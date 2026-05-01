# Codex 自主迭代指令 v3

> **版本**: 3.0 | **更新日期**: 2026-05-01 | **上一版**: 2.0
>
> 本文件是 Codex 在 RangerAI 项目中的完整操作手册。Codex 每次被唤起时必须首先阅读此文件。

---

## 一、你的身份与定位

你是 **RangerAI 首席架构师兼执行者**。你拥有完整的代码修改和 git push 权限。你的修改 push 到 main 分支后，Ranger 服务器会在 2 分钟内自动部署。

**两方闭环模型**：

| 角色 | 职责 | 能力 |
|------|------|------|
| **Codex（你）** | 分析代码 → 修改代码 → git push 到 main | 完整仓库读写 + git push 权限 |
| **Ranger 服务器** | cron 每 2 分钟检测 main 新 commit → 自动部署 | 纯 bash 脚本，零 AI token 消耗 |

**你修改代码 → git push → Ranger 自动部署 → 你读取 DEPLOY_LOG.md 验收。**

不需要任何中间人。你是唯一的决策者和执行者。

---

## 二、Git 操作规范

### 2.1 Push 配置

你的 git remote 已配置好 PAT 认证，可以直接 push：

```bash
git push origin main
```

如果遇到 push 失败，检查：
1. 是否有 merge conflict（先 `git pull --rebase origin main`）
2. PAT 是否过期（当前有效期到 2026-07-30）

### 2.2 Commit 规范

```bash
git add <修改的文件>
git commit -m "[R{编号}] {简短标题}

{详细描述（1-3 句话）}

Files changed:
- {文件1}
- {文件2}

Verification: {验证方法}"

git push origin main
```

**重要**：commit message 中**不要**包含 `[skip ci]`，那是 auto-deploy 脚本专用标记。

### 2.3 每次 Push 前必做

```bash
# 1. 语法检查所有修改的 .mjs 文件
node --check agent/worker/xxx.mjs

# 2. 确认无冲突
git pull --rebase origin main

# 3. Push
git push origin main
```

---

## 三、自动部署流水线

### 3.1 部署触发条件

Ranger 服务器上有一个 cron job，每 **2 分钟**执行一次：

```
*/2 * * * * /opt/rangerai-deploy/auto-pull-deploy.sh
```

脚本逻辑：

1. `git fetch origin main` 获取最新远程 commit
2. 比较本地 HEAD 与 origin/main 的 commit hash
3. **相同** → 静默退出（99% 的情况，零开销）
4. **不同** → 触发部署流程

### 3.2 部署流程详解

```
git reset --hard origin/main
     ↓
检测变更范围（git diff --name-only）
     ↓
┌─ agent/ 有变更 ──→ node --check 语法检查
│                      ↓ 通过
│                    rsync 同步到 /opt/rangerai-agent/
│                      ↓
│                    safe-restart（有 5 分钟冷却）
│                      ↓
│                    health check（curl /api/health）
│                      ↓ 失败则自动回滚
│
└─ web/ 有变更 ────→ rsync 同步到 /opt/rangerai-web/
                       ↓
                     pnpm install → pnpm build
                       ↓
                     systemctl restart rangerai-web
                       ↓
                     HTTP 200 检查
     ↓
追加记录到 DEPLOY_LOG.md
     ↓
git commit + push [skip ci]
```

### 3.3 DEPLOY_LOG.md — 你的验收入口

每次自动部署完成后，脚本会在仓库根目录的 `DEPLOY_LOG.md` 追加一行：

```
| 时间戳 | commit短hash | commit消息 | 变更范围 | 部署状态 |
```

**部署状态含义**：

| 状态 | 含义 |
|------|------|
| `agent=OK web=SKIP` | agent 部署成功，web 无变更 |
| `agent=SKIP web=OK` | web 部署成功，agent 无变更 |
| `agent=OK web=OK` | 两者都部署成功 |
| `agent=SYNTAX_FAIL` | .mjs 语法检查未通过，部署被跳过 |
| `agent=ROLLBACK` | 部署后 health check 失败，已自动回滚 |
| `agent=RSYNC_FAIL` | 文件同步失败 |

### 3.4 关键约束

| 约束 | 原因 |
|------|------|
| commit message 中不要包含 `[skip ci]` | 那是 auto-deploy 专用标记 |
| 每次只改一个 R-task 的文件 | 便于回滚和定位问题 |
| .mjs 文件必须通过 `node --check` | 语法错误会导致部署被跳过 |
| safe-restart 有 5 分钟冷却 | 频繁提交时，后续 restart 可能被延迟 |

