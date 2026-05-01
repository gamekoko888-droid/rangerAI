/**
 * budget-alert.mjs — F19: 预算告警系统
 * v2.0.0 — Migrated from direct better-sqlite3 to db-adapter (Iter-55 P0-1)
 *
 * 功能：
 * 1. 在每次消息处理完成后检查用户 token 使用率
 * 2. 当使用率达到 80% / 100% 时发送告警
 * 3. 告警渠道：应用内通知 + 管理员通知 + Telegram
 * 4. 每个阈值每天只告警一次（内存去重）
 */
import { query, queryOne, run } from "./db-adapter.mjs";

import { logger } from './lib/logger.mjs';
// In-memory dedup: key = `${userId}:${threshold}:${type}:${date}` → true
const _alertSent = new Map();

function alertKey(userId, threshold, type) {
  const today = new Date().toISOString().slice(0, 10);
  return `${userId}:${threshold}:${type}:${today}`;
}

// Clear old keys daily
const _budgetAlertTimer = setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [key] of _alertSent) {
    if (!key.endsWith(today)) _alertSent.delete(key);
  }
}, 3600_000);

function getDb() {
  // Compatibility shim — no longer needed but kept for reference
  // All DB access now goes through db-adapter
  return null;
}

/**
 * Check and send budget alerts for a user
 * Call this after each message processing
 */
export async function checkBudgetAlert(userId) {
  try {
    // P0-FIX: system_config may not exist in all DB backends (e.g., SQLite smoke tests).
    // Guard the query to prevent "no such table" errors from silently killing budget enforcement.
    let enforcement;
    try {
      enforcement = await queryOne(
        "SELECT value FROM system_config WHERE key = 'budget_enforcement'"
      );
    } catch (e) {
      if (e.message && e.message.includes('no such table')) {
        // system_config table missing — budget enforcement not supported on this backend
        return;
      }
      throw e;
    }
    if (!enforcement || enforcement.value !== 'true') return;
    
    // Get user-specific quota or fall back to global
    const userQuota = await queryOne(
      "SELECT daily_token_limit, monthly_token_limit, is_unlimited FROM user_quotas WHERE user_id = ?",
      [userId]
    );
    
    if (userQuota?.is_unlimited) return;
    
    let dailyLimit = userQuota?.daily_token_limit;
    let monthlyLimit = userQuota?.monthly_token_limit;
    
    if (!dailyLimit || !monthlyLimit) {
      // [R68-P2-1] Guard system_config queries individually for resilience
      let globalDaily, globalMonthly;
      try {
        globalDaily = await queryOne(
          "SELECT value FROM system_config WHERE key = 'global_daily_token_limit'"
        );
      } catch (e) {
        if (e.message && !e.message.includes('no such table')) {
          logger.warn('[budget-alert] global_daily_token_limit query failed:', e.message);
        }
      }
      try {
        globalMonthly = await queryOne(
          "SELECT value FROM system_config WHERE key = 'global_monthly_token_limit'"
        );
      } catch (e) {
        if (e.message && !e.message.includes('no such table')) {
          logger.warn('[budget-alert] global_monthly_token_limit query failed:', e.message);
        }
      }
      dailyLimit = dailyLimit || (globalDaily ? parseInt(globalDaily.value) : 50000);
      monthlyLimit = monthlyLimit || (globalMonthly ? parseInt(globalMonthly.value) : 1000000);
    }
    
    // Get usage
    const todayUsage = await queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM request_traces
      WHERE user_id = ? AND DATE(created_at) = DATE('now') AND status = 'success'
    `, [userId]);
    
    const monthUsage = await queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM request_traces
      WHERE user_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND status = 'success'
    `, [userId]);
    
    const dailyUsed = todayUsage?.tokens || 0;
    const monthlyUsed = monthUsage?.tokens || 0;
    const dailyCost = todayUsage?.cost_usd || 0;
    const monthlyCost = monthUsage?.cost_usd || 0;
    
    // Get username for notification
    const user = await queryOne("SELECT username, displayName FROM users WHERE id = ?", [userId]);
    const userName = user?.displayName || user?.username || userId;
    
    // Check daily thresholds
    const dailyPct = dailyLimit > 0 ? (dailyUsed / dailyLimit) * 100 : 0;
    if (dailyPct >= 100) {
      await _sendAlert(userId, userName, 'daily', 100, dailyUsed, dailyLimit, dailyCost);
    } else if (dailyPct >= 80) {
      await _sendAlert(userId, userName, 'daily', 80, dailyUsed, dailyLimit, dailyCost);
    }
    
    // Check monthly thresholds
    const monthlyPct = monthlyLimit > 0 ? (monthlyUsed / monthlyLimit) * 100 : 0;
    if (monthlyPct >= 100) {
      await _sendAlert(userId, userName, 'monthly', 100, monthlyUsed, monthlyLimit, monthlyCost);
    } else if (monthlyPct >= 80) {
      await _sendAlert(userId, userName, 'monthly', 80, monthlyUsed, monthlyLimit, monthlyCost);
    }
    
  } catch (e) {
    logger.error('[budget-alert] Check failed (non-fatal):', e.message);
  }
}

