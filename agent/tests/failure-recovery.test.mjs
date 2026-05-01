// failure-recovery.test.mjs — Iter-66: Failure taxonomy and recovery unit tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

let _mod = null;
async function mod() {
  if (!_mod) _mod = await import('../worker/failure-recovery.mjs');
  return _mod;
}

describe('FAILURE_TYPE constants', () => {
  it('exports all failure types', async () => {
    const m = await mod();
    assert.ok(Object.keys(m.FAILURE_TYPE).length >= 10);
    assert.equal(m.FAILURE_TYPE.NETWORK_ERROR, 'network_error');
    assert.equal(m.FAILURE_TYPE.API_RATE_LIMIT, 'api_rate_limit');
    assert.equal(m.FAILURE_TYPE.TIMEOUT, 'timeout');
  });
});

describe('classifyFailure', () => {
  it('detects rate limit errors', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Rate limit exceeded'), m.FAILURE_TYPE.API_RATE_LIMIT);
    assert.equal(m.classifyFailure('HTTP 429 Too Many Requests'), m.FAILURE_TYPE.API_RATE_LIMIT);
    assert.equal(m.classifyFailure('503 Service overloaded'), m.FAILURE_TYPE.API_RATE_LIMIT);
  });
  it('detects auth errors', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('401 Unauthorized'), m.FAILURE_TYPE.API_AUTH_ERROR);
    assert.equal(m.classifyFailure('Forbidden: 403'), m.FAILURE_TYPE.API_AUTH_ERROR);
  });
  it('detects timeout errors', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Request timed out'), m.FAILURE_TYPE.TIMEOUT);
    assert.equal(m.classifyFailure('Deadline exceeded'), m.FAILURE_TYPE.TIMEOUT);
  });
  it('detects network errors', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('ECONNREFUSED'), m.FAILURE_TYPE.NETWORK_ERROR);
    assert.equal(m.classifyFailure('Network error'), m.FAILURE_TYPE.NETWORK_ERROR);
  });
  it('detects browser element not found', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Element not found', 'browser'), m.FAILURE_TYPE.BROWSER_ELEMENT_NOT_FOUND);
  });
  it('detects browser page crash', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Target closed unexpectedly', 'browser'), m.FAILURE_TYPE.BROWSER_PAGE_CRASH);
  });
  it('detects content blocked', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Content blocked by Cloudflare', 'browser'), m.FAILURE_TYPE.BROWSER_CONTENT_BLOCKED);
  });
  it('detects tool not available', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Tool not found: old_tool'), m.FAILURE_TYPE.TOOL_NOT_AVAILABLE);
  });
  it('defaults to unknown for unrecognized errors', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Something weird happened'), m.FAILURE_TYPE.UNKNOWN_ERROR);
  });
  it('handles Error objects', async () => {
    const m = await mod();
    const err = new Error('429 Too Many Requests');
    assert.equal(m.classifyFailure(err), m.FAILURE_TYPE.API_RATE_LIMIT);
  });
});

describe('getRecoveryStrategy', () => {
  it('rate limit: retry_delayed then fallback_model after 3 attempts', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.API_RATE_LIMIT, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    assert.ok(s.retryable);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.API_RATE_LIMIT, { attempts: 4 });
    assert.equal(s.action, m.RECOVERY_ACTION.FALLBACK_MODEL);
  });
  it('auth error: ask_human, not retryable', async () => {
    const m = await mod();
    const s = m.getRecoveryStrategy(m.FAILURE_TYPE.API_AUTH_ERROR);
    assert.equal(s.action, m.RECOVERY_ACTION.ASK_HUMAN);
    assert.equal(s.severity, 'critical');
    assert.equal(s.retryable, false);
  });
  it('timeout: retry_delayed then skip_step', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.TIMEOUT, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    assert.ok(s.delayMs > 0);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.TIMEOUT, { attempts: 5 });
    assert.equal(s.action, m.RECOVERY_ACTION.SKIP_STEP);
  });
  it('content blocked: skip_step, not retryable', async () => {
    const m = await mod();
    const s = m.getRecoveryStrategy(m.FAILURE_TYPE.BROWSER_CONTENT_BLOCKED);
    assert.equal(s.action, m.RECOVERY_ACTION.SKIP_STEP);
    assert.equal(s.retryable, false);
  });
  it('unknown: retry_immediate then replan', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.UNKNOWN_ERROR, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_IMMEDIATE);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.UNKNOWN_ERROR, { attempts: 2 });
    assert.equal(s.action, m.RECOVERY_ACTION.REPLAN);
  });
});

