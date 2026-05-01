/**
 * acp-api.mjs — ACP RESTful API Gateway
 * 
 * Provides external HTTP API endpoints for third-party systems
 * (ERP, dashboards, automation tools) to interact with RangerAI.
 * 
 * Features:
 * - API Key authentication (Bearer token)
 * - Rate limiting (sliding window per API key)
 * - Async task submission with polling
 * - Sync chat endpoint (waits for reply)
 * - Knowledge search endpoint
 * - Admin JWT verification via main service HTTP API
 * - Status and health endpoints
 * 
 * Endpoints:
 *   POST /acp/v1/chat              — Synchronous chat (waits for AI reply)
 *   POST /acp/v1/chat/async        — Async chat (returns task ID)
 *   GET  /acp/v1/task/:id          — Check async task status
 *   POST /acp/v1/knowledge/search  — Search knowledge base
 *   GET  /acp/v1/status            — Bridge status
 *   GET  /acp/v1/health            — Health check
 *   GET  /acp/v1/admin/keys        — List API keys (admin JWT required)
 *   POST /acp/v1/admin/keys        — Create API key (admin JWT required)
 *   DELETE /acp/v1/admin/keys/:id  — Revoke API key (admin JWT required)
 * 
 * Iter-50: Decoupled from database.mjs — Admin auth now delegates to
 *          main service via HTTP /api/auth/me. ACP token obtained from
 *          acp-bridge.mjs (single source of truth for DB init + ACP user).
 * 
 * @version 1.2.0
 * @since Iter-50
 */

import http from "http";
import crypto from "crypto";
import { routeMessage, log, logError, ts, AGENT_API_BASE, ACP_PORT, ensureAcpUser, getAcpAuthToken } from "./acp-bridge.mjs";
import { initDingTalk, getStatus as getDingTalkStatus, shutdown as shutdownDingTalk, DINGTALK_ENABLED } from "./dingtalk-adapter.mjs";
// Iter-50: Removed direct import of database.mjs (initDatabase, generateToken, verifyToken, getUserById, getUserByUsername)
// Admin auth now delegates to main service via HTTP. DB init is handled by acp-bridge.mjs.
import { query, run, queryOne } from "./db-adapter.mjs";
import { loadEnvFile, loadSecretsJson } from "./lib/bootstrap.mjs";

// ─── Load Environment (same as server.mjs) ──────────────────
loadEnvFile("/opt/rangerai-agent/.env");
loadEnvFile("/opt/rangerai-agent/agent-secrets.env");
const _SECRETS = loadSecretsJson("/opt/rangerai-agent/secrets.json");
for (const [_k, _v] of Object.entries(_SECRETS)) {
  if (process.env[_k] === undefined && typeof _v === "string") {
    process.env[_k] = _v;
  }
}

// ─── API Key Management ─────────────────────────────────────
// API keys are loaded from DB (acp_api_keys table) + env fallback
const API_KEYS = new Map();

