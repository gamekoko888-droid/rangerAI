/**
 * soul-loader.mjs — Iter-E: Dynamic SOUL.md Layer Loading
 * 
 * Loads the slim main SOUL.md for all intents, then appends
 * intent-specific sub-files from soul/ directory.
 * 
 * Intent → Sub-file mapping:
 *   general     → (main SOUL.md only)
 *   business    → + soul/business.md
 *   coding/task → + soul/coding.md
 *   ops         → + soul/ops.md
 *   complex     → + soul/coding.md + soul/ops.md
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

const BASE_DIR = '/opt/rangerai-agent';
const SOUL_DIR = join(BASE_DIR, 'soul');
const MAIN_SOUL = join(BASE_DIR, 'SOUL.md');

// ─── Intent → Sub-file Mapping ─────────────────────────────
const INTENT_LAYERS = {
  general:      [],                                    // Main SOUL.md only
  chat:         [],                                    // Main SOUL.md only
  business:     ['business.md'],                       // + business rules
  coding:       ['coding.md'],                         // + coding rules
  task:         ['coding.md'],                         // tasks usually involve code
  ops:          ['ops.md'],                             // + ops rules
  complex:      ['coding.md', 'ops.md'],               // complex = coding + ops
  continuation: [],                                    // continue previous context
};

// ─── Keyword-based Intent Detection ─────────────────────────
// Supplements intent-classifier.mjs for soul-layer selection
const INTENT_KEYWORDS = {
  business: [
    '工单', '客服', 'KOL', '充值', '代充', '知识库', '工作流',
    '钉钉', '日报', '调研', '研究', '竞品', '市场', '价格',
    'ticket', 'kol', 'recharge', 'workflow',
  ],
  coding: [
    '代码', '修改', '修复', 'bug', 'fix', '重构', 'refactor',
    '部署', 'deploy', '前端', '后端', '.mjs', '.js', '.ts',
    'node', 'docker', 'git', 'schema', '数据库', 'sql',
    '迷宫', 'canvas', 'BFS', '算法', '考试', '解题',
  ],
  ops: [
    '诊断', '排查', '运维', '服务器', '重启', 'restart',
    '日志', 'log', '监控', '性能', '内存', 'CPU',
    '上下文', 'token', '压缩', '子Agent', 'sessions',
    '安全', '权限', '密钥',
  ],
};

/**
 * Detect intent from message content for soul-layer selection.
 * This is a lightweight supplement to intent-classifier.mjs.
 * 
 * @param {string} message - User message
 * @returns {string} - Detected intent: general|business|coding|ops
 */
function detectSoulIntent(message) {
  if (!message || typeof message !== 'string') return 'general';
  
  const lower = message.toLowerCase();
  const scores = { business: 0, coding: 0, ops: 0 };
  
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) {
        scores[intent]++;
      }
    }
  }
  
  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return 'general';
  
  const topIntent = Object.entries(scores).find(([, s]) => s === maxScore)?.[0] || 'general';
  return topIntent;
}

/**
 * Load SOUL.md content with intent-based layering.
 * 
 * @param {string} intent - Intent from intent-classifier or detectSoulIntent
 * @param {string} [userMessage] - Optional user message for fallback detection
 * @returns {{ content: string, layers: string[], totalChars: number }}
 */
export function loadSoul(intent, userMessage) {
  const startTime = Date.now();
  
  // Resolve intent
  let resolvedIntent = intent || 'general';
  
  // If intent is generic (chat/task/unknown), try keyword detection
  if (['chat', 'task', 'unknown', 'continuation'].includes(resolvedIntent) && userMessage) {
    const detected = detectSoulIntent(userMessage);
    if (detected !== 'general') {
      resolvedIntent = detected;
      logger.info(`[${ts()}] [soul-loader] Keyword override: ${intent} → ${resolvedIntent}`);
    }
  }
  
  // Map task → coding for layer loading
  const layerKey = INTENT_LAYERS[resolvedIntent] ? resolvedIntent : 'general';
  const subFiles = INTENT_LAYERS[layerKey] || [];
  
  // Load main SOUL.md
  let content = '';
  const layers = ['SOUL.md'];
  
  try {
    content = readFileSync(MAIN_SOUL, 'utf-8');
  } catch (err) {
    logger.error(`[${ts()}] [soul-loader] Failed to read main SOUL.md: ${err.message}`);
    return { content: '', layers: [], totalChars: 0 };
  }
  
  // Append sub-files
  for (const subFile of subFiles) {
    const subPath = join(SOUL_DIR, subFile);
    if (existsSync(subPath)) {
      try {
        const subContent = readFileSync(subPath, 'utf-8');
        content += '\n\n---\n\n' + subContent;
        layers.push(`soul/${subFile}`);
      } catch (err) {
        logger.warn(`[${ts()}] [soul-loader] Failed to read ${subFile}: ${err.message}`);
      }
    } else {
      logger.warn(`[${ts()}] [soul-loader] Sub-file not found: ${subPath}`);
    }
  }
  
  const elapsed = Date.now() - startTime;
  logger.info(`[${ts()}] [soul-loader] intent=${resolvedIntent}, layers=[${layers.join(', ')}], chars=${content.length}, elapsed=${elapsed}ms`);
  
  return {
    content,
    layers,
    totalChars: content.length,
    intent: resolvedIntent,
  };
}

/**
 * Get available soul layers and their sizes.
 * @returns {Array<{ name: string, path: string, chars: number, exists: boolean }>}
 */
export function getSoulLayers() {
  const layers = [
    { name: 'SOUL.md (main)', path: MAIN_SOUL },
    { name: 'soul/business.md', path: join(SOUL_DIR, 'business.md') },
    { name: 'soul/coding.md', path: join(SOUL_DIR, 'coding.md') },
    { name: 'soul/ops.md', path: join(SOUL_DIR, 'ops.md') },
  ];
  
  return layers.map(l => {
    const exists = existsSync(l.path);
    let chars = 0;
    if (exists) {
      try { chars = readFileSync(l.path, 'utf-8').length; } catch {}
    }
    return { ...l, chars, exists };
  });
}

export { detectSoulIntent, INTENT_LAYERS, INTENT_KEYWORDS };
