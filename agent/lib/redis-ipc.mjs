/**
 * lib/redis-ipc.mjs — Cross-Process IPC via Redis Pub/Sub + Hash
 *
 * Enables the API process (api-server.mjs) to query Worker status and send
 * commands to the WS process (ws-realtime.mjs) without shared memory.
 *
 * Channels:
 *   rangerai:ipc:cmd    — API → WS commands (restart worker, cleanup ws, etc.)
 *   rangerai:ipc:status — WS → Redis Hash (worker status, active tasks, etc.)
 *
 * @module lib/redis-ipc
 * @version 1.0.0 — Iter-59: HTTP/WS process separation
 */
import { createClient } from "redis";
import { logger } from "./logger.mjs";

const REDIS_URL = process.env.REDIS_POOL_URL || process.env.REDIS_URL || "redis://127.0.0.1:6380";
const CMD_CHANNEL = "rangerai:ipc:cmd";
const RESP_CHANNEL = "rangerai:ipc:resp";
const STATUS_KEY = "rangerai:ws:status";
const ACTIVE_TASKS_KEY = "rangerai:ws:active_tasks";

// Request-response pending callbacks (API side)
const pendingRequests = new Map();
const REQUEST_TIMEOUT_MS = 15000;

// ─── Publisher Side (used by both processes) ─────────────────
let pubClient = null;
let subClient = null;
let respClient = null; // API process subscribes to response channel
let cmdHandler = null;
let notificationHandler = null; // API process notification handler for WS events

/**
 * Initialize the IPC module.
 * @param {{ role: 'api' | 'ws', onCommand?: (cmd) => void }} opts
 */
export async function initIPC({ role, onCommand, onNotification }) {
  try {
    pubClient = createClient({ url: REDIS_URL, socket: { connectTimeout: 5000 } });
    pubClient.on("error", (err) => logger.warn(`[redis-ipc] pub error: ${err.message}`));
    await pubClient.connect();
    logger.info(`[redis-ipc] Publisher connected (role=${role})`);

    if (role === "ws" && onCommand) {
      // WS process subscribes to command channel
      subClient = createClient({ url: REDIS_URL, socket: { connectTimeout: 5000 } });
      subClient.on("error", (err) => logger.warn(`[redis-ipc] sub error: ${err.message}`));
      await subClient.connect();
      cmdHandler = onCommand;
      await subClient.subscribe(CMD_CHANNEL, (message) => {
        try {
          const cmd = JSON.parse(message);
          logger.info(`[redis-ipc] Received command: ${cmd.type}`);
          cmdHandler(cmd);
        } catch (e) {
          logger.warn(`[redis-ipc] Invalid command message: ${e.message}`);
        }
      });
      logger.info(`[redis-ipc] Subscribed to ${CMD_CHANNEL}`);
    }

    if (role === "api") {
      if (onNotification) notificationHandler = onNotification;
      // API process subscribes to response channel for request-response pattern
      respClient = createClient({ url: REDIS_URL, socket: { connectTimeout: 5000 } });
      respClient.on("error", (err) => logger.warn(`[redis-ipc] resp error: ${err.message}`));
      await respClient.connect();
      await respClient.subscribe(RESP_CHANNEL, (message) => {
        try {
          const resp = JSON.parse(message);
          // Handle notifications (no reqId) from WS process
          if (resp.type && !resp.reqId && notificationHandler) {
            notificationHandler(resp);
            return;
          }
          const reqId = resp.reqId;
          if (reqId && pendingRequests.has(reqId)) {
            const { resolve, timer } = pendingRequests.get(reqId);
            clearTimeout(timer);
            pendingRequests.delete(reqId);
            resolve(resp);
          }
        } catch (e) {
          logger.warn(`[redis-ipc] Invalid response message: ${e.message}`);
        }
      });
      logger.info(`[redis-ipc] Subscribed to ${RESP_CHANNEL} for request-response`);
    }
    return true;
  } catch (err) {
    logger.warn(`[redis-ipc] Init failed (non-fatal): ${err.message}`);
    return false;
  }
}

// ─── API Process: Send Commands to WS Process ───────────────
/**
 * Send a command from API process to WS process.
 * @param {{ type: string, payload?: any }} cmd
 */
