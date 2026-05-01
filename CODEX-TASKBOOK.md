# CODEX TASK BOOK — Ranger vs Manus Hell-Level Gap Analysis

> **Generated**: 2026-05-02  
> **Scope**: Full-stack audit of 353 agent files (92K LOC) + 273 web files (72K LOC)  
> **Benchmark**: Manus AI Agent (production-grade, millions of users)  
> **Verdict**: Ranger scores **4.2 / 10** against Manus. Functional skeleton exists but critical production capabilities are missing or stubbed.

---

## Executive Summary

Ranger has built an impressive *architectural skeleton* — smart routing, RAG, observability, role-based permissions, task planning, and a rich admin dashboard. However, when measured against Manus's production capabilities, the gaps are **severe and systemic**:

1. **Browser automation is DEAD** — archived to a stub, zero real capability
2. **Multi-agent orchestration is DEAD** — archived, never integrated into production path
3. **Worker pool is hardcoded to 1** — zero parallelism, zero scalability
4. **Sandbox is Docker-only with no fallback** — Docker not running = code execution disabled
5. **Context window management is primitive** — no sliding window, no priority-based retention
6. **No file system operations** — no persistent workspace per conversation
7. **No streaming UX** — WebSocket exists but no tool-use streaming, no progress artifacts
8. **Frontend is admin-heavy, user-facing UX is thin** — 40+ admin pages but the chat UX lacks Manus-level polish
9. **No plugin/extension system** — tools are hardcoded, no marketplace
10. **No voice I/O pipeline** — transcription helper exists but no end-to-end voice flow

---

## Dimension-by-Dimension Comparison

### 1. Multi-Agent Orchestration

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Sub-agent spawning | Production: `map()` spawns 2000+ parallel subtasks | **ARCHIVED** — `sub-agent-orchestrator.mjs` moved to dead-code | **CRITICAL** |
| Parallel execution | True parallel with result aggregation | Worker pool forced to 1 (HOTFIX comment in code) | **CRITICAL** |
| Agent specialization | Debugging agent, research agent, coding agent | Single monolithic worker handles everything | **SEVERE** |
| Result merging | Structured CSV/JSON output schema per subtask | `sub-agent-compactor.mjs` exists but orchestrator is dead | **CRITICAL** |
| Wave-based scheduling | N/A (uses pool.map pattern) | Designed but never activated (safety classifier exists) | **SEVERE** |

**Root Cause**: The sub-agent orchestrator was archived because Gateway WS event routing couldn't handle multiple concurrent sessions. This is a **Gateway architecture limitation**, not a Ranger code problem.

### 2. Browser Automation

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Page navigation | Full Chromium with annotated screenshots | **STUB** — returns `{ success: false, error: 'not available' }` | **CRITICAL** |
| Element interaction | Click, input, scroll, select, form fill by index | Archived puppeteer-core code (was CDP port 9222) | **CRITICAL** |
| Screenshot analysis | Numbered bounding boxes + multimodal understanding | Had screenshot capability, now dead | **CRITICAL** |
| Session persistence | Login state persists across tasks | Never implemented | **CRITICAL** |
| File download | Automatic to /Downloads/ | Never implemented | **CRITICAL** |
| Cookie injection | Automatic via browser profile | `browser-cookie-injector.py` exists (Python script, not integrated) | **SEVERE** |

**Root Cause**: Browser service was archived on 2026-05-01 (yesterday!). The puppeteer-core implementation existed but was apparently unstable or resource-heavy on the single-server deployment.

### 3. Code Execution Sandbox

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Isolation | Full VM sandbox per task (Ubuntu 22.04) | Docker containers (python:3.11-slim, node:22-alpine, ubuntu:22.04) | **MODERATE** |
| Availability | Always available | `dockerAvailable = false` if Docker daemon not running → **DISABLED** | **SEVERE** |
| Persistent workspace | Files persist across tool calls within a task | `/tmp/rangerai-sandbox` — ephemeral, no cross-call persistence | **SEVERE** |
| Pre-installed tools | bc, curl, git, python, node, pip, etc. | Only what's in Docker image | **MODERATE** |
| Output limit | Unlimited (redirected to files) | 8000 chars max (`MAX_OUTPUT`) | **MODERATE** |
| Role-based limits | N/A (single user per sandbox) | Tier system: admin=128MB/30s, operator=64MB/10s, viewer=denied | **OK** (good design) |
| Internet access | Full internet in sandbox | Docker `--network=none` (implied by security model) | **SEVERE** |

**Root Cause**: Docker dependency creates a single point of failure. If Docker daemon crashes or isn't installed, ALL code execution is disabled with no fallback (native fallback was intentionally removed for security).

