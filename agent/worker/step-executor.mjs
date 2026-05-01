import { legacyModule, handleViaOpenClaw as executeOpenClawSteps } from './openclaw-handler-loader.mjs';
import { shouldUseStructuredExecution, buildStepExecutionDirective, evaluateStepCompletionGate } from './r69-execution-discipline.mjs';
import { getActiveExecutor, clearActiveExecutor } from './context-injector.mjs';

// R97 step-executor: stable seam for the long-running OpenClaw step loop.
// The legacy loop is still delegated as-is; this module owns the execution
// envelope so future migrations can move retry/gate logic here incrementally.

export {
  legacyModule,
  executeOpenClawSteps,
  shouldUseStructuredExecution,
  buildStepExecutionDirective,
  evaluateStepCompletionGate,
  getActiveExecutor,
  clearActiveExecutor,
};

export function createStepExecutionState({ entry = {}, options = {}, deps = {} } = {}) {
  return {
    taskId: entry.taskId || null,
    runId: entry.initialRunId || null,
    sessionKey: entry.gatewaySessionKey || null,
    timeoutMs: entry.timeoutMs || options?.timeout || 0,
    hasAbortController: Boolean(options?.abortController),
    hasGateway: Boolean(deps?.gateway),
    startedAt: Date.now(),
    attempts: 0,
  };
}

export function markStepExecutionAttempt(state = {}) {
  state.attempts = Number(state.attempts || 0) + 1;
  state.lastAttemptAt = Date.now();
  return state;
}

export function completeStepExecutionState(state = {}, result = '') {
  state.completedAt = Date.now();
  state.durationMs = state.startedAt ? state.completedAt - state.startedAt : 0;
  state.resultLength = typeof result === 'string' ? result.length : 0;
  return state;
}

export function failStepExecutionState(state = {}, error) {
  state.failedAt = Date.now();
  state.durationMs = state.startedAt ? state.failedAt - state.startedAt : 0;
  state.error = error?.message || String(error || 'unknown error');
  return state;
}

export async function runStepExecutionLoop(args = {}) {
  const {
    userMessage,
    sessionKey,
    msgId,
    options = {},
    deps = {},
    state = createStepExecutionState({ entry: args.entry, options, deps }),
  } = args;
  markStepExecutionAttempt(state);
  try {
    const result = await executeOpenClawSteps(userMessage, sessionKey, msgId, options, deps);
    completeStepExecutionState(state, result);
    return result;
  } catch (error) {
    failStepExecutionState(state, error);
    throw error;
  }
}
