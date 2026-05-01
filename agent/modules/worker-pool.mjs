/**
 * worker-pool.mjs — Multi-Worker Process Pool Manager
 *
 * Replaces the single-worker WorkerManager with a pool of N workers,
 * each with its own GatewayConnector, enabling true parallel AI task processing.
 *
 * Design principles:
 *   - Each worker is a full WorkerManager instance (reuses existing code)
 *   - Task routing: session affinity first, then least-loaded worker
 *   - Backward-compatible API: drop-in replacement for WorkerManager
 *   - Graceful scaling: add/remove workers at runtime
 *
 * @version 1.0.0
 */
import { logger } from "../lib/logger.mjs";
import { WorkerManager, init as initWorkerManager } from "./worker-manager.mjs";
import { sendEvent } from "./helpers.mjs";

const ts = () => new Date().toISOString();

// ─── Configuration ──────────────────────────────────────────
const DEFAULT_POOL_SIZE = 1;
const DEFAULT_MAX_TASKS_PER_WORKER = 3;

export class WorkerPool {
  /**
   * @param {object} opts
   * @param {number} [opts.poolSize]          - Number of worker processes (default: 4)
   * @param {number} [opts.maxTasksPerWorker] - Max concurrent tasks per worker (default: 3)
   */
  constructor(opts = {}) {
    this.poolSize = 1; // HOTFIX: Force single worker to fix Gateway WS event routing
    this.maxTasksPerWorker = parseInt(process.env.MAX_TASKS_PER_WORKER || opts.maxTasksPerWorker || DEFAULT_MAX_TASKS_PER_WORKER, 10);

    /** @type {WorkerManager[]} */
    this.workers = [];

    /** @type {Map<string, number>} sessionKey → workerIndex (affinity) */
    this.sessionAffinity = new Map();

    /** @type {Map<string, number>} msgId → workerIndex (task tracking) */
    this.taskToWorker = new Map();

    // Track degraded state at pool level
    this._degraded = false;

    logger.info(`[${ts()}] [WorkerPool] Initialized: poolSize=${this.poolSize}, maxTasksPerWorker=${this.maxTasksPerWorker}, totalCapacity=${this.poolSize * this.maxTasksPerWorker}`);
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Spawn all worker processes in the pool.
   * Each WorkerManager instance manages its own child process and GatewayConnector.
   */
  spawn() {
    logger.info(`[${ts()}] [WorkerPool] Spawning ${this.poolSize} workers...`);
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new WorkerManager();
      this.workers.push(worker);
      worker.spawn();
      logger.info(`[${ts()}] [WorkerPool] Worker #${i} spawned (pid: ${worker.worker?.pid || 'pending'})`);
    }
  }

  // ─── Task Routing ──────────────────────────────────────────

  /**
   * Find the best worker for a task using:
   * 1. Session affinity (same session → same worker)
   * 2. Least-loaded (fewest active tasks)
   * 3. Skip workers that are degraded, not ready, or at capacity
   *
   * @param {string} sessionKey
   * @returns {number|null} worker index or null if all full
   */
  _selectWorker(sessionKey) {
    // 1. Session affinity — if this session was previously handled by a worker, prefer it
    if (sessionKey && this.sessionAffinity.has(sessionKey)) {
      const affinityIdx = this.sessionAffinity.get(sessionKey);
      const w = this.workers[affinityIdx];
      if (w && w.workerReady && !w.degraded && w.pendingTasks.size < this.maxTasksPerWorker) {
        return affinityIdx;
      }
      // Affinity worker is unavailable, clear affinity and fall through
      this.sessionAffinity.delete(sessionKey);
    }

    // 2. Least-loaded worker
    let bestIdx = null;
    let bestLoad = Infinity;

    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      if (!w.workerReady || w.degraded) continue;
      const load = w.pendingTasks.size;
      if (load >= this.maxTasksPerWorker) continue;
      if (load < bestLoad) {
        bestLoad = load;
        bestIdx = i;
      }
    }

    // Set affinity for future tasks from this session
    if (bestIdx !== null && sessionKey) {
      this.sessionAffinity.set(sessionKey, bestIdx);
    }

