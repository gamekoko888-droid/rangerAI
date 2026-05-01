/**
 * Iter-34 Tests — Keyboard Shortcuts System
 * - useKeyboardShortcuts hook
 * - formatShortcut utility
 * - ChatPage integration
 * - MessageInput data-message-input attribute
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const clientSrc = join(__dirname, '..');
const hooksDir = join(clientSrc, 'hooks');

function readFile(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf-8');
}

// ─── useKeyboardShortcuts Hook ─────────────────────────────────
describe('useKeyboardShortcuts hook', () => {
  it('hook file exists', () => {
    expect(existsSync(join(hooksDir, 'useKeyboardShortcuts.ts'))).toBe(true);
  });

  it('exports useKeyboardShortcuts function', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('export function useKeyboardShortcuts');
  });

  it('exports formatShortcut utility', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('export function formatShortcut');
  });

  it('defines ShortcutDef interface with required fields', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('key: string');
    expect(src).toContain('mod?: boolean');
    expect(src).toContain('shift?: boolean');
    expect(src).toContain('alt?: boolean');
    expect(src).toContain('handler:');
    expect(src).toContain('description?: string');
    expect(src).toContain('skipInInput?: boolean');
  });

  it('uses useRef for stable shortcuts reference', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('useRef');
    expect(src).toContain('shortcutsRef');
  });

  it('registers keydown event listener', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain("'keydown'");
    expect(src).toContain('addEventListener');
    expect(src).toContain('removeEventListener');
  });

  it('checks for input/textarea focus to skip shortcuts', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('INPUT');
    expect(src).toContain('TEXTAREA');
    expect(src).toContain('isContentEditable');
  });

  it('supports metaKey and ctrlKey for cross-platform', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('metaKey');
    expect(src).toContain('ctrlKey');
  });

  it('calls preventDefault on matching shortcut', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain('e.preventDefault()');
  });
});

// ─── formatShortcut ────────────────────────────────────────────
describe('formatShortcut utility', () => {
  it('handles Escape key label', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain("'Escape'");
    expect(src).toContain("'Esc'");
  });

  it('handles Mac vs Windows modifier display', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain("'⌘'");
    expect(src).toContain("'Ctrl'");
  });

  it('handles shift modifier display', () => {
    const src = readFile(hooksDir, 'useKeyboardShortcuts.ts');
    expect(src).toContain("'⇧'");
    expect(src).toContain("'Shift'");
  });
});

// ─── ChatPage Integration ──────────────────────────────────────
describe('ChatPage keyboard shortcuts integration', () => {
  const chatPageSrc = readFile(join(clientSrc, 'pages'), 'ChatPage.tsx');

  it('imports useKeyboardShortcuts', () => {
    expect(chatPageSrc).toContain('useKeyboardShortcuts');
  });

  it('registers Ctrl+K shortcut for search', () => {
    expect(chatPageSrc).toContain("key: 'k'");
    expect(chatPageSrc).toContain('mod: true');
    expect(chatPageSrc).toContain('data-sidebar-search');
  });

  it('registers Ctrl+N shortcut for new chat', () => {
    expect(chatPageSrc).toContain("key: 'n'");
    expect(chatPageSrc).toContain('createNewChat');
  });

  it('registers Escape shortcut for closing panels', () => {
    expect(chatPageSrc).toContain("key: 'Escape'");
    expect(chatPageSrc).toContain('tagManagerOpen');
    expect(chatPageSrc).toContain('toggleFilePanel');
  });

  it('registers / shortcut for focusing message input', () => {
    expect(chatPageSrc).toContain("key: '/'");
    expect(chatPageSrc).toContain('skipInInput: true');
    expect(chatPageSrc).toContain('data-message-input');
  });

  it('uses useMemo for stable shortcuts array', () => {
    expect(chatPageSrc).toContain('useKeyboardShortcuts(useMemo');
  });
});

// ─── MessageInput data attribute ───────────────────────────────
describe('MessageInput data-message-input attribute', () => {
  const inputSrc = readFile(join(clientSrc, 'components', 'chat'), 'MessageInput.tsx');

  it('has data-message-input attribute on textarea', () => {
    expect(inputSrc).toContain('data-message-input');
  });
});
