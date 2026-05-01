/**
 * knowledge-injector.mjs — 知识上下文内联注入管道
 * RAG v2（2026-03-24）：
 *   - Step1: 注入时带来源标注（title + score），模型可引用
 *   - Step2: 直接用原始消息做语义搜索（去掉手工关键词提取）
 *   - Step3: 记录 knowledge_search_log，追踪命中率
 * P3 v4（2026-04-01）：
 *   - 用户级持久记忆注入：从 users.agentMemory 读取并注入 <user_memory> 块
 * v26.0（2026-04-09）：
 *   - 意图分类 classifyIntent()：规则优先，零 LLM 消耗
 *   - scope 过滤：按意图动态检索知识，scope='general' 始终命中
 *   - token 预算：注入内容硬限 2500 tokens（~10000 chars），超出截断
 *   - 降级安全：检索失败静默跳过，不影响对话
 */

import { sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { handleAnalyzeImage as analyzeImage } from "./vision-analyzer.mjs";
import { emitEvent } from "./event-stream.mjs";
import { segmentLongMessage } from "./segmenter.mjs";
import { cosineSimilarity, hashEmbedding } from "../lib/rag-utils.mjs"; // [R60-T3] Semantic knowledge enrichment

import { logger } from '../lib/logger.mjs';
import { fetchDatasourceContext } from '../modules/datasource-router.mjs';
import { matchAndFetch } from '../modules/datasource-registry.mjs'; // [R34-T1] Datasource Registry
// [R26-T4] Import planner to get planText for system prompt injection
let _plannerModule = null;
try {
  _plannerModule = await import('./planner.mjs');
} catch (_) { /* planner not available — skip planText injection */ }
import { createRequire } from 'module';
const ts = () => new Date().toISOString();

// [R24-T3] Knowledge entries injector — reads from knowledge_entries table in worker DB
let _knowledgeBaseBlock = null;
let _knowledgeBaseTs = 0;
let _kbScopeCache = null; // [R42-T5] Scope-aware cache
const KB_CACHE_TTL = 10 * 60 * 1000; // 10 min cache

async function getKnowledgeBaseBlock(scopes = null) {
  // [R42-T5] Scope-filtered knowledge base block
  const scopeKey = scopes ? scopes.sort().join(',') : '_all_';
  const cacheKey = '_kb_' + scopeKey;
  if (_kbScopeCache && _kbScopeCache.key === cacheKey && Date.now() - _kbScopeCache.ts < KB_CACHE_TTL) {
    return _kbScopeCache.block;
  }
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const db = new Database('/opt/rangerai-agent/db/rangerai.db', { readonly: true });
    const entries = db.prepare(
      'SELECT category, title, content, priority, scope, relevance_weight FROM knowledge_entries WHERE active = 1 ORDER BY priority DESC, updated_at DESC LIMIT 30'
    ).all();
    db.close();
    // [R42-T5] Filter by scope if provided
    const filtered = scopes && scopes.length > 0
      ? entries.filter(e => {
          const entryScopes = (e.scope || 'general').split(',').map(s => s.trim());
          return entryScopes.some(es => {
            if (es === 'general') return true;
            if (scopes.includes(es)) return true;
            // [R43-T5] Sub-scope matching: game-topup.pubg matches game-topup
            const parentScope = es.split('.')[0];
            if (parentScope !== es && scopes.includes(parentScope)) return true;
            // Also check if any requested scope is a sub-scope of entry scope
            return scopes.some(rs => rs.startsWith(es + '.'));
          });
        })
      : entries;
    // [R43-T5] Apply relevance_weight filter (>= 0.5)
    const weightFiltered = filtered.filter(e => (e.relevance_weight || 0.8) >= 0.5);
    logger.info(`[${ts()}] [R43-T5] Knowledge filter: requested=${scopes ? scopes.join(',') : 'all'} total=${entries.length} scopeFiltered=${filtered.length} weightFiltered=${weightFiltered.length}`);
    // [RXX-T1] Dedup by (title, content) — prevent duplicate entries from inflating the knowledge block
    const seen = new Set();
    const filtered_final = weightFiltered.filter(e => {
      const key = `${e.title}|||${e.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!filtered_final || filtered_final.length === 0) {
      _kbScopeCache = { key: cacheKey, block: '', ts: Date.now() };
      return '';
    }
    // Group by category
    const grouped = {};
    for (const e of filtered_final) {
      const cat = e.category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(e);
    }
    const lines = ['<knowledge_base>'];
    for (const [category, items] of Object.entries(grouped)) {
      lines.push(`\n## ${category.charAt(0).toUpperCase() + category.slice(1)}`);
      for (const item of items) {
        lines.push(`\n### ${item.title}`);
        lines.push(item.content);
      }
    }
    lines.push('\n</knowledge_base>');
    const block = lines.join('\n');
    _kbScopeCache = { key: cacheKey, block, ts: Date.now() };
    logger.info(`[${ts()}] [R42-T5] Knowledge base block generated: ${filtered.length}/${entries.length} entries (scope-filtered), ${block.length} chars`);
    return block;
  } catch (err) {
    logger.warn(`[${ts()}] [R42-T5] Knowledge base block failed (non-fatal): ${err.message}`);
    _kbScopeCache = { key: cacheKey, block: '', ts: Date.now() };
    return '';
  }
}
const GATEWAY_SAFE_LENGTH = 12000;
const MAX_KNOWLEDGE_CHARS = 8000;
const MAX_MEMORY_CHARS = 2000;

// ─── v26.0: Token budget for dynamic knowledge injection ───
const MAX_DYNAMIC_KNOWLEDGE_TOKENS = 2500;  // ~10000 chars for Chinese
const MAX_DYNAMIC_KNOWLEDGE_CHARS = 10000;  // Hard char limit (conservative estimate: 4 chars/token for CJK)
// ─── v27.0: Knowledge retrieval TTL cache (5 min) ───
const KNOWLEDGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const KNOWLEDGE_CACHE_MAX_SIZE = 100;
const _knowledgeCache = new Map(); // key → { result, timestamp }

function _cacheKey(query, scopes) {
  // Normalize: first 100 chars lowercase + sorted scopes
  const q = (query || '').slice(0, 100).toLowerCase().trim();
  const s = [...scopes].sort().join(',');
  return `${q}||${s}`;
}

function _getCached(key) {
  const entry = _knowledgeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > KNOWLEDGE_CACHE_TTL_MS) {
    _knowledgeCache.delete(key);
    return null;
  }
  return entry.result;
}

