// intent-pipeline.mjs — 统一意图分类流水线 (Iter-M, v25.18)
//
// 合并两套意图分类系统：
//   - intent-classifier.mjs (classifyIntent)    → 被 message-router 用于 R60 路由覆盖
//   - llm-pre-classifier.mjs (preClassify)      → 被 smart-router 用于 LLM 路由决策
//
// 统一产出 IntentResult 对象，在请求链路中流转，下游共享同一份结果，
// 避免同一消息触发两次独立 LLM 分类调用。
//
// 分类策略（分层，快速路径优先）：
//   1. Regex 快速分类（无 LLM 调用，<1ms）
//   2. LLM 精确分类（仅在 regex 置信度 < 0.7 时触发）
//
// IntentResult 结构：
// {
//   intent: 'general' | 'coding' | 'business' | 'ops' | 'creative' | 'complex'
//   confidence: number,        // 0-1
//   source: 'llm' | 'regex',  // 分类来源
//   routingOverride: object|null, // 路由覆盖指令（来自 getRoutingOverride）
//   durationMs: number,        // 分类耗时（毫秒）
//   rawResult: object|null,    // 原始 LLM 分类结果（调试用）
// }

import { classifyByRegex, getRoutingOverride } from './intent-classifier.mjs';
import { preClassify, stripContext } from './llm-pre-classifier.mjs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// Regex 置信度阈值：低于此值才触发 LLM 分类
const REGEX_CONFIDENCE_THRESHOLD = 0.7;

/**
 * 统一意图分类（异步，支持 LLM 降级）
 *
 * @param {string} rawMessage - 原始用户消息
 * @returns {Promise<IntentResult>}
 */
export async function classifyUnifiedIntent(rawMessage) {
  const startMs = Date.now();

  if (!rawMessage || typeof rawMessage !== 'string') {
    return _buildResult('general', 0.5, 'regex', null, null, Date.now() - startMs);
  }

  // Step 1：Regex 快速分类（无 LLM 调用）
  const regexResult = classifyByRegex(rawMessage);
  const regexIntent = regexResult?.intent || 'general';
  const regexConfidence = regexResult?.confidence ?? 0;

  if (regexConfidence >= REGEX_CONFIDENCE_THRESHOLD) {
    // 高置信度，直接用 regex 结果
    const routingOverride = _safeGetRoutingOverride(regexResult);
    logger.debug(`[${ts()}] [intent-pipeline] regex hit: intent=${regexIntent} conf=${regexConfidence}`);
    return _buildResult(regexIntent, regexConfidence, 'regex', routingOverride, null, Date.now() - startMs);
  }

  // Step 2：LLM 精确分类（低置信度时触发）
  try {
    const stripped = stripContext(rawMessage);
    const llmResult = await preClassify(stripped);

    // preClassify 返回的是路由结果（category/model/thinking），需映射到 intent 字段
    const intent = _mapCategoryToIntent(llmResult?.category) || regexIntent || 'general';
    const confidence = llmResult?.confidence ?? 0.8;
    const routingOverride = _safeGetRoutingOverride({ intent, confidence });

    logger.debug(`[${ts()}] [intent-pipeline] llm hit: category=${llmResult?.category} → intent=${intent} conf=${confidence}`);
    return _buildResult(intent, confidence, 'llm', routingOverride, llmResult, Date.now() - startMs);
  } catch (e) {
    // LLM 失败，回退到 regex 结果
    logger.warn(`[${ts()}] [intent-pipeline] LLM classify failed, fallback to regex: ${e.message}`);
    const routingOverride = _safeGetRoutingOverride(regexResult);
    return _buildResult(regexIntent, Math.max(regexConfidence, 0.5), 'regex', routingOverride, null, Date.now() - startMs);
  }
}

/**
 * 同步 Regex 分类（用于不需要 LLM 精度的快速场景，如 Soul 分层意图检测）
 *
 * @param {string} rawMessage
 * @returns {IntentResult}
 */
export function classifyIntentSync(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'string') {
    return _buildResult('general', 0.5, 'regex', null, null, 0);
  }
  const result = classifyByRegex(rawMessage);
  const intent = result?.intent || 'general';
  const confidence = result?.confidence ?? 0.5;
  const routingOverride = _safeGetRoutingOverride(result);
  return _buildResult(intent, confidence, 'regex', routingOverride, null, 0);
}

// ─── 内部工具函数 ─────────────────────────────────────────────

function _buildResult(intent, confidence, source, routingOverride, rawResult, durationMs) {
  return { intent, confidence, source, routingOverride: routingOverride || null, rawResult: rawResult || null, durationMs };
}

function _safeGetRoutingOverride(intentResult) {
  try {
    if (!intentResult) return null;
    return getRoutingOverride(intentResult) || null;
  } catch {
    return null;
  }
}

// 将 llm-pre-classifier 的 category（路由类型）映射到 intent（用于 Soul 分层）
const CATEGORY_TO_INTENT = {
  coding:           'coding',
  code_review:      'coding',
  debugging:        'coding',
  deployment:       'ops',
  ops:              'ops',
  monitoring:       'ops',
  business:         'business',
  customer_service: 'business',
  research:         'business',
  image_generation: 'creative',
  creative:         'creative',
  chat:             'general',
  general:          'general',
};

function _mapCategoryToIntent(category) {
  if (!category) return 'general';
  return CATEGORY_TO_INTENT[category] || 'general';
}
