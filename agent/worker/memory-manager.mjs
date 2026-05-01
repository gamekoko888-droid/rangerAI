/**
 * memory-manager.mjs — Unified Long-term Memory Manager
 * 
 * Phase 3 of Context Management Refactoring:
 * Implements the four-type memory architecture with decay:
 * 
 *   1. EPISODIC  — What happened (events, outcomes, timestamps)
 *   2. SEMANTIC  — Facts and domain knowledge
 *   3. PROCEDURAL — How to do things (tool patterns, workflows)
 *   4. PROFILE   — User preferences, identity, constraints
 * 
 * Provides unified retrieval across all memory types for context injection.
 * 
 * @module worker/memory-manager
 */
import { logger } from '../lib/logger.mjs';
import { emitEvent, EVENT_TYPES } from './event-stream.mjs';
import { recordCompression } from './observability.mjs'; // [R13-T5]
import { cosineSimilarity, hashEmbedding } from '../lib/rag-utils.mjs'; // [R60-T2] Vector-based semantic recall

const ts = () => new Date().toISOString();
let _memoryStatsTimer = null;

// ─── Configuration ───
const MEMORY_CONFIG = {
  // Episodic memory
  EPISODIC_MAX_ENTRIES: 200,
  EPISODIC_EXTRACT_MIN_LENGTH: 50,  // Min combined msg length to extract
  EPISODIC_DECAY_RATE: 0.02,        // Score decays 2% per day
  EPISODIC_MIN_SCORE: 0.1,          // Below this, eligible for cleanup
  
  // Score decay (applies to all adaptive_memory types)
  DECAY_INTERVAL_MS: 6 * 60 * 60 * 1000, // Run decay every 6 hours
  DECAY_RATE_PER_DAY: 0.015,              // 1.5% per day base decay
  HIT_BOOST: 0.1,                          // Each access boosts score by 0.1
  MAX_SCORE: 5.0,
  MIN_SCORE: 0.05,
  
  // Unified retrieval
  MAX_RECALL_PER_TYPE: 3,           // Max items per memory type in recall
  MAX_TOTAL_RECALL: 8,              // Max total items in recall
  RECALL_MAX_CHARS: 2000,           // Max chars for recall block
};

// ─── SQLite Access ───
let _db = null;
async function getDb() {
  if (_db) return _db;
  try {
    const { default: Database } = await import('better-sqlite3');
    _db = new Database('/opt/rangerai-agent/db/rangerai.db');
    // TD-019: WAL mode + busy_timeout for concurrent access safety
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    let _busyCount = 0;
    let _queryCount = 0;
    const _origPrepare = _db.prepare.bind(_db);
    _db.prepare = function(sql) {
      _queryCount++;
      return _origPrepare(sql);
    };
    // Periodic stats log (every 15 min)
    _memoryStatsTimer = setInterval(() => {
      logger.info(`[${ts()}] [memory-mgr] [SQLite-STATS] queries=${_queryCount} busy=${_busyCount}`);
      _queryCount = 0;
      _busyCount = 0;
    }, 15 * 60 * 1000);
    if (_memoryStatsTimer.unref) _memoryStatsTimer.unref();
    ensureTables(_db);
    return _db;
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] SQLite init failed: ${err.message}`);
    return null;
  }
}

function ensureTables(db) {
  // Episodic memory table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_episodic (
      id TEXT PRIMARY KEY,
      sessionKey TEXT NOT NULL,
      eventType TEXT NOT NULL,
      summary TEXT NOT NULL,
      participants TEXT,
      outcome TEXT,
      emotionalTone TEXT,
      score REAL DEFAULT 1.0,
      hitCount INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_me_session ON memory_episodic(sessionKey);
    CREATE INDEX IF NOT EXISTS idx_me_type ON memory_episodic(eventType);
    CREATE INDEX IF NOT EXISTS idx_me_score ON memory_episodic(score DESC);
  `);
}

// ─── Episodic Memory ───

/**
 * Record an episodic memory (what happened).
 * 
 * @param {string} sessionKey
 * @param {string} eventType - 'task_complete' | 'decision_made' | 'error_resolved' | 'knowledge_gained' | 'preference_expressed'
 * @param {string} summary - What happened
 * @param {object} metadata - { participants, outcome, emotionalTone }
 */
