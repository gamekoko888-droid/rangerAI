/**
 * Migrate ALL users from MySQL (Docker) to SQLite
 * Handles schema differences: MySQL has extra columns that SQLite doesn't have
 * Uses INSERT OR REPLACE to handle existing records
 */
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';

const SQLITE_PATH = '/opt/rangerai-agent/rangerai.db';

async function main() {
  // Connect to MySQL via Docker network
  console.log('=== Connecting to MySQL ===');
  const mysqlConn = await mysql.createConnection({
    host: '10.255.0.2',  // Docker bridge IP for mysql-rangerai
    user: 'root',
    password: 'RangerAI2026!',
    database: 'rangerai'
  });
  console.log('MySQL connected');

  // Get all users from MySQL
  const [mysqlUsers] = await mysqlConn.execute('SELECT * FROM users');
  console.log(`Found ${mysqlUsers.length} users in MySQL`);

  // Connect to SQLite
  console.log('\n=== Connecting to SQLite ===');
  const sqliteDb = new Database(SQLITE_PATH);
  sqliteDb.pragma('journal_mode = WAL');
  
  // Check current SQLite users
  const existingCount = sqliteDb.prepare('SELECT count(*) as cnt FROM users').get();
  console.log(`SQLite currently has ${existingCount.cnt} users`);

  // Check SQLite schema to see what columns exist
  const tableInfo = sqliteDb.pragma('table_info(users)');
  const sqliteColumns = tableInfo.map(c => c.name);
  console.log('SQLite columns:', sqliteColumns.join(', '));

  // Add missing columns to SQLite if needed
  const extraColumns = [
    { name: 'department_id', type: 'TEXT' },
    { name: 'manager_id', type: 'TEXT' },
    { name: 'org_level', type: 'INTEGER DEFAULT 4' },
    { name: 'tree_path', type: "TEXT DEFAULT '/'" },
    { name: 'email', type: 'TEXT' },
    { name: 'phone', type: 'TEXT' },
    { name: 'avatar', type: 'TEXT' },
    { name: 'password_reset_token', type: 'TEXT' },
    { name: 'password_reset_expires', type: 'TEXT' },
  ];

  for (const col of extraColumns) {
    if (!sqliteColumns.includes(col.name)) {
      try {
        sqliteDb.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Added column: ${col.name}`);
      } catch (e) {
        // Column might already exist
        if (!e.message.includes('duplicate column')) {
          console.error(`Error adding ${col.name}:`, e.message);
        }
      }
    }
  }

  // Also need to relax the role CHECK constraint to allow 'manager', 'cs', etc.
  // SQLite doesn't support ALTER TABLE to modify constraints, so we need to recreate
  // But that's risky. Instead, let's just map non-standard roles to 'member'
  const validRoles = ['admin', 'member', 'viewer'];
  
  // Prepare INSERT OR REPLACE statement
  const insertStmt = sqliteDb.prepare(`
    INSERT OR REPLACE INTO users (
      id, username, passwordHash, salt, displayName, role, team, isActive, 
      createdAt, lastLoginAt, department_id, manager_id, org_level, tree_path,
      email, phone, avatar
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  // Migrate in a transaction
  let migrated = 0;
  let skipped = 0;
  let roleFixed = 0;

  const transaction = sqliteDb.transaction((users) => {
    for (const u of users) {
      let role = u.role || 'member';
      if (!validRoles.includes(role)) {
        console.log(`  Role mapping: ${u.username} "${role}" -> "member"`);
        role = 'member';
        roleFixed++;
      }

      // Handle NULL/empty passwordHash for DingTalk users
      const passwordHash = u.passwordHash || '';
      const salt = u.salt || '';

      try {
        insertStmt.run(
          u.id,
          u.username,
          passwordHash,
          salt,
          u.displayName || '',
          role,
          u.team || null,
          u.isActive ? 1 : 0,
          u.createdAt ? new Date(u.createdAt).toISOString().replace('T', ' ').replace('Z', '') : new Date().toISOString(),
          u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().replace('T', ' ').replace('Z', '') : null,
          u.department_id || null,
          u.manager_id || null,
          u.org_level || 4,
          u.tree_path || '/',
          u.email || null,
          u.phone || null,
          u.avatar || null
        );
        migrated++;
      } catch (e) {
        console.error(`  Failed to migrate ${u.username}: ${e.message}`);
        skipped++;
      }
    }
  });

  transaction(mysqlUsers);

  // Verify
  const finalCount = sqliteDb.prepare('SELECT count(*) as cnt FROM users').get();
  const adminCount = sqliteDb.prepare("SELECT count(*) as cnt FROM users WHERE role = 'admin'").get();
  const activeCount = sqliteDb.prepare("SELECT count(*) as cnt FROM users WHERE isActive = 1").get();

  console.log('\n=== Migration Summary ===');
  console.log(`MySQL total:     ${mysqlUsers.length}`);
  console.log(`Migrated:        ${migrated}`);
  console.log(`Skipped:         ${skipped}`);
  console.log(`Roles remapped:  ${roleFixed}`);
  console.log(`SQLite total:    ${finalCount.cnt}`);
  console.log(`  Admins:        ${adminCount.cnt}`);
  console.log(`  Active:        ${activeCount.cnt}`);

  // List admin users
  const admins = sqliteDb.prepare("SELECT username, displayName FROM users WHERE role = 'admin'").all();
  console.log('\nAdmin users:', admins.map(a => `${a.username} (${a.displayName})`).join(', '));

  // Verify jianwufy specifically
  const jianwufy = sqliteDb.prepare("SELECT id, username, role, isActive FROM users WHERE username = 'jianwufy'").get();
  console.log('\njianwufy:', JSON.stringify(jianwufy));

  sqliteDb.close();
  await mysqlConn.end();
  console.log('\n=== Done ===');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
