/**
 * modules/routes/infra-routes.mjs — Infrastructure Routes (v1.0.0, Iter-53)
 *
 * Extracted from http-routes.mjs:
 *   - /health
 *   - /api/metrics, /api/metrics/health
 *   - /api/health/providers
 *   - /api/workspace/*
 *   - /files/*
 */
import { logger } from "../../lib/logger.mjs";
// [R12-T2-FIX] Removed in-memory planner imports — metrics now read from DB directly
// (worker process writes to _planMetrics Map, but api-server is a separate process)
import Database from 'better-sqlite3';
import { getSupervisorStatus, getReviewHistory, getDecisionHistory, getSupervisorMetrics, updateDecisionOutcome, getSupervisorDb, updateEscalationStatus, updateEscalationWithAudit, getEscalationAuditLog, getDashboardOverview } from '../../worker/supervisor-agent.mjs'; // [R14-T3] + [R15-T3] + [R17-T1]
import { getDualModelConfig, updateDualModelConfig } from '../dual-model-stub.mjs'; // [R24-T5]
// [R12-T1-FIX] Recovery APIs now read from DB directly (cross-process safe)

import fs from "fs";
import path from "path";

// ─── [R17-T2] Canonical Tool Match Calculator ───
// Single source of truth for raw/normalized match rates
// Used by both plan-metrics and triplicate-summary
const _SEMANTIC_CATEGORIES = {
  read_like: new Set(['read', 'read_file', 'memory_search', 'memory_get', 'web_search', 'web_fetch', 'image', 'canvas', 'code']),
  write_like: new Set(['write', 'write_file', 'edit', 'edit_file', 'create_file', 'prose']),
  browser_like: new Set(['browser_navigate', 'browser_screenshot', 'browser_extract_text', 'browser_click', 'browser']),
  network_like: new Set(['web_search', 'web_fetch']),
};
const _EXEC_INSPECT_PATTERNS = [
  /^\s*(cat|head|tail|less|more)\s/,
  /^\s*(ls|find|locate|which|whereis)\s/,
  /^\s*(grep|rg|ag|ack)\s/,
  /^\s*(wc|du|df|stat|file)\s/,
  /^\s*(ps|top|htop|free|uptime|vmstat|iostat)\s/,
  /^\s*(echo|printf)\s/,
  /^\s*git\s+(log|status|diff|show|branch|tag)\s/,
  /^\s*systemctl\s+(status|is-active|is-enabled|list-units)\s/,
  /^\s*journalctl\s/,
  /^\s*curl\s/,
  /^\s*sqlite3\s+.*SELECT/i,
  /^\s*sed\s+-n\s/,
  /^\s*awk\s/,
  /^\s*sort\s/,
  /^\s*uniq\s/,
  /^\s*cut\s/,
  /^\s*diff\s/,
];
const _TITLE_INSPECT_KW = /查看|确认|核对|检查|收集|读取|检索|分析|对比|审查|验证|盘点|识别|梳理|了解|review|check|inspect|read|verify|analyze|compare|collect/i;
const _TITLE_WRITE_KW = /记录|输出|生成|写入|创建|制定|起草|编写|修改|更新|实现|导出|部署|安装|配置|write|create|generate|output|deploy|install|update|implement|export/i;

function _canonicalNormalizeTool(rawTool, execArgs, stepTitle) {
  const t = (rawTool || '').toLowerCase().trim();
  if (t === 'exec') {
    const cmd = (execArgs || '').trim();
    if (cmd) {
      if (_EXEC_INSPECT_PATTERNS.some(p => p.test(cmd))) return 'inspect_like';
      if (/systemctl\s+(restart|stop|start)/.test(cmd) || /rm\s+-rf/.test(cmd) || /docker\s+(rm|stop|kill)/.test(cmd)) return 'shell_critical';
      return 'shell_like';
    }
    const title = (stepTitle || '').trim();
    if (title) {
      if (_TITLE_INSPECT_KW.test(title)) return 'inspect_like';
      if (_TITLE_WRITE_KW.test(title)) return 'write_like';
    }
    return 'shell_like';
  }
  if (_SEMANTIC_CATEGORIES.browser_like.has(t)) return 'browser_like';
  if (_SEMANTIC_CATEGORIES.write_like.has(t)) return 'write_like';
  if (_SEMANTIC_CATEGORIES.read_like.has(t)) return 'read_like';
  if (_SEMANTIC_CATEGORIES.network_like.has(t)) return 'network_like';
  return t;
}

function _canonicalNormalizeHint(hint) {
  const h = (hint || '').toLowerCase().trim();
  if (h === 'read') return 'read_like';
  if (h === 'write') return 'write_like';
  if (h === 'exec') return 'shell_like';
  if (h === 'shell') return 'shell_like';
  if (h === 'all') return 'all';
  if (h === 'none') return 'none';
  if (h === 'inspect' || h === 'inspect_system') return 'inspect_like';
  if (h === 'browser' || h === 'browser_check' || h === 'browser_extract' || h === 'browser_click' || h === 'browser_screenshot') return 'browser_like';
  if (h === 'web_search' || h === 'search') return 'network_like';
  return h;
}

function _canonicalSemanticMatch(normalizedPlan, normalizedActual) {
  if (normalizedPlan === 'all') return true;
  if (normalizedPlan === normalizedActual) return true;
  if (normalizedPlan === 'read_like' && (normalizedActual === 'inspect_like' || normalizedActual === 'network_like')) return true;
  if (normalizedPlan === 'shell_like' && normalizedActual === 'inspect_like') return true;
  if (normalizedPlan === 'write_like' && normalizedActual === 'shell_like') return true;
  if (normalizedPlan === 'inspect_like' && normalizedActual === 'read_like') return true;
  return false;
}

/**
 * [R17-T2] Compute raw + normalized match rates from plan rows.
 * Returns { rawMatched, rawTotal, normMatched, normTotal, rawMismatchCounts, normMismatchCounts }
 */
function computeCanonicalMatchRates(rows) {
  const rawMismatchCounts = {};
  let rawMatched = 0, rawTotal = 0;
  const normMismatchCounts = {};
  let normMatched = 0, normTotal = 0;

  for (const r of rows) {
    let plan = {};
    try { plan = JSON.parse(typeof r === 'string' ? r : (r.plan_json || '{}')); } catch (_) {}
    const steps = plan.steps || [];
    for (const s of steps) {
      if (s.status !== 'done') continue;
      const titleMatch = (s.title || '').match(/\[tools?:\s*([^\]]+)\]/);
      const plannedTools = titleMatch ? titleMatch[1].split(',').map(t => t.trim().toLowerCase()) : (s.tools || []).map(t => t.toLowerCase());
      const actualTool = (s.output || '').replace(' completed', '').trim().toLowerCase();
      if (plannedTools.length === 0 && !actualTool) continue;

      // RAW
      rawTotal++;
      if (plannedTools.length === 0 || plannedTools.includes('all') || plannedTools.includes(actualTool)) {
        rawMatched++;
      } else {
        const key = `planned:${plannedTools.join('+')} \u2192 actual:${actualTool || 'none'}`;
        rawMismatchCounts[key] = (rawMismatchCounts[key] || 0) + 1;
      }

      // NORMALIZED
      normTotal++;
      const normalizedActual = _canonicalNormalizeTool(actualTool, '', s.title || '');
      const normalizedPlanned = plannedTools.map(_canonicalNormalizeHint);
      if (normalizedPlanned.length === 0 || normalizedPlanned.some(np => _canonicalSemanticMatch(np, normalizedActual))) {
        normMatched++;
      } else {
        const key = `planned:${normalizedPlanned.join('+')} \u2192 actual:${normalizedActual}`;
        normMismatchCounts[key] = (normMismatchCounts[key] || 0) + 1;
      }
    }
  }
  return { rawMatched, rawTotal, normMatched, normTotal, rawMismatchCounts, normMismatchCounts };
}
// ─── End Canonical Calculator ───
import metrics from '../../lib/metrics-collector.mjs';
import { getHealthStatus } from "../../worker/health-monitor.mjs";

let deps = {};

export function init(dependencies) {
  deps = dependencies;
}

/**
 * Try to handle an infra route. Returns true if handled.
 */
