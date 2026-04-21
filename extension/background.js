/**
 * background.js — Live Translation Chrome Extension Service Worker
 *
 * This service worker acts as the message broker between the popup and the
 * content script. It cannot access any tab's DOM or JavaScript — it is a
 * sandboxed background process that wakes up to process messages and then
 * goes back to sleep.
 *
 * Responsibilities:
 *   - Store the latest latency stats and connection status in memory
 *   - Forward toggle/pitch messages from popup → content script (Meet tab)
 *   - Forward latency/status updates from content script → popup
 *
 * All console.log calls are prefixed with [LT Background].
 */

console.log('[LT Background] Service worker started');

// ─── In-memory state ──────────────────────────────────────────────────────────

let latestStats = {
  chunkId:     null,
  networkIn:   null,
  processing:  null,
  networkOut:  null,
  total:       null,
  processingFailed: false,
};

let isConnected = false;

// ─── Helper: find the active Meet tab ─────────────────────────────────────────

/**
 * Queries all open tabs for a Google Meet tab.
 * Returns the first matching tab, or null if none is found.
 */
async function getMeetTab() {
  const tabs = await chrome.tabs.query({ url: '*://meet.google.com/*' });
  if (tabs.length === 0) {
    console.warn('[LT Background] No Meet tab found');
    return null;
  }
  // Prefer the tab that is currently active; fall back to any Meet tab
  const activeTab = tabs.find(t => t.active) || tabs[0];
  console.log(`[LT Background] Found Meet tab id=${activeTab.id}`);
  return activeTab;
}

/**
 * Sends a message to the content script in the Meet tab.
 * Silently ignores errors (e.g., tab was closed between query and send).
 */
async function sendToMeetTab(message) {
  const tab = await getMeetTab();
  if (!tab) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    console.log(`[LT Background] Message forwarded to Meet tab:`, message, '→', response);
  } catch (err) {
    console.warn('[LT Background] Failed to send message to Meet tab:', err.message);
  }
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[LT Background] Message received:', message, 'from sender:', sender?.tab?.id ?? 'popup');

  // ── Messages FROM content.js ───────────────────────────────────────────────

  if (message.type === 'latencyUpdate') {
    // Content script calculated fresh latency stats — store them for popup
    latestStats = { ...message.stats };
    console.log('[LT Background] Stored latency update:', latestStats);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'connectionStatus') {
    isConnected = message.connected;
    console.log(`[LT Background] Connection status: ${isConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
    sendResponse({ ok: true });
    return true;
  }

  // ── Messages FROM popup.js ─────────────────────────────────────────────────

  if (message.type === 'getStats') {
    // Popup is polling for the latest stats — respond immediately
    console.log('[LT Background] Popup requested stats — responding with:', { latestStats, isConnected });
    sendResponse({ stats: latestStats, connected: isConnected });
    return true;
  }

  if (message.type === 'toggle') {
    // Forward the toggle to the Meet content script
    console.log(`[LT Background] Forwarding toggle (enabled=${message.enabled}) to Meet tab`);
    sendToMeetTab({ type: 'toggle', enabled: message.enabled });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'setPitch') {
    // Forward the pitch change to the Meet content script
    console.log(`[LT Background] Forwarding setPitch (pitch=${message.pitch}) to Meet tab`);
    sendToMeetTab({ type: 'setPitch', pitch: message.pitch });
    sendResponse({ ok: true });
    return true;
  }

  // Unknown message type — log and respond to avoid hanging
  console.warn('[LT Background] Unknown message type:', message.type);
  sendResponse({ ok: false, error: 'Unknown message type' });
  return true;
});

console.log('[LT Background] Message listener registered — ready');
