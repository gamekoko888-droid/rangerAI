
// [R19-T1] Hint adoption tracking — lazy require to avoid native handle at module load (fixes test timeouts)
import { logger } from '../lib/logger.mjs';
import { createRequire } from 'node:module';
import { resolve } from "path";
const _require = createRequire(import.meta.url);
let _hintDb = null;
export function getHintDb() {
  if (!_hintDb) {
    const dbPath = process.env.RANGERAI_WORKER_DB || resolve("/opt/rangerai-agent/db/rangerai.db");
    _hintDb = new (_require("better-sqlite3"))(dbPath);
    _hintDb.pragma("journal_mode = WAL");
  }
  return _hintDb;
}

export function recordHintAdoption({ taskId, sessionKey, taskType, hintText, suggestedTools }) {
  try {
    const db = getHintDb();
    db.prepare(`
      INSERT INTO hint_adoptions (task_id, session_key, task_type, hint_text, suggested_tools, created_at, is_seed)
      VALUES (?, ?, ?, ?, ?, datetime('now'), 0)
    `).run(taskId, sessionKey, taskType, hintText, JSON.stringify(suggestedTools));
    logger.info(`[${ts()}] [R19-T1] hint adoption recorded: task=${taskId} type=${taskType} suggestedTools=${suggestedTools.join(',')}`);
  } catch (err) {
    logger.warn(`[${ts()}] [R19-T1] recordHintAdoption failed (non-fatal): ${err.message}`);
  }
}

export function updateHintAdoptionActualTools(taskId, actualTools) {
  try {
    const db = getHintDb();
    // Get the latest hint adoption for this task
    const row = db.prepare(`SELECT id, suggested_tools FROM hint_adoptions WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId);
    if (!row) return;
    const suggested = JSON.parse(row.suggested_tools || '[]');
    const actual = actualTools || [];
    // adopted = intersection of suggested and actual tools >= 1
    const adopted = suggested.some(s => actual.includes(s)) ? 1 : 0;
    db.prepare(`UPDATE hint_adoptions SET actual_tools = ?, adopted = ? WHERE id = ?`).run(JSON.stringify(actual), adopted, row.id);
    logger.info(`[${ts()}] [R19-T1] hint adoption updated: task=${taskId} adopted=${adopted} suggested=${suggested.join(',')} actual=${actual.join(',')}`);
  } catch (err) {
    logger.warn(`[${ts()}] [R19-T1] updateHintAdoptionActualTools failed (non-fatal): ${err.message}`);
  }
}

export function getHintAdoptionStats() {
    const db = getHintDb();
    const total = db.prepare("SELECT COUNT(*) as cnt FROM hint_adoptions WHERE actual_tools IS NOT NULL").get()?.cnt || 0;
    const adopted = db.prepare("SELECT COUNT(*) as cnt FROM hint_adoptions WHERE adopted = 1").get()?.cnt || 0;
    const realTotal = db.prepare("SELECT COUNT(*) as cnt FROM hint_adoptions WHERE actual_tools IS NOT NULL AND is_seed = 0").get()?.cnt || 0;
    const realAdopted = db.prepare("SELECT COUNT(*) as cnt FROM hint_adoptions WHERE adopted = 1 AND is_seed = 0").get()?.cnt || 0;
    const seedTotal = db.prepare("SELECT COUNT(*) as cnt FROM hint_adoptions WHERE actual_tools IS NOT NULL AND is_seed = 1").get()?.cnt || 0;
    const seedAdopted = db.prepare("SELECT COUNT(*) as cnt FROM hint_adoptions WHERE adopted = 1 AND is_seed = 1").get()?.cnt || 0;
    const byType = db.prepare("SELECT task_type, COUNT(*) as total, SUM(CASE WHEN adopted = 1 THEN 1 ELSE 0 END) as adopted_count FROM hint_adoptions WHERE actual_tools IS NOT NULL GROUP BY task_type").all();
    const recent = db.prepare("SELECT task_type, suggested_tools, actual_tools, adopted, created_at, is_seed FROM hint_adoptions ORDER BY id DESC LIMIT 20").all();
    return {
      total, adopted,
      adoptionRate: total > 0 ? Math.round(adopted / total * 1000) / 10 : 0,
      realTotal, realAdopted,
      realAdoptionRate: realTotal > 0 ? Math.round(realAdopted / realTotal * 1000) / 10 : 0,
      seedTotal, seedAdopted,
      seedAdoptionRate: seedTotal > 0 ? Math.round(seedAdopted / seedTotal * 1000) / 10 : 0,
      byType, recent
    };
}
