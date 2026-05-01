/**
 * R59: Wide Research — Parallel search for research-type tasks
 * 
 * Trigger: routing.taskType === 'research' AND message contains research keywords
 * Mechanism: Parallel 3 DuckDuckGo HTML searches with different sub-query angles,
 *            Promise.allSettled with 5s timeout, results injected as [RESEARCH_CONTEXT] block.
 * 
 * Silent failure — never blocks the main flow.
 */

import https from 'https';
import http from 'http';

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

// ─── Configuration ───
const SEARCH_TIMEOUT_MS = 5000;
const MAX_RESULTS_PER_QUERY = 3; // Iter-AM: 5路×3条=15条，与之前3路×5条总量相同
const MAX_CONTEXT_CHARS = 2000;

// ─── Trigger keywords (Chinese + English) ───
const RESEARCH_TRIGGERS = /调研|研究|分析|对比|市场|行业|趋势|竞品|调查|综述|概述|报告|数据|统计|research|investigate|analyze|compare|survey|overview/i;

/**
 * Check if Wide Research should be triggered
 * @param {string} userMessage - The user's message
 * @param {object} routing - Routing decision from smart-router
 * @returns {boolean}
 */
export function shouldTriggerWideResearch(userMessage, routing) {
  if (!userMessage || userMessage.length < 10) return false;
  // Now triggers on keyword match alone, regardless of routing classification
  // This allows research-like queries classified as 'general' to also benefit
  const taskType = routing?.taskType || '';
  const hasKeyword = RESEARCH_TRIGGERS.test(userMessage);
  // Direct trigger if research type OR keyword match
  if (taskType === 'research') return true;
  if (hasKeyword) return true;
  // Also trigger for long messages (>100 chars) with question patterns
  if (userMessage.length > 100 && /什么|怎么|如何|为什么|哪些|哪个|对比|区别|优势|劣势|推荐|建议|选择/.test(userMessage)) return true;
  return false;
}

/**
 * Generate 3 sub-queries from different angles for the user's research request
 * @param {string} userMessage - The user's message
 * @returns {string[]} Array of 3 search queries
 */
/**
 * Iter-AD (v25.24): 将中文核心词映射为英文关键词（Manus 规则：非英语查询必含英语变体）
 */
function extractCoreWords(chineseTopic) {
  const MAP = [
    [/游戏|电竞/g, 'game'],
    [/充值|代充|recharge/gi, 'top-up recharge'],
    [/直播|主播/g, 'live streaming'],
    [/电商|购物/g, 'e-commerce'],
    [/人工智能|AI/gi, 'AI artificial intelligence'],
    [/市场|行业/g, 'market industry'],
    [/客服|服务/g, 'customer service'],
    [/手机|移动/g, 'mobile'],
    [/平台|系统/g, 'platform'],
    [/用户|玩家/g, 'user player'],
    [/收入|营收|利润/g, 'revenue profit'],
    [/账号|账户/g, 'account'],
    [/支付|付款/g, 'payment'],
    [/云|服务器/g, 'cloud server'],
    [/视频|内容/g, 'video content'],
  ];
  let result = chineseTopic;
  for (const [pattern, replacement] of MAP) {
    result = result.replace(pattern, ' ' + replacement + ' ');
  }
  // 清理残余中文（不影响英文词汇）
  result = result.replace(/[\u4e00-\u9fa5]+/g, '').trim();
  return result || chineseTopic.slice(0, 20); // fallback 原文前20字
}

function generateSubQueries(userMessage) {
  // Extract the core topic (first 60 chars, clean up)
  const topic = userMessage.slice(0, 60).replace(/[帮我请你能不能可以吗麻烦]/g, '').trim();
  const cleanTopic = topic.replace(/(调研|研究|分析|对比|调查)/, '').trim();

  // 1. Direct topic search（中文原文）
  const q1 = topic;

  // 2. Market/industry angle（中文）
  const q2 = cleanTopic + ' 市场规模 趋势 2025';

  // 3. 英文变体（Iter-AD: Manus 规则 — 非英语查询必含英语变体）
  const coreEn = extractCoreWords(cleanTopic);
  const q3 = coreEn + ' market analysis overview 2025';

  // 4. 英文对比/评测角度（Iter-AM: Phase 14 扩容 — 5路并行）
  const q4 = coreEn + ' comparison review pros cons 2026';

  // 5. 中文时效词（Iter-AM: 捕捉最新动态）
  const q5 = cleanTopic + ' 2026 最新 进展';

  return [q1, q2, q3, q4, q5].filter(q => q.length > 2);
}