function _setCache(key, result) {
  // Evict oldest entries if over max size
  if (_knowledgeCache.size >= KNOWLEDGE_CACHE_MAX_SIZE) {
    const oldest = _knowledgeCache.keys().next().value;
    _knowledgeCache.delete(oldest);
  }
  _knowledgeCache.set(key, { result, timestamp: Date.now() });
}


/**
 * v26.0: Rule-based intent classification for scope-filtered knowledge retrieval.
 * v26.1 [R6-Task4]: Enhanced with stepHint from planner for plan-driven scope refinement.
 * Zero LLM consumption — pure keyword matching.
 * 
 * Scope values: general, code, operations, customer-service, kol, analysis, research, creative
 * Returns array of matching scopes (always includes 'general').
 * 
 * @param {string} message - User message text
 * @param {{ stepTitle?: string, stepTools?: string[] }} [stepHint] - Optional hint from current plan step
 * @returns {string[]} Array of scope strings
 */
export function classifyIntent(message, stepHint = null) {
  if (!message || typeof message !== 'string') return ['general'];
  
  // [R6-Task4] Combine user message with step context for better scope detection
  let text = message.toLowerCase();
  if (stepHint) {
    if (stepHint.stepTitle) text += ' ' + stepHint.stepTitle.toLowerCase();
    if (stepHint.stepTools && stepHint.stepTools.length > 0) text += ' ' + stepHint.stepTools.join(' ').toLowerCase();
  }
  const scopes = new Set(['general']); // Always include general
  
  // Code / Development
  if (/代码|修改代码|部署|bug|错误|报错|fix|debug|编程|函数|变量|接口|api|前端|后端|组件|脚本|编译|构建|build|compile|import|export|class|function|module|npm|pnpm|git|commit|merge|branch|docker|container|vite|react|node|typescript|javascript|python|sql|数据库|database|schema|migration|query|index|table/i.test(text)) {
    scopes.add('code');
  }
  
  // Operations / Infrastructure
  if (/服务器|重启|内存|磁盘|日志|systemctl|systemd|nginx|caddy|ssh|scp|端口|port|进程|process|cpu|负载|监控|告警|alert|cron|定时|备份|恢复|restore|运维|devops|防火墙|firewall|ssl|证书|域名|dns/i.test(text)) {
    scopes.add('operations');
  }
  
  // Customer Service
  if (/客服|工单|用户投诉|退款|refund|售后|售前|客户|咨询|反馈|feedback|support|帮助中心|FAQ|常见问题|投诉|complaint/i.test(text)) {
    scopes.add('customer-service');
  }
  
  // KOL / Marketing — [R30-T2] 扩展游戏/充值/出海相关关键词
  if (/kol|达人|合作|粉丝|influencer|网红|推广|营销|marketing|内容创作|社媒|社交媒体|tiktok|抖音|youtube|直播|带货|种草|游戏主播|游戏推广|blogger|youtuber|streamer|创作者|content creator/i.test(text)) {
    scopes.add('kol');
  }
  
  // Game Top-up / Supply Chain — [R30-T2] 游戏充值供应链专属 scope
  if (/游戏|充值|点卡|卡密|lootbar|供应商|供应链|上游|补货|库存|游戏币|钻石|金币|giftcard|gift card|steam|pubg|mlbb|mlbb|mobile legend|freefire|genshin|原神|王者|和平精英|比价|价差|利润|毛利|出货|采购|结算|汇率|外汇|跨境支付|全球充值|海外游戏/i.test(text)) {
    scopes.add('game-topup');
  }

  // Data Analysis
  if (/数据分析|统计|报表|周报|月报|dashboard|图表|chart|指标|metric|kpi|转化率|留存|arpu|ltv|roi|gmv|环比|同比|趋势|增长|下降|销量|销售额|订单量|成功率|失败率|出错率/i.test(text)) {
    scopes.add('analysis');
  }
  
  // Research — [R30-T2] 扩展竞品/市场关键词
  if (/研究|调研|竞品|市场分析|行业|趋势分析|报告|白皮书|论文|paper|research|survey|benchmark|对比|分析|比较|competitors|comparison|market share|市场份额|占比|深度研究|综合分析|多源|详细报告|deep research|comprehensive|in-depth/i.test(text)) {
    scopes.add('research');
    // R39-T3: Flag as deep research for directive injection
    if (/深度研究|综合分析|详细报告|deep research|comprehensive analysis|in-depth research|多源搜索|全面调研/i.test(text)) {
      scopes.add('deep_research');
    }
  }
  
  // Creative / Writing — [R30-T2] 扩展邮件/外联相关
  if (/写作|文案|copywriting|创意|设计|品牌|slogan|标题|描述|翻译|translate|润色|改写|摘要|总结|邮件|email|outreach|外联|合作邀请|pitch|提案|介绍信/i.test(text)) {
    scopes.add('creative');
  }

  // Customer Service — [R30-T2] 扩展工单/售后关键词
  if (/(customer|客服|工单|用户投诉|退款|refund|售后|售前|客户|咨询|反馈|feedback|support|帮助|FAQ|常见问题|投诉|complaint|ticket|issue|问题|充值失败|未到账|到账|客诉|纠纷|赔偿)/i.test(text)) {
    scopes.add('customer-service');
  }

  logger.debug(`[R30-T2] classifyIntent: scopes=${[...scopes].join(',')}, text_preview="${text.slice(0,60)}..."`);
  
  return Array.from(scopes);
}