export async function handleInfraRoute(req, res, urlPath) {
  // ── Public Metrics Health (no auth required) ──
  if (urlPath === '/api/metrics/health') {
    // H3+M1: Require auth for detailed metrics
    if (!req._authenticatedUser) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return true;
    }
    return metricsHealth(req, res);
  }
  if (req.url === "/health") {
    return handleHealth(req, res);
  }
  if (req.url === "/api/metrics") {
    return handleMetrics(req, res);
  }
  if (req.url === "/api/health/providers" || req.url?.startsWith("/api/health/providers?")) {
    return handleProviderHealthCheck(req, res);
  }

  // ─── [R12-T1] Recovery Plans API ───
  if (urlPath === '/api/admin/recovery-plans' && req.method === 'GET') {
    try {
      const dbPath = process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const db = new Database(dbPath, { readonly: true });
      const sessionKey = new URL(req.url, 'http://localhost').searchParams.get('sessionKey');
      let plans;
      if (sessionKey) {
        plans = db.prepare("SELECT msg_id, session_key, status, plan_version, step_count, steps_completed, goal, plan_json, created_at, updated_at FROM task_plans WHERE session_key = ? AND status = 'active' ORDER BY updated_at DESC").all(sessionKey);
      } else {
        plans = db.prepare("SELECT msg_id, session_key, status, plan_version, step_count, steps_completed, goal, created_at, updated_at FROM task_plans WHERE status = 'active' ORDER BY updated_at DESC LIMIT 20").all();
      }
      db.close();
      const result = plans.map(p => {
        let parsed = {};
        try { parsed = JSON.parse(p.plan_json || '{}'); } catch (_) {}
        const steps = parsed.steps || [];
        const pendingSteps = steps.filter(s => s.status === 'pending' || s.status === 'doing');
        return { taskId: p.msg_id, session: p.session_key, status: p.status, version: p.plan_version, goal: p.goal, totalSteps: p.step_count, completedSteps: p.steps_completed, pendingSteps: pendingSteps.length, nextStep: pendingSteps[0]?.title || null, created: p.created_at, updated: p.updated_at };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plans: result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }
  if (urlPath === '/api/admin/resume-plan' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { msgId } = JSON.parse(body);
      const dbPath = process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT msg_id, plan_json, status, step_count, steps_completed FROM task_plans WHERE msg_id = ? AND status = 'active'").get(msgId);
      db.close();
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No resumable plan found' }));
        return true;
      }
      let plan = {};
      try { plan = JSON.parse(row.plan_json || '{}'); } catch (_) {}
      const steps = plan.steps || [];
      const currentStep = steps.find(s => s.status === 'doing') || steps.find(s => s.status === 'pending');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, msgId, totalSteps: row.step_count, completedSteps: row.steps_completed, currentStep: currentStep ? { id: currentStep.id, title: currentStep.title, status: currentStep.status } : null }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── [R12-T2-FIX] Plan Driving Metrics API — reads from DB (cross-process safe) ───
  if (urlPath === '/api/admin/plan-metrics' && req.method === 'GET') {
    try {
      const dbPath = process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const db = new Database(dbPath, { readonly: true });
      const taskId = new URL(req.url, 'http://localhost').searchParams.get('taskId');
      let result;
      if (taskId) {
        const row = db.prepare('SELECT msg_id, session_key, status, plan_version, step_count, steps_completed, goal, plan_json, created_at, updated_at FROM task_plans WHERE msg_id = ?').get(taskId);
        if (row) {
          let plan = {};
          try { plan = JSON.parse(row.plan_json || '{}'); } catch (_) {}
          const steps = plan.steps || [];
          const totalActions = steps.length;
          const doneSteps = steps.filter(s => s.status === 'done').length;
          const withExpectedTools = steps.filter(s => s.expectedTools && s.expectedTools.length > 0).length;
          result = { taskId: row.msg_id, status: row.status, planVersion: row.plan_version, goal: row.goal, totalSteps: row.step_count, completedSteps: row.steps_completed, doneSteps, withExpectedTools, createdAt: row.created_at, updatedAt: row.updated_at };
        } else {
          result = { error: 'No plan found for taskId' };
        }
      } else {
        const rows = db.prepare('SELECT msg_id, session_key, status, plan_version, step_count, steps_completed, goal, plan_json, created_at, updated_at FROM task_plans ORDER BY updated_at DESC LIMIT 50').all();
        const totalTasks = rows.length;
        const completedTasks = rows.filter(r => r.status === 'completed').length;
        const activeTasks = rows.filter(r => r.status === 'active').length;
        const totalSteps = rows.reduce((s, r) => s + (r.step_count || 0), 0);
        const totalCompleted = rows.reduce((s, r) => s + (r.steps_completed || 0), 0);
        const completionRate = totalSteps > 0 ? (totalCompleted / totalSteps).toFixed(3) : '0.000';

        // ─── [R17-T2] Use canonical calculator — single source of truth ───
        const { rawMatched, rawTotal, normMatched, normTotal, rawMismatchCounts, normMismatchCounts } = computeCanonicalMatchRates(rows);
        const rawMismatched = rawTotal - rawMatched;
        const normMismatched = normTotal - normMatched;

        // Top mismatched pairs
        const topRawMismatched = Object.entries(rawMismatchCounts)
          .sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([pattern, count]) => ({ pattern, count }));
        const topNormMismatched = Object.entries(normMismatchCounts)
          .sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([pattern, count]) => ({ pattern, count }));

        // ─── Deviation explanations ───
        const rawRate = rawTotal > 0 ? (rawMatched / rawTotal) : 0;
        const normRate = normTotal > 0 ? (normMatched / normTotal) : 0;
        const explanations = [];
        const improvementPct = rawTotal > 0 ? ((normRate - rawRate) * 100) : 0;
        if (improvementPct > 10) {
          explanations.push(`[R16] Title-based 二次归类生效: normalized 比 raw 提升 ${improvementPct.toFixed(1)}%。exec 命令通过 step title 语义（查看/确认/核对 → inspect_like; 记录/输出/生成 → write_like）完成了二次归类。`);
        }
        if (rawRate < 0.5 && normRate > rawRate + 0.05) {
          explanations.push('大量 planned:read 实际落为 exec，是因为生产中通过 shell 执行 grep/sed/head 完成只读检查。R16 通过 title 语义归类将这些 exec 识别为 inspect_like，与 read_like 语义匹配。');
        }
        if (rawMismatchCounts['planned:read → actual:exec'] > 5) {
          explanations.push(`read→exec 偏差 (${rawMismatchCounts['planned:read → actual:exec']}次): Planner 标注 [tools: read] 但实际使用 exec。R16 通过 title 语义将其中大部分归为 inspect_like（与 read_like 匹配）。`);
        }
        if (rawMismatchCounts['planned:write → actual:exec'] > 3) {
          explanations.push(`write→exec 偏差 (${rawMismatchCounts['planned:write → actual:exec']}次): Planner 标注 [tools: write] 但实际通过 exec 执行。R16 通过 title 语义将写入类 exec 归为 write_like，或通过 write_like≈shell_like 语义匹配。`);
        }
        if (normRate > 0.6) {
          explanations.push('normalized 匹配率 >60%，说明 Planner 的语义判断基本正确。Title-based 归类 + 扩展语义匹配已有效修正了工具分类口径偏差。');
        }

        const abTest = {
          raw: {
            totalStepsAnalyzed: rawTotal,
            matched: rawMatched,
            mismatched: rawMismatched,
            matchRate: rawTotal > 0 ? (rawMatched / rawTotal).toFixed(3) : '0.000',
            topMismatchedPairs: topRawMismatched,
          },
          normalized: {
            totalStepsAnalyzed: normTotal,
            matched: normMatched,
            mismatched: normMismatched,
            matchRate: normTotal > 0 ? (normMatched / normTotal).toFixed(3) : '0.000',
            topMismatchedPairs: topNormMismatched,
          },
          improvement: rawTotal > 0 ? ((normRate - rawRate) * 100).toFixed(1) + '%' : '0.0%',
          deviationExplanations: explanations,
        };

        // ─── [R16-T5] Planner hint type distribution ───
        const hintDistribution = {};
        const actualDistribution = {};
        for (const r of rows) {
          let plan = {};
          try { plan = JSON.parse(r.plan_json || '{}'); } catch (_) {}
          for (const s of (plan.steps || [])) {
            const titleMatch = (s.title || '').match(/\[tools?:\s*([^\]]+)\]/);
            const hints = titleMatch ? titleMatch[1].split(',').map(t => t.trim().toLowerCase()) : (s.tools || []).map(t => t.toLowerCase());
            for (const h of hints) {
              hintDistribution[h] = (hintDistribution[h] || 0) + 1;
            }
            if (s.status === 'done') {
              const actual = (s.output || '').replace(' completed', '').trim().toLowerCase();
              if (actual) actualDistribution[actual] = (actualDistribution[actual] || 0) + 1;
            }
          }
        }
        // Sort by count descending
        const sortedHints = Object.entries(hintDistribution).sort((a, b) => b[1] - a[1]).map(([hint, count]) => ({ hint, count }));
        const sortedActuals = Object.entries(actualDistribution).sort((a, b) => b[1] - a[1]).map(([tool, count]) => ({ tool, count }));
        // Check for new R15+ hint types
        const newHintTypes = ['inspect', 'shell', 'browser', 'web_search', 'none'];
        const newHintUsage = newHintTypes.map(h => ({ hint: h, count: hintDistribution[h] || 0 }));
        const totalHints = Object.values(hintDistribution).reduce((s, v) => s + v, 0);
        const newHintTotal = newHintUsage.reduce((s, h) => s + h.count, 0);

        result = {
          aggregate: { totalTasks, completedTasks, activeTasks, totalSteps, totalCompleted, step_completion_rate: completionRate },
          ab_test: abTest,
          hintDistribution: {
            planned: sortedHints,
            actual: sortedActuals,
            newHintAdoption: {
              types: newHintUsage,
              totalNewHints: newHintTotal,
              totalHints,
              adoptionRate: totalHints > 0 ? (newHintTotal / totalHints * 100).toFixed(1) + '%' : '0%',
              note: newHintTotal === 0 ? 'No tasks have used R15+ hint types yet. New hint types (inspect/shell/browser/web_search/none) will appear in tasks created after R15 deployment.' : 'R15+ hint types are being adopted.',
            },
          },
          tasks: rows.map(r => ({ taskId: r.msg_id, session: r.session_key, status: r.status, version: r.plan_version, steps: r.step_count, completed: r.steps_completed, goal: r.goal, created: r.created_at, updated: r.updated_at }))
        };
      }
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // [R13-T1] Context Stats API
  if (urlPath === '/api/admin/context-stats' && req.method === 'GET') {
    try {
      const workerDbPath = '/opt/rangerai-agent/db/rangerai.db';
      const db = new Database(workerDbPath, { readonly: true });
      const params = new URL(req.url, 'http://localhost').searchParams;
      const sessionKey = params.get('sessionKey');
      const hours = parseInt(params.get('hours') || '24', 10);
      const since = Date.now() - hours * 3600 * 1000;

      let result;
      if (sessionKey) {
        // Per-session history
        const rows = db.prepare('SELECT * FROM context_compression_log WHERE session_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 200').all(sessionKey, since);
        result = { sessionKey, hours, records: rows.map(r => ({ ...r, extra_json: r.extra_json ? JSON.parse(r.extra_json) : null })) };
      } else {
        // Aggregate stats
        const total = db.prepare('SELECT COUNT(*) as cnt FROM context_compression_log WHERE created_at > ?').get(since);
        const byType = db.prepare('SELECT type, COUNT(*) as cnt, SUM(COALESCE(tokens_before,0) - COALESCE(tokens_after,0)) as saved FROM context_compression_log WHERE created_at > ? GROUP BY type').all(since);
        const avgSaved = db.prepare(`SELECT AVG(COALESCE(tokens_before,0) - COALESCE(tokens_after,0)) as avg_saved FROM context_compression_log WHERE created_at > ? AND type IN ('micro','auto')`).get(since);

        // [R13-T2] Sub-agent stats
        const subAgentCompact = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'sub_agent_compact' AND created_at > ?`).get(since);
        const subAgentInject = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'sub_agent_inject' AND created_at > ?`).get(since);
        const subAgentAvgRatio = db.prepare(`SELECT AVG(CAST(json_extract(extra_json, '$.compressionRatio') AS REAL)) as avg FROM context_compression_log WHERE type = 'sub_agent_compact' AND created_at > ?`).get(since);
        const subAgentTruncated = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'sub_agent_compact' AND json_extract(extra_json, '$.truncated') = 1 AND created_at > ?`).get(since);

        // [R13-T3] Checkpoint stats
        const checkpointTotal = db.prepare('SELECT COUNT(*) as cnt FROM context_checkpoints WHERE created_at > ?').get(since);
        const checkpointRestores = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'checkpoint_restore' AND created_at > ?`).get(since);
        const avgTokensAtCp = db.prepare('SELECT AVG(token_estimate) as avg FROM context_checkpoints WHERE created_at > ?').get(since);

        // [R13-T5] Memory stats
        const memoryWarnings = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'memory_limit_warning' AND created_at > ?`).get(since);
        const memoryDecays = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'memory_decay' AND created_at > ?`).get(since);

        // [R13-T7] Tool permission stats
        const toolPermByLevel = db.prepare(`SELECT json_extract(extra_json, '$.riskLevel') as level, COUNT(*) as cnt FROM context_compression_log WHERE type = 'tool_permission_check' AND created_at > ? GROUP BY level`).all(since);

        result = {
          hours,
          totalCompressions: total.cnt,
          byType: byType.reduce((o, r) => { o[r.type] = { count: r.cnt, tokensSaved: r.saved || 0 }; return o; }, {}),
          avgTokensSaved: Math.round(avgSaved.avg_saved || 0),
          subAgentStats: {
            totalCompactions: subAgentCompact.cnt,
            avgCompressionRatio: subAgentAvgRatio.avg ? Math.round(subAgentAvgRatio.avg * 100) / 100 : null,
            truncatedCount: subAgentTruncated.cnt,
            injectionCount: subAgentInject.cnt,
          },
          checkpointStats: {
            totalCheckpoints: checkpointTotal.cnt,
            totalRestores: checkpointRestores.cnt,
            avgTokensAtCheckpoint: Math.round(avgTokensAtCp.avg || 0),
          },
          memoryStats: {
            warningCount: memoryWarnings.cnt,
            decayCount: memoryDecays.cnt,
          },
          toolPermissionStats: toolPermByLevel.reduce((o, r) => { o[r.level || 'unknown'] = r.cnt; return o; }, {}),
        };
      }
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // [R13-T4] KV-Cache Stats API
  if (urlPath === '/api/admin/kv-cache-stats' && req.method === 'GET') {
    try {
      const workerDbPath = '/opt/rangerai-agent/db/rangerai.db';
      const db = new Database(workerDbPath, { readonly: true });
      const params = new URL(req.url, 'http://localhost').searchParams;
      const hours = parseInt(params.get('hours') || '24', 10);
      const since = Date.now() - hours * 3600 * 1000;

      const total = db.prepare(`SELECT COUNT(*) as cnt FROM context_compression_log WHERE type = 'kv_cache_miss' AND created_at > ?`).get(since);
      const sessions = db.prepare(`SELECT COUNT(DISTINCT session_key) as cnt FROM context_compression_log WHERE type = 'kv_cache_miss' AND created_at > ?`).get(since);
      const recent = db.prepare(`SELECT session_key, extra_json, created_at FROM context_compression_log WHERE type = 'kv_cache_miss' AND created_at > ? ORDER BY created_at DESC LIMIT 20`).all(since);

      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hours,
        totalMisses: total.cnt,
        sessionsAffected: sessions.cnt,
        recentMisses: recent.map(r => ({ sessionKey: r.session_key, ...JSON.parse(r.extra_json || '{}'), createdAt: r.created_at })),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // [R44-T2] /api/admin/routing — Model routing configuration
  if (urlPath === '/api/admin/routing' && req.method === 'GET') {
    try {
      const dbWorker = deps.ctx.dbWorker || deps.ctx.db?.raw;
      let routingConfig = {};
      if (dbWorker) {
        try {
          const rows = dbWorker.prepare('SELECT key, value FROM kv_store WHERE key LIKE ?').all('routing_%');
          for (const r of rows) routingConfig[r.key] = r.value;
        } catch(e) { /* no kv_store */ }
      }
      // Also include model_route event stats
      let modelStats = [];
      if (dbWorker) {
        try {
          modelStats = dbWorker.prepare(
            "SELECT json_extract(payload, '$.model') as model, json_extract(payload, '$.provider') as provider, json_extract(payload, '$.role') as role, COUNT(*) as count FROM event_stream WHERE event_type = 'model_route' GROUP BY model, provider, role ORDER BY count DESC LIMIT 20"
          ).all();
        } catch(e) { /* ignore */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, routing: routingConfig, modelStats, timestamp: new Date().toISOString() }));
      return true;
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
  }

  // [R44-T4] /api/admin/debug-timeout — Verify tool_timeout trigger
  if (urlPath === '/api/admin/debug-timeout' && req.method === 'GET') {
    try {
      const { emitEvent, EVENT_TYPES, getEvents } = await import('../../worker/event-stream.mjs');
      
      // Emit a test tool_timeout event
      const testPayload = {
        tool: 'debug_test_tool',
        timeoutMs: 5000,
        thresholdMs: 5000,
        severity: 'soft',
        step: null,
        retryCount: 0,
        key: 'debug-test-' + Date.now(),
        _debug: true,
        triggeredAt: new Date().toISOString(),
      };
      emitEvent('debug-session', 'debug-task-' + Date.now(), EVENT_TYPES.TOOL_TIMEOUT, testPayload);
      
      // Also get recent tool_timeout events
      let recentTimeouts = [];
      try {
        const dbWorker = deps.ctx.dbWorker || deps.ctx.db?.raw;
        if (dbWorker) {
          recentTimeouts = dbWorker.prepare(
            "SELECT * FROM event_stream WHERE event_type = 'tool_timeout' ORDER BY created_at DESC LIMIT 5"
          ).all();
        }
      } catch(e) { /* ignore */ }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: 'tool_timeout test event emitted',
        testPayload,
        recentTimeouts,
        config: {
          SINGLE_TOOL_MAX_MS: parseInt(process.env.DEBUG_TIMEOUT_MS) || 120000,
          SINGLE_TOOL_HARD_MS: parseInt(process.env.DEBUG_TIMEOUT_MS) ? parseInt(process.env.DEBUG_TIMEOUT_MS) * 2 : 180000,
          DEBUG_TIMEOUT_MS: process.env.DEBUG_TIMEOUT_MS || 'not set',
        },
      }));
      return true;
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return true;
    }
  }


  // [R13-T3] Checkpoints API
  if (urlPath === '/api/admin/checkpoints' && req.method === 'GET') {
    try {
      const workerDbPath = '/opt/rangerai-agent/db/rangerai.db';
      const db = new Database(workerDbPath, { readonly: true });
      const params = new URL(req.url, 'http://localhost').searchParams;
      const sessionKey = params.get('sessionKey');
      const msgId = params.get('msgId');
      const limit = parseInt(params.get('limit') || '50', 10);

      let rows;
      if (sessionKey && msgId) {
        rows = db.prepare('SELECT id, session_key, msg_id, step_id, token_estimate, created_at FROM context_checkpoints WHERE session_key = ? AND msg_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionKey, msgId, limit);
      } else if (sessionKey) {
        rows = db.prepare('SELECT id, session_key, msg_id, step_id, token_estimate, created_at FROM context_checkpoints WHERE session_key = ? ORDER BY created_at DESC LIMIT ?').all(sessionKey, limit);
      } else {
        rows = db.prepare('SELECT id, session_key, msg_id, step_id, token_estimate, created_at FROM context_checkpoints ORDER BY created_at DESC LIMIT ?').all(limit);
      }

      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: rows.length, checkpoints: rows }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── Workspace API ───
  if (req.url?.startsWith("/api/workspace/") || req.url?.startsWith("/workspace/")) {
    const wsUser = await deps.ctx.db.extractUserFromRequest(req);
    if (!wsUser) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication required" }));
      return true;
    }
  }
  if (req.url?.startsWith("/api/workspace/tree") && req.method === "GET") {
    handleWorkspaceTree(req, res); return true;
  }
  if (req.url?.startsWith("/api/workspace/file") && req.method === "GET") {
    handleWorkspaceFile(req, res); return true;
  }
  if (req.url?.startsWith("/workspace/")) {
    handleWorkspaceServe(req, res); return true;
  }

  // ─── File Serving ───
  if (req.url?.startsWith("/files/")) {
    handleFilesServe(req, res); return true;
  }

  // [R14-T3] Supervisor Status API
  if (urlPath === '/api/admin/supervisor-status' && req.method === 'GET') {
    try {
      const status = getSupervisorStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // [R15-T3] Supervisor Reviews API
  if (urlPath === '/api/admin/supervisor-reviews' && req.method === 'GET') {
    try {
      const _svUrl = new URL(req.url, 'http://localhost');
      const limit = parseInt(_svUrl.searchParams?.get('limit') || '20', 10);
      const reviews = getReviewHistory(limit);
      const status = getSupervisorStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        supervisor: status,
        reviews,
        total: reviews.length,
        riskSummary: {
          high: reviews.filter(r => r.riskLevel === 'high' || (r.risks || []).some(x => x.level === 'high')).length,
          medium: reviews.filter(r => r.riskLevel === 'medium' || (r.risks || []).some(x => x.level === 'medium')).length,
          low: reviews.filter(r => r.riskLevel === 'low').length,
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── [R17-T1] Supervisor Decisions: intervention tracking ───
  if (urlPath === '/api/admin/supervisor-decisions' && req.method === 'GET') {
    try {
      const _sdUrl = new URL(req.url, 'http://localhost');
      const limit = parseInt(_sdUrl.searchParams?.get('limit') || '50', 10);
      const decisions = getDecisionHistory(limit);
      const actionDist = {};
      decisions.forEach(d => { actionDist[d.decisionAction] = (actionDist[d.decisionAction] || 0) + 1; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        decisions,
        total: decisions.length,
        actionDistribution: actionDist,
        hasIntervention: decisions.some(d => d.decisionAction !== 'allow'),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  
  
  // ─── [R18-T2] Browser Evidence Screenshot File Serving ───
  if (urlPath.startsWith('/api/admin/browser-screenshot/') && req.method === 'GET') {
    try {
      const fs = await import('fs');
      const path = await import('path');
      // Extract evidence ID from URL
      const evidenceId = parseInt(urlPath.split('/').pop(), 10);
      if (isNaN(evidenceId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid evidence ID' }));
        return true;
      }
      const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });
      const row = dbWorker.prepare('SELECT file_path FROM browser_evidence WHERE id = ? AND evidence_type = ?').get(evidenceId, 'screenshot');
      dbWorker.close();
      if (!row || !row.file_path) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Screenshot not found' }));
        return true;
      }
      const filePath = row.file_path;
      if (!fs.default.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Screenshot file missing from disk' }));
        return true;
      }
      const ext = path.default.extname(filePath).toLowerCase();
      const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.default.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=3600',
      });
      fs.default.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }
  // ─── [R18-T4] Task Focus / Todo Anchor ───
  if (urlPath === '/api/admin/task-focus' && req.method === 'GET') {
    try {
      const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });
      // Ensure table exists
      try {
        dbWorker.exec(`
          CREATE TABLE IF NOT EXISTS task_focus (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            task_id TEXT,
            title TEXT,
            current_goal TEXT,
            next_action TEXT,
            status TEXT DEFAULT 'active',
            step_count INTEGER DEFAULT 0,
            steps_completed INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now')),
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
      } catch (e) { /* table exists or readonly */ }
      const focusParams = new URL(req.url, 'http://localhost').searchParams;
      const limit = Math.min(parseInt(focusParams.get('limit') || '20', 10), 100);
      const statusFilter = focusParams.get('status');
      let sql = 'SELECT * FROM task_focus';
      const conditions = [];
      const params = [];
      if (statusFilter) { conditions.push('status = ?'); params.push(statusFilter); }
      if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(limit);
      const rows = dbWorker.prepare(sql).all(...params);
      const totalActive = dbWorker.prepare("SELECT COUNT(*) as cnt FROM task_focus WHERE status = 'active'").get()?.cnt || 0;
      const totalCompleted = dbWorker.prepare("SELECT COUNT(*) as cnt FROM task_focus WHERE status = 'completed'").get()?.cnt || 0;
      const totalFailed = dbWorker.prepare("SELECT COUNT(*) as cnt FROM task_focus WHERE status = 'failed'").get()?.cnt || 0;
      dbWorker.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        focuses: rows.map(r => ({
          id: r.id,
          sessionId: r.session_id,
          taskId: r.task_id,
          title: r.title,
          currentGoal: r.current_goal,
          nextAction: r.next_action,
          status: r.status,
          stepCount: r.step_count,
          stepsCompleted: r.steps_completed,
          updatedAt: r.updated_at,
          createdAt: r.created_at,
        })),
        summary: {
          total: rows.length,
          active: totalActive,
          completed: totalCompleted,
          failed: totalFailed,
        },
      }));
    } catch (err) {
      if (err.message && err.message.includes('no such table')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ focuses: [], summary: { total: 0, active: 0, completed: 0, failed: 0, note: 'task_focus table not yet created' } }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return true;
  }

  
  
  
  
  // ─── [R19-T5] Browser Evidence by Task Focus ───
  if (urlPath.match(/^\/api\/admin\/task-focus\/\d+\/evidence$/) && req.method === 'GET') {
    try {
      const focusId = urlPath.split('/')[4];
      const db = getSupervisorDb();
      const rows = db.prepare('SELECT id, session_id, evidence_type, url, title, text_content, created_at, task_focus_id FROM browser_evidence WHERE task_focus_id = ? ORDER BY id DESC').all(parseInt(focusId));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, evidence: rows }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R19-T4] Task Focus Timeline API ───
  if (urlPath.match(/^\/api\/admin\/task-focus\/\d+\/timeline$/) && req.method === 'GET') {
    try {
      const focusId = urlPath.split('/')[4];
      const { getTaskFocusTimeline } = await import('../../worker/supervisor-agent.mjs');
      const timeline = getTaskFocusTimeline(parseInt(focusId));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, timeline }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R19-T2] Tickets API ───
  if (urlPath === '/api/admin/tickets' && req.method === 'GET') {
    try {
      const db = getSupervisorDb();
      const rows = db.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT 50').all();
      const stats = {
        total: db.prepare('SELECT COUNT(*) as cnt FROM tickets').get()?.cnt || 0,
        open: db.prepare("SELECT COUNT(*) as cnt FROM tickets WHERE status = 'open'").get()?.cnt || 0,
        byType: db.prepare('SELECT type, COUNT(*) as cnt FROM tickets GROUP BY type').all(),
        byRiskLevel: db.prepare('SELECT risk_level, COUNT(*) as cnt FROM tickets GROUP BY risk_level').all(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tickets: rows, stats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R19-T2] Resolve ticket ───
  if (urlPath.match(/^\/api\/admin\/tickets\/\d+\/resolve$/) && req.method === 'POST') {
    try {
      const ticketId = urlPath.split('/')[4];
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { status } = JSON.parse(body || '{}');
          const newStatus = status || 'resolved';
          const db = getSupervisorDb();
          db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, ticketId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (parseErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: parseErr.message }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R19-T1] Hint Adoption Stats API ───
  if (urlPath === '/api/admin/hint-adoption-stats' && req.method === 'GET') {
    try {
      const planner = await import('../../worker/planner.mjs');
      const stats = planner.getHintAdoptionStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: stats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R18-T1] Supervisor Metrics: aggregated decision statistics ───
  if (urlPath === '/api/admin/supervisor-metrics' && req.method === 'GET') {
    try {
      const metrics = getSupervisorMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // [R20-T5] Supervisor escalation status update
  if (urlPath === '/api/admin/supervisor-escalation' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { decisionId, status, action, note, operatorId } = JSON.parse(body);
          if (!decisionId || !status) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'decisionId and status required' }));
            return;
          }
          const validStatuses = ["pending", "escalated", "acknowledged", "resolved", "dismissed", "approved", "rejected"];
          if (!validStatuses.includes(status)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid status' }));
            return;
          }
          const ok = updateEscalationWithAudit(decisionId, status, action || "escalation_update", operatorId || "admin", note || "");
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R18-T1] Update decision outcome ───

  // [R21-T2] Escalation audit log endpoint
  if (urlPath === "/api/admin/escalation-audit" && req.method === "GET") {
    try {
      const params = new URLSearchParams(req.url.split("?")[1] || "");
      const decisionId = params.get("decisionId");
      const logs = getEscalationAuditLog(decisionId ? parseInt(decisionId) : null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, logs }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // [R21-T3] Dashboard Overview KPI endpoint
  if (urlPath === "/api/admin/dashboard-overview" && req.method === "GET") {
    try {
      const data = getDashboardOverview();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (urlPath === '/api/admin/supervisor-decision-outcome' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { decisionId, outcome, overrideByUser } = JSON.parse(body);
          if (!decisionId || !outcome) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'decisionId and outcome required' }));
            return;
          }
          const ok = updateDecisionOutcome(decisionId, outcome, !!overrideByUser);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: ok }));
        } catch (parseErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }
  // ─── [R16-T3] Task Trace: unified timeline for a single task ───
  if (urlPath === '/api/admin/task-trace' && req.method === 'GET') {
    try {
      const traceParams = new URL(req.url, 'http://localhost').searchParams;
      const taskId = traceParams.get('taskId');
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'taskId required' }));
        return true;
      }
      const dbMain = new Database(process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db', { readonly: true });
      const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });

      // 1. Plan data
      const planRow = dbMain.prepare('SELECT msg_id, session_key, status, plan_version, step_count, steps_completed, goal, plan_json, created_at, updated_at FROM task_plans WHERE msg_id = ?').get(taskId);
      let planSteps = [];
      let traceSessionKey = null;
      if (planRow) {
        traceSessionKey = planRow.session_key;
        try {
          const plan = JSON.parse(planRow.plan_json || '{}');
          planSteps = (plan.steps || []).map(s => ({
            id: s.id,
            title: s.title,
            status: s.status,
            tools: s.tools || [],
            output: s.output || null,
          }));
        } catch (_) {}
      }

      // 2. Compression events for this session
      let compressions = [];
      if (traceSessionKey) {
        compressions = dbWorker.prepare(
          'SELECT type, trigger_ratio, msgs_before, msgs_after, tokens_before, tokens_after, created_at FROM context_compression_log WHERE session_key = ? ORDER BY created_at ASC'
        ).all(traceSessionKey).map(r => ({
          type: r.type,
          triggerRatio: r.trigger_ratio,
          msgsBefore: r.msgs_before,
          msgsAfter: r.msgs_after,
          tokensBefore: r.tokens_before,
          tokensAfter: r.tokens_after,
          timestamp: r.created_at,
        }));
      }

      // 3. Checkpoints for this task
      let traceCheckpoints = [];
      traceCheckpoints = dbWorker.prepare(
        'SELECT step_id, token_estimate, created_at FROM context_checkpoints WHERE msg_id = ? ORDER BY created_at ASC'
      ).all(taskId).map(r => ({
        stepId: r.step_id,
        tokenEstimate: r.token_estimate,
        timestamp: r.created_at,
      }));

      // 4. Supervisor reviews for this task
      let traceReviews = [];
      try {
        traceReviews = dbWorker.prepare(
          'SELECT type, risk_level, score, step_count, feedback, stub, created_at FROM supervisor_reviews WHERE task_id = ? ORDER BY created_at ASC'
        ).all(taskId).map(r => ({
          type: r.type,
          riskLevel: r.risk_level,
          score: r.score,
          feedback: r.feedback,
          stub: !!r.stub,
          timestamp: r.created_at,
        }));
      } catch (_) {}

      // 5. Trace spans
      const spans = dbMain.prepare(
        'SELECT span_name, started_at, ended_at, duration_ms, status, meta FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC'
      ).all(taskId).map(r => ({
        name: r.span_name,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        status: r.status,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch(_) { return null; } })() : null,
      }));

      dbMain.close();
      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        taskId,
        sessionKey: traceSessionKey,
        plan: planRow ? {
          status: planRow.status,
          version: planRow.plan_version,
          goal: planRow.goal,
          totalSteps: planRow.step_count,
          completedSteps: planRow.steps_completed,
          createdAt: planRow.created_at,
          updatedAt: planRow.updated_at,
        } : null,
        timeline: {
          planSteps,
          compressions,
          checkpoints: traceCheckpoints,
          supervisorReviews: traceReviews,
          traceSpans: spans,
        },
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── [R16-T3] Triplicate Summary: Planner vs Executor vs Supervisor ───
  if (urlPath === '/api/admin/triplicate-summary' && req.method === 'GET') {
    try {
      const dbMain = new Database(process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db', { readonly: true });
      const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });

      // Planner stats — [R17-T2] uses canonical calculator for consistency
      const planRows = dbMain.prepare('SELECT status, step_count, steps_completed, plan_json FROM task_plans ORDER BY updated_at DESC LIMIT 50').all();
      const triTotalTasks = planRows.length;
      const triCompletedTasks = planRows.filter(r => r.status === 'completed').length;
      let triTotalPlannedSteps = 0, triTotalExecutedSteps = 0;
      for (const r of planRows) {
        triTotalPlannedSteps += r.step_count || 0;
        triTotalExecutedSteps += r.steps_completed || 0;
      }
      // Use canonical calculator — same logic as plan-metrics
      const triMatch = computeCanonicalMatchRates(planRows);

      // Executor stats
      const compressionCount = dbWorker.prepare('SELECT COUNT(*) as cnt FROM context_compression_log').get()?.cnt || 0;
      const checkpointCount = dbWorker.prepare('SELECT COUNT(*) as cnt FROM context_checkpoints').get()?.cnt || 0;
      const avgTokensSaved = dbWorker.prepare('SELECT AVG(tokens_before - tokens_after) as avg_saved FROM context_compression_log WHERE tokens_before > 0').get()?.avg_saved || 0;

      // Supervisor stats
      let supervisorTotal = 0, supervisorHighRisk = 0, triAvgScore = 0;
      try {
        supervisorTotal = dbWorker.prepare('SELECT COUNT(*) as cnt FROM supervisor_reviews').get()?.cnt || 0;
        supervisorHighRisk = dbWorker.prepare("SELECT COUNT(*) as cnt FROM supervisor_reviews WHERE risk_level = 'high'").get()?.cnt || 0;
        triAvgScore = dbWorker.prepare('SELECT AVG(score) as avg FROM supervisor_reviews WHERE score IS NOT NULL').get()?.avg || 0;
      } catch (_) {}

      dbMain.close();
      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        planner: {
          totalTasks: triTotalTasks,
          completedTasks: triCompletedTasks,
          completionRate: triTotalTasks > 0 ? (triCompletedTasks / triTotalTasks * 100).toFixed(1) + '%' : '0%',
          totalPlannedSteps: triTotalPlannedSteps,
          totalExecutedSteps: triTotalExecutedSteps,
          stepExecutionRate: triTotalPlannedSteps > 0 ? (triTotalExecutedSteps / triTotalPlannedSteps * 100).toFixed(1) + '%' : '0%',
          toolMatchRate: {
            raw: triMatch.rawTotal > 0 ? (triMatch.rawMatched / triMatch.rawTotal * 100).toFixed(1) + '%' : '0%',
            normalized: triMatch.normTotal > 0 ? (triMatch.normMatched / triMatch.normTotal * 100).toFixed(1) + '%' : '0%',
            improvement: triMatch.rawTotal > 0 ? (((triMatch.normMatched / triMatch.normTotal) - (triMatch.rawMatched / triMatch.rawTotal)) * 100).toFixed(1) + '%' : '0%',
          },
        },
        executor: {
          totalCompressions: compressionCount,
          totalCheckpoints: checkpointCount,
          avgTokensSaved: Math.round(avgTokensSaved),
        },
        supervisor: {
          totalReviews: supervisorTotal,
          highRiskCount: supervisorHighRisk,
          avgScore: triAvgScore ? triAvgScore.toFixed(2) : '0.00',
        },
        verdict: {
          plannerHealthy: triMatch.normTotal > 0 && (triMatch.normMatched / triMatch.normTotal) > 0.5,
          executorHealthy: compressionCount > 0 || checkpointCount > 0,
          supervisorHealthy: supervisorTotal > 0,
          allHealthy: (triMatch.normTotal > 0 && (triMatch.normMatched / triMatch.normTotal) > 0.5) && (compressionCount > 0 || checkpointCount > 0) && supervisorTotal > 0,
        },
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ─── [R16-T4] Browser Action Log Query ───
  if (urlPath === '/api/admin/browser-actions' && req.method === 'GET') {
    try {
      const baParams = new URL(req.url, 'http://localhost').searchParams;
      const limit = Math.min(parseInt(baParams.get('limit') || '50', 10), 200);
      const sessionFilter = baParams.get('sessionId');
      const actionFilter = baParams.get('action');

      const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });

      let sql = 'SELECT id, session_id, action, url, selector, success, title, status_code, text_length, error_msg, duration_ms, created_at FROM browser_action_log';
      const conditions = [];
      const params = [];
      if (sessionFilter) { conditions.push('session_id = ?'); params.push(sessionFilter); }
      if (actionFilter) { conditions.push('action = ?'); params.push(actionFilter); }
      if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);

      const rows = dbWorker.prepare(sql).all(...params);

      // Summary stats
      const totalActions = dbWorker.prepare('SELECT COUNT(*) as cnt FROM browser_action_log').get()?.cnt || 0;
      const successCount = dbWorker.prepare('SELECT COUNT(*) as cnt FROM browser_action_log WHERE success = 1').get()?.cnt || 0;
      const avgDuration = dbWorker.prepare('SELECT AVG(duration_ms) as avg FROM browser_action_log WHERE duration_ms IS NOT NULL').get()?.avg || 0;
      const actionBreakdown = dbWorker.prepare('SELECT action, COUNT(*) as cnt FROM browser_action_log GROUP BY action').all();

      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        actions: rows.map(r => ({
          id: r.id,
          sessionId: r.session_id,
          action: r.action,
          url: r.url,
          selector: r.selector,
          success: !!r.success,
          title: r.title,
          statusCode: r.status_code,
          textLength: r.text_length,
          error: r.error_msg,
          durationMs: r.duration_ms,
          timestamp: r.created_at,
        })),
        summary: {
          totalActions,
          successRate: totalActions > 0 ? (successCount / totalActions * 100).toFixed(1) + '%' : '0%',
          avgDurationMs: Math.round(avgDuration),
          breakdown: Object.fromEntries(actionBreakdown.map(r => [r.action, r.cnt])),
        },
      }));
    } catch (err) {
      // Table may not exist yet
      if (err.message && err.message.includes('no such table')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ actions: [], summary: { totalActions: 0, note: 'browser_action_log table not yet created' } }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return true;
  }

  // ─── [R17-T3] Browser Evidence Pack Query ───
  if (urlPath === '/api/admin/browser-evidence' && req.method === 'GET') {
    try {
      const evParams = new URL(req.url, 'http://localhost').searchParams;
      const limit = Math.min(parseInt(evParams.get('limit') || '50', 10), 200);
      const sessionFilter = evParams.get('sessionId');
      const typeFilter = evParams.get('type');

      const dbWorker = new Database(process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db', { readonly: true });

      let sql = 'SELECT id, session_id, action_id, evidence_type, file_path, url, title, text_content, metadata, created_at FROM browser_evidence';
      const conditions = [];
      const params = [];
      if (sessionFilter) { conditions.push('session_id = ?'); params.push(sessionFilter); }
      if (typeFilter) { conditions.push('evidence_type = ?'); params.push(typeFilter); }
      if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(limit);

      const rows = dbWorker.prepare(sql).all(...params);

      // Summary
      const totalEvidence = dbWorker.prepare('SELECT COUNT(*) as cnt FROM browser_evidence').get()?.cnt || 0;
      const byType = dbWorker.prepare('SELECT evidence_type, COUNT(*) as cnt FROM browser_evidence GROUP BY evidence_type').all();
      const topSessions = dbWorker.prepare('SELECT session_id, COUNT(*) as cnt FROM browser_evidence GROUP BY session_id ORDER BY cnt DESC LIMIT 10').all();

      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        evidence: rows.map(r => ({
          id: r.id,
          sessionId: r.session_id,
          actionId: r.action_id,
          type: r.evidence_type,
          filePath: r.file_path,
          url: r.url,
          title: r.title,
          textPreview: r.text_content ? r.text_content.substring(0, 500) : null,
          metadata: r.metadata ? JSON.parse(r.metadata) : null,
          timestamp: r.created_at,
        })),
        summary: {
          totalEvidence,
          byType: Object.fromEntries(byType.map(r => [r.evidence_type, r.cnt])),
          topSessions: topSessions.map(r => ({ sessionId: r.session_id, count: r.cnt })),
        },
      }));
    } catch (err) {
      if (err.message && err.message.includes('no such table')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ evidence: [], summary: { totalEvidence: 0, note: 'browser_evidence table not yet created' } }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return true;
  }

  // ═══ R22-T3: Task Replay API ═══════════════════════════════════════
  if (urlPath === '/api/admin/task-replay' && req.method === 'GET') {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const taskId = params.get('taskId');
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'taskId required' }));
        return true;
      }

      const dbPath = process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbMain = new Database(dbPath, { readonly: true });
      const dbWorker = new Database(workerDbPath, { readonly: true });

      // 1. Plan data
      const planRow = dbMain.prepare('SELECT msg_id, session_key, status, plan_version, step_count, steps_completed, goal, plan_json, created_at, updated_at FROM task_plans WHERE msg_id = ?').get(taskId);
      let planSteps = [];
      let traceSessionKey = planRow?.session_key || null;
      let planGoal = planRow?.goal || '';
      let planJson = {};
      if (planRow) {
        try {
          planJson = JSON.parse(planRow.plan_json || '{}');
          planSteps = (planJson.steps || []).map(s => ({
            id: s.id, title: s.title, status: s.status,
            tools: s.tools || [], expectedTools: s.expectedTools || [],
            rationale: s.rationale || '', output: s.output || null,
          }));
        } catch (_) {}
      }

      // 2. R22 fields from plan JSON
      const taskFamily = planJson.taskFamily || 'unknown';
      const routingReason = planJson.routingReason || '';
      const selectedPrimaryTool = planJson.selectedPrimaryTool || '';

      // 3. Browser actions
      let browserActions = [];
      if (traceSessionKey) {
        try {
          browserActions = dbWorker.prepare(
            `SELECT id, action, url, selector, success, title, status_code, text_length, error_msg, duration_ms, created_at
             FROM browser_action_log WHERE session_id = ? ORDER BY created_at ASC`
          ).all(traceSessionKey).map(r => ({
            id: r.id, action: r.action, url: r.url, selector: r.selector,
            success: !!r.success, title: r.title, statusCode: r.status_code,
            textLength: r.text_length, errorMsg: r.error_msg,
            durationMs: r.duration_ms, timestamp: r.created_at,
          }));
        } catch (_) {}
      }

      // 4. Browser evidence
      let browserEvidence = [];
      if (traceSessionKey) {
        try {
          browserEvidence = dbWorker.prepare(
            `SELECT id, evidence_type, file_path, url, title, text_content, metadata, created_at, task_focus_id
             FROM browser_evidence WHERE session_id = ? ORDER BY created_at ASC`
          ).all(traceSessionKey).map(r => ({
            id: r.id, evidenceType: r.evidence_type, filePath: r.file_path,
            url: r.url, title: r.title,
            textSnippet: (r.text_content || '').substring(0, 300),
            timestamp: r.created_at, taskFocusId: r.task_focus_id,
            evidenceRef: `/api/admin/browser-evidence?sessionKey=${traceSessionKey}&evidenceId=${r.id}`,
          }));
        } catch (_) {}
      }

      // 5. Supervisor reviews & decisions
      let reviews = [];
      let decisions = [];
      try {
        reviews = dbWorker.prepare(
          'SELECT id, type, risk_level, score, step_count, feedback, stub, created_at FROM supervisor_reviews WHERE task_id = ? ORDER BY created_at ASC'
        ).all(taskId).map(r => ({
          id: r.id, type: r.type, riskLevel: r.risk_level, score: r.score,
          feedback: r.feedback, stub: !!r.stub, timestamp: r.created_at,
        }));
      } catch (_) {}
      try {
        decisions = dbWorker.prepare(
          'SELECT id, phase, decision_action, risk_level, reason, step_id, step_title, final_outcome, escalation_status, created_at FROM supervisor_decisions WHERE task_id = ? ORDER BY created_at ASC'
        ).all(taskId).map(r => ({
          id: r.id, phase: r.phase, action: r.decision_action,
          riskLevel: r.risk_level, reason: r.reason, stepId: r.step_id,
          stepTitle: r.step_title, finalOutcome: r.final_outcome,
          escalationStatus: r.escalation_status, timestamp: r.created_at,
        }));
      } catch (_) {}

      // 6. Trace spans
      let spans = [];
      try {
        spans = dbMain.prepare(
          'SELECT span_name, started_at, ended_at, duration_ms, status, meta FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC'
        ).all(taskId).map(r => ({
          name: r.span_name, startedAt: r.started_at, endedAt: r.ended_at,
          durationMs: r.duration_ms, status: r.status,
          meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch(_) { return null; } })() : null,
        }));
      } catch (_) {}

      // 7. Failure/fallback events
      let failureRecords = [];
      let webTaskRouting = null;
      if (traceSessionKey) {
        try {
          const events = dbWorker.prepare(
            `SELECT event_type, payload, created_at FROM event_stream
             WHERE (session_key = ? OR task_id = ?)
             AND event_type IN ('browser_failure', 'browser_fallback', 'web_task_routing')
             ORDER BY created_at ASC`
          ).all(traceSessionKey, taskId);
          for (const evt of events) {
            try {
              const p = JSON.parse(evt.payload || '{}');
              if (evt.event_type === 'browser_failure') {
                failureRecords.push({
                  failureStage: p.failureStage || p.action || '',
                  failureReason: p.failureReason || p.category || '',
                  failureDetail: p.failureDetail || p.errorMsg || '',
                  url: p.url || '', retryable: p.retryable ?? false,
                  fallbackAction: p.fallbackAction || '',
                  fallbackResult: p.fallbackResult || 'unknown',
                  degradedSuccess: p.degradedSuccess ?? false,
                  timestamp: evt.created_at,
                });
              }
              if (evt.event_type === 'web_task_routing' && !webTaskRouting) {
                webTaskRouting = { taskFamily: p.taskFamily, routingReason: p.routingReason, selectedPrimaryTool: p.selectedPrimaryTool };
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      // 8. Build unified timeline
      const timeline = [];
      let stepIdx = 0;
      if (planRow) {
        timeline.push({ stepIndex: stepIdx++, timestamp: planRow.created_at, kind: 'plan_created',
          summary: `Plan created: "${planGoal}" (${planSteps.length} steps, v${planRow.plan_version})`, status: 'ok',
          evidenceRef: `/api/admin/plan-metrics?taskId=${taskId}` });
      }
      const routing = webTaskRouting || (taskFamily !== 'unknown' ? { taskFamily, routingReason, selectedPrimaryTool } : null);
      if (routing) {
        timeline.push({ stepIndex: stepIdx++, timestamp: planRow?.created_at || new Date().toISOString(), kind: 'web_task_routing',
          summary: `Web task: family=${routing.taskFamily}, tool=${routing.selectedPrimaryTool}. ${routing.routingReason}`, status: 'ok', evidenceRef: null });
      }
      for (const step of planSteps) {
        timeline.push({ stepIndex: stepIdx++, timestamp: null, kind: 'plan_step',
          summary: `Step ${step.id}: ${step.title} [${(step.tools || []).join(',')}] → ${step.status}`, status: step.status, evidenceRef: null });
      }
      for (const ba of browserActions) {
        const matchEvidence = browserEvidence.find(e => e.timestamp && ba.timestamp && Math.abs(new Date(e.timestamp) - new Date(ba.timestamp)) < 5000);
        timeline.push({ stepIndex: stepIdx++, timestamp: ba.timestamp, kind: `browser_${ba.action}`,
          summary: `Browser ${ba.action}: ${ba.url || ''} ${ba.success ? '✓' : '✗ ' + (ba.errorMsg || '')}`.trim(),
          status: ba.success ? 'ok' : 'failed', evidenceRef: matchEvidence?.evidenceRef || null, durationMs: ba.durationMs });
      }
      for (const fr of failureRecords) {
        timeline.push({ stepIndex: stepIdx++, timestamp: fr.timestamp, kind: fr.fallbackAction ? 'browser_fallback' : 'browser_failure',
          summary: `Failure: ${fr.failureReason} at ${fr.failureStage}. ${fr.fallbackAction ? 'Fallback: ' + fr.fallbackAction + ' → ' + fr.fallbackResult : 'No fallback'}`,
          status: fr.degradedSuccess ? 'degraded_success' : 'failed', evidenceRef: null });
      }
      for (const rev of reviews) {
        timeline.push({ stepIndex: stepIdx++, timestamp: rev.timestamp, kind: 'supervisor_review',
          summary: `Supervisor ${rev.type}: risk=${rev.riskLevel} score=${rev.score} ${rev.feedback ? '— ' + rev.feedback.substring(0, 100) : ''}`.trim(),
          status: 'ok', evidenceRef: `/api/admin/supervisor-reviews?taskId=${taskId}` });
      }
      for (const dec of decisions) {
        timeline.push({ stepIndex: stepIdx++, timestamp: dec.timestamp, kind: 'supervisor_decision',
          summary: `Decision: ${dec.action} (${dec.phase}) ${dec.reason ? '— ' + dec.reason.substring(0, 100) : ''}`.trim(),
          status: dec.finalOutcome || 'pending', evidenceRef: `/api/admin/supervisor-decisions?taskId=${taskId}` });
      }
      timeline.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return a.stepIndex - b.stepIndex;
        if (!a.timestamp) return -1;
        if (!b.timestamp) return 1;
        return new Date(a.timestamp) - new Date(b.timestamp);
      });
      timeline.forEach((item, idx) => { item.stepIndex = idx; });

      // 9. Final status (three-state)
      let finalStatus = 'unknown';
      if (planRow?.status === 'completed') {
        finalStatus = failureRecords.some(f => f.degradedSuccess) ? 'degraded_success' : 'success';
      } else if (planRow?.status === 'failed') {
        finalStatus = 'failed';
      } else if (planRow?.status === 'active') {
        finalStatus = 'in_progress';
      }

      // 10. Final output snippet
      let finalOutput = null;
      if (browserEvidence.length > 0) {
        const last = browserEvidence[browserEvidence.length - 1];
        finalOutput = { pageTitle: last.title, textSnippet: last.textSnippet, url: last.url };
      }

      dbMain.close();
      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        taskId, sessionKey: traceSessionKey,
        taskFamily: (webTaskRouting || {}).taskFamily || taskFamily,
        routingReason: (webTaskRouting || {}).routingReason || routingReason,
        selectedPrimaryTool: (webTaskRouting || {}).selectedPrimaryTool || selectedPrimaryTool,
        finalStatus,
        plan: planRow ? { status: planRow.status, version: planRow.plan_version, goal: planGoal,
          totalSteps: planRow.step_count, completedSteps: planRow.steps_completed, steps: planSteps } : null,
        timeline,
        browserActions: browserActions.length,
        browserEvidence: browserEvidence.length,
        failureRecords, supervisorReviews: reviews, supervisorDecisions: decisions,
        traceSpans: spans, finalOutput,
      }));
    } catch (err) {
      logger.error(`[task-replay] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ═══ R22-T4: Task Quality Summary API ═══════════════════════════════
  if (urlPath === '/api/admin/task-quality-summary' && req.method === 'GET') {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const hours = parseInt(params.get('hours') || '168', 10);
      const since = new Date(Date.now() - hours * 3600000).toISOString();

      const dbPath = process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbMain = new Database(dbPath, { readonly: true });
      const dbWorker = new Database(workerDbPath, { readonly: true });

      const totalTasks = dbMain.prepare("SELECT COUNT(*) as cnt FROM task_plans WHERE created_at > ?").get(since)?.cnt || 0;
      const completedTasks = dbMain.prepare("SELECT COUNT(*) as cnt FROM task_plans WHERE status = 'completed' AND created_at > ?").get(since)?.cnt || 0;
      const failedTasks = dbMain.prepare("SELECT COUNT(*) as cnt FROM task_plans WHERE status = 'failed' AND created_at > ?").get(since)?.cnt || 0;
      const activeTasks = dbMain.prepare("SELECT COUNT(*) as cnt FROM task_plans WHERE status = 'active' AND created_at > ?").get(since)?.cnt || 0;

      // Browser failure distribution
      let browserFailures = {};
      try {
        const failureEvents = dbWorker.prepare(
          `SELECT payload FROM event_stream WHERE event_type = 'browser_failure' AND created_at > ?`
        ).all(since);
        for (const evt of failureEvents) {
          try {
            const p = JSON.parse(evt.payload || '{}');
            const cat = p.failureReason || p.category || 'unknown';
            browserFailures[cat] = (browserFailures[cat] || 0) + 1;
          } catch (_) {}
        }
      } catch (_) {}

      // Degraded success count
      let degradedSuccessCount = 0;
      try {
        const degradedEvents = dbWorker.prepare(
          `SELECT COUNT(*) as cnt FROM event_stream
           WHERE event_type = 'browser_fallback'
           AND json_extract(payload, '$.degradedSuccess') = 1
           AND created_at > ?`
        ).get(since);
        degradedSuccessCount = degradedEvents?.cnt || 0;
      } catch (_) {}

      // Supervisor intervention rate
      let supervisorTotal = 0;
      let supervisorInterventions = 0;
      try {
        supervisorTotal = dbWorker.prepare("SELECT COUNT(*) as cnt FROM supervisor_reviews WHERE created_at > ?").get(since)?.cnt || 0;
        supervisorInterventions = dbWorker.prepare("SELECT COUNT(*) as cnt FROM supervisor_decisions WHERE decision_action IN ('reject', 'escalate') AND created_at > ?").get(since)?.cnt || 0;
      } catch (_) {}

      // Root cause distribution
      let rootCauseDistribution = { planner: 0, browser_exec: 0, page_state: 0, supervisor_policy: 0, business_risk: 0, unknown: 0 };
      try {
        const decisionRows = dbWorker.prepare(`SELECT reason FROM supervisor_decisions WHERE created_at > ?`).all(since);
        for (const row of decisionRows) {
          const reason = (row.reason || '').toLowerCase();
          if (/plan|routing|wrong.?tool|missed/i.test(reason)) rootCauseDistribution.planner++;
          else if (/browser|navigate|click|extract|timeout|element/i.test(reason)) rootCauseDistribution.browser_exec++;
          else if (/page|dom|redirect|unexpected|state/i.test(reason)) rootCauseDistribution.page_state++;
          else if (/policy|rule|constraint|limit/i.test(reason)) rootCauseDistribution.supervisor_policy++;
          else if (/risk|business|sensitive|dangerous/i.test(reason)) rootCauseDistribution.business_risk++;
          else rootCauseDistribution.unknown++;
        }
      } catch (_) {}

      const browserFailureTopReasons = Object.entries(browserFailures)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));

      const successCount = Math.max(0, completedTasks - degradedSuccessCount);
      const interventionRate = totalTasks > 0 ? Math.round((supervisorInterventions / totalTasks) * 1000) / 1000 : 0;

      dbMain.close();
      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        period: { hours, since },
        totalTasks, successCount, degradedSuccessCount,
        failedCount: failedTasks, activeCount: activeTasks,
        interventionRate, rootCauseDistribution,
        browserFailureTopReasons,
        supervisorStats: { totalReviews: supervisorTotal, interventions: supervisorInterventions },
      }));
    } catch (err) {
      logger.error(`[task-quality-summary] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ═══ R22-T1b: Web Task Stats API ═══════════════════════════════════
  if (urlPath === '/api/admin/web-task-stats' && req.method === 'GET') {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const hours = parseInt(params.get('hours') || '168', 10);
      const since = new Date(Date.now() - hours * 3600000).toISOString();

      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbWorker = new Database(workerDbPath, { readonly: true });

      const routingEvents = dbWorker.prepare(
        `SELECT payload FROM event_stream WHERE event_type = 'web_task_routing' AND created_at > ?`
      ).all(since);

      let webTaskCount = 0, browserCount = 0, searchCount = 0, directAnswerCount = 0;
      let missedBrowserCases = { downgraded_to_search: 0, routed_to_shell: 0, direct_text_answer: 0, routed_to_other_tool: 0 };
      let familyDistribution = {};

      for (const evt of routingEvents) {
        try {
          const p = JSON.parse(evt.payload || '{}');
          if (p.taskFamily && p.taskFamily !== 'non_web') {
            webTaskCount++;
            familyDistribution[p.taskFamily] = (familyDistribution[p.taskFamily] || 0) + 1;
            if (p.selectedPrimaryTool === 'browser') browserCount++;
            else if (/web_search|web_fetch/.test(p.selectedPrimaryTool)) searchCount++;
            else if (p.selectedPrimaryTool === 'none') directAnswerCount++;
          }
        } catch (_) {}
      }

      const missedEvents = dbWorker.prepare(
        `SELECT payload FROM event_stream WHERE event_type = 'missed_browser_opportunity' AND created_at > ?`
      ).all(since);
      for (const evt of missedEvents) {
        try {
          const p = JSON.parse(evt.payload || '{}');
          if (p.missedCategory && missedBrowserCases[p.missedCategory] !== undefined) {
            missedBrowserCases[p.missedCategory]++;
          }
        } catch (_) {}
      }

      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        period: { hours, since },
        webTaskCount,
        webTaskBrowserRate: webTaskCount > 0 ? Math.round((browserCount / webTaskCount) * 1000) / 1000 : 0,
        webTaskSearchRate: webTaskCount > 0 ? Math.round((searchCount / webTaskCount) * 1000) / 1000 : 0,
        webTaskDirectAnswerRate: webTaskCount > 0 ? Math.round((directAnswerCount / webTaskCount) * 1000) / 1000 : 0,
        webTaskMissedBrowserCases: missedBrowserCases,
        familyDistribution,
      }));
    } catch (err) {
      logger.error(`[web-task-stats] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ═══════════════════════════════════════════════════
  // R23 Helper: readBody for POST routes
  // ═══════════════════════════════════════════════════
  const readBody = (r) => new Promise((resolve, reject) => {
    const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks).toString())); r.on('error', reject);
  });

  // ═══════════════════════════════════════════════════
  // R23-T3: Supervisor Block Log
  // ═══════════════════════════════════════════════════
  if (urlPath === '/api/admin/supervisor-blocks' && req.method === 'GET') {
    try {
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbW = new Database(workerDbPath, { readonly: true });
      let blocks = [];
      try { blocks = dbW.prepare('SELECT * FROM event_stream WHERE event_type = ? ORDER BY created_at DESC LIMIT 50').all('supervisor_block'); } catch (_) {}
      dbW.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blocks, total: blocks.length }));
    } catch (err) {
      logger.error(`[supervisor-blocks] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (urlPath === '/api/admin/supervisor-block' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { taskId, sessionKey, reason, level, details, blockedAction } = JSON.parse(body);
      if (!taskId || !reason) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'taskId and reason required' }));
        return true;
      }
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbW = new Database(workerDbPath);
      try {
        dbW.prepare("INSERT INTO event_stream (session_key, task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
          .run(sessionKey || taskId, taskId, 'supervisor_block', JSON.stringify({ reason, level: level || 'block', details: details || '', blockedAction: blockedAction || {}, timestamp: Date.now() }));
      } catch (_) {}
      dbW.close();
      logger.info(`[R23-T3] Supervisor block recorded: task=${taskId} reason=${reason} level=${level || 'block'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logger.error(`[supervisor-block] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ═══════════════════════════════════════════════════
  // R23-T4: Knowledge Module CRUD
  // ═══════════════════════════════════════════════════
  if (urlPath === '/api/admin/knowledge' && req.method === 'GET') {
    try {
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbK = new Database(workerDbPath, { readonly: true });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const category = url.searchParams.get('category') || null;
      const active = url.searchParams.get('active');
      const page = parseInt(url.searchParams.get('page') || '1');
      const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
      const query = url.searchParams.get('q') || '';
      let sql = 'SELECT * FROM knowledge_entries WHERE 1=1';
      let countSql = 'SELECT COUNT(*) as total FROM knowledge_entries WHERE 1=1';
      const params = [];
      const countParams = [];
      if (category) { sql += ' AND category = ?'; countSql += ' AND category = ?'; params.push(category); countParams.push(category); }
      if (active !== null && active !== undefined && active !== '') { sql += ' AND active = ?'; countSql += ' AND active = ?'; params.push(parseInt(active)); countParams.push(parseInt(active)); }
      if (query) {
        const kw = `%${query}%`;
        sql += ' AND (LOWER(title) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))';
        countSql += ' AND (LOWER(title) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))';
        params.push(kw, kw, kw); countParams.push(kw, kw, kw);
      }
      sql += ' ORDER BY priority DESC, updated_at DESC LIMIT ? OFFSET ?';
      params.push(pageSize, (page - 1) * pageSize);
      let entries = []; let countRow = { total: 0 };
      try { entries = dbK.prepare(sql).all(...params); } catch (_) {}
      try { countRow = dbK.prepare(countSql).get(...countParams) || { total: 0 }; } catch (_) {}
      dbK.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries, total: countRow.total, page, pageSize }));
    } catch (err) {
      logger.error(`[knowledge-list] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (urlPath === '/api/admin/knowledge' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { category, title, content, tags, priority } = JSON.parse(body);
      if (!title || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title and content required' }));
        return true;
      }
      const tagsJson = typeof tags === 'string' ? tags : JSON.stringify(tags || []);
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbK = new Database(workerDbPath);
      dbK.prepare('INSERT INTO knowledge_entries (category, title, content, tags, priority, source) VALUES (?, ?, ?, ?, ?, ?)')
        .run(category || 'general', title, content, tagsJson, priority || 5, 'manual');
      const entry = dbK.prepare('SELECT * FROM knowledge_entries ORDER BY id DESC LIMIT 1').get();
      dbK.close();
      logger.info(`[R23-T4] Knowledge entry created: id=${entry?.id} title=${title}`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry }));
    } catch (err) {
      logger.error(`[knowledge-create] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (urlPath.startsWith('/api/admin/knowledge/') && req.method === 'PUT') {
    try {
      const id = parseInt(urlPath.split('/').pop());
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const fields = [];
      const params = [];
      if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
      if (updates.content !== undefined) { fields.push('content = ?'); params.push(updates.content); }
      if (updates.category !== undefined) { fields.push('category = ?'); params.push(updates.category); }
      if (updates.tags !== undefined) { fields.push('tags = ?'); params.push(typeof updates.tags === 'string' ? updates.tags : JSON.stringify(updates.tags)); }
      if (updates.priority !== undefined) { fields.push('priority = ?'); params.push(updates.priority); }
      if (updates.active !== undefined) { fields.push('active = ?'); params.push(updates.active ? 1 : 0); }
      fields.push("updated_at = datetime('now')");
      params.push(id);
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbK = new Database(workerDbPath);
      dbK.prepare(`UPDATE knowledge_entries SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      const entry = dbK.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id);
      dbK.close();
      logger.info(`[R23-T4] Knowledge entry updated: id=${id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entry }));
    } catch (err) {
      logger.error(`[knowledge-update] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (urlPath.startsWith('/api/admin/knowledge/') && req.method === 'DELETE') {
    try {
      const id = parseInt(urlPath.split('/').pop());
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbK = new Database(workerDbPath);
      dbK.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
      dbK.close();
      logger.info(`[R23-T4] Knowledge entry deleted: id=${id}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logger.error(`[knowledge-delete] Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ═══════════════════════════════════════════════════
  // R23-T5: Dual Model Config
  // ═══════════════════════════════════════════════════
  if (urlPath === '/api/admin/dual-model-config' && req.method === 'GET') {
    try {
      const config = getDualModelConfig(); // [R24-T5] Use live config from dual-model-stub
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // [R24-T5] PUT /api/admin/dual-model-config — Update dual model configuration
  if (urlPath === '/api/admin/dual-model-config' && req.method === 'PUT') {
    try {
      const body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        req.on('error', reject);
      });
      const updated = updateDualModelConfig(body);
      // Persist to DB for cross-restart durability
      let persisted = false;
      try {
        const db = new Database('/opt/rangerai-agent/db/rangerai.db');
        db.exec(`CREATE TABLE IF NOT EXISTS system_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.prepare(
          `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`
        ).run('dual_model_config', JSON.stringify(updated));
        db.close();
        persisted = true;
        logger.info(`[R24-T5] Dual model config persisted to DB`);
      } catch (dbErr) {
        logger.warn(`[R24-T5] DB persist failed (non-fatal): ${dbErr.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config: updated, persisted }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // ═══ [R25-T4] GET /api/admin/security-stats — Validator-chain observability ═══
  if (urlPath === '/api/admin/security-stats' && req.method === 'GET') {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const hours = parseInt(params.get('hours') || '168', 10);
      const since = new Date(Date.now() - hours * 3600000).toISOString();

      // [R25-T4] Query audit_logs for action distribution
      const dbPath = process.env.RANGERAI_DB_PATH || '/opt/rangerai-agent/rangerai.db';
      const workerDbPath = process.env.RANGERAI_WORKER_DB || '/opt/rangerai-agent/db/rangerai.db';
      const dbMain = new Database(dbPath, { readonly: true });
      const dbWorker = new Database(workerDbPath, { readonly: true });

      // Audit log stats
      let auditTotalEntries = 0;
      let recentActions = [];
      try {
        const auditRows = dbMain.prepare(
          `SELECT action, COUNT(*) as cnt FROM audit_logs WHERE createdAt > ? GROUP BY action ORDER BY cnt DESC LIMIT 10`
        ).all(since);
        auditTotalEntries = auditRows.reduce((sum, r) => sum + r.cnt, 0);
        recentActions = auditRows.map(r => ({ action: r.action, count: r.cnt }));
      } catch (_) {}

      // Validator chain stats from event_stream (supervisor_block events)
      let totalBlocked = 0;
      let topBlockReasons = [];
      try {
        const blockEvents = dbWorker.prepare(
          `SELECT payload FROM event_stream WHERE event_type = 'supervisor_block' AND created_at > ?`
        ).all(since);
        const reasonMap = {};
        for (const evt of blockEvents) {
          try {
            const p = JSON.parse(evt.payload || '{}');
            const reason = p.reason || p.level || 'unknown';
            reasonMap[reason] = (reasonMap[reason] || 0) + 1;
            totalBlocked++;
          } catch (_) {}
        }
        topBlockReasons = Object.entries(reasonMap)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => ({ reason, count }));
      } catch (_) {}

      // HTTP error stats from audit_logs (CRIT_PENDING, CRIT_TIMEOUT_REJECTED = blocked)
      let critPending = 0;
      let critRejected = 0;
      try {
        const critStats = dbMain.prepare(
          `SELECT action, COUNT(*) as cnt FROM audit_logs WHERE action IN ('CRIT_PENDING', 'CRIT_TIMEOUT_REJECTED') AND createdAt > ? GROUP BY action`
        ).all(since);
        for (const row of critStats) {
          if (row.action === 'CRIT_PENDING') critPending = row.cnt;
          if (row.action === 'CRIT_TIMEOUT_REJECTED') critRejected = row.cnt;
        }
      } catch (_) {}

      // Total requests approximation (all audit_logs entries)
      const totalRequests = auditTotalEntries;
      const totalBlockedAll = totalBlocked + critRejected;
      const blockRate = totalRequests > 0 ? Math.round((totalBlockedAll / totalRequests) * 10000) / 10000 : 0;

      dbMain.close();
      dbWorker.close();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      // [R26-T1] Top-level deny/warn counts
      res.end(JSON.stringify({
        denyCount: critRejected,
        warnCount: critPending,
        period: { hours, since },
        validatorChain: {
          totalRequests,
          blockedRequests: totalBlockedAll,
          blockRate,
          supervisorBlocks: totalBlocked,
          critPending,
          critRejected,
          topBlockReasons,
        },
        auditLog: {
          totalEntries: auditTotalEntries,
          recentActions,
        },
      }));
    } catch (err) {
      logger.error(`[R25-T4] security-stats error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}

// ─── Handlers ───

function metricsHealth(req, res) {
  const snapshot = metrics.getSnapshot();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    uptime_seconds: snapshot.uptime_seconds,
    traffic: { http_rpm: snapshot.traffic.http_rpm, ws_connections: snapshot.traffic.ws_connections },
    errors: { http_5xx_rpm: snapshot.errors.http_5xx_rpm, gateway_errors_rpm: snapshot.errors.gateway_errors_rpm },
    latency: { http_p50: snapshot.latency.http.p50, http_p99: snapshot.latency.http.p99 }
  }));
  return true;
}

function handleHealth(req, res) {
  const { ctx, workerManager } = deps;
  const wss = ctx.runtime.wss;
  const wStatus = workerManager.status;
  const isAdmin = ctx.services.auth.validateAdminToken(req);
  const capabilityHealth = getHealthStatus();
  const basicHealth = {
    status: "ok",
    version: "v68-modular",
    uptime: Math.round(process.uptime()),
    workerReady: wStatus.workerReady,
    gatewayConnected: wStatus.gatewayConnected || wStatus.workerReady,
    gatewayLastPongAge: wStatus.lastPongAt ? Math.round((Date.now() - wStatus.lastPongAt) / 1000) : null,
    gatewayReconnects: wStatus.restartCount || 0,
    redis: ctx.services.redisPool.isReady(),
    redisPool: ctx.services.redisPool.getHealth(),
    capabilities: capabilityHealth,
  };
  if (isAdmin) {
    Object.assign(basicHealth, {
      worker: wStatus,
      memory: process.memoryUsage(),
      connections: wss?.clients?.size || 0,
      rateLimiter: ctx.services.rateLimiter.getStatus(),
    });
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(basicHealth));
  return true;
}

function handleMetrics(req, res) {
  const { ctx, workerManager } = deps;
  const wss = ctx.runtime.wss;
  const accept = req.headers?.accept || '';
  if (accept.includes('text/plain')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(metrics.toPrometheus());
    return true;
  }
  const snapshot = metrics.getSnapshot();
  const legacy = ctx.services.monitor.getMetrics();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ...legacy,
    rateLimiter: ctx.services.rateLimiter.getStatus(),
    redis: { connected: ctx.services.taskStore.ready },
    connections: wss?.clients?.size || 0,
    observability: snapshot,
  }, null, 2));
  return true;
}

async function handleProviderHealthCheck(req, res) {
  const { ctx, SECRETS } = deps;
  res.writeHead(200, { "Content-Type": "application/json" });
  try {
    const openclawCfg = (() => {
      try { return JSON.parse(fs.readFileSync(ctx.config.OPENCLAW_CONFIG_PATH, "utf-8")); } catch (e) { logger.debug("[infra] config parse failed:", e.message); return {}; }
    })();
    const providers = openclawCfg?.models?.providers || {};
    const openaiKey = providers.openai?.apiKey || (SECRETS && SECRETS.OPENAI_API_KEY) || process.env.OPENAI_API_KEY || "";
    const googleKey = providers.google?.apiKey || "";
    const anthropicKey = providers.anthropic?.apiKey || "";

    const openaiModels = (providers.openai?.models || []).map(m => m.id);
    const googleModels = (providers.google?.models || []).map(m => m.id);
    const anthropicModels = (providers.anthropic?.models || []).map(m => m.id);

    const openaiTestModel = openaiModels[0] || "gpt-5.2";
    const googleTestModel = googleModels.find(m => m.includes("flash") && !m.includes("preview")) || googleModels.find(m => m.includes("flash")) || googleModels[0] || "gemini-2.0-flash";
    const anthropicTestModel = anthropicModels[0] || "claude-opus-4-6";

    const checkTimeout = 20000;
    const fetchWithTimeout = async (url, options, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return resp;
      } catch (e) { clearTimeout(timer); throw e; }
    };

    const checkProvider = async (name, key, testModel, models, url, buildBody, parseResp) => {
      if (!key) return { provider: name, status: "no_key", message: "未配置 API Key", models, testModel };
      try {
        const resp = await fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(name !== "google" ? { "Authorization": `Bearer ${key}` } : {}) },
          body: JSON.stringify(buildBody(testModel)),
        }, checkTimeout);
        const data = await resp.json();
        return parseResp(resp, data, name, testModel, models);
      } catch (e) {
        return { provider: name, status: "error", message: e.name === "AbortError" ? `超时 (${checkTimeout / 1000}s)` : e.message, models, testModel };
      }
    };

    const parseOpenAIStyle = (resp, data, name, testModel, models) => {
      if (resp.ok && data.choices) return { provider: name, status: "ok", message: `${testModel} 正常`, models, testModel };
      if (data.error?.code === "insufficient_quota" || data.error?.message?.includes("quota")) return { provider: name, status: "billing", message: data.error.message, models, testModel };
      if (resp.status === 429) return { provider: name, status: "rate_limited", message: data.error?.message || "Rate limited", models, testModel };
      if (resp.status === 401 || resp.status === 403) return { provider: name, status: "auth_error", message: data.error?.message || "认证失败", models, testModel };
      return { provider: name, status: "error", message: data.error?.message || `HTTP ${resp.status}`, models, testModel };
    };

    const [openai, google, anthropic] = await Promise.all([
      checkProvider("openai", openaiKey, openaiTestModel, openaiModels,
        "https://api.openai.com/v1/chat/completions",
        (model) => ({ model, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 3 }),
        parseOpenAIStyle),
      checkProvider("google", googleKey, googleTestModel, googleModels,
        `https://generativelanguage.googleapis.com/v1beta/models/${googleTestModel}:generateContent?key=${googleKey}`,
        () => ({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 3 } }),
        (resp, data, name, testModel, models) => {
          if (resp.ok && data.candidates) return { provider: name, status: "ok", message: `${testModel} 正常`, models, testModel };
          if (resp.status === 429) return { provider: name, status: "rate_limited", message: "Rate limited", models, testModel };
          return { provider: name, status: "error", message: data.error?.message || `HTTP ${resp.status}`, models, testModel };
        }),
      checkProvider("anthropic", anthropicKey, anthropicTestModel, anthropicModels,
        "https://api.anthropic.com/v1/messages",
        (model) => ({ model, max_tokens: 3, messages: [{ role: "user", content: "hi" }] }),
        (resp, data, name, testModel, models) => {
          if (resp.ok && (data.content || data.type === "message")) return { provider: name, status: "ok", message: `${testModel} 正常`, models, testModel };
          if (data.error?.type === "authentication_error") return { provider: name, status: "auth_error", message: data.error.message, models, testModel };
          if (resp.status === 429) return { provider: name, status: "rate_limited", message: "Rate limited", models, testModel };
          return { provider: name, status: "error", message: data.error?.message || `HTTP ${resp.status}`, models, testModel };
        }),
    ]);

    const allProviders = [openai, google, anthropic];
    const configuredProviders = allProviders.filter(p => p.status !== "no_key");
    const okCount = configuredProviders.filter(p => p.status === "ok").length;
    let overallStatus = "healthy", overallMessage = `所有 ${configuredProviders.length} 个已配置的 API 提供商正常`;
    if (configuredProviders.length > 0 && okCount === 0) {
      overallStatus = "critical"; overallMessage = "所有已配置的 API 提供商不可用";
    } else if (okCount < configuredProviders.length) {
      overallStatus = "degraded"; overallMessage = `${okCount}/${configuredProviders.length} 个正常`;
    }
    res.end(JSON.stringify({ status: overallStatus, message: overallMessage, checkedAt: new Date().toISOString(), providers: allProviders }));
  } catch (e) {
    res.end(JSON.stringify({ status: "error", message: e.message, providers: [] }));
  }
  return true;
}

function handleWorkspaceTree(req, res) {
  const WS_ROOT = "/home/admin/.openclaw/workspace";
  const EXCL = new Set(["node_modules", ".git", ".openclaw", "__pycache__", ".cache", "skills"]);
  function buildTree(dp, d) {
    if (d > 4) return [];
    const ents = [];
    try {
      const items = fs.readdirSync(dp, { withFileTypes: true });
      let fc = 0;
      for (const it of items) {
        if (fc >= 500) break;
        if (it.name.startsWith(".") && d === 0) continue;
        if (EXCL.has(it.name)) continue;
        const fp = path.join(dp, it.name);
        const rp = path.relative(WS_ROOT, fp);
        if (it.isDirectory()) {
          const ch = buildTree(fp, d + 1);
          ents.push({ name: it.name, path: rp, type: "directory", children: ch, childCount: ch.length });
        } else {
          fc++;
          try {
            const st = fs.statSync(fp);
            ents.push({ name: it.name, path: rp, type: "file", size: st.size, ext: path.extname(it.name).toLowerCase(), modified: st.mtimeMs });
          } catch (e) { logger.debug("[infra] caught:", e?.message); }
        }
      }
    } catch (e) { logger.debug("[infra] caught:", e?.message); }
    ents.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      if (a.type === "file") return (b.modified || 0) - (a.modified || 0);
      return a.name.localeCompare(b.name);
    });
    return ents;
  }
  try {
    const tree = buildTree(WS_ROOT, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tree, root: WS_ROOT }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleWorkspaceFile(req, res) {
  const WS_ROOT = "/home/admin/.openclaw/workspace";
  const params = new URLSearchParams(req.url.split("?")[1] || "");
  const filePath = params.get("path");
  if (!filePath) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing path parameter" })); return; }
  const fullPath = path.join(WS_ROOT, filePath);
  if (!fullPath.startsWith(WS_ROOT)) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Access denied" })); return; }
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not a file" })); return; }
    if (stat.size > 1024 * 1024) { res.writeHead(413, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "File too large (max 1MB)" })); return; }
    const content = fs.readFileSync(fullPath, "utf-8");
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: filePath, content, size: stat.size, ext, modified: stat.mtimeMs }));
  } catch (err) {
    if (err.code === "ENOENT") { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "File not found" })); }
    else { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: err.message })); }
  }
}