### 4. Context Window Management

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Compression strategy | Multi-level: sliding window + priority retention + structured summary | Two-level: microCompact (truncation) + autoCompact (LLM summary) | **MODERATE** |
| Trigger thresholds | Dynamic based on model context size | Fixed: 20 messages → micro, 35 → auto | **MODERATE** |
| Anchor system | Implicit via task plan phases | Explicit anchor detection (`detectAnchorCandidate`) — good design | **OK** |
| Cold/hot classification | Implicit | `classifyMessages` + `buildLayeredContext` + `updateColdSummary` | **OK** |
| Tool output handling | Automatic truncation + file redirect | `MICRO_COMPACT_TOOL_MAX_CHARS: 2000` truncation | **MODERATE** |
| KV-cache awareness | N/A (API-based) | KV-cache hit rate tracking (86.7% observed) | **GOOD** (Ranger advantage) |

**Assessment**: Context management is one of Ranger's **stronger areas**. The two-level pipeline with anchor detection is architecturally sound. Gap is in the fixed thresholds and lack of model-aware dynamic sizing.

### 5. Tool Ecosystem

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Total tools available | 20+ (shell, file, search, browser, generate, slides, map, schedule, etc.) | ~15 in role-tool-matrix (read, write, exec, media, agent, admin groups) | **MODERATE** |
| Search integration | Multi-type: info, image, api, news, tool, data, research | `web_search` + `web_fetch` (single search type) | **SEVERE** |
| Image generation | Built-in AI generation + editing | `generate_image` tool exists (Gemini routing) | **MODERATE** |
| File operations | Full CRUD + glob + grep with regex | `read_file`, `write_file`, `edit_file` | **MODERATE** |
| Scheduling | Cron + interval with full agent execution | Not implemented | **SEVERE** |
| Slides/presentations | Full slide generation system | Not implemented | **MODERATE** |
| Voice I/O | Speech-to-text + text-to-speech | `speak_text`, `transcribe_audio` in tool matrix (implementation unclear) | **MODERATE** |
| Map integration | Google Maps with full API | Not implemented | **LOW** |
| Data visualization | Matplotlib, Plotly, Seaborn in sandbox | Not implemented (relies on frontend charts) | **MODERATE** |

### 6. Streaming & Real-Time UX

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Token streaming | Real-time token-by-token to UI | WebSocket event streaming (chunk-based) | **OK** |
| Tool execution visibility | Live tool calls shown with progress | Events emitted but frontend rendering unclear | **MODERATE** |
| Artifact streaming | Code, files, images appear progressively | Not implemented | **SEVERE** |
| Progress indicators | Phase-based with estimated completion | `progress-tracker.mjs` exists | **OK** |
| Workspace panel | Live file tree, terminal, browser preview | Not implemented (chat-only UI) | **CRITICAL** |

### 7. Security Model

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Role-based access | Owner/admin binary | 5-role matrix (admin/manager/member/cs/viewer) | **GOOD** (Ranger advantage) |
| Tool approval gate | Implicit (user confirms sensitive ops) | `human-approval.mjs` with high-risk tool confirmation | **GOOD** (Ranger advantage) |
| Command deny-list | Implicit in sandbox isolation | R120: explicit deny-list for dangerous commands | **OK** |
| Rate limiting | Platform-level | R113: IP-level 60 req/min on /api/chat | **OK** |
| Sandbox isolation | VM-level | Docker-level (when available) | **MODERATE** |
| Secret management | Platform-injected env vars | `.env` file + systemd drop-in overrides | **OK** |

**Assessment**: Security is another **strong area** for Ranger. The 5-role permission matrix with tool groups is more granular than Manus's binary model.

### 8. Scalability

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Concurrent users | Distributed infrastructure, unlimited | **Single worker, capacity=3 tasks** | **CRITICAL** |
| Horizontal scaling | Auto-scaling cloud infrastructure | Single VPS (ranger.voyage) | **CRITICAL** |
| Database | Managed cloud DB | MySQL (Docker) + SQLite (agent state) — dual DB complexity | **SEVERE** |
| Worker pool | N/A (serverless functions) | `poolSize = 1` (HOTFIX hardcoded) | **CRITICAL** |
| Gateway | N/A | OpenClaw Gateway (single instance, port 18789) | **SEVERE** |

### 9. Frontend Polish

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| Chat UX | Rich: markdown, code blocks, file previews, artifact panels | Basic chat with streaming | **SEVERE** |
| Workspace panel | Split view: chat + live preview/terminal/files | Chat-only (no workspace concept) | **CRITICAL** |
| Mobile responsive | Full responsive design | Unknown (likely desktop-only given admin focus) | **MODERATE** |
| Admin tooling | Minimal (management UI) | **40+ pages** — CEO dashboard, KOL manager, TikTok, inventory, etc. | **GOOD** (Ranger advantage) |
| Onboarding | Guided first-use experience | Login + direct to chat | **MODERATE** |
| Error states | Graceful degradation with retry | R114: ErrorBoundary + toast (implemented) | **OK** |

