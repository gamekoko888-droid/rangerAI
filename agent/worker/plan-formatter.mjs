import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();


// [R42-T2] Transform plan_update payload to structured numbered pseudocode format
export function _r42FormatPlanPayload(plan, extraFields = {}) {
  if (!plan || !plan.steps) return extraFields;
  const steps = plan.steps.map((s, i) => ({
    id: parseInt(s.id) || (i + 1),
    desc: s.title || s.description || ('Step ' + (i + 1)),
    status: s.status || 'pending',
    tools: s.tools || [],
    output: s.output || undefined
  }));
  const activeStep = steps.find(s => s.status === 'doing' || s.status === 'active');
  const currentStep = activeStep ? activeStep.id : (steps.filter(s => s.status === 'done').length + 1);
  const totalSteps = steps.length;
  const allDone = steps.every(s => s.status === 'done');
  const anyFailed = steps.some(s => s.status === 'failed');
  let status = 'in_progress';
  if (allDone) status = 'completed';
  else if (anyFailed) status = 'failed';
  return {
    planId: plan.planId || plan.taskId || extraFields.taskId || 'plan-unknown',
    currentStep,
    totalSteps,
    status,
    reflection: plan.reflection || '',
    steps,
    // Keep original fields for backward compatibility
    plan,
    ...extraFields
  };
}


// The new schema adds plan_version, reflection, and per-step rationale.
// This is the STRICT schema sent to the LLM via response_format.

export const R8_PLAN_JSON_SCHEMA = {
  name: 'structured_plan_r8',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      plan_version: { type: 'integer', description: 'Plan version number, starts at 1' },
      reflection: { type: 'string', description: 'Brief reasoning about the task and approach' },
      goal: { type: 'string', description: 'The user objective' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string', description: 'Concise step description in Chinese, max 120 chars' },
            tools: { type: 'array', items: { type: 'string' } },
            expectedTools: { type: 'array', items: { type: 'string' }, description: '[R12-T4] Specific tool names expected for this step (e.g. shell_exec, file_write, web_search). Used for plan-follow metrics.' },
            rationale: { type: 'string', description: 'Why this step is needed' },
            status: { type: 'string', enum: ['pending', 'doing', 'done', 'failed', 'blocked', 'retrying', 'skipped'] },
            dependsOn: { type: 'array', items: { type: 'string' }, description: '[L4] Step IDs this step depends on. Steps with no dependsOn (or empty array) can run in parallel.' },
            onFailure: { type: 'string', enum: ['retry', 'skip', 'replan', 'abort'], description: '[L4] Failure recovery strategy: retry=retry up to 2 times, skip=mark skipped and continue, replan=trigger full replan, abort=stop execution.' },
            retryCount: { type: 'integer', description: '[L4] Max retry attempts if onFailure=retry (default 2).' },
            taskBrief: { type: 'string', description: '[R70] Detailed task brief written by GPT planner. Must specify: what to do, how to do it, expected output format. Max 500 chars.' },
            acceptanceCriteria: { type: 'string', description: '[R70] Measurable acceptance criteria for GPT review. Must be verifiable.' },
            critical: { type: 'boolean', description: '[R70] Whether this step requires GPT review after execution. True for write/deploy/code steps.' },
            reviewPolicy: { type: 'string', enum: ['gpt_review', 'auto_pass', 'final_only'], description: '[R70] Review policy: gpt_review=GPT reviews result, auto_pass=skip review, final_only=only review at plan end.' }
          },
          required: ['id', 'title', 'tools', 'expectedTools', 'rationale', 'status', 'dependsOn', 'onFailure', 'retryCount', 'taskBrief', 'acceptanceCriteria', 'critical', 'reviewPolicy'],
          additionalProperties: false
        }
      },
      currentStepId: { type: 'string' },
      doneCriteria: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
      needsReplan: { type: 'boolean' }
    },
    required: ['plan_version', 'reflection', 'goal', 'steps', 'currentStepId', 'doneCriteria', 'notes', 'needsReplan'],
    additionalProperties: false
  }
};

