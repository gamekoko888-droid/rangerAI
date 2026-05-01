/**
 * useChatStore — ChatProvider + Orchestrator (Phase 6b: Direct Store Migration)
 *
 * This file now only contains:
 *   1. ChatProvider — WebSocket event routing & cross-store coordination
 *   2. useOrchestrator — Context hook for WS bindChat/send
 *
 * The legacy useChatStore() compat shim has been REMOVED.
 * Components now import stores directly:
 *   - useAuthStore, useChatListStore, useMessageStore, useConnectionStore, useWorkspaceStore
 * For cross-store actions: import { useChatActions } from '../hooks/useChatActions'
 */

import React, { useCallback, useEffect, useRef, createContext, useContext } from 'react';

// Browser tool dedup: global map for merged tool IDs
declare global {
  interface Window {
    __browserToolIdMap?: Map<string, string>;
  }
}
import { useI18n } from '../lib/i18n';
import type { WsEvent, StepStatus } from '../lib/types';
import { normalizeContent } from '../lib/types';
import * as api from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useStreamBuffer } from '../hooks/useStreamBuffer';

// ─── Import atomic stores ──────────────────────────────────
import { useAuthStore } from '../stores/useAuthStore';
import { useChatListStore } from '../stores/useChatListStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useConnectionStore } from '../stores/useConnectionStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { getStreamFilter } from './streamFilter';
import { useStreamWatchdog } from './useStreamWatchdog';
import { useHttpPolling } from './useHttpPolling';
import { useRegenerateListener } from './useRegenerateListener';
import { useGatewayHealth } from './useGatewayHealth';
import { wsEventReducer, type StateSnapshot } from './wsEventReducer';

// ─── Context (for WebSocket orchestration only) ────────────
interface ChatOrchestratorValue {
  wsConnected: boolean;
  bindChat: (chatId: string) => void;
  wsSend: (data: Record<string, unknown>) => void;
  setActiveMsgId: (msgId: string | null) => void;
  cancelTask: () => void;
  wsForceReconnect: () => void;
}

const ChatOrchestratorContext = createContext<ChatOrchestratorValue | null>(null);

