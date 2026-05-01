/**
 * run-tracker.mjs — Run 全链路追踪 (Iter-H)
 *
 * 功能：
 * 1. 每次用户请求生成一个 RunTrace
 * 2. 记录所有工具调用步骤、token 消耗、耗时
 * 3. 计算 0-100 的质量评分
 *    - 工具成功率 60%
 *    - 速度 20%（基于预期时间）
 *    - 步骤效率 20%（实际步骤 vs 最优步骤估计）
 * 4. 提供 /api/system/run-traces 查询接口
 *
 * 设计原则：
 * - 内存环形缓冲区（最近 200 条），不写 DB
 * - 零侵入：try-catch 包裹
 * - 异步：非阻塞
 */
import { logger } from '../lib/logger.mjs';

// ─── 配置 ─────────────────────────────────────
const MAX_TRACES = 200;
const EXPECTED_MS_PER_STEP = 3000;   // 每步预期 3s
const MAX_EXPECTED_STEPS = 30;        // 超过 30 步视为低效
const SPEED_BASELINE_MS = 60000;      // 60s 内完成得满分

// ─── 环形缓冲区 ──────────────────────────────
const _traces = [];
let _traceIndex = 0;
const _activeRuns = new Map(); // runId -> trace (for backward compat with setCurrentRunId)

/**
 * @typedef {Object} ToolStep
 * @property {string} toolName
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} durationMs
 * @property {'success'|'error'|'blocked'} status
 * @property {string} [error]
 * @property {number} [tokensUsed]
 */

/**
 * @typedef {Object} RunTrace
 * @property {string} runId
 * @property {string} sessionKey
 * @property {string} [userId]
 * @property {number} startMs
 * @property {number} [endMs]
 * @property {number} [totalMs]
 * @property {'running'|'completed'|'error'} status
 * @property {ToolStep[]} steps
 * @property {number} totalTokens
 * @property {number} [qualityScore]
 * @property {Object} [scoreBreakdown]
 */

/**
 * 开始一个新的 Run 追踪
 * @param {string} runId — 通常是 msgId
 * @param {Object} meta — { sessionKey, userId }
 * @returns {RunTrace}
 */
export function startRun(runId, { sessionKey = '', userId = '' } = {}) {
  try {
    const trace = {
      runId,
      sessionKey,
      userId,
      startMs: Date.now(),
      endMs: null,
      totalMs: null,
      status: 'running',
      steps: [],
      totalTokens: 0,
      qualityScore: null,
      scoreBreakdown: null,
      createdAt: new Date().toISOString(),
    };

    // 环形缓冲区插入
    if (_traces.length < MAX_TRACES) {
      _traces.push(trace);
    } else {
      _traces[_traceIndex % MAX_TRACES] = trace;
    }
    _traceIndex++;
    _activeRuns.set(runId, trace); // Track active run

    return trace;
  } catch (e) {
    logger.error('[run-tracker] startRun failed (non-fatal):', e.message);
    return null;
  }
}

/**
 * 记录一个工具调用步骤
 * @param {string} runId
 * @param {string} toolName
 * @param {'start'|'end'} phase
 * @param {Object} [meta] — { status, error, tokensUsed }
 */
export function recordStep(runId, toolName, phase, meta = {}) {
  try {
    const trace = _findTrace(runId);
    if (!trace) return;

    if (phase === 'start') {
      trace.steps.push({
        toolName,
        startMs: Date.now(),
        endMs: null,
        durationMs: 0,
        status: 'running',
        error: null,
        tokensUsed: 0,
      });
    } else if (phase === 'end') {
      // Find the last step with this toolName that's still running
      for (let i = trace.steps.length - 1; i >= 0; i--) {
        const step = trace.steps[i];
        if (step.toolName === toolName && step.status === 'running') {
          step.endMs = Date.now();
          step.durationMs = step.endMs - step.startMs;
          step.status = meta.status || 'success';
          step.error = meta.error || null;
          step.tokensUsed = meta.tokensUsed || 0;
          trace.totalTokens += step.tokensUsed;
          break;
        }
      }
    }
  } catch (e) {
    logger.error('[run-tracker] recordStep failed (non-fatal):', e.message);
  }
}

/**
 * 添加 token 消耗到 Run
 * @param {string} runId
 * @param {number} tokens
 */
export function addTokens(runId, tokens) {
  try {
    const trace = _findTrace(runId);
    if (trace) trace.totalTokens += tokens;
  } catch (_) { /* non-fatal */ }
}

/**
 * 结束一个 Run 追踪并计算质量评分
 * @param {string} runId
 * @param {'completed'|'error'} status
 * @returns {RunTrace|null}
 */
export function endRun(runId, status = 'completed') {
  try {
    const trace = _findTrace(runId);
    if (!trace) return null;

    trace.endMs = Date.now();
    trace.totalMs = trace.endMs - trace.startMs;
    trace.status = status;
    _activeRuns.delete(runId); // Remove from active runs

    // 计算质量评分
    const breakdown = _calculateQualityScore(trace);
    trace.qualityScore = breakdown.total;
    trace.scoreBreakdown = breakdown;

    return trace;
  } catch (e) {
    logger.error('[run-tracker] endRun failed (non-fatal):', e.message);
    return null;
  }
}

/**
 * 质量评分算法（0-100）
 * - 工具成功率：60%
 * - 速度：20%
 * - 步骤效率：20%
 */
