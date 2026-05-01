#!/usr/bin/env node
/**
 * backfill-sqlite.mjs — 为 SQLite 数据库中的知识文档补跑向量化
 * Usage: node scripts/backfill-sqlite.mjs [--dry-run] [--force]
 */

import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { chunkText, embeddingToBuffer, estimateTokens } from '../lib/rag-utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHUNK_MAX_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 128;

// 获取 OpenAI Key
function getApiKey() {
  try {
    const secrets = JSON.parse(readFileSync('./secrets.json', 'utf8'));
    return secrets.OPENAI_API_KEY;
  } catch {
    return process.env.OPENAI_API_KEY;
  }
}

// 调用 OpenAI Embeddings API
async function fetchEmbeddings(texts, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function main() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('未找到 OPENAI_API_KEY，请检查 secrets.json 或环境变量');

  const db = new Database('./rangerai.db');

  // 查询所有文档
  const allDocs = db.prepare('SELECT id, title, content FROM knowledge_docs WHERE content IS NOT NULL AND length(content) > 0').all();
  console.log(`\n共 ${allDocs.length} 篇文档`);

  // 查询已向量化的文档 ID
  const existingDocIds = new Set(
    db.prepare('SELECT DISTINCT docId FROM knowledge_embeddings').all().map(r => r.docId)
  );
  console.log(`已向量化: ${existingDocIds.size} 篇\n`);

  const insertStmt = db.prepare(
    'INSERT INTO knowledge_embeddings (id, docId, chunkIndex, chunkText, embedding) VALUES (?, ?, ?, ?, ?)'
  );
  const deleteStmt = db.prepare('DELETE FROM knowledge_embeddings WHERE docId = ?');

  let processedDocs = 0, skippedDocs = 0, totalChunks = 0, totalTokens = 0;

  for (const doc of allDocs) {
    // 跳过已向量化（除非 --force）
    if (existingDocIds.has(doc.id) && !FORCE) {
      console.log(`  ⏭ 跳过 [${doc.title}]（已向量化）`);
      skippedDocs++;
      continue;
    }

    const fullText = doc.content;
    const chunks = chunkText(fullText, { maxTokens: CHUNK_MAX_TOKENS, overlapTokens: CHUNK_OVERLAP_TOKENS });

    console.log(`  📄 [${doc.title}] → ${chunks.length} chunk(s), ~${estimateTokens(fullText)} tokens`);

    if (DRY_RUN) {
      totalChunks += chunks.length;
      totalTokens += estimateTokens(fullText);
      processedDocs++;
      continue;
    }

    if (FORCE && existingDocIds.has(doc.id)) {
      deleteStmt.run(doc.id);
      console.log(`     🗑 已删除旧 embeddings`);
    }

    // 分批嵌入（每批最多 20 个 chunk）
    const BATCH_SIZE = 20;
    for (let batchStart = 0; batchStart < chunks.length; batchStart += BATCH_SIZE) {
      const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);
      console.log(`     🔄 嵌入 batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)} (${batch.length} chunks)...`);

      const embeddings = await fetchEmbeddings(batch.map(c => c.text), apiKey);

      const insertMany = db.transaction(() => {
        for (let j = 0; j < embeddings.length; j++) {
          const chunk = batch[j];
          const embBuffer = embeddingToBuffer(embeddings[j]);
          insertStmt.run(randomUUID(), doc.id, chunk.index, chunk.text, embBuffer);
        }
      });
      insertMany();

      console.log(`     ✅ 存入 ${embeddings.length} 个 embeddings`);
      totalChunks += embeddings.length;
      totalTokens += batch.reduce((s, c) => s + c.tokenCount, 0);
    }

    processedDocs++;
  }

  // 汇总
  console.log('\n───────────────────────────────────────────');
  console.log(`  处理: ${processedDocs} 篇文档`);
  console.log(`  跳过: ${skippedDocs} 篇（已向量化）`);
  console.log(`  总 chunks: ${totalChunks}`);
  console.log(`  估计 tokens: ${totalTokens}`);
  if (!DRY_RUN) {
    const result = db.prepare('SELECT COUNT(DISTINCT docId) as cnt FROM knowledge_embeddings').get();
    console.log(`  向量化文档数（最终）: ${result.cnt}`);
  }
  console.log('═══════════════════════════════════════════');

  db.close();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
