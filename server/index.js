/**
 * server/index.js — Live Translation WebSocket Server
 *
 * Supports two audio pipeline modes:
 *
 *   ┌─ NEW (default) ────────────────────────────────────────────────────────┐
 *   │ type: 'audioPCM'                                                        │
 *   │ Extension sends raw Float32Array PCM (12000 samples / 250ms, 48kHz)    │
 *   │ Server calls processPCM() → returns Float32Array of processed samples   │
 *   │ Server sends back 'audioPCM' with processed samples array               │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ LEGACY (kept for backward compat) ────────────────────────────────────┐
 *   │ type: 'audio'                                                            │
 *   │ Extension sends base64-encoded webm/opus                                 │
 *   │ Server calls processAudioChunk() → echo                                  │
 *   │ Server sends back 'audio' with base64 audio                              │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * processPCM is the SINGLE SWAPPABLE FUNCTION — replace its body with
 * Deepgram STT + Gemini Flash + Deepgram Aura TTS when ready.
 * Nothing else in this file needs to change.
 *
 * Backpressure: each client has a queue capped at MAX_QUEUE_DEPTH chunks.
 * If the queue is full when a new chunk arrives, the oldest chunks are dropped.
 * This keeps the system processing CURRENT audio, not audio from seconds ago.
 *
 * WebSocket routes:
 *   ws://localhost:8080                    → extension audio clients
 *   ws://localhost:8080?client=dashboard   → dashboard stat viewers
 *
 * HTTP:
 *   GET /health → { status, enableProcessing, extensionClients, dashboardClients, uptime }
 */

'use strict';

const Fastify = require('fastify');

// ─── Feature Flag ─────────────────────────────────────────────────────────────

/**
 * When false, processPCM and processAudioChunk are bypassed (raw echo).
 * Useful for measuring raw WebSocket round-trip latency with zero processing.
 *
 *   ENABLE_PROCESSING=false node index.js
 */
const ENABLE_PROCESSING = process.env.ENABLE_PROCESSING !== 'false';

console.log(`[Server] ENABLE_PROCESSING = ${ENABLE_PROCESSING}`);

// ─── Backpressure Config ───────────────────────────────────────────────────────

/**
 * Maximum number of chunks that can queue up for a single client.
 * If a new chunk arrives and the queue is already at this depth, the oldest
 * chunks are dropped. We always want to process the MOST RECENT audio.
 *
 * At 250ms per chunk, 3 chunks = 750ms of buffering before dropping starts.
 */
const MAX_QUEUE_DEPTH = 3;

// ─── Fastify Setup ────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: false });
fastify.register(require('@fastify/websocket'));

// ─── Client Sets ──────────────────────────────────────────────────────────────

/** @type {Set<import('@fastify/websocket').WebSocket>} */
const extensionClients = new Set();

/** @type {Set<import('@fastify/websocket').WebSocket>} */
const dashboardClients = new Set();

/**
 * Per-client processing queue.
 *
 * Each entry is: { message, socket }
 * A separate drainQueue() loop runs for each connected client.
 *
 * @type {Map<WebSocket, Array<{message: object, socket: WebSocket}>>}
 */
const clientQueues = new Map();

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function sendJson(ws, payload) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToDashboard(payload) {
  const text = JSON.stringify(payload);
  for (const client of dashboardClients) {
    if (client.readyState === 1) client.send(text);
  }
}

// ─── PCM Processing Function ───────────────────────────────────────────────────

