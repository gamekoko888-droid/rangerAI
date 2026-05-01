/**
 * Unified Message Protocol — TypeScript Frontend Version
 * 
 * Auto-generated from shared/message-types.mjs
 * Both backend (.mjs) and frontend (.ts) share the same constants.
 * 
 * @module shared/message-types
 * @version 3.7
 */

// ═══════════════════════════════════════════════════════════════
// WS: Client → Server
// ═══════════════════════════════════════════════════════════════
export const WS_CLIENT_TYPES = {
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
} as const;

export type WsClientType = typeof WS_CLIENT_TYPES[keyof typeof WS_CLIENT_TYPES];

// ═══════════════════════════════════════════════════════════════
// WS: Server → Client
// ═══════════════════════════════════════════════════════════════
export const WS_SERVER_TYPES = {
  CONNECTED:          'connected',
  CHAT_BOUND:         'chat_bound',
  PONG:               'pong',
  SERVER_PING:        'server_ping',
  SESSION_CHANGED:    'session_changed',
  STREAM_START:       'stream_start',
  STREAM_CHUNK:       'stream_chunk',
  STREAM_END:         'stream_end',
  THINKING:           'thinking',
  TOOL_START:         'tool_start',
  TOOL_END:           'tool_end',
  TOOL_PROGRESS:      'tool_progress',
  STEP:               'step',
  STEP_UPDATE:        'step_update',
  STATUS:             'status',
  PROGRESS:           'progress',
  TITLE_UPDATE:       'title_update',
  SUGGESTIONS:        'suggestions',
  ERROR:              'error',
  RECOVERY_STATUS:    'recovery_status',
  BROWSER_ACTION:     'browser_action',
  SUBAGENT_EVENT:     'subagent_event',
  SANDBOX_RESULT:     'sandbox_result',
  SYSTEM_NOTICE:      'system_notice',
  TIMEOUT_WARNING:    'timeout_warning',
  TASK_TIMEOUT:       'task_timeout',
  CANCEL_CONFIRMED:   'cancel_confirmed',
  TASK_RECOVERY:      'task_recovery',
  ROUTING_INFO:       'routing_info',
  FILE_CHANGED:       'file_changed',
  HISTORY:            'history',
  NOTIFICATION_NEW:   'notification_new',
  GATEWAY_API_RESPONSE: 'gateway_api_response',
} as const;

export type WsServerType = typeof WS_SERVER_TYPES[keyof typeof WS_SERVER_TYPES];

// Deprecated aliases for backward compatibility
export const DEPRECATED_ALIASES: Record<string, string> = {
  'title_generated': 'title_update',
  'routing':         'routing_info',
  'tool_result':     'tool_end',
};

/**
 * Combined WsEventType — replaces the manual union in types.ts
 */
export type WsEventType = WsServerType | 'title_generated' | 'routing' | 'tool_result';

/**
 * Normalize a deprecated type to its canonical form.
 */
export function normalizeType(type: string): string {
  return DEPRECATED_ALIASES[type] || type;
}
