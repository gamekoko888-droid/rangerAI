/**
 * knowledge-api.mjs — REST endpoints for knowledge base management.
 * Sub-iter 4.5A: DI规范化 — init(deps) + validateDeps + deps.db.* 子对象
 * v5.4: #8 RBAC 权限接入 — manager+ 可上传知识库
 *
 * All database functions accessed via deps.db.* (injected from ctx.db).
 * Zero direct imports from database.mjs or knowledge-db.mjs.
 *
 * Routes handled:
 *   handleKnowledgeApi(req, res)
 *     - GET    /api/knowledge              — List all knowledge documents
 *     - POST   /api/knowledge              — Upload a knowledge document
 *     - GET    /api/knowledge/:id          — Get document details
 *     - DELETE /api/knowledge/:id          — Delete a document
 *     - PATCH  /api/knowledge/:id          — Update document metadata
 *     - GET    /api/knowledge/categories   — List all categories
 *     - POST   /api/knowledge/search       — Search documents
 *
 * Supported file types for content extraction:
 *   - Text: .txt, .md, .json, .csv (UTF-8 text)
 *   - PDF:  .pdf (via pdf-parse)
 *   - Word: .docx (via mammoth)
 */
import { logger } from '../lib/logger.mjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { validateDeps } from '../lib/context.mjs';
import { hasPermission, denyAccess } from '../modules/rbac.mjs';

// ─── Module-level DI state ──────────────────────────────────
/** @type {object|null} */
let deps = null;

/**
 * Initialize the knowledge-api module with injected dependencies.
 *
 * @param {object} injected
 * @param {object} injected.db - Database operations (from ctx.db)
 */
export function init(injected) {
  validateDeps(['db'], injected, 'knowledge-api');
  deps = injected;
}

// ─── Constants ──────────────────────────────────────────────
const KNOWLEDGE_DIR = '/home/admin/.openclaw/workspace/knowledge';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// ─── Internal helpers ───────────────────────────────────────

function ensureKnowledgeDir() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
}

/**
 * Extract text content from a file using the unified file-parser.
 * Delegates all format detection and parsing to lib/file-parser.mjs.
 */
async function extractFileContent(fileData, fileName, mimeType) {
  const { parseBuffer } = await import('../lib/file-parser.mjs');
  const result = await parseBuffer(Buffer.from(fileData), fileName, mimeType, { noTruncate: true });
  return result.text || '';
}

function fixDoubleUtf8(str) {
  try {
    // If string already contains non-Latin1 chars (e.g. CJK), it's already correct UTF-8
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 255) return str;
    }
    // All chars are Latin1 — might be double-encoded UTF-8, try to decode
    const bytes = Buffer.alloc(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i);
    }
    const decoded = bytes.toString("utf-8");
    // Check if decoded contains CJK characters (fixed regex with proper \u escape)
    if (/[\u4e00-\u9fff]/.test(decoded)) return decoded;
    return str;
  } catch(e) { return str; }
}
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      reject(new Error('No boundary found'));
      return;
    }
    const boundary = boundaryMatch[1];
    const chunks = [];
    let totalSize = 0;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_FILE_SIZE) {
        reject(new Error('File too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      // Use Buffer-level splitting to preserve UTF-8 encoding
      const boundaryBuf = Buffer.from('--' + boundary);
      const result = { fields: {}, files: [] };
      const separatorBuf = Buffer.from('\r\n\r\n');

      // Find all boundary positions in the buffer
      let pos = 0;
      const partBuffers = [];
      while (pos < buffer.length) {
        const idx = buffer.indexOf(boundaryBuf, pos);
        if (idx === -1) break;
        if (partBuffers.length > 0) {
          // Previous part ends here (minus trailing \r\n before boundary)
          let end = idx;
          if (end >= 2 && buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) {
            end -= 2;
          }
          partBuffers[partBuffers.length - 1].end = end;
        }
        const startOfPart = idx + boundaryBuf.length;
        // Skip \r\n after boundary
        const dataStart = (startOfPart + 2 <= buffer.length && buffer[startOfPart] === 0x0d && buffer[startOfPart + 1] === 0x0a)
          ? startOfPart + 2 : startOfPart;
        partBuffers.push({ start: dataStart, end: buffer.length });
        pos = dataStart;
      }

      for (const pb of partBuffers) {
        const partBuf = buffer.subarray(pb.start, pb.end);
        if (partBuf.length < 4) continue;
        // Check for closing boundary marker "--"
        if (partBuf.length <= 4 && partBuf.toString('utf-8').trim() === '--') continue;

        const sepIdx = partBuf.indexOf(separatorBuf);
        if (sepIdx === -1) continue;

        // Headers are ASCII-safe, decode as utf-8
        const headers = partBuf.subarray(0, sepIdx).toString('utf-8');
        const bodyBuf = partBuf.subarray(sepIdx + 4);

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        // Also handle filename*=UTF-8''encoded format
        const filenameStarMatch = headers.match(/filename\*=(?:UTF-8|utf-8)''([^\s;]+)/);

        if ((filenameMatch || filenameStarMatch) && nameMatch) {
          const contentTypeMatch = headers.match(/Content-Type:\s*(.+)/i);
          let filename = filenameMatch ? filenameMatch[1] : '';
          // Prefer filename* (RFC 5987) if available
          if (filenameStarMatch) {
            try { filename = decodeURIComponent(filenameStarMatch[1]); } catch(e) { /* keep original */ }
          }
          result.files.push({
            fieldName: nameMatch[1],
            filename: fixDoubleUtf8(filename),
            contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
            data: Buffer.from(bodyBuf),
          });
        } else if (nameMatch) {
          // Text fields: decode as UTF-8
          result.fields[nameMatch[1]] = bodyBuf.toString('utf-8').trim();
        }
      }
      resolve(result);
    });
    req.on('error', reject);
  });
}
// ─── Main Route Handler ─────────────────────────────────────

