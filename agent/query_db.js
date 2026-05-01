const Database = require('better-sqlite3');
const db = new Database('db/rangerai.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));
const msgs = tables.find(t => t.name === 'messages' || t.name === 'message');
if (msgs) {
  const cols = db.pragma('table_info(' + msgs.name + ')');
  console.log("Cols:", cols.map(c => c.name).join(", "));
  const recent = db.prepare('SELECT * FROM ' + msgs.name + ' ORDER BY rowid DESC LIMIT 5').all();
  recent.forEach(r => {
    console.log("---");
    for (const [k,v] of Object.entries(r)) {
      const s = typeof v === 'string' && v.length > 150 ? v.substring(0,150)+'...' : v;
      console.log(k + ': ' + s);
    }
  });
}
