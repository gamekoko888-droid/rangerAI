/**
 * RangerAI Knowledge Base Database Module v4 — DI-refactored.
 * 
 * Iter-51: DI-refactored — db functions (query/queryOne/run/isMySQL/exec)
 * injected via init(), with static import from db-adapter.mjs as fallback.
 * 
 * Supports both SQLite and MySQL backends transparently.
 *
 * @version 4.0.0 — DI-refactored (Iter-51)
 */
import { llmRerank } from './llm-reranker.mjs';
import { logger } from './lib/logger.mjs';
import crypto from 'crypto';

// ─── DI: injected db functions (fallback to static import) ──────────
import { query as _sq, queryOne as _sqo, run as _sr, isMySQL as _sim } from './db-adapter.mjs';
let _di = null;

/**
 * Initialize with injected dependencies.
 * @param {{ query: Function, queryOne: Function, run: Function, isMySQL: Function, exec?: Function }} deps
 */
export function init(deps) {
  if (deps) {
    _di = deps;
    logger.info('[knowledge-db] DI initialized (using injected db functions)');
  }
}

/** Resolve db functions: injected > static fallback */
function q(sql, params) { return (_di?.query || _sq)(sql, params); }
function qo(sql, params) { return (_di?.queryOne || _sqo)(sql, params); }
function r(sql, params) { return (_di?.run || _sr)(sql, params); }
function isMy() { return (_di?.isMySQL || _sim)(); }

let initialized = false;

function now() {
  return isMy() ? 'NOW()' : "datetime('now')";
}

// ─── P4: Department-based visibility filter ───
/**
 * Build WHERE clause for department-based knowledge access control.
 * @param {string|null} userId - Current user ID (null = no filter)
 * @param {string|null} departmentId - User's department ID
 * @param {string} userRole - User's role (admin sees all)
 * @returns {{ clause: string, params: any[] }}
 */
function buildVisibilityFilter(userId, departmentId, userRole) {
  // Admin sees everything
  if (userRole === 'admin') return { clause: '', params: [] };
  // No user context = public only
  if (!userId) return { clause: " AND (visibility = 'all' OR visibility IS NULL)", params: [] };
  // Regular user: see all + own department + own private
  const conditions = ["visibility = 'all'", "visibility IS NULL"];
  const params = [];
  if (departmentId) {
    conditions.push("(visibility = 'department' AND department_id = ?)");
    params.push(departmentId);
  }
  conditions.push("(visibility = 'private' AND uploadedBy = ?)");
  params.push(userId);
  return { clause: ` AND (${conditions.join(' OR ')})`, params };
}


