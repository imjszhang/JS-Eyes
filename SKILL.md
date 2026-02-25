---
name: js-eyes
description: Browser automation for AI agents — control tabs, extract content, execute scripts and manage cookies via WebSocket.
version: 1.4.0
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

## Setup

### 1. Install the browser extension

Download from [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest):

- **Chrome/Edge**: `js-eyes-chrome-v1.4.0.zip` — load unpacked at `chrome://extensions/`
- **Firefox**: `js-eyes-firefox-v1.4.0.xpi` — drag into browser window

### 2. Install the OpenClaw plugin

Clone the repository and add the plugin path to your OpenClaw config (`~/.openclaw/openclaw.json`):

```bash
git clone https://github.com/imjszhang/js-eyes.git
```

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/js-eyes/openclaw-plugin"]
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

### 3. Connect

1. Start OpenClaw — the built-in WebSocket server launches automatically on port 18080
2. Click the browser extension icon, enter `http://localhost:18080`, click Connect
3. The AI agent can now control the browser via the registered tools

## Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverHost` | string | `"localhost"` | Server listen address |
| `serverPort` | number | `18080` | Server port (must match extension config) |
| `autoStartServer` | boolean | `true` | Auto-start server when plugin loads |
| `requestTimeout` | number | `60` | Per-request timeout in seconds |

## Supported Browsers

| Browser | Version | Manifest |
|---------|---------|----------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## Dependencies

- **Runtime**: Node.js, `ws` (WebSocket library)
- **Browser**: Chrome 88+ / Edge 88+ / Firefox 58+ with the JS Eyes extension installed

## Links

- Source: <https://github.com/imjszhang/js-eyes>
- Releases: <https://github.com/imjszhang/js-eyes/releases>
- Author: [@imjszhang](https://x.com/imjszhang)
- License: MIT
