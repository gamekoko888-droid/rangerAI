// ─── Token Cost Tracker ─── R50-T1
// 记录每次 LLM 调用的 token 用量与估算成本，支持按模型/任务/对话聚合统计
// 接入点：openclaw-handler.mjs 中 LLM 返回 usage 后调用 trackTokenUsage()

import { query, run, initAdapter } from '../db-adapter.mjs';
import { logger } from '../lib/logger.mjs';

let initialized = false;

// ── 价格表（单位：USD per 1M tokens）
// 更新时间：2026-04
const PRICE_TABLE = {
  'anthropic/claude-sonnet-4-6':        { input: 3.0,   cacheWrite: 3.75, cacheRead: 0.30,  output: 15.0 },
  'anthropic/claude-sonnet-4-20250514': { input: 3.0,   cacheWrite: 3.75, cacheRead: 0.30,  output: 15.0 },
  'anthropic/claude-haiku-3-5':         { input: 0.8,   cacheWrite: 1.0,  cacheRead: 0.08,  output: 4.0  },
  'openai/gpt-5.5':                     { input: 5.00,  cacheWrite: 0,    cacheRead: 0.50,  output: 30.00 },
  'openai/gpt-5.4':                     { input: 2.50,  cacheWrite: 0,    cacheRead: 0.25,  output: 15.00 },
  'openai/gpt-5.4-mini':                { input: 0.75,  cacheWrite: 0,    cacheRead: 0.075, output: 4.50 },
  'openai/gpt-5-mini':                  { input: 0.15,  cacheWrite: 0,    cacheRead: 0.075, output: 0.6  },
  'google/gemini-3.1-pro-preview':      { input: 1.25,  cacheWrite: 0,    cacheRead: 0,     output: 5.0  },
  'google/gemini-3-flash-preview':      { input: 0.075, cacheWrite: 0,    cacheRead: 0,     output: 0.30 },
  // DeepSeek (2026-04-28 官方定价, v4-pro 当前 75% 折扣至 2026/05/31)
  'deepseek/deepseek-v4-pro':           { input: 0.435, cacheWrite: 0,    cacheRead: 0.003625, output: 0.87 },
  'deepseek/deepseek-v4-flash':         { input: 0.14,  cacheWrite: 0,    cacheRead: 0.0028,  output: 0.28 },
  'deepseek/deepseek-chat':             { input: 0.14,  cacheWrite: 0,    cacheRead: 0.014,  output: 0.28 },  // deprecated → v4-flash
};

const DEFAULT_PRICE = { input: 3.0, cacheWrite: 3.75, cacheRead: 0.30, output: 15.0 };

/** 根据模型和 usage 计算估算成本（USD） */
export function calcCost(model, usage) {
  const price = PRICE_TABLE[model] || DEFAULT_PRICE;
  const M = 1_000_000;
  const inputTokens    = (usage.input         || usage.prompt_tokens       || 0);
  const outputTokens   = (usage.output        || usage.completion_tokens    || 0);
  const cacheReadTok   = (usage.cacheRead     || usage.cache_read_tokens    || 0);
  const cacheWriteTok  = (usage.cacheWrite    || usage.cache_creation_input_tokens || 0);
  // 有 cache 数据时，扣除 cache 部分的 input 计费（cache_read 以独立价格计）
  const netInput = Math.max(0, inputTokens - cacheReadTok - cacheWriteTok);
  return (
    (netInput       / M) * price.input       +
    (cacheWriteTok  / M) * price.cacheWrite  +
    (cacheReadTok   / M) * price.cacheRead   +
    (outputTokens   / M) * price.output
  );
}

/** 初始化 token_cost_log 表（SQLite） */
async function ensureTable() {
  if (initialized) return;
  try {
    await initAdapter({});
  } catch (_) { /* already initialized */ }
  await run(`
    CREATE TABLE IF NOT EXISTS token_cost_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT,
      chat_id      TEXT,
      session_key  TEXT,
      model        TEXT,
      task_family  TEXT,
      turn_index   INTEGER DEFAULT 0,
      prompt_tokens      INTEGER DEFAULT 0,
      completion_tokens  INTEGER DEFAULT 0,
      cache_read_tokens  INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      total_tokens       INTEGER DEFAULT 0,
      est_cost_usd       REAL DEFAULT 0,
      tool_count         INTEGER DEFAULT 0,
      is_retry           INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    )
  `);
  // 索引
  await run(`CREATE INDEX IF NOT EXISTS idx_tcl_created ON token_cost_log(created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_tcl_model   ON token_cost_log(model)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_tcl_family  ON token_cost_log(task_family)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_tcl_chat    ON token_cost_log(chat_id)`);
  initialized = true;
}

/**
 * 记录一次 LLM 调用的 token 用量
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} params.chatId
 * @param {string} params.sessionKey
 * @param {string} params.model
 * @param {string} params.taskFamily  - non_web / page_lookup / page_extract / browser / coding
 * @param {number} params.turnIndex
 * @param {object} params.usage       - { input, output, cacheRead, cacheWrite } 或 { prompt_tokens, completion_tokens }
 * @param {number} params.toolCount
 * @param {boolean} params.isRetry
 */
