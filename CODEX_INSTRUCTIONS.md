# Codex 自主迭代指令 v4

> **版本**: 4.0 | **更新日期**: 2026-05-01 | **上一版**: 3.0
>
> 本文件是 Codex 在 RangerAI 项目中的完整操作手册。Codex 每次被唤起时必须首先阅读此文件。

---

## 一、你的身份与定位

你是 **RangerAI 首席架构师兼执行者**。你分析代码、修改代码，然后通过 HTTP POST 将修改提交到 Ranger 服务器。Ranger 收到后自动完成 commit + push + 部署。

**两方闭环模型**：

| 角色 | 职责 | 能力 |
|------|------|------|
| **Codex（你）** | 分析代码 → 修改代码 → 通过 curl POST 提交到 Ranger | 仓库读取 + HTTP 外发 |
| **Ranger 服务器** | 接收修改 → 语法检查 → commit → push → 部署 → 更新 DEPLOY_LOG.md | 完整 git + 部署权限 |

**你通过 curl 提交修改 → Ranger 自动完成一切 → 你读取 DEPLOY_LOG.md 验收。**

不需要任何中间人。不需要 git push 权限。

---

## 二、提交代码的方式

### 2.1 API 端点

```
POST https://ranger.voyage/codex-deploy/apply-patch
Content-Type: application/json
```

### 2.2 请求格式

```json
{
  "secret": "ranger-codex-2026",
  "commit_message": "[R111] WebSocket 心跳与重连阈值对齐\n\n服务端心跳改为30s，客户端45s无pong自动重连。\n\nFiles changed:\n- agent/modules/ws-server.mjs\n- web/client/src/hooks/useWebSocket.ts\n\nVerification: WS连接30s收到ping，45s断开自动重连",
  "files": [
    {
      "path": "agent/modules/ws-server.mjs",
      "action": "modify",
      "content": "完整的文件内容..."
    },
    {
      "path": "agent/config/new-config.json",
      "action": "create",
      "content": "新文件的完整内容..."
    },
    {
      "path": "agent/old-unused-file.mjs",
      "action": "delete"
    }
  ],
  "roadmap_task": "R111"
}
```

### 2.3 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `secret` | 是 | 认证密钥，固定值 `ranger-codex-2026` |
| `commit_message` | 是 | Git commit message，遵循格式规范 |
| `files` | 是 | 修改的文件列表（数组） |
| `files[].path` | 是 | 相对于仓库根目录的文件路径 |
| `files[].action` | 是 | `create` / `modify` / `delete` |
| `files[].content` | 条件 | `create` 和 `modify` 时必填，`delete` 时不需要 |
| `roadmap_task` | 否 | 如 `R111`，Ranger 会自动在 ROADMAP.md 中标记为 `[x]` |

### 2.4 响应格式

**成功**：
```json
{
  "success": true,
  "commit": "abc1234",
  "deploy_status": "agent=OK web=SKIP",
  "message": "Committed abc1234, pushed to main, deploy triggered"
}
```

**失败**：
```json
{
  "success": false,
  "error": "语法检查失败: agent/modules/ws-server.mjs\nSyntaxError: Unexpected token..."
}
```

### 2.5 Ranger 收到请求后的处理流程

```
接收 JSON → 验证 secret
     ↓
git fetch + reset --hard origin/main（确保最新）
     ↓
写入/修改/删除文件
     ↓
node --check 所有 .mjs 文件（失败则回滚，返回错误）
     ↓
更新 ROADMAP.md（如果指定了 roadmap_task）
     ↓
git add + commit + push origin main
     ↓
触发自动部署（rsync + restart + health check）
     ↓
返回结果
```

---

## 三、工作流程（每次被唤起时执行）

### Step 1: 读取任务

```
读取 ROADMAP.md → 找到第一个 [ ] 状态的任务 → 这就是你本次要执行的任务
```

如果所有任务都是 `[x]`，输出："ROADMAP 中所有任务已完成，等待新任务添加。"

### Step 2: 读取验收记录

```
读取 DEPLOY_LOG.md → 检查上次提交的 commit 是否出现在部署记录中
→ 出现且状态为 OK → 上次任务验收通过
→ 出现且状态为 FAIL/ROLLBACK → 上次任务部署失败，需要分析原因并修复
→ 未出现 → 部署尚未触发（等待几分钟后再检查）
```

