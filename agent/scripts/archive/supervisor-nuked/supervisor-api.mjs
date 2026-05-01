/**
 * supervisor-api.mjs — REST API for Supervisor Engine
 * 
 * Endpoints:
 *   GET  /api/supervisor/tasks              — List supervisor tasks
 *   GET  /api/supervisor/tasks/:id          — Get task detail with steps (includes supervisorDecision)
 *   POST /api/supervisor/tasks/:id/cancel   — Cancel a running supervisor task
 *   GET  /api/supervisor/stats              — Aggregate stats for dashboard
 *   GET  /api/supervisor/schedules          — List all scheduled tasks
 *   POST /api/supervisor/schedules          — Create a new scheduled task
 *   PATCH /api/supervisor/schedules/:id     — Toggle enable/disable
 *   DELETE /api/supervisor/schedules/:id    — Delete a schedule
 * 
 * @version 1.4.0 — S14: failureReasons stats, audit-log endpoint, schedule run endpoint, scheduleHealth
 *   GET  /api/supervisor/audit-log            — Supervisor audit log (S14 P1)
 *   POST /api/supervisor/schedules/:id/run    — Immediately trigger a schedule (S14 P2)
 */
import { logger } from '../lib/logger.mjs';
import { getTask, listTasks, listAllSteps, cancelTask, getHealth, cleanupFailedTasks } from '../worker/supervisor-engine.mjs';
import { query, queryOne, run } from '../db-adapter.mjs';
import { listSchedules, createSchedule, toggleSchedule, deleteSchedule } from '../services/supervisor-scheduler.mjs';
import { sendCommand } from '../lib/redis-ipc.mjs';

const ts = () => new Date().toISOString();

/**
 * Parse supervisorDecision JSON safely
 */
function parseDecision(step) {
  if (!step.supervisorDecision) return null;
  try {
    return JSON.parse(step.supervisorDecision);
  } catch {
    return step.supervisorDecision;
  }
}

/**
 * Enrich steps with parsed supervisorDecision
 */
function enrichSteps(steps) {
  return (steps || []).map(s => ({
    ...s,
    supervisorDecision: parseDecision(s),
  }));
}

/**
 * S13 P3: Resolve atask_* ID to sv_* ID by querying supervisor_tasks metadata
 */
async function resolveAtaskToSvId(ataskId) {
  try {
    const row = await queryOne(
      `SELECT id FROM supervisor_tasks WHERE json_extract(metadata, '$.legacyTaskId') = ? ORDER BY createdAt DESC LIMIT 1`,
      [ataskId]
    );
    if (row) {
      logger.info(`[supervisor-api] Resolved ${ataskId} → ${row.id}`);
      return row.id;
    }
  } catch (e) {
    logger.error(`[supervisor-api] resolveAtaskToSvId error: ${e.message}`);
  }
  return null;
}

/**
 * Read request body as JSON
 */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Handle supervisor API requests
 */
