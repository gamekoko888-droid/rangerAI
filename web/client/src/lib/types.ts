/**
 * RangerAI Shared Types
 * Defines the data structures used across the frontend.
 */

// ─── Database Entities ───────────────────────────────────────

// ─── RBAC Types ─────────────────────────────────────────────
export interface NavConfigItem {
  key: string;
  label: string;
  icon?: string;
  path?: string;
  children?: NavConfigItem[];
  visible?: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member' | 'viewer';
  team: string | null;
  isActive?: number;
  createdAt?: string;
  lastLoginAt?: string | null;
  // RBAC fields (injected by JWT + backend)
  permissions?: string[];
  modules?: string[];
  dataScope?: 'self' | 'team' | 'all';
  navConfig?: NavConfigItem[];
}

export interface Chat {
  id: string;
  sessionKey: string;
  title: string;
  model: string | null;
  userId: string | null;
  tags: string | null;
  metadata: string | null;
  messageCount: number;
  lastMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  tokens: number | null;
  msgId: string | null;
  createdAt: string;
  metadata: string | null;
}

// ─── API Responses ───────────────────────────────────────────

export interface ChatsListResponse {
  chats: Chat[];
}

export interface ChatDetailResponse {
  chat: Chat;
  messages: Message[];
  messageCount: number;
}

export interface CreateChatResponse {
  chat: Chat;
}

export interface SendMessageResponse {
  msgId: string;
  chatId: string;
  status: 'processing';
  sessionKey: string;
}

export interface LoginResponse {
  user: User;
  token: string;
}

export interface MeResponse {
  user: User;
  nav?: NavConfigItem[];
}

export interface SearchResponse {
  chats: Chat[];
}

export interface TagsResponse {
  tags: string[];
}

export interface StatsResponse {
  chats: number;
  messages: number;
  users: number;
  dbSizeBytes: number;
  dbSizeMB: string;
  messageTrend: Array<{
    day: string;
    userMsgs: number;
    aiMsgs: number;
    total: number;
  }>;
  roleDistribution: Array<{
    role: string;
    count: number;
  }>;
  tagStats: Array<{
    tags: string;
    count: number;
  }>;
  userActivity: Array<{
    username: string;
    role: string;
    lastLoginAt: string | null;
    chatCount: number;
    messageCount: number;
  }>;
  lastActivity: string | null;
}

export interface RoutingStatsResponse {
  total: number;
  levelCounts: Record<string, number>;
  modelCounts: Record<string, number>;
  recentEntries: Array<{
    ts: string;
    level: string;
    model: string;
    msg: string;
  }>;
}

export interface SharedChat {
  id: number;
  chatId: string;
  sharedWithUserId: string;
  sharedByUserId: string;
  permission: 'read' | 'write';
  createdAt: string;
  title: string;
  updatedAt: string;
  tags: string | null;
  model: string | null;
  sharedByUsername: string;
  sharedByDisplayName: string;
}

export interface ChatShare {
  id: number;
  chatId: string;
  sharedWithUserId: string;
  sharedByUserId: string;
  permission: 'read' | 'write';
  createdAt: string;
  username: string;
  displayName: string;
}

export interface SharedWithMeResponse {
  chats: SharedChat[];
}

export interface ChatSharesResponse {
  shares: ChatShare[];
}

export interface UsersListResponse {
  users: User[];
}

// ─── WebSocket Events (server → client) ──────────────────────

export type WsEventType =
  | 'connected'
  | 'chat_bound'
  | 'stream_start'
  | 'stream_chunk'
  | 'thinking'
  | 'progress_update'
  | 'tool_start'
  | 'tool_result'
  | 'tool_end'
  | 'tool_progress'
  | 'stream_end'
  | 'status'
  | 'title_generated'
  | 'title_update'
  | 'suggestions'
  | 'error'
  | 'pong'
  | 'server_ping'
  | 'session_changed'
  | 'progress'
  | 'history'
  | 'recovery_status'
  | 'system_notice'
  | 'routing_info'
  | 'routing'
  | 'step'
  | 'step_update'
  | 'timeout_warning'
  | 'task_timeout'
  | 'file_changed'
  | 'notification_new'
  | 'cancel_confirmed'
  | 'task_recovery'
  | 'browser_action'
  | 'subagent_event'
  | 'message_done'
  | 'clear_error'
  | 'stats'
  | 'tool:confirm_required'
  | 'plan_created'
  | 'plan_phase_update'
  | 'plan_completed'
  | 'plan_progress'
  | 'supervisor_progress'
  | 'announce_message'
  | 'notify'
  | 'long_running_notify' // Iter-AG/AH
  | 'internal' // R71: backend internal directives (governance review, retry hints)
  | 'progress_update'; // v6.3: streaming progress indicator from backend

