# CHANGELOG.md — RangerAI 版本历史
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)

---

## [Manus-Iter5] — 2026-04-02 · 验收反馈修复 + 告警系统 + 质量闭环

### Added
- **`alert-cron.mjs`**：统一告警调度器，低库存每日 09:00 检查 + 差评率每小时检查，通过 `notification-service.mjs` 推送
- **`/api/inventory/stats`**：独立库存统计端点（总数/低库存/缺货/分类分布）
- **Feedback 反哺知识库**：AdminDashboard FeedbackTab 新增"添加到知识库"按钮，差评消息可一键写入 `knowledge_docs` 表，形成 差评→审阅→知识库修正 闭环
- **Internal-call 权限豁免**：`feedback-api.mjs`、`inventory-api.mjs`、`sandbox-api.mjs` 三者统一支持 `x-internal-call` header 绕过角色检查

### Changed
- **Docker 沙箱安全加固**：`sandbox-api.mjs` 移除 native bash fallback，Docker 不可用时直接返回 503，不再在宿主机执行用户代码
- **`/api/admin/` 认证修复**：将 `/api/admin/` 路径加入 `AUTH_REQUIRED_PREFIXES`，修复 feedback-summary 等端点 `_authenticatedUser` 为 null 的问题

### Fixed
- `sandbox-api.mjs` native fallback 安全漏洞（admin/manager 可在宿主机执行任意命令）
- `/api/inventory/stats` 404 问题（前端单独调用 stats 时挂掉）
- `feedback-api` 内部调用被 403 拦截（`x-internal-call` header 未豁免角色判断）

---

## [Manus-Iter4] — 2026-04-02 · 补完半成品 + 安全加固

### Added
- **`inventory-api.mjs`**：`GET /api/inventory` 端点，从 `inventory_items` 表读取真实库存数据（支持搜索/状态过滤/分页）
- **`feedback-api.mjs`**：`GET /api/admin/feedback-summary` 汇总统计 + `GET /api/admin/feedback-messages` 差评消息列表
- **AdminDashboard 反馈质量 Tab**：统计卡片（总数/好评/差评/差评率）+ 对话分布表 + 消息列表，三语 i18n（简中/繁中/EN）
- **MCP/Tools 路由挂载**：`/api/tools` 从 404 变为正常返回工具列表（调用 `skills-discovery.mjs`）

### Changed
- **Sandbox 角色门禁**：`http-router.mjs` 中代码执行端点加入 RBAC 检查，仅 admin/manager 可从外部调用

---

## [Manus-Iter3] — 2026-04-01 · RBAC + 配额 + 工作流增强

### Added
- **`rbac.mjs`**：RBAC 权限辅助模块，5 级角色层级（admin > manager > member > cs > viewer），提供 `checkPermission(user, action)` 和 `hasMinRole(user, minRole)` 函数
- **工作流 loop 步骤**：`type: "loop"` 支持 `maxIterations` + `until` 退出条件 + 嵌套子步骤
- **工作流 retry 机制**：任何步骤可设 `retry: N`，指数退避重试（上限 30s）
- **工作流 parallel 步骤**：`type: "parallel"` 使用 `Promise.allSettled` 并行执行子步骤
- **自主任务配额系统**：接入 `user_quotas` 表，每日任务数限制 + 每用户并发 3 任务上限
- **自主任务可见性隔离**：admin 全部可见 / manager 同部门可见 / 其他仅自己可见

### Fixed
- **`evaluateCondition()` ReferenceError**：`workflow-scheduler.mjs` 第 207 行调用未定义函数，实现完整的条件表达式解析器（支持 `>`, `<`, `>=`, `<=`, `==`, `!=`, `contains`, `equals`, `exists`, `empty` 共 10 种运算符）

### Changed
- **工作流权限**：创建/运行/修改需 manager+，删除需 admin
- **知识库权限**：上传需 manager+，删除需 admin
- **自主任务权限**：提交需 member+，取消仅限本人或 admin

---

## [Manus-Iter2] — 2026-04-01 · 核心能力升级 (Iter-57/58)

