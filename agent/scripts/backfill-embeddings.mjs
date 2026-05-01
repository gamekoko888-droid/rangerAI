#!/usr/bin/env node
/**
 * backfill-embeddings.mjs — Vectorize all existing knowledge docs (Iter-14)
 * 
 * Usage:
 *   node scripts/backfill-embeddings.mjs [--dry-run] [--force]
 * 
 * --dry-run: Show what would be done without writing to DB
 * --force:   Re-embed all docs even if embeddings already exist
 */

import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import mysql2 from 'mysql2/promise';

// Import rag-utils from lib/
import { chunkText, embeddingToBuffer, estimateTokens } from '../lib/rag-utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// ─── Config ─────────────────────────────────────────────────────────
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const CHUNK_MAX_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 128;
const BATCH_SIZE = 20; // OpenAI supports up to 2048 inputs per request

// ─── Database ───────────────────────────────────────────────────────
function getDbConfig() {
  const mysqlPwd = process.env.MYSQL_ROOT_PASSWORD || 'RangerAI2026!';
  return { host: '127.0.0.1', port: 3306, user: 'root', password: mysqlPwd, database: 'rangerai' };
}

// ─── OpenAI Embeddings ──────────────────────────────────────────────
function getApiKey() {
  try {
    const secrets = JSON.parse(readFileSync('secrets.json', 'utf8'));
    return secrets.OPENAI_API_KEY;
  } catch {
    return process.env.OPENAI_API_KEY;
  }
}

async function fetchEmbeddings(texts, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.data.map(d => d.embedding);
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  RangerAI Knowledge Embedding Backfill');
  console.log('═══════════════════════════════════════════');
  console.log(`  Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`  Force: ${FORCE}`);
  console.log(`  Model: ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS}d)`);
  console.log(`  Chunking: ${CHUNK_MAX_TOKENS} tokens / ${CHUNK_OVERLAP_TOKENS} overlap`);
  console.log('');

  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('ERROR: No OPENAI_API_KEY found in secrets.json or environment');
    process.exit(1);
  }

  const conn = await mysql2.createConnection(getDbConfig());

  try {
    // Get all active knowledge docs
    const [docs] = await conn.execute(
      'SELECT id, title, content, category, tags FROM knowledge_docs WHERE isActive = 1 ORDER BY createdAt'
    );
    console.log(`Found ${docs.length} active knowledge documents\n`);

    if (docs.length === 0) {
      console.log('No documents to process.');
      return;
    }

    // Check existing embeddings
    const [existing] = await conn.execute(
      'SELECT DISTINCT docId FROM knowledge_embeddings'
    );
    const existingDocIds = new Set(existing.map(r => r.docId));

    let totalChunks = 0;
    let totalTokens = 0;
    let skippedDocs = 0;
    let processedDocs = 0;

    for (const doc of docs) {
      // Skip if already embedded (unless --force)
      if (!FORCE && existingDocIds.has(doc.id)) {
        console.log(`  ⏭ [${doc.title}] Already embedded, skipping`);
        skippedDocs++;
        continue;
      }

      // Combine title + content for richer embedding
      const fullText = `${doc.title}\n\n${doc.content || ''}`.trim();
      const chunks = chunkText(fullText, {
        maxTokens: CHUNK_MAX_TOKENS,
        overlapTokens: CHUNK_OVERLAP_TOKENS,
      });

      console.log(`  📄 [${doc.title}] ${chunks.length} chunk(s), ${estimateTokens(fullText)} est. tokens`);

      if (DRY_RUN) {
        chunks.forEach((c, i) => {
          console.log(`     Chunk ${i}: ${c.tokenCount} tokens, ${c.text.length} chars`);
        });
        totalChunks += chunks.length;
        totalTokens += chunks.reduce((sum, c) => sum + c.tokenCount, 0);
        processedDocs++;
        continue;
      }

      // Delete old embeddings for this doc (if --force)
      if (FORCE && existingDocIds.has(doc.id)) {
        await conn.execute('DELETE FROM knowledge_embeddings WHERE docId = ?', [doc.id]);
        console.log(`     🗑 Deleted old embeddings`);
      }

      // Batch embed chunks
      const chunkTexts = chunks.map(c => c.text);
      for (let batchStart = 0; batchStart < chunkTexts.length; batchStart += BATCH_SIZE) {
        const batch = chunkTexts.slice(batchStart, batchStart + BATCH_SIZE);
        const batchChunks = chunks.slice(batchStart, batchStart + BATCH_SIZE);

        console.log(`     🔄 Embedding batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(chunkTexts.length / BATCH_SIZE)} (${batch.length} chunks)...`);

        const embeddings = await fetchEmbeddings(batch, apiKey);

        // Insert into MySQL
        for (let j = 0; j < embeddings.length; j++) {
          const chunk = batchChunks[j];
          const embBuffer = embeddingToBuffer(embeddings[j]);

          await conn.execute(
            `INSERT INTO knowledge_embeddings (id, docId, chunkIndex, chunkText, embedding, model, dimensions, tokenCount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              randomUUID(),
              doc.id,
              chunk.index,
              chunk.text,
              embBuffer,
              EMBEDDING_MODEL,
              EMBEDDING_DIMENSIONS,
              chunk.tokenCount,
            ]
          );
        }

        console.log(`     ✅ Stored ${embeddings.length} embeddings`);
        totalChunks += embeddings.length;
        totalTokens += batchChunks.reduce((sum, c) => sum + c.tokenCount, 0);
      }

      processedDocs++;
    }

    // Summary
    console.log('\n───────────────────────────────────────────');
    console.log(`  Processed: ${processedDocs} docs`);
    console.log(`  Skipped: ${skippedDocs} docs (already embedded)`);
    console.log(`  Total chunks: ${totalChunks}`);
    console.log(`  Total est. tokens: ${totalTokens}`);
    if (!DRY_RUN) {
      const [count] = await conn.execute('SELECT COUNT(*) as cnt FROM knowledge_embeddings');
      console.log(`  Embeddings in DB: ${count[0].cnt}`);
    }
    console.log('═══════════════════════════════════════════');

  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
