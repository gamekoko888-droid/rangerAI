/**
 * useChatActions — Cross-store coordination hook
 * 
 * Provides orchestrated actions that span multiple Zustand stores:
 *   - selectChat: updates ChatList + loads Messages + binds WebSocket
 *   - createNewChat: creates in ChatList + binds WebSocket + selects messages
 *   - sendMessage: sends via MessageStore with WS binding + auto-create chat + tracks activeMsgId
 *   - cancelTask: sends cancel message to stop current AI generation
 *   - logout: clears Auth + ChatList
 * 
 * Components that only need single-store actions should import stores directly.
 * Use this hook only when you need cross-store coordination.
 */
import { useCallback, useRef } from 'react';
import { useChatListStore } from '../stores/useChatListStore';
import { useMessageStore } from '../stores/useMessageStore';
import { useAuthStore } from '../stores/useAuthStore';
import { useOrchestrator } from './useChatStore';
import type { Chat } from '../lib/types';

export function useChatActions() {
  const orchestrator = useOrchestrator();
  // Ref to track active message ID for HTTP polling fallback and task recovery
  const activeMsgIdRef = useRef<string | null>(null);

  const selectChat = useCallback(async (chatId: string) => {
    useChatListStore.getState().setCurrentChatId(chatId);
    localStorage.setItem('rangerai_currentChatId', chatId);
    orchestrator.bindChat(chatId);
    // Dispatch chat_changed event to clear SupervisorTimeline state
    window.dispatchEvent(new CustomEvent('rangerai:chat_changed', { detail: { chatId } }));
    await useMessageStore.getState().selectChat(chatId);
  }, [orchestrator]);

  const createNewChat = useCallback(async (title?: string): Promise<Chat> => {
    const chat = await useChatListStore.getState().createNewChat(title);
    orchestrator.bindChat(chat.id);
    // Dispatch chat_changed event to clear SupervisorTimeline state
    window.dispatchEvent(new CustomEvent('rangerai:chat_changed', { detail: { chatId: chat.id } }));
    // Clear messages and select the new empty chat to show welcome screen
    useMessageStore.getState().setMessages([]);
    useMessageStore.getState().clearStreaming();
    useMessageStore.getState().setSuggestions([]);
    useMessageStore.getState().setError(null);
    return chat;
  }, [orchestrator]);

  const sendMessage = useCallback(async (
    content: string,
    attachments?: Array<{ type: string; url: string; name: string; mimeType: string; size: number }>,
    targetChatId?: string
  ) => {
    const chatId = targetChatId || useChatListStore.getState().currentChatId;
    await useMessageStore.getState().sendMessage(
      content,
      attachments,
      chatId || undefined,
      orchestrator.bindChat,
      async (t?: string) => {
        const chat = await useChatListStore.getState().createNewChat(t);
        orchestrator.bindChat(chat.id);
        return chat;
      },
      undefined,
      activeMsgIdRef,
    );
    // Sync activeMsgIdRef to orchestrator so ChatProvider can use it for polling/recovery
    if (activeMsgIdRef.current) {
      orchestrator.setActiveMsgId(activeMsgIdRef.current);
    }
  }, [orchestrator]);

  const cancelTask = useCallback(() => {
    orchestrator.cancelTask();
    activeMsgIdRef.current = null;
  }, [orchestrator]);

  const logout = useCallback(async () => {
    await useAuthStore.getState().logout();
    useChatListStore.getState().setChats([]);
    useChatListStore.getState().setCurrentChatId(null);
    localStorage.removeItem('rangerai_currentChatId');
  }, []);

  return {
    selectChat,
    createNewChat,
    sendMessage,
    cancelTask,
    logout,
    bindChat: orchestrator.bindChat,
    wsConnected: orchestrator.wsConnected,
    wsForceReconnect: orchestrator.wsForceReconnect,
  };
}
