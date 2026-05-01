/**
 * Sidebar — Chat list with search highlighting, batch operations, tag colors,
 * tag grouping, create, select, rename, delete, and user info.
 * Mobile-friendly: supports onChatSelect callback, long-press for actions, swipe-friendly.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { useChatListStore } from '../../stores/useChatListStore';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { useChatActions } from '../../hooks/useChatActions';
import { parseTags } from '../../lib/types';
import {
  Plus, MessageSquare, Trash2, Pencil, Check, X, Loader2,
  Search, Tag, LogOut, User as UserIcon, ChevronDown, ChevronRight, Ticket, BarChart3,
  MoreVertical, CheckSquare, Square, XSquare, Download, FileText, FileJson,
  Share2, Users, Inbox, Cpu, Sparkles, FolderOpen, Zap, ListTodo, Shield,
  Headphones, Crown, Bell, LayoutGrid, Eye, Clock, Film, Package, Gauge, Upload, TrendingUp, Brain, DollarSign,
} from 'lucide-react';
import { CapabilitiesPanel } from './CapabilitiesPanel';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useConfirmDialog } from '../ConfirmDialog';
import { toast } from 'sonner';
import { formatSmartTime } from '../../lib/dateUtils';
import { exportChat } from '../../lib/exportUtils';
import { fetchChatDetail, fetchSharedWithMe } from '../../lib/api';
import { ShareDialog } from './ShareDialog';
import { UserMemoryDialog } from './UserMemoryDialog';
import type { SharedChat } from '../../lib/types';
import { useLocation } from 'wouter';
import { getAuthToken } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { usePermissions } from '../../hooks/usePermissions';
import { logger } from "../../lib/logger";

// ─── Tag color palette ──────────────────────────────────────
const TAG_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  '工作': { bg: 'bg-blue-500/15', border: 'border-blue-500/40', text: 'text-blue-300' },
  '学习': { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-300' },
  '项目': { bg: 'bg-purple-500/15', border: 'border-purple-500/40', text: 'text-purple-300' },
  '研究': { bg: 'bg-cyan-500/15', border: 'border-cyan-500/40', text: 'text-cyan-300' },
  '创意': { bg: 'bg-pink-500/15', border: 'border-pink-500/40', text: 'text-pink-300' },
  '代码': { bg: 'bg-amber-500/15', border: 'border-amber-500/40', text: 'text-amber-300' },
  '重要': { bg: 'bg-red-500/15', border: 'border-red-500/40', text: 'text-red-300' },
  '客服': { bg: 'bg-orange-500/15', border: 'border-orange-500/40', text: 'text-orange-300' },
  '运营': { bg: 'bg-teal-500/15', border: 'border-teal-500/40', text: 'text-teal-300' },
  '市场': { bg: 'bg-indigo-500/15', border: 'border-indigo-500/40', text: 'text-indigo-300' },
};

function getTagColor(tag: string) {
  if (TAG_COLORS[tag]) return TAG_COLORS[tag];
  // Hash-based color for unknown tags
  const hash = tag.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const colors = Object.values(TAG_COLORS);
  return colors[hash % colors.length];
}

// ─── Markdown strip helper ──────────────────────────────────
function stripMarkdown(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '')  // tool calls
    .replace(/<tool_response>[\s\S]*?(<\/tool_response>|$)/gi, '')  // tool responses
    .replace(/<\/?(tool_call|tool_response|tool_result|function_call|function_result|system_instruction|internal_note)[^>]*>/gi, '')  // stray XML tags
    .replace(/```[\s\S]*?```/g, '[代码]')   // code blocks
    .replace(/`([^`]+)`/g, '$1')              // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')        // bold
    .replace(/\*([^*]+)\*/g, '$1')            // italic
    .replace(/#{1,6}\s*/g, '')                // headings
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images
    .replace(/\\n/g, ' ')                     // literal \n
    .replace(/\n+/g, ' ')                     // newlines
    .replace(/[>\-*+]\s/g, '')               // list markers, blockquotes
    .replace(/\|/g, ' ')                      // table pipes
    .replace(/\s{2,}/g, ' ')                  // multiple spaces
    .trim();
}

// ─── Search highlight helper ────────────────────────────────
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

interface SidebarProps {
  onChatSelect?: () => void;
}

