import assert from 'node:assert';
import test from 'node:test';
import { 
  parseCronField, 
  matchesCron, 
  getNextRunTime, 
  interpolate, 
  evaluateCondition 
} from '../workflow-scheduler.mjs';

test('Workflow Scheduler: parseCronField', () => {
  // Test *
  assert.strictEqual(parseCronField('*', 0, 59), null);
  
  // Test simple value
  const val1 = parseCronField('5', 0, 59);
  assert.ok(val1.has(5));
  assert.strictEqual(val1.size, 1);
  
  // Test range
  const val2 = parseCronField('1-3', 0, 59);
  assert.ok(val2.has(1) && val2.has(2) && val2.has(3));
  assert.strictEqual(val2.size, 3);
  
  // Test step
  const val3 = parseCronField('*/15', 0, 59);
  assert.ok(val3.has(0) && val3.has(15) && val3.has(30) && val3.has(45));
  assert.strictEqual(val3.size, 4);
  
  // Test comma
  const val4 = parseCronField('1,5,10', 0, 59);
  assert.ok(val4.has(1) && val4.has(5) && val4.has(10));
  assert.strictEqual(val4.size, 3);
});

test('Workflow Scheduler: matchesCron', () => {
  const date = new Date('2026-04-01T09:00:00Z'); // Note: local time depends on env, but we test relative
  // 9:00 AM matches "0 9 * * *" (assuming local time is UTC for simplicity in this test or we control the date)
  const d = new Date(2026, 3, 1, 9, 0, 0); // April 1st, 9:00 AM
  assert.ok(matchesCron('0 9 * * *', d));
  assert.ok(!matchesCron('1 9 * * *', d));
  assert.ok(matchesCron('* * * * *', d));
  assert.ok(matchesCron('0 9 1 4 *', d)); // April 1st
});

test('Workflow Scheduler: interpolate', () => {
  const context = { step_1_output: 'hello', name: 'world' };
  assert.strictEqual(interpolate('Result: {{step_1_output}}', context), 'Result: hello');
  assert.strictEqual(interpolate('Hi {{name}}, {{step_1_output}}', context), 'Hi world, hello');
  assert.strictEqual(interpolate('Missing {{none}}', context), 'Missing {{none}}');
});

test('Workflow Scheduler: evaluateCondition', () => {
  const context = { score: '85', status: 'success', text: 'hello world' };
  
  // Manual interpolation like in the actual scheduler
  const check = (expr) => evaluateCondition(interpolate(expr, context), context);

  // Numeric
  assert.ok(check('{{score}} > 80'));
  assert.ok(!check('{{score}} < 80'));
  assert.ok(check('{{score}} == 85'));
  
  // String
  assert.ok(check('{{status}} equals success'));
  assert.ok(check('{{text}} contains hello'));
  
  // Exists/Empty
  assert.ok(check('{{score}} exists'));
  assert.ok(check('{{missing}} empty', { missing: '' }));
  
  // Truthy
  assert.ok(evaluateCondition('true', {}));
  assert.ok(!evaluateCondition('false', {}));
});
