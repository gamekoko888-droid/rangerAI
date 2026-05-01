/**
 * RangerAI Workflow Scheduler v5 — 结构化步骤执行引擎 + 自主任务 Cron 调度
 * 2026-03-24 v3: 结构化步骤执行
 * 2026-04-01 v4: P1 自主任务 cron 调度
 * 2026-04-01 v5: #6 修复 evaluateCondition 未定义 bug
 *                #7 新增 loop/retry/parallel 步骤类型
 *   - 扫描 autonomous_tasks 表中 scheduleCron + isRecurring=1 的任务
 *   - 匹配 cron 表达式后通过 Redis IPC 提交给 ws-realtime 进程执行
 *   - 自动更新 lastRunAt / nextRunAt 字段
 *   - 防重复执行：检查 lastRunAt 是否在当前分钟内
 */
import { logger } from './lib/logger.mjs';
import { validateDeps } from './lib/context.mjs';
import {
  createWorkflowRun as kdbCreateRun,
  updateWorkflowRun as kdbUpdateRun,
  incrementWorkflowRunCount as kdbIncrRunCount,
  updateWorkflowNextRun as kdbUpdateNextRun,
  getCronEnabledWorkflows as kdbGetCronWorkflows,
} from './knowledge-db.mjs';
import { sendCommand, sendRequest } from './lib/redis-ipc.mjs';

const REQUIRED_DEPS = ['db'];

let deps = null;
let schedulerInterval = null;
let isRunning = false;

export function init(injected) {
  validateDeps(REQUIRED_DEPS, injected, 'workflow-scheduler');
  deps = injected;
}

const db = () => deps.db;

// ─── Cron Parsing ────────────────────────────────────────────
export function parseCronField(field, min, max) {
  if (field === '*') return null;
  const values = new Set();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      let start = min, end = max;
      if (range !== '*') {
        if (range.includes('-')) { [start, end] = range.split('-').map(Number); }
        else { start = parseInt(range, 10); }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      for (let i = s; i <= e; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return values;
}

export function matchesCron(cronExpression, date) {
  if (!cronExpression) return false;
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monthF, dowF] = parts;
  const checks = [
    { field: minF,   value: date.getMinutes(),     min: 0,  max: 59 },
    { field: hourF,  value: date.getHours(),        min: 0,  max: 23 },
    { field: domF,   value: date.getDate(),         min: 1,  max: 31 },
    { field: monthF, value: date.getMonth() + 1,   min: 1,  max: 12 },
    { field: dowF,   value: date.getDay(),          min: 0,  max: 6  },
  ];
  for (const { field, value, min, max } of checks) {
    const allowed = parseCronField(field, min, max);
    if (allowed !== null && !allowed.has(value)) return false;
  }
  return true;
}

export function getNextRunTime(cronExpression) {
  if (!cronExpression) return null;
  const now = new Date();
  for (let i = 1; i <= 1440; i++) {
    const candidate = new Date(now.getTime() + i * 60000);
    candidate.setSeconds(0, 0);
    if (matchesCron(cronExpression, candidate)) return candidate.toISOString();
  }
  return null;
}

// ─── 调用内部 AI（通过 rangerai-agent HTTP API）────────────────
async function callAI(prompt, sessionKey) {
  const http = (await import('http')).default;
  const body = JSON.stringify({
    message: prompt,
    model: 'openai/gpt-4.1-mini',
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3002,
      path: `/api/chat/simple`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-call': '1',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.reply || parsed.content || parsed.message || data);
        } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('AI call timeout')); });
    req.write(body); req.end();
  });
}

// ─── 调用外部 HTTP（step type: http_request）────────────────────
async function callHttp(step, context) {
  const url = interpolate(step.url || '', context);
  const method = (step.method || 'GET').toUpperCase();
  const bodyStr = step.body ? interpolate(JSON.stringify(step.body), context) : null;

  const { default: http } = step.url?.startsWith('https') 
    ? await import('https') 
    : await import('http');

  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search, method,
      headers: { 'Content-Type': 'application/json', ...(step.headers || {}) },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── 模板变量替换 {{step_N_output}} ──────────────────────────────
export function interpolate(template, context) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] ?? `{{${key}}}`);
}

