/**
 * useMessageStore — Message & streaming state (Zustand)
 * 
 * v11.0: Per-Chat State Isolation
 * - chatStreams Map<chatId, ChatStreamState> isolates each chat's streaming state
 * - Global fields (isStreaming, streamingContent, etc.) reflect the ACTIVE chat only
 * - Background chats accumulate state in chatStreams without affecting the UI
 * - selectChat restores from chatStreams and merges pendingMessages
 */
import { create } from 'zustand';
import { logger } from "../lib/logger";
import type { Message, ToolCall, ExecutionStep, RoutingInfo, StepStatus } from '../lib/types';
import * as api from '../lib/api';

// ─── Per-Chat Stream State ─────────────────────────────────

// [R67] Plan progress state from planner
export interface PlanProgressStep {
  id: string;
  title: string;
  status: 'pending' | 'doing' | 'done' | 'failed' | 'blocked' | 'skipped' | 'retrying' | 'active';
}
export interface PlanProgress {
  planId: string;
  goal: string;
  currentStep: number;
  totalSteps: number;
  steps: PlanProgressStep[];
  status: 'in_progress' | 'completed' | 'failed';
}

export interface ChatStreamState {
  isStreaming: boolean;
  streamingContent: string;
  thinkingContent: string;
  progressContent: string;
  activeTools: ToolCall[];
  executionSteps: ExecutionStep[];
  planProgress: PlanProgress | null;
  suggestions: string[];
  currentRoutingInfo: RoutingInfo | null;
  activeMsgId: string | null;
  error: string | null;
  pendingMessages: Message[];
  streamingStartedAt: number | null;
}

const emptyChatStream = (): ChatStreamState => ({
  isStreaming: false,
  streamingContent: '',
  thinkingContent: '',
  progressContent: '',
  activeTools: [],
  executionSteps: [],
  planProgress: null,
  suggestions: [],
  streamingStartedAt: null,
  currentRoutingInfo: null,
  activeMsgId: null,
  error: null,
  pendingMessages: [],
});

// [R67] Task phase for plan/task stage display
export type TaskPhase = 'idle' | 'planning' | 'executing' | 'verifying' | 'completed';

export const TASK_PHASE_LABELS: Record<TaskPhase, string> = {
  idle: '',
  planning: '规划中',
  executing: '执行中',
  verifying: '验证中',
  completed: '完成',
};

interface MessageState {
  pendingInput: string;
  setPendingInput: (v: string) => void;
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  thinkingContent: string;
  progressContent: string;
  activeTools: ToolCall[];
  executionSteps: ExecutionStep[];
  planProgress: PlanProgress | null;
  isLoadingMessages: boolean;
  error: string | null;
  suggestions: string[];
  currentRoutingInfo: RoutingInfo | null;
  messageRoutingMap: Record<number, RoutingInfo>;
  selectedModel: string;
  selectedRole: string;
  _lastStreamEndAt: number;
  chatStreams: Record<string, ChatStreamState>;
  isCancelling: boolean;
  streamingStartedAt: number | null;
  taskPhase: TaskPhase;
}

interface MessageActions {
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setStreaming: (isStreaming: boolean, preserveContent?: boolean) => void;
  appendStream: (content: string) => void;
  appendThinking: (content: string) => void;
  setProgress: (content: string) => void;
  addToolCall: (tool: ToolCall) => void;
  updateToolCall: (id: string, updates: Partial<ToolCall>) => void;
  addStep: (step: ExecutionStep) => void;
  updateStep: (id: string, status: StepStatus, detail?: string) => void;
  clearSteps: () => void;
  setPlanProgress: (progress: PlanProgress | null) => void;
  streamEnd: (content: string, model?: string, responseMode?: string) => void; // Iter-U
  clearStreaming: () => void;
  setLoadingMessages: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSuggestions: (suggestions: string[]) => void;
  setRoutingInfo: (info: RoutingInfo) => void;
  saveMessageRouting: (messageId: number, info: RoutingInfo) => void;
  setSelectedModel: (model: string) => void;
  setSelectedRole: (roleId: string) => void;
  setTaskPhase: (phase: TaskPhase) => void;

