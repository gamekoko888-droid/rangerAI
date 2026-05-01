/**
 * ws-control-handlers.mjs — WebSocket Control Message Handlers
 * Iter-56: Extracted from ws-handler.mjs to achieve Dispatch/Handling separation.
 *
 * Contains all non-chat control handlers:
 *   - handleBindChat       — Bind WS connection to a chat record
 *   - handleRecoverTask    — Reconnect and replay missed events
 *   - handleStatusUpdate   — Return current system status
 *   - handleForceReset     — Force-clear stuck processing state
 *   - handleCancel         — Cancel active task
 *   - handleGatewayApi     — Proxy Gateway API calls
 *   - handleAbortTask      — Abort task via chat.abort
 *   - handleSetSession     — Switch session key
 *   - handleUserInterrupt  — Handle user interrupt during processing
 *
 * @module ws-control-handlers
 */
import { logger } from '../lib/logger.mjs';
import { ts } from './helpers.mjs';
import { WebSocket } from 'ws';

/** @type {import('./ws-handler.mjs').WsHandlerDeps} */
let deps = null;

/**
 * Initialize with shared dependencies (same deps object as ws-handler).
 * @param {object} dependencies
 */
export function initControlHandlers(dependencies) {
  deps = dependencies;
}

// ─── bind_chat ──────────────────────────────────────────────
/**
 * Bind a WebSocket connection to a specific chat record.
 * Loads conversation history from DB and notifies the client.
 */
export async function handleBindChat(ws, msg, state) {
  const { wsClients, sendEvent, getChatById, getConversationHistory } = deps;
  const chatId = msg.chatId;

  // v10.0: Keep old bindings — one WS can receive events from multiple chats
  // Only update the binding for this specific chatId
  wsClients.set(chatId, ws);

  try {
    const chatRecord = await getChatById(chatId);
    if (chatRecord) {
      state.sessionKey = chatRecord.sessionKey;
      const dbHistory = await getConversationHistory(chatId, 50);
      if (dbHistory.length > 0) {
        state.conversationHistory = dbHistory;
      }
      state.titleGenerated = chatRecord.title !== "新对话";
    }
  } catch (e) {
    logger.info(`[${ts()}] [ws] bind_chat DB lookup failed: ${e.message}`);
  }

  sendEvent(ws, { type: "chat_bound", chatId, sessionKey: state.sessionKey });
  logger.info(`[${ts()}] [ws] Chat bound: ${chatId} -> session ${state.sessionKey}`);
  
  // P0: Check for interrupted tasks on reconnect and rebind
  try {
    const { workerManager } = deps;
    if (workerManager && state.sessionKey) {
      for (const [msgId, task] of workerManager.pendingTasks) {
        if (task.sessionKey === state.sessionKey && task.ws === null) {
          logger.info(`[${ts()}] [P0-REBIND] Rebinding task ${msgId} to reconnected client (session: ${state.sessionKey})`);
          task.ws = ws;
          if (task._gracePeriodTimer) {
            clearTimeout(task._gracePeriodTimer);
            task._gracePeriodTimer = null;
          }
          sendEvent(ws, { type: "recovery_status", phase: "reconnected", message: "已重新连接到进行中的任务", taskId: msgId });
        }
      }
    }
  } catch (rebindErr) {
    logger.info(`[${ts()}] [P0-REBIND] rebind check failed: ${rebindErr.message}`);
  }
}

// ─── recover_task ───────────────────────────────────────────
/**
 * Handle task recovery after client reconnection.
 * Replays missed events from EventBuffer and restores processing state.
 */
