import assert from 'node:assert';
import test from 'node:test';
import { cleanFinalText } from '../worker/stream-processor.mjs';

const KOREAN_WARNING = '> ⚠️ 模型输出了韩语内容，可能是幻觉。请重新提问或切换模型。';

test('cleanFinalText warns on predominantly Korean hallucination-like output', () => {
  const text = '안녕하세요. 이것은 한국어로 작성된 응답입니다. 다시 확인해 주세요.';
  const cleaned = cleanFinalText(text);
  assert.ok(cleaned.startsWith(KOREAN_WARNING));
  assert.ok(cleaned.includes(text));
});

test('cleanFinalText does not warn on normal Chinese output', () => {
  const text = '这是正常的中文回复，应该直接返回，不应该追加韩语幻觉提示。';
  assert.strictEqual(cleanFinalText(text), text);
});

test('cleanFinalText does not warn on short Korean phrase', () => {
  const text = '안녕하세요 Joseph';
  assert.strictEqual(cleanFinalText(text), text);
});

test('cleanFinalText removes heartbeat artifacts before final output', () => {
  assert.strictEqual(cleanFinalText('NOHEARTBEAT_OK\n\n正常回复'), '正常回复');
});
