/**
 * ws-handler.mjs — WebSocket Connection Manager & Message Dispatcher
 * v5.1 (Iter-61): Increased heartbeat tolerance for mobile background tabs.
 *   - Heartbeat interval: 30s → 45s
 *   - Missed pings threshold: 2 → 4 (= ~180s tolerance before terminate)
 *   - Reason: Mobile browsers suspend JS when app is backgrounded,
 *     causing pong misses that falsely trigger disconnection.
 *
 * v5.0 (Iter-56): Pure dispatch layer — all handling logic extracted to:
 *   - ws-control-handlers.mjs (bind, recover, cancel, reset, etc.)
 *   - ws-chat-handlers.mjs (sendMessage, title/suggestion gen, history compression)
 *
 * This module is responsible ONLY for:
 *   1. Connection lifecycle (auth, heartbeat, session init, close)
 *   2. Message routing (dispatch incoming messages to the correct handler)
 *
 * @module ws-handler
 */

import { logger } from '../lib/logger.mjs';
import crypto from "crypto";
import { WebSocket } from "ws";
import { ts } from "./helpers.mjs";
import { validateDeps } from "../lib/context.mjs";
import metrics from '../lib/metrics-collector.mjs';

// Handler modules
import { initChatHandlers, handleSendMessage, handleDisconnectGracePeriod } from './ws-chat-handlers.mjs';
import { getUserById } from "../services/user-service.mjs";
import {
  initControlHandlers,
  handleBindChat, handleRecoverTask, handleStatusUpdate,
  handleForceReset, handleCancel, handleGatewayApi,
  handleAbortTask, handleSetSession, handleUserInterrupt,
} from './ws-control-handlers.mjs';

// v14.1: Import drainPendingAnnounces from worker-manager (was missing, causing warning on every WS connect)
import { drainPendingAnnounces } from './worker-manager.mjs';

// ─── Required deps fields (fail-fast on missing) ────────────
const REQUIRED_DEPS = [
  // services
  'auth', 'rateLimiter', 'monitor', 'taskStore',
  // runtime
  'workerManager', 'eventBuffer',
  'sessions', 'wsClients', 'activeTasksBySession', 'toolMetadataByMsgId',
  // db
  'getChatBySessionKey', 'getChatById', 'createMessage',
  'updateChatTitle', 'getConversationHistory', 'verifyToken',
  // config
  'DEFAULT_SESSION_KEY', 'HISTORY_LIMIT', 'MAX_TASK_DURATION',
  // pure functions
  'sendEvent', 'smartReplayEvents', 'loadSession', 'saveSession',
  'expandFileAttachments', 'generateTitle', 'generateSuggestions', 'generateHistorySummary',
  'getAvailableProviders', 'getAvailableSkills', 'getAvailableTools', 'getSystemCapabilities',
  'inlineFallback',
];

/** @type {WsHandlerDeps} */
let deps = {};

/**
 * Initialize the ws-handler module with injected dependencies.
 * Propagates deps to all sub-handler modules.
 *
 * @param {WsHandlerDeps} dependencies
 * @throws {Error} If any required dep is missing or null
 */
export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'ws-handler');
  deps = dependencies;

  // Propagate to handler modules
  initChatHandlers(dependencies);
  initControlHandlers(dependencies);
}

/**
 * @typedef {object} WsHandlerDeps
 * @property {object}  auth                   - Auth service (validateWsToken, etc.)
 * @property {object}  rateLimiter            - Rate limiter service
 * @property {object}  monitor               - Monitor/metrics service
 * @property {object}  taskStore             - Redis-backed task store
 * @property {object}  workerManager         - WorkerManager instance
 * @property {object}  eventBuffer           - EventBuffer instance
 * @property {Map}     sessions              - Map<ws, sessionState>
 * @property {Map}     wsClients             - Map<sessionKey, ws>
 * @property {Map}     activeTasksBySession  - Map<sessionKey, {msgId}>
 * @property {Map}     toolMetadataByMsgId   - Map<msgId, {tools, steps}>
 * @property {Function} getChatBySessionKey  - DB: look up chat by session key
 * @property {Function} getChatById          - DB: look up chat by id
 * @property {Function} createMessage        - DB: persist a message
 * @property {Function} updateChatTitle      - DB: update chat title
 * @property {Function} getConversationHistory - DB: fetch conversation history
 * @property {Function} verifyToken          - DB: verify a user token
 * @property {string}  DEFAULT_SESSION_KEY   - Fallback session key
 * @property {number}  HISTORY_LIMIT         - Max conversation history entries
 * @property {number}  MAX_TASK_DURATION     - Absolute task timeout (ms)
 * @property {Function} sendEvent            - Helper: send WS event to client
 * @property {Function} smartReplayEvents    - Helper: replay buffered events
 * @property {Function} loadSession          - Helper: load session from DB
 * @property {Function} saveSession          - Helper: persist session to DB
 * @property {Function} expandFileAttachments - Helper: expand file attachment refs
 * @property {Function} generateTitle        - AI: generate chat title
 * @property {Function} generateSuggestions  - AI: generate follow-up suggestions
 * @property {Function} generateHistorySummary - AI: summarize conversation history
 * @property {Function} getAvailableProviders - Discovery: list AI providers
 * @property {Function} getAvailableSkills   - Discovery: list available skills
 * @property {Function} getAvailableTools    - Discovery: list available tools
 * @property {Function} getSystemCapabilities - Discovery: system capabilities
 * @property {Function} inlineFallback       - AI: inline fallback handler
 */

