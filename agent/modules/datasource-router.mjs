/**
 * modules/datasource-router.mjs — Datasource Intent Router (v28.0)
 * 
 * Maps user intent to internal API endpoints, injecting structured data hints
 * into the user message so the AI can answer from internal data instead of web_search.
 * 
 * Integration point: called from knowledge-injector.mjs after knowledge retrieval.
 * 
 * Supported datasources:
 *   - tickets: 工单系统 (GET /api/tickets, /api/tickets/stats)
 *   - kols: KOL 管理 (GET /api/kols)
 *   - stats: 系统统计 (GET /api/system/status, /api/tickets/stats)
 *   - inventory: 库存查询 (GET /api/inventory)
 *   - notifications: 通知记录 (GET /api/notifications)
 * 
 * Design: Pure rule-based intent classification (zero LLM cost).
 * Failure: Silent degradation — returns null, never blocks conversation.
 * 
 * @module modules/datasource-router
 * @version 28.0
 */

import { logger } from '../lib/logger.mjs';
import http from 'node:http';
// [R28-T3] Import event emitter for datasource_routed tracking
let _emitEvent = null;
try {
  const esm = await import('../worker/event-stream.mjs');
  _emitEvent = esm.emitEvent;
} catch (_) { /* non-fatal: event emission optional */ }

const ts = () => new Date().toISOString();

// ─── Intent Classification Rules ───
const DATASOURCE_RULES = [
  {
    id: 'tickets',
    patterns: [
      /工单|ticket|工单列表|待处理|未解决|客诉|投诉|反馈|售后/i,
      /ticket.*stat|工单.*统计|工单.*数量|多少.*工单/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/tickets?status=open&limit=10', label: '待处理工单' },
      { method: 'GET', path: '/api/tickets/stats', label: '工单统计' },
    ],
    // Only fetch stats for counting questions, full list for detail questions
    selectEndpoint: (msg) => {
      if (/统计|数量|多少|占比|趋势|分布/i.test(msg)) return [1]; // stats only
      if (/列表|详情|查看|哪些|最新/i.test(msg)) return [0]; // list only
      return [0, 1]; // both
    }
  },
  {
    id: 'kols',
    patterns: [
      /kol|KOL|达人|网红|博主|influencer|合作.*达人|达人.*合作/i,
      /kol.*列表|达人.*列表|达人.*状态|kol.*stat/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/kols?limit=20', label: 'KOL列表' },
    ],
    selectEndpoint: () => [0],
  },
  {
    id: 'stats',
    patterns: [
      /系统状态|系统.*统计|服务.*状态|健康.*检查|system.*status/i,
      /今日.*数据|今天.*数据|运营.*数据|dashboard|仪表盘/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/system/status', label: '系统状态' },
      { method: 'GET', path: '/api/tickets/stats', label: '工单统计' },
    ],
    selectEndpoint: () => [0, 1],
  },
  {
    id: 'inventory',
    patterns: [
      /库存|inventory|商品.*数量|充值卡|卡密|stock/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/inventory?limit=20', label: '库存列表' },
    ],
    selectEndpoint: () => [0],
  },
  {
    id: 'notifications',
    patterns: [
      /通知.*记录|通知.*列表|最近.*通知|notification/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/notifications?limit=10', label: '通知记录' },
    ],
    selectEndpoint: () => [0],
  },
  // [R29-T3] 用户管理路由规则
  {
    id: 'users',
    patterns: [
      /用户|user|客户|会员|注册.*用户|用户.*列表|活跃.*用户/i,
      /user.*list|user.*stat|用户.*统计|用户.*数量|多少.*用户/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/users?limit=20', label: '用户列表' },
      { method: 'GET', path: '/api/users/stats', label: '用户统计' },
    ],
    selectEndpoint: (msg) => {
      if (/统计|数量|多少|占比|趋势|活跃/i.test(msg)) return [1];
      if (/列表|详情|查看|哪些|最新/i.test(msg)) return [0];
      return [0, 1];
    }
  },
  // [R29-T3] 订单管理路由规则
  {
    id: 'orders',
    patterns: [
      /订单|order|充值.*订单|订单.*列表|最近.*订单|退款|退单/i,
      /order.*stat|订单.*统计|订单.*数量|多少.*订单|成交|交易/i,
    ],
    endpoints: [
      { method: 'GET', path: '/api/orders?limit=20&sort=created_at:desc', label: '最近订单' },
      { method: 'GET', path: '/api/orders/stats', label: '订单统计' },
    ],
    selectEndpoint: (msg) => {
      if (/统计|数量|多少|占比|趋势|成交|交易额/i.test(msg)) return [1];
      if (/列表|详情|查看|哪些|最新|退款/i.test(msg)) return [0];
      return [0, 1];
    }
  },
];

/**
 * Classify user message intent and return matching datasource IDs.
 * @param {string} message - User message
 * @returns {Array<{id: string, endpointIndices: number[]}>}
 */
