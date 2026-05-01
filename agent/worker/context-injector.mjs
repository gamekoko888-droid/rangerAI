// context-injector.mjs — Context injection + message assembly (extracted from user-message-handler.mjs Iter-I)
// Responsibilities: Vision pipeline, Continuation detection, Knowledge injection,
//   Conversation recall, Memory recall, Circuit breaker, Context window management,
//   Context recovery, Progress tracking, Plan generation, Wide Research, Tool mask, Chat directive

import { sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { estimateTokens } from "./format-utils.mjs";
import { handleVisionMessage } from "./vision-handler.mjs";
import { buildKnowledgeInjectedMessage } from "./knowledge-injector.mjs";
import { generatePlan } from "./task-engine.mjs";
import { shouldTriggerWideResearch, executeWideResearch } from "./wide-research.mjs";
import { getContextManager, CONFIG as CONTEXT_WINDOW_CONFIG } from "./context-window-manager.mjs";
import { getConversationHistory, getChatBySessionKey } from "./db-proxy.mjs";
import { buildProgressBlock, hasProgress, shouldTrackProgress, setTrackerMsgId, restoreTrackerFromDB, PROGRESS_PREFIXES } from "./task-engine.mjs";
import { recallUnifiedMemory, recallShortTermContext } from "./memory-manager.mjs";
import { getTaskStateSnapshot } from "./task-engine.mjs";
import { startSpan } from "./observability.mjs";
import { segmentLongMessage } from "./segmenter.mjs";
import { logger } from "../lib/logger.mjs";
import { buildWorkspaceBlock } from "./task-workspace.mjs"; // Iter-AB
import { buildConstraintInjection } from "./tool-constraint-resolver.mjs"; // Iter-AA


// ═══ MODEL GOVERNANCE IRON LAW — Auto-injection (2026-04-26) ═══
import { readFileSync } from "fs";
import { resolve as pathResolve } from "path";

let _governanceCache = null;
let _governanceCacheTime = 0;
const GOVERNANCE_FILE = pathResolve("/opt/rangerai-agent/MODEL-GOVERNANCE.md");
const GOVERNANCE_CACHE_TTL = 5 * 60 * 1000; // 5 min cache

function loadGovernanceBlock() {
  const now = Date.now();
  if (_governanceCache && (now - _governanceCacheTime) < GOVERNANCE_CACHE_TTL) {
    return _governanceCache;
  }
  try {
    const raw = readFileSync(GOVERNANCE_FILE, "utf-8");
    // Generic H2 section parser — auto-discovers all ## 铁律* sections
    // Robust against: new/removed/reordered laws, no hardcoded anchor regexes
    const sections = [];
    sections.push("[MODEL_GOVERNANCE_IRON_LAW]");
    sections.push("以下是模型治理铁律，在执行任何代码修改任务前必须遵守：");
    sections.push("");
    const h2Sections = raw.split(/(?=^## )/m);
    for (const sec of h2Sections) {
      if (/^## 铁律/.test(sec)) {
        sections.push(sec.trim());
      }
    }
    sections.push("[/MODEL_GOVERNANCE_IRON_LAW]");
    _governanceCache = sections.join("\n\n");
    _governanceCacheTime = now;
    const lawCount = h2Sections.filter(s => /^## 铁律/.test(s)).length;
    logger.info(`[${ts()}] [ctx-inject] [GOVERNANCE] Loaded governance block (${_governanceCache.length} chars, ${lawCount} laws)`);
    return _governanceCache;
  } catch (err) {
    logger.warn(`[${ts()}] [ctx-inject] [GOVERNANCE] Failed to load MODEL-GOVERNANCE.md: ${err.message}`);
    // Fallback: hardcoded minimal governance
    return "[MODEL_GOVERNANCE_IRON_LAW]\nR70架构：GPT-5.5规划+验收，V4Pro执行所有文件（无红线限制）。关键步骤由GPT-5.5验收(reviewPolicy=gpt_review)。同一bug修2次未解决必须熔断交回GPT-5.5。\n[/MODEL_GOVERNANCE_IRON_LAW]";
  }
}
// ═══ END MODEL GOVERNANCE ═══
const ts = () => new Date().toISOString();

/**
 * Run the vision pipeline if image attachments are present.
 * @returns {{ handled: boolean, userMessage: string }}
 */
export async function runVisionPipeline(msgId, userMessage, attachments, conversationHistory, routing, opts = {}) {
  const hasImageAttachments = attachments && attachments.some(a => a.type === "image" && a.url);
  if (!hasImageAttachments) return { handled: false, userMessage };

  logger.info(`[${ts()}] [ctx-inject] Image attachments detected, running vision pipeline`);
  const vr = await handleVisionMessage(msgId, userMessage, attachments, conversationHistory, routing, opts);
  if (vr.handled) return { handled: true, userMessage: vr.content };
  return { handled: false, userMessage: vr.userMessage || userMessage };
}

/**
 * Detect HARD_LIMIT continuation and inject truncation context.
 */
export function detectContinuation(userMessage, conversationHistory) {
  const continuePatterns = /^(继续|接着|接着做|继续执行|接着执行|请继续|continue|resume|go on|keep going)[。.！!？?\s]*$/i;
  const trimmedMsg = userMessage.trim();
  if (!continuePatterns.test(trimmedMsg) || !conversationHistory || conversationHistory.length === 0) {
    return userMessage;
  }

  let lastAssistantMsg = null;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    if (conversationHistory[i].role === "assistant") {
      lastAssistantMsg = conversationHistory[i].content || "";
      break;
    }
  }

  const truncationMarkers = [
    "工具调用已达上限", "已完成的操作步骤", "未完成的任务阶段",
    "如需继续后续步骤", "回复可能被截断", "内容较长，回复已分段", "AI 引擎响应超时"
  ];

  if (lastAssistantMsg && truncationMarkers.some(m => lastAssistantMsg.includes(m))) {
    const truncationSection = lastAssistantMsg.substring(lastAssistantMsg.lastIndexOf("---"));
    const continuationContext = [
      "[SYSTEM: 用户要求继续上次被截断的任务。以下是上次截断时的状态摘要，请从中断处继续执行：]",
      truncationSection, "",
      "[请直接从上次中断的地方继续执行，不要重复已完成的步骤。如果有未完成的任务阶段，请按顺序继续。]"
    ].join("\n");
    logger.info(`[${ts()}] [ctx-inject] [v14.1] HARD_LIMIT continuation detected — injected ${continuationContext.length} chars`);
    return continuationContext + "\n\n" + userMessage;
  }
  return userMessage;
}

/**
 * Inject knowledge context, conversation recall, and unified memory.
 * @returns {string} gatewayMessage with all context layers
 */
export async function injectKnowledgeAndRecall(msgId, userMessage, userId, sessionKey, conversationHistory) {
  // Knowledge injection
  const kStepId = sendStep(msgId, "📚 背景相关性检索", "running", "正在调取行业知识库...");
  const _knSpan = startSpan(msgId, 'knowledge_inject');
  let gatewayMessage = await buildKnowledgeInjectedMessage(msgId, userMessage, userId, sessionKey);
  const _knInjected = gatewayMessage !== userMessage;
  _knSpan.end(_knInjected ? 'ok' : 'skip', { injected: _knInjected });
  updateStep(msgId, kStepId, "success", _knInjected ? "业务背景已加载" : "无需背景增强");

  // Conversation recall (TF-IDF)
  try {
    const _rcSpan = startSpan(msgId, 'conversation_recall');
    const recallContext = recallShortTermContext(userMessage, conversationHistory);

    // Unified long-term memory recall
    let unifiedMemoryBlock = '';
    try {
      unifiedMemoryBlock = await recallUnifiedMemory(userMessage, sessionKey, { userId });
      if (unifiedMemoryBlock) {
        logger.info(`[${ts()}] [ctx-inject] [memory-mgr] Unified memory recalled: ${unifiedMemoryBlock.length} chars`);
      }
    } catch (_memErr) { /* Non-fatal */ }

    if (recallContext) {
      gatewayMessage = gatewayMessage + recallContext;
      logger.info(`[${ts()}] [ctx-inject] [recall] 召回上下文片段已注入，长度: ${recallContext.length} chars`);
      _rcSpan.end('ok', { recalled: true, chars: recallContext.length });
    } else {
      _rcSpan.end('skip', { recalled: false });
    }
  } catch (recallErr) {
    logger.warn(`[${ts()}] [ctx-inject] [recall] 召回失败（不影响主流程）: ${recallErr.message}`);
  }

  return gatewayMessage;
}

/**
 * Check circuit breaker and handle Gateway degradation.
 * @returns {{ blocked: boolean, errorContent?: string }}
 */
export async function checkCircuitBreaker(msgId, sessionKey, gateway, gatewayBreaker) {
  if (!gatewayBreaker || gatewayBreaker.canRequest()) return { blocked: false };

  const cbStatus = gatewayBreaker.getStatus();

  // If Gateway is connected, breaker state is stale — reset
  if (gateway.isConnected) {
    logger.info(`[${ts()}] [ctx-inject] Circuit breaker OPEN but Gateway connected — force resetting`);
    gatewayBreaker.forceReset("gateway_connected_stale_breaker");
    sendEvent(msgId, { type: "thinking", content: "AI 引擎已恢复，正在处理...\n" });
    return { blocked: false };
  }

  const timeSinceLastFailure = cbStatus.lastFailureAge || 0;
  if (timeSinceLastFailure > 60000) {
    logger.info(`[${ts()}] [ctx-inject] Circuit breaker auto-recovery: ${timeSinceLastFailure}ms since last failure`);
    sendEvent(msgId, { type: "thinking", content: "正在尝试自动恢复 AI 引擎连接...\n" });
    // Try rebuild — import rebuildSession dynamically to avoid circular deps
    return { blocked: false }; // Let caller handle rebuild
  }

  const cbErrorMsg = `⚠️ **AI 引擎暂时不可用**\n\nGateway 连续失败 ${cbStatus.failureCount} 次，系统已自动熔断保护。\n\n请等待 30 秒后重试，或联系 Manus 检查 Gateway 状态。`;
  sendEvent(msgId, { type: "thinking", content: "⚠️ AI 引擎暂时不可用，请稍后重试...\n" });
  sendEvent(msgId, { type: "message_done", content: cbErrorMsg, model: "RangerAI", provider: "rangerai" });
  sendEvent(msgId, { type: "status", status: "idle" });
  return { blocked: true, errorContent: cbErrorMsg };
}

/**
 * Run pre-send context window health check and compression.
 */
export async function runContextWindowCheck(msgId, sessionKey, gateway) {
  const ctxMgr = getContextManager(sessionKey, msgId);
  const preSendCheck = ctxMgr.checkPreSendHealth();

  if (preSendCheck.needsCompression) {
    logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Pre-send: tier=${preSendCheck.tier}, action=${preSendCheck.action}, tokens≈${preSendCheck.estimatedTokens}`);
    // [R33-T3] Record before-compression token count for budget ratio tracking
    const _r33BeforeTokens = preSendCheck.estimatedTokens || 0;
    const _r33BudgetExceeded = preSendCheck.budgetExceeded || false;
    // [R65] Proactive reset: for critical/red tier, reset session instead of slow compaction
    // Reset is instant (~50ms), compaction takes 2+ minutes with large context
    if (preSendCheck.tier === 'critical' || preSendCheck.tier === 'red') {
      logger.info(`[${ts()}] [R65] Proactive session reset: tier=${preSendCheck.tier}, tokens≈${preSendCheck.estimatedTokens} — resetting instead of slow compact`);
      sendEvent(msgId, { type: "thinking", content: "正在重置对话上下文（快速模式）..." });
      try {
        await gateway.resetSession(sessionKey);
        ctxMgr.reset();
        logger.info(`[${ts()}] [R65] Session reset complete — context cleared, will recover from DB if needed`);
        return; // Skip the rest of the compression pipeline
      } catch (resetErr) {
        logger.warn(`[${ts()}] [R65] Session reset failed: ${resetErr.message}, falling back to compact`);
        // Fall through to compaction as fallback
      }
    }
    sendEvent(msgId, { type: "thinking", content: `正在优化对话上下文（${preSendCheck.tier === 'critical' ? '紧急' : '主动'}压缩）...` });
    try {
      const compactResult = await gateway.compactSession(sessionKey);
      logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Compact result: compacted=${compactResult?.compacted}, kept=${compactResult?.kept}`);
      ctxMgr.recordCompression(compactResult?.kept ? estimateTokens(String(compactResult.kept)) : undefined);
      // [R33-T3] Emit context_compress event with before/after token ratio
      if (_r33BudgetExceeded) {
        const _r33AfterTokens = compactResult?.kept ? estimateTokens(String(compactResult.kept)) : Math.round(_r33BeforeTokens * 0.4);
        const _r33Ratio = _r33BeforeTokens > 0 ? (_r33AfterTokens / _r33BeforeTokens).toFixed(3) : "N/A";
        try {
          const { emitEvent } = await import("./event-stream.mjs");
          emitEvent(sessionKey, msgId, "context_compress", {
            level: "token_budget_gate",
            trigger: `${CONTEXT_WINDOW_CONFIG.TOKEN_BUDGET_HARD_LIMIT / 1000}k_hard_limit`,
            beforeTokens: _r33BeforeTokens,
            afterTokens: _r33AfterTokens,
            ratio: parseFloat(_r33Ratio),
            budgetLimit: CONTEXT_WINDOW_CONFIG.TOKEN_BUDGET_HARD_LIMIT,
            compacted: compactResult?.compacted || false,
          });
          logger.info(`[${ts()}] [R33-T3] context_compress event: before=${_r33BeforeTokens} after=${_r33AfterTokens} ratio=${_r33Ratio}`);
        } catch (_evtErr) { /* non-fatal */ }
      }
      if (preSendCheck.tier === 'critical' && !compactResult?.compacted) {
        logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] CRITICAL: compact failed, attempting session reset...`);
        try { await gateway.resetSession(sessionKey); ctxMgr.reset(); } catch (resetErr) {
          logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Session reset failed: ${resetErr.message}`);
        }
      }
    } catch (compactErr) {
      logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Compact failed (non-fatal): ${compactErr.message}`);
    }
  }

  // Periodic Gateway sync
  if (ctxMgr.shouldCheckGatewayHealth()) {
    try {
      const sessionsList = await gateway.request("sessions.list", {});
      const currentSession = sessionsList?.sessions?.find(s => s.key === sessionKey);
      if (currentSession) {
        const { totalTokens, contextTokens } = currentSession;
        ctxMgr.syncFromGateway(totalTokens, contextTokens);
        const postSyncCheck = ctxMgr.checkPreSendHealth();
        if (postSyncCheck.needsCompression && !preSendCheck.needsCompression) {
          logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Post-sync compression needed`);
          sendEvent(msgId, { type: "thinking", content: "正在优化对话上下文..." });
          try { await gateway.compactSession(sessionKey); ctxMgr.recordCompression(); } catch (e) {
            logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Post-sync compact failed: ${e.message}`);
          }
        }
      }
    } catch (err) {
      logger.info(`[${ts()}] [ctx-inject] [ctx-mgr] Gateway health check failed: ${err.message}`);
    }
  }

  return ctxMgr;
}

/**
 * Recover context from DB when Gateway session has expired.
 * @returns {string|null} recovered context string or null
 */
export async function recoverExpiredContext(msgId, sessionKey, gatewaySessionKey, gateway, conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) return null;

  try {
    const sessionsList = await gateway.request("sessions.list", {});
    const currentSession = sessionsList?.sessions?.find(s => s.key === sessionKey || s.key === gatewaySessionKey);
    if (currentSession) {
      logger.info(`[${ts()}] [ctx-inject] [v21.1] Gateway session exists (tokens: ${currentSession.totalTokens || "unknown"})`);
      return null;
    }

    logger.info(`[${ts()}] [ctx-inject] [v21.1] Gateway session NOT FOUND (expired). Recovering...`);
    sendEvent(msgId, { type: "thinking", content: "正在恢复对话上下文...\n" });
    const recoveryStepId = sendStep(msgId, "🔄 上下文恢复", "running", "检测到会话过期，正在从数据库恢复...");

    const chat = await getChatBySessionKey(sessionKey);
    if (!chat) { updateStep(msgId, recoveryStepId, "success", "新会话"); return null; }

    const history = await getConversationHistory(chat.id, 20);
    if (!history || history.length === 0) { updateStep(msgId, recoveryStepId, "success", "无历史记录"); return null; }

    const contextParts = [];
    for (const m of history) {
      if (!m.content || m.content.trim().length === 0) continue;
      const role = m.role === "user" ? "User" : "Assistant";
      let entry = `[${role}]: ${m.content.length > 6000 ? m.content.substring(0, 6000) + "...(truncated)" : m.content}`;
      // Extract tool metadata
      if (m.role === "assistant" && m.metadata) {
        try {
          const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
          if (meta?.tools?.length > 0) {
            const toolSummary = [], filePaths = new Set(), urls = new Set();
            for (const t of meta.tools) {
              const toolName = t.tool || "unknown", status = t.status || "unknown";
              if (toolName === "write" && t.args?.path) filePaths.add(t.args.path);
              if (t.result?.text) {
                const rt = typeof t.result.text === "string" ? t.result.text : JSON.stringify(t.result.text);
                (rt.match(/https?:\/\/[^\s"'<>]+/g) || []).forEach(u => urls.add(u));
                (rt.match(/\/opt\/[^\s"'<>]+\.[a-zA-Z]+/g) || []).forEach(p => filePaths.add(p));
              }
              if (t.args?.command) (t.args.command.match(/\/opt\/[^\s"'<>]+\.[a-zA-Z]+/g) || []).forEach(p => filePaths.add(p));
              toolSummary.push(`${toolName}(${status})`);
            }
            entry += "\n[Tool Context]: " + toolSummary.join(", ");
            if (filePaths.size > 0) entry += "\n[Files Created/Modified]: " + [...filePaths].join(", ");
            if (urls.size > 0) entry += "\n[URLs]: " + [...urls].join(", ");
          }
        } catch (_err) { logger.warn("[ctx-inject] tool metadata parse (non-fatal):", _err?.message || _err); }
      }
      contextParts.push(entry);
    }

    if (contextParts.length > 0) {
      const contextSummary = `[SYSTEM_HIDDEN_CONTEXT_RECOVERY]\nThe previous Gateway session expired due to inactivity. Below is the conversation history including tool execution details.\n\n${contextParts.join("\n\n")}\n[/SYSTEM_HIDDEN_CONTEXT_RECOVERY]`;
      logger.info(`[${ts()}] [ctx-inject] [v21.3] Context recovery stored: ${contextParts.length} messages, ${contextSummary.length} chars`);
      updateStep(msgId, recoveryStepId, "success", `已恢复 ${contextParts.length} 条历史消息（含工具上下文）`);
      return contextSummary;
    }
    updateStep(msgId, recoveryStepId, "success", "无需恢复");
    return null;
  } catch (listErr) {
    logger.info(`[${ts()}] [ctx-inject] [v21.1] sessions.list failed (non-fatal): ${listErr.message}`);
    return null;
  }
}

/**
 * Assemble the final gateway message with all context layers:
 * progress tracking, task state, plan, wide research, tool mask, chat directive.
 */
export async function assembleGatewayMessage(gatewayMessage, userMessage, sessionKey, msgId, taskId, routing, intentResult, intentOverride, deps = {}) {
  if (!hasProgress(sessionKey)) {
    try { await restoreTrackerFromDB(sessionKey); } catch (_err) { logger.error("[ctx-inject] silent catch:", _err?.message || _err); }
  }
  setTrackerMsgId(sessionKey, msgId);

  if (hasProgress(sessionKey) && shouldTrackProgress(routing?.taskType)) {
    // [R67-P1-2] TASK_STATE moved to end of context (fixes KV-Cache prefix breakage).
    // Was prepended before GOVERNANCE → broke the stable prefix hash on every step change.
    // Now appended at tail (same position as PROGRESS) → preserves cache-friendly prefix.
    try {
      const stateSnapshot = await getTaskStateSnapshot(taskId);
      if (stateSnapshot) {
        gatewayMessage = gatewayMessage + '\n\n' + stateSnapshot;
        logger.info(`[${ts()}] [ctx-inject] [R67-P1-2] TASK_STATE appended at tail (${stateSnapshot.length} chars, KV-Cache friendly)`);
      }
    } catch (_tsErr) {
      logger.warn(`[${ts()}] [ctx-inject] [task-state] Snapshot injection failed: ${_tsErr.message}`);
    }
  }

  // [R59-P0-1] Store metadata for tail injection — build progress block now, append at return

  // ═══ MODEL GOVERNANCE IRON LAW INJECTION ═══
  // Inject governance rules for non-chat tasks (code, research, reasoning)
  if (deps.routeResult?.category !== "chat") {
    try {
      const govBlock = loadGovernanceBlock();
      if (govBlock) {
        gatewayMessage = govBlock + "\n\n" + gatewayMessage;
        logger.info(`[${ts()}] [ctx-inject] [GOVERNANCE] Iron Law injected into context (${govBlock.length} chars, category=${deps.routeResult?.category || "unknown"})`);
      }
    } catch (_govErr) {
      logger.warn(`[${ts()}] [ctx-inject] [GOVERNANCE] Injection failed (non-fatal): ${_govErr.message}`);
    }
  }
  // ═══ END GOVERNANCE INJECTION ═══
  const { question: cleanQuestion } = segmentLongMessage(userMessage);

  if (intentOverride?.skipPlan || (deps.routeResult?.category === "chat")) {
    logger.info(`[${ts()}] [ctx-inject] [R60] Skipping plan generation`);
  } else {
    try {
      const planBlock = await Promise.race([
        generatePlan(sessionKey, cleanQuestion, routing),
        new Promise(resolve => setTimeout(() => resolve(null), 3000))
      ]);
      if (planBlock) {
        gatewayMessage = gatewayMessage + "\n\n" + planBlock;
        logger.info(`[${ts()}] [ctx-inject] [v27.0] Active plan injected (${planBlock.length} chars)`);
        // [R3-Task1] Bridge task-engine plan into planner _planCache for stepId binding
        try {
          const planSteps = parsePlanBlockToSteps(planBlock);
          if (planSteps.length > 0) {
            // [R27-T2] Generate planText (Manus-style numbered steps) for LLM context injection
            const _syntheticPlanText = planSteps
              .map((s, i) => `${i + 1}. ${s.title || s.description || 'Step ' + (i + 1)}`)
              .join('\n');
            const syntheticPlan = {
              goal: cleanQuestion.substring(0, 120),
              steps: planSteps,
              currentStepId: planSteps[0].id,
              doneCriteria: [],
              notes: [],
              needsReplan: false,
              version: 1,
              planText: _syntheticPlanText,  // [R27-T2] planText for LLM context tail injection
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            // Register with BOTH msgId and taskId so both openclaw-handler and executor can find it
            if (typeof registerExternalPlan === 'function') {
              registerExternalPlan(msgId, syntheticPlan);
              if (taskId && taskId !== msgId) {
                registerExternalPlan(taskId, syntheticPlan);
              }
              logger.info(`[${ts()}] [ctx-inject] [R3] Plan bridged to planner cache: ${planSteps.length} steps, keys=[${msgId}${taskId && taskId !== msgId ? ', ' + taskId : ''}]`);
              // [R27-T1] Sync todo-tracker from plan (context-injector path)
              try {
                todoSyncFromPlan(msgId, syntheticPlan);
                todoMarkInProgress(msgId, syntheticPlan.currentStepId);
                todoEmitTodoEvent(msgId, (type, payload) => {
                  const _es = deps?.sendEvent || sendEvent;
                  if (typeof _es === 'function') _es({ type, ...payload });
                }, sessionKey);
                logger.info(`[${ts()}] [R27-T1] Todo synced from ctx-inject plan: ${planSteps.length} steps, current=${syntheticPlan.currentStepId}`);
              } catch (_todoErr) {
                logger.warn(`[${ts()}] [R27-T1] todo sync failed (non-fatal): ${_todoErr.message}`);
              }
            }
          }
        } catch (_bridgeErr) {
          logger.warn(`[${ts()}] [ctx-inject] [R3] Plan bridge failed (non-fatal): ${_bridgeErr.message}`);
        }
        // [R2-Task3] Create executor instance after plan generation
        try {
          // R8 Task 1: Always use msgId as taskId to prevent dual seq counters
          _activeExecutor = createExecutor(msgId, sessionKey, msgId, {
            sendEvent: deps.sendEvent || sendEvent,
          });
          logger.info(`[${ts()}] [R8-executor] Created for task ${msgId} via context-injector plan path (originalTaskId=${taskId})`);
          // [R2-Task3] Execute first step as observer (non-blocking NOTIFY action)
          try {
            const initAction = buildNotifyAction(
              `Plan generated with ${planBlock.length} chars for task ${taskId || msgId}`,
              'plan_generated'
            );
            initAction.stepId = 'step-0-init';
            const initResult = await _activeExecutor.executeAction(initAction);
            logger.info(`[${ts()}] [executor] Step 0 init completed: success=${initResult.success}`);
          } catch (_stepErr) {
            logger.warn(`[${ts()}] [executor] Step 0 init failed (non-blocking): ${_stepErr.message}`);
          }
        } catch (_exErr) {
          logger.warn(`[${ts()}] [executor] Creation failed in ctx-inject (non-fatal): ${_exErr.message}`);
        }
      }
    } catch (planErr) {
      logger.warn(`[${ts()}] [ctx-inject] [v27.0] Plan generation failed: ${planErr.message}`);
    }
  }

  try {
    if (!intentOverride?.skipWideResearch && shouldTriggerWideResearch(cleanQuestion, routing)) {
      const _wrResult = await executeWideResearch(cleanQuestion, sessionKey);
      const researchContext = _wrResult?.contextBlock || _wrResult; // backward compat
      if (researchContext && typeof researchContext === 'string') {
        gatewayMessage = gatewayMessage + researchContext;
        logger.info(`[${ts()}] [ctx-inject] [R59] Wide Research context injected (${researchContext.length} chars)`);
      } else if (researchContext && researchContext.contextBlock) {
        gatewayMessage = gatewayMessage + researchContext.contextBlock;
      }
      // [R42-T3] Emit research_completed with actual sourceCount
      try {
        const { emitEvent: _emitRC } = await import('./event-stream.mjs');
        const _sc = typeof _wrResult === 'object' ? (_wrResult.sourceCount || 0) : 0;
        const _reportLen = typeof researchContext === 'string' ? researchContext.length : 0;
        _emitRC(sessionKey, taskId, 'research_completed', {
          sourceCount: _sc,
          engines: typeof _wrResult === 'object' ? (_wrResult.engines || 'unknown') : 'unknown',
          successCount: typeof _wrResult === 'object' ? (_wrResult.successCount || 0) : 0,
          subQueryCount: typeof _wrResult === 'object' ? (_wrResult.subQueryCount || 0) : 0,
          reportLength: _reportLen,
          avgConfidence: _sc > 0 ? 0.7 : 0
        });
        logger.info(`[${ts()}] [ctx-inject] [R42-T3] research_completed emitted: sourceCount=${_sc}`);
      } catch (_rcErr) {
        logger.warn(`[${ts()}] [ctx-inject] [R42-T3] research_completed emit failed: ${_rcErr.message}`);
      }
    }
  } catch (researchErr) {
    logger.warn(`[${ts()}] [ctx-inject] [R59] Wide Research failed: ${researchErr.message}`);
  }

  // Iter-AB: 注入任务工作区文件列表（如有外化文件）
  try {
    if (taskId) {
      const wsBlock = buildWorkspaceBlock(taskId);
      if (wsBlock) {
        gatewayMessage = gatewayMessage + '\n\n' + wsBlock;
        logger.info(`[${ts()}] [ctx-inject] [Iter-AB] Workspace block injected for taskId=${taskId}`);
      }
    }
  } catch (_err) { logger.error("[ctx-inject] silent catch (workspace):", _err?.message || _err); }

  try {
    const { parsePlanFromText } = await import("./task-engine.mjs");
    const parsedPlan = parsePlanFromText(gatewayMessage);
    if (parsedPlan?.phases?.length > 0) {
      const currentPhase = parsedPlan.phases.find(p => p.status === 'pending' || p.status === 'running') || parsedPlan.phases[0];
      const tools = currentPhase.allowedTools || ['all'];
      if (!tools.includes('all')) {
        // Iter-AA: 升级为结构化 XML 约束块（替代原 [TOOL_MASK] 纯文本软约束）
        const constraintBlock = buildConstraintInjection(currentPhase);
        if (constraintBlock) {
          gatewayMessage = gatewayMessage + constraintBlock;
          logger.info(`[${ts()}] [ctx-inject] [Iter-AA] [CONSTRAINT] Phase ${currentPhase.id}: "${currentPhase.title}" -> tools: [${tools.join(', ')}]`);
        }
      }
    }
  } catch (_err) { logger.error("[ctx-inject] silent catch (plan/constraint):", _err?.message || _err); }

  // R60-FIX-v2: Chat directive
  if (intentOverride?.overrideType === 'chat' && intentResult?.confidence >= 0.7) {
    const chatDirective = '\n\n[SYSTEM_DIRECTIVE]\n这是一个简单的对话/问答请求。请直接用文字回答，不需要使用任何工具。\n除非用户明确要求执行操作，否则直接回答即可。\n[/SYSTEM_DIRECTIVE]';
    gatewayMessage = chatDirective + '\n\n' + gatewayMessage;
    logger.info(`[${ts()}] [ctx-inject] [R60-v2] Chat directive injected (confidence: ${intentResult.confidence})`);
  }

  // [R59-P0-1] Inject progress block at tail of system context (last position before user message).
  // This prevents "lost-in-the-middle": LLM sees progress among the most recent context.
  // Uses time-modulo prefix rotation (Iter-AE) to prevent Few-Shot pattern lock-in.
  if (hasProgress(sessionKey) && shouldTrackProgress(routing?.taskType)) {
    const prefixIdx = Math.floor(Date.now() / (5 * 60 * 1000)) % PROGRESS_PREFIXES.length;
    const progressPrefix = PROGRESS_PREFIXES[prefixIdx];
    const progressBlock = buildProgressBlock(sessionKey, { prefix: progressPrefix });
    if (progressBlock) {
      gatewayMessage = gatewayMessage + progressBlock;
      const _totalLen = gatewayMessage.length;
      logger.info(`[${ts()}] [ctx-inject] [R59-P0-1] Progress block injected at tail (prefix="${progressPrefix}", ${progressBlock.length} chars, total=${_totalLen} chars)`);
    }
  }

  return gatewayMessage;
}

// ═══════════════════════════════════════════════════════════════════════
// ─── Phase 2: Event-Stream-Driven Context Assembly (v2.0) ───
// ═══════════════════════════════════════════════════════════════════════

import { getStateSnapshotForContext, summarizeEvents, EVENT_TYPES } from './event-stream.mjs';
import { getPlan as getCurrentPlan, renderPlanForContext as formatPlanForInjection, registerExternalPlan } from './planner.mjs';
import { createExecutor, buildNotifyAction } from './executor.mjs';
// [R27-T1/T3] Import todo-tracker for context-injector plan path
import { syncFromPlan as todoSyncFromPlan, markInProgress as todoMarkInProgress, emitTodoEvent as todoEmitTodoEvent, getSnapshot as todoGetSnapshot } from './todo-tracker.mjs';

// [R2-Task3] Module-level executor reference for current task
let _activeExecutor = null;
export function getActiveExecutor() { return _activeExecutor; }
export function clearActiveExecutor() { _activeExecutor = null; }

/**
 * Assemble context from event stream instead of string concatenation.
 * This is the NEW primary context assembly path.
 * 
 * Layers (in injection order):
 *   1. Task state snapshot (from event-stream rebuild)
 *   2. Active plan (from planner.mjs)
 *   3. Recent event summary (from event-stream)
 *   4. Knowledge + memory (from existing injectKnowledgeAndRecall)
 *   5. User message
 *   6. Chat directive (if applicable)
 * 
 * @param {string} sessionKey
 * @param {string} taskId
 * @param {string} userMessage - Already processed by knowledge/recall injection
 * @param {Object} options
 * @returns {Promise<string>} Assembled context for Gateway
 */
export async function assembleFromEventStream(sessionKey, taskId, userMessage, options = {}) {
  const { routing, intentResult, intentOverride, deps = {} } = options;
  const parts = [];

  // ── Layer 0: MODEL GOVERNANCE IRON LAW ──
  if (deps.routeResult?.category !== "chat") {
    try {
      const govBlock = loadGovernanceBlock();
      if (govBlock) {
        parts.push(govBlock);
        logger.info(`[${ts()}] [ctx-inject-v2] [GOVERNANCE] Iron Law injected (${govBlock.length} chars)`);
      }
    } catch (_govErr) {
      logger.warn(`[${ts()}] [ctx-inject-v2] [GOVERNANCE] Injection failed: ${_govErr.message}`);
    }
  }
  // ── Layer 1: Task State Snapshot ──
  try {
    if (taskId) {
      const stateSnapshot = await getStateSnapshotForContext(taskId, sessionKey);
      if (stateSnapshot) {
        parts.push(stateSnapshot);
        logger.info(`[${ts()}] [ctx-inject-v2] Task state injected (${stateSnapshot.length} chars)`);
      }
    }
  } catch (err) {
    logger.warn(`[${ts()}] [ctx-inject-v2] Task state injection failed: ${err.message}`);
  }

  // ── Layer 2: Active Plan ──
  try {
    if (!intentOverride?.skipPlan && deps.routeResult?.category !== 'chat') {
      const plan = getCurrentPlan(sessionKey);
      if (plan) {
        const planBlock = formatPlanForInjection(plan);
        if (planBlock) {
          parts.push(planBlock);
          logger.info(`[${ts()}] [ctx-inject-v2] Plan v${plan.version} injected (${planBlock.length} chars)`);
        }
      }
    }
  } catch (err) {
    logger.warn(`[${ts()}] [ctx-inject-v2] Plan injection failed: ${err.message}`);
  }

  // ── Layer 3: Recent Event Summary ──
  try {
    const eventSummary = await summarizeEvents(sessionKey, 20);
    if (eventSummary && eventSummary.length > 50) {
      parts.push(`[RECENT_CONTEXT]\n${eventSummary}\n[/RECENT_CONTEXT]`);
      logger.info(`[${ts()}] [ctx-inject-v2] Event summary injected (${eventSummary.length} chars)`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [ctx-inject-v2] Event summary failed: ${err.message}`);
  }

  // ── Layer 4: Workspace block ──
  try {
    if (taskId) {
      const wsBlock = buildWorkspaceBlock(taskId);
      if (wsBlock) {
        parts.push(wsBlock);
        logger.info(`[${ts()}] [ctx-inject-v2] Workspace block injected`);
      }
    }
  } catch (_err) { logger.error("[ctx-inject] silent catch (workspace v2):", _err?.message || _err); }

  // ── Layer 5: Chat Directive ──
  if (intentOverride?.overrideType === 'chat' && intentResult?.confidence >= 0.7) {
    parts.unshift('[SYSTEM_DIRECTIVE]\n这是一个简单的对话/问答请求。请直接用文字回答，不需要使用任何工具。\n除非用户明确要求执行操作，否则直接回答即可。\n[/SYSTEM_DIRECTIVE]');
    logger.info(`[${ts()}] [ctx-inject-v2] Chat directive injected`);
  }

  // ── Layer 6: User Message (always last) ──
  parts.push(userMessage);

  const assembled = parts.join('\n\n');
  logger.info(`[${ts()}] [ctx-inject-v2] Assembled context: ${parts.length} layers, ${assembled.length} chars total`);
  return assembled;
}