/** Initialize acp_api_keys table */
async function initApiKeysTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS acp_api_keys (
      id         VARCHAR(64) PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      key_hash   VARCHAR(128) NOT NULL UNIQUE,
      key_prefix VARCHAR(32) NOT NULL,
      status     VARCHAR(16) NOT NULL DEFAULT 'active',
      call_count INT NOT NULL DEFAULT 0,
      last_used  DATETIME,
      created_by VARCHAR(64),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME
    )
  `);
  try {
    await run(`CREATE INDEX idx_acp_api_keys_status ON acp_api_keys(status)`);
  } catch (e) {
    // Index may already exist — ignore duplicate key name error
    if (!e.message?.includes('Duplicate')) throw e;
  }
  log('api', 'acp_api_keys table initialized');
}

/** Hash an API key for secure storage */
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Generate a new API key */
function generateApiKey() {
  // Format: rak_<32 random hex chars> (rak = RangerAI API Key)
  const raw = crypto.randomBytes(24).toString('hex');
  return `rak_${raw}`;
}

/** Load API keys from DB + env fallback */
async function loadApiKeys() {
  API_KEYS.clear();
  
  // Load from database
  try {
    const dbKeys = await query(`SELECT * FROM acp_api_keys WHERE status = 'active'`);
    for (const row of dbKeys) {
      API_KEYS.set(row.key_hash, {
        id: row.id,
        name: row.name,
        keyPrefix: row.key_prefix,
        source: 'db',
        createdAt: new Date(row.created_at).getTime(),
        callCount: row.call_count || 0,
        lastUsed: row.last_used,
      });
    }
    log('api', `Loaded ${dbKeys.length} API key(s) from database`);
  } catch (err) {
    logError('api', 'Failed to load API keys from database', err);
  }
  
  // Load from env as fallback (for backward compatibility)
  const keysStr = process.env.ACP_API_KEYS || '';
  if (keysStr) {
    let envCount = 0;
    for (const entry of keysStr.split(',')) {
      const [key, name] = entry.trim().split(':');
      if (key) {
        const hash = hashKey(key);
        if (!API_KEYS.has(hash)) {
          API_KEYS.set(hash, {
            id: `env-${key.substring(0, 8)}`,
            name: name || 'env-key',
            keyPrefix: key.substring(0, 8) + '...',
            source: 'env',
            createdAt: Date.now(),
            callCount: 0,
          });
          envCount++;
        }
      }
    }
    if (envCount > 0) log('api', `Loaded ${envCount} additional API key(s) from env`);
  }
  
  if (API_KEYS.size === 0) {
    log('api', 'WARNING: No ACP API keys configured. API endpoints require authentication.');
  } else {
    log('api', `Total active API keys: ${API_KEYS.size}`);
  }
}

// ─── Rate Limiting (Sliding Window) ─────────────────────────
const rateLimitWindows = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.ACP_RATE_LIMIT || "30", 10);

function checkRateLimit(apiKeyHash) {
  const now = Date.now();
  if (!rateLimitWindows.has(apiKeyHash)) {
    rateLimitWindows.set(apiKeyHash, { timestamps: [] });
  }
  const window = rateLimitWindows.get(apiKeyHash);
  window.timestamps = window.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (window.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetIn: Math.ceil((window.timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }
  window.timestamps.push(now);
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - window.timestamps.length };
}

// ─── Request Parsing ────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'X-Powered-By': 'RangerAI ACP Bridge',
  });
  res.end(body);
}

// ─── ACP API Key Authentication ─────────────────────────────
function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Missing or invalid Authorization header. Use: Bearer <api_key>' };
  }
  const apiKey = authHeader.slice(7);
  const keyHash = hashKey(apiKey);
  
  if (!API_KEYS.has(keyHash)) {
    return { authenticated: false, error: 'Invalid API key' };
  }
  
  const keyInfo = API_KEYS.get(keyHash);
  keyInfo.callCount++;
  keyInfo.lastUsed = new Date().toISOString();
  
  // Async update DB call count (fire and forget)
  if (keyInfo.source === 'db') {
    run(`UPDATE acp_api_keys SET call_count = call_count + 1, last_used = NOW() WHERE id = ?`, [keyInfo.id]).catch(() => {});
  }
  
  return { authenticated: true, apiKeyHash: keyHash, keyName: keyInfo.name, keyId: keyInfo.id };
}

// ─── Admin JWT Authentication (Iter-50: Delegated to main service) ─────
/**
 * Authenticate admin requests by delegating JWT verification to the main
 * RangerAI service via GET /api/auth/me. This eliminates the need for
 * acp-api.mjs to directly import database.mjs (verifyToken, getUserById).
 * 
 * Benefits:
 * - Single source of truth for JWT verification (main service)
 * - No duplicate database.mjs import in ACP process
 * - Consistent auth behavior across all services
 */
async function authenticateAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Missing Authorization header' };
  }
  
  try {
    // Delegate token verification to main service
    const verifyResp = await fetch(`${AGENT_API_BASE}/api/auth/me`, {
      method: 'GET',
      headers: { 'Authorization': authHeader },
    });
    
    if (!verifyResp.ok) {
      return { authenticated: false, error: 'Invalid or expired token' };
    }
    
    const { user } = await verifyResp.json();
    if (!user || !user.isActive) {
      return { authenticated: false, error: 'User not found or inactive' };
    }
    if (user.role !== 'admin') {
      return { authenticated: false, error: 'Admin access required' };
    }
    
    return { authenticated: true, user };
  } catch (err) {
    logError('api', 'Admin auth delegation failed', err);
    return { authenticated: false, error: 'Authentication service unavailable' };
  }
}

// ─── Async Task Store ───────────────────────────────────────
const asyncTasks = new Map();
const TASK_TTL_MS = 3600000;

const _acpCleanupTimer = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, task] of asyncTasks) {
    if (now - task.createdAt > TASK_TTL_MS) {
      asyncTasks.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) log('api', `Cleaned ${cleaned} expired async tasks`);
}, 300000);

// ─── Route Handlers ─────────────────────────────────────────

/** POST /acp/v1/chat — Synchronous chat */
async function handleChat(req, res, body, auth) {
  const { message, conversation_id, user_id, user_name } = body;
  if (!message || typeof message !== 'string') {
    sendJson(res, 400, { error: 'Missing required field: message (string)' });
    return;
  }
  const result = await routeMessage({
    platformId: `api:${auth.keyName}`,
    externalUserId: user_id || auth.keyName,
    externalUserName: user_name || auth.keyName,
    conversationId: conversation_id || `api-${auth.keyId?.substring(0, 8) || 'default'}`,
    content: message,
    metadata: { apiKey: auth.keyName },
  });
  sendJson(res, 200, { reply: result.reply, metadata: result.metadata });
}

/** POST /acp/v1/chat/async — Async chat */
async function handleChatAsync(req, res, body, auth) {
  const { message, conversation_id, user_id, user_name } = body;
  if (!message || typeof message !== 'string') {
    sendJson(res, 400, { error: 'Missing required field: message (string)' });
    return;
  }
  const taskId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  asyncTasks.set(taskId, { status: 'processing', createdAt: Date.now(), message, result: null });
  
  (async () => {
    try {
      const result = await routeMessage({
        platformId: `api:${auth.keyName}`,
        externalUserId: user_id || auth.keyName,
        externalUserName: user_name || auth.keyName,
        conversationId: conversation_id || `api-${auth.keyId?.substring(0, 8) || 'default'}`,
        content: message,
        metadata: { apiKey: auth.keyName, taskId },
      });
      if (asyncTasks.has(taskId)) {
        const t = asyncTasks.get(taskId);
        t.status = 'completed'; t.result = result; t.completedAt = Date.now();
      }
    } catch (err) {
      if (asyncTasks.has(taskId)) {
        const t = asyncTasks.get(taskId);
        t.status = 'failed'; t.error = err.message;
      }
    }
  })();
  
  sendJson(res, 202, { task_id: taskId, status: 'processing' });
}

/** GET /acp/v1/task/:id — Check async task status */
async function handleTaskStatus(req, res, taskId) {
  if (!asyncTasks.has(taskId)) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }
  const task = asyncTasks.get(taskId);
  const response = { task_id: taskId, status: task.status, created_at: new Date(task.createdAt).toISOString() };
  if (task.status === 'completed') {
    response.reply = task.result?.reply;
    response.metadata = task.result?.metadata;
    response.completed_at = new Date(task.completedAt).toISOString();
  } else if (task.status === 'failed') {
    response.error = task.error;
  }
  sendJson(res, 200, response);
}

/** POST /acp/v1/knowledge/search — Search knowledge base */
async function handleKnowledgeSearch(req, res, body, auth) {
  const { query: q, limit = 5, category } = body;
  if (!q || typeof q !== 'string') {
    sendJson(res, 400, { error: 'Missing required field: query (string)' });
    return;
  }
  try {
    const searchResp = await fetch(`${AGENT_API_BASE}/api/knowledge/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${(await getAcpToken())}` },
      body: JSON.stringify({ query: q, limit, category }),
    });
    if (!searchResp.ok) { sendJson(res, searchResp.status, { error: 'Knowledge search failed' }); return; }
    const results = await searchResp.json();
    sendJson(res, 200, results);
  } catch (err) {
    logError('api', 'Knowledge search error', err);
    sendJson(res, 500, { error: 'Internal error during knowledge search' });
  }
}

/**
 * Iter-50: getAcpToken() now uses acp-bridge.mjs's getAcpAuthToken()
 * which is the single source of truth for the ACP bridge auth token.
 * ensureAcpUser() in acp-bridge.mjs handles DB init + user creation + token generation.
 */
async function getAcpToken() {
  // First try the cached token from acp-bridge.mjs
  const bridgeToken = getAcpAuthToken();
  if (bridgeToken) return bridgeToken;
  
  // If not available yet, ensure ACP user is created (triggers DB init + token generation)
  await ensureAcpUser();
  const token = getAcpAuthToken();
  if (token) return token;
  
  logError('api', 'Failed to obtain ACP auth token from bridge', null);
  return null;
}

// ─── Admin Key Management Handlers ──────────────────────────

/** GET /acp/v1/admin/keys — List all API keys */
async function handleListKeys(req, res) {
  const auth = await authenticateAdmin(req);
  if (!auth.authenticated) { sendJson(res, 401, { error: auth.error }); return; }
  
  try {
    const keys = await query(`SELECT id, name, key_prefix, status, call_count, last_used, created_by, created_at, revoked_at FROM acp_api_keys ORDER BY created_at DESC`);
    
    // Also include env keys
    const allKeys = [...keys];
    for (const [hash, info] of API_KEYS) {
      if (info.source === 'env') {
        allKeys.push({
          id: info.id,
          name: info.name,
          key_prefix: info.keyPrefix,
          status: 'active',
          call_count: info.callCount,
          last_used: info.lastUsed || null,
          created_by: 'system',
          created_at: new Date(info.createdAt).toISOString(),
          revoked_at: null,
          source: 'env',
        });
      }
    }
    
    sendJson(res, 200, { keys: allKeys, total: allKeys.length });
  } catch (err) {
    logError('api', 'List keys error', err);
    sendJson(res, 500, { error: 'Failed to list API keys' });
  }
}

/** POST /acp/v1/admin/keys — Create a new API key */
async function handleCreateKey(req, res, body) {
  const auth = await authenticateAdmin(req);
  if (!auth.authenticated) { sendJson(res, 401, { error: auth.error }); return; }
  
  const { name } = body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    sendJson(res, 400, { error: 'Missing required field: name (string)' });
    return;
  }
  
  try {
    const apiKey = generateApiKey();
    const keyHash = hashKey(apiKey);
    const keyPrefix = apiKey.substring(0, 12) + '...';
    const id = `key-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    
    await run(`INSERT INTO acp_api_keys (id, name, key_hash, key_prefix, created_by) VALUES (?, ?, ?, ?, ?)`,
      [id, name.trim(), keyHash, keyPrefix, auth.user.username]);
    
    // Add to in-memory map
    API_KEYS.set(keyHash, {
      id, name: name.trim(), keyPrefix, source: 'db',
      createdAt: Date.now(), callCount: 0,
    });
    
    log('api', `API key created: ${name.trim()} (${keyPrefix}) by ${auth.user.username}`);
    
    // Return the full key ONLY on creation (never shown again)
    sendJson(res, 201, {
      id,
      name: name.trim(),
      key: apiKey,
      key_prefix: keyPrefix,
      message: '请立即保存此 API Key，它不会再次显示。',
    });
  } catch (err) {
    logError('api', 'Create key error', err);
    sendJson(res, 500, { error: 'Failed to create API key' });
  }
}

