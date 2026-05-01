import { describe, expect, it } from 'vitest';

/**
 * Tests for the ChatStore reducer logic, types, and content normalization.
 * Covers: step events, enhanced tool calls, tool_progress, tool_end, and legacy behavior.
 */

import type { ChatState, ChatAction, Message, Chat, ToolCall, ExecutionStep } from './types';
import { normalizeContent, parseMessageContent, parseTags } from './types';

// ─── Inline Reducer (mirrors useChatStore.tsx) ──────────────

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
};

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_CHATS':
      return { ...state, chats: action.chats, isLoadingChats: false };
    case 'ADD_CHAT':
      return { ...state, chats: [action.chat, ...state.chats] };
    case 'UPDATE_CHAT':
      return {
        ...state,
        chats: state.chats.map(c =>
          c.id === action.chatId ? { ...c, ...action.updates } : c
        ),
      };
    case 'REMOVE_CHAT':
      return {
        ...state,
        chats: state.chats.filter(c => c.id !== action.chatId),
        currentChatId: state.currentChatId === action.chatId ? null : state.currentChatId,
        messages: state.currentChatId === action.chatId ? [] : state.messages,
      };
    case 'SET_CURRENT_CHAT':
      return {
        ...state,
        currentChatId: action.chatId,
        messages: action.chatId === state.currentChatId ? state.messages : [],
        streamingContent: '',
        thinkingContent: '',
        activeTools: [],
        executionSteps: [],
        isStreaming: false,
        suggestions: [],
        error: null,
      };
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages, isLoadingMessages: false };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'SET_STREAMING':
      return {
        ...state,
        isStreaming: action.isStreaming,
        ...(action.isStreaming ? { streamingContent: '', thinkingContent: '', activeTools: [], executionSteps: [] } : {}),
      };
    case 'APPEND_STREAM':
      return { ...state, streamingContent: state.streamingContent + action.content };
    case 'SET_THINKING':
      return { ...state, thinkingContent: state.thinkingContent + action.content };
    case 'ADD_TOOL_CALL':
      return { ...state, activeTools: [...state.activeTools, action.tool] };
    case 'UPDATE_TOOL_CALL':
      return {
        ...state,
        activeTools: state.activeTools.map(t =>
          t.id === action.id ? { ...t, ...action.updates } : t
        ),
      };
    case 'ADD_STEP':
      return { ...state, executionSteps: [...state.executionSteps, action.step] };
    case 'UPDATE_STEP':
      return {
        ...state,
        executionSteps: state.executionSteps.map(s =>
          s.id === action.id
            ? {
                ...s,
                status: action.status,
                detail: action.detail !== undefined ? action.detail : s.detail,
                ...(action.status !== 'running' ? { completedAt: Date.now() } : {}),
              }
            : s
        ),
      };
    case 'CLEAR_STEPS':
      return { ...state, executionSteps: [] };
    case 'STREAM_END': {
      const lastMsg = state.messages[state.messages.length - 1];
      const contentToAdd = action.content;
      if (lastMsg && lastMsg.role === 'assistant') {
        const lastContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';
        if (lastContent === contentToAdd) {
          return {
            ...state,
            isStreaming: false,
            streamingContent: '',
            thinkingContent: '',
            activeTools: [],
            executionSteps: [],
            _lastStreamEndAt: Date.now(),
          };
        }
      }
      const assistantMsg: Message = {
        id: Date.now(),
        chatId: state.currentChatId || '',
        role: 'assistant',
        content: contentToAdd,
        model: action.model || null,
        tokens: null,
        msgId: null,
        createdAt: new Date().toISOString(),
        metadata: null,
      };
      return {
        ...state,
        messages: [...state.messages, assistantMsg],
        isStreaming: false,
        streamingContent: '',
        thinkingContent: '',
        activeTools: [],
        executionSteps: [],
        _lastStreamEndAt: Date.now(),
      };
    }
    case 'CLEAR_STREAMING':
      return {
        ...state,
        isStreaming: false,
        streamingContent: '',
        thinkingContent: '',
        activeTools: [],
        executionSteps: [],
      };
    case 'SET_WS_CONNECTED':
      return { ...state, wsConnected: action.connected };
    case 'SET_GATEWAY_CONNECTED':
      return { ...state, gatewayConnected: action.connected };
    case 'SET_SUGGESTIONS':
      return { ...state, suggestions: action.suggestions };
    case 'SET_LOADING_CHATS':
      return { ...state, isLoadingChats: action.loading };
    case 'SET_LOADING_MESSAGES':
      return { ...state, isLoadingMessages: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_USER':
      return { ...state, user: action.user, isAuthLoading: false };
    case 'SET_AUTH_LOADING':
      return { ...state, isAuthLoading: action.loading };
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.query };
    case 'SET_FILTER_TAG':
      return { ...state, filterTag: action.tag };
    case 'SET_ALL_TAGS':
      return { ...state, allTags: action.tags };
    case 'SET_ROUTING_INFO':
      return { ...state, currentRoutingInfo: action.info };
    case 'SAVE_MESSAGE_ROUTING':
      return {
        ...state,
        messageRoutingMap: { ...state.messageRoutingMap, [action.messageId]: action.info },
      };
    case 'SET_SELECTED_MODEL':
      return { ...state, selectedModel: action.model };
    default:
      return state;
  }
}