// ─── Plan Generation ───────────────────────────────────────

const PLAN_SYSTEM_PROMPT_BASE = `You are a task planner for an AI agent. Given a user's goal and context, produce a structured execution plan.

Rules:
1. Each step should map to roughly one tool call or one reasoning action
2. Steps must be ordered by dependency
3. Mark all steps as "pending" initially
4. Set currentStepId to "1"
5. Define clear doneCriteria — what must be true for the task to be complete
6. Add notes for any assumptions, risks, or clarifications needed
7. CRITICAL: Break tasks into MULTIPLE concrete steps. Do NOT collapse everything into a single step.
   - Simple tasks (single lookup/answer): 2-3 steps
   - Medium tasks (research + synthesis, file operations): 3-5 steps
   - Complex tasks (multi-phase, multi-tool, analysis): 4-8 steps
   - Each step must have a SPECIFIC action, not a vague "do everything" description
   - Prefer granular steps: "Read file X" + "Analyze content" + "Report findings" over "Read and analyze file X and report"
   - [R25-T5] Step titles MUST be in Chinese (简体中文), clear, numbered, and actionable (e.g., "分析用户需求", "搜索相关信息", "生成结构化报告")
8. Each step MUST include a "tools" array listing the expected tool(s). Use the MOST SPECIFIC category:
   - "read": Read file content (cat/head/tail or read_file tool)
   - "write": Create or modify files (write_file/edit_file tools)
   - "inspect": Read-only system checks via shell (grep/ps/systemctl status/curl GET/sqlite3 SELECT/journalctl)
   - "shell": Shell commands with side effects (install/deploy/restart/delete/sed -i/echo >>)
   - "browser": Web page operations (navigate/screenshot/extract text/click elements)
   - "web_search": Internet search or knowledge retrieval
   - "none": Pure reasoning, no tool needed
   Selection guide:
   - grep/head/tail/sed -n/curl GET/systemctl status/ps/df/cat/wc → "inspect" (read-only shell, NOT "exec" or "read")
   - systemctl restart/npm install/docker run/rm/echo >>/sed -i → "shell" (side-effect commands)
   - Open URL/extract page text/take screenshot/click element → "browser"
   - Search internet for information → "web_search"
   - Read a file from disk → "read"; Write/create a file → "write"
   - Pure reasoning with no tool → "none"
9. Each step MUST include an "expectedTools" array with specific tool names expected to be called (e.g., ["shell_exec", "file_write", "browser_navigate"]). If unknown, use []. This is used for execution quality monitoring.
10. Each step MUST include a "rationale" explaining WHY this step is needed
11. Set plan_version to 1 for new plans
12. Write a brief "reflection" about your understanding of the task and chosen approach
13. [L4-PARALLEL] Set "dependsOn" for each step: list the step IDs it depends on. Steps with empty dependsOn can run in parallel. Example: steps 2 and 3 both only depend on step 1 → they can run concurrently.
14. [L4-FAILURE] Set "onFailure" for each step: "retry" for transient errors (network/timeout), "skip" for non-critical steps, "replan" for blockers that require a new strategy, "abort" only for fatal data-destructive failures. Default: "replan".
15. [L4-RETRY] Set "retryCount" for steps with onFailure="retry" (default 2, max 3).
16. [Iter-67-VALIDATION] The LAST step of every plan MUST be a validation/review step:
   - Title should be like "Verify results and report" or "Validate changes and confirm"
   - tools: ["inspect"] or ["inspect", "browser"] (read-only verification only)
   - This step checks: a) all previous steps completed successfully, b) no unintended side effects, c) core functionality still works
   - For code/sysadmin tasks: verify services are running, test key endpoints
   - For research tasks: verify all sources are cited, findings are consistent
   - NEVER skip this validation step. It is the quality gate.

17. [R70-TASK-BRIEF] Each step MUST include:
   - "taskBrief": A detailed task brief (max 500 chars) that specifies:
     * WHAT to do (specific files, commands, or actions)
     * HOW to do it (approach, tools to use, order of operations)
     * EXPECTED OUTPUT (what the result should look like)
     Example: "Read /opt/rangerai-agent/worker/planner.mjs lines 448-500. Extract the R8_PLAN_JSON_SCHEMA step properties. List each field name, type, and description in a markdown table. Output the table to stdout."
   - "acceptanceCriteria": A single verifiable criterion (e.g., "Output contains a markdown table with at least 8 rows" or "Service returns HTTP 200 on /api/health")
   - "critical": true if the step involves writing files, modifying code, deploying, or executing commands with side effects. false for read-only or inspection steps.
   - "reviewPolicy": "gpt_review" for critical steps and the final validation step. "auto_pass" for read-only/inspection steps. "final_only" for non-critical intermediate steps.
   IMPORTANT: taskBrief must be SPECIFIC and ACTIONABLE, not vague. Bad: "Analyze the code". Good: "Read planner.mjs lines 448-500, extract the JSON schema field definitions, output a summary table."
18. [GOVERNANCE-CONTINUOUS-EXEC] Plan for CONTINUOUS EXECUTION: steps flow automatically, no "report and wait" steps. Only pause for user input or irreversible operations. Final step delivers all results at once.
19. [GOVERNANCE-HIGH-RISK-ROUTING] High-risk operations (systemd, secrets, rm -rf, DROP TABLE, firewall, SSL, deploy, migration) → set intent to "review" or "validation", NOT "coding"/"sysadmin". Mark critical=true, reviewPolicy="gpt_review".
Output ONLY the JSON object. No markdown, no explanation, no preamble.

LANGUAGE RULE: The "goal" and step "title" fields MUST be written in Chinese (简体中文). The "reflection", "rationale", "doneCriteria", and "notes" fields should use English for precision. Example:
- goal: "清理 RangerAI 知识库中的重复条目并验证结果"
- title: "定位知识库数据源文件"
- rationale: "Need to find the knowledge base file to identify duplicates"`;

