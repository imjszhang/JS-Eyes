# JS Eyes

<div align="center">

**Browser Automation for AI Agent Frameworks**

Give your AI agents real eyes into the browser — WebSocket-powered automation with native OpenClaw support

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-imjszhang%2Fjs--eyes-181717?logo=github)](https://github.com/imjszhang/js-eyes)
[![Website](https://img.shields.io/badge/Website-js--eyes.com-FCD228?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjE2IiBmaWxsPSIjRkNEMjI4Ii8+PHRleHQgeD0iNjQiIHk9IjY0IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSI3MiIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzM3MzQyRiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZG9taW5hbnQtYmFzZWxpbmU9ImNlbnRyYWwiPkpTPC90ZXh0Pjwvc3ZnPg==)](https://js-eyes.com)
[![X (Twitter)](https://img.shields.io/badge/X-@imjszhang-000000?logo=x)](https://x.com/imjszhang)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/)
[![Firefox](https://img.shields.io/badge/Firefox-Manifest%20V2-FF7139?logo=firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)

[English](#quick-install) | [中文文档](./docs/README_CN.md)

</div>

---

## Quick Install

**Linux / macOS:**

```bash
curl -fsSL https://js-eyes.com/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://js-eyes.com/install.ps1 | iex
```

This downloads the skill bundle, installs dependencies, and prints the OpenClaw registration path. See [Manual Installation](#manual-installation) for other options.

---

## Introduction

JS Eyes is a browser extension + WebSocket server that gives AI agents full browser automation capabilities. It connects to AI agent frameworks (OpenClaw, DeepSeek Cowork, or custom) and provides tools for tab management, content extraction, script execution, cookie access, and more.

```
Browser Extension  <── WebSocket ──>  JS-Eyes Server  <── WebSocket ──>  AI Agent (OpenClaw)
 (Chrome/Edge/FF)                     (Node.js)                         (Plugin: index.mjs)
```

### Supported Agent Frameworks

| Framework | Description |
|-----------|-------------|
| [js-eyes/server](./server) | Lightweight built-in server (HTTP+WS on single port, no auth) |
| [OpenClaw](https://openclaw.ai/) (Plugin) | Registers as OpenClaw plugin — 9 AI tools, background service, CLI commands |
| [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) | Full-featured agent framework (separate WS port, HMAC auth, SSE, rate limiting) |

## Features

- **Real-time WebSocket Communication** — Persistent connection with server
- **Auto Server Discovery** — Automatic capability detection and endpoint configuration
- **Tab Management** — Auto-sync tab information to server
- **Remote Control** — Remote open/close tabs, execute scripts
- **Content Retrieval** — Get page HTML, text, links
- **Cookie Management** — Auto-retrieve and sync page cookies
- **Code Injection** — JavaScript execution and CSS injection
- **Health Check & Circuit Breaker** — Service health monitoring with automatic circuit breaker protection
- **SSE Fallback** — Auto-fallback to SSE when WebSocket connection fails
- **Rate Limiting & Deduplication** — Request rate limiting and deduplication for stability
- **Adaptive Authentication** — Auto-detects server auth requirements (HMAC-SHA256 or no-auth)
- **Extension Skills** — Discover and install higher-level skills (e.g. X.com search) on top of base automation

## Supported Browsers

| Browser | Version | Manifest |
|---------|---------|----------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## Download

Download the latest release from [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest):

- **Chrome/Edge Extension**: `js-eyes-chrome-v1.4.3.zip`
- **Firefox Extension**: `js-eyes-firefox-v1.4.3.xpi`

Or download directly from [js-eyes.com](https://js-eyes.com).

## Manual Installation

### Browser Extension

#### Chrome / Edge

1. Open browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the `chrome-extension` folder

#### Firefox

**Signed XPI** (recommended): drag and drop the `.xpi` file into Firefox.

**Temporary** (development): open `about:debugging` > This Firefox > Load Temporary Add-on > select `firefox-extension/manifest.json`.

### OpenClaw Skill Bundle

If you prefer manual setup instead of the [one-command install](#quick-install):

1. Download `js-eyes-skill.zip` from [js-eyes.com](https://js-eyes.com/js-eyes-skill.zip) or [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest)
2. Extract to a directory (e.g. `./skills/js-eyes`)
3. Run `npm install` inside the extracted folder
4. Register the plugin in `~/.openclaw/openclaw.json` (see [OpenClaw Plugin](#openclaw-plugin))

## Usage

### 1. Start a Compatible Server

**Option A** — Built-in lightweight server:
```bash
npm run server
# Starts on http://localhost:18080 (HTTP + WebSocket)
```

**Option B** — Use as an [OpenClaw](https://openclaw.ai/) plugin (see [OpenClaw Plugin](#openclaw-plugin) section below).

**Option C** — Use a supported agent framework such as [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork).

### 2. Configure Connection

1. Click the extension icon in the browser toolbar
2. Enter the server HTTP address (e.g. `http://localhost:18080`)
3. Click "Connect" — the extension automatically discovers WebSocket endpoint and server capabilities
4. For servers with authentication, configure the auth key in security settings

**Auto-Connect:** the extension reconnects automatically on startup and after disconnections (exponential backoff).

### 3. Verify Connection

```bash
openclaw js-eyes status
```

Expected output shows server uptime, connected extensions, and tab count.

## OpenClaw Plugin

JS Eyes registers as an [OpenClaw](https://openclaw.ai/) plugin, providing browser automation tools directly to AI agents.

### What It Provides

- **Background Service** — Automatically starts/stops the built-in WebSocket server
- **9 AI Tools** — Browser automation + skill discovery/installation (see table below)
- **CLI Commands** — `openclaw js-eyes status`, `openclaw js-eyes tabs`, `openclaw js-eyes server start/stop`

| Tool | Description |
|------|-------------|
| `js_eyes_get_tabs` | List all open browser tabs with ID, URL, title |
| `js_eyes_list_clients` | List connected browser extension clients |
| `js_eyes_open_url` | Open a URL in new or existing tab |
| `js_eyes_close_tab` | Close a tab by ID |
| `js_eyes_get_html` | Get full HTML content of a tab |
| `js_eyes_execute_script` | Run JavaScript in a tab and return result |
| `js_eyes_get_cookies` | Get all cookies for a tab's domain |
| `js_eyes_discover_skills` | Query the skill registry for available extension skills |
| `js_eyes_install_skill` | Download, extract, and register an extension skill |

### Setup

1. Install the browser extension in Chrome/Edge/Firefox (same as above)
2. Add the plugin to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/skills/js-eyes/openclaw-plugin"]
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

3. Restart OpenClaw — the server launches automatically and AI agents can control the browser via registered tools.

### Plugin Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverHost` | string | `"localhost"` | Server listen address |
| `serverPort` | number | `18080` | Server port |
| `autoStartServer` | boolean | `true` | Auto-start server when plugin loads |
| `requestTimeout` | number | `60` | Request timeout in seconds |
| `skillsRegistryUrl` | string | `"https://js-eyes.com/skills.json"` | URL of the extension skill registry |
| `skillsDir` | string | `""` | Skill install directory (empty = auto-detect `skills/` under skill root) |

## Extension Skills

JS Eyes supports **extension skills** — higher-level capabilities built on top of the base browser automation. Each skill adds new AI tools and can be installed independently.

| Skill | Description | Tools |
|-------|-------------|-------|
| [js-search-x](./skills/js-search-x/) | X.com (Twitter) content scraping — search tweets, user timelines, post details, home feed | `x_search_tweets`, `x_get_profile`, `x_get_post`, `x_get_home_feed` |

### Discovering Skills

AI agents can discover available skills automatically:

```
# Via the AI tool
js_eyes_discover_skills

# Via the skill registry
https://js-eyes.com/skills.json
```

### Installing Extension Skills

**One-command install:**

```bash
# Linux / macOS
curl -fsSL https://js-eyes.com/install.sh | bash -s -- js-search-x

# Windows PowerShell
$env:JS_EYES_SKILL="js-search-x"; irm https://js-eyes.com/install.ps1 | iex
```

**Via AI agent:** the agent calls `js_eyes_install_skill` with the skill ID — it downloads, extracts, installs dependencies, and registers the plugin automatically.

**Manual:** download the skill zip from [js-eyes.com/skills/js-search-x/](https://js-eyes.com/skills/js-search-x/js-search-x-skill.zip), extract to `skills/js-eyes/skills/js-search-x/`, run `npm install`, and add the plugin path to `openclaw.json`.

## Building

### Prerequisites

- Node.js >= 16
- Run `npm install` in the project root

### Build Commands

```bash
# Build site (docs/) + skill bundles + skills.json registry
npm run build:site

# Build Chrome extension only
npm run build:chrome

# Build and sign Firefox extension
npm run build:firefox

# Bump version across all manifests
npm run bump -- 1.4.3
```

Output files are saved to the `dist/` directory.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Extension shows "Disconnected" | Check `openclaw js-eyes status`; ensure `autoStartServer` is `true` |
| `js_eyes_get_tabs` returns empty | Click extension icon, verify address, click Connect |
| `Cannot find module 'ws'` | Run `npm install` in the skill root |
| Tools not appearing in OpenClaw | Ensure `plugins.load.paths` points to the `openclaw-plugin` subdirectory |
| Plugin path not found (Windows) | Use forward slashes in JSON, e.g. `C:/Users/you/skills/js-eyes/openclaw-plugin` |

## Related Projects

- [OpenClaw](https://openclaw.ai/) — AI agent framework with extensible plugin system
- [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) — AI agent framework with full-featured browser automation support

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

---

<div align="center">

**Browser automation for any AI agent framework**

[js-eyes.com](https://js-eyes.com) | [GitHub](https://github.com/imjszhang/js-eyes) | [@imjszhang](https://x.com/imjszhang)

</div>