/**
 * processPCM — THE SINGLE SWAPPABLE PROCESSING FUNCTION
 *
 * =====================================================================
 * CURRENT STATE: DEMO PLACEHOLDER — tanh soft-clip saturation
 *
 * Applies a tanh soft-clipper with a 2× input gain. This makes the voice
 * noticeably louder and slightly distorted — clearly audible proof that
 * the server is processing the audio in real time.
 *
 * IN PRODUCTION THIS WILL BE REPLACED WITH:
 *   1. Deepgram Streaming STT  → transcript text
 *   2. Gemini Flash            → translated text
 *   3. Deepgram Aura TTS       → Float32Array of audio samples
 *
 * The function signature is PERMANENT:
 *   input:  Float32Array of raw PCM samples (f32-planar, 48kHz, mono)
 *   output: Float32Array of processed PCM samples (same format/rate)
 *
 * The WebSocket handler and backpressure logic never change.
 * Only the body of this function changes when we integrate Deepgram.
 *
 * To bypass (pure echo): ENABLE_PROCESSING=false node index.js
 * =====================================================================
 *
 * @param {Float32Array} samples       — raw PCM from the extension
 * @param {number}       pitchSemitones — pitch shift requested (for future use)
 * @returns {Float32Array}             — processed samples
 */
function processPCM(samples, pitchSemitones) {
  // ================================================================
  // PLACEHOLDER — WILL BE REPLACED WITH:
  // 1. Deepgram Streaming STT  → transcript text
  // 2. Gemini Flash            → translated text
  // 3. Deepgram Aura TTS       → audio samples (Float32Array)
  //
  // Input:  Float32Array of raw PCM samples (f32-planar, 48kHz, mono)
  // Output: Float32Array of processed PCM samples (same format)
  //
  // To bypass: ENABLE_PROCESSING=false node index.js
  // ================================================================

  if (!ENABLE_PROCESSING) return samples;

  // Demo effect: tanh soft-clip saturation
  // Math.tanh(x * 2.0) compresses the dynamic range — loud samples are
  // pushed toward ±1 rather than clipping hard. The 2× input gain ensures
  // the effect is clearly audible compared to the original voice.
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    output[i] = Math.tanh(samples[i] * 2.0);
  }
  return output;
}

// ─── Legacy webm/opus Processing Function ─────────────────────────────────────

/**
 * processAudioChunk — legacy echo handler for type: 'audio' messages.
 *
 * Returns the input buffer unchanged. Kept for backward compatibility so old
 * extension builds that send webm/opus still get a valid response and correct
 * latency reporting.
 *
 * @param {Buffer} inputBuffer
 * @param {string} mimeType
 * @param {number} pitchSemitones
 * @returns {Promise<Buffer>}
 */
async function processAudioChunk(inputBuffer, mimeType, pitchSemitones) {
  // Echo — return audio unchanged regardless of ENABLE_PROCESSING.
  // The old pipeline is no longer the demo path.
  return inputBuffer;
}

// ─── Per-Client Queue Drain ────────────────────────────────────────────────────

/**
 * Processes the queue for a single client one item at a time.
 * Called after each new item is pushed to the client's queue.
 * If a drain loop is already running for this client, this is a no-op
 * (the running loop will process the item when it finishes the current one).
 */
const drainingClients = new Set();

async function drainQueue(socket) {
  // Only one drain loop per client at a time
  if (drainingClients.has(socket)) return;
  drainingClients.add(socket);

  const queue = clientQueues.get(socket);
  if (!queue) {
    drainingClients.delete(socket);
    return;
  }

  while (queue.length > 0) {
    const { message } = queue.shift();
    await processOne(socket, message);
  }

  drainingClients.delete(socket);
}

/**
 * Processes a single message — dispatches to the correct handler
 * based on message.type ('audio' legacy or 'audioPCM' new path).
 */
async function processOne(socket, message) {
  if (message.type === 'audioPCM') {
    await processOnePCM(socket, message);
  } else if (message.type === 'audio') {
    await processOneLegacy(socket, message);
  }
}

// ─── PCM Message Handler ───────────────────────────────────────────────────────

/**
 * Processes a single 'audioPCM' message.
 * Calls processPCM(), sends back 'audioPCM', broadcasts to dashboard.
 */
