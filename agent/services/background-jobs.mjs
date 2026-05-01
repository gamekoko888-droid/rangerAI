/**
 * background-jobs.mjs — Background maintenance tasks and monitoring
 * v25.9: Supervisor code completely removed
 * v25.11 (TD-042): Added autonomous task queue poller
 */
import { execSync as _execSync } from "child_process";
import { init as initScheduler, startScheduler } from "../workflow-scheduler.mjs";
import { buildSchedulerDeps } from "../lib/context.mjs";
import { query, queryOne, run } from "../db-adapter.mjs";
import { sendRequest } from "../lib/redis-ipc.mjs";
import crypto from "crypto";

// Timer handles for graceful shutdown cleanup
let _bgTaskStoreTimer = null;
let _bgGatewayMonitorTimer = null;
let _taskPollerTimer = null;

export async function startBackgroundJobs(ctx) {
  const { logger, taskStore, config, runtime } = ctx;
  const ts = () => new Date().toISOString();
  logger.info(`[${ts()}] Initializing background jobs...`);

  // 1. TaskStore Periodic Cleanup
  if (taskStore && taskStore.cleanupStaleTasks) {
    logger.info(`[${ts()}] Background: TaskStore cleanup scheduled (5m)`);
    _bgTaskStoreTimer = setInterval(() => {
      taskStore.cleanupStaleTasks().catch(e => {
        logger.info(`[${ts()}] TaskStore cleanup error: ${e.message}`);
      });
    }, 300000);
  } else {
    logger.warn(`[${ts()}] Redis TaskStore UNAVAILABLE — cleanup job skipped`);
  }

  // 2. Workflow Scheduler
  try {
    initScheduler(buildSchedulerDeps(ctx));
    startScheduler();
    logger.info(`[${ts()}] Background: Workflow scheduler started`);
  } catch (schedErr) {
    logger.warn(`[${ts()}] Workflow scheduler failed to start (non-fatal): ${schedErr.message}`);
  }

  // 3. Gateway Memory Monitor (rss guard)
  const GATEWAY_MEMORY_CHECK_INTERVAL = config.GATEWAY_MEMORY_CHECK_INTERVAL || 300000;
  const GATEWAY_MEMORY_LIMIT_MB = config.GATEWAY_MEMORY_LIMIT_MB || 2048;
  const ENABLE_GATEWAY_MONITOR = config.ENABLE_GATEWAY_MONITOR === "true"; 
  
  let _gatewayRestartCooldown = 0;
  if (ENABLE_GATEWAY_MONITOR) {
    logger.info(`[${ts()}] Background: Gateway memory monitor active (limit: ${GATEWAY_MEMORY_LIMIT_MB}MB)`);
    _bgGatewayMonitorTimer = setInterval(() => {
      try {
        const psOutput = _execSync(
          "ps -o pid,rss,comm -C openclaw-gateway --no-headers 2>/dev/null || echo ''",
          { timeout: 5000, encoding: "utf-8" }
        ).trim();
        if (!psOutput) return;
        const parts = psOutput.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const rssKB = parseInt(parts[1], 10);
        const rssMB = Math.round(rssKB / 1024);
        if (rssMB > GATEWAY_MEMORY_LIMIT_MB) {
          const now = Date.now();
          if (now - _gatewayRestartCooldown < 600000) {
            logger.warn(`[${ts()}] [gateway-monitor] RSS=${rssMB}MB > limit but cooldown active, skipping`);
            return;
          }
          _gatewayRestartCooldown = now;
          logger.warn(`[${ts()}] [gateway-monitor] Gateway RSS=${rssMB}MB exceeds limit — sending SIGTERM`);
          try {
            _execSync(`kill -TERM ${pid} 2>/dev/null || true`, { timeout: 3000 });
          } catch (killErr) {
            logger.error(`[${ts()}] [gateway-monitor] Failed to restart gateway: ${killErr.message}`);
          }
        } else if (rssMB > 1500) {
          logger.info(`[${ts()}] [gateway-monitor] Gateway RSS=${rssMB}MB (warning)`);
        }
      } catch (monErr) {
        if (!monErr.message.includes("TIMEOUT")) {
          logger.debug(`[${ts()}] [gateway-monitor] Check failed: ${monErr.message}`);
        }
      }
    }, GATEWAY_MEMORY_CHECK_INTERVAL);
  } else {
    logger.info(`[${ts()}] Background: Gateway memory monitor is DISABLED`);
  }

  // 4. Autonomous Task Queue Poller (TD-042)
  // Polls SQLite for queued tasks and dispatches them via Redis IPC to ws-realtime
  const TASK_POLL_INTERVAL = 30000; // 30 seconds
  const MAX_CONCURRENT_AUTO_TASKS = 1; // Conservative: one autonomous task at a time
  let _taskPollerRunning = false;

  async function pollTaskQueue() {
    if (_taskPollerRunning) return; // Prevent overlapping polls
    _taskPollerRunning = true;
    try {
      // Check how many tasks are currently running
      const runningCount = await queryOne(
        `SELECT COUNT(*) as cnt FROM autonomous_tasks WHERE status = 'running'`
      );
      if ((runningCount?.cnt || 0) >= MAX_CONCURRENT_AUTO_TASKS) {
        return; // Slot full, wait for next poll
      }

      // Fetch oldest queued task (FIFO, respect priority)
      const task = await queryOne(
        `SELECT * FROM autonomous_tasks WHERE status = 'queued' ORDER BY priority ASC, createdAt ASC LIMIT 1`
      );
      if (!task) return; // No queued tasks

      logger.info(`[${ts()}] [task-poller] Picking up task ${task.id}: "${task.title}"`);

      // Mark as running immediately to prevent double-pick
      await run(
        `UPDATE autonomous_tasks SET status = 'running', startedAt = datetime('now'), currentStep = '正在初始化...' WHERE id = ? AND status = 'queued'`,
        [task.id]
      );

      // Build a unique session key for this autonomous task
      const sessionKey = `auto_${task.id}_${crypto.randomBytes(4).toString("hex")}`;
      const msgId = `amsg_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;

      // Build the task prompt
      const taskPrompt = task.description
        ? `[自主任务] ${task.title}\n\n${task.description}`
        : `[自主任务] ${task.title}`;

      // Dispatch via Redis IPC to ws-realtime (which has workerManager)
      try {
        const result = await sendRequest({
          type: "dispatch_task",
          payload: {
            msgId,
            sessionKey,
            content: taskPrompt,
            history: [],
            userId: task.userId || "system",
          }
        }, 660000); // 11 min timeout

        // Task completed via IPC
        const replyText = result?.reply || "Task completed (no output)";
        await run(
          `UPDATE autonomous_tasks SET 
            status = 'completed', 
            result = ?, 
            completedAt = datetime('now'),
            duration = CAST((julianday('now') - julianday(startedAt)) * 86400 AS INTEGER),
            progress = 100,
            currentStep = '已完成'
           WHERE id = ?`,
          [typeof replyText === "string" ? replyText : JSON.stringify(replyText), task.id]
        );
        logger.info(`[${ts()}] [task-poller] Task ${task.id} completed successfully`);
      } catch (execErr) {
        // Task failed
        logger.error(`[${ts()}] [task-poller] Task ${task.id} failed: ${execErr.message}`);
        await run(
          `UPDATE autonomous_tasks SET 
            status = 'failed', 
            error = ?, 
            completedAt = datetime('now'),
            duration = CAST((julianday('now') - julianday(COALESCE(startedAt, createdAt))) * 86400 AS INTEGER),
            currentStep = '执行失败'
           WHERE id = ?`,
          [execErr.message, task.id]
        );
      }
    } catch (pollErr) {
      logger.debug(`[${ts()}] [task-poller] Poll error: ${pollErr.message}`);
    } finally {
      _taskPollerRunning = false;
    }
  }

  // Also recover stale "running" tasks on startup (stuck from previous crash)
  try {
    const staleCount = await run(
      `UPDATE autonomous_tasks SET status = 'queued', currentStep = '重新排队（系统重启）' 
       WHERE status = 'running' AND startedAt < datetime('now', '-15 minutes')`
    );
    if (staleCount?.changes > 0) {
      logger.info(`[${ts()}] [task-poller] Recovered ${staleCount.changes} stale running tasks back to queued`);
    }
  } catch (recoverErr) {
    logger.debug(`[${ts()}] [task-poller] Stale task recovery failed: ${recoverErr.message}`);
  }

  // Start polling
  _taskPollerTimer = setInterval(pollTaskQueue, TASK_POLL_INTERVAL);
  // Run first poll after a short delay (let services stabilize)
  setTimeout(pollTaskQueue, 10000);
  logger.info(`[${ts()}] Background: Autonomous task poller started (interval: ${TASK_POLL_INTERVAL / 1000}s)`);
}

/**
 * Stop all background job timers.
 * Call during graceful shutdown.
 */
export function stopBackgroundJobs() {
  if (_bgTaskStoreTimer) { clearInterval(_bgTaskStoreTimer); _bgTaskStoreTimer = null; }
  if (_bgGatewayMonitorTimer) { clearInterval(_bgGatewayMonitorTimer); _bgGatewayMonitorTimer = null; }
  if (_taskPollerTimer) { clearInterval(_taskPollerTimer); _taskPollerTimer = null; }
}