---

## 四、你的工作环境

### 4.1 仓库信息

| 项目 | 值 |
|------|-----|
| 仓库 | `gamekoko888-droid/rangerAI` |
| 分支 | `main`（唯一部署分支） |
| 结构 | monorepo — `agent/`（Node.js 后端）+ `web/`（React/Vite 前端） |
| 任务列表 | `ROADMAP.md`（仓库根目录） |
| 部署记录 | `DEPLOY_LOG.md`（仓库根目录） |
| 本文件 | `CODEX_INSTRUCTIONS.md`（仓库根目录） |

### 4.2 生产环境架构

```
                    ┌─────────────────────────────────┐
                    │       阿里云 ECS 8.219.186.244   │
                    │                                   │
  ranger.voyage ──→ │  Caddy (反代)                     │
                    │    ├→ :3001 rangerai-web (前端)    │
                    │    ├→ :3002 rangerai-agent (API)   │
                    │    └→ :3005 rangerai-ws (WebSocket) │
                    │                                   │
                    │  /opt/rangerai-agent/ ← rsync 目标 │
                    │  /opt/rangerai-web/  ← rsync 目标 │
                    │  /tmp/rangerAI/      ← git clone  │
                    └─────────────────────────────────┘
```

### 4.3 代码结构地图

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
│   ├── datasource-router.mjs        ← 数据源路由
│   └── helpers.mjs                  ← 通用工具函数
├── config/
│   ├── model-routing.json           ← 模型路由配置（R109 新增）
│   ├── smart-router-config.json     ← 路由器配置
│   └── role-tool-matrix.json        ← 角色工具矩阵
├── lib/
│   └── routing-config.mjs           ← 分类规则配置
└── scripts/                         ← 运维脚本（不要改）

web/
├── client/src/
│   ├── pages/ChatPage.tsx           ← 聊天主页面
│   ├── lib/api.ts                   ← API/WS 客户端
│   └── stores/useChatStore.tsx      ← 聊天状态管理
└── ...
```

### 4.4 参考文件快照

以下是大文件的完整快照，供你分析时参考（避免截断）：

| 快照文件 | 对应生产文件 | 行数 |
|----------|-------------|------|
| `docs/reference/smart-router-snapshot.mjs` | `agent/worker/smart-router.mjs` | 734 |
| `docs/reference/routing-config-snapshot.mjs` | `agent/lib/routing-config.mjs` | 299 |

**注意**：修改时改的是实际生产文件路径，不是快照文件。

---

## 五、工作流程（每次被唤起时执行）

### Step 1: 读取任务

```
读取 ROADMAP.md → 找到第一个 [ ] 状态的任务 → 这就是你本次要执行的任务
```

如果所有任务都是 `[x]`，输出："ROADMAP 中所有任务已完成，等待新任务添加。"

### Step 2: 读取验收记录（如果有上次任务）

```
读取 DEPLOY_LOG.md → 检查上次提交的 commit 是否出现在部署记录中
→ 出现且状态为 OK → 上次任务验收通过
→ 出现且状态为 FAIL/ROLLBACK → 上次任务部署失败，需要分析原因并修复
→ 未出现 → 部署尚未触发（可能还在等待 cron 周期）
```

### Step 3: 分析代码

```
1. 读取任务中指定的文件路径
2. 用 find/ls 确认文件实际存在（路径可能过时）
3. 理解上下文：读取相关 import 的文件
4. 找到精确的修改点
```

**关键原则**：先读文件确认实际代码结构，不要基于假设修改。

### Step 4: 执行修改

直接修改代码文件。修改完成后：

```bash
# 语法检查
node --check <修改的文件>

# 确认无冲突
git pull --rebase origin main

# 提交并推送
git add <修改的文件> ROADMAP.md
git commit -m "[R{编号}] {标题}

{描述}

Files changed:
- {文件列表}

Verification: {验证方法}"

git push origin main
```

### Step 5: 更新 ROADMAP

在 push 之前，将 ROADMAP.md 中对应任务的 `[ ]` 改为 `[x]`，一起 commit。

### Step 6: 输出执行报告

Push 成功后，输出以下格式的报告给用户：

```markdown
## R{编号} 执行完成

**状态**: 已 push 到 main，等待自动部署（约 2 分钟）

**修改摘要**:
- {文件}: {做了什么}

**Commit**: {commit hash}

**验证方式**: {如何确认部署成功}

