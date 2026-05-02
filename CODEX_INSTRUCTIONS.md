# CODEX_INSTRUCTIONS.md

> **版本**: 7.0 | **更新日期**: 2026-05-02 | **上一版**: 6.0
>
> 本文件是 Codex 在 RangerAI 项目中的完整操作手册。
> **v7 核心变更**: 适配 Codex Cloud 沙箱限制 — 不依赖 git push 或 webhook，只需 commit 到当前 branch

---

## 一、你的身份与定位

你是 **RangerAI 首席架构师兼执行者**。你在全自动模式下工作：读取任务队列 → 实现代码 → commit 到当前 branch → 标记完成 → 下一个任务。**永远不暂停等待人类确认。**

**部署闭环**：

```
Codex 修改代码 → git add → git commit（到当前 branch）
                                ↓
                    Codex 平台自动创建 PR
                                ↓
                    auto-merge-codex.yml 自动合并到 main
                                ↓
                    deploy.yml (GitHub Actions) 自动触发
                                ↓
                SSH 部署到 ranger.voyage (阿里云)
                                ↓
                语法检查 → rsync → 重启 → 健康验证
```

**你只需要做**: `git add → git commit`（到当前 branch）
**你不需要做**:
- ❌ `git push`（沙箱禁止）
- ❌ `git fetch` / `git pull`（沙箱禁止）
- ❌ `curl` / `webhook` / HTTP POST（网络不可达）
- ❌ 手动创建 PR（Codex 平台自动处理）

---

## 二、执行模式

### 2.1 任务来源优先级

1. **首选**: `CODEX-QUEUE.md`（如果存在且有未完成任务）
2. **次选**: `CODEX-QUEUE-V2.md`、`V3.md` 等（自审计生成的后续队列）
3. **末选**: `ROADMAP.md`（传统任务列表）

### 2.2 连续执行规则

```
WHILE (队列中有 [ ] 任务):
    task = 第一个 [ ] 任务
    result = 执行(task)
    IF result == success:
        git add + commit，标记 [x]，记录到 CODEX-LOG.md
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
2. **ONLY 使用 git add + git commit** — 这是你唯一能做的 git 操作
3. **NEVER 使用 git push / git fetch / git pull** — 沙箱硬限制禁止
4. **NEVER 使用 webhook / curl POST** — 网络不可达（ENETUNREACH）
5. **NEVER 修改禁区文件** — 见第六节
6. **ALWAYS 每个任务独立 commit** — 不要批量
7. **ALWAYS 标记完成状态** — commit 后立即更新队列文件
8. **ALWAYS 记录日志** — 每个任务追加到 CODEX-LOG.md
9. **3 次失败就跳过** — 标记 `[!]` 并继续下一个
10. **尽可能多做任务** — 在单次 session 中完成尽可能多的任务

### 2.4 多任务 commit 策略

由于每次 Codex session 结束后才会创建 PR，你应该在一次 session 中：
1. 连续完成多个任务
2. 每个任务一个 commit（方便追踪）
3. 所有 commit 会在 session 结束后一起出现在 PR 中
4. PR 会被自动合并，触发部署

---

## 三、部署方式（v7 — 适配沙箱限制）

### 3.1 你的部署方式：commit 到当前 branch

```bash
# 1. 修改代码文件
# 2. 暂存并提交（到当前 branch，不需要 push）
git add agent/worker/xxx.mjs
git add CODEX-QUEUE.md CODEX-LOG.md
git commit -m "[Q{N}] 任务描述

实现了 xxx 功能...

Files changed:
- agent/worker/xxx.mjs

Verification: 描述如何验证"
```

**就这样。不需要 push。** Codex 平台会在 session 结束后自动创建 PR。

### 3.2 自动部署流水线（你不需要操心）

你 commit 后，以下步骤全自动发生：

1. **Codex 平台** — session 结束后自动创建 PR 到 main
2. **auto-merge-codex.yml** — 自动审批 + 自动合并 PR
3. **deploy.yml** — 合并后自动触发：
   - 检测变更范围（agent/ vs web/）
   - 语法检查（node --check）
   - SSH 部署到阿里云
   - 安装依赖 + 构建（web 变更时）
   - 重启服务
   - 健康验证
   - 失败自动回滚

### 3.3 commit message 规范

```
[Q{N}] 简短描述          ← 队列任务
[R{N}] 简短描述          ← ROADMAP 任务
[FIX] 简短描述           ← Bug 修复
[AUDIT] 简短描述         ← 自审计修复
```

### 3.4 验证方式

由于你无法访问外部网络，验证方式限于：
- `node --check agent/worker/xxx.mjs` — 语法检查
- `node -e "import('./agent/worker/xxx.mjs').then(m => console.log(Object.keys(m)))"` — 导入检查
- 读取源文件确认 import 路径正确

---

## 四、工作流程

### 每个任务的执行步骤：

```
1. 读取任务描述（从队列文件）
2. 读取相关源文件（确认实际代码结构）
3. 实现修改
4. 自检：
   a. 所有 import 路径正确？
   b. 无语法错误？（node --check）
   c. 导出的函数签名正确？