export interface WsEvent {
  type: WsEventType;
  [key: string]: unknown;
}

export interface WsConnectedEvent extends WsEvent {
  type: 'connected';
  gatewayConnected: boolean;
  capabilities: Record<string, unknown>;
  skills: unknown[];
  tools: unknown[];
}

export interface WsStreamChunkEvent extends WsEvent {
  type: 'stream_chunk';
  msgId: string;
  content: string;
}

export interface WsThinkingEvent extends WsEvent {
  type: 'thinking';
  content: string;
  msgId?: string;
}

export interface WsToolStartEvent extends WsEvent {
  type: 'tool_start';
  msgId: string;
  tool: string;
  args: string;
}

export interface WsToolResultEvent extends WsEvent {
  type: 'tool_result';
  msgId: string;
  tool: string;
  result: string;
}

export interface WsStreamEndEvent extends WsEvent {
  type: 'stream_end';
  msgId: string;
  content: string;
  model?: string;
}

export interface WsStatusEvent extends WsEvent {
  type: 'status';
  status: 'idle' | 'processing';
}

export interface WsTitleEvent extends WsEvent {
  type: 'title_generated' | 'title_update';
  chatId?: string;
  title: string;
  sessionKey?: string;
}

export interface WsSuggestionsEvent extends WsEvent {
  type: 'suggestions';
  suggestions: string[];
}

export interface WsErrorEvent extends WsEvent {
  type: 'error';
  message: string;
}

export interface WsRoutingInfoEvent extends WsEvent {
  type: 'routing_info' | 'routing';
  taskType: string;
  thinking: string;
  confidence?: number;
  fallbackModel?: string;
  description?: string;
}

export interface RoutingInfo {
  taskType: string;
  thinking: string;
  confidence: number;
  model: string | null;
  provider: string | null;
}

// ─── Execution Steps (from OpenClaw step/step_update events) ─

export type StepStatus = 'running' | 'completed' | 'error';

export interface ExecutionStep {
  id: string;           // e.g. "step-1"
  title: string;        // e.g. "连接 AI 引擎"
  status: StepStatus;
  detail: string;       // e.g. "WebSocket" or "已连接"
  stepIndex: number;
  startedAt: number;    // timestamp
  completedAt?: number; // timestamp when completed/error
}

// ─── Enhanced Tool Call (with progress + end support) ────────

export interface ToolCall {
  id: string;           // toolCallId from backend
  tool: string;         // tool name e.g. "web_search"
  args: string;         // serialized args
  result?: string;      // serialized result
  status: 'running' | 'completed' | 'error';
  success?: boolean;    // from tool_end
  progress?: string;    // partial result from tool_progress (latest line)
  progressHistory?: string[];  // accumulated progress lines for exec terminal streaming
  toolIndex?: number;   // tool call order
  screenshot?: string;  // browser screenshot URL
  skill?: string;       // detected skill name e.g. "security-scan"
  skillLabel?: string;  // Chinese label e.g. "安全扫描"
  skillCategory?: string; // category e.g. "安全"
  description?: string;   // v24.1: Chinese description from backend tool-description.mjs
  title?: string;         // optional title from backend
  startedAt?: number;     // timestamp when tool started
  completedAt?: number;   // timestamp when tool completed
  duration?: number;      // elapsed ms from backend tool_end
}

// ─── Content Normalization ──────────────────────────────────

/**
 * Normalize message content to a string.
 * OpenClaw Gateway sometimes returns content as an object:
 *   { content: "text", file_path: "/path/to/file" }
 * or as an array of content parts.
 * This function ensures we always get a plain string.
 */
export function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (typeof p.content === 'string') return p.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    try { return JSON.stringify(content); } catch { return '[无法显示的内容]'; }
  }
  return String(content);
}

// ─── Workspace File Types ───────────────────────────────────

export interface WorkspaceFileEntry {
  name: string;
  path: string;        // relative path from workspace root
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
  children?: WorkspaceFileEntry[];
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  size: number;
  mimeType: string;
  isBinary: boolean;
}

// ─── Attachment Types ────────────────────────────────────────

export interface Attachment {
  type: 'image' | 'file';
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Parsed message content that may include attachments */
export interface ParsedMessageContent {
  text: string;
  attachments: Attachment[];
}

/**
 * Parse message content which may be JSON with attachments.
 * Backend stores user messages with attachments as:
 *   { text: "user text", attachments: [...] }
 */
export function parseMessageContent(content: string): ParsedMessageContent {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string' && Array.isArray(parsed.attachments)) {
      return { text: parsed.text, attachments: parsed.attachments };
    }
  } catch {
    // Not JSON, treat as plain text
  }
  return { text: content, attachments: [] };
}

