/**
 * LanguageSwitcher — Language toggle with clear visual indicator
 * 
 * Shows current locale flag + short label. Cycles through zh-CN → zh-TW → en on click.
 * Designed to be highly visible per user preference.
 */

import { useI18n, LOCALE_FLAGS, type Locale } from '@/lib/i18n';
import { Globe } from 'lucide-react';

const LOCALE_ORDER: Locale[] = ['zh-CN', 'zh-TW', 'en'];

const LOCALE_SHORT: Record<Locale, string> = {
  'zh-CN': '简',
  'zh-TW': '繁',
  'en': 'EN',
};

export function LanguageSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  const cycleLocale = () => {
    const idx = LOCALE_ORDER.indexOf(locale);
    const next = LOCALE_ORDER[(idx + 1) % LOCALE_ORDER.length];
    setLocale(next);
  };

  if (collapsed) {
    return (
      <button
        onClick={cycleLocale}
        title={`${t('common.language')}: ${LOCALE_FLAGS[locale]}`}
        className="flex items-center justify-center w-7 h-7 rounded-lg text-zinc-300 hover:text-white hover:bg-blue-600/20 border border-transparent hover:border-blue-500/30 transition-all"
      >
        <span className="text-xs font-bold">{LOCALE_SHORT[locale]}</span>
      </button>
    );
  }

  return (
    <button
      onClick={cycleLocale}
      title={t('common.language')}
      className="flex items-center gap-2 w-full px-2.5 py-2 rounded-lg text-sm text-zinc-300 hover:text-white hover:bg-blue-600/15 border border-transparent hover:border-blue-500/20 transition-all"
    >
      <Globe size={16} className="shrink-0 text-blue-400" />
      <span className="flex items-center gap-1.5 text-xs">
        <span className="font-semibold text-zinc-200">{LOCALE_FLAGS[locale]}</span>
        <span className="text-zinc-500">{LOCALE_SHORT[locale]}</span>
      </span>
    </button>
  );
}

/**
 * Standalone language switcher for pages without sidebar (e.g., login page)
 * Positioned as a floating button in the top-right corner
 */
export function FloatingLanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  const cycleLocale = () => {
    const idx = LOCALE_ORDER.indexOf(locale);
    const next = LOCALE_ORDER[(idx + 1) % LOCALE_ORDER.length];
    setLocale(next);
  };

  return (
    <button
      onClick={cycleLocale}
      title={t('common.language')}
      className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-800/80 backdrop-blur-sm border border-zinc-700/50 text-zinc-300 hover:text-white hover:bg-zinc-700/80 hover:border-blue-500/30 transition-all shadow-lg"
    >
      <Globe size={14} className="text-blue-400" />
      <span className="text-xs font-semibold">{LOCALE_SHORT[locale]}</span>
    </button>
  );
}
