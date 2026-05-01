/**
 * rate-limiter.mjs — RangerAI 请求限流模块
 * 
 * 设计原则：
 * - 独立模块，import 即用，出错不影响主流程
 * - 所有方法 try-catch 包裹，限流失败时默认放行（fail-open）
 * - 基于滑动窗口的令牌桶算法
 * - 支持 IP 级别和 Session 级别限流
 */

const DEFAULT_CONFIG = {
  // WebSocket connection limits (per IP)
  maxConnectionsPerIP: 20,
  
  // Message rate limits (per session)
  maxMessagesPerMinute: 60,
  maxMessagesPerHour: 600,
  
  // Concurrent task limits (per session)
  maxConcurrentTasks: 10,
  
  // Cleanup interval
  cleanupInterval: 60000, // 1 min
};

class RateLimiter {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ipConnections = new Map();    // ip -> Set<ws>
    this.sessionMessages = new Map();  // sessionKey -> { timestamps: [], concurrent: 0 }
    
    // Auto-cleanup stale entries
    this._cleanupTimer = setInterval(() => this._cleanup(), this.config.cleanupInterval);
  }

  /**
   * Check if a new WebSocket connection from this IP is allowed
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkConnection(ip) {
    try {
      if (!ip) return { allowed: true };
      
      const connections = this.ipConnections.get(ip);
      if (connections && connections.size >= this.config.maxConnectionsPerIP) {
        return { allowed: false, reason: `Too many connections from ${ip} (max: ${this.config.maxConnectionsPerIP})` };
      }
      return { allowed: true };
    } catch (e) {
      return { allowed: true }; // Fail-open
    }
  }

  /**
   * Register a new connection
   */
  addConnection(ip, ws) {
    try {
      if (!ip) return;
      if (!this.ipConnections.has(ip)) {
        this.ipConnections.set(ip, new Set());
      }
      this.ipConnections.get(ip).add(ws);
    } catch (e) { /* rate-limit redis fallback */ }
  }

  /**
   * Remove a connection
   */
  removeConnection(ip, ws) {
    try {
      if (!ip) return;
      const connections = this.ipConnections.get(ip);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) this.ipConnections.delete(ip);
      }
    } catch (e) { /* rate-limit redis fallback */ }
  }

  /**
   * Check if a new message from this session is allowed
   * @returns {{ allowed: boolean, reason?: string, retryAfter?: number }}
   */
  checkMessage(sessionKey) {
    try {
      if (!sessionKey) return { allowed: true };
      
      const now = Date.now();
      let session = this.sessionMessages.get(sessionKey);
      
      if (!session) {
        session = { timestamps: [], concurrent: 0 };
        this.sessionMessages.set(sessionKey, session);
      }
      
      // Clean old timestamps
      session.timestamps = session.timestamps.filter(t => now - t < 3600000);
      
      // Check per-minute limit
      const recentMinute = session.timestamps.filter(t => now - t < 60000).length;
      if (recentMinute >= this.config.maxMessagesPerMinute) {
        const oldestInWindow = session.timestamps.find(t => now - t < 60000);
        const retryAfter = oldestInWindow ? Math.ceil((60000 - (now - oldestInWindow)) / 1000) : 60;
        return { allowed: false, reason: `Rate limit: max ${this.config.maxMessagesPerMinute} messages/minute`, retryAfter };
      }
      
      // Check per-hour limit
      if (session.timestamps.length >= this.config.maxMessagesPerHour) {
        return { allowed: false, reason: `Rate limit: max ${this.config.maxMessagesPerHour} messages/hour`, retryAfter: 60 };
      }
      
      // Check concurrent tasks
      if (session.concurrent >= this.config.maxConcurrentTasks) {
        return { allowed: false, reason: `Max ${this.config.maxConcurrentTasks} concurrent tasks`, retryAfter: 5 };
      }
      
      return { allowed: true };
    } catch (e) {
      return { allowed: true }; // Fail-open
    }
  }

  /**
   * Record a message sent
   */
  recordMessage(sessionKey) {
    try {
      if (!sessionKey) return;
      let session = this.sessionMessages.get(sessionKey);
      if (!session) {
        session = { timestamps: [], concurrent: 0 };
        this.sessionMessages.set(sessionKey, session);
      }
      session.timestamps.push(Date.now());
      session.concurrent++;
    } catch (e) { /* rate-limit redis fallback */ }
  }

  /**
   * Record a task completed
   */
  completeTask(sessionKey) {
    try {
      if (!sessionKey) return;
      const session = this.sessionMessages.get(sessionKey);
      if (session && session.concurrent > 0) {
        session.concurrent--;
      }
    } catch (e) { /* rate-limit redis fallback */ }
  }

  /**
   * Get rate limiter status
   */
  getStatus() {
    try {
      return {
        activeIPs: this.ipConnections.size,
        activeSessions: this.sessionMessages.size,
        totalConnections: Array.from(this.ipConnections.values()).reduce((s, c) => s + c.size, 0),
      };
    } catch (e) {
      return { error: "Status unavailable" };
    }
  }

  // Cleanup stale entries
  _cleanup() {
    try {
      const now = Date.now();
      // Remove sessions with no recent activity
      for (const [key, session] of this.sessionMessages) {
        session.timestamps = session.timestamps.filter(t => now - t < 3600000);
        if (session.timestamps.length === 0 && session.concurrent === 0) {
          this.sessionMessages.delete(key);
        }
      }
      // Remove IPs with no connections
      for (const [ip, connections] of this.ipConnections) {
        if (connections.size === 0) this.ipConnections.delete(ip);
      }
    } catch (e) { /* rate-limit redis fallback */ }
  }

  // Graceful shutdown
  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }
}

// Singleton instance
const rateLimiter = new RateLimiter();

export { rateLimiter, RateLimiter };
export default rateLimiter;
