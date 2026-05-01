# RangerAI 前后端代码映射手册

> 本文档为 RangerAI 系统的**前后端代码对应关系全景图**，旨在让维护者（包括 AI Agent）能够精准定位每个功能模块的前端页面、后端 API、数据库表、WebSocket 事件之间的关联关系，从而实现准确的代码修改和功能维护。

---

## 1. 系统架构速览

RangerAI 采用前后端分离架构，前端为 React SPA，后端为 Node.js 自研 HTTP + WebSocket 服务器，数据库使用 SQLite。核心通信方式有三种：HTTP REST API（功能操作）、WebSocket（实时聊天）、IPC（主进程与 Worker 通信）。

### 1.1 端口与服务映射

| 端口 | 服务 | 说明 |
|------|------|------|
| 443 (HTTPS) | Caddy | 反向代理，TLS 终端 |
| 3001 | file-server.mjs | 文件上传/下载、OSS 签名、余额查询 |
| 3002 | server.mjs (主进程) | HTTP API + WebSocket 服务 |
| 3003 | ACP API | Agent Communication Protocol |
| 3004 | Grafana | 监控仪表盘 |
| 9090 | Prometheus | 指标采集 |
| 9093 | Alertmanager | 告警管理 |
| 18789 | OpenClaw Gateway | AI 模型网关 |

### 1.2 Caddy 路由 → 后端端口映射

| URL 路径 | 目标端口 | 目标服务 |
|----------|---------|---------|
| `/upload` | 3001 | file-server |
| `/files/*` | 3001 | file-server |
| `/workspace/*` | 3001 | file-server |
| `/_share/*` | 3001 | file-server |
| `/health` | 3001 | file-server |
| `/ws` | 3002 | WebSocket (server.mjs) |
| `/api/auth*` | 3002 | auth-api.mjs |
| `/api/chats*` | 3002 | chat-api.mjs |
| `/api/knowledge*` | 3002 | knowledge-api.mjs |
| `/api/tickets*` | 3002 | ticket-kol-api.mjs |
| `/api/kols*` | 3002 | ticket-kol-api.mjs |
| `/api/notifications*` | 3002 | ticket-kol-api.mjs |
| `/api/workflows*` | 3002 | workflow-api.mjs |
| `/api/admin/*` | 3002 | user-management-api.mjs |
| `/api/users*` | 3002 | chat-api.mjs / user-management-api.mjs |
| `/api/prompts*` | 3002 | system-api.mjs |
| `/api/stats*` | 3002 | system-api.mjs |
| `/api/system*` | 3002 | system-api.mjs |
| `/api/tiktok*` | 3002 | server.mjs (TikTok 模块) |
| `/api/task*` | 3002 | server.mjs |
| `/api/session*` | 3002 | server.mjs |
| `/api/models*` | 3002 | server.mjs |
| `/api/audit-logs*` | 3002 | workflow-api.mjs |
| `/api/messages*` | 3002 | server.mjs |
| `/api/roles*` | 3002 | server.mjs |
| `/api/*` (fallback) | 3004 | OpenClaw Gateway |
| `/acp/*` | 3003 | ACP API |
| `/grafana/*` | 3004 | Grafana |
| `/*` (SPA fallback) | 静态文件 | /var/www/rangerai |

---

## 2. 前端页面 → 后端 API 完整映射

以下表格列出每个前端页面组件、对应的 URL 路由、调用的后端 API 端点、以及涉及的数据库表。这是维护时最核心的参考。

### 2.1 聊天核心

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `ChatPage.js` | `/` (默认) | `GET /api/chats` | chats | 获取会话列表 |
| | | `POST /api/chats` | chats | 创建新会话 |
| | | `DELETE /api/chats/:id` | chats, messages | 删除会话 |
| | | `POST /api/chats/batch-delete` | chats, messages | 批量删除 |
| | | `GET /api/chats/search` | chats | 搜索会话 |
| | | `GET /api/chats/tags` | chats | 获取标签列表 |
| | | `GET /api/chats/by-tag/:tag` | chats | 按标签筛选 |
| | | `GET /api/chats/shared-with-me` | shared_chats, chats | 共享给我的 |
| | | `POST /api/chats/:id/share` | shared_chats | 分享会话 |
| | | `GET /api/chats/:id/shares` | shared_chats | 获取分享列表 |
| | | `DELETE /api/chats/:id/share/:userId` | shared_chats | 取消分享 |
| | | `PATCH /api/chats/:id/tags` | chats | 更新标签 |
| | | `POST /api/chats/:id/messages` | messages | 发送消息 (HTTP) |
| | | `POST /api/chats/:id/regenerate/:messageId` | messages | 重新生成 |
| | | `GET /api/knowledge/search` | knowledge_docs | RAG 知识检索 |
| | | `GET /api/system/ai-roles` | ai_roles | 获取 AI 角色列表 |
| | | `GET /api/workflows` | workflows | 获取工作流列表 |
| | | `GET /api/notifications/unread-count` | notifications | 未读通知数 |
| | | `POST /upload` | (文件系统) | 上传附件 |
| | | `GET /api/workspace/file` | (文件系统) | 获取工作区文件 |
| | | **WebSocket `/ws`** | messages, chats | 实时聊天通信 |

