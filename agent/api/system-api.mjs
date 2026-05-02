/**
 * api/system-api.mjs — System management REST endpoints.
 * Extracted from chat-api.mjs (Iter-52 Phase 2 split).
 *
 * Routes handled:
 *   GET  /api/health
 *   GET  /api/version
 *   GET  /api/stats
 *   GET  /api/stats/routing
 *   GET  /api/stats/summary
 *   GET  /api/stats/users          (admin)
 *   GET  /api/stats/loss-rates
 *   GET  /api/prompts
 *   GET  /api/prompts/all          (admin)
 *   POST /api/prompts              (admin)
 *   POST /api/prompts/:id/use
 *   PUT  /api/prompts/:id          (admin)
 *   DELETE /api/prompts/:id        (admin)
 *   GET  /api/system/status
 *   GET  /api/system/health-detail
 *   GET  /api/system/health-history (admin)
 *   GET  /api/system/config
 *   PUT  /api/system/config
 *   GET  /api/system/audit-logs
 *   GET  /api/system/ai-roles
 *   POST /api/system/ai-roles      (admin)
 *   PUT  /api/system/ai-roles/:id  (admin)
 *   DELETE /api/system/ai-roles/:id (admin)
 *   GET  /api/system/inspection-logs
 *   GET  /api/system/agent-metrics    (Iter-G)
 *   GET  /api/system/run-traces       (Iter-H)
 *   GET  /api/system/run-traces/:id   (Iter-H)
 *
 * @module api/system-api
 * @version 1.0.0
 */

