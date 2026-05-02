/**
 * sub-agent-orchestrator.mjs — P0-2 Phase A: Sub-Agent Parallel Orchestration
 *
 * 非侵入式子 Agent 编排模块。为后续 GPT-5.5 集成到 openclaw-handler.mjs 做准备。
 *
 * 设计原则：
 *   - 纯 ESM，无副作用
 *   - 不直接 import 红线文件（planner.mjs / openclaw-handler.mjs）
 *   - 并行分派通过 opts.spawnSubAgent 注入函数执行
 *   - 并行判断通过 opts.getParallelBatches 注入 planner 函数
 *   - 所有导出都是纯函数或闭包内统计
 *
 * 导出：
 *   DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG
 *   shouldParallelize(taskId, opts)
 *   buildSubAgentPrompt(step, context, opts)
 *   orchestrateWave(taskId, waveSteps, opts)
 *   collectAndMerge(taskId, waveId, results, opts)
 *   getOrchestratorStats()
 *   resetOrchestratorStatsForTest()
 */

// ─── R74 P1-2: Failure Classification & Recovery ───────────────────────
import { classifyFailure, FAILURE_TYPE, getRecoveryStrategy, RECOVERY_ACTION, SEVERITY, diagnoseFailure, executeRecovery } from './failure-recovery.mjs';
import { emitLedgerEvent, EVENT_TYPES } from './event-stream.mjs'; // [R75-P1-2]
import { logger } from '../lib/logger.mjs';
import { createLogger } from './lib/structured-logger.mjs'; // R100: 结构化日志工厂
import { routeSubAgentModel } from './smart-router.mjs';
const ts = () => new Date().toISOString();

// ─── R74 P1-1: Step Safety Classifier ───────────────────────────────────
// Classifies steps by mutation risk to enable safe parallel execution.
// Rules:
//   READ_ONLY — 纯只读安全并行
//   MUTATE    — 有写操作需串行化
//   SHARED_WRITE — 操作共享资源（文件/DB），在同一 wave 内必须互斥串行

const WRITE_TOOLS = new Set([
  'write', 'edit', 'exec', 'bash', 'shell', 'run', 'deploy',
  'replace', 'create', 'delete', 'remove', 'rm', 'mv', 'cp',
  'git', 'npm', 'pnpm', 'yarn', 'pip', 'apt', 'systemctl', 'restart',
]);

const READ_TOOLS = new Set([
  'read', 'grep', 'cat', 'head', 'tail', 'ls', 'find', 'stat',
  'git log', 'git diff', 'git status', 'git show',
  'node --check', 'node -e', 'echo', 'wc', 'which', 'type',
  'ps', 'ss', 'netstat', 'df', 'du', 'free', 'uptime', 'whoami',
]);

function classifyStepSafety(step) {
  const tools = (Array.isArray(step.tools) ? step.tools : (step.tools ? step.tools.split(/[,;]/) : [])).map(t => t.trim().toLowerCase());
  const desc = (step.description || step.title || '').toLowerCase();

  // No tools listed → assume read
  if (tools.length === 0) return 'READ_ONLY';

  const hasWrite = tools.some(t => WRITE_TOOLS.has(t));
  const hasRead = tools.every(t => READ_TOOLS.has(t) || !WRITE_TOOLS.has(t));

  // Explicit write tools → MUTATE
  if (hasWrite) return 'MUTATE';

  // All tools are read-only → READ_ONLY
  if (hasRead) return 'READ_ONLY';

  // Heuristic: keywords in description indicate mutation intent
  const mutateKeywords = /修改|创建|删除|写入|部署|重启|构建|安装|迁移|alter|create|delete|insert|update|drop|deploy|restart|build|install|migrate/;
  if (mutateKeywords.test(desc)) return 'MUTATE';

  return 'READ_ONLY';
}

function hasSharedResource(steps) {
  // Detect shared filesystem/DB resources across steps
  const resources = new Map(); // resource → [stepIds]
  for (const s of steps) {
    const desc = (s.description || s.title || '').toLowerCase();
    const fileMatches = desc.match(/[\w\/.-]+\.(mjs|js|json|ts|tsx|md|css|html|py|yaml|yml|sql)/g) || [];
    for (const f of fileMatches) {
      if (!resources.has(f)) resources.set(f, []);
      resources.get(f).push(s.id);
    }
  }
  // Return steps that share resources with others
  const shared = new Set();
  for (const [, ids] of resources) {
    if (ids.length > 1) ids.forEach(id => shared.add(id));
  }
  return shared;
}

