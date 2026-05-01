/**
 * RangerAI Structured Logger v3 (TD-043)
 * - JSON structured output with correlation IDs
 * - Log levels: debug, info, warn, error, fatal
 * - Performance timing helpers
 * - Console-only output (file logging removed in v25.9.2, dead code cleaned in v25.11)
 */
import { randomUUID } from 'node:crypto';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];
const SERVICE_NAME = process.env.SERVICE_NAME || 'rangerai-agent';

function formatTimestamp() {
  return new Date().toISOString();
}

let _context = {};

function setContext(ctx) {
  _context = { ..._context, ...ctx };
}

function clearContext() {
  _context = {};
}

function log(level, message, meta = {}) {
  // [v25.9.2] Skip EPIPE messages to prevent log explosion
  if (typeof message === "string" && message.includes("EPIPE")) return;
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  
  const entry = {
    ts: formatTimestamp(),
    level,
    service: SERVICE_NAME,
    msg: typeof message === 'string' ? message : JSON.stringify(message),
    ..._context,
    ...meta
  };

  Object.keys(entry).forEach(k => {
    if (entry[k] === undefined) delete entry[k];
  });

  const output = JSON.stringify(entry);

  // [v25.9.2] Wrap all writes in try/catch to prevent EPIPE cascade
  try {
    if (level === 'error' || level === 'fatal' || level === 'warn') {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  } catch (e) {
    // Silently ignore write errors (EPIPE, etc.)
  }
}

function startTimer(label) {
  const start = process.hrtime.bigint();
  return {
    end: (meta = {}) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      log('info', label + ' completed', { ...meta, duration_ms: Math.round(elapsed * 100) / 100 });
      return elapsed;
    }
  };
}

function requestLogger(req) {
  const requestId = req.headers['x-request-id'] || randomUUID().slice(0, 8);
  const userId = req.user?.id || req.headers['x-user-id'] || 'anonymous';
  return {
    requestId,
    userId,
    method: req.method,
    path: req.url?.split('?')[0],
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress
  };
}

export const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  fatal: (msg, meta) => log('fatal', msg, meta),
  timer: startTimer,
  setContext,
  clearContext,
  requestLogger,
};

export default logger;