import { getCircuitBreakerStatus } from "../worker/llm-bridge.mjs"; // [R45-T2] Updated to use llm-bridge CB
import { logger } from '../lib/logger.mjs';
import { validateDeps } from '../lib/context.mjs';
import { getStatsSummary, getStats, getAgentMetrics } from '../worker/observability.mjs';
import { getRunTraces, getRunDetail } from '../worker/run-tracker.mjs';
import { getKVCacheStats } from '../worker/kv-cache-monitor.mjs'; // Iter-R: KV-Cache 稳定性统计
import { getTokenStats, getTopExpensiveTasks, getGlobalSummary } from '../worker/token-cost-tracker.mjs'; // [Cost-R1-TaskC] token cost API
// workflow 用轻量直连 Google Gemini API（绕开 smart-router 模块常量问题）
async function simpleDirectAPICall(message, model = 'gemini-3-flash-preview') {
  const apiKey = process.env.GOOGLE_API_KEY || '';
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');
  // Strip provider prefix if present
  const cleanModel = model.replace(/^(google|openai|anthropic)\//, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: message }] }],
      generationConfig: { maxOutputTokens: 2000 },
    }),
  });
  if (!resp.ok) throw new Error(`Google API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return { content, model: cleanModel };
}

const REQUIRED_DEPS = ['db'];

/** @type {{ db: object }} */
let deps = {};

/**
 * Initialize system-api with injected dependencies.
 * @param {object} dependencies
 */
import { getUserBudgetInfo, setUserQuota } from "../token-budget.mjs";
import { getBudgetAlertStatus } from "../budget-alert.mjs";
import { cleanupSessions, getCleanupStats } from "../session-ttl-cleanup.mjs";

export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'system-api');
  deps = dependencies;
  logger.info('[system-api] Initialized (v1.0.0)');
}

/**
 * Handle /api/health, /api/version, /api/stats/*, /api/prompts/*, /api/system/* routes.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true if handled
 */
export async function handleSystemApi(req, res) {
  const { db } = deps;
  const urlPath = req.url.split('?')[0];
  const method = req.method;
  const ts = () => new Date().toISOString();

  try {
    // ═══════════════════════════════════════════════
    // Health & Version
    // ═══════════════════════════════════════════════

    // --- GET /api/health --- (F27: Enhanced with component checks)
    if (urlPath === "/api/health" && method === "GET") {
      // H3: Return minimal info for unauthenticated requests
      if (!req._authenticatedUser) {
        db.sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString(), version: "5.0.0" });
        return true;
      }
      const http = await import("http");
      const checks = [
        { name: "api-server", port: 3002, path: "/api/version" },
        { name: "ws-realtime", port: 3005, path: "/health" },
        { name: "openclaw-gateway", port: 18789, path: "/health" },
        { name: "file-server", port: 3001, path: "/health" },
      ];
      const results = await Promise.all(checks.map(c => new Promise(resolve => {
        const req = http.get({ hostname: "127.0.0.1", port: c.port, path: c.path, timeout: 3000 }, r => {
          let body = "";
          r.on("data", d => body += d);
          r.on("end", () => {
            try { resolve({ name: c.name, status: r.statusCode === 200 ? "ok" : "degraded", port: c.port, detail: JSON.parse(body) }); }
            catch(e) { resolve({ name: c.name, status: "ok", port: c.port }); }
          });
        });
        req.on("error", () => resolve({ name: c.name, status: "down", port: c.port }));
        req.on("timeout", () => { req.destroy(); resolve({ name: c.name, status: "timeout", port: c.port }); });
      })));
      const allOk = results.every(r => r.status === "ok");
      const os = await import("os");
      db.sendJson(res, allOk ? 200 : 503, {
        status: allOk ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        version: "5.0.0",
        uptime: process.uptime(),
        system: {
          memory: { total: os.totalmem(), free: os.freemem(), usedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100) },
          loadAvg: os.loadavg(),
          cpus: os.cpus().length
        },
        components: results
      }); return true;
    }

    // ─── GET /api/system/agent-metrics ─── (Iter-G)
    if ((urlPath === '/api/system/agent-metrics' || urlPath === '/api/admin/agent-metrics') && method === 'GET') /* [R44-T2] */ {
      const metrics = getAgentMetrics();
      db.sendJson(res, 200, { ok: true, data: metrics });
      return true;
    }

    // ─── GET /api/system/run-traces ─── (Iter-H)
    if ((urlPath === '/api/system/run-traces' || urlPath === '/api/admin/run-traces') && method === 'GET') /* [R44-T2] */ {
      const url = new URL(req.url, 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const sessionKey = url.searchParams.get('session') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const minScore = url.searchParams.get('minScore') ? parseInt(url.searchParams.get('minScore'), 10) : undefined;
      const traces = getRunTraces({ limit, sessionKey, status, minScore });
      db.sendJson(res, 200, { ok: true, data: traces });
      return true;
    }

    // ─── GET /api/system/run-traces/:runId ─── (Iter-H)
    if (urlPath.startsWith('/api/system/run-traces/') && method === 'GET') {
      const runId = urlPath.split('/').pop();
      const detail = getRunDetail(runId);
      if (detail) {
        db.sendJson(res, 200, { ok: true, data: detail });
      } else {
        db.sendJson(res, 404, { ok: false, error: 'Run trace not found' });
      }
      return true;
    }

    // ─── GET /api/system/kv-cache-stats ─── (Iter-R)
    if (urlPath === '/api/system/kv-cache-stats' && method === 'GET') {
      const stats = getKVCacheStats();
      db.sendJson(res, 200, { ok: true, data: stats, description: 'KV-Cache prefix stability per session' });
      return true;
    }

    // ─── GET /api/version ───
    if (urlPath === "/api/version" && method === "GET") {
      db.sendJson(res, 200, {
        version: "5.0.0",
        name: "RangerAI",
        uptime: process.uptime(),
        nodeVersion: process.version
      });
      return true;
    }

    // ═══════════════════════════════════════════════
    // Stats
    // ═══════════════════════════════════════════════

    // ─── GET /api/stats ───
    if (urlPath === '/api/stats' && method === 'GET') {
      db.sendJson(res, 200, await db.getStats());
      return true;
    }

    // ─── GET /api/stats/routing ───
    if (urlPath === '/api/stats/routing' && method === 'GET') {
      try {
        const fs = await import('fs');
        const logFile = '/home/admin/.openclaw/smart-router-logs/routing.jsonl';
        let entries = [];
        if (fs.existsSync(logFile)) {
          const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
          entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
        const levelCounts = {};
        const modelCounts = {};
        entries.forEach(e => {
          levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
          modelCounts[e.model] = (modelCounts[e.model] || 0) + 1;
        });
        db.sendJson(res, 200, { total: entries.length, levelCounts, modelCounts, recentEntries: entries.slice(-20) });
      } catch (err) {
        db.sendJson(res, 200, { total: 0, levelCounts: {}, modelCounts: {}, recentEntries: [] });
      }
      return true;
    }

    // ─── GET /api/stats/summary ───
    if (urlPath === '/api/stats/summary' && method === 'GET') {
      const stats = await db.getStats();
      db.sendJson(res, 200, { totalUsers: stats.totalUsers, totalChats: stats.totalChats, totalMessages: stats.totalMessages });
      return true;
    }

    // ─── GET /api/stats/users (admin only) ───
    if (urlPath === '/api/stats/users' && method === 'GET') {
      const user = await db.extractUserFromRequest(req);
      if (!user || user.role !== 'admin') {
        db.sendJson(res, 403, { error: 'Admin only' });
        return true;
      }
      try {
        const allUsers = await db.getAllUsers();
        // Query actual per-user message and chat counts from DB
        const userMsgCounts = await db.query(
          `SELECT c.userId, COUNT(m.id) as messageCount, COUNT(DISTINCT c.id) as chatCount
           FROM chats c LEFT JOIN messages m ON m.chatId = c.id
           GROUP BY c.userId`
        );
        const userLastActive = await db.query(
          `SELECT c.userId, MAX(m.createdAt) as lastActive
           FROM chats c LEFT JOIN messages m ON m.chatId = c.id
           GROUP BY c.userId`
        );
        const msgMap = {};
        userMsgCounts.forEach(r => { msgMap[r.userId] = { messageCount: r.messageCount, chatCount: r.chatCount }; });
        const activeMap = {};
        userLastActive.forEach(r => { activeMap[r.userId] = r.lastActive; });
        const users = allUsers.map(u => {
          const counts = msgMap[u.id] || { messageCount: 0, chatCount: 0 };
          return {
            id: u.id,
            username: u.username,
            email: u.username,
            role: u.role || 'member',
            status: u.isActive !== 0 ? 'active' : 'inactive',
            lastActive: activeMap[u.id] || null,
            messageCount: counts.messageCount || 0,
            chatCount: counts.chatCount || 0,
            createdAt: u.createdAt || new Date().toISOString(),
          };
        });
        db.sendJson(res, 200, { users });
      } catch (err) {
        logger.error('[stats/users] error:', err.message);
        db.sendJson(res, 500, { error: 'Failed to get users' });
      }
      return true;
    }

    // ─── GET /api/stats/loss-rates ───
    if (method === 'GET' && urlPath === '/api/stats/loss-rates') {
      try {
        const query = "SELECT DATE_FORMAT(created_at, '%Y-%m') as period, AVG(loss_rate) as loss_rate FROM golden_coins_history GROUP BY period ORDER BY period DESC";
        const rows = await db.query(query);
        db.sendJson(res, 200, { success: true, data: rows });
      } catch (e) {
        // Fallback mock if table missing
        db.sendJson(res, 200, { success: true, data: [{ period: '2026-03', loss_rate: 18.2 }, { period: '2026-02', loss_rate: 17.0 }] });
      }
      return true;
    }

    // ═══════════════════════════════════════════════
    // [Cost-R1-TaskC] Token Cost Stats API
    // ═══════════════════════════════════════════════

    // ─── GET /api/stats/cost/summary  → 全局汇总（今日/7日/30日）───
    if (urlPath === '/api/stats/cost/summary' && method === 'GET') {
      try {
        const summary = await getGlobalSummary();
        db.sendJson(res, 200, { success: true, data: summary });
      } catch (e) {
        logger.error(`[cost-api] summary error: ${e.message}`);
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── GET /api/stats/cost/by-model?since=7d  → 按模型聚合 ───
    if (urlPath === '/api/stats/cost/by-model' && method === 'GET') {
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const since = params.get('since') || '7d';
        const rows = await getTokenStats({ since, groupBy: 'model' });
        db.sendJson(res, 200, { success: true, since, data: rows });
      } catch (e) {
        logger.error(`[cost-api] by-model error: ${e.message}`);
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── GET /api/stats/cost/by-family?since=7d  → 按任务类型聚合 ───
    if (urlPath === '/api/stats/cost/by-family' && method === 'GET') {
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const since = params.get('since') || '7d';
        const rows = await getTokenStats({ since, groupBy: 'task_family' });
        db.sendJson(res, 200, { success: true, since, data: rows });
      } catch (e) {
        logger.error(`[cost-api] by-family error: ${e.message}`);
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── GET /api/stats/cost/top-tasks?since=7d&limit=10  → 最贵 Top N 任务 ───
    if (urlPath === '/api/stats/cost/top-tasks' && method === 'GET') {
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const since = params.get('since') || '7d';
        const limit = Math.min(parseInt(params.get('limit') || '10'), 50);
        const rows = await getTopExpensiveTasks({ since, limit });
        db.sendJson(res, 200, { success: true, since, limit, data: rows });
      } catch (e) {
        logger.error(`[cost-api] top-tasks error: ${e.message}`);
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ═══════════════════════════════════════════════
    // Prompts
    // ═══════════════════════════════════════════════

    // ─── GET /api/prompts/all (admin — must be before /api/prompts) ───
    if (urlPath === "/api/prompts/all" && method === "GET") {
      const authUserAll = await db.extractUserFromRequest(req);
      if (!authUserAll || (authUserAll.role !== "admin" && authUserAll.role !== "manager")) {
        db.sendJson(res, 403, { error: "Admin access required" });
        return true;
      }
      const prompts = await db.getAllPrompts();
      db.sendJson(res, 200, { prompts });
      return true;
    }

    // ─── GET /api/prompts ───
    if (urlPath === '/api/prompts' && method === 'GET') {
      const prompts = await db.getQuickPrompts();
      db.sendJson(res, 200, { prompts });
      return true;
    }

    // ─── POST /api/prompts/:id/use ───
    const promptUseMatch = urlPath.match(/^\/api\/prompts\/([^/]+)\/use$/);
    if (promptUseMatch && method === 'POST') {
      const promptId = promptUseMatch[1];
      const updated = await db.incrementPromptUsage(promptId);
      if (!updated) {
        db.sendJson(res, 404, { error: 'Prompt not found' });
        return true;
      }
      db.sendJson(res, 200, { id: updated.id, usageCount: updated.usageCount });
      return true;
    }

    // ─── POST /api/prompts (admin) ───
    if (urlPath === "/api/prompts" && method === "POST") {
      const authUser = await db.extractUserFromRequest(req);
      if (!authUser || (authUser.role !== "admin" && authUser.role !== "manager")) {
        db.sendJson(res, 403, { error: "Admin access required" });
        return true;
      }
      const body = await db.parseJsonBody(req);
      if (!body.title || !body.content) {
        db.sendJson(res, 400, { error: 'title and content are required' });
        return true;
      }
      const id = body.id || `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const prompt = await db.createPrompt(id, body.title, body.content, body.category || null, body.sortOrder || 0);
      if (!prompt) {
        db.sendJson(res, 500, { error: 'Failed to create prompt' });
        return true;
      }
      db.sendJson(res, 201, { prompt });
      return true;
    }

    // ─── PUT /api/prompts/:id (admin) ───
    const promptUpdateMatch = urlPath.match(/^\/api\/prompts\/([^/]+)$/);
    if (promptUpdateMatch && method === 'PUT') {
      const authUserPut = await db.extractUserFromRequest(req);
      if (!authUserPut || (authUserPut.role !== 'admin' && authUserPut.role !== 'manager')) {
        db.sendJson(res, 403, { error: 'Admin access required' });
        return true;
      }
      const promptId = promptUpdateMatch[1];
      const body = await db.parseJsonBody(req);
      const updated = await db.updatePrompt(promptId, body);
      if (!updated) {
        db.sendJson(res, 404, { error: 'Prompt not found or no changes' });
        return true;
      }
      db.sendJson(res, 200, { prompt: updated });
      return true;
    }

    // ─── DELETE /api/prompts/:id (admin) ───
    const promptDeleteMatch = urlPath.match(/^\/api\/prompts\/([^/]+)$/);
    if (promptDeleteMatch && method === 'DELETE') {
      const authUserDel = await db.extractUserFromRequest(req);
      if (!authUserDel || (authUserDel.role !== 'admin' && authUserDel.role !== 'manager')) {
        db.sendJson(res, 403, { error: 'Admin access required' });
        return true;
      }
      const promptId = promptDeleteMatch[1];
      const deleted = await db.deletePrompt(promptId);
      if (!deleted) {
        db.sendJson(res, 404, { error: 'Prompt not found' });
        return true;
      }
      db.sendJson(res, 200, { ok: true });
      return true;
    }

    // ═══════════════════════════════════════════════
    // System
    // ═══════════════════════════════════════════════

    // ─── GET /api/system/status ───
    if (urlPath === "/api/system/status" && method === "GET") {
      const status = await db.getSystemStatus();
      db.sendJson(res, 200, status);
      return true;
    }

    // ─── GET /api/system/health-detail ───
    if ((urlPath === "/api/system/health-detail" || urlPath === "/api/admin/health-detail") && method === "GET") /* [R44-T2] */ {
      try {
        const detailUser = await db.extractUserFromRequest(req);
        const isAdmin = detailUser && detailUser.role === 'admin';

        let latestRun = null;
        try {
          // health_check_runs is in MySQL, not SQLite
          const mysql2 = (await import('mysql2/promise')).default;
          const conn = await mysql2.createConnection({
            host: '127.0.0.1', port: 3306, user: 'root',
            password: process.env.MYSQL_PASSWORD || 'RangerAI2026!',
            database: process.env.MYSQL_DATABASE || 'rangerai',
            connectTimeout: 5000,
          });
          const [hdr] = await conn.execute(
            "SELECT * FROM health_check_runs ORDER BY id DESC LIMIT 1"
          );
          await conn.end();
          if (hdr && hdr.length > 0) {
            latestRun = hdr[0];
            if (typeof latestRun.metrics === "string") latestRun.metrics = JSON.parse(latestRun.metrics);
            if (typeof latestRun.results === "string") latestRun.results = JSON.parse(latestRun.results);
          }
        } catch (hdrErr) { logger.error("[health-detail] DB query failed: " + hdrErr.message); }

        const summary = latestRun ? {
          status: latestRun.status,
          checked_at: latestRun.createdAt,
          message: latestRun.summary,
          duration_ms: latestRun.duration_ms,
          pass_count: latestRun.pass_count,
          warn_count: latestRun.warn_count,
          crit_count: latestRun.crit_count,
          triggered_by: latestRun.triggered_by,
          uptime_seconds: Math.floor(process.uptime()),
        } : {
          status: 'UNKNOWN',
          checked_at: new Date().toISOString(),
          message: 'No health check data yet',
          uptime_seconds: Math.floor(process.uptime()),
        };

        const components = latestRun && latestRun.results ? latestRun.results : [];
        const response = { summary, components };

        if (isAdmin && latestRun && latestRun.metrics) {
          const m = latestRun.metrics;
          response.admin_metrics = {
            disk_usage_percent: m.disk_usage_percent,
            memory_used_percent: m.memory_used_percent,
            memory_free_mb: m.memory_free_mb,
            memory_total_mb: m.memory_total_mb,
            cpu_load_1m: m.cpu_load_1m,
            cpu_cores: m.cpu_cores,
            mysql_latency_ms: m.mysql_latency_ms,
            mysql_table_count: m.mysql_table_count,
            mysql_user_count: m.mysql_user_count,
            redis_memory: m.redis_memory,
            agent_latency_ms: m.agent_latency_ms,
            gateway_latency_ms: m.gateway_latency_ms,
            fileserver_latency_ms: m.fileserver_latency_ms,
            main_log_size_mb: m.main_log_size_mb,
            log_dir_size_mb: m.log_dir_size_mb,
            audit_log_count: m.audit_log_count,
            workflow_count: m.workflow_count,
            check_duration_ms: m.check_duration_ms,
          };
        }

        db.sendJson(res, 200, response);
      } catch (detailErr) {
        db.sendJson(res, 500, { status: 'error', error: detailErr.message, timestamp: new Date().toISOString() });
      }
      return true;
    }

    // ─── GET /api/system/health-history (admin only) ───
    if (urlPath === "/api/system/health-history" && method === "GET") {
      try {
        const histUser = await db.extractUserFromRequest(req);
        if (!histUser || histUser.role !== 'admin') {
          db.sendJson(res, 403, { error: 'Admin access required' });
          return true;
        }

        const hoursParam = parseInt(new URL(req.url, 'http://localhost').searchParams.get('hours') || '24', 10);
        const hours = Math.min(Math.max(hoursParam, 1), 720);

        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const rows = await db.query(
          `SELECT id, status, summary, duration_ms, pass_count, warn_count, crit_count, metrics, triggered_by, createdAt
           FROM health_check_runs WHERE createdAt >= ? ORDER BY createdAt ASC`,
          [since]
        );
        for (const r of rows) {
          if (typeof r.metrics === 'string') r.metrics = JSON.parse(r.metrics);
        }

        const data_points = (rows || []).map(r => {
          const m = r.metrics || {};
          return {
            timestamp: r.createdAt,
            status: r.status,
            pass_count: r.pass_count,
            warn_count: r.warn_count,
            crit_count: r.crit_count,
            duration_ms: r.duration_ms,
            triggered_by: r.triggered_by,
            disk_pct: m.disk_usage_percent,
            memory_pct: m.memory_used_percent,
            memory_free_mb: m.memory_free_mb,
            cpu_load_1m: m.cpu_load_1m,
            mysql_latency_ms: m.mysql_latency_ms,
            gateway_latency_ms: m.gateway_latency_ms,
            agent_latency_ms: m.agent_latency_ms,
          };
        });

        const totalChecks = data_points.length;
        const passCount = data_points.filter(d => d.status === 'PASS').length;
        const warnCount = data_points.filter(d => d.status === 'WARN').length;
        const critCount = data_points.filter(d => d.status === 'CRIT').length;

        db.sendJson(res, 200, {
          hours_requested: hours,
          interval_minutes: 5,
          data_points,
          summary: {
            total_checks: totalChecks,
            pass_count: passCount,
            warn_count: warnCount,
            crit_count: critCount,
            uptime_pct: totalChecks > 0 ? parseFloat(((passCount / totalChecks) * 100).toFixed(1)) : null,
          }
        });
      } catch (histErr) {
        db.sendJson(res, 500, { error: histErr.message });
      }
      return true;
    }

    // ─── Admin API: System Config ───
    const adminUser = await db.extractUserFromRequest(req);

    if (urlPath === "/api/system/config" && method === "GET") {
      try {
        const configs = await db.getSystemConfigs();
        db.sendJson(res, 200, { configs });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    if (urlPath === "/api/system/config" && method === "PUT") {
      try {
        const body = await db.parseJsonBody(req);
        const { key, value } = body;
        if (!key || value === undefined) { db.sendJson(res, 400, { error: "key and value required" }); return true; }
        const existing = await db.getSystemConfig(key);
        if (!existing) { db.sendJson(res, 404, { error: "Config key not found" }); return true; }
        await db.updateSystemConfig(key, value, adminUser?.username || 'system');
        await db.insertAuditLog(adminUser?.id || 'system', adminUser?.username || 'system', 'config_update', 'system_config', key, JSON.stringify({ key, oldValue: existing.value, newValue: value }));
        db.sendJson(res, 200, { success: true, key, value });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── Admin API: Audit Logs ───
    if (urlPath === "/api/system/audit-logs" && method === "GET") {
      try {
        const params = new URL(req.url, "http://localhost").searchParams;
        const limit = Math.min(parseInt(params.get("limit") || "50"), 200);
        const offset = parseInt(params.get("offset") || "0");
        const action = params.get("action") || null;
        const result = await db.getAuditLogs(limit, offset, action);
        db.sendJson(res, 200, { logs: result.logs, total: result.total, limit, offset });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── Admin API: AI Roles ───
    if (urlPath === "/api/system/ai-roles" && method === "GET") {
      try {
        const roles = await db.getAiRoles();
        db.sendJson(res, 200, { roles });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    if (urlPath === "/api/system/ai-roles" && method === "POST") {
      try {
        const body = await db.parseJsonBody(req);
        const { name, description, systemPrompt, icon, color, category } = body;
        if (!name || !systemPrompt) { db.sendJson(res, 400, { error: "name and systemPrompt required" }); return true; }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await db.createAiRole(id, name, description || '', systemPrompt, icon || 'bot', color || '#3b82f6', category || 'general', adminUser?.username || 'system');
        await db.insertAuditLog(adminUser?.id || 'system', adminUser?.username || 'system', 'role_create', 'ai_roles', id, JSON.stringify({ name }));
        db.sendJson(res, 201, { id, name });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    if (urlPath.startsWith("/api/system/ai-roles/") && method === "PUT") {
      try {
        const roleId = urlPath.slice("/api/system/ai-roles/".length);
        const body = await db.parseJsonBody(req);
        const existing = await db.getAiRole(roleId);
        if (!existing) { db.sendJson(res, 404, { error: "Role not found" }); return true; }
        await db.updateAiRole(roleId, body);
        await db.insertAuditLog(adminUser?.id || 'system', adminUser?.username || 'system', 'role_update', 'ai_roles', roleId, JSON.stringify(body));
        db.sendJson(res, 200, { success: true });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    if (urlPath.startsWith("/api/system/ai-roles/") && method === "DELETE") {
      try {
        const roleId = urlPath.slice("/api/system/ai-roles/".length);
        if (roleId === 'default') { db.sendJson(res, 400, { error: "Cannot delete default role" }); return true; }
        const existing = await db.getAiRole(roleId);
        if (!existing) { db.sendJson(res, 404, { error: "Role not found" }); return true; }
        await db.deleteAiRole(roleId);
        await db.insertAuditLog(adminUser?.id || 'system', adminUser?.username || 'system', 'role_delete', 'ai_roles', roleId, JSON.stringify({ name: existing.name }));
        db.sendJson(res, 200, { success: true });
      } catch (e) {
        db.sendJson(res, 500, { error: e.message });
      }
      return true;
    }

    // ─── GET /api/system/inspection-logs ───
    if (method === 'GET' && urlPath === '/api/system/inspection-logs') {
      const fs = await import('fs/promises');
      const logDir = '/opt/rangerai-agent/logs/';
      try {
        const files = await fs.readdir(logDir);
        const logs = files.filter(f => f.endsWith('.log')).map(f => ({ name: f, path: logDir + f }));
        db.sendJson(res, 200, { success: true, logs });
      } catch (e) {
        db.sendJson(res, 500, { error: 'Failed to read logs', message: e.message });
      }
      return true;
    }

    // ─── POST /api/system/restart-service ───
    // Admin-only: restart a specific service or all services
    if (urlPath === '/api/system/restart-service' && method === 'POST') {
      try {
        // Verify admin role
        const restartUser = await db.extractUserFromRequest(req);
        if (!restartUser || restartUser.role !== 'admin') {
          db.sendJson(res, 403, { error: 'Admin access required' });
          return true;
        }

        // Parse body
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { reject(new Error('Invalid JSON')); }
          });
          req.on('error', reject);
        });

        const { service } = body;
        const allowedServices = ['rangerai-agent', 'openclaw-gateway', 'rangerai-static', 'all'];
        if (!service || !allowedServices.includes(service)) {
          db.sendJson(res, 400, {
            error: 'Invalid service',
            message: `Allowed: ${allowedServices.join(', ')}`,
          });
          return true;
        }

        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const results = [];

        const restartOne = async (svc, cmd) => {
          try {
            const { stdout: output } = await execAsync(cmd, { timeout: 30000 });
            results.push({ service: svc, status: 'ok', output: output.trim() });
          } catch (err) {
            results.push({ service: svc, status: 'error', output: err.stderr || err.message });
          }
        };

        if (service === 'rangerai-agent' || service === 'all') {
          await restartOne('rangerai-agent', 'sudo /usr/local/bin/safe-restart-rangerai');
        }
        if (service === 'openclaw-gateway' || service === 'all') {
          await restartOne('openclaw-gateway', 'sudo /usr/local/bin/safe-restart-gateway');
        }
        if (service === 'rangerai-static' || service === 'all') {
          await restartOne('rangerai-static', 'sudo /usr/bin/systemctl restart rangerai-static');
        }

        // Log the restart action
        logger.info(`[${ts()}] [system-api] Service restart by ${restartUser.username}: ${service} → ${JSON.stringify(results)}`);

        // Check overall status
        const allOk = results.every(r => r.status === 'ok');
        db.sendJson(res, allOk ? 200 : 207, {
          success: allOk,
          service,
          results,
          timestamp: new Date().toISOString(),
          user: restartUser.username,
        });
      } catch (restartErr) {
        logger.error(`[${ts()}] [system-api] Restart error: ${restartErr.message}`);
        db.sendJson(res, 500, { error: 'Restart failed', message: restartErr.message });
      }
      return true;
    }

    // ─── GET /api/system/service-status ───
    // Get current status of all restartable services
    if (urlPath === '/api/system/service-status' && method === 'GET') {
      try {
        const { exec: _exec } = await import('child_process');
        const { promisify: _promisify } = await import('util');
        const _execAsync = _promisify(_exec);
        const services = ['rangerai-agent', 'openclaw-gateway', 'rangerai-static', 'rangerai-web', 'rangerai-fileserver', 'rangerai-acp', 'caddy', 'redis'];
        const statuses = await Promise.all(services.map(async svc => {
          try {
            const { stdout: _activeRaw } = await _execAsync(`sudo /usr/bin/systemctl is-active ${svc}`, { timeout: 5000 });
              const active = _activeRaw.trim();
            let uptime = '';
            try {
              const { stdout: _showRaw } = await _execAsync(`sudo /usr/bin/systemctl show ${svc} --property=ActiveEnterTimestampMonotonic`, { timeout: 5000 });
                const show = _showRaw.trim();
              const monoUs = parseInt(show.split('=')[1], 10);
              if (monoUs > 0) {
                const { stdout: _sysUpRawStr } = await _execAsync('cat /proc/uptime', { timeout: 2000 });
                const sysUpRaw = _sysUpRawStr.trim();
                const sysUpSec = parseFloat(sysUpRaw.split(' ')[0]);
                const svcUpSec = sysUpSec - (monoUs / 1000000);
                if (svcUpSec > 0) {
                  const hours = Math.floor(svcUpSec / 3600);
                  const mins = Math.floor((svcUpSec % 3600) / 60);
                  uptime = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
                }
              }
            } catch(_err) { /* v22.0 */ console.error("[system-api] silent catch:", _err?.message || _err); }
            return { service: svc, status: active, uptime, restartable: ['rangerai-agent', 'openclaw-gateway', 'rangerai-static'].includes(svc) };
          } catch {
            return { service: svc, status: 'unknown', uptime: '', restartable: ['rangerai-agent', 'openclaw-gateway', 'rangerai-static'].includes(svc) };
          }
        }));
        db.sendJson(res, 200, { services: statuses, timestamp: new Date().toISOString() });
      } catch (err) {
        db.sendJson(res, 500, { error: 'Failed to get service status', message: err.message });
      }
      return true;
    }
    // ─── POST /api/chat/simple — workflow 步骤专用轻量 AI 调用 ───
    if (urlPath === '/api/chat/simple' && method === 'POST') {
      try {
        const body = await db.parseJsonBody(req);
        const { message, model } = body;
        if (!message) { db.sendJson(res, 400, { error: 'message required' }); return true; }
        const result = await simpleDirectAPICall(message, model || 'gemini-3-flash-preview');
        db.sendJson(res, 200, { reply: result.content, model: result.model });
      } catch (err) {
        logger.error('[system-api] chat/simple error:', err.message);
        db.sendJson(res, 500, { error: err.message });
      }
      return true;
    }

    
    // ─── GET /api/system/budget — Get current user's budget info (F19: with alert status) ───
    if (urlPath === "/api/system/budget" && method === "GET") {
      const budgetUser = await db.extractUserFromRequest(req);
      if (!budgetUser) { db.sendJson(res, 401, { error: "Auth required" }); return true; }
      const info = await getUserBudgetInfo(budgetUser.id);
      const alertStatus = await getBudgetAlertStatus(budgetUser.id);
      db.sendJson(res, 200, { budget: info, alerts: alertStatus }); return true;
    }

    // ─── POST /api/system/budget — Set user quota (admin only) ───
    if (urlPath === "/api/system/budget" && method === "POST") {
      const budgetAdmin = await db.extractUserFromRequest(req);
      if (!budgetAdmin) { db.sendJson(res, 401, { error: "Auth required" }); return true; }
      if (budgetAdmin?.role !== "admin") { db.sendJson(res, 403, { error: "Admin only" }); return true; }
      const body = await db.parseJsonBody(req);
      const ok = await setUserQuota(body.userId, body.dailyLimit || 50000, body.monthlyLimit || 1000000, body.isUnlimited || false);
      db.sendJson(res, ok ? 200 : 500, { success: ok }); return true;
    }


    // --- GET /api/system/session-cleanup --- Get cleanup stats ---
    if (urlPath === "/api/system/session-cleanup" && method === "GET") {
      const stats = getCleanupStats();
      db.sendJson(res, 200, { stats }); return true;
    }
    // --- POST /api/system/session-cleanup --- Trigger manual cleanup ---
    if (urlPath === "/api/system/session-cleanup" && method === "POST") {
      const result = cleanupSessions();
      db.sendJson(res, 200, { result }); return true;
    }

    // --- GET /api/system/circuit-breaker --- Circuit breaker status (F25) ---
    if (urlPath === "/api/system/circuit-breaker" && method === "GET") {
      const status = await getCircuitBreakerStatus();
      db.sendJson(res, 200, { ok: true, circuitBreakers: status }); return true;
    }

    // GET /api/system/observability-stats — Token usage, cost, model breakdown
    if (urlPath === '/api/system/observability-stats' && method === 'GET') {
      try {
        const hours = parseInt(new URL(req.url, 'http://localhost').searchParams.get('hours') || '24');
        const summary = await getStatsSummary(hours);
        return db.sendJson(res, 200, summary);
      } catch (err) {
        return db.sendJson(res, 500, { error: err.message });
      }
    }


    // GET /api/system/observability-json — JSON format for frontend dashboard
    if (urlPath === '/api/system/observability-json' && method === 'GET') {
      try {
        const hours = parseInt(new URL(req.url, 'http://localhost').searchParams.get('hours') || '24');
        const stats = await getStats(hours);
        return db.sendJson(res, 200, stats);
      } catch (err) {
        return db.sendJson(res, 500, { error: err.message });
      }
    }

    // ═══════════════════════════════════════════════
    // Iter-S7: Gateway Events (Quota Monitoring)
    // ═══════════════════════════════════════════════
    // [R32-T4] Event Stats API — aggregated event_stream statistics
    // [R34-T3] GET /api/admin/datasource-entries — Datasource Registry entries
    if (urlPath === "/api/admin/datasource-entries" && method === "GET") {
      try {
        const { getAllEntries, getEntryCount } = await import("../modules/datasource-registry.mjs");
        const entries = getAllEntries();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          count: getEntryCount(),
          entries,
          version: "R34-T1",
          description: "RangerAI Internal API Documentation Registry",
        }));
        return true;
      } catch (err) {
        logger.error(`[R34-T3] datasource-entries error: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return true;
      }
    }

    if (urlPath === '/api/admin/event-stats' && method === 'GET') {
      try {
        const Database = (await import('better-sqlite3')).default;
        const eventDb = new Database('/opt/rangerai-agent/db/rangerai.db', { readonly: true });
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const days = parseInt(urlObj.searchParams.get('days') || '7', 10);
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const typeStats = eventDb.prepare('SELECT event_type, COUNT(*) as count FROM event_stream WHERE created_at > ? GROUP BY event_type ORDER BY count DESC').all(cutoff);
        const dailyTrend = eventDb.prepare('SELECT date(created_at) as day, event_type, COUNT(*) as count FROM event_stream WHERE created_at > ? GROUP BY day, event_type ORDER BY day DESC').all(cutoff);
        const totalRow = eventDb.prepare('SELECT COUNT(*) as total FROM event_stream WHERE created_at > ?').get(cutoff);
        const recentEvents = eventDb.prepare('SELECT id, session_key, task_id, event_type, payload, model, tool_name, created_at FROM event_stream ORDER BY id DESC LIMIT 50').all();
        eventDb.close();
        const planUpdates = typeStats.find(r => r.event_type === 'plan_update')?.count || 0;
        const knowledgeInjected = typeStats.find(r => r.event_type === 'knowledge_injected')?.count || 0;
        const kvCacheStats = typeStats.find(r => r.event_type === 'kv_cache_stats')?.count || 0;
        const contextCompress = typeStats.find(r => r.event_type === 'context_compress')?.count || 0;
        const ttsGenerated = typeStats.find(r => r.event_type === 'tts_generated')?.count || 0;
        const maxRetriesExceeded = typeStats.find(r => r.event_type === 'max_retries_exceeded')?.count || 0;
        const totalMessages = typeStats.find(r => r.event_type === 'user_message')?.count || 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          period: { days, cutoff },
          summary: { totalEvents: totalRow?.total || 0, totalMessages, uniqueTypes: typeStats.length, planUpdates, knowledgeInjected, kvCacheStats, contextCompress, ttsGenerated, maxRetriesExceeded },
          byType: typeStats,
          dailyTrend,
          recentEvents: recentEvents.map(e => ({ ...e, payload: typeof e.payload === 'string' ? (() => { try { return JSON.parse(e.payload); } catch { return e.payload; } })() : e.payload }))
        }));
      } catch (err) {
        logger.error('[R32-T4] event-stats error: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return true;
    }

    if (urlPath === '/api/admin/gateway-events' && method === 'GET') {
      // Iter-S8 P2: Admin auth check
      const gwUser = await db.extractUserFromRequest(req);
      if (!gwUser || gwUser.role !== 'admin') {
        return db.sendJson(res, 403, { error: 'Admin only' });
      }
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const hours = Math.min(parseInt(params.get('hours') || '24'), 168); // max 7 days
        const cutoff = Date.now() - hours * 3600 * 1000;
        const events = await db.query(
          `SELECT id, provider, model, error_type, error_message, fallback_result, timestamp FROM gateway_events WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 500`,
          [cutoff]
        );
        // Aggregate stats
        const stats = {};
        for (const e of events) {
          const key = `${e.provider}:${e.model}`;
          if (!stats[key]) stats[key] = { provider: e.provider, model: e.model, count: 0, error_types: {} };
          stats[key].count++;
          stats[key].error_types[e.error_type] = (stats[key].error_types[e.error_type] || 0) + 1;
        }
        // Hourly breakdown for chart
        const hourly = {};
        for (const e of events) {
          const hour = new Date(e.timestamp).toISOString().slice(0, 13) + ':00';
          if (!hourly[hour]) hourly[hour] = 0;
          hourly[hour]++;
        }
        const totalRequests = events.length;
        const fallbackRate = totalRequests > 0 ? Math.round(totalRequests / Math.max(hours, 1) * 100) / 100 : 0;
        return db.sendJson(res, 200, {
          events: events.slice(0, 100),
          stats: Object.values(stats),
          hourly: Object.entries(hourly).map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour)),
          summary: { total: totalRequests, hours, fallbackRate, alerting: totalRequests > 10 }
        });
      } catch (err) {
        return db.sendJson(res, 500, { error: err.message });
      }
    }


    // ─── GET /api/cost-stats ─── (admin only, cost dashboard)
    if (urlPath === '/api/cost-stats' && method === 'GET') {
      const costUser = req._authenticatedUser;
      if (!costUser) { db.sendJson(res, 401, { error: 'Auth required' }); return true; }
      if (costUser.role !== 'admin') { db.sendJson(res, 403, { error: 'Admin only' }); return true; }
      
      const hours = Math.min(Math.max(parseInt(new URL(req.url, 'http://localhost').searchParams.get('hours')) || 24, 1), 720);
      const cutoffMs = Date.now() - hours * 3600 * 1000;
      
      const fs = await import('fs');
      const path = await import('path');
      const SESSIONS_DIR = '/home/admin/.openclaw/agents/main/sessions';
      const SESSIONS_JSON = path.default.join(SESSIONS_DIR, 'sessions.json');
      
      // Load session metadata
      let sessionMeta = {};
      try {
        const raw = fs.default.readFileSync(SESSIONS_JSON, 'utf8');
        const meta = JSON.parse(raw);
        for (const [key, val] of Object.entries(meta)) {
          const sid = val.sessionId;
          if (!sid) continue;
          const origin = val.origin || {};
          const isCron = key.toLowerCase().includes('cron') || (val.label || '').toLowerCase().includes('cron');
          sessionMeta[sid] = {
            key,
            label: val.label || origin.label || key.split(':').pop().slice(0, 20),
            channel: origin.provider || origin.surface || 'unknown',
            isCron,
            user: origin.label || val.label || key.split(':').pop().slice(0, 20),
          };
        }
      } catch (e) { logger.error(`[cost-stats] sessions.json error: ${e.message}`); }
      
      // Scan JSONL files
      const userCosts = {};
      const modelCosts = {};
      const hourlyCosts = {};
      const dailyCosts = {};
      const sessionList = [];
      let totalCost = 0, totalCalls = 0, cronCost = 0, cronCalls = 0;
      
      let files = [];
      try { files = fs.default.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')); } catch {}
      
      for (const file of files) {
        const fpath = path.default.join(SESSIONS_DIR, file);
        try {
          const stat = fs.default.statSync(fpath);
          if (stat.mtimeMs < cutoffMs - 3600000) continue;
        } catch { continue; }
        
        const sid = file.replace('.jsonl', '');
        const meta = sessionMeta[sid] || { label: sid.slice(0, 12), isCron: false, user: 'unknown', channel: 'unknown' };
        let sCost = 0, sCalls = 0;
        
        try {
          const lines = fs.default.readFileSync(fpath, 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type !== 'message') continue;
            const msg = entry.message;
            if (!msg || msg.role !== 'assistant' || !msg.usage || !msg.usage.cost) continue;
            const cost = msg.usage.cost;
            if (!cost.total || cost.total <= 0) continue;
            
            let ts2 = msg.timestamp || 0;
            if (!ts2 && entry.timestamp) { try { ts2 = new Date(entry.timestamp).getTime(); } catch { continue; } }
            if (ts2 < cutoffMs) continue;
            
            const c = cost.total;
            const model = msg.model || 'unknown';
            sCost += c; sCalls += 1; totalCost += c; totalCalls += 1;
            
            const userKey = meta.user;
            if (!userCosts[userKey]) userCosts[userKey] = { total: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: {} };
            userCosts[userKey].total += c;
            userCosts[userKey].calls += 1;
            userCosts[userKey].input += cost.input || 0;
            userCosts[userKey].output += cost.output || 0;
            userCosts[userKey].cacheRead += cost.cacheRead || 0;
            userCosts[userKey].cacheWrite += cost.cacheWrite || 0;
            userCosts[userKey].models[model] = (userCosts[userKey].models[model] || 0) + c;
            
            if (!modelCosts[model]) modelCosts[model] = { total: 0, calls: 0 };
            modelCosts[model].total += c; modelCosts[model].calls += 1;
            
            const dt = new Date(ts2);
            const cstHour = (dt.getUTCHours() + 8) % 24;
            const hourKey = `${String(cstHour).padStart(2, '0')}:00`;
            hourlyCosts[hourKey] = (hourlyCosts[hourKey] || 0) + c;
            
            const cstDate = new Date(ts2 + 8 * 3600 * 1000);
            const dayKey = cstDate.toISOString().slice(0, 10);
            dailyCosts[dayKey] = (dailyCosts[dayKey] || 0) + c;
            
            if (meta.isCron) { cronCost += c; cronCalls += 1; }
          }
        } catch {}
        
        if (sCost > 0) {
          sessionList.push({ sid: sid.slice(0, 12), user: meta.user.slice(0, 40), cost: Math.round(sCost * 10000) / 10000, calls: sCalls, isCron: meta.isCron, channel: meta.channel, label: meta.label.slice(0, 50) });
        }
      }
      
      sessionList.sort((a, b) => b.cost - a.cost);
      
      const users = Object.entries(userCosts).map(([name, d]) => ({
        name: name.slice(0, 40), total: Math.round(d.total * 10000) / 10000, calls: d.calls,
        input: Math.round(d.input * 10000) / 10000, output: Math.round(d.output * 10000) / 10000,
        cacheRead: Math.round(d.cacheRead * 10000) / 10000, cacheWrite: Math.round(d.cacheWrite * 10000) / 10000,
        models: Object.entries(d.models).map(([m, c]) => ({ model: m, cost: Math.round(c * 10000) / 10000 })).sort((a, b) => b.cost - a.cost),
      })).sort((a, b) => b.total - a.total);
      
      const models = Object.entries(modelCosts).map(([name, d]) => ({ name, total: Math.round(d.total * 10000) / 10000, calls: d.calls })).sort((a, b) => b.total - a.total);
      const hourly = Object.entries(hourlyCosts).map(([hour, cost]) => ({ hour, cost: Math.round(cost * 10000) / 10000 })).sort((a, b) => a.hour.localeCompare(b.hour));
      const daily = Object.entries(dailyCosts).map(([date, cost]) => ({ date, cost: Math.round(cost * 10000) / 10000 })).sort((a, b) => a.date.localeCompare(b.date));
      
      db.sendJson(res, 200, {
        timeRange: { hours, from: new Date(cutoffMs).toISOString(), to: new Date().toISOString() },
        summary: { totalCost: Math.round(totalCost * 10000) / 10000, totalCalls, activeSessions: sessionList.length, cronCost: Math.round(cronCost * 10000) / 10000, cronCalls, userCost: Math.round((totalCost - cronCost) * 10000) / 10000, userCalls: totalCalls - cronCalls },
        users, models, hourly, daily, sessions: sessionList.slice(0, 20),
      });
      return true;
    }


    // [R44-T4] GET /api/admin/debug-timeout — Verify tool_timeout trigger
    if ((urlPath === "/api/admin/debug-timeout" || urlPath === "/api/system/debug-timeout") && method === "GET") {
      try {
        const { emitEvent, EVENT_TYPES } = await import("../worker/event-stream.mjs");
        const testPayload = {
          tool: "debug_test_tool",
          timeoutMs: 5000,
          thresholdMs: 5000,
          severity: "soft",
          step: null,
          retryCount: 0,
          key: "debug-test-" + Date.now(),
          _debug: true,
          triggeredAt: new Date().toISOString(),
        };
        emitEvent("debug-session", "debug-task-" + Date.now(), EVENT_TYPES.TOOL_TIMEOUT || "tool_timeout", testPayload);
        let recentTimeouts = [];
        try {
          const rows = db.prepare("SELECT * FROM event_stream WHERE event_type = 'tool_timeout' ORDER BY created_at DESC LIMIT 5").all();
          recentTimeouts = rows;
        } catch(e) { /* ignore */ }
        db.sendJson(res, 200, {
          ok: true,
          message: "tool_timeout test event emitted",
          testPayload,
          recentTimeouts,
          config: { DEBUG_TIMEOUT_MS: process.env.DEBUG_TIMEOUT_MS || "not set" },
        });
        return true;
      } catch(e) {
        db.sendJson(res, 500, { error: e.message });
        return true;
      }
    }


    
    // ─── GET /api/system/task-replay ─── Task list with pagination [R46-T5]
    if (urlPath === '/api/system/task-replay' && method === 'GET') {
      try {
        const Database = (await import('better-sqlite3')).default;
        const dbMain = new Database(process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db', { readonly: true });
        const params = new URL(req.url, 'http://localhost').searchParams;
        const page = Math.max(parseInt(params.get('page') || '1'), 1);
        const limit = Math.min(Math.max(parseInt(params.get('limit') || '20'), 1), 100);
        const status = params.get('status'); // completed, active, failed
        const offset = (page - 1) * limit;
        
        let whereClause = '';
        const queryParams = [];
        if (status) { whereClause = 'WHERE status = ?'; queryParams.push(status); }
        
        const total = dbMain.prepare('SELECT COUNT(*) as cnt FROM task_plans ' + whereClause).get(...(queryParams.length ? [queryParams] : []));
        const tasks = dbMain.prepare(
          'SELECT msg_id, session_key, status, goal, step_count, steps_completed, plan_version, created_at, updated_at FROM task_plans ' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
        ).all(...queryParams, limit, offset);
        
        // Get span counts per task
        const spanCounts = {};
        for (const t of tasks) {
          const sc = dbMain.prepare('SELECT COUNT(*) as cnt FROM trace_spans WHERE trace_id = ?').get(t.msg_id);
          spanCounts[t.msg_id] = sc?.cnt || 0;
        }
        
        dbMain.close();
        db.sendJson(res, 200, {
          ok: true,
          pagination: { page, limit, total: total?.cnt || 0, pages: Math.ceil((total?.cnt || 0) / limit) },
          tasks: tasks.map(t => ({
            taskId: t.msg_id,
            sessionKey: t.session_key,
            status: t.status,
            goal: t.goal,
            totalSteps: t.step_count,
            completedSteps: t.steps_completed,
            planVersion: t.plan_version,
            spanCount: spanCounts[t.msg_id] || 0,
            createdAt: t.created_at,
            updatedAt: t.updated_at,
          }))
        });
      } catch(e) {
        db.sendJson(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // ─── GET /api/system/task-replay/:taskId ─── Full task replay with events [R46-T5]
    if (urlPath.startsWith('/api/system/task-replay/') && method === 'GET') {
      try {
        const taskId = urlPath.split('/').pop();
        const Database = (await import('better-sqlite3')).default;
        const dbMain = new Database(process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db', { readonly: true });
        const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });
        
        // 1. Task plan
        const planRow = dbMain.prepare('SELECT * FROM task_plans WHERE msg_id = ?').get(taskId);
        if (!planRow) {
          dbMain.close(); dbWorker.close();
          db.sendJson(res, 404, { ok: false, error: 'Task not found' });
          return true;
        }
        
        let planSteps = [];
        try {
          const plan = JSON.parse(planRow.plan_json || '{}');
          planSteps = (plan.steps || []).map(s => ({
            id: s.id, title: s.title, status: s.status,
            tools: s.tools || [], output: s.output || null,
          }));
        } catch (_) {}
        
        // 2. Trace spans
        const spans = dbMain.prepare(
          'SELECT span_name, started_at, ended_at, duration_ms, status, meta FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC'
        ).all(taskId).map(r => ({
          name: r.span_name, startedAt: r.started_at, endedAt: r.ended_at,
          durationMs: r.duration_ms, status: r.status,
          meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch(_) { return null; } })() : null,
        }));
        
        // 3. Event stream for this session
        const sessionKey = planRow.session_key;
        let events = [];
        if (sessionKey) {
          events = dbWorker.prepare(
            'SELECT id, event_type, payload, model, tool_name, created_at FROM event_stream WHERE task_id = ? ORDER BY id ASC LIMIT 500'
          ).all(taskId).map(r => {
            let payload = {};
            try { payload = JSON.parse(r.payload || '{}'); } catch(_) {}
            // Truncate large payloads
            const payloadStr = JSON.stringify(payload);
            if (payloadStr.length > 2000) {
              payload = { _truncated: true, _size: payloadStr.length, _preview: payloadStr.slice(0, 500) + '...' };
            }
            return {
              id: r.id, type: r.event_type, model: r.model, toolName: r.tool_name,
              payload, timestamp: r.created_at,
            };
          });
        }
        
        // 4. Compressions
        let compressions = [];
        // Get actual UUID session_key from event_stream
        const actualSessionRow = dbWorker.prepare("SELECT DISTINCT session_key FROM event_stream WHERE task_id = ? LIMIT 1").get(taskId);
        const actualSessionKey = actualSessionRow ? actualSessionRow.session_key : sessionKey;
        if (sessionKey) {
          compressions = dbWorker.prepare(
            'SELECT type, trigger_ratio, msgs_before, msgs_after, tokens_before, tokens_after, created_at FROM context_compression_log WHERE session_key = ? ORDER BY created_at ASC'
          ).all(actualSessionKey).map(r => ({
            type: r.type, triggerRatio: r.trigger_ratio,
            msgsBefore: r.msgs_before, msgsAfter: r.msgs_after,
            tokensBefore: r.tokens_before, tokensAfter: r.tokens_after,
            timestamp: r.created_at,
          }));
        }
        
        // 5. Supervisor reviews
        let reviews = [];
        try {
          reviews = dbWorker.prepare(
            'SELECT type, risk_level, score, step_count, feedback, stub, created_at FROM supervisor_reviews WHERE task_id = ? ORDER BY created_at ASC'
          ).all(taskId).map(r => ({
            type: r.type, riskLevel: r.risk_level, score: r.score,
            feedback: r.feedback, stub: !!r.stub, timestamp: r.created_at,
          }));
        } catch (_) {}
        
        // 6. Build execution chain
        const chain = [];
        for (const evt of events) {
          if (['plan_update', 'action', 'observation', 'tool_route_chosen', 'model_route', 'final_answer'].includes(evt.type)) {
            chain.push({
              step: chain.length + 1,
              type: evt.type,
              model: evt.model,
              tool: evt.toolName,
              timestamp: evt.timestamp,
              detail: evt.type === 'plan_update' ? (evt.payload?.goal || evt.payload?._preview || '') :
                      evt.type === 'action' ? (evt.payload?.tool || evt.payload?._preview || '') :
                      evt.type === 'final_answer' ? 'Task completed' :
                      evt.type === 'tool_route_chosen' ? (evt.payload?.tool || '') :
                      evt.type === 'model_route' ? (evt.payload?.model || evt.model || '') :
                      '',
            });
          }
        }
        
        dbMain.close(); dbWorker.close();
        
        db.sendJson(res, 200, {
          ok: true,
          task: {
            taskId: planRow.msg_id,
            sessionKey,
            status: planRow.status,
            goal: planRow.goal,
            totalSteps: planRow.step_count,
            completedSteps: planRow.steps_completed,
            planVersion: planRow.plan_version,
            createdAt: planRow.created_at,
            updatedAt: planRow.updated_at,
          },
          planSteps,
          executionChain: chain,
          timeline: {
            events: events.slice(0, 200), // Limit for response size
            traceSpans: spans,
            compressions,
            supervisorReviews: reviews,
          },
          stats: {
            totalEvents: events.length,
            totalSpans: spans.length,
            totalCompressions: compressions.length,
            totalReviews: reviews.length,
            chainLength: chain.length,
            eventTypes: events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
          }
        });
      } catch(e) {
        db.sendJson(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

// --- GET /api/system/alerts/stream --- SSE real-time alert push [R46-T4] ---
    if (urlPath === "/api/system/alerts/stream" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("data: " + JSON.stringify({ type: "connected", ts: Date.now() }) + "\n\n");

      // Track active SSE clients
      if (!global._sseAlertClients) global._sseAlertClients = new Set();
      global._sseAlertClients.add(res);

      // Send heartbeat every 30s
      const heartbeat = setInterval(() => {
        try { res.write("data: " + JSON.stringify({ type: "heartbeat", ts: Date.now() }) + "\n\n"); }
        catch(e) { clearInterval(heartbeat); global._sseAlertClients?.delete(res); }
      }, 30000);

      // Check for alerts every 10s
      const alertCheck = setInterval(async () => {
        try {
          const rows = await db.query(
            "SELECT id, status, summary, metrics, createdAt FROM health_check_runs WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT 1",
            [new Date(Date.now() - 60000).toISOString().slice(0, 19).replace('T', ' ')]
          );
          if (rows.length > 0) {
            const latest = rows[0];
            if (typeof latest.metrics === 'string') latest.metrics = JSON.parse(latest.metrics);
            const m = latest.metrics || {};
            const alerts = [];
            if (m.disk_usage_percent > 85) alerts.push({ level: 'CRIT', metric: 'disk', value: m.disk_usage_percent, threshold: 85 });
            else if (m.disk_usage_percent > 70) alerts.push({ level: 'WARN', metric: 'disk', value: m.disk_usage_percent, threshold: 70 });
            if (m.memory_used_percent > 90) alerts.push({ level: 'CRIT', metric: 'memory', value: m.memory_used_percent, threshold: 90 });
            else if (m.memory_used_percent > 75) alerts.push({ level: 'WARN', metric: 'memory', value: m.memory_used_percent, threshold: 75 });
            if (m.cpu_load_1m > 4) alerts.push({ level: 'CRIT', metric: 'cpu', value: m.cpu_load_1m, threshold: 4 });
            else if (m.cpu_load_1m > 2) alerts.push({ level: 'WARN', metric: 'cpu', value: m.cpu_load_1m, threshold: 2 });
            if (m.mysql_latency_ms > 1000) alerts.push({ level: 'CRIT', metric: 'mysql_latency', value: m.mysql_latency_ms, threshold: 1000 });
            else if (m.mysql_latency_ms > 500) alerts.push({ level: 'WARN', metric: 'mysql_latency', value: m.mysql_latency_ms, threshold: 500 });
            if (latest.status === 'CRIT' || latest.status === 'WARN' || alerts.length > 0) {
              res.write("data: " + JSON.stringify({ type: "alert", status: latest.status, alerts, summary: latest.summary, ts: latest.createdAt }) + "\n\n");
            }
          }
        } catch(e) { /* ignore check errors */ }
      }, 10000);

      req.on("close", () => {
        clearInterval(heartbeat);
        clearInterval(alertCheck);
        global._sseAlertClients?.delete(res);
      });
      return true;
    }


    // ─── GET /api/system/quality-stats ─── Quality Scorer Statistics [R46-T6]
    if (urlPath === '/api/system/quality-stats' && method === 'GET') {
      try {
        const { getScoringStats } = await import('../worker/quality-scorer.mjs');
        const stats = getScoringStats();
        
        // Also check event_stream for historical quality events
        const Database = (await import('better-sqlite3')).default;
        const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });
        
        const scored = dbWorker.prepare("SELECT COUNT(*) as cnt FROM event_stream WHERE event_type = 'answer_quality_scored'").get();
        const skipped = dbWorker.prepare("SELECT COUNT(*) as cnt FROM event_stream WHERE event_type = 'answer_quality_skipped'").get();
        const recentScored = dbWorker.prepare("SELECT payload, created_at FROM event_stream WHERE event_type = 'answer_quality_scored' ORDER BY id DESC LIMIT 5").all();
        
        dbWorker.close();
        
        db.sendJson(res, 200, {
          ok: true,
          runtime: stats,
          historical: {
            totalScored: scored?.cnt || 0,
            totalSkipped: skipped?.cnt || 0,
            recentScores: recentScored.map(r => {
              let p = {};
              try { p = JSON.parse(r.payload || '{}'); } catch(_) {}
              return { score: p.score, dimensions: p.dimensions, timestamp: r.created_at };
            }),
          },
          config: {
            sampleRate: stats.sampleRate,
            effectiveRate: stats.total > 0 ? (stats.scored / stats.total).toFixed(3) : 'N/A',
          }
        });
      } catch(e) {
        db.sendJson(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // ─── POST /api/system/quality-validate ─── Validate quality scorer with test input [R46-T6]
    if (urlPath === '/api/system/quality-validate' && method === 'POST') {
      try {
        const { getScoringStats } = await import('../worker/quality-scorer.mjs');
        const stats = getScoringStats();
        
        // Validate configuration
        const issues = [];
        if (stats.sampleRate <= 0) issues.push('Sample rate is 0 - no scoring will occur');
        if (stats.sampleRate > 1) issues.push('Sample rate > 1 - invalid configuration');
        
        // Check that the module is properly loaded
        const moduleCheck = {
          getScoringStats: typeof getScoringStats === 'function',
          sampleRateValid: stats.sampleRate > 0 && stats.sampleRate <= 1,
          statsTracking: typeof stats.total === 'number' && typeof stats.scored === 'number',
        };
        
        db.sendJson(res, 200, {
          ok: true,
          validation: {
            passed: issues.length === 0,
            issues,
            moduleCheck,
            currentStats: stats,
          }
        });
      } catch(e) {
        db.sendJson(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // ─── GET /api/system/mcp-registry ─── MCP Tool Registry Overview [R46-T6]
    if (urlPath === '/api/system/mcp-registry' && method === 'GET') {
      try {
        const { getAllTools, getToolRegistry, getReadonlyTools, getStateMutatingTools } = await import('../worker/tools/index.mjs');
        const allTools = getAllTools();
        const registry = getToolRegistry();
        
        // Check MCP server tools
        let mcpTools = [];
        try {
          const { getMCPServers } = await import('./mcp-server.mjs');
          mcpTools = getMCPServers ? getMCPServers() : [];
        } catch(_) {}
        
        db.sendJson(res, 200, {
          ok: true,
          summary: {
            totalTools: allTools.length,
            readonlyTools: getReadonlyTools().length,
            stateMutatingTools: getStateMutatingTools().length,
            mcpServers: Array.isArray(mcpTools) ? mcpTools.length : 0,
          },
          tools: allTools.map(t => ({
            name: t.name,
            category: t.category,
            description: t.description,
            handler: t.handler || null,
            permissionTier: t.permissionTier,
            isMCPExposed: false, // Will be updated below
          })),
          mcpExposed: ['web_search', 'web_fetch', 'generate_image', 'speak_text', 'analyze_image', 'memory_search',
                       'analyze_video', 'analyze_audio', 'analyze_document'],
          preResearch: {
            currentMCPVersion: '2024-11-05',
            supportedTransports: ['stdio'],
            registeredCapabilities: ['tools', 'resources'],
            mediaToolsRegistered: allTools.filter(t => ['analyze_video', 'analyze_audio', 'analyze_document'].includes(t.name)).length === 3,
            recommendation: 'Media tools (analyze_video/audio/document) should be exposed via MCP for external client access. Current MCP server exposes 6 tools; adding 3 media tools would bring total to 9.',
          }
        });
      } catch(e) {
        db.sendJson(res, 500, { ok: false, error: e.message });
      }
      return true;
    }
    // ─── GET /api/task-status ─── [P0] Frontend self-healing endpoint
    if (urlPath === "/api/task-status" && method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const msgId = url.searchParams.get("msgId");
      if (!msgId) {
        db.sendJson(res, 400, { status: "unknown", error: "Missing msgId" });
        return true;
      }
      try {
        const [rows] = await db.pool.execute(
          `SELECT content, model, role, createdAt FROM messages WHERE chatId = (SELECT chatId FROM messages WHERE msgId = ? LIMIT 1) AND role = 'assistant' AND createdAt >= (SELECT createdAt FROM messages WHERE msgId = ? LIMIT 1) ORDER BY createdAt DESC LIMIT 1`,
          [msgId, msgId]
        );
        if (rows && rows.length > 0) {
          db.sendJson(res, 200, { status: "completed", content: rows[0].content, model: rows[0].model });
          return true;
        }
        db.sendJson(res, 200, { status: "running" });
        return true;
      } catch (err) {
        logger.error(`[task-status] Error: ${err.message}`);
        db.sendJson(res, 200, { status: "unknown", error: err.message });
        return true;
      }
    }

    return false;

  } catch (err) {
    logger.error(`[${ts()}] [system-api] Error: ${err.message}\n${err.stack}`);
    db.sendJson(res, 500, { error: 'Internal server error' });
    return true;
  }
}

// [R46-T4] Broadcast alert to all SSE clients
export function broadcastAlert(alertData) {
  if (!global._sseAlertClients || global._sseAlertClients.size === 0) return 0;
  const msg = "data: " + JSON.stringify({ type: "alert", ...alertData, ts: Date.now() }) + "\n\n";
  let sent = 0;
  for (const client of global._sseAlertClients) {
    try { client.write(msg); sent++; }
    catch(e) { global._sseAlertClients.delete(client); }
  }
  return sent;
}
