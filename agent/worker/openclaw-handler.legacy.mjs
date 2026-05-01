// ─── OpenClaw Handler: Orchestration Layer ───
// Delegates to:
//   - tool-tracker.mjs: Tool lifecycle, anti-loop, media detection
//   - stream-processor.mjs: Text cleaning, truncation detection, media append
//   - self-healer.mjs: Tool summary, truncation continuation, session rebuild
//
// This file retains the same external API: handleViaOpenClaw(userMessage, sessionKey, msgId, options, deps)
// Returns: Promise<string> (the AI response text)

import { sendStep, updateStep, sendEvent, sendNotify } from "./ipc-utils.mjs";
import { emitEvent, emitLedgerEvent, EVENT_TYPES, rebuildTaskStateFromEvents } from "./event-stream.mjs";
import {
  sanitizeForFrontend, estimateTokens, rewriteWorkspacePaths, parseResponseMode
} from "./format-utils.mjs";
import { createToolTracker } from "./tool-tracker.mjs";
import { diagnoseFailure, FAILURE_TYPE } from "./failure-recovery.mjs"; // [Iter-66] failure classification
import {
  detectTruncation, cleanHeartbeat, extractFinalText, appendMediaToText, createStreamFilter, cleanFinalText
} from "./stream-processor.mjs";
import {
  requestToolSummary, continueTruncation
} from "./self-healer.mjs";
import { setCurrentRunId } from "./run-tracker.mjs";
import { updateTraceModel } from "./observability.mjs"; // P0-FIX: Track actual model in trace
import { processTextForPlan, cleanupPlan, getSerializablePlan } from "./task-engine.mjs";
import { markStepDone as progressMarkStepDone, markStepRunning as progressMarkStepRunning, initTrackerFromPlan, buildProgressBlock, shouldTrackProgress, cleanupTracker, hasProgress, recordStepEvidence } from "./task-engine.mjs"; // [R71-P0-3] recordStepEvidence
import { TTLMap } from './lib/ttl-map.mjs'; // [R95] TTL-based memory-safe Map
import { injectMessage } from "./gateway-connector.mjs"; // [R106] Gateway mid-execution intervention

// [STEP-GATE] Track tool count per step to prevent cascade completion
const _stepToolTracker = new TTLMap(500, 30 * 60 * 1000, 5 * 60 * 1000);
const STEP_MIN_TOOLS = 3;
const STEP_MIN_TIME_MS = 10000;

async function recoverStepToolTracker(taskId, sessionKey, plan = null, source = 'unknown') {
  try {
    const rebuilt = await rebuildTaskStateFromEvents(taskId, sessionKey);
    const tracker = rebuilt?.stepTracker || null;
    const currentStepId = plan?.currentStepId || rebuilt?.currentStepId || tracker?.stepId || null;
    // [R71-P0-4] Recover evidence store from event stream
    if (rebuilt?.evidenceStore) {
      for (const [stepId, evidence] of Object.entries(rebuilt.evidenceStore)) {
        if (Array.isArray(evidence)) {
          for (const ev of evidence) {
            try { recordStepEvidence(sessionKey || taskId, stepId, ev); } catch(_) {}
          }
        }
      }
      logger.info(`[${new Date().toISOString()}] [R71-P0-4] evidence_recovered task=${taskId} steps=${Object.keys(rebuilt.evidenceStore).length}`);
    }
    if (!currentStepId) return null;
    const sameStep = tracker && String(tracker.stepId) === String(currentStepId);
    const restored = {
      stepId: String(currentStepId),
      count: sameStep ? Number(tracker?.count ?? tracker?.toolCount ?? 0) : 0,
      toolCount: sameStep ? Number(tracker?.toolCount ?? tracker?.count ?? 0) : 0,
      startedAt: sameStep ? (Number(tracker?.startedAt) || Date.now()) : Date.now(),
      elapsedMs: sameStep ? (Number(tracker?.elapsedMs) || 0) : 0,
      lastTool: sameStep ? (tracker?.lastTool || null) : null,
    };
    _stepToolTracker.set(taskId, restored);
    logger.info(`[${new Date().toISOString()}] [R70-P0-2] step_tracker_recovered task=${taskId} step=${restored.stepId} tools=${restored.toolCount} elapsed=${restored.elapsedMs}ms source=${source}`);
    return restored;
  } catch (err) {
    logger.warn(`[${new Date().toISOString()}] [R70-P0-2] step_tracker_recovery_failed task=${taskId}: ${err.message}`);
    return null;
  }
}
import { recordPlanInjection, recordActionFollowance, recordNoPlanAction, getRecoveredPlans, consumeRecoveredPlan, reviewStepResult } from "./planner.mjs"; // [R12-T2] [R70]
import { recordCompression } from "./observability.mjs"; // [R13-T3]
import { addAnchor, detectAnchorCandidate, getAnchors, saveContextCheckpoint } from "./context-buffer.mjs"; // [R13-T3] + [R14-T1] + [R106]
import { getChatBySessionKey, getConversationHistory } from "./db-proxy.mjs"; // [R106]
import { extractAssistantReplyFromJsonl } from "./jsonl-fallback.mjs";
import { createToolOrchestrator } from "./tool-orchestrator.mjs";
import { getContextManager, getUsageRatio, budgetToolResults } from "./context-window-manager.mjs";
import { bindTaskSession, getBoundSessionKey, initStreamState, markStreamEvent, canFinalize, finalizeOnce, nextEventSeq, scheduleTaskCleanup, _execTimers, _lastProgressHash } from "./task-session-manager.mjs"; // R68: Extracted task session management
import { microCompact, autoCompact } from "./context-compressor.mjs";
import { compactSubAgentResult, microCompact as microCompactSubAgent } from "./sub-agent-compactor.mjs"; // Iter-D / Iter-X
import { MICRO_COMPACT_THRESHOLD, AUTO_COMPACT_THRESHOLD, MICRO_COMPACT_MSG_THRESHOLD, AUTO_COMPACT_MSG_THRESHOLD } from "./agent-config.mjs";
import { appendToolError } from "./error-context-manager.mjs"; // Iter-AC
import { recordToolExperience, extractAndStoreFact, recordTaskPattern, getAdaptiveMemoryStats, cleanupExpired, getToolSubType } from "./adaptive-memory.mjs";
import { gateToolExecution, handleApprovalResponse } from "./human-approval.mjs";
import { shouldAutoVerify, buildAutoVerifyMessage, recordVerification } from "../visual-verifier.mjs";
import { trackPrefix } from "./kv-cache-monitor.mjs"; // Iter-R: KV-Cache 前缀稳定性监控
import { supervisorEvaluate, supervisorReview, getActiveTaskFocus, formatTaskFocusForContext } from './supervisor-agent.mjs'; // [R15-T3]
import { syncFromPlan, markInProgress, markDone, markFailed, getSnapshot, emitTodoEvent, hasTodo } from './todo-tracker.mjs'; // [R26-T3] Attention mechanism
import { smartRouteByPhase } from './smart-router.mjs'; // [方案A] taskPhase step-level routing
import { shouldUseStructuredExecution, buildStepExecutionDirective, evaluateStepCompletionGate } from './r69-execution-discipline.mjs'; // R69: structured step execution discipline

// ─── Extracted module imports ───
// ─── R54: Plan A/B hourly summary counters ───
const planABStats = { planA: 0, planB: 0, failed: 0, lastReset: Date.now() };
const PLAN_AB_SUMMARY_INTERVAL = 3600000; // 1 hour
let _planAbSummaryTimer = setInterval(() => {
  const elapsed = Math.round((Date.now() - planABStats.lastReset) / 60000);
  if (planABStats.planA + planABStats.planB + planABStats.failed > 0) {
    logger.info(`[${new Date().toISOString()}] [worker] [PlanAB Summary] ${elapsed}min: Plan A success=${planABStats.planA}, Plan B fallback=${planABStats.planB}, failed=${planABStats.failed}`);
  }
  planABStats.planA = 0;
  planABStats.planB = 0;
  planABStats.failed = 0;
  planABStats.lastReset = Date.now();
}, PLAN_AB_SUMMARY_INTERVAL);
if (typeof _planAbSummaryTimer.unref === 'function') _planAbSummaryTimer.unref();

export function cleanupOpenClawHandlerResources() {
  if (_planAbSummaryTimer) {
    clearInterval(_planAbSummaryTimer);
    _planAbSummaryTimer = null;
  }
  _stepToolTracker.dispose();
}

import {
  DEFAULT_TIMEOUT_MS, TOOL_TIMEOUT_MS, SINGLE_TOOL_MAX_MS, SINGLE_TOOL_HARD_MS,
  CONSECUTIVE_TOOL_NO_TEXT_THRESHOLD, CONSECUTIVE_TOOL_NO_TEXT_HARD_LIMIT,
  TOOL_COUNT_WARN, TOOL_COUNT_CRITICAL, TOOL_COUNT_HARD_LIMIT,
  MIN_API_INTERVAL_MS
} from "./agent-config.mjs";
import { generateToolDescription } from "./tool-description.mjs";
import { extractGatewayUsage } from "./usage-tracker.mjs";
import { saveLongOutputAsFile, handleLongOutput } from "./output-manager.mjs";
import { compressObservation } from "./observation-compressor.mjs"; // [R50-T2] 工具结果智能压缩
import { logger } from '../lib/logger.mjs';

// ─── Agent Loop Architecture v1.0: New Module Imports ───
let _agentLoopModules = null;
try {
  const [_esm, _plm, _exm] = await Promise.all([
    import("./event-stream.mjs"),
    import("./planner.mjs"),
    import("./executor.mjs"),
  ]);
  _agentLoopModules = { es: _esm, pl: _plm, ex: _exm };
  logger.info("[agent-loop] Modules loaded successfully");
  // [R9-Task3] Trigger crash recovery on module load (runs once)
  try {
    const recoveredCount = await _plm.recoverActivePlans();
    if (recoveredCount > 0) {
      logger.info(`[R9-recovery] ${recoveredCount} active plans recovered from DB on startup`);
    } else {
      logger.info(`[R9-recovery] No active plans to recover on startup`);
    }
    try {
      const _recoveredPlans = getRecoveredPlans();
      for (const [_taskId, _meta] of _recoveredPlans.entries()) {
        try {
          if (_meta?.plan && !hasTodo(_taskId)) {
            syncFromPlan(_taskId, _meta.plan);
            if (_meta.plan.currentStepId) markInProgress(_taskId, _meta.plan.currentStepId);
            logger.info(`[R56-todo-recovery] synced recovered todo for task=${_taskId}, steps=${_meta.plan.steps?.length || 0}`);
          }
          await recoverStepToolTracker(_taskId, _meta?.sessionKey || _taskId, _meta?.plan || null, 'startup');
          consumeRecoveredPlan(_taskId);
        } catch (_todoRecErr) {
          logger.warn(`[R56-todo-recovery] failed for task=${_taskId}: ${_todoRecErr.message}`);
        }
      }
    } catch (_todoRecoverErr) {
      logger.warn(`[R56-todo-recovery] startup sync failed (non-fatal): ${_todoRecoverErr.message}`);
    }
  } catch (_recErr) {
    logger.warn(`[R9-recovery] Startup recovery failed (non-fatal): ${_recErr.message}`);
  }
} catch (_alErr) {
  logger.warn(`[agent-loop] Module load failed (non-fatal): ${_alErr.message}`);
}
import { getActiveExecutor, clearActiveExecutor } from "./context-injector.mjs";
import { handleFinishSuccess, handleFinishError } from "./gateway-event-handler.mjs"; // Iter-I: Extracted finish handlers

// ─── Iter-I Architecture Note ───
// This file is the thin orchestration layer for Gateway communication.
// Event handling logic (finishSuccess, finishError) is also available in gateway-event-handler.mjs
// for future full extraction when closure dependencies are resolved.
// Current structure: ~300 lines orchestration + ~960 lines event handling (in-file)
// Target: Move event handling to gateway-event-handler.mjs once ctx object pattern is validated
// ─── Task session management extracted to task-session-manager.mjs (R68) ───
const EXEC_TIMEOUT_MS = 10000;   // 10 second CPU timeout

// ─── R106: Context bridge before Gateway reset ──────────────────────────────
const R106_HISTORY_LIMIT = 160;
const R106_RECENT_KEEP = 8;

function normalizeR106Message(msg) {
  const content = msg?.content ?? msg?.message ?? msg?.text ?? "";
  if (!content || typeof content !== "string") return null;
  return {
    role: msg.role || msg.senderRole || msg.sender_role || "user",
    content,
    toolName: msg.toolName || msg.name || "",
  };
}

