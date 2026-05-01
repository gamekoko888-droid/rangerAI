/**
 * supervisor-scheduler.mjs — Cron-based Supervisor Task Scheduler
 * S13 P0: Checks autonomous_tasks with scheduleCron every minute,
 * triggers new supervisor task runs when cron expressions match.
 * 
 * Uses the existing autonomous_tasks table columns:
 *   - scheduleCron: cron expression (5-field: min hour dom month dow)
 *   - isRecurring: 1 for recurring, 0 for one-shot
 *   - lastRunAt: ISO timestamp of last execution
 *   - nextRunAt: ISO timestamp of next planned execution
 *   - status: 'scheduled' for active schedules
 * 
 * @version 1.1.0 — S14 P3: Skip running tasks, circuit breaker (3 consecutive failures auto-disable)
 */
import { logger } from '../lib/logger.mjs';
import { query, queryOne, run } from '../db-adapter.mjs';
import { sendCommand } from '../lib/redis-ipc.mjs';
import crypto from 'crypto';

const ts = () => new Date().toISOString();
const PREFIX = '[supervisor-scheduler]';

// ─── Cron Expression Parser ─────────────────────────────────
/**
 * Parse a 5-field cron expression and check if it matches a given Date.
 * Fields: minute hour day-of-month month day-of-week
 * Supports: *, specific numbers, ranges (1-5), steps (star/5), lists (1 3 5)
 */
function cronMatchesNow(cronExpr, now = new Date()) {
  if (!cronExpr || typeof cronExpr !== 'string') return false;
  
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  
  // Use first 5 fields only (ignore optional 6th field)
  const [minField, hourField, domField, monField, dowField] = parts;
  
  const minute = now.getMinutes();
  const hour = now.getHours();
  const dom = now.getDate();
  const month = now.getMonth() + 1; // 1-12
  const dow = now.getDay(); // 0=Sunday
  
  return (
    fieldMatches(minField, minute, 0, 59) &&
    fieldMatches(hourField, hour, 0, 23) &&
    fieldMatches(domField, dom, 1, 31) &&
    fieldMatches(monField, month, 1, 12) &&
    fieldMatches(dowField, dow, 0, 6)
  );
}

function fieldMatches(field, value, min, max) {
  if (field === '*') return true;
  
  // Handle lists: 1,3,5
  const parts = field.split(',');
  for (const part of parts) {
    // Handle step: */5 or 1-10/2
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      
      let rangeStart = min, rangeEnd = max;
      if (range !== '*') {
        if (range.includes('-')) {
          [rangeStart, rangeEnd] = range.split('-').map(Number);
        } else {
          rangeStart = parseInt(range, 10);
        }
      }
      
      for (let v = rangeStart; v <= rangeEnd; v += step) {
        if (v === value) return true;
      }
      continue;
    }
    
    // Handle range: 1-5
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (value >= start && value <= end) return true;
      continue;
    }
    
    // Handle exact number
    if (parseInt(part, 10) === value) return true;
  }
  
  return false;
}

/**
 * Calculate the next run time for a cron expression from a given base time.
 * Simple approach: check each minute for the next 48 hours.
 */
function getNextRunTime(cronExpr, fromTime = new Date()) {
  const check = new Date(fromTime);
  check.setSeconds(0, 0);
  check.setMinutes(check.getMinutes() + 1); // Start from next minute
  
  const maxIterations = 48 * 60; // 48 hours of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatchesNow(cronExpr, check)) {
      return check;
    }
    check.setMinutes(check.getMinutes() + 1);
  }
  return null; // No match found within 48 hours
}

function generateId(prefix = 'atask') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

// ─── Schema Migration ───────────────────────────────────────
/**
 * Ensure the supervisor_schedules table exists (dedicated schedule management).
 * Also add 'enabled' column to track schedule state independently.
 */
async function ensureScheduleSchema() {
  try {
    await run(`CREATE TABLE IF NOT EXISTS supervisor_schedules (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cronExpr TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      lastRunAt TEXT,
      lastRunTaskId TEXT,
      lastRunStatus TEXT,
      lastRunResult TEXT,
      nextRunAt TEXT,
      runCount INTEGER DEFAULT 0,
      consecutiveFailures INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updatedAt TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      createdBy TEXT DEFAULT 'system'
    )`);
    // S14 P3: Migration — add consecutiveFailures column if missing (v22.4 idempotent)
    const cols = await query(`PRAGMA table_info(supervisor_schedules)`);
    if (!cols.some(c => c.name === 'consecutiveFailures')) {
      await run(`ALTER TABLE supervisor_schedules ADD COLUMN consecutiveFailures INTEGER DEFAULT 0`);
      logger.info(`${PREFIX} Migration: added supervisor_schedules.consecutiveFailures`);
    }
    logger.info(`${PREFIX} Schedule schema initialized (v1.1)`);
  } catch (err) {
    if (!err.message?.includes('already exists')) {
      logger.error(`${PREFIX} Schema init failed: ${err.message}`);
    }
  }
}

