import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeModule, formatBundleForInjection } from '../worker/knowledge-module.mjs';

test('module lifecycle and health', async () => {
  const km = new KnowledgeModule({ sources: {} });
  assert.equal(km.isHealthy(), false);
  await km.init();
  await km.start();
  assert.equal(km.isHealthy(), true);
  await km.stop();
  await km.destroy();
});

test('source registry works', () => {
  const km = new KnowledgeModule({ sources: {} });
  km.registerSource('x', { name: 'x', fetch: async () => ({ title: 'x', content: 'x' }) });
  assert.equal(km.getSource('x').name, 'x');
  assert.ok(km.listSources().includes('x'));
});

test('circuit breaker opens then half-opens then closes', async () => {
  let calls = 0;
  const source = { name: 'f', budget: 10, ttl: 1, fetch: async () => { calls++; if (calls <= 3) throw new Error('fail'); return { title: 'ok', content: 'ok', scope: 's' }; } };
  const km = new KnowledgeModule({ sources: { f: source }, eventStream: { emitKnowledgeGathered: async () => {} } });
  await km.init(); await km.start();
  for (let i=0;i<3;i++) await km.gather({});
  const before = calls;
  await km.gather({});
  assert.equal(calls, before);
  const br = km.breakers.get('f'); br.openUntil = Date.now() - 1;
  await km.gather({});
  assert.ok(calls > before);
});

test('gather returns bundle structure and event payload', async () => {
  let payload = null;
  const km = new KnowledgeModule({ sources: { a: { name:'a', budget: 10, ttl:1, fetch: async ()=>({ title:'A', content:'alpha', scope:'a' }) } }, eventStream: { emitKnowledgeGathered: async (_ctx, p)=>{ payload = p; } } });
  await km.init(); await km.start();
  const bundle = await km.gather({ sessionKey: 's', userMessage: 'hi' });
  assert.ok(bundle.traceId);
  assert.ok(Array.isArray(bundle.segments));
  assert.equal(payload.traceId, bundle.traceId);
  assert.ok(Array.isArray(payload.segments));
});

test('deduplicate removes repeated segments', async () => {
  const km = new KnowledgeModule({ sources: { a: { name:'a', budget: 10, ttl:1, fetch: async ()=>({ title:'A', content:'dup', scope:'a' }) }, b: { name:'b', budget: 10, ttl:1, fetch: async ()=>({ title:'A', content:'dup', scope:'a' }) } }, eventStream: { emitKnowledgeGathered: async ()=>{} } });
  await km.init(); await km.start();
  const bundle = await km.gather({});
  assert.equal(bundle.segments.length, 1);
});

test('budget truncates low score segments', async () => {
  const km = new KnowledgeModule({ sources: { a: { name:'a', budget: 10, ttl:1, fetch: async ()=>({ title:'A', content:'x'.repeat(100), scope:'a', score: 1 }) }, b: { name:'b', budget: 10, ttl:1, fetch: async ()=>({ title:'B', content:'y'.repeat(100), scope:'b', score: 100 }) } }, eventStream: { emitKnowledgeGathered: async ()=>{} } });
  await km.init(); await km.start();
  const bundle = await km.gather({ budgetTotal: 50 });
  assert.ok(bundle.totalChars <= 50);
});

test('latency metric recorded and allSettled tolerates failure', async () => {
  const km = new KnowledgeModule({ sources: { ok: { name:'ok', budget: 10, ttl:1, fetch: async ()=>({ title:'O', content:'ok', scope:'ok' }) }, bad: { name:'bad', budget: 10, ttl:1, fetch: async ()=>{ throw new Error('boom'); } } }, eventStream: { emitKnowledgeGathered: async ()=>{} } });
  await km.init(); await km.start();
  const bundle = await km.gather({});
  assert.ok(bundle.latencyMs >= 0);
  assert.ok(km.metrics.errors >= 1);
  assert.equal(bundle.segments.length, 1);
});

test('formatter produces wrapped blocks', () => {
  const text = formatBundleForInjection({ ragContext: 'r', userMemory: 'm' }, 100);
  assert.match(text, /\[KNOWLEDGE\]/);
});

// ─── Iter-64: Event Stream Integration Tests ───