// ─── P2-1: DependsOn batch safety validator ──────────────────────────────
// Verifies that steps in the same parallel batch that share mutable resources
// have explicit dependsOn declarations. Gaps indicate planner missed a dependency.

/**
 * 验证一个并行 batch 的 dependsOn 完整性。
 * 如果两个 MUTATE 步骤共享资源但没有声明 dependsOn 关系，报告为缺口。
 *
 * @param {Array<object>} batchSteps - 同一 wave 内的步骤
 * @returns {{ safe: boolean, gaps: Array<{stepA: string, stepB: string, sharedResources: string[], recommendation: string}>, muteCount: number }}
 */
export function validateBatchDependencies(batchSteps) {
  if (!batchSteps || batchSteps.length < 2) {
    return { safe: true, gaps: [], muteCount: 0 };
  }

  const gaps = [];
  let muteCount = 0;

  // Classify each step
  const classified = batchSteps.map(s => ({
    id: String(s.id),
    level: classifyStepSafety(s),
    deps: new Set((Array.isArray(s.dependsOn) ? s.dependsOn : []).map(String)),
  }));

  // Find all MUTATE steps
  const muteSteps = classified.filter(c => c.level === 'MUTATE');
  muteCount = muteSteps.length;

  if (muteSteps.length < 2) {
    return { safe: true, gaps: [], muteCount };
  }

  // Extract resource references from each step's description
  const stepResources = new Map();
  for (const s of batchSteps) {
    const desc = (s.description || s.title || '').toLowerCase();
    const matches = desc.match(/[\w\/.-]+\.(mjs|js|json|ts|tsx|md|css|html|py|yaml|yml|sql|db)/g) || [];
    stepResources.set(String(s.id), matches);
  }

  // Check each pair of MUTATE steps
  for (let i = 0; i < muteSteps.length; i++) {
    for (let j = i + 1; j < muteSteps.length; j++) {
      const a = muteSteps[i];
      const b = muteSteps[j];

      // If they already have explicit dependsOn, skip
      if (a.deps.has(b.id) || b.deps.has(a.id)) continue;

      // Check for shared resources
      const aRes = stepResources.get(a.id) || [];
      const bRes = stepResources.get(b.id) || [];
      const shared = aRes.filter(r => bRes.includes(r));

      if (shared.length > 0) {
        gaps.push({
          stepA: a.id,
          stepB: b.id,
          sharedResources: shared,
          recommendation: `建议声明 dependsOn: step "${a.id}" 和 "${b.id}" 共享资源 [${shared.join(', ')}]，应显式声明依赖关系`,
        });
      }
    }
  }

  return {
    safe: gaps.length === 0,
    gaps,
    muteCount,
  };
}

// ─── Default Configuration ────────────────────────────────────────────────

export const DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG = {
  enabled: true,                   // 全局开关
  maxConcurrent: 5,                // 最大并行子 Agent 数
  timeoutMs: 120000,               // 单个子 Agent 超时 (ms)
  minStepsForParallel: 2,          // wave 中至少 N 个步骤才并行
  fallbackToSerial: true,          // 并行失败时降级为串行
  maxRetries: 1,                   // P1-2: 单个步骤最大重试次数
  retryDelayMs: 2000,              // P1-2: 重试前等待时间 (ms)
  enableSafetyCheck: true,         // P1-1: 启用步骤安全分类，MUTATE+共享资源自动降级串行
  auditDependsOn: true,            // P2-1: 审计 dependsOn 缺口，MUTATE+共享资源但无 dependsOn → 日志警告
  strictDependsOn: false,          // P2-1: 严格模式 — 无 dependsOn 的 MUTATE+共享资源拒绝并行（强制串行，默认关闭）
};

// ─── Internal Stats (module-scoped, reset-table for tests) ───────────────

let _stats = {
  totalWaves: 0,
  totalSubAgents: 0,
  totalCompleted: 0,
  totalFailed: 0,
  totalTimeouts: 0,
  averageWaveDurationMs: 0,
  _durations: [],                   // 内部累积，用于计算平均值
  // P1-2: retry stats
  totalRetried: 0,
  totalRecovered: 0,
};

