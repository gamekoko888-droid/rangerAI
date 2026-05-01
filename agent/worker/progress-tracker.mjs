// progress-tracker.mjs — extracted from task-engine.mjs (R98)
import { logger } from '../lib/logger.mjs';
import { TTLMap } from './lib/ttl-map.mjs';
import { savePlan as dbSavePlan } from './db-proxy.mjs';
import { emitLedgerEvent, EVENT_TYPES } from './event-stream.mjs';

export const progressStore = new TTLMap(200, 60 * 60 * 1000, 5 * 60 * 1000);

// ─── Diagnostics Store (tracks why tracker was/wasn't initialized) ───
const diagnosticsStore = new TTLMap(200, 60 * 60 * 1000, 5 * 60 * 1000);

// ─── Constants ───
const MAX_STEPS = 20;           // Ignore plans with more than 20 steps (likely not a real plan)
const MIN_STEPS_TO_TRACK = 2;   // Don't track trivially small plans
const STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — auto-expire stale trackers

const ts = () => new Date().toISOString();

/**
 * Create or retrieve a progress tracker for a session.
 * Returns the tracker object with methods to manage progress.
 * 
 * @param {string} sessionKey - Gateway session key (persists across messages)
 * @returns {Object} tracker
 */
export function getProgressTracker(sessionKey) {
  if (!sessionKey) return createNullTracker();
  
  let tracker = progressStore.get(sessionKey);
  if (tracker && (Date.now() - tracker._lastActivity > STALE_TIMEOUT_MS)) {
    // Expired — clean up
    logger.info(`[${ts()}] [progress-tracker] Tracker expired for ${sessionKey} (stale ${Math.round((Date.now() - tracker._lastActivity) / 60000)}min)`);
    progressStore.delete(sessionKey);
    tracker = null;
  }
  
  if (!tracker) {
    tracker = createTracker(sessionKey);
    progressStore.set(sessionKey, tracker);
  }
  
  tracker._lastActivity = Date.now();
  return tracker;
}

/**
 * Initialize tracker from a parsed plan object (from task-planner.mjs).
 * Called when task-planner detects a new plan in AI output.
 * 
 * R53: Added diagnostic logging for rejected plans.
 * 
 * @param {string} sessionKey
 * @param {Object} plan - { phases: [{ id, title, status }], goal }
 */
export function initTrackerFromPlan(sessionKey, plan) {
  if (!sessionKey || !plan || !plan.phases) {
    // R53 diagnostic: log why initialization was skipped
    const reason = !sessionKey ? "no sessionKey" : !plan ? "no plan" : "no plan.phases";
    logger.info(`[${ts()}] [progress-tracker] [DIAG] initTrackerFromPlan SKIPPED: ${reason}`);
    recordDiagnostic(sessionKey || "unknown", "init_skipped", reason);
    return;
  }
  
  if (plan.phases.length < MIN_STEPS_TO_TRACK) {
    logger.info(`[${ts()}] [progress-tracker] [DIAG] Plan rejected: too few steps (${plan.phases.length} < ${MIN_STEPS_TO_TRACK})`);
    recordDiagnostic(sessionKey, "plan_rejected", `too_few_steps:${plan.phases.length}`);
    return;
  }
  
  if (plan.phases.length > MAX_STEPS) {
    logger.info(`[${ts()}] [progress-tracker] [DIAG] Plan rejected: too many steps (${plan.phases.length} > ${MAX_STEPS})`);
    recordDiagnostic(sessionKey, "plan_rejected", `too_many_steps:${plan.phases.length}`);
    return;
  }
  
  const tracker = getProgressTracker(sessionKey);
  tracker._steps = plan.phases.map(p => ({
    id: p.id,
    title: p.title || `步骤 ${p.id}`,
    status: p.status || "pending"  // "pending" | "running" | "completed"
  }));
  tracker._goal = plan.goal || "";
  tracker._totalSteps = tracker._steps.length;
  tracker._completedSteps = tracker._steps.filter(s => s.status === "completed").length;
  tracker._initialized = true;
  tracker._initSource = "plan";
  
  recordDiagnostic(sessionKey, "initialized", `${tracker._totalSteps} steps, goal="${tracker._goal}"`);
  logger.info(`[${ts()}] [progress-tracker] Initialized for ${sessionKey}: ${tracker._totalSteps} steps, goal="${tracker._goal}"`);
}

