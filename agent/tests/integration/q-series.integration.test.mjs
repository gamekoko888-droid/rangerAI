import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateWorkspace, cleanupStale } from '../../worker/workspace-manager.mjs';
import { fileWrite, fileRead, fileEdit, fileGrep, fileDelete } from '../../worker/tools/file-tools.mjs';
import { getHealthStatus } from '../../worker/health-monitor.mjs';
import { orchestrateParallel } from '../../worker/parallel-orchestrator.mjs';

test('workspace + file tools flow', async () => {
  const sessionKey = `q14-${Date.now()}`;
  const ws = await getOrCreateWorkspace(sessionKey);
  assert.ok(ws.includes('/opt/rangerai-agent/workspaces/'));
  await fileWrite(sessionKey, 'a.txt', 'hello world');
  assert.equal(await fileRead(sessionKey, 'a.txt'), 'hello world');
  const edit = await fileEdit(sessionKey, 'a.txt', [{ find: 'world', replace: 'ranger' }]);
  assert.equal(edit.success, true);
  const grep = await fileGrep(sessionKey, 'ranger');
  assert.ok(grep.length >= 1);
  await fileDelete(sessionKey, 'a.txt');
  const cleaned = await cleanupStale(0);
  assert.ok(Array.isArray(cleaned));
});

test('parallel orchestrator returns envelope', async () => {
  const out = await orchestrateParallel([]);
  assert.ok(out && typeof out.duration_ms === 'number');
});

test('health monitor status shape', async () => {
  const h = getHealthStatus();
  assert.ok(['up','down'].includes(h.docker));
  assert.ok(['up','down'].includes(h.browser));
  assert.ok(['up','down'].includes(h.gateway));
});
