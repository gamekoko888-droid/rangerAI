/**
 * TaskStore — Redis-backed persistent task state layer (Manus-style)
 * v57: Refactored to use shared RedisPool instead of independent connection
 * 
 * Design principles:
 * 1. Tasks are DECOUPLED from WebSocket connections
 * 2. All task state is persisted in Redis (survives process restart)
 * 3. Events are stored as Redis lists (append-only, efficient range queries)
 * 4. HTTP polling API can read task state without WebSocket
 * 5. Worker results are written to Redis, not dependent on ws connection
 * 
 * Redis key schema:
 *   task:{msgId}           — Hash: status, sessionKey, userMessage, startedAt, completedAt, result, error
 *   task:{msgId}:events    — List: ordered event objects (JSON strings)
 *   task:{msgId}:meta      — Hash: eventCount, lastEventTs, lastActivityAt
 *   session:{sessionKey}   — String: current active task msgId (or empty)
 *   session:{sessionKey}:completed — String: last completed task msgId
 *   tasks:active           — Set: all active (non-completed) task msgIds
 */

import { logger } from './lib/logger.mjs';
import { redisPool } from "./redis-pool.mjs";

const TASK_TTL = 86400; // P0: Extended from 1h to 24h for task resumption           // 1 hour TTL for completed tasks
const EVENT_MAX_COUNT = 5000;    // Max events per task (same as old EventBuffer)
const ACTIVE_TASK_TTL = 2400;    // 40 min TTL for active task keys (safety net)

class TaskStore {
  constructor() {
    // v57: No longer owns a Redis connection — uses shared pool
    this._unsubscribe = null;
  }

  get client() {
    return redisPool.getClient();
  }

  get ready() {
    return redisPool.isReady();
  }

  /**
   * v57: connect() now just waits for the shared pool to be ready.
   * The pool is initialized once in server.mjs before any module loads.
   */
  async connect() {
    // Subscribe to pool state changes for logging
    this._unsubscribe = redisPool.onStateChange((state) => {
      if (state === "connected") {
        logger.info("[TaskStore] Redis connection restored via pool");
      }
    });
    
    if (this.ready) {
      logger.info("[TaskStore] Using shared Redis pool (already connected)");
      return true;
    }
    
    // Wait for pool to connect (pool handles retries)
    await redisPool.connect();
    if (this.ready) {
      logger.info("[TaskStore] Using shared Redis pool (connected)");
    } else {
      logger.error("[TaskStore] Redis pool not available — running in degraded mode");
    }
    return this.ready;
  }

  // ─── Task Lifecycle ──────────────────────────────────────────

  // ─── v82: Redis Distributed Lock ─────────────────────────────
  async acquireLock(sessionKey, ttlMs = 300000) {
    if (!this.ready) return true; // fail-open if Redis is down
    const lockKey = `lock:session:${sessionKey}`;
    // SET NX EX — only set if not exists, with TTL
    const result = await this.client.set(lockKey, String(Date.now()), {
      NX: true,
      PX: ttlMs, // milliseconds TTL
    });
    if (result === "OK") {
      return true; // lock acquired
    }
    // Lock exists — check if it's stale (older than 2x TTL)
    const lockTime = await this.client.get(lockKey);
    if (lockTime && (Date.now() - parseInt(lockTime)) > ttlMs * 2) {
      // Force acquire stale lock
      await this.client.set(lockKey, String(Date.now()), { PX: ttlMs });
      logger.info(`[TaskStore] Force-acquired stale lock for session ${sessionKey}`);
      return true;
    }
    return false; // lock not acquired
  }
  
  async releaseLock(sessionKey) {
    if (!this.ready) return;
    const lockKey = `lock:session:${sessionKey}`;
    await this.client.del(lockKey);
  }
  
  async isLocked(sessionKey) {
    if (!this.ready) return false;
    const lockKey = `lock:session:${sessionKey}`;
    const exists = await this.client.exists(lockKey);
    return exists === 1;
  }
  // ─── End Redis Distributed Lock ─────────────────────────────

  async startTask(msgId, sessionKey, userMessage) {
    if (!this.ready) return;
    const now = Date.now();
    const pipeline = this.client.multi();
    
    pipeline.hSet(`task:${msgId}`, {
      status: "running",
      sessionKey,
      userMessage: userMessage.substring(0, 2000),
      startedAt: String(now),
      completedAt: "",
      result: "",
      error: "",
      lastActivityAt: String(now),
    });
    pipeline.expire(`task:${msgId}`, ACTIVE_TASK_TTL);
    
    pipeline.hSet(`task:${msgId}:meta`, {
      eventCount: "0",
      lastEventTs: String(now),
      lastActivityAt: String(now),
    });
    pipeline.expire(`task:${msgId}:meta`, ACTIVE_TASK_TTL);
    
    pipeline.set(`session:${sessionKey}`, msgId, { EX: ACTIVE_TASK_TTL });
    pipeline.sAdd("tasks:active", msgId);
    
    await pipeline.exec();
  }

