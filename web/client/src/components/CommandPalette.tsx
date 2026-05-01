/**
 * CommandPalette — 全局跨模块搜索 (Ctrl+K / Cmd+K)
 * 搜索工单、KOL、知识库、页面导航
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import {
  Search, X, ArrowRight, Headphones, Crown, FolderOpen,
  MessageSquare, BarChart3, Gauge, Package, Users, Shield,
  Eye, Clock, Film, Zap, ListTodo, FileText,
} from 'lucide-react';

interface SearchResult {
  id: string;
  type: 'page' | 'ticket' | 'kol' | 'knowledge' | 'action';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  path?: string;
  action?: () => void;
}

const PAGE_RESULTS: SearchResult[] = [
  { id: 'p-chat', type: 'page', title: 'AI 对话', subtitle: '与 RangerAI 对话', icon: <MessageSquare size={14} />, path: '/' },
  { id: 'p-tickets', type: 'page', title: '工单管理', subtitle: '客服工单处理', icon: <Headphones size={14} />, path: '/tickets' },
  { id: 'p-kols', type: 'page', title: 'KOL 管理', subtitle: '达人合作管理', icon: <Crown size={14} />, path: '/kols' },
  { id: 'p-kb', type: 'page', title: '知识库', subtitle: '文档和知识管理', icon: <FolderOpen size={14} />, path: '/knowledge' },
  { id: 'p-ceo', type: 'page', title: 'CEO 看板', subtitle: '高管决策面板', icon: <Eye size={14} />, path: '/ceo' },
  { id: 'p-analytics', type: 'page', title: '数据分析', subtitle: '业务数据洞察', icon: <BarChart3 size={14} />, path: '/data-analytics' },
  { id: 'p-reports', type: 'page', title: '日报分析', subtitle: '每日运营报告', icon: <Clock size={14} />, path: '/daily-reports' },
  { id: 'p-tiktok', type: 'page', title: 'TikTok 达人', subtitle: 'TikTok 合作管理', icon: <Users size={14} />, path: '/tiktok-partners' },
  { id: 'p-scripts', type: 'page', title: '文案生成', subtitle: 'TikTok 脚本创作', icon: <Film size={14} />, path: '/tiktok-scripts' },
  { id: 'p-inventory', type: 'page', title: '库存监控', subtitle: '库存预警和管理', icon: <Package size={14} />, path: '/inventory' },
  { id: 'p-ops', type: 'page', title: '运营效率', subtitle: '各中心效率分析', icon: <Gauge size={14} />, path: '/ops-efficiency' },
  { id: 'p-workflows', type: 'page', title: '工作流', subtitle: '自动化流程编辑', icon: <Zap size={14} />, path: '/workflows' },
  { id: 'p-tasks', type: 'page', title: '任务队列', subtitle: '任务管理和追踪', icon: <ListTodo size={14} />, path: '/tasks' },
  { id: 'p-team', type: 'page', title: '团队管理', subtitle: '成员和部门管理', icon: <Users size={14} />, path: '/team' },
  { id: 'p-admin', type: 'page', title: '管理控制台', subtitle: '系统管理', icon: <Shield size={14} />, path: '/admin' },
  { id: 'p-prompts', type: 'page', title: '提示词模板', subtitle: '对话提示词管理', icon: <FileText size={14} />, path: '/prompts' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const { locale } = useI18n();

  // Ctrl+K / Cmd+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Filter results
  const results = query.trim()
    ? PAGE_RESULTS.filter(r =>
        r.title.toLowerCase().includes(query.toLowerCase()) ||
        (r.subtitle || '').toLowerCase().includes(query.toLowerCase())
      )
    : PAGE_RESULTS.slice(0, 8);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      const r = results[selectedIndex];
      if (r.path) navigate(r.path);
      if (r.action) r.action();
      setOpen(false);
    }
  }, [results, selectedIndex, navigate]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Panel */}
      <div
        className="relative w-full max-w-lg mx-4 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
          <Search size={16} className="text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder={locale.startsWith('zh') ? '搜索页面、功能...' : 'Search pages, features...'}
            className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-zinc-500 bg-zinc-800 border border-zinc-700 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[300px] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              {locale.startsWith('zh') ? '未找到匹配结果' : 'No results found'}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                onClick={() => {
                  if (r.path) navigate(r.path);
                  if (r.action) r.action();
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  i === selectedIndex ? 'bg-blue-600/20 text-blue-300' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <span className={`shrink-0 ${i === selectedIndex ? 'text-blue-400' : 'text-zinc-500'}`}>
                  {r.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{r.title}</div>
                  {r.subtitle && <div className="text-xs text-zinc-500 truncate">{r.subtitle}</div>}
                </div>
                <ArrowRight size={12} className={`shrink-0 ${i === selectedIndex ? 'text-blue-400' : 'text-zinc-600'}`} />
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-600">
          <span>↑↓ 导航 · Enter 确认 · ESC 关闭</span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[9px]">⌘</kbd>
            <kbd className="px-1 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[9px]">K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}