// ─── #6 Fix: evaluateCondition — 条件表达式求值 ──────────────────
/**
 * 支持的表达式格式：
 *   - "value1 > value2"   (数值比较: >, <, >=, <=, ==, !=)
 *   - "value1 equals value2"  (字符串相等)
 *   - "haystack contains needle" (字符串包含)
 *   - "value exists"      (非空检查)
 *   - "value empty"       (空值检查)
 *   - "true" / "false"    (字面量)
 *   - 纯数值 → truthy (非零为 true)
 */
export function evaluateCondition(expr, context) {
  if (!expr || typeof expr !== 'string') return false;
  const trimmed = expr.trim();

  // 字面量
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;

  // "value exists" — 非空检查
  const existsMatch = trimmed.match(/^(.+?)\s+exists$/i);
  if (existsMatch) {
    const val = existsMatch[1].trim();
    return val !== '' && val !== 'undefined' && val !== 'null' && !val.startsWith('{{');
  }

  // "value empty" — 空值检查
  const emptyMatch = trimmed.match(/^(.+?)\s+empty$/i);
  if (emptyMatch) {
    const val = emptyMatch[1].trim();
    return val === '' || val === 'undefined' || val === 'null' || val.startsWith('{{');
  }

  // "haystack contains needle"
  const containsMatch = trimmed.match(/^(.+?)\s+contains\s+(.+)$/i);
  if (containsMatch) {
    return containsMatch[1].trim().toLowerCase().includes(containsMatch[2].trim().toLowerCase());
  }

  // "value1 equals value2"
  const equalsMatch = trimmed.match(/^(.+?)\s+equals\s+(.+)$/i);
  if (equalsMatch) {
    return equalsMatch[1].trim() === equalsMatch[2].trim();
  }

  // 数值比较: >, <, >=, <=, ==, !=
  const cmpMatch = trimmed.match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const left = parseFloat(cmpMatch[1].trim());
    const right = parseFloat(cmpMatch[3].trim());
    if (!isNaN(left) && !isNaN(right)) {
      switch (cmpMatch[2]) {
        case '>':  return left > right;
        case '<':  return left < right;
        case '>=': return left >= right;
        case '<=': return left <= right;
        case '==': return left === right;
        case '!=': return left !== right;
      }
    }
    // 非数值 fallback 到字符串比较
    const ls = cmpMatch[1].trim(), rs = cmpMatch[3].trim();
    if (cmpMatch[2] === '==') return ls === rs;
    if (cmpMatch[2] === '!=') return ls !== rs;
  }

  // 纯数值 → truthy
  const num = parseFloat(trimmed);
  if (!isNaN(num)) return num !== 0;

  // 非空字符串 → true（已插值的变量有值）
  return trimmed !== '' && !trimmed.startsWith('{{');
}

