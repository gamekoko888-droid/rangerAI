/**
 * modules/routes/task-routes.mjs — Task Routes (v1.0.0, Iter-53)
 *
 * Extracted from http-routes.mjs:
 *   - POST /api/tasks/:msgId/cancel
 *   - GET  /api/task/:msgId
 *   - GET  /api/session/:sessionKey
 *   - GET  /api/tasks/active
 */

import { logger } from "../../lib/logger.mjs";
let deps = {};

export function init(dependencies) {
  deps = dependencies;
}

/**
 * Try to handle a task route. Returns true if handled.
 */
export async function handleTaskRoute(req, res, urlPath) {
  // ─── POST /api/tasks/:msgId/cancel ───
  const taskCancelMatch = urlPath.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (taskCancelMatch && req.method === "POST") {
    return handleTaskCancel(req, res, taskCancelMatch[1]);
  }

  // ─── Task Polling ───
  if (req.url?.startsWith("/api/task/") && req.method === "GET") {
    return handleTaskPolling(req, res);
  }
  if (req.url?.startsWith("/api/session/") && req.method === "GET") {
    return handleSessionPolling(req, res);
  }
  if (urlPath === "/api/tasks/active" && req.method === "GET") {
    return handleActiveTasks(req, res);
  }

  return false;
}

// ─── Handlers ──────────────────────────────────────────────

async function handleTaskCancel(req, res, rawMsgId) {
  const msgId = decodeURIComponent(rawMsgId);
  const { workerManager, eventBuffer, activeTasksBySession } = deps;
  try {
    let cancelled = false;
    for (const [tid, task] of workerManager.pendingTasks) {
      if (tid === msgId) {
        workerManager._clearTaskTimers(tid);
        workerManager.pendingTasks.delete(tid);
        try { eventBuffer.completeTask(tid); } catch (e) { logger.debug("[task] completeTask failed:", e?.message); }
        try { workerManager.worker?.send({ type: "cancel_task", msgId: tid }); } catch (e) { logger.debug("[task] cancel send failed:", e?.message); }
        cancelled = true;
        break;
      }
    }
    for (const [sk, task] of activeTasksBySession) {
      if (task.msgId === msgId) {
        activeTasksBySession.delete(sk);
        break;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, msgId, cancelled }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
  return true;
}

async function handleTaskPolling(req, res) {
  const { eventBuffer, taskStore } = deps;
  const urlParts = req.url.split("?");
  const msgId = decodeURIComponent(urlParts[0].slice("/api/task/".length));
  const params = new URLSearchParams(urlParts[1] || "");
  const sinceTs = parseInt(params.get("since") || "0") || 0;
  if (!msgId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing task ID" })); return true; }
  try {
    const taskState = await taskStore.getTaskState(msgId, sinceTs);
    if (taskState) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(taskState)); return true; }
    const ebTask = eventBuffer.buffers.get(msgId);
    if (ebTask) {
      const events = eventBuffer.getEvents(msgId, sinceTs);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ msgId, status: ebTask.completed ? "completed" : "running", sessionKey: ebTask.sessionKey, userMessage: ebTask.userMessage, startedAt: ebTask.startedAt, completedAt: ebTask.completedAt || 0, events, totalEventCount: ebTask.events.length, newEventCount: events.length, source: "eventBuffer" }));
      return true;
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Task not found" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

async function handleSessionPolling(req, res) {
  const { eventBuffer, taskStore, workerManager, activeTasksBySession } = deps;
  const sessionKey = decodeURIComponent(req.url.slice("/api/session/".length).split("?")[0]);
  if (!sessionKey) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing session key" })); return true; }
  try {
    const activeInfo = activeTasksBySession.get(sessionKey);
    if (activeInfo) {
      const pendingTask = workerManager.pendingTasks.get(activeInfo.msgId);
      if (pendingTask) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "running", msgId: activeInfo.msgId, startedAt: activeInfo.startedAt, lastActivityAt: pendingTask.lastActivityAt || activeInfo.startedAt, source: "memory" }));
        return true;
      }
    }
    const sessionState = await taskStore.getSessionState(sessionKey);
    if (sessionState.status !== "idle") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ...sessionState, source: "redis" })); return true; }
    const ebActive = eventBuffer.getActiveTask(sessionKey);
    if (ebActive) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "running", msgId: ebActive.msgId, startedAt: ebActive.startedAt, source: "eventBuffer" })); return true; }
    const ebCompleted = eventBuffer.getCompletedTask(sessionKey);
    if (ebCompleted) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "completed", msgId: ebCompleted.msgId, startedAt: ebCompleted.startedAt, completedAt: ebCompleted.completedAt, source: "eventBuffer" })); return true; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "idle", task: null }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

async function handleActiveTasks(req, res) {
  const { workerManager, taskStore } = deps;
  try {
    const activeTasks = [];
    for (const [msgId, task] of workerManager.pendingTasks) {
      activeTasks.push({ msgId, sessionKey: task.sessionKey, startedAt: task.lastActivityAt, hasClient: task.ws !== null && task.ws?.readyState === 1, source: "memory" });
    }
    const redisTasks = await taskStore.getActiveTasks();
    for (const rt of redisTasks) {
      if (!activeTasks.find(t => t.msgId === rt.msgId)) activeTasks.push({ ...rt, source: "redis" });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ activeTasks, count: activeTasks.length }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
  return true;
}