describe('diagnoseFailure', () => {
  it('returns structured diagnosis', async () => {
    const m = await mod();
    const d = m.diagnoseFailure('429 Rate limited', 'search', { attempts: 1 });
    assert.equal(d.failureType, m.FAILURE_TYPE.API_RATE_LIMIT);
    assert.equal(d.recovery.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    assert.ok(d.recovery.delayMs > 0);
    assert.equal(d.errorMsg, '429 Rate limited');
  });
});

describe('attempt tracker', () => {
  it('tracks per-step attempts', async () => {
    const m = await mod();
    m.resetAllAttempts('test-task');
    assert.equal(m.recordAttempt('test-task', 'step1'), 1);
    assert.equal(m.recordAttempt('test-task', 'step1'), 2);
    assert.equal(m.getAttemptCount('test-task', 'step1'), 2);
    assert.equal(m.getAttemptCount('test-task', 'step2'), 0);
    m.resetAttempts('test-task', 'step1');
    assert.equal(m.getAttemptCount('test-task', 'step1'), 0);
  });
  it('resetAllAttempts clears all steps for a task', async () => {
    const m = await mod();
    m.resetAllAttempts('test-task2');
    m.recordAttempt('test-task2', 'step_a');
    m.recordAttempt('test-task2', 'step_b');
    assert.equal(m.getAttemptCount('test-task2', 'step_a'), 1);
    assert.equal(m.getAttemptCount('test-task2', 'step_b'), 1);
    m.resetAllAttempts('test-task2');
    assert.equal(m.getAttemptCount('test-task2', 'step_a'), 0);
    assert.equal(m.getAttemptCount('test-task2', 'step_b'), 0);
  });
});

describe('classifyFailure — additional types', () => {
  it('detects LLM call failures', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('Model inference failed'), m.FAILURE_TYPE.LLM_CALL_FAILED);
    // Iter-66 v2: token/context overflow classifies as LLM_CONTEXT_OVERFLOW, not LLM_CALL_FAILED
    assert.equal(m.classifyFailure('Token limit exceeded: max 128k'), m.FAILURE_TYPE.LLM_CONTEXT_OVERFLOW);
    assert.equal(m.classifyFailure('Context window too long'), m.FAILURE_TYPE.LLM_CONTEXT_OVERFLOW);
  });
  it('detects executor action failures with tool context', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure(new Error('execution error in worker'), 'exec'), m.FAILURE_TYPE.TOOL_EXECUTION_ERROR);
  });
  it('falls through to UNKNOWN_ERROR for null/empty inputs', async () => {
    const m = await mod();
    // Empty string should fall through to UNKNOWN (no patterns match)
    assert.equal(m.classifyFailure(''), m.FAILURE_TYPE.UNKNOWN_ERROR);
  });
});

describe('getRecoveryStrategy — additional escalation', () => {
  it('server error: retry_delayed then replan after 2 attempts', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.API_SERVER_ERROR, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    assert.ok(s.delayMs > 0);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.API_SERVER_ERROR, { attempts: 3 });
    assert.equal(s.action, m.RECOVERY_ACTION.REPLAN);
  });
  it('tool execution error: retry_immediate then replan', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.TOOL_EXECUTION_ERROR, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_IMMEDIATE);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.TOOL_EXECUTION_ERROR, { attempts: 3 });
    assert.equal(s.action, m.RECOVERY_ACTION.REPLAN);
  });
  it('planner failure: always ask_human', async () => {
    const m = await mod();
    const s = m.getRecoveryStrategy(m.FAILURE_TYPE.PLANNER_FAILED, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.ASK_HUMAN);
    assert.equal(s.severity, 'critical');
  });
  it('LLM failure: fallback_model then ask_human', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.LLM_CALL_FAILED, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.FALLBACK_MODEL);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.LLM_CALL_FAILED, { attempts: 3 });
    assert.equal(s.action, m.RECOVERY_ACTION.ASK_HUMAN);
  });
});

