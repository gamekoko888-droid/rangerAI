/**
 * tests/helpers/fake-deps.mjs — Minimal fake dependencies for unit testing
 *
 * Provides a buildFakeDeps() that returns a deps object matching
 * what http-routes.mjs init() expects, with all functions stubbed.
 */

/**
 * Create a minimal fake ctx object.
 */
export function buildFakeCtx() {
  return {
    config: {
      EVENT_BUFFER_DIR: "/tmp/test-events",
      OPENCLAW_CONFIG_PATH: "/tmp/test-config.json",
      WORKER_PATH: "./agent-worker.mjs",
      DATA_DIR: "/tmp/test-data",
      WORKSPACE_DIR: "/tmp/test-workspace",
      STATIC_DIR: "/tmp/test-static",
      ADMIN_UI_DIR: "/tmp/test-admin",
      UPLOAD_DIR: "/tmp/test-uploads",
      FILES_DIR: "/tmp/test-files",
    },
    services: {
      auth: {
        injectSecurityHeaders(res) {
          res.setHeader("X-Content-Type-Options", "nosniff");
        },
        setCorsHeaders(req, res) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          return true;
        },
        validateAdminToken(req) {
          const auth = req.headers?.authorization;
          return auth === "Bearer test-admin-token";
        },
        isAdminPath(url) {
          return url?.startsWith("/admin/restart") || url?.startsWith("/admin/reset");
        },
        isHealthPath(url) { return url === "/health"; },
        isAllowedOrigin() { return true; },
        ADMIN_TOKEN: "test-admin-token",
        WS_TOKEN: "test-ws-token",
      },
      redisPool: {
        isReady() { return true; },
        getHealth() { return { connected: true, url: "redis://localhost", retryCount: 0, lastError: null }; },
      },
      rateLimiter: {
        checkConnection() { return { allowed: true }; },
        addConnection() {},
        removeConnection() {},
        checkMessage() { return { allowed: true }; },
        recordMessage() {},
        completeTask() {},
        getStatus() { return {}; },
      },
      monitor: {
        recordTask() {},
        recordConnection() {},
        recordMessage() {},
        getMetrics() { return {}; },
        getStatus() { return {}; },
      },
      taskStore: {
        get() { return null; },
        set() {},
        getBySession() { return []; },
        getActive() { return []; },
      },
    },
    db: {
      extractUserFromRequest: async (req) => {
        const auth = req.headers?.authorization;
        if (auth === "Bearer test-user-token") {
          // "member" is a valid RBAC role (has ticket:read, knowledge:read, workflow:read etc.)
          return { id: "user-1", username: "testuser", role: "member" };
        }
        if (auth === "Bearer test-admin-token") {
          return { id: "admin-1", username: "admin", role: "admin" };
        }
        return null;
      },
    },
    runtime: {
      eventBuffer: { getEvents() { return []; } },
      workerManager: null,
      wss: null,
      gatewayConnector: {
        isConnected() { return true; },
        getLastPongAge() { return 5; },
        getReconnectCount() { return 0; },
      },
      redisPool: {
        connected: true,
        isReady() { return true; },
        getHealth() { return { connected: true, url: "redis://localhost", retryCount: 0, lastError: null }; },
      },
    },
  };
}

/**
 * Build a full fake deps object for http-routes.mjs init().
 */
export function buildFakeDeps(overrides = {}) {
  const ctx = buildFakeCtx();

  const deps = {
    ctx,
    workerManager: {
      isWorkerReady() { return true; },
      restartWorker() {},
      recoverBrowser() { return true; },
      status: {
        workerReady: true,
        gatewayConnected: true,
        lastPongAt: Date.now(),
        restartCount: 0,
      },
    },
    eventBuffer: ctx.runtime.eventBuffer,
    taskStore: ctx.services.taskStore,
    auth: ctx.services.auth,
    rateLimiter: ctx.services.rateLimiter,
    monitor: ctx.services.monitor,
    activeTasksBySession: new Map(),
    sessions: new Map(),
    wsClients: new Map(),

    // Delegated API handlers (return false = not handled)
    handleChatApi: async () => false,
    handleAuthApi: async () => false,
    handleTicketKolApi: async () => false,
    handleKnowledgeApi: async () => false,
    handleWorkflowApi: async () => false,
    handleTiktokApi: async () => false,
    handleSystemApi: async () => false,
    handleUserManagementApi: async () => false,
    handleRatingApi: async () => false,
    handleReportApi: async () => false,
    handleDataUploadApi: async () => false,

    // Discovery functions
    getAvailableProviders: () => [],
    getAvailableSkills: () => [],
    getAvailableTools: () => [],
    getSystemCapabilities: () => ({}),

    _execSync: () => "",
    SECRETS: {},

    ...overrides,
  };

  return deps;
}
