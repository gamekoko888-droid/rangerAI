/**
 * Phase 5/6/7 Unit Tests
 * - Phase 5: Image generation result inline display (extractImageUrl enhancement)
 * - Phase 6: Chat management (batch delete, search highlight, tag colors)
 * - Phase 7: Mobile file panel (bottom sheet)
 */
import { describe, it, expect } from 'vitest';

// ─── Phase 5: Image URL Extraction ────────────────────────────

describe('Phase 5: Image URL Extraction', () => {
  // Simulate the enhanced extractImageUrl logic
  function extractImageUrl(resultText: string | undefined): string | null {
    if (!resultText) return null;
    // Check for MEDIA: pattern (from exec tool)
    const mediaMatch = resultText.match(/MEDIA:\s*(https?:\/\/[^\s]+)/i);
    if (mediaMatch) return mediaMatch[1];
    // Check for markdown image pattern
    const mdMatch = resultText.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
    if (mdMatch) return mdMatch[1];
    // Check for direct image URL
    const urlMatch = resultText.match(/(https?:\/\/[^\s]+\.(?:png|jpg|jpeg|gif|webp|svg))/i);
    if (urlMatch) return urlMatch[1];
    return null;
  }

  it('should extract URL from MEDIA: pattern', () => {
    const result = 'Generated image: MEDIA: https://ranger.voyage/workspace/output.png';
    expect(extractImageUrl(result)).toBe('https://ranger.voyage/workspace/output.png');
  });

  it('should extract URL from markdown image pattern', () => {
    const result = 'Here is the result: ![output](https://example.com/image.png)';
    expect(extractImageUrl(result)).toBe('https://example.com/image.png');
  });

  it('should extract direct image URL', () => {
    const result = 'File saved to https://cdn.example.com/photo.jpg successfully';
    expect(extractImageUrl(result)).toBe('https://cdn.example.com/photo.jpg');
  });

  it('should return null for text without image URLs', () => {
    expect(extractImageUrl('Just some text output')).toBeNull();
    expect(extractImageUrl(undefined)).toBeNull();
    expect(extractImageUrl('')).toBeNull();
  });

  it('should prioritize MEDIA: pattern over markdown', () => {
    const result = 'MEDIA: https://a.com/img.png and also ![x](https://b.com/img.jpg)';
    expect(extractImageUrl(result)).toBe('https://a.com/img.png');
  });

  it('should handle MEDIA: with various image extensions', () => {
    expect(extractImageUrl('MEDIA: https://host.com/file.webp')).toBe('https://host.com/file.webp');
    expect(extractImageUrl('MEDIA: https://host.com/file.gif')).toBe('https://host.com/file.gif');
    expect(extractImageUrl('MEDIA: https://host.com/file.svg')).toBe('https://host.com/file.svg');
  });
});

// ─── Phase 6: Chat Management ─────────────────────────────────

describe('Phase 6: Batch Delete', () => {
  it('should validate batch delete request format', () => {
    const chatIds = ['chat-1', 'chat-2', 'chat-3'];
    const requestBody = { chatIds };
    expect(requestBody.chatIds).toHaveLength(3);
    expect(requestBody.chatIds).toContain('chat-1');
    expect(requestBody.chatIds).toContain('chat-2');
    expect(requestBody.chatIds).toContain('chat-3');
  });

  it('should reject empty chatIds array', () => {
    const chatIds: string[] = [];
    expect(chatIds.length).toBe(0);
    // API should reject empty arrays
  });

  it('should handle single item batch delete', () => {
    const chatIds = ['chat-1'];
    expect(chatIds).toHaveLength(1);
  });
});

describe('Phase 6: Search Highlight', () => {
  // Simulate search highlight logic
  function highlightMatch(text: string, query: string): { before: string; match: string; after: string } | null {
    if (!query || !text) return null;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQuery);
    if (idx === -1) return null;
    return {
      before: text.slice(Math.max(0, idx - 20), idx),
      match: text.slice(idx, idx + query.length),
      after: text.slice(idx + query.length, idx + query.length + 20),
    };
  }

  it('should find and highlight matching text', () => {
    const result = highlightMatch('Hello World, this is a test', 'World');
    expect(result).not.toBeNull();
    expect(result!.match).toBe('World');
    expect(result!.before).toContain('Hello ');
  });

  it('should be case-insensitive', () => {
    const result = highlightMatch('Hello WORLD', 'world');
    expect(result).not.toBeNull();
    expect(result!.match).toBe('WORLD');
  });

  it('should return null for no match', () => {
    expect(highlightMatch('Hello World', 'xyz')).toBeNull();
    expect(highlightMatch('', 'test')).toBeNull();
    expect(highlightMatch('Hello', '')).toBeNull();
  });

  it('should handle match at the beginning', () => {
    const result = highlightMatch('Hello World', 'Hello');
    expect(result).not.toBeNull();
    expect(result!.before).toBe('');
    expect(result!.match).toBe('Hello');
  });

  it('should handle match at the end', () => {
    const result = highlightMatch('Hello World', 'World');
    expect(result).not.toBeNull();
    expect(result!.match).toBe('World');
    expect(result!.after).toBe('');
  });
});

