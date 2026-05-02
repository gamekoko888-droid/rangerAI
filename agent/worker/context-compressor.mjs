export const CONTEXT_POLICY = { summarizeThreshold: 0.8, hardCompactThreshold: 0.9 };
/**
 * context-compressor.mjs — Iter-C: Two-Level Context Compression Pipeline
 * 
 * Level 1 (microCompact): >75% usage, pure text truncation, no LLM call
 *   - Only truncates exec/grep/glob/find/web_search tool outputs
 *   - Preserves last 5 rounds of messages untouched
 *   - Zero cost, instant execution
 * 
 * Level 2 (autoCompact): >90% usage, LLM-generated structured summary
 *   - Calls gpt-5-mini to generate structured summary
 *   - Format: 【任务目标】【已完成】【产物】【待处理】【关键上下文】
 *   - Returns "summary + last 10 rounds of original messages"
 *   - Sends "正在压缩对话历史…" status to frontend
 */

import { getConversationHistory, getChatBySessionKey } from './db-proxy.mjs';
import { logger } from '../lib/logger.mjs';
import { classifyMessages, buildLayeredContext, updateColdSummary, addAnchor, detectAnchorCandidate, getAnchors } from './context-buffer.mjs';
import { emitEvent, EVENT_TYPES } from './event-stream.mjs';
import { sendEvent } from './ipc-utils.mjs';
import { AUTOCOMPACT_PROMPT } from './agent-config.mjs';
import { readFileSync } from 'fs';
import http from 'http';
import { recordCompression } from './observability.mjs';


const ts = () => new Date().toISOString();

// ─── Configuration ──────────────────────────────────────────
const CONFIG = {
  // microCompact thresholds
  // [R77-T1] 对齐 agent-config：0.50 (handler uses agent-config import directly; CONFIG kept as reference mirror)
  MICRO_COMPACT_USAGE_RATIO: 0.50,
  MICRO_COMPACT_KEEP_RECENT: 5,  // Keep last 5 rounds untouched
  MICRO_COMPACT_TOOL_MAX_CHARS: 2000,  // Truncate tool outputs to this
  // [R77-T1] 消息数触发阈值：从 30 → 20，对齐 agent-config
  MICRO_COMPACT_MESSAGE_THRESHOLD: 20,  // 20 条消息触发 microCompact

  // autoCompact thresholds
  // [R77-T1] 对齐 agent-config：0.65 (handler uses agent-config import directly; CONFIG kept as reference mirror)
  AUTO_COMPACT_USAGE_RATIO: 0.65,
  AUTO_COMPACT_KEEP_RECENT: 10,  // Keep last 10 rounds untouched
  AUTO_COMPACT_SUMMARY_MAX_TOKENS: 800,
  AUTO_COMPACT_MODEL: 'openclaw', // R82: Gateway routing meta-model (actual model resolved by gateway)
  // [R77-T1] 消息数触发阈值：从 50 → 35，对齐 agent-config
  AUTO_COMPACT_MESSAGE_THRESHOLD: 35,   // 35 条消息触发 autoCompact

  // Shared
  COMPRESSION_COOLDOWN_MS: 3 * 60 * 1000,  // 3 min between compressions
  MAX_MSG_LENGTH_FOR_SUMMARY: 2000,
  
  // Tools eligible for microCompact truncation
  MICRO_COMPACT_TOOLS: new Set(['exec', 'grep', 'glob', 'find', 'web_search', 'browser']),
  // Tools exempt from ALL truncation (Infinity)
  EXEMPT_TOOLS: new Set(['file_read', 'read_file', 'ReadFile', 'Read']),
};

// Track last compression time per session
const _lastCompression = new Map();

// ─── Gateway LLM Call ───────────────────────────────────────
let _gwToken = "";
try { _gwToken = readFileSync("/home/admin/.openclaw/gateway.token", "utf-8").trim(); } catch(e) { /* ignore */ }

function _callCompactLLMOnce(messages, maxTokens = 800) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CONFIG.AUTO_COMPACT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    });
    const req = http.request({
      hostname: "127.0.0.1",
      port: 18789,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${_gwToken || process.env.GATEWAY_API_KEY || ""}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Gateway HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || "";
          resolve(content);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", (err) => { clearTimeout(timeout); reject(err); });
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("autoCompact LLM timeout (30s)"));
    }, 30000);
    req.write(body);
    req.end();
  });
}