export async function handleRecoverTask(ws, msg, state) {
  const {
    eventBuffer, workerManager, sendEvent, smartReplayEvents,
    loadSession, activeTasksBySession,
    DEFAULT_SESSION_KEY,
  } = deps;

  const clientSessionKey = msg.sessionKey;
  const sessionKey = clientSessionKey || state.sessionKey;
  const rawSinceTs = msg.lastEventTs || 0;
  const snapshotHash = typeof msg.snapshotHash === 'string' ? msg.snapshotHash : '';
  const lastChunkSeq = Number.isFinite(Number(msg.lastChunkSeq)) ? Number(msg.lastChunkSeq) : 0;
  // R73: When sinceTs=0 (no lastEventTs from frontend), cap to last 120s to avoid full replay
  const sinceTs = rawSinceTs === 0 ? Date.now() - 120000 : rawSinceTs;
  const sinceCapApplied = rawSinceTs === 0;
  logger.info(`[${ts()}] Recovery request, session=${sessionKey} (client=${clientSessionKey || "none"}), sinceTs=${sinceTs}${sinceCapApplied ? " (R73: capped from 0)" : ""}, lastChunkSeq=${lastChunkSeq}, snapshotHash=${snapshotHash || 'n/a'}`);

  // Restore session from client-provided key
  if (clientSessionKey && clientSessionKey !== state.sessionKey) {
    logger.info(`[${ts()}] [recover] Restoring sessionKey from client: ${clientSessionKey}`);
    state.sessionKey = clientSessionKey;
    const savedHistory = loadSession(clientSessionKey);
    if (savedHistory && savedHistory.length > 0) {
      state.conversationHistory = savedHistory;
      sendEvent(ws, { type: "history", messages: savedHistory });
    }
  }

  // Check for active task in EventBuffer
  const activeTask = eventBuffer.getActiveTask(sessionKey);
  if (activeTask) {
    const taskAge = Date.now() - (activeTask.startedAt || 0);
    const pendingTask = workerManager.pendingTasks.get(activeTask.msgId);

    // Case 1: Task still running in worker
    if (pendingTask) {
      pendingTask.ws = ws;
      if (pendingTask._gracePeriodTimer) {
        clearTimeout(pendingTask._gracePeriodTimer);
        pendingTask._gracePeriodTimer = null;
        logger.info(`[${ts()}] [recover] Cleared grace period timer for reconnected task`);
      }
      state.isProcessing = true;
      const missedEvents = eventBuffer.getEvents(activeTask.msgId, sinceTs);
      logger.info(`[${ts()}] [recover] Task running, replaying ${missedEvents.length} events for ${activeTask.msgId}`);
      sendEvent(ws, { type: "task_recovery", status: "running", msgId: activeTask.msgId, userMessage: activeTask.userMessage, eventCount: missedEvents.length });
      smartReplayEvents(ws, missedEvents);
      sendEvent(ws, { type: "status", status: "thinking" });
      return;
    }

    // Case 2: Task completed while disconnected
    const allEvents = eventBuffer.getEvents(activeTask.msgId, 0);
    const hasCompletionEvent = allEvents.some((ev) =>
      ev.type === "stream_end" || ev.type === "message_done" || (ev.type === "status" && ev.status === "idle")
    );

    if (hasCompletionEvent) {
      logger.info(`[${ts()}] [recover] Task completed while disconnected, replaying ${allEvents.length} events for ${activeTask.msgId}`);
      eventBuffer.markCompleted(activeTask.msgId);
      sendEvent(ws, { type: "task_recovery", status: "completed", msgId: activeTask.msgId, userMessage: activeTask.userMessage, eventCount: allEvents.length });
      const eventsToReplay = allEvents.filter((ev) => ev._ts > sinceTs || !ev._ts);
      smartReplayEvents(ws, eventsToReplay);
      sendEvent(ws, { type: "status", status: "idle" });
      return;
    }

    // Case 3: Stale task (>2 min, no completion)
    if (taskAge > 120000) {
      logger.info(`[${ts()}] [recover] Stale task (age=${Math.round(taskAge / 1000)}s) with no completion events: ${activeTask.msgId}`);
      eventBuffer.markCompleted(activeTask.msgId);
      const eventsToReplay = allEvents.filter((ev) => ev._ts > sinceTs || !ev._ts);
      if (eventsToReplay.length > 0) {
        sendEvent(ws, { type: "task_recovery", status: "completed", msgId: activeTask.msgId, userMessage: activeTask.userMessage, eventCount: eventsToReplay.length });
        smartReplayEvents(ws, eventsToReplay);
      } else {
        sendEvent(ws, { type: "task_recovery", status: "none" });
      }
      sendEvent(ws, { type: "status", status: "idle" });
      return;
    }

    // Case 4: Young task, treat as potentially running
    logger.info(`[${ts()}] [recover] Young task (age=${Math.round(taskAge / 1000)}s) with no pending task, treating as potentially running: ${activeTask.msgId}`);
    state.isProcessing = true;
    const missedEvents = eventBuffer.getEvents(activeTask.msgId, sinceTs);
    sendEvent(ws, { type: "task_recovery", status: "running", msgId: activeTask.msgId, userMessage: activeTask.userMessage, eventCount: missedEvents.length });
    smartReplayEvents(ws, missedEvents);
    sendEvent(ws, { type: "status", status: "thinking" });
    return;
  }

  // Check pendingTasks directly (fallback)
  for (const [pMsgId, pTask] of workerManager.pendingTasks) {
    if (pTask.sessionKey === sessionKey) {
      logger.info(`[${ts()}] [recover] v49: Found task ${pMsgId} in pendingTasks but not in eventBuffer active — reconnecting`);
      pTask.ws = ws;
      if (pTask._gracePeriodTimer) {
        clearTimeout(pTask._gracePeriodTimer);
        pTask._gracePeriodTimer = null;
      }
      state.isProcessing = true;
      const missedEvents = eventBuffer.getEvents(pMsgId, sinceTs);
      sendEvent(ws, { type: "task_recovery", status: "running", msgId: pMsgId, userMessage: pTask.content || "[unknown]", eventCount: missedEvents.length });
      smartReplayEvents(ws, missedEvents);
      sendEvent(ws, { type: "status", status: "thinking" });
      return;
    }
  }

  // Check completed task
  const completedTask = eventBuffer.getCompletedTask(sessionKey);
  if (completedTask) {
    let replayEvents = eventBuffer.getEvents(completedTask.msgId, sinceTs);
    if (replayEvents.length === 0 && sinceTs > 0) {
      replayEvents = eventBuffer.getEvents(completedTask.msgId, 0);
      logger.info(`[${ts()}] [recover] v47: No events after sinceTs=${sinceTs}, replaying ALL ${replayEvents.length} events for ${completedTask.msgId}`);
    } else {
      logger.info(`[${ts()}] [recover] Replaying ${replayEvents.length} completed events for ${completedTask.msgId}`);
    }
    sendEvent(ws, { type: "task_recovery", status: "completed", msgId: completedTask.msgId, userMessage: completedTask.userMessage, eventCount: replayEvents.length });
    smartReplayEvents(ws, replayEvents);
    sendEvent(ws, { type: "status", status: "idle" });
    return;
  }

  // No task found
  sendEvent(ws, { type: "task_recovery", status: "none" });
  sendEvent(ws, { type: "status", status: "idle" });
}

