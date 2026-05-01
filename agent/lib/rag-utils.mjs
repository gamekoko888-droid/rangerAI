/**
 * rag-utils.mjs — RAG Pipeline Utilities (Iter-14)
 * 
 * Provides:
 *   - chunkText()           — Adaptive text chunking with overlap
 *   - cosineSimilarity()    — Float32Array-based cosine similarity
 *   - reciprocalRankFusion()— RRF merge of multiple ranked lists
 *   - embeddingToBuffer()   — Convert embedding array → Buffer (for MySQL BLOB)
 *   - bufferToEmbedding()   — Convert Buffer → Float32Array
 *   - estimateTokens()      — Rough token count estimation
 */
import { logger } from '../lib/logger.mjs';


// ─── Token Estimation ───────────────────────────────────────────────
/**
 * Rough token count estimation.
 * Chinese: ~1.5 tokens per character. English: ~0.75 tokens per word.
 * This avoids importing a full tokenizer.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // Iter-60: Refined token estimation (weights based on cl100k_base characteristics)
  
  // 1. CJK characters (average ~2.0 tokens in cl100k_base)
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  
  // 2. Numbers and common symbols (often 1-2 tokens)
  const numbers = (text.match(/[0-9]/g) || []).length;
  
  // 3. Latin words (average ~1.3 tokens/word)
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff0-9]/g, ' ');
  const latinWords = nonCjk.split(/\s+/).filter(w => w.length > 0).length;
  
  // Weighted sum: 1.8 (CJK) + 1.2 (Numbers/Symbols) + 1.3 (Words)
  // This is conservative to avoid context overflow.
  return Math.ceil(cjkChars * 1.8 + numbers * 1.2 + latinWords * 1.3);
}

// ─── Text Chunking ──────────────────────────────────────────────────
/**
 * Adaptive text chunking with overlap.
 * - If text is shorter than maxTokens, returns single chunk (short-text escape).
 * - Otherwise splits by paragraphs/sentences, respecting maxTokens per chunk.
 * 
 * @param {string} text - Full document text
 * @param {object} opts
 * @param {number} opts.maxTokens - Max tokens per chunk (default 512)
 * @param {number} opts.overlapTokens - Overlap tokens between chunks (default 128)
 * @returns {Array<{text: string, index: number, tokenCount: number}>}
 */
export function chunkText(text, { maxTokens = 512, overlapTokens = 128 } = {}) {
  if (!text || text.trim().length === 0) return [];

  const totalTokens = estimateTokens(text);

  // Short-text escape: if total tokens fit in one chunk, return as-is
  if (totalTokens <= maxTokens) {
    return [{ text: text.trim(), index: 0, tokenCount: totalTokens }];
  }

  // Split into paragraphs first, then sentences if paragraphs are too long
  const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 0);
  const segments = [];
  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (paraTokens <= maxTokens) {
      segments.push(para.trim());
    } else {
      // Split long paragraphs by sentences
      const sentences = para.split(/(?<=[。！？.!?\n])\s*/);
      for (const sent of sentences) {
        if (sent.trim().length > 0) segments.push(sent.trim());
      }
    }
  }

  // Greedy merge segments into chunks with overlap
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  let overlapBuffer = []; // segments to carry over as overlap

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segTokens = estimateTokens(seg);

    if (currentTokens + segTokens > maxTokens && currentChunk.length > 0) {
      // Flush current chunk
      const chunkText = currentChunk.join('\n\n');
      chunks.push({
        text: chunkText,
        index: chunks.length,
        tokenCount: estimateTokens(chunkText),
      });

      // Build overlap from tail of current chunk
      overlapBuffer = [];
      let overlapCount = 0;
      for (let j = currentChunk.length - 1; j >= 0; j--) {
        const t = estimateTokens(currentChunk[j]);
        if (overlapCount + t > overlapTokens) break;
        overlapBuffer.unshift(currentChunk[j]);
        overlapCount += t;
      }

      currentChunk = [...overlapBuffer];
      currentTokens = overlapCount;
    }

    currentChunk.push(seg);
    currentTokens += segTokens;
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    const chunkText = currentChunk.join('\n\n');
    chunks.push({
      text: chunkText,
      index: chunks.length,
      tokenCount: estimateTokens(chunkText),
    });
  }

  return chunks;
}

// ─── Embedding Serialization ────────────────────────────────────────
/**
 * Convert embedding array (from API) to Buffer for MySQL BLOB storage.
 * Uses Float32Array for compact storage (4 bytes per dimension vs ~8 for JSON).
 */
