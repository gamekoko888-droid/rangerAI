// [v25.9.2] Global EPIPE protection — prevent uncaught EPIPE from crashing worker
process.stdout.on("error", (err) => { if (err.code === "EPIPE") return; });
process.stderr.on("error", (err) => { if (err.code === "EPIPE") return; });
// ─── RangerAI Agent Worker v3.0 (Modular) ─────────────────
// Entry point: env loading, singleton init, IPC routing.
// All business logic lives in handler modules.
// ─────────────────────────────────────────────────────────────

import { installConsoleBridge } from "../lib/console-bridge.mjs";
import { loadEnvFile, loadSecretsJson as loadSecretsJsonFromEnv } from "../lib/bootstrap.mjs";
import fs from "fs";
import { execSync } from "child_process";
import { GatewayConnector } from "../gateway-connector.mjs";
import { setCurrentSessionKey, clearRunTracking } from "./run-tracker.mjs";
import { CircuitBreaker } from "./circuit-breaker.mjs";
import { sendEvent, sendToMain } from "./ipc-utils.mjs";
import { handleDbResponse } from "./db-proxy.mjs";
import { sanitizeForFrontend, estimateTokens } from "./format-utils.mjs";
import { handleViaOpenClaw, cleanupOpenClawHandlerResources } from "./openclaw-handler.mjs";
import { handleUserMessage, _responseModeMap } from "./user-message-handler.mjs";
import { validateDownlink } from "../lib/schemas/ipc-schemas.mjs";
import { smartRouteWithStats, getRouteStats } from "./smart-router.mjs";
import { cleanupTaskEngineResources } from "./task-engine.mjs";
import { cleanupPlannerResources } from "./planner.mjs";
import { cleanupEventStream } from "./event-stream.mjs";
import { cleanupObservabilityResources } from "./observability.mjs";
import { cleanupHumanApprovalResources } from "./human-approval.mjs";
import { cleanupMemoryManagerResources } from "./memory-manager.mjs";
import { cleanupAdaptiveMemoryResources } from "./adaptive-memory.mjs";
import { cleanupProgressTrackerResources } from "./progress-tracker.mjs";

import { logger } from '../lib/logger.mjs';
// ─── Load env ────────────────────────────────────────────────

// F26: Install structured logging bridge for all console.log calls
installConsoleBridge();

// Unified env loading from lib/bootstrap.mjs (no more inline duplicates)
function loadSecretsJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch { return {}; }
}

const ENV_FILE = process.env.RANGERAI_ENV_FILE || "/opt/rangerai-agent/.env";
const SECRETS_FILE = process.env.RANGERAI_SECRETS_FILE || "/opt/rangerai-agent/agent-secrets.env";
const SECRETS_JSON = process.env.RANGERAI_SECRETS_JSON || "/opt/rangerai-agent/secrets.json";
loadEnvFile(ENV_FILE);
loadEnvFile(SECRETS_FILE);
const SECRETS = loadSecretsJson(SECRETS_JSON);

// ─── Configuration ──────────────────────────────────────────
const OPENCLAW_TOKEN = SECRETS.OPENCLAW_TOKEN || process.env.OPENCLAW_TOKEN;

function getLatestToken() {
  try {
    const config = JSON.parse(fs.readFileSync("/home/admin/.openclaw/openclaw.json", "utf-8"));
    return config?.gateway?.auth?.token || OPENCLAW_TOKEN;
  } catch {
    return OPENCLAW_TOKEN;
  }
}

if (!OPENCLAW_TOKEN) {
  logger.error("[worker] Missing OPENCLAW_TOKEN");
  process.exit(1);
}

const ts = () => new Date().toISOString();