export async function handleSupervisorApi(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // ─── Schedule Endpoints (S13 P0) ─────────────────────────

    // GET /api/supervisor/schedules — List all schedules
    if (path === '/api/supervisor/schedules' && method === 'GET') {
      const schedules = await listSchedules();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, schedules }));
      return true;
    }

    // POST /api/supervisor/schedules — Create a new schedule
    if (path === '/api/supervisor/schedules' && method === 'POST') {
      const body = await readBody(req);
      const { title, prompt, cron_expr, cronExpr } = body;
      const cron = cron_expr || cronExpr;
      
      if (!title || !prompt || !cron) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'title, prompt, and cron_expr are required' }));
        return true;
      }
      
      // Basic cron validation
      const cronParts = cron.trim().split(/\s+/);
      if (cronParts.length < 5 || cronParts.length > 6) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid cron expression. Must be 5 fields: min hour dom month dow' }));
        return true;
      }
      
      const userId = context?.user?.id || 'system';
      const enabled = body.enabled !== undefined ? !!body.enabled : true;
      const result = await createSchedule({ title, prompt, cronExpr: cron.trim(), createdBy: userId });
      // If created with enabled=false, toggle it off
      if (!enabled && result.id) {
        try { await toggleSchedule(result.id, false); } catch(_) { /* v22.0 */ console.error("[supervisor-api] silent catch:", _?.message || _); }
      }
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result, enabled }));
      return true;
    }

    // PATCH /api/supervisor/schedules/:id — Toggle enable/disable
    const schedToggleMatch = path.match(/^\/api\/supervisor\/schedules\/([^/]+)$/);
    if (schedToggleMatch && method === 'PATCH') {
      const schedId = schedToggleMatch[1];
      const body = await readBody(req);
      const { enabled } = body;
      
      if (typeof enabled !== 'boolean' && typeof enabled !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'enabled (boolean) is required' }));
        return true;
      }
      
      await toggleSchedule(schedId, !!enabled);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: schedId, enabled: !!enabled }));
      return true;
    }

    // DELETE /api/supervisor/schedules/:id — Delete a schedule
    const schedDeleteMatch = path.match(/^\/api\/supervisor\/schedules\/([^/]+)$/);
    if (schedDeleteMatch && method === 'DELETE') {
      const schedId = schedDeleteMatch[1];
      await deleteSchedule(schedId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: schedId }));
      return true;
    }

    // ─── Existing Supervisor Endpoints ───────────────────────

    // GET /api/supervisor/health
    if (path === '/api/supervisor/health' && method === 'GET') {
      const health = await getHealth();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...health }));
      return true;
    }

    // GET /api/supervisor/stats — Aggregate stats for dashboard (S12 P3 enhanced)
    if (path === '/api/supervisor/stats' && method === 'GET') {
      const allTasks = await listTasks({ limit: 500 });
      const stats = {
        total: allTasks.length,
        byStatus: {},
        avgSteps: 0,
        avgDurationMs: 0,
        successRate: 0,
        totalTasks: allTasks.length,
        activeTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        avgStepsPerTask: 0,
        avgDuration: 0,
        recentTasks: allTasks.slice(0, 5).map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          totalSteps: t.totalSteps,
          createdAt: t.createdAt,
          completedAt: t.completedAt,
          duration: t.completedAt ? t.completedAt - t.createdAt : null,
        })),
        dailyTrend: [],
        toolUsage: {},
      };

      for (const t of allTasks) {
        stats.byStatus[t.status] = (stats.byStatus[t.status] || 0) + 1;
      }
      stats.activeTasks = (stats.byStatus['running'] || 0) + (stats.byStatus['pending'] || 0);
      stats.completedTasks = stats.byStatus['completed'] || 0;
      stats.failedTasks = stats.byStatus['failed'] || 0;
      const finishedCount = stats.completedTasks + stats.failedTasks;
      stats.successRate = finishedCount > 0 ? stats.completedTasks / finishedCount : 0;

      const withSteps = allTasks.filter(t => t.totalSteps > 0);
      if (withSteps.length > 0) {
        stats.avgSteps = Math.round(withSteps.reduce((s, t) => s + t.totalSteps, 0) / withSteps.length * 10) / 10;
        stats.avgStepsPerTask = stats.avgSteps;
      }

      const completed = allTasks.filter(t => t.completedAt);
      if (completed.length > 0) {
        stats.avgDurationMs = Math.round(completed.reduce((s, t) => s + (t.completedAt - t.createdAt), 0) / completed.length);
        stats.avgDuration = stats.avgDurationMs;
      }

      // S12 P3: Build daily trend (last 14 days)
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const dailyMap = {};
      for (let d = 0; d < 14; d++) {
        const dayStart = now - (13 - d) * dayMs;
        const dateStr = new Date(dayStart).toISOString().slice(0, 10);
        dailyMap[dateStr] = { date: dateStr, total: 0, completed: 0, failed: 0, avgDuration: 0 };
      }
      for (const t of allTasks) {
        const dateStr = new Date(t.createdAt).toISOString().slice(0, 10);
        if (dailyMap[dateStr]) {
          dailyMap[dateStr].total++;
          if (t.status === 'completed') dailyMap[dateStr].completed++;
          if (t.status === 'failed') dailyMap[dateStr].failed++;
        }
      }
      for (const dateStr of Object.keys(dailyMap)) {
        const dayTasks = allTasks.filter(t => {
          const d = new Date(t.createdAt).toISOString().slice(0, 10);
          return d === dateStr && t.completedAt;
        });
        if (dayTasks.length > 0) {
          dailyMap[dateStr].avgDuration = Math.round(
            dayTasks.reduce((s, t) => s + (t.completedAt - t.createdAt), 0) / dayTasks.length
          );
        }
      }
      stats.dailyTrend = Object.values(dailyMap);

      // S12 P3: Tool usage distribution
      const toolPatterns = [
        { name: 'exec', pattern: /exec|shell|命令|执行|df |free |ps |docker |cat |grep |wc / },
        { name: 'web_search', pattern: /web_search|搜索|search/ },
        { name: 'read', pattern: /read|读取|读文件/ },
        { name: 'write', pattern: /write|写入|写文件/ },
        { name: 'llm_only', pattern: /分析|总结|翻译|回答|解释|\[FINISH\]/ },
      ];
      try {
        const allSteps = await listAllSteps({ limit: 500 });
        for (const step of allSteps) {
          if ((step.instruction || '').startsWith('[FINISH]')) continue;
          let matched = false;
          for (const tp of toolPatterns) {
            if (tp.pattern.test(step.instruction || '')) {
              stats.toolUsage[tp.name] = (stats.toolUsage[tp.name] || 0) + 1;
              matched = true;
              break;
            }
          }
          if (!matched) {
            stats.toolUsage['other'] = (stats.toolUsage['other'] || 0) + 1;
          }
        }
      } catch (e) {
        logger.error(`[supervisor-api] Tool usage stats error: ${e.message}`);
      }

      // S14 P0: Failure reasons distribution
      stats.failureReasons = {};
      const failedTasks = allTasks.filter(t => t.status === 'failed' || t.status === 'timeout');
      for (const t of failedTasks) {
        const reason = t.errorReason || 'unknown';
        stats.failureReasons[reason] = (stats.failureReasons[reason] || 0) + 1;
      }

      // S14 P3: Schedule health (per-schedule success rate from last 10 runs)
      try {
        const schedules = await listSchedules();
        stats.scheduleHealth = {};
        for (const sched of schedules) {
          const recentRuns = await query(
            `SELECT status FROM supervisor_tasks WHERE json_extract(metadata, '$.scheduleId') = ? ORDER BY createdAt DESC LIMIT 10`,
            [sched.id]
          );
          if (recentRuns.length > 0) {
            const ok = recentRuns.filter(r => r.status === 'completed').length;
            stats.scheduleHealth[sched.id] = {
              title: sched.title,
              recentRuns: recentRuns.length,
              successCount: ok,
              successRate: Math.round(ok / recentRuns.length * 100),
              consecutiveFailures: sched.consecutiveFailures || 0,
              enabled: !!sched.enabled,
            };
          }
        }
      } catch (e) {
        logger.warn(`[supervisor-api] scheduleHealth error: ${e.message}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return true;
    }

    // S14 P1 + S15 P1: GET /api/supervisor/audit-log — Supervisor audit log
    // S15 P1: Match both old 'supervisor_task' and new 'supervisor_task_completed'/'supervisor_task_failed' actions
    if (path === '/api/supervisor/audit-log' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const statusFilter = url.searchParams.get('status'); // 'completed' | 'failed' | null
      let auditQuery = `SELECT * FROM audit_logs WHERE action IN ('supervisor_task', 'supervisor_task_completed', 'supervisor_task_failed')`;
      const params = [];
      if (statusFilter === 'completed') {
        auditQuery = `SELECT * FROM audit_logs WHERE action = 'supervisor_task_completed'`;
      } else if (statusFilter === 'failed') {
        auditQuery = `SELECT * FROM audit_logs WHERE action = 'supervisor_task_failed'`;
      }
      auditQuery += ' ORDER BY createdAt DESC LIMIT ?';
      params.push(Math.min(limit, 200));
      const logs = await query(auditQuery, params);
      // Parse detail JSON
      const parsed = logs.map(l => {
        let detail = {};
        try { detail = JSON.parse(l.detail || '{}'); } catch(_) { /* v22.0 */ console.error("[supervisor-api] silent catch:", _?.message || _); }
        return { ...l, detail };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, logs: parsed, count: parsed.length }));
      return true;
    }

    // S14 P2: POST /api/supervisor/schedules/:id/run — Immediately trigger a schedule
    const schedRunMatch = path.match(/^\/api\/supervisor\/schedules\/([^/]+)\/run$/);
    if (schedRunMatch && method === 'POST') {
      const schedId = schedRunMatch[1];
      const schedule = await queryOne('SELECT * FROM supervisor_schedules WHERE id = ?', [schedId]);
      if (!schedule) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Schedule not found' }));
        return true;
      }
      // Generate a task ID and submit
      const taskId = `atask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const taskTitle = `[手动触发] ${schedule.title}`;
      try {
        await run(
          `INSERT INTO autonomous_tasks (id, userId, type, title, description, status, priority, metadata) VALUES (?, ?, 'scheduled', ?, ?, 'queued', 5, ?)`,
          [taskId, context?.user?.id || 'system', taskTitle, schedule.prompt, JSON.stringify({ scheduleId: schedule.id, manualTrigger: true })]
        );
        await sendCommand({
          type: 'submit_autonomous_task',
          taskId,
          userId: context?.user?.id || 'system',
          title: taskTitle,
          description: schedule.prompt,
          taskType: 'scheduled',
          priority: 5,
        });
        // Update schedule metadata
        await run(
          `UPDATE supervisor_schedules SET lastRunAt = ?, lastRunTaskId = ?, lastRunStatus = 'running', updatedAt = ? WHERE id = ?`,
          [new Date().toISOString(), taskId, new Date().toISOString(), schedId]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, taskId, message: `Schedule "${schedule.title}" triggered manually` }));
      } catch (e) {
        logger.error(`[supervisor-api] Manual schedule run error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    }

    // GET /api/supervisor/tasks — List tasks
    if (path === '/api/supervisor/tasks' && method === 'GET') {
      const userId = url.searchParams.get('userId') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const chatId = url.searchParams.get('chatId') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      
      let tasks = await listTasks({ userId, status, limit });
      // Filter by chatId if provided
      if (chatId && Array.isArray(tasks)) {
        tasks = tasks.filter(t => t.chatId === chatId || t.sessionKey === chatId);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tasks, count: tasks.length }));
      return true;
    }

    // GET /api/supervisor/tasks/:id — Get task detail with enriched steps
    const detailMatch = path.match(/^\/api\/supervisor\/tasks\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      let taskId = detailMatch[1];
      
      // S13 P3: If the ID starts with 'atask_', resolve it to the corresponding sv_* ID
      if (taskId.startsWith('atask_')) {
        const svId = await resolveAtaskToSvId(taskId);
        if (svId) {
          taskId = svId;
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No supervisor task found for autonomous task ID' }));
          return true;
        }
      }
      
      const task = await getTask(taskId);
      
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Task not found' }));
        return true;
      }

      task.steps = enrichSteps(task.steps);
      
      // S15 P0: Parse plan JSON for task detail
      if (task.plan) {
        try {
          task.plan = typeof task.plan === 'string' ? JSON.parse(task.plan) : task.plan;
        } catch (_) { task.plan = null; }
      }
      
      // S12 P1: If no live steps found, try metadata-persisted steps
      if ((!task.steps || task.steps.length === 0) && task.metadata) {
        try {
          const meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
          if (meta.steps && meta.steps.length > 0) {
            task.steps = meta.steps;
            task._stepsSource = 'metadata';
          }
          if (meta.duration_ms) task.duration_ms = meta.duration_ms;
          if (meta.completed_at) task.completed_at_ts = meta.completed_at;
        } catch(_) { /* v22.0 */ console.error("[supervisor-api] silent catch:", _?.message || _); }
      }
      
      // S12 P0: Parse structured result
      if (task.result) {
        try {
          const parsed = JSON.parse(task.result);
          if (parsed.answer) {
            task.structured = parsed;
            task.result_text = parsed.answer;
          }
        } catch (_) {
          task.result_text = task.result;
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, task }));
      return true;
    }

    // S15 P2: POST /api/supervisor/schedules — Create a new scheduled task
    if (path === '/api/supervisor/schedules' && method === 'POST') {
      const user = context?.user;
      if (!user || user.role !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Admin only' }));
        return true;
      }
      const body = await readBody(req);
      const { title, prompt, cron, enabled } = body;
      if (!title || !prompt || !cron) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing required fields: title, prompt, cron' }));
        return true;
      }
      try {
        const schedId = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        await run(
          `INSERT INTO supervisor_schedules (id, title, prompt, cron, enabled, consecutiveFailures, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          [schedId, title, prompt, cron, enabled !== false ? 1 : 0, now, now]
        );
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: schedId, message: `Schedule "${title}" created` }));
      } catch (e) {
        logger.error(`[supervisor-api] Create schedule error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    }

    // S15 P2: PATCH /api/supervisor/schedules/:id — Update a schedule
    const schedPatchMatch = path.match(/^\/api\/supervisor\/schedules\/([^/]+)$/);
    if (schedPatchMatch && method === 'PATCH') {
      const user = context?.user;
      if (!user || user.role !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Admin only' }));
        return true;
      }
      const schedId = schedPatchMatch[1];
      const body = await readBody(req);
      const updates = [];
      const params = [];
      if (body.title !== undefined) { updates.push('title = ?'); params.push(body.title); }
      if (body.prompt !== undefined) { updates.push('prompt = ?'); params.push(body.prompt); }
      if (body.cron !== undefined) { updates.push('cron = ?'); params.push(body.cron); }
      if (body.enabled !== undefined) { updates.push('enabled = ?'); params.push(body.enabled ? 1 : 0); }
      if (body.consecutiveFailures !== undefined) { updates.push('consecutiveFailures = ?'); params.push(body.consecutiveFailures); }
      if (updates.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No fields to update' }));
        return true;
      }
      updates.push('updatedAt = ?');
      params.push(new Date().toISOString());
      params.push(schedId);
      try {
        await run(`UPDATE supervisor_schedules SET ${updates.join(', ')} WHERE id = ?`, params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `Schedule ${schedId} updated` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    }

    // S15 P2: DELETE /api/supervisor/schedules/:id — Delete a schedule
    const schedDelMatch = path.match(/^\/api\/supervisor\/schedules\/([^/]+)$/);
    if (schedDelMatch && method === 'DELETE') {
      const user = context?.user;
      if (!user || user.role !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Admin only' }));
        return true;
      }
      const schedId = schedDelMatch[1];
      try {
        await run('DELETE FROM supervisor_schedules WHERE id = ?', [schedId]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `Schedule ${schedId} deleted` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    }

    // POST /api/supervisor/tasks/cleanup — Admin cleanup
    if (path === '/api/supervisor/tasks/cleanup' && method === 'POST') {
      const user = context?.user;
      if (!user || user.role !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Admin only' }));
        return true;
      }
      const body = await readBody(req);
      const beforeTimestamp = body.beforeTimestamp || (Date.now() - 24 * 60 * 60 * 1000);
      const result = await cleanupFailedTasks(beforeTimestamp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return true;
    }

    // POST /api/supervisor/tasks/:id/cancel
    const cancelMatch = path.match(/^\/api\/supervisor\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      let taskId = cancelMatch[1];
      
      if (taskId.startsWith('atask_')) {
        const svId = await resolveAtaskToSvId(taskId);
        if (svId) taskId = svId;
      }
      
      const cancelled = await cancelTask(taskId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelled }));
      return true;
    }

    return false;
  } catch (err) {
    logger.error(`[supervisor-api] Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
    return true;
  }
}
