// ─── R74 P0-1 / R75 P0-1+P0-2: Supervisor/Worker 双循环调度层 ───
// task-supervisor.mjs — Supervisor 调度层：安全筛选 + 委派 orchestrateWave + 生命周期事件 + 上下文隔离
//
// R75 升级：
//   - P0-1 superviseTask 现在内部调用 orchestrateWave 做并行调度（不再顺序 spawnWorker）
//   - P0-1 新增 getDelegatableSteps 可复用筛选函数
//   - P0-2 Worker 上下文隔离：大结果外化到 task-workspace，Context 只保留引用
//   - spawnWorker 保留作为单 Worker 备用路径

import { logger } from '../lib/logger.mjs';
import { emitLedgerEvent, EVENT_TYPES } from './event-stream.mjs';
import { normalizeWorkerResult, validateWorkerResult } from './worker-result-schema.mjs';
import { orchestrateWave, collectAndMerge } from './sub-agent-orchestrator.mjs';
import { initTaskWorkspace, writeTaskFile, buildWorkspaceBlock } from './task-workspace.mjs';

const ts = () => new Date().toISOString();

// ─── Worker 配置 ───
const DEFAULT_WORKER_TIMEOUT_MS = 120000; // 单个 Worker 超时 120s
const MAX_CONCURRENT_WORKERS = 3;         // 最大并发 Worker

/**
 * @typedef {Object} WorkerContext
 * @property {string} workerId     - 唯一 Worker ID
 * @property {string} taskId       - 父任务 ID
 * @property {string} sessionKey   - 会话 Key
 * @property {string} stepId       - 委派的步骤 ID
 * @property {'starting'|'running'|'completed'|'failed'|'retrying'} status
 * @property {number} retryCount   - 重试次数
 * @property {Object|null} result  - 标准化后的 Worker 结果
 */

/**
 * @typedef {Object} SupervisorOptions
 * @property {Function} [spawnSubAgent] - 子 Agent 创建函数
 * @property {number} [maxWorkers=3]    - 最大并发 Worker 数
 * @property {number} [timeoutMs=120000] - 单个 Worker 超时毫秒
 * @property {Object} [config]          - orchestrateWave 配置
 * @property {Object} [context]         - 上下文 { taskSummary, previousResults }
 * @property {Function} [compactFn]     - 结果压缩函数
 */

/**
 * 筛选可安全委派给 Worker 的步骤。
 * 规则：safe=true | workerEligible=true | intent 匹配 read/search/fetch/analyze
 *
 * @param {Object} plan - planner 计划对象 { steps[] }
 * @returns {Array<Object>} 可委派步骤列表
 */
export function getDelegatableSteps(plan) {
  if (!plan || !plan.steps || plan.steps.length === 0) return [];
  return plan.steps.filter(s =>
    s.safe === true ||
    s.workerEligible === true ||
    (s.intent && /^read|^search|^fetch|^analyze/i.test(s.intent))
  );
}

/**
 * 创建并启动一个 Worker 子任务（单 Worker 路径，保留备用）。
 *
 * @param {string} taskId - 父任务 ID
 * @param {string} sessionKey - 会话 Key
 * @param {Object} step - planner 步骤对象
 * @param {Object} options - { spawnSubAgent, timeoutMs, parentContext }
 * @returns {Promise<Object>} 标准化 Worker 结果
 */
