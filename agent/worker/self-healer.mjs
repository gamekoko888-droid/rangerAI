// ─── Self-Healer: Recovery Strategies ───
// Extracted from openclaw-handler.mjs (Phase 5: Planner/Executor split)
// Responsibilities:
//   - Tool summary requests (when tools ran but no text)
//   - Truncation continuation (when response was cut off)
//   - Session rebuild with context recovery (from DB)

import { sendStep, updateStep, sendEvent } from "./ipc-utils.mjs";
import { rewriteWorkspacePaths } from "./format-utils.mjs";
import { getChatBySessionKey, getConversationHistory } from "./db-proxy.mjs";
import { cleanHeartbeat, extractFinalText } from "./stream-processor.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

/**
 * Execute a follow-up message to the Gateway and collect the response.
 * Used by tool summary and truncation continuation.
 *
 * @param {string} message - The follow-up message to send
 * @param {string} sessionKey
 * @param {string} msgId
 * @param {object} deps - { gateway }
 * @param {object} streamState - { streamStarted, streamId } for continuing the stream
 * @returns {Promise<{text: string|null, streamStarted: boolean}>}
 */
async function executeFollowUp(message, sessionKey, msgId, deps, streamState = {}) {
  const { gateway } = deps;
  let { streamStarted = false, streamId = `stream-heal-${Date.now()}` } = streamState;

  // RCA improvement #6: Check Gateway connection before attempting follow-up
  if (!gateway.isConnected) {
    logger.info(`[${ts()}] [self-healer] Gateway not connected — skipping follow-up to avoid cascading failures`);
    return { text: null, streamStarted };
  }

  try {
    const key = `ranger-heal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = await gateway.request("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: key
    });

    const runId = payload.runId;
    logger.info(`[${ts()}] [self-healer] Follow-up run started: ${runId}`);

    return new Promise((resolve) => {
      let text = "";
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          gateway.offRunEvents(runId);
          logger.info(`[${ts()}] [self-healer] Follow-up timed out after 30s, got ${text.length} chars`);
          resolve({ text: text || null, streamStarted });
        }
      }, 30000);

      gateway.onRunEvents(runId, (msg) => {
        const p = msg.payload;

        if (msg.event === "agent") {
          if (p.stream === "text" || p.stream === "assistant") {
            const delta = p.data?.delta || "";
            if (delta) {
              const cleanDelta = delta.replace(/HEARTBEAT_OK|HEARTBEAT|NO_REPLY?|NO_REPL?/g, "").replace(/\|$/, "");
              if (cleanDelta) {
                text += cleanDelta;
                if (!streamStarted) {
                  streamStarted = true;
                  sendEvent(msgId, { type: "stream_start", id: streamId, provider: "rangerai", model: "RangerAI" });
                }
                sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(cleanDelta) });
              }
            }
          }
        }

        if (msg.event === "chat" && p.state === "final") {
          const msgModel = p.message?.model || "";
          if (msgModel === "gateway-injected") return;
          // v6.3: Detect session reset (seq:1 = Gateway created new empty session)
          const seq = p.seq || p.message?.seq;
          if (seq === 1 && !text) { logger.info(`[${ts()}] [self-healer] WARNING: seq=1 detected — session reset. Follow-up may fail.`); }

          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            gateway.offRunEvents(runId);

            const finalText = extractFinalText(p.message?.content);
            if (!text && finalText) text = finalText;
            resolve({ text: text || null, streamStarted });
          }
        }
      });
    });
  } catch (err) {
    logger.info(`[${ts()}] [self-healer] Follow-up failed: ${err.message}`);
    return { text: null, streamStarted };
  }
}

/**
 * Request a tool execution summary from the AI.
 * Used when tools ran but the AI didn't produce a text response.
 *
 * @param {string} sessionKey
 * @param {string} msgId
 * @param {number} toolCount
 * @param {string[]} toolNames
 * @param {object} deps - { gateway }
 * @param {object} streamState - { streamStarted, streamId }
 * @returns {Promise<{text: string|null, streamStarted: boolean}>}
 */
export async function requestToolSummary(sessionKey, msgId, toolCount, toolNames, deps, streamState, userMessage = null) {
  const uniqueTools = [...new Set(toolNames)];
  logger.info(`[${ts()}] [self-healer] Tools ran (${toolCount}x: ${uniqueTools.join(", ")}) but no text reply. Requesting summary...`);
  sendEvent(msgId, { type: "thinking", content: "正在生成工具执行总结...\n" });

  const summaryMsg = userMessage ? `用户的原始问题是：${userMessage.substring(0, 300)}

你执行了 ${toolCount} 个工具操作（${uniqueTools.join(", ")}）。请直接回答用户的问题，给出具体结果。不要泛泛总结工具操作过程。` : `请用中文简要总结你刚才执行的 ${toolCount} 个工具操作的结果。直接给出结果，不要重复工具调用。`;
  return executeFollowUp(summaryMsg, sessionKey, msgId, deps, streamState);
}

/**
 * Continue a truncated response.
 *
 * @param {string} sessionKey
 * @param {string} msgId
 * @param {object} deps - { gateway }
 * @param {object} streamState - { streamStarted, streamId }
 * @returns {Promise<{text: string|null, streamStarted: boolean}>}
 */
export async function continueTruncation(sessionKey, msgId, deps, streamState, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  logger.info(`[${ts()}] [self-healer] Continuing truncated response (attempt ${attempt}/${MAX_ATTEMPTS})...`);
  sendEvent(msgId, { type: "thinking", content: attempt === 1
    ? "检测到回复可能被截断，正在获取后续内容...\n"
    : `第 ${attempt} 次续写尝试...\n`
  });

  const result = await executeFollowUp("继续", sessionKey, msgId, deps, streamState);

  // If still truncated and have retries left, try again
  if (attempt < MAX_ATTEMPTS && (!result.text || result.text.trim().length < 50)) {
    logger.info(`[${ts()}] [self-healer] Continuation attempt ${attempt} yielded short/empty result (${result.text?.length || 0} chars), retrying...`);
    await new Promise(r => setTimeout(r, 1500)); // brief pause before retry
    return continueTruncation(sessionKey, msgId, deps, { ...streamState, streamStarted: result.streamStarted }, attempt + 1);
  }

  return result;
}

/**
 * Rebuild session with context recovery from database.
 *
 * @param {string} sessionKey
 * @param {object} deps - { gateway }
 * @returns {Promise<boolean>}
 */
export async function rebuildSessionWithContext(sessionKey, deps) {
  const { gateway } = deps;
  logger.info(`[${ts()}] [self-healer] Rebuilding session: ${sessionKey}`);
  try {
    // Step 1: Abort and try to compact (preserves session, clears history)
    try { await gateway.abortChat(sessionKey); } catch(_err) { /* v22.0 */ logger.error("[self-healer] silent catch:", _err?.message || _err); }
    
    let sessionExists = true;
    try {
      await gateway.compactSession(sessionKey);
      logger.info(`[${ts()}] [self-healer] Session compacted (history cleared, session preserved)`);
    } catch (compactErr) {
      logger.info(`[${ts()}] [self-healer] Compact failed: ${compactErr.message}, falling back to delete`);
      try {
        await gateway.deleteSession(sessionKey);
        sessionExists = false;
        logger.info(`[${ts()}] [self-healer] Old session destroyed`);
      } catch (delErr) {
        logger.info(`[${ts()}] [self-healer] Delete also failed: ${delErr.message}`);
      }
    }
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Step 2: Context recovery from DB via chat.send (NOT chat.inject)
    // chat.inject injects as assistant role — wrong for history recovery
    // chat.send works whether session exists or not (auto-creates if needed)
    try {
      const chat = await getChatBySessionKey(sessionKey);
      if (chat) {
        const history = await getConversationHistory(chat.id, 10);
        if (history && history.length > 0) {
          logger.info(`[${ts()}] [self-healer] Preparing ${history.length} history messages for context recovery`);
          const contextMessages = history
            .filter(m => m.content && m.content.trim().length > 0)
            .map(m => {
              const role = m.role === "user" ? "User" : "Assistant";
              const content = m.content.length > 500
                ? m.content.substring(0, 500) + "... (truncated)"
                : m.content;
              return `[${role}]: ${content}`;
            });
          if (contextMessages.length > 0) {
            const contextSummary = `[CONVERSATION_HISTORY_RECOVERY]\nThe previous session was rebuilt due to an error. Here is the recent conversation context for continuity:\n\n${contextMessages.join("\n\n")}\n[/CONVERSATION_HISTORY_RECOVERY]`;
            // P1-4: Use chat.inject instead of chat.send + abortChat
            // chat.inject writes context synchronously without triggering AI response,
            // avoiding the race condition where abortChat cancels before context is written
            try {
              await gateway.request("chat.inject", {
                sessionKey,
                content: contextSummary,
                role: "user"
              });
              logger.info(`[${ts()}] [self-healer] Context recovery successful: ${contextMessages.length} messages via chat.inject`);
            } catch (injectErr) {
              // Fallback: try chat.send if chat.inject is not supported
              logger.info(`[${ts()}] [self-healer] chat.inject failed (${injectErr.message}), falling back to chat.send`);
              try {
                const key = `ctx-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                const sendResult = await gateway.request("chat.send", {
                  sessionKey,
                  message: contextSummary,
                  deliver: false,
                  idempotencyKey: key
                });
                if (sendResult?.runId) {
                  // Wait longer (8s) to ensure context is written before aborting
                  await new Promise(r => setTimeout(r, 8000));
                  try { await gateway.abortChat(sessionKey); } catch(_err) { /* v22.0 */ logger.error("[self-healer] silent catch:", _err?.message || _err); }
                }
                logger.info(`[${ts()}] [self-healer] Context recovery successful via chat.send fallback`);
              } catch (sendErr) {
                logger.info(`[${ts()}] [self-healer] Context recovery via chat.send also failed: ${sendErr.message}`);
              }
            }
          }
        } else {
          logger.info(`[${ts()}] [self-healer] No history found in DB for context recovery`);
        }
      } else {
        logger.info(`[${ts()}] [self-healer] Chat not found in DB for sessionKey: ${sessionKey}`);
      }
    } catch (dbErr) {
      logger.info(`[${ts()}] [self-healer] Context recovery DB error (non-fatal): ${dbErr.message}`);
    }
    logger.info(`[${ts()}] [self-healer] Session rebuild complete`);
    return true;
  } catch (err) {
    logger.info(`[${ts()}] [self-healer] Session rebuild failed: ${err.message}`);
    return false;
  }
}

/**
 * Compact session to reduce token count.
 */
export async function compactSession(sessionKey, deps) {
  const { gateway } = deps;
  try {
    const result = await gateway.compactSession(sessionKey);
    logger.info(`[${ts()}] [self-healer] Session compacted: ${sessionKey}`);
    return result;
  } catch (err) {
    logger.info(`[${ts()}] [self-healer] Session compact failed: ${err.message}`);
    return null;
  }
}