### 10. Knowledge & Memory

| Aspect | Manus | Ranger | Gap Severity |
|--------|-------|--------|--------------|
| RAG pipeline | Implicit (skills system + search) | Explicit: KnowledgeModule with circuit breaker, budget, dedup, top-5 | **OK** |
| Long-term memory | Cross-session via skills and project state | `memory_search`, `memory_get` in tool matrix | **MODERATE** |
| Knowledge CRUD | Skills directory with SKILL.md | R23-T4: Knowledge entries API + KnowledgeTab frontend | **OK** |
| Source reliability | N/A | R119: reliability scoring + freshness + conflict penalty | **GOOD** (Ranger advantage) |
| Embedding model | Platform-managed | Not visible in audit (likely via Gateway) | **UNKNOWN** |

---

## Overall Scoring

| Dimension | Score (0-10) | Weight | Weighted |
|-----------|-------------|--------|----------|
| Multi-Agent Orchestration | 1 | 15% | 0.15 |
| Browser Automation | 0 | 15% | 0.00 |
| Code Sandbox | 4 | 12% | 0.48 |
| Context Management | 7 | 8% | 0.56 |
| Tool Ecosystem | 5 | 12% | 0.60 |
| Streaming UX | 4 | 10% | 0.40 |
| Security Model | 8 | 5% | 0.40 |
| Scalability | 1 | 10% | 0.10 |
| Frontend Polish | 5 | 8% | 0.40 |
| Knowledge/Memory | 7 | 5% | 0.35 |
| **TOTAL** | | **100%** | **3.44 / 10** |

> **Honest verdict**: Ranger is a well-architected prototype with strong internal tooling, but it is **not production-ready as a general AI agent**. The three critical gaps (browser=dead, multi-agent=dead, scalability=1 worker) make it fundamentally unable to compete with Manus on capability breadth.

---

## Critical Path to Parity

The following tasks are ordered by **impact × feasibility**. Tasks R200-R219 represent the "minimum viable parity" sprint.

---

## R200 — Resurrect Browser Service (Headless Chrome)

- **文件**: `agent/worker/browser-service.mjs` (replace stub), `agent/api/browser-api.mjs`
- **目标**: Restore browser automation using puppeteer-core connecting to a persistent Chromium instance (not per-request launch). Implement: navigate, screenshot (with element annotations), click, input, scroll, extract_text.
- **具体步骤**:
  1. Install `puppeteer-core` (already in package.json from archive era)
  2. Launch Chromium via systemd service (`chromium --headless --remote-debugging-port=9222 --no-sandbox`)
  3. Replace stub functions with real implementations from `archive/dead-code-20260501/browser-service.mjs`
  4. Add connection pooling: max 3 pages, 5-min TTL per page, LRU eviction
  5. Add screenshot annotation: number visible interactive elements with bounding boxes
  6. Add retry logic (already designed in archive: `BROWSER_MAX_RETRIES = 2`)
  7. Wire into `openclaw-handler` tool dispatch loop
- **验证**: `curl -X POST https://ranger.voyage/api/browser/navigate -d '{"url":"https://example.com"}' -H 'Authorization: Bearer ...'` returns `{ success: true, title: "Example Domain", text: "..." }`
- **约束**: No native Chrome install on host (use `chromium-browser` from apt); max 512MB memory for browser process; must not block agent event loop
- **优先级**: P0 — without browser, Ranger cannot do web research, form filling, or any browser-based task

---

## R201 — Resurrect Multi-Agent Orchestration

- **文件**: `agent/worker/sub-agent-orchestrator.mjs` (move from archive back to worker/), `agent/worker/openclaw-handler.legacy.mjs`
- **目标**: Re-enable parallel sub-agent execution. The archived code is well-designed (wave scheduling, safety classification, failure recovery). The blocker was Gateway WS routing — solve by using HTTP-based sub-agent calls instead of WS.
- **具体步骤**:
  1. Copy `archive/dead-code-20260501/sub-agent-orchestrator.mjs` back to `agent/worker/`
  2. Modify `orchestrateWave` to use HTTP POST to `/api/chat` instead of WS session spawn
  3. Each sub-agent gets its own `sessionKey` (UUID), runs synchronously via HTTP
  4. Implement `collectAndMerge`: aggregate sub-agent results into structured JSON
  5. Add to `openclaw-handler`: when planner detects parallelizable steps, call `orchestrateWave`
  6. Limit: max 3 concurrent sub-agents (matches worker capacity)