function _recordStats(waveDurationMs, completed, failed, timedOut, retried = 0, recovered = 0) {
  _stats.totalWaves++;
  _stats.totalSubAgents += completed + failed + timedOut;
  _stats.totalCompleted += completed;
  _stats.totalFailed += failed;
  _stats.totalTimeouts += timedOut;
  _stats.totalRetried += retried;
  _stats.totalRecovered += recovered;
  _stats._durations.push(waveDurationMs);
  const total = _stats._durations.reduce((a, b) => a + b, 0);
  _stats.averageWaveDurationMs = Math.round(total / _stats._durations.length);
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * 判断给定 taskId 的当前 wave 是否应该并行执行。
 *
 * @param {string} taskId - 任务 ID
 * @param {object} opts
 * @param {Function} opts.getParallelBatches - 注入的 planner.getParallelBatches 函数
 * @param {object} [opts.config] - 配置覆盖，与 DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG 合并
 * @returns {{ should: boolean, reason: string, waveIndex: number, waveSteps: Array<object> }}
 */
export function shouldParallelize(taskId, opts = {}) {
  const getParallelBatches = opts.getParallelBatches;
  if (typeof getParallelBatches !== 'function') {
    return { should: false, reason: 'getParallelBatches 未注入', waveIndex: -1, waveSteps: [] };
  }

  const config = { ...DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG, ...(opts.config || {}) };

  if (!config.enabled) {
    return { should: false, reason: '编排器已禁用 (enabled=false)', waveIndex: -1, waveSteps: [] };
  }

  let batches;
  try {
    batches = getParallelBatches(taskId);
  } catch (err) {
    return { should: false, reason: `getParallelBatches 异常: ${err.message}`, waveIndex: -1, waveSteps: [] };
  }

  if (!batches || batches.length === 0) {
    return { should: false, reason: '无待执行步骤', waveIndex: -1, waveSteps: [] };
  }

  // 找到第一个包含多个 pending step 的 wave
  for (let i = 0; i < batches.length; i++) {
    const wave = batches[i];
    const pendingSteps = wave.filter(
      s => s.status === 'pending' || s.status === 'doing' || s.status === 'retrying'
    );
    if (pendingSteps.length >= config.minStepsForParallel) {
      return {
        should: true,
        reason: `wave[${i}] 包含 ${pendingSteps.length} 个可并行步骤 (minSteps=${config.minStepsForParallel})`,
        waveIndex: i,
        waveSteps: pendingSteps.slice(0, config.maxConcurrent), // 不超过并发上限
      };
    }
  }

  return { should: false, reason: '无可并行 wave (所有 wave 步数 < minStepsForParallel)', waveIndex: -1, waveSteps: [] };
}

/**
 * 为子 Agent 构建执行 prompt。
 *
 * @param {object} step - 计划步骤对象，至少含 { id, title, description?, tools? }
 * @param {object} context - 上下文对象
 * @param {string} [context.taskSummary] - 任务总摘要
 * @param {Array<string>} [context.previousResults] - 前序 wave 结果摘要
 * @param {object} [opts] - 选项
 * @returns {string} 子 Agent prompt
 */
export function buildSubAgentPrompt(step, context = {}, opts = {}) {
  const stepTitle = step.title || step.id || '未命名步骤';
  const stepDesc = step.description || '';
  const stepTools = Array.isArray(step.tools) ? step.tools.join(', ') : (step.tools || '通用工具');
  const taskSummary = context.taskSummary || '';
  const previousResults = Array.isArray(context.previousResults) && context.previousResults.length > 0
    ? `\n前序结果摘要：\n${context.previousResults.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

  return [
    `你是 RangerAI 的子 Agent，负责执行以下子任务。`,
    taskSummary ? `\n【任务总目标】${taskSummary}` : '',
    `\n【当前子任务】`,
    `- 步骤 ID: ${step.id || 'unknown'}`,
    `- 标题: ${stepTitle}`,
    stepDesc ? `- 描述: ${stepDesc}` : '',
    `- 可用工具: ${stepTools}`,
    previousResults,
    `\n【执行要求】`,
    `1. 仅执行当前子任务，不要扩展到其他步骤`,
    `2. 完成后输出完成状态和产物路径`,
    `3. 如遇到不可恢复的错误，明确标记为失败`,
  ].filter(Boolean).join('\n');
}

/**
 * 执行一个并行的子任务 wave。R74 P1-1/2 已实现：
 *  - P1-1: 按步骤安全等级分组，MUTATE 共享资源步骤降级串行
 *  - P1-2: ✅ 失败步骤自动 classify → recovery 策略 → 条件重试 (retryable + RETRY_IMMEDIATE/DELAYED)→ 分类数据注入结果
 *
 * @param {string} taskId - 父任务 ID
 * @param {Array<object>} waveSteps - 待执行的步骤数组
 * @param {object} opts
 * @param {Function} opts.spawnSubAgent - 注入的子 Agent 生成函数
 *   (stepIndex, step, taskId, prompt) => Promise<{ stepId: string, success: boolean, result: string, error?: string }>
 * @param {object} [opts.context] - 上下文（传递给 buildSubAgentPrompt）
 * @param {object} [opts.config] - 配置覆盖
 * @returns {Promise<{ taskId: string, waveId: number, results: Array<object>, durationMs: number }>}
 */
export async function orchestrateWave(taskId, waveSteps, opts = {}) {
  const config = { ...DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG, ...(opts.config || {}) };
  const spawnSubAgent = opts.spawnSubAgent;
  const context = opts.context || {};

  if (typeof spawnSubAgent !== 'function') {
    throw new Error('orchestrateWave: opts.spawnSubAgent 函数未注入');
  }

  if (!waveSteps || waveSteps.length === 0) {
    return { taskId, waveId: _stats.totalWaves, results: [], durationMs: 0 };
  }

  const startTime = Date.now();
  const waveId = _stats.totalWaves;

  // 限制并发数
  const stepsToExecute = waveSteps.slice(0, config.maxConcurrent);

  // ─── P1-1: Step safety classification — serialize MUTATE steps with shared resources ──
  let serialSteps = [];
  let parallelSteps = stepsToExecute;
  if (config.enableSafetyCheck !== false && stepsToExecute.length > 1) {
    const safetyLevels = stepsToExecute.map(s => ({
      step: s,
      level: classifyStepSafety(s),
    }));
    const sharedResourceSteps = hasSharedResource(stepsToExecute);
    const mutateShared = safetyLevels.filter(s => s.level === 'MUTATE' && sharedResourceSteps.has(s.step.id));

    if (mutateShared.length > 0) {
      // Split: MUTATE+shared-resource steps run serially; everything else runs in parallel
      const mutateSharedIds = new Set(mutateShared.map(m => m.step.id));
      parallelSteps = stepsToExecute.filter(s => !mutateSharedIds.has(s.id));
      serialSteps = stepsToExecute.filter(s => mutateSharedIds.has(s.id));
      logger.info(`[${ts()}] [P1-1] Safety split: ${parallelSteps.length} parallel + ${serialSteps.length} serial (shared-resource MUTATE: ${[...mutateSharedIds].join(', ')})`);
    }
    // Tag safety level on each step for downstream reporting
    stepsToExecute.forEach(s => {
      const lv = safetyLevels.find(sl => sl.step.id === s.id);
      if (lv) s._safetyLevel = lv.level;
    });
  }

  // ─── P2-1: Audit dependsOn gaps in parallel batch ────────────────────
  if (config.auditDependsOn !== false && parallelSteps.length > 1) {
    // Merge all steps back for the audit (serial + parallel, since planner's topological sort
    // already separates dependsOn-linked steps into different batches)
    const allSteps = [...serialSteps, ...parallelSteps];
    const audit = validateBatchDependencies(allSteps);
    if (!audit.safe && audit.gaps.length > 0) {
      for (const gap of audit.gaps) {
        logger.warn(`[${ts()}] [P2-1] dependsOn gap: ${gap.recommendation}`);
      }
      // 严格模式：将缺口步骤从并行降级到串行
      if (config.strictDependsOn) {
        const gapIds = new Set();
        for (const g of audit.gaps) { gapIds.add(g.stepA); gapIds.add(g.stepB); }
        // Move gapped steps from parallel to serial
        const newSerial = parallelSteps.filter(s => gapIds.has(String(s.id)));
        if (newSerial.length > 0) {
          parallelSteps = parallelSteps.filter(s => !gapIds.has(String(s.id)));
          serialSteps = [...serialSteps, ...newSerial];
          logger.info(`[${ts()}] [P2-1] strictDependsOn: moved ${newSerial.length} gapped steps to serial (${newSerial.map(s => s.id).join(', ')})`);
        }
      }
    }
  }

  // Helper: execute a batch of steps in parallel (extracted for reuse in parallel + serial fallback)
  const executeParallelBatch = async (batchSteps, baseIndex = 0) => {
    const tasks = batchSteps.map((step, index) => {
      const prompt = buildSubAgentPrompt(step, context, opts);
      const route = routeSubAgentModel(step, prompt);
      if (route?.model) step._subAgentRoute = route;
      else delete step._subAgentRoute;
      logger.info(`[${ts()}] [R93] sub-agent route step=${step.id || baseIndex + index} category=${route.category} model=${route.model || 'default'} reason=${route.reason}`);
      return { step, index: baseIndex + index, prompt, route };
    });

    const taskPromises = tasks.map(({ step, index, prompt, route }) => {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`子 Agent 超时: step=${step.id || index}, timeoutMs=${config.timeoutMs}`)),
          config.timeoutMs
        );
      });
      return Promise.race([
        spawnSubAgent(index, step, taskId, prompt, route),
        timeoutPromise,
      ]).then(
        result => ({ ...result, stepId: step.id || `step-${index}`, timedOut: false, _safetyLevel: step._safetyLevel || null }),
        err => ({ stepId: step.id || `step-${index}`, success: false, result: '', error: err.message, timedOut: true, _safetyLevel: step._safetyLevel || null })
      ).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    });

    return Promise.allSettled(taskPromises);
  };

  // Execute serial steps one at a time first, then parallel batch
  let allSettledResults = [];
  if (serialSteps.length > 0) {
    for (const sstep of serialSteps) {
      const batchResult = await executeParallelBatch([sstep], 0);
      allSettledResults.push(batchResult[0]);
      if (batchResult[0].status === 'rejected' || (batchResult[0].status === 'fulfilled' && !batchResult[0].value?.success)) {
        // If a serial step fails, tag the remaining serial steps as skipped
        sstep._serialized = true;
      }
    }
  }
  if (parallelSteps.length > 0) {
    const parallelResults = await executeParallelBatch(parallelSteps, serialSteps.length);
    allSettledResults = allSettledResults.concat(parallelResults);
  }

  const results = allSettledResults;

  // ─── P1-2: classfiy each failure and retry if recovery strategy allows ──
  let totalRetried = 0;
  let totalRecovered = 0;

  // Map steps by id for O(1) lookup (needed after P1-1 serial/parallel reorder)
  const stepById = new Map();
  for (const s of waveSteps) {
    stepById.set(s.id, s);
    // also map by index-based id for backwards compat
    const idx = waveSteps.indexOf(s);
    stepById.set(`step-${idx}`, s);
  }

  const classifyAndRetry = async (result, resultIndex) => {
    if (result.status === 'fulfilled' && result.value?.success) {
      return result.value; // already succeeded
    }
    const rawValue = result.status === 'fulfilled' ? result.value : null;
    const stepId = rawValue?.stepId || `step-${resultIndex}`;
    const step = stepById.get(stepId) || {};
    const errorMsg = result.status === 'fulfilled'
      ? (rawValue?.error || '未知错误')
      : (result.reason?.message || '未知错误');
    const timedOut = result.status === 'fulfilled' ? !!rawValue?.timedOut : true;

    // Classify the failure
    const toolList = Array.isArray(step?.tools) ? step.tools.join(',') : (step?.tools || '');
    const failureType = classifyFailure(errorMsg, toolList);
    const recovery = getRecoveryStrategy(failureType, { attempts: 0 });

    logger.info(`[${ts()}] [P1-2] Step ${stepId} failed: ${failureType}, recovery=${recovery.action}, severity=${recovery.severity}`);

    // If retryable and under maxRetries, attempt retry
    if (recovery.retryable && config.maxRetries > 0) {
      // Only retry for RETRY_IMMEDIATE or RETRY_DELAYED actions
      if (recovery.action === RECOVERY_ACTION.RETRY_IMMEDIATE ||
          recovery.action === RECOVERY_ACTION.RETRY_DELAYED) {
        const delayMs = recovery.delayMs || config.retryDelayMs || 2000;
        logger.info(`[${ts()}] [P1-2] Retrying step ${stepId} after ${delayMs}ms (attempt 1/${config.maxRetries})`);
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

        totalRetried++;
        try {
          const prompt = buildSubAgentPrompt(step, context, opts);
          const retryRoute = routeSubAgentModel(step, prompt);
          const retryResult = await spawnSubAgent(resultIndex, step, taskId, prompt, retryRoute);
          if (retryResult?.success) {
            totalRecovered++;
            logger.info(`[${ts()}] [P1-2] Step ${stepId} recovered after retry`);
            return {
              ...retryResult,
              stepId,
              timedOut: false,
              _retried: true,
              _recovered: true,
            };
          }
          // Retry failed too — still return failed with classification
          logger.warn(`[${ts()}] [P1-2] Step ${stepId} retry also failed: ${retryResult?.error || 'unknown'}`);
          return {
            stepId,
            success: false,
            result: '',
            error: retryResult?.error || errorMsg,
            timedOut,
            _retried: true,
            _recovered: false,
            _failureType: failureType,
            _recoveryAction: recovery.action,
            _severity: recovery.severity,
          };
        } catch (retryErr) {
          logger.warn(`[${ts()}] [P1-2] Step ${stepId} retry threw: ${retryErr.message}`);
          return {
            stepId,
            success: false,
            result: '',
            error: retryErr.message || errorMsg,
            timedOut,
            _retried: true,
            _recovered: false,
            _failureType: failureType,
            _recoveryAction: recovery.action,
            _severity: recovery.severity,
          };
        }
      }
    }

    // Not retryable or recovery says skip/abort/fallback — execute the appropriate recovery action
    const diagnosis = diagnoseFailure(errorMsg, toolList, { attempts: 0 });
    let recoveryResult = { shouldRetry: false, shouldReplan: false, shouldSkip: false };
    try {
      recoveryResult = await executeRecovery(diagnosis, { taskId, stepId });
      logger.info(`[${ts()}] [P1-2] Step ${stepId} recovery executed: action=${recovery.action} shouldSkip=${recoveryResult.shouldSkip} needsHuman=${recoveryResult.needsHuman} shouldReplan=${recoveryResult.shouldReplan} abort=${recoveryResult.abort}`);
    } catch (recoveryExecErr) {
      logger.warn(`[${ts()}] [P1-2] Step ${stepId} recovery execution failed: ${recoveryExecErr.message}`);
    }
    return {
      stepId,
      success: false,
      result: '',
      error: errorMsg,
      timedOut,
      _retried: false,
      _failureType: failureType,
      _recoveryAction: recovery.action,
      _severity: recovery.severity,
      _shouldSkip: recoveryResult.shouldSkip || false,
      _needsHuman: recoveryResult.needsHuman || false,
      _shouldAbort: recoveryResult.abort || false,
      _shouldReplan: recoveryResult.shouldReplan || false,
    };
  };

  // Process all results — classify failures and retry where applicable
  const normalizedResults = await Promise.all(results.map(classifyAndRetry));

  const durationMs = Date.now() - startTime;

  const completed = normalizedResults.filter(r => r.success).length;
  const failed = normalizedResults.filter(r => !r.success && !r.timedOut).length;
  const timedOut2 = normalizedResults.filter(r => r.timedOut && !r.success).length;

  _recordStats(durationMs, completed, failed, timedOut2, totalRetried, totalRecovered);

  // 降级串行：如果设置了 fallbackToSerial，将失败项标记为需要串行重试
  if (config.fallbackToSerial && normalizedResults.some(r => !r.success)) {
    normalizedResults.forEach(r => {
      if (!r.success) {
        r._fallbackToSerial = true;
        r._fallbackReason = r.timedOut ? 'timeout' : (r._failureType || 'failure');
      }
    });
  }

  return { taskId, waveId, results: normalizedResults, durationMs };
}

/**
 * 收集并合并多个子 Agent 的结果，输出结构化报告。
 * 容忍部分失败，不因单个子 Agent 失败而阻断整体流程。
 *
 * @param {string} taskId - 父任务 ID
 * @param {number|string} waveId - wave 编号
 * @param {Array<object>} results - orchestrateWave 返回的 results 数组
 * @param {object} [opts] - 选项
 * @param {Function} [opts.compactFn] - 可选的压缩函数 (result) => Promise<string>
 * @returns {Promise<object>} { taskId, waveId, summary, report, completedSteps, failedSteps, artifacts, _mergedAt }
 */
export async function collectAndMerge(taskId, waveId, results, opts = {}) {
  const compactFn = opts.compactFn || null;

  if (!results || results.length === 0) {
    return {
      taskId,
      waveId,
      summary: '空 wave，无子 Agent 结果',
      report: '无结果',
      completedSteps: [],
      failedSteps: [],
      artifacts: [],
      _mergedAt: new Date().toISOString(),
    };
  }

  const completedSteps = [];
  const failedSteps = [];
  const artifacts = [];

  for (const r of results) {
    const stepId = r.stepId || 'unknown';

    // 可选压缩
    let resultText = r.result || '';
    if (compactFn && typeof compactFn === 'function' && resultText) {
      try {
        resultText = await compactFn(resultText);
      } catch (e) {
        // 压缩失败不影响结果收集
        resultText = `[压缩失败] ${resultText.substring(0, 200)}`;
      }
    }

    if (r.success) {
      completedSteps.push({
        stepId,
        result: resultText,
        error: null,
      });
      // 提取产物路径
      if (resultText) {
        const pathMatches = resultText.match(/[\w\/\.-]+\.(js|mjs|json|md|ts|tsx|css|html|py|sh|yaml|yml|toml)/g);
        if (pathMatches) {
          pathMatches.forEach(p => artifacts.push({ stepId, path: p }));
        }
      }
    } else {
      failedSteps.push({
        stepId,
        error: r.error || '未知错误',
        timedOut: !!r.timedOut,
        fallbackToSerial: !!r._fallbackToSerial,
        // P1-2: failure classification data
        failureType: r._failureType || FAILURE_TYPE.UNKNOWN_ERROR,
        recoveryAction: r._recoveryAction || RECOVERY_ACTION.ABORT,
        severity: r._severity || SEVERITY.MEDIUM,
        retried: !!r._retried,
        recovered: !!r._recovered,
        partialResult: resultText ? resultText.substring(0, 500) : null,
      });
    }
  }

  const totalCount = completedSteps.length + failedSteps.length;
  const completedIds = completedSteps.map(s => s.stepId).join(', ') || '无';
  const failedIds = failedSteps.map(s => s.stepId).join(', ') || '无';
  const failureDetails = failedSteps.map(f =>
    `  - ${f.stepId}: ${f.error} [${f.failureType}] → ${f.recoveryAction}${f.retried ? (f.recovered ? ' (已恢复)' : ' (重试失败)') : ''}${f.fallbackToSerial ? ' [已标记降级串行]' : ''}`
  ).join('\n');

  const summary = [
    `Wave ${waveId} 执行完成: ${completedSteps.length}/${totalCount} 成功`,
    failedSteps.length > 0 ? `，${failedSteps.length} 个失败` : '',
    failedSteps.some(f => f.recovered) ? ` [${failedSteps.filter(f => f.recovered).length} 个经重试恢复]` : '',
  ].join('');

  const report = [
    `## Wave ${waveId} 执行报告`,
    ``,
    `完成步骤 (${completedSteps.length}): ${completedIds}`,
    `失败步骤 (${failedSteps.length}): ${failedIds}`,
    failureDetails ? `\n失败详情:\n${failureDetails}` : '',
    artifacts.length > 0 ? `\n产物:\n${artifacts.map(a => `  - [${a.stepId}] ${a.path}`).join('\n')}` : '',
  ].join('\n');

  return {
    taskId,
    waveId,
    summary,
    report,
    completedSteps,
    failedSteps,
    artifacts,
    _mergedAt: new Date().toISOString(),
  };
}

