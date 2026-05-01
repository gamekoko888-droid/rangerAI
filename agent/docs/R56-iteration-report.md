# RangerAI R56 迭代报告

**版本**：v15.2-R56
**日期**：2026-04-04
**主题**：Manus 对标审计 — KV-Cache 前缀稳定、上下文压缩、进度持久化、非阻塞通知、视觉验证

---

## 一、迭代背景

R56 的核心目标是将 Manus 报告中披露的六大 Agent 工程策略逐一映射到 RangerAI 现有代码，找出真实 Gap 并补齐。本轮聚焦五项任务，覆盖 P0（KV-Cache、context-compressor）和 P1（进度持久化、notify/ask 分离、visual-verifier）两个优先级层。

---

## 二、Task 完成状态

| Task | 标题 | 计划工作量 | 实际结果 | 变更文件 |
|------|------|-----------|---------|---------|
| 1 | KV-Cache 前缀稳定审计 | 1-2h | **无需修改** — 审计确认前缀已稳定 | 无 |
| 2 | context-compressor 接入 | 30min | **已集成** — 发现 user-message-handler L232 已调用 | 无 |
| 3 | todo.md 注意力机制持久化 | 3-4h | **已实现** — DB 持久化 + 每轮工具调用后注入 | task-progress-tracker.mjs, openclaw-handler.mjs, user-message-handler.mjs |
| 4 | 非阻塞进度通知 | 2-3h | **已实现** — sendNotify + 前端 notify 事件处理 | ipc-utils.mjs, openclaw-handler.mjs, 前端生产构建 |
| 5 | visual-verifier 自动触发 | 2h | **已实现** — tool_end 后自动检测并触发验证 | openclaw-handler.mjs |

---

## 三、各 Task 详细说明

### Task 1：KV-Cache 前缀稳定审计

**结论：RangerAI 的系统提示词前缀已经是稳定的，不存在 Manus 报告中提到的动态内容注入问题。**

审计覆盖了以下路径：

1. **knowledge-injector.mjs L137 的 `ts: new Date().toISOString()`** — 这是 `logKnowledgeSearch()` 函数中的 HTTP 请求体字段，发送到 `/api/knowledge/search-log` API 用于日志记录，**不进入 system prompt**。

2. **SOUL.md 系统提示词** — 从文件读取，内容完全静态，无时间戳、无随机数。通过 `_soulCache` 缓存机制确保同一文件内容不重复读取。

3. **Gateway 路径 (chat.send)** — `chatSendParams` 只包含 `sessionKey`、`message`、`deliver`、`idempotencyKey`、`thinking`。系统提示词由 OpenClaw Gateway 从 SOUL.md 加载，不在每次请求中传递。

4. **Direct API 路径 (Anthropic/OpenAI/Google)** — 使用 `getSoulSystemPrompt()` 获取缓存的 SOUL.md 内容，带 `cache_control: { type: "ephemeral" }`，内容稳定。

5. **`effectiveMessage` 构建** — 包含 `browserWarning`（条件性注入，仅在熔断时出现）和 `roleSystemPrompt`（用户角色上下文），均不包含时间戳。

R53 的 KV-Cache 审计已确认生产环境 97% 缓存命中率，本次审计进一步确认前缀稳定性无问题。

### Task 2：context-compressor 接入

**结论：`checkAndCompress` 已在 `user-message-handler.mjs` L232 被正确调用。**

R56 计划中指出"openclaw-handler.mjs 零调用点"是准确的（openclaw-handler 确实没有调用），但实际上 `user-message-handler.mjs` 已经在正确的位置（`rebuildSession` 函数的 Step 1.5，Gateway 会话重建后、上下文恢复前）集成了 context-compressor。导入在 L15，调用在 L232。

### Task 3：todo.md 注意力机制持久化

**变更内容**：

1. **task-progress-tracker.mjs** — 在 `createTracker` 函数中新增 `_lastMsgId` 字段，用于跟踪最后一次注入的消息 ID，防止重复注入。

2. **user-message-handler.mjs** — 在任务处理入口（约 L652）新增 R56 恢复逻辑：从 `plan-service.mjs` 的 `dbGetActivePlan` 恢复持久化的计划状态到内存 tracker，确保 Worker 重启后不丢失进度。

3. **openclaw-handler.mjs** — 在 `tool_end` 事件处理后（R54-AUTO-ADVANCE 之后）新增 R56-progress-inject 块：每次工具调用完成后，构建最新的 progress block 并通过 `sendEvent` 以 `thinking` 类型发送到前端，同时通过 `sendNotify` 发送轻量级进度通知。

**持久化链路**：`markStepDone()` → `dbUpdateStepStatus()` (IPC) → SQLite `task_plans` 表 → Worker 重启时 `dbGetActivePlan()` → `initTrackerFromPlan()` 恢复内存状态。

### Task 4：非阻塞进度通知

**变更内容**：

1. **ipc-utils.mjs** — 新增 `sendNotify(msgId, text, category)` 函数，发送 `{ type: "notify", content, category, timestamp }` 事件到前端。