async function processOnePCM(socket, message) {
  const { chunkId, t1, pitch = 0, sampleRate = 48000, numberOfChannels = 1, samples } = message;
  const t2 = Date.now();

  console.log(
    `[Server] PCM chunk ${chunkId} received | net-in=${t2 - t1}ms | ` +
    `samples=${samples.length} | sampleRate=${sampleRate} | pitch=${pitch >= 0 ? '+' : ''}${pitch}`
  );

  try {
    const inputSamples  = new Float32Array(samples);
    const outputSamples = processPCM(inputSamples, pitch);
    const t3            = Date.now();

    console.log(
      `[Server] PCM chunk ${chunkId} complete | process=${t3 - t2}ms | ` +
      `in=${inputSamples.length} samples | out=${outputSamples.length} samples`
    );

    sendJson(socket, {
      type:             'audioPCM',
      chunkId,
      t1, t2, t3,
      sampleRate,
      numberOfChannels,
      samples:          Array.from(outputSamples),
    });

    broadcastToDashboard({
      type:       'chunkStats',
      chunkId,
      t1, t2, t3,
      networkIn:  t2 - t1,
      processing: t3 - t2,
    });

  } catch (err) {
    console.error(`[Server] PCM chunk ${chunkId}: unexpected error:`, err.message);
    const t3 = Date.now();
    // On error, echo the original samples back so processing never goes silent
    sendJson(socket, {
      type: 'audioPCM',
      chunkId, t1, t2, t3,
      sampleRate, numberOfChannels,
      samples,
      processingFailed: true,
    });
    broadcastToDashboard({
      type: 'chunkStats', chunkId, t1, t2, t3,
      networkIn: t2 - t1, processing: t3 - t2, processingFailed: true,
    });
  }
}

// ─── Legacy webm/opus Message Handler ─────────────────────────────────────────

/**
 * Processes a single legacy 'audio' message (webm/opus base64).
 * Kept for backward compatibility — echoes audio back unchanged.
 */
async function processOneLegacy(socket, message) {
  const { chunkId, t1, pitch = 0, mimeType = 'audio/webm', data } = message;
  const t2 = Date.now();

  const approxBytes = Math.round(data.length * 0.75);
  console.log(
    `[Server] Legacy chunk ${chunkId} received | net-in=${t2 - t1}ms | ` +
    `pitch=${pitch >= 0 ? '+' : ''}${pitch} | mime=${mimeType} | ~${approxBytes}B`
  );

  try {
    const inputBuffer  = Buffer.from(data, 'base64');
    const outputBuffer = await processAudioChunk(inputBuffer, mimeType, pitch);
    const t3           = Date.now();
    const outputBase64 = outputBuffer.toString('base64');

    console.log(
      `[Server] Legacy chunk ${chunkId} complete: net-in=${t2 - t1}ms | process=${t3 - t2}ms | echo`
    );

    sendJson(socket, { type: 'audio', chunkId, t1, t2, t3, data: outputBase64 });

    broadcastToDashboard({
      type:       'chunkStats',
      chunkId,
      t1, t2, t3,
      networkIn:  t2 - t1,
      processing: t3 - t2,
    });

  } catch (err) {
    console.error(`[Server] Legacy chunk ${chunkId}: unexpected error:`, err.message);
    const t3 = Date.now();
    sendJson(socket, { type: 'audio', chunkId, t1, t2, t3, data, processingFailed: true });
    broadcastToDashboard({
      type: 'chunkStats', chunkId, t1, t2, t3,
      networkIn: t2 - t1, processing: t3 - t2, processingFailed: true,
    });
  }
}

// ─── WebSocket Route ──────────────────────────────────────────────────────────

