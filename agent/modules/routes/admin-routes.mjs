/**
 * modules/routes/admin-routes.mjs — Admin Routes (v1.0.0, Iter-53)
 *
 * Extracted from http-routes.mjs:
 *   - /api/admin/browser-status
 *   - /api/admin/recover-browser
 *   - /api/admin/reset-browser-breaker
 *   - /api/admin/circuit-breaker/status
 *   - /admin/restart-worker
 *   - /admin/restart-gateway
 *   - /upload
 *   - /api/skills
 */

import logger from "../../lib/logger.mjs";

import fs from "fs";
import path from "path";
import { ts } from "../helpers.mjs";
import { execSync, spawn } from 'child_process';
import { extractUserFromRequest, verifyToken } from '../../services/user-service.mjs';
import { getChatById, getChatBySessionKey, createMessage, getConversationHistory } from '../../services/chat-service.mjs';
import { randomUUID } from 'crypto';

let deps = {};

export function init(dependencies) {
  deps = dependencies;
}

/**
 * Try to handle an admin route. Returns true if handled.
 */
export async function handleAdminRoute(req, res, urlPath) {
  // ─── Browser Admin API (JWT auth) ───
  if (urlPath === "/api/admin/browser-status" && req.method === "GET") {
    const currentUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅管理员可执行此操作" }));
      return true;
    }
    handleBrowserStatus(req, res); return true;
  }
  if (urlPath === "/api/admin/recover-browser" && req.method === "POST") {
    const currentUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅管理员可执行此操作" }));
      return true;
    }
    const success = deps.workerManager.recoverBrowser();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: success, message: success ? "浏览器恢复命令已发送" : "Worker 不可用" }));
    return true;
  }
  if (urlPath === "/api/admin/reset-browser-breaker" && req.method === "POST") {
    const currentUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅管理员可执行此操作" }));
      return true;
    }
    handleResetBrowserBreaker(req, res); return true;
  }

  // ─── Skills Discovery API ───
  if (urlPath === "/api/skills" && req.method === "GET") {
    const currentUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!currentUser) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication required" }));
      return true;
    }
    const skills = deps.getAvailableSkills ? deps.getAvailableSkills() : [];
    const providers = deps.getAvailableProviders ? deps.getAvailableProviders() : [];
    const tools = deps.getAvailableTools ? deps.getAvailableTools() : [];
    const capabilities = deps.getSystemCapabilities ? deps.getSystemCapabilities() : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills, providers, tools, capabilities }));
    return true;
  }

  // ─── Circuit Breaker Status API (admin only) ───
  if (urlPath === "/api/admin/circuit-breaker/status" && req.method === "GET") {
    const currentUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Admin access required" }));
      return true;
    }
    try {
      const wm = deps.workerManager;
      const status = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);
        const reqId = `cb-${Date.now()}`;
        const handler = (msg) => {
          if (msg.type === "browser_status" && msg.reqId === reqId) {
            clearTimeout(timeout);
            wm.worker?.off("message", handler);
            resolve(msg.status || {});
          }
        };
        if (!wm.worker) { clearTimeout(timeout); reject(new Error("Worker not running")); return; }
        wm.worker.on("message", handler);
        wm.worker.send({ type: "get_browser_status", reqId });
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ browserBreaker: status, workerStatus: wm.status }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, workerStatus: deps.workerManager?.status || {} }));
    }
    return true;
  }

  // ─── Admin Endpoints (legacy paths) ───
  if (urlPath === "/admin/restart-worker" && req.method === "POST") {
    deps.workerManager.restartWorker();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Worker restart initiated" }));
    return true;
  }
  if (urlPath === "/admin/restart-gateway" && req.method === "POST") {
    handleAdminRestartGateway(req, res); return true;
  }

  // ─── Restart Panel API (JWT-protected, used by frontend restart panel) ───
  if (urlPath.startsWith("/api/admin/restart/") && req.method === "POST") {
    await handleRestartApi(req, res, urlPath); return true;
  }

  // ─── Service Status API ───
  if (urlPath === "/api/admin/services/status" && req.method === "GET") {
    handleServicesStatus(req, res); return true;
  }

  // ─── R60: Adaptive Memory Stats API ───
  if (urlPath === "/api/admin/adaptive-memory/stats" && req.method === "GET") {
    const currentUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "仅管理员可执行此操作" }));
      return true;
    }
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database("/opt/rangerai-agent/db/rangerai.db", { readonly: true });
      
      // 1. Category summary
      const categories = db.prepare(`
        SELECT category, COUNT(*) as count, COALESCE(SUM(hitCount), 0) as totalHits,
        COALESCE(AVG(score), 0) as avgScore
        FROM adaptive_memory GROUP BY category
      `).all();
      
      // 2. Top tool experiences by hitCount
      const topTools = db.prepare(`
        SELECT title as key, content, metadata, hitCount, score, updatedAt
        FROM adaptive_memory WHERE category = 'adaptive_tool_experience'
        ORDER BY hitCount DESC LIMIT 20
      `).all();
      
      // 3. Parse tool experience metadata for subType and duration stats (R60 fix)
      const toolStats = topTools.map(t => {
        let meta = {};
        try { meta = JSON.parse(t.metadata || '{}'); } catch(_err) { /* v22.0 */ console.error("[admin-routes] silent catch:", _err?.message || _err); }
        return {
          key: t.key,
          subType: meta.subType || (t.key || '').split(':')[0] || 'unknown',
          durationMs: meta.durationMs || null,
          success: meta.success ?? null,
          hitCount: t.hitCount,
          score: t.score,
          updatedAt: t.updatedAt,
          contentPreview: (t.content || '').slice(0, 200),
        };
      });
      
      // 4. SubType aggregation
      const subTypeAgg = {};
      for (const t of toolStats) {
        if (!subTypeAgg[t.subType]) {
          subTypeAgg[t.subType] = { count: 0, totalHits: 0, successCount: 0, failCount: 0, totalDuration: 0, durationCount: 0 };
        }
        const agg = subTypeAgg[t.subType];
        agg.count++;
        agg.totalHits += t.hitCount;
        if (t.success === true) agg.successCount++;
        if (t.success === false) agg.failCount++;
        if (t.durationMs !== null) { agg.totalDuration += t.durationMs; agg.durationCount++; }
      }
      
      // 5. Recent task patterns
      const recentPatterns = db.prepare(`
        SELECT title as key, content, metadata, hitCount, score, updatedAt
        FROM adaptive_memory WHERE category = 'adaptive_task_pattern'
        ORDER BY updatedAt DESC LIMIT 10
      `).all();
      
      // 6. Total record count
      const totalRow = db.prepare(`SELECT COUNT(*) as total FROM adaptive_memory`).get();
      
      db.close();
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        total: totalRow.total,
        categories,
        toolStats,
        subTypeAgg,
        recentPatterns: recentPatterns.map(p => ({
          key: p.key,
          hitCount: p.hitCount,
          score: p.score,
          updatedAt: p.updatedAt,
          contentPreview: (p.content || '').slice(0, 300),
        })),
      }));
    } catch (err) {
      logger.error(`[admin] adaptive-memory stats error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── File Upload ───
  if (urlPath === "/upload" && req.method === "POST") {
    handleFileUpload(req, res); return true;
  }

  // ─── T5: Inject Task into existing/completed chat ───
  if (urlPath === "/api/admin/inject-task" && req.method === "POST") {
    await handleInjectTask(req, res); return true;
  }

  // ─── R50-T1: Token Cost Stats ───
  if (urlPath === "/api/admin/token-stats" && req.method === "GET") {
    await handleTokenStats(req, res); return true;
  }

  return false;
}

// ─── Handlers ──────────────────────────────────────────────

async function handleBrowserStatus(req, res) {
  const { workerManager } = deps;
  try {
    // Iter-59: Use IPC request-response instead of direct worker.on/send
    if (workerManager.sendRequest) {
      const resp = await workerManager.sendRequest({ type: "get_browser_status" }, 5000);
      if (resp.error) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: resp.error, connected: false }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...(resp.data?.status || {}), connected: true }));
      }
    } else {
      // Fallback: direct worker access (single-process mode)
      const reqId = `bs-${Date.now()}`;
      const timeout = setTimeout(() => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Worker not responding" }));
      }, 5000);
      const handler = (msg) => {
        if (msg.type === "browser_status" && msg.reqId === reqId) {
          clearTimeout(timeout);
          workerManager.worker?.removeListener("message", handler);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...msg.status, connected: true }));
        }
      };
      if (workerManager.worker) {
        workerManager.worker.on("message", handler);
        workerManager.worker.send({ type: "get_browser_status", reqId });
      } else {
        clearTimeout(timeout);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Worker not available", connected: false }));
      }
    }
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message, connected: false }));
  }
}

async function handleResetBrowserBreaker(req, res) {
  const { workerManager } = deps;
  try {
    // Iter-59: Use IPC request-response instead of direct worker.on/send
    if (workerManager.sendRequest) {
      const resp = await workerManager.sendRequest({ type: "reset_browser_breaker" }, 5000);
      if (resp.error) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: resp.error }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "浏览器熔断器已重置 + chromium 已清理" }));
      }
    } else {
      // Fallback: direct worker access (single-process mode)
      const reqId = `rbr-${Date.now()}`;
      const timeout = setTimeout(() => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Worker not responding" }));
      }, 5000);
      const handler = (msg) => {
        if (msg.type === "browser_breaker_reset" && msg.reqId === reqId) {
          clearTimeout(timeout);
          workerManager.worker?.removeListener("message", handler);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, message: "浏览器熔断器已重置 + chromium 已清理" }));
        }
      };
      if (workerManager.worker) {
        workerManager.worker.on("message", handler);
        workerManager.worker.send({ type: "reset_browser_breaker", reqId });
      } else {
        clearTimeout(timeout);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Worker not available" }));
      }
    }
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Restart Panel Handler ─────────────────────────────────

async function handleRestartApi(req, res, urlPath) {
  process.stderr.write('[handleRestartApi] ENTERED urlPath=' + urlPath + '\n');
  // JWT auth check（直接用 user-service，避免 ctx.db 未挂载导致挂起）
  try {
    // 纯JWT验证（不查DB，不会因MySQL慢查询卡住）
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    const payload = verifyToken(authHeader.slice(7));
    if (!payload || payload.role !== 'admin') {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Admin only" }));
      return;
    }
  } catch (e) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized: " + e.message }));
    return;
  }

  const service = urlPath.split('/').pop();
  logger.info(`[${ts()}] [restart-panel] Restart request: ${service}`);
  process.stderr.write('[restart-panel-debug] service=' + service + '\n');

  try {
    switch (service) {
      case 'worker':
        // Safe: restart agent worker sub-process (not the main server)
        deps.workerManager.restartWorker();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Agent Worker 正在重启，约5秒后恢复" }));
        break;

      case 'rangerai-agent':
        // Deferred restart: respond first, then fire-and-forget restart via spawn (non-blocking)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "rangerai-agent 将在3秒后重启..." }));
        // Use spawn (detached) instead of execSync to avoid blocking/timeout errors
        setTimeout(() => {
          try {
            const child = spawn('bash', ['/opt/rangerai-safety/defer-restart.sh', '3'], {
              detached: true,
              stdio: 'ignore'
            });
            child.unref();
            logger.info('[restart-panel] defer-restart spawned (detached)');
          } catch (e) {
            logger.error(`[restart-panel] defer-restart spawn failed: ${e.message}`);
          }
        }, 300);
        break;

      case 'rangerai-web':
        execSync('sudo systemctl restart rangerai-web', { timeout: 15000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "rangerai-web (前端静态服务) 已重启" }));
        break;

      case 'rangerai-static':
        execSync('sudo systemctl restart rangerai-static 2>/dev/null || true', { timeout: 10000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "rangerai-static 已重启" }));
        break;

      case 'caddy':
        execSync('sudo systemctl reload caddy', { timeout: 10000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Caddy 配置已热重载" }));
        break;

      case 'redis':
        execSync('sudo systemctl restart redis 2>/dev/null || sudo systemctl restart redis-server 2>/dev/null || true', { timeout: 15000 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Redis 已重启" }));
        break;

      default:
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Unknown service: ${service}` }));
    }
  } catch (err) {
    process.stderr.write('[restart-panel-CATCH] ' + err.message + '\n' + err.stack + '\n');
    console.error('[restart-panel] ERROR:', err.message, err.stack);
    logger.error(`[restart-panel] Restart ${service} failed: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }
}

async function handleServicesStatus(req, res) {
  const { ctx } = deps;
  try {
    const user = await extractUserFromRequest(req);
    if (!user || user.role !== 'admin') {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Admin only" }));
      return;
    }
  } catch (e) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }

  try {
    const getStatus = (svc) => {
      try { execSync(`systemctl is-active ${svc}`, { timeout: 3000 }); return 'active'; }
      catch (e) { return 'inactive'; }
    };
    const workerStatus = deps.workerManager?.status || {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      services: {
        'rangerai-agent': getStatus('rangerai-agent'),
        'rangerai-web': getStatus('rangerai-web'),
        'caddy': getStatus('caddy'),
        'redis': getStatus('redis') === 'active' ? 'active' : getStatus('redis-server'),
      },
      worker: {
        ready: workerStatus.workerReady,
        pid: workerStatus.workerPid,
        pendingTasks: workerStatus.pendingTasks,
        gatewayConnected: workerStatus.gatewayConnected,
      }
    }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

function handleAdminRestartGateway(req, res) {
  // 安全策略：后端不再提供“远程重启 openclaw-gateway”的能力。
  // 这属于高风险操作（相当于远程 kill 控制平面），容易被滥用或在误操作下造成全站不可用。
  // 如确需重启，请在服务器上人工执行，并做好变更记录。
  logger.info(`[${ts()}] [SECURITY] Blocked admin gateway restart request via API`);
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: false,
    error: "forbidden",
    message: "出于安全原因，已禁用通过 HTTP API 远程重启 openclaw-gateway。请在服务器上手动执行 openclaw gateway restart。"
  }));
}


function handleFileUpload(req, res) {
  const { ctx } = deps;
  if (!ctx.services.auth.validateAdminToken(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = Buffer.concat(chunks);
      const boundary = req.headers["content-type"]?.split("boundary=")[1];
      if (!boundary) { res.writeHead(400); res.end(JSON.stringify({ error: "No boundary" })); return; }
      const parts = body.toString("binary").split(`--${boundary}`);
      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (!filenameMatch) continue;
        const filename = filenameMatch[1].replace(/[^a-zA-Z0-9._-]/g, "_");
        const content = part.slice(headerEnd + 4, part.length - 2);
        const filePath = path.join(ctx.config.FILES_DIR, filename);
        fs.writeFileSync(filePath, content, "binary");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, filename, url: `/files/${filename}` }));
        return;
      }
      res.writeHead(400); res.end(JSON.stringify({ error: "No file found" }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ─── T5: inject-task handler ─────────────────────────────────────────────────
// POST /api/admin/inject-task
// Body: { chatId?, sessionKey?, content, taskType? }
// Auth: Bearer JWT (admin role)
// Effect: writes user message to DB, triggers worker to process it,
//         broadcasts task_injected over WS so frontend can refresh.
async function handleInjectTask(req, res) {
  // ── Auth ──
  // http-router already validated JWT/ADMIN_TOKEN and set req._authenticatedUser.
  // We trust that and just enforce admin role here.
  const authUser = req._authenticatedUser;
  if (!authUser) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'missing_auth' }));
    return;
  }
  if (authUser.role !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'admin_only' }));
    return;
  }

  // ── Parse body ──
  let body = '';
  await new Promise((resolve) => {
    req.on('data', chunk => { body += chunk; });
    req.on('end', resolve);
  });

  let params;
  try {
    params = JSON.parse(body);
  } catch (_e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'invalid_json' }));
    return;
  }

  const { chatId, sessionKey, content, taskType } = params;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'content_required' }));
    return;
  }

  if (!chatId && !sessionKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'chatId_or_sessionKey_required' }));
    return;
  }

  // ── Resolve chat record ──
  let chatRecord = null;
  try {
    if (chatId) {
      chatRecord = await getChatById(chatId);
    } else {
      chatRecord = await getChatBySessionKey(sessionKey);
    }
  } catch (dbErr) {
    logger.error(`[inject-task] DB lookup error: ${dbErr.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'db_error', detail: dbErr.message }));
    return;
  }

  if (!chatRecord) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'chat_not_found', chatId, sessionKey }));
    return;
  }

  const resolvedChatId = chatRecord.id;
  const resolvedSessionKey = chatRecord.session_key || sessionKey || chatRecord.sessionKey;

  // ── Write user message to DB ──
  const msgId = randomUUID();
  try {
    await createMessage({ chatId: resolvedChatId, role: 'user', content: content.trim(), msgId });
    logger.info(`[inject-task] saved msgId=${msgId} chatId=${resolvedChatId}`);
  } catch (dbErr) {
    logger.error(`[inject-task] createMessage failed: ${dbErr.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, reason: 'db_write_error', detail: dbErr.message }));
    return;
  }

  // ── Load conversation history ──
  let conversationHistory = [];
  try {
    conversationHistory = await getConversationHistory(resolvedChatId, 50);
  } catch (_e) {
    // best-effort, proceed without history
    logger.warn(`[inject-task] history load failed: ${_e.message}`);
  }

  // ── Broadcast task_injected to any connected WS clients ──
  const { wss } = deps;
  if (wss) {
    for (const client of wss.clients) {
      try {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'task_injected',
            msgId,
            chatId: resolvedChatId,
            sessionKey: resolvedSessionKey,
            taskType: taskType || 'admin_inject',
            content: content.trim()
          }));
        }
      } catch (_wsErr) { /* best-effort */ }
    }
  }

  // ── Dispatch to worker ──
  const { workerManager } = deps;
  if (!workerManager || !workerManager.workerReady) {
    // Worker unavailable — message saved to DB, will be picked up on recovery
    logger.warn(`[inject-task] worker not ready; message saved, will recover on restart`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      queued: false,
      worker_ready: false,
      msgId,
      chatId: resolvedChatId,
      sessionKey: resolvedSessionKey,
      note: 'message saved to DB; worker offline, will process on recovery'
    }));
    return;
  }

  try {
    // sendTask is fire-and-forget here; we respond immediately
    workerManager.sendTask(
      msgId,
      resolvedSessionKey,
      content.trim(),
      conversationHistory,
      null,            // ws — no live WS connection for admin inject
      undefined,       // model
      undefined,       // attachments
      undefined,       // roleSystemPrompt
      undefined,       // traceId
      resolvedChatId,
      'admin',         // userId (conceptual)
      'admin'          // userRole
    ).catch(taskErr => {
      logger.warn(`[inject-task] sendTask rejected (non-fatal): ${taskErr.message}`);
    });

    logger.info(`[inject-task] dispatched to worker msgId=${msgId} session=${resolvedSessionKey}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      msgId,
      chatId: resolvedChatId,
      sessionKey: resolvedSessionKey
    }));
  } catch (dispatchErr) {
    // Worker dispatch failed but message is already in DB
    logger.warn(`[inject-task] dispatch error (message saved): ${dispatchErr.message}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      queued: false,
      worker_error: dispatchErr.message,
      msgId,
      chatId: resolvedChatId,
      sessionKey: resolvedSessionKey,
      note: 'message saved to DB; dispatch failed, will recover'
    }));
  }
}

// ─── R50-T1: Token Cost Stats handler ────────────────────────────────────────
// GET /api/admin/token-stats?since=24h&groupBy=model
async function handleTokenStats(req, res) {
  const currentUser = await deps.ctx.db.extractUserFromRequest(req);
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'manager')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '仅管理员可访问' }));
    return;
  }

  try {
    const urlObj = new URL(req.url, 'http://localhost');
    const since   = urlObj.searchParams.get('since')   || '24h';
    const groupBy = urlObj.searchParams.get('groupBy') || 'model';

    // 动态 import，避免循环依赖
    const { getTokenStats, getTopExpensiveTasks, getGlobalSummary } = await import('../../worker/token-cost-tracker.mjs');

    const [summary, byGroup, topTasks] = await Promise.all([
      getGlobalSummary(),
      getTokenStats({ since, groupBy }),
      getTopExpensiveTasks({ limit: 10, since }),
    ]);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      summary,
      by_group: { groupBy, since, data: byGroup },
      top_expensive_tasks: topTasks,
      generated_at: new Date().toISOString(),
    }));
  } catch (err) {
    logger.error(`[token-stats] error: ${err?.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err?.message }));
  }
}
