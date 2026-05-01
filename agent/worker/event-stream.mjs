/**
 * event-stream.mjs — Unified Event Stream Layer (v2.0 — Agent Loop Architecture)
 * 
 * UPGRADED: Now serves as the SINGLE SOURCE OF TRUTH for task state.
 * 
 * New capabilities:
 *   - rebuildTaskStateFromEvents(taskId) — full state reconstruction from events
 *   - getEvents() with flexible filtering (replaces scattered query functions)
 *   - New event types: action, observation, waiting_user, resume, replan, notify, ask
 *   - Structured action/observation protocol
 * 
 * Retained:
 *   - SQLite persistence with WAL mode
 *   - Buffered writes with periodic flush
 *   - Event summarization for context injection
 *   - Cleanup/retention policy
 * 
 * @module worker/event-stream
 */
import { logger } from '../lib/logger.mjs';
import { validatePayload } from './event-schema.mjs';

const ts = () => new Date().toISOString();

// [R4] Module instance ID for debugging multi-instance issues
export const MODULE_INSTANCE_ID = `es-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;

// ─── Event Type Enum (v2.0 — expanded) ───
export const EVENT_TYPES = {
  // === Core Agent Loop Events ===
  USER_MESSAGE: 'user_message',
  PLAN_UPDATE: 'plan_update',           // Planner produced/updated a plan
  ACTION: 'action',                      // Executor decided on an action
  OBSERVATION: 'observation',            // Result of an action (tool result, LLM response, etc.)
  TASK_STATE_UPDATE: 'task_state_update',
  FINAL_ANSWER: 'final_answer',          // Task completed with final output

  // === Runtime Ledger Events (Iter-60 P0 Agent Runtime hardening) ===
  PLAN_CREATED: 'plan_created',
  STEP_STARTED: 'step_started',
  ACTION_STARTED: 'action_started',
  ACTION_COMPLETED: 'action_completed',
  OBSERVATION_RECORDED: 'observation_recorded',
  STEP_COMPLETED: 'step_completed',
  TASK_FAILED: 'task_failed',

  // === Communication Events ===
  NOTIFY: 'notify',                      // Non-blocking progress update to user
  ASK: 'ask',                            // Blocking question — needs user response
  WAITING_USER: 'waiting_user',          // Task paused, waiting for user input
  RESUME: 'resume',                      // Task resumed after user input

  // === Tool Events (detailed) ===
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',

  // === Model & Routing ===
  MODEL_ROUTE: 'model_route',
  REPLAN: 'replan',
  PLAN_STEP_UPDATE: 'plan_step_update',                      // Plan revision triggered

  // === Parallel Sub-Agent Events (P0-2 P1-2) ===
  PARALLEL_WAVE_DETECTED: 'parallel_wave_detected',
  PARALLEL_WAVE_COMPLETED: 'parallel_wave_completed',

  // === Context & Memory ===
  ASSISTANT_MESSAGE: 'assistant_message',
  MEMORY_WRITE: 'memory_write',
  MEMORY_RECALL: 'memory_recall',
  CONTEXT_COMPRESS: 'context_compress',
  SESSION_REBUILD: 'session_rebuild',
  KNOWLEDGE_INJECT: 'knowledge_inject',  // Knowledge provider injection
  KNOWLEDGE_GATHERED: 'knowledge_gathered',
  DATASOURCE_GATHERED: 'datasource_gathered',

  // === System ===
  ERROR: 'error',
  HUMAN_BLOCKED: 'human_blocked',        // Legacy compat
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  ANSWER_QUALITY_SCORED: 'answer_quality_scored',
  ANSWER_QUALITY_SKIPPED: 'answer_quality_skipped',   // [R45-T3] Skipped due to sampling
  MEDIA_ANALYZED: 'media_analyzed',
  PROVIDER_FALLBACK: 'provider_fallback',       // [R45-T2] Circuit Breaker fallback event
  // [R43-T2] New event types for observability
  PLAN_COMPLETED: 'plan_completed',
  TOOL_TIMEOUT: 'tool_timeout',
  // [R71-P0] Evidence & validation events
  STEP_EVIDENCE_RECORDED: 'step_evidence_recorded',
  STEP_NEEDS_VERIFICATION: 'step_needs_verification',
  NO_PLAN_ACTION: 'no_plan_action',

  // [R74-P0-3] Worker lifecycle events (Supervisor/Worker isolation)
  WORKER_STARTED: 'worker_started',
  WORKER_COMPLETED: 'worker_completed',
  WORKER_FAILED: 'worker_failed',
  WORKER_RETRIED: 'worker_retried',
};

// ─── Action Types (for ACTION events) ───
export const ACTION_TYPES = {
  TOOL_CALL: 'tool_call',
  NOTIFY: 'notify',
  ASK: 'ask',
  FINAL_ANSWER: 'final_answer',
  REPLAN: 'replan',
};

// ─── SQLite Direct Access ───
let _db = null;

async function getDb() {
  if (_db) return _db;
  try {
    const { default: Database } = await import('better-sqlite3');
    _db = new Database('/opt/rangerai-agent/db/rangerai.db');
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');

    // Ensure table exists with v2 schema
    _db.exec(`
      CREATE TABLE IF NOT EXISTS event_stream (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        model TEXT,
        tool_name TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_es_session ON event_stream(session_key);
      CREATE INDEX IF NOT EXISTS idx_es_task ON event_stream(task_id);
      CREATE INDEX IF NOT EXISTS idx_es_type ON event_stream(event_type);
      CREATE INDEX IF NOT EXISTS idx_es_created ON event_stream(created_at);
    `);
    logger.info(`[${ts()}] [event-stream] Database initialized (v2.0)`);
    return _db;
  } catch (err) {
    logger.error(`[${ts()}] [event-stream] Database init failed: ${err.message}`);
    return null;
  }
}

// ─── In-memory buffer ───
const _eventBuffer = [];
const _recentEvents = [];
const RECENT_EVENTS_MAX_SIZE = 100;
const BUFFER_FLUSH_INTERVAL = 5000;
const BUFFER_MAX_SIZE = 50;
let _flushTimer = null;
let _flushing = false;  // [R3] Guard against recursive flush

function startFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(async () => {
    if (_eventBuffer.length > 0) await flushBuffer();
  }, BUFFER_FLUSH_INTERVAL);
  if (_flushTimer.unref) _flushTimer.unref();
}

export function cleanupEventStream() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

export async function flushBuffer() {
  if (_eventBuffer.length === 0) return;
  _flushing = true;
  const batch = _eventBuffer.splice(0);
  const db = await getDb();
  if (!db) {
    logger.warn(`[${ts()}] [event-stream] DB unavailable, dropping ${batch.length} events`);
    _flushing = false;
    return;
  }
  let stmt;
  try {
    stmt = db.prepare(`
      INSERT INTO event_stream (session_key, task_id, event_type, payload, model, tool_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  } catch (prepErr) {
    logger.error('[event-stream] prepare FAILED: ' + prepErr.message);
    _eventBuffer.unshift(...batch);
    _flushing = false;
    return;
  }
  // [R32] Individual inserts instead of transaction to prevent one bad event from blocking all
  let insertedCount = 0;
  let skippedCount = 0;
  try {
    if (batch.length > 0) {
      const first = batch[0];
      logger.info('[R32-DEBUG] First event keys: ' + Object.keys(first).join(',') + ' type=' + first.event_type + ' sk=' + first.session_key);
      logger.info('[R32-DEBUG] First event JSON: ' + JSON.stringify(first).substring(0, 500));
    }
    for (const e of batch) {
      try {
        const vals = [
          e.session_key || "unknown",
          e.task_id || null,
          e.event_type || "unknown",
          typeof e.payload === 'object' ? JSON.stringify(e.payload) : (e.payload || "{}"),
          e.model || null,
          e.tool_name || null,
          e.created_at || new Date().toISOString()
        ];
        stmt.run(...vals);
        insertedCount++;
      } catch (rowErr) {
        skippedCount++;
        logger.warn('[event-stream] Skip event: type=' + (e.event_type || 'unknown') + ' err=' + rowErr.message + ' vals_count=' + 7);
      }
    }
    logger.info(`[${ts()}] [event-stream] Flushed ${insertedCount}/${batch.length} events (skipped: ${skippedCount})`);
    // [R11-T2] REMOVED: R3-Task3 auto-mark plan steps from observation events
    // This was a duplicate of openclaw-handler's step-advance logic (R6),
    // causing double markStepDone calls and contributing to the step-4 infinite loop.
    // Step completion is now exclusively handled by openclaw-handler.
    // [R3-Task2] Check if batch contains a final_answer event and trigger replay verification
    try {
      const finalEvent = batch.find(e => e.event_type === EVENT_TYPES.FINAL_ANSWER || e.event_type === EVENT_TYPES.TASK_COMPLETED);
      if (finalEvent) {
        const fTaskId = finalEvent.task_id;
        const fSessionKey = finalEvent.session_key;
        if (fTaskId) {
          // Run verification asynchronously (non-blocking)
          setImmediate(async () => {
            try {
              await verifyReplayConsistency(fTaskId, fSessionKey);
            } catch (verifyErr) {
              logger.warn(`[${ts()}] [event-stream] REPLAY verification failed (non-fatal): ${verifyErr.message}`);
            }
          });
        }
      }
    } catch (_) { /* Never block flush */ }
  } catch (err) {
    logger.error(`[${ts()}] [event-stream] Flush failed: ${err.message}`);
    _eventBuffer.unshift(...batch);
  } finally {
    _flushing = false;
  }
}