async function loadR106History(sessionKey) {
  const keys = [
    sessionKey,
    sessionKey?.replace(/^agent:main:/, ""),
    sessionKey?.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`,
  ].filter(Boolean);

  for (const key of keys) {
    try {
      const chat = await getChatBySessionKey(key);
      if (!chat?.id) continue;
      const rows = await getConversationHistory(chat.id, R106_HISTORY_LIMIT);
      return (rows || []).map(normalizeR106Message).filter(Boolean);
    } catch (err) {
      logger.warn(`[R106] load history failed for ${key}: ${err.message}`);
    }
  }
  return [];
}

function seedR106Anchors(sessionKey, messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const candidate = detectAnchorCandidate(msg, {
      isFirstMessage: i === 0 && msg.role === "user",
      hasToolOutput: msg.role === "tool" || msg.role === "function",
    });
    if (candidate?.shouldAnchor) {
      addAnchor(sessionKey, msg.content, candidate.reason, candidate.priority);
    }

    const hasArtifact = /(?:\/opt\/rangerai-agent|\/opt\/rangerai-web|https?:\/\/|[\w.-]+\.(?:mjs|ts|tsx|js|json|sql|md))/i.test(msg.content);
    if (hasArtifact) {
      addAnchor(sessionKey, msg.content, "artifact_or_path", 8);
    }
  }
}

async function buildR106ContextBridge({ sessionKey, msgId, userMessage, trigger }) {
  const history = await loadR106History(sessionKey);
  if (history.length === 0) return "";

  seedR106Anchors(sessionKey, history);

  const compact = await autoCompact(history, sessionKey, msgId, {
    trigger: trigger || "gateway_reset",
    usageRatio: null,
  });

  const anchors = getAnchors(sessionKey) || [];
  const recent = history.slice(-R106_RECENT_KEEP);

  let planBlock = "";
  try {
    const plan = getSerializablePlan(msgId);
    if (plan) {
      planBlock = `\n[ACTIVE_PLAN]\n${JSON.stringify(plan).slice(0, 6000)}\n[/ACTIVE_PLAN]`;
    }
  } catch (_) {}

  let todoBlock = "";
  try {
    const todo = getSnapshot(msgId) || getSnapshot(sessionKey);
    if (todo) {
      todoBlock = `\n[ACTIVE_TODO]\n${JSON.stringify(todo).slice(0, 4000)}\n[/ACTIVE_TODO]`;
    }
  } catch (_) {}

  const recentBlock = recent
    .map(m => `[${m.role}] ${m.content.slice(0, 1200)}`)
    .join("\n\n");

  const summaryBlock = compact?.summary
    ? compact.summary
    : compact?.messages?.map(m => m.content).join("\n\n") || "";

  return `[R106_CONTEXT_BRIDGE]
\u8fd9\u662f Gateway session reset/\u538b\u7f29\u540e\u7684\u7eed\u822a\u4e0a\u4e0b\u6587\u3002\u8bf7\u57fa\u4e8e\u5b83\u7ee7\u7eed\u6267\u884c\uff0c\u4e0d\u8981\u5411\u7528\u6237\u89e3\u91ca\u672c\u6bb5\u5185\u5bb9\u3002

[CURRENT_USER_MESSAGE]
${userMessage}
[/CURRENT_USER_MESSAGE]

[COMPRESSED_HISTORY]
${summaryBlock}
[/COMPRESSED_HISTORY]

[ANCHORS]
${anchors.map(a => `[${a.reason}] ${a.content}`).join("\n")}
[/ANCHORS]

[RECENT_HOT_MESSAGES]
${recentBlock}
[/RECENT_HOT_MESSAGES]
${planBlock}
${todoBlock}
[/R106_CONTEXT_BRIDGE]`;
}

// ─── R108: Gateway 5xx one-shot retry ──────────────────────────────────────
const R108_GATEWAY_RETRY_DELAY_MS = 3000;
const R108_GATEWAY_MAX_RETRIES = 1;

function isR108RetryableGatewayError(err) {
  const msg = err?.message || String(err || "");
  return /(?:\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout|candidate_failed|model.*failed)/i.test(msg);
}

async function withR108GatewayRetry(operation, context = {}) {
  const { msgId, label = "gateway_request" } = context;
  let lastErr;
  for (let attempt = 0; attempt <= R108_GATEWAY_MAX_RETRIES; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= R108_GATEWAY_MAX_RETRIES || !isR108RetryableGatewayError(err)) {
        throw err;
      }
      logger.warn(`[R108] ${label} failed with transient Gateway error, retrying once in ${R108_GATEWAY_RETRY_DELAY_MS}ms: ${err.message}`);
      if (msgId) {
        sendEvent(msgId, {
          type: "thinking",
          content: "\n系统检测到 AI 引擎临时波动，正在自动重试一次...\n"
        });
      }
      await new Promise(r => setTimeout(r, R108_GATEWAY_RETRY_DELAY_MS));
    }
  }
  throw lastErr;
}

let lastApiCallTime = 0;
async function rateLimitedApiCall() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < MIN_API_INTERVAL_MS && lastApiCallTime > 0) {
    const waitMs = MIN_API_INTERVAL_MS - elapsed;
    logger.info(`[${new Date().toISOString()}] [worker] [RATE-LIMIT] Waiting ${waitMs}ms before next API call`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastApiCallTime = Date.now();
}

// Constants imported from agent-config.mjs

// saveLongOutputAsFile moved to output-manager.mjs

/**
 * @param {string} userMessage
 * @param {string} sessionKey
 * @param {string} msgId
 * @param {object} options - { timeout, abortController, thinking, roleSystemPrompt, needsStrongModel, strongModel }
 * @param {object} deps   - { gateway } injected from index
 * @returns {Promise<string>}
 */
export async function handleViaOpenClaw(userMessage, sessionKey, msgId, options = {}, deps = {}) {
  const taskId = msgId; // Iter-60 ledger: stable task id for this run
  const initialRunId = options.runId || msgId;
  const userRole = options.userRole || deps.userRole || 'member';
  const gatewaySessionKey = sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;
  const { gateway } = deps;
  const TIMEOUT_MS = options.timeout || DEFAULT_TIMEOUT_MS;
  // TOOL_TIMEOUT_MS imported from agent-config.mjs
  let toolsActiveCount = 0; // Track number of tools currently executing
  const toolIdMap = new TTLMap(500, 30 * 60 * 1000, 0);
  const _r38BrowserArgsCache = new TTLMap(500, 30 * 60 * 1000, 0); // [R38-T1] Cache browser args from tool_start for tool_end // FIX: Map tool data.id → frontend toolId so tool_end can match tool_start
  const toolStartTimes = new TTLMap(500, 30 * 60 * 1000, 0);
  const interventionToolTimers = new TTLMap(500, 30 * 60 * 1000, 0); // [R106] toolKey → timeout timer
  const interventionRecentTools = []; // [R106] sliding window of last 5 tool signatures
  let interventionRepeatCount = 0; // [R106] consecutive same tool+similar-args count
  let interventionLastSignature = null; // [R106]
  const orchToolIdMap = new TTLMap(500, 30 * 60 * 1000, 0);
  const toolNameIdStack = new TTLMap(500, 30 * 60 * 1000, 0); // FIX v2: Map toolName → [toolId, ...] stack for tools without data.id
  // BUG-2 FIX: Dedicated name-stack Maps instead of attaching properties to Map instances
  const orchNameStacks = new TTLMap(500, 30 * 60 * 1000, 0);  // toolName → [orchToolId, ...]
  const tstNameStacks = new TTLMap(500, 30 * 60 * 1000, 0);   // toolName → [toolExpKey, ...]
  const abortController = options.abortController || new AbortController();
  const { signal } = abortController;
  const ts = () => new Date().toISOString();

// [R35-T2] Self-Healing Loop: Tool fallback mapping
// When a tool fails, automatically suggest/inject an alternative tool
const TOOL_FALLBACK_MAP = {
  'web_fetch': { fallback: 'web_search', reason: 'web_fetch failed, falling back to web_search' },
  'web_search': { fallback: 'web_fetch', reason: 'web_search failed, falling back to web_fetch for direct URL access' },
  'browser': { fallback: 'web_fetch', reason: 'browser tool failed, falling back to web_fetch' },
  // [R37-T3] Extended fallback: web_fetch → browser when static fetch insufficient
  'web_fetch_to_browser': { fallback: 'browser', reason: 'web_fetch returned insufficient content, upgrading to browser' },
  'read_file': { fallback: 'exec', reason: 'read_file failed, falling back to exec cat' },
  'write_file': { fallback: 'exec', reason: 'write_file failed, falling back to exec with echo/cat' },
  'generate_image': { fallback: 'web_search', reason: 'image generation failed, falling back to web_search for existing images' },
  'speak_text': { fallback: null, reason: 'TTS failed, will skip voice output' },
  'analyze_image': { fallback: null, reason: 'Vision analysis failed, will describe based on URL/context' },
  'analyze_video': { fallback: null, reason: 'Video analysis failed' },     // [R44-T6]
  'analyze_audio': { fallback: null, reason: 'Audio analysis failed' },     // [R44-T6]
  'analyze_document': { fallback: null, reason: 'Document analysis failed' }, // [R44-T6]
};

  // ─── R106: Gateway mid-execution intervention helpers ───
  const INTERVENTION_TOOL_TIMEOUT_MS = 120 * 1000;
  const INTERVENTION_REPEAT_THRESHOLD = 3;
  const INTERVENTION_WINDOW_SIZE = 5;

  function normalizeInterventionArgs(rawArgs) {
    try {
      const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs || {});
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return String(rawArgs || "").slice(0, 240);
      const volatileKeys = new Set(["id", "runId", "msgId", "timestamp", "time", "timeoutMs", "delayMs"]);
      const stable = {};
      for (const key of Object.keys(parsed).sort()) {
        if (!volatileKeys.has(key)) stable[key] = parsed[key];
      }
      return JSON.stringify(stable).slice(0, 240);
    } catch (_) {
      return String(rawArgs || "").replace(/\s+/g, " ").slice(0, 240);
    }
  }

  function interventionSignature(toolName, rawArgs) {
    return `${toolName}:${normalizeInterventionArgs(rawArgs)}`;
  }

  function clearInterventionTimer(toolKey, toolName) {
    let keyToClear = toolKey && interventionToolTimers.has(toolKey) ? toolKey : null;
    if (!keyToClear) {
      for (const [candidateKey, entry] of interventionToolTimers.entries()) {
        if (entry.toolName === toolName) { keyToClear = candidateKey; break; }
      }
    }
    if (!keyToClear) return;
    const entry = interventionToolTimers.get(keyToClear);
    if (entry?.timer) clearTimeout(entry.timer);
    interventionToolTimers.delete(keyToClear);
  }

  function clearAllInterventionTimers() {
    for (const [, entry] of interventionToolTimers.entries()) {
      if (entry?.timer) clearTimeout(entry.timer);
    }
    interventionToolTimers.clear();
  }

  function recordInterventionToolStart(toolKey, toolName, rawArgs) {
    const startedAt = Date.now();
    const timeoutTimer = setTimeout(() => {
      logger.info(`[${ts()}] [worker] [INTERVENTION-TIMEOUT] tool ${toolName} exceeded 120s`);
      injectMessage(gatewaySessionKey, "请跳过当前操作，尝试其他方法", gateway).catch(err => {
        logger.warn(`[${ts()}] [worker] [INTERVENTION-TIMEOUT] inject failed for tool ${toolName}: ${err.message}`);
      });
      interventionToolTimers.delete(toolKey);
    }, INTERVENTION_TOOL_TIMEOUT_MS);
    interventionToolTimers.set(toolKey, { timer: timeoutTimer, toolName, startedAt });

    const signature = interventionSignature(toolName, rawArgs);
    interventionRecentTools.push({ toolName, signature, ts: startedAt });
    while (interventionRecentTools.length > INTERVENTION_WINDOW_SIZE) interventionRecentTools.shift();

    interventionRepeatCount = signature === interventionLastSignature ? interventionRepeatCount + 1 : 1;
    interventionLastSignature = signature;

    if (interventionRepeatCount >= INTERVENTION_REPEAT_THRESHOLD) {
      logger.info(`[${ts()}] [worker] [INTERVENTION-LOOP] tool ${toolName} called ${interventionRepeatCount} times consecutively`);
      injectMessage(gatewaySessionKey, "你在重复操作，请换一种方法", gateway).catch(err => {
        logger.warn(`[${ts()}] [worker] [INTERVENTION-LOOP] inject failed for tool ${toolName}: ${err.message}`);
      });
      interventionRecentTools.length = 0;
      interventionRepeatCount = 0;
      interventionLastSignature = null;
    }
  }

function getToolFallback(toolName) {
  return TOOL_FALLBACK_MAP[toolName] || null;
}

// [R43-T3] Tool naming normalization — standardized prefix format
const TOOL_NAME_MAP = {
  // Browser tools → browser_*
  'browser': 'browser_navigate',
  // Shell tools → shell_*
  'exec': 'shell_exec',
  'code': 'shell_exec',
  // File tools → file_*
  'write_file': 'file_write',
  'edit_file': 'file_edit',
  'read_file': 'file_read',
  'create_file': 'file_create',
  // Search tools → search_*
  'web_search': 'search_web',
  'web_fetch': 'search_fetch',
  // Media tools → media_*
  'generate_image': 'media_image_generate',
  'analyze_image': 'media_image_analyze',
  'analyze_video': 'media_video_analyze',     // [R44-T6]
  'analyze_audio': 'media_audio_analyze',     // [R44-T6]
  'analyze_document': 'media_document_analyze', // [R44-T6]
  'speak_text': 'media_tts',
  'transcribe_audio': 'media_transcribe',
  // MCP tools → mcp_*
  'mcp_tool': 'mcp_call',
};
function normalizeToolName(rawName) {
  return TOOL_NAME_MAP[rawName] || rawName;
}



  // ─── R7: Session binding and stream state initialization ───
  const _boundSessionKey = bindTaskSession(msgId, sessionKey);
  const _ss = initStreamState(msgId);
  logger.info(`[${ts()}] [R7] task=${msgId} sessionBound=${_boundSessionKey.substring(0, 40)} streamState=initialized`);

  // 控制台会話（openclaw-control-ui）可能触发重复回放/重试；禁用进度刷屏类 guardrail 注入
  const isControlUI = 
    (options?.sender?.id === "openclaw-control-ui") || 
    (options?.metadata?.id === "openclaw-control-ui") || 
    (userMessage || "").includes("openclaw-control-ui");

  // ─── Step 1: Ensure Gateway connection ───
  const connectStepId = sendStep(msgId, "连接 AI 引擎", "running", "WebSocket");
  if (!gateway.isConnected) {
    try {
      await gateway.connect();
    } catch (err) {
      updateStep(msgId, connectStepId, "error", `连接失败: ${sanitizeForFrontend(err.message)}`);
      throw new Error(`AI 引擎暂时不可用: ${sanitizeForFrontend(err.message)}`);
    }
  }
  updateStep(msgId, connectStepId, "completed", "已连接");
  // ─── [R106] Proactive Gateway session token check + Context Bridge ───
  // If session has accumulated too many tokens, reset it proactively
  // This prevents the slow compaction (2+ minutes) that blocks task startup
  {
    const PROACTIVE_RESET_THRESHOLD = 80000; // Reset if > 80K tokens
    try {
      const sessionsList = await gateway.request("sessions.list", {});
      const currentSession = sessionsList?.sessions?.find(s => s.key === sessionKey || s.key === gatewaySessionKey);
      if (currentSession && currentSession.totalTokens > PROACTIVE_RESET_THRESHOLD) {
        logger.info(`[R106] Proactive reset requested: session has ${currentSession.totalTokens} tokens`);
        sendEvent(msgId, { type: "thinking", content: "正在压缩历史上下文并保留关键节点..." });

        let contextBridge = "";
        try {
          contextBridge = await buildR106ContextBridge({
            sessionKey,
            msgId,
            userMessage,
            trigger: "gateway_token_overflow",
          });
          logger.info(`[R106] Context bridge prepared: chars=${contextBridge.length}, tokens≈${estimateTokens(contextBridge)}`);
        } catch (bridgeErr) {
          logger.warn(`[R106] Context bridge build failed, reset will continue without bridge: ${bridgeErr.message}`);
        }

        try {
          await gateway.resetSession(sessionKey);
          logger.info(`[R106] Proactive reset complete`);

          if (contextBridge) {
            const injected = await injectMessage(gatewaySessionKey, contextBridge, gateway);
            logger.info(`[R106] Context bridge injected after reset: ${injected ? "ok" : "failed"}`);
            if (ctxMgr) ctxMgr.recordCompression(estimateTokens(contextBridge));
          }
        } catch (resetErr) {
          logger.warn(`[R106] Proactive reset failed: ${resetErr.message}`);
        }
      }
    } catch (listErr) {
      // Non-fatal: if sessions.list fails, just continue
    }
  }

  // ─── Step 2: Send chat request ───
  const thinkStepId = sendStep(msgId, "AI 思考中", "running", "RangerAI");
  sendEvent(msgId, { type: "status", status: "thinking" });

  // Fix P1-2: Use crypto.randomUUID() for collision-free idempotency keys
  const idempotencyKey = `ranger-${crypto.randomUUID()}`;

  let payload;
  let modelUpgraded = false;
  let routeModelPatched = false;
  let activeSessionKey = sessionKey;
  const originalSessionKey = sessionKey;
  let planABResult = null;
  let ctxMgr = null; // [R73v3] Moved outside try block to fix scope issue
  try {
    const roleSystemPrompt = options.roleSystemPrompt || null;

    // RBAC v2: Sanitize user message to prevent prompt injection
    // Strip any attempts to inject fake ROLE_CONTEXT, SECURITY POLICY, or SYSTEM tags
    // [R40-FIX4c] DO NOT filter SYSTEM_HIDDEN_CONTEXT_RECOVERY — it's generated internally
    // by context-injector.mjs for session recovery, not by user input
    const sanitizedUserMessage = userMessage
      .replace(/\[\/?ROLE_CONTEXT\]/gi, '[BLOCKED_TAG]')
      .replace(/\[\/?SECURITY[_ ]POLICY\]/gi, '[BLOCKED_TAG]')
      .replace(/\[\/?SYSTEM\]/gi, '[BLOCKED_TAG]')
      .replace(/\[\/?KNOWLEDGE_CONTEXT\]/gi, '[BLOCKED_TAG]');
    
    const effectiveMessage = roleSystemPrompt
      ? `[ROLE_CONTEXT]\n${roleSystemPrompt}\n[/ROLE_CONTEXT]\n\n${sanitizedUserMessage}`
      : sanitizedUserMessage;

    // R59: KV-Cache 前缀稳定性审计 — 只哈希稳定前缀（不含用户消息）
    // effectiveMessage 包含 sanitizedUserMessage，用户消息每次不同导致前缀哈希不稳定。
    {
      const stablePrefix = roleSystemPrompt
        ? `[ROLE_CONTEXT]\n${roleSystemPrompt}\n[/ROLE_CONTEXT]`
        : '(no-role-prompt)';
      const kvResult = trackPrefix(sessionKey, stablePrefix);
      logger.info(`[${ts()}] [worker] [R59-KVCACHE] prefix_hash=${kvResult.hash} stable=${kvResult.stable} missRate=${kvResult.missRate} prefixLen=${stablePrefix.length} session=${sessionKey}`);
      if (!kvResult.stable) {
        logger.info(`[${ts()}] [worker] [R59-KVCACHE] [MISS] prev=${kvResult.prevHash} curr=${kvResult.hash} — KV-Cache prefix changed, cache will miss`);
      }
    }
    // DEFENSIVE: Only use 'thinking' key (never 'thinkingLevel' — Gateway rejects it)
    const thinkingLevel = options.thinking || 'high'; // Default to high for quality

    // v23.1 (dedicated sessions) was REMOVED because new sessions lose system prompt,
    // conversation history, and tool context, causing 0-text-output failures.
    // the existing context format (cross-provider), the Gateway will still try its best.
    // The self-healer will catch any empty responses.
    // GPT models caused text-only "typewriter" output without Agent mode (tool calling + planning)
    // The smart-router MODEL_MAP now maps all types to Claude, so routedModel === primary model
    // No patch needed; Gateway uses its configured primary model (deepseek-v4-pro) by default
    // v26.0-SMART-ROUTE: Activate model patching for cost optimization
    // Smart Router selects cheaper models (gpt-5.4-mini) for non-tool tasks (chat, translation, etc.)
    // Only code/sysadmin tasks require Claude for tool calling stability
    // [R10-FIX] Also block downgrade if task has an active plan (complex tasks must stay on strong model)
    // [Iter-66b] Gateway default model is deepseek/deepseek-v4-pro (not gpt-5.5)
    // Always patch session when routedModel differs from Gateway default
    const GATEWAY_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';
    const _hasActivePlan = _agentLoopModules?.pl?.getPlan?.(msgId) != null;

    // [BUG-1 FIX] Check if conversation contains image_url content
    // DeepSeek API rejects image_url message parts → block downgrade to DeepSeek
    const _hasImageContent = options.conversationHistory?.some(m => {
      if (Array.isArray(m.content)) return m.content.some(p => p.type === 'image_url');
      return false;
    }) ?? false;

    if (_hasActivePlan && options.routedModel && options.routedModel !== GATEWAY_DEFAULT_MODEL) {
      logger.info(`[${ts()}] [worker] [R10-FIX] Blocked model downgrade to ${options.routedModel}: task ${msgId} has active plan, keeping default`);
    } else if (_hasImageContent && options.routedModel && (options.routedModel.startsWith('deepseek/') || options.routedModel === 'deepseek/deepseek-v4-pro')) {
      logger.info(`[${ts()}] [worker] [BUG-1] Blocked DeepSeek downgrade: conversation contains image_url content, keeping vision-capable default`);
    } else if (options.routedModel && options.routedModel !== GATEWAY_DEFAULT_MODEL && !options.needsStrongModel) {
      try {
        await gateway.request("sessions.patch", {
          key: gatewaySessionKey,
          model: options.routedModel
        });
        routeModelPatched = true;
        updateTraceModel(msgId, options.routedModel);
        logger.info(`[${ts()}] [worker] [v26.0-SMART-ROUTE] Patched session model to ${options.routedModel} (cost optimization)`);
      } catch (patchErr) {
        logger.warn(`[${ts()}] [worker] [v26.0-SMART-ROUTE] Model patch failed: ${patchErr.message}. Continuing with default Claude.`);
      }
    }
    // [R-COST-OPT] DISABLED: needsStrongModel session patch removed.
    // Architecture: GPT5.5 plans via direct API (plan-structured.mjs), V4Pro executes via Gateway.
    // Phase 3 review has its own patch (~line 1091). No need to patch entire session to GPT5.5.
    if (options.needsStrongModel && options.strongModel) {
      logger.info(`[${ts()}] [worker] [R-COST-OPT] needsStrongModel=${options.needsStrongModel} strongModel=${options.strongModel} — NOT patching session. Execution stays on Gateway default (V4Pro). Planning uses GPT-5.5 via direct API.`);
      // Do NOT set modelUpgraded or routeModelPatched — session stays on V4Pro
      planABResult = { plan: "COST-OPT", model: "deepseek/deepseek-v4-pro", session: "main" };
    }

    // ─── Iter-C: Context Compression Pipeline ───
    // Check usage ratio and apply compression if needed
    ctxMgr = getContextManager(sessionKey, msgId); // [R81] Moved before compression block to fix ctxMgr TDZ
    if (options.conversationHistory && options.conversationHistory.length > 0) {
      const MODEL_MAX_TOKENS = 200000;
      let usageRatio;
      if (options.gatewayTotalTokens && options.gatewayTotalTokens > 0) {
        usageRatio = Math.min(1, options.gatewayTotalTokens / MODEL_MAX_TOKENS);
        logger.info(`[${ts()}] [worker] [Iter-C] Pre-send usage ratio: ${(usageRatio * 100).toFixed(1)}% (Gateway actual: ${options.gatewayTotalTokens} tokens), messages: ${options.conversationHistory.length}`);
      } else {
        usageRatio = getUsageRatio(options.conversationHistory, MODEL_MAX_TOKENS);
        logger.info(`[${ts()}] [worker] [Iter-C] Pre-send usage ratio: ${(usageRatio * 100).toFixed(1)}% (local estimate), messages: ${options.conversationHistory.length}`);
      }
      
      const msgCount = options.conversationHistory.length;
      // [Cost-R1-TaskA] Message-count-based fallback trigger
      // 补充策略：超过消息数阈值时也触发压缩（即使 token 占比未到上限）
      const shouldAutoCompact  = usageRatio >= AUTO_COMPACT_THRESHOLD  || msgCount >= AUTO_COMPACT_MSG_THRESHOLD;
      const shouldMicroCompact = usageRatio >= MICRO_COMPACT_THRESHOLD || msgCount >= MICRO_COMPACT_MSG_THRESHOLD;

      if (shouldAutoCompact) {
        // Level 2: autoCompact — LLM summary
        const autoReason = usageRatio >= AUTO_COMPACT_THRESHOLD
          ? `usage=${(usageRatio * 100).toFixed(1)}% >= ${AUTO_COMPACT_THRESHOLD * 100}%`
          : `msgs=${msgCount} >= ${AUTO_COMPACT_MSG_THRESHOLD}`;
        logger.info(`[${ts()}] [worker] [Iter-C] Triggering autoCompact (${autoReason})`);
        try {
          const acResult = await autoCompact(options.conversationHistory, sessionKey, msgId);
          if (acResult.compressed) {
            logger.info(`[${ts()}] [worker] [Iter-C] autoCompact success: ${acResult.stats.olderCompressed} msgs compressed, ${acResult.stats.recentKept} kept, summary=${acResult.stats.summaryChars} chars`);
            ctxMgr.recordCompression();
          }
        } catch (acErr) {
          logger.error(`[${ts()}] [worker] [Iter-C] autoCompact failed: ${acErr.message}, falling back to microCompact`);
          // [R80-Gap1] Degrade to microCompact on autoCompact failure
          // Prevents unbounded context growth when LLM summary is unavailable
          try {
            const mcResult = microCompact(options.conversationHistory, sessionKey);
            if (mcResult.compressed) {
              logger.info(`[${ts()}] [worker] [Iter-C] microCompact fallback: truncated=${mcResult.stats.truncated}, saved=${mcResult.stats.savedChars} chars`);
              sendEvent(msgId, { type: "thinking", content: "上下文压缩(轻量)完成" });
            }
          } catch (mcErr) {
            logger.error(`[${ts()}] [worker] [Iter-C] microCompact fallback also failed: ${mcErr.message}`);
          }
        }
      } else if (shouldMicroCompact) {
        // Level 1: microCompact — pure text truncation
        const microReason = usageRatio >= MICRO_COMPACT_THRESHOLD
          ? `usage=${(usageRatio * 100).toFixed(1)}% >= ${MICRO_COMPACT_THRESHOLD * 100}%`
          : `msgs=${msgCount} >= ${MICRO_COMPACT_MSG_THRESHOLD}`;
        logger.info(`[${ts()}] [worker] [Iter-C] Triggering microCompact (${microReason})`);
        const mcResult = microCompact(options.conversationHistory, sessionKey);
        if (mcResult.compressed) {
          logger.info(`[${ts()}] [worker] [Iter-C] microCompact: truncated=${mcResult.stats.truncated}, saved=${mcResult.stats.savedChars} chars`);
        }
      }
      
      // Budget tool results (always, but respects file_read exemption)
      const budgetStats = budgetToolResults(options.conversationHistory);
      if (budgetStats.truncated > 0) {
        logger.info(`[${ts()}] [worker] [Iter-C] budgetToolResults: truncated=${budgetStats.truncated}, exempted=${budgetStats.exempted}, saved=${budgetStats.savedChars} chars`);
      }
    }

    // ─── [R10-Task2] Check if this task has a recovered plan needing executor rebuild ───
    if (_agentLoopModules) {
      const recoveredInfo = _agentLoopModules.pl.getRecoveredPlan?.(msgId);
      if (recoveredInfo) {
        try {
          const { plan } = recoveredInfo;
          const currentStep = plan.steps.find(s => s.id === plan.currentStepId);
          logger.info(`[${ts()}] [R10-Task2] Rebuilding executor for recovered task ${msgId}, current step: ${plan.currentStepId}`);
          await recoverStepToolTracker(msgId, recoveredInfo.sessionKey || sessionKey, plan, 'R10-Task2');
          // Mark current step as doing (it may have been interrupted mid-execution)
          _agentLoopModules.pl.markStepDoing(msgId, plan.currentStepId);
          // Rebuild executor
          try {
            const executor = _agentLoopModules.ex.createExecutor(msgId, sessionKey, msgId, {
              sendEvent: sendEvent,
              plan,
              currentStep,
            });
            _agentLoopModules._executor = executor;
            logger.info(`[${ts()}] [R10-Task2] Executor rebuilt for recovered task ${msgId}`);
          } catch (exErr) {
            logger.warn(`[${ts()}] [R10-Task2] Executor rebuild failed: ${exErr.message}`);
          }
          // Consume the recovery entry so it doesn't trigger again
          _agentLoopModules.pl.consumeRecoveredPlan?.(msgId);
        } catch (recErr) {
          logger.warn(`[${ts()}] [R10-Task2] Recovery resume error: ${recErr.message}`);
        }
      }
    }

    // ─── [R6-Task1] Generate plan BEFORE chat.send so planBlock can be injected ───
    let _r6PlanBlock = '';
    if (_agentLoopModules) {
      try {
        const { emitEvent, emitLedgerEvent, EVENT_TYPES } = _agentLoopModules.es;
        emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.TASK_STARTED, {
          taskId,
          runId: initialRunId,
          userMessage: userMessage.substring(0, 500),
          model: options.routedModel || "deepseek/deepseek-v4-pro",
          thinking: thinkingLevel,
        });
        emitEvent(sessionKey, taskId, EVENT_TYPES.USER_MESSAGE, {
          taskId,
          runId: initialRunId,
          content: userMessage.substring(0, 2000),
          model: options.routedModel || "deepseek/deepseek-v4-pro",
          thinking: thinkingLevel,
        });
        // [R6] Generate plan synchronously (await) so it's available for injection
        // --- [THREE-PHASE] Phase 1: PLANNING (GPT-5.5) ---
        logger.info(`[${ts()}] [worker] [THREE-PHASE] Phase 1 (PLANNING): GPT-5.5 direct API`);
        const _planStartMs = Date.now();
        const plan = options.isAutoContinue ? null : await _agentLoopModules.pl.generatePlan(msgId, sessionKey, userMessage, {
          conversationSummary: options.conversationSummary || "",
          taskType: options.taskType || options.routeType || "reasoning",
        });
        const _planDurationMs = Date.now() - _planStartMs;
        if (plan) {
          // --- [THREE-PHASE] Phase 2: EXECUTION (deepseek-v4-pro) ---
          logger.info(`[${ts()}] [worker] [THREE-PHASE] Phase 2 (EXECUTION): Gateway agentic loop`);
          logger.info(`[${ts()}] [agent-loop] Plan v${plan.version} generated: ${plan.steps.length} steps (${_planDurationMs}ms)`);
          // [R30-FIX] Bridge planner plan to progress tracker
          // The planner stores plans in _planCache (with steps[]), but the progress tracker
          // uses progressStore (with _steps[]). initTrackerFromPlan bridges the two systems.
          try {
            const _progressPlan = {
              goal: plan.goal || '',
              phases: plan.steps.map(s => ({
                id: s.id,
                title: s.title || s.description || `步骤 ${s.id}`,
                status: s.status === 'doing' ? 'running' : (s.status || 'pending')
              }))
            };
            initTrackerFromPlan(sessionKey, _progressPlan);
            logger.info(`[${ts()}] [R30-FIX] Progress tracker initialized from plan: ${plan.steps.length} steps, goal="${(plan.goal || '').substring(0, 60)}"`);
          } catch (_ptErr) {
            logger.warn(`[${ts()}] [R30-FIX] Progress tracker init failed (non-fatal): ${_ptErr.message}`);
          }
          // [R15-T3] Supervisor preflight review (non-blocking)
          try {
            const _svReview = await supervisorEvaluate(plan, { taskId: msgId, sessionKey });
            if (_svReview.risks && _svReview.risks.length > 0) {
              logger.info(`[${ts()}] [R15-supervisor] Preflight: risk=${_svReview.riskLevel} risks=${_svReview.risks.map(r => r.label).join(', ')}`);
            } else {
              logger.info(`[${ts()}] [R15-supervisor] Preflight: no risks detected`);
            }
          } catch (_svErr) {
            logger.warn(`[${ts()}] [R15-supervisor] Preflight failed (non-fatal): ${_svErr.message}`);
          }
          _agentLoopModules.pl.markStepDoing(msgId, plan.currentStepId);
          const _ledgerPlanId = plan.planId || plan.id || msgId;
          const _ledgerCurrentStep = plan.steps?.find?.(s => s.id === plan.currentStepId || s.stepId === plan.currentStepId) || null;
          emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.PLAN_CREATED, {
            taskId,
            runId: initialRunId,
            planId: _ledgerPlanId,
            stepId: plan.currentStepId || null,
            currentStepId: plan.currentStepId || null,
            plan,
            currentStep: _ledgerCurrentStep,
            durationMs: _planDurationMs,
          });
          if (plan.currentStepId) {
            emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.STEP_STARTED, {
              taskId,
              runId: initialRunId,
              planId: _ledgerPlanId,
              stepId: plan.currentStepId,
              title: _ledgerCurrentStep?.title || _ledgerCurrentStep?.name || '',
              intent: _ledgerCurrentStep?.intent || _ledgerCurrentStep?.taskPhase || null,
              expectedAction: _ledgerCurrentStep?.expectedAction || _ledgerCurrentStep?.action || null,
              expectedOutput: _ledgerCurrentStep?.expectedOutput || null,
            });
          }
          // [R26-T3] Sync todo tracker from plan
          try {
            syncFromPlan(msgId, plan);
            markInProgress(msgId, plan.currentStepId);
            emitTodoEvent(msgId, (type, payload) => emitEvent(sessionKey, msgId, type, payload), sessionKey);
            logger.info(`[${ts()}] [R26-T3] Todo synced from plan: ${plan.steps.length} steps, current=${plan.currentStepId}`);
          } catch (_todoErr) {
            logger.warn(`[${ts()}] [R26-T3] Todo sync failed (non-fatal): ${_todoErr.message}`);
          }
          // [R6-Task1] Render plan as text block for LLM context injection
          _r6PlanBlock = _agentLoopModules.pl.renderPlanForContext(msgId);
          // [R70] Inject first step's taskBrief into initial context
          if (_r6PlanBlock && plan.steps && plan.steps.length > 0) {
            const _r70FirstStep = plan.steps.find(s => String(s.id) === String(plan.currentStepId)) || plan.steps[0];
            if (_r70FirstStep && _r70FirstStep.taskBrief) {
              _r6PlanBlock += '\n\n[TASK_BRIEF for Step ' + _r70FirstStep.id + ']\n' + _r70FirstStep.taskBrief + '\n[/TASK_BRIEF]';
              if (_r70FirstStep.acceptanceCriteria) {
                _r6PlanBlock += '\n[ACCEPTANCE_CRITERIA]\n' + _r70FirstStep.acceptanceCriteria + '\n[/ACCEPTANCE_CRITERIA]';
              }
              if (_r70FirstStep.reviewPolicy === 'gpt_review') {
                _r6PlanBlock += '\n[GPT_WILL_REVIEW] Your output for this step will be reviewed by GPT. Follow the task brief precisely.';
              }
              logger.info('[R70] First step taskBrief injected: ' + _r70FirstStep.taskBrief.substring(0, 80));
            }
          }
          if (_r6PlanBlock) {
            logger.info(`[${ts()}] [R6-inject] planBlock generated: ${_r6PlanBlock.length} chars, steps=${plan.steps.length}`);
          }
          // [R2-Task3] Create executor instance for this task
          try {
            const executor = _agentLoopModules.ex.createExecutor(msgId, sessionKey, msgId, {
              sendEvent: sendEvent,
              plan,
              currentStep: plan?.steps?.find(s => s.id === plan.currentStepId) || null,
            });
            _agentLoopModules._executor = executor;
            logger.info(`[${ts()}] [executor] Created for task ${msgId}, first step: ${plan.currentStepId}`);
          } catch (exErr) {
            logger.warn(`[${ts()}] [executor] Creation failed (non-fatal): ${exErr.message}`);
          }
        } else {
          logger.info(`[${ts()}] [agent-loop] Plan generation returned null (${_planDurationMs}ms)`);
        }
      } catch (_alErr) {
        logger.warn(`[${ts()}] [agent-loop] Event/plan error (non-fatal): ${_alErr.message}`);
      }
    }

    // [R6-Task1] Inject planBlock into effectiveMessage for LLM context
    let _r6EnrichedMessage = effectiveMessage;
    if (_r6PlanBlock) {
      _r6EnrichedMessage = `${effectiveMessage}\n\n[CURRENT_USER_INTENT_PRIORITY]\nThe latest user message above is authoritative. The plan below is guidance only. If the latest user message changes topic, asks a meta-question, corrects/objects to prior behavior, uploads evidence, or conflicts with CURRENT_PLAN/TASK_FOCUS, answer the latest user message first and do not execute stale plan steps.\n[/CURRENT_USER_INTENT_PRIORITY]\n\n[CURRENT_PLAN]\n${_r6PlanBlock}\n[/CURRENT_PLAN]\nUse the plan only when it matches the latest user message. Execute the CURRENT step only if it is still relevant to the latest user intent.`;
      try {
        const _r69Plan = _agentLoopModules?.pl?.getPlan?.(msgId) || null;
        if (shouldUseStructuredExecution(userMessage, _r69Plan)) {
          const _r69Directive = buildStepExecutionDirective(_r69Plan);
          _r6EnrichedMessage = `${_r6EnrichedMessage}\n\n${_r69Directive}`;
          emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.ACTION_STARTED, {
            taskId,
            runId: initialRunId,
            planId: _r69Plan?.planId || _r69Plan?.id || taskId,
            stepId: _r69Plan?.currentStepId || null,
            type: 'r69_structured_step_execution',
            reason: 'R69 execution discipline injected for complex task',
          });
          logger.info(`[${ts()}] [R69] structured step execution directive injected`);
        }
      } catch (_r69Err) {
        logger.warn(`[${ts()}] [R69] execution discipline injection failed (non-fatal): ${_r69Err.message}`);
      }
      logger.info(`[${ts()}] [R6-inject] planBlock injected into message: ${_r6PlanBlock.length} chars added`);
      recordPlanInjection(msgId); // [R12-T2]
    // [R20-T1] Inject task_focus attention anchor into context
    try {
      const _taskFocus = getActiveTaskFocus(sessionKey);
      if (_taskFocus) {
        const _focusBlock = formatTaskFocusForContext(_taskFocus);
        if (_focusBlock) {
          _r6EnrichedMessage = _r6EnrichedMessage + '\n\n' + _focusBlock;
          logger.info(`[${ts()}] [R20-T1] task_focus anchor injected: goal=${_taskFocus.current_goal?.substring(0, 50)}, status=${_taskFocus.status}`);
        }
      }
    } catch (_focusErr) {
      logger.warn(`[${ts()}] [R20-T1] task_focus injection failed (non-fatal): ${_focusErr.message}`);
    }
    }

    // [R37-T3] Browser routing directive — inject when plan indicates browser should be primary tool
    try {
      if (_agentLoopModules) {
        const _r37Plan = _agentLoopModules.pl.getPlan?.(msgId);
        if (_r37Plan && _r37Plan.selectedPrimaryTool === 'browser') {
          const _browserDirective = `\n\n[TOOL_ROUTING_DIRECTIVE]\nThis task is classified as a web task (family: ${_r37Plan.taskFamily || 'web'}).\nPREFERRED TOOL: browser (use browser_navigate, browser_screenshot, browser_extract_text, browser_click)\nUse browser tool for web page interaction, content extraction, and verification.\nOnly fall back to web_fetch if browser fails or for simple static text retrieval.\nRouting reason: ${_r37Plan.routingReason || 'Web task detected'}\n[/TOOL_ROUTING_DIRECTIVE]`;
          _r6EnrichedMessage = _r6EnrichedMessage + _browserDirective;
          const { emitEvent } = _agentLoopModules.es;
          emitEvent(sessionKey, msgId, 'tool_route_candidate', {
            candidates: ['browser', 'web_fetch', 'web_search'],
            preferred: 'browser',
            taskFamily: _r37Plan.taskFamily,
            reason: _r37Plan.routingReason,
          });
          logger.info(`[${ts()}] [R37-T3] Browser routing directive injected: family=${_r37Plan.taskFamily}`);
        }
      }
    } catch (_r37Err) {
      logger.warn(`[${ts()}] [R37-T3] Browser routing directive injection failed (non-fatal): ${_r37Err.message}`);
    }
    // R39-T3: Deep Research Directive injection
    try {
      const _userMsgForResearch = String(effectiveMessage || "");
      const _isResearchTask = /深度研究|综合分析|详细报告|deep research|comprehensive|in-depth|多源搜索|全面调研|研究报告|market research|competitive analysis/i.test(_userMsgForResearch);
      if (_isResearchTask) {
        const _researchDirective = "\n\n[RESEARCH_DIRECTIVE]\nYou are performing a DEEP RESEARCH task. Follow this structured approach:\n1. SEARCH PHASE: Use web_search with 3+ different query variations to gather diverse sources\n2. FETCH PHASE: Use web_fetch or browser to access the top 3-5 most relevant URLs from search results\n3. SYNTHESIZE PHASE: Cross-reference information from multiple sources, identify consensus and disagreements\n4. OUTPUT PHASE: Produce a structured Markdown report with:\n   - Executive Summary (2-3 sentences)\n   - Key Findings (organized by theme, with inline citations like [1][2])\n   - MANDATORY: Every factual claim MUST have an inline citation [N] referencing the source\n   - References section at the end: [1] Title - URL format\n   - Confidence Assessment (what is well-supported vs. uncertain)\nCITATION RULES (MANDATORY):\n- Every factual statement MUST include at least one inline citation marker [N]\n- Use the numbered sources from [RESEARCH_CONTEXT] as your reference numbers\n- At the end of your report, include a References section listing all cited sources\n- Format: [N] Source Title - URL\n- Do NOT make claims without citations\nIMPORTANT: Do NOT rely on a single source. Always cross-validate claims across 2+ sources.\n[/RESEARCH_DIRECTIVE]";
        _r6EnrichedMessage = _r6EnrichedMessage + _researchDirective;
        if (_agentLoopModules) {
          const { emitEvent: _emitR } = _agentLoopModules.es;
          _emitR(sessionKey, msgId, 'research_started', { topic: _userMsgForResearch.slice(0, 100), searchSources: 3, sourceCount: 0 });
        }
        logger.info(`[${ts()}] [R39-T3] Research directive injected for task`);
      }
    } catch (_r39Err) {
      logger.warn(`[${ts()}] [R39-T3] Research directive injection failed (non-fatal): ${_r39Err.message}`);
    }

    const chatSendParams = {
      sessionKey: sessionKey,
      message: _r6EnrichedMessage,
      deliver: false,
      idempotencyKey,
      thinking: thinkingLevel  // Always send thinking level
    };
    // DEFENSIVE: Ensure no 'thinkingLevel' key exists (Gateway bug workaround)
    delete chatSendParams.thinkingLevel;
    logger.info(`[${ts()}] [worker] [v25.3] Sending with thinking: ${thinkingLevel}, modelUpgraded: ${modelUpgraded}, routePatched: ${routeModelPatched}, session: ${sessionKey}`);
    await rateLimitedApiCall();
    payload = await withR108GatewayRetry(() => gateway.request("chat.send", chatSendParams), { msgId, label: "chat.send" });
  } catch (err) {
    updateStep(msgId, thinkStepId, "error", sanitizeForFrontend(err.message));
    throw err;
  }

  logger.info(`[${ts()}] [worker] chat.send response: ${JSON.stringify(payload).substring(0, 500)}`);
  const runId = payload.runId;
  setCurrentRunId(runId, sessionKey);
  logger.info(`[${ts()}] [worker] Run started: ${runId}`);

  // ─── Step 3: Listen for events and relay to frontend ───
  return new Promise((resolve, reject) => {
    // Create tool tracker for this run
    const tracker = createToolTracker(msgId);
    const orchestrator = createToolOrchestrator(msgId, userRole);
    // ctxMgr already initialized before compression block (R81 fix)
    ctxMgr.trackUserMessage(userMessage); // Track input tokens

    // Create stream filter for this run (filters technical content from AI text output)
    const streamFilter = createStreamFilter(sessionKey);

    // Stream state
    let fullText = "";
    let lastChunkAt = 0;
    let thinkingReceived = false;
    // GUARDRAIL-LANG v4: 基于 fullText 窗口的英文检测
            let engSuppressedChunks = []; // 缓冲被抑制的中文内容
    let streamStarted = false;
    let resolved = false;
    let lifecycleEnded = false;
    let agenticTurnCount = 0;        // v25.21-FIX3: Track agentic loop turns
    let chatFinalDelayTimer = null;   // v25.21-FIX3: Delayed finishSuccess for agentic loop detection
    let noReplyBuffered = null;       // R22-fix: Buffer potential NO_REPLY split
    let noReplyTimer = null;          // R22-fix: Timer for NO_REPLY detection
    let phantomChunkTimer = null;      // R24-fix: Timer for phantom first chunk delay
    let phantomChunkPending = null;    // R61-fix: Pending delayed first chunk, flushed only if real content follows
    let ghostFinalTimer = null;
    let lifecycleSafetyTimer = null;  // [R48-FIX] Store lifecycle safety timeout so it can be cancelled on new turn
    // [R51-FIX] lastActivityAt already declared below (line ~706) — reused for safety timer tracking
    let selfHealAttempted = false;
    let selfHealInProgress = false;
    let gatewayInjectedCount = 0;
    let streamId = `stream-${Date.now()}`;
    // F33: Gateway token usage accumulator
    let gatewayUsage = null;

    // ─── GUARDRAIL-PROGRESS: Track consecutive tool calls without text output ───
    let toolsSinceLastText = 0;       // Reset to 0 whenever AI outputs text
    let progressReminderCount = 0;    // How many reminders we've injected this run
    let lastTextOutputAt = Date.now(); // Timestamp of last text output
    let lastProgressReminderAt = 0; // Timestamp of last injected progress reminder (recurring throttle)

    // [R30-T1] Consecutive tool failure counter — trigger user clarification after 3 failures
    let _consecutiveToolFailCount = 0;
    let _r30HelpRequested = false; // Only ask once per turn

    // Inactivity timeout
    let lastActivityAt = Date.now();
    async function handleTimeout() {
      if (resolved) {
        logger.info(`[${ts()}] [worker] [v8.0] TIMEOUT fired but already resolved — ignoring (prevents aborting new run)`);
        return;
      }
      logger.info(`[${ts()}] [worker] [TIMEOUT] Inactivity timeout (${TIMEOUT_MS / 1000}s). fullText=${fullText.length} chars, streamStarted=${streamStarted}, tools=${tracker.toolCount}`);
      // [R43-T2] Emit tool_timeout event for inactivity timeout
      try {
        emitEvent(sessionKey, taskId, EVENT_TYPES.TOOL_TIMEOUT, {
          tool: '_inactivity',
          timeoutMs: TIMEOUT_MS,
          thresholdMs: TIMEOUT_MS,
          severity: 'inactivity',
          step: tracker.currentStepId || null,
          retryCount: 0,
          fullTextLength: fullText.length,
          streamStarted
        });
      } catch (_e43tti) { /* non-fatal */ }
      if (fullText.length > 50 || tracker.toolCount > 0) {
        logger.info(`[${ts()}] [worker] [TIMEOUT] Delivering partial result (${fullText.length} chars) instead of error`);
        try {
          await gateway.request("chat.abort", { sessionKey, runId });
          logger.info(`[${ts()}] [worker] [v10.0] TIMEOUT abortChat success (runId=${runId}) — waiting 2s cooldown for lane cleanup`);
          await new Promise(r => setTimeout(r, 2000)); // P0-FIX: cooldown for lane release
        } catch (abortErr) {
          logger.info(`[${ts()}] [worker] [v10.0] TIMEOUT abortChat failed (non-fatal): ${abortErr.message}`);
        }
        fullText += "\n\n---\n> ⚠️ AI 引擎响应超时，以上为已生成的部分内容。如需完整回复，请发送「继续」。";
        finishSuccess(fullText);
      } else {
        // BUG-1 FIX: Restore model on timeout path (same as finishSuccess restore block)
        if (routeModelPatched) {
          gateway.request("sessions.patch", {
            key: gatewaySessionKey,
            model: 'deepseek/deepseek-v4-pro'  // [Iter-66b] Restore to actual Gateway default
          }).catch(err => {
            logger.warn(`[${ts()}] [worker] [BUG1-FIX] routedModel restore failed in timeout: ${err.message}`);
          });
        }
        cleanup("timeout");
        reject(new Error(`AI 引擎超时 (${TIMEOUT_MS / 1000}s 无活动)`));
      }
    }
    let timeoutTimer = setTimeout(handleTimeout, TIMEOUT_MS);

    function resetTimeout() {
      lastActivityAt = Date.now();
      clearTimeout(timeoutTimer);
      const activeTimeout = toolsActiveCount > 0 ? TOOL_TIMEOUT_MS : TIMEOUT_MS;
      timeoutTimer = setTimeout(handleTimeout, activeTimeout);
    }

    // Heartbeat
    let heartbeatCount = 0;
    const taskStartTime = Date.now(); // Iter-AG: 任务总运行时长基准（不随工具调用重置）
    let longRunningNotified = false;  // Iter-AG: 3分钟提示只发一次
    const heartbeatTimer = setInterval(() => {
      heartbeatCount++;
      const totalElapsedSec = Math.floor((Date.now() - taskStartTime) / 1000);
      sendEvent(msgId, {
        type: "progress",
        phase: "processing",
        elapsed: Math.floor((Date.now() - lastActivityAt) / 1000),
        totalElapsed: totalElapsedSec,       // Iter-AG: 任务总耗时（秒）
        heartbeat: heartbeatCount,
        toolCount: tracker.toolCount,
        streamStarted
      });
      // Iter-AG: 任务超过 3 分钟时推送 long_running_notify，提示用户耐心等待
      if (!longRunningNotified && totalElapsedSec >= 180) {
        longRunningNotified = true;
        logger.info(`[${ts()}] [worker] [Iter-AG] Task running ${totalElapsedSec}s — sending long_running_notify`);
        sendEvent(msgId, {
          type: "long_running_notify",
          totalElapsed: totalElapsedSec,
          toolCount: tracker.toolCount,
          message: "任务仍在执行中，请耐心等待...",
        });
      }
      // FIX: Single tool execution timeout check
      if (toolsActiveCount > 0 && toolStartTimes.size > 0) {
        const now = Date.now();
        for (const [key, entry] of toolStartTimes.entries()) {
          const elapsed = now - entry.startTime;
          if (elapsed > SINGLE_TOOL_HARD_MS && !entry._hardWarned) {
            entry._hardWarned = true;
            logger.info(`[${ts()}] [worker] [TOOL-TIMEOUT] HARD: ${entry.toolName} running ${Math.round(elapsed/1000)}s > ${SINGLE_TOOL_HARD_MS/1000}s — triggering abort`);
            sendEvent(msgId, { type: "timeout_warning", elapsed: Math.round(elapsed/1000), tool: entry.toolName, severity: "hard" });
            // [R43-T2] Emit tool_timeout event
            try {
              emitEvent(sessionKey, taskId, EVENT_TYPES.TOOL_TIMEOUT, {
                tool: entry.toolName,
                timeoutMs: Math.round(elapsed),
                thresholdMs: SINGLE_TOOL_HARD_MS,
                severity: 'hard',
                step: tracker.currentStepId || null,
                retryCount: entry._retryCount || 0,
                key
              });
              logger.info(`[${ts()}] [R43-T2] tool_timeout emitted: tool=${entry.toolName} elapsed=${Math.round(elapsed/1000)}s severity=hard`);
            } catch (_e43tt) { /* non-fatal */ }
            // Trigger cleanup to abort the stuck tool
            cleanup("tool_timeout_hard");
            reject(new Error(`Tool ${entry.toolName} exceeded hard timeout (${SINGLE_TOOL_HARD_MS/1000}s)`));
            return; // Exit heartbeat — cleanup will clear the interval
          } else if (elapsed > SINGLE_TOOL_MAX_MS && !entry._softWarned) {
            entry._softWarned = true;
            logger.info(`[${ts()}] [worker] [TOOL-TIMEOUT] SOFT: ${entry.toolName} running ${Math.round(elapsed/1000)}s > ${SINGLE_TOOL_MAX_MS/1000}s — warning`);
            sendEvent(msgId, { type: "timeout_warning", elapsed: Math.round(elapsed/1000), tool: entry.toolName, severity: "soft" });
            // [R43-T2] Emit tool_timeout event for soft timeout
            try {
              emitEvent(sessionKey, taskId, EVENT_TYPES.TOOL_TIMEOUT, {
                tool: entry.toolName,
                timeoutMs: Math.round(elapsed),
                thresholdMs: SINGLE_TOOL_MAX_MS,
                severity: 'soft',
                step: tracker.currentStepId || null,
                retryCount: entry._retryCount || 0,
                key
              });
              logger.info(`[${ts()}] [R43-T2] tool_timeout emitted: tool=${entry.toolName} elapsed=${Math.round(elapsed/1000)}s severity=soft`);
            } catch (_e43tts) { /* non-fatal */ }
          }
        }
      }
    }, 10000);

    function cleanup(reason) {
      if (resolved) return;
      logger.info(`[${ts()}] [worker] Task ${msgId} cleanup: ${reason}`);
      clearTimeout(timeoutTimer);
      clearInterval(heartbeatTimer);
      gateway.offRunEvents(runId);
      clearAllInterventionTimers();
      // [R46-BUGFIX] Release all orchestrator slots on cleanup to prevent concurrency leak
      try { const activeToolIds = [...(orchestrator.getActiveToolInfo ? [] : [])]; } catch(err) {
        logger.warn(`[${ts()}] [worker] Cleanup: orchestrator getActiveToolInfo failed: ${err.message}`);
      }
      // Force reset via the leak detection path
      try { orchestrator.forceReset && orchestrator.forceReset(); } catch(err) {
        logger.warn(`[${ts()}] [worker] Cleanup: orchestrator forceReset failed: ${err.message}`);
      }
      // Only skip abort for "completed" (normal lifecycle end) and "error" (Gateway already knows)
      const WORKER_ABORT_REASONS = ["timeout", "tool_abort", "guardrail_abort", "loop_abort"];
      const needsGatewayAbort = WORKER_ABORT_REASONS.some(r => reason.includes(r)) || 
        (reason !== "completed" && reason !== "error");
      if (needsGatewayAbort && runId && gateway.isConnected) {
        logger.info(`[${ts()}] [worker] [v9.1] Cleanup abort: notifying Gateway to release lane (reason=${reason}, runId=${runId})`);
        gateway.request("chat.abort", { sessionKey, runId }).then(() => {
          logger.info(`[${ts()}] [worker] [v9.1] Cleanup abort success — lane released`);
          setCurrentRunId(null, sessionKey);
        }).catch(err => {
          logger.info(`[${ts()}] [worker] [v9.1] Cleanup abort failed (non-fatal): ${err.message}`);
          setCurrentRunId(null, sessionKey);
        });
      } else {
        setCurrentRunId(null, sessionKey);
      }
      if (ghostFinalTimer) { clearTimeout(ghostFinalTimer); ghostFinalTimer = null; }

      // Note: cleanup() is sync, so we use Promise chain (no await)
      if (modelUpgraded) {
        logger.info(`[${ts()}] [worker] [v7.3] Keeping modelOverride persistent (no restore)`);
      }
    }

    // ─── Finish handlers ───
    async function finishSuccess(text) {
      if (resolved) return;
      // R7 Task 1: Atomic finalizeOnce guard with reason tracking
      if (!finalizeOnce(msgId, 'finishSuccess')) {
        logger.warn(`[${ts()}] [R7-stream] finishSuccess blocked by finalizeOnce for task=${msgId}`);
        return;
      }
      // P0-FIX v14.0: Immediately set resolved=true SYNCHRONOUSLY to prevent race conditions.
      // Three async paths (chat:final 1s delay, lifecycle:end 15s delay, HARD_LIMIT 2s delay)
      // can all pass the `if (resolved) return` check during async self-heal operations.
      // By setting resolved=true here, we guarantee only the first caller proceeds.
      resolved = true;
      markStreamEvent(msgId, 'completed');
      clearInterval(heartbeatTimer); // P0-FIX: Stop heartbeat immediately when resolved
      clearTimeout(timeoutTimer);
      clearAllInterventionTimers();
      // capturing events meant for subsequent runs. cleanup() has `if (resolved) return;`
      // which skips offRunEvents when we've already set resolved=true above.
      gateway.offRunEvents(runId);

      const hasText = text && text.trim().length > 0;
      const hasTools = tracker.toolCount > 0;
      const summary = tracker.getSummary();
      // many tool calls without producing a substantive summary. The chat:final only contains
      // the initial brief text, leaving the user with no useful output.
      const textLen = text ? text.trim().length : 0;
      const shortTextThreshold = Math.max(80, summary.toolCount * 15); // R52: relaxed threshold
      const isShortTextManyTools = hasText && textLen < shortTextThreshold && summary.toolCount >= 8; // R52: raised min tools from 3 to 8

      logger.info(`[${ts()}] [worker] [CHECKPOINT] Response validation: text=${hasText ? textLen + "chars" : "EMPTY"}, tools=${summary.toolCount}, threshold=${shortTextThreshold}, selfHealAttempted=${selfHealAttempted}, isShortTextManyTools=${isShortTextManyTools}`);

      // SELF-HEAL: Tools ran but no text reply -> request summary
      if ((!hasText || isShortTextManyTools) && hasTools && !selfHealAttempted && !selfHealInProgress) {
        selfHealInProgress = true;
        const healReason = isShortTextManyTools
          ? `SHORT_TEXT_MANY_TOOLS: ${textLen} chars text but ${summary.toolCount} tools executed`
          : `${summary.toolCount} tools executed but no text`;
        logger.info(`[${ts()}] [worker] [CHECKPOINT] FAILED: ${healReason}. Triggering self-heal...`);
        sendEvent(msgId, { type: "thinking", content: `\u2705 ${summary.toolCount} 个工具操作完成，正在生成总结...\n` });
  
        // --- [THREE-PHASE] Phase 3: REVIEW (GPT-5.5) ---
        logger.info("[" + new Date().toISOString() + "] [worker] [THREE-PHASE] Phase 3 (REVIEW): patching to GPT-5.5");
        try {
          await gateway.request("sessions.patch", { key: gatewaySessionKey, model: "openai/gpt-5.5" });
          routeModelPatched = true;
        } catch (_p3Err) {
          logger.warn("[THREE-PHASE] Phase 3 patch failed: " + _p3Err.message);
        }
        selfHealAttempted = true;
        try {
          const healResult = await requestToolSummary(
            sessionKey, msgId, summary.toolCount, summary.toolNames,
            deps, { streamStarted, streamId }, userMessage
          );
          if (healResult && healResult.text && healResult.text.trim().length > 0) {
            logger.info(`[${ts()}] [worker] [SELF-HEAL] Got summary (${healResult.text.length} chars), using as reply`);
            fullText = healResult.text;
            text = healResult.text;
            streamStarted = healResult.streamStarted;
          } else {
            logger.info(`[${ts()}] [worker] [SELF-HEAL] Summary also empty, using fallback message`);
            text = `\u2705 已执行 ${summary.toolCount} 个工具操作（${summary.uniqueTools.join("\u3001")}）。\n\nAI 完成了工具调用但未能生成文本总结。请查看上方的工具执行详情，或发送「继续」获取结果总结。`;
          }
        } finally {
          selfHealInProgress = false;
        }
      }

      // SELF-HEAL: Truncation detection (Layer-2 fix: pass attempt count to continueTruncation)
      // P1-FIX v14.0: Relaxed from `toolCount === 0` to `toolCount < 10`.
      // Previously, ANY tool call would disable truncation detection entirely,
      // meaning AI could call 3 tools then output incomplete text without triggering continuation.
      // Now allows truncation detection when fewer than 10 tools were used.
      if (text && detectTruncation(text) && tracker.toolCount < 10 && !selfHealAttempted) {
        logger.info(`[${ts()}] [worker] [CHECKPOINT] Possible truncation detected (text length: ${text.length}, toolCount: ${tracker.toolCount})`);
        selfHealAttempted = true;

        const contResult = await continueTruncation(
          sessionKey, msgId, deps, { streamStarted, streamId }, 1 // explicit attempt=1 (Layer-1 will retry internally)
        );
        if (contResult && contResult.text && contResult.text.trim().length > 0) {
          logger.info(`[${ts()}] [worker] [SELF-HEAL] Got continuation: ${contResult.text.length} chars`);
          text += contResult.text;
          fullText = text;
          streamStarted = contResult.streamStarted;
          // Layer-2: Check if the continuation itself is still truncated
          if (detectTruncation(contResult.text)) {
            logger.info(`[${ts()}] [worker] [SELF-HEAL] Continuation also truncated — appending hint`);
            text += "\n\n---\n> ⚠️ 内容较长，回复已分段。如需继续，请发送「继续」。";
          }
        } else {
          logger.info(`[${ts()}] [worker] [SELF-HEAL] All continuation attempts failed, adding truncation warning`);
          text += "\n\n---\n> \u26A0\uFE0F 回复可能被截断。如需完整内容，请发送「继续」。";
        }
      }

      // Append media images to text
      text = appendMediaToText(text || "", summary.mediaImages);

      // Long output handling (delegated to output-manager.mjs)
      text = handleLongOutput(text, msgId, sendEvent);

      const flushed = streamFilter.flush();
      text = cleanFinalText(text);
      // R22-fix: Strip orphan "NO" from final text (phantom agentic turn artifact)
      if (text && text.trim() === "NO") {
        logger.info(`[${ts()}] [worker] [R22-NOREPLY] Final text is just "NO" — suppressing phantom turn artifact`);
        text = "";
      }
      // Also strip leading "NO" followed by real content (turn concatenation artifact)
      if (text && /^NO\s/.test(text.trim()) && text.trim().length > 5) {
        const stripped = text.trim().replace(/^NO\s+/, "");
        logger.info(`[${ts()}] [worker] [R22-NOREPLY] Stripped leading "NO" from final text: "${text.substring(0, 30)}" → "${stripped.substring(0, 30)}"`);
        text = stripped;
      }
      // [R48-FIX2] Strip HEARTBEAT_OK/NOHEARTBEAT_OK phantom responses
      // These arrive split across deltas (HE+ART+BE+AT+_OK) bypassing per-delta cleanHeartbeat
      if (text) {
        const heartbeatCleaned = text.replace(/\bNO\s*HEARTBEAT_OK\b|\bHEARTBEAT_OK\b|\bNOHEARTBEAT_OK\b/gi, "").trim();
        if (heartbeatCleaned !== text.trim()) {
          logger.info(`[${ts()}] [worker] [R48-FIX2] Stripped heartbeat from final text: "${text.substring(0, 40)}" -> "${heartbeatCleaned.substring(0, 40)}"`);
          text = heartbeatCleaned;
        }
        if (!text.trim()) {
          logger.info(`[${ts()}] [worker] [R48-FIX2] Final text was only heartbeat - suppressing`);
          text = "";
        }
      }

      const { mode: _resMode, cleanText: _cleanText } = parseResponseMode(text);
      if (_resMode !== 'default') {
        logger.info(`[${ts()}] [worker] [Iter-U] responseMode=${_resMode}, stripping marker`);
        text = _cleanText;
      }

      // P0-FIX v14.0: resolved=true already set at function entry (line 288)
      // Send final events
      cleanup("completed");

      const processedText = rewriteWorkspacePaths(text);
      // [R51-FIX] Don't send stream_end with empty content — prevents empty bubbles on frontend
      if (streamStarted && processedText && processedText.trim().length > 0) {
        sendEvent(msgId, { type: "stream_end", id: streamId, content: processedText, model: options.routedModel || "deepseek/deepseek-v4-pro", provider: "rangerai", tokens: estimateTokens(text), responseMode: _resMode });
      } else if (streamStarted && (!processedText || processedText.trim().length === 0)) {
        // [R51-FIX] Stream was started but no content — send stream_end with empty to properly close stream
        logger.info(`[${ts()}] [worker] [R51-FIX] stream_end with empty content — sending minimal close event`);
        sendEvent(msgId, { type: "stream_end", id: streamId, content: "", model: options.routedModel || "deepseek/deepseek-v4-pro", provider: "rangerai", tokens: 0 });
      } else if (text) {
        sendEvent(msgId, { type: "message_done", content: processedText, model: options.routedModel || "deepseek/deepseek-v4-pro", provider: "rangerai", tokens: estimateTokens(text), responseMode: _resMode });
      }

      updateStep(msgId, thinkStepId, "completed", text.length > 0 ? `${text.length} 字` : "已完成");
      sendEvent(msgId, { type: "status", status: "idle" });
      sendEvent(msgId, { type: "stats", toolCalls: summary.toolCount, tokens: estimateTokens(text) });
      try {
        const finalPlan = getSerializablePlan(msgId);
        if (finalPlan) {
          sendEvent(msgId, { type: "plan_completed", plan: finalPlan });
          logger.info(`[${ts()}] [worker] [task-planner] Plan completed: ${finalPlan.completedPhases}/${finalPlan.totalPhases} phases`);
        }
        cleanupPlan(msgId);
      } catch (planErr) {
        logger.info(`[${ts()}] [worker] [task-planner] Cleanup error: ${planErr.message}`);
      }
      logger.info(`[${ts()}] [worker] [F15-DEBUG] Final stats: text.length=${text.length}, estimateTokens=${estimateTokens(text)}`);
      logger.info(`[${ts()}] [worker] ${orchestrator.getSummaryString()}`);
      ctxMgr.trackAssistantResponse(text);
      logger.info(`[${ts()}] [worker] ${ctxMgr.getSummaryString()}`);
      const ctxStats = ctxMgr.getStats();
      sendEvent(msgId, { type: "context_stats", ...ctxStats });
      const orchStats = orchestrator.getStats();
      if (orchStats.classificationCount > 0) {
        sendEvent(msgId, { type: "orchestrator_stats", ...orchStats });
      }
      const toolSequence = orchestrator.getClassificationHistory().map(c => ({ name: c.toolName, class: c.safetyClass }));
      if (toolSequence.length >= 3) {
        recordTaskPattern(userMessage, toolSequence, true, sessionKey).catch(() => {});
      }
      getAdaptiveMemoryStats().then(amStats => {
        if (amStats) {
          logger.info(`[${ts()}] [worker] [adaptive-mem] tool_exp=${amStats.adaptive_tool_experience?.count || 0} | facts=${amStats.adaptive_fact_knowledge?.count || 0} | patterns=${amStats.adaptive_task_pattern?.count || 0}`);
          logger.info(`[${ts()}] [worker] [R58-diag] session-summary: orchToolIdMap.size=${orchToolIdMap.size}, toolStartTimes.size=${toolStartTimes.size}, toolIdMap.size=${toolIdMap.size}, orchNameStacks=${JSON.stringify([...orchNameStacks.entries()].map(([k,v])=>[k,v.length]))}`);
          sendEvent(msgId, { type: "adaptive_memory_stats", ...amStats });
        }
      }).catch(() => {});
      cleanupExpired().catch(() => {});
      // Iter-AK: KV-Cache 命中率周期性汇报（每次任务完成时输出）
      try {
        const { getKVCacheStats } = await import('./kv-cache-monitor.mjs');
        const kvStats = getKVCacheStats();
        // getKVCacheStats returns { shortKey: {...} }, not { sessions: [...] }
        const shortKey = (sessionKey || '').substring(0, 12) + '...';
        const sessStats = kvStats[shortKey];
        if (sessStats) {
          logger.info(`[${ts()}] [kv-cache-monitor] [Iter-AK] session=${sessionKey} hitRate=${sessStats.hitRate} totalCalls=${sessStats.totalCount} stablePrefix=${sessStats.stablePrefix}`);
        }
      } catch(err) { logger.warn(`[${ts()}] [kv-cache-monitor] Failed: ${err.message}`); }
      // F33: Gateway usage (delegated to usage-tracker.mjs)
      if (!gatewayUsage && sessionKey) {
        gatewayUsage = await extractGatewayUsage(sessionKey);
      }
      // [R28-T1] KV-Cache efficiency logging
      if (gatewayUsage) {
        const cR = gatewayUsage.cacheRead || 0;
        const cW = gatewayUsage.cacheWrite || 0;
        const inp = gatewayUsage.input || 0;
        const totalInput = cR + cW + inp;
        const cacheHitPct = totalInput > 0 ? ((cR / totalInput) * 100).toFixed(1) : '0.0';
        logger.info(`[${ts()}] [worker] [R28-T1] KV-Cache: cacheRead=${cR}, cacheWrite=${cW}, input=${inp}, hitRate=${cacheHitPct}%, total=${gatewayUsage.totalTokens || 0}`);
        // Emit cache efficiency event for observability
        try {
          const { emitEvent } = await import('./event-stream.mjs');
          emitEvent(sessionKey, msgId, 'kv_cache_stats', { cacheRead: cR, cacheWrite: cW, input: inp, hitRate: parseFloat(cacheHitPct), totalTokens: gatewayUsage.totalTokens || 0 });
        } catch(err) { logger.warn(`[${ts()}] [worker] emitEvent kv_cache_stats failed: ${err.message}`); }
      }

      // [R50-T1] Token Cost Tracking
      if (gatewayUsage) {
        try {
          const { trackTokenUsage } = await import('./token-cost-tracker.mjs');
          // [R50-T1-FIX] 从 planner 读取 taskFamily，确保非 unknown
          const _tcPlan = _agentLoopModules?.pl?.getPlan?.(msgId);
          const _tcFamily = _tcPlan?.taskFamily || options.taskFamily || 'non_web';
          const _tcTurnIdx = tracker?.toolCount || options.turnIndex || 0;
          await trackTokenUsage({
            taskId:     options.taskId     || msgId,
            chatId:     options.chatId     || null,
            sessionKey: sessionKey         || null,
            model:      options.routedModel || options.model || 'deepseek/deepseek-v4-pro',
            taskFamily: _tcFamily,
            turnIndex:  _tcTurnIdx,
            usage:      gatewayUsage,
            toolCount:  (tracker?.toolCount || options.toolCallCount || 0),
            isRetry:    (options.isRetry || false),
          });
        } catch (_trackErr) {
          // 追踪失败不影响主流程
        }
      }

      // Gateway doesn't accept 'auto' as model ID — it interprets it as 'provider/auto'
      // which is not a valid model. Use the agent's default model (deepseek-v4-pro) instead.
      if (routeModelPatched) {
        try {
          await gateway.request("sessions.patch", {
            key: gatewaySessionKey,
            model: 'deepseek/deepseek-v4-pro'  // [Iter-66b] Restore to actual Gateway default
          });
          logger.info(`[${ts()}] [worker] [v25.2] routedModel restored to deepseek/deepseek-v4-pro after completion`);
        } catch (restoreErr) {
          logger.warn(`[${ts()}] [worker] [v25.2] routedModel restore failed: ${restoreErr.message}`);
        }
      }

      // are now tracked by routeModelPatched, restored in the block above

      // R53 Task 3: Plan A/B success rate monitoring
      if (planABResult) {
        const outcome = resolved ? "success" : "error";
        logger.info(`[${ts()}] [worker] [PLAN_AB_MONITOR] plan=${planABResult.plan} model=${planABResult.model} session=${planABResult.session} outcome=${outcome} toolCount=${tracker.toolCount} textLen=${text?.length || 0}`);
      }
      // ─── Agent Loop: Emit FINAL_ANSWER event ───
      if (_agentLoopModules) {
        try {
          const { emitEvent, EVENT_TYPES } = _agentLoopModules.es;
          
      // [R43-T6] Quality scoring for final_answer
      const _r43QualityScore = (() => {
        const _text = text || "";
        const _len = _text.length;
        // Completeness: based on content richness
        let _completeness = 0;
        if (_len > 50) _completeness += 0.2;
        if (_len > 200) _completeness += 0.2;
        if (_len > 500) _completeness += 0.15;
        if (_len > 1000) _completeness += 0.1;
        if (_len > 2000) _completeness += 0.05;
        // Structural markers: lists, tables, headers, code blocks
        if (/\n[-*]\s/.test(_text)) _completeness += 0.1; // bullet lists
        if (/\|.*\|/.test(_text)) _completeness += 0.1; // tables
        if (/^#{1,3}\s/m.test(_text)) _completeness += 0.05; // headers
        if (/```/.test(_text)) _completeness += 0.05; // code blocks
        _completeness = Math.min(1, Math.round(_completeness * 100) / 100);
        // Confidence: based on tool usage and task completion signals
        let _confidence = 0.5; // base confidence
        const _tc = tracker.toolCount || 0;
        if (_tc > 0) _confidence += 0.15; // used tools
        if (_tc > 3) _confidence += 0.1; // used multiple tools
        if (_tc > 6) _confidence += 0.05; // extensive tool usage
        // Check for error/uncertainty language
        const _uncertainWords = ['不确定', '可能', 'might', 'perhaps', 'not sure', '无法确认'];
        const _hasUncertainty = _uncertainWords.some(w => _text.toLowerCase().includes(w));
        if (_hasUncertainty) _confidence -= 0.1;
        // Check for citations/references
        if (/\[\d+\]/.test(_text)) _confidence += 0.1; // numbered citations
        if (/https?:\/\//.test(_text)) _confidence += 0.05; // URLs
        _confidence = Math.min(1, Math.max(0, Math.round(_confidence * 100) / 100));
        return { completeness: _completeness, confidence: _confidence };
      })();

          emitEvent(sessionKey, msgId, EVENT_TYPES.FINAL_ANSWER, {
            content: text || "",
            toolCount: tracker.toolCount,
            completeness: _r43QualityScore.completeness,
            confidence: _r43QualityScore.confidence,
          });
          // [R43-T2] Emit plan_completed before clearing plan
          try {
            const _r43Plan = _agentLoopModules.pl.getPlan(msgId);
            if (_r43Plan && _r43Plan.steps && _r43Plan.steps.length > 0) {
              const _r43DoneCount = _r43Plan.steps.filter(s => s.status === 'done').length;
              const _r43FailedCount = _r43Plan.steps.filter(s => s.status === 'failed').length;
              const _r43SuccessRate = _r43Plan.steps.length > 0 ? _r43DoneCount / _r43Plan.steps.length : 0;
              const _r43StartTime = _r43Plan.createdAt || _r43Plan.startedAt || 0;
              const _r43Duration = _r43StartTime ? Date.now() - _r43StartTime : 0;
              emitEvent(sessionKey, msgId, EVENT_TYPES.PLAN_COMPLETED, {
                planId: msgId,
                totalSteps: _r43Plan.steps.length,
                doneSteps: _r43DoneCount,
                failedSteps: _r43FailedCount,
                skippedSteps: _r43Plan.steps.length - _r43DoneCount - _r43FailedCount,
                duration: _r43Duration,
                successRate: Math.round(_r43SuccessRate * 100) / 100,
                plan_version: _r43Plan.plan_version || _r43Plan.version || 1,
                completionTrigger: 'final_answer',
                steps: _r43Plan.steps.map((s, i) => ({
                  id: parseInt(s.id) || (i + 1),
                  desc: s.title || s.description || 'Step ' + (i + 1),
                  status: s.status,
                  tools: s.tools || []
                }))
              });
              logger.info(`[${ts()}] [R43-T2] plan_completed emitted at final_answer: planId=${msgId} steps=${_r43Plan.steps.length} done=${_r43DoneCount} successRate=${_r43SuccessRate}`);
            }
          } catch (_e43pc) {
            logger.info(`[${ts()}] [R43-T2] plan_completed at final_answer error: ${_e43pc.message}`);
          }
          _agentLoopModules.pl.clearPlan(msgId);
        } catch(err) { logger.warn(`[${ts()}] [worker] clearPlan failed for msgId=${msgId}: ${err.message}`); }
      }
      scheduleTaskCleanup(msgId); // R7 Task 5: Schedule cleanup after 5 minutes
      resolve({ text, gatewayUsage, thinkingReceived, responseMode: _resMode || 'default' }); // Iter-U
    }

    function finishError(errMsg) {
      if (resolved) return;
      // R7 Task 1: Atomic finalizeOnce guard with reason tracking
      if (!finalizeOnce(msgId, 'finishError')) {
        logger.warn(`[${ts()}] [R7-stream] finishError blocked by finalizeOnce for task=${msgId}`);
        return;
      }
      resolved = true;
      markStreamEvent(msgId, 'aborted');
      clearInterval(heartbeatTimer); // P0-FIX: Stop heartbeat immediately when resolved
      clearAllInterventionTimers();
      gateway.offRunEvents(runId);
      cleanup("error");
      // BUG-1 FIX: Restore model on error path (same as finishSuccess restore block)
      if (routeModelPatched) {
        gateway.request("sessions.patch", {
          key: gatewaySessionKey,
          model: 'deepseek/deepseek-v4-pro'  // [Iter-66b] Restore to actual Gateway default
        }).then(() => {
          logger.info(`[${ts()}] [worker] [BUG1-FIX] routedModel restored after finishError`);
        }).catch(err => {
          logger.warn(`[${ts()}] [worker] [BUG1-FIX] routedModel restore failed in finishError: ${err.message}`);
        });
      }

      if (fullText.length > 100) {
        const processedText = rewriteWorkspacePaths(fullText);
        if (streamStarted) {
          sendEvent(msgId, { type: "stream_end", id: streamId, content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(fullText) });
        }
        updateStep(msgId, thinkStepId, "completed", `${fullText.length} 字 (部分)`);
        sendEvent(msgId, { type: "status", status: "idle" });
        resolve({ text: fullText, gatewayUsage, thinkingReceived });
      } else {
        // FIX: Always send error event to frontend so it can exit streaming state
        if (streamStarted) {
          sendEvent(msgId, { type: "stream_end", id: streamId, content: rewriteWorkspacePaths(fullText || ""), model: "RangerAI", provider: "rangerai" });
        }
        sendEvent(msgId, { type: "error", message: sanitizeForFrontend(errMsg).substring(0, 200) });
        sendEvent(msgId, { type: "status", status: "idle" });
        updateStep(msgId, thinkStepId, "error", sanitizeForFrontend(errMsg).substring(0, 80));
        scheduleTaskCleanup(msgId); // R7 Task 5: Schedule cleanup after 5 minutes
        reject(new Error(errMsg));
      }
    }

    // ─── Event handler ───
    gateway.onRunEvents(runId, async (msg) => {
      const p = msg.payload;
      const stream = p.stream;
      const data = p.data;
      resetTimeout();
      lastActivityAt = Date.now(); // [R51-FIX] Track activity
      logger.info(`[${ts()}] [worker] [DEBUG] Event received: event=${msg.event} stream=${stream} phase=${data?.phase} state=${p?.state} runId=${p?.runId}`);
      if (stream === "tool" || (p && p.stream === "tool")) logger.info(`[${ts()}] [worker] [STREAM-CHECK] stream=${JSON.stringify(stream)} p.stream=${JSON.stringify(p?.stream)} typeof=${typeof stream} event=${msg.event} data.name=${data?.name} data.phase=${data?.phase}`);

      if (msg.event === "agent") {
        // ─── Lifecycle events ───
        if (stream === "lifecycle") {
          if (ghostFinalTimer) {
            clearTimeout(ghostFinalTimer);
            ghostFinalTimer = null;
            logger.info(`[${ts()}] [worker] [v7.0] Real lifecycle event received. Ghost final timer cancelled.`);
          }
          // v25.21-FIX3: Track agentic loop turns
          if (data.phase === "start") {
            agenticTurnCount++;
            logger.info(`[${ts()}] [worker] [v25.21-AGENTIC] lifecycle:start turn #${agenticTurnCount}`);
            // Cancel any pending chat:final finishSuccess — Gateway is continuing
            if (chatFinalDelayTimer) {
              clearTimeout(chatFinalDelayTimer);
              chatFinalDelayTimer = null;
              logger.info(`[${ts()}] [worker] [v25.21-AGENTIC] Cancelled pending finishSuccess — new turn started`);
            }
            // [R48-FIX] Cancel lifecycle safety timeout — new turn means the agent is still working
            if (lifecycleSafetyTimer) {
              clearTimeout(lifecycleSafetyTimer);
              lifecycleSafetyTimer = null;
              logger.info(`[${ts()}] [worker] [R48-FIX] Cancelled lifecycle safety timeout — new turn #${agenticTurnCount} started`);
            }
            // [R24-FIX] Cancel phantom chunk timer — new agentic turn means phantom text should be suppressed
            if (phantomChunkTimer) {
              clearTimeout(phantomChunkTimer);
              phantomChunkTimer = null;
              phantomChunkPending = null;
              logger.info(`[${ts()}] [worker] [R24-PHANTOM-GUARD] Cancelled phantom chunk — new agentic turn #${agenticTurnCount} started`);
            }
            // Reset lifecycleEnded since a new turn is starting
            lifecycleEnded = false;
          }
          if (data.phase === "end") {
            lifecycleEnded = true;
            logger.info(`[${ts()}] [worker] [CHECKPOINT] Lifecycle end: fullText=${fullText.length} chars, tools=${tracker.toolCount}, streamStarted=${streamStarted}`);
            // v25.21-FIX3: Don't start the 15s timeout if agentic loop might continue
            // Instead, let the chat:final handler manage the timing
            if (agenticTurnCount <= 1 && fullText.length < 20 && tracker.toolCount === 0) {
              logger.info(`[${ts()}] [worker] [v25.21-AGENTIC] lifecycle:end with short text — deferring to chat:final handler (agenticTurnCount=${agenticTurnCount})`);
              // [R51-FIX] Increased from 120s to 300s for complex agentic loops
              lifecycleSafetyTimer = setTimeout(() => { // [R48-FIX]
                if (!resolved) {
                  const idleTime = Date.now() - lastActivityAt;
                  if (idleTime < 60000) {
                    logger.info(`[${ts()}] [worker] [R51-FIX] Safety timer fired but activity was ${idleTime}ms ago — rescheduling`);
                    lifecycleSafetyTimer = setTimeout(() => {
                      if (!resolved) {
                        logger.info(`[${ts()}] [worker] [R51-FIX] Extended safety timeout after lifecycle:end. fullText=${fullText.length}, tools=${tracker.toolCount}`);
                        finishSuccess(fullText);
                      }
                    }, 120000);
                    return;
                  }
                  logger.info(`[${ts()}] [worker] [v25.21-AGENTIC] Safety timeout (300s) after lifecycle:end. fullText=${fullText.length}, tools=${tracker.toolCount}, idleTime=${idleTime}ms`);
                  finishSuccess(fullText);
                }
              }, 300000);
            } else {
              // [R51-FIX] Increased from 15s to 30s, with activity check
              lifecycleSafetyTimer = setTimeout(() => { // [R48-FIX]
                if (!resolved) {
                  const idleTime = Date.now() - lastActivityAt;
                  if (idleTime < 10000) {
                    logger.info(`[${ts()}] [worker] [R51-FIX] 30s safety timer fired but activity was ${idleTime}ms ago — extending 30s`);
                    lifecycleSafetyTimer = setTimeout(() => {
                      if (!resolved) {
                        logger.info(`[${ts()}] [worker] [R51-FIX] Extended safety timeout. fullText=${fullText.length}, tools=${tracker.toolCount}`);
                        finishSuccess(fullText);
                      }
                    }, 30000);
                    return;
                  }
                  logger.info(`[${ts()}] [worker] [CHECKPOINT] chat:final not received within 30s after lifecycle:end. fullText=${fullText.length}, tools=${tracker.toolCount}, idleTime=${idleTime}ms`);
                  finishSuccess(fullText);
                }
              }, 30000);
            }
          }
          if (data.phase === "error" || data.phase === "failed") {
            const errMsg = data.error || data.message || "Agent error";
            // [Iter-66] Diagnose failure type and recovery strategy
            const diagnosis = diagnoseFailure(errMsg, data.name || 'agent', { attempts: 0 });
            logger.info(`[${ts()}] [worker] [R68-FIX] Lifecycle error: ${errMsg}. type=${diagnosis.failureType} recovery=${diagnosis.recovery.action} severity=${diagnosis.recovery.severity} fullText=${fullText.length}, tools=${tracker.toolCount}, resolved=${resolved}`);
            if (resolved) {
              logger.info(`[${ts()}] [worker] [R68-FIX] Already resolved — ignoring lifecycle error`);
            } else if (fullText && fullText.trim().length > 50) {
              // We have substantial content — save it instead of discarding
              logger.info(`[${ts()}] [worker] [R68-FIX] Provider error but have ${fullText.length} chars of content — saving with finishSuccess`);
              finishSuccess(fullText);
            } else if (tracker.toolCount > 0) {
              // Tools ran but no text yet — generate a summary instead of losing everything
              logger.info(`[${ts()}] [worker] [R68-FIX] Provider error with ${tracker.toolCount} tools but minimal text — saving tool summary`);
              const toolSummary = `任务执行了 ${tracker.toolCount} 个操作后遇到临时错误 (${errMsg})。已完成的操作结果已保存。`;
              finishSuccess(fullText ? fullText + "\n\n" + toolSummary : toolSummary);
            } else {
              // Nothing to save — this is a genuine early failure, trigger retry
              logger.info(`[${ts()}] [worker] [R68-FIX] Provider error with no content — finishError to trigger retry`);
              finishError(`terminated: ${errMsg}`);
            }
          }
          // [R67-FIX] Handle lifecycle fallback — Gateway is switching models (NOT terminating)
          // Previously R49-FIX would call finishError when fullText was empty during fallback,
          // but this kills the task prematurely. Model fallback is NORMAL behavior.
          if (data.phase === "fallback") {
            logger.info(`[${ts()}] [worker] [R67-FIX] Lifecycle FALLBACK received. fullText=${fullText.length}, tools=${tracker.toolCount}`);
            if (!resolved) {
              if (fullText && fullText.trim().length > 100) {
                // Only save if we have substantial content
                logger.info(`[${ts()}] [worker] [R67-FIX] Fallback with existing text (${fullText.length} chars) — saving partial response`);
                finishSuccess(fullText);
              } else {
                // DON'T finishError! The fallback model will produce output.
                // Just log and let the event stream continue.
                logger.info(`[${ts()}] [worker] [R67-FIX] Fallback with no/minimal content — WAITING for fallback model output (not terminating)`);
                // Reset timeout to give the fallback model time to respond
                resetTimeout();
              }
            }
          }
        }

        // ─── Text stream events ───
        if (stream === "text" || stream === "assistant") {
          const delta = data.delta || "";
          logger.info(`[${ts()}] [worker] [DELTA-DIAG] stream=${stream} delta_len=${delta.length} delta_preview="${delta.substring(0, 80)}" fullText_len=${fullText.length}`);
          if (resolved) {
            logger.info(`[${ts()}] [worker] [v23.0] Skipping late delta (${delta.length} chars) — already resolved`);
            return;
          }
          if (delta) {
            if (!streamStarted) {
              streamStarted = true;
              if (ghostFinalTimer) {
                clearTimeout(ghostFinalTimer);
                ghostFinalTimer = null;
                logger.info(`[${ts()}] [worker] [v7.0] Real text stream started. Ghost final timer cancelled.`);
              }
              sendEvent(msgId, { type: "stream_start", id: streamId, provider: "rangerai", model: "RangerAI" });
              updateStep(msgId, thinkStepId, "running", "正在生成回复...");
            }
            const cleanDelta = cleanHeartbeat(delta).replace(/\|$/, "");
            if (cleanDelta) {
              // ─── R22-fix: NO_REPLY split detection ───
              // When LLM outputs "NO_REPLY", Gateway may split it into delta="NO" + delta="_REPLY".
              // Or LLM outputs just "NO" as a phantom first agentic turn.
              // Buffer short first deltas that look like NO_REPLY prefixes.
              // [R24-FIX] Enhanced NO suppression with debug logging
              const trimmedDelta = cleanDelta.trim();
              const CONTROL_PHANTOM_PREFIXES = ["NO_REPLY", "HEARTBEAT_OK", "NOHEARTBEAT_OK", "NO HEARTBEAT_OK"];
              const bufferedCandidate = fullText.length === 0 ? `${noReplyBuffered || ""}${cleanDelta}` : "";
              const isControlPhantomPrefix = bufferedCandidate && CONTROL_PHANTOM_PREFIXES.some((token) => token.startsWith(bufferedCandidate));
              const isControlPhantomComplete = bufferedCandidate && CONTROL_PHANTOM_PREFIXES.includes(bufferedCandidate);
              if (isControlPhantomComplete) {
                logger.info(`[${ts()}] [worker] [R61-PHANTOM] Suppressing complete control phantom: "${bufferedCandidate}"`);
                noReplyBuffered = null;
                if (noReplyTimer) { clearTimeout(noReplyTimer); noReplyTimer = null; }
                return;
              }
              if (isControlPhantomPrefix) {
                noReplyBuffered = bufferedCandidate;
                logger.info(`[${ts()}] [worker] [R61-PHANTOM] Buffering control phantom prefix: "${noReplyBuffered}"`);
                if (noReplyTimer) clearTimeout(noReplyTimer);
                noReplyTimer = setTimeout(() => {
                  if (noReplyBuffered) {
                    logger.info(`[${ts()}] [worker] [R61-PHANTOM] Timer expired, suppressing orphan control prefix "${noReplyBuffered.trim()}"`);
                    noReplyBuffered = null;
                  }
                  noReplyTimer = null;
                }, 2000);
                return;
              }
              const isNoReplyPrefix = fullText.length === 0 && trimmedDelta === "NO";
              const isNoReplySuffix = noReplyBuffered && (trimmedDelta === "_REPLY" || trimmedDelta.startsWith("_REPLY") || trimmedDelta.startsWith("_REP"));
              // [R24-DEBUG] Log the exact values being checked
              if (fullText.length === 0 && cleanDelta.length <= 5) {
                logger.info(`[${ts()}] [worker] [R24-NOREPLY-DEBUG] fullText.length=${fullText.length} cleanDelta="${cleanDelta}" trimmed="${trimmedDelta}" isNoReplyPrefix=${isNoReplyPrefix} charCodes=${[...trimmedDelta].map(c => c.charCodeAt(0))}`);
              }
              
              // [R24-FIX] Broader phantom suppression: catch any short single-word first delta
              // that looks like a phantom agentic turn artifact (NO, OK, YES, etc.)
              const PHANTOM_WORDS = new Set(["NO", "OK", "YES", "NO_REPLY", "HEARTBEAT", "HEARTBEAT_OK", "N", "Y"]);
              const isPhantomFirstDelta = fullText.length === 0 && trimmedDelta.length <= 12 && PHANTOM_WORDS.has(trimmedDelta.toUpperCase());
              
              if (isNoReplyPrefix || isPhantomFirstDelta) {
                noReplyBuffered = cleanDelta;
                logger.info(`[${ts()}] [worker] [R24-NOREPLY] Buffering potential phantom first delta: "${cleanDelta}" (isNoReplyPrefix=${isNoReplyPrefix}, isPhantom=${isPhantomFirstDelta})`);
                if (noReplyTimer) clearTimeout(noReplyTimer);
                noReplyTimer = setTimeout(() => {
                  if (noReplyBuffered) {
                    logger.info(`[${ts()}] [worker] [R24-NOREPLY] Timer expired, suppressing orphan "${noReplyBuffered.trim()}" (likely phantom turn)`);
                    // Don't flush — suppress the orphan entirely
                    // The real content will come in the next agentic turn
                    noReplyBuffered = null;
                  }
                  noReplyTimer = null;
                }, 2000); // [R24-FIX] Extended from 800ms to 2000ms for slower LLM reasoning
                return; // Don't process this delta yet
              }
              
              if (isNoReplySuffix) {
                logger.info(`[${ts()}] [worker] [R22-NOREPLY] Detected NO_REPLY split: buffered="${noReplyBuffered}" + current="${cleanDelta.trim()}". Suppressing both.`);
                noReplyBuffered = null;
                if (noReplyTimer) { clearTimeout(noReplyTimer); noReplyTimer = null; }
                return; // Suppress both parts
              }
              
              // If we had a buffered "NO" but next delta is NOT "_REPLY", flush buffer first
              if (noReplyBuffered) {
                logger.info(`[${ts()}] [worker] [R22-NOREPLY] Flushing buffer (next delta is not _REPLY): "${noReplyBuffered}"`);
                const bufferedFiltered = streamFilter.filter(noReplyBuffered);
                fullText += noReplyBuffered;
                if (bufferedFiltered) {
                  sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(bufferedFiltered) });
                }
                noReplyBuffered = null;
                if (noReplyTimer) { clearTimeout(noReplyTimer); noReplyTimer = null; }
              }
              // ─── End R22-fix ───
              
              // ─── v3.10: Filter technical content before sending to frontend ───
              const filteredDelta = streamFilter.filter(cleanDelta);
              fullText += cleanDelta; // fullText keeps everything for self-heal/summary
              lastChunkAt = Date.now();
              // ─── v11.0: Task Plan Parsing ───
              try {
                processTextForPlan(msgId, fullText, cleanDelta, sessionKey);
              } catch (planErr) {
                logger.info(`[${ts()}] [worker] [task-planner] Error: ${planErr.message}`);
              }
              // ─── GUARDRAIL-PROGRESS: Reset counter when AI outputs text ───
              toolsSinceLastText = 0;
              lastTextOutputAt = Date.now();
              logger.info(`[${ts()}] [worker] [DELTA-SEND] cleanDelta_len=${cleanDelta.length} filtered_len=${filteredDelta.length} cleanDelta_preview="${cleanDelta.substring(0, 80)}" total_fullText=${fullText.length}`);

              if (filteredDelta) {
                // [R24-FIX] Second safety net: delay sending very short first chunks
                // that could be phantom agentic turn artifacts (NO, OK, YES, etc.)
                const _PHANTOM_RE = /^(NO|OK|YES|N|Y|NO_REPLY|HEARTBEAT|HEARTBEAT_OK|NOHEARTBEAT_OK)$/i;
                if (fullText.length <= 15 && _PHANTOM_RE.test(fullText.trim())) {
                  logger.info(`[${ts()}] [worker] [R24-PHANTOM-GUARD] Delaying short first chunk: "${fullText.trim()}" (${fullText.length} chars)`);
                  // Don't send yet — wait 2s to see if tools follow
                  phantomChunkPending = filteredDelta;
                  if (phantomChunkTimer) clearTimeout(phantomChunkTimer);
                  phantomChunkTimer = setTimeout(() => {
                    // If we get here, no tools/new turn started within 2s — send the chunk
                    if (!resolved && phantomChunkPending) {
                      logger.info(`[${ts()}] [worker] [R24-PHANTOM-GUARD] Timer expired, flushing delayed chunk: "${phantomChunkPending}"`);
                      sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(phantomChunkPending) });
                    }
                    phantomChunkPending = null;
                    phantomChunkTimer = null;
                  }, 2000);
                } else {
                  // [R24-FIX] If we have a pending phantom chunk and now real content arrives, flush it first
                  if (phantomChunkTimer) {
                    clearTimeout(phantomChunkTimer);
                    phantomChunkTimer = null;
                    if (phantomChunkPending) {
                      logger.info(`[${ts()}] [worker] [R61-PHANTOM] Real content followed delayed chunk, flushing pending chunk first: "${phantomChunkPending}"`);
                      sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(phantomChunkPending) });
                      phantomChunkPending = null;
                    }
                  }
                  sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(filteredDelta) });
                }
              }
            }
          }
        }

        // ─── Tool events (delegated to ToolTracker) ───
        if (stream === "tool") {
          logger.info(`[${ts()}] [worker] [TOOL-DIAG] stream=tool entered: toolName=${data?.name}, phase=${data?.phase}, dataKeys=${JSON.stringify(Object.keys(data || {}))}`);
          const toolName = data.name || "unknown";

            if (data.phase === "start") {
            if (toolName === "browser") {
              logger.info(`[${ts()}] [worker] [v10.3-DUMP] Browser tool_START data keys: ${JSON.stringify(Object.keys(data))}`);
              for (const k of Object.keys(data)) {
                const v = data[k];
                const vStr = typeof v === "string" ? v : JSON.stringify(v);
                logger.info(`[${ts()}] [worker] [v10.3-DUMP] START data.${k}: ${(vStr || "").substring(0, 300)}`);
              }
            }
            // v25.21-FIX3: Tool starting means agentic loop is active — cancel pending finishSuccess
            if (chatFinalDelayTimer) {
              clearTimeout(chatFinalDelayTimer);
              chatFinalDelayTimer = null;
              logger.info(`[${ts()}] [worker] [v25.21-AGENTIC] Cancelled pending finishSuccess — tool ${toolName} starting`);
            }
            // [R48-FIX] Cancel lifecycle safety timeout — tool execution means agent is still working
            if (lifecycleSafetyTimer) {
              clearTimeout(lifecycleSafetyTimer);
              lifecycleSafetyTimer = null;
              logger.info(`[${ts()}] [worker] [R48-FIX] Cancelled lifecycle safety timeout — tool ${toolName} starting`);
            }
            // [R24-FIX] Cancel phantom chunk timer — tools are running, suppress the phantom text
            if (phantomChunkTimer) {
              clearTimeout(phantomChunkTimer);
              phantomChunkTimer = null;
              phantomChunkPending = null;
              logger.info(`[${ts()}] [worker] [R24-PHANTOM-GUARD] Cancelled phantom chunk — tool ${toolName} starting (phantom text suppressed)`);
            }
            const result = tracker.handleToolStart(toolName, data);
            const toolArgs = data.args || data.input || data.arguments || "";
            const orchToolId = data.id || `orch-${streamId}-${tracker.toolCount}`;
            const toolExpKey = data.id || `texp-${streamId}-${tracker.toolCount}`;
            toolStartTimes.set(toolExpKey, { startTime: Date.now(), toolName });
            recordInterventionToolStart(toolExpKey, toolName, toolArgs);
            // Fire async acquireExecution — if blocked, send tool_blocked event
            orchToolIdMap.set(orchToolId, orchToolId);
            if (data.id) orchToolIdMap.set(data.id, orchToolId);
            // BUG-2 FIX: Use dedicated orchNameStacks / tstNameStacks instead of Map instance properties
            if (!orchNameStacks.has(toolName)) orchNameStacks.set(toolName, []);
            orchNameStacks.get(toolName).push(orchToolId);
            if (!tstNameStacks.has(toolName)) tstNameStacks.set(toolName, []);
            tstNameStacks.get(toolName).push(toolExpKey);

            // [R41-T1-v2] Cache browser args at tool_start — Gateway only sends start+result, no update/progress
            if (toolName === "browser") {
              try {
                const _r41BrStartArgs = data.args || data.input || data.arguments || {};
                const _r41BrArgsObj = typeof _r41BrStartArgs === "string" ? (() => { try { return JSON.parse(_r41BrStartArgs); } catch(e) { return {}; } })() : (_r41BrStartArgs || {});
                // Write under multiple keys for reliable lookup in tool_end
                _r38BrowserArgsCache.set(toolExpKey, _r41BrArgsObj);
                if (data.id) _r38BrowserArgsCache.set(data.id, _r41BrArgsObj);
                _r38BrowserArgsCache.set(`br-${msgId}`, _r41BrArgsObj);
                logger.info(`[${ts()}] [R41-T1-v2] Browser args cached at START: toolExpKey=${toolExpKey}, dataId=${data.id}, argsKeys=${Object.keys(_r41BrArgsObj).join(',')}, action=${_r41BrArgsObj.action || 'none'}`);
              } catch(_brCacheErr) {
                logger.error(`[${ts()}] [R41-T1-v2] Browser args cache error: ${_brCacheErr.message}`);
              }
            }
            logger.info(`[${ts()}] [worker] [R58-diag] tool_start: name=${toolName}, normalized=${normalizeToolName(toolName)}, data.id=${data.id}, orchToolId=${orchToolId}, toolExpKey=${toolExpKey}, orchMap=${orchToolIdMap.size}, tsTimes=${toolStartTimes.size}`);
            // ─── Agent Loop: Emit ACTION event for tool call ───
            if (_agentLoopModules) {
              try {
                const { emitEvent, emitLedgerEvent, EVENT_TYPES } = _agentLoopModules.es;
                const _curStep = _agentLoopModules.pl?.getCurrentStep?.(msgId) || null;
                const _curPlan = _agentLoopModules.pl?.getPlan?.(msgId) || null;
                const _actionId = data.id || toolExpKey || `action-${msgId}-${tracker.toolCount}`;
                const _actionPayload = {
                  taskId,
                  runId,
                  planId: _curPlan?.planId || _curPlan?.id || msgId,
                  stepId: _curStep?.id || _curStep?.stepId || null,
                  actionId: _actionId,
                  type: "tool_call",
                  tool: toolName,
                  args: (typeof toolArgs === "object" ? JSON.stringify(toolArgs) : String(toolArgs || "")).substring(0, 500),
                  reason: `Tool call #${tracker.toolCount}`,
                  expectedAction: _curStep?.expectedAction || _curStep?.action || null,
                  stepTitle: _curStep?.title || null,
                  diagnostic: !_curStep ? 'no_current_step_for_action' : undefined,
                };
                emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.ACTION_STARTED, _actionPayload, null, toolName);
                emitEvent(sessionKey, taskId, EVENT_TYPES.ACTION, _actionPayload, null, toolName);
                // [R2-Task3] Record action via executor (check both sources)
                const _activeExec = (_agentLoopModules && _agentLoopModules._executor) || getActiveExecutor();
                if (_activeExec) {
                  logger.info(`[${ts()}] [executor] Action: tool_call ${toolName} for step ${_curStep?.id || '-'}`);
                }
              } catch(err) { logger.warn(`[${ts()}] [executor] tool_call ${toolName} logging failed: ${err.message}`); }
            }
            // [R73 P0-1] dispatch() replaces fire-and-forget — orchestrator is now the dispatch spine
            let dispatchResult;
            try {
              dispatchResult = await orchestrator.dispatch(orchToolId, toolName, toolArgs);
            } catch (err) {
              logger.warn(`[${ts()}] [worker] [orchestrator] dispatch error: ${err.message}`);
              dispatchResult = { blocked: true, blockReason: `Dispatch error: ${err.message}`, safetyClass: 'error' };
            }
            if (dispatchResult.blocked) {
              logger.info(`[${ts()}] [worker] [orchestrator] ❌ BLOCKED: ${toolName} — ${dispatchResult.blockReason}`);
              sendEvent(msgId, { type: "tool_blocked", tool: toolName, reason: dispatchResult.blockReason, safetyClass: dispatchResult.safetyClass });
              // [R73 P0-1] Do not proceed with tool execution — orchestrator blocked it
              return;
            }
            toolsActiveCount++;
            resetTimeout(); // Extend timeout during tool execution
            // This prevents the frontend watchdog from triggering during long tool executions
            // R53 KV-Cache fix: Deterministic tool ID using counter instead of random values
            const toolId = data.id || `tool-${streamId}-${tracker.toolCount}`;
            if (data.id) toolIdMap.set(data.id, toolId); // FIX: store mapping for tool_end lookup
            // FIX v2: Also push to name-based stack for tools without data.id
            if (!toolNameIdStack.has(toolName)) toolNameIdStack.set(toolName, []);
            toolNameIdStack.get(toolName).push(toolId);
            const toolDesc = generateToolDescription(toolName, data.args || data.input || "");
            sendEvent(msgId, {
              type: "tool_start",
              id: toolId,
              tool: toolName,
              args: data.args || data.input || "",
              toolIndex: tracker.toolCount,
              title: data.title || toolName,
              description: toolDesc,
              ...(data.skill ? { skill: data.skill, skillLabel: data.skillLabel, skillCategory: data.skillCategory } : {}),
            });
            // [R37-T1] code_exec_started event for exec/code tools
            if ((toolName === "exec" || toolName === "code") && data.phase !== "done" && data.phase !== "failed") {
              try {
                const _codeArgs = data.args || data.input || {};
                const _codeStr = typeof _codeArgs === 'string' ? _codeArgs : (_codeArgs.code || _codeArgs.command || _codeArgs.cmd || JSON.stringify(_codeArgs));
                const _codeLang = _codeArgs.language || (toolName === "code" ? "auto" : "bash");
                emitEvent(sessionKey, msgId, "code_exec_started", {
                  tool: toolName,
                  language: _codeLang,
                  codePreview: String(_codeStr).substring(0, 200),
                  codeLength: String(_codeStr).length,
                });
                logger.info(`[${ts()}] [R37-T1] code_exec_started: tool=${toolName} lang=${_codeLang} codeLen=${String(_codeStr).length}`);
                sendStep(msgId, "💻 代码执行中", "running", `语言: ${_codeLang} | 代码: ${String(_codeStr).substring(0, 60)}...`);
                // [R38-T4] Start exec timeout timer
                const _execKey = `${msgId}:${toolId}`;
                const _execTimer = setTimeout(() => {
                  logger.warn(`[${ts()}] [R38-T4] EXEC TIMEOUT: ${_execKey} exceeded ${EXEC_TIMEOUT_MS}ms`);
                  try {
                    emitEvent(sessionKey, msgId, "sandbox_limit_exceeded", {
                      limitType: "cpu_timeout",
                      limitValue: EXEC_TIMEOUT_MS,
                      tool: toolName,
                      toolId,
                      language: _codeLang,
                      codePreview: String(_codeStr).substring(0, 100),
                    });
                  } catch (_e) { /* non-fatal */ }
                  sendStep(msgId, "⚠️ 执行超时", "warning", `代码执行超过 ${EXEC_TIMEOUT_MS/1000}s 限制`);
                }, EXEC_TIMEOUT_MS);
                _execTimers.set(_execKey, { timer: _execTimer, startMs: Date.now() });
              } catch (_ceErr) {
                logger.warn(`[${ts()}] [R37-T1] code_exec_started event error: ${_ceErr.message}`);
              }
            }


            // [R40-FIX4] Docker sandbox isolation for exec/code tools
            // Strategy: check if command needs host access FIRST, skip Docker entirely if so
            let _skipDockerSandbox = true; // [R47-FIX1] Always bypass Docker — agent commands need host access. Docker caused race condition with mutex, empty output, premature Gateway abort.
            if ((toolName === "exec" || toolName === "code") && data.phase !== "done" && data.phase !== "failed") {
              const _dkArgs_check = data.args || data.input || {};
              const _dkCmd_check = typeof _dkArgs_check === 'string' ? _dkArgs_check : (_dkArgs_check.command || _dkArgs_check.cmd || _dkArgs_check.code || JSON.stringify(_dkArgs_check));
              const _cmdLower = String(_dkCmd_check).toLowerCase();
              const _dkLang_check = _dkArgs_check.language || (toolName === "code" ? "python3" : "bash");
              
              // [R40-FIX4] Comprehensive bypass rules — Agent's own host commands skip Docker entirely
              const _needsHostAccess = (
                // File system access on host paths (Agent reading memory/config/logs)
                /\b(cat|head|tail|wc|grep|find|ls|stat|sed|awk|cp|mv|rm|mkdir|chmod|chown)\b/.test(_cmdLower) && /(\/home\/|\/opt\/|\/etc\/|\/var\/|\.openclaw)/.test(_cmdLower) ||
                // Network tools accessing local services (Agent checking health/API)
                /\b(curl|wget|nc|netcat)\b/.test(_cmdLower) && /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(_cmdLower) ||
                // System management (Agent checking services)
                /\b(systemctl|journalctl|service|docker)\b/.test(_cmdLower) ||
                // Database access on host
                /\b(sqlite3|mysql|psql)\b/.test(_cmdLower) ||
                // Package/process management
                /\b(apt|pip|npm|pnpm|ps|kill|df|du|free|uptime)\b/.test(_cmdLower) ||
                // Script execution on host paths
                /\b(bash|sh|node|python3?)\s+[\/\.]/.test(_cmdLower) ||
                // Internal API headers
                _cmdLower.includes("x-internal-call") ||
                // Host-specific path references
                _cmdLower.includes("/opt/rangerai") || _cmdLower.includes("/home/admin") || _cmdLower.includes(".openclaw") ||
                // Pipe chains reading host data
                (_cmdLower.includes("| head") || _cmdLower.includes("| tail") || _cmdLower.includes("| grep")) && /(\/home\/|\/opt\/|\/var\/)/.test(_cmdLower) ||
                // Any file read command with absolute path
                /\b(cat|head|tail|ls|stat|wc|sed)\s+\//.test(_cmdLower) ||
                // grep/find with -r flag on host paths
                /\b(grep|find)\b.*-r/.test(_cmdLower) && /(\/opt\/|\/home\/)/.test(_cmdLower)
              );
              
              if (_needsHostAccess) {
                _skipDockerSandbox = true;
                logger.info(`[${ts()}] [R40-FIX4] Bypassing Docker \u2014 command needs host access, letting Gateway handle: ${String(_dkCmd_check).substring(0, 120)}`);
                // [R40-FIX4b] Clear the exec timeout timer — bypass commands run on host via Gateway
                // which has its own timeout handling. Without this, the 10s timer fires falsely.
                const _bypassExecKey = `${msgId}:${toolId}`;
                if (_execTimers.has(_bypassExecKey)) {
                  clearTimeout(_execTimers.get(_bypassExecKey).timer);
                  _execTimers.delete(_bypassExecKey);
                  logger.info(`[${ts()}] [R40-FIX4b] Cleared exec timeout timer for bypassed command: ${_bypassExecKey}`);
                }
                // Emit host_bypass event for observability
                try {
                  emitEvent(sessionKey, msgId, "code_exec_started", {
                    tool: toolName,
                    language: _dkLang_check,
                    codePreview: String(_dkCmd_check).substring(0, 200),
                    codeLength: String(_dkCmd_check).length,
                    isolation: "host_bypass",
                  });
                } catch (_emitErr) { /* non-fatal */ }
              }
            }
            // Only run Docker sandbox if command does NOT need host access
            if (!_skipDockerSandbox && (toolName === "exec" || toolName === "code") && data.phase !== "done" && data.phase !== "failed") {
              try {
                const { execSync } = await import("child_process");
                const _dkArgs = data.args || data.input || {};
                const _dkCmd = typeof _dkArgs === 'string' ? _dkArgs : (_dkArgs.command || _dkArgs.cmd || _dkArgs.code || JSON.stringify(_dkArgs));
                const _dkLang = _dkArgs.language || (toolName === "code" ? "python3" : "bash");
                
                // Determine Docker command based on language
                let _dockerCmd;
                const _escapedCode = String(_dkCmd).replace(/'/g, "'\''");
                if (_dkLang === "python" || _dkLang === "python3" || _dkLang === "py") {
                  _dockerCmd = `docker run --rm --network none --memory=256m --cpus=0.5 --pids-limit=50 openclaw-sandbox:bookworm-enhanced timeout 10 python3 -c '${_escapedCode}'`;
                } else if (_dkLang === "node" || _dkLang === "javascript" || _dkLang === "js") {
                  _dockerCmd = `docker run --rm --network none --memory=256m --cpus=0.5 --pids-limit=50 openclaw-sandbox:bookworm-enhanced timeout 10 node -e '${_escapedCode}'`;
                } else {
                  // bash/shell
                  _dockerCmd = `docker run --rm --network none --memory=256m --cpus=0.5 --pids-limit=50 openclaw-sandbox:bookworm-enhanced timeout 10 bash -c '${_escapedCode}'`;
                }
                
                logger.info(`[${ts()}] [R39-T5] Docker sandbox exec: lang=${_dkLang} cmdLen=${String(_dkCmd).length}`);
                
                let _dkOutput, _dkExitCode = 0;
                try {
                  _dkOutput = execSync(_dockerCmd, { timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" });
                } catch (_dkExecErr) {
                  _dkOutput = (_dkExecErr.stdout || "") + (_dkExecErr.stderr || "");
                  _dkExitCode = _dkExecErr.status || 1;
                  if (_dkExecErr.killed || _dkExecErr.signal === "SIGTERM") {
                    _dkOutput += "\n[SANDBOX] Execution timed out (10s limit)";
                    emitEvent(sessionKey, msgId, "sandbox_limit_exceeded", {
                      limitType: "docker_timeout",
                      limitValue: 10000,
                      tool: toolName,
                      language: _dkLang,
                    });
                  }
                  if (_dkOutput.includes("OOM") || _dkOutput.includes("memory")) {
                    emitEvent(sessionKey, msgId, "sandbox_limit_exceeded", {
                      limitType: "memory_exceeded",
                      limitValue: "256m",
                      tool: toolName,
                      language: _dkLang,
                    });
                  }
                }
                
                const _dkResult = {
                  output: String(_dkOutput || "").substring(0, 8000),
                  exitCode: _dkExitCode,
                  sandbox: true,
                  isolation: "docker",
                  constraints: { network: "none", memory: "256m", cpu: "0.5", timeout: "10s" }
                };
                
                emitEvent(sessionKey, msgId, "code_exec_finished", {
                  tool: toolName,
                  language: _dkLang,
                  exitCode: _dkExitCode,
                  outputLength: String(_dkOutput || "").length,
                  sandbox: true,
                  isolation: "docker",
                });
                
                logger.info(`[${ts()}] [R39-T5] Docker sandbox result: exitCode=${_dkExitCode} outputLen=${String(_dkOutput || "").length}`);
                sendStep(msgId, _dkExitCode === 0 ? "✅ 沙箱执行完成" : "⚠️ 沙箱执行异常", _dkExitCode === 0 ? "success" : "warning",
                  `隔离: Docker | 输出: ${String(_dkOutput || "").substring(0, 100)}...`);
                
                // [R39-T5-FIX] Abort Gateway run and return Docker result directly
                // appendToolResult is not available in tool_start scope, so we use abort+finishSuccess
                try {
                  if (runId && gateway.isConnected) {
                    await gateway.request("chat.abort", { sessionKey, runId });
                    logger.info(`[${ts()}] [R39-T5] Gateway abort success after Docker exec`);
                  }
                } catch (_abortErr) {
                  logger.warn(`[${ts()}] [R39-T5] Gateway abort failed: ${_abortErr.message}`);
                }
                
                // Clear timeout timer
                const _dkTimerKey = `${msgId}:${toolId}`;
                if (_execTimers.has(_dkTimerKey)) {
                  clearTimeout(_execTimers.get(_dkTimerKey).timer);
                  _execTimers.delete(_dkTimerKey);
                }
                
                // Format output for user
                const _dkUserOutput = _dkExitCode === 0
                  ? `代码执行结果（Docker 沙箱隔离）:\n\n\`\`\`\n${String(_dkOutput || "(无输出)").substring(0, 4000)}\n\`\`\`\n\n[隔离环境: Docker | 网络: 禁用 | 内存: 256MB | 超时: 10s]`
                  : `代码执行异常（退出码: ${_dkExitCode}）:\n\n\`\`\`\n${String(_dkOutput || "(无输出)").substring(0, 4000)}\n\`\`\`\n\n[隔离环境: Docker | 网络: 禁用 | 内存: 256MB | 超时: 10s]`;
                
                abortController.abort();
                finishSuccess(_dkUserOutput);
                return; // Prevent Gateway from executing on host
              } catch (_dkErr) {
                logger.error(`[${ts()}] [R40-FIX4] Docker sandbox error: ${_dkErr.message}`);
                // Fall through to Gateway exec if Docker fails — this is intentional for Docker-only errors
              }
            }

            if (result.abort) {
              logger.info(`[${ts()}] [worker] [v9.1] Tool-tracker abort: ${result.reason}. Aborting Gateway run ${runId}...`);
              try {
                if (runId && gateway.isConnected) {
                  await gateway.request("chat.abort", { sessionKey, runId });
                  logger.info(`[${ts()}] [worker] [v9.1] Tool-tracker Gateway abort success`);
                }
              } catch (abortErr) {
                logger.info(`[${ts()}] [worker] [v9.1] Tool-tracker Gateway abort failed: ${abortErr.message}`);
              }
              abortController.abort();
              finishSuccess(fullText || result.fallbackText);
              return;
            }
          }

          if (data.phase === "update" || data.phase === "progress") {
            // P1: Enhanced browser tool event forwarding
            if (toolName === "browser") {
              // Extract structured browser action data
              const browserData = data.result || data.output || {};
              const screenshotUrl = browserData.screenshot || browserData.screenshotUrl || null;
              const currentUrl = browserData.url || browserData.currentUrl || '';
              const action = browserData.action || (data.args && typeof data.args === 'object' ? data.args.action : '') || '';
              
              // Forward structured browser event to frontend
              process.send({
                type: "browser_action",
                msgId,
                action: action,
                screenshot: screenshotUrl,
                url: currentUrl,
                toolName: toolName,
                args: data.args,
                timestamp: Date.now()
              });
              
              logger.info(`[${ts()}] [worker] [P1-BROWSER] action=${action}, url=${(currentUrl || '').substring(0, 80)}, screenshot=${screenshotUrl ? 'yes' : 'no'}`);
              // [R41-T1] Cache browser args for tool_end detail logging — write under MULTIPLE keys for reliable lookup
              try {
                const _r41BrArgs = data.args || data.input || {};
                // Key 1: data.id (if available from Gateway)
                if (data.id) _r38BrowserArgsCache.set(data.id, _r41BrArgs);
                // Key 2: toolExpKey format (matches toolStartTimes key used in tool_end)
                const _r41ToolExpKey = data.id || `texp-${streamId}-${tracker.toolCount}`;
                _r38BrowserArgsCache.set(_r41ToolExpKey, _r41BrArgs);
                // Key 3: msgId fallback
                _r38BrowserArgsCache.set(`br-${msgId}`, _r41BrArgs);
                logger.info(`[${ts()}] [R41-T1] Browser args cached: dataId=${data.id}, expKey=${_r41ToolExpKey}, argsKeys=${Object.keys(typeof _r41BrArgs === 'object' ? _r41BrArgs : {}).join(',')}`);
              } catch(err) { logger.warn(`[${ts()}] [R41-T1] Browser args cache failed for dataId=${data.id}: ${err.message}`); }
              try {
                const _browserLogEntry = {
                  url: currentUrl,
                  title: browserData.title || '',
                  textSnippet: (browserData.text || browserData.content || '').substring(0, 200),
                  screenshot: screenshotUrl ? 'captured' : 'none',
                  action: action,
                  timestamp: Date.now()
                };
                recordCompression('browser_execution', 0, { sessionKey, extra: JSON.stringify(_browserLogEntry) });
                logger.info(`[${ts()}] [R15-T2] Browser execution logged: action=${action} url=${(currentUrl || '').substring(0, 60)}`);
              } catch (_browserLogErr) {
                logger.warn(`[${ts()}] [R15-T2] Browser log failed: ${_browserLogErr.message}`);
              }
            }
            // [R30-T4] generate_image local handler
            if (toolName === "generate_image" && data.phase !== "done" && data.phase !== "failed") {
              try {
                const { handleGenerateImage } = await import('./image-generator.mjs');
                const _imgArgs = data.args || data.input || {};
                logger.info(`[${ts()}] [R30-T4] intercepting generate_image tool call: prompt="${(_imgArgs.prompt || '').substring(0, 60)}"`);
                sendStep(msgId, "🎨 生成图片中", "running", `模型: gpt-image-1 | 尺寸: ${_imgArgs.size || '1024x1024'}`);
                const _imgResult = await handleGenerateImage(_imgArgs);
                logger.info(`[${ts()}] [R30-T4] generate_image result: phase=${_imgResult.phase} url=${_imgResult.url || 'none'}`);
                // R30-T4: Emit image_generated event for observability
                if (_imgResult.phase === "done" || _imgResult.success) {
                  try {
                    emitEvent(sessionKey, msgId, "image_generated", {
                      model: _imgResult.model || "dall-e-3",
                      prompt: (_imgArgs.prompt || "").substring(0, 100),
                      url: _imgResult.url || _imgResult.servedUrl || "",
                      size: _imgArgs.size || "1024x1024"
                    });
                  } catch (_evtErr) { /* non-fatal */ }
                }
                sendStep(msgId, "🎨 图片已生成", _imgResult.phase === 'done' ? "success" : "error",
                  _imgResult.phase === 'done' ? `图片地址: ${_imgResult.url}` : `生成失败: ${_imgResult.error}`);
                // Inject result back as observation
                if (options.conversationHistory) {
                  appendToolResult(options.conversationHistory, toolName, JSON.stringify(_imgResult));
                }
              } catch (_imgErr) {
                logger.error(`[${ts()}] [R30-T4] generate_image intercept error: ${_imgErr.message}`);
                sendStep(msgId, "🎨 图片生成失败", "error", _imgErr.message);
              }
            }

            // [R32-T3] transcribe_audio local handler
            if (toolName === "transcribe_audio" && data.phase !== "done" && data.phase !== "failed") {
              try {
                const _taArgs = data.args || data.input || {};
                const _audioUrl = _taArgs.audio_url || _taArgs.audioUrl || _taArgs.url || '';
                const _lang = _taArgs.language || '';
                logger.info(`[${ts()}] [R32-T3] intercepting transcribe_audio: url="${_audioUrl.substring(0, 80)}" lang=${_lang}`);
                sendStep(msgId, "🎙️ 语音转写中", "running", `语言: ${_lang || '自动检测'}`);
                
                // Call the voice transcribe API locally
                const _transcribeResp = await fetch('http://127.0.0.1:3001/api/voice/transcribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-internal-call': '1' },
                  body: JSON.stringify({ audioUrl: _audioUrl, language: _lang })
                });
                const _transcribeResult = await _transcribeResp.json();
                logger.info(`[${ts()}] [R32-T3] transcribe_audio result: text="${(_transcribeResult.text || '').substring(0, 60)}" lang=${_transcribeResult.language}`);
                
                // Emit audio_transcribed event
                try {
                  emitEvent(sessionKey, msgId, "audio_transcribed", {
                    audioUrl: _audioUrl.substring(0, 200),
                    language: _transcribeResult.language || _lang || 'unknown',
                    duration: _transcribeResult.duration || 0,
                    textLength: (_transcribeResult.text || '').length
                  });
                } catch (_evtErr) { /* non-fatal */ }
                
                sendStep(msgId, "🎙️ 转写完成", _transcribeResult.text ? "success" : "error",
                  _transcribeResult.text ? `语言: ${_transcribeResult.language} | 时长: ${_transcribeResult.duration}s` : `转写失败: ${_transcribeResult.error}`);
                
                // Inject result back as observation
                if (options.conversationHistory) {
                  appendToolResult(options.conversationHistory, toolName, JSON.stringify(_transcribeResult));
                }
              } catch (_taErr) {
                logger.error(`[${ts()}] [R32-T3] transcribe_audio intercept error: ${_taErr.message}`);
                sendStep(msgId, "🎙️ 语音转写失败", "error", _taErr.message);
              }
            }

            // [R33-T1] speak_text local handler
            if (toolName === "speak_text" && data.phase !== "done" && data.phase !== "failed") {
              try {
                const { handleSpeakText } = await import("./tts-generator.mjs");
                const _ttsArgs = data.args || data.input || {};
                const _ttsText = _ttsArgs.text || _ttsArgs.input || _ttsArgs.content || "";
                logger.info(`[${ts()}] [R33-T1] intercepting speak_text: text="${_ttsText.substring(0, 60)}" voice=${_ttsArgs.voice || "alloy"}`);
                sendStep(msgId, "🔊 语音合成中", "running", `语音: ${_ttsArgs.voice || "alloy"} | 模型: ${_ttsArgs.model || "tts-1"}`);
                
                const _ttsResult = await handleSpeakText(_ttsArgs);
                logger.info(`[${ts()}] [R33-T1] speak_text result: phase=${_ttsResult.phase} url=${_ttsResult.url || "none"}`);
                
                // Emit tts_generated event
                if (_ttsResult.phase === "done" || _ttsResult.success) {
                  try {
                    emitEvent(sessionKey, msgId, "tts_generated", {
                      voice: _ttsResult.voice || "alloy",
                      model: _ttsResult.model || "tts-1",
                      text_length: _ttsText.length,
                      url: _ttsResult.url || "",
                      size_bytes: _ttsResult.size_bytes || 0
                    });
                  } catch (_evtErr) { /* non-fatal */ }
                }
                
                sendStep(msgId, "🔊 语音已生成", _ttsResult.success ? "success" : "error",
                  _ttsResult.success ? `音频地址: ${_ttsResult.url}` : `生成失败: ${_ttsResult.error}`);
                
                // Inject result back as observation
                if (options.conversationHistory) {
                  appendToolResult(options.conversationHistory, toolName, JSON.stringify(_ttsResult));
                }
              } catch (_ttsErr) {
                logger.error(`[${ts()}] [R33-T1] speak_text intercept error: ${_ttsErr.message}`);
                sendStep(msgId, "🔊 语音合成失败", "error", _ttsErr.message);
              }

            // [R35-T1] analyze_image local handler
            if ((toolName === "analyze_image" || toolName === "image") && data.phase !== "done" && data.phase !== "failed") {
              try {
                const { handleAnalyzeImage } = await import("./vision-analyzer.mjs");
                const _visArgs = data.args || data.input || {};
                const _imgUrl = _visArgs.image_url || _visArgs.imageUrl || _visArgs.image || _visArgs.url || "";
                const _question = _visArgs.question || _visArgs.prompt || "Describe this image in detail";
                logger.info(`[${ts()}] [R35-T1] intercepting analyze_image: url="${_imgUrl.substring(0, 80)}" question="${_question.substring(0, 60)}"`);
                sendStep(msgId, "\u{1F441}\uFE0F \u56FE\u50CF\u5206\u6790\u4E2D", "running", `\u6A21\u578B: GPT-4o | \u7CBE\u5EA6: ${_visArgs.detail || "auto"}`);
                
                const _visResult = await handleAnalyzeImage(_visArgs);
                logger.info(`[${ts()}] [R35-T1] analyze_image result: success=${_visResult.success} model=${_visResult.model || "none"} tokens=${_visResult.tokens_used || 0}`);
                
                if (_visResult.success) {
                  try {
                    emitEvent(sessionKey, msgId, "vision_analysis", {
                      model: _visResult.model || "gpt-4o",
                      image_count: _visResult.image_count || 1,
                      tokens_used: _visResult.tokens_used || 0,
                      analysis_length: (_visResult.analysis || "").length,
                      detail: _visArgs.detail || "auto"
                    });
                  } catch (_evtErr) { /* non-fatal */ }
                }
                
                sendStep(msgId, "\u{1F441}\uFE0F \u56FE\u50CF\u5206\u6790\u5B8C\u6210", _visResult.success ? "success" : "error",
                  _visResult.success ? `\u5206\u6790: ${(_visResult.analysis || "").substring(0, 100)}...` : `\u5206\u6790\u5931\u8D25: ${_visResult.error}`);
                
                appendToolResult(msgId, toolCallId, toolName, _visResult.success
                  ? JSON.stringify({ analysis: _visResult.analysis, model: _visResult.model, image_count: _visResult.image_count })
                  : JSON.stringify({ error: _visResult.error }), sessionKey);
                return;
              } catch (_visErr) {
                logger.error(`[${ts()}] [R35-T1] analyze_image intercept error: ${_visErr.message}`);
              }

            // [R44-T6] Media analyzer tool intercept
            if (['analyze_video', 'analyze_audio', 'analyze_document'].includes(toolName) && data.phase !== 'done' && data.phase !== 'failed') {
              try {
                const { analyzeMedia } = await import('./media-analyzer.mjs');
                const _mediaArgs = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : (data.arguments || {});
                logger.info(`[${ts()}] [R44-T6] intercepting ${toolName}: args=${JSON.stringify(_mediaArgs).substring(0, 100)}`);
                const _mediaResult = await analyzeMedia(toolName, _mediaArgs, { sessionKey, taskId: msgId });
                logger.info(`[${ts()}] [R44-T6] ${toolName} result: success=${_mediaResult.success}`);
                if (_mediaResult.success) {
                  data.result = JSON.stringify(_mediaResult);
                  data.phase = 'done';
                }
              } catch (_mediaErr) {
                logger.error(`[${ts()}] [R44-T6] ${toolName} intercept error: ${_mediaErr.message}`);
              }
            }
            }
            // [R82] R36-T2 browser local intercept removed — Gateway handles browser natively (R38-T1)
            }
            // P2: Enhanced subagent/sessions tool event forwarding
            if (toolName === "sessions" || toolName === "subagents" || toolName === "prose") {
              const subData = data.result || data.output || {};
              const subAction = subData.action || data.args?.action || '';
              const subAgentId = subData.agentId || subData.sessionId || '';
              const subStatus = subData.status || 'progress';
              const subOutput = subData.output || subData.text || '';
              
              // Iter-X: microCompact 对长字符串子 Agent 结果压缩（>800 chars）
              let rawOutputStr = typeof subOutput === 'string' ? subOutput : JSON.stringify(subOutput);
              if (rawOutputStr.length > 800 && (subStatus === 'complete' || subStatus === 'done' || subAction === 'complete')) {
                try {
                  rawOutputStr = await microCompactSubAgent(rawOutputStr, subAction || '');
                  logger.info(`[${ts()}] [worker] [Iter-X] microCompact applied to subagent output`);
                } catch (_) { /* silent */ }
              }
              let compactedOutput = rawOutputStr.substring(0, 500);
              if (subStatus === 'complete' || subStatus === 'done' || subAction === 'complete') {
                try {
                  const subMessages = Array.isArray(subData.messages) ? subData.messages : [];
                  if (subMessages.length > 0) {
                    const compactResult = await compactSubAgentResult(subMessages, { agentId: subAgentId, taskDescription: subAction });
                    compactedOutput = compactResult.report;
                    logger.info(`[${ts()}] [worker] [Iter-D] Sub-agent ${subAgentId} compacted: method=${compactResult.method}, ${compactResult.originalTokens}→${compactResult.compactedTokens} tokens`);
                  }
                } catch (compactErr) {
                  logger.warn(`[${ts()}] [worker] [Iter-D] Sub-agent compact failed: ${compactErr.message}`);
                }
              }
              
              process.send({
                type: "subagent_event",
                msgId,
                agentId: subAgentId,
                agentName: toolName,
                action: subAction,
                status: subStatus,
                output: compactedOutput,
                _compressed: true,
                timestamp: Date.now()
              });
              
              logger.info(`[${ts()}] [worker] [P2-SUBAGENT] tool=${toolName}, action=${subAction}, agent=${subAgentId}, status=${subStatus}`);
            }
            if (process.env.DEBUG_TOOLS) {
              logger.info(`[${ts()}] [worker] [v10.3-DUMP] Browser tool_PROGRESS data keys: ${JSON.stringify(Object.keys(data))}`);
              for (const k of Object.keys(data)) {
                const v = data[k];
                const vStr = typeof v === "string" ? v : JSON.stringify(v);
                logger.info(`[${ts()}] [worker] [v10.3-DUMP] PROGRESS data.${k}: ${(vStr || "").substring(0, 300)}`);
              }
            }
            const progressToolId = data.id || `tool-progress-${Date.now()}`;
            sendEvent(msgId, {
              type: "tool_progress",
              id: progressToolId,
              tool: toolName,
              data: { partialResult: data.result || data.output || data.text || "" },
            });
          }

          if (data.phase === "end" || data.phase === "complete" || data.phase === "result") {
            tracker.handleToolEnd(toolName, data);
            clearInterventionTimer(data.id || null, toolName);
            // [FIX toolId-scope] Resolve toolId from toolIdMap/stack so R38-T4 timer cleanup can use it
            const resolvedToolId = (data.id && toolIdMap.get(data.id)) || (() => {
              const _stk = toolNameIdStack.get(toolName);
              return (_stk && _stk.length > 0) ? _stk[0] : null;
            })() || data.id || `tool-end-${Date.now()}`;
            let orchEndId = (data.id && orchToolIdMap.get(data.id)) || null;
            if (!orchEndId && orchNameStacks.has(toolName)) {
              const orchStack = orchNameStacks.get(toolName);
              if (orchStack && orchStack.length > 0) orchEndId = orchStack.shift();
            }
            if (!orchEndId) orchEndId = data.id || `orch-end-${Date.now()}`;
            const orchMapHit = orchToolIdMap.has(orchEndId);
            logger.info(`[${ts()}] [worker] [R58-diag] tool_end: name=${toolName}, data.id=${data.id}, orchEndId=${orchEndId}, orchMapHit=${orchMapHit}, orchMap=${orchToolIdMap.size}, tsTimes=${toolStartTimes.size}`);
            // [R5B] Enhanced exec failure detection: check result content for command-level failures
            // Must be defined early — used by _toolSuccess, observation payload, and R5 failure handler
            let _execFailureDetected = false;
            if (toolName === 'exec' && data.phase === 'result') {
              // Primary signal: Gateway isError flag
              if (data.isError === true) {
                _execFailureDetected = true;
                logger.info(`[${ts()}] [R5B] exec failure via isError=true: tool=${toolName}`);
              }
              // Secondary signal: check result content for error patterns
              if (!_execFailureDetected && data.result) {
                const _resultStr = typeof data.result === 'object' ? JSON.stringify(data.result) : String(data.result);
                if (/(?:No such file|Permission denied|command not found|ENOENT|EACCES|exit (?:code|status)\s*[1-9])/i.test(_resultStr.substring(0, 2000))) {
                  _execFailureDetected = true;
                  logger.info(`[${ts()}] [R5B] exec command-level failure detected: tool=${toolName} resultPreview=${(typeof _resultStr === 'object' && _resultStr !== null) ? JSON.stringify(_resultStr).substring(0, 200) : String(_resultStr || '').substring(0, 200)}`);
                }
              }
            }
            // [R38-T4] Clear exec timeout timer
            if (toolName === "exec" || toolName === "code") {
              const _execKey2 = `${msgId}:${resolvedToolId}`;
              const _execEntry = _execTimers.get(_execKey2);
              if (_execEntry) {
                clearTimeout(_execEntry.timer);
                const _execDurationMs = Date.now() - _execEntry.startMs;
                _execTimers.delete(_execKey2);
                if (_execDurationMs > EXEC_TIMEOUT_MS) {
                  logger.warn(`[${ts()}] [R38-T4] Exec exceeded timeout: ${_execDurationMs}ms > ${EXEC_TIMEOUT_MS}ms`);
                  try {
                    emitEvent(sessionKey, msgId, "sandbox_limit_exceeded", {
                      limitType: "cpu_timeout_exceeded",
                      durationMs: _execDurationMs,
                      limitMs: EXEC_TIMEOUT_MS,
                      tool: toolName,
                      toolId: resolvedToolId,
                    });
                  } catch (_e) { /* non-fatal */ }
                }
                logger.info(`[${ts()}] [R38-T4] Exec duration: ${_execDurationMs}ms (limit: ${EXEC_TIMEOUT_MS}ms)`);
              }
            }
            // [R37-T1] code_exec_finished/failed event for exec/code tools
            if (toolName === "exec" || toolName === "code") {
              try {
                const _ceResult = data.result || data.output || "";
                const _ceResultStr = typeof _ceResult === "string" ? _ceResult : JSON.stringify(_ceResult);
                const _ceSuccess = !_execFailureDetected && data.phase !== "failed" && !data.error;
                const _ceExitCode = data.exitCode ?? (data.result && typeof data.result === "object" ? data.result.exitCode : undefined) ?? (_execFailureDetected ? 1 : 0);
                const _ceDuration = toolStartTimes.has(data.id || "") ? Date.now() - (toolStartTimes.get(data.id || "")?.startTime || Date.now()) : 0;
                
                // [R37-T1] Large output file-ization: if output > 4KB, write to file
                let _ceArtifactPath = null;
                if (_ceResultStr.length > 4096) {
                  try {
                    const _artifactId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    _ceArtifactPath = `/tmp/rangerai-sandbox/artifacts/${_artifactId}.txt`;
                    const _fs = await import("fs");
                    const _path = await import("path");
                    _fs.default.mkdirSync(_path.default.dirname(_ceArtifactPath), { recursive: true });
                    _fs.default.writeFileSync(_ceArtifactPath, _ceResultStr);
                    logger.info(`[${ts()}] [R37-T1] Large output saved to artifact: ${_ceArtifactPath} (${_ceResultStr.length} chars)`);
                    emitEvent(sessionKey, msgId, "artifact_written", {
                      path: _ceArtifactPath,
                      size: _ceResultStr.length,
                      tool: toolName,
                      type: "exec_output",
                    });
                  } catch (_artErr) {
                    logger.warn(`[${ts()}] [R37-T1] artifact write failed: ${_artErr.message}`);
                  }
                }
                
                const _ceEventType = _ceSuccess ? "code_exec_finished" : "code_exec_failed";
                emitEvent(sessionKey, msgId, _ceEventType, {
                  tool: toolName,
                  exitCode: _ceExitCode,
                  duration: _ceDuration,
                  outputLength: _ceResultStr.length,
                  outputPreview: _ceResultStr.substring(0, 500),
                  artifactPath: _ceArtifactPath,
                  error: _execFailureDetected ? _ceResultStr.substring(0, 300) : null,
                  isolation: "gateway",  // [R40-T3] Mark as Gateway-executed (not Docker-intercepted)
                });
                logger.info(`[${ts()}] [R37-T1] ${_ceEventType}: tool=${toolName} exitCode=${_ceExitCode} duration=${_ceDuration}ms outputLen=${_ceResultStr.length} artifact=${_ceArtifactPath || "none"}`);
                sendStep(msgId, _ceSuccess ? "💻 代码执行完成" : "💻 代码执行失败", _ceSuccess ? "success" : "error",
                  _ceSuccess ? `耗时: ${_ceDuration}ms | 输出: ${_ceResultStr.length} 字符` : `退出码: ${_ceExitCode} | ${_ceResultStr.substring(0, 100)}`);
              } catch (_ceEndErr) {
                logger.warn(`[${ts()}] [R37-T1] code_exec event error: ${_ceEndErr.message}`);
              }
            }

            // [R73 P0-1] completeDispatch wraps getActiveToolInfo + releaseExecution
            const dispatchCompletion = orchestrator.completeDispatch(orchEndId);
            const orchToolInfo = dispatchCompletion.toolInfo;
            orchToolIdMap.delete(orchEndId);
            if (data.id) orchToolIdMap.delete(data.id);
            let toolExpEndKey = (data.id && toolStartTimes.has(data.id)) ? data.id : null;
            if (!toolExpEndKey && tstNameStacks.has(toolName)) {
              const tstStack = tstNameStacks.get(toolName);
              if (tstStack && tstStack.length > 0) toolExpEndKey = tstStack.shift();
            }
            if (!toolExpEndKey) toolExpEndKey = data.id || `texp-${streamId}-${tracker.toolCount}`;
            const toolStartInfo = toolStartTimes.get(toolExpEndKey);
            if (toolStartInfo) {
              const toolDuration = Date.now() - toolStartInfo.startTime;
              const toolSuccess = data.phase !== "failed" && !data.error;
              // [Iter-66] Log failure diagnosis for failed tools
              if (!toolSuccess) {
                const _toolErrMsg = data.error || data.result?.error || '';
                const _toolDiagnosis = diagnoseFailure(_toolErrMsg, toolName, { attempts: 0 });
                logger.info(`[${ts()}] [worker] [Iter-66] Tool failure: tool=${toolName} type=${_toolDiagnosis.failureType} recovery=${_toolDiagnosis.recovery.action} severity=${_toolDiagnosis.recovery.severity} error="${String(_toolErrMsg).substring(0, 200)}"`);
              }
              logger.info(`[${ts()}] [worker] [R58-diag] recordToolExp: normalized=${normalizeToolName(toolName)}, name=${toolName}, subType=${getToolSubType(toolName, data.args || data.input || "")}, duration=${toolDuration}ms, success=${toolSuccess}, expKey=${toolExpEndKey}, orchMap=${orchToolIdMap.size}, tsTimes=${toolStartTimes.size}`);
              recordToolExperience(toolName, data.args || data.input || '', data.result || data.output || '', toolDuration, toolSuccess, sessionKey).catch(() => {});
              // Extract facts from search-type tools
              // [R37-T3] Emit tool_route_chosen event for web tools
              if (['web_search', 'web_fetch', 'browser'].includes(toolName)) {
                try {
                  const _r37Plan2 = _agentLoopModules?.pl?.getPlan?.(msgId);
                  const _expectedTool = _r37Plan2?.selectedPrimaryTool || 'none';
                  _agentLoopModules?.es?.emitEvent(sessionKey, msgId, 'tool_route_chosen', {
                    chosenTool: toolName,
                    expectedTool: _expectedTool,
                    taskFamily: _r37Plan2?.taskFamily || 'unknown',
                    match: toolName === _expectedTool || (_expectedTool === 'browser' && toolName === 'browser'),
                  });
                } catch (_trErr) { /* non-fatal */ }
              }
              // [R38-T1] Enhanced browser action detail logging (Gateway native)
              if (toolName === "browser") {
                try {
                  const _r38Result = data.result || data.output || "";
                  const _r38ResultStr = typeof _r38Result === "string" ? _r38Result : JSON.stringify(_r38Result);
                  // [R41-T1] Read args from cache — try MULTIPLE keys for reliable lookup
                  const _r41LookupKeys = [
                    toolExpEndKey,
                    data.id,
                    `texp-${streamId}-${tracker.toolCount}`,
                    `br-${msgId}`,
                  ].filter(Boolean);
                  let _r38CachedArgs = {};
                  let _r41MatchedKey = 'none';
                  for (const _r41K of _r41LookupKeys) {
                    const _r41V = _r38BrowserArgsCache.get(_r41K);
                    if (_r41V && Object.keys(typeof _r41V === 'object' ? _r41V : {}).length > 0) {
                      _r38CachedArgs = _r41V;
                      _r41MatchedKey = _r41K;
                      break;
                    }
                  }
                  // Cleanup all possible keys
                  for (const _r41K of _r41LookupKeys) _r38BrowserArgsCache.delete(_r41K);
                  logger.info(`[${ts()}] [R41-T1] Browser args lookup: matchedKey=${_r41MatchedKey}, triedKeys=${_r41LookupKeys.join(',')}, hasArgs=${Object.keys(_r38CachedArgs).length > 0}`);
                  const _r38Args = _r38CachedArgs || data.args || data.input || {};
                  const _r38ArgsObj = typeof _r38Args === "string" ? (() => { try { return JSON.parse(_r38Args); } catch(e) { return {}; } })() : (_r38Args || {});
                  
                  // [R41-T1-v3] FIXED: Declare _r38Action BEFORE using it (was TDZ bug in v2)
                  let _r38Action = _r38ArgsObj.action || "unknown";
                  const _r38Url = _r38ArgsObj.url || "";
                  const _r38Selector = _r38ArgsObj.selector || _r38ArgsObj.ref || "";
                  const _r38RequestRaw = _r38ArgsObj.request || "";
                  const _r38Request = (typeof _r38RequestRaw === "string" ? _r38RequestRaw : (typeof _r38RequestRaw === "object" ? (_r38RequestRaw.text || JSON.stringify(_r38RequestRaw)) : String(_r38RequestRaw))).toLowerCase();
                  const _r38Text = _r38ArgsObj.text || "";
                  
                  // [R41-T1-v3] Fallback: if action still unknown, try extracting from result
                  if (_r38Action === "unknown" || _r38Action === "") {
                    try {
                      const _r41ResultObj = typeof _r38Result === "string" ? (() => { try { return JSON.parse(_r38Result); } catch(e) { return {}; } })() : (_r38Result || {});
                      if (_r41ResultObj.action) _r38Action = _r41ResultObj.action;
                      if (_r41ResultObj.url && !_r38Url) _r38ArgsObj.url = _r41ResultObj.url;
                      if (_r41ResultObj.currentUrl && !_r38Url) _r38ArgsObj.url = _r41ResultObj.currentUrl;
                      const _r41ResStr = typeof _r38Result === "string" ? _r38Result : JSON.stringify(_r38Result);
                      if (_r38Action === "unknown" || _r38Action === "") {
                        if (/navigat|goto|open/i.test(_r41ResStr.substring(0, 300))) _r38Action = "navigate";
                        else if (/click/i.test(_r41ResStr.substring(0, 300))) _r38Action = "click";
                        else if (/type|fill|input/i.test(_r41ResStr.substring(0, 300))) _r38Action = "type";
                        else if (/screenshot|snapshot/i.test(_r41ResStr.substring(0, 300))) _r38Action = "screenshot";
                        else if (/scroll/i.test(_r41ResStr.substring(0, 300))) _r38Action = "scroll";
                      }
                      logger.info(`[${ts()}] [R41-T1-v3] Result-based fallback: action=${_r38Action}`);
                    } catch(_r41FbErr) {}
                  }
                  
                  // [R41-T1-v3] Map Gateway action names to actionType enum
                  // Gateway uses: open, act, snapshot, screenshot, scroll, type, click
                  // Target enum: navigate, click, type, screenshot, scroll, select
                  let _r38ActionType = "unknown";
                  const _r38ActionLower = (_r38Action || "").toLowerCase();
                  if (_r38ActionLower === "open" || _r38ActionLower === "navigate" || _r38ActionLower === "goto") _r38ActionType = "navigate";
                  else if (_r38ActionLower === "act" || _r38ActionLower === "click") {
                    // [R42-T4-v3] Enhanced: use request.kind for precise mapping
                    const _r42ReqRaw = _r38ArgsObj.request || "";
                    const _r42ReqKind = (typeof _r42ReqRaw === "object" && _r42ReqRaw !== null) ? (_r42ReqRaw.kind || "").toLowerCase() : "";
                    const _r42IsPlainText = typeof _r42ReqRaw === "string" && _r42ReqRaw.length > 0 && !_r42ReqRaw.startsWith("{");
                    if (_r42ReqKind === "scroll" || /scroll/i.test(_r38Request)) _r38ActionType = "scroll";
                    else if (_r42ReqKind === "select" || /select|choose|dropdown/i.test(_r38Request)) _r38ActionType = "select";
                    else if (_r42ReqKind === "type" || _r42ReqKind === "fill" || _r42ReqKind === "input") _r38ActionType = "type";
                    else if (_r42IsPlainText || _r38Text) _r38ActionType = "type";
                    else if (_r42ReqKind === "evaluate" && /scroll/i.test(_r38Request)) _r38ActionType = "scroll";
                    else _r38ActionType = "click";
                  }
                  else if (_r38ActionLower === "type" || _r38ActionLower === "fill" || _r38Text) _r38ActionType = "type";
                  else if (_r38ActionLower === "screenshot" || _r38ActionLower === "snapshot") _r38ActionType = "screenshot";
                  else if (_r38ActionLower === "scroll") _r38ActionType = "scroll";
                  else if (_r38ActionLower === "select") _r38ActionType = "select";
                  else _r38ActionType = _r38Action; // pass through if no mapping
                  emitEvent(sessionKey, msgId, "browser_action_detail", {
                    actionType: _r38ActionType, action: _r38Action,
                    normalizedToolName: 'browser_' + _r38ActionType, // [R43-T3]
                    url: (_r38Url || "").substring(0, 200),
                    selector: (_r38Selector || "").substring(0, 100),
                    text: (_r38Text || "").substring(0, 100),
                    request: (_r38Request || "").substring(0, 150),
                    success: toolSuccess, resultLength: _r38ResultStr.length,
                    isNativeGateway: true, source: "gateway_native"
                  });
                  logger.info(`[${ts()}] [R38-T1] browser_action_detail: type=${_r38ActionType} action=${_r38Action} request=${(_r38Request || '').substring(0, 50)} success=${toolSuccess}`);
                } catch (_r38Err) {
                  logger.warn(`[${ts()}] [R38-T1] browser_action_detail error: ${_r38Err.message}`);
                }
              }
              if (['web_search', 'web_fetch', 'browser'].includes(toolName)) {
                const query = (() => { try { const a = JSON.parse(data.args || '{}'); return a.query || a.url || ''; } catch { return ''; } })();
                extractAndStoreFact(toolName, query, data.result || data.output || '', msgId).catch(() => {});
              }
              toolStartTimes.delete(toolExpEndKey);
            } else {
              // Fallback: record without duration
              const toolSuccess = data.phase !== "failed" && !data.error;
              recordToolExperience(toolName, data.args || data.input || '', data.result || data.output || '', 1000, toolSuccess, sessionKey).catch(() => {});
            }
            toolsActiveCount = Math.max(0, toolsActiveCount - 1);
            // ─── Agent Loop: Emit OBSERVATION event for tool result ───
            if (_agentLoopModules) {
              try {
                const { emitEventSync, emitEvent, emitLedgerEvent, EVENT_TYPES, MODULE_INSTANCE_ID } = _agentLoopModules.es;
                const _rawResult = data.result || data.output || "";
                const _trStr = typeof _rawResult === "string" ? _rawResult : JSON.stringify(_rawResult || "");
                // [R50-T2] 用智能压缩替换硬截断 substring(0, 2000)
                const { compressed: _obsContent, didCompress: _obsDidCompress, originalLen: _obsOrigLen } = compressObservation(toolName, _trStr);
                const _csForLedger = _agentLoopModules.pl?.getCurrentStep?.(msgId) || null;
                const _planForLedger = _agentLoopModules.pl?.getPlan?.(msgId) || null;
                const _endActionId = data.id || toolExpEndKey || `action-${msgId}-${toolName}`;
                const _obsPayload = {
                  taskId,
                  runId,
                  planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                  stepId: _csForLedger?.id || _csForLedger?.stepId || null,
                  actionId: _endActionId,
                  type: "tool_result",
                  tool: toolName,
                  success: data.phase !== "failed" && !data.error && !_execFailureDetected,
                  content: _obsContent,
                };
                // [R4] Debug: log observation emit with instance ID and buffer state
                logger.info(`[${ts()}] [R4-obs] emit observation: tool=${toolName} taskId=${msgId} sessionKey=${sessionKey} esInstance=${MODULE_INSTANCE_ID} success=${_obsPayload.success} origLen=${_obsOrigLen} compressed=${_obsDidCompress}`);
                emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.ACTION_COMPLETED, _obsPayload, null, toolName);
                emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.OBSERVATION_RECORDED, _obsPayload, null, toolName);
                // [R4] Use emitEventSync to guarantee immediate DB write (non-blocking)
                emitEventSync(sessionKey, taskId, EVENT_TYPES.OBSERVATION, _obsPayload, null, toolName)
                  .then(() => logger.info(`[${ts()}] [R4-obs] observation synced to DB: tool=${toolName} taskId=${msgId}`))
                  .catch(syncErr => {
                    logger.warn(`[${ts()}] [R4-obs] sync write failed, falling back to buffer: ${syncErr.message}`);
                    emitEvent(sessionKey, msgId, EVENT_TYPES.OBSERVATION, _obsPayload, null, toolName);
                  });
                // Update plan step if tool matches
                const _toolSuccess = data.phase !== "failed" && !data.error && !_execFailureDetected;
                const _cs = _agentLoopModules.pl.getCurrentStep(msgId);
                logger.info(`[${ts()}] [R4-obs] getCurrentStep(${msgId}): ${_cs ? `id=${_cs.id} tools=[${(_cs.tools||[]).join(',')}]` : 'null'} toolSuccess=${_toolSuccess} execFailure=${!!_execFailureDetected}`);
                // [R71-P0-1] NO_PLAN detection: warn when tool is executed without active plan
                if (!_cs) {
                  const _plan = _agentLoopModules.pl.getPlan(msgId);
                  logger.info(`[${ts()}] [R71-P0-1] NO_PLAN_ACTION_WARNED: tool=${toolName} hasPlan=${!!_plan} taskId=${msgId}`);
                  emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.NO_PLAN_ACTION, {
                    taskId, runId,
                    tool: toolName,
                    reason: _plan ? 'plan exists but no current step' : 'no active plan',
                  }, null, toolName);
                  try { _agentLoopModules.pl.recordNoPlanAction?.(msgId, toolName, !!_plan); } catch(_) {}
                }
                // [R70 P0-1] Tool failure handling delegated to executor.handleToolFailure()
                if (!_toolSuccess && _cs) {
                  const _failError = _execFailureDetected
                    ? String(data.result || '').substring(0, 300)
                    : (data.error || data.stderr || data.phase || 'unknown error').substring(0, 300);
                  logger.info(`[${ts()}] [L4-fail] tool_call failed for step ${_cs.id}: tool=${toolName} strategy=${_cs.onFailure || 'replan'} error=${_failError.substring(0, 150)}`);
                  const _execModule = _agentLoopModules?.ex;
                  if (_execModule?.handleToolFailure) {
                    _execModule.handleToolFailure({
                      taskId, sessionKey, msgId,
                      planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                      runId,
                      step: _cs,
                      toolName,
                      error: _failError,
                      actionId: _endActionId,
                    }).then(result => {
                      logger.info(`[${ts()}] [executor-R70] step=${_cs.id} resolved: action=${result.action} failureType=${result.failureType}`);
                      if (result.directive) {
                        sendEvent(msgId, { type: 'thinking', content: result.directive });
                      }
                      if (result.aborted) {
                        logger.warn(`[${ts()}] [executor-R70] task=${msgId} step=${_cs.id} aborted by strategy`);
                      }
                    }).catch(async rpErr => {
                      logger.error(`[${ts()}] [executor-R70] handleToolFailure error: ${rpErr.message}`);
                      try {
                        await emitEventSync(sessionKey, taskId, EVENT_TYPES.TASK_FAILED, {
                          taskId, runId,
                          planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                          stepId: _cs.id, actionId: _endActionId,
                          tool: toolName, failureType: 'internal',
                          recoveryAction: 'failure_handler_error',
                          error: `${_failError.substring(0, 220)} | handler=${rpErr.message}`.substring(0, 300),
                        }, null, toolName);
                      } catch (syncErr) {
                        emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.TASK_FAILED, {
                          taskId, runId,
                          planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                          stepId: _cs.id, tool: toolName,
                          failureType: 'internal', recoveryAction: 'failure_handler_error',
                          error: `${_failError.substring(0, 220)} | handler=${rpErr.message}`.substring(0, 300),
                        }, null, toolName);
                      }
                    });
                  } else {
                    // Fallback: executor module not yet loaded with handleToolFailure (legacy path)
                    logger.warn(`[${ts()}] [executor-R70] handleToolFailure not available, using legacy inline handler`);
                    _agentLoopModules.pl.handleStepFailure(msgId, sessionKey, _cs.id, toolName, _failError)
                      .catch(rpErr => logger.error(`[${ts()}] [executor-R70] legacy fallback error: ${rpErr.message}`));
                  }
                }
                // [R12-T2] Record plan followance metrics
                if (_cs && _cs.status !== 'done' && _cs.status !== 'skipped') {
                  const _expectedTools = _cs.expectedTools || _cs.tools || [];
                  const _followed = _expectedTools.length === 0 || _expectedTools.some(t => toolName.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(toolName.toLowerCase()));
                  recordActionFollowance(msgId, toolName, _cs.id, _followed);
                } else if (!_cs) {
                  recordNoPlanAction(msgId);
                }
                // [R4-Task3] Relaxed condition: mark step done if tool succeeded AND step exists
                // Previously: _cs.tools.includes(toolName) — too strict when tools=[] (from bridge)
                // [R10-FIX-2] Guard: skip if step is already done/skipped to prevent infinite loop
                if (_cs && _cs.status !== 'done' && _cs.status !== 'skipped' && _toolSuccess) { // [R30-FIX-2] Removed tool name matching — planner tool hints are unreliable
                  // [STEP-GATE] Prevent cascade: require min tools or min time before marking done
                  let _stt = _stepToolTracker.get(msgId);
                  if (!_stt || String(_stt.stepId) !== String(_cs.id)) {
                    _stt = { stepId: String(_cs.id), count: 0, startedAt: Date.now() };
                  }
                  _stt.count++;
                  _stepToolTracker.set(msgId, _stt);
                  const _gateDecision = evaluateStepCompletionGate({
                    toolName,
                    resultText: _trStr,
                    step: _cs,
                    tracker: _stt,
                    minTools: STEP_MIN_TOOLS,
                    minElapsedMs: STEP_MIN_TIME_MS,
                  });
                  const _gateElapsed = _gateDecision.elapsedMs;
                  const _shouldComplete = _gateDecision.complete;
                  if (!_shouldComplete) {
                    // Gate not met: mark step as "doing" but don't complete
                    if (_cs.status === 'pending') {
                      try { _agentLoopModules.pl.markStepDoing(msgId, _cs.id); } catch(_) {}
                    }
                    logger.info(`[${ts()}] [STEP-GATE] Step ${_cs.id} in progress: ${_gateDecision.count}/${STEP_MIN_TOOLS} tools, ${_gateElapsed}ms/${STEP_MIN_TIME_MS}ms reason=${_gateDecision.reason} — not completing yet`);
                  } else {
                  // Gate passed: proceed with step completion
                  _stepToolTracker.set(msgId, { stepId: null, count: 0, startedAt: Date.now() });
                  logger.info(`[${ts()}] [STEP-GATE] Step ${_cs.id} gate passed (reason=${_gateDecision.reason}, tools=${_gateDecision.count}, elapsed=${_gateElapsed}ms) — marking done`);
                  _agentLoopModules.pl.markStepDone(msgId, _cs.id, `${toolName} completed`);
                  // [R30-FIX] Sync progress tracker with planner step completion
                  try {
                    // [R71-P0-3] Record evidence from completed tool action before marking step done
                    try {
                      recordStepEvidence(sessionKey, _cs.id, {
                        type: 'tool_completed', detail: `${toolName} completed`, tool: toolName,
                      });
                      logger.info(`[${ts()}] [R71-P0-3] evidence_recorded_for_step: step=${_cs.id} tool=${toolName} session=${sessionKey}`);
                    } catch (_evErr) { /* non-fatal */ }
                    progressMarkStepDone(sessionKey, _cs.id);
                  } catch (_syncErr) { /* non-fatal */ }
                  logger.info(`[${ts()}] [planner] Step ${_cs.id} marked done (tool=${toolName}, via openclaw-handler)`);
                  // [R26-T3] Update todo tracker on step completion
                  try {
                    markDone(msgId, _cs.id, `${toolName} completed`);
                  } catch (_todoErr) { /* non-fatal */ }
                  // [R14-T1] Save context checkpoint via context-buffer singleton (replaces R13-T3 inline DB)
                  try { saveContextCheckpoint(sessionKey, msgId, _cs.id, typeof messages !== "undefined" ? messages : []); } catch(_sccErr) { /* R68-FIX: messages not in scope */ }
                  // [R2] Emit PLAN_STEP_UPDATE event for event stream replay
                  const _nextStep = _agentLoopModules.pl.getCurrentStep(msgId);
                  emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_STEP_UPDATE, {
                    taskId,
                    runId,
                    planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                    stepId: _cs.id,
                    status: "done",
                    output: `${toolName} completed`,
                    nextStepId: _nextStep ? _nextStep.id : null,
                  });
                  emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.STEP_COMPLETED, {
                    taskId,
                    runId,
                    planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                    stepId: _cs.id,
                    actionId: _endActionId,
                    status: 'done',
                    output: `${toolName} completed`,
                    nextStepId: _nextStep ? _nextStep.id : null,
                  }, null, toolName);
                  // [R6-Task3] Inject [NEXT_STEP] directive after step completion
                  if (_nextStep) {
                    _agentLoopModules.pl.markStepDoing(msgId, _nextStep.id);
                    emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.STEP_STARTED, {
                      taskId,
                      runId,
                      planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                      stepId: _nextStep.id,
                      title: _nextStep.title || '',
                      intent: _nextStep.intent || _nextStep.taskPhase || null,
                      expectedAction: _nextStep.expectedAction || _nextStep.action || null,
                      expectedOutput: _nextStep.expectedOutput || null,
                    });
                    // [R26-T3] Update todo tracker for next step
                    try {
                      markInProgress(msgId, _nextStep.id);
                      emitTodoEvent(msgId, (type, payload) => emitEvent(sessionKey, msgId, type, payload), sessionKey);
                    } catch (_todoErr) { /* non-fatal */ }
                    let _r70SkipNextStep = false;
                    // ═══ [R70] GPT Step Review (replaces 方案A model switching) ═══
                    // Instead of switching models per step, we now:
                    // 1. Review completed step via GPT if reviewPolicy=gpt_review
                    // 2. Inject detailed taskBrief for the next step
                    // 3. Keep V4Pro as the execution model throughout (no model switching)
                    const _r70CompletedStep = _cs; // The step that just completed
                    const _r70ReviewPolicy = _r70CompletedStep.reviewPolicy || 'auto_pass';
                    let _r70ReviewResult = null;
                    if (_r70ReviewPolicy === 'gpt_review') {
                      try {
                        sendEvent(msgId, { type: "internal", content: `[R70-REVIEW] Reviewing step ${_r70CompletedStep.id}: "${_r70CompletedStep.title}"...` });
                        // Collect execution summary from recent tool results
                        const _r70ExecSummary = _trStr ? _trStr.substring(0, 2000) : `Tool ${toolName} completed`;
                        const _r70TaskCtx = userMessage ? userMessage.substring(0, 300) : '';
                        const _r76_mustPass = _r70CompletedStep.reviewPolicy === 'must_pass' || _r70CompletedStep.critical === true;
                        _r70ReviewResult = await reviewStepResult(_r70CompletedStep, _r70ExecSummary, _r70TaskCtx, { mustPass: _r76_mustPass });
                        logger.info(`[R70-review] Step ${_r70CompletedStep.id} review: pass=${_r70ReviewResult.pass} feedback="${(_r70ReviewResult.feedback || '').substring(0, 100)}"`);
                        if (_r70ReviewResult.pass) {
                          sendEvent(msgId, { type: "internal", content: `[R70-REVIEW] Step ${_r70CompletedStep.id} ✓ PASSED: ${_r70ReviewResult.feedback || 'OK'}` });
                        } else {
                          // Step failed review — inject retry directive
                          sendEvent(msgId, { type: "internal", content: `[R70-REVIEW] Step ${_r70CompletedStep.id} ✗ NEEDS REVISION: ${_r70ReviewResult.feedback}` });
                          // Check if we already retried this step
                          const _r70RetryKey = `r70_retry_${msgId}_${_r70CompletedStep.id}`;
                          const _r70AlreadyRetried = _stepToolTracker.get(_r70RetryKey);
                          if (!_r70AlreadyRetried) {
                            _stepToolTracker.set(_r70RetryKey, true);
                            // Revert step to 'doing' and inject retry directive
                            try { _agentLoopModules.pl.markStepDoing(msgId, _r70CompletedStep.id); } catch(_) {}
                            try { progressMarkStepDone(sessionKey, _r70CompletedStep.id); } catch(_) {} // undo
                            const _retryDirective = `[RETRY_STEP] Step ${_r70CompletedStep.id} ("${_r70CompletedStep.title}") did NOT pass quality review.\nREVIEW FEEDBACK: ${_r70ReviewResult.feedback}\nFIX HINT: ${_r70ReviewResult.retryHint || 'Re-examine the task brief and try again.'}\nPlease redo this step, addressing the feedback above.`;
                            sendEvent(msgId, { type: "internal", content: _retryDirective });
                            logger.info(`[R70-review] Step ${_r70CompletedStep.id} retry injected`);
                            // Skip the normal next-step injection — V4Pro will retry current step
                            _r70SkipNextStep = true;
                          } else {
                            // [R76-PhaseA] P0/critical steps cannot force-pass; mark as HARD_FAILED
                            const _r76_isCritical = (_r70CompletedStep.reviewPolicy === 'must_pass' || _r70CompletedStep.critical === true);
                            if (_r76_isCritical) {
                              logger.info(`[R76] Step ${_r70CompletedStep.id} HARD_FAILED — critical step cannot force-pass`);
                              sendEvent(msgId, { type: "internal", content: `[R76-BLOCKED] Critical step ${_r70CompletedStep.id} ("${_r70CompletedStep.title}") FAILED review and cannot be force-passed. Requires replanning or human intervention.` });
                              try { _agentLoopModules.pl.markStepFailed(msgId, _r70CompletedStep.id, 'R76 hard block: review failed'); } catch(_) {}
                              sendEvent(msgId, { type: "critical_step_failed", content: `Critical step "${_r70CompletedStep.title}" (${_r70CompletedStep.id}) failed verification.` });
                              _r70SkipNextStep = true;
                            } else {
                              logger.info(`[R70-review] Step ${_r70CompletedStep.id} already retried once, force-passing`);
                              sendEvent(msgId, { type: "internal", content: `[R70-REVIEW] Step ${_r70CompletedStep.id} force-passed after retry (max 1 retry)` });
                            }
                          }
                        }
                      } catch (_r70Err) {
                        logger.warn(`[R70-review] Review failed (auto-passing): ${_r70Err.message}`);
                      }
                    } else {
                      logger.info(`[R70-review] Step ${_r70CompletedStep.id} reviewPolicy=${_r70ReviewPolicy} — auto-pass`);
                    }
                    // [R10-FIX] Only send concise directive, NOT full plan block.
                    // [R70] Enhanced NEXT_STEP with taskBrief injection
                    if (!_r70SkipNextStep) {
                    const _nextTools = (_nextStep.tools || []).map(t => t.toLowerCase());
                    const _hasBrowserHint = _nextTools.some(t => t === 'browser' || t.startsWith('browser_'));
                    const _browserDirective = _hasBrowserHint
                      ? ' [BROWSER_PREFERRED] This step involves web verification — use Gateway native browser tool.'
                      : '';
                    // [R70] Enhanced directive with taskBrief and acceptanceCriteria
                    const _r70Brief = _nextStep.taskBrief ? `\n[TASK_BRIEF]\n${_nextStep.taskBrief}\n[/TASK_BRIEF]` : '';
                    const _r70Criteria = _nextStep.acceptanceCriteria ? `\n[ACCEPTANCE_CRITERIA]\n${_nextStep.acceptanceCriteria}\n[/ACCEPTANCE_CRITERIA]` : '';
                    const _r70ReviewNote = _nextStep.reviewPolicy === 'gpt_review' ? ' [GPT_WILL_REVIEW] Your output will be reviewed by GPT for quality. Follow the task brief precisely.' : '';
                    const _nextStepDirective = `[NEXT_STEP] Step ${_cs.id} ("${_cs.title}") is now DONE. Proceed to step ${_nextStep.id}: "${_nextStep.title}". Tools: ${_nextTools.join(', ') || 'auto'}${_browserDirective}${_r70ReviewNote}${_r70Brief}${_r70Criteria}`;
                    // [R27-T3] Enhanced todo+planText injection into LLM context tail
                    // Uses XML format <todo_progress> for LLM attention anchoring
                    let _todoSnippet = '';
                    try { _todoSnippet = getSnapshot(msgId); } catch (_) {}
                    // [R27-T2] Also inject planText from planner (plan exists at this point)
                    let _planTextSnippet = '';
                    try {
                      const _activePlan = _agentLoopModules.pl.getPlan?.(msgId);
                      if (_activePlan && _activePlan.planText) {
                        _planTextSnippet = _activePlan.planText;
                      }
                    } catch (_) {}
                    let _contextTail = _nextStepDirective;
                    if (_todoSnippet || _planTextSnippet) {
                      _contextTail += '\n\n<todo_progress>';
                      if (_planTextSnippet) _contextTail += `\n<current_plan>\n${_planTextSnippet}\n</current_plan>`;
                      if (_todoSnippet) _contextTail += `\n${_todoSnippet}`;
                      _contextTail += '\n</todo_progress>';
                      logger.info(`[${ts()}] [R27-T3] Injected <todo_progress>: plan=${_planTextSnippet.length}chars, todo=${_todoSnippet.length}chars`);
                    }
                    sendEvent(msgId, { type: "thinking", content: _contextTail });
                    logger.info(`[${ts()}] [R6-step-advance] Step ${_cs.id} → ${_nextStep.id}: "${_nextStep.title.substring(0, 80)}"`);
                    } // [R70] end if (!_r70SkipNextStep)
                  } else {
                    // All steps done — plan complete
                    // [R10-FIX] Concise completion signal, no plan block duplication
                    // [Iter-65] Validate plan completion contract before signaling complete
                    try {
                      const _vpc = _agentLoopModules?.pl?.validatePlanCompletion?.(msgId);
                      if (_vpc && !_vpc.valid) {
                        logger.warn(`[Iter-65] Plan completion contract has issues: taskId=${msgId} issues=[${_vpc.issues.join(';')}] missingCriteria=[${_vpc.missingCriteria.join(';')}]`);
                        sendEvent(msgId, { type: "thinking", content: `[PLAN_CONTRACT_WARN] Completion contract issues: ${_vpc.issues.join(';')}. Missing criteria: ${_vpc.missingCriteria.join(';')}. Continuing anyway.` });
                      }
                    } catch (_vpcErr) {
                      logger.warn(`[Iter-65] Plan completion validation failed (non-fatal): ${_vpcErr.message}`);
                    }
                    sendEvent(msgId, { type: "thinking", content: `[PLAN_COMPLETE] All steps are done. Summarize results and respond to the user.` });
                    const _taskCompletedPayload = {
                      taskId,
                      runId,
                      planId: _planForLedger?.planId || _planForLedger?.id || msgId,
                      stepId: _cs.id,
                      actionId: _endActionId,
                      status: 'completed',
                    };
                    try {
                      await emitEventSync(sessionKey, taskId, EVENT_TYPES.TASK_COMPLETED, _taskCompletedPayload);
                    } catch (syncErr) {
                      logger.warn(`[${ts()}] [R6-step-advance] task_completed sync write failed, falling back to buffer: ${syncErr.message}`);
                      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.TASK_COMPLETED, _taskCompletedPayload);
                    }
                    logger.info(`[${ts()}] [R6-step-advance] Plan complete — all steps done after step ${_cs.id}`);
                    // [R15-T3] Supervisor final review (non-blocking, fire-and-forget)
                    try {
                      const _svPlan = _agentLoopModules.pl.getPlan?.(msgId);
                      if (_svPlan) {
                        supervisorReview(_svPlan, { taskId: msgId, sessionKey }).then(_svResult => {
                          logger.info(`[${ts()}] [R15-supervisor] Final review: score=${_svResult.score} completed=${_svResult.summary?.completed}/${_svResult.summary?.totalSteps} risks=${(_svResult.risks || []).length}`);
                        }).catch(_svErr => {
                          logger.warn(`[${ts()}] [R15-supervisor] Final review failed: ${_svErr.message}`);
                        });
                      }
                    } catch (_svErr2) {
                      logger.warn(`[${ts()}] [R15-supervisor] Final review setup failed: ${_svErr2.message}`);
                    }
                  }
                  // [R2-Task3] Log executor step completion (check both sources)
                  const _obsExec = (_agentLoopModules && _agentLoopModules._executor) || getActiveExecutor();
                  if (_obsExec) {
                    const _execStats = _obsExec.getStats();
                    logger.info(`[${ts()}] [executor] Step ${_cs.id} completed via ${toolName} (actions: ${_execStats.actionCount})`);
                  }
                  } // [STEP-GATE] Close the else (gate passed) block
                }
              } catch (_obsEmitErr) {
                logger.error(`[${ts()}] [R4-obs] OBSERVATION emit FAILED: ${_obsEmitErr.message} stack=${(_obsEmitErr.stack || '').substring(0, 300)}`);
              }
            }
            resetTimeout(); // Restore timeout after tool completes
            logger.info(`[${ts()}] [worker] [v10.3-debug] tool_end: name=${toolName}, phase=${data.phase}, hasResult=${!!(data.result)}, hasOutput=${!!(data.output)}, dataKeys=${Object.keys(data).join(',')}, error=${data.error || 'none'}, resultPreview=${(typeof data.result === 'object' && data.result !== null) ? JSON.stringify(data.result).substring(0, 500) : String(data.result || '').substring(0, 500)}`);
            if (toolName === "browser") {
              const dataKeys = Object.keys(data);
              logger.info(`[${ts()}] [worker] [v10.3-DUMP] Browser data keys: ${JSON.stringify(dataKeys)}`);
              for (const k of dataKeys) {
                const v = data[k];
                const vStr = typeof v === "string" ? v : JSON.stringify(v);
                logger.info(`[${ts()}] [worker] [v10.3-DUMP] data.${k} (type=${typeof v}): ${(vStr || "").substring(0, 500)}`);
              }
            }
            // FIX: Reuse the same id sent in tool_start so frontend can match and update status
            // FIX v2: Try toolIdMap first, then toolNameIdStack, then generate new ID
            let endToolId = (data.id && toolIdMap.get(data.id)) || null;
            if (!endToolId) {
              const stack = toolNameIdStack.get(toolName);
              if (stack && stack.length > 0) {
                endToolId = stack.shift();
              }
            }
            if (!endToolId) endToolId = data.id || `tool-end-${Date.now()}`;
            if (data.id) toolIdMap.delete(data.id); // cleanup
            let toolResult = data.result || data.output || "";
            if (typeof toolResult === 'string' && toolResult.length > 0) {
              toolResult = ctxMgr.processToolOutput(toolName, toolResult);
              // [R28-T2] Apply intelligent summarization after basic trimming
              if (typeof toolResult === 'string' && toolResult.length > 3000) {
                try {
                  const { postProcessToolOutput } = await import('./tool-output-summarizer.mjs');
                  toolResult = postProcessToolOutput(toolName, toolResult);
                } catch (sumErr) {
                  logger.info(`[${ts()}] [R28-T2] Summarizer error (non-fatal): ${sumErr.message}`);
                }
              }
            }
            if (toolName && toolName.includes("browser")) {
              logger.info(`[${ts()}] [worker] [v10.3-debug] Browser tool result: type=${typeof toolResult}, len=${String(toolResult).length}, preview=${String(toolResult).substring(0, 500)}`);
            }
            let screenshotUrl = null;
            if (toolName === "browser" || toolName === "browser_navigate" || toolName === "browser_screenshot") {
              // Result structure: { content: [{type:"text", text:"MEDIA:/path/to/file.png"}, ...], details: {path: "/path/to/file.png", ...} }
              let mediaPath = null;
              
              // Method 1: Extract from result.details.path (most reliable)
              if (toolResult && typeof toolResult === "object" && toolResult.details && toolResult.details.path) {
                const p = toolResult.details.path;
                const pathMatch = p.match(/\.openclaw\/media\/(.+?\.(?:png|jpg|jpeg|webp))/);
                if (pathMatch) mediaPath = pathMatch[1];
              }
              
              // Method 2: Extract from result.content[].text MEDIA: prefix
              if (!mediaPath && toolResult && typeof toolResult === "object" && Array.isArray(toolResult.content)) {
                for (const item of toolResult.content) {
                  if (item.type === "text" && typeof item.text === "string") {
                    const m = item.text.match(/MEDIA:.*?\.openclaw\/media\/(.+?\.(?:png|jpg|jpeg|webp))/);
                    if (m) { mediaPath = m[1]; break; }
                  }
                }
              }
              
              // Method 3: Legacy string-based extraction
              if (!mediaPath && typeof toolResult === "string") {
                const m = toolResult.match(/MEDIA:.*?\.openclaw\/media\/(.+?\.(?:png|jpg|jpeg|webp))/);
                if (m) mediaPath = m[1];
              }
              
              if (mediaPath) {
                screenshotUrl = `/openclaw-media/${mediaPath}`;
                logger.info(`[${ts()}] [worker] [v10.4] Browser screenshot extracted: ${screenshotUrl}`);
              } else {
                logger.info(`[${ts()}] [worker] [v10.4] No screenshot found in browser result (type=${typeof toolResult})`);
              }
            }
            const toolDuration = toolStartTimes.has(data.id || "") ? Date.now() - (toolStartTimes.get(data.id || "")?.startTime || Date.now()) : 0;
            sendEvent(msgId, {
              type: "tool_end",
              id: endToolId,
              tool: toolName,
              success: data.phase !== "failed" && !data.error,
              result: toolResult,
              duration: toolDuration,
              ...(screenshotUrl ? { screenshot: screenshotUrl } : {}),
            });

            // [R26-T3] Update todo tracker on tool failure
            if ((data.phase === "failed" || data.error) && _agentLoopModules) {
              try {
                const _csFail = _agentLoopModules.pl.getCurrentStep?.(msgId);
                if (_csFail && hasTodo(msgId)) {
                  markFailed(msgId, _csFail.id, data.error || 'tool failed');
                  emitTodoEvent(msgId, (type, payload) => emitEvent(sessionKey, msgId, type, payload), sessionKey);
                }
              } catch (_todoErr) { /* non-fatal */ }
            }
            // Iter-AC: 工具失败时追加 [TOOL_ERROR] 到 conversationHistory（错误保留策略）
            if ((data.phase === "failed" || data.error) && options.conversationHistory) {
              try {
                appendToolError(options.conversationHistory, toolName, data.error || data.message || 'tool failed');
                logger.info(`[${ts()}] [worker] [Iter-AC] Appended TOOL_ERROR to history: ${toolName}`);
              } catch(err) { logger.warn(`[${ts()}] [worker] appendToolError failed for tool=${toolName}: ${err.message}`); }
              _consecutiveToolFailCount++;
              logger.info(`[${ts()}] [R30-T1] consecutive tool fail #${_consecutiveToolFailCount}: tool=${toolName}`);
              
              // [R35-T2] Self-Healing: Auto-fallback on 1st/2nd failure
              const _fallbackInfo = getToolFallback(toolName);
              if (_fallbackInfo && _consecutiveToolFailCount <= 2) {
                const _fallbackHint = _fallbackInfo.fallback
                  ? `\n\n[SYSTEM] Tool "${toolName}" failed. Auto-fallback suggestion: use "${_fallbackInfo.fallback}" instead. Reason: ${_fallbackInfo.reason}`
                  : `\n\n[SYSTEM] Tool "${toolName}" failed (${_fallbackInfo.reason}). Please try an alternative approach.`;
                
                // Inject fallback hint into the tool result so LLM sees it
                try {
                  if (typeof appendToolResult === 'function') {
                    appendToolResult(msgId, toolName, _fallbackHint);
                  }
                } catch(err) { logger.warn(`[${ts()}] [R35-T2] appendToolResult fallback failed for tool=${toolName}: ${err.message}`); }
                
                // Emit tool_fallback event
                try {
                  emitEvent(sessionKey, msgId, "tool_fallback", {
                    failedTool: toolName,
                    suggestedFallback: _fallbackInfo.fallback || "none",
                    reason: _fallbackInfo.reason,
                    failCount: _consecutiveToolFailCount,
                    autoInjected: true
                  });
                } catch(err) { logger.warn(`[${ts()}] [R35-T2] emitEvent tool_fallback failed for msgId=${msgId}: ${err.message}`); }
                
                logger.info(`[${ts()}] [R35-T2] Self-healing: tool=${toolName} fail#${_consecutiveToolFailCount}, suggested fallback=${_fallbackInfo.fallback || 'none'}`);
                
                // Reset help flag so we don't skip the 3-fail threshold
                // (fallback suggestion doesn't count as "help requested")
              }
              
              if (_consecutiveToolFailCount >= 3 && !_r30HelpRequested) {
                _r30HelpRequested = true;
                const _failMsg = `⚠️ **遇到连续失败，需要您的帮助**\n\n工具 \`${toolName}\` 已连续失败 ${_consecutiveToolFailCount} 次。\n\n**错误信息：** ${(data.error || data.message || '未知错误').substring(0, 200)}\n\n您能提供更多背景信息，或者希望我换一种方式尝试吗？`;
                try {
                  if (typeof sendFrontendMessage === 'function') {
                    sendFrontendMessage(sessionKey, msgId, _failMsg);
                  } else {
                    sendStep(msgId, "⚠️ 需要帮助", "warning", `连续 ${_consecutiveToolFailCount} 次工具失败（${toolName}），已暂停等待用户指引`);
                  }
                  logger.info(`[${ts()}] [R30-T1] User help requested after ${_consecutiveToolFailCount} consecutive failures`);
                  // R30-T1: Emit max_retries_exceeded event for observability
                  try {
                    emitEvent(sessionKey, msgId, "max_retries_exceeded", {
                      tool: toolName,
                      consecutiveFailures: _consecutiveToolFailCount,
                      lastError: (data.error || data.message || "unknown").substring(0, 200),
                      helpRequested: true
                    });
                  } catch (_evtErr) { /* non-fatal */ }
                } catch (_helpErr) { logger.warn(`[${ts()}] [R30-T1] help request failed: ${_helpErr.message}`); }
              }
            } else {
              // 工具成功则重置计数
              _consecutiveToolFailCount = 0;
            }

            // ─── R54: Step auto-advance REMOVED (R30-FIX) ───
            // R54 heuristic was broken (toolsSinceLastText >= 3 never triggered).
            // Step advancement is now handled by R30-FIX: progressMarkStepDone is called
            // alongside planner.markStepDone at the tool completion handler (line ~2659).
            // ─── R56: Inject updated progress block after tool completion ───
            // Send as frontend thinking event so user sees live progress updates
            // This does NOT go through chat.send (avoids Gateway lane flooding)
            try {
              const updatedProgress = buildProgressBlock(sessionKey);
              if (updatedProgress) {
                sendEvent(msgId, { type: "progress_update", content: updatedProgress });
                logger.info(`[${ts()}] [worker] [R56-progress-inject] Progress block sent to frontend (${updatedProgress.length} chars)`);
                // [R59-P0-1] Track progress hash for dedup — prevents flooding if progress is unchanged
                try {
                  const progressHash = updatedProgress.substring(0, 80);
                  const lastHash = _lastProgressHash.get(sessionKey);
                  if (lastHash !== progressHash) {
                    _lastProgressHash.set(sessionKey, progressHash);
                    logger.info(`[${ts()}] [worker] [R59-progress-track] Progress hash updated: ${progressHash.substring(0, 20)}... (changed)`);
                  } else {
                    logger.info(`[${ts()}] [worker] [R59-progress-track] Progress hash unchanged (dedup)`);
                  }
                } catch (_hashErr) { /* non-fatal */ }
              }
            } catch (progressErr) {
              // Silent failure — progress display is non-critical
            }
            // ─── R56-notify-milestone: Send lightweight progress notification ───
            try {
              if (hasProgress(sessionKey)) {
                const plan = getSerializablePlan(msgId);
                if (plan && plan.phases) {
                  const completed = plan.phases.filter(p => p.status === 'done').length;
                  const total = plan.phases.length;
                  const running = plan.phases.find(p => p.status === 'running');
                  if (running) {
                    sendNotify(msgId, `${completed}/${total}: ${running.title}`, 'step_progress');
                  }
                }
              }
            } catch(_err) { /* v22.0 */ logger.error("[openclaw-handler] silent catch:", _err?.message || _err); }
            // ─── R56-visual-verify: Auto-trigger visual verification after frontend changes ───
            try {
              const toolResult = { path: data.args?.path || data.args?.file_path || '', command: data.args?.command || '' };
              if (shouldAutoVerify(toolName, toolResult)) {
                const verifyMsg = buildAutoVerifyMessage(toolName, toolResult.path || toolResult.command);
                logger.info(`[${new Date().toISOString()}] [worker] [R56-visual-verify] Triggered for ${toolName}: ${toolResult.path || toolResult.command}`);
                // Send as thinking event so the AI sees it in context
                sendEvent(msgId, { type: "thinking", content: verifyMsg });
                // Record that verification was triggered (status will be updated by AI's response)
                recordVerification({
                  taskId: msgId,
                  description: `Auto-verify after ${toolName}: ${toolResult.path || toolResult.command}`,
                  status: 'partial',
                  details: 'Auto-triggered, awaiting AI visual check'
                });
              }
            } catch (verifyErr) {
              logger.info(`[${new Date().toISOString()}] [worker] [R56-visual-verify] Error: ${verifyErr.message}`);
            }
            // ─── GUARDRAIL-PROGRESS: Consecutive tool calls without text output ───
            // Increment counter on every tool completion
            toolsSinceLastText++;
            const timeSinceText = Date.now() - lastTextOutputAt;
            logger.info(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] toolsSinceLastText=${toolsSinceLastText}, timeSinceText=${Math.round(timeSinceText/1000)}s, progressReminders=${progressReminderCount}`);

            // Soft reminder: after N consecutive tool calls without text
            // P0-FIX v10.0: REMOVED chat.send — it floods Gateway lane queue and causes cascading failures
            // Now only sends frontend thinking event (no Gateway interaction)
            if (toolsSinceLastText === CONSECUTIVE_TOOL_NO_TEXT_THRESHOLD) {
              progressReminderCount++;
              logger.info(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] Soft reminder #${progressReminderCount}: ${toolsSinceLastText} consecutive tools without text output (frontend-only, no chat.send)`);
              sendEvent(msgId, { type: "thinking", content: `\n📋 已连续执行 ${toolsSinceLastText} 个操作，AI 正在工作中...\n` });
            }

            // Hard reminder: after N consecutive tool calls without text
            // P0-FIX v10.0: REMOVED chat.send — frontend-only notification
            if (toolsSinceLastText === CONSECUTIVE_TOOL_NO_TEXT_HARD_LIMIT) {
              progressReminderCount++;
              logger.info(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] HARD reminder #${progressReminderCount}: ${toolsSinceLastText} consecutive tools without text output (frontend-only, no chat.send)`);
              sendEvent(msgId, { type: "thinking", content: `\n⚠️ 已连续执行 ${toolsSinceLastText} 个操作无文字输出，AI 仍在工作中...\n` });
            }

            // Recurring reminder (throttled): frontend-only
            // P0-FIX v10.0: REMOVED chat.send — frontend-only notification
            if (toolsSinceLastText > CONSECUTIVE_TOOL_NO_TEXT_HARD_LIMIT && toolsSinceLastText % 5 === 0) {
              const now = Date.now();
              const canSendRecurring = timeSinceText >= 120000 && (now - lastProgressReminderAt) >= 120000 && progressReminderCount < 3;
              if (canSendRecurring) {
                lastProgressReminderAt = now;
                progressReminderCount++;
                logger.info(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] Recurring reminder #${progressReminderCount}: ${toolsSinceLastText} consecutive tools without text (frontend-only)`);
                sendEvent(msgId, { type: "thinking", content: `\n⏳ 已连续执行 ${toolsSinceLastText} 个操作，AI 正在处理复杂任务...\n` });
              }
            }

            // ─── Step count guardrails v10.0 (P0-FIX) ───
            // and cause cascading failures (lane wait 8min+, ghost finals, OOM crashes).
            // Now: frontend-only notifications at 30/45, hard abort at 60.
            const currentToolCount = tracker.toolCount;
            if (currentToolCount === TOOL_COUNT_WARN) {
              logger.info(`[${ts()}] [worker] [GUARDRAIL-v8.0] Tool count reached 60 — frontend-only reminder`);
              sendEvent(msgId, { type: "thinking", content: "\n⚠️ 已执行 60 次工具调用，AI 正在处理复杂任务...\n" });
            } else if (currentToolCount === TOOL_COUNT_CRITICAL) {
              logger.info(`[${ts()}] [worker] [GUARDRAIL-v8.0] Tool count reached 100 — frontend-only warning`);
              sendEvent(msgId, { type: "thinking", content: "\n⚠️ 已执行 100 次工具调用，即将达到上限...\n" });
            } else if (currentToolCount >= TOOL_COUNT_HARD_LIMIT) {
              // HARD LIMIT v8.0: raised from 60 to 120 for complex autonomous dev tasks
              logger.info(`[${ts()}] [worker] [GUARDRAIL-v8.0] Tool count reached ${currentToolCount} — HARD LIMIT, aborting and forcing delivery`);
              sendEvent(msgId, { type: "thinking", content: "\n🛑 工具调用已达上限，正在强制交付当前成果...\n" });
              // P0-FIX v10.0: Abort FIRST, wait for lane release, THEN finish
              // Old approach: setTimeout 3s then abort+finish simultaneously
              // New approach: abort immediately, wait 2s cooldown for lane cleanup, then finish
              (async () => {
                try {
                  if (runId && gateway.isConnected) {
                    logger.info(`[${ts()}] [worker] [v10.0] Hard-limit abort: aborting Gateway run ${runId}...`);
                    await gateway.request("chat.abort", { sessionKey, runId });
                    logger.info(`[${ts()}] [worker] [v10.0] Hard-limit Gateway abort success. Waiting 2s cooldown for lane cleanup...`);
                  }
                } catch (abortErr) {
                  logger.info(`[${ts()}] [worker] [v10.0] Hard-limit Gateway abort failed (non-fatal): ${abortErr.message}`);
                }
                // P0-FIX: 2-second cooldown after abort to ensure Gateway lane is fully released
                await new Promise(r => setTimeout(r, 2000));
                if (!resolved) {
                  const summary = tracker.getSummary();
                  const titleList = (summary.toolTitles || []).slice(-10).map((t, i) => `${i+1}. ${t}`).join("\n");
                  const summaryText = titleList ? `\n\n**已完成的操作步骤（最近10步）：**\n${titleList}` : "";

                  // P2-FIX v14.0: Save task plan state for continuation
                  let planSummary = "";
                  try {
                    const plan = getSerializablePlan(msgId);
                    if (plan && plan.phases && plan.phases.length > 0) {
                      const pendingPhases = plan.phases.filter(p => p.status !== "completed");
                      if (pendingPhases.length > 0) {
                        const pendingList = pendingPhases.map((p, i) => `${i+1}. ${p.title || p.name || "Phase " + p.id}`).join("\n");
                        planSummary = `\n\n**未完成的任务阶段：**\n${pendingList}`;
                        logger.info(`[${ts()}] [worker] [P2-FIX] HARD_LIMIT plan state saved: ${pendingPhases.length} pending phases out of ${plan.phases.length} total`);
                      }
                    }
                  } catch (planErr) {
                    logger.info(`[${ts()}] [worker] [P2-FIX] Failed to get plan state: ${planErr.message}`);
                  }

                  fullText += "\n\n---\n> ⚠️ 已完成 " + currentToolCount + " 步操作。" + summaryText + planSummary + "\n\n如需继续后续步骤，请发送「继续」，我会从上次中断的地方接着执行。";
                  abortController.abort();
                  finishSuccess(fullText);
                }
              })();
            }
          }
        }

        // ─── Thinking/reasoning events ───
        if (stream === "thinking" || stream === "reasoning") {
          const thinkText = data.delta || data.text || "";
          if (thinkText) {
            thinkingReceived = true;
            sendEvent(msgId, { type: "thinking", content: thinkText });
          }
        }
      }

      // ─── [R67-FIX] Chat aborted event ───
      if (msg.event === "chat" && p.state === "aborted") {
        logger.info(`[${ts()}] [worker] [R67-FIX] Gateway ABORTED task ${msgId}. fullText=${fullText.length}, tools=${tracker.toolCount}`);
        if (!resolved) {
          if (fullText && fullText.trim().length > 100) {
            logger.info(`[${ts()}] [worker] [R67-FIX] Abort with existing text (${fullText.length} chars) — saving as partial response`);
            finishSuccess(fullText);
          } else if (tracker.toolCount > 0) {
            logger.info(`[${ts()}] [worker] [R67-FIX] Abort with ${tracker.toolCount} tools but no text — generating summary`);
            finishSuccess(`任务被中断。已执行 ${tracker.toolCount} 个工具操作。`);
          } else {
            logger.info(`[${ts()}] [worker] [R67-FIX] Abort with no/minimal content — calling finishError to trigger retry`);
            finishError("Gateway aborted the task");
          }
        } else {
          logger.info(`[${ts()}] [worker] [R67-FIX] Abort received but task already resolved — ignoring`);
        }
        return;
      }
      // [R67] Duplicate abort block removed
      // ─── Chat final event ───
      if (msg.event === "chat" && p.state === "final") {
        const msgModel = p.message?.model || "";
        if (msgModel === "gateway-injected") {
          gatewayInjectedCount++;
          const injectedText = Array.isArray(p.message?.content)
            ? p.message.content.filter(c => c.type === "text").map(c => c.text).join(" ")
            : (typeof p.message?.content === "string" ? p.message.content : "");
          logger.info(`[${ts()}] [worker] [v3.4] SKIPPING gateway-injected chat:final #${gatewayInjectedCount}: "${injectedText.substring(0, 100)}"`);
          return;
        }

        // Gateway's broadcastChatFinal fires before agent run starts, producing
        // a spurious chat:final with seq:1, empty content, and rawSessionKey
        // (no "agent:main:" prefix). Real agent chat:final events use the
        // canonical key (with "agent:main:" prefix) and seq > 1.
        const isGhostFinal = (
          p.seq === 1 &&
          !fullText &&
          !streamStarted &&
          tracker.toolCount === 0 &&
          !lifecycleEnded &&
          typeof p.sessionKey === "string" &&
          !p.sessionKey.startsWith("agent:main:")
        );

        if (isGhostFinal) {
          logger.info(`[${ts()}] [worker] [v7.0] GHOST chat:final detected (seq:${p.seq}, empty, sessionKey=${p.sessionKey?.substring(0, 30)}). Waiting up to 10s for real agent events...`);
          // Don't resolve yet — wait for real agent events to arrive.
          // Set a fallback timer: if no real events arrive in 20s, resolve as empty.
          if (!ghostFinalTimer) {
            ghostFinalTimer = setTimeout(() => {
              if (!resolved) {
                if (fullText && fullText.length > 0) {
                  logger.info(`[${ts()}] [worker] [v7.0] Ghost final timeout: using accumulated fullText (${fullText.length} chars).`);
                  finishSuccess(fullText);
                } else if (tracker.toolCount > 0) {
                  logger.info(`[${ts()}] [worker] [v7.0] Ghost final timeout: ${tracker.toolCount} tools ran but no text — using summary.`);
                  finishSuccess(`已执行 ${tracker.toolCount} 个工具操作，但未生成文本响应。`);
                } else {
                  logger.info(`[${ts()}] [worker] [v7.0] Ghost final timeout: no real agent events after 10s. Triggering self-heal.`);
                  selfHealAttempted = false; // Allow self-heal inside finishSuccess to run
                  finishSuccess("");
                }
              }
            }, 10000);
          }
          return; // Skip normal chat:final processing
        }

        if (ghostFinalTimer) {
          clearTimeout(ghostFinalTimer);
          ghostFinalTimer = null;
          logger.info(`[${ts()}] [worker] [v7.0] Real chat:final arrived after ghost detection. Proceeding normally.`);
        }


        // via sessionKey prefix matching. Cron heartbeat responses (HEARTBEAT_OK) should not
        // be treated as user message replies.
        const finalSessionKey = p.sessionKey || "";
        if (finalSessionKey.includes("cron:")) {
          const cronFinalText = Array.isArray(p.message?.content)
            ? p.message.content.filter(c => c.type === "text").map(c => c.text).join("")
            : (typeof p.message?.content === "string" ? p.message.content : "");
          logger.info(`[${ts()}] [worker] [v25.21] SKIPPING cron session chat:final (sessionKey=${finalSessionKey.substring(0, 50)}, text="${cronFinalText.substring(0, 30)}")`);
          return;
        }
        fullText = cleanHeartbeat(fullText);
        logger.info(`[${ts()}] [worker] [CHECKPOINT] Chat final: fullText=${fullText.length} chars, tools=${tracker.toolCount}, streamStarted=${streamStarted}`);
        logger.info(`[${ts()}] [worker] [DEBUG-FINAL] chat:final payload: ${JSON.stringify(p).substring(0, 800)}`);
        // F33: Extract usage data from chat:final message
        if (p.message?.usage) {
          gatewayUsage = p.message.usage;
          logger.info(`[${ts()}] [worker] [F33] Extracted usage from chat:final: input=${gatewayUsage.input}, output=${gatewayUsage.output}, total=${gatewayUsage.totalTokens}, cacheRead=${gatewayUsage.cacheRead || 0}, cacheWrite=${gatewayUsage.cacheWrite || 0}`);
        }

        // Extract text from chat:final message.content
        const finalText = extractFinalText(p.message?.content);
        if (finalText) {
          if (!fullText && finalText.length > 0) {
            logger.info(`[${ts()}] [worker] Using chat.final text (${finalText.length} chars) as fallback (fullText was empty)`);
            fullText = finalText;
          } else {
            logger.info(`[${ts()}] [worker] Final message received, keeping accumulated fullText (${fullText.length} chars)`);
          }
        }
        // read the assistant reply directly from Gateway's session JSONL file.
        // This handles the bug where Gateway processes the request (output tokens > 0) but
        // the WS event stream only sends lifecycle events without assistant text deltas.
        if (!fullText && !finalText && tracker.toolCount === 0) {
          logger.info(`[${ts()}] [worker] [v15.3] No text from WS stream or chat:final. Attempting JSONL fallback...`);
          try {
            const jsonlText = await extractAssistantReplyFromJsonl(sessionKey);
            if (jsonlText && jsonlText.trim().length > 0) {
              logger.info(`[${ts()}] [worker] [v15.3] JSONL fallback recovered ${jsonlText.length} chars`);
              fullText = jsonlText;
              // Stream the recovered text to frontend so user sees the response
              if (!streamStarted) {
                streamId = `stream-${msgId}-${Date.now()}`;
                sendEvent(msgId, { type: "stream_start", id: streamId });
                streamStarted = true;
              }
              const processedRecovery = rewriteWorkspacePaths(jsonlText);
              sendEvent(msgId, { type: "stream_delta", id: streamId, delta: processedRecovery });
            } else {
              logger.info(`[${ts()}] [worker] [v15.3] JSONL fallback also empty`);
            }
          } catch (jsonlErr) {
            logger.info(`[${ts()}] [worker] [v15.3] JSONL fallback error: ${jsonlErr.message}`);
          }
        }
        if (!fullText && thinkingReceived && tracker.toolCount === 0) {
          logger.info(`[${ts()}] [worker] [v15.2] THINK-ONLY response detected: thinking events received but no visible text output. Treating as empty for retry.`);
        }
        // to ensure the last chunk is processed before stream_end
        const CHAT_FINAL_BASE_DELAY = 1000;
        const CHUNK_DRAIN_DELAY = 50; // ms to wait after last chunk
        const timeSinceLastChunk = lastChunkAt ? Date.now() - lastChunkAt : Infinity;
        const extraDelay = (timeSinceLastChunk < CHAT_FINAL_BASE_DELAY) ? CHUNK_DRAIN_DELAY : 0;
        const totalDelay = CHAT_FINAL_BASE_DELAY + extraDelay;
        if (extraDelay > 0) {
          logger.info(`[${ts()}] [worker] [v23.0] Last chunk was ${timeSinceLastChunk}ms ago, adding ${extraDelay}ms drain delay (total: ${totalDelay}ms)`);
        }
        // v25.21-FIX3: Agentic loop aware finishSuccess
        // If text is very short and no tools tracked, Gateway might be in an agentic loop
        // where the first turn produces minimal text before tool calls.
        // Use a longer delay to detect if more events arrive.
        const isLikelyAgenticFirstTurn = fullText.length < 20 && tracker.toolCount === 0 && agenticTurnCount <= 1;
        const agenticDelay = isLikelyAgenticFirstTurn ? 5000 : totalDelay;
        if (isLikelyAgenticFirstTurn) {
          logger.info(`[${ts()}] [worker] [v25.21-AGENTIC] Short text (${fullText.length} chars), no tools — using ${agenticDelay}ms delay to detect agentic loop`);
        }
        if (chatFinalDelayTimer) clearTimeout(chatFinalDelayTimer);
        chatFinalDelayTimer = setTimeout(() => {
          chatFinalDelayTimer = null;
          if (!resolved) {
            if (fullText || tracker.toolCount > 0) {
              finishSuccess(fullText);
            } else {
              finishSuccess("");
            }
          }
        }, agenticDelay);
      }
    }, gatewaySessionKey);
  });
}