// ─── 核心：结构化步骤执行 ──────────────────────────────────────
export async function executeWorkflowSteps(workflow, runId, triggeredBy = 'cron') {
  const steps = typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : (workflow.steps || []);

  if (!steps.length) {
    logger.info(`[scheduler] Workflow ${workflow.name} has no steps`);
    return { success: true, stepResults: [] };
  }

  try {
    if (runId) await kdbUpdateRun(runId, { status: 'running' });
  } catch(_err) { /* v22.0 */ logger.error("[workflow-scheduler] silent catch:", _err?.message || _err); }

  const context = { workflow_name: workflow.name, triggered_by: triggeredBy };
  const stepResults = [];
  let allSuccess = true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepKey = `step_${i + 1}`;
    const stepName = step.name || `步骤${i + 1}`;
    const stepType = step.type || 'ai_prompt';
    const maxRetries = step.retry || 0; // #7: retry count (0 = no retry)

    logger.info(`[scheduler] [${workflow.name}] 执行 ${stepName} (${stepType})`);

    // #7: loop step — 重复执行子步骤直到条件成立或达到最大次数
    if (stepType === 'loop') {
      const maxIterations = step.maxIterations || 10;
      const loopCondition = step.until || 'true'; // 退出条件
      const loopSteps = step.steps || [];
      let iteration = 0;
      let loopOutput = '';
      try {
        while (iteration < maxIterations) {
          iteration++;
          context[`${stepKey}_iteration`] = iteration;
          logger.info(`[scheduler] [${workflow.name}] ${stepName} 循环第 ${iteration}/${maxIterations} 次`);

          // 执行 loop 内的子步骤
          for (let j = 0; j < loopSteps.length; j++) {
            const subStep = loopSteps[j];
            const subKey = `${stepKey}_sub_${j + 1}`;
            const subType = subStep.type || 'ai_prompt';
            let subOutput = '';
            if (subType === 'ai_prompt') {
              const prompt = interpolate(subStep.prompt || '', context);
              subOutput = prompt.trim() ? await callAI(prompt, `wf-${workflow.id}-${runId}-loop${iteration}-${j}`) : '';
            } else if (subType === 'http_request') {
              subOutput = await callHttp(subStep, context);
            }
            context[`${subKey}_output`] = subOutput;
            loopOutput = subOutput; // 最后一个子步骤的输出作为 loop 输出
          }

          // 检查退出条件
          const condExpr = interpolate(loopCondition, context);
          if (evaluateCondition(condExpr, context)) {
            logger.info(`[scheduler] [${workflow.name}] ${stepName} 循环在第 ${iteration} 次满足退出条件`);
            break;
          }
        }
        context[`${stepKey}_output`] = loopOutput;
        context[`${stepKey}_iterations`] = iteration;
        stepResults.push({ step: i + 1, name: stepName, type: stepType, status: 'success', output: `Loop completed: ${iteration} iterations`, iterations: iteration });
        logger.info(`[scheduler] [${workflow.name}] ${stepName} 循环完成，共 ${iteration} 次`);
      } catch (loopErr) {
        logger.error(`[scheduler] [${workflow.name}] ${stepName} 循环失败:`, loopErr.message);
        context[`${stepKey}_output`] = `[ERROR: ${loopErr.message}]`;
        stepResults.push({ step: i + 1, name: stepName, type: stepType, status: 'failed', error: loopErr.message });
        allSuccess = false;
        if (step.stopOnError !== false) break;
      }
      continue;
    }

    // #7: parallel step — 并行执行多个独立子步骤
    if (stepType === 'parallel') {
      const parallelSteps = step.steps || [];
      try {
        logger.info(`[scheduler] [${workflow.name}] ${stepName} 并行执行 ${parallelSteps.length} 个子步骤`);
        const parallelPromises = parallelSteps.map(async (subStep, j) => {
          const subKey = `${stepKey}_sub_${j + 1}`;
          const subType = subStep.type || 'ai_prompt';
          let subOutput = '';
          if (subType === 'ai_prompt') {
            const prompt = interpolate(subStep.prompt || '', context);
            subOutput = prompt.trim() ? await callAI(prompt, `wf-${workflow.id}-${runId}-par${j}`) : '';
          } else if (subType === 'http_request') {
            subOutput = await callHttp(subStep, context);
          } else if (subType === 'browser') {
            const browserPrompt = interpolate(subStep.prompt || '', context);
            const browserMsgId = `wf_par_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            try {
              const result = await sendRequest({
                type: 'dispatch_task',
                payload: { msgId: browserMsgId, sessionKey: `wf_par_${workflow.id}_${j}`, content: browserPrompt, history: [], model: null }
              }, 300000);
              subOutput = typeof result?.reply === 'string' ? result.reply : JSON.stringify(result?.reply || '');
            } catch (e) {
              subOutput = `[Browser error: ${e.message}]`;
            }
          }
          return { key: subKey, name: subStep.name || `并行${j + 1}`, output: subOutput };
        });

        const results = await Promise.allSettled(parallelPromises);
        const outputs = [];
        for (const r of results) {
          if (r.status === 'fulfilled') {
            context[`${r.value.key}_output`] = r.value.output;
            outputs.push(`${r.value.name}: ${r.value.output.slice(0, 500)}`);
          } else {
            outputs.push(`[FAILED: ${r.reason?.message || 'unknown'}]`);
          }
        }
        const combinedOutput = outputs.join('\n---\n');
        context[`${stepKey}_output`] = combinedOutput;
        stepResults.push({ step: i + 1, name: stepName, type: stepType, status: 'success', output: combinedOutput.slice(0, 2000), parallelCount: parallelSteps.length });
        logger.info(`[scheduler] [${workflow.name}] ${stepName} 并行完成，${results.length} 个子步骤`);
      } catch (parErr) {
        logger.error(`[scheduler] [${workflow.name}] ${stepName} 并行失败:`, parErr.message);
        context[`${stepKey}_output`] = `[ERROR: ${parErr.message}]`;
        stepResults.push({ step: i + 1, name: stepName, type: stepType, status: 'failed', error: parErr.message });
        allSuccess = false;
        if (step.stopOnError !== false) break;
      }
      continue;
    }

    // #7: retry wrapper for normal steps
    let lastErr = null;
    let retrySuccess = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // exponential backoff, max 30s
        logger.info(`[scheduler] [${workflow.name}] ${stepName} 重试 ${attempt}/${maxRetries}，等待 ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

    try {
      let output = '';

      if (stepType === 'ai_prompt') {
        const prompt = interpolate(step.prompt || step.description || '', context);
        if (!prompt.trim()) {
          output = '[跳过：prompt 为空]';
        } else {
          output = await callAI(prompt, `wf-${workflow.id}-${runId}`);
        }
      } else if (stepType === 'http_request') {
        output = await callHttp(step, context);
      } else if (stepType === 'notification') {
        const { sendNotification } = await import('./notification-service.mjs');
        const channel = step.channel || 'console';
        const notifTitle = interpolate(step.title || step.name || 'Workflow Notification', context);
        const notifContent = interpolate(step.content || step.prompt || '', context);
        const result = await sendNotification({
          channel,
          title: notifTitle,
          content: notifContent,
          webhookUrl: step.webhookUrl,
          extra: { workflowName: workflow.name, runId }
        });
        output = JSON.stringify(result);
      } else if (stepType === 'condition') {
        const condExpr = interpolate(step.condition || '', context);
        const condResult = evaluateCondition(condExpr, context);
        context[`${stepKey}_condition`] = condResult;
        output = `Condition evaluated: ${condResult}`;
        if (!condResult && step.skipTo) {
          const skipIdx = steps.findIndex(s => s.name === step.skipTo);
          if (skipIdx > i) {
            logger.info(`[scheduler] Condition false, skipping to "${step.skipTo}" (step ${skipIdx + 1})`);
            i = skipIdx - 1;
          }
        }
      } else if (stepType === 'browser') {
        // P2: Real browser control via workerManager.sendTask() through Redis IPC
        // Uses dispatch_task to go through the full OpenClaw Agent pipeline
        // which includes browser_navigate, browser_click, etc.
        const browserPrompt = interpolate(step.prompt || '', context);
        const browserSessionKey = `wf_browser_${workflow.id}_${runId}_step${i + 1}`;
        const browserMsgId = `wf_browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const browserSystemPrompt = [
          'You are a browser automation agent. You have full browser access.',
          'Use browser tools (browser_navigate, browser_click, browser_input, browser_screenshot) to complete the task.',
          'Extract and return the requested data as structured text.',
          `Workflow: ${workflow.name}, Step: ${stepName}`,
        ].join('\n');

        try {
          const result = await sendRequest({
            type: 'dispatch_task',
            payload: {
              msgId: browserMsgId,
              sessionKey: browserSessionKey,
              content: browserPrompt,
              history: [{ role: 'system', content: browserSystemPrompt }],
              model: null,  // Use default model
            }
          }, 300000); // 5 min timeout for browser tasks
          output = typeof result?.reply === 'string' 
            ? result.reply 
            : (result?.reply?.content || result?.reply?.text || JSON.stringify(result?.reply || ''));
          logger.info(`[scheduler] [${workflow.name}] Browser step completed via Agent pipeline`);
        } catch (browserErr) {
          // Fallback to callAI if dispatch_task fails
          logger.warn(`[scheduler] [${workflow.name}] Browser dispatch_task failed: ${browserErr.message}, falling back to callAI`);
          const fullPrompt = `You have browser access. Please complete this task using the browser:\n\n${browserPrompt}\n\nReturn the results as structured text.`;
          output = await callAI(fullPrompt, `wf-${workflow.id}-${runId}-browser`);
        }
      } else {
        output = `[不支持的步骤类型: ${stepType}]`;
      }

      context[`${stepKey}_output`] = output;
      stepResults.push({ step: i + 1, name: stepName, type: stepType, status: 'success', output: output.slice(0, 2000), attempts: attempt + 1 });
      logger.info(`[scheduler] [${workflow.name}] ${stepName} 完成，输出 ${output.length} 字符${attempt > 0 ? ` (重试 ${attempt} 次后成功)` : ''}`);
      retrySuccess = true;
      break; // success, exit retry loop

    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        logger.warn(`[scheduler] [${workflow.name}] ${stepName} 第 ${attempt + 1} 次尝试失败: ${err.message}`);
        continue; // retry
      }
      // All retries exhausted
      logger.error(`[scheduler] [${workflow.name}] ${stepName} 失败 (${attempt + 1} 次尝试):`, err.message);
      context[`${stepKey}_output`] = `[ERROR: ${err.message}]`;
      stepResults.push({ step: i + 1, name: stepName, type: stepType, status: 'failed', error: err.message, attempts: attempt + 1 });
      allSuccess = false;

      if (step.stopOnError !== false) {
        logger.warn(`[scheduler] [${workflow.name}] 步骤失败，终止执行`);
        break;
      }
    }
    } // end retry loop
    if (!retrySuccess && lastErr && step.stopOnError !== false) break;
  }

  const finalResult = JSON.stringify({ stepResults, context: Object.fromEntries(
    Object.entries(context).filter(([k]) => k.endsWith('_output'))
  )});
  try {
    if (runId) await kdbUpdateRun(runId, {
      status: allSuccess ? 'completed' : 'failed',
      result: finalResult,
      completedAt: new Date().toISOString(),
    });
  } catch (e) {
    logger.error('[scheduler] Failed to save run result:', e.message);
  }

  try { await kdbIncrRunCount(workflow.id); } catch(_err) { /* v22.0 */ logger.error("[workflow-scheduler] silent catch:", _err?.message || _err); }
  const nextRun = getNextRunTime(workflow.cronExpression);
  if (nextRun) { try { await kdbUpdateNextRun(workflow.id, nextRun); } catch(_err) { /* v22.0 */ logger.error("[workflow-scheduler] silent catch:", _err?.message || _err); } }

  return { success: allSuccess, stepResults };
}

// ─── P1: 自主任务 Cron 调度 ──────────────────────────────────
/**
 * 扫描 autonomous_tasks 表中 scheduleCron + isRecurring=1 的任务，
 * 匹配当前时间后通过 Redis IPC 提交给 ws-realtime 进程执行。
 * 
 * 防重复机制：
 *   1. 检查 lastRunAt 是否在当前分钟内（同一分钟不重复触发）
 *   2. 只扫描 status 为 completed/failed/queued 的任务（排除 running）
 *   3. 提交前立即更新 lastRunAt 和 nextRunAt
 */
async function checkAndRunScheduledAutonomousTasks() {
  let dbMod;
  try {
    dbMod = await import('./db-adapter.mjs');
    try { await dbMod.initAdapter(); } catch (_) { /* already initialized */ }
  } catch (e) {
    logger.warn('[scheduler-cron] Failed to import db-adapter:', e.message);
    return;
  }

  try {
    // Query recurring tasks with a cron schedule that are not currently running
    const tasks = await dbMod.query(
      `SELECT id, userId, title, description, type, templateId, templateParams,
              scheduleCron, lastRunAt, nextRunAt, status
       FROM autonomous_tasks
       WHERE scheduleCron IS NOT NULL
         AND scheduleCron != ''
         AND isRecurring = 1
         AND status NOT IN ('running')`,
      []
    );

    if (!tasks || tasks.length === 0) return;

    const now = new Date();
    now.setSeconds(0, 0);
    const nowMinuteStr = now.toISOString().slice(0, 16); // "2026-04-01T09:00"

    for (const task of tasks) {
      try {
        // Check if cron matches current minute
        if (!matchesCron(task.scheduleCron, now)) continue;

        // Dedup: skip if lastRunAt is within the same minute
        if (task.lastRunAt) {
          const lastMinute = task.lastRunAt.slice(0, 16);
          if (lastMinute === nowMinuteStr) {
            continue; // Already ran this minute
          }
        }

        logger.info(`[scheduler-cron] Cron match for autonomous task: ${task.id} "${task.title}" (cron: ${task.scheduleCron})`);

        // Immediately update lastRunAt and nextRunAt to prevent duplicate triggers
        const nextRun = getNextRunTime(task.scheduleCron);
        await dbMod.run(
          `UPDATE autonomous_tasks 
           SET lastRunAt = ?, nextRunAt = ?, status = 'queued'
           WHERE id = ?`,
          [now.toISOString(), nextRun, task.id]
        );

        // Create a new task instance for this cron run
        // We generate a unique ID for the new execution
        const runTaskId = `atask_cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        
        // Resolve the task prompt: use description directly, or expand from template
        let taskPrompt = task.description || '';
        if (task.templateId && !taskPrompt) {
          try {
            const template = await dbMod.queryOne(
              'SELECT prompt FROM task_templates WHERE id = ?',
              [task.templateId]
            );
            if (template) {
              taskPrompt = template.prompt;
              const params = typeof task.templateParams === 'string' 
                ? JSON.parse(task.templateParams) 
                : (task.templateParams || {});
              for (const [key, value] of Object.entries(params)) {
                taskPrompt = taskPrompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
              }
            }
          } catch (tplErr) {
            logger.warn(`[scheduler-cron] Template resolve failed for ${task.id}: ${tplErr.message}`);
          }
        }

        if (!taskPrompt) {
          taskPrompt = task.title; // Fallback to title as prompt
        }

        // Insert a new autonomous_tasks row for this cron execution
        await dbMod.run(
          `INSERT INTO autonomous_tasks (id, userId, type, title, description, templateId, templateParams, status, priority, scheduleCron, isRecurring)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 5, NULL, 0)`,
          [
            runTaskId,
            task.userId || 'system',
            task.type || 'general',
            `[定时] ${task.title}`,
            taskPrompt,
            task.templateId || null,
            task.templateParams || '{}',
          ]
        );

        // Submit to ws-realtime via Redis IPC
        const sent = await sendCommand({
          type: 'submit_autonomous_task',
          taskId: runTaskId,
          userId: task.userId || 'system',
          title: `[定时] ${task.title}`,
          description: taskPrompt,
          taskType: task.type || 'general',
          priority: 5,
          cronParentId: task.id, // Reference to the recurring parent task
          isCronTriggered: true,
        });

        if (sent) {
          logger.info(`[scheduler-cron] Submitted cron task ${runTaskId} (parent: ${task.id}) via Redis IPC`);
        } else {
          logger.warn(`[scheduler-cron] Redis IPC sendCommand failed for task ${runTaskId}`);
        }

      } catch (taskErr) {
        logger.error(`[scheduler-cron] Error processing task ${task.id}: ${taskErr.message}`);
      }
    }
  } catch (err) {
    logger.error('[scheduler-cron] Error in autonomous task cron scan:', err.message);
  }
}

// ─── Scheduler Loop ──────────────────────────────────────────
async function checkAndRunScheduledWorkflows() {
  if (isRunning) return;
  isRunning = true;
  try {
    // Part 1: Original workflow cron scanning
    const workflows = await kdbGetCronWorkflows();
    const now = new Date();
    now.setSeconds(0, 0);
    
    if (workflows && workflows.length > 0) {
      for (const wf of workflows) {
        if (matchesCron(wf.cronExpression, now)) {
          logger.info(`[scheduler] Cron match: ${wf.name}`);
          let runId = null;
          try {
            const runRecord = await kdbCreateRun({ workflowId: wf.id, triggeredBy: 'cron' });
            runId = runRecord?.id || null;
          } catch (e) {
            logger.warn('[scheduler] createWorkflowRun failed:', e.message);
          }
          await executeWorkflowSteps(wf, runId, 'cron').catch(e =>
            logger.error(`[scheduler] executeWorkflowSteps failed for ${wf.name}:`, e.message)
          );
        }
      }
    }

    // Part 2: P1 — Autonomous task cron scanning
    await checkAndRunScheduledAutonomousTasks();

  } catch (err) {
    logger.error('[scheduler] Error in scheduler loop:', err.message);
  } finally {
    isRunning = false;
  }
}

export function startScheduler() {
  if (schedulerInterval) { logger.info('[scheduler] Already running'); return; }
  logger.info('[scheduler] Starting workflow + autonomous task scheduler (60s interval)');
  schedulerInterval = setInterval(checkAndRunScheduledWorkflows, 60 * 1000);
  checkAndRunScheduledWorkflows();
}

export function stopScheduler() {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  logger.info('[scheduler] Stopped');
}
