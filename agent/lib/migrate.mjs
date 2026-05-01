/**
 * lib/migrate.mjs — Database Migration Manager (R100)
 * 
 * Versioned migration runner for SQLite.
 * Tracks applied migrations in schema_versions table.
 * Migrations run in order, each exactly once.
 * 
 * Usage:
 *   node lib/migrate.mjs              # run pending migrations
 *   node lib/migrate.mjs --status     # show migration status
 *   node lib/migrate.mjs --rollback N # rollback last N migrations (needs down.sql)
 */

import Database from 'better-sqlite3';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(AGENT_ROOT, 'migrations');
const DB_PATH = process.env.RANGERAI_DB_PATH || join(AGENT_ROOT, 'rangerai.db');

function getDb() {
  return new Database(DB_PATH);
}

function ensureSchemaVersions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      checksum    TEXT,
      duration_ms INTEGER
    )
  `);
}

function getAppliedVersions(db) {
  return db.prepare('SELECT version, name, applied_at FROM schema_versions ORDER BY version').all();
}

function getPendingMigrations(db) {
  const applied = new Set(getAppliedVersions(db).map(r => r.version));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  
  return files.map(f => {
    const version = parseInt(f.substring(0, 3), 10);
    const name = f.replace(/^\d{3}_/, '').replace(/\.sql$/, '');
    return { version, name, file: f, applied: applied.has(version) };
  });
}

function runMigration(db, { version, name, file }) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
  const start = Date.now();
  
  // Check for rollback section
  const upSql = sql.includes('-- DOWN')
    ? sql.split('-- DOWN')[0].trim()
    : sql;
  
  db.exec(upSql);
  
  const duration = Date.now() - start;
  db.prepare(
    'INSERT INTO schema_versions (version, name, duration_ms) VALUES (?, ?, ?)'
  ).run(version, name, duration);
  
  return { version, name, duration };
}

function rollbackMigration(db, { version, name, file }) {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
  
  if (!sql.includes('-- DOWN')) {
    throw new Error(`Migration ${version}_${name} has no DOWN section`);
  }
  
  const downSql = sql.split('-- DOWN')[1].trim();
  db.exec(downSql);
  
  db.prepare('DELETE FROM schema_versions WHERE version = ?').run(version);
  
  return { version, name, rolledBack: true };
}

function status() {
  const db = getDb();
  try {
    ensureSchemaVersions(db);
    const migrations = getPendingMigrations(db);
    
    console.log('Migration Status:');
    console.log('─'.repeat(50));
    
    for (const m of migrations) {
      const status = m.applied ? '✓ APPLIED' : '○ PENDING';
      console.log(`  [${String(m.version).padStart(3, '0')}] ${status}  ${m.name}`);
    }
    
    const pending = migrations.filter(m => !m.applied);
    console.log('─'.repeat(50));
    console.log(`Total: ${migrations.length}, Applied: ${migrations.length - pending.length}, Pending: ${pending.length}`);
  } finally {
    db.close();
  }
}

function migrate() {
  const db = getDb();
  try {
    ensureSchemaVersions(db);
    const migrations = getPendingMigrations(db);
    const pending = migrations.filter(m => !m.applied);
    
    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }
    
    console.log(`Running ${pending.length} pending migration(s)...`);
    
    for (const m of pending) {
      process.stdout.write(`  [${String(m.version).padStart(3, '0')}] ${m.name} ... `);
      const result = runMigration(db, m);
      console.log(`OK (${result.duration}ms)`);
    }
    
    console.log('All migrations applied successfully.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

function rollback(count = 1) {
  const db = getDb();
  try {
    ensureSchemaVersions(db);
    const applied = getAppliedVersions(db);
    
    if (applied.length === 0) {
      console.log('No migrations to rollback.');
      return;
    }
    
    const toRollback = applied.slice(-count);
    
    for (const r of toRollback) {
      const file = readdirSync(MIGRATIONS_DIR).find(f => f.startsWith(String(r.version).padStart(3, '0')));
      if (!file) {
        console.error(`Migration file not found for version ${r.version}`);
        continue;
      }
      process.stdout.write(`  Rolling back [${String(r.version).padStart(3, '0')}] ${r.name} ... `);
      rollbackMigration(db, { ...r, file });
      console.log('OK');
    }
  } catch (e) {
    console.error('Rollback failed:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--status')) {
  status();
} else if (args.includes('--rollback')) {
  const idx = args.indexOf('--rollback');
  const count = parseInt(args[idx + 1], 10) || 1;
  rollback(count);
} else {
  migrate();
}