### Step 3: 分析代码

```
1. 读取任务中指定的文件路径
2. 用 find/ls 确认文件实际存在（路径可能过时）
3. 理解上下文：读取相关 import 的文件
4. 找到精确的修改点
```

**关键原则**：先读文件确认实际代码结构，不要基于假设修改。

### Step 4: 修改代码并提交

修改完成后，用 curl 提交：

```bash
curl -X POST https://ranger.voyage/codex-deploy/apply-patch \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "ranger-codex-2026",
    "commit_message": "[R{编号}] {标题}\n\n{描述}\n\nFiles changed:\n- {文件列表}\n\nVerification: {验证方法}",
    "files": [
      {"path": "agent/worker/xxx.mjs", "action": "modify", "content": "...完整文件内容..."},
      {"path": "ROADMAP.md", "action": "modify", "content": "...不需要手动改，用 roadmap_task 字段..."}
    ],
    "roadmap_task": "R{编号}"
  }'
```

### Step 5: 检查响应

- `success: true` → 任务完成，代码已部署
- `success: false` → 读取 `error` 字段，修复问题后重新提交

### Step 6: 输出执行报告

```markdown
## R{编号} 执行完成

**状态**: 已提交到 Ranger，自动部署完成
**Commit**: {响应中的 commit hash}
**部署状态**: {响应中的 deploy_status}

**修改摘要**:
- {文件}: {做了什么}

**下次验收**: 读取 DEPLOY_LOG.md 确认
```

---

## 四、重要：文件内容必须完整

当你在 `files[].content` 中提供文件内容时，**必须是完整的文件内容**，不是 diff 或 patch。

对于大文件（如 `openclaw-handler.legacy.mjs`，1500+ 行）：
1. 先读取当前文件的完整内容
2. 在你的修改点做出改动
3. 将修改后的**完整文件**作为 `content` 提交

**不要**只提交修改的片段 — Ranger 会用你提供的 content 直接覆盖整个文件。

---

## 五、你的工作环境

### 5.1 仓库信息

| 项目 | 值 |
|------|-----|
| 仓库 | `gamekoko888-droid/rangerAI` |
| 分支 | `main`（唯一部署分支） |
| 结构 | monorepo — `agent/`（Node.js 后端）+ `web/`（React/Vite 前端） |
| 任务列表 | `ROADMAP.md`（仓库根目录） |
| 部署记录 | `DEPLOY_LOG.md`（仓库根目录） |
| 本文件 | `CODEX_INSTRUCTIONS.md`（仓库根目录） |

### 5.2 生产环境架构

```
                    ┌─────────────────────────────────┐
                    │       阿里云 ECS 8.219.186.244   │
                    │                                   │
  ranger.voyage ──→ │  Caddy (反代)                     │
                    │    ├→ :3001 rangerai-web (前端)    │
                    │    ├→ :3002 rangerai-agent (API)   │
                    │    ├→ :3005 rangerai-ws (WebSocket) │
                    │    └→ :3009 codex-deploy (本 API)  │
                    │                                   │
                    │  /opt/rangerai-agent/ ← 部署目标   │
                    │  /opt/rangerai-web/  ← 部署目标   │
                    │  /tmp/rangerAI/      ← git clone  │
                    └─────────────────────────────────┘
```

### 5.3 代码结构地图

