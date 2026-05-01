# RangerAI Iteration Roadmap

> **格式说明**：Codex 自动读取此文件，找到第一个 `[ ]` 状态的任务执行。
> 完成后将 `[ ]` 改为 `[x]` 并 commit。

---

## 当前迭代阶段：Manus 化能力对齐

### 已完成

- [x] **R106** — Context Bridge 上下文窗口管理优化
  - 文件: `agent/worker/openclaw-handler.legacy.mjs`
  - 目标: Gateway session 超 80K token 时构建 Context Bridge 而非直接 reset
  - 验证: 日志出现 `[R106] Context bridge injected after reset: ok`

### 待执行

- [x] **R107** — http-router.mjs method 变量修复
  - 文件: `agent/modules/http-router.mjs`
  - 完成时间: 2026-05-01
  - 目标: 在 `handleRequest(req, res)` 内部添加 `const method = req.method || 'GET';`，与 `urlPath` 解析放在一起
  - 风险: 当前代码在进入该分支前会抛 `ReferenceError: method is not defined`
  - 验证: `curl -X POST https://ranger.voyage/api/health` 不再 500
  - 约束: 仅修改 http-router.mjs，不动其他路由文件

- [x] **R108** — Worker 错误恢复增强
  - 文件: `agent/worker/openclaw-handler.legacy.mjs`, `agent/worker/worker-manager.mjs`
  - 目标: Worker 执行任务时如果 OpenClaw Gateway 返回 5xx，自动重试 1 次（间隔 3s），而非直接报错给用户
  - 验证: 模拟 Gateway 503 → Worker 重试 → 用户收到正常响应
  - 约束: 重试上限 1 次，超过后正常报错；不改 Gateway 本身

- [x] **R109** — 模型路由配置外置化
  - 文件: `agent/worker/smart-router.mjs`（主修改）+ 新建 `agent/config/model-routing.json`
  - 参考: `docs/reference/smart-router-snapshot.mjs`（完整 734 行快照）
  - 目标: 将硬编码的 MODEL_MAP、THINKING_MAP、TOOL_MODEL、SAFE_FALLBACK_MODEL、phaseRoutes 抽取到 `agent/config/model-routing.json`，运行时读取
  - 具体步骤:
    1. 新建 `agent/config/model-routing.json`，包含所有模型映射数据
    2. 在 `smart-router.mjs` 顶部添加 JSON 加载逻辑（带 try-catch fallback）
    3. 将 `export const MODEL_MAP = {...}` 替换为从 JSON 加载的版本
    4. 将 `export const THINKING_MAP = {...}` 同理替换
    5. 将 `SAFE_FALLBACK_MODEL` 和 `TOOL_MODEL` 从 JSON 读取
    6. 将 `smartRouteByPhase` 内的 `phaseRoutes` 对象从 JSON 读取
    7. JSON 不存在或解析失败时，fallback 到代码内默认值（保持当前硬编码值作为默认）
  - 验证: 修改 json 后重启生效，无需改 .mjs 代码；json 删除后服务仍能正常启动（用默认值）
  - 约束: 保持三阶段架构不变；所有函数签名和返回值格式不变；不改 routing-config.mjs（那是分类规则，不是模型映射）
  - 修改策略: 使用 sed 做局部替换，不要尝试输出完整 734 行文件

- [x] **R110** — 任务执行超时优雅降级
  - 文件: `agent/worker/openclaw-handler.legacy.mjs`
  - 目标: `EXEC_TIMEOUT_MS` 触发后，不直接 kill worker，而是发送 cancel signal + 等待 5s graceful shutdown
  - 验证: 长任务超时后用户收到 "任务超时，已保存中间结果" 而非连接断开
  - 约束: 不改 EXEC_TIMEOUT_MS 的值（当前 180s）

- [x] **R111** — WebSocket 心跳 + 断线重连
  - 文件: `agent/ws-realtime.mjs`, `web/client/src/lib/api.ts`
  - 目标: 服务端每 30s 发 ping，客户端 45s 无 pong 自动重连；重连后恢复 session
  - 验证: 网络断开 10s 后恢复 → 客户端自动重连 → 对话继续
  - 约束: 不改现有消息协议格式