// ─── Mock Data ──────────────────────────────────────────────

const mockChat: Chat = {
  id: 'chat-1',
  sessionKey: 'sk-1',
  title: 'Test Chat',
  model: null,
  userId: null,
  tags: null,
  metadata: null,
  messageCount: 0,
  lastMessage: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockMessage: Message = {
  id: 1,
  chatId: 'chat-1',
  role: 'user',
  content: 'Hello',
  model: null,
  tokens: null,
  msgId: 'msg-1',
  createdAt: '2026-01-01T00:00:00Z',
  metadata: null,
};

// ─── Core Reducer Tests ─────────────────────────────────────

describe('chatReducer — core actions', () => {
  it('SET_CHATS sets chat list and clears loading', () => {
    const state = chatReducer(
      { ...initialState, isLoadingChats: true },
      { type: 'SET_CHATS', chats: [mockChat] }
    );
    expect(state.chats).toHaveLength(1);
    expect(state.isLoadingChats).toBe(false);
  });

  it('ADD_CHAT prepends new chat', () => {
    const state = chatReducer(
      { ...initialState, chats: [mockChat] },
      { type: 'ADD_CHAT', chat: { ...mockChat, id: 'chat-2' } }
    );
    expect(state.chats).toHaveLength(2);
    expect(state.chats[0].id).toBe('chat-2');
  });

  it('REMOVE_CHAT clears current if active', () => {
    const state = chatReducer(
      { ...initialState, chats: [mockChat], currentChatId: 'chat-1', messages: [mockMessage] },
      { type: 'REMOVE_CHAT', chatId: 'chat-1' }
    );
    expect(state.chats).toHaveLength(0);
    expect(state.currentChatId).toBeNull();
    expect(state.messages).toHaveLength(0);
  });

  it('SET_CURRENT_CHAT clears streaming and steps', () => {
    const state = chatReducer(
      {
        ...initialState,
        isStreaming: true,
        streamingContent: 'partial',
        executionSteps: [{ id: 'step-1', title: 'Test', status: 'running', detail: '', stepIndex: 1, startedAt: Date.now() }],
      },
      { type: 'SET_CURRENT_CHAT', chatId: 'chat-1' }
    );
    expect(state.currentChatId).toBe('chat-1');
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe('');
    expect(state.executionSteps).toHaveLength(0);
  });

  it('APPEND_STREAM accumulates content', () => {
    let state = chatReducer(initialState, { type: 'SET_STREAMING', isStreaming: true });
    state = chatReducer(state, { type: 'APPEND_STREAM', content: 'Hello' });
    state = chatReducer(state, { type: 'APPEND_STREAM', content: ' World' });
    expect(state.streamingContent).toBe('Hello World');
  });

  it('STREAM_END adds assistant message and clears all streaming state', () => {
    const state = chatReducer(
      { ...initialState, currentChatId: 'chat-1', isStreaming: true },
      { type: 'STREAM_END', content: 'Hello World', model: 'gpt-4' }
    );
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe('');
    expect(state.executionSteps).toHaveLength(0);
    expect(state.activeTools).toHaveLength(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('assistant');
    expect(state.messages[0].content).toBe('Hello World');
  });

  it('STREAM_END deduplicates when last message has same content', () => {
    const existingMsg: Message = {
      id: 1, chatId: 'chat-1', role: 'assistant', content: 'Hello World',
      model: null, tokens: null, msgId: null, createdAt: '', metadata: null,
    };
    const state = chatReducer(
      { ...initialState, currentChatId: 'chat-1', isStreaming: true, messages: [existingMsg] },
      { type: 'STREAM_END', content: 'Hello World' }
    );
    expect(state.messages).toHaveLength(1); // No duplicate added
    expect(state.isStreaming).toBe(false);
  });
});

// ─── Execution Step Tests ───────────────────────────────────

describe('chatReducer — execution steps', () => {
  it('ADD_STEP adds a new execution step', () => {
    const step: ExecutionStep = {
      id: 'step-1',
      title: '连接 AI 引擎',
      status: 'running',
      detail: 'WebSocket',
      stepIndex: 1,
      startedAt: Date.now(),
    };
    const state = chatReducer(initialState, { type: 'ADD_STEP', step });
    expect(state.executionSteps).toHaveLength(1);
    expect(state.executionSteps[0].title).toBe('连接 AI 引擎');
    expect(state.executionSteps[0].status).toBe('running');
  });

  it('UPDATE_STEP updates step status and detail', () => {
    const step: ExecutionStep = {
      id: 'step-1', title: '连接 AI 引擎', status: 'running', detail: 'WebSocket', stepIndex: 1, startedAt: Date.now(),
    };
    let state = chatReducer(initialState, { type: 'ADD_STEP', step });
    state = chatReducer(state, { type: 'UPDATE_STEP', id: 'step-1', status: 'completed', detail: '已连接' });
    expect(state.executionSteps[0].status).toBe('completed');
    expect(state.executionSteps[0].detail).toBe('已连接');
    expect(state.executionSteps[0].completedAt).toBeDefined();
  });

  it('UPDATE_STEP sets completedAt for error status', () => {
    const step: ExecutionStep = {
      id: 'step-1', title: '连接 AI 引擎', status: 'running', detail: '', stepIndex: 1, startedAt: Date.now(),
    };
    let state = chatReducer(initialState, { type: 'ADD_STEP', step });
    state = chatReducer(state, { type: 'UPDATE_STEP', id: 'step-1', status: 'error', detail: '连接失败' });
    expect(state.executionSteps[0].status).toBe('error');
    expect(state.executionSteps[0].completedAt).toBeDefined();
  });

  it('UPDATE_STEP does not set completedAt for running status', () => {
    const step: ExecutionStep = {
      id: 'step-1', title: 'AI 思考中', status: 'running', detail: '', stepIndex: 1, startedAt: Date.now(),
    };
    let state = chatReducer(initialState, { type: 'ADD_STEP', step });
    state = chatReducer(state, { type: 'UPDATE_STEP', id: 'step-1', status: 'running', detail: '正在生成回复...' });
    expect(state.executionSteps[0].status).toBe('running');
    expect(state.executionSteps[0].detail).toBe('正在生成回复...');
    expect(state.executionSteps[0].completedAt).toBeUndefined();
  });

  it('CLEAR_STEPS removes all steps', () => {
    let state = chatReducer(initialState, {
      type: 'ADD_STEP',
      step: { id: 'step-1', title: 'Test', status: 'completed', detail: '', stepIndex: 1, startedAt: Date.now() },
    });
    state = chatReducer(state, { type: 'CLEAR_STEPS' });
    expect(state.executionSteps).toHaveLength(0);
  });

  it('Multiple steps accumulate correctly', () => {
    let state = chatReducer(initialState, {
      type: 'ADD_STEP',
      step: { id: 'step-1', title: '连接 AI 引擎', status: 'running', detail: '', stepIndex: 1, startedAt: Date.now() },
    });
    state = chatReducer(state, { type: 'UPDATE_STEP', id: 'step-1', status: 'completed', detail: '已连接' });
    state = chatReducer(state, {
      type: 'ADD_STEP',
      step: { id: 'step-2', title: 'AI 思考中', status: 'running', detail: '', stepIndex: 2, startedAt: Date.now() },
    });
    state = chatReducer(state, {
      type: 'ADD_STEP',
      step: { id: 'step-3', title: '搜索: test', status: 'running', detail: '', stepIndex: 3, startedAt: Date.now() },
    });
    expect(state.executionSteps).toHaveLength(3);
    expect(state.executionSteps[0].status).toBe('completed');
    expect(state.executionSteps[1].status).toBe('running');
    expect(state.executionSteps[2].title).toBe('搜索: test');
  });

  it('SET_STREAMING clears execution steps', () => {
    let state = chatReducer(initialState, {
      type: 'ADD_STEP',
      step: { id: 'step-1', title: 'Test', status: 'running', detail: '', stepIndex: 1, startedAt: Date.now() },
    });
    state = chatReducer(state, { type: 'SET_STREAMING', isStreaming: true });
    expect(state.executionSteps).toHaveLength(0);
  });
});

// ─── Enhanced Tool Call Tests ───────────────────────────────

describe('chatReducer — enhanced tool calls', () => {
  it('ADD_TOOL_CALL adds tool with id', () => {
    const tool: ToolCall = {
      id: 'tool-123',
      tool: 'web_search',
      args: '{"query":"test"}',
      status: 'running',
      toolIndex: 1,
    };
    const state = chatReducer(initialState, { type: 'ADD_TOOL_CALL', tool });
    expect(state.activeTools).toHaveLength(1);
    expect(state.activeTools[0].id).toBe('tool-123');
    expect(state.activeTools[0].tool).toBe('web_search');
    expect(state.activeTools[0].status).toBe('running');
  });

  it('UPDATE_TOOL_CALL updates by id (tool_progress)', () => {
    const tool: ToolCall = { id: 'tool-123', tool: 'web_search', args: '', status: 'running' };
    let state = chatReducer(initialState, { type: 'ADD_TOOL_CALL', tool });
    state = chatReducer(state, {
      type: 'UPDATE_TOOL_CALL',
      id: 'tool-123',
      updates: { progress: '正在搜索...' },
    });
    expect(state.activeTools[0].progress).toBe('正在搜索...');
    expect(state.activeTools[0].status).toBe('running');
  });

  it('UPDATE_TOOL_CALL updates by id (tool_end success)', () => {
    const tool: ToolCall = { id: 'tool-123', tool: 'exec', args: '{"command":"ls"}', status: 'running' };
    let state = chatReducer(initialState, { type: 'ADD_TOOL_CALL', tool });
    state = chatReducer(state, {
      type: 'UPDATE_TOOL_CALL',
      id: 'tool-123',
      updates: { result: '{"text":"file1.txt\\nfile2.txt"}', status: 'completed', success: true },
    });
    expect(state.activeTools[0].status).toBe('completed');
    expect(state.activeTools[0].success).toBe(true);
    expect(state.activeTools[0].result).toContain('file1.txt');
  });

  it('UPDATE_TOOL_CALL updates by id (tool_end error)', () => {
    const tool: ToolCall = { id: 'tool-456', tool: 'exec', args: '', status: 'running' };
    let state = chatReducer(initialState, { type: 'ADD_TOOL_CALL', tool });
    state = chatReducer(state, {
      type: 'UPDATE_TOOL_CALL',
      id: 'tool-456',
      updates: { result: 'Command not found', status: 'error', success: false },
    });
    expect(state.activeTools[0].status).toBe('error');
    expect(state.activeTools[0].success).toBe(false);
  });

  it('UPDATE_TOOL_CALL only updates matching tool by id', () => {
    const tool1: ToolCall = { id: 'tool-1', tool: 'web_search', args: '', status: 'running' };
    const tool2: ToolCall = { id: 'tool-2', tool: 'exec', args: '', status: 'running' };
    let state = chatReducer(initialState, { type: 'ADD_TOOL_CALL', tool: tool1 });
    state = chatReducer(state, { type: 'ADD_TOOL_CALL', tool: tool2 });
    state = chatReducer(state, {
      type: 'UPDATE_TOOL_CALL',
      id: 'tool-1',
      updates: { status: 'completed', success: true, result: 'done' },
    });
    expect(state.activeTools[0].status).toBe('completed');
    expect(state.activeTools[1].status).toBe('running'); // tool-2 unchanged
  });

  it('CLEAR_STREAMING clears active tools and steps', () => {
    let state = chatReducer(initialState, {
      type: 'ADD_TOOL_CALL',
      tool: { id: 'tool-1', tool: 'search', args: '', status: 'running' },
    });
    state = chatReducer(state, {
      type: 'ADD_STEP',
      step: { id: 'step-1', title: 'Test', status: 'running', detail: '', stepIndex: 1, startedAt: Date.now() },
    });
    state = chatReducer(state, { type: 'CLEAR_STREAMING' });
    expect(state.activeTools).toHaveLength(0);
    expect(state.executionSteps).toHaveLength(0);
  });
});

// ─── Content Normalization Tests ────────────────────────────

describe('normalizeContent', () => {
  it('returns string as-is', () => {
    expect(normalizeContent('hello')).toBe('hello');
  });

  it('handles null and undefined', () => {
    expect(normalizeContent(null)).toBe('');
    expect(normalizeContent(undefined)).toBe('');
  });

  it('converts numbers and booleans', () => {
    expect(normalizeContent(42)).toBe('42');
    expect(normalizeContent(true)).toBe('true');
  });

  it('extracts text from object with content field', () => {
    expect(normalizeContent({ content: 'hello world' })).toBe('hello world');
  });

  it('extracts text from object with text field', () => {
    expect(normalizeContent({ text: 'hello world' })).toBe('hello world');
  });

  it('handles array of content parts', () => {
    const parts = [
      { text: 'Part 1' },
      { content: 'Part 2' },
      'Part 3',
    ];
    expect(normalizeContent(parts)).toBe('Part 1\nPart 2\nPart 3');
  });

  it('falls back to JSON.stringify for unknown objects', () => {
    const result = normalizeContent({ foo: 'bar' });
    expect(result).toBe('{"foo":"bar"}');
  });
});

// ─── Parse Message Content Tests ────────────────────────────

describe('parseMessageContent', () => {
  it('returns plain text when not JSON', () => {
    const result = parseMessageContent('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.attachments).toHaveLength(0);
  });

  it('parses JSON with text and attachments', () => {
    const json = JSON.stringify({
      text: 'Check this image',
      attachments: [{ type: 'image', url: 'http://example.com/img.png', name: 'img.png', mimeType: 'image/png', size: 1024 }],
    });
    const result = parseMessageContent(json);
    expect(result.text).toBe('Check this image');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe('image');
  });
});

// ─── Parse Tags Tests ───────────────────────────────────────

describe('parseTags', () => {
  it('returns empty array for null', () => {
    expect(parseTags(null)).toEqual([]);
  });

  it('parses JSON array', () => {
    expect(parseTags('["tag1","tag2"]')).toEqual(['tag1', 'tag2']);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseTags('not json')).toEqual([]);
  });
});

// ─── API Error Tests ────────────────────────────────────────

describe('ApiError', () => {
  it('creates error with status and data', async () => {
    const { ApiError } = await import('./api');
    const error = new ApiError('Not Found', 404, { detail: 'Chat not found' });
    expect(error.message).toBe('Not Found');
    expect(error.status).toBe(404);
    expect(error.data).toEqual({ detail: 'Chat not found' });
  });
});
