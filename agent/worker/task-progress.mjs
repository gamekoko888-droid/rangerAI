// task-progress.mjs — R98 extracted task progress facade
// Keeps task-engine.mjs thin while preserving the existing progress-tracker API.

export {
  progressStore,
  getProgressTracker,
  initTrackerFromPlan,
  markStepDone,
  recordStepEvidence,
  hasStepEvidence,
  getStepEvidence,
  clearEvidence,
  markStepRunning,
  buildProgressBlock,
  hasProgress,
  shouldTrackProgress,
  cleanupTracker,
  getTrackerStats,
  getTrackerDiagnostics,
  setTrackerMsgId,
  recordDiagnostic,
  cleanupProgressTrackerResources,
  PROGRESS_PREFIXES,
} from './progress-tracker.mjs';


export function summarizeProgress(sessionKey) {
  const stats = getTrackerStats(sessionKey) || {};
  const diagnostics = getTrackerDiagnostics(sessionKey) || [];
  return {
    sessionKey,
    hasProgress: hasProgress(sessionKey),
    totalSteps: Number(stats.totalSteps || stats.total || 0),
    doneSteps: Number(stats.doneSteps || stats.done || 0),
    runningSteps: Number(stats.runningSteps || stats.running || 0),
    diagnostics: diagnostics.slice(-10),
  };
}

export function formatProgressSummary(sessionKey) {
  const summary = summarizeProgress(sessionKey);
  return [
    `session=${summary.sessionKey}`,
    `progress=${summary.doneSteps}/${summary.totalSteps}`,
    `running=${summary.runningSteps}`,
    `diagnostics=${summary.diagnostics.length}`,
  ].join(' ');
}

export function hasActionableProgress(sessionKey) {
  const summary = summarizeProgress(sessionKey);
  return Boolean(summary.hasProgress && (summary.runningSteps > 0 || summary.doneSteps < summary.totalSteps));
}
