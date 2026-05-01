/**
 * EventBuffer Module — Extracted from server.mjs v73
 * Manages event buffering for background tasks with disk persistence.
 */
import { logger } from './lib/logger.mjs';
import fs from "fs";
import path from "path";

const ts = () => new Date().toISOString();
const EVENT_BUFFER_DIR = "/opt/rangerai-agent/event-buffers";
try { fs.mkdirSync(EVENT_BUFFER_DIR, { recursive: true }); } catch(e) { if(e.code !== "ENOENT") logger.error("[event-buffer]", e.message); }

export class EventBuffer {
  constructor() {
    this.buffers = new Map();
    this.sessionIndex = new Map(); // BUG-12 fix: reverse index sessionKey->msgId
  }

  startTask(msgId, sessionKey, userMessage) {
    const task = {
      events: [],
      startedAt: Date.now(),
      sessionKey,
      userMessage,
      completed: false,
      completedAt: null
    };
    this.buffers.set(msgId, task);
    this.sessionIndex.set(sessionKey, msgId); // BUG-12 fix
    this._persist(msgId, task);
  }

  addEvent(msgId, event) {
    const task = this.buffers.get(msgId);
    if (!task) return;
    if (event.type === "server_ping" || event.type === "pong") return;
    task.events.push({ ...event, _ts: Date.now() });
    
    // BUG-11 fix: Increased event buffer limit from 500 to 5000 to support complex multi-tool reasoning
    if (task.events.length > 5000) {
      logger.warn(`[EventBuffer] BUG-11: msgId ${msgId} dropped 1000 events (overflow at 5000)`);
      task.events = task.events.slice(-4000);
    }
    if (task.events.length % 10 === 0) {
      this._persist(msgId, task);
    }
  }

  completeTask(msgId) {
    const task = this.buffers.get(msgId);
    if (!task) return;
    task.completed = true;
    task.completedAt = Date.now();
    this._persist(msgId, task);
    // BUG-12 fix: clear session index immediately on complete
    this.sessionIndex.delete(task.sessionKey);
    // BUG-09 fix: memory cleared after 300s, disk after 1800s (separate windows)
    setTimeout(() => { this.buffers.delete(msgId); }, 300000);
    setTimeout(() => {
      try { fs.unlinkSync(path.join(EVENT_BUFFER_DIR, msgId + ".json")); } catch(e) { if(e.code !== "ENOENT") logger.error("[event-buffer]", e.message); }
    }, 1800000);
  }

  getEvents(msgId, sinceTs = 0) {
    const task = this.buffers.get(msgId);
    if (!task) {
      const diskTask = this._loadFromDisk(msgId);
      if (diskTask) {
        this.buffers.set(msgId, diskTask);
        return diskTask.events.filter(e => (e._ts || 0) > sinceTs);
      }
      return [];
    }
    return task.events.filter(e => (e._ts || 0) > sinceTs);
  }

  markCompleted(msgId) {
    const task = this.buffers.get(msgId);
    if (task) {
      task.completed = true;
      task.completedAt = Date.now();
      task.events.push({ type: "status", status: "idle", _ts: Date.now() });
      this._persist(msgId, task);
    }
    // Also try disk
    try {
      const diskPath = path.join(EVENT_BUFFER_DIR, msgId + ".json");
      if (fs.existsSync(diskPath)) {
        const data = JSON.parse(fs.readFileSync(diskPath, "utf8"));
        data.completed = true;
        data.completedAt = Date.now();
        data.events.push({ type: "status", status: "idle", _ts: Date.now() });
        fs.writeFileSync(diskPath, JSON.stringify(data));
      }
    } catch(e) { logger.error("[event-buffer] Error:", e.message); }
  }

