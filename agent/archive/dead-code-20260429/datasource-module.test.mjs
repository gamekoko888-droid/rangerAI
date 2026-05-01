import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatasourceModule, CircuitBreaker } from '../worker/datasource-module.mjs';
import { EVENT_TYPES, getRecentEvents, getEvents, flushBuffer } from '../worker/event-stream.mjs';

const flush = () => new Promise(r => setTimeout(r, 20));

test('lifecycle create → init → start → stop → destroy', async () => {
  const mod = createDatasourceModule();
  assert.equal(mod.state, 'created');
  await mod.init();
  assert.equal(mod.state, 'initialized');
  await mod.start();
  assert.equal(mod.state, 'running');
  await mod.stop();
  assert.equal(mod.state, 'stopped');
  await mod.destroy();
  assert.equal(mod.state, 'destroyed');
});

test('built-in sources gather data', async () => {
  const mod = createDatasourceModule();
  await mod.init(); await mod.start();
  const payload = await mod.gather({ sessionKey: 'sess-a', taskId: 'task-a' });
  assert.equal(payload.totalSources, 3);
  assert.match(payload.formatted, /Game Topup Stats/);
  assert.match(payload.formatted, /KOL Roster/);
  assert.match(payload.formatted, /System Status/);
});

test('SystemStatus source is resilient when runtime-ledger is absent', async () => {
  const mod = createDatasourceModule();
  const payload = await mod.gather({ sessionKey: 'sess-b', taskId: 'task-b' });
  assert.equal(payload.totalSources >= 1, true);
  assert.match(payload.formatted, /系统健康/);
});

test('circuit breaker opens after 3 failures and half-opens after cooldown', async () => {
  const mod = createDatasourceModule();
  const failing = { async fetch() { throw new Error('fail'); } };
  mod.registerSource('flaky', failing);
  const breaker = mod.breakers.get('flaky');
  for (let i = 0; i < 3; i++) { await mod.gather({ sessionKey: 'sess-c', taskId: 'task-c' }); }
  assert.equal(breaker.state, 'OPEN');
  breaker.openUntil = Date.now() - 1;
  assert.equal(breaker.canPass(), true);
  assert.equal(breaker.state, 'HALF_OPEN');
});

test('gather emits DATASOURCE_GATHERED into event stream', async () => {
  const mod = createDatasourceModule();
  await mod.gather({ sessionKey: 'sess-event', taskId: 'task-event' });
  await flushBuffer();
  await flush();
  const events = await getRecentEvents('sess-event', 20);
  const all = await getEvents('sess-event', { limit: 20 });
  assert.ok(events.some(e => e.event_type === EVENT_TYPES.DATASOURCE_GATHERED) || all.some(e => e.event_type === EVENT_TYPES.DATASOURCE_GATHERED));
});
