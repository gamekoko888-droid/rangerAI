// ─── Gateway Connector v1.0 ─────────────────────────────────
// Modular Gateway connection manager with:
// - Infinite reconnect with intelligent backoff
// - Dynamic port discovery from openclaw.json
// - fs.watch for port change detection
// - Error classification for UI and alerting
// - Single state machine (no concurrent reconnect timers)
// - Storm protection (escalating slow-down)
// ─────────────────────────────────────────────────────────────

import { logger } from './lib/logger.mjs';
import fs from "fs";
import WebSocket from "ws";

const ts = () => new Date().toISOString();

// ─── Error Classification ──────────────────────────────────
const ERROR_TYPES = {
  CONNECTION_REFUSED: "CONNECTION_REFUSED",   // ECONNREFUSED - port/process issue
  TIMEOUT: "TIMEOUT",                         // ETIMEOUT - network/load issue
  AUTH_ERROR: "AUTH_ERROR",                    // 401/token issue
  PROTOCOL_ERROR: "PROTOCOL_ERROR",           // handshake/protocol mismatch
  CONFIG_ERROR: "CONFIG_ERROR",               // openclaw.json unreadable
  UNKNOWN: "UNKNOWN"
};

function classifyError(err) {
  const msg = (err?.message || err || "").toString().toLowerCase();
  if (msg.includes("econnrefused") || msg.includes("connection refused")) return ERROR_TYPES.CONNECTION_REFUSED;
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("etimeout")) return ERROR_TYPES.TIMEOUT;
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("auth") || msg.includes("token")) return ERROR_TYPES.AUTH_ERROR;
  if (msg.includes("handshake") || msg.includes("protocol") || msg.includes("invalid")) return ERROR_TYPES.PROTOCOL_ERROR;
  return ERROR_TYPES.UNKNOWN;
}

// ─── Dynamic Port Discovery ────────────────────────────────
const OPENCLAW_CONFIG_PATH = "/home/admin/.openclaw/openclaw.json";
const DEFAULT_PORT = 18789;
const DEFAULT_HOST = "127.0.0.1";

class PortDiscovery {
  constructor() {
    this.lastKnownPort = DEFAULT_PORT;
    this.lastKnownHost = DEFAULT_HOST;
    this.configWatcher = null;
    this.debounceTimer = null;
    this.onPortChange = null; // callback
  }

  /**
   * Read port from openclaw.json
   * Returns { host, port, wsUrl } or null on failure
   */
  readConfig() {
    try {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);
      
      // Try multiple possible config paths
      const port = config?.gateway?.port || config?.port || DEFAULT_PORT;
      const host = config?.gateway?.host || config?.host || DEFAULT_HOST;
      
      this.lastKnownPort = port;
      this.lastKnownHost = host;
      
      return { host, port, wsUrl: `ws://${host}:${port}` };
    } catch (err) {
      logger.info(`[${ts()}] [port-discovery] Failed to read ${OPENCLAW_CONFIG_PATH}: ${err.message}`);
      logger.info(`[${ts()}] [port-discovery] Using last-known-good: ws://${this.lastKnownHost}:${this.lastKnownPort}`);
      return null; // signal config read failure
    }
  }

  /**
   * Get current WebSocket URL (always returns something usable)
   */
  getWsUrl() {
    const config = this.readConfig();
    if (config) return config.wsUrl;
    return `ws://${this.lastKnownHost}:${this.lastKnownPort}`;
  }

  /**
   * Get token from openclaw.json
   */
  getToken(fallbackToken) {
    try {
      const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
      return config?.gateway?.auth?.token || fallbackToken;
    } catch {
      return fallbackToken;
    }
  }

  /**
   * Start watching openclaw.json for changes
   * Debounces to avoid multiple triggers (300ms)
   */
  startWatching(onChange) {
    this.onPortChange = onChange;
    try {
      this.configWatcher = fs.watch(OPENCLAW_CONFIG_PATH, (eventType) => {
        if (eventType !== "change") return;
        
        // Debounce: 500ms to avoid multiple triggers
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          const oldPort = this.lastKnownPort;
          const config = this.readConfig();
          if (config && config.port !== oldPort) {
            logger.info(`[${ts()}] [port-discovery] Port changed: ${oldPort} → ${config.port}`);
            if (this.onPortChange) this.onPortChange(config);
          }
        }, 500);
      });
      logger.info(`[${ts()}] [port-discovery] Watching ${OPENCLAW_CONFIG_PATH} for changes`);
    } catch (err) {
      logger.info(`[${ts()}] [port-discovery] Cannot watch config: ${err.message}`);
    }
  }

  stopWatching() {
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

// ─── Connection State Machine ──────────────────────────────
// States: DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED
// Only one transition at a time (single-flight lock)
const CONN_STATES = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED"
};

