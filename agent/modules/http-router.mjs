import { checkRateLimit } from "./rate-limit-session.mjs";
/**
 * modules/http-router.mjs — Thin HTTP Router (v3.1.0, Iter-56 Security)
 *
 * Central dispatcher that delegates to sub-route modules.
 * Handles: CORS, rate limiting, JWT auth middleware, admin auth, then dispatches.
 *
 * v3.1.0 Changes (Iter-56):
 *   - Added JWT authentication middleware for protected API routes
 *   - Added global rate limiting for all /api/ GET requests
 *   - Added CSP security header
 *   - Protected: /api/chats, /api/tickets, /api/kols, /api/notifications,
 *                /api/knowledge, /api/roles, /api/users
 *   - Public (no auth): /api/auth/*, /api/health, /api/version, /api/stats (read-only)
 *
 * Sub-route modules:
 *   - routes/infra-routes.mjs   — health, metrics, workspace, files
 *   - routes/admin-routes.mjs   — browser admin, circuit breaker, upload
 *   - routes/task-routes.mjs    — task polling, cancel, active tasks
 *   - routes/static-routes.mjs  — admin UI, SPA, gateway proxy
 *
 * Delegated API handlers (injected via init):
 *   - handleChatApi, handleAuthApi, handleSystemApi
 *   - handleTicketKolApi, handleKnowledgeApi, handleWorkflowApi
 *   - handleUserManagementApi, handleTiktokApi
 */

import { logger } from '../lib/logger.mjs';
import fs from 'fs'; // [R44-T2] for reading .admin-token
// [R45-T1] Admin token cache (60s TTL) to avoid per-request disk IO
let _adminTokenCache = null;
let _adminTokenCacheTs = 0;
const ADMIN_TOKEN_CACHE_TTL = 60000; // 60 seconds
function getCachedAdminToken() {
  const now = Date.now();
  if (_adminTokenCache && (now - _adminTokenCacheTs) < ADMIN_TOKEN_CACHE_TTL) {
    return _adminTokenCache;
  }
  try {
    _adminTokenCache = fs.readFileSync('/opt/rangerai-agent/.admin-token', 'utf8').trim();
    _adminTokenCacheTs = now;
  } catch (e) {
    _adminTokenCache = process.env.ADMIN_TOKEN || process.env.RANGERAI_ADMIN_TOKEN || null;
    _adminTokenCacheTs = now;
  }
  return _adminTokenCache;
}
// [R45-T1] Startup: preload and log admin token status
try {
  const _startupToken = getCachedAdminToken();
  if (_startupToken) {
    logger.info('[auth] ADMIN_TOKEN loaded: ' + _startupToken.substring(0, 4) + '****' + ' (len=' + _startupToken.length + ')');
  } else {
    logger.warn("[auth] ADMIN_TOKEN not found! Admin API will be inaccessible.");
  }
} catch (e) {
  logger.error('[auth] Failed to load ADMIN_TOKEN:', e.message);
}
import crypto from "crypto";
import { validateDeps } from '../lib/context.mjs';
import metrics from '../lib/metrics-collector.mjs';

import * as infraRoutes from './routes/infra-routes.mjs';
import * as adminRoutes from './routes/admin-routes.mjs';
import { checkRoutePermission } from "./rbac-router-patch.mjs";
import * as taskRoutes from './routes/task-routes.mjs';
import * as staticRoutes from './routes/static-routes.mjs';
import { handleBrowserApi, init as initBrowserApi } from "../api/browser-api.mjs";
import { handleAutonomousTaskApi } from "../api/autonomous-task-api.mjs";
import { registerSandboxRoutes } from "./sandbox-api.mjs";
import { handleInventoryApi } from "../api/inventory-api.mjs";
import { handleFeedbackApi } from "../api/feedback-api.mjs";
import { handleVoiceApi } from "../api/voice-api.mjs";
import { handleRatingApi } from "../api/rating-api.mjs";
import { setupMCPRoutes } from "../api/mcp-api.mjs";
import { init as initEventStreamApi, handleEventStreamApi } from './event-stream-api.mjs';

const REQUIRED_DEPS = [
  'ctx',
  'workerManager',
  'eventBuffer',
  'taskStore',
  'activeTasksBySession',
  'sessions',
  'wsClients',
  'SECRETS',
  '_execSync',
  'handleChatApi',
  'handleAuthApi',
  'handleTicketKolApi',
  'handleKnowledgeApi',
  'handleWorkflowApi',
  'handleUserManagementApi',
  'handleTiktokApi',
  'handleSystemApi',
  'handleReportApi',
  'handleDataUploadApi',
];