/**
 * Helper to format user memory for injection.
 * Sorts keys for KV-cache stability.
 */
export function formatMemory(memory) {
  if (!memory || memory === '{}' || memory === '[]') return '';
  if (typeof memory === 'object') {
    const entries = Object.entries(memory).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
  }
  return String(memory).slice(0, 2000); // 2000 is MAX_MEMORY_CHARS
}

/**
 * P3: 查询用户持久记忆
 * @param {string} userId
 * @returns {string} 记忆文本（空字符串表示无记忆）
 */
async function getUserMemory(userId) {
  if (!userId || userId === 'system') return '';
  try {
    const http = (await import('http')).default;
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 3002,
        path: `/api/user/${encodeURIComponent(userId)}/memory`,
        method: 'GET',
        headers: { 'x-internal-call': '1' }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    const memory = result.memory || result.agentMemory || '';
    return formatMemory(memory);
  } catch (e) {
    logger.info(`[${ts()}] [memory] getUserMemory failed for ${userId}: ${e.message}`);
    return '';
  }
}

/**
 * 主动检索知识库。
 * v2: 直接用原始消息做语义搜索（不再手工提取关键词）；返回带 source 标注的文本块。
 * v26.0: 增加 scope 过滤 + token 预算控制 + priority 排序
 * v26.1 [R6-Task4]: 增加 stepHint 参数支持计划驱动的 scope 精确过滤
 * @param {string} userMessage
 * @param {string} userId
 * @param {{ stepTitle?: string, stepTools?: string[] }} [stepHint]
 * @returns {{ text: string, hits: Array, scopes: string[] }} text 用于注入，hits 用于日志，scopes 用于调试
 */
// [R60-T3] hashEmbedding imported from ../lib/rag-utils.mjs

/**
 * [R60-T3] Semantic re-ranking of knowledge search results.
 * Uses hash embedding similarity to boost semantically relevant docs
 * that may have lower keyword/scope scores but higher content relevance.
 */
