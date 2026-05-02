# Codex Autonomous Task Queue V2

## Priority Fixes From Self-Audit

- [x] **V2-1 — Wire health-monitor into /api/health**
  - Expose `{ docker, browser, gateway }` in health payload
  - Ensure probe failures degrade to `down` without throwing

- [x] **V2-2 — Real ToolExecutionLog data binding**
  - Feed tool_start/tool_execution events from `useChatStore` into `ToolExecutionLog`
  - Collapse panel after stream_end; keep manual expand

- [x] **V2-3 — OpenClaw browser tool runtime mapping tests**
  - Validate browser_navigate/screenshot/click/input/scroll/extract_text runtime dispatch

- [x] **V2-4 — File-tools recursive traversal hardening**
  - Add recursive fileList + scoped fileGrep traversal with symlink-safety

- [x] **V2-5 — Deployment verification automation**
  - Add script to post full-file webhook payload and validate response/receipt logging

## Carry-Forward Improvements

- [x] **V2-6 — Quality gate threshold alignment**
  - Update `r121-quality-gate` expected heartbeat/pong constants to current contract or align runtime constants

- [x] **V2-7 — Browser service resiliency**
  - Add reconnect-on-disconnect for puppeteer CDP and per-session page rehydration