describe('delayMs calculation', () => {
  it('rate limit exponential backoff with 30s cap', async () => {
    const m = await mod();
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.API_RATE_LIMIT, { attempts: 0 }).delayMs, 2000);
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.API_RATE_LIMIT, { attempts: 1 }).delayMs, 4000);
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.API_RATE_LIMIT, { attempts: 2 }).delayMs, 8000);
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.API_RATE_LIMIT, { attempts: 5 }).delayMs, 30000);
  });
  it('timeout backoff with 12s cap', async () => {
    const m = await mod();
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.TIMEOUT, { attempts: 0 }).delayMs, 1500);
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.TIMEOUT, { attempts: 1 }).delayMs, 3000);
    assert.equal(m.getRecoveryStrategy(m.FAILURE_TYPE.TIMEOUT, { attempts: 4 }).delayMs, 12000);
  });
});

describe('SEVERITY constants', () => {
  it('exports all severity levels', async () => {
    const m = await mod();
    assert.equal(m.SEVERITY.LOW, 'low');
    assert.equal(m.SEVERITY.MEDIUM, 'medium');
    assert.equal(m.SEVERITY.HIGH, 'high');
    assert.equal(m.SEVERITY.CRITICAL, 'critical');
  });
});

describe('RECOVERY_ACTION constants', () => {
  it('exports all recovery actions', async () => {
    const m = await mod();
    assert.equal(m.RECOVERY_ACTION.RETRY_IMMEDIATE, 'retry_immediate');
    assert.equal(m.RECOVERY_ACTION.FALLBACK_MODEL, 'fallback_model');
    assert.equal(m.RECOVERY_ACTION.REPLAN, 'replan');
    assert.equal(m.RECOVERY_ACTION.ASK_HUMAN, 'ask_human');
    assert.equal(m.RECOVERY_ACTION.ABORT, 'abort');
    assert.equal(m.RECOVERY_ACTION.RESET_SESSION, 'reset_session');
  });
});

// ─── Iter-66 v2: Gateway-specific classification ─────────────
describe('classifyFailure — Gateway-specific (Iter-66 v2)', () => {
  it('detects gateway reasoning error (reasoning_content)', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('reasoning_content is not allowed'), m.FAILURE_TYPE.GATEWAY_REASONING_ERROR);
    assert.equal(m.classifyFailure('Reasoning is required but not configured'), m.FAILURE_TYPE.GATEWAY_REASONING_ERROR);
    assert.equal(m.classifyFailure('thinking mode must be enabled'), m.FAILURE_TYPE.GATEWAY_REASONING_ERROR);
  });
  it('detects gateway model failed (candidate_failed)', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('deepseek-v4-pro candidate_failed'), m.FAILURE_TYPE.GATEWAY_MODEL_FAILED);
    assert.equal(m.classifyFailure('model inference failed at gateway'), m.FAILURE_TYPE.GATEWAY_MODEL_FAILED);
  });
  it('detects gateway lane busy', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('lane wait exceeded for slot 3'), m.FAILURE_TYPE.GATEWAY_LANE_BUSY);
    assert.equal(m.classifyFailure('lane busy, try again later'), m.FAILURE_TYPE.GATEWAY_LANE_BUSY);
  });
  it('detects gateway session corrupt', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('session state corrupt'), m.FAILURE_TYPE.GATEWAY_SESSION_CORRUPT);
    assert.equal(m.classifyFailure('session not found in gateway'), m.FAILURE_TYPE.GATEWAY_SESSION_CORRUPT);
  });
  it('detects gateway aborted', async () => {
    const m = await mod();
    assert.equal(m.classifyFailure('gateway aborted the run'), m.FAILURE_TYPE.GATEWAY_ABORTED);
    assert.equal(m.classifyFailure('state aborted unexpectedly'), m.FAILURE_TYPE.GATEWAY_ABORTED);
  });
});

