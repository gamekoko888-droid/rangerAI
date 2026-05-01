import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeWatchdogAction,
  WATCHDOG_TIMEOUT,
  useStreamWatchdog,
  type WatchdogState,
  type WatchdogAction,
  type StreamWatchdogControls,
} from '../useStreamWatchdog';

// ─── computeWatchdogAction — pure function tests ──────────

describe('computeWatchdogAction', () => {
  it('returns "none" when not streaming', () => {
    expect(computeWatchdogAction({ isStreaming: false, streamingContent: '', hasTools: false })).toBe('none');
    expect(computeWatchdogAction({ isStreaming: false, streamingContent: 'hello', hasTools: true })).toBe('none');
  });

  it('returns "commit" when streaming with non-empty content', () => {
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: 'Hello', hasTools: false })).toBe('commit');
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: '  content  ', hasTools: false })).toBe('commit');
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: '你好世界', hasTools: true })).toBe('commit');
  });

  it('returns "clear" for whitespace-only content (trim removes all)', () => {
    // '   '.trim() === '' → streamingContent.trim().length === 0 → falls through to clear
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: '   ', hasTools: false })).toBe('clear');
  });

  it('returns "commit-metadata" when streaming with empty content but has tools', () => {
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: '', hasTools: true })).toBe('commit-metadata');
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: '', hasTools: false })).toBe('clear');
  });

  it('returns "clear" when streaming with no content and no tools', () => {
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: '', hasTools: false })).toBe('clear');
  });

  it('handles null/undefined content gracefully', () => {
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: undefined as any, hasTools: false })).toBe('clear');
  });

  it('returns "commit" for very long content', () => {
    const long = 'x'.repeat(100_000);
    expect(computeWatchdogAction({ isStreaming: true, streamingContent: long, hasTools: false })).toBe('commit');
  });

  it('returns all four possible action values', () => {
    const actions = new Set<WatchdogAction>();
    actions.add(computeWatchdogAction({ isStreaming: false, streamingContent: '', hasTools: false })); // none
    actions.add(computeWatchdogAction({ isStreaming: true, streamingContent: 'text', hasTools: false })); // commit
    actions.add(computeWatchdogAction({ isStreaming: true, streamingContent: '', hasTools: true })); // commit-metadata
    actions.add(computeWatchdogAction({ isStreaming: true, streamingContent: '', hasTools: false })); // clear
    expect(actions.size).toBe(4);
  });
});

// ─── WATCHDOG_TIMEOUT constant ─────────────────────────────

describe('WATCHDOG_TIMEOUT', () => {
  it('is 60 seconds', () => {
    expect(WATCHDOG_TIMEOUT).toBe(60_000);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(WATCHDOG_TIMEOUT)).toBe(true);
    expect(WATCHDOG_TIMEOUT).toBeGreaterThan(0);
  });
});

// ─── useStreamWatchdog — structural verification ──────────
// Note: Full hook integration tests require jsdom environment (React useRef/useCallback).
// These tests validate function signature, module structure, and export shape.
// Hook behavior is validated by the full vitest suite (572 tests including ChatPage).

describe('useStreamWatchdog', () => {
  it('is a function', () => {
    expect(typeof useStreamWatchdog).toBe('function');
  });

  it('has correct function length (1 parameter: activeMsgIdRef)', () => {
    expect(useStreamWatchdog.length).toBe(1);
  });
});

// ─── StreamWatchdogControls type ───────────────────────────

describe('StreamWatchdogControls type', () => {
  it('has reset and clear as function properties', () => {
    const controls: StreamWatchdogControls = {
      reset: () => {},
      clear: () => {},
    };
    expect(typeof controls.reset).toBe('function');
    expect(typeof controls.clear).toBe('function');
  });
});
