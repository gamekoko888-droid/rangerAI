
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

## Lesson 22: 后端 Bug 修复强化训练（2026-03-06）
**总分：35/100**

### Task 1（0/50）：/api/health version Bug
- 消息发送后 Gateway 重启导致任务中断
- RangerAI 未能执行任何步骤
- 根因：服务重启时机不当

### Task 2（35/50）：ai-helpers.mjs generateSuggestions Bug
- **定位 Bug**：15/15 — 7步内准确找到 s.length <= 5
- **修复正确**：15/20 — 改为 30（非原始值50），功能可用但不精确
- **验证完整**：0/10 — 执行 systemctl restart 后自己被杀，无法发送回复
- **效率**：5/5 — 7步完成，在≤8步预算内

### 关键发现
1. **自杀式重启**：RangerAI 直接执行 systemctl restart 导致自己被杀
2. **修复值不精确**：选择了 30 而非原始 50，说明缺乏对原始值的推理
3. **已添加 SOUL.md 24a 规则**：先回复再延迟重启

### server.mjs 重构（同日完成）
- 从 3,616 行拆分为 3,043 行（-573行，-15.8%）
- 提取 3 个独立模块：event-buffer-module.mjs, ai-helpers.mjs, skills-discovery.mjs
- 部署后所有 API 和 Gateway 连接正常

### Worker 泄漏修复 v59（同日完成）
- agent-worker.mjs 重连逻辑：指数退避 + 最大10次 + terminate 标志
- server.mjs v73：finally 块保存部分回复到数据库
