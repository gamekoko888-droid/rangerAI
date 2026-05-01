// ─── todo-tracker.mjs ─── R26-T3 ───────────────────────────────────────────
// Attention mechanism inspired by Manus's todo.md pattern.
// Maintains per-session todo state derived from the planner's structured plan.
// After each tool_end, generates a compact todo snapshot that gets injected
// into the next LLM context — keeping the agent focused on its goals even
// after 50+ tool calls.
//
// Exports:
//   syncFromPlan(taskId, plan)          — rebuild todo from plan steps
//   markInProgress(taskId, stepId)      — [→] transition
//   markDone(taskId, stepId, output)    — [x] transition
//   markFailed(taskId, stepId, reason)  — [!] transition
//   getSnapshot(taskId)                 — returns formatted todo string
//   emitTodoEvent(taskId, emitEvent)    — fire todo_updated event
// ────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'module';
import Database from 'better-sqlite3';
const require = createRequire(import.meta.url);
const path = await import('path');

const TODO_DB_PATH = '/opt/rangerai-agent/db/rangerai.db';
let _todoDb = null;
let _saveStmt = null;
let _loadStmt = null;
let _deleteStmt = null;

function getTodoDb() {
  if (_todoDb) return _todoDb;
  _todoDb = new Database(TODO_DB_PATH);
  _todoDb.pragma('journal_mode = WAL');
  _todoDb.exec(`
    CREATE TABLE IF NOT EXISTS todo_state (
      task_id TEXT PRIMARY KEY,
      goal TEXT,
      version INTEGER DEFAULT 1,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
  _saveStmt = _todoDb.prepare(`
    INSERT INTO todo_state (task_id, goal, version, updated_at, payload_json)
    VALUES (@task_id, @goal, @version, @updated_at, @payload_json)
    ON CONFLICT(task_id) DO UPDATE SET
      goal=excluded.goal,
      version=excluded.version,
      updated_at=excluded.updated_at,
      payload_json=excluded.payload_json
  `);
  _loadStmt = _todoDb.prepare('SELECT payload_json FROM todo_state WHERE task_id = ?');
  _deleteStmt = _todoDb.prepare('DELETE FROM todo_state WHERE task_id = ?');
  return _todoDb;
}

function persistTodo(taskId) {
  try {
    const todo = _todoCache.get(taskId);
    if (!todo) return;
    getTodoDb();
    _saveStmt.run({
      task_id: String(taskId),
      goal: todo.goal || '',
      version: Number(todo.version || 1),
      updated_at: Number(todo.updatedAt || Date.now()),
      payload_json: JSON.stringify(todo),
    });
  } catch (err) {
    logger.warn(`[R56-todo-db] persist failed for ${taskId}: ${err.message}`);
  }
}

export function restoreTodo(taskId) {
  try {
    if (_todoCache.has(taskId)) return _todoCache.get(taskId);
    getTodoDb();
    const row = _loadStmt.get(String(taskId));
    if (!row || !row.payload_json) return null;
    const todo = JSON.parse(row.payload_json);
    if (!todo || !Array.isArray(todo.items)) return null;
    _todoCache.set(taskId, todo);
    logger.info(`[R56-todo-db] restored todo for taskId=${taskId}, items=${todo.items.length}`);
    return todo;
  } catch (err) {
    logger.warn(`[R56-todo-db] restore failed for ${taskId}: ${err.message}`);
    return null;
  }
}

// ─── Logger (matches project convention) ────────────────────────────────────
const ts = () => new Date().toISOString();
const logger = {
  info: (...a) => console.log(`[${ts()}]`, ...a),
  warn: (...a) => console.warn(`[${ts()}]`, ...a),
  error: (...a) => console.error(`[${ts()}]`, ...a),
};

// ─── In-memory store ────────────────────────────────────────────────────────
// Map<taskId, TodoState>
// TodoState = { goal: string, items: TodoItem[], version: number, updatedAt: number }
// TodoItem  = { id: string, title: string, status: '[ ]'|'[→]'|'[x]'|'[!]', output?: string }
const _todoCache = new Map();

const MAX_SNAPSHOT_CHARS = 800; // hard cap to avoid context bloat

// ─── Status mapping from plan status to todo marker ─────────────────────────
const STATUS_MAP = {
  pending:  '[ ]',
  doing:    '[→]',
  done:     '[x]',
  failed:   '[!]',
  blocked:  '[!]',
  retrying: '[→]',
  skipped:  '[-]',
};

// ─── Core functions ─────────────────────────────────────────────────────────

/**
 * Rebuild todo list from a planner plan object.
 * Called on plan creation and on replan.
 */
export function syncFromPlan(taskId, plan) {
  if (!plan || !plan.steps || !Array.isArray(plan.steps)) {
    logger.warn(`[R26-T3] syncFromPlan: invalid plan for ${taskId}`);
    return;
  }
  const items = plan.steps.map(step => ({
    id: step.id,
    title: (step.title || '').substring(0, 120),
    status: STATUS_MAP[step.status] || '[ ]',
    output: step.output ? step.output.substring(0, 80) : '',
  }));
  _todoCache.set(taskId, {
    goal: (plan.goal || '').substring(0, 200),
    items,
    version: (plan.plan_version || plan.version || 1),
    updatedAt: Date.now(),
  });
  persistTodo(taskId);
  logger.info(`[R26-T3] syncFromPlan: taskId=${taskId}, steps=${items.length}, goal="${plan.goal?.substring(0, 60)}"`);
}

/**
 * Mark a step as in-progress [→]
 */
export function markInProgress(taskId, stepId) {
  const todo = _todoCache.get(taskId);
  if (!todo) return;
  const item = todo.items.find(i => i.id === stepId);
  if (item && item.status !== '[x]') {
    item.status = '[→]';
    todo.updatedAt = Date.now();
    persistTodo(taskId);
    logger.info(`[R26-T3] markInProgress: taskId=${taskId}, step=${stepId}`);
  }
}

/**
 * Mark a step as done [x]
 */
export function markDone(taskId, stepId, output = '') {
  const todo = _todoCache.get(taskId);
  if (!todo) return;
  const item = todo.items.find(i => i.id === stepId);
  if (item) {
    item.status = '[x]';
    if (output) item.output = output.substring(0, 80);
    todo.updatedAt = Date.now();
    persistTodo(taskId);
    logger.info(`[R26-T3] markDone: taskId=${taskId}, step=${stepId}`);
  }
}

/**
 * Mark a step as failed [!]
 */
export function markFailed(taskId, stepId, reason = '') {
  const todo = _todoCache.get(taskId);
  if (!todo) return;
  const item = todo.items.find(i => i.id === stepId);
  if (item) {
    item.status = '[!]';
    if (reason) item.output = reason.substring(0, 80);
    todo.updatedAt = Date.now();
    persistTodo(taskId);
    logger.info(`[R26-T3] markFailed: taskId=${taskId}, step=${stepId}`);
  }
}

/**
 * Generate a compact todo snapshot for LLM context injection.
 * Format matches Manus's todo.md convention:
 *   ## Current Progress
 *   - [x] 1. Step title (result: ...)
 *   - [→] 2. Step title  ← CURRENT
 *   - [ ] 3. Step title
 */
export function getSnapshot(taskId) {
  const todo = _todoCache.get(taskId);
  if (!todo || !todo.items || todo.items.length === 0) return '';

  const lines = [];
  lines.push(`## Current Progress (v${todo.version})`);
  if (todo.goal) lines.push(`Goal: ${todo.goal}`);

  const doneCount = todo.items.filter(i => i.status === '[x]').length;
  const totalCount = todo.items.length;
  lines.push(`Progress: ${doneCount}/${totalCount} completed`);
  lines.push('');

  for (const item of todo.items) {
    let line = `- ${item.status} ${item.id}. ${item.title}`;
    if (item.status === '[x]' && item.output) {
      line += ` (done: ${item.output})`;
    }
    if (item.status === '[!]' && item.output) {
      line += ` (error: ${item.output})`;
    }
    if (item.status === '[→]') {
      line += '  ← CURRENT';
    }
    lines.push(line);
  }

  let snapshot = lines.join('\n');
  // Hard cap to prevent context bloat
  if (snapshot.length > MAX_SNAPSHOT_CHARS) {
    // Keep header + current + next pending, trim done items
    const headerLines = lines.slice(0, 4);
    const currentAndPending = todo.items
      .filter(i => i.status === '[→]' || i.status === '[ ]' || i.status === '[!]')
      .map(i => {
        let l = `- ${i.status} ${i.id}. ${i.title}`;
        if (i.status === '[→]') l += '  ← CURRENT';
        if (i.status === '[!]' && i.output) l += ` (error: ${i.output})`;
        return l;
      });
    const doneItems = todo.items.filter(i => i.status === '[x]');
    headerLines.push(`(${doneItems.length} completed steps omitted)`);
    snapshot = [...headerLines, ...currentAndPending].join('\n');
    if (snapshot.length > MAX_SNAPSHOT_CHARS) {
      snapshot = snapshot.substring(0, MAX_SNAPSHOT_CHARS) + '\n... (truncated)';
    }
  }

  return snapshot;
}

/**
 * Emit a todo_updated event to event_stream.
 * @param {string} taskId
 * @param {Function} emitEvent - from event-stream.mjs
 * @param {string} sessionKey
 */
export function emitTodoEvent(taskId, emitEvent, sessionKey) {
  if (!emitEvent) return;
  const todo = _todoCache.get(taskId);
  if (!todo) {
    logger.warn(`[R27-T1] emitTodoEvent: no todo in cache for taskId=${taskId}`);
    return;
  }

  // [R27-T1] Inline snapshot generation — bypass getSnapshot() race condition
  // where _items might exist but getSnapshot returns empty due to timing
  const doneCount = todo.items.filter(i => i.status === '[x]').length;
  const currentItem = todo.items.find(i => i.status === '[→]');
  let inlineSnapshot = '';
  try {
    if (todo.items && todo.items.length > 0) {
      const lines = [`## Current Progress (v${todo.version})`];
      if (todo.goal) lines.push(`Goal: ${todo.goal}`);
      lines.push(`Progress: ${doneCount}/${todo.items.length} completed`);
      lines.push('');
      for (const item of todo.items) {
        let line = `- ${item.status} ${item.id}. ${item.title}`;
        if (item.status === '[x]' && item.output) line += ` (done: ${item.output})`;
        if (item.status === '[!]' && item.output) line += ` (error: ${item.output})`;
        if (item.status === '[→]') line += '  ← CURRENT';
        lines.push(line);
      }
      inlineSnapshot = lines.join('\n');
    }
  } catch (_snapErr) {
    logger.warn(`[R27-T1] inline snapshot generation failed: ${_snapErr.message}`);
  }

  try {
    emitEvent('todo_updated', {
      taskId,
      sessionKey: sessionKey || taskId,
      version: todo.version,
      doneCount,
      totalCount: todo.items.length,
      currentStep: currentItem ? currentItem.id : null,
      snapshot: (inlineSnapshot || '').substring(0, 500), // [R27-T1] guaranteed non-empty if items exist
    });
    logger.info(`[R27-T1] emitTodoEvent: taskId=${taskId}, done=${doneCount}/${todo.items.length}, snapshot=${inlineSnapshot.length}chars`);
  } catch (err) {
    logger.warn(`[R27-T1] emitTodoEvent failed (non-fatal): ${err.message}`);
  }
}

/**
 * Check if a todo exists for this task
 */
export function peekTodo(taskId) {
  return _todoCache.get(taskId) || null;
}

export function hasTodo(taskId) {
  return _todoCache.has(taskId) || !!restoreTodo(taskId);
}

/**
 * Clear todo for a task (on task completion)
 */
export function clearTodo(taskId) {
  _todoCache.delete(taskId);
  try {
    getTodoDb();
    _deleteStmt.run(String(taskId));
  } catch (err) {
    logger.warn(`[R56-todo-db] clear failed for ${taskId}: ${err.message}`);
  }
}