function handleWorkspaceServe(req, res) {
  const WS_ROOT = "/home/admin/.openclaw/workspace";
  const urlPath = req.url.split("?")[0];
  const relativePath = urlPath.replace(/^\/workspace\/?/, "");
  const fullPath = path.join(WS_ROOT, relativePath);
  if (!fullPath.startsWith(WS_ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mimeMap = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".mp4": "video/mp4" };
      res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Content-Length": stat.size });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
    if (stat.isDirectory()) {
      const indexPath = path.join(fullPath, "index.html");
      if (fs.existsSync(indexPath)) {
        const indexStat = fs.statSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": indexStat.size });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }
    }
  } catch (e) { logger.debug("[infra] caught:", e?.message); }
  res.writeHead(404); res.end("Not Found");
}

function handleFilesServe(req, res) {
  const { ctx } = deps;
  const FILES_ROOT = ctx.config.FILES_DIR;
  const urlPath = req.url.split("?")[0];
  const relativePath = urlPath.replace(/^\/files\/?/, "");
  const fullPath = path.join(FILES_ROOT, relativePath);
  if (!fullPath.startsWith(FILES_ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".md": "text/markdown", ".html": "text/html" };
      res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Content-Length": stat.size, "Cache-Control": "public, max-age=3600" });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
  } catch (e) { logger.debug("[infra] caught:", e?.message); }
  res.writeHead(404); res.end("File not found");
}
