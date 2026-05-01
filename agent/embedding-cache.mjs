/**
 * RangerAI Embedding Cache — In-process LRU cache for vector embeddings.
 * 
 * Iter-16: Eliminates full-table-scan on every vector search by keeping
 * embeddings in a Map<docId, chunks[]> with write-through invalidation.
 * 
 * Iter-51: DI-refactored — query function injected via init(), static import as fallback.
 * 
 * Design decisions (agreed with Ranger):
 *   - Warm from DB on startup (one-time SELECT ALL)
 *   - Sync update on embedDocumentAsync / deleteDocumentEmbeddings
 *   - TTL 1 hour for cold-data eviction (safety net)
 *   - Worker thread for cosine computation (see vector-worker.mjs)
 *
 * @version 2.0.0 — DI-refactored (Iter-51)
 */

import { logger } from './lib/logger.mjs';
import { Worker } from 'worker_threads';
import { bufferToEmbedding } from './lib/rag-utils.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

// ─── DI: injected query function (fallback to static import) ────────
import { query as _staticQuery } from './db-adapter.mjs';
let _injectedQuery = null;

/**
 * Initialize with injected dependencies.
 * @param {{ query: Function }} deps
 */
export function init(deps) {
  if (deps?.query) {
    _injectedQuery = deps.query;
    logger.info('[embedding-cache] DI initialized (using injected query)');
  }
}

/** Resolve query function: injected > static fallback */
function getQuery() {
  return _injectedQuery || _staticQuery;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Cache State ──────────────────────────────────────────────────────
/**
 * Map<docId, { chunks: [{chunkIndex, chunkText, embedding: Float32Array}], 
 *              meta: {title, category, tags, content}, 
 *              lastAccess: number }>
 */
const cache = new Map();
let warmed = false;
let warming = false;

// TTL: 1 hour (cold-data eviction)
const TTL_MS = 60 * 60 * 1000;

// Worker thread for cosine computation
let worker = null;
let workerReady = false;
let pendingRequests = new Map();
let requestId = 0;

// ─── Worker Management ───────────────────────────────────────────────

function ensureWorker() {
  if (worker && workerReady) return;
  
  const workerPath = path.join(__dirname, 'vector-worker.mjs');
  try {
    worker = new Worker(workerPath);
    
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        workerReady = true;
        logger.info('[embedding-cache] Worker thread ready');
      } else if (msg.type === 'result') {
        const resolve = pendingRequests.get(msg.requestId);
        if (resolve) {
          resolve.resolve(msg.results);
          pendingRequests.delete(msg.requestId);
        }
      } else if (msg.type === 'error') {
        const resolve = pendingRequests.get(msg.requestId);
        if (resolve) {
          resolve.reject(new Error(msg.error));
          pendingRequests.delete(msg.requestId);
        }
      }
    });
    
    worker.on('error', (err) => {
      logger.error('[embedding-cache] Worker error:', err.message);
      workerReady = false;
      worker = null;
    });
    
    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`[embedding-cache] Worker exited with code ${code}, will restart on next search`);
      }
      workerReady = false;
      worker = null;
      // Reject all pending requests
      for (const [id, { reject }] of pendingRequests) {
        reject(new Error('Worker exited'));
      }
      pendingRequests.clear();
    });
  } catch (err) {
    logger.error('[embedding-cache] Failed to create worker:', err.message);
    worker = null;
    workerReady = false;
  }
}

/**
 * Send cosine similarity computation to worker thread.
 * Falls back to main-thread computation if worker is unavailable.
 */
function computeInWorker(queryEmbedding, candidates, topK) {
  return new Promise((resolve, reject) => {
    ensureWorker();
    
    if (!worker || !workerReady) {
      // Fallback: compute on main thread (chunked with setImmediate)
      return resolve(computeMainThreadChunked(queryEmbedding, candidates, topK));
    }
    
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });
    
    // Transfer query embedding as SharedArrayBuffer-compatible data
    // Send candidates as serializable array
    const candidateData = candidates.map(c => ({
      docId: c.docId,
      chunkIndex: c.chunkIndex,
      chunkText: c.chunkText,
      title: c.title,
      category: c.category,
      tags: c.tags,
      content: c.content,
      // Convert Float32Array to regular array for transfer
      embedding: Array.from(c.embedding),
    }));
    
    worker.postMessage({
      type: 'search',
      requestId: id,
      queryEmbedding: Array.from(queryEmbedding),
      candidates: candidateData,
      topK,
    });
    
    // Timeout: 5 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Worker timeout'));
      }
    }, 5000);
  });
}

/**
 * Fallback: Main-thread chunked cosine computation.
 * Uses setImmediate to yield to event loop every 100 candidates.
 */
