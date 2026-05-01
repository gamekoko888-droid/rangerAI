/**
 * MessageInput — Chat input with file upload, send button, suggestions, model selector.
 * Supports: click upload, drag-and-drop, clipboard paste (images).
 * Mobile: compact layout, safe-area-aware, keyboard-friendly.
 * 
 * v2.1: Integrated useComposition hook to prevent IME Enter key from
 *       triggering message send (fixes Chinese input truncation bug).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useMessageStore } from '../../stores/useMessageStore';
import { useConnectionStore } from '../../stores/useConnectionStore';
import { useChatListStore } from '../../stores/useChatListStore';
import { useChatActions } from '../../hooks/useChatActions';
import { useComposition } from '../../hooks/useComposition';
import { ModelSelector } from './ModelSelector';
import { RoleSelector } from './RoleSelector';
import { FileUploadButton, isImageFile } from './FileUploadButton';
import { AttachmentPreview, type PendingAttachment } from './AttachmentPreview';
import * as api from '../../lib/api';
import { Send, Loader2, Square, Mic } from 'lucide-react';
import VoiceChat from './VoiceChat';
import { toast } from 'sonner';
import { useI18n } from '../../lib/i18n';
import { useIsMobile } from '../../hooks/useIsMobile';
import { logger } from "../../lib/logger";

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);

export function MessageInput() {
  const { sendMessage, cancelTask } = useChatActions();
  const { isStreaming, isCancelling, suggestions, selectedModel, selectedRole, setSelectedModel, setSelectedRole } = useMessageStore();
  const wsConnected = useConnectionStore(s => s.wsConnected);
  const wsDisconnectedDuringTask = useConnectionStore(s => s.wsDisconnectedDuringTask);
  // state destructured above via individual stores
  const { t } = useI18n();
  const isMobile = useIsMobile();

  // BUG-5 FIX: Cache unsent input per chatId to prevent loss on chat switch
  const inputCacheRef = useRef<Map<string, string>>(new Map());
  const [input, setInput] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const pendingInput = useMessageStore(s => s.pendingInput);
  const setPendingInput = useMessageStore(s => s.setPendingInput);
  useEffect(() => {
    if (pendingInput) {
      setInput(pendingInput);
      setPendingInput('');
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [pendingInput, setPendingInput]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }, [input]);

  // BUG-5 FIX: Save current input before switching, restore cached input for new chat
  useEffect(() => {
    // Save current input to cache before clearing
    const prevChatId = inputCacheRef.current.get('__current__');
    if (prevChatId && input.trim()) {
      inputCacheRef.current.set(prevChatId, input);
    }
    const newChatId = useChatListStore.getState().currentChatId;
    inputCacheRef.current.set('__current__', newChatId || '');
    // Restore cached input for the new chat, or empty
    const cached = newChatId ? (inputCacheRef.current.get(newChatId) || '') : '';
    setInput(cached);
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    // Auto-focus on desktop when switching chats
    if (window.innerWidth >= 768) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [useChatListStore.getState().currentChatId]);

  // Focus on mount and when streaming ends (desktop only)
  useEffect(() => {
    if (!isStreaming && window.innerWidth >= 768) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  // ─── File Upload Logic ─────────────────────────────────────

  const uploadFile = useCallback(async (file: File): Promise<PendingAttachment> => {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const isImage = IMAGE_TYPES.has(file.type);

    // Create preview for images
    let preview: string | undefined;
    if (isImage) {
      preview = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
    }

    const att: PendingAttachment = { id, file, preview, progress: 0 };
    return att;
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    // Create pending attachments with previews
    const newAtts: PendingAttachment[] = [];
    for (const file of files) {
      const att = await uploadFile(file);
      newAtts.push(att);
    }

    setAttachments(prev => [...prev, ...newAtts]);

    // Upload each file
    for (const att of newAtts) {
      try {
        const results = await api.uploadFiles([att.file], (percent) => {
          setAttachments(prev =>
            prev.map(a => a.id === att.id ? { ...a, progress: percent } : a)
          );
        });

        if (results.length > 0) {
          const uploaded = results[0];
          const fullUrl = api.getFileUrl(uploaded.path);
          setAttachments(prev =>
            prev.map(a => a.id === att.id
              ? { ...a, progress: 100, uploaded: { ...uploaded, url: fullUrl } }
              : a
            )
          );
        }
      } catch (err) {
        logger.error('Upload failed:', err);
        setAttachments(prev =>
          prev.map(a => a.id === att.id
            ? { ...a, progress: -1, error: (err as Error).message }
            : a
          )
        );
      }
    }
  }, [uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  // ─── Drag & Drop ───────────────────────────────────────────

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      processFiles(files);
    }
  }, [processFiles]);

  // ─── Clipboard Paste ───────────────────────────────────────

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));

    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems
        .map(item => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        processFiles(files);
      }
    }
    // Let text paste through normally
  }, [processFiles]);

  // ─── Send Message ──────────────────────────────────────────

  const handleSend = useCallback(async () => {
    // v2.1: Block send if IME is composing (prevents Chinese input truncation)
    if (composition.isComposing()) return;

    const trimmed = input.trim();
    const uploadedAtts = attachments.filter(a => a.uploaded);

    // Must have text or at least one uploaded attachment
    if (!trimmed && uploadedAtts.length === 0) return;
    // BUG-4 FIX: Show toast instead of silently discarding when AI is still processing
    if (isStreaming) {
      toast.info(t('toast.waitForAI') || '请等待 AI 回复完成后再发送');
      return;
    }

    // Build attachments array for API
    const attData = uploadedAtts.map(a => ({
      type: isImageFile(a.file) ? 'image' : 'file',
      url: a.uploaded!.url,
      name: a.uploaded!.name || a.file.name,
      mimeType: a.file.type || 'application/octet-stream',
      size: a.file.size,
    }));

    // Build message text - if only attachments, use a descriptive text
    const messageText = trimmed || (attData.length > 0
      ? attData.map(a => a.type === 'image' ? `[${t('input.imageAttachment')}: ${a.name}]` : `[${t('input.fileAttachment')}: ${a.name}]`).join(' ')
      : '');

    setInput('');
    setAttachments([]);
    // BUG-5 FIX: Clear cache for this chat after sending
    const currentChatId = useChatListStore.getState().currentChatId;
    if (currentChatId) inputCacheRef.current.delete(currentChatId);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await sendMessage(messageText, attData.length > 0 ? attData : undefined);
    } catch (err) {
      logger.error('Failed to send:', err);
      setInput(trimmed);
    }
  }, [input, attachments, isStreaming, sendMessage]);

  // v2.1: Use composition hook to handle IME input correctly
  // This wraps handleKeyDown to prevent Enter from triggering send during IME composing
  const baseHandleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const composition = useComposition<HTMLTextAreaElement>({
    onKeyDown: baseHandleKeyDown,
  });

  const handleSuggestionClick = async (suggestion: string) => {
    // BUG-4 FIX: Show toast when trying to use suggestion during streaming
    if (isStreaming) {
      toast.info(t('toast.waitForAI') || '请等待 AI 回复完成后再发送');
      return;
    }
    try {
      await sendMessage(suggestion);
    } catch (err) {
      logger.error('Failed to send suggestion:', err);
      setInput(suggestion);
      textareaRef.current?.focus();
    }
  };

  const hasUploadingFiles = attachments.some(a => a.progress >= 0 && a.progress < 100 && !a.uploaded);
  // wsDisconnectedDuringTask: WS断线但后端任务未完成，禁止发新消息（等polling确认结束）
  const canSend = (input.trim() || attachments.some(a => a.uploaded)) && !isStreaming && !isCancelling && !hasUploadingFiles && wsConnected && !wsDisconnectedDuringTask;

  // Quick commands
  const QUICK_COMMANDS = [
    { cmd: '/report', label: '生成日报', desc: '生成今日运营日报摘要' },
    { cmd: '/stock', label: '库存查询', desc: '查询当前库存状态和预警' },
    { cmd: '/ticket', label: '创建工单', desc: '快速创建客服工单' },
    { cmd: '/kol', label: 'KOL分析', desc: '分析KOL合作效果和建议' },
    { cmd: '/price', label: '价格查询', desc: '查询竞品价格和市场行情' },
    { cmd: '/help', label: '帮助', desc: '查看所有可用命令' },
  ];
  const showCommands = input.startsWith('/') && !input.includes(' ');
  const filteredCommands = showCommands
    ? QUICK_COMMANDS.filter(c => c.cmd.startsWith(input.toLowerCase()))
    : [];

  const applyCommand = (cmd: string) => {
    setInput(cmd + ' ');
    textareaRef.current?.focus();
  };

  return (
    <div
      ref={dropZoneRef}
      className={`border-t border-zinc-800 bg-zinc-900/80 backdrop-blur-sm pb-[calc(env(safe-area-inset-bottom)+var(--keyboard-offset,0px))]
                  transition-colors ${isDragging ? 'bg-blue-500/10 border-blue-500/30' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div className="px-3 sm:px-4 pt-3 pb-1">
          <div className="max-w-3xl mx-auto border-2 border-dashed border-blue-500/50 rounded-xl py-6 flex flex-col items-center gap-1">
            <p className="text-sm text-blue-400 font-medium">{t('input.dropFilesHere')}</p>
            <p className="text-xs text-zinc-500">{t('input.supportsImagesAndDocs')}</p>
          </div>
        </div>
      )}

      {/* Quick Commands Popup */}
      {filteredCommands.length > 0 && (
        <div className="px-3 sm:px-4 pt-2 pb-0">
          <div className="max-w-3xl mx-auto bg-zinc-800 border border-zinc-700 rounded-xl p-1.5 space-y-0.5">
            {filteredCommands.map(c => (
              <button
                key={c.cmd}
                onClick={() => applyCommand(c.cmd)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-700 transition-colors flex items-center gap-3"
              >
                <span className="text-xs font-mono text-blue-400 shrink-0">{c.cmd}</span>
                <span className="text-xs text-zinc-300">{c.label}</span>
                <span className="text-[10px] text-zinc-500 ml-auto">{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Suggestions — Enhanced card-style follow-ups */}
      {suggestions.length > 0 && !isStreaming && (
        <div className="px-3 sm:px-4 pt-2 sm:pt-3 pb-0 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex gap-2 sm:gap-2.5 max-w-3xl mx-auto overflow-x-auto scrollbar-hide pb-1">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => handleSuggestionClick(s)}
                className="group flex items-center gap-2 text-xs px-3.5 py-2 rounded-xl
                           border border-zinc-700/60 bg-zinc-800/30 text-zinc-400
                           hover:border-blue-500/40 hover:text-zinc-200 hover:bg-zinc-800/60
                           hover:shadow-sm hover:shadow-blue-500/5
                           active:scale-[0.98] transition-all duration-200 whitespace-nowrap shrink-0"
              >
                <span className="w-5 h-5 rounded-md bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:bg-blue-500/20 transition-colors">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                </span>
                <span className="max-w-[200px] truncate">{s}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="input-area-wrapper px-3 sm:px-4 py-2 sm:py-3">
        <div className="max-w-3xl mx-auto">
          <div className="bg-zinc-800 rounded-xl border border-zinc-700 focus-within:border-zinc-500 transition-colors">
            {/* Attachment previews */}
            {attachments.length > 0 && (
              <div className="px-2.5 sm:px-3 pt-2.5">
                <AttachmentPreview
                  attachments={attachments}
                  onRemove={removeAttachment}
                />
              </div>
            )}

            {/* Input row — two-row layout: textarea on top, toolbar on bottom */}
            {/* Input row — Responsive layout: 3 rows on mobile for maximum tap area */}
            <div className="flex flex-col px-2 sm:px-3 py-2 gap-1.5">
              {/* Row 1: Selectors (Top) */}
              <div className="selectors-row flex items-center gap-1 pb-1 border-b border-zinc-700/30 sm:border-none sm:pb-0 overflow-visible mobile-no-scrollbar">
                {/* @ts-ignore */}

                <RoleSelector
                  selectedRole={selectedRole}
                  onSelectRole={/* @ts-ignore */ setSelectedRole as any}
                  disabled={isStreaming || !wsConnected}
                />
                <ModelSelector
                  selectedModel={selectedModel}
                  onSelectModel={setSelectedModel}
                  disabled={isStreaming || !wsConnected}
                />
              </div>

              {/* Row 2: Text input (Full width) */}
              <div className="w-full">
                <textarea
                  data-message-input
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={composition.onKeyDown}
                  onCompositionStart={composition.onCompositionStart}
                  onCompositionEnd={composition.onCompositionEnd}
                  onPaste={handlePaste}
                  placeholder={
                    wsDisconnectedDuringTask
                      ? (isMobile ? '连接中断...' : '连接中断，正在确认上一条回复是否完成...')
                      : !wsConnected
                      ? t('input.connecting')
                      : isStreaming
                      ? t('input.aiReplying')
                      : isMobile
                      ? t('input.placeholderMobile')
                      : t('input.placeholder')
                  }
                  aria-label={t('input.ariaLabel')}
                  disabled={!wsConnected || wsDisconnectedDuringTask}
                  rows={1}
                  className="w-full bg-transparent text-sm text-zinc-200 placeholder-zinc-500
                             resize-none outline-none min-h-[36px] sm:min-h-[40px] max-h-[120px] sm:max-h-[160px] py-1 sm:py-1.5
                             disabled:opacity-50"
                />
              </div>

              {/* Character count (shown > 2000 chars, warns > 4000) */}
              {input.length > 2000 && (
                <div className={`text-[10px] text-right pr-1 transition-colors mt-0.5 ${
                  input.length > 4000 ? 'text-red-400' : 'text-zinc-500'
                }`}>
                  {input.length.toLocaleString()} {input.length > 4000 ? '/ 建议 4000 字以内' : '字'}
                </div>
              )}

              {/* Row 3: Actions (Bottom) */}
              <div className="flex items-center justify-between sm:justify-start sm:gap-4 pt-1 sm:pt-0">
                <div className="flex items-center gap-1">
                  <FileUploadButton
                    onFilesSelected={processFiles}
                    disabled={isStreaming || !wsConnected}
                    mode="all"
                  />
                </div>

                {isStreaming ? (
                  <button
                    onClick={cancelTask}
                    disabled={isCancelling}
                    className="shrink-0 p-2 rounded-lg transition-colors
                               bg-red-600 hover:bg-red-500 active:bg-red-700 text-white
                               disabled:opacity-60 disabled:cursor-not-allowed"
                    title={isCancelling ? (t('input.stopping') || '停止中...') : (t('input.stopGeneration') || '停止生成')}
                  >
                    {isCancelling
                      ? <Loader2 size={14} className="animate-spin" />
                      : <Square size={14} fill="currentColor" />
                    }
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                  <button
                    onClick={() => setVoiceOpen(true)}
                    className="shrink-0 p-2.5 sm:p-1.5 rounded-lg transition-all
                               bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white"
                    title="语音通话"
                  >
                    <Mic size={14} />
                  </button>
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    aria-label={isStreaming ? (t('input.stopGeneration') || '停止生成') : (t('input.send') || '发送')}
                    className="shrink-0 px-4 py-2.5 sm:py-1.5 rounded-lg transition-all
                               disabled:opacity-30 disabled:grayscale
                               enabled:bg-blue-600 enabled:hover:bg-blue-500 enabled:active:scale-95 enabled:text-white
                               flex items-center gap-2 text-xs sm:text-xs font-medium"
                  >
                    {hasUploadingFiles ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <>
                        {t('input.send') || '发送'}
                        <Send size={14} />
                      </>
                    )}
                  </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <VoiceChat open={voiceOpen} onClose={() => setVoiceOpen(false)} />
          <p className="hidden sm:block text-[10px] sm:text-xs text-zinc-600 mt-1 sm:mt-1.5 text-center">
            {t('input.footer')}
          </p>
        </div>
      </div>
    </div>
  );
}
