/**
 * content.js — Live Translation Chrome Extension (Isolated World side)
 *
 * Runs in Chrome's isolated world — a sandboxed JS context separate from the
 * page. Because of this isolation, it CANNOT override navigator.mediaDevices
 * in a way that affects Google Meet. Instead, its first job is to inject
 * injected.js into the page's MAIN WORLD (where Meet lives).
 *
 * Architecture — Insertable Streams edition:
 *
 *   injected.js  (main world)       — owns getUserMedia override,
 *                                     MediaStreamTrackProcessor/Generator pipeline,
 *                                     PCM accumulation, processed audio playback
 *        ↕  window.postMessage
 *   content.js   (isolated world)   — owns WebSocket, Chrome API calls,
 *                                     latency maths, message routing
 *        ↕  chrome.runtime.sendMessage
 *   background.js (service worker)  — store stats, forward popup ↔ content
 *        ↕  chrome.tabs.sendMessage
 *   popup.js                        — displays status, toggle, pitch, latency
 *
 * Message types injected.js → content.js (via postMessage, source: 'lt-injected'):
 *   micReady      — Insertable Streams pipeline is ready, open WebSocket
 *   audioChunk    — 250ms raw PCM chunk ready to send to server
 *                   { chunkId, samples, sampleRate, numberOfChannels, timestamp }
 *
 * Message types content.js → injected.js (via postMessage, source: 'lt-content'):
 *   startRecording — enable processing
 *   stopRecording  — disable processing
 *   setPitch       — { pitch: N semitones }
 *   playChunk      — { chunkId, samples, sampleRate }  processed PCM from server
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

let ws                = null;   // WebSocket connection to the local server
let currentPitch      = 0;      // Current pitch in semitones (kept in sync with injected.js)
let processingEnabled = false;  // Whether audio processing is active

// Chunks that arrive before the WebSocket is open are dropped.
// Raw PCM is time-sensitive — stale audio from before the socket opened
// is useless. (Small chunks at 250ms: at most 1 chunk in flight.)

// ─── WebSocket Connection ─────────────────────────────────────────────────────

/**
 * Opens a WebSocket to ws://localhost:8080 and handles the lifecycle.
 * Auto-reconnects after 3 seconds on close.
 */