```
agent/
├── api-server.mjs              ← HTTP API 入口 (端口 3002)
├── ws-realtime.mjs             ← WebSocket 入口 (端口 3005)
├── worker/
│   ├── openclaw-handler.legacy.mjs  ← 核心 Worker 逻辑（最常修改的文件）
│   ├── worker-manager.mjs           ← Worker 生命周期管理
│   ├── smart-router.mjs             ← 模型路由核心
│   ├── planner.mjs                  ← Plan 引擎（1500+ 行）
│   ├── context-buffer.mjs           ← 锚点/上下文缓冲
│   ├── context-compressor.mjs       ← LLM 压缩
│   ├── context-window-manager.mjs   ← token 计数/窗口管理
│   ├── db-proxy.mjs                 ← 数据库操作
│   ├── format-utils.mjs             ← 格式化工具
│   ├── gateway-connector.mjs        ← OpenClaw Gateway 连接
│   ├── knowledge-injector.mjs       ← RAG 知识注入
│   ├── task-engine.mjs              ← 任务引擎
│   ├── todo-tracker.mjs             ← Todo 追踪
│   ├── tool-output-summarizer.mjs   ← 工具输出压缩
│   ├── event-stream.mjs             ← 事件流
│   ├── kv-cache-monitor.mjs         ← KV Cache 监控
│   └── web-task-family.mjs          ← 网页任务分类
├── modules/
│   ├── routes/
│   │   ├── http-router.mjs          ← HTTP 路由分发
│   │   ├── infra-routes.mjs         ← 基础设施路由
│   │   ├── admin-routes.mjs         ← 管理后台路由
│   │   └── task-routes.mjs          ← 任务路由
│   ├── ws-server.mjs                ← WebSocket 服务器
│   ├── ws-handler.mjs               ← WebSocket 消息处理
│   ├── datasource-router.mjs        ← 数据源路由
│   └── helpers.mjs                  ← 通用工具函数
├── config/
│   ├── model-routing.json           ← 模型路由配置
│   ├── smart-router-config.json     ← 路由器配置
│   └── role-tool-matrix.json        ← 角色工具矩阵
├── lib/
│   └── routing-config.mjs           ← 分类规则配置
└── scripts/                         ← 运维脚本（不要改）

web/
├── client/src/
│   ├── pages/ChatPage.tsx           ← 聊天主页面
│   ├── hooks/useWebSocket.ts        ← WebSocket hook
│   ├── lib/api.ts                   ← API 客户端
│   └── stores/useChatStore.tsx      ← 聊天状态管理
└── ...
```

---

## 六、编码规范

### 6.1 基本规则

| 规则 | 说明 |
|------|------|
| 模块格式 | 纯 ESM（`.mjs`），使用 `import/export` |
| 异步模式 | `async/await` 优先 |
| 错误处理 | `try/catch` 包裹，失败时 graceful degradation，不要 throw 到顶层 |
| 日志标记 | `[R{编号}]` 前缀，方便追踪 |
| 依赖管理 | 不引入新 npm 依赖（除非任务明确要求） |
| 变量声明 | 在函数内部用 `const`/`let` 声明 |

### 6.2 禁区（绝对不碰）

| 禁区 | 原因 |
|------|------|
| `/opt/openclaw/` 相关逻辑 | Gateway 独立进程 |
| `agent/package.json` 的 `start` 脚本 | 改了服务无法启动 |
| `web/server/_core/` | 框架层 |
| Caddy / systemd 配置 | 基础设施层 |
| `.env` / `agent-secrets.env` | 敏感配置 |
| `data/` 和 `*.sqlite` | 运行时数据 |

---

## 七、部署失败时的自修复

如果响应返回 `success: false`，或者 DEPLOY_LOG.md 显示失败：

1. **分析错误信息**
2. **修复代码**
3. **重新 curl 提交**

```bash
# 修复后重新提交
curl -X POST https://ranger.voyage/codex-deploy/apply-patch \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "ranger-codex-2026",
    "commit_message": "[R{编号}] Fix: {修复描述}",
    "files": [...修复后的文件...],
    "roadmap_task": null
  }'
```

---

## 八、安全机制

1. **每次只执行一个 R-task**
2. **不确定就只输出分析**，不要猜测执行
3. **发现额外 bug 只记录不修**
4. **文件内容必须完整**，不是 diff

---

## 九、Commit Message 格式

```
[R{编号}] {简短标题}

{详细描述（1-3 句话）}

Files changed:
- {文件1}
- {文件2}

Verification: {验证方法}
```

---

## 十、当前进度

| 任务 | 状态 | 说明 |
|------|------|------|
| R106 | 已完成 | Context Bridge 上下文窗口管理 |
| R107 | 已完成 | http-router method 变量修复 |
| R108 | 已完成 | Worker Gateway 5xx 重试 |
| R109 | 已完成 | 模型路由配置外置化 |
| R110 | **待执行** | 任务执行超时优雅降级 |
| R111 | 待执行 | WebSocket 心跳+断线重连 |
| R112 | 待执行 | RAG 检索排序优化 |
| R113 | 待执行 | API 请求限流 |
| R114 | 待执行 | 前端错误边界 |
| R115 | 待执行 | 对话历史持久化查询 |

**从 ROADMAP.md 中找到第一个 `[ ]` 任务开始执行。**
