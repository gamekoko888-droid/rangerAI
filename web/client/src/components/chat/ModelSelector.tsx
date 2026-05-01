/**
 * ModelSelector — Dropdown to choose AI model or auto-routing.
 * Desktop: popover above the button.
 * Mobile: bottom sheet overlay for easier touch interaction.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ChevronDown, Sparkles, Cpu, Zap, Brain, Globe, Check, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  descriptionKey: string;
  icon: 'auto' | 'anthropic' | 'openai' | 'google' | 'meta' | 'deepseek';
  category: 'auto' | 'premium' | 'fast' | 'reasoning';
}

// Static model data — description uses i18n key
const MODEL_OPTIONS_RAW: Omit<ModelOption, 'description'>[] = [
  { id: 'auto', name: '', provider: 'RangerAI', descriptionKey: 'model.smartRouterDesc', icon: 'auto', category: 'auto' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', descriptionKey: 'model.deepseekV4Desc', icon: 'deepseek', category: 'premium' },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', provider: 'OpenAI', descriptionKey: 'model.gpt55Desc', icon: 'openai', category: 'premium' },
  { id: 'openai/gpt-5.5-mini', name: 'GPT-5.5 Mini', provider: 'OpenAI', descriptionKey: 'model.gpt55MiniDesc', icon: 'openai', category: 'fast' },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', provider: 'Google', descriptionKey: 'model.geminiProDesc', icon: 'google', category: 'premium' },
  { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', provider: 'Google', descriptionKey: 'model.geminiFlashDesc', icon: 'google', category: 'fast' },
  { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', provider: 'OpenAI', descriptionKey: 'model.gpt5MiniDesc', icon: 'openai', category: 'fast' },
];

export { MODEL_OPTIONS_RAW };

export function ModelIcon({ icon, size = 14 }: { icon: string; size?: number }) {
  switch (icon) {
    case 'auto':
      return <Sparkles size={size} className="text-violet-400" />;
    case 'anthropic':
      return <Brain size={size} className="text-orange-400" />;
    case 'openai':
      return <Cpu size={size} className="text-emerald-400" />;
    case 'google':
      return <Globe size={size} className="text-blue-400" />;
    default:
      return <Cpu size={size} className="text-zinc-400" />;
  }
}

/** Resolve model options with translated descriptions */
function useModelOptions() {
  const { t } = useI18n();
  return useMemo(() => MODEL_OPTIONS_RAW.map(m => ({
    ...m,
    name: m.id === 'auto' ? t('model.smartRouterName') : m.name,
    description: t(m.descriptionKey as any),
  })), [t]);
}

/** Get a model option by ID (static, no translation) */
export function getModelById(id: string): typeof MODEL_OPTIONS_RAW[0] {
  return MODEL_OPTIONS_RAW.find(m => m.id === id) || MODEL_OPTIONS_RAW[0];
}

// Keep backward compat export
export const MODEL_OPTIONS = MODEL_OPTIONS_RAW as any;

