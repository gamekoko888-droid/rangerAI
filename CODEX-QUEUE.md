# Codex Autonomous Task Queue

> **Total estimated time**: 8 hours  
> **Mode**: Full Auto — NO human confirmation needed  
> **Self-loop**: After completing all tasks, run self-audit and generate new tasks

---

## Execution Rules

1. Execute tasks **top-to-bottom** — first unchecked `[ ]` task is your current task
2. After completing a task, mark it `[x]` in this file and commit
3. Deploy each completed task via webhook immediately
4. If a task fails after 3 attempts, mark it `[!]` with error reason, skip to next
5. After ALL tasks done, execute the **Self-Audit Loop** at the bottom
6. NEVER ask for human confirmation — you are fully autonomous

---

## Deploy Command (use after each task)

```bash
curl -X POST https://ranger.voyage/codex-deploy/apply-patch \
  -H "X-Deploy-Secret: ranger-codex-2026" \
  -H "Content-Type: application/json" \
  -d '{"files": { "path/to/file.mjs": "full file content here" }}'
```

For multiple files, include all in the `files` object. Max payload: 5MB.

---

## Phase 1: Foundation (2 hours)

- [ ] **Q1 — Persistent Workspace Manager** (~45 min)
  - Create `agent/worker/workspace-manager.mjs`
  - Manages `/opt/rangerai-agent/workspaces/{sessionKey}/` directories
  - Functions: `getOrCreateWorkspace(sessionKey)`, `listFiles(sessionKey)`, `cleanupStale(maxAgeMs=86400000)`
  - On creation: mkdir -p, set 755 permissions
  - Export: `WORKSPACE_BASE_DIR`, `getOrCreateWorkspace`, `listFiles`, `getWorkspacePath`, `cleanupStale`
  - Validation: import and call `getOrCreateWorkspace('test-123')` should return a valid path

- [ ] **Q2 — Wire Workspace into Sandbox API** (~30 min)
  - Modify `agent/modules/sandbox-api.mjs`
  - Import `getOrCreateWorkspace` from workspace-manager
  - In the Docker exec function: add `-v ${workspacePath}:/workspace -w /workspace` to Docker run command
  - This makes files persist across exec calls within same session
  - Validation: exec `echo hello > test.txt` then exec `cat test.txt` in same session → "hello"

- [ ] **Q3 — File Tools Implementation** (~45 min)
  - Create `agent/worker/tools/file-tools.mjs`
  - Implement 7 functions (all scoped to workspace dir):
    - `fileRead(sessionKey, path, startLine?, endLine?)` → string content
    - `fileWrite(sessionKey, path, content)` → { success, bytesWritten }
    - `fileAppend(sessionKey, path, content)` → { success, bytesWritten }
    - `fileEdit(sessionKey, path, edits[{find, replace, all?}])` → { success, replacements }
    - `fileList(sessionKey, glob?)` → array of { name, size, modified }
    - `fileGrep(sessionKey, regex, scope?)` → array of { file, line, match, context }
    - `fileDelete(sessionKey, path)` → { success }
  - Security: reject paths with `..`, absolute paths, symlinks outside workspace
  - Validation: write a file, read it back, edit it, grep for content — all succeed

---

## Phase 2: Browser Resurrection (2.5 hours)

- [ ] **Q4 — Chromium Systemd Service** (~20 min)
  - Create `agent/scripts/chromium-headless.service` (systemd unit file):
    ```
    [Unit]
    Description=Headless Chromium for RangerAI Browser Tools
    After=network.target
    
    [Service]
    ExecStart=/usr/bin/chromium-browser --headless --no-sandbox --disable-gpu --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
    Restart=always
    RestartSec=5
    MemoryMax=512M
    
    [Install]
    WantedBy=multi-user.target
    ```
  - Deploy this file and document in CODEX-LOG.md that it needs `systemctl enable` on server
  - Validation: file is syntactically correct systemd unit

- [ ] **Q5 — Browser Service Core** (~60 min)
  - Rewrite `agent/worker/browser-service.mjs` (replace the stub)
  - Use `puppeteer-core` connecting to `http://127.0.0.1:9222`
  - Implement:
    - `browserNavigate(url)` → { success, title, text(first 2000 chars), url }
    - `browserScreenshot(sessionId)` → { success, base64png, width, height }
    - `browserExtractText(selector?)` → { success, text }
    - `browserClick(selector)` → { success }
    - `browserInput(selector, text)` → { success }
    - `browserScroll(direction, amount?)` → { success }
  - Connection pool: max 3 pages, Map<sessionId, Page>, 5-min TTL with LRU eviction
  - Error handling: if CDP connection fails, return `{ success: false, error: 'Browser not available', degraded: true }`
  - Import `classifyBrowserFailure` from `browser-failure-taxonomy.mjs` for error classification
  - Validation: `browserNavigate('https://example.com')` returns title "Example Domain"