export async function initKnowledgeDb() {
  if (initialized) return;
  
  // For SQLite, create tables if they don't exist (MySQL tables are pre-created)
  if (!isMy()) {
    let execFn = _di?.exec;
    if (!execFn) {
      const adapter = await import('./db-adapter.mjs');
      execFn = adapter.exec;
    }
    await execFn(`
      CREATE TABLE IF NOT EXISTS knowledge_docs (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT DEFAULT '',
        category    TEXT DEFAULT '未分类',
        tags        TEXT DEFAULT '',
        fileName    TEXT,
        filePath    TEXT,
        fileSize    INTEGER DEFAULT 0,
        mimeType    TEXT DEFAULT 'text/plain',
        content     TEXT DEFAULT '',
        uploadedBy  TEXT,
        isActive    INTEGER DEFAULT 1,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_docs(category);
      CREATE INDEX IF NOT EXISTS idx_knowledge_uploadedBy ON knowledge_docs(uploadedBy);
      CREATE INDEX IF NOT EXISTS idx_knowledge_createdAt ON knowledge_docs(createdAt);

      -- FTS5 virtual table for full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_docs_fts USING fts5(
        title, description, content, tags,
        content='knowledge_docs',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert AFTER INSERT ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts(rowid, title, description, content, tags)
        VALUES (new.rowid, new.title, new.description, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts(knowledge_docs_fts, rowid, title, description, content, tags)
        VALUES ('delete', old.rowid, old.title, old.description, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge_docs BEGIN
        INSERT INTO knowledge_docs_fts(knowledge_docs_fts, rowid, title, description, content, tags)
        VALUES ('delete', old.rowid, old.title, old.description, old.content, old.tags);
        INSERT INTO knowledge_docs_fts(rowid, title, description, content, tags)
        VALUES (new.rowid, new.title, new.description, new.content, new.tags);
      END;

      -- Knowledge references table (message <-> knowledge doc)
      CREATE TABLE IF NOT EXISTS knowledge_references (
        id TEXT PRIMARY KEY,
        messageId TEXT NOT NULL,
        knowledgeDocId TEXT NOT NULL,
        snippet TEXT DEFAULT '',
        createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_kref_messageId ON knowledge_references(messageId);
      CREATE INDEX IF NOT EXISTS idx_kref_docId ON knowledge_references(knowledgeDocId);
    `);
    
    await execFn(`
      CREATE TABLE IF NOT EXISTS workflows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT DEFAULT '',
        steps       TEXT NOT NULL DEFAULT '[]',
        category    TEXT DEFAULT '未分类',
        createdBy   TEXT,
        isActive    INTEGER DEFAULT 1,
        runCount    INTEGER DEFAULT 0,
        lastRunAt   TEXT,
        createdAt   TEXT NOT NULL DEFAULT (datetime('now')),
        cronExpression TEXT DEFAULT NULL,
        cronEnabled INTEGER DEFAULT 0,
        nextRunAt   TEXT DEFAULT NULL,
        updatedAt   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_createdBy ON workflows(createdBy);
      CREATE INDEX IF NOT EXISTS idx_workflows_category ON workflows(category);
      CREATE INDEX IF NOT EXISTS idx_workflows_cronEnabled ON workflows(cronEnabled);
    `);

    // ─── Workflow Runs (Iter-11) ───
    await r(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id          TEXT PRIMARY KEY,
        workflowId  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        startedAt   TEXT,
        completedAt TEXT,
        result      TEXT DEFAULT '',
        error       TEXT DEFAULT '',
        triggeredBy TEXT DEFAULT 'manual',
        createdAt   TEXT NOT NULL DEFAULT (${now()}),
        FOREIGN KEY (workflowId) REFERENCES workflows(id)
      )
    `);
    await r('CREATE INDEX IF NOT EXISTS idx_workflow_runs_wfId ON workflow_runs(workflowId)');
    await r('CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)');

    // ─── Audit Logs (Iter-11) ───
    await r(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id        TEXT PRIMARY KEY,
        userId    TEXT NOT NULL,
        username  TEXT DEFAULT '',
        action    TEXT NOT NULL,
        targetType TEXT DEFAULT '',
        targetId  TEXT DEFAULT '',
        details   TEXT DEFAULT '',
        ip        TEXT DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT (${now()})
      )
    `);
    await r('CREATE INDEX IF NOT EXISTS idx_audit_logs_userId ON audit_logs(userId)');
    await r('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)');
    await r('CREATE INDEX IF NOT EXISTS idx_audit_logs_createdAt ON audit_logs(createdAt)');

    // ─── Knowledge Embeddings (Iter-61: fix missing CREATE TABLE) ───
    await execFn(`
      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        id         TEXT PRIMARY KEY,
        docId      TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL DEFAULT 0,
        chunkText  TEXT DEFAULT '',
        embedding  BLOB,
        createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (docId) REFERENCES knowledge_docs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ke_docId ON knowledge_embeddings(docId);
    `);
  }
  

  // ─── v26.0 Migration: scope/priority/enabled columns for Knowledge Module ───
  try {
    const cols = await q('PRAGMA table_info(knowledge_docs)');
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('scope')) {
      await r("ALTER TABLE knowledge_docs ADD COLUMN scope TEXT DEFAULT 'general'");
      logger.info('[knowledge-db] Migration: Added scope column');
    }
    if (!colNames.has('priority')) {
      await r("ALTER TABLE knowledge_docs ADD COLUMN priority INTEGER DEFAULT 50");
      logger.info('[knowledge-db] Migration: Added priority column');
    }
    if (!colNames.has('enabled')) {
      await r("ALTER TABLE knowledge_docs ADD COLUMN enabled INTEGER DEFAULT 1");
      logger.info('[knowledge-db] Migration: Added enabled column');
    }
    // Ensure indexes
    await r('CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge_docs(scope)');
    await r('CREATE INDEX IF NOT EXISTS idx_knowledge_enabled ON knowledge_docs(enabled)');
  } catch (migErr) {
    logger.info('[knowledge-db] v26.0 migration check: ' + migErr.message);
  }

  initialized = true;
  logger.info('[knowledge-db] Tables initialized');
}