function computeMainThreadChunked(queryEmbedding, candidates, topK) {
  return new Promise((resolve) => {
    const results = [];
    const CHUNK_SIZE = 100;
    let idx = 0;
    
    function processChunk() {
      const end = Math.min(idx + CHUNK_SIZE, candidates.length);
      for (; idx < end; idx++) {
        const c = candidates[idx];
        let dot = 0, normA = 0, normB = 0;
        const emb = c.embedding;
        for (let i = 0; i < queryEmbedding.length; i++) {
          dot += queryEmbedding[i] * emb[i];
          normA += queryEmbedding[i] * queryEmbedding[i];
          normB += emb[i] * emb[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        const score = denom === 0 ? 0 : dot / denom;
        results.push({ ...c, score });
      }
      
      if (idx < candidates.length) {
        // Yield to event loop
        setImmediate(processChunk);
      } else {
        // Done — sort and return top-K
        results.sort((a, b) => b.score - a.score);
        resolve(results.slice(0, topK));
      }
    }
    
    processChunk();
  });
}

// ─── Cache Warm-up ───────────────────────────────────────────────────

/**
 * Warm cache from DB. Called once on startup.
 */
export async function warmCache() {
  if (warmed || warming) return;
  warming = true;
  
  try {
    const q = getQuery();
    const rows = await q(
      `SELECT e.id, e.docId, e.chunkIndex, e.chunkText, e.embedding,
              d.title, d.content, d.category, d.tags
       FROM knowledge_embeddings e
       JOIN knowledge_docs d ON d.id = e.docId
       WHERE d.isActive = 1`
    );
    
    if (!rows || rows.length === 0) {
      logger.info('[embedding-cache] No embeddings to warm');
      warmed = true;
      warming = false;
      return;
    }
    
    for (const row of rows) {
      const docId = row.docId;
      if (!cache.has(docId)) {
        cache.set(docId, {
          chunks: [],
          meta: {
            title: row.title,
            content: row.content,
            category: row.category,
            tags: row.tags,
          },
          lastAccess: Date.now(),
        });
      }
      
      const entry = cache.get(docId);
      entry.chunks.push({
        chunkIndex: row.chunkIndex,
        chunkText: row.chunkText,
        embedding: bufferToEmbedding(row.embedding),
      });
    }
    
    logger.info(`[embedding-cache] Warmed: ${cache.size} docs, ${rows.length} chunks`);
    warmed = true;
    
    // Initialize worker thread
    ensureWorker();
  } catch (err) {
    logger.error('[embedding-cache] Warm-up failed:', err.message);
  } finally {
    warming = false;
  }
}

// ─── Cache Write-Through ─────────────────────────────────────────────

/**
 * Update cache after embedDocumentAsync completes.
 * Called synchronously from knowledge-db.mjs after DB writes.
 */
export function cacheUpdateDoc(docId, chunks, meta) {
  cache.set(docId, {
    chunks, // [{chunkIndex, chunkText, embedding: Float32Array}]
    meta,   // {title, content, category, tags}
    lastAccess: Date.now(),
  });
}

/**
 * Remove doc from cache after deleteDocumentEmbeddings.
 */
export function cacheRemoveDoc(docId) {
  cache.delete(docId);
}

// ─── Cache Read ──────────────────────────────────────────────────────

/**
 * Get all cached embeddings, optionally filtered by category.
 * Returns flat array of {docId, chunkIndex, chunkText, embedding, title, category, tags, content}.
 */
export function getCachedEmbeddings(category = null) {
  const now = Date.now();
  const results = [];
  
  for (const [docId, entry] of cache) {
    // TTL eviction check
    if (now - entry.lastAccess > TTL_MS) {
      cache.delete(docId);
      continue;
    }
    
    // Category filter
    if (category && entry.meta.category !== category) continue;
    
    // Update access time
    entry.lastAccess = now;
    
    for (const chunk of entry.chunks) {
      results.push({
        docId,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        embedding: chunk.embedding,
        title: entry.meta.title,
        content: entry.meta.content,
        category: entry.meta.category,
        tags: entry.meta.tags,
      });
    }
  }
  
  return results;
}

/**
 * Vector search using cache + worker thread.
 * Drop-in replacement for the old searchKnowledgeVector.
 */
export async function cachedVectorSearch(queryEmbedding, category = null, limit = 10) {
  // Ensure cache is warm
  if (!warmed) await warmCache();
  
  const candidates = getCachedEmbeddings(category);
  if (candidates.length === 0) return [];
  
  // Delegate cosine computation to worker thread
  try {
    const results = await computeInWorker(queryEmbedding, candidates, limit);
    return results.map(r => ({
      id: r.docId,
      embId: null,
      docId: r.docId,
      chunkIndex: r.chunkIndex,
      chunkText: r.chunkText,
      title: r.title,
      content: r.content,
      category: r.category,
      tags: r.tags,
      score: r.score,
    }));
  } catch (err) {
    logger.error('[embedding-cache] Search failed, falling back to DB:', err.message);
    // Return empty — caller (searchKnowledgeHybrid) handles graceful degradation
    return [];
  }
}

/**
 * Get cache stats for monitoring.
 */
export function getCacheStats() {
  let totalChunks = 0;
  for (const entry of cache.values()) {
    totalChunks += entry.chunks.length;
  }
  return {
    docs: cache.size,
    chunks: totalChunks,
    warmed,
    workerReady,
    diActive: !!_injectedQuery,
    estimatedMemoryMB: (totalChunks * 1536 * 4 / 1024 / 1024).toFixed(2),
  };
}
