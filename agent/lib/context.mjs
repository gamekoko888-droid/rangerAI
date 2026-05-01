/**
 * lib/context.mjs — Application Context Factory
 * 
 * Sub-iter 4.2: DI 规范核心文件
 * 
 * createContext(env) → ctx
 * 
 * ctx 包含四层：
 *   ctx.config    — 运行时配置（常量，不变）
 *   ctx.services  — 有状态服务（有生命周期的）
 *   ctx.db        — 数据库操作函数集合（来自 database.mjs）
 *   ctx.runtime   — 运行时可变状态（sessions/wsClients 等 Map/Set）
 * 
 * 设计原则：
 * - services.* 有状态、有生命周期，必须通过 init(deps) 注入
 * - db.* 数据库函数集合，必须通过 init(deps) 注入
 * - config.* 常量，可直传字面量或通过 deps 注入
 * - 无状态工具函数（helpers, ai-services, provider-discovery）可直接 import
 */

import { logger } from '../lib/logger.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Create the application context from environment variables.
 * 
 * @param {object} [overrides] - Optional overrides for testing
 * @returns {object} ctx - The four-layer application context
 */
export function createContext(overrides = {}) {
  // ─── Layer 1: config（纯常量，从 env / defaults 读） ───────
  const config = {
    PORT:                parseInt(process.env.AGENT_PORT || process.env.RANGERAI_PORT || '3002'),
    NODE_ENV:            process.env.NODE_ENV || 'production',
    DEFAULT_SESSION_KEY: 'rangerai-frontend',
    HISTORY_LIMIT:       50,
    // P0-FIX v10.0: Aligned with worker-manager defaults (was 600000/90000/600000)
    // Old values caused premature timeout → abort → lane queue flooding → OOM cascade
    MAX_TASK_DURATION:   1800000,  // 30 min (was 10 min)
    SOFT_TIMEOUT_MS:     180000,   // 3 min (was 1.5 min)
    IDLE_TIMEOUT_MS:     900000,   // 15 min (was 10 min)
    WORKER_PING_INTERVAL: 10000,
    WORKER_PING_TIMEOUT:  30000,
    MAX_RESTART_COUNT:   10,
    RESTART_WINDOW:      300000,
    WORKER_PATH:         path.join(PROJECT_ROOT, 'agent-worker.mjs'),
    OPENCLAW_CONFIG_PATH: '/home/admin/.openclaw/openclaw.json',
    EVENT_BUFFER_DIR:    '/opt/rangerai-agent/event-buffer',
    FILES_DIR:           '/opt/rangerai-agent/files',
    PROJECT_ROOT,
    ...overrides.config,
  };

  // ─── Layer 2: services（有状态，有生命周期）─────────────────
  // 注意：services 在 createContext 中只是占位，
  // 实际初始化在 server.mjs 的 start() 中完成后注入。
  // 这样做是因为 services 初始化有顺序依赖和异步操作。
  const services = {
    redisPool:    null,  // → redis-pool.mjs
    auth:         null,  // → auth.mjs
    rateLimiter:  null,  // → rate-limiter.mjs
    monitor:      null,  // → monitor.mjs
    taskStore:    null,  // → task-store.mjs
    ...overrides.services,
  };

  // ─── Layer 3: db（数据库操作集合）──────────────────────────
  // 同样是占位，initDatabase() 后注入
  const db = {
    // ── lifecycle ───────────────────────────────────────────
    initDatabase:             null,
    closeDatabase:            null,
    // ── chat / session ──────────────────────────────────────
    getChats:                 null,
    getChatBySessionKey:      null,
    getChatById:              null,
    createChat:               null,
    updateChatTitle:          null,
    deleteChat:               null,
    deleteChats:              null,
    searchChats:              null,
    getAllTags:                null,
    updateChatTags:           null,
    getChatsByTag:            null,
    // ── messages ────────────────────────────────────────────
    getMessages:              null,
    createMessage:            null,
    getConversationHistory:   null,
    getMessageCount:          null,
    getMessageById:           null,
    deleteMessagesFrom:       null,
    getLastUserMessageBefore: null,
    // ── auth / users ────────────────────────────────────────
    authenticateUser:         null,
    generateToken:            null,
    verifyToken:              null,
    extractUserFromRequest:   null,
    registerUser:             null,
    getUserById:              null,
    getAllUsers:               null,
    getRoleById:              null,
    // ── invite codes ────────────────────────────────────────
    getInviteCodes:           null,
    createInviteCode:         null,
    deactivateInviteCode:     null,
    // ── sharing ─────────────────────────────────────────────
    shareChat:                null,
    unshareChat:              null,
    getSharedWithMe:          null,
    getChatShares:            null,
    hasShareAccess:           null,
    // ── quick prompts ───────────────────────────────────────
    getQuickPrompts:          null,
    incrementPromptUsage:     null,
    createPrompt:             null,
    updatePrompt:             null,
    deletePrompt:             null,
    getAllPrompts:             null,
    // ── system config ───────────────────────────────────────
    getSystemConfigs:         null,
    getSystemConfig:          null,
    updateSystemConfig:       null,
    getSystemStatus:          null,
    // ── audit ───────────────────────────────────────────────
    getAuditLogs:             null,
    insertAuditLog:           null,
    // ── ai roles ────────────────────────────────────────────
    getAiRoles:               null,
    getAiRole:                null,
    createAiRole:             null,
    updateAiRole:             null,
    deleteAiRole:             null,
    // ── stats ───────────────────────────────────────────────
    getStats:                 null,
    // ── http utils (from database.mjs, pending move to helpers) ─
    parseJsonBody:            null,
    sendJson:                 null,
    // ── db-adapter (low-level SQL) ─────────────────────────────
    query:                    null,
    queryOne:                 null,
    run:                      null,
    exec:                     null,
    // ── knowledge-db ───────────────────────────────────────────
    initKnowledgeDb:          null,
    getKnowledgeDocs:         null,
    getKnowledgeDocById:      null,
    createKnowledgeDoc:       null,
    updateKnowledgeDoc:       null,
    deleteKnowledgeDoc:       null,
    searchKnowledgeDocs:      null,
    getKnowledgeCategories:   null,
    searchKnowledgeFTS:       null,
    searchKnowledgeVector:    null,
    searchKnowledgeHybrid:    null,
    embedDocumentAsync:       null,
    deleteDocumentEmbeddings: null,
    createKnowledgeReference: null,
    getMessageReferences:     null,
    getKnowledgeDocsByIds:    null,
    rebuildKnowledgeFTS:      null,
    // ── knowledge-db: workflows ────────────────────────────────
    getWorkflows:             null,
    getWorkflowById:          null,
    createWorkflow:           null,
    updateWorkflow:           null,
    deleteWorkflow:           null,
    incrementWorkflowRunCount: null,
    getCronEnabledWorkflows:  null,
    updateWorkflowNextRun:    null,
    // ── workflow runs + audit (Iter-11) ────────────────────────
    createWorkflowRun:        null,
    updateWorkflowRun:        null,
    getWorkflowRuns:          null,
    getWorkflowRunById:       null,
    createAuditLog:           null,
    getAuditLogs:             null,
    ...overrides.db,
  };

  // ─── Layer 4: runtime（运行时可变状态）─────────────────────
  const runtime = {
    sessions:             new Map(),
    wsClients:            new Map(),
    activeTasksBySession: new Map(),
    toolMetadataByMsgId:  new Map(),
    eventBuffer:          null,  // → EventBuffer instance
    workerManager:        null,  // → WorkerManager instance
    wss:                  null,  // → WebSocketServer instance
    server:               null,  // → http.Server instance
    ...overrides.runtime,
  };

  return { config, services, db, runtime };
}

