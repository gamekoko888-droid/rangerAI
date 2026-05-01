// task-diagnostics.mjs — R98 task diagnostic helpers for task-engine observability.
// This module is intentionally side-effect free: it summarizes existing task/progress
// state for logs, admin endpoints, and verifier-visible module boundaries.

import { getTaskStateSnapshot, getActiveTaskState } from './task-lifecycle.mjs';
import { getTrackerStats, getTrackerDiagnostics, hasProgress } from './task-progress.mjs';

export function buildTaskDiagnostic(sessionKey, taskId = sessionKey) {
  const state = getTaskStateSnapshot(taskId) || getActiveTaskState(taskId) || null;
  const trackerStats = getTrackerStats(sessionKey) || null;
  const diagnostics = getTrackerDiagnostics(sessionKey) || [];
  return normalizeDiagnostic({ sessionKey, taskId, state, trackerStats, diagnostics });
}

export function normalizeDiagnostic(input = {}) {
  const state = input.state || null;
  const trackerStats = input.trackerStats || null;
  const diagnostics = Array.isArray(input.diagnostics) ? input.diagnostics : [];
  const progressKnown = input.sessionKey ? hasProgress(input.sessionKey) : false;
  return {
    sessionKey: input.sessionKey || '',
    taskId: input.taskId || input.sessionKey || '',
    status: state?.status || 'unknown',
    phase: state?.phase || state?.currentPhase || 'unknown',
    progressKnown,
    tracker: summarizeTracker(trackerStats),
    recentDiagnostics: diagnostics.slice(-10),
    updatedAt: state?.updatedAt || Date.now(),
  };
}

export function summarizeTracker(stats = {}) {
  return {
    totalSteps: Number(stats.totalSteps || stats.total || 0),
    doneSteps: Number(stats.doneSteps || stats.done || 0),
    runningSteps: Number(stats.runningSteps || stats.running || 0),
    failedSteps: Number(stats.failedSteps || stats.failed || 0),
    evidenceCount: Number(stats.evidenceCount || stats.evidence || 0),
  };
}

export function formatTaskDiagnostic(diag = {}) {
  const tracker = diag.tracker || summarizeTracker();
  return [
    `task=${diag.taskId || 'unknown'}`,
    `status=${diag.status || 'unknown'}`,
    `phase=${diag.phase || 'unknown'}`,
    `progress=${tracker.doneSteps}/${tracker.totalSteps}`,
    `evidence=${tracker.evidenceCount}`,
  ].join(' ');
}

export function shouldEmitDiagnostic(diag = {}) {
  if (!diag || diag.status === 'unknown') return false;
  const tracker = diag.tracker || {};
  return Boolean(diag.progressKnown || tracker.totalSteps > 0 || diag.recentDiagnostics?.length);
}