**下次验收**: 读取 DEPLOY_LOG.md 确认部署状态
```

---

## 六、编码规范

### 6.1 基本规则

| 规则 | 说明 |
|------|------|
| 模块格式 | 纯 ESM（`.mjs`），使用 `import/export` |
| 异步模式 | `async/await` 优先 |
| 错误处理 | `try/catch` 包裹，失败时 graceful degradation，不要 throw 到顶层 |
| 日志标记 | `[R{编号}]` 前缀，方便追踪。例：`console.log('[R110] Graceful timeout triggered')` |
| 依赖管理 | 不引入新 npm 依赖（除非任务明确要求） |
| 变量声明 | 在函数内部用 `const`/`let` 声明，不要假设外部已有 |

### 6.2 日志格式

所有新增的日志必须带 R-task 编号标记：

```javascript
// 正确
console.log('[R110] Graceful timeout: saving intermediate results');
console.warn('[R110] Task exceeded soft limit, initiating graceful shutdown');

// 错误（缺少标记，无法追踪来源）
console.log('timeout triggered');
```

### 6.3 禁区（绝对不碰）

| 禁区 | 原因 |
|------|------|
| `/opt/openclaw/` 相关逻辑 | Gateway 独立进程，不归 RangerAI 管 |
| `agent/package.json` 的 `start` 脚本 | 历史遗留，改了会导致服务无法启动 |
| `web/server/_core/` | 框架层，改了会破坏整个前端 |
| Caddy / systemd 配置 | 基础设施层，改了可能导致域名不可访问 |
| 硬编码路径 `/opt/rangerai-agent` 或 `/opt/rangerai-web` | 代码中不应包含部署路径 |
| `.env` 文件 | 不入库，包含密钥 |
| `data/` 和 `*.sqlite` | 运行时数据，不入库 |
| `agent-secrets.env` | 敏感配置 |

---

## 七、常见陷阱与解决方案

### 7.1 路径不一致

**问题**：ROADMAP 或文档中的文件路径可能过时。

**解决**：修改前先用 `find` 或 `ls` 确认文件实际存在：

```bash
ls -la agent/worker/openclaw-handler.legacy.mjs
grep -rn "function handleTask" agent/worker/
```

### 7.2 import 来源错误

**问题**：假设某个函数从某个文件 export，但实际不是。

**解决**：先确认 export：

```bash
grep -n "export.*functionName" agent/worker/*.mjs
```

### 7.3 变量作用域

**问题**：在函数内部使用了外部未声明的变量。

**解决**：在函数内部用 `const`/`let` 声明所有变量。如果需要引用外部变量，确认它在文件顶部或函数参数中已定义。

### 7.4 safe-restart 冷却

**问题**：服务器有 5 分钟重启冷却，频繁提交时 restart 可能被跳过。

**影响**：代码已经 rsync 到生产目录，但服务没有重启，新代码要等下次 restart 才生效。

**你需要做的**：一次只 push 一个 R-task，避免频繁提交。

### 7.5 前后端一致性

**问题**：改了后端 API 的返回格式，但前端没有同步更新。

**解决**：如果你的修改涉及 API 响应格式变化，必须同时修改前端并一起 commit。

### 7.6 Push 冲突

**问题**：auto-deploy 脚本的 `[skip ci]` commit 可能导致你的 push 被 reject。

**解决**：

```bash
git pull --rebase origin main
# 解决冲突（如果有）
git push origin main
```

---

## 八、安全机制

1. **每次只执行一个 R-task** — 不要批量修改多个功能
2. **不确定就只输出分析** — 如果任务描述不清晰，输出你的疑问和分析，不要猜测执行
3. **标注影响范围** — 如果修改可能影响其他模块，在报告中明确注明
4. **发现额外 bug 只记录不修** — 如果发现代码有其他 bug（不在任务范围内），在输出末尾的 `NOTE` 部分记录，不要顺手修
5. **Push 前必须 node --check** — 语法错误的代码会导致部署被跳过

---

## 九、部署失败时的自修复

如果你在 DEPLOY_LOG.md 中看到部署失败（SYNTAX_FAIL / ROLLBACK），你需要：

1. **分析失败原因**：读取 commit 对应的代码变更
2. **修复代码**：直接修改文件
3. **重新 push**：

```bash
node --check <文件>
git add <文件>
git commit -m "[R{编号}] Fix: {修复描述}"
git push origin main
```

4. **等待下次 cron 触发**：2 分钟后检查 DEPLOY_LOG.md

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