// ─── Reconnect Strategy ────────────────────────────────────
// Phase 1 (fast): attempts 1-10, delay 1s-30s exponential backoff
// Phase 2 (slow): attempts 11+, delay 60s fixed
// Phase 3 (storm): if >20 failures in 10 min, delay 5min
// Never gives up. Never sets _terminated.
class ReconnectStrategy {
  constructor() {
    this.attempts = 0;
    this.recentFailures = []; // timestamps of recent failures
    this.lastError = null;
    this.lastErrorType = null;
  }

  recordFailure(err) {
    this.attempts++;
    this.lastError = err;
    this.lastErrorType = classifyError(err);
    this.recentFailures.push(Date.now());
    // Keep only last 10 minutes of failures
    const tenMinAgo = Date.now() - 600000;
    this.recentFailures = this.recentFailures.filter(t => t > tenMinAgo);
  }

  recordSuccess() {
    this.attempts = 0;
    this.recentFailures = [];
    this.lastError = null;
    this.lastErrorType = null;
  }

  getDelay() {
    // Storm protection: >20 failures in 10 min → 5 min delay
    if (this.recentFailures.length > 20) {
      const delay = 300000; // 5 min
      const jitter = Math.random() * 30000;
      return Math.round(delay + jitter);
    }

    // Phase 1 (fast): attempts 1-10
    if (this.attempts <= 10) {
      const baseDelay = Math.min(1000 * Math.pow(2, this.attempts - 1), 30000);
      const jitter = Math.random() * baseDelay * 0.3;
      return Math.round(baseDelay + jitter);
    }

    // Phase 2 (slow): attempts 11+
    const baseDelay = 60000; // 60s
    const jitter = Math.random() * 10000;
    return Math.round(baseDelay + jitter);
  }

  getPhase() {
    if (this.recentFailures.length > 20) return "STORM";
    if (this.attempts <= 10) return "FAST";
    return "SLOW";
  }

  getStatus() {
    return {
      attempts: this.attempts,
      phase: this.getPhase(),
      lastErrorType: this.lastErrorType,
      lastError: this.lastError?.message || null,
      recentFailureCount: this.recentFailures.length,
      nextDelay: this.getDelay()
    };
  }
}

// ─── Gateway Connector (Main Class) ────────────────────────
export class GatewayConnector {
  constructor(options = {}) {
    this.fallbackToken = options.token || "";
    this.onMessage = options.onMessage || (() => {});
    this.onConnected = options.onConnected || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    // RCA improvement #4: Gateway lifecycle callback for circuit breaker reset
    this.onReconnected = options.onReconnected || (() => {});
    this._wasEverConnected = false;

    this.ws = null;
    this.state = CONN_STATES.DISCONNECTED;
    this.reconnectTimer = null;
    this.tickTimer = null;
    this.lastTickAt = 0;
    this.pendingRequests = new Map();
    this.eventHandlers = new Map();
    // R59: Event buffer for race condition fix — cache events that arrive before handler is registered
    this._pendingEventBuffer = new Map(); // runId → { events: [], timer: setTimeout }
    this._terminated = false;
    this._pingInterval = null; // v3.6: heartbeat ping interval

    this.portDiscovery = new PortDiscovery();
    this.strategy = new ReconnectStrategy();
    this.currentWsUrl = null;

    // Start watching for port changes
    this.portDiscovery.startWatching((newConfig) => {
      logger.info(`[${ts()}] [gateway] Port change detected, triggering reconnect to ${newConfig.wsUrl}`);
      this._forceReconnect();
    });
  }

  // ─── Public API ──────────────────────────────────────────

  async connect() {
    if (this._terminated) throw new Error("Gateway connector terminated");
    if (this.state !== CONN_STATES.DISCONNECTED) return;
    
    return this._doConnect();
  }

  get isConnected() { return this.state === CONN_STATES.CONNECTED; }

  getStatus() {
    return {
      state: this.state,
      wsUrl: this.currentWsUrl,
      reconnect: this.strategy.getStatus(),
      lastTickAge: this.lastTickAt ? Date.now() - this.lastTickAt : null
    };
  }

