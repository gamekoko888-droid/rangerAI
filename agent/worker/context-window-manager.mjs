// ─── Context Window Manager: Token Budget & Proactive Compression ───
//
// Purpose: Prevent context window collapse through proactive token budget
// management, tool output trimming, and tiered compression strategies.
//
// Replaces the reactive sessions.list health check with a predictive
// token tracking system that acts BEFORE the context window overflows.

import { sendEvent } from "./ipc-utils.mjs";
import { estimateTokens } from "./format-utils.mjs";

import { logger } from '../lib/logger.mjs';
import { recordCompression } from './observability.mjs'; // [R13-T6]
const ts = () => new Date().toISOString();

// ─── Configuration ───
export const CONFIG = {
  // Model context window sizes (tokens)
  DEFAULT_CONTEXT_WINDOW: 200000,  // Claude 3.5 Sonnet / GPT-4o default
  // [R77-T1] Hard token budget limit — triggers autoCompact regardless of tier
  // 从 160K 降至 120K：大多数会话应该在 120K 前已触发压缩
  TOKEN_BUDGET_HARD_LIMIT: 120000,  // 120k tokens hard gate (was 160000)

  // Token budget tiers (as ratio of context window)
  // [R77-T1] 对齐 agent-config 阈值：3层逐步压缩
  TIER_GREEN: 0.35,   // 0-35%: normal operation (was 0.50)
  TIER_YELLOW: 0.50,  // 35-50%: enable tool output trimming (was 0.62)
  TIER_RED: 0.60,     // 50-60%: proactive compression (was 0.72)
  TIER_CRITICAL: 0.75, // >75%: emergency compression (was 0.85)

  // Tool output trimming thresholds (chars, ~4 chars ≈ 1 token)
  TOOL_OUTPUT_MAX_CHARS: 12000,        // Max tool output before trimming (was 8000)
  TOOL_OUTPUT_TRIM_HEAD: 3000,         // Keep first N chars when trimming (was 2000)
  TOOL_OUTPUT_TRIM_TAIL: 3000,         // Keep last N chars when trimming (was 2000)
  TOOL_OUTPUT_YELLOW_MAX: 8000,        // Stricter limit in yellow tier (was 4000)
  TOOL_OUTPUT_RED_MAX: 4000,           // Even stricter in red tier (was 2000)

  // Specific tool limits
  EXEC_OUTPUT_MAX: 10000,   // was 6000 — exec output is often critical for debugging
  WEB_FETCH_OUTPUT_MAX: 8000,  // was 5000
  BROWSER_OUTPUT_MAX: 5000,    // was 3000

  // Compression settings
  COMPRESSION_COOLDOWN_MS: 3 * 60 * 1000,  // 3 minutes between compressions
  KEEP_RECENT_MESSAGES: 8,                   // Messages to keep in full during compression
  SUMMARY_MAX_TOKENS: 500,                   // Max tokens for LLM summary

  // Token estimation: ~4 chars per token for mixed CJK/English
  CHARS_PER_TOKEN: 3.5,

  // Session tracking
  HEALTH_CHECK_INTERVAL_MS: 2 * 60 * 1000,  // Check session health every 2 min
  HEALTH_CHECK_MSG_INTERVAL: 5,               // Or every 5 messages
};

// ─── Per-session state ───
const _sessionState = new Map();

function getSessionState(sessionKey) {
  if (!_sessionState.has(sessionKey)) {
    _sessionState.set(sessionKey, {
      estimatedTokens: 0,
      messageCount: 0,
      toolOutputTokens: 0,
      lastCompressionAt: 0,
      lastHealthCheckAt: 0,
      healthCheckMsgCount: 0,
      tier: 'green',
      compressionCount: 0,
      trimmedOutputs: 0,
      contextWindow: CONFIG.DEFAULT_CONTEXT_WINDOW,
    });
  }
  return _sessionState.get(sessionKey);
}