/**
 * Mark a step as completed.
 * 
 * @param {string} sessionKey
 * @param {number} stepId - Phase/step ID to mark as done
 */
export function markStepDone(sessionKey, stepId) {
  const tracker = progressStore.get(sessionKey);
  if (!tracker || !tracker._initialized) return;
  
  const step = tracker._steps.find(s => s.id === stepId);
  if (step && step.status !== "completed") {
    // [R71-P0-3] Evidence gate: step cannot be "done" without verifiable evidence.
    // If no evidence, mark as needs_verification instead.
    const _hasEvidence = hasStepEvidence(sessionKey, stepId);
    if (!_hasEvidence) {
      step.status = "needs_verification";
      // [R73-P0-3] Write needs_verification to event stream for recovery replay
      emitLedgerEvent(sessionKey, tracker._lastMsgId || sessionKey, EVENT_TYPES.STEP_NEEDS_VERIFICATION, {
        stepId, stepTitle: step.title, reason: 'no_evidence',
      });
      logger.info(`[${ts()}] [progress-tracker] Step ${stepId} needs verification (no evidence) for ${sessionKey}`);
      return;
    }

    step.status = "completed";
    tracker._completedSteps = tracker._steps.filter(s => s.status === "completed").length;
    
    // Auto-advance: set next pending step to "running"
    const nextPending = tracker._steps.find(s => s.status === "pending");
    if (nextPending) {
      nextPending.status = "running";
    }
    
    // [R73-P0-3] Write step completion to event stream for recovery replay
    emitLedgerEvent(sessionKey, tracker._lastMsgId || sessionKey, EVENT_TYPES.STEP_COMPLETED, {
      stepId, stepTitle: step.title, completedSteps: tracker._completedSteps,
      totalSteps: tracker._totalSteps, nextStepId: nextPending?.id || null,
    });
    
    logger.info(`[${ts()}] [progress-tracker] Step ${stepId} completed for ${sessionKey}: ${tracker._completedSteps}/${tracker._totalSteps}`);
    try {
      const planForDB = { goal: tracker._goal, phases: tracker._steps, steps: tracker._steps.map(s => ({ title: s.title, status: s.status === "completed" ? "done" : s.status, done: s.status === "completed" })) };
      dbSavePlan({ sessionKey, msgId: tracker._lastMsgId || sessionKey, plan: planForDB }).catch(() => {});
    } catch(_err) { /* v22.0 */ logger.error("[task-progress-tracker] silent catch:", _err?.message || _err); }
  }
}

// [R71-P0-3] Evidence store for step verification gate.
const _evidenceStore = new TTLMap(100, 2 * 60 * 60 * 1000, 5 * 60 * 1000); // `${sessionKey}:${stepId}` => [{ type, detail, timestamp }]

/**
 * Record evidence for a step.
 * @param {string} sessionKey
 * @param {number|string} stepId
 * @param {Object} evidence - { type: string, detail: string, tool?: string }
 */
export function recordStepEvidence(sessionKey, stepId, evidence) {
  if (!sessionKey || stepId == null) return;
  const key = `${sessionKey}:${stepId}`;
  if (!_evidenceStore.has(key)) _evidenceStore.set(key, []);
  _evidenceStore.get(key).push({
    type: evidence.type || evidence.evidenceType || 'unknown',
    detail: evidence.detail || evidence.result || '',
    tool: evidence.tool || null,
    timestamp: new Date().toISOString(),
  });
  logger.info(`[${ts()}] [progress-tracker] Evidence recorded for step ${stepId}: type=${evidence.type || evidence.evidenceType}`);
}

/**
 * Check if a step has any evidence recorded.
 * @param {string} sessionKey
 * @param {number|string} stepId
 * @returns {boolean}
 */
export function hasStepEvidence(sessionKey, stepId) {
  const key = `${sessionKey}:${stepId}`;
  const evidence = _evidenceStore.get(key);
  return Array.isArray(evidence) && evidence.length > 0;
}

/**
 * Get all evidence for a step.
 * @param {string} sessionKey
 * @param {number|string} stepId
 * @returns {Array}
 */
