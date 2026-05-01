/**
 * Frontend Logger — silences debug logs in production builds.
 * 
 * Usage:
 *   import { logger } from "../lib/logger";
 *   logger.debug("[ChatStore] some debug info", data);
 *   logger.warn("[WS] connection issue", err);
 *   logger.error("[Critical] something broke", err);
 * 
 * In development: all levels print to console.
 * In production: only warn and error print.
 */

const isDev = import.meta.env.DEV;

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (..._args: unknown[]) => {};

export const logger = {
  /** Debug-level log — silenced in production */
  debug: isDev ? console.log.bind(console) : noop,
  /** Info-level log — silenced in production */
  info: isDev ? console.info.bind(console) : noop,
  /** Warning — always prints */
  warn: console.warn.bind(console),
  /** Error — always prints */
  error: console.error.bind(console),
};

export default logger;
