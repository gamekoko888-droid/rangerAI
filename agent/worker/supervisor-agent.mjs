/**
 * worker/supervisor-agent.mjs — Supervisor Agent (v1.0, R15-T3)
 *
 * Three minimum capabilities:
 *   (a) preflight review: static check on plan, output risk level
 *   (b) step intervention hint: advice for high-risk steps
 *   (c) final review: post-task review summary
 *
 * When SUPERVISOR_ENABLED=false (default), all functions return stub responses
 * without blocking the existing single-loop agent flow.
 *
 * @module worker/supervisor-agent
 */
import { logger } from '../lib/logger.mjs';
import { emitEvent } from './event-stream.mjs'; // [R43-T4]
import { invokeLLM } from './llm-bridge.mjs';
import Database from 'better-sqlite3';
import { resolve } from 'path';

const ts = () => new Date().toISOString();

// ─── Configuration ───
// [R16-T2] Default to true — supervisor now runs in production
const SUPERVISOR_ENABLED = process.env.SUPERVISOR_ENABLED !== 'false';

// ─── DB Singleton for supervisor_reviews ───
let _supervisorDb = null;
export function getSupervisorDb() {
  if (!_supervisorDb) {
    const dbPath = process.env.RANGERAI_WORKER_DB || resolve('/opt/rangerai-agent/db/rangerai.db');
    _supervisorDb = new Database(dbPath);
    _supervisorDb.pragma('journal_mode = WAL');
    _supervisorDb.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        task_id TEXT,
        session_key TEXT,
        risk_level TEXT,
        score REAL,
        step_count INTEGER,
        goal TEXT,
        risks_json TEXT,
        feedback TEXT,
        stub INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // [R17-T1] supervisor_decisions table for intervention tracking
    _supervisorDb.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        session_key TEXT,
        phase TEXT NOT NULL,
        decision_action TEXT NOT NULL,
        risk_level TEXT,
        reason TEXT,
        step_id INTEGER,
        step_title TEXT,
        risks_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // [R43-T4] Add intervention_type column
    try { _supervisorDb.exec('ALTER TABLE supervisor_decisions ADD COLUMN intervention_type TEXT DEFAULT NULL'); } catch(_) {}

  }
  return _supervisorDb;
}

// ─── Risk Patterns (Static Analysis) ───
const RISK_PATTERNS = {
  destructive_shell: {
    level: 'high',
    label: 'Destructive shell command risk',
    detect: (step) => {
      const t = (step.title || '').toLowerCase();
      const tools = (step.tools || []).map(x => x.toLowerCase());
      const expected = (step.expectedTools || []).map(x => x.toLowerCase());
      const hasShell = tools.includes('shell') || tools.includes('exec') || expected.some(e => e.includes('exec'));
      const hasDestructive = /\b(rm\s+-rf|drop\s+table|delete\s+from|truncate|format|fdisk|mkfs|dd\s+if)\b/i.test(t);
      return hasShell && hasDestructive;
    }
  },
  no_verification: {
    level: 'medium',
    label: 'Missing verification step',
    detect: (step, allSteps, idx) => {
      const tools = (step.tools || []).map(x => x.toLowerCase());
      const isWrite = tools.includes('write') || tools.includes('shell');
      // Check if next step is a verification step
      if (isWrite && idx < allSteps.length - 1) {
        const nextTools = (allSteps[idx + 1].tools || []).map(x => x.toLowerCase());
        const nextTitle = (allSteps[idx + 1].title || '').toLowerCase();
        const isVerify = nextTools.includes('inspect') || nextTools.includes('browser') || 
                         nextTitle.includes('验证') || nextTitle.includes('verify') || 
                         nextTitle.includes('check') || nextTitle.includes('test') ||
                         nextTitle.includes('确认');
        return !isVerify;
      }
      return false;
    }
  },
  browser_without_fallback: {
    level: 'low',
    label: 'Browser step without fallback plan',
    detect: (step) => {
      const tools = (step.tools || []).map(x => x.toLowerCase());
      return tools.includes('browser') && !(step.rationale || '').toLowerCase().includes('fallback');
    }
  },
  single_step_complex: {
    level: 'medium',
    label: 'Complex task compressed into single step',
    detect: (step, allSteps) => {
      return allSteps.length <= 1 && (step.title || '').length > 80;
    }
  },
  excessive_steps: {
    level: 'low',
    label: 'Plan has too many steps (may cause drift)',
    detect: (step, allSteps) => {
      return allSteps.length > 8;
    }
  },
  // [R17-T6] Business risk patterns
  financial_operation: {
    level: 'high',
    label: 'Financial/payment operation detected',
    detect: (step) => {
      const t = (step.title || '').toLowerCase();
      return /\b(refund|payment|balance|charge|credit|debit|transfer|withdraw|payout|invoice|billing)\b/i.test(t);
    }
  },
  data_export: {
    level: 'medium',
    label: 'Data export/download operation',
    detect: (step) => {
      const t = (step.title || '').toLowerCase();
      return /\b(export|download|dump|backup|extract.*data|csv|excel)\b/i.test(t);
    }
  },
  user_data_access: {
    level: 'medium',
    label: 'User personal data access',
    detect: (step) => {
      const t = (step.title || '').toLowerCase();
      return /\b(user.*data|personal.*info|email.*list|phone.*number|password|credential|pii|gdpr)\b/i.test(t);
    }
  },
  external_api_call: {
    level: 'low',
    label: 'External API call (potential cost/rate-limit)',
    detect: (step) => {
      const t = (step.title || '').toLowerCase();
      const tools = (step.tools || []).map(x => x.toLowerCase());
      return (tools.includes('web_search') || tools.includes('browser')) && /\b(api|endpoint|webhook|third.?party)\b/i.test(t);
    }
  }
};

