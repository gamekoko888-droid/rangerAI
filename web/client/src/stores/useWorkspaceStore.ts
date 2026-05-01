/**
 * useWorkspaceStore — Workspace files & AI capabilities state (Zustand)
 * 
 * Manages: workspace file tree, file content, file panel, AI skills/tools/capabilities
 * Consumers: FilePanel, CapabilitiesPanel, ChatPage
 */
import { create } from 'zustand';
import type { WorkspaceFileEntry, WorkspaceFileContent } from '../lib/types';
import * as api from '../lib/api';
import { logger } from "../lib/logger";

interface WorkspaceState {
  workspaceFiles: WorkspaceFileEntry[];
  selectedFilePath: string | null;
  fileContent: WorkspaceFileContent | null;
  isFilePanelOpen: boolean;
  isLoadingFiles: boolean;
  changedFiles: string[];
  // AI capabilities (from connected event)
  aiSkills: Array<{
    name: string;
    displayName?: string;
    label?: string;
    description?: string;
    emoji?: string;
    eligible: boolean;
    source?: string;
    homepage?: string | null;
  }>;
  aiTools: string[];
  aiCapabilities: string[];
}

interface WorkspaceActions {
  setWorkspaceFiles: (files: WorkspaceFileEntry[]) => void;
  setSelectedFile: (path: string | null) => void;
  setFileContent: (content: WorkspaceFileContent | null) => void;
  toggleFilePanel: (open?: boolean) => void;
  setLoadingFiles: (loading: boolean) => void;
  addChangedFile: (path: string) => void;
  clearChangedFiles: () => void;
  setAiCapabilities: (skills: WorkspaceState['aiSkills'], tools: string[], capabilities: string[]) => void;

  // Async actions
  loadWorkspaceFiles: () => Promise<void>;
  selectFile: (path: string | null) => Promise<void>;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  // ─── State ───────────────────────────────────────────────
  workspaceFiles: [],
  selectedFilePath: null,
  fileContent: null,
  isFilePanelOpen: false,
  isLoadingFiles: false,
  changedFiles: [],
  aiSkills: [],
  aiTools: [],
  aiCapabilities: [],

  // ─── Sync Actions ────────────────────────────────────────
  setWorkspaceFiles: (files) => set({ workspaceFiles: files }),
  setSelectedFile: (path) => set({ selectedFilePath: path, fileContent: null }),
  setFileContent: (content) => set({ fileContent: content }),
  toggleFilePanel: (open) =>
    set((s) => ({ isFilePanelOpen: open !== undefined ? open : !s.isFilePanelOpen })),
  setLoadingFiles: (loading) => set({ isLoadingFiles: loading }),
  addChangedFile: (path) =>
    set((s) => {
      if (s.changedFiles.includes(path)) return s;
      return { changedFiles: [...s.changedFiles, path] };
    }),
  clearChangedFiles: () => set({ changedFiles: [] }),
  setAiCapabilities: (skills, tools, capabilities) =>
    set({ aiSkills: skills, aiTools: tools, aiCapabilities: capabilities }),

  // ─── Async Actions ───────────────────────────────────────
  loadWorkspaceFiles: async () => {
    set({ isLoadingFiles: true });
    try {
      const files = await api.fetchWorkspaceTree();
      set({ workspaceFiles: files, isLoadingFiles: false });
    } catch (err) {
      logger.error('[WorkspaceStore] Failed to load workspace files:', err);
      set({ isLoadingFiles: false });
    }
  },

  selectFile: async (path: string | null) => {
    set({ selectedFilePath: path, fileContent: null });
    if (!path) return;
    try {
      const content = await api.fetchWorkspaceFile(path);
      set({ fileContent: content });
    } catch (err) {
      logger.error('[WorkspaceStore] Failed to load file:', err);
    }
  },
}));