/**
 * Inject database functions into ctx.db from the database module.
 * Call after initDatabase() succeeds.
 * 
 * @param {object} ctx - Application context
 * @param {object} dbModule - The imported database.mjs module
 */
export function injectDb(ctx, dbModule) {
  // ── lifecycle ─────────────────────────────────────────────
  ctx.db.initDatabase             = dbModule.initDatabase;
  ctx.db.closeDatabase            = dbModule.closeDatabase;
  // ── chat / session ───────────────────────────────────────
  ctx.db.getChats                 = dbModule.getChats;
  ctx.db.getChatBySessionKey      = dbModule.getChatBySessionKey;
  ctx.db.getChatById              = dbModule.getChatById;
  ctx.db.createChat               = dbModule.createChat;
  ctx.db.updateChatTitle          = dbModule.updateChatTitle;
  ctx.db.deleteChat               = dbModule.deleteChat;
  ctx.db.deleteChats              = dbModule.deleteChats;
  ctx.db.searchChats              = dbModule.searchChats;
  ctx.db.getAllTags                = dbModule.getAllTags;
  ctx.db.updateChatTags           = dbModule.updateChatTags;
  ctx.db.getChatsByTag            = dbModule.getChatsByTag;
  // ── messages ─────────────────────────────────────────────
  ctx.db.getMessages              = dbModule.getMessages;
  ctx.db.createMessage            = dbModule.createMessage;
  ctx.db.getConversationHistory   = dbModule.getConversationHistory;
  ctx.db.getMessageCount          = dbModule.getMessageCount;
  ctx.db.getMessageById           = dbModule.getMessageById;
  ctx.db.deleteMessagesFrom       = dbModule.deleteMessagesFrom;
  ctx.db.getLastUserMessageBefore = dbModule.getLastUserMessageBefore;
  // ── auth / users ─────────────────────────────────────────
  ctx.db.authenticateUser         = dbModule.authenticateUser;
  ctx.db.generateToken            = dbModule.generateToken;
  ctx.db.verifyToken              = dbModule.verifyToken;
  ctx.db.extractUserFromRequest   = dbModule.extractUserFromRequest;
  ctx.db.registerUser             = dbModule.registerUser;
  ctx.db.getUserById              = dbModule.getUserById;
  ctx.db.getAllUsers               = dbModule.getAllUsers;
  ctx.db.getRoleById              = dbModule.getRoleById;
  // ── invite codes ─────────────────────────────────────────
  ctx.db.getInviteCodes           = dbModule.getInviteCodes;
  ctx.db.createInviteCode         = dbModule.createInviteCode;
  ctx.db.deactivateInviteCode     = dbModule.deactivateInviteCode;
  // ── sharing ──────────────────────────────────────────────
  ctx.db.shareChat                = dbModule.shareChat;
  ctx.db.unshareChat              = dbModule.unshareChat;
  ctx.db.getSharedWithMe          = dbModule.getSharedWithMe;
  ctx.db.getChatShares            = dbModule.getChatShares;
  ctx.db.hasShareAccess           = dbModule.hasShareAccess;
  // ── quick prompts ────────────────────────────────────────
  ctx.db.getQuickPrompts          = dbModule.getQuickPrompts;
  ctx.db.incrementPromptUsage     = dbModule.incrementPromptUsage;
  ctx.db.createPrompt             = dbModule.createPrompt;
  ctx.db.updatePrompt             = dbModule.updatePrompt;
  ctx.db.deletePrompt             = dbModule.deletePrompt;
  ctx.db.getAllPrompts             = dbModule.getAllPrompts;
  // ── system config ────────────────────────────────────────
  ctx.db.getSystemConfigs         = dbModule.getSystemConfigs;
  ctx.db.getSystemConfig          = dbModule.getSystemConfig;
  ctx.db.updateSystemConfig       = dbModule.updateSystemConfig;
  ctx.db.getSystemStatus          = dbModule.getSystemStatus;
  // ── audit ────────────────────────────────────────────────
  ctx.db.getAuditLogs             = dbModule.getAuditLogs;
  ctx.db.insertAuditLog           = dbModule.insertAuditLog;
  // ── ai roles ─────────────────────────────────────────────
  ctx.db.getAiRoles               = dbModule.getAiRoles;
  ctx.db.getAiRole                = dbModule.getAiRole;
  ctx.db.createAiRole             = dbModule.createAiRole;
  ctx.db.updateAiRole             = dbModule.updateAiRole;
  ctx.db.deleteAiRole             = dbModule.deleteAiRole;
  // ── stats ────────────────────────────────────────────────
  ctx.db.getStats                 = dbModule.getStats;
  // ── http utils (from database.mjs, pending move to helpers) ─
  ctx.db.parseJsonBody            = dbModule.parseJsonBody;
  ctx.db.sendJson                 = dbModule.sendJson;
}

