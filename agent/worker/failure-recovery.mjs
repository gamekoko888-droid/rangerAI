// failure-recovery.mjs — Iter-66 v2: Standardized failure taxonomy and recovery strategy module
// v2.0 — 2026-04-26: Enhanced with Gateway-specific types, actionable recovery, circuit breaker
import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

// ─── Taxonomy ──────────────────────────────────────────────
export const FAILURE_TYPE = Object.freeze({
  // Network / connectivity
  NETWORK_ERROR:              'network_error',
  TIMEOUT:                    'timeout',
  // API errors
  API_RATE_LIMIT:             'api_rate_limit',
  API_AUTH_ERROR:              'api_auth_error',
  API_BAD_REQUEST:             'api_bad_request',
  API_SERVER_ERROR:            'api_server_error',
  // Gateway-specific (Iter-66 v2)
  GATEWAY_MODEL_FAILED:       'gateway_model_failed',       // deepseek-v4-pro candidate_failed
  GATEWAY_REASONING_ERROR:    'gateway_reasoning_error',     // reasoning_content 400 error
  GATEWAY_LANE_BUSY:          'gateway_lane_busy',           // lane wait exceeded / 429
  GATEWAY_SESSION_CORRUPT:    'gateway_session_corrupt',     // session state corruption
  GATEWAY_ABORTED:            'gateway_aborted',             // Gateway aborted the run
  // Browser
  BROWSER_ELEMENT_NOT_FOUND:  'browser_element_not_found',
  BROWSER_PAGE_CRASH:         'browser_page_crash',
  BROWSER_NAVIGATION_FAILED:  'browser_navigation_failed',
  BROWSER_CONTENT_BLOCKED:    'browser_content_blocked',
  // Tool
  TOOL_NOT_AVAILABLE:         'tool_not_available',
  TOOL_EXECUTION_ERROR:       'tool_execution_error',
  EXECUTOR_ACTION_FAILED:     'executor_action_failed',
  // LLM / Planner
  LLM_CALL_FAILED:            'llm_call_failed',
  LLM_CONTEXT_OVERFLOW:       'llm_context_overflow',        // Iter-66 v2
  PLANNER_FAILED:             'planner_failed',
  UNKNOWN_ERROR:              'unknown_error',
});

export const RECOVERY_ACTION = Object.freeze({
  RETRY_IMMEDIATE:    'retry_immediate',
  RETRY_DELAYED:      'retry_delayed',
  FALLBACK_MODEL:     'fallback_model',
  FALLBACK_TOOL:      'fallback_tool',
  REPLAN:             'replan',
  SKIP_STEP:          'skip_step',
  RESET_SESSION:      'reset_session',       // Iter-66 v2: clear Gateway session state
  ASK_HUMAN:          'ask_human',
  ABORT:              'abort',
});

export const SEVERITY = Object.freeze({
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
});

