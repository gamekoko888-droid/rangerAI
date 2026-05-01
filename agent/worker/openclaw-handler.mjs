// R97 thin public entry for OpenClaw handler.
// External API is intentionally unchanged:
//   handleViaOpenClaw(userMessage, sessionKey, msgId, options, deps)
//   cleanupOpenClawHandlerResources()
//
// The legacy orchestration body is loaded through openclaw-handler-loader.mjs
// from ≤500-line source shards. R97 responsibility modules below are imported
// and called as stable seams for progressive internal migration.

import {
  initializeHandlerEntry,
  summarizeHandlerEntry,
} from './handler-entry.mjs';
import { createToolDispatchMetadata } from './tool-dispatcher.mjs';
import { createStepExecutionState, runStepExecutionLoop } from './step-executor.mjs';
import { createRecoveryContext } from './error-recovery.mjs';
import { createPlanProgressFacade } from './plan-tracker.mjs';
import { createHeartbeatSnapshot } from './heartbeat-manager.mjs';
import {
  cleanupOpenClawHandlerResources as _cleanupOpenClawHandlerResources,
} from './openclaw-handler-loader.mjs';

function buildR97HandlerContext(userMessage, sessionKey, msgId, options = {}, deps = {}) {
  const entry = initializeHandlerEntry(userMessage, sessionKey, msgId, options, deps);
  const toolDispatch = createToolDispatchMetadata({ entry, options });
  const recovery = createRecoveryContext({ entry, source: 'openclaw-handler' });
  const planProgress = createPlanProgressFacade(entry.gatewaySessionKey);
  const heartbeat = createHeartbeatSnapshot({ timeoutMs: entry.timeoutMs });
  const stepState = createStepExecutionState({ entry, options, deps });
  return {
    entry,
    entrySummary: summarizeHandlerEntry(entry),
    toolDispatch,
    recovery,
    planProgress,
    heartbeat,
    stepState,
  };
}

export async function handleViaOpenClaw(userMessage, sessionKey, msgId, options = {}, deps = {}) {
  const r97Context = buildR97HandlerContext(userMessage, sessionKey, msgId, options, deps);
  return runStepExecutionLoop({
    userMessage,
    sessionKey,
    msgId,
    options,
    deps,
    entry: r97Context.entry,
    state: r97Context.stepState,
    r97Context,
  });
}

export function cleanupOpenClawHandlerResources() {
  return _cleanupOpenClawHandlerResources();
}

export default handleViaOpenClaw;