export function Sidebar({ onChatSelect }: SidebarProps) {
  const { selectChat, createNewChat, logout } = useChatActions();
  const chatListStore = useChatListStore();
  const { chats, currentChatId, isLoadingChats, searchQuery, filterTag, allTags,
          deleteChat, batchDeleteChats, renameChat, searchChats, filterByTag } = chatListStore;
  const user = useAuthStore(s => s.user);
  const { wsConnected, wsReconnecting, wsReconnectAttempt, gatewayConnected } = useConnectionStore();
  const [, navigate] = useLocation();
  const { t, locale } = useI18n();
  const { can: canPerm } = usePermissions();
  const { confirm: confirmDialog, ConfirmDialogUI } = useConfirmDialog();
  // state destructured above via individual stores

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [showTags, setShowTags] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  // Share dialog
  const [shareDialogChatId, setShareDialogChatId] = useState<string | null>(null);
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [shareDialogTitle, setShareDialogTitle] = useState('');
  // Shared with me
  const [showSharedWithMe, setShowSharedWithMe] = useState(false);
  const [sharedChats, setSharedChats] = useState<SharedChat[]>([]);
  const [isLoadingShared, setIsLoadingShared] = useState(false);
  // Batch selection mode
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [capabilitiesPanelOpen, setCapabilitiesPanelOpen] = useState(false);
  // Per-group collapse state with localStorage persistence
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('rangerai-nav-collapsed');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const toggleGroup = useCallback((group: string) => {
    setGroupCollapsed(prev => {
      const next = { ...prev, [group]: !prev[group] };
      localStorage.setItem('rangerai-nav-collapsed', JSON.stringify(next));
      return next;
    });
  }, []);
  const [unreadCount, setUnreadCount] = useState(0);
  // Swipe gesture to close sidebar on mobile
  const sidebarRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  // Global search state
  const [globalResults, setGlobalResults] = useState<{
    knowledge: Array<{ id: string; title: string; category: string; description: string }>;
    workflows: Array<{ id: string; name: string; description: string }>;
  }>({ knowledge: [], workflows: [] });
  const [isGlobalSearching, setIsGlobalSearching] = useState(false);
  const [showGlobalResults, setShowGlobalResults] = useState(false);

  // Notification: initial fetch + WS real-time push
  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    // Initial fetch
    const fetchUnread = async () => {
      try {
        const res = await fetch('/api/notifications/unread-count', {
          headers: { Authorization: `Bearer ${getAuthToken()}` },
        });
        if (res.ok) {
          const data = await res.json();
          setUnreadCount(data.count || 0);
        }
      } catch { /* ignore */ }
    };
    fetchUnread();
    // Listen for real-time WS notification events
    const handleNotification = () => {
      setUnreadCount(prev => prev + 1);
    };
    window.addEventListener('rangerai:notification', handleNotification);
    // Fallback: poll every 120s (reduced from 30s since WS handles real-time)
    const interval = setInterval(fetchUnread, 120000);
    return () => {
      clearInterval(interval);
      window.removeEventListener('rangerai:notification', handleNotification);
    };
  }, [user]);
  const globalSearchRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Swipe-to-close handler for mobile
  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartX.current = e.touches[0].clientX;
      touchStartY.current = e.touches[0].clientY;
    };
    const handleTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - touchStartX.current;
      const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
      // Swipe left to close (dx < -80 and mostly horizontal)
      if (dx < -80 && dy < 60) {
        onChatSelect?.();
      }
    };
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onChatSelect]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // Close action menu on outside click
  useEffect(() => {
    if (!activeMenuId) return;
    const handleClick = () => setActiveMenuId(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [activeMenuId]);

  // Exit batch mode when no items selected
  useEffect(() => {
    if (batchMode && selectedIds.size === 0 && !isBatchDeleting) {
      // Keep batch mode active even with 0 selections
    }
  }, [batchMode, selectedIds, isBatchDeleting]);

  // Close global results on outside click
  useEffect(() => {
    if (!showGlobalResults) return;
    const handleClick = (e: MouseEvent) => {
      if (globalSearchRef.current && !globalSearchRef.current.contains(e.target as Node)) {
        setShowGlobalResults(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showGlobalResults]);

  // Debounced global search
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      searchChats(value);
      if (!value.trim()) {
        setGlobalResults({ knowledge: [], workflows: [] });
        setShowGlobalResults(false);
        return;
      }
      setIsGlobalSearching(true);
      setShowGlobalResults(true);
      try {
        const token = getAuthToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const [knowledgeRes, workflowsRes] = await Promise.allSettled([
          fetch('/api/knowledge/search', {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ query: value.trim(), limit: 5 }),
          }).then(r => r.ok ? r.json() : { docs: [] }),
          fetch('/api/workflows', {
            headers,
            credentials: 'include',
          }).then(r => r.ok ? r.json() : { workflows: [] }),
        ]);
        const knowledgeDocs = knowledgeRes.status === 'fulfilled' ? (knowledgeRes.value.docs || []).slice(0, 5) : [];
        const allWorkflows = workflowsRes.status === 'fulfilled' ? (workflowsRes.value.workflows || workflowsRes.value || []) : [];
        const q = value.trim().toLowerCase();
        const matchedWorkflows = allWorkflows.filter((w: any) =>
          (w.name || '').toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)
        ).slice(0, 5);
        setGlobalResults({ knowledge: knowledgeDocs, workflows: matchedWorkflows });
      } catch (err) {
        logger.error('Global search error:', err);
      } finally {
        setIsGlobalSearching(false);
      }
    }, 300);
  }, [searchChats]);

  const handleCreate = async () => {
    try {
      if (searchQuery || filterTag) {
        setSearchInput('');
        searchChats('');
        filterByTag(null);
      }
      await createNewChat();
      // Always navigate to chat page — even if already on '/', this ensures UI refreshes
      navigate('/');
      onChatSelect?.();
    } catch (err) {
      logger.error('Failed to create chat:', err);
      toast.error(t('toast.createChatFailed'));
    }
  };

  const handleSelect = (chatId: string) => {
    if (batchMode) {
      toggleSelection(chatId);
      return;
    }
    if (chatId !== currentChatId) {
      selectChat(chatId);
    }
    // Ensure navigation to home page if selected from a page other than '/'
    if (window.location.pathname !== '/') {
      navigate('/');
    }
    onChatSelect?.();
  };

  const handleStartRename = (chatId: string, currentTitle: string) => {
    setEditingId(chatId);
    setEditTitle(currentTitle);
    setActiveMenuId(null);
  };

  const handleConfirmRename = async () => {
    if (editingId && editTitle.trim()) {
      try {
        await renameChat(editingId, editTitle.trim());
        toast.success(t('toast.renameSuccess'));
      } catch (err) {
        logger.error('Failed to rename:', err);
        toast.error(t('toast.renameFailed'));
      }
    }
    setEditingId(null);
  };

  const handleCancelRename = () => {
    setEditingId(null);
  };

  const handleDelete = async (chatId: string) => {
    setDeletingId(chatId);
    setActiveMenuId(null);
    try {
      await deleteChat(chatId);
      toast.success(t('toast.deleteSuccess'));
    } catch (err) {
      logger.error('Failed to delete:', err);
      toast.error(t('toast.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleTagClick = (tag: string) => {
    if (filterTag === tag) {
      filterByTag(null);
    } else {
      filterByTag(tag);
    }
    setShowTags(false);
  };

  const handleLogout = async () => {
    const ok = await confirmDialog({
      title: t('sidebar.logout'),
      message: `${t('sidebar.logout')}?`,
      variant: 'warning',
      confirmText: t('sidebar.logout'),
      cancelText: t('common.cancel'),
    });
    if (ok) await logout();
  };

  // ─── Batch operations ──────────────────────────────────────
  const toggleSelection = (chatId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(chats.map(c => c.id)));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirmDialog({
      title: t('sidebar.delete'),
      message: `${t('sidebar.delete')} ${selectedIds.size} ${t('sidebar.foundChats')}?`,
      variant: 'danger',
      confirmText: t('sidebar.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    setIsBatchDeleting(true);
    try {
      await batchDeleteChats(Array.from(selectedIds));
      toast.success(`${t('toast.batchDeleteSuccess')} ${selectedIds.size} ${t('sidebar.foundChats')}`);
      setSelectedIds(new Set());
      setBatchMode(false);
    } catch (err) {
      logger.error('Batch delete failed:', err);
      toast.error(t('toast.batchDeleteFailed'));
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  // ─── Group chats by tag when filtering ─────────────────────
  const groupedChats = useMemo(() => {
    if (filterTag) return null; // Already filtered by single tag
    if (!showTags) return null;
    // Group by first tag
    const groups: Record<string, typeof chats> = { 'untagged': [] };
    chats.forEach(chat => {
      const tags = parseTags(chat.tags);
      if (tags.length === 0) {
        groups['untagged'].push(chat);
      } else {
        tags.forEach(tag => {
          if (!groups[tag]) groups[tag] = [];
          groups[tag].push(chat);
        });
      }
    });
    return groups;
  }, [chats, filterTag, showTags]);

  const formatTime = (dateStr: string) => formatSmartTime(dateStr, locale);

  // ─── Group chats by time ────────────────────────────────────
  function groupChatsByTime(chatList: typeof chats) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);
    const weekStart = new Date(todayStart.getTime() - 7 * 86400000);
    return [
      { label: '今天', items: chatList.filter(c => new Date(c.updatedAt || c.createdAt) >= todayStart) },
      { label: '昨天', items: chatList.filter(c => { const d = new Date(c.updatedAt || c.createdAt); return d >= yesterdayStart && d < todayStart; }) },
      { label: '本周', items: chatList.filter(c => { const d = new Date(c.updatedAt || c.createdAt); return d >= weekStart && d < yesterdayStart; }) },
      { label: '更早', items: chatList.filter(c => new Date(c.updatedAt || c.createdAt) < weekStart) },
    ].filter(g => g.items.length > 0);
  }

  // ─── Render a single chat item ─────────────────────────────
  const renderChatItem = (chat: typeof chats[0]) => {
    const isActive = chat.id === currentChatId;
    const isEditing = chat.id === editingId;
    const isDeleting = chat.id === deletingId;
    const chatTags = parseTags(chat.tags);
    const isMenuOpen = activeMenuId === chat.id;
    const isSelected = selectedIds.has(chat.id);

    return (
      <div
        key={chat.id}
        role="option"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        className={`group relative flex items-center mx-1.5 my-0.5 rounded-lg cursor-pointer transition-colors
          ${batchMode && isSelected ? 'bg-blue-600/15 border border-blue-500/30' : ''}
          ${!batchMode && isActive ? 'bg-zinc-700/70' : ''}
          ${!batchMode && !isActive ? 'hover:bg-zinc-800/70 active:bg-zinc-800' : ''}
          ${batchMode && !isSelected ? 'hover:bg-zinc-800/50' : ''}
          ${isDeleting ? 'opacity-50' : ''}
          focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50`}
        onClick={() => !isEditing && handleSelect(chat.id)}
      >
        {/* Batch selection checkbox */}
        {batchMode && (
          <div className="pl-2 shrink-0">
            {isSelected ? (
              <CheckSquare size={16} className="text-blue-400" />
            ) : (
              <Square size={16} className="text-zinc-600" />
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 px-3 py-2.5">
          {isEditing ? (
            <div className="flex items-center gap-1">
              <input
                ref={editInputRef}
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmRename();
                  if (e.key === 'Escape') handleCancelRename();
                }}
                className="flex-1 bg-zinc-800 text-zinc-100 text-sm rounded px-1.5 py-0.5 
                           border border-zinc-600 focus:border-blue-500 focus:outline-none"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                onClick={(e) => { e.stopPropagation(); handleConfirmRename(); }}
                className="p-1 text-green-400 hover:text-green-300"
              >
                <Check size={14} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleCancelRename(); }}
                className="p-1 text-zinc-400 hover:text-zinc-300"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium truncate text-zinc-200">
                <HighlightText text={chat.title || t('sidebar.newConversation')} query={searchQuery} />
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                {chat.lastMessage && (
                  <p className="text-xs text-zinc-500 truncate flex-1">
                    <HighlightText text={stripMarkdown(chat.lastMessage).slice(0, 50)} query={searchQuery} />
                  </p>
                )}
                <span className="text-xs text-zinc-600 shrink-0">
                  {formatTime(chat.updatedAt)}
                </span>
              </div>
              {chatTags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {chatTags.map((tag) => {
                    const color = getTagColor(tag);
                    return (
                      <span
                        key={tag}
                        className={`text-[10px] px-1.5 py-0 rounded-full border ${color.bg} ${color.border} ${color.text}`}
                      >
                        {tag}
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Action buttons — hover on desktop, always-visible menu button on mobile */}
        {!isEditing && !batchMode && (
          <>
            {/* Desktop: hover actions */}
            <div className="hidden md:flex md:opacity-0 md:group-hover:opacity-100 items-center gap-0.5 pr-2 transition-opacity">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartRename(chat.id, chat.title);
                }}
                className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
                title={t('sidebar.rename')}
                aria-label={t('sidebar.rename')}
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`${t('sidebar.deleteConfirm')}?`)) {
                    handleDelete(chat.id);
                  }
                }}
                className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-700"
                title={t('sidebar.delete')}
                aria-label={t('sidebar.delete')}
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* Mobile + Desktop: three-dot menu */}
            <div className="relative pr-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuId(isMenuOpen ? null : chat.id);
                }}
                className={`p-1.5 rounded-md transition-colors
                  ${isMenuOpen || isActive
                    ? 'text-zinc-300 bg-zinc-700/50'
                    : 'text-zinc-500 md:opacity-0 md:group-hover:opacity-100'
                  }
                  hover:text-zinc-200 hover:bg-zinc-700`}
                style={{ opacity: isMenuOpen ? 1 : undefined }}
              >
                <MoreVertical size={14} />
              </button>

              {/* Dropdown menu */}
              {isMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 w-32 py-1
                             bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl shadow-black/40"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => handleStartRename(chat.id, chat.title)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    <Pencil size={12} />
                    {t('sidebar.rename')}
                  </button>
                  {/* Export submenu */}
                  <button
                    onClick={async () => {
                      setActiveMenuId(null);
                      setExportingId(chat.id);
                      try {
                        const detail = await fetchChatDetail(chat.id);
                        exportChat(detail.chat, detail.messages, 'md');
                      } catch (err) {
                        logger.error('Export failed:', err);
                        toast.error(t('toast.exportFailed'));
                      } finally {
                        setExportingId(null);
                      }
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    <FileText size={12} />
                    {exportingId === chat.id ? t('common.loading') : 'Export Markdown'}
                  </button>
                  <button
                    onClick={async () => {
                      setActiveMenuId(null);
                      setExportingId(chat.id);
                      try {
                        const detail = await fetchChatDetail(chat.id);
                        exportChat(detail.chat, detail.messages, 'json');
                      } catch (err) {
                        logger.error('Export failed:', err);
                        toast.error(t('toast.exportFailed'));
                      } finally {
                        setExportingId(null);
                      }
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    <FileJson size={12} />
                    {exportingId === chat.id ? t('common.loading') : 'Export JSON'}
                  </button>
                  <button
                    onClick={() => {
                      setActiveMenuId(null);
                      setShareDialogChatId(chat.id);
                      setShareDialogTitle(chat.title || t('sidebar.newConversation'));
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    <Share2 size={12} />
                    Share
                  </button>
                  <div className="border-t border-zinc-700 my-1" />
                  <button
                    onClick={() => {
                      if (confirm(`${t('sidebar.deleteConfirm')}?`)) {
                        handleDelete(chat.id);
                      }
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-zinc-700 transition-colors"
                  >
                    <Trash2 size={12} />
                    {t('sidebar.delete')}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div ref={sidebarRef} className="flex flex-col h-full bg-zinc-900 text-zinc-100">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-300">{t('sidebar.conversations')}</h2>
        <div className="flex items-center gap-1.5">
          {/* Batch mode toggle */}
          <button
            onClick={() => batchMode ? exitBatchMode() : setBatchMode(true)}
            className={`flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors
              ${batchMode
                ? 'bg-amber-600/20 border border-amber-500/40 text-amber-300 hover:bg-amber-600/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            title={batchMode ? t('sidebar.exitBatchMode') : t('sidebar.batchManage')}
            aria-label={batchMode ? t('sidebar.exitBatchMode') : t('sidebar.batchManage')}
          >
            {batchMode ? <XSquare size={14} /> : <CheckSquare size={14} />}
          </button>
          <button
            onClick={handleCreate}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md
                       bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white transition-colors"
            title={`${t('sidebar.newChat')} (Ctrl+N)`}
            aria-label={t('sidebar.newChat')}
          >
            <Plus size={14} />
            <span>{t('sidebar.newChat')}</span>
          </button>
        </div>
      </div>

      {/* Batch mode toolbar */}
      {batchMode && (
        <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 border-b border-zinc-700/50">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">
              {t('sidebar.selected')} <span className="text-zinc-200 font-medium">{selectedIds.size}</span>
            </span>
            <button
              onClick={selectAll}
              className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              {t('sidebar.selectAll')}
            </button>
            {selectedIds.size > 0 && (
              <button
                onClick={deselectAll}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {t('sidebar.deselectAll')}
              </button>
            )}
          </div>
          <button
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0 || isBatchDeleting}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md
                       bg-red-600/20 border border-red-500/40 text-red-300 
                       hover:bg-red-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isBatchDeleting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            )}
            {t('sidebar.delete')}
          </button>
        </div>
      )}

      {/* Global Search */}
      <div className="px-3 pt-2 pb-1 relative" ref={globalSearchRef}>
        <div className="flex items-center gap-1.5 bg-zinc-800 rounded-lg border border-zinc-700 px-2.5 py-2
                        focus-within:border-zinc-500 transition-colors">
          <Search size={14} className="text-zinc-500 shrink-0" />
          <input
            data-sidebar-search
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            onFocus={() => { if (searchInput.trim() && (globalResults.knowledge.length > 0 || globalResults.workflows.length > 0)) setShowGlobalResults(true); }}
            placeholder={t('sidebar.globalSearch')}
            aria-label={t('sidebar.globalSearch')}
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none"
          />
          {isGlobalSearching && <Loader2 size={14} className="animate-spin text-zinc-500 shrink-0" />}
          {searchInput && (
            <button
              onClick={() => { setSearchInput(''); searchChats(''); setGlobalResults({ knowledge: [], workflows: [] }); setShowGlobalResults(false); }}
              className="text-zinc-500 hover:text-zinc-300 p-0.5"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {/* Global search results dropdown */}
        {showGlobalResults && searchInput.trim() && (
          <div className="absolute left-3 right-3 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
            {/* Knowledge results */}
            {globalResults.knowledge.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-750 border-b border-zinc-700/50">
                  <FolderOpen size={12} className="text-blue-400" />
                  <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">{t('sidebar.knowledge')}</span>
                  <span className="text-[10px] text-zinc-600">({globalResults.knowledge.length})</span>
                </div>
                {globalResults.knowledge.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => { navigate('/knowledge'); setShowGlobalResults(false); setSearchInput(''); searchChats(''); onChatSelect?.(); }}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-700/50 transition-colors flex items-start gap-2"
                  >
                    <FileText size={14} className="text-blue-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs text-zinc-200 truncate">{doc.title}</p>
                      <p className="text-[10px] text-zinc-500 truncate">{doc.category}{doc.description ? ` · ${doc.description}` : ''}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {/* Workflow results */}
            {globalResults.workflows.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-750 border-b border-zinc-700/50">
                  <Zap size={12} className="text-amber-400" />
                  <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">{t('sidebar.workflows')}</span>
                  <span className="text-[10px] text-zinc-600">({globalResults.workflows.length})</span>
                </div>
                {globalResults.workflows.map((wf) => (
                  <button
                    key={wf.id}
                    onClick={() => { navigate('/workflows'); setShowGlobalResults(false); setSearchInput(''); searchChats(''); onChatSelect?.(); }}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-700/50 transition-colors flex items-start gap-2"
                  >
                    <Zap size={14} className="text-amber-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs text-zinc-200 truncate">{wf.name}</p>
                      {wf.description && <p className="text-[10px] text-zinc-500 truncate">{wf.description}</p>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {/* Chat results hint */}
            {chats.length > 0 && searchQuery && (
              <div className="px-3 py-2 border-t border-zinc-700/50">
                <p className="text-[10px] text-zinc-500">
                  <MessageSquare size={10} className="inline mr-1" />
                  {chats.length} {t('sidebar.foundChats')}
                </p>
              </div>
            )}
            {/* No results */}
            {globalResults.knowledge.length === 0 && globalResults.workflows.length === 0 && !isGlobalSearching && (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-zinc-500">{t('sidebar.noKnowledgeOrWorkflow')}</p>
                {chats.length > 0 && searchQuery && (
                  <p className="text-[10px] text-zinc-600 mt-1">{chats.length} {t('sidebar.foundChats')}</p>
                )}
              </div>
            )}
          </div>
        )}
        {searchQuery && !showGlobalResults && (
          <p className="text-[10px] text-zinc-500 mt-1 px-1">
            "{searchQuery}" — {chats.length} {t('sidebar.foundChats')}
          </p>
        )}
      </div>

      {/* Tags Filter */}
      {allTags.length > 0 && (
        <div className="px-3 pb-1">
          <button
            onClick={() => setShowTags(!showTags)}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-1"
          >
            <Tag size={12} />
            <span>{filterTag ? `${t('sidebar.tagFilter')}: ${filterTag}` : t('sidebar.tagFilter')}</span>
            <ChevronDown size={12} className={`transition-transform ${showTags ? 'rotate-180' : ''}`} />
            {filterTag && (
              <button
                onClick={(e) => { e.stopPropagation(); filterByTag(null); }}
                className="ml-1 text-zinc-500 hover:text-zinc-300 p-0.5"
              >
                <X size={12} />
              </button>
            )}
          </button>
          {showTags && (
            <div className="flex flex-wrap gap-1.5 mt-1.5 pb-1">
              {allTags.map((tag) => {
                const color = getTagColor(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => handleTagClick(tag)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      filterTag === tag
                        ? `${color.bg} ${color.border} ${color.text}`
                        : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Shared with me toggle */}
      <div className="px-3 pb-1">
        <button
          onClick={async () => {
            const next = !showSharedWithMe;
            setShowSharedWithMe(next);
            if (next && sharedChats.length === 0) {
              setIsLoadingShared(true);
              try {
                const data = await fetchSharedWithMe();
                setSharedChats(data);
              } catch (err) {
                logger.error('Failed to load shared chats:', err);
              } finally {
                setIsLoadingShared(false);
              }
            }
          }}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-1"
        >
          <Inbox size={12} />
          <span>{t('sidebar.sharedChats')}</span>
          <ChevronDown size={12} className={`transition-transform ${showSharedWithMe ? 'rotate-180' : ''}`} />
          {sharedChats.length > 0 && (
            <span className="ml-1 text-[10px] bg-blue-600/20 text-blue-300 px-1.5 py-0 rounded-full">
              {sharedChats.length}
            </span>
          )}
        </button>
        {showSharedWithMe && (
          <div className="mt-1 space-y-0.5">
            {isLoadingShared ? (
              <div className="flex items-center justify-center py-3">
                <Loader2 size={14} className="animate-spin text-zinc-500" />
              </div>
            ) : sharedChats.length === 0 ? (
              <p className="text-[10px] text-zinc-600 py-2 text-center">{t('sidebar.noSharedChats')}</p>
            ) : (
              sharedChats.map((sc) => (
                <div
                  key={sc.chatId}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer
                             bg-zinc-800/30 hover:bg-zinc-800/70 transition-colors"
                  onClick={() => {
                    selectChat(sc.chatId);
                    onChatSelect?.();
                  }}
                >
                  <Share2 size={11} className="text-blue-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-zinc-200 truncate">{sc.title || t('sidebar.newConversation')}</p>
                    <p className="text-[10px] text-zinc-500 truncate">
                      {t('sidebar.from')} {sc.sharedByDisplayName || sc.sharedByUsername}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Quick Nav — Role-aware navigation */}
      {user && (
        <div className="border-b border-zinc-800 shrink-0">
          {(() => {
            const isAdmin = user.role === 'admin';
            // ── Common tools (all roles) ──
            type NavItem = { key: string; icon: typeof Cpu; label: string; action: () => void; hoverColor: string; badge?: number; requiredRole?: 'admin'; permission?: string };
            const commonTools: NavItem[] = [
              { key: 'capabilities', icon: Cpu, label: t('sidebar.capabilities'), action: () => setCapabilitiesPanelOpen(true), hoverColor: 'hover:text-cyan-300 hover:bg-cyan-500/10' , permission: 'chat:read' },
              { key: 'knowledge', icon: FolderOpen, label: t('sidebar.knowledge'), action: () => { navigate('/knowledge'); onChatSelect?.(); }, hoverColor: 'hover:text-blue-300 hover:bg-blue-500/10' , permission: 'knowledge:read' },
              { key: 'workflows', icon: Zap, label: t('sidebar.workflows'), action: () => { navigate('/workflows'); onChatSelect?.(); }, hoverColor: 'hover:text-amber-300 hover:bg-amber-500/10' , permission: 'workflow:read' },
              { key: 'tasks', icon: ListTodo, label: t('sidebar.tasks'), action: () => { navigate('/tasks'); onChatSelect?.(); }, hoverColor: 'hover:text-teal-300 hover:bg-teal-500/10' , permission: 'task:read' },
              { key: 'notifications', icon: Bell, label: t('sidebar.notifications'), action: () => { navigate('/notifications'); onChatSelect?.(); }, hoverColor: 'hover:text-cyan-300 hover:bg-cyan-500/10', badge: unreadCount , permission: 'chat:read' },
              { key: 'prompts', icon: Sparkles, label: t('sidebar.promptTemplates'), action: () => { navigate('/prompts'); onChatSelect?.(); }, hoverColor: 'hover:text-purple-300 hover:bg-purple-500/10', requiredRole: 'admin' , permission: 'prompt:read' },
            ];
            // ── Business modules (user sees subset, admin sees all) ──
            const businessModules: NavItem[] = [
              { key: 'tickets', icon: Headphones, label: t('sidebar.tickets'), action: () => { navigate('/tickets'); onChatSelect?.(); }, hoverColor: 'hover:text-orange-300 hover:bg-orange-500/10' , permission: 'ticket:read' },
              { key: 'kols', icon: Crown, label: t('sidebar.kol'), action: () => { navigate('/kols'); onChatSelect?.(); }, hoverColor: 'hover:text-yellow-300 hover:bg-yellow-500/10' , permission: 'kol:read' },
              { key: 'tiktok', icon: BarChart3, label: locale === 'en' ? 'TK Dashboard' : 'TK 看板', action: () => { navigate('/tiktok-partners'); onChatSelect?.(); }, hoverColor: 'hover:text-pink-300 hover:bg-pink-500/10' , permission: 'tiktok:read' },
              { key: 'scripts', icon: Film, label: locale === 'en' ? 'Scripts' : '文案', action: () => { navigate('/tiktok-scripts'); onChatSelect?.(); }, hoverColor: 'hover:text-violet-300 hover:bg-violet-500/10' , permission: 'script:read' },
              { key: 'inventory', icon: Package, label: locale === 'en' ? 'Inventory' : '库存', action: () => { navigate('/inventory'); onChatSelect?.(); }, hoverColor: 'hover:text-amber-300 hover:bg-amber-500/10' , permission: 'inventory:read' },
              { key: 'data-upload', icon: Upload, label: locale === 'en' ? 'Data Import' : '数据摄食', action: () => { navigate('/data-upload'); onChatSelect?.(); }, hoverColor: 'hover:text-cyan-300 hover:bg-cyan-500/10' , permission: 'data:import' },
              { key: 'daily', icon: Clock, label: t('sidebar.dailyReports'), action: () => { navigate('/daily-reports'); onChatSelect?.(); }, hoverColor: 'hover:text-lime-300 hover:bg-lime-500/10' , permission: 'analytics:all' },
              { key: 'analytics', icon: BarChart3, label: t('sidebar.dataAnalytics'), action: () => { navigate('/data-analytics'); onChatSelect?.(); }, hoverColor: 'hover:text-indigo-300 hover:bg-indigo-500/10' , permission: 'analytics:read' },
              { key: 'price-monitor', icon: TrendingUp, label: locale === 'en' ? 'Price Monitor' : '价格监控', action: () => { navigate('/price-monitor'); onChatSelect?.(); }, hoverColor: 'hover:text-emerald-300 hover:bg-emerald-500/10' , permission: 'analytics:read' },
            ];
            // ── Admin-only modules ──
            const adminModules: NavItem[] = [
              { key: 'ceo', icon: Eye, label: t('sidebar.ceoDashboard'), action: () => { navigate('/ceo'); onChatSelect?.(); }, hoverColor: 'hover:text-sky-300 hover:bg-sky-500/10', requiredRole: 'admin' , permission: 'ceo_dashboard:read' },
              { key: 'team', icon: Users, label: t('sidebar.team'), action: () => { navigate('/team'); onChatSelect?.(); }, hoverColor: 'hover:text-violet-300 hover:bg-violet-500/10', requiredRole: 'admin' , permission: 'team:read' },
              { key: 'admin', icon: Shield, label: t('sidebar.console'), action: () => { navigate('/admin'); onChatSelect?.(); }, hoverColor: 'hover:text-rose-300 hover:bg-rose-500/10', requiredRole: 'admin' , permission: 'system:config' },
              { key: 'stats', icon: BarChart3, label: t('sidebar.stats'), action: () => { navigate('/stats'); onChatSelect?.(); }, hoverColor: 'hover:text-emerald-300 hover:bg-emerald-500/10', requiredRole: 'admin' , permission: 'analytics:all' },
              { key: 'invite', icon: Ticket, label: t('sidebar.inviteCodes'), action: () => { navigate('/invite-codes'); onChatSelect?.(); }, hoverColor: 'hover:text-blue-300 hover:bg-blue-500/10', requiredRole: 'admin' , permission: 'system:invite' },
              { key: 'ops', icon: Gauge, label: locale === 'en' ? 'Ops' : '运营', action: () => { navigate('/ops-efficiency'); onChatSelect?.(); }, hoverColor: 'hover:text-teal-300 hover:bg-teal-500/10', requiredRole: 'admin' , permission: 'analytics:all' },
              { key: 'cost', icon: DollarSign, label: locale === 'en' ? 'Cost' : '成本统计', action: () => { navigate('/cost'); onChatSelect?.(); }, hoverColor: 'hover:text-emerald-300 hover:bg-emerald-500/10', requiredRole: 'admin' , permission: 'system:config' },
            ];
            // Filter by RBAC permissions (server-driven)
            const filterByPermission = (items: NavItem[]) => 
              items.filter(item => {
                if (!item.permission) return true;
                return canPerm(item.permission);
              });
            const visibleCommon = filterByPermission(commonTools);
            const visibleBusiness = filterByPermission(businessModules);
            const visibleAdmin = filterByPermission(adminModules);
            const renderNavItem = (item: NavItem) => (
              <button
                key={item.key}
                onClick={item.action}
                className={`flex flex-col items-center gap-1 px-1 py-2.5 min-h-[44px] rounded-lg text-zinc-400 ${item.hoverColor} transition-colors active:bg-zinc-800/50 touch-manipulation ${item.badge ? 'relative' : ''}`}
              >
                <item.icon size={16} />
                <span className="text-[10px] leading-tight truncate w-full text-center">{item.label}</span>
                {item.badge && item.badge > 0 ? (
                  <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] flex items-center justify-center px-0.5 bg-red-500 text-white text-[8px] font-bold rounded-full leading-none">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </button>
            );
            return (
              <div className="px-1 pb-1 space-y-0">
                {/* ── Common Tools Group ── */}
                <button
                  onClick={() => toggleGroup('tools')}
                  className="flex items-center justify-between w-full px-2 py-2 min-h-[44px] hover:bg-zinc-800/50 transition-colors rounded-md active:bg-zinc-800/70 touch-manipulation"
                >
                  <div className="flex items-center gap-2">
                    <LayoutGrid size={14} className="text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-400">{t('sidebar.navGroupTools')}</span>
                    <span className="text-[10px] text-zinc-600">({visibleCommon.length})</span>
                  </div>
                  <ChevronDown size={14} className={`text-zinc-600 transition-transform duration-200 ${groupCollapsed['tools'] ? '-rotate-90' : ''}`} />
                </button>
                {!groupCollapsed['tools'] && (
                  <div className="grid grid-cols-3 gap-1 px-1 pb-1 animate-in slide-in-from-top-1 duration-200">
                    {visibleCommon.map(renderNavItem)}
                  </div>
                )}

                {/* ── Business Modules Group ── */}
                <button
                  onClick={() => toggleGroup('business')}
                  className="flex items-center justify-between w-full px-2 py-2 min-h-[44px] hover:bg-zinc-800/50 transition-colors rounded-md active:bg-zinc-800/70 touch-manipulation"
                >
                  <div className="flex items-center gap-2">
                    <Headphones size={14} className="text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-400">{locale === 'en' ? 'Business' : '业务模块'}</span>
                    <span className="text-[10px] text-zinc-600">({visibleBusiness.length})</span>
                  </div>
                  <ChevronDown size={14} className={`text-zinc-600 transition-transform duration-200 ${groupCollapsed['business'] ? '-rotate-90' : ''}`} />
                </button>
                {!groupCollapsed['business'] && (
                  <div className="grid grid-cols-3 gap-1 px-1 pb-1 animate-in slide-in-from-top-1 duration-200">
                    {visibleBusiness.map(renderNavItem)}
                  </div>
                )}

                {/* ── Admin-only Modules Group ── */}
                {visibleAdmin.length > 0 && (
                  <>
                    <button
                      onClick={() => toggleGroup('admin')}
                      className="flex items-center justify-between w-full px-2 py-2 min-h-[44px] hover:bg-zinc-800/50 transition-colors rounded-md active:bg-zinc-800/70 touch-manipulation"
                    >
                      <div className="flex items-center gap-2">
                        <Shield size={14} className="text-amber-500" />
                        <span className="text-xs font-medium text-amber-600">{t('sidebar.navGroupAdmin')}</span>
                        <span className="text-[10px] text-amber-700">({visibleAdmin.length})</span>
                      </div>
                      <ChevronDown size={14} className={`text-amber-600 transition-transform duration-200 ${groupCollapsed['admin'] ? '-rotate-90' : ''}`} />
                    </button>
                    {!groupCollapsed['admin'] && (
                      <div className="grid grid-cols-3 gap-1 px-1 pb-1 animate-in slide-in-from-top-1 duration-200">
                        {visibleAdmin.map(item => (
                          <button
                            key={item.key}
                            onClick={item.action}
                            className={`flex flex-col items-center gap-1 px-1 py-2.5 min-h-[44px] rounded-lg text-zinc-400 ${item.hoverColor} transition-colors border border-transparent hover:border-amber-500/20 active:bg-zinc-800/50 touch-manipulation`}
                          >
                            <item.icon size={16} />
                            <span className="text-[10px] leading-tight truncate w-full text-center">{item.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto mobile-scroll mobile-no-scrollbar overscroll-contain">
        {isLoadingChats ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-zinc-500" />
          </div>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <MessageSquare size={32} className="text-zinc-600 mb-2" />
            <p className="text-sm text-zinc-500">
              {searchQuery ? t('sidebar.noMatchingChats') : filterTag ? t('sidebar.noTagChats') : t('sidebar.noChatsYet')}
            </p>
            {!searchQuery && !filterTag && (
              <p className="text-xs text-zinc-600 mt-1">{t('sidebar.clickNewToStart')}</p>
            )}
          </div>
        ) : (
          <div
            className="py-1"
            role="listbox"
            aria-label={t('sidebar.chatList')}
            onKeyDown={(e) => {
              if (batchMode || chats.length === 0) return;
              const idx = chats.findIndex(c => c.id === currentChatId);
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = idx < chats.length - 1 ? idx + 1 : 0;
                handleSelect(chats[next].id);
                (e.currentTarget.children[next] as HTMLElement)?.focus();
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = idx > 0 ? idx - 1 : chats.length - 1;
                handleSelect(chats[prev].id);
                (e.currentTarget.children[prev] as HTMLElement)?.focus();
              }
            }}
          >
            {groupChatsByTime(chats).map(group => (
              <div key={group.label}>
                <div className="px-3 py-1 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{group.label}</div>
                {group.items.map(renderChatItem)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer — User info only */}
      <div className="border-t border-zinc-800">
        {/* Compact user info row */}
        {user && (
          <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-zinc-800/50">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className="w-5 h-5 rounded-full bg-blue-600/20 flex items-center justify-center shrink-0">
                <UserIcon size={11} className="text-blue-400" />
              </div>
              <span className="text-[11px] font-medium text-zinc-400 truncate">{user.displayName}</span>
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                wsConnected 
                  ? (gatewayConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse') 
                  : (wsReconnecting ? 'bg-orange-500 animate-pulse' : 'bg-red-500')
              }`} />
              <span className="text-[10px] text-zinc-600 shrink-0">
                {wsConnected
                  ? (gatewayConnected ? t('sidebar.aiReady') : t('sidebar.aiStarting'))
                  : (wsReconnecting 
                      ? `${t('sidebar.reconnecting')}${wsReconnectAttempt > 0 ? ` (${wsReconnectAttempt})` : ''}`
                      : t('sidebar.disconnectedShort'))}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setMemoryDialogOpen(true)}
                className="p-1 rounded text-zinc-600 hover:text-purple-400 hover:bg-zinc-800 transition-colors"
                title="AI 记忆"
                aria-label="AI Memory"
              >
                <Brain size={13} />
              </button>
              <LanguageSwitcher collapsed />
              <button
                onClick={handleLogout}
                className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                title={t('sidebar.logout')}
                aria-label={t('sidebar.logout')}
              >
                <LogOut size={13} />
              </button>
            </div>
          </div>
        )}
      </div>
      {/* Share Dialog */}
      {shareDialogChatId && (
        <ShareDialog
          chatId={shareDialogChatId}
          chatTitle={shareDialogTitle}
          isOpen={!!shareDialogChatId}
          onClose={() => setShareDialogChatId(null)}
        />
      )}
      {/* User Memory Dialog */}
      {user && (
        <UserMemoryDialog
          open={memoryDialogOpen}
          onClose={() => setMemoryDialogOpen(false)}
          userId={user.id}
        />
      )}
      {/* AI Capabilities Panel */}
      <CapabilitiesPanel
        isOpen={capabilitiesPanelOpen}
        onClose={() => setCapabilitiesPanelOpen(false)}
      />
      {ConfirmDialogUI}
    </div>
  );
}
