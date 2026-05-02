/**
 * worker-manager.mjs — Worker process lifecycle management
 * Sub-iter 4.3: DI规范化 — 统一 init(deps) 签名 + validateDeps + JSDoc
 *               硬编码超时常量迁移为从 deps 读取，与 ctx.config 保持一致
 *
 * Manages: spawning/killing the agent-worker child process,
 *          IPC message routing, task tracking, ping monitoring,
 *          crash recovery with retry queue, graceful restart.
 *
 * Dependency injection: call init(deps) once before instantiating WorkerManager.
 * initWorkerManager() is a backward-compat alias for init().
 *
 * @module worker-manager
 */

import { logger } from '../lib/logger.mjs';
import fs from "fs";
import { fork } from "child_process";
import { execSync as _execSync } from "child_process";
import { WebSocket } from "ws";
import { sanitizeForFrontend } from "../worker/format-utils.mjs";
import { sendEvent, saveSession, ts } from "./helpers.mjs";
import { validateDeps } from "../lib/context.mjs";
import { validateUplink, validateDownlink } from "../lib/schemas/ipc-schemas.mjs";
import { getChatBySessionKey, getConversationHistory, createMessage } from '../services/chat-service.mjs'; // Iter-N: direct service import
import { query, run } from '../db-adapter.mjs';
// R31-T2: Import emitEvent for IPC dual-write to event_stream
import { emitEvent as _emitEventStream } from '../worker/event-stream.mjs';
// R54: Plan persistence service
import { savePlan, updateStepStatus, finalizePlan, getPlans, getActivePlan } from '../services/plan-service.mjs';

// ─── Fallback constants (used only when deps values are absent) ──
// These exist so WorkerManager stays functional even without ctx.config.
// Prefer passing config values through init(deps) for consistency.
const DEFAULT_SOFT_TIMEOUT_MS    = 180000;   // 3 min — notify user
const DEFAULT_IDLE_TIMEOUT_MS    = 300000;   // 5 min — kill if no activity (was 15 min)
const DEFAULT_MAX_TASK_DURATION  = 600000;   // 10 min — absolute cap (was 30 min)
const DEFAULT_WORKER_PING_INTERVAL = 30000;  // 30s
const DEFAULT_WORKER_PING_TIMEOUT  = 90000;  // 90s
const DEFAULT_RESTART_WINDOW     = 300000;   // 5 min
const DEFAULT_MAX_RESTART_COUNT  = 5;

// ─── Required deps fields ────────────────────────────────────
const REQUIRED_DEPS = [
  'sessions', 'eventBuffer', 'taskStore',
  'activeTasksBySession', 'workerPath', 'defaultSessionKey',
];

// ─── Injected Dependencies ─────────────────────────────────
/** @type {WorkerManagerDeps} */
let _deps = {
  sessions: null,
  eventBuffer: null,
  taskStore: null,
  activeTasksBySession: null,
  toolMetadataByMsgId: null,
  wss: null,
  pendingAnnounces: [],  // v1.2: Queue for announce messages when no clients connected
  // R39-T1: FIFO task queue for backpressure
  taskQueue: [],
  MAX_QUEUE_SIZE: 50,
  MAX_CONCURRENT_TASKS: 2,  // R40: Lowered to 2 for realistic queue triggering
  _processedAnnounceRunIds: new Map(),  // v14.2: Dedup announce events across workers (runId → timestamp)
  workerPath: '',
  defaultSessionKey: 'default',
  // config — optional, fall back to DEFAULT_* above if absent
  SOFT_TIMEOUT_MS: null,
  IDLE_TIMEOUT_MS: null,
  MAX_TASK_DURATION: null,
  WORKER_PING_INTERVAL: null,
  WORKER_PING_TIMEOUT: null,
  RESTART_WINDOW: null,
  MAX_RESTART_COUNT: null,
};

// ─── Resolved timeout values (set after init()) ─────────────
let SOFT_TIMEOUT_MS    = DEFAULT_SOFT_TIMEOUT_MS;
let IDLE_TIMEOUT_MS    = DEFAULT_IDLE_TIMEOUT_MS;
let MAX_TASK_DURATION  = DEFAULT_MAX_TASK_DURATION;
let WORKER_PING_INTERVAL = DEFAULT_WORKER_PING_INTERVAL;
let WORKER_PING_TIMEOUT  = DEFAULT_WORKER_PING_TIMEOUT;
let RESTART_WINDOW     = DEFAULT_RESTART_WINDOW;
let MAX_RESTART_COUNT  = DEFAULT_MAX_RESTART_COUNT;

/**
 * Initialize the worker-manager module with injected dependencies.
 * Must be called once before instantiating WorkerManager.
 *
 * @param {WorkerManagerDeps} deps
 * @throws {Error} If any required dep is missing or null
 */
export function init(deps) {
  validateDeps(REQUIRED_DEPS, deps, 'worker-manager');
  Object.assign(_deps, deps);

  // Resolve timeout values from deps (ctx.config) with fallback to defaults
  SOFT_TIMEOUT_MS    = _deps.SOFT_TIMEOUT_MS    ?? DEFAULT_SOFT_TIMEOUT_MS;
  IDLE_TIMEOUT_MS    = _deps.IDLE_TIMEOUT_MS    ?? DEFAULT_IDLE_TIMEOUT_MS;
  MAX_TASK_DURATION  = _deps.MAX_TASK_DURATION  ?? DEFAULT_MAX_TASK_DURATION;
  WORKER_PING_INTERVAL = _deps.WORKER_PING_INTERVAL ?? DEFAULT_WORKER_PING_INTERVAL;
  WORKER_PING_TIMEOUT  = _deps.WORKER_PING_TIMEOUT  ?? DEFAULT_WORKER_PING_TIMEOUT;
  RESTART_WINDOW     = _deps.RESTART_WINDOW     ?? DEFAULT_RESTART_WINDOW;
  MAX_RESTART_COUNT  = _deps.MAX_RESTART_COUNT  ?? DEFAULT_MAX_RESTART_COUNT;

  logger.info(`[${ts()}] [WorkerManager] Initialized with worker: ${_deps.workerPath} ` +
    `(softTimeout=${SOFT_TIMEOUT_MS/1000}s, idle=${IDLE_TIMEOUT_MS/1000}s, max=${MAX_TASK_DURATION/1000}s)`);
}

/**
 * Backward-compatible alias for init().
 * Prefer init() in new code.
 *
 * @param {WorkerManagerDeps} deps
 */
export function initWorkerManager(deps) {
  init(deps);
}

/**
 * Update the WSS reference after WebSocketServer is created.
 * Use this instead of calling init() again (which would re-validate all deps).
 * 
 * @param {object} wss - WebSocketServer instance
 */
export function setWss(wss) {
  _deps.wss = wss;
}

