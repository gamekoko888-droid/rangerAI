# 第二轮迭代：Gateway 加固方案

## 背景

当前 Gateway（OpenClaw Gateway）是 RangerAI 的核心依赖，所有 AI 对话都通过它路由。今天的事件（端口从 7777 变为 18789）暴露了单点故障风险。

## 现状分析

### 已有的保护机制（做得好的部分）
1. **CircuitBreaker** - 3 次失败后熔断，30s 后半开探测
2. **指数退避重连** - 最多 10 次，base 2^n，max 30s，30% jitter
3. **Tick Monitor** - 300s 无消息自动断开重连
4. **Stall Detection** - 4 分钟浏览器任务卡死检测 + 自动 kill chromium
5. **Browser CircuitBreaker** - 浏览器工具 3 次失败后 5 分钟冷却

### 存在的问题
1. **10 次重连后永久放弃** - `_terminated = true` 后再也不会重连，只能重启服务
2. **Gateway 进程崩溃无自动恢复** - 如果 openclaw-gateway 进程挂了，没有 supervisor
3. **端口变更无感知** - 如果 Gateway 端口变了（如今天的事件），worker 硬编码 `ws://127.0.0.1:18789`
4. **前端只显示"Gateway 连接异常"** - 没有具体错误信息和自助恢复指引
5. **没有 Gateway 进程健康检查** - 只检查 WebSocket 连接，不检查 Gateway 进程是否存活

## 改造方案（4 个子步骤）

### A. 无限重连 + 智能退避（改 agent-worker.mjs）
- 移除 `MAX_RECONNECT_ATTEMPTS = 10` 的硬限制
- 改为：前 10 次快速重连（1s-30s），之后进入慢速重连模式（每 60s 一次）
- 永远不设置 `_terminated = true`（除非收到 graceful shutdown 信号）
- 每次重连前动态读取 openclaw.json 获取最新端口

### B. Gateway 进程监控 + 自动重启（新建 gateway-watchdog.mjs）
- 独立模块，每 30s 检查 Gateway 进程是否存活
- 如果进程不存在，自动执行 `openclaw gateway start`
- 如果连续 3 次启动失败，发送 Telegram 告警
- 集成到 server.mjs 的启动流程中

### C. 动态端口发现（改 agent-worker.mjs）
- 不再硬编码 `ws://127.0.0.1:18789`
- 每次连接前从 `~/.openclaw/openclaw.json` 读取最新端口
- 如果文件读取失败，回退到环境变量或默认值

### D. 前端降级提示优化（改前端 ChatContext）
- 当 Gateway 断开时，显示具体原因和预计恢复时间
- 添加"手动重连"按钮
- 在 Gateway 恢复后自动清除错误提示

## 开发顺序

A → C → B → D（先修核心连接逻辑，再加监控，最后优化前端）

## 风险评估

- **A+C 风险低** - 只修改重连逻辑，不影响正常连接流程
- **B 风险中** - 新增进程管理，需要测试 Gateway 重启场景
- **D 风险低** - 纯前端改动

## 备份策略

每个子步骤开始前备份，文件名格式：`{filename}.backup.iter2.{step}.{timestamp}`
