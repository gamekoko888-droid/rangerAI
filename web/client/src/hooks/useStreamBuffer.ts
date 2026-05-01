/**
 * useStreamBuffer — Word-level buffered smooth streaming output (v25.0)
 *
 * Instead of rendering every single token immediately (causing character "popping"),
 * this hook accumulates tokens in a buffer and flushes them in word/phrase-sized
 * batches at regular intervals, creating a smooth "flowing" visual effect.
 *
 * Strategy:
 *   - Tokens arrive via appendStream → stored in a raw buffer
 *   - A RAF-based flush loop runs at ~40ms intervals
 *   - Each flush moves content from buffer → display, preferring word boundaries
 *   - When buffer is empty, the loop idles (no wasted cycles)
 *   - On stream end, all remaining buffer is flushed immediately
 */
import { useRef, useCallback, useEffect } from 'react';

// ─── Configuration ─────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 40;       // Target flush interval (25fps)
const MIN_FLUSH_CHARS = 2;          // Minimum chars per flush (avoid single-char flushes)
const MAX_FLUSH_CHARS = 80;         // Maximum chars per flush (prevent large jumps)
const WORD_BOUNDARY_REGEX = /[\s,.\u3002\uff0c\uff01\uff1f\u3001\uff1b\uff1a\u201c\u201d\u2018\u2019\u300a\u300b\u3010\u3011\uff08\uff09]/;

/**
 * Find the best split point in a string, preferring word/phrase boundaries.
 * For CJK text, each character IS a word, so we flush more aggressively.
 */
function findFlushPoint(buffer: string, maxChars: number): number {
  if (buffer.length <= maxChars) return buffer.length;

  // Look for the last word boundary within maxChars
  let bestSplit = -1;
  for (let i = Math.min(buffer.length, maxChars) - 1; i >= MIN_FLUSH_CHARS; i--) {
    if (WORD_BOUNDARY_REGEX.test(buffer[i])) {
      bestSplit = i + 1; // Include the boundary character
      break;
    }
  }

  // If no boundary found, just split at maxChars
  return bestSplit > MIN_FLUSH_CHARS ? bestSplit : Math.min(maxChars, buffer.length);
}

export interface StreamBufferControls {
  /** Push new content into the buffer (called on each stream_chunk) */
  push: (content: string) => void;
  /** Flush all remaining buffer immediately (called on stream_end) */
  flushAll: () => void;
  /** Reset the buffer (called on stream_start or new message) */
  reset: () => void;
}

/**
 * Hook that provides buffered streaming output.
 * @param onFlush - Callback invoked with each batch of content to render.
 *                  Typically calls useMessageStore.getState().appendStream(batch)
 */
export function useStreamBuffer(onFlush: (content: string) => void): StreamBufferControls {
  const bufferRef = useRef('');
  const rafIdRef = useRef<number | null>(null);
  const lastFlushTimeRef = useRef(0);
  const isRunningRef = useRef(false);
  const onFlushRef = useRef(onFlush);

  // Keep onFlush ref up to date without causing re-renders
  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  // ─── Flush Loop ────────────────────────────────────────────
  const flushLoop = useCallback(() => {
    const now = performance.now();
    const elapsed = now - lastFlushTimeRef.current;

    if (bufferRef.current.length > 0 && elapsed >= FLUSH_INTERVAL_MS) {
      const flushPoint = findFlushPoint(bufferRef.current, MAX_FLUSH_CHARS);
      const batch = bufferRef.current.slice(0, flushPoint);
      bufferRef.current = bufferRef.current.slice(flushPoint);
      lastFlushTimeRef.current = now;

      if (batch) {
        onFlushRef.current(batch);
      }
    }

    // Continue loop if there's still content or we're still streaming
    if (isRunningRef.current || bufferRef.current.length > 0) {
      rafIdRef.current = requestAnimationFrame(flushLoop);
    } else {
      rafIdRef.current = null;
    }
  }, []);

  // ─── Start the flush loop if not already running ───────────
  const ensureRunning = useCallback(() => {
    if (rafIdRef.current === null) {
      lastFlushTimeRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame(flushLoop);
    }
  }, [flushLoop]);

  // ─── Public API ────────────────────────────────────────────
  const push = useCallback((content: string) => {
    bufferRef.current += content;
    isRunningRef.current = true;
    ensureRunning();
  }, [ensureRunning]);

  const flushAll = useCallback(() => {
    isRunningRef.current = false;
    if (bufferRef.current.length > 0) {
      const remaining = bufferRef.current;
      bufferRef.current = '';
      onFlushRef.current(remaining);
    }
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    bufferRef.current = '';
    isRunningRef.current = false;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return { push, flushAll, reset };
}
