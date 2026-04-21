# Live Translation — Complete Setup Guide

> **Assumed knowledge level:** None. If you have never installed Node.js, never loaded a Chrome extension, and never run a development server, this guide has you covered. Follow every step in order.

---

## Prerequisites — What You Need Before Starting

### 1. Node.js 18+

Node.js is the JavaScript runtime that runs the server. You need version 18 or higher.

**macOS (using Homebrew):**
```bash
# Install Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js
brew install node
```

**Ubuntu / Debian Linux:**
```bash
# Add NodeSource repository and install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows:**
Download the installer from https://nodejs.org — choose the LTS version. Run the installer, click through all the defaults, and make sure "Add to PATH" is checked.

**Verify installation:**
```bash
node -v
# Should print something like: v20.11.0
```

---

### 2. npm

npm (Node Package Manager) comes bundled with Node.js. You do not need to install it separately.

**Verify installation:**
```bash
npm -v
# Should print something like: 10.2.4
```

---

### 3. ffmpeg

ffmpeg is the command-line audio/video processing tool the server uses for pitch shifting.

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu / Debian Linux:**
```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

**Windows:**
1. Go to https://ffmpeg.org/download.html
2. Click "Windows" under "Get packages & executable files"
3. Click one of the build links (e.g., via gyan.dev)
4. Download the "ffmpeg-release-essentials.zip" file
5. Extract it to `C:\ffmpeg`
6. Add `C:\ffmpeg\bin` to your system PATH:
   - Open Start → search "Environment Variables" → click "Edit the system environment variables"
   - Click "Environment Variables" button
   - Under "System variables", find "Path" and click Edit
   - Click New and add `C:\ffmpeg\bin`
   - Click OK to close all dialogs
