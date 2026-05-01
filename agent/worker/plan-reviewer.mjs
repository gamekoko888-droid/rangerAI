// plan-reviewer.mjs — R98 extracted planner step review gate
// Extracted from planner.mjs without changing reviewStepResult contract.

import { invokeLLM as _rawInvokeLLM } from './llm-bridge.mjs';
import { logger } from '../lib/logger.mjs';

async function invokeLLM(params) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _rawInvokeLLM(params);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn(`[R31-T1] [planner-reviewer] LLM attempt ${attempt + 1} failed: ${err.message}, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        logger.error(`[R31-T1] [planner-reviewer] LLM all ${MAX_RETRIES + 1} attempts failed: ${err.message}`);
        throw err;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// [R70] GPT Step Review — Called after step completion for quality gate
// ═══════════════════════════════════════════════════════════════
export async function reviewStepResult(step, executionSummary, taskContext, options = {}) {
  // [R76-PhaseA] mustPass mode: for P0/critical steps, default to FAIL on ambiguity.
  const _r76_mustPass = options.mustPass === true;
  const REVIEW_MODEL = 'openai/gpt-5.5';
  const MAX_SUMMARY_LEN = 2000;
  const MAX_BRIEF_LEN = 500;

  const truncatedSummary = (executionSummary || '').substring(0, MAX_SUMMARY_LEN);
  const truncatedBrief = (step.taskBrief || '').substring(0, MAX_BRIEF_LEN);
  const criteria = step.acceptanceCriteria || 'Step completed successfully';

  const prompt = `You are a quality reviewer for an AI agent execution pipeline.

TASK CONTEXT: ${(taskContext || '').substring(0, 300)}

STEP: ${step.title || 'Unknown step'}
TASK BRIEF: ${truncatedBrief}
ACCEPTANCE CRITERIA: ${criteria}

EXECUTION RESULT (last ${MAX_SUMMARY_LEN} chars):
${truncatedSummary}

Review whether the execution result meets the acceptance criteria.
Be pragmatic: if the step achieved its core objective even with minor deviations, mark as pass.
Only fail if the result clearly does NOT meet the criteria or has obvious errors.

Output ONLY valid JSON (no markdown): { "pass": true/false, "feedback": "1-2 sentence explanation", "retryHint": "specific fix instruction if failed, empty string if passed" }`;

  try {
    const response = await invokeLLM({
      messages: [
        { role: 'system', content: 'You are a pragmatic quality reviewer. Output only valid JSON. Be strict on correctness but lenient on style.' },
        { role: 'user', content: prompt }
      ],
      model: REVIEW_MODEL,
      maxTokens: 300,
    });

    const text = response?.choices?.[0]?.message?.content || '{}';
    // Parse JSON, handling potential markdown wrapping
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`[R70-review] Could not parse JSON from GPT response: ${text.substring(0, 200)}`);
      return { pass: !_r76_mustPass, feedback: `Review parse failed, ${_r76_mustPass ? 'BLOCKED' : 'auto-passing'}`, retryHint: '', blocked: _r76_mustPass };
    }
    const result = JSON.parse(jsonMatch[0]);
    logger.info(`[R70-review] Step "${step.title}" review: pass=${result.pass} feedback="${(result.feedback || '').substring(0, 100)}"`);
    // [R76-PhaseA] mustPass mode: ambiguous results default to FAIL
    const _r76_defaultPass = _r76_mustPass ? false : true;
    const _r76_pass = result.pass === true ? true : (result.pass === false ? false : _r76_defaultPass);
    return {
      pass: _r76_pass,
      feedback: result.feedback || '',
      retryHint: result.retryHint || '',
      blocked: _r76_mustPass && !_r76_pass,
    };
  } catch (err) {
    logger.warn(`[R70-review] GPT review failed (${_r76_mustPass ? 'BLOCKING' : 'auto-passing'}): ${err.message}`);
    return { pass: !_r76_mustPass, feedback: `Review error: ${err.message}${_r76_mustPass ? ' (BLOCKED)' : ''}`, retryHint: '', blocked: _r76_mustPass };
  }
}



// ─── R98 Step Failure Handling Extraction (from planner.mjs) ───
import { _planCache, markStepRetrying, markStepFailed, persistProgress } from './plan-storage.mjs';
import { replanOnFailure } from './plan-generator.mjs';
const reviewTs = () => new Date().toISOString();

export async function handleStepFailure(taskId, sessionKey, stepId, toolName, errorMsg) {
  const plan = _planCache.get(taskId);
  if (!plan) return { action: 'abort' };

  const step = plan.steps.find(s => String(s.id) === String(stepId));
  if (!step) return { action: 'replan' };

  const strategy = step.onFailure || 'replan';
  const maxRetries = step.retryCount != null ? step.retryCount : 2;

  logger.info(`[${reviewTs()}] [L4-failure] step=${stepId} strategy=${strategy} tool=${toolName} retries_used=${step._retryCount || 0}/${maxRetries}`);

  switch (strategy) {
    case 'retry': {
      const used = step._retryCount || 0;
      if (used < maxRetries) {
        step._retryCount = used + 1;
        markStepRetrying(taskId, stepId);
        logger.info(`[${reviewTs()}] [L4-retry] step=${stepId} attempt=${step._retryCount}/${maxRetries}`);
        return { action: 'retry', attempt: step._retryCount };
      }
      // Exhausted retries → fall through to replan
      logger.info(`[${reviewTs()}] [L4-retry] step=${stepId} retries exhausted → replan`);
      markStepFailed(taskId, stepId, `Exhausted ${maxRetries} retries: ${errorMsg}`);
      const newPlan = await replanOnFailure(taskId, sessionKey, stepId, toolName, errorMsg);
      return { action: 'replan', plan: newPlan };
    }

    case 'skip': {
      const s = plan.steps.find(ss => String(ss.id) === String(stepId));
      if (s) { s.status = 'skipped'; s.output = `Skipped due to ${toolName} error: ${errorMsg.substring(0, 100)}`; }
      // Advance to next step
      const nextPending = plan.steps.find(ss => ss.status === 'pending');
      if (nextPending) { plan.currentStepId = String(nextPending.id); nextPending.status = 'doing'; }
      persistProgress(taskId, 'skip');
      logger.info(`[${reviewTs()}] [L4-skip] step=${stepId} skipped, next=${plan.currentStepId}`);
      return { action: 'skip' };
    }

    case 'abort': {
      markStepFailed(taskId, stepId, errorMsg);
      logger.warn(`[${reviewTs()}] [L4-abort] task=${taskId} step=${stepId} aborted: ${errorMsg.substring(0, 150)}`);
      return { action: 'abort' };
    }

    case 'replan':
    default: {
      markStepFailed(taskId, stepId, errorMsg);
      const newPlan = await replanOnFailure(taskId, sessionKey, stepId, toolName, errorMsg);
      return { action: 'replan', plan: newPlan };
    }
  }
}