2. **openclaw-handler.mjs** — 在 tool_end 后新增 R56-notify-milestone 块：检测当前进度状态，发送 `step_progress` 类别的通知（格式：`2/5: 当前步骤标题`）。

3. **前端生产构建** — 在 `useChatActions` 的事件处理 switch 中注入 `notify` case：接收到 notify 事件后，通过 `console.log` 记录并触发 `CustomEvent('agent:notify')` 供 UI 组件监听。

**事件流**：Worker `sendNotify()` → IPC `frontend_event` → `worker-manager._handleWorkerMessage` → WS → 前端 `notify` case → `CustomEvent('agent:notify')`。

### Task 5：visual-verifier 自动触发

**变更内容**：

1. **openclaw-handler.mjs L35** — 新增 `import { shouldAutoVerify, buildAutoVerifyMessage, recordVerification } from "./visual-verifier.mjs"`。

2. **openclaw-handler.mjs L869-887** — 在 R56-notify-milestone 之后、GUARDRAIL-PROGRESS 之前新增 R56-visual-verify 块：
   - 从 `data.args` 提取 `path`/`file_path`/`command` 信息
   - 调用 `shouldAutoVerify(toolName, toolResult)` 判断是否需要视觉验证（前端文件修改、构建命令等）
   - 触发时发送 `thinking` 事件携带验证提示到 AI 上下文
   - 调用 `recordVerification()` 记录验证触发事件

---

## 四、部署验证

| 检查项 | 结果 |
|--------|------|
| rangerai-agent 服务 | active |
| rangerai-ws 服务 | active |
| 外部访问 (ranger.voyage) | HTTP 200 |
| Worker Gateway 连接 | 12:17:43 UTC "Ready and waiting for tasks" |
| 重启后新错误 | 无 |
| visual-verifier import | 确认（L35） |
| sendNotify 函数 | 确认（2处引用） |
| R56-progress-inject | 确认（1处） |
| R56-visual-verify | 确认（3处） |
| R56-notify-milestone | 确认（1处） |
| PLAN_MODEL | claude-haiku-4-5（R55 修复） |
| PLAN_TIMEOUT_MS | 8000（R55 修复） |

---

## 五、Manus 对标差距总结

| Manus 策略 | R56 前状态 | R56 后状态 |
|------------|-----------|-----------|
| KV-Cache 前缀稳定 | 未审计 | ✅ 已审计确认稳定（97% 命中率） |
| 上下文主动压缩 | 已实现未发现 | ✅ 已确认在 user-message-handler L232 集成 |
| 错误保留策略 | ✅ 已满足 | ✅ 已满足（无主动 filter/remove） |
| todo.md 注意力机制 | 🟡 in-memory，重启丢失 | ✅ DB 持久化 + 每轮工具调用后注入 |
| notify/ask 分离 | ❌ 不存在 | ✅ sendNotify + 前端 notify 事件 |
| visual-verifier | ❌ 未集成 | ✅ tool_end 后自动触发 |

---

## 六、遗留问题

1. **workspace/SOUL.md 不存在**：R54 的统一操作可能只复制了一个方向（`.openclaw/SOUL.md` 存在且为 23,898B，但 `workspace/SOUL.md` 缺失）。Gateway 使用 `.openclaw/SOUL.md`，功能不受影响，但建议 R57 重新建立 symlink 或确认 workspace 目录是否已废弃。

2. **前端 notify 渲染**：当前 notify 事件仅触发 `console.log` + `CustomEvent`，尚未有 UI 组件监听并渲染为进度徽章。需要前端迭代添加 `NotificationBadge` 组件。

3. **P2 待办**：工具前缀规范化、Wide Research 并行化仍在 backlog。

---

## 七、R53-R56 累计变更清单

| 迭代 | 变更文件 | 变更类型 |
|------|---------|---------|
| R53 | openclaw-handler.mjs | PLAN_AB_MONITOR 日志、markStepDone 导入 |
| R54 | user-message-handler.mjs | generatePlan 参数修复 (message→userMessage) |
| R54 | .openclaw/SOUL.md | 统一双文件 |
| R54 | openclaw-handler.mjs | R54-AUTO-ADVANCE 步骤推进 |
| R54 | openclaw-handler.mjs | planABStats 汇总统计 |
| R55 | task-planner.mjs | PLAN_MODEL + PLAN_TIMEOUT_MS |
| R55 | conversation-recall.mjs | 中文停用词 + 阈值 0.20 + 分数标注 |
| R55 | openclaw-handler.mjs | toolStartTimes 独立跟踪（修复 adaptive-memory） |
| R56 | task-progress-tracker.mjs | _lastMsgId 字段 |
| R56 | user-message-handler.mjs | R56 恢复逻辑（DB → 内存 tracker） |
| R56 | openclaw-handler.mjs | R56-progress-inject + R56-notify-milestone + R56-visual-verify |
| R56 | ipc-utils.mjs | sendNotify 函数 |
| R56 | 前端生产构建 | notify 事件处理 |
