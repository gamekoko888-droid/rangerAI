/**
 * worker-ping-monitor.mjs — Extracted from worker-manager.mjs
 * Handles ping/pong monitoring for worker process health checks.
 * @module worker-ping-monitor
 */
import { logger } from '../lib/logger.mjs';
import { ts } from './helpers.mjs';

/**
 * PingMonitor — monitors worker health via periodic ping/pong
 */
export class PingMonitor {
  constructor(workerManager) {
    this.wm = workerManager;
    this.interval = null;
    this.lastPong = Date.now();
    this.missedPings = 0;
    this.maxMissed = 3;
  }

  start(intervalMs = 30000) {
    this.stop();
    this.lastPong = Date.now();
    this.missedPings = 0;
    this.interval = setInterval(() => this._ping(), intervalMs);
    logger.info(`[${ts()}] [PingMonitor] Started (interval: ${intervalMs}ms)`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info(`[${ts()}] [PingMonitor] Stopped`);
    }
  }

  onPong() {
    this.lastPong = Date.now();
    this.missedPings = 0;
  }

  _ping() {
    const worker = this.wm.worker;
    if (!worker || !worker.connected) return;

    this.missedPings++;
    if (this.missedPings > this.maxMissed) {
      logger.warn(`[${ts()}] [PingMonitor] Worker missed ${this.missedPings} pings, restarting...`);
      this.wm.restart('ping_timeout');
      return;
    }

    try {
      worker.send({ type: 'ping', ts: Date.now() });
    } catch (err) {
      logger.warn(`[${ts()}] [PingMonitor] Failed to send ping: ${err.message}`);
    }
  }
}