- [ ] **Q6 — Browser API Route Wiring** (~30 min)
  - Modify `agent/api/browser-api.mjs`
  - Import real functions from new `browser-service.mjs`
  - Ensure existing routes (`POST /api/browser/navigate`, etc.) call real implementations
  - Add auth check: only admin/manager roles can use browser tools
  - Validation: `curl -X POST https://ranger.voyage/api/browser/navigate -d '{"url":"https://example.com"}'` returns real page data

- [ ] **Q7 — Browser Tool Registration in OpenClaw Handler** (~30 min)
  - Modify `agent/worker/openclaw-handler.legacy.mjs`
  - In the tool execution switch/map, add cases for: `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_input`, `browser_scroll`, `browser_extract_text`
  - Each case calls the corresponding function from browser-service.mjs
  - Format results as tool_result messages back to the LLM
  - Validation: In a chat, ask "navigate to example.com and tell me the title" → agent uses browser tool → returns "Example Domain"

---

## Phase 3: Multi-Agent & Parallelism (2 hours)

- [ ] **Q8 — HTTP-Based Sub-Agent Executor** (~45 min)
  - Create `agent/worker/sub-agent-http.mjs`
  - Instead of WS-based sub-agents (which broke Gateway routing), use HTTP:
    - `executeSubAgent(prompt, options)` → makes POST to `http://127.0.0.1:3002/api/chat` with a fresh sessionKey
    - Waits for completion (polling `/api/task-status/{sessionKey}` every 2s, timeout 60s)
    - Returns final assistant message as result
  - Options: `{ timeout: 60000, model: 'auto', maxTokens: 4000 }`
  - Concurrency limit: max 3 simultaneous sub-agents (semaphore)
  - Validation: `executeSubAgent("What is 2+2?")` returns a response containing "4"

- [ ] **Q9 — Parallel Orchestrator (Simplified)** (~45 min)
  - Create `agent/worker/parallel-orchestrator.mjs`
  - Simplified version of archived sub-agent-orchestrator:
    - `orchestrateParallel(tasks[])` → executes up to 3 tasks concurrently via sub-agent-http
    - Each task: `{ prompt, id, dependencies?: string[] }`
    - Dependency resolution: tasks with deps wait for their deps to complete
    - Result aggregation: returns `{ results: Map<id, result>, failed: string[], duration_ms }`
  - No wave scheduling (keep simple) — just Promise.all with concurrency limit
  - Validation: `orchestrateParallel([{id:'a', prompt:'say hello'}, {id:'b', prompt:'say world'}])` → both complete

- [ ] **Q10 — Planner Integration for Parallelism** (~30 min)
  - Modify `agent/worker/planner.mjs`
  - In `generatePlan` or equivalent: when plan has independent steps, mark them `parallel: true`
  - In plan execution: collect parallel steps → call `orchestrateParallel`
  - Detection heuristic: steps that don't reference each other's outputs are independent
  - Keep it conservative: only parallelize if explicitly independent (e.g., "research A" and "research B")
  - Validation: Task "Research Apple and Google stock prices" → planner marks both as parallel → both execute concurrently

---

## Phase 4: UX & Reliability (1.5 hours)

- [ ] **Q11 — Tool Execution Streaming Events** (~30 min)
  - Modify `agent/worker/openclaw-handler.legacy.mjs`
  - After each tool call completes, emit WS event:
    ```json
    { "type": "tool_execution", "tool": "exec", "status": "success", "output": "...", "duration_ms": 123, "timestamp": "..." }
    ```
  - Before tool call starts, emit:
    ```json
    { "type": "tool_start", "tool": "exec", "args_summary": "running: ls -la", "timestamp": "..." }
    ```
  - Limit output in event to 1000 chars (truncate with "... [truncated]")
  - Validation: During task execution, WS client receives tool_start and tool_execution events

