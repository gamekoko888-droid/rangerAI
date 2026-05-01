/**
 * token-budget.mjs — Token budget enforcement for RangerAI
 * v2.0.0 — Migrated from direct better-sqlite3 to db-adapter (Iter-55 P0-1)
 * 
 * Checks user's token usage against daily/monthly limits.
 * Fail-open: if budget check fails, request is allowed.
 */
import { query, queryOne, run } from "./db-adapter.mjs";

import { logger } from './lib/logger.mjs';
/**
 * Check if user has remaining token budget
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, reason?: string, usage?: object }>}
 */
export async function checkTokenBudget(userId) {
  try {
    // Check if enforcement is enabled
    const enforcement = await queryOne(
      "SELECT value FROM system_config WHERE key = 'budget_enforcement'"
    );
    if (!enforcement || enforcement.value !== 'true') {
      return { allowed: true, reason: 'enforcement_disabled' };
    }
    
    // Get user-specific quota or fall back to global
    const userQuota = userId ? await queryOne(
      "SELECT daily_token_limit, monthly_token_limit, is_unlimited FROM user_quotas WHERE user_id = ?",
      [userId]
    ) : null;
    
    let dailyLimit, monthlyLimit;
    if (userQuota && userQuota.is_unlimited) {
      return { allowed: true, reason: 'unlimited_user' };
    } else if (userQuota) {
      dailyLimit = userQuota.daily_token_limit;
      monthlyLimit = userQuota.monthly_token_limit;
    } else {
      const globalDaily = await queryOne(
        "SELECT value FROM system_config WHERE key = 'global_daily_token_limit'"
      );
      const globalMonthly = await queryOne(
        "SELECT value FROM system_config WHERE key = 'global_monthly_token_limit'"
      );
      dailyLimit = globalDaily ? parseInt(globalDaily.value) : 50000;
      monthlyLimit = globalMonthly ? parseInt(globalMonthly.value) : 1000000;
    }
    
    // Calculate today's usage
    const todayUsage = await queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens
      FROM request_traces
      WHERE user_id = ? AND DATE(created_at) = DATE('now') AND status = 'success'
    `, [userId || '']);
    
    // Calculate this month's usage
    const monthUsage = await queryOne(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens
      FROM request_traces
      WHERE user_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND status = 'success'
    `, [userId || '']);
    
    const dailyUsed = todayUsage?.tokens || 0;
    const monthlyUsed = monthUsage?.tokens || 0;
    
    const usage = {
      daily: { used: dailyUsed, limit: dailyLimit, remaining: dailyLimit - dailyUsed },
      monthly: { used: monthlyUsed, limit: monthlyLimit, remaining: monthlyLimit - monthlyUsed }
    };
    
    if (dailyUsed >= dailyLimit) {
      return {
        allowed: false,
        reason: `Daily token limit exceeded (${dailyUsed}/${dailyLimit})`,
        usage
      };
    }
    
    if (monthlyUsed >= monthlyLimit) {
      return {
        allowed: false,
        reason: `Monthly token limit exceeded (${monthlyUsed}/${monthlyLimit})`,
        usage
      };
    }
    
    return { allowed: true, usage };
  } catch (e) {
    // Fail-open: if budget check fails, allow the request
    logger.error('[token-budget] Check failed (fail-open):', e.message);
    return { allowed: true, reason: 'check_error' };
  }
}

/**
 * Get user's current usage and limits
 */
export async function getUserBudgetInfo(userId) {
  try {
    const result = await checkTokenBudget(userId);
    return result.usage || null;
  } catch (e) {
    return null;
  }
}

/**
 * Set user-specific quota
 */
export async function setUserQuota(userId, dailyLimit, monthlyLimit, isUnlimited = false) {
  try {
    await run(`
      INSERT INTO user_quotas (user_id, daily_token_limit, monthly_token_limit, is_unlimited, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        daily_token_limit = excluded.daily_token_limit,
        monthly_token_limit = excluded.monthly_token_limit,
        is_unlimited = excluded.is_unlimited,
        updated_at = datetime('now')
    `, [userId, dailyLimit, monthlyLimit, isUnlimited ? 1 : 0]);
    return true;
  } catch (e) {
    logger.error('[token-budget] setUserQuota failed:', e.message);
    return false;
  }
}
