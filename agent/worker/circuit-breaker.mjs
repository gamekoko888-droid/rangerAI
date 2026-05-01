import { logger } from '../lib/logger.mjs';
// ─── Circuit Breaker v2 (RCA improvement #2) ─────────────────
// Two-tier circuit breaker: distinguishes "hard failures" (connection/scope/timeout)
// from "soft failures" (empty response, application-level issues).
//
// Hard failures trip quickly (3 consecutive) — infrastructure is broken.
// Soft failures trip slowly (8 consecutive) — application-level, may self-heal.
// Decay: failure counts decay over time if no new failures arrive.
//
//   - Split failureCount into hardFailureCount / softFailureCount
//   - Added recordSoftFailure() for empty-response scenarios
//   - Added decay logic: counters halve every decayIntervalMs without new failures
//   - Added forceReset() for external callers (e.g., Gateway reconnect)
//   - Preserved all v1 API: canRequest(), recordSuccess(), recordFailure(), getStatus(), reset()

export class CircuitBreaker {
  constructor(options = {}) {
    // Hard failure: connection refused, scope error, timeout, WebSocket close
    this.hardFailureThreshold = options.hardFailureThreshold || options.failureThreshold || 3;
    // Soft failure: empty response, application-level error
    this.softFailureThreshold = options.softFailureThreshold || 8;
    // Cooldown before HALF_OPEN probe
    this.resetTimeoutMs = options.resetTimeoutMs || 30000; // 30s
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts || 1;
    // Decay: halve failure counts if no new failure in this interval
    this.decayIntervalMs = options.decayIntervalMs || 60000; // 60s

    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.hardFailureCount = 0;
    this.softFailureCount = 0;
    this.lastFailureTime = 0;
    this.lastDecayTime = Date.now();
    this.halfOpenAttempts = 0;
    this.nextAttemptAt = 0;
    this.totalTrips = 0;
    this.lastTripReason = null; // "hard" | "soft"
  }

  // ── Backward-compatible getter ──
  get failureCount() {
    return this.hardFailureCount + this.softFailureCount;
  }

  // ── Decay stale failure counts ──
  // Previously decay only ran in CLOSED state — meaning once OPEN, counters stayed
  // elevated forever even if no new failures arrived, preventing natural recovery.
  _applyDecay() {
    const now = Date.now();
    if (now - this.lastDecayTime < this.decayIntervalMs) return;

    const elapsed = now - this.lastDecayTime;
    const periods = Math.floor(elapsed / this.decayIntervalMs);
    if (periods <= 0) return;

    if (this.state === "CLOSED" || this.state === "OPEN") {
      this.hardFailureCount = Math.max(0, this.hardFailureCount >> periods);
      this.softFailureCount = Math.max(0, this.softFailureCount >> periods);
      this.lastDecayTime = now;
    }

    // Max OPEN duration cap: if OPEN for > 5 minutes with no new failures, force HALF_OPEN probe
    const MAX_OPEN_MS = 5 * 60 * 1000;
    if (this.state === "OPEN" && this.lastFailureTime && (now - this.lastFailureTime) > MAX_OPEN_MS) {
      const ts = new Date().toISOString();
      logger.info(`[${ts}] [circuit-breaker] OPEN → HALF_OPEN (max open duration ${MAX_OPEN_MS/1000}s exceeded, forcing probe)`);
      this.state = "HALF_OPEN";
      this.halfOpenAttempts = 0;
    }
  }

