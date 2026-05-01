// ─── OpenClaw Handler: Orchestration Layer ───
// v3.10: Added stream delta filter for technical content (filterStreamDelta)
// v3.9: Added consecutive-tool-without-text guardrail (GUARDRAIL-PROGRESS)
// v3.8: Refactored from 747-line monolith into orchestration layer.
// Delegates to:
//   - tool-tracker.mjs: Tool lifecycle, anti-loop, media detection
//   - stream-processor.mjs: Text cleaning, truncation detection, media append
//   - self-healer.mjs: Tool summary, truncation continuation, session rebuild
//
// This file retains the same external API: handleViaOpenClaw(userMessage, sessionKey, msgId, options, deps)
// Returns: Promise<string> (the AI response text)

import { sendStep, updateStep, sendEvent } from "./ipc-utils.mjs";
import {
  sanitizeForFrontend, estimateTokens, rewriteWorkspacePaths
} from "./format-utils.mjs";
import { createToolTracker } from "./tool-tracker.mjs";
import {
  detectTruncation, cleanHeartbeat, extractFinalText, appendMediaToText, createStreamFilter, cleanFinalText
} from "./stream-processor.mjs";
import {
  requestToolSummary, continueTruncation
} from "./self-healer.mjs";
import fs from 'node:fs';
import path from 'node:path';
import { setCurrentRunId } from "./run-tracker.mjs"; // v9.0: Track runId for precise abort
import { processTextForPlan, cleanupPlan, getSerializablePlan } from "./task-planner.mjs"; // v11.0: Task plan parsing

// ─── Long Output Auto-Document ───
const LONG_OUTPUT_THRESHOLD = 8000; // chars - auto-save as file when exceeded (raised from 3000 to avoid saving normal-length replies)
const WORKSPACE_DIR = "/home/admin/.openclaw/workspace";
const WORKSPACE_URL = "https://ranger.voyage/workspace";

