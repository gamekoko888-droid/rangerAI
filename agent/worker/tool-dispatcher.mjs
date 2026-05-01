import { createToolTracker } from './tool-tracker.mjs';
import { createToolOrchestrator } from './tool-orchestrator.mjs';
import { generateToolDescription } from './tool-description.mjs';
import { gateToolExecution, handleApprovalResponse } from './human-approval.mjs';
import { normalizeToolName } from './tool-name-normalizer.mjs';

// R97 tool-dispatcher: shared exports and dispatch metadata for tool execution.
// The heavy tool loop still lives in the legacy shard, but this module is now a
// real, callable composition seam instead of a side-effect-only import.

export {
  createToolTracker,
  createToolOrchestrator,
  generateToolDescription,
  gateToolExecution,
  handleApprovalResponse,
  normalizeToolName,
};

export const TOOL_DISPATCHER_CAPABILITIES = Object.freeze([
  'tool-tracking',
  'tool-orchestration',
  'human-approval',
  'tool-name-normalization',
]);

export function getToolDispatcherCapabilities() {
  return [...TOOL_DISPATCHER_CAPABILITIES];
}

export function createToolDispatchContext(options = {}) {
  const tracker = options.tracker || createToolTracker(options.trackerOptions || {});
  const orchestrator = options.orchestrator || createToolOrchestrator(options.orchestratorOptions || {});
  return { tracker, orchestrator };
}

export function createToolDispatchMetadata({ entry = {}, options = {} } = {}) {
  return {
    taskId: entry.taskId || null,
    sessionKey: entry.gatewaySessionKey || null,
    approvalMode: options.approvalMode || 'default',
    capabilities: getToolDispatcherCapabilities(),
  };
}

export async function dispatchWithApproval(toolCall, execute, context = {}) {
  const approval = await gateToolExecution(toolCall, context);
  if (approval?.blocked) return approval;
  if (approval?.response) return handleApprovalResponse(approval.response, context);
  return execute(toolCall, context);
}