  canRequest() {
    this._applyDecay();

    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      const now = Date.now();
      if (this.nextAttemptAt && now < this.nextAttemptAt) {
        return false;
      }
      const elapsed = now - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        this.halfOpenAttempts = 0;
        const ts = new Date().toISOString();
        logger.info(`[${ts}] [circuit-breaker] OPEN → HALF_OPEN (${elapsed}ms elapsed, lastTrip=${this.lastTripReason})`);
        return true;
      }
      return false;
    }
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenAttempts < this.halfOpenMaxAttempts) {
        this.halfOpenAttempts++;
        return true;
      }
      return false;
    }
    return false;
  }

  recordSuccess() {
    if (this.state === "HALF_OPEN") {
      const ts = new Date().toISOString();
      logger.info(`[${ts}] [circuit-breaker] HALF_OPEN → CLOSED (probe succeeded)`);
    }
    this.state = "CLOSED";
    this.hardFailureCount = 0;
    this.softFailureCount = 0;
    this.halfOpenAttempts = 0;
    this.nextAttemptAt = 0;
    this.lastDecayTime = Date.now();
  }

  // ── Hard failure: infrastructure-level (connection, scope, timeout) ──
  recordFailure() {
    this.hardFailureCount++;
    this.lastFailureTime = Date.now();
    this.lastDecayTime = Date.now();
    const ts = new Date().toISOString();

    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.totalTrips++;
      this.lastTripReason = "hard";
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
      logger.info(`[${ts}] [circuit-breaker] HALF_OPEN → OPEN (hard probe failed, trip #${this.totalTrips}, next probe at +${this.resetTimeoutMs}ms)`);
      return;
    }

    if (this.hardFailureCount >= this.hardFailureThreshold) {
      this.state = "OPEN";
      this.totalTrips++;
      this.lastTripReason = "hard";
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
      logger.info(`[${ts}] [circuit-breaker] CLOSED → OPEN [HARD] (${this.hardFailureCount} hard failures, trip #${this.totalTrips})`);
    } else {
      logger.info(`[${ts}] [circuit-breaker] hard failure ${this.hardFailureCount}/${this.hardFailureThreshold}`);
    }
  }

  // ── Soft failure: application-level (empty response, parse error) ──
  recordSoftFailure() {
    this.softFailureCount++;
    this.lastFailureTime = Date.now();
    this.lastDecayTime = Date.now();
    const ts = new Date().toISOString();

    if (this.state === "HALF_OPEN") {
      // Soft failure during probe — still trip, but with longer cooldown
      this.state = "OPEN";
      this.totalTrips++;
      this.lastTripReason = "soft";
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs * 2; // Double cooldown for soft
      logger.info(`[${ts}] [circuit-breaker] HALF_OPEN → OPEN (soft probe failed, trip #${this.totalTrips}, next probe at +${this.resetTimeoutMs * 2}ms)`);
      return;
    }

    if (this.softFailureCount >= this.softFailureThreshold) {
      this.state = "OPEN";
      this.totalTrips++;
      this.lastTripReason = "soft";
      this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
      logger.info(`[${ts}] [circuit-breaker] CLOSED → OPEN [SOFT] (${this.softFailureCount} soft failures, trip #${this.totalTrips})`);
    } else {
      logger.info(`[${ts}] [circuit-breaker] soft failure ${this.softFailureCount}/${this.softFailureThreshold} (not tripping yet)`);
    }
  }

  getStatus() {
    return {
      state: this.state,
      hardFailureCount: this.hardFailureCount,
      softFailureCount: this.softFailureCount,
      failureCount: this.failureCount, // backward compat
      totalTrips: this.totalTrips,
      lastTripReason: this.lastTripReason,
      halfOpenAttempts: this.halfOpenAttempts,
      nextAttemptAt: this.nextAttemptAt || null,
      lastFailureAge: this.lastFailureTime ? Date.now() - this.lastFailureTime : null
    };
  }

  reset() {
    this.state = "CLOSED";
    this.hardFailureCount = 0;
    this.softFailureCount = 0;
    this.halfOpenAttempts = 0;
    this.nextAttemptAt = 0;
    this.lastDecayTime = Date.now();
    this.lastTripReason = null;
  }

  // ── Force reset from external trigger (e.g., Gateway reconnect) ──
  forceReset(reason = "external") {
    const ts = new Date().toISOString();
    const prevState = this.state;
    this.reset();
    logger.info(`[${ts}] [circuit-breaker] ${prevState} → CLOSED (force reset: ${reason})`);
  }
}
