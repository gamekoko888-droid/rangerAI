// plan-storage.mjs — R98 extracted planner state/storage/recovery utilities
// Extracted from planner.mjs without changing external planner exports.

import { sendToMain } from './ipc-utils.mjs';
import { updateHintAdoptionActualTools, getHintAdoptionStats } from './hint-system.mjs';
import { ensureDb, persistPlanToDb, loadPlanFromDb, markPlanCompletedInDb, finalizePlanInDb, getPlanDbModule } from './plan-persistence.mjs';
import { _r42FormatPlanPayload, normalizePlanStepContract } from './plan-formatter.mjs';
import { emitEvent, getEvents, EVENT_TYPES } from './event-stream.mjs';
import { logger } from '../lib/logger.mjs';
import { hasStepEvidence } from './task-engine.mjs'; // [R76-PhaseA] evidence gate for hard closed-loop
import { TTLMap } from './lib/ttl-map.mjs'; // [R95] TTL-based memory-safe Map

const ts = () => new Date().toISOString();

// [R67-PROGRESS] Send plan progress to frontend via IPC
export function _sendPlanProgress(taskId, plan, trigger) {
  try {
    if (!plan || !plan.steps) return;
    const steps = plan.steps.map((s, i) => ({
      id: String(parseInt(s.id) || (i + 1)),
      title: s.title || s.description || ('Step ' + (i + 1)),
      status: s.status || 'pending'
    }));
    const doneCount = steps.filter(s => s.status === 'done').length;
    const activeStep = steps.find(s => s.status === 'doing' || s.status === 'active');
    const currentStep = activeStep ? parseInt(activeStep.id) : (doneCount + 1);
    const totalSteps = steps.length;
    const allDone = steps.every(s => s.status === 'done' || s.status === 'skipped');
    sendToMain(taskId, {
      type: "plan_progress",
      planId: taskId,
      goal: plan.goal || '',
      currentStep,
      totalSteps,
      steps,
      status: allDone ? 'completed' : 'in_progress',
      trigger
    });
  } catch (e) {
    // non-fatal: don't break planner if IPC fails
  }
}

// ─── In-Memory Plan Cache (R95: migrated to TTLMap) ──────────────────────────────────
// Key: taskId → StructuredPlan
export const _planCache = new TTLMap(100, 2 * 60 * 60 * 1000, 5 * 60 * 1000);
export const _externalPlanKeys = new TTLMap(100, 2 * 60 * 60 * 1000, 5 * 60 * 1000); // [R10-Task1] Track plans from registerExternalPlan

// [R9-Task2] Session key cache: taskId → sessionKey
// Needed by markStep* functions to call persistPlanToDb without requiring sessionKey param
export const _sessionKeyCache = new TTLMap(500, 60 * 60 * 1000, 5 * 60 * 1000);

/**
 * [R9-Task2] Helper: persist plan progress to DB after step status changes.
 * Uses cached sessionKey. Non-blocking, fire-and-forget.
 * @param {string} taskId
 * @param {string} trigger - What caused the persist (e.g., 'markStepDone', 'markStepFailed')
 */
export function persistProgress(taskId, trigger) {
  const plan = _planCache.get(taskId);
  if (!plan) return;
  const sessionKey = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
  const doneCount = plan.steps.filter(s => s.status === 'done').length;
  const failedCount = plan.steps.filter(s => s.status === 'failed').length;
  const skippedCount = plan.steps.filter(s => s.status === 'skipped').length;
  // steps_completed = done count (R9 口径: only 'done' counts as completed; failed/skipped tracked separately)
  logger.info(`[${ts()}] [R9-db] progress persisted: task=${taskId} trigger=${trigger} done=${doneCount} failed=${failedCount} skipped=${skippedCount} total=${plan.steps.length}`);
  persistPlanToDb(taskId, sessionKey, plan);
}

// ─── Plan State Management ─────────────────────────────────

/**
 * Advance the current step to "doing" status.
 */