// ─── Classification Logic ──────────────────────────────────
export function classifyFailure(error, tool = '') {
  const msg = typeof error === 'string' ? error : (error?.message || error?.toString() || '');
  const msgLower = msg.toLowerCase();

  // ── Gateway-specific patterns (check FIRST, before generic patterns) ──
  if (/reasoning_content|reasoning.*required|thinking.*mode.*must/i.test(msg)) {
    return FAILURE_TYPE.GATEWAY_REASONING_ERROR;
  }
  if (/candidate_failed|model.*failed.*gateway|deepseek.*failed/i.test(msg)) {
    return FAILURE_TYPE.GATEWAY_MODEL_FAILED;
  }
  if (/lane.*wait.*exceeded|lane.*busy|lane.*timeout/i.test(msg)) {
    return FAILURE_TYPE.GATEWAY_LANE_BUSY;
  }
  if (/session.*corrupt|session.*invalid|session.*not.*found/i.test(msg)) {
    return FAILURE_TYPE.GATEWAY_SESSION_CORRUPT;
  }
  if (/gateway.*abort|run.*aborted|state.*aborted/i.test(msg)) {
    return FAILURE_TYPE.GATEWAY_ABORTED;
  }

  // ── LLM context overflow ──
  if (/context.*length|max.*token|token.*limit|context.*window|too.*long/i.test(msgLower)) {
    return FAILURE_TYPE.LLM_CONTEXT_OVERFLOW;
  }

  // ── Rate limit ──
  if (/rate.?limit|too.?many.?requests|429|503.*overloaded/i.test(msgLower)) {
    return FAILURE_TYPE.API_RATE_LIMIT;
  }

  // ── Auth ──
  if (/unauthorized|401|forbidden|403|auth.?required|invalid.*token|not.?authenticated/i.test(msgLower)) {
    return FAILURE_TYPE.API_AUTH_ERROR;
  }

  // ── Bad request ──
  if (/400|bad.?request|invalid.?parameter|schema.?error/i.test(msgLower)) {
    return FAILURE_TYPE.API_BAD_REQUEST;
  }

  // ── Server error ──
  if (/500|502|503|internal.?server.?error|service.?unavailable/i.test(msgLower)) {
    return FAILURE_TYPE.API_SERVER_ERROR;
  }

  // ── Timeout ──
  if (/timeout|timed.?out|exceeded.*time|deadline.?exceeded/i.test(msgLower)) {
    return FAILURE_TYPE.TIMEOUT;
  }

  // ── Browser-specific ──
  if (tool === 'browser' || /browser|browser_navigate|playwright|puppeteer/i.test(tool)) {
    if (/element.?not.?found|selector.*not.*found|no.?element/i.test(msgLower)) {
      return FAILURE_TYPE.BROWSER_ELEMENT_NOT_FOUND;
    }
    if (/page.?crash|target.?closed|browser.?crash|disconnected/i.test(msgLower)) {
      return FAILURE_TYPE.BROWSER_PAGE_CRASH;
    }
    if (/navigation.*fail|net::err|dns.*fail|cannot.*reach|refused/i.test(msgLower)) {
      return FAILURE_TYPE.BROWSER_NAVIGATION_FAILED;
    }
    if (/content.?blocked|access.?denied|cloudflare|captcha/i.test(msgLower)) {
      return FAILURE_TYPE.BROWSER_CONTENT_BLOCKED;
    }
  }

  // ── Network ──
  if (/network.?error|econnrefused|econnreset|etimedout|enotfound|dns|socket.*error|fetch.*failed/i.test(msgLower)) {
    return FAILURE_TYPE.NETWORK_ERROR;
  }

  // ── Tool unavailable ──
  if (/tool.?not.?found|tool.?not.?available|unknown.*tool|disabled/i.test(msgLower)) {
    return FAILURE_TYPE.TOOL_NOT_AVAILABLE;
  }

  // ── LLM failures ──
  if (/model.*fail|llm.*error/i.test(msgLower)) {
    return FAILURE_TYPE.LLM_CALL_FAILED;
  }

  // ── Generic tool error ──
  if (tool && tool !== 'browser') {
    return FAILURE_TYPE.TOOL_EXECUTION_ERROR;
  }

  return FAILURE_TYPE.UNKNOWN_ERROR;
}

