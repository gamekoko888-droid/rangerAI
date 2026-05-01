// task-lifecycle.mjs — R98 extracted task lifecycle facade.
// Groups task state creation/status transitions for task-engine.mjs while keeping
// the public task-engine API stable.

import { rowToState, createDefaultState, mergeState } from './task-state-model.mjs';
import {
  getOrCreateTaskState,
  updateTaskState,
  getTaskStateSnapshot,
  getActiveTaskState,
  completeTask,
  cleanupTaskStateResources,
} from './task-state-manager.mjs';

export { rowToState, createDefaultState, mergeState };
export {
  getOrCreateTaskState,
  updateTaskState,
  getTaskStateSnapshot,
  getActiveTaskState,
  completeTask,
  cleanupTaskStateResources,
};

export function ensureLifecycleState(taskId, seed = {}) {
  const state = getOrCreateTaskState(taskId, seed);
  return mergeState(createDefaultState(taskId), state || {}, seed || {});
}

export function markLifecyclePhase(taskId, phase, patch = {}) {
  if (!taskId) return null;
  const nextPatch = {
    ...patch,
    phase,
    currentPhase: phase,
    updatedAt: Date.now(),
  };
  return updateTaskState(taskId, nextPatch);
}

export function snapshotLifecycle(taskId) {
  const snapshot = getTaskStateSnapshot(taskId) || getActiveTaskState(taskId);
  if (!snapshot) return null;
  return {
    taskId,
    status: snapshot.status || 'unknown',
    phase: snapshot.phase || snapshot.currentPhase || 'unknown',
    updatedAt: snapshot.updatedAt || null,
    hasState: true,
  };
}

export function isLifecycleTerminal(state = {}) {
  const status = state.status || state.phase || '';
  return ['done', 'completed', 'failed', 'cancelled', 'blocked'].includes(status);
}

export function finalizeLifecycle(taskId, result = {}) {
  const state = completeTask(taskId, result);
  return snapshotLifecycle(taskId) || state || null;
}