### 2.2 知识库

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `KnowledgeBase.js` | `/knowledge` | `GET /api/knowledge` | knowledge_docs | 文档列表（分页） |
| | | `POST /api/knowledge` | knowledge_docs, knowledge_docs_fts | 上传文档 |
| | | `GET /api/knowledge/:id` | knowledge_docs | 获取文档详情 |
| | | `PATCH /api/knowledge/:id` | knowledge_docs, knowledge_docs_fts | 更新文档 |
| | | `DELETE /api/knowledge/:id` | knowledge_docs, knowledge_docs_fts | 删除文档 |
| | | `GET /api/knowledge/categories` | knowledge_docs | 分类列表 |
| | | `POST /api/knowledge/search` | knowledge_docs, knowledge_docs_fts | 搜索文档 |
| | | `POST /api/knowledge/:id/retry-embedding` | knowledge_docs | 重试向量化 |
| | | `GET /api/knowledge/:id/embedding-status` | knowledge_docs | 向量化状态 |
| `SearchDebug.js` | `/search-debug` | `POST /api/knowledge/search-debug` | knowledge_docs, knowledge_docs_fts | 搜索调试 |
| | | `POST /api/knowledge/rebuild-fts` | knowledge_docs_fts | 重建 FTS 索引 |

### 2.3 工单管理

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `TicketManager.js` | `/tickets` | `GET /api/tickets` | tickets | 工单列表 |
| | | `POST /api/tickets` | tickets | 创建工单 |
| | | `GET /api/tickets/:id` | tickets | 工单详情 |
| | | `PATCH /api/tickets/:id` | tickets | 更新工单 |
| | | `DELETE /api/tickets/:id` | tickets | 删除工单 |
| | | `POST /api/tickets/ai-classify` | tickets | AI 分类 |
| | | `GET /api/tickets/stats` | tickets | 工单统计 |
| | | `GET /api/tickets/trend` | tickets | 趋势数据 |

### 2.4 KOL 管理

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `KolManager.js` | `/kols` | `GET /api/kols` | kols | KOL 列表 |
| | | `POST /api/kols` | kols | 添加 KOL |
| | | `PATCH /api/kols/:id` | kols | 更新 KOL |
| | | `DELETE /api/kols/:id` | kols | 删除 KOL |
| | | `GET /api/kols/stats` | kols | KOL 统计 |
| `KolDetail.js` | `/kols/:id` | `GET /api/kols/:id` | kols, kol_cooperations | KOL 详情 |
| | | `POST /api/kols/:id/cooperations` | kol_cooperations | 添加合作记录 |
| | | `PATCH /api/kols/:id/cooperations/:cid` | kol_cooperations | 更新合作 |
| | | `DELETE /api/kols/:id/cooperations/:cid` | kol_cooperations | 删除合作 |

### 2.5 TikTok 运营

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `TikTokPartners.js` | `/tiktok-partners` | `GET /api/tiktok` | (TikTok 模块) | 达人列表 |
| | | `POST /api/tiktok` | (TikTok 模块) | 添加达人 |
| `TikTokScriptGen.js` | `/tiktok-scripts` | `POST /api/tiktok/generate-script` | (LLM 调用) | AI 脚本生成 |

### 2.6 工作流

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `WorkflowEditor.js` | `/workflows` | `GET /api/workflows` | workflows | 工作流列表 |
| | | `POST /api/workflows` | workflows | 创建工作流 |
| | | `GET /api/workflows/:id` | workflows | 工作流详情 |
| | | `PATCH /api/workflows/:id` | workflows | 更新工作流 |
| | | `DELETE /api/workflows/:id` | workflows | 删除工作流 |
| | | `POST /api/workflows/:id/run` | workflows, workflow_runs | 执行工作流 |
| | | `GET /api/workflows/:id/runs` | workflow_runs | 执行记录 |

### 2.7 团队与用户管理

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `TeamManagement.js` | `/team` | `GET /api/admin/users` | users, departments | 用户列表 |
| | | `POST /api/admin/users` | users | 创建用户 |
| | | `PATCH /api/admin/users/:id` | users | 更新用户 |
| | | `DELETE /api/admin/users/:id` | users | 停用用户 |
| | | `POST /api/admin/users/:id/reset-password` | users | 重置密码 |
| | | `GET /api/admin/departments` | departments | 部门列表 |
| | | `POST /api/admin/departments` | departments | 创建部门 |
| | | `PATCH /api/admin/departments/:id` | departments | 更新部门 |
| | | `DELETE /api/admin/departments/:id` | departments | 删除部门 |
| | | `GET /api/admin/org-tree` | users, departments | 组织架构树 |
| `InviteCodesPage.js` | `/invite-codes` | `GET /api/auth/invite-codes` | invite_codes | 邀请码列表 |
| | | `POST /api/auth/invite-codes` | invite_codes | 生成邀请码 |
| | | `DELETE /api/auth/invite-codes/:id` | invite_codes | 删除邀请码 |