- [ ] **Q12 — Frontend Tool Execution Display** (~45 min)
  - Create `web/client/src/components/ToolExecutionLog.tsx`
  - Renders tool_start/tool_execution events in a collapsible "Thinking" section
  - Each tool call shows: icon (terminal for exec, globe for browser, file for write), name, duration, status badge
  - Collapsed by default after task completes, expandable on click
  - Wire into ChatPage: show above assistant message while task is running
  - Use existing WS event infrastructure from useChatStore
  - Validation: During a coding task, user sees "Running: exec..." with spinner, then result appears

- [ ] **Q13 — Degradation Health Monitor** (~15 min)
  - Create `agent/worker/health-monitor.mjs`
  - Checks every 30s: Docker available? Chromium CDP reachable? Gateway WS connected?
  - Exposes: `getHealthStatus()` → `{ docker: 'up'|'down', browser: 'up'|'down', gateway: 'up'|'down' }`
  - Emits event on status change: `{ type: 'health_change', capability, oldStatus, newStatus }`
  - Wire into `/api/health` endpoint (already exists? extend it)
  - Validation: `curl https://ranger.voyage/api/health` returns capability status JSON

---

## Phase 5: Self-Audit & Quality (bonus, if time remains)

- [ ] **Q14 — Integration Test for New Features** (~30 min)
  - Create `agent/tests/integration/q-series.integration.test.mjs`
  - Test cases:
    - Workspace: create → write file → read file → cleanup
    - File tools: write → edit → grep → delete
    - Browser (mock CDP): navigate → extract text
    - Sub-agent HTTP: execute simple prompt → get response
    - Health monitor: returns valid status object
  - Use existing test helpers from `agent/tests/helpers/`
  - Validation: `node --test agent/tests/integration/q-series.integration.test.mjs` passes

- [ ] **Q15 — Update ROADMAP.md with Completed Tasks** (~10 min)
  - Add entries R200-R219 status based on what was actually completed
  - Mark completed Q-series tasks as done
  - Add any discovered issues as new R-series tasks

---

## Self-Audit Loop (execute after all tasks above)

When all tasks above are done (or skipped), execute this self-audit:

### Step 1: Verify Deployments
```bash
curl -s https://ranger.voyage/api/health | jq .
curl -s https://ranger.voyage/api/admin/worker-pool | jq .
```

### Step 2: Run Quality Gate
```bash
# On the server via webhook or direct test
node agent/scripts/r121-quality-gate.mjs
```

### Step 3: Self-Assessment
Read through all files you modified. For each, ask yourself:
- Does this introduce any import errors? (check all import paths exist)
- Does this break any existing functionality? (check no removed exports)
- Are there edge cases not handled? (null checks, timeout handling)

### Step 4: Generate Next Iteration
Based on your self-assessment, create `CODEX-QUEUE-V2.md` with:
- Bug fixes for anything broken in this iteration
- Improvements you noticed were needed while coding
- Next priority tasks from CODEX-TASKBOOK.md (P1 tasks)

Commit and deploy `CODEX-QUEUE-V2.md` so the next Codex session can continue.

---

## Failure Recovery Rules

| Situation | Action |
|-----------|--------|
| Import error after deploy | Fix the import path, redeploy |
| Existing test breaks | Read the test, understand what it expects, fix your code to match |
| Webhook returns 500 | Check file content for syntax errors (run `node --check` mentally) |
| Can't find a file to modify | Use `find` or `grep` in your mental model of the repo structure |
| Task is too complex | Break it into 2 sub-tasks, do the simpler half, mark the complex half as `[!] deferred` |
| Docker/Chromium not installed on server | Create the files anyway, mark task as `[x] code ready, needs server setup` |

---

## Important Context

- **Repo structure**: `agent/` (Node.js ESM, .mjs files) + `web/` (React+TypeScript+Vite)
- **Agent entry**: `agent/bootstrap.mjs` → spawns worker via `agent/modules/worker-pool.mjs`
- **Tool dispatch**: `agent/worker/openclaw-handler.legacy.mjs` is the main agentic loop
- **Config files**: `agent/config/model-routing.json`, `agent/config/role-tool-matrix.json`
- **DB**: MySQL (main) + SQLite (agent state at `/opt/rangerai-agent/db/rangerai.db`)
- **Gateway**: OpenClaw at `http://127.0.0.1:18789`
- **Never modify**: `/opt/openclaw/`, `agent/package.json` start script, `web/server/_core/`, Caddy config, systemd configs, `.env`, `data/`, `*.sqlite`