export const TASK_TYPE_STEP_GUIDANCE = {
  code: { min: 3, max: 6, hint: "For code tasks: 1) Understand requirements 2) Read existing code/context 3) Write implementation 4) Test/verify 5) Report results. Use tools like exec, read, write." },
  sysadmin: { min: 3, max: 6, hint: "For sysadmin tasks: 1) Check current state [inspect] 2) Execute changes [shell/write] 3) Verify results [inspect/browser] 4) Report summary. Use inspect for read-only checks (grep/ps/systemctl status/curl GET), shell for state-changing commands (restart/install/deploy), browser for web UI verification." },

  // R39-T3: Research task template
  research: { min: 4, max: 8, hint: "For research tasks: 1) Define research scope [analyze] 2) Search multiple sources [web_search x3] 3) Fetch detailed content [web_fetch/browser x3-5] 4) Cross-reference and validate [analyze] 5) Synthesize findings [write] 6) Format report with citations [write]. Always use 3+ search queries with different angles." },
  reasoning: { min: 2, max: 5, hint: "For reasoning tasks: 1) Break down the problem 2) Analyze each component 3) Draw conclusions 4) Present answer." },
  creative: { min: 2, max: 4, hint: "For creative tasks: 1) Understand the creative brief 2) Generate content 3) Refine and polish 4) Deliver." },
  chat: { min: 1, max: 2, hint: "For simple chat: 1) Respond directly. Keep it brief." },
  translation: { min: 1, max: 2, hint: "For translation: 1) Translate the content 2) Verify accuracy." },
  chinese_content: { min: 2, max: 4, hint: "For Chinese content tasks: 1) Understand requirements 2) Draft content 3) Refine 4) Deliver." },
  gaming: { min: 1, max: 3, hint: "For gaming queries: 1) Understand the question 2) Provide answer/strategy." },
};

