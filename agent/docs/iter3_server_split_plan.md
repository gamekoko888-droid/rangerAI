# 第三轮迭代：server.mjs 模块拆分方案

## 1. 问题分析

`server.mjs` 当前 3,871 行，是整个 RangerAI 的核心单体文件。它包含了：
- Express HTTP 服务器
- WebSocket 服务器
- Worker 进程管理
- AI 功能（摘要、标题、建议生成）
- OpenClaw 配置发现
- 文件管理 API
- 健康检查 API
- 会话持久化
- 自愈机制
- 信号处理

**每次修改任何一个功能都要触碰这个文件，风险极高。**

## 2. 拆分原则

1. **保持 server.mjs 作为入口文件**（编排者），但把业务逻辑拆到独立模块
2. **每个模块导出纯函数或类**，不依赖全局变量
3. **共享状态通过依赖注入**（传入 app, wss, worker 等）
4. **拆分后的模块可以独立测试**
5. **渐进式拆分**：每次拆一个模块，验证后再拆下一个

## 3. 拆分方案（按优先级排序）

### 模块 A: `ai-services.mjs` (约 200 行)
**来源：** 行 500-692
**内容：**
- `summarizeHistory()` — AI 历史摘要
- `generateTitle()` — AI 标题生成
- `generateSuggestions()` — AI 跟进建议生成

**依赖：** Gateway URL/Token（通过参数传入）
**风险：** 低（纯函数，无状态）

### 模块 B: `openclaw-discovery.mjs` (约 200 行)
**来源：** 行 249-438
**内容：**
- `SKILL_DISPLAY_MAP` 常量
- `getAvailableSkills()` — 技能发现
- `getAvailableTools()` — 工具发现
- `getSystemCapabilities()` — 能力发现
- `getAvailableProviders()` — Provider 发现

**依赖：** OPENCLAW_CONFIG_PATH（常量）
**风险：** 低（只读操作，有缓存）

### 模块 C: `worker-manager.mjs` (约 550 行)
**来源：** 行 922-1643
**内容：**
- Worker 进程 fork/kill/restart
- Worker 消息处理（pong, worker_ready, task_complete 等）
- Gateway API 代理
- Worker 健康检查

**依赖：** WORKER_PATH, 配置常量, activeTasksBySession
**风险：** 中（涉及进程管理，需要仔细处理状态传递）

### 模块 D: `ws-handler.mjs` (约 800 行)
**来源：** 行 2876-3776
**内容：**
- WebSocket 连接处理
- bind_chat 逻辑
- send_message 处理
- Gateway API 代理处理
- 消息持久化

**依赖：** worker, database, sessions Map
**风险：** 高（核心消息流，需要最仔细的测试）

### 模块 E: `http-routes.mjs` (约 900 行)
**来源：** 行 1822-2875
**内容：**
- Health check API
- Provider health check
- File API
- Polling API
- Static file serving
- Admin UI

**依赖：** app (Express), worker, database
**风险：** 中（路由多但逻辑独立）

### 模块 F: `self-heal.mjs` (约 100 行)
**来源：** 行 1644-1759
**内容：**
- isProcessing 卡住检测
- activeTasksBySession 清理
- Worker 崩溃恢复

**依赖：** sessions Map, worker
**风险：** 低（定时器逻辑）

### 模块 G: `file-handler.mjs` (约 100 行)
**来源：** 行 443-499
**内容：**
- `expandFileAttachments()` — 文件附件内容注入
- TEXT_EXTENSIONS 常量

**依赖：** FILES_DIR 常量
**风险：** 低（纯函数）

## 4. 开发顺序

**Phase 1（低风险热身）：** A → B → F → G
**Phase 2（中风险核心）：** C → E
**Phase 3（高风险核心）：** D

每个模块拆分后立即重启验证，确保功能正常。

## 5. 拆分后的 server.mjs 结构

```javascript
// server.mjs — 入口编排文件（约 500 行）
import { summarizeHistory, generateTitle, generateSuggestions } from "./ai-services.mjs";
import { getAvailableSkills, getAvailableTools, getSystemCapabilities, getAvailableProviders } from "./openclaw-discovery.mjs";
import { WorkerManager } from "./worker-manager.mjs";
import { setupWsHandler } from "./ws-handler.mjs";
import { setupHttpRoutes } from "./http-routes.mjs";
import { startSelfHeal } from "./self-heal.mjs";
import { expandFileAttachments } from "./file-handler.mjs";

// 共享状态
const sessions = new Map();
const activeTasksBySession = new Map();
const toolMetadataByMsgId = new Map();

// 初始化
const workerManager = new WorkerManager({ ... });
setupHttpRoutes(app, { workerManager, ... });
setupWsHandler(wss, { workerManager, sessions, ... });
startSelfHeal({ sessions, workerManager, ... });
```

## 6. 备份策略

每个模块拆分前：
```bash
cp server.mjs ~/backups/server.mjs.bak-YYYYMMDD_HHMMSS-before-split-X
```

## 7. 关键问题需要 Ranger 确认

1. **拆分顺序是否合理？** 先低风险后高风险
2. **共享状态（sessions, activeTasksBySession）如何传递？** 建议依赖注入
3. **拆分粒度是否合适？** 7 个模块是否太多或太少
4. **是否需要保留 event-buffer 逻辑在 server.mjs 中？** （行 693-921，约 230 行，涉及复杂的事件缓冲和 WebSocket 推送）
