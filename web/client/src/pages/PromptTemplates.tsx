/**
 * PromptTemplates — Manage and use quick prompt templates.
 * Supports category filtering, search, and one-click use.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import {
  ArrowLeft, Search, Sparkles, Zap, TrendingUp,
  Copy, Check, MessageSquarePlus, Filter,
} from 'lucide-react';
import * as api from '../lib/api';
import { EmptyState } from '../components/EmptyState';
import { copyToClipboard } from '../lib/clipboard';
import { PageLoadingSkeleton } from '../components/PageLoadingSkeleton';
import { useChatActions } from '../hooks/useChatActions';
import { logger } from "../lib/logger";

interface QuickPrompt {
  id: string;
  title: string;
  content: string;
  category: string | null;
  sortOrder: number;
  isActive: number;
  usageCount: number;
  createdAt: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  '运营': 'bg-pink-500/15 text-pink-400 border-pink-500/20',
  '研发': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  '运维': 'bg-teal-500/15 text-teal-400 border-teal-500/20',
  '创作': 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  '分析': 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
  '通用': 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20',
};

function getCategoryColor(cat: string | null): string {
  if (!cat) return CATEGORY_COLORS['通用'];
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS['通用'];
}

export default function PromptTemplates() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const { createNewChat, sendMessage } = useChatActions();
  const [prompts, setPrompts] = useState<QuickPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Fetch prompts
  useEffect(() => {
    setLoading(true);
    api.fetchPrompts()
      .then(data => setPrompts(data.prompts || []))
      .catch(err => { logger.error('Failed to load prompts:', err); toast.error(t('prompt.loadError')); })
      .finally(() => setLoading(false));
  }, []);

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set(prompts.map(p => p.category).filter(Boolean));
    return Array.from(cats) as string[];
  }, [prompts]);

  // Filter prompts
  const filteredPrompts = useMemo(() => {
    return prompts.filter(p => {
      if (filterCategory && p.category !== filterCategory) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
      }
      return true;
    });
  }, [prompts, searchQuery, filterCategory]);

  // Copy to clipboard
  const handleCopy = useCallback(async (prompt: QuickPrompt) => {
    const ok = await copyToClipboard(prompt.content);
    if (ok) {
      setCopiedId(prompt.id);
      // Track usage
      api.usePrompt(prompt.id).catch(() => {});
      setTimeout(() => setCopiedId(null), 2000);
    }
  }, []);

  // Use in new chat
  const handleUseInChat = useCallback(async (prompt: QuickPrompt) => {
    // Track usage
    api.usePrompt(prompt.id).catch(() => {});
    // Navigate to chat page first
    setLocation('/');
    // Create new chat and send the prompt content directly (avoid stateRef race condition)
    try {
      const newChat = await createNewChat(prompt.title);
      await sendMessage(prompt.content, undefined, newChat.id);
    } catch (err) {
      logger.error('Failed to use prompt in chat:', err);
      toast.error('使用模板失败');
    }
  }, [setLocation, createNewChat, sendMessage, t]);

  return (
    <div className="flex flex-col h-dvh bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
        <button
          onClick={() => setLocation('/')}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-blue-400" />
          <h1 className="text-sm font-semibold">{t('prompt.title')}</h1>
        </div>
        <span className="text-[11px] text-zinc-500 ml-auto">
          {filteredPrompts.length}
        </span>
      </div>

      {/* Search + Filter */}
      <div className="px-4 py-3 border-b border-zinc-800 space-y-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('prompt.search')}
            className="w-full pl-9 pr-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50"
          />
        </div>
        {categories.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Filter size={12} className="text-zinc-500 mr-1" />
            <button
              onClick={() => setFilterCategory(null)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                !filterCategory
                  ? 'bg-blue-500/20 text-blue-400 border-blue-500/30'
                  : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600'
              }`}
            >
              {t('prompt.allCats')}
            </button>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setFilterCategory(filterCategory === cat ? null : cat)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                  filterCategory === cat
                    ? getCategoryColor(cat)
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-600'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Usage Statistics Summary */}
      {!loading && prompts.length > 0 && (
        <div className="px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/30">
          <div className="flex items-center gap-4 text-[11px]">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Zap size={11} className="text-blue-400" />
              <span>{'总使用'}: <span className="text-zinc-200 font-medium">{prompts.reduce((s, p) => s + p.usageCount, 0)}</span> {'次'}</span>
            </div>
            <div className="text-zinc-600">|</div>
            <div className="flex items-center gap-1.5 text-zinc-400">
              <Sparkles size={11} className="text-emerald-400" />
              <span>{'最热门'}: <span className="text-emerald-400 font-medium">{[...prompts].sort((a, b) => b.usageCount - a.usageCount)[0]?.title || '-'}</span></span>
            </div>
            <div className="text-zinc-600 hidden sm:block">|</div>
            <div className="hidden sm:flex items-center gap-1.5 text-zinc-400">
              <TrendingUp size={11} className="text-purple-400" />
              <span>{'平均'}: <span className="text-zinc-200 font-medium">{(prompts.reduce((s, p) => s + p.usageCount, 0) / prompts.length).toFixed(1)}</span> {'次/模板'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Cards */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <PageLoadingSkeleton rows={6} showHeader={false} variant="cards" />
        ) : filteredPrompts.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={t('prompt.empty')}
            description={t('prompt.emptyDesc')}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredPrompts.map(prompt => (
              <div
                key={prompt.id}
                className="group bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-4 hover:border-zinc-600 hover:bg-zinc-800/60 transition-all"
              >
                {/* Title + Category */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="text-sm font-medium text-zinc-200 line-clamp-1">{prompt.title}</h3>
                  {prompt.category && (
                    <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium border ${getCategoryColor(prompt.category)}`}>
                      {prompt.category}
                    </span>
                  )}
                </div>

                {/* Content Preview */}
                <p className="text-xs text-zinc-400 line-clamp-3 mb-3 leading-relaxed">
                  {prompt.content}
                </p>

                {/* Footer */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <TrendingUp size={10} />
                    <span>{prompt.usageCount}x</span>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleCopy(prompt)}
                      className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                      title="Copy"
                    >
                      {copiedId === prompt.id ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    </button>
                    <button
                      onClick={() => handleUseInChat(prompt)}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-blue-400 hover:bg-blue-500/10 transition-colors"
                      title="Use in chat"
                    >
                      <MessageSquarePlus size={12} />
                      {t('prompt.useBtn')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