/** DELETE /acp/v1/admin/keys/:id — Revoke an API key */
async function handleRevokeKey(req, res, keyId) {
  const auth = await authenticateAdmin(req);
  if (!auth.authenticated) { sendJson(res, 401, { error: auth.error }); return; }
  
  try {
    // Check if it's an env key
    if (keyId.startsWith('env-')) {
      sendJson(res, 400, { error: '环境变量中的 Key 不能通过 API 删除，请修改服务器环境变量。' });
      return;
    }
    
    const existing = await queryOne(`SELECT * FROM acp_api_keys WHERE id = ?`, [keyId]);
    if (!existing) {
      sendJson(res, 404, { error: 'API key not found' });
      return;
    }
    if (existing.status === 'revoked') {
      sendJson(res, 400, { error: 'API key already revoked' });
      return;
    }
    
    await run(`UPDATE acp_api_keys SET status = 'revoked', revoked_at = NOW() WHERE id = ?`, [keyId]);
    
    // Remove from in-memory map
    for (const [hash, info] of API_KEYS) {
      if (info.id === keyId) {
        API_KEYS.delete(hash);
        break;
      }
    }
    
    log('api', `API key revoked: ${existing.name} (${existing.key_prefix}) by ${auth.user.username}`);
    sendJson(res, 200, { message: 'API key revoked', id: keyId });
  } catch (err) {
    logError('api', 'Revoke key error', err);
    sendJson(res, 500, { error: 'Failed to revoke API key' });
  }
}