// ─── ChatProvider — WebSocket orchestration layer ──────────
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  // ─── Refs for cross-store coordination ───────────────────
  const activeMsgIdRef = useRef<string | null>(null);
  // FIX-REFRESH: Restore activeMsgId from localStorage on mount (survives page refresh)
  const persistedMsgId = typeof window !== 'undefined' ? localStorage.getItem('rangerai_activeMsgId') : null;
  const persistedChatId = typeof window !== 'undefined' ? localStorage.getItem('rangerai_activeChatId') : null;
  if (persistedMsgId && !activeMsgIdRef.current) {
    activeMsgIdRef.current = persistedMsgId;
    console.log('[ChatStore] Restored activeMsgId from localStorage:', persistedMsgId);
  }
  // Helper to sync activeMsgIdRef with localStorage
  const setActiveMsgIdPersisted = useCallback((msgId: string | null, chatId?: string | null) => {
    activeMsgIdRef.current = msgId;
    if (msgId) {
      localStorage.setItem('rangerai_activeMsgId', msgId);
      if (chatId) localStorage.setItem('rangerai_activeChatId', chatId);
    } else {
      localStorage.removeItem('rangerai_activeMsgId');
      localStorage.removeItem('rangerai_activeChatId');
    }
  }, []);
  // Persist selected model/role in localStorage for recovery across sessions
  if (typeof window !== 'undefined') {
    const storedModel = localStorage.getItem('rangerai_selectedModel');
    const storedRole = localStorage.getItem('rangerai_selectedRole');
    if (storedModel) {
      useMessageStore.getState().setSelectedModel(storedModel);
      localStorage.setItem('rangerai_selectedModel', storedModel);
    }
    if (storedRole) {
      useMessageStore.getState().setSelectedRole(storedRole);
      localStorage.setItem('rangerai_selectedRole', storedRole);
    }
  }
  const wsConnectedRef = useRef(false);
  const wsEverConnectedRef = useRef(false); // Track if WS has connected at least once (for reconnect detection)
  const pendingRecoveryRef = useRef<{ msgId: string; chatId: string } | null>(null); // R52: Deferred recover_task until chat_bound
  const offlineQueueRef = useRef<Array<Record<string, unknown>>>([]); // Iter-AG: WS offline queue
  const reconnectRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // WS reconnect debounce timer

  // ─── Streaming Watchdog (v6.5 → R93: extracted to useStreamWatchdog) ──
  const { reset: resetStreamWatchdog, clear: clearStreamWatchdog } = useStreamWatchdog(activeMsgIdRef);

  // ─── v25.0: Word-level Stream Buffer ─────────────────────
  const streamBuffer = useStreamBuffer(
    useCallback((batch: string) => {
      useMessageStore.getState().appendStream(batch);
    }, [])
  );

  // ─── Helper: Build StateSnapshot from current store state ──
  const buildSnapshot = useCallback((): StateSnapshot => {
    const s = useMessageStore.getState();
    return {
      isStreaming: s.isStreaming,
      streamingContent: s.streamingContent,
      thinkingContent: s.thinkingContent,
      activeTools: s.activeTools,
      messages: s.messages.map(m => ({ id: m.id, role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      _lastStreamEndAt: s._lastStreamEndAt,
      planProgress: s.planProgress as any,
      taskPhase: s.taskPhase,
    };
  }, []);

  // ─── Helper: Apply reducer mutations to the store ────────
  const applyReducerMutations = useCallback((mutations: ReturnType<typeof wsEventReducer>) => {
    const store = useMessageStore.getState();
    for (const m of mutations) {
      switch (m.type) {
        case 'setStreaming':
          store.setStreaming(m.isStreaming, m.preserveContent);
          break;
        case 'clearStreaming':
          store.clearStreaming();
          break;
        case 'addToolCall':
          store.addToolCall(m.tool);
          break;
        case 'updateToolCall':
          store.updateToolCall(m.id, m.updates);
          break;
        case 'streamEnd':
          store.streamEnd(m.content, m.model, m.responseMode);
          break;
        case 'setError':
          store.setError(m.error);
          break;
        case 'setSuggestions':
          store.setSuggestions(m.suggestions);
          break;
        case 'setPlanProgress':
          store.setPlanProgress(m.progress as any);
          break;
        case 'snapshotTextToTimeline':
          store.snapshotTextToTimeline();
          break;
        case 'appendTimelineItem':
          store.addTimelineItem(m.item);
          break;
        case 'appendThinking':
          store.appendThinking(m.content);
          break;
        case 'setLongRunningNotice':
          useConnectionStore.getState().setLongRunningNotice(m.notice);
          break;
        case 'setTaskPhase':
          store.setTaskPhase(m.phase as any);
          break;
        case 'none':
          break;
      }
    }
  }, []);

  // ─── WebSocket Event Handler ─────────────────────────────
  const handleWsEvent = useCallback((event: WsEvent) => {
    // R73: Persist lastEventTs for accurate recover_task replay
    const _evType = (event as any).type as string;
    if (_evType && _evType !== 'pong' && _evType !== 'server_ping') {
      try { localStorage.setItem('rangerai_lastEventTs', String(Date.now())); } catch {}
    }
    const msgStore = useMessageStore.getState();

    // ── Route guard: ignore events belonging to a different chat ──
    const eventChatId = (event as any)?._chatId;
    if (eventChatId) {
      const currentChatId = useChatListStore.getState().currentChatId;
      if (currentChatId && eventChatId !== currentChatId) {
        // Event belongs to a different chat — silently discard
        return;
      }
    }

    // Filter heartbeat messages
    if (event.type === 'stream_chunk' || event.type === 'stream_end' || event.type === 'thinking' || event.type === 'status') {
      const content = (event as any).content || (event as any).status;
      if (typeof content === 'string' && (
        content.includes('HEARTBEAT_OK') ||
        content.includes('[HEARTBEAT]') ||
        content === 'HEARTBEAT_OK'
      )) {
        return;
      }
    }

    switch (event.type) {
      case 'connected': {
        const e = event as { gatewayConnected?: boolean; skills?: any[]; tools?: string[]; capabilities?: string[] };
        useConnectionStore.getState().setGatewayConnected(e.gatewayConnected ?? false);
        if (e.skills || e.tools || e.capabilities) {
          useWorkspaceStore.getState().setAiCapabilities(e.skills || [], e.tools || [], e.capabilities || []);
        }
        if (e.gatewayConnected) {
          useMessageStore.getState().setError(null);
        }
        break;
      }

      case 'chat_bound': {
        // R52 FIX: Process deferred recover_task now that bind_chat DB query is complete
        const pendingRecovery = pendingRecoveryRef.current;
        if (pendingRecovery) {
          pendingRecoveryRef.current = null;
          console.log('[ChatStore] chat_bound received, now sending deferred recover_task for msgId:', pendingRecovery.msgId);
          wsSend({
            type: 'recover_task',
            msgId: pendingRecovery.msgId,
            chatId: pendingRecovery.chatId,
            lastEventTs: parseInt(localStorage.getItem('rangerai_lastEventTs') || '0', 10),
          });
          console.log('[ChatStore] R73: recover_task sent with lastEventTs');
          resetStreamWatchdog();
        }
        break;
      }

      case 'stream_start': {
        // Pre-checks: duplicate detection and content preservation (domain logic stays in handler)
        const snap = buildSnapshot();
        const timeSinceLastEnd = Date.now() - (snap._lastStreamEndAt || 0);
        if (timeSinceLastEnd < 2000 && !snap.isStreaming) {
          console.log('[ChatStore] Ignoring duplicate stream_start (late_result), gap:', timeSinceLastEnd, 'ms');
          break;
        }
        // R58-FIX/R63-FIX: Guard when streamingContent is non-empty (reconnect / timeout recovery)
        if (snap.streamingContent) {
          console.log('[ChatStore] stream_start received with existing content (%d chars), skipping reset to preserve content', snap.streamingContent.length);
          getStreamFilter().reset();
          resetStreamWatchdog();
          break;
        }
        // R93: Use reducer for core state mutations
        const mutations = wsEventReducer({ snapshot: snap, event });
        applyReducerMutations(mutations);
        // Side effects: filter, buffer, watchdog
        getStreamFilter().reset();
        streamBuffer.reset();
        resetStreamWatchdog();
        break;
      }

      case 'stream_chunk': {
        const e = event as { content?: unknown };
        if (e.content) {
          const raw = normalizeContent(e.content);
          const filtered = getStreamFilter().filter(raw);
          if (filtered) {
            // v25.0: Push to buffer instead of immediate setState
            streamBuffer.push(filtered);
          }
        }
        resetStreamWatchdog(); // v6.3: Reset watchdog on activity
        break;
      }

      case 'internal': {
        // [R71] Internal directives from backend — not shown to user, just reset watchdog
        resetStreamWatchdog();
        break;
      }
      case 'thinking': {
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        resetStreamWatchdog(); // v6.3: Reset watchdog on thinking activity
        break;
      }
      case 'progress_update': {
        const e = event as { content?: string };
        if (e.content) {
          useMessageStore.getState().setProgress(e.content);
        }
        break;
      }

      case 'step': {
        const e = event as { id?: string; title?: string; status?: string; detail?: string; stepIndex?: number };
        if (e.id && e.title) {
          if (!msgStore.isStreaming) {
            // R73v2: preserveContent=true — step events during replay shouldn't wipe content
            useMessageStore.getState().setStreaming(true, true);
          }
          resetStreamWatchdog(); // v6.3: Reset watchdog on step activity
          useMessageStore.getState().addStep({
            id: e.id,
            title: e.title,
            status: (e.status as StepStatus) || 'running',
            detail: e.detail || '',
            stepIndex: e.stepIndex || 0,
            startedAt: Date.now(),
          });
        }
        break;
      }

      case 'step_update': {
        const e = event as { id?: string; status?: string; detail?: string };
        resetStreamWatchdog(); // v10.1: Reset watchdog on step updates
        if (e.id && e.status) {
          useMessageStore.getState().updateStep(e.id, e.status as StepStatus, e.detail);
        }
        break;
      }

      case 'tool_start': {
        const e = event as { id?: string; tool?: string; args?: unknown; toolIndex?: number; skill?: string; skillLabel?: string; skillCategory?: string; title?: string; description?: string };
        if (!e.tool) break;

        // ─── Browser tool dedup: merge consecutive browser sub-actions (preprocessing, stays in handler) ───
        if (e.tool === 'browser') {
          const currentStore = useMessageStore.getState();
          const lastBrowserTool = [...currentStore.activeTools].reverse().find(t => t.tool === 'browser');
          const argsStr = typeof e.args === 'string' ? e.args : (e.args ? JSON.stringify(e.args) : '');
          let parsedArgs: any = {};
          try { parsedArgs = argsStr ? JSON.parse(argsStr) : {}; } catch {}
          const action = parsedArgs.action || '';
          const isSubAction = ['evaluate', 'act', 'snapshot'].includes(action);

          if (lastBrowserTool && isSubAction && lastBrowserTool.completedAt &&
              (Date.now() - lastBrowserTool.completedAt) < 5000) {
            const newToolId = e.id || `tool-${Date.now()}`;
            if (!window.__browserToolIdMap) window.__browserToolIdMap = new Map();
            window.__browserToolIdMap.set(newToolId, lastBrowserTool.id);
            currentStore.updateToolCall(lastBrowserTool.id, {
              status: 'running',
              args: argsStr,
              completedAt: undefined as any,
              result: undefined as any,
            });
            break; // Skip creating a new tool entry
          }
        }

        // R93: Use reducer for core state mutations
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        resetStreamWatchdog(); // v10.1: Backend is still active (tool running)
        break;
      }

      case 'tool_progress': {
        const e = event as { id?: string; tool?: string; data?: { partialResult?: string } };
        resetStreamWatchdog(); // v10.1: Reset watchdog on tool progress
        // Browser dedup: route merged tool IDs (preprocessing, stays in handler)
        if (e.id && window.__browserToolIdMap?.has(e.id)) {
          e.id = window.__browserToolIdMap.get(e.id)!;
        }
        if (e.id) {
          // R93: Use reducer for core state mutations
          const mutations = wsEventReducer({ snapshot: buildSnapshot(), event: { ...event, id: e.id } });
          applyReducerMutations(mutations);
        }
        break;
      }

      case 'tool_end': {
        const e = event as { id?: string; tool?: string; success?: boolean; result?: unknown; screenshot?: string };
        resetStreamWatchdog(); // v10.1: Reset watchdog on tool end
        // Browser dedup: route merged tool IDs to the parent tool (preprocessing, stays in handler)
        if (e.id && window.__browserToolIdMap?.has(e.id)) {
          const mappedId = window.__browserToolIdMap.get(e.id)!;
          window.__browserToolIdMap.delete(e.id);
          e.id = mappedId;
        }
        if (e.id) {
          // R93: Use reducer for core state mutations
          const mutations = wsEventReducer({ snapshot: buildSnapshot(), event: { ...event, id: e.id } });
          applyReducerMutations(mutations);
        }
        break;
      }

      case 'tool_result': {
        const e = event as { id?: string; tool?: string; result?: unknown; success?: boolean };
        resetStreamWatchdog(); // v10.1: Reset watchdog on tool result
        // Browser dedup: route merged tool IDs
        if (e.id && window.__browserToolIdMap?.has(e.id)) {
          const mappedId = window.__browserToolIdMap.get(e.id)!;
          window.__browserToolIdMap.delete(e.id);
          e.id = mappedId;
        }
        if (e.id || e.tool) {
          const resultStr = typeof e.result === 'string' ? e.result : (e.result ? JSON.stringify(e.result) : '');
          if (e.id) {
            useMessageStore.getState().updateToolCall(e.id, {
              result: resultStr,
              status: e.success !== false ? 'completed' : 'error',
              success: e.success !== false,
              completedAt: Date.now(),
            });
          }
        }
        break;
      }
      // P1: Browser action events - forward to BrowserPreviewPanel
      case 'browser_action': {
        const ba = event as { msgId?: string; action?: string; screenshot?: string; url?: string; args?: unknown; timestamp?: number };
        if (ba.screenshot) {
          const currentTools = useMessageStore.getState().activeTools;
          const browserTool = currentTools.find(t => t.tool === 'browser' && t.status === 'running');
          if (browserTool) {
            useMessageStore.getState().updateToolCall(browserTool.id, {
              screenshot: ba.screenshot,
              progress: `Browser: ${ba.action || 'action'} @ ${(ba.url || '').substring(0, 60)}`,
            });
          }
        }
        resetStreamWatchdog();
        break;
      }
      // P2: SubAgent events - forward to SubAgentPanel
      case 'subagent_event': {
        const sa = event as { msgId?: string; action?: string; subagentId?: string; subagentTask?: string; subagentStatus?: string; subagentResult?: string };
        useMessageStore.getState().addMessage({
          id: `subagent-${Date.now()}`,
          role: 'system',
          content: `[SubAgent] ${sa.action}: ${sa.subagentTask || sa.subagentResult || ''}`,
          msgId: sa.msgId || '',
          type: 'subagent_event',
          ...sa,
        } as any);
        resetStreamWatchdog();
        break;
      }
      // P0: Recovery status events
      case 'recovery_status': {
        const rs = event as { phase?: string; message?: string; taskId?: string; result?: string };
        console.log(`[P0-RECOVERY] ${rs.phase}: ${rs.message}`);
        // v2: Update RecoveryBanner via connection store
        if (rs.phase === 'recovering') {
          useConnectionStore.getState().setRecoveryPhase('recovering_task', rs.message || '正在恢复任务...');
        } else if (rs.phase === 'reconnected') {
          useConnectionStore.getState().setRecoveryPhase('recovered', rs.message || '任务已恢复');
          useMessageStore.getState().addMessage({
            id: `recovery-${Date.now()}`,
            role: 'system',
            content: rs.message || 'Task reconnected',
            msgId: rs.taskId || '',
          } as any);
          // Dismiss banner after 4 seconds
          setTimeout(() => {
            if (useConnectionStore.getState().recoveryPhase === 'recovered') {
              useConnectionStore.getState().setRecoveryPhase('idle');
            }
          }, 4000);
        } else if (rs.phase === 'failed') {
          useConnectionStore.getState().setRecoveryPhase('failed', rs.message || '任务恢复失败');
          setTimeout(() => {
            if (useConnectionStore.getState().recoveryPhase === 'failed') {
              useConnectionStore.getState().setRecoveryPhase('idle');
            }
          }, 6000);
        }
        break;
      }


      case 'stream_end':
      case 'message_done': {
        clearStreamWatchdog(); // v6.3: Clear watchdog on normal completion
        // R60-FIX: If this is a synthetic stream_end from server restart and we're not streaming, skip
        if ((event as any)._synthetic && !useMessageStore.getState().isStreaming) {
          console.log('[ChatStore] Ignoring synthetic stream_end — not currently streaming');
          break;
        }
        // v25.0: Flush stream buffer before processing stream_end (side effect)
        streamBuffer.flushAll();
        // Flush any remaining filtered content (side effect)
        const flushed = getStreamFilter().flush();
        if (flushed) {
          useMessageStore.getState().appendStream(flushed);
        }
        // R93: Use reducer for core state mutations
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        // Side effects: stop polling, clear localStorage refs
        stopPolling();
        activeMsgIdRef.current = null; localStorage.removeItem('rangerai_activeMsgId'); localStorage.removeItem('rangerai_activeChatId');
        break;
      }

      case 'error': {
        clearStreamWatchdog(); // v6.3: Clear watchdog on error
        // R93: Use reducer for core state mutations
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        break;
      }
      case 'clear_error': {
        // v1.1: Fallback succeeded — clear any previous error banner and restore streaming state
        useMessageStore.getState().setError(null);
        // R73v2: preserveContent=true — fallback recovery shouldn't wipe existing content
        useMessageStore.getState().setStreaming(true, true);
        break;
      }

      case 'suggestions': {
        const e = event as { suggestions?: string[] };
        if (e.suggestions) {
          useMessageStore.getState().setSuggestions(e.suggestions);
        }
        break;
      }

      case 'title_update': {
        const e = event as { chatId?: string; title?: string };
        if (e.chatId && e.title) {
          useChatListStore.getState().updateChat(e.chatId, { title: e.title });
        }
        break;
      }

      case 'routing_info':
      case 'routing': {
        const e = event as { taskType?: string; thinking?: string; confidence?: number; fallbackModel?: string; description?: string };
        useMessageStore.getState().setRoutingInfo({
          taskType: e.taskType || 'chat',
          thinking: e.thinking || 'medium',
          confidence: e.confidence || 0,
          model: e.fallbackModel || null,
          provider: null,
        });
        break;
      }

      case 'progress':
        resetStreamWatchdog(); // FIX: Reset watchdog on backend heartbeat to prevent premature stream cleanup
        break;

      // Iter-AG/AH: 任务运行超 3 分钟时后端推送，显示进度提示
      case 'long_running_notify': {
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        break;
      }

      case 'timeout_warning': {
        resetStreamWatchdog(); // FIX: Reset watchdog on timeout warning
        const e = event as { elapsed?: number };
        useMessageStore.getState().appendThinking(
          `\n${tRef.current('store.err.waitingSeconds').replace('{seconds}', String(e.elapsed || '?'))}\n`
        );
        break;
      }

      case 'task_timeout': {
        // R93: Use reducer for core state mutations
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        // R63-FIX: Error message uses i18n t() — side effect stays in handler
        useMessageStore.getState().setError(tRef.current('store.err.taskTimeout'));
        break;
      }


      case 'status': {
        const e = event as { status?: string };
        if (e.status === 'idle') {
          // Iter-AG/AH: 任务完成，清除长任务提示 (side effect)
          useConnectionStore.getState().setLongRunningNotice(null);
          clearStreamWatchdog(); // v6.3: Clear watchdog
          if (useMessageStore.getState().isStreaming) {
            // R60-FIX: Flush stream buffer BEFORE state snapshot (side effects)
            streamBuffer.flushAll();
            const remainingFiltered = getStreamFilter().flush();
            if (remainingFiltered) {
              useMessageStore.getState().appendStream(remainingFiltered);
            }
            // R93: Use reducer for core state mutations
            const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
            applyReducerMutations(mutations);
          }
          // Side effects: stop polling, clear localStorage refs
          stopPolling();
          activeMsgIdRef.current = null; localStorage.removeItem('rangerai_activeMsgId'); localStorage.removeItem('rangerai_activeChatId');
        }
        break;
      }
      case 'stats':
        // Stats event from backend — informational only, no action needed
        break;
      case 'file_changed': {
        const e = event as { path?: string; action?: string };
        if (e.path) {
          const wsStore = useWorkspaceStore.getState();
          wsStore.addChangedFile(e.path);
          if (!wsStore.isFilePanelOpen) {
            wsStore.toggleFilePanel(true);
          }
        }
        break;
      }

      case 'task_recovery': {
        const e = event as { status?: string; msgId?: string; userMessage?: string; eventCount?: number };
        console.log(`[ChatStore] Task recovery: status=${e.status}, msgId=${e.msgId}, events=${e.eventCount}`);
        // v2: Update RecoveryBanner progress
        if (e.status === 'starting') {
          useConnectionStore.getState().setRecoveryPhase('recovering_task', e.userMessage ? `正在恢复: ${e.userMessage.substring(0, 60)}...` : '正在恢复任务状态...');
        } else if (e.status === 'running') {
          useConnectionStore.getState().setRecoveryPhase('recovering_task', e.eventCount ? `已恢复 ${e.eventCount} 条事件...` : '正在重放任务事件...');
        } else if (e.status === 'completed') {
          useConnectionStore.getState().setRecoveryPhase('recovered', '任务已恢复');
          setTimeout(() => {
            if (useConnectionStore.getState().recoveryPhase === 'recovered') {
              useConnectionStore.getState().setRecoveryPhase('idle');
            }
          }, 4000);
        }
        // R73: Clear lastEventTs after successful recovery
        try { localStorage.removeItem('rangerai_lastEventTs'); } catch {}
        if (e.msgId) {
          activeMsgIdRef.current = e.msgId;
          if (e.msgId) localStorage.setItem('rangerai_activeMsgId', e.msgId);
        }
        if (e.status === 'running') {
          // R73v2: preserveContent=true — don't wipe content recovered via smartReplayEvents
          useMessageStore.getState().setStreaming(true, true);
        }
        // 'completed' status: events will be replayed via smartReplayEvents, stream_end handles cleanup
        break;
      }

      case 'cancel_confirmed': {
        const e = event as { msgId?: string };
        console.log('[ChatStore] Cancel confirmed:', e.msgId);
        streamBuffer.flushAll(); // v25.0: Flush remaining buffer before cancel
        useMessageStore.getState().clearStreaming();
        stopPolling();
        activeMsgIdRef.current = null; localStorage.removeItem('rangerai_activeMsgId'); localStorage.removeItem('rangerai_activeChatId');
        break;
      }

      case 'session_changed':
      case 'history':
        break;

      case 'notification_new': {
        const notifEvent = new CustomEvent('rangerai:notification', { detail: (event as any).notification });
        window.dispatchEvent(notifEvent);
        break;
      }

      // R55: CRITICAL tool confirmation request from tool-orchestrator v2.0
      case 'tool:confirm_required': {
        const tcr = event as { confirmId?: string; toolName?: string; toolArgs?: Record<string, unknown>; sessionKey?: string };
        if (tcr.confirmId && tcr.toolName) {
          console.log('[ChatStore] CRITICAL tool confirmation required:', tcr.toolName, tcr.confirmId);
          const confirmEvent = new CustomEvent('rangerai:tool_confirm', {
            detail: { confirmId: tcr.confirmId, toolName: tcr.toolName, toolArgs: tcr.toolArgs || {}, sessionKey: tcr.sessionKey }
          });
          window.dispatchEvent(confirmEvent);
        }
        break;
      }

      case 'plan_created':
      case 'plan_phase_update':
      case 'plan_completed': {
        // Dispatch plan events to any listeners via CustomEvent (side effect stays in handler)
        const planEvent = new CustomEvent('rangerai:plan', { detail: event });
        window.dispatchEvent(planEvent);
        // R93: Use reducer for taskPhase state transition
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        break;
      }

      // v15.0: Supervisor Engine progress events — dispatch to SupervisorTimeline
      case 'supervisor_progress': {
        const svEvent = new CustomEvent('rangerai:supervisor', { detail: event });
        window.dispatchEvent(svEvent);
        // Also reset stream watchdog on supervisor activity to prevent false timeouts
        resetStreamWatchdog();
        break;
      }

      // [R67] Plan progress from planner — real execution plan steps
      case 'plan_progress': {
        const mutations = wsEventReducer({ snapshot: buildSnapshot(), event });
        applyReducerMutations(mutations);
        resetStreamWatchdog();
        break;
      }


      // v14.2: Handle announce_message — server-initiated push messages
      // These arrive when subagents/autonomous tasks complete and push results
      case 'announce_message': {
        const announceEvt = event as { content?: string; model?: string; chatId?: string; runId?: string; streamId?: string };
        const announceContent = announceEvt.content || '';
        if (!announceContent || announceContent.trim().length < 3) break;

        const currentChatId = useChatListStore.getState().currentChatId;
        const msgStore = useMessageStore.getState();

        // If we're currently streaming, queue the announce for delivery after stream ends
        if (msgStore.isStreaming) {
          console.log('[ChatStore] announce_message received during active stream - queuing for post-stream delivery');
          // Queue and retry after streaming ends (poll every 500ms, max 30s)
          const queuedContent = announceContent;
          const queuedEvt = { ...announceEvt };
          let retries = 0;
          const announceRetryInterval = setInterval(() => {
            retries++;
            const store = useMessageStore.getState();
            if (!store.isStreaming || retries > 60) {
              clearInterval(announceRetryInterval);
              if (!store.isStreaming) {
                const queuedMsg = {
                  id: Date.now(),
                  chatId: queuedEvt.chatId || useChatListStore.getState().currentChatId || '',
                  role: 'assistant' as const,
                  content: queuedContent,
                  model: queuedEvt.model || 'RangerAI Agent (Announce)',
                  tokens: null,
                  msgId: queuedEvt.streamId || `announce-${Date.now()}`,
                  createdAt: new Date().toISOString(),
                  metadata: JSON.stringify({ type: 'announce', runId: queuedEvt.runId })
                };
                const curChatId = useChatListStore.getState().currentChatId;
                if (!queuedEvt.chatId || queuedEvt.chatId === curChatId) {
                  store.addMessage(queuedMsg);
                  console.log('[ChatStore] announce_message delivered after stream ended:', queuedContent.substring(0, 50));
                }
              } else {
                console.log('[ChatStore] announce_message delivery timed out - will appear on refresh');
              }
            }
          }, 500);
          break;
        }
        // Create a synthetic Message object and add it to the current message list
        const announceMsg = {
          id: Date.now(),
          chatId: announceEvt.chatId || currentChatId || '',
          role: 'assistant' as const,
          content: announceContent,
          model: announceEvt.model || 'RangerAI Agent (Announce)',
          tokens: null,
          msgId: announceEvt.streamId || `announce-${Date.now()}`,
          createdAt: new Date().toISOString(),
          metadata: JSON.stringify({ type: 'announce', runId: announceEvt.runId })
        };

        // Only add to UI if the announce belongs to the current chat or has no chatId
        if (!announceEvt.chatId || announceEvt.chatId === currentChatId) {
          msgStore.addMessage(announceMsg);
          console.log('[ChatStore] announce_message added to chat:', announceContent.substring(0, 50));
        } else {
          // Announce for a different chat — dispatch notification so user knows
          console.log('[ChatStore] announce_message for different chat:', announceEvt.chatId, 'current:', currentChatId);
        }

        // Dispatch a custom event for any toast/notification UI
        const announceNotif = new CustomEvent('rangerai:announce', {
          detail: { content: announceContent, chatId: announceEvt.chatId, runId: announceEvt.runId }
        });
        window.dispatchEvent(announceNotif);
        break;
      }

      // R57: Non-blocking progress notification from backend (sendNotify)
      case 'notify': {
        const notifyEvt = event as { content?: string; level?: string };
        if (notifyEvt.content) {
          console.log('[ChatStore] R57 notify:', notifyEvt.content);
          window.dispatchEvent(new CustomEvent('agent:notify', { detail: { content: notifyEvt.content, level: notifyEvt.level || 'info' } }));
        }
        break;
      }
      default:
        console.log('[ChatStore] Unhandled WS event:', event.type);
    }
  }, [resetStreamWatchdog, clearStreamWatchdog, streamBuffer]);

  // ─── HTTP Polling Fallback (Phase 3: extracted to useHttpPolling) ──
  const handlePolledEvent = useCallback((event: Record<string, unknown>) => {
    handleWsEvent(event as WsEvent);
  }, [handleWsEvent]);

  const onPollCompleted = useCallback((_msgId: string, status: string) => {
    activeMsgIdRef.current = null;
    localStorage.removeItem('rangerai_activeMsgId');
    localStorage.removeItem('rangerai_activeChatId');
    const msgStore = useMessageStore.getState();
    if (msgStore.isStreaming && status === 'failed') {
      // R65-FIX: Commit any accumulated content before showing error (HTTP polling path)
      const failedContent = msgStore.streamingContent;
      if (failedContent && failedContent.trim().length > 0) {
        console.warn('[ChatStore] HTTP poll task failed — committing %d chars before error.', failedContent.length);
        msgStore.streamEnd(failedContent, undefined);
      } else {
        msgStore.clearStreaming();
      }
      msgStore.setError(tRef.current('store.err.taskFailed'));
    }
  }, []);

  const { startPolling, stopPolling, isPolling } = useHttpPolling({
    onEvent: handlePolledEvent,
    onCompleted: onPollCompleted,
    intervalMs: 3000,
  });

  const handleConnectionChange = useCallback((connected: boolean) => {
    const wasConnected = wsConnectedRef.current;
    wsConnectedRef.current = connected;
    useConnectionStore.getState().setWsConnected(connected);
    useConnectionStore.getState().setRecoveryPhase(connected ? 'recovering_task' : 'reconnecting_ws', connected ? 'WebSocket 已恢复，正在恢复任务上下文...' : 'WebSocket 连接中断，正在重连...');

    if (!connected && wasConnected) {
      if (activeMsgIdRef.current && useMessageStore.getState().isStreaming) {
        console.log('[ChatStore] WS disconnected during active task, starting HTTP polling fallback');
        startPolling(activeMsgIdRef.current);
        // R57-STREAMFIX: Persist streamingContent snapshot so reconnect can rehydrate
        const chatId = useChatListStore.getState().currentChatId;
        if (chatId) {
          const cs = useMessageStore.getState().getChatStream(chatId);
          if (cs.streamingContent) {
            localStorage.setItem('rangerai_streamSnapshot_chatId', chatId);
            localStorage.setItem('rangerai_streamSnapshot_content', cs.streamingContent);
            localStorage.setItem('rangerai_streamSnapshot_thinking', cs.thinkingContent || '');
            console.log('[ChatStore] Persisted streamingContent snapshot (%d chars) for chatId=%s', cs.streamingContent.length, chatId);
          }
        }
      }
    } else if (connected && !wasConnected) {
      if (isPolling) {
        console.log('[ChatStore] WS reconnected, stopping HTTP polling');
        stopPolling();
      }
      useConnectionStore.getState().setRecoveryPhase('recovered', '连接已恢复，可继续对话');
      // Iter-AG: offline queue flush happens inside wsSend() via wsConnectedRef check
    }
  }, [startPolling, stopPolling, isPolling]);

  const handleStateChange = useCallback((wsState: import('../hooks/useWebSocket').WsConnectionState) => {
    if (wsState === 'reconnecting') {
      useConnectionStore.getState().setWsReconnecting(true, 0);
      useConnectionStore.getState().setRecoveryPhase('reconnecting_ws', '正在重连 WebSocket...');
    } else if (wsState === 'disconnected') {
      // If we were reconnecting and now disconnected, it means max attempts reached
      if (useConnectionStore.getState().wsReconnecting) {
        useConnectionStore.getState().setWsGaveUp(true);
        useConnectionStore.getState().setRecoveryPhase('failed', '连接恢复失败，请手动重试');
      }
      useConnectionStore.getState().setWsReconnecting(false, 0);
    }
  }, []);

  const { connected: wsConnected, send: wsRawSend, bindChat, reconnectAttempt, connect: wsConnect, neverConnectedFailed } = useWebSocket({
    onEvent: handleWsEvent,
    onConnectionChange: handleConnectionChange,
    onStateChange: handleStateChange,
  });

  // Iter-AG: wsSend with offline queue — if disconnected, queue the message
  const wsSend = useCallback((data: Record<string, unknown>) => {
    if (wsConnectedRef.current) {
      // Flush any queued messages first
      if (offlineQueueRef.current.length > 0) {
        console.log('[ChatStore] Flushing offline queue:', offlineQueueRef.current.length, 'messages');
        const queue = offlineQueueRef.current.splice(0);
        for (const msg of queue) {
          wsRawSend(msg);
        }
      }
      wsRawSend(data);
    } else {
      // Queue non-control messages for later (skip heartbeat-type messages)
      const queueable = data.type !== 'ping' && data.type !== 'pong';
      if (queueable) {
        console.log('[ChatStore] WS offline, queuing message:', data.type);
        offlineQueueRef.current.push(data);
      }
    }
  }, [wsRawSend]);

  // Sync reconnect attempt count
  useEffect(() => {
    if (reconnectAttempt > 0) {
      useConnectionStore.getState().setWsReconnecting(true, reconnectAttempt);
      useConnectionStore.getState().setRecoveryPhase('reconnecting_ws', `正在重连 WebSocket（第 ${reconnectAttempt} 次）...`);
    }
  }, [reconnectAttempt]);

  // Iter-AG: Sync neverConnectedFailed → wsGaveUp store (for ConnectionFailedBanner)
  useEffect(() => {
    if (neverConnectedFailed) {
      useConnectionStore.getState().setWsGaveUp(true);
    }
  }, [neverConnectedFailed]);

  // ─── Gateway Health Polling (Phase 4: extracted to useGatewayHealth) ──
  useGatewayHealth({ wsConnected });

  // ─── Initial Load ────────────────────────────────────────
  useEffect(() => {
    useAuthStore.getState().checkAuth();
  }, []);

  useEffect(() => {
    const unsub = useAuthStore.subscribe((state, prev) => {
      if (prev.isAuthLoading && !state.isAuthLoading) {
        useChatListStore.getState().loadChats();
        useChatListStore.getState().loadTags();
      }
    });
    // Also check immediately if auth is already loaded
    if (!useAuthStore.getState().isAuthLoading) {
      useChatListStore.getState().loadChats();
      useChatListStore.getState().loadTags();
    }
    return unsub;
  }, []);

  // Restore last selected chat
  useEffect(() => {
    const unsub = useChatListStore.subscribe((state, prev) => {
      if (prev.chats.length === 0 && state.chats.length > 0) {
        const savedChatId = localStorage.getItem('rangerai_currentChatId');
        if (savedChatId && state.chats.some(c => c.id === savedChatId) && !state.currentChatId) {
          useChatListStore.getState().setCurrentChatId(savedChatId);
          useMessageStore.getState().selectChat(savedChatId);
          bindChat(savedChatId);
          localStorage.setItem('rangerai_currentChatId', savedChatId);
        }
      }
    });
    return unsub;
  }, [bindChat]);

  // Re-bind chat when WS reconnects + refresh messages to catch missed ones
  useEffect(() => {
    if (wsConnected) {
      const isReconnect = wsEverConnectedRef.current; // true = reconnect, false = first connect
      wsEverConnectedRef.current = true;

      const currentChatId = useChatListStore.getState().currentChatId;
      // FIX-REFRESH: Check localStorage for persisted active task (survives page refresh)
      const lsMsgId = localStorage.getItem('rangerai_activeMsgId');
      const lsChatId = localStorage.getItem('rangerai_activeChatId');
      const effectiveMsgId = activeMsgIdRef.current || lsMsgId;
      const effectiveChatId = currentChatId || lsChatId;
      if (effectiveChatId) {
        if (effectiveMsgId) {
          // R52 FIX: Defer recover_task until chat_bound arrives (bind_chat is async — DB query must complete first)
          // Without this, recover_task uses the new random sessionKey instead of the persisted one from DB
          console.log('[ChatStore] WS connected, deferring recover_task until chat_bound: msgId=%s, chatId=%s, fromLS=%s', effectiveMsgId, effectiveChatId, !activeMsgIdRef.current);
          activeMsgIdRef.current = effectiveMsgId;
          // R57-STREAMFIX: Rehydrate persisted streamingContent snapshot before recover_task
          // This restores content that was mid-stream when WS disconnected (not yet committed to DB)
          const snapChatId = localStorage.getItem('rangerai_streamSnapshot_chatId');
          const snapContent = localStorage.getItem('rangerai_streamSnapshot_content');
          const snapThinking = localStorage.getItem('rangerai_streamSnapshot_thinking');
          if (snapChatId && snapContent && snapChatId === effectiveChatId) {
            const cs = useMessageStore.getState().getChatStream(effectiveChatId);
            if (!cs.streamingContent || cs.streamingContent.length < snapContent.length) {
              useMessageStore.getState().updateChatStream(effectiveChatId, {
                streamingContent: snapContent,
                thinkingContent: snapThinking || cs.thinkingContent,
              });
              console.log('[ChatStore] Rehydrated streamingContent from snapshot (%d chars) for chatId=%s', snapContent.length, effectiveChatId);
            }
            localStorage.removeItem('rangerai_streamSnapshot_chatId');
            localStorage.removeItem('rangerai_streamSnapshot_content');
            localStorage.removeItem('rangerai_streamSnapshot_thinking');
          }
          // R53 FIX: preserveContent=true — do NOT wipe streamingContent on reconnect
          // Bug: setStreaming(true) was clearing all streamed content when WS reconnected mid-stream
          useMessageStore.getState().setStreaming(true, true);
          pendingRecoveryRef.current = {
            msgId: effectiveMsgId,
            chatId: effectiveChatId,
          };
          // v2: Trigger recovery progress in RecoveryBanner
          if (isReconnect) {
            useConnectionStore.getState().setRecoveryPhase('recovering_task', '正在恢复任务状态...');
          }
        }
        bindChat(effectiveChatId);  // Send bind_chat — chat_bound handler will fire recover_task
        if (!effectiveMsgId) {
          // No active task to recover
          if (useMessageStore.getState().isStreaming && !activeMsgIdRef.current) {
            // Layer-3: Orphan stream detected — isStreaming=true but no tracked msgId (zombie state)
            // R65-FIX: Commit accumulated content before clearing orphan state
            const orphanStore = useMessageStore.getState();
            const orphanContent = orphanStore.streamingContent;
            if (orphanContent && orphanContent.trim().length > 0) {
              console.warn('[ChatStore] WS reconnected: orphan stream has %d chars — committing before clear.', orphanContent.length);
              orphanStore.streamEnd(orphanContent, undefined);
            } else {
              console.warn('[ChatStore] WS reconnected: orphan streaming state detected (no activeMsgId). Clearing zombie stream.');
              orphanStore.clearStreaming();
            }
            clearStreamWatchdog();
          } else {
            // Not streaming — silently refresh messages to catch any missed during disconnection
            // Debounce: delay refresh by 2s to avoid rapid re-renders on flapping connections
            if (reconnectRefreshTimerRef.current) clearTimeout(reconnectRefreshTimerRef.current);
            reconnectRefreshTimerRef.current = setTimeout(() => {
              reconnectRefreshTimerRef.current = null;
              console.log('[ChatStore] WS connected, refreshing messages (debounced, isReconnect=%s)', isReconnect);
              if (currentChatId) useMessageStore.getState().refreshMessages(currentChatId);
            }, isReconnect ? 2000 : 0); // 2s debounce on reconnect, immediate on first connect
          }
        }
      }
    }
  }, [wsConnected, bindChat, wsSend, resetStreamWatchdog, clearStreamWatchdog]);

  // ─── Regenerate Event Listener (Phase 4: extracted to useRegenerateListener) ──
  useRegenerateListener({ bindChat, activeMsgIdRef, t: t as any });

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      stopPolling();
      clearStreamWatchdog(); // v6.3→R93: Cleanup watchdog via extracted hook
    };
  }, [stopPolling, clearStreamWatchdog]);

  const setActiveMsgId = useCallback((msgId: string | null) => {
    activeMsgIdRef.current = msgId;
  }, []);

  const cancelTask = useCallback(() => {
    const state = useMessageStore.getState();
    if (state.isStreaming && !state.isCancelling) {
      wsSend({ type: 'cancel' });
      // Set isCancelling to block new messages; actual cleanup on cancel_confirmed
      state.setCancelling(true);
      // Safety fallback: if cancel_confirmed never arrives, force-clear after 5s
      setTimeout(() => {
        if (useMessageStore.getState().isCancelling) {
          useMessageStore.getState().clearStreaming();
          stopPolling();
          activeMsgIdRef.current = null; localStorage.removeItem('rangerai_activeMsgId'); localStorage.removeItem('rangerai_activeChatId');
        }
      }, 5000);
    }
  }, [wsSend, stopPolling]);

  const orchestratorValue: ChatOrchestratorValue = {
    wsConnected,
    bindChat,
    wsSend,
    setActiveMsgId,
    cancelTask,
    wsForceReconnect: () => {
      useConnectionStore.getState().setWsGaveUp(false);
      wsConnect();
    },
  };

  return (
    <ChatOrchestratorContext.Provider value={orchestratorValue}>
      {children}
    </ChatOrchestratorContext.Provider>
  );
}

// ─── Orchestrator Hook (exported for useChatActions) ──────
export function useOrchestrator(): ChatOrchestratorValue {
  const ctx = useContext(ChatOrchestratorContext);
  if (!ctx) {
    // Fallback for components outside ChatProvider
    return { wsConnected: false, bindChat: () => {}, wsSend: () => {}, setActiveMsgId: () => {}, cancelTask: () => {}, wsForceReconnect: () => {} };
  }
  return ctx;
}

// ─── Backward Compatibility Export ─────────────────────────
// Some components (e.g., CapabilitiesPanel) import useChatStore.
// This shim provides a minimal compatible interface.
export function useChatStore() {
  return {
    state: {},
    createNewChat: async (_name?: string) => ({ id: `chat-${Date.now()}` }),
    sendMessage: async (_msg: string, _opts?: unknown, _chatId?: string) => {},
  };
}
