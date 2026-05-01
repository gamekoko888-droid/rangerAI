/**
 * useStreamWatchdog — Streaming stall detection & recovery hook
 *
 * Extracted from useChatStore.tsx (Phase 2: watchdog extraction).
 * Monitors streaming activity via a 60s timeout. If no WebSocket events
 * arrive within the window, commits accumulated content before clearing
 * to prevent silent data loss from stalled streams.
 *
 * Dependencies:
 *   - useMessageStore (Zustand) — reads streaming state, calls streamEnd/clearStreaming
 *   - activeMsgIdRef (React ref) — cleared on watchdog trigger
 *   - localStorage — persistence cleanup on trigger
 *
 * Usage:
 *   const { reset, clear } = useStreamWatchdog(activeMsgIdRef);
 *   // Call reset() on every WS event, clear() on stream end/error
 */

import { useRef, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { useMessageStore } from '../stores/useMessageStore';

// ─── Constants ────────────────────────────────────────────
// Layer-3 fix: Increased from 30s to 60s to accommodate slow tool/reasoning steps.
export const WATCHDOG_TIMEOUT = 60_000; // 60 seconds

// ─── Pure helper: compute watchdog action from streaming state ───

export interface WatchdogState {
  isStreaming: boolean;
  streamingContent: string;
  hasTools: boolean;
}

export type WatchdogAction = 'commit' | 'commit-metadata' | 'clear' | 'none';

/** Pure function — determines what to do when watchdog fires.
 *  Testable without React or Zustand. */
export function computeWatchdogAction(state: WatchdogState): WatchdogAction {
  if (!state.isStreaming) return 'none';
  if (state.streamingContent && state.streamingContent.trim().length > 0) return 'commit';
  if (state.hasTools) return 'commit-metadata';
  return 'clear';
}

// ─── LocalStorage keys (reused from useChatStore behavior) ───

const LS_KEYS = ['rangerai_activeMsgId', 'rangerai_activeChatId', 'rangerai_lastEventTs'] as const;

function clearWatchdogStorage(): void {
  for (const key of LS_KEYS) {
    try { localStorage.removeItem(key); } catch { /* sandboxed env */ }
  }
}

// ─── Hook ──────────────────────────────────────────────────

export interface StreamWatchdogControls {
  reset: () => void;
  clear: () => void;
}

/**
 * Returns { reset, clear } callbacks for streaming stall detection.
 * Call `reset()` on every WebSocket event during streaming;
 * call `clear()` when the stream ends normally or on error.
 *
 * @param activeMsgIdRef — React ref tracking the active message ID (cleared on watchdog trigger)
 */
export function useStreamWatchdog(
  activeMsgIdRef: MutableRefObject<string | null>,
): StreamWatchdogControls {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const state = useMessageStore.getState();
      const action = computeWatchdogAction({
        isStreaming: state.isStreaming,
        streamingContent: state.streamingContent,
        hasTools: state.activeTools.length > 0 || state.executionSteps.length > 0,
      });

      switch (action) {
        case 'commit':
          console.warn(
            '[StreamWatchdog] Triggered — committing %d chars before clearing.',
            state.streamingContent.length,
          );
          state.streamEnd(state.streamingContent, undefined);
          break;
        case 'commit-metadata':
          console.warn(
            '[StreamWatchdog] Triggered — no text but has tools/steps, committing metadata.',
          );
          state.streamEnd('', undefined);
          break;
        case 'clear':
          console.warn(
            '[StreamWatchdog] Triggered — no content at all, clearing state.',
          );
          state.clearStreaming();
          break;
        case 'none':
          break;
      }

      // eslint-disable-next-line no-param-reassign
      activeMsgIdRef.current = null;
      clearWatchdogStorage();
    }, WATCHDOG_TIMEOUT);
  }, [activeMsgIdRef, clear]);

  return { reset, clear };
}
