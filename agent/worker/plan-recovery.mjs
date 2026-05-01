// plan-recovery.mjs — R98 crash recovery and plan metrics helpers.

import { ensureDb, persistPlanToDb, loadPlanFromDb, getPlanDbModule } from './plan-persistence.mjs';
import { getEvents, EVENT_TYPES } from './event-stream.mjs';
import { logger } from '../lib/logger.mjs';
import { TTLMap } from './lib/ttl-map.mjs';
import { _planCache, _externalPlanKeys, _sessionKeyCache } from './plan-storage.mjs';

const ts = () => new Date().toISOString();
// ─── Plan Rebuild from Events ──────────────────────────────

/**
 * Rebuild a plan from event stream (for crash recovery / resumption).
 * [R8-Task4] Now checks task_plans DB table FIRST for faster recovery,
 * falls back to event stream scanning if DB lookup fails.
 *
 * @param {string} taskId
 * @param {string} sessionKey
 * @returns {Promise<StructuredPlan|null>}
 */
export async function rebuildPlanFromEvents(taskId, sessionKey) {
  // [R8-Task4] Try DB first — O(1) lookup vs scanning event stream
  try {
    const dbPlan = await loadPlanFromDb(taskId);
    if (dbPlan && dbPlan.steps && dbPlan.steps.length > 0) {
      _planCache.set(taskId, dbPlan);
      logger.info(`[${ts()}] [R8-Task4] Plan rebuilt from DB: v${dbPlan.plan_version || dbPlan.version}, ${dbPlan.steps.length} steps`);
      return dbPlan;
    }
  } catch (dbErr) {
    logger.warn(`[${ts()}] [R8-Task4] DB plan lookup failed, falling back to events: ${dbErr.message}`);
  }

  // Fallback: scan event stream
  try {
    const events = await getEvents(sessionKey, {
      eventTypes: [EVENT_TYPES.PLAN_UPDATE],
      limit: 50
    });

    if (!events || events.length === 0) {
      logger.info(`[${ts()}] [planner] No plan events found for task ${taskId}`);
      return null;
    }

    // Find the latest plan_update event
    let latestPlan = null;
    for (const event of events) {
      try {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        if (payload?.plan) {
          latestPlan = payload.plan;
        }
      } catch (_) { /* skip malformed events */ }
    }

    if (latestPlan) {
      _planCache.set(taskId, latestPlan);
      // [R8-Task4] Backfill DB with plan recovered from events
      persistPlanToDb(taskId, sessionKey, latestPlan);
      logger.info(`[${ts()}] [planner] Plan rebuilt from events: v${latestPlan.version}, ${latestPlan.steps.length} steps`);
      return latestPlan;
    }

    return null;
  } catch (err) {
    logger.error(`[${ts()}] [planner] Plan rebuild failed: ${err.message}`);
    return null;
  }
}


let _recoveryDone = false;
// [R10-Task2] Track recovered plan keys so openclaw-handler can rebuild executors
const _recoveredPlanKeys = new TTLMap(100, 2 * 60 * 60 * 1000, 5 * 60 * 1000); // msgId => { sessionKey, plan }

/**
 * [R9-Task3] Recover active plans from DB after process restart.
 * Called once during worker startup or on first handleViaOpenClaw call.
 * Loads all plans with status='active' from task_plans table back into _planCache.
 * This enables step tracking to resume without losing progress.
 *
 * @returns {Promise<number>} Number of plans recovered
 */
