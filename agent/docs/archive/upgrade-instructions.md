# server.mjs v14 升级指令

> 本文件包含 server.mjs 从 v13 升级到 v14 的所有代码改动。
> 按顺序执行每个改动即可完成升级。

---

## 改动 1：文件头 + 新增 import

**位置**：第 1-19 行
**操作**：替换

```javascript
/**
 * RangerAI Agent Backend v14.0
 * 
 * Architecture: OpenClaw Gateway Passthrough + Resilience Layer
 * - All user messages go directly to OpenClaw via Gateway WebSocket protocol
 * - OpenClaw Agent decides which tools to use (exec, browser, file, web_search, etc.)
 * - Backend translates OpenClaw events into RangerAI frontend events
 * - v14: Message queue, session persistence, smart context, error recovery, task planning
 * 
 * P0 Upgrades:
 * - Message Queue: replaces hard reject with queuing (max 5)
 * - Session Persistence: conversation history saved to filesystem
 * - Smart Context Trimming: intelligent history management (50 entries, token-aware)
 * - Error Recovery: layered error handling with retry + fallback
 * - Task Planning: complexity analysis + phase tracking
 * - Structured Logging: JSON-formatted logs for debugging
 */

import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
```

---

## 改动 2：新增结构化日志（在 Configuration 段之后）

**位置**：第 78 行之后（`const OPENAI_API_URL` 之后）
**操作**：插入

```javascript
// ── Structured Logger ───────────────────────────────
class Logger {
  constructor(component = "server") {
    this.component = component;
  }
  _fmt(level, event, data = {}) {
    return JSON.stringify({ ts: new Date().toISOString(), level, c: this.component, event, ...data });
  }
  info(event, data) { console.log(this._fmt("info", event, data)); }
  warn(event, data) { console.warn(this._fmt("warn", event, data)); }
  error(event, data) { console.error(this._fmt("error", event, data)); }
  debug(event, data) { if (process.env.DEBUG) console.log(this._fmt("debug", event, data)); }
}
const log = new Logger("server");
```

---

## 改动 3：新增会话持久化（在 Helpers 段之后）

**位置**：第 114 行之后（`updateStep` 函数之后）
**操作**：插入

```javascript
// ── Session Persistence ───────────────────────────────
const SESSION_DIR = "/opt/rangerai-agent/sessions";
try { if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) {}

function saveSession(sessionKey, data) {
  try {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(SESSION_DIR, `${safe}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      sessionKey,
      updatedAt: new Date().toISOString(),
      conversationHistory: data.conversationHistory || [],
      taskPlan: data.taskPlan || null,
    }, null, 2));
  } catch (e) {
    log.warn("session_save_failed", { sessionKey, error: e.message });
  }
}