let _workerResourcesCleaned = false;
function cleanupWorkerResources(reason = 'exit') {
  if (_workerResourcesCleaned) return;
  _workerResourcesCleaned = true;
  try { cleanupEventStream(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupEventStream failed: ${e.message}`); }
  try { cleanupOpenClawHandlerResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupOpenClawHandlerResources failed: ${e.message}`); }
  try { cleanupTaskEngineResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupTaskEngineResources failed: ${e.message}`); }
  try { cleanupPlannerResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupPlannerResources failed: ${e.message}`); }
  try { cleanupHumanApprovalResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupHumanApprovalResources failed: ${e.message}`); }
  try { cleanupMemoryManagerResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupMemoryManagerResources failed: ${e.message}`); }
  try { cleanupAdaptiveMemoryResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupAdaptiveMemoryResources failed: ${e.message}`); }
  try { cleanupObservabilityResources(); } catch (e) { logger.warn(`[${ts()}] [worker] cleanupObservabilityResources failed: ${e.message}`); }
  logger.info(`[${ts()}] [worker] cleanupWorkerResources done (${reason})`);
}

function exitWorker(code = 0, reason = 'exit') {
  cleanupWorkerResources(reason);
  process.exit(code);
}

// ─── Singletons ─────────────────────────────────────────────
const gatewayBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30000 });
const browserBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 300000,
  halfOpenMaxAttempts: 1
});

const gateway = new GatewayConnector({
  token: getLatestToken(),
  onConnected: () => {
    logger.info(`[${ts()}] [worker] Gateway connected (via GatewayConnector)`);
  },
  onDisconnected: () => {
    logger.info(`[${ts()}] [worker] Gateway disconnected (will auto-reconnect)`);
  },
  // RCA improvement #4: Reset circuit breaker on Gateway reconnect
  onReconnected: () => {
    logger.info(`[${ts()}] [worker] Gateway reconnected — resetting circuit breakers`);
    gatewayBreaker.forceReset("gateway_reconnected");
    // Notify parent process so WS can inform connected clients
    try {
      process.send({ type: "gateway_reconnected", ts: Date.now() });
    } catch (e) { /* parent may not be listening */ }
  },
  onStatusChange: (status) => {
    if (status.reconnect?.attempts > 0 && status.reconnect.attempts % 5 === 0) {
      logger.info(`[${ts()}] [worker] Gateway reconnect status: attempt ${status.reconnect.attempts}, phase ${status.reconnect.phase}, lastError: ${status.reconnect.lastErrorType}`);
    }
  },
  onMessage: (msg) => {
    if (msg.type === "event" && (msg.event === "agent" || msg.event === "chat")) {
      const runId = msg.payload?.runId || "unknown";
      const p = msg.payload;
      const stream = p?.stream;
      const data = p?.data;
      
      // Only process announce-triggered runs (runId starts with "announce:")
      if (typeof runId === "string" && runId.startsWith("announce:")) {
        logger.info(`[${ts()}] [worker] [ANNOUNCE] Received: event=${msg.event} stream=${stream} state=${p?.state} runId=${runId}`);
        
        // Forward text stream events (stream=text OR stream=assistant, delta in data.delta)
        if (msg.event === "agent" && (stream === "text" || stream === "assistant")) {
          const delta = data?.delta || data?.text || "";
          if (delta) {
            logger.info(`[${ts()}] [worker] [ANNOUNCE] Text delta: ${delta.substring(0, 100)} (${delta.length} chars)`);
            try {
              process.send({
                type: "announce_event",
                runId,
                event: { type: "thinking", content: delta }
              });
            } catch (e) { /* parent may not be listening */ }
          }
        }
        
        // Forward lifecycle events
        if (msg.event === "agent" && stream === "lifecycle") {
          const phase = data?.phase;
          logger.info(`[${ts()}] [worker] [ANNOUNCE] Lifecycle: phase=${phase} runId=${runId}`);
          if (phase === "end") {
            try {
              process.send({
                type: "announce_complete",
                runId,
                event: { type: "announce_complete", runId }
              });
            } catch (e) { /* parent may not be listening */ }
          }
        }
        
        // Forward chat:final (p.state === "final", text in p.message.content)
        if (msg.event === "chat" && p?.state === "final") {
          // Skip gateway-injected directive ack events
          const msgModel = p.message?.model || "";
          if (msgModel === "gateway-injected") {
            logger.info(`[${ts()}] [worker] [ANNOUNCE] Skipping gateway-injected chat:final`);
            return;
          }
          const content = p.message?.content;
          let text = "";
          if (Array.isArray(content)) {
            text = content.filter(c => c.type === "text").map(c => c.text).join("");
          } else if (typeof content === "string") {
            text = content;
          }
          logger.info(`[${ts()}] [worker] [ANNOUNCE] chat:final received: ${text.substring(0, 200)} (${text.length} chars)`);
          try {
            process.send({
              type: "announce_final",
              runId,
              text,
              event: { type: "announce_final", content: text, runId }
            });
          } catch (e) { /* parent may not be listening */ }
        }
      } else {
        logger.info(`[${ts()}] [worker] [UNREGISTERED] Non-announce event: event=${msg.event} stream=${stream} runId=${runId}`);
      }
    }
  }
});

// ─── Drain mode flag ─────────────────────────────────────────
let _draining = false;
const _taskAborts = new Map();  // msgId → AbortController (v10.0 multi-task)

let _activeTaskCount = 0;

// Shared deps object passed to all handlers
const deps = { gateway, gatewayBreaker, browserBreaker };

// ─── IPC Message Handler ────────────────────────────────────
process.on("message", async (msg) => {
  // IPC Schema validation (warn-only, never blocks)
  const _dv = validateDownlink(msg);
  if (!_dv.success) {
    logger.warn(`[${ts()}] [IPC] Downlink schema mismatch for type="${msg?.type}": ${_dv.error.issues.map(i => i.path.join('.') + ': ' + i.message).join(', ')}`);
  }
  try {
    // DB query response (Phase 1: Worker DB decoupling via IPC proxy)
    if (handleDbResponse(msg)) return;

    // Gateway API proxy
    if (msg.type === "gateway_api_request") {
      const { reqId, method, params } = msg;
      try {
        if (!gateway.isConnected) await gateway.connect();
        const result = await gateway.request(method, params || {});
        process.send({ type: "gateway_api_response", reqId, result, ok: true });
      } catch (err) {
        process.send({ type: "gateway_api_response", reqId, error: err.message, ok: false });
      }
      return;
    }

    // User message
    if (msg.type === "user_message") {
      const { id, sessionKey, content, conversationHistory, model: userModel, attachments, roleSystemPrompt, traceId, chatId, userId, userRole } = msg;
      
      // Iter-60: Set logger context for the duration of this task
      if (typeof logger !== "undefined" && logger.setContext) {
        logger.setContext({ traceId, msgId: id });
      }
      
      _activeTaskCount++;
      try {
        if (_draining) {
          logger.info(`[${ts()}] [worker] Rejecting new task ${id} — drain mode active`);
          sendEvent(id, { type: "error", message: "AI 引擎正在重启，请稍后重试" });
          sendEvent(id, { type: "status", status: "idle" });
          process.send({ type: "task_error", msgId: id, error: "Worker draining" });
          _activeTaskCount--;
          if (_activeTaskCount === 0) {
            logger.info(`[${ts()}] [worker] Drain complete, exiting`);
            exitWorker(0, 'graceful_exit');
          }
          return;
        }
        const taskAbort = new AbortController();
        _taskAborts.set(id, taskAbort);
        setCurrentSessionKey(sessionKey);
        const routeResult = await smartRouteWithStats(content, attachments, userModel, sessionKey);
        const resolvedModel = routeResult.model;
        logger.info(`[${ts()}] [smart-router] "${(content||"").slice(0,40)}..." → ${resolvedModel} (category: ${routeResult.category}, reason: ${routeResult.reason}, user_pref: ${userModel||"auto"})`);
        const result = await handleUserMessage(id, content, conversationHistory || [], sessionKey, userModel, attachments, msg.roleSystemPrompt, { ...deps, userId, userRole, routeResult });
        _taskAborts.delete(id);
        clearRunTracking(sessionKey);
        sendEvent(id, { type: "status", status: "idle" });
        // F8: Return model+tokens for cost tracking
        const estTokens = typeof result === 'string' ? estimateTokens(result) : null;
        const _rMode = _responseModeMap.get(id) || 'default'; _responseModeMap.delete(id); // Iter-U
        process.send({ type: "task_complete", msgId: id, result, model: resolvedModel || userModel || "unknown", tokens: estTokens, routeCategory: routeResult.category, responseMode: _rMode });
        _activeTaskCount--;
        if (_draining && _activeTaskCount === 0) {
          logger.info(`[${ts()}] [worker] Drain complete after task ${id}, exiting`);
          exitWorker(0, 'graceful_exit');
        }
      } catch (err) {
        logger.error(`[${ts()}] [worker] Task ${id} error: ${err.message}`);
        _taskAborts.delete(id);
        clearRunTracking(sessionKey);
        sendEvent(id, { type: "error", message: sanitizeForFrontend(err.message) });
        sendEvent(id, { type: "status", status: "idle" });
        process.send({ type: "task_error", msgId: id, error: err.message });
        _activeTaskCount--;
        if (_draining && _activeTaskCount === 0) {
          logger.info(`[${ts()}] [worker] Drain complete after task ${id} error, exiting`);
          exitWorker(0, 'graceful_exit');
        }
      }
      return;
    }

    if (msg.type === "tool_confirm_response") {
      const { confirmId, approved } = msg;
      logger.info(`[${ts()}] [worker] Received tool_confirm_response: ${confirmId} → ${approved ? 'approved' : 'rejected'}`);
      // The orchestrator is per-task and lives inside handleViaOpenClaw.
      // We need to broadcast this to the active task via a global event emitter.
      // Use process-level event for simplicity since worker is single-threaded.
      process.emit('tool_confirm_response', { confirmId, approved });
      return;
    }

    // Cancel task — abort current Gateway run
    if (msg.type === "cancel_task") {
      const { msgId } = msg;
      logger.info(`[${ts()}] [worker] Received cancel_task for ${msgId}`);
      const taskAbortCtrl = _taskAborts.get(msg.msgId);
      if (taskAbortCtrl) {
        taskAbortCtrl.abort();
        _taskAborts.delete(msg.msgId);
        logger.info(`[${ts()}] [worker] AbortController signaled for task ${msgId}`);
      }
      if (gateway.isConnected) {
        const { getCurrentRunId: _getRunId, getCurrentSessionKey: _getSK } = await import("./run-tracker.mjs");
        const sk = msg.sessionKey || _getSK() || "agent:main:main";
        const rid = _getRunId(sk);
        try {
          if (rid) {
            await gateway.request("chat.abort", { sessionKey: sk, runId: rid });
            logger.info(`[${ts()}] [worker] [v9.0] Gateway chat.abort sent for runId=${rid}`);
          } else {
            await gateway.abortChat(sk);
            logger.info(`[${ts()}] [worker] Gateway chat.abort sent for session (no runId)`);
          }
        } catch (err) {
          logger.info(`[${ts()}] [worker] Gateway chat.abort failed: ${err.message}`);
        }
        clearRunTracking(sk);
      }
      return;
    }
    // User interrupt
    if (msg.type === "user_interrupt") {
      const { content, timestamp } = msg;
      logger.info(`[${ts()}] [worker] Received user_interrupt: "${(content || "").slice(0, 80)}"`);
      if (gateway.isConnected) {
        try {
          const interruptKey = `interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          await gateway.request("chat.send", {
            sessionKey: msg.sessionKey || "agent:main:main",
            message: `[用户补充指令] ${content}`,
            deliver: false,
            idempotencyKey: interruptKey
          }, 30000);
          logger.info(`[${ts()}] [worker] Interrupt forwarded to Gateway via chat.send`);
        } catch (err) {
          logger.info(`[${ts()}] [worker] Failed to forward interrupt: ${err.message}`);
        }
      } else {
        logger.info(`[${ts()}] [worker] Gateway not connected, cannot forward interrupt`);
      }
      return;
    }

    // Ping/pong
    if (msg.type === "ping") {
      process.send({ type: "pong", id: msg.id, pid: process.pid, gatewayConnected: gateway.isConnected });
      return;
    }

    // Drain mode — stop accepting new tasks, wait for current to finish
    if (msg.type === "drain") {
      _draining = true;
      logger.info(`[${ts()}] [worker] Drain mode activated, will exit after current tasks complete`);
      if (_activeTaskCount === 0) {
        logger.info(`[${ts()}] [worker] No active tasks, exiting immediately`);
        exitWorker(0, 'graceful_exit');
      }
      return;
    }
    // Shutdown
    if (msg.type === "shutdown") {
      logger.info(`[${ts()}] [worker] Shutdown requested`);
      if (_activeTaskCount > 0) {
        logger.info(`[${ts()}] [worker] ${_activeTaskCount} active task(s), entering drain before exit`);
        _draining = true;
        return;
      }
      exitWorker(0, 'graceful_exit');
    }

    // Browser recovery
    if (msg.type === "recover_browser") {
      logger.info(`[${ts()}] [worker] HARD Browser recovery (killing Chromium processes)`);
      try {
        try { execSync("sudo pkill -u admin -f chromium 2>/dev/null || true"); } catch(e) { /* v22.0 */ logger.error("[index] silent catch:", e?.message || e); }
        try { execSync("sudo pkill -u admin -f chrome 2>/dev/null || true"); } catch(e) { /* v22.0 */ logger.error("[index] silent catch:", e?.message || e); }
        try { execSync("sudo pkill -u admin -f Playwright 2>/dev/null || true"); } catch(e) { /* v22.0 */ logger.error("[index] silent catch:", e?.message || e); }
        logger.info(`[${ts()}] [worker] Killed browser processes, subsystem will auto-reinit on next tool call`);
      } catch (err) {
        logger.error(`[${ts()}] [worker] Browser recovery error: ${err.message}`);
      }
    }
    
    // Browser breaker status
    if (msg.type === "get_browser_status") {
      process.send({
        type: "browser_status",
        reqId: msg.reqId,
        status: browserBreaker.getStatus(),
        gatewayConnected: gateway.isConnected
      });
      return;
    }
    
    // Reset browser breaker
    if (msg.type === "reset_browser_breaker") {
      logger.info(`[${ts()}] [worker] Admin requested browser breaker reset (was: ${browserBreaker.state})`);
      browserBreaker.reset();
      try {
        try { execSync("sudo pkill -u admin -f chromium 2>/dev/null"); } catch(e) { /* v22.0 */ logger.error("[index] silent catch:", e?.message || e); }
        logger.info(`[${ts()}] [worker] Browser breaker RESET + chromium killed`);
      } catch (err) { /* ignore */ }
      process.send({ type: "browser_breaker_reset", reqId: msg.reqId, ok: true });
      return;
    }
  } catch (err) {
    logger.error(`[${ts()}] [worker] Unhandled IPC message error: ${err.message}`);
  }
});

