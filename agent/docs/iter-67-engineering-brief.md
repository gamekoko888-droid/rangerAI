# Iter-67 工程化任务书 — RangerAI 模块化架构升级

**日期**: 2026-04-26  
**前置提交**: `9ffe290` feat(recovery): Iter-66 v2  
**模型**: deepseek/deepseek-v4-pro  
**定位**: 非最小化迭代 — 向 Manus 式 Planner→Knowledge→Executor 事件驱动架构演进

---

## 一、背景与目标

### 当前状态
- KnowledgeModule 已独立（Iter-64），`knowledge_gathered` 事件已定义
- Recovery/failure-recovery 已完成诊断+回退闭环（Iter-66 v2）
- Planner 已标准化 failure contract（Iter-63）
- 测试覆盖：83/83 pass，包含 circuit breaker、recovery、knowledge 全链路

### 架构差距（vs Manus 参考模型）
| 维度 | RangerAI 现状 | Manus 参考 | 差距 |
|------|-------------|-----------|------|
| 模块通信 | 函数调用 + 少量事件 | Planner/Knowledge/Datasource/Executor 全事件驱动 | 模块间耦合，前后端不可见 |
| 双模型 | 单模型 loop | Planner(Claude) + Executor(GPT-4o) 分离 | 无模型分离策略 |
| 前端可观测 | 仅 chat 消息 | 事件流可视、步骤追踪、知识来源标注 | 前端看不到内部事件 |
| KV-Cache | 无指标 | 核心指标，<100:1 输入输出比 | 无缓存命中监控 |
| 工具体系 | LLM 调用为主 | 30+ 前缀分组工具（browser_*/shell_*/file_*） | 工具丰富度不足 |
| 并行 Map | sessions_spawn | Pool.map() 2000 子任务 | 缺少统一子任务分发 |
| 数据库健康 | event-stats API 报 `disk image malformed` | — | 生产数据损坏风险 |

### 本轮目标
**把 RangerAI 从"函数调用聚合体"推进一步为"事件驱动的模块化 Agent 运行时"，同时修复生产数据损坏问题。**

---

## 二、迭代范围（4 个子任务，非最小化）

### T1. Event Stream 契约化升级（核心架构）

**文件**: `worker/event-stream.mjs` + 新建 `worker/event-schema.mjs`

**内容**:
1. 抽取事件类型枚举和 JSON Schema 到独立 `event-schema.mjs`（22+ 事件类型）
2. 每个事件类型有独立的 `validatePayload(type, payload)` 校验函数
3. `plan_update` 事件从自由文本升级为结构化：`{ stepNumber, status, pseudoCode, reflection }`
4. `knowledge_gathered` 扩展 `contributingSources: [{ source, relevance }]` 字段
5. 事件写入后在内存中保留最近 N 条的事件 ring buffer（`eventRingBuffer`），减少 event-stats API 的数据库依赖

**测试**: `tests/event-schema.test.mjs` — 每种事件类型 1 个校验用例

**验收**: `node --check` + `npm run test:native`（新增测试全部 pass） + 重启后 `knowledge_gathered` 事件 payload 符合 schema

---

### T2. Datasource 模块创建（对标 Manus 四大模块）

**文件**: 新建 `worker/datasource-module.mjs`

**内容**:
1. 创建 `DatasourceModule` 类，与 `KnowledgeModule` 同生命周期（init/start/stop/health）
2. 核心职责：从内部数据 API 拉取业务数据，生成结构化上下文注入 Executor
3. 首批数据源（3 个）:
   - `game-topup-stats` — 游戏充值 GMV/订单量近 7 天汇总
   - `kol-roster` — KOL 达人名单 + 近 30 天 ROI
   - `system-status` — worker pool + 健康指标（替代当前分散调用）
4. 通过 `DATASOURCE_GATHERED` 事件写入 event_stream
5. 复用 KnowledgeModule 的 circuit breaker + score/dedup 模式

**事件流改造**: `event-stream.mjs` 新增 `DATASOURCE_GATHERED` 事件类型 + rebuild 逻辑

**测试**: `tests/datasource-module.test.mjs` — 6 个测试（生命周期、3 源 fetch、circuit breaker、emit）

**验收**: 语法检查 + 10+ 测试通过 + 事件 payload 验证

---

### T3. 前端事件流面板（可观测闭环）

**文件**: 前端 `src/pages/EventStreamPanel.tsx`（新建） + 导航入口

