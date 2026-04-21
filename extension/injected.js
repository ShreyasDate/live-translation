/**
 * injected.js — Live Translation Main World Script
 *
 * IMPORTANT: This file runs in the PAGE'S MAIN WORLD — the same JavaScript
 * context as Google Meet. This is the only context where a getUserMedia
 * override actually intercepts Meet's mic call.
 *
 * This file is injected via a <script> tag created by content.js.
 * It cannot use any Chrome extension APIs (no chrome.runtime, no chrome.storage).
 * The only communication channel with content.js is window.postMessage.
 *
 * Responsibilities:
 *   1. Override navigator.mediaDevices.getUserMedia BEFORE Meet calls it
 *   2. When Meet requests audio: get the real stream, build the Web Audio graph,
 *      create a fake MediaStream, return it to Meet
 *   3. Notify content.js via postMessage that the mic stream is ready
 *   4. Listen for commands from content.js via postMessage:
 *        { source: 'lt-content', type: 'startRecording' }
 *        { source: 'lt-content', type: 'stopRecording' }
 *        { source: 'lt-content', type: 'setPitch', pitch: N }
 *        { source: 'lt-content', type: 'playChunk', chunkId, data: base64 }
 *
 * Message protocol:
 *   Messages FROM injected.js TO content.js have:  { source: 'lt-injected', type, ...payload }
 *   Messages FROM content.js TO injected.js have:  { source: 'lt-content',  type, ...payload }
 *
 * All console.log calls are prefixed with [LT Injected] for easy filtering.
 */

