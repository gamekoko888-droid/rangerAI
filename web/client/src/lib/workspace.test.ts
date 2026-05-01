/**
 * Tests for Phase 2: Workspace file panel functionality.
 * Covers: workspace reducer actions, file type helpers, and API types.
 */

import { describe, expect, it } from 'vitest';
import type {
  ChatState, ChatAction, WorkspaceFileEntry, WorkspaceFileContent,
} from './types';

// ─── Inline Reducer (workspace-related actions from useChatStore.tsx) ──

const initialState: ChatState = {
  chats: [],
  currentChatId: null,
  messages: [],
  isStreaming: false,
  streamingContent: '',
  thinkingContent: '',
  activeTools: [],
  executionSteps: [],
  wsConnected: false,
  gatewayConnected: false,
  suggestions: [],
  isLoadingChats: false,
  isLoadingMessages: false,
  error: null,
  user: null,
  isAuthLoading: true,
  searchQuery: '',
  filterTag: null,
  allTags: [],
  currentRoutingInfo: null,
  messageRoutingMap: {},
  selectedModel: 'auto',
  _lastStreamEndAt: 0,
  // Workspace
  workspaceFiles: [],
  selectedFilePath: null,
  fileContent: null,
  isFilePanelOpen: false,
  isLoadingFiles: false,
  changedFiles: [],
};

function workspaceReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_WORKSPACE_FILES':
      return { ...state, workspaceFiles: action.files };
    case 'SET_SELECTED_FILE':
      return { ...state, selectedFilePath: action.path, fileContent: null };
    case 'SET_FILE_CONTENT':
      return { ...state, fileContent: action.content };
    case 'TOGGLE_FILE_PANEL':
      return { ...state, isFilePanelOpen: action.open !== undefined ? action.open : !state.isFilePanelOpen };
    case 'SET_LOADING_FILES':
      return { ...state, isLoadingFiles: action.loading };
    case 'ADD_CHANGED_FILE': {
      if (state.changedFiles.includes(action.path)) return state;
      return { ...state, changedFiles: [...state.changedFiles, action.path] };
    }
    case 'CLEAR_CHANGED_FILES':
      return { ...state, changedFiles: [] };
    default:
      return state;
  }
}

// ─── Mock Data ──────────────────────────────────────────────

const mockFileTree: WorkspaceFileEntry[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [
      { name: 'index.ts', path: 'src/index.ts', type: 'file', size: 256 },
      { name: 'utils.ts', path: 'src/utils.ts', type: 'file', size: 128 },
    ],
  },
  { name: 'package.json', path: 'package.json', type: 'file', size: 512 },
  { name: 'README.md', path: 'README.md', type: 'file', size: 1024 },
];

const mockFileContent: WorkspaceFileContent = {
  path: 'src/index.ts',
  content: 'console.log("hello");',
  size: 21,
  mimeType: 'text/plain',
  isBinary: false,
};

// ─── Workspace Reducer Tests ────────────────────────────────

describe('workspaceReducer — file tree management', () => {
  it('SET_WORKSPACE_FILES sets the file tree', () => {
    const state = workspaceReducer(initialState, {
      type: 'SET_WORKSPACE_FILES',
      files: mockFileTree,
    });
    expect(state.workspaceFiles).toHaveLength(3);
    expect(state.workspaceFiles[0].name).toBe('src');
    expect(state.workspaceFiles[0].type).toBe('directory');
    expect(state.workspaceFiles[0].children).toHaveLength(2);
  });

  it('SET_WORKSPACE_FILES replaces existing files', () => {
    let state = workspaceReducer(initialState, {
      type: 'SET_WORKSPACE_FILES',
      files: mockFileTree,
    });
    const newFiles: WorkspaceFileEntry[] = [
      { name: 'new.txt', path: 'new.txt', type: 'file', size: 10 },
    ];
    state = workspaceReducer(state, { type: 'SET_WORKSPACE_FILES', files: newFiles });
    expect(state.workspaceFiles).toHaveLength(1);
    expect(state.workspaceFiles[0].name).toBe('new.txt');
  });

  it('SET_WORKSPACE_FILES handles empty array', () => {
    const state = workspaceReducer(initialState, {
      type: 'SET_WORKSPACE_FILES',
      files: [],
    });
    expect(state.workspaceFiles).toHaveLength(0);
  });
});

