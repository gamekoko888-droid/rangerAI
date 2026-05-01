import assert from 'node:assert';
import test from 'node:test';
import { formatMemory } from '../worker/knowledge-injector.mjs';

test('Knowledge Injector: formatMemory with object', () => {
  const memory = { b: '2', a: '1', c: '3' };
  const formatted = formatMemory(memory);
  // Should be sorted alphabetically by key for KV-cache stability
  assert.strictEqual(formatted, '- a: 1\n- b: 2\n- c: 3');
});

test('Knowledge Injector: formatMemory with empty cases', () => {
  assert.strictEqual(formatMemory(null), '');
  assert.strictEqual(formatMemory('{}'), '');
  assert.strictEqual(formatMemory([]), '');
});

test('Knowledge Injector: formatMemory with string', () => {
  const memory = 'Some text memory';
  assert.strictEqual(formatMemory(memory), 'Some text memory');
});
