# Release Notes

## v1.3.5

### Changes
- Synced Chrome extension with Firefox extension feature parity
- Connection orphan protection: connection instance tracking (`connectionId`) and `_cleanupSocket` for proper cleanup
- Message handling: added rate limit, deduplication, and queue checks before processing requests
- Session management: `session_expired` and `session_expiring` handling for session refresh
- Server config: use `extensionRateLimit` instead of `callbackQueryLimit` for rate limit sync
- Cleanup task: send timeout response for expired requests, run every 10 seconds
- `handleOpenUrl`: URL deduplication, timeout protection, URL-tab cache
- `handleGetHtml` / `handleExecuteScript`: timeout protection via `withTimeout`
- `reconnectWithNewSettings`: use `_cleanupSocket` for proper connection cleanup
- Stop health checker on WebSocket close/error

### Downloads
- [Chrome Extension](https://github.com/imjszhang/js-eyes/releases/download/v1.3.5/js-eyes-chrome-v1.3.5.zip)
- [Firefox Extension](https://github.com/imjszhang/js-eyes/releases/download/v1.3.5/js-eyes-firefox-v1.3.5.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.3.5.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.3.5.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.3.4

### Changes
- Enhanced connection management: Improved socket cleanup and connection instance tracking to prevent orphan connections
- Minor adjustments to background script for better stability and error handling

### Downloads
- [Chrome Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.4/js-eyes-chrome-v1.3.4.zip)
- [Firefox Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.4/js-eyes-firefox-v1.3.4.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.3.4.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.3.4.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.3.3

### Changes
- Unified build scripts: replaced 6 platform-specific shell scripts (PS1/SH) + sign-firefox.js with a single cross-platform Node.js build script (`releases/build.js`)
- Added root `package.json` as the single source of truth for version management
- Added `bump` command to sync version across `package.json`, `chrome-extension/manifest.json`, and `firefox-extension/manifest.json` in one step
- Added npm scripts for convenient build commands (`npm run build`, `npm run build:chrome`, `npm run build:firefox:sign`, `npm run bump`)

### Downloads
- [Chrome Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.3/js-eyes-chrome-v1.3.3.zip)
- [Firefox Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.3/js-eyes-firefox-v1.3.3.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.3.3.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.3.3.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.3.2

### Changes
- Refactor code: Rename classes from `KaichiBrowserControl`/`KaichiContentScript` to `BrowserControl`/`ContentScript`
- Improve reconnection mechanism: Add jitter (random offset) to prevent thundering herd problem when multiple clients reconnect simultaneously
- Add `resetReconnectCounter()` method for better connection state management
- Enhanced logging and error messages

### Downloads
- [Chrome Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.2/js-eyes-chrome-v1.3.2.zip)
- [Firefox Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.2/js-eyes-firefox-v1.3.2.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.3.2.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.3.2.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.3.1

### Changes
- Add `get_cookies_by_domain` functionality to enhance cookie retrieval options

### Downloads
- [Chrome Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.1/js-eyes-chrome-v1.3.1.zip)
- [Firefox Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.1/js-eyes-firefox-v1.3.1.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.3.1.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.3.1.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.3.0

### Changes
- Enhanced stability features with rate limiting, request deduplication, and queue management
- Sync Chrome extension with Firefox v1.3.0 stability features
- Integrated utility functions for improved request handling and cleanup tasks

### Downloads
- [Chrome Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.0/js-eyes-chrome-v1.3.0.zip)
- [Firefox Extension](https://github.com/imjszhang/JS-Eyes/releases/download/v1.3.0/js-eyes-firefox-v1.3.0.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.3.0.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.3.0.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.2.0

### Changes
- Updated to version 1.2.0

### Downloads
- [Chrome Extension](js-eyes-chrome-v1.2.0.zip)
- [Firefox Extension](js-eyes-firefox-v1.2.0.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.2.0.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.2.0.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

## v1.1.0

### Changes
- Unified version number to 1.1.0
- Optimized build process, unified output to `dist/` directory
- Firefox extension supports official signing

### Downloads
- [Chrome Extension](js-eyes-chrome-v1.1.0.zip)
- [Firefox Extension](js-eyes-firefox-v1.1.0.xpi)

### Installation Instructions

#### Chrome/Edge
1. Download `js-eyes-chrome-v1.1.0.zip`
2. Extract the ZIP file
3. Open your browser and navigate to `chrome://extensions/` (or `edge://extensions/`)
4. Enable "Developer mode" in the top right
5. Click "Load unpacked"
6. Select the extracted folder

#### Firefox
1. Download `js-eyes-firefox-v1.1.0.xpi`
2. Open Firefox browser
3. Drag and drop the `.xpi` file into the browser window
4. Confirm installation

### What's New
- Improved build and release workflow
- Firefox extension is now officially signed by Mozilla
- All release files are now organized in the `dist/` directory for easier distribution