  async request(method, params, timeoutMs = 30000) {
    if (!this.isConnected) throw new Error("Gateway not connected");
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  onRunEvents(runId, handler, sessionKey) {
    logger.info(`[gateway-connector] [HANDLER-REG] Registering handler for runId=${runId}, sessionKey=${sessionKey || 'none'}, total=${this.eventHandlers.size + 1}`);
    // Memory-leak guard: store registration timestamp alongside handler
    // v16.0: Also store sessionKey for fallback matching when Gateway uses internal runId
    this.eventHandlers.set(runId, { handler, registeredAt: Date.now(), sessionKey: sessionKey || null });
    // R59: Flush any buffered events that arrived before handler was registered
    const buffered = this._pendingEventBuffer.get(runId);
    if (buffered) {
      clearTimeout(buffered.timer);
      this._pendingEventBuffer.delete(runId);
      logger.info(`[gateway-connector] [R59-BUFFER] Flushing ${buffered.events.length} buffered events for runId=${runId}`);
      for (const msg of buffered.events) {
        try { handler(msg); } catch (e) { logger.info(`[gateway-connector] [R59-BUFFER] Error dispatching buffered event: ${e.message}`); }
      }
    }
    // R59-FIX: Also flush buffers matching by sessionKey (events may have arrived with different runId)
    if (sessionKey) {
      const toFlush = [];
      for (const [bufRunId, buf] of this._pendingEventBuffer) {
        if (bufRunId === runId) continue; // already handled above
        const evtSK = buf.events[0]?.payload?.sessionKey;
        if (!evtSK) continue;
        const sk = sessionKey;
        if (evtSK === sk || evtSK === `agent:main:${sk}` || sk === `agent:main:${evtSK}` || evtSK.replace(/^agent:main:/, '') === sk.replace(/^agent:main:/, '')) {
          toFlush.push(bufRunId);
        }
      }
      for (const bufRunId of toFlush) {
        const buf = this._pendingEventBuffer.get(bufRunId);
        if (!buf) continue;
        clearTimeout(buf.timer);
        this._pendingEventBuffer.delete(bufRunId);
        logger.info(`[gateway-connector] [R59-FIX] Flushing ${buf.events.length} sessionKey-matched events (bufRunId=${bufRunId} → handlerRunId=${runId})`);
        for (const msg of buf.events) {
          const rewritten = JSON.parse(JSON.stringify(msg));
          rewritten.payload.runId = runId;
          if (rewritten.payload?.data?.runId) rewritten.payload.data.runId = runId;
          try { handler(rewritten); } catch (e) { logger.info(`[gateway-connector] [R59-FIX] SK-flush error: ${e.message}`); }
        }
      }
    }
    // Start stale-handler GC if not already running
    if (!this._handlerGcTimer) {
      this._handlerGcTimer = setInterval(() => {
        const TTL = 12 * 60 * 1000; // 12 minutes — longer than any real task should live
        const now = Date.now();
        let cleaned = 0;
        for (const [id, entry] of this.eventHandlers) {
          if (now - entry.registeredAt > TTL) {
            this.eventHandlers.delete(id);
            cleaned++;
          }
        }
        if (cleaned > 0) {
          logger.warn(`[gateway-connector] [GC] Cleaned ${cleaned} stale event handler(s). Remaining: ${this.eventHandlers.size}`);
        }
        // Stop GC timer when Map is empty to avoid running forever
        if (this.eventHandlers.size === 0) {
          clearInterval(this._handlerGcTimer);
          this._handlerGcTimer = null;
        }
      }, 3 * 60 * 1000); // Check every 3 minutes
    }
  }

  offRunEvents(runId) {
    this.eventHandlers.delete(runId);
    // R59: Also clean up any pending buffer for this runId
    const buf = this._pendingEventBuffer.get(runId);
    if (buf) { clearTimeout(buf.timer); this._pendingEventBuffer.delete(runId); }
  }

  _dispatchRunEvent(runId, msg) {
    const entryExists = this.eventHandlers.has(runId);
    if (!entryExists) logger.info(`[${new Date().toISOString()}] [gateway] [v16.1-DISPATCH] Handler NOT found for runId=${runId}, handlers=${[...this.eventHandlers.keys()].join(",")}`);
    const entry = this.eventHandlers.get(runId);
    if (entry) { try { entry.handler(msg); } catch(e) { logger.error(`[${new Date().toISOString()}] [gateway] [v16.1-DISPATCH-ERR] Handler threw: ${e.message}`, e.stack); } }
  }

  terminate() {
    this._terminated = true;
    this._clearReconnectTimer();
    this._stopTickMonitor();
    this.portDiscovery.stopWatching();
    // Stop GC timer on terminate to prevent timer leak
    if (this._handlerGcTimer) {
      clearInterval(this._handlerGcTimer);
      this._handlerGcTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* best-effort */ }
      this.ws = null;
    }
    this._failPendingEventHandlers();
    this._failAllPending("Gateway connector terminated");
    this.eventHandlers.clear();
    // R59: Clear event buffers on terminate
    for (const [, buf] of this._pendingEventBuffer) { clearTimeout(buf.timer); }
    this._pendingEventBuffer.clear();
    this.state = CONN_STATES.DISCONNECTED;
    logger.info(`[${ts()}] [gateway] Connector terminated — no further reconnects`);
  }