export async function recoverActivePlans() {
  if (_recoveryDone) return 0;
  _recoveryDone = true;
  try {
    if (!(await ensureDb())) {
      logger.warn(`[${ts()}] [R9-recovery] DB not available, skipping recovery`);
      return 0;
    }
    // Only recover plans that are still active (not completed/failed)
    // and were updated within the last 24 hours (stale plans are ignored)
    // Use SQLite-compatible date format (YYYY-MM-DD HH:MM:SS) to match stored format
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cutoff = cutoffDate.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const rows = await getPlanDbModule().query(
      `SELECT msg_id, session_key, plan_json, plan_version, status FROM task_plans WHERE status = 'active' AND updated_at > ?`,
      [cutoff]
    );
    if (!rows || rows.length === 0) {
      logger.info(`[${ts()}] [R9-recovery] No active plans to recover`);
      return 0;
    }
    let recovered = 0;
    for (const row of rows) {
      try {
        if (_planCache.has(row.msg_id)) {
          logger.info(`[${ts()}] [R9-recovery] skipping ${row.msg_id} (already in cache)`);
          continue;
        }
        const plan = JSON.parse(row.plan_json);
        if (!plan || !plan.steps || plan.steps.length === 0) continue;
        // [R11-T3] Reset interrupted 'doing' steps to 'pending' (execution context lost on restart)
        const doingStep = plan.steps.find(s => s.status === 'doing');
        if (doingStep) {
          doingStep.status = 'pending';
          doingStep.output = '[R11] Reset after process restart — execution context lost';
          logger.info(`[${ts()}] [R11-T3] Reset doing step ${doingStep.id} to pending for task=${row.msg_id}`);
        }

        _planCache.set(row.msg_id, plan);
        _sessionKeyCache.set(row.msg_id, row.session_key);
        // [R10-Task2] Store recovered plan info for executor rebuild
        _recoveredPlanKeys.set(row.msg_id, { sessionKey: row.session_key, plan });

        // [R11-T3] Persist the doing→pending reset back to DB
        if (doingStep) {
          try {
            await getPlanDbModule().exec(
              `UPDATE task_plans SET plan_json = ?, updated_at = datetime('now') WHERE msg_id = ?`,
              [JSON.stringify(plan), row.msg_id]
            );
          } catch (_persistErr) {
            logger.warn(`[${ts()}] [R11-T3] Failed to persist doing→pending reset: ${_persistErr.message}`);
          }
        }

        const doneSteps = plan.steps.filter(s => s.status === 'done').length;
        const currentStep = plan.steps.find(s => s.id === plan.currentStepId);
        logger.info(`[${ts()}] [R9-recovery] recovered plan: task=${row.msg_id} v=${row.plan_version} steps=${doneSteps}/${plan.steps.length} current=${plan.currentStepId}(${currentStep?.title || 'unknown'})`);
        logger.info(`[${ts()}] [R11-T3] Recovery state: doingReset=${!!doingStep} pendingSteps=${plan.steps.filter(s => s.status === 'pending').length}`);

        recovered++;
      } catch (parseErr) {
        logger.warn(`[${ts()}] [R9-recovery] failed to parse plan for ${row.msg_id}: ${parseErr.message}`);
      }
    }
    logger.info(`[${ts()}] [R9-recovery] recovery complete: ${recovered} plans restored from DB`);

    // [R11-T4] Clean up orphan active records older than 24h
    // This runs AFTER recovery so we don't accidentally clean up recoverable plans
    try {
      const staleResult = await getPlanDbModule().exec(
        `UPDATE task_plans SET status = 'stale', updated_at = datetime('now') WHERE status = 'active' AND updated_at < ?`,
        [cutoff]
      );
      const staleCount = staleResult?.changes || 0;
      if (staleCount > 0) {
        logger.info(`[${ts()}] [R11-T4] Cleaned ${staleCount} stale active records (>24h)`);
      }
    } catch (cleanErr) {
      logger.warn(`[${ts()}] [R11-T4] Stale cleanup failed: ${cleanErr.message}`);
    }

    return recovered;
  } catch (err) {
    logger.error(`[${ts()}] [R9-recovery] recovery failed: ${err.message}`);
    return 0;
  }
}

/**
 * [R9-Task3] Check if recovery has been performed.
 * Used by openclaw-handler to trigger recovery on first call.
 */


export function isRecoveryDone() {
  return _recoveryDone;
}

/**
 * [R10-Task2] Get all recovered plans that need executor rebuild.
 * Returns a Map of msgId => { sessionKey, plan }.
 * After calling this, the caller should rebuild executors for each entry.
 * Calling consumeRecoveredPlan(msgId) marks it as handled.
 */
export function getRecoveredPlans() {
  return new Map(_recoveredPlanKeys);
}

/**
 * [R10-Task2] Check if a specific task was recovered and needs executor rebuild.
 * Returns the recovery info or null.
 */
export function getRecoveredPlan(msgId) {
  return _recoveredPlanKeys.get(msgId) || null;
}

/**
 * [R10-Task2] Consume (mark as handled) a recovered plan.
 * Called after executor has been rebuilt for this task.
 */
export function consumeRecoveredPlan(msgId) {
  const had = _recoveredPlanKeys.delete(msgId);
  if (had) {
    logger.info(`[${ts()}] [R10-Task2] consumed recovered plan: ${msgId}`);
  }
  return had;
}

// ─── [R12-T1] Cross-Session Recovery ────────────────────────────

/**
 * [R12-T1] Get all active (recoverable) plans for a given session.
 * Used by the frontend RecoveryBanner to show resumable tasks.
 * Returns array of { msgId, plan, sessionKey, pendingSteps, currentStep }.
 */
export function getActivePlansBySession(sessionKey) {
  const results = [];
  for (const [msgId, plan] of _planCache) {
    const sk = _sessionKeyCache.get(msgId);
    if (sk !== sessionKey) continue;
    const pendingSteps = plan.steps.filter(s => s.status === 'pending');
    const doneSteps = plan.steps.filter(s => s.status === 'done');
    if (pendingSteps.length === 0) continue; // fully complete
    const currentStep = plan.steps.find(s => s.id === plan.currentStepId);
    results.push({
      msgId,
      totalSteps: plan.steps.length,
      doneSteps: doneSteps.length,
      pendingSteps: pendingSteps.length,
      currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, status: currentStep.status } : null,
      goal: plan.goal || plan.steps[0]?.title || 'Unknown task',
      version: plan.version || 1,
    });
  }
  return results;
}

