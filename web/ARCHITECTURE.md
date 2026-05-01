# RangerAI 系统架构文档

> **版本**: v4.1 (2026-03-14)
> **适用范围**: 游侠出海 AI 中台 — 前后端完整架构映射
> **目的**: 供 Ranger（AI Agent）及人类开发者对照维护系统，理解每个模块的职责、边界和通信方式

---

## 一、系统定位

RangerAI 是游侠出海团队的 **AI 中台协作工具**，底层基于 **OpenClaw**（AI Agent 引擎），为客服、运营、市场、财务等团队提供智能对话、知识库、工单管理、KOL 管理、工作流自动化等能力。系统采用 HTTP + WebSocket 混合通信架构，前端 React SPA 通过 Caddy 反向代理与后端 Node.js 服务集群通信。

---

## 二、部署拓扑

### 2.1 服务器信息

| 项目 | 值 |
|------|-----|
| **服务器** | 阿里云 ECS (8.219.186.244) |
| **操作系统** | Ubuntu 22.04 |
| **域名** | ranger.voyage |
| **SSL** | Caddy 自动 HTTPS (Let's Encrypt) |
| **Gateway 子域名** | gw.ranger.voyage |

### 2.2 端口分配

| 端口 | 服务 | systemd 单元 | 说明 |
|------|------|-------------|------|
| **80/443** | Caddy | caddy.service | 反向代理 + SSL 终止 + SPA 静态文件 |
| **3000** | rangerai-static | rangerai-static.service | 前端静态文件服务（备用） |
| **3001** | rangerai-agent | rangerai-agent.service | 后端主服务（HTTP API + WebSocket） |
| **3002** | rangerai-web | rangerai-web.service | 后端 Web 服务（部分 API 路由） |
| **3003** | rangerai-acp | rangerai-acp.service | ACP Bridge（钉钉 + API Gateway） |
| **3004** | rangerai-fileserver | rangerai-fileserver.service | 文件服务器 |
| **18789** | OpenClaw Gateway | — | OpenClaw 核心引擎 |

### 2.3 Caddy 路由规则

Caddy 作为统一入口，根据 URL 路径将请求分发到不同后端服务：

| URL 模式 | 目标 | 说明 |
|----------|------|------|
| `/ws` | 127.0.0.1:3001 | WebSocket 连接（主服务） |
| `/api/chats/*`, `/api/messages/*`, `/api/search/*` | 127.0.0.1:3001 | 聊天相关 API |
| `/api/auth/*` | 127.0.0.1:3001 | 认证 API |
| `/api/stats/*`, `/api/health/*`, `/api/version/*` | 127.0.0.1:3001 | 系统状态 API |
| `/api/knowledge/*` | 127.0.0.1:3001 | 知识库 API |
| `/api/workflows/*`, `/api/audit-logs` | 127.0.0.1:3001 | 工作流 API |
| `/api/tickets/*`, `/api/kols/*`, `/api/notifications/*` | 127.0.0.1:3002 | 工单/KOL/通知 |
| `/api/users/*`, `/api/teams/*`, `/api/roles/*` | 127.0.0.1:3002 | 用户管理 |
| `/admin/*` | 127.0.0.1:3002 | 管理后台 |
| `/acp/*` | 127.0.0.1:3003 | ACP Bridge |
| `/api/*`（兜底） | 127.0.0.1:3004 | OpenClaw Gateway |
| `gw.ranger.voyage` | 127.0.0.1:18789 | Gateway 直连子域名 |
| 其他路径 | /var/www/rangerai | SPA 静态文件 |

---

## 三、后端架构

### 3.1 目录结构总览

```
/opt/rangerai-agent/
├── server.mjs                 # [入口] v68 — 启动编排器（不含业务逻辑）
├── database.mjs               # [Facade] v4 — 统一数据库导出门面
├── db-adapter.mjs             # [底层] 数据库适配器（MySQL/SQLite 双模）
├── gateway-connector.mjs      # [核心] OpenClaw Gateway 连接器
├── acp-bridge.mjs             # [独立] ACP Bridge（钉钉集成）
├── task-store.mjs             # [核心] 任务状态存储
├── tiktok-api.mjs             # [业务] TikTok 数据 API
├── knowledge-db.mjs           # [业务] 知识库数据层
├── embedding-cache.mjs        # [业务] 向量嵌入缓存
│
├── api/                       # ── HTTP API 模块（DI 初始化）──
│   ├── auth-api.mjs           # 认证：login/register/me/logout/invite-codes
│   ├── chat-api.mjs           # 聊天路由层（v3.0 瘦身版，306 行）→ 委托 ChatOrchestrator
│   ├── system-api.mjs         # 系统：health/version/stats/prompts/ai-roles
│   ├── knowledge-api.mjs      # 知识库：文档 CRUD + RAG 搜索 + 引用
│   ├── ticket-kol-api.mjs     # 工单 + KOL 管理
│   ├── workflow-api.mjs       # 工作流：CRUD + 执行 + 审计日志
│   ├── user-management-api.mjs # 用户/团队/角色管理
│   └── report-api.mjs         # 报表 API
│
├── modules/                   # ── 核心模块 ──
│   ├── http-router.mjs        # HTTP 路由分发器（薄层）
│   ├── ws-handler.mjs         # WebSocket 连接管理 + 消息分发（纯 Dispatch 层）
│   ├── ws-control-handlers.mjs # WS 控制处理（bind_chat, recover, cancel, abort 等 9 个操作）
│   ├── ws-chat-handlers.mjs   # WS 聊天处理（发送消息、生成标题）
│   ├── ws-message-handlers.mjs # WS 消息处理（兼容保留）
│   ├── ws-chat-logic.mjs      # WS 聊天业务逻辑
│   ├── ws-server.mjs          # WebSocket 服务器创建
│   ├── worker-manager.mjs     # Worker 进程管理器
│   ├── worker-crash-recovery.mjs # Worker 崩溃恢复
│   ├── worker-ping-monitor.mjs # Worker 心跳监控
│   ├── event-buffer.mjs       # 事件缓冲（断连重连）
│   ├── ai-services.mjs        # AI 服务调用封装
│   ├── provider-discovery.mjs # OpenClaw Provider 发现
│   ├── helpers.mjs            # 通用工具函数
│   ├── file-handler.mjs       # 文件处理
│   └── routes/                # HTTP 子路由
│       ├── admin-routes.mjs   # 管理路由（浏览器管理、熔断器、重启）
│       ├── task-routes.mjs    # 任务路由（轮询、取消、活跃任务）
│       ├── infra-routes.mjs   # 基础设施路由（health、metrics、workspace）
│       └── static-routes.mjs  # 静态文件路由
│
├── services/                  # ── 数据服务层（纯数据操作）──
│   ├── chat-service.mjs       # 聊天 CRUD（266 行）
│   ├── user-service.mjs       # 用户 CRUD + 认证（182 行）
│   ├── admin-service.mjs      # 系统配置 + 审计日志（126 行）
│   └── content-service.mjs    # Prompt + AI Role 管理（122 行）
│
├── lib/                       # ── 基础设施库 ──
│   ├── context.mjs            # DI 容器 + 依赖构建工厂（632 行）
│   ├── context-setup.mjs      # 启动时 DI 组装（159 行）
│   ├── bootstrap.mjs          # 环境变量加载（118 行）
│   ├── logger.mjs             # 日志系统（106 行）
│   ├── metrics-collector.mjs  # 指标收集（371 行）
│   ├── file-parser.mjs        # 文件解析（PDF/Word/Markdown）
│   ├── rag-utils.mjs          # RAG 工具函数
│   ├── signals.mjs            # 进程信号处理
│   └── schemas/               # 数据校验 Schema
│       ├── ipc-schemas.mjs    # IPC 消息 Schema
│       └── http-schemas.mjs   # HTTP 请求 Schema
│
└── worker/                    # ── Agent Worker 进程 ──
    ├── index.mjs              # Worker 入口
    ├── user-message-handler.mjs # 用户消息处理（769 行 — 最大）
    ├── openclaw-handler.mjs   # OpenClaw 交互处理
    ├── tool-tracker.mjs       # 工具调用追踪
    ├── stream-processor.mjs   # 流式响应处理
    ├── self-healer.mjs        # 自愈逻辑
    ├── format-utils.mjs       # 格式化工具
    ├── db-proxy.mjs           # 数据库代理（Worker→主进程）
    ├── circuit-breaker.mjs    # 熔断器
    └── ipc-utils.mjs          # IPC 通信工具
```

### 3.2 启动流程

```
server.mjs (入口)
  │
  ├── lib/bootstrap.mjs          → 加载 .env 环境变量
  ├── database.mjs.initDatabase() → 初始化数据库连接
  ├── lib/context-setup.mjs      → 组装 DI 容器
  │     ├── context.mjs.createContext()  → 创建空上下文
  │     ├── context.mjs.injectDb()      → 注入数据库函数
  │     ├── context.mjs.injectKnowledgeDb() → 注入知识库
  │     ├── context.mjs.injectDbAdapter()   → 注入适配器
  │     │
  │     ├── api/auth-api.mjs.init(buildAuthApiDeps)
  │     ├── ChatOrchestrator(buildChatOrchestratorDeps)
  │     ├── api/chat-api.mjs.init(buildChatApiDeps + orchestrator)
  │     ├── api/system-api.mjs.init(buildSystemApiDeps)
  │     ├── api/knowledge-api.mjs.init(buildKnowledgeApiDeps)
  │     ├── api/ticket-kol-api.mjs.init(buildTicketKolApiDeps)
  │     ├── api/workflow-api.mjs.init(buildWorkflowApiDeps)
  │     ├── api/user-management-api.mjs.init(buildUserManagementApiDeps)
  │     ├── api/report-api.mjs.init(buildReportApiDeps)
  │     │
  │     ├── modules/http-router.mjs.init()  → 注入所有 API handler
  │     ├── modules/ws-handler.mjs.init()   → 注入 WS 依赖
  │     └── modules/worker-manager.mjs.init() → 注入 Worker 依赖
  │
  ├── HTTP Server (port 3001)
  │     └── modules/http-router.mjs.handleRequest()
  │
  └── WebSocket Server (port 3001, path /ws)
        └── modules/ws-handler.mjs.handleConnection()
```

### 3.3 DI（依赖注入）架构

系统采用 **手动 DI** 模式，核心流程如下：

1. `lib/context.mjs` 定义了 `createContext()` 创建空容器，以及一系列 `build*Deps()` 工厂函数
2. `lib/context-setup.mjs` 在启动时调用这些工厂，将依赖注入到各 API 模块
3. 每个 API 模块通过 `init(deps)` 接收依赖，内部闭包持有引用

**依赖构建工厂清单：**

| 工厂函数 | 消费模块 | 注入的关键依赖 |
|----------|---------|--------------|
| `buildAuthApiDeps(ctx)` | auth-api.mjs | getUserByUsername, createUser, generateToken, verifyToken |
| `buildChatOrchestratorDeps(ctx, extras)` | ChatOrchestrator | workerManager, rateLimiter, sendEvent, generateTitle 等 |
| `buildChatApiDeps(ctx, orchestrator)` | chat-api.mjs | db, orchestrator, wsClients, taskStore |
| `buildSystemApiDeps(ctx)` | system-api.mjs | getStats, getSystemConfigs, getQuickPrompts, getAiRoles |
| `buildKnowledgeApiDeps(ctx)` | knowledge-api.mjs | knowledgeDb.search, knowledgeDb.addDocument, ragUtils |
| `buildTicketKolApiDeps(ctx)` | ticket-kol-api.mjs | query, run, sendJson, parseJsonBody |
| `buildWorkflowApiDeps(ctx)` | workflow-api.mjs | query, run, insertAuditLog |
| `buildUserManagementApiDeps(ctx)` | user-management-api.mjs | userService (零 raw SQL，全部委托 user-service.mjs) |
| `buildReportApiDeps(ctx)` | report-api.mjs | query, run |
| `buildWsHandlerDeps(ctx)` | ws-handler.mjs | workerManager, eventBuffer, taskStore, chatService |
| `buildWorkerManagerDeps(ctx)` | worker-manager.mjs | gatewayConnector, taskStore, eventBuffer |

### 3.4 数据层架构

```
database.mjs (Facade — 统一导出门面)
  │
  ├── re-export from services/user-service.mjs (515 行)
  │     → getUserByUsername, createUser, getUserById, getAllUsers,
  │       updateUser, generateToken, verifyToken, extractUserFromRequest,
  │       getDepartments, createDepartment, updateDepartment, deleteDepartment,
  │       getUsersByDepartment, buildOrgTree, changePassword, resetPassword,
  │       deactivateUser, reactivateUser
  │
  ├── re-export from services/chat-service.mjs
  │     → getChats, getChatById, createChat, updateChat, deleteChat,
  │       getMessages, addMessage, searchChats, getAllTags,
  │       getChatBySessionKey, getConversationHistory
  │
  ├── re-export from services/admin-service.mjs
  │     → getStats, getSystemStatus, getSystemConfigs, getAuditLogs
  │
  ├── re-export from services/content-service.mjs
  │     → getQuickPrompts, incrementPromptUsage, getAiRoles
  │
  ├── initDatabase() → 初始化 db-adapter + 建表（SQLite）
  └── parseJsonBody(), sendJson() → HTTP 工具函数（兼容保留）
```

**数据库**: MySQL (TiDB) 生产环境 / SQLite 开发环境，通过 `db-adapter.mjs` 统一适配。

### 3.5 WebSocket 事件体系

前端通过 WebSocket 连接到 `wss://ranger.voyage/ws`，事件流如下：

**客户端 → 服务端（上行事件）：**

| type | 说明 | 处理模块 |
|------|------|---------|
| `ping` | 心跳 | ws-handler.mjs |
| `bind_chat` | 绑定聊天会话 | ws-control-handlers.mjs |
| `message` | 发送用户消息 | ws-chat-handlers.mjs |
| `cancel` | 取消当前任务 | ws-control-handlers.mjs |
| `abort_task` | 强制中止任务 | ws-control-handlers.mjs |
| `recover_task` | 恢复断连任务 | ws-control-handlers.mjs |
| `status_update` | 状态更新请求 | ws-control-handlers.mjs |
| `force_reset` | 强制重置状态 | ws-control-handlers.mjs |
| `set_session` | 设置 Gateway 会话 | ws-control-handlers.mjs |
| `gateway_api` | 直接调用 Gateway API | ws-control-handlers.mjs |
| `user_interrupt` | 用户中断（追加消息） | ws-control-handlers.mjs |

**服务端 → 客户端（下行事件）：**

| type | 说明 | 数据字段 |
|------|------|---------|
| `connected` | 连接成功 | sessionId, capabilities |
| `stream_chunk` | 流式文本片段 | content, msgId |
| `thinking` | 思考过程 | content |
| `tool_start` | 工具调用开始 | toolName, toolCallId, args |
| `tool_end` / `tool_result` | 工具调用结束 | toolCallId, result, screenshot |
| `tool_progress` | 工具执行进度 | toolCallId, progress |
| `stream_end` | 流式结束 | msgId, fullContent |
| `message_done` | 消息完成 | msgId |
| `status` | 状态变更 | status (idle/thinking/executing/...) |
| `title` | 自动生成标题 | title, chatId |
| `suggestions` | 后续建议 | suggestions[] |
| `error` | 错误 | message, code |
| `step_start` / `step_end` | 执行步骤 | stepId, stepName |
| `workspace_update` | 工作区文件变更 | files[] |
| `capabilities` | AI 能力更新 | skills[], tools[] |

### 3.6 Worker 进程架构

主服务通过 `worker-manager.mjs` 管理 Worker 子进程，Worker 负责与 OpenClaw Gateway 交互：

```
主进程 (server.mjs)
  │
  ├── worker-manager.mjs (进程管理)
  │     ├── 创建/销毁 Worker 子进程
  │     ├── IPC 消息路由
  │     ├── 崩溃恢复 (worker-crash-recovery.mjs)
  │     └── 心跳监控 (worker-ping-monitor.mjs)
  │
  └── worker/ (子进程)
        ├── index.mjs (入口 — 接收 IPC 消息)
        ├── user-message-handler.mjs (处理用户消息 → 调用 OpenClaw)
        ├── openclaw-handler.mjs (OpenClaw Gateway 交互)
        ├── stream-processor.mjs (流式响应处理)
        ├── tool-tracker.mjs (工具调用追踪 + 可视化事件)
        ├── self-healer.mjs (自愈：检测卡死/超时)
        ├── db-proxy.mjs (通过 IPC 代理数据库操作)
        └── circuit-breaker.mjs (熔断器 — 防止级联故障)
```

---

## 四、前端架构

### 4.1 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| React | 18 | UI 框架 |
| TypeScript | 5.x | 类型安全 |
| Vite | 5.x | 构建工具 |
| Zustand | 5.0.11 | 状态管理（原子化 stores） |
| Wouter | — | 轻量路由 |
| Tailwind CSS | 3.x | 样式 |
| Sonner | — | Toast 通知 |

### 4.2 目录结构

```
/opt/rangerai-web/client/src/
├── App.tsx                    # 路由定义 + 全局布局
├── main.tsx                   # 入口 + Provider 挂载
├── index.css                  # 全局样式 + Tailwind
│
├── stores/                    # ── Zustand 原子化状态 ──
│   ├── useAuthStore.ts        # 认证状态（user, isAuthLoading, login, logout）
│   ├── useChatListStore.ts    # 对话列表（chats, currentChatId, search, filter, tags）
│   ├── useMessageStore.ts     # 消息/流式（messages, isStreaming, tools, steps）
│   ├── useConnectionStore.ts  # 连接状态（wsConnected, gatewayConnected）
│   ├── useWorkspaceStore.ts   # 工作区（files, aiSkills, aiTools）
│   └── index.ts               # 统一导出
│
├── hooks/                     # ── 自定义 Hooks ──
│   ├── useChatStore.tsx       # ChatProvider（WebSocket 事件路由到各 store）
│   ├── useChatActions.ts      # 跨 store 协调操作（createNewChat, sendMessage, selectChat）
│   └── useWebSocket.ts        # WebSocket 连接管理
│
├── lib/                       # ── 工具库 ──
│   ├── api.ts                 # HTTP API 客户端（所有 fetch 调用）
│   ├── types.ts               # TypeScript 类型定义
│   ├── i18n.tsx               # 国际化（中/英）
│   ├── clipboard.ts           # 剪贴板工具
│   ├── dateUtils.ts           # 日期格式化
│   └── exportUtils.ts         # 对话导出
│
├── pages/                     # ── 页面组件 ──
│   ├── ChatPage.tsx           # 主聊天页面（入口 /）
│   ├── LoginPage.tsx          # 登录页（/login）
│   ├── KnowledgeBase.tsx      # 知识库（/knowledge）
│   ├── WorkflowEditor.tsx     # 工作流编辑器（/workflows）
│   ├── TicketManager.tsx      # 工单管理（/tickets）
│   ├── KolManager.tsx         # KOL 管理（/kols）
│   ├── KolDetail.tsx          # KOL 详情（/kols/:id）
│   ├── NotificationCenter.tsx # 通知中心（/notifications）
│   ├── TeamManagement.tsx     # 团队管理（/team）— Admin
│   ├── InviteCodesPage.tsx    # 邀请码（/invite-codes）— Admin
│   ├── StatsPage.tsx          # 统计（/stats）— Admin
│   ├── PromptTemplates.tsx    # Prompt 模板（/prompts）— Admin
│   ├── AdminDashboard.tsx     # 管理仪表板（/admin）— Admin
│   ├── CeoDashboard.tsx       # CEO 仪表板（/ceo）— Admin
│   ├── DataAnalytics.tsx      # 数据分析（/data-analytics）
│   ├── DailyReports.tsx       # 日报（/daily-reports）
│   ├── TikTokPartners.tsx     # TikTok 合作伙伴（/tiktok-partners）
│   ├── TikTokScriptGen.tsx    # TikTok 脚本生成（/tiktok-scripts）
│   ├── InventoryMonitor.tsx   # 库存监控（/inventory）
│   ├── OperationalEfficiency.tsx # 运营效率（/ops-efficiency）— Admin
│   ├── GlobalDashboard.tsx    # 全局仪表板（/dashboard）
│   ├── TaskQueue.tsx          # 任务队列（/tasks）
│   └── SearchDebug.tsx        # 搜索调试（/search-debug）
│
└── components/                # ── 可复用组件 ──
    ├── chat/                  # 聊天相关
    │   ├── Sidebar.tsx        # 侧边栏（对话列表 + 导航）
    │   ├── MessageList.tsx    # 消息列表（渲染所有消息类型）
    │   ├── MessageInput.tsx   # 消息输入框
    │   ├── FilePanel.tsx      # 文件面板（工作区文件）
    │   ├── CapabilitiesPanel.tsx # AI 能力面板
    │   ├── TagManager.tsx     # 标签管理
    │   ├── RecoveryBanner.tsx # 断连恢复横幅
    │   ├── ShareDialog.tsx    # 分享对话框
    │   ├── SearchResultCards.tsx # 搜索结果卡片
    │   ├── KnowledgeReferences.tsx # 知识引用
    │   ├── MessageAttachments.tsx # 消息附件
    │   ├── AIFileOutput.tsx   # AI 文件输出
    │   ├── LazyStreamdown.tsx # 懒加载 Markdown 渲染
    │   └── LanguageSwitcher.tsx # 语言切换
    ├── AdminRoute.tsx         # 管理员路由守卫
    ├── ConfirmDialog.tsx      # 确认对话框
    └── DashboardLayout.tsx    # 仪表板布局（未启用）
```

### 4.3 状态管理架构（Zustand 原子化 Stores）

系统采用 **5 个独立的 Zustand store**，每个 store 管理一个领域的状态，组件通过 selector 精确订阅所需的状态切片：

```
┌─────────────────────────────────────────────────┐
│                  ChatProvider                     │
│  (WebSocket 事件路由 → 分发到各 store)            │
│                                                   │
│  useWebSocket() ──→ onEvent(event) ──→ switch:   │
│    stream_chunk  → useMessageStore.appendStream   │
│    tool_start    → useMessageStore.addToolCall    │
│    tool_end      → useMessageStore.updateToolCall │
│    step_start    → useMessageStore.addStep        │
│    connected     → useConnectionStore.set...      │
│    capabilities  → useWorkspaceStore.set...       │
│    title         → useChatListStore.updateTitle   │
│    suggestions   → useMessageStore.setSuggestions │
│    workspace_update → useWorkspaceStore.set...    │
└─────────────────────────────────────────────────┘
         │              │              │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │ Auth    │   │ChatList │   │ Message │
    │ Store   │   │ Store   │   │ Store   │
    ├─────────┤   ├─────────┤   ├─────────┤
    │ user    │   │ chats   │   │messages │
    │ loading │   │currentId│   │streaming│
    │ login() │   │search   │   │tools    │
    │ logout()│   │filter   │   │steps    │
    └─────────┘   │tags     │   │thinking │
                  │create() │   │suggest  │
                  │delete() │   └─────────┘
                  │rename() │
                  └─────────┘
    ┌─────────┐   ┌─────────────┐
    │Connect  │   │ Workspace   │
    │ Store   │   │ Store       │
    ├─────────┤   ├─────────────┤
    │wsConn   │   │ files       │
    │gwConn   │   │ selectedFile│
    │reconnect│   │ aiSkills    │
    └─────────┘   │ aiTools     │
                  │ filePanel   │
                  └─────────────┘
```

**组件 → Store 订阅映射：**

| 组件 | 订阅的 Store | 说明 |
|------|-------------|------|
| ChatPage | Auth + ChatList + Connection + Workspace | 页面编排 |
| Sidebar | Auth + ChatList + Connection | 对话列表 + 导航 |
| MessageList | Message | 消息渲染 |
| MessageInput | ChatList + Message + Connection | 输入框状态 |
| FilePanel | Workspace | 文件浏览 |
| CapabilitiesPanel | Workspace + useChatActions | AI 能力展示 |
| TagManager | ChatList | 标签管理 |
| PromptTemplates | useChatActions | Prompt 使用 |
| RecoveryBanner | Connection | 断连提示 |

### 4.4 前端路由表

| 路径 | 页面组件 | 权限 | 功能 |
|------|---------|------|------|
| `/` | ChatPage | 登录用户 | AI 对话（核心功能） |
| `/login` | LoginPage | 公开 | 登录/注册 |
| `/knowledge` | KnowledgeBase | 登录用户 | 知识库浏览/搜索 |
| `/workflows` | WorkflowEditor | 登录用户 | 工作流编辑/执行 |
| `/tickets` | TicketManager | 登录用户 | 工单管理 |
| `/kols` | KolManager | 登录用户 | KOL 管理 |
| `/kols/:id` | KolDetail | 登录用户 | KOL 详情 |
| `/notifications` | NotificationCenter | 登录用户 | 通知中心 |
| `/tasks` | TaskQueue | 登录用户 | 任务队列 |
| `/data-analytics` | DataAnalytics | 登录用户 | 数据分析 |
| `/daily-reports` | DailyReports | 登录用户 | 日报 |
| `/tiktok-partners` | TikTokPartners | 登录用户 | TikTok 合作伙伴 |
| `/tiktok-scripts` | TikTokScriptGen | 登录用户 | TikTok 脚本生成 |
| `/inventory` | InventoryMonitor | 登录用户 | 库存监控 |
| `/dashboard` | GlobalDashboard | 登录用户 | 全局仪表板 |
| `/search-debug` | SearchDebug | 登录用户 | 搜索调试 |
| `/team` | TeamManagement | **Admin** | 团队管理 |
| `/invite-codes` | InviteCodesPage | **Admin** | 邀请码管理 |
| `/stats` | StatsPage | **Admin** | 系统统计 |
| `/prompts` | PromptTemplates | **Admin** | Prompt 模板管理 |
| `/admin` | AdminDashboard | **Admin** | 管理仪表板 |
| `/ceo` | CeoDashboard | **Admin** | CEO 仪表板 |
| `/ops-efficiency` | OperationalEfficiency | **Admin** | 运营效率 |

---

## 五、前后端通信映射

### 5.1 HTTP API 映射（前端 lib/api.ts → 后端 api/*.mjs）

| 前端函数 | HTTP 方法 | URL | 后端模块 |
|----------|----------|-----|---------|
| `login()` | POST | `/api/auth/login` | auth-api.mjs |
| `register()` | POST | `/api/auth/register` | auth-api.mjs |
| `getMe()` | GET | `/api/auth/me` | auth-api.mjs |
| `logout()` | POST | `/api/auth/logout` | auth-api.mjs |
| `createInviteCode()` | POST | `/api/auth/invite-codes` | auth-api.mjs |
| `getInviteCodes()` | GET | `/api/auth/invite-codes` | auth-api.mjs |
| `deactivateInviteCode()` | DELETE | `/api/auth/invite-codes/:id` | auth-api.mjs |
| `fetchChats()` | GET | `/api/chats` | chat-api.mjs |
| `createChat()` | POST | `/api/chats` | chat-api.mjs |
| `fetchChatDetail()` | GET | `/api/chats/:id` | chat-api.mjs |
| `updateChat()` | PUT | `/api/chats/:id` | chat-api.mjs |
| `updateChatTitle()` | PUT | `/api/chats/:id` | chat-api.mjs |
| `updateChatTags()` | PUT | `/api/chats/:id/tags` | chat-api.mjs |
| `deleteChat()` | DELETE | `/api/chats/:id` | chat-api.mjs |
| `batchDeleteChats()` | POST | `/api/chats/batch-delete` | chat-api.mjs |
| `sendMessage()` | POST | `/api/messages` | chat-api.mjs |
| `regenerateMessage()` | POST | `/api/messages/regenerate` | chat-api.mjs |
| `searchChats()` | GET | `/api/search?q=...` | chat-api.mjs |
| `getChatsByTag()` | GET | `/api/chats?tag=...` | chat-api.mjs |
| `getAllTags()` | GET | `/api/tags` | chat-api.mjs |
| `uploadFiles()` | POST | `/api/upload` | infra-routes.mjs |
| `pollTaskStatus()` | GET | `/api/task-status/:id` | task-routes.mjs |
| `getSessionStatus()` | GET | `/api/session-status/:key` | task-routes.mjs |
| `fetchWorkspaceTree()` | GET | `/api/workspace/tree` | infra-routes.mjs |
| `fetchWorkspaceFile()` | GET | `/api/workspace/file?path=...` | infra-routes.mjs |
| `downloadWorkspaceFile()` | GET | `/api/workspace/download?path=...` | infra-routes.mjs |
| `getStats()` | GET | `/api/stats` | system-api.mjs |
| `getRoutingStats()` | GET | `/api/stats/routing` | system-api.mjs |
| `fetchPrompts()` | GET | `/api/prompts` | system-api.mjs |
| `usePrompt()` | POST | `/api/prompts/:id/use` | system-api.mjs |
| `fetchHealth()` | GET | `/api/health` | system-api.mjs |
| `fetchProviderHealth()` | GET | `/api/health/providers` | system-api.mjs |
| `fetchUsers()` | GET | `/api/users` | user-management-api.mjs |
| `shareChat()` | POST | `/api/chats/:id/share` | chat-api.mjs |
| `fetchChatShares()` | GET | `/api/chats/:id/shares` | chat-api.mjs |
| `unshareChat()` | DELETE | `/api/chats/:id/share/:userId` | chat-api.mjs |
| `fetchSharedWithMe()` | GET | `/api/chats/shared-with-me` | chat-api.mjs |
| `reportError()` | POST | `/api/error-report` | system-api.mjs |

### 5.2 WebSocket 通信映射（前端 hooks → 后端 modules）

| 前端操作 | WS 上行消息 | 后端处理 | WS 下行事件 | 前端 Store 更新 |
|----------|-----------|---------|-----------|---------------|
| 打开聊天 | `{type:"bind_chat", chatId}` | ws-message-handlers.handleBindChat | `connected` | connectionStore.setWsConnected |
| 发送消息 | `{type:"message", content}` | ws-chat-handlers.handleSendMessage | `stream_chunk` → `stream_end` | messageStore.appendStream → streamEnd |
| 取消任务 | `{type:"cancel"}` | ws-message-handlers.handleCancel | `status:{idle}` | connectionStore |
| 恢复任务 | `{type:"recover_task"}` | ws-message-handlers.handleRecoverTask | 重放缓冲事件 | messageStore |
| 中断追加 | `{type:"user_interrupt", content}` | ws-handler | 继续流式 | messageStore |
| 工具调用 | — (服务端推送) | — | `tool_start` → `tool_end` | messageStore.addToolCall → updateToolCall |
| AI 思考 | — (服务端推送) | — | `thinking` | messageStore.appendThinking |
| 执行步骤 | — (服务端推送) | — | `step_start` → `step_end` | messageStore.addStep → updateStep |
| 标题生成 | — (服务端推送) | — | `title` | chatListStore.updateTitle |
| 建议生成 | — (服务端推送) | — | `suggestions` | messageStore.setSuggestions |
| 能力更新 | — (服务端推送) | — | `capabilities` | workspaceStore.setAiCapabilities |
| 文件变更 | — (服务端推送) | — | `workspace_update` | workspaceStore.setWorkspaceFiles |

---

## 六、环境变量

### 6.1 后端 (.env)

| 变量名 | 说明 |
|--------|------|
| `PORT` | 主服务端口（默认 3001） |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `QWEN_API_KEY` | 通义千问 API Key |
| `GOOGLE_API_KEY` | Google API Key |
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret |
| `REDIS_POOL_URL` | Redis 连接池 URL |
| `REDIS_QUEUE_URL` | Redis 队列 URL |

### 6.2 前端（构建时注入）

前端环境变量通过 Vite 的 `import.meta.env` 注入，以 `VITE_` 前缀标识。当前前端直接使用 `ranger.voyage` 域名作为 API 基础路径，无需额外配置。

---

## 七、维护指南

### 7.1 添加新的 HTTP API 端点

1. **选择或创建 API 模块**: 在 `api/` 目录下找到对应的模块（如 `chat-api.mjs`），或创建新模块
2. **实现处理函数**: 在模块内添加路由匹配和处理逻辑
3. **注册路由**: 在 `modules/http-router.mjs` 的 `handleRequest()` 中添加 URL 匹配规则
4. **DI 注入**（如需新依赖）: 在 `lib/context.mjs` 添加 `build*Deps()` 工厂，在 `lib/context-setup.mjs` 调用
5. **前端对接**: 在 `client/src/lib/api.ts` 添加对应的 fetch 函数
6. **Caddy 路由**（如需新路径前缀）: 在 `/etc/caddy/conf.d/` 添加反向代理规则

### 7.2 添加新的 WebSocket 事件

1. **定义事件类型**: 在 `lib/schemas/ipc-schemas.mjs` 添加 Schema
2. **后端处理**: 在 `modules/ws-control-handlers.mjs`（控制类）或 `ws-chat-handlers.mjs`（聊天类）添加处理函数，然后在 `ws-handler.mjs` 的 dispatch 表中注册
3. **Worker 发送**（如需）: 在 `worker/` 相关模块通过 IPC 发送事件
4. **前端接收**: 在 `hooks/useChatStore.tsx` 的 `ChatProvider` 中添加事件处理分支
5. **Store 更新**: 在对应的 Zustand store 中添加 action
6. **类型定义**: 在 `client/src/lib/types.ts` 添加 `WsEvent` 子类型

### 7.3 添加新的前端页面

1. **创建页面组件**: 在 `client/src/pages/` 创建 `XxxPage.tsx`
2. **注册路由**: 在 `App.tsx` 添加 `<Route path="/xxx" component={XxxPage} />`
3. **添加导航**: 在 `Sidebar.tsx` 的 `businessModules` 或 `adminModules` 数组中添加入口
4. **API 对接**: 在 `lib/api.ts` 添加所需的 fetch 函数
5. **权限控制**: 如需 Admin 权限，用 `<AdminRoute>` 包裹

### 7.4 修改数据库 Schema

1. **修改 Service**: 在 `services/` 对应的 service 文件中修改查询
2. **MySQL 迁移**: 直接在 MySQL 中执行 ALTER TABLE
3. **SQLite 兼容**: 在 `database.mjs` 的 `initDatabase()` 中添加 migration
4. **更新 Facade**: 如有新导出函数，在 `database.mjs` 添加 re-export
5. **更新 DI**: 如有新依赖，更新 `lib/context.mjs` 对应的 `build*Deps()`

### 7.5 systemd 服务管理

```bash
# 查看服务状态
sudo systemctl status rangerai-agent

# 重启后端主服务
sudo systemctl restart rangerai-agent

# 查看日志
sudo journalctl -u rangerai-agent -f --no-pager

# 重启所有 RangerAI 服务
sudo systemctl restart rangerai-agent rangerai-web rangerai-acp rangerai-static rangerai-fileserver

# 重载 Caddy 配置
sudo systemctl reload caddy
```

### 7.6 前端构建部署

```bash
# 进入前端项目目录
cd /opt/rangerai-web

# 安装依赖
pnpm install

# 构建
pnpm build

# 部署到 Caddy 静态目录
sudo cp -r dist/* /var/www/rangerai/
```

### 7.7 已知遗留问题

| 问题 | 位置 | 严重程度 | 说明 |
|------|------|---------|------|
| worker-manager.mjs 直接 import database.mjs | modules/worker-manager.mjs | 低 | 应改为 DI 注入，但不影响功能 |
| acp-bridge.mjs 直接 import database.mjs | acp-bridge.mjs | 低 | 独立进程，DI 改造收益有限 |
| context.mjs 过大（632 行） | lib/context.mjs | 低 | 所有 build*Deps 集中在一个文件 |
| MessageList.tsx 过大（1,685 行） | components/chat/MessageList.tsx | 中 | 混合 10+ 种渲染模式，建议拆分 |
| Sidebar.tsx 过大（1,173 行） | components/chat/Sidebar.tsx | 中 | 混合导航、搜索、对话列表 |

---

## 八、变更日志

### Iter-56: Service 层 SQL 下沉 + WebSocket 模块化 + 磁盘清理

**日期：** 2026-03-14

**变更内容：**

**1. user-management-api.mjs SQL 下沉（零 raw SQL）：**
- `user-management-api.mjs`：564 行 → 394 行（-30%），36 处 raw SQL 全部迁移到 user-service.mjs
- `user-service.mjs`：182 行 → 515 行，新增部门 CRUD、组织树构建、密码管理、用户停用/激活等 15 个方法
- API 层通过 `userService.*` 单行调用替代原有的 `db().query()` 直接操作

**2. WebSocket 模块化（Dispatch ↔ Handling 物理隔离）：**
- `ws-handler.mjs`：590 行 → 297 行（-50%），仅保留连接管理 + 消息分发路由表
- `ws-control-handlers.mjs`：382 行（新建），提取 9 个控制类处理器（bind_chat, recover_task, cancel, abort_task, force_reset, status_update, set_session, user_interrupt, gateway_api）
- 分发逻辑从 if/else 链改为 handler map 查表，新增事件只需在 map 中注册

**3. 磁盘环境清理：**
- 归档 6 个 `.bak` 冗余文件到 `.archive-bak-20260314/`
- 工作目录 `grep` 结果不再受干扰

**架构变化：**
```
重构前：ws-handler.mjs (590行) = 连接管理 + dispatch + 9个控制处理器
重构后：ws-handler.mjs (297行) = 连接管理 + dispatch
       ws-control-handlers.mjs (382行) = 9个控制处理器
       ws-chat-handlers.mjs (393行) = 聊天处理（不变）
```

**当前 API 层 raw SQL 统计：**
| API 模块 | raw SQL 数 | 状态 |
|----------|-----------|------|
| chat-api.mjs | 0 | 已完成（Iter-55） |
| user-management-api.mjs | 0 | 已完成（Iter-56） |
| ticket-kol-api.mjs | 54 | 待迭代 |
| system-api.mjs | 3 | 待迭代 |
| report-api.mjs | 2 | 待迭代 |
| knowledge-api.mjs | 1 | 待迭代 |

---

### Iter-55: chat-api.mjs → ChatOrchestrator 重构

**日期：** 2026-03-14

**变更内容：**
- `chat-api.mjs`：666 行 → 306 行（瘦身 54%），仅保留路由分发 + 请求验证
- `chat-service.mjs`：266 行 → 644 行，新增 `ChatOrchestrator` 类封装消息发送完整业务编排
- `context.mjs`：新增 `buildChatOrchestratorDeps()` 工厂函数
- `context-setup.mjs`：新增 ChatOrchestrator DI 注册

**架构变化：**
```
重构前：chat-api.mjs (666行) → 直接操作 db + workerManager + rateLimiter + ...
重构后：chat-api.mjs (306行) → ChatOrchestrator (378行) → db + workerManager + ...
```

**ChatOrchestrator 封装的业务逻辑：**
- `sendMessage()` — 消息发送完整流水线（验证→限流→文件展开→保存→知识注入→Worker调度→标题生成→建议生成）
- `stopGeneration()` — 停止 AI 生成
- `retryMessage()` — 重试失败消息
- `generateSuggestionsForChat()` — 手动触发建议生成

---

## 八、架构图（ASCII）

```
                              ┌──────────────┐
                              │  Cloudflare   │
                              │   DNS/CDN     │
                              └──────┬───────┘
                                     │
                              ┌──────▼───────┐
                              │    Caddy      │
                              │  :80 / :443   │
                              │  SSL + Proxy  │
                              └──┬──┬──┬──┬──┘
                                 │  │  │  │
              ┌──────────────────┘  │  │  └──────────────────┐
              │                     │  │                     │
     ┌────────▼────────┐  ┌───────▼──▼───────┐  ┌─────────▼────────┐
     │  Static Files   │  │  Agent Server    │  │   ACP Bridge     │
     │  /var/www/       │  │  :3001           │  │   :3003          │
     │  rangerai/       │  │  HTTP + WS       │  │   钉钉集成       │
     │  (React SPA)     │  │                  │  └──────────────────┘
     └─────────────────┘  │  ┌─────────────┐ │
                           │  │ http-router │ │  ┌──────────────────┐
                           │  │ ws-handler  │ │  │  Web Service     │
                           │  └──────┬──────┘ │  │  :3002           │
                           │         │        │  │  Tickets/KOL/    │
                           │  ┌──────▼──────┐ │  │  Users/Notif     │
                           │  │ Worker Mgr  │ │  └──────────────────┘
                           │  │ (子进程池)   │ │
                           │  └──────┬──────┘ │  ┌──────────────────┐
                           │         │        │  │  File Server     │
                           │  ┌──────▼──────┐ │  │  :3004           │
                           │  │  Workers    │ │  └──────────────────┘
                           │  │ OpenClaw ↔  │ │
                           │  └──────┬──────┘ │  ┌──────────────────┐
                           │         │        │  │ OpenClaw Gateway │
                           └─────────┼────────┘  │  :18789          │
                                     │           │  gw.ranger.voyage│
                                     └───────────▶  AI 引擎核心     │
                                                 └──────────────────┘
                                                          │
                                                 ┌────────▼────────┐
                                                 │   MySQL (TiDB)  │
                                                 │   数据持久化     │
                                                 └─────────────────┘
```

---

> **文档维护说明**: 本文档应在每次重大架构变更后更新。文件位置: `/opt/rangerai-agent/ARCHITECTURE.md`