// ─── Token Estimation ───
// [v22.0] Removed: using shared version from format-utils.mjs
// // function estimateTokens(text) {
//   if (!text) return 0;
//   const str = typeof text === 'string' ? text : JSON.stringify(text);
//   return Math.ceil(str.length / CONFIG.CHARS_PER_TOKEN);
// }

// ─── Tier Classification ───
function classifyTier(usageRatio) {
  if (usageRatio >= CONFIG.TIER_CRITICAL) return 'critical';
  if (usageRatio >= CONFIG.TIER_RED) return 'red';
  if (usageRatio >= CONFIG.TIER_YELLOW) return 'yellow';
  return 'green';
}

const TIER_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴', critical: '💀' };

// ─── Tool Output Trimming ───

/**
 * Trim tool output based on current tier and tool type.
 * Returns { trimmed: boolean, output: string, originalLength: number, trimmedLength: number }
 */
const ERROR_PATTERNS = [
  /\b(ERROR|FATAL|PANIC|FAIL(ED)?|EXCEPTION)\b/i,
  /\b(Traceback|SyntaxError|TypeError|ReferenceError|ImportError|ModuleNotFoundError)\b/,
  /\b(Permission denied|No such file|Connection refused|ECONNREFUSED|ENOENT|EPERM)\b/,
  /^\s*(at\s+|Caused by:|>>>|!!!)/,
  /\b(exit code [1-9]|returned [1-9]|status [4-5]\d\d)\b/i,
  /\b(warn(ing)?|deprecated)\b/i,
];

/**
 * v28.0: Extract error/warning lines from the middle section of tool output.
 * Returns deduplicated lines with 1 line of context above each match.
 */
function extractErrorLines(middleSection, maxErrorChars) {
  const allLines = middleSection.split('\n');
  const matchedIndices = new Set();
  
  for (let i = 0; i < allLines.length; i++) {
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(allLines[i])) {
        if (i > 0) matchedIndices.add(i - 1);
        matchedIndices.add(i);
        break;
      }
    }
  }
  
  if (matchedIndices.size === 0) return { lines: [], count: 0 };
  
  const sorted = [...matchedIndices].sort((a, b) => a - b);
  const result = [];
  let totalChars = 0;
  
  for (const idx of sorted) {
    const line = allLines[idx];
    if (totalChars + line.length + 1 > maxErrorChars) break;
    result.push(line);
    totalChars += line.length + 1;
  }
  
  return { lines: result, count: matchedIndices.size };
}