export async function getKnowledgeDocs(category = null, limit = 100, offset = 0, { userId, departmentId, userRole } = {}) {
  if (category) {
    return await q(
      'SELECT * FROM knowledge_docs WHERE isActive = 1 AND category = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      [category, limit, offset]
    );
  }
  return await q(
    'SELECT * FROM knowledge_docs WHERE isActive = 1 ORDER BY createdAt DESC LIMIT ? OFFSET ?',
    [limit, offset]
  );
}

export async function getKnowledgeDocById(id) {
  return await qo('SELECT * FROM knowledge_docs WHERE id = ? AND isActive = 1', [id]);
}

export async function createKnowledgeDoc({ title, description, category, tags, fileName, filePath, fileSize, mimeType, content, uploadedBy, departmentId, visibility, scope, priority, enabled }) {
  const id = crypto.randomUUID();
  // v26.0: Include scope, priority, enabled in INSERT
  await r(
    `INSERT INTO knowledge_docs (id, title, description, category, tags, fileName, filePath, fileSize, mimeType, content, uploadedBy, scope, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, description || '', category || '未分类', tags || '', fileName, filePath, fileSize || 0, mimeType || 'text/plain', content || '', uploadedBy, scope || 'general', priority != null ? priority : 50, enabled != null ? enabled : 1]
  );
  const doc_result = await getKnowledgeDocById(id);
  // Iter-15A: fire-and-forget auto-embed
  if (content && content.trim().length >= 10) {
    embedDocumentAsync(id, content).catch(e => logger.error('[embedding] auto-embed error:', e.message));
  }
  return doc_result;
}

export async function updateKnowledgeDoc(id, updates) {
  const doc = await getKnowledgeDocById(id);
  if (!doc) return null;
  
  const allowedFields = ['title', 'description', 'category', 'tags', 'content', 'department_id', 'visibility', 'scope', 'priority', 'enabled'];
  const setClauses = [];
  const values = [];
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }
  
  if (setClauses.length === 0) return doc;
  
  setClauses.push(`updatedAt = ${now()}`);
  values.push(id);
  
  await r(`UPDATE knowledge_docs SET ${setClauses.join(', ')} WHERE id = ?`, values);
  const updated_doc = await getKnowledgeDocById(id);
  // Iter-15B: fire-and-forget auto-embed on ANY allowedField change (not just content)
  // Embedding quality depends on content+title+tags combination
  const hasRelevantChange = allowedFields.some(f => updates[f] !== undefined);
  const textForEmbed = updated_doc.content || '';
  if (hasRelevantChange && textForEmbed.trim().length >= 10) {
    embedDocumentAsync(id, textForEmbed).catch(e => logger.error('[embedding] auto-embed error:', e.message));
  }
  return updated_doc;
}

export async function deleteKnowledgeDoc(id) {
  // Iter-15B: soft-delete FIRST, then cascade delete embeddings (fix race condition)
  const result = await r('UPDATE knowledge_docs SET isActive = 0 WHERE id = ?', [id]);
  // Only clean up embeddings after successful soft-delete
  deleteDocumentEmbeddings(id).catch(e => logger.error('[embedding] cascade delete error:', e.message));
  return result;
}

export async function searchKnowledgeDocs(queryStr, category = null, limit = 50, { userId, departmentId, userRole } = {}) {
  const searchTerm = `%${queryStr}%`;
  const vis = buildVisibilityFilter(userId, departmentId, userRole);
  if (category) {
    return await q(
      `SELECT * FROM knowledge_docs WHERE isActive = 1 AND category = ? AND (title LIKE ? OR description LIKE ? OR content LIKE ? OR tags LIKE ?)${vis.clause} ORDER BY createdAt DESC LIMIT ?`,
      [category, searchTerm, searchTerm, searchTerm, searchTerm, ...vis.params, limit]
    );
  }
  return await q(
    `SELECT * FROM knowledge_docs WHERE isActive = 1 AND (title LIKE ? OR description LIKE ? OR content LIKE ? OR tags LIKE ?)${vis.clause} ORDER BY createdAt DESC LIMIT ?`,
    [searchTerm, searchTerm, searchTerm, searchTerm, ...vis.params, limit]
  );
}

export async function getKnowledgeCategories() {
  return await q(`
    SELECT category, COUNT(*) as count 
    FROM knowledge_docs WHERE isActive = 1 
    GROUP BY category ORDER BY count DESC
  `);
}

// ─── FTS Search (dual-engine: MySQL FULLTEXT + SQLite FTS5) ───
export async function searchKnowledgeFTS(queryStr, category = null, limit = 20, { userId, departmentId, userRole } = {}) {
  const safeQuery = queryStr.replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safeQuery) return [];
  
  try {
    if (isMy()) {
      // MySQL: FULLTEXT MATCH...AGAINST with ngram parser
      if (category) {
        return await q(
          `SELECT *, MATCH(title, description, content, tags) AGAINST(? IN NATURAL LANGUAGE MODE) as relevance
           FROM knowledge_docs
           WHERE MATCH(title, description, content, tags) AGAINST(? IN NATURAL LANGUAGE MODE)
             AND isActive = 1 AND category = ?
           ORDER BY relevance DESC LIMIT ?`,
          [safeQuery, safeQuery, category, limit]
        );
      }
      return await q(
        `SELECT *, MATCH(title, description, content, tags) AGAINST(? IN NATURAL LANGUAGE MODE) as relevance
         FROM knowledge_docs
         WHERE MATCH(title, description, content, tags) AGAINST(? IN NATURAL LANGUAGE MODE)
           AND isActive = 1
         ORDER BY relevance DESC LIMIT ?`,
        [safeQuery, safeQuery, limit]
      );    } else {
      // SQLite: FTS5 cannot tokenize CJK on SQLite 3.26 (unicode61 treats each char as token)
      // Strategy: detect CJK in query -> use LIKE search; English-only -> use FTS5
      const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(safeQuery);
      
      if (hasCJK) {
        // LIKE-based search for Chinese queries (FTS5 can't handle CJK tokenization)
        const terms = safeQuery.split(/\s+/).filter(t => t && t.length >= 1);
        if (terms.length === 0) return [];
        const conditions = terms.map(() => '(title LIKE ? OR content LIKE ?)').join(' AND ');
        const params = terms.flatMap(t => [`%${t}%`, `%${t}%`]);
        const catClause = category ? ' AND category = ?' : '';
        if (category) params.push(category);
        const vis = buildVisibilityFilter(userId, departmentId, userRole);
        params.push(...vis.params);
        params.push(limit);
        return await q(
          `SELECT *, 1.0 as relevance FROM knowledge_docs
           WHERE isActive = 1 AND ${conditions}${catClause}${vis.clause}
           ORDER BY updatedAt DESC LIMIT ?`,
          params
        );
      } else {
        // English queries: use FTS5 (works correctly with unicode61)
        const ftsTerms = safeQuery.split(/\s+/).filter(t => t && t.length >= 2 && !/^\d+$/.test(t));
        if (ftsTerms.length === 0) return [];
        const ftsQuery = ftsTerms.map(term => '"' + term + '"').join(' OR ');
        if (category) {
          return await q(
            `SELECT d.*, rank as relevance
             FROM knowledge_docs_fts fts
             JOIN knowledge_docs d ON d.rowid = fts.rowid
             WHERE knowledge_docs_fts MATCH ?
               AND d.isActive = 1 AND d.category = ?
             ORDER BY rank LIMIT ?`,
            [ftsQuery, category, limit]
          );
        }
        return await q(
          `SELECT d.*, rank as relevance
           FROM knowledge_docs_fts fts
           JOIN knowledge_docs d ON d.rowid = fts.rowid
           WHERE knowledge_docs_fts MATCH ?
             AND d.isActive = 1
           ORDER BY rank LIMIT ?`,
          [ftsQuery, limit]
        );
      }
    }
  } catch (ftsErr) {
    // Fallback to LIKE search if FTS fails
    logger.error('[knowledge-db] FTS search failed, falling back to LIKE:', ftsErr.message);
    return await searchKnowledgeDocs(queryStr, category, limit);
  }
}

// ─── Knowledge References ───
export async function createKnowledgeReference({ messageId, knowledgeDocId, snippet }) {
  const id = crypto.randomUUID();
  const nowTs = Date.now();
  await r(
    'INSERT INTO knowledge_references (id, messageId, knowledgeDocId, snippet, createdAt) VALUES (?, ?, ?, ?, ?)',
    [id, messageId, knowledgeDocId, snippet || '', nowTs]
  );
  return { id, messageId, knowledgeDocId, snippet };
}

export async function getMessageReferences(messageId) {
  return await q(
    `SELECT kr.*, kd.title as docTitle, kd.category as docCategory
     FROM knowledge_references kr
     LEFT JOIN knowledge_docs kd ON kr.knowledgeDocId = kd.id
     WHERE kr.messageId = ?
     ORDER BY kr.createdAt ASC`,
    [messageId]
  );
}

export async function getKnowledgeDocsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return await q(
    `SELECT * FROM knowledge_docs WHERE id IN (${placeholders}) AND isActive = 1`,
    ids
  );
}

// ─── Rebuild FTS index (one-time, call after migration) ───
export async function rebuildKnowledgeFTS() {
  try {
    if (isMy()) {
      const testResult = await q(
        "SELECT COUNT(*) as cnt FROM knowledge_docs WHERE MATCH(title, description, content, tags) AGAINST('test' IN NATURAL LANGUAGE MODE) OR 1=0",
        []
      );
      return { success: true, message: 'FULLTEXT index is operational (MySQL)' };
    } else {
      await r("INSERT INTO knowledge_docs_fts(knowledge_docs_fts) VALUES('rebuild')");
      return { success: true, message: 'FULLTEXT index rebuilt (SQLite)' };
    }
  } catch (err) {
    logger.error('[knowledge-db] FULLTEXT index rebuild/check failed:', err.message);
    return { success: false, message: err.message };
  }
}

// ─── Workflow functions ───
export async function getWorkflows(createdBy = null, limit = 100) {
  if (createdBy) {
    return await q(
      'SELECT * FROM workflows WHERE isActive = 1 AND createdBy = ? ORDER BY updatedAt DESC LIMIT ?',
      [createdBy, limit]
    );
  }
  return await q(
    'SELECT * FROM workflows WHERE isActive = 1 ORDER BY updatedAt DESC LIMIT ?',
    [limit]
  );
}

export async function getWorkflowById(id) {
  return await qo('SELECT * FROM workflows WHERE id = ? AND isActive = 1', [id]);
}

export async function createWorkflow({ name, description, steps, category, createdBy, cronExpression, cronEnabled, triggerType = 'manual' }) {
  const id = crypto.randomUUID();
  await r(
    `INSERT INTO workflows (id, name, description, steps, category, createdBy, cronExpression, cronEnabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description || '', JSON.stringify(steps || []), category || '未分类', createdBy, cronExpression || null, cronEnabled ? 1 : 0]
  );
  return await getWorkflowById(id);
}

