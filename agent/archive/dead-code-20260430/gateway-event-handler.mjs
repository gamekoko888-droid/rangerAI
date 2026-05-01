// gateway-event-handler.mjs — Extracted from openclaw-handler.mjs (Iter-I)
// Handles all Gateway run events: text streaming, tool lifecycle, chat:final, lifecycle events
// Receives a shared context object (ctx) with all state needed for event processing

import { sendStep, updateStep, sendEvent, sendNotify } from "./ipc-utils.mjs";
import {
  sanitizeForFrontend, estimateTokens, rewriteWorkspacePaths, parseResponseMode
} from "./format-utils.mjs"; // Iter-S: added parseResponseMode
import {
  detectTruncation, cleanHeartbeat, extractFinalText, appendMediaToText, cleanFinalText
} from "./stream-processor.mjs";
import {
  requestToolSummary, continueTruncation
} from "./self-healer.mjs";
import { setCurrentRunId } from "./run-tracker.mjs";
import { processTextForPlan, cleanupPlan, getSerializablePlan } from "./task-engine.mjs";
import { markStepDone as progressMarkStepDone, buildProgressBlock, shouldTrackProgress, cleanupTracker, hasProgress } from "./task-engine.mjs";
import { extractAssistantReplyFromJsonl } from "./jsonl-fallback.mjs";
import { recordToolExperience, extractAndStoreFact, recordTaskPattern, getAdaptiveMemoryStats, cleanupExpired, getToolSubType } from "./adaptive-memory.mjs";
import { gateToolExecution, handleApprovalResponse } from "./human-approval.mjs";
import { shouldAutoVerify, buildAutoVerifyMessage, recordVerification } from "../visual-verifier.mjs"; // Iter-O: use canonical root version
import { extractGatewayUsage } from "./usage-tracker.mjs";
import { handleLongOutput } from "./output-manager.mjs";
import { logger } from "../lib/logger.mjs";

const ts = () => new Date().toISOString();

/**
 * Handle the "finish success" path — self-heal, truncation detection, final event emission.
 * @param {string} text - The accumulated fullText
 * @param {object} ctx - Shared context from openclaw-handler
 */