// ─── Public API: Emit ───

/**
 * Emit an event to the stream (buffered).
 */
// R7 Task 4: Per-task monotonic event sequence counter
const _seqCounters = new Map(); // taskId => number
function _nextSeq(taskId) {
  const cur = _seqCounters.get(taskId) || 0;
  const next = cur + 1;
  _seqCounters.set(taskId, next);
  return next;
}
/** R7 Task 5: Cleanup seq counter for a task */
export function cleanupTaskSeq(taskId) {
  _seqCounters.delete(taskId);
}


function _normalizeLedgerValue(value) {
  return value === undefined ? null : value;
}

function _deriveActionId(taskId, stepId, seq) {
  const base = taskId || 'task';
  const step = stepId || 'stepless';
  return `${base}:${step}:a${seq || Date.now()}`;
}

/**
 * Emit a runtime ledger event with compatible task/run/plan/step/action identifiers.
 * This is additive: existing event types and payload shapes remain supported.
 */
export function emitLedgerEvent(sessionKey, taskId, eventType, payload = {}, model = null, toolName = null) {
  const normalizedPayload = typeof payload === 'string' ? { content: payload } : { ...payload };
  const ledgerTaskId = normalizedPayload.taskId || taskId || normalizedPayload.msgId || null;
  const stepId = normalizedPayload.stepId || normalizedPayload.currentStepId || null;
  const runId = normalizedPayload.runId || ledgerTaskId || normalizedPayload.msgId || null;
  const planId = normalizedPayload.planId || (normalizedPayload.plan && (normalizedPayload.plan.planId || normalizedPayload.plan.id)) || null;
  const actionId = normalizedPayload.actionId || (
    eventType === EVENT_TYPES.ACTION_STARTED || eventType === EVENT_TYPES.ACTION_COMPLETED || eventType === EVENT_TYPES.ACTION
      ? _deriveActionId(ledgerTaskId, stepId, normalizedPayload._seq)
      : null
  );
  const enriched = {
    ...normalizedPayload,
    taskId: _normalizeLedgerValue(ledgerTaskId),
    runId: _normalizeLedgerValue(runId),
    planId: _normalizeLedgerValue(planId),
    stepId: _normalizeLedgerValue(stepId),
    actionId: _normalizeLedgerValue(actionId),
  };
  emitEvent(sessionKey, ledgerTaskId, eventType, enriched, model, toolName);
}

export function emitEvent(sessionKey, taskId, eventType, payload = {}, model = null, toolName = null) {
  const validation = validatePayload(eventType, payload);
  if (!validation?.ok) {
    logger.warn(`[${ts()}] [event-stream] Invalid payload for ${eventType}: ${validation?.reason || 'validation_failed'}`);
    return false;
  }
  // R7 Task 4: Attach monotonic seq to payload
  const seq = taskId ? _nextSeq(taskId) : 0;
  const enrichedPayload = typeof payload === 'string' ? payload : { ...payload, _seq: seq };
  const event = {
    session_key: sessionKey,
    task_id: taskId || null,
    event_type: eventType,
    payload: typeof enrichedPayload === 'string' ? enrichedPayload : JSON.stringify(enrichedPayload),
    model: model || null,
    tool_name: toolName || null,
    created_at: ts(),
  };
  _eventBuffer.push(event);
  _recentEvents.push(event);
  if (_recentEvents.length > RECENT_EVENTS_MAX_SIZE) _recentEvents.splice(0, _recentEvents.length - RECENT_EVENTS_MAX_SIZE);
  startFlushTimer();
  if (_eventBuffer.length >= BUFFER_MAX_SIZE) {
    flushBuffer().catch(() => {});
  }
  return true;
}

/**
 * Emit an event immediately (synchronous write, for critical events).
 * [R11-T1] Changed: now routes through the same buffer as emitEvent to prevent
 * seq ordering issues. The old direct-write path caused DB INSERT id order to
 * diverge from _seq order when buffered events hadn't flushed yet.
 * For truly critical events, we flush the buffer immediately after pushing.
 */
