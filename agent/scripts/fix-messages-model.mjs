/**
 * P0-2 修复脚本：从 event_stream 回填 messages.model
 * 策略：
 *   1. 从 db/rangerai.db 的 event_stream 取 model_route 事件（task_id = msgId）
 *   2. 过滤掉 task-session_xxx 格式（非 msgId）
 *   3. 用 model_route 中的 model 字段 UPDATE 主库 messages 表
 *   4. 顺带从 token_cost_log 回填 tokens（如有）
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DB = path.resolve(__dirname, '../rangerai.db');
const AUX_DB  = path.resolve(__dirname, '../db/rangerai.db');

const main = new Database(MAIN_DB, { readonly: false });
const aux  = new Database(AUX_DB,  { readonly: true });

main.pragma('journal_mode = WAL');
main.pragma('busy_timeout = 5000');

// --- Step 1: 取 model_route 事件，按 msgId 聚合最新一条 model ---
const routes = aux.prepare(`
  SELECT task_id AS msgId,
         json_extract(payload, '$.model') AS model,
         MAX(created_at) AS ts
  FROM event_stream
  WHERE event_type = 'model_route'
    AND task_id LIKE 'msg-%'
    AND json_extract(payload, '$.model') IS NOT NULL
    AND json_extract(payload, '$.model') != ''
  GROUP BY task_id
`).all();

console.log(`[fix-model] model_route events found: ${routes.length}`);

// --- Step 2: 批量 UPDATE ---
const updateModel = main.prepare(`
  UPDATE messages
  SET model = ?
  WHERE msgId = ?
    AND role = 'assistant'
    AND (model IS NULL OR model = '' OR model = 'unknown')
`);

let updated = 0;
let skipped = 0;

const doUpdate = main.transaction(() => {
  for (const row of routes) {
    const result = updateModel.run(row.model, row.msgId);
    if (result.changes > 0) {
      updated++;
    } else {
      skipped++;
    }
  }
});

doUpdate();

console.log(`[fix-model] Updated: ${updated}, Skipped (already set or no match): ${skipped}`);

// --- Step 3: 验证 ---
const stats = main.prepare(`
  SELECT
    count(*) AS total,
    count(model) AS has_model,
    sum(CASE WHEN model IS NULL OR model = '' THEN 1 ELSE 0 END) AS null_model
  FROM messages
  WHERE role = 'assistant'
`).get();

console.log(`[fix-model] Verification — assistant messages: total=${stats.total}, has_model=${stats.has_model}, null_model=${stats.null_model}`);

// --- Step 4: 显示最新 10 条结果 ---
const sample = main.prepare(`
  SELECT msgId, model, tokens, createdAt
  FROM messages
  WHERE role = 'assistant'
  ORDER BY createdAt DESC
  LIMIT 10
`).all();

console.log('\n[fix-model] Latest 10 assistant messages:');
for (const row of sample) {
  console.log(`  ${row.createdAt} | ${row.msgId} | model=${row.model || 'NULL'} | tokens=${row.tokens || 'NULL'}`);
}

main.close();
aux.close();
console.log('[fix-model] Done.');
