import Database from 'better-sqlite3';

const db = new Database('/opt/rangerai-agent/rangerai.db');

// Check if role column already exists
const cols = db.pragma('table_info(invite_codes)').map(c => c.name);
console.log('Current columns:', cols);

if (cols.indexOf('role') === -1) {
  db.exec("ALTER TABLE invite_codes ADD COLUMN role TEXT DEFAULT 'member'");
  console.log('Added role column with default member');
} else {
  console.log('role column already exists');
}

// Verify
const newCols = db.pragma('table_info(invite_codes)');
console.log('Updated columns:', newCols.map(c => c.name + ':' + c.type));
db.close();