export function markStepDoing(taskId, stepId) {
  const plan = _planCache.get(taskId);
  if (!plan) return null;

  const step = plan.steps.find(s => s.id === stepId);
  if (step && step.status === 'pending') {
    step.status = 'doing';
    plan.currentStepId = stepId;
    plan.updatedAt = Date.now();
    logger.info(`[${ts()}] [planner] Step ${stepId} → doing: "${step.title}"`);
    persistProgress(taskId, 'markStepDoing'); // [R9-Task2]
    // [R71] Send plan_progress on step_doing so frontend shows real-time step transitions
    _sendPlanProgress(taskId, plan, "step_doing");
    // [R38-T3] Emit plan_update on step status change for observability
    try {
      const _sk38 = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
      emitEvent(_sk38, taskId, EVENT_TYPES.PLAN_UPDATE, _r42FormatPlanPayload(plan, {
        version: plan.version, plan_version: plan.plan_version || plan.version,
        trigger: 'step_doing', stepId, taskId
      }));
    } catch (_e38) { /* non-fatal */ }
  }
  return plan;
}

/**
 * Mark a step as done with optional output summary.
 */
export function markStepDone(taskId, stepId, output = '') {
  const plan = _planCache.get(taskId);
  if (!plan) return null;

  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    // [R76-PhaseA] Hard evidence gate: step cannot be 'done' without verifiable evidence.
    // Resolve sessionKey from cache (used by progress-tracker evidence store).
    const _r76_sk = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
    const _r76_hasEvidence = hasStepEvidence(_r76_sk, stepId);
    if (!_r76_hasEvidence) {
      step.status = 'needs_verification';
      if (output) step.output = output;
      plan.updatedAt = Date.now();
      logger.info(`[${ts()}] [R76] Step ${stepId} → needs_verification (no evidence) for ${taskId}`);
      persistProgress(taskId, 'markStepDone_needs_verification');
      _sendPlanProgress(taskId, plan, "step_needs_verification");
      try {
        const _sk38v = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
        emitEvent(_sk38v, taskId, EVENT_TYPES.PLAN_UPDATE, _r42FormatPlanPayload(plan, {
          version: plan.version, plan_version: plan.plan_version || plan.version,
          trigger: 'step_needs_verification', stepId, taskId
        }));
      } catch (_e38v) { /* non-fatal */ }
      return plan;
    }
    step.status = 'done';
    if (output) step.output = output;
    plan.updatedAt = Date.now();

    // Auto-advance currentStepId to next pending step
    // [R10-FIX-2] Also check for 'doing' steps (in case a step was already marked doing)
    const nextPending = plan.steps.find(s => s.status === 'pending' || s.status === 'doing' || s.status === 'retrying');
    if (nextPending) {
      plan.currentStepId = nextPending.id;
    } else {
      // [R10-FIX-2] All steps done — set currentStepId to null to prevent
      // getCurrentStep() from returning a completed step, which causes infinite loops
      plan.currentStepId = null;
      logger.info(`[${ts()}] [planner] All steps done — currentStepId set to null`);
      // [R43-T2] Emit plan_completed event when all steps are done
      try {
        const _sk43pc = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
        const _planStartTime = plan.createdAt || plan.startedAt || 0;
        const _planDuration = _planStartTime ? Date.now() - _planStartTime : 0;
        const _doneCount = plan.steps.filter(s => s.status === 'done').length;
        const _failedCount = plan.steps.filter(s => s.status === 'failed').length;
        const _successRate = plan.steps.length > 0 ? _doneCount / plan.steps.length : 0;
        emitEvent(_sk43pc, taskId, EVENT_TYPES.PLAN_COMPLETED, {
          planId: taskId,
          totalSteps: plan.steps.length,
          doneSteps: _doneCount,
          failedSteps: _failedCount,
          duration: _planDuration,
          successRate: Math.round(_successRate * 100) / 100,
          plan_version: plan.plan_version || plan.version || 1,
          steps: plan.steps.map((s, i) => ({
            id: parseInt(s.id) || (i + 1),
            desc: s.title || s.description || 'Step ' + (i + 1),
            status: s.status,
            tools: s.tools || []
          }))
        });
        logger.info(`[${ts()}] [R43-T2] plan_completed emitted: planId=${taskId} steps=${plan.steps.length} successRate=${_successRate}`);
      } catch (_e43pc) {
        logger.info(`[${ts()}] [R43-T2] plan_completed emit error: ${_e43pc.message}`);
      }
    }

    logger.info(`[${ts()}] [planner] Step ${stepId} → done: "${step.title}" | output: ${(output || '').substring(0, 100)}`);
    persistProgress(taskId, 'markStepDone'); // [R9-Task2]
    _sendPlanProgress(taskId, plan, "step_done");
    // [R38-T3] Emit plan_update on step completion
    try {
      const _sk38d = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
      emitEvent(_sk38d, taskId, EVENT_TYPES.PLAN_UPDATE, _r42FormatPlanPayload(plan, {
        version: plan.version, plan_version: plan.plan_version || plan.version,
        trigger: 'step_done', stepId, output: (output || '').substring(0, 200), taskId
      }));
    } catch (_e38d) { /* non-fatal */ }
    // [R19-T1] Track actual tools used for hint adoption
    try {
      const fullPlan = _planCache.get(taskId);
      if (fullPlan) {
        const allActualTools = [...new Set(fullPlan.steps.filter(s => s.status === 'done').flatMap(s => s.tools || []))];
        updateHintAdoptionActualTools(taskId, allActualTools);
      }
    } catch (hintErr) { /* non-fatal */ }

  }
  return plan;
}