// ─── Recovery Strategy ─────────────────────────────────────
export function getRecoveryStrategy(failureType, context = {}) {
  const attempts = context.attempts || 0;
  const lastRecovery = context.lastRecovery || '';

  switch (failureType) {
    // ── Gateway-specific (Iter-66 v2) ──
    case FAILURE_TYPE.GATEWAY_REASONING_ERROR:
      // reasoning_content error: retry won't help, need to fix the request
      return {
        action: RECOVERY_ACTION.RETRY_DELAYED,
        severity: SEVERITY.HIGH,
        delayMs: 2000,
        retryable: true,
        hint: 'Ensure reasoning_content="" for all assistant messages with tool_calls',
      };
    case FAILURE_TYPE.GATEWAY_MODEL_FAILED:
      return {
        action: attempts < 1 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.FALLBACK_MODEL,
        severity: SEVERITY.MEDIUM,
        delayMs: 3000,
        retryable: true,
        hint: 'Gateway model candidate failed, will try fallback model',
      };
    case FAILURE_TYPE.GATEWAY_LANE_BUSY:
      return {
        action: attempts < 3 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.FALLBACK_MODEL,
        severity: SEVERITY.LOW,
        delayMs: Math.min(3000 * Math.pow(2, attempts), 30000),
        retryable: true,
        hint: 'Gateway lane congested, exponential backoff',
      };
    case FAILURE_TYPE.GATEWAY_SESSION_CORRUPT:
      return {
        action: RECOVERY_ACTION.RESET_SESSION,
        severity: SEVERITY.HIGH,
        delayMs: 1000,
        retryable: true,
        hint: 'Session state corrupted, need to rebuild session',
      };
    case FAILURE_TYPE.GATEWAY_ABORTED:
      return {
        action: attempts < 2 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.MEDIUM,
        delayMs: 2000,
        retryable: true,
        hint: 'Gateway aborted the run, cooldown then retry',
      };

    // ── LLM context overflow ──
    case FAILURE_TYPE.LLM_CONTEXT_OVERFLOW:
      return {
        action: RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.HIGH,
        delayMs: 0,
        retryable: false,
        hint: 'Context window exceeded, need to compress or replan with shorter context',
      };

    // ── Standard patterns ──
    case FAILURE_TYPE.API_RATE_LIMIT:
      return {
        action: attempts < 3 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.FALLBACK_MODEL,
        severity: SEVERITY.LOW,
        delayMs: Math.min(2000 * Math.pow(2, attempts), 30000),
        retryable: true,
      };
    case FAILURE_TYPE.API_SERVER_ERROR:
      return {
        action: attempts < 2 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.MEDIUM,
        delayMs: Math.min(1000 * Math.pow(2, attempts), 8000),
        retryable: true,
      };
    case FAILURE_TYPE.TIMEOUT:
    case FAILURE_TYPE.NETWORK_ERROR:
      return {
        action: attempts < 3 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.SKIP_STEP,
        severity: SEVERITY.MEDIUM,
        delayMs: Math.min(1500 * Math.pow(2, attempts), 12000),
        retryable: true,
      };
    case FAILURE_TYPE.API_AUTH_ERROR:
      return {
        action: RECOVERY_ACTION.ASK_HUMAN,
        severity: SEVERITY.CRITICAL,
        delayMs: 0,
        retryable: false,
      };
    case FAILURE_TYPE.API_BAD_REQUEST:
      return {
        action: RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.MEDIUM,
        delayMs: 0,
        retryable: false,
      };
    case FAILURE_TYPE.BROWSER_ELEMENT_NOT_FOUND:
      return {
        action: attempts < 1 ? RECOVERY_ACTION.RETRY_IMMEDIATE : RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.LOW,
        delayMs: 0,
        retryable: true,
      };
    case FAILURE_TYPE.BROWSER_PAGE_CRASH:
    case FAILURE_TYPE.BROWSER_NAVIGATION_FAILED:
      return {
        action: attempts < 2 ? RECOVERY_ACTION.RETRY_DELAYED : RECOVERY_ACTION.SKIP_STEP,
        severity: SEVERITY.MEDIUM,
        delayMs: 3000,
        retryable: true,
      };
    case FAILURE_TYPE.BROWSER_CONTENT_BLOCKED:
      return {
        action: RECOVERY_ACTION.SKIP_STEP,
        severity: SEVERITY.HIGH,
        delayMs: 0,
        retryable: false,
      };
    case FAILURE_TYPE.TOOL_NOT_AVAILABLE:
      return {
        action: lastRecovery === RECOVERY_ACTION.REPLAN ? RECOVERY_ACTION.SKIP_STEP : RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.HIGH,
        delayMs: 0,
        retryable: false,
      };
    case FAILURE_TYPE.TOOL_EXECUTION_ERROR:
      return {
        action: attempts < 2 ? RECOVERY_ACTION.RETRY_IMMEDIATE : RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.MEDIUM,
        delayMs: 0,
        retryable: true,
      };
    case FAILURE_TYPE.LLM_CALL_FAILED:
      return {
        action: attempts < 2 ? RECOVERY_ACTION.FALLBACK_MODEL : RECOVERY_ACTION.ASK_HUMAN,
        severity: SEVERITY.HIGH,
        delayMs: 0,
        retryable: true,
      };
    case FAILURE_TYPE.PLANNER_FAILED:
      return {
        action: RECOVERY_ACTION.ASK_HUMAN,
        severity: SEVERITY.CRITICAL,
        delayMs: 0,
        retryable: false,
      };
    case FAILURE_TYPE.UNKNOWN_ERROR:
    default:
      return {
        action: attempts < 1 ? RECOVERY_ACTION.RETRY_IMMEDIATE : RECOVERY_ACTION.REPLAN,
        severity: SEVERITY.MEDIUM,
        delayMs: 0,
        retryable: true,
      };
  }
}

