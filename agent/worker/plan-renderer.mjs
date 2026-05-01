// plan-renderer.mjs — R98 focused plan rendering and fallback construction helpers.

import { updateHintAdoptionActualTools, getHintAdoptionStats } from './hint-system.mjs';
import { normalizePlanStepContract } from './plan-formatter.mjs';
import { _planCache } from './plan-storage.mjs';

export function renderPlanForContext(taskId) {
  const plan = _planCache.get(taskId);
  if (!plan) return '';

  const allLines = [];

  // [R10-Task3] Current step directive — placed FIRST for LLM attention
  const currentStep = plan.steps.find(s => s.id === plan.currentStepId);
  if (currentStep && (currentStep.status === 'doing' || currentStep.status === 'pending')) {
    const toolsStr = (currentStep.tools && currentStep.tools.length > 0) ? currentStep.tools.join(', ') : 'auto';
    const doneSteps = plan.steps.filter(s => s.status === 'done').length;
    allLines.push(`[CURRENT_STEP_DIRECTIVE]`);
    allLines.push(`Latest user message has priority over this directive. Execute this step only if it still matches the latest user intent; otherwise answer the latest user message first and treat this plan as stale background.`);
    allLines.push(`Current planned step ${currentStep.id}: "${currentStep.title}"`);
    allLines.push(`Required tools: ${toolsStr}`);
    if (currentStep.rationale) {
      allLines.push(`Rationale: ${currentStep.rationale}`);
    }
    allLines.push(`Progress: ${doneSteps}/${plan.steps.length} steps completed`);
    // Show what comes after this step
    const nextPending = plan.steps.find(s => s.status === 'pending' && s.id !== currentStep.id);
    if (nextPending) {
      allLines.push(`After this step: proceed to step ${nextPending.id} ("${nextPending.title}")`);
    } else {
      allLines.push(`After this step: plan complete — summarize results for user`);
    }
    allLines.push(`[/CURRENT_STEP_DIRECTIVE]`);
    allLines.push(''); // blank line separator
  }

  // Plan overview (same as before)
  const statusIcon = { pending: '○', doing: '▶', done: '✓', failed: '✘', blocked: '✗', retrying: '↻', skipped: '–' };
  allLines.push(`[STRUCTURED_PLAN v${plan.plan_version || plan.version}]`);
  allLines.push(`Goal: ${plan.goal}`);

  // [R8] Include reflection if available
  if (plan.reflection) {
    allLines.push(`Reflection: ${plan.reflection.substring(0, 200)}`);
  }

  allLines.push(`Steps:`);

  for (const step of plan.steps) {
    const icon = statusIcon[step.status] || '?';
    const current = step.id === plan.currentStepId ? ' ← CURRENT' : '';
    const output = step.output ? ` (result: ${step.output.substring(0, 100)})` : '';
    const blocked = step.blockReason ? ` [BLOCKED: ${step.blockReason}]` : '';
    allLines.push(`  ${icon} ${step.id}. ${step.title}${output}${blocked}${current}`);
  }

  allLines.push(`Done Criteria: ${plan.doneCriteria.join('; ')}`);
  if (plan.notes.length > 0) {
    allLines.push(`Notes: ${plan.notes.slice(-3).join('; ')}`);
  }
  allLines.push(`[/STRUCTURED_PLAN]`);

  return allLines.join('\n');
}

// ─── Fallback Plan ─────────────────────────────────────────

export function createFallbackPlan(taskId, userGoal, existingPlan) {
  return {
    plan_version: existingPlan ? (existingPlan.plan_version || existingPlan.version || 0) + 1 : 1,
    reflection: 'Fallback plan: LLM plan generation failed, using single-step execution',
    goal: userGoal.substring(0, 500),
    steps: [
      { id: '1', title: '分析用户需求并执行任务', status: 'pending', tools: ['auto'], rationale: 'Fallback single-step execution' }
    ],
    currentStepId: '1',
    doneCriteria: ['用户目标已达成'],
    notes: ['Fallback plan: LLM plan generation failed, using single-step execution'],
    needsReplan: false,
    version: existingPlan ? existingPlan.version + 1 : 1,
    createdAt: existingPlan ? existingPlan.createdAt : Date.now(),
    updatedAt: Date.now()
  };
}