### Added
- **断点续传**：`task-store.mjs` 新增 `resumeTask()`、`getResumableTasks()`、`saveCheckpoint()` — 任务中断后可恢复执行
- **Computer Use（浏览器操控）**：`openclaw-handler.mjs` 透传 browser 工具事件到前端，`BrowserViewer.tsx` 展示浏览器截图和操作状态
- **多 Agent 协作**：`multi-agent-api.mjs` 支持 Agent 间任务委派和结果聚合
- **用户侧代码沙箱**：`sandbox-api.mjs` Docker 隔离执行（`--network none --memory 128m --cpus 0.5 --read-only`），`CodeExecutor.tsx` 前端面板
- **动态工具扩展**：`mcp-api.mjs` + `skills-discovery.mjs` 运行时发现和注册工具

### Fixed
- **MySQL 建表误报**：确认 autonomous_tasks / task_steps / task_templates 三张表已存在于 SQLite 数据库
- **CodeExecutor 组件未挂载**：在 `ChatPage.tsx` 中添加 Code Executor 面板入口
- **自主任务触发链路误报**：确认 `autonomous-task-api.mjs` → `sendCommand()` → `ws-realtime.mjs` 链路完整

---

## [Manus-Iter1] — 2026-03-31 · 审计修复 + Admin Dashboard 数据打通

### Fixed
- **Admin Dashboard 数据 Bug（P0）**：`/api/stats/summary` 字段名不匹配（`users` vs `totalUsers`），完全重写 `getStats()` 函数，新增 `messageTrend`（16天趋势）、`roleDistribution`、`userActivity`（Top 20）、`dbSizeMB`
- **Ticket/KOL Stats 无限 Loading（P0）**：前端 `fetch()` 调用缺少 `Authorization` header
- **响应时间指标优化（P0）**：`129243ms` → `122.5s`（自动单位转换），新增 TTFB 指标

### Added
- **自主任务系统**：`autonomous-task-api.mjs`（CRUD API）+ `autonomous-task-worker.mjs`（后台执行器）
- **浏览器任务模板**：预设竞品监控、TikTok 采集等高价值场景
- **工作流增强**：Webhook 触发 + 通知 + 条件分支 + 浏览器步骤
- **RAG 质量提升**：Hybrid Search + LLM Reranker（`llm-reranker.mjs`）+ 引用溯源
- **OCR 图片文字识别**：`file-parser.mjs` 集成 tesseract.js v5（中英文）
- **统一通知服务**：`notification-service.mjs`（钉钉 Webhook + 通用 Webhook）

---

## [Iter-17] — 2026-03-22 · 架构解耦

### Changed
- **`chat-api.mjs` 兼容层清理**：删除不该存在的 reports/stats 路由残留，回归纯兼容导出层
- **禁用 Gateway 重启端点**：`/admin/restart-gateway` 改为固定返回 403，避免业务面→控制平面的强耦合

### Planned (未完成)
- `worker/openclaw-handler.mjs` 的 `isControlUI` 改为基于 `sender.id/label` 字段
- `server.mjs` 里的 gateway-monitor 改为默认关闭

---

## [Iter-16] — 2026-03-22 · RAG 优化 + Gateway 截断修复

### Fixed
- **Gateway 回复截断**：根因是 `lifecycle:end` 在 assistant stream 完成前触发 `finishSuccess`。修复：`lifecycle:end` 不再立即 resolve，改为等待 `chat:final` 事件（含完整 textParts）。验证：fullText 从 4 chars → 1284 chars
- **Loop detection 阈值调整**：`MAX_CONSECUTIVE_SAME_TOOL`: 10→25, `MAX_TOTAL_TOOLS`: 60→120

### Added
- **`embedding-cache.mjs`**：进程内向量缓存，优化 `searchKnowledgeVector` 性能
- **`vector-worker.mjs`**：Worker Thread 隔离 Cosine 计算
- **存量文档 Embeddings 批量回填**：10/10 文档全部有向量嵌入

---

## [Iter-15] — 2026-03-22 · 假数据清除 + AI中台数据摄食层

### Removed
- **全量假数据清除**：前端所有 mock/假数据移除，Dashboard 指标从真实数据库读取

### Added
- **数据摄食层**：`data-upload-api.mjs` 支持 CSV/Excel 上传到 `inventory_items`、`daily_metrics` 等业务表
- **知识库术语体系**：批量导入游戏充值行业术语文档

---

## [Iter-14] — 2026-03-21 · 知识库 Bug 修复 + RAG 三阶段迭代