// ─── status_update ──────────────────────────────────────────
/**
 * Return current worker/gateway status to the client.
 */
export async function handleStatusUpdate(ws, msg, state) {
  const { sendEvent, workerManager } = deps;
  const wStatus = workerManager.status;
  sendEvent(ws, {
    type: "status_update",
    gatewayConnected: wStatus.workerReady,
    workerReady: wStatus.workerReady,
    pendingTasks: wStatus.pendingTasks,
  });
}

// ─── force_reset ────────────────────────────────────────────
/**
 * Force-clear all stuck processing state for this connection.
 */
export async function handleForceReset(ws, msg, state) {
  const { sendEvent, workerManager, eventBuffer, taskStore, activeTasksBySession } = deps;
  logger.info(`[${ts()}] Force reset from client`);
  state.isProcessing = false;
  state.processingStartedAt = null;

  for (const [msgId, task] of workerManager.pendingTasks) {
    if (task.ws === ws) {
      workerManager._clearTaskTimers(msgId);
      workerManager.pendingTasks.delete(msgId);
      try { workerManager.worker?.send({ type: "cancel_task", msgId }); } catch (e) { /* cancel best-effort */ }
    }
  }

  const taskSK = msg.sessionKey || state.sessionKey;
  const activeMsgId = activeTasksBySession.get(taskSK)?.msgId;
  if (activeMsgId) eventBuffer.completeTask(activeMsgId);
  activeTasksBySession.delete(taskSK);

  sendEvent(ws, { type: "thinking", content: "\n[系统] 已重置任务状态\n" });
  sendEvent(ws, { type: "status", status: "idle" });
}

