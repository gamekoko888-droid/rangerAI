# RangerAI R55 迭代报告

**版本**: v15.2  
**日期**: 2026-04-04  
**状态**: 已部署到生产环境  

---

## 迭代目标

R55 的核心目标是收尾 R53/R54 遗漏的功能缺陷，同时激活已实现但未正确集成的子系统（adaptive-memory 工具经验学习、human-approval 前端审批），并对 conversation-recall 召回质量进行优化。

---

## 变更总览

| Task | 优先级 | 文件 | 变更类型 | 状态 |
|------|--------|------|----------|------|
| Task 1: PLAN_MODEL 修复 | P0 | `task-planner.mjs` L28 | 模型名修正 | **已完成** |
| Task 6: PLAN_TIMEOUT_MS | P0 | `task-planner.mjs` L30 | 超时延长 | **已完成** |
| Task 2: operator 沙盒权限 | P1 | `sandbox-api.mjs` | 审查确认 | **已实现（R54）** |
| Task 3: conversation-recall 优化 | P1 | `conversation-recall.mjs` | 阈值+停用词+标注 | **已完成** |
| Task 4: adaptive-memory 激活 | P1 | `openclaw-handler.mjs` | ID 映射修复 | **已完成** |
| Task 5: human-approval 前端 UI | P2 | 前端+后端全链路 | 审查确认 | **已实现（R53）** |

---

## 详细变更

### Task 1 — PLAN_MODEL 404 修复

**问题根因**：`task-planner.mjs` 中 `PLAN_MODEL` 设为 `claude-3-5-haiku-20241022`，该模型名已在 Anthropic API 中下线，所有 Plan 生成请求返回 404，导致 R55 主动计划功能静默失效。

**修复**：将模型名更新为 `claude-haiku-4-5`（当前 Anthropic 最新 Haiku 模型）。

```diff
- const PLAN_MODEL = "claude-3-5-haiku-20241022";
+ const PLAN_MODEL = "claude-haiku-4-5";
```

**验收**：重启后发送任务时，`worker-stderr.log` 中不再出现 `Plan generation failed: Anthropic API 404` 错误。

### Task 6 — PLAN_TIMEOUT_MS 延长

**问题**：原 5000ms 超时在 Haiku 冷启动时偶尔不足，导致 Plan 生成超时后静默跳过。

**修复**：从 5000ms 延长至 8000ms，给冷启动留出足够余量。

```diff
- const PLAN_TIMEOUT_MS = 5000;
+ const PLAN_TIMEOUT_MS = 8000;
```

### Task 2 — operator 沙盒权限（已实现）

经代码审查确认，`sandbox-api.mjs` 中 `ROLE_LIMITS` 已为 `operator` 角色配置 tier 2 权限（64MB 内存 / 10s 超时 / 4000 字符输出限制）。`getRoleLimits(user.role)` 正确返回 operator 的限制配置，tier 不为 0 因此不会被拒绝。

完整链路：前端 `CodeExecutor.tsx` → `POST /api/sandbox/execute` → `handleSandboxRequest` → `getRoleLimits('operator')` → tier 2 → 通过权限检查 → 执行。

**结论**：R54 已正确实现，无需额外修改。

### Task 3 — conversation-recall 召回质量优化

**变更内容**：

1. **中文停用词过滤**：新增 `CHINESE_STOP_WORDS` 集合（包含"的"、"了"、"是"、"在"、"和"等 30+ 高频虚词），在 TF-IDF 分词阶段过滤掉这些词，避免它们贡献虚假相似度。

2. **最低相关性阈值**：将 `RECALL_MIN_SCORE` 从 0.10 提升至 0.20，过滤掉低质量召回结果，减少注入无关上下文对模型推理的干扰。

3. **分数标注**：在召回结果的输出格式中添加 `(score: X.XX)` 标注，使模型能感知每条召回内容的相关性强度，辅助其决策是否采纳。

### Task 4 — adaptive-memory 工具经验学习激活

**问题根因**：`recordToolExperience` 在 `openclaw-handler.mjs` L724 被调用时依赖 `orchToolInfo`（从 orchestrator 的 `activeTools` Map 获取），但由于 ID 映射不一致，`orchToolInfo` 始终为 `null`：

- **tool_start** 阶段：`orchToolId = data.id || orch-${streamId}-${tracker.toolCount}`
- **tool_end** 阶段：`orchEndId = toolIdMap.get(data.id) || data.id || orch-end-${Date.now()}`

`toolIdMap` 将 `data.id` 映射到 `toolId`（前端用），而非 `orchToolId`（orchestrator 用），导致 `getActiveToolInfo(orchEndId)` 永远找不到匹配项。

**修复方案**：引入独立的 `toolStartTimes` Map，在 tool_start 时记录开始时间，在 tool_end 时查找并计算持续时间，完全绕过 orchestrator 的 ID 映射问题。

