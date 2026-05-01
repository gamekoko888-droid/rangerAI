// task-state-manager.mjs — Structured Task State Management (R98 extraction)
// Extracted from task-engine.mjs LAYER 3
// 
// Maintains a structured state object for each task/session that persists
// across model switches, context compressions, and service restarts.
// 
// The task state is the "golden thread" that keeps all models aligned on:
// - What the user wants (user_goal)
// - What's been done (artifacts, decisions)
// - What's pending (open_questions, risks)
// - What the next model needs to know (handoff_summary)
// 
// @module worker/task-state-manager

import { logger } from '../lib/logger.mjs';
import { TTLMap } from './lib/ttl-map.mjs';
import { rowToState, createDefaultState, mergeState } from './task-state-model.mjs';

const ts = () => new Date().toISOString();

// ─── SQLite Direct Access ───
let _db = null;
let _taskStateStatsTimer = null;

async function getDb() {
  if (_db) return _db;
  try {
    const { default: Database } = await import('better-sqlite3');
    _db = new Database('/opt/rangerai-agent/db/rangerai.db');
    // TD-019: WAL mode + busy_timeout for concurrent access safety
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    let _busyCount = 0;
    let _queryCount = 0;
    const _origPrepare = _db.prepare.bind(_db);
    _db.prepare = function(sql) {
      _queryCount++;
      return _origPrepare(sql);
    };
    // Periodic stats log (every 15 min)
    _taskStateStatsTimer = setInterval(() => {
      logger.info(`[${ts()}] [task-state] [SQLite-STATS] queries=${_queryCount} busy=${_busyCount}`);
      _queryCount = 0;
      _busyCount = 0;
    }, 15 * 60 * 1000);
    if (_taskStateStatsTimer.unref) _taskStateStatsTimer.unref();
    _db.exec(`
      CREATE TABLE IF NOT EXISTS task_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        user_goal TEXT,
        current_plan TEXT DEFAULT '[]',
        current_step INTEGER DEFAULT 0,
        open_questions TEXT DEFAULT '[]',
        constraints TEXT DEFAULT '[]',
        artifacts TEXT DEFAULT '[]',
        tool_observations TEXT DEFAULT '[]',
        working_facts TEXT DEFAULT '[]',
        decisions TEXT DEFAULT '[]',
        risks TEXT DEFAULT '[]',
        done_criteria TEXT DEFAULT '[]',
        last_model TEXT,
        handoff_summary TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ts_session ON task_states(session_key);
      CREATE INDEX IF NOT EXISTS idx_ts_status ON task_states(status);
    `);
    logger.info(`[${ts()}] [task-state] Database initialized`);
    return _db;
  } catch (err) {
    logger.error(`[${ts()}] [task-state] Database init failed: ${err.message}`);
    return null;
  }
}

// ─── In-memory cache (R95: migrated to TTLMap) ───
const _stateCache = new TTLMap(200, 60 * 60 * 1000, 5 * 60 * 1000);

function getCached(taskId) {
  return _stateCache.get(taskId);
}

function setCache(taskId, state) {
  _stateCache.set(taskId, state);
}

// ─── Public API ───

export async function getOrCreateTaskState(sessionKey, taskId = null) {
  const effectiveTaskId = taskId || `task-${sessionKey}`;
  
  const cached = getCached(effectiveTaskId);
  if (cached) return cached;
  
  const db = await getDb();
  if (!db) {
    return createDefaultState(effectiveTaskId, sessionKey);
  }
  
  try {
    const row = db.prepare('SELECT * FROM task_states WHERE task_id = ?').get(effectiveTaskId);
    if (row) {
      const state = rowToState(row);
      setCache(effectiveTaskId, state);
      return state;
    }
    
    db.prepare(`
      INSERT INTO task_states (task_id, session_key) VALUES (?, ?)
    `).run(effectiveTaskId, sessionKey);
    
    const newRow = db.prepare('SELECT * FROM task_states WHERE task_id = ?').get(effectiveTaskId);
    const state = rowToState(newRow);
    setCache(effectiveTaskId, state);
    logger.info(`[${ts()}] [task-state] Created new task state: ${effectiveTaskId}`);
    return state;
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      const row = db.prepare('SELECT * FROM task_states WHERE task_id = ?').get(effectiveTaskId);
      if (row) {
        const state = rowToState(row);
        setCache(effectiveTaskId, state);
        return state;
      }
    }
    logger.error(`[${ts()}] [task-state] getOrCreate failed: ${err.message}`);
    return createDefaultState(effectiveTaskId, sessionKey);
  }
}

