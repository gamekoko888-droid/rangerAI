import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeForFrontend } from '../worker/format-utils.mjs';

test('sanitizeForFrontend keeps technical OpenClaw identifiers intact', () => {
  const input = '检查 worker/openclaw-handler.mjs、/opt/rangerai-agent/worker/openclaw-handler.mjs、openclaw-gateway。';
  assert.equal(sanitizeForFrontend(input), input);
});

test('sanitizeForFrontend still rewrites standalone brand terms', () => {
  assert.equal(sanitizeForFrontend('OpenClaw Gateway WebSocket connected via Gateway'), 'RangerAI AI 引擎 connected via AI 引擎');
});
