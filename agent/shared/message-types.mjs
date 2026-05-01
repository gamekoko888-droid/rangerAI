/**
 * Unified Message Protocol — Single Source of Truth
 * 
 * All WebSocket and IPC message types are defined here.
 * Both backend and frontend should import from this module.
 * 
 * @module shared/message-types
 * @version 3.7
 */

// ═══════════════════════════════════════════════════════════════
// WS: Client → Server (Frontend sends to Backend)
// ═══════════════════════════════════════════════════════════════
export const WS_CLIENT_TYPES = Object.freeze({
  MESSAGE:        'message',
  BIND_CHAT:      'bind_chat',
  SET_SESSION:    'set_session',
  PING:           'ping',
  USER_INTERRUPT: 'user_interrupt',
  CANCEL:         'cancel',
  ABORT_TASK:     'abort_task',
  FORCE_RESET:    'force_reset',
  RECOVER_TASK:   'recover_task',
  GATEWAY_API:    'gateway_api',
  STATUS_UPDATE:  'status_update',
});

// ═══════════════════════════════════════════════════════════════
// WS: Server → Client (Backend sends to Frontend)
// ═══════════════════════════════════════════════════════════════
export const WS_SERVER_TYPES = Object.freeze({
  // Connection lifecycle
  CONNECTED:          'connected',
  CHAT_BOUND:         'chat_bound',
  PONG:               'pong',
  SERVER_PING:        'server_ping',
  SESSION_CHANGED:    'session_changed',

  // Streaming lifecycle
  STREAM_START:       'stream_start',
  STREAM_CHUNK:       'stream_chunk',
  STREAM_END:         'stream_end',

  // AI reasoning
  THINKING:           'thinking',

  // Tool execution
  TOOL_START:         'tool_start',
  TOOL_END:           'tool_end',
  TOOL_PROGRESS:      'tool_progress',

  // Step tracking
  STEP:               'step',
  STEP_UPDATE:        'step_update',

  // Status & progress
  STATUS:             'status',
  PROGRESS:           'progress',

  // Chat metadata
  TITLE_UPDATE:       'title_update',
  SUGGESTIONS:        'suggestions',

  // Errors & recovery
  ERROR:              'error',
  RECOVERY_STATUS:    'recovery_status',
  SYSTEM_NOTICE:      'system_notice',
  TIMEOUT_WARNING:    'timeout_warning',
  TASK_TIMEOUT:       'task_timeout',
  CANCEL_CONFIRMED:   'cancel_confirmed',
  TASK_RECOVERY:      'task_recovery',

  // Routing info
  ROUTING_INFO:       'routing_info',

  // File system
  FILE_CHANGED:       'file_changed',

  // History
  HISTORY:            'history',

  // Notifications
  NOTIFICATION_NEW:   'notification_new',

  // Gateway API proxy
  GATEWAY_API_RESPONSE: 'gateway_api_response',
});

// ═══════════════════════════════════════════════════════════════
// IPC: Main Process → Worker (Downlink)
// ═══════════════════════════════════════════════════════════════
export const IPC_DOWNLINK_TYPES = Object.freeze({
  USER_MESSAGE:         'user_message',
  USER_INTERRUPT:       'user_interrupt',
  PING:                 'ping',
  GATEWAY_API_REQUEST:  'gateway_api_request',
  DB_QUERY_RESPONSE:    'db_query_response',
  SHUTDOWN:             'shutdown',
  RECOVER_BROWSER:      'recover_browser',
  GET_BROWSER_STATUS:   'get_browser_status',
  RESET_BROWSER_BREAKER:'reset_browser_breaker',
});

// ═══════════════════════════════════════════════════════════════
// IPC: Worker → Main Process (Uplink)
// ═══════════════════════════════════════════════════════════════
export const IPC_UPLINK_TYPES = Object.freeze({
  DB_QUERY:             'db_query',
  WORKER_READY:         'worker_ready',
  FRONTEND_EVENT:       'frontend_event',
  ROTATE_SESSION:       'rotate_session',
  AUTO_FOLLOWUP:        'auto_followup',
  TASK_COMPLETE:        'task_complete',
  TASK_ERROR:           'task_error',
  PONG:                 'pong',
  GATEWAY_API_RESPONSE: 'gateway_api_response',
  BROWSER_BREAKER_RESET:'browser_breaker_reset',
  BROWSER_STATUS:       'browser_status',
});

// ═══════════════════════════════════════════════════════════════
// Frontend Event Types (Worker → Main → Frontend via IPC relay)
// These are the event.type values inside frontend_event IPC messages
// ═══════════════════════════════════════════════════════════════
export const FRONTEND_EVENT_TYPES = Object.freeze({
  STREAM_START:    'stream_start',
  STREAM_CHUNK:    'stream_chunk',
  STREAM_END:      'stream_end',
  THINKING:        'thinking',
  TOOL_START:      'tool_start',
  TOOL_END:        'tool_end',
  TOOL_PROGRESS:   'tool_progress',
  STEP:            'step',
  STEP_UPDATE:     'step_update',
  STATUS:          'status',
  PROGRESS:        'progress',
  FILE_CHANGED:    'file_changed',
  MESSAGE_DONE:    'message_done',
  STATS:           'stats',
});

// ═══════════════════════════════════════════════════════════════
// Deprecated aliases — kept for backward compatibility
// Will be removed in v4.0
// ═══════════════════════════════════════════════════════════════
export const DEPRECATED_ALIASES = Object.freeze({
  'title_generated': 'title_update',    // Use title_update
  'routing':         'routing_info',     // Use routing_info
  'tool_result':     'tool_end',         // Use tool_end
});

// ═══════════════════════════════════════════════════════════════
// Validation helpers
// ═══════════════════════════════════════════════════════════════

const ALL_WS_CLIENT = new Set(Object.values(WS_CLIENT_TYPES));
const ALL_WS_SERVER = new Set(Object.values(WS_SERVER_TYPES));
const ALL_IPC_DOWN  = new Set(Object.values(IPC_DOWNLINK_TYPES));
const ALL_IPC_UP    = new Set(Object.values(IPC_UPLINK_TYPES));
const ALL_DEPRECATED = new Set(Object.keys(DEPRECATED_ALIASES));

/**
 * Check if a WS client message type is valid.
 * @param {string} type
 * @returns {boolean}
 */
export function isValidClientType(type) {
  return ALL_WS_CLIENT.has(type);
}

/**
 * Check if a WS server event type is valid.
 * @param {string} type
 * @returns {boolean}
 */
export function isValidServerType(type) {
  return ALL_WS_SERVER.has(type) || ALL_DEPRECATED.has(type);
}

/**
 * Normalize a deprecated type to its canonical form.
 * @param {string} type
 * @returns {string}
 */
export function normalizeType(type) {
  return DEPRECATED_ALIASES[type] || type;
}

/**
 * Get all valid WS server event type strings (for TypeScript generation).
 * @returns {string[]}
 */
export function getAllServerTypes() {
  return [...ALL_WS_SERVER];
}

/**
 * Get all valid WS client message type strings.
 * @returns {string[]}
 */
export function getAllClientTypes() {
  return [...ALL_WS_CLIENT];
}