interface ModelSelectorProps {
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ selectedModel, onSelectModel, disabled }: ModelSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const isMobile = useIsMobile();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelOptions = useModelOptions();

  const CATEGORY_LABELS: Record<string, string> = {
    auto: t('model.tierAuto'),
    premium: t('model.tierPremium'),
    fast: t('model.tierFast'),
    reasoning: t('model.tierReasoning'),
  };

  // Close dropdown on outside click (desktop only)
  useEffect(() => {
    if (!isOpen || isMobile) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isMobile]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Prevent body scroll when mobile sheet is open
  useEffect(() => {
    if (isMobile && isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isMobile, isOpen]);

  const current = modelOptions.find(m => m.id === selectedModel) || modelOptions[0];

  // Group models by category
  const categories = ['auto', 'premium', 'fast', 'reasoning'];
  const grouped = categories
    .map(cat => ({
      key: cat,
      label: CATEGORY_LABELS[cat],
      models: modelOptions.filter(m => m.category === cat),
    }))
    .filter(g => g.models.length > 0);

  const handleSelect = (modelId: string) => {
    onSelectModel(modelId);
    setIsOpen(false);
  };

  const modelList = (
    <>
      {grouped.map((group, gi) => (
        <div key={group.key}>
          {gi > 0 && <div className="mx-3 my-1 border-t border-zinc-700/50" />}
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider px-3 sm:px-4 pt-2 pb-1 font-medium">
            {group.label}
          </p>
          {group.models.map((model) => {
            const isSelected = selectedModel === model.id;
            return (
              <button
                key={model.id}
                onClick={() => handleSelect(model.id)}
                className={`w-full flex items-center gap-3 px-3 sm:px-4 py-2.5 sm:py-2 text-left
                           transition-all duration-100
                           active:bg-zinc-600/40
                           ${isSelected
                             ? 'bg-violet-500/10'
                             : 'hover:bg-zinc-700/40'}`}
              >
                <div className="shrink-0 w-8 h-8 sm:w-7 sm:h-7 rounded-lg flex items-center justify-center bg-zinc-700/50">
                  <ModelIcon icon={model.icon} size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-sm sm:text-[13px] font-medium ${
                      isSelected ? 'text-violet-300' : 'text-zinc-200'
                    }`}>
                      {model.name}
                    </span>
                  </div>
                  <p className="text-xs sm:text-[11px] text-zinc-500 leading-tight">
                    {model.provider} · {model.description}
                  </p>
                </div>
                {isSelected && (
                  <Check size={16} className="text-violet-400 shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs
                   text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60
                   active:bg-zinc-700 transition-all duration-150 shrink-0
                   disabled:opacity-40 disabled:cursor-not-allowed
                   border border-transparent hover:border-zinc-600/50"
        title={`${t('model.currentModel')}: ${current.name}`}
      >
        <ModelIcon icon={current.icon} size={14} />
        <span className="max-w-[100px] sm:max-w-[120px] truncate font-medium">{current.name}</span>
        <ChevronDown
          size={12}
          className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Desktop Dropdown */}
      {isOpen && !isMobile && (
        <div
          className="absolute bottom-full left-0 mb-2 w-72
                     bg-zinc-800/95 backdrop-blur-xl border border-zinc-600/50
                     rounded-xl shadow-2xl shadow-black/60 overflow-hidden z-50"
          style={{ animation: 'modelSelectorFadeIn 150ms ease-out' }}
        >
          <div className="px-3 pt-3 pb-2">
            <p className="text-[11px] font-semibold text-zinc-400 tracking-wide">{t('model.selectModel')}</p>
          </div>
          <div className="max-h-[340px] overflow-y-auto pb-1.5">
            {modelList}
          </div>
        </div>
      )}

      {/* Mobile Bottom Sheet */}
      {isOpen && isMobile && (
        <div className="fixed inset-0 z-[100]">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setIsOpen(false)}
          />
          {/* Sheet */}
          <div
            className="absolute bottom-0 left-0 right-0 bg-zinc-900 rounded-t-2xl 
                       max-h-[70vh] flex flex-col overflow-hidden
                       pb-[env(safe-area-inset-bottom)]"
            style={{ animation: 'modelSheetSlideUp 200ms ease-out' }}
          >
            {/* Handle bar */}
            <div className="flex items-center justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-full bg-zinc-700" />
            </div>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2">
              <p className="text-sm font-semibold text-zinc-300">{t('model.selectModel')}</p>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-full text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              >
                <X size={18} />
              </button>
            </div>
            {/* Model list */}
            <div className="flex-1 overflow-y-auto overscroll-contain pb-4">
              {modelList}
            </div>
          </div>
        </div>
      )}

      {/* Animation keyframes */}
      <style>{`
        @keyframes modelSelectorFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes modelSheetSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