function classifyDatasourceIntent(message) {
  const matches = [];
  for (const rule of DATASOURCE_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(message)) {
        matches.push({
          id: rule.id,
          endpointIndices: rule.selectEndpoint(message),
        });
        break; // Only match first pattern per rule
      }
    }
  }
  return matches;
}

/**
 * Call internal API endpoint via localhost.
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {number} timeoutMs - Timeout in ms
 * @returns {Promise<{status: number, data: any}>}
 */
function callInternalAPI(method, path, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Internal API timeout: ${path}`));
    }, timeoutMs);

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3002,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-call': '1',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data.substring(0, 500) });
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/**
 * Summarize API response data for injection into user message.
 * Keeps it compact to avoid bloating context.
 * @param {string} label - Human-readable label
 * @param {object} response - API response
 * @returns {string}
 */
function summarizeResponse(label, response) {
  const { status, data } = response;
  if (status !== 200) return `${label}: API 返回 ${status}`;
  
  if (Array.isArray(data)) {
    // List response — show count + first 5 items summary
    const count = data.length;
    const preview = data.slice(0, 5).map(item => {
      // Extract key fields for compact display
      const fields = [];
      if (item.title) fields.push(item.title);
      if (item.name) fields.push(item.name);
      if (item.status) fields.push(`[${item.status}]`);
      if (item.priority) fields.push(`P:${item.priority}`);
      if (item.platform) fields.push(item.platform);
      if (item.handle) fields.push(`@${item.handle}`);
      return fields.join(' | ') || JSON.stringify(item).substring(0, 80);
    });
    return `${label} (共${count}条):\n${preview.map((p, i) => `  ${i+1}. ${p}`).join('\n')}${count > 5 ? `\n  ... 还有${count - 5}条` : ''}`;
  }
  
  if (data && typeof data === 'object') {
    // Object response (stats, status) — compact JSON
    const compact = JSON.stringify(data, null, 0).substring(0, 500);
    return `${label}: ${compact}`;
  }
  
  return `${label}: ${String(data).substring(0, 200)}`;
}

// ─── TTL Cache for datasource results ───
const _dsCache = new Map();
const DS_CACHE_TTL = 60_000; // 1 minute (shorter than knowledge cache since data changes more)
const DS_CACHE_MAX = 20;

function getCachedResult(cacheKey) {
  const entry = _dsCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > DS_CACHE_TTL) {
    _dsCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setCachedResult(cacheKey, data) {
  if (_dsCache.size >= DS_CACHE_MAX) {
    const oldest = _dsCache.keys().next().value;
    _dsCache.delete(oldest);
  }
  _dsCache.set(cacheKey, { data, ts: Date.now() });
}

/**
 * Main entry point: classify intent, fetch data, return injection block.
 * 
 * @param {string} userMessage - Raw user message
 * @returns {Promise<string|null>} - Datasource context block or null
 */
export async function fetchDatasourceContext(userMessage) {
  try {
    const matches = classifyDatasourceIntent(userMessage);
    if (matches.length === 0) return null;

    logger.info(`[${ts()}] [datasource] Intent matched: ${matches.map(m => m.id).join(', ')}`);

    const results = [];
    for (const match of matches) {
      const rule = DATASOURCE_RULES.find(r => r.id === match.id);
      if (!rule) continue;

      for (const idx of match.endpointIndices) {
        const ep = rule.endpoints[idx];
        if (!ep) continue;

        const cacheKey = `${ep.method}:${ep.path}`;
        const cached = getCachedResult(cacheKey);
        if (cached) {
          results.push(cached);
          logger.info(`[${ts()}] [datasource] Cache HIT: ${cacheKey}`);
          continue;
        }

        try {
          const response = await callInternalAPI(ep.method, ep.path);
          const summary = summarizeResponse(ep.label, response);
          results.push(summary);
          setCachedResult(cacheKey, summary);
        } catch (apiErr) {
          logger.warn(`[${ts()}] [datasource] API call failed: ${ep.path} — ${apiErr.message}`);
          // Silent failure per endpoint — continue with others
        }
      }
    }

    if (results.length === 0) return null;

    const block = `\n\n[DATASOURCE_CONTEXT]\n以下是从内部系统实时查询的数据，请优先使用这些数据回答用户问题：\n${results.join('\n\n')}\n[/DATASOURCE_CONTEXT]`;
    
    logger.info(`[${ts()}] [datasource] Injected ${results.length} datasource results (${block.length} chars)`);
    // [R28-T3] Emit datasource_routed event for observability
    if (_emitEvent) {
      try {
        _emitEvent('system', 'datasource_routed', {
          matchedIntents: matches.map(m => m.id),
          resultCount: results.length,
          blockLength: block.length,
        });
      } catch (_) {}
    }
    return block;
  } catch (err) {
    logger.warn(`[${ts()}] [datasource] fetchDatasourceContext failed (silent): ${err.message}`);
    return null;
  }
}

/**
 * Export for testing
 */
export { classifyDatasourceIntent, DATASOURCE_RULES };
