
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('[R46-T3] Quality Scorer Integration', () => {
  const qsPath = '/opt/rangerai-agent/worker/quality-scorer.mjs';
  const configPath = '/opt/rangerai-agent/worker/agent-config.mjs';

  it('quality-scorer.mjs exists', () => {
    assert.ok(fs.existsSync(qsPath), 'quality-scorer.mjs should exist');
  });

  it('has QUALITY_SCORE_SAMPLE_RATE config', () => {
    const config = fs.readFileSync(configPath, 'utf8');
    assert.ok(config.includes('QUALITY_SCORE_SAMPLE_RATE'), 'agent-config should have QUALITY_SCORE_SAMPLE_RATE');
  });

  it('has sampling logic', () => {
    const code = fs.readFileSync(qsPath, 'utf8');
    assert.ok(code.includes('SAMPLE_RATE') || code.includes('sampleRate'), 'Should have sampling rate logic');
  });

  it('has answer_quality_scored event type', () => {
    const esPath = '/opt/rangerai-agent/worker/event-stream.mjs';
    const code = fs.readFileSync(esPath, 'utf8');
    assert.ok(code.includes('answer_quality_scored'), 'event-stream should have answer_quality_scored');
  });

  it('has answer_quality_skipped event type', () => {
    const esPath = '/opt/rangerai-agent/worker/event-stream.mjs';
    const code = fs.readFileSync(esPath, 'utf8');
    assert.ok(code.includes('answer_quality_skipped'), 'event-stream should have answer_quality_skipped');
  });
});