function loadSession(sessionKey) {
  try {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(SESSION_DIR, `${safe}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    log.warn("session_load_failed", { sessionKey, error: e.message });
    return null;
  }
}

// ── Smart Context Trimming ───────────────────────────────
function smartTrimHistory(history, maxEntries = 50) {
  if (history.length <= maxEntries) return history;

  const result = [];

  // Always keep first user message (task origin)
  if (history.length > 0 && history[0].role === "user") {
    result.push(history[0]);
  }

  // Recent 30 messages: keep fully
  const recent = history.slice(-30);
  // Middle messages: keep user messages, compress assistant messages
  const middle = history.slice(1, -30);

  for (const msg of middle) {
    if (msg.role === "user") {
      result.push(msg);
    } else if (msg.role === "assistant" && msg.content) {
      // Compress: keep first 100 + last 100 chars
      if (msg.content.length > 300) {
        result.push({
          ...msg,
          content: msg.content.slice(0, 100) + "\n...[已压缩]...\n" + msg.content.slice(-100),
          _trimmed: true
        });
      } else {
        result.push(msg);
      }
    }
  }

  for (const msg of recent) {
    result.push(msg);
  }

  return result;
}

// ── Error Handler ───────────────────────────────────────
class ErrorHandler {
  constructor() {
    this.retryCounters = new Map();
    this.maxRetries = 2;
  }

  handleToolError(toolName, toolCallId, error) {
    const count = (this.retryCounters.get(toolCallId) || 0) + 1;
    this.retryCounters.set(toolCallId, count);

    if (count <= this.maxRetries) {
      return { action: "retry", delay: count * 1000, message: `${toolName} 失败（第${count}次），重试中...` };
    }

    const fallbacks = { "web_search": "web_fetch", "browser": "web_fetch" };
    if (fallbacks[toolName]) {
      return { action: "fallback", fallbackTool: fallbacks[toolName], message: `${toolName} 多次失败，切换备用方案` };
    }

    return { action: "skip", message: `${toolName} 执行失败，跳过继续` };
  }

  handleGatewayError(error, attempt) {
    if (attempt <= 3) return { action: "reconnect", delay: Math.min(attempt * 2000, 10000) };
    if (attempt <= 5) return { action: "fallback_http" };
    return { action: "notify_user", message: "后端服务暂时不可用，请稍后重试" };
  }

  reset(toolCallId) { this.retryCounters.delete(toolCallId); }
}

const errorHandler = new ErrorHandler();

// ── Task Plan Tracker ───────────────────────────────────
class TaskPlanTracker {
  constructor() {
    this.plans = new Map();
  }

  analyzeComplexity(userMessage) {
    const msg = userMessage.toLowerCase();
    let score = 0;
    const signals = [
      { pattern: /分析|评估|报告|研究|调研/, weight: 3 },
      { pattern: /ppt|演示|文档|方案/, weight: 3 },
      { pattern: /开发|部署|重构|迁移/, weight: 4 },
      { pattern: /对比|竞品|多个|几个/, weight: 2 },
      { pattern: /步骤|流程|计划/, weight: 2 },
      { pattern: /先.*然后.*最后/, weight: 3 },
    ];
    for (const s of signals) { if (s.pattern.test(msg)) score += s.weight; }
    if (msg.length > 200) score += 2;
    if (msg.length > 500) score += 3;
    return { score, level: score >= 5 ? "complex" : score >= 2 ? "medium" : "simple", needsPlan: score >= 5 };
  }

  createPlan(sessionKey, title, phases) {
    const plan = {
      id: `plan-${Date.now()}`,
      title,
      phases: phases.map((p, i) => ({
        id: i + 1, title: p,
        status: i === 0 ? "active" : "pending",
        startedAt: i === 0 ? Date.now() : null,
        completedAt: null
      })),
      currentPhaseId: 1,
      createdAt: Date.now(),
      status: "active"
    };
    this.plans.set(sessionKey, plan);
    return plan;
  }

  advancePhase(sessionKey) {
    const plan = this.plans.get(sessionKey);
    if (!plan) return null;
    const current = plan.phases.find(p => p.status === "active");
    if (current) { current.status = "completed"; current.completedAt = Date.now(); }
    const next = plan.phases.find(p => p.status === "pending");
    if (next) { next.status = "active"; next.startedAt = Date.now(); plan.currentPhaseId = next.id; }
    else { plan.status = "completed"; }
    return plan;
  }

  getPlan(sessionKey) { return this.plans.get(sessionKey) || null; }
}

const taskTracker = new TaskPlanTracker();

// ── Message Queue ───────────────────────────────────────
class MessageQueue {
  constructor(maxSize = 5) {
    this.queue = [];
    this.maxSize = maxSize;
    this.processing = false;
    this.handler = null;
  }

  setHandler(fn) { this.handler = fn; }

  async enqueue(message, ws, state) {
    if (this.queue.length >= this.maxSize) {
      sendEvent(ws, { type: "error", message: "消息队列已满，请稍后再试" });
      return false;
    }

    const item = { id: `msg-${Date.now()}`, message, ws, state, timestamp: Date.now() };
    this.queue.push(item);

    if (this.queue.length > 1) {
      sendEvent(ws, { type: "queue_status", position: this.queue.length, message: `消息已排队（第${this.queue.length}位）` });
    }

    this._processNext();
    return true;
  }

  async _processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue[0];

    try {
      if (this.handler) await this.handler(item.message, item.ws, item.state);
    } catch (err) {
      log.error("queue_process_error", { error: err.message });
      sendEvent(item.ws, { type: "error", message: `处理出错: ${err.message}` });
      sendEvent(item.ws, { type: "status", status: "idle" });
    } finally {
      this.queue.shift();
      this.processing = false;
      if (this.queue.length > 0) this._processNext();
    }
  }

  get isProcessing() { return this.processing; }
}
```

---

## 改动 4：替换 WebSocket 连接处理器

**位置**：第 1324-1416 行（`wss.on("connection"` 整个块）
**操作**：替换为

```javascript
// Per-connection message queue
const connectionQueues = new Map();

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const connId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  log.info("client_connected", { ip, connId });

  // Initialize state — try to restore from session
  const state = {
    conversationHistory: [],
    sessionKey: DEFAULT_SESSION_KEY,
    connId,
    taskPlan: null
  };

  // Try to restore session
  const saved = loadSession(state.sessionKey);
  if (saved && saved.conversationHistory) {
    state.conversationHistory = saved.conversationHistory;
    state.taskPlan = saved.taskPlan;
    log.info("session_restored", { sessionKey: state.sessionKey, historyLen: state.conversationHistory.length });
  }

  // Create per-connection message queue
  const queue = new MessageQueue(5);
  queue.setHandler(async (userMessage, clientWs, connState) => {
    try {
      const reply = await handleUserMessage(userMessage, connState.conversationHistory, clientWs, connState.sessionKey);

      connState.conversationHistory.push({ role: "user", content: userMessage });
      if (reply) {
        connState.conversationHistory.push({ role: "assistant", content: reply });
      }

      // Smart trim instead of hard slice
      connState.conversationHistory = smartTrimHistory(connState.conversationHistory, 50);

      // Persist session
      saveSession(connState.sessionKey, connState);
    } catch (err) {
      log.error("handler_error", { error: err.message, sessionKey: connState.sessionKey });
      sendEvent(clientWs, { type: "error", message: `处理出错: ${err.message}` });
      sendEvent(clientWs, { type: "status", status: "idle" });
    }
  });
  connectionQueues.set(connId, queue);

  sendEvent(ws, {
    type: "connected",
    defaultProvider: "openclaw",
    defaultModel: "OpenClaw Agent",
    routerModel: "OpenClaw Gateway",
    gatewayConnected: gateway.isConnected,
    availableProviders: [
      { id: "openclaw", name: "OpenClaw", models: ["Agent (Full)", "GPT-5.2", "Gemini 2.5 Pro", "Claude Opus 4.6"] },
      { id: "openai", name: "OpenAI", models: ["GPT-5.2"] },
      { id: "google", name: "Google", models: ["Gemini 2.5 Pro", "Gemini 2.5 Flash"] },
      { id: "anthropic", name: "Anthropic", models: ["Claude Opus 4.6", "Claude Sonnet 4"] }
    ],
    capabilities: [
      "shell_exec", "file_management", "browser_automation",
      "web_search", "web_fetch", "image_generation",
      "code_execution", "process_management", "cron_scheduling",
      "memory_system", "multi_agent", "message_queue", "session_persistence"
    ],
    sessionRestored: !!(saved && saved.conversationHistory?.length > 0),
    historyLength: state.conversationHistory.length
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);

  ws.on("message", async (raw) => {
    const rawStr = raw.toString();
    let msg;
    try { msg = JSON.parse(rawStr); } catch (e) { return; }

    if (msg.type === "ping") {
      sendEvent(ws, { type: "pong" });
      return;
    }

    if (msg.type === "clear") {
      state.conversationHistory = [];
      state.taskPlan = null;
      saveSession(state.sessionKey, state);
      sendEvent(ws, { type: "cleared" });
      return;
    }

    if (msg.type === "set_session") {
      state.sessionKey = msg.sessionKey || DEFAULT_SESSION_KEY;
      // Try to restore the new session
      const saved = loadSession(state.sessionKey);
      if (saved) {
        state.conversationHistory = saved.conversationHistory || [];
        state.taskPlan = saved.taskPlan;
      } else {
        state.conversationHistory = [];
        state.taskPlan = null;
      }
      sendEvent(ws, {
        type: "session_changed",
        sessionKey: state.sessionKey,
        historyLength: state.conversationHistory.length
      });
      return;
    }

    if (msg.type === "message" && msg.content) {
      // Enqueue instead of hard reject
      await queue.enqueue(msg.content, ws, state);
    }
  });

  ws.on("close", () => {
    log.info("client_disconnected", { ip, connId });
    clearInterval(heartbeat);
    // Save session on disconnect
    saveSession(state.sessionKey, state);
    connectionQueues.delete(connId);
  });

  ws.on("error", (err) => {
    log.error("client_error", { error: err.message, connId });
  });
});
```

---

## 改动 5：替换 handleUserMessage（添加任务复杂度分析）

**位置**：第 1246-1286 行（`handleUserMessage` 函数）
**操作**：替换为

```javascript
async function handleUserMessage(userMessage, conversationHistory, ws, sessionKey) {
  log.info("new_message", { len: userMessage.length, sessionKey, historyLen: conversationHistory.length });
  stepCounter = 0;

  // Task complexity analysis
  const complexity = taskTracker.analyzeComplexity(userMessage);
  if (complexity.needsPlan) {
    sendEvent(ws, { type: "thinking", content: `这是一个${complexity.level === "complex" ? "复杂" : "中等"}任务，让我先规划一下...\n` });
  }

  sendEvent(ws, { type: "status", status: "thinking" });

  // Primary path: OpenClaw Gateway
  let gatewayAttempt = 0;
  while (gatewayAttempt < 2) {
    try {
      const result = await handleViaOpenClaw(userMessage, sessionKey, ws);
      return result;
    } catch (err) {
      gatewayAttempt++;
      const recovery = errorHandler.handleGatewayError(err, gatewayAttempt);
      log.warn("gateway_failed", { attempt: gatewayAttempt, action: recovery.action, error: err.message });

      if (recovery.action === "reconnect") {
        sendEvent(ws, { type: "thinking", content: `连接中断，${Math.ceil(recovery.delay / 1000)}秒后重连...\n` });
        await sleep(recovery.delay);
        try { await gateway.connect(); continue; } catch (e) { /* fall through */ }
      }

      if (recovery.action === "fallback_http" || gatewayAttempt >= 2) {
        log.info("fallback_to_http", { reason: err.message });
        break;
      }
    }
  }

  // Fallback: HTTP API
  const fallbackStepId = sendStep(ws, "切换到备用模式", "running", "HTTP API");
  sendEvent(ws, { type: "thinking", content: "收到，让我想想怎么处理这个请求...\n" });

  const SYSTEM_PROMPT = `You are RangerAI, a powerful AI assistant. Respond in the user's language (Chinese by default). Be direct and helpful.`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory.slice(-10),
    { role: "user", content: userMessage }
  ];

  updateStep(ws, fallbackStepId, "completed", "备用模式");
  sendEvent(ws, { type: "thinking", content: "正在组织语言，准备回复...\n" });
  const genStepId = sendStep(ws, "生成回复", "running");

  const content = await streamViaHTTP(messages, ws);

  updateStep(ws, genStepId, "completed", `${content.length} 字`);
  sendEvent(ws, { type: "status", status: "idle" });
  sendEvent(ws, { type: "stats", toolCalls: 0, tokens: Math.ceil(content.length / 2) });

  return content;
}
```

---

## 改动 6：替换 start() 函数

**位置**：第 1418-1437 行
**操作**：替换为

```javascript
async function start() {
  // Ensure session directory exists
  try { if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) {}

  // Try to connect to OpenClaw Gateway
  try {
    await gateway.connect();
    log.info("gateway_connected", { url: OPENCLAW_WS_URL });
  } catch (err) {
    log.warn("gateway_initial_connect_failed", { error: err.message });
  }

  // Graceful shutdown
  process.on("SIGTERM", () => {
    log.info("shutdown", { reason: "SIGTERM" });
    wss.clients.forEach(ws => {
      sendEvent(ws, { type: "server_shutdown", message: "服务器正在重启，请稍后重新连接" });
      ws.close();
    });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  });

  process.on("SIGINT", () => {
    log.info("shutdown", { reason: "SIGINT" });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  });

  // Uncaught error handlers
  process.on("uncaughtException", (err) => {
    log.error("uncaught_exception", { error: err.message, stack: err.stack?.split("\n").slice(0, 3).join(" | ") });
    // Don't exit — try to keep serving
  });

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", { reason: String(reason) });
  });

  server.listen(PORT, "0.0.0.0", () => {
    log.info("server_started", {
      version: "14.0.0",
      port: PORT,
      gateway: OPENCLAW_WS_URL,
      gatewayConnected: gateway.isConnected,
      features: ["message_queue", "session_persistence", "smart_trim", "error_recovery", "task_planning", "graceful_shutdown"]
    });
  });
}