(function () {
  'use strict';

  console.log('[LT Injected] Main world script loaded — installing getUserMedia override');

  // ─── State ──────────────────────────────────────────────────────────────────

  let audioContext      = null;  // AudioContext for the whole Web Audio graph
  let destinationNode   = null;  // MediaStreamDestinationNode — the fake mic stream
  let realMicStream     = null;  // The real hardware MediaStream from the browser
  let mediaRecorder     = null;  // MediaRecorder capturing the real mic in chunks
  let processingEnabled = false; // Whether to send audio chunks to content.js
  let currentPitch      = 0;     // Current semitone pitch shift

  // ─── Choose Recording Format ───────────────────────────────────────────────
  //
  // We always want audio/webm;codecs=opus:
  //   — Chrome's MediaRecorder produces it natively at ~5KB per 250ms chunk
  //   — Deepgram's Streaming STT API accepts it directly (no conversion)
  //   — 10× smaller than uncompressed PCM (audio/webm;codecs=pcm)
  //   — The standard codec of WebRTC: Meet, Zoom, Discord all use Opus
  //
  // We do NOT want audio/webm;codecs=pcm — it is 10× larger, the server
  // cannot process it without a codec library, and Deepgram does not list
  // it as a supported input format.
  let MIME_TYPE = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
    console.warn('[LT Injected] audio/webm;codecs=opus not supported — falling back to audio/webm');
    MIME_TYPE = 'audio/webm'; // Chrome default, still almost always opus
  }
  console.log('[LT Injected] Using MIME type:', MIME_TYPE);



  // ─── getUserMedia Override ─────────────────────────────────────────────────

  // Capture the original BEFORE any other code (including Meet) can touch it.
  // .bind() preserves the correct `this` context when we call it later.
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    console.log('[LT Injected] getUserMedia intercepted — constraints:', JSON.stringify(constraints));

    // Non-audio requests (video-only, screen share, etc.) pass through unchanged
    if (!constraints || !constraints.audio) {
      console.log('[LT Injected] Non-audio constraints — passing through to original');
      return originalGetUserMedia(constraints);
    }

    // ── Step 1: Get the real microphone stream ─────────────────────────────
    let realStream;
    try {
      realStream = await originalGetUserMedia(constraints);
      console.log('[LT Injected] Got real mic stream from browser');
    } catch (err) {
      console.error('[LT Injected] Failed to get real mic stream:', err);
      // Re-throw so Meet can handle permission-denied exactly as it normally would
      throw err;
    }

    // Guard: if Meet calls getUserMedia multiple times (which it does for
    // reconnects and codec negotiation), only set up the graph once.
    if (realMicStream) {
      console.log('[LT Injected] getUserMedia called again — returning existing fake stream');
      return destinationNode.stream;
    }

    realMicStream = realStream;

    // ── Step 2: Build the Web Audio processing graph ───────────────────────
    // AudioContext must be created in the main world so it shares the same
    // audio rendering engine as Meet itself.
    audioContext    = new AudioContext();
    const sourceNode = audioContext.createMediaStreamSource(realStream);
    destinationNode  = audioContext.createMediaStreamDestination();

    // Pass-through by default: real mic → fake mic.
    // When processing is enabled we keep this connection so audio still flows
    // while playback nodes are connected on top for the processed chunks.
    sourceNode.connect(destinationNode);

    console.log('[LT Injected] Web Audio graph built — source → destination pass-through active');
    console.log('[LT Injected] Fake mic stream id:', destinationNode.stream.id);

    // ── Step 3: Notify content.js that the mic is ready ───────────────────
    window.postMessage(
      { source: 'lt-injected', type: 'micReady' },
      '*'
    );

    console.log('[LT Injected] Returning fake mic stream to Meet');

    // ── Step 4: Return the fake stream to Meet ─────────────────────────────
    return destinationNode.stream;
  };

  console.log('[LT Injected] getUserMedia override installed in main world ✓');

  // ─── MediaRecorder (runs in main world — has direct access to the stream) ──

  function startRecording() {
    if (!realMicStream) {
      console.warn('[LT Injected] startRecording called but realMicStream is null');
      window.postMessage({ source: 'lt-injected', type: 'recordingError', reason: 'no-stream' }, '*');
      return;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      console.log('[LT Injected] MediaRecorder already running — ignoring startRecording');
      return;
    }

    console.log(`[LT Injected] Creating MediaRecorder — mimeType=${MIME_TYPE}`);

    try {
      mediaRecorder = new MediaRecorder(realMicStream, { mimeType: MIME_TYPE });
    } catch (err) {
      console.warn('[LT Injected] Requested mimeType failed, falling back to browser default:', err.message);
      mediaRecorder = new MediaRecorder(realMicStream);
    }

    mediaRecorder.ondataavailable = async (event) => {
      if (!processingEnabled) return;
      if (!event.data || event.data.size === 0) return;

      // Convert Blob → base64 and send to content.js for WebSocket forwarding.
      // Include the mimeType so the server knows how to decode the bytes.
      try {
        const arrayBuffer = await event.data.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        // btoa() requires a binary string — convert byte-by-byte
        const base64 = btoa(String.fromCharCode(...uint8));
        window.postMessage(
          {
            source:   'lt-injected',
            type:     'audioChunk',
            data:     base64,
            size:     event.data.size,
            mimeType: mediaRecorder.mimeType || MIME_TYPE,  // actual mimeType used
          },
          '*'
        );
      } catch (err) {
        console.error('[LT Injected] Failed to encode audio chunk:', err);
      }
    };

    mediaRecorder.onerror = (err) => {
      console.error('[LT Injected] MediaRecorder error:', err);
    };

    mediaRecorder.onstop = () => {
      console.log('[LT Injected] MediaRecorder stopped');
      window.postMessage({ source: 'lt-injected', type: 'recordingStopped' }, '*');
    };

    mediaRecorder.start(250); // fire ondataavailable every 250ms
    console.log('[LT Injected] MediaRecorder started — 250ms timeslice');
    window.postMessage({ source: 'lt-injected', type: 'recordingStarted' }, '*');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      console.log('[LT Injected] MediaRecorder stop() called');
    } else {
      console.log('[LT Injected] stopRecording: MediaRecorder was already inactive');
    }
  }

  // ─── Play Processed Chunk ──────────────────────────────────────────────────

  /**
   * Decodes a base64-encoded WebM/Opus chunk and plays it through the
   * MediaStreamDestinationNode so Meet hears the processed voice.
   *
   * @param {string} base64   — the processed audio, base64 encoded
   * @param {number} chunkId  — for logging only
   */
  async function playProcessedChunk(base64, chunkId) {
    if (!audioContext || !destinationNode) {
      console.warn(`[LT Injected] Chunk ${chunkId}: AudioContext not ready — cannot play`);
      return;
    }

    let arrayBuffer;
    try {
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      arrayBuffer = bytes.buffer;
    } catch (err) {
      console.error(`[LT Injected] Chunk ${chunkId}: base64 decode failed:`, err);
      return;
    }

    let audioBuffer;
    try {
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    } catch (err) {
      console.error(`[LT Injected] Chunk ${chunkId}: decodeAudioData failed:`, err);
      return;
    }

    try {
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(destinationNode);
      source.start();
      console.log(
        `[LT Injected] Playing processed audio back through fake mic — ` +
        `${(audioBuffer.duration * 1000).toFixed(0)}ms audio | chunk #${chunkId}`
      );
    } catch (err) {
      console.error(`[LT Injected] Chunk ${chunkId}: playback failed:`, err);
    }
  }

  // ─── postMessage Listener (commands from content.js) ──────────────────────

  window.addEventListener('message', (event) => {
    // Only handle messages from our content script
    if (!event.data || event.data.source !== 'lt-content') return;

    const msg = event.data;
    console.log('[LT Injected] Received command from content.js:', msg.type);

    switch (msg.type) {
      case 'startRecording':
        processingEnabled = true;
        startRecording();
        break;

      case 'stopRecording':
        processingEnabled = false;
        stopRecording();
        break;

      case 'setPitch':
        currentPitch = msg.pitch;
        console.log(`[LT Injected] Pitch set to ${currentPitch} semitones`);
        break;

      case 'playChunk':
        // content.js received processed audio from server and is asking us to
        // play it through the fake mic (only main world has access to AudioContext)
        playProcessedChunk(msg.data, msg.chunkId).catch((err) => {
          console.error('[LT Injected] playChunk error:', err);
        });
        break;

      default:
        console.warn('[LT Injected] Unknown command type:', msg.type);
    }
  });

  console.log('[LT Injected] postMessage listener ready — waiting for commands from content.js');
})();