// v1.2: Drain pending announce messages to a newly connected client
export function drainPendingAnnounces(ws, sendEventFn) {
  if (!_deps.pendingAnnounces.length) return 0;
  const now = Date.now();
  // Filter expired (>5min)
  _deps.pendingAnnounces = _deps.pendingAnnounces.filter(a => now - a.timestamp < 300000);
  const count = _deps.pendingAnnounces.length;
  if (count === 0) return 0;
  logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Draining ${count} pending announce(s) to new client`);
  for (const announce of _deps.pendingAnnounces) {
    try {
      // v14.2: Use announce_message event type instead of stream_start/chunk/end
      const drainStreamId = "announce-drain-" + Date.now();
      sendEventFn(ws, { type: "announce_message", content: announce.text, model: "RangerAI Agent (Announce)", runId: announce.runId || '', chatId: announce.chatId || null, streamId: drainStreamId });
    } catch (e) {
      logger.warn(`[${ts()}] [worker-manager] [ANNOUNCE] Failed to drain announce: ${e.message}`);
    }
  }
  try {
    sendEventFn(ws, { type: "status", status: "idle" });
  } catch (e) { /* ignore */ }
  _deps.pendingAnnounces = [];
  return count;
}

/**
 * @typedef {object} WorkerManagerDeps
 * @property {Map}    sessions              - Map<ws, sessionState>
 * @property {object} eventBuffer           - EventBuffer instance
 * @property {object} taskStore             - Redis-backed task store
 * @property {Map}    activeTasksBySession  - Map<sessionKey, {msgId}>
 * @property {Map}    [toolMetadataByMsgId] - Map<msgId, {tools, steps}>
 * @property {object} [wss]                 - WebSocketServer instance (set after WSS creation)
 * @property {string} workerPath            - Absolute path to agent-worker.mjs
 * @property {string} defaultSessionKey     - Fallback session key
 * @property {number} [SOFT_TIMEOUT_MS]     - ctx.config value; falls back to 180000
 * @property {number} [IDLE_TIMEOUT_MS]     - ctx.config value; falls back to 900000
 * @property {number} [MAX_TASK_DURATION]   - ctx.config value; falls back to 1800000
 * @property {number} [WORKER_PING_INTERVAL] - ctx.config value; falls back to 30000
 * @property {number} [WORKER_PING_TIMEOUT]  - ctx.config value; falls back to 90000
 * @property {number} [RESTART_WINDOW]      - ctx.config value; falls back to 300000
 * @property {number} [MAX_RESTART_COUNT]   - ctx.config value; falls back to 5
 */

// ─── RCA improvement #3: Worker max lifetime for auto-restart ──
const DEFAULT_MAX_WORKER_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── WorkerManager Class ───────────────────────────────────
export class WorkerManager {
  constructor() {
    this.worker = null;
    this.workerReady = false;
    this.pendingTasks = new Map();
    this.lastModelByMsgId = new Map(); // [P0-2-FIX] task model side-channel
    this.restartHistory = [];
    this.degraded = false;
    this.gatewayConnected = false;
    this.pingTimer = null;
    this.lastPongAt = 0;
    this.missedPings = 0;
    this.retryQueue = [];
    this._stalledAlertSent = false;
    // RCA improvement #3: track Worker birth time for auto-restart
    this.workerSpawnedAt = null;
    this._lifetimeCheckTimer = null;
    // SV-FIX: Map svTaskId to parent msgId for forwarding sub-step events
    this._svStepToParent = new Map();
  }


  // ─── P0: Interrupted Task Recovery ─────────────────────────
  async _recoverInterruptedTasks() {
    if (!_deps.taskStore) {
      logger.info(`[${ts()}] [P0-RECOVERY] taskStore not available, skipping recovery`);
      return;
    }
    
    try {
      const resumable = await _deps.taskStore.getResumableTasks();
      if (resumable.length === 0) {
        logger.info(`[${ts()}] [P0-RECOVERY] No interrupted tasks to recover`);
        return;
      }
      
      logger.info(`[${ts()}] [P0-RECOVERY] Found ${resumable.length} interrupted task(s), attempting recovery...`);
      
      for (const task of resumable) {
        // Skip if already being processed
        if (this.pendingTasks.has(task.msgId)) {
          logger.info(`[${ts()}] [P0-RECOVERY] Task ${task.msgId} already pending, skipping`);
          continue;
        }
        
        // Limit resume attempts
        const resumeCount = parseInt(task.resumeCount) || 0;
        if (resumeCount >= 3) {
          logger.info(`[${ts()}] [P0-RECOVERY] Task ${task.msgId} exceeded max resume attempts (3), marking failed`);
          await _deps.taskStore.failTask(task.msgId, "Exceeded max resume attempts");
          continue;
        }
        
        try {
          // Resume the task in TaskStore
          const resumed = await _deps.taskStore.resumeTask(task.msgId);
          if (!resumed) continue;
          
          logger.info(`[${ts()}] [P0-RECOVERY] Resuming task ${task.msgId} (session: ${task.sessionKey}, attempt #${resumed.resumeCount})`);
          
          // Send a recovery message through the existing Gateway session
          const recoveryContent = `[SYSTEM RECOVERY] The previous task was interrupted. Please continue from where you left off. Task context: ${(task.content || '').substring(0, 500)}`;
          
          // Use sendTask with the original session key to reconnect to Gateway session
          const history = task.conversationHistory ? JSON.parse(task.conversationHistory) : [];
          
          this.sendTask(
            task.msgId,
            task.sessionKey,
            recoveryContent,
            history,
            null, // No WS connection during recovery
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined
          ).then(reply => {
            logger.info(`[${ts()}] [P0-RECOVERY] Task ${task.msgId} recovered successfully (${(reply || '').length} chars)`);
          }).catch(err => {
            logger.info(`[${ts()}] [P0-RECOVERY] Task ${task.msgId} recovery failed: ${err.message}`);
            _deps.taskStore.failTask(task.msgId, `Recovery failed: ${err.message}`).catch(() => {});
          });
          
          // Stagger recovery attempts to avoid overwhelming Gateway
          await new Promise(r => setTimeout(r, 2000));
          
        } catch (taskErr) {
          logger.info(`[${ts()}] [P0-RECOVERY] Failed to recover task ${task.msgId}: ${taskErr.message}`);
        }
      }
    } catch (e) {
      logger.info(`[${ts()}] [P0-RECOVERY] Recovery scan failed: ${e.message}`);
    }
  }

  spawn() {
    const workerPath = _deps.workerPath;
    if (!fs.existsSync(workerPath)) {
      logger.error(`[${ts()}] Worker file not found: ${workerPath}`);
      this.degraded = true;
      return;
    }

    // Kill old worker before spawning new one
    if (this.worker) {
      const oldPid = this.worker.pid;
      logger.info(`[${ts()}] Killing old worker (PID: ${oldPid}) before respawn`);
      try {
        this.worker.removeAllListeners();
        this.worker.kill("SIGTERM");
        setTimeout(() => {
          try { process.kill(oldPid, "SIGKILL"); } catch (e) { /* best-effort */ }
        }, 3000);
      } catch (e) {
        logger.warn(`[${ts()}] Failed to kill old worker: ${e.message}`);
      }
      this.worker = null;
    }

    logger.info(`[${ts()}] Spawning worker: ${workerPath}`);
    this.workerReady = false;
    this.missedPings = 0;
    this.workerSpawnedAt = Date.now(); // RCA improvement #3: record spawn time
    this._startLifetimeCheck(); // RCA improvement #3: start lifetime monitor

    this.worker = fork(workerPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: process.env
    });

    this.worker.stdout?.on("data", (data) => {
      const str = data.toString();
      if (str.includes("EPIPE")) return; // [v25.9.2] Suppress EPIPE
      try { process.stdout.write(`[worker:${this.worker.pid}] ${data}`); } catch(e) {}
      try { fs.appendFileSync("/opt/rangerai-agent/logs/worker-stdout.log", `[${new Date().toISOString()}] ${data}`); } catch(e) {}
    });
    this.worker.stderr?.on("data", (data) => {
      const str = data.toString();
      if (str.includes("EPIPE")) return; // [v25.9.2] Suppress EPIPE
      try { process.stderr.write(`[worker:${this.worker.pid}] ${data}`); } catch(e) {}
      try { fs.appendFileSync("/opt/rangerai-agent/logs/worker-stderr.log", `[${new Date().toISOString()}] ${data}`); } catch(e) {}
    });

    this.worker.on("message", (msg) => this._handleWorkerMessage(msg));

    this.worker.on("exit", (code, signal) => {
      // v5-fix: Check if there are pending tasks BEFORE resetting sessions
      const hasPendingTasks = this.pendingTasks && this.pendingTasks.size > 0;
      // Reset ALL sessions on worker exit
      if (_deps.sessions) {
        for (const [ws, state] of _deps.sessions) {
          if (state.isProcessing) {
            logger.info(`[${ts()}] [worker-exit] Resetting isProcessing for session`);
            state.isProcessing = false;
            state.processingStartedAt = null;
            if (ws.readyState === 1) {
              sendEvent(ws, { type: "thinking", content: "\n[系统] 正在刷新连接，请稍候...\n" });
              // v5-fix: Do NOT send status:idle if there are pending tasks
              // _failAllPending will send proper stream_end + error events instead
              if (!hasPendingTasks) {
                sendEvent(ws, { type: "status", status: "idle" });
              }
            }
          }
        }
      }
      logger.info(`[${ts()}] Worker exited: code=${code}, signal=${signal}, pendingTasks=${this.pendingTasks?.size || 0}`);
      this.workerReady = false;
      this._stopPingMonitor();
      this._failAllPending("Worker process crashed");
      this._scheduleRespawn();
    });

    this.worker.on("error", (err) => {
      logger.error(`[${ts()}] Worker error: ${err.message}`);
    });
  }

  async _handleWorkerMessage(msg) {
    // TOP-LEVEL IPC DEBUG
    if (msg?.type === 'frontend_event') {
      const _et = msg.event?.type || 'unknown';
      logger.info(`[IPC-TOP] frontend_event received: msgId=${msg.msgId} evType=${_et}`);
    }
    // IPC Schema validation (warn-only, never blocks)
    const _v = validateUplink(msg);
    if (!_v.success) {
      logger.warn(`[${ts()}] [IPC] Uplink schema mismatch for type="${msg?.type}": ${_v.error.issues.map(i => i.path.join('.') + ': ' + i.message).join(', ')}`);
    }
    const { sessions, eventBuffer, taskStore, activeTasksBySession, toolMetadataByMsgId, wss, wsClients } = _deps;

    switch (msg.type) {
      case "worker_ready":
        this.workerReady = true;
        this.lastPongAt = Date.now();
        logger.info(`[${ts()}] Worker ready (PID: ${msg.pid}, gateway: ${msg.gatewayConnected})`);
        this._startPingMonitor();
        break;

      case "frontend_event": {
        // Always buffer events for background recovery
        eventBuffer.addEvent(msg.msgId, msg.event);
        // Dual-write to Redis TaskStore
        taskStore.addEvent(msg.msgId, msg.event).catch((e) => { logger.debug("[worker-manager] addEvent failed:", e.message); });
        // R31-T2: Dual-write whitelisted events to event_stream SQLite for persistence
        const _R31_DUAL_WRITE_EVENTS = [
          'knowledge_injected', 'kv_cache_stats', 'max_retries_exceeded',
          'context_compress', 'todo_updated', 'datasource_routed',
          'image_generated', 'audio_transcribed', 'plan_generation_failed'
        ];
        if (msg.event && _R31_DUAL_WRITE_EVENTS.includes(msg.event.type)) {
          try {
            const _sk = msg.sessionKey || msg.event.sessionKey || 'ipc_unknown';
            _emitEventStream(_sk, msg.msgId, msg.event.type, msg.event);
            logger.info(`[R31-T2] Dual-write event_stream: type=${msg.event.type} msgId=${msg.msgId}`);
          } catch (_dwErr) {
            logger.debug(`[R31-T2] Dual-write failed (non-fatal): ${_dwErr.message}`);
          }
        }
        // Collect tool/step events for metadata persistence
        if (msg.event && msg.event.type) {
          const evType = msg.event.type;
          if (evType === "tool_start" || evType === "tool_end" || evType === "step") {
            if (!toolMetadataByMsgId.has(msg.msgId)) {
              toolMetadataByMsgId.set(msg.msgId, { tools: [], steps: [] });
            }
            const meta = toolMetadataByMsgId.get(msg.msgId);
            if (evType === "tool_start") {
              meta.tools.push({ id: msg.event.id, tool: msg.event.tool, args: msg.event.args, description: msg.event.description || '', status: "running", startedAt: Date.now() });
            } else if (evType === "tool_end") {
              const existing = meta.tools.find(t => t.id === msg.event.id);
              if (existing) {
                existing.status = msg.event.success ? "completed" : "error";
                existing.result = msg.event.result;
                existing.endedAt = Date.now();
                if (msg.event.screenshot) existing.screenshot = msg.event.screenshot;
              } else {
                meta.tools.push({ id: msg.event.id, tool: msg.event.tool, status: msg.event.success ? "completed" : "error", result: msg.event.result, endedAt: Date.now(), ...(msg.event.screenshot ? { screenshot: msg.event.screenshot } : {}) });
              }
            } else if (evType === "step") {
              meta.steps.push({ id: msg.event.id, title: msg.event.title, status: msg.event.status, detail: msg.event.detail, timestamp: Date.now() });
            }
          }
        }

        // ── P2_TASK_STEPS: Record steps for autonomous tasks ──
        if (msg.event && msg.msgId) {
          const evType = msg.event.type;
          // Check if this is an autonomous task by looking up pendingTasks
          const pendingTask = this.pendingTasks.get(msg.msgId);
          const isAutonomous = pendingTask?.sessionKey?.startsWith("autonomous_");
          
          if (isAutonomous && (evType === "tool_start" || evType === "tool_end" || evType === "step" || evType === "step_update")) {
            const taskId = pendingTask.sessionKey.replace("autonomous_", "");
            
            // Lazy-init per-task state (all Maps are synchronous, no race conditions)
            if (!this._autonomousStepCounters) this._autonomousStepCounters = new Map();
            if (!this._autonomousStepCounters.has(taskId)) this._autonomousStepCounters.set(taskId, 0);
            if (!this._toolIdToStepNum) this._toolIdToStepNum = new Map();
            if (!this._stepIdToStepNum) this._stepIdToStepNum = new Map();
            if (!this._lastStepTitle) this._lastStepTitle = new Map();
            
            // ── SYNCHRONOUS: Compute stepNum and update Maps BEFORE async DB writes ──
            // This prevents race conditions where step_update arrives before step's async IIFE completes
            let syncStepNum = null;
            let syncAction = null; // 'insert_tool', 'update_tool', 'insert_step', 'update_step', 'dedup_tool'
            
            if (evType === "tool_start") {
              const lastTitle = this._lastStepTitle.get(taskId);
              const toolTitle = msg.event.description || msg.event.title || msg.event.tool || "unknown";
              let dedupStepNum = null;
              
              if (lastTitle) {
                const lastClean = lastTitle.replace(/[📚🆘\s]/g, '').substring(0, 6);
                const toolClean = toolTitle.replace(/[📚🆘\s]/g, '').substring(0, 6);
                if (lastClean && toolClean && (lastClean.startsWith(toolClean.substring(0, 3)) || toolClean.startsWith(lastClean.substring(0, 3)))) {
                  dedupStepNum = this._autonomousStepCounters.get(taskId);
                }
              }
              this._lastStepTitle.delete(taskId);
              
              if (dedupStepNum) {
                syncStepNum = dedupStepNum;
                syncAction = 'dedup_tool';
                const toolEventId = msg.event.id;
                if (toolEventId) this._toolIdToStepNum.set(`${taskId}:${toolEventId}`, dedupStepNum);
              } else {
                syncStepNum = this._autonomousStepCounters.get(taskId) + 1;
                this._autonomousStepCounters.set(taskId, syncStepNum);
                syncAction = 'insert_tool';
                const toolEventId = msg.event.id;
                if (toolEventId) this._toolIdToStepNum.set(`${taskId}:${toolEventId}`, syncStepNum);
              }
              
            } else if (evType === "tool_end") {
              const toolEventId = msg.event.id;
              const mapKey = toolEventId ? `${taskId}:${toolEventId}` : null;
              syncStepNum = mapKey ? this._toolIdToStepNum.get(mapKey) : null;
              if (mapKey) this._toolIdToStepNum.delete(mapKey);
              syncAction = 'update_tool';
              // syncStepNum may be null - will use DB fallback in async
              
            } else if (evType === "step") {
              syncStepNum = this._autonomousStepCounters.get(taskId) + 1;
              this._autonomousStepCounters.set(taskId, syncStepNum);
              syncAction = 'insert_step';
              
              const stepTitle = msg.event.title || "Step";
              this._lastStepTitle.set(taskId, stepTitle);
              
              const stepEventId = msg.event.id;
              if (stepEventId) this._stepIdToStepNum.set(`${taskId}:${stepEventId}`, syncStepNum);
              
            } else if (evType === "step_update") {
              const stepEventId = msg.event.id;
              const mapKey = stepEventId ? `${taskId}:${stepEventId}` : null;
              syncStepNum = mapKey ? this._stepIdToStepNum.get(mapKey) : null;
              syncAction = 'update_step';
              // syncStepNum may be null - will use DB fallback in async
            }
            
            // ── ASYNC: Database operations only ──
            const capturedStepNum = syncStepNum;
            const capturedAction = syncAction;
            
            (async () => {
              try {
                const dbMod = await import("../db-adapter.mjs");
                try { await dbMod.initAdapter(); } catch(_) { /* v22.0 */ console.error("[worker-manager] silent catch:", _?.message || _); }
                
                if (capturedAction === 'insert_tool') {
                  const toolTitle = msg.event.description || msg.event.title || msg.event.tool || "unknown";
                  await dbMod.run(
                    `INSERT INTO task_steps (taskId, stepNumber, type, title, toolName, toolInput, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      taskId, capturedStepNum, "tool_call", toolTitle,
                      msg.event.tool || "",
                      typeof msg.event.args === "string" ? msg.event.args.slice(0, 2000) : JSON.stringify(msg.event.args || {}).slice(0, 2000),
                      "running", new Date().toISOString()
                    ]
                  );
                  await dbMod.run(
                    `UPDATE autonomous_tasks SET currentStep = ?, completedSteps = ? WHERE id = ?`,
                    [toolTitle, Math.max(0, capturedStepNum - 1), taskId]
                  );
                  
                } else if (capturedAction === 'dedup_tool') {
                  const toolTitle = msg.event.description || msg.event.title || msg.event.tool || "unknown";
                  await dbMod.run(
                    `UPDATE task_steps SET type = 'tool_call', title = ?, toolName = ?, toolInput = ?, status = 'running' WHERE taskId = ? AND stepNumber = ?`,
                    [
                      toolTitle, msg.event.tool || "",
                      typeof msg.event.args === "string" ? msg.event.args.slice(0, 2000) : JSON.stringify(msg.event.args || {}).slice(0, 2000),
                      taskId, capturedStepNum
                    ]
                  );
                  
                } else if (capturedAction === 'update_tool') {
                  let stepNum = capturedStepNum;
                  if (!stepNum) {
                    try {
                      const row = await dbMod.get(
                        `SELECT stepNumber FROM task_steps WHERE taskId = ? AND type = 'tool_call' AND status = 'running' ORDER BY stepNumber DESC LIMIT 1`,
                        [taskId]
                      );
                      stepNum = row?.stepNumber;
                    } catch(_) { /* v22.0 */ console.error("[worker-manager] silent catch:", _?.message || _); }
                  }
                  if (!stepNum) stepNum = this._autonomousStepCounters.get(taskId) || 1;
                  
                  const resultStr = (() => {
                    const r = msg.event.result;
                    if (!r) return "";
                    if (typeof r === "string") return r.slice(0, 5000);
                    try { return JSON.stringify(r).slice(0, 5000); } catch { return String(r).slice(0, 5000); }
                  })();
                  const now = new Date().toISOString();
                  
                  await dbMod.run(
                    `UPDATE task_steps SET status = ?, toolOutput = ?, completedAt = ?, duration = CAST((julianday(?) - julianday(createdAt)) * 86400000 AS INTEGER) WHERE taskId = ? AND stepNumber = ?`,
                    [msg.event.success ? "completed" : "failed", resultStr, now, now, taskId, stepNum]
                  );
                  
                  try {
                    const countRow = await dbMod.get(
                      `SELECT COUNT(*) as cnt FROM task_steps WHERE taskId = ? AND status IN ('completed', 'failed')`,
                      [taskId]
                    );
                    await dbMod.run(`UPDATE autonomous_tasks SET completedSteps = ? WHERE id = ?`, [countRow?.cnt || stepNum, taskId]);
                  } catch (_) {
                    await dbMod.run(`UPDATE autonomous_tasks SET completedSteps = ? WHERE id = ?`, [stepNum, taskId]);
                  }
                  
                } else if (capturedAction === 'insert_step') {
                  const stepTitle = msg.event.title || "Step";
                  const stepStatus = (msg.event.status === "success") ? "completed" : (msg.event.status || "running");
                  await dbMod.run(
                    `INSERT INTO task_steps (taskId, stepNumber, type, title, description, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [taskId, capturedStepNum, "action", stepTitle, msg.event.detail || "", stepStatus, new Date().toISOString()]
                  );
                  
                } else if (capturedAction === 'update_step') {
                  let stepNum = capturedStepNum;
                  if (!stepNum) {
                    try {
                      const row = await dbMod.get(
                        `SELECT stepNumber FROM task_steps WHERE taskId = ? AND type = 'action' AND status = 'running' ORDER BY stepNumber DESC LIMIT 1`,
                        [taskId]
                      );
                      stepNum = row?.stepNumber;
                    } catch(_) { /* v22.0 */ console.error("[worker-manager] silent catch:", _?.message || _); }
                  }
                  if (stepNum) {
                    const rawStatus = msg.event.status || "completed";
                    const newStatus = rawStatus === "success" ? "completed" : rawStatus;
                    const now = new Date().toISOString();
                    await dbMod.run(
                      `UPDATE task_steps SET status = ?, description = CASE WHEN ? != '' THEN ? ELSE description END, completedAt = CASE WHEN ? IN ('completed','failed') THEN ? ELSE completedAt END, duration = CASE WHEN ? IN ('completed','failed') THEN CAST((julianday(?) - julianday(createdAt)) * 86400000 AS INTEGER) ELSE duration END WHERE taskId = ? AND stepNumber = ?`,
                      [newStatus, msg.event.detail || "", msg.event.detail || "", newStatus, now, newStatus, now, taskId, stepNum]
                    );
                  }
                }
              } catch (e) {
                logger.debug(`[P2] task_steps write error: ${e.message}`);
              }
            })();
          }
        }
        // ── END P2_TASK_STEPS ──

        const task = this.pendingTasks.get(msg.msgId);
        // SV-FIX: If msgId is a sv-step-* sub-step, forward events to parent task
        if (!task && msg.msgId && typeof msg.msgId === 'string' && msg.msgId.startsWith('sv-step-')) {
          const parts = msg.msgId.replace('sv-step-', '').split('-');
          parts.pop(); // remove timestamp
          const svTaskId = parts.join('-');
          const parentMsgId = this._svStepToParent?.get(svTaskId);
          const evType = msg.event?.type;
          // Debug: log every sv-step event for diagnosis
          if (evType !== 'progress') {
            logger.info(`[${ts()}] [SV-STEP-FWD] msgId=${msg.msgId} evType=${evType} svTaskId=${svTaskId} parentMsgId=${parentMsgId || 'NONE'} mapSize=${this._svStepToParent?.size || 0}`);
          }
          if (parentMsgId) {
            const parentTask = this.pendingTasks.get(parentMsgId);
            if (parentTask && parentTask.ws && parentTask.ws.readyState === 1) {
              if (evType === 'stream_chunk' || evType === 'stream_start' || evType === 'stream_end'
                  || evType === 'step' || evType === 'step_update' || evType === 'progress'
                  || evType === 'thinking' || evType === 'tool_start' || evType === 'tool_end'
                  || evType === 'tool_result' || evType === 'status') {
                const wrappedEvent = {
                  type: 'step_detail',
                  svTaskId,
                  innerType: evType,
                  detail: msg.event,
                  _chatId: parentTask.chatId,
                };
                sendEvent(parentTask.ws, wrappedEvent);
                this._resetIdleTimeout(parentMsgId);
                parentTask.lastActivityAt = Date.now();
                if (evType === 'tool_start' || evType === 'tool_end') {
                  logger.info(`[${ts()}] [SV-STEP-FWD] FORWARDED ${evType} to parent WS chatId=${parentTask.chatId}`);
                }
              }
            } else {
              if (evType !== 'progress') {
                logger.info(`[${ts()}] [SV-STEP-FWD] parentTask WS not ready: found=${!!parentTask} wsReady=${parentTask?.ws?.readyState}`);
              }
            }
          } else {
            // No parent mapping — try to find it by iterating _svStepToParent keys
            if (evType !== 'progress' && this._svStepToParent?.size > 0) {
              const allKeys = [...this._svStepToParent.keys()].join(', ');
              logger.info(`[${ts()}] [SV-STEP-FWD] NO PARENT for svTaskId=${svTaskId}. Map keys: ${allKeys}`);
            }
          }
        }
        // DEBUG: trace frontend_event delivery for supervisor events
        const _evType = msg.event?.type;
        if (_evType === 'deprecated_sv_progress' || _evType === 'deprecated_sv_mode' || _evType === 'thinking' || _evType === 'step' || _evType === 'step_update') {
          logger.info(`[${ts()}] [FE-EVT] msgId=${msg.msgId} type=${_evType} taskFound=${!!task} wsReady=${task?.ws?.readyState} evDetail=${JSON.stringify(msg.event).slice(0,120)}`);
        }
        if (task) {
          this._resetIdleTimeout(msg.msgId);
          task.lastActivityAt = Date.now();

          if (task.ws && task.ws.readyState === 1) {
            // WS is still connected, send directly — inject chatId for frontend routing
            const enrichedEvent = task.chatId ? { ...msg.event, _chatId: task.chatId } : msg.event;
            if (_evType === 'deprecated_sv_progress' || _evType === 'deprecated_sv_mode') {
              logger.info(`[${ts()}] [FE-EVT] SENT to WS: type=${_evType} svTaskId=${msg.event.svTaskId || 'N/A'}`);
              // SV-FIX: Register sv-step -> parent mapping
              if (msg.event.svTaskId) {
                this._svStepToParent.set(msg.event.svTaskId, msg.msgId);
              }
            }
            sendEvent(task.ws, enrichedEvent);
          } else {
            // P1-1: WS disconnected — find the correct client by sessionKey/chatId
            // instead of blindly picking the first active connection (SEC-3 fix)
            let reconnectedWs = null;
            if (task.sessionKey && wsClients) {
              // Try to find the correct WS via chatId lookup from DB
              try {
                const chatRecord = await _deps.db?.getChatBySessionKey?.(task.sessionKey);
                if (chatRecord) {
                  const candidateWs = wsClients.get(chatRecord.id);
                  if (candidateWs && candidateWs.readyState === 1) {
                    reconnectedWs = candidateWs;
                  }
                }
              } catch (_) { /* best-effort */ }
            }
            // Fallback: iterate wsClients to find a matching session
            if (!reconnectedWs && wsClients) {
              for (const [chatId, clientWs] of wsClients) {
                if (clientWs.readyState === 1) {
                  // Only use if sessions map confirms this WS belongs to the same session
                  const clientState = sessions?.get(clientWs);
                  if (clientState?.sessionKey === task.sessionKey) {
                    reconnectedWs = clientWs;
                    break;
                  }
                }
              }
            }
            if (reconnectedWs) {
              task.ws = reconnectedWs;
              logger.info(`[${ts()}] Task ${msg.msgId} reconnected to correct client via sessionKey match`);
              const enrichedEvent2 = task.chatId ? { ...msg.event, _chatId: task.chatId } : msg.event;
              sendEvent(reconnectedWs, enrichedEvent2);
            } else {
              logger.info(`[${ts()}] Task ${msg.msgId} has no active WS client, event buffered only`);
            }
          }
        }
        break;
      }

      case "rotate_session": {
        const newKey = msg.data?.newSessionKey;
        if (newKey && sessions) {
          for (const [_ws, _state] of sessions) {
            if (_state.sessionKey && _state.sessionKey !== newKey) {
              const oldKey = _state.sessionKey;
              _state.sessionKey = newKey;
              if (_state.conversationHistory.length > 10) {
                const compressed = _state.conversationHistory.length - 10;
                const summary = `[系统: 由于上下文溢出，已压缩 ${compressed} 条早期消息。以下是最近的对话。]`;
                _state.conversationHistory = [
                  { role: "system", content: summary },
                  ..._state.conversationHistory.slice(-10)
                ];
                logger.info(`[${ts()}] Session rotated: ${oldKey} -> ${newKey} (compressed ${compressed} messages, kept 10)`);
              } else {
                logger.info(`[${ts()}] Session rotated: ${oldKey} -> ${newKey} (history preserved: ${_state.conversationHistory.length} messages)`);
              }
              if (_ws.readyState === 1) {
                _ws.send(JSON.stringify({
                  type: "system_notice",
                  message: "AI 引擎已重新连接，由于历史过长已压缩，近期上下文已保留",
                  severity: "info"
                }));
                _ws.send(JSON.stringify({ type: "history", messages: _state.conversationHistory }));
              }
              saveSession(newKey, _state.conversationHistory);
              break;
            }
          }
        }
        break;
      }

      case "auto_followup": {
        const { sessionKey: afSessionKey = "default", content: afContent } = msg;
        if (!afContent) { logger.warn(`[${ts()}] auto_followup missing content`); break; }
        logger.info(`[${ts()}] Auto-followup from worker: "${afContent.slice(0, 60)}..."`);
        if (sessions) {
          for (const [ws, state] of sessions) {
            if (state.sessionKey === afSessionKey || afSessionKey === "default") {
              if (!state.isProcessing) {
                (async () => {
                  logger.info(`[${ts()}] Dispatching auto-followup as new task`);
                  sendEvent(ws, { type: "thinking", content: "正在处理补充指令...\n" });
                  state.isProcessing = true;
                  const fMsgId = `msg-${Date.now()}-auto`;
                  try {
                    eventBuffer.startTask(fMsgId, afSessionKey, afContent);
                    const reply = await this.sendTask(fMsgId, afSessionKey, afContent, state.conversationHistory, ws);
                    sendEvent(ws, { type: "status", status: "idle" });
                    state.conversationHistory.push({ role: "user", content: `[补充指令] ${afContent}` });
                    if (reply) state.conversationHistory.push({ role: "assistant", content: reply });
                    saveSession(state.sessionKey, state.conversationHistory);
                  } catch (err) {
                    logger.info(`[${ts()}] Auto-followup error: ${err.message}`);
                    sendEvent(ws, { type: "error", message: `补充指令处理出错: ${err.message}` });
                    sendEvent(ws, { type: "status", status: "idle" });
                  } finally {
                    state.isProcessing = false;
                    eventBuffer.completeTask(fMsgId);
                  }
                })();
              } else {
                logger.info(`[${ts()}] Cannot dispatch auto-followup: still processing`);
                state.conversationHistory.push({ role: "user", content: `[待处理补充指令] ${afContent}` });
              }
              break;
            }
          }
        }
        break;
      }

      case "task_complete": {
        logger.info(`[${ts()}] [TC-DEBUG] task_complete received: msgId=${msg.msgId}, result=${msg.result ? String(msg.result).length + " chars" : "NULL"}, model=${msg.model || "N/A"}, tokens=${msg.tokens || "N/A"}`);
        const task = this.pendingTasks.get(msg.msgId);
        taskStore.completeTask(msg.msgId, msg.result || "").catch((e) => { logger.debug("[worker-manager] completeTask failed:", e.message); });
        // [QUALITY-MONITOR] Write model/tokens/routeCategory to messages table for cost & quality tracking
        if (msg.model || msg.routeCategory) {
          (async () => {
            try {
              // [QUALITY-MONITOR-FIX] Retry-based wait: try UPDATE at 3s, 7s, 12s
              const _qmMsgId = msg.msgId;
              const _qmModel = msg.model || null;
              const _qmTokens = msg.tokens || null;
              const _qmCat = msg.routeCategory || null;
              for (const delay of [3000, 4000, 5000]) {
                await new Promise(r => setTimeout(r, delay));
                const updated = await run(
                  "UPDATE messages SET model = ?, tokens = ? WHERE msgId = ? AND role = 'assistant' AND (model IS NULL OR model = '')",
                  [_qmModel, _qmTokens, _qmMsgId]
                );
                const changed = updated?.changes ?? updated?.affectedRows ?? 0;
                if (changed > 0) {
                  logger.info(`[${ts()}] [QUALITY-MONITOR] model/tokens written: msgId=${_qmMsgId} model=${_qmModel} tokens=${_qmTokens}`);
                  break;
                } else {
                  logger.warn(`[${ts()}] [QUALITY-MONITOR] UPDATE hit 0 rows (will retry): msgId=${_qmMsgId} delay=${delay}ms`);
                }
              }
            } catch(e) { logger.warn(`[${ts()}] [QUALITY-MONITOR] write failed: ${e.message}`); }
          })();
        }
        // Always clean activeTasksBySession on task_complete
        for (const [sk, info] of activeTasksBySession) {
          if (info.msgId === msg.msgId) {
            activeTasksBySession.delete(sk);
            break;
          }
        }

        if (task) {
          // [TC-STREAM-FIX] Send stream_end to frontend BEFORE deleting task from pendingTasks.
          // Without this, the frontend_event handler cannot find the task's WS when message_done arrives
          // (because task_complete IPC arrives before message_done IPC due to event ordering).
          if (task.ws && task.ws.readyState === 1 && msg.result) {
            const _tcStreamId = `tc-${Date.now()}`;
            sendEvent(task.ws, { type: "stream_end", id: _tcStreamId, content: String(msg.result), model: msg.model || "RangerAI Agent", provider: "rangerai" });
            sendEvent(task.ws, { type: "status", status: "idle" });
            logger.info(`[${ts()}] [TC-STREAM-FIX] Sent stream_end to frontend: msgId=${msg.msgId} len=${String(msg.result).length}`);
          }
          this._clearTaskTimers(msg.msgId);
          this.pendingTasks.delete(msg.msgId);
          // R39-T1: Dequeue next task if queue has items
          if (_deps.taskQueue && _deps.taskQueue.length > 0) {
            const next = _deps.taskQueue.shift();
            const waitTime = Math.round((Date.now() - next.queuedAt) / 1000);
            logger.info(`[${ts()}] [R39-T1] Dequeuing task ${next.msgId} (waited ${waitTime}s, queue remaining: ${_deps.taskQueue.length})`);
            if (next.ws?.readyState === 1) {
              sendEvent(next.ws, { type: "status", status: "processing" });
              sendEvent(next.ws, { type: "thinking", content: `\n🚀 轮到您了！等待了 ${waitTime} 秒，正在处理...\n` });
            }
            // Emit task_dequeued event [R40-T1-FIX: use event-stream.mjs with correct signature]
            try {
              const { emitEvent: _emitDequeued } = await import('../worker/event-stream.mjs');
              const _dqSessionKey = next.sessionKey || 'unknown';
              _emitDequeued(_dqSessionKey, next.msgId, 'task_dequeued', { msgId: next.msgId, waitTime, queueRemaining: _deps.taskQueue.length });
            } catch(e) { logger.warn(`[R40-T1] task_dequeued emit failed: ${e.message}`); }
            // Execute dequeued task
            this.sendTask(
              next.msgId, next.sessionKey, next.content, next.history, next.ws,
              next.model, next.attachments, next.roleSystemPrompt,
              next.traceId, next.chatId, next.userId, next.userRole
            ).then(result => next.resolve(result)).catch(err => next.reject(err));
          }
          // V3-FIX: Persist tool metadata from WS process using raw SQL
          // ChatOrchestrator in API process has empty toolMetadataByMsgId due to process separation
          if (toolMetadataByMsgId.has(msg.msgId)) {
            const toolMeta = toolMetadataByMsgId.get(msg.msgId);
            if (toolMeta && (toolMeta.tools.length > 0 || toolMeta.steps.length > 0)) {
              const toolMetadataJson = JSON.stringify(toolMeta);
              // Async DB update after ChatOrchestrator saves the message
              (async () => {
                try {
                  // Wait for ChatOrchestrator to save the message first (it runs in API process via IPC)
                  await new Promise(r => setTimeout(r, 4000));
                  // Use raw SQL to update by msgId (string), not numeric id
                  const rows = await query("SELECT id, chatId, metadata FROM messages WHERE msgId = ? AND role = 'assistant' LIMIT 1", [msg.msgId]);
                  if (rows && rows.length > 0) {
                    const row = rows[0];
                    // Merge with any existing metadata
                    let existing = {};
                    try { if (row.metadata) existing = JSON.parse(row.metadata); } catch(_err) { /* v22.0 */ console.error("[worker-manager] silent catch:", _err?.message || _err); }
                    const merged = { ...existing, ...toolMeta };
                    const mergedJson = JSON.stringify(merged);
                    await run("UPDATE messages SET metadata = ? WHERE id = ?", [mergedJson, row.id]);
                    logger.info(`[${ts()}] [V3-META] Persisted tool metadata for msgId=${msg.msgId} (${toolMeta.tools.length} tools, ${toolMeta.steps.length} steps, rowId=${row.id})`);
                  } else {
                    // Retry once more after additional delay
                    logger.info(`[${ts()}] [V3-META] Message not in DB yet for msgId=${msg.msgId}, retrying in 5s...`);
                    await new Promise(r => setTimeout(r, 5000));
                    const rows2 = await query("SELECT id, metadata FROM messages WHERE msgId = ? AND role = 'assistant' LIMIT 1", [msg.msgId]);
                    if (rows2 && rows2.length > 0) {
                      let existing2 = {};
                      try { if (rows2[0].metadata) existing2 = JSON.parse(rows2[0].metadata); } catch(_err) { /* v22.0 */ console.error("[worker-manager] silent catch:", _err?.message || _err); }
                      const merged2 = { ...existing2, ...toolMeta };
                      await run("UPDATE messages SET metadata = ? WHERE id = ?", [JSON.stringify(merged2), rows2[0].id]);
                      logger.info(`[${ts()}] [V3-META] Persisted on retry for msgId=${msg.msgId}`);
                    } else {
                      logger.info(`[${ts()}] [V3-META] Message still not found for msgId=${msg.msgId}`);
                    }
                  }
                } catch (metaErr) {
                  logger.info(`[${ts()}] [V3-META] Failed: ${metaErr.message}`);
                }
              })();
            }
            toolMetadataByMsgId.delete(msg.msgId);
          }
          // [P0-2-FIX] Store model in side map so ws-realtime can attach to IPC response
          if (msg.model) this.lastModelByMsgId?.set(msg.msgId, msg.model);
          task.resolve(msg.result);
        } else {
          // Late result handling
          const existingBuffer = eventBuffer.buffers.get(msg.msgId);
          const alreadyStreamed = existingBuffer && existingBuffer.events &&
            existingBuffer.events.some(e => e.type === "stream_end");

          if (alreadyStreamed) {
            logger.info(`[${ts()}] Late result for ${msg.msgId} — SKIPPED (worker already pushed stream_end)`);
          } else {
            logger.info(`[${ts()}] Late result for ${msg.msgId} — no prior stream_end, pushing to clients`);
            const resultContent = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result);
            const lateStreamId = `late-${Date.now()}`;
            const lateEvents = [
              { type: "stream_start", id: lateStreamId, provider: "rangerai", model: "RangerAI Agent (Recovered)" },
              { type: "stream_chunk", content: resultContent },
              { type: "stream_end", id: lateStreamId, content: resultContent, model: "RangerAI Agent (Recovered)", provider: "rangerai" },
              { type: "status", status: "idle" }
            ];

            if (existingBuffer) {
              existingBuffer.completed = false;
              for (const ev of lateEvents) eventBuffer.addEvent(msg.msgId, ev);
              existingBuffer.completed = true;
              existingBuffer.completedAt = Date.now();
              eventBuffer._persist(msg.msgId, existingBuffer);
            } else {
              const sessionKey = activeTasksBySession.get(_deps.defaultSessionKey)?.msgId === msg.msgId ? _deps.defaultSessionKey : "unknown";
              eventBuffer.startTask(msg.msgId, sessionKey, "[recovered]");
              for (const ev of lateEvents) eventBuffer.addEvent(msg.msgId, ev);
              eventBuffer.completeTask(msg.msgId);
            }

            let pushed = false;
            for (const client of wss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                for (const ev of lateEvents) sendEvent(client, ev);
                pushed = true;
                break;
              }
            }
            if (!pushed) {
              logger.info(`[${ts()}] No connected clients for late result — saved to eventBuffer for recovery`);
            }
          }
        }
        break;
      }

      case "task_error": {
        const task = this.pendingTasks.get(msg.msgId);
        taskStore.failTask(msg.msgId, msg.error || "unknown").catch((e) => { logger.debug("[worker-manager] failTask failed:", e.message); });
        for (const [sk, info] of activeTasksBySession) {
          if (info.msgId === msg.msgId) {
            activeTasksBySession.delete(sk);
            break;
          }
        }
        if (task) {
          this._clearTaskTimers(msg.msgId);
          this.pendingTasks.delete(msg.msgId);
          task.reject(new Error(msg.error));
        }
        break;
      }

      // Phase 1: Worker DB decoupling — handle db_query IPC from Worker
      case "db_query": {
        const { reqId: dbReqId, method: dbMethod, args: dbArgs } = msg;
        // Allowed DB methods (whitelist for security)
        const DB_METHOD_WHITELIST = {
          getChatBySessionKey,
          getConversationHistory,
          // R54: Plan persistence methods
          savePlan,
          updateStepStatus,
          finalizePlan,
          getPlans,
          getActivePlan,
        };
        const dbFn = DB_METHOD_WHITELIST[dbMethod];
        if (!dbFn) {
          logger.warn(`[${ts()}] [db-proxy] Unknown DB method: ${dbMethod}`);
          this.worker?.send({ type: "db_query_response", reqId: dbReqId, ok: false, error: `Unknown method: ${dbMethod}` });
          break;
        }
        // Execute the DB query in the main process and send result back
        (async () => {
          try {
            const result = await dbFn(...(dbArgs || []));
            this.worker?.send({ type: "db_query_response", reqId: dbReqId, ok: true, result });
          } catch (dbErr) {
            logger.error(`[${ts()}] [db-proxy] DB query error (${dbMethod}): ${dbErr.message}`);
            this.worker?.send({ type: "db_query_response", reqId: dbReqId, ok: false, error: dbErr.message });
          }
        })();
        break;
      }

      // Iter-S7: Log gateway fallback events to gateway_events table for quota monitoring
      case "log_gateway_event": {
        const { provider: gwProvider, model: gwModel, error_type: gwErrType, error_message: gwErrMsg, fallback_result: gwFbResult } = msg;
        (async () => {
          try {
            await run(
              `INSERT INTO gateway_events (provider, model, error_type, error_message, fallback_result, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
              [gwProvider || 'unknown', gwModel || 'unknown', gwErrType || 'unknown', (gwErrMsg || '').slice(0, 500), gwFbResult || null, Date.now()]
            );
          } catch (e) {
            logger.warn(`[${ts()}] [worker-manager] Failed to log gateway event: ${e.message}`);
          }
        })();
        break;
      }

      case "pong":
        this.lastPongAt = Date.now();
        this.missedPings = 0;
        if (msg.gatewayConnected !== undefined) {
          this.gatewayConnected = msg.gatewayConnected;
        }
        break;

      // RCA improvement #4: Gateway reconnect notification
      case "gateway_reconnected": {
        logger.info(`[${ts()}] [worker-manager] Gateway reconnected — broadcasting recovery to clients`);
        this.gatewayConnected = true;
        // Notify all connected WebSocket clients that Gateway is back
        if (wss?.clients) {
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              sendEvent(client, { type: "system", content: "AI 引擎已恢复连接\n" });
            }
          }
        }
        break;
      }
      // P1: Forward browser_action events to WebSocket client
      case "browser_action": {
        const baTask = this.pendingTasks.get(msg.msgId);
        if (baTask?.ws?.readyState === 1) {
          const browserEvt = {
            type: "browser_action",
            msgId: msg.msgId,
            action: msg.action || "",
            screenshot: msg.screenshot || null,
            url: msg.url || "",
            args: msg.args,
            timestamp: msg.timestamp || Date.now()
          };
          baTask.ws.send(JSON.stringify(browserEvt));
        }
        break;
      }
      // P2: Forward subagent_event to WebSocket client
      case "subagent_event": {
        const saTask = this.pendingTasks.get(msg.msgId);
        if (saTask?.ws?.readyState === 1) {
          const subEvt = {
            type: "subagent_event",
            msgId: msg.msgId,
            action: msg.action || "",
            subagentId: msg.subagentId || null,
            subagentTask: msg.subagentTask || null,
            subagentStatus: msg.subagentStatus || null,
            subagentResult: msg.subagentResult || null,
            timestamp: msg.timestamp || Date.now()
          };
          saTask.ws.send(JSON.stringify(subEvt));
        }
        break;
      }
      // v1.1: Handle announce events from worker (subagent announce-triggered agent runs)
      // v14.2: All announce cases now dedup by runId — Gateway broadcasts to ALL workers,
      // so each event arrives N times (once per worker). Only process the first.
      case "announce_event": {
        // Dedup: only forward the first announce_event per runId
        const aeKey = `ae:${msg.runId}`;
        if (_deps._processedAnnounceRunIds.has(aeKey)) break;
        _deps._processedAnnounceRunIds.set(aeKey, Date.now());
        logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Streaming event: runId=${msg.runId}`);
        // Broadcast announce text to ALL connected WebSocket clients
        if (wss?.clients) {
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              sendEvent(client, msg.event);
            }
          }
        }
        break;
      }
      case "announce_final": {
        // v14.2: Dedup — only process the first announce_final per runId
        const afKey = `af:${msg.runId}`;
        if (_deps._processedAnnounceRunIds.has(afKey)) {
          logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Skipping duplicate announce_final: runId=${msg.runId}`);
          break;
        }
        _deps._processedAnnounceRunIds.set(afKey, Date.now());
        const announceText = sanitizeForFrontend(msg.text || "") || "";
        logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Final text received: runId=${msg.runId} len=${announceText.length}`);
        
        // v14.2: Skip empty or trivially short announce content (e.g. "ok", whitespace)
        if (!announceText || announceText.trim().length < 3) {
          logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Skipping trivial announce content: "${announceText}"`);
          break;
        }
        
        // v14.2: Save announce message to the most recently active chat in DB
        // This ensures announce messages persist across page refreshes
        let savedChatId = null;
        try {
          // Find the most recently updated chat to attach the announce message to
          const recentChat = await (async () => {
            const rows = await query('SELECT id FROM chats ORDER BY updatedAt DESC LIMIT 1');
            return rows.length > 0 ? rows[0] : null;
          })();
          if (recentChat) {
            savedChatId = recentChat.id;
            const announceMsgId = `announce-${Date.now()}`;
            await createMessage({
              chatId: recentChat.id,
              role: 'assistant',
              content: announceText,
              model: 'RangerAI Agent (Announce)',
              msgId: announceMsgId,
              metadata: JSON.stringify({ type: 'announce', runId: msg.runId })
            });
            logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Saved to DB: chatId=${recentChat.id}`);
          }
        } catch (dbErr) {
          logger.warn(`[${ts()}] [worker-manager] [ANNOUNCE] DB save failed: ${dbErr.message}`);
        }
        
        // v14.2: Send announce-specific event type so frontend can handle it distinctly
        // Instead of generic stream_start/chunk/end, send a dedicated announce_message event
        // that the frontend can process without conflicting with regular streaming
        const announceStreamId = "announce-" + Date.now();
        const announceEvents = [
          { type: "announce_message", content: announceText, model: "RangerAI Agent (Announce)", runId: msg.runId, chatId: savedChatId, streamId: announceStreamId },
          { type: "status", status: "idle" }
        ];
        let delivered = false;
        if (wss?.clients) {
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              for (const evt of announceEvents) {
                sendEvent(client, evt);
              }
              delivered = true;
            }
          }
        }
        // v1.2: If no clients connected, queue the announce for later delivery
        if (!delivered && announceText) {
          logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] No connected clients — queuing announce for later delivery`);
          _deps.pendingAnnounces.push({
            text: announceText,
            runId: msg.runId,
            chatId: savedChatId,
            timestamp: Date.now()
          });
          const now = Date.now();
          _deps.pendingAnnounces = _deps.pendingAnnounces.filter(a => now - a.timestamp < 300000).slice(-20);
        }
        break;
      }
      case "announce_complete": {
        // v14.2: Dedup — only process the first announce_complete per runId
        const acKey = `ac:${msg.runId}`;
        if (_deps._processedAnnounceRunIds.has(acKey)) break;
        _deps._processedAnnounceRunIds.set(acKey, Date.now());
        logger.info(`[${ts()}] [worker-manager] [ANNOUNCE] Run complete: runId=${msg.runId}`);
        // Ensure status is set to idle after announce completes
        if (wss?.clients) {
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              sendEvent(client, { type: "status", status: "idle" });
            }
          }
        }
        // v14.2: Clean up old dedup entries (keep last 5 minutes)
        const now = Date.now();
        for (const [k, v] of _deps._processedAnnounceRunIds) {
          if (now - v > 300000) _deps._processedAnnounceRunIds.delete(k);
        }
        break;
      }

    }
  }

  // ─── Timer Management ────────────────────────────────────
  _clearTaskTimers(msgId) {
    const task = this.pendingTasks.get(msgId);
    if (!task) return;
    if (task.softTimer) clearTimeout(task.softTimer);
    if (task.idleTimer) clearTimeout(task.idleTimer);
    if (task.maxTimer) clearTimeout(task.maxTimer);
  }

  _resetIdleTimeout(msgId) {
    const task = this.pendingTasks.get(msgId);
    if (!task) return;
    task.lastActivityAt = Date.now();
    if (task.idleTimer) clearTimeout(task.idleTimer);
    task.idleTimer = setTimeout(() => {
      logger.info(`[${ts()}] Task ${msgId} idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`);
      this._clearTaskTimers(msgId);
      this.pendingTasks.delete(msgId);
      if (task.ws?.readyState === 1) {
        sendEvent(task.ws, { type: "thinking", content: `\n[系统] 长时间无活动，任务超时\n` });
      }
      task.reject(new Error(`Task idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`));
    }, IDLE_TIMEOUT_MS);
  }

  // ─── Ping Monitor ────────────────────────────────────────
  _startPingMonitor() {
    this._stopPingMonitor();
    this.pingTimer = setInterval(() => {
      if (!this.worker || !this.workerReady) return;

      if (Date.now() - this.lastPongAt > WORKER_PING_TIMEOUT) {
        this.missedPings++;
        logger.info(`[${ts()}] Worker missed ${this.missedPings} pings`);
        if (this.missedPings >= 3) {
          logger.info(`[${ts()}] Worker unresponsive, killing...`);
          this.worker.kill("SIGKILL");
          return;
        }
      }

      try {
        this.worker.send({ type: "ping", id: `ping-${Date.now()}` });
      } catch (err) {
        logger.info(`[${ts()}] Failed to ping worker: ${err.message}`);
      }

      // Gateway stall detection
      const GATEWAY_STALL_MS = 240000;
      const now = Date.now();
      let stalledCount = 0;
      for (const [msgId, task] of this.pendingTasks) {
        const age = now - (task.startedAt || now);
        if (age > GATEWAY_STALL_MS && task.browser) {
          stalledCount++;
          logger.warn(`[${ts()}] [stall-detect] Task ${msgId} stalled ${Math.round(age / 1000)}s (browser task)`);
        }
      }
      if (stalledCount > 0 && !this._stalledAlertSent) {
        this._stalledAlertSent = true;
        logger.error(`[${ts()}] [stall-detect] ${stalledCount} browser task(s) stalled`);
        try {
          _execSync("sudo pkill -u admin -f chromium 2>/dev/null || true", { timeout: 5000 });
          logger.info(`[${ts()}] [stall-detect] Auto-killed chromium processes`);
        } catch (e) { /* best-effort */ }
        setTimeout(() => { this._stalledAlertSent = false; }, 120000);
      }
    }, WORKER_PING_INTERVAL);
  }

  _stopPingMonitor() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ─── RCA improvement #3: Worker auto-restart after max lifetime ──
  _startLifetimeCheck() {
    if (this._lifetimeCheckTimer) clearInterval(this._lifetimeCheckTimer);
    const MAX_LIFETIME = _deps.MAX_WORKER_LIFETIME_MS || DEFAULT_MAX_WORKER_LIFETIME_MS;
    // Check every 5 minutes
    this._lifetimeCheckTimer = setInterval(() => {
      if (!this.workerSpawnedAt || !this.workerReady) return;
      const age = Date.now() - this.workerSpawnedAt;
      if (age >= MAX_LIFETIME) {
        // Only restart if no pending tasks
        if (this.pendingTasks.size === 0) {
          logger.info(`[${ts()}] [lifetime] Worker exceeded max lifetime (${Math.round(age / 3600000)}h), scheduling graceful restart`);
          this._gracefulLifetimeRestart();
        } else {
          logger.info(`[${ts()}] [lifetime] Worker exceeded max lifetime but has ${this.pendingTasks.size} pending tasks, deferring restart`);
        }
      }
    }, 5 * 60 * 1000);
  }

  _gracefulLifetimeRestart() {
    if (this._lifetimeCheckTimer) {
      clearInterval(this._lifetimeCheckTimer);
      this._lifetimeCheckTimer = null;
    }
    // Graceful: let current tasks finish, then respawn
    logger.info(`[${ts()}] [lifetime] Initiating graceful Worker restart for state hygiene`);
    if (this.worker) {
      this.worker.kill("SIGTERM");
      // Worker exit handler will call _scheduleRespawn automatically
    }
  }

  // ─── Crash Recovery ──────────────────────────────────────
  _failAllPending(reason) {
    this.retryQueue = this.retryQueue || [];
    for (const [msgId, task] of this.pendingTasks) {
      this._clearTaskTimers(msgId);
      if (task.ws?.readyState === 1) {
        sendEvent(task.ws, { type: "thinking", content: "系统正在重新连接，您的任务将自动恢复...\n" });
      }
      if (task.content && task.retryCount < 2) {
        // P0-3: Clear activeTasksBySession before retry to prevent 409 "busy" errors
        if (task.sessionKey) {
          _deps.activeTasksBySession.delete(task.sessionKey);
        }
        this.retryQueue.push({
          msgId, ws: task.ws, resolve: task.resolve, reject: task.reject,
          content: task.content, sessionKey: task.sessionKey, history: task.history,
          model: task.model, attachments: task.attachments, roleSystemPrompt: task.roleSystemPrompt,
          retryCount: (task.retryCount || 0) + 1
        });
      } else {
        // ─── v5-salvage: Salvage partial reply from eventBuffer before discarding ───
        let salvageContent = "";
        try {
          if (_deps.eventBuffer) {
            const allEvts = _deps.eventBuffer.getEvents(msgId, 0);
            // Try stream_end first
            const streamEnd = allEvts.find(e => e.type === "stream_end");
            if (streamEnd && streamEnd.content) {
              salvageContent = streamEnd.content;
            } else {
              // Concatenate stream_chunk events
              const chunks = allEvts.filter(e => e.type === "stream_chunk");
              if (chunks.length > 0) salvageContent = chunks.map(c => c.content || "").join("");
            }
            if (!salvageContent) {
              const msgDone = allEvts.find(e => e.type === "message_done");
              if (msgDone && msgDone.content) salvageContent = msgDone.content;
            }
          }
        } catch (salvageErr) {
          logger.info(`[${ts()}] [salvage] Failed to extract partial content for ${msgId}: ${salvageErr.message}`);
        }

        // Save partial reply to database if we have any content
        if (salvageContent && task.sessionKey) {
          (async () => {
            try {
              const chatRecord = await getChatBySessionKey(task.sessionKey);
              if (chatRecord) {
                await createMessage({
                  chatId: chatRecord.id, role: "assistant", content: salvageContent, msgId,
                  metadata: JSON.stringify({ partial: true, reason: "worker_crashed", salvaged: true }),
                });
                logger.info(`[${ts()}] [salvage] Saved partial reply (${salvageContent.length} chars) for chat ${chatRecord.id}`);
              }
            } catch (dbErr) {
              logger.info(`[${ts()}] [salvage] DB save failed for ${msgId}: ${dbErr.message}`);
            }
          })();
        }

        // Send stream_end to frontend so it properly finishes the streaming state
        if (task.ws?.readyState === 1) {
          const errorMsg = salvageContent
            ? `\n\n---\n⚠️ 系统中断，以上为部分回复。请重新发送以获取完整回复。`
            : "";
          sendEvent(task.ws, {
            type: "stream_end",
            content: salvageContent ? (salvageContent + errorMsg) : "[系统中断] 任务处理被中断，请重新发送。",
            model: "RangerAI Agent (Recovered)",
            provider: "rangerai"
          });
          // Also send error event for the error banner
          sendEvent(task.ws, { type: "error", message: "系统服务重启导致任务中断，请重新发送消息。" });
        }
        // ─── end v5-salvage ───

        task.reject(new Error("任务处理中断，请重新发送"));
        if (task.sessionKey) {
          _deps.activeTasksBySession.delete(task.sessionKey);
          try { _deps.eventBuffer.completeTask(msgId); } catch (e) { /* best-effort */ }
          _deps.taskStore.completeTask(msgId, "Worker crashed").catch((e) => { logger.debug("[worker-manager] crash completeTask failed:", e.message); });
        }
      }
    }
    this.pendingTasks.clear();
    setTimeout(() => this._retryFailedTasks(), 5000);
  }

  _retryFailedTasks() {
    if (!this.retryQueue || this.retryQueue.length === 0) return;
    const tasks = this.retryQueue.splice(0);
    for (const task of tasks) {
      if (task.ws && task.ws.readyState !== 1) {
        logger.info(`[${ts()}] Skipping retry for ${task.msgId}: ws already closed`);
        task.reject(new Error("WebSocket closed before retry"));
        continue;
      }
      if (this.workerReady && this.worker) {
        logger.info(`[${ts()}] Retrying task ${task.msgId} on new worker (attempt ${task.retryCount})`);
        if (task.ws?.readyState === 1) {
          sendEvent(task.ws, { type: "thinking", content: "系统已恢复，正在继续处理您的任务...\n" });
          sendEvent(task.ws, { type: "recovery_status", phase: "retrying", message: "系统已恢复，正在重新执行任务..." });
        }
        try {
          const softTimer = setTimeout(() => {
            if (task.ws?.readyState === 1) {
              sendEvent(task.ws, { type: "thinking", content: "任务仍在后台处理中，请耐心等待...\n" });
            }
          }, SOFT_TIMEOUT_MS);
          const idleTimer = setTimeout(() => {
            logger.info(`[${ts()}] Retry task ${task.msgId} idle timeout`);
            this._clearTaskTimers(task.msgId);
            this.pendingTasks.delete(task.msgId);
            task.reject(new Error("Retry task idle timeout"));
          }, IDLE_TIMEOUT_MS);
          const maxTimer = setTimeout(() => {
            logger.info(`[${ts()}] Retry task ${task.msgId} max duration exceeded`);
            this._clearTaskTimers(task.msgId);
            this.pendingTasks.delete(task.msgId);
            task.reject(new Error("Retry task max duration exceeded"));
          }, MAX_TASK_DURATION);

          this.pendingTasks.set(task.msgId, {
            ws: task.ws, resolve: task.resolve, reject: task.reject,
            softTimer, idleTimer, maxTimer,
            content: task.content, sessionKey: task.sessionKey, history: task.history,
            retryCount: task.retryCount, lastActivityAt: Date.now(),
            startedAt: Date.now()  // P1-8: Add startedAt for stall detection
          });

          // P1-6: Re-register activeTasksBySession for the retried task
          if (task.sessionKey && _deps.activeTasksBySession) {
            _deps.activeTasksBySession.set(task.sessionKey, { msgId: task.msgId, startedAt: Date.now() });
          }

          this.worker.send({
            type: "user_message",
            id: task.msgId,
            sessionKey: task.sessionKey,
            content: task.content,
            conversationHistory: task.history || [],
            model: task.model || undefined,
            attachments: task.attachments || undefined,
            roleSystemPrompt: task.roleSystemPrompt || undefined
          });
        } catch (err) {
          logger.info(`[${ts()}] Failed to retry task: ${err.message}`);
          task.reject(new Error("Failed to retry: " + err.message));
        }
      } else {
        logger.info(`[${ts()}] Worker not ready for retry, falling back for ${task.msgId}`);
        if (task.ws?.readyState === 1) {
          sendEvent(task.ws, { type: "thinking", content: "系统恢复中，请稍后重新发送消息...\n" });
        }
        _deps.eventBuffer.markCompleted(task.msgId);
        task.reject(new Error("系统恢复中，请稍后重试"));
      }
    }
  }

  _scheduleRespawn() {
    const now = Date.now();
    this.restartHistory = this.restartHistory.filter(t => now - t < RESTART_WINDOW);

    if (this.restartHistory.length >= MAX_RESTART_COUNT) {
      logger.error(`[${ts()}] Too many restarts (${this.restartHistory.length} in 5min), entering degraded mode`);
      this.degraded = true;
      setTimeout(() => {
        logger.info(`[${ts()}] Auto-recovering from degraded mode`);
        this.degraded = false;
        this.restartHistory = [];
        this.spawn();
      }, 60000);
      return;
    }

    this.restartHistory.push(now);
    const delay = Math.min(1000 * Math.pow(2, this.restartHistory.length - 1), 30000);
    logger.info(`[${ts()}] Scheduling worker respawn in ${delay}ms`);
    setTimeout(() => { this.spawn(); }, delay);
  }

  // ─── Public API ──────────────────────────────────────────
  async gatewayRequest(method, params = {}) {
    if (!this.workerReady || !this.worker) {
      throw new Error("Worker unavailable for Gateway API request");
    }
    return new Promise((resolve, reject) => {
      const reqId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeout = setTimeout(() => {
        reject(new Error(`Gateway API timeout: ${method}`));
      }, 15000);
      const handler = (msg) => {
        if (msg.type === "gateway_api_response" && msg.reqId === reqId) {
          this.worker.removeListener("message", handler);
          clearTimeout(timeout);
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error || "Gateway API error"));
        }
      };
      this.worker.on("message", handler);
      try {
        this.worker.send({ type: "gateway_api_request", reqId, method, params });
      } catch (err) {
        this.worker.removeListener("message", handler);
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  async sendTask(msgId, sessionKey, content, history, ws, model, attachments, roleSystemPrompt, traceId, chatId, userId, userRole = 'member') {
    if (this.degraded || !this.workerReady || !this.worker) {
      throw new Error("Worker unavailable");
    }

    // R39-T1: Concurrency cap with FIFO queue backpressure
    const MAX_CONCURRENT_TASKS = _deps.MAX_CONCURRENT_TASKS || 5;
    const MAX_QUEUE_SIZE = _deps.MAX_QUEUE_SIZE || 50;
    if (this.pendingTasks.size >= MAX_CONCURRENT_TASKS) {
      // Queue instead of reject
      if (_deps.taskQueue.length >= MAX_QUEUE_SIZE) {
        logger.warn(`[${ts()}] [R39-T1] Queue full (${_deps.taskQueue.length}/${MAX_QUEUE_SIZE}), rejecting task ${msgId}`);
        if (ws?.readyState === 1) {
          sendEvent(ws, { type: "error", message: `队列已满（${MAX_QUEUE_SIZE}），请稍后再试。` });
          sendEvent(ws, { type: "status", status: "queue_full" });
        }
        throw new Error(`队列已满（${MAX_QUEUE_SIZE}），请稍候`);
      }
      // Enqueue task
      const queuedAt = Date.now();
      const position = _deps.taskQueue.length + 1;
      const estimatedWait = position * 15; // ~15s per task average
      logger.info(`[${ts()}] [R39-T1] Task ${msgId} queued at position ${position}, est wait ${estimatedWait}s`);
      if (ws?.readyState === 1) {
        sendEvent(ws, { type: "status", status: "queued", position, estimatedWait });
        sendEvent(ws, { type: "thinking", content: `\n⏳ 当前有 ${this.pendingTasks.size} 个任务正在处理，您的请求已排队（位置 #${position}），预计等待 ${estimatedWait} 秒...\n` });
      }
      // Emit task_queued event [R40-T1-FIX: use event-stream.mjs with correct signature]
      try {
        const { emitEvent: _emitQueued } = await import('../worker/event-stream.mjs');
        _emitQueued(sessionKey, msgId, 'task_queued', { msgId, position, queueSize: _deps.taskQueue.length + 1, estimatedWait, pendingTasks: this.pendingTasks.size });
      } catch(e) { logger.warn(`[R40-T1] task_queued emit failed: ${e.message}`); }
      return new Promise((resolve, reject) => {
        _deps.taskQueue.push({
          msgId, sessionKey, content, history, ws, model, attachments,
          roleSystemPrompt, traceId, chatId, userId, userRole,
          resolve, reject, queuedAt
        });
      });
    }

        // --- SUPERSEDE-FIX: Clean up old tasks for the same session ---
    for (const [oldMsgId, oldTask] of this.pendingTasks.entries()) {
      if (oldTask.sessionKey === sessionKey && oldMsgId !== msgId) {
        logger.info(`[${ts()}] [SUPERSEDE] New task ${msgId} supersedes old task ${oldMsgId} in session ${sessionKey}`);
        if (oldTask.ws && oldTask.ws.readyState === 1) {
          try {
            sendEvent(oldTask.ws, {
              type: "stream_end",
              content: "",
              _chatId: oldTask.chatId || null,
              _superseded: true
            });
            logger.info(`[${ts()}] [SUPERSEDE] Sent stream_end cleanup for ${oldMsgId}`);
          } catch (e) {
            logger.warn(`[${ts()}] [SUPERSEDE] Failed to send cleanup for ${oldMsgId}: ${e.message}`);
          }
        }
        oldTask.ws = null;
        oldTask._superseded = true;
      }
    }