/**
 * Inject knowledge-db functions into ctx.db.
 * Call after injectDb() and after knowledge-db.mjs is imported.
 * 
 * @param {object} ctx - Application context
 * @param {object} knowledgeDbModule - The imported knowledge-db.mjs module
 */
export function injectKnowledgeDb(ctx, knowledgeDbModule) {
  // ── knowledge docs ─────────────────────────────────────────
  ctx.db.initKnowledgeDb          = knowledgeDbModule.initKnowledgeDb;
  ctx.db.getKnowledgeDocs         = knowledgeDbModule.getKnowledgeDocs;
  ctx.db.countKnowledgeDocs       = knowledgeDbModule.countKnowledgeDocs;
  ctx.db.getKnowledgeDocById      = knowledgeDbModule.getKnowledgeDocById;
  ctx.db.createKnowledgeDoc       = knowledgeDbModule.createKnowledgeDoc;
  ctx.db.updateKnowledgeDoc       = knowledgeDbModule.updateKnowledgeDoc;
  ctx.db.deleteKnowledgeDoc       = knowledgeDbModule.deleteKnowledgeDoc;
  ctx.db.searchKnowledgeDocs      = knowledgeDbModule.searchKnowledgeDocs;
  ctx.db.getKnowledgeCategories   = knowledgeDbModule.getKnowledgeCategories;
  ctx.db.searchKnowledgeFTS       = knowledgeDbModule.searchKnowledgeFTS;
  ctx.db.searchKnowledgeVector   = knowledgeDbModule.searchKnowledgeVector;
  ctx.db.searchKnowledgeHybrid   = knowledgeDbModule.searchKnowledgeHybrid;
  ctx.db.embedDocumentAsync      = knowledgeDbModule.embedDocumentAsync;
  ctx.db.deleteDocumentEmbeddings = knowledgeDbModule.deleteDocumentEmbeddings;
  ctx.db.createKnowledgeReference = knowledgeDbModule.createKnowledgeReference;
  ctx.db.getMessageReferences     = knowledgeDbModule.getMessageReferences;
  ctx.db.getKnowledgeDocsByIds    = knowledgeDbModule.getKnowledgeDocsByIds;
  ctx.db.rebuildKnowledgeFTS      = knowledgeDbModule.rebuildKnowledgeFTS;
  // ── workflows ──────────────────────────────────────────────
  ctx.db.getWorkflows             = knowledgeDbModule.getWorkflows;
  ctx.db.getWorkflowById          = knowledgeDbModule.getWorkflowById;
  ctx.db.createWorkflow           = knowledgeDbModule.createWorkflow;
  ctx.db.updateWorkflow           = knowledgeDbModule.updateWorkflow;
  ctx.db.deleteWorkflow           = knowledgeDbModule.deleteWorkflow;
  ctx.db.incrementWorkflowRunCount = knowledgeDbModule.incrementWorkflowRunCount;
  ctx.db.getCronEnabledWorkflows  = knowledgeDbModule.getCronEnabledWorkflows;
  ctx.db.updateWorkflowNextRun    = knowledgeDbModule.updateWorkflowNextRun;
  // ── workflow runs + audit (Iter-11) ──────────────────────────
  ctx.db.createWorkflowRun        = knowledgeDbModule.createWorkflowRun;
  ctx.db.updateWorkflowRun        = knowledgeDbModule.updateWorkflowRun;
  ctx.db.getWorkflowRuns          = knowledgeDbModule.getWorkflowRuns;
  ctx.db.getWorkflowRunById       = knowledgeDbModule.getWorkflowRunById;
  ctx.db.createAuditLog           = knowledgeDbModule.createAuditLog;
  ctx.db.getAuditLogs             = knowledgeDbModule.getAuditLogs;
}

