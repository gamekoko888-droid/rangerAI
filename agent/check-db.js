const Database = require('better-sqlite3');
const db = new Database('./db/rangerai.db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));

try {
  const cols = db.prepare("PRAGMA table_info(messages)").all();
  console.log("messages cols:", cols.map(c => c.name).join(", "));
  const count = db.prepare("SELECT COUNT(*) as c FROM messages").get();
  console.log("Total messages:", count.c);
  const recent = db.prepare("SELECT id, role, substr(content,1,80) as preview, created_at FROM messages ORDER BY created_at DESC LIMIT 10").all();
  for (const m of recent) {
    console.log("  " + m.role + ": " + (m.preview||"").replace(/\n/g," ") + " (" + m.created_at + ")");
  }
} catch(e) {
  console.log("No messages table:", e.message);
}

try {
  const cols = db.prepare("PRAGMA table_info(chats)").all();
  console.log("chats cols:", cols.map(c => c.name).join(", "));
  const count = db.prepare("SELECT COUNT(*) as c FROM chats").get();
  console.log("Total chats:", count.c);
} catch(e) {
  console.log("No chats table:", e.message);
}

db.close();