- **验证**: Send a task like "Research 3 companies and compare them" → observe 3 parallel HTTP calls → merged result returned to user
- **约束**: Do NOT modify Gateway code; use HTTP API as the sub-agent transport; each sub-agent limited to 60s timeout
- **优先级**: P0 — parallel execution is table-stakes for complex tasks

---

## R202 — Unlock Worker Pool (Remove HOTFIX)

- **文件**: `agent/modules/worker-pool.mjs`
- **目标**: Remove the `this.poolSize = 1` HOTFIX and implement proper multi-worker with Gateway session routing.
- **具体步骤**:
  1. Change `this.poolSize = 1` to `this.poolSize = parseInt(process.env.POOL_SIZE || opts.poolSize || 2, 10)`
  2. Implement session-to-worker affinity via `sessionAffinity` Map (already designed)
  3. Add worker health check: if a worker hasn't responded in 60s, mark degraded
  4. Add graceful worker restart: drain tasks → kill → respawn
  5. Add pool-level metrics: tasks/worker, queue depth, wait time
  6. Set initial production value: `POOL_SIZE=2` (conservative start)
- **验证**: `GET /api/admin/worker-pool` returns `{ poolSize: 2, workers: [{tasks: 1}, {tasks: 0}] }`
- **约束**: Must maintain backward compatibility with single-worker behavior; Gateway WS routing must be tested with 2 workers before increasing further
- **优先级**: P1 — enables R201 and general throughput improvement

---

## R203 — Persistent Conversation Workspace

- **文件**: New file `agent/worker/workspace-manager.mjs`, modify `agent/modules/sandbox-api.mjs`
- **目标**: Each conversation gets a persistent workspace directory that survives across tool calls. Files created in one tool call are accessible in the next.
- **具体步骤**:
  1. Create `workspace-manager.mjs`: manages `/opt/rangerai-agent/workspaces/{sessionKey}/`
  2. On first tool call in a session, create workspace dir
  3. Mount workspace into Docker containers: `-v /opt/rangerai-agent/workspaces/{sessionKey}:/workspace`
  4. Set working directory in Docker to `/workspace`
  5. Add cleanup: workspaces older than 24h are archived to `/opt/rangerai-agent/workspaces-archive/`
  6. Add `list_files` tool that returns workspace contents
  7. Add workspace size limit: 100MB per session
- **验证**: Execute `write_file("test.py", "print('hello')")` then `exec("python test.py")` in same session → output "hello"
- **约束**: Do not store workspace in SQLite; use filesystem only; respect disk space (cleanup cron)
- **优先级**: P0 — without persistent workspace, multi-step coding tasks are impossible

---

## R204 — Docker Daemon Reliability + Fallback

- **文件**: `agent/modules/sandbox-api.mjs`, new file `agent/scripts/ensure-docker.sh`
- **目标**: Ensure Docker is always available. Add systemd watchdog for Docker daemon. If Docker is truly unavailable, provide a degraded-mode native sandbox with strict resource limits.
- **具体步骤**:
  1. Create `ensure-docker.sh`: checks Docker health, restarts if needed, alerts if failed
  2. Add to crontab: `*/5 * * * * /opt/rangerai-agent/scripts/ensure-docker.sh`
  3. In `sandbox-api.mjs`: if Docker unavailable, use `child_process.spawn` with:
     - `ulimit -v 131072` (128MB virtual memory)
     - `timeout 30` prefix
     - `nice -n 19` (lowest priority)
     - Chroot to workspace dir (if available)
  4. Log degraded-mode usage for monitoring
  5. Add `/api/admin/sandbox-status` endpoint
- **验证**: `systemctl stop docker && curl /api/sandbox/exec -d '{"code":"echo hi","lang":"bash"}'` returns `{ success: true, output: "hi", mode: "degraded" }`
- **约束**: Native fallback is ONLY for admin/manager roles; member/cs/viewer still denied in degraded mode
- **优先级**: P1 — eliminates single point of failure

---

## R205 — Rich Search Tool (Multi-Type)

- **文件**: New file `agent/worker/tools/search-tool.mjs`, modify tool dispatch
- **目标**: Implement Manus-style multi-type search: info, news, image, api, research, data. Currently Ranger only has generic `web_search` and `web_fetch`.
- **具体步骤**:
  1. Create `search-tool.mjs` with search type routing:
     - `info` → DuckDuckGo API + Brave Search API
     - `news` → NewsAPI or Google News RSS
     - `image` → Unsplash API + Google Images scrape
     - `research` → Semantic Scholar API + arXiv API
     - `data` → data.gov API + Kaggle datasets API
  2. Each search returns structured results: title, url, snippet, source, date
  3. Add query expansion: user query → 3 variant queries for broader coverage
  4. Add result deduplication by URL
  5. Wire into tool dispatch as `enhanced_search` tool