export function getStepEvidence(sessionKey, stepId) {
  const key = `${sessionKey}:${stepId}`;
  return _evidenceStore.get(key) || [];
}

/**
 * Clear evidence for a session (cleanup after task completion).
 * @param {string} sessionKey
 */
export function clearEvidence(sessionKey) {
  if (!sessionKey) return;
  for (const key of _evidenceStore.keys()) {
    if (key.startsWith(`${sessionKey}:`)) _evidenceStore.delete(key);
  }
}

/**
 * Mark a step as currently running.
 * 
 * @param {string} sessionKey
 * @param {number} stepId
 */
export function markStepRunning(sessionKey, stepId) {
  const tracker = progressStore.get(sessionKey);
  if (!tracker || !tracker._initialized) return;
  
  const step = tracker._steps.find(s => s.id === stepId);
  if (step && step.status === "pending") {
    step.status = "running";
    // [R73-P0-3] Write step state change to event stream for recovery replay
    emitLedgerEvent(sessionKey, tracker._lastMsgId || sessionKey, EVENT_TYPES.STEP_STARTED, {
      stepId, stepTitle: step.title, stepIndex: tracker._steps.indexOf(step),
      totalSteps: tracker._totalSteps,
    });
    logger.info(`[${ts()}] [R73-P0-3] Step ${stepId} → running, event emitted for ${sessionKey}`);
  }
}

/**
 * Build the progress block text to append to the LLM message.
 * Returns empty string if no progress data exists.
 * 
 * Format:
 * [TASK_PROGRESS]
 * 目标: xxx
 * ✅ 步骤1: 已完成描述
 * 🔄 步骤2: 当前进行中（第2/5步）
 * ⬜ 步骤3: 待执行
 * [/TASK_PROGRESS]
 * 
 * @param {string} sessionKey
 * @returns {string}
 */
// Iter-AE: 进度块前缀变体（按调用次数取模轮换，防 Few-Shot 模式固化）
const PROGRESS_PREFIXES = ['当前进度', '任务状态', '执行情况', '阶段概览'];

export function buildProgressBlock(sessionKey, options = {}) {
  const tracker = progressStore.get(sessionKey);
  if (!tracker || !tracker._initialized || tracker._steps.length === 0) return "";

  // Iter-AE: 支持外部传入 prefix（由 context-injector 按 toolCallCount 取模决定）
  const prefix = options.prefix || PROGRESS_PREFIXES[0];
  const lines = [`[${prefix.toUpperCase().replace(/\s/g, '_')}]`];
  
  if (tracker._goal) {
    lines.push(`目标: ${tracker._goal}`);
  }
  
  for (const step of tracker._steps) {
    const icon = step.status === "completed" ? "✅" 
      : step.status === "running" ? "🔄" 
      : "⬜";
    const suffix = step.status === "running" 
      ? `（第${step.id}/${tracker._totalSteps}步）` 
      : "";
    lines.push(`${icon} 步骤${step.id}: ${step.title}${suffix}`);
  }
  
  const closeTag = `[/${prefix.toUpperCase().replace(/\s/g, '_')}]`;
  lines.push(closeTag);
  return "\n\n" + lines.join("\n");
}

export { PROGRESS_PREFIXES };

/**
 * Check if this session has active progress tracking.
 * 
 * @param {string} sessionKey
 * @returns {boolean}
 */
export function hasProgress(sessionKey) {
  const tracker = progressStore.get(sessionKey);
  return !!(tracker && tracker._initialized && tracker._steps.length > 0);
}

/**
 * Check if progress tracking should be active for this task type.
 * Only tracks complex tasks that benefit from attention anchoring.
 * 
 * R53: Lowered tool call threshold from 3 to 2, added "general" and "creative" types.
 * 
 * @param {string} taskType - From smart-router classification
 * @param {number} toolCallCount - Number of tool calls so far
 * @returns {boolean}
 */
export function shouldTrackProgress(taskType, toolCallCount = 0) {
  const trackableTypes = ["code", "reasoning", "sysadmin", "research", "chinese_content", "general", "creative"];
  
  // Track if: (1) complex task type, OR (2) any task with 2+ tool calls
  return trackableTypes.includes(taskType) || toolCallCount >= 2;
}