5. git add + commit（到当前 branch）
6. 更新队列文件（标记 [x]）
7. 追加 CODEX-LOG.md
8. git add + commit（标记更新）
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
| 任务队列 | `CODEX-QUEUE.md`（v7 首选） |
| 任务书 | `CODEX-TASKBOOK.md`（完整差距分析 + 20 个大任务） |
| 传统任务 | `ROADMAP.md` |
| 部署记录 | `DEPLOY_LOG.md`（GitHub Actions 自动更新） |
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

部署路径:
  Codex commit → PR → auto-merge → main → Actions SSH → rsync → /opt/rangerai-{agent|web}/
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
│   ├── browser-service.mjs          ← 浏览器工具（Puppeteer CDP）
│   ├── browser-failure-taxonomy.mjs ← 浏览器失败分类
│   ├── sub-agent-orchestrator.mjs   ← 多Agent HTTP编排
│   ├── sub-agent-compactor.mjs      ← 子Agent结果压缩
│   ├── file-tools.mjs               ← 文件系统工具
│   ├── workspace-manager.mjs        ← 持久化工作区
│   ├── health-monitor.mjs           ← 健康监控
│   ├── ws-heartbeat.mjs             ← WebSocket心跳
│   ├── tool-execution-stream.mjs    ← 工具执行流式事件
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
│   │   └── ToolExecutionLog.vue     ← 工具执行实时展示
│   ├── hooks/
│   │   ├── useWebSocket.ts          ← WebSocket hook
│   │   └── useChatStore.tsx         ← 聊天状态管理
│   ├── stores/                      ← Zustand stores
│   └── lib/api.ts                   ← API 客户端
└── server/routers.ts                ← tRPC 路由
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
| `.github/workflows/deploy.yml` | CI/CD 流水线（已配置好） |
| `.github/workflows/auto-merge-codex.yml` | 自动合并流水线（已配置好） |

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
创建 `CODEX-QUEUE-V{N+1}.md`，包含：
- 本轮发现的 bug 和遗漏
- 需要补充的错误处理
- 需要的集成测试
- CODEX-TASKBOOK.md 中的下一批 P1 任务

### Step 4: 提交
```bash
git add CODEX-QUEUE-V{N+1}.md CODEX-LOG.md
git commit -m "[AUDIT] Self-audit complete, generated V{N+1} queue"
```

---

## 九、失败恢复

| 情况 | 处理 |
|------|------|
| git push 被拒绝 | **不要 push** — 只 commit 到当前 branch |
| 语法检查失败 | 修复代码，重新 commit |
| Import 路径不存在 | 用 find 确认实际路径，修正 import |
| 任务太复杂 | 拆成 2 个子步骤，先做简单的，复杂的标记 `[!] deferred` |
| 网络不可达 | **正常** — 你在沙箱里，不需要网络访问 |
| git fetch/pull 失败 | **不要尝试** — 直接基于当前代码工作 |

---

## 十、CODEX-LOG.md 格式

每完成一个任务，追加：

```markdown
## Q{N} — {任务标题}
- **状态**: done | skipped | partial
- **文件**: agent/worker/xxx.mjs, agent/worker/yyy.mjs
- **commit**: {commit hash}
- **耗时**: ~{N} min
- **备注**: {任何值得记录的发现}
```

---

## 十一、当前进度

**活跃任务队列**: `CODEX-QUEUE.md`（检查最新版本）

**已完成的基础设施**:
- R111-R122 全部完成（心跳、RAG、限流、错误边界、历史查询等）
- Q1-Q15 全部完成（工作区、文件工具、浏览器、多Agent、并行、流式、健康监控）
- GitHub Actions 自动部署流水线就绪（SSH + 健康验证 + 自动回滚）
- Auto-merge workflow 就绪（Codex PR 自动合并）
- pnpm 权限问题已修复（web 构建正常）

**当前最大差距**（来自 CODEX-TASKBOOK.md）:
1. 浏览器服务需要集成到 openclaw-handler 工具执行路径
2. 多Agent编排需要接入实际 gateway 会话
3. Worker Pool 扩容（从 1 到 N）
4. 前端工具执行可视化需要接入 WebSocket 事件
5. 端到端集成测试覆盖

**从 CODEX-QUEUE.md 第一个 `[ ]` 任务开始执行。**

---

## 十二、沙箱限制说明

你运行在 Codex Cloud 沙箱中，有以下硬限制：

