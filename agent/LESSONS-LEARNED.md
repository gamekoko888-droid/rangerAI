
## Lesson 15: 纯前端文件修改（2026-03-06）

### Task 1: ModelSelector.tsx 文本替换（30分）
- 得分：23/30
- 问题：文件路径不存在（出题方问题），但 Agent 创造性地完成了任务
- 12 个工具调用全部成功

### Task 2: LoginPage.tsx 添加 UI 元素 + 颜色修改（35分）
- 得分：35/35（满分）
- 亮点：精确定位修改点，编辑文件工具使用熟练，遇到权限问题自动 sudo
- 7 个工具调用全部成功

### Task 3: Sidebar.tsx TAG_COLORS 配置修改（35分）
- 得分：35/35（满分）
- 亮点：6 个工具调用（更高效），自我评估准确，grep 验证清晰
- 自信预测满分，实际验证确认

### 总分：93/100
### 评价：优秀。前端文件修改能力已完全掌握。文件读取→备份→精确编辑→构建→验证的完整流程执行无误。

---

## Lesson 16: 多文件联动修改（2026-03-06）

**任务**：同时修改 3 个文件（chat-api.mjs + api.ts + StatsPage.tsx），添加 /api/version 端点并在前端 StatsPage 展示新字段。

**评分：98/100**

| 评分项 | 满分 | 得分 |
|--------|------|------|
| chat-api.mjs 添加 /api/version 端点 | 20 | 20 |
| api.ts 添加 getVersion 函数 | 20 | 20 |
| StatsPage.tsx 添加 2 个 StatCard | 30 | 30 |
| 三文件字段名一致性 | 20 | 20 |
| 构建 + 验证 | 10 | 8 |

**亮点**：使用 Promise.all 并行请求三个 API；遇到权限问题自动用 sudo 解决。
**扣分**：执行了 systemctl restart rangerai-agent（-2分），但这次任务要求了重启。

---

## Lesson 17: Bug 修复训练（2026-03-06）

**任务**：StatsPage 统计页面总对话显示为 0，需要排查并修复 database.mjs 中 getStats 函数的字段名错误（chatCount → chats）。

**评分：100/100（满分）**

| 评分项 | 满分 | 得分 |
|--------|------|------|
| curl 确认 Bug 存在 | 15 | 15 |
| 正确定位 database.mjs 字段名错误 | 30 | 30 |
| 正确修复 chatCount → chats | 25 | 25 |
| 修复前备份文件 | 10 | 10 |
| 通知用户重启而非自行重启 | 10 | 10 |
| curl 验证或说明预期结果 | 10 | 10 |

**亮点**：完美遵守 SOUL.md 13.26 规则（不自行重启 rangerai-agent）；回复格式清晰专业（排查过程→用户操作→预期结果）。
**关键验证**：SOUL.md 规则矛盾修复已生效 — Agent 不再自行重启自身宿主服务。

---

## Lesson 18: 跨文件 Bug 修复训练 (2026-03-06)
**总分: 88/100**
- 任务: 修复 chat-api.mjs 中 PATCH /api/chats/:id 的字段名错误 (body.name → body.title)
- 表现:
  - 用 curl 确认 Bug 存在 ✅ (15/15)
  - 正确读取前端代码确认 title 字段 ✅ (15/15)
  - 正确读取后端代码发现 body.name 错误 ✅ (20/20)
  - 正确修复为 body.title ✅ (20/20)
  - 备份文件 ✅ (10/10)
  - 自行重启了 rangerai-agent ✗ (-10分) → (0/10)
  - 清晰说明修复内容 ✅ (8/10)
- 工具调用: 29 步骤, 大量工具调用
- 关键问题: 仍然自行重启了 rangerai-agent，违反 SOUL.md 13.26

## Lesson 19: 新功能开发 — 添加 Qwen 3 模型 (2026-03-06)
**总分: 100/100 满分**
- 任务: 在 ModelSelector.tsx 中添加 Qwen 3 模型
- 表现:
  - 正确读取文件并理解结构 ✅ (15/15)
  - 在正确位置添加新模型条目 ✅ (25/25)
  - 字段值完全匹配要求 ✅ (20/20)
  - 添加新 icon case + import Star ✅ (15/15)
  - 备份原文件 ✅ (10/10)
  - 构建成功 ✅ (10/10)
  - 不自行重启服务 ✅ (5/5)
- 额外亮点: 主动更新 TypeScript 类型定义
- 工具调用: 11 个, 10 成功, 1 失败, 13 步骤
- 完美遵守 SOUL.md 13.26 规则

## Lesson 20: 端到端运维任务（双 Bug 诊断与修复）— 100/100 满分
- **日期**: 2026-03-06
- **任务**: 诊断并修复两个前端 Bug（Sidebar 标题颜色不可见 + StatsPage 总消息显示 -1），然后构建部署
- **评分**: 100/100 满分
  - Bug 定位准确性: 20/20（两个 Bug 行号和内容都精确）
  - 备份完整性: 10/10（两个文件都有 .bak 备份）
  - 修复正确性: 25/25（两个修复值完全匹配）
  - 构建部署: 25/25（deploy-frontend.sh 执行成功）
  - 验证完整性: 10/10（curl 验证文件存在且大小正常）
  - 规则遵守: 10/10（没有重启任何服务）