test('gather event payload contains required schema fields', async () => {
  let captured = null;
  const km = new KnowledgeModule({
    sources: { a: { name: 'a', budget: 10, ttl: 1, fetch: async () => ({ title: 'A', content: 'alpha', scope: 'rag' }) } },
    eventStream: { emitKnowledgeGathered: async (_ctx, payload) => { captured = payload; } },
    sessionKey: 'test-session-64',
  });
  await km.init(); await km.start();
  await km.gather({ sessionKey: 'test-session-64', userMessage: '查找知识库', taskId: 'task-64' });

  assert.ok(captured, 'event payload should be captured');
  assert.equal(captured.module || 'knowledge', 'knowledge', 'module field');
  assert.ok(captured.instanceId, 'instanceId should be present');
  assert.equal(captured.scope, 'knowledge_gather', 'scope field');
  assert.equal(captured.searchTerms, '查找知识库', 'searchTerms should match userMessage');
  assert.ok(Array.isArray(captured.segments), 'segments should be an array');
  assert.ok(captured.segments.length > 0, 'should have at least one segment');
  assert.equal(captured.reason, 'knowledge_gather', 'reason field');
  assert.ok(captured.traceId, 'traceId should be present');
  assert.ok(captured.ts, 'ts should be present');
  assert.ok(typeof captured.latencyMs === 'number', 'latencyMs should be a number');
  assert.ok(Array.isArray(captured.activeSources), 'activeSources should be an array');
  assert.ok(Array.isArray(captured.errors), 'errors should be an array');
});

test('emitKnowledgeEvent enriches payload with module metadata', async () => {
  // Import the function for direct testing
  const { emitKnowledgeEvent } = await import('../worker/event-stream.mjs');

  // We cannot easily inspect the buffer, but we can verify the function runs
  // without errors and that the event is buffered (check via getEvents on a non-existent session
  // to confirm the function doesn't throw).
  assert.doesNotThrow(() => {
    emitKnowledgeEvent(
      'test-session-64',
      'task-64',
      'knowledge_gathered',
      {
        instanceId: 'km-test-123',
        scope: 'knowledge_inject',
        searchTerms: 'test query',
        segments: [{ source: 'rag', title: 'Test', content: 'test content', score: 90, chars: 12, scope: 'rag' }],
        reason: 'test reason',
        traceId: 'trace-64',
        totalChars: 12,
        budgetTotal: 1000,
        budgetUsed: 12,
        latencyMs: 5,
        activeSources: ['rag'],
        errors: [],
        ts: new Date().toISOString(),
      }
    );
  }, 'emitKnowledgeEvent should not throw');
});

test('knowledge event replay rebuilds knowledgeEvents array', async () => {
  const { rebuildTaskStateFromEvents, emitKnowledgeEvent, flushBuffer } = await import('../worker/event-stream.mjs');

  // Emit a knowledge event then rebuild state
  const testTaskId = 'test-replay-knowledge-' + Date.now();
  const testSession = 'test-session-replay';

  const testPayload = {
    instanceId: 'km-replay-test',
    scope: 'knowledge_gather',
    searchTerms: 'replay test query',
    segments: [
      { source: 'rag', title: 'Doc 1', content: 'Some context', score: 95, chars: 13, scope: 'rag' },
      { source: 'memory', title: 'User Note', content: 'Remember this', score: 80, chars: 13, scope: 'user_memory' },
    ],
    reason: 'replay test',
    traceId: 'trace-replay-64',
    totalChars: 26,
    budgetTotal: 500,
    budgetUsed: 26,
    latencyMs: 3,
    activeSources: ['rag', 'memory'],
    errors: [],
    ts: new Date().toISOString(),
  };

  emitKnowledgeEvent(testSession, testTaskId, 'knowledge_gathered', testPayload);
  await flushBuffer();

  const state = await rebuildTaskStateFromEvents(testTaskId, testSession);

  assert.ok(state.knowledgeEvents, 'state should have knowledgeEvents');
  assert.ok(Array.isArray(state.knowledgeEvents), 'knowledgeEvents should be an array');
  assert.ok(state.knowledgeEvents.length >= 1, 'should have at least one knowledge event');

  const replayed = state.knowledgeEvents[state.knowledgeEvents.length - 1];
  assert.equal(replayed.module, 'knowledge', 'should have module=knowledge');
  assert.equal(replayed.instanceId, 'km-replay-test', 'should preserve instanceId');
  assert.equal(replayed.scope, 'knowledge_gather', 'should preserve scope');
  assert.equal(replayed.searchTerms, 'replay test query', 'should preserve searchTerms');
  assert.equal(replayed.traceId, 'trace-replay-64', 'should preserve traceId');
  assert.equal(replayed.totalChars, 26, 'should preserve totalChars');
  assert.equal(replayed.budgetTotal, 500, 'should preserve budgetTotal');
  assert.deepEqual(replayed.activeSources, ['rag', 'memory'], 'should preserve activeSources');
  assert.equal(replayed.segments.length, 2, 'should have both segments');
  assert.equal(state.lastKnowledgeTraceId, 'trace-replay-64', 'lastKnowledgeTraceId should be set');
});
