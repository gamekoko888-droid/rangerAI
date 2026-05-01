/**
 * Ticket & KOL Management API Module (v66 - DI refactor)
 * Handles /api/tickets, /api/kols, /api/notifications routes
 *
 * Sub-iter 4.5B: Migrated to init(deps) pattern.
 * All database access via deps.db (db-adapter functions + sendJson).
 * OpenClaw gateway access via deps.callGateway (pre-bound with token).
 *
 * @module ticket-kol-api
 *
 * @typedef {Object} TicketKolApiDeps
 * @property {Object} db                - Database access layer
 * @property {Function} db.query        - Execute SQL query, return rows
 * @property {Function} db.queryOne     - Execute SQL query, return single row
 * @property {Function} db.run          - Execute SQL write (INSERT/UPDATE/DELETE)
 * @property {Function} db.exec         - Execute raw SQL statement
 * @property {Function} db.sendJson     - Send JSON HTTP response
 * @property {Function} callGateway     - Call OpenClaw gateway (messages, maxTokens?, temperature?) => string
 */

import { logger } from '../lib/logger.mjs';
import { validateDeps } from '../lib/context.mjs';

/** @type {TicketKolApiDeps} */
let deps = null;

/**
 * Initialize module with injected dependencies.
 * @param {TicketKolApiDeps} injected
 */
export function init(injected) {
  validateDeps(['db', 'callGateway'], injected, 'ticket-kol-api');
  validateDeps(['query', 'queryOne', 'run', 'sendJson'], injected.db, 'ticket-kol-api.db');
  deps = injected;
  logger.info('[ticket-kol-api] Initialized with DI deps');
}

// ─── SQL Column Whitelists (R94 security hardening) ───

const ALLOWED_ASSIGN_RULES_COLS = ['category', 'priority', 'assignee', 'assignee_name', 'is_active'];
const ALLOWED_TICKETS_COLS = ['status', 'priority', 'assigned_to', 'resolution', 'category', 'ai_suggestion', 'title', 'description'];
const ALLOWED_KOLS_COLS = ['name', 'platform', 'handle', 'followers', 'engagement_rate', 'category', 'country', 'language', 'contact_email', 'contact_phone', 'status', 'cooperation_status', 'notes', 'tags'];

// ─── Internal Helpers (use deps) ───

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { logger.debug("[ticket-kol] caught:", e?.message); resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * Create a notification record in the database.
 * Uses deps.db.run instead of direct import.
 */
async function createNotification({ title, content, type = 'info', target_user = null, related_type = null, related_id = null }) {
  const { db } = deps;
  try {
    await db.run(
      'INSERT INTO notifications (title, content, type, target_user, related_type, related_id) VALUES (?, ?, ?, ?, ?, ?)',
      [title, content, type, target_user, related_type, related_id]
    );
    // Broadcast to connected WS clients
    broadcastNotification({ title, content, type, target_user, related_type, related_id, created_at: new Date().toISOString() });
  } catch (e) { logger.error('Create notification error:', e.message); }
}
/**
 * Broadcast a notification event to all connected WebSocket clients.
 * This enables real-time notification updates without polling.
 */
function broadcastNotification(notification) {
  try {
    const wss = deps.runtime?.wss;
    if (!wss) return;
    const payload = JSON.stringify({
      type: 'notification_new',
      notification,
    });
    let sent = 0;
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(payload);
        sent++;
      }
    }
    if (sent > 0) logger.info(`[notification] Broadcasted to ${sent} clients`);
  } catch (e) {
    logger.error('[notification] Broadcast error:', e.message);
  }
}

/**
 * Auto-assign rules: category → assigned_to mapping.
 * Uses deps.db.queryOne instead of direct import.
 */
