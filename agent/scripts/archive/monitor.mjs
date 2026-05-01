/**
 * monitor.mjs — RangerAI 运行时指标收集模块
 * 
 * 设计原则：
 * - 独立模块，import 即用，出错不影响主流程
 * - 所有方法 try-catch 包裹，返回安全默认值
 * - 内存中存储最近 1 小时的指标，自动清理
 * - 提供 getMetrics() 供 /health 和 /api/metrics 使用
 */
import { logger } from './lib/logger.mjs';


const METRICS_WINDOW = 3600000; // 1 hour
const CLEANUP_INTERVAL = 300000; // 5 min

class Monitor {
  constructor() {
    this.taskMetrics = [];     // { ts, duration, tier, success, model, error? }
    this.connectionMetrics = []; // { ts, event, ip? }
    this.modelUsage = {};      // { "model_name": { calls, tokens, errors } }
    this.startTime = Date.now();
    this.counters = {
      totalTasks: 0,
      successTasks: 0,
      failedTasks: 0,
      totalConnections: 0,
      totalMessages: 0,
      preSearchHits: 0,
      cacheHits: 0,
      fallbackUsed: 0,
    };

    // Auto-cleanup old metrics
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL);
  }

  // Record a completed task
  recordTask({ duration, tier, success, model, error }) {
    try {
      this.taskMetrics.push({ ts: Date.now(), duration, tier, success, model, error });
      this.counters.totalTasks++;
      if (success) this.counters.successTasks++;
      else this.counters.failedTasks++;

      // Track model usage
      if (model) {
        if (!this.modelUsage[model]) {
          this.modelUsage[model] = { calls: 0, tokens: 0, errors: 0 };
        }
        this.modelUsage[model].calls++;
        if (!success) this.modelUsage[model].errors++;
      }
    } catch (e) {
      // Silent — monitoring should never crash the app
    }
  }

  // Record model token usage
  recordTokens(model, tokens) {
    try {
      if (!this.modelUsage[model]) {
        this.modelUsage[model] = { calls: 0, tokens: 0, errors: 0 };
      }
      this.modelUsage[model].tokens += tokens;
    } catch (e) { logger.error("[monitor] Error:", e.message); }
  }

  // Record a connection event
  recordConnection(event, ip) {
    try {
      this.connectionMetrics.push({ ts: Date.now(), event, ip });
      if (event === "open") this.counters.totalConnections++;
    } catch (e) { logger.error("[monitor] Error:", e.message); }
  }

  // Record a message received
  recordMessage() {
    this.counters.totalMessages++;
  }

  // Record pre-search hit
  recordPreSearch() {
    this.counters.preSearchHits++;
  }

  // Record cache hit
  recordCacheHit() {
    this.counters.cacheHits++;
  }

  // Record fallback used
  recordFallback() {
    this.counters.fallbackUsed++;
  }

  // Get comprehensive metrics snapshot
  getMetrics() {
    try {
      const now = Date.now();
      const recentTasks = this.taskMetrics.filter(t => now - t.ts < METRICS_WINDOW);
      
      // Task statistics
      const avgDuration = recentTasks.length > 0
        ? Math.round(recentTasks.reduce((s, t) => s + (t.duration || 0), 0) / recentTasks.length)
        : 0;
      const successRate = recentTasks.length > 0
        ? Math.round((recentTasks.filter(t => t.success).length / recentTasks.length) * 100)
        : 100;

      // Tier distribution
      const tierDist = {};
      for (const t of recentTasks) {
        tierDist[t.tier || "unknown"] = (tierDist[t.tier || "unknown"] || 0) + 1;
      }

      // Recent errors
      const recentErrors = recentTasks
        .filter(t => !t.success && t.error)
        .slice(-5)
        .map(t => ({ ts: t.ts, error: t.error.substring(0, 100), model: t.model }));

      // Memory usage
      const mem = process.memoryUsage();

      return {
        uptime: Math.floor((now - this.startTime) / 1000),
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        counters: { ...this.counters },
        recentWindow: {
          tasks: recentTasks.length,
          avgDuration,
          successRate,
          tierDistribution: tierDist,
        },
        modelUsage: { ...this.modelUsage },
        recentErrors,
      };
    } catch (e) {
      return { error: "Metrics collection failed", uptime: Math.floor((Date.now() - this.startTime) / 1000) };
    }
  }

  // Cleanup old metrics
  _cleanup() {
    try {
      const cutoff = Date.now() - METRICS_WINDOW;
      this.taskMetrics = this.taskMetrics.filter(t => t.ts > cutoff);
      this.connectionMetrics = this.connectionMetrics.filter(c => c.ts > cutoff);
    } catch (e) { logger.error("[monitor] Error:", e.message); }
  }

  // Graceful shutdown
  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }
}

// Singleton instance
const monitor = new Monitor();

export { monitor, Monitor };
export default monitor;
