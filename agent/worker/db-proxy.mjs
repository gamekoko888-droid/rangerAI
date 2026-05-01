import { logger } from '../lib/logger.mjs';
/**
 * db-proxy.mjs — Worker-side database proxy via IPC
 * 
 * Phase 1 of architecture decoupling: Worker no longer imports database.mjs directly.
 * Instead, all DB queries are routed through IPC to the main process, which holds
 * the single database connection pool.
 * 
 * This eliminates the cross-process DB connection split issue and ensures
 * all database access goes through the main process's connection pool.
 * 
 * Usage (drop-in replacement for direct database imports):
 *   import { getChatBySessionKey, getConversationHistory } from "./db-proxy.mjs";
 *   const chat = await getChatBySessionKey(sessionKey);
 *   const history = await getConversationHistory(chatId, 10);
 * 
 * @module worker/db-proxy
 */

const ts = () => new Date().toISOString();

// Pending request registry: reqId → { resolve, reject, timer }
const _pendingRequests = new Map();

// Auto-incrementing request counter for unique IDs
let _reqCounter = 0;

// Default timeout for DB queries via IPC (ms)
const DB_QUERY_TIMEOUT = 15000;

/**
 * Send a database query request to the main process via IPC and wait for the response.
 * 
 * @param {string} method - The database function name (e.g., "getChatBySessionKey")
 * @param {any[]} args - Arguments to pass to the database function
 * @param {number} [timeout=DB_QUERY_TIMEOUT] - Timeout in ms
 * @returns {Promise<any>} The query result
 */
function dbRequest(method, args = [], timeout = DB_QUERY_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const reqId = `db-${++_reqCounter}-${Date.now()}`;
    
    const timer = setTimeout(() => {
      _pendingRequests.delete(reqId);
      reject(new Error(`[db-proxy] Timeout waiting for DB response: ${method} (${timeout}ms)`));
    }, timeout);

    _pendingRequests.set(reqId, { resolve, reject, timer, method });

    try {
      process.send({
        type: "db_query",
        reqId,
        method,
        args
      });
    } catch (err) {
      clearTimeout(timer);
      _pendingRequests.delete(reqId);
      reject(new Error(`[db-proxy] IPC send failed for ${method}: ${err.message}`));
    }
  });
}

/**
 * Handle db_query_response messages from the main process.
 * Must be called from the Worker's IPC message handler.
 * 
 * @param {object} msg - The IPC message { type: "db_query_response", reqId, ok, result?, error? }
 * @returns {boolean} true if this message was handled, false if not a db response
 */
export function handleDbResponse(msg) {
  if (msg.type !== "db_query_response") return false;
  
  const pending = _pendingRequests.get(msg.reqId);
  if (!pending) {
    logger.warn(`[${ts()}] [db-proxy] Received response for unknown reqId: ${msg.reqId}`);
    return true;
  }

  clearTimeout(pending.timer);
  _pendingRequests.delete(msg.reqId);

  if (msg.ok) {
    pending.resolve(msg.result);
  } else {
    pending.reject(new Error(`[db-proxy] DB query failed (${pending.method}): ${msg.error}`));
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// Drop-in replacement functions for database.mjs exports
// ═══════════════════════════════════════════════════════════════

/**
 * Get a chat record by its session key.
 * @param {string} sessionKey
 * @returns {Promise<object|null>}
 */
export async function getChatBySessionKey(sessionKey) {
  return dbRequest("getChatBySessionKey", [sessionKey]);
}

/**
 * Get conversation history for a chat.
 * @param {string} chatId
 * @param {number} [limit=50]
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function getConversationHistory(chatId, limit = 50) {
  return dbRequest("getConversationHistory", [chatId, limit]);
}


/**
 * Get paginated conversation summaries for a user.
 * @param {string} userId
 * @param {number} [limit=20]
 * @param {number} [offset=0]
 * @returns {Promise<Array<{sessionKey:string,title:string,lastMessage:string,updatedAt:string}>>}
 */
export async function getConversations(userId, limit = 20, offset = 0) {
  return dbRequest("getConversations", [userId, limit, offset]);
}

// ═══════════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════════

/**
 * Get the number of pending DB requests (for health checks).
 * @returns {number}
 */
/**
 * Save a parsed plan to the database via IPC.
 * @param {object} params - { sessionKey, chatId, msgId, plan }
 * @returns {Promise<{id: number}>}
 */
export async function savePlan(params) {
  return dbRequest("savePlan", [params]);
}

/**
 * Update a step's status in a stored plan.
 * @param {string} msgId
 * @param {number} stepIndex
 * @param {string} status
 * @returns {Promise<boolean>}
 */
export async function updateStepStatus(msgId, stepIndex, status) {
  return dbRequest("updateStepStatus", [msgId, stepIndex, status]);
}

/**
 * Mark a plan as completed/failed.
 * @param {string} msgId
 * @param {string} status
 * @returns {Promise<boolean>}
 */
export async function finalizePlan(msgId, status = 'completed') {
  return dbRequest("finalizePlan", [msgId, status]);
}

/**
 * Get the most recent active plan for a session.
 * @param {string} sessionKey
 * @returns {Promise<object|null>}
 */
export async function getActivePlan(sessionKey) {
  return dbRequest("getActivePlan", [sessionKey]);
}

export function getPendingCount() {
  return _pendingRequests.size;
}
