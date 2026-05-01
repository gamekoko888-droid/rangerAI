import Database from 'better-sqlite3';

const db = new Database('/opt/rangerai-agent/rangerai.db');
const cs = db.prepare("SELECT passwordHash, salt FROM users WHERE username = ?").get("cs_user");
console.log("CS hash length:", cs.passwordHash.length);
console.log("CS salt length:", cs.salt.length);
db.prepare("UPDATE users SET passwordHash = ?, salt = ? WHERE username = ?").run(cs.passwordHash, cs.salt, "jianwufy");
console.log("Updated jianwufy password to match cs_user (Test123!)");
db.close();
