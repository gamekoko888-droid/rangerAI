// ─── Adaptive Memory Layer: Cross-session Knowledge Sedimentation ───
//
// Three memory types that complement existing memory-extractor.mjs:
// 1. Tool Experience: Success/failure patterns for tool calls
// 2. Fact Knowledge: Reusable facts extracted from search results
// 3. Task Patterns: Execution path templates for recurring task types
//
// Storage: SQLite knowledge_docs table + FTS5 index (reuses existing infra)

import { sendEvent } from "./ipc-utils.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();
let _adaptiveStatsTimer = null;

// ─── Configuration ───
const CONFIG = {
  // Tool experience
  TOOL_EXP_MAX_ENTRIES: 100,       // Max tool experience entries
  TOOL_EXP_MIN_DURATION_MS: 500,   // Only record tools that take >500ms
  TOOL_EXP_FAILURE_WEIGHT: 3,      // Failures are 3x more valuable than successes
  TOOL_EXP_DEDUP_WINDOW: 20,       // Dedup within last N entries

  // Fact knowledge
  FACT_MAX_ENTRIES: 50,             // Max fact entries
  FACT_MIN_LENGTH: 30,             // Min chars for a fact to be worth storing
  FACT_TTL_DAYS: 30,               // Facts expire after N days
  FACT_EXTRACT_TRIGGERS: ['web_search', 'web_fetch', 'browser'],

  // Task patterns
  PATTERN_MAX_ENTRIES: 30,         // Max task pattern entries
  PATTERN_MIN_STEPS: 3,           // Min steps for a pattern to be worth storing
  PATTERN_SIMILARITY_THRESHOLD: 0.6,

  // General
  CATEGORY_TOOL_EXP: 'adaptive_tool_experience',
  CATEGORY_FACT: 'adaptive_fact_knowledge',
  CATEGORY_PATTERN: 'adaptive_task_pattern',
};

// ─── Internal HTTP helper (reuses existing pattern from memory-extractor) ───
async function httpRequest(method, path, body = null) {
  const http = (await import('http')).default;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1', port: 3002,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-call': '1',
      },
    };
    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── SQLite direct access for adaptive memory ───
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
    _adaptiveStatsTimer = setInterval(() => {
      logger.info(`[${ts()}] [adaptive-mem] [SQLite-STATS] queries=${_queryCount} busy=${_busyCount}`);
      _queryCount = 0;
      _busyCount = 0;
    }, 15 * 60 * 1000);
    if (_adaptiveStatsTimer.unref) _adaptiveStatsTimer.unref();
    ensureAdaptiveTable(_db);
    return _db;
  } catch (err) {
    logger.warn(`[${ts()}] [adaptive-mem] SQLite init failed: ${err.message}`);
    return null;
  }
}

function ensureAdaptiveTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_memory (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      score REAL DEFAULT 1.0,
      hitCount INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      expiresAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_am_category ON adaptive_memory(category);
    CREATE INDEX IF NOT EXISTS idx_am_score ON adaptive_memory(score DESC);
  `);
}

// ─── 1. Tool Experience Memory ───

/**
 * Record a tool execution experience.
 * Called at tool:end with the tool name, args, result, duration, and success status.
 */
export async function recordToolExperience(toolName, args, result, durationMs, success, sessionKey) {
  if (durationMs < CONFIG.TOOL_EXP_MIN_DURATION_MS && success) return; // Skip fast successes

  try {
    const db = await getDb();
    if (!db) return;

    // Normalize args for dedup
    const argsNormalized = normalizeToolArgs(toolName, args);
    const subType = getToolSubType(toolName, args);
    const fingerprint = `${subType}:${argsNormalized}`;

    // Check for duplicate in recent entries
    const recent = db.prepare(`
      SELECT id, hitCount, score FROM adaptive_memory 
      WHERE category = ? AND title = ? 
      ORDER BY updatedAt DESC LIMIT ?
    `).all(CONFIG.CATEGORY_TOOL_EXP, fingerprint, CONFIG.TOOL_EXP_DEDUP_WINDOW);

    if (recent.length > 0) {
      // Update existing entry
      const existing = recent[0];
      const newScore = success
        ? existing.score + 0.1
        : existing.score + (0.1 * CONFIG.TOOL_EXP_FAILURE_WEIGHT);
      db.prepare(`
        UPDATE adaptive_memory SET hitCount = hitCount + 1, score = ?, updatedAt = ?, 
        content = ? WHERE id = ?
      `).run(newScore, new Date().toISOString(), buildToolExpContent(toolName, args, result, durationMs, success), existing.id);
      return;
    }

    // Insert new entry
    const id = `te-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const content = buildToolExpContent(toolName, args, result, durationMs, success);
    const score = success ? 1.0 : CONFIG.TOOL_EXP_FAILURE_WEIGHT;

    db.prepare(`
      INSERT INTO adaptive_memory (id, category, title, content, metadata, score, hitCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id, CONFIG.CATEGORY_TOOL_EXP, fingerprint, content,
      JSON.stringify({ toolName, subType, durationMs, success, sessionKey }),
      score, new Date().toISOString(), new Date().toISOString()
    );

    // Enforce max entries
    enforceLimit(db, CONFIG.CATEGORY_TOOL_EXP, CONFIG.TOOL_EXP_MAX_ENTRIES);

    logger.info(`[${ts()}] [adaptive-mem] Tool experience recorded: ${subType} (${success ? 'ok' : 'FAIL'}, ${durationMs}ms)`);
  } catch (err) {
    logger.warn(`[${ts()}] [adaptive-mem] recordToolExperience failed: ${err.message}`);
  }
}

export function getToolSubType(toolName, args) {
  if (toolName === 'exec') {
    const cmd = typeof args === 'string' ? args : (args.command || args.cmd || '');
    // Read operations
    if (/^(grep|cat|head|tail|less|find|ls|wc|du|df|stat|file|which|type|echo|pwd|whoami|id|uname|date|uptime|free|top|ps|env|printenv)\b/.test(cmd.trim())) return 'exec:read';
    // Service management
    if (/^(sudo\s+)?(systemctl|service|journalctl|supervisorctl|pm2|docker|nginx|apache)\b/.test(cmd.trim())) return 'exec:service';
    // Network operations
    if (/^(curl|wget|ping|nslookup|dig|traceroute|netstat|ss|nc|nmap|ssh|scp|rsync)\b/.test(cmd.trim())) return 'exec:network';
    // Package management
    if (/^(sudo\s+)?(apt|yum|dnf|pip|npm|pnpm|yarn|brew|snap)\b/.test(cmd.trim())) return 'exec:package';
    // File write operations
    if (/^(sed|awk|tee|mv|cp|rm|mkdir|chmod|chown|touch|ln|tar|gzip|zip|unzip)\b/.test(cmd.trim())) return 'exec:write';
    // Pipe chains with sed/awk are write-ish
    if (/\|\s*(sed|awk|tee)\b/.test(cmd)) return 'exec:write';
    return 'exec:misc';
  }
  if (toolName === 'edit' || toolName === 'write' || toolName === 'create_file') return 'file:write';
  if (toolName === 'read' || toolName === 'read_file' || toolName === 'view') return 'file:read';
  if (toolName === 'web_search' || toolName === 'search') return 'search';
  if (toolName === 'web_fetch' || toolName === 'browser') return 'web:browse';
  return toolName;
}

function normalizeToolArgs(toolName, args) {
  if (!args) return '';
  if (toolName === 'exec') {
    // Normalize exec commands: strip variable parts (timestamps, random IDs)
    const cmd = typeof args === 'string' ? args : (args.command || args.cmd || JSON.stringify(args));
    return cmd
      .replace(/\d{10,}/g, '<TS>')
      .replace(/[a-f0-9]{8,}/gi, '<ID>')
      .replace(/\/tmp\/[^\s]+/g, '/tmp/<FILE>')
      .slice(0, 200);
  }
  const str = typeof args === 'string' ? args : JSON.stringify(args);
  return str.slice(0, 200);
}

function buildToolExpContent(toolName, args, result, durationMs, success) {
  const resultPreview = typeof result === 'string'
    ? result.slice(0, 300)
    : JSON.stringify(result).slice(0, 300);
  return [
    `Tool: ${toolName}`,
    `Status: ${success ? 'SUCCESS' : 'FAILURE'}`,
    `Duration: ${durationMs}ms`,
    `Args: ${normalizeToolArgs(toolName, args)}`,
    `Result: ${resultPreview}`,
  ].join('\n');
}

// ─── 2. Fact Knowledge Memory ───

/**
 * Extract and store reusable facts from tool results (search, web_fetch, browser).
 * Called asynchronously after tool:end for search-type tools.
 */
export async function extractAndStoreFact(toolName, query, result, msgId) {
  if (!CONFIG.FACT_EXTRACT_TRIGGERS.includes(toolName)) return;
  if (!result || (typeof result === 'string' && result.length < CONFIG.FACT_MIN_LENGTH)) return;

  try {
    const db = await getDb();
    if (!db) return;

    // Use LLM to extract key facts
    const resultText = typeof result === 'string' ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000);

    const extractPrompt = `从以下搜索结果中提取可复用的关键事实（数据、日期、名称、结论）。
每条事实一行，用 "- " 开头。只保留客观事实，不要主观评价。最多5条。
如果没有值得记录的事实，输出"无"。

搜索查询: ${query || toolName}
搜索结果:
${resultText}

关键事实:`;

    const llmResult = await httpRequest('POST', '/api/chat/simple', {
      message: extractPrompt,
      model: 'openai/gpt-5-mini',
    });

    const extracted = (llmResult.reply || llmResult.content || '').trim();
    if (!extracted || extracted === '无' || extracted.length < 10) return;

    // Store each fact
    const facts = extracted.split('\n').filter(l => l.trim().startsWith('- '));
    let stored = 0;

    for (const fact of facts.slice(0, 5)) {
      const factText = fact.replace(/^- /, '').trim();
      if (factText.length < CONFIG.FACT_MIN_LENGTH) continue;

      // Check for duplicate
      const existing = db.prepare(`
        SELECT id FROM adaptive_memory 
        WHERE category = ? AND content LIKE ? LIMIT 1
      `).get(CONFIG.CATEGORY_FACT, `%${factText.slice(0, 50)}%`);

      if (existing) continue;

      const id = `fk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = new Date(Date.now() + CONFIG.FACT_TTL_DAYS * 86400000).toISOString();

      db.prepare(`
        INSERT INTO adaptive_memory (id, category, title, content, metadata, score, hitCount, createdAt, updatedAt, expiresAt)
        VALUES (?, ?, ?, ?, ?, 1.0, 0, ?, ?, ?)
      `).run(
        id, CONFIG.CATEGORY_FACT, query || toolName, factText,
        JSON.stringify({ source: toolName, query }),
        new Date().toISOString(), new Date().toISOString(), expiresAt
      );
      stored++;
    }

    if (stored > 0) {
      logger.info(`[${ts()}] [adaptive-mem] Stored ${stored} facts from ${toolName} (query: ${(query || '').slice(0, 50)})`);
      enforceLimit(db, CONFIG.CATEGORY_FACT, CONFIG.FACT_MAX_ENTRIES);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [adaptive-mem] extractAndStoreFact failed: ${err.message}`);
  }
}

// ─── 3. Task Pattern Memory ───

/**
 * Record a task execution pattern after a successful multi-step run.
 * Called at run completion with the tool sequence and user intent.
 */
export async function recordTaskPattern(userMessage, toolSequence, success, sessionKey) {
  if (!success || !toolSequence || toolSequence.length < CONFIG.PATTERN_MIN_STEPS) return;

  try {
    const db = await getDb();
    if (!db) return;

    // Build pattern fingerprint from tool sequence
    const patternFingerprint = toolSequence.map(t => t.name).join(' → ');

    // Check for similar existing pattern
    const existing = db.prepare(`
      SELECT id, hitCount, score, content FROM adaptive_memory 
      WHERE category = ? ORDER BY score DESC LIMIT 20
    `).all(CONFIG.CATEGORY_PATTERN);

    for (const entry of existing) {
      if (entry.content.includes(patternFingerprint.slice(0, 50))) {
        // Update existing pattern
        db.prepare(`
          UPDATE adaptive_memory SET hitCount = hitCount + 1, score = score + 0.5, updatedAt = ?
          WHERE id = ?
        `).run(new Date().toISOString(), entry.id);
        logger.info(`[${ts()}] [adaptive-mem] Task pattern updated (hit #${entry.hitCount + 1}): ${patternFingerprint.slice(0, 80)}`);
        return;
      }
    }

    // Store new pattern
    const id = `tp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const content = [
      `Intent: ${userMessage.slice(0, 200)}`,
      `Pattern: ${patternFingerprint}`,
      `Steps: ${toolSequence.length}`,
      `Tools: ${[...new Set(toolSequence.map(t => t.name))].join(', ')}`,
    ].join('\n');

    db.prepare(`
      INSERT INTO adaptive_memory (id, category, title, content, metadata, score, hitCount, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 1.0, 1, ?, ?)
    `).run(
      id, CONFIG.CATEGORY_PATTERN, `task:${userMessage.slice(0, 100)}`, content,
      JSON.stringify({ sessionKey, toolCount: toolSequence.length }),
      new Date().toISOString(), new Date().toISOString()
    );

    enforceLimit(db, CONFIG.CATEGORY_PATTERN, CONFIG.PATTERN_MAX_ENTRIES);
    logger.info(`[${ts()}] [adaptive-mem] New task pattern stored: ${patternFingerprint.slice(0, 80)}`);
  } catch (err) {
    logger.warn(`[${ts()}] [adaptive-mem] recordTaskPattern failed: ${err.message}`);
  }
}

// ─── Recall: Retrieve relevant adaptive memories ───

/**
 * Recall relevant adaptive memories for a user message.
 * Returns formatted context string or null.
 */
export async function recallAdaptiveMemory(userMessage, toolsInProgress = []) {
  try {
    const db = await getDb();
    if (!db) return null;

    const results = [];

    // 1. Recall relevant tool experiences (if tools are about to be used)
    if (toolsInProgress.length > 0) {
      for (const toolName of toolsInProgress) {
        const experiences = db.prepare(`
          SELECT content, score, hitCount FROM adaptive_memory 
          WHERE category = ? AND title LIKE ? 
          ORDER BY score DESC LIMIT 3
        `).all(CONFIG.CATEGORY_TOOL_EXP, `${toolName}:%`);

        if (experiences.length > 0) {
          results.push({
            type: 'tool_experience',
            items: experiences.map(e => e.content),
          });
        }
      }
    }

    // 2. Recall relevant facts (keyword match)
    const keywords = extractKeywords(userMessage);
    if (keywords.length > 0) {
      const likeConditions = keywords.slice(0, 5).map(k => `(title LIKE '%${k}%' OR content LIKE '%${k}%')`).join(' OR ');
      const facts = db.prepare(`
        SELECT title, content, score FROM adaptive_memory 
        WHERE category = ? AND (${likeConditions})
        AND (expiresAt IS NULL OR expiresAt > ?)
        ORDER BY score DESC LIMIT 3
      `).all(CONFIG.CATEGORY_FACT, new Date().toISOString());

      if (facts.length > 0) {
        results.push({
          type: 'fact_knowledge',
          items: facts.map(f => `[${f.title}] ${f.content}`),
        });
        // Update hit count
        for (const f of facts) {
          db.prepare(`UPDATE adaptive_memory SET hitCount = hitCount + 1 WHERE content = ? AND category = ?`)
            .run(f.content, CONFIG.CATEGORY_FACT);
        }
      }
    }

    // 3. Recall relevant task patterns
    if (userMessage.length > 20) {
      const patterns = db.prepare(`
        SELECT content, score, hitCount FROM adaptive_memory 
        WHERE category = ? ORDER BY score DESC, hitCount DESC LIMIT 3
      `).all(CONFIG.CATEGORY_PATTERN);

      const relevantPatterns = patterns.filter(p => {
        const intent = p.content.split('\n')[0].replace('Intent: ', '');
        return calculateSimilarity(userMessage, intent) > CONFIG.PATTERN_SIMILARITY_THRESHOLD;
      });

      if (relevantPatterns.length > 0) {
        results.push({
          type: 'task_pattern',
          items: relevantPatterns.map(p => p.content),
        });
      }
    }

    if (results.length === 0) return null;

    // Format for injection
    const parts = [];
    for (const r of results) {
      const label = {
        tool_experience: '🔧 工具经验',
        fact_knowledge: '📚 已知事实',
        task_pattern: '📋 任务模式',
      }[r.type] || r.type;

      parts.push(`[${label}]\n${r.items.join('\n')}`);
    }

    return `\n\n---\n**[自适应记忆召回]**\n${parts.join('\n\n')}\n---\n`;
  } catch (err) {
    logger.warn(`[${ts()}] [adaptive-mem] recallAdaptiveMemory failed: ${err.message}`);
    return null;
  }
}

// ─── Utility ───

function extractKeywords(text) {
  if (!text) return [];
  // Extract meaningful keywords (>2 chars, not stop words)
  const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '这', '那', '也', '都', '和', '与', '或', '但', '不', '有', '没有', '可以', '需要', '要', 'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'this', 'that', 'it']);
  const words = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g) || [];
  return words.filter(w => !stopWords.has(w.toLowerCase())).slice(0, 10);
}

function calculateSimilarity(text1, text2) {
  const words1 = new Set(extractKeywords(text1));
  const words2 = new Set(extractKeywords(text2));
  if (words1.size === 0 || words2.size === 0) return 0;
  const intersection = [...words1].filter(w => words2.has(w)).length;
  return intersection / Math.max(words1.size, words2.size);
}

function enforceLimit(db, category, maxEntries) {
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM adaptive_memory WHERE category = ?`).get(category);
  if (count.cnt > maxEntries) {
    const excess = count.cnt - maxEntries;
    db.prepare(`
      DELETE FROM adaptive_memory WHERE id IN (
        SELECT id FROM adaptive_memory WHERE category = ? ORDER BY score ASC, updatedAt ASC LIMIT ?
      )
    `).run(category, excess);
    logger.info(`[${ts()}] [adaptive-mem] Enforced limit: removed ${excess} entries from ${category}`);
  }
}