export async function recordEpisode(sessionKey, eventType, summary, metadata = {}) {
  const db = await getDb();
  if (!db) return;
  
  try {
    const id = `ep-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = ts();
    
    db.prepare(`
      INSERT INTO memory_episodic (id, sessionKey, eventType, summary, participants, outcome, emotionalTone, score, hitCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 0, ?, ?)
    `).run(
      id, sessionKey, eventType,
      summary.substring(0, 1000),
      metadata.participants || null,
      metadata.outcome || null,
      metadata.emotionalTone || null,
      now, now
    );
    
    // Enforce limit
    const count = db.prepare('SELECT COUNT(*) as cnt FROM memory_episodic').get();
    if (count.cnt > MEMORY_CONFIG.EPISODIC_MAX_ENTRIES) {
      const excess = count.cnt - MEMORY_CONFIG.EPISODIC_MAX_ENTRIES;
      db.prepare(`
        DELETE FROM memory_episodic WHERE id IN (
          SELECT id FROM memory_episodic ORDER BY score ASC, updatedAt ASC LIMIT ?
        )
      `).run(excess);
    }
    
    logger.info(`[${ts()}] [memory-mgr] Episodic recorded: ${eventType} (${summary.substring(0, 60)}...)`);
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] recordEpisode failed: ${err.message}`);
  }
}

/**
 * Auto-extract episodic memory from a completed conversation turn.
 * Called after assistant response is generated.
 */
export async function extractEpisodicMemory(sessionKey, userMessage, assistantReply, context = {}) {
  if (!userMessage || !assistantReply) return;
  if (userMessage.length + assistantReply.length < MEMORY_CONFIG.EPISODIC_EXTRACT_MIN_LENGTH) return;
  
  // Determine event type based on content patterns
  const combined = (userMessage + ' ' + assistantReply).toLowerCase();
  
  let eventType = 'general_interaction';
  let summary = '';
  
  // Task completion
  if (/完成|done|finished|成功|搞定|已经/.test(combined) && context.hasToolOutput) {
    eventType = 'task_complete';
    summary = `用户请求: ${userMessage.substring(0, 200)}. 结果: ${assistantReply.substring(0, 300)}`;
  }
  // Decision made
  else if (/决定|选择|采用|确定|let's go with|decided|choose/.test(combined)) {
    eventType = 'decision_made';
    summary = `决策: ${userMessage.substring(0, 150)}. 结论: ${assistantReply.substring(0, 300)}`;
  }
  // Error resolved
  else if (/错误|error|bug|fix|修复|解决|问题/.test(combined) && /解决|fixed|resolved|修好/.test(combined)) {
    eventType = 'error_resolved';
    summary = `问题: ${userMessage.substring(0, 200)}. 解决方案: ${assistantReply.substring(0, 300)}`;
  }
  // Knowledge gained
  else if (/学到|了解|原来|知道了|learned|understood|i see/.test(combined)) {
    eventType = 'knowledge_gained';
    summary = `话题: ${userMessage.substring(0, 200)}. 要点: ${assistantReply.substring(0, 300)}`;
  }
  // Only record meaningful interactions (skip short chit-chat)
  else if (userMessage.length > 30 && assistantReply.length > 100) {
    eventType = 'general_interaction';
    summary = `用户: ${userMessage.substring(0, 150)}. 回复摘要: ${assistantReply.substring(0, 200)}`;
  } else {
    return; // Skip trivial interactions
  }
  
  await recordEpisode(sessionKey, eventType, summary, {
    outcome: context.success !== false ? 'success' : 'partial',
    emotionalTone: context.emotionalTone || 'neutral',
  });
}

// ─── Score Decay Mechanism ───

let _lastDecayRun = 0;

/**
 * Apply time-based score decay to all memory types.
 * Should be called periodically (e.g., on each message processing).
 */