// ─── Worker Startup ─────────────────────────────────────────
async function init() {
  logger.info(`[${ts()}] [worker] Agent Worker v3.0 (modular) starting (PID: ${process.pid})`);
  
  try {
    await gateway.connect();
    logger.info(`[${ts()}] [worker] Gateway connected`);
  } catch (err) {
    logger.info(`[${ts()}] [worker] Gateway initial connect failed: ${err.message} (will retry)`);
  }
  
  process.send({ type: "worker_ready", pid: process.pid, gatewayConnected: gateway.isConnected });
  logger.info(`[${ts()}] [worker] Ready and waiting for tasks`);
}

init().catch(err => {
  logger.error(`[${ts()}] [worker] Init failed: ${err.message}`);
  process.exit(1);
});

// Handle uncaught errors gracefully
process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.message?.includes("EPIPE")) return; // [v25.9.2] Suppress EPIPE
  logger.error(`[${ts()}] [worker] Uncaught exception: ${err.message}`);
  logger.error(err.stack);
  if (err.message.includes("FATAL") || err.message.includes("out of memory")) {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  logger.error(`[${ts()}] [worker] Unhandled rejection: ${reason}`);
});

// ─── [R95] Graceful shutdown cleanup ────────────────────────
async function cleanupAll() {
  logger.info(`[${ts()}] [worker] Graceful shutdown: cleaning up all resources...`);
  try {
    cleanupTaskEngineResources();
    cleanupPlannerResources();
    cleanupEventStream();
    cleanupObservabilityResources();
    cleanupHumanApprovalResources();
    cleanupMemoryManagerResources();
    cleanupAdaptiveMemoryResources();
    cleanupProgressTrackerResources();
    cleanupOpenClawHandlerResources();
  } catch (err) {
    logger.error(`[${ts()}] [worker] Cleanup error (non-fatal): ${err.message}`);
  }
  logger.info(`[${ts()}] [worker] Cleanup complete, exiting.`);
  process.exit(0);
}

process.on("SIGTERM", () => {
  logger.info(`[${ts()}] [worker] Received SIGTERM`);
  cleanupAll();
});

process.on("SIGINT", () => {
  logger.info(`[${ts()}] [worker] Received SIGINT`);
  cleanupAll();
});