/**
 * Mark a step as blocked.
 */
export function markStepBlocked(taskId, stepId, reason = '') {
  const plan = _planCache.get(taskId);
  if (!plan) return null;

  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    step.status = 'blocked';
    step.blockReason = reason;
    plan.updatedAt = Date.now();
    plan.needsReplan = true;
    logger.info(`[${ts()}] [planner] Step ${stepId} → blocked: "${step.title}" reason: ${reason}`);
    persistProgress(taskId, 'markStepBlocked'); // [R9-Task2]
    _sendPlanProgress(taskId, plan, "step_blocked");
  }
  return plan;
}

/**
 * [R5-Task1] Mark a step as failed with error details.
 * Unlike blocked (external constraint), failed means the tool execution returned an error.
 */
export function markStepFailed(taskId, stepId, errorMsg = '') {
  const plan = _planCache.get(taskId);
  if (!plan) return null;
  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    step.status = 'failed';
    step.blockReason = errorMsg;
    step.output = `FAILED: ${errorMsg.substring(0, 200)}`;
    plan.updatedAt = Date.now();
    plan.needsReplan = true;
    // Auto-advance currentStepId to next pending step (skip the failed one)
    const nextPending = plan.steps.find(s => s.status === 'pending');
    if (nextPending) {
      plan.currentStepId = nextPending.id;
    }
    logger.info(`[${ts()}] [planner] Step ${stepId} \u2192 failed: "${step.title}" error: ${errorMsg.substring(0, 150)}`);
    persistProgress(taskId, 'markStepFailed'); // [R9-Task2]
    _sendPlanProgress(taskId, plan, "step_failed");
    // [R38-T3] Emit plan_update on step failure
    try {
      const _sk38f = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
      emitEvent(_sk38f, taskId, EVENT_TYPES.PLAN_UPDATE, _r42FormatPlanPayload(plan, {
        version: plan.version, plan_version: plan.plan_version || plan.version,
        trigger: 'step_failed', stepId, taskId
      }));
    } catch (_e38f) { /* non-fatal */ }
  }
  return plan;
}
/**
 * [R5-Task2] Mark a step as retrying.
 */
export function markStepRetrying(taskId, stepId) {
  const plan = _planCache.get(taskId);
  if (!plan) return null;
  const step = plan.steps.find(s => s.id === stepId);
  if (step) {
    step.status = 'retrying';
    plan.updatedAt = Date.now();
    logger.info(`[${ts()}] [planner] Step ${stepId} \u2192 retrying: "${step.title}"`);
    persistProgress(taskId, 'markStepRetrying'); // [R9-Task2]
  }
  return plan;
}
/**
 * Flag the plan for replanning (e.g., after unexpected errors).
 */
export function requestReplan(taskId, reason = '') {
  const plan = _planCache.get(taskId);
  if (!plan) return;
  plan.needsReplan = true;
  plan.notes.push(`Replan requested: ${reason}`);
  plan.updatedAt = Date.now();
  logger.info(`[${ts()}] [planner] Replan requested for task ${taskId}: ${reason}`);
}

/**
 * Check if the plan is complete (all steps done or skipped).
 */
export function isPlanComplete(taskId) {
  const plan = _planCache.get(taskId);
  if (!plan) return false;
  return plan.steps.every(s => s.status === 'done' || s.status === 'skipped' || s.status === 'failed' || s.status === 'blocked');
}