function trimToolOutput(toolName, output, tier) {
  if (!output || typeof output !== 'string') return { trimmed: false, output: output || '', originalLength: 0, trimmedLength: 0 };
  
  if (process.env.TOOL_OUTPUT_VERBOSE === '1') {
    return { trimmed: false, output, originalLength: output.length, trimmedLength: output.length };
  }
  
  const originalLength = output.length;
  let maxChars;
  if (tier === 'critical' || tier === 'red') {
    maxChars = Math.min(CONFIG.TOOL_OUTPUT_RED_MAX, getToolSpecificLimit(toolName, 'red'));
  } else if (tier === 'yellow') {
    maxChars = Math.min(CONFIG.TOOL_OUTPUT_YELLOW_MAX, getToolSpecificLimit(toolName, 'yellow'));
  } else {
    maxChars = Math.min(CONFIG.TOOL_OUTPUT_MAX_CHARS, getToolSpecificLimit(toolName, 'green'));
  }
  if (originalLength <= maxChars) {
    return { trimmed: false, output, originalLength, trimmedLength: originalLength };
  }
  
  const headSize = Math.min(CONFIG.TOOL_OUTPUT_TRIM_HEAD, Math.floor(maxChars * 0.35));
  const tailSize = Math.min(CONFIG.TOOL_OUTPUT_TRIM_TAIL, Math.floor(maxChars * 0.35));
  const errorBudget = Math.floor(maxChars * 0.2);
  
  const head = output.substring(0, headSize);
  const tail = output.substring(originalLength - tailSize);
  const middleSection = output.substring(headSize, originalLength - tailSize);
  
  const { lines: errorLines, count: errorCount } = extractErrorLines(middleSection, errorBudget);
  
  const omittedChars = originalLength - headSize - tailSize;
  const omittedTokens = Math.ceil(omittedChars / CONFIG.CHARS_PER_TOKEN);
  
  let trimmedOutput;
  if (errorLines.length > 0) {
    const errorBlock = errorLines.join('\n');
    trimmedOutput = `${head}\n\n[... ${omittedChars} chars / ~${omittedTokens} tokens omitted — ${errorCount} error/warning lines extracted below ...]\n\n--- extracted errors ---\n${errorBlock}\n--- end extracted errors ---\n\n${tail}`;
    logger.info(`[${ts()}] [ctx-mgr] [v28.0] ${toolName}: extracted ${errorLines.length}/${errorCount} error lines from middle section`);
  } else {
    trimmedOutput = `${head}\n\n[... ${omittedChars} chars / ~${omittedTokens} tokens omitted for context budget ...]\n\n${tail}`;
  }
  
  return {
    trimmed: true,
    output: trimmedOutput,
    originalLength,
    trimmedLength: trimmedOutput.length,
    errorLinesExtracted: errorLines.length,
  };
}

function getToolSpecificLimit(toolName, tier) {
  const multiplier = tier === 'red' ? 0.4 : tier === 'yellow' ? 0.7 : 1.0;
  switch (toolName) {
    case 'exec': return Math.floor(CONFIG.EXEC_OUTPUT_MAX * multiplier);
    case 'web_fetch': return Math.floor(CONFIG.WEB_FETCH_OUTPUT_MAX * multiplier);
    case 'browser': return Math.floor(CONFIG.BROWSER_OUTPUT_MAX * multiplier);
    default: return Math.floor(CONFIG.TOOL_OUTPUT_MAX_CHARS * multiplier);
  }
}

// ─── Factory ───

/**
 * Create a context window manager for a session.
 * @param {string} sessionKey
 * @param {string} msgId - Current message ID for event emission
 */