fastify.register(async function (fastify) {
  fastify.get('/', { websocket: true }, (socket, req) => {

    // ── Dashboard client ───────────────────────────────────────────────────────
    if (req.query.client === 'dashboard') {
      dashboardClients.add(socket);
      console.log(`[Server] Dashboard connected — total: ${dashboardClients.size}`);
      sendJson(socket, {
        type: 'connected',
        extensionClients: extensionClients.size,
        dashboardClients: dashboardClients.size,
      });
      socket.on('close', () => {
        dashboardClients.delete(socket);
        console.log(`[Server] Dashboard disconnected — remaining: ${dashboardClients.size}`);
      });
      socket.on('error', (err) => {
        console.error('[Server] Dashboard WS error:', err.message);
        dashboardClients.delete(socket);
      });
      return;
    }

    // ── Extension audio client ─────────────────────────────────────────────────
    extensionClients.add(socket);
    clientQueues.set(socket, []);
    console.log(`[Server] Extension connected — total: ${extensionClients.size}`);

    socket.on('message', (rawMessage) => {
      let message;
      try {
        message = JSON.parse(rawMessage.toString());
      } catch (err) {
        console.error('[Server] Failed to parse message:', err.message);
        return;
      }

      // ── PCM audio chunk (new path) ───────────────────────────────────────────
      if (message.type === 'audioPCM' || message.type === 'audio') {
        const queue = clientQueues.get(socket);

        // ── Backpressure: drop oldest chunks if queue is full ─────────────────
        if (queue.length >= MAX_QUEUE_DEPTH) {
          const toDrop = queue.length - MAX_QUEUE_DEPTH + 1;
          queue.splice(0, toDrop);
          console.log(
            `[Server] Dropping ${toDrop} stale chunk(s) for client — queue was full (depth=${MAX_QUEUE_DEPTH})`
          );
        }

        queue.push({ message, socket });
        drainQueue(socket); // start drain loop if not already running
      }

      // ── Config message ───────────────────────────────────────────────────────
      if (message.type === 'config') {
        console.log('[Server] Config message received:', message);
        sendJson(socket, { type: 'configAck', ok: true });
      }
    });

    socket.on('close', () => {
      extensionClients.delete(socket);
      clientQueues.delete(socket);
      drainingClients.delete(socket);
      console.log(`[Server] Extension disconnected — remaining: ${extensionClients.size}`);
    });

    socket.on('error', (err) => {
      console.error('[Server] Extension WS error:', err.message);
      extensionClients.delete(socket);
      clientQueues.delete(socket);
      drainingClients.delete(socket);
    });
  });
});

// ─── Health Check ─────────────────────────────────────────────────────────────

fastify.get('/health', async () => ({
  status:           'ok',
  enableProcessing: ENABLE_PROCESSING,
  audioFormat:      'PCM Float32Array (audioPCM) + legacy webm/opus (audio)',
  maxQueueDepth:    MAX_QUEUE_DEPTH,
  extensionClients: extensionClients.size,
  dashboardClients: dashboardClients.size,
  uptime:           process.uptime(),
}));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 8080;

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) { console.error('[Server] Startup error:', err); process.exit(1); }
  console.log(`[Server] Live Translation server running at ${address}`);
  console.log(`[Server] Audio format (new)    : PCM Float32Array via type='audioPCM'`);
  console.log(`[Server] Audio format (legacy) : webm/opus base64 via type='audio' (echo)`);
  console.log(`[Server] ENABLE_PROCESSING     : ${ENABLE_PROCESSING}`);
  console.log(`[Server] Max queue depth       : ${MAX_QUEUE_DEPTH} chunks per client`);
  console.log(`[Server] WebSocket extension   : ws://localhost:${PORT}`);
  console.log(`[Server] WebSocket dashboard   : ws://localhost:${PORT}?client=dashboard`);
  console.log(`[Server] Health check          : http://localhost:${PORT}/health`);
  console.log(`[Server] Bypass mode           : ENABLE_PROCESSING=false node index.js`);
  console.log(`[Server] Demo effect           : tanh soft-clip saturation (2× gain)`);
  console.log(`[Server] Replace processPCM()  : swap body for Deepgram+Gemini+TTS`);
});
