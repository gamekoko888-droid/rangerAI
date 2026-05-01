# RangerAI 代码架构与运维全书

> **版本**: v2.0 | **日期**: 2026-03-11 | **评分**: 93.0/100 (A-)
>
> 本文档是 RangerAI 项目的完整技术手册，覆盖系统架构、代码结构、数据流、部署运维、故障排查和代码修改指南。目标读者是 RangerAI 系统自身及其维护者，使其能够独立理解、维护和修改整个代码库。

---

## 目录

1. [系统架构总览](#1-系统架构总览)
2. [服务器环境与基础设施](#2-服务器环境与基础设施)
3. [后端架构深度解析](#3-后端架构深度解析)
4. [前端架构深度解析](#4-前端架构深度解析)
5. [数据流与通信协议](#5-数据流与通信协议)
6. [数据库架构](#6-数据库架构)
7. [AI 模型集成与智能路由](#7-ai-模型集成与智能路由)
8. [Caddy 反向代理与路由](#8-caddy-反向代理与路由)
9. [监控与告警体系](#9-监控与告警体系)
10. [部署流程](#10-部署流程)
11. [自动化运维工具](#11-自动化运维工具)
12. [安全架构](#12-安全架构)
13. [常见故障排查手册](#13-常见故障排查手册)
14. [代码修改指南](#14-代码修改指南)
15. [完整文件索引](#15-完整文件索引)

---

## 1. 系统架构总览

### 1.1 架构分层

RangerAI 采用前后端分离的全栈架构，整体分为四层。接入层由 Caddy 统一处理 HTTPS 请求和 WebSocket 升级，自动管理 Let's Encrypt SSL 证书。应用层包含 5 个 systemd 服务和 1 个定时器，分别处理 API 请求、WebSocket 实时通信、AI 网关桥接、文件服务和前端静态文件。数据层使用 MySQL 8.0 作为主数据库，Redis 7 作为任务队列缓存。基础设施层通过 Docker 运行数据库、监控栈和辅助服务。

```
                    ┌─────────────────────────────────────────────────┐
                    │              Internet (HTTPS:443)                │
                    └──────────────────────┬──────────────────────────┘
                                           │
                    ┌──────────────────────▼──────────────────────────┐
                    │                 Caddy (443/80)                   │
                    │    Auto-TLS · Gzip · Security Headers           │
                    │    ranger.voyage / gw.ranger.voyage              │
                    └──┬───────┬───────┬───────┬───────┬─────────────┘
                       │       │       │       │       │
              ┌────────▼──┐ ┌─▼────┐ ┌▼─────┐ ┌▼────┐ ┌▼──────────┐
              │ Frontend  │ │Agent │ │ OC   │ │ACP  │ │ Gateway   │
              │ SPA       │ │:3002 │ │:3004 │ │:3003│ │ WS :18789 │
              │/var/www/  │ │      │ │      │ │     │ │           │
              │rangerai   │ │HTTP+ │ │HTTP  │ │HTTP │ │ WebSocket │
              │           │ │WS    │ │      │ │     │ │           │
              └───────────┘ └──┬───┘ └──┬───┘ └──┬──┘ └─────┬─────┘
                               │        │        │           │
                    ┌──────────▼────────▼────────▼───────────▼────┐
                    │              Data Layer                       │
                    │  MySQL 8.0 (:3306) · Redis 7 (:6380)         │
                    │  SQLite (OpenClaw local)                      │
                    └─────────────────────────────────────────────┘
```

### 1.2 服务清单

| 服务名称 | systemd 单元 | 监听端口 | 进程命令 | 职责 |
|----------|-------------|---------|---------|------|
| **RangerAI Agent** | `rangerai-agent.service` | 127.0.0.1:3002 | `node --max-old-space-size=512 server.mjs` | 核心后端：HTTP API + WebSocket + Worker 管理 |
| **RangerAI Web** | `rangerai-web.service` | *:3000 | `node static-server.cjs` | 前端 SPA 静态文件服务（Manus 部署用） |
| **RangerAI ACP** | `rangerai-acp.service` | 127.0.0.1:3003 | `node acp-api.mjs` | ACP 桥接：钉钉 + API 网关 |
| **RangerAI FileServer** | `rangerai-fileserver.service` | 127.0.0.1:3004 | `node file-server.mjs` | 文件上传/下载 + OpenClaw Gateway 代理 |
| **RangerAI Static** | `rangerai-static.service` | 127.0.0.1:9999 | `python3 -m http.server 9999` | 静态文件备用服务 |
| **Health Check** | `rangerai-healthcheck.timer` | — | `node health-check.mjs` | 每 5 分钟健康检查 |

### 1.3 Docker 容器

| 容器名称 | 镜像 | 端口映射 | 用途 |
|----------|------|---------|------|
| `mysql-rangerai` | mysql:8.0 | 127.0.0.1:3306→3306 | 主数据库 |
| `prometheus` | prom/prometheus:v2.51.0 | 127.0.0.1:9090 | 指标采集 |
| `grafana` | grafana/grafana:latest | 127.0.0.1:3000 (容器内) | 监控仪表盘 |
| `alertmanager` | prom/alertmanager:latest | *:9093 | 告警管理 |
| `node-exporter` | prom/node-exporter:v1.7.0 | 127.0.0.1:9100 | 系统指标采集 |
| `searxng` | searxng/searxng:latest | 127.0.0.1:8888→8080 | 搜索引擎 |
| `v2ray-proxy` | v2fly/v2fly-core:latest | — | 网络代理 |
| `redis-test` | redis:7-alpine | 127.0.0.1:6380→6379 | Redis 缓存 |

---

## 2. 服务器环境与基础设施

### 2.1 硬件与操作系统

| 项目 | 详情 |
|------|------|
| **云平台** | 阿里云 ECS |
| **公网 IP** | 8.219.186.244 |
| **域名** | ranger.voyage, gw.ranger.voyage |
| **操作系统** | Alibaba Cloud Linux 3.2104 |
| **CPU** | 8 核 |
| **内存** | 14 GiB |
| **磁盘** | 99 GB NVMe SSD |
| **Node.js** | v24.13.0 |
| **Docker** | 已安装 |
| **Caddy** | 2.x |

### 2.2 SSH 访问

```bash
ssh admin@8.219.186.244
# 密码: Joseph1991@
```

### 2.3 关键目录

| 目录 | 用途 |
|------|------|
| `/opt/rangerai-agent/` | 后端代码主目录 |
| `/opt/rangerai-web/` | 前端源码目录（含 Manus 模板 + 独立构建） |
| `/var/www/rangerai/` | 前端生产构建输出（Caddy 静态服务） |
| `/var/www/rangerai1/` | Manus 部署的前端（static-server.cjs 服务） |
| `/home/admin/.openclaw/` | OpenClaw Gateway 配置与工作空间 |
| `/opt/monitoring/` | Prometheus/Grafana 配置 |
| `/etc/caddy/conf.d/` | Caddy 模块化配置 |

---

## 3. 后端架构深度解析

### 3.1 进程架构

RangerAI Agent 采用**主进程 + Worker 子进程**的架构。主进程（`server.mjs`）负责 HTTP 路由、WebSocket 连接管理和 Worker 生命周期管理。Worker 子进程（`agent-worker.mjs`）负责与 OpenClaw Gateway 通信，处理 AI 对话的实际逻辑。两者通过 Node.js 的 IPC（进程间通信）交换消息。

```
┌─────────────────────────────────────────────────────────────┐
│                    主进程 (server.mjs)                        │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ HTTP Router   │  │ WS Handler   │  │ Worker Manager   │   │
│  │ (Express)     │  │ (ws library) │  │ (child_process)  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │              │
│  ┌──────▼───────┐  ┌─────▼────────┐  ┌───────▼──────────┐   │
│  │ API Modules  │  │ Chat Logic   │  │ IPC Channel       │   │
│  │ (7 modules)  │  │ (3 modules)  │  │ (JSON messages)   │   │
│  └──────────────┘  └──────────────┘  └───────┬──────────┘   │
└──────────────────────────────────────────────┬──────────────┘
                                               │ IPC
┌──────────────────────────────────────────────▼──────────────┐
│                Worker 子进程 (agent-worker.mjs)               │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │ OpenClaw Handler  │  │ User Msg Handler │                  │
│  │ (Gateway WS)      │  │ (消息预处理)      │                  │
│  └────────┬─────────┘  └──────────────────┘                  │
│           │                                                   │
│  ┌────────▼─────────┐  ┌──────────────────┐                  │
│  │ Gateway Connector │  │ Circuit Breaker  │                  │
│  │ (WebSocket 客户端) │  │ (熔断器)          │                  │
│  └──────────────────┘  └──────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 主进程模块依赖图

`server.mjs` 是入口文件，它通过 `lib/context.mjs` 创建应用上下文（DI 容器），然后初始化各模块。

```
server.mjs
├── lib/context.mjs          → 创建 ctx（四层上下文：config/services/db/runtime）
├── lib/logger.mjs           → 统一日志模块
├── lib/metrics-collector.mjs → 内存滑动窗口指标收集器
├── auth.mjs                 → ADMIN_TOKEN / WS_TOKEN / CORS / Security Headers
├── database.mjs             → 数据库操作函数集合（async-first, adapter-based）
│   └── db-adapter.mjs       → 数据库适配器（支持 SQLite + MySQL）
├── modules/
│   ├── http-router.mjs      → Express 路由注册中心
│   ├── ws-handler.mjs       → WebSocket 连接管理（590 行）
│   │   ├── ws-chat-handlers.mjs   → 聊天相关 WS 事件处理
│   │   ├── ws-chat-logic.mjs      → 聊天业务逻辑
│   │   └── ws-message-handlers.mjs → 消息相关 WS 事件处理
│   ├── worker-manager.mjs   → Worker 子进程生命周期管理（779 行）
│   ├── event-buffer.mjs     → 事件缓冲区
│   └── routes/
│       ├── infra-routes.mjs → 基础设施路由（health, metrics, version）
│       ├── admin-routes.mjs → 管理员路由
│       ├── task-routes.mjs  → 任务路由
│       └── static-routes.mjs → 静态资源路由
├── api/
│   ├── auth-api.mjs         → 认证 API（登录/注册/JWT）
│   ├── chat-api.mjs         → 对话 CRUD API（666 行）
│   ├── knowledge-api.mjs    → 知识库 API（618 行）
│   ├── system-api.mjs       → 系统管理 API（538 行）
│   ├── ticket-kol-api.mjs   → 工单 + KOL API（601 行）
│   ├── user-management-api.mjs → 用户管理 API（563 行）
│   └── workflow-api.mjs     → 工作流 API（265 行）
├── smart-router.mjs         → AI 智能路由（任务分类 + 模型选择，477 行）
├── knowledge-db.mjs         → 知识库数据库操作（708 行）
├── task-store.mjs           → Redis 任务存储（370 行）
├── embedding-cache.mjs      → 向量嵌入缓存（378 行）
├── remediation-engine.mjs   → 自动修复引擎（638 行）
├── alert-manager.mjs        → 告警管理器（236 行）
└── gateway-message-queue.mjs → Gateway 消息队列（241 行）
```

### 3.3 应用上下文（DI 容器）

`lib/context.mjs` 是整个后端的依赖注入核心，创建的 `ctx` 对象包含四层：

```javascript
ctx = {
  config: {
    PORT: 3002,                    // 服务端口
    NODE_ENV: 'production',        // 运行环境
    DEFAULT_SESSION_KEY: 'rangerai-frontend',
    WORKER_PATH: '/opt/rangerai-agent/agent-worker.mjs',
    // ... 更多配置常量
  },
  services: {
    workerManager,                 // Worker 管理器实例
    eventBuffer,                   // 事件缓冲区实例
    taskStore,                     // Redis 任务存储实例
    rateLimiter,                   // 速率限制器实例
    monitor,                       // 监控收集器实例
  },
  db: {
    // 所有数据库操作函数（来自 database.mjs）
    getChatById, createChat, updateChat, deleteChat,
    createMessage, getConversationHistory,
    extractUserFromRequest, verifyToken, generateToken,
    // ... 更多 DB 函数
  },
  runtime: {
    sessions: new Map(),           // sessionKey → session state
    wsClients: new Map(),          // chatId → WebSocket
    activeTasksBySession: new Map(), // sessionKey → taskId
    server: null,                  // HTTP server 实例
  }
};
```

### 3.4 HTTP API 路由表

所有 HTTP 路由通过 `modules/http-router.mjs` 注册，API 模块挂载在 `/api/` 前缀下。

**认证 API (`api/auth-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 无 | 用户登录，返回 JWT |
| POST | `/api/auth/register` | 无 | 用户注册（需邀请码） |
| GET | `/api/auth/me` | JWT | 获取当前用户信息 |
| POST | `/api/auth/logout` | JWT | 用户登出 |

**对话 API (`api/chat-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/chats` | JWT | 获取对话列表 |
| POST | `/api/chats` | JWT | 创建新对话 |
| GET | `/api/chats/:id` | JWT | 获取对话详情 + 消息 |
| PUT | `/api/chats/:id` | JWT | 更新对话（标题/模型/标签） |
| DELETE | `/api/chats/:id` | JWT | 删除对话 |
| POST | `/api/chats/:id/share` | JWT | 分享对话 |
| GET | `/api/chats/shared/:shareId` | 无 | 查看共享对话 |
| GET | `/api/messages/search` | JWT | 搜索消息 |

**工单 + KOL API (`api/ticket-kol-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/tickets` | JWT | 获取工单列表 |
| POST | `/api/tickets` | JWT | 创建工单 |
| PUT | `/api/tickets/:id` | JWT | 更新工单 |
| GET | `/api/kols` | JWT | 获取 KOL 列表 |
| POST | `/api/kols` | JWT | 创建 KOL |
| PUT | `/api/kols/:id` | JWT | 更新 KOL |

**知识库 API (`api/knowledge-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/knowledge` | JWT | 获取知识库文档列表 |
| POST | `/api/knowledge` | JWT | 上传知识库文档 |
| PUT | `/api/knowledge/:id` | JWT | 更新文档 |
| DELETE | `/api/knowledge/:id` | JWT | 删除文档 |
| POST | `/api/knowledge/search` | JWT | 语义搜索 |

**系统管理 API (`api/system-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/health` | 无 | 健康检查 |
| GET | `/api/version` | 无 | 版本信息 |
| GET | `/api/stats` | JWT | 系统统计 |
| GET | `/api/system/config` | Admin | 系统配置 |
| PUT | `/api/system/config` | Admin | 更新配置 |
| GET | `/api/models` | JWT | 可用模型列表 |

**用户管理 API (`api/user-management-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/users` | Admin | 用户列表 |
| PUT | `/api/users/:id` | Admin | 更新用户 |
| DELETE | `/api/users/:id` | Admin | 删除用户 |
| GET | `/api/roles` | Admin | 角色列表 |
| GET | `/api/audit-logs` | Admin | 审计日志 |
| GET | `/api/notifications` | JWT | 通知列表 |

**工作流 API (`api/workflow-api.mjs`)**

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/workflows` | JWT | 工作流列表 |
| POST | `/api/workflows` | JWT | 创建工作流 |
| PUT | `/api/workflows/:id` | JWT | 更新工作流 |
| POST | `/api/workflows/:id/run` | JWT | 执行工作流 |

### 3.5 WebSocket 事件协议

WebSocket 连接通过 `/ws` 路径建立，使用 JSON 消息格式。客户端连接时需要在 URL 参数中传递 JWT token。

**客户端 → 服务端事件**

| 事件类型 | 字段 | 说明 |
|----------|------|------|
| `send-message` | `message`, `sessionKey`, `model?`, `attachments?` | 发送用户消息 |
| `bind-chat` | `chatId` | 绑定 WebSocket 到指定对话 |
| `recover-task` | `taskId` | 恢复中断的任务 |
| `cancel` | `taskId` | 取消正在执行的任务 |
| `force-reset` | — | 强制重置连接状态 |
| `ping` | — | 心跳 ping |

**服务端 → 客户端事件**

| 事件类型 | 关键字段 | 说明 |
|----------|---------|------|
| `connected` | `gatewayConnected`, `capabilities`, `skills`, `tools` | 连接成功，返回 Gateway 状态 |
| `chat_bound` | `chatId` | 对话绑定成功 |
| `stream_start` | `msgId` | AI 回复流开始 |
| `stream_chunk` | `msgId`, `content` | AI 回复流式内容块 |
| `thinking` | `content`, `msgId?` | AI 思考过程 |
| `tool_start` | `msgId`, `tool`, `args` | 工具调用开始 |
| `tool_result` | `msgId`, `tool`, `result` | 工具调用结果 |
| `tool_end` | `msgId` | 工具调用结束 |
| `stream_end` | `msgId`, `content`, `model?` | AI 回复流结束 |
| `status` | `status` (`idle`/`processing`) | 处理状态变更 |
| `title_update` | `title`, `sessionKey` | 对话标题自动生成 |
| `suggestions` | `suggestions` (string[]) | 后续问题建议 |
| `error` | `message` | 错误消息 |
| `routing_info` | `taskType`, `thinking`, `confidence?` | 智能路由信息 |
| `step` / `step_update` | `id`, `title`, `status`, `detail` | 执行步骤进度 |
| `history` | `messages` | 对话历史恢复 |
| `pong` | — | 心跳响应 |
| `system_notice` | `message`, `severity` | 系统通知 |
| `progress` | `taskId`, `phase`, `timestamp` | 任务进度 |
| `recovery_status` | `phase`, `message` | 恢复状态 |

### 3.6 Worker 子进程通信

主进程与 Worker 之间通过 Node.js IPC 通道通信，消息格式由 `lib/schemas/ipc-schemas.mjs` 定义。

**主进程 → Worker（上行消息）**

```javascript
{
  type: "chat",           // 消息类型
  sessionKey: "xxx",      // 会话标识
  message: "用户输入",     // 用户消息
  history: [...],         // 对话历史
  model: "gemini-2.5-pro", // 指定模型（可选）
  attachments: [...],     // 附件（可选）
  taskId: "xxx",          // 任务 ID
}
```

**Worker → 主进程（下行消息）**

```javascript
{
  type: "stream_chunk" | "stream_end" | "tool_start" | "tool_result" | "error" | ...,
  sessionKey: "xxx",
  msgId: "xxx",
  content: "...",         // 内容
  // ... 其他字段根据 type 不同而异
}
```

### 3.7 认证与安全模块

`auth.mjs` 是安全配置的核心，管理三类令牌：

**ADMIN_TOKEN**：管理员 API 令牌，用于 `/api/metrics`、`/api/tasks/active`、`/admin/*` 等端点。优先级：环境变量 → 持久化文件 (`.admin-token`) → 自动生成。生成后自动持久化到 `/opt/rangerai-agent/.admin-token`，确保 Prometheus 抓取和服务重启后令牌不变。

**WS_TOKEN**：WebSocket 连接令牌，客户端必须在连接 URL 中传递 `?token=xxx`。优先级：环境变量 → 自动生成随机令牌。

**JWT**：用户认证令牌，由 `database.mjs` 中的 `generateToken()` 和 `verifyToken()` 管理。JWT 密钥从环境变量 `JWT_SECRET` 读取。

**CORS 配置**：允许的源包括 `https://ranger.voyage`、`http://localhost:3000`、`http://localhost:5173` 等。

**安全头**：所有响应添加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`X-XSS-Protection`、`HSTS`、`Referrer-Policy`、`Permissions-Policy`。

---

## 4. 前端架构深度解析

### 4.1 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| **React** | 18 | UI 框架 |
| **TypeScript** | — | 类型安全 |
| **Vite** | — | 构建工具 |
| **TailwindCSS** | 4 | 样式框架 |
| **wouter** | — | 路由（轻量级 React Router 替代） |
| **shadcn/ui** | — | UI 组件库 |
| **Zustand** (via useChatStore) | — | 状态管理 |
| **sonner** | — | Toast 通知 |
| **lucide-react** | — | 图标库 |
| **streamdown** | — | Markdown 流式渲染 |
| **mermaid** | — | 图表渲染 |
| **katex** | — | 数学公式渲染 |
| **shiki** | — | 代码高亮 |
| **recharts** | — | 图表组件 |
| **cytoscape** | — | 网络图渲染 |

### 4.2 目录结构

```
/opt/rangerai-web/
├── client/
│   ├── src/
│   │   ├── App.tsx                    → 路由定义 + 全局组件
│   │   ├── main.tsx                   → 入口文件
│   │   ├── index.css                  → 全局样式 + Tailwind 主题
│   │   ├── pages/                     → 页面组件（28 个）
│   │   │   ├── ChatPage.tsx           → AI 对话主页面（606 行）
│   │   │   ├── LoginPage.tsx          → 登录/注册页
│   │   │   ├── GlobalDashboard.tsx    → 全局仪表盘首页
│   │   │   ├── CeoDashboard.tsx       → CEO 决策看板
│   │   │   ├── CeoDashboardPanels.tsx → CEO 看板子面板
│   │   │   ├── AdminDashboard.tsx     → 管理控制台
│   │   │   ├── DataAnalytics.tsx      → 数据分析
│   │   │   ├── TicketManager.tsx      → 工单管理
│   │   │   ├── KolManager.tsx         → KOL 管理
│   │   │   ├── KolDetail.tsx          → KOL 详情
│   │   │   ├── InventoryMonitor.tsx   → 库存监控
│   │   │   ├── DailyReports.tsx       → 日报分析
│   │   │   ├── TikTokPartners.tsx     → TikTok 达人管理
│   │   │   ├── TikTokScriptGen.tsx    → TikTok 脚本生成
│   │   │   ├── WorkflowEditor.tsx     → 工作流编辑器
│   │   │   ├── TaskQueue.tsx          → 任务队列
│   │   │   ├── TeamManagement.tsx     → 团队管理
│   │   │   ├── KnowledgeBase.tsx      → 知识库
│   │   │   ├── NotificationCenter.tsx → 通知中心
│   │   │   ├── OperationalEfficiency.tsx → 运营效率
│   │   │   ├── PromptTemplates.tsx    → 提示词模板
│   │   │   ├── StatsPage.tsx          → 统计页面
│   │   │   ├── InviteCodesPage.tsx    → 邀请码管理
│   │   │   ├── SearchDebug.tsx        → 搜索调试
│   │   │   ├── ComponentShowcase.tsx  → 组件展示
│   │   │   ├── NotFound.tsx           → 404 页面
│   │   │   ├── Home.tsx               → 首页（重定向）
│   │   │   ├── CapabilitiesPanel.tsx  → 能力面板
│   │   │   ├── admin/                 → 管理面板子组件
│   │   │   │   ├── OverviewTab.tsx
│   │   │   │   ├── SystemTab.tsx
│   │   │   │   ├── UsersTab.tsx
│   │   │   │   ├── ConfigTab.tsx
│   │   │   │   ├── RolesTab.tsx
│   │   │   │   ├── AuditTab.tsx
│   │   │   │   ├── AssignRulesTab.tsx
│   │   │   │   ├── OpenPlatformTab.tsx
│   │   │   │   └── shared.tsx
│   │   │   └── ceo-components/
│   │   │       └── CeoUtils.tsx
│   │   ├── components/                → 可复用组件
│   │   │   ├── AdminRoute.tsx         → 管理员路由守卫
│   │   │   ├── Breadcrumb.tsx         → 面包屑导航
│   │   │   ├── CommandPalette.tsx     → 全局搜索（Ctrl+K）
│   │   │   ├── ErrorBoundary.tsx      → 全局错误边界
│   │   │   ├── NetworkStatusBar.tsx   → 网络状态栏
│   │   │   ├── EmptyState.tsx         → 空状态组件
│   │   │   ├── ConfirmDialog.tsx      → 确认对话框
│   │   │   ├── AutoRefreshControl.tsx → 自动刷新控制
│   │   │   ├── PageLoadingSkeleton.tsx → 页面加载骨架屏
│   │   │   ├── DashboardLayout.tsx    → 仪表盘布局
│   │   │   ├── DashboardLayoutSkeleton.tsx
│   │   │   ├── ManusDialog.tsx        → Manus 对话框
│   │   │   ├── AIChatBox.tsx          → AI 聊天组件
│   │   │   ├── Map.tsx                → 地图组件
│   │   │   └── chat/                  → 聊天相关子组件
│   │   │       ├── Sidebar.tsx        → 对话列表侧边栏
│   │   │       ├── MessageList.tsx    → 消息列表
│   │   │       ├── MessageInput.tsx   → 消息输入框
│   │   │       ├── ModelSelector.tsx  → 模型选择器
│   │   │       ├── RoleSelector.tsx   → AI 角色选择器
│   │   │       ├── FilePanel.tsx      → 文件面板
│   │   │       ├── FileUploadButton.tsx → 文件上传
│   │   │       ├── AttachmentPreview.tsx → 附件预览
│   │   │       ├── MessageAttachments.tsx → 消息附件
│   │   │       ├── AIFileOutput.tsx   → AI 文件输出
│   │   │       ├── ShareDialog.tsx    → 分享对话框
│   │   │       ├── TagManager.tsx     → 标签管理
│   │   │       ├── SearchResultCards.tsx → 搜索结果卡片
│   │   │       ├── KnowledgeReferences.tsx → 知识库引用
│   │   │       ├── CapabilitiesPanel.tsx → 能力面板
│   │   │       ├── RecoveryBanner.tsx → 恢复横幅
│   │   │       ├── LazyStreamdown.tsx → 懒加载 Markdown
│   │   │       └── LanguageSwitcher.tsx → 语言切换
│   │   ├── hooks/                     → 自定义 Hooks
│   │   │   ├── useChatStore.tsx       → 聊天状态管理（1310 行，核心）
│   │   │   ├── useWebSocket.ts        → WebSocket 连接管理
│   │   │   ├── useSimpleAuth.ts       → 认证状态 Hook
│   │   │   ├── useAutoRefresh.ts      → 自动刷新 Hook
│   │   │   ├── useIsMobile.ts         → 移动端检测
│   │   │   ├── useMobile.tsx          → 移动端适配
│   │   │   ├── useDebounce.ts         → 防抖 Hook
│   │   │   ├── useLocalStorage.ts     → 本地存储 Hook
│   │   │   ├── useNetworkStatus.ts    → 网络状态 Hook
│   │   │   ├── usePersistFn.ts        → 持久化函数 Hook
│   │   │   ├── useComposition.ts      → 输入法组合 Hook
│   │   │   └── useKeyboardShortcuts.ts → 键盘快捷键
│   │   ├── lib/                       → 工具库
│   │   │   ├── api.ts                 → HTTP API 客户端
│   │   │   ├── types.ts              → TypeScript 类型定义
│   │   │   ├── utils.ts              → 通用工具函数
│   │   │   ├── i18n.tsx              → 国际化（中/英）
│   │   │   ├── clipboard.ts          → 剪贴板工具
│   │   │   ├── dateUtils.ts          → 日期工具
│   │   │   ├── exportUtils.ts        → 导出工具
│   │   │   ├── formValidation.ts     → 表单验证
│   │   │   ├── webVitals.ts          → Web 性能指标
│   │   │   ├── trpc.ts              → tRPC 客户端（Manus 模板用）
│   │   │   └── *.test.ts            → 单元测试文件（80+ 个）
│   │   └── contexts/
│   │       └── ThemeContext.tsx       → 主题上下文
│   └── public/
│       ├── favicon.svg
│       ├── robots.txt
│       └── sitemap.xml
├── vite.config.standalone.ts          → 独立构建配置（Aliyun 部署用）
├── server/                            → Manus 模板后端（tRPC）
└── drizzle/                           → Manus 模板数据库 schema
```

### 4.3 路由配置

所有路由在 `App.tsx` 中通过 wouter 的 `<Switch>` 和 `<Route>` 定义。页面使用 `React.lazy()` 实现代码分割。

| 路径 | 组件 | 权限 | 说明 |
|------|------|------|------|
| `/` | `Home` → 重定向到 `/chat` | 公开 | 首页 |
| `/login` | `LoginPage` | 公开 | 登录/注册 |
| `/chat` | `ChatPage` | 需登录 | AI 对话主界面 |
| `/chat/:id` | `ChatPage` | 需登录 | 指定对话 |
| `/dashboard` | `GlobalDashboard` | 需登录 | 全局仪表盘 |
| `/ceo` | `CeoDashboard` | Admin | CEO 决策看板 |
| `/data-analytics` | `DataAnalytics` | 需登录 | 数据分析 |
| `/daily-reports` | `DailyReports` | 需登录 | 日报分析 |
| `/tickets` | `TicketManager` | 需登录 | 工单管理 |
| `/kols` | `KolManager` | 需登录 | KOL 管理 |
| `/kols/:id` | `KolDetail` | 需登录 | KOL 详情 |
| `/inventory` | `InventoryMonitor` | 需登录 | 库存监控 |
| `/tiktok-partners` | `TikTokPartners` | 需登录 | TikTok 达人 |
| `/tiktok-scripts` | `TikTokScriptGen` | 需登录 | 脚本生成 |
| `/knowledge` | `KnowledgeBase` | 需登录 | 知识库 |
| `/workflows` | `WorkflowEditor` | 需登录 | 工作流编辑 |
| `/tasks` | `TaskQueue` | 需登录 | 任务队列 |
| `/team` | `TeamManagement` | Admin | 团队管理 |
| `/admin` | `AdminDashboard` | Admin | 管理控制台 |
| `/stats` | `StatsPage` | Admin | 统计页面 |
| `/prompts` | `PromptTemplates` | Admin | 提示词管理 |
| `/invite-codes` | `InviteCodesPage` | Admin | 邀请码管理 |
| `/ops-efficiency` | `OperationalEfficiency` | Admin | 运营效率 |
| `/notifications` | `NotificationCenter` | 需登录 | 通知中心 |
| `/search-debug` | `SearchDebug` | 需登录 | 搜索调试 |

> **AdminRoute 守卫**：标记为 Admin 的路由被 `<AdminRoute>` 组件包裹，非管理员用户会看到 403 页面并在 5 秒后自动跳转到首页。

### 4.4 核心状态管理：useChatStore

`useChatStore.tsx`（1310 行）是整个前端最核心的状态管理模块，采用类 Zustand 模式（实际是 React Context + useReducer），管理所有对话相关状态。

**核心状态**

```typescript
interface ChatState {
  // 对话列表
  chats: Chat[];
  currentChatId: string | null;
  isLoadingChats: boolean;
  
  // 消息
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  
  // WebSocket
  connected: boolean;
  connectionState: WsConnectionState;
  
  // AI 状态
  routingInfo: RoutingInfo | null;
  executionSteps: ExecutionStep[];
  suggestions: string[];
  
  // 工作区文件
  workspaceFiles: WorkspaceFile[];
  selectedFilePath: string | null;
  fileContent: string | null;
  isFilePanelOpen: boolean;
}
```

**关键操作流程**

1. **发送消息**：`sendMessage()` → HTTP POST `/api/chats/:id/messages` → WebSocket `send-message` 事件 → 等待 `stream_chunk` / `stream_end` 事件
2. **创建对话**：`createNewChat()` → HTTP POST `/api/chats` → WebSocket `bind-chat` 事件
3. **加载对话**：`selectChat()` → HTTP GET `/api/chats/:id` → WebSocket `bind-chat` 事件 → 接收 `history` 事件
4. **重试机制**：关键操作使用 `withRetry()` 工具函数，支持指数退避 + 抖动

### 4.5 WebSocket 连接管理：useWebSocket

`useWebSocket.ts` 管理 WebSocket 连接的完整生命周期：

**连接建立**：构造 `wss://ranger.voyage/ws?token=<JWT>` URL，建立 WebSocket 连接。

**心跳机制**：每 25 秒发送 `ping`，8 秒内未收到 `pong` 则判定连接异常。如果 pong 延迟超过 5 秒，标记为 stale 连接。

**自动重连**：断开后使用指数退避策略重连，最多 20 次尝试。监听 `navigator.onLine` 网络事件，网络恢复时立即重连。区分正常关闭和服务器重启（通过 close code）。

**事件分发**：所有收到的 JSON 消息通过 `onEvent` 回调传递给 `useChatStore` 处理。

### 4.6 认证流程

前端使用 `useSimpleAuth` Hook 管理认证状态，而非 Manus 模板的 tRPC `useAuth`（因为 RangerAI 使用自己的 REST API）。

```
用户访问 → LoginPage → POST /api/auth/login → 返回 JWT
                                                    ↓
                                            localStorage 存储
                                                    ↓
                                            api.ts 自动附加 Authorization header
                                                    ↓
                                            useSimpleAuth → GET /api/auth/me → 获取用户信息
```

### 4.7 Vite 构建配置

`vite.config.standalone.ts` 是独立构建配置（不依赖 Manus 平台），关键配置：

**路径别名**：`@` → `client/src`，`@shared` → `shared`，`@assets` → `attached_assets`

**代码分割策略**：
- **React.lazy()** 处理页面级分割（每个页面独立 chunk）
- **manualChunks** 仅分割大型独立库（mermaid、cytoscape、shiki、katex、recharts）
- **不分割 react/react-dom/lucide-react**（避免循环依赖，这是之前白屏 bug 的根因）

### 4.8 全局功能组件

**ErrorBoundary**：全局错误边界，捕获 React 渲染错误，自动重试最多 2 次，显示错误详情并上报到 `/api/error-report`。

**CommandPalette**：全局搜索面板（Ctrl+K / Cmd+K），搜索页面、工单、KOL、知识库，支持快速导航。

**NetworkStatusBar**：网络状态栏，检测离线/在线状态，显示连接恢复提示。

**GlobalKeyboardShortcuts**：全局键盘快捷键，`G+C` 跳转 CEO 看板，`G+D` 跳转数据分析，`?` 显示帮助。

---

## 5. 数据流与通信协议

### 5.1 HTTP + WebSocket 混合通信

RangerAI 采用 HTTP + WebSocket 混合通信架构。HTTP 用于 CRUD 操作（对话管理、用户管理等），WebSocket 用于实时流式通信（AI 对话、状态推送）。

```
┌──────────────────────────────────────────────────────────────┐
│                      前端 (React SPA)                         │
│                                                               │
│  ┌──────────────┐        ┌──────────────────────────────┐    │
│  │  api.ts      │        │  useWebSocket.ts              │    │
│  │  (HTTP)      │        │  (WebSocket)                  │    │
│  │              │        │                               │    │
│  │  CRUD 操作:  │        │  实时通信:                     │    │
│  │  - 对话列表  │        │  - 发送消息                    │    │
│  │  - 创建对话  │        │  - 接收 AI 流式回复            │    │
│  │  - 删除对话  │        │  - 工具调用进度                │    │
│  │  - 用户认证  │        │  - 标题生成                    │    │
│  │  - 工单/KOL  │        │  - 建议问题                    │    │
│  └──────┬───────┘        └──────────┬───────────────────┘    │
└─────────┼───────────────────────────┼────────────────────────┘
          │ HTTPS                     │ WSS
          ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Caddy (反向代理)                           │
│  /api/* → 127.0.0.1:3002    /ws → 127.0.0.1:3002           │
└─────────────────────────────────────────────────────────────┘
          │                           │
          ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│              RangerAI Agent (server.mjs:3002)                │
│                                                              │
│  HTTP Router ◄──────────── WebSocket Handler                 │
│      │                          │                            │
│      ▼                          ▼                            │
│  API Modules              Worker Manager                     │
│  (7 modules)                   │ IPC                         │
│      │                         ▼                             │
│      ▼                    Worker 子进程                       │
│  Database                      │                             │
│  (MySQL)                       ▼                             │
│                          Gateway Connector                    │
│                                │ WebSocket                   │
│                                ▼                             │
│                         OpenClaw Gateway                      │
│                          (:18789)                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 AI 对话完整数据流

一次完整的 AI 对话请求经过以下步骤：

```
1. 用户在 ChatPage 输入消息，点击发送
   ↓
2. useChatStore.sendMessage() 被调用
   ↓
3. WebSocket 发送 { type: "send-message", message, sessionKey, model?, attachments? }
   ↓
4. ws-handler.mjs 接收消息，调用 ws-chat-handlers.handleSendMessage()
   ↓
5. 速率限制检查 (rateLimiter.checkMessage)
   ↓
6. 创建数据库消息记录 (createMessage)
   ↓
7. 智能路由分析 (smart-router.mjs classifyTask)
   ↓
8. 发送 routing_info 事件到前端
   ↓
9. 通过 IPC 发送消息到 Worker 子进程
   ↓
10. Worker 通过 Gateway Connector 连接 OpenClaw Gateway
    ↓
11. OpenClaw Gateway 调用 AI 模型（Google/OpenAI/OpenRouter）
    ↓
12. AI 模型返回流式响应
    ↓
13. Worker 通过 IPC 逐块发送 stream_chunk 到主进程
    ↓
14. 主进程通过 WebSocket 逐块发送到前端
    ↓
15. useChatStore 更新 streamingContent 状态
    ↓
16. MessageList 组件实时渲染 Markdown 内容
    ↓
17. stream_end 事件到达，保存完整消息到数据库
    ↓
18. 异步生成对话标题 (generateTitle)
    ↓
19. 异步生成后续建议问题 (generateSuggestions)
```

### 5.3 工具调用数据流

当 AI 需要调用工具（如浏览器、Shell、搜索等）时：

```
AI 模型决定调用工具
    ↓
Gateway 发送 tool_start 事件 → Worker → IPC → 主进程 → WebSocket → 前端
    ↓
前端显示工具调用进度（tool 名称 + 参数）
    ↓
Gateway 执行工具（在 OpenClaw Sandbox 中）
    ↓
Gateway 发送 tool_result 事件 → Worker → IPC → 主进程 → WebSocket → 前端
    ↓
前端显示工具执行结果
    ↓
AI 模型继续生成回复（可能再次调用工具）
```

---

## 6. 数据库架构

### 6.1 数据库适配器

`db-adapter.mjs` 提供统一的数据库访问接口，支持 SQLite 和 MySQL 双后端。生产环境使用 MySQL 8.0（Docker 容器），开发环境可使用 SQLite。

**连接信息**

| 项目 | 值 |
|------|-----|
| **主机** | 127.0.0.1 |
| **端口** | 3306 |
| **数据库** | rangerai |
| **用户** | rangerai |
| **密码** | RangerAI2026 |
| **字符集** | utf8mb4_unicode_ci |

### 6.2 表结构总览

数据库包含 19 张表，覆盖对话、用户、工单、KOL、知识库、工作流等业务领域。

| 序号 | 表名 | 说明 | 关键字段 |
|------|------|------|---------|
| 1 | `chats` | 对话表 | id, title, userId, model, systemPrompt, isPinned, roleId |
| 2 | `messages` | 消息表 | id, chatId(FK), role, content, model, timestamp, toolCalls |
| 3 | `quick_prompts` | 快捷提示表 | id, title, content, category, icon, sortOrder |
| 4 | `invite_codes` | 邀请码表 | id, code, maxUses, usedCount, expiresAt, assignedRole |
| 5 | `invite_usage` | 邀请码使用记录 | id, invite_code_id(FK), used_by, used_at |
| 6 | `shared_chats` | 共享对话表 | id, chatId, sharedBy, messages(JSON), expiresAt |
| 7 | `audit_logs` | 审计日志表 | id, userId, action, target, detail, ip |
| 8 | `system_config` | 系统配置表 | key, value, description, category |
| 9 | `ai_roles` | AI 角色表 | id, name, systemPrompt, icon, color, category |
| 10 | `tickets` | 工单表 | id, ticket_no, title, status, priority, assigned_to, ai_suggestion |
| 11 | `ticket_comments` | 工单评论表 | id, ticket_id(FK), content, author, is_internal |
| 12 | `kols` | KOL 表 | id, name, platform, handle, followers, engagement_rate |
| 13 | `kol_cooperations` | KOL 合作表 | id, kol_id(FK), campaign_name, budget, status |
| 14 | `assign_rules` | 分配规则表 | id, category, priority, assignee, is_active |
| 15 | `notifications` | 通知表 | id, title, content, type, target_user, is_read |
| 16 | `departments` | 部门表 | id, name, parent_id, manager_id, sort_order |
| 17 | `users` | 用户表 | id, username, passwordHash, role, team, department_id |
| 18 | `knowledge_docs` | 知识库文档表 | id, title, content, category, tags, fileName |
| 19 | `workflows` | 工作流表 | id, name, steps(JSON), cronExpression, cronEnabled |

### 6.3 关键表关系

```
users ──1:N──► chats ──1:N──► messages
  │                │
  │                └──1:N──► shared_chats
  │
  ├──1:N──► audit_logs
  ├──1:N──► tickets ──1:N──► ticket_comments
  ├──1:N──► notifications
  └──N:1──► departments

kols ──1:N──► kol_cooperations

invite_codes ──1:N──► invite_usage
```

### 6.4 用户角色体系

| 角色 | 权限 | 说明 |
|------|------|------|
| `admin` | 全部权限 | 系统管理员，可访问所有功能 |
| `member` | 业务功能 | 普通成员，可使用 AI 对话和业务模块 |
| `viewer` | 只读 | 观察者，只能查看不能修改 |

---

## 7. AI 模型集成与智能路由

### 7.1 OpenClaw Gateway

OpenClaw Gateway 是 RangerAI 的 AI 引擎核心，运行在 `127.0.0.1:18789`，提供 V3 协议的 WebSocket 接口。Gateway 管理 AI 模型调用、工具执行（浏览器、Shell、搜索等）和沙箱环境。

**配置文件**：`/home/admin/.openclaw/openclaw.json`

**SOUL.md**：`/home/admin/.openclaw/SOUL.md` — Gateway 的系统提示词（身份文件），定义 RangerAI 的人格和行为准则。

### 7.2 智能路由（smart-router.mjs）

`smart-router.mjs`（477 行）负责分析用户消息并选择最优的 AI 模型。它通过关键词匹配和正则表达式将用户消息分类为不同任务类型，每种类型对应不同的模型和思考深度。

**任务分类表**

| 任务类型 | 思考深度 | 典型关键词 | 说明 |
|----------|---------|-----------|------|
| `image_generation` | high | draw, paint, 画, 生成图片 | 图片生成/编辑 |
| `code` | high | code, debug, 代码, 编程 | 代码生成/调试 |
| `reasoning` | high | analyze, 分析, 推理, 数学 | 复杂分析/推理 |
| `chinese_content` | medium | 文案, 翻译, 润色, 写作 | 中文内容创作 |
| `translation` | medium | translate, 翻译, localization | 翻译/本地化 |
| `creative` | medium | write, story, 创意, 小说 | 创意写作 |
| `research` | medium | research, 搜索, 查找, 调研 | 信息检索/研究 |
| `gaming` | medium | game, 游戏, 攻略, build | 游戏相关 |
| `sysadmin` | high | server, deploy, 部署, 运维 | 系统管理 |
| `chat` | medium | — | 默认闲聊 |

**路由策略**：优先使用 OpenClaw Gateway（主路径），当 Gateway 不可用时降级到 OpenRouter API（备用路径）。OpenRouter 支持多模型 fallback 链。

### 7.3 Gateway Connector

`gateway-connector.mjs`（578 行）管理与 OpenClaw Gateway 的 WebSocket 连接：

**动态端口发现**：从 `/home/admin/.openclaw/openclaw.json` 读取 Gateway 端口，并通过 `fs.watch` 监听配置文件变化，自动适应端口变更。

**智能重连**：使用状态机管理连接状态，指数退避重连，风暴保护（连续失败时逐步延长间隔）。

**错误分类**：将连接错误分为 5 类（CONNECTION_REFUSED、TIMEOUT、AUTH_ERROR、PROTOCOL_ERROR、CONFIG_ERROR），便于告警和排查。

**熔断器**（`worker/circuit-breaker.mjs`）：当 Gateway 连续失败超过阈值时触发熔断，避免雪崩。

---

## 8. Caddy 反向代理与路由

### 8.1 配置结构

Caddy 使用模块化配置，主配置文件 `/etc/caddy/Caddyfile` 通过 `import /etc/caddy/conf.d/*.caddy` 加载所有子配置。

| 配置文件 | 用途 |
|----------|------|
| `00-global.caddy` | 全局设置（邮箱、超时、keepalive） |
| `10-ranger-main.caddy` | 主站路由（ranger.voyage） |
| `20-gateway.caddy` | Gateway 子域名（gw.ranger.voyage） |

### 8.2 主站路由规则

`10-ranger-main.caddy` 定义了 `ranger.voyage` 的完整路由规则，按优先级从高到低：

```
1. OpenClaw Gateway 路由（最高优先级）
   /upload, /health, /files/*, /workspace/*, /_share/* → :3004 (FileServer)

2. WebSocket 路由
   /ws → :3002 (Agent, flush_interval=-1, 无超时)

3. RangerAI Agent API 路由（精确匹配）
   /api/tiktok*, /api/chats*, /api/task*, /api/session*,
   /api/models*, /api/skills*, /api/admin/*, /api/auth*,
   /api/tickets*, /api/kols*, /api/workspace*, /api/users*,
   /api/prompts*, /api/health*, /api/version*, /api/system*,
   /api/stats*, /api/knowledge*, /api/workflows*,
   /api/audit-logs*, /api/messages*, /api/notifications*,
   /api/roles*, /admin/* → :3002

4. Fallback API 路由
   /api/* → :3004 (OpenClaw Gateway)

5. Grafana 监控
   /grafana/* → :3004

6. ACP 桥接
   /acp/* → :3003

7. OpenClaw Gateway 直连
   /ed0d9821* → :18789

8. Gateway WebSocket 升级
   非 /ws 路径的 WebSocket 升级请求 → :18789

9. SPA Fallback（最低优先级）
   所有其他请求 → /var/www/rangerai/ 静态文件
   try_files {path} /index.html（SPA 路由支持）
```

### 8.3 安全头配置

Caddy 为静态文件添加安全头（后端 API 自行设置安全头）：

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; 
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; 
  font-src 'self' https://fonts.gstatic.com; 
  img-src 'self' data: https: blob:; 
  connect-src 'self' https: wss:; 
  frame-ancestors 'none'; 
  upgrade-insecure-requests
```

### 8.4 缓存策略

```
/index.html → Cache-Control: no-cache, no-store, must-revalidate
/assets/*   → Cache-Control: public, max-age=31536000, immutable
```

---

## 9. 监控与告警体系

### 9.1 监控栈架构

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Node Exporter│     │ RangerAI     │     │ Prometheus   │
│ (:9100)     │────►│ Agent        │────►│ (:9090)      │
│ 系统指标     │     │ /api/metrics │     │ 15s 采集间隔  │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │ Alertmanager │
                                          │ (:9093)      │
                                          │ 告警路由      │
                                          └──────┬───────┘
                                                 │
                                          ┌──────▼───────┐
                                          │ Grafana      │
                                          │ (:3000容器内) │
                                          │ 可视化仪表盘  │
                                          └──────────────┘
```

### 9.2 Prometheus 告警规则

共 7 条告警规则，分为三组：

**可用性告警 (rangerai-availability)**

| 告警名 | 条件 | 持续时间 | 严重级别 |
|--------|------|---------|---------|
| `AgentDown` | Agent 不可达 | 1 分钟 | critical |
| `NodeExporterDown` | Node Exporter 不可达 | 2 分钟 | warning |

**系统告警 (rangerai-system)**

| 告警名 | 条件 | 持续时间 | 严重级别 |
|--------|------|---------|---------|
| `HighCpuUsage` | CPU > 85% | 5 分钟 | warning |
| `HighMemoryUsage` | 内存 > 90% | 5 分钟 | warning |
| `DiskSpaceRunningLow` | 磁盘 > 85% | 10 分钟 | warning |
| `DiskSpaceCritical` | 磁盘 > 95% | 5 分钟 | critical |

**性能告警 (rangerai-performance)**

| 告警名 | 条件 | 持续时间 | 严重级别 |
|--------|------|---------|---------|
| `HighAgentRestartRate` | 1 小时内重启 > 3 次 | 立即 | warning |

### 9.3 Alertmanager 路由

```yaml
route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'default'
  routes:
    - match: { severity: critical }
      receiver: 'critical-alerts'
      repeat_interval: 1h
```

告警通过 Webhook 发送到 `http://localhost:3000/api/internal/alert-webhook`。

### 9.4 健康检查

`rangerai-healthcheck.timer` 每 5 分钟触发一次 `health-check.mjs`，检查所有服务状态并输出 JSON 格式报告到 `/var/log/rangerai-healthcheck.log`。

---

## 10. 部署流程

### 10.1 标准部署流程

RangerAI 有两条部署路径：**Manus 平台部署**和**手动部署**。

**Manus 平台部署（推荐）**

1. 在 Manus 平台修改代码
2. 运行 `pnpm test` 确保测试通过
3. 使用 `webdev_save_checkpoint` 创建检查点
4. 读取 `rangerai-deploy` skill 并执行部署流程
5. 部署脚本自动构建前端、同步到 Aliyun、重启服务

**手动部署（`scripts/deploy.sh`）**

```bash
cd /opt/rangerai-agent
./scripts/deploy.sh [--skip-tests] [--skip-backup]
```

部署流水线步骤：

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | Pre-flight checks | 运行 `startup-check.sh` 验证文件完整性 |
| 2 | Run tests | 执行 `tests/*.test.mjs` 单元测试 |
| 3 | Backup | 运行 `backup-db.sh` 备份数据库 |
| 4 | Build frontend | `npx vite build --config
 vite.config.standalone.ts` |
| 5 | Restart agent | `safe-restart-rangerai`（5 分钟冷却保护） |
| 6 | Health check | 最多 5 次重试检查 `/api/health` |
| 7 | Smoke test | 验证 `https://ranger.voyage/` 可访问 |

### 10.2 前端构建与部署

**构建命令**

```bash
cd /opt/rangerai-web
npx vite build --config vite.config.standalone.ts
```

构建输出到 `/opt/rangerai-web/dist/`，然后需要复制到 Caddy 静态服务目录：

```bash
sudo cp -r /opt/rangerai-web/dist/* /var/www/rangerai/
```

**构建产物**

```
/var/www/rangerai/
├── index.html              → SPA 入口
├── favicon.svg             → 网站图标
├── robots.txt              → 爬虫规则
├── sitemap.xml             → 站点地图
└── assets/                 → JS/CSS/字体/图片
    ├── index-*.js          → 主 bundle
    ├── ChatPage-*.js       → 对话页面 chunk
    ├── CeoDashboard-*.js   → CEO 看板 chunk
    ├── AdminDashboard-*.js → 管理面板 chunk
    ├── GlobalDashboard-*.js → 全局仪表盘 chunk
    ├── vendor-mermaid-*.js → Mermaid 图表库
    ├── vendor-shiki-*.js   → 代码高亮库
    ├── vendor-katex-*.js   → 数学公式库
    ├── vendor-recharts-*.js → 图表库
    ├── vendor-cytoscape-*.js → 网络图库
    └── KaTeX_*.woff2       → KaTeX 字体文件
```

### 10.3 后端部署

后端代码直接在 `/opt/rangerai-agent/` 目录修改，通过 `safe-restart-rangerai` 重启服务。

```bash
# 重启 Agent 服务（有 5 分钟冷却保护）
sudo /usr/local/bin/safe-restart-rangerai

# 查看服务状态
systemctl status rangerai-agent

# 查看最近日志
journalctl -u rangerai-agent -n 50 --no-pager

# 查看错误日志
tail -50 /var/log/rangerai-agent-error.log
```

### 10.4 回滚

```bash
cd /opt/rangerai-agent
./scripts/rollback.sh [commit-hash]
# 不带参数则回滚到上一个 commit
```

回滚脚本会自动：git stash → git checkout → 重建前端 → 重启服务 → 健康检查。

---

## 11. 自动化运维工具

### 11.1 脚本清单

| 脚本 | 路径 | 用途 |
|------|------|------|
| `deploy.sh` | `/opt/rangerai-agent/scripts/` | 完整部署流水线 |
| `rollback.sh` | `/opt/rangerai-agent/scripts/` | 回滚到指定版本 |
| `health-check.mjs` | `/opt/rangerai-agent/scripts/` | 健康检查（615 行） |
| `health-check.sh` | `/opt/rangerai-agent/scripts/` | 健康检查 Shell 版 |
| `startup-check.sh` | `/opt/rangerai-agent/scripts/` | 启动前完整性检查 |
| `smoke-test.sh` | `/opt/rangerai-agent/scripts/` | 全端点冒烟测试 |
| `backup-db.sh` | `/opt/rangerai-agent/scripts/` | 数据库备份 |
| `oss-backup.sh` | `/opt/rangerai-agent/scripts/` | OSS 云端备份 |
| `ci-gate.sh` | `/opt/rangerai-agent/scripts/` | CI 门禁检查 |
| `cleanup-tool.sh` | `/opt/rangerai-agent/scripts/` | 清理工具 |
| `daily-self-diagnosis.sh` | `/opt/rangerai-agent/scripts/` | 每日自诊断 |
| `system-check.sh` | `/opt/rangerai-agent/scripts/` | 系统检查 |
| `safe-restart-rangerai` | `/usr/local/bin/` | 冷却保护重启 |

### 11.2 定时任务（Cron）

| 时间 | 命令 | 说明 |
|------|------|------|
| 每天 03:30 | `benchmark.py` | OpenClaw 每日进化基准测试 |
| 每周日 04:00 | `self-assess.py` | OpenClaw 每周自评 |
| 每 6 小时 | `token-monitor.sh` | Token 使用量监控 |
| 每天 08:00 | `daily-evolution.sh` | 每日进化脚本 |
| 每天 08:05 | `daily-evolution-notify.sh` | 进化通知 |
| 每天 03:00 | `backup.sh` | OpenClaw 每日备份 |
| 每周日 04:00 | `rotate.sh` | 日志轮转 |
| 每天 03:30 | `oss-backup.sh` | 数据库 OSS 备份 |

### 11.3 safe-restart-rangerai

这是一个关键的安全重启脚本，防止频繁重启导致服务不稳定：

- **冷却保护**：两次重启之间至少间隔 300 秒（5 分钟）
- **冷却文件**：`/tmp/.rangerai-restart-cooldown` 记录上次重启时间
- **状态检查**：重启后等待 3 秒检查服务状态
- **绕过提示**：如果被冷却阻止，提示使用 `curl localhost:3002/health` 验证

### 11.4 startup-check.sh

启动前完整性检查，验证以下内容：

- 14 个必需源码模块是否存在
- `node_modules` 目录是否存在
- 关键 npm 依赖（mysql2, ws, redis）是否安装
- 日志目录是否存在
- `server.mjs` 是否可读

---

## 12. 安全架构

### 12.1 认证体系

| 层级 | 机制 | 说明 |
|------|------|------|
| **用户认证** | JWT | 登录后签发，localStorage 存储，每次请求 Authorization header 携带 |
| **管理员认证** | ADMIN_TOKEN | 持久化到文件，Prometheus 和管理 API 使用 |
| **WebSocket 认证** | WS_TOKEN + JWT | 连接时 URL 参数传递 |
| **注册控制** | 邀请码 | 新用户注册必须提供有效邀请码 |

### 12.2 CORS 策略

仅允许以下源：

```
https://ranger.voyage
http://ranger.voyage
https://www.ranger.voyage
http://localhost:3000
http://localhost:5173
http://127.0.0.1:3000
http://127.0.0.1:5173
```

### 12.3 CSP 策略

```
default-src 'self';
script-src 'self' https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data: https: blob:;
connect-src 'self' https: wss:;
frame-ancestors 'none';
upgrade-insecure-requests
```

> **注意**：`style-src` 中保留了 `'unsafe-inline'`，这是因为 TailwindCSS 和 shadcn/ui 需要内联样式。`script-src` 中**没有** `'unsafe-inline'` 和 `'unsafe-eval'`，这是安全的。

### 12.4 密码安全

- 密码使用 salt + hash 存储（`passwordHash` + `salt` 字段）
- 支持密码重置令牌（`password_reset_token` + `password_reset_expires`）

### 12.5 速率限制

WebSocket 消息发送有速率限制（`rateLimiter`），防止用户过于频繁发送消息。被限制时返回错误消息和重试等待时间。

### 12.6 输入验证

- 后端使用 Zod schema 验证 IPC 消息格式（`lib/schemas/ipc-schemas.mjs`）
- API 路由对请求参数进行验证
- 前端使用 `formValidation.ts` 进行表单验证

---

## 13. 常见故障排查手册

### 13.1 白屏问题

**症状**：访问 `ranger.voyage` 显示白屏，浏览器控制台报错。

**排查步骤**：

```bash
# 1. 检查前端构建是否成功
ls -la /var/www/rangerai/assets/index-*.js

# 2. 检查 Caddy 是否正常
systemctl status caddy
caddy validate --config /etc/caddy/Caddyfile

# 3. 检查浏览器控制台错误
# 常见原因：Vite manualChunks 循环依赖
# 解决方案：不要在 manualChunks 中分割 react/react-dom/lucide-react
```

**已知根因**：Vite `manualChunks` 将 `react` 和 `react-dom` 分到 `vendor-react` chunk，导致与页面 chunk 产生循环依赖。**解决方案**：只对大型独立库（mermaid, cytoscape, shiki, katex, recharts）进行手动分割，其余由 Vite 自动处理。

### 13.2 WebSocket 连接失败

**症状**：前端显示"连接断开"，无法发送消息。

**排查步骤**：

```bash
# 1. 检查 Agent 服务状态
systemctl status rangerai-agent

# 2. 检查端口监听
ss -tlnp | grep 3002

# 3. 检查 WebSocket 路由
curl -v -H "Upgrade: websocket" -H "Connection: Upgrade" https://ranger.voyage/ws

# 4. 检查 Agent 日志
tail -50 /var/log/rangerai-agent.log | grep -i "ws\|websocket"

# 5. 检查 Worker 进程
ps aux | grep agent-worker
```

**常见原因**：
- Agent 服务崩溃（内存溢出，`--max-old-space-size=512` 限制）
- Worker 子进程死亡未重启
- Gateway 连接断开导致 Worker 卡死

### 13.3 AI 回复无响应

**症状**：发送消息后一直显示"处理中"，无 AI 回复。

**排查步骤**：

```bash
# 1. 检查 OpenClaw Gateway 状态
curl http://127.0.0.1:18789/health 2>/dev/null

# 2. 检查 Gateway 进程
ps aux | grep openclaw-gateway

# 3. 检查 Worker 与 Gateway 的连接
tail -50 /var/log/rangerai-agent.log | grep -i "gateway\|openclaw"

# 4. 检查 smart-router 降级
tail -50 /var/log/rangerai-agent.log | grep -i "openrouter\|fallback"
```

**常见原因**：
- OpenClaw Gateway 进程崩溃
- Gateway WebSocket 连接超时
- AI 模型 API 限流或不可用
- 熔断器触发（连续失败过多）

### 13.4 服务频繁重启

**症状**：`systemctl status rangerai-agent` 显示频繁重启。

**排查步骤**：

```bash
# 1. 检查错误日志
tail -100 /var/log/rangerai-agent-error.log

# 2. 检查内存使用
ps aux --sort=-%mem | head -10

# 3. 检查端口冲突
ss -tlnp | grep 3002

# 4. 检查 Prometheus 告警
curl http://127.0.0.1:9090/api/v1/alerts 2>/dev/null | python3 -m json.tool
```

**常见原因**：
- 内存泄漏（超过 `MemoryMax=2G` 限制）
- 端口被占用（`EADDRINUSE`）
- 未捕获的异常

### 13.5 H5 移动端布局问题

**症状**：移动端页面底部出现大片白色空白。

**排查原因**：Bottom Sheet 组件在关闭状态下仍然渲染，占据页面空间。

**解决方案**：在 Bottom Sheet 组件中添加条件渲染，`isOpen` 为 false 时返回 null。

### 13.6 组件提取后 useEffect 未定义

**症状**：页面报错 `useEffect is not defined`。

**排查原因**：将组件从大文件提取到独立文件时，忘记导入 React Hooks。

**解决方案**：确保新文件顶部包含所有必要的 import：

```typescript
import { useState, useEffect, useMemo, useCallback } from 'react';
```

### 13.7 数据库连接失败

**排查步骤**：

```bash
# 1. 检查 MySQL 容器状态
docker ps | grep mysql

# 2. 测试连接
docker exec mysql-rangerai mysql -urangerai -pRangerAI2026 rangerai -e "SELECT 1"

# 3. 检查连接数
docker exec mysql-rangerai mysql -urangerai -pRangerAI2026 -e "SHOW PROCESSLIST"

# 4. 重启 MySQL
docker restart mysql-rangerai
```

### 13.8 Caddy 配置错误

**排查步骤**：

```bash
# 1. 验证配置
caddy validate --config /etc/caddy/Caddyfile

# 2. 检查日志
journalctl -u caddy -n 50 --no-pager

# 3. 重载配置（不重启）
caddy reload --config /etc/caddy/Caddyfile

# 4. 完全重启
systemctl restart caddy
```

---

## 14. 代码修改指南

### 14.1 添加新的 API 端点

**步骤 1**：在 `api/` 目录创建或修改 API 模块

```javascript
// api/new-feature-api.mjs
import { logger } from '../lib/logger.mjs';
import express from 'express';

export function registerNewFeatureRoutes(app, ctx) {
  const router = express.Router();
  
  router.get('/api/new-feature', async (req, res) => {
    try {
      // 使用 ctx.db 访问数据库
      const data = await ctx.db.query('SELECT * FROM ...');
      res.json({ success: true, data });
    } catch (err) {
      logger.error(`[new-feature] Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
  
  app.use(router);
}
```

**步骤 2**：在 `modules/http-router.mjs` 中注册

```javascript
import { registerNewFeatureRoutes } from '../api/new-feature-api.mjs';
// ... 在 registerRoutes 函数中添加
registerNewFeatureRoutes(app, ctx);
```

**步骤 3**：在 Caddy 配置中添加路由

```caddy
handle /api/new-feature* {
    reverse_proxy 127.0.0.1:3002
}
```

**步骤 4**：重载 Caddy 并重启 Agent

```bash
caddy reload --config /etc/caddy/Caddyfile
sudo /usr/local/bin/safe-restart-rangerai
```

### 14.2 添加新的前端页面

**步骤 1**：创建页面组件

```typescript
// client/src/pages/NewFeature.tsx
import { useState, useEffect } from 'react';
import { useSimpleAuth } from '../hooks/useSimpleAuth';
import { useI18n } from '../lib/i18n';
import * as api from '../lib/api';

export default function NewFeature() {
  const { user, isAuthenticated } = useSimpleAuth();
  const { t } = useI18n();
  
  // ... 页面逻辑
  
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* 页面内容 */}
    </div>
  );
}
```

**步骤 2**：在 `App.tsx` 中添加路由

```typescript
const NewFeature = lazy(() => import('./pages/NewFeature'));

// 在 Switch 中添加
<Route path={"/new-feature"} component={NewFeature} />
// 如果需要管理员权限
<Route path={"/new-feature"}>{() => <AdminRoute><NewFeature /></AdminRoute>}</Route>
```

**步骤 3**：在侧边栏导航中添加入口（如果需要）

编辑 `client/src/components/chat/Sidebar.tsx` 或 `App.tsx` 中的导航配置。

**步骤 4**：构建并部署

```bash
cd /opt/rangerai-web
npx vite build --config vite.config.standalone.ts
sudo cp -r dist/* /var/www/rangerai/
```

### 14.3 添加新的数据库表

**步骤 1**：编写 SQL

```sql
CREATE TABLE IF NOT EXISTS new_table (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_new_table_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**步骤 2**：执行 SQL

```bash
docker exec mysql-rangerai mysql -urangerai -pRangerAI2026 rangerai -e "CREATE TABLE IF NOT EXISTS ..."
```

**步骤 3**：在 `database.mjs` 中添加操作函数

```javascript
export async function getNewTableItems() {
  return await query('SELECT * FROM new_table ORDER BY created_at DESC');
}

export async function createNewTableItem(name) {
  return await run('INSERT INTO new_table (name) VALUES (?)', [name]);
}
```

**步骤 4**：更新 `docs/mysql_schema.sql` 文档

### 14.4 添加新的 WebSocket 事件

**步骤 1**：在 `modules/ws-message-handlers.mjs` 或 `ws-chat-handlers.mjs` 中添加处理器

```javascript
export async function handleNewEvent(ws, msg, state) {
  const { sendEvent } = deps;
  // 处理逻辑
  sendEvent(ws, { type: "new_event_response", data: "..." });
}
```

**步骤 2**：在 `modules/ws-handler.mjs` 中注册事件

```javascript
case 'new-event':
  await handleNewEvent(ws, msg, state);
  break;
```

**步骤 3**：在前端 `lib/types.ts` 中添加事件类型

```typescript
export type WsEventType = 
  | ... 
  | 'new_event_response';
```

**步骤 4**：在 `hooks/useChatStore.tsx` 中处理事件

```typescript
case 'new_event_response':
  // 更新状态
  break;
```

### 14.5 修改 AI 模型路由

编辑 `smart-router.mjs` 中的 `TASK_PATTERNS` 对象：

```javascript
const TASK_PATTERNS = {
  new_task_type: {
    keywords: [
      /关键词1/,
      /关键词2/i,
    ],
    thinking: "high",  // high | medium | low
    description: "新任务类型描述"
  },
  // ...
};
```

### 14.6 修改 Caddy 路由

```bash
# 1. 编辑配置
sudo nano /etc/caddy/conf.d/10-ranger-main.caddy

# 2. 验证配置
caddy validate --config /etc/caddy/Caddyfile

# 3. 热重载（不中断服务）
caddy reload --config /etc/caddy/Caddyfile
```

### 14.7 代码修改注意事项

**前端修改注意事项**：

1. **不要分割 react/react-dom**：在 `vite.config.standalone.ts` 的 `manualChunks` 中，绝对不要将 react、react-dom、lucide-react 分到独立 chunk，否则会导致白屏
2. **组件提取时检查 import**：从大文件提取组件到独立文件时，必须确保所有 React Hooks（useState, useEffect, useMemo, useCallback 等）都已导入
3. **使用 useSimpleAuth 而非 useAuth**：RangerAI 使用自己的 REST API，不使用 tRPC，因此必须使用 `useSimpleAuth` Hook
4. **移动端适配**：Bottom Sheet 等条件渲染组件必须在关闭时返回 null，避免占据布局空间
5. **国际化**：所有用户可见文本应使用 `useI18n()` 的 `t()` 函数

**后端修改注意事项**：

1. **使用 ctx 而非全局变量**：所有数据库操作通过 `ctx.db`，所有服务通过 `ctx.services`
2. **异步函数**：所有数据库操作函数都是 async，必须 await
3. **日志规范**：使用 `logger` 而非 `console.log`
4. **IPC 消息验证**：Worker 与主进程通信的消息必须通过 `ipc-schemas.mjs` 验证
5. **安全头**：新的 API 端点自动继承 `auth.mjs` 中的安全头

---

## 15. 完整文件索引

### 15.1 后端文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `server.mjs` | ~400 | 主入口：初始化 ctx、注册路由、启动服务器 |
| `auth.mjs` | ~200 | 安全配置：ADMIN_TOKEN、WS_TOKEN、CORS、安全头 |
| `database.mjs` | 906 | 数据库操作函数集合 |
| `db-adapter.mjs` | 262 | 数据库适配器（SQLite/MySQL） |
| `smart-router.mjs` | 477 | AI 智能路由 |
| `gateway-connector.mjs` | 578 | Gateway WebSocket 连接管理 |
| `knowledge-db.mjs` | 708 | 知识库数据库操作 |
| `remediation-engine.mjs` | 638 | 自动修复引擎 |
| `acp-bridge.mjs` | 308 | ACP 桥接（钉钉） |
| `acp-api.mjs` | 668 | ACP API 服务 |
| `file-server.mjs` | 563 | 文件服务器 |
| `task-store.mjs` | 370 | Redis 任务存储 |
| `embedding-cache.mjs` | 378 | 向量嵌入缓存 |
| `alert-manager.mjs` | 236 | 告警管理器 |
| `gateway-message-queue.mjs` | 241 | Gateway 消息队列 |
| `dingtalk-adapter.mjs` | 308 | 钉钉适配器 |
| `tiktok-api.mjs` | 248 | TikTok API |
| `modules/http-router.mjs` | 307 | HTTP 路由注册中心 |
| `modules/ws-handler.mjs` | 590 | WebSocket 连接管理 |
| `modules/ws-chat-handlers.mjs` | 391 | 聊天 WS 事件处理 |
| `modules/ws-chat-logic.mjs` | 340 | 聊天业务逻辑 |
| `modules/ws-message-handlers.mjs` | 358 | 消息 WS 事件处理 |
| `modules/worker-manager.mjs` | 779 | Worker 生命周期管理 |
| `lib/context.mjs` | 620 | 应用上下文工厂（DI） |
| `lib/logger.mjs` | — | 统一日志模块 |
| `lib/metrics-collector.mjs` | 371 | 指标收集器 |
| `lib/rag-utils.mjs` | 276 | RAG 工具函数 |
| `lib/schemas/ipc-schemas.mjs` | 236 | IPC 消息 Schema |
| `api/auth-api.mjs` | — | 认证 API |
| `api/chat-api.mjs` | 666 | 对话 API |
| `api/knowledge-api.mjs` | 618 | 知识库 API |
| `api/system-api.mjs` | 538 | 系统管理 API |
| `api/ticket-kol-api.mjs` | 601 | 工单+KOL API |
| `api/user-management-api.mjs` | 563 | 用户管理 API |
| `api/workflow-api.mjs` | 265 | 工作流 API |
| `worker/index.mjs` | 235 | Worker 入口 |
| `worker/openclaw-handler.mjs` | 466 | OpenClaw 消息处理 |
| `worker/user-message-handler.mjs` | 250 | 用户消息处理 |
| `worker/circuit-breaker.mjs` | — | 熔断器 |
| `worker/format-utils.mjs` | — | 格式化工具 |
| `worker/ipc-utils.mjs` | — | IPC 工具函数 |

### 15.2 前端关键文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `App.tsx` | ~300 | 路由定义 + 全局组件 |
| `pages/ChatPage.tsx` | 606 | AI 对话主界面 |
| `pages/GlobalDashboard.tsx` | — | 全局仪表盘首页 |
| `pages/CeoDashboard.tsx` | — | CEO 决策看板 |
| `pages/AdminDashboard.tsx` | — | 管理控制台 |
| `hooks/useChatStore.tsx` | 1310 | 聊天状态管理（核心） |
| `hooks/useWebSocket.ts` | — | WebSocket 连接管理 |
| `hooks/useSimpleAuth.ts` | — | 认证状态 Hook |
| `lib/api.ts` | — | HTTP API 客户端 |
| `lib/types.ts` | — | TypeScript 类型定义 |
| `lib/i18n.tsx` | — | 国际化 |
| `components/chat/Sidebar.tsx` | — | 对话列表侧边栏 |
| `components/chat/MessageList.tsx` | — | 消息列表 |
| `components/chat/MessageInput.tsx` | — | 消息输入框 |
| `components/ErrorBoundary.tsx` | — | 全局错误边界 |
| `components/CommandPalette.tsx` | — | 全局搜索 |
| `components/AdminRoute.tsx` | — | 管理员路由守卫 |

### 15.3 配置文件索引

| 文件 | 用途 |
|------|------|
| `/etc/caddy/Caddyfile` | Caddy 主配置 |
| `/etc/caddy/conf.d/00-global.caddy` | Caddy 全局设置 |
| `/etc/caddy/conf.d/10-ranger-main.caddy` | 主站路由 |
| `/etc/caddy/conf.d/20-gateway.caddy` | Gateway 子域名 |
| `/etc/systemd/system/rangerai-agent.service` | Agent 服务配置 |
| `/etc/systemd/system/rangerai-web.service` | Web 前端服务配置 |
| `/etc/systemd/system/rangerai-acp.service` | ACP 桥接服务配置 |
| `/etc/systemd/system/rangerai-fileserver.service` | 文件服务器配置 |
| `/etc/systemd/system/rangerai-static.service` | 静态服务器配置 |
| `/etc/systemd/system/rangerai-healthcheck.timer` | 健康检查定时器 |
| `/opt/rangerai-agent/.admin-token` | 持久化 ADMIN_TOKEN |
| `/home/admin/.openclaw/openclaw.json` | OpenClaw Gateway 配置 |
| `/home/admin/.openclaw/SOUL.md` | AI 身份文件 |
| `/opt/rangerai-web/vite.config.standalone.ts` | Vite 独立构建配置 |

### 15.4 日志文件索引

| 文件 | 内容 |
|------|------|
| `/var/log/rangerai-agent.log` | Agent 标准输出 |
| `/var/log/rangerai-agent-error.log` | Agent 错误输出 |
| `/var/log/rangerai-healthcheck.log` | 健康检查结果 |
| `/var/log/rangerai-deploy.log` | 部署日志 |
| `/var/log/rangerai-oss-backup.log` | OSS 备份日志 |
| `journalctl -u rangerai-agent` | Agent systemd 日志 |
| `journalctl -u rangerai-acp` | ACP systemd 日志 |
| `journalctl -u caddy` | Caddy 日志 |

---

## 附录 A：快速命令参考

### 服务管理

```bash
# 查看所有 RangerAI 服务状态
systemctl list-units 'rangerai*' --no-pager

# 重启 Agent（推荐方式，有冷却保护）
sudo /usr/local/bin/safe-restart-rangerai

# 强制重启（跳过冷却）
sudo systemctl restart rangerai-agent

# 重启所有服务
for svc in rangerai-agent rangerai-acp rangerai-fileserver rangerai-web; do
  sudo systemctl restart $svc
done

# 查看服务日志
journalctl -u rangerai-agent -f  # 实时跟踪
journalctl -u rangerai-agent -n 100 --no-pager  # 最近 100 行
```

### 数据库操作

```bash
# 连接 MySQL
docker exec -it mysql-rangerai mysql -urangerai -pRangerAI2026 rangerai

# 查看表列表
docker exec mysql-rangerai mysql -urangerai -pRangerAI2026 rangerai -e "SHOW TABLES"

# 查看用户列表
docker exec mysql-rangerai mysql -urangerai -pRangerAI2026 rangerai -e "SELECT id, username, role, isActive FROM users"

# 备份数据库
docker exec mysql-rangerai mysqldump -urangerai -pRangerAI2026 rangerai > /tmp/rangerai_backup.sql
```

### 前端构建

```bash
# 构建前端
cd /opt/rangerai-web
npx vite build --config vite.config.standalone.ts

# 部署到 Caddy
sudo cp -r dist/* /var/www/rangerai/

# 验证部署
curl -s -o /dev/null -w "%{http_code}" https://ranger.voyage/
```

### 监控

```bash
# 检查 Prometheus 目标
curl http://127.0.0.1:9090/api/v1/targets 2>/dev/null | python3 -m json.tool | head -30

# 检查告警
curl http://127.0.0.1:9090/api/v1/alerts 2>/dev/null | python3 -m json.tool

# 查看 Docker 容器状态
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# 系统资源
free -h && df -h / && uptime
```

### 健康检查

```bash
# Agent 健康检查
curl http://127.0.0.1:3002/api/health

# 前端可访问性
curl -s -o /dev/null -w "%{http_code}" https://ranger.voyage/

# Gateway 健康检查
curl http://127.0.0.1:18789/health

# 完整冒烟测试
cd /opt/rangerai-agent && bash scripts/smoke-test.sh
```

---

## 附录 B：已知问题与历史修复

### B.1 白屏问题（已修复）

**根因**：Vite `manualChunks` 将 `react` 分到 `vendor-react` chunk，与页面 chunk（如 `page-chat-page`）产生循环依赖。

**修复**：移除 `vendor-react` chunk，只保留大型独立库的手动分割。

### B.2 H5 移动端底部白色空白（已修复）

**根因**：Bottom Sheet 组件在 `isOpen=false` 时仍然渲染 DOM 元素。

**修复**：添加条件渲染 `if (!isOpen) return null`。

### B.3 CeoDashboard useEffect 未定义（已修复）

**根因**：组件从 `CeoDashboard.tsx` 提取到 `CeoDashboardPanels.tsx` 时，忘记导入 `useEffect`。

**修复**：在 `CeoDashboardPanels.tsx` 顶部添加 `import { useState, useEffect, useMemo, useCallback } from 'react'`。

### B.4 tRPC Context 崩溃（已修复）

**根因**：5 个页面使用了 Manus 模板的 `useAuth` Hook，该 Hook 依赖 tRPC Context，但 RangerAI 使用自己的 REST API。

**修复**：创建 `useSimpleAuth` Hook 替代 `useAuth`，直接调用 `/api/auth/me`。

### B.5 console.log 泄露（已修复）

**说明**：代码中存在 435 个 `console.log` 调用，已全部替换为 `logger` 模块。配置 ESLint 规则禁止 `console.log`。

---

> **文档维护说明**：本文档应在每次重大代码修改后更新。特别是添加新的 API 端点、数据库表、前端页面或修改路由配置时，必须同步更新对应章节。文档存放位置：`/opt/rangerai-agent/docs/RangerAI-代码架构与运维全书.md` 和 Manus 平台。
