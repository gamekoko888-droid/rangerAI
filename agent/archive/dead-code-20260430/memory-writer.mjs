// memory-writer.mjs — 统一记忆写入网关 (Iter-K, v25.18)
//
// 替代 user-message-handler.mjs 中分散的 extractAndSaveMemory + extractEpisodicMemory 并发调用。
// 串行执行两类记忆写入，添加 msgId 去重保护，防止同一条消息触发两次 LLM 提取。
//
// 两类记忆职责不同（故均保留，仅统一调用入口）：
//   - extractAndSaveMemory  → user_memories 表（用户级长期记忆，跨会话）
//   - extractEpisodicMemory → episodic_memories 表（会话级情节记忆，短期上下文）

import { extractAndSaveMemory } from './memory-extractor.mjs';
import { extractEpisodicMemory } from './memory-manager.mjs';
import { logger } from '../lib/logger.mjs';

// 去重保护：记录已写入的 msgId（最多保留 1000 条，超出时淘汰最旧）
const _writtenMsgIds = new Map(); // msgId → timestamp
const MAX_DEDUP_SIZE = 1000;

const ts = () => new Date().toISOString();

/**
 * 统一记忆写入入口（异步，串行执行两类写入）
 *
 * @param {string} msgId              - 消息 ID（用于去重，必传）
 * @param {string} userId             - 用户 ID（用于 user_memories）
 * @param {string} sessionKey         - 会话 Key（用于 episodic_memories）
 * @param {string} userMessage        - 用户输入
 * @param {string} assistantReply     - 助手回复
 * @param {Array}  conversationHistory - 对话历史（默认 []）
 * @param {Object} opts               - 选项
 * @param {boolean} [opts.hasToolOutput=false]  - 是否含工具调用输出
 * @param {boolean} [opts.skipEpisodic=false]   - 是否跳过情节记忆
 * @param {boolean} [opts.skipUserMemory=false] - 是否跳过用户长期记忆
 */
export async function writeMemory(
  msgId, userId, sessionKey, userMessage, assistantReply,
  conversationHistory = [], opts = {}
) {
  // 去重保护
  if (_writtenMsgIds.has(msgId)) {
    logger.debug(`[memory-writer] msgId ${msgId} already written, skipping`);
    return;
  }

  // LRU 淘汰
  if (_writtenMsgIds.size >= MAX_DEDUP_SIZE) {
    const oldestKey = _writtenMsgIds.keys().next().value;
    _writtenMsgIds.delete(oldestKey);
  }
  _writtenMsgIds.set(msgId, Date.now());

  const {
    hasToolOutput = false,
    skipEpisodic = false,
    skipUserMemory = false,
  } = opts;

  // Step 1：用户级长期记忆（user_memories）
  if (!skipUserMemory && userId && userId !== 'system' && userMessage?.length >= 10) {
    try {
      await extractAndSaveMemory(userId, userMessage, assistantReply, conversationHistory);
    } catch (e) {
      logger.warn(`[${ts()}] [memory-writer] extractAndSaveMemory failed: ${e.message}`);
    }
  }

  // Step 2：会话级情节记忆（episodic_memories）
  if (!skipEpisodic) {
    try {
      await extractEpisodicMemory(sessionKey, userMessage, assistantReply, { hasToolOutput });
    } catch (e) {
      logger.warn(`[${ts()}] [memory-writer] extractEpisodicMemory failed: ${e.message}`);
    }
  }
}

/**
 * 异步记忆写入（fire-and-forget，不阻塞主流程）
 * 与 writeMemory 参数相同。
 */
export function writeMemoryAsync(
  msgId, userId, sessionKey, userMessage, assistantReply,
  conversationHistory = [], opts = {}
) {
  writeMemory(msgId, userId, sessionKey, userMessage, assistantReply, conversationHistory, opts)
    .catch(e => logger.warn(`[${ts()}] [memory-writer] async write error: ${e.message}`));
}

/**
 * 清空去重缓存（仅测试用）
 */
export function resetMemoryDedup() {
  _writtenMsgIds.clear();
}

/**
 * 获取去重缓存大小（仅调试用）
 */
export function getMemoryDedupSize() {
  return _writtenMsgIds.size;
}
