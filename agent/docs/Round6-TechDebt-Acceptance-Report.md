# RangerAI 第六轮技术债验收报告

**版本**：v25.11（Git commit `fbdcd67`）
**标签**：`v25.11`
**日期**：2026-04-11
**范围**：TD-040 ~ TD-046（7 项技术债）
**作者**：Manus AI

---

## 一、执行摘要

本轮技术债清理集中解决了两个系统性问题：**autonomous-task 功能链完全断裂**（API 可创建但任务永不执行、RBAC 权限定义缺失、数据库表归属不明确）和**日志架构代码与配置不一致**（v25.9.2 关闭文件日志但代码残留死导入）。经过 7 项修复，autonomous-task 功能链已从"创建即死"恢复为"创建→排队→执行→完成/失败"的完整生命周期，日志模块的死代码已全部清除，EPIPE 防护覆盖完整。

---

## 二、逐项验收结果

| TD 编号 | 优先级 | 标题 | 状态 | 验收结论 |
|---------|--------|------|------|----------|
| TD-040 | P0 | RBAC 权限缺失导致全角色 403 | **通过** | 权限名统一为标准格式，admin/cs 角色已添加 task 权限 |
| TD-041 | P0 | autonomous_tasks 表归属混乱 | **通过** | 确认表在根目录 rangerai.db（SQLite），532 条数据，task_steps 14 条 |
| TD-042 | P1 | queued 任务永不执行 | **通过** | 实现 30s 轮询器，通过 Redis IPC dispatch_task 执行 |
| TD-043 | P1 | logger.mjs 死代码残留 | **通过** | 删除 fs import、LOG_DIR、LOG_TO_FILE、mkdirSync（0 残留） |
| TD-044 | P1 | ws-realtime dead import | **通过** | 删除 handleAutonomousTask import（0 残留） |
| TD-045 | P2 | knowledge-api 引用检查 | **通过** | 确认为活跃模块，归档空的 knowledge.db 和 tasks.db |
| TD-046 | P3 | EPIPE 兜底与 logs 目录策略 | **通过** | 3 入口进程均有 EPIPE 防护，logs 目录保留供 alert-manager/worker-manager 使用 |

---

## 三、各项详细说明

### TD-040：RBAC 权限修复

**问题**：`autonomous-task-api.mjs` 使用 `hasPermission(context.user, 'task.submit')` 检查权限，但 `ROLE_PERMISSIONS` 中无任何角色定义该权限，导致所有用户（包括 admin）提交任务时均返回 403。

**修复内容**：

1. 将 API 中的权限名从非标准的 `task.submit` / `task.cancel.any` 统一为标准 RBAC 格式 `task:write` / `task:manage`
2. 在 `ROLE_PERMISSIONS` 中为以下角色添加 task 权限：
   - **admin**：`task:read`、`task:write`、`task:manage`（完整权限）
   - **manager**：`task:read`、`task:write`、`task:manage`
   - **cs**：`task:read`、`task:write`（可提交，不可取消他人任务）
   - **viewer**：`task:read`（仅查看）

**验证结果**：`grep` 确认 admin 角色包含 `task:read, task:write, task:manage`，cs 角色包含 `task:read, task:write`。API 中 `hasPermission` 调用使用 `task:write` 和 `task:manage`，与 RBAC 定义完全匹配。

### TD-041：autonomous_tasks 表归属确认

**问题**：任务书描述了"三重混乱"——db-adapter 默认走 SQLite 但表可能不存在、API 返回数据来源不明、worker 依赖的 task_steps 表缺失。

**探测结果**：

- **db-adapter 默认走 SQLite**：systemd 服务未设置 `DB_TYPE` 环境变量，默认使用 `/opt/rangerai-agent/rangerai.db`
- **autonomous_tasks 表存在**：位于根目录 `rangerai.db`，包含 532 条记录
- **task_steps 表存在**：同一 SQLite 实例，包含 14 条记录
- **API 和 Worker 共享同一 DB 实例**：均通过 `db-adapter.mjs` 的 `query/run` 函数访问

**结论**：数据库归属不混乱。之前 v25.10 的 TD-034 删除了 ws-realtime 中多余的 SQLite 恢复逻辑，当前 API 层读写正常。

### TD-042：autonomous task 轮询执行器

**问题**：supervisor-engine 删除后，无任何进程轮询 `autonomous_tasks` 表执行 queued 任务。用户提交的任务写入 DB 后永远停留在 `queued` 状态。

**实现方案**：在 `services/background-jobs.mjs` 中新增第 4 项后台任务——**Autonomous Task Queue Poller**，核心逻辑如下：

