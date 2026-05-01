/**
 * observability.mjs — RangerAI 可观测性模块 v1.0
 *
 * 功能：
 * 1. 请求全链路追踪（traceId = msgId）
 * 2. 各阶段耗时记录（span）
 * 3. 错误率统计
 * 4. 模型使用分布
 * 5. 写入 SQLite request_traces 表
 * 6. 提供 /api/observability/stats 接口数据
 * 7. F18: 模型级成本计算（$/1M tokens 定价 × 实际 token 数）
 *
 * 设计原则：
 * - 零侵入：try-catch 包裹，失败不影响主流程
 * - 轻量：纯 SQLite，无外部依赖
 * - 异步：非阻塞写入
 */

import { initAdapter, query, run } from '../db-adapter.mjs';
import Database from 'better-sqlite3';
import { calculateCostUsd, getDefaultModel } from './model-pricing.mjs';

import { logger } from '../lib/logger.mjs';
// F19: Budget alert — lazy import to avoid circular deps
let _checkBudgetAlerts = null;
let _cleanupBudgetAlert = null;
async function triggerBudgetAlert(userId) {
  try {
    if (!_checkBudgetAlerts) {
      const mod = await import('../budget-alert.mjs');
      _checkBudgetAlerts = mod.checkBudgetAlert;
      _cleanupBudgetAlert = mod.cleanupBudgetAlert;
    }
    await _checkBudgetAlerts(userId);
  } catch (e) {
    logger.error('[observability] Budget alert trigger failed (non-fatal):', e.message);
  }
}

export function cleanupObservabilityResources() {
  if (_cleanupBudgetAlert) _cleanupBudgetAlert();
}

let _initialized = false;
let _schemaInitPromise = null;

// ─── Idempotent column migration helper ─────────────────────────
async function ensureColumn(table, column, definition) {
  const cols = await query(`PRAGMA table_info(${table})`);
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`[observability] Migration: added column ${table}.${column}`);
  }
}

// ─── 初始化 Schema ───────────────────────────────────────────
async function ensureSchema() {
  if (_initialized) return;
  if (_schemaInitPromise) return _schemaInitPromise;
  _schemaInitPromise = (async () => {
  try {
    await initAdapter({});

    // 请求追踪表
    await run(`
      CREATE TABLE IF NOT EXISTS request_traces (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id   TEXT NOT NULL,
        session_key TEXT,
        user_id    TEXT,
        model      TEXT,
        message_len INTEGER DEFAULT 0,
        total_ms   INTEGER DEFAULT 0,
        status     TEXT DEFAULT 'pending',  -- pending | success | error | timeout
        error_msg  TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        finished_at TEXT
      )
    `);

    // 阶段耗时表（每个 trace 对应多个 span）
    await run(`
      CREATE TABLE IF NOT EXISTS trace_spans (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id   TEXT NOT NULL,
        span_name  TEXT NOT NULL,   -- 阶段名：knowledge_inject / recall / gateway_send / stream 等
        started_at INTEGER NOT NULL,  -- epoch ms
        ended_at   INTEGER,
        duration_ms INTEGER,
        status     TEXT DEFAULT 'ok',  -- ok | error | skip
        meta       TEXT               -- JSON 附加信息
      )
    `);

    // 创建索引（提升查询速度）
    await run(`CREATE INDEX IF NOT EXISTS idx_traces_created ON request_traces(created_at)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_traces_model ON request_traces(model)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_spans_trace ON trace_spans(trace_id)`);

    // F33/R66: Add token/cost telemetry columns (idempotent migrations)
    await ensureColumn('request_traces', 'prompt_tokens', 'INTEGER DEFAULT 0');
    await ensureColumn('request_traces', 'completion_tokens', 'INTEGER DEFAULT 0');
    await ensureColumn('request_traces', 'total_tokens', 'INTEGER DEFAULT 0');
    await ensureColumn('request_traces', 'cost_usd', 'REAL DEFAULT 0');
    await ensureColumn('request_traces', 'gateway_cost', 'TEXT');
    await ensureColumn('request_traces', 'token_source', "TEXT DEFAULT 'estimate'");

    // R72: Create system_config table to eliminate "no such table" noise from
    // budget-alert.mjs and session-ttl-cleanup.mjs (table exists in MySQL but not SQLite)
    await run(`
      CREATE TABLE IF NOT EXISTS system_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now')),
        updated_by  TEXT
      )
    `);

    _initialized = true;
  } catch (err) {
    logger.warn('[observability] Schema init failed (non-fatal):', err.message);
  } finally {
    _schemaInitPromise = null;
  }
  })();
  return _schemaInitPromise;
}

