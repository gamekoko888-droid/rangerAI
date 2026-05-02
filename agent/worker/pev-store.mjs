const pev = new Map();
export function upsertPEV(taskId, patch){ const prev=pev.get(taskId)||{ taskId, phase:'plan', updatedAt:Date.now() }; const next={ ...prev, ...patch, updatedAt:Date.now() }; pev.set(taskId,next); return next; }
export function getPEV(taskId){ return pev.get(taskId) || null; }
