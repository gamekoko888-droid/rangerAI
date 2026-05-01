/**
 * IPC Schema Contracts — Main Process ↔ Worker
 * 
 * Uses Zod for runtime validation + JSDoc for editor intellisense.
 * All IPC messages MUST pass through these schemas.
 * 
 * @module lib/schemas/ipc-schemas
 */
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// DOWNLINK: Main Process → Worker
// ═══════════════════════════════════════════════════════════════

/** User message task dispatch */
export const UserMessageDownlink = z.object({
  type: z.literal("user_message"),
  id: z.string().min(1),
  sessionKey: z.string().default("default"),
  content: z.string().min(1),
  conversationHistory: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string()
  })).default([]),
  model: z.string().optional(),
  attachments: z.array(z.any()).optional(),
  roleSystemPrompt: z.string().optional()
}).passthrough();

/** User interrupt (supplementary instruction during streaming) */
export const UserInterruptDownlink = z.object({
  type: z.literal("user_interrupt"),
  content: z.string().min(1),
  sessionKey: z.string().default("default")
}).passthrough();

/** Heartbeat ping */
export const PingDownlink = z.object({
  type: z.literal("ping"),
  id: z.string()
}).passthrough();

/** Gateway API proxy request */
export const GatewayApiRequestDownlink = z.object({
  type: z.literal("gateway_api_request"),
  reqId: z.string(),
  method: z.string(),
  params: z.any()
}).passthrough();

/** Database query response (Main → Worker, Phase 1 DB decoupling) */
export const DbQueryResponseDownlink = z.object({
  type: z.literal("db_query_response"),
  reqId: z.string(),
  ok: z.boolean(),
  result: z.any().optional(),
  error: z.string().optional()
}).passthrough();

/** Graceful shutdown */
export const ShutdownDownlink = z.object({
  type: z.literal("shutdown")
}).passthrough();

/** Browser recovery trigger */
export const RecoverBrowserDownlink = z.object({
  type: z.literal("recover_browser")
}).passthrough();

/** Get browser breaker status */
export const GetBrowserStatusDownlink = z.object({
  type: z.literal("get_browser_status"),
  reqId: z.string()
}).passthrough();

/** Reset browser breaker */
export const ResetBrowserBreakerDownlink = z.object({
  type: z.literal("reset_browser_breaker"),
  reqId: z.string()
}).passthrough();

/** Cancel task (Main → Worker) */
export const CancelTaskDownlink = z.object({
  type: z.literal("cancel_task"),
  msgId: z.string()
}).passthrough();

/** Drain mode (Main → Worker) */
export const DrainDownlink = z.object({
  type: z.literal("drain")
}).passthrough();

/** Union of all downlink messages */
export const DownlinkMessage = z.discriminatedUnion("type", [
  UserMessageDownlink,
  UserInterruptDownlink,
  PingDownlink,
  GatewayApiRequestDownlink,
  DbQueryResponseDownlink,
  ShutdownDownlink,
  RecoverBrowserDownlink,
  GetBrowserStatusDownlink,
  ResetBrowserBreakerDownlink,
  CancelTaskDownlink,
  DrainDownlink
]);

// ═══════════════════════════════════════════════════════════════
// UPLINK: Worker → Main Process
// ═══════════════════════════════════════════════════════════════

/** Database query request (Worker → Main, Phase 1 DB decoupling) */
export const DbQueryUplink = z.object({
  type: z.literal("db_query"),
  reqId: z.string(),
  method: z.string(),
  args: z.array(z.any()).default([])
}).passthrough();

/** Worker ready signal */
export const WorkerReadyUplink = z.object({
  type: z.literal("worker_ready"),
  pid: z.number(),
  gatewayConnected: z.boolean()
}).passthrough();

/** Frontend event relay (step, tool_call, thinking, etc.) */
export const FrontendEventUplink = z.object({
  type: z.literal("frontend_event"),
  msgId: z.string(),
  event: z.object({
    type: z.string()
  }).passthrough()
}).passthrough();

/** Session rotation request */
export const RotateSessionUplink = z.object({
  type: z.literal("rotate_session"),
  data: z.object({
    newSessionKey: z.string()
  })
}).passthrough();

/** Auto-followup instruction from worker */
export const AutoFollowupUplink = z.object({
  type: z.literal("auto_followup"),
  sessionKey: z.string().default("default"),
  content: z.string().min(1)
}).passthrough();

/** Task completion */
export const TaskCompleteUplink = z.object({
  type: z.literal("task_complete"),
  msgId: z.string(),
  result: z.any()
}).passthrough();

