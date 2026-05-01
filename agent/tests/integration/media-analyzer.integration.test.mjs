
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { execSync } from 'child_process';

describe('[R46-T3] Media Analyzer Integration', () => {
  const maPath = '/opt/rangerai-agent/worker/media-analyzer.mjs';

  it('media-analyzer.mjs exists', () => {
    assert.ok(fs.existsSync(maPath), 'media-analyzer.mjs should exist');
  });

  it('has frameCount and extractionMethod fields', () => {
    const code = fs.readFileSync(maPath, 'utf8');
    assert.ok(code.includes('frameCount'), 'Should have frameCount field');
    assert.ok(code.includes('extractionMethod'), 'Should have extractionMethod field');
  });

  it('has ffmpeg frame extraction', () => {
    const code = fs.readFileSync(maPath, 'utf8');
    assert.ok(code.includes('ffmpeg') || code.includes('ffprobe'), 'Should have ffmpeg integration');
  });

  it('ffmpeg is available', () => {
    try {
      const version = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
      assert.ok(version.includes('ffmpeg'), 'ffmpeg should be available');
    } catch (e) {
      assert.fail('ffmpeg not installed');
    }
  });

  it('has media_analyzed event type', () => {
    const esPath = '/opt/rangerai-agent/worker/event-stream.mjs';
    const code = fs.readFileSync(esPath, 'utf8');
    assert.ok(code.includes('media_analyzed'), 'event-stream should have media_analyzed');
  });

  it('registers analyze_video tool', () => {
    const toolsPath = '/opt/rangerai-agent/worker/tools/index.mjs';
    const code = fs.readFileSync(toolsPath, 'utf8');
    assert.ok(code.includes('analyze_video'), 'Should register analyze_video tool');
  });

  it('registers analyze_audio tool', () => {
    const toolsPath = '/opt/rangerai-agent/worker/tools/index.mjs';
    const code = fs.readFileSync(toolsPath, 'utf8');
    assert.ok(code.includes('analyze_audio'), 'Should register analyze_audio tool');
  });
});
