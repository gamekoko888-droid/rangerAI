/**
 * modules/datasource-registry.mjs — Datasource Registry (R34-T1)
 *
 * Centralized registry of internal API documentation entries.
 * Each entry describes an internal endpoint: what it does, how to call it,
 * and which user intents should trigger its injection.
 *
 * Design principles:
 *   - Pure data module — no side effects on import
 *   - Rule-based intent matching (zero LLM cost)
 *   - Silent degradation: fetch failures never block conversation
 *   - Cache layer: 60s TTL per endpoint to avoid repeated calls
 *
 * Integration: called from knowledge-injector.mjs via matchAndFetch()
 *
 * @module modules/datasource-registry
 * @version R34-T1
 */

import { logger } from '../lib/logger.mjs';
import http from 'node:http';

const ts = () => new Date().toISOString();

// ─── Registry Entries (9 条 Ranger 真实接口) ───

export const DATASOURCE_ENTRIES = [
  {
    id: 'ds_dashboard',
    name: '系统仪表盘',
    description: '获取 RangerAI 系统整体运行状态，包括 worker 数量、活跃会话、内存使用、运行时间等核心指标。',
    patterns: [
      /仪表盘|dashboard|系统状态|系统概览|运行状态|系统健康|系统监控/i,
      /worker.*状态|worker.*数量|内存.*使用|运行.*时间|uptime/i,
      /ranger.*状态|agent.*状态|服务.*状态/i,
      /系统.*怎么样|系统.*情况|运行.*情况|服务.*情况|整体.*状况/i,
      /看看.*系统|查看.*系统|检查.*系统|系统.*报告|系统.*总结/i,
      /今天.*数据|数据.*概况|数据.*总览|数据.*汇总|整体.*数据/i,
      /性能.*怎么样|性能.*指标|性能.*报告|系统.*负载/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/system/status', label: '系统状态概览' },
      { method: 'GET', path: '/api/system/health-detail', label: '健康详情' },
    ],
    selectEndpoint: (msg) => {
      if (/详情|detail|健康|health/i.test(msg)) return [1];
      if (/概览|overview|简要/i.test(msg)) return [0];
      return [0, 1];
    },
    docSnippet: `
## 系统仪表盘 API
- GET /api/system/status → { workers, activeSessions, memoryUsage, uptime, version }
- GET /api/system/health-detail → { cpu, memory, disk, dbSize, workerPool, eventStreamSize }
用途：监控系统运行状态，排查性能问题。`
  },

  {
    id: 'ds_tasks',
    name: '任务管理',
    description: '查询 agent 任务列表、任务状态、任务历史。支持按状态/时间/会话过滤。',
    patterns: [
      /任务.*列表|任务.*状态|任务.*历史|task.*list|task.*status/i,
      /正在.*执行|执行.*中|pending.*task|running.*task/i,
      /最近.*任务|今天.*任务|任务.*统计|多少.*任务/i,
      /帮我.*查|帮我.*看|帮我.*找|帮我.*搜/i,
      /处理.*进度|完成.*情况|进度.*怎么样|做得.*怎么样/i,
      /还有.*没做|待办|to.?do|未完成|待处理/i,
      /工作.*安排|工作.*计划|今天.*做什么|接下来.*做/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/stats', label: '任务统计概览' },
      { method: 'GET', path: '/api/stats/summary', label: '任务汇总' },
    ],
    selectEndpoint: (msg) => {
      if (/统计|数量|多少|汇总|summary/i.test(msg)) return [1];
      return [0];
    },
    docSnippet: `
## 任务管理 API
- GET /api/stats → { totalTasks, activeTasks, completedTasks, failedTasks, avgDuration }
- GET /api/stats/summary → { today, week, month, byModel, byStatus }
用途：查看任务执行情况，分析成功率和耗时。`
  },

  {
    id: 'ds_kol',
    name: 'KOL 达人管理',
    description: '查询 KOL 达人列表、合作状态、绩效数据。支持按平台/状态/地区过滤。',
    patterns: [
      /kol|KOL|达人|网红|博主|influencer|红人/i,
      /达人.*列表|达人.*合作|达人.*绩效|kol.*stat/i,
      /tiktok.*达人|youtube.*达人|ins.*达人/i,
      /合作.*达人|签约.*达人|达人.*合同|达人.*费用/i,
      /达人.*数据|达人.*效果|达人.*ROI|达人.*转化/i,
      /找.*达人|推荐.*达人|筛选.*达人|达人.*筛选/i,
      /充值.*推广|游戏.*推广|推广.*效果|带货.*效果/i,
      /lootbar.*达人|lootbar.*推广|游戏.*充值.*推广/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/kols?limit=20', label: 'KOL 列表' },
    ],
    selectEndpoint: () => [0],
    docSnippet: `
## KOL 达人管理 API
- GET /api/kols?limit=20&platform=tiktok&status=active → [{ id, name, platform, followers, status, region }]
用途：管理 KOL 合作关系，查看达人数据和合作状态。`
  },

  {
    id: 'ds_web_task_stats',
    name: 'Web 任务统计',
    description: '查询 web_search/web_fetch 等网络任务的执行统计，包括成功率、平均耗时、失败原因分布。',
    patterns: [
      /web.*任务|网络.*任务|搜索.*统计|web.*task|web.*stat/i,
      /web_search|web_fetch|浏览器.*任务|browser.*task/i,
      /网络.*成功率|搜索.*失败|爬取.*统计/i,
      /搜索.*结果|搜索.*了什么|搜了.*什么|查了.*什么/i,
      /网页.*抓取|网页.*内容|网站.*数据|爬虫.*结果/i,
      /API.*调用|接口.*调用|外部.*请求|HTTP.*请求/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/stats/routing', label: '路由统计（含 web 任务）' },
      { method: 'GET', path: '/api/stats/loss-rates', label: '失败率统计' },
    ],
    selectEndpoint: (msg) => {
      if (/失败|loss|error|错误/i.test(msg)) return [1];
      if (/路由|routing|分布/i.test(msg)) return [0];
      return [0, 1];
    },
    docSnippet: `
## Web 任务统计 API
- GET /api/stats/routing → { byModel, byTool, webSearchCount, webFetchCount, avgLatency }
- GET /api/stats/loss-rates → { overallLoss, byTool: [{ tool, successRate, avgDuration, failReasons }] }
用途：监控网络任务执行质量，优化工具调用策略。`
  },

  {
    id: 'ds_task_quality',
    name: '任务质量分析',
    description: '查询任务质量指标，包括用户满意度、模型路由分布、KV-Cache 命中率。',
    patterns: [
      /任务.*质量|质量.*分析|满意度|quality|模型.*路由/i,
      /kv.*cache|缓存.*命中|cache.*hit|token.*消耗/i,
      /模型.*分布|模型.*使用|哪个.*模型|model.*usage/i,
      /花了.*多少|消耗.*多少|成本.*多少|费用.*多少/i,
      /token.*消耗|token.*使用|API.*费用|API.*成本/i,
      /回复.*质量|回答.*质量|准确率|效果.*怎么样/i,
      /openai.*费用|claude.*费用|gpt.*消耗|模型.*费用/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/system/kv-cache-stats', label: 'KV-Cache 统计' },
      { method: 'GET', path: '/api/stats/routing', label: '模型路由分布' },
    ],
    selectEndpoint: (msg) => {
      if (/kv|cache|缓存/i.test(msg)) return [0];
      if (/模型|model|路由/i.test(msg)) return [1];
      return [0, 1];
    },
    docSnippet: `
## 任务质量分析 API
- GET /api/system/kv-cache-stats → { totalHits, totalMisses, hitRate, savedTokens, savedCost }
- GET /api/stats/routing → { byModel: [{ model, count, avgTokens }], byTool: [...] }
用途：分析模型使用效率和缓存命中率，优化成本。`
  },

  {
    id: 'ds_supervisor',
    name: 'Supervisor 监控',
    description: '查询 Supervisor agent 的干预记录，包括阻断原因、重规划触发、错误恢复事件。',
    patterns: [
      /supervisor|监督|干预|阻断|block|重规划|replan/i,
      /错误.*恢复|error.*recovery|max.*retries|连续.*失败/i,
      /agent.*监控|agent.*干预|安全.*检查/i,
      /出.*错|报错|异常|故障|bug|问题/i,
      /修复.*了吗|解决.*了吗|恢复.*了吗|好了.*吗/i,
      /失败.*原因|为什么.*失败|什么.*出错|哪里.*出错/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/admin/event-stats?days=7', label: '事件统计（含 Supervisor）' },
    ],
    selectEndpoint: () => [0],
    docSnippet: `
## Supervisor 监控 API
- GET /api/admin/event-stats?days=7 → { summary, typeDistribution, recentEvents, dailyTrend }
  - summary 包含: supervisor_block, max_retries_exceeded, replan 等事件计数
用途：监控 agent 自主运行质量，查看干预和恢复记录。`
  },

  {
    id: 'ds_knowledge',
    name: '知识库管理',
    description: '查询知识库条目、注入记录、检索命中率。',
    patterns: [
      /知识库|knowledge|知识.*条目|知识.*注入|知识.*检索/i,
      /文档.*库|doc.*base|参考.*资料|业务.*文档/i,
      /知识.*命中|知识.*覆盖|知识.*统计/i,
      /有没有.*资料|有没有.*文档|有没有.*记录/i,
      /之前.*说过|之前.*提到|历史.*记录|聊天.*记录/i,
      /记住|记一下|保存.*信息|存.*下来/i,
      /参考.*信息|背景.*信息|相关.*资料|相关.*文档/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/admin/event-stats?days=30', label: '知识注入事件统计' },
    ],
    selectEndpoint: () => [0],
    docSnippet: `
## 知识库管理 API
- GET /api/admin/event-stats?days=30 → { summary: { knowledgeInjected, totalEvents }, typeDistribution }
  - knowledge_injected 事件包含: charCount, segments, searchTerms
用途：监控知识库注入效果，优化检索覆盖率。`
  },

  {
    id: 'ds_event_stream',
    name: '事件流查询',
    description: '查询 agent event_stream 中的所有事件，支持按类型/时间/会话过滤。',
    patterns: [
      /事件.*流|event.*stream|事件.*查询|事件.*记录/i,
      /事件.*类型|事件.*统计|事件.*分布|event.*type/i,
      /最近.*事件|今天.*事件|事件.*趋势/i,
      /日志|log|操作.*记录|行为.*记录/i,
      /发生.*什么|刚才.*什么|最近.*发生/i,
      /活动.*记录|使用.*记录|访问.*记录/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/admin/event-stats?days=7', label: '事件流统计' },
    ],
    selectEndpoint: () => [0],
    docSnippet: `
## 事件流查询 API
- GET /api/admin/event-stats?days=7 → { summary, typeDistribution, recentEvents, dailyTrend }
  - 支持 22+ 种事件类型: user_message, action, observation, plan_update, tts_generated, max_retries_exceeded 等
  - recentEvents 返回最近 50 条事件详情（含 payload）
用途：全链路可观测，追踪 agent loop 的每个决策点。`
  },

  {
    id: 'ds_task_replay',
    name: '任务回放',
    description: '查询特定任务的完整执行轨迹，包括每一步的工具调用、模型输出、状态变更。',
    patterns: [
      /任务.*回放|task.*replay|执行.*轨迹|执行.*记录/i,
      /任务.*详情|任务.*步骤|task.*detail|task.*trace/i,
      /调试.*任务|debug.*task|任务.*日志/i,
      /看看.*过程|执行.*过程|怎么.*做的|做了.*什么/i,
      /复盘|回顾|分析.*过程|追踪.*问题/i,
      /上次.*任务|之前.*任务|历史.*任务/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/system/run-traces', label: '运行轨迹列表' },
      { method: 'GET', path: '/api/system/agent-metrics', label: 'Agent 指标' },
    ],
    selectEndpoint: (msg) => {
      if (/指标|metric|性能/i.test(msg)) return [1];
      if (/轨迹|trace|回放|replay/i.test(msg)) return [0];
      return [0, 1];
    },
    docSnippet: `
## 任务回放 API
- GET /api/system/run-traces → [{ taskId, sessionKey, startTime, endTime, steps, toolCalls, model }]
- GET /api/system/agent-metrics → { avgResponseTime, toolCallCount, modelUsage, errorRate }
用途：回放任务执行过程，分析瓶颈和优化点。`
  },
];

