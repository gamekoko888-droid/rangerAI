/**
 * Unified date/time formatting utilities for RangerAI
 * 
 * Centralizes all date formatting to ensure consistency across the app.
 * Uses Intl.DateTimeFormat for locale-aware formatting.
 */

type TranslateFn = (key: string) => string;

/** Map app locale to Intl locale string */
export function toIntlLocale(locale: string): string {
  switch (locale) {
    case 'zh-CN': return 'zh-CN';
    case 'zh-TW': return 'zh-TW';
    case 'en': return 'en-US';
    default: return locale;
  }
}

/**
 * Format a date string to a short time (HH:mm)
 */
export function formatShortTime(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(toIntlLocale(locale), { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date string to a short date (e.g., "Mar 9" or "3月9日")
 */
export function formatShortDate(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(toIntlLocale(locale), { month: 'short', day: 'numeric' });
}

/**
 * Format a date string to date + time (e.g., "Mar 9, 14:30" or "3月9日 14:30")
 */
export function formatDateTime(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(toIntlLocale(locale), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Format a date string to full date + time with seconds
 */
export function formatFullDateTime(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(toIntlLocale(locale), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

/**
 * Format a date string to full date (e.g., "2026/3/9" or "Mar 9, 2026")
 */
export function formatFullDate(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(toIntlLocale(locale), {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

/**
 * Smart time formatting for chat sidebar:
 * - Today: show time only (HH:mm)
 * - This year: show month + day
 * - Older: show full date
 */
export function formatSmartTime(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  
  const now = new Date();
  const intlLocale = toIntlLocale(locale);
  
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' });
  }
  
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isYesterday) {
    return date.toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' });
  }
  
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' });
  }
  
  return date.toLocaleDateString(intlLocale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Relative time formatting (e.g., "just now", "5 min ago", "3 days ago")
 * Uses i18n translation function for localized labels.
 */
export function formatRelativeTime(dateStr: string | null, locale: string, t: TranslateFn): string {
  if (!dateStr) return '—';
  
  const date = new Date(dateStr.includes('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z');
  if (isNaN(date.getTime())) return '—';
  
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return `${Math.floor(diff / 60)} ${t('time.minutesAgo')}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ${t('time.hoursAgo')}`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} ${t('time.daysAgo')}`;
  
  return date.toLocaleDateString(toIntlLocale(locale));
}

/**
 * Format time for task queue: time with seconds
 */
export function formatTimeWithSeconds(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(toIntlLocale(locale), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
