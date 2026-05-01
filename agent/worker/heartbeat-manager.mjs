import { cleanHeartbeat } from './stream-processor.mjs';

// R97 heartbeat-manager: heartbeat cleanup and optional notify timer wrapper.
// It is intentionally side-effect free until start() is called by a caller.

export class HeartbeatManager {
  constructor({ sendNotify = null, timeoutMs = 0, now = () => Date.now() } = {}) {
    this.sendNotify = sendNotify;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.lastBeatAt = this.now();
    this.timer = null;
  }

  touch() {
    this.lastBeatAt = this.now();
    return this.lastBeatAt;
  }

  clean(text) {
    const cleaned = cleanHeartbeat(text);
    if (cleaned !== text) this.touch();
    return cleaned;
  }

  snapshot() {
    return {
      timeoutMs: this.timeoutMs,
      lastBeatAt: this.lastBeatAt,
      active: Boolean(this.timer),
      timedOut: this.isTimedOut(),
    };
  }

  start({ sessionKey, taskId, intervalMs = 5000, message = '任务执行中…' } = {}) {
    this.stop();
    if (!this.sendNotify || intervalMs <= 0) return null;
    this.timer = setInterval(() => {
      if (this.timeoutMs > 0 && this.now() - this.lastBeatAt > this.timeoutMs) return;
      try { this.sendNotify(sessionKey, taskId, message); } catch (_) {}
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this.timer;
  }

  isTimedOut() {
    return this.timeoutMs > 0 && this.now() - this.lastBeatAt > this.timeoutMs;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createHeartbeatManager(options = {}) {
  return new HeartbeatManager(options);
}

export function createHeartbeatSnapshot(options = {}) {
  return createHeartbeatManager(options).snapshot();
}

export { cleanHeartbeat };
