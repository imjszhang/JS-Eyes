---
name: js-eyes
description: Browser automation for AI agents — control tabs, extract content, execute scripts and manage cookies via WebSocket.
version: 1.4.2
metadata:
  openclaw:
    emoji: "\U0001F441"
    homepage: https://github.com/imjszhang/js-eyes
    os:
      - windows
      - macos
      - linux
    requires:
      bins:
        - node
    install:
      - kind: node
        package: ws
        bins: []
---

# JS Eyes

Browser extension + WebSocket server that gives AI agents full browser automation capabilities.

## What it does

JS Eyes connects a browser extension (Chrome / Edge / Firefox) to an AI agent framework via WebSocket, enabling the agent to:

- List and manage browser tabs
- Open URLs and navigate pages
- Extract full HTML content from any tab
- Execute arbitrary JavaScript in page context
- Read cookies for any domain
- Monitor connected browser clients

## Architecture

```
Browser Extension  <── WebSocket ──>  JS-Eyes Server  <── WebSocket ──>  AI Agent (OpenClaw)
 (Chrome/Edge/FF)                     (Node.js)                         (Plugin: index.mjs)
```

The browser extension runs in the user's browser and maintains a persistent WebSocket connection to the JS-Eyes server. The OpenClaw plugin connects to the same server and exposes 7 AI tools + a background service + CLI commands.

## Provided AI Tools

| Tool | Description |
|------|-------------|
| `js_eyes_get_tabs` | List all open browser tabs with ID, URL, title |
| `js_eyes_list_clients` | List connected browser extension clients |
| `js_eyes_open_url` | Open a URL in new or existing tab |
| `js_eyes_close_tab` | Close a tab by ID |
| `js_eyes_get_html` | Get full HTML content of a tab |
| `js_eyes_execute_script` | Run JavaScript in a tab and return result |
| `js_eyes_get_cookies` | Get all cookies for a tab's domain |

## CLI Commands

```
openclaw js-eyes status          # Server connection status
openclaw js-eyes tabs            # List all browser tabs
openclaw js-eyes server start    # Start the built-in server
openclaw js-eyes server stop     # Stop the built-in server
```

## Plugin Files

This skill bundle contains the OpenClaw plugin source — these are the files OpenClaw needs to load and run the plugin:

| File | Role |
|------|------|
| `openclaw.plugin.json` | Plugin manifest — ID, description, config schema (JSON Schema) and UI hints for settings |
| `package.json` | Node.js package descriptor — declares ESM module type and the plugin entry point |
| `index.mjs` | Plugin logic — registers 7 AI tools, 1 background service (WebSocket server) and CLI commands with OpenClaw |

> `index.mjs` imports the WebSocket server and client SDK from the parent repository (`../server/` and `../clients/`), so the full [js-eyes repo](https://github.com/imjszhang/js-eyes) must be cloned for the plugin to work. This directory alone is not self-contained.

## Prerequisites

- **Node.js** >= 14
- **Git**
- **A supported browser**: Chrome 88+ / Edge 88+ / Firefox 58+

## Setup

### Step 1: Install the browser extension

Download the latest version from [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest):

- **Chrome/Edge**: download `js-eyes-chrome-vX.Y.Z.zip`, open `chrome://extensions/` (or `edge://extensions/`), enable Developer mode, click "Load unpacked" and select the extracted folder
- **Firefox**: download `js-eyes-firefox-vX.Y.Z.xpi`, drag and drop into the browser window

### Step 2: Clone and install

```bash
git clone https://github.com/imjszhang/js-eyes.git
cd js-eyes
npm install
```

### Step 3: Register the plugin in OpenClaw

Edit your OpenClaw config file (`~/.openclaw/openclaw.json`) and add the plugin:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/projects/js-eyes/openclaw-plugin"]
    },
    "entries": {
      "js-eyes": {
        "enabled": true,
        "config": {
          "serverPort": 18080,
          "autoStartServer": true
        }
      }
    }
  }
}
```

> Replace `~/projects/js-eyes/openclaw-plugin` with the actual absolute path to the `openclaw-plugin` directory inside the cloned repository.

### Step 4: Connect the browser extension

1. Start OpenClaw — the built-in WebSocket server launches automatically on port 18080
2. Click the JS Eyes extension icon in the browser toolbar
3. Enter `http://localhost:18080` as the server address
4. Click "Connect" — the status should turn green ("Connected")

### Step 5: Verify

Run the following CLI command to confirm everything is working:

```bash
openclaw js-eyes status
```

Expected output:

```
=== JS-Eyes Server Status ===
  Uptime: ...s
  Browser extensions: 1
  Automation clients: ...
```

You can also ask the AI agent to list your browser tabs — it should invoke `js_eyes_get_tabs` and return the tab list.

## Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverHost` | string | `"localhost"` | Server listen address |
| `serverPort` | number | `18080` | Server port (must match extension config) |
| `autoStartServer` | boolean | `true` | Auto-start server when plugin loads |
| `requestTimeout` | number | `60` | Per-request timeout in seconds |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Extension shows "Disconnected" | Server not running | Check `openclaw js-eyes status`; ensure `autoStartServer` is `true` |
| `js_eyes_get_tabs` returns empty | No extension connected | Click extension icon, verify address is correct, click Connect |
| `Cannot find module 'ws'` | Dependencies not installed | Run `npm install` in the cloned `js-eyes` directory |
| Tools not appearing in OpenClaw | Plugin path wrong or not enabled | Double-check the path in `plugins.load.paths` points to the `openclaw-plugin` folder |

## Links

- Source: <https://github.com/imjszhang/js-eyes>
- Releases: <https://github.com/imjszhang/js-eyes/releases>
- Author: [@imjszhang](https://x.com/imjszhang)
- License: MIT