  async addEvent(msgId, event) {
    if (!this.ready) return;
    if (event.type === "server_ping" || event.type === "pong") return;
    
    const now = Date.now();
    const eventWithTs = { ...event, _ts: now };
    
    const pipeline = this.client.multi();
    pipeline.rPush(`task:${msgId}:events`, JSON.stringify(eventWithTs));
    pipeline.hSet(`task:${msgId}:meta`, {
      lastEventTs: String(now),
      lastActivityAt: String(now),
    });
    pipeline.hSet(`task:${msgId}`, "lastActivityAt", String(now));
    pipeline.expire(`task:${msgId}`, ACTIVE_TASK_TTL);
    pipeline.expire(`task:${msgId}:events`, ACTIVE_TASK_TTL);
    pipeline.expire(`task:${msgId}:meta`, ACTIVE_TASK_TTL);
    
    await pipeline.exec();
    
    const len = await this.client.lLen(`task:${msgId}:events`);
    if (len > EVENT_MAX_COUNT) {
      await this.client.lTrim(`task:${msgId}:events`, len - EVENT_MAX_COUNT + 1000, -1);
      logger.warn(`[TaskStore] Task ${msgId} events trimmed from ${len} to ${EVENT_MAX_COUNT - 1000}`);
    }
  }

  async completeTask(msgId, result = "") {
    if (!this.ready) return;
    const now = Date.now();
    
    const sessionKey = await this.client.hGet(`task:${msgId}`, "sessionKey");
    
    const pipeline = this.client.multi();
    pipeline.hSet(`task:${msgId}`, {
      status: "completed",
      completedAt: String(now),
      result: typeof result === "string" ? result.substring(0, 50000) : JSON.stringify(result).substring(0, 50000),
    });
    pipeline.expire(`task:${msgId}`, TASK_TTL);
    pipeline.expire(`task:${msgId}:events`, TASK_TTL);
    pipeline.expire(`task:${msgId}:meta`, TASK_TTL);
    pipeline.sRem("tasks:active", msgId);
    
    if (sessionKey) {
      pipeline.del(`session:${sessionKey}`);
      pipeline.del(`lock:session:${sessionKey}`); // v82: Release lock on complete
      pipeline.set(`session:${sessionKey}:completed`, msgId, { EX: TASK_TTL });
    }
    
    await pipeline.exec();
  }

  async failTask(msgId, error = "") {
    if (!this.ready) return;
    const now = Date.now();
    const sessionKey = await this.client.hGet(`task:${msgId}`, "sessionKey");
    
    const pipeline = this.client.multi();
    pipeline.hSet(`task:${msgId}`, {
      status: "error",
      completedAt: String(now),
      error: typeof error === "string" ? error : String(error),
    });
    pipeline.expire(`task:${msgId}`, TASK_TTL);
    pipeline.expire(`task:${msgId}:events`, TASK_TTL);
    pipeline.expire(`task:${msgId}:meta`, TASK_TTL);
    pipeline.sRem("tasks:active", msgId);
    if (sessionKey) {
      pipeline.del(`session:${sessionKey}`);
      pipeline.del(`lock:session:${sessionKey}`); // v82: Release lock on fail
    }
    
    await pipeline.exec();
  }

  // ─── Query Methods ───────────────────────────────────────────

  async getTask(msgId) {
    if (!this.ready) return null;
    const data = await this.client.hGetAll(`task:${msgId}`);
    if (!data || !data.status) return null;
    return {
      msgId,
      status: data.status,
      sessionKey: data.sessionKey,
      userMessage: data.userMessage,
      startedAt: parseInt(data.startedAt) || 0,
      completedAt: parseInt(data.completedAt) || 0,
      result: data.result,
      error: data.error,
      lastActivityAt: parseInt(data.lastActivityAt) || 0,
    };
  }

  async getEvents(msgId, sinceTs = 0) {
    if (!this.ready) return [];
    const raw = await this.client.lRange(`task:${msgId}:events`, 0, -1);
    if (!raw || raw.length === 0) return [];
    
    const events = [];
    for (const str of raw) {
      try {
        const ev = JSON.parse(str);
        if ((ev._ts || 0) > sinceTs) {
          events.push(ev);
        }
      } catch(_err) { /* v22.0 */ logger.error("[task-store] silent catch:", _err?.message || _err); }
    }
    return events;
  }

  async getEventCount(msgId) {
    if (!this.ready) return 0;
    return await this.client.lLen(`task:${msgId}:events`) || 0;
  }

  async getActiveTask(sessionKey) {
    if (!this.ready) return null;
    const msgId = await this.client.get(`session:${sessionKey}`);
    if (!msgId) return null;
    const task = await this.getTask(msgId);
    if (!task || task.status !== "running") {
      await this.client.del(`session:${sessionKey}`);
      return null;
    }
    return task;
  }

