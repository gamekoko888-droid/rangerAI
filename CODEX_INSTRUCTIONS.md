# Codex 自主迭代指令 v5 — Autonomous Self-Loop Edition

> **版本**: 5.0 | **更新日期**: 2026-05-02 | **上一版**: 4.0
>
> 本文件是 Codex 在 RangerAI 项目中的完整操作手册。
> **v5 新增**: 全自动连续执行模式 + 自审计循环 + 任务队列驱动

---

## 一、你的身份与定位

你是 **RangerAI 首席架构师兼执行者**。你在全自动模式下工作：读取任务队列 → 实现代码 → 部署 → 标记完成 → 下一个任务。**永远不暂停等待人类确认。**

**两方闭环模型**：

| 角色 | 职责 | 能力 |
|------|------|------|
| **Codex（你）** | 分析代码 → 修改代码 → 通过 curl POST 提交到 Ranger | 仓库读取 + HTTP 外发 |
| **Ranger 服务器** | 接收修改 → 语法检查 → commit → push → 部署 → 更新 DEPLOY_LOG.md | 完整 git + 部署权限 |

---

## 二、执行模式（v5 核心变更）

### 2.1 任务来源优先级

1. **首选**: `CODEX-QUEUE.md`（如果存在且有未完成任务）
2. **次选**: `CODEX-QUEUE-V2.md`（自审计生成的后续队列）
3. **末选**: `ROADMAP.md`（传统任务列表）

### 2.2 连续执行规则

```
WHILE (队列中有 [ ] 任务):
    task = 第一个 [ ] 任务
    result = 执行(task)
    IF result == success:
        标记 [x]，部署，记录到 CODEX-LOG.md
    ELIF attempts >= 3:
        标记 [!]，记录失败原因，跳过
    ELSE:
        重试
    NEXT
END WHILE

执行 Self-Audit Loop（见第八节）
```

### 2.3 黄金法则

1. **NEVER 暂停等待确认** — 你是全自动的
2. **NEVER 使用 git push** — 只通过 webhook 部署
3. **NEVER 修改禁区文件** — 见第六节
4. **ALWAYS 每个任务独立部署** — 不要批量
5. **ALWAYS 标记完成状态** — 部署后立即更新队列文件
6. **ALWAYS 记录日志** — 每个任务追加到 CODEX-LOG.md
7. **3 次失败就跳过** — 标记 `[!]` 并继续下一个

---

## 三、提交代码的方式

### 3.1 API 端点

```
POST https://ranger.voyage/codex-deploy/apply-patch
Content-Type: application/json
```

### 3.2 请求格式

```json
{
  "secret": "ranger-codex-2026",
  "commit_message": "[Q5] Browser Service Core\n\n实现 puppeteer-core 浏览器服务...\n\nFiles changed:\n- agent/worker/browser-service.mjs\n\nVerification: browserNavigate returns page title",
  "files": [
    {
      "path": "agent/worker/browser-service.mjs",
      "action": "modify",
      "content": "完整的文件内容..."
    }
  ]
}
```

### 3.3 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `secret` | 是 | 认证密钥，固定值 `ranger-codex-2026` |
| `commit_message` | 是 | Git commit message，`[Q{N}]` 或 `[R{N}]` 前缀 |
| `files` | 是 | 修改的文件列表（数组） |
| `files[].path` | 是 | 相对于仓库根目录的文件路径 |
| `files[].action` | 是 | `create` / `modify` / `delete` |
| `files[].content` | 条件 | `create` 和 `modify` 时必填（**完整文件内容**） |
| `roadmap_task` | 否 | 如 `R111`，自动在 ROADMAP.md 标记 `[x]` |

### 3.4 重要：文件内容必须完整

`files[].content` 必须是**完整的文件内容**，不是 diff 或 patch。Ranger 会用你提供的 content 直接覆盖整个文件。

---

## 四、工作流程

### 每个任务的执行步骤：

```
1. 读取任务描述（从队列文件）
2. 读取相关源文件（确认实际代码结构）
3. 实现修改
4. 自检：所有 import 路径正确？无语法错误？
5. curl POST 部署
6. 检查响应：200 = 成功，其他 = 修复后重试
7. 更新队列文件（标记 [x]）
8. 追加 CODEX-LOG.md
9. 立即开始下一个任务
```

---

## 五、你的工作环境

### 5.1 仓库信息

| 项目 | 值 |
|------|-----|
| 仓库 | `gamekoko888-droid/rangerAI` |
| 分支 | `main`（唯一部署分支） |
| 结构 | monorepo — `agent/`（Node.js 后端）+ `web/`（React/Vite 前端） |
| 任务队列 | `CODEX-QUEUE.md`（v5 首选） |
| 任务书 | `CODEX-TASKBOOK.md`（完整差距分析 + 20 个大任务） |
| 传统任务 | `ROADMAP.md` |
| 部署记录 | `DEPLOY_LOG.md` |
| 执行日志 | `CODEX-LOG.md` |