- **验证**: `enhanced_search({ type: "research", query: "transformer attention mechanism" })` returns 5+ academic papers with titles, authors, URLs
- **约束**: No paid API keys required (use free tiers); cache results for 1 hour; max 10 results per query
- **优先级**: P1 — dramatically improves research capability

---

## R206 — Artifact Streaming & Workspace Panel (Frontend)

- **文件**: `web/client/src/pages/ChatPage.tsx`, new components in `web/client/src/components/workspace/`
- **目标**: Add a split-panel workspace view (like Manus) that shows: file tree, code editor, terminal output, and browser preview — all updating in real-time as the agent works.
- **具体步骤**:
  1. Create `WorkspacePanel.tsx`: resizable split panel (chat left, workspace right)
  2. Create `FileTree.tsx`: shows workspace files, updates via WS events
  3. Create `CodeViewer.tsx`: syntax-highlighted file viewer (read-only)
  4. Create `TerminalOutput.tsx`: shows exec tool outputs in terminal style
  5. Create `BrowserPreview.tsx`: shows screenshots from browser tool
  6. Add WS event types: `workspace_file_created`, `workspace_file_updated`, `exec_output`, `browser_screenshot`
  7. Add toggle: users can collapse workspace panel for chat-only mode
- **验证**: During a coding task, workspace panel shows files being created/modified in real-time; terminal shows command outputs; clicking a file shows its content
- **约束**: Mobile: hide workspace panel entirely (chat-only); Desktop: default 60/40 split; panel state persisted in localStorage
- **优先级**: P1 — transforms UX from "chatbot" to "AI workspace"

---

## R207 — Scheduled Task Execution

- **文件**: New file `agent/modules/scheduler.mjs`, new API endpoint
- **目标**: Allow users to schedule recurring tasks (cron-based or interval-based). Each execution spawns a fresh agent session.
- **具体步骤**:
  1. Create `scheduler.mjs`: cron parser + job queue (use `node-cron` package)
  2. Store schedules in MySQL: `scheduled_tasks` table (id, user_id, cron_expr, prompt, enabled, last_run, next_run)
  3. On trigger: create new session via `/api/chat` with the stored prompt
  4. Add API: `POST /api/schedules` (create), `GET /api/schedules` (list), `DELETE /api/schedules/:id`
  5. Add frontend: `ScheduledTasks.tsx` page with create/edit/delete/toggle UI
  6. Limit: max 10 schedules per user, minimum interval 5 minutes
- **验证**: Create schedule "每天早上9点总结昨日新闻" → next day at 9:00 a new chat session appears with news summary
- **约束**: Schedules survive service restart (persisted in MySQL); failed executions logged but don't disable the schedule
- **优先级**: P2 — nice-to-have for automation use cases

---

## R208 — Tool Output Streaming (Real-Time Artifacts)

- **文件**: `agent/worker/openclaw-handler.legacy.mjs`, `agent/ws-realtime.mjs`, `web/client/src/hooks/useChatStore.tsx`
- **目标**: Stream tool execution results to the frontend in real-time instead of waiting for the full response. Show code being written line-by-line, search results appearing one-by-one, etc.
- **具体步骤**:
  1. In `openclaw-handler`: after each tool call completes, emit `tool_result` event via WS
  2. Event format: `{ type: "tool_result", tool: "exec", status: "success", output: "...", duration_ms: 123 }`
  3. In frontend: render tool results in a collapsible "thinking" section above the assistant message
  4. For `exec` tool: stream stdout line-by-line (pipe child process stdout to WS)
  5. For `write_file`: show file creation with syntax highlighting
  6. For `web_search`: show results appearing progressively
  7. Add "Show thinking" toggle (default: collapsed after completion)
- **验证**: During task execution, user sees real-time tool calls with outputs; after completion, thinking section is collapsed but expandable
- **约束**: Don't send more than 50 events/second to frontend (batch if needed); large outputs (>4KB) truncated with "show more" link
- **优先级**: P1 — critical for user trust and transparency

---

## R209 — Dynamic Context Window Sizing

- **文件**: `agent/worker/context-compressor.mjs`, `agent/worker/agent-config.mjs`
- **目标**: Replace fixed message thresholds (20/35) with model-aware dynamic sizing. Different models have different context windows — compression should adapt.
- **具体步骤**:
  1. Add model context sizes to `model-routing.json`: `{ "contextWindows": { "deepseek/deepseek-v4-pro": 128000, "openai/gpt-5.5": 256000 } }`
  2. In `context-compressor.mjs`: calculate actual token usage ratio instead of message count
  3. microCompact triggers at 60% of model's context window
  4. autoCompact triggers at 80% of model's context window
  5. Add token estimation: `estimateTokens(messages)` using tiktoken-compatible counter
  6. Keep message-count as fallback if token estimation fails
  7. Log compression decisions with model name and actual usage ratio