/**
 * [R12-T1] Resume a recovered plan by re-injecting it into the executor pipeline.
 * Called when user clicks "Continue" on RecoveryBanner.
 * @param {string} msgId - The original task's msgId
 * @returns {{ plan, sessionKey, currentStep } | null}
 */
export function getResumablePlan(msgId) {
  const plan = _planCache.get(msgId);
  const sessionKey = _sessionKeyCache.get(msgId);
  if (!plan || !sessionKey) return null;
  const pendingSteps = plan.steps.filter(s => s.status === 'pending');
  if (pendingSteps.length === 0) return null;
  // Find first pending step
  const firstPending = pendingSteps[0];
  // Set it as current
  plan.currentStepId = firstPending.id;
  return { plan, sessionKey, currentStep: firstPending };
}

// ─── [R12-T2] Plan Driving Metrics ───────────────────────────────

const _planMetrics = new TTLMap(200, 60 * 60 * 1000, 5 * 60 * 1000); // taskId → { totalActions, injectedActions, followedActions, details[] }

/**
 * [R12-T2] Record that a plan step directive was injected into LLM context.
 * Called from context-injector or openclaw-handler when plan block is injected.
 */
export function recordPlanInjection(taskId) {
  if (!_planMetrics.has(taskId)) {
    _planMetrics.set(taskId, { totalActions: 0, injectedActions: 0, followedActions: 0, details: [] });
  }
  const m = _planMetrics.get(taskId);
  m.injectedActions++;
  m.totalActions++;
}

/**
 * [R12-T2] Record that an action was taken (tool call) and whether it followed the plan.
 * @param {string} taskId
 * @param {string} toolName - The tool that was actually called
 * @param {string|null} currentStepId - The current plan step ID (null = no plan)
 * @param {boolean} followed - Whether the tool matched the step's expectedTools
 */
export function recordActionFollowance(taskId, toolName, currentStepId, followed) {
  if (!_planMetrics.has(taskId)) {
    _planMetrics.set(taskId, { totalActions: 0, injectedActions: 0, followedActions: 0, details: [] });
  }
  const m = _planMetrics.get(taskId);
  m.totalActions++;
  if (followed) m.followedActions++;
  m.details.push({ toolName, stepId: currentStepId, followed, ts: Date.now() });
}

/**
 * [R12-T2] Record an action without plan (no plan was active).
 */
export function recordNoPlanAction(taskId) {
  if (!_planMetrics.has(taskId)) {
    _planMetrics.set(taskId, { totalActions: 0, injectedActions: 0, followedActions: 0, details: [] });
  }
  _planMetrics.get(taskId).totalActions++;
}

/**
 * [R12-T2] Get plan driving metrics for a specific task.
 */
export function getTaskPlanMetrics(taskId) {
  const m = _planMetrics.get(taskId);
  if (!m) return null;
  return {
    taskId,
    totalActions: m.totalActions,
    injectedActions: m.injectedActions,
    followedActions: m.followedActions,
    plan_injection_rate: m.totalActions > 0 ? (m.injectedActions / m.totalActions).toFixed(3) : '0.000',
    step_follow_rate: m.totalActions > 0 ? (m.followedActions / m.totalActions).toFixed(3) : '0.000',
    details: m.details.slice(-20), // last 20 actions
  };
}

/**
 * [R12-T2] Get aggregated plan metrics across all tracked tasks.
 * Exposed via /api/admin/plan-metrics.
 */
export function getAllPlanMetrics() {
  const tasks = [];
  let totalActions = 0, totalInjected = 0, totalFollowed = 0;
  for (const [taskId, m] of _planMetrics) {
    tasks.push({
      taskId,
      totalActions: m.totalActions,
      injectedActions: m.injectedActions,
      followedActions: m.followedActions,
      plan_injection_rate: m.totalActions > 0 ? (m.injectedActions / m.totalActions).toFixed(3) : '0.000',
      step_follow_rate: m.totalActions > 0 ? (m.followedActions / m.totalActions).toFixed(3) : '0.000',
    });
    totalActions += m.totalActions;
    totalInjected += m.injectedActions;
    totalFollowed += m.followedActions;
  }
  return {
    aggregate: {
      totalTasks: tasks.length,
      totalActions,
      totalInjected,
      totalFollowed,
      plan_injection_rate: totalActions > 0 ? (totalInjected / totalActions).toFixed(3) : '0.000',
      step_follow_rate: totalActions > 0 ? (totalFollowed / totalActions).toFixed(3) : '0.000',
    },
    tasks: tasks.slice(-50), // last 50 tasks
  };
}

// ─── [L4] Parallel Scheduler ──────────────────────────────────────────────────

/**
 * [L4] Compute parallel execution batches using topological sort.
 * Steps with no unresolved dependencies form a "wave" that can run concurrently.
 *
 * @param {string} taskId
 * @returns {Array<Array<Object>>} Ordered list of batches; each batch is an array of steps to run in parallel.
 *   Example: [[step1], [step2, step3], [step4]]
 */


export function cleanupPlanRecoveryResources() {
  _recoveredPlanKeys.dispose();
  _planMetrics.dispose();
}