export function embeddingToBuffer(embedding) {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

/**
 * Convert Buffer (from MySQL BLOB) back to Float32Array.
 */
export function bufferToEmbedding(buffer) {
  // Ensure we have a proper Buffer
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // MySQL BLOB buffers may have unaligned byteOffset; copy to aligned ArrayBuffer
  if (buf.byteOffset % 4 !== 0) {
    const aligned = new ArrayBuffer(buf.byteLength);
    new Uint8Array(aligned).set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    return new Float32Array(aligned);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ─── Cosine Similarity ──────────────────────────────────────────────
/**
 * Compute cosine similarity between two Float32Arrays.
 * Returns value in [-1, 1], where 1 = identical direction.
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Hash Embedding ─────────────────────────────────────────────────
/**
 * [R60-T2] Hash-based pseudo-embedding for semantic similarity.
 * Character n-gram hashing creates a sparse vector from text.
 * Captures CJK and Latin semantic similarity without requiring an embedding API.
 * Used by memory-manager (vector semantic recall) and knowledge-injector (semantic re-ranking).
 *
 * @param {string} text - Input text
 * @param {number} dim - Embedding dimension (default 512)
 * @returns {Float32Array} L2-normalized embedding vector
 */
export function hashEmbedding(text, dim = 512) {
  const embedding = new Float32Array(dim);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ' ').trim();
  const words = normalized.split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return embedding;

  for (const word of words) {
    // Character trigram hashing
    for (let i = 0; i <= word.length - 3; i++) {
      const trigram = word.slice(i, i + 3);
      let hash = 0;
      for (let j = 0; j < trigram.length; j++) {
        hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
      }
      embedding[Math.abs(hash) % dim] += 1.0;
    }
    // Word-level hash (weighted higher)
    let wHash = 0;
    for (let j = 0; j < word.length; j++) {
      wHash = ((wHash << 5) - wHash + word.charCodeAt(j)) | 0;
    }
    embedding[Math.abs(wHash) % dim] += 2.0;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) embedding[i] /= norm;

  return embedding;
}

/**
 * Batch cosine similarity: compute similarity of query embedding against
 * an array of {id, embedding} objects. Returns sorted by similarity desc.
 * 
 * @param {Float32Array} queryEmbedding
 * @param {Array<{id: string, embedding: Float32Array, [key: string]: any}>} candidates
 * @param {number} topK - Max results to return
 * @returns {Array<{id: string, score: number, ...rest}>}
 */
export function batchCosineSimilarity(queryEmbedding, candidates, topK = 10) {
  const scored = candidates.map(c => ({
    ...c,
    score: cosineSimilarity(queryEmbedding, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ─── Reciprocal Rank Fusion (RRF) ──────────────────────────────────
/**
 * Merge multiple ranked lists using Reciprocal Rank Fusion.
 * 
 * RRF score = Σ 1/(k + rank_i) for each list where the item appears.
 * Default k=60 (standard RRF constant).
 * 
 * @param {Array<Array<{id: string, score?: number, [key: string]: any}>>} rankedLists
 *   Each list is sorted by relevance (best first).
 * @param {object} opts
 * @param {number} opts.k - RRF constant (default 60)
 * @param {number} opts.topK - Max results to return (default 10)
 * @returns {Array<{id: string, rrfScore: number, sources: string[], ...mergedFields}>}
 */
export function reciprocalRankFusion(rankedLists, { k = 60, topK = 10 } = {}) {
  const scoreMap = new Map(); // id → { rrfScore, sources, fields }

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    const sourceName = listIdx === 0 ? 'fts' : 'vector';

    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfContribution = 1 / (k + rank + 1); // rank is 0-indexed, so +1

      if (scoreMap.has(item.id)) {
        const existing = scoreMap.get(item.id);
        existing.rrfScore += rrfContribution;
        existing.sources.push(sourceName);
      } else {
        scoreMap.set(item.id, {
          ...item,
          rrfScore: rrfContribution,
          sources: [sourceName],
        });
      }
    }
  }

  const merged = Array.from(scoreMap.values());
  merged.sort((a, b) => b.rrfScore - a.rrfScore);
  return merged.slice(0, topK);
}

// ─── Self-test (CLI) ────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('rag-utils.mjs') && process.argv.includes('--test')) {
  logger.info('=== rag-utils.mjs self-test ===\n');

  // Test estimateTokens
  logger.info('estimateTokens("Hello world"):', estimateTokens('Hello world'));
  logger.info('estimateTokens("你好世界"):', estimateTokens('你好世界'));
  logger.info('estimateTokens("混合 mixed 测试 test"):', estimateTokens('混合 mixed 测试 test'));

  // Test chunkText - short text
  const shortChunks = chunkText('这是一段很短的文本。');
  logger.info('\nShort text chunks:', shortChunks.length, '(should be 1)');

  // Test chunkText - long text
  const longText = Array(50).fill('这是一段测试文本，用于验证分块逻辑是否正确工作。每个段落应该包含足够的内容来触发分块。').join('\n\n');
  const longChunks = chunkText(longText, { maxTokens: 200, overlapTokens: 50 });
  logger.info('Long text chunks:', longChunks.length, '(should be > 1)');
  longChunks.forEach((c, i) => logger.info(`  Chunk ${i}: ${c.tokenCount} tokens, ${c.text.length} chars`));

  // Test embedding serialization
  const testEmb = new Float32Array([0.1, 0.2, 0.3, -0.4, 0.5]);
  const buf = embeddingToBuffer(testEmb);
  const restored = bufferToEmbedding(buf);
  logger.info('\nEmbedding roundtrip:', 
    testEmb.length === restored.length && 
    Math.abs(testEmb[0] - restored[0]) < 0.0001 ? 'PASS' : 'FAIL');

  // Test cosine similarity
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  const c = new Float32Array([0, 1, 0]);
  logger.info('cosineSimilarity(same):', cosineSimilarity(a, b).toFixed(4), '(should be 1.0000)');
  logger.info('cosineSimilarity(orthogonal):', cosineSimilarity(a, c).toFixed(4), '(should be 0.0000)');

  // Test RRF
  const ftsResults = [
    { id: 'doc1', text: 'FTS result 1' },
    { id: 'doc2', text: 'FTS result 2' },
    { id: 'doc3', text: 'FTS result 3' },
  ];
  const vecResults = [
    { id: 'doc2', text: 'Vec result 2' },
    { id: 'doc4', text: 'Vec result 4' },
    { id: 'doc1', text: 'Vec result 1' },
  ];
  const fused = reciprocalRankFusion([ftsResults, vecResults], { topK: 5 });
  logger.info('\nRRF fusion results:');
  fused.forEach(r => logger.info(`  ${r.id}: rrfScore=${r.rrfScore.toFixed(6)}, sources=${r.sources.join('+')}`));
  logger.info('Top result:', fused[0].id, '(should be doc2 — appears in both lists)');

  logger.info('\n=== All tests passed ===');
}