export function buildPlanSystemPrompt(taskType) {
  const guidance = TASK_TYPE_STEP_GUIDANCE[taskType] || TASK_TYPE_STEP_GUIDANCE.reasoning;
  return PLAN_SYSTEM_PROMPT_BASE.replace(
    "1. Each step should map to roughly one tool call or one reasoning action",
    `1. Break the goal into ${guidance.min}-${guidance.max} concrete, actionable steps\n   Task type: ${taskType}. ${guidance.hint}\n2. Each step should map to roughly one tool call or one reasoning action`
  );
}

export const REPLAN_SYSTEM_PROMPT = `You are a task planner for an AI agent. The current plan needs revision because a step failed.
LANGUAGE: The "goal" and step "title" fields MUST be in Chinese (简体中文).
Given:
- The original goal
- The current plan with step statuses (done/failed/blocked/pending)
- The failed step details (tool name, error message)
- Recent observations (tool results, errors)
- List of already completed steps
Produce an UPDATED plan with recovery steps. Rules:
1. Keep completed steps (status="done") unchanged — do NOT modify them
2. Keep failed steps (status="failed") unchanged — they are historical record
3. Add NEW recovery/alternative steps to work around the failure
4. Use incremental step IDs for new steps (e.g., if step "2" failed, add "2r1", "2r2" or "3b", "4b")
5. Update currentStepId to the first new actionable step
6. Set needsReplan to false
7. If the failure is unrecoverable (missing permissions, resource unavailable), mark remaining steps as "blocked" with blockReason
8. Focus on PRACTICAL alternatives — if a file path was wrong, try a different path; if a command failed, try a corrected command
9. Increment plan_version from the previous version
10. Write a "reflection" explaining what went wrong and the recovery strategy
11. Each step MUST include an "expectedTools" array with specific tool names expected to be called. If unknown, use [].
Respond with valid JSON only, same schema as before.`;


const PLAN_TOOL_ALIASES = new Map([
  ['read', 'read'], ['cat', 'read'], ['head', 'read'], ['tail', 'read'], ['file_read', 'read'], ['read_file', 'read'],
  ['write', 'write'], ['edit', 'write'], ['edit_file', 'write'], ['write_file', 'write'], ['file_write', 'write'],
  ['inspect', 'inspect'], ['grep', 'inspect'], ['rg', 'inspect'], ['curl', 'inspect'], ['sqlite3', 'inspect'], ['journalctl', 'inspect'], ['ps', 'inspect'], ['ls', 'inspect'], ['wc', 'inspect'],
  ['exec', 'shell'], ['shell', 'shell'], ['shell_exec', 'shell'], ['systemctl', 'shell'], ['docker', 'shell'], ['npm', 'shell'], ['node', 'shell'],
  ['browser', 'browser'], ['browser_navigate', 'browser'], ['browser_snapshot', 'browser'], ['browser_click', 'browser'],
  ['web_search', 'web_search'], ['web_fetch', 'web_search'], ['search', 'web_search'],
  ['none', 'none'], ['reasoning', 'none'], ['think', 'none'],
]);

export function normalizePlanToolName(tool) {
  if (typeof tool !== 'string') return null;
  const t = tool.trim().toLowerCase();
  if (!t) return null;
  return PLAN_TOOL_ALIASES.get(t) || PLAN_TOOL_ALIASES.get(t.replace(/[^a-z0-9_]+/g, '_')) || null;
}

