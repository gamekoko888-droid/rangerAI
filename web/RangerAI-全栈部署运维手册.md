# RangerAI 全栈代码部署与运维手册

> **版本**: v1.0 | **日期**: 2026-03-10 | **作者**: RangerAI 运维团队
>
> 本手册是 RangerAI 项目在阿里云服务器上的完整部署与运维指南。RangerAI 是游侠出海团队的 AI 中台协作工具，底层基于 OpenClaw，服务于客服、运营、市场、财务等团队。本文档涵盖系统架构、服务管理、代码部署、数据库运维、安全配置、备份恢复、故障排查等全部内容，确保项目可完全自主运行和维护。

---

## 目录

1. [系统架构总览](#1-系统架构总览)
2. [服务器环境](#2-服务器环境)
3. [服务清单与管理](#3-服务清单与管理)
4. [网络与端口映射](#4-网络与端口映射)
5. [Caddy 反向代理配置](#5-caddy-反向代理配置)
6. [前端代码与部署](#6-前端代码与部署)
7. [后端代码与部署](#7-后端代码与部署)
8. [OpenClaw Gateway](#8-openclaw-gateway)
9. [数据库管理](#9-数据库管理)
10. [Redis 缓存](#10-redis-缓存)
11. [Docker 容器管理](#11-docker-容器管理)
12. [定时任务（Cron）](#12-定时任务cron)
13. [日志管理](#13-日志管理)
14. [安全配置](#14-安全配置)
15. [备份与恢复](#15-备份与恢复)
16. [自动化运维工具](#16-自动化运维工具)
17. [故障排查手册](#17-故障排查手册)
18. [OpenClaw Skills 管理](#18-openclaw-skills-管理)
19. [完整文件目录索引](#19-完整文件目录索引)

---

## 1. 系统架构总览

RangerAI 采用前后端分离的全栈架构，由 Caddy 作为统一入口提供 HTTPS 反向代理。整体架构分为四层：

**接入层**：Caddy 处理所有外部 HTTPS 请求（443 端口），自动管理 Let's Encrypt SSL 证书，根据 URL 路径将请求分发到不同后端服务。域名 `ranger.voyage` 和 `www.ranger.voyage` 指向主站，`gw.ranger.voyage` 指向 OpenClaw Gateway 直连入口。

**应用层**：包括 RangerAI Agent（核心后端 API + WebSocket）、OpenClaw Gateway（AI Agent 网关）、ACP Bridge（钉钉 + API 网关桥接）、FileServer（文件上传下载服务）。这些服务通过 systemd 管理，运行在不同端口上，仅监听 localhost，由 Caddy 统一对外暴露。

**数据层**：MySQL 8.0（Docker 容器，端口 3306）作为主数据库，Redis 7（Docker 容器，端口 6379）作为缓存层，SQLite（本地文件）作为 OpenClaw 内部存储。

**基础设施层**：Docker 运行数据库和辅助服务（SearXNG 搜索引擎、V2Ray 代理），systemd 管理所有应用服务的生命周期，cron 执行定时备份和健康检查。

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
              │ Static    │ │Agent │ │ OC   │ │ACP  │ │ Gateway   │
              │ Files     │ │:3002 │ │:3001 │ │:3003│ │ WS :18789 │
              │/var/www/  │ │      │ │      │ │     │ │           │
              │rangerai   │ │HTTP+ │ │HTTP  │ │HTTP │ │ WebSocket │
              │           │ │WS    │ │      │ │     │ │           │
              └───────────┘ └──┬───┘ └──┬───┘ └──┬──┘ └─────┬─────┘
                               │        │        │           │
                    ┌──────────▼────────▼────────▼───────────▼────┐
                    │              Data Layer                       │
                    │  MySQL 8.0 (:3306) · Redis 7 (:6379)         │
                    │  SQLite (OpenClaw local)                      │
                    └─────────────────────────────────────────────┘
```

---

## 2. 服务器环境

### 2.1 硬件与操作系统

| 项目 | 详情 |
|------|------|
| **云平台** | 阿里云 ECS |
| **公网 IP** | 8.219.186.244 |
| **操作系统** | Alibaba Cloud Linux 3.2104 U12.2 (OpenAnolis Edition) |
| **内核版本** | 5.10.134-19.2.al8.x86_64 |
| **CPU** | 8 核 |
| **内存** | 14 GiB |
| **磁盘** | 99 GB（已用 39%） |

### 2.2 运行时环境

| 工具 | 版本 | 安装路径 |
|------|------|----------|
| **Node.js** | v24.13.0 | /usr/bin/node |
| **npm** | 11.6.2 | /usr/bin/npm |
| **pnpm** | 10.28.2 | /home/admin/.local/share/pnpm |
| **Docker** | — | /usr/bin/docker |
| **Caddy** | 2.x | /usr/bin/caddy |
| **Python 3** | 3.x | /usr/bin/python3 |

### 2.3 SSH 访问

```bash
# 管理员账户
ssh admin@8.219.186.244 -p 22

# Root 账户（用于 systemd 服务管理）
ssh root@8.219.186.244 -p 22
```

> **安全提示**：SSH 端口 22 对外开放，同时还有备用端口 2222 和 2223。建议通过阿里云安全组限制 SSH 来源 IP。

---

## 3. 服务清单与管理

### 3.1 核心服务

RangerAI 由以下 systemd 服务组成，按重要性排序：

| 服务名 | 端口 | 运行用户 | 工作目录 | 说明 |
|--------|------|----------|----------|------|
| **caddy** | 443, 80 | caddy | — | HTTPS 反向代理，自动 TLS |
| **rangerai-agent** | 3002 | root | /opt/rangerai-agent | 核心后端 API + WebSocket |
| **openclaw-gateway** | 18789 | admin | /home/admin | AI Agent 网关（OpenClaw） |
| **rangerai-acp** | 3003 | admin | /opt/rangerai-agent | ACP 桥接（钉钉 + API） |
| **rangerai-fileserver** | — | root | /opt/rangerai-agent | 文件上传下载服务 |

**已废弃服务**（仍在运行但不再被 Caddy 路由使用）：

| 服务名 | 端口 | 说明 |
|--------|------|------|
| rangerai-web | 3000 | 旧版静态文件服务（Caddy 已直接提供 SPA 服务） |
| rangerai-static | 9999 | Python HTTP 静态服务器（已被 Caddy 替代） |

### 3.2 服务管理命令

```bash
# 查看所有服务状态
for svc in rangerai-agent openclaw-gateway rangerai-acp rangerai-fileserver caddy; do
  echo "$svc: $(systemctl is-active $svc)"
done

# 单个服务操作
sudo systemctl start   <service-name>    # 启动
sudo systemctl stop    <service-name>    # 停止
sudo systemctl restart <service-name>    # 重启
sudo systemctl status  <service-name>    # 查看状态
sudo systemctl enable  <service-name>    # 开机自启
sudo systemctl disable <service-name>    # 取消自启

# 重启所有核心服务
for svc in rangerai-agent rangerai-acp rangerai-fileserver openclaw-gateway; do
  sudo systemctl restart $svc
  echo "Restarted $svc"
done

# 查看服务日志
journalctl -u rangerai-agent -f          # 实时跟踪
journalctl -u rangerai-agent -n 50       # 最近 50 行
journalctl -u rangerai-agent --since "1 hour ago"  # 最近 1 小时
```

### 3.3 Systemd 服务文件位置

所有服务文件位于 `/etc/systemd/system/` 目录。修改服务文件后需执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart <service-name>
```

### 3.4 rangerai-agent 服务详解

rangerai-agent 是核心服务，其 systemd 配置包含以下关键设置：

```ini
[Service]
ExecStart=/usr/bin/node --max-old-space-size=512 /opt/rangerai-agent/server.mjs
EnvironmentFile=-/opt/rangerai-agent/.env
EnvironmentFile=-/opt/rangerai-agent/agent-secrets.env
Restart=always
RestartSec=8
LimitNOFILE=65535
MemoryMax=2G
StandardOutput=append:/var/log/rangerai-agent.log
StandardError=append:/var/log/rangerai-agent-error.log
```

**关键参数说明**：`--max-old-space-size=512` 限制 V8 堆内存为 512MB，`MemoryMax=2G` 是 systemd 层面的硬限制，`RestartSec=8` 表示崩溃后 8 秒自动重启，`LimitNOFILE=65535` 允许大量并发连接。启动前会自动清理残留进程（`ExecStartPre` 中 kill 占用 3002 端口的进程）。

---

## 4. 网络与端口映射

### 4.1 端口使用清单

| 端口 | 绑定地址 | 服务 | 对外暴露 |
|------|----------|------|----------|
| 443 | 0.0.0.0 | Caddy (HTTPS) | 是 |
| 80 | 0.0.0.0 | Caddy (HTTP→HTTPS) | 是 |
| 22 | 0.0.0.0 | SSH | 是 |
| 2222 | 0.0.0.0 | SSH 备用 | 是 |
| 2223 | 0.0.0.0 | SSH 备用 | 是 |
| 3000 | 0.0.0.0 | rangerai-web（废弃） | 否 |
| 3001 | 127.0.0.1 | OpenClaw Gateway HTTP | 否（Caddy 代理） |
| 3002 | 127.0.0.1 | rangerai-agent | 否（Caddy 代理） |
| 3003 | 0.0.0.0 | rangerai-acp | 是 |
| 3306 | 127.0.0.1 | MySQL (Docker) | 否 |
| 6379 | 127.0.0.1 | Redis | 否 |
| 6380 | 127.0.0.1 | Redis 测试实例 | 否 |
| 8888 | 127.0.0.1 | SearXNG (Docker) | 否 |
| 9999 | 0.0.0.0 | rangerai-static（废弃） | 否 |
| 18789 | 127.0.0.1 | OpenClaw Gateway | 否（Caddy 代理） |

### 4.2 防火墙规则

当前 iptables 规则：

```
ACCEPT  tcp  --  18.142.113.55  0.0.0.0/0  tcp dpt:22    # 允许特定 IP SSH
DROP    tcp  -- !127.0.0.1      0.0.0.0/0  tcp dpt:3002  # 禁止外部直连 Agent
```

> **建议**：通过阿里云安全组进一步限制入站规则，仅开放 22、80、443、3003 端口。

---

## 5. Caddy 反向代理配置

### 5.1 配置文件结构

Caddy 采用模块化配置，主入口文件 `/etc/caddy/Caddyfile` 通过 `import` 指令加载子配置：

```
/etc/caddy/
├── Caddyfile                  # 主入口（import conf.d/*.caddy）
└── conf.d/
    ├── 00-global.caddy        # 全局设置（邮箱、超时、keepalive）
    ├── 10-ranger-main.caddy   # 主站点路由规则
    └── 20-gateway.caddy       # Gateway 子域名
```

### 5.2 路由规则详解

`10-ranger-main.caddy` 定义了 `ranger.voyage` 和 `www.ranger.voyage` 的完整路由：

| URL 路径 | 目标服务 | 端口 | 说明 |
|----------|----------|------|------|
| `/upload` | OpenClaw Gateway | 3001 | 文件上传 |
| `/health` | OpenClaw Gateway | 3001 | Gateway 健康检查 |
| `/files/*` | OpenClaw Gateway | 3001 | 文件访问 |
| `/workspace/*` | OpenClaw Gateway | 3001 | 工作空间 |
| `/_share/*` | OpenClaw Gateway | 3001 | 共享资源 |
| `/ws` | rangerai-agent | 3002 | WebSocket（聊天） |
| `/api/chats*` | rangerai-agent | 3002 | 聊天 API |
| `/api/auth*` | rangerai-agent | 3002 | 认证 API |
| `/api/admin/*` | rangerai-agent | 3002 | 管理后台 API |
| `/api/tiktok*` | rangerai-agent | 3002 | TikTok API |
| `/api/tickets*` | rangerai-agent | 3002 | 工单 API |
| `/api/kols*` | rangerai-agent | 3002 | KOL 管理 API |
| `/api/knowledge*` | rangerai-agent | 3002 | 知识库 API |
| `/api/workflows*` | rangerai-agent | 3002 | 工作流 API |
| `/api/stats*` | rangerai-agent | 3002 | 统计 API |
| `/api/notifications*` | rangerai-agent | 3002 | 通知 API |
| `/api/*`（兜底） | OpenClaw Gateway | 3001 | 其他 API |
| `/acp/*` | rangerai-acp | 3003 | ACP 桥接 |
| `/ed0d9821*` | OpenClaw Gateway | 18789 | Gateway 直连 |
| WebSocket（非 /ws） | OpenClaw Gateway | 18789 | Gateway WebSocket |
| 其他路径 | 静态文件 | — | SPA fallback |

`20-gateway.caddy` 定义了 `gw.ranger.voyage` 子域名，直接代理到 OpenClaw Gateway（18789）。

### 5.3 Caddy 管理命令

```bash
# 验证配置语法
caddy validate --config /etc/caddy/Caddyfile

# 重新加载配置（不中断连接）
sudo systemctl reload caddy

# 重启 Caddy
sudo systemctl restart caddy

# 查看 Caddy 日志
journalctl -u caddy -n 30 --no-pager

# 编辑主站配置
sudo vim /etc/caddy/conf.d/10-ranger-main.caddy
# 编辑后必须验证 + 重载
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

### 5.4 添加新的 API 路由

当后端新增 API 端点时，需要在 Caddy 配置中添加路由规则。例如添加 `/api/reports*` 路由到 rangerai-agent：

```bash
# 1. 编辑主站配置
sudo vim /etc/caddy/conf.d/10-ranger-main.caddy

# 2. 在 "RangerAI Agent API routes" 区块中添加：
#    handle /api/reports* {
#        reverse_proxy 127.0.0.1:3002
#    }

# 3. 验证并重载
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

---

## 6. 前端代码与部署

### 6.1 技术栈

| 技术 | 版本 | 说明 |
|------|------|------|
| React | 19.2 | UI 框架 |
| TypeScript | 5.9 | 类型安全 |
| Tailwind CSS | 4.x | 样式框架 |
| Vite | 7.1 | 构建工具 |
| Wouter | 3.3 | 路由 |
| shadcn/ui | — | UI 组件库（Radix 基础） |
| Recharts | 2.15 | 图表库 |
| Streamdown | 1.4 | Markdown 流式渲染 |
| Shiki | — | 代码语法高亮 |
| Mermaid | — | 图表渲染 |

### 6.2 源码目录结构

前端源码位于 `/opt/rangerai-web/client/src/`：

```
client/src/
├── App.tsx                    # 路由定义 + 全局布局
├── main.tsx                   # 应用入口（Provider 注入）
├── index.css                  # 全局样式 + CSS 变量
├── pages/                     # 页面组件（共 24 个）
│   ├── LoginPage.tsx          # 登录/注册页
│   ├── ChatPage.tsx           # AI 聊天主页（lazy-loaded）
│   ├── AdminDashboard.tsx     # 管理后台
│   ├── CeoDashboard.tsx       # CEO 数据看板
│   ├── DataAnalytics.tsx      # 数据分析
│   ├── DailyReports.tsx       # 日报系统
│   ├── KnowledgeBase.tsx      # 知识库管理
│   ├── WorkflowEditor.tsx     # 工作流编辑器
│   ├── TeamManagement.tsx     # 团队管理
│   ├── TaskQueue.tsx          # 任务队列
│   ├── TicketManager.tsx      # 工单管理
│   ├── KolManager.tsx         # KOL 管理
│   ├── KolDetail.tsx          # KOL 详情
│   ├── TikTokPartners.tsx     # TikTok 合作伙伴
│   ├── TikTokScriptGen.tsx    # TikTok 脚本生成
│   ├── InventoryMonitor.tsx   # 库存监控
│   ├── OperationalEfficiency.tsx  # 运营效率
│   ├── GlobalDashboard.tsx    # 全局仪表盘
│   ├── InviteCodesPage.tsx    # 邀请码管理
│   ├── PromptTemplates.tsx    # 提示词模板
│   ├── StatsPage.tsx          # 统计页面
│   ├── NotificationCenter.tsx # 通知中心
│   ├── SearchDebug.tsx        # 搜索调试
│   └── NotFound.tsx           # 404 页面
├── components/                # 可复用组件
│   ├── chat/                  # 聊天相关组件
│   │   ├── LazyStreamdown.tsx # 懒加载 Markdown 渲染
│   │   ├── MessageBubble.tsx  # 消息气泡
│   │   └── ...
│   ├── ui/                    # shadcn/ui 基础组件
│   ├── Breadcrumb.tsx         # 面包屑导航
│   ├── CommandPalette.tsx     # 命令面板（Cmd+K）
│   ├── NetworkStatusBar.tsx   # 网络状态栏
│   ├── AdminRoute.tsx         # 管理员路由守卫
│   ├── ErrorBoundary.tsx      # 错误边界
│   └── FloatingLanguageSwitcher.tsx  # 语言切换
├── hooks/                     # 自定义 Hooks
│   ├── useSimpleAuth.ts       # 认证状态管理
│   ├── useWebSocket.ts        # WebSocket 连接
│   ├── useChatStore.ts        # 聊天状态管理
│   └── ...
├── lib/                       # 工具库
│   ├── api.ts                 # HTTP API 客户端（纯 fetch）
│   ├── types.ts               # TypeScript 类型定义
│   ├── i18n.tsx               # 国际化（中/英/繁）
│   ├── utils.ts               # 通用工具函数
│   └── webVitals.ts           # 性能监控
└── contexts/                  # React Context
    └── ThemeContext.tsx        # 主题管理
```

### 6.3 构建与部署

#### 一键部署（推荐）

```bash
sudo bash /opt/rangerai-agent/deploy-frontend.sh
```

该脚本（v5）执行以下步骤：检查并安装依赖 → 使用 `vite.config.standalone.ts` 构建 → 复制到 `/var/www/rangerai/` → 同步到 `/var/www/rangerai1/`（向后兼容）→ 验证部署结果。

#### 手动构建

```bash
cd /opt/rangerai-web

# 1. 安装/更新依赖
pnpm install

# 2. 构建（必须使用 standalone 配置）
npx vite build --config vite.config.standalone.ts

# 3. 部署到 Caddy 服务目录
sudo rm -rf /var/www/rangerai/assets
sudo cp dist/index.html /var/www/rangerai/
sudo cp -r dist/assets /var/www/rangerai/

# 4. 验证
curl -s -o /dev/null -w "%{http_code}" https://ranger.voyage/
```

> **重要**：必须使用 `vite.config.standalone.ts` 而非 `vite.config.ts`。后者包含 Manus 平台调试插件（`vite-plugin-manus-runtime`），在独立环境中会导致构建失败。

#### 添加新的前端依赖

```bash
cd /opt/rangerai-web
sudo pnpm add <package-name>
# 然后重新构建部署
sudo bash /opt/rangerai-agent/deploy-frontend.sh
```

### 6.4 前端认证机制

前端使用自有的 JWT 认证系统（非 Manus OAuth），流程如下：

1. 用户在 `LoginPage.tsx` 输入用户名/密码
2. 调用 `POST /api/auth/login`，后端验证后返回 JWT token
3. Token 存储在 `localStorage`（key: `rangerai_token`）
4. 后续所有 API 请求通过 `Authorization: Bearer <token>` 头携带认证信息
5. `useSimpleAuth` hook 通过 `GET /api/auth/me` 检查认证状态

### 6.5 前端与后端通信

前端通过两种方式与后端通信：

**HTTP API**（`lib/api.ts`）：所有 CRUD 操作使用纯 `fetch` 封装，不依赖 tRPC 或 Axios。API 基地址默认为空（同源），可通过 `VITE_API_BASE` 环境变量覆盖。

**WebSocket**（`hooks/useWebSocket.ts`）：聊天消息的实时推送通过 `/ws` 路径建立 WebSocket 连接，支持心跳检测（30 秒间隔）和自动重连。

---

## 7. 后端代码与部署

### 7.1 技术栈

| 技术 | 说明 |
|------|------|
| Node.js v24 | 运行时 |
| ESM (.mjs) | 模块系统 |
| Express-like HTTP | 自定义 HTTP 路由（非 Express 框架） |
| WebSocket (ws) | 实时通信 |
| MySQL 8.0 | 主数据库 |
| Redis 7 | 缓存 + 会话 |
| OpenRouter API | LLM 智能路由 |
| JWT | 认证 |

### 7.2 源码目录结构

后端源码位于 `/opt/rangerai-agent/`：

```
/opt/rangerai-agent/
├── server.mjs                 # 主入口（v69）— 编排骨架
├── lib/                       # 基础设施层
│   ├── bootstrap.mjs          # 环境加载 + 动态导入
│   ├── context-setup.mjs      # 依赖注入上下文组装
│   ├── context.mjs            # 上下文工具
│   ├── logger.mjs             # 日志系统
│   ├── metrics-collector.mjs  # 指标收集
│   ├── rag-utils.mjs          # RAG 工具
│   └── signals.mjs            # 进程信号处理
├── modules/                   # 核心模块
│   ├── http-router.mjs        # HTTP 路由注册器
│   ├── http-routes.mjs        # HTTP 路由定义
│   ├── ws-server.mjs          # WebSocket 服务器 + 心跳
│   ├── ws-handler.mjs         # WebSocket 消息处理
│   ├── worker-manager.mjs     # Worker 生命周期管理
│   ├── ai-services.mjs        # AI 服务（标题生成、建议等）
│   ├── provider-discovery.mjs # 模型/技能/工具发现
│   ├── file-handler.mjs       # 文件附件处理
│   ├── helpers.mjs            # 通用工具函数
│   └── event-buffer.mjs       # 事件缓冲
├── api/                       # API 路由处理器
│   ├── auth-api.mjs           # 认证 API（登录/注册/JWT）
│   ├── chat-api.mjs           # 聊天 API（CRUD）
│   ├── system-api.mjs         # 系统 API（健康/版本/统计）
│   ├── knowledge-api.mjs      # 知识库 API
│   ├── workflow-api.mjs       # 工作流 API
│   ├── ticket-kol-api.mjs     # 工单 + KOL API
│   └── user-management-api.mjs # 用户管理 API
├── worker/                    # Agent Worker（子进程）
│   ├── index.mjs              # Worker 入口
│   ├── openclaw-handler.mjs   # OpenClaw 消息处理
│   ├── user-message-handler.mjs # 用户消息处理
│   ├── circuit-breaker.mjs    # 熔断器
│   ├── format-utils.mjs       # 格式化工具
│   └── ipc-utils.mjs          # 进程间通信
├── smart-router.mjs           # LLM 智能路由（OpenRouter）
├── database.mjs               # 数据库操作层
├── db-adapter.mjs             # 数据库适配器（SQLite/MySQL）
├── auth.mjs                   # JWT 认证 + CORS
├── redis-pool.mjs             # Redis 连接池
├── gateway-connector.mjs      # OpenClaw Gateway 连接器
├── gateway-message-queue.mjs  # Gateway 消息队列
├── workflow-scheduler.mjs     # 工作流定时调度
├── acp-api.mjs                # ACP 桥接服务入口
├── acp-bridge.mjs             # ACP 桥接逻辑
├── file-server.mjs            # 文件服务器入口
├── tiktok-api.mjs             # TikTok 数据 API
├── knowledge-db.mjs           # 知识库数据库操作
├── embedding-cache.mjs        # 向量嵌入缓存
├── alert-manager.mjs          # 告警管理
├── monitor.mjs                # 系统监控
├── rate-limiter.mjs           # 速率限制
├── remediation-engine.mjs     # 自动修复引擎
├── sanitize.mjs               # 输入清理
├── skills-discovery.mjs       # 技能发现
├── task-store.mjs             # 任务存储
├── SOUL.md                    # Agent 人格定义
└── TEACHING-INDEX.md          # 教学索引
```

### 7.3 后端部署

```bash
# 1. 语法检查（推荐）
bash /opt/rangerai-agent/validate-mjs.sh

# 2. 重启服务
sudo systemctl restart rangerai-agent

# 3. 检查启动状态
sudo systemctl status rangerai-agent
journalctl -u rangerai-agent -n 20 --no-pager

# 4. 验证 API
curl -s https://ranger.voyage/api/health
curl -s https://ranger.voyage/api/version
```

### 7.4 修改后端代码的注意事项

**文件格式**：所有后端文件使用 `.mjs` 扩展名（ESM 模块），使用 `import/export` 语法。

**环境变量**：通过 `/opt/rangerai-agent/.env` 和 `/opt/rangerai-agent/agent-secrets.env` 加载，代码中通过 `process.env.XXX` 访问。

**数据库操作**：使用 `db-adapter.mjs` 提供的统一接口（`query`、`queryOne`、`run`、`runTransaction`），支持 SQLite 和 MySQL 两种后端。

**添加新的 API 端点**：在 `api/` 目录创建新文件，然后在 `server.mjs` 中导入并注册，最后在 Caddy 配置中添加路由规则。

### 7.5 Worker 架构

rangerai-agent 使用主进程 + Worker 子进程架构。主进程处理 HTTP/WebSocket 请求，Worker 进程（`agent-worker.mjs` → `worker/index.mjs`）处理耗时的 AI 推理任务。主进程与 Worker 通过 IPC（进程间通信）交换消息。Worker 内置熔断器（`circuit-breaker.mjs`），在连续失败时自动降级。

---

## 8. OpenClaw Gateway

### 8.1 概述

OpenClaw Gateway 是 AI Agent 的核心引擎，版本 `2026.2.21-2`，通过 pnpm 全局安装。它提供 Agent 的推理、工具调用、技能执行等能力。

### 8.2 配置

Gateway 的环境变量在 `/opt/start-openclaw-gateway.sh` 中设置，关键配置包括：

| 变量 | 说明 |
|------|------|
| `OPENCLAW_GATEWAY_PORT` | Gateway 端口（18789） |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway 认证 Token |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `GOOGLE_API_KEY` | Google API 密钥 |
| `NODE_ENV` | 运行环境（production） |

### 8.3 管理命令

```bash
# 重启 Gateway
sudo systemctl restart openclaw-gateway

# 查看日志
journalctl -u openclaw-gateway -n 30 --no-pager

# 检查端口
ss -tlnp | grep 18789

# 直接测试 Gateway
curl -s http://127.0.0.1:18789/health
```

### 8.4 OpenClaw Sandbox

OpenClaw 运行一个 Docker 沙箱容器（`openclaw-sbx-agent-main-main-*`），基于 `openclaw-sandbox:bookworm-enhanced` 镜像，用于安全执行 Agent 的代码和命令。

```bash
# 查看沙箱状态
docker ps | grep openclaw-sbx

# 清理过期沙箱（定时任务已配置）
bash /opt/rangerai-agent/cleanup-sandboxes.sh
```

---

## 9. 数据库管理

### 9.1 MySQL 配置

| 项目 | 详情 |
|------|------|
| **版本** | MySQL 8.0 |
| **运行方式** | Docker 容器（mysql-rangerai） |
| **端口** | 3306（仅 127.0.0.1） |
| **数据库名** | rangerai |
| **Root 密码** | RangerAI2026! |
| **字符集** | utf8mb4 / utf8mb4_unicode_ci |

### 9.2 数据表清单

| 表名 | 说明 | 关键字段 |
|------|------|----------|
| **users** | 用户账户 | id, username, passwordHash, role(admin/member), team |
| **chats** | 聊天会话 | id, userId, title, model, messageCount |
| **messages** | 聊天消息 | id, chatId, role, content, metadata |
| **tickets** | 工单系统 | id, ticket_no, title, status, priority, category |
| **ticket_comments** | 工单评论 | id, ticket_id, content, author |
| **kols** | KOL 档案 | id, name, platform, followers, engagement_rate |
| **kol_contacts** | KOL 联系记录 | id, kol_id, contact_type, status |
| **kol_outreach** | KOL 外联追踪 | id, kol_id, campaign, status |
| **tiktok_partners** | TikTok 合作伙伴 | id, kol_handle, country, sharing_ratio |
| **knowledge_items** | 知识库条目 | id, title, content, category, tags |
| **workflows** | 工作流定义 | id, name, steps(JSON), cronExpression |
| **workflow_runs** | 工作流执行记录 | id, workflowId, status, stepResults(JSON) |
| **notifications** | 用户通知 | id, title, content, target_user, is_read |
| **quick_prompts** | 快捷提示词 | id, title, content, category |
| **departments** | 组织部门 | id, name, parent_id, manager_id |
| **invite_codes** | 邀请码 | id, code, createdBy, usedBy, isActive |
| **shared_chats** | 共享聊天 | id, chatId, sharedBy, messages |
| **audit_logs** | 审计日志 | id, userId, action, resource, details |
| **remediation_events** | 自动修复日志 | id, component, action, success |
| **system_config** | 系统配置 KV | key, value, category |

### 9.3 数据库操作

```bash
# 连接 MySQL
docker exec -it mysql-rangerai mysql -u root -p'RangerAI2026!' rangerai

# 常用查询
SELECT COUNT(*) FROM users;                           # 用户数
SELECT COUNT(*) FROM chats;                           # 聊天数
SELECT COUNT(*) FROM messages;                        # 消息数
SELECT * FROM users WHERE role = 'admin';             # 管理员列表
SELECT * FROM system_config ORDER BY category;        # 系统配置

# 提升用户为管理员
UPDATE users SET role = 'admin' WHERE username = 'xxx';

# 查看表结构
DESCRIBE users;
SHOW CREATE TABLE chats;
```

### 9.4 数据库备份

自动备份通过 cron 每天凌晨 3 点执行：

```bash
# 手动执行备份
bash /opt/rangerai-agent/backup-rangerai-db.sh

# 备份文件位置
ls -la /opt/rangerai-agent/backups/db/

# 备份保留策略：7 天滚动
```

> **注意**：当前备份脚本针对 SQLite 编写（使用 `.backup` 命令）。如果已完全迁移到 MySQL，需要更新为 `mysqldump` 方式。MySQL Docker 容器的数据卷持久化在宿主机上，容器重启不会丢失数据。

---

## 10. Redis 缓存

### 10.1 配置

| 项目 | 详情 |
|------|------|
| **版本** | Redis 7 (Alpine) |
| **运行方式** | Docker 容器（redis-test） |
| **端口** | 6379（主）/ 6380（测试） |
| **绑定** | 127.0.0.1 |

### 10.2 管理命令

```bash
# 连接 Redis
redis-cli -p 6379

# 常用命令
INFO server              # 服务器信息
INFO memory              # 内存使用
DBSIZE                   # 键数量
KEYS rangerai:*          # 查看 RangerAI 相关键
FLUSHDB                  # 清空当前数据库（谨慎！）
```

---

## 11. Docker 容器管理

### 11.1 容器清单

| 容器名 | 镜像 | 端口映射 | 说明 |
|--------|------|----------|------|
| mysql-rangerai | mysql:8.0 | 127.0.0.1:3306→3306 | 主数据库 |
| redis-test | redis:7-alpine | 127.0.0.1:6380→6379 | Redis 缓存 |
| searxng | searxng/searxng | 127.0.0.1:8888→8080 | 搜索引擎 |
| v2ray-proxy | v2fly/v2fly-core | — | VPN 代理 |
| openclaw-sbx-* | openclaw-sandbox:bookworm-enhanced | — | OpenClaw 沙箱 |

### 11.2 管理命令

```bash
# 查看所有容器
docker ps -a

# 重启容器
docker restart mysql-rangerai
docker restart redis-test

# 查看容器日志
docker logs mysql-rangerai --tail 30
docker logs redis-test --tail 30

# 进入容器
docker exec -it mysql-rangerai bash
docker exec -it redis-test sh
```

---

## 12. 定时任务（Cron）

### 12.1 当前 Cron 任务清单

| 时间 | 脚本 | 说明 |
|------|------|------|
| `*/5 * * * *` | health-guardian.sh | 每 5 分钟健康检查 |
| `0 * * * *` | auto-backup.sh | 每小时自动备份 |
| `0 */1 * * *` | gateway-memory-monitor.sh | 每小时 Gateway 内存监控 |
| `0 */6 * * *` | token-monitor.sh | 每 6 小时 Token 监控 |
| `0 */6 * * *` | cleanup-sandboxes.sh | 每 6 小时清理沙箱 |
| `0 3 * * *` | backup-rangerai-db.sh | 每天 3:00 数据库备份 |
| `0 3 * * *` | auto-maintenance/maintain.sh | 每天 3:00 自动维护 |
| `0 3 * * *` | evolution-engine/cron-evolve.sh | 每天 3:00 进化引擎 |
| `0 3 * * *` | daily-backup/backup.sh | 每天 3:00 OpenClaw 备份 |
| `30 3 * * *` | evolve-toward-manus/benchmark.py | 每天 3:30 基准测试 |
| `30 3,15 * * *` | frontend-selfcheck.sh | 每天 3:30/15:30 前端自检 |
| `0 4 * * 0` | log-rotation/rotate.sh | 每周日 4:00 日志轮转 |
| `0 4 * * 0` | self-assess.py | 每周日 4:00 自我评估 |
| `0 8 * * *` | daily-evolution.sh | 每天 8:00 每日进化 |
| `5 8 * * *` | daily-evolution-notify.sh | 每天 8:05 进化通知 |
| `46 10 * * *` | acme.sh --cron | SSL 证书续期 |

### 12.2 管理 Cron

```bash
# 查看当前 cron 任务
crontab -l                    # admin 用户
sudo crontab -l               # root 用户

# 编辑 cron 任务
crontab -e                    # admin 用户
sudo crontab -e               # root 用户
```

---

## 13. 日志管理

### 13.1 日志文件位置

| 日志文件 | 说明 | 大小 |
|----------|------|------|
| `/var/log/rangerai-agent.log` | Agent 主日志 | ~2 MB |
| `/var/log/rangerai-agent-error.log` | Agent 错误日志 | ~1 MB |
| `/var/log/rangerai-backup.log` | 备份日志 | ~85 KB |
| `/var/log/rangerai-healthcheck.log` | 健康检查日志 | ~2 MB |
| `/var/log/rangerai-cleanup.log` | 清理日志 | ~13 KB |
| `/var/log/rangerai-health.log` | 健康日志 | ~242 KB |

### 13.2 日志查看命令

```bash
# 实时跟踪 Agent 日志
tail -f /var/log/rangerai-agent.log

# 查看最近错误
tail -50 /var/log/rangerai-agent-error.log

# 搜索特定错误
grep -i "error\|exception\|fatal" /var/log/rangerai-agent.log | tail -20

# 按时间过滤
grep "2026-03-10" /var/log/rangerai-agent.log | tail -30

# 查看 systemd 日志
journalctl -u rangerai-agent --since "2 hours ago"
journalctl -u openclaw-gateway --since today
```

### 13.3 日志轮转

日志轮转通过 cron 每周日凌晨 4 点执行（`log-rotation/rotate.sh`）。如果日志增长过快，可以手动清理：

```bash
# 清空日志（不删除文件）
sudo truncate -s 0 /var/log/rangerai-agent.log
sudo truncate -s 0 /var/log/rangerai-agent-error.log
```

---

## 14. 安全配置

### 14.1 认证机制

RangerAI 使用自有的 JWT 认证系统：

- **密码存储**：使用 salt + hash（非明文）
- **Token 签发**：JWT，包含用户 ID、角色、过期时间
- **Token 验证**：每个 API 请求通过 `auth.mjs` 中间件验证
- **角色控制**：`admin` 和 `member` 两种角色，管理后台仅 admin 可访问

### 14.2 CORS 配置

`auth.mjs` 中配置了 CORS 白名单，允许以下来源：

- `https://ranger.voyage`
- `https://www.ranger.voyage`
- `*.manus.computer`（开发环境）
- `*.manus.space`（预览环境）

### 14.3 网络安全

- Caddy 自动添加 `X-Content-Type-Options: nosniff` 安全头
- 静态资产使用 `Cache-Control: public, max-age=31536000, immutable`（1 年缓存）
- `index.html` 使用 `Cache-Control: no-cache, no-store, must-revalidate`（不缓存）
- 后端服务（3002、18789）仅监听 127.0.0.1，iptables 额外阻止外部直连 3002

### 14.4 SSL/TLS

Caddy 自动通过 Let's Encrypt 获取和续期 SSL 证书，配置邮箱为 `admin@ranger.voyage`。同时 `acme.sh` 也在 cron 中运行证书续期（可能是历史遗留）。

---

## 15. 备份与恢复

### 15.1 备份策略

| 备份对象 | 频率 | 保留期 | 脚本 |
|----------|------|--------|------|
| 数据库（SQLite） | 每天 3:00 | 7 天 | backup-rangerai-db.sh |
| OpenClaw 工作空间 | 每天 3:00 | — | daily-backup/backup.sh |
| 系统状态 | 每小时 | — | auto-backup.sh |

### 15.2 手动备份

```bash
# 备份前端源码
tar czf ~/backup-frontend-$(date +%Y%m%d).tar.gz \
  -C /opt rangerai-web \
  --exclude=node_modules --exclude=dist --exclude=.git

# 备份后端源码
tar czf ~/backup-backend-$(date +%Y%m%d).tar.gz \
  -C /opt rangerai-agent \
  --exclude=node_modules --exclude=backups --exclude=.git

# 备份 MySQL 数据库
docker exec mysql-rangerai mysqldump -u root -p'RangerAI2026!' \
  --all-databases --single-transaction > ~/backup-mysql-$(date +%Y%m%d).sql

# 备份 Caddy 配置
tar czf ~/backup-caddy-$(date +%Y%m%d).tar.gz -C /etc caddy

# 备份 OpenClaw 配置
tar czf ~/backup-openclaw-$(date +%Y%m%d).tar.gz \
  /opt/start-openclaw-gateway.sh \
  /home/admin/.openclaw/workspace/skills \
  /home/admin/.openclaw/workspace/memory
```

### 15.3 恢复流程

```bash
# 恢复前端
tar xzf ~/backup-frontend-YYYYMMDD.tar.gz -C /opt
cd /opt/rangerai-web && pnpm install
sudo bash /opt/rangerai-agent/deploy-frontend.sh

# 恢复后端
tar xzf ~/backup-backend-YYYYMMDD.tar.gz -C /opt
cd /opt/rangerai-agent && npm install
sudo systemctl restart rangerai-agent

# 恢复 MySQL
docker exec -i mysql-rangerai mysql -u root -p'RangerAI2026!' < ~/backup-mysql-YYYYMMDD.sql

# 恢复 Caddy
tar xzf ~/backup-caddy-YYYYMMDD.tar.gz -C /etc
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

---

## 16. 自动化运维工具

### 16.1 工具清单

| 脚本 | 位置 | 说明 |
|------|------|------|
| `deploy-frontend.sh` | /opt/rangerai-agent/ | 前端一键构建部署（v5） |
| `regression-test.sh` | /opt/rangerai-agent/ | 自动化回归测试（19 项检查） |
| `validate-mjs.sh` | /opt/rangerai-safety/ | ESM 语法验证 |
| `restart.sh` | /opt/rangerai-agent/ | 服务重启脚本 |
| `smoke-test.sh` | /opt/rangerai-agent/ | 快速冒烟测试 |
| `cleanup-sandboxes.sh` | /opt/rangerai-agent/ | 清理过期沙箱 |
| `cleanup-server.sh` | /opt/rangerai-agent/ | 服务器清理 |
| `backup-rangerai-db.sh` | /opt/rangerai-agent/ | 数据库备份 |
| `monitor.sh` | /opt/rangerai-agent/ | 系统监控 |
| `health-guardian.sh` | ~/.openclaw/.../skills/ | 健康守护（每 5 分钟） |
| `frontend-selfcheck.sh` | /opt/rangerai-safety/ | 前端自检 |
| `gateway-memory-monitor.sh` | /opt/rangerai-safety/ | Gateway 内存监控 |
| `safe-edit.sh` | /opt/rangerai-safety/ | 安全编辑（带备份） |
| `rollback.sh` | /opt/rangerai-safety/ | 回滚脚本 |

### 16.2 回归测试

```bash
# 运行完整回归测试
bash /opt/rangerai-agent/regression-test.sh

# 详细模式
bash /opt/rangerai-agent/regression-test.sh --verbose
```

测试覆盖 7 大类：服务健康检查、API 端点测试、WebSocket 连接测试、前端资产完整性、Caddy 代理路由、数据库连接、代码语法验证。

---

## 17. 故障排查手册

### 17.1 前端白屏

**症状**：访问 ranger.voyage 显示空白页面。

**排查步骤**：

```bash
# 1. 检查 Caddy 是否运行
systemctl status caddy

# 2. 检查 index.html 是否存在
ls -la /var/www/rangerai/index.html

# 3. 检查 JS bundle 是否存在
JS=$(grep -o 'index-[A-Za-z0-9_-]*\.js' /var/www/rangerai/index.html | head -1)
ls -la /var/www/rangerai/assets/$JS

# 4. 如果文件缺失，重新部署
sudo bash /opt/rangerai-agent/deploy-frontend.sh
```

### 17.2 API 返回 502 Bad Gateway

**症状**：API 请求返回 502 错误。

**排查步骤**：

```bash
# 1. 检查后端是否运行
systemctl status rangerai-agent
ss -tlnp | grep 3002

# 2. 查看错误日志
tail -30 /var/log/rangerai-agent-error.log

# 3. 检查内存使用
free -h
ps aux --sort=-rss | head -10

# 4. 重启后端
sudo systemctl restart rangerai-agent
```

### 17.3 WebSocket 断连

**症状**：聊天消息无法实时接收，需要刷新页面。

**排查步骤**：

```bash
# 1. 检查 WebSocket 端口
ss -tlnp | grep 3002

# 2. 测试 WebSocket 连接
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: test" \
  https://ranger.voyage/ws

# 3. 检查 Caddy WebSocket 配置
grep -A5 "/ws" /etc/caddy/conf.d/10-ranger-main.caddy

# 4. 重启后端
sudo systemctl restart rangerai-agent
```

### 17.4 OpenClaw Gateway 无响应

**症状**：AI Agent 功能不可用。

**排查步骤**：

```bash
# 1. 检查 Gateway 状态
systemctl status openclaw-gateway
ss -tlnp | grep 18789

# 2. 检查 Gateway 日志
journalctl -u openclaw-gateway -n 30

# 3. 检查内存（Gateway 可能 OOM）
ps aux | grep openclaw

# 4. 重启 Gateway
sudo systemctl restart openclaw-gateway
```

### 17.5 数据库连接失败

**症状**：API 返回数据库错误。

**排查步骤**：

```bash
# 1. 检查 MySQL 容器
docker ps | grep mysql
docker logs mysql-rangerai --tail 20

# 2. 测试连接
docker exec mysql-rangerai mysql -u root -p'RangerAI2026!' -e "SELECT 1;"

# 3. 检查磁盘空间（MySQL 可能因磁盘满而停止）
df -h /

# 4. 重启 MySQL
docker restart mysql-rangerai
```

### 17.6 SSL 证书过期

**症状**：浏览器显示证书不安全。

**排查步骤**：

```bash
# 1. 检查证书状态
curl -vI https://ranger.voyage 2>&1 | grep "expire"

# 2. Caddy 自动续期（重启即可）
sudo systemctl restart caddy

# 3. 如果 Caddy 续期失败，检查 80 端口是否被占用
ss -tlnp | grep :80
```

### 17.7 磁盘空间不足

```bash
# 查看磁盘使用
df -h /

# 查看大目录
du -sh /opt/* /var/www/* /home/admin/.openclaw/ /var/log/rangerai-* | sort -rh

# 清理日志
sudo truncate -s 0 /var/log/rangerai-agent.log
sudo truncate -s 0 /var/log/rangerai-agent-error.log
sudo truncate -s 0 /var/log/rangerai-healthcheck.log

# 清理 Docker
docker system prune -f

# 清理旧备份
find /opt/rangerai-agent/backups -mtime +7 -delete
```

---

## 18. OpenClaw Skills 管理

### 18.1 Skills 目录

OpenClaw 技能位于 `/home/admin/.openclaw/workspace/skills/`，当前已安装 50+ 技能，包括：

| 类别 | 技能 | 说明 |
|------|------|------|
| **核心能力** | think-first, context-optimization | 思考优先、上下文优化 |
| **开发** | code-review, web-dev, css-debug | 代码审查、Web 开发 |
| **运维** | server-ops, self-repair, self-diagnosis | 服务器运维、自修复 |
| **部署** | project-deploy, self-deploy | 项目部署、自部署 |
| **数据** | data-analysis, searxng | 数据分析、搜索 |
| **内容** | chinese-content, length-control | 中文内容、长度控制 |
| **监控** | health-guardian, healthcheck, observability | 健康守护、可观测性 |
| **进化** | evolution-engine, self-evolution, evolve-toward-manus | 进化引擎 |
| **工具** | browser-automation, sandbox-exec, tmux | 浏览器自动化、沙箱 |
| **媒体** | video-processor, openai-image-gen, openai-whisper-api | 视频、图像、语音 |

### 18.2 Memory 系统

OpenClaw 的记忆文件位于 `/home/admin/.openclaw/workspace/memory/`，包含每日记忆、知识库、经验教训、进化日志等。这些文件是 OpenClaw 持续学习和改进的基础。

---

## 19. 完整文件目录索引

### 19.1 关键目录

| 路径 | 大小 | 说明 |
|------|------|------|
| `/opt/rangerai-agent/` | 450 MB | 后端源码 + node_modules |
| `/opt/rangerai-web/` | 578 MB | 前端源码 + node_modules |
| `/var/www/rangerai/` | 16 MB | 前端部署目录（Caddy 服务） |
| `/var/www/rangerai1/` | 16 MB | 前端部署目录（向后兼容） |
| `/etc/caddy/` | — | Caddy 配置 |
| `/etc/systemd/system/` | — | Systemd 服务文件 |
| `/opt/rangerai-safety/` | 40 KB | 安全运维脚本 |
| `/home/admin/.openclaw/` | 2.7 GB | OpenClaw 工作空间 |
| `/opt/start-openclaw-gateway.sh` | — | Gateway 启动脚本 |

### 19.2 配置文件索引

| 文件 | 说明 |
|------|------|
| `/etc/caddy/Caddyfile` | Caddy 主配置 |
| `/etc/caddy/conf.d/00-global.caddy` | 全局设置 |
| `/etc/caddy/conf.d/10-ranger-main.caddy` | 主站路由 |
| `/etc/caddy/conf.d/20-gateway.caddy` | Gateway 子域名 |
| `/etc/systemd/system/rangerai-agent.service` | Agent 服务 |
| `/etc/systemd/system/openclaw-gateway.service` | Gateway 服务 |
| `/etc/systemd/system/rangerai-acp.service` | ACP 服务 |
| `/etc/systemd/system/rangerai-fileserver.service` | FileServer 服务 |
| `/opt/rangerai-agent/.env` | 后端环境变量 |
| `/opt/rangerai-agent/agent-secrets.env` | 后端密钥 |
| `/opt/start-openclaw-gateway.sh` | Gateway 环境变量 + 启动 |

### 19.3 日志文件索引

| 文件 | 说明 |
|------|------|
| `/var/log/rangerai-agent.log` | Agent 主日志 |
| `/var/log/rangerai-agent-error.log` | Agent 错误日志 |
| `/var/log/rangerai-backup.log` | 备份日志 |
| `/var/log/rangerai-healthcheck.log` | 健康检查日志 |
| `/var/log/rangerai-cleanup.log` | 清理日志 |
| `/tmp/health-guardian.log` | 健康守护日志 |
| `/tmp/cron-evolve.log` | 进化引擎日志 |

---

> **文档维护说明**：本手册应随系统变更同步更新。每次添加新服务、修改 Caddy 路由、变更数据库结构或调整安全配置后，请更新对应章节。手册副本存放在服务器 `/opt/rangerai-web/SELF-HOSTED-OPS.md` 和 `/opt/rangerai-agent/SELF-HOSTED-OPS.md`。