async function getAutoAssignee(category, priority) {
  const { db } = deps;
  try {
    let rule = await db.queryOne(
      "SELECT * FROM assign_rules WHERE category = ? AND (priority = ? OR priority = 'all') AND is_active = 1 ORDER BY priority DESC LIMIT 1",
      [category, priority]
    );
    if (rule) return rule.assignee;
    rule = await db.queryOne('SELECT * FROM assign_rules WHERE category = ? AND is_active = 1 LIMIT 1', [category]);
    if (rule) return rule.assignee;
    rule = await db.queryOne("SELECT * FROM assign_rules WHERE category = 'default' AND is_active = 1 LIMIT 1");
    if (rule) return rule.assignee;
    return null;
  } catch { return null; }
}

// ─── Main Route Handler ───

export async function handleTicketKolApi(req, res) {
  try {
  const { db, callGateway } = deps;
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // ========== NOTIFICATION API ==========
  if (urlPath.startsWith('/api/notifications')) {
    const notifPath = urlPath.replace('/api/notifications', '');

    // GET /api/notifications — list notifications
    if (method === 'GET' && (notifPath === '' || notifPath === '/')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const unreadOnly = params.get('unread') === 'true';
      const limit = parseInt(params.get('limit') || '50');
      const offset = parseInt(params.get('offset') || '0');

      let sql = 'SELECT * FROM notifications WHERE 1=1';
      const qp = [];
      if (unreadOnly) { sql += ' AND is_read = 0'; }
      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      qp.push(limit, offset);

      const notifications = await db.query(sql, qp);
      const unreadRow = await db.queryOne('SELECT COUNT(*) as c FROM notifications WHERE is_read = 0');
      const totalRow = await db.queryOne('SELECT COUNT(*) as c FROM notifications');
      db.sendJson(res, 200, { notifications, unread_count: unreadRow.c, total: totalRow.c });
      return true;
    }

    // GET /api/notifications/unread-count
    if (method === 'GET' && notifPath === '/unread-count') {
      const row = await db.queryOne('SELECT COUNT(*) as c FROM notifications WHERE is_read = 0');
      db.sendJson(res, 200, { count: row.c });
      return true;
    }

    // PATCH /api/notifications/:id/read — mark as read
    const readMatch = notifPath.match(/^\/([0-9]+)\/read$/);
    if (method === 'PATCH' && readMatch) {
      await db.run('UPDATE notifications SET is_read = 1 WHERE id = ?', [readMatch[1]]);
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // POST /api/notifications/read-all — mark all as read
    if (method === 'POST' && notifPath === '/read-all') {
      await db.run('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // DELETE /api/notifications/:id
    const delNotifMatch = notifPath.match(/^\/([0-9]+)$/);
    if (method === 'DELETE' && delNotifMatch) {
      await db.run('DELETE FROM notifications WHERE id = ?', [delNotifMatch[1]]);
      db.sendJson(res, 200, { success: true });
      return true;
    }

    db.sendJson(res, 404, { error: 'Notification endpoint not found' });
    return true;
  }

  // ========== TICKET MANAGEMENT API ==========
  if (urlPath.startsWith('/api/tickets')) {
    const ticketPath = urlPath.replace('/api/tickets', '');

    // GET /api/tickets/stats
    if (method === 'GET' && ticketPath === '/stats') {
      const [total, open, in_progress, resolved, closed, by_category, by_priority] = await Promise.all([
        db.queryOne('SELECT COUNT(*) as c FROM tickets'),
        db.queryOne("SELECT COUNT(*) as c FROM tickets WHERE status = 'open'"),
        db.queryOne("SELECT COUNT(*) as c FROM tickets WHERE status = 'in_progress'"),
        db.queryOne("SELECT COUNT(*) as c FROM tickets WHERE status = 'resolved'"),
        db.queryOne("SELECT COUNT(*) as c FROM tickets WHERE status = 'closed'"),
        db.query('SELECT category, COUNT(*) as count FROM tickets GROUP BY category'),
        db.query('SELECT priority, COUNT(*) as count FROM tickets GROUP BY priority'),
      ]);
      db.sendJson(res, 200, {
        total: total.c, open: open.c, in_progress: in_progress.c,
        resolved: resolved.c, closed: closed.c, by_category, by_priority,
      });
      return true;
    }

    // GET /api/tickets/trend
    if (method === 'GET' && ticketPath === '/trend') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const days = parseInt(params.get('days') || '30');
      const trend = [];
      for (let i = days - 1; i >= 0; i--) {
        const dayStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const createdRow = await db.queryOne("SELECT COUNT(*) as c FROM tickets WHERE DATE(created_at) = ?", [dayStr]);
        const resolvedRow = await db.queryOne("SELECT COUNT(*) as c FROM tickets WHERE DATE(updated_at) = ? AND status IN ('resolved','closed')", [dayStr]);
        trend.push({ date: dayStr, created: createdRow?.c || 0, resolved: resolvedRow?.c || 0 });
      }
      db.sendJson(res, 200, { trend, days });
      return true;
    }

    // POST /api/tickets/ai-classify
    if (method === 'POST' && ticketPath === '/ai-classify') {
      const body = await parseJsonBody(req);
      const title = body.title || '';
      const description = body.description || '';
      try {
        const content = await callGateway([
          { role: 'system', content: 'You are a customer service ticket classifier for a global game top-up supply chain company (游侠出海). Analyze the ticket and return JSON with: category (one of: general, product, shipping, payment, refund, account), priority (one of: low, medium, high, urgent), and reason (brief explanation in Chinese). Only return valid JSON, no markdown.' },
          { role: 'user', content: `Ticket title: ${title}\nDescription: ${description}` }
        ]);
        let parsed;
        try { parsed = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
        catch { parsed = { category: 'general', priority: 'medium', reason: 'AI 无法分类' }; }
        const assignee = await getAutoAssignee(parsed.category || 'general', parsed.priority || 'medium');
        db.sendJson(res, 200, { category: parsed.category || 'general', priority: parsed.priority || 'medium', reason: parsed.reason || '', suggested_assignee: assignee });
      } catch (e) {
        logger.error('AI classify error:', e);
        db.sendJson(res, 200, { category: 'general', priority: 'medium', reason: 'AI 分类暂不可用', suggested_assignee: null });
      }
      return true;
    }

    // GET /api/tickets/assign-rules — list assign rules
    if (method === 'GET' && ticketPath === '/assign-rules') {
      const rules = await db.query('SELECT * FROM assign_rules ORDER BY category, priority');
      db.sendJson(res, 200, rules);
      return true;
    }

    // POST /api/tickets/assign-rules — create assign rule
    if (method === 'POST' && ticketPath === '/assign-rules') {
      const body = await parseJsonBody(req);
      const result = await db.run(
        'INSERT INTO assign_rules (category, priority, assignee, assignee_name, is_active) VALUES (?, ?, ?, ?, ?)',
        [body.category || 'default', body.priority || 'all', body.assignee || '', body.assignee_name || '', body.is_active !== false ? 1 : 0]
      );
      db.sendJson(res, 200, { id: result.lastInsertRowid });
      return true;
    }

    // PATCH /api/tickets/assign-rules/:id — update assign rule
    const ruleMatch = ticketPath.match(/^\/assign-rules\/([0-9]+)$/);
    if (method === 'PATCH' && ruleMatch) {
      const body = await parseJsonBody(req);
      const updates = [];
      const params = [];
      for (const [key, val] of Object.entries(body)) {
        if (ALLOWED_ASSIGN_RULES_COLS.includes(key)) {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }
      if (updates.length > 0) {
        params.push(ruleMatch[1]);
        await db.run(`UPDATE assign_rules SET ${updates.join(', ')} WHERE id = ?`, params);
      }
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // DELETE /api/tickets/assign-rules/:id
    const ruleDelMatch = ticketPath.match(/^\/assign-rules\/([0-9]+)$/);
    if (method === 'DELETE' && ruleDelMatch) {
      await db.run('DELETE FROM assign_rules WHERE id = ?', [ruleDelMatch[1]]);
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // GET /api/tickets — list tickets
    if (method === 'GET' && (ticketPath === '' || ticketPath === '/')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const status = params.get('status');
      const category = params.get('category');
      const priority = params.get('priority');
      const assigned_to = params.get('assigned_to');
      const limit = parseInt(params.get('limit') || '50');
      const offset = parseInt(params.get('offset') || '0');

      let sql = 'SELECT * FROM tickets WHERE 1=1';
      const queryParams = [];
      if (status) { sql += ' AND status = ?'; queryParams.push(status); }
      if (category) { sql += ' AND category = ?'; queryParams.push(category); }
      if (priority) { sql += ' AND priority = ?'; queryParams.push(priority); }
      if (assigned_to) { sql += ' AND assigned_to = ?'; queryParams.push(assigned_to); }
      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      queryParams.push(limit, offset);

      const tickets = await db.query(sql, queryParams);
      const totalRow = await db.queryOne('SELECT COUNT(*) as count FROM tickets');
      db.sendJson(res, 200, { tickets, total: totalRow.count });
      return true;
    }

    // POST /api/tickets — create ticket (with auto-assign)
    if (method === 'POST' && (ticketPath === '' || ticketPath === '/')) {
      const body = await parseJsonBody(req);
      const ticketNo = 'TK-' + Date.now().toString(36).toUpperCase();
      const category = body.category || 'general';
      const priority = body.priority || 'medium';
      const autoAssignee = body.assigned_to || await getAutoAssignee(category, priority);
      const result = await db.run(
        'INSERT INTO tickets (ticket_no, title, description, category, priority, customer_name, customer_email, customer_platform, created_by, assigned_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [ticketNo, body.title || 'Untitled', body.description || '', category, priority, body.customer_name || '', body.customer_email || '', body.customer_platform || '', body.created_by || 'system', autoAssignee || null]
      );
      await createNotification({
        title: `新工单: ${body.title || 'Untitled'}`,
        content: `工单 ${ticketNo} 已创建，分类: ${category}，优先级: ${priority}${autoAssignee ? `，已分配给: ${autoAssignee}` : ''}`,
        type: 'ticket',
        target_user: autoAssignee,
        related_type: 'ticket',
        related_id: Number(result.lastInsertRowid)
      });
      db.sendJson(res, 200, { id: result.lastInsertRowid, ticket_no: ticketNo, assigned_to: autoAssignee });
      return true;
    }

    // GET /api/tickets/:id
    const ticketIdMatch = ticketPath.match(/^\/([0-9]+)$/);
    if (method === 'GET' && ticketIdMatch) {
      const ticket = await db.queryOne('SELECT * FROM tickets WHERE id = ?', [ticketIdMatch[1]]);
      if (!ticket) { db.sendJson(res, 404, { error: 'Not found' }); return true; }
      let comments = [];
      try { comments = await db.query('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC', [ticket.id]); } catch(e) { logger.debug('[ticket-kol] query failed:', e?.message); }
      db.sendJson(res, 200, { ...ticket, comments });
      return true;
    }

    // PATCH /api/tickets/:id
    if (method === 'PATCH' && ticketIdMatch) {
      const body = await parseJsonBody(req);
      const oldTicket = await db.queryOne('SELECT * FROM tickets WHERE id = ?', [ticketIdMatch[1]]);
      const updates = [];
      const params = [];
      for (const [key, val] of Object.entries(body)) {
        if (ALLOWED_TICKETS_COLS.includes(key)) {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }
      if (body.status === 'resolved') updates.push('resolved_at = CURRENT_TIMESTAMP');
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(ticketIdMatch[1]);
      if (updates.length > 1) {
        await db.run(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`, params);
      }
      if (body.status && oldTicket && body.status !== oldTicket.status) {
        const statusLabels = { open: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
        await createNotification({
          title: `工单状态变更: ${oldTicket.ticket_no}`,
          content: `工单 "${oldTicket.title}" 状态从 ${statusLabels[oldTicket.status] || oldTicket.status} 变更为 ${statusLabels[body.status] || body.status}`,
          type: 'ticket',
          related_type: 'ticket',
          related_id: parseInt(ticketIdMatch[1])
        });
      }
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // DELETE /api/tickets/:id
    const ticketDelMatch = ticketPath.match(/^\/([0-9]+)$/);
    if (method === 'DELETE' && ticketDelMatch) {
      await db.run('DELETE FROM ticket_comments WHERE ticket_id = ?', [ticketDelMatch[1]]);
      await db.run('DELETE FROM tickets WHERE id = ?', [ticketDelMatch[1]]);
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // POST /api/tickets/:id/comments
    const commentMatch = ticketPath.match(/^\/([0-9]+)\/comments$/);
    if (method === 'POST' && commentMatch) {
      const body = await parseJsonBody(req);
      const result = await db.run(
        'INSERT INTO ticket_comments (ticket_id, author, content, is_internal) VALUES (?, ?, ?, ?)',
        [commentMatch[1], body.author || 'system', body.content || '', body.is_internal ? 1 : 0]
      );
      db.sendJson(res, 200, { id: result.lastInsertRowid });
      return true;
    }

    db.sendJson(res, 404, { error: 'Ticket endpoint not found' });
    return true;
  }

  // ========== KOL MANAGEMENT API ==========
  if (urlPath.startsWith('/api/kols')) {
    const kolPath = urlPath.replace('/api/kols', '');

    // GET /api/kols/stats
    if (method === 'GET' && kolPath === '/stats') {
      const [total, by_platform, by_status, by_country, total_cooperations, active_cooperations] = await Promise.all([
        db.queryOne('SELECT COUNT(*) as c FROM kols'),
        db.query('SELECT platform, COUNT(*) as count FROM kols GROUP BY platform'),
        db.query('SELECT status, COUNT(*) as count FROM kols GROUP BY status'),
        db.query("SELECT country, COUNT(*) as count FROM kols WHERE country IS NOT NULL AND country != '' GROUP BY country"),
        db.queryOne('SELECT COUNT(*) as c FROM kol_cooperations'),
        db.queryOne("SELECT COUNT(*) as c FROM kol_cooperations WHERE status = 'active'"),
      ]);
      db.sendJson(res, 200, {
        total: total.c, by_platform, by_status, by_country,
        total_cooperations: total_cooperations.c, active_cooperations: active_cooperations.c,
      });
      return true;
    }

    // GET /api/kols/weekly-stats — 周绩效数据（来自 data_uploads 导入）
    if (method === 'GET' && kolPath === '/weekly-stats') {
      const weekParam = new URLSearchParams(req.url.split('?')[1] || '').get('week');
      let rows;
      if (weekParam) {
        rows = await db.query(
          'SELECT * FROM kol_weekly_stats WHERE week_start = ? ORDER BY gmv DESC',
          [weekParam]
        );
      } else {
        // 默认返回最近一周数据
        rows = await db.query(
          'SELECT * FROM kol_weekly_stats ORDER BY week_start DESC, gmv DESC LIMIT 50'
        );
      }
      // 汇总统计
      const totals = rows.reduce((acc, r) => {
        acc.totalGmv += (r.gmv || 0);
        acc.totalOrders += (r.orders || 0);
        acc.totalCost += (r.cost || 0);
        return acc;
      }, { totalGmv: 0, totalOrders: 0, totalCost: 0 });
      totals.avgRoi = totals.totalCost > 0 ? Math.round(totals.totalGmv / totals.totalCost * 100) : 0;

      return db.sendJson(res, 200, { success: true, data: rows, totals, count: rows.length });
    }

    // POST /api/kols/batch-refresh — batch refresh all KOL data via OpenClaw
    if (method === 'POST' && kolPath === '/batch-refresh') {
      const kols = await db.query('SELECT id, name, platform, handle FROM kols WHERE status = "active"');
      const results = [];
      for (const kol of kols) {
        try {
          const content = await callGateway([
            { role: 'system', content: 'You are a social media data analyst. Given a KOL\'s platform and handle, estimate their current followers count and engagement rate. Return JSON with: followers (integer), engagement_rate (float 0-100), trending (up/down/stable), estimated_reach (integer). Only return valid JSON, no markdown.' },
            { role: 'user', content: `Platform: ${kol.platform}, Handle: ${kol.handle || kol.name}` }
          ], 200, 0.5);
          let parsed;
          try { parsed = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
          catch { parsed = null; }
          if (parsed && parsed.followers) {
            await db.run(
              'UPDATE kols SET followers = ?, engagement_rate = ?, data_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [parsed.followers, parsed.engagement_rate || 0, kol.id]
            );
            results.push({ id: kol.id, name: kol.name, status: 'updated', data: parsed });
          } else {
            results.push({ id: kol.id, name: kol.name, status: 'skipped', reason: 'Invalid AI response' });
          }
        } catch (e) {
          results.push({ id: kol.id, name: kol.name, status: 'error', reason: e.message });
        }
      }
      const updated = results.filter(r => r.status === 'updated').length;
      await createNotification({
        title: 'KOL 数据批量刷新完成',
        content: `共 ${kols.length} 个 KOL，成功更新 ${updated} 个`,
        type: 'kol'
      });
      db.sendJson(res, 200, { total: kols.length, results });
      return true;
    }

    // POST /api/kols/:id/refresh — refresh single KOL data via OpenClaw
    const refreshMatch = kolPath.match(/^\/([0-9]+)\/refresh$/);
    if (method === 'POST' && refreshMatch) {
      const kol = await db.queryOne('SELECT * FROM kols WHERE id = ?', [refreshMatch[1]]);
      if (!kol) { db.sendJson(res, 404, { error: 'Not found' }); return true; }
      try {
        const content = await callGateway([
          { role: 'system', content: 'You are a social media data analyst. Given a KOL\'s platform and handle, estimate their current followers count and engagement rate based on your knowledge. Return JSON with: followers (integer), engagement_rate (float 0-100), trending (up/down/stable), estimated_reach (integer), content_frequency (posts per week estimate). Only return valid JSON, no markdown.' },
          { role: 'user', content: `Platform: ${kol.platform}, Handle: ${kol.handle || kol.name}, Current followers: ${kol.followers}, Category: ${kol.category || 'gaming'}` }
        ], 300, 0.5);
        let parsed;
        try { parsed = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
        catch { parsed = null; }
        if (parsed && parsed.followers) {
          await db.run(
            'UPDATE kols SET followers = ?, engagement_rate = ?, data_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [parsed.followers, parsed.engagement_rate || kol.engagement_rate, kol.id]
          );
          db.sendJson(res, 200, { success: true, data: parsed });
        } else {
          db.sendJson(res, 200, { success: false, reason: 'AI 无法获取数据' });
        }
      } catch (e) {
        logger.error('KOL refresh error:', e);
        db.sendJson(res, 200, { success: false, reason: 'AI 数据刷新暂不可用' });
      }
      return true;
    }

    // GET /api/kols — list KOLs
    if (method === 'GET' && (kolPath === '' || kolPath === '/')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const platform = params.get('platform');
      const status = params.get('status');
      const category = params.get('category');
      const search = params.get('search');
      const limit = parseInt(params.get('limit') || '50');
      const offset = parseInt(params.get('offset') || '0');

      let sql = 'SELECT * FROM kols WHERE 1=1';
      const queryParams = [];
      if (platform) { sql += ' AND platform = ?'; queryParams.push(platform); }
      if (status) { sql += ' AND status = ?'; queryParams.push(status); }
      if (category) { sql += ' AND category = ?'; queryParams.push(category); }
      if (search) { sql += ' AND (name LIKE ? OR handle LIKE ?)'; queryParams.push(`%${search}%`, `%${search}%`); }
      sql += ' ORDER BY followers DESC LIMIT ? OFFSET ?';
      queryParams.push(limit, offset);

      const kols = await db.query(sql, queryParams);
      const totalRow = await db.queryOne('SELECT COUNT(*) as count FROM kols');
      db.sendJson(res, 200, { kols, total: totalRow.count });
      return true;
    }

    // POST /api/kols — create KOL
    if (method === 'POST' && (kolPath === '' || kolPath === '/')) {
      const body = await parseJsonBody(req);
      const result = await db.run(
        'INSERT INTO kols (name, platform, handle, followers, category, country, language, contact_email, contact_phone, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [body.name || 'Unknown', body.platform || 'Other', body.handle || '', body.followers || 0, body.category || 'gaming', body.country || '', body.language || '', body.contact_email || '', body.contact_phone || '', body.status || 'active', body.notes || '']
      );
      await createNotification({
        title: `新 KOL 添加: ${body.name || 'Unknown'}`,
        content: `平台: ${body.platform || 'Other'}，粉丝: ${body.followers || 0}`,
        type: 'kol',
        related_type: 'kol',
        related_id: Number(result.lastInsertRowid)
      });
      db.sendJson(res, 200, { id: result.lastInsertRowid });
      return true;
    }

    // GET /api/kols/:id
    const kolIdMatch = kolPath.match(/^\/([0-9]+)$/);
    if (method === 'GET' && kolIdMatch) {
      const kol = await db.queryOne('SELECT * FROM kols WHERE id = ?', [kolIdMatch[1]]);
      if (!kol) { db.sendJson(res, 404, { error: 'Not found' }); return true; }
      const cooperations = await db.query('SELECT * FROM kol_cooperations WHERE kol_id = ? ORDER BY created_at DESC', [kol.id]);
      db.sendJson(res, 200, { ...kol, cooperations });
      return true;
    }

    // PATCH /api/kols/:id
    if (method === 'PATCH' && kolIdMatch) {
      const body = await parseJsonBody(req);
      const updates = [];
      const params = [];
      for (const [key, val] of Object.entries(body)) {
        if (ALLOWED_KOLS_COLS.includes(key)) {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(kolIdMatch[1]);
      await db.run(`UPDATE kols SET ${updates.join(', ')} WHERE id = ?`, params);
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // DELETE /api/kols/:id
    if (method === 'DELETE' && kolIdMatch) {
      await db.run('DELETE FROM kol_cooperations WHERE kol_id = ?', [kolIdMatch[1]]);
      await db.run('DELETE FROM kols WHERE id = ?', [kolIdMatch[1]]);
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // POST /api/kols/:id/cooperations
    const coopMatch = kolPath.match(/^\/([0-9]+)\/cooperations$/);
    if (method === 'POST' && coopMatch) {
      const body = await parseJsonBody(req);
      const result = await db.run(
        'INSERT INTO kol_cooperations (kol_id, campaign_name, content_type, start_date, end_date, budget, actual_cost, deliverables, performance_metrics, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [coopMatch[1], body.campaign_name || 'Untitled', body.content_type || 'promotion', body.start_date || null, body.end_date || null, body.budget || 0, body.actual_cost || 0, body.deliverables || '', body.performance_metrics || '', body.status || 'planning', body.notes || '']
      );
      const kol = await db.queryOne('SELECT name FROM kols WHERE id = ?', [coopMatch[1]]);
      await createNotification({
        title: `新合作记录: ${kol?.name || 'KOL'}`,
        content: `活动: ${body.campaign_name || 'Untitled'}，预算: ¥${body.budget || 0}`,
        type: 'kol',
        related_type: 'kol',
        related_id: parseInt(coopMatch[1])
      });
      db.sendJson(res, 200, { id: result.lastInsertRowid });
      return true;
    }

    db.sendJson(res, 404, { error: 'KOL endpoint not found' });
    return true;
  }

  return false;
  } catch (err) {
    logger.error('[ticket-kol-api] Unhandled error:', err.message, err.stack);
    try {
      if (!res.headersSent) {
        const statusCode = err.message === 'Invalid JSON' ? 400 : 500;
        const errorMsg = statusCode === 400 ? 'Invalid JSON in request body' : 'Internal server error';
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMsg }));
      }
    } catch (e) { /* response already sent */ }
    return true;
  }
}