export async function handleKnowledgeApi(req, res) {
  const { db } = deps;
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // All knowledge endpoints require authentication
  // 内部服务调用（来自 127.0.0.1 且携带 x-internal-call 头）直接放行
  const remoteAddr = req.socket?.remoteAddress || '';
  const isInternal = req.headers['x-internal-call'] === '1' &&
    (remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1');
  let user;
  if (isInternal) {
    // P4: If internal call has x-user-id, look up real user for department filtering
    const internalUserId = req.headers['x-user-id'];
    if (internalUserId && internalUserId !== 'system') {
      try {
        const realUser = await db.query('SELECT id, role, department_id FROM users WHERE id = ?', [internalUserId]);
        user = realUser?.[0] || { id: internalUserId, role: 'member', department_id: null };
      } catch {
        user = { id: internalUserId, role: 'member', department_id: null };
      }
    } else {
      user = { id: 'system', role: 'admin' };
    }
  } else {
    user = await db.extractUserFromRequest(req);
  }
  if (!user) {
    db.sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  // Initialize knowledge DB tables
  await db.initKnowledgeDb();
  ensureKnowledgeDir();

  // P4: Build visibility context from user
  const visCtx = { userId: user.id, departmentId: user.department_id || null, userRole: user.role };


  // ─── GET /api/knowledge/categories ───
  if (urlPath === '/api/knowledge/categories' && method === 'GET') {
    try {
      const categories = await db.getKnowledgeCategories();
      db.sendJson(res, 200, { categories });
    } catch (err) {
      logger.error('[knowledge-api] categories error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to get categories' });
    }
    return true;
  }

  // ─── POST /api/knowledge/search ───
  if (urlPath === '/api/knowledge/search' && method === 'POST') {
    try {
      const body = await db.parseJsonBody(req);
      const { query, category, limit = 50, scopes } = body;
      // v26.0: Accept scopes array for scope-filtered search
      // Use FTS5 search with snippet support, fallback to LIKE
      let docs;
      try {
        if (db.searchKnowledgeHybrid) {
          docs = await db.searchKnowledgeHybrid(query, category, limit, visCtx);
          // Hybrid search completed
        } else {
          docs = await db.searchKnowledgeFTS(query, category, limit, visCtx);
        }
      } catch (hybridErr) {
        logger.warn('[knowledge-api] Hybrid search failed, trying FTS:', hybridErr.message);
        try {
          docs = await db.searchKnowledgeFTS(query, category, limit, visCtx);
        } catch (ftsErr) {
          logger.warn('[knowledge-api] FTS also failed, falling back to LIKE');
          docs = await db.searchKnowledgeDocs(query, category, limit, visCtx);
        }
      }
      // v26.0: Post-filter by scope and enabled status
      if (docs && docs.length > 0) {
        // Always filter out disabled docs
        docs = docs.filter(d => d.enabled !== 0);
        // If scopes provided, filter: doc.scope must match one of the requested scopes
        // 'general' scope docs always pass through
        if (scopes && Array.isArray(scopes) && scopes.length > 0) {
          docs = docs.filter(d => {
            const docScope = d.scope || 'general';
            // Support comma-separated scopes in doc (e.g., "code,operations")
            const docScopes = docScope.split(',').map(s => s.trim());
            return docScopes.some(ds => ds === 'general' || scopes.includes(ds));
          });
        }
        // v26.0: Sort by priority DESC then by score DESC
        docs.sort((a, b) => {
          const priA = a.priority ?? 50;
          const priB = b.priority ?? 50;
          if (priB !== priA) return priB - priA;
          const scoreA = a.rrfScore || a.score || 0;
          const scoreB = b.rrfScore || b.score || 0;
          return scoreB - scoreA;
        });
      }
      db.sendJson(res, 200, { docs });
    } catch (err) {
      logger.error('[knowledge-api] search error:', err.message);
      db.sendJson(res, 500, { error: 'Search failed' });
    }
    return true;
  }

  // ─── GET /api/knowledge ───
  if (urlPath === '/api/knowledge' && method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const category = url.searchParams.get('category');
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const [docs, total] = await Promise.all([
        db.getKnowledgeDocs(category, limit, offset, visCtx),
        db.countKnowledgeDocs(category)
      ]);
      db.sendJson(res, 200, { docs, total, limit, offset, hasMore: offset + docs.length < total });
    } catch (err) {
      logger.error('[knowledge-api] list error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to list documents' });
    }
    return true;
  }

  // ─── POST /api/knowledge ───
  if (urlPath === '/api/knowledge' && method === 'POST') {
    // #8 RBAC: manager+ can upload knowledge
    if (!hasPermission(user, 'knowledge.upload')) {
      denyAccess(res, db.sendJson, 'knowledge.upload', user.role);
      return true;
    }
    try {
      const contentType = req.headers['content-type'] || '';
      let title, description, category, tags, fileContent, fileName, fileMimeType, fileSize;

      if (contentType.includes('multipart/form-data')) {
        const parsed = await parseMultipart(req);
        title = parsed.fields.title || '';
        description = parsed.fields.description || '';
        category = parsed.fields.category || '未分类';
        tags = parsed.fields.tags || '';

        if (parsed.files.length > 0) {
          const file = parsed.files[0];
          fileName = file.filename;
          fileMimeType = file.contentType;
          fileSize = file.data.length;

          // Save file to knowledge directory
          const ext = path.extname(fileName);
          const safeFileName = `${crypto.randomUUID()}${ext}`;
          const filePath = path.join(KNOWLEDGE_DIR, safeFileName);
          fs.writeFileSync(filePath, file.data);

          // Extract text content for searchable index
          fileContent = await extractFileContent(file.data, fileName, fileMimeType);

          const doc = await db.createKnowledgeDoc({
            title: title || fileName,
            description,
            category,
            tags,
            fileName,
            filePath: safeFileName,
            fileSize,
            mimeType: fileMimeType,
            content: fileContent || '',
            uploadedBy: user.id,
          });

          // Auto-trigger embedding after file upload
          if (doc && doc.id && fileContent) {
            db.embedDocumentAsync(doc.id, fileContent).catch(err => {
              logger.error(`[knowledge-api] auto-embed failed for ${doc.id}:`, err.message);
            });
          }
          db.sendJson(res, 201, { doc });
        } else {
          db.sendJson(res, 400, { error: 'No file uploaded' });
        }
      } else {
        // JSON body — text-only knowledge entry
        const body = await db.parseJsonBody(req);
        title = body.title;
        description = body.description || '';
        category = body.category || '未分类';
        tags = body.tags || '';
        fileContent = body.content || '';

        if (!title) {
          db.sendJson(res, 400, { error: 'Title is required' });
          return true;
        }

        const doc = await db.createKnowledgeDoc({
          title,
          description,
          category,
          tags,
          fileName: null,
          filePath: null,
          fileSize: 0,
          mimeType: 'text/plain',
          content: fileContent,
          uploadedBy: user.id,
          scope: body.scope || 'general',
          priority: body.priority != null ? parseInt(body.priority) : 50,
          enabled: body.enabled != null ? (body.enabled ? 1 : 0) : 1,
        });

        // Auto-trigger embedding after text entry creation
        if (doc && doc.id && fileContent) {
          db.embedDocumentAsync(doc.id, fileContent).catch(err => {
            logger.error(`[knowledge-api] auto-embed failed for ${doc.id}:`, err.message);
          });
        }
        db.sendJson(res, 201, { doc });
      }
    } catch (err) {
      logger.error('[knowledge-api] upload error:', err.message);
      db.sendJson(res, 500, { error: `Upload failed: ${err.message}` });
    }
    return true;
  }

  // ─── POST /api/knowledge/rebuild-fts — Rebuild FTS index ───
  if (urlPath === '/api/knowledge/rebuild-fts' && method === 'POST') {
    try {
      await db.rebuildKnowledgeFTS();
      db.sendJson(res, 200, { message: 'FTS index rebuilt successfully' });
    } catch (err) {
      logger.error('[knowledge-api] rebuild FTS error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to rebuild FTS index' });
    }
    return true;
  }

  // ─── GET /api/knowledge/:id ───
  // ─── POST /api/knowledge/search-debug — Debug search with detailed scoring ───
  if (urlPath === '/api/knowledge/search-debug' && method === 'POST') {
    try {
      // Admin only
      if (user.role !== 'admin') {
        db.sendJson(res, 403, { error: 'Admin only' });
        return true;
      }
      const body = await db.parseJsonBody(req);
      const { query, category, limit = 5 } = body;
      if (!query || query.trim().length < 2) {
        db.sendJson(res, 400, { error: 'Query must be at least 2 characters' });
        return true;
      }
      const t0 = Date.now();
      // Run FTS search
      let ftsResults = [];
      const tFts0 = Date.now();
      try {
        ftsResults = await db.searchKnowledgeFTS(query, category, limit * 2);
      } catch (e) { logger.warn('[search-debug] FTS failed:', e.message); }
      const tFts1 = Date.now();
      // Run Vector search
      let vectorResults = [];
      const tVec0 = Date.now();
      try {
        vectorResults = await db.searchKnowledgeVector(query, category, limit * 2);
      } catch (e) { logger.warn('[search-debug] Vector failed:', e.message); }
      const tVec1 = Date.now();
      // Run Hybrid (RRF fusion)
      let fusedResults = [];
      const tHyb0 = Date.now();
      try {
        fusedResults = await db.searchKnowledgeHybrid(query, category, limit);
      } catch (e) { logger.warn('[search-debug] Hybrid failed:', e.message); }
      const tHyb1 = Date.now();
      db.sendJson(res, 200, {
        query,
        category,
        ftsResults: ftsResults.map(r => ({
          id: r.id, title: r.title, snippet: (r.snippet_text || r.content || '').substring(0, 200),
          relevance: r.relevance || r.ftsRelevance || null,
        })),
        vectorResults: vectorResults.map(r => ({
          id: r.id || r.docId, title: r.title, snippet: (r.chunkText || r.content || '').substring(0, 200),
          score: r.score || r.vectorScore || null,
          chunkIndex: r.chunkIndex,
        })),
        fusedResults: fusedResults.map(r => ({
          id: r.id, title: r.title, snippet: (r.content || '').substring(0, 200),
          rrfScore: r.rrfScore, sources: r.sources,
          ftsRelevance: r.ftsRelevance, vectorScore: r.vectorScore,
        })),
        timing: {
          fts_ms: tFts1 - tFts0,
          vector_ms: tVec1 - tVec0,
          hybrid_ms: tHyb1 - tHyb0,
          total_ms: Date.now() - t0,
        },
        counts: {
          fts: ftsResults.length,
          vector: vectorResults.length,
          fused: fusedResults.length,
        },
      });
    } catch (err) {
      logger.error('[knowledge-api] search-debug error:', err.message);
      db.sendJson(res, 500, { error: `Search debug failed: ${err.message}` });
    }
    return true;
  }
  // ─── POST /api/knowledge/:id/retry-embedding — Retry embedding generation ───
  const retryEmbMatch = urlPath.match(/^\/api\/knowledge\/([^/]+)\/retry-embedding$/);
  if (retryEmbMatch && method === 'POST') {
    try {
      if (user.role !== 'admin') {
        db.sendJson(res, 403, { error: 'Admin only' });
        return true;
      }
      const docId = retryEmbMatch[1];
      const doc = await db.getKnowledgeDocById(docId);
      if (!doc) {
        db.sendJson(res, 404, { error: 'Document not found' });
        return true;
      }
      // Fire-and-forget embedding
      db.embedDocumentAsync(docId, doc.content || '').catch(err => {
        logger.error(`[knowledge-api] retry-embedding failed for ${docId}:`, err.message);
      });
      db.sendJson(res, 202, { message: 'Embedding regeneration started', docId });
    } catch (err) {
      logger.error('[knowledge-api] retry-embedding error:', err.message);
      db.sendJson(res, 500, { error: `Retry embedding failed: ${err.message}` });
    }
    return true;
  }
  // ─── GET /api/knowledge/:id/embedding-status — Check embedding status ───
  const embStatusMatch = urlPath.match(/^\/api\/knowledge\/([^/]+)\/embedding-status$/);
  if (embStatusMatch && method === 'GET') {
    try {
      const docId = embStatusMatch[1];
      const doc = await db.getKnowledgeDocById(docId);
      if (!doc) {
        db.sendJson(res, 404, { error: 'Document not found' });
        return true;
      }
      // Count embeddings for this doc
      const embRows = await db.query(
        'SELECT COUNT(*) as count, MAX(chunkIndex) as maxChunk FROM knowledge_embeddings WHERE docId = ?',
        [docId]
      );
      const embCount = embRows[0]?.count || 0;
      const maxChunk = embRows[0]?.maxChunk ?? -1;
      db.sendJson(res, 200, {
        docId,
        docTitle: doc.title,
        contentLength: (doc.content || '').length,
        embeddingCount: embCount,
        maxChunkIndex: maxChunk,
        hasEmbeddings: embCount > 0,
        status: embCount > 0 ? 'ready' : 'missing',
      });
    } catch (err) {
      logger.error('[knowledge-api] embedding-status error:', err.message);
      db.sendJson(res, 500, { error: `Embedding status check failed: ${err.message}` });
    }
    return true;
  }

  // ─── POST /api/knowledge/search-log — RAG v2 命中日志（必须在 :id 通配前）───
  if (urlPath === '/api/knowledge/search-log' && method === 'POST') {
    try {
      const body = await db.parseJsonBody(req);
      const { query, hits, ts: logTs } = body;
      if (!query || !Array.isArray(hits)) { db.sendJson(res, 400, { error: 'invalid' }); return true; }
      await db.run(`CREATE TABLE IF NOT EXISTS knowledge_search_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT, hit_doc_ids TEXT, hit_titles TEXT,
        hit_count INTEGER, top_score REAL, created_at TEXT
      )`).catch(() => {});
      const hitDocIds = hits.map(h => h.id).join(',');
      const hitTitles = hits.map(h => h.title).join('|');
      const topScore = hits.length > 0 ? (hits[0].score || 0) : 0;
      await db.run(
        `INSERT INTO knowledge_search_log (query, hit_doc_ids, hit_titles, hit_count, top_score, created_at) VALUES (?,?,?,?,?,?)`,
        [query.slice(0, 200), hitDocIds, hitTitles.slice(0, 500), hits.length, topScore, logTs || new Date().toISOString()]
      ).catch(() => {});
      db.sendJson(res, 200, { ok: true });
    } catch (err) {
      db.sendJson(res, 200, { ok: false });
    }
    return true;
  }

  // ─── GET /api/knowledge/search-stats — 命中率统计（必须在 :id 通配前）───
  if (urlPath === '/api/knowledge/search-stats' && method === 'GET') {
    try {
      await db.run(`CREATE TABLE IF NOT EXISTS knowledge_search_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT, hit_doc_ids TEXT, hit_titles TEXT,
        hit_count INTEGER, top_score REAL, created_at TEXT
      )`).catch(() => {});
      const total = await db.queryOne('SELECT COUNT(*) as c FROM knowledge_search_log');
      const withHits = await db.queryOne('SELECT COUNT(*) as c FROM knowledge_search_log WHERE hit_count > 0');
      const topDocs = await db.query(`
        SELECT hit_titles, COUNT(*) as cnt FROM knowledge_search_log
        WHERE hit_count > 0 GROUP BY hit_titles ORDER BY cnt DESC LIMIT 10
      `);
      const recent = await db.query(`
        SELECT query, hit_titles, hit_count, top_score, created_at
        FROM knowledge_search_log ORDER BY id DESC LIMIT 20
      `);
      db.sendJson(res, 200, {
        total: total?.c || 0,
        withHits: withHits?.c || 0,
        hitRate: total?.c > 0 ? ((withHits?.c / total?.c) * 100).toFixed(1) + '%' : 'N/A',
        topDocs,
        recent,
      });
    } catch (err) {
      logger.error('[knowledge-api] search-stats error:', err.message);
      db.sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  const getMatch = urlPath.match(/^\/api\/knowledge\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    try {
      const doc = await db.getKnowledgeDocById(getMatch[1]);
      if (!doc) {
        db.sendJson(res, 404, { error: 'Document not found' });
      } else {
        db.sendJson(res, 200, { doc });
      }
    } catch (err) {
      logger.error('[knowledge-api] get error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to get document' });
    }
    return true;
  }

  // ─── PATCH /api/knowledge/:id ───
  const patchMatch = urlPath.match(/^\/api\/knowledge\/([^/]+)$/);
  if (patchMatch && method === 'PATCH') {
    try {
      const body = await db.parseJsonBody(req);
      const doc = await db.updateKnowledgeDoc(patchMatch[1], body);
      if (!doc) {
        db.sendJson(res, 404, { error: 'Document not found' });
      } else {
        db.sendJson(res, 200, { doc });
      }
    } catch (err) {
      logger.error('[knowledge-api] update error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to update document' });
    }
    return true;
  }

  // ─── DELETE /api/knowledge/:id ───
  const deleteMatch = urlPath.match(/^\/api\/knowledge\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    try {
      // #8 RBAC: admin only can delete knowledge
      if (!hasPermission(user, 'knowledge.delete')) {
        denyAccess(res, db.sendJson, 'knowledge.delete', user.role);
        return true;
      }
      const doc = await db.getKnowledgeDocById(deleteMatch[1]);
      if (!doc) {
        db.sendJson(res, 404, { error: 'Document not found' });
        return true;
      }
      // Delete file from disk
      if (doc.filePath) {
        const fullPath = path.join(KNOWLEDGE_DIR, doc.filePath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
      await db.deleteKnowledgeDoc(deleteMatch[1]);
      db.sendJson(res, 200, { success: true });
    } catch (err) {
      logger.error('[knowledge-api] delete error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to delete document' });
    }
    return true;
  }

  // ─── POST /api/knowledge/:id/reference — Create reference ───
  const refMatch = urlPath.match(/^\/api\/knowledge\/([^/]+)\/reference$/);
  if (refMatch && method === 'POST') {
    try {
      const docId = refMatch[1];
      const body = await db.parseJsonBody(req);
      if (!body.messageId) {
        db.sendJson(res, 400, { error: 'messageId is required' });
        return true;
      }

      if (typeof db.createKnowledgeReference !== 'function') {
        db.sendJson(res, 500, { error: 'createKnowledgeReference not available on db object' });
        return true;
      }
      const ref = await db.createKnowledgeReference({
        messageId: body.messageId,
        knowledgeDocId: docId,
        snippet: body.snippet || ''
      });
      db.sendJson(res, 201, { reference: ref });
    } catch (err) {
      logger.error('[knowledge-api] create reference error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to create reference' });
    }
    return true;
  }

  // ─── GET /api/messages/:id/references — Get message references ───
  const msgRefMatch = urlPath.match(/^\/api\/messages\/([^/]+)\/references$/);
  if (msgRefMatch && method === 'GET') {
    try {
      const messageId = msgRefMatch[1];

      if (typeof db.getMessageReferences !== 'function') {
        db.sendJson(res, 500, { error: 'getMessageReferences not available on db object' });
        return true;
      }
      const refs = await db.getMessageReferences(messageId);
      db.sendJson(res, 200, { references: refs });
    } catch (err) {
      logger.error('[knowledge-api] get references error:', err.message);
      db.sendJson(res, 500, { error: 'Failed to get references' });
    }
    return true;
  }

  return false;
}
