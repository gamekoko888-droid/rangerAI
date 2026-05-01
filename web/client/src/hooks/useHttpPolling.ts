/**
 * useHttpPolling — HTTP polling fallback hook
 *
 * Extracted from useChatStore.tsx (Phase 3 refactor).
 * Provides incremental HTTP polling for task status when WebSocket is unavailable.
 *
 * @param onEvent     — callback to process each polled event
 * @param onCompleted — callback when task reaches terminal state (completed/failed)
 * @param onError     — callback for poll errors
 * @param intervalMs  — polling interval (default 3000ms)
 */

import { useCallback, useRef, useState } from 'react';
import * as api from '../lib/api';

interface UseHttpPollingOptions {
  onEvent: (event: Record<string, unknown>) => void;
  onCompleted: (msgId: string, status: string) => void;
  onError?: (err: unknown) => void;
  intervalMs?: number;
}

interface UseHttpPollingReturn {
  startPolling: (msgId: string) => void;
  stopPolling: () => void;
  isPolling: boolean;
}

export function useHttpPolling({
  onEvent,
  onCompleted,
  onError,
  intervalMs = 3000,
}: UseHttpPollingOptions): UseHttpPollingReturn {
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollSinceRef = useRef(0);
  const [isPolling, setIsPolling] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const processPolledEvents = useCallback(
    (events: Array<Record<string, unknown>>) => {
      for (const event of events) {
        onEvent(event);
      }
    },
    [onEvent],
  );

  const startPolling = useCallback(
    (msgId: string) => {
      stopPolling();
      if (!msgId) return;

      console.log(`[useHttpPolling] Starting HTTP polling for task ${msgId}`);
      pollSinceRef.current = 0;
      setIsPolling(true);

      const poll = async () => {
        try {
          const taskState = await api.pollTaskStatus(msgId, pollSinceRef.current);
          if (!taskState) {
            // Task not found — stop polling
            stopPolling();
            return;
          }

          if (taskState.events && taskState.events.length > 0) {
            processPolledEvents(taskState.events);
            const lastEvent = taskState.events[taskState.events.length - 1];
            pollSinceRef.current = (lastEvent._ts as number) ?? Date.now();
          }

          if (taskState.status === 'completed' || taskState.status === 'failed') {
            console.log(`[useHttpPolling] Task ${msgId} ${taskState.status} via HTTP polling`);
            stopPolling();
            onCompleted(msgId, taskState.status);
          }
        } catch (err) {
          console.warn('[useHttpPolling] HTTP poll error:', err);
          onError?.(err);
        }
      };

      // Execute first poll immediately, then set interval
      poll();
      pollTimerRef.current = setInterval(poll, intervalMs);
    },
    [stopPolling, processPolledEvents, onCompleted, onError, intervalMs],
  );

  return { startPolling, stopPolling, isPolling };
}
