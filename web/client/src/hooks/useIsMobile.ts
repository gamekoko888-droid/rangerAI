import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Centralized mobile detection hook with throttled resize listener.
 * Replaces scattered `window.addEventListener('resize', ...)` patterns.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  const lastRunRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(() => {
    const now = Date.now();
    const remaining = 150 - (now - lastRunRef.current); // 150ms throttle
    if (remaining <= 0) {
      lastRunRef.current = now;
      setIsMobile(window.innerWidth < breakpoint);
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        lastRunRef.current = Date.now();
        timerRef.current = null;
        setIsMobile(window.innerWidth < breakpoint);
      }, remaining);
    }
  }, [breakpoint]);

  useEffect(() => {
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('resize', check);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [check]);

  return isMobile;
}
