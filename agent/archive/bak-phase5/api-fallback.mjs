/**
 * @deprecated v22.2 - These fallback functions are no longer called.
 * v22.1 disabled direct LLM fallback; Gateway errors now report to user directly.
 * Kept for reference only. Safe to delete in future cleanup.
 */
/**
 * api-fallback.mjs — Direct API Fallback Pipeline
 * 从 user-message-handler.mjs 中提取（Iter-63 重构）
 * v13: 使用直连 API (OpenAI/Anthropic/Google) 作为 Gateway 降级方案
 *
 * 覆盖两种场景：
 *   1. Gateway 健康分降级（routing.useGateway === false）→ 尝试直连 API
 *   2. Gateway 所有重试耗尽后的最终兜底 → 尝试直连 API
 *
 * 返回值统一：
 *   { ok: true,  content: string }   — 成功
 *   { ok: false, reason: 'rate_limit' | 'all_failed', content: string } — 失败（含用户可见错误文字）
 */
import { sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { estimateTokens, sanitizeForFrontend } from "./format-utils.mjs";
import { callDirectAPIWithFallback, getSoulSystemPrompt } from "../llm-gateway.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

// Iter-S7: Log gateway events via IPC to main process for quota monitoring
function logGatewayEvent({ provider, model, error_type, error_message, fallback_result }) {
  try {
    process.send({ type: 'log_gateway_event', provider, model, error_type, error_message, fallback_result });
  } catch { /* worker may not have IPC */ }
}

/**
 * 场景 1：Gateway 健康分降级，跳过 Gateway，使用直连 API。
 * v13: 使用 callDirectAPIWithFallback 尝试 OpenAI/Anthropic/Google 直连
 */
export async function handleDegradedGatewayFallback({ msgId, userMessage, conversationHistory, attachments, routing }) {
  logger.info(`[${ts()}] [fallback] Gateway health degraded (score=${routing.healthScore}). Trying direct API fallback...`);
  logGatewayEvent({ provider: 'gateway', model: 'openclaw', error_type: 'health_degraded', error_message: `Health score: ${routing.healthScore}`, fallback_result: 'attempting_direct_api' });
  const stepId = sendStep(msgId, "⚖️ 通道自动分流", "running", `当前网关负载高(分:${routing.healthScore})，尝试直连 API...`);
  sendEvent(msgId, { type: "thinking", content: "⚠️ Gateway 健康度低，切换到直连 API...\n" });
  // v1.1: Clear any previous error banner
  sendEvent(msgId, { type: "clear_error" });
  sendEvent(msgId, { type: "status", status: "streaming" });

  try {
    const result = await callDirectAPIWithFallback({
      message: userMessage,
      history: conversationHistory || [],
      taskType: routing.taskType || "chat",
      attachments,
      systemPrompt: getSoulSystemPrompt(),
      onDelta: (delta) => {
        sendEvent(msgId, { type: "stream_chunk", content: delta });
      },
      onDone: (content, model) => {
        sendEvent(msgId, { type: "message_done", content, model: model || "direct-api", provider: "direct-api", tokens: estimateTokens(content) });
        sendEvent(msgId, { type: "status", status: "idle" });
      }
    });

    updateStep(msgId, stepId, "success", `直连 API 成功: ${result.model}`);
    logger.info(`[${ts()}] [fallback] Direct API success: ${result.model}, ${result.content.length} chars`);
    return { ok: true, content: result.content };

  } catch (err) {
    logger.info(`[${ts()}] [fallback] Direct API fallback also failed: ${err.message}`);
    logGatewayEvent({ provider: 'direct-api', model: 'unknown', error_type: 'all_failed', error_message: err.message, fallback_result: 'failed' });
    const content = `⚠️ **AI 服务暂时不可用**\n\nGateway 健康度低 (分: ${routing.healthScore})，直连 API 也调用失败。\n\n错误：${sanitizeForFrontend(err.message)}\n\n**建议：**\n- 稍等 1 分钟后重试\n- 如持续出现，请联系管理员检查服务状态`;
    sendEvent(msgId, { type: "message_done", content, model: "RangerAI", provider: "rangerai" });
    sendEvent(msgId, { type: "status", status: "idle" });
    updateStep(msgId, stepId, "error", "直连 API 也失败");
    return { ok: false, reason: "all_failed", content };
  }
}

/**
 * 场景 2：Gateway 所有重试耗尽后的最终兜底。
 * v13: 使用直连 API 作为最后手段
 */
export async function handleGatewayExhaustedFallback({ msgId, userMessage, conversationHistory, attachments, routing, lastError }) {
  const isRateLimit = /rate.?limit|quota|429|FailoverError/i.test(lastError?.message || "");
  const errorMsg = sanitizeForFrontend(lastError?.message || "未知错误");
  logger.info(`[${ts()}] [fallback] Gateway exhausted. Error: ${errorMsg}. Trying direct API...`);
  logGatewayEvent({ provider: 'gateway', model: 'openclaw', error_type: isRateLimit ? 'rate_limit' : 'gateway_error', error_message: errorMsg, fallback_result: 'attempting_direct_api' });

  if (isRateLimit) {
    // Rate limit — still try direct API as it uses different keys
    const stepId = sendStep(msgId, "🔄 切换直连 API", "running", "Gateway 配额耗尽，尝试直连 API...");
    // v1.1: Clear any previous error banner from Gateway failure before fallback streaming
    sendEvent(msgId, { type: "clear_error" });
    sendEvent(msgId, { type: "status", status: "streaming" });
    try {
      const result = await callDirectAPIWithFallback({
        message: userMessage,
        history: conversationHistory || [],
        taskType: routing?.taskType || "chat",
        attachments,
        systemPrompt: getSoulSystemPrompt(),
        onDelta: (delta) => {
          sendEvent(msgId, { type: "stream_chunk", content: delta });
        },
        onDone: (content, model) => {
          sendEvent(msgId, { type: "message_done", content, model: model || "direct-api", provider: "direct-api", tokens: estimateTokens(content) });
          sendEvent(msgId, { type: "status", status: "idle" });
        }
      });
      updateStep(msgId, stepId, "success", `直连 API 成功: ${result.model}`);
      return { ok: true, content: result.content };
    } catch (directErr) {
      updateStep(msgId, stepId, "error", "直连 API 也失败");
      const content = "⚠️ AI 模型 API 配额已用尽\n\n所有 AI 模型的 API 调用配额已耗尽。\n\n**建议：**\n- 等待 1-2 小时后重试\n- 联系管理员充值 API 额度";
      sendEvent(msgId, { type: "message_done", content, model: "RangerAI", provider: "rangerai" });
      sendEvent(msgId, { type: "error", code: "rate_limited", message: content, recoverable: false });
      sendEvent(msgId, { type: "status", status: "idle" });
      return { ok: false, reason: "rate_limit", content };
    }
  } else {
    const rescueStepId = sendStep(msgId, "🆘 AI 引擎诊断", "running", "Gateway 连接失败，尝试直连 API...");
    // v1.1: Clear any previous error banner from Gateway failure before fallback streaming
    sendEvent(msgId, { type: "clear_error" });
    sendEvent(msgId, { type: "status", status: "streaming" });
    try {
      const result = await callDirectAPIWithFallback({
        message: userMessage,
        history: conversationHistory || [],
        taskType: routing?.taskType || "chat",
        attachments,
        systemPrompt: getSoulSystemPrompt(),
        onDelta: (delta) => {
          sendEvent(msgId, { type: "stream_chunk", content: delta });
        },
        onDone: (content, model) => {
          sendEvent(msgId, { type: "message_done", content, model: model || "direct-api", provider: "direct-api", tokens: estimateTokens(content) });
          sendEvent(msgId, { type: "status", status: "idle" });
        }
      });
      updateStep(msgId, rescueStepId, "success", `直连 API 救援成功: ${result.model}`);
      return { ok: true, content: result.content };
    } catch (directErr) {
      updateStep(msgId, rescueStepId, "error", "所有通道均失败");
      const content = `⚠️ **AI 通道暂时不可用**\n\nGateway 错误：${errorMsg}\n直连 API 错误：${sanitizeForFrontend(directErr.message)}\n\n**建议：**\n- 稍等 1 分钟后重试\n- 如持续出现，请联系管理员检查服务状态`;
      sendEvent(msgId, { type: "message_done", content, model: "RangerAI", provider: "rangerai" });
      sendEvent(msgId, { type: "status", status: "idle" });
      return { ok: false, reason: "all_failed", content };
    }
  }
}
