/**
 * server/index.js — Live Translation WebSocket Server
 *
 * Audio format: audio/webm;codecs=opus throughout the entire pipeline.
 *
 * processAudioChunk is currently a simple ECHO — it returns audio unchanged.
 * This proves the full round-trip pipeline works with zero processing overhead.
 * Replace only the body of processAudioChunk when integrating Deepgram + Gemini.
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
 * When false, processAudioChunk is bypassed and the function logs that fact.
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

// ─── Main Processing Function ──────────────────────────────────────────────────

/**
 * processAudioChunk — THE SINGLE SWAPPABLE PROCESSING UNIT
 *
 * =====================================================================
 * CURRENT STATE: ECHO PLACEHOLDER
 * Returns the input buffer unchanged. Proves the full round-trip pipeline
 * works: capture → WebSocket → server → WebSocket → playback → fake mic.
 *
 * IN PRODUCTION THIS WILL BE REPLACED WITH:
 *   1. Deepgram Streaming STT  → transcript text
 *   2. Gemini Flash            → translated text
 *   3. Deepgram Aura TTS       → audio buffer
 *
 * The function signature is PERMANENT:
 *   input:  Buffer of webm/opus audio
 *   output: Promise<Buffer> of webm/opus audio
 *
 * The WebSocket handler and backpressure logic never change.
 * Only the body of this function changes when we integrate Deepgram.
 *
 * To bypass entirely: ENABLE_PROCESSING=false node index.js
 * =====================================================================
 *
 * @param {Buffer} inputBuffer    — webm/opus audio from the extension
 * @param {string} mimeType       — MIME type reported by MediaRecorder (informational)
 * @param {number} pitchSemitones — pitch shift requested (ignored by echo, used by real impl)
 * @returns {Promise<Buffer>}     — processed audio (currently: original unchanged)
 */
async function processAudioChunk(inputBuffer, mimeType, pitchSemitones) {
  if (!ENABLE_PROCESSING) {
    return inputBuffer;
  }

  // ECHO — return audio unchanged.
  // This proves end-to-end connectivity without any processing risk.
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
 * Processes a single audio chunk message and sends the result back.
 */
async function processOne(socket, message) {
  const { chunkId, t1, pitch = 0, mimeType = 'audio/webm', data } = message;
  const t2 = Date.now();

  const approxBytes = Math.round(data.length * 0.75);
  console.log(
    `[Server] Chunk ${chunkId} received | net-in=${t2 - t1}ms | pitch=${pitch >= 0 ? '+' : ''}${pitch} | mime=${mimeType} | ~${approxBytes}B`
  );

  try {
    const inputBuffer  = Buffer.from(data, 'base64');
    const outputBuffer = await processAudioChunk(inputBuffer, mimeType, pitch);
    const t3           = Date.now();
    const outputBase64 = outputBuffer.toString('base64');

    console.log(
      `[Server] Chunk ${chunkId} complete: net-in=${t2 - t1}ms | process=${t3 - t2}ms | echo`
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
    console.error(`[Server] Chunk ${chunkId}: unexpected error:`, err.message);
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

      // ── Audio chunk ──────────────────────────────────────────────────────────
      if (message.type === 'audio') {
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
  audioFormat:      'audio/webm;codecs=opus',
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
  console.log(`[Server] Audio format         : audio/webm;codecs=opus`);
  console.log(`[Server] ENABLE_PROCESSING    : ${ENABLE_PROCESSING}`);
  console.log(`[Server] Max queue depth      : ${MAX_QUEUE_DEPTH} chunks per client`);
  console.log(`[Server] WebSocket extension  : ws://localhost:${PORT}`);
  console.log(`[Server] WebSocket dashboard  : ws://localhost:${PORT}?client=dashboard`);
  console.log(`[Server] Health check         : http://localhost:${PORT}/health`);
  console.log(`[Server] Bypass mode          : ENABLE_PROCESSING=false node index.js`);
});