// ─── Tag Helpers ─────────────────────────────────────────────

/**
 * Parse tags from the JSON string stored in the database.
 */
export function parseTags(tagsStr: string | null): string[] {
  if (!tagsStr) return [];
  try {
    const parsed = JSON.parse(tagsStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Chat Store State ────────────────────────────────────────

export interface ChatState {
  chats: Chat[];
  currentChatId: string | null;
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  thinkingContent: string;
  activeTools: ToolCall[];
  executionSteps: ExecutionStep[];
  wsConnected: boolean;
  wsReconnecting: boolean;
  wsReconnectAttempt: number;
  gatewayConnected: boolean;
  suggestions: string[];
  isLoadingChats: boolean;
  isLoadingMessages: boolean;
  error: string | null;
  // Auth
  user: User | null;
  isAuthLoading: boolean;
  // Search & filter
  searchQuery: string;
  filterTag: string | null;
  allTags: string[];
  // Routing info
  currentRoutingInfo: RoutingInfo | null;
  messageRoutingMap: Record<number, RoutingInfo>;
  // Model selection
  selectedModel: string;
  selectedRole: string;
  // Internal: dedup tracking
  _lastStreamEndAt: number;
  // Workspace files
  workspaceFiles: WorkspaceFileEntry[];
  selectedFilePath: string | null;
  fileContent: WorkspaceFileContent | null;
  isFilePanelOpen: boolean;
  isLoadingFiles: boolean;
  changedFiles: string[];  // files changed during current session
  // AI capabilities (from connected event)
  aiSkills: Array<{ name: string; displayName?: string; label?: string; description?: string; emoji?: string; eligible: boolean; source?: string; homepage?: string | null }>;
  aiTools: string[];
  aiCapabilities: string[];
}

export type ChatAction =
  | { type: 'SET_CHATS'; chats: Chat[] }
  | { type: 'ADD_CHAT'; chat: Chat }
  | { type: 'UPDATE_CHAT'; chatId: string; updates: Partial<Chat> }
  | { type: 'REMOVE_CHAT'; chatId: string }
  | { type: 'SET_CURRENT_CHAT'; chatId: string | null }
  | { type: 'SET_MESSAGES'; messages: Message[] }
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'SET_STREAMING'; isStreaming: boolean }
  | { type: 'APPEND_STREAM'; content: string }
  | { type: 'SET_THINKING'; content: string }
  | { type: 'ADD_TOOL_CALL'; tool: ToolCall }
  | { type: 'UPDATE_TOOL_CALL'; id: string; updates: Partial<ToolCall> }
  | { type: 'STREAM_END'; content: string; model?: string }
  | { type: 'SET_WS_CONNECTED'; connected: boolean }
  | { type: 'SET_WS_RECONNECTING'; reconnecting: boolean; attempt: number }
  | { type: 'SET_GATEWAY_CONNECTED'; connected: boolean }
  | { type: 'SET_SUGGESTIONS'; suggestions: string[] }
  | { type: 'SET_LOADING_CHATS'; loading: boolean }
  | { type: 'SET_LOADING_MESSAGES'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'CLEAR_STREAMING' }
  | { type: 'SET_USER'; user: User | null }
  | { type: 'SET_AUTH_LOADING'; loading: boolean }
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'SET_FILTER_TAG'; tag: string | null }
  | { type: 'SET_ALL_TAGS'; tags: string[] }
  | { type: 'SET_ROUTING_INFO'; info: RoutingInfo }
  | { type: 'SAVE_MESSAGE_ROUTING'; messageId: number; info: RoutingInfo }
  | { type: 'SET_SELECTED_MODEL'; model: string }
  | { type: 'SET_SELECTED_ROLE'; roleId: string }
  | { type: 'ADD_STEP'; step: ExecutionStep }
  | { type: 'UPDATE_STEP'; id: string; status: StepStatus; detail?: string }
  | { type: 'CLEAR_STEPS' }
  | { type: 'SET_WORKSPACE_FILES'; files: WorkspaceFileEntry[] }
  | { type: 'SET_SELECTED_FILE'; path: string | null }
  | { type: 'SET_FILE_CONTENT'; content: WorkspaceFileContent | null }
  | { type: 'TOGGLE_FILE_PANEL'; open?: boolean }
  | { type: 'SET_LOADING_FILES'; loading: boolean }
  | { type: 'ADD_CHANGED_FILE'; path: string }
  | { type: 'CLEAR_CHANGED_FILES' }
  | { type: 'SET_AI_CAPABILITIES'; skills: ChatState['aiSkills']; tools: string[]; capabilities: string[] };