describe('workspaceReducer — file selection', () => {
  it('SET_SELECTED_FILE sets path and clears content', () => {
    const stateWithContent = {
      ...initialState,
      fileContent: mockFileContent,
      selectedFilePath: 'old/path.ts',
    };
    const state = workspaceReducer(stateWithContent, {
      type: 'SET_SELECTED_FILE',
      path: 'src/index.ts',
    });
    expect(state.selectedFilePath).toBe('src/index.ts');
    expect(state.fileContent).toBeNull(); // Content cleared for new selection
  });

  it('SET_SELECTED_FILE with null deselects', () => {
    const stateWithSelection = {
      ...initialState,
      selectedFilePath: 'src/index.ts',
      fileContent: mockFileContent,
    };
    const state = workspaceReducer(stateWithSelection, {
      type: 'SET_SELECTED_FILE',
      path: null,
    });
    expect(state.selectedFilePath).toBeNull();
    expect(state.fileContent).toBeNull();
  });

  it('SET_FILE_CONTENT sets the file content', () => {
    const state = workspaceReducer(initialState, {
      type: 'SET_FILE_CONTENT',
      content: mockFileContent,
    });
    expect(state.fileContent).toBeDefined();
    expect(state.fileContent!.path).toBe('src/index.ts');
    expect(state.fileContent!.content).toBe('console.log("hello");');
    expect(state.fileContent!.isBinary).toBe(false);
  });

  it('SET_FILE_CONTENT with null clears content', () => {
    const stateWithContent = { ...initialState, fileContent: mockFileContent };
    const state = workspaceReducer(stateWithContent, {
      type: 'SET_FILE_CONTENT',
      content: null,
    });
    expect(state.fileContent).toBeNull();
  });
});

describe('workspaceReducer — file panel toggle', () => {
  it('TOGGLE_FILE_PANEL opens when closed', () => {
    const state = workspaceReducer(initialState, { type: 'TOGGLE_FILE_PANEL' });
    expect(state.isFilePanelOpen).toBe(true);
  });

  it('TOGGLE_FILE_PANEL closes when open', () => {
    const openState = { ...initialState, isFilePanelOpen: true };
    const state = workspaceReducer(openState, { type: 'TOGGLE_FILE_PANEL' });
    expect(state.isFilePanelOpen).toBe(false);
  });

  it('TOGGLE_FILE_PANEL with explicit open=true', () => {
    const state = workspaceReducer(initialState, { type: 'TOGGLE_FILE_PANEL', open: true });
    expect(state.isFilePanelOpen).toBe(true);
  });

  it('TOGGLE_FILE_PANEL with explicit open=false', () => {
    const openState = { ...initialState, isFilePanelOpen: true };
    const state = workspaceReducer(openState, { type: 'TOGGLE_FILE_PANEL', open: false });
    expect(state.isFilePanelOpen).toBe(false);
  });

  it('TOGGLE_FILE_PANEL with open=true when already open stays open', () => {
    const openState = { ...initialState, isFilePanelOpen: true };
    const state = workspaceReducer(openState, { type: 'TOGGLE_FILE_PANEL', open: true });
    expect(state.isFilePanelOpen).toBe(true);
  });
});

describe('workspaceReducer — loading state', () => {
  it('SET_LOADING_FILES sets loading to true', () => {
    const state = workspaceReducer(initialState, { type: 'SET_LOADING_FILES', loading: true });
    expect(state.isLoadingFiles).toBe(true);
  });

  it('SET_LOADING_FILES sets loading to false', () => {
    const loadingState = { ...initialState, isLoadingFiles: true };
    const state = workspaceReducer(loadingState, { type: 'SET_LOADING_FILES', loading: false });
    expect(state.isLoadingFiles).toBe(false);
  });
});