- **验证**: With GPT-5.5 (256K context), compression triggers later than with DeepSeek-v4-pro (128K context)
- **约束**: Token estimation must be fast (<10ms for 100 messages); don't add tiktoken as dependency (use char-based estimation: chars/4)
- **优先级**: P2 — improves quality but not blocking

---

## R210 — Conversation Memory Persistence

- **文件**: New file `agent/worker/memory-store.mjs`, modify `agent/worker/knowledge-module.mjs`
- **目标**: Implement cross-session memory. Key facts, user preferences, and task outcomes should persist and be retrievable in future conversations.
- **具体步骤**:
  1. Create MySQL table: `memory_entries` (id, user_id, category, content, embedding_hash, relevance_score, created_at, last_accessed)
  2. Categories: `fact`, `preference`, `outcome`, `entity`, `instruction`
  3. After each conversation: extract key facts via LLM call ("What should I remember from this conversation?")
  4. On new conversation start: query top-5 relevant memories and inject into system prompt
  5. Add memory management API: `GET /api/memory`, `DELETE /api/memory/:id`
  6. Add frontend: memory viewer in settings (user can see/delete what the agent remembers)
  7. Dedup: if new memory is >90% similar to existing, update instead of insert
- **验证**: Tell agent "我喜欢用 TypeScript" in session 1 → in session 2, agent defaults to TypeScript without being told
- **约束**: Max 100 memories per user; oldest/least-accessed evicted when limit reached; no embedding model required (use keyword matching for MVP)
- **优先级**: P2 — significant UX improvement for returning users

---

## R211 — Gateway Session Multiplexing

- **文件**: `agent/worker/worker-manager.mjs`, `agent/modules/gateway-connector.mjs` (or equivalent)
- **目标**: The HOTFIX that forced poolSize=1 was due to Gateway WS event routing. Fix the root cause: implement session-tagged events so multiple workers can share one Gateway connection.
- **具体步骤**:
  1. Add `sessionKey` field to all Gateway WS messages (outgoing and incoming)
  2. In Gateway connector: maintain a Map of `sessionKey → callback`
  3. When Gateway sends an event, route to correct worker based on `sessionKey`
  4. If Gateway doesn't support session tagging: use multiple Gateway connections (one per worker)
  5. Add connection health monitoring: reconnect if no heartbeat in 60s
  6. Test with poolSize=2: verify events route to correct worker
- **验证**: Two concurrent tasks on different workers both receive their own events correctly (no cross-talk)
- **约束**: Do NOT modify OpenClaw Gateway code (it's a separate repo/process); work within the connector layer only
- **优先级**: P0 — prerequisite for R202 (unlocking worker pool)

---

## R212 — File Operations Tool Suite

- **文件**: New file `agent/worker/tools/file-tools.mjs`
- **目标**: Implement Manus-level file operations: view (multimodal), read (with line ranges), write, append, edit (find/replace), glob, grep.
- **具体步骤**:
  1. `file_read(path, range?)`: read file with optional line range [start, end]
  2. `file_write(path, content)`: overwrite file (create if not exists)
  3. `file_append(path, content)`: append to file
  4. `file_edit(path, edits[])`: sequential find/replace operations
  5. `file_view(path)`: for images/PDFs, return base64 or description
  6. `file_glob(pattern)`: find files matching glob pattern
  7. `file_grep(pattern, scope)`: regex search across files
  8. All operations scoped to workspace dir (no escape to system files)
  9. Add path validation: reject `../`, absolute paths outside workspace, symlinks
- **验证**: `file_edit("/workspace/app.js", [{ find: "console.log", replace: "logger.info", all: true }])` modifies all occurrences
- **约束**: Max file size for read: 1MB; max file size for write: 5MB; binary files rejected for read/write (use view only)
- **优先级**: P1 — essential for any coding task

---

## R213 — Structured Plan Display (Frontend)

- **文件**: `web/client/src/components/PlanDisplay.tsx` (new), modify `ChatPage.tsx`
- **目标**: Show the agent's task plan as a visual progress tracker (like Manus's phase display). Currently plan exists in backend but frontend doesn't render it.
- **具体步骤**:
  1. Create `PlanDisplay.tsx`: vertical stepper showing plan phases
  2. Each phase shows: title, status (pending/active/complete/failed), duration
  3. Active phase pulses with animation
  4. Completed phases show green checkmark
  5. Failed phases show red X with error summary
  6. Wire to existing `plan_update` WS events from backend
  7. Position: above chat messages, collapsible
