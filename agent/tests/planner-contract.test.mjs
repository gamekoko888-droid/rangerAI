// planner-contract.test.mjs — Iter-65: validatePlanCompletion unit tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('validatePlanCompletion', () => {
  it('worker planner exports validatePlanCompletion', async () => {
    const planner = await import('../worker/planner.mjs');
    assert.equal(typeof planner.validatePlanCompletion, 'function');
  });

  it('returns structured no_plan result when plan not found', async () => {
    const planner = await import('../worker/planner.mjs');
    const result = planner.validatePlanCompletion('iter65-no-plan');

    assert.equal(result.valid, false);
    assert.equal(result.status, 'no_plan');
    assert.ok(Array.isArray(result.issues));
    assert.ok(Array.isArray(result.missingCriteria));
    assert.ok(result.issues.includes('Plan not found in cache'));
  });

  it('preserves existing plan completion API alongside contract validator', async () => {
    const planner = await import('../worker/planner.mjs');

    assert.equal(typeof planner.isPlanComplete, 'function');
    assert.equal(typeof planner.markStepDone, 'function');
    assert.equal(typeof planner.markStepFailed, 'function');
    assert.equal(typeof planner.getCurrentStep, 'function');
    assert.equal(typeof planner.getPlan, 'function');
    assert.equal(typeof planner.clearPlan, 'function');
  });
});
