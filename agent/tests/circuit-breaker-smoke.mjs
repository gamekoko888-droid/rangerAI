/**
 * tests/circuit-breaker-smoke.mjs — R76 LLM Circuit Breaker unit smoke test
 * 
 * Tests the CircuitBreaker class standalone (from circuit-breaker.mjs).
 * Does NOT touch llm-bridge.mjs private instances or handler code.
 * 
 * Coverage:
 *   - Initial state & canRequest()
 *   - Hard failure threshold → OPEN
 *   - Soft failure threshold → OPEN (8 soft)
 *   - HALF_OPEN → CLOSED (successful probe)
 *   - HALF_OPEN → OPEN (failed probe, hard & soft)
 *   - Decay: counters halve without new failures
 *   - Max OPEN duration → forced HALF_OPEN probe
 *   - forceReset() from any state
 *   - getStatus() correctness
 *   - failureCount getter (backward compat)
 *   - Custom thresholds via constructor options
 */

import { CircuitBreaker } from '../worker/circuit-breaker.mjs';
import { strict as assert } from 'node:assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

function assertState(cb, state, hardCount, softCount, label) {
  const s = cb.getStatus();
  assert.strictEqual(s.state, state, `${label}: state`);
  assert.strictEqual(s.hardFailureCount, hardCount, `${label}: hardFailureCount`);
  assert.strictEqual(s.softFailureCount, softCount, `${label}: softFailureCount`);
}

// Use short intervals for fast testing
const FAST_OPTS = { hardFailureThreshold: 3, softFailureThreshold: 5, resetTimeoutMs: 50, decayIntervalMs: 100 };

console.log(`\n[R76] Circuit Breaker Unit Smoke Test\n`);

// ─── Group 1: Initialization & Basic State ───
console.log('【Group 1】Initialization & Basic State');

test('initial state is CLOSED', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assertState(cb, 'CLOSED', 0, 0, 'initial');
});

test('canRequest() returns true when CLOSED', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assert.strictEqual(cb.canRequest(), true);
});

test('failureCount getter sums hard + soft', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assert.strictEqual(cb.failureCount, 0);
  cb.recordFailure();
  assert.strictEqual(cb.failureCount, 1);
  cb.recordSoftFailure();
  assert.strictEqual(cb.failureCount, 2);
});

test('totalTrips starts at 0', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assert.strictEqual(cb.totalTrips, 0);
});

test('lastTripReason starts null', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assert.strictEqual(cb.lastTripReason, null);
});

test('halfOpenAttempts starts at 0', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assert.strictEqual(cb.halfOpenAttempts, 0);
});

test('nextAttemptAt starts at 0', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  assert.strictEqual(cb.nextAttemptAt, 0);
});

// ─── Group 2: Hard Failure Threshold → OPEN ───
console.log('【Group 2】Hard Failure Threshold → OPEN');

test('1 hard failure — still CLOSED', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  cb.recordFailure();
  assertState(cb, 'CLOSED', 1, 0, '1-hard');
  assert.strictEqual(cb.canRequest(), true);
});

test('2 hard failures — still CLOSED', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  cb.recordFailure();
  cb.recordFailure();
  assertState(cb, 'CLOSED', 2, 0, '2-hard');
  assert.strictEqual(cb.canRequest(), true);
});

test('3 hard failures → OPEN, canRequest() false', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  assertState(cb, 'OPEN', 3, 0, '3-hard');
  assert.strictEqual(cb.totalTrips, 1);
  assert.strictEqual(cb.lastTripReason, 'hard');
  assert.strictEqual(cb.canRequest(), false);
});

test('custom hardFailureThreshold=1 → OPEN after 1', () => {
  const cb = new CircuitBreaker({ ...FAST_OPTS, hardFailureThreshold: 1 });
  cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN');
  assert.strictEqual(cb.totalTrips, 1);
});

// ─── Group 3: Soft Failure Threshold → OPEN ───
console.log('【Group 3】Soft Failure Threshold → OPEN');