- **验证**: During a multi-step task, plan display shows phases progressing in real-time
- **约束**: Must not break existing chat layout; plan display is optional (hidden for simple Q&A tasks)
- **优先级**: P2 — improves transparency and user trust

---

## R214 — Voice Input/Output Pipeline

- **文件**: New files `web/client/src/components/VoiceInput.tsx`, `agent/worker/tools/voice-tools.mjs`
- **目标**: End-to-end voice: user speaks → transcribed → agent processes → response spoken back. Currently only transcription helper exists server-side.
- **具体步骤**:
  1. Frontend: `VoiceInput.tsx` with MediaRecorder API, push-to-talk button
  2. Upload audio to server via `/api/voice/transcribe`
  3. Server: call existing `transcribeAudio` helper (Whisper API)
  4. Feed transcription into normal chat flow
  5. For TTS response: use `speak_text` tool or dedicated TTS endpoint
  6. Frontend: `AudioPlayer.tsx` for playing TTS responses
  7. Add voice mode toggle in chat input area
- **验证**: User holds mic button, speaks "今天天气怎么样", releases → transcription appears as user message → agent responds with text + audio
- **约束**: Max audio duration: 60s; supported formats: webm, mp3, wav; TTS only for final response (not intermediate thinking)
- **优先级**: P3 — nice-to-have, not critical for parity

---

## R215 — Plugin/Extension System

- **文件**: New directory `agent/plugins/`, new file `agent/modules/plugin-loader.mjs`
- **目标**: Allow adding new tools without modifying core code. Each plugin is a directory with a manifest and handler function.
- **具体步骤**:
  1. Plugin structure: `agent/plugins/{name}/manifest.json` + `handler.mjs`
  2. Manifest: `{ name, version, description, tools: [{ name, description, parameters }] }`
  3. `plugin-loader.mjs`: scans plugins dir at startup, registers tools into dispatch table
  4. Hot-reload: watch plugins dir for changes, reload without restart
  5. Plugin isolation: each plugin runs in its own `vm.createContext` (basic sandboxing)
  6. Add `/api/admin/plugins` endpoint: list, enable, disable plugins
  7. Ship 2 example plugins: `calculator` (basic math) and `weather` (OpenWeatherMap API)
- **验证**: Drop a new plugin folder → within 5s it appears in `/api/admin/plugins` → tool is available in next conversation
- **约束**: Plugins cannot access core agent internals (only exposed API); max 10 plugins; plugin errors don't crash agent
- **优先级**: P3 — architectural improvement for extensibility

---

## R216 — Observability Dashboard Enhancement

- **文件**: `web/client/src/pages/AdminDashboard.tsx`, `agent/api/infra-routes.mjs`
- **目标**: The admin dashboard exists but lacks real-time operational visibility. Add: live request traces, model cost breakdown, error rate graphs, worker pool status.
- **具体步骤**:
  1. Add `/api/admin/traces/live` SSE endpoint: streams last 50 request traces in real-time
  2. Add `/api/admin/costs/breakdown` endpoint: cost by model, by day, by user
  3. Add `/api/admin/errors/recent` endpoint: last 100 errors with stack traces
  4. Frontend: add tabs to AdminDashboard — "Live Traces", "Cost Analysis", "Error Log"
  5. Live Traces tab: real-time table with traceId, model, duration, tokens, cost
  6. Cost Analysis tab: bar chart (daily cost) + pie chart (cost by model)
  7. Error Log tab: filterable error list with expandable stack traces
- **验证**: Open admin dashboard → Live Traces tab shows requests appearing in real-time as users interact
- **约束**: SSE endpoint limited to admin role; max 1000 traces in memory (ring buffer); no external charting library (use existing frontend chart components)
- **优先级**: P2 — operational visibility

---

## R217 — Graceful Degradation Framework

- **文件**: New file `agent/worker/degradation-manager.mjs`, modify `agent/worker/openclaw-handler.legacy.mjs`
- **目标**: When capabilities are unavailable (Docker down, browser dead, Gateway overloaded), gracefully degrade instead of failing. Inform user what's limited and offer alternatives.
- **具体步骤**:
  1. Create `degradation-manager.mjs`: tracks capability health status
  2. Capabilities: `browser`, `sandbox`, `gateway`, `search`, `memory`
  3. Health check: periodic ping (every 30s) for each capability
  4. When capability is DOWN: inject degradation notice into system prompt
  5. Example: browser DOWN → system prompt says "Browser is unavailable. Use web_fetch for URLs instead."
  6. Frontend: show capability status badges in header (green/yellow/red)
  7. Add `/api/health/capabilities` endpoint for monitoring
- **验证**: Stop Docker → within 30s, sandbox capability shows "degraded" → agent automatically uses alternative tools → user sees "⚠️ Code execution in degraded mode"
- **约束**: Health checks must not block main event loop (use setTimeout, not setInterval blocking); degradation notices are concise (1 line)
- **优先级**: P1 — critical for production reliability

