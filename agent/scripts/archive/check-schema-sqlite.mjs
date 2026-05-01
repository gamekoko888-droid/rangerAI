import { initAdapter, query } from './db-adapter.mjs';

async function checkSchema() {
  try {
    await initAdapter();
    const tables = await query("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('Tables:', JSON.stringify(tables, null, 2));
    
    for (const tableObj of tables) {
      const tableName = tableObj.name;
      const columns = await query(`PRAGMA table_info(${tableName})`);
      console.log(`Table ${tableName} Columns:`, JSON.stringify(columns, null, 2));
    }
  } catch (err) {
    console.error('Schema check failed:', err);
  } finally {
    process.exit(0);
  }
}

checkSchema();
