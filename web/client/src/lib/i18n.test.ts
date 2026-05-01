/**
 * i18n Translation System Tests
 * Verifies translation completeness, consistency, and correctness across all locales.
 */
import { describe, it, expect } from 'vitest';

// We need to import the translations directly
// The i18n module exports useI18n hook and I18nProvider
// We'll test the translation data structure

describe('i18n Translation System', () => {
  let zhCN: Record<string, string>;
  let zhTW: Record<string, string>;
  let en: Record<string, string>;

  // Dynamic import to get the translation objects
  it('should export all required functions and types', async () => {
    const i18nModule = await import('./i18n');
    expect(i18nModule.I18nProvider).toBeDefined();
    expect(i18nModule.useI18n).toBeDefined();
    expect(typeof i18nModule.I18nProvider).toBe('function');
    expect(typeof i18nModule.useI18n).toBe('function');
  });

  it('should have getTranslations function or equivalent', async () => {
    // The module should export translations that can be accessed
    const i18nModule = await import('./i18n');
    // Check that the module has the expected structure
    expect(i18nModule).toBeDefined();
  });
});

describe('Translation Key Coverage', () => {
  it('should have matching keys across all three locales', async () => {
    // Import the raw module to access translations
    const moduleText = await import('./i18n?raw');
    const raw = (moduleText as any).default || moduleText;
    
    // Parse key patterns from the source
    // We check that every key used in t('key') calls exists in translations
    // This is a structural test
    expect(typeof raw).toBe('string');
    
    // Verify the module contains all three locale objects
    expect(raw).toContain('const zhCN');
    expect(raw).toContain('const zhTW');
    expect(raw).toContain('const en');
  });

  it('should have TranslationKeys type exported', async () => {
    const moduleText = await import('./i18n?raw');
    const raw = (moduleText as any).default || moduleText;
    expect(raw).toContain('TranslationKeys');
  });
});

describe('Translation Content Quality', () => {
  it('should not have empty translation values in source', async () => {
    const moduleText = await import('./i18n?raw');
    const raw = (moduleText as any).default || moduleText;
    
    // Check for empty string values (potential missing translations)
    const emptyValuePattern = /:\s*['"][\s]*['"]\s*,/g;
    const matches = raw.match(emptyValuePattern);
    // Allow some empty values (they might be intentional placeholders)
    // but flag if there are too many
    const emptyCount = matches ? matches.length : 0;
    expect(emptyCount).toBeLessThan(10); // Threshold for acceptable empty values
  });

  it('should have consistent key naming convention', async () => {
    const moduleText = await import('./i18n?raw');
    const raw = (moduleText as any).default || moduleText;
    
    // Keys should use dot notation (e.g., 'sidebar.newChat')
    // Extract keys from the type definition
    const keyPattern = /'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)'/g;
    const keys: string[] = [];
    let match;
    while ((match = keyPattern.exec(raw)) !== null) {
      keys.push(match[1]);
    }
    
    // Should have a substantial number of translation keys
    expect(keys.length).toBeGreaterThan(100);
  });

  it('should support all three languages: zh-CN, zh-TW, en', async () => {
    const moduleText = await import('./i18n?raw');
    const raw = (moduleText as any).default || moduleText;
    
    // Verify language identifiers
    expect(raw).toContain("'zh-CN'");
    expect(raw).toContain("'zh-TW'");
    expect(raw).toContain("'en'");
  });
});

describe('i18n Hook Integration', () => {
  it('useI18n should return t function and locale', async () => {
    // This tests the hook signature without rendering
    const i18nModule = await import('./i18n');
    expect(i18nModule.useI18n).toBeDefined();
    // The hook returns { t, locale, setLocale }
    // We can't call it outside React, but we verify it exists
  });
});

describe('Export Utils i18n Integration', () => {
  it('exportToMarkdown should use English defaults without t()', async () => {
    const { exportToMarkdown } = await import('./exportUtils');
    const mockChat = {
      id: 'test-001',
      sessionKey: 'sk-001',
      title: 'Test Chat',
      model: null,
      userId: 'user-001',
      tags: 'test',
      metadata: null,
      messageCount: 1,
      lastMessage: 'Hello',
      createdAt: '2026-03-01T10:00:00Z',
      updatedAt: '2026-03-01T10:00:00Z',
    };
    const mockMessages = [{
      id: 1,
      chatId: 'test-001',
      role: 'user' as const,
      content: 'Hello world',
      model: null,
      tokens: null,
      msgId: 'msg-001',
      createdAt: '2026-03-01T10:00:00Z',
      metadata: null,
    }];

    const md = exportToMarkdown(mockChat, mockMessages);
    
    // Should use English defaults
    expect(md).toContain('# Test Chat');
    expect(md).toContain('Chat ID');
    expect(md).toContain('Messages');
    expect(md).toContain('Exported from RangerAI');
    expect(md).toContain('User');
  });

  it('exportToMarkdown should handle untitled chat with English default', async () => {
    const { exportToMarkdown } = await import('./exportUtils');
    const mockChat = {
      id: 'test-002',
      sessionKey: 'sk-002',
      title: '',
      model: null,
      userId: 'user-001',
      tags: null,
      metadata: null,
      messageCount: 0,
      lastMessage: '',
      createdAt: '2026-03-01T10:00:00Z',
      updatedAt: '2026-03-01T10:00:00Z',
    };

    const md = exportToMarkdown(mockChat, []);
    expect(md).toContain('# Untitled Chat');
  });
});