test('4 soft failures — still CLOSED (threshold=5)', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 4; i++) cb.recordSoftFailure();
  assertState(cb, 'CLOSED', 0, 4, '4-soft');
  assert.strictEqual(cb.canRequest(), true);
});

test('5 soft failures → OPEN', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 5; i++) cb.recordSoftFailure();
  assertState(cb, 'OPEN', 0, 5, '5-soft');
  assert.strictEqual(cb.totalTrips, 1);
  assert.strictEqual(cb.lastTripReason, 'soft');
  assert.strictEqual(cb.canRequest(), false);
});

test('mix hard + soft: soft alone trips at 5, hard trips at 3 separately', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  cb.recordSoftFailure();
  cb.recordSoftFailure();
  cb.recordFailure();
  cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'CLOSED'); // hard=2 (threshold 3), soft=2 (threshold 5)
  cb.recordSoftFailure();
  cb.recordSoftFailure();
  assert.strictEqual(cb.getStatus().state, 'CLOSED'); // hard=2, soft=4
  cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN'); // hard=3 → trip
});

// ─── Group 4: HALF_OPEN Probe ───
console.log('【Group 4】HALF_OPEN Probe');

test('after resetTimeoutMs, canRequest() transitions OPEN→HALF_OPEN', async () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  // Trip to OPEN
  for (let i = 0; i < 3; i++) cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN');
  
  // Wait for resetTimeoutMs
  await new Promise(r => setTimeout(r, 100));
  
  assert.strictEqual(cb.canRequest(), true);
  assert.strictEqual(cb.getStatus().state, 'HALF_OPEN');
  assert.strictEqual(cb.halfOpenAttempts, 1);
});

test('HALF_OPEN success → CLOSED, counters zeroed', async () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  await new Promise(r => setTimeout(r, 100));
  cb.canRequest(); // enter HALF_OPEN
  cb.recordSuccess();
  assertState(cb, 'CLOSED', 0, 0, 'after-success');
  assert.strictEqual(cb.totalTrips, 1); // trip count preserved
});

test('HALF_OPEN hard failure → back to OPEN', async () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  await new Promise(r => setTimeout(r, 100));
  cb.canRequest(); // HALF_OPEN
  cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN');
  assert.strictEqual(cb.totalTrips, 2); // tripped again
  assert.strictEqual(cb.canRequest(), false);
});

test('HALF_OPEN soft failure → back to OPEN, double cooldown', async () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  await new Promise(r => setTimeout(r, 100));
  cb.canRequest(); // HALF_OPEN
  cb.recordSoftFailure();
  const s = cb.getStatus();
  assert.strictEqual(s.state, 'OPEN');
  assert.strictEqual(cb.totalTrips, 2);
  // Soft HALF_OPEN failure sets nextAttemptAt with double resetTimeoutMs
  assert.ok(cb.nextAttemptAt > Date.now() + 50, 'soft HALF_OPEN failure should have longer cooldown');
});

test('HALF_OPEN only allows halfOpenMaxAttempts probes', async () => {
  const cb = new CircuitBreaker({ ...FAST_OPTS, halfOpenMaxAttempts: 1, resetTimeoutMs: 10 });
  for (let i = 0; i < 3; i++) cb.recordFailure();
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(cb.canRequest(), true); // HALF_OPEN, attempt 1
  assert.strictEqual(cb.canRequest(), false); // exceeded max attempts
});

// ─── Group 5: Decay ───
console.log('【Group 5】Decay');

test('counters halve after decayIntervalMs without new failures', async () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 10, softFailureThreshold: 10, decayIntervalMs: 50 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure(); // hard=4
  cb.recordSoftFailure();
  cb.recordSoftFailure(); // soft=2
  assert.strictEqual(cb.hardFailureCount, 4);
  assert.strictEqual(cb.softFailureCount, 2);
  
  // Wait for decay
  await new Promise(r => setTimeout(r, 120));
  
  // call canRequest() to trigger _applyDecay
  cb.canRequest();
  assert.ok(cb.hardFailureCount <= 2, `hard count should halve: actual=${cb.hardFailureCount}`);
  assert.ok(cb.softFailureCount <= 1, `soft count should halve: actual=${cb.softFailureCount}`);
});