// ─── Review History (in-memory, limited) ───
const _reviewHistory = [];
const MAX_REVIEW_HISTORY = 50;

function addReview(review) {
  _reviewHistory.push(review);
  if (_reviewHistory.length > MAX_REVIEW_HISTORY) {
    _reviewHistory.shift();
  }
  // [R16-T2] Persist to DB
  try {
    const db = getSupervisorDb();
    db.prepare(`
      INSERT INTO supervisor_reviews (type, task_id, session_key, risk_level, score, step_count, goal, risks_json, feedback, stub)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      review.type || 'unknown',
      review.taskId || null,
      review.sessionKey || null,
      review.riskLevel || null,
      review.score != null ? review.score : null,
      review.stepCount || review.summary?.totalSteps || null,
      review.goal || review.summary?.goal || null,
      JSON.stringify(review.risks || []),
      review.feedback || review.llmFeedback || null,
      review.stub ? 1 : 0
    );
  } catch (err) {
    logger.warn(`[${ts()}] [supervisor] Failed to persist review to DB: ${err.message}`);
  }
}

// ─── State ───
const _state = {
  enabled: SUPERVISOR_ENABLED,
  initialized: false,
  evaluationCount: 0,
  interventionCount: 0,
  reviewCount: 0,
  lastActivity: null,
};

/**
 * Initialize the supervisor module.
 */
export function initSupervisor(config = {}) {
  _state.initialized = true;
  if (SUPERVISOR_ENABLED) {
    logger.info(`[${ts()}] [supervisor] Supervisor agent ENABLED — review mode active`);
  } else {
    logger.info(`[${ts()}] [supervisor] Supervisor agent DISABLED (stub mode) — passthrough active`);
  }
  return { enabled: SUPERVISOR_ENABLED, stub: !SUPERVISOR_ENABLED };
}

/**
 * (a) Preflight Review: Static check on plan before execution.
 * Analyzes plan structure and identifies risks without LLM call.
 *
 * @param {object} plan - The execution plan to evaluate
 * @param {object} context - Current session context
 * @returns {{ approved: boolean, riskLevel: string, risks: Array, feedback: string|null, revised_plan: object|null, stub: boolean }}
 */
export async function supervisorEvaluate(plan, context = {}) {
  _state.evaluationCount++;
  _state.lastActivity = Date.now();

  if (!SUPERVISOR_ENABLED) {
    // Even in stub mode, run static analysis for logging
    const risks = staticRiskAnalysis(plan);
    const riskLevel = risks.length === 0 ? 'low' : 
                      risks.some(r => r.level === 'high') ? 'high' : 'medium';
    
    const review = {
      type: 'preflight',
      taskId: context.taskId || null,
      sessionKey: context.sessionKey || null,
      riskLevel,
      risks,
      stepCount: plan?.steps?.length || 0,
      goal: (plan?.goal || '').substring(0, 200),
      timestamp: Date.now(),
      stub: true,
    };
    addReview(review);
    
    if (risks.length > 0) {
      logger.info(`[${ts()}] [supervisor] [STUB] Preflight found ${risks.length} risk(s): ${risks.map(r => r.label).join(', ')}`);
    }
    
    return {
      approved: true,
      riskLevel,
      risks,
      feedback: risks.length > 0 ? `[Stub] ${risks.length} risk(s) detected: ${risks.map(r => `[${r.level}] ${r.label} (step ${r.stepId})`).join('; ')}` : null,
      revised_plan: null,
      stub: true,
    };
  }

  // Full mode: static analysis + LLM review
  const risks = staticRiskAnalysis(plan);
  const riskLevel = risks.length === 0 ? 'low' : 
                    risks.some(r => r.level === 'high') ? 'high' : 'medium';
  
  let llmFeedback = null;
  if (riskLevel === 'high') {
    try {
      llmFeedback = await llmPlanReview(plan, risks, context);
    } catch (err) {
      logger.warn(`[${ts()}] [supervisor] LLM review failed: ${err.message}`);
    }
  }

  const review = {
    type: 'preflight',
    taskId: context.taskId || null,
    sessionKey: context.sessionKey || null,
    riskLevel,
    risks,
    llmFeedback,
    stepCount: plan?.steps?.length || 0,
    goal: (plan?.goal || '').substring(0, 200),
    timestamp: Date.now(),
    stub: false,
  };
  addReview(review);

  // [R17-T1] Determine decision_action based on risk analysis
  let decisionAction = 'allow';
  let decisionReason = 'No significant risks detected';
  if (riskLevel === 'high') {
    decisionAction = risks.some(r => r.pattern === 'destructive_shell') ? 'block' : 'warn';
    decisionReason = `High risk: ${risks.filter(r => r.level === 'high').map(r => r.label).join('; ')}`;
  } else if (riskLevel === 'medium') {
    decisionAction = 'warn';
    decisionReason = `Medium risk: ${risks.filter(r => r.level === 'medium').map(r => r.label).join('; ')}`;
  }

  // Persist decision
  // [R43-T4] Classify intervention type
  const _r43InterventionType = classifyInterventionType(risks, decisionAction);
  recordDecision({
    taskId: context.taskId,
    sessionKey: context.sessionKey,
    phase: 'preflight',
    decisionAction,
    riskLevel,
    reason: decisionReason,
    risks,
    interventionType: _r43InterventionType,
  });

  // [R19-T2] Auto-create tickets for high/medium risk
  if (risks.length > 0 && (riskLevel === 'high' || riskLevel === 'medium')) {
    createTicketFromRisk({ taskId: context.taskId, sessionKey: context.sessionKey, risks, riskLevel, decisionAction, phase: 'preflight' });
  }

  logger.info(`[${ts()}] [supervisor] Preflight: ${risks.length} risk(s), level=${riskLevel}, decision=${decisionAction}, steps=${plan?.steps?.length || 0}`);
  return {
    approved: decisionAction !== 'block',
    riskLevel,
    risks,
    decisionAction,
    interventionType: _r43InterventionType,
    feedback: llmFeedback || (risks.length > 0 ? risks.map(r => `[${r.level}] ${r.label} (step ${r.stepId})`).join('; ') : null),
    revised_plan: null,
    stub: false,
  };
}

/**
 * (b) Step Intervention Hint: Provide advice for a specific step.
 *
 * @param {string} sessionKey
 * @param {object} step - Current step being executed
 * @param {object} context - { plan, taskId, ... }
 * @returns {{ action: string, directive: string|null, riskLevel: string, stub: boolean }}
 */
export async function supervisorIntervene(sessionKey, step, context = {}) {
  _state.interventionCount++;
  _state.lastActivity = Date.now();

  const stepRisks = [];
  const allSteps = context.plan?.steps || [];
  const stepIdx = allSteps.findIndex(s => s.id === step?.id);
  
  for (const [key, pattern] of Object.entries(RISK_PATTERNS)) {
    if (step && pattern.detect(step, allSteps, stepIdx >= 0 ? stepIdx : 0)) {
      stepRisks.push({ pattern: key, level: pattern.level, label: pattern.label });
    }
  }

  const riskLevel = stepRisks.length === 0 ? 'low' :
                    stepRisks.some(r => r.level === 'high') ? 'high' : 'medium';

  if (!SUPERVISOR_ENABLED) {
    if (stepRisks.length > 0) {
      logger.info(`[${ts()}] [supervisor] [STUB] Step ${step?.id} intervention: ${stepRisks.map(r => r.label).join(', ')}`);
    }
    return {
      action: 'none',
      directive: stepRisks.length > 0 ? `[Stub] Caution: ${stepRisks.map(r => r.label).join('; ')}` : null,
      riskLevel,
      stub: true,
    };
  }

  let directive = null;
  if (riskLevel === 'high') {
    directive = `[SUPERVISOR] HIGH RISK: ${stepRisks.map(r => r.label).join('; ')}. Consider adding verification step or using safer alternatives.`;
  } else if (riskLevel === 'medium') {
    directive = `[SUPERVISOR] CAUTION: ${stepRisks.map(r => r.label).join('; ')}.`;
  }

  // [R17-T1] Determine and persist intervention decision
  const decisionAction = riskLevel === 'high' ? 'warn' : (riskLevel === 'medium' ? 'warn' : 'allow');
  // [R43-T4] Classify intervention type
  const _r43StepInterventionType = classifyInterventionType(stepRisks, decisionAction);
  recordDecision({
    taskId: context.taskId,
    sessionKey: context.sessionKey || sessionKey,
    phase: 'step_intervention',
    decisionAction,
    riskLevel,
    reason: stepRisks.length > 0 ? stepRisks.map(r => r.label).join('; ') : 'No step-level risks',
    stepId: step?.id,
    stepTitle: (step?.title || '').substring(0, 200),
    risks: stepRisks,
    interventionType: _r43StepInterventionType,
  });

  // [R19-T2] Auto-create tickets for step-level risks
  if (stepRisks.length > 0 && (riskLevel === 'high' || riskLevel === 'medium')) {
    createTicketFromRisk({ taskId: context.taskId, sessionKey: context.sessionKey || sessionKey, risks: stepRisks, riskLevel, decisionAction, phase: 'step_intervention' });
  }

  logger.info(`[${ts()}] [supervisor] Step ${step?.id} intervention: risk=${riskLevel}, decision=${decisionAction}, risks=${stepRisks.length}`);
  return {
    action: decisionAction,
    directive,
    riskLevel,
    stub: false,
  };
}

/**
 * (c) Final Review: Post-task review summary.
 *
 * @param {object} plan - The completed plan
 * @param {object} context - { taskId, sessionKey, executionTime, toolsUsed, ... }
 * @returns {{ score: number, feedback: string|null, risks: Array, summary: object, retry: boolean, stub: boolean }}
 */
export async function supervisorReview(plan, context = {}) {
  _state.reviewCount++;
  _state.lastActivity = Date.now();

  const steps = plan?.steps || [];
  const doneSteps = steps.filter(s => s.status === 'done');
  const failedSteps = steps.filter(s => s.status === 'failed');
  const skippedSteps = steps.filter(s => s.status === 'skipped');
  
  // Calculate completion score
  const completionRate = steps.length > 0 ? doneSteps.length / steps.length : 0;
  const failureRate = steps.length > 0 ? failedSteps.length / steps.length : 0;
  
  // Score: 1.0 = perfect, 0.0 = total failure
  let score = completionRate;
  if (failureRate > 0.5) score = Math.min(score, 0.3);
  if (failedSteps.length > 0 && doneSteps.length === 0) score = 0;

  // Identify post-hoc risks
  const postRisks = [];
  if (failedSteps.length > 0) {
    postRisks.push({ level: 'medium', label: `${failedSteps.length} step(s) failed`, steps: failedSteps.map(s => s.id) });
  }
  if (skippedSteps.length > steps.length / 2) {
    postRisks.push({ level: 'medium', label: 'More than half of steps were skipped' });
  }
  if (steps.length === 1 && doneSteps.length === 1) {
    postRisks.push({ level: 'low', label: 'Single-step plan — may lack thoroughness' });
  }

  const summary = {
    totalSteps: steps.length,
    completed: doneSteps.length,
    failed: failedSteps.length,
    skipped: skippedSteps.length,
    completionRate: Math.round(completionRate * 100) + '%',
    score: Math.round(score * 100) / 100,
    goal: (plan?.goal || '').substring(0, 200),
  };

  const review = {
    type: 'final',
    taskId: context.taskId || null,
    sessionKey: context.sessionKey || null,
    score,
    summary,
    risks: postRisks,
    timestamp: Date.now(),
    stub: !SUPERVISOR_ENABLED,
  };
  addReview(review);

  const feedback = postRisks.length > 0
    ? `Review: score=${summary.score}, ${summary.completed}/${summary.totalSteps} completed. Issues: ${postRisks.map(r => r.label).join('; ')}`
    : `Review: score=${summary.score}, ${summary.completed}/${summary.totalSteps} completed. No issues detected.`;

  // [R17-T1] Final review decision
  let finalDecision = 'allow';
  let finalReason = `Score=${summary.score}, ${summary.completed}/${summary.totalSteps} completed`;
  if (score < 0.3 && failedSteps.length > 0) {
    finalDecision = 'replan';
    finalReason = `Low score (${summary.score}), ${failedSteps.length} failed step(s) — recommend retry`;
  } else if (postRisks.some(r => r.level === 'high' || r.level === 'medium')) {
    finalDecision = 'warn';
    finalReason = `Post-hoc risks: ${postRisks.map(r => r.label).join('; ')}`;
  }

  // [R43-T4] Classify intervention type
  const _r43FinalInterventionType = classifyInterventionType(postRisks, finalDecision);
  recordDecision({
    taskId: context.taskId,
    sessionKey: context.sessionKey,
    phase: 'final_review',
    decisionAction: finalDecision,
    riskLevel: postRisks.length > 0 ? (postRisks.some(r => r.level === 'high') ? 'high' : 'medium') : 'low',
    reason: finalReason,
    risks: postRisks,
    interventionType: _r43FinalInterventionType,
  });

  logger.info(`[${ts()}] [supervisor] Final review: score=${summary.score} completed=${summary.completed}/${summary.totalSteps} decision=${finalDecision} risks=${postRisks.length}`);

  return {
    score,
    feedback,
    risks: postRisks,
    summary,
    retry: finalDecision === 'replan',
    decisionAction: finalDecision,
    interventionType: _r43FinalInterventionType,
    stub: !SUPERVISOR_ENABLED,
  };
}

/**
 * Get supervisor status for monitoring.
 */
export function getSupervisorStatus() {
  return {
    enabled: _state.enabled,
    stub: !_state.enabled,
    initialized: _state.initialized,
    stats: {
      evaluations: _state.evaluationCount,
      interventions: _state.interventionCount,
      reviews: _state.reviewCount,
      lastActivity: _state.lastActivity ? new Date(_state.lastActivity).toISOString() : null,
    },
  };
}

/**
 * Get recent review history for /api/admin/supervisor-reviews
 */
export function getReviewHistory(limit = 20) {
  // [R16-T2] Read from DB for persistence across restarts
  try {
    const db = getSupervisorDb();
    const rows = db.prepare(`
      SELECT id, type, task_id, session_key, risk_level, score, step_count, goal, risks_json, feedback, stub, created_at
      FROM supervisor_reviews ORDER BY id DESC LIMIT ?
    `).all(limit);
    return rows.map(r => ({
      id: r.id,
      type: r.type,
      taskId: r.task_id,
      sessionKey: r.session_key,
      riskLevel: r.risk_level,
      score: r.score,
      stepCount: r.step_count,
      goal: r.goal,
      risks: JSON.parse(r.risks_json || '[]'),
      feedback: r.feedback,
      stub: !!r.stub,
      timestamp: r.created_at,
    }));
  } catch (err) {
    logger.warn(`[${ts()}] [supervisor] Failed to read reviews from DB: ${err.message}`);
    // Fallback to in-memory
    return _reviewHistory.slice(-limit).reverse();
  }
}

/**
 * [R17-T1] Record a supervisor decision to DB.
 */

// [R43-T4] Classify intervention type: 'ask' for security-sensitive, 'notify' for informational
function classifyInterventionType(risks, decisionAction) {
  // 'ask' patterns: require user confirmation
  const ASK_PATTERNS = ['destructive_shell', 'financial_operation', 'data_export', 'user_data_access'];
  // Check if any risk matches an 'ask' pattern
  const hasAskRisk = (risks || []).some(r => ASK_PATTERNS.includes(r.pattern));
  // block decisions always require 'ask'
  if (decisionAction === 'block') return 'ask';
  if (hasAskRisk) return 'ask';
  return 'notify';
}

function recordDecision({ taskId, sessionKey, phase, decisionAction, riskLevel, reason, stepId, stepTitle, risks, interventionType }) {
  // [R43-T4] Emit supervisor_intervention event to event_stream
  try {
    if (sessionKey && taskId && (decisionAction === 'warn' || decisionAction === 'block')) {
      emitEvent(sessionKey, taskId, 'supervisor_intervention', {
        phase,
        decisionAction,
        interventionType: interventionType || 'notify',
        riskLevel: riskLevel || 'low',
        reason: reason || '',
        risks: (risks || []).map(r => ({ pattern: r.pattern, level: r.level, label: r.label })),
        stepId: stepId || null,
        stepTitle: stepTitle || null,
      });
    }
  } catch (_evtErr) {
    logger.warn('[R43-T4] Failed to emit supervisor_intervention: ' + _evtErr.message);
  }
  try {
    const db = getSupervisorDb();
    db.prepare(`
      INSERT INTO supervisor_decisions (task_id, session_key, phase, decision_action, risk_level, reason, step_id, step_title, risks_json, intervention_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId || null,
      sessionKey || null,
      phase,
      decisionAction,
      riskLevel || null,
      reason || null,
      stepId || null,
      stepTitle || null,
      JSON.stringify(risks || []),
      interventionType || 'notify'
    );
  } catch (err) {
    logger.warn(`[${ts()}] [supervisor] Failed to persist decision: ${err.message}`);
  }
}

// [R19-T2] Auto-create ticket from supervisor risk detection
function createTicketFromRisk({ taskId, sessionKey, risks, riskLevel, decisionAction, phase }) {
  try {
    const db = getSupervisorDb();
    const PATTERN_TO_TYPE = {
      "financial_operation": "payment",
      "payment": "payment",
      "refund": "refund",
      "data_export": "data_export",
      "user_data_access": "account_change",
      "destructive_shell": "other",
      "credential_exposure": "account_change",
    };
    for (const risk of risks) {
      if (risk.level !== "high" && risk.level !== "medium") continue;
      const ticketType = PATTERN_TO_TYPE[risk.pattern] || "other";
      const title = `[${phase}] ${risk.label}`;
      const description = `Auto-created from supervisor ${phase}. Task: ${taskId}, Decision: ${decisionAction}`;
      db.prepare(`
        INSERT INTO tickets (session_id, task_id, type, title, description, risk_type, risk_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
      `).run(sessionKey, taskId, ticketType, title, description, risk.pattern, risk.level);
      logger.info(`[${ts()}] [R19-T2] ticket created: type=${ticketType} risk=${risk.pattern} task=${taskId}`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [R19-T2] createTicketFromRisk failed: ${err.message}`);
  }
}

/**
 * [R17-T1] Get decision history for /api/admin/supervisor-decisions
 */
export function getDecisionHistory(limit = 50) {
  try {
    const db = getSupervisorDb();
    const rows = db.prepare(`
      SELECT id, task_id, session_key, phase, decision_action, risk_level, reason, step_id, step_title, risks_json, created_at
      FROM supervisor_decisions ORDER BY id DESC LIMIT ?
    `).all(limit);
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      sessionKey: r.session_key,
      phase: r.phase,
      decisionAction: r.decision_action,
      riskLevel: r.risk_level,
      reason: r.reason,
      stepId: r.step_id,
      stepTitle: r.step_title,
      risks: JSON.parse(r.risks_json || '[]'),
      timestamp: r.created_at,
    }));
  } catch (err) {
    logger.warn(`[${ts()}] [supervisor] Failed to read decisions from DB: ${err.message}`);
    return [];
  }
}

// ─── Internal Helpers ───

/**
 * Static risk analysis on plan structure.
 */
function staticRiskAnalysis(plan) {
  const steps = plan?.steps || [];
  const risks = [];
  const seenPatterns = new Set(); // Deduplicate plan-level risks

  steps.forEach((step, idx) => {
    for (const [key, pattern] of Object.entries(RISK_PATTERNS)) {
      if (pattern.detect(step, steps, idx)) {
        // For plan-level patterns (excessive_steps, single_step_complex), only report once
        if (key === 'excessive_steps' || key === 'single_step_complex') {
          if (seenPatterns.has(key)) continue;
          seenPatterns.add(key);
        }
        risks.push({
          pattern: key,
          level: pattern.level,
          label: pattern.label,
          stepId: step.id,
          stepTitle: (step.title || '').substring(0, 80),
        });
      }
    }
  });

  return risks;
}

/**
 * LLM-based plan review (only for high-risk plans when SUPERVISOR_ENABLED=true).
 */
async function llmPlanReview(plan, staticRisks, context) {
  const prompt = `You are a Supervisor reviewing an AI agent's execution plan.

Plan goal: ${plan?.goal || 'unknown'}
Steps (${plan?.steps?.length || 0}):
${(plan?.steps || []).map(s => `  ${s.id}. [${(s.tools || []).join(',')}] ${s.title}`).join('\n')}

Static risks detected:
${staticRisks.map(r => `  - [${r.level}] ${r.label} (step ${r.stepId})`).join('\n')}

Provide a brief review (2-3 sentences) focusing on:
1. Whether the plan adequately addresses the goal
2. Whether the identified risks are genuine concerns
3. One specific suggestion to improve the plan

Respond in plain text, no JSON.`;

  const response = await invokeLLM({
    model: 'deepseek-v4-pro', // [COST-OPT] Lightweight review task, V4Pro (V4Flash disabled)
    messages: [
      { role: 'system', content: 'You are a concise plan reviewer. Keep responses under 100 words.' },
      { role: 'user', content: prompt }
    ]
  });

  return response?.choices?.[0]?.message?.content || null;
}

// ─── [R18-T1] Supervisor Metrics & Decision Outcome Tracking ───

/**
 * [R18-T1] Update the final_outcome of a decision.
 * Called when a task completes or is cancelled.
 * @param {number} decisionId
 * @param {string} outcome - success|failed|user_cancelled|escalated
 * @param {boolean} overrideByUser - whether user overrode the supervisor decision
 */
export function updateDecisionOutcome(decisionId, outcome, overrideByUser = false) {
  try {
    const db = getSupervisorDb();
    db.prepare(`
      UPDATE supervisor_decisions SET final_outcome = ?, override_by_user = ? WHERE id = ?
    `).run(outcome, overrideByUser ? 1 : 0, decisionId);
    logger.info(`[${ts()}] [supervisor] Decision #${decisionId} outcome updated: ${outcome}, override=${overrideByUser}`);
    return true;
  } catch (err) {
    logger.warn(`[${ts()}] [supervisor] Failed to update decision outcome: ${err.message}`);
    return false;
  }
}

/**
 * [R18-T1] Get supervisor metrics for /api/admin/supervisor-metrics.
 * Returns aggregated statistics about supervisor decisions.
 */
export function getSupervisorMetrics() {
  try {
    const db = getSupervisorDb();
    
    // Total decisions
    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM supervisor_decisions').get();
    const total = totalRow?.cnt || 0;
    
    // Action distribution (allow/warn/replan/block)
    const actionRows = db.prepare('SELECT decision_action, COUNT(*) as cnt FROM supervisor_decisions GROUP BY decision_action').all();
    const actionDistribution = {};
    actionRows.forEach(r => { actionDistribution[r.decision_action] = r.cnt; });
    
    // Phase distribution (preflight/step_intervention/final_review)
    const phaseRows = db.prepare('SELECT phase, COUNT(*) as cnt FROM supervisor_decisions GROUP BY phase').all();
    const phaseDistribution = {};
    phaseRows.forEach(r => { phaseDistribution[r.phase] = r.cnt; });
    
    // Risk level distribution
    const riskRows = db.prepare('SELECT risk_level, COUNT(*) as cnt FROM supervisor_decisions GROUP BY risk_level').all();
    const riskDistribution = {};
    riskRows.forEach(r => { riskDistribution[r.risk_level] = r.cnt; });
    
    // Outcome distribution (final_outcome)
    const outcomeRows = db.prepare("SELECT final_outcome, COUNT(*) as cnt FROM supervisor_decisions WHERE final_outcome IS NOT NULL GROUP BY final_outcome").all();
    const outcomeDistribution = {};
    outcomeRows.forEach(r => { outcomeDistribution[r.final_outcome] = r.cnt; });
    
    // Intervention rate (non-allow decisions / total)
    const nonAllow = total - (actionDistribution['allow'] || 0);
    const interventionRate = total > 0 ? Math.round((nonAllow / total) * 10000) / 100 : 0;
    
    // High-risk precision: among high-risk decisions, how many had bad outcomes
    const highRiskTotal = db.prepare("SELECT COUNT(*) as cnt FROM supervisor_decisions WHERE risk_level = 'high'").get()?.cnt || 0;
    const highRiskWithOutcome = db.prepare("SELECT COUNT(*) as cnt FROM supervisor_decisions WHERE risk_level = 'high' AND final_outcome IS NOT NULL").get()?.cnt || 0;
    const highRiskBadOutcome = db.prepare("SELECT COUNT(*) as cnt FROM supervisor_decisions WHERE risk_level = 'high' AND final_outcome IN ('failed', 'escalated')").get()?.cnt || 0;
    const highRiskPrecision = highRiskWithOutcome > 0 ? Math.round((highRiskBadOutcome / highRiskWithOutcome) * 10000) / 100 : null;
    
    // Override rate
    const overrideCount = db.prepare("SELECT COUNT(*) as cnt FROM supervisor_decisions WHERE override_by_user = 1").get()?.cnt || 0;
    const overrideRate = total > 0 ? Math.round((overrideCount / total) * 10000) / 100 : 0;
    
    // Recent decisions (last 10)
    const recentDecisions = db.prepare(`
      SELECT id, task_id, session_key, phase, decision_action, risk_level, reason, final_outcome, override_by_user, escalation_status, created_at
      FROM supervisor_decisions ORDER BY id DESC LIMIT 10
    `).all().map(r => ({
      id: r.id,
      taskId: r.task_id,
      sessionKey: r.session_key,
      phase: r.phase,
      decisionAction: r.decision_action,
      riskLevel: r.risk_level,
      reason: r.reason,
      finalOutcome: r.final_outcome,
      overrideByUser: !!r.override_by_user,
      escalationStatus: r.escalation_status || null,
      timestamp: r.created_at,
    }));
    
    return {
      total,
      interventionRate,
      overrideRate,
      actionDistribution,
      phaseDistribution,
      riskDistribution,
      outcomeDistribution,
      highRisk: {
        total: highRiskTotal,
        withOutcome: highRiskWithOutcome,
        badOutcome: highRiskBadOutcome,
        precision: highRiskPrecision,
      },
      recentDecisions,
    };
  } catch (err) {
    logger.warn(`[${ts()}] [supervisor] Failed to compute metrics: ${err.message}`);
    return { total: 0, error: err.message };
  }
}


// ─── [R18-T4] Task Focus / Todo Anchor ───

/**
 * Create or update a task focus entry.
 * Called when a plan is generated or updated.
 */
export function updateTaskFocus({ sessionId, taskId, title, currentGoal, nextAction, stepCount, stepsCompleted, status }) {
  try {
    const db = getSupervisorDb();
    // Check if entry exists for this session
    const existing = db.prepare('SELECT id FROM task_focus WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
    if (existing) {
      db.prepare(`
        UPDATE task_focus SET
          task_id = COALESCE(?, task_id),
          title = COALESCE(?, title),
          current_goal = COALESCE(?, current_goal),
          next_action = COALESCE(?, next_action),
          step_count = COALESCE(?, step_count),
          steps_completed = COALESCE(?, steps_completed),
          status = COALESCE(?, status),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(taskId, title, currentGoal, nextAction, stepCount, stepsCompleted, status, existing.id);
      logger.info(`[${ts()}] [task-focus] Updated focus #${existing.id} for session ${sessionId}`);
    } else {
      db.prepare(`
        INSERT INTO task_focus (session_id, task_id, title, current_goal, next_action, status, step_count, steps_completed, updated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(sessionId, taskId, title, currentGoal, nextAction, status || 'active', stepCount || 0, stepsCompleted || 0);
      logger.info(`[${ts()}] [task-focus] Created focus for session ${sessionId}: ${title}`);
    }
    return true;
  } catch (err) {
    logger.warn(`[${ts()}] [task-focus] Failed to update: ${err.message}`);
    return false;
  }
}

/**
 * Mark a task focus as completed or failed.
 */
export function completeTaskFocus(sessionId, status = 'completed') {
  try {
    const db = getSupervisorDb();
    db.prepare("UPDATE task_focus SET status = ?, updated_at = datetime('now') WHERE session_id = ? AND status = 'active'")
      .run(status, sessionId);
    logger.info(`[${ts()}] [task-focus] Completed focus for session ${sessionId}: ${status}`);
    return true;
  } catch (err) {
    logger.warn(`[${ts()}] [task-focus] Failed to complete: ${err.message}`);
    return false;
  }
}


// [R19-T4] Task Focus lifecycle: interrupt and resume
export function interruptTaskFocus(sessionId, reason = 'session_timeout') {
  try {
    const db = getSupervisorDb();
    const row = db.prepare("SELECT id, status FROM task_focus WHERE session_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(sessionId);
    if (!row) return false;
    
    db.prepare("UPDATE task_focus SET status = 'interrupted', interrupted_at = datetime('now'), interrupt_reason = ? WHERE id = ?").run(reason, row.id);
    db.prepare("INSERT INTO task_focus_timeline (task_focus_id, from_status, to_status, reason, created_at) VALUES (?, 'active', 'interrupted', ?, datetime('now'))").run(row.id, reason);
    
    logger.info(`[${ts()}] [R19-T4] task_focus #${row.id} interrupted: reason=${reason}`);
    return true;
  } catch (err) {
    logger.warn(`[${ts()}] [R19-T4] interruptTaskFocus failed: ${err.message}`);
    return false;
  }
}

export function resumeTaskFocus(sessionId) {
  try {
    const db = getSupervisorDb();
    const row = db.prepare("SELECT id, status FROM task_focus WHERE session_id = ? AND status = 'interrupted' ORDER BY id DESC LIMIT 1").get(sessionId);
    if (!row) return false;
    
    db.prepare("UPDATE task_focus SET status = 'active', resumed_at = datetime('now') WHERE id = ?").run(row.id);
    db.prepare("INSERT INTO task_focus_timeline (task_focus_id, from_status, to_status, reason, created_at) VALUES (?, 'interrupted', 'active', 'session_resumed', datetime('now'))").run(row.id);
    
    logger.info(`[${ts()}] [R19-T4] task_focus #${row.id} resumed`);
    return true;
  } catch (err) {
    logger.warn(`[${ts()}] [R19-T4] resumeTaskFocus failed: ${err.message}`);
    return false;
  }
}

export function getTaskFocusTimeline(taskFocusId) {
  try {
    const db = getSupervisorDb();
    return db.prepare("SELECT * FROM task_focus_timeline WHERE task_focus_id = ? ORDER BY id ASC").all(taskFocusId);
  } catch (err) {
    return [];
  }
}

// [R20-T1] Get active task focus for context injection
export function getActiveTaskFocus(sessionId) {
  try {
    const db = getSupervisorDb();
    const row = db.prepare(`
      SELECT id, task_id, title, current_goal, next_action, status, 
             step_count, steps_completed, updated_at, interrupt_reason
      FROM task_focus 
      WHERE session_id = ? AND status IN ('active', 'interrupted')
      ORDER BY id DESC LIMIT 1
    `).get(sessionId);
    return row || null;
  } catch (err) {
    return null;
  }
}

// [R20-T1] Format task focus as context block for LLM injection
export function formatTaskFocusForContext(focus) {
  if (!focus) return null;
  const progress = focus.step_count > 0 
    ? `${focus.steps_completed}/${focus.step_count} steps (${Math.round(focus.steps_completed / focus.step_count * 100)}%)`
    : 'no steps tracked';
  const lines = [
    `Status: ${focus.status}${focus.status === 'interrupted' ? ` (reason: ${focus.interrupt_reason || 'unknown'})` : ''}`,
    `Goal: ${focus.current_goal || 'not set'}`,
    `Next Action: ${focus.next_action || 'not set'}`,
    `Progress: ${progress}`,
    `Last Updated: ${focus.updated_at || 'unknown'}`,
  ];
  return `[TASK_FOCUS — background task anchor, lower priority than latest user message]\nIf this task focus conflicts with the latest user message, treat it as stale background and answer the latest user message first.\n${lines.join('\n')}\n[/TASK_FOCUS]`;
}

// [R20-T5] Update escalation status for a supervisor decision
export function updateEscalationStatus(decisionId, status) {
  try {
    const db = getSupervisorDb();
    db.prepare("UPDATE supervisor_decisions SET escalation_status = ? WHERE id = ?").run(status, decisionId);
    logger.info(`[supervisor] Decision ${decisionId} escalation updated to: ${status}`);
    return true;
  } catch (err) {
    logger.warn(`[supervisor] Failed to update escalation: ${err.message}`);
    return false;
  }
}

// [R21-T2] Enhanced escalation with audit logging
export function updateEscalationWithAudit(decisionId, status, action, operatorId, note) {
  try {
    const db = getSupervisorDb();
    db.prepare("UPDATE supervisor_decisions SET escalation_status = ? WHERE id = ?").run(status, decisionId);
    db.prepare("INSERT INTO audit_logs (userId, action, target, details, createdAt) VALUES (?, ?, ?, ?, datetime('now'))").run(
      operatorId || "admin",
      action,
      "supervisor_decision:" + decisionId,
      JSON.stringify({ status, note: note || "" })
    );
    return true;
  } catch (err) {
    logger.warn("[supervisor] updateEscalationWithAudit failed: " + err.message);
    return false;
  }
}

export function getEscalationAuditLog(decisionId) {
  try {
    const db = getSupervisorDb();
    if (decisionId) {
      return db.prepare("SELECT * FROM audit_logs WHERE target = ? ORDER BY id DESC").all("supervisor_decision:" + decisionId);
    }
    return db.prepare("SELECT * FROM audit_logs WHERE target LIKE ? ORDER BY id DESC LIMIT 50").all("supervisor_decision:%");
  } catch (err) {
    logger.warn("[supervisor] getEscalationAuditLog failed: " + err.message);
    return [];
  }
}

// [R21-T3] Dashboard Overview KPI aggregation
export function getDashboardOverview() {
  const db = getSupervisorDb();
  const now = Date.now();
  
  // Supervisor decisions stats
  const decisionStats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN decision_action != 'allow' THEN 1 ELSE 0 END) as interventions, SUM(CASE WHEN escalation_status IS NOT NULL AND escalation_status != '' THEN 1 ELSE 0 END) as escalated FROM supervisor_decisions").get();
  
  // Hint adoption stats
  const hintStats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN adopted = 1 THEN 1 ELSE 0 END) as adopted, SUM(CASE WHEN is_seed = 0 THEN 1 ELSE 0 END) as realTotal, SUM(CASE WHEN is_seed = 0 AND adopted = 1 THEN 1 ELSE 0 END) as realAdopted FROM hint_adoptions").get();
  
  // Browser evidence stats
  const evidenceStats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN evidence_type = 'screenshot' THEN 1 ELSE 0 END) as screenshots, SUM(CASE WHEN evidence_type != 'screenshot' THEN 1 ELSE 0 END) as textExtracts FROM browser_evidence").get();
  
  // Task focus stats
  const focusStats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) as interrupted FROM task_focus").get();
  
  // Tickets stats
  const ticketStats = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved FROM tickets").get();
  
  // Timeline events (last 24h)
  const recentTimeline = db.prepare("SELECT COUNT(*) as count FROM task_focus_timeline WHERE created_at > datetime('now', '-24 hours')").get();
  
  // Audit logs (last 24h)
  const recentAudit = db.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE target LIKE 'supervisor_decision:%' AND createdAt > datetime('now', '-24 hours')").get();
  
  return {
    supervisor: {
      totalDecisions: decisionStats?.total || 0,
      interventions: decisionStats?.interventions || 0,
      escalated: decisionStats?.escalated || 0,
      interventionRate: decisionStats?.total > 0 ? ((decisionStats.interventions / decisionStats.total) * 100).toFixed(1) : "0.0"
    },
    hints: {
      total: hintStats?.total || 0,
      adopted: hintStats?.adopted || 0,
      adoptionRate: hintStats?.total > 0 ? ((hintStats.adopted / hintStats.total) * 100).toFixed(1) : "0.0",
      realTotal: hintStats?.realTotal || 0,
      realAdopted: hintStats?.realAdopted || 0,
      realAdoptionRate: hintStats?.realTotal > 0 ? ((hintStats.realAdopted / hintStats.realTotal) * 100).toFixed(1) : "0.0"
    },
    evidence: {
      total: evidenceStats?.total || 0,
      screenshots: evidenceStats?.screenshots || 0,
      textExtracts: evidenceStats?.textExtracts || 0
    },
    focus: {
      total: focusStats?.total || 0,
      active: focusStats?.active || 0,
      completed: focusStats?.completed || 0,
      interrupted: focusStats?.interrupted || 0
    },
    tickets: {
      total: ticketStats?.total || 0,
      open: ticketStats?.open || 0,
      resolved: ticketStats?.resolved || 0
    },
    activity: {
      timelineEvents24h: recentTimeline?.count || 0,
      auditActions24h: recentAudit?.count || 0
    },
    timestamp: new Date().toISOString()
  };
}
