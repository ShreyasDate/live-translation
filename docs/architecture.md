# Live Translation — Architecture Deep Dive

> **Who this is for:** You have never built a Chrome extension. You have never worked with the Web Audio API. You have never used WebSockets. This document explains every concept, every API, every design decision, from scratch. Read it top to bottom once before touching a single line of code.

---

## Table of Contents

1. [What This Project Does](#1-what-this-project-does)
2. [What a Chrome Extension Is](#2-what-a-chrome-extension-is)
3. [How Chrome Extension Contexts Communicate](#3-how-chrome-extension-contexts-communicate)
4. [What getUserMedia Is](#4-what-getusermedia-is)
5. [How We Override getUserMedia](#5-how-we-override-getusermedia)
6. [What the Web Audio API Is](#6-what-the-web-audio-api-is)
7. [How Audio Capture Works](#7-how-audio-capture-works)
8. [How WebSockets Work](#8-how-websockets-work)
9. [How Latency Is Measured](#9-how-latency-is-measured)
10. [How Voice Processing Works on the Server](#10-how-voice-processing-works-on-the-server)
11. [How Processed Audio Gets Back Into the Meeting](#11-how-processed-audio-gets-back-into-the-meeting)
12. [The Dashboard](#12-the-dashboard)
13. [Why This Architecture Is the Foundation for Real Translation](#13-why-this-architecture-is-the-foundation-for-real-translation)
14. [The Isolated World Problem and How We Solved It](#14-the-isolated-world-problem-and-how-we-solved-it)
15. [The processAudioChunk Function — Placeholder and Future Replacement](#15-the-processaudiochunk-function--placeholder-and-future-replacement)
16. [Audio Format — Why We Use webm/opus and How It Flows Through the Pipeline](#16-audio-format--why-we-use-webmopus-and-how-it-flows-through-the-pipeline)
17. [Why We Removed the Pitch Shift Placeholder and What We Learned](#17-why-we-removed-the-pitch-shift-placeholder-and-what-we-learned)

---

## 1. What This Project Does

### The User Story

Imagine you are on a Google Meet call and you want other participants to hear a modified version of your voice — for example, a voice with a higher or lower pitch, or eventually a fully translated voice in a different language.

Here is what happens from the moment you install this extension:

1. **You install the Chrome extension.** Chrome loads three JavaScript environments: a background service worker, the popup interface, and a content script that gets injected into every Google Meet tab you open.

2. **You join a Google Meet call.** The moment `meet.google.com` loads, Chrome automatically injects `content.js` into that tab. This content script runs *before* Google Meet's own JavaScript loads. By the time Meet tries to access your microphone, our code has already replaced the browser's microphone API with our own custom version.

3. **Meet asks for your microphone.** Our intercepted version runs instead. We grab the real microphone stream ourselves, build a fake microphone stream using the Web Audio API, and hand this fake stream to Meet. Meet is completely unaware anything unusual happened — it received a valid microphone stream object and starts using it.

4. **You click the extension icon and toggle "Enable voice processing" on.** The popup sends a message to the background worker, which forwards it to the content script in your Meet tab. The content script starts a `MediaRecorder` on your real microphone, capturing audio chunks every 250 milliseconds.

5. **Each 250ms audio chunk is sent over a WebSocket** to the local Node.js server running on your machine at `ws://localhost:8080`. The chunk is base64-encoded and wrapped in JSON with timing metadata.

6. **The server receives the chunk.** It writes it to a temporary file, runs `ffmpeg` to apply a pitch shift, reads the processed file, and sends it back over the WebSocket to the extension.

7. **The extension receives the processed audio.** It decodes the base64 data, decodes the audio using the Web Audio API, creates an audio source from it, and plays it through the fake microphone stream. Because Meet is already using this fake microphone stream as its audio input, the pitch-shifted audio flows directly into the Meet call.

8. **Other participants hear your modified voice.** They have no idea this is happening. From their perspective, your microphone is simply producing modified audio.

9. **The developer dashboard** at `localhost:3000` shows live graphs of latency: how long each chunk spent in transit to the server, how long `ffmpeg` took to process it, how long the processed audio took to get back, and the total round-trip time.

### What Others on the Call Experience

Other participants hear whatever audio comes out of your fake microphone stream. In the current version, that is a pitch-shifted version of your voice. In the full translation version, it would be a synthesized voice speaking in a different language. The pipeline is identical; only the server-side processing step changes.

---

## 2. What a Chrome Extension Is

A Chrome extension is a collection of JavaScript (and HTML/CSS) files that Chrome loads and runs in specific contexts. It is not a webpage. It is not a Node.js program. It is a set of files that plug into Chrome's internal architecture and gain access to browser APIs that normal webpages cannot access.

Think of it like a browser plugin that can do four things ordinary websites cannot:
- Run JavaScript persistently in the background, even when no tab is focused
- Inject JavaScript into other websites
- Intercept and modify network requests
- Show a small custom UI (the popup) when the user clicks the extension icon

Every extension is defined by a single `manifest.json` file. This file is the extension's identity card — it tells Chrome everything: what the extension is called, what permissions it needs, which JavaScript files to load, where to inject them, and what triggers what.

### File Roles

#### `manifest.json`

This is the configuration file. Chrome reads it when you install the extension and uses it to set up every piece. It defines:

- **`name`**: The human-readable name shown in `chrome://extensions` and the Chrome Web Store. We use `"Live Translation"`.

- **`version`**: A version string (`"1.0"`). Chrome uses this for updates when you distribute through the Web Store.

- **`description`**: A short description shown in the Web Store and extension management page.

- **`manifest_version`**: Must be `3`. Manifest V2 is deprecated. V3 is the current standard. The key difference is that V3 uses service workers instead of persistent background pages, and has stricter content security policies.

- **`permissions`**: An array of capabilities the extension needs. We request:
  - `"activeTab"`: Allows the extension to access the currently active tab. Required for the popup to interact with the current page.
  - `"scripting"`: Allows the extension to programmatically inject scripts into tabs (used by the background worker to communicate with content scripts).
  - `"storage"`: Allows reading and writing to Chrome's extension storage (we do not heavily use this, but it is good practice to declare it).

- **`host_permissions`**: Specifies which websites the extension is allowed to interact with. We specify `"https://meet.google.com/*"` — the `*` is a wildcard meaning any URL path under that domain. Without this, content scripts would not be injected and the extension could not access the Meet tab.

- **`background`**: Defines the background service worker. We set `{ "service_worker": "background.js" }`. This tells Chrome to load `background.js` as a service worker — a special type of JavaScript worker that runs independently of any tab.

- **`content_scripts`**: An array of objects defining which scripts to inject into which pages. Each object has:
  - `"matches"`: Which URLs to inject into. We use `["https://meet.google.com/*"]`.
  - `"js"`: Which JavaScript files to inject. We inject `["content.js"]`.
  - `"run_at"`: When to inject. We use `"document_start"` — this is critical and explained in detail in Section 5.

- **`action`**: Defines the popup. `{ "default_popup": "popup.html" }` tells Chrome to show `popup.html` when the user clicks the extension icon.

#### `content.js`

Chrome injects this file into the Google Meet webpage at `document_start`. However, Chrome runs content scripts in an **isolated world** — a sandboxed JavaScript context separate from the page itself (this is explained in full detail in Section 14). This means that directly overriding `navigator.mediaDevices.getUserMedia` here would have no effect on Google Meet, because Meet runs in the **main world**.

To work around this, `content.js` does not attempt the override itself. Instead, its first job is to inject `injected.js` into the page's main world by creating a `<script>` tag. After that, `content.js` acts as the **bridge** between the main world and Chrome's extension APIs:
1. It injects `injected.js` into the main world
2. It owns the WebSocket connection to the server (Chrome APIs like WebSocket are fully accessible from the isolated world)
3. It receives audio chunks from `injected.js` via `window.postMessage` and forwards them over WebSocket
4. It receives processed audio back from the server and forwards it to `injected.js` to play
5. It relays toggle and pitch commands from `background.js` to `injected.js`

#### `injected.js`

This is the file that actually overrides `navigator.mediaDevices.getUserMedia`. It runs in the page's **main world** — the same JavaScript context as Google Meet — so its override genuinely intercepts Meet's mic call.

`injected.js` owns all audio processing that requires main-world access:
1. The `getUserMedia` override — intercepts Meet's mic call
2. The `AudioContext` and Web Audio processing graph
3. The `MediaRecorder` — captures the real mic in 250ms chunks
4. Audio playback — decodes and plays processed chunks through the fake mic

Because `injected.js` runs in the main world, it cannot use any Chrome extension APIs (`chrome.runtime`, `chrome.tabs`, etc.). Communication with `content.js` happens exclusively via `window.postMessage`.

#### `background.js`

This is a service worker — a special type of JavaScript worker that Chrome runs separately from any tab. Think of it as a tiny background process running inside Chrome.

Key properties of a service worker:
- It has no access to the DOM (there is no webpage for it to access)
- It can run even when no Meet tab is open
- In Manifest V3, it does not run continuously — Chrome wakes it up when it receives a message, then it goes back to sleep. This is fine for our use case.
- It acts as a **message broker**: the popup and content script are in completely separate JavaScript contexts and cannot talk directly. Background.js sits in the middle and passes messages between them.
- It can use Chrome APIs like `chrome.tabs.query` to find specific tabs and `chrome.tabs.sendMessage` to send messages to a content script running in a specific tab.

#### `popup.html` and `popup.js`

When the user clicks the extension icon in Chrome's toolbar, Chrome opens a small window and loads `popup.html` inside it. This is just an HTML page — it can have CSS, it can have JavaScript (`popup.js`), it can have buttons and inputs. But it runs in its own isolated JavaScript context, completely separate from any webpage or the background worker.

`popup.js` handles:
- Displaying connection status (is the content script connected to the server?)
- The toggle switch to enable/disable audio processing
- The pitch slider
- The latency display, updated every 2 seconds by polling background.js

The popup communicates only through `chrome.runtime.sendMessage` — it cannot directly access `content.js` or `background.js`'s variables.

---

## 3. How Chrome Extension Contexts Communicate

This is one of the most confusing parts of Chrome extension development. There are three completely isolated JavaScript environments:

1. **The popup** (`popup.js`) — runs when the popup is open
2. **The background service worker** (`background.js`) — always running (or woken up by messages)
3. **The content script** (`content.js`) — runs inside the Meet tab

These three environments are sandboxed from each other. They literally cannot access each other's variables. If `popup.js` sets `window.latencyData = {...}`, `background.js` cannot read it. The only way they can communicate is through Chrome's messaging API.

### The Messaging API

**`chrome.runtime.sendMessage(message)`**
Sends a one-time message to any listener within the same extension. Returns a promise that resolves with the response. Used by content scripts and popups to send messages to the background worker.

**`chrome.runtime.onMessage.addListener(callback)`**
Registers a listener function. When a message arrives, the callback is called with `(message, sender, sendResponse)`. If you return a value from `sendResponse`, it is sent back as the reply to the caller. Used in `background.js` to listen for messages from content scripts and popups.

**`chrome.tabs.sendMessage(tabId, message)`**
Sends a message to the content script running in a specific tab, identified by `tabId`. This is how the background worker forwards messages to `content.js` in the Meet tab. You first need to find the tab's ID using `chrome.tabs.query`.

**`chrome.tabs.query({ active: true, url: "*://meet.google.com/*" })`**
Searches all open tabs matching the specified criteria. Returns an array of matching Tab objects, each with a `.id` property. This is how `background.js` finds the active Meet tab to forward messages to.

### The Message Flow in This Project

The full message architecture now has four layers because of the isolated world split:

```
User clicks toggle in popup
    ↓
popup.js: chrome.runtime.sendMessage({ type: "toggle", enabled: true })
    ↓
background.js: queries Meet tab → chrome.tabs.sendMessage(tabId, { type: "toggle", enabled: true })
    ↓
content.js (isolated world): receives chrome message
    ↓
window.postMessage({ source: 'lt-content', type: 'startRecording' })
    ↓
injected.js (main world): receives postMessage → starts MediaRecorder
```

```
injected.js encodes 250ms mic chunk → window.postMessage({ source: 'lt-injected', type: 'audioChunk', data: base64 })
    ↓
content.js receives postMessage → sends chunk over WebSocket to server
    ↓
server processes chunk → sends processed audio back over WebSocket
    ↓
content.js receives processed audio → calculates latency
    ↓
content.js: chrome.runtime.sendMessage({ type: 'latencyUpdate', stats })
    ↓
background.js stores stats
    ↓
content.js: window.postMessage({ source: 'lt-content', type: 'playChunk', data: base64 })
    ↓
injected.js plays audio through fake mic → Meet participants hear it
```

---

## 4. What getUserMedia Is

`getUserMedia` is part of the WebRTC (Web Real-Time Communications) specification, a set of browser APIs designed for real-time audio/video communication between browsers.

The full path to this function is:
```javascript
navigator.mediaDevices.getUserMedia(constraints)
```

- `navigator` is a global browser object containing information about the browser and device.
- `navigator.mediaDevices` is an object exposing media input/output device APIs.
- `getUserMedia` is an async function that requests access to the user's camera and/or microphone.

When called, the browser shows a permission dialog: "meet.google.com wants to use your microphone. Allow or Block?" If the user allows, the function resolves with a **MediaStream** object.

### What Is a MediaStream?

A `MediaStream` is a JavaScript object representing a stream of audio and/or video data coming from a real device or being generated programmatically. Think of it like a pipe — on one end is a microphone producing audio, on the other end is whatever is consuming the stream (Google Meet, in this case).

A MediaStream has zero or more **tracks**.

### What Is a MediaStreamTrack?

A `MediaStreamTrack` represents an individual audio or video channel within a stream. When you call `getUserMedia({ audio: true })`, you get a MediaStream with one audio track — the track carrying audio data from your microphone.

Tracks can be:
- **Live**: actively receiving data from a device
- **Muted**: temporarily not producing data
- **Ended**: the device has been released and no more data will come

When you call `stream.getTracks()`, you get an array of all tracks. `stream.getAudioTracks()` gives only audio tracks.

### What Google Meet Does

When Meet starts, somewhere in its JavaScript is code equivalent to:
```javascript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
// stream is now used for the call
```

This is the call we intercept.

---

## 5. How We Override getUserMedia

The actual override lives in `injected.js`, which runs in the page's main world. The technique is the same regardless of which file it is in — see Section 14 for why we need a separate file.

Here is the core technique in `injected.js`:

```javascript
// Step 1: Save a reference to the original function
// Must happen immediately on script load, before Meet's code runs
const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

// Step 2: Replace it with our function
navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (constraints && constraints.audio) {
        // Step 3: Get the REAL mic stream using the saved original
        const realStream = await originalGetUserMedia(constraints);

        // Step 4: Build the Web Audio graph in the main world
        const audioContext   = new AudioContext();
        const sourceNode     = audioContext.createMediaStreamSource(realStream);
        const destinationNode = audioContext.createMediaStreamDestination();
        sourceNode.connect(destinationNode);

        // Step 5: Notify content.js (isolated world) that the mic is ready
        window.postMessage({ source: 'lt-injected', type: 'micReady' }, '*');

        // Step 6: Return the fake stream to Meet
        return destinationNode.stream; // Meet uses this for the entire call
    }
    return originalGetUserMedia(constraints);
};
```

Meet calls `getUserMedia`, receives `destinationNode.stream` (the fake mic), and uses it for the entire call.

### Why `document_start` + Script Injection Is Critical

`manifest.json` specifies `"run_at": "document_start"` for `content.js`. The moment Chrome injects `content.js`, its very first action is:

```javascript
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).appendChild(script);
```

This injects `injected.js` into the main world synchronously, before the rest of the page parses. The `getUserMedia` override inside `injected.js` is therefore in place before Meet ever calls it.

If `content.js` were injected at `document_end` or `document_idle`, Meet would have already loaded and called `getUserMedia` with no override in place.

### Why `.bind(navigator.mediaDevices)`

`getUserMedia` internally uses `this` to refer to the `mediaDevices` object. If we extracted the function without binding, calling it as a plain function would lose `this` context and throw an error. `.bind(navigator.mediaDevices)` permanently attaches the correct `this` to our saved reference.

### Handling Multiple getUserMedia Calls

Google Meet sometimes calls `getUserMedia` more than once — on reconnect, codec renegotiation, or when the user grants permissions. `injected.js` guards against this:

```javascript
if (realMicStream) {
    // Already set up — return the same fake stream
    return destinationNode.stream;
}
```

This ensures we only build one AudioContext and one fake mic stream, no matter how many times Meet calls getUserMedia.

---

## 6. What the Web Audio API Is

The Web Audio API is a browser API for creating, processing, and routing audio programmatically. It was designed for music applications and games but is equally useful for voice processing.

The central concept is the **AudioContext** — a container for all audio processing. Think of it as an audio engine. You create nodes, connect them in a graph, and audio flows through the graph.

### The Node-Based Architecture

Every sound source, processor, and output is represented as a **node**. Nodes have:
- **Inputs**: where audio flows in
- **Outputs**: where audio flows out
- **Parameters**: values that control their behaviour

You connect nodes using `nodeA.connect(nodeB)`, meaning audio flowing out of `nodeA` goes into `nodeB`. Audio flows through this graph in real time, processed at audio rate (typically 44,100 or 48,000 samples per second).

This is exactly like a signal chain in a recording studio: microphone → preamp → equalizer → compressor → speakers. Each piece of equipment is a node.

### Nodes Used in This Project

#### `MediaStreamSourceNode`

Created by: `audioContext.createMediaStreamSource(stream)`

This node takes a `MediaStream` object (your real microphone stream) and wraps it so it can enter the Web Audio processing chain. Without this node, you cannot use a real microphone stream as input to the Web Audio graph.

Audio flows: Real Mic → MediaStreamSourceNode → [processing nodes] → ...

#### `MediaStreamDestinationNode`

Created by: `audioContext.createMediaStreamDestination()`

This is the opposite of `MediaStreamSourceNode`. Whatever audio arrives at this node's input gets wrapped into a new `MediaStream` object. You access this stream via `destinationNode.stream`.

This is how we create the "fake microphone." We create this node, and `destinationNode.stream` becomes our fake mic stream. We hand this stream to Meet. Anything we route into this node's input will be picked up by Meet as microphone audio.

Audio flows: ... → [processing nodes] → MediaStreamDestinationNode → `destinationNode.stream` → Meet

#### `AudioBufferSourceNode`

Created by: `audioContext.createBufferSource()`

This node plays a decoded audio clip (an `AudioBuffer`) through the audio context. Unlike a streaming source, an `AudioBuffer` holds a complete clip of audio in memory.

We use this when processed audio arrives back from the server. We decode the audio into an `AudioBuffer`, create a source node, set its buffer, and call `source.start()`. The audio plays through the node and we route it to the destination node, which feeds it into the Meet call.

A `BufferSourceNode` can only be used once — after it finishes playing, you discard it and create a new one for the next chunk.

#### `DynamicsCompressorNode`

Created by: `audioContext.createDynamicsCompressor()`

This processes audio to control its dynamic range — the difference between the quietest and loudest parts. When the audio gets louder than a threshold, the compressor automatically turns it down, making the overall audio more consistent in volume.

In future versions, this would be used for **sidechain ducking**: when a translated voice starts playing through the fake mic, we want the original mic audio to automatically get quieter so the two do not overlap. The translation audio would "key" (trigger) the compressor on the original voice chain.

This is not fully implemented in this version but the architectural foundation is here.

### The Full Audio Graph in This Project

```
Real Microphone
     ↓
MediaStreamSourceNode (brings mic into Web Audio)
     ↓
MediaStreamDestinationNode (creates fake mic stream)
     ↑
AudioBufferSourceNode (plays processed audio chunks from server)
```

Note: in the initial setup, we connect source directly to destination — so audio flows through unchanged. Once we enable processing, we stop playing the raw mic through (Meet is already using the fake mic), and instead we play the server-processed chunks through the destination.

---

## 7. How Audio Capture Works

Once we have the real microphone stream, we need to capture its audio, chop it into chunks, and send it to the server.

### MediaRecorder

`MediaRecorder` is a browser API that records a `MediaStream` to a compressed audio or video file. We use it to record the real microphone.

```javascript
const recorder = new MediaRecorder(realMicStream, { mimeType: 'audio/webm;codecs=opus' });
```

- **`realMicStream`**: the actual microphone stream we got from the original `getUserMedia`
- **`mimeType`**: tells MediaRecorder what format to encode the audio in. `audio/webm;codecs=opus` means WebM container format with Opus audio codec. This is Chrome's native format — no conversion needed.

**WebM** is a container format (like a box) that holds compressed audio/video data. **Opus** is a highly efficient audio codec (compression algorithm) developed by Xiph and Mozilla. It is excellent for speech — low latency, good quality, efficient bitrate.

### The `ondataavailable` Event

```javascript
recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
        sendChunk(event.data);
    }
};
```

Every N milliseconds, MediaRecorder emits this event with `event.data` — a **Blob** of audio data.

### What Is a Blob?

A `Blob` (Binary Large Object) is a JavaScript object representing raw binary data. It is like a file in memory — it has a size (in bytes) and a MIME type, but no name. When MediaRecorder gives us a Blob, it contains compressed audio data in WebM/Opus format — the same bytes that would be in a `.webm` audio file.

### The Timeslice

```javascript
recorder.start(250);
```

The `250` is the **timeslice** in milliseconds. MediaRecorder fires `ondataavailable` every 250ms. This is the granularity of our audio streaming — we send a new chunk to the server every quarter second.

Why 250ms? It balances two competing needs:
- **Latency**: smaller chunks mean less delay between you speaking and the processed audio playing back. Chunks that are too large add latency.
- **Overhead**: smaller chunks mean more WebSocket messages and more `ffmpeg` invocations per second. Chunks that are too small create excessive overhead.
- **ffmpeg startup cost**: each chunk requires spawning an ffmpeg process. 250ms produces 4 chunks per second — manageable without overwhelming the server.

For production, you would use a streaming process like a Node.js audio stream or a persistent ffmpeg process with a pipe to avoid the per-chunk ffmpeg startup overhead.

### The Audio Format

Each chunk is a valid WebM/Opus audio segment that can be decoded independently. In practice, only the first chunk contains the full WebM header, so the server must be careful about this. ffmpeg handles it gracefully — it reads the file as a stream and processes whatever audio it finds.

---

## 8. How WebSockets Work

### HTTP vs WebSocket

**HTTP** (HyperText Transfer Protocol) is a request-response protocol. The client sends a request. The server sends a response. The connection closes. Every interaction requires the client to initiate.

This model is fine for loading web pages but terrible for real-time bidirectional data like audio streaming. Imagine opening a new HTTP connection 4 times per second to send audio chunks — the overhead would be enormous.

**WebSocket** is a different protocol built on top of HTTP. It starts with an HTTP "upgrade" handshake, then the connection transforms into a persistent, full-duplex channel. Both the client and server can send data at any time without the other side requesting it. The connection stays open indefinitely (until explicitly closed or the network drops).

For our audio pipeline:
- The extension opens one WebSocket connection when a Meet tab opens
- This single connection stays open for the entire meeting
- Audio chunks fly through it bidirectionally at 4 chunks/second without any connection overhead

### The WebSocket API

```javascript
// Open a connection
const ws = new WebSocket('ws://localhost:8080');

// React to connection being established
ws.onopen = () => console.log('Connected');

// React to messages from server
ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    // process message...
};

// Send a message to the server
ws.send(JSON.stringify({ type: 'audio', data: base64string }));

// React to connection closing
ws.onclose = () => console.log('Disconnected');

// Close the connection
ws.close();
```

Note the protocol prefix: `ws://` for unencrypted (like `http://`) and `wss://` for encrypted (like `https://`). Since both our extension and server run locally, we use `ws://`.

### The Message Format

We use JSON messages with base64-encoded audio:

```json
{
    "type": "audio",
    "chunkId": 42,
    "t1": 1714000000123,
    "pitch": 2,
    "data": "GkXfo59ChoEBQveBAULygQRC84EIQoKEd..."
}
```

**Why base64?** WebSocket can send either text frames or binary frames. Text frames expect UTF-8 text. Audio data is arbitrary binary bytes — it contains values that are not valid UTF-8 characters. **Base64** is an encoding scheme that converts any binary data to a string of safe ASCII characters (A-Z, a-z, 0-9, +, /). Every 3 bytes of binary become 4 ASCII characters, a 33% size overhead. We accept this overhead in exchange for being able to send the audio as plain JSON text.

Binary WebSocket frames would be more efficient (no 33% overhead, no JSON parsing), but require more complex protocol design. For this prototype, JSON + base64 is simpler to debug — you can log messages directly and read the structure.

In `content.js`:
```javascript
// Convert Blob to base64
const arrayBuffer = await blob.arrayBuffer();
const uint8Array = new Uint8Array(arrayBuffer);
const base64 = btoa(String.fromCharCode(...uint8Array));
```

`btoa` (Binary to ASCII) is the browser's built-in base64 encoder.

---

## 9. How Latency Is Measured

Latency measurement is critical for understanding the performance of this pipeline. We use four timestamps to break down the round-trip time into three segments.

### The Four Timestamps

**t1 — Extension sends chunk**
Set in `content.js` the instant before calling `ws.send()`. Uses `Date.now()`, which returns the current time in milliseconds since January 1, 1970 (Unix epoch). Example value: `1714000000123`.

**t2 — Server receives chunk**
Set in `server/index.js` the instant `ws.onmessage` fires. The difference `t2 - t1` tells us how long the audio chunk took to travel from the extension to the server through the local network (which is just localhost, so this should be very small).

**t3 — Server finishes processing**
Set in `server/index.js` immediately after `ffmpeg` finishes. The difference `t3 - t2` tells us how long `ffmpeg` took to apply the pitch shift. This includes the ffmpeg process startup time, audio decoding, filter application, audio encoding, and process exit.

**t4 — Extension receives processed chunk**
Set in `content.js` the instant `ws.onmessage` fires with the processed audio. The difference `t4 - t3` tells us how long the processed chunk took to travel back from the server.

**Total round-trip: `t4 - t1`**

This gives us a comprehensive breakdown:
- `t2 - t1`: Network latency (extension → server)
- `t3 - t2`: Server processing time
- `t4 - t3`: Network latency (server → extension)
- `t4 - t1`: Total latency

### Why This Works Without Synchronizing Clocks

A common pitfall with distributed systems: if the client clock and server clock differ, latency measurements become meaningless. For example, if the server clock is 100ms ahead of the client, `t2 - t1` would always appear to be 100ms slower than it really is.

We sidestep this by including `t1` in the JSON message body. The server reads `t1` from the message, stores it, and includes it in the response. The extension then calculates `t4 - t1` entirely on the extension side using its own clock. The server's clock is only used internally to measure `t3 - t2` (server processing time), which is valid because both t2 and t3 are measured on the same machine.

---

## 10. How Voice Processing Works on the Server

### What Is ffmpeg?

`ffmpeg` is an open-source command-line tool for processing audio and video. It can decode and encode virtually any audio/video format, apply filters, change sample rates, adjust bitrates — essentially anything you might want to do to a media file.

We use it because:
- It is battle-tested and extremely reliable
- It handles WebM/Opus natively — the exact format the browser sends us
- It has built-in audio filters including pitch shifting
- It is available on every platform (Windows, Mac, Linux)

### The Command We Run

For a chunk with a pitch shift of +2 semitones:

```bash
ffmpeg -y -i /tmp/lt_input_42.webm \
    -af "asetrate=48000*1.1224620483,aresample=48000" \
    /tmp/lt_output_42.webm
```

Let us break this down:

- **`-y`**: Overwrite output file if it exists without asking
- **`-i /tmp/lt_input_42.webm`**: Input file (the audio chunk we wrote)
- **`-af "..."`**: Apply an audio filter chain
- **`asetrate=48000*1.1224620483`**: The pitch shift filter
- **`aresample=48000`**: Resample back to 48kHz
- `/tmp/lt_output_42.webm`: Output file

### The asetrate Filter

`asetrate` changes the assumed sample rate of the audio without resampling. Normally audio recorded at 48kHz plays back at normal speed because the player reads 48,000 samples per second. If you tell the player "this audio has 54,000 samples per second" (asetrate=54000), it plays the same 48,000 samples in less time — faster playback. Faster playback = higher pitch.

The mathematically correct formula for semitone pitch shifting is:

```
new_sample_rate = original_sample_rate × 2^(semitones/12)
```

This comes from how musical pitch works: every 12 semitones is one octave, and each octave doubles the frequency. `2^(1/12)` ≈ 1.0595 is the frequency ratio between adjacent semitones.

So for +2 semitones: `2^(2/12)` = `2^(1/6)` ≈ 1.1225

For -3 semitones: `2^(-3/12)` = `2^(-1/4)` ≈ 0.8409

### The aresample Filter

After `asetrate`, ffmpeg knows the audio is at a different sample rate (say 53,888Hz for +2 semitones). But we need the output to be at 48kHz for the browser to play it correctly. `aresample=48000` resamples the audio back to 48kHz — this correctly stretches or compresses the audio to fit the target rate.

The combined effect: the audio plays at the original speed (duration is preserved) but at a different pitch. Note that this is a rough approximation — it slightly affects speed as well. A production system would use a **phase vocoder** algorithm (like rubberband or soundtouch) which correctly shifts pitch without affecting tempo. We use asetrate because it is a single ffmpeg filter chain — no extra libraries needed.

### Error Handling

If ffmpeg fails (corrupted chunk, unexpected format, timeout), the server catches the error and sends the original unprocessed audio back to the extension with a `{ processingFailed: true }` flag. This ensures the pipeline never crashes and the voice call continues, just without the pitch effect for that chunk.

---

## 11. How Processed Audio Gets Back Into the Meeting

This section covers the full return path — from base64 string in a WebSocket message to sound coming out of the participants' speakers on the other side of a Google Meet call.

### Step 1: Receive the Message

```javascript
ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'audio') {
        const t4 = Date.now();
        // ... calculate latency ...
        
        // Decode the base64 audio data
        const binaryString = atob(message.data); // atob = ASCII to Binary
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const arrayBuffer = bytes.buffer;
```

`atob` (ASCII to Binary) is the browser's built-in base64 decoder. It gives us a binary string where each character represents one byte.

### Step 2: Decode the Audio

```javascript
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
```

`AudioContext.decodeAudioData` takes an `ArrayBuffer` containing encoded audio (WebM/Opus in our case) and decodes it into an `AudioBuffer` — the Web Audio API's internal representation.

An **AudioBuffer** is a container for decoded, uncompressed audio samples in memory. It represents audio as an array of floating-point numbers between -1.0 and 1.0, one number per sample. For stereo audio, there are two such arrays (channels). At 48kHz, a 250ms buffer contains 12,000 samples per channel.

The browser handles the decoding — we do not need to know anything about the WebM/Opus format. We just hand it the bytes and get back an AudioBuffer.

### Step 3: Create a Source Node and Play It

```javascript
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(destination); // destination = MediaStreamDestinationNode
        source.start();
```

- `createBufferSource()` creates an `AudioBufferSourceNode`
- We set its `buffer` to our decoded audio
- We connect it to the `destination` (the `MediaStreamDestinationNode`)
- `source.start()` begins playing immediately

### Step 4: Audio Flows Into the Meet Call

`destination` is the `MediaStreamDestinationNode` we created back when we first intercepted `getUserMedia`. Its `.stream` property is the fake MediaStream we handed to Meet. Meet is already using this stream as its microphone input — it is feeding every audio packet from this stream directly into the call.

When `source.start()` plays, audio flows through the `AudioBufferSourceNode` → `MediaStreamDestinationNode` → Meet's input → Google's servers → other participants' speakers.

The end-to-end path: your voice → real mic → MediaRecorder → WebSocket → ffmpeg → WebSocket → AudioBufferSourceNode → MediaStreamDestinationNode → Google Meet → other participants.

---

## 12. The Dashboard

The dashboard is a separate Next.js application running at `localhost:3000`. It connects to the same server but on a different WebSocket endpoint: `ws://localhost:8080?client=dashboard`.

### Why a Separate WebSocket Path?

The same Fastify WebSocket server handles both extension clients and dashboard clients. When a new WebSocket connection arrives, the server checks the URL query parameters. If `?client=dashboard` is present, it adds the connection to the dashboard clients set and sends it latency statistics. Otherwise, it treats it as an extension client.

### Real-Time Data Flow

1. Extension sends an audio chunk to the server
2. Server processes it with ffmpeg
3. Server broadcasts latency stats to all connected dashboard clients
4. Each dashboard connection receives the stats object: `{ chunkId, t1, t2, t3, networkIn, processing }`
5. React state updates — the component re-renders with the new data
6. The chart adds a new data point; the table shows the new row

### Auto-Reconnect

If the server restarts or the WebSocket drops, the dashboard attempts to reconnect every 3 seconds. This is implemented with `setInterval` in a `useEffect` hook.

### The Chart

We use `recharts` to draw a line chart of the last 50 chunk round-trip latencies. Reference lines at 100ms (green) and 300ms (red) help you immediately see if latency is within an acceptable range. Below 100ms is excellent. 100-300ms is acceptable for voice. Above 300ms feels noticeably laggy.

---

## 13. Why This Architecture Is the Foundation for Real Translation

This project is explicitly designed as the infrastructure layer for a real voice translation system. Everything you see here solves the hard engineering problems. The actual translation is just one function swap on the server.

### Current Server Processing

```
Extension sends audio/wav chunk
    ↓
processAudioChunk() — decode WAV → Float32 PCM samples → linear interpolation pitch shift → re-encode WAV
    ↓
Extension receives processed audio/wav, decodes, plays through fake mic
```

The entire processing logic is isolated in one function: `processAudioChunk(inputBuffer, mimeType, pitchSemitones)`. See Section 15 for a full explanation.

### Future Translation Processing

```
Input WebM → Deepgram STT (speech-to-text) → Gemini Flash (translation) → Deepgram Aura TTS (text-to-speech) → Output audio
```

**What stays exactly the same:**
- The Chrome extension (`content.js`, `background.js`, `popup.js`, `manifest.json`) — zero changes
- The WebSocket protocol and message format — zero changes
- The fake microphone override technique — zero changes
- The latency measurement system — zero changes
- The dashboard — zero changes (it just shows different processing times)
- The Fastify server structure — minimal changes (swap the processing function)

**What changes:**
- The processing function in `server/index.js` — replace ffmpeg with three API calls

### Why This Matters

Building the translation pipeline first, with a fake but working voice effect, proves that:
1. The getUserMedia override works reliably in Google Meet
2. The WebSocket streaming is fast enough at 250ms chunks
3. Audio decoding and re-injection into the Meet stream works correctly
4. The latency is within acceptable bounds for voice communication
5. The extension install/load/unload cycle works correctly

All of these could have subtle, difficult bugs. By validating the audio pipeline with a simple pitch shift that takes 10-50ms, you know that any latency problems in the full translation version are due to the AI APIs (which typically add 500-2000ms), not the infrastructure.

You also have a working latency dashboard that can measure exactly how much each AI service contributes to total latency, enabling optimization.

The `ffmpeg` pitch shift is temporary scaffolding. It lets you prove the whole pipeline works end-to-end before spending money on AI API calls.

---

## 14. The Isolated World Problem and How We Solved It

This section explains the bug that caused `realMicStream` to always be `null`, why it happened, and how the main-world injection pattern fixes it permanently.

---

### What Isolated Worlds Are

When Chrome injects a content script into a webpage, it does not let the content script run in the exact same JavaScript environment as the page. Instead, Chrome creates a **separate, parallel JavaScript execution environment** — called an **isolated world** — specifically for the extension's content scripts.

Think of it this way. JavaScript running on a webpage has access to a set of global objects:
- `window` — the global namespace
- `navigator` — browser/device info
- `document` — the page's HTML tree
- All the variables and functions the page's own JavaScript creates

In an isolated world, the content script gets its **own private copy** of `window` and `navigator`. These copies start out identical to the page's copies — same built-in functions, same initial values — but they are **independent objects living in memory-separate sandboxes**. A modification to one copy does not propagate to the other.

The DOM (`document`) is an exception — both the page and content scripts share the same DOM. But the JavaScript environments are completely separate.

To picture this concretely: imagine two people in separate rooms. Each room has an identical set of tools laid out on a table (the global objects). If person A (the content script) picks up the hammer and modifies it, person B's (the page's) hammer is completely unchanged. They have separate hammers even though the rooms look identical.

**Why does Chrome do this?**

Security. If content scripts ran in the same JavaScript context as the page, a malicious webpage could:
- Read the extension's private variables (API keys, auth tokens, user data)
- Call the extension's internal functions to manipulate its behaviour
- Overwrite the extension's functions with malicious versions

Isolated worlds prevent all of this. The page cannot see the extension's variables. The extension cannot accidentally pollute the page's global namespace. They are genuinely isolated.

---

### Why This Broke Our getUserMedia Override

Our original `content.js` had this code:

```javascript
// content.js — runs in ISOLATED WORLD
navigator.mediaDevices.getUserMedia = async function(constraints) {
    // Our override
};
```

This modifies `navigator.mediaDevices.getUserMedia` in the **isolated world's copy of navigator**. The page's copy is completely untouched.

Google Meet runs in the **main world** (the page's own JavaScript environment). When Meet runs:

```javascript
// Google Meet — runs in MAIN WORLD
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
```

It is reading from its own world's `navigator` — which still has the browser's original, unmodified `getUserMedia`. Our override in the isolated world is never called. Meet gets the real mic stream directly. Our `realMicStream` variable stays `null` forever.

Here is the failure flow visualised:

```
┌─────────────────────────────────────────────────────┐
│  ISOLATED WORLD (content.js)                        │
│                                                     │
│  navigator.mediaDevices.getUserMedia = ourOverride  │
│  ← override installed here, in the wrong universe   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  MAIN WORLD (Google Meet)                           │
│                                                     │
│  navigator.mediaDevices.getUserMedia({ audio:true })│
│  ← calls ORIGINAL here — never hits our override   │
│                                                     │
│  Result: Meet gets real mic, realMicStream = null   │
└─────────────────────────────────────────────────────┘
```

The console log `"getUserMedia override installed successfully"` was telling the truth — the override WAS installed, just in the wrong JavaScript universe.

---

### What Main World Injection Is

Chrome provides a specific escape hatch for exactly this problem. You can inject a JavaScript file directly into the **page's main world** by creating a `<script>` element and appending it to the document.

A script tag appended to the page runs in the same context as the page itself — same `window`, same `navigator`, same everything. Any override it makes to global objects is visible to all other scripts running in the main world, including Google Meet.

```javascript
// content.js — runs in ISOLATED WORLD
// Creates a script tag that loads in the MAIN WORLD
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove(); // clean up the DOM
```

`chrome.runtime.getURL('injected.js')` generates a Chrome extension URL like:
```
chrome-extension://abcdefghijklmnop/injected.js
```

The browser fetches the file from the extension's package and executes it in the main world context. The script tag is then removed from the DOM (the override remains in memory — removing the element does not undo the JavaScript that already ran).

### The web_accessible_resources Declaration

For `injected.js` to be loadable via a script tag, it must be declared as a **web accessible resource** in `manifest.json`:

```json
"web_accessible_resources": [
  {
    "resources": ["injected.js"],
    "matches": ["https://meet.google.com/*"]
  }
]
```

Without this declaration, Chrome's Content Security Policy (a security mechanism that restricts what scripts a page can load) would block the extension URL. The browser would see an unfamiliar `chrome-extension://` URL in a script tag on `meet.google.com` and refuse to load it.

By declaring it in `web_accessible_resources`, we explicitly grant permission for pages on `meet.google.com` to load this specific file from our extension. No other page on the internet can load it — the `matches` field enforces this.

---

### How Communication Works Between injected.js and content.js

Now that `injected.js` runs in the main world and `content.js` runs in the isolated world, they are back to being in separate JavaScript universes. They cannot share variables. They cannot call each other's functions. They need a communication channel.

The solution is `window.postMessage` — a built-in browser API designed for cross-context communication.

**How postMessage works:**

`window.postMessage(data, targetOrigin)` places a message in the browser's event queue. Every `window.addEventListener('message', handler)` listener on the same window receives it, regardless of which JavaScript world they are in. This is because `window` is the one object both worlds share a connection to (via the DOM).

Both the main world and isolated world can post and receive messages this way.

**The message protocol:**

To avoid processing messages from unrelated sources (other extensions, page scripts, analytics SDKs — all of which may postMessage), every message includes a `source` identifier:

- Messages from `injected.js` to `content.js`: `{ source: 'lt-injected', type: '...', ...payload }`
- Messages from `content.js` to `injected.js`: `{ source: 'lt-content', type: '...', ...payload }`

Each listener checks `event.data.source` and ignores anything that does not match.

**The full four-layer communication architecture:**

```
┌──────────────────────────────┐
│  injected.js  (main world)   │  ← owns getUserMedia, AudioContext,
│                              │     MediaRecorder, audio playback
└──────────┬───────────────────┘
           │  window.postMessage / window.addEventListener
┌──────────▼───────────────────┐
│  content.js  (isolated world)│  ← owns WebSocket, latency math,
│                              │     Chrome API calls
└──────────┬───────────────────┘
           │  chrome.runtime.sendMessage / onMessage
┌──────────▼───────────────────┐
│  background.js (service wkr) │  ← stores stats, routes messages
└──────────┬───────────────────┘
           │  chrome.tabs.sendMessage
┌──────────▼───────────────────┐
│  popup.js                    │  ← shows UI, polls stats
└──────────────────────────────┘
```

**Why content.js owns the WebSocket and not injected.js:**

WebSocket connections work in both worlds, but having `content.js` own the WebSocket is strategically cleaner:
- `content.js` can use `chrome.runtime.sendMessage` to forward latency stats to the background worker — `injected.js` cannot use Chrome APIs
- If the extension is reloaded or disabled, `content.js` is terminated cleanly by Chrome, taking the WebSocket with it
- Keeping the Chrome API calls in the isolated world maintains security isolation

---

### The Corrected Flow

With main world injection in place, the flow is:

```
┌─────────────────────────────────────────────────────────────┐
│  ISOLATED WORLD (content.js)                                │
│                                                             │
│  1. Appends <script src="injected.js"> to document          │
│  2. Listens for window.postMessage from injected.js         │
│  3. Owns WebSocket, relays audio chunks                     │
└─────────────────────────────────────────────────────────────┘
                          ↕ window.postMessage
┌─────────────────────────────────────────────────────────────┐
│  MAIN WORLD (injected.js, running alongside Google Meet)     │
│                                                             │
│  navigator.mediaDevices.getUserMedia = ourOverride          │
│  ← installed in the right universe this time               │
│                                                             │
│  When Meet calls getUserMedia:                              │
│  → Gets real stream, builds fake stream, returns fake       │
│  → Starts MediaRecorder on real stream                      │
│  → Sends audio chunks to content.js via postMessage         │
│  → Receives processed chunks from content.js, plays them    │
└─────────────────────────────────────────────────────────────┘
```

---

### Why This Pattern Is Used in Production Extensions

This is not a hack. It is a documented, Chrome-approved extension pattern used by major commercial extensions:

- **Voicemod** — injects a script to intercept audio APIs (same as us)
- **Grammarly** — injects into the main world to access text inputs across different framework contexts
- **LastPass / 1Password** — inject to detect and fill password fields before framework event handlers claim them
- **MetaMask** — injects `window.ethereum` into the main world so any webpage can access the wallet API

Chrome explicitly created `web_accessible_resources` to enable this pattern. The Chrome Web Store review team reviews and approves extensions using this technique.

---

### Security Considerations

`injected.js` runs in the main world, which means it theoretically has access to everything the page can access — DOM, cookies (non-HttpOnly), JavaScript variables.

**Why this is acceptable for Live Translation:**

1. **Narrow scope**: `injected.js` overrides exactly one thing (`getUserMedia`) and nothing else. It does not read form inputs, inspect cookies, access local storage, or modify page content. The code is reviewable and short.

2. **User consent**: The extension is installed explicitly by the user. Installing a Chrome extension is an informed action — Chrome warns you about the permissions requested.

3. **No data persistence**: We do not store audio on disk, send it to any remote logging service, or transmit it anywhere except the local WebSocket server on the same machine.

4. **Restricted to Meet**: `web_accessible_resources` restricts injection to `https://meet.google.com/*` only. The injected script cannot run on any other site.

5. **Precedent**: Every noise cancellation, voice changer, and virtual microphone tool works the same way — Krisp, NVIDIA RTX Voice, Voicemod. Intercepting getUserMedia is the standard technique.

### Legal and Ethical Note

The extension is installed by the user who uses it. They consent to having their audio processed locally. Other participants on the Meet call hear whatever audio comes from your microphone — which has always been the case with any audio device, headset, or microphone adapter. Using a voice modifier is equivalent to using a USB audio interface with built-in DSP processing. The Chrome Web Store review process approves extensions using this architecture when they comply with its developer policies.

---

## 15. The processAudioChunk Function — Placeholder and Future Replacement

This section explains what a placeholder function is, why this one exists, and every concept involved in the current implementation: what PCM audio is, what WAV format is, how the pitch shift works, why there is no disk I/O, and what comes next.

---

### What a Placeholder Function Is

A placeholder function is a function that does a simple temporary job, in exactly the same place and with exactly the same inputs and outputs as the real function will have when it is ready.

Think of it like a stunt double in a movie. In an action scene, the stunt double stands in for the lead actor. They are in the exact same position, on the exact same set, wearing the exact same costume. They perform the dangerous parts that would be too risky or expensive for the real actor to do at that stage of filming. When the real actor is ready for their close-up, the crew simply swaps them in. Nothing else about the scene changes.

`processAudioChunk` is the stunt double. It does something simple (shift the pitch of audio by resampling it) in exactly the position where the real thing will eventually go (inside the WebSocket message handler, between receiving audio and sending it back). It takes audio bytes in and returns audio bytes out — the same contract the real function will have. When the real implementation (Deepgram + Gemini + TTS) is ready, we swap it in. The WebSocket handler, the extension, the dashboard — none of them change.

The function signature is:

```javascript
async function processAudioChunk(inputBuffer, mimeType, pitchSemitones)
  // inputBuffer   — a Node.js Buffer of raw audio bytes
  // mimeType      — the format string (e.g. 'audio/wav')
  // pitchSemitones — how many semitones to shift by (-12 to +12)
  // returns: Promise<Buffer> — processed audio bytes
```

This signature will stay identical in the production version. Only the body of the function changes.

---

### What PCM Audio Is

PCM stands for **Pulse Code Modulation**. It is the simplest possible representation of audio — just a list of numbers.

Here is what audio actually is at a physical level: a microphone converts pressure waves in the air (sound) into an electrical signal. The voltage of this signal varies over time, tracing the shape of the sound wave. To store or transmit this on a computer, we need to convert the continuous electrical signal into discrete numbers.

PCM does this by **sampling** the signal thousands of times per second. At each sample point, we measure the amplitude (strength) of the electrical signal and record it as a number. A **sample rate** of 48,000Hz means we take 48,000 measurements per second. Each measurement is stored as a number.

**The number range:** In the format we use (32-bit floating point PCM), each sample is a number between -1.0 and +1.0:
- `0.0` means silence (the speaker cone is at rest)
- `1.0` means maximum positive pressure (cone pushed fully forward)
- `-1.0` means maximum negative pressure (cone pulled fully backward)
- Values between these extremes represent the proportional displacement of the cone

When you want to play the audio back, you push these numbers one at a time into a **DAC** (Digital to Analogue Converter). The DAC converts each number into a proportional electrical voltage. That voltage drives an amplifier, which drives a speaker. The speaker cone moves according to the voltage, creating pressure waves in the air that your ears perceive as sound.

PCM is what speakers actually receive. Every other audio format (MP3, AAC, Opus, WebM, FLAC) is just PCM that has been compressed in various ways. When you play a Spotify track, your computer decodes the compressed audio back into PCM before sending it to your speakers.

For audio processing — manipulating individual samples to change the pitch, add effects, or run through a speech model — you always need to work with PCM. Compressed formats need to be decoded to PCM first.

---

### What WAV Format Is

WAV (Waveform Audio File Format) is a **container format** for audio. Think of a container format like a cardboard box — it wraps the actual content (the audio) along with a label on the outside (the header) that describes what is inside.

A WAV file has two parts:

**1. The header** (44 bytes at the start of the file):

The header contains metadata that tells any program reading the file exactly how to interpret the bytes that follow:
- Sample rate (e.g., 48000Hz — how many samples per second)
- Number of channels (1 = mono, 2 = stereo)
- Bit depth (how many bits represent each sample — we use 32)
- Number of bytes of audio data that follow

**2. The audio data** (everything after the header):

Just raw PCM samples, written one after another as bytes. For 32-bit float PCM, each sample is 4 bytes. For 48kHz mono audio, one second of audio is `48,000 samples × 4 bytes = 192,000 bytes = 187.5 KB`.

WAV is large (no compression) but trivially simple to decode. A program reading a WAV file just:
1. Reads the 44-byte header to find out the sample rate, channels, and bit depth
2. Reads the remaining bytes as raw PCM numbers

This is exactly what `node-wav.decode()` does. It returns:
```javascript
{
  sampleRate: 48000,
  channelData: [
    Float32Array([0.0, 0.001, 0.003, ...]),  // channel 0 (left)
    Float32Array([0.0, 0.001, 0.002, ...]),  // channel 1 (right) if stereo
  ]
}
```

Each `Float32Array` is a typed array containing 32-bit floating point numbers — the raw PCM samples. We manipulate these directly to perform the pitch shift.

For our 250ms chunks at 48kHz: each channel has `48,000 × 0.25 = 12,000 samples`. That is 12,000 floating point numbers to process per channel per chunk.

---

### What Linear Interpolation Is and Why We Use It

The pitch shift works by **resampling** — reading the source audio at a different rate than it was recorded.

Imagine the source audio as a list of samples: `[s0, s1, s2, s3, s4, ...]`. Normally you read them at positions 0, 1, 2, 3, 4 — one by one, in order. But to pitch up by a factor of 1.06, you instead step through the source at intervals of 1.06: reading at positions 0, 1.06, 2.12, 3.18, 4.24...

The problem: position 1.06 does not exist. There are only integer positions. You have `s1` (at position 1) and `s2` (at position 2), but nothing at 1.06.

**Nearest-neighbour interpolation** would just round 1.06 down to 1 and use `s1`. This is the digital equivalent of pixelating an image when you zoom in — you get a harsh, jagged result that sounds distorted.

**Linear interpolation** does something smarter. It estimates the value at position 1.06 by assuming the signal changes smoothly between `s1` and `s2`. If the fractional part is 0.06 (6% of the way between s1 and s2), we take 94% of `s1` and 6% of `s2`:

```
value_at_1.06 = s1 × (1 - 0.06) + s2 × 0.06
              = s1 × 0.94       + s2 × 0.06
```

The general formula:
```
pos  = i × pitchRatio         // where to read in the source
lo   = Math.floor(pos)         // the sample just before
hi   = lo + 1                  // the sample just after
frac = pos - lo                // fractional distance between them (0.0 to 1.0)

output[i] = source[lo] × (1 - frac) + source[hi] × frac
```

Linear interpolation is smooth, fast (just a few math operations per sample), and gives good enough quality for voice audio that will be played in 250ms chunks. Production-quality pitch shifting uses more sophisticated algorithms (cubic interpolation, sinc interpolation, or a full phase vocoder) but linear is completely adequate for proving the pipeline works.

**Why the output has the same length as the input:**

We step through the input faster (to pitch up) but we still produce the same number of output samples. This means we do not use all of the input — we run off the end of the source array early. The remaining output positions are filled with silence. The duration of the audio chunk is preserved even though the pitch changes. This is different from simply playing the audio back faster (which would both speed it up and pitch it up).

Note: this is a simplified approximation. A perfect algorithm would preserve duration exactly without the silence artifact. But for 250ms chunks at 0-6 semitone shifts, the silence at the end is negligible (less than 10% of the chunk at +2 semitones).

---

### Why No Disk I/O

Disk I/O stands for **Input/Output** to a storage device (hard disk or SSD). It means reading or writing data to the physical storage medium of the computer.

The previous implementation wrote each audio chunk to a temp file on disk before processing:
```javascript
// OLD approach (removed):
fs.writeFileSync('/tmp/lt_input_42.webm', audioBuffer);  // DISK WRITE
await runFfmpeg('/tmp/lt_input_42.webm', '/tmp/lt_output_42.webm');  // ffmpeg reads and writes disk
const output = fs.readFileSync('/tmp/lt_output_42.webm');  // DISK READ
```

This was causing problems on Windows specifically because:
1. Windows uses locked file handles differently from Linux/Mac, so temp files sometimes could not be written or deleted
2. Windows Defender antivirus scans new files as they are created, adding 50-200ms of latency per chunk
3. Even on SSDs, small random file writes are 100-1000x slower than RAM operations
4. With 4 chunks per second, you are creating and deleting 8 files per second — significant filesystem churn

**The new approach keeps everything in memory:**
```javascript
// NEW approach:
const inputBuffer  = Buffer.from(data, 'base64');          // RAM only
const outputBuffer = await processAudioChunk(inputBuffer); // RAM only
const outputBase64 = outputBuffer.toString('base64');      // RAM only
```

A `Buffer` in Node.js is a region of memory (RAM) holding raw bytes. Operations on Buffers happen at RAM speed — nanoseconds instead of microseconds. There is no filesystem involvement, no antivirus scanning, no file locking issues.

For real-time audio processing at 250ms chunk intervals, disk I/O latency is unacceptable. Everything must happen in memory.

---

### The ENABLE_PROCESSING Flag

```javascript
const ENABLE_PROCESSING = process.env.ENABLE_PROCESSING !== 'false';
```

This is a **feature flag** — a variable that turns a feature on or off without changing the code. Feature flags are used constantly in production software to:
- Enable or disable features for testing
- Gradually roll out new features to users
- Quickly turn off a broken feature without redeploying

When `ENABLE_PROCESSING` is `false`, `processAudioChunk` immediately returns the original audio unchanged:

```javascript
if (!ENABLE_PROCESSING) {
  return inputBuffer;  // no processing at all
}
```

This is useful for **isolating problems**. If you suspect the audio sounds wrong, set `ENABLE_PROCESSING=false` and restart the server:

```bash
ENABLE_PROCESSING=false node index.js
```

Now the server echoes audio back instantly. If the audio sounds correct in this mode, the processing code is causing the problem. If it still sounds wrong, the problem is in the pipeline (encoding, WebSocket, or playback). You have just narrowed the search space in half.

The flag can also be used to benchmark the bare pipeline latency. With processing disabled, the server reflects each chunk back with essentially zero processing time. The latency numbers you see in the dashboard represent pure network round-trip time. This is your baseline. Any latency above this baseline is caused by the processing code.

---

### What Comes After the Placeholder

In the final product, `processAudioChunk` will be replaced with three sequential API calls. The function signature stays identical. The WebSocket handler does not change. Only the body of the function changes:

```javascript
async function processAudioChunk(inputBuffer, mimeType, pitchSemitones) {
  // THIS WILL REPLACE THE PITCH SHIFT:

  // 1. Deepgram STT — speech to text
  //    Send the audio buffer to Deepgram's streaming transcription API.
  //    Deepgram returns a text transcript: "Hello, how are you today?"
  const transcript = await deepgramSTT(inputBuffer);

  // 2. Gemini Flash — translate the text
  //    Send the transcript to Gemini with a translation prompt.
  //    Gemini returns translated text: "Hola, ¿cómo estás hoy?"
  const translatedText = await geminiTranslate(transcript, targetLanguage);

  // 3. Deepgram Aura TTS — text to speech
  //    Send the translated text to Deepgram's Aura text-to-speech API.
  //    Deepgram returns an audio buffer of a synthesized voice speaking
  //    the translated text.
  const audioBuffer = await deepgramTTS(translatedText);

  return audioBuffer;
  // ↑ Same return type as before. The caller never knows what happened inside.
}
```

**Why three separate steps instead of one end-to-end translation API?**

1. **Control**: We can swap each component independently. If a better TTS voice comes out next month, we swap step 3. If we need to add a custom pronunciation correction layer, we insert it between steps 2 and 3.

2. **Latency measurement**: The `processAudioChunk` call is surrounded by timestamps. We can measure exactly how long the three API calls take, which is essential for understanding why latency is high and where to optimise.

3. **Error handling**: Each step can fail independently. If the TTS API is slow, we can fall back to a cached voice or skip processing for that chunk without crashing the whole pipeline.

4. **Cost optimisation**: If the transcript is empty (silence detected by STT), we can return silence directly without calling Gemini or TTS at all, saving API credit.

The placeholder pitch shift you see today is exactly this function, just with simpler internals. When you look at the code and see `processAudioChunk`, you are looking at the future home of the translation pipeline. The function is already wired up and working. We just need to swap the guts.

---

## 16. Audio Format — Why We Use webm/opus and How It Flows Through the Pipeline

Every engineering decision about audio format has direct consequences for latency, server complexity, and how much work we have to do when we integrate Deepgram. This section explains what audio codecs are, why we chose webm/opus specifically, and exactly how the format flows through every stage of the pipeline.

---

### What an Audio Codec Is

When a microphone records your voice, it produces an endless stream of numbers — one number per sample, 48,000 samples per second (at 48kHz). Each number is typically 16 bits (2 bytes). That makes raw, uncompressed mono audio:

```
48,000 samples/sec × 2 bytes/sample = 96,000 bytes/sec = ~96 KB/sec
```

For a 250ms chunk that is `96,000 × 0.25 = 24,000 bytes = ~24KB` every quarter second. Over four seconds that is nearly 400KB of data just from your microphone. Over a local network this is fine, but:

- **On a real internet connection to a cloud server**, you pay for data transfer. 400KB every 4 seconds = 100KB/sec = ~750Kbps just for the audio *upload*. Many mobile connections and corporate WiFi networks throttle or struggle at this rate.
- **Deepgram charges per audio-minute** of transcription. Sending uncompressed audio wastes money on bandwidth before Deepgram even sees it.
- **Latency accumulates**: waiting for a 24KB chunk to fully arrive over a slow connection adds delay before the server can even start processing.

**A codec** (short for coder-decoder) is a compression algorithm that makes audio much smaller while sounding almost identical to the original. It does this by exploiting perceptual properties of human hearing — for example, removing frequencies the ear cannot distinguish, or discarding audio information that is masked by louder sounds at the same moment.

Different codecs exist for different use cases:
- **MP3**: old, designed for music storage, not real-time
- **AAC**: used by Apple, good quality, moderate compression
- **Opus**: modern, designed specifically for real-time internet voice

---

### What Opus Specifically Is

Opus is an open-source audio codec developed by the Xiph.Org Foundation and standardised by the Internet Engineering Task Force (IETF) in 2012 (RFC 6716). It was designed from the ground up for one purpose: **real-time audio transmission over the internet**.

Key properties:

**Extremely low encoding latency.** Opus can operate at frame sizes as small as 2.5ms. This means the encoder does not need to buffer more than a few milliseconds of audio before it can start compressing and sending. Other codecs require much larger buffers (MP3 requires at least 100ms). For live voice, every millisecond of encoding latency adds directly to the end-to-end delay.

**Excellent voice quality at very low bitrates.** Opus at 16Kbps sounds better than the MP3 codec at 128Kbps for speech. For our use case, Chrome’s MediaRecorder uses approximately 32–64Kbps for voice audio, giving:

```
64,000 bits/sec ÷ 8 bits/byte = 8,000 bytes/sec
8,000 bytes/sec × 0.25 sec/chunk = 2,000 bytes per chunk
```

Compare to uncompressed PCM at ~24,000 bytes per chunk. **Opus is 12x smaller.** In practice we see chunks of 3– 6KB with Opus vs 30–60KB with uncompressed PCM.

**It is the codec used by every major real-time communication platform.** WebRTC — the underlying technology in Google Meet, Zoom, Discord, Microsoft Teams, and every video calling platform — mandates Opus support. Chrome produces Opus natively. The browser’s media stack is already optimised for it.

**Chrome’s `MediaRecorder` produces Opus by default.** When you create a `MediaRecorder` and request `audio/webm` or `audio/webm;codecs=opus`, Chrome uses its built-in Opus encoder. The CPU cost is negligible — typically less than 0.5% of a modern CPU. Zero cost from our code.

---

### What webm Is in This Context

**webm** is a **container format** — a wrapper that holds compressed audio (or video) data along with metadata that describes it.

Think of it like a shipping box. The box itself is the container. Inside the box is the product (the Opus-compressed audio). On the outside of the box is a label (the metadata) that tells the recipient:
- What codec was used (Opus)
- The sample rate (48000Hz)
- The number of channels (1 = mono, 2 = stereo)
- Timestamps for each audio frame (so decoders know when to play each piece)
- The duration of the audio

The webm format is based on the Matroska container format, which uses a binary encoding scheme called EBML (Extensible Binary Meta Language). This sounds complicated but the important thing is that webm is **extremely lightweight for streaming** — it was designed by Google specifically for internet streaming of video and audio, with minimal header overhead.

When `MediaRecorder` records in `audio/webm;codecs=opus`, the data you get looks like:

```
[webm header: 40-100 bytes]  ← only in the very first chunk
[webm cluster: timestamp + Opus frame block]
[webm cluster: timestamp + Opus frame block]
...
```

This is important: **the webm header only appears in the first chunk MediaRecorder produces.** Subsequent chunks are streaming continuations. If you need to decode a non-first chunk independently, you must prepend the first chunk (the header) to it first. This is why the server receives the first chunk and must handle it specially when integrating with Deepgram — Deepgram needs the header to know what format is coming.

---

### Why We Chose webm/opus Over Other Formats

We evaluated every format available from `MediaRecorder` in Chrome:

#### `audio/webm;codecs=pcm` (what we were using before)

- **What it is**: PCM (raw, uncompressed samples) wrapped in a webm container
- **Size**: ~24–50 KB per 250ms chunk — same as uncompressed WAV
- **Problem 1**: No compression. Sends 10x more data over the network than necessary.
- **Problem 2**: `node-wav` cannot parse it because it expects a WAV header, not a webm container. So our server was receiving ~50KB of data and had no usable way to process it — it just echoed it back.
- **Problem 3**: Deepgram does not list `webm;codecs=pcm` as a supported input format. Using it would require server-side conversion before calling Deepgram, adding latency.
- **Verdict**: Wrong format. Abandoned.

#### `audio/wav`

- **What it is**: Raw PCM samples with a 44-byte WAV header
- **Size**: ~24 KB per 250ms chunk (uncompressed)
- **Problem 1**: Still too large. 10x more data than Opus.
- **Problem 2**: Chrome’s `MediaRecorder` does not reliably support `audio/wav` on all platforms. `MediaRecorder.isTypeSupported('audio/wav')` returns false in most Chrome versions.
- **Upside**: Deepgram does accept WAV. And `node-wav` can decode it in pure JavaScript.
- **Verdict**: A reasonable approach for a pure-JavaScript server with no external tools, but not the right format for the real pipeline.

#### `audio/webm;codecs=opus` ✔ CHOSEN

- **What it is**: Opus-compressed audio in a webm container
- **Size**: ~3–5 KB per 250ms chunk (compressed)
- **Deepgram**: Accepts it directly with no conversion
- **Chrome**: Produces it natively via `MediaRecorder`
- **Processing**: our `processAudioChunk` placeholder passes it through `ffmpeg` stdin→stdout for pitch shifting and returns the same format
- **Future pipeline**: `inputBuffer` goes directly to Deepgram’s streaming STT API. No format conversion anywhere.
- **Verdict**: Correct format. 10× smaller than PCM, zero conversion cost, Deepgram-ready.

---

### What “Natively Supported” Means

When we say Chrome produces `webm/opus` natively, it means the browser’s built-in code already implements the Opus encoder. We do not install a library. We do not call an external program. We simply tell `MediaRecorder`:

```javascript
new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
```

And Chrome’s internal media stack handles everything: capturing the raw PCM from the microphone hardware, running it through the Opus encoder, wrapping the result in a webm container, and handing us the resulting bytes through the `ondataavailable` event.

From our code’s perspective, the compressed audio just appears. We do not see the raw PCM at all. This is fundamentally different from how we used to approach it (trying to capture raw PCM in `audio/wav` to do our own processing).

**Why this is the right model:** In the final translation pipeline, we do not want to do any audio processing in the browser at all. We want the smallest possible chunks delivered as fast as possible to the server, where the actual AI processing happens. A compressed 5KB chunk gets to the server faster than an uncompressed 50KB chunk, even on localhost.

---

### How This Format Flows Into the Real Translation Pipeline

Here is the complete data flow, step by step, from the moment you speak to the moment the translated voice plays in Meet:

```
1. You speak
   ↓
2. Real microphone hardware captures sound waves as electrical signal
   ↓
3. [Browser] Chrome’s audio subsystem samples the signal at 48,000 times/sec
   ↓
4. [injected.js] MediaRecorder compresses samples using Opus encoder
   ↔ produces a ~5KB webm/opus chunk every 250ms
   ↓
5. [injected.js] Chunk encoded to base64, sent via window.postMessage to content.js
   ↓
6. [content.js] Wraps in JSON { chunkId, t1, pitch, mimeType, data } and sends over WebSocket
   ↓
7. [Network] WebSocket frame travels from browser tab to server (~0.5ms on localhost)
   ↓
8. [server/index.js] Receives message, decodes base64 → Buffer
   ↓
9. [CURRENT] processAudioChunk: pipes Buffer through ffmpeg stdin→stdout (pitch shift)
   [FUTURE]  processAudioChunk:
     a. Deepgram Streaming STT — send Buffer directly (no conversion)
        → returns: "Hello, how are you today?"
     b. Gemini Flash — send transcript text
        → returns: "नमस्ते, आप कैसे हैं?"
     c. Deepgram Aura TTS — send translated text
        → returns: audio Buffer (webm/opus format)
   ↓
10. [server/index.js] Encodes output Buffer to base64, sends back over WebSocket
    ↓
11. [content.js] Receives response, passes to injected.js via window.postMessage
    ↓
12. [injected.js] Decodes base64 → ArrayBuffer
    ↓
13. [injected.js] AudioContext.decodeAudioData() decodes webm/opus → AudioBuffer
    ↓
14. [injected.js] AudioBufferSourceNode plays AudioBuffer → MediaStreamDestinationNode
    ↓
15. Meet receives audio from fake mic → transmits to other participants
    ↓
16. Other participants hear translated voice
```

The key insight: **steps 8 and 10 do not know or care what format the audio is**. They decode base64 to bytes and encode bytes to base64. The `processAudioChunk` function is the only place that “understands” the audio format. And in the future, Deepgram handles the format — it accepts webm/opus directly at step 9a.

---

### What stdin/stdout Piping Is and Why It Eliminates Disk Latency

Our placeholder pitch shifter uses `ffmpeg` with a technique called **stdin/stdout piping**.

**What a pipe is:**

In computing, a **pipe** is a one-directional data channel between two processes. Data written to one end immediately becomes available to read from the other end. The data flows entirely through memory (kernel buffers) without ever touching the disk.

Think of it like a hose. When you turn on the tap (write data to the pipe), water (data) immediately comes out the other end. There is no storage step in between.

In Node.js, when you `spawn` a child process, it has three standard streams:
- **stdin (standard input, pipe:0)**: data flows INTO the process
- **stdout (standard output, pipe:1)**: data flows OUT of the process
- **stderr (standard error, pipe:2)**: diagnostic messages from the process

**How we use it:**

```javascript
const ffmpegProcess = spawn('ffmpeg', [
  '-i', 'pipe:0',   // read input from stdin (not a file)
  // ... audio filters ...
  'pipe:1',         // write output to stdout (not a file)
]);

// Write our audio data into ffmpeg's stdin
ffmpegProcess.stdin.write(inputBuffer);
ffmpegProcess.stdin.end();  // signal EOF — ffmpeg processes and exits

// Collect ffmpeg's output from stdout
ffmpegProcess.stdout.on('data', chunk => outputChunks.push(chunk));
```

`pipe:0` is ffmpeg’s special notation for “read from stdin”. `pipe:1` means “write to stdout”. ffmpeg is perfectly happy reading from a pipe instead of a file — it just processes whatever bytes arrive on stdin and writes the result to stdout.

**Why this matters:**

The previous implementation wrote temp files:
```javascript
fs.writeFileSync('/tmp/input.webm', buffer);   // disk write: ~5ms
await runFfmpeg('/tmp/input.webm', '/tmp/output.webm');  // ffmpeg opens files: ~5ms overhead
const output = fs.readFileSync('/tmp/output.webm');  // disk read: ~5ms
```

Three disk operations per chunk, each costing 1–10ms on a typical SSD. Not counting ffmpeg’s own processing time, you have 3–30ms of pure filesystem overhead added to every chunk.

With stdin/stdout:
```javascript
ffmpegProcess.stdin.write(buffer);  // RAM transfer: <0.1ms
// ffmpeg processes in its own memory space
// output arrives in RAM via stdout: <0.1ms
```

The data transfer overhead is reduced from milliseconds to microseconds. On Windows, there is an additional benefit: Windows Defender antivirus scans newly created files. Every temp file write triggers a scan. With pipe-based processing, there are no new files — no antivirus scanning, no file handle locking issues.

---

### The ENABLE_PROCESSING Flag

At the top of `server/index.js`:

```javascript
const ENABLE_PROCESSING = process.env.ENABLE_PROCESSING !== 'false';
```

When set to `false`, `processAudioChunk` returns the original audio immediately:

```javascript
if (!ENABLE_PROCESSING) {
  return inputBuffer; // instant echo
}
```

**How to use it:**

```powershell
# PowerShell (Windows)
$env:ENABLE_PROCESSING="false"; node index.js
```

```bash
# bash (Mac/Linux)
ENABLE_PROCESSING=false node index.js
```

**What it tells you:**

With processing disabled, the server’s latency numbers represent the raw WebSocket round-trip time. This is your **baseline** — the minimum latency possible with this architecture. Any numbers above this baseline are caused by `processAudioChunk`. Currently the baseline is 1–3ms on localhost.

When you see 40ms in the processing column, you know ffmpeg is taking 40ms to pitch-shift that chunk. When you replace ffmpeg with Deepgram + Gemini + TTS, you will see that number jump to 300–1500ms. That delta is the cost of the AI pipeline, visualised in real time.

---

### What the Latency Numbers Mean

Every chunk going through the pipeline generates four timestamps:

| Timestamp | Where set | Meaning |
|-----------|-----------|----------|
| `t1` | `content.js` | Moment the extension sends the chunk over WebSocket |
| `t2` | `server/index.js` | Moment the server receives and parses the message |
| `t3` | `server/index.js` | Moment `processAudioChunk` returns |
| `t4` | `content.js` | Moment the extension receives the processed chunk |

The dashboard shows these derived values:

| Label | Formula | What it measures |
|-------|---------|------------------|
| `net-in` | `t2 - t1` | WebSocket transit time: extension → server |
| `process` | `t3 - t2` | Time spent inside `processAudioChunk` (ffmpeg or future AI calls) |
| `net-out` | `t4 - t3` | WebSocket transit time: server → extension |
| `total` | `t4 - t1` | Full round-trip: from sending to receiving processed audio |

**On localhost (development):** All network times will be ~0–2ms because both client and server are on the same machine. The only meaningful number is `process`.

**On a real deployed server in Mumbai (~20ms from Bengaluru):**
- `net-in` ≈ 20ms
- `process` ≈ depends on AI pipeline (300–1500ms for Deepgram + Gemini + TTS)
- `net-out` ≈ 20ms
- `total` ≈ 340–1540ms

That total latency is what the listener in a Meet call will experience between when you say a word and when they hear the translated version of it. The 250ms recording window is not included in this figure — there is also an inherent 250ms capture delay because we record in 250ms chunks. So the total perceptible delay is roughly `250ms + total`. At best that is about 600ms (0.6 seconds). This is acceptable for voice translation — professional human interpreters typically have 1–2 second lag.

---

## 17. Why We Removed the Pitch Shift Placeholder and What We Learned

During development we attempted to use pitch shifting as a placeholder to prove the audio pipeline worked while also doing something interesting with the audio. This failed in several ways that taught us important lessons about real-time audio systems. This section documents what went wrong and why the current approach (a simple echo) is correct.

---

### What Backpressure Is

**Backpressure** is the problem that occurs when a producer (the thing sending data) sends data faster than a consumer (the thing processing data) can handle it.

Imagine a restaurant. The front of house seats customers every five minutes. The kitchen takes twenty minutes to cook each table's food. After an hour, twelve tables are seated but the kitchen has only served three of them. Nine tables are waiting. After two hours, twenty-four tables have been seated but only six have eaten. The queue grows indefinitely. Customers who sat down two hours ago are still waiting.

This is exactly what happened with our audio pipeline when using ffmpeg for pitch shifting.

**The numbers:**
- The extension sends a new audio chunk every **250ms** (4 chunks per second)
- ffmpeg took **300–800ms** to pitch-shift each chunk (depending on Windows system load)
- The server could process at most **1.25–3.3 chunks per second**
- But it was receiving **4 chunks per second**
- The queue grew by **0.7–2.75 chunks every second**

After one minute: the queue was ~120 chunks deep. After two minutes: ~240 chunks. The net-in latency values we observed (70,000ms = 70 seconds) represent exactly this: the oldest chunk in the queue had been waiting **70 seconds** to be processed.

In a real-time audio pipeline, this is catastrophic. A user speaks a word. Their voice arrives in Meet 70 seconds later. The conversation is completely unintelligible.

---

### What Dropping Stale Chunks Means and Why It Is Correct

The fix is to **drop old chunks** when the queue is too deep.

The server now maintains a `MAX_QUEUE_DEPTH = 3` limit per client. When a new chunk arrives:
1. If the queue has fewer than 3 chunks — add the new chunk, start processing
2. If the queue already has 3 chunks — **remove the oldest chunks** to make room for the newest one

This ensures the system always has at most 750ms (3 × 250ms) of buffered audio awaiting processing. If processing can't keep up, old audio is discarded rather than accumulated.

**Why this is the correct approach for real-time audio:**

In a recording session, old audio matters. If you are editing a podcast, you want every word preserved.

In a real-time translation pipeline, old audio is worthless. If someone said "Hello, how are you?" three seconds ago, playing the translation of that phrase *now* while the conversation has moved on is not helpful — it is disorienting.

The rule is: **always process the most recent audio**. If you cannot process everything, discard the old. This is the same approach used by WebRTC (the protocol behind Google Meet) — it uses RTP (Real-time Transport Protocol) with sequence numbers, and if packets arrive out of order or the buffer grows too large, old packets are discarded. Real-time communication systems are designed to lose data rather than be delayed by it.

The log line `[Server] Dropping N stale chunks for client` tells you that the processing pipeline is too slow for the incoming rate. When we add Deepgram + Gemini + TTS (300–1500ms per processing cycle), the `MAX_QUEUE_DEPTH` may need to be set to 1 — process only the most recent chunk, discard everything else, maintain real-time continuity at the cost of missing some words.

---

### Why ffmpeg Failed with Piped webm/opus on Windows

We attempted to use ffmpeg with stdin/stdout piping for pitch shifting:

```bash
ffmpeg -i pipe:0 -af asetrate=50849,aresample=48000 -c:a libopus -f webm pipe:1
```

The error we observed:
```
[vist#0:0/h263 @ ...] Decode error rate 1 exceeds maximum
```

**What this means:** When ffmpeg reads audio from a pipe (rather than a file), it cannot seek backwards to re-read the file header for format detection. It uses the first few bytes to guess the format. With `audio/webm;codecs=opus` data, ffmpeg 8.0 on Windows misidentified the format as **H.263 video** — a completely wrong guess. H.263 is a video codec from 1995 used in old 3GP video files. The webm container header shares some byte patterns with very old formats and ffmpeg's heuristic got it wrong.

The fix would have been to add `-f webm` before `-i pipe:0` to explicitly tell ffmpeg the input format:
```bash
ffmpeg -f webm -i pipe:0 ...
```

However, we decided not to pursue this fix for a more fundamental reason:

**ffmpeg is not part of the real translation pipeline.** In production, `processAudioChunk` will call Deepgram STT, then Gemini, then Deepgram TTS. None of these use ffmpeg. Debugging ffmpeg piping issues on Windows was complexity with zero payoff for the real system. The right decision was to remove ffmpeg entirely and use the simplest possible placeholder.

---

### What the Echo Placeholder Proves

The current `processAudioChunk` function simply returns its input unchanged:

```javascript
async function processAudioChunk(inputBuffer, mimeType, pitchSemitones) {
  return inputBuffer; // echo — return audio unchanged
}
```

This looks trivial. It is not. The echo proves every component of the pipeline is working correctly:

| Component | What the echo proves |
|-----------|---------------------|
| **Chrome extension** | `injected.js` captures real mic audio in webm/opus format |
| **MediaRecorder** | Produces valid audio chunks every 250ms |
| **main-world injection** | `getUserMedia` override works — Meet sees the fake mic |
| **postMessage bridge** | `injected.js` → `content.js` communication works |
| **WebSocket (outbound)** | `content.js` sends chunks to server without corruption |
| **Server receives** | `server/index.js` parses the JSON message correctly |
| **Buffer handling** | base64 decode → Buffer → base64 encode works without corruption |
| **WebSocket (inbound)** | Server sends audio back to extension without corruption |
| **Playback** | `injected.js` decodes base64 → ArrayBuffer → `decodeAudioData` → `AudioBufferSourceNode` → fake mic stream |
| **Meet integration** | Meet picks up audio from the fake `MediaStreamDestinationNode` and transmits it to other participants |

If the extension user speaks and a participant in the Meet call hears their voice (even though it is unmodified), **every single component of the future translation pipeline is working**. The only thing left to build is the body of `processAudioChunk` — replace the one-line echo with three API calls.

This is the value of a good placeholder: it proves the container before filling it.

---

### Why Pitch Shifting Was Never the Right Placeholder

Looking back, using pitch shifting as a placeholder was a mistake for several reasons:

**1. It added failure modes unrelated to the pipeline.**
The pipeline could fail because of ffmpeg format detection, ffmpeg not being in PATH, Windows file handle issues, libopus not being available in the ffmpeg build, or pipe buffer overflow. None of these failure modes would exist in the real Deepgram-based pipeline. Debugging them was debugging the wrong thing.

**2. It masked whether the pipeline worked.**
If pitch-shifted audio never arrived or sounded garbled, was it a pipeline problem or an ffmpeg problem? With echo, there is no ambiguity. If you hear your own voice, the pipeline works. If you do not, it does not.

**3. It caused the backpressure problem.**
ffmpeg took 300–800ms per chunk. The echo takes 0ms. The backpressure problem never existed with echo. We spent debugging time on a problem that was entirely caused by the placeholder itself.

**4. It was not closer to production than echo.**
The key property of a good placeholder is that it has the same inputs and outputs as the real function. Both echo and pitch-shift have the same signature: `Buffer in → Buffer out`. But echo introduces zero new dependencies and zero new failure modes. Pitch shift introduced ffmpeg, format detection, piping, and latency. Echo is the better placeholder.

**The lesson:** When proving a pipeline, use the simplest possible function that can still confirm the pipeline works. An echo function is enough. Save the complexity for the real implementation.

---

### Current State and What Comes Next

**Current state:**
- Extension captures mic audio as `audio/webm;codecs=opus` (~5KB per 250ms chunk)
- Server receives chunks, echoes them back at 0ms processing time
- Extension plays echoed audio through the fake mic into Meet
- Other participants hear your voice (unmodified) through the pipeline
- Backpressure queue ensures max 750ms of buffering — no more 70-second lag
- Dashboard shows consistent `net-in=1ms | process=0ms` latency

**What comes next (replacing the echo body with the real pipeline):**

```javascript
async function processAudioChunk(inputBuffer, mimeType, pitchSemitones) {
  // Step 1: Send webm/opus audio to Deepgram Streaming STT
  const transcript = await deepgramSTT(inputBuffer);
  if (!transcript || transcript.trim() === '') {
    return inputBuffer; // silence detected — return original audio
  }

  // Step 2: Translate transcript with Gemini Flash
  const translated = await geminiFlash(transcript, targetLanguage);

  // Step 3: Synthesise translated text with Deepgram Aura TTS
  const audioBuffer = await deepgramAuraTTS(translated);

  return audioBuffer; // webm/opus audio in target language
}
```

The function signature does not change. The WebSocket handler does not change. The backpressure queue does not change. The extension does not change. Only these ~10 lines change.

---

## 18. Why We Switched from decodeAudioData to MediaSource API

### What decodeAudioData Is

`AudioContext.decodeAudioData` is a Web Audio API method that takes a complete audio file as an `ArrayBuffer` and fully decodes it into an `AudioBuffer` — the Web Audio API's internal, uncompressed, floating-point representation of audio data. The key word is **complete**. `decodeAudioData` needs the entire file: the format header, all codec initialisation tables, and all encoded audio data. It cannot work with partial files or streaming data. It was designed for loading a sound clip once and playing it — background music, sound effects, UI sounds. Not for streaming.

### Why decodeAudioData Failed on MediaRecorder Chunks

`MediaRecorder` produces a **streaming WebM** file, not a series of independent complete files. The WebM container format has the following structure:

- **Chunk 1 (the first chunk, ~1–2 KB)**: Contains the EBML header (the WebM container magic number and structure), the Segment header, and the `Tracks` element (codec name: `opus`, sample rate: 48000 Hz, channel count: 1). This first chunk is a valid, complete WebM file that `decodeAudioData` can decode successfully.

- **Chunk 2, 3, 4, … (all subsequent chunks, ~4–6 KB each)**: Contain only `Cluster` elements — raw Opus audio data blocks. There is no header. There is no codec information. There is no EBML magic number. These chunks are **continuation data** — they are only meaningful when appended to the stream after the first chunk.

When we called `decodeAudioData` on chunk 5, for example, the browser received a buffer that started with a raw audio block, not an EBML header. The decoder immediately failed with an `EncodingError DOMException` — it looked at the first bytes, found nothing it recognised as a valid audio file format, and gave up. The error `"Unable to decode audio data"` in DevTools was not a network error or a server error — it was the browser correctly reporting that the bytes it received were not a valid standalone audio file, because they were not.

This is why the pipeline appeared to work (chunk 1 played), but all subsequent chunks failed silently in the `catch` block, producing no audio.

### What MediaSource API Is

`MediaSource` is a browser API designed specifically for feeding streaming media to an HTML `<audio>` or `<video>` element. Instead of requiring a complete file, you push chunks to it as they arrive. The browser stitches them together and plays them continuously.

The key components:

**`MediaSource`** — the top-level object. You create one, set it as the `src` of an `<audio>` element via `URL.createObjectURL(mediaSource)`, and wait for the `sourceopen` event.

**`SourceBuffer`** — created inside the `MediaSource` via `mediaSource.addSourceBuffer(mimeType)`. This is where you push audio data using `sourceBuffer.appendBuffer(bytes)`. The browser accumulates chunks internally and plays them continuously through the audio element.

The browser knows that a streaming WebM file's first chunk establishes the header and all subsequent chunks are continuation data. `MediaSource` was designed exactly for this use case — it is the technology behind HTTP Live Streaming (HLS), MPEG-DASH, and other adaptive streaming formats. It correctly handles WebM/Opus streaming because streaming WebM is a first-class use case for `MediaSource`.

### What the `sequence` Mode Means

When you create a `SourceBuffer`, you can set its `mode` property to either `'segments'` or `'sequence'`:

- **`'segments'` mode** (default): The browser uses the internal timestamps embedded in the WebM clusters to place each chunk at the correct position in the timeline. Requires that chunks carry correct, valid timestamps.

- **`'sequence'` mode**: The browser ignores any internal timestamps in the chunks and instead plays them in the order they are appended, assigning timestamps automatically based on the duration of previously appended audio.

We set `sourceBuffer.mode = 'sequence'` because:
1. We always receive and append chunks in the correct chronological order (the server echoes them back in order).
2. The chunks may not carry reliable timestamps if the streaming WebM was not produced from the beginning.
3. `'sequence'` mode is the correct mode for streamed audio where you always append in order and do not need random access or seeking.

### Why the `updateend` Event and Queue Are Necessary

`SourceBuffer` processes one `appendBuffer` call at a time. Internally, it must parse the WebM cluster, decode the Opus frames, and hand them to the browser's audio pipeline before it is ready for the next chunk. While this is happening, `sourceBuffer.updating` is `true`.

If you call `appendBuffer` again while `sourceBuffer.updating === true`, the browser throws an `InvalidStateError`. This is not a bug — it is by design. The buffer has a processing pipeline that must finish before accepting more input.

The `updateend` event fires on the `SourceBuffer` when the current `appendBuffer` call finishes — signalling that `sourceBuffer.updating` is now `false` and the next append is safe.

Our implementation handles this with a queue:
1. If `sourceBuffer.updating === false` when a chunk arrives → append immediately.
2. If `sourceBuffer.updating === true` → push the chunk to `pendingPlayChunks`.
3. In the `updateend` handler → check `pendingPlayChunks`, shift the first chunk, and append it.
4. This drains the queue one chunk at a time without ever double-appending.

We also have a `sourceBufferReady` flag because `addSourceBuffer` is called inside the `sourceopen` event, which fires asynchronously. Chunks can arrive before `sourceopen` fires (especially the very first chunk, which triggers `initMediaSource()` and immediately arrives). Any chunk that arrives before `sourceopen` is pushed to `pendingPlayChunks` and flushed synchronously inside the `sourceopen` handler.

### Why We Disconnect the Original Mic Passthrough When Processing Starts

In the initial Web Audio graph, we connect:

```
realMic → MediaStreamSourceNode (sourceNode) → MediaStreamDestinationNode (destinationNode)
```

This pass-through ensures Meet hears the raw microphone while no processing is active.

When processing starts, we additionally route:

```
MediaSource audio element → createMediaElementSource → MediaStreamDestinationNode (destinationNode)
```

If we left the direct `sourceNode → destinationNode` connection in place, `destinationNode` would receive **two simultaneous audio inputs**:
1. The raw microphone audio (direct pass-through)
2. The server-processed audio from MediaSource

The `MediaStreamDestinationNode` mixes all its inputs together. Meet would therefore receive both your unprocessed voice and the processed voice simultaneously — an echo/doubling effect that makes the call unusable.

By calling `sourceNode.disconnect(destinationNode)` at the moment recording starts, we sever the direct path. Only the MediaSource path remains active. When recording stops, we call `sourceNode.connect(destinationNode)` to restore the direct pass-through, so Meet continues hearing you normally even without processing.

This is the correct pattern for any Web Audio graph where you want to switch between two audio sources: explicitly connect and disconnect rather than mixing both.

---

## 19. The Complete Audio Pipeline — Insertable Streams with Server Processing

### Why the getUserMedia + AudioContext Approach Failed

In the previous architecture we built a Web Audio graph: the real mic stream flowed into a `MediaStreamSourceNode`, through processing nodes, into a `MediaStreamDestinationNode`. We returned `destinationNode.stream` from our `getUserMedia` override.

Meet accepted this `MediaStream` — it is a valid object. But then something unexpected happened. Meet internally extracted the audio track from the stream and passed it to its own **Audio Worklet** — a high-priority audio processing thread that runs in Chrome's audio rendering pipeline. Google Meet's Audio Worklet does not read from the Web Audio node chain we built. It reads from the **underlying hardware device** attached to the track.

A `MediaStreamTrack` backed by a `MediaStreamDestinationNode` has no underlying hardware device. Meet's Audio Worklet found nothing to read. The track appeared to produce silence or, in some configurations, a clone of the real hardware track — bypassing our processing chain entirely. Other participants always heard the original unmodified voice, as if the extension was not installed.

This is not a bug in Meet — it is the correct behaviour. `MediaStreamDestinationNode.stream` is a Web Audio construct designed for Web Audio playback, not for delivering audio to WebRTC tracks in a way that meets Chrome's zero-copy, high-priority media pipeline requirements.

### What the Insertable Streams API Is and Why Google Built It

Before the Insertable Streams API existed (pre-Chrome 94, 2021), there was no way for a web application to modify the audio or video flowing through a `MediaStreamTrack`. You could route audio through a Web Audio graph (as we tried), but as described above, WebRTC did not honour that. You could use a canvas element to modify video frames, but this was slow and did not work for audio at all.

Google shipped the **Insertable Streams API** (also called Breakout Box, Chrome 94, 2021) specifically for:
- **Real-time video effects**: virtual backgrounds, face filters, augmented reality overlays
- **Voice processing**: noise cancellation, vocoders, voice changers
- **End-to-end encryption**: encrypting audio or video frames before WebRTC transmits them (each frame is encrypted client-side, so even the server cannot read it)
- **Our use case**: intercepting raw mic audio frames, sending them to a server for translation, and feeding back the translated audio — all through a track that Meet's Audio Worklet reads as a genuine mic source

The two core objects this API provides are `MediaStreamTrackProcessor` and `MediaStreamTrackGenerator`. Together they let us "break out" of the `MediaStreamTrack` abstraction, process the raw audio at frame level, and produce a new track that is indistinguishable from a real hardware source.

### What MediaStreamTrackProcessor Is

A `MediaStreamTrackProcessor` takes an existing `MediaStreamTrack` — specifically the audio track from the real microphone — and exposes its contents as a `ReadableStream` of `AudioData` objects.

Think of it as opening the wire. Audio data flows from the microphone hardware into Chrome's audio pipeline. Normally you cannot touch this data directly. `MediaStreamTrackProcessor` taps the wire and exposes every audio frame as a JavaScript object you can read one at a time.

```javascript
const processor = new MediaStreamTrackProcessor({ track: micTrack });
const reader = processor.readable.getReader();

// Every call to reader.read() returns the next audio frame
const { value: audioData } = await reader.read();
```

Each `AudioData` object you receive contains:
- **`format`**: `'f32-planar'` — 32-bit floating-point, one plane per channel
- **`sampleRate`**: `48000` — 48,000 samples per second (Chrome's preferred rate)
- **`numberOfFrames`**: approximately `128` — the number of audio samples in this chunk
- **`numberOfChannels`**: `1` for mono microphone input
- **`timestamp`**: microseconds elapsed since the audio context started
- **`copyTo(buffer, { planeIndex: 0 })`**: copies the raw float samples to a `Float32Array` you provide

At 128 samples per frame and 48,000 samples per second, frames arrive approximately **375 times per second** — once every 2.67 milliseconds. Each sample is a floating-point number between -1.0 (maximum negative amplitude) and +1.0 (maximum positive amplitude), representing the raw sound wave captured by the microphone.

### What MediaStreamTrackGenerator Is

A `MediaStreamTrackGenerator` is the reverse. It produces a `MediaStreamTrack` whose content is whatever you write into its `WritableStream`. You push `AudioData` frames in; the track plays them out.

```javascript
const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
const writer = generator.writable.getWriter();

// Write any AudioData frame — this is what Meet will hear
await writer.write(someAudioDataFrame);
```

The critical property: `generator.track` is a **genuine, first-class `MediaStreamTrack`**. It is not a Web Audio API construct. It is not backed by a `MediaStreamDestinationNode`. It is a native track that Chrome's media pipeline treats identically to a track captured from a real microphone hardware device.

When we return `new MediaStream([generator.track])` from our `getUserMedia` override, Meet receives this track. Meet's Audio Worklet reads from `generator.track`. Whatever we write into the generator is exactly what other participants hear. We are not beside the signal chain — we are **in** it.

### The Manual Reader Loop

The most intuitive approach to connecting a processor to a generator is a `TransformStream`:

```javascript
// This looks clean — but it does not work for our purpose
processor.readable
  .pipeThrough(new TransformStream({ transform: myProcessFunction }))
  .pipeTo(generator.writable);
```

A `TransformStream` creates a self-contained pipeline. Data enters one end and exits the other. This works when you have a single data source (the mic) feeding a single destination (the generator).

But we have **two sources**: the mic (pass-through audio) and the server (processed audio frames arriving asynchronously). You cannot write to a `WritableStream` from two places at the same time — the stream picks one writer and locks out the other. Calling `generator.writable.getWriter()` after `pipeTo` has locked the stream throws an error.

The solution is the **manual reader loop**:

```javascript
async function runPipeline() {
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  
  while (true) {
    const { done, value: audioData } = await reader.read();
    if (done) break;
    
    // Single control point — we decide everything here
    await handleAudioFrame(audioData, writer);
  }
}
```

This pattern gives us a single `writer` and a single loop. In each iteration of the loop, we read one mic frame and decide whether to write the mic frame unchanged (pass-through) or write a processed frame from the server. One writer. One loop. Clear logic. No concurrent write conflicts.

### AudioData Lifecycle and Memory Management

`AudioData` objects hold raw audio sample data in memory. This memory is allocated outside the JavaScript heap — it belongs to Chrome's media pipeline. When you are done with an `AudioData`, you must call `audioData.close()` to release that memory.

The streams pipeline handles this automatically in normal cases:
- If you call `writer.write(audioData)`, the stream takes ownership of the frame and closes it when the pipeline is done with it.
- If you call `controller.enqueue(audioData)` in a `TransformStream`, the same applies.

But in our manual loop, when we decide to **replace** a mic frame with a processed frame from the server, we are not writing the mic frame — we are discarding it. In that case, we must close it ourselves:

```javascript
if (playingProcessed && processedQueue.length > 0) {
  const processedFrame = processedQueue.shift();
  audioData.close(); // CRITICAL — prevents memory leak
  await writer.write(processedFrame);
} else {
  await writer.write(audioData); // stream takes ownership, no close() needed
}
```

Failing to close a discarded `AudioData` frame causes a memory leak. At 375 frames per second, even a small leak compounds quickly into hundreds of megabytes of stranded memory over a 30-minute call.

### Sample Accumulation — Why 250ms Chunks

`AudioData` frames arrive at 128 samples each, approximately 375 times per second. Sending a WebSocket message for every 128-sample frame would mean:
- **375 WebSocket messages per second** — enormous network overhead
- Messages arriving faster than any server could process them
- The server would be flooded before it could respond to the first frame

Instead, we **accumulate** frames until we have **12,000 samples** — exactly 250ms of audio at 48kHz:

```
12000 samples ÷ 48000 samples/second = 0.25 seconds = 250ms
250ms → 4 WebSocket messages per second
```

In `handleAudioFrame`, every time processing is enabled, we copy frame samples into an accumulation buffer. When the buffer reaches 12,000 samples, we concatenate all buffered `Float32Array` slices into one combined array and send it to the server. The accumulation buffer resets.

This 250ms chunk timing is not arbitrary — it matches the chunk timing that Deepgram's streaming STT API expects. When we integrate Deepgram, the server receives the same 250ms chunks and passes them directly to Deepgram without reformatting.

### Raw PCM Format for Server Communication

With the Insertable Streams API, we already have raw audio samples as `Float32Array` values (from `audioData.copyTo()`). We send these directly as a JSON array:

```json
{
  "type": "audioPCM",
  "chunkId": 5,
  "t1": 1714000000321,
  "samples": [0.0012, -0.0043, 0.0078, ...],
  "sampleRate": 48000,
  "numberOfChannels": 1
}
```

Why raw PCM instead of encoding to webm/opus first?

1. **Simplicity**: We already have the float values in memory. Encoding them to Opus would require the `AudioEncoder` WebCodecs API, adding complexity and potential failure modes.
2. **Server compatibility**: Node.js can work with raw float arrays directly — `new Float32Array(samples)` gives us the values immediately, ready to pass to `processPCM`.
3. **Localhost**: On localhost, bandwidth is not a concern. A 12,000-sample Float32Array is 48KB. At 4 chunks/second, that is 192KB/s — trivial for localhost.

When we deploy to a remote server (e.g., a Mumbai VM for India users), we will add `AudioEncoder` to compress to Opus before sending, reducing bandwidth by approximately 10×. The server receives the same format either way — the PCM samples, either directly or decoded from Opus.

### The Toggle Behavior

The pipeline always runs — the reader loop is started once when `getUserMedia` is called and keeps running for the duration of the call. The `processingEnabled` flag is the only switch:

**OFF (`processingEnabled = false`):**
Every mic frame is written directly to the generator unchanged. No samples are copied to the accumulation buffer. Nothing is sent to the server. Meet hears the original voice exactly as captured from the microphone. Zero overhead — the loop is trivially fast in the off state.

**ON (`processingEnabled = true`):**
Every mic frame is still written to the generator (so there is never silence). Additionally, the frame's samples are copied into the accumulation buffer. When the buffer reaches 12,000 samples, the chunk is sent to the server. When the server returns processed samples (`type: 'audioPCM'`), `content.js` forwards them to `injected.js`, which splits them into 128-sample `AudioData` frames and pushes them into `processedQueue`.

In the pipeline loop, when `playingProcessed` is `true` and `processedQueue` is non-empty, we write a processed frame instead of the mic frame (the mic frame is closed). The switch from mic to processed is a **hard cut** — a clean, immediate transition with no blending or crossfade. This is correct for the current implementation. A production version might add a sidechain compressor to duck the mic before the switch and fade in the processed audio, but the hard cut is sufficient to prove the pipeline works.

### The `processPCM` Function — The Single Swappable Function

The entire server is built around one principle: everything is infrastructure except `processPCM`. The WebSocket handler, the backpressure queue, the drain loop, the client tracking — none of that ever needs to change. Only `processPCM` changes.

Current implementation — tanh soft-clip saturation:

```javascript
function processPCM(samples, pitchSemitones) {
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    output[i] = Math.tanh(samples[i] * 2.0);
  }
  return output;
}
```

`Math.tanh(x * 2.0)` is a soft-limiter. It compresses the dynamic range — samples near ±1.0 are pushed toward ±1.0 asymptotically rather than clipping hard. The 2× gain makes the voice noticeably louder and slightly saturated. This is obviously different from the original voice — a clear, audible, subjective proof that server processing is working at all.

Production implementation — voice translation:

```javascript
async function processPCM(samples, pitchSemitones) {
  // Step 1: Deepgram Streaming STT
  const transcript = await deepgramSTT(samples);
  if (!transcript || transcript.trim() === '') return samples; // silence
  
  // Step 2: Gemini Flash translation
  const translated = await geminiFlash(transcript, targetLanguage);
  
  // Step 3: Deepgram Aura TTS
  const audioSamples = await deepgramAuraTTS(translated, 48000);
  return audioSamples; // Float32Array
}
```

The function signature — `(Float32Array samples, number pitchSemitones) → Float32Array` — is permanent. The server handler never changes. Only the body of `processPCM` changes when real AI processing is integrated.

### Why This Is the Correct Production Architecture

Every component of the current implementation is in the final product, unchanged:

| Component | Status in demo | Status in production |
|---|---|---|
| `MediaStreamTrackProcessor` | Reads real mic frames | Same — never changes |
| `MediaStreamTrackGenerator` | Outputs to Meet | Same — never changes |
| Manual reader loop | Controls what Meet hears | Same — never changes |
| 250ms PCM accumulation | Buffers frames for server | Same — matches Deepgram |
| `processedQueue` + hard switch | Plays server audio | Enhanced with crossfade |
| WebSocket pipeline | Carries PCM samples | Same — just different content |
| `processPCM` | tanh saturation demo | Deepgram+Gemini+TTS body |
| Backpressure queue | Drops stale chunks | Same — prevents lag buildup |
| Latency measurement (t1–t4) | Measures demo latency | Measures AI API latency |
| Dashboard broadcasting | Shows demo timing | Shows full pipeline timing |

The demo is considered working when: toggle ON → speak → the other participant hears a noticeably louder and slightly saturated version of your voice with approximately 250ms of delay. This 250ms delay is the round-trip time of one chunk through the pipeline (extension → server → back). When deployed with real AI processing, the delay will be the sum of Deepgram STT latency (~300ms) + Gemini translation latency (~200ms) + Deepgram TTS latency (~300ms) + network time — typically 800–1500ms total, which is acceptable for voice translation where the listener expects a slight delay.