// ─── Unified Recovery Decision ─────────────────────────────
export function diagnoseFailure(error, tool = '', context = {}) {
  const errorMsg = typeof error === 'string' ? error : (error?.message || error?.toString() || '');
  const failureType = classifyFailure(error, tool);
  const recovery = getRecoveryStrategy(failureType, context);
  logger.info(`[${ts()}] [Iter-66] Failure diagnosed: type=${failureType} tool=${tool} recovery=${recovery.action} severity=${recovery.severity} hint=${recovery.hint || 'none'}`);
  return { failureType, recovery, errorMsg };
}

// ─── Attempt Tracker ───────────────────────────────────────
const _attemptTracker = new Map();

export function recordAttempt(taskId, stepId) {
  const key = `${taskId}:${stepId}`;
  const count = (_attemptTracker.get(key) || 0) + 1;
  _attemptTracker.set(key, count);
  return count;
}

export function getAttemptCount(taskId, stepId) {
  return _attemptTracker.get(`${taskId}:${stepId}`) || 0;
}

export function resetAttempts(taskId, stepId) {
  _attemptTracker.delete(`${taskId}:${stepId}`);
}

export function resetAllAttempts(taskId) {
  for (const key of _attemptTracker.keys()) {
    if (key.startsWith(`${taskId}:`)) _attemptTracker.delete(key);
  }
}

// ─── Circuit Breaker (Iter-66 v2) ──────────────────────────
// Prevents cascading failures by tracking error rates per tool/service
const _circuitBreakers = new Map(); // Map<service, { failures, lastFailure, state }>
const CB_THRESHOLD = 5;     // failures before opening circuit
const CB_COOLDOWN_MS = 30000; // 30s cooldown before half-open

export function checkCircuitBreaker(service) {
  const cb = _circuitBreakers.get(service);
  if (!cb) return { allowed: true, state: 'closed' };
  if (cb.state === 'open') {
    if (Date.now() - cb.lastFailure > CB_COOLDOWN_MS) {
      cb.state = 'half-open';
      logger.info(`[${ts()}] [Iter-66-CB] Circuit half-open for ${service} (cooldown expired)`);
      return { allowed: true, state: 'half-open' };
    }
    return { allowed: false, state: 'open', retryAfterMs: CB_COOLDOWN_MS - (Date.now() - cb.lastFailure) };
  }
  return { allowed: true, state: cb.state };
}