// ─── Trace 生命周期 ───────────────────────────────────────────

const _activeTraces = new Map(); // traceId → { startMs, spans[], model, sessionKey, ... }

/**
 * 开始一个请求追踪
 */
export function startTrace(traceId, { sessionKey, userId, model, messageLen } = {}) {
  _activeTraces.set(traceId, {
    traceId,
    sessionKey,
    userId,
    model: model || 'unknown',
    messageLen: messageLen || 0,
    startMs: Date.now(),
    spans: [],
    status: 'pending',
  });

  // 异步写入（不等待）
  ensureSchema().then(() =>
    run(
      `INSERT INTO request_traces (trace_id, session_key, user_id, model, message_len, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      [traceId, sessionKey || null, userId || null, model || null, messageLen || 0]
    )
  ).catch((e) => { logger.warn('[observability] Insert trace failed:', e.message); });
}

/**
 * 开始一个 span（阶段）
 * 返回 spanHandle，调用 spanHandle.end() 结束
 */
export function startSpan(traceId, spanName, meta = {}) {
  const startedAt = Date.now();
  const trace = _activeTraces.get(traceId);

  return {
    end(status = 'ok', extraMeta = {}) {
      const endedAt = Date.now();
      const durationMs = endedAt - startedAt;

      if (trace) {
        trace.spans.push({ spanName, startedAt, endedAt, durationMs, status });
      }

      // 异步写入
      ensureSchema().then(() =>
        run(
          `INSERT INTO trace_spans (trace_id, span_name, started_at, ended_at, duration_ms, status, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            traceId,
            spanName,
            startedAt,
            endedAt,
            durationMs,
            status,
            JSON.stringify({ ...meta, ...extraMeta }),
          ]
        )
      ).catch((e) => { logger.warn('[observability] Span update failed:', e.message); });

      return durationMs;
    },
  };
}

/**
 * 更新 trace 的模型信息（路由决策后调用）
 */
export function updateTraceModel(traceId, model, force = false) {
  const trace = _activeTraces.get(traceId);
  const currentModel = trace ? trace.model : 'N/A';
  // In retry scenarios (e.g., gemini empty -> claude retry), model changes are legitimate
  if (trace) {
    trace.model = model;
  }
  logger.info(`[updateTraceModel] traceId=${traceId} model=${model} (was: ${currentModel}) traceExists=${!!trace}`);
  ensureSchema().then(() =>
    run(`UPDATE request_traces SET model = ? WHERE trace_id = ?`, [model, traceId])
  ).catch((e) => { logger.warn('[observability] Trace model update failed:', e.message); });
}

/**
 * 结束一个请求追踪
 */

let _lastStaleCleanup = 0;
function cleanupStalePendingTraces() {
  const now = Date.now();
  if (now - _lastStaleCleanup < 30 * 60 * 1000) return; // throttle: 30 min
  _lastStaleCleanup = now;
  try {
    const db = getDb();
    if (!db) return;
    const result = db.prepare(`
      UPDATE request_traces 
      SET status = 'timeout', finished_at = datetime('now')
      WHERE status = 'pending' 
      AND created_at < datetime('now', '-2 hours')
    `).run();
    if (result.changes > 0) {
      logger.info(`[observability] Cleaned up ${result.changes} stale pending traces`);
    }
  } catch (e) {
    // silent - cleanup is best-effort
  }
}

