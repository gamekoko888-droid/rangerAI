// TD-029: This file IS actively used by embedding-cache.mjs via worker_threads (line 71-73).
// It is NOT dead code — it runs cosine similarity calculations in a separate thread.
// Consumers: embedding-cache.mjs → new Worker("vector-worker.mjs")
/**
 * RangerAI Vector Worker — Offloads cosine similarity computation
 * to a separate thread to avoid blocking the main event loop.
 * 
 * Iter-16: Runs in worker_threads, receives search requests via
 * parentPort.postMessage, returns top-K results.
 */

import { parentPort } from 'worker_threads';

/**
 * Cosine similarity between two arrays (same as rag-utils.mjs).
 * Duplicated here to avoid importing modules in worker context.
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

parentPort.on('message', (msg) => {
  if (msg.type === 'search') {
    try {
      const { requestId, queryEmbedding, candidates, topK } = msg;
      
      // Convert arrays back to typed arrays for performance
      const qEmb = new Float32Array(queryEmbedding);
      
      // Compute cosine similarity for all candidates
      const scored = candidates.map(c => {
        const cEmb = new Float32Array(c.embedding);
        const score = cosineSimilarity(qEmb, cEmb);
        return {
          docId: c.docId,
          chunkIndex: c.chunkIndex,
          chunkText: c.chunkText,
          title: c.title,
          category: c.category,
          tags: c.tags,
          content: c.content,
          score,
        };
      });
      
      // Sort by similarity descending and return top-K
      scored.sort((a, b) => b.score - a.score);
      const results = scored.slice(0, topK);
      
      parentPort.postMessage({
        type: 'result',
        requestId,
        results,
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        requestId: msg.requestId,
        error: err.message,
      });
    }
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
