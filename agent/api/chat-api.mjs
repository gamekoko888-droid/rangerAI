/**
 * api/chat-api.mjs — Thin routing layer for chat REST endpoints.
 * 
 * v3.0.0: Business logic extracted to ChatOrchestrator (services/chat-service.mjs).
 * This file is now a pure route dispatcher — each handler ≤15 lines.
 *
 * Routes handled:
 *   GET    /api/chats
 *   POST   /api/chats
 *   GET    /api/chats/search
 *   GET    /api/chats/tags
 *   GET    /api/chats/by-tag/:tag
 *   GET    /api/chats/shared-with-me
 *   GET    /api/chats/stats
 *   POST   /api/chats/batch-delete
 *   GET    /api/chats/:id
 *   PATCH  /api/chats/:id
 *   DELETE /api/chats/:id
 *   PATCH  /api/chats/:id/tags
 *   POST   /api/chats/:id/messages
 *   POST   /api/chats/:id/share
 *   GET    /api/chats/:id/shares
 *   DELETE /api/chats/:id/share/:userId
 *   POST   /api/chats/:id/regenerate/:messageId
 *   GET    /api/users
 *
 * @module api/chat-api
 * @version 3.0.0
 */

import { logger } from '../lib/logger.mjs';
import { validateDeps } from '../lib/context.mjs';

const REQUIRED_DEPS = ['db', 'orchestrator', 'wsClients', 'activeTasksBySession', 'eventBuffer', 'taskStore'];

/** @type {object} */
let deps = {};

/**
 * Initialize chat-api with injected dependencies.
 * @param {object} dependencies
 * @param {object} dependencies.db - Database operations
 * @param {import('../services/chat-service.mjs').ChatOrchestrator} dependencies.orchestrator - Business logic orchestrator
 * @param {Map} dependencies.wsClients - WebSocket clients map
 * @param {Map} dependencies.activeTasksBySession - Active tasks map
 * @param {object} dependencies.eventBuffer - Event buffer
 * @param {object} dependencies.taskStore - Task store
 */
import { checkTokenBudget, getUserBudgetInfo } from "../token-budget.mjs";

export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'chat-api');
  deps = dependencies;
  logger.info('[chat-api] Initialized (v3.0.0 — thin router + ChatOrchestrator)');
}

// ─── Helpers ────────────────────────────────────────────────
const json = (res, status, data) => deps.db.sendJson(res, status, data);
const parseBody = (req) => deps.db.parseJsonBody(req);
const getUser = (req) => deps.db.extractUserFromRequest(req);
const ts = () => new Date().toISOString();

function requireAuth(currentUser, res) {
  if (!currentUser) { json(res, 401, { error: 'Authentication required' }); return false; }
  return true;
}

/**
 * Handle all /api/chats/* and /api/users routes.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true if handled
 */
