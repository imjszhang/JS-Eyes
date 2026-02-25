---
name: js-eyes
description: Browser automation for AI agents — control tabs, extract content, execute scripts and manage cookies via WebSocket.
version: 1.5.0
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

## Skill Bundle Structure

This skill bundle is published from the repository root and contains all files required to run the OpenClaw plugin:

```
js-eyes/
├── SKILL.md                        ← Skill entry point (this file)
├── package.json                    ← Root package — declares ws dependency
├── LICENSE
├── openclaw-plugin/
│   ├── openclaw.plugin.json        ← Plugin manifest (ID, config schema, UI hints)
│   ├── package.json                ← ESM module descriptor, declares entry point
│   └── index.mjs                   ← Plugin logic — registers 7 AI tools, 1 service, CLI
├── server/
│   ├── index.js                    ← HTTP + WebSocket server
│   ├── ws-handler.js               ← Connection and message handling
│   └── package.json
└── clients/
    └── js-eyes-client.js           ← Node.js client SDK for browser automation
```

> `openclaw-plugin/index.mjs` imports from `../server/` and `../clients/` via relative paths, so the directory layout above must be preserved — `openclaw-plugin/` cannot be used in isolation.

## Prerequisites

- **Node.js** >= 14
- **A supported browser**: Chrome 88+ / Edge 88+ / Firefox 58+

## Deploy to .openclaw

Install the skill via ClawHub:

```bash
clawhub install js-eyes
```

This downloads and extracts the skill bundle into the local OpenClaw skills directory (typically `~/.openclaw/skills/js-eyes/`). The bundle is self-contained — it includes the plugin, WebSocket server, and client SDK.

Install Node.js dependencies — the `ws` package is required at runtime:

```bash
cd ~/.openclaw/skills/js-eyes
npm install
```

Register the plugin in your OpenClaw config. Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/skills/js-eyes/openclaw-plugin"]
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

> The path must point to the `openclaw-plugin` subdirectory inside the installed skill, not to the skill root. `index.mjs` resolves `../server/` and `../clients/` relative to itself, so the bundle directory layout must be preserved.

Restart OpenClaw to load the plugin.

> **For developers**: if you want to modify the source, clone the [full repository](https://github.com/imjszhang/js-eyes) and point `plugins.load.paths` to the `openclaw-plugin` directory inside your clone instead.

## Browser Extension Setup

The plugin talks to browsers through the JS Eyes extension. Install it separately:

1. Download from [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest):
   - **Chrome / Edge**: `js-eyes-chrome-vX.Y.Z.zip` — open `chrome://extensions/` (or `edge://extensions/`), enable Developer mode, click "Load unpacked", select the extracted folder
   - **Firefox**: `js-eyes-firefox-vX.Y.Z.xpi` — drag and drop into the browser window

2. Click the JS Eyes extension icon in the toolbar, enter `http://localhost:18080` as the server address, click **Connect** — the status should turn green.

## Verify

Run the CLI command to confirm everything is working:

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
| `Cannot find module 'ws'` | Dependencies not installed | Run `npm install` in the skill root (where `package.json` declares `ws`) |
| Tools not appearing in OpenClaw | Plugin path wrong or not enabled | Ensure `plugins.load.paths` points to the `openclaw-plugin` subdirectory, not the skill root |

## Links

- Source: <https://github.com/imjszhang/js-eyes>
- Releases: <https://github.com/imjszhang/js-eyes/releases>
- ClawHub: <https://clawhub.ai/skills/js-eyes>
- Author: [@imjszhang](https://x.com/imjszhang)
- License: MIT
