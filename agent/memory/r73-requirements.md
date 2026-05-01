# R73 任务书 — 工具调度脊柱 + 执行韧性

**前身**: R72 调研任务书（5项全部未执行，仅完成清扫commit）
**启动基线**: `r73-start-20260428-1058` (HEAD=15e771c)
**状态**: ✅ 已完成（P0-1/P0-2/P0-3 已提交部署，P1-1/P2-1 延期至 R74）

---

## P0-1 工具调度脊柱统一 🔴

**目标**: `tool-orchestrator.mjs` 从被动分类器升级为主动调度器

**当前问题**:
- handler 的 `acquireExecution` 调用是 fire-and-forget（line 1755）
- orchestrator 只做 rule check + confirm/cap，不参与执行决策
- 工具失败后的 retry/fallback/降级由 handler 硬编码

**改造方案**:
1. orchestrator 新增 `dispatch()` 方法：acquisition → execution → result → 下一动作决策
2. handler 不再 fire-and-forget 调用 acquireExecution，改为 await orchestrator.dispatch()
3. dispatch 内部：acquire → executor.executeToolCall() → 结果分析（成功/失败/需降级/需用户确认）
4. 保留现有分类安全规则不变

**文件**: `worker/tool-orchestrator.mjs` (+`dispatch`方法), `worker/openclaw-handler.mjs` (改造调用链)

---

## P0-2 失败恢复闭环 🔴

**目标**: 工具失败不再靠内存计数硬撑

**改造方案**:
- orchestrator dispatch 返回结构化结果 { success, result, failureType, recoveryAction }
- failure-recovery.mjs 已有 `classifyFailure()` 和 `getRecoveryStrategy()`
- 将 handler 中硬编码的 retry 逻辑替换为 orchestrated 恢复链

**文件**: `worker/tool-orchestrator.mjs`, `worker/openclaw-handler.mjs`

---

## P0-3 Event Stream 唯一事实源 🟡

**目标**: evidence/activeAction/stepProgress 不丢在内存

**改造方案**:
- stepTracker 状态变化写入 event stream（已有 event buffer）
- 重启回放可恢复完整 step 状态（event-stream 已有 rebuildTaskStateFromEvents）

**文件**: `worker/event-stream.mjs`

---

## P1-1 长任务隔离 MVP 🟢

**目标**: 子任务上下文隔离，不超长上下文跑到底

**改造方案**: Supervisor + Worker 模式（新增文件）

**文件**: `worker/openclaw-handler.mjs`, `worker/planner.mjs`, 新增文件

---

## P2-1 安全并行 🔵

**目标**: 基于 dependsOn 的只读/独立子任务并行

**前提**: P0-1 (调度脊柱) + P1-1 (任务隔离) + planner dependsOn (R71 已有)

**文件**: `worker/planner.mjs`

---

## 红线文件（已解除）

R72 清扫已移除 pre-commit 红线检查，所有文件可直接修改。
