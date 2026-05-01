/**
 * Iter-28 Tests — Performance & Accessibility
 * - Image lazy loading across components
 * - Keyboard navigation for Sidebar chat list
 * - aria-label / role attributes for accessibility
 * - Web Vitals integration (from Iter-27)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const clientSrc = join(__dirname, '..');

function readComponent(relativePath: string): string {
  return readFileSync(join(clientSrc, relativePath), 'utf-8');
}

// ─── Image Lazy Loading ────────────────────────────────────────
describe('Image lazy loading', () => {
  it('MessageList: all img tags in ImagePreview have loading="lazy"', () => {
    const src = readComponent('components/chat/MessageList.tsx');
    // Find the ImagePreview function and check its img tags
    const imagePreviewMatch = src.match(/function ImagePreview[\s\S]*?^}/m);
    if (imagePreviewMatch) {
      const imgTags = imagePreviewMatch[0].match(/<img[\s\S]*?\/>/g) || [];
      const thumbnailImgs = imgTags.filter(tag => !tag.includes('max-w-[90vw]')); // exclude lightbox full-size
      thumbnailImgs.forEach(tag => {
        expect(tag).toContain('loading="lazy"');
      });
    }
  });

  it('MessageList: inline image thumbnails have loading="lazy"', () => {
    const src = readComponent('components/chat/MessageList.tsx');
    // Find img tags with max-h-32 (inline thumbnails in tool cards)
    const inlineImgs = src.match(/<img[^>]*max-h-32[^>]*>/g) || [];
    inlineImgs.forEach(tag => {
      expect(tag).toContain('loading="lazy"');
    });
  });

  it('AIFileOutput: image preview has loading="lazy"', () => {
    const src = readComponent('components/chat/AIFileOutput.tsx');
    const imgTags = src.match(/<img[\s\S]*?\/>/g) || [];
    expect(imgTags.length).toBeGreaterThan(0);
    imgTags.forEach(tag => {
      expect(tag).toContain('loading="lazy"');
    });
  });

  it('MessageAttachments: thumbnail images have loading="lazy"', () => {
    const src = readComponent('components/chat/MessageAttachments.tsx');
    const imgTags = src.match(/<img[\s\S]*?\/>/g) || [];
    const thumbnailImgs = imgTags.filter(tag => tag.includes('object-cover'));
    thumbnailImgs.forEach(tag => {
      expect(tag).toContain('loading="lazy"');
    });
  });

  it('FilePanel: image preview has loading="lazy"', () => {
    const src = readComponent('components/chat/FilePanel.tsx');
    const imgTags = src.match(/<img[\s\S]*?\/>/g) || [];
    expect(imgTags.length).toBeGreaterThan(0);
    imgTags.forEach(tag => {
      expect(tag).toContain('loading="lazy"');
    });
  });
});

// ─── Keyboard Navigation ───────────────────────────────────────
describe('Keyboard navigation', () => {
  it('Sidebar: chat list container has role="listbox"', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain('role="listbox"');
  });

  it('Sidebar: chat list container has aria-label', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toMatch(/role="listbox"[\s\S]*?aria-label=/);
  });

  it('Sidebar: chat items have role="option"', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain('role="option"');
  });

  it('Sidebar: chat items have aria-selected', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain('aria-selected={isActive}');
  });

  it('Sidebar: chat items have tabIndex for focus management', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain('tabIndex={isActive ? 0 : -1}');
  });

  it('Sidebar: chat list has ArrowDown keyboard handler', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain("e.key === 'ArrowDown'");
  });

  it('Sidebar: chat list has ArrowUp keyboard handler', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain("e.key === 'ArrowUp'");
  });

  it('Sidebar: chat items have focus-visible ring style', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toContain('focus-visible:ring-1');
  });
});

// ─── Accessibility (aria-labels) ───────────────────────────────
describe('Accessibility: aria-labels', () => {
  it('ChatPage: sidebar toggle button has aria-label', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toMatch(/aria-label=\{sidebarOpen/);
  });

  it('ChatPage: tag manager button has aria-label', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toMatch(/aria-label=\{t\('chatPage\.manageTags'\)/);
  });

  it('ChatPage: file panel toggle has aria-label', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toMatch(/aria-label=\{isFilePanelOpen/);
  });

  it('ChatPage: export button has aria-label', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toMatch(/aria-label=\{t\('chatPage\.exportConversation'\)/);
  });

  it('ChatPage: connection status has role="status" and aria-live', () => {
    const src = readComponent('pages/ChatPage.tsx');
    expect(src).toContain('role="status"');
    expect(src).toContain('aria-live="polite"');
  });

  it('Sidebar: new chat button has aria-label', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toMatch(/aria-label=\{t\('sidebar\.newChat'\)/);
  });

  it('Sidebar: rename button has aria-label', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toMatch(/aria-label=\{t\('sidebar\.rename'\)/);
  });

  it('Sidebar: delete button has aria-label', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toMatch(/aria-label=\{t\('sidebar\.delete'\)/);
  });

  it('Sidebar: logout button has aria-label', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toMatch(/aria-label=\{t\('sidebar\.logout'\)/);
  });

  it('Sidebar: batch mode button has aria-label', () => {
    const src = readComponent('components/chat/Sidebar.tsx');
    expect(src).toMatch(/aria-label=\{batchMode/);
  });

  it('LoginPage: error message has role="alert"', () => {
    const src = readComponent('pages/LoginPage.tsx');
    expect(src).toContain('role="alert"');
  });

  it('LoginPage: error icon has aria-hidden', () => {
    const src = readComponent('pages/LoginPage.tsx');
    expect(src).toContain('aria-hidden="true"');
  });

  it('MessageInput: textarea has aria-label', () => {
    const src = readComponent('components/chat/MessageInput.tsx');
    expect(src).toMatch(/aria-label=\{t\('input\.ariaLabel'\)/);
  });

  it('MessageInput: send button has aria-label', () => {
    const src = readComponent('components/chat/MessageInput.tsx');
    expect(src).toMatch(/aria-label=\{isStreaming/);
  });
});

// ─── i18n keys for accessibility ──────────────────────────────
describe('i18n: accessibility keys exist', () => {
  it('sidebar.chatList key exists in all locales', () => {
    const src = readComponent('lib/i18n.tsx');
    expect(src).toContain("'sidebar.chatList'");
    // Check all 3 locales have it
    const matches = src.match(/'sidebar\.chatList'/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(4); // type + 3 locales
  });
});