function semanticReRank(docs, queryEmbedding) {
  return docs.map(doc => {
    const contentForEmbed = (doc.title || '') + ' ' + (doc.content || doc.snippet || '').slice(0, 500);
    const docEmbedding = hashEmbedding(contentForEmbed);
    const semanticScore = cosineSimilarity(queryEmbedding, docEmbedding);
    // Combine: 70% original score + 30% semantic score
    const origScore = doc.rrfScore || doc.score || 0;
    const combinedScore = origScore * 0.7 + semanticScore * 0.3;
    return { ...doc, semanticScore, combinedScore };
  }).sort((a, b) => b.combinedScore - a.combinedScore);
}

async function activeKnowledgeSearch(userMessage, userId, stepHint = null) {
  // [R57-T2] 提升 TOP_K：从 5 → 8，增加候选命中数，提升覆盖率
  const TOP_K = 8;

  const query = userMessage.slice(0, 200).trim();
  if (!query || query.length < 4) return { text: '', hits: [], scopes: ['general'] };

  const scopes = classifyIntent(userMessage, stepHint);
  if (stepHint) {
    logger.info(`[${ts()}] [R6-scope] stepHint applied: title="${(stepHint.stepTitle || '').substring(0, 60)}" tools=${(stepHint.stepTools || []).join(',')} scopes=${scopes.join(',')}`);
  }

  const cKey = _cacheKey(query, scopes);
  const cached = _getCached(cKey);
  if (cached) {
    logger.info(`[${ts()}] [knowledge] v27.0 cache HIT: key=${cKey.slice(0,40)}... hits=${cached.hits.length}`);
    return cached;
  }

  try {
    const http = (await import('http')).default;
    const body = JSON.stringify({ query, limit: TOP_K, scopes });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 3002,
        path: '/api/knowledge/search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-call': '1', 'x-user-id': userId || '', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });

    const docs = result.docs || [];
    if (!docs.length) return { text: '', hits: [], scopes };

    // [R60-T3] Semantic re-ranking: boost docs with high semantic similarity to query
    let sortedDocs;
    try {
      const queryEmbedding = hashEmbedding(userMessage);
      sortedDocs = semanticReRank(docs, queryEmbedding);
      logger.info(`[${ts()}] [R60-T3] Semantic re-rank: ${sortedDocs.length} docs, top sim=${sortedDocs[0]?.semanticScore?.toFixed(3) || 'N/A'}`);
    } catch (srErr) {
      // Fallback: original priority+score sort
      sortedDocs = [...docs].sort((a, b) => {
        const priA = a.priority ?? 50;
        const priB = b.priority ?? 50;
        if (priB !== priA) return priB - priA;
        const scoreA = a.rrfScore || a.score || 0;
        const scoreB = b.rrfScore || b.score || 0;
        return scoreB - scoreA;
      });
      logger.warn(`[${ts()}] [R60-T3] Semantic re-rank failed (falling back to priority+score): ${srErr.message}`);
    }

    const blocks = [];
    let totalChars = 0;
    const hits = [];

    for (const doc of sortedDocs) {
      if (doc.enabled === 0) continue;
      
      // P1-3: Skip low-relevance results
      // [R57-T2] 降低过滤阈值：0.10 → 0.05，减少因 score 过低被跳过导致覆盖率不足
      // 说明：rrfScore 是 RRF 融合分，0.05 已能保证基本相关性
      const docScore = doc.rrfScore || doc.score || 0;
      if (docScore < 0.05) continue; // R57-T2: lowered from 0.10 to 0.05
      const title = doc.title || '未知文档';
      const score = doc.score != null ? doc.score.toFixed(2) : (doc.rrfScore != null ? doc.rrfScore.toFixed(3) : null);
      const scoreStr = score ? `（相关度 ${score}）` : '';
      const content = (doc.content || doc.snippet || '').slice(0, 1200);
      if (!content) continue;

      const block = `### 来源：${title}${scoreStr}\n${content}`;
      
      if (totalChars + block.length > MAX_DYNAMIC_KNOWLEDGE_CHARS) break;

      blocks.push(block);
      totalChars += block.length;
      hits.push({ id: doc.id, title, score: doc.score || doc.rrfScore || null, scope: doc.scope || 'general' });
    }

    if (!blocks.length) return { text: '', hits: [], scopes };

    logKnowledgeSearch(query, hits, scopes).catch(() => {});

    logger.info(`[${ts()}] [knowledge] v26.0 scope-filtered search: scopes=${scopes.join(',')} hits=${hits.length} chars=${totalChars}`);
    const searchResult = { text: blocks.join('\n\n'), hits, scopes };
    _setCache(cKey, searchResult);
    return searchResult;
  } catch (e) {
    logger.warn(`[${ts()}] [knowledge] search failed (graceful skip):`, e.message);
    return { text: '', hits: [], scopes };
  }
}

