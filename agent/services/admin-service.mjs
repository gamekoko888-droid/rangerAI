/**
 * RangerAI Admin Service — Domain: System Status, Config, Audit Logs, Health Checks
 * Phase 2 of architecture decoupling: Service layer extracted from database.mjs
 */
import { logger } from '../lib/logger.mjs';
import { query, queryOne, run, getAdapter, isMySQL } from '../db-adapter.mjs';

// ─── Helpers ────────────────────────────────────────────────
function now() { return isMySQL() ? 'NOW()' : "datetime('now')"; }
function nowMinus(days) {
  return isMySQL()
    ? `DATE_SUB(NOW(), INTERVAL ${days} DAY)`
    : `datetime('now', '-${days} days')`;
}
function dateFunc(col) { return isMySQL() ? `DATE(${col})` : `date(${col})`; }

// ─── System Status & Stats ──────────────────────────────────
export async function getStats() {
  try {
    const totalChats = await queryOne("SELECT COUNT(*) as count FROM chats");
    const totalMessages = await queryOne("SELECT COUNT(*) as count FROM messages");
    const totalUsers = await queryOne("SELECT COUNT(*) as count FROM users WHERE isActive = 1");
    // Message trend (last 30 days, split by role)
    const messageTrend = await query(
      `SELECT ${dateFunc('createdAt')} as day,
              SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as userMsgs,
              SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as aiMsgs,
              COUNT(*) as total
       FROM messages WHERE createdAt >= ${nowMinus(30)}
       GROUP BY ${dateFunc('createdAt')} ORDER BY day ASC`
    );
    // Role distribution
    const roleDistribution = await query(
      "SELECT role, COUNT(*) as count FROM messages GROUP BY role ORDER BY count DESC"
    );
    // Top models (for model usage chart)
    const topModels = await query(
      "SELECT model, COUNT(*) as count FROM messages WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC LIMIT 10"
    );
    // Tag stats
    let tagStats = [];
    try {
      tagStats = await query(
        "SELECT tags, COUNT(*) as count FROM chats WHERE tags IS NOT NULL AND tags != '' GROUP BY tags ORDER BY count DESC LIMIT 20"
      );
    } catch (e) { /* tags column may not exist */ }
    // User activity (top 20 by message count)
    const userActivity = await query(
      `SELECT u.username, u.role, MAX(m.createdAt) as lastLoginAt,
              COUNT(DISTINCT c.id) as chatCount, COUNT(m.id) as messageCount
       FROM users u
       LEFT JOIN chats c ON c.userId = u.id
       LEFT JOIN messages m ON m.chatId = c.id
       WHERE u.isActive = 1
       GROUP BY u.id
       ORDER BY messageCount DESC
       LIMIT 20`
    );
    // DB size (SQLite specific)
    let dbSizeBytes = 0;
    let dbSizeMB = '0';
    try {
      const fs = await import('fs');
      const dbPath = process.env.DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const stat = fs.statSync(dbPath);
      dbSizeBytes = stat.size;
      dbSizeMB = (stat.size / 1024 / 1024).toFixed(1);
    } catch (e) { /* ignore */ }
    // Last activity
    const lastMsg = await queryOne("SELECT MAX(createdAt) as last FROM messages");
    return {
      // Match frontend StatsResponse interface exactly
      chats: totalChats.count,
      messages: totalMessages.count,
      users: totalUsers.count,
      // Also keep totalX aliases for backward compat
      totalChats: totalChats.count,
      totalMessages: totalMessages.count,
      totalUsers: totalUsers.count,
      dbSizeBytes,
      dbSizeMB,
      messageTrend,
      roleDistribution,
      topModels,
      tagStats,
      userActivity,
      lastActivity: lastMsg?.last || null,
    };
  } catch (e) {
    logger.error('[admin-service] getStats error:', e.message);
    return { error: e.message };
  }
}

export async function getSystemStatus() {
  try {
    const userCount = await queryOne("SELECT COUNT(*) as count FROM users");
    const chatCount = await queryOne("SELECT COUNT(*) as count FROM chats");
    const msgCount = await queryOne("SELECT COUNT(*) as count FROM messages");
    return {
      users: userCount.count,
      chats: chatCount.count,
      messages: msgCount.count
    };
  } catch (e) {
    logger.error('[admin-service] getSystemStatus error:', e.message);
    return { error: e.message };
  }
}

// ─── System Config ──────────────────────────────────────────
export async function getSystemConfigs() {
  return await query('SELECT * FROM system_config ORDER BY category, `key`');
}

export async function getSystemConfig(key) {
  return await queryOne('SELECT * FROM system_config WHERE `key` = ?', [key]);
}

export async function updateSystemConfig(key, value, updatedBy) {
  return await run(
    `UPDATE system_config SET value = ?, updatedAt = ${now()}, updatedBy = ? WHERE \`key\` = ?`,
    [value, updatedBy, key]
  );
}

// ─── Audit Logs ─────────────────────────────────────────────
export async function getAuditLogs(limit = 50, offset = 0, action = null) {
  let sql = 'SELECT * FROM audit_logs';
  const args = [];
  if (action) { sql += ' WHERE `action` = ?'; args.push(action); }
  sql += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  const logs = await query(sql, args);
  const totalRow = await queryOne(
    'SELECT COUNT(*) as count FROM audit_logs' + (action ? ' WHERE `action` = ?' : ''),
    action ? [action] : []
  );
  return { logs, total: totalRow.count };
}

export async function insertAuditLog(userId, username, action, target, targetId, detail) {
  return await run(
    'INSERT INTO audit_logs (userId, username, `action`, target, targetId, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, username, action, target, targetId, detail]
  );
}

// ─── Health Checks ──────────────────────────────────────────
export async function getLatestHealthCheck() {
  return await queryOne('SELECT * FROM health_check_runs ORDER BY id DESC LIMIT 1');
}

export async function getHealthCheckHistory(hours = 24) {
  const safeHours = Math.min(Math.max(parseInt(hours, 10) || 24, 1), 168);
  const since = new Date(Date.now() - safeHours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return await query(
    `SELECT id, status, summary, duration_ms, pass_count, warn_count, crit_count, metrics, triggered_by, createdAt
     FROM health_check_runs
     WHERE createdAt >= ?
     ORDER BY createdAt ASC`,
    [since]
  );
}

// ─── Backward Compat ────────────────────────────────────────
export async function getDb() {
  return await getAdapter();
}