// ─── Schedule Checker (runs every minute) ───────────────────
let _isChecking = false;

async function checkSchedules() {
  if (_isChecking) {
    logger.debug(`${PREFIX} Previous check still running, skipping`);
    return;
  }
  _isChecking = true;
  
  try {
    const now = new Date();
    
    // Query all enabled schedules
    const schedules = await query(
      `SELECT * FROM supervisor_schedules WHERE enabled = 1`
    );
    
    if (!schedules || schedules.length === 0) return;
    
    for (const schedule of schedules) {
      try {
        // Check if cron expression matches current minute
        if (!cronMatchesNow(schedule.cronExpr, now)) continue;
        
        // Prevent double-firing: check if lastRunAt is within the same minute
        if (schedule.lastRunAt) {
          const lastRun = new Date(schedule.lastRunAt);
          const diffMs = now.getTime() - lastRun.getTime();
          if (diffMs < 55000) { // Less than 55 seconds ago = same minute
            logger.debug(`${PREFIX} Schedule ${schedule.id} already ran this minute, skipping`);
            continue;
          }
        }
        
        // S14 P3: Skip if same scheduleId has a running task
        try {
          const runningTask = await queryOne(
            `SELECT id FROM autonomous_tasks WHERE status IN ('running', 'queued') AND json_extract(metadata, '$.scheduleId') = ? LIMIT 1`,
            [schedule.id]
          );
          if (runningTask) {
            logger.warn(`${PREFIX} Schedule ${schedule.id} skipped: previous task ${runningTask.id} still running`);
            // Update nextRunAt without incrementing runCount
            const nextRun = getNextRunTime(schedule.cronExpr, now);
            await run(
              `UPDATE supervisor_schedules SET nextRunAt = ?, updatedAt = ? WHERE id = ?`,
              [nextRun?.toISOString() || null, now.toISOString(), schedule.id]
            );
            continue;
          }
        } catch (skipErr) {
          logger.warn(`${PREFIX} Skip-check error (non-fatal): ${skipErr.message}`);
        }
        
        logger.info(`${PREFIX} Triggering schedule: ${schedule.id} "${schedule.title}" (cron: ${schedule.cronExpr})`);
        
        // Create a new autonomous task for this scheduled run
        const taskId = generateId('atask');
        const taskTitle = `[定时] ${schedule.title}`;
        const taskDesc = schedule.prompt;
        
        await run(
          `INSERT INTO autonomous_tasks (id, userId, type, title, description, status, priority, metadata)
           VALUES (?, 'system', 'scheduled', ?, ?, 'queued', 5, ?)`,
          [taskId, taskTitle, taskDesc, JSON.stringify({ scheduleId: schedule.id, scheduleCron: schedule.cronExpr })]
        );
        
        // Send to worker via Redis IPC
        try {
          await sendCommand({
            type: 'submit_autonomous_task',
            taskId,
            userId: 'system',
            title: taskTitle,
            description: taskDesc,
            taskType: 'scheduled',
            priority: 5,
          });
          logger.info(`${PREFIX} Schedule ${schedule.id}: task ${taskId} submitted to worker`);
        } catch (ipcErr) {
          logger.warn(`${PREFIX} Schedule ${schedule.id}: IPC send failed: ${ipcErr.message}`);
        }
        
        // Update schedule metadata
        const nextRun = getNextRunTime(schedule.cronExpr, now);
        await run(
          `UPDATE supervisor_schedules SET 
            lastRunAt = ?, lastRunTaskId = ?, lastRunStatus = 'running',
            nextRunAt = ?, runCount = runCount + 1, updatedAt = ?
           WHERE id = ?`,
          [now.toISOString(), taskId, nextRun?.toISOString() || null, now.toISOString(), schedule.id]
        );
        
      } catch (schedErr) {
        logger.error(`${PREFIX} Error processing schedule ${schedule.id}: ${schedErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`${PREFIX} checkSchedules error: ${err.message}`);
  } finally {
    _isChecking = false;
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Start the schedule checker (called from background-jobs.mjs)
 */
export async function startScheduleChecker() {
  await ensureScheduleSchema();
  
  // Calculate initial nextRunAt for all schedules that don't have one
  try {
    const noNext = await query(`SELECT * FROM supervisor_schedules WHERE enabled = 1 AND (nextRunAt IS NULL OR nextRunAt = '')`);
    for (const s of noNext) {
      const next = getNextRunTime(s.cronExpr);
      if (next) {
        await run(`UPDATE supervisor_schedules SET nextRunAt = ? WHERE id = ?`, [next.toISOString(), s.id]);
      }
    }
  } catch (e) {
    logger.warn(`${PREFIX} Initial nextRunAt calculation failed: ${e.message}`);
  }
  
  // Run check every 60 seconds
  const _schedulerTimer = setInterval(checkSchedules, 60000);
  logger.info(`${PREFIX} Schedule checker started (60s interval)`);
  
  // Also run immediately on startup
  setTimeout(checkSchedules, 5000);
}

/**
 * List all schedules
 */
export async function listSchedules() {
  return await query(`SELECT * FROM supervisor_schedules ORDER BY createdAt DESC`);
}

/**
 * Create a new schedule
 */
export async function createSchedule({ title, prompt, cronExpr, createdBy = 'system' }) {
  const id = `sched_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const nextRun = getNextRunTime(cronExpr);
  
  await run(
    `INSERT INTO supervisor_schedules (id, title, prompt, cronExpr, enabled, nextRunAt, createdBy)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [id, title, prompt, cronExpr, nextRun?.toISOString() || null, createdBy]
  );
  
  logger.info(`${PREFIX} Created schedule ${id}: "${title}" (cron: ${cronExpr})`);
  return { id, nextRunAt: nextRun?.toISOString() || null };
}

/**
 * Toggle schedule enabled/disabled
 */
export async function toggleSchedule(id, enabled) {
  await run(
    `UPDATE supervisor_schedules SET enabled = ?, updatedAt = ? WHERE id = ?`,
    [enabled ? 1 : 0, new Date().toISOString(), id]
  );
  
  if (enabled) {
    // Recalculate nextRunAt
    const schedule = await queryOne(`SELECT cronExpr FROM supervisor_schedules WHERE id = ?`, [id]);
    if (schedule) {
      const next = getNextRunTime(schedule.cronExpr);
      if (next) {
        await run(`UPDATE supervisor_schedules SET nextRunAt = ? WHERE id = ?`, [next.toISOString(), id]);
      }
    }
  }
  
  logger.info(`${PREFIX} Schedule ${id} ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Delete a schedule
 */
export async function deleteSchedule(id) {
  await run(`DELETE FROM supervisor_schedules WHERE id = ?`, [id]);
  logger.info(`${PREFIX} Schedule ${id} deleted`);
}

/**
 * Update last run result (called when task completes)
 * S14 P3: Track consecutive failures for circuit breaker
 */
export async function updateScheduleResult(scheduleId, status, result) {
  const isFailure = status === 'failed' || status === 'timeout';
  
  if (isFailure) {
    // Increment consecutive failures
    await run(
      `UPDATE supervisor_schedules SET lastRunStatus = ?, lastRunResult = ?, consecutiveFailures = COALESCE(consecutiveFailures, 0) + 1, updatedAt = ? WHERE id = ?`,
      [status, (result || '').substring(0, 500), new Date().toISOString(), scheduleId]
    );
    
    // S14 P3: Circuit breaker — auto-disable after 3 consecutive failures
    const schedule = await queryOne('SELECT consecutiveFailures, title, enabled FROM supervisor_schedules WHERE id = ?', [scheduleId]);
    if (schedule && schedule.consecutiveFailures >= 3 && schedule.enabled) {
      await run(
        `UPDATE supervisor_schedules SET enabled = 0, updatedAt = ? WHERE id = ?`,
        [new Date().toISOString(), scheduleId]
      );
      logger.warn(`${PREFIX} CIRCUIT BREAKER: Schedule ${scheduleId} "${schedule.title}" auto-disabled after ${schedule.consecutiveFailures} consecutive failures`);
      
      // Return circuit breaker info for alert
      return { circuitBreaker: true, title: schedule.title, consecutiveFailures: schedule.consecutiveFailures };
    }
  } else {
    // Reset consecutive failures on success
    await run(
      `UPDATE supervisor_schedules SET lastRunStatus = ?, lastRunResult = ?, consecutiveFailures = 0, updatedAt = ? WHERE id = ?`,
      [status, (result || '').substring(0, 500), new Date().toISOString(), scheduleId]
    );
  }
  return null;
}

// Export cron utilities for testing
export { cronMatchesNow, getNextRunTime };