export async function handleChatApi(req, res) {
  const { db, orchestrator } = deps;
  const urlPath = req.url.split('?')[0];
  const method = req.method;
  const currentUser = await getUser(req);

  try {

    // ─── R32-T1: POST /api/chat/send — Admin-only agent loop trigger ───
    if (urlPath === '/api/chat/send' && method === 'POST') {
      // Admin token auth (bypass JWT)
      const authHeader = req.headers.authorization;
      const adminToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
      const expectedToken = process.env.ADMIN_TOKEN || process.env.RANGERAI_ADMIN_TOKEN || '';
      
      // Also check persisted token file
      let persistedToken = '';
      try {
        const fs = await import('fs');
        persistedToken = fs.readFileSync('/opt/rangerai-agent/.admin-token', 'utf8').trim();
      } catch {}
      
      if (!adminToken || (adminToken !== expectedToken && adminToken !== persistedToken)) {
        return json(res, 401, { error: 'Valid Bearer admin token required' }), true;
      }
      
      const body = await parseBody(req);
      if (!body.message || typeof body.message !== 'string') {
        return json(res, 400, { error: 'message field is required (string)' }), true;
      }
      
      logger.info(`[R32-T1] POST /api/chat/send: "${body.message.slice(0, 80)}..."`);
      
      // Step 1: Create or reuse chat
      let chat;
      if (body.chatId) {
        chat = await db.getChatById(body.chatId);
        if (!chat) return json(res, 404, { error: 'Chat not found' }), true;
      } else {
        chat = await db.createChat({
          title: body.message.slice(0, 50),
          userId: body.userId || null,
        });
      }
      
      // Step 2: Validate content
      // Inline validation (no orchestrator dependency)
      const processedContent = body.message.trim();
      const attachments = body.attachments || [];
      if (!processedContent) return json(res, 400, { error: 'Empty message' }), true;
      
      // Step 3: Rate limit check (skip for admin trigger)
      // const rateCheck = orchestrator.checkRateAndActiveTask(chat.sessionKey);
      // if (!rateCheck.ok) return json(res, rateCheck.status, { error: rateCheck.error }), true;
      
      // Step 4: Generate message ID & save user message
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await db.createMessage({ chatId: chat.id, role: 'user', content: body.message, msgId });
      
      // Step 5: Get history
      const history = await db.getConversationHistory(chat.id, 50);
      
      // Step 6: Track active task
      deps.activeTasksBySession.set(chat.sessionKey, { msgId, startedAt: Date.now() });
      deps.eventBuffer.startTask(msgId, chat.sessionKey, body.message);
      deps.taskStore.startTask(msgId, chat.sessionKey, body.message).catch(e => logger.debug('[R32-T1] startTask failed:', e.message));
      
      // Step 7: Return 202 immediately
      json(res, 202, { msgId, chatId: chat.id, sessionKey: chat.sessionKey, status: 'dispatched' });
      
      // Step 8: Delegate async pipeline to orchestrator
      const traceId = `r32-${Date.now()}`;
      orchestrator.executeMessagePipeline({
        chatId: chat.id, msgId, chat,
        processedContent: processedContent,
        rawContent: body.message,
        history, attachments: attachments, body: { content: body.message },
        traceId,
        userId: body.userId || null,
        userRole: 'admin',
      });
      
      logger.info(`[R32-T1] Agent loop dispatched: msgId=${msgId}, chatId=${chat.id}`);
      return true;
    }

    // ─── GET /api/chats ───
    if (urlPath === '/api/chats' && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = Math.min(parseInt(params.get('limit') || '50'), 500);
      const offset = parseInt(params.get('offset') || '0');
      const chats = await db.getChats(limit, offset, currentUser.id);
      return json(res, 200, { chats }), true;
    }

    // ─── POST /api/chats ───
    if (urlPath === '/api/chats' && method === 'POST') {
      if (!requireAuth(currentUser, res)) return true;
      const body = await parseBody(req);
      const chat = await db.createChat({
        title: body.title || '新对话',
        model: body.model || null,
        userId: currentUser.id,
      });
      logger.info(`[${ts()}] [chat-api] Created chat: ${chat.id} (user: ${currentUser?.username || 'anonymous'})`);
      return json(res, 201, { chat }), true;
    }

    // ─── GET /api/chats/search ───
    if (urlPath === '/api/chats/search' && method === 'GET') {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      if (!requireAuth(currentUser, res)) return true;
      const q = params.get('q') || '';
      if (!q.trim()) return json(res, 400, { error: 'Query parameter q is required' }), true;
      const results = await db.searchChats(q.trim(), currentUser.id);
      return json(res, 200, { chats: results }), true;
    }

    // ─── GET /api/chats/tags ───
    if (urlPath === '/api/chats/tags' && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      const tags = await db.getAllTags(currentUser.id);
      return json(res, 200, { tags }), true;
    }

    // ─── GET /api/chats/by-tag/:tag ───
    const tagMatch = urlPath.match(/^\/api\/chats\/by-tag\/(.+)$/);
    if (tagMatch && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      const tag = decodeURIComponent(tagMatch[1]);
      const chats = await db.getChatsByTag(tag, currentUser.id);
      return json(res, 200, { chats }), true;
    }

    // ─── GET /api/chats/shared-with-me ───
    if (urlPath === '/api/chats/shared-with-me' && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      const shared = await db.getSharedWithMe(currentUser.id);
      return json(res, 200, { chats: shared }), true;
    }

    // ─── GET /api/chats/stats ───
    if (urlPath === '/api/chats/stats' && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      return json(res, 200, await db.getStats()), true;
    }

    // ─── POST /api/chats/batch-delete ───
    if (urlPath === '/api/chats/batch-delete' && method === 'POST') {
      if (!requireAuth(currentUser, res)) return true;
      const body = await parseBody(req);
      const { chatIds } = body || {};
      if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0) {
        return json(res, 400, { error: 'chatIds array required' }), true;
      }
      const deleted = await db.deleteChats(chatIds, currentUser.id);
      chatIds.forEach(id => deps.wsClients.delete(id));
      return json(res, 200, { success: true, deleted }), true;
    }

    // ─── GET /api/users ───
    if (urlPath === '/api/users' && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      const users = await db.getAllUsers();
      return json(res, 200, { users: users.filter(u => u.id !== currentUser.id) }), true;
    }

    // ─── GET /api/users/stats ───
    if (urlPath === '/api/users/stats' && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      try {
        const { query: dbQuery } = await import('../db-adapter.mjs');
        const [totalRow] = await dbQuery("SELECT COUNT(*) as n FROM users WHERE isActive=1");
        const byRole = await dbQuery("SELECT role, COUNT(*) as count FROM users WHERE isActive=1 GROUP BY role ORDER BY count DESC");
        const [newWeekRow] = await dbQuery("SELECT COUNT(*) as n FROM users WHERE isActive=1 AND createdAt > datetime('now', '-7 days')");
        const [newTodayRow] = await dbQuery("SELECT COUNT(*) as n FROM users WHERE isActive=1 AND createdAt > datetime('now', '-1 day')");
        return json(res, 200, {
          total: totalRow.n,
          active_today: newTodayRow.n,
          new_this_week: newWeekRow.n,
          by_role: byRole,
        }), true;
      } catch (e) {
        return json(res, 500, { error: e.message }), true;
      }
    }

    // ─── PATCH /api/chats/:id/tags ───
    const tagsMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/tags$/);
    if (tagsMatch && method === 'PATCH') {
      if (!requireAuth(currentUser, res)) return true;
      const body = await parseBody(req);
      if (!Array.isArray(body.tags)) return json(res, 400, { error: 'tags must be an array' }), true;
      const updated = await db.updateChatTags(tagsMatch[1], body.tags);
      if (!updated) return json(res, 404, { error: 'Chat not found' }), true;
      return json(res, 200, { success: true, tags: body.tags }), true;
    }

    // ─── POST /api/chats/:id/messages — Delegate to ChatOrchestrator ───
    const msgMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (msgMatch && method === 'POST') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = msgMatch[1];
      const chat = await db.getChatById(chatId);
      if (!chat) return json(res, 404, { error: 'Chat not found' }), true;
      // Ownership check: only owner, admin, or shared-with-write users can send messages
      if (chat.userId && chat.userId !== currentUser.id && currentUser.role !== 'admin') {
        const hasShare = await db.hasShareAccess(chatId, currentUser.id);
        if (!hasShare) return json(res, 403, { error: 'Access denied' }), true;
      }

      const body = await parseBody(req);

      // Step 1: Validate & parse
      logger.info(`[${ts()}] [chat-api] body.attachments: ${JSON.stringify(body.attachments || null)}`);
      const parsed = await orchestrator.validateAndParse(body);
      logger.info(`[${ts()}] [chat-api] parsed.attachments: ${JSON.stringify(parsed.attachments || [])}`);
      if (!parsed.ok) return json(res, parsed.status, { error: parsed.error }), true;

      
      // Step 1.5: Token budget check (F14)
      const budgetCheck = await checkTokenBudget(currentUser?.id || null);
      if (!budgetCheck.allowed) {
        logger.info(`[${ts()}] [chat-api] Token budget exceeded for user ${currentUser?.id}: ${budgetCheck.reason}`);
        return json(res, 429, { 
          error: 'Token budget exceeded', 
          detail: budgetCheck.reason,
          usage: budgetCheck.usage 
        }), true;
      }
      // Step 2: Rate limit & active task check
      const rateCheck = orchestrator.checkRateAndActiveTask(chat.sessionKey);
      if (!rateCheck.ok) return json(res, rateCheck.status, { error: rateCheck.error }), true;

      // Step 3: Generate message ID & save user message
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const savedContent = parsed.attachments.length > 0
        ? JSON.stringify({ text: body.content, attachments: parsed.attachments.map(a => ({ type: a.type, url: a.url, name: a.name, mimeType: a.mimeType, size: a.size })) })
        : body.content;
      await db.createMessage({ chatId, role: 'user', content: savedContent, msgId });

      // Step 4: Get history
      const history = await db.getConversationHistory(chatId, 50);

      // Step 5: Track active task
      deps.activeTasksBySession.set(chat.sessionKey, { msgId, startedAt: Date.now() });
      deps.eventBuffer.startTask(msgId, chat.sessionKey, body.content);
      deps.taskStore.startTask(msgId, chat.sessionKey, body.content).catch(e => logger.debug('[chat-api] startTask failed:', e.message));

      // Step 6: Return 202 immediately
      json(res, 202, { msgId, chatId, status: 'processing', sessionKey: chat.sessionKey });

      // Step 7: Delegate async pipeline to orchestrator
      const traceId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || `tid_${Date.now()}`;
      orchestrator.executeMessagePipeline({
        chatId, msgId, chat,
        processedContent: parsed.processedContent,
        rawContent: body.content,
        history, attachments: parsed.attachments, body,
        traceId, // Iter-60: propagate traceId
        userId: currentUser?.id || null, // F9: propagate userId for trace
        userRole: currentUser?.role || 'member',
      });

      return true;
    }

    // ─── POST /api/chats/:id/share ───
    const shareMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/share$/);
    if (shareMatch && method === 'POST') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = shareMatch[1];
      const body = await parseBody(req);
      if (!body.sharedWithUserId) return json(res, 400, { error: 'sharedWithUserId is required' }), true;
      const chat = await db.getChatById(chatId);
      if (!chat) return json(res, 404, { error: 'Chat not found' }), true;
      if (chat.userId !== currentUser.id && currentUser.role !== 'admin') return json(res, 403, { error: 'Only chat owner or admin can share' }), true;
      if (body.sharedWithUserId === currentUser.id) return json(res, 400, { error: 'Cannot share with yourself' }), true;
      await db.shareChat(chatId, body.sharedWithUserId, currentUser.id, body.permission || 'read');
      return json(res, 200, { success: true }), true;
    }

    // ─── GET /api/chats/:id/shares ───
    const sharesMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/shares$/);
    if (sharesMatch && method === 'GET') {
      const shares = await db.getChatShares(sharesMatch[1]);
      return json(res, 200, { shares }), true;
    }

    // ─── DELETE /api/chats/:id/share/:userId ───
    const unshareMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/share\/([^/]+)$/);
    if (unshareMatch && method === 'DELETE') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = unshareMatch[1];
      const chat = await db.getChatById(chatId);
      if (!chat) return json(res, 404, { error: 'Chat not found' }), true;
      if (chat.userId !== currentUser.id && currentUser.role !== 'admin') return json(res, 403, { error: 'Only chat owner or admin can unshare' }), true;
      await db.unshareChat(chatId, unshareMatch[2]);
      return json(res, 200, { success: true }), true;
    }

    // ─── POST /api/chats/:id/regenerate/:messageId ───
    // ─── PATCH /api/chats/:id/messages/:msgId/feedback ───
    const feedbackMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/messages\/(\d+)\/feedback$/);
    if (feedbackMatch && method === 'PATCH') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = feedbackMatch[1];
      const messageId = feedbackMatch[2];
      const body = await parseBody(req);
      const { feedback } = body; // 'up' | 'down' | null
      if (feedback !== 'up' && feedback !== 'down' && feedback !== null) {
        return json(res, 400, { error: 'Invalid feedback value. Must be "up", "down", or null.' }), true;
      }
      const updated = await db.updateMessageMetadata(chatId, messageId, { feedback });
      if (!updated) return json(res, 404, { error: 'Message not found' }), true;
      logger.info(`[${ts()}] [chat-api] Feedback ${feedback} on msg ${messageId} in chat ${chatId}`);
      return json(res, 200, { success: true, metadata: updated }), true;
    }

    const regenMatch = urlPath.match(/^\/api\/chats\/([^/]+)\/regenerate\/(\d+)$/);
    if (regenMatch && method === 'POST') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = regenMatch[1];
      const messageId = parseInt(regenMatch[2], 10);
      const chat = await db.getChatById(chatId);
      if (!chat) return json(res, 404, { error: '对话不存在' }), true;
      const targetMsg = await db.getMessageById(chatId, messageId);
      if (!targetMsg) return json(res, 404, { error: '消息不存在' }), true;
      const lastUserMsg = await db.getLastUserMessageBefore(chatId, messageId);
      if (!lastUserMsg) return json(res, 400, { error: '找不到对应的用户消息' }), true;
      const { deleted } = await db.deleteMessagesFrom(chatId, messageId);
      logger.info(`[${ts()}] [chat-api] Regenerate: deleted ${deleted} messages from chat ${chatId} starting at id ${messageId}`);
      return json(res, 200, { success: true, deleted, userMessage: { id: lastUserMsg.id, content: lastUserMsg.content, role: lastUserMsg.role } }), true;
    }

    // ─── GET /api/chats/:id ───
    const chatIdMatch = urlPath.match(/^\/api\/chats\/([^/]+)$/);
    if (chatIdMatch && method === 'GET') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = chatIdMatch[1];
      const chat = await db.getChatById(chatId);
      if (!chat) return json(res, 404, { error: 'Chat not found' }), true;
      // Ownership check: only owner, admin, or shared-with users can access
      if (chat.userId && chat.userId !== currentUser.id && currentUser.role !== 'admin') {
        const hasShare = await db.hasShareAccess(chatId, currentUser.id);
        if (!hasShare) return json(res, 403, { error: 'Access denied' }), true;
      }
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = Math.min(parseInt(params.get('limit') || '500'), 1000);
      const offset = parseInt(params.get('offset') || '0');
      const messages = await db.getMessages(chatId, limit, offset);
      const messageCount = await db.getMessageCount(chatId);
      return json(res, 200, { chat, messages, messageCount }), true;
    }

    // ─── PATCH /api/chats/:id ───
    if (chatIdMatch && method === 'PATCH') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = chatIdMatch[1];
      const chat = await db.getChatById(chatId);
      if (!chat) return json(res, 404, { error: 'Chat not found' }), true;
      if (chat.userId && chat.userId !== currentUser.id && currentUser.role !== 'admin') {
        return json(res, 403, { error: 'Only chat owner or admin can rename' }), true;
      }
      const body = await parseBody(req);
      if (!body.title || typeof body.title !== 'string') return json(res, 400, { error: 'Title is required' }), true;
      const updated = await db.updateChatTitle(chatId, body.title.trim());
      if (!updated) return json(res, 404, { error: 'Chat not found' }), true;
      const updatedChat = await db.getChatById(chatId);
      return json(res, 200, { chat: updatedChat }), true;
    }

    // ─── DELETE /api/chats/:id ───
    if (chatIdMatch && method === 'DELETE') {
      if (!requireAuth(currentUser, res)) return true;
      const chatId = chatIdMatch[1];
      const deleted = await db.deleteChat(chatId, currentUser.id);
      if (!deleted) return json(res, 404, { error: 'Chat not found' }), true;
      deps.wsClients.delete(chatId);
      logger.info(`[${ts()}] [chat-api] Deleted chat: ${chatId} (user: ${currentUser?.username || 'anonymous'})`);
      return json(res, 200, { success: true }), true;
    }

  } catch (err) {
    logger.error(`[${ts()}] [chat-api] Error: ${err.message}`);
    const statusCode = err.message === 'Invalid JSON' ? 400 : 500;
    json(res, statusCode, { error: statusCode === 400 ? 'Invalid JSON in request body' : 'Internal server error' });
    return true;
  }

  return false;
}
