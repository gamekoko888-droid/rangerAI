/**
 * ChatPage — Main chat interface with responsive sidebar, message area, and file panel.
 * Mobile: drawer-style sidebar with overlay + bottom sheet file panel.
 * Desktop: collapsible sidebar + resizable file panel on the right.
 */

import { lazy, useState, useEffect, useCallback, useMemo } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { toast } from 'sonner';
import { ChatProvider, useOrchestrator } from '../hooks/useChatStore';
import { ToolConfirmModal } from '../components/ToolConfirmModal';
import { useAuthStore } from '../stores/useAuthStore';
import { useChatListStore } from '../stores/useChatListStore';
import { useConnectionStore } from '../stores/useConnectionStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { useChatActions } from '../hooks/useChatActions';
import { Sidebar } from '../components/chat/Sidebar';
const MessageList = lazy(() => import('../components/chat/MessageList').then((mod) => ({ default: mod.MessageList })));
import { MessageInput } from '../components/chat/MessageInput';
import { TagManager } from '../components/chat/TagManager';
import { FilePanel } from '../components/chat/FilePanel';
import LoginPage from './LoginPage';
import type { WorkspaceFileEntry } from '../lib/types';
import {
  PanelLeftClose, PanelLeft, Tag, Loader2, Menu, X,
  Wifi, WifiOff, FolderTree, PanelRightOpen,
  FolderOpen, Folder, FileText, ChevronRight, ChevronDown, Download,
} from 'lucide-react';
import { exportChat } from '../lib/exportUtils';
import * as api from '../lib/api';
import { ScrollArea } from '../components/ui/scroll-area';
import { useI18n } from '../lib/i18n';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

// ─── Export Dropdown Component ────────────────────────────────────

function ExportDropdown({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { t } = useI18n();

  const handleExport = useCallback(async (format: 'md' | 'json') => {
    setExporting(true);
    try {
      const detail = await api.fetchChatDetail(chatId);
      exportChat(detail.chat, detail.messages, format);
    } catch (err) {
      console.error('[Export] Failed:', err);
      toast.error(t('chatPage.exportError'));
    } finally {
      setExporting(false);
      setOpen(false);
    }
  }, [chatId]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = () => setOpen(false);
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 active:scale-95 transition-all"
        title={t('chatPage.exportConversation')}
        aria-label={t('chatPage.exportConversation')}
        disabled={exporting}
      >
        <Download size={16} className={exporting ? 'animate-pulse' : ''} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 z-50 min-w-[140px]">
          <button
            onClick={(e) => { e.stopPropagation(); handleExport('md'); }}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            📄 {t('chatPage.exportMarkdown')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleExport('json'); }}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            📦 {t('chatPage.exportJson')}
          </button>
        </div>
      )}
    </div>
  );
}