// ─── cancel ─────────────────────────────────────────────────
/**
 * Cancel the currently active task for this connection.
 */
export async function handleCancel(ws, msg, state, ip) {
  const { sendEvent, workerManager, eventBuffer, activeTasksBySession } = deps;
  logger.info(`[${ts()}] Cancel request from ${ip}`);
  const taskSK = msg.sessionKey || state.sessionKey;

  // P0-FIX: Clean up local state FIRST, then abort Gateway.
  // This ensures frontend receives status:idle only after local cleanup is done,
  // preventing new messages from racing with a still-running Gateway task.
  let cancelledMsgId = null;
  for (const [msgId, task] of workerManager.pendingTasks) {
    if (task.ws === ws) {
      cancelledMsgId = msgId;
      workerManager._clearTaskTimers(msgId);
      workerManager.pendingTasks.delete(msgId);
      try { eventBuffer.completeTask(msgId); } catch (e) { /* cleanup best-effort */ }
      // Pass sessionKey so Worker can do precise runId-based abort
      try { workerManager.worker?.send({ type: "cancel_task", msgId, sessionKey: taskSK }); } catch (e) { /* cancel best-effort */ }
      break;
    }
  }

  const activeMsgId = cancelledMsgId || activeTasksBySession.get(taskSK)?.msgId;
  if (activeMsgId && !cancelledMsgId) {
    try { eventBuffer.completeTask(activeMsgId); } catch (e) { /* cleanup best-effort */ }
  }
  activeTasksBySession.delete(taskSK);
  state.isProcessing = false;

  // Abort Gateway lane (async, non-blocking — local state already cleaned)
  workerManager.gatewayRequest("chat.abort", { sessionKey: taskSK })
    .then(r => logger.info(`[${ts()}] [P0] handleCancel: Gateway chat.abort OK: ${JSON.stringify(r)}`))
    .catch(e => logger.info(`[${ts()}] [P0] handleCancel: Gateway chat.abort failed (non-fatal): ${e.message}`));

  // P0-FIX: Push status:idle AFTER local cleanup, so frontend unblocks only when safe
  sendEvent(ws, { type: "thinking", content: "\n[系统] 任务已取消\n" });
  sendEvent(ws, { type: "status", status: "idle" });
  logger.info(`[${ts()}] Task cancelled: ${cancelledMsgId || "none pending"}`);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "cancel_confirmed", msgId: cancelledMsgId }));
  }
}

// ─── gateway_api ────────────────────────────────────────────
/**
 * Proxy a Gateway API request through the worker manager.
 */
export async function handleGatewayApi(ws, msg) {
  const { workerManager } = deps;
  const { method, params, reqId } = msg;
  logger.info(`[${ts()}] Gateway API request: ${method} (reqId: ${reqId})`);
  try {
    const result = await workerManager.gatewayRequest(method, params || {});
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "gateway_api_response", reqId, ok: true, result }));
    }
  } catch (err) {
    logger.info(`[${ts()}] Gateway API error: ${method} — ${err.message}`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "gateway_api_response", reqId, ok: false, error: err.message }));
    }
  }
}

// ─── abort_task ─────────────────────────────────────────────
/**
 * Abort a task via Gateway chat.abort, then clean up local state.
 */
