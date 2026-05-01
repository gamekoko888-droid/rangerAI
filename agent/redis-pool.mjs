/**
 * redis-pool.mjs — Unified Redis Connection Pool (v57)
 * 
 * CRIT-01 FIX: All modules share a single Redis connection instead of
 * creating independent connections. Provides:
 * 1. Single shared connection with automatic reconnection
 * 2. Startup readiness check with exponential backoff
 * 3. Health monitoring and connection state broadcasting
 * 4. Graceful shutdown
 */

import { logger } from './lib/logger.mjs';
import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_POOL_URL || process.env.REDIS_URL || "redis://127.0.0.1:6380";
const MAX_RETRIES = 10;
const INITIAL_RETRY_DELAY = 500; // ms
const MAX_RETRY_DELAY = 15000;   // ms

class RedisPool {
  constructor() {
    this.client = null;
    this.ready = false;
    this._connectPromise = null;
    this._listeners = new Set();
    this._retryCount = 0;
    this._shuttingDown = false;
  }

  /**
   * Connect to Redis with exponential backoff retry.
   * Returns the shared client instance.
   */
  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    return this._connectPromise;
  }

  async _doConnect() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.client = createClient({
          url: REDIS_URL,
          socket: {
            reconnectStrategy: (retries) => {
              if (this._shuttingDown) return false; // Don't reconnect during shutdown
              // P2-1: Cap reconnect attempts to prevent infinite retry loops
              if (retries > 50) {
                logger.error(`[RedisPool] Max reconnect attempts (50) exceeded, giving up`);
                return false;
              }
              const delay = Math.min(retries * 500, MAX_RETRY_DELAY);
              if (retries % 10 === 0) {
                logger.info(`[RedisPool] Reconnecting in ${delay}ms (attempt ${retries}/50)...`);
              }
              return delay;
            },
            connectTimeout: 5000,
          },
        });

        this.client.on("error", (err) => {
          // Only log unique errors, not repeated ECONNREFUSED spam
          if (this._lastError !== err.message) {
            logger.error(`[RedisPool] Redis error: ${err.message}`);
            this._lastError = err.message;
          }
          this.ready = false;
          this._notifyListeners("disconnected");
        });

        this.client.on("ready", () => {
          this.ready = true;
          this._retryCount = 0;
          this._lastError = null;
          this._notifyListeners("connected");
        });

        this.client.on("end", () => {
          this.ready = false;
          this._notifyListeners("disconnected");
        });

        await this.client.connect();
        this.ready = true;
        logger.info(`[RedisPool] Connected to Redis at ${REDIS_URL} (attempt ${attempt})`);
        return this.client;
      } catch (err) {
        logger.error(`[RedisPool] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1), MAX_RETRY_DELAY);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    logger.error(`[RedisPool] Failed to connect after ${MAX_RETRIES} attempts. Running in degraded mode.`);
    this.ready = false;
    return null;
  }

  /**
   * Get the shared Redis client. Returns null if not connected.
   */
  getClient() {
    return this.ready ? this.client : null;
  }

  /**
   * Check if Redis is ready
   */
  isReady() {
    return this.ready && this.client !== null;
  }

  /**
   * Register a listener for connection state changes
   * @param {Function} fn - callback(state: 'connected'|'disconnected')
   */
  onStateChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notifyListeners(state) {
    for (const fn of this._listeners) {
      try { fn(state); } catch (e) { /* ignore listener errors */ }
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this._shuttingDown = true;
    if (this.client) {
      try {
        await this.client.quit();
      } catch (e) {
        try { this.client.disconnect(); } catch(_) { /* v22.0 */ logger.error("[redis-pool] silent catch:", _?.message || _); }
      }
    }
    this.ready = false;
    this.client = null;
  }

  /**
   * Health check info
   */
  getHealth() {
    return {
      connected: this.ready,
      url: REDIS_URL,
      retryCount: this._retryCount,
      lastError: this._lastError || null,
    };
  }
}

// Singleton instance
const pool = new RedisPool();

export default pool;
export { pool as redisPool };
