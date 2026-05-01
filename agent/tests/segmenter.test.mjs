import assert from 'node:assert';
import test from 'node:test';
import { splitIntoSegments, segmentLongMessage } from '../worker/segmenter.mjs';

test('Segmenter: splitIntoSegments', () => {
  const text = 'a'.repeat(6000);
  const segments = splitIntoSegments(text, 1000, 5);
  assert.strictEqual(segments.length, 5);
  assert.ok(segments[4].includes('... (后续内容已省略)'));
});

test('Segmenter: segmentLongMessage with tags', () => {
  const msg = 'Some context... [KNOWLEDGE_CONTEXT] My data here [/KNOWLEDGE_CONTEXT] My question?';
  const { segments, question } = segmentLongMessage(msg);
  assert.strictEqual(question, 'My question?');
  assert.strictEqual(segments[0], 'My data here');
});

test('Segmenter: segmentLongMessage without tags', () => {
  const msg = 'Plain message';
  const { segments, question } = segmentLongMessage(msg);
  assert.strictEqual(question, 'Plain message');
  assert.strictEqual(segments.length, 0);
});
