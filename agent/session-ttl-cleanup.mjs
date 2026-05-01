/**
 * session-ttl-cleanup.mjs — F20: Session TTL 自动清理
 * v2.0.0 — Migrated from direct better-sqlite3 to db-adapter (Iter-55 P0-1)
 *
 * 功能：
 * 1. 定期扫描 OpenClaw Gateway session 文件
 * 2. 根据 system_config 表配置的 TTL 清理过期文件
 * 3. 非阻塞：异步执行，不影响主流程
 * 4. 可审计：每次清理记录到日志
 */
import { readdirSync, statSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { queryOne, run } from './db-adapter.mjs';

import { logger } from './lib/logger.mjs';
const SESSIONS_DIR = '/home/admin/.openclaw/agents/main/sessions';

// Defaults
const DEFAULT_TTL_HOURS = 72;       // 3 days
const DEFAULT_ARCHIVE_TTL_HOURS = 24; // 1 day for .deleted/.reset files
const MIN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let _lastCleanupTime = 0;
let _cleanupStats = { total: 0, cleaned: 0, archived: 0, errors: 0, lastRun: null };

/**
 * Get TTL config from system_config table
 */
async function getConfig() {
  try {
    const ttlRow = await queryOne(
      "SELECT value FROM system_config WHERE key = 'session_ttl_hours'"
    );
    const archiveTtlRow = await queryOne(
      "SELECT value FROM system_config WHERE key = 'session_archive_ttl_hours'"
    );
    return {
      ttlHours: ttlRow ? parseInt(ttlRow.value) : DEFAULT_TTL_HOURS,
      archiveTtlHours: archiveTtlRow ? parseInt(archiveTtlRow.value) : DEFAULT_ARCHIVE_TTL_HOURS,
    };
  } catch (e) {
    return { ttlHours: DEFAULT_TTL_HOURS, archiveTtlHours: DEFAULT_ARCHIVE_TTL_HOURS };
  }
}

/**
 * Run session cleanup
 * @returns {Promise<{ cleaned: number, archived: number, errors: number, total: number }>}
 */
export async function cleanupSessions() {
  const now = Date.now();
  const config = await getConfig();
  const ttlMs = config.ttlHours * 60 * 60 * 1000;
  const archiveTtlMs = config.archiveTtlHours * 60 * 60 * 1000;
  
  let total = 0, cleaned = 0, archived = 0, errors = 0;
  
  try {
    const files = readdirSync(SESSIONS_DIR);
    total = files.length;
    
    for (const file of files) {
      try {
        const filePath = join(SESSIONS_DIR, file);
        const stat = statSync(filePath);
        
        if (!stat.isFile()) continue;
        
        const age = now - stat.mtimeMs;
        
        // Case 1: .deleted or .reset files — shorter TTL
        if (file.includes('.deleted.') || file.includes('.reset.')) {
          if (age > archiveTtlMs) {
            unlinkSync(filePath);
            archived++;
            logger.info(`[session-ttl] Removed archived session: ${file} (age: ${Math.round(age / 3600000)}h)`);
          }
          continue;
        }
        
        // Case 2: Active .jsonl files — standard TTL
        if (file.endsWith('.jsonl')) {
          if (age > ttlMs) {
            // Rename to .deleted instead of hard delete (safety)
            const deletedPath = `${filePath}.deleted.${new Date().toISOString().replace(/[:.]/g, '-')}`;
            renameSync(filePath, deletedPath);
            cleaned++;
            logger.info(`[session-ttl] Archived expired session: ${file} (age: ${Math.round(age / 3600000)}h)`);
          }
        }
      } catch (fileErr) {
        errors++;
        logger.error(`[session-ttl] Error processing ${file}:`, fileErr.message);
      }
    }
  } catch (dirErr) {
    logger.error(`[session-ttl] Cannot read sessions dir:`, dirErr.message);
    errors++;
  }
  
  _cleanupStats = { total, cleaned, archived, errors, lastRun: new Date().toISOString() };
  _lastCleanupTime = now;
  
  logger.info(`[session-ttl] Cleanup complete: ${total} files scanned, ${cleaned} expired, ${archived} archived removed, ${errors} errors`);
  
  // Log to DB via db-adapter
  try {
    await run(`
      INSERT INTO audit_logs (action, details, createdAt)
      VALUES ('session_cleanup', ?, datetime('now'))
    `, [JSON.stringify(_cleanupStats)]);
  } catch (e) {
    logger.error('[session-ttl] Failed to log cleanup:', e.message);
  }
  
  return _cleanupStats;
}

/**
 * Periodic cleanup — call this from a setInterval
 * Only runs if enough time has passed since last cleanup
 */
export async function maybeCleanup() {
  const now = Date.now();
  if (now - _lastCleanupTime < MIN_CLEANUP_INTERVAL_MS) return null;
  return cleanupSessions();
}

/**
 * Get cleanup stats
 */
export function getCleanupStats() {
  return { ..._cleanupStats };
}

/**
 * Start periodic cleanup timer
 * @param {number} intervalMs - Cleanup interval in ms (default: 1 hour)
 * @returns {NodeJS.Timer}
 */
export function startPeriodicCleanup(intervalMs = 60 * 60 * 1000) {
  logger.info(`[session-ttl] Starting periodic cleanup every ${Math.round(intervalMs / 60000)} minutes`);
  
  // Run immediately on start
  setTimeout(async () => {
    try { await cleanupSessions(); } catch (e) { logger.error('[session-ttl] Initial cleanup failed:', e.message); }
  }, 5000);
  
  // Then run periodically
  return setInterval(async () => {
    try { await cleanupSessions(); } catch (e) { logger.error('[session-ttl] Periodic cleanup failed:', e.message); }
  }, intervalMs);
}