  // ─── Timeline & Cancel Actions ──────────────────────────────
  snapshotTextToTimeline: () => void;
  addTimelineItem: (item: { type: string; toolId?: string; timestamp: number }) => void;
  refreshMessages: (chatId: string) => Promise<void>;
  setCancelling: (cancelling: boolean) => void;

  // ─── Per-Chat Stream Actions ──────────────────────────────
  getChatStream: (chatId: string) => ChatStreamState;
  updateChatStream: (chatId: string, updates: Partial<ChatStreamState>) => void;

  // Async actions
  selectChat: (chatId: string) => Promise<void>;
  sendMessage: (
    content: string,
    attachments?: Array<{ type: string; url: string; name: string; mimeType: string; size: number }>,
    targetChatId?: string,
    bindChatFn?: (chatId: string) => void,
    createNewChatFn?: (title?: string) => Promise<{ id: string }>,
    tFn?: (key: string) => string,
    activeMsgIdRef?: React.MutableRefObject<string | null>,
  ) => Promise<void>;
}

export type MessageStore = MessageState & MessageActions;

export const useMessageStore = create<MessageStore>((set, get) => ({
  pendingInput: '' as string,
  setPendingInput: (v: string) => set({ pendingInput: v }),
  // ─── State ───────────────────────────────────────────────
  messages: [],
  isStreaming: false,
  streamingContent: '',
  thinkingContent: '',
  progressContent: '',
  activeTools: [],
  executionSteps: [],
  planProgress: null,
  isLoadingMessages: false,
  error: null,
  suggestions: [],
  currentRoutingInfo: null,
  messageRoutingMap: {},
  selectedModel:
    (typeof window !== 'undefined' && localStorage.getItem('rangerai_selectedModel')) || 'auto',
  selectedRole:
    (typeof window !== 'undefined' && localStorage.getItem('rangerai_selectedRole')) || 'default',
  _lastStreamEndAt: 0,
  chatStreams: {},
  isCancelling: false,
  streamingStartedAt: null,
  taskPhase: 'idle' as TaskPhase,

  // ─── Sync Actions ────────────────────────────────────────
  setMessages: (messages) => set({ messages, isLoadingMessages: false }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),

  setStreaming: (isStreaming, preserveContent) =>
    set((s) => ({
      isStreaming,
      streamingStartedAt: isStreaming ? Date.now() : s.streamingStartedAt,
      ...(isStreaming && !preserveContent ? { streamingContent: '', thinkingContent: '', activeTools: [], executionSteps: [] } : {}),
    })),

  appendStream: (content) =>
    set((s) => ({ streamingContent: s.streamingContent + content })),

  appendThinking: (content) =>
    set((s) => {
      // [R71] Comprehensive filter: strip all internal directives from thinking content
      if (typeof content !== 'string') return { thinkingContent: s.thinkingContent + content };
      let clean = content
        // Progress blocks
        .replace(/\n*\[当前进度\][\s\S]*?\[\/当前进度\]\n*/g, '')
        .replace(/\n*\[CURRENT_PROGRESS\][\s\S]*?\[\/CURRENT_PROGRESS\]\n*/g, '')
        .replace(/\n*<todo_progress>[\s\S]*?<\/todo_progress>\n*/g, '')
        // Step directives
        .replace(/\[NEXT_STEP\][^\n]*/g, '')
        .replace(/\[TASK_BRIEF\][\s\S]*?\[\/TASK_BRIEF\]/g, '')
        .replace(/\[ACCEPTANCE_CRITERIA\][\s\S]*?\[\/ACCEPTANCE_CRITERIA\]/g, '')
        .replace(/\[GPT_WILL_REVIEW\][^\n]*/g, '')
        .replace(/\[BROWSER_PREFERRED\][^\n]*/g, '')
        .replace(/\[BROWSER_FALLBACK\][^\n]*/g, '')
        // Review directives
        .replace(/\[R70-REVIEW\][^\n]*/g, '')
        .replace(/\[RETRY_STEP\][^\n]*/g, '')
        .replace(/\[PLAN_COMPLETE\][^\n]*/g, '')
        .replace(/\[PLAN_CONTRACT_WARN\][^\n]*/g, '')
        // Clean up excessive newlines left by removals
        .replace(/\n{3,}/g, '\n\n');
      return { thinkingContent: s.thinkingContent + clean };
    }),
  setProgress: (content: string) =>
    set(() => ({ progressContent: content })),

  addToolCall: (tool) =>
    set((s) => ({ activeTools: [...s.activeTools, tool] })),

  updateToolCall: (id, updates) =>
    set((s) => ({
      activeTools: s.activeTools.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  addStep: (step) =>
    set((s) => ({ executionSteps: [...s.executionSteps, step] })),

  updateStep: (id, status, detail) =>
    set((s) => ({
      executionSteps: s.executionSteps.map((st) =>
        st.id === id
          ? {
              ...st,
              status,
              detail: detail !== undefined ? detail : st.detail,
              ...(status !== 'running' ? { completedAt: Date.now() } : {}),
            }
          : st
      ),
    })),

  clearSteps: () => set({ executionSteps: [] }),
  setPlanProgress: (progress) => set({ planProgress: progress }),

  streamEnd: (content, model, responseMode) => {
    const s = get();
    const lastMsg = s.messages[s.messages.length - 1];
    const contentToAdd = content;

    // Dedup: if the last message is already an assistant message with same content, skip
    if (lastMsg && lastMsg.role === 'assistant') {
      const lastContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';
      if (
        lastContent === contentToAdd ||
        (contentToAdd.length > 50 &&
          lastContent.length > 50 &&
          (lastContent.includes(contentToAdd.slice(0, Math.min(200, contentToAdd.length))) ||
            contentToAdd.includes(lastContent.slice(0, Math.min(200, lastContent.length)))))
      ) {
        let dedupMetadata: string | null = null;
        if (s.activeTools.length > 0 || s.executionSteps.length > 0) {
          try {
            dedupMetadata = JSON.stringify({
              toolCalls: s.activeTools.map((t) => ({
                id: t.id, tool: t.tool, args: t.args, result: t.result,
                status: t.status, success: t.success, toolIndex: t.toolIndex,
              })),
              executionSteps: s.executionSteps.map((st) => ({
                id: st.id, title: st.title, status: st.status, detail: st.detail,
                stepIndex: st.stepIndex, startedAt: st.startedAt, completedAt: st.completedAt,
              })),
            });
          } catch { /* ignore */ }
        }
        const updatedMessages =
          dedupMetadata || model
            ? s.messages.map((m, i) =>
                i === s.messages.length - 1
                  ? { ...m, metadata: dedupMetadata || m.metadata, model: model || m.model }
                  : m
              )
            : s.messages;
        set({
          messages: updatedMessages,
          isStreaming: false,
          streamingContent: '',
          thinkingContent: '',
          activeTools: [],
          executionSteps: [],
          planProgress: null,
          _lastStreamEndAt: Date.now(),
        });
        return;
      }
    }

    // Build metadata from tool calls and execution steps
    let metadata: string | null = null;
    if (s.activeTools.length > 0 || s.executionSteps.length > 0) {
      try {
        metadata = JSON.stringify({
          toolCalls: s.activeTools.map((t) => ({
            id: t.id, tool: t.tool, args: t.args, result: t.result,
            status: t.status, success: t.success, toolIndex: t.toolIndex,
          })),
          executionSteps: s.executionSteps.map((st) => ({
            id: st.id, title: st.title, status: st.status, detail: st.detail,
            stepIndex: st.stepIndex, startedAt: st.startedAt, completedAt: st.completedAt,
          })),
        });
      } catch { /* ignore */ }
    }

    // Iter-U: merge responseMode into metadata
    if (responseMode && responseMode !== 'default') {
      try {
        const base = metadata ? JSON.parse(metadata) : {};
        metadata = JSON.stringify({ ...base, responseMode });
      } catch { /* ignore */ }
    }

    const assistantMsg: Message = {
      id: Date.now(),
      chatId: '',
      role: 'assistant',
      content: contentToAdd,
      model: model || null,
      tokens: null,
      msgId: null,
      createdAt: new Date().toISOString(),
      metadata,
    };

    set({
      messages: [...s.messages, assistantMsg],
      isStreaming: false,
      streamingContent: '',
      thinkingContent: '',
      progressContent: '',
      activeTools: [],
      executionSteps: [],
      planProgress: null,
      _lastStreamEndAt: Date.now(),
      streamingStartedAt: null,
    });
  },

  clearStreaming: () =>
    set({
      isStreaming: false,
      streamingContent: '',
      thinkingContent: '',
      progressContent: '',
      activeTools: [],
      executionSteps: [],
      planProgress: null,
      streamingStartedAt: null,
    }),

  setLoadingMessages: (loading) => set({ isLoadingMessages: loading }),
  setError: (error) => set({ error }),
  setSuggestions: (suggestions) => set({ suggestions }),
  setRoutingInfo: (info) => set({ currentRoutingInfo: info }),
  saveMessageRouting: (messageId, info) =>
    set((s) => ({
      messageRoutingMap: { ...s.messageRoutingMap, [messageId]: info },
    })),

  setSelectedModel: (model) => {
    set({ selectedModel: model });
    localStorage.setItem('rangerai_selectedModel', model);
  },

  setSelectedRole: (roleId) => {
    set({ selectedRole: roleId });
    localStorage.setItem('rangerai_selectedRole', roleId);
  },

  setTaskPhase: (phase) => set({ taskPhase: phase }),

  // ─── Timeline & Cancel Actions ──────────────────────────────
  snapshotTextToTimeline: () => {
    // No-op: timeline snapshots are handled by the ExecutionTimeline component
    // which reads streamingContent directly from the store
  },
  addTimelineItem: (_item) => {
    // No-op: timeline items are derived from activeTools/executionSteps
  },
  refreshMessages: async (chatId) => {
    try {
      // Silent incremental refresh: fetch new messages WITHOUT clearing existing ones
      // This prevents UI flicker on WS reconnect (unlike selectChat which sets messages: [])
      const detail = await api.withRetry(() => api.fetchChatDetail(chatId), {
        maxRetries: 2,
        baseDelay: 1000,
        onRetry: (attempt) => logger.debug(`[MessageStore] refreshMessages retry ${attempt}/2`),
      });
      const currentMessages = get().messages;
      const currentChatId = currentMessages.length > 0 ? currentMessages[0]?.chatId : null;
      
      // Only update if we're still on the same chat
      if (currentChatId && currentChatId !== chatId) {
        logger.debug('[MessageStore] refreshMessages: chat changed during fetch, skipping');
        return;
      }
      
      // Merge: keep existing messages, add any new ones from server
      const existingIds = new Set(currentMessages.map(m => m.id));
      const newMessages = detail.messages.filter(m => !existingIds.has(m.id));
      
      if (newMessages.length > 0) {
        logger.debug(`[MessageStore] refreshMessages: ${newMessages.length} new messages merged`);
        set({ messages: [...currentMessages, ...newMessages] });
      } else if (detail.messages.length !== currentMessages.length) {
        // Server has different count — do a full replace (but no intermediate empty state)
        logger.debug('[MessageStore] refreshMessages: message count mismatch, full replace');
        set({ messages: detail.messages });
      }
      // else: no changes, no state update = no re-render
    } catch (err) {
      logger.warn('[MessageStore] refreshMessages failed:', err);
    }
  },
  setCancelling: (cancelling) => set({ isCancelling: cancelling }),

  // ─── Per-Chat Stream Actions ──────────────────────────────
  getChatStream: (chatId) => get().chatStreams[chatId] || emptyChatStream(),

  updateChatStream: (chatId, updates) =>
    set((s) => ({
      chatStreams: {
        ...s.chatStreams,
        [chatId]: { ...(s.chatStreams[chatId] || emptyChatStream()), ...updates },
      },
    })),

  // ─── Async Actions ───────────────────────────────────────
  selectChat: async (chatId: string) => {
    // Restore from chatStreams if this chat has active state
    const cs = get().chatStreams[chatId] || emptyChatStream();
    set({
      messages: [],
      streamingContent: cs.streamingContent,
      thinkingContent: cs.thinkingContent,
      progressContent: cs.progressContent || '',
      activeTools: cs.activeTools,
      executionSteps: cs.executionSteps,
      isStreaming: cs.isStreaming,
      suggestions: cs.suggestions,
      currentRoutingInfo: cs.currentRoutingInfo,
      error: cs.error,
      isLoadingMessages: true,
    });
    try {
      const detail = await api.withRetry(() => api.fetchChatDetail(chatId), {
        maxRetries: 2,
        baseDelay: 1000,
        onRetry: (attempt) => logger.debug(`[MessageStore] selectChat retry ${attempt}/2`),
      });
      // Merge pending messages from background execution
      const pending = cs.pendingMessages || [];
      const allMessages = pending.length > 0 ? [...detail.messages, ...pending] : detail.messages;
      set({ messages: allMessages, isLoadingMessages: false });
      // Clear pending after merge
      if (pending.length > 0) {
        get().updateChatStream(chatId, { pendingMessages: [] });
      }
    } catch (err) {
      logger.error('[MessageStore] Failed to load messages after retries:', err);
      set({ error: 'Failed to load messages', isLoadingMessages: false });
    }
  },

  sendMessage: async (content, attachments, targetChatId, bindChatFn, createNewChatFn, tFn, activeMsgIdRef) => {
    const s = get();
    const t = tFn || ((k: string) => k);
    let chatId = targetChatId;

    if (!chatId && createNewChatFn) {
      const chat = await createNewChatFn();
      chatId = chat.id;
    }
    if (!chatId) return;

    // Build display content
    const displayContent =
      attachments && attachments.length > 0
        ? JSON.stringify({ text: content, attachments })
        : content;

    const tempMsg: Message = {
      id: Date.now(),
      chatId,
      role: 'user',
      content: displayContent,
      model: null,
      tokens: null,
      msgId: null,
      createdAt: new Date().toISOString(),
      metadata: null,
    };

    set((prev) => ({
      messages: [...prev.messages, tempMsg],
      isStreaming: false,
      streamingContent: '',
      thinkingContent: '',
      progressContent: '',
      activeTools: [],
      executionSteps: [],
      planProgress: null,
      suggestions: [],
    }));
    // Then set streaming
    set({ isStreaming: true });

    const selectedModel = s.selectedModel;
    const selectedRole = s.selectedRole;

    try {
      if (bindChatFn) bindChatFn(chatId);
      const sendResult = await api.sendMessage(chatId, content, undefined, selectedModel, attachments, selectedRole);
      if (activeMsgIdRef) activeMsgIdRef.current = sendResult.msgId;
    } catch (err: unknown) {
      logger.error('[MessageStore] Failed to send message:', err);

      let errorMsg = t('store.err.sendFailed');
      if (err instanceof api.ApiError) {
        if (err.status === 409) {
          errorMsg = t('store.err.retrying409');
          set({ error: errorMsg });
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const retryResult = await api.sendMessage(chatId!, content, undefined, selectedModel, attachments, selectedRole);
            if (activeMsgIdRef) activeMsgIdRef.current = retryResult.msgId;
            set({ error: null });
            return;
          } catch {
            errorMsg = t('store.err.chatBusy');
          }
        } else if (err.status === 429) {
          errorMsg = t('store.err.tooFrequent');
        } else if (err.status === 401) {
          errorMsg = t('store.err.loginExpired');
        } else if (err.status === 404) {
          errorMsg = t('store.err.chatNotFound');
        } else {
          errorMsg = err.message || t('store.err.serverError');
        }
      } else if (err instanceof Error) {
        if (err.name === 'AbortError' || err.message.includes('abort')) {
          errorMsg = t('store.err.requestTimeout');
        } else if (
          err.message.includes('fetch') ||
          err.message.includes('network') ||
          err.message.includes('Failed to fetch')
        ) {
          errorMsg = t('store.err.networkFailed');
        }
      }

      set({
        error: errorMsg,
        isStreaming: false,
        streamingContent: '',
        thinkingContent: '',
        activeTools: [],
        executionSteps: [],
        planProgress: null,
      });

      setTimeout(() => {
        set({ error: null });
      }, 8000);
    }
  },
}));
