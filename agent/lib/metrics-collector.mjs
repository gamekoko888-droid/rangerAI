/**
 * lib/metrics-collector.mjs — In-memory Sliding Window Metrics Collector
 * 
 * Collects traffic, error, and latency metrics using ring buffers.
 * Zero external dependencies. Memory-safe with fixed-size buffers.
 * 
 * Usage:
 *   import metrics from "../lib/metrics-collector.mjs";
 *   metrics.recordHttpRequest(method, path, statusCode, durationMs);
 *   metrics.recordError("gateway_timeout", { provider: "openai" });
 *   const snapshot = metrics.getSnapshot();
 */

// ═══════════════════════════════════════════════════════════════
// Ring Buffer — Fixed-size circular buffer for latency samples
// ═══════════════════════════════════════════════════════════════

class RingBuffer {
  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.buffer = new Float64Array(capacity);
    this.head = 0;
    this.count = 0;
  }

  push(value) {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getPercentile(p) {
    if (this.count === 0) return 0;
    const sorted = Array.from(this.buffer.subarray(0, this.count)).sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
    return sorted[idx];
  }

  getAvg() {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.buffer[i];
    return sum / this.count;
  }

  getMin() {
    if (this.count === 0) return 0;
    let min = Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.buffer[i] < min) min = this.buffer[i];
    }
    return min;
  }

  getMax() {
    if (this.count === 0) return 0;
    let max = -Infinity;
    for (let i = 0; i < this.count; i++) {
      if (this.buffer[i] > max) max = this.buffer[i];
    }
    return max;
  }

  size() { return this.count; }
}

// ═══════════════════════════════════════════════════════════════
// Time-Windowed Counter — Counts events in sliding time windows
// ═══════════════════════════════════════════════════════════════

class WindowedCounter {
  constructor(windowMs = 60_000, buckets = 60) {
    this.windowMs = windowMs;
    this.bucketMs = windowMs / buckets;
    this.buckets = new Array(buckets).fill(0);
    this.bucketTimestamps = new Array(buckets).fill(0);
    this.total = 0;
  }

  increment(amount = 1) {
    this._rotate();
    const idx = this._currentBucket();
    this.buckets[idx] += amount;
    this.total += amount;
  }