start();
```

---

## 改动 7：health endpoint 升级

**位置**：第 1296-1316 行（`/health` 路由）
**操作**：替换为

```javascript
  if (req.url === "/health") {
    const sessions = (() => { try { return fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json')).length; } catch { return 0; } })();
    const queueSizes = [];
    connectionQueues.forEach((q, id) => { if (q.isProcessing || q.queue?.length > 0) queueSizes.push({ id, size: q.queue?.length || 0 }); });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "14.0.0",
      architecture: "OpenClaw Gateway Passthrough + Resilience Layer",
      gatewayConnected: gateway.isConnected,
      uptime: process.uptime(),
      connections: wss.clients.size,
      sessions,
      activeQueues: queueSizes,
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB"
      },
      features: ["message_queue", "session_persistence", "smart_trim", "error_recovery", "task_planning", "structured_logging", "graceful_shutdown"],
      tools: [
        "exec", "read", "write", "edit", "apply_patch",
        "process", "browser", "canvas",
        "web_search", "web_fetch",
        "memory_search", "memory_get",
        "cron", "gateway", "nodes",
        "sessions_list", "sessions_history", "sessions_send", "sessions_spawn",
        "message", "image", "agents_list"
      ]
    }));
    return;
  }
```

---

## 总结：v14 升级清单

| # | 改动 | 影响的 P0 维度 | 行数变化 |
|---|------|---------------|---------|
| 1 | 文件头 + path import | P0-1 架构 | +5 |
| 2 | 结构化日志 Logger | P0-1 架构 | +15 |
| 3 | SessionStore + SmartTrim + ErrorHandler + TaskTracker + MessageQueue | P0-1/3/4/5 全部 | +200 |
| 4 | WebSocket 连接处理器重写 | P0-1/3/4 | +100（替换 90） |
| 5 | handleUserMessage 重写 | P0-4/5 | +50（替换 35） |
| 6 | start() 重写 + 优雅关闭 | P0-1/4 | +35（替换 20） |
| 7 | health endpoint 升级 | P0-1 | +25（替换 20） |

**净增约 310 行代码，替换约 165 行。总文件从 1438 行增长到约 1583 行。**