export async function updateTaskState(taskId, delta) {
  const db = await getDb();
  if (!db) {
    const cached = getCached(taskId);
    if (cached) {
      const merged = mergeState(cached, delta);
      setCache(taskId, merged);
    }
    return;
  }
  
  try {
    const row = db.prepare('SELECT * FROM task_states WHERE task_id = ?').get(taskId);
    if (!row) {
      logger.warn(`[${ts()}] [task-state] Task not found for update: ${taskId}`);
      return;
    }
    
    const current = rowToState(row);
    const merged = mergeState(current, delta);
    
    const updatableFields = [
      'user_goal', 'current_plan', 'current_step', 'open_questions',
      'constraints', 'artifacts', 'tool_observations', 'working_facts',
      'decisions', 'risks', 'done_criteria', 'last_model', 'handoff_summary', 'status'
    ];
    
    const sets = [];
    const values = [];
    for (const field of updatableFields) {
      if (field in delta || field in merged) {
        const val = merged[field];
        if (Array.isArray(val)) {
          sets.push(`${field} = ?`);
          values.push(JSON.stringify(val));
        } else {
          sets.push(`${field} = ?`);
          values.push(val);
        }
      }
    }
    
    if (sets.length === 0) return;
    
    sets.push('updated_at = ?');
    values.push(ts());
    values.push(taskId);
    
    db.prepare(`UPDATE task_states SET ${sets.join(', ')} WHERE task_id = ?`).run(...values);
    
    setCache(taskId, merged);
    
    logger.info(`[${ts()}] [task-state] Updated task ${taskId}: ${Object.keys(delta).join(', ')}`);
  } catch (err) {
    logger.error(`[${ts()}] [task-state] Update failed: ${err.message}`);
  }
}

export async function getTaskStateSnapshot(taskId) {
  const state = getCached(taskId);
  let s = state;
  if (!s) {
    const db = await getDb();
    if (!db) return null;
    const row = db.prepare('SELECT * FROM task_states WHERE task_id = ?').get(taskId);
    if (!row) return null;
    s = rowToState(row);
  }
  
  if (!s.user_goal && s.artifacts.length === 0 && s.decisions.length === 0) {
    return null;
  }
  
  const lines = ['[TASK_STATE]'];
  
  if (s.user_goal) {
    lines.push(`Goal: ${s.user_goal}`);
  }
  
  if (s.current_plan.length > 0) {
    const planSteps = s.current_plan.map((step, i) => {
      const marker = i < s.current_step ? '✓' : (i === s.current_step ? '→' : '○');
      return `  ${marker} ${typeof step === 'string' ? step : step.title || step.description || JSON.stringify(step)}`;
    });
    lines.push(`Plan:\n${planSteps.join('\n')}`);
  }
  
  if (s.constraints.length > 0) {
    lines.push(`Constraints: ${s.constraints.join('; ')}`);
  }
  
  if (s.working_facts.length > 0) {
    const recentFacts = s.working_facts.slice(-5);
    lines.push(`Key Facts: ${recentFacts.join('; ')}`);
  }
  
  if (s.decisions.length > 0) {
    const recentDecisions = s.decisions.slice(-3);
    lines.push(`Decisions: ${recentDecisions.join('; ')}`);
  }
  
  if (s.artifacts.length > 0) {
    const recentArtifacts = s.artifacts.slice(-3);
    lines.push(`Artifacts: ${recentArtifacts.join('; ')}`);
  }
  
  if (s.open_questions.length > 0) {
    lines.push(`Open Questions: ${s.open_questions.join('; ')}`);
  }
  
  if (s.risks.length > 0) {
    lines.push(`Risks: ${s.risks.join('; ')}`);
  }
  
  if (s.handoff_summary) {
    lines.push(`Previous Model Notes: ${s.handoff_summary}`);
  }
  
  lines.push('[/TASK_STATE]');
  
  return lines.join('\n');
}

export async function getActiveTaskState(sessionKey) {
  const db = await getDb();
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT * FROM task_states 
      WHERE session_key = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionKey);
    return row ? rowToState(row) : null;
  } catch (err) {
    logger.error(`[${ts()}] [task-state] getActiveTaskState failed: ${err.message}`);
    return null;
  }
}

export async function completeTask(taskId) {
  await updateTaskState(taskId, { status: 'completed' });
  _stateCache.delete(taskId);
  logger.info(`[${ts()}] [task-state] Task completed: ${taskId}`);
}

export function cleanupTaskStateResources() {
  if (_taskStateStatsTimer) {
    clearInterval(_taskStateStatsTimer);
    _taskStateStatsTimer = null;
  }
  _stateCache.dispose();
}