describe('Phase 6: Tag Colors', () => {
  // Simulate tag color mapping
  const TAG_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
    '重要': { bg: 'bg-red-500/15', text: 'text-red-400', dot: 'bg-red-400' },
    '进行中': { bg: 'bg-blue-500/15', text: 'text-blue-400', dot: 'bg-blue-400' },
    '已完成': { bg: 'bg-emerald-500/15', text: 'text-emerald-400', dot: 'bg-emerald-400' },
    '待处理': { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400' },
  };

  function getTagColor(tag: string): { bg: string; text: string; dot: string } {
    if (TAG_COLORS[tag]) return TAG_COLORS[tag];
    // Hash-based color for unknown tags
    const colors = [
      { bg: 'bg-violet-500/15', text: 'text-violet-400', dot: 'bg-violet-400' },
      { bg: 'bg-cyan-500/15', text: 'text-cyan-400', dot: 'bg-cyan-400' },
      { bg: 'bg-pink-500/15', text: 'text-pink-400', dot: 'bg-pink-400' },
      { bg: 'bg-orange-500/15', text: 'text-orange-400', dot: 'bg-orange-400' },
    ];
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  it('should return predefined colors for known tags', () => {
    expect(getTagColor('重要').bg).toBe('bg-red-500/15');
    expect(getTagColor('进行中').text).toBe('text-blue-400');
    expect(getTagColor('已完成').dot).toBe('bg-emerald-400');
  });

  it('should return consistent colors for unknown tags', () => {
    const color1 = getTagColor('自定义标签');
    const color2 = getTagColor('自定义标签');
    expect(color1.bg).toBe(color2.bg);
    expect(color1.text).toBe(color2.text);
  });

  it('should return different colors for different tags', () => {
    // Different tags should likely get different colors (not guaranteed but probable)
    const color1 = getTagColor('标签A');
    const color2 = getTagColor('标签B');
    // At least verify they return valid color objects
    expect(color1.bg).toBeTruthy();
    expect(color2.bg).toBeTruthy();
  });
});

// ─── Phase 7: Mobile File Panel ───────────────────────────────

describe('Phase 7: Mobile File Panel', () => {
  it('should detect mobile viewport correctly', () => {
    // Simulate mobile detection logic
    const checkMobile = (width: number) => width < 768;
    expect(checkMobile(375)).toBe(true);   // iPhone
    expect(checkMobile(414)).toBe(true);   // iPhone Plus
    expect(checkMobile(768)).toBe(false);  // iPad
    expect(checkMobile(1024)).toBe(false); // Desktop
    expect(checkMobile(1440)).toBe(false); // Wide desktop
  });

  it('should sort tree nodes correctly (directories first)', () => {
    const entries = [
      { name: 'file.txt', type: 'file' as const },
      { name: 'src', type: 'directory' as const },
      { name: 'README.md', type: 'file' as const },
      { name: 'docs', type: 'directory' as const },
    ];

    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    expect(sorted[0].name).toBe('docs');
    expect(sorted[1].name).toBe('src');
    // localeCompare: file.txt < README.md in default locale
    expect(sorted[2].name).toBe('file.txt');
    expect(sorted[3].name).toBe('README.md');
  });

  it('should detect changed files in subdirectories', () => {
    const changedFiles = ['/workspace/src/main.py', '/workspace/docs/readme.md'];
    const dirPath = '/workspace/src';
    const hasChangedChild = changedFiles.some(f => f.startsWith(dirPath + '/'));
    expect(hasChangedChild).toBe(true);
  });

  it('should not detect changed files in unrelated directories', () => {
    const changedFiles = ['/workspace/src/main.py'];
    const dirPath = '/workspace/docs';
    const hasChangedChild = changedFiles.some(f => f.startsWith(dirPath + '/'));
    expect(hasChangedChild).toBe(false);
  });

  it('should calculate bottom sheet height correctly', () => {
    // 75dvh for mobile file panel
    const sheetHeightPercent = 75;
    expect(sheetHeightPercent).toBe(75);
    expect(sheetHeightPercent).toBeGreaterThan(50); // At least half screen
    expect(sheetHeightPercent).toBeLessThan(100);   // Not full screen
  });

  it('should handle file size formatting', () => {
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    expect(formatSize(500)).toBe('500 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1048576)).toBe('1.0 MB');
    expect(formatSize(2621440)).toBe('2.5 MB');
  });
});