| 限制 | 说明 |
|------|------|
| ❌ git push | 沙箱禁止推送到远程 |
| ❌ git fetch/pull | 沙箱禁止从远程拉取 |
| ❌ 外部网络 | 只能访问 github.com 和 npm registry |
| ❌ webhook | ranger.voyage (8.219.186.244) 不可达 |
| ✅ git add/commit | 可以在当前 branch 上 commit |
| ✅ 读写本地文件 | 完全的文件系统访问 |
| ✅ node/npm | 可以运行 Node.js 和安装 npm 包 |
| ✅ 语法检查 | node --check 验证代码 |

**你的代码通过以下路径到达生产环境**：
```
你的 commit → Codex 创建 PR → auto-merge → GitHub Actions → 阿里云
```

---

## 十三、版本历史

| 版本 | 日期 | 核心变更 |
|------|------|----------|
| v7.1 | 2026-05-02 | **新增部署验证指南：教会正确判断部署状态** |
| v7.0 | 2026-05-02 | **适配沙箱限制：只 commit，不 push/webhook** |
| v6.0 | 2026-05-02 | 废弃 webhook，改用 git push（发现 push 也被禁） |
| v5.1 | 2026-05-02 | 修复 webhook secret 格式 |
| v5.0 | 2026-05-02 | 全自动连续执行 + 自审计循环 |
| v4.0 | 2026-05-01 | 任务队列驱动 |

### 为什么 v7 只用 commit？

1. **git push 被沙箱禁止** — Codex Cloud 的硬限制
2. **webhook 网络不可达** — ENETUNREACH 8.219.186.244:443
3. **Codex 平台自动创建 PR** — session 结束后自动处理
4. **auto-merge workflow** — PR 创建后自动合并到 main
5. **GitHub Actions** — main 更新后自动部署到阿里云

---
## 十四、部署验证（关键！）

### ⚠️ 重要：DEPLOY_LOG.md 不是部署真相来源

**DEPLOY_LOG.md 只是一个辅助记录文件**，它由 GitHub Actions 的 "Write deploy log" 步骤自动写入。
如果该步骤失败、被跳过、或 commit 使用了 `[skip ci]` 标签，DEPLOY_LOG.md 就不会更新。

**这不代表代码没有部署。**

### 正确的部署验证方法（按优先级排序）

#### 方法 1：GitHub Actions 运行记录（权威来源）
```
查看 GitHub Actions → Deploy to Production → 每个 run 的 conclusion
- success = 已部署
- failure = 部署失败（但文件可能已 rsync 到服务器，只是 verify 步骤失败）
```
**这是最权威的部署证据。** 如果 GitHub Actions run 显示 success，代码就已经在生产服务器上了。

#### 方法 2：服务器文件对比（最终真相）
```bash
# 对比 git repo 和生产目录
cd /tmp/rangerAI
find agent/ -type f -name "*.mjs" | while read f; do
  target="/opt/rangerai-agent/${f#agent/}"
  if [ -f "$target" ]; then
    diff -q "$f" "$target" > /dev/null 2>&1 || echo "DIFF: $f"
  else
    echo "MISSING: $f"
  fi
done
```
如果输出为空 = 所有文件已同步到生产。

#### 方法 3：服务健康检查
```bash
# Agent API
curl -s http://127.0.0.1:3002/api/health
# 期望: {"status":"ok","version":"5.0.0"}

# WS + Workers
curl -s http://127.0.0.1:3005/health
# 期望: {"status":"ok","readyWorkers":4,"poolSize":4,...}
# 关键字段: readyWorkers > 0, degraded = false, gatewayConnected = true
```

### 部署判定规则

| 条件 | 判定 |
|------|------|
| GitHub Actions run = success | ✅ 已部署 |
| GitHub Actions run = failure 但 "Deploy Agent" step = success | ⚠️ 文件已部署，verify 可能失败 |
| 服务器文件与 repo 一致（方法2输出为空） | ✅ 已部署 |
| DEPLOY_LOG.md 有记录 | 📝 辅助确认（但缺失不代表未部署） |
| DEPLOY_LOG.md 无记录 | ❓ 不能判定未部署，需用方法1或2验证 |

### 你（Codex）不需要关心部署

**你的职责是：写代码 → commit → 创建 PR**

部署由以下自动化链路完成：
```
你的 commit → PR → auto-merge → main → GitHub Actions deploy.yml → rsync 到阿里云 → systemctl restart
```

**不要：**
- ❌ 尝试 webhook 部署（网络不可达）
- ❌ 尝试 git push（沙箱禁止）
- ❌ 仅凭 DEPLOY_LOG.md 缺失记录就判定"未部署"
- ❌ 重复提交已存在的代码"补部署"

**要做的：**
- ✅ 专注写高质量代码
- ✅ 确保 `node --check` 通过
- ✅ 正确 commit 到当前分支
- ✅ 信任自动化流水线会处理部署

### DEPLOY_LOG.md 的正确用途

DEPLOY_LOG.md 是**可选的辅助参考**，用于快速浏览部署历史。
如果你发现它缺少记录，**不需要任何行动**——这只是日志写入步骤的遗漏，不影响实际部署。

---