/** GET /acp/v1/status — Bridge status */
function handleStatus(req, res) {
  sendJson(res, 200, {
    service: 'RangerAI ACP Bridge',
    version: '1.2.0',
    uptime: Math.floor(process.uptime()),
    adapters: { dingtalk: getDingTalkStatus() },
    api: {
      keys_loaded: API_KEYS.size,
      rate_limit: `${RATE_LIMIT_MAX_REQUESTS} req/min`,
      active_async_tasks: asyncTasks.size,
    },
  });
}

/** GET /acp/v1/health — Health check */
function handleHealth(req, res) {
  sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
}

// ─── HTTP Server ────────────────────────────────────────────
function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${ACP_PORT}`);
    const pathname = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      sendJson(res, 204, null);
      return;
    }

    // Health check (no auth required)
    if (pathname === '/acp/v1/health' && method === 'GET') {
      handleHealth(req, res);
      return;
    }

    // Status (no auth required for basic status)
    if (pathname === '/acp/v1/status' && method === 'GET') {
      handleStatus(req, res);
      return;
    }

    // ─── Admin Key Management Routes (JWT auth via main service) ─────────
    if (pathname === '/acp/v1/admin/keys' && method === 'GET') {
      await handleListKeys(req, res);
      return;
    }
    if (pathname === '/acp/v1/admin/keys' && method === 'POST') {
      const body = await parseBody(req);
      await handleCreateKey(req, res, body);
      return;
    }
    if (pathname.startsWith('/acp/v1/admin/keys/') && method === 'DELETE') {
      const keyId = pathname.split('/acp/v1/admin/keys/')[1];
      await handleRevokeKey(req, res, keyId);
      return;
    }

    // ─── ACP API Routes (API Key auth) ──────────────────
    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
      sendJson(res, 401, { error: auth.error });
      return;
    }

    const rateCheck = checkRateLimit(auth.apiKeyHash);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', rateCheck.resetIn);
      sendJson(res, 429, { error: 'Rate limit exceeded', retry_after: rateCheck.resetIn });
      return;
    }

    try {
      if (pathname === '/acp/v1/chat' && method === 'POST') {
        const body = await parseBody(req);
        await handleChat(req, res, body, auth);
      } else if (pathname === '/acp/v1/chat/async' && method === 'POST') {
        const body = await parseBody(req);
        await handleChatAsync(req, res, body, auth);
      } else if (pathname.startsWith('/acp/v1/task/') && method === 'GET') {
        const taskId = pathname.split('/acp/v1/task/')[1];
        await handleTaskStatus(req, res, taskId);
      } else if (pathname === '/acp/v1/knowledge/search' && method === 'POST') {
        const body = await parseBody(req);
        await handleKnowledgeSearch(req, res, body, auth);
      } else {
        sendJson(res, 404, {
          error: 'Not found',
          available_endpoints: [
            'POST /acp/v1/chat',
            'POST /acp/v1/chat/async',
            'GET  /acp/v1/task/:id',
            'POST /acp/v1/knowledge/search',
            'GET  /acp/v1/status',
            'GET  /acp/v1/health',
            'GET  /acp/v1/admin/keys (admin)',
            'POST /acp/v1/admin/keys (admin)',
            'DELETE /acp/v1/admin/keys/:id (admin)',
          ],
        });
      }
    } catch (err) {
      logError('api', `Request error: ${method} ${pathname}`, err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  return server;
}

// ─── Main Entry Point ───────────────────────────────────────
async function main() {
  log('main', '═══════════════════════════════════════════════');
  log('main', '  RangerAI ACP Bridge v1.2.0 (Iter-50)');
  log('main', '  Decoupled: Admin auth via main service HTTP');
  log('main', '═══════════════════════════════════════════════');

  // Iter-50: Database initialization is now handled by acp-bridge.mjs
  // ensureAcpUser() triggers initDatabase() internally via database.mjs import
  // This ensures a single initialization path instead of duplicate initDatabase() calls
  await ensureAcpUser();
  log('main', 'ACP user ensured (DB initialized via acp-bridge)');

  await initApiKeysTable();
  await loadApiKeys();

  if (DINGTALK_ENABLED) {
    const dtOk = await initDingTalk();
    log('main', dtOk ? 'DingTalk adapter: CONNECTED' : 'DingTalk adapter: FAILED (will retry on restart)');
  } else {
    log('main', 'DingTalk adapter: DISABLED (set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET to enable)');
  }

  const server = createServer();
  server.listen(ACP_PORT, '127.0.0.1', () => {
    log('main', `ACP API Gateway listening on port ${ACP_PORT}`);
    log('main', `Endpoints: http://127.0.0.1:${ACP_PORT}/acp/v1/`);
    log('main', '─────────────────────────────────────────────');
  });

  const shutdown = () => {
    clearInterval(_acpCleanupTimer);
    log('main', 'Shutting down ACP Bridge...');
    shutdownDingTalk();
    server.close(() => { log('main', 'ACP Bridge shut down'); process.exit(0); });
    setTimeout(() => process.exit(1), 10000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  logError('main', 'Fatal error', err);
  process.exit(1);
});