function ChatLayout() {
  const { user, isAuthLoading } = useAuthStore();
  const { currentChatId, chats } = useChatListStore();
  const { wsConnected, gatewayConnected } = useConnectionStore();
  const { isFilePanelOpen, changedFiles, toggleFilePanel } = useWorkspaceStore();
  const { createNewChat } = useChatActions();
  const { wsSend } = useOrchestrator();
  const { t } = useI18n();

  // ─── ALL hooks MUST be declared before any conditional return ───
  const [sidebarPref, setSidebarPref] = useLocalStorage('rangerai_sidebarOpen', true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const isMobile = useIsMobile();
  // File panel width (percentage of main area, desktop only)
  const [filePanelWidth, setFilePanelWidth] = useLocalStorage('rangerai_filePanelWidth', 40);
  const [isResizing, setIsResizing] = useState(false);
  // Mobile file panel state (must be before conditional returns)
  const [mobileFilePanelOpen, setMobileFilePanelOpen] = useState(false);

  // Default sidebar open on desktop (respect saved preference)
  useEffect(() => {
    if (!isMobile) {
      setSidebarOpen(sidebarPref);
    } else {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  // Close sidebar when selecting a chat on mobile
  const handleSidebarClose = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  // ─── Global keyboard shortcuts (via centralized hook) ─────────
  useKeyboardShortcuts(useMemo(() => [
    {
      key: 'k', mod: true,
      description: 'Focus sidebar search',
      handler: () => {
        const searchInput = document.querySelector('[data-sidebar-search]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
          if (!sidebarOpen) setSidebarOpen(true);
        }
      },
    },
    {
      key: 'n', mod: true,
      description: 'New chat',
      handler: () => createNewChat(),
    },
    {
      key: 'Escape',
      description: 'Close file panel / tag manager',
      handler: () => {
        if (tagManagerOpen) setTagManagerOpen(false);
        else if (isFilePanelOpen) {
          toggleFilePanel();
        }
      },
    },
    {
      key: '/', skipInInput: true,
      description: 'Focus message input',
      handler: () => {
        const input = document.querySelector('[data-message-input]') as HTMLTextAreaElement;
        if (input) input.focus();
      },
    },
  ], [sidebarOpen, createNewChat, tagManagerOpen, isFilePanelOpen]));

  // ─── Resize Handler for File Panel ─────────────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = filePanelWidth;
    const mainArea = (e.target as HTMLElement).closest('[data-main-area]');
    if (!mainArea) return;
    const mainWidth = mainArea.getBoundingClientRect().width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = startX - moveEvent.clientX;
      const deltaPercent = (deltaX / mainWidth) * 100;
      const newWidth = Math.min(70, Math.max(25, startWidth + deltaPercent));
      setFilePanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [filePanelWidth]);

  // ─── Conditional returns AFTER all hooks ───────────────────

  // Loading state
  if (isAuthLoading) {
    return (
      <div className="fixed inset-0 flex bg-zinc-950 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  // Auth guard — show login if not authenticated
  if (!user) {
    return <LoginPage />;
  }

  const showFilePanel = isFilePanelOpen && !isMobile;

  return (
    <div className="fixed inset-0 flex bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Mobile Overlay — sidebar */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile Overlay — file panel */}
      {isMobile && mobileFilePanelOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm"
          onClick={() => setMobileFilePanelOpen(false)}
        />
      )}

      {/* Sidebar */}
      {isMobile ? (
        /* Mobile: slide-in drawer */
        <div
          className={`fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] bg-zinc-900 
                      transform transition-transform duration-250 ease-out
                      ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <Sidebar onChatSelect={handleSidebarClose} />
        </div>
      ) : (
        /* Desktop: collapsible panel */
        <div
          className={`shrink-0 border-r border-zinc-800 transition-all duration-200 overflow-hidden ${
            sidebarOpen ? 'w-64 opacity-100' : 'w-0 opacity-0 pointer-events-none'
          }`}
        >
          <div className="w-64 h-full">
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main Area (Chat + File Panel) */}
      <div className="flex-1 flex min-w-0 h-full" data-main-area>
        {/* Chat Column */}
        <div
          className="flex flex-col min-w-0 h-full"
          style={{ width: showFilePanel ? `${100 - filePanelWidth}%` : '100%' }}
        >
          {/* Top Bar */}
          <div className="flex items-center justify-between h-11 px-2 sm:px-3 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <button
                onClick={() => { const next = !sidebarOpen; setSidebarOpen(next); if (!isMobile) setSidebarPref(next); }}
                className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 active:scale-95 transition-all shrink-0"
                title={sidebarOpen ? t('chatPage.collapseSidebar') : t('chatPage.expandSidebar')}
                aria-label={sidebarOpen ? t('chatPage.collapseSidebar') : t('chatPage.expandSidebar')}
              >
                {isMobile ? (
                  sidebarOpen ? <X size={18} /> : <Menu size={18} />
                ) : (
                  sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />
                )}
              </button>
              {currentChatId && (
                <span className="text-sm text-zinc-400 truncate">
                  {chats.find((c: { id: string; title?: string }) => c.id === currentChatId)?.title || t('sidebar.newConversation')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {/* WS Connection Status Indicator */}
              <div className="flex items-center gap-1 mr-1" role="status" aria-live="polite" title={
                wsConnected && gatewayConnected
                  ? t('chatPage.aiConnected')
                  : wsConnected
                    ? t('chatPage.wsConnectedAiConnecting')
                    : t('chatPage.disconnectedReconnecting')
              }>
                {wsConnected ? (
                  <Wifi size={14} className={gatewayConnected ? 'text-emerald-500' : 'text-amber-500'} />
                ) : (
                  <WifiOff size={14} className="text-red-500 animate-pulse" />
                )}
                <span className={`text-[11px] hidden sm:inline ${
                  wsConnected && gatewayConnected
                    ? 'text-emerald-500/70'
                    : wsConnected
                      ? 'text-amber-500/70'
                      : 'text-red-500/70'
                }`}>
                  {wsConnected && gatewayConnected
                    ? t('chatPage.connected')
                    : wsConnected
                      ? t('chatPage.aiConnecting')
                      : t('chatPage.reconnecting')}
                </span>
              </div>
              {currentChatId && (
                <>
                  <button
                    onClick={() => setTagManagerOpen(!tagManagerOpen)}
                    className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 active:scale-95 transition-all"
                    title={t('chatPage.manageTags')}
                    aria-label={t('chatPage.manageTags')}
                  >
                    <Tag size={16} />
                  </button>
                  <ExportDropdown chatId={currentChatId} />
                </>
              )}
              {/* File Panel Toggle */}
              {!isMobile ? (
                <button
                  onClick={() => toggleFilePanel()}
                  className={`p-1.5 rounded-md transition-colors relative ${
                    isFilePanelOpen
                      ? 'text-blue-400 hover:text-blue-300 bg-blue-500/10'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                  }`}
                  title={isFilePanelOpen ? t('chatPage.closeFilePanel') : t('chatPage.openFilePanel')}
                  aria-label={isFilePanelOpen ? t('chatPage.closeFilePanel') : t('chatPage.openFilePanel')}
                >
                  <FolderTree size={16} />
                  {changedFiles.length > 0 && !isFilePanelOpen && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  )}
                </button>
              ) : (
                <button
                  onClick={() => setMobileFilePanelOpen(true)}
                  className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 active:scale-95 transition-all relative"
                  title={t('chatPage.viewFiles')}
                  aria-label={t('chatPage.viewFiles')}
                >
                  <FolderTree size={16} />
                  {changedFiles.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Tag Manager Panel */}
          {tagManagerOpen && currentChatId && (
            <TagManager
              chatId={currentChatId}
              onClose={() => setTagManagerOpen(false)}
            />
          )}

          {/* Messages */}
          <MessageList key={currentChatId || 'empty'} />

          {/* Input */}
          <MessageInput />
        </div>

        {/* Resize Handle */}
        {showFilePanel && (
          <div
            onMouseDown={handleResizeStart}
            className={`
              w-1 shrink-0 cursor-col-resize relative group
              ${isResizing ? 'bg-blue-500/40' : 'bg-zinc-800 hover:bg-blue-500/30'}
              transition-colors
            `}
          >
            {/* Visual grip indicator */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-zinc-600 group-hover:bg-blue-400/60 transition-colors" />
          </div>
        )}

        {/* File Panel */}
        {showFilePanel && (
          <div
            className="shrink-0 overflow-hidden"
            style={{ width: `${filePanelWidth}%` }}
          >
            <FilePanel />
          </div>
        )}
      </div>

      {/* Mobile File Panel — Bottom Sheet */}
      {isMobile && mobileFilePanelOpen && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 transform transition-transform duration-300 ease-out translate-y-0"
          style={{ height: '75dvh' }}
        >
          {/* Drag handle */}
          <div
            className="flex justify-center py-2 bg-zinc-900 rounded-t-2xl border-t border-x border-zinc-700/50"
            onClick={() => setMobileFilePanelOpen(false)}
          >
            <div className="w-10 h-1 rounded-full bg-zinc-600" />
          </div>
          {/* File panel content */}
          <div className="h-full bg-zinc-900 overflow-hidden">
            <MobileFilePanel onClose={() => setMobileFilePanelOpen(false)} />
          </div>
        </div>
      )}
      {/* R8 Task 2: Tool Confirmation Modal */}
      <ToolConfirmModal wsSend={wsSend} />
    </div>
  );
}

/**
 * MobileFilePanel — Lightweight wrapper that opens FilePanel in mobile context.
 * Triggers loadWorkspaceFiles on mount and provides close button.
 */
function MobileFilePanel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { workspaceFiles, selectedFilePath, fileContent, isLoadingFiles, changedFiles, loadWorkspaceFiles, selectFile } = useWorkspaceStore();

  useEffect(() => {
    loadWorkspaceFiles();
  }, [loadWorkspaceFiles]);

  // Reload when files change
  useEffect(() => {
    if (changedFiles.length > 0) {
      const timer = setTimeout(() => loadWorkspaceFiles(), 500);
      return () => clearTimeout(timer);
    }
  }, [changedFiles, loadWorkspaceFiles]);

  // Iter-AO: iOS Safari keyboard offset via visualViewport API
  useEffect(() => {
    if (!window.visualViewport) return;
    const handleResize = () => {
      const offset = window.innerHeight - (window.visualViewport?.height ?? window.innerHeight);
      document.documentElement.style.setProperty('--keyboard-offset', `${offset}px`);
    };
    window.visualViewport.addEventListener('resize', handleResize);
    handleResize();
    return () => window.visualViewport?.removeEventListener('resize', handleResize);
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    selectFile(path);
  }, [selectFile]);

  const handleClosePreview = useCallback(() => {
    selectFile(null);
  }, [selectFile]);

  const hasFiles = workspaceFiles.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <FolderTree size={15} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">{t('chatPage.workspaceFiles')}</span>
          {changedFiles.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">
              {changedFiles.length} {t('chatPage.changes')}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      {selectedFilePath && fileContent ? (
        <div className="flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/80 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] text-zinc-200 truncate font-medium">
                {fileContent.path.split('/').pop()}
              </span>
            </div>
            <button
              onClick={handleClosePreview}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {t('chatPage.backToList')}
            </button>
          </div>
          <ScrollArea className="h-[calc(100%-40px)]">
            {fileContent.isBinary ? (
              <div className="flex items-center justify-center p-8 text-zinc-500">
                <p className="text-sm">{t('chatPage.binaryFile')}</p>
              </div>
            ) : (
              <pre className="p-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap break-all">
                {fileContent.content}
              </pre>
            )}
          </ScrollArea>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {isLoadingFiles && !hasFiles ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-zinc-500" />
            </div>
          ) : !hasFiles ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <FolderTree size={28} className="text-zinc-600 mb-2" />
              <p className="text-sm text-zinc-400">{t('chatPage.noWorkspaceFiles')}</p>
              <p className="text-xs text-zinc-600 mt-1">{t('chatPage.filesAppearHere')}</p>
            </div>
          ) : (
            <div className="py-1">
              {workspaceFiles.map(entry => (
                <MobileTreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  selectedPath={selectedFilePath}
                  changedFiles={changedFiles}
                  onSelect={handleSelectFile}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * MobileTreeNode — Simplified tree node for mobile with larger touch targets.
 */
function MobileTreeNode({ entry, depth, selectedPath, changedFiles, onSelect }: {
  entry: WorkspaceFileEntry;
  depth: number;
  selectedPath: string | null;
  changedFiles: string[];
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = entry.type === 'directory';
  const isChanged = changedFiles.includes(entry.path);

  useEffect(() => {
    if (isDir && entry.children) {
      const hasChangedChild = changedFiles.some(f => f.startsWith(entry.path + '/'));
      if (hasChangedChild && !expanded) setExpanded(true);
    }
  }, [changedFiles, entry.path, entry.children, isDir, expanded]);

  const sortedChildren = useMemo(() => {
    if (!entry.children) return [];
    return [...entry.children].sort((a: WorkspaceFileEntry, b: WorkspaceFileEntry) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [entry.children]);

  return (
    <div>
      <button
        onClick={() => isDir ? setExpanded(!expanded) : onSelect(entry.path)}
        className={`w-full flex items-center gap-2 py-2.5 pr-3 text-left text-sm transition-colors
          ${selectedPath === entry.path ? 'bg-blue-500/15 text-blue-300' : 'text-zinc-400 active:bg-zinc-800'}
          ${isChanged ? 'text-amber-300' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 16}px` }}
      >
        {isDir && (
          <span className="shrink-0">
            {expanded ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />}
          </span>
        )}
        {!isDir && <span className="w-3.5 shrink-0" />}
        {isDir ? (
          expanded ? <FolderOpen size={16} className="text-amber-400 shrink-0" /> : <Folder size={16} className="text-amber-400/70 shrink-0" />
        ) : (
          <FileText size={16} className="text-zinc-500 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
        {isChanged && <span className="ml-auto shrink-0 w-2 h-2 rounded-full bg-amber-400" />}
      </button>
      {isDir && expanded && sortedChildren.map((child: WorkspaceFileEntry) => (
        <MobileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          changedFiles={changedFiles}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export default function ChatPage() {
  return (
    <ChatProvider>
      <ChatLayout />
    </ChatProvider>
  );
}
