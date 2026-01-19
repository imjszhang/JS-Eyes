# JS Eyes

<div align="center">

**Browser Extension for DeepSeek Cowork**

Provides browser automation capabilities for [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-imjszhang%2Fjs--eyes-181717?logo=github)](https://github.com/imjszhang/js-eyes)
[![X (Twitter)](https://img.shields.io/badge/X-@imjszhang-000000?logo=x)](https://x.com/imjszhang)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/)
[![Firefox](https://img.shields.io/badge/Firefox-Manifest%20V2-FF7139?logo=firefox)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions)

[English](#introduction) | [中文文档](./docs/README_CN.md)

</div>

---

## Introduction

JS Eyes is the browser extension component for [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork). It communicates with the DeepSeek Cowork server via WebSocket to enable browser automation control.

> 💡 Let AI assistants help you operate your browser: open pages, batch fill forms, extract data, cross-site operations

## Features

- 🔗 **Real-time WebSocket Communication** - Persistent connection with DeepSeek Cowork server
- 📊 **Tab Management** - Auto-sync tab information to server
- 🎯 **Remote Control** - Remote open/close tabs, execute scripts, etc.
- 📄 **Content Retrieval** - Get page HTML, text, links, and more
- 🍪 **Cookie Management** - Auto-retrieve and sync page cookies
- 💉 **Code Injection** - Support JavaScript execution and CSS injection
- 📱 **Status Monitoring** - Real-time connection status and extension info

## Supported Browsers

| Browser | Version | Manifest |
|---------|---------|----------|
| Chrome | 88+ | V3 |
| Edge | 88+ | V3 |
| Firefox | 58+ | V2 |

## Download

### Latest Release

Download the latest release from [GitHub Releases](https://github.com/imjszhang/js-eyes/releases/latest):

- **Chrome/Edge Extension**: `js-eyes-chrome-v1.0.0.zip`
- **Firefox Extension**: `js-eyes-firefox-v1.0.0.xpi`

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

### 1. Start DeepSeek Cowork Server

Ensure DeepSeek Cowork is running with WebSocket server listening on port 8080 (default).

### 2. Configure Connection

1. Click the extension icon in the browser toolbar
2. Check connection status in the popup
3. Modify server address in settings if needed
4. Click "Connect" to apply settings and connect

**Auto-Connect Feature:**
- Extension automatically connects on startup (if enabled)
- Auto-reconnects after disconnection (exponential backoff, unlimited retries)
- Can be enabled/disabled in settings

### 3. Verify Connection

- Status indicator shows "Connected" (green) when successful
- Tab information automatically syncs to server
- View current tab and statistics in popup

## Troubleshooting

If you encounter connection issues:
- Ensure DeepSeek Cowork is running
- Verify server address and port settings
- Check browser console for error messages

## Related Projects

- [DeepSeek Cowork](https://github.com/imjszhang/deepseek-cowork) - Main project

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

**Making AI browser automation accessible to everyone**

Built with ❤️ by [@imjszhang](https://x.com/imjszhang)

</div>
