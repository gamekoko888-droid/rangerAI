// r69-execution-discipline.mjs — R69 task execution discipline
// Goal: make complex tasks execute step-by-step instead of one-shot cascading.

const COMPLEXITY_PATTERNS = [
  /执行|修复|实现|重构|部署|迭代|任务|步骤|计划|验证|测试|commit|提交|改代码|修改代码/i,
  /execute|fix|implement|refactor|deploy|iterate|task|step|plan|verify|test|commit/i,
];

export function shouldUseStructuredExecution(userMessage = '', plan = null) {
  const text = String(userMessage || '');
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (steps.length >= 2) return true;
  if (text.length >= 160) return true;
  return COMPLEXITY_PATTERNS.some((re) => re.test(text));
}

export function buildStepExecutionDirective(plan = null) {
  const currentStep = getCurrentStep(plan);
  const stepTitle = currentStep?.title || currentStep?.description || currentStep?.name || 'current step';
  const stepId = currentStep?.id || currentStep?.stepId || plan?.currentStepId || 'current';

  return `[R69_STEP_EXECUTION_DISCIPLINE]\nMode: structured_step_execution\nCurrent step: ${stepId} — ${stepTitle}\nRules:\n1. Execute ONLY the current step before moving forward.\n2. After every code/file/service change, run the smallest relevant verification.\n3. Do not mark a step done unless verification evidence exists.\n4. If a tool or verification fails, classify the failure and retry/fix the same step; do not silently continue.\n5. If more than 4 files need modification, stop and replan before editing.\n6. Report step result with: changed files, verification command, verification output, next step.\n[/R69_STEP_EXECUTION_DISCIPLINE]`;
}

export function getCurrentStep(plan = null) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const currentId = plan.currentStepId || plan.current_step_id || plan.currentStep;
  return plan.steps.find((s) => String(s.id || s.stepId) === String(currentId))
    || plan.steps.find((s) => s.status === 'doing' || s.status === 'running' || s.status === 'pending')
    || plan.steps[0]
    || null;
}

export function evaluateStepCompletionGate({ toolName = '', resultText = '', step = null, tracker = null, minTools = 3, minElapsedMs = 10000 } = {}) {
  const tool = String(toolName || '').toLowerCase();
  const text = String(resultText || '').toLowerCase();
  const count = Number(tracker?.count || 0);
  const elapsedMs = Math.max(0, Date.now() - Number(tracker?.startedAt || Date.now()));
  const stepText = `${step?.title || ''} ${step?.description || ''} ${(step?.tools || []).join(' ')}`.toLowerCase();

  const isVerificationTool = tool === 'exec' || tool.includes('test') || tool.includes('check');
  const hasVerificationEvidence = /syntax ok|test(s)? passed|passed|http=200|https=200|status.:.?ok|build complete|build succeeded|0 failed|exit code 0|listening/.test(text);
  const stepAsksVerification = /验证|检查|测试|构建|部署|verify|check|test|build|deploy|health/.test(stepText);

  if (isVerificationTool && (hasVerificationEvidence || stepAsksVerification)) {
    return { complete: true, reason: 'verification_evidence', count, elapsedMs };
  }
  if (count >= minTools && elapsedMs >= minElapsedMs) {
    return { complete: true, reason: 'min_tools_and_time', count, elapsedMs };
  }
  return { complete: false, reason: 'await_more_evidence', count, elapsedMs };
}