export async function sendCommand(cmd) {
  if (!pubClient) return false;
  try {
    // Iter-60: Ensure traceId is propagated if available in logger context
    const traceId = cmd.traceId || cmd.payload?.traceId || process.env.TRACE_ID;
    await pubClient.publish(CMD_CHANNEL, JSON.stringify({ ...cmd, traceId, ts: Date.now() }));
    return true;
  } catch (err) {
    logger.warn(`[redis-ipc] sendCommand failed: ${err.message}`);
    return false;
  }
}

// ─── WS Process: Publish Status to Redis ────────────────────
/**
 * Update worker status in Redis (called by WS process periodically).
 * @param {object} status — workerManager.status-like object
 */
export async function publishWorkerStatus(status) {
  if (!pubClient) return;
  try {
    await pubClient.hSet(STATUS_KEY, {
      workerReady: String(status.workerReady || false),
      pendingTasks: String(status.pendingTasks || 0),
      workerPid: String(status.workerPid || 0),
      uptime: String(status.uptime || 0),
      lastActivity: String(status.lastActivity || ""),
      updatedAt: String(Date.now()),
    });
    // TTL 60s — if WS process dies, status auto-expires
    await pubClient.expire(STATUS_KEY, 60);
  } catch (err) {
    logger.debug(`[redis-ipc] publishWorkerStatus failed: ${err.message}`);
  }
}

/**
 * Update active tasks list in Redis (called by WS process).
 * @param {Array} tasks — array of { msgId, sessionKey, startedAt, hasClient }
 */
export async function publishActiveTasks(tasks) {
  if (!pubClient) return;
  try {
    await pubClient.set(ACTIVE_TASKS_KEY, JSON.stringify(tasks), { EX: 60 });
  } catch (err) {
    logger.debug(`[redis-ipc] publishActiveTasks failed: ${err.message}`);
  }
}

// ─── API Process: Read Status from Redis ────────────────────
/**
 * Get worker status from Redis (called by API process).
 * @returns {object|null}
 */
export async function getWorkerStatus() {
  if (!pubClient) return null;
  try {
    const raw = await pubClient.hGetAll(STATUS_KEY);
    if (!raw || !raw.updatedAt) return null;
    return {
      workerReady: raw.workerReady === "true",
      pendingTasks: parseInt(raw.pendingTasks, 10) || 0,
      workerPid: parseInt(raw.workerPid, 10) || 0,
      uptime: parseInt(raw.uptime, 10) || 0,
      lastActivity: raw.lastActivity || "",
      updatedAt: parseInt(raw.updatedAt, 10),
      stale: Date.now() - parseInt(raw.updatedAt, 10) > 30000,
    };
  } catch (err) {
    logger.warn(`[redis-ipc] getWorkerStatus failed: ${err.message}`);
    return null;
  }
}

/**
 * Get active tasks from Redis (called by API process).
 * @returns {Array}
 */
export async function getActiveTasks() {
  if (!pubClient) return [];
  try {
    const raw = await pubClient.get(ACTIVE_TASKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    logger.warn(`[redis-ipc] getActiveTasks failed: ${err.message}`);
    return [];
  }
}

// ─── Request-Response Pattern (API → WS → API) ─────────────
/**
 * Send a command to WS process and wait for a response.
 * Used by admin-routes and static-routes for worker.send/on patterns.
 * @param {{ type: string, payload?: any }} cmd
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<object>}
 */
export function sendRequest(cmd, timeoutMs = REQUEST_TIMEOUT_MS) {
  const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error(`IPC request timeout after ${timeoutMs}ms for ${cmd.type}`));
    }, timeoutMs);

    pendingRequests.set(reqId, { resolve, timer });

    const sent = await sendCommand({ ...cmd, reqId });
    if (!sent) {
      clearTimeout(timer);
      pendingRequests.delete(reqId);
      reject(new Error("IPC sendCommand failed"));
    }
  });
}

/**
 * Publish a response from WS process back to API process.
 * Called by WS process when it receives a request-type command.
 * @param {string} reqId
 * @param {object} data
 */
export async function publishResponse(reqId, data) {
  if (!pubClient) return;
  try {
    await pubClient.publish(RESP_CHANNEL, JSON.stringify({ reqId, ...data, ts: Date.now() }));
  } catch (err) {
    logger.warn(`[redis-ipc] publishResponse failed: ${err.message}`);
  }
}

/**
 * Shutdown IPC connections gracefully.
 */
export async function shutdownIPC() {
  try {
    if (subClient) await subClient.quit();
    if (respClient) await respClient.quit();
    if (pubClient) await pubClient.quit();
    pendingRequests.clear();
  } catch (e) { /* best-effort */ }
}
