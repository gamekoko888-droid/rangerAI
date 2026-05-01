// [v25.9.2] Global EPIPE protection
process.stdout.on("error", (err) => { if (err.code === "EPIPE") return; });
process.stderr.on("error", (err) => { if (err.code === "EPIPE") return; });
/**
 * ws-realtime.mjs — WebSocket + Worker Realtime Process (Iter-59)
 *
 * Dedicated process for:
 *   - WebSocket connections (chat, streaming, heartbeat)
 *   - Worker lifecycle management (spawn, restart, IPC)
 *   - ChatOrchestrator (message sending pipeline)
 *   - Real-time event delivery
 *
 * Communicates with api-server.mjs via Redis IPC:
 *   - Publishes worker status every 5s to Redis hash
 *   - Subscribes to commands (restart_worker, recover_browser, cleanup_ws, etc.)
 *
 * @version 1.0.0 — Iter-59: HTTP/WS process separation
 */
import { logger } from "./lib/logger.mjs";
import { initTaskPlansTable } from './services/plan-service.mjs'; // R54
import http from "http";
import fs from "fs";
import { loadEnvFile, loadSecretsJson, loadBootstrap } from "./lib/bootstrap.mjs";
import { ts } from "./modules/helpers.mjs";
import { sendEvent, smartReplayEvents, loadSession, saveSession } from "./modules/helpers.mjs";
import { generateTitle, generateSuggestions, generateHistorySummary, inlineFallback, cleanupAiServices } from "./modules/ai-services.mjs";
import { getAvailableProviders, getAvailableSkills, getAvailableTools, getSystemCapabilities } from "./modules/provider-discovery.mjs";
import { expandFileAttachments } from "./modules/file-handler.mjs";
import { createWsServer } from "./modules/ws-server.mjs";
import { rebindTaskOnReconnect } from "./modules/ws-chat-handlers.mjs";
// [v25.9] import { createTask as svCreateTask, runTask as svRunTask, cancelTask as svCancelTask, getTask as svGetTask, listTasks as svListTasks } from "./worker/supervisor-engine.mjs";
import { redisPool } from "./redis-pool.mjs";
import { initIPC, publishWorkerStatus, publishActiveTasks, sendCommand, publishResponse } from "./lib/redis-ipc.mjs";
import { execSync } from "child_process";
import { startPeriodicCleanup } from "./session-ttl-cleanup.mjs";
// [v25.9] import { updateScheduleResult } from "./services/supervisor-scheduler.mjs";

// ─── Load Environment ────────────────────────────────────────
const RANGERAI_ENV_FILE = process.env.RANGERAI_ENV_FILE || "/opt/rangerai-agent/.env";
const RANGERAI_SECRETS_FILE = process.env.RANGERAI_SECRETS_FILE || "/opt/rangerai-agent/agent-secrets.env";
loadEnvFile(RANGERAI_ENV_FILE);
loadEnvFile(RANGERAI_SECRETS_FILE);
const RANGERAI_SECRETS_JSON = process.env.RANGERAI_SECRETS_JSON || "/opt/rangerai-agent/secrets.json";
const SECRETS = loadSecretsJson(RANGERAI_SECRETS_JSON);
for (const [key, val] of Object.entries(SECRETS)) {
  if (process.env[key] === undefined && typeof val === "string") {
    process.env[key] = val;
  }
}

// ─── WS Port (separate from API port) ───────────────────────
const WS_PORT = parseInt(process.env.WS_PORT || "3005", 10);

// ─── Redis Pool Connect ─────────────────────────────────────
await redisPool.connect();
logger.info(`[${ts()}] [ws-realtime] Redis pool: ${redisPool.isReady() ? "connected" : "degraded"}`);

// ─── Dynamic Imports: auth / monitor / rateLimiter ───────────
const { auth, monitor, rateLimiter } = await loadBootstrap(ts);

// ─── Context Assembly (WS-specific) ─────────────────────────
// We reuse the same setupContext but this process only uses WS-related parts
import { setupContext } from "./lib/context-setup.mjs";