1. **轮询间隔**：每 30 秒扫描一次 `autonomous_tasks` 表
2. **并发控制**：最多同时执行 1 个自主任务（`MAX_CONCURRENT_AUTO_TASKS = 1`）
3. **任务拾取**：按 `priority ASC, createdAt ASC` 排序（FIFO + 优先级）
4. **执行方式**：通过 Redis IPC `sendRequest({ type: 'dispatch_task' })` 发送给 ws-realtime 进程，复用现有的 `workerManager.sendTask` 完整链路
5. **状态管理**：拾取时立即标记为 `running`，完成后更新 `completed`/`failed` + 结果/错误信息 + 耗时
6. **崩溃恢复**：启动时将超过 15 分钟的 `running` 任务重置为 `queued`

**验证结果**：日志确认 `"Background: Autonomous task poller started (interval: 30s)"`。当前任务状态分布：completed 514、failed 17、running 1（正在执行中）。

### TD-043：logger.mjs 死代码清理

**问题**：v25.9.2 将 `LOG_TO_FILE` 设为 `false`，但代码仍保留 `import { appendFileSync, mkdirSync, existsSync } from 'node:fs'`、`LOG_DIR` 定义和 `mkdirSync` 调用。

**修复内容**：从 `lib/logger.mjs` 删除以下死代码：
- `import { appendFileSync, mkdirSync, existsSync } from 'node:fs'`
- `const LOG_DIR` 定义
- `const LOG_TO_FILE` 定义
- `mkdirSync(LOG_DIR, { recursive: true })` 调用
- `writeToFile()` 函数中的文件追加逻辑

**验证结果**：`grep -c` 确认 `appendFileSync/mkdirSync/existsSync/LOG_DIR/LOG_TO_FILE` 在 logger.mjs 中的匹配数为 **0**。

### TD-044：ws-realtime dead import 清理

**问题**：`ws-realtime.mjs` 第 31 行 import 了 `handleAutonomousTask`，但该函数在文件中无任何调用路径。

**修复内容**：删除 `import { handleAutonomousTask } from "./worker/autonomous-task-worker.mjs"` 行。

**验证结果**：`grep -c 'handleAutonomousTask' ws-realtime.mjs` 返回 **0**。

### TD-045：knowledge-api 引用检查

**问题**：需确认 `knowledge-api.mjs` 是活跃模块还是可归档的 stub。

**分析结果**：

- `knowledge-api.mjs`（28KB）是完整的 REST API 模块，处理 `/api/knowledge` 路由
- 被 `api-server.mjs` import 并在 `http-router.mjs` 中注册
- `initKnowledgeApi` 在 `context-setup.mjs` 行 156 被正确调用
- 主 DB 有 50 条 `knowledge_docs` 记录

**处理**：保留 knowledge-api 模块不动。归档两个空文件：
- `knowledge.db`（0 字节）→ `archive/knowledge.db.empty`
- `tasks.db`（0 字节）→ `archive/tasks.db.empty`

### TD-046：EPIPE 兜底与 logs 目录策略

**问题**：EPIPE 防护分散在多处，缺少统一兜底；logs 目录保留策略不明确。

**验证结果**：

- **api-server.mjs**：4 处 EPIPE 防护（`uncaughtException` + `stdout/stderr.on('error')`）
- **ws-realtime.mjs**：4 处 EPIPE 防护（同上）
- **worker/index.mjs**：同样有 EPIPE 过滤
- **signals.mjs**：全局 `uncaughtException` 兜底

**logs 目录策略**：保留 `/opt/rangerai-agent/logs/` 目录，因为 `alert-manager.mjs`（写 `alerts.log`）和 `worker-manager.mjs`（写 `worker-stdout.log`、`worker-stderr.log`）仍在主动使用。logger.mjs 不再创建该目录。

---

## 四、生产环境健康状态

| 指标 | 值 |
|------|-----|
| rangerai-agent | **active** |
| rangerai-ws | **active** |
| rangerai-web | **active** |
| rangerai-fileserver | **active** |
| ranger.voyage HTTP | **200** |
| 磁盘使用率 | **56%** |
| Git 版本 | `fbdcd67` (v25.11) |
| 端口 3001 (API) | LISTENING |
| 端口 3002 (WS) | LISTENING |

---

## 五、已知遗留与建议

1. **db-adapter WAL-MONITOR 警告**：`require is not defined` 错误每 10 分钟出现一次，因为 WAL checkpoint 代码使用了 CommonJS `require` 但运行在 ESM 环境。建议下一轮修复为 `import()` 动态导入。

2. **Workflow Scheduler 启动失败**：`Cannot read properties of undefined (reading 'getCronEnabledWorkflows')`，说明 `buildSchedulerDeps` 未正确注入 knowledge-db 的 workflow 函数。非致命但影响定时工作流功能。

3. **autonomous task 并发限制**：当前设为 1（保守策略）。待系统稳定运行一段时间后，可根据服务器负载调整为 2-3。

4. **根目录 knowledge-api.mjs stub**：任务书提到根目录可能有 5 行 re-export wrapper，但当前根目录无此文件（仅 `api/knowledge-api.mjs` 存在）。已确认无需处理。
