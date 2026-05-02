// planner.mjs — Structured Planner Module (thin facade after R98 extraction)
// Responsibilities are delegated to focused modules:
//   - plan-generator.mjs: generateStructuredPlan/replan/replanOnFailure
//   - plan-reviewer.mjs: reviewStepResult/handleStepFailure
//   - plan-storage.mjs: plan state and persistence helpers
//   - plan-recovery.mjs: crash/session recovery metrics

import './plan-types.mjs';

export {
  markStepDoing,
  markStepDone,
  markStepBlocked,
  markStepFailed,
  markStepRetrying,
  requestReplan,
  isPlanComplete,
  validatePlanCompletion,
  getCurrentStep,
  getPlan,
  clearPlan,
  registerExternalPlan,
  rebuildPlanFromEvents,
  renderPlanForContext,
  getParallelBatches,
  getNextExecutableSteps,
  cleanupPlanStorageResources as cleanupPlannerResources,
} from './plan-storage.mjs';

export {
  recoverActivePlans,
  isRecoveryDone,
  getRecoveredPlans,
  getRecoveredPlan,
  consumeRecoveredPlan,
  getActivePlansBySession,
  getResumablePlan,
  recordPlanInjection,
  recordActionFollowance,
  recordNoPlanAction,
  getTaskPlanMetrics,
  getAllPlanMetrics,
} from './plan-recovery.mjs';

export {
  generateStructuredPlan as generatePlan,
  replan,
  replanOnFailure,
} from './plan-generator.mjs';

export { reviewStepResult, handleStepFailure } from './plan-reviewer.mjs';
export { getHintAdoptionStats } from './hint-system.mjs';

export { markParallelSteps, executePlanWithParallel } from './parallel-planner.mjs';