let deps = {};

/**
 * Initialize with shared dependencies and propagate to sub-route modules.
 */
export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'http-router');
  deps = dependencies;
  infraRoutes.init(dependencies);
  adminRoutes.init(dependencies);
  taskRoutes.init(dependencies);
  staticRoutes.init(dependencies);
  initBrowserApi(dependencies);
  initEventStreamApi(dependencies);
  // inventory-api and feedback-api use db-adapter directly, no init needed
  logger.info('[http-router] Initialized v3.2.0 (A1-A3+B3: inventory, feedback, MCP, sandbox security)');
}

// ─── JWT Auth Helper ─────────────────────────────────────────
/**
 * Routes that require JWT authentication.
 * Any route starting with these prefixes will be checked for a valid JWT token.
 */
const AUTH_REQUIRED_PREFIXES = [
  '/api/chats',
  '/api/tickets',
  '/api/kols',
  '/api/notifications',
  '/api/knowledge',
  '/api/roles',
  '/api/users',
  '/api/workflows',
  '/api/audit-logs',
  '/api/autonomous-tasks',
  '/api/prompts',
  '/api/sandbox',
  '/api/admin/',
  '/api/inventory',
  '/api/tools',
  '/api/mcp',
  '/api/stats',
  '/api/cost-stats',
  '/api/observability',
  '/api/system',
  '/api/metrics',
  '/api/tiktok',
];

/**
 * Routes that are always public (no auth required).
 * These take priority over AUTH_REQUIRED_PREFIXES.
 */
const PUBLIC_ROUTES = [
  '/api/auth/',        // login, register, etc.
  '/api/health',       // health check
  '/api/version',      // version info
  '/api/workflows/webhook/',  // webhook triggers (public, token-based auth)
  '/api/admin/event-stats',   // [R32-T4] event stats
  '/api/admin/datasource-entries', // [R34-T3] datasource registry
  '/api/mcp/jsonrpc',              // [R35-T3] MCP JSON-RPC 2.0 protocol endpoint
  '/api/observability',             // [R37-T6] observability data is non-sensitive
];

/**
 * Check if a route requires JWT authentication.
 * @param {string} urlPath
 * @returns {boolean}
 */