const ctx = await setupContext(
  { auth, monitor, rateLimiter, redisPool },
  {
    sendEvent, smartReplayEvents, loadSession, saveSession,
    getAvailableProviders, getAvailableSkills, getAvailableTools, getSystemCapabilities,
    expandFileAttachments, inlineFallback, generateTitle, generateSuggestions, generateHistorySummary,
  }
);

const { workerManager, eventBuffer, sessions, wsClients, activeTasksBySession } = ctx.runtime;
const { taskStore } = ctx.services;

// ─── Redis IPC: Subscribe to commands from API process ──────
await initIPC({
  role: "ws",
  onCommand: (cmd) => {
    switch (cmd.type) {
      case "restart_worker":
        logger.info(`[ws-realtime] IPC: Restarting worker (requested by API)`);
        workerManager.restartWorker();
        break;
      case "recover_browser":
        logger.info(`[ws-realtime] IPC: Recovering browser (requested by API)`);
        workerManager.recoverBrowser();
        break;
      case "cleanup_ws": {
        // Clean up WS client entries for deleted chats
        const chatIds = cmd.payload?.chatIds || [];
        chatIds.forEach((id) => wsClients.delete(id));
        logger.info(`[ws-realtime] IPC: Cleaned up ${chatIds.length} WS client entries`);
        break;
      }
      case "get_browser_status": {
        // Forward browser status request to worker and relay response back
        const bsReqId = cmd.reqId;
        if (workerManager.worker) {
          const bsHandler = (msg) => {
            if (msg.type === "browser_status" && msg.reqId === (cmd.payload?.reqId || bsReqId)) {
              workerManager.worker.removeListener("message", bsHandler);
              publishResponse(bsReqId, { type: "browser_status", data: msg });
            }
          };
          workerManager.worker.on("message", bsHandler);
          workerManager.worker.send({ type: "get_browser_status", reqId: cmd.payload?.reqId || bsReqId });
          setTimeout(() => workerManager.worker?.removeListener("message", bsHandler), 10000);
        } else {
          publishResponse(bsReqId, { type: "browser_status", error: "Worker not available" });
        }
        break;
      }
      case "reset_browser_breaker": {
        const rbReqId = cmd.reqId;
        if (workerManager.worker) {
          const rbHandler = (msg) => {
            if (msg.type === "browser_breaker_reset" && msg.reqId === (cmd.payload?.reqId || rbReqId)) {
              workerManager.worker.removeListener("message", rbHandler);
              publishResponse(rbReqId, { type: "browser_breaker_reset", data: msg });
            }
          };
          workerManager.worker.on("message", rbHandler);
          workerManager.worker.send({ type: "reset_browser_breaker", reqId: cmd.payload?.reqId || rbReqId });
          setTimeout(() => workerManager.worker?.removeListener("message", rbHandler), 10000);
        } else {
          publishResponse(rbReqId, { type: "browser_breaker_reset", error: "Worker not available" });
        }
        break;
      }
      case "dispatch_task": {
        // Iter-60: API process delegates message pipeline execution to WS process
        // All async work is in the IIFE since cmdHandler() is not awaited
        const dtReqId = cmd.reqId;
        const dtPayload = cmd.payload || {};
        logger.info(`[ws-realtime] IPC: dispatch_task received for msgId=${dtPayload.msgId}, session=${dtPayload.sessionKey}`);
        (async () => {
          const { msgId, sessionKey, content, history, model, attachments, roleSystemPrompt, userId, userRole } = dtPayload;
          try {
            // Find the WS client for this session's chat via DB lookup
            let targetWs = null;
            try {
              const chatRecord = await ctx.db.getChatBySessionKey(sessionKey);
              if (chatRecord) {
                targetWs = wsClients.get(chatRecord.id) || null;
                logger.info(`[ws-realtime] dispatch_task: Found WS for chat ${chatRecord.id}, connected: ${targetWs?.readyState === 1}`);
              }
            } catch (e) {
              logger.info(`[ws-realtime] dispatch_task: DB lookup failed: ${e.message}`);
            }
            if (!targetWs || targetWs.readyState !== 1) {
              logger.info(`[ws-realtime] dispatch_task: No active WS for session ${sessionKey}, proceeding without WS`);
              targetWs = null;
            }
            // Execute the task using the real workerManager
            const reply = await workerManager.sendTask(
              msgId, sessionKey, content, history || [],
              targetWs,
              model, attachments, roleSystemPrompt,
              undefined, undefined, userId, userRole  // F9: pass userId + userRole to worker
            );
            // [P0-2-FIX] Pick up model from side-channel map populated by worker-manager
            const resolvedModel = workerManager.lastModelByMsgId?.get(msgId) || null;
            logger.info(`[ws-realtime] [P0-2-DEBUG] msgId=${msgId} resolvedModel=${resolvedModel} hasMap=${!!workerManager.lastModelByMsgId} replyLen=${reply?.length || 0}`);
            if (resolvedModel) workerManager.lastModelByMsgId.delete(msgId);
            // [R56-FIX] Save assistant message directly in ws-realtime process.
            // PRIMARY save path — ensures messages persist even when api-server
            // restarts mid-task (which causes IPC publishResponse to be lost).
            if (reply && typeof reply === 'string' && reply.length > 0) {
              try {
                const chatRecord = await ctx.db.getChatBySessionKey(sessionKey);
                if (chatRecord) {
                  const estTokens = Math.ceil(reply.length / 2);
                  let toolMetaJson = null;
                  try {
                    const tmMap = workerManager.toolMetadataByMsgId || ctx.runtime?.toolMetadataByMsgId;
                    if (tmMap && tmMap.has(msgId)) {
                      const tm = tmMap.get(msgId);
                      if (tm && (tm.tools?.length > 0 || tm.steps?.length > 0)) {
                        toolMetaJson = JSON.stringify(tm);
                      }
                    }
                  } catch (_) {}
                  await ctx.db.createMessage({
                    chatId: chatRecord.id,
                    role: 'assistant',
                    content: reply,
                    msgId,
                    model: resolvedModel,
                    tokens: estTokens,
                    metadata: toolMetaJson
                  });
                  logger.info(`[ws-realtime] [R56-FIX] Saved assistant reply: chatId=${chatRecord.id} msgId=${msgId} len=${reply.length} model=${resolvedModel}`);
                } else {
                  logger.info(`[ws-realtime] [R56-FIX] No chat for session=${sessionKey}`);
                }
              } catch (dbErr) {
                logger.info(`[ws-realtime] [R56-FIX] DB save failed: ${dbErr.message}`);
              }
            }
            publishResponse(dtReqId, {
              type: "dispatch_task_result",
              reply: reply || null,
              model: resolvedModel,
              dbSaved: true  // [R56-FIX] ws-realtime already saved to DB
            });
          } catch (err) {
            logger.info(`[ws-realtime] dispatch_task failed for ${dtPayload.msgId}: ${err.message}`);
            // P0-5: Fix scoping — reuse variables from outer destructuring, avoid re-declaring targetWs
            let fallbackWs = null;
            try {
              const chatRecord = await ctx.db.getChatBySessionKey(dtPayload.sessionKey);
              if (chatRecord) fallbackWs = wsClients.get(chatRecord.id) || null;
            } catch (_) { /* ignore */ }
            if (typeof inlineFallback === 'function' && fallbackWs && fallbackWs.readyState === 1) {
              try {
                const fallbackReply = await inlineFallback(dtPayload.content, dtPayload.history || [], fallbackWs, sendEvent);
                publishResponse(dtReqId, { type: "dispatch_task_result", reply: fallbackReply || null });
                return;
              } catch (fbErr) {
                logger.info(`[ws-realtime] dispatch_task fallback also failed: ${fbErr.message}`);
              }
            }
            publishResponse(dtReqId, { type: "dispatch_task_error", error: err.message });
          }
        })();
        break;
      }
      case "gateway_proxy": {
        // Forward gateway proxy request to worker and relay response back
        const gpReqId = cmd.reqId;
        if (workerManager.worker) {
          const gpHandler = (msg) => {
            if (msg.type === "gateway_response" && msg.reqId === (cmd.payload?.reqId || gpReqId)) {
              workerManager.worker.removeListener("message", gpHandler);
              publishResponse(gpReqId, { type: "gateway_response", data: msg });
            }
          };
          workerManager.worker.on("message", gpHandler);
          workerManager.worker.send({
            type: "gateway_proxy",
            reqId: cmd.payload?.reqId || gpReqId,
            body: cmd.payload?.body,
          });
          setTimeout(() => workerManager.worker?.removeListener("message", gpHandler), 15000);
        } else {
          publishResponse(gpReqId, { type: "gateway_response", error: "Worker not available" });
        }
        break;
      }

      case "submit_autonomous_task": {
        // [v25.9] Supervisor autonomous task execution removed
        logger.warn("[ws-realtime] submit_autonomous_task is deprecated (supervisor removed)");
        if (typeof publishResponse === "function" && cmd.reqId) {
          publishResponse(cmd.reqId, { type: "autonomous_task_error", error: "Supervisor has been removed" });
        }
        break;
      }
      case "cancel_autonomous_task": {
        // [v25.9] Supervisor cancel removed
        logger.warn("[ws-realtime] cancel_autonomous_task is deprecated (supervisor removed)");
        break;
      }
      case "recover_task": {
        // P0: Explicit task recovery request from frontend
        const recoverMsgId = msg.taskId || msg.msgId;
        const recoverSessionKey = msg.sessionKey || state?.sessionKey;
        logger.info(`[${ts()}] [P0-RECOVER] Explicit recovery request: taskId=${recoverMsgId}, session=${recoverSessionKey}`);
        
        (async () => {
          if (recoverMsgId && ctx.taskStore) {
            try {
              const task = await ctx.taskStore.getTask(recoverMsgId);
              if (task && (task.status === 'running' || task.status === 'started')) {
                // Try to rebind first
                const rebound = rebindTaskOnReconnect(ws, recoverSessionKey);
                if (!rebound) {
                  // Task not in pendingTasks, try full recovery
                  sendEvent(ws, { type: "recovery_status", phase: "recovering", message: "正在恢复中断的任务..." });
                  const resumed = await ctx.taskStore.resumeTask(recoverMsgId);
                  if (resumed) {
                    sendEvent(ws, { type: "recovery_status", phase: "resumed", message: "任务已恢复", taskId: recoverMsgId });
                  } else {
                    sendEvent(ws, { type: "recovery_status", phase: "failed", message: "任务无法恢复" });
                  }
                }
              } else {
                sendEvent(ws, { type: "recovery_status", phase: "not_found", message: "未找到可恢复的任务" });
              }
            } catch (e) {
              sendEvent(ws, { type: "recovery_status", phase: "error", message: `恢复失败: ${e.message}` });
            }
          }
        })();
        break;
      }

      case "send_ws_event": {
        // Iter-61: Forward WS events from api-server to connected clients
        const { chatId: evtChatId, event: evtData } = cmd.payload || {};
        if (evtChatId && evtData) {
          const targetWs = wsClients.get(evtChatId);
          if (targetWs && targetWs.readyState === 1) {
            sendEvent(targetWs, evtData);
            logger.info(`[ws-realtime] IPC: Forwarded ${evtData.type} to chat ${evtChatId}`);
          } else {
            logger.info(`[ws-realtime] IPC: No active WS for chat ${evtChatId} (send_ws_event)`);
          }
        }
        break;
      }
      default:
        logger.warn(`[ws-realtime] IPC: Unknown command type: ${cmd.type}`);
    }
  },
});