### 2.8 系统管理与仪表盘

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `AdminDashboard.js` | `/admin` | `GET /api/system/health-detail` | (系统状态) | 系统健康 |
| | | `GET /api/system/config` | system_config | 系统配置 |
| | | `PUT /api/system/config` | system_config | 更新配置 |
| | | `GET /api/system/audit-logs` | audit_logs | 审计日志 |
| | | `GET /api/system/ai-roles` | ai_roles | AI 角色管理 |
| | | `POST /api/system/ai-roles` | ai_roles | 创建 AI 角色 |
| | | `PUT /api/system/ai-roles/:id` | ai_roles | 更新 AI 角色 |
| | | `DELETE /api/system/ai-roles/:id` | ai_roles | 删除 AI 角色 |
| | | `GET /api/stats/users` | users, chats, messages | 用户统计 |
| | | `GET /api/tickets/stats` | tickets | 工单统计 |
| | | `GET /api/tickets/trend` | tickets | 工单趋势 |
| | | `GET /api/kols/stats` | kols | KOL 统计 |
| | | `GET /api/tickets/assign-rules` | assign_rules | 分配规则 |
| | | `POST /api/tickets/assign-rules` | assign_rules | 创建规则 |
| | | `PATCH /api/tickets/assign-rules/:id` | assign_rules | 更新规则 |
| | | `DELETE /api/tickets/assign-rules/:id` | assign_rules | 删除规则 |
| | | `GET /api/tasks/active` | (运行时) | 活跃任务 |
| | | `GET /api/users/` | users | 用户列表 |
| | | `POST /api/admin/recover-browser` | (运行时) | 恢复浏览器 |
| | | `POST /api/admin/reset-browser-breaker` | (运行时) | 重置熔断器 |
| `StatsPage.js` | `/stats` | `GET /api/stats` | chats, messages, users | 综合统计 |
| | | `GET /api/stats/routing` | (运行时) | 路由统计 |
| `PromptTemplates.js` | `/prompts` | `GET /api/prompts` | quick_prompts | 提示词列表 |
| | | `POST /api/prompts` | quick_prompts | 创建提示词 |
| | | `PUT /api/prompts/:id` | quick_prompts | 更新提示词 |
| | | `DELETE /api/prompts/:id` | quick_prompts | 删除提示词 |
| | | `POST /api/prompts/:id/use` | quick_prompts | 使用计数 |

### 2.9 业务仪表盘

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `CeoDashboard.js` | `/ceo` | `GET /api/stats/market-prices` | (外部数据) | 市场价格 |
| | | `GET /api/system/inspection-logs` | (系统日志) | 巡检日志 |
| `GlobalDashboard.js` | `/dashboard` | (聚合多个 API) | 多表 | 全局仪表盘 |
| `DailyReports.js` | `/daily-reports` | (聚合统计 API) | 多表 | 日报 |
| `DataAnalytics.js` | `/data-analytics` | `GET /api/stats/loss-rates` | (业务数据) | 损耗率分析 |
| | | `GET /api/stats/market-prices` | (外部数据) | 市场价格 |
| `InventoryMonitor.js` | `/inventory` | `GET /api/inventory` | (库存数据) | 库存监控 |
| `OperationalEfficiency.js` | `/ops-efficiency` | (聚合统计 API) | 多表 | 运营效率 |
| `TaskQueue.js` | `/tasks` | `GET /api/chats` | chats | 任务列表 |
| | | `GET /api/stats/summary` | 多表 | 统计摘要 |

### 2.10 通知中心

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| `NotificationCenter.js` | `/notifications` | `GET /api/notifications` | notifications | 通知列表 |
| | | `GET /api/notifications/unread-count` | notifications | 未读数 |
| | | `PATCH /api/notifications/:id/read` | notifications | 标记已读 |
| | | `POST /api/notifications/read-all` | notifications | 全部已读 |
| | | `DELETE /api/notifications/:id` | notifications | 删除通知 |

### 2.11 认证（共享模块，非独立页面）

| 前端文件 | 路由 | 调用的后端 API | 涉及的 DB 表 | 说明 |
|---------|------|--------------|-------------|------|
| (LoginPage 内嵌) | `/login` | `POST /api/auth/login` | users | 登录 |
| | | `POST /api/auth/register` | users, invite_codes | 注册 |
| (全局 Hook) | — | `GET /api/auth/me` | users | 获取当前用户 |
| | | `POST /api/auth/logout` | — | 登出 |
| | | `POST /api/auth/change-password` | users | 修改密码 |

---

## 3. 后端 API 模块 → 数据库表 → 前端页面 反向映射

以下从后端 API 模块的角度，反向映射到前端页面，方便从后端修改时快速定位受影响的前端。

### 3.1 auth-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/auth/login` | POST | users | LoginPage | 公开 |
| `/api/auth/register` | POST | users, invite_codes | LoginPage | 公开 |
| `/api/auth/me` | GET | users | 全局 useAuth Hook | 需登录 |
| `/api/auth/logout` | POST | — | 全局 | 需登录 |
| `/api/auth/invite-codes` | GET | invite_codes | InviteCodesPage | admin |
| `/api/auth/invite-codes` | POST | invite_codes | InviteCodesPage | admin |
| `/api/auth/invite-codes/:id` | DELETE | invite_codes | InviteCodesPage | admin |