export async function trackTokenUsage({
  taskId = null,
  chatId = null,
  sessionKey = null,
  model = 'unknown',
  taskFamily = 'unknown',
  turnIndex = 0,
  usage = {},
  toolCount = 0,
  isRetry = false,
}) {
  try {
    await ensureTable();
    const promptTok    = usage.input         || usage.prompt_tokens              || 0;
    const completeTok  = usage.output        || usage.completion_tokens           || 0;
    const cacheReadTok = usage.cacheRead     || usage.cache_read_tokens           || 0;
    const cacheWriteTok= usage.cacheWrite    || usage.cache_creation_input_tokens || 0;
    const totalTok     = promptTok + completeTok;
    const cost         = calcCost(model, usage);

    await run(
      `INSERT INTO token_cost_log
        (task_id, chat_id, session_key, model, task_family, turn_index,
         prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
         total_tokens, est_cost_usd, tool_count, is_retry)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [taskId, chatId, sessionKey, model, taskFamily, turnIndex,
       promptTok, completeTok, cacheReadTok, cacheWriteTok,
       totalTok, cost, toolCount, isRetry ? 1 : 0]
    );
  } catch (err) {
    // 追踪失败不影响主流程
    logger.warn(`[token-cost-tracker] write failed: ${err?.message}`);
  }
}

/**
 * 聚合统计
 * @param {object} opts
 * @param {string} opts.since   - '1h' | '24h' | '7d' | '30d'，默认 '24h'
 * @param {string} opts.groupBy - 'model' | 'task_family' | 'chat_id'，默认 'model'
 * @returns {Array}
 */
export async function getTokenStats({ since = '24h', groupBy = 'model' } = {}) {
  await ensureTable();
  const sinceMap = { '1h': '-1 hours', '24h': '-1 day', '7d': '-7 days', '30d': '-30 days' };
  const interval = sinceMap[since] || '-1 day';
  const col = ['model', 'task_family', 'chat_id'].includes(groupBy) ? groupBy : 'model';
  const rows = await query(
    `SELECT
       ${col} AS group_key,
       COUNT(*)                        AS call_count,
       SUM(prompt_tokens)              AS total_prompt_tokens,
       SUM(completion_tokens)          AS total_completion_tokens,
       SUM(cache_read_tokens)          AS total_cache_read,
       SUM(cache_write_tokens)         AS total_cache_write,
       SUM(total_tokens)               AS total_tokens,
       ROUND(SUM(est_cost_usd), 6)     AS total_cost_usd,
       ROUND(AVG(total_tokens), 0)     AS avg_tokens_per_call,
       ROUND(AVG(est_cost_usd), 6)     AS avg_cost_per_call,
       MAX(total_tokens)               AS max_tokens_call
     FROM token_cost_log
     WHERE created_at >= datetime('now', ?)
     GROUP BY ${col}
     ORDER BY total_cost_usd DESC`,
    [interval]
  );
  return rows;
}

/**
 * 获取成本最高的 top N 任务
 * @param {object} opts
 * @param {number} opts.limit  - 默认 10
 * @param {string} opts.since  - 默认 '24h'
 */
export async function getTopExpensiveTasks({ limit = 10, since = '24h' } = {}) {
  await ensureTable();
  const sinceMap = { '1h': '-1 hours', '24h': '-1 day', '7d': '-7 days', '30d': '-30 days' };
  const interval = sinceMap[since] || '-1 day';
  const rows = await query(
    `SELECT
       task_id,
       chat_id,
       session_key,
       model,
       task_family,
       COUNT(*)                    AS turns,
       SUM(total_tokens)           AS total_tokens,
       ROUND(SUM(est_cost_usd), 6) AS total_cost_usd,
       MAX(prompt_tokens)          AS max_prompt_single_turn,
       MIN(created_at)             AS started_at,
       MAX(created_at)             AS last_turn_at
     FROM token_cost_log
     WHERE created_at >= datetime('now', ?)
       AND task_id IS NOT NULL
     GROUP BY task_id
     ORDER BY total_cost_usd DESC
     LIMIT ?`,
    [interval, limit]
  );
  return rows;
}

/**
 * 获取全局汇总（今日/7日/30日）
 */
export async function getGlobalSummary() {
  await ensureTable();
  const periods = [
    { label: 'today',   interval: '-1 day'   },
    { label: 'week',    interval: '-7 days'  },
    { label: 'month',   interval: '-30 days' },
  ];
  const result = {};
  for (const { label, interval } of periods) {
    const [row] = await query(
      `SELECT
         COUNT(*)                    AS call_count,
         SUM(total_tokens)           AS total_tokens,
         ROUND(SUM(est_cost_usd), 4) AS total_cost_usd,
         ROUND(AVG(total_tokens), 0) AS avg_tokens,
         ROUND(AVG(est_cost_usd), 6) AS avg_cost
       FROM token_cost_log
       WHERE created_at >= datetime('now', ?)`,
      [interval]
    );
    result[label] = row;
  }
  return result;
}

/**
 * 清理旧记录（默认保留 30 天）
 */
export async function pruneOldRecords(daysToKeep = 30) {
  await ensureTable();
  const { changes } = await run(
    `DELETE FROM token_cost_log WHERE created_at < datetime('now', ?)`,
    [`-${daysToKeep} days`]
  );
  return changes || 0;
}