### Fixed
- **FTS 重建语法 Bug**：`rebuildKnowledgeFTS()` 在 SQLite 模式下错误调用 MySQL `MATCH...AGAINST` 语法，修复为 `INSERT INTO knowledge_docs_fts(knowledge_docs_fts) VALUES('rebuild')`
- **中文 FTS 命中 0 Bug**：SQLite FTS5 中文查询需后缀通配符，改为 `.map(term => term + '*').join(' OR ')`
- **前端任务耗时负数 Bug**：改为 `Math.max(0, updatedAt - createdAt)`

### Added
- **RAG Phase 1 — 查询改写（Query Rewriting）**：用户原始查询 → LLM 改写为更精准的检索 query
- **RAG Phase 2 — 父子篇章检索（Small-to-Big Retrieval）**：定位 chunkText 在全文中的字符位置，向前补 500 字符铺垫
- **RAG Phase 3 — 精排重排（Reranking / LLM-as-a-Judge）**：候选结果二次评分

---

## [Iter-13] — 2026-03-08 · 自动化自愈引擎

### Added
- **`remediation-engine.mjs`**：核心自愈引擎，含熔断器保护（3 failures / 30min → trip → 1hr cooldown）
- **6 种修复策略**：Redis 重启、MySQL 空闲连接清理、磁盘日志清理、FileServer 重启、Web Server 重启、Caddy SSL 重载
- **三轨审计**：Console + 文件 (remediation.log) + MySQL (remediation_events 表)
- **安全红线**：永不自动重启 rangerai-agent 或 Gateway

### Integration
`health-check.mjs` (cron 5min) → `alert-manager.mjs` → `remediation-engine.mjs`

---

## [Iter-12A] — 2026-03-08 · 健壮性底座 (Robustness Foundation)

### Added
- **`health-check.mjs`**：全栈健康检查脚本，21/21 检查项覆盖（系统资源 / 进程状态 / MySQL / Redis / Agent API / Gateway / FileServer / 前端构建完整性 / Workflow 调度器 / Audit Logs 体积）
  - 支持 `--format=json` 输出，供 CI Gate 和自动化管道消费
  - 告警分级：PASS / WARN / CRIT 三档，阈值可配置
- **`health_check_runs` MySQL 表**：持久化每次 health-check 运行结果
- **双轨审计日志机制**：状态转换时（PASS↔WARN↔CRIT）写入 `audit_logs`，全量正常结果不写 audit
- **CI Gate 第 7 项检查**：`ci-gate.sh` 新增 health-check 调用；WARN 不阻断，CRIT 强制阻断部署

### Changed
- **前端静态目录**：从 `/var/www/rangerai1/` 更新为 `/opt/rangerai-agent/dist/`
- **主数据库**：SOUL.md / MEMORY.md 中的数据库描述全面更新，明确 MySQL 为主库，SQLite 降级为备份/遗留态

---

## [Iter-11] — 2026-03-08 · Bug 修复批次

### Fixed
- CI Gate 全部通过（Smoke Tests 73/73）
- 对话串台 BUG：修复 `taskSessionKey` 未正确绑定导致的跨会话消息污染

---

## [Iter-10] — 历史版本

### Changed
- **数据库迁移**：SQLite → MySQL（主库切换完成，含 21 张表，8 用户）
- Redis 缓存层引入（port 6380）
- Workflow 引擎上线（29 个 workflows）

---

## [早期版本] — 2026-02-xx

### Added
- RangerAI 初始架构上线（React + TypeScript + Tailwind + Node.js + OpenClaw Gateway）
- Cloudflare CDN + Caddy 反向代理
- 智能模型路由（smart-router.mjs）
- SSH 安全加固（禁止 root 密码登录、MaxAuthTries 3）

---

## 附录：迭代编号体系说明

RangerAI 有两套迭代编号体系：

1. **Iter-N**（Iter-1 到 Iter-17+）：由 RangerAI Agent（OpenClaw）自主执行的迭代，记录在 memory 日志中
2. **Manus-IterN**（Manus-Iter1 到 Manus-Iter5）：由 Manus AI 执行的架构级迭代，记录在 Manus 交付报告中
3. **R-N**（R1 到 R50+）：RangerAI Agent 的自我进化轮次（self-evolution rounds），主要涉及 Skills 体系、成本纪律、记忆管理等

三套编号独立计数，时间线上交叉进行。