// ─── Publish Worker Status Periodically ─────────────────────
const _workerStatusTimer = setInterval(async () => {
  try {
    const wStatus = workerManager.status;
    await publishWorkerStatus({
      workerReady: wStatus.workerReady,
      pendingTasks: wStatus.pendingTasks || 0,
      workerPid: wStatus.workerPid || 0,
      uptime: wStatus.uptime || 0,
      lastActivity: wStatus.lastActivity || "",
      // WorkerPool stats
      poolSize: wStatus.poolSize || 1,
      readyWorkers: wStatus.readyWorkers || 0,
      totalCapacity: wStatus.totalCapacity || 3,
    });

    // Publish active tasks (WorkerPool: aggregates from all workers)
    const activeTasks = [];
    const allPendingTasks = workerManager.pendingTasks;
    if (allPendingTasks) {
      for (const [msgId, task] of allPendingTasks) {
        activeTasks.push({
          msgId,
          sessionKey: task.sessionKey,
          startedAt: task.lastActivityAt,
          hasClient: task.ws !== null && task.ws?.readyState === 1,
          source: "memory",
        });
      }
    }
    await publishActiveTasks(activeTasks);
  } catch (e) {
    // Non-fatal
  }
}, 5000);

// ─── HTTP Server (for WS upgrade + metrics + health) ──────
const server = http.createServer((req, res) => {
  // Health check
  if (req.url === "/ws/health" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const poolStatus = workerManager.status;
    res.end(JSON.stringify({
      status: "ok",
      process: "ws-realtime",
      workerReady: poolStatus.workerReady,
      wsClients: wsClients.size,
      activeTasks: poolStatus.pendingTasks || 0,
      uptime: process.uptime(),
      // WorkerPool stats
      poolSize: poolStatus.poolSize || 1,
      readyWorkers: poolStatus.readyWorkers || (poolStatus.workerReady ? 1 : 0),
      totalCapacity: poolStatus.totalCapacity || 3,
      workers: poolStatus.workers || [],
    }));
    return;
  }

  // Prometheus metrics endpoint
  if (req.url === "/api/metrics" || req.url === "/metrics") {
    // Check bearer token (same auth as API process)
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.ADMIN_TOKEN;
    if (expectedToken && (!authHeader || authHeader !== `Bearer ${expectedToken}`)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const wStatus = workerManager.status;
    const uptimeSec = Math.floor(process.uptime());
    const wsCount = wsClients.size;
    const wsPeak = ctx.runtime.wsConnectionsPeak || wsCount;
    const activeTaskCount = wStatus.pendingTasks || 0;
    const workerPid = wStatus.workerPid || 0;
    const workerReady = wStatus.workerReady ? 1 : 0;
    const workerCrashes = wStatus.restartCount || 0;
    const poolSize = wStatus.poolSize || 1;
    const readyWorkers = wStatus.readyWorkers || (workerReady ? 1 : 0);
    const totalCapacity = wStatus.totalCapacity || 3;
    const memUsage = process.memoryUsage();

    const lines = [
      `# HELP rangerai_ws_uptime_seconds WS process uptime in seconds`,
      `# TYPE rangerai_ws_uptime_seconds gauge`,
      `rangerai_ws_uptime_seconds ${uptimeSec}`,
      ``,
      `# HELP rangerai_ws_connections_active Current active WebSocket connections`,
      `# TYPE rangerai_ws_connections_active gauge`,
      `rangerai_ws_connections_active ${wsCount}`,
      ``,
      `# HELP rangerai_ws_connections_peak Peak WebSocket connections since startup`,
      `# TYPE rangerai_ws_connections_peak gauge`,
      `rangerai_ws_connections_peak ${wsPeak}`,
      ``,
      `# HELP rangerai_ws_active_tasks Current active tasks in Worker`,
      `# TYPE rangerai_ws_active_tasks gauge`,
      `rangerai_ws_active_tasks ${activeTaskCount}`,
      ``,
      `# HELP rangerai_ws_worker_ready Whether the Worker process is ready (1=yes, 0=no)`,
      `# TYPE rangerai_ws_worker_ready gauge`,
      `rangerai_ws_worker_ready ${workerReady}`,
      ``,
      `# HELP rangerai_ws_worker_pid Worker process PID`,
      `# TYPE rangerai_ws_worker_pid gauge`,
      `rangerai_ws_worker_pid ${workerPid}`,
      ``,
      `# HELP rangerai_ws_worker_crashes_total Total Worker crashes since startup`,
      `# TYPE rangerai_ws_worker_crashes_total counter`,
      `rangerai_ws_worker_crashes_total ${workerCrashes}`,
      ``,
      `# HELP rangerai_ws_memory_rss_bytes WS process RSS memory in bytes`,
      `# TYPE rangerai_ws_memory_rss_bytes gauge`,
      `rangerai_ws_memory_rss_bytes ${memUsage.rss}`,
      ``,
      `# HELP rangerai_ws_memory_heap_used_bytes WS process heap used in bytes`,
      `# TYPE rangerai_ws_memory_heap_used_bytes gauge`,
      `rangerai_ws_memory_heap_used_bytes ${memUsage.heapUsed}`,
      ``,
      `# HELP rangerai_ws_memory_heap_total_bytes WS process heap total in bytes`,
      `# TYPE rangerai_ws_memory_heap_total_bytes gauge`,
      `rangerai_ws_memory_heap_total_bytes ${memUsage.heapTotal}`,
      ``,
      `# HELP rangerai_ws_event_loop_lag_ms Estimated event loop lag in ms`,
      `# TYPE rangerai_ws_event_loop_lag_ms gauge`,
      `rangerai_ws_event_loop_lag_ms ${ctx.runtime._eventLoopLag || 0}`,
    ];

    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(lines.join("\n") + "\n");
    return;
  }

  // R60: adaptive-memory stats API handled by admin-routes.mjs (port 3002)
  res.writeHead(404);
  res.end("Not Found — this is the WS-only server");
});

// ─── WebSocket Server ───────────────────────────────────────
const { wss, wsHeartbeatInterval } = createWsServer(server, ctx);

// ─── Signal Handlers ────────────────────────────────────────
process.on("SIGUSR2", () => {
  logger.info(`[${ts()}] [ws-realtime] SIGUSR2 → restarting worker`);
  workerManager.restartWorker();
});

process.on("SIGTERM", async () => {
  // R60-FIX: Improved graceful shutdown — salvage active tasks BEFORE closing WS
  logger.info(`[${ts()}] [ws-realtime] SIGTERM → graceful shutdown (ppid=${process.ppid})`);
  
  // R60-FIX Step 1: Salvage all active tasks and send stream_end BEFORE closing WS
  try {
    const pendingCount = workerManager?.pendingTasks?.size || 0;
    if (pendingCount > 0) {
      logger.info(`[${ts()}] [R60-FIX] ${pendingCount} pending task(s) — salvaging before shutdown`);
      for (const [msgId, task] of workerManager.pendingTasks) {
        try {
          let salvageContent = "";
          if (eventBuffer) {
            const allEvts = eventBuffer.getEvents(msgId, 0);
            const streamEnd = allEvts.find(e => e.type === "stream_end");
            if (streamEnd && streamEnd.content) {
              salvageContent = streamEnd.content;
            } else {
              const chunks = allEvts.filter(e => e.type === "stream_chunk");
              if (chunks.length > 0) salvageContent = chunks.map(c => c.content || "").join("");
            }
            if (!salvageContent) {
              const msgDone = allEvts.find(e => e.type === "message_done");
              if (msgDone && msgDone.content) salvageContent = msgDone.content;
            }
          }
          // Save to DB before it closes
          if (salvageContent && task.sessionKey) {
            try {
              const chatRecord = await ctx.db.getChatBySessionKey(task.sessionKey);
              if (chatRecord) {
                await ctx.db.createMessage({
                  chatId: chatRecord.id, role: "assistant", content: salvageContent, msgId,
                  metadata: JSON.stringify({ partial: true, reason: "service_restart", salvaged: true }),
                });
                logger.info(`[${ts()}] [R60-FIX] Saved partial reply (${salvageContent.length} chars) for ${msgId}`);
              }
            } catch (dbErr) {
              logger.info(`[${ts()}] [R60-FIX] DB save failed for ${msgId}: ${dbErr.message}`);
            }
          }
          // Send stream_end WHILE WS is still open
          if (task.ws?.readyState === 1) {
            const errorSuffix = salvageContent
              ? "\n\n---\n⚠️ 系统正在重启，以上为部分回复。系统恢复后请重新发送以获取完整回复。"
              : "";
            sendEvent(task.ws, {
              type: "stream_end",
              content: salvageContent ? (salvageContent + errorSuffix) : "[系统重启] 任务处理被中断，系统恢复后请重新发送。",
              model: "RangerAI Agent (Restarting)", provider: "rangerai"
            });
            sendEvent(task.ws, { type: "status", status: "idle" });
            logger.info(`[${ts()}] [R60-FIX] Sent stream_end for ${msgId} (salvage=${salvageContent.length} chars)`);
          }
        } catch (taskErr) {
          logger.info(`[${ts()}] [R60-FIX] Error salvaging task ${msgId}: ${taskErr.message}`);
        }
      }
    }
  } catch (e) {
    logger.info(`[${ts()}] [R60-FIX] Error in task salvage: ${e.message}`);
  }
  
  // R60-FIX Step 2: NOW close WS clients (after stream_end has been sent)
  try {
    let closedCount = 0;
    for (const [chatId, ws] of wsClients.entries()) {
      try {
        if (ws.readyState === 1) {
          ws.close(1012, "server_restart");
          closedCount++;
        }
      } catch (e) { /* best-effort per client */ }
    }
    logger.info(`[${ts()}] [ws-realtime] Sent 1012 close to ${closedCount} WS clients`);
  } catch (e) {
    logger.info(`[${ts()}] [ws-realtime] Error closing WS clients: ${e.message}`);
  }
  // Drain worker
  const DRAIN_TIMEOUT_MS = 25000;
  const drainStart = Date.now();
  if (workerManager && workerManager.worker) {
    try {
      workerManager.worker.send({ type: "drain" });
      logger.info(`[${ts()}] [ws-realtime] Sent drain signal to worker`);
    } catch (e) {
      logger.info(`[${ts()}] [ws-realtime] Could not send drain: ${e.message}`);
    }
    await new Promise((resolve) => {
      const onExit = () => {
        logger.info(`[${ts()}] [ws-realtime] Worker exited during drain after ${Date.now() - drainStart}ms`);
        clearTimeout(forceTimer);
        resolve();
      };
      workerManager.worker.once("exit", onExit);
      const forceTimer = setTimeout(() => {
        logger.info(`[${ts()}] [ws-realtime] Drain timeout after ${DRAIN_TIMEOUT_MS}ms`);
        workerManager.worker.removeListener("exit", onExit);
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });
  }
  try { await redisPool.shutdown(); } catch (e) { /* best-effort */ }
  try { await ctx.db.closeDatabase(); } catch (e) { /* best-effort */ }
  clearInterval(wsHeartbeatInterval);
    if (typeof _workerStatusTimer !== 'undefined') clearInterval(_workerStatusTimer);
    if (typeof _taskStoreCleanupTimer !== 'undefined') clearInterval(_taskStoreCleanupTimer);
    if (typeof _affinityCleanupTimer !== 'undefined') clearInterval(_affinityCleanupTimer);
    cleanupAiServices();
    if (ctx.runtime?.orchestrator?.destroy) ctx.runtime.orchestrator.destroy();
    if (typeof _sessionTtlTimer !== "undefined") clearInterval(_sessionTtlTimer);
  setTimeout(() => { server.close(); process.exit(0); }, 1000);
});

process.on("SIGINT", () => {
  logger.info(`[${ts()}] [ws-realtime] SIGINT → delegating to SIGTERM`);
  process.kill(process.pid, "SIGTERM");
});

process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.message?.includes("EPIPE")) return; // [v25.9.2] Suppress EPIPE
  logger.error(`[${ts()}] [ws-realtime] Uncaught: ${err.message}\n${err.stack}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`[${ts()}] [ws-realtime] Unhandled rejection: ${reason}`);
});

// ─── Start ──────────────────────────────────────────────────
async function start() {
  logger.info(`[${ts()}] RangerAI WS-Realtime v1.0 — Iter-59: Process Separation`);
  logger.info(`[${ts()}] PID: ${process.pid}`);

  try {
    await ctx.db.initDatabase();
    logger.info(`[${ts()}] [ws-realtime] Database initialized`);
    // R54: Initialize task_plans table
    try {
      await initTaskPlansTable();
      logger.info(`[${ts()}] [ws-realtime] task_plans table initialized`);
    } catch (planErr) {
      logger.warn(`[${ts()}] [ws-realtime] task_plans init failed (non-fatal): ${planErr.message}`);
    }
  } catch (dbErr) {
    logger.error(`[${ts()}] [ws-realtime] CRITICAL: DB init failed: ${dbErr.message}`);
  }

  try { fs.mkdirSync(ctx.config.FILES_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
  try { fs.mkdirSync(ctx.config.EVENT_BUFFER_DIR, { recursive: true }); } catch (e) { /* best-effort */ }

  // Connect TaskStore (Redis)
  const redisOk = await taskStore.connect();
  if (redisOk) {
    logger.info(`[${ts()}] [ws-realtime] Redis TaskStore connected`);
    try { await taskStore.cleanupStaleTasks(); } catch (e) { /* non-fatal */ }
    const _taskStoreCleanupTimer = setInterval(() => {
      taskStore.cleanupStaleTasks().catch((e) => {
        logger.info(`[${ts()}] [ws-realtime] TaskStore cleanup: ${e.message}`);
      });
    }, 300000);
  } else {
    logger.warn(`[${ts()}] [ws-realtime] Redis TaskStore UNAVAILABLE`);
  }

  // Spawn worker
  workerManager.spawn();

  // WorkerPool: Periodic session affinity cleanup (every 5 minutes)
  if (typeof workerManager.cleanupAffinity === 'function') {
    const _affinityCleanupTimer = setInterval(() => { workerManager.cleanupAffinity(); }, 300000);
    logger.info(`[${ts()}] [ws-realtime] WorkerPool affinity cleanup scheduled (every 5min)`);
  }

  ctx.runtime.server = server;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.info(`[ws-realtime] Port ${WS_PORT} in use, retrying...`);
      try {
        execSync(`fuser -k ${WS_PORT}/tcp`);
      } catch (e) { /* best-effort */ }
      setTimeout(() => { server.close(); server.listen(WS_PORT, "127.0.0.1"); }, 2000);
    }
  });

  server.listen(WS_PORT, "127.0.0.1", async () => {
    logger.info(`[${ts()}] [ws-realtime] Listening on 127.0.0.1:${WS_PORT}`);
    logger.info(`[${ts()}] [ws-realtime] Worker: ${ctx.config.WORKER_PATH}`);
    // Notify API process that WS has restarted — clear stale activeTasksBySession
    try {
      await publishResponse(null, { type: "ws_restarted", pid: process.pid, ts: Date.now() });
      logger.info(`[${ts()}] [ws-realtime] Sent ws_restarted notification to API process`);
    } catch (e) {
      logger.warn(`[${ts()}] [ws-realtime] Failed to send ws_restarted: ${e.message}`);
    }
  });
    // F20: Start session TTL cleanup (every hour)
    const _sessionTtlTimer = startPeriodicCleanup(60 * 60 * 1000);
    logger.info(`[${ts()}] [ws-realtime] Session TTL cleanup started`);
    // ─── P2: Auto-recover interrupted tasks on startup ──────────────
    setTimeout(async () => {
      logger.info(`[${ts()}] [P2-RECOVER] Starting automatic task recovery...`);
      let recoveredCount = 0;
      
      // 1. Recover WS chat tasks from Redis TaskStore
      try {
        if (taskStore && taskStore.ready) {
          const resumable = await taskStore.getResumableTasks();
          if (resumable.length > 0) {
            logger.info(`[${ts()}] [P2-RECOVER] Found ${resumable.length} resumable Redis tasks`);
            for (const task of resumable) {
              try {
                const resumed = await taskStore.resumeTask(task.msgId);
                if (resumed) {
                  logger.info(`[${ts()}] [P2-RECOVER] Resumed Redis task: ${task.msgId}`);
                  recoveredCount++;
                }
              } catch (e) {
                logger.warn(`[${ts()}] [P2-RECOVER] Failed to resume Redis task ${task.msgId}: ${e.message}`);
              }
            }
          } else {
            logger.info(`[${ts()}] [P2-RECOVER] No resumable Redis tasks found`);
          }
        }
      } catch (e) {
        logger.warn(`[${ts()}] [P2-RECOVER] Redis recovery error: ${e.message}`);
      }
      
      logger.info(`[${ts()}] [P2-RECOVER] Recovery complete. Recovered ${recoveredCount} tasks.`);
    }, 10000); // Wait 10s after startup for workers to be fully ready
}

start().catch((err) => {
  logger.error(`[${ts()}] [ws-realtime] FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
