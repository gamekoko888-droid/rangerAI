/**
 * lib/context-setup.mjs — Application context assembly
 *
 * Extracted from server.mjs (Iter-6.2).
 * Iter-51: Added TikTok API, embedding-cache, and knowledge-db DI initialization.
 * Iter-52: Split chat-api.mjs into auth-api, system-api, chat-api.
 * Iter-55: ChatOrchestrator DI — business logic extracted from chat-api.mjs.
 *
 * Handles:
 *   - createContext() + all injectXxx() calls
 *   - EventBuffer, WorkerManager, ws-handler, all API inits
 *   - ChatOrchestrator instantiation (Iter-55)
 *   - TikTok API DI init (moved from server.mjs)
 *   - embedding-cache DI init (query injection)
 *   - knowledge-db DI init (db functions injection)
 *   - auth-api, system-api, chat-api DI init (Iter-52 split)
 *
 * @version 5.0.0 — ChatOrchestrator DI (Iter-55)
 */
import TaskStore from "../task-store.mjs";
import { EventBuffer } from "../modules/event-buffer.mjs";
import { WorkerManager, initWorkerManager } from "../modules/worker-manager.mjs";
import { WorkerPool } from "../modules/worker-pool.mjs";
import * as wsHandler from "../modules/ws-handler.mjs";
import {
  createContext,
  injectDb,
  injectDbAdapter,
  injectKnowledgeDb,
  injectService,
  buildWsHandlerDeps,
  buildWorkerManagerDeps,
  buildChatApiDeps,
  buildChatOrchestratorDeps,
  buildAuthApiDeps,
  buildSystemApiDeps,
  buildKnowledgeApiDeps,
  buildTicketKolApiDeps,
  buildWorkflowApiDeps,
  buildUserManagementApiDeps,
  buildReportApiDeps,
} from "./context.mjs";
import * as dbModule from "../database.mjs";
import * as dbAdapterModule from "../db-adapter.mjs";
import * as knowledgeDbModule from "../knowledge-db.mjs";
// Iter-52: Split API modules (replaces monolithic chat-api.mjs)
import { init as initAuthApi } from "../api/auth-api.mjs";
import { init as initSystemApi } from "../api/system-api.mjs";
import { init as initChatApi } from "../api/chat-api.mjs";
import { init as initTicketKolApi } from "../api/ticket-kol-api.mjs";
import { init as initKnowledgeApi } from "../api/knowledge-api.mjs";
import { init as initWorkflowApi } from "../api/workflow-api.mjs";
import { init as initUserManagementApi } from "../api/user-management-api.mjs";
import { init as initReportApi, handleReportApi } from '../api/report-api.mjs';
import { loadOpenClawConfig } from "../modules/provider-discovery.mjs";
// Iter-55: ChatOrchestrator for message-sending business logic
import { ChatOrchestrator } from "../services/chat-service.mjs";

// Iter-51: DI-managed modules (moved from server.mjs)
import * as tiktokApi from "../tiktok-api.mjs";
import { init as initEmbeddingCache, warmCache } from "../embedding-cache.mjs";

/**
 * Build and return a fully-wired application context.
 * @param {{ auth, monitor, rateLimiter, redisPool }} services
 * @param {{ sendEvent, smartReplayEvents, loadSession, saveSession,
 *            getAvailableProviders, getAvailableSkills, getAvailableTools, getSystemCapabilities,
 *            expandFileAttachments, inlineFallback, generateTitle, generateSuggestions, generateHistorySummary }} fns
 * @returns ctx
 */