/**
 * 记录知识库搜索日志到 knowledge_search_log 表。
 * 表不存在时自动跳过（不崩溃）。
 * v26.0: 增加 scopes 参数记录意图分类结果
 */
async function logKnowledgeSearch(query, hits, scopes = []) {
  try {
    const http = (await import('http')).default;
    const body = JSON.stringify({ query, hits, scopes, ts: new Date().toISOString() });
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: 3002,
        path: '/api/knowledge/search-log', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-call': '1', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); resolve(); });
      req.on('error', resolve); // 静默失败
      req.setTimeout(1000, () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    });
  } catch(_err) { /* v22.0 */ logger.error("[knowledge-injector] silent catch:", _err?.message || _err); }
}


// [R35-T1] Vision: auto-detect image URLs in user message and analyze them
const IMAGE_URL_PATTERN = /https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg|tiff|ico)(?:[?#][^\s]*)?|https?:\/\/[^\s]*(?:image|img|photo|picture|screenshot|upload)[^\s]*\.(?:png|jpg|jpeg|gif|webp)/gi;

async function autoVisionAnalysis(msgId, userMessage, sessionKey) {
  const imageUrls = userMessage.match(IMAGE_URL_PATTERN);
  if (!imageUrls || imageUrls.length === 0) return '';
  
  const uniqueUrls = [...new Set(imageUrls)].slice(0, 3);
  logger.info(`[${ts()}] [R35-T1] Detected ${uniqueUrls.length} image URL(s) in message`);
  
  const results = [];
  for (const url of uniqueUrls) {
    try {
      const result = await analyzeImage({ image_url: url, question: 'Describe this image in detail. What objects, text, colors, and layout do you see?' });
      if (result.success && result.analysis) {
        results.push({ url, description: result.analysis, model: result.model });
        logger.info(`[${ts()}] [R35-T1] Vision analysis success: url=${url.substring(0, 60)} model=${result.model} chars=${result.analysis.length}`);
      }
    } catch (err) {
      logger.info(`[${ts()}] [R35-T1] Vision analysis failed for ${url.substring(0, 60)}: ${err.message}`);
    }
  }
  
  if (results.length === 0) return '';
  
  try {
    emitEvent(sessionKey || "unknown", msgId, "vision_analysis", {
      imageCount: results.length,
      urls: results.map(r => r.url),
      models: results.map(r => r.model),
      totalChars: results.reduce((sum, r) => sum + r.description.length, 0)
    });
  } catch (_err) { logger.error("[knowledge-injector] silent catch (vision emit):", _err?.message || _err); }
  
  const analysisText = results.map((r, i) => 
    `Image ${i + 1}: ${r.url}\nAnalysis: ${r.description}`
  ).join('\n\n');
  
  return `<vision_analysis>\n[VISION] The following images were detected in the user message and automatically analyzed:\n${analysisText}\n[/VISION]\n</vision_analysis>\n`;
}

// [R36-T2] Browser: auto-detect URLs in user message and prefetch page content
const WEB_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
async function autoBrowserPrefetch(msgId, userMessage, sessionKey) {
  // Skip if message contains image URLs (handled by vision)
  const imageExts = /\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|#|$)/i;
  const allUrls = userMessage.match(WEB_URL_PATTERN);
  if (!allUrls || allUrls.length === 0) return '';
  
  // Filter out image URLs (already handled by vision) and common non-page URLs
  const pageUrls = [...new Set(allUrls)]
    .filter(u => !imageExts.test(u))
    .filter(u => !u.match(/\.(mp3|mp4|wav|pdf|zip|tar|gz|rar)$/i))
    .slice(0, 2); // Max 2 URLs to avoid timeout
  
  if (pageUrls.length === 0) return '';
  
  logger.info(`[${ts()}] [R36-T2] Detected ${pageUrls.length} web URL(s) for browser prefetch`);
  
  const results = [];
  for (const url of pageUrls) {
    logger.info(`[${ts()}] [R102] Browser prefetch skipped: Gateway native browser tool will handle url=${url.substring(0, 60)}`);
  }
  
  if (results.length === 0) return '';
  
  // Emit browser_action event
  try {
    emitEvent(sessionKey || "unknown", msgId, "browser_action", {
      action: "prefetch",
      urlCount: results.length,
      urls: results.map(r => r.url),
      titles: results.map(r => r.title),
      totalChars: results.reduce((sum, r) => sum + r.text.length, 0),
      source: "auto_prefetch"
    });
  } catch (_err) { logger.error("[knowledge-injector] silent catch (prefetch emit):", _err?.message || _err); }
  
  const prefetchText = results.map((r, i) => 
    `Page ${i + 1}: ${r.url}\nTitle: ${r.title}\nContent:\n${r.text}`
  ).join('\n\n---\n\n');
  
  return `<browser_prefetch>\n[BROWSER_PREFETCH] The following web pages were detected in the user message and automatically fetched via browser:\n${prefetchText}\n[/BROWSER_PREFETCH]\n</browser_prefetch>\n`;
}


// [R36-T3] TTS auto-routing: detect speech/voice keywords and auto-generate TTS
const TTS_KEYWORDS = /(?:朗读|念出|读出|播报|语音播报|大声读|读给我听|帮我读|用语音|speak|read aloud|read out|text.to.speech|say this|voice output)/i;

async function autoTTSRoute(msgId, userMessage, sessionKey) {
  if (!TTS_KEYWORDS.test(userMessage)) return '';
  
  // Extract the text to speak: remove the keyword trigger part, use the rest
  const cleanText = userMessage
    .replace(TTS_KEYWORDS, '')
    .replace(/[：:]/g, '')
    .trim();
  
  if (cleanText.length < 5 || cleanText.length > 4000) return '';
  
  logger.info(`[${ts()}] [R36-T3] TTS keyword detected, auto-generating speech for ${cleanText.length} chars`);
  
  try {
    const { handleSpeakText } = await import('./tts-generator.mjs');
    const result = await handleSpeakText({ text: cleanText, voice: 'alloy' });
    
    if (result.phase === 'done' && result.url) {
      // Emit tts_generated event
      emitEvent(sessionKey || 'unknown', msgId, 'tts_generated', {
        source: 'auto_route',
        textLength: cleanText.length,
        url: result.url,
        voice: 'alloy'
      });
      
      logger.info(`[${ts()}] [R36-T3] Auto-TTS success: url=${result.url}`);
      return `<auto_tts>\n[TTS] Voice output was automatically generated for the user\'s request:\nAudio URL: ${result.url}\nPlease include this audio link in your response and let the user know they can listen to it.\n[/TTS]\n</auto_tts>\n`;
    }
  } catch (err) {
    logger.info(`[${ts()}] [R36-T3] Auto-TTS error: ${err.message}`);
  }
  return '';
}

export async function buildKnowledgeInjectedMessage(msgId, userMessage, userId, sessionKey = null) {
  const { segments, question: baseQuestion } = segmentLongMessage(userMessage);

  // P3: 查询用户持久记忆
  let memoryBlock = '';
  try {
    const memoryText = await getUserMemory(userId);
    if (memoryText) {
      memoryBlock = `<user_memory>
以下是关于当前用户的持久记忆，请在回答时参考这些信息以提供个性化服务：
${memoryText}
</user_memory>

`;
      logger.info(`[${ts()}] [memory] Injected ${memoryText.length} chars of user memory for ${userId}`);
    }
  } catch (memErr) {
    logger.info(`[${ts()}] [memory] Memory injection failed: ${memErr.message}`);
  }


  // [R35-T1] Auto-detect and analyze images in user message
  let visionBlock = '';
  try {
    visionBlock = await autoVisionAnalysis(msgId, userMessage, sessionKey);
  } catch (vErr) {
    logger.info(`[${ts()}] [R35-T1] Vision auto-analysis error: ${vErr.message}`);
  }
  // [R36-T2] Browser prefetch for URLs in message
  let browserBlock = '';
  try {
    browserBlock = await autoBrowserPrefetch(msgId, userMessage, sessionKey);
  } catch (bErr) {
    logger.info(`[${ts()}] [R36-T2] Browser prefetch error (non-fatal): ${bErr.message}`);
  }
  // [R36-T3] Auto-TTS routing
  let ttsBlock = '';
  // [R37-T1] Code execution capability hint
  let codeExecBlock = '';
  const codeKeywords = /(?:\u8fd0\u884c|\u6267\u884c|\u8dd1\u4e00\u4e0b|\u4ee3\u7801|\u811a\u672c|\u8ba1\u7b97|\u7f16\u7a0b|python|node|bash|script|run|execute|compute|calculate|pip install|npm install)/i;
  if (codeKeywords.test(userMessage)) {
    codeExecBlock = '\n[CODE_EXECUTION_CAPABILITY]\n' +
      '\u4f60\u5177\u5907\u4ee3\u7801\u6267\u884c\u80fd\u529b\u3002\u53ef\u4ee5\u4f7f\u7528 exec \u5de5\u5177\u5728\u9694\u79bb\u7684 Docker \u6c99\u7bb1\u4e2d\u8fd0\u884c\u4ee3\u7801\u3002\n' +
      '\u652f\u6301\u8bed\u8a00\uff1aPython 3.11\u3001Node.js 22\u3001Bash\n' +
      '\u4f7f\u7528\u65b9\u5f0f\uff1a\u8c03\u7528 exec \u5de5\u5177\uff0c\u4f20\u5165\u8981\u6267\u884c\u7684\u547d\u4ee4\n' +
      '\u9650\u5236\uff1a30\u79d2\u8d85\u65f6\u300164MB\u5185\u5b58\u3001\u8f93\u51fa\u4e0a\u96508KB\n' +
      '\u5f53\u7528\u6237\u8981\u6c42\u8fd0\u884c\u4ee3\u7801\u3001\u8ba1\u7b97\u3001\u5b89\u88c5\u4f9d\u8d56\u6216\u751f\u6210\u6587\u4ef6\u65f6\uff0c\u8bf7\u4e3b\u52a8\u4f7f\u7528 exec \u5de5\u5177\u3002\n' +
      '[/CODE_EXECUTION_CAPABILITY]\n';
    logger.info('[' + ts() + '] [R37-T1] Code execution hint injected for message: "' + userMessage.substring(0, 60) + '"');
  }

  try {
    ttsBlock = await autoTTSRoute(msgId, userMessage, sessionKey);
  } catch (tErr) {
    logger.info(`[${ts()}] [R36-T3] Auto-TTS error (non-fatal): ${tErr.message}`);
  }

  // [R27-T2] planText injection REMOVED from here — plan doesn't exist yet at this point.
  // Plan is generated AFTER knowledge injection (in openclaw-handler.mjs line ~451).
  // planText is now injected in openclaw-handler's agentic loop (after plan exists).
  const planTextBlock = ''; // [R27-T2] placeholder, actual injection in openclaw-handler

  // [R42-T5] Classify intent for scope-filtered knowledge injection
  const _r42Scopes = classifyIntent(userMessage);
  const _r42TaskType = _r42Scopes.filter(s => s !== 'general')[0] || 'general';
  // [R24-T3] Fetch knowledge_base block (system-level knowledge entries)
  let kbBlock = '';
  try {
    kbBlock = await getKnowledgeBaseBlock(_r42Scopes);
    if (kbBlock) {
      logger.info(`[${ts()}] [R24-T3] Knowledge base injected: ${kbBlock.length} chars`);
      logger.info(`[${ts()}] [R30-T2] knowledge injected: source=knowledge_entries chars=${kbBlock.length}`);
      // Emit knowledge_injected event via IPC for event_stream tracking
      try {
        emitEvent(sessionKey || "unknown", msgId, "knowledge_injected", { charCount: kbBlock.length, source: "knowledge_entries", scope: _r42Scopes.join(','), matchedTaskType: _r42TaskType, weightThreshold: 0.5 });
      } catch (_) { /* non-fatal */ }
    }
  } catch (_) { /* non-fatal */ }

  if (segments.length === 0) {
    if (baseQuestion.length !== userMessage.length) {
      logger.info(`[${ts()}] [knowledge] Message adjusted: ${userMessage.length} → ${baseQuestion.length} chars`);
    }
    // 主动检索知识库（v26.0：scope 过滤 + priority 排序 + token 预算）
    const { text: activeKB, hits, scopes } = await activeKnowledgeSearch(baseQuestion, userId);
    if (activeKB) {
      const scopeInfo = scopes.length > 1 ? ` [scope: ${scopes.join(',')}]` : '';
      logger.info(`[${ts()}] [R30-T2] knowledge injected: source=active_search hits=${hits.length} scopes=${scopes.join(',')}`);
      // [R57-T2] 增加 top_score / query_used 字段，便于诊断覆盖率不足的根因
      try {
        const topScore = hits.length > 0 ? (hits[0].score || 0) : 0;
        emitEvent(sessionKey || "unknown", msgId, "knowledge_injected", {
          charCount: activeKB.length, source: "active_search", scope: scopes.join(','),
          hitsCount: hits.length, topScore, queryUsed: baseQuestion.slice(0, 100),
          coverageSkipReason: null,
        });
      } catch (_) { /* non-fatal */ }
      sendStep(msgId, "📚 知识库检索", "success", `命中 ${hits.length} 篇文档${scopeInfo}：${hits.map(h => h.title).join('、')}`);
      // R53 KV-Cache fix: Separate fixed instruction prefix from dynamic KB content
      return `${planTextBlock}${visionBlock}${browserBlock}${codeExecBlock}${ttsBlock}${kbBlock}\n${memoryBlock}<knowledge_reference>
[INSTRUCTION] 以下是从知识库中检索到的相关参考资料，请优先基于这些资料回答用户问题。如果资料不足以回答，请明确说明。
[/INSTRUCTION]
[DOCUMENTS]
${activeKB}
[/DOCUMENTS]
</knowledge_reference>

${baseQuestion}`;
    }
    // [R57-T2] 记录知识注入缺失原因，用于覆盖率诊断
    try {
      emitEvent(sessionKey || "unknown", msgId, "knowledge_injected", {
        charCount: 0, source: "none", scope: "general",
        hitsCount: 0, topScore: 0, queryUsed: baseQuestion.slice(0, 100),
        coverageSkipReason: "no_match",
      });
    } catch (_) { /* non-fatal */ }
    return `${planTextBlock}${visionBlock}${browserBlock}${codeExecBlock}${ttsBlock}${kbBlock}\n${memoryBlock}${baseQuestion}`;
  }

  logger.info(`[${ts()}] [knowledge] Detected ${segments.length} segments + question (${baseQuestion.length} chars)`);

  // 合并知识段，限制总长度
  let mergedKnowledge = segments.join('\n\n---\n\n');
  if (mergedKnowledge.length > MAX_KNOWLEDGE_CHARS) {
    mergedKnowledge = mergedKnowledge.substring(0, MAX_KNOWLEDGE_CHARS) + '\n... (部分内容已省略)';
  }

  // R53 KV-Cache fix: Structured knowledge block with fixed instruction prefix
  // [R24-T3] Prepend knowledge_base block to segments path too
  let gatewayMessage = [
    planTextBlock + kbBlock,
    memoryBlock + '<knowledge_reference>',
    '[INSTRUCTION] 以下是从知识库中检索到的相关参考资料，请优先基于这些资料回答用户问题。如果资料不足以回答，请明确说明。',
    '[/INSTRUCTION]',
    '[DOCUMENTS]',
    mergedKnowledge,
    '[/DOCUMENTS]',
    '</knowledge_reference>',
    '',
    baseQuestion
  ].join('\n');

  // 安全截断：优先保护用户问题
  if (gatewayMessage.length > GATEWAY_SAFE_LENGTH) {
    const questionPart = gatewayMessage.split('</knowledge_reference>').pop().trim();
    const availableForKnowledge = GATEWAY_SAFE_LENGTH - questionPart.length - memoryBlock.length - 200;
    if (availableForKnowledge > 500) {
      const trimmedKnowledge = mergedKnowledge.substring(0, availableForKnowledge) + '\n... (已截断)';
      gatewayMessage = `${memoryBlock}<knowledge_reference>\n${trimmedKnowledge}\n</knowledge_reference>\n\n${questionPart}`;
    } else {
      gatewayMessage = `${memoryBlock}${questionPart}`;
    }
    logger.info(`[${ts()}] [knowledge] Safety truncated to ${gatewayMessage.length} chars`);
  }

  logger.info(`[${ts()}] [knowledge] Inline injection: ${mergedKnowledge.length} chars knowledge + ${baseQuestion.length} chars question = ${gatewayMessage.length} total`);

  const kbStepId = sendStep(msgId, "📚 知识库检索", "running", `正在注入 ${segments.length} 段参考资料...`);
  updateStep(msgId, kbStepId, "success", `已加载 ${segments.length} 段参考资料 (${mergedKnowledge.length} 字符)`);

  try {
    const dsContext = await fetchDatasourceContext(userMessage);
    if (dsContext) {
      gatewayMessage += dsContext;
      logger.info(`[${ts()}] [knowledge] [v28.0] Datasource context injected: ${dsContext.length} chars`);
    }
  } catch (dsErr) {
    logger.warn(`[${ts()}] [knowledge] [v28.0] Datasource fetch failed (silent): ${dsErr.message}`);
  }
  // [R34-T2] Datasource Registry — 内部 API 文档库注入
  try {
    const dsRegistry = await matchAndFetch(userMessage);
    if (dsRegistry && dsRegistry.block) {
      gatewayMessage += dsRegistry.block;
      logger.info(`[${ts()}] [knowledge] [R34-T2] Datasource registry injected: ${dsRegistry.matchedIds.join(",")} (${dsRegistry.block.length} chars)`);
      emitEvent(sessionKey || "unknown", msgId, "datasource_injected", {
        matchedIds: dsRegistry.matchedIds,
        entryCount: dsRegistry.matchedIds.length,
        blockLength: dsRegistry.block.length,
        docSnippetCount: dsRegistry.docSnippets.length,
      });
    }
  } catch (dsRegErr) {
    logger.warn(`[${ts()}] [knowledge] [R34-T2] Datasource registry failed (silent): ${dsRegErr.message}`);
  }

  return gatewayMessage;
}
