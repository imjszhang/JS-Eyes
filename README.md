# JS Eyes

<div align="center">

**Browser Extension for AI Agent Frameworks**

Provides browser automation capabilities for AI agent frameworks via WebSocket

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-imjszhang%2Fjs--eyes-181717?logo=github)](https://github.com/imjszhang/js-eyes)
[![X (Twitter)](https://img.shields.io/badge/X-@imjszhang-000000?logo=x)](https://x.com/imjszhang)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/)
[![Firefox](https://img.shields.io/badge/Firefox-Manifest%20V2-FF7139?logo=firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)

[English](#introduction) | [中文文档](./docs/README_CN.md)

</div>

---

## Introduction

JS Eyes is a browser extension that communicates with AI agent frameworks via WebSocket to enable browser automation control. It supports multiple server backends through automatic capability discovery.

> 💡 Let AI assistants help you operate your browser: open pages, batch fill forms, extract data, cross-site operations

### Supported Agent Frameworks

| Framework | Description |
|-----------|-------------|
| [js-eyes/server](./server) | Lightweight built-in server (HTTP+WS on single port, no auth) |
| [OpenClaw](https://github.com/nicepkg/openclaw) (Plugin) | Registers as OpenClaw plugin — AI tools, background service, CLI commands |
| [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) | Full-featured agent framework (separate WS port, HMAC auth, SSE, rate limiting) |

## Features

- 🔗 **Real-time WebSocket Communication** - Persistent connection with server
- 🔍 **Auto Server Discovery** - Automatic capability detection and endpoint configuration
- 📊 **Tab Management** - Auto-sync tab information to server
- 🎯 **Remote Control** - Remote open/close tabs, execute scripts, etc.
- 📄 **Content Retrieval** - Get page HTML, text, links, and more
- 🍪 **Cookie Management** - Auto-retrieve and sync page cookies
- 💉 **Code Injection** - Support JavaScript execution and CSS injection
- 📱 **Status Monitoring** - Real-time connection status and extension info
- 🏥 **Health Check & Circuit Breaker** - Service health monitoring with automatic circuit breaker protection
- 🔄 **SSE Fallback** - Auto-fallback to SSE when WebSocket connection fails (if server supports it)
- ⚡ **Rate Limiting & Deduplication** - Request rate limiting and deduplication for stability
- 🔐 **Adaptive Authentication** - Auto-detects server auth requirements (HMAC-SHA256 or no-auth)

## Supported Browsers

| Browser | Version | Manifest |
|---------|---------|----------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## Download

### Latest Release

Download the latest release from [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest):

- **Chrome/Edge Extension**: `js-eyes-chrome-v1.4.0.zip`
- **Firefox Extension**: `js-eyes-firefox-v1.4.0.xpi`

### Installation from Source

If you prefer to install from source code:

1. Clone this repository
2. Follow the installation instructions below

## Installation

### Chrome / Edge

1. Open browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `chrome-extension` folder
5. The extension will be installed and activated

### Firefox

#### Temporary Installation (Development)

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select `firefox-extension/manifest.json`

#### Signed XPI Installation

If you have a signed `.xpi` file:
1. Drag and drop into Firefox browser window
2. Or open the file path in the address bar

## Usage

### 1. Start a Compatible Server

**Option A** - Built-in lightweight server:
```bash
npm run server
# Starts on http://localhost:18080 (HTTP + WebSocket)
```

**Option B** - Use as an [OpenClaw](https://github.com/nicepkg/openclaw) plugin (see [OpenClaw Plugin](#openclaw-plugin) section below).

**Option C** - Use a supported agent framework such as [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork).

### 2. Configure Connection

1. Click the extension icon in the browser toolbar
2. Enter the server HTTP address (e.g. `http://localhost:18080`)
3. Click "Connect" - the extension automatically discovers WebSocket endpoint and server capabilities
4. For servers with authentication, configure the auth key in security settings

**Auto-Connect Feature:**
- Extension automatically connects on startup (if enabled)
- Auto-reconnects after disconnection (exponential backoff, unlimited retries)
- Can be enabled/disabled in settings

### 3. Verify Connection

- Status indicator shows "Connected" (green) when successful
- "Server Type" shows detected server info and capabilities
- Tab information automatically syncs to server
- View current tab and statistics in popup

## Troubleshooting

If you encounter connection issues:
- Ensure the server is running
- Verify server address (use HTTP address, e.g. `http://localhost:18080`)
- Check browser console for error messages
- The extension auto-discovers the WebSocket endpoint from the HTTP address

## Building

### Prerequisites

- Node.js >= 14
- Run `npm install` in the project root

### Build Commands

```bash
# Build all extensions (Firefox is signed automatically)
npm run build

# Build Chrome extension only
npm run build:chrome

# Build and sign Firefox extension
npm run build:firefox

# Bump version across all manifests
npm run bump -- 1.4.0
```

Output files are saved to the `dist/` directory. See [releases/README.md](releases/README.md) for detailed documentation.

## OpenClaw Plugin

JS Eyes can be used as an [OpenClaw](https://github.com/nicepkg/openclaw) plugin, providing browser automation tools directly to OpenClaw AI agents.

### What it provides

- **Background Service** — Automatically starts/stops the built-in WebSocket server
- **7 AI Tools** — `js_eyes_get_tabs`, `js_eyes_list_clients`, `js_eyes_open_url`, `js_eyes_close_tab`, `js_eyes_get_html`, `js_eyes_execute_script`, `js_eyes_get_cookies`
- **CLI Commands** — `openclaw js-eyes status`, `openclaw js-eyes tabs`, `openclaw js-eyes server start/stop`

### Setup

1. Install the browser extension in Chrome/Edge/Firefox (same as above)
2. Add the plugin to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/JS-Eyes/openclaw-plugin"]
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

3. Start OpenClaw — the server launches automatically and AI agents can control the browser via registered tools.

### Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverHost` | string | `"localhost"` | Server listen address |
| `serverPort` | number | `18080` | Server port |
| `autoStartServer` | boolean | `true` | Auto-start server when plugin loads |
| `requestTimeout` | number | `60` | Request timeout in seconds |

## Related Projects

- [OpenClaw](https://github.com/nicepkg/openclaw) - AI agent framework with extensible plugin system
- [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) - AI agent framework with full-featured browser automation support

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

Created by **[@imjszhang](https://x.com/imjszhang)**

Follow me on X for updates, tips, and more open source projects!

---

<div align="center">

**Browser automation for any AI agent framework**

Built with ❤️ by [@imjszhang](https://x.com/imjszhang)

</div>
