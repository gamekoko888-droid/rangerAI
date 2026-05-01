/**
 * Iter-36 Tests: Unified date/time formatting utilities
 */
import { describe, it, expect } from 'vitest';
import {
  toIntlLocale,
  formatShortTime,
  formatShortDate,
  formatDateTime,
  formatFullDateTime,
  formatFullDate,
  formatSmartTime,
  formatRelativeTime,
  formatTimeWithSeconds,
} from './dateUtils';

describe('Iter-36: Unified date/time formatting', () => {
  describe('toIntlLocale', () => {
    it('maps zh-CN to zh-CN', () => {
      expect(toIntlLocale('zh-CN')).toBe('zh-CN');
    });
    it('maps zh-TW to zh-TW', () => {
      expect(toIntlLocale('zh-TW')).toBe('zh-TW');
    });
    it('maps en to en-US', () => {
      expect(toIntlLocale('en')).toBe('en-US');
    });
    it('passes through unknown locales', () => {
      expect(toIntlLocale('ja-JP')).toBe('ja-JP');
    });
  });

  describe('formatShortTime', () => {
    it('returns HH:mm format for valid date', () => {
      const result = formatShortTime('2026-03-09T14:30:00Z', 'en');
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
    it('returns — for invalid date', () => {
      expect(formatShortTime('invalid', 'en')).toBe('—');
    });
  });

  describe('formatShortDate', () => {
    it('returns short date for valid date', () => {
      const result = formatShortDate('2026-03-09T14:30:00Z', 'en');
      expect(result).toBeTruthy();
      expect(result).not.toBe('—');
    });
    it('returns — for invalid date', () => {
      expect(formatShortDate('invalid', 'en')).toBe('—');
    });
  });

  describe('formatDateTime', () => {
    it('returns date + time for valid date', () => {
      const result = formatDateTime('2026-03-09T14:30:00Z', 'zh-CN');
      expect(result).toBeTruthy();
      expect(result).not.toBe('—');
    });
    it('returns — for invalid date', () => {
      expect(formatDateTime('not-a-date', 'en')).toBe('—');
    });
  });

  describe('formatFullDateTime', () => {
    it('returns full date + time with seconds', () => {
      const result = formatFullDateTime('2026-03-09T14:30:45Z', 'en');
      expect(result).toBeTruthy();
      expect(result).not.toBe('—');
    });
    it('returns — for invalid date', () => {
      expect(formatFullDateTime('', 'en')).toBe('—');
    });
  });

  describe('formatFullDate', () => {
    it('returns full date with year', () => {
      const result = formatFullDate('2026-03-09T14:30:00Z', 'en');
      expect(result).toContain('2026');
    });
    it('returns — for invalid date', () => {
      expect(formatFullDate('xyz', 'en')).toBe('—');
    });
  });

  describe('formatSmartTime', () => {
    it('returns time for today', () => {
      const now = new Date();
      now.setHours(now.getHours() - 1);
      const result = formatSmartTime(now.toISOString(), 'en');
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
    it('returns short date for older dates', () => {
      const old = new Date();
      old.setDate(old.getDate() - 10);
      const result = formatSmartTime(old.toISOString(), 'en');
      expect(result).toBeTruthy();
      expect(result).not.toBe('—');
    });
    it('returns — for invalid date', () => {
      expect(formatSmartTime('invalid', 'en')).toBe('—');
    });
  });

  describe('formatRelativeTime', () => {
    const mockT = (key: string) => {
      const map: Record<string, string> = {
        'time.justNow': 'just now',
        'time.minutesAgo': 'min ago',
        'time.hoursAgo': 'hr ago',
        'time.daysAgo': 'days ago',
      };
      return map[key] || key;
    };

    it('returns — for null', () => {
      expect(formatRelativeTime(null, 'en', mockT)).toBe('—');
    });
    it('returns "just now" for recent dates', () => {
      const now = new Date();
      now.setSeconds(now.getSeconds() - 10);
      const result = formatRelativeTime(now.toISOString(), 'en', mockT);
      expect(result).toBe('just now');
    });
    it('returns minutes ago for dates within an hour', () => {
      const d = new Date();
      d.setMinutes(d.getMinutes() - 5);
      const result = formatRelativeTime(d.toISOString(), 'en', mockT);
      expect(result).toContain('min ago');
    });
    it('returns hours ago for dates within a day', () => {
      const d = new Date();
      d.setHours(d.getHours() - 3);
      const result = formatRelativeTime(d.toISOString(), 'en', mockT);
      expect(result).toContain('hr ago');
    });
    it('returns days ago for dates within a week', () => {
      const d = new Date();
      d.setDate(d.getDate() - 3);
      const result = formatRelativeTime(d.toISOString(), 'en', mockT);
      expect(result).toContain('days ago');
    });
    it('returns formatted date for older dates', () => {
      const result = formatRelativeTime('2025-01-01T00:00:00Z', 'en', mockT);
      expect(result).toBeTruthy();
      expect(result).not.toContain('ago');
    });
    it('returns — for invalid date string', () => {
      expect(formatRelativeTime('not-a-date', 'en', mockT)).toBe('—');
    });
  });

  describe('formatTimeWithSeconds', () => {
    it('returns time with seconds', () => {
      const result = formatTimeWithSeconds('2026-03-09T14:30:45Z', 'en');
      expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    });
    it('returns — for invalid date', () => {
      expect(formatTimeWithSeconds('invalid', 'en')).toBe('—');
    });
  });
});

describe('Iter-36: Integration - pages use dateUtils', () => {
  const fs = require('fs');
  const path = require('path');
  const clientSrc = path.resolve(__dirname, '..');

  it('Sidebar imports formatSmartTime from dateUtils', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'components/chat/Sidebar.tsx'), 'utf-8');
    expect(src).toContain("import { formatSmartTime } from '../../lib/dateUtils'");
  });

  it('NotificationCenter imports formatRelativeTime from dateUtils', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'pages/NotificationCenter.tsx'), 'utf-8');
    expect(src).toContain("import { formatRelativeTime } from '@/lib/dateUtils'");
  });

  it('WorkflowEditor imports formatRelativeTime from dateUtils', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'pages/WorkflowEditor.tsx'), 'utf-8');
    expect(src).toContain("import { formatRelativeTime as formatRelTime } from '@/lib/dateUtils'");
  });

  it('i18n has time.justNow key in all locales', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'lib/i18n.tsx'), 'utf-8');
    expect(src).toContain("'time.justNow'");
    expect(src).toContain("'time.minutesAgo'");
    expect(src).toContain("'time.hoursAgo'");
    expect(src).toContain("'time.daysAgo'");
    expect(src).toContain("'time.neverRun'");
  });
});