### 3.2 chat-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/chats` | GET | chats | ChatPage (Sidebar) | 需登录 |
| `/api/chats` | POST | chats | ChatPage | 需登录 |
| `/api/chats/:id` | GET | chats, messages | ChatPage | 需登录 |
| `/api/chats/:id` | DELETE | chats, messages | ChatPage (Sidebar) | 需登录 |
| `/api/chats/batch-delete` | POST | chats, messages | ChatPage (Sidebar) | 需登录 |
| `/api/chats/search` | GET | chats | ChatPage (搜索) | 需登录 |
| `/api/chats/tags` | GET | chats | ChatPage (Sidebar) | 需登录 |
| `/api/chats/by-tag/:tag` | GET | chats | ChatPage (Sidebar) | 需登录 |
| `/api/chats/shared-with-me` | GET | shared_chats, chats | ChatPage (Sidebar) | 需登录 |
| `/api/chats/:id/share` | POST | shared_chats | ChatPage | 需登录 |
| `/api/chats/:id/shares` | GET | shared_chats | ChatPage | 需登录 |
| `/api/chats/:id/share/:userId` | DELETE | shared_chats | ChatPage | 需登录 |
| `/api/chats/:id/tags` | PATCH | chats | ChatPage | 需登录 |
| `/api/chats/:id/messages` | POST | messages | ChatPage | 需登录 |
| `/api/chats/:id/regenerate/:messageId` | POST | messages | ChatPage | 需登录 |
| `/api/chats/stats` | GET | chats, messages | TaskQueue | 需登录 |
| `/api/users` | GET | users | ChatPage (分享选人) | 需登录 |

### 3.3 knowledge-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/knowledge` | GET | knowledge_docs | KnowledgeBase | 需登录 |
| `/api/knowledge` | POST | knowledge_docs, knowledge_docs_fts | KnowledgeBase | 需登录 |
| `/api/knowledge/categories` | GET | knowledge_docs | KnowledgeBase | 需登录 |
| `/api/knowledge/search` | POST | knowledge_docs, knowledge_docs_fts | ChatPage (RAG), KnowledgeBase | 需登录 |
| `/api/knowledge/search-debug` | POST | knowledge_docs, knowledge_docs_fts | SearchDebug | 需登录 |
| `/api/knowledge/rebuild-fts` | POST | knowledge_docs_fts | SearchDebug | admin |
| `/api/knowledge/:id` | GET | knowledge_docs | KnowledgeBase | 需登录 |
| `/api/knowledge/:id` | PATCH | knowledge_docs, knowledge_docs_fts | KnowledgeBase | 需登录 |
| `/api/knowledge/:id` | DELETE | knowledge_docs, knowledge_docs_fts | KnowledgeBase | 需登录 |
| `/api/knowledge/:id/retry-embedding` | POST | knowledge_docs | KnowledgeBase | 需登录 |
| `/api/knowledge/:id/embedding-status` | GET | knowledge_docs | KnowledgeBase | 需登录 |
| `/api/knowledge/:id/references` | POST | knowledge_references | ChatPage | 需登录 |
| `/api/messages/:id/references` | GET | knowledge_references | ChatPage | 需登录 |

### 3.4 system-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/health` | GET | — | 监控 | 公开 |
| `/api/version` | GET | — | 全局 | 公开 |
| `/api/stats` | GET | chats, messages, users | StatsPage | 需登录 |
| `/api/stats/routing` | GET | (运行时) | StatsPage | 需登录 |
| `/api/stats/summary` | GET | 多表 | TaskQueue | 需登录 |
| `/api/stats/users` | GET | users, chats, messages | AdminDashboard | admin |
| `/api/prompts` | GET | quick_prompts | PromptTemplates, ChatPage | 需登录 |
| `/api/prompts/all` | GET | quick_prompts | PromptTemplates | admin |
| `/api/prompts` | POST | quick_prompts | PromptTemplates | admin |
| `/api/prompts/:id` | PUT | quick_prompts | PromptTemplates | admin |
| `/api/prompts/:id` | DELETE | quick_prompts | PromptTemplates | admin |
| `/api/prompts/:id/use` | POST | quick_prompts | ChatPage | 需登录 |
| `/api/system/status` | GET | (运行时) | AdminDashboard | 需登录 |
| `/api/system/health-detail` | GET | (运行时) | AdminDashboard | 需登录 |
| `/api/system/config` | GET | system_config | AdminDashboard | 需登录 |
| `/api/system/config` | PUT | system_config | AdminDashboard | admin |
| `/api/system/audit-logs` | GET | audit_logs | AdminDashboard | admin |
| `/api/system/ai-roles` | GET | ai_roles | AdminDashboard, ChatPage | 需登录 |

### 3.5 ticket-kol-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/tickets` | GET | tickets | TicketManager | 需登录 |
| `/api/tickets` | POST | tickets | TicketManager | 需登录 |
| `/api/tickets/:id` | GET | tickets | TicketManager | 需登录 |
| `/api/tickets/:id` | PATCH | tickets | TicketManager | 需登录 |
| `/api/tickets/:id` | DELETE | tickets | TicketManager | 需登录 |
| `/api/tickets/stats` | GET | tickets | AdminDashboard, TicketManager | 需登录 |
| `/api/tickets/trend` | GET | tickets | AdminDashboard | 需登录 |
| `/api/tickets/ai-classify` | POST | tickets | TicketManager | 需登录 |
| `/api/tickets/assign-rules` | GET | assign_rules | AdminDashboard | admin |
| `/api/tickets/assign-rules` | POST | assign_rules | AdminDashboard | admin |
| `/api/tickets/assign-rules/:id` | PATCH | assign_rules | AdminDashboard | admin |
| `/api/tickets/assign-rules/:id` | DELETE | assign_rules | AdminDashboard | admin |
| `/api/kols` | GET | kols | KolManager | 需登录 |
| `/api/kols` | POST | kols | KolManager | 需登录 |
| `/api/kols/:id` | GET | kols, kol_cooperations | KolDetail | 需登录 |
| `/api/kols/:id` | PATCH | kols | KolManager, KolDetail | 需登录 |
| `/api/kols/:id` | DELETE | kols | KolManager | 需登录 |
| `/api/kols/stats` | GET | kols | AdminDashboard | 需登录 |
| `/api/notifications` | GET | notifications | NotificationCenter | 需登录 |
| `/api/notifications/unread-count` | GET | notifications | ChatPage (全局) | 需登录 |
| `/api/notifications/:id/read` | PATCH | notifications | NotificationCenter | 需登录 |
| `/api/notifications/read-all` | POST | notifications | NotificationCenter | 需登录 |
| `/api/notifications/:id` | DELETE | notifications | NotificationCenter | 需登录 |