export async function handleFinishSuccess(text, ctx) {
  const {
    resolved, tracker, orchestrator, ctxMgr, streamFilter,
    msgId, sessionKey, thinkStepId, streamId, streamStarted,
    selfHealAttempted, selfHealInProgress, deps, fullTextRef,
    heartbeatTimer, timeoutTimer, cleanup, resolve, reject,
    gatewayUsage, thinkingReceived, routeModelPatched, gateway,
    gatewaySessionKey, planABResult, orchToolIdMap, toolStartTimes, toolIdMap,
    sendEventFn, updateStepFn
  } = ctx;

  if (ctx._resolved) return;
  ctx._resolved = true;
  clearInterval(heartbeatTimer);
  clearTimeout(timeoutTimer);

  const hasText = text && text.trim().length > 0;
  const hasTools = tracker.toolCount > 0;
  const summary = tracker.getSummary();
  const textLen = text ? text.trim().length : 0;
  const shortTextThreshold = Math.max(120, summary.toolCount * 30);
  const isShortTextManyTools = hasText && textLen < shortTextThreshold && summary.toolCount >= 3;

  logger.info(`[${ts()}] [worker] [CHECKPOINT] Response validation: text=${hasText ? textLen + "chars" : "EMPTY"}, tools=${summary.toolCount}, threshold=${shortTextThreshold}, selfHealAttempted=${ctx._selfHealAttempted}, isShortTextManyTools=${isShortTextManyTools}`);

  // SELF-HEAL: Tools ran but no text reply -> request summary
  if ((!hasText || isShortTextManyTools) && hasTools && !ctx._selfHealAttempted && !ctx._selfHealInProgress) {
    ctx._selfHealInProgress = true;
    const healReason = isShortTextManyTools
      ? `SHORT_TEXT_MANY_TOOLS: ${textLen} chars text but ${summary.toolCount} tools executed`
      : `${summary.toolCount} tools executed but no text`;
    logger.info(`[${ts()}] [worker] [CHECKPOINT] FAILED: ${healReason}. Triggering self-heal...`);
    sendEvent(msgId, { type: "thinking", content: `\u2705 ${summary.toolCount} 个工具操作完成，正在生成总结...\n` });

    const healResult = await requestToolSummary(
      sessionKey, msgId, summary.toolCount, summary.toolNames,
      deps, { streamStarted: ctx._streamStarted, streamId: ctx._streamId }
    );
    if (healResult && healResult.text && healResult.text.trim().length > 0) {
      logger.info(`[${ts()}] [worker] [SELF-HEAL] Got summary (${healResult.text.length} chars), using as reply`);
      ctx._fullText = healResult.text;
      text = healResult.text;
      ctx._streamStarted = healResult.streamStarted;
    } else {
      logger.info(`[${ts()}] [worker] [SELF-HEAL] Summary also empty, using fallback message`);
      text = `\u2705 已执行 ${summary.toolCount} 个工具操作（${summary.uniqueTools.join("\u3001")}）。\n\nAI 完成了工具调用但未能生成文本总结。请查看上方的工具执行详情，或发送「继续」获取结果总结。`;
    }
  }
  ctx._selfHealInProgress = false;
  ctx._selfHealAttempted = true;

  // SELF-HEAL: Truncation detection
  if (text && detectTruncation(text) && tracker.toolCount < 10 && !ctx._selfHealAttempted) {
    logger.info(`[${ts()}] [worker] [CHECKPOINT] Possible truncation detected (text length: ${text.length}, toolCount: ${tracker.toolCount})`);
    ctx._selfHealAttempted = true;
    const contResult = await continueTruncation(
      sessionKey, msgId, deps, { streamStarted: ctx._streamStarted, streamId: ctx._streamId }, 1
    );
    if (contResult && contResult.text && contResult.text.trim().length > 0) {
      text += contResult.text;
      ctx._fullText = text;
      ctx._streamStarted = contResult.streamStarted;
      if (detectTruncation(contResult.text)) {
        text += "\n\n---\n> ⚠️ 内容较长，回复已分段。如需继续，请发送「继续」。";
      }
    } else {
      text += "\n\n---\n> ⚠️ 回复可能被截断。如需完整内容，请发送「继续」。";
    }
  }

  // Append media images to text
  text = appendMediaToText(text || "", summary.mediaImages);
  // Long output handling
  text = handleLongOutput(text, msgId, sendEvent);
  // Flush stream filter buffer and clean final text
  const flushed = streamFilter.flush();
  text = cleanFinalText(text);

  cleanup("completed");

  const processedText = rewriteWorkspacePaths(text);
  if (ctx._streamStarted) {
    sendEvent(msgId, { type: "stream_end", id: ctx._streamId, content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(text) });
  } else if (text) {
    sendEvent(msgId, { type: "message_done", content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(text) });
  }

  updateStep(msgId, thinkStepId, "completed", text.length > 0 ? `${text.length} 字` : "已完成");
  sendEvent(msgId, { type: "status", status: "idle" });
  sendEvent(msgId, { type: "stats", toolCalls: summary.toolCount, tokens: estimateTokens(text) });

  // Task plan completion
  try {
    const finalPlan = getSerializablePlan(msgId);
    if (finalPlan) {
      sendEvent(msgId, { type: "plan_completed", plan: finalPlan });
    }
    cleanupPlan(msgId);
  } catch (planErr) {
    logger.info(`[${ts()}] [worker] [task-planner] Cleanup error: ${planErr.message}`);
  }

  // Orchestrator + context stats
  logger.info(`[${ts()}] [worker] ${orchestrator.getSummaryString()}`);
  ctxMgr.trackAssistantResponse(text);
  logger.info(`[${ts()}] [worker] ${ctxMgr.getSummaryString()}`);
  sendEvent(msgId, { type: "context_stats", ...ctxMgr.getStats() });
  const orchStats = orchestrator.getStats();
  if (orchStats.classificationCount > 0) {
    sendEvent(msgId, { type: "orchestrator_stats", ...orchStats });
  }

  // Adaptive memory
  const toolSequence = orchestrator.getClassificationHistory().map(c => ({ name: c.toolName, class: c.safetyClass }));
  if (toolSequence.length >= 3) {
    recordTaskPattern(ctx._userMessage, toolSequence, true, sessionKey).catch(() => {});
  }
  getAdaptiveMemoryStats().then(amStats => {
    if (amStats) {
      sendEvent(msgId, { type: "adaptive_memory_stats", ...amStats });
    }
  }).catch(() => {});
  cleanupExpired().catch(() => {});

  // Gateway usage
  if (!ctx._gatewayUsage && sessionKey) {
    ctx._gatewayUsage = await extractGatewayUsage(sessionKey);
  }

  // Model restoration
  if (routeModelPatched) {
    try {
      await gateway.request("sessions.patch", {
        key: gatewaySessionKey,
        model: "openai/gpt-5.5" // R82: was anthropic/claude-sonnet-4-6 (not in gateway config)
      });
    } catch (restoreErr) {
      logger.warn(`[${ts()}] [worker] [v25.2] routedModel restore failed: ${restoreErr.message}`);
    }
  }

  // Plan A/B monitoring
  if (planABResult) {
    const outcome = ctx._resolved ? "success" : "error";
    logger.info(`[${ts()}] [worker] [PLAN_AB_MONITOR] plan=${planABResult.plan} model=${planABResult.model} outcome=${outcome} toolCount=${tracker.toolCount} textLen=${text?.length || 0}`);
  }

  const { mode: responseMode, cleanText: responseText } = parseResponseMode(text);
  if (responseMode !== 'default') {
    logger.info(`[${ts()}] [worker] [Iter-S] responseMode=${responseMode} (${text.length} → ${responseText.length} chars)`);
    text = responseText; // 清除标记，避免展示给用户
  }

  resolve({ text, gatewayUsage: ctx._gatewayUsage, thinkingReceived: ctx._thinkingReceived, responseMode });
}

