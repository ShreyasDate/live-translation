/**
 * content.js — Live Translation Chrome Extension (Isolated World side)
 *
 * Runs in Chrome's isolated world — a sandboxed JS context separate from the
 * page. Because of this isolation, it CANNOT override navigator.mediaDevices
 * in a way that affects Google Meet. Instead, its first job is to inject
 * injected.js into the page's MAIN WORLD (where Meet lives).
 *
 * Architecture after the isolated-world fix:
 *
 *   injected.js  (main world)       — owns getUserMedia override, AudioContext,
 *                                     MediaRecorder, audio playback
 *        ↕  window.postMessage
 *   content.js   (isolated world)   — owns WebSocket, Chrome API calls,
 *                                     latency maths, message routing
 *        ↕  chrome.runtime.sendMessage
 *   background.js (service worker)  — store stats, forward popup ↔ content
 *        ↕  chrome.tabs.sendMessage
 *   popup.js                        — displays status, toggle, pitch, latency
 *
 * All console.log calls are prefixed with [LT Content] for easy filtering.
 * Logs from injected.js are prefixed with [LT Injected].
 */

console.log('[LT Content] Isolated-world script starting');

// ─── Step 1: Inject injected.js into the main world ──────────────────────────

/**
 * Creates a <script> element pointing at injected.js (declared as a
 * web_accessible_resource in manifest.json) and appends it to the document.
 * The script executes synchronously in the page's main world and is removed
 * from the DOM immediately after — no trace is left in the page HTML.
 *
 * This must happen at document_start (guaranteed by manifest.json) so the
 * override is in place before Meet's JS runs.
 */
(function injectMainWorldScript() {
  const scriptUrl = chrome.runtime.getURL('injected.js');
  const script = document.createElement('script');
  script.src = scriptUrl;

  script.onload = () => {
    // Clean up — remove the <script> tag once the JS has executed.
    // The override remains in effect even after the element is gone.
    script.remove();
    console.log('[LT Content] injected.js loaded and removed from DOM');
  };

  script.onerror = (err) => {
    console.error('[LT Content] Failed to load injected.js:', err);
  };

  // Append to <head> if available, otherwise to <html> root.
  // document_start runs before <body> exists; <head> may not be present yet
  // either — documentElement is always available.
  (document.head || document.documentElement).appendChild(script);
  console.log('[LT Content] injected.js script tag appended to DOM');
})();

// ─── State ────────────────────────────────────────────────────────────────────

let ws               = null;   // WebSocket connection to the local server
let chunkId          = 0;      // Monotonically increasing chunk counter
let currentPitch     = 0;      // Current pitch in semitones (kept in sync with injected.js)
let processingEnabled = false; // Whether audio processing is active

// Chunks that arrive before the WebSocket is open are queued here
let pendingChunks = [];

// ─── WebSocket Connection ─────────────────────────────────────────────────────

/**
 * Opens a WebSocket to ws://localhost:8080 and handles the lifecycle.
 * Queued chunks are flushed on connect.
 * Auto-reconnects after 3 seconds on close.
 */
function connectWebSocket() {
  console.log('[LT Content] Opening WebSocket to ws://localhost:8080');
  ws = new WebSocket('ws://localhost:8080');

  ws.onopen = () => {
    console.log('[LT Content] WebSocket connected ✓');
    chrome.runtime.sendMessage({ type: 'connectionStatus', connected: true });

    if (pendingChunks.length > 0) {
      console.log(`[LT Content] Flushing ${pendingChunks.length} queued chunk(s)`);
      pendingChunks.forEach((msg) => ws.send(JSON.stringify(msg)));
      pendingChunks = [];
    }
  };

  ws.onmessage = async (event) => {
    const t4 = Date.now(); // moment the processed chunk arrives back

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.error('[LT Content] Failed to parse server message:', err);
      return;
    }

    if (message.type === 'audio') {
      await handleProcessedAudio(message, t4);
    }
  };

  ws.onclose = (event) => {
    console.log(`[LT Content] WebSocket closed (code=${event.code}) — reconnecting in 3s`);
    chrome.runtime.sendMessage({ type: 'connectionStatus', connected: false });
    ws = null;
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('[LT Content] WebSocket error:', err);
    // onclose fires after onerror — reconnection handled there
  };
}

// ─── Handle Audio Chunks from injected.js ─────────────────────────────────────

/**
 * Called every 250ms when injected.js has encoded a mic audio chunk.
 * Wraps it in a JSON message with timing, pitch, and format metadata and sends
 * it over WebSocket (or queues it if the socket isn't open yet).
 *
 * @param {string} base64    — audio data, base64 encoded
 * @param {number} size      — original Blob size in bytes, for logging
 * @param {string} mimeType  — the mimeType used by MediaRecorder (e.g. 'audio/wav')
 */