export function endTrace(traceId, status = 'success', errorMsg = null, tokenInfo = null) {
  cleanupStalePendingTraces();
  const trace = _activeTraces.get(traceId);
  const totalMs = trace ? Date.now() - trace.startMs : 0;
  _activeTraces.delete(traceId);
  
  // F18: Resolve model — if "unknown", use Gateway default model for cost calculation
  const resolvedModel = (trace?.model && trace.model !== 'unknown') ? trace.model : getDefaultModel();
  
  // F18: Calculate USD cost from token counts
  const promptTok = tokenInfo?.prompt_tokens || 0;
  const compTok = tokenInfo?.completion_tokens || 0;
  const costUsd = (promptTok > 0 || compTok > 0) ? calculateCostUsd(resolvedModel, promptTok, compTok) : 0;
  
  // F33: Enhanced logging with gateway cost comparison
  const tokenSource = tokenInfo?.source || 'unknown';
  const gatewayCost = tokenInfo?.gateway_cost ? JSON.stringify(tokenInfo.gateway_cost) : 'N/A';
  logger.info(`[endTrace] Called for ${traceId}, status=${status}, model=${resolvedModel}, tokens=${promptTok}+${compTok}, cost=$${costUsd}, totalMs=${totalMs}, source=${tokenSource}, gatewayCost=${gatewayCost}`);
  (async () => {
    try {
      await ensureSchema();
      const gatewayCostJson = tokenInfo?.gateway_cost ? JSON.stringify(tokenInfo.gateway_cost) : null;
      const tokenSourceVal = tokenInfo?.source || 'estimate';
      const result = await run(
        `UPDATE request_traces SET status = ?, total_ms = ?, error_msg = ?, finished_at = datetime('now'), model = COALESCE(NULLIF(?, 'unknown'), model, ?), prompt_tokens = COALESCE(?, prompt_tokens), completion_tokens = COALESCE(?, completion_tokens), total_tokens = COALESCE(?, total_tokens), cost_usd = ?, gateway_cost = ?, token_source = ? WHERE trace_id = ?`,
        [status, totalMs, errorMsg, resolvedModel, resolvedModel, tokenInfo?.prompt_tokens || null, tokenInfo?.completion_tokens || null, tokenInfo?.total_tokens || null, costUsd, gatewayCostJson, tokenSourceVal, traceId]
      );
      logger.info(`[endTrace] Updated ${traceId}: changes=${result?.changes}, status=${status}, cost=$${costUsd}`);
      
      // F19: Trigger budget alert check after successful trace update
      if (status === 'success' && trace?.userId) {
        triggerBudgetAlert(trace.userId).catch((e) => { logger.warn('[observability] Budget alert promise failed:', e.message); });
      }
    } catch (err) {
      logger.error(`[endTrace] SQL ERROR for ${traceId}:`, err.message);
    }
  })();
  return totalMs;
}

// ─── 统计查询 ────────────────────────────────────────────────

/**
 * 获取最近 N 小时的统计数据
 */
