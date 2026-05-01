// Stateless task state data model helpers extracted from task-engine.mjs (R98)

const ts = () => new Date().toISOString();

function parseJsonField(val, fallback = []) {
  if (!val || val === 'null') return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

export function rowToState(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    session_key: row.session_key,
    user_goal: row.user_goal || '',
    current_plan: parseJsonField(row.current_plan, []),
    current_step: row.current_step || 0,
    open_questions: parseJsonField(row.open_questions, []),
    constraints: parseJsonField(row.constraints, []),
    artifacts: parseJsonField(row.artifacts, []),
    tool_observations: parseJsonField(row.tool_observations, []),
    working_facts: parseJsonField(row.working_facts, []),
    decisions: parseJsonField(row.decisions, []),
    risks: parseJsonField(row.risks, []),
    done_criteria: parseJsonField(row.done_criteria, []),
    last_model: row.last_model || null,
    handoff_summary: row.handoff_summary || null,
    status: row.status || 'active',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}


export function createDefaultState(taskId, sessionKey) {
  return {
    id: null,
    task_id: taskId,
    session_key: sessionKey,
    user_goal: '',
    current_plan: [],
    current_step: 0,
    open_questions: [],
    constraints: [],
    artifacts: [],
    tool_observations: [],
    working_facts: [],
    decisions: [],
    risks: [],
    done_criteria: [],
    last_model: null,
    handoff_summary: null,
    status: 'active',
    created_at: ts(),
    updated_at: ts(),
  };
}

export function mergeState(current, delta) {
  const merged = { ...current };
  
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'id' || key === 'task_id' || key === 'session_key' || key === 'created_at') {
      continue; // Don't overwrite immutable fields
    }
    
    if (Array.isArray(current[key]) && Array.isArray(value)) {
      // Merge arrays: append new items, deduplicate
      const existing = new Set(current[key].map(v => typeof v === 'string' ? v : JSON.stringify(v)));
      const newItems = value.filter(v => {
        const str = typeof v === 'string' ? v : JSON.stringify(v);
        return !existing.has(str);
      });
      merged[key] = [...current[key], ...newItems];
      
      // Cap array sizes to prevent unbounded growth
      const MAX_ITEMS = {
        tool_observations: 20,
        working_facts: 30,
        artifacts: 50,
        decisions: 20,
        risks: 10,
        open_questions: 10,
        constraints: 10,
        done_criteria: 10,
        current_plan: 20,
      };
      const max = MAX_ITEMS[key] || 50;
      if (merged[key].length > max) {
        merged[key] = merged[key].slice(-max);
      }
    } else {
      // Scalar: overwrite
      merged[key] = value;
    }
  }
  
  merged.updated_at = ts();
  return merged;
}
