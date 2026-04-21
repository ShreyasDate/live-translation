/**
 * popup.js — Live Translation Extension Popup
 *
 * Runs inside popup.html when the user clicks the extension icon.
 * Communicates with background.js via chrome.runtime.sendMessage.
 *
 * Responsibilities:
 *   - Show connection status (connected / not connected)
 *   - Toggle: send enable/disable to background → content
 *   - Pitch slider: send new pitch value to background → content
 *   - Poll background every 2s for fresh latency stats and display them
 */

console.log('[LT Popup] Popup opened');

// ─── DOM References ───────────────────────────────────────────────────────────

const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const toggleCheckbox = document.getElementById('toggle-checkbox');

const latNetworkIn  = document.getElementById('lat-network-in');
const latProcessing = document.getElementById('lat-processing');
const latNetworkOut = document.getElementById('lat-network-out');
const latTotal      = document.getElementById('lat-total');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a millisecond value for display.
 * Returns '--' if the value is null/undefined.
 */
function fmt(ms) {
  if (ms === null || ms === undefined) return '--';
  return `${ms}ms`;
}

/**
 * Returns a CSS class name for colour-coding a latency value.
 *   green  → < 100ms
 *   amber  → 100–299ms
 *   red    → ≥ 300ms
 */
function latencyClass(ms) {
  if (ms === null || ms === undefined) return 'none';
  if (ms < 100)  return 'good';
  if (ms < 300)  return 'medium';
  return 'bad';
}

/**
 * Applies a latency value + colour class to an element.
 */
function setLatency(el, ms) {
  el.textContent = fmt(ms);
  el.className = `latency-value ${latencyClass(ms)}`;
}

/**
 * Updates the connection status indicators.
 */
function setConnected(connected) {
  if (connected) {
    statusDot.className  = 'status-dot connected';
    statusText.className = 'connected';
    statusText.textContent = 'Connected';
  } else {
    statusDot.className  = 'status-dot disconnected';
    statusText.className = 'disconnected';
    statusText.textContent = 'Not connected';
  }
}


// ─── Fetch & Render Stats ─────────────────────────────────────────────────────

/**
 * Asks background.js for the latest stats and updates all UI elements.
 */
async function fetchAndRenderStats() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'getStats' });
  } catch (err) {
    console.warn('[LT Popup] Failed to get stats:', err.message);
    setConnected(false);
    return;
  }

  if (!response) {
    setConnected(false);
    return;
  }

  setConnected(response.connected);

  const s = response.stats;
  setLatency(latNetworkIn,  s?.networkIn  ?? null);
  setLatency(latProcessing, s?.processing ?? null);
  setLatency(latNetworkOut, s?.networkOut ?? null);
  setLatency(latTotal,      s?.total      ?? null);

  console.log('[LT Popup] Stats updated:', response);
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

// Toggle switch — send enable/disable to background
toggleCheckbox.addEventListener('change', async () => {
  const enabled = toggleCheckbox.checked;
  console.log(`[LT Popup] Toggle changed → enabled=${enabled}`);
  try {
    await chrome.runtime.sendMessage({ type: 'toggle', enabled });
  } catch (err) {
    console.error('[LT Popup] Failed to send toggle:', err.message);
  }
});


// ─── Initialise ───────────────────────────────────────────────────────────────

// Fetch stats immediately when popup opens
fetchAndRenderStats();

// Poll every 2 seconds for fresh latency data
const pollInterval = setInterval(fetchAndRenderStats, 2000);

// Clean up polling when popup is closed (avoid ghost intervals)
window.addEventListener('unload', () => {
  clearInterval(pollInterval);
  console.log('[LT Popup] Popup closed — polling stopped');
});


console.log('[LT Popup] Initialised successfully');
