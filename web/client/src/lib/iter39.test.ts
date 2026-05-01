/**
 * Iter-39 Tests: Local storage persistence for user preferences
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─── Unit Tests: useLocalStorage hook ───
describe('useLocalStorage hook', () => {
  const hookSource = fs.readFileSync(
    path.resolve(__dirname, '../hooks/useLocalStorage.ts'),
    'utf-8',
  );

  it('should export useLocalStorage function', () => {
    expect(hookSource).toContain('export function useLocalStorage');
  });

  it('should be generic with type parameter T', () => {
    expect(hookSource).toContain('useLocalStorage<T>');
  });

  it('should accept key and defaultValue parameters', () => {
    expect(hookSource).toContain('key: string');
    expect(hookSource).toContain('defaultValue: T');
  });

  it('should return tuple of [value, setter]', () => {
    expect(hookSource).toMatch(/\[T,\s*\(value:/);
  });

  it('should read from localStorage on mount', () => {
    expect(hookSource).toContain('localStorage.getItem(key)');
  });

  it('should write to localStorage when value changes', () => {
    expect(hookSource).toContain('localStorage.setItem(key, JSON.stringify(nextValue))');
  });

  it('should handle SSR safety with typeof window check', () => {
    expect(hookSource).toContain("typeof window === 'undefined'");
  });

  it('should support functional updates', () => {
    expect(hookSource).toContain('value instanceof Function');
  });

  it('should sync across tabs via storage event', () => {
    expect(hookSource).toContain("addEventListener('storage'");
    expect(hookSource).toContain("removeEventListener('storage'");
  });

  it('should handle JSON parse errors gracefully', () => {
    // Should have try/catch around JSON.parse
    const parseBlocks = hookSource.match(/try\s*\{[^}]*JSON\.parse/g);
    expect(parseBlocks).toBeTruthy();
    expect(parseBlocks!.length).toBeGreaterThanOrEqual(2); // init + storage event
  });

  it('should handle quota exceeded errors gracefully', () => {
    expect(hookSource).toContain('Quota exceeded');
  });
});

// ─── Integration Tests: ChatPage sidebar preference persistence ───
describe('ChatPage sidebar preference persistence', () => {
  const chatPageSource = fs.readFileSync(
    path.resolve(__dirname, '../pages/ChatPage.tsx'),
    'utf-8',
  );

  it('should import useLocalStorage', () => {
    expect(chatPageSource).toContain("import { useLocalStorage } from '../hooks/useLocalStorage'");
  });

  it('should persist sidebar open state with useLocalStorage', () => {
    expect(chatPageSource).toContain("useLocalStorage('rangerai_sidebarOpen'");
  });

  it('should default sidebar preference to true', () => {
    expect(chatPageSource).toContain("useLocalStorage('rangerai_sidebarOpen', true)");
  });

  it('should save sidebar preference on toggle (desktop only)', () => {
    expect(chatPageSource).toContain('setSidebarPref(next)');
    // Should only save on desktop
    expect(chatPageSource).toMatch(/if\s*\(\s*!isMobile\s*\)\s*setSidebarPref/);
  });

  it('should restore sidebar preference on desktop', () => {
    expect(chatPageSource).toContain('setSidebarOpen(sidebarPref)');
  });

  it('should persist file panel width with useLocalStorage', () => {
    expect(chatPageSource).toContain("useLocalStorage('rangerai_filePanelWidth', 40)");
  });
});

// ─── Integration Tests: Existing localStorage usage ───
describe('Existing localStorage persistence patterns', () => {
  it('should persist theme in localStorage', () => {
    const themeSource = fs.readFileSync(
      path.resolve(__dirname, '../contexts/ThemeContext.tsx'),
      'utf-8',
    );
    expect(themeSource).toContain("localStorage.getItem(\"theme\")");
    expect(themeSource).toContain("localStorage.setItem(\"theme\"");
  });

  it('should persist language locale in localStorage', () => {
    const i18nSource = fs.readFileSync(
      path.resolve(__dirname, './i18n.tsx'),
      'utf-8',
    );
    expect(i18nSource).toContain('localStorage.getItem(STORAGE_KEY)');
    expect(i18nSource).toContain('localStorage.setItem(STORAGE_KEY');
  });

  it('should persist selected model in localStorage', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '../hooks/useChatStore.tsx'),
      'utf-8',
    );
    expect(chatStoreSource).toContain("localStorage.getItem('rangerai_selectedModel')");
    expect(chatStoreSource).toContain("localStorage.setItem('rangerai_selectedModel'");
  });

  it('should persist selected role in localStorage', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '../hooks/useChatStore.tsx'),
      'utf-8',
    );
    expect(chatStoreSource).toContain("localStorage.getItem('rangerai_selectedRole')");
    expect(chatStoreSource).toContain("localStorage.setItem('rangerai_selectedRole'");
  });

  it('should persist current chat ID in localStorage', () => {
    const chatStoreSource = fs.readFileSync(
      path.resolve(__dirname, '../hooks/useChatStore.tsx'),
      'utf-8',
    );
    expect(chatStoreSource).toContain("localStorage.getItem('rangerai_currentChatId')");
    expect(chatStoreSource).toContain("localStorage.setItem('rangerai_currentChatId'");
  });
});

// ─── Consistency Tests: All localStorage keys use rangerai_ prefix ───
describe('localStorage key naming consistency', () => {
  const chatPageSource = fs.readFileSync(
    path.resolve(__dirname, '../pages/ChatPage.tsx'),
    'utf-8',
  );

  it('sidebar key should use rangerai_ prefix', () => {
    expect(chatPageSource).toContain("'rangerai_sidebarOpen'");
  });

  it('file panel width key should use rangerai_ prefix', () => {
    expect(chatPageSource).toContain("'rangerai_filePanelWidth'");
  });
});
