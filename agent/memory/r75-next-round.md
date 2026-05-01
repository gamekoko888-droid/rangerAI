# R75 下一轮任务书 — 已交付项盘点 + 剩余工作

**生成时间**: 2026-04-28 16:55 CST
**基线**: `73f6395` feat(R75-P0): wire supervisor into worker orchestration
**工作区状态**: clean（0 脏文件，0 untracked）

---

## 已交付（commit 73f6395）

**P0-1 superviseTask 接入主链路** ✅
- `openclaw-handler.mjs:753`: 并行 wave 处理段改为 `superviseTask(msgId, sessionKey, _plan, {...})`
- `task-supervisor.mjs`: `superviseTask()` 升级为内部调用 `orchestrateWave` + `collectAndMerge` + 生命周期事件 emit
- `task-supervisor.mjs`: 新增 `getDelegatableSteps(plan)` 可复用筛选函数
- 变更: handler (-9/+18 行), supervisor (+169 行)
- 验证: `node --check` PASS

**P0-3 前端 dist 同步** ✅
- 34 个 JS chunk hash 更新（Vite rebuild 后文件名变更）
- `index.html` 入口更新
- 1 个 hook chunk 重命名（useChatActions）

---

## 剩余 P0

**P0-2: Worker 上下文隔离（task-workspace 接入）** 🔴

现状:
- `worker/task-workspace.mjs` 217 行, 8 导出已就绪
  - `initTaskWorkspace(taskId)` — 创建工作目录
  - `writeTaskFile / readTaskFile / listTaskFiles` — 文件 CRUD
  - `maybeExternalize(taskId, toolName, result)` — 大结果 (>4000 chars) 写入文件
  - `buildWorkspaceBlock(taskId)` — 生成 context 注入块
  - `cleanupTaskWorkspace(taskId)` — 48h TTL 清理
  - `loadFileMemory(taskId)` — 从文件系统恢复记忆
- 当前问题: Worker 子 Agent 结果全文塞回主 Agent 上下文（`collectAndMerge` 返回 raw report）

改造方案:
1. `superviseTask()` 在 `orchestrateWave` 前为每个 delegatable step 调用 `initTaskWorkspace(workerId)`
2. Worker 执行期间，`maybeExternalize` 拦截大工具结果写入文件
3. `collectAndMerge` 后用 `buildWorkspaceBlock` 替代全文注入
4. 任务结束时 `cleanupTaskWorkspace` 触发 TTL 延后清理

文件: `worker/task-supervisor.mjs`, `worker/task-workspace.mjs`

验收命令:
```bash
node --check worker/task-supervisor.mjs worker/task-workspace.mjs
grep -c "task-workspace" worker/task-supervisor.mjs  # > 0
```

预估: 10-15 轮

---

## 剩余 P1

**P1-1: circuit-breaker 接入 LLM 调用链** 🟡

现状:
- `worker/circuit-breaker.mjs` 199 行, 导出 `CircuitBreaker` 类
  - 双轨熔断: hard（3 次连续连接/scope/timeout）+ soft（8 次连续空响应/应用级）
  - 衰减机制: decayIntervalMs 内无新失败则计数器减半
  - 状态: CLOSED → OPEN → HALF_OPEN
  - `canRequest() / recordSuccess() / recordFailure() / recordSoftFailure() / forceReset()`
- 当前 LLM 调用直接走 `llm-bridge.mjs` 803 行，无熔断保护

改造方案:
1. `llm-bridge.mjs` 初始化一个全局 CircuitBreaker 实例
2. 每次 LLM 调用前 `cb.canRequest()` 检查
3. 调用成功后 `cb.recordSuccess()`
4. 调用失败后根据错误类型调用 `cb.recordFailure()` 或 `cb.recordSoftFailure()`
5. 熔断时通过 `emitLedgerEvent` 通知事件流

文件: `worker/circuit-breaker.mjs`, `worker/llm-bridge.mjs`

验收命令:
```bash
node --check worker/circuit-breaker.mjs worker/llm-bridge.mjs
grep -c "CircuitBreaker" worker/llm-bridge.mjs  # > 0
```

预估: 10-15 轮

**P1-2: handler 并行编排段提取** 🟡

现状:
- `openclaw-handler.mjs` 3458 行
- 并行 wave 处理段在 handler 内联 ~60 行（已改为 supervisor 调用后缩减）

改造方案:
1. 确认 handler 中并行 wave 段（包含 supervisor 调用 + 结果合并 + 事件发送 + progress 标记）可整体提取
2. 提取到 `sub-agent-orchestrator.mjs` 的 `handleParallelWave()` 函数
3. handler 只保留一行调用: `await handleParallelWave(msgId, sessionKey, _parallel, options)`
4. 目标: handler < 3400 行

文件: `worker/openclaw-handler.mjs`, `worker/sub-agent-orchestrator.mjs`

验收命令:
```bash
node --check worker/openclaw-handler.mjs worker/sub-agent-orchestrator.mjs
wc -l worker/openclaw-handler.mjs  # < 3400
```

预估: 5-10 轮

---

## 剩余 P2

**P2-1: quality-scorer 接入回答输出管** 🔵

- `output-manager.mjs` 在输出前调用质量评分
- 预估: 5-8 轮

**P2-2: knowledge-injector 接入 context 注入链** 🔵

- `context-injector.mjs` 在 context assembly 阶段调用知识注入
- 预估: 5-8 轮

---

## 汇总

| 优先级 | 任务 | 状态 | 预估轮次 |
|--------|------|------|---------|
| P0-1 | superviseTask 接入 | ✅ 已交付 | — |
| P0-3 | 前端 dist 同步 | ✅ 已交付 | — |
| P0-2 | task-workspace 上下文隔离 | ❌ 待执行 | 10-15 |
| P1-1 | circuit-breaker 接入 | ❌ 待执行 | 10-15 |
| P1-2 | handler 并行段提取 | ❌ 待执行 | 5-10 |
| P2-1 | quality-scorer 接入 | ❌ 待执行 | 5-8 |
| P2-2 | knowledge-injector 接入 | ❌ 待执行 | 5-8 |
| **剩余合计** | | | **35-56 轮** |

**建议执行顺序**: P0-2 → P1-1 → P1-2 → P2-1 → P2-2
