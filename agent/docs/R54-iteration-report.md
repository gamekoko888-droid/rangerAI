# RangerAI 迭代报告 R54 — v15.1

**日期**：2026-04-04  
**目标**：收尾 R53 遗漏 + SOUL.md 统一 + 步骤自动推进 + 前端 PTR 验收  
**部署时间**：17:37 CST（延迟重启 `rangerai-ws`，无活跃任务中断）

---

## 变更总览

| Task | 状态 | 变更文件 | 说明 |
|------|------|----------|------|
| Task 1 | **已修复** | `worker/user-message-handler.mjs` L664 | `generatePlan(sessionKey, message, routing)` → `generatePlan(sessionKey, userMessage, routing)` |
| Task 2 | **已完成** | `~/.openclaw/SOUL.md` | 根目录副本（23,915B）用 workspace 版本（21,941B）覆盖，两文件现已一致 |
| Task 3 | **已实现** | `worker/openclaw-handler.mjs` L797-815 | 在 `tool_end` 事件后注入 `markStepDone` 调用，基于工具计数启发式推进步骤 |
| Task 4 | **代码确认** | 无代码变更 | PTR 修复（`pendingRecoveryRef` + 延迟 `recover_task`）已确认存在于生产构建 `useChatActions-Cc-OCqzP.js` 中，待用户手动验收 |
| Task 5 | **已实现** | `worker/openclaw-handler.mjs` L37-49, L170/182/186 | 新增 `planABStats` 计数器 + 1 小时定期汇总日志 `[PlanAB Summary]` |

---

## Task 1：修复 R55 Plan 生成 Bug

R53 审计中发现 `generatePlan` 调用传入了未定义的 `message` 变量，而函数签名的参数名为 `userMessage`。这导致每次主动计划生成都静默失败，日志中持续出现 `Plan generation failed: message is not defined`。

修复内容为单行变更，将第 664 行的 `message` 替换为 `userMessage`。修复后，R55 主动计划生成功能将在下次用户发送复杂任务（code/sysadmin/research/reasoning 类型）时正常触发。

**验证方式**：发送一条代码或系统管理类型的任务后，检查 `worker-stderr.log` 中是否出现 `R55: Active plan injected` 而非 `Plan generation failed`。

---

## Task 2：统一 SOUL.md 双文件

R53 KV-Cache 审计中发现 SOUL.md 存在两个版本：根目录副本（`~/.openclaw/SOUL.md`，23,915 字节）和 workspace 版本（`~/.openclaw/workspace/SOUL.md`，21,941 字节），差异约 2KB。

两个路径分别被不同代码路径引用：Gateway（OpenClaw）使用 workspace 版本，Direct API fallback 路径使用根目录版本。版本不一致可能导致两条路径下 Agent 行为差异，同时影响 Anthropic prompt caching 的命中率（系统 prompt 变化会导致缓存失效）。

本次操作将 workspace 版本（作为维护主版本）复制到根目录，确保两文件完全一致。操作后通过 `diff -q` 验证两文件字节级相同。

---

## Task 3：步骤自动推进

R53 已导入 `task-progress-tracker.mjs` 的相关函数但未实际集成到工具完成回调中。本次在 `openclaw-handler.mjs` 的 `tool_end` 事件处理区域（`data.phase === "end" || "complete" || "result"` 分支内）注入了步骤自动推进逻辑。

实现策略采用工具计数启发式：当 progress tracker 已初始化（`hasProgress(sessionKey)` 为 true）且存在 `running` 状态的 phase 时，每累计 3 次工具调用自动将当前 running phase 标记为 done。这是一个保守的初始策略，后续可根据实际日志数据调整阈值或改为基于 AI 文本输出中的步骤完成信号来触发。

注入位置在 `sendEvent(tool_end)` 之后、`GUARDRAIL-PROGRESS` 计数器之前，确保不影响现有的工具计数和进度提醒逻辑。日志标签为 `[R54-AUTO-ADVANCE]`，可通过 `grep R54-AUTO-ADVANCE` 监控触发频率。

---

## Task 4：前端 PTR 修复验收

通过在生产构建文件 `useChatActions-Cc-OCqzP.js` 中搜索关键标识符，确认 R52 的 PTR 修复代码已包含在当前部署中：

- `recover_task`：3 处引用
- `chat_bound`：3 处引用
- `bind_chat`：2 处引用

这证实 `pendingRecoveryRef` + 延迟 `recover_task` 到 `chat_bound` 后的完整修复链路已在生产环境中生效。需要用户在移动端 Chrome 清除缓存后手动验收：发起耗时任务 → 任务输出过程中下拉刷新 → 观察是否显示"已重新连接"并完整回放历史输出。

---

## Task 5：Plan A/B 汇总统计

在 `openclaw-handler.mjs` 模块级别新增 `planABStats` 对象，包含 `planA`、`planB`、`failed` 三个计数器。在 Plan A 成功（Gateway session 创建成功）、Plan B 回退（fallback 到主 session）、以及两者都失败时分别递增对应计数器。

通过 `setInterval` 每小时输出一次汇总日志：

```
[PlanAB Summary] 60min: Plan A success=N, Plan B fallback=M, failed=K
```

仅在该小时内有实际调用时才输出，避免空闲时产生无意义日志。计数器在每次汇总后重置。

---

## 部署验证

| 检查项 | 结果 |
|--------|------|
| rangerai-web | active |
| rangerai-ws | active（17:37:29 CST 重启） |
| rangerai-agent | active |
| Port 3000 | LISTENING |
| Port 3002 | LISTENING |
| Port 3005 | LISTENING |
| External access (ranger.voyage) | HTTP 200 |
| Post-restart errors | 无新错误（最后一条 `message is not defined` 在 09:28 UTC，重启前） |

---

## 已知遗留问题

`modelUpgraded is not defined` 错误在 04:57 和 05:01 UTC 出现过两次。该变量在 `openclaw-handler.mjs` L123 声明为 `let modelUpgraded = false`，位于 `handleOpenClawStream` 函数作用域内。错误可能源于某个异步回调在函数作用域外引用了该变量。此问题在 R54 重启后未复现，建议在 R55 中监控是否再次出现。

---

## 备份清单

| 文件 | 备份路径 |
|------|----------|
| user-message-handler.mjs | `backups/user-message-handler.mjs.bak-20260404-173133` |
| openclaw-handler.mjs (Task 3) | `backups/openclaw-handler.mjs.bak-r54-task3-20260404-173439` |
| openclaw-handler.mjs (Task 5) | `backups/openclaw-handler.mjs.bak-r54-task5-20260404-173627` |
| SOUL.md (根目录原版) | `~/.openclaw/SOUL.md.bak-r54` |

---

## R55 建议

1. **验证 Task 1 生效**：发送复杂任务后检查日志中是否出现 `R55: Active plan injected`
2. **验证 Task 3 生效**：检查日志中是否出现 `[R54-AUTO-ADVANCE]` 标签，评估步骤推进频率是否合理
3. **用户验收 Task 4**：在移动端执行 PTR 测试
4. **监控 Plan A/B 汇总**：1 小时后检查 `[PlanAB Summary]` 日志，评估 Plan A 成功率
5. **监控 `modelUpgraded` 错误**：如重启后仍出现，需排查异步回调作用域问题