// ─── Iter-66 v2: Gateway-specific recovery strategies ────────
describe('getRecoveryStrategy — Gateway-specific (Iter-66 v2)', () => {
  it('GATEWAY_REASONING_ERROR: retry_delayed with hint', async () => {
    const m = await mod();
    const s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_REASONING_ERROR);
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    assert.equal(s.severity, m.SEVERITY.HIGH);
    assert.equal(s.delayMs, 2000);
    assert.ok(s.retryable);
    assert.ok(s.hint.includes('reasoning_content'));
  });
  it('GATEWAY_MODEL_FAILED: retry_delayed then fallback_model', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_MODEL_FAILED, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_MODEL_FAILED, { attempts: 2 });
    assert.equal(s.action, m.RECOVERY_ACTION.FALLBACK_MODEL);
  });
  it('GATEWAY_LANE_BUSY: retry_delayed with exponential backoff, 30s cap', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_LANE_BUSY, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    assert.equal(s.delayMs, 3000);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_LANE_BUSY, { attempts: 5 });
    assert.equal(s.action, m.RECOVERY_ACTION.FALLBACK_MODEL);
    assert.equal(s.delayMs, 30000);
  });
  it('GATEWAY_SESSION_CORRUPT: reset_session', async () => {
    const m = await mod();
    const s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_SESSION_CORRUPT);
    assert.equal(s.action, m.RECOVERY_ACTION.RESET_SESSION);
    assert.equal(s.severity, m.SEVERITY.HIGH);
    assert.ok(s.retryable);
  });
  it('GATEWAY_ABORTED: retry_delayed then replan', async () => {
    const m = await mod();
    let s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_ABORTED, { attempts: 0 });
    assert.equal(s.action, m.RECOVERY_ACTION.RETRY_DELAYED);
    s = m.getRecoveryStrategy(m.FAILURE_TYPE.GATEWAY_ABORTED, { attempts: 3 });
    assert.equal(s.action, m.RECOVERY_ACTION.REPLAN);
  });
});

// ─── Iter-66 v2: executeRecovery ──────────────────────────────
describe('executeRecovery (Iter-66 v2)', () => {
  it('retry_delayed: returns shouldRetry=true with delay', async () => {
    const m = await mod();
    const diagnosis = m.diagnoseFailure('429 Rate limited', 'search', { attempts: 0 });
    const result = await m.executeRecovery(diagnosis);
    assert.ok(result.shouldRetry);
    assert.ok(!result.shouldSkip);
    assert.ok(!result.shouldReplan);
  });
  it('skip_step: returns shouldSkip=true', async () => {
    const m = await mod();
    const diagnosis = m.diagnoseFailure('Content blocked by Cloudflare', 'browser', { attempts: 0 });
    const result = await m.executeRecovery(diagnosis);
    assert.ok(result.shouldSkip);
    assert.ok(!result.shouldRetry);
    assert.ok(!result.shouldReplan);
  });
  it('ask_human: returns needsHuman=true', async () => {
    const m = await mod();
    const diagnosis = m.diagnoseFailure('401 Unauthorized', 'search', { attempts: 0 });
    const result = await m.executeRecovery(diagnosis);
    assert.ok(result.needsHuman);
    assert.ok(!result.shouldRetry);
    assert.ok(!result.shouldSkip);
  });
  it('replan: returns shouldReplan=true', async () => {
    const m = await mod();
    const diagnosis = m.diagnoseFailure('Context window too long, please compress', 'llm', { attempts: 0 });
    const result = await m.executeRecovery(diagnosis);
    assert.ok(result.shouldReplan);
    assert.ok(!result.shouldRetry);
    assert.ok(!result.shouldSkip);
  });
  it('abort: returns abort=true', async () => {
    const m = await mod();
    // Use a diagnosis path that leads to abort — call getRecoveryStrategy directly for ABORT type
    const diagnosis = { failureType: m.FAILURE_TYPE.UNKNOWN_ERROR, recovery: m.getRecoveryStrategy(m.FAILURE_TYPE.UNKNOWN_ERROR, { attempts: 0 }), errorMsg: 'test abort' };
    // Default unknown error with 0 attempts is retry_immediate, not abort, so test with correct recovery
    const abortRecovery = { action: m.RECOVERY_ACTION.ABORT, severity: m.SEVERITY.HIGH, delayMs: 0, retryable: false };
    const abortDiagnosis = { failureType: m.FAILURE_TYPE.UNKNOWN_ERROR, recovery: abortRecovery, errorMsg: 'abort test' };
    const result = await m.executeRecovery(abortDiagnosis);
    assert.ok(result.abort);
    assert.ok(!result.shouldRetry);
    assert.ok(!result.shouldSkip);
  });
  it('reset_session: returns resetSession=true', async () => {
    const m = await mod();
    const diagnosis = m.diagnoseFailure('session state corrupt', 'gateway', { attempts: 0 });
    const result = await m.executeRecovery(diagnosis);
    assert.ok(result.resetSession);
    assert.ok(result.shouldRetry);
    assert.ok(!result.shouldSkip);
  });
});