// [R66-B] Rate limit retry wrapper for context compressor
async function callCompactLLM(messages, maxTokens = 800) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _callCompactLLMOnce(messages, maxTokens);
    } catch (err) {
      if (/429|rate.?limit|temporarily rate-limited/i.test(err.message) && attempt < MAX_RETRIES) {
        logger.info(`[R66-B] context-compressor 429 retry ${attempt}/${MAX_RETRIES}, waiting 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

// ─── microCompact (Level 1) ─────────────────────────────────

/**
 * microCompact: Pure text truncation, no LLM call.
 * Only truncates exec/grep/glob/find/web_search tool outputs.
 * Preserves last KEEP_RECENT rounds untouched.
 * 
 * @param {Array} messages - Full conversation messages
 * @param {string} sessionKey - For logging
 * @returns {{ compressed: boolean, messages: Array, stats: object }}
 */
export function microCompact(messages, sessionKey, opts = {}) {
  if (!messages || messages.length === 0) return { compressed: false, messages, stats: {} };
  
  const keepCount = CONFIG.MICRO_COMPACT_KEEP_RECENT * 2; // 2 messages per round (user + assistant)
  const splitIdx = Math.max(0, messages.length - keepCount);
  const olderMessages = messages.slice(0, splitIdx);
  const recentMessages = messages.slice(splitIdx);
  
  let truncated = 0;
  let savedChars = 0;
  let exempted = 0;
  
  for (const msg of olderMessages) {
    if (!msg.content || typeof msg.content !== 'string') continue;
    
    // Detect tool output by role or content pattern
    const isToolOutput = msg.role === 'tool' || msg.role === 'function' || 
      (msg.role === 'assistant' && msg.content.includes('[tool:'));
    if (!isToolOutput) continue;
    
    // Check exemption
    const toolName = msg.toolName || msg.name || '';
    if (CONFIG.EXEMPT_TOOLS.has(toolName)) {
      exempted++;
      continue;
    }
    
    // Only truncate specific tools
    const isTargetTool = CONFIG.MICRO_COMPACT_TOOLS.has(toolName) || 
      !toolName; // Unknown tool outputs also get truncated
    if (!isTargetTool) continue;
    
    if (msg.content.length > CONFIG.MICRO_COMPACT_TOOL_MAX_CHARS) {
      const original = msg.content.length;
      const head = msg.content.substring(0, 800);
      const tail = msg.content.substring(msg.content.length - 500);
      msg.content = `${head}\n[...${original - 1300} chars truncated by microCompact...]\n${tail}`;
      truncated++;
      savedChars += original - msg.content.length;
    }
  }
  
  const stats = { level: 'microCompact', truncated, exempted, savedChars };
  if (truncated > 0) {
    logger.info(`[${ts()}] [R29-T1] [context-compressor] [microCompact] Compressed session=${sessionKey}: truncated=${truncated}, exempted=${exempted}, saved=${savedChars} chars`);
    // [R29-T1] Emit context_compress event for microCompact
    // [R57-T1] 增加 trigger 字段，区分触发原因（usage_ratio | message_count | token_budget）
    try {
      emitEvent(sessionKey, `task-${sessionKey}`, EVENT_TYPES.CONTEXT_COMPRESS, {
        totalMessages: messages.length,
        truncated,
        exempted,
        savedChars,
        level: 'microCompact',
        trigger: opts.trigger || 'usage_ratio',
        usageRatioAtTrigger: opts.usageRatio || null,
        messagesAtTrigger: messages.length,
      });
    } catch (e) { /* ignore */ }
    // [R13-T1] Record microCompact to DB
    const savedTokens = Math.ceil(savedChars / 3.5);
    recordCompression('micro', savedTokens, {
      sessionKey,
      msgsBefore: messages.length,
      msgsAfter: messages.length,
      tokensBefore: Math.ceil(messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 3.5),
      tokensAfter: Math.ceil(messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 3.5) - savedTokens,
      extraJson: { truncated, exempted, savedChars },
    });
  }
  
  return {
    compressed: truncated > 0,
    messages: [...olderMessages, ...recentMessages],
    stats,
  };
}

// ─── autoCompact (Level 2) ──────────────────────────────────

/**
 * autoCompact: LLM-generated structured summary.
 * Calls gpt-5-mini to generate summary in fixed format.
 * Returns "summary + last 10 rounds of original messages".
 * 
 * @param {Array} messages - Full conversation messages
 * @param {string} sessionKey - For logging and events
 * @param {string} msgId - For frontend status events
 * @returns {Promise<{ compressed: boolean, messages: Array, summary: string, stats: object }>}
 */
export async function autoCompact(messages, sessionKey, msgId, opts = {}) {
  if (!messages || messages.length === 0) return { compressed: false, messages, summary: '', stats: {} };
  
  // Check cooldown
  const lastTime = _lastCompression.get(sessionKey) || 0;
  if (Date.now() - lastTime < CONFIG.COMPRESSION_COOLDOWN_MS) {
    logger.info(`[${ts()}] [context-compressor] [autoCompact] Cooldown active, skipping`);
    return { compressed: false, messages, summary: '', stats: { level: 'autoCompact', reason: 'cooldown' } };
  }
  
  // Send status to frontend
  if (msgId) {
    sendEvent(msgId, { type: "status", status: "compressing", message: "正在压缩对话历史…" });
  }
  
  const keepCount = CONFIG.AUTO_COMPACT_KEEP_RECENT * 2;
  const splitIdx = Math.max(0, messages.length - keepCount);
  const olderMessages = messages.slice(0, splitIdx);
  const recentMessages = messages.slice(splitIdx);
  
  if (olderMessages.length < 5) {
    logger.info(`[${ts()}] [context-compressor] [autoCompact] Too few older messages (${olderMessages.length}), skipping`);
    return { compressed: false, messages, summary: '', stats: { level: 'autoCompact', reason: 'too_few' } };
  }
  
  // Format older messages for LLM summarization
  const formatted = olderMessages
    .filter(m => m.content && typeof m.content === 'string' && m.content.trim().length > 0)
    .map(m => {
      const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
      const content = m.content.length > CONFIG.MAX_MSG_LENGTH_FOR_SUMMARY
        ? m.content.substring(0, CONFIG.MAX_MSG_LENGTH_FOR_SUMMARY) + '...(截断)'
        : m.content;
      return `[${role}]: ${content}`;
    })
    .join('\n\n');
  
  let summary = '';
  try {
    summary = await callCompactLLM([
      { role: 'system', content: AUTOCOMPACT_PROMPT },
      { role: 'user', content: `以下是需要压缩的对话历史（${olderMessages.length}条消息）：\n\n${formatted}` }
    ], CONFIG.AUTO_COMPACT_SUMMARY_MAX_TOKENS);
    
    logger.info(`[${ts()}] [context-compressor] [autoCompact] LLM summary generated: ${summary.length} chars`);
  } catch (err) {
    logger.error(`[${ts()}] [context-compressor] [autoCompact] LLM call failed: ${err.message}, using extractive fallback`);
    summary = generateExtractiveSummary(olderMessages);
  }
  
  // Update layered buffer
  try {
    updateColdSummary(sessionKey, summary, olderMessages.length);
    for (let i = 0; i < olderMessages.length; i++) {
      const msg = olderMessages[i];
      const candidate = detectAnchorCandidate(msg, { isFirstMessage: i === 0 });
      if (candidate && candidate.shouldAnchor) {
        addAnchor(sessionKey, msg.content, candidate.reason, candidate.priority);
      }
    }
  } catch (e) {
    logger.warn(`[${ts()}] [context-compressor] [autoCompact] Buffer update failed: ${e.message}`);
  }
  
  // Build compressed context as a system message
  const anchors = getAnchors(sessionKey) || [];
  const anchorBlock = anchors.length > 0
    ? `\n=== 固定上下文 (${anchors.length} 个锚点) ===\n${anchors.map(a => `[${a.reason}] ${a.content}`).join('\n')}\n`
    : '';
  
  const compressedSystemMsg = {
    role: 'system',
    content: `[AUTOCOMPACT_SUMMARY]\n以下是之前 ${olderMessages.length} 条消息的结构化摘要：\n\n${summary}\n${anchorBlock}\n请基于以上摘要和后续的最近消息继续执行任务。不要向用户提问，直接继续待处理的工作。\n[/AUTOCOMPACT_SUMMARY]`
  };
  
  // Record compression
  _lastCompression.set(sessionKey, Date.now());
  
  // [R29-T1] Emit context_compressed event for autoCompact
  try {
    // [R57-T1] 增加 trigger 字段
    emitEvent(sessionKey, `task-${sessionKey}`, EVENT_TYPES.CONTEXT_COMPRESS, {
      totalMessages: messages.length,
      compressed: olderMessages.length,
      kept: recentMessages.length,
      anchors: anchors.length,
      summaryLength: summary.length,
      level: 'autoCompact',
      trigger: opts.trigger || 'usage_ratio',
      usageRatioAtTrigger: opts.usageRatio || null,
      messagesAtTrigger: messages.length,
    });
    logger.info(`[${ts()}] [R29-T1] [context-compressor] [autoCompact] Compressed session=${sessionKey}: ${olderMessages.length} msgs compressed, ${recentMessages.length} kept, summary=${summary.length} chars`);
  } catch (e) { /* ignore */ }
  
  const stats = {
    level: 'autoCompact',
    olderCompressed: olderMessages.length,
    recentKept: recentMessages.length,
    summaryChars: summary.length,
    anchors: anchors.length,
  };
  
  logger.info(`[${ts()}] [context-compressor] [autoCompact] session=${sessionKey}: compressed=${olderMessages.length} msgs → ${summary.length} char summary, keeping ${recentMessages.length} recent`);
  
  // [R13-T1] Record autoCompact to DB
  const tokensBefore = Math.ceil(messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 3.5);
  const tokensAfter = Math.ceil([compressedSystemMsg, ...recentMessages].reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 3.5);
  recordCompression('auto', tokensBefore - tokensAfter, {
    sessionKey,
    msgId,
    msgsBefore: messages.length,
    msgsAfter: 1 + recentMessages.length,
    tokensBefore,
    tokensAfter,
    summaryChars: summary.length,
    extraJson: { anchors: anchors.length, olderCompressed: olderMessages.length },
  });

  return {
    compressed: true,
    messages: [compressedSystemMsg, ...recentMessages],
    summary,
    stats,
  };
}

// ─── Extractive Summary Fallback ────────────────────────────

function generateExtractiveSummary(messages) {
  const userMessages = messages.filter(m => m.role === 'user');
  const keyMessages = [];
  
  if (userMessages[0]) {
    keyMessages.push(`【任务目标】${userMessages[0].content.substring(0, 500)}`);
  }
  
  // Sample topic evolution
  for (let i = 5; i < userMessages.length; i += 5) {
    keyMessages.push(`【进展】${userMessages[i].content.substring(0, 300)}`);
  }
  
  // Recent context
  const recentUser = userMessages.slice(-3);
  for (const m of recentUser) {
    keyMessages.push(`【最近】${m.content.substring(0, 300)}`);
  }
  
  return `对话摘要（${messages.length}条消息压缩）：\n${keyMessages.join('\n')}`;
}

// ─── Legacy API (backward compatible) ───────────────────────

/**
 * Legacy checkAndCompress — now routes to microCompact or autoCompact
 * based on usage ratio.
 */
export async function checkAndCompress(sessionKey, gateway, llmFn) {
  try {
    const lastTime = _lastCompression.get(sessionKey) || 0;
    if (Date.now() - lastTime < CONFIG.COMPRESSION_COOLDOWN_MS) {
      return { compressed: false, reason: 'cooldown' };
    }
    
    const chat = await getChatBySessionKey(sessionKey);
    if (!chat) return { compressed: false, reason: 'no_chat' };
    
    const allMessages = await getConversationHistory(chat.id, 100);
    if (!allMessages || allMessages.length < 20) {
      return { compressed: false, reason: 'below_threshold', messageCount: allMessages?.length || 0 };
    }
    
    // Route to appropriate compression level
    // (In the new pipeline, this is called from openclaw-handler with usage ratio)
    const result = await autoCompact(allMessages, sessionKey, null);
    return {
      compressed: result.compressed,
      summary: result.summary?.substring(0, 200) + '...',
      messageCount: allMessages.length,
      summarized: result.stats.olderCompressed || 0,
      kept: result.stats.recentKept || 0,
    };
  } catch (err) {
    logger.error(`[${ts()}] [context-compressor] Error: ${err.message}`);
    return { compressed: false, reason: 'error', error: err.message };
  }
}

/**
 * Get compression stats for monitoring.
 */
export function getCompressionStats() {
  const stats = {};
  for (const [key, time] of _lastCompression.entries()) {
    stats[key] = {
      lastCompression: new Date(time).toISOString(),
      ageMs: Date.now() - time
    };
  }
  return stats;
}

export { CONFIG as COMPRESSION_CONFIG };


export async function safeAutoCompact(messages, sessionKey, msgId, opts = {}) {
  try {
    return await autoCompact(messages, sessionKey, msgId, opts);
  } catch (err) {
    return { compacted: false, reason: err?.message || 'autoCompact_failed', messages };
  }
}

export function estimateTokenCount(messages = []) {
  const text = messages.map(m => (m?.content || '')).join(' ');
  return Math.ceil(text.length / 4);
}
