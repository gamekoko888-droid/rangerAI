/**
 * RangerAI HTTP API Client
 * 
 * Pure fetch wrapper — no tRPC, no Manus dependencies.
 * All data CRUD goes through these functions.
 * WebSocket is handled separately in useWebSocket.ts.
 */

import type {
  ChatsListResponse,
  ChatDetailResponse,
  CreateChatResponse,
  SendMessageResponse,
  LoginResponse,
  MeResponse,
  SearchResponse,
  TagsResponse,
  StatsResponse,
  Chat,
  User,
} from './types';

// ─── Configuration ───────────────────────────────────────────

function getApiBase(): string {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  return '';
}

const API_BASE = getApiBase();

// ─── Token Management ────────────────────────────────────────

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem('rangerai_token', token);
  } else {
    localStorage.removeItem('rangerai_token');
  }
}

export function getAuthToken(): string | null {
  if (authToken) return authToken;
  authToken = localStorage.getItem('rangerai_token');
  return authToken;
}

// ─── Fetch Helper ────────────────────────────────────────────

interface FetchOptions {
  method?: string;
  body?: unknown;
  timeout?: number;
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { method = 'GET', body, timeout = 30000 } = options;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
      credentials: 'include', // Send cookies
    };

    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE}${path}`, fetchOptions);

    if (!response.ok) {
      let errorData: Record<string, unknown> = { error: `HTTP ${response.status}` };
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        errorData = await response.json().catch(() => errorData);
      } else {
        // Non-JSON error (e.g. 502 HTML page from reverse proxy)
        const text = await response.text().catch(() => '');
        errorData = { error: `HTTP ${response.status}`, detail: text.slice(0, 200) };
      }
      // Auto-clear token on 401 to prevent stale auth state
      if (response.status === 401) {
        setAuthToken(null);
      }
      throw new ApiError(
        (errorData.message as string) || (errorData.error as string) || `HTTP ${response.status}`,
        response.status,
        errorData
      );
    }

    // Safe JSON parsing: check Content-Type before parsing
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      // Server returned non-JSON success response (unexpected)
      const text = await response.text().catch(() => '');
      throw new ApiError(
        `Expected JSON response but got ${contentType || 'unknown content type'}`,
        response.status,
        { raw: text.slice(0, 500) }
      );
    }

    return await response.json() as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('Request timeout, please try again later', 408);
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new ApiError('Network connection failed, please check your network', 0);
    }
    // Catch JSON parse errors (e.g. when proxy returns HTML for a JSON endpoint)
    if (err instanceof SyntaxError && err.message.includes('JSON')) {
      throw new ApiError('Server returned invalid response, please try again later', 502);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// ─── Retry Utility ──────────────────────────────────────────

interface RetryOptions {
  /** Max number of retries. Default: 3 */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseDelay?: number;
  /** Max delay cap in ms. Default: 10000 */
  maxDelay?: number;
  /** HTTP status codes that should trigger a retry. Default: [502, 503, 504, 408, 429, 0] */
  retryableStatuses?: number[];
  /** Called before each retry with attempt number */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Wrap an async function with exponential backoff retry logic.
 * Only retries on transient/retryable errors (502, 503, 504, network failures).
 * Non-retryable errors (400, 401, 403, 404, 409, 422) are thrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    retryableStatuses = [502, 503, 504, 408, 429, 0],
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry on non-retryable errors
      if (err instanceof ApiError && !retryableStatuses.includes(err.status)) {
        throw err;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) {
        throw err;
      }

      // Calculate delay with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * 0.2 * Math.random();
      const totalDelay = Math.round(delay + jitter);

      logger.warn(`[API] Retry ${attempt + 1}/${maxRetries} after ${totalDelay}ms`, err);
      onRetry?.(attempt + 1, err);

      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }
  throw lastError;
}

/**
 * Report a frontend error to the backend for logging.
 * Fire-and-forget — never throws.
 */
export function reportError(error: {
  message: string;
  stack?: string;
  component?: string;
  url?: string;
  userAgent?: string;
  extra?: Record<string, unknown>;
}): void {
  try {
    const token = getAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    fetch(`${API_BASE}/api/error-report`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...error,
        url: error.url || window.location.href,
        userAgent: error.userAgent || navigator.userAgent,
        timestamp: Date.now(),
      }),
      credentials: 'include',
    }).catch(() => { /* silently ignore reporting failures */ });
  } catch { /* silently ignore */ }
}

// ─── Auth API ───────────────────────────────────────────────

/**
 * Login with username and password.
 */
export async function login(username: string, password: string): Promise<{ user: User; token: string }> {
  const data = await apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  setAuthToken(data.token);
  return data;
}

/**
 * Get current authenticated user.
 */
export async function getMe(): Promise<{ user: User; nav: import('./types').NavConfigItem[] } | null> {
  try {
    const data = await apiFetch<MeResponse>('/api/auth/me');
    return { user: data.user, nav: data.nav || [] };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

/**
 * Logout.
 */
export async function logout(): Promise<void> {
  try {
    await apiFetch<{ success: boolean }>('/api/auth/logout', { method: 'POST' });
  } finally {
    setAuthToken(null);
  }
}

// ─── Registration API ────────────────────────────────────────

/**
 * Register a new user with invite code.
 */
export async function register(
  username: string,
  password: string,
  inviteCode: string
): Promise<{ user: User; token: string }> {
  const data = await apiFetch<LoginResponse>('/api/auth/register', {
    method: 'POST',
    body: { username, password, inviteCode },
  });
  setAuthToken(data.token);
  return data;
}

// ─── Invite Code API (Admin) ────────────────────────────────

export interface InviteCode {
  id: string;
  code: string;
  createdBy: string;
  usedBy: string | null;
  usedAt: string | null;
  maxUses: number;
  currentUses: number;
  expiresAt: string | null;
  createdAt: string;
  active: number;
  role: string;
}

/**
 * Create a new invite code (admin only).
 */
export async function createInviteCode(
  maxUses = 1,
  expiresInDays = 7,
  role = 'member'
): Promise<InviteCode> {
  return apiFetch<InviteCode>('/api/auth/invite-codes', {
    method: 'POST',
    body: { maxUses, expiresInDays, role },
  });
}

/**
 * List all invite codes (admin only).
 */
export async function getInviteCodes(): Promise<InviteCode[]> {
  const data = await apiFetch<{ codes: InviteCode[] }>('/api/auth/invite-codes');
  return data.codes;
}

/**
 * Deactivate an invite code (admin only).
 */
export async function deactivateInviteCode(codeId: string): Promise<void> {
  await apiFetch<{ success: boolean }>(`/api/auth/invite-codes/${codeId}`, {
    method: 'DELETE',
  });
}

// ─── Chat API ───────────────────────────────────────────────

/**
 * Get list of all chats, ordered by most recently updated.
 */
export async function fetchChats(limit = 100, offset = 0): Promise<Chat[]> {
  const data = await apiFetch<ChatsListResponse>(
    `/api/chats?limit=${limit}&offset=${offset}`
  );
  return data.chats;
}

/**
 * Create a new chat.
 */
export async function createChat(title?: string): Promise<Chat> {
  const data = await apiFetch<CreateChatResponse>('/api/chats', {
    method: 'POST',
    body: { title },
  });
  return data.chat;
}

/**
 * Get chat details with full message history.
 */
export async function fetchChatDetail(chatId: string): Promise<ChatDetailResponse> {
  return apiFetch<ChatDetailResponse>(`/api/chats/${chatId}`);
}

/**
 * Update chat title and/or tags.
 */
export async function updateChat(chatId: string, updates: { title?: string; tags?: string[] }): Promise<Chat> {
  const data = await apiFetch<{ chat: Chat }>(`/api/chats/${chatId}`, {
    method: 'PATCH',
    body: updates,
  });
  return data.chat;
}

/**
 * Update chat title (convenience wrapper).
 */
export async function updateChatTitle(chatId: string, title: string): Promise<Chat> {
  return updateChat(chatId, { title });
}

/**
 * Update chat tags via dedicated endpoint.
 */
export async function updateChatTags(chatId: string, tags: string[]): Promise<{ success: boolean; tags: string[] }> {
  return apiFetch<{ success: boolean; tags: string[] }>(`/api/chats/${chatId}/tags`, {
    method: 'PATCH',
    body: { tags },
  });
}

/**
 * Delete a chat.
 */
export async function deleteChat(chatId: string): Promise<void> {
  await apiFetch<{ success: boolean }>(`/api/chats/${chatId}`, {
    method: 'DELETE',
  });
}

/**
 * Batch delete multiple chats.
 */
export async function batchDeleteChats(chatIds: string[]): Promise<{ success: boolean; deleted: number }> {
  return apiFetch<{ success: boolean; deleted: number }>('/api/chats/batch-delete', {
    method: 'POST',
    body: { chatIds },
  });
}

/**
 * Regenerate an AI message (delete it and all subsequent messages, return the user message to re-send).
 */
export async function regenerateMessage(
  chatId: string,
  messageId: number
): Promise<{ success: boolean; deleted: number; userMessage: { id: number; content: string; role: string } }> {
  return apiFetch<{ success: boolean; deleted: number; userMessage: { id: number; content: string; role: string } }>(
    `/api/chats/${chatId}/regenerate/${messageId}`,
    { method: 'POST' }
  );
}

/**
 * Send a message to a chat. Returns immediately with msgId.
 * AI response will arrive via WebSocket.
 * @param model - Optional model ID to override smart routing (e.g. 'openai/gpt-5.2')
 */

export async function submitMessageFeedback(
  chatId: string,
  messageId: number,
  feedback: 'up' | 'down' | null
): Promise<{ success: boolean; metadata: Record<string, unknown> }> {
  return apiFetch(`/api/chats/${chatId}/messages/${messageId}/feedback`, {
    method: 'PATCH',
    body: { feedback },
  });
}

export async function sendMessage(
  chatId: string,
  content: string,
  metadata?: Record<string, unknown>,
  model?: string,
  attachments?: Array<{ type: string; url: string; name: string; mimeType: string; size: number }>,
  roleId?: string
): Promise<SendMessageResponse> {
  return apiFetch<SendMessageResponse>(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: {
      content,
      metadata,
      model: model && model !== 'auto' ? model : undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      roleId: roleId && roleId !== 'default' ? roleId : undefined,
    },
    timeout: 60000,
  });
}
// ─── File Upload API ─────────────────────────────────────────

export interface UploadedFile {
  name: string;
  path: string;  // e.g. /files/upload-xxx.png
  size: number;
}

/**
 * Upload files to the backend. Returns file paths for use in messages.
 * Uses multipart/form-data to the /upload endpoint.
 */
export async function uploadFiles(
  files: File[],
  onProgress?: (percent: number) => void
): Promise<UploadedFile[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file, file.name);
  }

  const token = getAuthToken();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload`);
    
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.files || []);
        } catch {
          reject(new Error('Upload response parse failed'));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || `Upload failed: HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => reject(new Error('Network error, upload failed'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.timeout = 120000; // 2 min timeout for large files
    xhr.send(formData);
  });
}

/**
 * Build the full URL for a file path returned by upload.
 */
export function getFileUrl(filePath: string): string {
  if (filePath.startsWith('http')) return filePath;
  return `${API_BASE || window.location.origin}${filePath}`;
}

// ─── Task Polling API (HTTP fallback for WS) ─────────────────

/**
 * Task state returned by GET /api/task/:id
 */
export interface TaskState {
  msgId: string;
  status: 'running' | 'completed' | 'failed';
  sessionKey: string;
  userMessage: string;
  startedAt: number;
  completedAt: number;
  events: Array<Record<string, unknown>>;
  totalEventCount: number;
  newEventCount: number;
  source: string;
  result?: string;
}

/**
 * Poll task status via HTTP. Used as fallback when WS is disconnected.
 * @param msgId - The message/task ID returned by sendMessage
 * @param sinceTs - Only return events after this timestamp (for incremental polling)
 */
export async function pollTaskStatus(
  msgId: string,
  sinceTs = 0
): Promise<TaskState | null> {
  try {
    return await apiFetch<TaskState>(
      `/api/task/${msgId}?since=${sinceTs}`,
      { timeout: 10000 }
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null; // Task not found
    }
    throw err;
  }
}

/**
 * Get session state — check if there's an active/completed task for a session.
 */
export async function getSessionStatus(
  sessionKey: string
): Promise<{ hasActiveTask: boolean; activeMsgId?: string; status?: string } | null> {
  try {
    return await apiFetch<{ hasActiveTask: boolean; activeMsgId?: string; status?: string }>(
      `/api/session/${encodeURIComponent(sessionKey)}`,
      { timeout: 10000 }
    );
  } catch {
    return null;
  }
}

// ─── Search & Tags API ────────────────────────────────────────
/**
 * Search chats by keyword.
 */
export async function searchChats(query: string): Promise<Chat[]> {
  const data = await apiFetch<SearchResponse>(
    `/api/chats/search?q=${encodeURIComponent(query)}`
  );
  return data.chats;
}

/**
 * Get chats filtered by tag.
 */
export async function getChatsByTag(tag: string): Promise<Chat[]> {
  const data = await apiFetch<SearchResponse>(
    `/api/chats/search?tag=${encodeURIComponent(tag)}`
  );
  return data.chats;
}

/**
 * Get all unique tags.
 */
export async function getAllTags(): Promise<string[]> {
  const data = await apiFetch<TagsResponse>('/api/chats/tags');
  return data.tags;
}

/**
 * Get database stats.
 */
export async function getStats(): Promise<StatsResponse> {
  return apiFetch<StatsResponse>('/api/stats');
}

/**
 * Get smart-router routing statistics.
 */
export async function getRoutingStats(): Promise<import('./types').RoutingStatsResponse> {
  return apiFetch<import('./types').RoutingStatsResponse>('/api/stats/routing');
}

// ─── Workspace API ─────────────────────────────────────────

import type { WorkspaceFileEntry, WorkspaceFileContent } from './types';

/**
 * Get workspace file tree.
 */
export async function fetchWorkspaceTree(): Promise<WorkspaceFileEntry[]> {
  const data = await apiFetch<{ tree: WorkspaceFileEntry[] }>('/api/workspace/tree');
  return data.tree;
}

/**
 * Get file content from workspace.
 */
export async function fetchWorkspaceFile(filePath: string): Promise<WorkspaceFileContent> {
  return apiFetch<WorkspaceFileContent>(
    `/api/workspace/file?path=${encodeURIComponent(filePath)}`
  );
}

/**
 * Download a workspace file (returns blob URL).
 * IMPORTANT: Caller must call URL.revokeObjectURL() after use to prevent memory leaks.
 */
export async function downloadWorkspaceFile(filePath: string): Promise<string> {
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const resp = await fetch(
    `${API_BASE}/api/workspace/file?path=${encodeURIComponent(filePath)}&raw=1`,
    { headers, credentials: 'include' }
  );
  if (!resp.ok) throw new ApiError(`Download failed: HTTP ${resp.status}`, resp.status);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

// ─── Sharing API ──────────────────────────────────────────────

import type {
  SharedChat,
  ChatShare,
  SharedWithMeResponse,
  ChatSharesResponse,
  UsersListResponse,
} from './types';
import { logger } from "./logger";

/**
 * Get all users (for share dialog).
 */
export async function fetchUsers(): Promise<User[]> {
  const data = await apiFetch<UsersListResponse>('/api/users');
  return data.users;
}

/**
 * Get chats shared with the current user.
 */
export async function fetchSharedWithMe(): Promise<SharedChat[]> {
  const data = await apiFetch<SharedWithMeResponse>('/api/chats/shared-with-me');
  return data.chats;
}

/**
 * Share a chat with another user.
 */
export async function shareChat(
  chatId: string,
  sharedWithUserId: string,
  permission: 'read' | 'write' = 'read'
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/chats/${chatId}/share`, {
    method: 'POST',
    body: { sharedWithUserId, permission },
  });
}