return new Promise((resolve, reject) => {
      const softTimer = setTimeout(() => {
        logger.info(`[${ts()}] Task ${msgId} soft timeout (${SOFT_TIMEOUT_MS / 1000}s), keeping alive`);
        if (ws?.readyState === 1) {
          const elapsed = Math.floor(SOFT_TIMEOUT_MS / 1000);
          sendEvent(ws, { type: "thinking", content: `\n📝 正在深度分析中，已用时 ${elapsed} 秒。复杂任务需要更多时间，请耐心等待...\n` });
          sendEvent(ws, { type: "timeout_warning", elapsed, maxIdle: IDLE_TIMEOUT_MS / 1000 });
        }
      }, SOFT_TIMEOUT_MS);

      const idleTimer = setTimeout(() => {
        logger.info(`[${ts()}] Task ${msgId} idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`);
        this._clearTaskTimers(msgId);
        this.pendingTasks.delete(msgId);
        if (ws?.readyState === 1) {
          sendEvent(ws, { type: "thinking", content: `\n⏳ 任务处理时间较长（${Math.floor(IDLE_TIMEOUT_MS / 1000)}秒），正在尝试恢复连接...\n` });
          sendEvent(ws, { type: "task_timeout", reason: "idle", elapsed: IDLE_TIMEOUT_MS / 1000 });
        }
        reject(new Error(`Task idle timeout (${IDLE_TIMEOUT_MS / 1000}s)`));
      }, IDLE_TIMEOUT_MS);

      const maxTimer = setTimeout(() => {
        logger.info(`[${ts()}] Task ${msgId} max duration (${MAX_TASK_DURATION / 1000}s)`);
        this._clearTaskTimers(msgId);
        this.pendingTasks.delete(msgId);
        if (ws?.readyState === 1) {
          sendEvent(ws, { type: "thinking", content: "任务已运行超过30分钟，自动终止...\n" });
        }
        reject(new Error(`Task max duration exceeded (${MAX_TASK_DURATION / 1000}s)`));
      }, MAX_TASK_DURATION);

      this.pendingTasks.set(msgId, {
        ws, resolve, reject, softTimer, idleTimer, maxTimer,
        content, sessionKey, history, model, attachments, chatId, traceId,
        retryCount: 0, lastActivityAt: Date.now()
      });

      try {
        this.worker.send({
          type: "user_message",
          id: msgId,
          sessionKey,
          content,
          conversationHistory: history,
          model: model || undefined,
          attachments: attachments || undefined,
          roleSystemPrompt: roleSystemPrompt || undefined,
          traceId: traceId || undefined,
          chatId: chatId || undefined,
          userId: userId || undefined,  // F9: propagate userId for trace
          userRole: userRole || 'member'  // security: propagate userRole for access control
        });
      } catch (err) {
        this._clearTaskTimers(msgId);
        this.pendingTasks.delete(msgId);
        reject(new Error(`Failed to send to worker: ${err.message}`));
      }
    });
  }

  async restartWorker() {
    logger.info(`[${ts()}] Graceful worker restart requested`);
    // FIX: Clear pendingTasks before restart to prevent "busy" lock after worker dies.
    // Old tasks can never complete after worker is killed, so we must release the slots.
    if (this.pendingTasks.size > 0) {
      logger.warn(`[${ts()}] [restartWorker] Clearing ${this.pendingTasks.size} stale pending tasks before restart`);
      for (const [msgId, task] of this.pendingTasks) {
        this._clearTaskTimers(msgId);
        try {
          if (task.ws?.readyState === 1) {
            sendEvent(task.ws, { type: "status", status: "idle" });
          }
          task.reject(new Error("Worker restarting"));
        } catch (e) { /* best effort */ }
      }
      this.pendingTasks.clear();
    }
    if (this.worker) {
      try { this.worker.send({ type: "shutdown" }); } catch (e) { /* best-effort */ }
      setTimeout(() => {
        if (this.worker) this.worker.kill("SIGKILL");
      }, 3000);
    }
  }

  async recoverBrowser() {
    logger.info(`[${ts()}] Browser recovery requested`);
    if (this.worker) {
      this.worker.send({ type: "recover_browser" });
      return true;
    }
    return false;
  }

  get status() {
    return {
      workerPid: this.worker?.pid || null,
      workerReady: this.workerReady,
      degraded: this.degraded,
      pendingTasks: this.pendingTasks.size,
      restartCount: this.restartHistory.length,
      lastPongAt: this.lastPongAt,
      gatewayConnected: this.gatewayConnected || false
    };
  }
}