export async function spawnWorker(taskId, sessionKey, step, options = {}) {
  const workerId = `worker-${taskId}-${step.id || step.stepId || Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const stepId = String(step.id || step.stepId || `step-${Date.now()}`);
  const timeoutMs = options.timeoutMs || DEFAULT_WORKER_TIMEOUT_MS;

  logger.info(`[${ts()}] [task-supervisor] spawnWorker: workerId=${workerId} task=${taskId} step=${stepId}`);

  emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_STARTED, {
    taskId,
    workerId,
    stepId,
    stepTitle: step.title || step.description || '',
    stepIntent: step.intent || null,
    timeoutMs,
  });

  const startTime = Date.now();
  let workerResult = null;
  let attempts = 0;
  const maxRetries = options.maxRetries ?? 1;

  while (attempts <= maxRetries) {
    attempts++;
    try {
      if (typeof options.spawnSubAgent === 'function') {
        const rawResult = await options.spawnSubAgent(
          attempts === 1 ? 0 : attempts,
          { id: stepId, title: step.title || step.description || stepId, description: step.description || '' },
          taskId,
          buildWorkerPrompt(step, options.parentContext || ''),
          { timeoutMs }
        );
        workerResult = normalizeWorkerResult({
          stepId,
          status: rawResult?.success !== false ? 'completed' : 'failed',
          evidence: rawResult?.result || rawResult?.text || '',
          summary: (rawResult?.result || rawResult?.text || '').substring(0, 500),
          nextRisk: rawResult?.success === false ? (rawResult?.error || 'Worker execution failed') : null,
          workerId,
          elapsedMs: Date.now() - startTime,
          attempt: attempts,
        });

        if (validateWorkerResult(workerResult)) {
          emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_COMPLETED, {
            taskId, workerId, stepId,
            elapsedMs: workerResult.elapsedMs,
            attempt: attempts,
            resultLength: workerResult.evidence ? workerResult.evidence.length : 0,
          });
          logger.info(`[${ts()}] [task-supervisor] Worker completed: ${workerId} elapsed=${workerResult.elapsedMs}ms`);
          return workerResult;
        } else {
          logger.warn(`[${ts()}] [task-supervisor] Worker result validation failed: ${workerId}`);
        }
      } else {
        workerResult = normalizeWorkerResult({
          stepId,
          status: 'skipped',
          evidence: '',
          summary: `Worker unavailable: no spawnSubAgent for step "${step.title || stepId}"`,
          nextRisk: 'no spawnSubAgent; worker skipped',
          workerId,
          elapsedMs: Date.now() - startTime,
          attempt: attempts,
        });
        logger.info(`[${ts()}] [task-supervisor] Worker skipped (no spawnSubAgent): ${workerId}`);
        return workerResult;
      }
    } catch (err) {
      logger.warn(`[${ts()}] [task-supervisor] Worker error (attempt ${attempts}/${maxRetries + 1}): ${workerId} - ${err.message}`);

      if (attempts <= maxRetries) {
        emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_RETRIED, {
          taskId, workerId, stepId,
          attempt: attempts,
          error: err.message,
          maxRetries,
        });
        await new Promise(r => setTimeout(r, 2000 * attempts));
      } else {
        emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_FAILED, {
          taskId, workerId, stepId,
          error: err.message,
          attempts,
          elapsedMs: Date.now() - startTime,
        });
        workerResult = normalizeWorkerResult({
          stepId,
          status: 'failed',
          evidence: '',
          summary: `Worker failed after ${attempts} attempts: ${err.message}`,
          nextRisk: err.message,
          workerId,
          elapsedMs: Date.now() - startTime,
          attempt: attempts,
        });
        return workerResult;
      }
    }
  }

  return workerResult;
}

/**
 * Supervisor 调度器（R75 升级）：接入 orchestrateWave 做并行子步骤调度。
 *
 * 流程：
 * 1. getDelegatableSteps 筛选安全子步骤
 * 2. 为每个 delegatable step emit WORKER_STARTED
 * 3. orchestrateWave 并行执行
 * 4. collectAndMerge 合并结果
 * 5. 为每个结果 emit WORKER_COMPLETED/FAILED
 *
 * @param {string} taskId - 父任务 ID
 * @param {string} sessionKey - 会话 Key
 * @param {Object} plan - planner 计划对象 { steps[], currentStepId }
 * @param {SupervisorOptions} options
 * @returns {Promise<{ taskId: string, waveId: number, results: Array, merged: Object|null, completed: number, failed: number, skipped: number, durationMs: number }>}
 */
export async function superviseTask(taskId, sessionKey, plan, options = {}) {
  if (!plan || !plan.steps || plan.steps.length === 0) {
    logger.info(`[${ts()}] [task-supervisor] No plan/steps, skip supervise for task=${taskId}`);
    return { taskId, waveId: -1, results: [], merged: null, completed: 0, failed: 0, skipped: 0, durationMs: 0 };
  }

  const delegatableSteps = getDelegatableSteps(plan);

  if (delegatableSteps.length === 0) {
    logger.info(`[${ts()}] [task-supervisor] No delegatable steps in plan for task=${taskId}`);
    return { taskId, waveId: -1, results: [], merged: null, completed: 0, failed: 0, skipped: 0, durationMs: 0 };
  }

  logger.info(`[${ts()}] [task-supervisor] superviseTask: task=${taskId} totalSteps=${plan.steps.length} delegatable=${delegatableSteps.length}`);

  const spawnSubAgent = options.spawnSubAgent;
  if (typeof spawnSubAgent !== 'function') {
    logger.info(`[${ts()}] [task-supervisor] No spawnSubAgent, injecting directive only task=${taskId}`);
    return {
      taskId,
      waveId: -1,
      results: delegatableSteps.map(s => normalizeWorkerResult({
        stepId: s.id || s.stepId || 'unknown',
        status: 'skipped',
        evidence: '',
        summary: 'No spawnSubAgent available; step not delegated',
        nextRisk: 'spawnSubAgent missing',
        workerId: `worker-${taskId}-${s.id || s.stepId || '?'}-nosub`,
      })),
      merged: null,
      completed: 0,
      failed: 0,
      skipped: delegatableSteps.length,
      durationMs: 0,
    };
  }

  // ─── Emit WORKER_STARTED for each delegatable step ───
  for (const step of delegatableSteps) {
    const stepId = step.id || step.stepId || 'unknown';
    const workerId = `worker-${taskId}-${stepId}-${Math.random().toString(36).slice(2, 6)}`;
    emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_STARTED, {
      taskId,
      workerId,
      stepId,
      stepTitle: step.title || step.description || '',
      stepIntent: step.intent || null,
    });
  }

  // [R77-T2] 提前创建工作区目录，Worker 可在执行期间使用 maybeExternalize
  initTaskWorkspace(taskId);

  // ─── 通过 orchestrateWave 并行执行 ───
  const waveStartTime = Date.now();
  const wave = await orchestrateWave(taskId, delegatableSteps, {
    spawnSubAgent,
    config: options.config || {},
    context: options.context || { taskSummary: '', previousResults: [] },
  });

  // ─── 合并结果 ───
  const merged = await collectAndMerge(taskId, wave.waveId, wave.results, {
    compactFn: options.compactFn || null,
  });

  // [R77-T2] Worker 上下文隔离：大结果外化到 task-workspace，主 Agent 上下文只保留摘要 + 文件引用
  // 阈值从 3000 → 2000，更积极外化
  const WORKSPACE_REPORT_THRESHOLD = 2000;
  let workspaceBlock = '';
  if (merged && merged.report && merged.report.length > WORKSPACE_REPORT_THRESHOLD) {
    initTaskWorkspace(taskId);
    writeTaskFile(taskId, 'worker-results.md', merged.report);
    workspaceBlock = buildWorkspaceBlock(taskId);
    const completedCount = merged.completedSteps?.length || 0;
    const failedSteps = merged.failedSteps || [];
    const summaryLines = [
      `[WORKER_RESULTS taskId="${taskId}"]`,
      `  完成: ${completedCount} 步骤, 失败: ${failedSteps.length} 步骤`,
    ];
    if (failedSteps.length > 0) {
      for (const fs of failedSteps) {
        summaryLines.push(`  ✗ ${fs.stepId || 'unknown'}: ${String(fs.error || fs.failureType || 'unknown').substring(0, 100)}`);
      }
    }
    summaryLines.push('  完整结果已外化到任务工作区');
    summaryLines.push('[/WORKER_RESULTS]');
    merged._originalReportLength = merged.report.length;
    merged.report = summaryLines.join('\n') + '\n\n' + workspaceBlock;
    logger.info(`[${ts()}] [task-supervisor] [R75-P0-2] Externalized worker results (${merged._originalReportLength} chars → ${merged.report.length} chars) to workspace for task=${taskId}`);
  }

  const durationMs = Date.now() - waveStartTime;

  // ─── Emit WORKER_COMPLETED/FAILED for each result ───
  let completed = 0, failed = 0, skipped = 0;
  for (const r of wave.results) {
    const stepId = r.stepId || 'unknown';
    const workerRef = `worker-${taskId}-${stepId}`;
    if (r.success) {
      completed++;
      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_COMPLETED, {
        taskId, workerId: workerRef, stepId,
        elapsedMs: durationMs,
        resultLength: r.result ? r.result.length : 0,
      });
    } else {
      failed++;
      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.WORKER_FAILED, {
        taskId, workerId: workerRef, stepId,
        error: r.error || r._failureType || 'unknown',
        elapsedMs: durationMs,
        failureType: r._failureType || null,
        recoveryAction: r._recoveryAction || null,
      });
    }
  }

  logger.info(`[${ts()}] [task-supervisor] superviseTask complete: task=${taskId} wave=${wave.waveId} completed=${completed} failed=${failed} skipped=${skipped} durationMs=${durationMs}`);

  // [R77-T2] 工作区保留，由 cleanup-sandboxes.sh 或 cron job 做 TTL 清理
  // 不立即删除：LLM 可能需要通过 buildWorkspaceBlock 引用已外化的完整结果

  return {
    taskId,
    waveId: wave.waveId,
    results: wave.results,
    merged,
    completed,
    failed,
    skipped,
    durationMs,
  };
}

/**
 * 构建 Worker 子 Agent 的执行 prompt。
 */
function buildWorkerPrompt(step, parentContext) {
  const lines = [
    '[WORKER_TASK]',
    `You are a Worker sub-agent executing a single safe sub-step.`,
    `Step ID: ${step.id || step.stepId || 'unknown'}`,
    `Step Title: ${step.title || step.description || 'Unnamed step'}`,
    `Step Intent: ${step.intent || 'execute'}`,
    step.description ? `Description: ${step.description}` : '',
    '',
    'INSTRUCTIONS:',
    '1. Execute ONLY this step. Do not expand scope.',
    '2. Use read/search/fetch tools — do NOT write files or modify system state.',
    '3. When done, output your result in the following JSON format:',
    '   { "stepId": "<id>", "status": "completed|failed", "evidence": "<details>", "summary": "<100-word summary>", "nextRisk": "<risk or null>" }',
    '4. Be concise. Focus on accuracy.',
  ];

  if (parentContext) {
    lines.push('');
    lines.push(`Parent task context: ${parentContext.substring(0, 500)}`);
  }

  lines.push('[/WORKER_TASK]');
  return lines.filter(Boolean).join('\n');
}

/**
 * 获取当前活跃的 Worker 摘要（供 context injection 使用）。
 *
 * @param {string} taskId
 * @param {Array<Object>} workerResults
 * @returns {string|null}
 */
export function getWorkerSummaryForContext(taskId, workerResults = []) {
  if (!workerResults || workerResults.length === 0) return null;

  const lines = [`[WORKER_RESULTS taskId="${taskId}"]`];
  for (const w of workerResults) {
    const statusIcon = w.status === 'completed' ? '✓' : w.status === 'failed' ? '✗' : '○';
    lines.push(`  ${statusIcon} [${w.stepId}] ${w.status} — ${(w.summary || '').substring(0, 150)}`);
  }
  lines.push('[/WORKER_RESULTS]');
  return lines.join('\n');
}

export default { spawnWorker, superviseTask, getWorkerSummaryForContext, getDelegatableSteps };