/** Task error */
export const TaskErrorUplink = z.object({
  type: z.literal("task_error"),
  msgId: z.string(),
  error: z.string()
}).passthrough();

/** Heartbeat pong */
export const PongUplink = z.object({
  type: z.literal("pong"),
  id: z.string(),
  pid: z.number(),
  gatewayConnected: z.boolean()
}).passthrough();

/** Gateway API proxy response */
export const GatewayApiResponseUplink = z.object({
  type: z.literal("gateway_api_response"),
  reqId: z.string(),
  ok: z.boolean(),
  result: z.any().optional(),
  error: z.string().optional()
}).passthrough();

/** Browser breaker reset confirmation */
export const BrowserBreakerResetUplink = z.object({
  type: z.literal("browser_breaker_reset"),
  reqId: z.string(),
  ok: z.boolean()
}).passthrough();

/** Browser status response */
export const BrowserStatusUplink = z.object({
  type: z.literal("browser_status"),
  reqId: z.string(),
  status: z.any(),
  gatewayConnected: z.boolean()
}).passthrough();

/** Union of all uplink messages */
// v1.2: Announce event schemas (subagent announce-triggered agent runs)
export const AnnounceEventUplink = z.object({
  type: z.literal("announce_event"),
  runId: z.string().optional(),
  event: z.any().optional()
}).passthrough();

export const AnnounceFinalUplink = z.object({
  type: z.literal("announce_final"),
  runId: z.string().optional(),
  text: z.string().optional(),
  event: z.any().optional()
}).passthrough();

export const AnnounceCompleteUplink = z.object({
  type: z.literal("announce_complete"),
  runId: z.string().optional(),
  event: z.any().optional()
}).passthrough();

export const UplinkMessage = z.discriminatedUnion("type", [
  DbQueryUplink,
  WorkerReadyUplink,
  FrontendEventUplink,
  RotateSessionUplink,
  AutoFollowupUplink,
  TaskCompleteUplink,
  TaskErrorUplink,
  PongUplink,
  GatewayApiResponseUplink,
  BrowserBreakerResetUplink,
  BrowserStatusUplink,
  AnnounceEventUplink,
  AnnounceFinalUplink,
  AnnounceCompleteUplink
]);

// ═══════════════════════════════════════════════════════════════
// Validation Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Validate a downlink message (Main → Worker).
 * Returns { success, data, error } — never throws.
 * @param {unknown} msg
 */
export function validateDownlink(msg) {
  const result = DownlinkMessage.safeParse(msg);
  if (!result.success) {
    console.warn(`[IPC-Schema] Invalid downlink: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
  }
  return result;
}

/**
 * Validate an uplink message (Worker → Main).
 * Returns { success, data, error } — never throws.
 * @param {unknown} msg
 */
export function validateUplink(msg) {
  const result = UplinkMessage.safeParse(msg);
  if (!result.success) {
    console.warn(`[IPC-Schema] Invalid uplink: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// Schema Registry (for doc generation)
// ═══════════════════════════════════════════════════════════════
export const IPC_SCHEMA_REGISTRY = {
  downlink: {
    user_message: UserMessageDownlink,
    user_interrupt: UserInterruptDownlink,
    ping: PingDownlink,
    gateway_api_request: GatewayApiRequestDownlink,
    db_query_response: DbQueryResponseDownlink,
    shutdown: ShutdownDownlink,
    recover_browser: RecoverBrowserDownlink,
    get_browser_status: GetBrowserStatusDownlink,
    reset_browser_breaker: ResetBrowserBreakerDownlink,
    cancel_task: CancelTaskDownlink,
    drain: DrainDownlink
  },
  uplink: {
    db_query: DbQueryUplink,
    worker_ready: WorkerReadyUplink,
    frontend_event: FrontendEventUplink,
    rotate_session: RotateSessionUplink,
    auto_followup: AutoFollowupUplink,
    task_complete: TaskCompleteUplink,
    task_error: TaskErrorUplink,
    pong: PongUplink,
    gateway_api_response: GatewayApiResponseUplink,
    browser_breaker_reset: BrowserBreakerResetUplink,
    browser_status: BrowserStatusUplink
  }
};

// ═══════════════════════════════════════════════════════════════
// Re-export unified message types for convenience
// ═══════════════════════════════════════════════════════════════
export { WS_CLIENT_TYPES, WS_SERVER_TYPES, IPC_DOWNLINK_TYPES, IPC_UPLINK_TYPES, FRONTEND_EVENT_TYPES, DEPRECATED_ALIASES, normalizeType } from '#shared/message-types';