/**
 * Inject db-adapter (low-level SQL) functions into ctx.db.
 * Call after db-adapter.mjs initAdapter() succeeds.
 * 
 * @param {object} ctx - Application context
 * @param {object} adapterModule - The imported db-adapter.mjs module
 */
export function injectDbAdapter(ctx, adapterModule) {
  ctx.db.query    = adapterModule.query;
  ctx.db.queryOne = adapterModule.queryOne;
  ctx.db.run      = adapterModule.run;
  ctx.db.exec     = adapterModule.exec;
}

/**
 * Create a callGateway function bound to the OpenClaw gateway token.
 * Reads token from config file and returns a pre-bound function.
 * 
 * @param {object} ctx - Application context
 * @returns {Function} callGateway(messages, maxTokens?, temperature?) => Promise<string>
 */
export function createCallGateway(ctx) {
  let _token = null;
  
  async function getToken() {
    if (_token) return _token;
    try {
      const fs = await import('fs');
      const config = JSON.parse(
        fs.default.readFileSync(ctx.config.OPENCLAW_CONFIG_PATH, 'utf-8')
      );
      _token = config?.gateway?.auth?.token || '';
    } catch { _token = ''; }
    return _token;
  }
  
  return async function callGateway(messages, maxTokens = 200, temperature = 0.3) {
    const token = await getToken();
    const resp = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-5-mini',
        messages,
        max_tokens: maxTokens,
        temperature
      })
    });
    const result = await resp.json();
    return result?.choices?.[0]?.message?.content || '';
  };
}