export async function setupContext(services, fns) {
  const { auth, monitor, rateLimiter, redisPool } = services;
  const ctx = createContext();
  // Inject services
  injectService(ctx, "redisPool", redisPool);
  injectService(ctx, "auth", auth);
  injectService(ctx, "rateLimiter", rateLimiter);
  injectService(ctx, "monitor", monitor);
  injectService(ctx, "taskStore", new TaskStore());
  // v3.6: Initialize DB adapter EARLY to prevent race condition
  // (system-api requests arriving before server.start() could hit null adapter)
  await dbAdapterModule.initAdapter();

  // Inject database layers
  injectDb(ctx, dbModule);
  injectDbAdapter(ctx, dbAdapterModule);
  injectKnowledgeDb(ctx, knowledgeDbModule);

  // ─── Iter-51: DI init for knowledge-db and embedding-cache ───
  // Inject db functions into knowledge-db (fallback to static import if init not called)
  if (typeof knowledgeDbModule.init === 'function') {
    knowledgeDbModule.init({
      query: dbAdapterModule.query,
      queryOne: dbAdapterModule.queryOne,
      run: dbAdapterModule.run,
      isMySQL: dbAdapterModule.isMySQL,
      exec: dbAdapterModule.exec,
    });
  }
  // Inject query function into embedding-cache
  if (typeof initEmbeddingCache === 'function') {
    initEmbeddingCache({
      query: dbAdapterModule.query,
    });
  }

  // Runtime instances
  ctx.runtime.eventBuffer = new EventBuffer({
    bufferDir: ctx.config.EVENT_BUFFER_DIR,
    maxBufferAge: 600000,
    cleanupInterval: 60000,
  });
  loadOpenClawConfig(ctx.config.OPENCLAW_CONFIG_PATH);
  // WorkerManager (wss set later after WSS creation)
  initWorkerManager({
    ...buildWorkerManagerDeps(ctx),
    wss: null,
  });
  ctx.runtime.workerManager = new WorkerPool();
  // ws-handler
  wsHandler.init(buildWsHandlerDeps(ctx, {
    sendEvent: fns.sendEvent,
    smartReplayEvents: fns.smartReplayEvents,
    loadSession: fns.loadSession,
    saveSession: fns.saveSession,
    getAvailableProviders: fns.getAvailableProviders,
    getAvailableSkills: fns.getAvailableSkills,
    getAvailableTools: fns.getAvailableTools,
    getSystemCapabilities: fns.getSystemCapabilities,
    expandFileAttachments: fns.expandFileAttachments,
    inlineFallback: fns.inlineFallback,
    generateTitle: fns.generateTitle,
    generateSuggestions: fns.generateSuggestions,
    generateHistorySummary: fns.generateHistorySummary,
  }));

  // ─── Iter-55: ChatOrchestrator — business logic for message sending ───
  const orchestrator = new ChatOrchestrator(buildChatOrchestratorDeps(ctx, {
    sendEvent: fns.sendEvent,
    expandFileAttachments: fns.expandFileAttachments,
    generateTitle: fns.generateTitle,
    generateSuggestions: fns.generateSuggestions,
    inlineFallback: fns.inlineFallback,
  }));
  // Iter-60: Expose orchestrator on ctx.runtime for API process overrides
  ctx.runtime.orchestrator = orchestrator;

  // ─── Iter-52/55: Split API modules init ───
  // auth-api: only needs db
  initAuthApi(buildAuthApiDeps(ctx));
  // system-api: only needs db
  initSystemApi(buildSystemApiDeps(ctx));
  // chat-api v3: thin router + ChatOrchestrator
  initChatApi(buildChatApiDeps(ctx, orchestrator));

  initKnowledgeApi(buildKnowledgeApiDeps(ctx));
  initTicketKolApi(buildTicketKolApiDeps(ctx));
  initWorkflowApi(buildWorkflowApiDeps(ctx));
  initUserManagementApi(buildUserManagementApiDeps(ctx));
  initReportApi(buildReportApiDeps(ctx));

  // ─── Iter-51: TikTok API DI init (moved from server.mjs) ───
  tiktokApi.init({ ctx });
  // Expose handleTiktokApi on ctx.runtime for server.mjs to pass to httpRoutes
  ctx.runtime.handleTiktokApi = tiktokApi.handleTiktokApi.bind(tiktokApi);
  // Expose warmCache on ctx.runtime for server.mjs startup sequence
  ctx.runtime.warmCache = warmCache;

  return ctx;
}
