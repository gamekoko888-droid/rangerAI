import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Debounced value hook — delays updating the returned value until
 * the input has stopped changing for `delay` ms.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Debounced callback hook — wraps a function so it only fires
 * after `delay` ms of inactivity.
 */
export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
): (...args: Parameters<T>) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const debouncedFn = useCallback(
    (...args: Parameters<T>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => callbackRef.current(...args), delay);
    },
    [delay],
  );

  // Cleanup on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return debouncedFn;
}

/**
 * Throttled callback hook — ensures the function fires at most
 * once every `interval` ms (leading edge).
 */
export function useThrottledCallback<T extends (...args: any[]) => any>(
  callback: T,
  interval: number,
): (...args: Parameters<T>) => void {
  const lastRunRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const throttledFn = useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      const remaining = interval - (now - lastRunRef.current);
      if (remaining <= 0) {
        lastRunRef.current = now;
        callbackRef.current(...args);
      } else if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          lastRunRef.current = Date.now();
          timerRef.current = null;
          callbackRef.current(...args);
        }, remaining);
      }
    },
    [interval],
  );

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return throttledFn;
}
