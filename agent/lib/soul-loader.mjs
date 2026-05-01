// ─── lib/soul-loader.mjs v2 — 兼容适配层 (Iter-L, v25.18) ──────────────────
// TD-023: Extracted from llm-gateway.mjs
//
// v2 变更：内部调用 worker/soul-loader.mjs 的分层加载能力（Iter-E，v25.15），
// 对外保持原有 API 完全兼容（getSoulSystemPrompt / getSoulSystemPromptSplit / setSoulConfigAccessor）。
//
// 分层效果：
//   general 意图  → 仅主 SOUL.md (~8k chars，原 ~26k)，节省约 67% token
//   coding 意图   → 主 SOUL.md + soul/coding.md
//   business 意图 → 主 SOUL.md + soul/business.md
//   ops 意图      → 主 SOUL.md + soul/ops.md
//   complex 意图  → 主 SOUL.md + soul/coding.md + soul/ops.md
//
// Consumers（不变）：
//   - llm-gateway.mjs: re-exports getSoulSystemPrompt/getSoulSystemPromptSplit
//   - worker/user-message-handler.mjs
//   - worker/api-fallback.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from './logger.mjs';
import { loadSoul, detectSoulIntent } from '../worker/soul-loader.mjs';

// Config accessor（由 llm-gateway.mjs 在初始化时注入，保持兼容）
let _getConfig = () => ({});
export function setSoulConfigAccessor(fn) { _getConfig = fn; }

const DEFAULT_SOUL_FALLBACK = "You are RangerAI (游侠AI), a multi-model AI assistant created by Voyage Games (游侠出海). You have access to tools including browser, exec (shell), web_search, web_fetch, and file operations. 所有回复必须使用简体中文。Be helpful, concise, and proactive.";

/**
 * 获取系统提示（分层加载版）
 *
 * @param {string} [userMessage=''] - 当前用户消息，用于意图检测（可选）
 * @param {string} [intentHint]     - 外部传入的意图覆盖（可选，优先级更高）
 * @returns {string} 合并后的 SOUL 系统提示文本
 */
export function getSoulSystemPrompt(userMessage = '', intentHint = null) {
  try {
    const intent = intentHint || (userMessage ? detectSoulIntent(userMessage) : 'general');
    const soul = loadSoul(intent, userMessage);
    if (process.env.SOUL_DEBUG === '1') {
      logger.debug(`[soul-loader] intent=${intent}, chars=${soul.length}`);
    }
    return soul || DEFAULT_SOUL_FALLBACK;
  } catch (err) {
    logger.warn(`[soul-loader] getSoulSystemPrompt failed: ${err.message}, using fallback`);
    return DEFAULT_SOUL_FALLBACK;
  }
}

/**
 * 获取拆分格式系统提示（[fixed, volatile, full] 对象）
 * 保持与旧版 API 完全兼容。
 *
 * fixed   = 主 SOUL.md 前 §14 行为禁止清单之前的部分（稳定，适合 KV-Cache）
 * volatile = §14 之后 + 子文件内容（可变）
 *
 * @param {string} [userMessage='']
 * @param {string} [intentHint]
 * @returns {{ fixed: string, volatile: string, full: string }}
 */
export function getSoulSystemPromptSplit(userMessage = '', intentHint = null) {
  try {
    const full = getSoulSystemPrompt(userMessage, intentHint);
    const splitMarker = '## 14. 行为禁止清单';
    const splitIdx = full.indexOf(splitMarker);

    let fixed, volatile;
    if (splitIdx > 0) {
      fixed = full.substring(0, splitIdx).trimEnd();
      volatile = full.substring(splitIdx);
    } else {
      // fallback: 70/30 split
      const splitPoint = Math.floor(full.length * 0.7);
      const lineBreak = full.indexOf('\n', splitPoint);
      const actualSplit = lineBreak > 0 ? lineBreak : splitPoint;
      fixed = full.substring(0, actualSplit);
      volatile = full.substring(actualSplit);
    }

    if (process.env.SOUL_DEBUG === '1') {
      logger.debug(`[soul-loader] split: fixed=${fixed.length}, volatile=${volatile.length}`);
    }

    return { fixed, volatile, full };
  } catch (err) {
    logger.warn(`[soul-loader] getSoulSystemPromptSplit failed: ${err.message}`);
    const fallback = DEFAULT_SOUL_FALLBACK;
    return { fixed: fallback, volatile: '', full: fallback };
  }
}