  getWindowCount() {
    this._rotate();
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let sum = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      if (this.bucketTimestamps[i] >= cutoff) {
        sum += this.buckets[i];
      }
    }
    return sum;
  }

  getTotal() { return this.total; }

  _currentBucket() {
    return Math.floor(Date.now() / this.bucketMs) % this.buckets.length;
  }

  _rotate() {
    const now = Date.now();
    const idx = this._currentBucket();
    const bucketStart = Math.floor(now / this.bucketMs) * this.bucketMs;
    if (this.bucketTimestamps[idx] < bucketStart) {
      this.buckets[idx] = 0;
      this.bucketTimestamps[idx] = bucketStart;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Metrics Collector
// ═══════════════════════════════════════════════════════════════

class MetricsCollector {
  constructor() {
    this.startTime = Date.now();

    // ── Traffic ──
    this.httpRequests = new WindowedCounter(60_000);     // per minute
    this.httpRequestsTotal = 0;
    this.wsConnections = 0;                               // gauge
    this.wsConnectionsPeak = 0;

    // ── Errors ──
    this.http4xx = new WindowedCounter(60_000);
    this.http5xx = new WindowedCounter(60_000);
    this.workerCrashes = new WindowedCounter(300_000);    // 5 min window
    this.workerCrashesTotal = 0;
    this.gatewayErrors = new WindowedCounter(60_000);
    this.gatewayErrorsTotal = 0;
    this.ipcValidationWarnings = new WindowedCounter(60_000);

    // ── Latency ──
    this.httpLatency = new RingBuffer(1000);
    this.modelFirstTokenLatency = new RingBuffer(500);
    this.modelTotalLatency = new RingBuffer(500);

    // ── Per-endpoint breakdown ──
    this.endpointCounts = {};   // { "POST /api/chats": count }
    this.endpointLatency = {};  // { "POST /api/chats": RingBuffer }

    // ── Custom error categories ──
    this.errorCategories = {};  // { "gateway_timeout": WindowedCounter }
  }

  // ─── Traffic Recording ──────────────────────────────────────

  recordHttpRequest(method, path, statusCode, durationMs) {
    this.httpRequests.increment();
    this.httpRequestsTotal++;

    // Status code buckets
    if (statusCode >= 400 && statusCode < 500) this.http4xx.increment();
    if (statusCode >= 500) this.http5xx.increment();

    // Latency
    if (typeof durationMs === "number") {
      this.httpLatency.push(durationMs);

      // Per-endpoint
      const key = `${method} ${path}`;
      this.endpointCounts[key] = (this.endpointCounts[key] || 0) + 1;
      if (!this.endpointLatency[key]) {
        this.endpointLatency[key] = new RingBuffer(200);
      }
      this.endpointLatency[key].push(durationMs);
    }
  }

  recordWsConnect() {
    this.wsConnections++;
    if (this.wsConnections > this.wsConnectionsPeak) {
      this.wsConnectionsPeak = this.wsConnections;
    }
  }

  recordWsDisconnect() {
    this.wsConnections = Math.max(0, this.wsConnections - 1);
  }

  // ─── Error Recording ────────────────────────────────────────

  recordWorkerCrash() {
    this.workerCrashes.increment();
    this.workerCrashesTotal++;
  }

  recordGatewayError(detail) {
    this.gatewayErrors.increment();
    this.gatewayErrorsTotal++;
  }

  recordIpcValidationWarning() {
    this.ipcValidationWarnings.increment();
  }

  recordError(category, detail) {
    if (!this.errorCategories[category]) {
      this.errorCategories[category] = new WindowedCounter(60_000);
    }
    this.errorCategories[category].increment();
  }

  // ─── Model Latency ─────────────────────────────────────────

  recordModelFirstToken(durationMs) {
    this.modelFirstTokenLatency.push(durationMs);
  }

  recordModelTotal(durationMs) {
    this.modelTotalLatency.push(durationMs);
  }

  // ─── Snapshot ───────────────────────────────────────────────

  getSnapshot() {
    const uptimeMs = Date.now() - this.startTime;
    
    // Top 10 endpoints by count
    const topEndpoints = Object.entries(this.endpointCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([endpoint, count]) => {
        const lat = this.endpointLatency[endpoint];
        return {
          endpoint,
          count,
          p50: lat ? Math.round(lat.getPercentile(0.5)) : 0,
          p99: lat ? Math.round(lat.getPercentile(0.99)) : 0,
          avg: lat ? Math.round(lat.getAvg()) : 0
        };
      });

    // Error categories
    const errors = {};
    for (const [cat, counter] of Object.entries(this.errorCategories)) {
      errors[cat] = { lastMinute: counter.getWindowCount(), total: counter.getTotal() };
    }

    return {
      uptime_seconds: Math.round(uptimeMs / 1000),
      collected_at: new Date().toISOString(),

      traffic: {
        http_rpm: this.httpRequests.getWindowCount(),
        http_total: this.httpRequestsTotal,
        ws_connections: this.wsConnections,
        ws_peak: this.wsConnectionsPeak
      },

      errors: {
        http_4xx_rpm: this.http4xx.getWindowCount(),
        http_5xx_rpm: this.http5xx.getWindowCount(),
        worker_crashes_5m: this.workerCrashes.getWindowCount(),
        worker_crashes_total: this.workerCrashesTotal,
        gateway_errors_rpm: this.gatewayErrors.getWindowCount(),
        gateway_errors_total: this.gatewayErrorsTotal,
        ipc_validation_warnings_rpm: this.ipcValidationWarnings.getWindowCount(),
        categories: errors
      },

      latency: {
        http: {
          samples: this.httpLatency.size(),
          p50: Math.round(this.httpLatency.getPercentile(0.5)),
          p99: Math.round(this.httpLatency.getPercentile(0.99)),
          avg: Math.round(this.httpLatency.getAvg()),
          min: Math.round(this.httpLatency.getMin()),
          max: Math.round(this.httpLatency.getMax())
        },
        model_first_token: {
          samples: this.modelFirstTokenLatency.size(),
          p50: Math.round(this.modelFirstTokenLatency.getPercentile(0.5)),
          p99: Math.round(this.modelFirstTokenLatency.getPercentile(0.99)),
          avg: Math.round(this.modelFirstTokenLatency.getAvg())
        },
        model_total: {
          samples: this.modelTotalLatency.size(),
          p50: Math.round(this.modelTotalLatency.getPercentile(0.5)),
          p99: Math.round(this.modelTotalLatency.getPercentile(0.99)),
          avg: Math.round(this.modelTotalLatency.getAvg())
        }
      },

      top_endpoints: topEndpoints
    };
  }

  // ─── Prometheus-compatible text format ──────────────────────

  toPrometheus() {
    const s = this.getSnapshot();
    const lines = [
      `# HELP rangerai_uptime_seconds Server uptime in seconds`,
      `# TYPE rangerai_uptime_seconds gauge`,
      `rangerai_uptime_seconds ${s.uptime_seconds}`,
      ``,
      `# HELP rangerai_http_requests_total Total HTTP requests`,
      `# TYPE rangerai_http_requests_total counter`,
      `rangerai_http_requests_total ${s.traffic.http_total}`,
      ``,
      `# HELP rangerai_http_rpm HTTP requests per minute`,
      `# TYPE rangerai_http_rpm gauge`,
      `rangerai_http_rpm ${s.traffic.http_rpm}`,
      ``,
      `# HELP rangerai_ws_connections Current WebSocket connections`,
      `# TYPE rangerai_ws_connections gauge`,
      `rangerai_ws_connections ${s.traffic.ws_connections}`,
      ``,
      `# HELP rangerai_http_5xx_rpm HTTP 5xx errors per minute`,
      `# TYPE rangerai_http_5xx_rpm gauge`,
      `rangerai_http_5xx_rpm ${s.errors.http_5xx_rpm}`,
      ``,
      `# HELP rangerai_worker_crashes_total Total worker crashes`,
      `# TYPE rangerai_worker_crashes_total counter`,
      `rangerai_worker_crashes_total ${s.errors.worker_crashes_total}`,
      ``,
      `# HELP rangerai_gateway_errors_total Total gateway errors`,
      `# TYPE rangerai_gateway_errors_total counter`,
      `rangerai_gateway_errors_total ${s.errors.gateway_errors_total}`,
      ``,
      `# HELP rangerai_http_latency_p99_ms HTTP P99 latency in ms`,
      `# TYPE rangerai_http_latency_p99_ms gauge`,
      `rangerai_http_latency_p99_ms ${s.latency.http.p99}`,
      ``,
      `# HELP rangerai_http_latency_p50_ms HTTP P50 latency in ms`,
      `# TYPE rangerai_http_latency_p50_ms gauge`,
      `rangerai_http_latency_p50_ms ${s.latency.http.p50}`,
      ``,
      `# HELP rangerai_model_first_token_p99_ms Model first token P99 latency`,
      `# TYPE rangerai_model_first_token_p99_ms gauge`,
      `rangerai_model_first_token_p99_ms ${s.latency.model_first_token.p99}`,
    ];
    return lines.join("\n") + "\n";
  }

  // ─── Reset (for testing) ────────────────────────────────────

  reset() {
    this.httpRequests = new WindowedCounter(60_000);
    this.httpRequestsTotal = 0;
    this.wsConnections = 0;
    this.wsConnectionsPeak = 0;
    this.http4xx = new WindowedCounter(60_000);
    this.http5xx = new WindowedCounter(60_000);
    this.workerCrashes = new WindowedCounter(300_000);
    this.workerCrashesTotal = 0;
    this.gatewayErrors = new WindowedCounter(60_000);
    this.gatewayErrorsTotal = 0;
    this.ipcValidationWarnings = new WindowedCounter(60_000);
    this.httpLatency = new RingBuffer(1000);
    this.modelFirstTokenLatency = new RingBuffer(500);
    this.modelTotalLatency = new RingBuffer(500);
    this.endpointCounts = {};
    this.endpointLatency = {};
    this.errorCategories = {};
    this.startTime = Date.now();
  }
}

// Singleton
const metrics = new MetricsCollector();
export default metrics;
export { MetricsCollector, RingBuffer, WindowedCounter };
