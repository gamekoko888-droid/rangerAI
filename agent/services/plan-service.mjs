/**
 * plan-service.mjs — Task Plan Persistence Service (R54 Task2)
 * 
 * Stores parsed task plans in the database for:
 * - Restart resilience (plans survive service restarts)
 * - API exposure (GET /api/task-plans)
 * - Step completion tracking (markStepDone updates DB)
 * 
 * Uses db-adapter.mjs unified interface (works with both SQLite and MySQL).
 * 
 * Table: task_plans
 * Columns: id, session_key, chat_id, msg_id, plan_json, status, created_at, updated_at
 * 
 * @module services/plan-service
 */
import { query, queryOne, run } from '../db-adapter.mjs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── Table Initialization ───────────────────────────────────
/**
 * Create the task_plans table if it doesn't exist.
 * Called once during service startup.
 */
export async function initTaskPlansTable() {
  try {
    await run(`
      CREATE TABLE IF NOT EXISTS task_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        chat_id TEXT,
        msg_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        step_count INTEGER NOT NULL DEFAULT 0,
        steps_completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Index for fast lookups by session_key and msg_id
    await run(`CREATE INDEX IF NOT EXISTS idx_task_plans_session ON task_plans(session_key)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_task_plans_msg ON task_plans(msg_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_task_plans_status ON task_plans(status)`);
    logger.info(`[${ts()}] [plan-service] task_plans table initialized`);
  } catch (err) {
    logger.error(`[${ts()}] [plan-service] Failed to init task_plans table: ${err.message}`);
    throw err;
  }
}

// ─── CRUD Operations ────────────────────────────────────────

/**
 * Save a parsed plan to the database.
 * If a plan already exists for the same msgId, it will be replaced.
 * 
 * @param {object} params
 * @param {string} params.sessionKey - The session key
 * @param {string} [params.chatId] - The chat ID (optional)
 * @param {string} params.msgId - The message ID that triggered this plan
 * @param {object} params.plan - The parsed plan object (steps array + metadata)
 * @returns {Promise<{id: number}>} The inserted/updated plan ID
 */
export async function savePlan({ sessionKey, chatId, msgId, plan }) {
  try {
    const planJson = JSON.stringify(plan);
    const stepCount = Array.isArray(plan.steps) ? plan.steps.length : 0;
    const stepsCompleted = Array.isArray(plan.steps)
      ? plan.steps.filter(s => s.done || s.status === 'done').length
      : 0;

    // Upsert: delete existing plan for this msgId, then insert new one
    await run(`DELETE FROM task_plans WHERE msg_id = ?`, [msgId]);
    const result = await run(
      `INSERT INTO task_plans (session_key, chat_id, msg_id, plan_json, status, step_count, steps_completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'))`,
      [sessionKey, chatId || null, msgId, planJson, stepCount, stepsCompleted]
    );

    logger.info(`[${ts()}] [plan-service] Saved plan for msg=${msgId}: ${stepCount} steps (${stepsCompleted} done)`);
    return { id: result.lastInsertRowid };
  } catch (err) {
    logger.error(`[${ts()}] [plan-service] savePlan error: ${err.message}`);
    throw err;
  }
}

/**
 * Update a specific step's status in a stored plan.
 * 
 * @param {string} msgId - The message ID
 * @param {number} stepIndex - Zero-based step index
 * @param {string} status - New status ('done', 'active', 'pending')
 * @returns {Promise<boolean>} Whether the update was successful
 */
export async function updateStepStatus(msgId, stepIndex, status) {
  try {
    const row = await queryOne(`SELECT id, plan_json, step_count FROM task_plans WHERE msg_id = ?`, [msgId]);
    if (!row) {
      logger.warn(`[${ts()}] [plan-service] updateStepStatus: no plan found for msg=${msgId}`);
      return false;
    }

    const plan = JSON.parse(row.plan_json);
    if (!Array.isArray(plan.steps) || stepIndex >= plan.steps.length) {
      logger.warn(`[${ts()}] [plan-service] updateStepStatus: invalid stepIndex=${stepIndex} for msg=${msgId}`);
      return false;
    }

    plan.steps[stepIndex].status = status;
    plan.steps[stepIndex].done = status === 'done';
    if (status === 'done' && !plan.steps[stepIndex].completedAt) {
      plan.steps[stepIndex].completedAt = new Date().toISOString();
    }

    const stepsCompleted = plan.steps.filter(s => s.done || s.status === 'done').length;
    const planStatus = stepsCompleted >= plan.steps.length ? 'completed' : 'active';

    await run(
      `UPDATE task_plans SET plan_json = ?, steps_completed = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(plan), stepsCompleted, planStatus, row.id]
    );

    logger.info(`[${ts()}] [plan-service] Step ${stepIndex} → ${status} for msg=${msgId} (${stepsCompleted}/${row.step_count})`);
    return true;
  } catch (err) {
    logger.error(`[${ts()}] [plan-service] updateStepStatus error: ${err.message}`);
    return false;
  }
}

/**
 * Mark a plan as completed or failed.
 * 
 * @param {string} msgId - The message ID
 * @param {string} status - 'completed' | 'failed' | 'cancelled'
 * @returns {Promise<boolean>}
 */
export async function finalizePlan(msgId, status = 'completed') {
  try {
    const result = await run(
      `UPDATE task_plans SET status = ?, updated_at = datetime('now') WHERE msg_id = ?`,
      [status, msgId]
    );
    return result.changes > 0;
  } catch (err) {
    logger.error(`[${ts()}] [plan-service] finalizePlan error: ${err.message}`);
    return false;
  }
}

/**
 * Get plans for a session, optionally filtered by status.
 * 
 * @param {object} params
 * @param {string} [params.sessionKey] - Filter by session key
 * @param {string} [params.chatId] - Filter by chat ID
 * @param {string} [params.status] - Filter by status ('active', 'completed', 'failed')
 * @param {number} [params.limit=20] - Max results
 * @returns {Promise<Array>} Array of plan records
 */
export async function getPlans({ sessionKey, chatId, status, limit = 20 } = {}) {
  try {
    let sql = `SELECT * FROM task_plans WHERE 1=1`;
    const params = [];

    if (sessionKey) {
      sql += ` AND session_key = ?`;
      params.push(sessionKey);
    }
    if (chatId) {
      sql += ` AND chat_id = ?`;
      params.push(chatId);
    }
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await query(sql, params);
    // Parse plan_json for each row
    return rows.map(row => ({
      ...row,
      plan: JSON.parse(row.plan_json),
    }));
  } catch (err) {
    logger.error(`[${ts()}] [plan-service] getPlans error: ${err.message}`);
    return [];
  }
}

/**
 * Get the most recent active plan for a session.
 * 
 * @param {string} sessionKey
 * @returns {Promise<object|null>}
 */
export async function getActivePlan(sessionKey) {
  try {
    const row = await queryOne(
      `SELECT * FROM task_plans WHERE session_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [sessionKey]
    );
    if (!row) return null;
    return { ...row, plan: JSON.parse(row.plan_json) };
  } catch (err) {
    logger.error(`[${ts()}] [plan-service] getActivePlan error: ${err.message}`);
    return null;
  }
}