export async function emitEventSync(sessionKey, taskId, eventType, payload = {}, model = null, toolName = null) {
  // [R11-T1] Route through buffer + immediate flush (preserves seq monotonicity)
  emitEvent(sessionKey, taskId, eventType, payload, model, toolName);
  // Flush immediately to maintain the "sync" semantics (data hits DB quickly)
  try {
    await flushBuffer();
  } catch (flushErr) {
    logger.warn(`[${ts()}] [R11-T1] emitEventSync flush failed (non-fatal, will retry on next timer): ${flushErr.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// ─── Knowledge Event Emission (Iter-64) ───
// ═══════════════════════════════════════════════════════════

/**
 * Emit a Knowledge module event to the event stream with a standardized
 * schema suitable for observability, replay, and diagnostics.
 *
 * Schema fields (all nullable for forward compatibility):
 *   - module          — always "knowledge"
 *   - instanceId      — the KnowledgeModule.instanceId that produced this event
 *   - scope           — logical scope name (e.g. "knowledge_gather", "knowledge_inject")
 *   - searchTerms     — user message or search key that triggered the gather
 *   - segments        — array of gathered knowledge segments, each with { source, title, score, chars, scope }
 *   - reason          — human-readable reason/trigger for this gather
 *   - ts              — ISO timestamp of emission
 *   - traceId         — correlation id spanning multiple events for the same gather
 *   - totalChars       — total characters injected
 *   - budgetTotal      — configured budget
 *   - budgetUsed       — actual budget consumed
 *   - latencyMs        — gather latency in milliseconds
 *   - activeSources    — list of source names that contributed
 *   - errors           — array of source-level errors encountered
 *
 * Idempotency: uses traceId as the natural dedup key; replay consumers
 * should be prepared to see duplicate traceIds for the same gather.
 *
 * @param {string} sessionKey - Gateway session identifier
 * @param {string|null} taskId - Current task id (nullable)
 * @param {string} eventType  - One of EVENT_TYPES.KNOWLEDGE_* constants
 * @param {Object} payload    - Raw knowledge bundle (from KnowledgeModule.gather)
 * @param {string|null} [model=null] - Model context if applicable
 */
export function emitKnowledgeEvent(sessionKey, taskId, eventType, payload = {}, model = null) {
  const enriched = {
    module: 'knowledge',
    instanceId: payload.instanceId || MODULE_INSTANCE_ID,
    scope: payload.scope || 'knowledge_gather',
    searchTerms: payload.searchTerms || null,
    segments: payload.segments || [],
    reason: payload.reason || 'knowledge_gather',
    ts: payload.ts || ts(),
    traceId: payload.traceId || null,
    totalChars: payload.totalChars ?? null,
    budgetTotal: payload.budgetTotal ?? null,
    budgetUsed: payload.budgetUsed ?? null,
    latencyMs: payload.latencyMs ?? null,
    activeSources: payload.activeSources || [],
    errors: payload.errors || [],
    // preserve original fields for backward compat
    _userMessage: payload.userMessage || null,
    _sessionKey: sessionKey || null,
  };
  emitEvent(sessionKey, taskId, eventType, enriched, model, null);
}

// ─── Public API: Query (v2.0 unified) ───

/**
 * Unified event query with flexible filtering.
 * Replaces getRecentEvents, getEventsByType, getEventsSince, getTaskEvents.
 *
 * @param {string} sessionKey
 * @param {Object} options
 * @param {string} [options.taskId]       - Filter by task ID
 * @param {string[]} [options.eventTypes] - Filter by event types
 * @param {number} [options.sinceId]      - Get events after this ID
 * @param {number} [options.limit=50]     - Max events to return
 * @param {string} [options.order='asc']  - 'asc' or 'desc'
 * @returns {Promise<Array>} Events
 */
export async function getEvents(sessionKey, options = {}) {
  await flushBuffer();
  const db = await getDb();
  if (!db) return [];

  const { taskId, eventTypes, sinceId, limit = 50, order = 'asc' } = options;

  let sql = 'SELECT * FROM event_stream WHERE session_key = ?';
  const params = [sessionKey];

  if (taskId) {
    sql += ' AND task_id = ?';
    params.push(taskId);
  }
  if (eventTypes && eventTypes.length > 0) {
    sql += ` AND event_type IN (${eventTypes.map(() => '?').join(',')})`;
    params.push(...eventTypes);
  }
  if (sinceId) {
    sql += ' AND id > ?';
    params.push(sinceId);
  }

  sql += ` ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
  params.push(limit);

  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    logger.error(`[${ts()}] [event-stream] getEvents failed: ${err.message}`);
    return [];
  }
}

// ─── Backward-compatible aliases ───
export async function getRecentEvents(sessionKey, limit = 20) {
  if (!sessionKey) return [];
  const recent = _recentEvents.filter(e => e.session_key === sessionKey).slice(-limit);
  if (recent.length >= limit) return recent;
  // Fall through to DB for supplementation
  const dbEvents = await getEvents(sessionKey, { limit, order: 'desc' }).then(events => events.reverse());
  // [Iter-65] If DB is unavailable (corrupt / empty) but we have in-memory events,
  // return those instead of losing data. This handles the corrupt DB edge case.
  if (dbEvents.length === 0 && recent.length > 0) return recent;
  return dbEvents;
}

export async function getEventsByType(sessionKey, eventType, limit = 10) {
  return getEvents(sessionKey, { eventTypes: [eventType], limit, order: 'desc' }).then(events => events.reverse());
}

export async function getEventsSince(sessionKey, sinceId) {
  return getEvents(sessionKey, { sinceId, limit: 1000 });
}

export async function getTaskEvents(taskId, limit = 50) {
  await flushBuffer();
  const db = await getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM event_stream WHERE task_id = ? ORDER BY id ASC LIMIT ?').all(taskId, limit);
  } catch (err) {
    logger.error(`[${ts()}] [event-stream] getTaskEvents failed: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// ─── NEW: State Rebuild from Events (v2.0 core feature) ───
// ═══════════════════════════════════════════════════════════

/**
 * @typedef {Object} TaskState
 * @property {string} taskId
 * @property {string} sessionKey
 * @property {string|null} goal           - User's objective
 * @property {Object|null} plan           - Current structured plan
 * @property {string|null} currentStepId  - Current step being executed
 * @property {"running"|"waiting_user"|"completed"|"error"|"idle"} status
 * @property {Array} recentObservations   - Last N observations
 * @property {Array} recentActions        - Last N actions
 * @property {Object|null} lastError      - Most recent error
 * @property {string|null} lastToolCall   - Last tool that was called
 * @property {string|null} lastToolResult - Last tool result summary
 * @property {boolean} isWaitingUser      - Whether task is blocked on user input
 * @property {string|null} waitingQuestion - The question asked to user (if waiting)
 * @property {number} totalActions        - Total actions executed
 * @property {number} totalToolCalls      - Total tool calls made
 * @property {number} totalErrors         - Total errors encountered
 * @property {number} lastEventId         - ID of the last processed event
 * @property {string|null} finalAnswer    - Final answer (if completed)
 * @property {number} rebuiltAt           - Timestamp of state rebuild
 * @property {boolean} hasKnowledge       - Whether knowledge was gathered
 * @property {Object|null} knowledgeGathered - Last knowledge gather payload
 * @property {string|null} lastKnowledgeTraceId - Last knowledge trace correlation ID
 * @property {Array} knowledgeEvents      - All knowledge events for this task (capped at 20)
 */

/**
 * Rebuild complete task state from event stream.
 * This is the PRIMARY state recovery mechanism.
 *
 * @param {string} taskId
 * @param {string} [sessionKey] - Optional, will be inferred from events if not provided
 * @returns {Promise<TaskState>}
 */
export async function rebuildTaskStateFromEvents(taskId, sessionKey = null) {
  // [R3] Guard against recursive flush when called from within flushBuffer's setImmediate
  if (_eventBuffer.length > 0 && !_flushing) await flushBuffer();
  const db = await getDb();

  // Initialize empty state
  const state = {
    taskId,
    sessionKey: sessionKey || null,
    goal: null,
    plan: null,
    currentStepId: null,
    status: 'idle',
    recentObservations: [],
    recentActions: [],
    lastError: null,
    lastToolCall: null,
    lastToolResult: null,
    isWaitingUser: false,
    waitingQuestion: null,
    totalActions: 0,
    totalToolCalls: 0,
    totalErrors: 0,
    lastEventId: 0,
    finalAnswer: null,
    knowledgeGathered: null,
    lastKnowledgeTraceId: null,
    knowledgeEvents: [],
    // [R70-P0-2] Recover per-step tool gate tracker for STEP-GATE after restart.
    stepTracker: null,
    // [R71-P0-3] Evidence map per step for step-completion gate.
    evidenceStore: {},
    // [R71-P0-4] Track current active action for recovery.
    activeAction: null,
    // [P0-2 P1-2] Track parallel sub-agent waves for recovery.
    subAgentWaves: [],
    // [R74-P0-3] Track worker lifecycle state for recovery.
    workers: {},
    workersHistory: [],
    rebuiltAt: Date.now(),
  };

  if (!db) {
    logger.warn(`[${ts()}] [event-stream] Cannot rebuild state — DB unavailable`);
    return state;
  }

  try {
    // Get all events for this task, ordered chronologically
    const events = db.prepare(`
      SELECT * FROM event_stream
      WHERE task_id = ?
      ORDER BY id ASC
    `).all(taskId);

    if (events.length === 0) {
      logger.info(`[${ts()}] [event-stream] No events found for task ${taskId}`);
      return state;
    }

    const seenActionKeys = new Set();
    const seenObservationKeys = new Set();
    const seenStepToolKeys = new Set();

    const parseEventTime = (value) => {
      const ms = value ? Date.parse(value) : NaN;
      return Number.isFinite(ms) ? ms : Date.now();
    };
    const resetStepTracker = (stepId, eventTime = null) => {
      if (!stepId) {
        state.stepTracker = null;
        return;
      }
      const startedAt = eventTime || Date.now();
      state.stepTracker = {
        stepId: String(stepId),
        toolCount: 0,
        count: 0, // compat with openclaw-handler STEP-GATE tracker
        startedAt,
        elapsedMs: 0,
        lastTool: null,
      };
    };
    const noteStepTool = (payload, event, fallbackTool = null) => {
      const tool = fallbackTool || payload.tool || payload.name || event.tool_name || null;
      if (!tool) return;
      const stepId = payload.stepId || state.currentStepId || state.stepTracker?.stepId || null;
      if (!stepId) return;
      const key = payload.actionId || `${event.event_type}:${event.id}:${tool}`;
      if (seenStepToolKeys.has(key)) return;
      seenStepToolKeys.add(key);
      const eventTime = parseEventTime(event.created_at);
      if (!state.stepTracker || String(state.stepTracker.stepId) !== String(stepId)) {
        resetStepTracker(stepId, eventTime);
      }
      state.stepTracker.toolCount = (state.stepTracker.toolCount || 0) + 1;
      state.stepTracker.count = state.stepTracker.toolCount;
      state.stepTracker.elapsedMs = Math.max(0, eventTime - (state.stepTracker.startedAt || eventTime));
      state.stepTracker.lastTool = {
        tool,
        actionId: payload.actionId || null,
        timestamp: event.created_at || new Date(eventTime).toISOString(),
      };
    };

    // Replay events to rebuild state
    for (const event of events) {
      let payload;
      try {
        payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      } catch {
        payload = {};
      }

      state.lastEventId = event.id;
      if (!state.sessionKey && event.session_key) {
        state.sessionKey = event.session_key;
      }

      switch (event.event_type) {
        case EVENT_TYPES.USER_MESSAGE:
          state.status = 'running';
          if (!state.goal && payload.content) {
            state.goal = payload.content.substring(0, 500);
          }
          if (state.isWaitingUser) {
            state.isWaitingUser = false;
            state.waitingQuestion = null;
          }
          break;

        case EVENT_TYPES.PLAN_UPDATE:
        case EVENT_TYPES.PLAN_CREATED:
          if (payload.plan) {
            state.plan = payload.plan;
            state.currentStepId = payload.stepId || payload.currentStepId || payload.plan.currentStepId || null;
          }
          if (payload.planId && state.plan && !state.plan.planId) state.plan.planId = payload.planId;
          break;

        case EVENT_TYPES.STEP_STARTED:
          state.status = 'running';
          if (payload.stepId) {
            state.currentStepId = payload.stepId;
            resetStepTracker(payload.stepId, parseEventTime(event.created_at));
          }
          break;

        case EVENT_TYPES.STEP_COMPLETED:
          if (payload.nextStepId) {
            state.currentStepId = payload.nextStepId;
            resetStepTracker(payload.nextStepId, parseEventTime(event.created_at));
          } else if (state.stepTracker && String(state.stepTracker.stepId) === String(payload.stepId)) {
            state.stepTracker.elapsedMs = Math.max(0, parseEventTime(event.created_at) - (state.stepTracker.startedAt || parseEventTime(event.created_at)));
            state.stepTracker = null;
          }
          break;

        // [P0-2 P1-2] Parallel sub-agent wave events
        case EVENT_TYPES.PARALLEL_WAVE_DETECTED:
          if (!state.subAgentWaves) state.subAgentWaves = [];
          state.subAgentWaves.push({
            waveId: payload.waveId || `wave-${state.subAgentWaves.length}`,
            waveIndex: payload.waveIndex || state.subAgentWaves.length,
            stepCount: payload.stepCount || (payload.steps ? payload.steps.length : 0),
            steps: payload.steps || [],
            status: 'started',
            startedAt: event.created_at,
          });
          break;

        case EVENT_TYPES.PARALLEL_WAVE_COMPLETED:
          if (state.subAgentWaves && payload.waveId) {
            const wave = state.subAgentWaves.find(w => w.waveId === payload.waveId);
            if (wave) {
              wave.completed = payload.completed || 0;
              wave.failed = payload.failed || 0;
              wave.durationMs = payload.durationMs || 0;
              wave.status = 'completed';
              wave.completedAt = event.created_at;
            }
          }
          break;

        // [R74-P0-3] Worker lifecycle event handlers
        case EVENT_TYPES.WORKER_STARTED: {
          const wid = payload.workerId || `worker-${event.id}`;
          state.workers[wid] = {
            workerId: wid,
            taskId: payload.taskId || taskId,
            stepId: payload.stepId || null,
            stepTitle: payload.stepTitle || null,
            status: 'starting',
            startedAt: event.created_at || new Date().toISOString(),
            completedAt: null,
            elapsedMs: 0,
            retryCount: 0,
            result: null,
            lastError: null,
          };
          state.workersHistory.push({
            workerId: wid,
            event: 'started',
            stepId: payload.stepId,
            timestamp: event.created_at,
          });
          // Keep history capped at 50 entries
          if (state.workersHistory.length > 50) {
            state.workersHistory = state.workersHistory.slice(-50);
          }
          break;
        }

        case EVENT_TYPES.WORKER_COMPLETED: {
          const wid2 = payload.workerId;
          if (wid2 && state.workers[wid2]) {
            state.workers[wid2].status = 'completed';
            state.workers[wid2].completedAt = event.created_at || new Date().toISOString();
            state.workers[wid2].elapsedMs = payload.elapsedMs || 0;
            state.workers[wid2].resultLength = payload.resultLength || 0;
          }
          if (wid2) {
            state.workersHistory.push({
              workerId: wid2,
              event: 'completed',
              stepId: payload.stepId,
              elapsedMs: payload.elapsedMs,
              timestamp: event.created_at,
            });
            if (state.workersHistory.length > 50) state.workersHistory = state.workersHistory.slice(-50);
          }
          break;
        }

        case EVENT_TYPES.WORKER_FAILED: {
          const wid3 = payload.workerId;
          if (wid3 && state.workers[wid3]) {
            state.workers[wid3].status = 'failed';
            state.workers[wid3].lastError = payload.error || 'Unknown worker error';
            state.workers[wid3].completedAt = event.created_at || new Date().toISOString();
            state.workers[wid3].elapsedMs = payload.elapsedMs || 0;
          }
          if (wid3) {
            state.workersHistory.push({
              workerId: wid3,
              event: 'failed',
              stepId: payload.stepId,
              error: payload.error,
              timestamp: event.created_at,
            });
            if (state.workersHistory.length > 50) state.workersHistory = state.workersHistory.slice(-50);
          }
          break;
        }

        case EVENT_TYPES.WORKER_RETRIED: {
          const wid4 = payload.workerId;
          if (wid4 && state.workers[wid4]) {
            state.workers[wid4].status = 'retrying';
            state.workers[wid4].retryCount = (state.workers[wid4].retryCount || 0) + 1;
            state.workers[wid4].lastError = payload.error || 'Retry triggered';
          }
          if (wid4) {
            state.workersHistory.push({
              workerId: wid4,
              event: 'retried',
              stepId: payload.stepId,
              attempt: payload.attempt,
              error: payload.error,
              timestamp: event.created_at,
            });
            if (state.workersHistory.length > 50) state.workersHistory = state.workersHistory.slice(-50);
          }
          break;
        }

        case EVENT_TYPES.ACTION:
        case EVENT_TYPES.ACTION_STARTED: {
          const actionKey = payload.actionId || `${event.event_type}:${event.id}`;
          if (!seenActionKeys.has(actionKey)) {
            seenActionKeys.add(actionKey);
            state.totalActions++;
            state.recentActions.push({
              type: payload.type || 'unknown',
              tool: payload.tool || null,
              reason: payload.reason || '',
              planId: payload.planId || null,
              stepId: payload.stepId || state.currentStepId || null,
              actionId: payload.actionId || null,
              timestamp: event.created_at,
            });
            // Keep only last 10 actions
            if (state.recentActions.length > 10) {
              state.recentActions = state.recentActions.slice(-10);
            }
            // [R71-P0-4] Track active action for recovery
            state.activeAction = {
              type: payload.type || 'unknown',
              tool: payload.tool || null,
              stepId: payload.stepId || state.currentStepId || null,
              actionId: payload.actionId || actionKey,
              startedAt: event.created_at || new Date().toISOString(),
              reason: payload.reason || null,
            };
            if (payload.type === ACTION_TYPES.TOOL_CALL) {
              state.lastToolCall = payload.tool;
              state.totalToolCalls++;
              noteStepTool(payload, event, payload.tool);
            }
          }
          break;
        }

        case EVENT_TYPES.OBSERVATION:
        case EVENT_TYPES.OBSERVATION_RECORDED:
        case EVENT_TYPES.ACTION_COMPLETED: {
          const observationKey = payload.actionId || `${event.event_type}:${event.id}`;
          if (!seenObservationKeys.has(observationKey)) {
            seenObservationKeys.add(observationKey);
            state.recentObservations.push({
              type: payload.type || 'tool_result',
              tool: event.tool_name || payload.tool || null,
              content: (payload.content || payload.result || '').substring(0, 5000),
              success: payload.success !== false,
              planId: payload.planId || null,
              stepId: payload.stepId || state.currentStepId || null,
              actionId: payload.actionId || null,
              timestamp: event.created_at,
            });
            // Keep only last 10 observations
            if (state.recentObservations.length > 10) {
              state.recentObservations = state.recentObservations.slice(-10);
            }
            if (event.tool_name || payload.tool) {
              state.lastToolResult = (payload.content || payload.result || '').substring(0, 300);
            }
            // [R71-P0-4] Clear active action on completion
            if (state.activeAction && state.activeAction.actionId === payload.actionId) {
              state.activeAction = null;
            }
          }
          break;
        }

        // [R71-P0-3] Evidence recorded for step verification gate
        case EVENT_TYPES.STEP_EVIDENCE_RECORDED: {
          const _sid = payload.stepId || state.currentStepId || null;
          if (_sid) {
            if (!state.evidenceStore) state.evidenceStore = {};
            if (!state.evidenceStore[_sid]) state.evidenceStore[_sid] = [];
            state.evidenceStore[_sid].push({
              type: payload.evidenceType || 'unknown',
              detail: payload.detail || payload.result || '',
              timestamp: event.created_at || new Date().toISOString(),
            });
          }
          break;
        }

        // [R71-P0-3] Step marked as needs_verification (evidence gate blocked)
        case EVENT_TYPES.STEP_NEEDS_VERIFICATION: {
          const _sid2 = payload.stepId || state.currentStepId || null;
          if (_sid2) {
            if (!state.evidenceStore) state.evidenceStore = {};
            if (!state.evidenceStore[_sid2]) state.evidenceStore[_sid2] = [];
            state.evidenceStore[_sid2].push({
              type: 'needs_verification',
              detail: payload.reason || 'No evidence provided',
              timestamp: event.created_at || new Date().toISOString(),
            });
          }
          break;
        }

        // [R71-P0-1] No-plan action detected (warn, not block)
        case EVENT_TYPES.NO_PLAN_ACTION: {
          state.totalErrors++;
          state.lastError = {
            message: (payload.reason || 'Action without active plan') + ' (warned)',
            timestamp: event.created_at,
            tool: event.tool_name || payload.tool || null,
          };
          break;
        }

        case EVENT_TYPES.TOOL_CALL:
          state.lastToolCall = event.tool_name || payload.tool || payload.name;
          state.totalToolCalls++;
          noteStepTool(payload, event, state.lastToolCall);
          break;

        case EVENT_TYPES.TOOL_RESULT:
          state.lastToolResult = (payload.result || payload.content || '').substring(0, 300);
          break;

        case EVENT_TYPES.WAITING_USER:
        case EVENT_TYPES.ASK:
          state.isWaitingUser = true;
          state.waitingQuestion = payload.question || payload.content || null;
          state.status = 'waiting_user';
          break;

        case EVENT_TYPES.RESUME:
          state.isWaitingUser = false;
          state.waitingQuestion = null;
          state.status = 'running';
          break;

        case EVENT_TYPES.ERROR:
          state.totalErrors++;
          state.lastError = {
            message: payload.message || payload.error || 'Unknown error',
            timestamp: event.created_at,
            tool: event.tool_name || null,
          };
          break;

        case EVENT_TYPES.FINAL_ANSWER:
        case EVENT_TYPES.TASK_COMPLETED:
          state.status = 'completed';
          state.finalAnswer = payload.content || payload.answer || state.finalAnswer || '';
          break;

        case EVENT_TYPES.TASK_FAILED:
          state.status = 'error';
          state.totalErrors++;
          state.lastError = {
            message: payload.message || payload.error || payload.failureType || 'Task failed',
            failureType: payload.failureType || null,
            recoveryAction: payload.recoveryAction || null,
            timestamp: event.created_at,
            tool: event.tool_name || payload.tool || null,
          };
          break;

        case EVENT_TYPES.TASK_STATE_UPDATE:
          // Merge any explicit state updates
          if (payload.status) state.status = payload.status;
          if (payload.goal) state.goal = payload.goal;
          if (payload.currentStepId) state.currentStepId = payload.currentStepId;
          break;

        case EVENT_TYPES.KNOWLEDGE_GATHERED:
          state.knowledgeGathered = payload;
          state.lastKnowledgeTraceId = payload.traceId || state.lastKnowledgeTraceId || null;
          // Store knowledge events for replay consumers
          if (!state.knowledgeEvents) state.knowledgeEvents = [];
          state.knowledgeEvents.push({
            module: payload.module || 'knowledge',
            instanceId: payload.instanceId || null,
            scope: payload.scope || 'unknown',
            searchTerms: payload.searchTerms || null,
            segments: payload.segments || [],
            reason: payload.reason || null,
            ts: payload.ts || event.created_at,
            traceId: payload.traceId || null,
            totalChars: payload.totalChars ?? 0,
            budgetTotal: payload.budgetTotal ?? 0,
            budgetUsed: payload.budgetUsed ?? 0,
            latencyMs: payload.latencyMs ?? 0,
            activeSources: payload.activeSources || [],
            errors: payload.errors || [],
          });
          // Keep only last 20 knowledge events
          if (state.knowledgeEvents.length > 20) {
            state.knowledgeEvents = state.knowledgeEvents.slice(-20);
          }
          break;

        case EVENT_TYPES.REPLAN:
          // Plan revision was triggered
          if (payload.plan) {
            state.plan = payload.plan;
            state.currentStepId = payload.plan.currentStepId || state.currentStepId;
          }
          break;

        case EVENT_TYPES.PLAN_STEP_UPDATE:
          // Individual step status change
          if (state.plan && payload.stepId) {
            const step = state.plan.steps?.find(s => s.id === payload.stepId);
            if (step) {
              if (payload.status) step.status = payload.status;
              if (payload.output) step.output = payload.output;
              if (payload.blockReason) step.blockReason = payload.blockReason;
            }
            if (payload.nextStepId) {
              state.currentStepId = payload.nextStepId;
              resetStepTracker(payload.nextStepId, parseEventTime(event.created_at));
            }
          }
          break;

        default:
          // Other events don't affect core state
          break;
      }
    }

    if (state.stepTracker) {
      const now = Date.now();
      state.stepTracker.elapsedMs = Math.max(state.stepTracker.elapsedMs || 0, now - (state.stepTracker.startedAt || now));
    }
    logger.info(`[${ts()}] [event-stream] State rebuilt for task ${taskId}: status=${state.status}, events=${events.length}, actions=${state.totalActions}, tools=${state.totalToolCalls}, stepTracker=${state.stepTracker ? `${state.stepTracker.stepId}/${state.stepTracker.toolCount}` : 'none'}, evidenceSteps=${Object.keys(state.evidenceStore || {}).length}, activeAction=${state.activeAction ? state.activeAction.actionId : 'none'}, workersActive=${state.workers ? Object.keys(state.workers).length : 0}`);
    return state;

  } catch (err) {
    logger.error(`[${ts()}] [event-stream] State rebuild failed for task ${taskId}: ${err.message}`);
    return state;
  }
}

// ─── [R3-Task2] End-to-End Replay Verification ───

/**
 * Verify that rebuildTaskStateFromEvents produces a state consistent
 * with the actual executor observations recorded in the event stream.
 *
 * Checks: step count, per-step success/fail, tool types.
 * Logs REPLAY_OK or REPLAY_MISMATCH.
 *
 * @param {string} taskId
 * @param {string} [sessionKey]
 * @returns {Promise<{ok: boolean, details: Object}>}
 */
export async function verifyReplayConsistency(taskId, sessionKey = null) {
  try {
    // Step 1: Rebuild state from events
    const state = await rebuildTaskStateFromEvents(taskId, sessionKey);

    // Step 2: Get raw action and observation events for ground truth
    // Note: flushBuffer already completed before this is called (via setImmediate in flushBuffer)
    const db = await getDb();
    if (!db) {
      logger.warn(`[${ts()}] [event-stream] REPLAY_SKIP: DB unavailable for task ${taskId}`);
      return { ok: false, details: { reason: 'db_unavailable' } };
    }

    const actionEvents = db.prepare(`
      SELECT * FROM event_stream
      WHERE task_id = ? AND event_type IN ('action', 'action_started')
      ORDER BY id ASC
    `).all(taskId);

    const observationEvents = db.prepare(`
      SELECT * FROM event_stream
      WHERE task_id = ? AND event_type IN ('observation', 'observation_recorded', 'action_completed')
      ORDER BY id ASC
    `).all(taskId);

    // [R4] Also fetch plan_step_update events for step-level verification
    const planStepEvents = db.prepare(`
      SELECT * FROM event_stream
      WHERE task_id = ? AND event_type = 'plan_step_update'
      ORDER BY id ASC
    `).all(taskId);

    // [R7-Task3] Dual-key check: verify all events share the same session_key
    const allEvents = [...actionEvents, ...observationEvents, ...planStepEvents];
    const sessionKeys = new Set(allEvents.map(e => e.session_key).filter(Boolean));
    let sessionKeyConsistent = true;
    if (sessionKey && sessionKeys.size > 0) {
      const foreignKeys = [...sessionKeys].filter(k => k !== sessionKey);
      if (foreignKeys.length > 0) {
        sessionKeyConsistent = false;
        logger.warn(`[${ts()}] [R7-dual-key] session_key mismatch: task=${taskId} expected=${sessionKey.substring(0, 40)} foreign=[${foreignKeys.map(k => k.substring(0, 20)).join(',')}]`);
      }
    }
    // [R7-Task4] Seq ordering check: verify _seq in payloads is monotonically increasing
    let seqOrderOk = true;
    let lastSeq = 0;
    const seqEvents = allEvents.sort((a, b) => a.id - b.id);
    for (const evt of seqEvents) {
      let payload;
      try { payload = JSON.parse(evt.payload); } catch { payload = {}; }
      if (payload._seq !== undefined) {
        if (payload._seq <= lastSeq && lastSeq > 0) {
          seqOrderOk = false;
          logger.warn(`[${ts()}] [R7-seq-order] non-monotonic: task=${taskId} eventId=${evt.id} seq=${payload._seq} prevSeq=${lastSeq}`);
        }
        lastSeq = payload._seq;
      }
    }

    const uniqueActionEvents = [];
    const seenActionGroundKeys = new Set();
    for (const act of actionEvents) {
      let payload;
      try { payload = JSON.parse(act.payload); } catch { payload = {}; }
      const key = payload.actionId || `${act.event_type}:${act.id}`;
      if (seenActionGroundKeys.has(key)) continue;
      seenActionGroundKeys.add(key);
      uniqueActionEvents.push(act);
    }

    const uniqueObservationEvents = [];
    const seenObservationGroundKeys = new Set();
    for (const obs of observationEvents) {
      let payload;
      try { payload = JSON.parse(obs.payload); } catch { payload = {}; }
      const key = payload.actionId || `${obs.event_type}:${obs.id}`;
      if (seenObservationGroundKeys.has(key)) continue;
      seenObservationGroundKeys.add(key);
      uniqueObservationEvents.push(obs);
    }

    // Step 3: Build ground truth from raw events
    const groundTruth = {
      totalActions: uniqueActionEvents.length,
      totalObservations: uniqueObservationEvents.length,
      steps: [],  // { stepId, success, toolType, tool }
      planStepUpdates: [],  // { stepId, status }
    };

    for (const obs of uniqueObservationEvents) {
      let payload;
      try { payload = JSON.parse(obs.payload); } catch { payload = {}; }
      groundTruth.steps.push({
        stepId: payload.stepId || null,
        success: payload.success !== false,
        toolType: payload.type || obs.tool_name || 'unknown',
        tool: obs.tool_name || payload.tool || null,
      });
    }

    for (const pse of planStepEvents) {
      let payload;
      try { payload = JSON.parse(pse.payload); } catch { payload = {}; }
      groundTruth.planStepUpdates.push({
        stepId: payload.stepId || null,
        status: payload.status || 'unknown',
      });
    }

    // Step 4: Compare rebuilt state with ground truth
    const mismatches = [];

    // Check total action count
    if (state.totalActions !== groundTruth.totalActions) {
      mismatches.push(`totalActions: rebuilt=${state.totalActions} vs ground=${groundTruth.totalActions}`);
    }

    // Check observation count matches recent observations (capped at 10)
    const expectedObsCount = Math.min(groundTruth.totalObservations, 10);
    if (state.recentObservations.length !== expectedObsCount) {
      mismatches.push(`recentObservations: rebuilt=${state.recentObservations.length} vs expected=${expectedObsCount}`);
    }

    // Check per-step success/fail consistency
    const recentObs = state.recentObservations;
    const groundTruthRecent = groundTruth.steps.slice(-10);
    for (let i = 0; i < Math.min(recentObs.length, groundTruthRecent.length); i++) {
      const rebuilt = recentObs[i];
      const ground = groundTruthRecent[i];
      if (rebuilt.success !== ground.success) {
        mismatches.push(`obs[${i}].success: rebuilt=${rebuilt.success} vs ground=${ground.success}`);
      }
      // Check tool type consistency (allow null/unknown mismatches)
      if (rebuilt.tool && ground.toolType && ground.toolType !== 'unknown' &&
          rebuilt.tool !== ground.toolType && rebuilt.type !== ground.toolType) {
        mismatches.push(`obs[${i}].tool: rebuilt=${rebuilt.tool || rebuilt.type} vs ground=${ground.toolType}`);
      }
    }

    const ok = mismatches.length === 0;
    const details = {
      totalActions: state.totalActions,
      totalObservations: groundTruth.totalObservations,
      stepsChecked: Math.min(recentObs.length, groundTruthRecent.length),
      mismatches,
    };

    // [R5-Task2] Build step-level summary with failed/blocked/retrying breakdown
    const stepSummary = groundTruth.steps.map((s, i) => `${s.tool || 'unknown'}:${s.success ? 'ok' : 'fail'}`).join(', ');
    const planStepSummary = groundTruth.planStepUpdates.map(p => `${p.stepId}:${p.status}`).join(', ');
    // [R5] Count steps by status from plan_step_update events
    const doneSteps = groundTruth.planStepUpdates.filter(p => p.status === 'done').length;
    const failedSteps = groundTruth.planStepUpdates.filter(p => p.status === 'failed').length;
    const blockedSteps = groundTruth.planStepUpdates.filter(p => p.status === 'blocked').length;
    const retryingSteps = groundTruth.planStepUpdates.filter(p => p.status === 'retrying').length;
    const statusBreakdown = `doneSteps=${doneSteps} failedSteps=${failedSteps} blockedSteps=${blockedSteps} retryingSteps=${retryingSteps}`;

    // [R7] Add dual-key and seq-order results to log
    const r7Checks = `sessionKeyOk=${sessionKeyConsistent} seqOrderOk=${seqOrderOk} maxSeq=${lastSeq}`;
    if (ok) {
      logger.info(`[${ts()}] [event-stream] REPLAY_OK: taskId=${taskId} actions=${groundTruth.totalActions} observations=${groundTruth.totalObservations} steps=[${stepSummary}] planUpdates=[${planStepSummary}] ${statusBreakdown} ${r7Checks} matched=true`);
    } else {
      logger.warn(`[${ts()}] [event-stream] REPLAY_MISMATCH: taskId=${taskId} actions=${groundTruth.totalActions} observations=${groundTruth.totalObservations} steps=[${stepSummary}] planUpdates=[${planStepSummary}] ${statusBreakdown} ${r7Checks} mismatches=${JSON.stringify(mismatches)}`);
    }

    return { ok, details };

  } catch (err) {
    logger.error(`[${ts()}] [event-stream] Replay verification failed for task ${taskId}: ${err.message}`);
    return { ok: false, details: { error: err.message } };
  }
}

/**
 * Get a compact state snapshot for context injection.
 * Lighter than full rebuildTaskStateFromEvents — uses recent events only.
 *
 * @param {string} taskId
 * @param {string} sessionKey
 * @returns {Promise<string|null>} Text block for context injection
 */
export async function getStateSnapshotForContext(taskId, sessionKey) {
  const state = await rebuildTaskStateFromEvents(taskId, sessionKey);
  if (state.status === 'idle' && state.totalActions === 0) return null;

  const lines = [`[TASK_STATE taskId="${taskId}"]`];
  lines.push(`Status: ${state.status}`);
  if (state.goal) lines.push(`Goal: ${state.goal}`);
  if (state.currentStepId) lines.push(`Current Step: ${state.currentStepId}`);
  lines.push(`Progress: ${state.totalActions} actions, ${state.totalToolCalls} tool calls, ${state.totalErrors} errors`);

  if (state.isWaitingUser) {
    lines.push(`⏳ WAITING FOR USER: ${state.waitingQuestion || '(no question specified)'}`);
  }

  if (state.lastToolCall) {
    lines.push(`Last Tool: ${state.lastToolCall}`);
  }
  if (state.lastToolResult) {
    lines.push(`Last Result: ${state.lastToolResult.substring(0, 200)}`);
  }
  if (state.lastError) {
    lines.push(`Last Error: ${state.lastError.message}`);
  }

  if (state.recentObservations.length > 0) {
    lines.push(`Recent Observations:`);
    for (const obs of state.recentObservations.slice(-5)) {
      const icon = obs.success ? '✓' : '✗';
      lines.push(`  ${icon} [${obs.tool || obs.type}] ${obs.content.substring(0, 150)}`);
    }
  }

  // ── [Iter-68] Knowledge Replay: re-inject runtime-gathered knowledge ──
  // During task replay/resume, the AI should see what it previously learned
  // via KnowledgeModule (e.g. datasource, web search, internal API data).
  // This closes the gap where gathered knowledge was persisted in event_stream
  // but not replayed during context injection.
  if (state.knowledgeEvents && state.knowledgeEvents.length > 0) {
    const deduped = new Map(); // dedup by scope to avoid flooding context
    for (const ke of state.knowledgeEvents.slice(-10)) {
      const scope = ke.scope || 'unknown';
      if (!deduped.has(scope)) deduped.set(scope, ke);
    }
    const replayed = [...deduped.values()];
    if (replayed.length > 0) {
      lines.push(`Replayed Knowledge (${replayed.length} scopes):`);
      for (const ke of replayed) {
        const segments = (ke.segments || []).filter(s => s.title || s.content);
        if (segments.length === 0) continue;
        lines.push(`  [${ke.scope || 'knowledge'}] sources=${(ke.activeSources || []).join(',')}`);
        for (const seg of segments.slice(0, 3)) {
          const snippet = (seg.content || seg.title || '').substring(0, 200);
          if (snippet) lines.push(`    - ${snippet}`);
        }
      }
    }
  }

  lines.push(`[/TASK_STATE]`);
  return lines.join('\n');
}

// ─── Event Summarization (retained, enhanced) ───

/**
 * Generate a summary of events for context injection.
 */
export async function summarizeEvents(sessionKey, maxEvents = 30) {
  const events = await getRecentEvents(sessionKey, maxEvents);
  if (events.length === 0) return null;

  const lines = [];
  for (const e of events) {
    let payload;
    try { payload = JSON.parse(e.payload); } catch { payload = {}; }

    switch (e.event_type) {
      case EVENT_TYPES.USER_MESSAGE:
        lines.push(`[User] ${(payload.content || '').substring(0, 200)}`);
        break;
      case EVENT_TYPES.ASSISTANT_MESSAGE:
        lines.push(`[Assistant] ${(payload.content || '').substring(0, 200)}`);
        break;
      case EVENT_TYPES.ACTION:
        lines.push(`[Action:${payload.type}] ${payload.tool || ''} — ${(payload.reason || '').substring(0, 100)}`);
        break;
      case EVENT_TYPES.OBSERVATION:
        lines.push(`[Observation] ${(payload.content || payload.result || '').substring(0, 150)}`);
        break;
      case EVENT_TYPES.TOOL_CALL:
        lines.push(`[Tool:${e.tool_name}] Called: ${(payload.args || '').substring(0, 100)}`);
        break;
      case EVENT_TYPES.TOOL_RESULT:
        lines.push(`[Tool:${e.tool_name}] Result: ${(payload.result || '').substring(0, 150)}`);
        break;
      case EVENT_TYPES.PLAN_UPDATE:
        lines.push(`[Plan v${payload.version || '?'}] ${payload.trigger || 'updated'}: ${(payload.plan?.goal || '').substring(0, 100)}`);
        break;
      case EVENT_TYPES.PLAN_STEP_UPDATE:
        lines.push(`[Step ${payload.stepId}] ${payload.status}: ${(payload.output || payload.blockReason || '').substring(0, 100)}`);
        break;
      case EVENT_TYPES.NOTIFY:
        lines.push(`[Notify] ${(payload.content || '').substring(0, 150)}`);
        break;
      case EVENT_TYPES.ASK:
        lines.push(`[Ask] ${(payload.question || payload.content || '').substring(0, 150)}`);
        break;
      case EVENT_TYPES.FINAL_ANSWER:
        lines.push(`[Final] ${(payload.content || '').substring(0, 200)}`);
        break;
      case EVENT_TYPES.KNOWLEDGE_GATHERED:
        lines.push(`[Knowledge:Gathered] traceId=${payload.traceId || '?'} sources=[${(payload.activeSources || []).join(',')}] chars=${payload.totalChars || 0}/${payload.budgetTotal || '?'} latency=${payload.latencyMs || '?'}ms`);
        break;
      case EVENT_TYPES.KNOWLEDGE_INJECT:
        lines.push(`[Knowledge:Injected] traceId=${payload.traceId || '?'} chars=${payload.totalChars || 0}`);
        break;
      case EVENT_TYPES.ERROR:
        lines.push(`[Error] ${(payload.message || '').substring(0, 150)}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

// ─── Cleanup ───

export async function cleanupOldEvents(retentionDays = 7) {
  const db = await getDb();
  if (!db) return 0;
  try {
    const result = db.prepare(`
      DELETE FROM event_stream
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    const deleted = result.changes;
    if (deleted > 0) {
      logger.info(`[${ts()}] [event-stream] Cleaned up ${deleted} events older than ${retentionDays} days`);
    }
    return deleted;
  } catch (err) {
    logger.error(`[${ts()}] [event-stream] Cleanup failed: ${err.message}`);
    return 0;
  }
}

export async function getEventCount(sessionKey) {
  const db = await getDb();
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM event_stream WHERE session_key = ?').get(sessionKey);
    return row?.count || 0;
  } catch { return 0; }
}
