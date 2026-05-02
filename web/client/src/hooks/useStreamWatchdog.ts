/**
 * useStreamWatchdog — Streaming stall detection & self-healing hook
 *
 * v2.0: Enhanced with backend status query (P0 self-healing)
 * 
 * When streaming stalls (no WS events for WATCHDOG_TIMEOUT):
 * 1. First, query backend /api/task-status to check if task actually completed
 * 2. If backend says completed → fetch the reply and render it (self-heal)
 * 3. If backend says still running → extend timeout and wait
 * 4. If backend unreachable → commit whatever content we have (original behavior)
 *
 * This prevents the "task completed but frontend stuck" bug caused by
 * IPC race conditions between task_complete and frontend_event.
 */
import { useRef, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { useMessageStore } from '../stores/useMessageStore';

// ─── Constants ────────────────────────────────────────────
// Primary watchdog: 60s for normal streaming stalls
export const WATCHDOG_TIMEOUT = 60_000;
// Extended timeout after backend says "still running": 120s additional
export const EXTENDED_TIMEOUT = 120_000;
// Max retries for backend status query
const MAX_STATUS_RETRIES = 2;

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

// ─── Backend status query ───────────────────────────────────
interface TaskStatusResponse {
  status: 'running' | 'completed' | 'failed' | 'unknown';
  content?: string;
  model?: string;
  error?: string;
}

async function queryTaskStatus(msgId: string): Promise<TaskStatusResponse> {
  try {
    const res = await fetch(`/api/task-status?msgId=${encodeURIComponent(msgId)}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(5000), // 5s timeout for status query
    });
    if (!res.ok) return { status: 'unknown' };
    return await res.json();
  } catch (e) {
    console.warn('[StreamWatchdog] Backend status query failed:', e);
    return { status: 'unknown' };
  }
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
 * Returns { reset, clear } callbacks for streaming stall detection with self-healing.
 * Call `reset()` on every WebSocket event during streaming;
 * call `clear()` when the stream ends normally or on error.
 */
export function useStreamWatchdog(
  activeMsgIdRef: MutableRefObject<string | null>,
): StreamWatchdogControls {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    retryCountRef.current = 0;
  }, []);

  const handleWatchdogTrigger = useCallback(async () => {
    const state = useMessageStore.getState();
    if (!state.isStreaming) return; // Already resolved

    const msgId = activeMsgIdRef.current;
    
    // ─── P0 Self-Healing: Query backend before giving up ───
    if (msgId && retryCountRef.current < MAX_STATUS_RETRIES) {
      retryCountRef.current++;
      console.warn(
        '[StreamWatchdog] Timeout triggered (attempt %d/%d). Querying backend for msgId=%s...',
        retryCountRef.current, MAX_STATUS_RETRIES, msgId
      );

      const taskStatus = await queryTaskStatus(msgId);
      
      switch (taskStatus.status) {
        case 'completed': {
          // Backend has the reply! Self-heal by rendering it.
          console.warn('[StreamWatchdog] Self-heal: Backend says task completed. Rendering reply.');
          const content = taskStatus.content || state.streamingContent || '[Response recovered]';
          state.streamEnd(content, taskStatus.model);
          activeMsgIdRef.current = null;
          clearWatchdogStorage();
          retryCountRef.current = 0;
          return;
        }
        case 'running': {
          // Task still running — extend timeout
          console.warn('[StreamWatchdog] Backend says still running. Extending timeout by %ds.', EXTENDED_TIMEOUT / 1000);
          timerRef.current = setTimeout(handleWatchdogTrigger, EXTENDED_TIMEOUT);
          return;
        }
        case 'failed': {
          // Task failed on backend
          console.warn('[StreamWatchdog] Backend says task failed:', taskStatus.error);
          state.setError(taskStatus.error || 'Task failed on server');
          state.clearStreaming();
          activeMsgIdRef.current = null;
          clearWatchdogStorage();
          retryCountRef.current = 0;
          return;
        }
        case 'unknown':
        default: {
          // Backend unreachable or unknown — fall through to original behavior
          console.warn('[StreamWatchdog] Backend status unknown. Will retry or fallback.');
          if (retryCountRef.current < MAX_STATUS_RETRIES) {
            // Retry after shorter interval
            timerRef.current = setTimeout(handleWatchdogTrigger, 15_000);
            return;
          }
          break;
        }
      }
    }

    // ─── Original fallback behavior (commit whatever we have) ───
    const action = computeWatchdogAction({
      isStreaming: state.isStreaming,
      streamingContent: state.streamingContent,
      hasTools: state.activeTools.length > 0 || state.executionSteps.length > 0,
    });

    switch (action) {
      case 'commit':
        console.warn(
          '[StreamWatchdog] Final fallback — committing %d chars before clearing.',
          state.streamingContent.length,
        );
        state.streamEnd(state.streamingContent, undefined);
        break;
      case 'commit-metadata':
        console.warn(
          '[StreamWatchdog] Final fallback — no text but has tools/steps, committing metadata.',
        );
        state.streamEnd('', undefined);
        break;
      case 'clear':
        console.warn(
          '[StreamWatchdog] Final fallback — no content at all, clearing state.',
        );
        state.clearStreaming();
        break;
      case 'none':
        break;
    }

    activeMsgIdRef.current = null;
    clearWatchdogStorage();
    retryCountRef.current = 0;
  }, [activeMsgIdRef, clear]);

  const reset = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    retryCountRef.current = 0; // Reset retry count on activity
    timerRef.current = setTimeout(handleWatchdogTrigger, WATCHDOG_TIMEOUT);
  }, [handleWatchdogTrigger]);

  return { reset, clear };
}