### 3.6 user-management-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/admin/users` | GET | users, departments | TeamManagement | admin/manager |
| `/api/admin/users` | POST | users | TeamManagement | admin |
| `/api/admin/users/:id` | PATCH | users | TeamManagement | admin |
| `/api/admin/users/:id` | DELETE | users | TeamManagement | admin |
| `/api/admin/users/:id/reset-password` | POST | users | TeamManagement | admin |
| `/api/admin/departments` | GET | departments | TeamManagement | admin/manager |
| `/api/admin/departments` | POST | departments | TeamManagement | admin |
| `/api/admin/departments/:id` | PATCH | departments | TeamManagement | admin |
| `/api/admin/departments/:id` | DELETE | departments | TeamManagement | admin |
| `/api/admin/org-tree` | GET | users, departments | TeamManagement | admin/manager |
| `/api/auth/change-password` | POST | users | (用户设置) | 需登录 |

### 3.7 workflow-api.mjs

| API 端点 | 方法 | DB 表 | 前端调用方 | 权限 |
|---------|------|-------|-----------|------|
| `/api/workflows` | GET | workflows | WorkflowEditor, ChatPage | 需登录 |
| `/api/workflows` | POST | workflows | WorkflowEditor | 需登录 |
| `/api/workflows/:id` | GET | workflows | WorkflowEditor | 需登录 |
| `/api/workflows/:id` | PATCH | workflows | WorkflowEditor | 需登录 |
| `/api/workflows/:id` | DELETE | workflows | WorkflowEditor | 需登录 |
| `/api/workflows/:id/run` | POST | workflows, workflow_runs | WorkflowEditor | 需登录 |
| `/api/workflows/:id/runs` | GET | workflow_runs | WorkflowEditor | 需登录 |
| `/api/workflows/:id/runs/:runId` | GET | workflow_runs | WorkflowEditor | 需登录 |
| `/api/audit-logs` | GET | audit_logs | AdminDashboard | admin |

### 3.8 file-server.mjs (端口 3001)

| API 端点 | 方法 | 存储 | 前端调用方 | 说明 |
|---------|------|------|-----------|------|
| `/upload` | POST | 本地文件系统 | ChatPage (附件上传) | multipart 上传 |
| `/files/*` | GET | 本地文件系统 | ChatPage (附件下载) | 静态文件服务 |
| `/workspace/*` | GET | 本地文件系统 | ChatPage (工作区) | 工作区文件 |
| `/_share/*` | GET | 本地文件系统 | (分享链接) | 分享文件 |
| `/api/oss/credential` | POST | — | (前端 OSS 上传) | OSS 签名 |
| `/api/oss/status` | GET | — | (前端) | OSS 状态 |
| `/api/balance` | GET | — | (前端) | OpenRouter 余额 |
| `/health` | GET | — | 监控 | 健康检查 |

---

## 4. WebSocket 事件协议映射

WebSocket 是聊天功能的核心通信通道，连接 `wss://ranger.voyage/ws`，由 Caddy 转发到 `127.0.0.1:3002`。

### 4.1 前端 → 后端（上行事件）

| 事件类型 | 触发场景 | 前端文件 | 后端处理文件 | 说明 |
|---------|---------|---------|------------|------|
| `ping` | 心跳 | useChatStore | ws-handler.mjs | 保活，返回 pong |
| `message` | 发送消息 | useChatStore | ws-handler.mjs → ws-chat-handlers.mjs | 核心聊天 |
| `bind_chat` | 切换会话 | useChatStore | ws-handler.mjs | 绑定 chatId |
| `set_session` | 设置会话 | useChatStore | ws-handler.mjs | 设置 sessionKey |
| `cancel` | 取消生成 | ChatPage | ws-handler.mjs | 中断当前任务 |
| `abort_task` | 中止任务 | ChatPage | ws-handler.mjs | 强制中止 |
| `force_reset` | 强制重置 | ChatPage | ws-handler.mjs | 重置会话状态 |
| `recover_task` | 恢复任务 | ChatPage | ws-handler.mjs | 恢复中断的任务 |
| `user_interrupt` | 用户插入 | ChatPage | ws-handler.mjs | 用户中途插话 |
| `status_update` | 状态更新 | ChatPage | ws-handler.mjs | 更新任务状态 |
| `gateway_api` | Gateway 调用 | AdminDashboard | ws-handler.mjs | 直接调用 Gateway |

### 4.2 后端 → 前端（下行事件）