export async function updateWorkflow(id, updates) {
  const wf = await getWorkflowById(id);
  if (!wf) return null;
  
  const allowedFields = ['name', 'description', 'steps', 'category', 'cronExpression', 'cronEnabled'];
  const setClauses = [];
  const values = [];
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      values.push(field === 'steps' ? JSON.stringify(updates[field]) : updates[field]);
    }
  }
  
  if (setClauses.length === 0) return wf;
  
  setClauses.push(`updatedAt = ${now()}`);
  values.push(id);
  
  await r(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?`, values);
  return await getWorkflowById(id);
}

export async function deleteWorkflow(id) {
  return await r('UPDATE workflows SET isActive = 0 WHERE id = ?', [id]);
}

export async function incrementWorkflowRunCount(id) {
  await r(`UPDATE workflows SET runCount = runCount + 1, lastRunAt = ${now()} WHERE id = ?`, [id]);
  return await getWorkflowById(id);
}

export async function getCronEnabledWorkflows() {
  return await q('SELECT * FROM workflows WHERE isActive = 1 AND cronEnabled = 1 AND cronExpression IS NOT NULL');
}

export async function updateWorkflowNextRun(id, nextRunAt) {
  await r('UPDATE workflows SET nextRunAt = ? WHERE id = ?', [nextRunAt, id]);
}


// ─── Workflow Runs (Iter-11) ───
export async function createWorkflowRun({ workflowId, triggeredBy = 'manual' }) {
  const id = crypto.randomUUID();
  const nowTs = new Date().toISOString();
  await r(
    'INSERT INTO workflow_runs (id, workflowId, status, startedAt, triggeredBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    [id, workflowId, 'running', nowTs, triggeredBy, nowTs]
  );
  return { id, workflowId, status: 'running', startedAt: nowTs, triggeredBy };
}

export async function updateWorkflowRun(id, updates) {
  const setClauses = [];
  const values = [];
  if (updates.status) { setClauses.push('status = ?'); values.push(updates.status); }
  if (updates.result !== undefined) { setClauses.push('result = ?'); values.push(typeof updates.result === 'string' ? updates.result : JSON.stringify(updates.result)); }
  if (updates.error !== undefined) { setClauses.push('error = ?'); values.push(updates.error); }
  if (updates.completedAt) { setClauses.push('completedAt = ?'); values.push(updates.completedAt); }
  if (setClauses.length === 0) return null;
  values.push(id);
  await r(`UPDATE workflow_runs SET ${setClauses.join(', ')} WHERE id = ?`, values);
  return await qo('SELECT * FROM workflow_runs WHERE id = ?', [id]);
}

export async function getWorkflowRuns(workflowId, limit = 20) {
  return await q(
    'SELECT * FROM workflow_runs WHERE workflowId = ? ORDER BY createdAt DESC LIMIT ?',
    [workflowId, limit]
  );
}

export async function getWorkflowRunById(id) {
  return await qo('SELECT * FROM workflow_runs WHERE id = ?', [id]);
}

// ─── Audit Logs (Iter-11) ───
export async function createAuditLog({ userId, username, action, targetType, targetId, details, ip }) {
  // Map Iter-11 field names to existing table column names
  await r(
    'INSERT INTO audit_logs (userId, username, `action`, target, targetId, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, username || '', action, targetType || '', targetId || '', details || '']
  );
  return { success: true };
}

export async function getAuditLogs(limit = 100, offset = 0) {
  return await q('SELECT * FROM audit_logs ORDER BY createdAt DESC LIMIT ? OFFSET ?', [limit, offset]);
}


// ─── Vector Search (Iter-14) ────────────────────────────────────────
import { chunkText, embeddingToBuffer, bufferToEmbedding, cosineSimilarity, reciprocalRankFusion } from './lib/rag-utils.mjs';
import { warmCache, cacheUpdateDoc, cacheRemoveDoc, cachedVectorSearch, getCacheStats } from './embedding-cache.mjs';
import { readFileSync } from 'fs';

/**
 * Get OpenAI API key for embedding calls.
 */
function getOpenAIKey() {
  try {
    const secrets = JSON.parse(readFileSync('secrets.json', 'utf8'));
    return secrets.OPENAI_API_KEY;
  } catch {
    return process.env.OPENAI_API_KEY || '';
  }
}

/**
 * Fetch embedding for a query string via OpenAI API.
 * @param {string} text - Query text
 * @returns {Float32Array} - 1536-dim embedding
 */

/**
 * Hash-based pseudo-embedding fallback when OPENAI_API_KEY is unavailable.
 * Not as good as real embeddings but allows basic vector search to work.
 * Uses character n-gram hashing to create a sparse vector.
 */
function hashBasedEmbedding(text, dim = 1536) {
  const embedding = new Float32Array(dim);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ' ').trim();
  const words = normalized.split(/\s+/).filter(w => w.length > 1);
  
  // Character trigram hashing
  for (const word of words) {
    for (let i = 0; i <= word.length - 3; i++) {
      const trigram = word.slice(i, i + 3);
      let hash = 0;
      for (let j = 0; j < trigram.length; j++) {
        hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
      }
      const idx = Math.abs(hash) % dim;
      embedding[idx] += 1.0;
    }
    // Word-level hash
    let wHash = 0;
    for (let j = 0; j < word.length; j++) {
      wHash = ((wHash << 5) - wHash + word.charCodeAt(j)) | 0;
    }
    const wIdx = Math.abs(wHash) % dim;
    embedding[wIdx] += 2.0;
  }
  
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) embedding[i] /= norm;
  
  return embedding;
}

async function getQueryEmbedding(text) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    // Fallback: use internal LLM API for pseudo-embedding (hash-based)
    logger.warn('[embedding] No OPENAI_API_KEY, using hash-based pseudo-embedding');
    return hashBasedEmbedding(text);
  }
  
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small',
    }),
  });
  
  if (!resp.ok) {
    throw new Error(`Embedding API error ${resp.status}: ${await resp.text()}`);
  }
  
  const data = await resp.json();
  return new Float32Array(data.data[0].embedding);
}

/**
 * Iter-15A: Auto-embed a document asynchronously (fire-and-forget).
 * Called after create/update to keep embeddings in sync.
 * @param {string} docId - Document ID
 * @param {string} textContent - Full text content to embed
 */
export async function embedDocumentAsync(docId, textContent) {
  try {
    if (!textContent || textContent.trim().length < 10) {
      // Skip: content too short
      return;
    }
    
    const apiKey = getOpenAIKey();
    if (!apiKey) {
      logger.warn('[embedding] No OPENAI_API_KEY, skipping auto-embed');
      return;
    }
    
    // Delete existing embeddings for this doc (re-embed on update)
    await r('DELETE FROM knowledge_embeddings WHERE docId = ?', [docId]);
    
    // Chunk the text
    const chunks = chunkText(textContent, { maxTokens: 500, overlapTokens: 100 });
    
    // Embed each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const resp = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            input: chunk.text,
            model: 'text-embedding-3-small',
          }),
        });
        
        if (!resp.ok) {
          logger.error(`[embedding] API error for chunk ${i}: ${resp.status}`);
          continue;
        }
        
        const data = await resp.json();
        const embedding = new Float32Array(data.data[0].embedding);
        const embBuffer = embeddingToBuffer(embedding);
        const embId = crypto.randomUUID();
        
        await r(
          `INSERT INTO knowledge_embeddings (id, docId, chunkIndex, chunkText, embedding) VALUES (?, ?, ?, ?, ?)`,
          [embId, docId, i, chunk.text, embBuffer]
        );
      } catch (chunkErr) {
        logger.error(`[embedding] Failed to embed chunk ${i} of doc ${docId}:`, chunkErr.message);
      }
    }
    
    // Auto-embed complete — sync update cache
    const cachedChunks = [];
    const embRows = await q('SELECT chunkIndex, chunkText, embedding FROM knowledge_embeddings WHERE docId = ?', [docId]);
    for (const row of embRows) {
      cachedChunks.push({
        chunkIndex: row.chunkIndex,
        chunkText: row.chunkText,
        embedding: bufferToEmbedding(row.embedding),
      });
    }
    // Fetch doc meta for cache
    const docMeta = await qo('SELECT title, content, category, tags FROM knowledge_docs WHERE id = ?', [docId]);
    if (docMeta) {
      cacheUpdateDoc(docId, cachedChunks, {
        title: docMeta.title,
        content: docMeta.content,
        category: docMeta.category,
        tags: docMeta.tags,
      });
    }
  } catch (err) {
    logger.error(`[embedding] Auto-embed failed for doc ${docId}:`, err.message);
  }
}

/**
 * Iter-15A: Delete embeddings for a document (cascade on soft-delete).
 * @param {string} docId - Document ID
 */
export async function deleteDocumentEmbeddings(docId) {
  try {
    await r('DELETE FROM knowledge_embeddings WHERE docId = ?', [docId]);
    // Sync remove from cache
    cacheRemoveDoc(docId);
  } catch (err) {
    logger.error(`[embedding] Failed to delete embeddings for doc ${docId}:`, err.message);
  }
}

export async function searchKnowledgeVector(queryStr, category = null, limit = 10) {
  // Iter-16: Uses embedding-cache + worker_threads for non-blocking search
  if (!queryStr || queryStr.trim().length < 2) return [];
  
  // Get query embedding (still hits OpenAI API)
  const queryEmb = await getQueryEmbedding(queryStr);
  
  // Delegate to cached vector search (worker thread handles cosine computation)
  return cachedVectorSearch(queryEmb, category, limit);
}

/**
 * Hybrid search: run FTS + Vector in parallel, fuse with RRF.
 * This is the primary search function for Iter-14.
 * 
 * @param {string} queryStr - User query text
 * @param {string|null} category - Optional category filter
 * @param {number} limit - Max results (default 5)
 * @returns {Array<{id, title, content, score, rrfScore, sources}>}
 */
export async function searchKnowledgeHybrid(queryStr, category = null, limit = 5, { userId, departmentId, userRole } = {}) {
  if (!queryStr || queryStr.trim().length < 2) return [];
  
  // P1-3: Query expansion - also search with key terms extracted
  const expandedQuery = queryStr.length > 50 ? queryStr.slice(0, 100) : queryStr;
  
  // Run FTS and Vector search in parallel
  const visCtx = { userId, departmentId, userRole };
  const [ftsResults, vecResults] = await Promise.allSettled([
    searchKnowledgeFTS(queryStr, category, limit * 2, visCtx),
    searchKnowledgeVector(queryStr, category, limit * 2, visCtx),
  ]);
  
  const ftsList = ftsResults.status === 'fulfilled' ? ftsResults.value : [];
  const vecList = vecResults.status === 'fulfilled' ? vecResults.value : [];
  
  // If one channel fails completely, fall back to the other
  if (ftsList.length === 0 && vecList.length === 0) return [];
  if (ftsList.length === 0) return vecList.slice(0, limit);
  if (vecList.length === 0) return ftsList.slice(0, limit);
  
  // RRF fusion
  const fused = reciprocalRankFusion([ftsList, vecList], { k: 30, topK: limit });
  
  // Ensure each result has full doc content (from whichever source had it)
  const docContentMap = new Map();
  for (const rr of [...ftsList, ...vecList]) {
    if (rr.content && !docContentMap.has(rr.id)) {
      docContentMap.set(rr.id, { title: rr.title, content: rr.content });
    }
  }
  
  const rrfResults = fused.map(rr => ({
    id: rr.id,
    title: rr.title || docContentMap.get(rr.id)?.title || 'Unknown',
    content: rr.content || docContentMap.get(rr.id)?.content || rr.chunkText || '',
    chunkText: rr.chunkText || '', // Explicitly expose the matched chunk for Small-to-Big alignment
    score: rr.rrfScore,       // Normalized alias consumed by frontend (doc.score)
    rrfScore: rr.rrfScore,
    sources: rr.sources,
    // Preserve original scores for debugging
    ftsRelevance: rr.relevance,
    vectorScore: rr.score,
  }));
  return rrfResults;
}

export async function countKnowledgeDocs(category = null) {
  if (category) {
    const row = await qo(
      'SELECT COUNT(*) as total FROM knowledge_docs WHERE isActive = 1 AND category = ?',
      [category]
    );
    return row?.total || 0;
  }
  const row = await qo(
    'SELECT COUNT(*) as total FROM knowledge_docs WHERE isActive = 1'
  );
  return row?.total || 0;
}
