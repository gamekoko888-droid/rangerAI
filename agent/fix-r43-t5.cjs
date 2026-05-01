// R43-T5: Knowledge scope refinement - sub-scopes + relevance_weight
const Database = require('better-sqlite3');
const fs = require('fs');

const dbPath = '/opt/rangerai-agent/db/rangerai.db';
const db = new Database(dbPath);

// === 1. Add relevance_weight column ===
try {
  db.exec('ALTER TABLE knowledge_entries ADD COLUMN relevance_weight REAL NOT NULL DEFAULT 0.8');
  console.log('✅ Added relevance_weight column');
} catch (e) {
  if (e.message.includes('duplicate column')) {
    console.log('ℹ️ relevance_weight column already exists');
  } else {
    console.log('❌ ALTER TABLE failed:', e.message);
  }
}

// === 2. Update existing entries with appropriate weights and sub-scopes ===
const updates = [
  // System/core entries - high weight
  { id: 1, weight: 0.95, scope: 'general' },
  { id: 6, weight: 0.95, scope: 'general' },
  // Capability entries - high weight
  { id: 2, weight: 0.85, scope: 'general,code' },
  { id: 7, weight: 0.85, scope: 'general,code' },
  { id: 3, weight: 0.85, scope: 'general,operations' },
  { id: 8, weight: 0.85, scope: 'general,operations' },
  // Workflow entries - medium weight
  { id: 4, weight: 0.75, scope: 'kol,creative' },
  { id: 9, weight: 0.75, scope: 'kol,creative' },
  { id: 5, weight: 0.80, scope: 'analysis,research' },
  { id: 10, weight: 0.80, scope: 'analysis,research' },
  // Game topup - high weight with sub-scopes
  { id: 11, weight: 0.90, scope: 'game-topup,game-topup.pubg,game-topup.freefire,customer-service' },
  { id: 18, weight: 0.90, scope: 'game-topup,game-topup.pubg,game-topup.freefire,customer-service' },
  // KOL - high weight
  { id: 12, weight: 0.90, scope: 'kol,creative,game-topup.marketing' },
  // Customer service - high weight
  { id: 13, weight: 0.90, scope: 'customer-service,game-topup.support' },
  // Analysis - medium weight
  { id: 14, weight: 0.80, scope: 'analysis,research' },
  // Operations - medium weight
  { id: 15, weight: 0.75, scope: 'operations,code' },
  // Research - medium weight
  { id: 16, weight: 0.80, scope: 'research,analysis' },
  // Creative - medium weight
  { id: 17, weight: 0.75, scope: 'creative,kol' },
];

const updateStmt = db.prepare('UPDATE knowledge_entries SET relevance_weight = ?, scope = ? WHERE id = ?');
for (const u of updates) {
  updateStmt.run(u.weight, u.scope, u.id);
}
console.log('✅ Updated weights and sub-scopes for', updates.length, 'entries');

// Verify
const entries = db.prepare('SELECT id, scope, relevance_weight FROM knowledge_entries ORDER BY id').all();
console.log('\n=== Updated entries ===');
entries.forEach(e => console.log(`  id=${e.id} weight=${e.relevance_weight} scope=${e.scope}`));

db.close();

// === 3. Update knowledge-injector.mjs to filter by weight ===
const kiPath = '/opt/rangerai-agent/worker/knowledge-injector.mjs';
let code = fs.readFileSync(kiPath, 'utf8');

// Update the SQL query to include relevance_weight
const oldQuery = "'SELECT category, title, content, priority, scope FROM knowledge_entries WHERE active = 1 ORDER BY priority DESC, updated_at DESC LIMIT 30'";
const newQuery = "'SELECT category, title, content, priority, scope, relevance_weight FROM knowledge_entries WHERE active = 1 ORDER BY priority DESC, updated_at DESC LIMIT 30'";
if (code.includes(oldQuery)) {
  code = code.replace(oldQuery, newQuery);
  console.log('\n✅ Updated SQL query to include relevance_weight');
}

// Add weight filtering after scope filtering
const oldFilterLog = "logger.info(`[${ts()}] [R42-T5] Knowledge scope filter: requested=${scopes ? scopes.join(',') : 'all'} total=${entries.length} filtered=${filtered.length}`);";
const newFilterLog = `// [R43-T5] Apply relevance_weight filter (>= 0.5)
    const weightFiltered = filtered.filter(e => (e.relevance_weight || 0.8) >= 0.5);
    logger.info(\`[\${ts()}] [R43-T5] Knowledge filter: requested=\${scopes ? scopes.join(',') : 'all'} total=\${entries.length} scopeFiltered=\${filtered.length} weightFiltered=\${weightFiltered.length}\`);
    const filtered_final = weightFiltered;`;

if (code.includes(oldFilterLog)) {
  code = code.replace(oldFilterLog, newFilterLog);
  // Replace subsequent references to 'filtered' with 'filtered_final'
  // But only in the getKnowledgeBaseBlock function scope
  // The next reference is: if (!filtered || filtered.length === 0)
  code = code.replace(
    'if (!filtered || filtered.length === 0) {',
    'if (!filtered_final || filtered_final.length === 0) {'
  );
  // And: for (const e of filtered)
  code = code.replace(
    'for (const e of filtered) {',
    'for (const e of filtered_final) {'
  );
  console.log('✅ Added weight filtering to getKnowledgeBaseBlock');
}

// === 4. Update knowledge_injected event to include weight info ===
// Find the knowledge_injected emitEvent in the code
const oldKIEvent = "scope: _r42Scopes ? _r42Scopes.join(',') : 'all',";
const newKIEvent = "scope: _r42Scopes ? _r42Scopes.join(',') : 'all',\n          weightThreshold: 0.5,";
if (code.includes(oldKIEvent)) {
  code = code.replace(oldKIEvent, newKIEvent);
  console.log('✅ Added weightThreshold to knowledge_injected event');
}

// Also add sub-scope matching support
// Update scope matching to support sub-scopes (e.g., game-topup.pubg matches game-topup)
const oldScopeMatch = "return entryScopes.some(es => es === 'general' || scopes.includes(es));";
const newScopeMatch = `return entryScopes.some(es => {
            if (es === 'general') return true;
            if (scopes.includes(es)) return true;
            // [R43-T5] Sub-scope matching: game-topup.pubg matches game-topup
            const parentScope = es.split('.')[0];
            if (parentScope !== es && scopes.includes(parentScope)) return true;
            // Also check if any requested scope is a sub-scope of entry scope
            return scopes.some(rs => rs.startsWith(es + '.'));
          });`;
if (code.includes(oldScopeMatch)) {
  code = code.replace(oldScopeMatch, newScopeMatch);
  console.log('✅ Added sub-scope matching support');
}

fs.writeFileSync(kiPath, code);

// Verify
const final = fs.readFileSync(kiPath, 'utf8');
console.log('\n=== Final verification ===');
console.log('Has relevance_weight in query:', final.includes('relevance_weight'));
console.log('Has weight filter:', final.includes('weightFiltered'));
console.log('Has sub-scope matching:', final.includes('parentScope'));
console.log('Has weightThreshold in event:', final.includes('weightThreshold'));
