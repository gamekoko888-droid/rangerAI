import { initAdapter, query, queryOne, run, exec, isMySQL } from './db-adapter.mjs';
import { init as initKnowledgeDb, embedDocumentAsync } from './knowledge-db.mjs';

async function main() {
  // Initialize DB adapter
  await initAdapter({ dbPath: '/opt/rangerai-agent/rangerai.db' });
  
  // Initialize knowledge-db with DI
  initKnowledgeDb({
    q: query,
    qo: queryOne,
    r: run,
    exec: exec,
    isMy: isMySQL,
  });
  
  const docIds = [
    'r30-game-topup-001', 'r30-kol-001', 'r30-cs-001',
    'r30-analysis-001', 'r30-tiktok-001', 'r30-research-001', 'r30-creative-001'
  ];
  
  for (const docId of docIds) {
    console.log('Embedding: ' + docId);
    try {
      const rows = await query('SELECT content FROM knowledge_docs WHERE id = ?', [docId]);
      if (rows && rows.length > 0) {
        await embedDocumentAsync(docId, rows[0].content);
        console.log('  OK: ' + docId);
      } else {
        console.log('  NOT FOUND: ' + docId);
      }
    } catch (e) {
      console.error('  ERROR: ' + docId + ': ' + e.message);
    }
  }
  
  // Check results
  const results = await query("SELECT docId, COUNT(*) as chunks FROM knowledge_embeddings WHERE docId LIKE 'r30-%' GROUP BY docId");
  console.log('\nEmbedding results:', JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