export async function getStats(hours = 24) {
  try {
    await ensureSchema();

    const [overview, modelDist, slowRequests, errorRate, spanPerf] = await Promise.all([
      // 总体概览（F18: 增加成本汇总）
      query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as error_count,
          SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) as timeout_count,
          AVG(total_ms) as avg_ms,
          MAX(total_ms) as max_ms,
          MIN(total_ms) as min_ms,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as total_cost_usd
        FROM request_traces
        WHERE created_at >= datetime('now', '-${hours} hours')
          AND status != 'pending'
      `),

      // 模型使用分布（F18: 增加成本归因）
      query(`
        SELECT model, COUNT(*) as cnt, AVG(total_ms) as avg_ms,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as total_cost_usd
        FROM request_traces
        WHERE created_at >= datetime('now', '-${hours} hours')
          AND status = 'success'
          AND model IS NOT NULL
        GROUP BY model
        ORDER BY total_cost_usd DESC
        LIMIT 10
      `),

      // 最慢的5条请求
      query(`
        SELECT trace_id, model, total_ms, created_at
        FROM request_traces
        WHERE created_at >= datetime('now', '-${hours} hours')
          AND status = 'success'
        ORDER BY total_ms DESC
        LIMIT 5
      `),

      // 按小时的错误率
      query(`
        SELECT
          strftime('%Y-%m-%d %H:00', created_at) as hour,
          COUNT(*) as total,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors
        FROM request_traces
        WHERE created_at >= datetime('now', '-${hours} hours')
          AND status != 'pending'
        GROUP BY hour
        ORDER BY hour DESC
        LIMIT 24
      `),

      // 各阶段平均耗时
      query(`
        SELECT span_name, AVG(duration_ms) as avg_ms, COUNT(*) as cnt
        FROM trace_spans ts
        JOIN request_traces rt ON ts.trace_id = rt.trace_id
        WHERE rt.created_at >= datetime('now', '-${hours} hours')
          AND ts.status = 'ok'
        GROUP BY span_name
        ORDER BY avg_ms DESC
      `),
    ]);

    return {
      period: `最近 ${hours} 小时`,
      overview: overview[0] || {},
      modelDistribution: modelDist,
      slowestRequests: slowRequests,
      errorsByHour: errorRate,
      spanPerformance: spanPerf,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 格式化统计为可读文本（用于 /api/observability/summary）
 */
export async function getStatsSummary(hours = 24) {
  const stats = await getStats(hours);
  if (stats.error) return `可观测性数据暂不可用: ${stats.error}`;

  const ov = stats.overview;
  const successRate = ov.total > 0
    ? ((ov.success_count / ov.total) * 100).toFixed(1)
    : 'N/A';

  const lines = [
    `📊 **RangerAI 可观测性报告**（${stats.period}）`,
    ``,
    `**请求概览**`,
    `- 总请求: ${ov.total || 0}`,
    `- 成功率: ${successRate}%`,
    `- 平均响应: ${Math.round(ov.avg_ms || 0)}ms`,
    `- 最慢请求: ${Math.round(ov.max_ms || 0)}ms`,
    `- 错误数: ${ov.error_count || 0} | 超时数: ${ov.timeout_count || 0}`,
    `- 总 Tokens: ${ov.total_tokens || 0}`,
    `- 总成本: $${(ov.total_cost_usd || 0).toFixed(6)}`,
    ``,
    `**模型使用分布（按成本排序）**`,
  ];

  for (const m of stats.modelDistribution) {
    lines.push(`- ${m.model}: ${m.cnt} 次，均${Math.round(m.avg_ms)}ms，${m.total_tokens || 0} tokens，$${(m.total_cost_usd || 0).toFixed(6)}`);
  }

  if (stats.spanPerformance.length > 0) {
    lines.push(``, `**各阶段耗时（Top 5）**`);
    for (const s of stats.spanPerformance.slice(0, 5)) {
      lines.push(`- ${s.span_name}: 均${Math.round(s.avg_ms)}ms（${s.cnt} 次）`);
    }
  }

  return lines.join('\n');
}

// 初始化 Schema（模块加载时触发）
ensureSchema().catch((e) => { logger.warn('[observability] Schema init failed:', e.message); });


// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════

const _agentCounters = {
  compression: { micro: 0, auto: 0, microSaved: 0, autoSaved: 0, lastAt: null },
  tools: { total: 0, success: 0, blocked: 0, byName: {} },
  skills: { total: 0, success: 0, failed: 0, byName: {} },
  _startedAt: Date.now(),
};

// [R13-T1] DB-backed compression logging
let _compressionDb = null;
function getCompressionDb() {
  if (_compressionDb) return _compressionDb;
  try {
    _compressionDb = new Database('/opt/rangerai-agent/db/rangerai.db');
    _compressionDb.pragma('journal_mode = WAL');
    _compressionDb.pragma('busy_timeout = 5000');
  } catch (e) {
    logger.warn(`[R13-T1] Failed to open compression DB: ${e.message}`);
    return null;
  }
  return _compressionDb;
}

/**
 * [R13-T1] 记录一次压缩事件 — 写入 DB + 内存计数
 * @param {'micro'|'auto'|'sub-agent'|'tier_change'|'checkpoint_restore'|'kv_cache_miss'|'memory_limit_warning'|'memory_decay'|'tool_permission_check'} type
 * @param {number} savedTokens — 节省的 token 数
 * @param {object} opts — 额外参数 { sessionKey, msgId, triggerRatio, msgsBefore, msgsAfter, tokensBefore, tokensAfter, summaryChars, extraJson }
 */
export function recordCompression(type, savedTokens = 0, opts = {}) {
  try {
    // 内存计数（向后兼容）
    if (type === 'micro') {
      _agentCounters.compression.micro++;
      _agentCounters.compression.microSaved += savedTokens;
    } else if (type === 'auto') {
      _agentCounters.compression.auto++;
      _agentCounters.compression.autoSaved += savedTokens;
    }
    _agentCounters.compression.lastAt = new Date().toISOString();

    // [R13-T1] 写入 DB
    const db = getCompressionDb();
    if (db) {
      db.prepare(`
        INSERT INTO context_compression_log 
        (session_key, msg_id, type, trigger_ratio, msgs_before, msgs_after, tokens_before, tokens_after, summary_chars, extra_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        opts.sessionKey || 'unknown',
        opts.msgId || null,
        type,
        opts.triggerRatio || null,
        opts.msgsBefore || null,
        opts.msgsAfter || null,
        opts.tokensBefore || null,
        opts.tokensAfter || null,
        opts.summaryChars || null,
        opts.extraJson ? JSON.stringify(opts.extraJson) : null,
        Date.now()
      );
      logger.info(`[R13-T1] recordCompression: type=${type}, saved=${savedTokens}, session=${opts.sessionKey || 'unknown'}`);
    }
  } catch (e) {
    logger.warn(`[R13-T1] recordCompression failed (non-fatal): ${e.message}`);
  }
}

