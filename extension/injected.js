/**
 * injected.js — Live Translation Main World Script
 *
 * IMPORTANT: This file runs in the PAGE'S MAIN WORLD — the same JavaScript
 * context as Google Meet. This is the only context where a getUserMedia
 * override actually intercepts Meet's mic call.
 *
 * Architecture: Insertable Streams (MediaStreamTrackProcessor + Generator)
 * ─────────────────────────────────────────────────────────────────────────
 * Previous approach (AudioContext + MediaStreamDestinationNode) failed because
 * Meet's Audio Worklet reads from the underlying hardware track, bypassing
 * whatever Web Audio nodes we built on top. The Insertable Streams API
 * intercepts at the track level — we are IN the signal chain, not beside it.
 *
 * Pipeline:
 *   Real mic hardware
 *     → MediaStreamTrackProcessor  (exposes raw AudioData frames)
 *     → manual reader loop         (our control point)
 *       OFF: enqueue mic frame unchanged → generator
 *       ON:  accumulate samples → send PCM to server every 250ms
 *            pass-through mic while waiting for server audio
 *            when server audio arrives: write processed frames instead
 *     → MediaStreamTrackGenerator  (produces real MediaStreamTrack)
 *     → new MediaStream([generator.track]) returned to Meet
 *     → Meet's Audio Worklet reads generator.track
 *     → WebRTC → other participants
 *
 * This file injects via <script> tag from content.js.
 * Cannot use any Chrome extension APIs — window.postMessage only.
 *
 * Message protocol:
 *   FROM injected.js → content.js:  { source: 'lt-injected', type, ...payload }
 *   FROM content.js  → injected.js: { source: 'lt-content',  type, ...payload }
 *
 * All console.log calls prefixed with [LT Injected] for easy filtering.
 */

