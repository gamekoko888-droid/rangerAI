import {
  processTextForPlan,
  cleanupPlan,
  getSerializablePlan,
  markStepDone as progressMarkStepDone,
  markStepRunning as progressMarkStepRunning,
  initTrackerFromPlan,
  buildProgressBlock,
  shouldTrackProgress,
  cleanupTracker,
  hasProgress,
  recordStepEvidence,
} from './task-engine.mjs';
import { recordPlanInjection, recordActionFollowance, recordNoPlanAction, getRecoveredPlans, consumeRecoveredPlan, reviewStepResult } from './planner.mjs';
import { syncFromPlan, markInProgress, markDone, markFailed, getSnapshot, emitTodoEvent, hasTodo } from './todo-tracker.mjs';

export {
  processTextForPlan,
  cleanupPlan,
  getSerializablePlan,
  progressMarkStepDone,
  progressMarkStepRunning,
  initTrackerFromPlan,
  buildProgressBlock,
  shouldTrackProgress,
  cleanupTracker,
  hasProgress,
  recordStepEvidence,
  recordPlanInjection,
  recordActionFollowance,
  recordNoPlanAction,
  getRecoveredPlans,
  consumeRecoveredPlan,
  reviewStepResult,
  syncFromPlan,
  markInProgress,
  markDone,
  markFailed,
  getSnapshot,
  emitTodoEvent,
  hasTodo,
};

export function createPlanProgressFacade(sessionKey) {
  return {
    sessionKey,
    init: initTrackerFromPlan,
    running: progressMarkStepRunning,
    done: progressMarkStepDone,
    evidence: recordStepEvidence,
    block: buildProgressBlock,
    cleanup: cleanupTracker,
  };
}
