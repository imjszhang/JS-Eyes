# Security and Network Behavior

## Overview

JS Eyes is a **local-first** browser automation skill. It does not contact any external APIs, analytics, or third-party services. All network communication is limited to endpoints **you** configure (localhost or your own server).

## Why VirusTotal May Flag This Skill

Static analysis tools (including VirusTotal Code Insight) often flag code that:

- Uses `fetch()` or `WebSocket` (common in both legitimate automation and malware)
- Builds URLs dynamically (e.g. `http://${host}:${port}/api/...`)
- Exposes an “API” surface

In this project, those patterns are used **only** to talk to a **user-configured** JS-Eyes server (default `localhost:18080`). There are no hardcoded external domains, no telemetry, and no call-home behavior.

## What This Skill Does (Network-Wise)

| Component        | Network behavior |
|-----------------|------------------|
| OpenClaw plugin | Connects via WebSocket to `serverHost:serverPort` (default `localhost:18080`). Uses `fetch()` only for local HTTP endpoints like `/api/browser/status` and `/api/browser/tabs`. |
| Client SDK      | Connects via WebSocket to the URL you pass (e.g. `ws://localhost:18080`). |
| Server          | Listens on a single HTTP+WebSocket port; does not initiate outbound connections. |

All of the above use **localhost** or the host/port you set in OpenClaw plugin config. No data is sent to the internet unless you explicitly point the extension or client at a remote server you control.

## If ClawHub Shows a VirusTotal Warning

- **Install with confidence (same as before):** You can use `clawhub install js-eyes --force` when you understand that the warning is due to the patterns above, not malicious behavior.
- **Report a false positive:** VirusTotal aggregates results from many vendors. To report a false positive, use the [VirusTotal false positive process](https://docs.virustotal.com/docs/false-positive): identify the vendor(s) that flagged the file from your VirusTotal report and contact them directly.
- **Ask OpenClaw/ClawHub:** If you maintain or use the ClawHub pipeline, you can ask OpenClaw maintainers whether they support manual review or whitelisting for known-good skills like js-eyes.

## Dependencies

- **Runtime:** Only `ws` (WebSocket library) is required in the skill bundle. It is used for local WebSocket communication only.
- **Excluded from ClawHub bundle:** Browser extensions (`chrome-extension/`, `firefox-extension/`), CLI, tests, and docs are not part of the skill package (see `.clawhubignore`). Code that references external URLs (e.g. GitHub API, Cloudflare) lives only in those excluded paths and is **not** shipped to ClawHub.

---

*Last updated: 2025-02 — for js-eyes skill bundle as distributed via ClawHub.*