/**
 * 记录一次工具执行事件
 * @param {string} toolName
 * @param {'success'|'error'|'blocked'} status
 * @param {number} durationMs
 */
export function recordToolExecution(toolName, status, durationMs = 0) {
  try {
    _agentCounters.tools.total++;
    if (status === 'success') _agentCounters.tools.success++;
    else if (status === 'blocked') _agentCounters.tools.blocked++;
    if (!_agentCounters.tools.byName[toolName]) {
      _agentCounters.tools.byName[toolName] = { total: 0, success: 0, errors: 0, blocked: 0, totalMs: 0 };
    }
    const t = _agentCounters.tools.byName[toolName];
    t.total++;
    t.totalMs += durationMs;
    if (status === 'success') t.success++;
    else if (status === 'blocked') t.blocked++;
    else t.errors++;
  } catch (_) { /* non-fatal */ }
}

/**
 * 记录一次 Skill 执行事件
 * @param {string} skillName
 * @param {boolean} success
 * @param {number} durationMs
 */
export function recordSkillExecution(skillName, success, durationMs = 0) {
  try {
    _agentCounters.skills.total++;
    if (success) _agentCounters.skills.success++;
    else _agentCounters.skills.failed++;
    if (!_agentCounters.skills.byName[skillName]) {
      _agentCounters.skills.byName[skillName] = { total: 0, success: 0, failed: 0, totalMs: 0 };
    }
    const s = _agentCounters.skills.byName[skillName];
    s.total++;
    s.totalMs += durationMs;
    if (success) s.success++;
    else s.failed++;
  } catch (_) { /* non-fatal */ }
}