export async function applyScoreDecay() {
  const now = Date.now();
  if (now - _lastDecayRun < MEMORY_CONFIG.DECAY_INTERVAL_MS) return;
  _lastDecayRun = now;
  
  const db = await getDb();
  if (!db) return;
  
  try {
    const decayRate = MEMORY_CONFIG.DECAY_RATE_PER_DAY;
    const minScore = MEMORY_CONFIG.MIN_SCORE;
    
    // Decay adaptive_memory scores
    const amResult = db.prepare(`
      UPDATE adaptive_memory 
      SET score = MAX(?, score * (1.0 - ? * (julianday('now') - julianday(updatedAt)))),
          updatedAt = datetime('now')
      WHERE score > ?
    `).run(minScore, decayRate, minScore);
    
    // Decay episodic memory scores
    const epResult = db.prepare(`
      UPDATE memory_episodic 
      SET score = MAX(?, score * (1.0 - ? * (julianday('now') - julianday(updatedAt)))),
          updatedAt = datetime('now')
      WHERE score > ?
    `).run(minScore, decayRate, minScore);
    
    // Cleanup very low score entries
    const amCleaned = db.prepare(`DELETE FROM adaptive_memory WHERE score < ?`).run(minScore);
    const epCleaned = db.prepare(`DELETE FROM memory_episodic WHERE score < ?`).run(minScore);
    
    const totalDecayed = (amResult.changes || 0) + (epResult.changes || 0);
    const totalCleaned = (amCleaned.changes || 0) + (epCleaned.changes || 0);
    
    if (totalDecayed > 0 || totalCleaned > 0) {
      logger.info(`[${ts()}] [memory-mgr] Score decay: ${totalDecayed} decayed, ${totalCleaned} cleaned`);
      // [R13-T5] Record memory decay audit to DB
      recordCompression('memory_decay', 0, {
        extraJson: {
          adaptiveDecayed: amResult.changes || 0,
          episodicDecayed: epResult.changes || 0,
          adaptiveCleaned: amCleaned.changes || 0,
          episodicCleaned: epCleaned.changes || 0,
          totalDecayed,
          totalCleaned,
          decayRate: MEMORY_CONFIG.DECAY_RATE_PER_DAY,
          minScore: MEMORY_CONFIG.MIN_SCORE,
        },
      });
      logger.info(`[R13-T5] memory_decay audit: decayed=${totalDecayed}, cleaned=${totalCleaned}`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] Score decay failed: ${err.message}`);
  }
}

// ─── Unified Memory Retrieval ───

/**
 * Retrieve relevant memories from all 4 types for context injection.
 * 
 * @param {string} userMessage - Current user message
 * @param {string} sessionKey - Current session
 * @param {object} options - { userId, toolsInProgress }
 * @returns {string} Formatted memory block for prompt injection
 */
// ─── TD-026 Resolution ─────────────────────────────────────
// MySQL `agentMemory` table was originally planned for cross-session persistent memory,
// but MySQL was never installed on the production server (confirmed 2026-04-11).
// All memory storage uses SQLite (`/opt/rangerai-agent/db/rangerai.db`) exclusively.
// The MySQL adapter in db-adapter.mjs is deprecated and marked for removal.
// If MySQL is deployed in the future, add a MySQL recall path here:
//   const mysqlMemories = await recallFromMySQL(keywords, sessionKey);
//   results.push(...mysqlMemories);
// ─────────────────────────────────────────────────────────────
export async function recallUnifiedMemory(userMessage, sessionKey, options = {}) {
  const db = await getDb();
  if (!db) return '';
  
  // Apply decay on each recall
  applyScoreDecay().catch(() => {});
  
  const results = [];
  const keywords = extractKeywords(userMessage);
  
  try {
    // 1. Episodic memories (recent events)
    const episodic = recallEpisodic(db, keywords, sessionKey);
    if (episodic.length > 0) {
      results.push({
        type: 'episodic',
        label: '相关事件记忆',
        items: episodic.slice(0, MEMORY_CONFIG.MAX_RECALL_PER_TYPE),
      });
    }
    
    // 2. Semantic memories (facts) — [R60-T2] Vector-first, keyword fallback
    let semantic = recallSemanticVector(db, userMessage, MEMORY_CONFIG.MAX_RECALL_PER_TYPE + 2);
    if (semantic.length === 0) {
      // Fallback to keyword-based recall when vector returns nothing
      semantic = recallSemantic(db, keywords);
      if (semantic.length > 0) {
        logger.info(`[${ts()}] [memory-mgr] [R60-T2] Vector recall empty, using keyword fallback (${semantic.length} items)`);
      }
    }
    if (semantic.length > 0) {
      results.push({
        type: 'semantic',
        label: '相关知识',
        items: semantic.slice(0, MEMORY_CONFIG.MAX_RECALL_PER_TYPE),
      });
    }
    
    // 3. Procedural memories (tool patterns + task patterns)
    const procedural = recallProcedural(db, keywords, options.toolsInProgress);
    if (procedural.length > 0) {
      results.push({
        type: 'procedural',
        label: '相关经验',
        items: procedural.slice(0, MEMORY_CONFIG.MAX_RECALL_PER_TYPE),
      });
    }
    
    // 4. User profile is handled by memory-extractor (injected separately)
    // We don't duplicate it here
    
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] Unified recall failed: ${err.message}`);
    return '';
  }
  
  if (results.length === 0) return '';
  
  // Format into injection block
  const parts = ['[LONG_TERM_MEMORY — relevant memories from past interactions]'];
  let totalChars = 0;
  
  for (const group of results) {
    parts.push(`\n[${group.label}]`);
    for (const item of group.items) {
      if (totalChars > MEMORY_CONFIG.RECALL_MAX_CHARS) break;
      parts.push(`- ${item}`);
      totalChars += item.length;
    }
  }
  
  parts.push('[/LONG_TERM_MEMORY]');
  
  // Boost scores of recalled items
  boostRecalledScores(db, results);
  
  // Emit recall event
  emitEvent(sessionKey, `task-${sessionKey}`, EVENT_TYPES.MEMORY_RECALL, {
    types: results.map(r => r.type),
    totalItems: results.reduce((sum, r) => sum + r.items.length, 0),
  });
  
  return parts.join('\n');
}

