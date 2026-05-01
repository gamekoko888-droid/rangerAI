/**
 * autonomous-task-api.mjs — REST API for Autonomous Task System
 * v5.4: #8 RBAC + #9 配额 + 可见性隔离
 * 
 * Endpoints:
 *   GET    /api/autonomous-tasks          — List tasks (with filters)
 *   POST   /api/autonomous-tasks          — Submit new autonomous task
 *   GET    /api/autonomous-tasks/:id       — Get task detail with steps
 *   POST   /api/autonomous-tasks/:id/cancel — Cancel a running task
 *   GET    /api/task-templates             — List available templates
 *   GET    /api/task-templates/:id         — Get template detail
 *   POST   /api/task-templates             — Create custom template
 * 
 * @version 1.0.0
 */
import { logger } from '../lib/logger.mjs';
import { query, queryOne, run } from '../db-adapter.mjs';
import { hasPermission, denyAccess, buildTaskVisibilityFilter } from '../modules/rbac.mjs';
import crypto from 'crypto';

const ts = () => new Date().toISOString();

function generateId(prefix = 'task') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Handle autonomous task API requests
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {{ user: object }} context - Authenticated user context
 */
export async function handleAutonomousTaskApi(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  logger.info(`[autonomous-task-api] DEBUG: path=${path} method=${method} url=${req.url}`);

  try {
    // ─── Task Templates ─────────────────────────────────────
    if (path === '/api/task-templates' && method === 'GET') {
      const category = url.searchParams.get('category');
      let sql = 'SELECT * FROM task_templates WHERE isActive = 1';
      const params = [];
      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }
      sql += ' ORDER BY usageCount DESC, createdAt DESC';
      const templates = await query(sql, params);
      
      // Parse JSON fields
      const parsed = templates.map(t => ({
        ...t,
        params: parseJSON(t.params, []),
      }));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ templates: parsed }));
      return true;
    }

    if (path.startsWith('/api/task-templates/') && method === 'GET') {
      const id = path.split('/').pop();
      const template = await queryOne('SELECT * FROM task_templates WHERE id = ?', [id]);
      if (!template) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Template not found' }));
        return true;
      }
      template.params = parseJSON(template.params, []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(template));
      return true;
    }

    if (path === '/api/task-templates' && method === 'POST') {
      const body = await readBody(req);
      const { name, description, category, icon, prompt, params: tplParams } = body;
      if (!name || !prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name and prompt are required' }));
        return true;
      }
      const id = generateId('tpl');
      await run(
        `INSERT INTO task_templates (id, name, description, category, icon, prompt, params, isBuiltin, createdBy)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [id, name, description || '', category || 'general', icon || 'zap', prompt, JSON.stringify(tplParams || []), context.user?.id || null]
      );
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, message: 'Template created' }));
      return true;
    }

    // ─── Autonomous Tasks ───────────────────────────────────
    if (path === '/api/autonomous-tasks' && method === 'GET') {
      const status = url.searchParams.get('status');
      const type = url.searchParams.get('type');
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      
      // #9: Visibility isolation — use RBAC-driven filter
      const visFilter = buildTaskVisibilityFilter(context.user || { id: 'anon', role: 'viewer' });
      let sql = `SELECT * FROM autonomous_tasks WHERE ${visFilter.clause}`;
      const params = [...visFilter.params];
      
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      
      sql += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      const tasks = await query(sql, params);
      const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total').replace(/ORDER BY.*$/, '');
      const countResult = await queryOne(countSql, params.slice(0, -2));
      
      // Parse JSON fields
      const parsed = tasks.map(t => ({
        ...t,
        artifacts: parseJSON(t.artifacts, []),
        screenshots: parseJSON(t.screenshots, []),
        metadata: parseJSON(t.metadata, {}),
        templateParams: parseJSON(t.templateParams, {}),
      }));
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks: parsed, total: countResult?.total || 0, limit, offset }));
      return true;
    }

    if (path === '/api/autonomous-tasks' && method === 'POST') {
      // #8 RBAC: cs+ can submit tasks (viewer excluded)
      if (!hasPermission(context.user, 'task:write')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `权限不足：提交任务需要 cs 及以上角色（当前角色: ${context.user?.role || 'unknown'}）`,
          requiredRole: 'cs',
          currentRole: context.user?.role,
        }));
        return true;
      }

      const body = await readBody(req);
      const { title, description, type, templateId, templateParams: tplParams, priority, scheduleCron } = body;
      
      if (!title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title is required' }));
        return true;
      }
      
      const id = generateId('atask');
      const userId = context.user?.id || 'system';

      // #9: Per-user quota enforcement
      try {
        const quota = await queryOne('SELECT * FROM user_quotas WHERE user_id = ?', [userId]);
        if (quota && !quota.is_unlimited) {
          // Count tasks submitted today by this user
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const todayCount = await queryOne(
            `SELECT COUNT(*) as cnt FROM autonomous_tasks WHERE userId = ? AND createdAt >= ?`,
            [userId, todayStart.toISOString()]
          );
          const dailyTaskLimit = Math.floor((quota.daily_token_limit || 50000) / 5000); // ~10 tasks per 50k tokens
          if ((todayCount?.cnt || 0) >= dailyTaskLimit) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `今日任务配额已用完（${todayCount.cnt}/${dailyTaskLimit}），请明天再试或联系管理员提升配额`,
              used: todayCount.cnt,
              limit: dailyTaskLimit,
            }));
            return true;
          }
        }
        // Also check concurrent running tasks
        const runningCount = await queryOne(
          `SELECT COUNT(*) as cnt FROM autonomous_tasks WHERE userId = ? AND status IN ('running', 'queued')`,
          [userId]
        );
        const maxConcurrent = 3; // Per-user concurrent limit
        if ((runningCount?.cnt || 0) >= maxConcurrent) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `并发任务上限已达到（${runningCount.cnt}/${maxConcurrent}），请等待现有任务完成`,
            running: runningCount.cnt,
            limit: maxConcurrent,
          }));
          return true;
        }
      } catch (quotaErr) {
        logger.warn(`[autonomous-task-api] Quota check failed (non-blocking): ${quotaErr.message}`);
        // Non-blocking: if quota check fails, allow task submission
      }
      
      // If using a template, get the prompt and merge params
      let taskDescription = description || '';
      if (templateId) {
        const template = await queryOne('SELECT * FROM task_templates WHERE id = ?', [templateId]);
        if (template) {
          // Replace template variables with params
          let prompt = template.prompt;
          const params = tplParams || {};
          for (const [key, value] of Object.entries(params)) {
            prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
          }
          taskDescription = prompt;
          // Update template usage count
          await run('UPDATE task_templates SET usageCount = usageCount + 1, updatedAt = datetime("now") WHERE id = ?', [templateId]);
        }
      }
      
      const initialStatus = scheduleCron ? 'pending' : 'queued';
      await run(
        `INSERT INTO autonomous_tasks (id, userId, type, title, description, templateId, templateParams, status, priority, scheduleCron, isRecurring)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, type || 'general', title, taskDescription, templateId || null, JSON.stringify(tplParams || {}), initialStatus, priority || 5, scheduleCron || null, scheduleCron ? 1 : 0]
      );
      
      // [TD-036] IPC to supervisor removed. Task saved in DB as queued.
      // Future: implement direct worker polling from MySQL queue.
      if (!scheduleCron) {
        logger.info(`[${ts()}] [autonomous-task] Task ${id} saved to DB (supervisor removed, IPC skipped)`);













      } else {
        logger.info(`[${ts()}] [autonomous-task] Cron task ${id} created with schedule: ${scheduleCron}, registering with scheduler`);

      }
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, status: scheduleCron ? 'pending' : 'queued', message: scheduleCron ? 'Scheduled task created' : 'Task submitted' }));
      return true;
    }

    if (path.match(/^\/api\/autonomous-tasks\/[^/]+$/) && method === 'GET') {
      const id = path.split('/').pop();
      const task = await queryOne('SELECT * FROM autonomous_tasks WHERE id = ?', [id]);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return true;
      }
      // #9: Visibility check — non-admin can only see own tasks (or dept for manager)
      if (context.user?.role !== 'admin') {
        const isOwn = task.userId === context.user?.id;
        const isDept = context.user?.role === 'manager' && context.user?.department_id;
        if (!isOwn && !isDept) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无权查看此任务' }));
          return true;
        }
      }
      
      // Get steps
      const steps = await query('SELECT * FROM task_steps WHERE taskId = ? ORDER BY stepNumber ASC', [id]);
      
      // Parse JSON fields
      task.artifacts = parseJSON(task.artifacts, []);
      task.screenshots = parseJSON(task.screenshots, []);
      task.metadata = parseJSON(task.metadata, {});
      task.templateParams = parseJSON(task.templateParams, {});
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...task, steps }));
      return true;
    }

    if (path.match(/^\/api\/autonomous-tasks\/[^/]+\/cancel$/) && method === 'POST') {
      const id = path.split('/')[3];
      const task = await queryOne('SELECT * FROM autonomous_tasks WHERE id = ?', [id]);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return true;
      }
      // #8 RBAC: manager+ can cancel any task, others can only cancel own
      const canCancelAny = hasPermission(context.user, 'task:manage');
      const isOwn = task.userId === context.user?.id;
      if (!canCancelAny && !isOwn) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '只能取消自己的任务' }));
        return true;
      }
      if (task.status !== 'running' && task.status !== 'queued') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task is not running or queued' }));
        return true;
      }
      
      await run(
        `UPDATE autonomous_tasks SET status = 'cancelled', completedAt = datetime('now') WHERE id = ?`,
        [id]
      );
      
      // Send cancel command to worker
      try {
        // [TD-036] cancel IPC removed (supervisor removed)
      } catch(_err) { /* v22.0 */ console.error("[autonomous-task-api] silent catch:", _err?.message || _err); }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, status: 'cancelled' }));
      return true;
    }

    return false; // Not handled
  } catch (err) {
    logger.error(`[${ts()}] [autonomous-task-api] Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
    return true;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