/**
 * Search DuckDuckGo HTML and extract results
 * @param {string} query - Search query
 * @returns {Promise<{title: string, snippet: string, url: string}[]>}
 */
async function searchDDG(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('DDG search timeout'));
    }, SEARCH_TIMEOUT_MS);
    
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const results = parseDDGResults(data);
          resolve(results.slice(0, MAX_RESULTS_PER_QUERY));
        } catch (e) {
          resolve([]);
        }
      });
    });
    
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Parse DuckDuckGo HTML results
 * @param {string} html - Raw HTML from DuckDuckGo
 * @returns {{title: string, snippet: string, url: string}[]}
 */
async function searchBing(query) {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${encodedQuery}&setlang=zh-Hans`;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('Bing search timeout'));
    }, SEARCH_TIMEOUT_MS);
    
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const results = parseBingResults(data);
          resolve(results.slice(0, MAX_RESULTS_PER_QUERY));
        } catch (e) {
          resolve([]);
        }
      });
    });
    
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseBingResults(html) {
  const results = [];
  // Bing result blocks: <li class="b_algo"><h2><a href="...">title</a></h2><p>snippet</p></li>
  const resultRegex = /<li[^>]*class="b_algo"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  
  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < MAX_RESULTS_PER_QUERY) {
    const url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    
    if (title && snippet && url.startsWith('http')) {
      results.push({ title, snippet, url });
    }
  }
  
  return results;
}

let _ddgFailCount = 0;
const DDG_COOLDOWN_THRESHOLD = 3; // After 3 consecutive DDG failures, switch to Bing
const DDG_COOLDOWN_RESET_MS = 10 * 60 * 1000; // Reset after 10 minutes
let _ddgCooldownStart = 0;

async function searchWithFallback(query) {
  // Check if DDG is in cooldown
  const inCooldown = _ddgFailCount >= DDG_COOLDOWN_THRESHOLD && 
    (Date.now() - _ddgCooldownStart < DDG_COOLDOWN_RESET_MS);
  
  if (inCooldown) {
    // Use Bing during DDG cooldown
    try {
      const results = await searchBing(query);
      if (results.length > 0) return { results, engine: 'bing' };
    } catch (e) {
      logger.warn(`[${ts()}] [WideResearch] Bing fallback also failed: ${e.message}`);
    }
    return { results: [], engine: 'none' };
  }
  
  // Try DDG first
  try {
    const results = await searchDDG(query);
    if (results.length > 0) {
      _ddgFailCount = 0; // Reset on success
      return { results, engine: 'ddg' };
    }
    // DDG returned empty — count as soft failure
    _ddgFailCount++;
    if (_ddgFailCount >= DDG_COOLDOWN_THRESHOLD) {
      _ddgCooldownStart = Date.now();
      logger.info(`[${ts()}] [WideResearch] DDG cooldown activated after ${_ddgFailCount} failures, switching to Bing for ${DDG_COOLDOWN_RESET_MS/1000}s`);
    }
  } catch (err) {
    _ddgFailCount++;
    if (_ddgFailCount >= DDG_COOLDOWN_THRESHOLD) {
      _ddgCooldownStart = Date.now();
      logger.info(`[${ts()}] [WideResearch] DDG cooldown activated after ${_ddgFailCount} failures, switching to Bing for ${DDG_COOLDOWN_RESET_MS/1000}s`);
    }
    logger.warn(`[${ts()}] [WideResearch] DDG failed: ${err.message}, trying Bing`);
  }
  
  // Fallback to Bing
  try {
    const results = await searchBing(query);
    if (results.length > 0) return { results, engine: 'bing' };
  } catch (e) {
    logger.warn(`[${ts()}] [WideResearch] Bing fallback also failed: ${e.message}`);
  }
  
  return { results: [], engine: 'none' };
}

function parseDDGResults(html) {
  const results = [];
  
  // Match result blocks: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  
  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < MAX_RESULTS_PER_QUERY) {
    const url = match[1].replace(/.*uddg=([^&]+).*/, (_, u) => decodeURIComponent(u));
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    
    if (title && snippet) {
      results.push({ title, snippet, url });
    }
  }
  
  return results;
}

/**
 * Execute Wide Research: parallel search from 3 angles
 * @param {string} userMessage - The user's message
 * @param {string} sessionKey - Session key for logging
 * @returns {Promise<string|null>} [RESEARCH_CONTEXT] block or null
 */
export async function executeWideResearch(userMessage, sessionKey) {
  const subQueries = generateSubQueries(userMessage);
  if (subQueries.length === 0) return { contextBlock: null, sourceCount: 0, engines: "none", successCount: 0, subQueryCount: 0 };
  
  logger.info(`[${ts()}] [WideResearch] Starting parallel search for session ${sessionKey}: ${subQueries.length} queries`);
  
  // Parallel search with timeout
  const searchPromises = subQueries.map((query, idx) => {
    return searchWithFallback(query).then(({ results, engine }) => {
      logger.info(`[${ts()}] [WideResearch] Query ${idx + 1}/${subQueries.length} completed: "${query.slice(0, 30)}" → ${results.length} results (engine=${engine})`);
      return { query, results, status: 'ok', engine };
    }).catch(err => {
      logger.warn(`[${ts()}] [WideResearch] Query ${idx + 1} failed: ${err.message}`);
      return { query, results: [], status: 'error', error: err.message };
    });
  });
  
  // Wait for all with 5s global timeout
  const globalTimeout = new Promise(resolve => {
    setTimeout(() => resolve('timeout'), SEARCH_TIMEOUT_MS + 1000);
  });
  
  const settled = await Promise.race([
    Promise.allSettled(searchPromises).then(r => r.map(s => s.status === 'fulfilled' ? s.value : { query: '', results: [], status: 'error' })),
    globalTimeout
  ]);
  
  if (settled === 'timeout') {
    logger.warn(`[${ts()}] [WideResearch] Global timeout reached`);
    return { contextBlock: null, sourceCount: 0, engines: "timeout", successCount: 0, subQueryCount: subQueries.length };
  }
  
  // Build context block (Iter-AM: URL 去重，避免同一来源重复出现)
  const seenUrls = new Set();
  const allResults = [];
  let totalChars = 0;
  
  for (const searchResult of settled) {
    if (!searchResult.results || searchResult.results.length === 0) continue;
    for (const r of searchResult.results) {
      if (r.url && seenUrls.has(r.url)) continue; // 去重
      if (r.url) seenUrls.add(r.url);
      const refIndex = allResults.length + 1;
      const entry = `[${refIndex}] ${r.title}: ${r.snippet} 来源：${r.url || ''}`;
      if (totalChars + entry.length > MAX_CONTEXT_CHARS) break;
      allResults.push(entry);
      totalChars += entry.length;
    }
  }
  
  if (allResults.length === 0) {
    logger.info(`[${ts()}] [WideResearch] No results found`);
    return { contextBlock: null, sourceCount: 0, engines: "none", successCount: 0, subQueryCount: subQueries.length };
  }
  
  const successCount = settled.filter(s => s.status === 'ok' && s.results.length > 0).length;
  const engines = [...new Set(settled.filter(s => s.engine).map(s => s.engine))].join('+');
  // [R41-T6] Build numbered reference list
    const refList = allResults.map((entry, idx) => {
      const urlMatch = entry.match(/来源：(\S+)/);
      const titleMatch = entry.match(/^\[\d+\] ([^:]+)/);
      return urlMatch ? `[${idx + 1}] ${titleMatch ? titleMatch[1].trim() : 'Source'} - ${urlMatch[1]}` : null;
    }).filter(Boolean).join('\n');
    
    const contextBlock = `\n\n[RESEARCH_CONTEXT]\n以下是从多个角度搜索到的背景信息（${successCount}/${subQueries.length} 个搜索成功，共 ${allResults.length} 条结果，引擎=${engines || 'none'}）：\n${allResults.join('\n')}\n\n参考来源：\n${refList}\n[/RESEARCH_CONTEXT]`;
  
  logger.info(`[${ts()}] [WideResearch] Context block generated: ${allResults.length} results, ${contextBlock.length} chars`);
  
  return { contextBlock, sourceCount: allResults.length, engines: engines || "none", successCount, subQueryCount: subQueries.length };
}