    return bestIdx;
  }

  // ─── Public API (backward-compatible with WorkerManager) ───

  /**
   * Send a task to the best available worker.
   * Drop-in replacement for WorkerManager.sendTask().
   */
  async sendTask(msgId, sessionKey, content, history, ws, model, attachments, roleSystemPrompt, traceId, chatId, userId, userRole = 'member') {
    if (this._degraded) {
      throw new Error("WorkerPool degraded — all workers unavailable");
    }

    const workerIdx = this._selectWorker(sessionKey);

    if (workerIdx === null) {
      // All workers are full
      const totalActive = this.workers.reduce((sum, w) => sum + w.pendingTasks.size, 0);
      const totalCapacity = this.poolSize * this.maxTasksPerWorker;
      logger.warn(`[${ts()}] [WorkerPool] All workers at capacity (${totalActive}/${totalCapacity}), rejecting task ${msgId}`);

      if (ws?.readyState === 1) {
        sendEvent(ws, { type: "error", message: `系统当前有 ${totalActive} 个任务正在处理（总容量 ${totalCapacity}），请稍后再试。` });
        sendEvent(ws, { type: "status", status: "busy" });
      }
      throw new Error(`WorkerPool at capacity (${totalActive}/${totalCapacity})`);
    }

    // Track which worker handles this task
    this.taskToWorker.set(msgId, workerIdx);

    logger.info(`[${ts()}] [WorkerPool] Routing task ${msgId} → Worker #${workerIdx} (load: ${this.workers[workerIdx].pendingTasks.size}/${this.maxTasksPerWorker})`);

    try {
      const result = await this.workers[workerIdx].sendTask(
        msgId, sessionKey, content, history, ws, model, attachments, roleSystemPrompt, traceId, chatId, userId, userRole
      );
      this.taskToWorker.delete(msgId);
      return result;
    } catch (err) {
      this.taskToWorker.delete(msgId);
      throw err;
    }
  }

  /**
   * [P0-2-FIX] Proxy lastModelByMsgId.get(msgId) across all workers.
   * Since poolSize=1, we always check workers[0]. Used by ws-realtime.mjs
   * to pick up the routed model after sendTask completes.
   */
  get lastModelByMsgId() {
    const self = this;
    return {
      get(msgId) {
        for (const w of self.workers) {
          const m = w.lastModelByMsgId?.get(msgId);
          if (m) return m;
        }
        return undefined;
      },
      delete(msgId) {
        for (const w of self.workers) {
          w.lastModelByMsgId?.delete(msgId);
        }
      },
      has(msgId) {
        return self.workers.some(w => w.lastModelByMsgId?.has(msgId));
      }
    };
  }

  /**
   * Cancel a task — route to the correct worker.
   */
  cancelTask(msgId, sessionKey) {
    const workerIdx = this.taskToWorker.get(msgId);
    if (workerIdx !== null && workerIdx !== undefined && this.workers[workerIdx]?.worker) {
      this.workers[workerIdx].worker.send({
        type: "cancel_task",
        msgId,
        sessionKey
      });
      logger.info(`[${ts()}] [WorkerPool] Cancel task ${msgId} → Worker #${workerIdx}`);
      return true;
    }
    // Broadcast cancel to all workers if we don't know which one has it
    for (let i = 0; i < this.workers.length; i++) {
      if (this.workers[i]?.worker && this.workers[i].workerReady) {
        try {
          this.workers[i].worker.send({ type: "cancel_task", msgId, sessionKey });
        } catch (e) { /* best effort */ }
      }
    }
    return false;
  }

  /**
   * Send user interrupt to the worker handling this session.
   */
  sendInterrupt(sessionKey, content) {
    const workerIdx = this.sessionAffinity.get(sessionKey);
    if (workerIdx !== null && workerIdx !== undefined && this.workers[workerIdx]?.worker) {
      this.workers[workerIdx].worker.send({
        type: "user_interrupt",
        sessionKey,
        content,
        timestamp: Date.now()
      });
      return true;
    }
    // Broadcast to all if unknown
    for (const w of this.workers) {
      if (w?.worker && w.workerReady) {
        try { w.worker.send({ type: "user_interrupt", sessionKey, content, timestamp: Date.now() }); } catch(e) { /* v22.0 */ console.error("[worker-pool] silent catch:", e?.message || e); }
      }
    }
    return false;
  }

  /**
   * Gateway API request — route to first available worker.
   */
  async gatewayRequest(method, params = {}) {
    for (const w of this.workers) {
      if (w.workerReady && w.worker && !w.degraded) {
        return w.gatewayRequest(method, params);
      }
    }
    throw new Error("No available worker for Gateway API request");
  }

  /**
   * Restart all workers gracefully.
   */
  async restartWorker() {
    logger.info(`[${ts()}] [WorkerPool] Restarting all ${this.workers.length} workers...`);
    this.sessionAffinity.clear();
    this.taskToWorker.clear();
    for (let i = 0; i < this.workers.length; i++) {
      try {
        await this.workers[i].restartWorker();
        logger.info(`[${ts()}] [WorkerPool] Worker #${i} restart initiated`);
      } catch (e) {
        logger.warn(`[${ts()}] [WorkerPool] Worker #${i} restart failed: ${e.message}`);
      }
    }
  }

  /**
   * Restart a specific worker by index.
   */
  async restartSingleWorker(idx) {
    if (idx < 0 || idx >= this.workers.length) {
      throw new Error(`Invalid worker index: ${idx}`);
    }
    // Clear affinity entries pointing to this worker
    for (const [sk, wi] of this.sessionAffinity) {
      if (wi === idx) this.sessionAffinity.delete(sk);
    }
    await this.workers[idx].restartWorker();
    logger.info(`[${ts()}] [WorkerPool] Worker #${idx} restart initiated`);
  }

  /**
   * Recover browser — send to all workers.
   */
  async recoverBrowser() {
    let recovered = false;
    for (const w of this.workers) {
      if (w.worker) {
        try {
          await w.recoverBrowser();
          recovered = true;
        } catch (e) { /* best effort */ }
      }
    }
    return recovered;
  }

  /**
   * Scale up — add N new workers to the pool.
   */
  scaleUp(count = 1) {
    const newSize = this.workers.length + count;
    logger.info(`[${ts()}] [WorkerPool] Scaling up: ${this.workers.length} → ${newSize}`);
    for (let i = 0; i < count; i++) {
      const worker = new WorkerManager();
      this.workers.push(worker);
      worker.spawn();
      logger.info(`[${ts()}] [WorkerPool] New Worker #${this.workers.length - 1} spawned`);
    }
    this.poolSize = this.workers.length;
  }

  /**
   * Scale down — remove N workers (drain first, then kill).
   */
  async scaleDown(count = 1) {
    const toRemove = Math.min(count, this.workers.length - 1); // Keep at least 1
    if (toRemove <= 0) {
      logger.warn(`[${ts()}] [WorkerPool] Cannot scale below 1 worker`);
      return;
    }
    logger.info(`[${ts()}] [WorkerPool] Scaling down: ${this.workers.length} → ${this.workers.length - toRemove}`);

    for (let i = 0; i < toRemove; i++) {
      const idx = this.workers.length - 1;
      const w = this.workers[idx];

      // Clear affinity entries pointing to this worker
      for (const [sk, wi] of this.sessionAffinity) {
        if (wi === idx) this.sessionAffinity.delete(sk);
      }

      // Drain and remove
      try {
        await w.restartWorker(); // This clears pending tasks and kills the worker
      } catch (e) { /* best effort */ }
      this.workers.pop();
    }
    this.poolSize = this.workers.length;
  }

  // ─── Status & Metrics ──────────────────────────────────────

  /**
   * Get combined pool status (backward-compatible with WorkerManager.status).
   */
  get status() {
    const workerStatuses = this.workers.map((w, i) => ({
      index: i,
      ...w.status
    }));

    const totalPending = this.workers.reduce((sum, w) => sum + w.pendingTasks.size, 0);
    const readyWorkers = this.workers.filter(w => w.workerReady && !w.degraded).length;
    const totalCapacity = this.poolSize * this.maxTasksPerWorker;

    return {
      // Backward-compatible fields (used by ws-realtime.mjs health/metrics)
      workerPid: this.workers[0]?.worker?.pid || null,
      workerReady: readyWorkers > 0,
      degraded: readyWorkers === 0,
      pendingTasks: totalPending,
      restartCount: this.workers.reduce((sum, w) => sum + (w.restartHistory?.length || 0), 0),
      lastPongAt: Math.max(...this.workers.map(w => w.lastPongAt || 0)),
      gatewayConnected: this.workers.some(w => w.gatewayConnected),

      // Pool-specific fields
      poolSize: this.poolSize,
      readyWorkers,
      totalCapacity,
      maxTasksPerWorker: this.maxTasksPerWorker,
      sessionAffinityCount: this.sessionAffinity.size,
      workers: workerStatuses,
    };
  }

  /**
   * Get the combined pendingTasks map (for backward-compat with ws-realtime.mjs).
   * Returns a virtual Map that aggregates all workers' pending tasks.
   */
  get pendingTasks() {
    const combined = new Map();
    for (const w of this.workers) {
      for (const [msgId, task] of w.pendingTasks) {
        combined.set(msgId, task);
      }
    }
    return combined;
  }

  /**
   * Get the first available worker's child process (for backward-compat).
   * Used by ws-realtime.mjs for IPC commands like get_browser_status.
   */
  get worker() {
    for (const w of this.workers) {
      if (w.worker && w.workerReady) return w.worker;
    }
    return this.workers[0]?.worker || null;
  }

  /**
   * Clean up stale session affinity entries periodically.
   * Call this from a setInterval in ws-realtime.mjs.
   */
  cleanupAffinity() {
    const before = this.sessionAffinity.size;
    for (const [sk, idx] of this.sessionAffinity) {
      const w = this.workers[idx];
      // Remove affinity if worker is gone or has no tasks for this session
      if (!w || !w.workerReady) {
        this.sessionAffinity.delete(sk);
        continue;
      }
      // Check if any pending task still uses this session
      let hasActiveTask = false;
      for (const [, task] of w.pendingTasks) {
        if (task.sessionKey === sk) {
          hasActiveTask = true;
          break;
        }
      }
      if (!hasActiveTask) {
        this.sessionAffinity.delete(sk);
      }
    }
    const removed = before - this.sessionAffinity.size;
    if (removed > 0) {
      logger.info(`[${ts()}] [WorkerPool] Cleaned ${removed} stale affinity entries (${this.sessionAffinity.size} remaining)`);
    }
  }
}

/**
 * Factory function to create a WorkerPool.
 * Replaces `new WorkerManager()` in context-setup.mjs.
 */
export function createWorkerPool(opts = {}) {
  return new WorkerPool(opts);
}
