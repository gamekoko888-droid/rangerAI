import { DEFAULT_TIMEOUT_MS } from './agent-config.mjs';

// R97 handler-entry: entry normalization and session bootstrap helpers.
// This module deliberately keeps the public handler signature unchanged while
// making the former inline setup steps explicit and independently testable.

export function normalizeGatewaySessionKey(sessionKey) {
  const raw = String(sessionKey || '');
  return raw.startsWith('agent:main:') ? raw : `agent:main:${raw}`;
}

export function assertHandlerInput(userMessage, sessionKey, msgId) {
  if (typeof userMessage !== 'string') {
    throw new TypeError('userMessage must be a string');
  }
  if (!sessionKey) {
    throw new TypeError('sessionKey is required');
  }
  if (!msgId) {
    throw new TypeError('msgId is required');
  }
}

export function resolveInitialRunId(msgId, options = {}) {
  return options?.runId || msgId;
}

export function resolveUserRole(options = {}, deps = {}) {
  return options?.userRole || deps?.userRole || 'member';
}

export function resolveTimeoutMs(options = {}) {
  return options?.timeout || DEFAULT_TIMEOUT_MS;
}

export function buildHandlerEntryContext(userMessage, sessionKey, msgId, options = {}, deps = {}) {
  assertHandlerInput(userMessage, sessionKey, msgId);
  const taskId = msgId;
  const initialRunId = resolveInitialRunId(msgId, options);
  const userRole = resolveUserRole(options, deps);
  const gatewaySessionKey = normalizeGatewaySessionKey(sessionKey);
  const timeoutMs = resolveTimeoutMs(options);
  const hasGateway = Boolean(deps?.gateway);
  const hasBrowserBreaker = Boolean(deps?.browserBreaker);
  return {
    taskId,
    initialRunId,
    userRole,
    gatewaySessionKey,
    timeoutMs,
    hasGateway,
    hasBrowserBreaker,
  };
}

export function summarizeHandlerEntry(entry = {}) {
  return {
    taskId: entry.taskId || null,
    initialRunId: entry.initialRunId || null,
    userRole: entry.userRole || 'member',
    gatewaySessionKey: entry.gatewaySessionKey || null,
    timeoutMs: Number(entry.timeoutMs || 0),
    hasGateway: Boolean(entry.hasGateway),
    hasBrowserBreaker: Boolean(entry.hasBrowserBreaker),
  };
}

export function initializeHandlerEntry(userMessage, sessionKey, msgId, options = {}, deps = {}) {
  return buildHandlerEntryContext(userMessage, sessionKey, msgId, options, deps);
}
