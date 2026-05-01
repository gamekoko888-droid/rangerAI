// user-message-handler.mjs — Thin glue layer (Iter-I refactored)
// Delegates to: message-router.mjs, context-injector.mjs, openclaw-handler.mjs
// Retains: helpers, handleUserMessage wrapper, Gateway retry loop, result processing

import fs from "fs";
import { resetStepCounter, sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { sanitizeForFrontend, estimateTokens } from "./format-utils.mjs";
import { handleViaOpenClaw } from "./openclaw-handler.mjs";
import { segmentLongMessage } from "./segmenter.mjs";
import { getRoutingDecision, logRoutingDecision, getSoulSystemPrompt } from "../llm-gateway.mjs";
import { getConversationHistory, getChatBySessionKey } from "./db-proxy.mjs";
import { checkAndCompress } from "./context-compressor.mjs";
import { getContextManager } from "./context-window-manager.mjs";
import { handleVisionMessage } from "./vision-handler.mjs";
import { startTrace, startSpan, updateTraceModel, endTrace } from "./observability.mjs";
import { logger } from "../lib/logger.mjs";
import { buildProgressBlock, buildActiveStatusBlock, hasProgress, shouldTrackProgress, setTrackerMsgId, restoreTrackerFromDB } from "./task-engine.mjs"; // Iter-Q: added buildActiveStatusBlock
import { emitEvent, EVENT_TYPES } from "./event-stream.mjs";
import { getOrCreateTaskState, updateTaskState, extractGoalHeuristic } from "./task-engine.mjs";
import { initTaskWorkspace, cleanupTaskWorkspace } from "./task-workspace.mjs"; // Iter-AB
import { hasRecentErrors, buildErrorSummaryBlock } from "./error-context-manager.mjs"; // Iter-AC
import { resumeTaskFocus } from "./supervisor-agent.mjs"; // [R20-T4]
import { addAnchor, detectAnchorCandidate } from "./context-buffer.mjs";
import { writeMemoryAsync } from "./memory-writer.mjs"; // Iter-K: unified memory write gateway
import { buildHandoffPacket } from "./model-handoff.mjs";
import { resolveRouting } from "./message-router.mjs";
import { runVisionPipeline, detectContinuation, injectKnowledgeAndRecall, checkCircuitBreaker, runContextWindowCheck, recoverExpiredContext, assembleGatewayMessage } from "./context-injector.mjs";
import { scoreAnswer } from "./quality-scorer.mjs"; // [R44-T3]
import { shouldAutoContinue, buildContinueMessage, emitAutoContinue, MAX_AUTO_TURNS, INTER_TURN_DELAY_MS } from "./agent-loop-controller.mjs"; // P0-FIX: Multi-Turn Agent Loop

const ts = () => new Date().toISOString();
const _sessionLastModel = new Map();
const _gatewayUsageMap = new Map();
export const _responseModeMap = new Map(); // Iter-U: responseMode per msgId

// ─── Helpers (retained) ───
async function enrichMessageWithAttachments(userMessage, attachments, ts) {
  if (!attachments || attachments.length === 0) return userMessage;
  const fileAttachments = attachments.filter(a => a.type !== "image" && a.url);
  if (fileAttachments.length === 0) return userMessage;
  logger.info(`[${ts()}] [worker] Found ${fileAttachments.length} non-image file attachment(s), parsing...`);
  const { parseFile, parseUrl } = await import("../lib/file-parser.mjs");
  const fileContents = [];
  for (const att of fileAttachments) {
    try {
      const fileName = att.name || att.url.split("/").pop() || "unknown";
      let result;
      if (att.url.startsWith("/files/")) {
        const localPath = "/opt/rangerai-agent/files/" + att.url.split("/").pop();
        if (fs.existsSync(localPath)) result = await parseFile(localPath, att.mimeType);
        else {
          const pubPath = "/opt/rangerai-agent/public" + att.url;
          const uploadPath = "/opt/rangerai-agent/uploads/" + att.url.split("/").pop();
          if (fs.existsSync(pubPath)) result = await parseFile(pubPath, att.mimeType);
          else if (fs.existsSync(uploadPath)) result = await parseFile(uploadPath, att.mimeType);
        }
      }
      if (!result && att.url.startsWith("http")) result = await parseUrl(att.url, fileName, att.mimeType);
      if (result && result.type !== 'missing' && result.type !== 'error') {
        if (['image', 'audio', 'video', 'archive', 'binary'].includes(result.type)) {
          fileContents.push(`--- 文件: ${fileName} (${result.text}) ---`);
        } else {
          const truncNote = result.truncated ? " (已截断)" : "";
          fileContents.push(`--- 文件: ${fileName}${truncNote} ---\n${result.text}\n--- 文件结束 ---`);
        }
      } else {
        fileContents.push(`--- 文件: ${fileName} (无法读取内容) ---`);
      }
    } catch (err) {
      fileContents.push(`--- 文件: ${att.name || "unknown"} (读取失败: ${err.message}) ---`);
    }
  }
  if (fileContents.length > 0) return userMessage + "\n\n" + fileContents.join("\n\n");
  return userMessage;
}

function resolveExecutionModel(userModel, ts, msgId, sendEvent) {
  if (!userModel) return null;
  if (userModel.includes("claude-sonnet-4.6")) userModel = userModel.replace("claude-sonnet-4.6", "claude-sonnet-4-6");
  sendEvent(msgId, { type: "routing_info", taskType: "user-selected", thinking: "standard", confidence: 1.0, fallbackModel: userModel, description: `用户手动选择模型: ${userModel}` });
  return userModel;
}

async function rebuildSession(gateway, sessionKey) {
  logger.info(`[${ts()}] [worker] Rebuilding session: ${sessionKey}`);
  try {
    try { await gateway.abortChat(sessionKey); } catch(_) {}
    try { await gateway.compactSession(sessionKey); } catch (e) {
      try { await gateway.deleteSession(sessionKey); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 500));
    try { await checkAndCompress(sessionKey, gateway, null); } catch (_) {}
    try {
      const chat = await getChatBySessionKey(sessionKey);
      if (chat) {
        const history = await getConversationHistory(chat.id, 15);
        if (history?.length > 0) {
          const msgs = history.filter(m => m.content?.trim()).map(m => `[${m.role === "user" ? "User" : "Assistant"}]: ${m.content.length > 10000 ? m.content.substring(0, 10000) + "..." : m.content}`);
          if (msgs.length > 0) {
            const ctx = `[SYSTEM_HIDDEN_CONTEXT_RECOVERY]\n${msgs.join("\n\n")}\n[/SYSTEM_HIDDEN_CONTEXT_RECOVERY]`;
            const key = `ctx-recovery-${sessionKey}-${Date.now()}`;
            await gateway.request("chat.send", { sessionKey, message: ctx, deliver: false, idempotencyKey: key });
          }
        }
      }
    } catch (_) {}
    return true;
  } catch (err) {
    logger.info(`[${ts()}] [worker] Session rebuild failed: ${err.message}`);
    return false;
  }
}

// ─── Main Entry Point ───
export async function handleUserMessage(msgId, userMessage, conversationHistory, sessionKey, userModel, attachments, roleSystemPrompt, deps = {}) {
  const gatewaySessionKey = sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;
  let _traceStatus = 'success', _traceError = null, _resultLen = 0, _resultText = "";
  try {
    const _result = await _handleUserMessageInner(msgId, userMessage, conversationHistory, sessionKey, userModel, attachments, roleSystemPrompt, { ...deps, gatewaySessionKey });
    _resultLen = typeof _result === "string" ? _result.length : 0;
    _resultText = typeof _result === "string" ? _result : "";
    return _result;
  } catch (err) {
    _traceStatus = 'error'; _traceError = err.message; throw err;
  } finally {
    try {
      let tokenInfo = null;
      const _gu = _gatewayUsageMap.get(msgId); _gatewayUsageMap.delete(msgId);
      if (_gu && (_gu.input > 0 || _gu.output > 0)) {
        tokenInfo = { prompt_tokens: _gu.input || 0, completion_tokens: _gu.output || 0, total_tokens: _gu.totalTokens || (_gu.input + _gu.output), cache_read_tokens: _gu.cacheRead || 0, cache_write_tokens: _gu.cacheWrite || 0, gateway_cost: _gu.cost || null, source: _gu.source || 'gateway' };
      } else {
        const ct = _resultText ? estimateTokens(_resultText) : 0, pt = userMessage ? estimateTokens(userMessage) : 0;
        tokenInfo = (ct > 0 || pt > 0) ? { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, source: 'estimate' } : null;
      }
      endTrace(msgId, _traceStatus, _traceError, tokenInfo);
    } catch (_) {}
  }
}

async function _handleUserMessageInner(msgId, userMessage, conversationHistory, sessionKey, userModel, attachments, roleSystemPrompt, deps = {}) {
  const { gatewaySessionKey, gateway, gatewayBreaker, browserBreaker, userId, userRole = 'member' } = deps;
  // RBAC v2: Only admin (jianwufy) has unrestricted access
  const isAdmin = userRole === 'admin';
  const isManager = userRole === 'manager';
  
  // Tiered security policy injection
  if (!isAdmin && roleSystemPrompt !== null) {
    let securityPolicy;
    if (isManager) {
      // Manager: relaxed but still restricted
      securityPolicy = `\n\n[SECURITY POLICY]\n当前用户角色：${userRole}（管理层）。\n你可以使用以下工具为用户服务：\n- web_search / browser / web_fetch\n- read / read_file\n- exec：运行数据分析脚本、查看系统状态\n- 所有 AI 推理、文本生成、翻译、数据分析能力\n\n你必须严格遵守以下限制：\n1. 禁止修改 /opt/rangerai/ 下的核心配置文件（可读取）\n2. 禁止修改 /etc/ 下的系统配置文件\n3. 禁止执行 sudo、systemctl、reboot 等系统管理命令\n4. 禁止重启或停止 Ranger 核心服务\n5. 禁止泄露服务器凭据、API 密钥或内部接口地址\n6. 禁止删除数据库表或修改 schema\n7. 禁止修改其他用户的权限或角色\n[/SECURITY POLICY]`;
    } else {
      // member / cs / viewer / finance: strict restrictions
      securityPolicy = `\n\n[SECURITY POLICY]\n当前用户角色：${userRole}（普通用户）。\n你可以使用以下工具为用户服务：\n- web_search / web_fetch\n- read_file（仅限用户自己的文件）\n- 所有 AI 推理、文本生成、翻译、数据分析能力\n\n你必须严格遵守以下限制：\n1. 禁止修改 /opt/rangerai/ 下的任何文件\n2. 禁止修改 /etc/ 下的系统配置文件\n3. 禁止执行 sudo、systemctl、reboot 等命令\n4. 禁止执行 exec 运行任意 shell 命令\n5. 禁止使用 browser 工具访问内部管理页面\n6. 禁止重启或管理 Ranger 服务\n7. 禁止泄露服务器凭据、密钥或内部 API 地址\n8. 禁止修改数据库 schema 或删除数据\n9. 禁止读取其他用户的对话或私有数据\n10. 禁止尝试提升自身权限或冒充其他角色\n[/SECURITY POLICY]`;
    }
    roleSystemPrompt = (roleSystemPrompt || '') + securityPolicy;
  }

  userMessage = await enrichMessageWithAttachments(userMessage, attachments, ts);
  logger.info(`[${ts()}] [worker] === New message (${msgId}): ${userMessage.length} chars ===`);

  const taskId = `task-${sessionKey}`;
  emitEvent(sessionKey, taskId, EVENT_TYPES.USER_MESSAGE, { content: userMessage.substring(0, 500), hasAttachments: !!(attachments?.length), model: userModel || 'auto' });
  try {
    const taskState = await getOrCreateTaskState(sessionKey, taskId);
    if (!taskState.user_goal && userMessage.length > 10) {
      const goal = extractGoalHeuristic(userMessage);
      if (goal) await updateTaskState(taskId, { user_goal: goal });
    }
  } catch (_) {}
  // Iter-AB: 初始化任务工作区（幂等，已存在则不报错）
  try { initTaskWorkspace(taskId); } catch (_) {}
  // [R20-T4] Resume interrupted task focus when user sends new message
  try { resumeTaskFocus(sessionKey); } catch (_resumeErr) {}

  try {
    const ac = detectAnchorCandidate({ role: 'user', content: userMessage }, { isFirstMessage: conversationHistory.length <= 2 });
    if (ac?.shouldAnchor) addAnchor(sessionKey, userMessage.substring(0, 1000), ac.reason, ac.priority);
  } catch (_) {}

  try { startTrace(msgId, { sessionKey, userId, model: userModel, messageLen: userMessage.length }); } catch (_) {}
  resetStepCounter();
  sendEvent(msgId, { type: "status", status: "thinking" });

  {
    try {
      const { getCurrentRunId, getCurrentSessionKey } = await import("./run-tracker.mjs");
      const oldRunId = getCurrentRunId(sessionKey);
      const oldSK = getCurrentSessionKey();
      if (oldRunId && gateway.isConnected) {
        const abortSK = oldSK || sessionKey;
        logger.info(`[${ts()}] [worker] [v9.0] Preemptive abort: killing old runId=${oldRunId}`);
        try { await gateway.request("chat.abort", { sessionKey: abortSK, runId: oldRunId }); await new Promise(r => setTimeout(r, 800)); } catch (_) {}
      }
    } catch (_) {}
  }

  // User-selected model path
  if (userModel && typeof userModel === 'string' && userModel.trim()) {
    resolveExecutionModel(userModel, ts, msgId, sendEvent);
    const vr = await runVisionPipeline(msgId, userMessage, attachments, conversationHistory, getRoutingDecision(userMessage), { forceVision: true });
    if (vr.handled) return vr.userMessage;
    userMessage = vr.userMessage;
  }

  // ─── Routing (delegated to message-router.mjs) ───
  const { routing, intentResult, intentOverride } = await resolveRouting(userMessage, msgId, sessionKey, taskId, deps);

  if (intentResult?.intent === "task") {
    logger.info(`[${ts()}] [worker] [v20.0] Task detected. All tasks use Gateway direct flow.`);
  }

  // Gateway degradation check
  if (!routing.useGateway && routing.gatewayStatus !== "image_direct") {
    logger.error(`[${ts()}] [worker] [v22.1] Gateway degraded (score=${routing.healthScore})`);
    try { if (gateway?.reconnect) await gateway.reconnect(); } catch (_) {}
    const errorContent = `⚠️ **AI 引擎连接异常**\nGateway 健康度过低 (分数: ${routing.healthScore})，请稍后重试。`;
    sendEvent(msgId, { type: "message_done", content: errorContent, model: "RangerAI", provider: "rangerai" });
    sendEvent(msgId, { type: "status", status: "idle" });
    return errorContent;
  }

  const MAX_RETRIES = 5; // R66: increased from 3 for rate limit resilience
  let lastError = null, sessionRebuilt = false;

  // ─── Vision Pipeline (delegated) ───
  const visionResult = await runVisionPipeline(msgId, userMessage, attachments, conversationHistory, routing);
  if (visionResult.handled) return visionResult.userMessage;
  userMessage = visionResult.userMessage;

  // ─── Continuation Detection (delegated) ───
  userMessage = detectContinuation(userMessage, conversationHistory);

  // ─── Knowledge + Recall Injection (delegated) ───
  let gatewayMessage = await injectKnowledgeAndRecall(msgId, userMessage, userId, sessionKey, conversationHistory);

  // ─── Circuit Breaker (delegated) ───
  const cbResult = await checkCircuitBreaker(msgId, sessionKey, gateway, gatewayBreaker);
  if (cbResult.blocked) return cbResult.errorContent;

  // ─── Context Window Check (delegated) ───
  const ctxMgr = await runContextWindowCheck(msgId, sessionKey, gateway);

  // ─── Context Recovery (delegated) ───
  let consecutiveEmptyReplies = 0;
  const _recoveredContext = await recoverExpiredContext(msgId, sessionKey, gatewaySessionKey, gateway, conversationHistory);

  // ─── Message Assembly (delegated) ───
  gatewayMessage = await assembleGatewayMessage(gatewayMessage, userMessage, sessionKey, msgId, taskId, routing, intentResult, intentOverride, deps);

  const { question: cleanQuestion } = segmentLongMessage(userMessage);

  // [R40-T5] Image generation intercept — bypass Gateway for image tasks
  if (routing.taskType === 'image_generation' || (intentResult?.intent === 'image_generation')) {
    try {
      logger.info(`[${ts()}] [R40-T5] Image generation task detected, bypassing Gateway`);
      sendStep(msgId, "🎨 生成图片中", "running", "正在调用图像生成模型...");
      const { handleGenerateImage } = await import('./image-generator.mjs');
      const _imgPrompt = String(userMessage || "").replace(/^(请|帮我|帮忙|麻烦)?(生成|画|创建|制作|做)(一[张幅个只条])?/g, '').trim() || userMessage;
      const _imgResult = await handleGenerateImage({ prompt: _imgPrompt, size: '1024x1024' });
      logger.info(`[${ts()}] [R40-T5] Image generation result: phase=${_imgResult.phase} url=${_imgResult.url || 'none'}`);
      
      if (_imgResult.phase === 'done' || _imgResult.success) {
        // Emit image_generated event
        try {
          const { emitEvent } = await import('./event-stream.mjs');
          emitEvent(sessionKey, msgId, 'image_generated', {
            model: _imgResult.model || 'gpt-image-1',
            prompt: String(userMessage || '').substring(0, 100),
            url: _imgResult.url || _imgResult.servedUrl || '',
            size: '1024x1024',
            fallbackReason: _imgResult.fallbackReason || null, // [R41-T3] Track why gpt-image-1 fell back
            primaryModel: 'gpt-image-1', // [R41-T3] Always record intended primary model
          });
        } catch (_evtErr) { /* non-fatal */ }
        
        const _imgUrl = _imgResult.url || _imgResult.servedUrl || '';
        const _imgContent = `🎨 **图片已生成！**\n\n![生成的图片](${_imgUrl})\n\n**图片地址**: ${_imgUrl}\n\n> 原始请求: ${String(userMessage || '').substring(0, 100)}`;
        sendStep(msgId, "🎨 图片已生成", "success", `图片地址: ${_imgUrl}`);
        sendEvent(msgId, { type: "message_done", content: _imgContent, model: _imgResult.model || "gpt-image-1", provider: "rangerai" });
        sendEvent(msgId, { type: "status", status: "idle" });
        // Emit final_answer
        try {
          const { emitEvent: emitEvt2 } = await import('./event-stream.mjs');
          emitEvt2(sessionKey, msgId, 'final_answer', { content: _imgContent });
        } catch (_) {}
        return _imgContent;
      } else {
        const _errMsg = `⚠️ 图片生成失败: ${_imgResult.error || '未知错误'}\n\n请稍后重试，或尝试更简单的描述。`;
        sendStep(msgId, "🎨 图片生成失败", "error", _imgResult.error || '未知错误');
        sendEvent(msgId, { type: "message_done", content: _errMsg, model: "RangerAI", provider: "rangerai" });
        sendEvent(msgId, { type: "status", status: "idle" });
        return _errMsg;
      }
    } catch (_imgErr) {
      logger.error(`[${ts()}] [R40-T5] Image generation intercept error: ${_imgErr.message}`);
      sendStep(msgId, "🎨 图片生成失败", "error", _imgErr.message);
      // Fall through to Gateway as fallback
    }
  }

    // ─── Gateway Call + Retry Loop ───
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let _watchdogStepId = null;
      const _watchdogTimer = setTimeout(() => {
        _watchdogStepId = sendStep(msgId, "⏱️ 响应延迟预警", "running", "AI 通道超过 120 秒未返回内容...");
      }, 120000);

      let result, _gatewayUsage = null;
      try {
        // Model handoff packet
        let _handoffPacket = null;
        try {
          const _prevModel = _sessionLastModel.get(sessionKey);
          const _currModel = routing?.fallbackModel || 'unknown';
          if (_prevModel && _prevModel !== _currModel) {
            _handoffPacket = await buildHandoffPacket(sessionKey, _currModel, _prevModel, deps.routeResult, { userMessage, userId, conversationHistory });
          }
          _sessionLastModel.set(sessionKey, _currModel);
        } catch (_) {}

        const contextParts = [];
        if (_recoveredContext) contextParts.push(_recoveredContext);
        if (_handoffPacket) contextParts.push(_handoffPacket);
        contextParts.push(gatewayMessage);
        // 每次 LLM 调用前，将最新进度块追加到消息末尾，防止 lost-in-the-middle
        const activeStatusBlock = buildActiveStatusBlock(sessionKey);
        if (activeStatusBlock) {
          contextParts.push(activeStatusBlock);
          logger.info(`[user-message-handler] [Iter-Q] Plan status injected to context end (${activeStatusBlock.length} chars)`);
        }
        const finalMessage = contextParts.join('\n\n');
        updateTraceModel(msgId, routing?.fallbackModel || "unknown");
        // [R41-T2] Emit task_started event
        try { emitEvent(sessionKey, taskId, "task_started", { taskType: routing?.taskType || "chat", model: routing?.fallbackModel || "unknown", startedAt: Date.now() }, routing?.fallbackModel); } catch(_) {}

        result = await handleViaOpenClaw(finalMessage, sessionKey, msgId, {
          timeout: 600000, thinking: routing?.thinking || 'high', roleSystemPrompt,
          needsStrongModel: (userModel?.trim()) ? false : (routing?.needsStrongModel || false),
          strongModel: routing?.strongModel || null, routedModel: routing?.fallbackModel || null,
          userRole, conversationHistory, gatewayTotalTokens: ctxMgr?.getGatewayTokens?.() || 0,
        }, { gateway, browserBreaker });
      } finally {
        clearTimeout(_watchdogTimer);
        // [R41-T2] Emit task_completed event
        try { 
          // [R43-T3] Enhanced task_completed with tool summary
          const _r43CompletedPayload = { completedAt: Date.now(), hasResult: !!result };
          if (result && result.toolNames) _r43CompletedPayload.toolNames = result.toolNames;
          if (result && result.normalizedToolNames) _r43CompletedPayload.normalizedToolNames = result.normalizedToolNames;
          if (result && result.toolCount !== undefined) _r43CompletedPayload.toolCount = result.toolCount;
          emitEvent(sessionKey, taskId, "task_completed", _r43CompletedPayload, routing?.fallbackModel); 
        } catch(_) {}
        // [R44-T3] Async quality scoring (fire-and-forget)
        if (result) {
          const _answerText = typeof result === 'string' ? result : (result?.text || '');
          if (_answerText.length > 10) {
            scoreAnswer({ sessionKey, taskId, userMessage: userMessage, answer: _answerText, model: routing?.fallbackModel })
              .catch(e => logger.warn('[R44-T3] quality scoring error: ' + e.message));
          }
        }
        if (_watchdogStepId) updateStep(msgId, _watchdogStepId, result ? "success" : "error", result ? "响应已到达" : "通道超时");
      }

      const wasThinkOnly = (typeof result === "object" && result !== null && result.thinkingReceived && (!result.text || result.text.trim().length === 0));
      let _responseMode = 'default'; // Iter-U: capture responseMode before flattening
      if (result && typeof result === 'object' && 'text' in result) {
        _gatewayUsage = result.gatewayUsage || null;
        _responseMode = result.responseMode || 'default'; // Iter-U
        result = result.text;
        if (_gatewayUsage) _gatewayUsageMap.set(msgId, _gatewayUsage);
      }

      // Knowledge leak sanitization
      if (typeof result === 'string') {
        result = result.replace(/\[SYSTEM\] 以下是知识库参考资料[\s\S]*?不要原样输出。(\n\n)?/g, '')
          .replace(/--- 参考资料开始 ---[\s\S]*?--- 参考资料结束 ---/g, '')
          .replace(/\[参考资料 \(\d+\/\d+\)\]/g, '')
          .split('--- 参考资料开始')[0].split('[参考资料 (')[0].trim();
      }

      if (!result || (typeof result === "string" && result.trim().length === 0) || wasThinkOnly) {
        consecutiveEmptyReplies++;
        if (routing?.fallbackModel && !routing.fallbackModel.includes('claude')) {
          routing.fallbackModel = 'openai/gpt-5.5'; routing.thinking = 'high'; // R82: was anthropic/claude-sonnet-4-6 (not in gateway config)
          try { await gateway.request('sessions.patch', { key: gatewaySessionKey, model: 'openai/gpt-5.5' }); } catch (_) {}
        }
        if (consecutiveEmptyReplies >= 2 && !sessionRebuilt) {
          sessionRebuilt = await rebuildSession(gateway, sessionKey);
          if (sessionRebuilt) { consecutiveEmptyReplies = 0; continue; }
        }
        if (attempt < MAX_RETRIES) {
          if (!gateway.isConnected) { const s = Date.now(); while (!gateway.isConnected && Date.now() - s < 30000) await new Promise(r => setTimeout(r, 1000)); }
          // Iter-AC: 有最近错误记录时，跳过 compact，改注入错误摘要块
          if (hasRecentErrors(conversationHistory)) {
            const errBlock = buildErrorSummaryBlock(conversationHistory);
            if (errBlock) {
              logger.info(`[${ts()}] [worker] [Iter-AC] Skip compact (recent errors); injecting error summary`);
              // 将错误摘要追加到当前消息末尾，让模型在下一轮看到
              if (typeof gatewayMessage === 'string') gatewayMessage = gatewayMessage + '\n\n' + errBlock;
            }
          } else {
            try { await gateway.compactSession(sessionKey); } catch (_) {}
          }
          continue;
        }
        lastError = new Error("Empty response from Gateway"); break;
      }

      // Success!
      consecutiveEmptyReplies = 0;
      if (gatewayBreaker) gatewayBreaker.recordSuccess();
      if (typeof result === "string") result = sanitizeForFrontend(result);

      emitEvent(sessionKey, taskId, EVENT_TYPES.ASSISTANT_MESSAGE, { content: typeof result === 'string' ? result : '', model: routing?.fallbackModel || 'unknown' }, routing?.fallbackModel);
      // R36-T1: Also emit FINAL_ANSWER for simple-path completions (fixes 17.5% completion rate metric)
      // [R43-T6] Quality scoring for simple path
      const _r43SimpleQuality = (() => {
        const _t = typeof result === "string" ? result : "";
        const _l = _t.length;
        let _c = 0;
        if (_l > 50) _c += 0.2;
        if (_l > 200) _c += 0.2;
        if (_l > 500) _c += 0.15;
        if (_l > 1000) _c += 0.1;
        if (/\n[-*]\s/.test(_t)) _c += 0.1;
        if (/\|.*\|/.test(_t)) _c += 0.1;
        if (/^#{1,3}\s/m.test(_t)) _c += 0.05;
        _c = Math.min(1, Math.round(_c * 100) / 100);
        // Simple path has lower base confidence (no tool usage)
        let _cf = 0.4;
        if (_l > 200) _cf += 0.1;
        if (_l > 500) _cf += 0.1;
        if (/https?:\/\//.test(_t)) _cf += 0.05;
        _cf = Math.min(1, Math.max(0, Math.round(_cf * 100) / 100));
        return { completeness: _c, confidence: _cf };
      })();
      emitEvent(sessionKey, taskId, EVENT_TYPES.FINAL_ANSWER, { content: typeof result === "string" ? result : "", model: routing?.fallbackModel || "unknown", path: "simple", completeness: _r43SimpleQuality.completeness, confidence: _r43SimpleQuality.confidence }, routing?.fallbackModel);
      try { await updateTaskState(taskId, { last_model: routing?.fallbackModel || 'unknown' }); } catch (_) {}
      writeMemoryAsync(msgId, userId, sessionKey, userMessage, result, conversationHistory, { hasToolOutput: false });
      if (_responseMode && _responseMode !== 'default') _responseModeMap.set(msgId, _responseMode); // Iter-U
// --- P0-FIX: Multi-Turn Agent Loop ---
      {
        const { getPlan: _alGetPlan } = await import("./plan-storage.mjs");
        const _alPlan = _alGetPlan(msgId);
        if (_alPlan && _alPlan.steps && _alPlan.steps.some(s => s.status === "pending")) {
          let _alTurnCount = 1;
          let _alLastResult = result;
          while (_alTurnCount < MAX_AUTO_TURNS) {
            const _alNextStep = shouldAutoContinue(msgId, _alTurnCount);
            if (_alNextStep === null || _alNextStep === undefined) break;
            logger.info("[" + new Date().toISOString() + "] [agent-loop-ctrl] Auto-continuing: turn " + (_alTurnCount + 1) + ", step " + _alNextStep.id);
            emitAutoContinue(msgId, _alNextStep, _alTurnCount + 1);
            const { markStepDoing: _alMarkDoing } = await import("./plan-storage.mjs");
            _alMarkDoing(msgId, _alNextStep.id);
            await new Promise(r => setTimeout(r, INTER_TURN_DELAY_MS));
            const _alContinueMsg = buildContinueMessage(_alNextStep, _alPlan);
            try {
              const _alResult = await handleViaOpenClaw(_alContinueMsg, sessionKey, msgId, {
                timeout: 600000, thinking: routing?.thinking || "high", roleSystemPrompt,
                needsStrongModel: false, routedModel: routing?.fallbackModel || null,
                userRole, conversationHistory, gatewayTotalTokens: ctxMgr?.getGatewayTokens?.() || 0,
                isAutoContinue: true,
              }, { gateway, browserBreaker });
              if (_alResult && typeof _alResult === "object" && "text" in _alResult) { _alLastResult = _alResult.text; }
              else if (typeof _alResult === "string") { _alLastResult = _alResult; }
              _alTurnCount++;
            } catch (_alErr) {
              logger.warn("[" + new Date().toISOString() + "] [agent-loop-ctrl] Auto-continue failed: " + _alErr.message);
              break;
            }
          }
          if (_alTurnCount > 1) {
            logger.info("[" + new Date().toISOString() + "] [agent-loop-ctrl] Agent loop completed: " + _alTurnCount + " total turns");
            result = _alLastResult || result;
          }
        }
      }
      // Iter-AB: 延迟 48h 清理任务工作区（简单对话通常不产生文件，有文件则留存供复查）
      setTimeout(() => { try { cleanupTaskWorkspace(taskId); } catch (_) {} }, 48 * 60 * 60 * 1000);
      return result;
    } catch (err) {
      lastError = err;
      logger.info(`[${ts()}] [worker] Gateway attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (/terminated|lifecycle.*error|session.*corrupt/i.test(err.message) && !sessionRebuilt) {
        sessionRebuilt = await rebuildSession(gateway, sessionKey);
      }
      if (attempt < MAX_RETRIES) {
        // [R66] Smart rate limit handling: retry on temporary 429, break on credit exhaustion
        if (/credit.*balance|balance.*too.*low/i.test(err.message)) {
          logger.info(`[${ts()}] [R66] Credit/balance exhausted — breaking retry loop`);
          break;
        }
        if (/rate.?limit|quota|429|FailoverError/i.test(err.message)) {
          logger.info(`[${ts()}] [R66] Rate limit hit (attempt ${attempt}/${MAX_RETRIES}) — waiting 5s before retry`);
          await new Promise(r => setTimeout(r, 5000));
          continue; // Retry instead of break
        }
        if (!gateway.isConnected) { const s = Date.now(); while (!gateway.isConnected && Date.now() - s < 30000) await new Promise(r => setTimeout(r, 1000)); }
        await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt - 1), 30000)));
      }
    }
  }

  // All retries exhausted
  if (gatewayBreaker) {
    if (/empty.*response/i.test(lastError?.message || "")) gatewayBreaker.recordSoftFailure();
    else gatewayBreaker.recordFailure();
  }
  try { if (gateway?.reconnect) await gateway.reconnect(); } catch (_) {}
  const errorMsg = lastError?.message || '未知错误';
  const isRateLimit = /rate.?limit|quota|429|FailoverError/i.test(errorMsg);
  const errorContent = isRateLimit
    ? `⚠️ **AI 模型暂时不可用**\nGateway 报告: ${errorMsg}\n\n**建议：** 请稍后重试（通常等待 1-2 分钟即可）`
    : `⚠️ **AI 引擎连接失败**\nGateway 错误: ${errorMsg}\n\n系统已尝试 ${MAX_RETRIES} 次重试均失败。`;
  sendEvent(msgId, { type: "message_done", content: errorContent, model: "RangerAI", provider: "rangerai" });
  sendEvent(msgId, { type: "error", code: isRateLimit ? "rate_limited" : "gateway_error", message: errorContent, recoverable: true });
  sendEvent(msgId, { type: "status", status: "idle" });
  return errorContent;
}
