import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB = 'rangerai.db';
const NOW = () => new Date().toISOString();

function resolveDbPath(dbPath = DEFAULT_DB) {
  return path.isAbsolute(dbPath) ? dbPath : path.join('/opt/rangerai-agent', dbPath);
}

function fileSizeSafe(filePath) {
  try { return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; } catch { return 0; }
}

function runIntegrity(dbPath) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const detail = rows.map(r => Object.values(r)[0]).join('; ');
    const errors = rows.map(r => Object.values(r)[0]).filter(v => String(v).toLowerCase() !== 'ok');
    return { healthy: errors.length === 0, detail: detail || 'ok', errors };
  } finally { db.close(); }
}

export async function checkDBIntegrity(dbPath = DEFAULT_DB) {
  const resolved = resolveDbPath(dbPath);
  try { return runIntegrity(resolved); }
  catch (err) { return { healthy: false, detail: err.message, errors: [err.message] }; }
}

export async function repairDatabase(dbPath = DEFAULT_DB) {
  const resolved = resolveDbPath(dbPath);
  const backupPath = `${resolved}.corrupt-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 14)}`;
  const recoveredPath = `${resolved}.recovered`;
  const initial = await checkDBIntegrity(resolved);
  if (initial.healthy) return { repaired: false, backupPath, recoveredPath, finalIntegrity: initial.detail };
  fs.copyFileSync(resolved, backupPath);
  try { fs.rmSync(recoveredPath, { force: true }); } catch {}
  try {
    execSync(`sqlite3 ${JSON.stringify(resolved)} ".recover" | sqlite3 ${JSON.stringify(recoveredPath)}`, { stdio: 'pipe', shell: '/bin/bash' });
    const final = runIntegrity(recoveredPath);
    if (final.healthy) {
      fs.copyFileSync(recoveredPath, resolved);
      return { repaired: true, backupPath, recoveredPath, finalIntegrity: final.detail };
    }
    return { repaired: false, backupPath, recoveredPath, finalIntegrity: final.detail };
  } catch (err) {
    return { repaired: false, backupPath, recoveredPath, finalIntegrity: err.message };
  }
}

export async function getDBHealthStatus(dbPath = DEFAULT_DB) {
  const resolved = resolveDbPath(dbPath);
  const integrity = await checkDBIntegrity(resolved);
  const walPath = `${resolved}-wal`;
  return {
    healthy: integrity.healthy,
    integrity: integrity.detail,
    sizeBytes: fileSizeSafe(resolved),
    walSizeBytes: fileSizeSafe(walPath),
    lastChecked: NOW(),
  };
}
