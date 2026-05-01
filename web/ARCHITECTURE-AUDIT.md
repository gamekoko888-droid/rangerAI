# RangerAI 全栈架构审计报告 — Manus 依赖清理方案

## 审计结论

**好消息**：前端核心功能（ChatPage、LoginPage、WebSocket、API 客户端）已经是独立的，不依赖 Manus。

**需要清理的 Manus 残留**：主要是 Manus 模板的框架层代码（tRPC、OAuth、_core），这些代码在阿里云部署中**完全不使用**。

## Manus 依赖清单

### 前端（需要清理）

| 文件 | 依赖类型 | 是否在用 | 处理方案 |
|------|----------|----------|----------|
| `client/src/_core/hooks/useAuth.ts` | tRPC auth.me.useQuery | 未使用（App.tsx 不引用） | 删除 |
| `client/src/lib/trpc.ts` | tRPC 客户端 | 未使用 | 删除 |
| `client/src/components/ManusDialog.tsx` | Manus 登录对话框 | 未使用 | 删除 |
| `client/src/components/DashboardLayout.tsx` | 引用 useAuth + getLoginUrl | 未使用（App.tsx 不引用） | 删除 |
| `client/src/components/DashboardLayoutSkeleton.tsx` | DashboardLayout 配套 | 未使用 | 删除 |
| `client/src/pages/Home.tsx` | 引用 useAuth + getLoginUrl | 未使用（App.tsx 不引用） | 删除 |
| `client/src/pages/ComponentShowcase.tsx` | 示例页面 | 未使用 | 删除 |
| `client/src/const.ts` | getLoginUrl (Manus OAuth) | 未使用 | 删除 |
| `client/src/components/AIChatBox.tsx` | 模板预置聊天组件 | 未使用 | 删除 |
| `client/src/components/Map.tsx` | Google Maps 集成 | 未使用 | 删除 |

### 后端（server/ 目录全部是 Manus 框架层）

| 目录/文件 | 依赖类型 | 是否在用 | 处理方案 |
|-----------|----------|----------|----------|
| `server/_core/` | Manus OAuth、tRPC、LLM、通知等 | 阿里云不使用 | 保留但不部署 |
| `server/routers.ts` | tRPC 路由 | 阿里云不使用 | 保留但不部署 |
| `server/db.ts` | Drizzle ORM | 阿里云不使用（用 SQLite） | 保留但不部署 |
| `server/storage.ts` | Manus S3 存储 | 阿里云不使用 | 保留但不部署 |

### NPM 依赖（可移除）

| 包名 | 用途 | 处理方案 |
|------|------|----------|
| `@trpc/client` | tRPC 客户端 | 移除 |
| `@trpc/react-query` | tRPC React 绑定 | 移除 |
| `@trpc/server` | tRPC 服务端 | 移除 |
| `@tanstack/react-query` | React Query（tRPC 依赖） | 移除 |
| `vite-plugin-manus-runtime` | Manus 运行时插件 | 移除 |

## 当前独立架构（已在阿里云运行）

```
ranger.voyage (Caddy)
├── /ws              → server.mjs:3002 (WebSocket 实时通信)
├── /api/chats*      → server.mjs:3002 (对话 CRUD)
├── /api/auth*       → server.mjs:3002 (JWT 认证)
├── /api/workspace*  → server.mjs:3002 (文件管理)
├── /upload          → file-server.mjs:3001 (文件上传)
├── /files/*         → file-server.mjs:3001 (文件服务)
├── /workspace/*     → file-server.mjs:3001 (工作区文件)
├── gw.ranger.voyage → openclaw-gateway:18789 (AI 引擎)
└── /*               → /var/www/rangerai/public (前端静态文件)
```

## 清理方案

### 方案：前端代码清理（最小改动）

1. 删除未使用的 Manus 模板文件（10个文件）
2. 从 package.json 移除 5 个 Manus/tRPC 依赖
3. 清理 vite.config.ts 中的 manus-runtime 插件
4. 重新构建并部署

**不需要改动的**：
- `server/` 目录保留（Manus webdev 运行需要）
- `drizzle/` 目录保留（Manus webdev 运行需要）
- 阿里云后端代码（已经完全独立）

**关键认知**：Manus webdev 项目是**开发环境**，阿里云是**生产环境**。
开发环境保留 Manus 框架层不影响生产环境的独立性。
生产环境只部署 `client/dist/` 构建产物，构建产物不包含 server/ 和 _core/ 代码。
