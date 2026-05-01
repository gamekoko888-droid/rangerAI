/**
 * Iter-33 Tests — Error Boundary & Network Status
 * - useNetworkStatus hook
 * - NetworkStatusBar component
 * - ErrorBoundary improvements
 * - i18n network keys
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const clientSrc = join(__dirname, '..');
const hooksDir = join(clientSrc, 'hooks');
const componentsDir = join(clientSrc, 'components');

function readFile(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8');
}

// ─── useNetworkStatus Hook ─────────────────────────────────────
describe('useNetworkStatus hook', () => {
  it('hook file exists', () => {
    expect(existsSync(join(hooksDir, 'useNetworkStatus.ts'))).toBe(true);
  });

  it('exports useNetworkStatus function', () => {
    const src = readFile(hooksDir, 'useNetworkStatus.ts');
    expect(src).toContain('export function useNetworkStatus');
  });

  it('uses navigator.onLine for initial state', () => {
    const src = readFile(hooksDir, 'useNetworkStatus.ts');
    expect(src).toContain('navigator.onLine');
  });

  it('listens to online/offline events', () => {
    const src = readFile(hooksDir, 'useNetworkStatus.ts');
    expect(src).toContain("'online'");
    expect(src).toContain("'offline'");
    expect(src).toContain('addEventListener');
    expect(src).toContain('removeEventListener');
  });

  it('returns isOnline, wasOffline, and lastOnlineAt', () => {
    const src = readFile(hooksDir, 'useNetworkStatus.ts');
    expect(src).toContain('isOnline');
    expect(src).toContain('wasOffline');
    expect(src).toContain('lastOnlineAt');
  });

  it('has auto-dismiss for wasOffline after timeout', () => {
    const src = readFile(hooksDir, 'useNetworkStatus.ts');
    expect(src).toContain('setTimeout');
    expect(src).toContain('setWasOffline(false)');
  });
});

// ─── NetworkStatusBar Component ────────────────────────────────
describe('NetworkStatusBar component', () => {
  it('component file exists', () => {
    expect(existsSync(join(componentsDir, 'NetworkStatusBar.tsx'))).toBe(true);
  });

  it('imports useNetworkStatus hook', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('useNetworkStatus');
  });

  it('imports i18n for translations', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('useI18n');
  });

  it('has role=alert for accessibility', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('role="alert"');
  });

  it('has aria-live=assertive for screen readers', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('aria-live="assertive"');
  });

  it('uses WifiOff and Wifi icons', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('WifiOff');
    expect(src).toContain('Wifi');
  });

  it('uses fixed positioning with high z-index', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('fixed');
    expect(src).toContain('z-[9999]');
  });

  it('shows different colors for online vs offline', () => {
    const src = readFile(componentsDir, 'NetworkStatusBar.tsx');
    expect(src).toContain('bg-emerald');
    expect(src).toContain('bg-destructive');
  });
});

// ─── ErrorBoundary ─────────────────────────────────────────────
describe('ErrorBoundary component', () => {
  it('component file exists', () => {
    expect(existsSync(join(componentsDir, 'ErrorBoundary.tsx'))).toBe(true);
  });

  it('has getDerivedStateFromError', () => {
    const src = readFile(componentsDir, 'ErrorBoundary.tsx');
    expect(src).toContain('getDerivedStateFromError');
  });

  it('has componentDidCatch for logging', () => {
    const src = readFile(componentsDir, 'ErrorBoundary.tsx');
    expect(src).toContain('componentDidCatch');
  });

  it('has fallback prop support', () => {
    const src = readFile(componentsDir, 'ErrorBoundary.tsx');
    expect(src).toContain('fallback');
  });

  it('shows error stack in fallback UI', () => {
    const src = readFile(componentsDir, 'ErrorBoundary.tsx');
    expect(src).toContain('error?.stack');
  });

  it('has reload button in fallback', () => {
    const src = readFile(componentsDir, 'ErrorBoundary.tsx');
    expect(src).toContain('window.location.reload()');
  });
});

// ─── App Integration ───────────────────────────────────────────
describe('App integration', () => {
  const appSrc = readFile(clientSrc, 'App.tsx');

  it('App.tsx imports NetworkStatusBar', () => {
    expect(appSrc).toContain('NetworkStatusBar');
  });

  it('App.tsx renders NetworkStatusBar', () => {
    expect(appSrc).toContain('<NetworkStatusBar');
  });

  it('App.tsx wraps with ErrorBoundary', () => {
    expect(appSrc).toContain('<ErrorBoundary>');
  });
});

// ─── i18n Network Keys ────────────────────────────────────────
describe('i18n network keys', () => {
  const i18nSrc = readFile(join(clientSrc, 'lib'), 'i18n.tsx');

  it('has network.offline key in TranslationKeys', () => {
    expect(i18nSrc).toContain("'network.offline': string");
  });

  it('has network.backOnline key in TranslationKeys', () => {
    expect(i18nSrc).toContain("'network.backOnline': string");
  });

  it('has zh-CN translations for network keys', () => {
    expect(i18nSrc).toContain('网络连接已断开');
    expect(i18nSrc).toContain('网络已恢复连接');
  });

  it('has zh-TW translations for network keys', () => {
    expect(i18nSrc).toContain('網路連線已中斷');
    expect(i18nSrc).toContain('網路已恢復連線');
  });

  it('has en translations for network keys', () => {
    expect(i18nSrc).toContain('Network connection lost');
    expect(i18nSrc).toContain('Back online');
  });
});
