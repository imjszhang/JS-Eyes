# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-02-24

> Both Firefox and Chrome extensions are now feature-equivalent for multi-server adaptation.

### Added

- **Server Capability Discovery**: Extension now auto-detects server type and capabilities via `/api/browser/config` endpoint before connecting. Supports both lightweight (`js-eyes/server`) and full-featured (`deepseek-cowork`) server backends.
- **Unified Server URL Entry**: Single `SERVER_URL` config replaces separate `WEBSOCKET_SERVER_URL` and `HTTP_SERVER_URL`. WebSocket address is auto-discovered from the HTTP entry point.
- **`DISCOVERY` Config Block**: New configuration section for capability discovery (endpoint, timeout, fallback behavior).
- **Server Type Display**: Popup UI now shows detected server name/version and supported capabilities (SSE, rate limiting, etc.).
- **Adaptive Authentication**: Auth flow is now fully message-driven. The extension reacts to the server's first message (`auth_challenge` or `auth_result`) instead of guessing with a timeout.
- **Tolerant Health Check Parsing**: `HealthChecker` now accepts HTTP 503 as a valid "critical" health response, and supports multiple response formats (`{ status }`, `{ ok }`, or HTTP-status-based inference).

### Changed

- **Init Flow**: Initialization order changed to `loadSettings → discoverServer → initStabilityTools → listeners → connect`, ensuring HTTP base URL is available before health checker and SSE client are created.
- **Auth Timeout**: Replaced the 10-30s auth timeout (which guessed server type) with a 60s safety-net timeout that only fires if the server sends no message at all.
- **`handleAuthResult`**: Now correctly handles lightweight servers that return `auth_result: success` without a `sessionId` — skips session refresh and uses `sendRawMessage` for init.
- **Config Sync**: `syncServerConfig()` first uses cached discovery data before making a separate HTTP request.
- **Reconnect Flow**: `reconnectWithNewSettings()` now re-runs `discoverServer()` and updates health checker / SSE client addresses.
- **Popup Presets**: Preset server addresses updated to HTTP format (`http://localhost:18080`, `http://localhost:3000`).
- **Popup Server Input**: Now accepts `http://`, `https://`, `ws://`, and `wss://` protocols.

### Removed

- **`HTTP_SERVER_URL` Config**: Removed in favor of `SERVER_URL` + auto-discovery.
- **`WEBSOCKET_SERVER_URL` Config**: Removed (single entry merged into `SERVER_URL`).
- **Hardcoded `localhost:3333` Fallbacks**: Eliminated from `HealthChecker` and `SSEClient` constructors.

### Fixed

- **Health Check 503 Handling**: Servers returning HTTP 503 for "critical" status no longer trigger connection failures or circuit breaker false positives.
- **SSE False Activation**: SSE fallback is now conditionally enabled only when the server explicitly supports it, preventing errors against lightweight servers.
- **Port Mismatch Prevention**: Unified URL entry eliminates the class of bugs where HTTP and WS ports are configured inconsistently.

## [1.3.5] - 2026-01-26

### Added

- HMAC-SHA256 authentication support
- Session management with auto-refresh
- Health checker with circuit breaker protection
- SSE fallback for WebSocket failures
- Rate limiting and request deduplication
- Request queue management
- Content Script relay communication mode
- Security configuration (action whitelist, sensitive operation checks)
- Application-level heartbeat (ping/pong)
- Connection instance tracking to prevent orphan connections

## [1.3.3] - Previous

- Initial public release with core browser automation features