/**
 * Build the deps object for ticketKolApi.init() from ctx layers.
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildTicketKolApiDeps(ctx) {
  return {
    db: ctx.db,
    callGateway: createCallGateway(ctx),
    runtime: ctx.runtime,
  };
}
/**
 * Build the deps object for workflowApi.init() from ctx layers.
 * Workflow API only needs db operations (same as knowledge API).
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildWorkflowApiDeps(ctx) {
  return {
    db: ctx.db,
  };
}
/**
 * Build the deps object for userManagementApi.init() from ctx layers.
 * User management API needs db operations + getUserByUsername.
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildUserManagementApiDeps(ctx) {
  return {
    db: ctx.db,
  };
}
/**
 * Build the deps object for workflowScheduler.init() from ctx layers.
 * Scheduler needs getCronEnabledWorkflows, incrementWorkflowRunCount, updateWorkflowNextRun.
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildSchedulerDeps(ctx) {
  return {
    db: {
      getCronEnabledWorkflows:   ctx.db.getCronEnabledWorkflows,
      incrementWorkflowRunCount: ctx.db.incrementWorkflowRunCount,
      updateWorkflowNextRun:     ctx.db.updateWorkflowNextRun,
      // v3: 结构化执行引擎需要的额外方法
      createWorkflowRun:         ctx.db.createWorkflowRun,
      getWorkflowRunById:        ctx.db.getWorkflowRunById,
      run:                       ctx.db.run,  // SQLite run for UPDATE workflow_runs
    },
  };
}




/**
 * Inject a service into ctx.services.
 * 
 * @param {object} ctx - Application context
 * @param {string} name - Service name (e.g., 'auth', 'redisPool')
 * @param {object} service - The service instance
 */
