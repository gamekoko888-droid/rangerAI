import { updateTaskFocus } from './supervisor-agent.mjs';
import { emitEvent } from './event-stream.mjs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();


// ─── [R8-Task4] DB Persistence Layer ──────────────────────
// Lazy-loaded db-adapter reference. We import dynamically to avoid
// circular deps and to tolerate the adapter not being ready yet.
let _dbReady = false;
let _dbModule = null;

export async function ensureDb() {
  if (_dbReady) return true;
  try {
    _dbModule = await import('../db-adapter.mjs');
    // Create task_plans table if not exists (compatible with existing schema)
    // Existing schema uses: id, session_key, chat_id, msg_id, plan_json, status, step_count, steps_completed
    // R8 adds: plan_version, goal columns via ALTER TABLE (safe to fail if already exist)
    await _dbModule.exec(`
      CREATE TABLE IF NOT EXISTS task_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        chat_id TEXT,
        msg_id TEXT NOT NULL,
        plan_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        step_count INTEGER NOT NULL DEFAULT 0,
        steps_completed INTEGER NOT NULL DEFAULT 0,
        plan_version INTEGER DEFAULT 1,
        goal TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Safely add R8 columns to existing table (ignore errors if columns already exist)
    try { await _dbModule.exec(`ALTER TABLE task_plans ADD COLUMN plan_version INTEGER DEFAULT 1`); } catch (_) { /* column exists */ }
    try { await _dbModule.exec(`ALTER TABLE task_plans ADD COLUMN goal TEXT`); } catch (_) { /* column exists */ }
    // Ensure indexes
    await _dbModule.exec(`CREATE INDEX IF NOT EXISTS idx_tp_session ON task_plans(session_key)`);
    await _dbModule.exec(`CREATE INDEX IF NOT EXISTS idx_tp_status ON task_plans(status)`);
    await _dbModule.exec(`CREATE INDEX IF NOT EXISTS idx_tp_msg ON task_plans(msg_id)`);
    _dbReady = true;
    logger.info(`[${ts()}] [R8-Task4] task_plans table ensured (compatible schema)`);
    return true;
  } catch (err) {
    logger.warn(`[${ts()}] [R8-Task4] DB init failed (non-fatal): ${err.message}`);
    return false;
  }
}

/**
 * [R8-Task4] Persist a plan to the task_plans table.
 * Called every time _planCache is updated.
 * Failures are logged but do NOT block the in-memory flow.
 */
export async function persistPlanToDb(taskId, sessionKey, plan) {
  try {
    if (!(await ensureDb())) return;
    const planJson = JSON.stringify(plan);
    const version = plan.plan_version || plan.version || 1;
    const goal = (plan.goal || '').substring(0, 500);
    const stepCount = plan.steps?.length || 0;
    const stepsCompleted = plan.steps?.filter(s => s.status === 'done' || s.status === 'skipped').length || 0;
    const status = plan.steps?.every(s => s.status === 'done' || s.status === 'skipped' || s.status === 'failed' || s.status === 'blocked') ? 'completed' : 'active';
    // Use msg_id as the task identifier (compatible with existing schema)
    // First check if a row exists for this msg_id
    const existing = await _dbModule.queryOne(
      'SELECT id FROM task_plans WHERE msg_id = ?',
      [taskId]
    );
    if (existing) {
      await _dbModule.run(
        `UPDATE task_plans SET plan_json = ?, plan_version = ?, goal = ?, status = ?, step_count = ?, steps_completed = ?, updated_at = datetime('now') WHERE msg_id = ?`,
        [planJson, version, goal, status, stepCount, stepsCompleted, taskId]
      );
    } else {
      await _dbModule.run(
        `INSERT INTO task_plans (msg_id, session_key, plan_json, plan_version, goal, status, step_count, steps_completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [taskId, sessionKey, planJson, version, goal, status, stepCount, stepsCompleted]
      );
    }
    logger.info(`[${ts()}] [R8-Task4] plan persisted: task=${taskId} v=${version} status=${status} steps=${stepsCompleted}/${stepCount}`);
    // [R18-T4] Auto-update task focus
    try {
      const nextStep = plan.steps?.find(s => s.status === 'pending' || s.status === 'running');
      updateTaskFocus({
        sessionId: sessionKey,
        taskId: taskId,
        title: goal || 'Untitled task',
        currentGoal: goal || '',
        nextAction: nextStep?.title || nextStep?.description || 'Processing...',
        stepCount: stepCount,
        stepsCompleted: stepsCompleted,
        status: status,
      });
    } catch (focusErr) {
      logger.warn(`[${ts()}] [R18-T4] task_focus update failed (non-fatal): ${focusErr.message}`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [R8-Task4] persistPlanToDb failed (non-fatal): ${err.message}`);
  }
}

/**
 * [R8-Task4] Load a plan from the task_plans table.
 * Returns the parsed plan object or null.
 */
export async function loadPlanFromDb(taskId) {
  try {
    if (!(await ensureDb())) return null;
    const row = await _dbModule.queryOne(
      'SELECT plan_json, plan_version, status FROM task_plans WHERE msg_id = ?',
      [taskId]
    );
    if (!row || !row.plan_json) return null;
    const plan = JSON.parse(row.plan_json);
    logger.info(`[${ts()}] [R8-Task4] plan loaded from DB: task=${taskId} v=${row.plan_version} status=${row.status}`);
    return plan;
  } catch (err) {
    logger.warn(`[${ts()}] [R8-Task4] loadPlanFromDb failed: ${err.message}`);
    return null;
  }
}

/**
 * [R8-Task4] Mark a plan as completed in DB.
 */
export async function markPlanCompletedInDb(taskId) {
  try {
    if (!(await ensureDb())) return;
    await _dbModule.run(
      `UPDATE task_plans SET status = 'completed', updated_at = datetime('now') WHERE msg_id = ?`,
      [taskId]
    );
    logger.info(`[${ts()}] [R8-Task4] plan marked completed in DB: task=${taskId}`);
  } catch (err) {
    logger.warn(`[${ts()}] [R8-Task4] markPlanCompletedInDb failed: ${err.message}`);
  }
}

/**
 * [R10-Task4] Finalize plan in DB: update steps_completed with accurate final count
 * AND set status to 'completed' in a single UPDATE to prevent race conditions.
 */
export async function finalizePlanInDb(taskId, plan, sessionKey) {
  try {
    if (!(await ensureDb())) return;
    const planJson = JSON.stringify(plan);
    const version = plan.plan_version || plan.version || 1;
    const goal = (plan.goal || '').substring(0, 500);
    const stepCount = plan.steps?.length || 0;
    const memoryCompleted = plan.steps?.filter(s => s.status === 'done' || s.status === 'skipped').length || 0;
    // [R10-Task4-fix] Query DB for current max steps_completed to prevent overwriting with lower value
    // This handles the race condition where markStepDone DB writes happen before clearPlan
    let dbCompleted = 0;
    try {
      const row = await _dbModule.queryOne('SELECT steps_completed FROM task_plans WHERE msg_id = ?', [taskId]);
      dbCompleted = row?.steps_completed || 0;
    } catch (_) { /* ignore */ }
    const stepsCompleted = Math.max(memoryCompleted, dbCompleted, stepCount); // If task completed, all steps are done

    // [R24-T2] Detect degraded_success: check for browser failures, skipped steps, context compressions
    // NOTE: event_stream lives in /opt/rangerai-agent/db/rangerai.db (worker DB),
    // while task_plans lives in /opt/rangerai-agent/rangerai.db (main DB via _dbModule).
    // Must use direct better-sqlite3 connection for event_stream queries.
    let finalStatus = 'completed';
    const degradedReasons = [];
    try {
      // Check skipped steps
      const skippedSteps = plan.steps?.filter(s => s.status === 'skipped') || [];
      if (skippedSteps.length > 0) degradedReasons.push(`skipped_steps=${skippedSteps.length}`);

      // Open worker DB for event_stream queries (R83: dynamic import for worker compatibility)
      let workerDb = null;
      try {
        const { default: BetterSqlite3 } = await import('better-sqlite3');
        workerDb = new BetterSqlite3('/opt/rangerai-agent/db/rangerai.db', { readonly: true });

        // Check browser failures in event_stream
        try {
          const bfRow = workerDb.prepare(
            `SELECT COUNT(*) as cnt FROM event_stream WHERE task_id = ? AND event_type = 'browser_failure'`
          ).get(taskId);
          if (bfRow?.cnt > 0) degradedReasons.push(`browser_failures=${bfRow.cnt}`);
        } catch (_) { /* event_stream may not have browser_failure */ }

        // Check context compressions
        try {
          const ccRow = workerDb.prepare(
            `SELECT COUNT(*) as cnt FROM event_stream WHERE task_id = ? AND event_type = 'context_compress'`
          ).get(taskId);
          if (ccRow?.cnt > 0) degradedReasons.push(`context_compressions=${ccRow.cnt}`);
        } catch (_) { /* ignore */ }
      } catch (dbErr) {
        logger.warn(`[${ts()}] [R24-T2] Worker DB open failed: ${dbErr.message}`);
      } finally {
        try { workerDb?.close(); } catch (_) {}
      }

      if (degradedReasons.length > 0) {
        finalStatus = 'degraded_success';
        logger.info(`[${ts()}] [R24-T2] Task ${taskId} degraded: ${degradedReasons.join(', ')}`);
        // Emit browser_fallback event with degradedSuccess=true for API tracking
        try {
          emitEvent(sessionKey, taskId, 'browser_fallback', { degradedSuccess: true, reasons: degradedReasons, detectedAt: Date.now() });
        } catch (_) { /* non-fatal */ }
      }
    } catch (dgErr) {
      logger.warn(`[${ts()}] [R24-T2] Degraded check failed (non-fatal): ${dgErr.message}`);
    }

    await _dbModule.run(
      `UPDATE task_plans SET plan_json = ?, plan_version = ?, goal = ?, status = ?, step_count = ?, steps_completed = ?, updated_at = datetime('now') WHERE msg_id = ?`,
      [planJson, version, goal, finalStatus, stepCount, stepsCompleted, taskId]
    );
    logger.info(`[${ts()}] [R10-Task4] plan finalized in DB: task=${taskId} steps=${stepsCompleted}/${stepCount} (memory=${memoryCompleted} db=${dbCompleted}) status=${finalStatus}${degradedReasons.length > 0 ? ' [DEGRADED: ' + degradedReasons.join(', ') + ']' : ''}`);
  } catch (err) {
    logger.warn(`[${ts()}] [R10-Task4] finalizePlanInDb failed: ${err.message}`);
    // Fallback to simple status update
    markPlanCompletedInDb(taskId);
  }
}

export function getPlanDbModule() {
  return _dbModule;
}
