import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, validatePayload } from '../worker/event-schema.mjs';

const successCases = [
  [EVENT_TYPES.USER_MESSAGE, 'hello'],
  [EVENT_TYPES.PLAN_UPDATE, { status: 'pending', stepNumber: 1, pseudoCode: 'do x', reflection: 'ok' }],
  [EVENT_TYPES.PLAN_GENERATED, { planId: 'p1' }],
  [EVENT_TYPES.ACTION, { type: 'tool_call' }],
  [EVENT_TYPES.ACTION_STARTED, { actionId: 'a1' }],
  [EVENT_TYPES.ACTION_COMPLETED, { actionId: 'a1', success: true }],
  [EVENT_TYPES.OBSERVATION, { content: 'done' }],
  [EVENT_TYPES.TASK_STARTED, { taskId: 't1' }],
  [EVENT_TYPES.TASK_COMPLETED, { taskId: 't1' }],
  [EVENT_TYPES.TASK_FAILED, { taskId: 't1', error: 'boom' }],
  [EVENT_TYPES.FINAL_ANSWER, { text: 'answer' }],
  [EVENT_TYPES.ERROR, { message: 'oops' }],
  [EVENT_TYPES.TTS_GENERATED, { audioUrl: 'x' }],
  [EVENT_TYPES.KNOWLEDGE_GATHERED, { traceId: 'k1', contributingSources: [{ source: 'rag', relevance: 0.9 }] }],
  [EVENT_TYPES.KNOWLEDGE_INJECTED, { content: 'knowledge' }],
  [EVENT_TYPES.DATASOURCE_GATHERED, { traceId: 'd1', sources: [] }],
  [EVENT_TYPES.SUPERVISOR_BLOCK, { reason: 'policy' }],
  [EVENT_TYPES.MAX_RETRIES_EXCEEDED, { retries: 3 }],
  [EVENT_TYPES.REPLAN, { reason: 'new info' }],
  [EVENT_TYPES.RECOVERY_ATTEMPT, { attempt: 1 }],
  [EVENT_TYPES.AGENT_THINKING, { thought: '...'}],
  [EVENT_TYPES.HEALTH_CHECK, { healthy: true }],
];

test('validatePayload success for all event types', () => {
  for (const [type, payload] of successCases) {
    const res = validatePayload(type, payload);
    assert.equal(res.ok, true, `${type} should pass`);
  }
});

test('PLAN_UPDATE validates structured payload', () => {
  assert.equal(validatePayload(EVENT_TYPES.PLAN_UPDATE, { status: 'in_progress' }).ok, true);
  assert.equal(validatePayload(EVENT_TYPES.PLAN_UPDATE, { status: 'completed', stepNumber: 2 }).ok, true);
});

test('validatePayload USER_MESSAGE accepts string, {message}, or {content}', () => {
  assert.equal(validatePayload(EVENT_TYPES.USER_MESSAGE, 'hello').ok, true);
  assert.equal(validatePayload(EVENT_TYPES.USER_MESSAGE, { message: 'hi' }).ok, true);
  assert.equal(validatePayload(EVENT_TYPES.USER_MESSAGE, { content: 'hi there' }).ok, true);
  assert.equal(validatePayload(EVENT_TYPES.USER_MESSAGE, { taskId: 't1', content: 'msg', model: 'ds' }).ok, true);
  assert.equal(validatePayload(EVENT_TYPES.USER_MESSAGE, { taskId: 't1' }).ok, false);
  assert.equal(validatePayload(EVENT_TYPES.USER_MESSAGE, 123).ok, false);
});

test('validatePayload rejects type errors and missing fields', () => {
  assert.equal(validatePayload(EVENT_TYPES.PLAN_UPDATE, { stepNumber: 1 }).ok, false);
  assert.equal(validatePayload(EVENT_TYPES.KNOWLEDGE_GATHERED, { contributingSources: [{ source: 'a', relevance: 'bad' }] }).ok, false);
});