export function injectService(ctx, name, service) {
  if (!(name in ctx.services)) {
    logger.warn(`[context] Warning: injecting unknown service '${name}'`);
  }
  ctx.services[name] = service;
}

/**
 * Build the deps object for wsHandler.init() from ctx layers.
 * This is the adapter that bridges ctx → existing init(deps) interface.
 * 
 * @param {object} ctx - Application context
 * @param {object} extras - Additional pure-function dependencies (sendEvent, etc.)
 * @returns {object} deps - The flat deps object expected by wsHandler.init()
 */
export function buildWsHandlerDeps(ctx, extras = {}) {
  return {
    // services layer
    workerManager:  ctx.runtime.workerManager,
    eventBuffer:    ctx.runtime.eventBuffer,
    taskStore:      ctx.services.taskStore,
    auth:           ctx.services.auth,
    rateLimiter:    ctx.services.rateLimiter,
    monitor:        ctx.services.monitor,
    redisPool:      ctx.services.redisPool,
    // runtime layer
    sessions:             ctx.runtime.sessions,
    wsClients:            ctx.runtime.wsClients,
    activeTasksBySession: ctx.runtime.activeTasksBySession,
    toolMetadataByMsgId:  ctx.runtime.toolMetadataByMsgId,
    // db layer
    getChatBySessionKey:    ctx.db.getChatBySessionKey,
    getChatById:            ctx.db.getChatById,
    createChat:             ctx.db.createChat,
    createMessage:          ctx.db.createMessage,
    updateChatTitle:        ctx.db.updateChatTitle,
    getConversationHistory: ctx.db.getConversationHistory,
    verifyToken:            ctx.db.verifyToken,
    // config layer
    DEFAULT_SESSION_KEY: ctx.config.DEFAULT_SESSION_KEY,
    HISTORY_LIMIT:       ctx.config.HISTORY_LIMIT,
    MAX_TASK_DURATION:   ctx.config.MAX_TASK_DURATION,
    // pure-function extras (directly imported, not injected)
    ...extras,
  };
}

/**
 * Build the deps object for initWorkerManager() from ctx layers.
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildWorkerManagerDeps(ctx) {
  return {
    // paths & keys
    workerPath:          ctx.config.WORKER_PATH,
    defaultSessionKey:   ctx.config.DEFAULT_SESSION_KEY,
    // runtime
    sessions:            ctx.runtime.sessions,
    eventBuffer:         ctx.runtime.eventBuffer,
    activeTasksBySession: ctx.runtime.activeTasksBySession,
    toolMetadataByMsgId: ctx.runtime.toolMetadataByMsgId,
    wss:                 ctx.runtime.wss,
    // P1-1: Add wsClients for precise WS routing in frontend_event
    wsClients:           ctx.runtime.wsClients,
    // services
    taskStore:           ctx.services.taskStore,
    db:                  ctx.services.db,
    // config timeouts — passed explicitly so worker-manager uses ctx.config values
    SOFT_TIMEOUT_MS:     ctx.config.SOFT_TIMEOUT_MS,
    IDLE_TIMEOUT_MS:     ctx.config.IDLE_TIMEOUT_MS,
    MAX_TASK_DURATION:   ctx.config.MAX_TASK_DURATION,
    WORKER_PING_INTERVAL: ctx.config.WORKER_PING_INTERVAL,
    WORKER_PING_TIMEOUT:  ctx.config.WORKER_PING_TIMEOUT,
    RESTART_WINDOW:      ctx.config.RESTART_WINDOW,
    MAX_RESTART_COUNT:   ctx.config.MAX_RESTART_COUNT,
  };
}

/**
 * Build deps for ChatOrchestrator (business logic layer).
 * Contains all runtime deps needed for message processing pipeline.
 * Iter-55: Extracted from buildChatApiDeps.
 * 
 * @param {object} ctx - Application context
 * @param {object} extras - Pure-function dependencies (sendEvent, etc.)
 * @returns {object} deps for ChatOrchestrator constructor
 */