**内容**:
1. 新建 `POST /api/event-stream/latest?limit=20` API — 读取 event_stream 最近 N 条事件
2. 新建前端 `EventStreamPanel` 页面：
   - 时间线形式展示最近 20 条事件（类型图标 + 摘要）
   - 展开单条事件显示完整 payload（JSON 格式化）
   - 按事件类型筛选（plan_update / knowledge_gathered / action / observation 等）
   - 实时刷新按钮 + 自动刷新开关（5s 轮询）
3. 左侧导航加"事件流"入口（仅 Admin 可见）
4. 部署：`bash /opt/rangerai-agent/deploy-frontend.sh`

**后端新增**: `modules/event-stream-api.mjs` — `POST /api/event-stream/latest` 端点

**验收**: 前端可访问 /events 路由，展开一条事件看到结构化 JSON，筛选功能正常

---

### T4. 数据库健康修复 + 监控硬化（运维兜底）

**文件**: `modules/db-health.mjs`（新建） + `worker/runtime-ledger.mjs`（修改）

**内容**:
1. 创建 `dbHealthCheck()` 函数：执行 `PRAGMA integrity_check` 检测 SQLite 损坏
2. 检测到 `database disk image is malformed` 时自动执行修复动作：
   - 备份损坏库 `cp db/rangerai.db db/rangerai.db.corrupt-$(date +%Y%m%d)`
   - 尝试 `sqlite3 db/rangerai.db ".recover" > db/recovered.sql` 恢复
   - 失败则从 event_stream 的 WAL journal 重建 event_stats 视图
3. `runtime-ledger.mjs` 中健康检查增加 DB 完整性一项
4. 写入 `health_check_runs` 表时附带 DB 完整性状态
5. event-stats API 路由改为优先读内存 ring buffer（来自 T1），降级才读数据库

**测试**: `tests/db-health.test.mjs` — 模拟损坏场景的恢复逻辑（至少 4 个用例）

**验收**: `node --check` + 测试通过 + event-stats 路由 curl 返回非 error

---

## 三、文件清单总结

| # | 文件 | 动作 | 规模 |
|---|------|------|------|
| 1 | `worker/event-schema.mjs` | **新建** | ~200 行，22 种事件 schema |
| 2 | `worker/event-stream.mjs` | 修改 | 接入 schema 校验 + ring buffer |
| 3 | `worker/datasource-module.mjs` | **新建** | ~400 行，3 源 + circuit breaker |
| 4 | `modules/event-stream-api.mjs` | **新建** | ~80 行 API 端点 |
| 5 | `src/pages/EventStreamPanel.tsx` | **新建** (前端) | ~300 行时间线面板 |
| 6 | `src/App.tsx` | 修改 (前端) | 导航入口 |
| 7 | `modules/db-health.mjs` | **新建** | ~150 行检测+恢复 |
| 8 | `worker/runtime-ledger.mjs` | 修改 | 集成 DB 健康检查 |
| 9 | `tests/event-schema.test.mjs` | **新建** | ~180 行 |
| 10 | `tests/datasource-module.test.mjs` | **新建** | ~200 行 |
| 11 | `tests/db-health.test.mjs` | **新建** | ~150 行 |
| 12 | `package.json` | 修改 | test:native 加入新测试 |

**预估总改动量**: ~2,000 行新增代码，6 个新建文件，4 个修改文件

---

## 四、执行策略

1. **子 Agent 分配**: T1+T2 一个编子 Agent（后端核心），T3 一个编码子 Agent（前端面板），T4 一个编码子 Agent（运维修复）
2. **执行顺序**: T1 → T2（依赖 event schema）→ T3（依赖 T1 API）→ T4（并行）
3. **验证链**: 每个子 Agent 完成后 → 主 Agent 验收 → `node --check` → `npm run test:native` → commit
4. **预计轮次**: 120-150 轮工具调用（3 个子 Agent + 主 Agent 验收）

---

## 五、风险与注意事项

- **数据库修复**（T4）是 CRIT 级操作：先备份后修复，绝不直接修改生产库
- **前端部署**（T3）：修改前端源码后必须走 `bash /opt/rangerai-agent/deploy-frontend.sh`
- **不阻塞生产**：T1/T2 的模块创建不影响现有运行逻辑，直到 task-engine 显式接入
- **历史脏文件**：`deepseek-proxy.mjs`、`openrouter-fallback-proxy.mjs` 删除、`dist/` 变更不在本轮范围内提交