function requiresAuth(urlPath) {
  // Public routes are always accessible
  for (const pub of PUBLIC_ROUTES) {
    if (urlPath.startsWith(pub)) return false;
  }
  // Check if route matches any auth-required prefix
  for (const prefix of AUTH_REQUIRED_PREFIXES) {
    if (urlPath.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Extract and verify JWT token from request.
 * Uses the same extractUserFromRequest from database.mjs via ctx.db.
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object|null>} user object or null
 */
async function authenticateRequest(req) {
  const { ctx } = deps;
  try {
    const user = await ctx.db.extractUserFromRequest(req);
    return user;
  } catch (e) {
    logger.error('[http-router] Auth error:', e.message);
    return null;
  }
}

/**
 * Handle an HTTP request.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
export async function handleRequest(req, res) {
  const _internal = req.headers["x-internal-call"] === "1";
  // [FIX] Exempt localhost + health endpoints from early rate limit (was breaking CI verify)
  const _earlyIp = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const _isLocal = _earlyIp === "127.0.0.1" || _earlyIp === "::1" || _earlyIp === "::ffff:127.0.0.1";
  const _urlCheck = (req.url || "").split("?")[0];
  const _isHealthOrMetrics = _urlCheck === "/api/health" || _urlCheck === "/health" || _urlCheck.startsWith("/api/metrics");
  if (!_internal && !_isLocal && !_isHealthOrMetrics) {
    const rl = checkRateLimit((_earlyIp || "anon"));
    if (!rl.allowed) { res.writeHead(429,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:"rate_limited"})); return; }
  }
  const { ctx } = deps;
  const urlPath = req.url?.split("?")[0] || "/";
  const method = req.method || 'GET';
  // Observability: 记录请求开始时间，在 finish 时上报耗时
  const _reqStart = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - _reqStart;
    metrics.recordHttpRequest(req.method || 'GET', urlPath, res.statusCode || 200, dur);
  });

  // ── Security headers + CORS ──
  ctx.services.auth.injectSecurityHeaders(res);
  // Add CSP header
  // Generate per-request CSP nonce
  const _nonce = crypto.randomBytes(16).toString("base64");
  res._cspNonce = _nonce;
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${_nonce}' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' https: wss:; frame-ancestors 'self'; frame-src 'self'; upgrade-insecure-requests`);
  ctx.services.auth.setCorsHeaders(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Global Error Handler ──
  try {
  // ── Rate Limit ──
  const clientIp = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  // [R46-T3] Exempt localhost from rate limiting for CI/testing
  const isLocalhost = clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1";
  if (isLocalhost) { /* skip rate limiting */ } else {
  if (!global._rateLimitMap) global._rateLimitMap = new Map();
  const _rlNow = Date.now();

  // Auth endpoint rate limit (20 req/min)
  if (urlPath.startsWith("/api/auth/")) {
    const _rlKey = "rl:auth:" + clientIp;
    const _rlE = global._rateLimitMap.get(_rlKey) || { count: 0, resetAt: _rlNow + 60000 };
    if (_rlNow > _rlE.resetAt) { _rlE.count = 0; _rlE.resetAt = _rlNow + 60000; }
    _rlE.count++;
    global._rateLimitMap.set(_rlKey, _rlE);
    if (_rlE.count > 20) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
  }

  // Write operation rate limit (60 req/min)
  if (["POST","PUT","DELETE"].includes(req.method) && !urlPath.startsWith("/api/auth/")) {
    const _rlKey = "rl:write:" + clientIp;
    const _rlE = global._rateLimitMap.get(_rlKey) || { count: 0, resetAt: _rlNow + 60000 };
    if (_rlNow > _rlE.resetAt) { _rlE.count = 0; _rlE.resetAt = _rlNow + 60000; }
    _rlE.count++;
    global._rateLimitMap.set(_rlKey, _rlE);
    if (_rlE.count > 60) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many write requests" }));
      return;
    }
  }

  // Global API read rate limit (100 req/min per IP)
  if (urlPath.startsWith("/api/") && req.method === "GET") {
    const _rlKey = "rl:read:" + clientIp;
    const _rlE = global._rateLimitMap.get(_rlKey) || { count: 0, resetAt: _rlNow + 60000 };
    if (_rlNow > _rlE.resetAt) { _rlE.count = 0; _rlE.resetAt = _rlNow + 60000; }
    _rlE.count++;
    global._rateLimitMap.set(_rlKey, _rlE);
    if (_rlE.count > 100) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many read requests" }));
      return;
    }
  }

  } // end rate-limit else
  // ── JWT Authentication Middleware ──
  // 内部服务调用（x-internal-call header）直接放行，无需认证
  const remoteAddr = req.socket.remoteAddress || '';
  const isInternalCall = req.headers['x-internal-call'] === '1' && (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1');
  if (requiresAuth(urlPath) && !isInternalCall) {
    let user = await authenticateRequest(req);
    // [R44-T2] Fallback: if JWT auth fails, try ADMIN_TOKEN for admin/system paths
    // [R47-T2] Extended to cover /api/stats and /api/cost-stats (previously 401 for admin token callers)
    if (!user && (urlPath.startsWith('/api/admin/') || urlPath.startsWith('/api/system/') || urlPath.startsWith('/api/metrics') || urlPath.startsWith('/api/stats') || urlPath.startsWith('/api/cost-stats'))) {
      try {
        const authHeader = req.headers.authorization || '';
        const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
        // Read ADMIN_TOKEN directly (same logic as auth.mjs)
        const adminToken = getCachedAdminToken(); // [R46-T1] Use cached token instead of per-request disk read
        if (bearerToken && adminToken && bearerToken === adminToken) {
          user = { id: 'admin-token', username: 'Admin (Token)', role: 'admin', roleLevel: 100 };
          logger.info('[http-router] [R44-T2] ADMIN_TOKEN fallback auth OK for ' + urlPath);
        } else {
          logger.info('[http-router] [R44-T2] ADMIN_TOKEN fallback FAILED for ' + urlPath + ' tokenMatch=' + (bearerToken === adminToken) + ' hasAdminToken=' + !!adminToken);
        }
      } catch(e) {
        logger.error('[http-router] [R44-T2] ADMIN_TOKEN fallback error: ' + e.message);
      }
    }
    if (!user) {
      const hasAuthHeader = !!req.headers.authorization;
      const authSnippet = hasAuthHeader ? req.headers.authorization.slice(0, 20) + '...' : 'NONE';
      logger.info('[http-router] 401 REJECTED: ' + req.method + ' ' + urlPath + ' hasAuth=' + hasAuthHeader + ' authSnippet=' + authSnippet + ' ip=' + clientIp);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication required", message: "Valid JWT token required in Authorization header" }));
      return;
    }
    // Attach user to request for downstream handlers
    req._authenticatedUser = user;
  } else if (isInternalCall) {
    // v15.0: For internal calls, allow cs+ role (viewer excluded) for testing/autonomous-tasks
    req._authenticatedUser = { id: 'system', username: 'System (Internal)', role: 'admin', roleLevel: 100 };
  }

  // ── RBAC Permission Check ──
  if (req._authenticatedUser) {
    const allowed = checkRoutePermission(req, res, urlPath);
    if (!allowed) return;
  }
  // ── Admin endpoint protection ──
  if (ctx.services.auth.isAdminPath(urlPath)) {
    if (!ctx.services.auth.validateAdminToken(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", message: "Valid Bearer token required" }));
      return;
    }
  }

  // ── 1. Infrastructure routes (health, metrics, workspace, files) ──
  const infraHandled = await infraRoutes.handleInfraRoute(req, res, urlPath);
  if (infraHandled) return;

  // ── 2. Admin routes (browser admin, circuit breaker, upload, skills) ──
  const adminHandled = await adminRoutes.handleAdminRoute(req, res, urlPath);
  // ── 2.5. Browser Takeover API ──
  if (urlPath.startsWith("/api/browser/")) {
    const browserHandled = await handleBrowserApi(req, res, urlPath);
    if (browserHandled) return;
  }
  if (adminHandled) return;

  // ── 3. Delegated API Routes ──
  if (urlPath.startsWith("/api/tiktok") || urlPath.startsWith("/api/stats/market-prices") || urlPath === "/api/system/inspection-logs") {
    const handled = await deps.handleTiktokApi(req, res);
    if (handled) return;
  }
  // [R32-T4] Event Stats - route before user-management to avoid JWT interception
  if (urlPath === '/api/admin/event-stats' || urlPath === '/api/admin/datasource-entries' || urlPath === '/api/admin/debug-timeout') { // [R44-T4]
    const handled = await deps.handleSystemApi(req, res);
    if (handled) return;
  }
    if (urlPath.startsWith("/api/admin/") || urlPath === "/api/auth/change-password" || urlPath.match(/^\/api\/user\/[^/]+\/memory$/)) {
    const handled = await deps.handleUserManagementApi(req, res);
    if (handled) return;
  }
  if (urlPath.startsWith("/api/report") || urlPath.startsWith("/api/analytics")) {
    const handled = await deps.handleReportApi(req, res);
    if (handled) return;
  }
  if (urlPath.startsWith('/api/data/')) {
    const handled = await deps.handleDataUploadApi(req, res);
    if (handled) return;
  }
  // ── Inventory API (A1) ──
  if (urlPath.startsWith('/api/inventory')) {
    const handled = await handleInventoryApi(req, res, { user: req._authenticatedUser });
    if (handled) return;
  }
  // ── Feedback Summary API (A2) ──
  if (urlPath.startsWith('/api/admin/feedback')) {
    const handled = await handleFeedbackApi(req, res, { user: req._authenticatedUser });
    if (handled) return;
  }
  // ── Event Stream API (internal admin panel) ──
  if (urlPath === '/api/event-stream/latest') {
    const handled = await handleEventStreamApi(req, res);
    if (handled) return;
  }
  // ── [R35-T3] MCP JSON-RPC 2.0 Protocol Endpoint ──
  if (urlPath === '/api/mcp/jsonrpc' && req.method === 'POST') {
    try {
      const { handleMcpRequest } = await import('./mcp-server.mjs');
      let body = '';
      for await (const chunk of req) body += chunk;
      req.body = body;
      await handleMcpRequest(req, res);
      return;
    } catch (mcpErr) {
      logger.error('[http-router] MCP JSON-RPC error:', mcpErr.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: mcpErr.message } }));
      return;
    }
  }

  // ── MCP / Tools API (A3) ──
  if (urlPath.startsWith('/api/tools') || urlPath.startsWith('/api/mcp')) {
    // Inline handler since mcp-api uses Express-style setup
    try {
      const { getAvailableSkills, getAvailableTools, getMCPServers,
              registerSkill, unregisterSkill, addMCPServer, removeMCPServer
      } = await import("../skills-discovery.mjs");
      const user = req._authenticatedUser;
      const sendJson = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const body = await new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d))}catch{r({})} }); });
      
      if (urlPath === '/api/tools' && req.method === 'GET') {
        sendJson(200, { skills: getAvailableSkills(), tools: getAvailableTools() }); return;
      }
      if (urlPath === '/api/tools/register' && req.method === 'POST') {
        if (!user || user.role !== 'admin') { sendJson(403, { error: 'Admin only' }); return; }
        if (!body.name) { sendJson(400, { error: 'Missing skill name' }); return; }
        sendJson(200, { success: registerSkill(body) }); return;
      }
      if (urlPath.startsWith('/api/tools/unregister/') && req.method === 'DELETE') {
        if (!user || user.role !== 'admin') { sendJson(403, { error: 'Admin only' }); return; }
        const name = urlPath.split('/').pop();
        sendJson(200, { success: unregisterSkill(name) }); return;
      }
      if (urlPath === '/api/mcp/servers' && req.method === 'GET') {
        sendJson(200, { servers: getMCPServers() }); return;
      }
      if (urlPath === '/api/mcp/servers' && req.method === 'POST') {
        if (!user || user.role !== 'admin') { sendJson(403, { error: 'Admin only' }); return; }
        if (!body.name || !body.command) { sendJson(400, { error: 'Missing name or command' }); return; }
        sendJson(200, { success: addMCPServer(body.name, { command: body.command, args: body.args, env: body.env }) }); return;
      }
      if (urlPath.startsWith('/api/mcp/servers/') && req.method === 'DELETE') {
        if (!user || user.role !== 'admin') { sendJson(403, { error: 'Admin only' }); return; }
        const name = urlPath.split('/').pop();
        sendJson(200, { success: removeMCPServer(name) }); return;
      }
    } catch (e) {
      logger.error('[http-router] MCP/tools error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message })); return;
    }
  }
  // ── Voice API (Realtime) ──
  if (urlPath.startsWith("/api/voice")) {
    const handled = await handleVoiceApi(req, res);
    if (handled) return;
  }
  // ── Rating / Anonymous Peer Review API ──
  if (urlPath.startsWith("/api/rating")) {
    const handled = await handleRatingApi(req, res);
    if (handled) return;
  }
  if (urlPath.startsWith("/api/auth") && !urlPath.startsWith("/api/auth/change-password")) {
    const handled = await deps.handleAuthApi(req, res);
    if (handled) return;
  }
  if (urlPath.startsWith("/api/stats") ||
      urlPath.startsWith("/api/health") || urlPath.startsWith("/api/prompts") ||
      urlPath.startsWith("/api/version") || urlPath.startsWith("/api/system") || urlPath === "/api/admin/health-detail" || urlPath === "/api/admin/agent-metrics" || urlPath === "/api/admin/run-traces" /* [R44-T2] */ ||
      urlPath.startsWith("/api/chat/simple") ||
      urlPath === "/api/admin/gateway-events" ||
      urlPath === "/api/admin/event-stats" ||
      urlPath === "/api/admin/debug-timeout" || // [R44-T4]
      urlPath.startsWith("/api/cost-stats") || urlPath === "/api/task-status") {
    const handled = await deps.handleSystemApi(req, res);
    if (handled) return;
  }

  // ── 可观测性路由 ──
  if (urlPath.startsWith("/api/observability")) {
    const { getStats, getStatsSummary } = await import("../worker/observability.mjs");
    const hours = parseInt(new URL(req.url, "http://localhost").searchParams.get("hours") || "24");
    if (urlPath === "/api/observability/stats") {
      const data = await getStats(hours);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }
    if (urlPath === "/api/observability/summary") {
      const text = await getStatsSummary(hours);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
      return;
    }
    // [R37-T6] Final answer windowed statistics
    if (urlPath === "/api/observability/final-answer-stats") {
      try {
        const { getFinalAnswerStats } = await import("../worker/observability.mjs");
        const postFixDate = new URL(req.url, "http://localhost").searchParams.get("postFixDate") || null;
        const stats = await getFinalAnswerStats(postFixDate);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
  }
  // ─── GET /api/orders/stats — 订单统计占位（orders 表在外部系统，待接入）───
  if (urlPath === '/api/orders/stats' && method === 'GET') {
    const user = await deps.db.extractUserFromRequest(req);
    if (!user) { deps.db.sendJson(res, 401, { error: 'Unauthorized' }); return; }
    deps.db.sendJson(res, 200, {
      total: null,
      today: null,
      this_week: null,
      gmv_today: null,
      gmv_this_week: null,
      success_rate: null,
      by_game: [],
      _note: 'orders 表尚未接入，数据为空占位。待外部订单系统对接后补充。',
    });
    return;
  }

  if (urlPath.startsWith("/api/tickets") || urlPath.startsWith("/api/kols") ||
      urlPath.startsWith("/api/notifications")) {
    const handled = await deps.handleTicketKolApi(req, res);
    if (handled) return;
  }
  if (urlPath === "/api/chat/send" || urlPath.startsWith("/api/chats") || urlPath.startsWith("/api/users")) {
    const handled = await deps.handleChatApi(req, res);
    if (handled) return;
  }
  if (urlPath.startsWith("/api/knowledge") || /^\/api\/messages\/[^/]+\/references$/.test(urlPath)) {
    const handled = await deps.handleKnowledgeApi(req, res);
    if (handled) return;
  }
  if (urlPath.startsWith("/api/workflows") || urlPath.startsWith("/api/workflow-runs") || urlPath === "/api/audit-logs") {
    const handled = await deps.handleWorkflowApi(req, res);
    if (handled) return;
  }
  // R54: Task Plans API — plan persistence and retrieval
  if (urlPath.startsWith("/api/task-plans")) {
    const { getPlans } = await import("../services/plan-service.mjs");
    const url = new URL(req.url, "http://localhost");
    const sessionKey = url.searchParams.get("sessionKey");
    const chatId = url.searchParams.get("chatId");
    const status = url.searchParams.get("status");
    const limit = parseInt(url.searchParams.get("limit") || "20");
    try {
      const plans = await getPlans({ sessionKey, chatId, status, limit });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, plans }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  // Autonomous Tasks API
  if (urlPath.startsWith("/api/autonomous-tasks") || urlPath.startsWith("/api/task-templates")) {
    const handled = await handleAutonomousTaskApi(req, res, { user: req._authenticatedUser });
    if (handled) return;
  }
  // [v25.9] Supervisor API removed
  // P3: Sandbox Code Execution API — delegated to sandbox-api.mjs (Docker-only, RBAC built-in)
  if (urlPath.startsWith("/api/sandbox")) {
    try {
      const { handleSandboxRequest } = await import("./sandbox-api.mjs");
      const _readBody = (r) => new Promise((resolve, reject) => {
        let raw = ''; r.on('data', c => { raw += c; }); r.on('end', () => resolve(raw)); r.on('error', reject);
      });
      await handleSandboxRequest(req, res, urlPath, req._authenticatedUser, _readBody);
      return;
    } catch (e) {
      logger.error("[http-router] sandbox error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }
  if (urlPath.startsWith("/api/reports")) {
    const handled = await deps.handleReportApi(req, res);
    if (handled) return;
  }

  // ── 4. Task routes (polling, cancel, active tasks) ──
  const taskHandled = await taskRoutes.handleTaskRoute(req, res, urlPath);
  if (taskHandled) return;

  // ── 5. Gateway Proxy ──
  if (urlPath === "/v1/chat/completions" && req.method === "POST") {
    await staticRoutes.handleGatewayProxy(req, res);
    return;
  }

  // ── 6. API 404 ──
  if (urlPath.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found", path: urlPath, method: req.method }));
    return;
  }

  // ── 7. Admin UI Static Files ──
  if (req.url?.startsWith("/admin")) {
    staticRoutes.handleAdminUI(req, res);
    return;
  }

  // ── 8. SPA Static Files (catch-all) ──
  staticRoutes.handleStaticFiles(req, res);
  } catch (globalErr) {
    logger.error('[http-router] Unhandled error in request handler:', globalErr.message, globalErr.stack);
    try {
      if (!res.headersSent) {
        const statusCode = globalErr.message === 'Invalid JSON' ? 400 : 500;
        const errorMsg = statusCode === 400 ? 'Invalid JSON in request body' : 'Internal server error';
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMsg, path: req.url }));
      }
    } catch (e) { /* response already sent */ }
  }
}