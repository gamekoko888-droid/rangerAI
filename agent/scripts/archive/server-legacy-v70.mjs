/**
 * RangerAI Server v70 — Modular Architecture (Iter-54: start() fully self-contained)
 *
 * Iter-54: All top-level imperative code (env load, redis connect, context setup,
 *   http-routes init, ws-server, signal handlers) moved into start().
 *   Top-level now contains only imports + start().catch().
 *
 * Orchestration skeleton only. All heavy logic lives in:
 *   lib/bootstrap.mjs       — env loading + dynamic imports (auth/monitor/rateLimiter)
 *   lib/context-setup.mjs   — DI context assembly + all API inits + TikTok/embedding DI
 *   lib/signals.mjs         — process signal handlers
 *   modules/http-router.mjs — all HTTP route handlers
 *   modules/ws-server.mjs   — WebSocket server + heartbeat
 *   modules/worker-manager.mjs — worker lifecycle
 *   worker/index.mjs        — agent worker (via agent-worker.mjs thin wrapper)
 *
 * @version 70
 */
import { logger } from './lib/logger.mjs';
import http from "http";
import { execSync as _execSync } from "child_process";
import fs from "fs";
import { loadAllEnvironments, loadBootstrap } from "./lib/bootstrap.mjs";
import { setupContext } from "./lib/context-setup.mjs";
import { startBackgroundJobs } from "./services/background-jobs.mjs";
import { registerSignalHandlers } from "./lib/signals.mjs";
import { ts } from "./modules/helpers.mjs";
import { sendEvent, smartReplayEvents, safeWriteFileSync, loadSession, saveSession } from "./modules/helpers.mjs";
import { generateTitle, generateSuggestions, generateHistorySummary, inlineFallback } from "./modules/ai-services.mjs";
import { getAvailableProviders, getAvailableSkills, getAvailableTools, getSystemCapabilities } from "./modules/provider-discovery.mjs";
import { expandFileAttachments } from "./modules/file-handler.mjs";
import * as httpRoutes from "./modules/http-router.mjs";

import { createWsServer } from "./modules/ws-server.mjs";
import { redisPool } from "./redis-pool.mjs";

// ─── Split API Handlers (Iter-52) ────────────────────────────
import { handleAuthApi } from "./api/auth-api.mjs";
import { handleSystemApi } from "./api/system-api.mjs";
import { handleChatApi } from "./api/chat-api.mjs";
import { handleTicketKolApi } from "./api/ticket-kol-api.mjs";
import { handleKnowledgeApi } from "./api/knowledge-api.mjs";
import { handleWorkflowApi } from "./api/workflow-api.mjs";
import { handleUserManagementApi } from "./api/user-management-api.mjs";
import { handleReportApi } from "./api/report-api.mjs";
import { handle as handleDataUploadApi } from "./api/data-upload-api.mjs";





// ─── Entry Point ──────────────────────────────────────────────
async function start() {
  // 1. Load env + secrets
  const SECRETS = loadAllEnvironments();

  // 2. Redis pool connect (after env loaded — Iter-8 fix)
  await redisPool.connect();
  logger.info(`[${new Date().toISOString()}] [server] Redis pool initialized: ${redisPool.isReady() ? "connected" : "degraded mode"}`);

  // 3. Dynamic imports: auth / monitor / rateLimiter
  const { auth, monitor, rateLimiter } = await loadBootstrap(ts);

  // 4. Context assembly (DI)
  const ctx = await setupContext(
    { auth, monitor, rateLimiter, redisPool },
    {
      sendEvent, smartReplayEvents, loadSession, saveSession,
      getAvailableProviders, getAvailableSkills, getAvailableTools, getSystemCapabilities,
      expandFileAttachments, inlineFallback, generateTitle, generateSuggestions, generateHistorySummary,
    }
  );

  // 5. Convenience aliases (backward compat)
  const { workerManager, eventBuffer, sessions, wsClients, activeTasksBySession, toolMetadataByMsgId } = ctx.runtime;
  const { taskStore } = ctx.services;

  // 6. HTTP routes init
  const handleTiktokApi = ctx.runtime.handleTiktokApi;
  httpRoutes.init({
    ctx,
    workerManager,
    eventBuffer,
    taskStore,
    activeTasksBySession,
    sessions,
    wsClients,
    SECRETS,
    _execSync,
    getAvailableProviders,
    getAvailableSkills,
    getAvailableTools,
    getSystemCapabilities,
    handleChatApi,
    handleAuthApi,
    handleSystemApi,
    handleTicketKolApi,
    handleKnowledgeApi,
    handleWorkflowApi,
    handleUserManagementApi,
    handleTiktokApi,
    handleReportApi,
    handleDataUploadApi,
  });

  // 7. HTTP server
  const server = http.createServer(async (req, res) => {
    return httpRoutes.handleRequest(req, res);
  });

  // 8. WebSocket server
  const { wss, wsHeartbeatInterval } = createWsServer(server, ctx);

  // 9. Signal handlers
  registerSignalHandlers({ ctx, workerManager, wsHeartbeatInterval, server, ts });

  // 10. DB init + cache warm
  logger.info(`[${ts()}] RangerAI Server v70 — Modular Architecture (Iter-54: fully self-contained start)`);
  logger.info(`[${ts()}] Main PID: ${process.pid}`);

  try {
    await ctx.db.initDatabase();
    logger.info(`[${ts()}] Database initialized (adapter mode)`);
    const warmCache = ctx.runtime.warmCache;
    if (warmCache) {
      warmCache().then(() => logger.info(`[${ts()}] Embedding cache warmed`)).catch(e => logger.warn(`[${ts()}] Embedding cache warm failed (non-fatal): ${e.message}`));
    }
  } catch (dbErr) {
    logger.error(`[${ts()}] CRITICAL: Database init failed: ${dbErr.message}`);
  }

  // 11. Ensure directories exist
  try { fs.mkdirSync(ctx.config.FILES_DIR, { recursive: true }); } catch (e) { /* best-effort */ }
  try { fs.mkdirSync(ctx.config.EVENT_BUFFER_DIR, { recursive: true }); } catch (e) { /* best-effort */ }

  // 12. Spawn worker + bind server
  workerManager.spawn();
  ctx.runtime.server = server;

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.info("Port in use, retrying...");
      try { _execSync(`fuser -k ${ctx.config.PORT}/tcp`); } catch (e) { /* best-effort */ }
      setTimeout(() => { server.close(); server.listen(ctx.config.PORT, "127.0.0.1"); }, 2000);
    }
  });

  server.listen(ctx.config.PORT, "127.0.0.1", () => {
    logger.info(`[${ts()}] Listening on 127.0.0.1:${ctx.config.PORT}`);
    logger.info(`[${ts()}] Worker: ${ctx.config.WORKER_PATH}`);
  });

  startBackgroundJobs(ctx);

  }
}

start().catch(err => {
  logger.error(`[${ts()}] FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