export function buildChatOrchestratorDeps(ctx, extras = {}) {
  return {
    db:                    ctx.db,
    workerManager:         ctx.runtime.workerManager,
    eventBuffer:           ctx.runtime.eventBuffer,
    taskStore:             ctx.services.taskStore,
    rateLimiter:           ctx.services.rateLimiter,
    activeTasksBySession:  ctx.runtime.activeTasksBySession,
    wsClients:             ctx.runtime.wsClients,
    toolMetadataByMsgId:   ctx.runtime.toolMetadataByMsgId,
    sendEvent:             extras.sendEvent,
    expandFileAttachments: extras.expandFileAttachments,
    generateTitle:         extras.generateTitle,
    generateSuggestions:   extras.generateSuggestions,
    inlineFallback:        extras.inlineFallback,
  };
}

/**
 * Build deps for chat-api.mjs (thin routing layer).
 * v3.0: Now only needs db + orchestrator + runtime maps.
 * Iter-55: Slimmed down — business logic moved to ChatOrchestrator.
 * 
 * @param {object} ctx - Application context
 * @param {import('../services/chat-service.mjs').ChatOrchestrator} orchestrator
 * @returns {object} deps for chat-api.init()
 */
export function buildChatApiDeps(ctx, orchestrator) {
  return {
    db:                    ctx.db,
    orchestrator:          orchestrator,
    wsClients:             ctx.runtime.wsClients,
    activeTasksBySession:  ctx.runtime.activeTasksBySession,
    eventBuffer:           ctx.runtime.eventBuffer,
    taskStore:             ctx.services.taskStore,
  };
}

/**
 * Build the deps object for knowledgeApi.init() from ctx layers.
 * Knowledge API only needs db operations.
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildKnowledgeApiDeps(ctx) {
  return {
    db: ctx.db,
  };
}

/**
 * Build the deps object for authApi.init() from ctx layers.
 * Auth API only needs db operations.
 * Iter-52: Extracted from buildChatApiDeps.
 *
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildAuthApiDeps(ctx) {
  return {
    db: ctx.db,
  };
}

/**
 * Build the deps object for systemApi.init() from ctx layers.
 * System API only needs db operations.
 * Iter-52: Extracted from buildChatApiDeps.
 *
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildSystemApiDeps(ctx) {
  return {
    db: ctx.db,
  };
}

// ─────────────────────────────────────────────────────────────
// ─── DI Validation Utility ──────────────────────────────────
// ─────────────────────────────────────────────────────────────

/**
 * Validate that all required dependency fields are present and non-null.
 *
 * Call this at the top of each module's init(deps) to get a clear,
 * actionable error instead of a cryptic "cannot read property of undefined"
 * at runtime.
 *
 * @param {string[]} required - Array of required field names
 * @param {object}   actual   - The deps object passed to init()
 * @param {string}   [moduleName='module'] - Module name for error messages
 * @throws {Error} If any required field is missing or null/undefined
 *
 * @example
 * export function init(deps) {
 *   validateDeps(['auth', 'sessions', 'sendEvent'], deps, 'ws-handler');
 *   _deps = deps;
 * }
 */
export function validateDeps(required, actual, moduleName = 'module') {
  if (!actual || typeof actual !== 'object') {
    throw new Error(`[${moduleName}] init() called with invalid deps (${typeof actual}). Expected an object.`);
  }
  const missing = required.filter(key => actual[key] == null);
  if (missing.length > 0) {
    throw new Error(
      `[${moduleName}] init() missing required deps: ${missing.join(', ')}.\n` +
      `  Received keys: [${Object.keys(actual).join(', ')}]`
    );
  }
}

/**
 * Build the deps object for reportApi.init() from ctx layers.
 * 
 * @param {object} ctx - Application context
 * @returns {object} deps
 */
export function buildReportApiDeps(ctx) {
  return {
    db: ctx.db,
  };
}
