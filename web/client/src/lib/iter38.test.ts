import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/* ─── Iter-38: Debounce / Throttle Optimization ─── */

const root = path.resolve(__dirname, '../../..');

function readSrc(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

describe('useDebounce hooks', () => {
  const src = readSrc('client/src/hooks/useDebounce.ts');

  it('exports useDebouncedValue', () => {
    expect(src).toContain('export function useDebouncedValue');
  });

  it('exports useDebouncedCallback', () => {
    expect(src).toContain('export function useDebouncedCallback');
  });

  it('exports useThrottledCallback', () => {
    expect(src).toContain('export function useThrottledCallback');
  });

  it('useDebouncedValue uses setTimeout internally', () => {
    expect(src).toContain('setTimeout');
    expect(src).toContain('clearTimeout');
  });

  it('useThrottledCallback tracks lastRunRef for leading edge', () => {
    expect(src).toContain('lastRunRef');
  });

  it('all hooks clean up timers on unmount', () => {
    // Each hook should have cleanup in useEffect return
    const cleanupCount = (src.match(/clearTimeout/g) || []).length;
    expect(cleanupCount).toBeGreaterThanOrEqual(3); // one per hook
  });
});

describe('useIsMobile hook', () => {
  const src = readSrc('client/src/hooks/useIsMobile.ts');

  it('exports useIsMobile', () => {
    expect(src).toContain('export function useIsMobile');
  });

  it('uses default breakpoint of 768', () => {
    expect(src).toContain('768');
  });

  it('implements throttled resize handler', () => {
    expect(src).toContain('resize');
    expect(src).toContain('setTimeout');
    expect(src).toContain('lastRunRef');
  });

  it('cleans up resize listener on unmount', () => {
    expect(src).toContain('removeEventListener');
    expect(src).toContain('clearTimeout');
  });
});

describe('TicketManager debounced search', () => {
  const src = readSrc('client/src/pages/TicketManager.tsx');

  it('imports useDebouncedValue', () => {
    expect(src).toContain("import { useDebouncedValue } from '@/hooks/useDebounce'");
  });

  it('uses debouncedSearch instead of raw search for API calls', () => {
    expect(src).toContain('useDebouncedValue(search, 300)');
    expect(src).toContain('debouncedSearch');
  });

  it('fetchData depends on debouncedSearch not raw search', () => {
    expect(src).toContain('[debouncedSearch, statusFilter]');
  });

  it('API params use debouncedSearch', () => {
    expect(src).toContain("if (debouncedSearch) params.set('search', debouncedSearch)");
  });
});

describe('KolManager debounced search', () => {
  const src = readSrc('client/src/pages/KolManager.tsx');

  it('imports useDebouncedValue', () => {
    expect(src).toContain("import { useDebouncedValue } from '@/hooks/useDebounce'");
  });

  it('uses debouncedSearch instead of raw search for API calls', () => {
    expect(src).toContain('useDebouncedValue(search, 300)');
    expect(src).toContain('debouncedSearch');
  });

  it('fetchData depends on debouncedSearch not raw search', () => {
    expect(src).toContain('[debouncedSearch, platformFilter]');
  });

  it('API params use debouncedSearch', () => {
    expect(src).toContain("if (debouncedSearch) params.set('search', debouncedSearch)");
  });
});

describe('ChatPage uses useIsMobile', () => {
  const src = readSrc('client/src/pages/ChatPage.tsx');

  it('imports useIsMobile hook', () => {
    expect(src).toContain("import { useIsMobile } from");
  });

  it('uses useIsMobile() instead of inline resize handler', () => {
    expect(src).toContain('useIsMobile()');
  });

  it('does NOT have inline window resize listener (visualViewport resize for keyboard offset is exempt)', () => {
    expect(src).not.toContain("window.addEventListener('resize'");
  });
});

describe('ModelSelector uses useIsMobile', () => {
  const src = readSrc('client/src/components/chat/ModelSelector.tsx');

  it('imports useIsMobile hook', () => {
    expect(src).toContain("import { useIsMobile } from");
  });

  it('uses useIsMobile() instead of inline resize handler', () => {
    expect(src).toContain('useIsMobile()');
  });

  it('does NOT have inline addEventListener resize', () => {
    expect(src).not.toContain("addEventListener('resize'");
  });
});