function connectWebSocket() {
  console.log('[LT Content] Opening WebSocket to ws://localhost:8080');
  ws = new WebSocket('ws://localhost:8080');

  ws.onopen = () => {
    console.log('[LT Content] WebSocket connected ✓');
    chrome.runtime.sendMessage({ type: 'connectionStatus', connected: true });
  };

  ws.onmessage = (event) => {
    const t4 = Date.now(); // moment the processed chunk arrives back

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      console.error('[LT Content] Failed to parse server message:', err);
      return;
    }

    // ── Legacy webm/opus audio echo (kept for backward compat) ───────────────
    if (message.type === 'audio') {
      handleProcessedAudioLegacy(message, t4);
    }

    // ── New PCM round-trip ────────────────────────────────────────────────────
    if (message.type === 'audioPCM') {
      handleProcessedPCM(message, t4);
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

// ─── Send Raw PCM Chunk to Server ─────────────────────────────────────────────

/**
 * Called when injected.js has accumulated 250ms of raw PCM samples (12000
 * samples at 48kHz) and wants them sent to the server for processing.
 *
 * We send the Float32Array values as a plain JSON array. This is acceptable
 * on localhost — when we deploy remotely we will add AudioEncoder (WebCodecs)
 * to compress to opus first and reduce bandwidth ~10×.
 *
 * @param {object} msg — the audioChunk postMessage from injected.js
 *   { chunkId, samples: number[], sampleRate, numberOfChannels, timestamp }
 */
function sendPCMChunk(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('[LT Content] PCM chunk', msg.chunkId, 'dropped — WebSocket not open');
    return;
  }

  const t1 = Date.now();
  const message = {
    type:             'audioPCM',
    chunkId:          msg.chunkId,
    t1,
    pitch:            currentPitch,
    sampleRate:       msg.sampleRate,
    numberOfChannels: msg.numberOfChannels,
    samples:          msg.samples,   // Float32Array values as JSON array
  };

  ws.send(JSON.stringify(message));
  console.log('[LT Content] PCM chunk', msg.chunkId, 'sent —',
    msg.samples.length, 'samples @ sampleRate=', msg.sampleRate,
    '| t1=', t1, '| pitch=', currentPitch);
}

// ─── Handle Processed PCM from Server ─────────────────────────────────────────

/**
 * Called when the server returns a processed PCM chunk (type: 'audioPCM').
 * Calculates latency, reports to background.js, and forwards the samples
 * to injected.js for playback via the Insertable Streams generator.
 *
 * @param {object} message — parsed JSON from the server
 *   { type, chunkId, t1, t2, t3, samples, sampleRate, numberOfChannels }
 * @param {number} t4 — timestamp when this message was received
 */
function handleProcessedPCM(message, t4) {
  const { chunkId, t1, t2, t3, samples, sampleRate, numberOfChannels } = message;

  const networkIn  = t2 - t1; // extension → server
  const processing = t3 - t2; // server processPCM()
  const networkOut = t4 - t3; // server → extension
  const total      = t4 - t1; // full round-trip

  console.log(
    `[LT Content] PCM chunk ${chunkId} returned | net-in=${networkIn}ms | proc=${processing}ms | net-out=${networkOut}ms | total=${total}ms`
  );

  // Report latency stats to background.js so popup can display them
  chrome.runtime.sendMessage({
    type:  'latencyUpdate',
    stats: { chunkId, networkIn, processing, networkOut, total, processingFailed: false },
  });

  // Forward processed samples to injected.js (main world) for playback.
  // injected.js owns the MediaStreamTrackGenerator — only it can write frames.
  window.postMessage({
    source:   'lt-content',
    type:     'playChunk',
    chunkId,
    samples,
    sampleRate,
  }, '*');
}

// ─── Handle Legacy webm/opus Echo (backward compatibility) ────────────────────

/**
 * Handles the old 'audio' message type from the server (webm/opus base64).
 * Kept so the old server echo path still reports latency, but injected.js
 * no longer plays webm/opus — it only plays PCM. This handler logs the
 * old path and reports latency but does not forward audio to injected.js.
 *
 * @param {object} message — { chunkId, t1, t2, t3, data, processingFailed }
 * @param {number} t4
 */
function handleProcessedAudioLegacy(message, t4) {
  const { chunkId: id, t1, t2, t3, processingFailed } = message;
  const networkIn  = t2 - t1;
  const processing = t3 - t2;
  const networkOut = t4 - t3;
  const total      = t4 - t1;

  console.log(
    `[LT Content] Legacy audio chunk ${id} returned | net-in=${networkIn}ms | proc=${processing}ms | net-out=${networkOut}ms | total=${total}ms` +
    (processingFailed ? ' ⚠ PROCESSING FAILED' : '') +
    ' (legacy webm/opus path — not forwarded to injected.js)'
  );

  chrome.runtime.sendMessage({
    type:  'latencyUpdate',
    stats: { chunkId: id, networkIn, processing, networkOut, total, processingFailed: !!processingFailed },
  });
}

// ─── postMessage Listener (messages from injected.js) ────────────────────────

window.addEventListener('message', (event) => {
  if (!event.data || event.data.source !== 'lt-injected') return;

  const msg = event.data;

  switch (msg.type) {
    case 'micReady':
      // injected.js has set up the Insertable Streams pipeline.
      // Open the WebSocket now — we can start receiving PCM chunks.
      console.log('[LT Content] micReady received — Insertable Streams pipeline active ✓');
      console.log('[LT Content] Opening WebSocket connection to server');
      connectWebSocket();
      break;

    case 'audioChunk':
      // injected.js accumulated 250ms of raw PCM samples — send to server
      if (processingEnabled) {
        sendPCMChunk(msg);
      }
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

  if (message.type === 'ping') {
    sendResponse({ ok: true });
  }

  if (message.type === 'getConnectionStatus') {
    // Popup (via background.js) is asking for the live WebSocket state.
    // Respond immediately with the current readyState — no async needed.
    const connected = ws && ws.readyState === WebSocket.OPEN;
    console.log('[LT Content] getConnectionStatus → connected:', connected);
    sendResponse({ connected });
    return true;
  }

  return true; // keep async sendResponse channel open
});

console.log('[LT Content] Isolated world setup complete — injected.js is loading in main world');
