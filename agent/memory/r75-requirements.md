# R75 任务书 — Supervisor/Worker 接入执行链路 + 模块集成债务清理

**启动基线**: `b4f9efe` (R74 P0+P1+P2 全部完成)  
**日期**: 2026-04-28  
**上下文**: R74 完成了 Supervisor/Worker 的 MVP 代码（task-supervisor、worker-result-schema、event-stream 生命周期事件、安全分类、恢复分类、dependsOn 审计），但 **Supervisor 从未被实际调用**。

---

## 关键发现（代码证据）

| 证据 | 文件 | 说明 |
|------|------|------|
| `superviseTask` 已导入但从未调用 | `openclaw-handler.mjs:90` | import 存在，但 handler 仍直接用 `orchestrateWave()` |
| `task-engine.mjs` 不知道 task-supervisor 存在 | `task-engine.mjs` (1615 行) | 0 引用 task-supervisor |
| handler 3449 行 | `openclaw-handler.mjs` | 持续膨胀，并行编排逻辑可进一步提取 |
| 5 个模块 0 引用 | 见下方 | 写了未集成的功能模块 |

**0 引用模块（存在于 worker/ 但 handler 从未调用）**：
- `task-workspace.mjs` — Worker 上下文隔离
- `circuit-breaker.mjs` — API 调用熔断保护
- `quality-scorer.mjs` — 回答质量评分
- `knowledge-injector.mjs` — RAG 知识注入
- `datasource-module.mjs` — 数据源路由

**前端债务**：`dist/` 71 个文件脏（前端重建后未提交部署）

---

## P0 项

### P0-1: 接入 superviseTask 到任务执行主链路 🔴

**目标**: task-supervisor 从"存在但不运行"变成"实际调度 Worker"

**当前状态**:
- `superviseTask(taskId, sessionKey, plan, { spawnSubAgent })` 已实现，支持顺序调度 delegatable 步骤
- handler 在 parallel wave 检测到时有 `options.spawnSubAgent`，但只传给了 `orchestrateWave()`，不经过 Supervisor 层
- Worker 生命周期事件（WORKER_STARTED/COMPLETED/FAILED/RETRIED）已定义但从未 emit

**改造方案**:
1. handler 的 parallel wave 处理段调用 `superviseTask()` 替代直接 `orchestrateWave()`
2. `superviseTask` 内部调用 `orchestrateWave`（复用已有并行调度）
3. Supervisor 负责：步骤筛选（delegatable 判断）、Worker 事件 emit、失败后的重试/降级决策
4. 增加 `getDelegatableSteps(plan)` — 从 plan.steps 中筛选适合 Worker 执行的步骤

**文件**: `worker/openclaw-handler.mjs`, `worker/task-supervisor.mjs`

### P0-2: Worker 上下文隔离（task-workspace 接入）🔴

**目标**: 每个 Worker 有独立上下文，不污染主 Agent 上下文窗口

**改造方案**:
- `superviseTask` 为每个 Worker 调用 `task-workspace.create(path)` 创建隔离工作区
- Worker 结果通过 `getWorkerSummaryForContext` 压缩后注入主 Agent
- 替代当前 `orchestrateWave` 内直接把子 Agent 结果全文塞回主上下文的做法

**文件**: `worker/task-workspace.mjs`, `worker/task-supervisor.mjs`

### P0-3: 前端资产同步部署 🔴

**目标**: dist/ 71 个脏文件通过标准脚本构建部署

**操作**: `bash /opt/rangerai-agent/deploy-frontend.sh`（无需代码修改）

---

## P1 项

### P1-1: circuit-breaker 接入 LLM 调用链 🟡

**目标**: API 调用熔断保护，防止连续失败消耗配额

**改造方案**:
- `llm-bridge.mjs` 调用前经过 circuit-breaker 状态检查
- 连续失败 N 次自动熔断，冷却后自动恢复
- 熔断通知通过 emitLedgerEvent 写入事件流

**文件**: `worker/circuit-breaker.mjs`, `worker/llm-bridge.mjs`

### P1-2: handler 并行编排段提取 🟡

**目标**: 减少 handler 3449 行 → 目标 <3200 行

**改造方案**:
- handler 的 parallel wave 处理段（~80 行）整体提取到 `sub-agent-orchestrator.mjs` 的 `handleParallelWave()` 函数
- handler 只保留一行调用 + 错误包裹

**文件**: `worker/openclaw-handler.mjs`, `worker/sub-agent-orchestrator.mjs`

---

## P2 项

### P2-1: quality-scorer 接入回答输出管 🔵

**目标**: 自动评估 Agent 最终回答质量

**改造方案**: `output-manager.mjs` 在输出前调用 `quality-scorer.score(answer, criteria)` 评分并写入事件流

### P2-2: knowledge-injector 接入 context 注入链 🔵

**目标**: RAG 知识注入到每个 Agent 回合的上下文

**改造方案**: `context-injector.mjs` 在 context assembly 阶段调用 `knowledge-injector.inject(query)` 追加相关知识片段

---

## 红线文件

| 文件 | 风险 | R75 触碰项 |
|------|------|-----------|
| `worker/openclaw-handler.mjs` | 3449 行核心调度器 | P0-1, P1-2 |
| `worker/task-engine.mjs` | 1615 行任务状态机 | P0-1（被动感知） |
| `worker/task-supervisor.mjs` | R74 新增 | P0-1, P0-2 |
| `worker/llm-bridge.mjs` | 803 行 LLM 调用桥 | P1-1 |
| `worker/planner.mjs` | 2282 行 | 无需改动 |

---

## 预估轮次

| 优先级 | 任务 | 预估轮次 |
|--------|------|---------|
| P0-1 | 接入 superviseTask | 20-30 轮 |
| P0-2 | Worker 上下文隔离 | 10-15 轮 |
| P0-3 | 前端部署 | 2 轮 |
| P1-1 | circuit-breaker | 10-15 轮 |
| P1-2 | handler 提取 | 5-10 轮 |
| P2-1 | quality-scorer | 5-8 轮 |
| P2-2 | knowledge-injector | 5-8 轮 |
| **合计** | | **57-88 轮** |
