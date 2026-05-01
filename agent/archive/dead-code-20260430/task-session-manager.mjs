// task-session-manager.mjs — Extracted from openclaw-handler.mjs (Iter-I / R68)
// Task-local state management: session binding, stream state, event sequencing, cleanup
import { logger } from '../lib/logger.mjs';
import { cleanupExecutorRegistry } from "./executor.mjs";

// ─── R7: Task-local state Maps for session binding and stream lifecycle ───
const _taskContext = new Map();  // taskId => { taskId, taskSessionKey, createdAt, ... }
const _streamState = new Map();  // taskId => { started, completed, finalized, aborted, lastEventSeq, finalizeReason }
const _eventSeq = new Map();     // taskId => monotonic event counter
// [R38-T4] Sandbox isolation: exec timeout tracking
const _execTimers = new Map();   // `${taskId}:${toolId}` => { timer, startMs }
// [R59-P0-1] Progress reinjection dedup: avoid flooding LLM context with unchanged progress
const _lastProgressHash = new Map(); // sessionKey => last injected progress hash (dedup by first 80 chars)

/** R7 Task 2: Register task session binding */
export function bindTaskSession(taskId, sessionKey) {
  if (_taskContext.has(taskId)) {
    const existing = _taskContext.get(taskId);
    if (existing.taskSessionKey !== sessionKey) {
      logger.warn(`[R7-session-bind] mismatch blocked: task=${taskId} bound=${existing.taskSessionKey} incoming=${sessionKey}`);
    }
    return existing.taskSessionKey;
  }
  _taskContext.set(taskId, {
    taskId,
    taskSessionKey: sessionKey,
    createdAt: Date.now(),
  });
  logger.info(`[R7-session-bind] task=${taskId} bound to session=${sessionKey.substring(0, 40)}`);
  return sessionKey;
}

/** R7 Task 2: Get bound session key for a task */
export function getBoundSessionKey(taskId) {
  const ctx = _taskContext.get(taskId);
  return ctx?.taskSessionKey || null;
}

/** R7 Task 1: Initialize stream state for a task */
export function initStreamState(taskId) {
  _streamState.set(taskId, {
    started: false,
    completed: false,
    finalized: false,
    aborted: false,
    lastEventSeq: 0,
    finalizeReason: null,
  });
  return _streamState.get(taskId);
}

/** R7 Task 1: Mark a stream event and check ordering */
export function markStreamEvent(taskId, type, seq) {
  const ss = _streamState.get(taskId);
  if (!ss) return;
  if (seq !== undefined && seq <= ss.lastEventSeq) {
    logger.warn(`[R7-stream-order] non-monotonic seq: task=${taskId} prev=${ss.lastEventSeq} current=${seq} type=${type}`);
  }
  if (seq !== undefined) ss.lastEventSeq = seq;
  switch (type) {
    case 'started': ss.started = true; break;
    case 'completed': ss.completed = true; break;
    case 'aborted': ss.aborted = true; break;
  }
}

/** R7 Task 1: Check if finalize is allowed */
export function canFinalize(taskId) {
  const ss = _streamState.get(taskId);
  if (!ss) return true; // No state = legacy path, allow
  return !ss.finalized;
}

/** R7 Task 1: Atomic finalize-once guard */
export function finalizeOnce(taskId, reason) {
  const ss = _streamState.get(taskId);
  if (!ss) {
    logger.info(`[R7-stream] finalizeOnce: task=${taskId} reason=${reason} (no stream state, legacy path)`);
    return true;
  }
  if (ss.finalized) {
    logger.warn(`[R7-stream] duplicate finalize blocked: task=${taskId} reason=${reason} (already finalized by: ${ss.finalizeReason})`);
    return false;
  }
  ss.finalized = true;
  ss.finalizeReason = reason;
  logger.info(`[R7-stream] finalizeOnce: task=${taskId} reason=${reason}`);
  return true;
}

/** R7 Task 4: Get next event seq for a task */
export function nextEventSeq(taskId) {
  const current = _eventSeq.get(taskId) || 0;
  const next = current + 1;
  _eventSeq.set(taskId, next);
  return next;
}

/** R7 Task 5: Cleanup task-local state after completion */
export function scheduleTaskCleanup(taskId, delayMs = 300000) {
  setTimeout(() => {
    _taskContext.delete(taskId);
    _streamState.delete(taskId);
    _eventSeq.delete(taskId);
    cleanupExecutorRegistry(taskId); // R8 Task 1: Clean executor registry
    logger.info(`[R7-cleanup] released task state: ${taskId} (incl. executor registry)`);
  }, delayMs);
}

// Exported for direct mutation by openclaw-handler
export { _execTimers, _lastProgressHash };