function _calculateQualityScore(trace) {
  const steps = trace.steps;
  const totalSteps = steps.length;

  // 1. 工具成功率（60分）
  let successCount = 0;
  for (const step of steps) {
    if (step.status === 'success') successCount++;
  }
  const successRate = totalSteps > 0 ? successCount / totalSteps : 1;
  const successScore = Math.round(successRate * 60);

  // 2. 速度评分（20分）
  // 60s 内完成 = 满分，超过 300s = 0分
  const totalMs = trace.totalMs || 0;
  let speedScore;
  if (totalMs <= SPEED_BASELINE_MS) {
    speedScore = 20;
  } else if (totalMs >= 300000) {
    speedScore = 0;
  } else {
    speedScore = Math.round(20 * (1 - (totalMs - SPEED_BASELINE_MS) / (300000 - SPEED_BASELINE_MS)));
  }

  // 3. 步骤效率（20分）
  // ≤5 步 = 满分，≥30 步 = 0分
  let efficiencyScore;
  if (totalSteps <= 5) {
    efficiencyScore = 20;
  } else if (totalSteps >= MAX_EXPECTED_STEPS) {
    efficiencyScore = 0;
  } else {
    efficiencyScore = Math.round(20 * (1 - (totalSteps - 5) / (MAX_EXPECTED_STEPS - 5)));
  }

  const total = Math.max(0, Math.min(100, successScore + speedScore + efficiencyScore));

  return {
    total,
    successScore,
    speedScore,
    efficiencyScore,
    details: {
      totalSteps,
      successCount,
      successRate: Math.round(successRate * 100),
      totalMs,
      totalTokens: trace.totalTokens,
    },
  };
}

/**
 * 查询最近的 Run 追踪记录
 * @param {Object} [options]
 * @param {number} [options.limit=20]
 * @param {string} [options.sessionKey]
 * @param {string} [options.status]
 * @param {number} [options.minScore]
 * @returns {Object}
 */
export function getRunTraces({ limit = 20, sessionKey, status, minScore } = {}) {
  try {
    let results = [..._traces].filter(t => t && t.runId);

    if (sessionKey) results = results.filter(t => t.sessionKey === sessionKey);
    if (status) results = results.filter(t => t.status === status);
    if (minScore !== undefined) results = results.filter(t => t.qualityScore !== null && t.qualityScore >= minScore);

    // Sort by startMs descending (newest first)
    results.sort((a, b) => b.startMs - a.startMs);
    results = results.slice(0, limit);

    // Compute aggregate stats
    const completed = results.filter(t => t.status === 'completed');
    const avgScore = completed.length > 0
      ? Math.round(completed.reduce((s, t) => s + (t.qualityScore || 0), 0) / completed.length)
      : null;
    const avgMs = completed.length > 0
      ? Math.round(completed.reduce((s, t) => s + (t.totalMs || 0), 0) / completed.length)
      : null;
    const totalTokens = results.reduce((s, t) => s + (t.totalTokens || 0), 0);

    return {
      total: results.length,
      buffered: _traces.filter(t => t && t.runId).length,
      maxBuffer: MAX_TRACES,
      aggregate: { avgScore, avgMs, totalTokens },
      traces: results.map(t => ({
        runId: t.runId,
        sessionKey: t.sessionKey,
        userId: t.userId,
        status: t.status,
        totalMs: t.totalMs,
        totalTokens: t.totalTokens,
        stepsCount: t.steps.length,
        qualityScore: t.qualityScore,
        scoreBreakdown: t.scoreBreakdown,
        createdAt: t.createdAt,
      })),
    };
  } catch (e) {
    logger.error('[run-tracker] getRunTraces failed:', e.message);
    return { total: 0, traces: [], error: e.message };
  }
}

/**
 * 获取单个 Run 的详细追踪（含所有步骤）
 * @param {string} runId
 * @returns {RunTrace|null}
 */
export function getRunDetail(runId) {
  return _findTrace(runId) || null;
}

// ─── 内部工具 ─────────────────────────────────
function _findTrace(runId) {
  for (let i = _traces.length - 1; i >= 0; i--) {
    if (_traces[i] && _traces[i].runId === runId) return _traces[i];
  }
  return null;
}

// ─── Backward Compatibility (v10.0 API) ───
// These functions are required by openclaw-handler, index.mjs, user-message-handler
const _sessionRuns = new Map(); // sessionKey → { runId }

export function setCurrentRunId(runId, sessionKey) {
  if (!sessionKey) return;
  _sessionRuns.set(sessionKey, { runId });
  // Also start a RunTrace if not already started
  if (runId && !_activeRuns.has(runId)) {
    startRun(runId, { sessionKey });
  }
}

export function getCurrentRunId(sessionKey) {
  if (!sessionKey) return null;
  return _sessionRuns.get(sessionKey)?.runId || null;
}

export function setCurrentSessionKey(sk) {
  // No-op in v10.0+ — session is passed explicitly
}

export function getCurrentSessionKey() {
  const keys = [..._sessionRuns.keys()];
  return keys.length > 0 ? keys[keys.length - 1] : null;
}

export function clearRunTracking(sessionKey) {
  if (sessionKey) {
    // End the run trace if active
    const entry = _sessionRuns.get(sessionKey);
    if (entry?.runId && _activeRuns.has(entry.runId)) {
      endRun(entry.runId, 'completed');
    }
    _sessionRuns.delete(sessionKey);
  } else {
    // End all active runs
    for (const [sk, entry] of _sessionRuns) {
      if (entry?.runId && _activeRuns.has(entry.runId)) {
        endRun(entry.runId, 'completed');
      }
    }
    _sessionRuns.clear();
  }
}

export function getAllActiveRuns() {
  return new Map(_sessionRuns);
}