/**
 * Handle the "finish error" path.
 */
export function handleFinishError(errMsg, ctx) {
  if (ctx._resolved) return;
  ctx._resolved = true;
  clearInterval(ctx.heartbeatTimer);
  ctx.cleanup("error");

  const { msgId, thinkStepId, gateway } = ctx;
  const fullText = ctx._fullText;

  if (fullText.length > 100) {
    const processedText = rewriteWorkspacePaths(fullText);
    if (ctx._streamStarted) {
      sendEvent(msgId, { type: "stream_end", id: ctx._streamId, content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(fullText) });
    }
    updateStep(msgId, thinkStepId, "completed", `${fullText.length} 字 (部分)`);
    sendEvent(msgId, { type: "status", status: "idle" });
    ctx.resolve({ text: fullText, gatewayUsage: ctx._gatewayUsage, thinkingReceived: ctx._thinkingReceived });
  } else {
    if (ctx._streamStarted) {
      sendEvent(msgId, { type: "stream_end", id: ctx._streamId, content: rewriteWorkspacePaths(fullText || ""), model: "RangerAI", provider: "rangerai" });
    }
    sendEvent(msgId, { type: "error", message: sanitizeForFrontend(errMsg).substring(0, 200) });
    sendEvent(msgId, { type: "status", status: "idle" });
    updateStep(msgId, thinkStepId, "error", sanitizeForFrontend(errMsg).substring(0, 80));
    ctx.reject(new Error(errMsg));
  }
}