describe('workspaceReducer — changed files tracking', () => {
  it('ADD_CHANGED_FILE adds a new file path', () => {
    const state = workspaceReducer(initialState, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    expect(state.changedFiles).toHaveLength(1);
    expect(state.changedFiles[0]).toBe('src/index.ts');
  });

  it('ADD_CHANGED_FILE deduplicates same path', () => {
    let state = workspaceReducer(initialState, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    state = workspaceReducer(state, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    expect(state.changedFiles).toHaveLength(1);
  });

  it('ADD_CHANGED_FILE accumulates different paths', () => {
    let state = workspaceReducer(initialState, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    state = workspaceReducer(state, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/utils.ts',
    });
    state = workspaceReducer(state, {
      type: 'ADD_CHANGED_FILE',
      path: 'package.json',
    });
    expect(state.changedFiles).toHaveLength(3);
    expect(state.changedFiles).toContain('src/index.ts');
    expect(state.changedFiles).toContain('src/utils.ts');
    expect(state.changedFiles).toContain('package.json');
  });

  it('CLEAR_CHANGED_FILES removes all tracked files', () => {
    let state = workspaceReducer(initialState, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    state = workspaceReducer(state, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/utils.ts',
    });
    state = workspaceReducer(state, { type: 'CLEAR_CHANGED_FILES' });
    expect(state.changedFiles).toHaveLength(0);
  });

  it('ADD_CHANGED_FILE returns same state reference when duplicate', () => {
    const state = workspaceReducer(initialState, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    const sameState = workspaceReducer(state, {
      type: 'ADD_CHANGED_FILE',
      path: 'src/index.ts',
    });
    expect(sameState).toBe(state); // Same reference = no re-render
  });
});

// ─── Type Shape Tests ───────────────────────────────────────

describe('WorkspaceFileEntry type shape', () => {
  it('file entry has required fields', () => {
    const entry: WorkspaceFileEntry = {
      name: 'test.ts',
      path: 'src/test.ts',
      type: 'file',
      size: 100,
    };
    expect(entry.name).toBe('test.ts');
    expect(entry.path).toBe('src/test.ts');
    expect(entry.type).toBe('file');
    expect(entry.size).toBe(100);
    expect(entry.children).toBeUndefined();
  });

  it('directory entry has children', () => {
    const dir: WorkspaceFileEntry = {
      name: 'src',
      path: 'src',
      type: 'directory',
      children: [
        { name: 'a.ts', path: 'src/a.ts', type: 'file' },
      ],
    };
    expect(dir.type).toBe('directory');
    expect(dir.children).toHaveLength(1);
  });
});

describe('WorkspaceFileContent type shape', () => {
  it('text file content has required fields', () => {
    const content: WorkspaceFileContent = {
      path: 'src/index.ts',
      content: 'const x = 1;',
      size: 12,
      mimeType: 'text/plain',
      isBinary: false,
    };
    expect(content.isBinary).toBe(false);
    expect(content.content).toBe('const x = 1;');
  });

  it('binary file content has isBinary=true', () => {
    const content: WorkspaceFileContent = {
      path: 'image.png',
      content: '',
      size: 50000,
      mimeType: 'image/png',
      isBinary: true,
    };
    expect(content.isBinary).toBe(true);
    expect(content.mimeType).toBe('image/png');
  });
});

// ─── Integration: Full workflow simulation ──────────────────

describe('workspace workflow — full lifecycle', () => {
  it('simulates: open panel → load files → select file → load content → close', () => {
    // 1. Open panel
    let state = workspaceReducer(initialState, { type: 'TOGGLE_FILE_PANEL', open: true });
    expect(state.isFilePanelOpen).toBe(true);

    // 2. Start loading
    state = workspaceReducer(state, { type: 'SET_LOADING_FILES', loading: true });
    expect(state.isLoadingFiles).toBe(true);

    // 3. Files loaded
    state = workspaceReducer(state, { type: 'SET_WORKSPACE_FILES', files: mockFileTree });
    state = workspaceReducer(state, { type: 'SET_LOADING_FILES', loading: false });
    expect(state.workspaceFiles).toHaveLength(3);
    expect(state.isLoadingFiles).toBe(false);

    // 4. Select a file
    state = workspaceReducer(state, { type: 'SET_SELECTED_FILE', path: 'src/index.ts' });
    expect(state.selectedFilePath).toBe('src/index.ts');
    expect(state.fileContent).toBeNull(); // Content not loaded yet

    // 5. File content loaded
    state = workspaceReducer(state, { type: 'SET_FILE_CONTENT', content: mockFileContent });
    expect(state.fileContent!.content).toBe('console.log("hello");');

    // 6. Close panel
    state = workspaceReducer(state, { type: 'TOGGLE_FILE_PANEL', open: false });
    expect(state.isFilePanelOpen).toBe(false);
    // Files and selection persist when panel is closed
    expect(state.workspaceFiles).toHaveLength(3);
    expect(state.selectedFilePath).toBe('src/index.ts');
  });

  it('simulates: file_changed event → auto-open panel → track changes', () => {
    // 1. Panel is closed, file changes arrive
    let state = initialState;
    expect(state.isFilePanelOpen).toBe(false);

    // 2. file_changed event adds to changedFiles
    state = workspaceReducer(state, { type: 'ADD_CHANGED_FILE', path: 'src/new-file.ts' });
    expect(state.changedFiles).toHaveLength(1);

    // 3. Auto-open panel (simulated by ChatStore event handler)
    state = workspaceReducer(state, { type: 'TOGGLE_FILE_PANEL', open: true });
    expect(state.isFilePanelOpen).toBe(true);

    // 4. More files change
    state = workspaceReducer(state, { type: 'ADD_CHANGED_FILE', path: 'src/another.ts' });
    expect(state.changedFiles).toHaveLength(2);

    // 5. Clear changes after acknowledging
    state = workspaceReducer(state, { type: 'CLEAR_CHANGED_FILES' });
    expect(state.changedFiles).toHaveLength(0);
  });
});