export async function handleAbortTask(ws, msg, state) {
  const { sendEvent, workerManager, eventBuffer, activeTasksBySession } = deps;
  const taskSK = msg.sessionKey || state.sessionKey;
  logger.info(`[${ts()}] [P0] abort_task for session: ${taskSK}`);

  // P0-FIX: Clean up local state FIRST (same pattern as handleCancel),
  // then fire Gateway abort async. Prevents race where frontend unblocks
  // before local isProcessing is cleared.
  let cancelledMsgId = null;
  for (const [msgId, task] of workerManager.pendingTasks) {
    if (task.ws === ws || task.sessionKey === taskSK) {
      cancelledMsgId = msgId;
      workerManager._clearTaskTimers(msgId);
      workerManager.pendingTasks.delete(msgId);
      try { eventBuffer.completeTask(msgId); } catch (e) { /* cleanup best-effort */ }
      try { workerManager.worker?.send({ type: "cancel_task", msgId }); } catch (e) { /* cancel best-effort */ }
      break;
    }
  }
  activeTasksBySession.delete(taskSK);
  state.isProcessing = false;

  // Abort Gateway lane async (non-blocking)
  workerManager.gatewayRequest("chat.abort", { sessionKey: taskSK })
    .then(r => logger.info(`[${ts()}] [P0] abort_task: Gateway chat.abort OK: ${JSON.stringify(r)}`))
    .catch(e => logger.info(`[${ts()}] [P0] abort_task: Gateway chat.abort failed (non-fatal): ${e.message}`));

  sendEvent(ws, { type: "thinking", content: "\n[系统] 任务已取消\n" });
  sendEvent(ws, { type: "status", status: "idle" });
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "cancel_confirmed", msgId: cancelledMsgId }));
  }
}

// ─── set_session ────────────────────────────────────────────
/**
 * Switch the current session key and reload conversation history.
 */
export async function handleSetSession(ws, msg, state) {
  const { sendEvent, loadSession, getChatBySessionKey } = deps;
  const newSessionKey = msg.sessionKey || deps.DEFAULT_SESSION_KEY;
  state.sessionKey = newSessionKey;
  sendEvent(ws, { type: "session_changed", sessionKey: state.sessionKey });
  state.conversationHistory = loadSession(state.sessionKey);

  let chatRecordForSession = null;
  try {
    chatRecordForSession = await getChatBySessionKey(newSessionKey);
  } catch (e) {
    logger.warn(`[${ts()}] [ws] set_session DB lookup failed for sessionKey ${newSessionKey}: ${e.message}`);
  }
  state.titleGenerated = !!chatRecordForSession && chatRecordForSession.title !== "新对话";
  sendEvent(ws, { type: "session_changed", sessionKey: state.sessionKey });
}

// ─── user_interrupt ─────────────────────────────────────────
/**
 * Handle user interrupt during active processing.
 * Returns true if the interrupt should be dispatched as a normal message.
 * Returns false if the interrupt was handled internally.
 */
export function handleUserInterrupt(ws, msg, state, ip) {
  const { sendEvent, workerManager } = deps;
  logger.info(`[${ts()}] User interrupt received: "${msg.content.slice(0, 80)}..." (processing: ${state.isProcessing})`);

  if (state.isProcessing && workerManager.workerReady && workerManager.worker) {
    workerManager.worker.send({
      type: "user_interrupt",
      content: msg.content,
      sessionKey: state.sessionKey,
      timestamp: Date.now(),
    });
    sendEvent(ws, { type: "thinking", content: `\n📝 收到补充指令: "${msg.content.slice(0, 50)}${msg.content.length > 50 ? "..." : ""}"\n` });
    state.conversationHistory.push({ role: "user", content: `[补充指令] ${msg.content}` });
    return false; // handled
  } else if (!state.isProcessing) {
    logger.info(`[${ts()}] No active task, treating interrupt as normal message`);
    return true; // dispatch as normal message
  } else {
    sendEvent(ws, { type: "thinking", content: `\n📝 收到补充指令，但当前无法转发给Agent，将在下次对话中使用\n` });
    state.conversationHistory.push({ role: "user", content: `[补充指令] ${msg.content}` });
    return false; // handled
  }
}