export function inferStepToolsConservatively(step) {
  const seeds = [];
  for (const value of [step.tools, step.expectedTools, step.tool, step.action, step.expectedAction]) {
    if (Array.isArray(value)) seeds.push(...value);
    else if (typeof value === 'string') seeds.push(...value.split(/[\s,，、|/]+/));
  }
  const normalized = [];
  for (const seed of seeds) {
    const mapped = normalizePlanToolName(seed);
    if (mapped && !normalized.includes(mapped)) normalized.push(mapped);
  }
  // Conservative text signals: only infer when the step explicitly names a concrete operation/tool family.
  const text = `${step.title || ''} ${step.description || ''} ${step.rationale || ''}`.toLowerCase();
  const textSignals = [
    [/\b(web_search|search web|internet search|google|搜索|检索)\b/i, 'web_search'],
    [/\b(browser|navigate|screenshot|click|网页|浏览器)\b/i, 'browser'],
    [/\b(read|cat|head|tail|查看文件|读取文件)\b/i, 'read'],
    [/\b(write|edit|patch|modify file|create file|写入|修改文件|编辑文件)\b/i, 'write'],
    [/\b(grep|rg|inspect|check|verify|node --check|curl get|status|验证|检查)\b/i, 'inspect'],
    [/\b(exec|shell|systemctl|docker|npm install|restart|deploy|命令|部署|重启)\b/i, 'shell'],
    [/\b(no tool|pure reasoning|reason only|无需工具|纯推理)\b/i, 'none'],
  ];
  for (const [pattern, mapped] of textSignals) {
    if (pattern.test(text) && !normalized.includes(mapped)) normalized.push(mapped);
  }
  if (normalized.includes('shell')) {
    return normalized.filter(t => t !== 'inspect');
  }
  return normalized;
}

// ─── [L4-PR2] Planner Step Contract Normalization ───────────────

/**
 * Normalize planner step fields added after the original R8 schema.
 * Keeps legacy/fallback plans compatible with L4 parallel/failure execution.
 * @param {Object|null} plan
 * @returns {Object|null}
 */
export function normalizePlanStepContract(plan) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const allowedFailureStrategies = new Set(['retry', 'skip', 'replan', 'abort']);
  const ids = new Set();
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i] || {};
    step.id = String(step.id || i + 1);
    step.title = step.title || step.description || `Step ${i + 1}`;
    step.description = step.description || step.title;
    step.status = step.status || 'pending';
    step.rationale = step.rationale || step.description || step.title;
    const inferredTools = inferStepToolsConservatively(step);
    step.tools = inferredTools.length > 0 ? inferredTools : [];
    step.expectedTools = Array.isArray(step.expectedTools) ? step.expectedTools : [...step.tools];
    if (step.expectedTools.length === 0 && step.tools.length > 0) step.expectedTools = [...step.tools];
    step.dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [];
    step.priority = ['high', 'medium', 'low'].includes(step.priority) ? step.priority : 'medium';
    step.onFailure = allowedFailureStrategies.has(step.onFailure) ? step.onFailure : 'replan';
    const retryCount = Number.isFinite(Number(step.retryCount)) ? Number(step.retryCount) : (step.onFailure === 'retry' ? 2 : 0);
    step.retryCount = Math.max(0, Math.min(3, retryCount));
    const retryAttempts = Number.isFinite(Number(step.retryAttempts)) ? Number(step.retryAttempts) : 0;
    step.retryAttempts = Math.max(0, retryAttempts);
    ids.add(step.id);
    plan.steps[i] = step;
  }
  for (const step of plan.steps) {
    step.dependsOn = [...new Set(step.dependsOn.filter(dep => dep !== step.id && ids.has(dep)))];
    step.canRunInParallel = typeof step.canRunInParallel === 'boolean'
      ? step.canRunInParallel
      : step.dependsOn.length === 0;
  }
  plan.currentStepId = plan.currentStepId ? String(plan.currentStepId) : (plan.steps[0]?.id || null);
  return plan;
}

// ─── [R8-Task3] JSON Parse with Fallback ───────────────────

/**
 * Parse LLM output as R8 JSON plan. If it fails, try legacy format, then fallback.
 * @param {string} content - Raw LLM output
 * @param {Object|null} existingPlan - Previous plan (for version increment)
 * @returns {{ plan: Object|null, method: string }}
 */
