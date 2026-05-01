#!/usr/bin/env node
/**
 * runner.mjs — 数据库迁移运行器
 *
 * 用法：
 *   node migrations/runner.mjs           # 执行所有待运行的迁移
 *   node migrations/runner.mjs --dry-run # 仅列出待执行的迁移，不实际执行
 *
 * 设计：
 *   - 使用 node:sqlite 操作 rangerai.db
 *   - 检查 schema_versions 表是否存在，不存在则创建
 *   - 遍历 migrations/ 下 .sql 文件，按文件名排序
 *   - 只执行 schema_versions 中未记录的迁移
 *   - 每个迁移在事务中执行
 *   - 记录执行结果（版本号、文件名、时间戳、校验和、耗时）
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __root = resolve(__dirname, '..');

const DB_PATH = process.env.RANGERAI_DB || resolve(__root, 'rangerai.db');
const MIGRATIONS_DIR = __dirname;
const SCHEMA_VERSIONS_TABLE = 'schema_versions';

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'migration-runner',
    msg,
    ...meta,
  };
  const out = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(out + '\n');
  } else {
    process.stdout.write(out + '\n');
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────
function openDb() {
  try {
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    return db;
  } catch (err) {
    log('error', 'failed to open database', { path: DB_PATH, error: err.message });
    process.exit(1);
  }
}

function ensureSchemaVersions(db) {
  // 检查表是否存在
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(SCHEMA_VERSIONS_TABLE);
  if (exists) {
    log('info', 'schema_versions table exists');
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSIONS_TABLE} (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      checksum    TEXT,
      duration_ms INTEGER
    )
  `);
  log('info', 'created schema_versions table');
}

function isApplied(db, version, name) {
  const row = db
    .prepare(`SELECT version, checksum FROM ${SCHEMA_VERSIONS_TABLE} WHERE version=? AND name=?`)
    .get(version, name);
  return !!row;
}

function recordMigration(db, version, name, checksum, durationMs) {
  db.prepare(
    `INSERT INTO ${SCHEMA_VERSIONS_TABLE} (version, name, applied_at, checksum, duration_ms) VALUES (?, ?, datetime('now'), ?, ?)`
  ).run(version, name, checksum, durationMs);
}

// ─── Migration scanner ───────────────────────────────────────────────────────
function scanMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // 字母序，001_, 002_ 等前缀自然排序

  const migrations = [];
  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      log('warn', 'skipping non-conforming migration file', { file });
      continue;
    }
    const version = parseInt(match[1], 10);
    const name = match[2];
    const path = resolve(MIGRATIONS_DIR, file);
    const content = readFileSync(path, 'utf-8');
    const checksum = createHash('sha256').update(content).digest('hex');

    migrations.push({ version, name, file, path, content, checksum });
  }
  return migrations;
}

// ─── Execute migration ───────────────────────────────────────────────────────
function executeMigration(db, migration) {
  const { version, name, file, content, checksum } = migration;
  log('info', 'executing migration', { version, name, file });

  const startMs = Date.now();

  // 在事务中执行
  db.exec('BEGIN IMMEDIATE');
  try {
    // 按分号拆分为多条语句执行
    const statements = content
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      db.exec(stmt);
    }

    recordMigration(db, version, name, checksum, 0);
    db.exec('COMMIT');

    const durationMs = Date.now() - startMs;
    // 更新耗时
    db.prepare(
      `UPDATE ${SCHEMA_VERSIONS_TABLE} SET duration_ms=? WHERE version=? AND name=?`
    ).run(durationMs, version, name);

    log('info', 'migration applied', { version, name, duration_ms: durationMs });
    return { status: 'applied', durationMs };
  } catch (err) {
    db.exec('ROLLBACK');
    log('error', 'migration failed', { version, name, error: err.message });
    return { status: 'failed', error: err.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  log('info', 'migration runner starting', { db: DB_PATH, dry_run: DRY_RUN });

  const migrations = scanMigrations();
  log('info', `found ${migrations.length} migration file(s)`);

  if (migrations.length === 0) {
    log('info', 'no migrations found, exiting');
    process.exit(0);
  }

  const db = openDb();
  try {
    ensureSchemaVersions(db);

    const pending = [];
    for (const m of migrations) {
      if (isApplied(db, m.version, m.name)) {
        log('debug', 'skip already applied', { version: m.version, name: m.name });
      } else {
        pending.push(m);
      }
    }

    if (pending.length === 0) {
      log('info', 'database is up to date, nothing to run');
      process.exit(0);
    }

    log('info', `pending migrations: ${pending.length}`);

    if (DRY_RUN) {
      log('info', 'DRY RUN — would execute the following:');
      for (const m of pending) {
        log('info', `  [DRY-RUN] ${m.file} (v${m.version}, checksum=${m.checksum.slice(0, 12)})`);
      }
      process.exit(0);
    }

    // 实际执行
    let applied = 0;
    let failed = 0;
    for (const m of pending) {
      const result = executeMigration(db, m);
      if (result.status === 'applied') applied++;
      else failed++;
    }

    log('info', 'migration complete', { applied, failed, total: pending.length });
    if (failed > 0) process.exit(1);
  } finally {
    db.close();
  }
}

main();
