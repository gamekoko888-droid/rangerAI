# RangerAI Iteration Roadmap

> **格式说明**：Codex 自动读取此文件，找到第一个 `[ ]` 状态的任务执行。
> 完成后将 `[ ]` 改为 `[x]` 并在输出方案中注明。
>
> **协作模式**：Codex 输出修改方案 → 用户转给 Manus → Manus 执行并 push → Ranger 服务器自动部署。
> 详细操作规范见 `CODEX_INSTRUCTIONS.md`。部署结果见 `DEPLOY_LOG.md`。

---

## 当前迭代阶段：Manus 化能力对齐

### 已完成

- [x] **R106** — Context Bridge 上下文窗口管理优化
  - 文件: `agent/worker/openclaw-handler.legacy.mjs`
  - 目标: Gateway session 超 80K token 时构建 Context Bridge 而非直接 reset
  - 验证: 日志出现 `[R106] Context bridge injected after reset: ok`

- [x] **R107** — http-router.mjs method 变量修复
  - 文件: `agent/modules/http-router.mjs`
  - 完成时间: 2026-05-01
  - 目标: 在 `handleRequest(req, res)` 内部添加 `const method = req.method || 'GET';`
  - 验证: `curl -X POST https://ranger.voyage/api/health` 不再 500

- [x] **R108** — Worker 错误恢复增强
  - 文件: `agent/worker/openclaw-handler.legacy.mjs`, `agent/worker/worker-manager.mjs`
  - 目标: Worker 执行任务时如果 Gateway 返回 5xx，自动重试 1 次（间隔 3s）
  - 验证: 模拟 Gateway 503 → Worker 重试 → 用户收到正常响应

- [x] **R109** — 模型路由配置外置化
  - 文件: `agent/worker/smart-router.mjs` + `agent/config/model-routing.json`
  - 目标: 将硬编码的 MODEL_MAP 等抽取到 JSON，运行时读取
  - 验证: 修改 json 后重启生效；json 删除后服务仍能启动（用默认值）

### 待执行

- [ ] **R110** — 任务执行超时优雅降级
  - 文件: `agent/worker/openclaw-handler.legacy.mjs`
  - 目标: `EXEC_TIMEOUT_MS` 触发后，不直接 kill worker，而是发送 cancel signal + 等待 5s graceful shutdown
  - 验证: 长任务超时后用户收到 "任务超时，已保存中间结果" 而非连接断开
  - 约束: 不改 EXEC_TIMEOUT_MS 的值（当前 180s）

- [ ] **R111** — WebSocket 心跳 + 断线重连
  - 文件: `agent/ws-realtime.mjs`, `web/client/src/lib/api.ts`
  - 目标: 服务端每 30s 发 ping，客户端 45s 无 pong 自动重连；重连后恢复 session
  - 验证: 网络断开 10s 后恢复 → 客户端自动重连 → 对话继续
  - 约束: 不改现有消息协议格式

- [ ] **R112** — RAG 检索结果排序优化
  - 文件: `agent/modules/knowledge-base.mjs`（或实际路径）
  - 目标: 检索结果按 relevance score 降序 + 去重 + 截断到 top-5
  - 验证: 相同 query 返回结果稳定且不重复
  - 约束: 不改 embedding 模型，只改后处理逻辑

- [ ] **R113** — API 请求限流保护
  - 文件: `agent/api-server.mjs` 或 `agent/modules/routes/`
  - 目标: 对 `/api/chat` 添加 IP 级别限流（60 req/min），超限返回 429
  - 验证: 快速发送 61 次请求 → 第 61 次返回 429
  - 约束: 使用内存计数器（不引入 Redis），重启后计数器清零可接受

- [ ] **R114** — 前端错误边界 + 用户友好提示
  - 文件: `web/client/src/pages/ChatPage.tsx`, `web/client/src/components/`
  - 目标: WebSocket 断开/API 报错时显示 toast 提示而非白屏；添加 ErrorBoundary
  - 验证: 手动断开 WS → 页面显示 "连接中断，正在重连..." 而非崩溃
  - 约束: 不改后端逻辑

- [ ] **R115** — 对话历史持久化查询 API
  - 文件: `agent/api-server.mjs`, `agent/worker/db-proxy.mjs`
  - 目标: 添加 `GET /api/conversations?userId=xxx&limit=20` 分页查询历史对话
  - 验证: curl 调用返回 JSON 数组，包含 sessionKey, title, lastMessage, updatedAt
  - 约束: 只读接口，不改写入逻辑

---

## 任务格式规范

每个任务必须包含：
- **文件**: 需要修改的文件路径（相对于 repo 根目录）
- **目标**: 一句话描述要做什么
- **验证**: 如何确认修改成功
- **约束**: 不能碰什么

---

## 自动部署说明

当代码被 push 到 `main` 分支后，Ranger 服务器的 cron job 会在 **2 分钟内**自动检测并部署：

1. `agent/` 目录有变更 → 语法检查 → rsync → 重启 agent + ws 服务 → health check
2. `web/` 目录有变更 → rsync → pnpm build → 重启 web 服务 → HTTP 200 检查
3. 部署结果自动追加到 `DEPLOY_LOG.md` 并 push 回仓库

**Codex 验收方式**：下次被唤起时读取 `DEPLOY_LOG.md` 最后几行，确认部署状态。

---

## 禁区（任何任务都不能碰）

1. `/opt/openclaw/` — Gateway 独立进程
2. `agent/package.json` 的 `start` 脚本 — 历史遗留
3. `web/server/_core/` — 框架层
4. Caddy/systemd 配置文件
5. 硬编码路径 `/opt/rangerai-agent` 和 `/opt/rangerai-web`
6. `.env` 文件 — 不入库
7. `data/` 和 `*.sqlite` — 运行时数据