// ─── Iter-66 v2: Circuit Breaker ──────────────────────────────
describe('circuit breaker (Iter-66 v2)', () => {
  it('starts closed', async () => {
    const m = await mod();
    const cb = m.checkCircuitBreaker('test-closed');
    assert.ok(cb.allowed);
    assert.equal(cb.state, 'closed');
  });
  it('opens after threshold failures', async () => {
    const m = await mod();
    const service = 'test-open';
    // Record 5 failures (threshold)
    for (let i = 0; i < 5; i++) {
      m.recordCircuitFailure(service);
    }
    const cb = m.checkCircuitBreaker(service);
    assert.ok(!cb.allowed);
    assert.equal(cb.state, 'open');
    assert.ok(cb.retryAfterMs > 0);
  });
  it('circuit breaker stays open before cooldown', async () => {
    const m = await mod();
    const service = 'test-open-now';
    for (let i = 0; i < 5; i++) {
      m.recordCircuitFailure(service);
    }
    // Immediately check — should still be open
    const cb = m.checkCircuitBreaker(service);
    assert.ok(!cb.allowed);
    assert.equal(cb.state, 'open');
  });
  it('circuit breaker closes after success', async () => {
    const m = await mod();
    const service = 'test-success-close';
    for (let i = 0; i < 5; i++) {
      m.recordCircuitFailure(service);
    }
    // Record success
    m.recordCircuitSuccess(service);
    const cb = m.checkCircuitBreaker(service);
    assert.ok(cb.allowed);
    assert.equal(cb.state, 'closed');
  });
  it('getCircuitState returns correct state', async () => {
    const m = await mod();
    const service = 'test-state';
    let state = m.getCircuitState(service);
    assert.equal(state.state, 'closed');
    assert.equal(state.failures, 0);
    m.recordCircuitFailure(service);
    state = m.getCircuitState(service);
    assert.equal(state.failures, 1);
    m.recordCircuitSuccess(service);
    state = m.getCircuitState(service);
    assert.equal(state.failures, 0);
    assert.equal(state.state, 'closed');
  });
  it('different services have independent breakers', async () => {
    const m = await mod();
    const svcA = 'test-indep-a';
    const svcB = 'test-indep-b';
    for (let i = 0; i < 5; i++) {
      m.recordCircuitFailure(svcA);
    }
    // svcA should be open
    assert.ok(!m.checkCircuitBreaker(svcA).allowed);
    // svcB should still be closed
    assert.ok(m.checkCircuitBreaker(svcB).allowed);
    assert.equal(m.checkCircuitBreaker(svcB).state, 'closed');
  });
});

// ─── Iter-66 v2: LLM_CONTEXT_OVERFLOW recovery strategy ───────
describe('getRecoveryStrategy — LLM_CONTEXT_OVERFLOW (Iter-66 v2)', () => {
  it('LLM_CONTEXT_OVERFLOW: replan, not retryable', async () => {
    const m = await mod();
    const s = m.getRecoveryStrategy(m.FAILURE_TYPE.LLM_CONTEXT_OVERFLOW);
    assert.equal(s.action, m.RECOVERY_ACTION.REPLAN);
    assert.equal(s.severity, m.SEVERITY.HIGH);
    assert.equal(s.retryable, false);
  });
});