/**
 * Get the list of users a chat is shared with.
 */
export async function fetchChatShares(chatId: string): Promise<ChatShare[]> {
  const data = await apiFetch<ChatSharesResponse>(`/api/chats/${chatId}/shares`);
  return data.shares;
}

/**
 * Remove sharing for a specific user from a chat.
 */
export async function unshareChat(chatId: string, userId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/chats/${chatId}/share/${userId}`, {
    method: 'DELETE',
  });
}

// ─── Prompts API ──────────────────────────────────────────────

/**
 * Fetch all active quick prompts.
 */
export async function fetchPrompts(): Promise<{ prompts: Array<{
  id: string; title: string; content: string; category: string | null;
  sortOrder: number; isActive: number; usageCount: number; createdAt: string;
}> }> {
  return apiFetch<any>('/api/prompts');
}

/**
 * Increment usage count for a prompt.
 */
export async function usePrompt(promptId: string): Promise<{ id: string; usageCount: number }> {
  return apiFetch<{ id: string; usageCount: number }>(`/api/prompts/${promptId}/use`, {
    method: 'POST',
  });
}

// ─── Health Check API ───────────────────────────────────────

export interface HealthStatus {
  status: string;
  version: string;
  uptime: number;
  workerReady: boolean;
  gatewayConnected: boolean;
  gatewayLastPongAge?: number;
  gatewayReconnects?: number;
  redis: boolean;
}

/**
 * Check backend health status. Used for Gateway health polling
 * when WebSocket is disconnected.
 */
export async function fetchHealth(): Promise<HealthStatus> {
  return apiFetch<HealthStatus>('/api/health', { timeout: 8000 });
}

// ─── Provider Health API ──────────────────────────────────────

export interface ProviderStatus {
  provider: string;
  status: 'ok' | 'error' | 'no_key' | 'timeout';
  message: string;
  models: string[];
  testModel: string;
}

export interface ProviderHealthResponse {
  status: string;
  message: string;
  checkedAt: string;
  providers: ProviderStatus[];
}

/**
 * Fetch AI provider health status (OpenAI, Google, Anthropic).
 */
export async function fetchProviderHealth(): Promise<ProviderHealthResponse> {
  return apiFetch<ProviderHealthResponse>('/api/health/providers', { timeout: 15000 });
}


// ─── Skills API (stub) ─────────────────────────────────────
export interface Skill {
  name: string;
  displayName?: string;
  description?: string;
  emoji?: string;
  eligible: boolean;
  source?: string;
  homepage?: string | null;
  missing?: { bins?: string[]; env?: string[]; config?: string[] };
  label?: string;
}

export interface CircuitBreakerStatus {
  [key: string]: any;
}

export async function fetchSkills(): Promise<Skill[]> {
  try {
    return await apiFetch<Skill[]>('/api/skills');
  } catch {
    return [];
  }
}

export async function fetchCircuitBreakerStatus(): Promise<Record<string, any>> {
  try {
    return await apiFetch<Record<string, any>>('/api/admin/circuit-breaker');
  } catch {
    return {};
  }
}

export async function ratingFetch(path: string, options: FetchOptions = {}) {
  return apiFetch(path, options);
}
