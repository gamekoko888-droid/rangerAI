/**
 * structured-logger.mjs — 结构化日志工厂 (R100)
 *
 * 每条日志输出为单行 JSON，可直接被 ELK/Loki 解析。
 *
 * 用法：
 *   import { createLogger } from './lib/structured-logger.mjs';
 *   const log = createLogger('task-engine');
 *   log.info('task started', { taskId: 'abc123' });
 *
 * 输出格式：
 *   {"ts":"2026-04-29T17:15:50.123Z","level":"INFO","module":"task-engine","msg":"task started","taskId":"abc123"}
 *
 * 级别控制：LOG_LEVEL 环境变量 (DEBUG/INFO/WARN/ERROR)，默认 INFO
 *   生产环境默认 INFO，DEBUG 会输出所有级别
 */

// ─── Level definitions ───────────────────────────────────────────────────────
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

const envLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const CURRENT_LEVEL = LEVELS[envLevel] ?? LEVELS.INFO;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString();
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────
/**
 * createLogger(moduleName)
 * @param {string} moduleName — 模块标识，如 'task-engine'
 * @returns {{ debug, info, warn, error }}
 */
export function createLogger(moduleName) {
  function emit(level, msg, extra = {}) {
    // 提前跳过低于当前级别的日志
    const levelNum = LEVELS[level];
    if (levelNum < CURRENT_LEVEL) return;

    const entry = {
      ts: ts(),
      level,
      module: moduleName,
      msg: typeof msg === 'string' ? msg : safeStringify(msg),
      ...extra,
    };

    // 清理 undefined
    Object.keys(entry).forEach(k => {
      if (entry[k] === undefined) delete entry[k];
    });

    const line = JSON.stringify(entry);

    // error/warn → stderr, info/debug → stdout
    try {
      if (level === 'ERROR' || level === 'WARN') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    } catch {
      // 静默忽略写入错误 (EPIPE 等)
    }
  }

  return {
    debug: (msg, extra) => emit('DEBUG', msg, extra),
    info: (msg, extra) => emit('INFO', msg, extra),
    warn: (msg, extra) => emit('WARN', msg, extra),
    error: (msg, extra) => emit('ERROR', msg, extra),
  };
}

// ─── 默认导出：向后兼容的 logger 对象 ──────────────────────────────────────
export const logger = createLogger('default');

export default { createLogger, logger, LEVELS };