/**
 * 获取 Agent 指标实时快照
 * @returns {object} 聚合指标
 */
export function getAgentMetrics() {
  const uptime = Math.round((Date.now() - _agentCounters._startedAt) / 1000);
  const toolSuccessRate = _agentCounters.tools.total > 0
    ? Math.round((_agentCounters.tools.success / _agentCounters.tools.total) * 10000) / 100
    : 100;
  const skillSuccessRate = _agentCounters.skills.total > 0
    ? Math.round((_agentCounters.skills.success / _agentCounters.skills.total) * 10000) / 100
    : 100;

  // Top 10 tools by usage
  const topTools = Object.entries(_agentCounters.tools.byName)
    .map(([name, d]) => ({
      name, total: d.total, success: d.success, errors: d.errors, blocked: d.blocked,
      avgMs: d.total > 0 ? Math.round(d.totalMs / d.total) : 0,
      successRate: d.total > 0 ? Math.round((d.success / d.total) * 100) : 100,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return {
    uptimeSeconds: uptime,
    timestamp: new Date().toISOString(),
    compression: {
      microCompactCount: _agentCounters.compression.micro,
      autoCompactCount: _agentCounters.compression.auto,
      totalCompactions: _agentCounters.compression.micro + _agentCounters.compression.auto,
      estimatedTokensSaved: _agentCounters.compression.microSaved + _agentCounters.compression.autoSaved,
      lastCompactionAt: _agentCounters.compression.lastAt,
    },
    tools: {
      totalExecutions: _agentCounters.tools.total,
      successCount: _agentCounters.tools.success,
      blockedCount: _agentCounters.tools.blocked,
      errorCount: _agentCounters.tools.total - _agentCounters.tools.success - _agentCounters.tools.blocked,
      successRate: toolSuccessRate,
      topTools,
    },
    skills: {
      totalExecutions: _agentCounters.skills.total,
      successCount: _agentCounters.skills.success,
      failedCount: _agentCounters.skills.failed,
      successRate: skillSuccessRate,
      bySkill: _agentCounters.skills.byName,
    },
  };
}


// ─── [R37-T6] Final Answer Windowed Statistics ───
export async function getFinalAnswerStats(postFixDate = null) {
  try {
    // IMPORTANT: event_stream is in rangerai.db, not in the observability db-adapter
    const { default: Database } = await import('better-sqlite3');
    const esDb = new Database('/opt/rangerai-agent/db/rangerai.db', { readonly: true });
    esDb.pragma('busy_timeout = 5000');
    
    const fixDate = postFixDate || '2026-04-17';
    
    // All-time
    const allTime = esDb.prepare(`
      SELECT 
        (SELECT COUNT(DISTINCT task_id) FROM event_stream WHERE event_type = 'user_message' AND task_id IS NOT NULL AND task_id != '') as total_tasks,
        (SELECT COUNT(DISTINCT task_id) FROM event_stream WHERE event_type = 'final_answer' AND task_id IS NOT NULL AND task_id != '') as tasks_with_final_answer
    `).get();
    
    // Post-fix
    const postFix = esDb.prepare(`
      SELECT 
        (SELECT COUNT(DISTINCT task_id) FROM event_stream WHERE event_type = 'user_message' AND task_id IS NOT NULL AND task_id != '' AND created_at >= ?) as total_tasks,
        (SELECT COUNT(DISTINCT task_id) FROM event_stream WHERE event_type = 'final_answer' AND task_id IS NOT NULL AND task_id != '' AND created_at >= ?) as tasks_with_final_answer
    `).get(fixDate, fixDate);
    
    // Last 7 days
    const last7d = esDb.prepare(`
      SELECT 
        (SELECT COUNT(DISTINCT task_id) FROM event_stream WHERE event_type = 'user_message' AND task_id IS NOT NULL AND task_id != '' AND created_at >= datetime('now', '-7 days')) as total_tasks,
        (SELECT COUNT(DISTINCT task_id) FROM event_stream WHERE event_type = 'final_answer' AND task_id IS NOT NULL AND task_id != '' AND created_at >= datetime('now', '-7 days')) as tasks_with_final_answer
    `).get();
    
    // Last 50 tasks
    const last50 = esDb.prepare(`
      WITH recent_tasks AS (
        SELECT DISTINCT task_id 
        FROM event_stream 
        WHERE event_type = 'user_message' AND task_id IS NOT NULL AND task_id != ''
        ORDER BY created_at DESC 
        LIMIT 50
      )
      SELECT 
        COUNT(DISTINCT rt.task_id) as total_tasks,
        (SELECT COUNT(DISTINCT es2.task_id) FROM event_stream es2 WHERE es2.event_type = 'final_answer' AND es2.task_id IN (SELECT task_id FROM recent_tasks)) as tasks_with_final_answer
      FROM recent_tasks rt
    `).get();
    
    // Tool usage breakdown (last 7 days)
    const toolBreakdown = esDb.prepare(`
      SELECT 
        COALESCE(json_extract(payload, '$.tool'), json_extract(payload, '$.toolName'), 'unknown') as tool_name,
        COUNT(*) as call_count,
        COUNT(DISTINCT task_id) as unique_tasks
      FROM event_stream
      WHERE event_type IN ('tool_start', 'tool_end', 'code_exec_started')
        AND created_at >= datetime('now', '-7 days')
      GROUP BY tool_name
      ORDER BY call_count DESC
      LIMIT 15
    `).all();
    
    // Browser routing stats (last 7 days)
    const routingStats = esDb.prepare(`
      SELECT 
        COALESCE(json_extract(payload, '$.chosenTool'), 'unknown') as chosen_tool,
        COALESCE(json_extract(payload, '$.expectedTool'), 'unknown') as expected_tool,
        COUNT(*) as count
      FROM event_stream
      WHERE event_type = 'tool_route_chosen'
        AND created_at >= datetime('now', '-7 days')
      GROUP BY chosen_tool, expected_tool
      ORDER BY count DESC
    `).all();
    
    // Code execution stats (last 7 days)
    const codeExecStats = esDb.prepare(`
      SELECT 
        event_type,
        COUNT(*) as count,
        COUNT(DISTINCT task_id) as unique_tasks
      FROM event_stream
      WHERE event_type IN ('code_exec_started', 'code_exec_finished', 'code_exec_failed')
        AND created_at >= datetime('now', '-7 days')
      GROUP BY event_type
    `).all();
    
    esDb.close();
    
    const calcRate = (row) => {
      if (!row || !row.total_tasks || row.total_tasks === 0) return { total: 0, final_answer: 0, rate: 0 };
      return {
        total: row.total_tasks,
        final_answer: row.tasks_with_final_answer || 0,
        rate: Math.round(((row.tasks_with_final_answer || 0) / row.total_tasks) * 1000) / 10,
      };
    };
    
    return {
      timestamp: new Date().toISOString(),
      postFixDate: fixDate,
      windows: {
        all_time: { label: 'All Time', ...calcRate(allTime) },
        post_fix: { label: 'Post-Fix (since ' + fixDate + ')', ...calcRate(postFix) },
        last_7d: { label: 'Last 7 Days', ...calcRate(last7d) },
        last_50_tasks: { label: 'Last 50 Tasks', ...calcRate(last50) },
      },
      tool_breakdown: toolBreakdown || [],
      routing_stats: routingStats || [],
      code_exec_stats: codeExecStats || [],
    };
  } catch (err) {
    return { error: err.message, stack: err.stack?.substring(0, 300) };
  }
}
