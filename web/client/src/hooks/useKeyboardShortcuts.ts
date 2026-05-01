import { useEffect, useCallback, useRef } from 'react';

export interface ShortcutDef {
  /** Key to match (e.g. 'k', 'n', 'Escape', '/') */
  key: string;
  /** Require Ctrl (Win/Linux) or Cmd (Mac) */
  mod?: boolean;
  /** Require Shift */
  shift?: boolean;
  /** Require Alt/Option */
  alt?: boolean;
  /** Handler function */
  handler: (e: KeyboardEvent) => void;
  /** Description for help display */
  description?: string;
  /** Skip when user is typing in an input/textarea */
  skipInInput?: boolean;
}

/**
 * Centralized keyboard shortcuts hook.
 * Registers global keydown listeners and dispatches to matching handlers.
 * 
 * Usage:
 *   useKeyboardShortcuts([
 *     { key: 'k', mod: true, handler: () => focusSearch(), description: 'Focus search' },
 *     { key: 'n', mod: true, handler: () => newChat(), description: 'New chat' },
 *     { key: 'Escape', handler: () => closePanel(), description: 'Close panel' },
 *   ]);
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDef[]) {
  // Use ref to always have latest shortcuts without re-registering listener
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInputFocused = target.tagName === 'INPUT' 
      || target.tagName === 'TEXTAREA' 
      || target.isContentEditable;

    for (const shortcut of shortcutsRef.current) {
      // Skip if user is typing and shortcut opts out
      if (shortcut.skipInInput && isInputFocused) continue;

      const isMod = e.metaKey || e.ctrlKey;
      const modMatch = shortcut.mod ? isMod : !isMod;
      const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = shortcut.alt ? e.altKey : !e.altKey;
      const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase() 
        || e.key === shortcut.key;

      if (keyMatch && modMatch && shiftMatch && altMatch) {
        e.preventDefault();
        shortcut.handler(e);
        return; // Only fire first match
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * Format a shortcut for display (e.g. "⌘K" on Mac, "Ctrl+K" on Windows)
 */
export function formatShortcut(shortcut: Pick<ShortcutDef, 'key' | 'mod' | 'shift' | 'alt'>): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const parts: string[] = [];
  
  if (shortcut.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (shortcut.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (shortcut.alt) parts.push(isMac ? '⌥' : 'Alt');
  
  const keyLabel = shortcut.key === 'Escape' ? 'Esc' 
    : shortcut.key === ' ' ? 'Space'
    : shortcut.key.length === 1 ? shortcut.key.toUpperCase() 
    : shortcut.key;
  
  parts.push(keyLabel);
  
  return isMac ? parts.join('') : parts.join('+');
}