/**
 * Internal: Send alert through both notification channels
 */
async function _sendAlert(userId, userName, type, threshold, used, limit, costUsd) {
  const key = alertKey(userId, threshold, type);
  if (_alertSent.has(key)) return; // Already alerted today
  _alertSent.set(key, true);
  
  const typeLabel = type === 'daily' ? '日' : '月';
  const pctStr = threshold >= 100 ? '已超限' : `已达 ${threshold}%`;
  const costStr = costUsd > 0 ? `，成本 $${costUsd.toFixed(4)}` : '';
  
  const title = `Token 预算告警：${userName} ${typeLabel}用量${pctStr}`;
  const content = `用户 ${userName} 的${typeLabel}Token 用量${pctStr}。\n` +
    `已使用: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens${costStr}\n` +
    `使用率: ${Math.min(100, (used / limit * 100)).toFixed(1)}%`;
  
  logger.info(`[budget-alert] ${title}`);
  
  // Channel 1: In-app notification (for user)
  try {
    await run(`
      INSERT INTO notifications (title, content, type, target_user, related_type, is_read, created_at)
      VALUES (?, ?, ?, ?, 'budget_alert', 0, CURRENT_TIMESTAMP)
    `, [
      title,
      content,
      threshold >= 100 ? 'warning' : 'info',
      userId
    ]);
  } catch (e) {
    logger.error('[budget-alert] Notification insert failed:', e.message);
  }
  
  // Channel 2: Admin notification (for admins)
  try {
    await run(`
      INSERT INTO notifications (title, content, type, target_user, related_type, is_read, created_at)
      VALUES (?, ?, 'warning', NULL, 'budget_alert', 0, CURRENT_TIMESTAMP)
    `, [
      `[管理员] ${title}`,
      content + `\n\n用户ID: ${userId}`
    ]);
  } catch (e) {
    logger.error('[budget-alert] Admin notification insert failed:', e.message);
  }
  
  // Channel 3: Alert manager (Telegram + log)
  try {
    const { sendAlert } = await import('./alert-manager.mjs');
    await sendAlert({
      level: threshold >= 100 ? 'WARN' : 'INFO',
      title,
      body: content,
      component: `budget:${userId}:${type}`
    });
  } catch (e) {
    logger.error('[budget-alert] Alert manager failed:', e.message);
  }
}

/**
 * Get budget alert status for a user (for API/UI)
 */
export async function getBudgetAlertStatus(userId) {
  try {
    const userQuota = await queryOne(
      "SELECT daily_token_limit, monthly_token_limit, is_unlimited FROM user_quotas WHERE user_id = ?",
      [userId]
    );
    
    if (userQuota?.is_unlimited) return { status: 'unlimited' };
    
    let dailyLimit = userQuota?.daily_token_limit || 50000;
    let monthlyLimit = userQuota?.monthly_token_limit || 1000000;
    
    const todayUsage = await queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM request_traces WHERE user_id = ? AND DATE(created_at) = DATE('now') AND status = 'success'
    `, [userId]);
    
    const monthUsage = await queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost_usd
      FROM request_traces WHERE user_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND status = 'success'
    `, [userId]);
    
    return {
      status: 'active',
      daily: {
        used: todayUsage?.tokens || 0,
        limit: dailyLimit,
        pct: dailyLimit > 0 ? Math.round((todayUsage?.tokens || 0) / dailyLimit * 100) : 0,
        cost_usd: todayUsage?.cost_usd || 0
      },
      monthly: {
        used: monthUsage?.tokens || 0,
        limit: monthlyLimit,
        pct: monthlyLimit > 0 ? Math.round((monthUsage?.tokens || 0) / monthlyLimit * 100) : 0,
        cost_usd: monthUsage?.cost_usd || 0
      }
    };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

// v24.0: Timer cleanup for graceful shutdown
export function cleanupBudgetAlert() { clearInterval(_budgetAlertTimer); }