// ─── Internal Recall Functions ───

function recallEpisodic(db, keywords, sessionKey) {
  const items = [];
  
  try {
    // First: same session episodes
    const sessionEps = db.prepare(`
      SELECT summary, eventType, score, createdAt FROM memory_episodic 
      WHERE sessionKey = ? ORDER BY score DESC, createdAt DESC LIMIT 3
    `).all(sessionKey);
    
    for (const ep of sessionEps) {
      items.push(`[${ep.eventType}] ${ep.summary} (${ep.createdAt.substring(0, 10)})`);
    }
    
    // Then: keyword-matched from other sessions
    if (keywords.length > 0) {
      const likeConditions = keywords.map(() => 'summary LIKE ?').join(' OR ');
      const likeValues = keywords.map(k => `%${k}%`);
      
      const crossEps = db.prepare(`
        SELECT summary, eventType, score, createdAt FROM memory_episodic 
        WHERE sessionKey != ? AND (${likeConditions})
        ORDER BY score DESC LIMIT 3
      `).all(sessionKey, ...likeValues);
      
      for (const ep of crossEps) {
        items.push(`[${ep.eventType}] ${ep.summary} (${ep.createdAt.substring(0, 10)})`);
      }
    }
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] Episodic recall error: ${err.message}`);
  }
  
  return items;
}

// [R60-T2] hashEmbedding imported from ../lib/rag-utils.mjs

/**
 * [R60-T2] Vector-based semantic recall using hash embeddings.
 * Computes cosine similarity between query embedding and all stored facts,
 * returning top-K semantically similar items.
 * Keeps keyword-based `recallSemantic()` as fallback.
 */
function recallSemanticVector(db, query, limit = 5) {
  const items = [];
  
  try {
    if (!query || query.trim().length === 0) return items;
    
    const queryEmbedding = hashEmbedding(query);
    
    // Fetch all facts with content
    const facts = db.prepare(`
      SELECT id, title, content, score FROM adaptive_memory 
      WHERE category = 'adaptive_fact_knowledge'
      ORDER BY score DESC LIMIT 50
    `).all();
    
    if (facts.length === 0) return items;
    
    // Compute similarity for each fact
    const scored = facts.map(fact => {
      const factEmbedding = hashEmbedding(fact.content || fact.title || '');
      const similarity = cosineSimilarity(queryEmbedding, factEmbedding);
      return { ...fact, similarity };
    });
    
    // Sort by similarity descending, then by score
    scored.sort((a, b) => b.similarity - a.similarity || b.score - a.score);
    
    // Return top-K with reasonable similarity threshold
    const minSimilarity = 0.15;
    for (const fact of scored) {
      if (items.length >= limit) break;
      if (fact.similarity < minSimilarity && items.length > 0) break; // stop at low-sim if we have some
      items.push(`[知识] ${fact.title}: ${fact.content.substring(0, 200)}`);
    }
    
    logger.info(`[${ts()}] [memory-mgr] [R60-T2] Vector recall: ${items.length}/${facts.length} facts matched (top sim=${scored[0]?.similarity?.toFixed(3) || 'N/A'})`);
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] [R60-T2] Vector recall error: ${err.message}`);
  }
  
  return items;
}

