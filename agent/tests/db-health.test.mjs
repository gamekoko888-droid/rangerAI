import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkDBIntegrity, repairDatabase, getDBHealthStatus } from '../modules/db-health.mjs';

function tmpDb(name) { return path.join('/tmp', `test-db-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`); }
function cleanup(...files) { for (const f of files) { try { fs.rmSync(f, { force: true }); } catch {} } }

test('checkDBIntegrity returns healthy=true for normal db', async () => {
  const dbPath = tmpDb('healthy');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('ok');");
  db.close();
  const res = await checkDBIntegrity(dbPath);
  assert.equal(res.healthy, true);
  assert.match(res.detail.toLowerCase(), /ok/);
  cleanup(dbPath);
});

test('checkDBIntegrity returns healthy=false for corrupted db', async () => {
  const dbPath = tmpDb('corrupt');
  fs.writeFileSync(dbPath, Buffer.from('not-a-sqlite-db'));
  const res = await checkDBIntegrity(dbPath);
  assert.equal(res.healthy, false);
  assert.ok(res.detail.length > 0);
  cleanup(dbPath);
});

test('repairDatabase creates backup path', async () => {
  const dbPath = tmpDb('repair');
  fs.writeFileSync(dbPath, Buffer.from('not-a-sqlite-db')); 
  const res = await repairDatabase(dbPath);
  assert.ok(res.backupPath.includes('.corrupt-'));
  assert.ok(fs.existsSync(res.backupPath));
  cleanup(dbPath, res.backupPath, res.recoveredPath);
});

test('getDBHealthStatus returns full fields', async () => {
  const dbPath = tmpDb('status');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);');
  db.close();
  const res = await getDBHealthStatus(dbPath);
  assert.deepEqual(Object.keys(res).sort(), ['healthy','integrity','lastChecked','sizeBytes','walSizeBytes'].sort());
  assert.equal(typeof res.healthy, 'boolean');
  assert.equal(typeof res.sizeBytes, 'number');
  assert.equal(typeof res.walSizeBytes, 'number');
  cleanup(dbPath, `${dbPath}-wal`);
});
