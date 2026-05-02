# CODEX-QUEUE.md — Task Queue (Updated after manual landing)

> **Status**: Round 1 partially completed. Q1,Q3,Q5,Q8+Q9,Q13 landed via manual webhook push.
> **Next**: Codex should start from the first `[ ]` task.

---

## Completed Tasks (landed in production)

- [x] **Q1 — Persistent Workspace Manager** ✅ (Codex commit c736cb7)
- [x] **Q3 — File Tools Implementation** ✅ (Manual deploy via webhook)
- [x] **Q5 — Browser Service Core** ✅ (Restored from archive, 785 lines)
- [x] **Q8+Q9 — Sub-Agent Orchestrator** ✅ (Restored from archive, 831 lines)
- [x] **Q13 — Degradation Health Monitor** ✅ (Manual deploy via webhook)
- [x] **R111 — WS Heartbeat Module** ✅ (New module ws-heartbeat.mjs)

## Remaining Tasks (for Codex to execute)

- [ ] **Q2 — Wire Workspace into Sandbox API** (~30 min)
  - File: `agent/modules/sandbox-api.mjs`
  - Goal: Mount `getOrCreateWorkspace(sessionKey)` as Docker volume at `/workspace`
  - Import `{ getOrCreateWorkspace }` from `../worker/workspace-manager.mjs`
  - Add `-v ${workspacePath}:/workspace:rw` to Docker run command

- [ ] **Q4 — Chromium Systemd Service** (~20 min)
  - File: `agent/scripts/chromium-headless.service`
  - Goal: Create systemd unit file for headless Chromium on port 9222
  - Note: Chromium is already running on the server, this formalizes it

- [ ] **Q6 — Browser API Route Wiring** (~30 min)
  - File: `agent/modules/routes/admin-routes.mjs`
  - Goal: Add POST /api/admin/browser/{navigate,screenshot,extract,click} endpoints
  - Import browser functions from `../../worker/browser-service.mjs`
  - Gate behind admin/manager role check

- [ ] **Q7 — Browser Tool Registration in OpenClaw Handler** (~30 min)
  - File: `agent/worker/openclaw-handler.legacy.mjs`
  - Goal: Wire browser tool calls to actual browser-service functions
  - Currently the handler logs browser results but doesn't call browser-service
  - Add import and dispatch for browser_navigate, browser_screenshot, etc.

- [ ] **Q10 — Planner Integration for Parallelism** (~30 min)
  - File: `agent/worker/planner.mjs`
  - Goal: When plan has independent steps, call `shouldParallelize()` from sub-agent-orchestrator
  - If parallelizable, use `handleParallelWave()` instead of sequential execution

- [ ] **Q11 — Tool Execution Streaming Events** (~30 min)
  - File: `agent/worker/event-stream.mjs`
  - Goal: Emit granular events: tool_start, tool_progress, tool_end, tool_error
  - Wire into the tool execution loop in openclaw-handler

- [ ] **Q12 — Frontend Tool Execution Display** (~45 min)
  - File: `web/client/src/components/ToolExecutionLog.tsx`
  - Goal: React component showing real-time tool execution with status icons
  - Subscribe to WS events: tool_start → spinner, tool_end → checkmark, tool_error → X

- [ ] **Q14 — Integration Test for New Features** (~30 min)
  - File: `agent/tests/integration-q-series.test.mjs`
  - Goal: Test browser-service, file-tools, workspace-manager, health-monitor
  - Verify imports resolve, functions return expected shapes

- [ ] **Q15 — Update ROADMAP.md with Completed Tasks** (~10 min)
  - File: `ROADMAP.md`
  - Goal: Add Q-series tasks to ROADMAP, mark completed ones [x]