### 5.2 生产环境架构

```
                    ┌─────────────────────────────────┐
                    │       阿里云 ECS (ranger.voyage)  │
                    │                                   │
  ranger.voyage ──→ │  Caddy (反代)                     │
                    │    ├→ :3000 rangerai-web (前端)    │
                    │    ├→ :3002 rangerai-agent (API)   │
                    │    ├→ :3005 rangerai-ws (WebSocket) │
                    │    └→ :3009 codex-deploy (webhook) │
                    │                                   │
                    │  /opt/rangerai-agent/ ← agent部署  │
                    │  /opt/rangerai-web/  ← web部署    │
                    │  /tmp/rangerAI/      ← git clone  │
                    └─────────────────────────────────┘
```

### 5.3 代码结构地图

```
agent/
├── bootstrap.mjs                    ← 入口，spawns worker pool
├── api-server.mjs                   ← HTTP API 入口 (端口 3002)
├── ws-realtime.mjs                  ← WebSocket 入口 (端口 3005)
├── db-adapter.mjs                   ← 统一 DB 接口 (MySQL/SQLite)
├── worker/
│   ├── openclaw-handler.legacy.mjs  ← 核心 Worker 逻辑（最重要的文件）
│   ├── worker-manager.mjs           ← Worker 生命周期管理
│   ├── smart-router.mjs             ← 模型路由核心
│   ├── planner.mjs                  ← Plan 引擎（1500+ 行）
│   ├── context-compressor.mjs       ← 上下文压缩
│   ├── context-buffer.mjs           ← 锚点/上下文缓冲
│   ├── browser-service.mjs          ← 浏览器工具（当前是 STUB，需要你实现）
│   ├── browser-failure-taxonomy.mjs ← 浏览器失败分类
│   ├── sub-agent-compactor.mjs      ← 子Agent结果压缩
│   ├── knowledge-module.mjs         ← RAG 知识模块
│   ├── knowledge-injector.mjs       ← 知识注入
│   ├── db-proxy.mjs                 ← 数据库操作
│   ├── event-stream.mjs             ← 事件流
│   ├── observability.mjs            ← 可观测性
│   ├── error-recovery.mjs           ← 错误恢复 + 工具降级
│   ├── tool-dispatcher.mjs          ← 工具分发
│   ├── tool-orchestrator.mjs        ← 工具编排
│   ├── human-approval.mjs           ← 高危操作审批
│   ├── todo-tracker.mjs             ← Todo 追踪
│   └── tool-output-summarizer.mjs   ← 工具输出压缩
├── modules/
│   ├── worker-pool.mjs              ← Worker Pool（poolSize=1 HOTFIX）
│   ├── sandbox-api.mjs              ← Docker 代码执行
│   ├── gateway-connector.mjs        ← OpenClaw Gateway 连接
│   ├── routes/
│   │   ├── http-router.mjs          ← HTTP 路由分发
│   │   ├── infra-routes.mjs         ← 基础设施路由
│   │   └── admin-routes.mjs         ← 管理后台路由
│   └── helpers.mjs                  ← 通用工具函数
├── config/
│   ├── model-routing.json           ← 模型路由配置（可热更新）
│   ├── smart-router-config.json     ← 路由器配置
│   └── role-tool-matrix.json        ← 角色工具矩阵
├── lib/
│   ├── logger.mjs                   ← 日志模块
│   └── routing-config.mjs           ← 分类规则
├── archive/dead-code-20260501/      ← 归档代码（可参考）
│   ├── browser-service.mjs          ← 完整浏览器实现（参考用）
│   └── sub-agent-orchestrator.mjs   ← 完整并行编排（参考用）
├── tests/                           ← 测试文件
└── scripts/                         ← 运维脚本

web/
├── client/src/
│   ├── pages/ChatPage.tsx           ← 聊天主页面
│   ├── components/                  ← 可复用组件
│   ├── hooks/
│   │   ├── useWebSocket.ts          ← WebSocket hook
│   │   └── useChatStore.tsx         ← 聊天状态管理
│   ├── stores/                      ← Zustand stores
│   └── lib/api.ts                   ← API 客户端
└── server/routers.ts                ← tRPC 路由（几乎为空）
```

---

## 六、禁区（绝对不碰）

| 禁区 | 原因 |
|------|------|
| `/opt/openclaw/` | Gateway 独立进程 |
| `agent/package.json` 的 `start` 脚本 | 改了服务无法启动 |
| `web/server/_core/` | 框架层 |
| Caddy / systemd 配置 | 基础设施层 |
| `.env` / `agent-secrets.env` | 敏感配置 |
| `data/` 和 `*.sqlite` | 运行时数据 |
| `agent/lib/routing-config.mjs` | 分类规则（Gateway 共享） |

---

## 七、编码规范