function sendAudioChunk(base64, size, mimeType) {
  const id = ++chunkId;
  const t1 = Date.now();

  const message = {
    type:     'audio',
    chunkId:  id,
    t1,
    pitch:    currentPitch,
    mimeType: mimeType || 'audio/webm',
    data:     base64,
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    console.log(`[LT Content] Chunk ${id} sent (t1=${t1}, pitch=${currentPitch}, mime=${message.mimeType}, size=${size}B)`);
  } else {
    pendingChunks.push(message);
    console.log(`[LT Content] Chunk ${id} queued — WebSocket not ready (queue=${pendingChunks.length})`);
  }
}

// ─── Handle Processed Audio from Server ───────────────────────────────────────

/**
 * Called when the server returns a pitch-shifted audio chunk.
 * Calculates latency, reports stats to background.js, and forwards the
 * base64 audio to injected.js for playback through the fake mic.
 *
 * @param {object} message — parsed JSON from the server
 * @param {number} t4      — timestamp when this message was received
 */
async function handleProcessedAudio(message, t4) {
  const { chunkId: id, t1, t2, t3, data, processingFailed } = message;

  const networkIn  = t2 - t1; // extension → server
  const processing = t3 - t2; // server processAudioChunk()
  const networkOut = t4 - t3; // server → extension
  const total      = t4 - t1; // full round-trip

  console.log(
    `[LT Content] Chunk ${id} returned | net-in=${networkIn}ms | proc=${processing}ms | net-out=${networkOut}ms | total=${total}ms` +
    (processingFailed ? ' ⚠ PROCESSING FAILED — original audio' : '')
  );

  // Report latency to background.js so popup can display it
  chrome.runtime.sendMessage({
    type: 'latencyUpdate',
    stats: { chunkId: id, networkIn, processing, networkOut, total, processingFailed: !!processingFailed },
  });

  // Forward processed audio to injected.js for playback in the main world.
  // injected.js has the AudioContext and destinationNode — only it can play
  // audio into the fake mic stream.
  window.postMessage(
    { source: 'lt-content', type: 'playChunk', chunkId: id, data },
    '*'
  );
}

// ─── postMessage Listener (messages from injected.js) ────────────────────────

window.addEventListener('message', (event) => {
  if (!event.data || event.data.source !== 'lt-injected') return;

  const msg = event.data;

  switch (msg.type) {
    case 'micReady':
      // injected.js has intercepted getUserMedia and built the audio graph.
      // Now we open the WebSocket — from this point on we can start recording.
      console.log('[LT Content] micReady received — getUserMedia was intercepted ✓');
      console.log('[LT Content] Opening WebSocket connection to server');
      connectWebSocket();
      break;

    case 'audioChunk':
      // injected.js encoded a 250ms mic chunk and sent it here for WebSocket forwarding
      if (processingEnabled) {
        sendAudioChunk(msg.data, msg.size, msg.mimeType);
      }
      break;

    case 'recordingStarted':
      console.log('[LT Content] MediaRecorder confirmed started in main world');
      break;

    case 'recordingStopped':
      console.log('[LT Content] MediaRecorder confirmed stopped in main world');
      break;

    case 'recordingError':
      console.error('[LT Content] Recording error from injected.js:', msg.reason);
      break;

    default:
      // Silently ignore unknown messages — other extensions may postMessage too
      break;
  }
});

// ─── Message Listener (from background.js / popup) ───────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[LT Content] Message from background:', message);

  if (message.type === 'toggle') {
    processingEnabled = message.enabled;

    if (message.enabled) {
      console.log('[LT Content] Enabling processing — sending startRecording to injected.js');
      window.postMessage({ source: 'lt-content', type: 'startRecording' }, '*');
    } else {
      console.log('[LT Content] Disabling processing — sending stopRecording to injected.js');
      window.postMessage({ source: 'lt-content', type: 'stopRecording' }, '*');
    }

    sendResponse({ ok: true });
  }

  if (message.type === 'setPitch') {
    currentPitch = message.pitch;
    // Forward pitch change to injected.js so the MediaRecorder tag knows the value
    window.postMessage({ source: 'lt-content', type: 'setPitch', pitch: currentPitch }, '*');
    console.log(`[LT Content] Pitch forwarded to injected.js: ${currentPitch} semitones`);
    sendResponse({ ok: true });
  }

  if (message.type === 'ping') {
    sendResponse({ ok: true });
  }

  return true; // keep async sendResponse channel open
});

console.log('[LT Content] Isolated world setup complete — injected.js is loading in main world');