/**
 * [Iter-65] Validate plan completion with contract checks.
 * Goes beyond isPlanComplete() by verifying:
 * 1. All steps have terminal status
 * 2. Completed steps have output (for tool steps)
 * 3. doneCriteria items are programmatically assessed
 *
 * @returns {{ valid: boolean, status: string, issues: string[], missingCriteria: string[] }}
 */
export function validatePlanCompletion(taskId) {
  const plan = _planCache.get(taskId);
  if (!plan) return { valid: false, status: 'no_plan', issues: ['Plan not found in cache'], missingCriteria: [] };

  const issues = [];
  const missingCriteria = [];

  // 1. Step status check
  const terminalStatuses = new Set(['done', 'skipped', 'failed', 'blocked']);
  const nonTerminalSteps = plan.steps.filter(s => !terminalStatuses.has(s.status));
  if (nonTerminalSteps.length > 0) {
    for (const s of nonTerminalSteps) {
      issues.push(`Step "${s.id}" is still "${s.status}"`);
    }
  }

  // 2. Output check for completed/failed tool steps
  for (const s of plan.steps) {
    if (s.status === 'done' && !s.output && (s.tools || []).length > 0) {
      issues.push(`Step "${s.id}" marked done but has no output`);
    }
    if (s.status === 'failed' && !s.blockReason) {
      issues.push(`Step "${s.id}" marked failed but has no blockReason`);
    }
  }

  // 3. doneCriteria assessment
  const criteria = plan.doneCriteria || [];
  if (criteria.length === 0) {
    issues.push('Plan has no doneCriteria defined');
  } else {
    const allOutputs = plan.steps
      .filter(s => s.output)
      .map(s => s.output)
      .join(' ');
    const allTitles = plan.steps
      .filter(s => s.status === 'done' || s.status === 'skipped')
      .map(s => s.title)
      .join(' ');

    for (const criterion of criteria) {
      const keywords = criterion.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const matched = keywords.some(kw =>
        allOutputs.toLowerCase().includes(kw) || allTitles.toLowerCase().includes(kw)
      );
      if (!matched) {
        missingCriteria.push(criterion);
      }
    }
  }

  const valid = issues.length === 0 && missingCriteria.length === 0;
  const status = issues.length === 0 ? 'valid' : 'invalid';

  if (!valid) {
    logger.info(`[${ts()}] [Iter-65] validatePlanCompletion ${taskId}: valid=${valid} issues=${issues.length} missingCriteria=${missingCriteria.length}`);
  }

  return { valid, status, issues, missingCriteria };
}
/**
 * Get the current step that should be executed.
 */
