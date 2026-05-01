/**
 * useChatListStore — Chat list management state (Zustand)
 * 
 * Manages: chats array, currentChatId, search/filter, tags, loading states
 * Consumers: ChatPage, Sidebar, TagManager
 */
import { create } from 'zustand';
import { logger } from "../lib/logger";
import type { Chat } from '../lib/types';
import * as api from '../lib/api';

interface ChatListState {
  chats: Chat[];
  currentChatId: string | null;
  isLoadingChats: boolean;
  searchQuery: string;
  filterTag: string | null;
  allTags: string[];
}

interface ChatListActions {
  setChats: (chats: Chat[]) => void;
  addChat: (chat: Chat) => void;
  updateChat: (chatId: string, updates: Partial<Chat>) => void;
  removeChat: (chatId: string) => void;
  setCurrentChatId: (chatId: string | null) => void;
  setLoadingChats: (loading: boolean) => void;
  setSearchQuery: (query: string) => void;
  setFilterTag: (tag: string | null) => void;
  setAllTags: (tags: string[]) => void;

  // Async actions
  loadChats: () => Promise<void>;
  createNewChat: (title?: string) => Promise<Chat>;
  deleteChat: (chatId: string) => Promise<void>;
  batchDeleteChats: (chatIds: string[]) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  updateChatTags: (chatId: string, tags: string[]) => Promise<void>;
  searchChats: (query: string) => Promise<void>;
  filterByTag: (tag: string | null) => Promise<void>;
  loadTags: () => Promise<void>;
}

export type ChatListStore = ChatListState & ChatListActions;

export const useChatListStore = create<ChatListStore>((set, get) => ({
  // ─── State ───────────────────────────────────────────────
  chats: [],
  currentChatId: null,
  isLoadingChats: false,
  searchQuery: '',
  filterTag: null,
  allTags: [],

  // ─── Sync Actions ────────────────────────────────────────
  setChats: (chats) => set({ chats, isLoadingChats: false }),
  addChat: (chat) => set((s) => ({ chats: [chat, ...s.chats] })),
  updateChat: (chatId, updates) =>
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...updates } : c)),
    })),
  removeChat: (chatId) =>
    set((s) => ({
      chats: s.chats.filter((c) => c.id !== chatId),
      currentChatId: s.currentChatId === chatId ? null : s.currentChatId,
    })),
  setCurrentChatId: (chatId) => set({ currentChatId: chatId }),
  setLoadingChats: (loading) => set({ isLoadingChats: loading }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setFilterTag: (tag) => set({ filterTag: tag }),
  setAllTags: (tags) => set({ allTags: tags }),

  // ─── Async Actions ───────────────────────────────────────
  loadChats: async () => {
    set({ isLoadingChats: true });
    try {
      const chats = await api.withRetry(() => api.fetchChats(), {
        maxRetries: 3,
        baseDelay: 1500,
        onRetry: (attempt) => logger.debug(`[ChatListStore] loadChats retry ${attempt}/3`),
      });
      set({ chats, isLoadingChats: false });
    } catch (err) {
      logger.error('[ChatListStore] Failed to load chats after retries:', err);
      set({ isLoadingChats: false });
    }
  },

  createNewChat: async (title?: string): Promise<Chat> => {
    const chat = await api.withRetry(() => api.createChat(title), {
      maxRetries: 2,
      baseDelay: 1000,
      onRetry: (attempt) => logger.debug(`[ChatListStore] createNewChat retry ${attempt}/2`),
    });
    set((s) => ({
      chats: [chat, ...s.chats],
      currentChatId: chat.id,
    }));
    localStorage.setItem('rangerai_currentChatId', chat.id);
    return chat;
  },

  deleteChat: async (chatId: string) => {
    await api.deleteChat(chatId);
    const s = get();
    set({
      chats: s.chats.filter((c) => c.id !== chatId),
      currentChatId: s.currentChatId === chatId ? null : s.currentChatId,
    });
    if (s.currentChatId === chatId) {
      localStorage.removeItem('rangerai_currentChatId');
    }
  },

  batchDeleteChats: async (chatIds: string[]) => {
    await api.batchDeleteChats(chatIds);
    const s = get();
    set({
      chats: s.chats.filter((c) => !chatIds.includes(c.id)),
      currentChatId: chatIds.includes(s.currentChatId || '') ? null : s.currentChatId,
    });
    if (chatIds.includes(s.currentChatId || '')) {
      localStorage.removeItem('rangerai_currentChatId');
    }
  },

  renameChat: async (chatId: string, title: string) => {
    const updated = await api.updateChatTitle(chatId, title);
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, title: updated.title } : c)),
    }));
  },

  updateChatTags: async (chatId: string, tags: string[]) => {
    const result = await api.updateChatTags(chatId, tags);
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, tags: JSON.stringify(result.tags) } : c
      ),
    }));
  },

  searchChats: async (query: string) => {
    set({ searchQuery: query });
    if (!query.trim()) {
      get().loadChats();
      return;
    }
    set({ isLoadingChats: true });
    try {
      const chats = await api.searchChats(query);
      set({ chats, isLoadingChats: false });
    } catch (err) {
      logger.error('[ChatListStore] Search failed:', err);
      set({ isLoadingChats: false });
    }
  },

  filterByTag: async (tag: string | null) => {
    set({ filterTag: tag });
    if (!tag) {
      get().loadChats();
      return;
    }
    set({ isLoadingChats: true });
    try {
      const chats = await api.getChatsByTag(tag);
      set({ chats, isLoadingChats: false });
    } catch (err) {
      logger.error('[ChatListStore] Tag filter failed:', err);
      set({ isLoadingChats: false });
    }
  },

  loadTags: async () => {
    try {
      const tags = await api.getAllTags();
      set({ allTags: tags });
    } catch (err) {
      logger.error('[ChatListStore] Failed to load tags:', err);
    }
  },
}));