(function () {
  'use strict';

  console.log('[LT Injected] Main world script loaded — Insertable Streams edition');

  // ─── State ──────────────────────────────────────────────────────────────────

  let processor         = null;  // MediaStreamTrackProcessor
  let generator         = null;  // MediaStreamTrackGenerator
  let writer            = null;  // generator.writable.getWriter()
  let clonedTrack       = null;  // clone of real mic track given to processor

  // Pipeline lifecycle guards — prevent duplicate setup when Meet calls
  // getUserMedia multiple times (4+ calls during call setup are normal).
  let pipelineReady   = null;  // Promise<void> that resolves when pipeline is running
  let pipelineStarted = false; // true once runPipeline() has been called

  let processingEnabled = false; // toggled by startRecording / stopRecording
  let currentPitch      = 0;     // semitones (forwarded to server, preserved for future use)

  // ─── Sample accumulation ────────────────────────────────────────────────────
  // AudioData frames are ~128 samples each (~2.7ms at 48kHz).
  // We accumulate 12000 samples (250ms) before sending one WebSocket message.
  // This matches Deepgram's streaming API timing and avoids 375 msg/sec overhead.

  let accumBuffer  = [];    // array of Float32Arrays waiting to be sent
  let accumCount   = 0;     // total samples accumulated so far
  const CHUNK_SAMPLES = 12000; // 250ms × 48000 Hz
  let chunkCounter = 0;

  // ─── Playback state ─────────────────────────────────────────────────────────

  let playingProcessed = false; // true when writing server audio frames to generator
  let processedQueue   = [];    // queue of AudioData frames from server, ready to write
  let currentTimestamp = 0;     // running microsecond timestamp (from latest AudioData)

  // ─── Feature Detection ───────────────────────────────────────────────────────

  const INSERTABLE_STREAMS_SUPPORTED =
    ('MediaStreamTrackProcessor' in window) &&
    ('MediaStreamTrackGenerator' in window);

  if (!INSERTABLE_STREAMS_SUPPORTED) {
    console.error('[LT Injected] Insertable Streams NOT supported in this browser — ' +
      'falling back to simple pass-through. Audio processing will not work.');
  } else {
    console.log('[LT Injected] Insertable Streams supported ✓');
  }

  // ─── getUserMedia Override ───────────────────────────────────────────────────

  const originalGetUserMedia =
    navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    console.log('[LT Injected] getUserMedia intercepted:', JSON.stringify(constraints));

    // Non-audio requests (video-only, screen share) always pass through.
    if (!constraints || !constraints.audio) {
      console.log('[LT Injected] Non-audio request — passing through unchanged');
      return originalGetUserMedia(constraints);
    }

    // ── Guard 1: pipeline already fully running ───────────────────────────────
    // Meet calls getUserMedia 4+ times during call setup (codec negotiation,
    // reconnects, permission re-checks). Creating a new processor/generator
    // for each call would consume the mic track multiple times and cause
    // Chrome to throw a microphone conflict error.
    if (generator) {
      console.log('[LT Injected] getUserMedia called again — pipeline already active, ' +
        'returning existing generator track');
      return new MediaStream([generator.track]);
    }

    // ── Guard 2: pipeline is being set up (race condition) ────────────────────
    // If getUserMedia fires a second time while the first call is still in
    // the async setupPipeline() function (between the real getUserMedia call
    // and the generator being assigned), we wait for setup to finish then
    // return the generator track.
    if (pipelineReady) {
      console.log('[LT Injected] getUserMedia called during pipeline setup — awaiting ready');
      await pipelineReady;
      console.log('[LT Injected] Pipeline now ready — returning generator track');
      return new MediaStream([generator.track]);
    }

    // ── First call: set up the pipeline ──────────────────────────────────────
    // Assign pipelineReady immediately (before any await) so Guard 2 above
    // can catch concurrent calls that arrive while we are still setting up.
    let resolveReady;
    pipelineReady = new Promise((res) => { resolveReady = res; });

    let realStream;
    try {
      realStream = await originalGetUserMedia(constraints);
      console.log('[LT Injected] Got real mic stream from browser');
    } catch (err) {
      console.error('[LT Injected] getUserMedia failed:', err);
      pipelineReady = null; // reset so a retry can try again
      throw err;
    }

    // ── Fallback: Insertable Streams not available ────────────────────────────
    if (!INSERTABLE_STREAMS_SUPPORTED) {
      console.warn('[LT Injected] Using real stream (no Insertable Streams) — audio unchanged');
      window.postMessage({ source: 'lt-injected', type: 'micReady' }, '*');
      resolveReady();
      return realStream;
    }

    const originalTrack = realStream.getAudioTracks()[0];
    console.log('[LT Injected] Real mic track:', originalTrack.label,
      '| settings:', JSON.stringify(originalTrack.getSettings()));

    // Clone the track before giving it to MediaStreamTrackProcessor.
    //
    // On Windows, MediaStreamTrackProcessor holds an exclusive OS-level lock
    // on whichever track it receives. If we passed originalTrack directly,
    // Meet's Audio Worklet would try to open the same physical mic device in
    // its own thread and get blocked — producing "Microphone can't be accessed".
    //
    // By cloning:
    //   clonedTrack  → processor reads mic frames for our PCM pipeline
    //   originalTrack stays with realStream → Meet/Audio Worklet can open
    //                  the hardware normally (for echo cancellation etc.)
    //   generator.track → what Meet's WebRTC actually sends to participants
    clonedTrack = originalTrack.clone();
    console.log('[LT Injected] Mic track cloned — processor uses clone, Meet uses generator.track');

    // Create processor and generator
    processor = new MediaStreamTrackProcessor({ track: clonedTrack });
    generator = new MediaStreamTrackGenerator({ kind: 'audio' });
    console.log('[LT Injected] MediaStreamTrackProcessor and Generator created');

    // Start the manual reader loop — only ever called ONCE.
    // Guard against accidental re-entry with pipelineStarted.
    if (!pipelineStarted) {
      pipelineStarted = true;
      runPipeline().catch((err) => {
        console.error('[LT Injected] Pipeline loop terminated unexpectedly:', err);
      });
    }

    // Signal that setup is complete — any concurrent getUserMedia callers
    // waiting on pipelineReady can now proceed.
    resolveReady();

    // Notify content.js — WebSocket opens after this
    window.postMessage({ source: 'lt-injected', type: 'micReady' }, '*');

    console.log('[LT Injected] Returning MediaStream backed by generator.track to Meet');
    return new MediaStream([generator.track]);
  };

  console.log('[LT Injected] getUserMedia override installed ✓');

  // ─── Manual Pipeline Loop ───────────────────────────────────────────────────

  /**
   * The heart of the Insertable Streams pipeline.
   *
   * Reads AudioData frames one at a time from the processor's ReadableStream
   * and writes either the mic frame or a processed frame from the server into
   * the generator's WritableStream. This gives us complete, exclusive control
   * over what Meet hears — one writer, one loop, clear logic.
   *
   * We obtain the writer here (not earlier) because you must call getWriter()
   * before piping or the WritableStream is locked.
   */
  async function runPipeline() {
    const reader = processor.readable.getReader();
    writer = generator.writable.getWriter();
    console.log('[LT Injected] Pipeline loop started — reading mic frames');

    try {
      while (true) {
        const { done, value: audioData } = await reader.read();
        if (done) {
          console.log('[LT Injected] Processor ReadableStream ended — pipeline stopping');
          break;
        }

        // All logic for each frame lives here
        await handleAudioFrame(audioData);
      }
    } catch (err) {
      console.error('[LT Injected] Pipeline loop error:', err);
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      try { writer.releaseLock(); } catch (_) {}
      // Stop the cloned track to release the OS microphone handle.
      // The original track (owned by realStream) remains alive for Meet.
      try {
        if (clonedTrack) {
          clonedTrack.stop();
          console.log('[LT Injected] Cloned mic track stopped — OS handle released');
        }
      } catch (_) {}
      console.log('[LT Injected] Pipeline loop exited — writer released');
    }
  }

  // ─── Per-Frame Logic ─────────────────────────────────────────────────────────

  /**
   * Called once per AudioData frame (~2.7ms at 48kHz / 128 samples per frame).
   * Decides what to write to the generator:
   *   - Processing OFF: mic frame unchanged
   *   - Processing ON + processed audio ready: swap in a processed frame
   *   - Processing ON + waiting for server: mic frame (never silence)
   *
   * AudioData memory contract:
   *   If you write a frame, the stream owns it and closes it automatically.
   *   If you discard a frame (e.g. replaced by a processed one), you MUST
   *   call audioData.close() yourself, or memory leaks.
   *
   * @param {AudioData} audioData — the current mic frame from the processor
   */
  async function handleAudioFrame(audioData) {
    // Always track the latest timestamp for building processed AudioData frames
    currentTimestamp = audioData.timestamp;

    // ── OFF: simple pass-through ─────────────────────────────────────────────
    if (!processingEnabled) {
      await writer.write(audioData);
      return;
    }

    // ── ON: accumulate samples to send to server ─────────────────────────────
    const buffer = new Float32Array(audioData.numberOfFrames);
    audioData.copyTo(buffer, { planeIndex: 0 });

    accumBuffer.push(buffer);
    accumCount += audioData.numberOfFrames;

    if (accumCount >= CHUNK_SAMPLES) {
      // We have 250ms of audio — concatenate and send to server
      const combined = new Float32Array(accumCount);
      let offset = 0;
      for (const buf of accumBuffer) {
        combined.set(buf, offset);
        offset += buf.length;
      }
      accumBuffer = [];
      accumCount  = 0;

      const id = ++chunkCounter;
      console.log('[LT Injected] Sending PCM chunk', id, '→', combined.length, 'samples',
        '@ sampleRate=', audioData.sampleRate, 'channels=', audioData.numberOfChannels);

      window.postMessage({
        source:           'lt-injected',
        type:             'audioChunk',
        chunkId:          id,
        samples:          Array.from(combined),
        sampleRate:       audioData.sampleRate,
        numberOfChannels: audioData.numberOfChannels,
        timestamp:        audioData.timestamp,
      }, '*');
    }

    // ── Decide what to write to the generator ───────────────────────────────
    if (playingProcessed && processedQueue.length > 0) {
      // Swap: use a processed frame from the server, discard the mic frame
      const processedFrame = processedQueue.shift();

      if (processedQueue.length === 0) {
        playingProcessed = false;
        console.log('[LT Injected] Processed chunk exhausted — back to mic pass-through');
      }

      audioData.close(); // MUST close the discarded mic frame — prevents memory leak
      await writer.write(processedFrame);
    } else {
      // Pass-through while waiting for server audio (never silence)
      await writer.write(audioData);
    }
  }

  // ─── Play Processed Audio ────────────────────────────────────────────────────

  /**
   * Called when content.js delivers processed PCM samples back from the server.
   * Splits the flat Float32Array into 128-sample AudioData frames (matching
   * the pipeline's native frame size) and pushes them into processedQueue.
   * The main pipeline loop drains the queue frame-by-frame.
   *
   * @param {number[]} samples    — Float32Array values received from server
   * @param {number}   sampleRate — e.g. 48000
   * @param {number}   chunkId    — for logging
   */
  function playProcessedAudio(samples, sampleRate, chunkId) {
    console.log('[LT Injected] Received processed PCM chunk', chunkId,
      '—', samples.length, 'samples @ sampleRate=', sampleRate);

    const FRAME_SIZE = 128; // match the mic's native frame size
    const frames = [];
    let ts = currentTimestamp; // pick up from where the mic currently is

    for (let i = 0; i < samples.length; i += FRAME_SIZE) {
      const end       = Math.min(i + FRAME_SIZE, samples.length);
      const frameData = new Float32Array(samples.slice(i, end));

      try {
        const frame = new AudioData({
          format:           'f32-planar',
          sampleRate:       sampleRate,
          numberOfFrames:   frameData.length,
          numberOfChannels: 1,
          timestamp:        ts,
          data:             frameData,
        });
        frames.push(frame);
        // Advance timestamp by the duration of this frame in microseconds
        ts += Math.round((frameData.length / sampleRate) * 1_000_000);
      } catch (err) {
        console.error('[LT Injected] Failed to create AudioData frame at offset', i, ':', err);
      }
    }

    if (frames.length > 0) {
      processedQueue.push(...frames);
      playingProcessed = true;
      console.log('[LT Injected] Queued', frames.length, 'AudioData frames for playback from chunk', chunkId);
    } else {
      console.warn('[LT Injected] No frames created for chunk', chunkId, '— nothing to play');
    }
  }

  // ─── postMessage Listener (commands from content.js) ────────────────────────

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'lt-content') return;
    const msg = event.data;
    console.log('[LT Injected] Command from content.js:', msg.type);

    switch (msg.type) {
      case 'startRecording':
        // Reset all accumulation and playback state for a clean start
        accumBuffer      = [];
        accumCount       = 0;
        processedQueue   = [];
        playingProcessed = false;
        processingEnabled = true;
        console.log('[LT Injected] Processing ENABLED — accumulating PCM, sending to server');
        break;

      case 'stopRecording':
        processingEnabled = false;
        // Clear everything — mic pass-through takes over immediately
        accumBuffer      = [];
        accumCount       = 0;
        processedQueue   = [];
        playingProcessed = false;
        console.log('[LT Injected] Processing DISABLED — mic pass-through restored');
        break;

      case 'setPitch':
        // Pitch UI removed from popup — this message is no longer sent.
        // Handler kept as a no-op so old messages don't fall through to
        // the default warning.
        currentPitch = msg.pitch || 0;
        break;

      case 'playChunk':
        // content.js is delivering processed PCM samples from the server
        if (processingEnabled) {
          playProcessedAudio(msg.samples, msg.sampleRate, msg.chunkId);
        } else {
          console.log('[LT Injected] playChunk ignored — processing is disabled');
        }
        break;

      default:
        console.warn('[LT Injected] Unknown command type:', msg.type);
    }
  });

  console.log('[LT Injected] postMessage listener ready — waiting for commands from content.js');
})();