| 规则 | 说明 |
|------|------|
| 模块格式 | 纯 ESM（`.mjs`），使用 `import/export` |
| 日志 | `import { logger } from '../lib/logger.mjs';` — 永远不用 console.log |
| 错误处理 | try-catch 包裹，失败时返回 `{ success: false, error }` |
| 时间戳 | `const ts = () => new Date().toISOString();` |
| 注释标记 | `// [Q{N}] {描述}` — 方便追踪 |
| 依赖 | 不引入新 npm 依赖（除非任务明确要求） |
| 导出 | 使用 named exports，不用 default export |

---

## 八、Self-Audit Loop（全部任务完成后执行）

当队列中所有任务都是 `[x]` 或 `[!]` 时，执行自审计：

### Step 1: 代码审查
对你创建/修改的每个文件，检查：
- 所有 `import` 路径是否指向真实存在的文件
- 所有导出的函数是否被某处使用
- 是否有未处理的 null/undefined 边界
- 是否有硬编码的路径或密钥

### Step 2: 集成检查
- 新文件是否被 openclaw-handler 或其他入口文件引用
- 新 API 端点是否注册到 http-router
- 新 WS 事件是否在前端有对应处理

### Step 3: 生成下一轮任务
创建 `CODEX-QUEUE-V2.md`，包含：
- 本轮发现的 bug 和遗漏
- 需要补充的错误处理
- 需要的集成测试
- CODEX-TASKBOOK.md 中的下一批 P1 任务

### Step 4: 部署
将 `CODEX-QUEUE-V2.md` 通过 webhook 部署到仓库。

---

## 九、失败恢复

| 情况 | 处理 |
|------|------|
| curl 返回 500 | 检查 content 是否有 JSON 转义问题，修复后重试 |
| 语法检查失败 | 读错误信息，修复代码，重新提交 |
| Import 路径不存在 | 用 find 确认实际路径，修正 import |
| 任务太复杂 | 拆成 2 个子步骤，先做简单的，复杂的标记 `[!] deferred` |
| 服务器无响应 | 等待 30s 重试一次，仍失败则标记 `[!] server unreachable` |

---

## 十、CODEX-LOG.md 格式

每完成一个任务，追加：

```markdown
## Q{N} — {任务标题}
- **状态**: done | skipped | partial
- **文件**: agent/worker/xxx.mjs, agent/worker/yyy.mjs
- **部署**: 200 OK (commit abc1234) | FAILED (reason)
- **耗时**: ~{N} min
- **备注**: {任何值得记录的发现}
```

---

## 十一、当前进度

**活跃任务队列**: `CODEX-QUEUE.md`（15 个任务，约 8 小时工作量）

**已完成的基础设施**:
- R111-R122 全部完成（心跳、RAG、限流、错误边界、历史查询等）
- 三层部署保护（rsync排除 + systemd环境变量 + 备份回滚）
- Codex webhook 部署通道就绪

**当前最大差距**（来自 CODEX-TASKBOOK.md）:
1. 浏览器 = STUB（零能力）
2. 多Agent编排 = 归档（未激活）
3. Worker Pool = 1（零并行）
4. 无持久化工作区
5. 前端缺少工具执行可视化

**从 CODEX-QUEUE.md 第一个 `[ ]` 任务开始执行。**


---
## 十二、关键修复记录（v5.1 补丁）

### 根因分析：为什么 Codex follow-up 模式代码不落地

**问题**: Codex 在 follow-up 模式下修改的文件只存在于临时沙箱，不会自动 commit/push。

**根因**:
1. Codex 的 follow-up 是在同一个 task 沙箱内继续工作
2. 只有 task 完成时的第一次 commit 会被 push（Q1 落地了）
3. 后续 follow-up 的修改停留在沙箱内存中
4. 沙箱回收后代码永久丢失

**修复方案（v5.1）**:
1. **每个任务必须是独立的 Codex task**（不是 follow-up）
2. 每个 task 完成后，Codex 会自动创建 commit
3. 用户点击 "Merge" 或 Codex 通过 webhook 部署
4. Webhook 方式仍然可用：POST body.secret = "ranger-codex-2026"

### 正确的 Codex 使用流程
```
1. 创建新 Task（不是 follow-up）
2. Prompt: "Read CODEX-QUEUE.md, execute the first [ ] task"
3. Task 完成 → Codex 自动 commit
4. 用户点击 Merge to main
5. GitHub Actions 自动部署到 ranger.voyage
6. 创建下一个 Task，重复
```

### Webhook 部署的正确格式
```bash
curl -X POST https://ranger.voyage/codex-deploy/apply-patch \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "ranger-codex-2026",
    "commit_message": "[Q{N}] Task description",
    "files": [
      {"path": "agent/worker/xxx.mjs", "action": "modify", "content": "完整文件内容"}
    ]
  }'
```

**注意**: secret 是 JSON body 字段，不是 HTTP header。
