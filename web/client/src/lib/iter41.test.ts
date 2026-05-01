/**
 * Iter-41 Tests — Scroll-to-bottom button & focus improvements
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(root, relPath), 'utf-8');
}

describe('Iter-41: Scroll-to-bottom button', () => {
  const messageListSrc = readFile('client/src/components/chat/MessageList.tsx');

  it('should have showScrollBtn state', () => {
    expect(messageListSrc).toContain('showScrollBtn');
    expect(messageListSrc).toContain('setShowScrollBtn');
  });

  it('should track near-bottom state and toggle button visibility', () => {
    expect(messageListSrc).toContain('setShowScrollBtn(!nearBottom)');
  });

  it('should render scroll-to-bottom button when showScrollBtn is true', () => {
    expect(messageListSrc).toContain('{showScrollBtn && (');
    expect(messageListSrc).toContain('scrollIntoView');
  });

  it('should have ArrowDown icon for scroll button', () => {
    expect(messageListSrc).toContain('ArrowDown');
  });

  it('should have aria-label for accessibility', () => {
    expect(messageListSrc).toContain("t('msg.scrollToBottom')");
  });

  it('should use relative positioning on container for absolute button', () => {
    expect(messageListSrc).toContain('className="relative flex-1 overflow-y-auto');
  });

  it('should have smooth scroll behavior', () => {
    expect(messageListSrc).toContain("behavior: 'smooth'");
  });

  it('should hide button after clicking', () => {
    expect(messageListSrc).toContain('setShowScrollBtn(false)');
  });

  it('should have animate-in for entrance animation', () => {
    expect(messageListSrc).toContain('animate-in fade-in slide-in-from-bottom');
  });
});

describe('Iter-41: Focus improvements', () => {
  const messageInputSrc = readFile('client/src/components/chat/MessageInput.tsx');

  it('should auto-focus textarea when switching chats on desktop', () => {
    expect(messageInputSrc).toContain('Auto-focus on desktop when switching chats');
    expect(messageInputSrc).toContain("setTimeout(() => textareaRef.current?.focus(), 100)");
  });

  it('should only auto-focus on desktop (width >= 768)', () => {
    expect(messageInputSrc).toContain('window.innerWidth >= 768');
  });

  it('should focus when streaming ends', () => {
    expect(messageInputSrc).toContain('!isStreaming && window.innerWidth >= 768');
  });
});

describe('Iter-41: i18n keys', () => {
  const i18nSrc = readFile('client/src/lib/i18n.tsx');

  it('should have msg.scrollToBottom key in TranslationKeys', () => {
    expect(i18nSrc).toContain("'msg.scrollToBottom': string;");
  });

  it('should have msg.scrollToBottom in zh-CN', () => {
    expect(i18nSrc).toContain("'msg.scrollToBottom': '滚动到底部'");
  });

  it('should have msg.scrollToBottom in zh-TW', () => {
    expect(i18nSrc).toContain("'msg.scrollToBottom': '捲動到底部'");
  });

  it('should have msg.scrollToBottom in en', () => {
    expect(i18nSrc).toContain("'msg.scrollToBottom': 'Scroll to bottom'");
  });
});