test('decay only runs after interval, not immediately', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 10, softFailureThreshold: 10, decayIntervalMs: 5000 });
  cb.recordFailure();
  cb.recordFailure();
  cb.canRequest(); // should not decay yet (5000ms interval)
  assert.strictEqual(cb.hardFailureCount, 2);
});

// ─── Group 6: Max OPEN Duration ───
console.log('【Group 6】Max OPEN Duration');

test('OPEN > 5 min with no new failure → forced HALF_OPEN', async () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8, resetTimeoutMs: 10000 });
  for (let i = 0; i < 3; i++) cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN');
  
  // Simulate old lastFailureTime
  cb.lastFailureTime = Date.now() - (6 * 60 * 1000); // 6 minutes ago
  
  assert.strictEqual(cb.canRequest(), true);
  assert.strictEqual(cb.getStatus().state, 'HALF_OPEN');
});

// ─── Group 7: forceReset ───
console.log('【Group 7】forceReset');

test('forceReset from OPEN → CLOSED', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN');
  cb.forceReset('test');
  assertState(cb, 'CLOSED', 0, 0, 'forced');
});

test('forceReset from HALF_OPEN → CLOSED', async () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  await new Promise(r => setTimeout(r, 100));
  cb.canRequest();
  assert.strictEqual(cb.getStatus().state, 'HALF_OPEN');
  cb.forceReset('test');
  assertState(cb, 'CLOSED', 0, 0, 'half-to-closed');
});

test('forceReset preserves totalTrips', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  assert.strictEqual(cb.totalTrips, 1);
  cb.forceReset('test');
  assert.strictEqual(cb.totalTrips, 1);
});

// ─── Group 8: getStatus ───
console.log('【Group 8】getStatus');

test('getStatus returns all fields', () => {
  const cb = new CircuitBreaker({ hardFailureThreshold: 3, softFailureThreshold: 8 });
  const s = cb.getStatus();
  assert.ok('state' in s);
  assert.ok('hardFailureCount' in s);
  assert.ok('softFailureCount' in s);
  assert.ok('failureCount' in s);
  assert.ok('totalTrips' in s);
  assert.ok('lastTripReason' in s);
  assert.ok('halfOpenAttempts' in s);
  assert.ok('nextAttemptAt' in s);
  assert.ok('lastFailureAge' in s);
});

test('getStatus failureCount matches sum', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSoftFailure();
  const s = cb.getStatus();
  assert.strictEqual(s.failureCount, s.hardFailureCount + s.softFailureCount);
});

test('getStatus lastFailureAge is null when no failures', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  assert.strictEqual(cb.getStatus().lastFailureAge, null);
});

test('getStatus lastFailureAge is positive after failure', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  cb.recordFailure();
  const s = cb.getStatus();
  assert.ok(typeof s.lastFailureAge === 'number' && s.lastFailureAge >= 0);
});

// ─── Group 9: Reset ───
console.log('【Group 9】Reset');

test('reset() clears counters and state', () => {
  const cb = new CircuitBreaker(FAST_OPTS);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  cb.reset();
  assertState(cb, 'CLOSED', 0, 0, 'reset');
  assert.strictEqual(cb.halfOpenAttempts, 0);
  assert.strictEqual(cb.nextAttemptAt, 0);
  assert.strictEqual(cb.lastTripReason, null);
});

// ─── Group 10: Backward Compat ───
console.log('【Group 10】Backward Compat');

test('failureThreshold option still works as hardFailureThreshold', () => {
  const cb = new CircuitBreaker({ failureThreshold: 5 });
  assert.strictEqual(cb.hardFailureThreshold, 5);
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assert.strictEqual(cb.getStatus().state, 'OPEN');
});

// ─── Summary ───
console.log(`\n${'═'.repeat(50)}`);
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
console.log(`${'═'.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