- [x] **R112** — RAG 检索结果排序优化
  - 文件: `agent/modules/knowledge-base.mjs`（或实际路径）
  - 目标: 检索结果按 relevance score 降序 + 去重 + 截断到 top-5
  - 验证: 相同 query 返回结果稳定且不重复
  - 约束: 不改 embedding 模型，只改后处理逻辑

- [x] **R113** — API 请求限流保护
  - 文件: `agent/api-server.mjs` 或 `agent/modules/routes/`
  - 目标: 对 `/api/chat` 添加 IP 级别限流（60 req/min），超限返回 429
  - 验证: 快速发送 61 次请求 → 第 61 次返回 429
  - 约束: 使用内存计数器（不引入 Redis），重启后计数器清零可接受

- [x] **R114** — 前端错误边界 + 用户友好提示
  - 文件: `web/client/src/pages/ChatPage.tsx`, `web/client/src/components/`
  - 目标: WebSocket 断开/API 报错时显示 toast 提示而非白屏；添加 ErrorBoundary
  - 验证: 手动断开 WS → 页面显示 "连接中断，正在重连..." 而非崩溃
  - 约束: 不改后端逻辑

- [x] **R115** — 对话历史持久化查询 API
  - 文件: `agent/api-server.mjs`, `agent/worker/db-proxy.mjs`
  - 目标: 添加 `GET /api/conversations?userId=xxx&limit=20` 分页查询历史对话
  - 验证: curl 调用返回 JSON 数组，包含 sessionKey, title, lastMessage, updatedAt
  - 约束: 只读接口，不改写入逻辑

- [x] **R116** — 连接恢复阶段状态机增强
  - 文件: `web/client/src/hooks/useChatStore.tsx`
  - 目标: 将 WS 重连与恢复流程映射到 recoveryPhase（reconnecting_ws/recovering_task/recovered/failed）并携带用户可读 message
  - 验证: 断网重连时 recoveryPhase 按阶段变化；重连失败进入 failed，恢复后进入 recovered
  - 约束: 不改后端协议，不引入新依赖

- [x] **R117** — Recover Contract 元数据增强
  - 文件: `web/client/src/hooks/useChatStore.tsx`, `agent/modules/ws-control-handlers.mjs`
  - 目标: recover_task 增加 snapshotHash/lastChunkSeq，与 lastEventTs 一并上传，服务端记录恢复上下文
  - 验证: recover 请求日志包含 sinceTs + snapshotHash + lastChunkSeq
  - 约束: 不改现有 WS 消息协议基础字段，仅做向后兼容扩展

- [x] **R118** — 恢复链路可解释追踪
  - 文件: `agent/modules/ws-control-handlers.mjs`, `web/client/src/hooks/useChatStore.tsx`
  - 目标: 服务端在 recover_task 开始时下发 recovery_trace，前端将关键元数据写入 timeline 便于排障
  - 验证: 断线恢复时 timeline 出现 Recovery Trace 条目，含 sinceTs/lastChunkSeq/snapshotHash
  - 约束: 不改既有恢复逻辑分支，仅新增观测事件

---

## 任务格式规范

每个任务必须包含：
- **文件**: 需要修改的文件路径（相对于 repo 根目录）
- **目标**: 一句话描述要做什么
- **验证**: 如何确认修改成功
- **约束**: 不能碰什么

---

## 禁区（任何任务都不能碰）

1. `/opt/openclaw/` — Gateway 独立进程
2. `agent/package.json` 的 `start` 脚本 — 历史遗留
3. `web/server/_core/` — 框架层
4. Caddy/systemd 配置文件
5. 硬编码路径 `/opt/rangerai-agent` 和 `/opt/rangerai-web`
6. `.env` 文件 — 不入库
7. `data/` 和 `*.sqlite` — 运行时数据