export function recordCircuitFailure(service) {
  let cb = _circuitBreakers.get(service);
  if (!cb) {
    cb = { failures: 0, lastFailure: 0, state: 'closed' };
    _circuitBreakers.set(service, cb);
  }
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= CB_THRESHOLD) {
    cb.state = 'open';
    logger.info(`[${ts()}] [Iter-66-CB] Circuit OPEN for ${service} (${cb.failures} failures)`);
  }
  return cb;
}

export function recordCircuitSuccess(service) {
  const cb = _circuitBreakers.get(service);
  if (cb) {
    cb.failures = 0;
    cb.state = 'closed';
    logger.info(`[${ts()}] [Iter-66-CB] Circuit CLOSED for ${service} (success)`);
  }
}

export function getCircuitState(service) {
  const cb = _circuitBreakers.get(service);
  return cb ? { ...cb } : { failures: 0, lastFailure: 0, state: 'closed' };
}

// ─── Recovery Executor Helper (Iter-66 v2) ─────────────────
// Provides a helper that the executor can call to actually perform the recovery action
export async function executeRecovery(diagnosis, context = {}) {
  const { recovery, failureType } = diagnosis;
  const { taskId, stepId, sendEvent, msgId } = context;

  switch (recovery.action) {
    case RECOVERY_ACTION.RETRY_DELAYED:
      if (recovery.delayMs > 0) {
        logger.info(`[${ts()}] [Iter-66-EXEC] Waiting ${recovery.delayMs}ms before retry (type=${failureType})`);
        await new Promise(r => setTimeout(r, recovery.delayMs));
      }
      return { shouldRetry: true, shouldReplan: false, shouldSkip: false };

    case RECOVERY_ACTION.RETRY_IMMEDIATE:
      return { shouldRetry: true, shouldReplan: false, shouldSkip: false };

    case RECOVERY_ACTION.FALLBACK_MODEL:
      logger.info(`[${ts()}] [Iter-66-EXEC] Suggesting fallback model (type=${failureType})`);
      return { shouldRetry: false, shouldReplan: true, shouldSkip: false, fallbackModel: true };

    case RECOVERY_ACTION.REPLAN:
      logger.info(`[${ts()}] [Iter-66-EXEC] Triggering replan (type=${failureType})`);
      return { shouldRetry: false, shouldReplan: true, shouldSkip: false };

    case RECOVERY_ACTION.SKIP_STEP:
      logger.info(`[${ts()}] [Iter-66-EXEC] Skipping step (type=${failureType})`);
      if (sendEvent && msgId) {
        sendEvent(msgId, {
          type: 'notify',
          content: `⚠️ 步骤跳过: ${failureType}`,
          category: 'warning',
        });
      }
      return { shouldRetry: false, shouldReplan: false, shouldSkip: true };

    case RECOVERY_ACTION.RESET_SESSION:
      logger.info(`[${ts()}] [Iter-66-EXEC] Session reset needed (type=${failureType})`);
      return { shouldRetry: true, shouldReplan: false, shouldSkip: false, resetSession: true };

    case RECOVERY_ACTION.ASK_HUMAN:
      logger.info(`[${ts()}] [Iter-66-EXEC] Human intervention needed (type=${failureType})`);
      if (sendEvent && msgId) {
        sendEvent(msgId, {
          type: 'notify',
          content: `🆘 需要人工介入: ${diagnosis.errorMsg.substring(0, 100)}`,
          category: 'error',
        });
      }
      return { shouldRetry: false, shouldReplan: false, shouldSkip: false, needsHuman: true };

    case RECOVERY_ACTION.ABORT:
      logger.info(`[${ts()}] [Iter-66-EXEC] Aborting task (type=${failureType})`);
      return { shouldRetry: false, shouldReplan: false, shouldSkip: false, abort: true };

    default:
      return { shouldRetry: false, shouldReplan: true, shouldSkip: false };
  }
}
