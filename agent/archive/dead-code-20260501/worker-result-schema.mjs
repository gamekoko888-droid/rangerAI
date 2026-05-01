// ─── R74 P0-2: Worker 结果结构化回传 ───
// worker-result-schema.mjs — Worker 结果标准化/校验模块
//
// 设计目标：
//   所有 Worker 子任务结果统一为 { stepId, status, evidence, summary, nextRisk }
//   提供 normalize（填充缺失字段）和 validate（检查必填字段）两个函数。

import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── Worker 结果 Schema 定义 ───
export const WORKER_RESULT_SCHEMA = {
  version: '1.0.0',
  description: 'R74 Worker result schema — unified structure for sub-agent results',
  fields: {
    stepId: {
      type: 'string',
      required: true,
      description: '步骤 ID（对应 plan.steps[].id）',
    },
    status: {
      type: 'string',
      required: true,
      enum: ['completed', 'failed', 'skipped', 'timeout', 'cancelled'],
      description: 'Worker 执行状态',
    },
    evidence: {
      type: 'string',
      required: false,
      description: 'Worker 执行过程中收集的证据/原始输出',
    },
    summary: {
      type: 'string',
      required: true,
      description: 'Worker 结果摘要（≤500 字符）',
    },
    nextRisk: {
      type: 'string',
      required: false,
      description: '下一步建议或风险提示（null 表示无风险）',
    },
    // ─── 扩展字段（非必填，供 trace/debug 使用） ───
    workerId: {
      type: 'string',
      required: false,
      description: 'Worker 唯一标识符',
    },
    elapsedMs: {
      type: 'number',
      required: false,
      description: 'Worker 执行耗时（毫秒）',
    },
    attempt: {
      type: 'number',
      required: false,
      description: '执行次数（≥1）',
    },
  },
};

/**
 * 标准化 Worker 结果：确保所有必填字段存在，填充默认值。
 *
 * @param {Object} raw - 原始 Worker 结果（可能不完整）
 * @returns {Object} 标准化后的结果，符合 WORKER_RESULT_SCHEMA
 */
export function normalizeWorkerResult(raw = {}) {
  const defaultStatuses = ['completed', 'failed', 'skipped', 'timeout', 'cancelled'];
  const status = defaultStatuses.includes(raw.status) ? raw.status : 'failed';

  const summary = typeof raw.summary === 'string' && raw.summary.trim()
    ? raw.summary.trim().substring(0, 500)
    : (raw.evidence ? String(raw.evidence).substring(0, 500) : (status === 'completed' ? 'Worker completed successfully.' : 'Worker did not produce a summary.'));

  return {
    stepId: String(raw.stepId || raw.step || raw.step_id || 'unknown'),
    status,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : (raw.evidence ? String(raw.evidence) : ''),
    summary,
    nextRisk: raw.nextRisk !== undefined && raw.nextRisk !== null ? String(raw.nextRisk) : null,
    // 扩展字段
    workerId: raw.workerId || raw.worker_id || raw.id || null,
    elapsedMs: typeof raw.elapsedMs === 'number' ? raw.elapsedMs : (raw.elapsedMs ? parseInt(raw.elapsedMs, 10) || 0 : 0),
    attempt: typeof raw.attempt === 'number' ? raw.attempt : (raw.attempt ? parseInt(raw.attempt, 10) || 1 : 1),
  };
}

/**
 * 校验 Worker 结果是否符合 Schema 要求。
 *
 * @param {Object} result - 待校验的 Worker 结果
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWorkerResult(result) {
  const errors = [];

  if (!result || typeof result !== 'object') {
    errors.push('Result must be a non-null object');
    return { valid: false, errors };
  }

  // stepId: 必填
  if (!result.stepId || typeof result.stepId !== 'string') {
    errors.push(`stepId is required and must be a string, got: ${typeof result.stepId}`);
  }

  // status: 必填，枚举
  const validStatuses = ['completed', 'failed', 'skipped', 'timeout', 'cancelled'];
  if (!result.status || !validStatuses.includes(result.status)) {
    errors.push(`status must be one of [${validStatuses.join(', ')}], got: "${result.status}"`);
  }

  // summary: 必填
  if (!result.summary || typeof result.summary !== 'string' || !result.summary.trim()) {
    errors.push('summary is required and must be a non-empty string');
  }

  // evidence: 可选，但如果非空必须是 string
  if (result.evidence !== undefined && result.evidence !== null && typeof result.evidence !== 'string') {
    errors.push(`evidence must be a string or null, got: ${typeof result.evidence}`);
  }

  // nextRisk: 可选
  if (result.nextRisk !== undefined && result.nextRisk !== null && typeof result.nextRisk !== 'string') {
    errors.push(`nextRisk must be a string or null, got: ${typeof result.nextRisk}`);
  }

  const valid = errors.length === 0;
  if (!valid) {
    logger.warn(`[${ts()}] [worker-result-schema] Validation failed for stepId=${result.stepId || 'unknown'}: ${errors.join('; ')}`);
  }

  return { valid, errors };
}

/**
 * 批量校验 Worker 结果数组。
 *
 * @param {Array<Object>} results
 * @returns {{ allValid: boolean, results: Array<{ stepId: string, valid: boolean, errors: string[] }> }}
 */
export function validateWorkerResults(results = []) {
  const outcomes = results.map(r => ({
    stepId: r?.stepId || 'unknown',
    ...validateWorkerResult(r),
  }));

  return {
    allValid: outcomes.every(o => o.valid),
    results: outcomes,
  };
}

export default {
  WORKER_RESULT_SCHEMA,
  normalizeWorkerResult,
  validateWorkerResult,
  validateWorkerResults,
};