  async getCompletedTask(sessionKey) {
    if (!this.ready) return null;
    const msgId = await this.client.get(`session:${sessionKey}:completed`);
    if (!msgId) return null;
    return await this.getTask(msgId);
  }

  async getActiveTasks() {
    if (!this.ready) return [];
    const msgIds = await this.client.sMembers("tasks:active");
    const tasks = [];
    for (const msgId of msgIds) {
      const task = await this.getTask(msgId);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async touchTask(msgId) {
    if (!this.ready) return;
    const now = Date.now();
    await this.client.hSet(`task:${msgId}`, "lastActivityAt", String(now));
    await this.client.expire(`task:${msgId}`, ACTIVE_TASK_TTL);
  }

  async isTaskRunning(msgId) {
    if (!this.ready) return false;
    const status = await this.client.hGet(`task:${msgId}`, "status");
    return status === "running";
  }

  // ─── HTTP API Response Helpers ───────────────────────────────

  async getTaskState(msgId, sinceTs = 0) {
    if (!this.ready) return null;
    const task = await this.getTask(msgId);
    if (!task) return null;
    
    const events = await this.getEvents(msgId, sinceTs);
    const eventCount = await this.getEventCount(msgId);
    
    return {
      ...task,
      events,
      totalEventCount: eventCount,
      newEventCount: events.length,
    };
  }

  async getSessionState(sessionKey) {
    if (!this.ready) return { status: "idle", task: null };
    
    const activeTask = await this.getActiveTask(sessionKey);
    if (activeTask) {
      return { status: "running", task: activeTask };
    }
    
    const completedTask = await this.getCompletedTask(sessionKey);
    if (completedTask) {
      return { status: "completed", task: completedTask };
    }
    
    return { status: "idle", task: null };
  }

  // ─── Cleanup ─────────────────────────────────────────────────

  async cleanupStaleTasks(maxAgeMs = 2400000) {
    if (!this.ready) return;
    const msgIds = await this.client.sMembers("tasks:active");
    const now = Date.now();
    let cleaned = 0;
    
    for (const msgId of msgIds) {
      const task = await this.getTask(msgId);
      if (!task) {
        await this.client.sRem("tasks:active", msgId);
        cleaned++;
        continue;
      }
      const age = now - task.startedAt;
      const silent = now - task.lastActivityAt;
      if (age > maxAgeMs || silent > maxAgeMs) {
        logger.info(`[TaskStore] Cleaning stale task ${msgId} (age=${Math.round(age/1000)}s, silent=${Math.round(silent/1000)}s)`);
        await this.failTask(msgId, "Task timed out (stale cleanup)");
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`[TaskStore] Cleaned ${cleaned} stale tasks`);
    }
  }


  // ─── P0: Task Resumption ─────────────────────────────────────
  async resumeTask(msgId) {
    if (!this.ready) return null;
    const task = await this.getTask(msgId);
    if (!task || task.status === 'completed') return null;
    
    const events = await this.getEvents(msgId, 0);
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    
    const resumeCount = (parseInt(task.resumeCount) || 0) + 1;
    await this.client.hSet(`task:${msgId}`, {
      status: 'running',
      resumedAt: Date.now().toString(),
      resumeCount: resumeCount.toString()
    });
    // Refresh TTL on resume
    await this.client.expire(`task:${msgId}`, TASK_TTL);
    await this.client.expire(`task:${msgId}:events`, TASK_TTL);
    
    logger.info(`[TaskStore] Resumed task ${msgId} (attempt #${resumeCount})`);
    
    return {
      ...task,
      status: 'running',
      resumeCount,
      lastEvent,
      eventCount: events.length,
      gatewaySessionKey: task.sessionKey
    };
  }

  async getResumableTasks() {
    if (!this.ready) return [];
    const activeIds = await this.client.sMembers("tasks:active");
    const resumable = [];
    
    for (const msgId of activeIds) {
      const task = await this.getTask(msgId);
      if (!task) continue;
      
      // A task is resumable if it's running/started but not in pendingTasks
      if (task.status === 'running' || task.status === 'started') {
        const age = Date.now() - (task.lastActivityAt || task.startedAt);
        // Only resume tasks that are less than 1 hour old
        if (age < 3600000) {
          resumable.push({ msgId, ...task });
        }
      }
    }
    
    return resumable;
  }

  async saveCheckpoint(msgId, checkpointData) {
    if (!this.ready) return;
    const key = `task:${msgId}:checkpoint`;
    await this.client.set(key, JSON.stringify({
      ...checkpointData,
      savedAt: Date.now()
    }));
    await this.client.expire(key, TASK_TTL);
    logger.info(`[TaskStore] Checkpoint saved for task ${msgId}`);
  }

  async getCheckpoint(msgId) {
    if (!this.ready) return null;
    const raw = await this.client.get(`task:${msgId}:checkpoint`);
    return raw ? JSON.parse(raw) : null;
  }

  async disconnect() {
    // v57: No longer owns the connection — just unsubscribe from state changes
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

export default TaskStore;