// ─── API Rate Limiting ───
// v10.2: Prevent API abuse by rate-limiting API calls
const MIN_API_INTERVAL_MS = 2000; // Minimum 2 seconds between chat.send calls
let lastApiCallTime = 0;
async function rateLimitedApiCall() {
  const now = Date.now();
  const elapsed = now - lastApiCallTime;
  if (elapsed < MIN_API_INTERVAL_MS && lastApiCallTime > 0) {
    const waitMs = MIN_API_INTERVAL_MS - elapsed;
    console.log(`[${new Date().toISOString()}] [worker] [RATE-LIMIT] Waiting ${waitMs}ms before next API call`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  lastApiCallTime = Date.now();
}

// ─── Progress Guardrail Config ───
// P0-FIX v10.0: Raised thresholds to reduce guardrail frequency (was 3/6, caused lane queue flooding)
const CONSECUTIVE_TOOL_NO_TEXT_THRESHOLD = 15; // Soft reminder after N consecutive tool calls without text output (v8.0: raised from 8)
const CONSECUTIVE_TOOL_NO_TEXT_HARD_LIMIT = 30; // Hard reminder after N consecutive tool calls without text (v8.0: raised from 15)

function saveLongOutputAsFile(text, msgId) {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
    const filename = `report_${dateStr}_${timeStr}.md`;
    const filepath = path.join(WORKSPACE_DIR, filename);
    fs.writeFileSync(filepath, text, "utf-8");
    const fileUrl = `${WORKSPACE_URL}/${filename}`;
    console.log(`[${new Date().toISOString()}] [worker] [LONG-OUTPUT] Saved ${text.length} chars to ${filepath}`);
    return { filename, filepath, fileUrl };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] [worker] [LONG-OUTPUT] Failed to save file: ${err.message}`);
    return null;
  }
}

/**
 * @param {string} userMessage
 * @param {string} sessionKey
 * @param {string} msgId
 * @param {object} options - { timeout, abortController, thinking, roleSystemPrompt, needsStrongModel, strongModel }
 * @param {object} deps   - { gateway, browserBreaker } injected from index
 * @returns {Promise<string>}
 */
export async function handleViaOpenClaw(userMessage, sessionKey, msgId, options = {}, deps = {}) {
  // v6.2: Gateway sessions.patch requires full key with agent:main: prefix
  const gatewaySessionKey = sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;
  const { gateway, browserBreaker } = deps;
  const TIMEOUT_MS = options.timeout || 3600000; // 60 min default (v8.0: raised from 20min for complex autonomous dev tasks)
  const TOOL_TIMEOUT_MS = 5400000; // 90 min timeout when tools are actively running (v8.0: raised from 30min for long dev tasks)
  let toolsActiveCount = 0; // Track number of tools currently executing
  const toolIdMap = new Map(); // FIX: Map tool data.id → frontend toolId so tool_end can match tool_start
  const toolNameIdStack = new Map(); // FIX v2: Map toolName → [toolId, ...] stack for tools without data.id
  const abortController = options.abortController || new AbortController();
  const { signal } = abortController;
  const ts = () => new Date().toISOString();

  // 控制台会话（openclaw-control-ui）可能触发重复回放/重试；禁用进度刷屏类 guardrail 注入
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

  // ─── Step 2: Send chat request ───
  const thinkStepId = sendStep(msgId, "AI 思考中", "running", "RangerAI");
  sendEvent(msgId, { type: "status", status: "thinking" });

  // Fix P1-2: Use crypto.randomUUID() for collision-free idempotency keys
  const idempotencyKey = `ranger-${crypto.randomUUID()}`;

  let payload;
  try {
    const roleSystemPrompt = options.roleSystemPrompt || null;

    // Inject browser circuit breaker warning
    let browserWarning = "";
    if (browserBreaker && browserBreaker.state === "OPEN") {
      // v14.6: KV-Cache optimization — quantize cooldown to fixed buckets
      // Avoids per-second variation that breaks prompt prefix caching
      const rawCooldown = browserBreaker.nextAttemptAt
        ? Math.max(0, Math.round((browserBreaker.nextAttemptAt - Date.now()) / 1000))
        : 0;
      const cooldownBucket = rawCooldown <= 15 ? "15秒" 
        : rawCooldown <= 30 ? "30秒"
        : rawCooldown <= 60 ? "1分钟" 
        : rawCooldown <= 120 ? "2分钟"
        : "数分钟";
      browserWarning = `[SYSTEM] \u26A0\uFE0F browser 工具当前不可用（连续失败已触发熔断，冷却剩余约${cooldownBucket}）。请使用 web_fetch / web_search / exec+curl 替代，不要调用 browser 工具。\n\n`;
      console.log(`[${ts()}] [worker] Injecting browser-circuit-open warning into prompt`);
    }

    const effectiveMessage = roleSystemPrompt
      ? `${browserWarning}[ROLE_CONTEXT]\n${roleSystemPrompt}\n[/ROLE_CONTEXT]\n\n${userMessage}`
      : `${browserWarning}${userMessage}`;

    // v5.0: Pass thinking level via chat.send
    // DEFENSIVE: Only use 'thinking' key (never 'thinkingLevel' — Gateway rejects it)
    const thinkingLevel = options.thinking || 'high'; // Default to high for quality

    // v5.0: Dynamic model upgrade via sessions.patch
    // If task needs a strong model (e.g., code/reasoning), temporarily switch session model
    let modelUpgraded = false;
    if (options.needsStrongModel && options.strongModel) {
      try {
        await gateway.request("sessions.patch", {
          key: gatewaySessionKey,
          model: options.strongModel
        });
        modelUpgraded = true;
        console.log(`[${ts()}] [worker] [v5.0] Model UPGRADED to ${options.strongModel} for this task`);
      } catch (patchErr) {
        console.log(`[${ts()}] [worker] [v5.0] sessions.patch model upgrade failed: ${patchErr.message}. Continuing with default model.`);
      }
    }

    const chatSendParams = {
      sessionKey,
      message: effectiveMessage,
      deliver: false,
      idempotencyKey,
      thinking: thinkingLevel  // Always send thinking level
    };
    // DEFENSIVE: Ensure no 'thinkingLevel' key exists (Gateway bug workaround)
    delete chatSendParams.thinkingLevel;
    console.log(`[${ts()}] [worker] [v5.0] Sending with thinking: ${thinkingLevel}, modelUpgraded: ${modelUpgraded}`);
    // v10.2: Rate limit API calls to prevent abuse
    await rateLimitedApiCall();
    payload = await gateway.request("chat.send", chatSendParams);
  } catch (err) {
    updateStep(msgId, thinkStepId, "error", sanitizeForFrontend(err.message));
    throw err;
  }

  console.log(`[${ts()}] [worker] chat.send response: ${JSON.stringify(payload).substring(0, 500)}`);
  const runId = payload.runId;
  setCurrentRunId(runId, sessionKey); // v9.0: Track runId for precise preemptive abort
  console.log(`[${ts()}] [worker] Run started: ${runId}`);

  // ─── Step 3: Listen for events and relay to frontend ───
  return new Promise((resolve, reject) => {
    // Create tool tracker for this run
    const tracker = createToolTracker(msgId);

    // Create stream filter for this run (filters technical content from AI text output)
    const streamFilter = createStreamFilter();

    // Stream state
    let fullText = "";
    // GUARDRAIL-LANG v4: 基于 fullText 窗口的英文检测
    let engBufferCount = 0;
    let engSuppressMode = false;
    let engSuppressedChunks = []; // 缓冲被抑制的中文内容
    let streamStarted = false;
    let resolved = false;
    let lifecycleEnded = false;
    let ghostFinalTimer = null; // v7.0: Timer for ghost chat:final detection
    let selfHealAttempted = false;
  let selfHealInProgress = false; // v6.3: Lock to prevent concurrent self-heal
    let gatewayInjectedCount = 0;
    const streamId = `stream-${Date.now()}`;
    // F33: Gateway token usage accumulator
    let gatewayUsage = null;

    // ─── GUARDRAIL-PROGRESS: Track consecutive tool calls without text output ───
    let toolsSinceLastText = 0;       // Reset to 0 whenever AI outputs text
    let progressReminderCount = 0;    // How many reminders we've injected this run
    let lastTextOutputAt = Date.now(); // Timestamp of last text output
    let lastProgressReminderAt = 0; // Timestamp of last injected progress reminder (recurring throttle)

    // Inactivity timeout
    let lastActivityAt = Date.now();
    async function handleTimeout() {
      if (resolved) {
        console.log(`[${ts()}] [worker] [v8.0] TIMEOUT fired but already resolved — ignoring (prevents aborting new run)`);
        return;
      }
      console.log(`[${ts()}] [worker] [TIMEOUT] Inactivity timeout (${TIMEOUT_MS / 1000}s). fullText=${fullText.length} chars, streamStarted=${streamStarted}, tools=${tracker.toolCount}`);
      if (fullText.length > 50 || tracker.toolCount > 0) {
        console.log(`[${ts()}] [worker] [TIMEOUT] Delivering partial result (${fullText.length} chars) instead of error`);
        // v10.0: Abort Gateway run BEFORE delivering partial result + cooldown
        try {
          await gateway.request("chat.abort", { sessionKey, runId });
          console.log(`[${ts()}] [worker] [v10.0] TIMEOUT abortChat success (runId=${runId}) — waiting 2s cooldown for lane cleanup`);
          await new Promise(r => setTimeout(r, 2000)); // P0-FIX: cooldown for lane release
        } catch (abortErr) {
          console.log(`[${ts()}] [worker] [v10.0] TIMEOUT abortChat failed (non-fatal): ${abortErr.message}`);
        }
        fullText += "\n\n---\n> ⚠️ AI 引擎响应超时，以上为已生成的部分内容。如需完整回复，请发送「继续」。";
        finishSuccess(fullText);
      } else {
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
    const heartbeatTimer = setInterval(() => {
      heartbeatCount++;
      sendEvent(msgId, {
        type: "progress",
        phase: "processing",
        elapsed: Math.floor((Date.now() - lastActivityAt) / 1000),
        heartbeat: heartbeatCount,
        toolCount: tracker.toolCount,
        streamStarted
      });
    }, 10000);

    function cleanup(reason) {
      if (resolved) return;
      console.log(`[${ts()}] [worker] Task ${msgId} cleanup: ${reason}`);
      clearTimeout(timeoutTimer);
      clearInterval(heartbeatTimer);
      gateway.offRunEvents(runId);
      // v9.1: Abort Gateway run when Worker terminates early (tool limit, loop, timeout, guardrail)
      // Only skip abort for "completed" (normal lifecycle end) and "error" (Gateway already knows)
      const WORKER_ABORT_REASONS = ["timeout", "tool_abort", "guardrail_abort", "loop_abort"];
      const needsGatewayAbort = WORKER_ABORT_REASONS.some(r => reason.includes(r)) || 
        (reason !== "completed" && reason !== "error");
      if (needsGatewayAbort && runId && gateway.isConnected) {
        console.log(`[${ts()}] [worker] [v9.1] Cleanup abort: notifying Gateway to release lane (reason=${reason}, runId=${runId})`);
        gateway.request("chat.abort", { sessionKey, runId }).then(() => {
          console.log(`[${ts()}] [worker] [v9.1] Cleanup abort success — lane released`);
          setCurrentRunId(null, sessionKey);
        }).catch(err => {
          console.log(`[${ts()}] [worker] [v9.1] Cleanup abort failed (non-fatal): ${err.message}`);
          setCurrentRunId(null, sessionKey);
        });
      } else {
        setCurrentRunId(null, sessionKey); // v9.0: Clear runId on cleanup
      }
      if (ghostFinalTimer) { clearTimeout(ghostFinalTimer); ghostFinalTimer = null; } // v7.0

      // v5.1: Restore default model — P1-3 fix: 带超时+延迟重试，防止进程崩溃时 session 永久锁在升级模型
      // Note: cleanup() is sync, so we use Promise chain (no await)
      // v7.3: Removed model restore - modelOverride persists across turns
      if (modelUpgraded) {
        console.log(`[${ts()}] [worker] [v7.3] Keeping modelOverride persistent (no restore)`);
      }
    }

    // ─── Finish handlers ───
    async function finishSuccess(text) {
      if (resolved) return;
      // v8.0: Clear timeout timer to prevent stale timer from aborting future runs
      clearTimeout(timeoutTimer);

      const hasText = text && text.trim().length > 0;
      const hasTools = tracker.toolCount > 0;
      const summary = tracker.getSummary();

      console.log(`[${ts()}] [worker] [CHECKPOINT] Response validation: text=${hasText ? text.length + "chars" : "EMPTY"}, tools=${summary.toolCount}, selfHealAttempted=${selfHealAttempted}, progressReminders=${progressReminderCount}`);

      // SELF-HEAL: Tools ran but no text reply -> request summary
      // v6.3: Added selfHealInProgress lock to prevent concurrent self-heal from lifecycle:end timeout
      if (!hasText && hasTools && !selfHealAttempted && !selfHealInProgress) {
        selfHealInProgress = true; // v6.3: Lock
        console.log(`[${ts()}] [worker] [CHECKPOINT] FAILED: ${summary.toolCount} tools executed but no text. Triggering self-heal...`);
        sendEvent(msgId, { type: "thinking", content: `\u2705 ${summary.toolCount} 个工具操作完成，正在生成总结...\n` });
  
        const healResult = await requestToolSummary(
          sessionKey, msgId, summary.toolCount, summary.toolNames,
          deps, { streamStarted, streamId }
        );
        if (healResult && healResult.text && healResult.text.trim().length > 0) {
          console.log(`[${ts()}] [worker] [SELF-HEAL] Got summary (${healResult.text.length} chars), using as reply`);
          fullText = healResult.text;
          text = healResult.text;
          streamStarted = healResult.streamStarted;
        } else {
          console.log(`[${ts()}] [worker] [SELF-HEAL] Summary also empty, using fallback message`);
          text = `\u2705 已执行 ${summary.toolCount} 个工具操作（${summary.uniqueTools.join("\u3001")}）。\n\nAI 完成了工具调用但未能生成文本总结。请查看上方的工具执行详情，或发送「继续」获取结果总结。`;
        }
      }
        selfHealInProgress = false; // v6.3: Release lock
        selfHealAttempted = true; // v6.3: Mark as attempted

      // SELF-HEAL: Truncation detection (Layer-2 fix: pass attempt count to continueTruncation)
      if (text && detectTruncation(text) && tracker.toolCount === 0 && !selfHealAttempted) {
        console.log(`[${ts()}] [worker] [CHECKPOINT] Possible truncation detected (text length: ${text.length})`);
        selfHealAttempted = true;

        const contResult = await continueTruncation(
          sessionKey, msgId, deps, { streamStarted, streamId }, 1 // explicit attempt=1 (Layer-1 will retry internally)
        );
        if (contResult && contResult.text && contResult.text.trim().length > 0) {
          console.log(`[${ts()}] [worker] [SELF-HEAL] Got continuation: ${contResult.text.length} chars`);
          text += contResult.text;
          fullText = text;
          streamStarted = contResult.streamStarted;
          // Layer-2: Check if the continuation itself is still truncated
          if (detectTruncation(contResult.text)) {
            console.log(`[${ts()}] [worker] [SELF-HEAL] Continuation also truncated — appending hint`);
            text += "\n\n---\n> ⚠️ 内容较长，回复已分段。如需继续，请发送「继续」。";
          }
        } else {
          console.log(`[${ts()}] [worker] [SELF-HEAL] All continuation attempts failed, adding truncation warning`);
          text += "\n\n---\n> \u26A0\uFE0F 回复可能被截断。如需完整内容，请发送「继续」。";
        }
      }

      // Append media images to text
      text = appendMediaToText(text || "", summary.mediaImages);

      // ─── Long Output: Auto-save as document when text is too long ───
      if (text && text.length > LONG_OUTPUT_THRESHOLD) {
        console.log(`[${ts()}] [worker] [LONG-OUTPUT] Text length ${text.length} exceeds threshold ${LONG_OUTPUT_THRESHOLD}, saving as document`);
        const fileInfo = saveLongOutputAsFile(text, msgId);
        if (fileInfo) {
          // Append download link to the text
          text += `\n\n---\n📄 **完整内容已保存为文档：** [${fileInfo.filename}](${fileInfo.fileUrl})`;
          // Send file_changed event so FilePanel opens
          sendEvent(msgId, { type: "file_changed", path: fileInfo.filename, action: "created" });
        }
      }

      // v3.10: Flush stream filter buffer and clean final text
      const flushed = streamFilter.flush();
      text = cleanFinalText(text);

      // Mark as resolved and send final events
      resolved = true;
      cleanup("completed");

      const processedText = rewriteWorkspacePaths(text);
      if (streamStarted) {
        sendEvent(msgId, { type: "stream_end", id: streamId, content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(text) });
      } else if (text) {
        sendEvent(msgId, { type: "message_done", content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(text) });
      }

      updateStep(msgId, thinkStepId, "completed", text.length > 0 ? `${text.length} 字` : "已完成");
      sendEvent(msgId, { type: "status", status: "idle" });
      sendEvent(msgId, { type: "stats", toolCalls: summary.toolCount, tokens: estimateTokens(text) });
      // v11.0: Emit plan completion and cleanup
      try {
        const finalPlan = getSerializablePlan(msgId);
        if (finalPlan) {
          sendEvent(msgId, { type: "plan_completed", plan: finalPlan });
          console.log(`[${ts()}] [worker] [task-planner] Plan completed: ${finalPlan.completedPhases}/${finalPlan.totalPhases} phases`);
        }
        cleanupPlan(msgId);
      } catch (planErr) {
        console.log(`[${ts()}] [worker] [task-planner] Cleanup error: ${planErr.message}`);
      }
      console.log(`[${ts()}] [worker] [F15-DEBUG] Final stats: text.length=${text.length}, estimateTokens=${estimateTokens(text)}`);
      // F33: Fetch Gateway usage from session JSONL (optimized: grep instead of 16MB JSON parse)
      if (!gatewayUsage && sessionKey) {
        try {
          const rawKey = sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;
          const _fs = await import("fs");
          const { execSync } = await import("child_process");
          const sessionsDir = "/home/admin/.openclaw/agents/main/sessions";
          // Step 1: Use grep to find sessionId for this key (avoids parsing 16MB JSON)
          let sessionId = null;
          try {
            // grep for the key, then extract the next sessionId line
            const grepResult = execSync(
              `grep -A1 '"${rawKey}"' ${sessionsDir}/sessions.json | grep sessionId | head -1`,
              { encoding: "utf8", timeout: 3000 }
            ).trim();
            const match = grepResult.match(/"sessionId":\s*"([^"]+)"/);
            if (match) sessionId = match[1];
          } catch (_grepErr) {
            // grep may fail if key not found - that's ok
          }
          // Step 2: Read the JSONL file for this session
          if (sessionId) {
            const jsonlPath = `${sessionsDir}/${sessionId}.jsonl`;
            if (_fs.existsSync(jsonlPath)) {
              const lines = _fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
              for (let i = lines.length - 1; i >= 0; i--) {
                try {
                  const event = JSON.parse(lines[i]);
                  if (event.type === "message" && event.message?.role === "assistant" && event.message?.usage) {
                    const u = event.message.usage;
                    gatewayUsage = { input: u.input || 0, output: u.output || 0, totalTokens: u.totalTokens || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, cost: u.cost || null, source: "session.jsonl" };
                    console.log(`[${ts()}] [worker] [F33] Usage from JSONL: input=${gatewayUsage.input}, output=${gatewayUsage.output}, total=${gatewayUsage.totalTokens}, cost=${JSON.stringify(u.cost)}`);
                    break;
                  }
                } catch (_) {}
              }
            }
          }
          // Fallback: if no JSONL usage, try grep for token counts from sessions.json
          if (!gatewayUsage && sessionId) {
            try {
              const grepTokens = execSync(
                `grep -A20 '"${rawKey}"' ${sessionsDir}/sessions.json | head -25`,
                { encoding: "utf8", timeout: 3000 }
              );
              const inMatch = grepTokens.match(/"inputTokens":\s*(\d+)/);
              const outMatch = grepTokens.match(/"outputTokens":\s*(\d+)/);
              const totalMatch = grepTokens.match(/"totalTokens":\s*(\d+)/);
              if (inMatch || outMatch) {
                gatewayUsage = {
                  input: parseInt(inMatch?.[1] || "0"),
                  output: parseInt(outMatch?.[1] || "0"),
                  totalTokens: parseInt(totalMatch?.[1] || "0"),
                  source: "sessions.json.grep"
                };
                console.log(`[${ts()}] [worker] [F33] Usage from sessions.json (grep): input=${gatewayUsage.input}, output=${gatewayUsage.output}`);
              }
            } catch (_) {}
          }
        } catch (usageErr) {
          console.log(`[${ts()}] [worker] [F33] Failed to fetch Gateway usage: ${usageErr.message}`);
        }
      }

      resolve({ text, gatewayUsage });
    }

    function finishError(errMsg) {
      if (resolved) return;
      resolved = true;
      cleanup("error");

      if (fullText.length > 100) {
        const processedText = rewriteWorkspacePaths(fullText);
        if (streamStarted) {
          sendEvent(msgId, { type: "stream_end", id: streamId, content: processedText, model: "RangerAI", provider: "rangerai", tokens: estimateTokens(fullText) });
        }
        updateStep(msgId, thinkStepId, "completed", `${fullText.length} 字 (部分)`);
        sendEvent(msgId, { type: "status", status: "idle" });
        resolve({ text: fullText, gatewayUsage });
      } else {
        // FIX: Always send error event to frontend so it can exit streaming state
        if (streamStarted) {
          sendEvent(msgId, { type: "stream_end", id: streamId, content: rewriteWorkspacePaths(fullText || ""), model: "RangerAI", provider: "rangerai" });
        }
        sendEvent(msgId, { type: "error", message: sanitizeForFrontend(errMsg).substring(0, 200) });
        sendEvent(msgId, { type: "status", status: "idle" });
        updateStep(msgId, thinkStepId, "error", sanitizeForFrontend(errMsg).substring(0, 80));
        reject(new Error(errMsg));
      }
    }

    // ─── Event handler ───
    gateway.onRunEvents(runId, async (msg) => {
      resetTimeout();
      console.log(`[${ts()}] [worker] [DEBUG] Event received: event=${msg.event} stream=${msg.payload?.stream} phase=${msg.payload?.data?.phase} state=${msg.payload?.state} runId=${msg.payload?.runId}`);
      const p = msg.payload;
      const stream = p.stream;
      const data = p.data;

      if (msg.event === "agent") {
        // ─── Lifecycle events ───
        if (stream === "lifecycle") {
          // v7.0: Real agent event arrived — cancel ghost final timer
          if (ghostFinalTimer) {
            clearTimeout(ghostFinalTimer);
            ghostFinalTimer = null;
            console.log(`[${ts()}] [worker] [v7.0] Real lifecycle event received. Ghost final timer cancelled.`);
          }
          if (data.phase === "end") {
            lifecycleEnded = true;
            console.log(`[${ts()}] [worker] [CHECKPOINT] Lifecycle end: fullText=${fullText.length} chars, tools=${tracker.toolCount}, streamStarted=${streamStarted}`);
            setTimeout(() => {
              if (!resolved) {
                console.log(`[${ts()}] [worker] [CHECKPOINT] chat:final not received within 15s after lifecycle:end. fullText=${fullText.length}, tools=${tracker.toolCount}`);
                finishSuccess(fullText);
              }
            }, 15000);
          }
          if (data.phase === "error" || data.phase === "failed") {
            const errMsg = data.error || data.message || "Agent error";
            console.log(`[${ts()}] [worker] [CHECKPOINT] Lifecycle error: ${errMsg}`);
            finishError(`terminated: ${errMsg}`);
          }
        }

        // ─── Text stream events ───
        if (stream === "text" || stream === "assistant") {
          const delta = data.delta || "";
          console.log(`[${ts()}] [worker] [DELTA-DIAG] stream=${stream} delta_len=${delta.length} delta_preview="${delta.substring(0, 80)}" fullText_len=${fullText.length}`);
          if (delta) {
            if (!streamStarted) {
              streamStarted = true;
              // v7.0: Real text stream started — cancel ghost final timer
              if (ghostFinalTimer) {
                clearTimeout(ghostFinalTimer);
                ghostFinalTimer = null;
                console.log(`[${ts()}] [worker] [v7.0] Real text stream started. Ghost final timer cancelled.`);
              }
              sendEvent(msgId, { type: "stream_start", id: streamId, provider: "rangerai", model: "RangerAI" });
              updateStep(msgId, thinkStepId, "running", "正在生成回复...");
            }
            const cleanDelta = cleanHeartbeat(delta).replace(/\|$/, "");
            if (cleanDelta) {
              // ─── v3.10: Filter technical content before sending to frontend ───
              const filteredDelta = streamFilter.filter(cleanDelta);
              fullText += cleanDelta; // fullText keeps everything for self-heal/summary
              // ─── v11.0: Task Plan Parsing ───
              try {
                processTextForPlan(msgId, fullText, cleanDelta);
              } catch (planErr) {
                console.log(`[${ts()}] [worker] [task-planner] Error: ${planErr.message}`);
              }
              // ─── GUARDRAIL-PROGRESS: Reset counter when AI outputs text ───
              toolsSinceLastText = 0;
              lastTextOutputAt = Date.now();
              console.log(`[${ts()}] [worker] [DELTA-SEND] cleanDelta_len=${cleanDelta.length} filtered_len=${filteredDelta.length} cleanDelta_preview="${cleanDelta.substring(0, 80)}" total_fullText=${fullText.length}`);
              // === GUARDRAIL-LANG v5: DISABLED ===
              // v3 和 v4 都导致了严重的中文内容丢失问题
              // 英文检测+抑制机制在技术讨论场景下弊大于利，完全禁用
              // 语言控制改为纯依赖 SOUL.md 系统提示词
              if (false && !engSuppressMode) {
                // 检查是否需要进入抑制模式
                if (fullText.length > 200) {
                  const sample = fullText.slice(-400);
                  const engChars = (sample.match(/[a-zA-Z]/g) || []).length;
                  const cjkChars = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
                  const total = sample.replace(/\s/g, '').length;
                  // 只有当英文字母占比 > 70% 且中文极少（< 5%）时才进入抑制
                  // 这样技术讨论中的代码片段不会误触发
                  if (total > 50 && engChars / total > 0.70 && cjkChars / total < 0.05) {
                    engSuppressMode = true;
                    engSuppressedChunks = [];
                    console.log(`[${ts()}] [worker] [GUARDRAIL-LANG-v4] 进入英文抑制模式 (英文 ${(engChars/total*100).toFixed(0)}%, 中文 ${(cjkChars/total*100).toFixed(0)}%, fullText=${fullText.length})`);
                    // 注入中文切换指令
                    if (!isControlUI) gateway.request("chat.send", {
                      sessionKey,
                      message: "[SYSTEM_FORCE][HIDDEN] 你正在用英文回复用户。这严重违反了 SOUL.md 最高优先级指令。立即停止英文输出，从下一句开始全部使用简体中文。标题、选项、分析段落全部用中文。违反=任务失败。",
                      deliver: false,
                      idempotencyKey: `guardrail-lang-${Date.now()}`
                    }).catch(err => console.log(`[${ts()}] [worker] [GUARDRAIL-LANG-v4] inject failed: ${err.message}`));
                  }
                }
              } else {
                // 抑制模式下：基于 fullText 最近 200 字符检查是否应退出
                const recentWindow = fullText.slice(-200);
                const recentCjk = (recentWindow.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
                const recentTotal = recentWindow.replace(/\s/g, '').length;
                if (recentTotal > 20 && recentCjk / recentTotal > 0.25) {
                  engSuppressMode = false;
                  console.log(`[${ts()}] [worker] [GUARDRAIL-LANG-v4] 退出英文抑制模式 (近200字符中文比例 ${(recentCjk/recentTotal*100).toFixed(0)}%)`);
                  // 释放缓冲的内容
                  if (engSuppressedChunks.length > 0) {
                    const buffered = engSuppressedChunks.join('');
                    sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(buffered) });
                    console.log(`[${ts()}] [worker] [GUARDRAIL-LANG-v4] 释放缓冲内容 ${buffered.length} chars`);
                    engSuppressedChunks = [];
                  }
                }
              }
              
              // v4: Send filtered delta to frontend (skip if empty or in suppress mode)
              if (filteredDelta && !engSuppressMode) {
                sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(filteredDelta) });
              } else if (engSuppressMode && filteredDelta) {
                engBufferCount += filteredDelta.length;
                engSuppressedChunks.push(filteredDelta);
                // 安全阀：缓冲超过 500 字符时强制释放（防止大量内容丢失）
                if (engBufferCount > 500) {
                  engSuppressMode = false;
                  const buffered = engSuppressedChunks.join('');
                  sendEvent(msgId, { type: "stream_chunk", content: rewriteWorkspacePaths(buffered) });
                  console.log(`[${ts()}] [worker] [GUARDRAIL-LANG-v4] 安全阀触发：缓冲 ${engBufferCount} chars 强制释放`);
                  engSuppressedChunks = [];
                  engBufferCount = 0;
                }
                console.log(`[${ts()}] [worker] [GUARDRAIL-LANG-v4] 内容缓冲中 (${engBufferCount} chars): "${filteredDelta.substring(0, 60)}"`);
              } else if (!filteredDelta) {
                console.log(`[${ts()}] [worker] [STREAM-FILTER] Delta fully filtered out (${cleanDelta.length} chars)`);
              }
            }
          }
        }

        // ─── Tool events (delegated to ToolTracker) ───
        if (stream === "tool") {
          const toolName = data.name || "unknown";

            if (data.phase === "start") {
            // v10.3-debug: Dump browser tool_start data
            if (toolName === "browser") {
              console.log(`[${ts()}] [worker] [v10.3-DUMP] Browser tool_START data keys: ${JSON.stringify(Object.keys(data))}`);
              for (const k of Object.keys(data)) {
                const v = data[k];
                const vStr = typeof v === "string" ? v : JSON.stringify(v);
                console.log(`[${ts()}] [worker] [v10.3-DUMP] START data.${k}: ${(vStr || "").substring(0, 300)}`);
              }
            }
            const result = tracker.handleToolStart(toolName, data);
            toolsActiveCount++;
            resetTimeout(); // Extend timeout during tool execution
            // v10.1: Send tool_start event to frontend so it knows backend is still active
            // This prevents the frontend watchdog from triggering during long tool executions
            const toolId = data.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
            if (data.id) toolIdMap.set(data.id, toolId); // FIX: store mapping for tool_end lookup
            // FIX v2: Also push to name-based stack for tools without data.id
            if (!toolNameIdStack.has(toolName)) toolNameIdStack.set(toolName, []);
            toolNameIdStack.get(toolName).push(toolId);
            sendEvent(msgId, {
              type: "tool_start",
              id: toolId,
              tool: toolName,
              args: data.args || data.input || "",
              toolIndex: tracker.toolCount,
              title: data.title || toolName,
              ...(data.skill ? { skill: data.skill, skillLabel: data.skillLabel, skillCategory: data.skillCategory } : {}),
            });
            if (result.abort) {
              // v9.1: Abort Gateway run BEFORE finishing to release lane
              console.log(`[${ts()}] [worker] [v9.1] Tool-tracker abort: ${result.reason}. Aborting Gateway run ${runId}...`);
              try {
                if (runId && gateway.isConnected) {
                  await gateway.request("chat.abort", { sessionKey, runId });
                  console.log(`[${ts()}] [worker] [v9.1] Tool-tracker Gateway abort success`);
                }
              } catch (abortErr) {
                console.log(`[${ts()}] [worker] [v9.1] Tool-tracker Gateway abort failed: ${abortErr.message}`);
              }
              abortController.abort();
              finishSuccess(fullText || result.fallbackText);
              return;
            }
          }

          // v10.1: Forward tool update/progress events to frontend
          if (data.phase === "update" || data.phase === "progress") {
            // v10.3-debug: Dump browser tool_progress data
            if (toolName === "browser") {
              console.log(`[${ts()}] [worker] [v10.3-DUMP] Browser tool_PROGRESS data keys: ${JSON.stringify(Object.keys(data))}`);
              for (const k of Object.keys(data)) {
                const v = data[k];
                const vStr = typeof v === "string" ? v : JSON.stringify(v);
                console.log(`[${ts()}] [worker] [v10.3-DUMP] PROGRESS data.${k}: ${(vStr || "").substring(0, 300)}`);
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
            toolsActiveCount = Math.max(0, toolsActiveCount - 1);
            resetTimeout(); // Restore timeout after tool completes
            // v10.1: Send tool_end event to frontend
            // v10.3: Extract browser screenshot URLs from tool results
            // v10.3-debug: Log ALL tool names for debugging
            console.log(`[${ts()}] [worker] [v10.3-debug] tool_end: name=${toolName}, phase=${data.phase}, hasResult=${!!(data.result)}, hasOutput=${!!(data.output)}`);
            // v10.3-debug: Dump ALL data keys for browser tools
            if (toolName === "browser") {
              const dataKeys = Object.keys(data);
              console.log(`[${ts()}] [worker] [v10.3-DUMP] Browser data keys: ${JSON.stringify(dataKeys)}`);
              for (const k of dataKeys) {
                const v = data[k];
                const vStr = typeof v === "string" ? v : JSON.stringify(v);
                console.log(`[${ts()}] [worker] [v10.3-DUMP] data.${k} (type=${typeof v}): ${(vStr || "").substring(0, 500)}`);
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
            const toolResult = data.result || data.output || "";
            // v10.3-debug: Log browser tool result details AFTER toolResult is declared
            if (toolName && toolName.includes("browser")) {
              console.log(`[${ts()}] [worker] [v10.3-debug] Browser tool result: type=${typeof toolResult}, len=${String(toolResult).length}, preview=${String(toolResult).substring(0, 500)}`);
            }
            let screenshotUrl = null;
            if (toolName === "browser" || toolName === "browser_navigate" || toolName === "browser_screenshot") {
              // v10.4: Extract screenshot from tool result (object or string)
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
                console.log(`[${ts()}] [worker] [v10.4] Browser screenshot extracted: ${screenshotUrl}`);
              } else {
                console.log(`[${ts()}] [worker] [v10.4] No screenshot found in browser result (type=${typeof toolResult})`);
              }
            }
            sendEvent(msgId, {
              type: "tool_end",
              id: endToolId,
              tool: toolName,
              success: data.phase !== "failed" && !data.error,
              result: toolResult,
              ...(screenshotUrl ? { screenshot: screenshotUrl } : {}),
            });

            // ─── GUARDRAIL-PROGRESS: Consecutive tool calls without text output ───
            // Increment counter on every tool completion
            toolsSinceLastText++;
            const timeSinceText = Date.now() - lastTextOutputAt;
            console.log(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] toolsSinceLastText=${toolsSinceLastText}, timeSinceText=${Math.round(timeSinceText/1000)}s, progressReminders=${progressReminderCount}`);

            // Soft reminder: after N consecutive tool calls without text
            // P0-FIX v10.0: REMOVED chat.send — it floods Gateway lane queue and causes cascading failures
            // Now only sends frontend thinking event (no Gateway interaction)
            if (toolsSinceLastText === CONSECUTIVE_TOOL_NO_TEXT_THRESHOLD) {
              progressReminderCount++;
              console.log(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] Soft reminder #${progressReminderCount}: ${toolsSinceLastText} consecutive tools without text output (frontend-only, no chat.send)`);
              sendEvent(msgId, { type: "thinking", content: `\n📋 已连续执行 ${toolsSinceLastText} 个操作，AI 正在工作中...\n` });
            }

            // Hard reminder: after N consecutive tool calls without text
            // P0-FIX v10.0: REMOVED chat.send — frontend-only notification
            if (toolsSinceLastText === CONSECUTIVE_TOOL_NO_TEXT_HARD_LIMIT) {
              progressReminderCount++;
              console.log(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] HARD reminder #${progressReminderCount}: ${toolsSinceLastText} consecutive tools without text output (frontend-only, no chat.send)`);
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
                console.log(`[${ts()}] [worker] [GUARDRAIL-PROGRESS] Recurring reminder #${progressReminderCount}: ${toolsSinceLastText} consecutive tools without text (frontend-only)`);
                sendEvent(msgId, { type: "thinking", content: `\n⏳ 已连续执行 ${toolsSinceLastText} 个操作，AI 正在处理复杂任务...\n` });
              }
            }

            // ─── Step count guardrails v10.0 (P0-FIX) ───
            // v10.0: REMOVED all chat.send guardrails — they flood Gateway lane queue
            // and cause cascading failures (lane wait 8min+, ghost finals, OOM crashes).
            // Now: frontend-only notifications at 30/45, hard abort at 60.
            const currentToolCount = tracker.toolCount;
            if (currentToolCount === 60) {
              console.log(`[${ts()}] [worker] [GUARDRAIL-v8.0] Tool count reached 60 — frontend-only reminder`);
              sendEvent(msgId, { type: "thinking", content: "\n⚠️ 已执行 60 次工具调用，AI 正在处理复杂任务...\n" });
            } else if (currentToolCount === 100) {
              console.log(`[${ts()}] [worker] [GUARDRAIL-v8.0] Tool count reached 100 — frontend-only warning`);
              sendEvent(msgId, { type: "thinking", content: "\n⚠️ 已执行 100 次工具调用，即将达到上限...\n" });
            } else if (currentToolCount >= 120) {
              // HARD LIMIT v8.0: raised from 60 to 120 for complex autonomous dev tasks
              console.log(`[${ts()}] [worker] [GUARDRAIL-v8.0] Tool count reached ${currentToolCount} — HARD LIMIT, aborting and forcing delivery`);
              sendEvent(msgId, { type: "thinking", content: "\n🛑 工具调用已达上限，正在强制交付当前成果...\n" });
              // P0-FIX v10.0: Abort FIRST, wait for lane release, THEN finish
              // Old approach: setTimeout 3s then abort+finish simultaneously
              // New approach: abort immediately, wait 2s cooldown for lane cleanup, then finish
              (async () => {
                try {
                  if (runId && gateway.isConnected) {
                    console.log(`[${ts()}] [worker] [v10.0] Hard-limit abort: aborting Gateway run ${runId}...`);
                    await gateway.request("chat.abort", { sessionKey, runId });
                    console.log(`[${ts()}] [worker] [v10.0] Hard-limit Gateway abort success. Waiting 2s cooldown for lane cleanup...`);
                  }
                } catch (abortErr) {
                  console.log(`[${ts()}] [worker] [v10.0] Hard-limit Gateway abort failed (non-fatal): ${abortErr.message}`);
                }
                // P0-FIX: 2-second cooldown after abort to ensure Gateway lane is fully released
                await new Promise(r => setTimeout(r, 2000));
                if (!resolved) {
                  const summary = tracker.getSummary();
                  const titleList = (summary.toolTitles || []).slice(-10).map((t, i) => `${i+1}. ${t}`).join("\n");
                  const summaryText = titleList ? `\n\n**已完成的操作步骤：**\n${titleList}` : "";
                  fullText += "\n\n---\n> ⚠️ 已完成 " + currentToolCount + " 步操作。" + summaryText + "\n\n如需继续后续步骤，请发送「继续」，我会从上次中断的地方接着执行。";
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
            sendEvent(msgId, { type: "thinking", content: thinkText });
          }
        }
      }

      // ─── Chat final event ───
      if (msg.event === "chat" && p.state === "final") {
        // v3.4: Skip gateway-injected directive ack events
        const msgModel = p.message?.model || "";
        if (msgModel === "gateway-injected") {
          gatewayInjectedCount++;
          const injectedText = Array.isArray(p.message?.content)
            ? p.message.content.filter(c => c.type === "text").map(c => c.text).join(" ")
            : (typeof p.message?.content === "string" ? p.message.content : "");
          console.log(`[${ts()}] [worker] [v3.4] SKIPPING gateway-injected chat:final #${gatewayInjectedCount}: "${injectedText.substring(0, 100)}"`);
          return;
        }

        // v7.0: Ghost chat:final detection
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
          console.log(`[${ts()}] [worker] [v7.0] GHOST chat:final detected (seq:${p.seq}, empty, sessionKey=${p.sessionKey?.substring(0, 30)}). Waiting up to 10s for real agent events...`);
          // Don't resolve yet — wait for real agent events to arrive.
          // Set a fallback timer: if no real events arrive in 20s, resolve as empty.
          if (!ghostFinalTimer) {
            ghostFinalTimer = setTimeout(() => {
              if (!resolved && !streamStarted && !fullText && tracker.toolCount === 0) {
                console.log(`[${ts()}] [worker] [v7.0] Ghost final timeout: no real agent events after 10s. Resolving as empty.`);
                finishSuccess("");
              }
            }, 10000);
          }
          return; // Skip normal chat:final processing
        }

        // v7.0: If we had a ghost final timer running and real chat:final arrived, clear it
        if (ghostFinalTimer) {
          clearTimeout(ghostFinalTimer);
          ghostFinalTimer = null;
          console.log(`[${ts()}] [worker] [v7.0] Real chat:final arrived after ghost detection. Proceeding normally.`);
        }


        fullText = cleanHeartbeat(fullText);
        console.log(`[${ts()}] [worker] [CHECKPOINT] Chat final: fullText=${fullText.length} chars, tools=${tracker.toolCount}, streamStarted=${streamStarted}`);
        console.log(`[${ts()}] [worker] [DEBUG-FINAL] chat:final payload: ${JSON.stringify(p).substring(0, 800)}`);
        // F33: Extract usage data from chat:final message
        if (p.message?.usage) {
          gatewayUsage = p.message.usage;
          console.log(`[${ts()}] [worker] [F33] Extracted usage from chat:final: input=${gatewayUsage.input}, output=${gatewayUsage.output}, total=${gatewayUsage.totalTokens}`);
        }

        // Extract text from chat:final message.content
        const finalText = extractFinalText(p.message?.content);
        if (finalText) {
          if (!fullText && finalText.length > 0) {
            console.log(`[${ts()}] [worker] Using chat.final text (${finalText.length} chars) as fallback (fullText was empty)`);
            fullText = finalText;
          } else {
            console.log(`[${ts()}] [worker] Final message received, keeping accumulated fullText (${fullText.length} chars)`);
          }
        }

        // Short delay then finish (allows any trailing events to arrive)
        setTimeout(() => {
          if (!resolved) {
            if (fullText || tracker.toolCount > 0) {
              finishSuccess(fullText);
            } else {
              finishSuccess("");
            }
          }
        }, 1000);
      }
    });
  });
}