export function parseR8PlanOutput(content, existingPlan) {
  // Method 1: Direct JSON parse (expected path with response_format)
  try {
    const plan = JSON.parse(content.trim());

    // Validate R8 fields
    if (plan.plan_version !== undefined && plan.reflection !== undefined && Array.isArray(plan.steps)) {
      // Full R8 schema — validate steps have rationale
      // [R12-T4] Ensure every step has expectedTools (default to empty array)
      for (const step of plan.steps) {
        if (!step.expectedTools) step.expectedTools = [];
      }
      const hasRationale = plan.steps.every(s => s.rationale !== undefined);
      if (hasRationale) {
        logger.info(`[${ts()}] [R8-planner] JSON schema output parsed: plan_version=${plan.plan_version} steps=${plan.steps.length}`);
        return { plan, method: 'r8_json_schema' };
      }
      // R8 schema but missing rationale on some steps — still acceptable
      logger.info(`[${ts()}] [R8-planner] JSON schema output parsed (partial rationale): plan_version=${plan.plan_version} steps=${plan.steps.length}`);
      return { plan, method: 'r8_json_partial' };
    }

    // Legacy schema (pre-R8): has goal/steps but no plan_version/reflection
    if (plan.goal && Array.isArray(plan.steps) && plan.steps.length > 0) {
      // Upgrade to R8 format by adding missing fields
      plan.plan_version = existingPlan ? (existingPlan.plan_version || existingPlan.version || 0) + 1 : 1;
      plan.reflection = plan.notes?.[0] || 'Legacy plan format — auto-upgraded to R8';
      for (const step of plan.steps) {
        if (!step.rationale) step.rationale = step.title;
        if (!step.expectedTools) step.expectedTools = []; // [R12-T4]
      }
      logger.info(`[${ts()}] [R8-planner] Legacy JSON parsed and upgraded: plan_version=${plan.plan_version} steps=${plan.steps.length}`);
      return { plan, method: 'legacy_json_upgraded' };
    }

    logger.warn(`[${ts()}] [R8-planner] JSON parsed but invalid structure: keys=${Object.keys(plan).join(',')}`);
    return { plan: null, method: 'json_invalid_structure' };
  } catch (jsonErr) {
    // Method 2: Try to extract JSON from markdown code block
    const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        const plan = JSON.parse(codeBlockMatch[1].trim());
        if (plan.goal && Array.isArray(plan.steps)) {
          plan.plan_version = plan.plan_version || (existingPlan ? (existingPlan.plan_version || existingPlan.version || 0) + 1 : 1);
          plan.reflection = plan.reflection || 'Extracted from markdown code block';
          for (const step of plan.steps) {
            if (!step.rationale) step.rationale = step.title;
          }
          logger.warn(`[${ts()}] [R8-planner] fallback to code-block extraction: ${plan.steps.length} steps`);
          return { plan, method: 'code_block_fallback' };
        }
      } catch (_) { /* continue to next fallback */ }
    }

    // Method 3: Try to find JSON object in text
    const jsonMatch = content.match(/\{[\s\S]*"steps"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (jsonMatch) {
      try {
        const plan = JSON.parse(jsonMatch[0]);
        if (plan.steps && plan.steps.length > 0) {
          plan.plan_version = plan.plan_version || (existingPlan ? (existingPlan.plan_version || existingPlan.version || 0) + 1 : 1);
          plan.reflection = plan.reflection || 'Extracted from embedded JSON';
          plan.goal = plan.goal || 'auto-extracted';
          plan.doneCriteria = plan.doneCriteria || ['Task completed'];
          plan.notes = plan.notes || [];
          plan.needsReplan = plan.needsReplan || false;
          plan.currentStepId = plan.currentStepId || plan.steps[0]?.id || '1';
          for (const step of plan.steps) {
            if (!step.rationale) step.rationale = step.title;
          }
          logger.warn(`[${ts()}] [R8-planner] fallback to embedded JSON extraction: ${plan.steps.length} steps`);
          return { plan, method: 'embedded_json_fallback' };
        }
      } catch (_) { /* all fallbacks exhausted */ }
    }

    logger.warn(`[${ts()}] [R8-planner] all parse methods failed: ${jsonErr.message} | content preview: ${content.substring(0, 200)}`);
    return { plan: null, method: 'all_failed' };
  }
}