// ─── Stats ───

export async function getAdaptiveMemoryStats() {
  try {
    const db = await getDb();
    if (!db) return null;

    const stats = {};
    for (const cat of [CONFIG.CATEGORY_TOOL_EXP, CONFIG.CATEGORY_FACT, CONFIG.CATEGORY_PATTERN]) {
      const row = db.prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(hitCount), 0) as totalHits, 
        COALESCE(AVG(score), 0) as avgScore FROM adaptive_memory WHERE category = ?
      `).get(cat);
      stats[cat] = row;
    }
    return stats;
  } catch (err) {
    return null;
  }
}

/**
 * Cleanup expired entries.
 */
export async function cleanupExpired() {
  try {
    const db = await getDb();
    if (!db) return;
    const result = db.prepare(`
      DELETE FROM adaptive_memory WHERE expiresAt IS NOT NULL AND expiresAt < ?
    `).run(new Date().toISOString());
    if (result.changes > 0) {
      logger.info(`[${ts()}] [adaptive-mem] Cleaned up ${result.changes} expired entries`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [adaptive-mem] cleanup failed: ${err.message}`);
  }
}

export function cleanupAdaptiveMemoryResources() {
  if (_adaptiveStatsTimer) {
    clearInterval(_adaptiveStatsTimer);
    _adaptiveStatsTimer = null;
  }
}
