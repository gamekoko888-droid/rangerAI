/**
 * useRegenerateListener — Regenerate event handler hook
 *
 * Extracted from useChatStore.tsx (Phase 4 refactor).
 * Listens for 'rangerai:regenerate' custom events and re-sends the message
 * via the API, handling loading states, error display, and activeMsgId tracking.
 */

import { useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { useMessageStore } from '../stores/useMessageStore';
import { useChatListStore } from '../stores/useChatListStore';

interface UseRegenerateListenerOptions {
  bindChat: (chatId: string) => void;
  activeMsgIdRef: React.MutableRefObject<string | null>;
  t: (key: string, params?: Record<string, string>) => string;
}

export function useRegenerateListener({
  bindChat,
  activeMsgIdRef,
  t,
}: UseRegenerateListenerOptions) {
  // Keep t in a ref so the effect doesn't re-subscribe on language changes
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const handleRegenerate = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const { chatId, messages: updatedMessages, userContent } = detail;

      useMessageStore.getState().setMessages(updatedMessages);

      if (userContent && chatId) {
        useMessageStore.getState().clearStreaming();
        useMessageStore.getState().setStreaming(true);
        useMessageStore.getState().setSuggestions([]);

        try {
          bindChat(chatId);
          const { selectedModel, selectedRole } = useMessageStore.getState();
          const sendResult = await api.sendMessage(
            chatId, userContent, undefined,
            selectedModel, undefined, selectedRole,
          );
          activeMsgIdRef.current = sendResult.msgId;
          localStorage.setItem('rangerai_activeMsgId', sendResult.msgId);
          localStorage.setItem(
            'rangerai_activeChatId',
            useChatListStore.getState().currentChatId || '',
          );
        } catch (err: unknown) {
          console.error('[useRegenerateListener] Regenerate re-send failed:', err);
          let errorMsg = tRef.current('store.err.regenerateFailed');
          if (err instanceof api.ApiError) {
            errorMsg = err.message || tRef.current('store.err.serverErrorShort');
          }
          useMessageStore.getState().setError(errorMsg);
          useMessageStore.getState().clearStreaming();
          setTimeout(() => useMessageStore.getState().setError(null), 8000);
        }
      }
    };

    window.addEventListener('rangerai:regenerate', handleRegenerate);
    return () => window.removeEventListener('rangerai:regenerate', handleRegenerate);
  }, [bindChat, activeMsgIdRef]);
}
