/**
 * lib/signals.mjs — Process signal handlers
 *
 * Extracted from server.mjs (Iter-6.2).
 * Registers: SIGUSR2, SIGTERM, SIGINT, uncaughtException, unhandledRejection
 *
 * v3.5: Added graceful drain on SIGTERM — waits for active worker tasks to complete
 *       before shutting down (up to 25 seconds).
 */
import { logger } from '../lib/logger.mjs';

async function cleanupGracefulResources({ ctx, wsHeartbeatInterval, ts }) {
  // Worker-side TTLMap/timer disposal is triggered by the drain message before exit.
  try { await ctx.services.redisPool.shutdown(); } catch (e) { logger.warn(`[${ts()}] redisPool cleanup failed: ${e.message}`); }
  try { await ctx.db.closeDatabase(); } catch (e) { logger.warn(`[${ts()}] db cleanup failed: ${e.message}`); }
  clearInterval(wsHeartbeatInterval);
}

/**
 * Register all process signal/error handlers.
 * @param {{ ctx, workerManager, wsHeartbeatInterval, server, ts }} opts
 */
export function registerSignalHandlers({ ctx, workerManager, wsHeartbeatInterval, server, ts }) {
  process.on("SIGUSR2", () => {
    logger.info(`[${ts()}] Received SIGUSR2, restarting worker...`);
    workerManager.restartWorker();
  });
  process.on("SIGTERM", async () => {
    logger.info(`[${ts()}] Received SIGTERM, shutting down gracefully...`);

    // ─── Phase 1: Drain — wait for active worker tasks to finish ───
    const DRAIN_TIMEOUT_MS = 25000; // max 25s to wait for tasks
    const drainStart = Date.now();

    // Tell worker to enter drain mode (finish current task, reject new ones)
    if (workerManager && workerManager.worker) {
      try {
        workerManager.worker.send({ type: "drain" });
        logger.info(`[${ts()}] Sent drain signal to worker`);
      } catch (e) {
        logger.info(`[${ts()}] Could not send drain to worker: ${e.message}`);
      }

      // Wait for worker to exit (it will exit after finishing current task)
      await new Promise((resolve) => {
        const onExit = () => {
          logger.info(`[${ts()}] Worker exited during drain after ${Date.now() - drainStart}ms`);
          clearTimeout(forceTimer);
          resolve();
        };
        workerManager.worker.once('exit', onExit);

        const forceTimer = setTimeout(() => {
          logger.info(`[${ts()}] Drain timeout after ${DRAIN_TIMEOUT_MS}ms, forcing shutdown`);
          workerManager.worker.removeListener('exit', onExit);
          resolve();
        }, DRAIN_TIMEOUT_MS);
      });
    } else {
      logger.info(`[${ts()}] No worker to drain, proceeding with shutdown`);
    }

    // ─── Phase 2: Cleanup resources ───
    await cleanupGracefulResources({ ctx, wsHeartbeatInterval, ts });

    // ─── Phase 3: Close server and exit ───
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  });
  process.on("SIGINT", () => {
    logger.info(`[${ts()}] Received SIGINT, shutting down...`);
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.message?.includes("EPIPE")) return; // [v25.9.2] Suppress EPIPE
    logger.error(`[${ts()}] Uncaught exception in main: ${err.message}`);
    logger.error(err.stack);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`[${ts()}] Unhandled rejection in main: ${reason}`);
  });
}
