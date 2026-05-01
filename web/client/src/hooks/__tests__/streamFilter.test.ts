import { describe, it, expect, beforeEach } from 'vitest';
import { createFrontendStreamFilter, getStreamFilter, type StreamFilter } from '../streamFilter';

describe('createFrontendStreamFilter', () => {
  let filter: StreamFilter;

  beforeEach(() => {
    filter = createFrontendStreamFilter();
  });

  // ── Basic content passthrough ──

  it('passes normal text through unchanged', () => {
    expect(filter.filter('Hello world')).toBe('Hello world');
    expect(filter.filter('你好世界')).toBe('你好世界');
    expect(filter.filter('こんにちは')).toBe('こんにちは');
  });

  it('returns empty string for empty delta', () => {
    expect(filter.filter('')).toBe('');
  });

  // ── System directive filtering ──

  it('filters [SYSTEM_DIRECTIVE] lines', () => {
    expect(filter.filter('[SYSTEM_DIRECTIVE]')).toBe('');
    expect(filter.filter('[SYSTEM_DIRECTIVE] some args')).toBe('');
  });

  it('filters [SYSTEM_FORCE] lines', () => {
    expect(filter.filter('[SYSTEM_FORCE]')).toBe('');
    expect(filter.filter('[SYSTEM_FORCE] reroute=true')).toBe('');
  });

  it('filters [HIDDEN] lines', () => {
    expect(filter.filter('[HIDDEN]')).toBe('');
  });

  // ── Non-text content filtering ──

  it('filters [non-text content:...] markers (case-insensitive)', () => {
    expect(filter.filter('[non-text content: image]')).toBe('');
    expect(filter.filter('[non-text content: pdf]')).toBe('');
    expect(filter.filter('[Non-Text Content: anything]')).toBe('');
  });

  it('filters Assistant: [non-text content...] markers', () => {
    expect(filter.filter('Assistant: [non-text content: image]')).toBe('');
    expect(filter.filter('Assistant: [non-text content: chart]')).toBe('');
  });

  // ── Multi-line handling ──

  it('handles multi-line content — filters system lines, keeps normal lines', () => {
    const input = 'Hello world\n[SYSTEM_DIRECTIVE]\nGoodbye world';
    const result = filter.filter(input);
    // System directive lines are completely removed, not replaced with empty lines
    expect(result).toBe('Hello world\nGoodbye world');
  });

  it('multi-line with all system lines returns empty', () => {
    const input = '[SYSTEM_DIRECTIVE]\n[HIDDEN]\n[SYSTEM_FORCE]';
    const result = filter.filter(input);
    expect(result).toBe(''); // all lines filtered → join produces empty
  });

  it('multi-line with mixed content preserves structure', () => {
    const input = 'Line 1\n[SYSTEM_DIRECTIVE] secret\n[non-text content: image]\nLine 4\nLine 5';
    const result = filter.filter(input);
    // Line 1, 4, 5 pass through; 2 system lines become empty
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 4');
    expect(result).toContain('Line 5');
    expect(result).not.toContain('[SYSTEM_DIRECTIVE]');
    expect(result).not.toContain('[non-text content');
  });

  // ── flush() and reset() in v2 ──

  it('flush() always returns empty string (v2: no buffer)', () => {
    filter.filter('Hello');
    expect(filter.flush()).toBe('');
    filter.filter('[SYSTEM_DIRECTIVE]');
    expect(filter.flush()).toBe('');
  });

  it('reset() does not throw (v2: no buffer to reset)', () => {
    expect(() => filter.reset()).not.toThrow();
    // After reset, filter still works
    expect(filter.filter('Hello')).toBe('Hello');
  });

  // ── Edge cases ──

  it('handles consecutive newlines', () => {
    expect(filter.filter('Hello\n\n\nWorld')).toBe('Hello\n\n\nWorld');
  });

  it('handles very long content', () => {
    const long = 'A'.repeat(10000);
    expect(filter.filter(long)).toBe(long);
  });

  it('does not modify content that looks similar but is not a directive', () => {
    // Close but not exact match
    expect(filter.filter('[SYSTEM_DIRECTIVE_NOT_REAL]')).toBe('[SYSTEM_DIRECTIVE_NOT_REAL]');
    expect(filter.filter('[non-text content:')).toBe('[non-text content:'); // incomplete
    // Partial match of regex /^Assistant:\s*\[non-text content/i — still matches!
    expect(filter.filter('Assistant: [non-text content')).toBe('');
  });

  it('is case-sensitive for SYSTEM tags but case-insensitive for non-text content', () => {
    expect(filter.filter('[system_directive]')).toBe('[system_directive]'); // lowercase = not matched
    expect(filter.filter('[SYSTEM_DIRECTIVE]')).toBe(''); // uppercase = matched
    expect(filter.filter('[Non-Text Content: x]')).toBe(''); // case-insensitive
  });
});

describe('getStreamFilter', () => {
  it('returns the same singleton instance', () => {
    const a = getStreamFilter();
    const b = getStreamFilter();
    expect(a).toBe(b);
  });

  it('uses the singleton from createFrontendStreamFilter', () => {
    const singleton = getStreamFilter();
    expect(singleton.filter('Hello')).toBe('Hello');
    expect(singleton.filter('[SYSTEM_DIRECTIVE]')).toBe('');
  });
});