```javascript
// tool_start 阶段
const toolExpKey = data.id || `texp-${streamId}-${tracker.toolCount}`;
toolStartTimes.set(toolExpKey, { startTime: Date.now(), toolName });

// tool_end 阶段
const toolExpEndKey = data.id || `texp-${streamId}-${tracker.toolCount}`;
const toolStartInfo = toolStartTimes.get(toolExpEndKey);
if (toolStartInfo) {
  const toolDuration = Date.now() - toolStartInfo.startTime;
  recordToolExperience(toolName, args, result, toolDuration, success, sessionKey);
  toolStartTimes.delete(toolExpEndKey);
} else {
  // Fallback: record without accurate duration
  recordToolExperience(toolName, args, result, 1000, success, sessionKey);
}
```

**验收**：下次执行工具调用后，`adaptive_memory` 表中应出现 `category=adaptive_tool_experience` 的记录。

### Task 5 — human-approval 前端 UI（已实现）

经全链路审查确认，human-approval 系统已完整实现并部署：

| 层级 | 组件 | 功能 |
|------|------|------|
| 后端 | `tool-orchestrator.mjs` | CRITICAL 工具检测 → `requestConfirmation()` → 发送 `tool_confirm_required` WS 事件 |
| IPC | `worker/index.mjs` L252 | 接收 `tool_confirm_response` → `process.emit` 转发到 orchestrator |
| WS | `ws-handler.mjs` L312 | 接收前端 WS 消息 → 转发到 worker 进程 |
| 前端 Store | `useChatStore.tsx` L617 | 监听 `tool:confirm_required` → 派发 `rangerai:tool_confirm` CustomEvent |
| 前端 UI | `ToolConfirmModal.tsx` | 渲染审批弹窗（红色高危提示 + 120s 倒计时 + 批准/拒绝按钮）|
| 挂载 | `ChatPage.tsx` L676 | `<ToolConfirmModalWrapper />` 已挂载 |

生产构建中已确认 `ChatPage-C9d3mryM.js` 和 `useChatActions-Cc-OCqzP.js` 均包含相关代码。

**结论**：R53 已完整实现，无需额外修改。

---

## 部署验证

| 检查项 | 结果 |
|--------|------|
| 延迟重启 | `defer-restart.sh 15` 执行成功，rangerai-ws 状态 active |
| 服务状态 | rangerai-agent: active, rangerai-ws: active |
| 端口监听 | 3001 (ws-realtime), 3002 (api-server), 18789/18791 (openclaw-gateway) |
| 外部访问 | `https://ranger.voyage/` HTTP 200 |
| Worker 进程 | 4 个 agent-worker 进程 (PID 702369-702372)，启动时间 18:43 |
| 重启后错误 | 无（所有历史错误均在重启前） |
| PLAN_MODEL | `claude-haiku-4-5` 已生效 |
| PLAN_TIMEOUT_MS | `8000` 已生效 |
| toolStartTimes | Map 声明已加载 |
| RECALL_MIN_SCORE | `0.20` 已生效 |

---

## 遗留问题与 R56 建议

1. **adaptive-memory 验证**：Task 4 的 ID 映射修复需要在下次实际工具调用后验证 `adaptive_memory` 表中是否新增 `adaptive_tool_experience` 记录。当前表中仅有 9 条 `adaptive_task_pattern` 记录，0 条 tool_experience。

2. **orchestrator ID 映射根治**：当前 `orchToolId` 和 `orchEndId` 的 ID 不一致问题仍然存在（orchestrator 的 `releaseExecution` 永远找不到工具），虽然不影响功能（工具仍然正常执行），但会导致 orchestrator 的 `activeTools` Map 持续膨胀。建议 R56 统一 ID 生成策略。

3. **PTR 用户验收**：R52 的 PTR 修复（`pendingRecoveryRef` + 延迟 `recover_task`）已确认在生产构建中，但需要用户在移动端清除缓存后手动验收下拉刷新场景。

4. **Plan A/B 实际数据**：R54 添加的 `PLAN_AB_MONITOR` 日志和 1 小时汇总统计需要在 R55 部署后积累数据，建议 R56 时分析首批统计结果。

---

## 文件变更清单

| 文件 | 变更行 | 变更类型 |
|------|--------|----------|
| `worker/task-planner.mjs` L28 | `PLAN_MODEL = "claude-haiku-4-5"` | 修改 |
| `worker/task-planner.mjs` L30 | `PLAN_TIMEOUT_MS = 8000` | 修改 |
| `worker/conversation-recall.mjs` L14 | `RECALL_MIN_SCORE = 0.20` | 修改 |
| `worker/conversation-recall.mjs` L16+ | 新增 `CHINESE_STOP_WORDS` 集合 | 新增 |
| `worker/conversation-recall.mjs` 输出格式 | 添加 `(score: X.XX)` 标注 | 修改 |
| `worker/openclaw-handler.mjs` L91 | 新增 `toolStartTimes` Map | 新增 |
| `worker/openclaw-handler.mjs` L604-606 | tool_start 记录开始时间 | 新增 |
| `worker/openclaw-handler.mjs` L724-740 | tool_end 使用 toolStartTimes 记录经验 | 修改 |

---

*报告生成时间: 2026-04-04 18:50 CST*