function recallSemantic(db, keywords) {
  const items = [];
  
  try {
    if (keywords.length === 0) return items;
    
    const likeConditions = keywords.map(() => 'content LIKE ?').join(' OR ');
    const likeValues = keywords.map(k => `%${k}%`);
    
    const facts = db.prepare(`
      SELECT title, content, score FROM adaptive_memory 
      WHERE category = 'adaptive_fact_knowledge' AND (${likeConditions})
      ORDER BY score DESC, hitCount DESC LIMIT 5
    `).all(...likeValues);
    
    for (const fact of facts) {
      items.push(`[知识] ${fact.title}: ${fact.content.substring(0, 200)}`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] Semantic recall error: ${err.message}`);
  }
  
  return items;
}

function recallProcedural(db, keywords, toolsInProgress = []) {
  const items = [];
  
  try {
    // Tool experience for currently active tools
    if (toolsInProgress.length > 0) {
      for (const tool of toolsInProgress.slice(0, 3)) {
        const exp = db.prepare(`
          SELECT title, content, score FROM adaptive_memory 
          WHERE category = 'adaptive_tool_experience' AND title LIKE ?
          ORDER BY score DESC LIMIT 1
        `).get(`%${tool}%`);
        
        if (exp) {
          items.push(`[工具经验] ${exp.title}: ${exp.content.substring(0, 150)}`);
        }
      }
    }
    
    // Task patterns matching keywords
    if (keywords.length > 0) {
      const likeConditions = keywords.map(() => 'content LIKE ?').join(' OR ');
      const likeValues = keywords.map(k => `%${k}%`);
      
      const patterns = db.prepare(`
        SELECT title, content, score FROM adaptive_memory 
        WHERE category = 'adaptive_task_pattern' AND (${likeConditions})
        ORDER BY score DESC LIMIT 3
      `).all(...likeValues);
      
      for (const p of patterns) {
        items.push(`[任务模式] ${p.title}: ${p.content.substring(0, 150)}`);
      }
    }
  } catch (err) {
    logger.warn(`[${ts()}] [memory-mgr] Procedural recall error: ${err.message}`);
  }
  
  return items;
}

function boostRecalledScores(db, results) {
  try {
    // We can't easily boost specific rows without IDs, but we can boost by content match
    // This is a simplified version - in production, pass IDs through
  } catch (err) {
    // Non-fatal
  }
}

// ─── Keyword Extraction ───

function extractKeywords(text) {
  if (!text || text.length < 5) return [];
  
  const keywords = [];
  
  // Extract Chinese phrases (2-4 chars)
  const cjk = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  // Filter out common stop phrases
  const stopPhrases = new Set(['什么', '怎么', '如何', '为什么', '可以', '能不能', '是不是', '有没有', '一下', '一些']);
  for (const phrase of cjk) {
    if (!stopPhrases.has(phrase) && phrase.length >= 2) {
      keywords.push(phrase);
    }
  }
  
  // Extract English words (3+ chars)
  const english = text.match(/[a-zA-Z]{3,}/g) || [];
  const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'not', 'but', 'can', 'will', 'would', 'could', 'should']);
  for (const word of english) {
    if (!stopWords.has(word.toLowerCase())) {
      keywords.push(word.toLowerCase());
    }
  }
  
  // Deduplicate and limit
  return [...new Set(keywords)].slice(0, 10);
}

// ─── Stats ───



// ─── Short-term Conversation Recall (merged from conversation-recall.mjs, TD-003) ───

const SHORT_TERM_CONFIG = {
  MAX_ITEMS: 3,
  MIN_SCORE: 0.12,
  MAX_CHARS: 600,
  LOOKBACK: 50,
  WINDOW_SKIP: 4,
};

function stTokenize(text) {
  if (!text) return [];
  const english = text.match(/[a-zA-Z0-9]+/g) || [];
  const chinese = [];
  const cjk = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length; i++) chinese.push(seg[i]);
    for (let i = 0; i < seg.length - 1; i++) chinese.push(seg.slice(i, i + 2));
  }
  return [...english.map(w => w.toLowerCase()), ...chinese];
}

function stTermFrequency(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const total = tokens.length || 1;
  for (const t in tf) tf[t] /= total;
  return tf;
}

function stCosineSimilarity(tf1, tf2) {
  const keys = new Set([...Object.keys(tf1), ...Object.keys(tf2)]);
  let dot = 0, mag1 = 0, mag2 = 0;
  for (const k of keys) {
    const a = tf1[k] || 0, b = tf2[k] || 0;
    dot += a * b; mag1 += a * a; mag2 += b * b;
  }
  return (mag1 === 0 || mag2 === 0) ? 0 : dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

const ST_STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'to','of','in','on','at','by','for','with','about','from','that','this','it',
  'and','or','but','not','no','so','if','then','than','too','very','just','only',
  '的','了','是','在','我','你','他','她','它','我们','你们','他们','这','那',
  '也','都','和','与','或','但','如果','因为','所以','一个','一些','有','没有',
  '不','对','好','可以','需要','要','就','会','能','到','把','被','让','给',
  '吗','呢','吧','啊','哦','嗯','哈','呀','什么','怎么','怎样','哪','谁',
  '很','非常','比较','最','更','还','又','再','已经','说','看','做','用','想',
  '请','帮','谢谢','好的','没问题',
]);

function stFilterTokens(tokens) {
  return tokens.filter(t => t.length > 1 && !ST_STOP_WORDS.has(t));
}

/**
 * Short-term conversation recall: find relevant earlier messages
 * @param {string} currentMessage
 * @param {Array} conversationHistory - [{role, content}]
 * @returns {string|null}
 */
export function recallShortTermContext(currentMessage, conversationHistory) {
  if (!currentMessage || !conversationHistory || conversationHistory.length === 0) return null;
  
  const currentTokens = stFilterTokens(stTokenize(currentMessage));
  if (currentTokens.length < 2) return null;
  const currentTF = stTermFrequency(currentTokens);
  
  const candidateHistory = conversationHistory.slice(
    0, Math.max(0, conversationHistory.length - SHORT_TERM_CONFIG.WINDOW_SKIP)
  );
  const candidates = candidateHistory.slice(-SHORT_TERM_CONFIG.LOOKBACK);
  if (candidates.length === 0) return null;
  
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const msg = candidates[i];
    if (!msg || !msg.content) continue;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.length < 20) continue;
    const tokens = stFilterTokens(stTokenize(content));
    if (tokens.length < 2) continue;
    const score = stCosineSimilarity(currentTF, stTermFrequency(tokens));
    if (score >= SHORT_TERM_CONFIG.MIN_SCORE) {
      scored.push({
        index: i,
        role: msg.role || 'user',
        content: content.slice(0, SHORT_TERM_CONFIG.MAX_CHARS),
        score,
        truncated: content.length > SHORT_TERM_CONFIG.MAX_CHARS,
      });
    }
  }
  
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const topItems = scored.slice(0, SHORT_TERM_CONFIG.MAX_ITEMS);
  topItems.sort((a, b) => a.index - b.index);
  
  const parts = topItems.map(item => {
    const roleLabel = item.role === 'assistant' ? 'AI之前的回复' : '你之前说的';
    return `[${roleLabel} 相似度:${item.score.toFixed(2)}] ${item.content}${item.truncated ? '...' : ''}`;
  });
  
  return [
    '\n\n---\n**[上文关联召回 — 与当前问题相关的前文片段]**',
    parts.join('\n\n'),
    '---\n',
  ].join('\n');
}

export async function getMemoryStats() {
  const db = await getDb();
  if (!db) return {};
  
  try {
    const episodicCount = db.prepare('SELECT COUNT(*) as cnt FROM memory_episodic').get().cnt;
    const adaptiveCount = db.prepare('SELECT COUNT(*) as cnt FROM adaptive_memory').get().cnt;
    const factCount = db.prepare("SELECT COUNT(*) as cnt FROM adaptive_memory WHERE category = 'adaptive_fact_knowledge'").get().cnt;
    const toolExpCount = db.prepare("SELECT COUNT(*) as cnt FROM adaptive_memory WHERE category = 'adaptive_tool_experience'").get().cnt;
    const patternCount = db.prepare("SELECT COUNT(*) as cnt FROM adaptive_memory WHERE category = 'adaptive_task_pattern'").get().cnt;
    
    return {
      episodic: episodicCount,
      semantic: factCount,
      procedural: { toolExperience: toolExpCount, taskPatterns: patternCount },
      totalAdaptive: adaptiveCount,
      lastDecayRun: _lastDecayRun ? new Date(_lastDecayRun).toISOString() : 'never',
    };
  } catch (err) {
    return { error: err.message };
  }
}

export function cleanupMemoryManagerResources() {
  if (_memoryStatsTimer) {
    clearInterval(_memoryStatsTimer);
    _memoryStatsTimer = null;
  }
}

export { MEMORY_CONFIG };