export function getCurrentStep(taskId) {
  const plan = _planCache.get(taskId);
  if (!plan) return null;

  // [L4-PR1] Dependency-aware step resolution:
  // If currentStepId step has unresolved dependsOn, find next executable step instead.
  const current = plan.steps.find(s => String(s.id) === String(plan.currentStepId));
  if (!current) return null;

  // If current step is already done/skipped, find next executable
  if (current.status === 'done' || current.status === 'skipped' || current.status === 'failed') {
    const done = new Set(plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').map(s => String(s.id)));
    const next = plan.steps.find(s => {
      if (s.status !== 'pending' && s.status !== 'doing' && s.status !== 'retrying') return false;
      const deps = (s.dependsOn || []).map(String);
      return deps.every(d => done.has(d));
    });
    if (next) {
      plan.currentStepId = String(next.id);
      logger.info(`[${ts()}] [L4-PR1] getCurrentStep: advanced to dep-ready step ${next.id} (was done/skipped)`);
    }
    return next || null;
  }

  // Check if current step's dependencies are all satisfied
  const doneSt = new Set(plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').map(s => String(s.id)));
  const deps = (current.dependsOn || []).map(String);
  const blocked = deps.filter(d => !doneSt.has(d));
  if (blocked.length > 0) {
    // Current step is blocked — find a step that IS unblocked
    const unblocked = plan.steps.find(s => {
      if (String(s.id) === String(plan.currentStepId)) return false;
      if (s.status !== 'pending' && s.status !== 'doing' && s.status !== 'retrying') return false;
      const sdeps = (s.dependsOn || []).map(String);
      return sdeps.every(d => doneSt.has(d));
    });
    if (unblocked) {
      logger.info(`[${ts()}] [L4-PR1] getCurrentStep: step ${plan.currentStepId} blocked by [${blocked.join(',')}], redirecting to ${unblocked.id}`);
      return unblocked;
    }
    // All remaining steps are blocked — return current anyway (will retry/replan)
    logger.warn(`[${ts()}] [L4-PR1] getCurrentStep: step ${plan.currentStepId} blocked, no unblocked alternative`);
  }

  return current;
}

/**
 * Get the full plan for a task.
 */
export function getPlan(taskId) {
  return _planCache.get(taskId) || null;
}

/**
 * Clear plan cache for a task (on task completion).
 * [R8-Task4] Also marks the plan as completed in DB.
 * [R10-Task4] Force-persist final steps_completed before marking completed,
 * to prevent stale values from earlier persistProgress calls.
 */
export function clearPlan(taskId) {
  const plan = _planCache.get(taskId);
  if (plan) {
    // [R10-Task4] Force final persist with accurate step counts BEFORE deleting from cache
    const sessionKey = _sessionKeyCache.get(taskId) || taskId.replace(/^msg-/, 'task-');
    const finalDone = plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
    const totalSteps = plan.steps.length;
    logger.info(`[${ts()}] [R10-Task4] clearPlan final persist: task=${taskId} done=${finalDone}/${totalSteps}`);
    // Synchronous-ish: fire the final persist (it's async but we don't await — the UPDATE will race with markPlanCompletedInDb)
    // To guarantee ordering, we combine both into a single DB call
    finalizePlanInDb(taskId, plan, sessionKey);
  }
  _planCache.delete(taskId);
  _externalPlanKeys.delete(taskId); // [R10-Task1] cleanup
  _sessionKeyCache.delete(taskId); // [R9-Task2]
  // [R10-Task4] markPlanCompletedInDb is now handled inside finalizePlanInDb
  if (!plan) {
    markPlanCompletedInDb(taskId); // fallback if plan was already gone from cache
  }
}

/**
 * [R3-Task1] Register an externally-generated plan into the planner cache.
 * Used by context-injector to bridge task-engine plans into planner's _planCache
 * so that getCurrentStep() and markStepDone() work for all callers.
 *
 * @param {string} taskId - Key to register under (msgId or taskId)
 * @param {StructuredPlan} plan - Plan object with steps[], currentStepId, etc.
 */
export function registerExternalPlan(taskId, plan) {
  if (!taskId || !plan || !plan.steps) return;
  // Don't overwrite an existing plan from planner's own generatePlan
  if (_planCache.has(taskId)) {
    logger.info(`[${ts()}] [planner] registerExternalPlan: skipping ${taskId} (already cached)`);
    return;
  }
  normalizePlanStepContract(plan);
  _planCache.set(taskId, plan);
  _sendPlanProgress(taskId, plan, "plan_generated");
  _externalPlanKeys.set(taskId, true); // [R10-Task1] Mark as external so generatePlan will upgrade it
  // [R8-Task4] Also persist externally registered plans to DB
  const sessionKey = taskId.replace(/^msg-/, 'task-');
  _sessionKeyCache.set(taskId, sessionKey); // [R9-Task2]
  persistPlanToDb(taskId, sessionKey, plan);
  logger.info(`[${ts()}] [planner] registerExternalPlan: registered ${plan.steps.length} steps for ${taskId} (marked external)`);
}

// R98 split: rendering, recovery/metrics and parallel scheduling live in focused modules.
export { renderPlanForContext, createFallbackPlan } from './plan-renderer.mjs';
export {
  rebuildPlanFromEvents,
  recoverActivePlans,
  isRecoveryDone,
  getRecoveredPlans,
  getRecoveredPlan,
  consumeRecoveredPlan,
  getActivePlansBySession,
  getResumablePlan,
  recordPlanInjection,
  recordActionFollowance,
  recordNoPlanAction,
  getTaskPlanMetrics,
  getAllPlanMetrics,
} from './plan-recovery.mjs';
export { getParallelBatches, getNextExecutableSteps } from './plan-parallel.mjs';

export function cleanupPlanStorageResources() {
  _planCache.dispose();
  _externalPlanKeys.dispose();
  _sessionKeyCache.dispose();
  // Lazy imports own their cleanup via process lifetime; caches above remain the shared planner state.
}