export function createContextWindowManager(sessionKey, msgId) {
  const state = getSessionState(sessionKey);

  return {
    /**
     * Record tokens consumed by a user message.
     */
    trackUserMessage(messageText) {
      const tokens = estimateTokens(messageText);
      state.estimatedTokens += tokens;
      state.messageCount++;
      state.healthCheckMsgCount++;
      this._updateTier();
      logger.info(`[${ts()}] [ctx-mgr] User message: +${tokens} tokens, total≈${state.estimatedTokens}, tier=${state.tier}`);
    },

    /**
     * Record tokens consumed by an assistant response.
     */
    trackAssistantResponse(responseText) {
      const tokens = estimateTokens(responseText);
      state.estimatedTokens += tokens;
      this._updateTier();
    },

    /**
     * Process tool output: trim if needed based on current tier.
     * Call this at tool:end BEFORE the output enters the context.
     * Returns the (possibly trimmed) output.
     */
    processToolOutput(toolName, rawOutput) {
      const result = trimToolOutput(toolName, rawOutput, state.tier);

      if (result.trimmed) {
        state.trimmedOutputs++;
        const savedTokens = Math.ceil((result.originalLength - result.trimmedLength) / CONFIG.CHARS_PER_TOKEN);
        logger.info(`[${ts()}] [ctx-mgr] ${TIER_EMOJI[state.tier]} Trimmed ${toolName} output: ${result.originalLength}→${result.trimmedLength} chars (saved ~${savedTokens} tokens)`);
        sendEvent(msgId, {
          type: "context_trim",
          tool: toolName,
          originalChars: result.originalLength,
          trimmedChars: result.trimmedLength,
          savedTokens,
          tier: state.tier,
        });
      }

      // Track tool output tokens
      const outputTokens = estimateTokens(result.output);
      state.toolOutputTokens += outputTokens;
      state.estimatedTokens += outputTokens;
      this._updateTier();

      return result.output;
    },

    /**
     * Check if proactive compression is needed BEFORE sending a message.
     * Returns { needsCompression: boolean, tier: string, action: string }
     * [R33-T3] Added 80k token hard gate
     */
    checkPreSendHealth() {
      this._updateTier();
      const usageRatio = state.estimatedTokens / state.contextWindow;
      
      // [R33-T3] 80k token hard gate — always compress when exceeding budget
      if (state.estimatedTokens >= CONFIG.TOKEN_BUDGET_HARD_LIMIT) {
        logger.info(`[${ts()}] [R33-T3] TOKEN BUDGET GATE: ${state.estimatedTokens} tokens >= ${CONFIG.TOKEN_BUDGET_HARD_LIMIT} limit, forcing compression`);
        return {
          needsCompression: true,
          tier: state.tier,
          action: "token_budget_compress",
          usageRatio,
          estimatedTokens: state.estimatedTokens,
          contextWindow: state.contextWindow,
          budgetExceeded: true,
          budgetLimit: CONFIG.TOKEN_BUDGET_HARD_LIMIT,
        };
      }
      // usageRatio already declared above (R33-T3 fix)

      if (state.tier === 'critical') {
        return {
          needsCompression: true,
          tier: 'critical',
          action: 'emergency_compress',
          usageRatio,
          estimatedTokens: state.estimatedTokens,
          contextWindow: state.contextWindow,
        };
      }

      if (state.tier === 'red') {
        // Check cooldown
        const timeSinceLastCompression = Date.now() - state.lastCompressionAt;
        if (timeSinceLastCompression > CONFIG.COMPRESSION_COOLDOWN_MS) {
          return {
            needsCompression: true,
            tier: 'red',
            action: 'proactive_compress',
            usageRatio,
            estimatedTokens: state.estimatedTokens,
            contextWindow: state.contextWindow,
          };
        }
      }

      // [R57-T1] 消息计数触发：消息数超过阈值也触发压缩，不等 usage 阈值
      // 避免短消息高频场景（每条消息 token 少但积累条数多）无法触发压缩
      const MSG_COMPRESS_THRESHOLD = 30;       // 30 条消息触发 microCompact
      const MSG_EMERGENCY_THRESHOLD = 60;      // 60 条消息触发 emergency
      if (state.messageCount >= MSG_EMERGENCY_THRESHOLD) {
        const timeSinceLastCompression = Date.now() - state.lastCompressionAt;
        if (timeSinceLastCompression > CONFIG.COMPRESSION_COOLDOWN_MS) {
          return {
            needsCompression: true,
            tier: 'red',
            action: 'message_count_emergency',
            usageRatio,
            estimatedTokens: state.estimatedTokens,
            contextWindow: state.contextWindow,
            messageCount: state.messageCount,
            trigger: 'message_count',
          };
        }
      } else if (state.messageCount >= MSG_COMPRESS_THRESHOLD) {
        const timeSinceLastCompression = Date.now() - state.lastCompressionAt;
        if (timeSinceLastCompression > CONFIG.COMPRESSION_COOLDOWN_MS) {
          return {
            needsCompression: true,
            tier: 'yellow',
            action: 'message_count_compact',
            usageRatio,
            estimatedTokens: state.estimatedTokens,
            contextWindow: state.contextWindow,
            messageCount: state.messageCount,
            trigger: 'message_count',
          };
        }
      }

      return {
        needsCompression: false,
        tier: state.tier,
        action: 'none',
        usageRatio,
        estimatedTokens: state.estimatedTokens,
        contextWindow: state.contextWindow,
      };
    },

    /**
     * Should we do a Gateway sessions.list health check?
     * Replaces the old shouldRunSessionHealthCheck with smarter throttling.
     */
    shouldCheckGatewayHealth() {
      const now = Date.now();
      const timeSinceLast = now - state.lastHealthCheckAt;

      // In yellow+ tiers, check more frequently
      const intervalMs = (state.tier === 'green')
        ? CONFIG.HEALTH_CHECK_INTERVAL_MS
        : CONFIG.HEALTH_CHECK_INTERVAL_MS / 2;

      const intervalMsgs = (state.tier === 'green')
        ? CONFIG.HEALTH_CHECK_MSG_INTERVAL
        : Math.max(2, Math.floor(CONFIG.HEALTH_CHECK_MSG_INTERVAL / 2));

      if (timeSinceLast > intervalMs || state.healthCheckMsgCount >= intervalMsgs) {
        state.lastHealthCheckAt = now;
        state.healthCheckMsgCount = 0;
        return true;
      }
      return false;
    },

    /**
     * Update estimated tokens from Gateway's real data (sessions.list).
     * Call this after a successful sessions.list response.
     */
    syncFromGateway(gatewayTokens, contextWindow) {
      const oldEstimate = state.estimatedTokens;
      state.estimatedTokens = gatewayTokens;
      if (contextWindow) state.contextWindow = contextWindow;
      this._updateTier();
      const drift = Math.abs(oldEstimate - gatewayTokens);
      const driftPct = oldEstimate > 0 ? Math.round((drift / oldEstimate) * 100) : 0;
      logger.info(`[${ts()}] [ctx-mgr] Synced from Gateway: estimated=${oldEstimate}→actual=${gatewayTokens} (drift=${driftPct}%), window=${state.contextWindow}, tier=${state.tier}`);
    },

    /**
     * Record that compression was performed.
     */
    recordCompression(keptTokens) {
      state.lastCompressionAt = Date.now();
      state.compressionCount++;
      if (keptTokens !== undefined) {
        state.estimatedTokens = keptTokens;
      } else {
        // Estimate: compression typically reduces to ~30% of original
        state.estimatedTokens = Math.floor(state.estimatedTokens * 0.3);
      }
      this._updateTier();
      logger.info(`[${ts()}] [ctx-mgr] Compression recorded (#${state.compressionCount}), tokens≈${state.estimatedTokens}, tier=${state.tier}`);
    },

    /**
     * Get current context window stats for observability.
     */
    getStats() {
      const usageRatio = state.estimatedTokens / state.contextWindow;
      return {
        sessionKey,
        estimatedTokens: state.estimatedTokens,
        contextWindow: state.contextWindow,
        usageRatio: Math.round(usageRatio * 100) / 100,
        usagePct: `${Math.round(usageRatio * 100)}%`,
        tier: state.tier,
        messageCount: state.messageCount,
        toolOutputTokens: state.toolOutputTokens,
        trimmedOutputs: state.trimmedOutputs,
        compressionCount: state.compressionCount,
      };
    },

    /**
     * Get a summary string for logging.
     */
    getSummaryString() {
      const s = this.getStats();
      return `[ctx-mgr] ${TIER_EMOJI[s.tier]} tokens≈${s.estimatedTokens}/${s.contextWindow} (${s.usagePct}) | msgs=${s.messageCount} | tool_output_tokens=${s.toolOutputTokens} | trimmed=${s.trimmedOutputs} | compressions=${s.compressionCount}`;
    },

    /**
     * Reset session state (after session rebuild/delete).
     */
    reset() {
      state.estimatedTokens = 0;
      state.messageCount = 0;
      state.toolOutputTokens = 0;
      state.tier = 'green';
      state.healthCheckMsgCount = 0;
      logger.info(`[${ts()}] [ctx-mgr] Session state reset`);
    },

    // Internal: update tier based on current token usage
    _updateTier() {
      const usageRatio = state.estimatedTokens / state.contextWindow;
      const oldTier = state.tier;
      state.tier = classifyTier(usageRatio);

      if (state.tier !== oldTier) {
        const usagePct = Math.round(usageRatio * 100);
        logger.info(`[${ts()}] [ctx-mgr] Tier change: ${TIER_EMOJI[oldTier]} ${oldTier} → ${TIER_EMOJI[state.tier]} ${state.tier} (${usagePct}%)`);
        sendEvent(msgId, {
          type: "context_tier_change",
          from: oldTier,
          to: state.tier,
          usagePct,
          estimatedTokens: state.estimatedTokens,
        });
        // [R13-T6] Record tier change to DB for SOUL layer confirmation
        try {
          recordCompression('tier_change', 0, {
            sessionKey,
            triggerRatio: usageRatio,
            tokensBefore: state.estimatedTokens,
            extraJson: {
              fromTier: oldTier,
              toTier: state.tier,
              usagePct,
              messageCount: state.messageCount,
              contextWindow: state.contextWindow,
              compressionCount: state.compressionCount,
              trimmedOutputs: state.trimmedOutputs,
            },
          });
          logger.info(`[R13-T6] tier_change recorded: ${oldTier} → ${state.tier}, session=${sessionKey}`);
        } catch (e) {
          logger.warn(`[R13-T6] tier_change record failed: ${e.message}`);
        }
      }
    },
  };
}