// ─── [R75-P1-2] Parallel Wave Handler — 从 openclaw-handler 提取到编排器 ───
/**
 * 处理并行 wave 的完整生命周期：检测 → 委派 superviseTask → 结果合并 → 事件发送 → 进度标记。
 * 从 openclaw-handler.mjs 提取，减少 handler 行数。
 *
 * @param {string} msgId
 * @param {string} sessionKey
 * @param {Object} _parallel — planner 并行检测结果 { waveIndex, waveSteps, reason, should }
 * @param {Object} opts
 * @param {Function} opts.spawnSubAgent — 子 Agent 创建函数
 * @param {Object} opts.subAgentOrchestratorConfig — 编排器配置
 * @param {string} opts.userMessage — 用户原始消息
 * @param {string} opts.enrichedMessage — 当前富文本消息（可能被修改并返回）
 * @param {Object} opts.agentLoopModules — handler 的模块缓存 { pl }
 * @param {Function} opts.compactSubAgentResult — 子 Agent 结果压缩
 * @param {Function} opts.progressMarkStepDone — 进度标记函数
 * @param {Function} opts.sendEvent — IPC 事件发送
 * @param {Function} opts.superviseTask — Supervisor 调度函数（回调注入，避免循环依赖）
 * @returns {Promise<{ enrichedMessage: string, completed: number, failed: number, skipped: number, waveId: number|string, durationMs: number }>}
 */
