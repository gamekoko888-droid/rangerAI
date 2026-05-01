import { useState, useCallback, useEffect } from 'react';

/**
 * Type-safe localStorage hook with SSR safety and cross-tab sync.
 *
 * Usage:
 *   const [value, setValue] = useLocalStorage('key', defaultValue);
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Read from localStorage on mount (SSR-safe)
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const item = localStorage.getItem(key);
      return item !== null ? (JSON.parse(item) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  // Write to localStorage whenever value changes
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const nextValue = value instanceof Function ? value(prev) : value;
        try {
          localStorage.setItem(key, JSON.stringify(nextValue));
        } catch {
          // Quota exceeded or other storage error — silently ignore
        }
        return nextValue;
      });
    },
    [key],
  );

  // Sync across tabs via storage event
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      try {
        const newValue = e.newValue !== null ? (JSON.parse(e.newValue) as T) : defaultValue;
        setStoredValue(newValue);
      } catch {
        // Ignore parse errors
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [key, defaultValue]);

  return [storedValue, setValue];
}