  // ─── Internal: Connection ────────────────────────────────

  async _doConnect() {
    if (this.state === CONN_STATES.CONNECTING) return; // single-flight lock
    this.state = CONN_STATES.CONNECTING;
    this._notifyStatus();

    // FIX: Close any existing WebSocket before creating a new one to prevent
    // duplicate connections. Old ws close/message handlers stay alive via closures
    // and can trigger spurious reconnects, leading to N parallel connections.
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) { /* best-effort */ }
      this.ws = null;
    }

    // Dynamic port discovery
    this.currentWsUrl = this.portDiscovery.getWsUrl();
    const token = this.portDiscovery.getToken(this.fallbackToken);

    return new Promise((resolve, reject) => {
      logger.info(`[${ts()}] [gateway] Connecting to ${this.currentWsUrl} (attempt ${this.strategy.attempts + 1}, phase ${this.strategy.getPhase()})`);

      try {
        this.ws = new WebSocket(this.currentWsUrl, {
          headers: { "Origin": `http://${this.portDiscovery.lastKnownHost}:${this.portDiscovery.lastKnownPort}` }
        });
      } catch (err) {
        this.state = CONN_STATES.DISCONNECTED;
        this.strategy.recordFailure(err);
        this._notifyStatus();
        reject(err);
        return;
      }

      // FIX: Capture local reference for stale WebSocket detection
      const ws = this.ws;
      const connectTimeout = setTimeout(() => {
        this.state = CONN_STATES.DISCONNECTED;
        this._notifyStatus();
        reject(new Error("Gateway connection timeout"));
      }, 15000);

      this.ws.on("open", () => {
        logger.info(`[${ts()}] [gateway] WebSocket opened`);
      });

      this.ws.on("message", (raw) => {
        // FIX: Ignore messages from stale WebSocket connections
        if (ws !== this.ws) return;
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg, connectTimeout, token, resolve, reject);
        } catch (err) {
          logger.info(`[${ts()}] [gateway] Failed to parse message: ${err.message}`);
        }
      });

      this.ws.on("close", (code) => {
        // FIX: Guard against stale WebSocket close events from old connections
        // that were replaced by _doConnect() but not yet fully closed
        if (ws !== this.ws) {
          logger.info(`[${ts()}] [gateway] Ignoring close event from stale WebSocket (code=${code})`);
          return;
        }
        logger.info(`[${ts()}] [gateway] WebSocket closed: ${code}`);
        const wasConnected = this.state === CONN_STATES.CONNECTED;
        this.state = CONN_STATES.DISCONNECTED;
        this._stopTickMonitor();
        this._notifyStatus();

        if (wasConnected) {
          // v16.2: DON'T clear eventHandlers on reconnect - preserve them
          // Only clear the pending event buffers (R59)
          for (const [, buf] of this._pendingEventBuffer) { clearTimeout(buf.timer); }
          this._pendingEventBuffer.clear();
          // Notify handlers of temporary disconnection but DON'T remove them
          if (this.eventHandlers.size > 0) {
            logger.info(`[${new Date().toISOString()}] [gateway] [v16.2] Preserving ${this.eventHandlers.size} event handlers across reconnection`);
          }
          this._failAllPending("Gateway connection lost");
          this.onDisconnected();
        }

        this._scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        const errType = classifyError(err);
        logger.info(`[${ts()}] [gateway] WebSocket error [${errType}]: ${err.message}`);
      });
    });
  }

  _handleMessage(msg, connectTimeout, token, resolve, reject) {
    // Challenge → send connect
    if (msg.type === "event" && msg.event === "connect.challenge") {
      this._sendConnect(token);
      return;
    }

    // Connect response
    if (msg.type === "res" && msg.id === "connect-1") {
      clearTimeout(connectTimeout);
      const pending = this.pendingRequests.get("connect-1");
      if (pending) {
        this.pendingRequests.delete("connect-1");
        clearTimeout(pending.timeout);
      }
      if (msg.ok) {
        this.state = CONN_STATES.CONNECTED;
        this.strategy.recordSuccess();
        this._startTickMonitor();
        this._notifyStatus();
        logger.info(`[${ts()}] [gateway] Connected (protocol ${msg.payload?.protocol})`);
        // RCA improvement #4: notify reconnect for circuit breaker reset
        if (this._wasEverConnected) {
          logger.info(`[${ts()}] [gateway] Reconnect successful — notifying lifecycle listeners`);
          this.onReconnected();
          // FIX: Notify active event handlers that gateway restarted (runs are lost)
          this._notifyHandlersGatewayRestart();
        }
        this._wasEverConnected = true;
        this.onConnected();
        resolve();
      } else {
        this.state = CONN_STATES.DISCONNECTED;
        const err = new Error(`Gateway connect failed: ${msg.error?.message || "unknown"}`);
        this.strategy.recordFailure(err);
        this._notifyStatus();
        reject(err);
      }
      return;
    }

    // Regular RPC response
    if (msg.type === "res" && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.ok) pending.resolve(msg.payload);
      else pending.reject(new Error(msg.error?.message || "Request failed"));
      return;
    }

    // Update tick on ANY message
    this.lastTickAt = Date.now();
    if (msg.type === "event" && msg.event === "tick") return;

    // Forward events to handlers
    if (msg.type === "event" && (msg.event === "agent" || msg.event === "chat")) {
      this.lastTickAt = Date.now();
      const runId = msg.payload?.runId;
      if (runId && this.eventHandlers.has(runId)) {
        this._dispatchRunEvent(runId, msg);
        return;
      }
      // v16.1: Multi-strategy fallback for Gateway runId mismatch
      // The Gateway broadcasts events with agent's internal runId (chatcmpl_* or UUID),
      // not the idempotencyKey (ranger-*) that the worker registered.
      // Strategy: sessionKey match → recent-handler match → buffer
      if (runId && this.eventHandlers.size > 0) {
        const evtSessionKey = msg.payload?.sessionKey;
        
        // Strategy 1: Match by sessionKey (v22.2: EXACT match only, no fuzzy includes)
        if (evtSessionKey) {
          for (const [handlerRunId, entry] of this.eventHandlers) {
            // v22.2: Only exact match or known prefix patterns (agent:main:X matches X and vice versa)
            const exactMatch = entry.sessionKey === evtSessionKey;
            const prefixMatch = entry.sessionKey && (
              evtSessionKey === `agent:main:${entry.sessionKey}` ||
              entry.sessionKey === `agent:main:${evtSessionKey}` ||
              evtSessionKey.replace(/^agent:main:/, '') === entry.sessionKey.replace(/^agent:main:/, '')
            );
            if (entry.sessionKey && (exactMatch || prefixMatch)) {
              logger.info(`[gateway-connector] [v22.2-SK-EXACT] Matched event runId=${runId} to handler=${handlerRunId} via sessionKey (exact=${exactMatch}, prefix=${prefixMatch})`);
              const rewrittenMsg = JSON.parse(JSON.stringify(msg));
              rewrittenMsg.payload.runId = handlerRunId;
              if (rewrittenMsg.payload?.data?.runId) rewrittenMsg.payload.data.runId = handlerRunId;
              this._dispatchRunEvent(handlerRunId, rewrittenMsg);
              return;
            }
          }
        }
        
        // Strategy 2: If there's exactly 1 recently-registered handler (within 60s),
        // and the event's runId looks like a Gateway internal ID (chatcmpl_* or UUID without ranger-),
        // route it there. This handles the common case of 1 active chat.
        if (!runId.startsWith("ranger-")) {
          const now = Date.now();
          const recentHandlers = [...this.eventHandlers.entries()]
            .filter(([k, v]) => (now - v.registeredAt) < 60000);
          if (recentHandlers.length === 1) {
            const [handlerRunId, entry] = recentHandlers[0];
            // Track which internal runIds map to this handler to avoid log spam
            if (!entry._mappedInternalIds) entry._mappedInternalIds = new Set();
            if (!entry._mappedInternalIds.has(runId)) {
              entry._mappedInternalIds.add(runId);
              logger.info(`[gateway-connector] [v16.1-TIME-MATCH] Mapped internal runId=${runId} to handler=${handlerRunId} (only recent handler, age=${now - entry.registeredAt}ms)`);
            }
            const rewrittenMsg = JSON.parse(JSON.stringify(msg));
            rewrittenMsg.payload.runId = handlerRunId;
            if (rewrittenMsg.payload?.data?.runId) rewrittenMsg.payload.data.runId = handlerRunId;
            this._dispatchRunEvent(handlerRunId, rewrittenMsg);
            return;
          }
          // If multiple recent handlers, try to match by the handler that has no events yet
          if (recentHandlers.length > 1) {
            // Find handlers that haven't received any events yet (freshest)
            const freshHandlers = recentHandlers.filter(([k, v]) => !v._mappedInternalIds || v._mappedInternalIds.size === 0);
            if (freshHandlers.length === 1) {
              const [handlerRunId, entry] = freshHandlers[0];
              if (!entry._mappedInternalIds) entry._mappedInternalIds = new Set();
              entry._mappedInternalIds.add(runId);
              logger.info(`[gateway-connector] [v16.1-FRESH-MATCH] Mapped internal runId=${runId} to fresh handler=${handlerRunId}`);
              const rewrittenMsg = JSON.parse(JSON.stringify(msg));
              rewrittenMsg.payload.runId = handlerRunId;
              if (rewrittenMsg.payload?.data?.runId) rewrittenMsg.payload.data.runId = handlerRunId;
              this._dispatchRunEvent(handlerRunId, rewrittenMsg);
              return;
            }
            // Multiple handlers - try matching by the one registered most recently
            const sorted = recentHandlers.sort((a, b) => b[1].registeredAt - a[1].registeredAt);
            // First: check if any handler already has this runId mapped
            for (const [handlerRunId, entry] of sorted) {
              if (entry._mappedInternalIds && entry._mappedInternalIds.has(runId)) {
                const rewrittenMsg = JSON.parse(JSON.stringify(msg));
                rewrittenMsg.payload.runId = handlerRunId;
                if (rewrittenMsg.payload?.data?.runId) rewrittenMsg.payload.data.runId = handlerRunId;
                logger.info("[gateway-connector] [v16.3-MAPPED] Dispatched event runId=" + runId + " to previously-mapped handler=" + handlerRunId);
                this._dispatchRunEvent(handlerRunId, rewrittenMsg);
                return;
              }
            }
            // v16.3: No prior mapping found - assign to the most recently registered handler
            {
              const [handlerRunId, entry] = sorted[0];
              if (!entry._mappedInternalIds) entry._mappedInternalIds = new Set();
              entry._mappedInternalIds.add(runId);
              const rewrittenMsg = JSON.parse(JSON.stringify(msg));
              rewrittenMsg.payload.runId = handlerRunId;
              if (rewrittenMsg.payload?.data?.runId) rewrittenMsg.payload.data.runId = handlerRunId;
              logger.info("[gateway-connector] [v16.3-NEWEST] Mapped new internal runId=" + runId + " to newest handler=" + handlerRunId + " (age=" + (Date.now() - entry.registeredAt) + "ms)");
              this._dispatchRunEvent(handlerRunId, rewrittenMsg);
              return;
            }
          }
        }
      }
      // R59: Buffer unregistered events for 2s to handle race condition
      // where events arrive before onRunEvents() is called after chat.send resolves
      if (runId) {
        let buf = this._pendingEventBuffer.get(runId);
        if (!buf) {
          buf = { events: [], timer: null };
          this._pendingEventBuffer.set(runId, buf);
          // R59-FIX: Increased from 2s to 8s to give chat.send time to return
          buf.timer = setTimeout(() => {
            const expired = this._pendingEventBuffer.get(runId);
            if (expired) {
              this._pendingEventBuffer.delete(runId);
              // R59-FIX: Before falling to onMessage, try sessionKey matching against registered handlers
              const evtSessionKey = expired.events[0]?.payload?.sessionKey;
              let matched = false;
              if (evtSessionKey && this.eventHandlers.size > 0) {
                for (const [handlerRunId, entry] of this.eventHandlers) {
                  if (!entry.sessionKey) continue;
                  const sk = entry.sessionKey;
                  const exactMatch = sk === evtSessionKey;
                  const prefixMatch = evtSessionKey === `agent:main:${sk}` || sk === `agent:main:${evtSessionKey}` || evtSessionKey.replace(/^agent:main:/, '') === sk.replace(/^agent:main:/, '');
                  if (exactMatch || prefixMatch) {
                    logger.info(`[${ts()}] [gateway] [R59-FIX] Buffer expired but found sessionKey match: runId=${runId} → handler=${handlerRunId} (${expired.events.length} events)`);
                    for (const e of expired.events) {
                      const rewritten = JSON.parse(JSON.stringify(e));
                      rewritten.payload.runId = handlerRunId;
                      if (rewritten.payload?.data?.runId) rewritten.payload.data.runId = handlerRunId;
                      try { entry.handler(rewritten); } catch(err) { logger.info(`[${ts()}] [gateway] [R59-FIX] Dispatch error: ${err.message}`); }
                    }
                    matched = true;
                    break;
                  }
                }
              }
              if (!matched) {
                logger.info(`[${ts()}] [gateway] [R59-BUFFER] Buffer expired for runId=${runId}, forwarding ${expired.events.length} events to onMessage`);
                for (const e of expired.events) { this.onMessage(e); }
              }
            }
          }, 8000);
        }
        buf.events.push(msg);
        if (buf.events.length === 1) {
          logger.info(`[${ts()}] [gateway] [R59-BUFFER] Buffering events for unregistered runId=${runId} (registered_handlers=${[...this.eventHandlers.keys()].join(",") || "none"})`);
        }
        return;
      }
      // No runId — forward immediately (legacy behavior)
      logger.info(`[${ts()}] [gateway] Unregistered agent/chat event: event=${msg.event} runId=none — forwarding to onMessage`);
      this.onMessage(msg);
      return;
    }

    // Forward all other messages to generic handler
    this.onMessage(msg);
  }

  _sendConnect(token) {
    const id = "connect-1";
    this.pendingRequests.set(id, {
      resolve: () => {}, reject: () => {},
      timeout: setTimeout(() => {
        const p = this.pendingRequests.get(id);
        if (p) { this.pendingRequests.delete(id); p.reject(new Error("Gateway connect timeout")); }
      }, 10000)
    });
    this.ws.send(JSON.stringify({
      type: "req", id, method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: "openclaw-control-ui", version: "dev", platform: "linux", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["tool-events"],
        commands: [], permissions: {},
        auth: { token },
        locale: "zh-CN",
        userAgent: "rangerai-agent/2.0"
      }
    }));
  }

  // ─── Internal: Tick Monitor ──────────────────────────────

  _startTickMonitor() {
    this.lastTickAt = Date.now();
    this._lastPongAt = Date.now();
    this.tickTimer = setInterval(() => {
      if (Date.now() - this.lastTickAt > 120000) {
        logger.info(`[${ts()}] [gateway] No tick for 120s, forcing reconnect...`);
        this.ws?.close();
        return;
      }
      // v3.7: WebSocket-level ping for faster dead connection detection
      if (this.ws && this.ws.readyState === 1) {
        try {
          this.ws.ping();
        } catch (pingErr) {
          logger.info(`[${ts()}] [gateway] Ping failed: ${pingErr.message}`);
        }
      }
    }, 30000);

    // v3.7: Listen for pong responses
    if (this.ws) {
      this.ws.on("pong", () => {
        this._lastPongAt = Date.now();
      });
    }
  }

  _stopTickMonitor() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  // ─── Internal: Reconnect ─────────────────────────────────

  _scheduleReconnect(isActualFailure = false) {
    if (this._terminated) {
      logger.info(`[${ts()}] [gateway] Reconnect skipped — terminated`);
      return;
    }
    // Single-flight: only one reconnect timer at a time
    if (this.reconnectTimer) return;

    // P1-2: Only record failure when it's an actual connection failure,
    // not a normal close (e.g., Gateway maintenance restart)
    if (isActualFailure) {
      this.strategy.recordFailure(this.strategy.lastError || new Error("disconnected"));
    }
    const delay = this.strategy.getDelay();
    const status = this.strategy.getStatus();

    logger.info(`[${ts()}] [gateway] Scheduling reconnect in ${delay}ms (attempt ${status.attempts}, phase ${status.phase}, lastError: ${status.lastErrorType || "none"})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._terminated) return;
      try {
        await this._doConnect();
      } catch (err) {
        logger.info(`[${ts()}] [gateway] Reconnect failed [${classifyError(err)}]: ${err.message}`);
        this._scheduleReconnect(true);  // P1-2: Actual failure, record it
      }
    }, delay);
  }

  _forceReconnect() {
    if (this._terminated) return;
    // Clear existing timer and force immediate reconnect
    this._clearReconnectTimer();
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* best-effort */ }
    }
    // Don't count port-change reconnects as failures
    this.strategy.recordSuccess();
    logger.info(`[${ts()}] [gateway] Force reconnect (port change)`);
    setTimeout(async () => {
      try {
        await this._doConnect();
      } catch (err) {
        logger.info(`[${ts()}] [gateway] Force reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, 500);
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Internal: Cleanup ───────────────────────────────────

  _failPendingEventHandlers() {
    // R59: Clear event buffers on connection failure
    for (const [, buf] of this._pendingEventBuffer) { clearTimeout(buf.timer); }
    this._pendingEventBuffer.clear();
    if (this.eventHandlers.size > 0) {
      logger.info(`[${ts()}] [gateway] Failing ${this.eventHandlers.size} pending run event handlers`);
      for (const [runId, entry] of this.eventHandlers) {
        try {
          const handler = typeof entry === 'function' ? entry : entry.handler;
          handler({
            event: "agent",
            payload: {
              runId,
              stream: "lifecycle",
              data: { phase: "error", error: "Gateway connection lost — will reconnect and retry" }
            }
          });
        } catch (e) {
          logger.info(`[${ts()}] [gateway] Error notifying handler for run ${runId}: ${e.message}`);
        }
      }
      this.eventHandlers.clear();
    }
  }

  _failAllPending(reason) {
    for (const [id, pending] of this.pendingRequests) {
      if (id === "connect-1") continue;
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  _notifyHandlersGatewayRestart() {
    if (this.eventHandlers.size === 0) return;
    const handlerCount = this.eventHandlers.size;
    logger.info(`[${ts()}] [gateway] [v16.3] Reconnected with ${handlerCount} active handler(s) — checking if runs survived...`);
    
    // Grace period: wait 3s for Gateway to stabilize, then check if runs are still alive
    setTimeout(async () => {
      if (this.state !== "CONNECTED") {
        logger.info(`[${ts()}] [gateway] [v16.3] Not connected after grace period, skipping run check`);
        return;
      }
      
      let activeSessions = null;
      try {
        const sessionsResp = await this.request("sessions.list", {}, 10000);
        activeSessions = sessionsResp?.sessions || [];
        logger.info(`[${ts()}] [gateway] [v16.3] sessions.list returned ${activeSessions.length} active session(s)`);
      } catch (err) {
        logger.info(`[${ts()}] [gateway] [v16.3] sessions.list failed: ${err.message} — assuming runs survived (optimistic)`);
        return; // Optimistic: if we can't check, assume runs are fine
      }
      
      // Check each handler's run against active sessions
      const activeSessionKeys = new Set(activeSessions.map(s => s.key));
      let lostCount = 0;
      let survivedCount = 0;
      
      for (const [runId, entry] of this.eventHandlers) {
        // If the handler was registered AFTER the reconnect, skip it
        if (entry.registeredAt > Date.now() - 5000) {
          survivedCount++;
          continue;
        }
        
        // Check if the session is still active in Gateway
        // The sessionKey might be stored in the entry or derivable from runId
        const sessionKey = entry.sessionKey;
        const isAlive = sessionKey ? 
          (activeSessionKeys.has(sessionKey) || activeSessionKeys.has("agent:main:" + sessionKey) || activeSessionKeys.has(sessionKey.replace(/^agent:main:/, ""))) :
          true; // If no sessionKey, assume alive (optimistic)
        
        if (isAlive) {
          survivedCount++;
          logger.info(`[${ts()}] [gateway] [v16.3] Run ${runId} survived reconnect (session still active)`);
        } else {
          lostCount++;
          logger.info(`[${ts()}] [gateway] [v16.3] Run ${runId} confirmed LOST after reconnect`);
          try {
            entry.handler({
              type: "event",
              event: "agent",
              payload: {
                runId,
                stream: "lifecycle",
                data: { phase: "error", error: "Gateway restarted — run lost. Will retry." }
              }
            });
          } catch (err) {
            logger.info(`[${ts()}] [gateway] Error notifying handler for runId=${runId}: ${err.message}`);
          }
        }
      }
      
      logger.info(`[${ts()}] [gateway] [v16.3] Reconnect audit complete: ${survivedCount} survived, ${lostCount} lost`);
    }, 3000);
  }
  _notifyStatus() {
    try {
      this.onStatusChange(this.getStatus());
    } catch (e) { /* best-effort */ }
  }

  // ─── Gateway API Proxy Methods ───────────────────────────
  async listSessions() { return this.request("sessions.list", {}); }
  async compactSession(sk) { return this.request("sessions.compact", { key: sk }); }
  async resetSession(sk) { return this.request("sessions.reset", { key: sk }); }
  async deleteSession(sk) { return this.request("sessions.delete", { key: sk }); }
  async abortChat(sk) {
    try {
      return await this.request("chat.abort", { sessionKey: sk });
    } catch (e1) {
      try {
        return await this.request("chat.abort", { sessionKey: sk });
      } catch (e2) {
        logger.info(`[${ts()}] [gateway] abort failed with both key and sessionKey: ${e1.message}, ${e2.message}`);
        throw e2;
      }
    }
  }
  async getChatHistory(sk) { return this.request("chat.history", { key: sk }); }
  async listModels() { return this.request("models.list", {}); }
  async getHealth() { return this.request("health", {}); }
  async getGatewayStatus() { return this.request("status", {}); }
}

export { ERROR_TYPES, classifyError, PortDiscovery, ReconnectStrategy };
export default GatewayConnector;
