/**
 * RangerAI Content Service — Domain: Quick Prompts, AI Roles
 * Phase 2 of architecture decoupling: Service layer extracted from database.mjs
 */
import { logger } from '../lib/logger.mjs';
import { query, queryOne, run, isMySQL } from '../db-adapter.mjs';

// ─── Helpers ────────────────────────────────────────────────
function now() { return isMySQL() ? 'NOW()' : "datetime('now')"; }

// ─── Quick Prompts ──────────────────────────────────────────
export async function getQuickPrompts() {
  try {
    return await query('SELECT * FROM quick_prompts WHERE isActive = 1 ORDER BY sortOrder ASC, createdAt DESC');
  } catch (e) {
    logger.error('[content-service] getQuickPrompts error:', e.message);
    return [];
  }
}

export async function incrementPromptUsage(promptId) {
  try {
    const result = await run('UPDATE quick_prompts SET useCount = useCount + 1 WHERE id = ?', [promptId]);
    if (result.changes === 0) return null;
    return await queryOne('SELECT id, useCount FROM quick_prompts WHERE id = ?', [promptId]);
  } catch (e) {
    logger.error('[content-service] incrementPromptUsage error:', e.message);
    return null;
  }
}

export async function createPrompt(id, title, content, category, sortOrder = 0) {
  try {
    await run(
      'INSERT INTO quick_prompts (id, title, content, category, sortOrder, isActive, usageCount) VALUES (?, ?, ?, ?, ?, 1, 0)',
      [id, title, content, category || null, sortOrder]
    );
    return await queryOne('SELECT * FROM quick_prompts WHERE id = ?', [id]);
  } catch (e) {
    logger.error('[content-service] createPrompt error:', e.message);
    return null;
  }
}

export async function updatePrompt(id, fields) {
  try {
    const allowed = ['title', 'content', 'category', 'sortOrder', 'isActive'];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
    }
    if (sets.length === 0) return null;
    vals.push(id);
    const result = await run(`UPDATE quick_prompts SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (result.changes === 0) return null;
    return await queryOne('SELECT * FROM quick_prompts WHERE id = ?', [id]);
  } catch (e) {
    logger.error('[content-service] updatePrompt error:', e.message);
    return null;
  }
}

export async function deletePrompt(id) {
  try {
    const result = await run('DELETE FROM quick_prompts WHERE id = ?', [id]);
    return result.changes > 0;
  } catch (e) {
    logger.error('[content-service] deletePrompt error:', e.message);
    return false;
  }
}

export async function getAllPrompts() {
  try {
    return await query('SELECT * FROM quick_prompts ORDER BY sortOrder ASC, createdAt DESC');
  } catch (e) {
    logger.error('[content-service] getAllPrompts error:', e.message);
    return [];
  }
}

// ─── AI Roles ───────────────────────────────────────────────
export async function getRoleById(roleId) {
  return await queryOne('SELECT * FROM ai_roles WHERE id = ?', [roleId]);
}

export async function getAllRoles() {
  return await query('SELECT * FROM ai_roles WHERE isActive = 1 ORDER BY name');
}

export async function getAiRoles() {
  return await query('SELECT * FROM ai_roles ORDER BY sortOrder, name');
}

export async function getAiRole(id) {
  return await queryOne('SELECT * FROM ai_roles WHERE id = ?', [id]);
}

export async function createAiRole(id, name, description, systemPrompt, icon, color, category, createdBy) {
  return await run(
    'INSERT INTO ai_roles (id, name, description, systemPrompt, icon, color, category, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, description, systemPrompt, icon, color, category, createdBy]
  );
}

export async function updateAiRole(id, updates) {
  const fields = ['name', 'description', 'systemPrompt', 'icon', 'color', 'category', 'isActive', 'sortOrder'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (updates[f] !== undefined) { sets.push(f + ' = ?'); vals.push(updates[f]); }
  }
  if (sets.length === 0) return;
  sets.push(`updatedAt = ${now()}`);
  vals.push(id);
  return await run('UPDATE ai_roles SET ' + sets.join(', ') + ' WHERE id = ?', vals);
}

export async function deleteAiRole(id) {
  return await run('DELETE FROM ai_roles WHERE id = ?', [id]);
}