  getActiveTask(sessionKey) {
    // BUG-12 fix: O(1) lookup via sessionIndex
    const msgId = this.sessionIndex.get(sessionKey);
    if (msgId) {
      const task = this.buffers.get(msgId);
      if (task && !task.completed) return { msgId, ...task };
    }
    // Fallback: scan disk for recovery after restart
    try {
      const files = fs.readdirSync(EVENT_BUFFER_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const mid = file.replace(".json", "");
        const task = this._loadFromDisk(mid);
        if (task && task.sessionKey === sessionKey && !task.completed) {
          this.buffers.set(mid, task);
          this.sessionIndex.set(sessionKey, mid);
          return { msgId: mid, ...task };
        }
      }
    } catch(e) { if(e.code !== "ENOENT") logger.error("[event-buffer]", e.message); }
    return null;
  }

  getCompletedTask(sessionKey) {
    // v26: Search memory first, then disk for recently completed tasks
    let bestMatch = null;
    let bestCompletedAt = 0;
    for (const [msgId, task] of this.buffers) {
      if (task.sessionKey === sessionKey && task.completed) {
        if ((task.completedAt || 0) > bestCompletedAt) {
          bestMatch = { msgId, ...task };
          bestCompletedAt = task.completedAt || 0;
        }
      }
    }
    if (bestMatch) return bestMatch;
    // v26: Fallback to disk search for tasks that were evicted from memory
    try {
      const files = fs.readdirSync(EVENT_BUFFER_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const mid = file.replace(".json", "");
        const task = this._loadFromDisk(mid);
        if (task && task.sessionKey === sessionKey && task.completed) {
          if ((task.completedAt || 0) > bestCompletedAt) {
            bestMatch = { msgId: mid, ...task };
            bestCompletedAt = task.completedAt || 0;
          }
        }
      }
    } catch(e) { if(e.code !== "ENOENT") logger.error("[event-buffer]", e.message); }
    return bestMatch;
  }

  _persist(msgId, task) {
    try {
      fs.writeFileSync(path.join(EVENT_BUFFER_DIR, msgId + ".json"), JSON.stringify(task));
    } catch (err) {
      logger.info("[" + ts() + "] Failed to persist event buffer: " + err.message);
    }
  }

  _loadFromDisk(msgId) {
    try {
      const fp = path.join(EVENT_BUFFER_DIR, msgId + ".json");
      if (!fs.existsSync(fp)) return null;
      return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch { return null; }
  }

  // v57 FIX (HIGH-03): Periodic cleanup for abandoned tasks
  startPeriodicCleanup(intervalMs = 600000) { // every 10 min
    const _eventBufferCleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [msgId, task] of this.buffers) {
        const age = now - task.startedAt;
        const silent = now - (task.events.length > 0 ? task.events[task.events.length - 1]._ts : task.startedAt);
        // Clean up tasks older than 45 min or silent for 30 min
        if (!task.completed && (age > 2700000 || silent > 1800000)) {
          task.completed = true;
          task.completedAt = now;
          this._persist(msgId, task);
          this.sessionIndex.delete(task.sessionKey);
          cleaned++;
        }
        // Remove completed tasks older than 10 min from memory
        if (task.completed && task.completedAt && (now - task.completedAt > 600000)) {
          this.buffers.delete(msgId);
          cleaned++;
        }
      }
      // Clean up old disk files (older than 2 hours)
      try {
        const files = fs.readdirSync(EVENT_BUFFER_DIR);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const fp = path.join(EVENT_BUFFER_DIR, file);
          const stat = fs.statSync(fp);
          if (now - stat.mtimeMs > 7200000) {
            fs.unlinkSync(fp);
            cleaned++;
          }
        }
      } catch(e) { if(e.code !== "ENOENT") logger.error("[event-buffer]", e.message); }
      if (cleaned > 0) {
        logger.info(`[${ts()}] [EventBuffer] Periodic cleanup: ${cleaned} items, ${this.buffers.size} active buffers`);
      }
    }, intervalMs);
  }
}

// Singleton instance
export const eventBuffer = new EventBuffer();
eventBuffer.startPeriodicCleanup(); // v57: Start periodic cleanup

export { EVENT_BUFFER_DIR };
