# RangerAI Plan System Architecture

> TD-030: 三套 Plan 系统并存说明文档（2026-04-11）

## 概述

RangerAI 当前有 3 套 plan 相关机制同时运行，各自服务于不同的场景。
本文档明确三套系统的边界、数据流向和使用场景。

---

## 1. task-planner.mjs（内存态执行计划）

**位置**: `worker/task-planner.mjs`（~600 行）

**职责**: 从 LLM 流式输出中解析执行计划（plan JSON），管理 plan 的生命周期。

**存储**: 纯内存 Map（`_plans`），随进程重启丢失。

**核心函数**:
- `parsePlanFromText(text)` — 从 LLM 输出中提取 plan JSON
- `storePlan(msgId, plan, sessionKey)` — 存储解析的 plan 到内存 Map
- `getPlan(msgId)` — 按 msgId 获取 plan
- `updatePlanPhase(msgId, phaseId, status)` — 更新某个 phase 的状态
- `generatePlan(sessionKey, userMessage, routing)` — 调用 LLM 生成 plan
- `processTextForPlan(msgId, fullText, delta, sessionKey)` — 流式处理中检测 plan

**数据模型**: plan 是一个 phase 数组，每个 phase 有 id/title/status。

**消费者**: `worker-manager.mjs`、`stream-processor.mjs`

**与 plan-service 的关系**: storePlan() 调用时会同步调用 plan-service.savePlan() 持久化到 MySQL。
内存 Map 是热缓存，MySQL 是持久化层。

---

## 2. plan-service.mjs（MySQL 持久化层）

**位置**: `services/plan-service.mjs`（215 行）

**职责**: 将 task-planner 的 plan 持久化到 MySQL `task_plans` 表，提供查询和状态更新。

**存储**: MySQL `task_plans` 表（session_key, chat_id, msg_id, plan JSON, status, timestamps）

**核心函数**:
- `savePlan({ sessionKey, chatId, msgId, plan })` — 持久化 plan
- `updateStepStatus(msgId, stepIndex, status)` — 更新步骤状态
- `finalizePlan(msgId, status)` — 标记 plan 完成/失败
- `getPlans({ sessionKey, chatId, status, limit })` — 查询历史 plan
- `getActivePlan(sessionKey)` — 获取当前活跃 plan

**消费者**: `worker-manager.mjs`（通过 task-planner 间接调用）

---

## 3. supervisor-engine.mjs（多步骤任务 plan）

**位置**: `worker/supervisor-engine.mjs`

**职责**: 管理复杂多步骤任务（如 "先搜索再分析再总结"）的执行计划。

**存储**: MySQL `supervisor_tasks` 表的 `plan` TEXT 字段。

**数据模型**: plan 是一个工具调用序列（tool call sequence），与 task-planner 的 "phase 数组" 概念不同。

**与其他系统的关系**: 独立运行，不共享数据。supervisor 的 plan 描述的是 "用哪些工具、按什么顺序执行"，
而 task-planner 的 plan 描述的是 "任务分几个阶段、每个阶段做什么"。

---

## 数据流向

```
用户消息
  │
  ├─→ task-planner.mjs (解析/生成 plan)
  │     │
  │     ├─→ 内存 Map (热缓存, 用于实时 phase 追踪)
  │     └─→ plan-service.mjs → MySQL task_plans (持久化)
  │
  └─→ supervisor-engine.mjs (复杂任务)
        └─→ MySQL supervisor_tasks.plan (独立存储)
```

## 未来改进方向

1. **统一查询接口**: plan-service 的 `getPlans` API 增加 `source=supervisor` 参数，
   可以同时查询 task_plans 和 supervisor_tasks 中的 plan。
2. **统一 plan 概念**: 定义统一的 Plan 接口，让三套系统使用相同的数据结构。
3. **合并存储**: 将 supervisor_tasks.plan 迁移到 task_plans 表，用 type 字段区分。