---

## R218 — End-to-End Test Suite

- **文件**: New directory `agent/tests/e2e/`, new file `agent/tests/e2e/full-flow.test.mjs`
- **目标**: Create comprehensive E2E tests that exercise the full agent loop: user message → routing → planning → tool execution → response. Currently tests are mostly unit/smoke level.
- **具体步骤**:
  1. Create test harness: mock Gateway responses, real DB, real tool execution
  2. Test cases:
     - Simple Q&A (no tools) → correct model routing → response
     - Code task → sandbox execution → file created → response with code
     - Research task → web_search → summarized response
     - Multi-step task → plan created → steps executed in order → final response
     - Error recovery → tool fails → fallback used → degraded response
  3. Add `pnpm test:e2e` script
  4. Each test must complete in <30s
  5. Add CI gate: E2E tests must pass before deploy (in `auto-pull-deploy.sh`)
- **验证**: `pnpm test:e2e` runs 10+ scenarios, all pass, total time <5 minutes
- **约束**: Tests must not require external API keys (mock all LLM calls); tests must not modify production DB (use test DB)
- **优先级**: P1 — prevents regressions from Codex iterations

---

## R219 — Chat UX Polish Sprint

- **文件**: `web/client/src/pages/ChatPage.tsx`, `web/client/src/components/`
- **目标**: Bring chat UX to Manus level: markdown rendering with syntax highlighting, file attachment previews, image display, copy buttons, message actions (retry, edit, delete).
- **具体步骤**:
  1. Markdown: use `react-markdown` + `rehype-highlight` for code blocks with language detection
  2. Code blocks: add copy button (top-right), language label, line numbers for >5 lines
  3. Images: inline display with lightbox on click
  4. File attachments: show file icon + name + size, click to download
  5. Message actions (on hover): copy, retry (resend user message), edit (modify and resend), delete
  6. Typing indicator: animated dots while agent is processing
  7. Auto-scroll: smooth scroll to bottom on new messages, with "scroll to bottom" button when user scrolls up
  8. Empty state: helpful suggestions when no messages ("Try asking me to...")
- **验证**: Send a message with code → response shows syntax-highlighted code with copy button → hover message shows action buttons → click retry resends
- **约束**: Must work on mobile (responsive); no layout shifts during streaming; dark theme only (match existing design)
- **优先级**: P1 — user-facing quality directly impacts adoption

---

## Priority Summary

| Priority | Tasks | Theme |
|----------|-------|-------|
| **P0** (Do First) | R200, R201, R203, R211 | Core capabilities: browser, multi-agent, workspace, gateway fix |
| **P1** (Do Next) | R202, R204, R205, R206, R208, R212, R217, R218, R219 | Production readiness: scaling, reliability, UX, testing |
| **P2** (Do Later) | R207, R209, R210, R213, R216 | Enhancement: scheduling, context, memory, observability |
| **P3** (Backlog) | R214, R215 | Future: voice, plugins |

---

## Codex Execution Notes

1. **Start with R211** (Gateway session multiplexing) — this unblocks R201 and R202
2. **Then R200** (browser) — highest user-visible impact
3. **Then R203** (workspace) — enables R212 (file tools)
4. **Each task is independent** unless noted — Codex can work on P1 tasks in parallel after P0 is done
5. **Test after each task**: run `node agent/scripts/r121-quality-gate.mjs` to verify no regressions
6. **Deploy via webhook**: `curl -X POST https://ranger.voyage/codex-deploy/apply-patch -H 'X-Deploy-Secret: ranger-codex-2026' -H 'Content-Type: application/json' -d '{"files": {...}}'`

---

## Appendix: What Ranger Does Better Than Manus

To be fair, Ranger has genuine advantages in specific areas:

1. **Role-based access control** — 5-role matrix with tool group permissions is more granular than Manus's binary owner model
2. **Human approval gate** — explicit confirmation for high-risk tools (exec, write) for non-admin roles
3. **KV-cache observability** — tracking cache hit rates (86.7%) for cost optimization
4. **RAG source reliability scoring** — R119's freshness + conflict penalty is sophisticated
5. **Cost observability** — per-request cost calculation with budget alerts
6. **Admin tooling breadth** — 40+ admin pages for business operations (CEO dashboard, KOL management, TikTok integration, inventory)
7. **Smart routing with phase awareness** — model selection adapts to task phase (planning → GPT-5.5, coding → DeepSeek, review → GPT-5.5)
8. **Externalized configuration** — model routing, role matrix, and router config are JSON files (hot-reloadable without code changes)

These advantages should be **preserved and enhanced**, not replaced during the parity sprint.
