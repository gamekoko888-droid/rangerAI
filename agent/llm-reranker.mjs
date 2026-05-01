/**
 * llm-reranker.mjs — LLM-based reranking for RAG results
 * Uses the existing smart-router LLM to score relevance of search results.
 * Fallback: if LLM unavailable, returns results unchanged.
 */
import { logger } from './lib/logger.mjs';

const RERANK_TIMEOUT = 8000; // 8s max for reranking
const MAX_RERANK_DOCS = 10;  // Only rerank top N candidates

/**
 * Rerank search results using LLM scoring.
 * @param {string} query - User query
 * @param {Array} docs - Search results with {id, title, content, score}
 * @param {number} topK - Number of results to return
 * @returns {Array} Reranked results with added relevanceScore
 */
export async function llmRerank(query, docs, topK = 5) {
  if (!docs || docs.length <= 1) return docs;
  
  // Only rerank top candidates to save LLM calls
  const candidates = docs.slice(0, MAX_RERANK_DOCS);
  
  try {
    // Build scoring prompt
    const docList = candidates.map((d, i) => 
      `[${i + 1}] ${d.title || 'Untitled'}\n${(d.content || d.chunkText || '').slice(0, 300)}`
    ).join('\n\n');
    
    const prompt = `You are a relevance scoring assistant. Given a user query and a list of documents, score each document's relevance to the query on a scale of 0-10.

Query: "${query}"

Documents:
${docList}

Return ONLY a JSON array of scores in order, e.g. [8, 3, 7, ...]. No explanation needed.`;

    // Use internal HTTP call to smart-router LLM
    const response = await fetchLLM(prompt);
    
    if (!response) {
      logger.warn('[reranker] LLM response empty, returning original order');
      return docs.slice(0, topK);
    }
    
    // Parse scores
    const scoreMatch = response.match(/\[[\d,\s.]+\]/);
    if (!scoreMatch) {
      logger.warn('[reranker] Could not parse scores from LLM response');
      return docs.slice(0, topK);
    }
    
    const scores = JSON.parse(scoreMatch[0]);
    
    // Attach scores and sort
    const scored = candidates.map((doc, i) => ({
      ...doc,
      llmRelevance: scores[i] || 0,
      // Combine RRF score with LLM relevance (weighted)
      combinedScore: (doc.rrfScore || doc.score || 0) * 0.3 + (scores[i] || 0) / 10 * 0.7
    }));
    
    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    
    logger.info(`[reranker] Reranked ${candidates.length} docs, scores: [${scores.slice(0, 5).join(',')}]`);
    
    return scored.slice(0, topK);
  } catch (err) {
    logger.warn(`[reranker] LLM rerank failed: ${err.message}, returning original order`);
    return docs.slice(0, topK);
  }
}

/**
 * Call LLM via internal API
 */
async function fetchLLM(prompt) {
  const http = (await import('http')).default;
  
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 200
    });
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3002,
      path: '/api/llm/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-call': '1',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content || parsed?.content || data;
          resolve(content);
        } catch {
          resolve(data);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(RERANK_TIMEOUT, () => { req.destroy(); reject(new Error('rerank timeout')); });
    req.write(body);
    req.end();
  });
}

export default { llmRerank };