// ═══════════════════════════════════════════════════════════════
// CONNECTION LIFECYCLE
// ═══════════════════════════════════════════════════════════════

// Heartbeat config — v5.1: increased tolerance for mobile background tabs
const HEARTBEAT_INTERVAL_MS = 45000;  // 45s (was 30s)
const MAX_MISSED_CLIENT_PINGS = 4;    // 4 misses × 45s = 180s tolerance (was 2 × 30s = 60s)

/**
 * Handle a new WebSocket connection.
 * Performs auth, rate limiting, session init, heartbeat, and wires message/close handlers.
 *
 * @param {WebSocket} ws
 * @param {http.IncomingMessage} req
 */
export function handleConnection(ws, req) {
  const {
    auth, rateLimiter, monitor, workerManager, eventBuffer,
    sessions, wsClients, activeTasksBySession,
    sendEvent, getAvailableProviders, getAvailableSkills,
    getAvailableTools, getSystemCapabilities,
    DEFAULT_SESSION_KEY, verifyToken,
  } = deps;

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  logger.info(`[${ts()}] Client connected: ${ip}`);

  // ── Auth ──
  const wsAuth = auth.validateWsToken(req, verifyToken);
  if (!wsAuth.valid) {
    logger.info(`[${ts()}] [auth] WS connection rejected for ${ip}: ${wsAuth.reason}`);
    ws.close(1008, JSON.stringify({ error: "auth_failed", reason: wsAuth.reason }));
    return;
  }

  // ── Rate Limiting ──
  const connCheck = rateLimiter.checkConnection(ip);
  if (!connCheck.allowed) {
    logger.info(`[${ts()}] [rate-limit] Connection rejected for ${ip}: ${connCheck.reason}`);
    ws.close(1008, JSON.stringify({ error: "rate_limited", reason: connCheck.reason }));
    return;
  }
  rateLimiter.addConnection(ip, ws);
  monitor.recordConnection("open", ip);

  // ── Session Init ──
  const uniqueSessionKey = "ranger-" + crypto.randomUUID();
  const state = {
    conversationHistory: [],
    isProcessing: false,
    sessionKey: uniqueSessionKey,
    titleGenerated: false,
    userId: wsAuth.userId || null,
    username: wsAuth.username || 'anonymous',
    userRole: wsAuth.role || 'member',
  };

  setTimeout(() => {
    try { sendEvent(ws, { type: "session_changed", sessionKey: uniqueSessionKey }); } catch (e) { logger.warn("[ws] session_changed send failed:", e.message); }
  }, 100);
  // v1.2: Drain any pending announce messages to the newly connected client
  setTimeout(() => {
    try {
      const drained = drainPendingAnnounces(ws, sendEvent);
      if (drained > 0) {
        logger.info(`[${ts()}] [ws-handler] Drained ${drained} pending announce(s) to new client ${ip}`);
      }
    } catch (e) {
      logger.warn(`[${ts()}] [ws-handler] Failed to drain pending announces: ${e.message}`);
    }
  }, 500);
  sessions.set(ws, state);
  // ── DB role refresh (non-blocking) ──
  // JWT may contain stale role; refresh from DB to ensure latest permissions
  if (wsAuth.userId) {
    (async () => {
      try {
        const freshUser = await getUserById(wsAuth.userId);
        if (freshUser && freshUser.role && freshUser.role !== state.userRole) {
          logger.info(`[${ts()}] [ws-handler] Role refreshed from DB: ${state.userRole} -> ${freshUser.role} for ${state.username}`);
          state.userRole = freshUser.role;
        }
      } catch (e) {
        logger.debug(`[ws-handler] DB role refresh failed (non-fatal): ${e.message}`);
      }
    })();
  }

  // ── Keep-alive ──
  ws.isAlive = true;
  metrics.recordWsConnect();
  ws.lastClientActivity = Date.now();
  ws.on("pong", () => {
    ws.isAlive = true;
    ws.lastClientActivity = Date.now();
  });

  // ── Initial State Push ──
  const wStatus = workerManager.status;
  sendEvent(ws, { type: "history", messages: state.conversationHistory });
  sendEvent(ws, {
    type: "connected",
    defaultProvider: "rangerai",
    defaultModel: "RangerAI Agent",
    routerModel: "RangerAI 智能路由",
    gatewayConnected: wStatus.workerReady,
    availableProviders: getAvailableProviders(),
    skills: getAvailableSkills(),
    tools: getAvailableTools(),
    capabilities: getSystemCapabilities(),
  });

  // Force reset stale state
  const connectActiveTask = eventBuffer.getActiveTask(DEFAULT_SESSION_KEY);
  if (!connectActiveTask && !workerManager.status.pendingTasks) {
    sendEvent(ws, { type: "status", status: "idle" });
    if (state.isProcessing) {
      logger.info(`[${ts()}] [connect] Clearing stale isProcessing on new connection`);
      state.isProcessing = false;
      state.processingStartedAt = null;
    }
  }

  // ── Heartbeat ──
  // v5.1: 45s interval, 4 missed pings = 180s tolerance for mobile background
  let missedClientPings = 0;
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (!ws.isAlive) {
        missedClientPings++;
        const silentSec = Math.round((Date.now() - ws.lastClientActivity) / 1000);
        logger.info(`[${ts()}] Client ${ip} missed ping #${missedClientPings}/${MAX_MISSED_CLIENT_PINGS} (silent ${silentSec}s)`);
        if (missedClientPings >= MAX_MISSED_CLIENT_PINGS) {
          logger.info(`[${ts()}] Client ${ip} dead (${missedClientPings} missed pings, ${silentSec}s silent). Terminating.`);
          ws.terminate();
          return;
        }
      } else {
        missedClientPings = 0;
      }
      ws.isAlive = false;
      ws.ping();
      sendEvent(ws, { type: "server_ping", ts: Date.now() });
    }
  }, HEARTBEAT_INTERVAL_MS);

  // ── Message Handler ──
  ws.on("message", async (raw) => {
    const rawStr = raw.toString();
    let msg;
    try { msg = JSON.parse(rawStr); } catch (e) { return; }
    ws.isAlive = true;
    ws.lastClientActivity = Date.now();

    try {
      await dispatchMessage(ws, msg, state, ip);
    } catch (err) {
      logger.info(`[${ts()}] WS message handler error: ${err.message}`);
    }
  });

  // ── Close Handler ──
  ws.on("close", () => {
    logger.info(`[${ts()}] Client disconnected: ${ip}`);
    clearInterval(heartbeat);
    for (const [cid, cws] of wsClients) {
      if (cws === ws) wsClients.delete(cid);
    }
    rateLimiter.removeConnection(ip, ws);
    monitor.recordConnection("close", ip);
    metrics.recordWsDisconnect();
    sessions.delete(ws);

    // Grace period for pending tasks
    handleDisconnectGracePeriod(ws);
  });

  ws.on("error", (err) => {
    logger.info(`[${ts()}] Client error: ${err.message}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE DISPATCH (pure routing — zero business logic)
// ═══════════════════════════════════════════════════════════════

/**
 * Route an incoming WebSocket message to the appropriate handler.
 * This function contains ONLY dispatch logic — no business logic.
 *
 * @param {WebSocket} ws
 * @param {object} msg - Parsed JSON message
 * @param {object} state - Connection session state
 * @param {string} ip - Client IP
 */
async function dispatchMessage(ws, msg, state, ip) {
  const { sendEvent } = deps;

  // ── Ping/Pong ──
  if (msg.type === "ping") {
    ws.isAlive = true;
    ws.lastClientActivity = Date.now();
    sendEvent(ws, { type: "pong" });
    return;
  }

  // ── Control Messages → ws-control-handlers ──
  if (msg.type === "bind_chat" && msg.chatId)  return handleBindChat(ws, msg, state);
  if (msg.type === "recover_task")             return handleRecoverTask(ws, msg, state);
  if (msg.type === "status_update")            return handleStatusUpdate(ws, msg, state);
  if (msg.type === "force_reset")              return handleForceReset(ws, msg, state);
  if (msg.type === "cancel")                   return handleCancel(ws, msg, state, ip);
  if (msg.type === "gateway_api")              return handleGatewayApi(ws, msg);
  if (msg.type === "abort_task")               return handleAbortTask(ws, msg, state);
  if (msg.type === "set_session")              return handleSetSession(ws, msg, state);

  // R54: Route tool confirmation responses from frontend to worker
  if (msg.type === "tool_confirm_response") {
    const { confirmId, approved } = msg;
    logger.info(`[ws-handler] tool_confirm_response: ${confirmId} → ${approved ? 'approved' : 'rejected'}`);
    // Forward to the worker process via IPC
    try {
      const { workerManager } = deps;
      if (workerManager && workerManager.worker) {
        workerManager.worker.send({ type: "tool_confirm_response", confirmId, approved: !!approved });
      }
    } catch (err) {
      logger.warn(`[ws-handler] Failed to forward tool_confirm_response: ${err.message}`);
    }
    return;
  }

  // ── User Interrupt (may dispatch as normal message) ──
  let dispatchAsNormalMessage = false;
  if (msg.type === "user_interrupt" && msg.content) {
    dispatchAsNormalMessage = handleUserInterrupt(ws, msg, state, ip);
    if (!dispatchAsNormalMessage) return;
  }

  // ── Chat Messages → ws-chat-handlers ──
  if ((msg.type === "message" || msg.type === "user_interrupt") && msg.content) {
    return handleSendMessage(ws, msg, state, ip);
  }
}
