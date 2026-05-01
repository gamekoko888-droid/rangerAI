/**
 * structured-logger.ts — 结构化日志工厂 (R100 → R101 TS 迁移)
 *
 * 每条日志输出为单行 JSON，可直接被 ELK/Loki 解析。
 *
 * 用法：
 *   import { createLogger } from './lib/structured-logger.ts';
 *   const log = createLogger('task-engine');
 *   log.info('task started', { taskId: 'abc123' });
 *
 * 输出格式：
 *   {"ts":"2026-04-29T17:15:50.123Z","level":"INFO","module":"task-engine","msg":"task started","taskId":"abc123"}
 *
 * 级别控制：LOG_LEVEL 环境变量 (DEBUG/INFO/WARN/ERROR)，默认 INFO
 *   生产环境默认 INFO，DEBUG 会输出所有级别
 *
 * R101: 从 structured-logger.mjs 迁移，添加 TypeScript 类型注解。
 *   原始 .mjs 文件保留不变，所有运行时 import 保持对 .mjs 的引用。
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogLevelValue = 0 | 1 | 2 | 3;

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  [key: string]: unknown;
}

interface Logger {
  debug: (msg: unknown, extra?: Record<string, unknown>) => void;
  info: (msg: unknown, extra?: Record<string, unknown>) => void;
  warn: (msg: unknown, extra?: Record<string, unknown>) => void;
  error: (msg: unknown, extra?: Record<string, unknown>) => void;
}

interface StructuredLoggerExport {
  createLogger: (moduleName: string) => Logger;
  logger: Logger;
  LEVELS: Record<LogLevel, LogLevelValue>;
}

// ─── Level definitions ───────────────────────────────────────────────────────
const LEVELS: Record<LogLevel, LogLevelValue> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};
const LEVEL_NAMES: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

const envLevel: string = (process.env.LOG_LEVEL || 'INFO').toUpperCase() as LogLevel;
const CURRENT_LEVEL: LogLevelValue =
  LEVELS[envLevel as LogLevel] ?? LEVELS.INFO;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ts(): string {
  return new Date().toISOString();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────
/**
 * createLogger(moduleName)
 * @param moduleName — 模块标识，如 'task-engine'
 */
export function createLogger(moduleName: string): Logger {
  function emit(level: LogLevel, msg: unknown, extra: Record<string, unknown> = {}): void {
    // 提前跳过低于当前级别的日志
    const levelNum: LogLevelValue = LEVELS[level];
    if (levelNum < CURRENT_LEVEL) return;

    const entry: LogEntry = {
      ts: ts(),
      level,
      module: moduleName,
      msg: typeof msg === 'string' ? msg : safeStringify(msg),
      ...extra,
    };

    // 清理 undefined
    (Object.keys(entry) as (keyof LogEntry)[]).forEach(k => {
      if (entry[k] === undefined) delete entry[k];
    });

    const line: string = JSON.stringify(entry);

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
    debug: (msg: unknown, extra?: Record<string, unknown>) => emit('DEBUG', msg, extra),
    info: (msg: unknown, extra?: Record<string, unknown>) => emit('INFO', msg, extra),
    warn: (msg: unknown, extra?: Record<string, unknown>) => emit('WARN', msg, extra),
    error: (msg: unknown, extra?: Record<string, unknown>) => emit('ERROR', msg, extra),
  };
}

// ─── 默认导出：向后兼容的 logger 对象 ──────────────────────────────────────
export const logger: Logger = createLogger('default');

const _default: StructuredLoggerExport = { createLogger, logger, LEVELS };
export default _default;
