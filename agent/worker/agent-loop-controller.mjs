/**
 * agent-loop-controller.mjs
 * P0-FIX: Multi-Turn Agent Loop Controller
 * Enables Ranger to auto-continue executing plan steps without waiting for user input.
 */
import { getPlan } from './plan-storage.mjs';

export const MAX_AUTO_TURNS = 5;
export const INTER_TURN_DELAY_MS = 1500;

/**
 * Check if the agent should auto-continue to the next plan step.
 * Returns the next pending step, or null if no more steps to execute.
 */
export function shouldAutoContinue(msgId, currentTurn) {
  if (currentTurn >= MAX_AUTO_TURNS) return null;
  const plan = getPlan(msgId);
  if (plan === null || plan === undefined) return null;
  if (plan.steps === null || plan.steps === undefined) return null;
  const nextStep = plan.steps.find(s => s.status === 'pending');
  return nextStep || null;
}

/**
 * Build the continue message for the next plan step.
 */
export function buildContinueMessage(nextStep, plan) {
  const completedSteps = plan.steps.filter(s => s.status === 'done').map(s => s.title || s.description).join(', ');
  const msg = 'Continue executing the plan. ' +
    'Completed so far: [' + completedSteps + ']. ' +
    'Now execute step ' + nextStep.id + ': ' + (nextStep.title || nextStep.description) + '. ' +
    'Focus only on this step. When done, report the result.';
  return msg;
}

/**
 * Emit auto-continue event for observability.
 */
export function emitAutoContinue(msgId, nextStep, turnNumber) {
  console.log('[agent-loop-ctrl] [AUTO-CONTINUE] msgId=' + msgId + ' turn=' + turnNumber + ' step=' + nextStep.id + ' title=' + (nextStep.title || nextStep.description));
}

// --- L3 Runtime Verification ---
const L3_VIOLATIONS = [];

export function verifyThreePhaseInvariants(msgId, phases) {
  const violations = [];
  if (phases.planGenerated === false && phases.isAutoContinue === false) {
    violations.push({ rule: 'L3-1', msg: 'Plan was not generated (Phase 1 skipped)' });
  }
  if (phases.gatewayExecuted === false) {
    violations.push({ rule: 'L3-2', msg: 'Gateway was not called (Phase 2 skipped)' });
  }
  if (phases.toolsUsed > 0 && phases.hasText === false && phases.selfHealAttempted === false) {
    violations.push({ rule: 'L3-3', msg: 'Tools used without text but no self-heal (Phase 3 skipped)' });
  }
  if (phases.planModel && phases.planModel !== 'gpt-5.5') {
    violations.push({ rule: 'L3-4', msg: 'Plan model was ' + phases.planModel + ', expected gpt-5.5' });
  }
  if (violations.length > 0) {
    L3_VIOLATIONS.push({ msgId, timestamp: Date.now(), violations });
    console.warn('[L3-VERIFY] ' + violations.length + ' violations for ' + msgId);
  }
  return violations;
}

export function getL3Violations() {
  return L3_VIOLATIONS.slice(-50);
}