7. Open a new terminal window (old ones won't see the path change)

**Verify installation:**
```bash
ffmpeg -version
# Should print: ffmpeg version X.X.X ...
```

---

## Getting the Project

If you received this as a folder, skip this step.

If you are cloning from git:
```bash
git clone <your-repo-url> live-translation
```

Or if you created it fresh, just navigate into the project folder:
```bash
cd live-translation
# This is the root folder — all commands in this guide run from here
```

---

## Installing Dependencies

All project dependencies are installed with a single command from the root folder:

```bash
npm run install:all
```

This installs:
- Root dependencies (the `concurrently` tool that runs server and dashboard together)
- Server dependencies (`fastify`, `@fastify/websocket`, `fluent-ffmpeg`, etc.)
- Dashboard dependencies (`next`, `react`, `recharts`, etc.)

This may take 1-3 minutes. You will see npm output for each workspace.

---

## Starting the Project

From the root folder, run:

```bash
npm run dev
```

That is it. One command starts everything.

You will see output like this:
```
[SERVER]  Server running on port 8080
[SERVER]  WebSocket endpoint: ws://localhost:8080
[DASHBOARD] ▶ Ready at http://localhost:3000
```

- **Server logs** appear labeled `[SERVER]` in blue
- **Dashboard logs** appear labeled `[DASHBOARD]` in green

Press **Ctrl+C** at any time to stop both the server and the dashboard simultaneously.

The server and dashboard start in parallel using the `concurrently` package. This is configured in the root `package.json`. You do not need to open multiple terminals.

---

## Loading the Chrome Extension

The extension folder (`extension/`) is what you install into Chrome. You install it in Developer Mode, which allows loading unpacked extensions directly from your filesystem without going through the Chrome Web Store.

> **Important:** Use Google Chrome. Not Brave. Not Firefox. Not Edge. This extension uses Chrome-specific APIs and has only been tested in Chrome.

### Step-by-Step

**Step 1: Open Chrome's extension manager**

Type the following in Chrome's address bar and press Enter:
```
chrome://extensions
```

This opens the Extensions management page. You will see a list of all currently installed extensions.

**Step 2: Enable Developer Mode**

In the top-right corner of the Extensions page, look for a toggle labeled **"Developer mode"**. It is probably grey (off). Click it to turn it on (it should turn blue/green).

Once enabled, three new buttons appear at the top of the page:
- **Load unpacked**
- Pack extension
- Update

**Step 3: Click "Load unpacked"**

Click the **"Load unpacked"** button. A file picker dialog opens.

**Step 4: Navigate to the extension folder**

In the file picker:
1. Navigate to your `live-translation` project folder
2. Navigate into the `extension` subfolder
3. Click **Select Folder** (Windows) or **Open** (Mac/Linux)

> Make sure you select the `extension` folder ITSELF, not a file inside it.

**Step 5: Confirm the extension loaded**

The extension should now appear in the list with:
- Name: **Live Translation**
- A blue toggle in the bottom right (make sure it is ON)
- No error messages

If you see an error message below the extension name, double-check that all files in the `extension/` folder are present and have correct syntax.

**Step 6: Pin the extension to the toolbar**

1. Look for the **puzzle piece icon** in Chrome's toolbar (top right, next to the address bar)
2. Click it — a dropdown appears showing all your extensions
3. Find **Live Translation**
4. Click the **pin icon** (looks like a thumbtack) next to it

The Live Translation icon now appears permanently in your Chrome toolbar. You can click it anytime to open the popup.

---

## Using the Extension in a Meet Call

1. Make sure the server is running (`npm run dev` from root)
2. Open a new tab and go to `https://meet.google.com`
3. Start or join a meeting
4. Click the **Live Translation** icon in your Chrome toolbar
5. The popup opens — you should see a green dot next to "Connected"
6. Toggle **"Enable voice processing"** to ON
7. Other participants now hear your pitch-shifted voice

> **Note on microphone permission:** The first time you use the extension on Google Meet, Chrome may ask for microphone permission. Allow it. The extension needs this to capture your audio.

---

## Viewing the Dashboard

With the server running, open a new Chrome tab and go to:
```
http://localhost:3000
```

The dashboard shows:
- **Connection status** — green if connected to the server WebSocket
- **Total chunks processed** — increments every 250ms while you are on a call with voice processing enabled
- **Average latency** — rolling average of round-trip time
- **Latency graph** — line chart of the last 50 chunks' total latency
- **Raw log table** — detailed timestamps for each recent chunk

The dashboard updates in real time. Leave it open in a separate window alongside your Meet call.

---

## Reloading the Extension After Code Changes

When you modify files in the `extension/` folder, you need to reload the extension for Chrome to pick up your changes.

**How to reload:**
1. Go to `chrome://extensions`
2. Find **Live Translation** in the list
3. Click the **circular refresh arrow** icon (bottom left of the extension card)

Content scripts (like `content.js`) take effect on the next page load — you need to close and reopen the Meet tab. Background scripts reload immediately.

Alternatively, there is a keyboard shortcut: with the Extensions tab focused, you can press the refresh button icon.

> **Tip:** During development, use `console.log` liberally in your files. To see logs from `content.js`, open DevTools in the Meet tab (F12) → Console. To see logs from `background.js`, click the "service worker" link on the extension card in `chrome://extensions`.

---

## Troubleshooting

### "Extension not connecting to server" (red dot in popup)

The WebSocket server is not running. From the root folder, run:
```bash
npm run dev
```
If it is already running and still not connecting, try restarting it with Ctrl+C then `npm run dev` again.

---

### "No audio processing happening" (toggle is on but voice sounds unchanged)

Check microphone permissions:
1. Go to the Meet tab in Chrome
2. Click the **lock icon** in the address bar (left of the URL)
3. Find "Microphone" in the list and make sure it is set to "Allow"
4. Reload the Meet tab

---

### "ffmpeg not found" error in server logs

ffmpeg is not installed or not in your PATH. Install it following the instructions at the top of this guide, then restart the server.

Test that ffmpeg is in PATH by opening a new terminal and running `ffmpeg -version`.

---

### "Port 8080 already in use"

Something else on your machine is using port 8080 (another server, a proxy, etc.).

**Option A — Find and kill what is using port 8080:**

macOS/Linux:
```bash
lsof -ti:8080 | xargs kill
```

Windows (PowerShell):
```powershell
netstat -ano | findstr :8080
# Note the PID from the last column
taskkill /PID <PID> /F
```

**Option B — Change the port:**
1. In `server/index.js`, change `port: 8080` to another port (e.g., `9090`)
2. In `extension/content.js`, change `ws://localhost:8080` to `ws://localhost:9090`
3. Reload the extension and restart the server

---

### "Extension shows red dot / popup says Not Connected"

The WebSocket connection from `content.js` to the server failed. Causes:
1. Server is not running — run `npm run dev`
2. Port mismatch — check that both `content.js` and `server/index.js` use the same port
3. Firewall blocking localhost connections — unlikely on local machine, but check your firewall settings

---

### "Dashboard shows Disconnected"

The dashboard's WebSocket connection to the server dropped or never established.
1. Make sure the server is running
2. Refresh the dashboard tab — it will reconnect automatically after 3 seconds, or a page refresh forces an immediate reconnect
3. Check the browser console (F12 → Console) on the dashboard tab for error messages

---

### "Extension installed but voice is NOT being modified" / console shows "Cannot start recording — no real mic stream yet"

This error means the `getUserMedia` override is running in the wrong JavaScript context and never intercepts Google Meet's mic call.

**What it indicates:** Chrome runs content scripts in an *isolated world* — a separate JavaScript sandbox from the page. An override placed in `content.js` directly modifies the isolated world's `navigator`, not the page's `navigator` where Meet runs. Meet never sees the override.

**How to fix it:**

1. Make sure `injected.js` exists in the `extension/` folder. This is the file that installs the getUserMedia override in the correct (main world) context.

2. Open `manifest.json` and confirm that `web_accessible_resources` is declared:
   ```json
   "web_accessible_resources": [
     {
       "resources": ["injected.js"],
       "matches": ["https://meet.google.com/*"]
     }
   ]
   ```
   Without this the browser will refuse to load `injected.js` via the script tag.

3. Go to `chrome://extensions`, find **Live Translation**, click the **refresh icon** to reload the extension.

4. Close the Google Meet tab completely and reopen it. Content scripts only reload on a fresh page load.

5. Open DevTools on the Meet tab (F12 → Console). You should see these logs in order when Meet initialises:
   ```
   [LT Content] Isolated-world script starting
   [LT Content] injected.js script tag appended to DOM
   [LT Content] injected.js loaded and removed from DOM
   [LT Injected] Main world script loaded — installing getUserMedia override
   [LT Injected] getUserMedia override installed in main world ✓
   [LT Injected] getUserMedia intercepted — constraints: {...}
   [LT Injected] Got real mic stream from browser
   [LT Content] micReady received — getUserMedia was intercepted ✓
   [LT Content] Opening WebSocket connection to server
   ```
   If you see `[LT Content]` logs but no `[LT Injected]` logs, `injected.js` is not loading — check step 1 and 2 above.

---

### "Content script errors" in Meet tab console

Open DevTools in the Meet tab (F12 → Console). If you see errors from content.js:
1. Check for syntax errors in `content.js` — fix them and reload the extension
2. If the error is "Cannot read properties of null" — getUserMedia intercept fired before AudioContext was initialized. Check the initialization order in `content.js`.
3. If the error mentions CORS or security — check that `host_permissions` in `manifest.json` includes `https://meet.google.com/*`

---

## Full Project Structure Reference

```
live-translation/
├── docs/
│   ├── architecture.md      ← Full technical explanation (read this first)
│   └── setup.md             ← This file
├── extension/
│   ├── manifest.json        ← Extension config (Manifest V3)
│   ├── injected.js          ← Runs in page's MAIN WORLD — getUserMedia override, AudioContext
│   ├── content.js           ← Isolated world bridge — injects injected.js, owns WebSocket
│   ├── background.js        ← Service worker, message broker
│   ├── popup.html           ← Extension popup UI
│   └── popup.js             ← Popup logic
├── server/
│   ├── index.js             ← Fastify + WebSocket server, ffmpeg processing
│   └── package.json
├── dashboard/
│   ├── app/
│   │   ├── layout.tsx       ← Next.js root layout
│   │   └── page.tsx         ← Renders Dashboard component
│   ├── components/
│   │   └── Dashboard.tsx    ← Real-time latency dashboard
│   └── package.json
└── package.json             ← Root: npm workspaces + concurrently for "npm run dev"
```