/**
 * Clean up tracker for a session (call on session end or explicit cleanup).
 * 
 * @param {string} sessionKey
 */
export function cleanupTracker(sessionKey) {
  // [R19-T4] Interrupt active task focus on session cleanup
  try { interruptTaskFocus(sessionKey, 'session_cleanup'); } catch (_) {}
  progressStore.delete(sessionKey);
  diagnosticsStore.delete(sessionKey);
}

/**
 * Get tracker stats for logging/debugging.
 * 
 * @param {string} sessionKey
 * @returns {Object|null}
 */
export function getTrackerStats(sessionKey) {
  const tracker = progressStore.get(sessionKey);
  if (!tracker || !tracker._initialized) return null;
  
  return {
    goal: tracker._goal,
    totalSteps: tracker._totalSteps,
    completedSteps: tracker._completedSteps,
    currentStep: tracker._steps.find(s => s.status === "running")?.id || null,
    steps: tracker._steps.map(s => ({ id: s.id, title: s.title, status: s.status }))
  };
}

/**
 * R53: Get diagnostic information for debugging tracker behavior.
 * Shows why tracker was/wasn't initialized for recent sessions.
 * 
 * @param {string} sessionKey - Optional, if provided returns only that session's diagnostics
 * @returns {Object}
 */
export function getTrackerDiagnostics(sessionKey) {
  if (sessionKey) {
    return {
      sessionKey,
      events: diagnosticsStore.get(sessionKey) || [],
      trackerActive: hasProgress(sessionKey),
      trackerStats: getTrackerStats(sessionKey)
    };
  }
  
  // Return all diagnostics
  const all = {};
  for (const [key, events] of diagnosticsStore) {
    all[key] = {
      events,
      trackerActive: hasProgress(key),
      trackerStats: getTrackerStats(key)
    };
  }
  return all;
}

// ─── Internal helpers ───

export function createTracker(sessionKey) {
  return {
    _sessionKey: sessionKey,
    _steps: [],
    _goal: "",
    _totalSteps: 0,
    _completedSteps: 0,
    _initialized: false,
    _initSource: null,
    _lastActivity: Date.now(),
    _lastMsgId: null
  };
}

export function createNullTracker() {
  return {
    _initialized: false,
    _steps: [],
    hasProgress: () => false,
    buildProgressBlock: () => ""
  };
}

/**
 * R53: Record a diagnostic event for debugging.
 */
export function recordDiagnostic(sessionKey, event, detail) {
  if (!diagnosticsStore.has(sessionKey)) {
    diagnosticsStore.set(sessionKey, []);
  }
  const events = diagnosticsStore.get(sessionKey);
  events.push({ event, detail, at: new Date().toISOString() });
  // Keep only last 10 events per session
  if (events.length > 10) events.shift();
}

// ─── Periodic cleanup of stale trackers ───
let _progressCleanupTimer = setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, tracker] of progressStore) {
    if (now - tracker._lastActivity > STALE_TIMEOUT_MS) {
      progressStore.delete(key);
      cleaned++;
    }
  }
  for (const [key, events] of diagnosticsStore) {
    if (!progressStore.has(key) && events.length > 0) {
      const lastEvent = events[events.length - 1];
      if (lastEvent && (now - new Date(lastEvent.at).getTime() > 60 * 60 * 1000)) {
        diagnosticsStore.delete(key);
      }
    }
  }
  if (cleaned > 0) {
    logger.info(`[${ts()}] [progress-tracker] Cleaned up ${cleaned} stale tracker(s)`);
  }
}, 10 * 60 * 1000); // Every 10 minutes
if (typeof _progressCleanupTimer.unref === 'function') _progressCleanupTimer.unref();

// [R95] Clean up the periodic stale tracker cleanup timer
export function cleanupProgressTrackerResources() {
  if (_progressCleanupTimer) {
    clearInterval(_progressCleanupTimer);
    _progressCleanupTimer = null;
  }
}

export function setTrackerMsgId(sessionKey, msgId) {
  const tracker = progressStore.get(sessionKey);
  if (tracker && tracker._initialized) {
    tracker._lastMsgId = msgId;
  }
}

