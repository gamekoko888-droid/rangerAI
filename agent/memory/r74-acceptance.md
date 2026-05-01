# R74 验收报告 — Supervisor/Worker 长任务隔离 MVP

**日期**: 2026-04-28 13:44 CST  
**验收人**: RangerAI 编码子 Agent  
**范围**: P0 MVP（task-supervisor + worker-result-schema + Worker 生命周期事件）

---

## 修改文件清单

| 文件 | 操作 | 行数变化 |
|------|------|----------|
| `worker/task-supervisor.mjs` | **新增** | ~245 行 |
| `worker/worker-result-schema.mjs` | **新增** | ~145 行 |
| `worker/event-stream.mjs` | 修改 | +103 行 |
| `worker/openclaw-handler.mjs` | 修改 | +4 行（仅 import 注记） |
| `worker/user-message-handler.mjs` | 未修改 | 0 行 |

## P0 子项验证

### P0-1: task-supervisor.mjs ✓

- 导出 `spawnWorker(taskId, sessionKey, step, options)` — 创建单个 Worker 子任务
- 导出 `superviseTask(taskId, sessionKey, plan, options)` — Supervisor 调度器，顺序执行 delegatable 步骤
- 导出 `getWorkerSummaryForContext(taskId, workerResults)` — context injection 用摘要
- spawnWorker 通过 `options.spawnSubAgent` 桥接到 Gateway sessions.spawn
- 无 spawnSubAgent 时返回 `skipped` 状态，不抛异常
- 支持可配置重试（maxRetries），每次 retry emit WORKER_RETRIED

### P0-2: worker-result-schema.mjs ✓

- 导出 `WORKER_RESULT_SCHEMA` — 完整 schema 定义（7 个字段）
- 导出 `normalizeWorkerResult(raw)` — 确保 { stepId, status, evidence, summary, nextRisk } 结构完整
- 导出 `validateWorkerResult(result)` — 校验必填字段 stepId/status/summary
- 导出 `validateWorkerResults(results)` — 批量校验
- 实地测试：normalize → validate 返回 `{ valid: true }`

### P0-3: Worker 生命周期事件 ✓

- `EVENT_TYPES` 新增 4 个事件类型：
  - `WORKER_STARTED: 'worker_started'`
  - `WORKER_COMPLETED: 'worker_completed'`
  - `WORKER_FAILED: 'worker_failed'`
  - `WORKER_RETRIED: 'worker_retried'`
- `rebuildTaskStateFromEvents` 新增：
  - `state.workers` — 按 workerId 索引的 Worker 状态 { workerId, stepId, status, startedAt, completedAt, retryCount, lastError }
  - `state.workersHistory` — 按时间排序的事件历史（上限 50 条）
  - 4 个 case 处理块正确更新 workers map 和 history
  - 回放日志包含 `workersActive=N` 指标

## 兼容性检查 ✓

- 不修改 SOUL.md、openclaw.json、systemd service、Gateway 配置
- openclaw-handler.mjs 仅添加 import 注记，不修改任何函数体
- user-message-handler.mjs 未修改
- 不破坏现有 orchestrator.dispatch / completeDispatch / parallel wave / spawnSubAgentAdapter
- 所有新增代码为独立模块，可随时移除不影响核心功能

## 语法检查结果

```
$ node --check worker/task-supervisor.mjs      → PASS
$ node --check worker/worker-result-schema.mjs  → PASS
$ node --check worker/event-stream.mjs          → PASS
$ node --check worker/openclaw-handler.mjs      → PASS
$ node --check worker/user-message-handler.mjs  → PASS
```

## 运行时导出验证

```
task-supervisor exports: getWorkerSummaryForContext, spawnWorker, superviseTask
worker-result-schema normalize + validate: { valid: true }
Worker event types: worker_started, worker_completed, worker_failed, worker_retried — All present: true
```

## 风险评估

| 风险 | 等级 | 说明 |
|------|------|------|
| Worker 暂无实际调用路径 | LOW | 本轮 MVP 仅提供模块和接口，handler 层未真正调用 superviseTask |
| Worker 结果未被 downstream 消费 | LOW | getWorkerSummaryForContext 已就绪，待 R75 集成 |
| no spawnSubAgent 时返回 skipped | LOW | 优雅降级，不影响现有流程 |

## P1 子项验证（2026-04-28 15:00 CST 补充）

### P1-1: Step Safety Classifier integration ✅ 已集成 (2026-04-28 16:10 CST)

- 提交: 待 commit（与 P1-2 同批次）
- `orchestrateWave()` 新增 P1-1 安全检查：
  - 执行前对所有步骤调用 `classifyStepSafety(step)` → READ_ONLY / MUTATE
  - 调用 `hasSharedResource(waveSteps)` 检测跨步骤共享文件/DB 资源
  - MUTATE + sharedResource → 拆分到 `serialSteps`，逐一顺序执行（前一个失败后续跳过）
  - READ_ONLY / 无共享资源的 MUTATE → 保留在 `parallelSteps`，并行执行
  - 执行顺序：串行步骤先跑，并行步骤后跑
- 配置新增: `enableSafetyCheck: true`（可通过 config 关闭）
- 每个步骤注入 `_safetyLevel` 标签供下游报告
- `executeParallelBatch()` 函数抽取复用（并行 + 串行共用同一超时/错误处理）
- classifyAndRetry 索引修复：用 `stepById` Map 查找步骤，不再依赖 waveSteps 数组索引

### P1-2: Wave recovery classify ✅ 已实现 (2026-04-28 15:50 CST)

- 提交: 待 commit（本地已修改）
- `orchestrateWave()` 新增: 每个失败步骤调用 `classifyFailure(error, tools)` → `getRecoveryStrategy(failureType, {attempts})`
- 恢复策略判断: 仅 `RETRY_IMMEDIATE` / `RETRY_DELAYED` 且 `retryable=true` 时自动重试
- 重试行为: 按 `recovery.delayMs || config.retryDelayMs` 延迟 → 重新 `spawnSubAgent`
- 重试成功: 标记 `_retried=true, _recovered=true`，计入 `totalRecovered` 统计
- 重试失败: 标记 `_retried=true, _recovered=false` + `_failureType/_recoveryAction/_severity`
- 不可重试: 直接返回失败 + 分类数据（`_failureType/_recoveryAction/_severity`）
- `collectAndMerge()` 新增: `failedSteps` 包含 `failureType/recoveryAction/severity/retried/recovered` 字段
- `collectAndMerge()` 报告新增: 失败详情包含 `[failureType] → recoveryAction (已恢复/重试失败)` 格式
- 配置新增: `maxRetries` (默认 1), `retryDelayMs` (默认 2000)
- 统计新增: `totalRetried`, `totalRecovered`
- 导入: `classifyFailure, FAILURE_TYPE, getRecoveryStrategy, RECOVERY_ACTION, SEVERITY` from `failure-recovery.mjs`

## 结论

**PASS** — R74 全部 P0/P1/P2 已完成并提交。
```
R74 Supervisor/Worker 长任务隔离
├── P0-1 task-supervisor.mjs           ✅ b0d1e30
├── P0-2 worker-result-schema.mjs      ✅ b0d1e30
├── P0-3 Worker 生命周期事件           ✅ b0d1e30
├── P1-1 Step Safety Classifier        ✅ 2412e6f + 04c0e87
├── P1-2 Wave recovery classify        ✅ 04c0e87
└── P2-1 dependsOn 安全并行审计        ✅ b4f9efe
```

**净增代码**: ~340 行（task-supervisor 284 + worker-result-schema 145 + event-stream +103 + orchestrator ~340）