**主进程发送的事件（modules/*.mjs）：**

| 事件类型 | 来源模块 | 前端处理 | 说明 |
|---------|---------|---------|------|
| `pong` | ws-handler.mjs | useChatStore | 心跳响应 |
| `server_ping` | ws-server.mjs | useChatStore | 服务端主动 ping |
| `thinking` | ws-chat-handlers.mjs | ChatPage (消息气泡) | 思考中内容 |
| `error` | 多个模块 | ChatPage (错误提示) | 错误信息 |
| `status` | ws-chat-handlers.mjs | ChatPage (状态指示器) | idle/busy 状态 |
| `progress` | ws-chat-handlers.mjs | ChatPage (进度条) | 任务进度 |
| `title_update` | ws-chat-handlers.mjs | ChatPage (Sidebar) | 自动生成标题 |
| `suggestions` | ws-chat-handlers.mjs | ChatPage (建议面板) | 后续问题建议 |
| `history` | ws-chat-handlers.mjs | ChatPage | 历史消息加载 |
| `system_notice` | ws-chat-handlers.mjs | ChatPage (通知) | 系统通知 |
| `recovery_status` | ws-chat-handlers.mjs | ChatPage | 恢复状态 |
| `task_recovery` | ws-handler.mjs | ChatPage | 任务恢复 |
| `task_timeout` | ws-handler.mjs | ChatPage | 任务超时 |
| `timeout_warning` | ws-handler.mjs | ChatPage | 超时警告 |
| `chat_bound` | ws-handler.mjs | ChatPage | 会话绑定确认 |
| `session_changed` | ws-handler.mjs | ChatPage | 会话切换 |
| `message_done` | ws-chat-handlers.mjs | ChatPage | 完整消息完成 |
| `stats` | ws-handler.mjs | StatsPage | 实时统计 |

**Worker 进程发送的事件（worker/*.mjs → IPC → 主进程转发）：**

| 事件类型 | 来源模块 | 前端处理 | 说明 |
|---------|---------|---------|------|
| `stream_start` | worker/index.mjs | ChatPage | 流式响应开始 |
| `stream_chunk` | worker/index.mjs | ChatPage (消息气泡) | 流式文本块 |
| `stream_end` | worker/index.mjs | ChatPage | 流式响应结束 |
| `tool_start` | worker/index.mjs | ChatPage (工具面板) | 工具调用开始 |
| `tool_progress` | worker/index.mjs | ChatPage (工具面板) | 工具执行进度 |
| `tool_end` | worker/index.mjs | ChatPage (工具面板) | 工具调用结束 |
| `tool_result` | worker/index.mjs | ChatPage (工具面板) | 工具执行结果 |
| `step` | worker/index.mjs | ChatPage | 执行步骤 |
| `step_update` | worker/index.mjs | ChatPage | 步骤更新 |
| `file_changed` | worker/index.mjs | ChatPage | 文件变更通知 |
| `routing_info` | worker/index.mjs | ChatPage | 路由信息 |
| `browser_status` | worker/index.mjs | AdminDashboard | 浏览器状态 |
| `browser_breaker_reset` | worker/index.mjs | AdminDashboard | 熔断器重置 |
| `gateway_api_response` | worker/index.mjs | AdminDashboard | Gateway 响应 |
| `task_complete` | worker/index.mjs | ChatPage | 任务完成 |
| `task_error` | worker/index.mjs | ChatPage | 任务错误 |
| `worker_ready` | worker/index.mjs | (内部) | Worker 就绪 |

---

## 5. 数据库表 → API → 前端 反向索引

从数据库表出发，快速定位哪些 API 和前端页面会受到表结构变更的影响。

| 数据库表 | 操作该表的 API 模块 | 受影响的前端页面 |
|---------|-------------------|---------------|
| `users` | auth-api, chat-api, system-api, user-management-api | LoginPage, TeamManagement, AdminDashboard, ChatPage |
| `chats` | chat-api, system-api | ChatPage, TaskQueue, StatsPage |
| `messages` | chat-api, knowledge-api, system-api | ChatPage, StatsPage |
| `invite_codes` | auth-api | InviteCodesPage, LoginPage |
| `shared_chats` | chat-api | ChatPage |
| `quick_prompts` | system-api | PromptTemplates, ChatPage |
| `knowledge_docs` | knowledge-api | KnowledgeBase, SearchDebug, ChatPage (RAG) |
| `knowledge_docs_fts` | knowledge-api | KnowledgeBase, SearchDebug, ChatPage (RAG) |
| `knowledge_references` | knowledge-api | ChatPage |
| `workflows` | workflow-api | WorkflowEditor, ChatPage |
| `workflow_runs` | workflow-api | WorkflowEditor |
| `audit_logs` | workflow-api, system-api | AdminDashboard |
| `system_config` | system-api | AdminDashboard |
| `ai_roles` | system-api | AdminDashboard, ChatPage |
| `tickets` | ticket-kol-api | TicketManager, AdminDashboard |
| `ticket_comments` | ticket-kol-api | TicketManager |
| `kols` | ticket-kol-api | KolManager, KolDetail, AdminDashboard |
| `kol_cooperations` | ticket-kol-api | KolDetail |
| `assign_rules` | ticket-kol-api | AdminDashboard |
| `notifications` | ticket-kol-api | NotificationCenter, ChatPage |
| `departments` | user-management-api | TeamManagement |

---

## 6. 后端模块文件索引

### 6.1 主进程 (server.mjs)

| 文件路径 | 职责 | 依赖 |
|---------|------|------|
| `server.mjs` | 入口，HTTP 服务器创建，模块编排 | 所有 API 模块、WS 模块、Worker 模块 |
| `api/auth-api.mjs` | 认证 API（登录/注册/邀请码） | db (DI 注入) |
| `api/chat-api.mjs` | 聊天 API（会话/消息/分享） | db (DI 注入) |
| `api/knowledge-api.mjs` | 知识库 API（文档/搜索/FTS） | db (DI 注入) |
| `api/system-api.mjs` | 系统 API（统计/配置/角色/提示词） | db (DI 注入) |
| `api/ticket-kol-api.mjs` | 工单+KOL+通知 API | db (DI 注入) |
| `api/user-management-api.mjs` | 用户管理 API（部门/组织架构） | db (DI 注入) |
| `api/workflow-api.mjs` | 工作流 API（CRUD/执行/审计） | db (DI 注入) |
| `modules/ws-server.mjs` | WebSocket 服务器创建与心跳 | — |
| `modules/ws-handler.mjs` | WS 消息分发（路由到具体 handler） | ws-chat-handlers, ws-message-handlers |
| `modules/ws-chat-handlers.mjs` | WS 聊天消息处理（发送/限流/超时） | ws-chat-logic, worker-manager |
| `modules/ws-chat-logic.mjs` | WS 聊天核心逻辑（历史压缩/标题生成） | worker-manager, event-buffer |
| `modules/ws-message-handlers.mjs` | WS 其他消息处理 | — |
| `modules/worker-manager.mjs` | Worker 进程管理（spawn/kill/IPC） | worker/index.mjs |
| `modules/worker-crash-recovery.mjs` | Worker 崩溃恢复 | worker-manager |
| `modules/worker-ping-monitor.mjs` | Worker 心跳监控 | worker-manager |
| `modules/event-buffer.mjs` | 事件缓冲区 | — |
| `modules/http-router.mjs` | HTTP 路由分发 | 所有 API 模块 |
| `modules/http-routes.mjs` | HTTP 路由注册 | — |
| `modules/infra-routes.mjs` | 基础设施路由 | — |
| `modules/ai-services.mjs` | AI 服务集成 | — |
| `modules/provider-discovery.mjs` | 模型提供商发现 | — |
| `modules/file-handler.mjs` | 文件处理 | — |
| `modules/helpers.mjs` | 工具函数 | — |

### 6.2 Worker 进程 (worker/)

| 文件路径 | 职责 | 说明 |
|---------|------|------|
| `worker/index.mjs` | Worker 入口，IPC 消息处理 | 接收主进程任务，调用 OpenClaw |
| `worker/openclaw-handler.mjs` | OpenClaw Gateway 调用 | 核心 AI 处理逻辑 |
| `worker/user-message-handler.mjs` | 用户消息预处理 | 消息格式化、上下文构建 |
| `worker/circuit-breaker.mjs` | 熔断器 | Gateway 调用保护 |
| `worker/format-utils.mjs` | 格式化工具 | 消息格式转换 |
| `worker/ipc-utils.mjs` | IPC 通信工具 | 主进程-Worker 通信 |

### 6.3 基础库 (lib/)

| 文件路径 | 职责 |
|---------|------|
| `lib/context.mjs` | 全局上下文（DI 容器） |
| `lib/context-setup.mjs` | 上下文初始化 |
| `lib/bootstrap.mjs` | 启动引导 |
| `lib/logger.mjs` | 日志系统 |
| `lib/metrics-collector.mjs` | 指标采集 |
| `lib/rag-utils.mjs` | RAG 检索工具 |
| `lib/signals.mjs` | 信号处理 |
| `lib/schemas/` | 数据验证 Schema |

### 6.4 独立服务

| 文件路径 | 端口 | 职责 |
|---------|------|------|
| `file-server.mjs` | 3001 | 文件上传/下载、OSS 签名、余额查询 |

---

## 7. 前端文件索引

### 7.1 页面组件 (编译后位于 /var/www/rangerai1/assets/)

| 编译文件 | 对应源页面 | 路由 |
|---------|-----------|------|
| `ChatPage-*.js` | ChatPage | `/` |
| `KnowledgeBase-*.js` | KnowledgeBase | `/knowledge` |
| `KolManager-*.js` | KolManager | `/kols` |
| `KolDetail-*.js` | KolDetail | `/kols/:id` |
| `TicketManager-*.js` | TicketManager | `/tickets` |
| `AdminDashboard-*.js` | AdminDashboard | `/admin` |
| `CeoDashboard-*.js` | CeoDashboard | `/ceo` |
| `GlobalDashboard-*.js` | GlobalDashboard | `/dashboard` |
| `TeamManagement-*.js` | TeamManagement | `/team` |
| `WorkflowEditor-*.js` | WorkflowEditor | `/workflows` |
| `PromptTemplates-*.js` | PromptTemplates | `/prompts` |
| `StatsPage-*.js` | StatsPage | `/stats` |
| `TaskQueue-*.js` | TaskQueue | `/tasks` |
| `InviteCodesPage-*.js` | InviteCodesPage | `/invite-codes` |
| `TikTokPartners-*.js` | TikTokPartners | `/tiktok-partners` |
| `TikTokScriptGen-*.js` | TikTokScriptGen | `/tiktok-scripts` |
| `DailyReports-*.js` | DailyReports | `/daily-reports` |
| `DataAnalytics-*.js` | DataAnalytics | `/data-analytics` |
| `InventoryMonitor-*.js` | InventoryMonitor | `/inventory` |
| `OperationalEfficiency-*.js` | OperationalEfficiency | `/ops-efficiency` |
| `NotificationCenter-*.js` | NotificationCenter | `/notifications` |
| `SearchDebug-*.js` | SearchDebug | `/search-debug` |

### 7.2 共享模块 (编译在 index-*.js 中)

| 模块 | 职责 | 涉及的 API |
|------|------|-----------|
| useChatStore | 聊天状态管理（约 1310 行） | `/api/chats/*`, WebSocket |
| useAuth Hook | 认证状态 | `/api/auth/me`, `/api/auth/logout` |
| api.ts (uploadFiles) | 文件上传 | `/upload` |
| api.ts (login/register) | 认证 | `/api/auth/login`, `/api/auth/register` |
| DashboardLayout | 侧边栏布局 | — |
| i18n | 多语言（zh-CN/zh-TW/en） | — |

---

## 8. 修改指南：常见场景的完整修改路径

### 8.1 添加新的数据库表

1. **创建表**：在 SQLite 中执行 `CREATE TABLE` SQL（`/opt/rangerai-agent/rangerai.db`）
2. **添加 DB 操作**：在对应的 `api/*.mjs` 中添加 `db.*` 方法调用
3. **添加 API 端点**：在对应的 `api/*.mjs` 中添加路由处理
4. **添加 Caddy 路由**（如果是新的 URL 前缀）：编辑 `/etc/caddy/conf.d/10-ranger-main.caddy`
5. **前端页面**：创建新的页面组件，在路由中注册
6. **前端 API 调用**：使用 `fetch` 调用新端点
7. **重新构建前端**：`cd /opt/rangerai-agent && pnpm build`
8. **重启后端**：`sudo systemctl restart rangerai-agent`

### 8.2 修改现有 API 的返回字段

1. **定位 API 模块**：查看第 3 节的反向映射表
2. **修改后端**：编辑 `api/*.mjs` 中的对应端点
3. **定位前端页面**：查看第 2 节的映射表，找到所有调用该 API 的页面
4. **修改前端**：更新所有使用该字段的组件
5. **测试**：确保所有调用方都已更新

### 8.3 添加新的前端页面

1. **创建页面组件**：在 `src/pages/` 下创建 `.tsx` 文件
2. **注册路由**：在 `App.tsx` 中添加 `<Route>`
3. **添加侧边栏入口**：在 `DashboardLayout.tsx` 的导航配置中添加
4. **调用 API**：使用 `fetch` 或 WebSocket 与后端通信
5. **构建部署**：`pnpm build` 后复制到 `/var/www/rangerai1/`

### 8.4 修改 WebSocket 事件

1. **后端发送方**：查看第 4.2 节定位来源模块
2. **修改事件格式**：编辑对应的 `modules/ws-*.mjs` 或 `worker/*.mjs`
3. **前端接收方**：修改 `useChatStore` 中的 WS 消息处理逻辑
4. **注意**：WS 事件修改需要前后端同步，否则会导致消息丢失

### 8.5 添加新的 API 模块

1. **创建文件**：`api/new-feature-api.mjs`，遵循 DI 模式（`export function init(deps) { ... }`）
2. **注册模块**：在 `server.mjs` 中 `import` 并在 HTTP 路由中注册
3. **添加 Caddy 路由**：在 `/etc/caddy/conf.d/10-ranger-main.caddy` 中添加 `handle /api/new-feature*`
4. **重载 Caddy**：`sudo systemctl reload caddy`

---

## 9. 角色权限矩阵

| 角色 | 代码值 | 可访问的前端页面 | 可调用的 API 范围 |
|------|--------|---------------|-----------------|
| admin | `'admin'` | 全部页面 | 全部 API |
| manager | `'manager'` | 除 admin 外的全部 | 用户管理（只读）、部门管理 |
| member | `'member'` | 聊天、知识库、工单、KOL、工作流 | 基础 CRUD |
| viewer | `'viewer'` | 只读页面 | 只读 API |
| cs | `'cs'` | 聊天、工单 | 聊天和工单相关 |

权限检查在后端 API 层通过 `db.extractUserFromRequest(req)` 获取用户角色后进行判断。前端通过 `useAuth().user?.role` 控制导航菜单显示。

---

## 10. 部署后的文件位置速查

| 用途 | 路径 |
|------|------|
| 后端代码 | `/opt/rangerai-agent/` |
| 后端 API 模块 | `/opt/rangerai-agent/api/` |
| 后端 Worker | `/opt/rangerai-agent/worker/` |
| 后端模块 | `/opt/rangerai-agent/modules/` |
| 后端基础库 | `/opt/rangerai-agent/lib/` |
| 文件服务器 | `/opt/rangerai-agent/file-server.mjs` |
| 前端构建产物 | `/var/www/rangerai1/` (当前版本) |
| 前端备用目录 | `/var/www/rangerai/` |
| 上传文件存储 | `/opt/rangerai-agent/uploads/` |
| 下载文件服务 | `/opt/rangerai-agent/files/` |
| 数据库文件 | `/opt/rangerai-agent/rangerai.db` |
| Caddy 配置 | `/etc/caddy/conf.d/10-ranger-main.caddy` |
| systemd 服务 | `/etc/systemd/system/rangerai-*.service` |
| 环境变量 | `/opt/rangerai-agent/agent-secrets.env` |
| 日志目录 | `/opt/rangerai-agent/logs/` |
| 文档目录 | `/opt/rangerai-agent/docs/` |

---

*本文档由 Manus AI 于 2026 年 3 月 11 日生成，基于 RangerAI v69 代码库分析。*