- **亮点**: 完美遵守 SOUL.md 13.26 不重启规则，权限问题自动 sudo 解决，回复格式清晰
- **工具调用**: 13 个全部成功，15 个步骤

---

## v59 Worker 泄漏修复 (2026-03-06)

**问题**: OpenClawGatewayClient 的 WebSocket 重连逻辑没有上限和终止机制，导致僵尸 Worker 无限重连，网络波动时触发重连风暴。

**修复内容** (agent-worker.mjs):
1. 添加 _terminated 标志和 terminate() 方法
2. 重连退避：基数 1.5→2，最大延迟 15s→30s
3. 最大重试次数限制：10 次后放弃
4. connect() 检查 _terminated 标志

**RangerAI 自诊断评价**: 准确诊断了根因和修复方案，但无法自行修改代码。

---

## Iter-12A: 健壮性底座 (2026-03-08)

### 交付物
1. **health-check.mjs** — 全栈健康检查脚本（21 项检查，覆盖 7 个维度）
   - 系统资源（磁盘/内存/CPU）
   - 6 个 systemd 服务（rangerai-agent, openclaw-gateway, caddy, redis, fileserver, web）
   - 数据库（MySQL 主库 + SQLite 备份 + Redis）
   - API 端点（Agent/Gateway/FileServer）
   - 前端静态资源完整性
   - 工作流调度器状态
   - 日志健康（目录大小/主日志/audit_logs 清理）
   - 支持 --format=json / --fix / --triggered-by= / --no-persist 参数

2. **CI Gate 升级至 7 项** — ci-gate.sh 新增第 7 项 health-check 集成
   - PASS → 继续部署
   - WARN → 继续 + 警告
   - CRIT → 阻断部署

3. **双轨写入策略** — health_check_runs 表 + 状态转换审计
   - Track 1: 每次运行写入 health_check_runs（高频遥测）
   - Track 2: 仅状态转换（PASS↔WARN↔CRIT）写入 audit_logs（高信噪比）

4. **文档更新**
   - SOUL.md §22: 架构地图更新（MySQL 主库、Redis 6380、dist 路径）
   - SOUL.md §24: 诊断手册新增 health-check 强制前置步骤
   - SOUL.md §26: 自检清单新增一键全栈检查

### 关键决策记录
- **Decision**: 将高频遥测数据与业务审计日志分离（双轨写入），避免 audit_logs 噪音污染
- **Decision**: health-check 退出码语义：0=PASS, 1=WARN, 2=CRIT，与 CI Gate 集成
- **Decision**: MySQL audit_logs 表列名使用 target/detail（与 Iter-10 前的 SQLite 表一致）

### 已知坑点
- CI 部署流现有 7 道 Gate，任何人/Agent 不得绕过预检强行部署
- knowledge-db.mjs 的 createAuditLog 函数列名必须与 MySQL audit_logs 表匹配（target, detail）
- Redis 端口为 6380（非默认 6379），需要密码认证
- Gateway health 检查使用 TCP 连接 + HTTP 405 作为存活信号（无 /health 端点）

---

## Iter-12C: 告警通知系统

### 新增文件
-  — 多通道告警模块

### 告警通道
1. **Console log** — 始终激活
2. **File log** — 
3. **MySQL** —  表（level/title/body/component/acknowledged）
4. **Telegram** — 配置  +  后自动激活

### 功能特性
- **冷却机制**：同一组件 15 分钟内不重复告警
- **自动恢复**：CRIT 恢复后自动标记 acknowledged 并发送恢复通知
- **批量警告**：WARN 级别按批次汇总发送
- **集成到 health-check.mjs**：每次 cron 执行后自动触发告警检查

### 经验教训
- health-check.mjs 的 JSON 模式参数是  不是 
- admin 用户无法 kill root 进程，需要 
- chat-api.mjs 中的 db.getHealthCheckHistory 不存在于 ctx.db 映射中，需要直接使用 MySQL 连接

## Iter-14: RAG Pipeline — Hybrid Retrieval

**Date**: 2026-03-08

### What was built
- **knowledge_embeddings table**: Stores Float32 embedding vectors per doc chunk in MySQL BLOB
- **rag-utils.mjs**: Chunking (500 token overlap windows), cosine similarity, RRF fusion (k=60)
- **backfill-embeddings.mjs**: Batch vectorize existing docs via OpenAI text-embedding-3-small (1536-dim)
- **Hybrid search**: FTS + Vector parallel via Promise.allSettled, RRF fusion, graceful degradation

### Key bug found and fixed
- **MySQL BLOB Buffer alignment**: `new Float32Array(buf.buffer, buf.byteOffset, ...)` fails when MySQL returns Buffers with `byteOffset % 4 !== 0`. Fix: detect misalignment and copy to aligned ArrayBuffer first.

### Architecture decisions
- OpenAI API called directly (Gateway only supports /v1/chat/completions, not /v1/embeddings)
- Embedding stored as raw Float32 BLOB (6144 bytes per 1536-dim vector) — no base64 overhead
- RRF fusion with k=60 balances FTS precision and vector recall
- Graceful degradation: if vector search fails, falls back to FTS-only; if both fail, falls back to LIKE

### Verification
- Hybrid search returns results with `rrfScore`, `sources: ["fts", "vector"]`
- Vector-only results (e.g., KOL guide for "Lootbar充值" query) prove semantic recall value
- CI Gate 7/7 passed
