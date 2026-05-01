import { query } from './db-adapter.mjs';

async function checkSchema() {
  try {
    const tables = await query('SHOW TABLES');
    console.log('Tables:', JSON.stringify(tables, null, 2));
    
    for (const tableObj of tables) {
      const tableName = Object.values(tableObj)[0];
      const columns = await query(`DESCRIBE ${tableName}`);
      console.log(`Table ${tableName} Columns:`, JSON.stringify(columns, null, 2));
    }
  } catch (err) {
    console.error('Schema check failed:', err);
  } finally {
    process.exit(0);
  }
}

checkSchema();