export async function handleParallelWave(msgId, sessionKey, _parallel, opts = {}) {
  const {
    spawnSubAgent,
    subAgentOrchestratorConfig = {},
    userMessage = '',
    enrichedMessage = '',
    agentLoopModules = {},
    compactSubAgentResult,
    progressMarkStepDone,
    sendEvent,
    superviseTask,
  } = opts;

  if (!_parallel.should) {
    return { enrichedMessage, completed: 0, failed: 0, skipped: 0, waveId: -1, durationMs: 0 };
  }

  sendEvent(msgId, {
    type: 'parallel_wave_detected',
    waveIndex: _parallel.waveIndex,
    stepCount: _parallel.waveSteps.length,
    steps: _parallel.waveSteps.map(s => ({ id: s.id, title: s.title || s.description || '' })),
    reason: _parallel.reason,
  });
  emitLedgerEvent(sessionKey, msgId, EVENT_TYPES.PARALLEL_WAVE_DETECTED, {
    waveId: `wave-${_parallel.waveIndex}`,
    waveIndex: _parallel.waveIndex,
    stepCount: _parallel.waveSteps.length,
    steps: _parallel.waveSteps.map(s => ({ id: s.id, title: s.title || s.description || '' })),
  });
  logger.info(`[${ts()}] [R75-P1-2] Parallel wave detected: wave=${_parallel.waveIndex}, steps=${_parallel.waveSteps.length}, reason=${_parallel.reason}`);

  if (typeof spawnSubAgent !== 'function' || typeof superviseTask !== 'function') {
    // No sub-agent capability — inject directive text instead
    const directive = `\n\n[PARALLEL_SUBAGENT_DIRECTIVE]\nPlanner detected a parallel wave (${_parallel.reason}). If sub-agent tools are available, delegate these independent steps in parallel and merge results before continuing:\n${_parallel.waveSteps.map((s, i) => `${i + 1}. ${s.id || `step-${i + 1}`}: ${s.title || s.description || 'untitled step'}`).join('\n')}\n[/PARALLEL_SUBAGENT_DIRECTIVE]`;
    logger.info(`[${ts()}] [R75-P1-2] Parallel directive injected; spawnSubAgent/superviseTask unavailable`);
    return { enrichedMessage: enrichedMessage + directive, completed: 0, failed: 0, skipped: _parallel.waveSteps.length, waveId: -1, durationMs: 0 };
  }

  const plan = agentLoopModules?.pl?.getPlan?.(msgId) || {
    steps: _parallel.waveSteps,
    currentStepId: _parallel.waveSteps[0]?.id,
  };

  const supResult = await superviseTask(msgId, sessionKey, plan, {
    spawnSubAgent,
    config: subAgentOrchestratorConfig,
    context: {
      taskSummary: userMessage.substring(0, 1000),
      previousResults: [],
    },
    compactFn: compactSubAgentResult
      ? async (text) => {
          const r = await compactSubAgentResult(
            [{ role: 'assistant', content: text }],
            { agentId: `sup-${msgId}`, taskDescription: userMessage.substring(0, 200) }
          );
          return r.report;
        }
      : null,
  });

  let newEnriched = enrichedMessage;
  let completed = 0, failed = 0, skipped = 0;

  if (supResult.merged && supResult.completed > 0) {
    newEnriched = `${enrichedMessage}\n\n[PARALLEL_SUBAGENT_RESULTS]\n${supResult.merged.report}\n[/PARALLEL_SUBAGENT_RESULTS]`;
    completed = supResult.completed;
    failed = supResult.failed;
    sendEvent(msgId, {
      type: 'parallel_wave_completed',
      waveId: supResult.waveId,
      completed: supResult.completed,
      failed: supResult.failed,
      durationMs: supResult.durationMs,
    });
    emitLedgerEvent(sessionKey, msgId, EVENT_TYPES.PARALLEL_WAVE_COMPLETED, {
      waveId: supResult.waveId,
      completed: supResult.completed,
      failed: supResult.failed,
      durationMs: supResult.durationMs,
    });
    logger.info(`[${ts()}] [R75-P1-2] Supervisor wave completed: wave=${supResult.waveId} completed=${supResult.completed} failed=${supResult.failed}`);

    // Mark completed sub-agent steps in progress tracker
    if (progressMarkStepDone && supResult.merged.completedSteps?.length > 0) {
      for (const cs of supResult.merged.completedSteps) {
        try { progressMarkStepDone(sessionKey, cs.stepId); } catch (e) {
          logger.warn(`[${ts()}] [R75-P1-2] markStepDone failed for ${cs.stepId}: ${e.message}`);
        }
      }
    }
  } else if (supResult.skipped > 0) {
    skipped = supResult.skipped;
    logger.info(`[${ts()}] [R75-P1-2] Supervisor skipped ${skipped} step(s) — no delegatable match`);
  }

  return {
    enrichedMessage: newEnriched,
    completed,
    failed,
    skipped,
    waveId: supResult.waveId,
    durationMs: supResult.durationMs,
  };
}

/**
 * 获取编排器统计信息。
 * @returns {{ totalWaves: number, totalSubAgents: number, totalCompleted: number, totalFailed: number, totalTimeouts: number, averageWaveDurationMs: number }}
 */
export function getOrchestratorStats() {
  return { ..._stats };
}

/**
 * 重置编排器统计（仅用于测试）。
 */
export function resetOrchestratorStatsForTest() {
  _stats = {
    totalWaves: 0,
    totalSubAgents: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalTimeouts: 0,
    averageWaveDurationMs: 0,
    _durations: [],
    totalRetried: 0,
    totalRecovered: 0,
  };
}