/**
 * Build a structured context block from recent events.
 * Used by executor.mjs to provide observation context to the LLM.
 * 
 * @param {string} sessionKey
 * @param {number} maxEvents
 * @returns {Promise<string|null>}
 */
export async function buildEventContext(sessionKey, maxEvents = 15) {
  try {
    const summary = await summarizeEvents(sessionKey, maxEvents);
    if (!summary || summary.length < 20) return null;
    return `[EVENT_HISTORY]\n${summary}\n[/EVENT_HISTORY]`;
  } catch (err) {
    logger.warn(`[${ts()}] [ctx-inject-v2] buildEventContext failed: ${err.message}`);
    return null;
  }
}

// ─── [R3-Task1] Parse task-engine plan text into planner-compatible steps ───
/**
 * Parse a [PLAN]...[/PLAN] text block into an array of step objects
 * compatible with planner.mjs _planCache format.
 * 
 * task-engine plans look like:
 *   [PLAN]
 *   目标: ...
 *   1. 检查服务状态
 *   2. 查看错误日志
 *   3. 报告资源使用率
 *   [/PLAN]
 */
function parsePlanBlockToSteps(planBlock) {
  const steps = [];
  try {
    // Extract content between [PLAN] and [/PLAN]
    const match = planBlock.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/);
    if (!match) return steps;
    const content = match[1];
    // Match numbered lines: "1. ...", "2. ...", etc.
    const linePattern = /^\s*(\d+)\.\s+(.+)/gm;
    let m;
    while ((m = linePattern.exec(content)) !== null) {
      const stepNum = m[1];
      const title = m[2].trim();
      // Skip the goal line if it starts with "目标:"
      if (title.startsWith('目标:') || title.startsWith('目标：')) continue;
      steps.push({
        id: `step-${stepNum}`,
        title: title.substring(0, 200),
        status: steps.length === 0 ? 'doing' : 'pending',
        tools: [],
      });
    }
    // If no numbered steps found, try bullet points
    if (steps.length === 0) {
      const bulletPattern = /^\s*[-•]\s+(.+)/gm;
      let idx = 1;
      while ((m = bulletPattern.exec(content)) !== null) {
        const title = m[1].trim();
        if (title.startsWith('目标:') || title.startsWith('目标：')) continue;
        steps.push({
          id: `step-${idx}`,
          title: title.substring(0, 200),
          status: idx === 1 ? 'doing' : 'pending',
          tools: [],
        });
        idx++;
      }
    }
  } catch (err) {
    logger.warn(`[${ts()}] [ctx-inject] [R3] parsePlanBlockToSteps error: ${err.message}`);
  }
  return steps;
}