/**
 * Get or create a context window manager for a session.
 * Convenience wrapper that reuses existing state.
 */
export function getContextManager(sessionKey, msgId) {
  return createContextWindowManager(sessionKey, msgId);
}

// ─── Iter-C: Usage Ratio & Budget Tool Results ───

/**
 * Iter-C: Calculate context usage ratio from raw messages array.
 * @param {Array} messages - Array of {role, content} messages
 * @param {number} modelMaxTokens - Model's context window size in tokens
 * @returns {number} 0~1 usage ratio
 */
export function getUsageRatio(messages, modelMaxTokens = 200000) {
  if (!messages || messages.length === 0) return 0;
  let totalChars = 0;
  for (const msg of messages) {
    if (!msg.content) continue;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    totalChars += content.length;
  }
  const estimatedTokens = Math.ceil(totalChars / CONFIG.CHARS_PER_TOKEN);
  return Math.min(1, estimatedTokens / modelMaxTokens);
}

/**
 * Iter-C: Budget tool results in messages array.
 * Truncates oversized tool outputs EXCEPT file_read/read_file (Infinity exemption).
 * Modifies messages in-place and returns stats.
 * @param {Array} messages - Array of {role, content, toolName?} messages
 * @returns {{ truncated: number, exempted: number, savedChars: number }}
 */
export function budgetToolResults(messages) {
  const EXEMPT_TOOLS = new Set(['file_read', 'read_file', 'ReadFile', 'Read']);
  const MAX_TOOL_RESULT_CHARS = 8000;
  const stats = { truncated: 0, exempted: 0, savedChars: 0 };
  
  for (const msg of messages) {
    if (msg.role !== 'tool' && msg.role !== 'function') continue;
    if (!msg.content || typeof msg.content !== 'string') continue;
    
    // Check exemption
    const toolName = msg.toolName || msg.name || '';
    if (EXEMPT_TOOLS.has(toolName)) {
      stats.exempted++;
      continue;
    }
    
    if (msg.content.length > MAX_TOOL_RESULT_CHARS) {
      const original = msg.content.length;
      const head = msg.content.substring(0, 3000);
      const tail = msg.content.substring(msg.content.length - 2000);
      msg.content = `${head}\n\n[... ${original - 5000} chars truncated by budgetToolResults ...]\n\n${tail}`;
      stats.truncated++;
      stats.savedChars += original - msg.content.length;
    }
  }
  
  return stats;
}