// ─── Cache Layer ───
const _cache = new Map();
const CACHE_TTL = 60_000; // 60s

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  // Evict old entries
  if (_cache.size > 50) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
}

// ─── Internal API Caller ───
function callAPI(method, path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const port = 3002; // API server port
    const opts = { hostname: '127.0.0.1', port, path, method, timeout: timeoutMs };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body.substring(0, 500) });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Summarize API Response ───
function summarize(label, response) {
  if (!response || !response.data) return `[${label}]: 无数据`;
  const data = response.data;
  if (typeof data === 'string') return `[${label}]: ${data.substring(0, 300)}`;
  // Smart summarization based on data shape
  if (Array.isArray(data)) {
    return `[${label}]: ${data.length} 条记录\n${JSON.stringify(data.slice(0, 3), null, 2).substring(0, 500)}${data.length > 3 ? '\n... 更多记录省略' : ''}`;
  }
  return `[${label}]: ${JSON.stringify(data, null, 2).substring(0, 800)}`;
}

// ─── Core: Match Intent & Fetch Data ───

/**
 * Match user message against registry entries and fetch relevant data.
 * @param {string} userMessage - The user's message text
 * @returns {Promise<{block: string|null, matchedIds: string[], docSnippets: string[]}>}
 */
export async function matchAndFetch(userMessage) {
  const matched = [];

  for (const entry of DATASOURCE_ENTRIES) {
    for (const pattern of entry.patterns) {
      if (pattern.test(userMessage)) {
        matched.push(entry);
        break; // first pattern match per entry
      }
    }
  }

  if (matched.length === 0) {
    return { block: null, matchedIds: [], docSnippets: [] };
  }

  logger.info(`[${ts()}] [datasource-registry] Matched ${matched.length} entries: ${matched.map(e => e.id).join(', ')}`);

  const results = [];
  const docSnippets = [];

  for (const entry of matched) {
    const indices = entry.selectEndpoint(userMessage);
    docSnippets.push(entry.docSnippet.trim());

    for (const idx of indices) {
      const ep = entry.endpoints[idx];
      if (!ep) continue;

      const cacheKey = `${ep.method}:${ep.path}`;
      const cached = getCached(cacheKey);
      if (cached) {
        results.push(cached);
        continue;
      }

      try {
        const response = await callAPI(ep.method, ep.path);
        const summary = summarize(ep.label, response);
        results.push(summary);
        setCache(cacheKey, summary);
      } catch (err) {
        logger.warn(`[${ts()}] [datasource-registry] API call failed: ${ep.path} — ${err.message}`);
      }
    }
  }

  if (results.length === 0 && docSnippets.length === 0) {
    return { block: null, matchedIds: matched.map(e => e.id), docSnippets: [] };
  }

  // Build injection block
  let block = '\n\n[DATASOURCE]\n';
  block += '以下是从内部 API 文档库匹配到的相关接口信息和实时数据：\n\n';

  // API documentation
  if (docSnippets.length > 0) {
    block += '### 相关 API 文档\n';
    block += docSnippets.join('\n\n');
    block += '\n\n';
  }

  // Live data
  if (results.length > 0) {
    block += '### 实时查询结果\n';
    block += results.join('\n\n');
    block += '\n';
  }

  block += '[/DATASOURCE]';

  return {
    block,
    matchedIds: matched.map(e => e.id),
    docSnippets,
  };
}

/**
 * Get all registry entries (for admin API).
 * @returns {Array} All datasource entries with metadata
 */
export function getAllEntries() {
  return DATASOURCE_ENTRIES.map(e => ({
    id: e.id,
    name: e.name,
    description: e.description,
    patternCount: e.patterns.length,
    endpointCount: e.endpoints.length,
    endpoints: e.endpoints.map(ep => ({ method: ep.method, path: ep.path, label: ep.label })),
    docSnippet: e.docSnippet.trim(),
  }));
}

/**
 * Get entry count.
 */
export function getEntryCount() {
  return DATASOURCE_ENTRIES.length;
}
