/**
 * HTTP API Schema Contracts
 * 
 * Zod schemas for request body validation on all write endpoints.
 * Read endpoints (GET) are not validated as they have no body.
 * 
 * Usage: import { validateBody } from "../lib/schemas/http-schemas.mjs";
 *        const { data, error } = validateBody("auth.login", body);
 *        if (error) return sendJson(res, 400, { error });
 * 
 * @module lib/schemas/http-schemas
 */
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// Auth Schemas
// ═══════════════════════════════════════════════════════════════

export const AuthLoginBody = z.object({
  username: z.string().min(1, "用户名不能为空"),
  password: z.string().min(1, "密码不能为空")
});

export const AuthRegisterBody = z.object({
  username: z.string().min(1, "用户名不能为空").max(50),
  password: z.string().min(6, "密码至少6位"),
  inviteCode: z.string().min(1, "邀请码不能为空")
});

// ═══════════════════════════════════════════════════════════════
// Chat Schemas
// ═══════════════════════════════════════════════════════════════

export const ChatCreateBody = z.object({
  title: z.string().max(200).optional().default("新对话"),
  model: z.string().max(100).nullable().optional().default(null)
});

export const ChatUpdateTagsBody = z.object({
  tags: z.array(z.string().max(50)).max(20)
});

export const ChatSendMessageBody = z.object({
  content: z.string().min(1, "消息内容不能为空"),
  model: z.string().max(100).optional(),
  attachments: z.array(z.object({
    name: z.string(),
    url: z.string(),
    type: z.string().optional(),
    size: z.number().optional()
  })).optional(),
  roleSystemPrompt: z.string().optional()
});

export const ChatBatchDeleteBody = z.object({
  chatIds: z.array(z.string().uuid()).min(1, "至少选择一个对话")
});

// ═══════════════════════════════════════════════════════════════
// Ticket Schemas
// ═══════════════════════════════════════════════════════════════

export const TicketCreateBody = z.object({
  title: z.string().min(1, "标题不能为空").max(200),
  description: z.string().max(5000).optional().default(""),
  category: z.string().max(50).optional().default("general"),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional().default("medium"),
  customer_name: z.string().max(100).optional().default(""),
  customer_email: z.string().max(200).optional().default(""),
  customer_platform: z.string().max(50).optional().default(""),
  created_by: z.string().max(100).optional().default("system"),
  assigned_to: z.string().max(100).optional()
});

export const TicketUpdateBody = z.object({
  status: z.enum(["open", "in_progress", "pending", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  category: z.string().max(50).optional(),
  assigned_to: z.string().max(100).nullable().optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional()
}).refine(data => Object.keys(data).length > 0, { message: "至少提供一个更新字段" });

export const TicketCommentBody = z.object({
  author: z.string().max(100).optional().default("system"),
  content: z.string().min(1, "评论内容不能为空").max(5000),
  is_internal: z.boolean().optional().default(false)
});

// ═══════════════════════════════════════════════════════════════
// KOL Schemas
// ═══════════════════════════════════════════════════════════════

export const KolRuleCreateBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(""),
  category: z.string().max(50).optional().default("default"),
  priority: z.string().max(20).optional().default("all"),
  assignee: z.string().max(100).optional().default(""),
  assignee_name: z.string().max(100).optional().default(""),
  is_active: z.boolean().optional().default(true)
});

// ═══════════════════════════════════════════════════════════════
// Workflow Schemas
// ═══════════════════════════════════════════════════════════════

export const WorkflowCreateBody = z.object({
  name: z.string().min(1, "名称不能为空").max(200),
  description: z.string().max(2000).optional().default(""),
  cron_expression: z.string().max(100).optional(),
  is_active: z.boolean().optional().default(true),
  config: z.any().optional()
});

export const WorkflowUpdateBody = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  cron_expression: z.string().max(100).optional(),
  is_active: z.boolean().optional(),
  config: z.any().optional()
}).refine(data => Object.keys(data).length > 0, { message: "至少提供一个更新字段" });

// ═══════════════════════════════════════════════════════════════
// User Management Schemas
// ═══════════════════════════════════════════════════════════════

export const InviteCodeCreateBody = z.object({
  maxUses: z.number().int().min(1).max(1000).optional().default(1),
  expiresInDays: z.number().int().min(1).max(365).optional().default(7)
});

export const UserUpdateBody = z.object({
  role: z.enum(["admin", "user"]).optional(),
  is_active: z.boolean().optional(),
  display_name: z.string().max(100).optional()
}).refine(data => Object.keys(data).length > 0, { message: "至少提供一个更新字段" });

// ═══════════════════════════════════════════════════════════════
// Knowledge Schemas
// ═══════════════════════════════════════════════════════════════

export const KnowledgeCreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  category: z.string().max(50).optional().default("general"),
  tags: z.array(z.string().max(50)).optional().default([])
});

// ═══════════════════════════════════════════════════════════════
// System Config Schemas
// ═══════════════════════════════════════════════════════════════

export const SystemConfigUpdateBody = z.object({
  key: z.string().min(1).max(100),
  value: z.any()
});

export const AiRoleCreateBody = z.object({
  name: z.string().min(1, "角色名不能为空").max(100),
  system_prompt: z.string().min(1, "系统提示不能为空"),
  description: z.string().max(500).optional().default(""),
  is_default: z.boolean().optional().default(false)
});

// ═══════════════════════════════════════════════════════════════
// Schema Registry & Validation Helper
// ═══════════════════════════════════════════════════════════════

export const HTTP_SCHEMA_REGISTRY = {
  "auth.login": AuthLoginBody,
  "auth.register": AuthRegisterBody,
  "chat.create": ChatCreateBody,
  "chat.updateTags": ChatUpdateTagsBody,
  "chat.sendMessage": ChatSendMessageBody,
  "chat.batchDelete": ChatBatchDeleteBody,
  "ticket.create": TicketCreateBody,
  "ticket.update": TicketUpdateBody,
  "ticket.comment": TicketCommentBody,
  "kol.createRule": KolRuleCreateBody,
  "workflow.create": WorkflowCreateBody,
  "workflow.update": WorkflowUpdateBody,
  "invite.create": InviteCodeCreateBody,
  "user.update": UserUpdateBody,
  "knowledge.create": KnowledgeCreateBody,
  "config.update": SystemConfigUpdateBody,
  "aiRole.create": AiRoleCreateBody
};

/**
 * Validate a request body against a named schema.
 * Returns { data, error } — never throws.
 * 
 * @param {string} schemaName - Key from HTTP_SCHEMA_REGISTRY
 * @param {unknown} body - Request body to validate
 * @returns {{ data?: any, error?: string }}
 */
export function validateBody(schemaName, body) {
  const schema = HTTP_SCHEMA_REGISTRY[schemaName];
  if (!schema) {
    console.warn(`[HTTP-Schema] Unknown schema: ${schemaName}`);
    return { data: body }; // pass-through for unknown schemas
  }
  const result = schema.safeParse(body);
  if (result.success) {
    return { data: result.data };
  }
  const errorMsg = result.error.issues
    .map(i => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('; ');
  return { error: errorMsg };
}

/**
 * Express-style middleware factory.
 * Usage: app.post("/api/foo", schemaMiddleware("foo.create"), handler)
 * 
 * @param {string} schemaName
 * @returns {Function} middleware
 */
export function schemaMiddleware(schemaName) {
  return (req, res, next) => {
    const { data, error } = validateBody(schemaName, req.body);
    if (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error, schema: schemaName }));
      return;
    }
    req.validatedBody = data;
    next();
  };
}
