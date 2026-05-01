/**
 * acp-bridge.mjs — ACP (Agent Communication Protocol) Bridge Core
 * 
 * Orchestrates external platform adapters (DingTalk, Feishu, etc.)
 * and the RESTful API Gateway. Routes messages between external
 * platforms and RangerAI Agent backend.
 * 
 * Architecture:
 *   External Platform → Adapter → ACP Bridge → RangerAI Agent (HTTP API)
 *   RangerAI Agent → ACP Bridge → Adapter → External Platform
 * 
 * Iter-50: Now the single source of truth for DB initialization in the
 *          ACP process. ensureAcpUser() calls initDatabase() before
 *          any DB operations. Exports getAcpAuthToken() for acp-api.mjs.
 * 
 * @version 1.1.0
 * @since Iter-50
 */

import { logger } from './lib/logger.mjs';
import { loadEnvFile } from "./lib/bootstrap.mjs";
import { initAdapter as initDatabase } from './db-adapter.mjs'; // Iter-N: direct adapter import (initDatabase → initAdapter, idempotent)
import { extractUserFromRequest, generateToken, verifyToken } from './services/user-service.mjs'; // Iter-N: direct service import

// ─── Configuration ──────────────────────────────────────────
const RANGERAI_ENV_FILE = process.env.RANGERAI_ENV_FILE || "/opt/rangerai-agent/.env";
const RANGERAI_SECRETS_FILE = process.env.RANGERAI_SECRETS_FILE || "/opt/rangerai-agent/agent-secrets.env";

// Load env files
loadEnvFile(RANGERAI_ENV_FILE);
loadEnvFile(RANGERAI_SECRETS_FILE);

const AGENT_API_BASE = process.env.RANGERAI_API_BASE || "http://127.0.0.1:3002";
const ACP_PORT = parseInt(process.env.ACP_PORT || "3003", 10);

// ─── Logging ────────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(module, msg) { logger.info(`[${ts()}] [acp-bridge:${module}] ${msg}`); }
function logError(module, msg, err) { logger.error(`[${ts()}] [acp-bridge:${module}] ERROR: ${msg}`, err?.message || err); }

// ─── Message Router ─────────────────────────────────────────
/**
 * Route a message from an external platform to RangerAI Agent.
 * Creates a chat (or reuses existing), sends the message, and
 * polls for the AI response.
 */
async function routeMessage({ platformId, externalUserId, externalUserName, conversationId, content, msgType = 'text', metadata = {} }) {
  const startTime = Date.now();
  log('router', `Incoming message from ${platformId}:${externalUserId} in ${conversationId}: "${content.substring(0, 80)}..."`);

  try {
    // Step 1: Get or create a mapped chat session
    const chatMapping = await getOrCreateChatMapping(platformId, externalUserId, conversationId);
    const { chatId, authToken } = chatMapping;

    log('router', `Using chatId=${chatId}`);

    // Step 2: Send message to RangerAI Agent via HTTP API
    const sendResp = await fetch(`${AGENT_API_BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        content,
        metadata: {
          ...metadata,
          platform: platformId,
          externalUserId,
          externalUserName,
        },
      }),
    });

    if (!sendResp.ok) {
      const errBody = await sendResp.text();
      throw new Error(`Agent API returned ${sendResp.status}: ${errBody}`);
    }

    const sendResult = await sendResp.json();
    const { msgId } = sendResult;
    log('router', `Message sent to Agent, msgId=${msgId}, chatId=${chatId}`);

    // Step 3: Poll for task completion (AI response)
    const reply = await pollForReply(chatId, msgId, authToken);
    const elapsed = Date.now() - startTime;
    log('router', `Reply received in ${elapsed}ms for ${platformId}:${externalUserId}`);

    return {
      reply: reply.content || '抱歉，我暂时无法回复。',
      metadata: {
        msgId,
        chatId,
        elapsed,
      },
    };
  } catch (err) {
    logError('router', `Failed to route message from ${platformId}:${externalUserId}`, err);
    return {
      reply: '系统处理消息时遇到问题，请稍后重试。',
      metadata: { error: err.message },
    };
  }
}

// ─── Chat Mapping (External ID → RangerAI Chat) ────────────
const chatMappings = new Map();

// ACP bridge user — a dedicated system user for external platform messages
let acpUserId = null;
let acpAuthToken = null;

/**
 * Iter-50: ensureAcpUser is now the single DB initialization point for the ACP process.
 * It calls initDatabase() (idempotent) before any DB operations.
 */
async function ensureAcpUser() {
  if (acpAuthToken) return;
  
  // Iter-50: Ensure DB is initialized before any DB operations
  // initDatabase() is idempotent (checks `initialized` flag internally)
  await initDatabase();
  
  const { getUserByUsername, createUser } = await import("./database.mjs");
  
  let user = await getUserByUsername('acp-bridge');
  if (!user) {
    try {
      user = await createUser({
        username: 'acp-bridge',
        password: `acp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        displayName: 'ACP Bridge',
        role: 'member',
      });
      log('init', `Created ACP bridge user: ${user.id}`);
    } catch (err) {
      user = await getUserByUsername('acp-bridge');
      if (!user) throw new Error('Failed to create ACP bridge user');
    }
  }
  
  acpUserId = user.id;
  acpAuthToken = generateToken({ userId: user.id, username: 'acp-bridge' });
  log('init', `ACP bridge user ready: ${acpUserId}`);
}

/**
 * Iter-50: Get the ACP auth token. Used by acp-api.mjs for knowledge search.
 * Returns the cached token or null if ensureAcpUser hasn't been called yet.
 */
function getAcpAuthToken() {
  return acpAuthToken;
}

async function getOrCreateChatMapping(platformId, externalUserId, conversationId) {
  await ensureAcpUser();
  
  const mappingKey = `${platformId}:${conversationId}:${externalUserId}`;
  
  if (chatMappings.has(mappingKey)) {
    return chatMappings.get(mappingKey);
  }
  
  // Create a new chat in RangerAI
  const createResp = await fetch(`${AGENT_API_BASE}/api/chats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${acpAuthToken}`,
    },
    body: JSON.stringify({
      title: `[${platformId}] ${externalUserId}`,
    }),
  });
  
  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`Failed to create chat: ${createResp.status} ${errText}`);
  }
  
  // Response format: { chat: { id, sessionKey, title, ... } }
  const chatResp = await createResp.json();
  const chat = chatResp.chat || chatResp;
  
  if (!chat || !chat.id) {
    throw new Error(`Invalid chat creation response: ${JSON.stringify(chatResp)}`);
  }
  
  const mapping = {
    chatId: chat.id,
    sessionKey: chat.sessionKey,
    authToken: acpAuthToken,
    platformId,
    externalUserId,
    conversationId,
    createdAt: Date.now(),
  };
  
  chatMappings.set(mappingKey, mapping);
  log('mapping', `Created chat mapping: ${mappingKey} → ${mapping.chatId}`);
  
  return mapping;
}

// ─── Poll for AI Reply ──────────────────────────────────────
/**
 * Poll the RangerAI Agent for task completion and retrieve the AI reply.
 * 
 * Strategy:
 * 1. Poll /api/task/:msgId for task status (running/completed)
 * 2. When completed, get messages from /api/chats/:chatId to find assistant reply
 * 3. Fallback: after timeout, check messages directly
 */
async function pollForReply(chatId, msgId, authToken, maxWaitMs = 180000) {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds
  
  log('poll', `Polling for reply: chatId=${chatId}, msgId=${msgId}`);
  
  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Check task status via /api/task/:msgId
      const statusResp = await fetch(`${AGENT_API_BASE}/api/task/${encodeURIComponent(msgId)}`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      
      if (statusResp.ok) {
        const status = await statusResp.json();
        
        // Task completed — fetch the assistant reply from messages
        if (status.status === 'completed' || status.status === 'done') {
          log('poll', `Task ${msgId} completed, fetching reply...`);
          const reply = await fetchLatestAssistantMessage(chatId, authToken);
          if (reply) return reply;
        }
        
        if (status.status === 'failed' || status.status === 'error') {
          log('poll', `Task ${msgId} failed`);
          return { content: '处理失败，请重试。' };
        }
        
        // Still running — continue polling
      } else if (statusResp.status === 404) {
        // Task not found in event buffer — might have completed already
        // Check messages directly
        const reply = await fetchLatestAssistantMessage(chatId, authToken);
        if (reply) return reply;
      }
    } catch (err) {
      // Ignore polling errors, keep trying
      log('poll', `Poll error: ${err.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  // Timeout — try to get whatever reply exists
  log('poll', `Polling timeout for ${msgId}, checking messages one last time...`);
  const reply = await fetchLatestAssistantMessage(chatId, authToken);
  if (reply) return reply;
  
  return { content: '回复超时，请稍后重试。' };
}

/**
 * Fetch the latest assistant message from a chat.
 * GET /api/chats/:id returns { chat, messages, messageCount }
 */
async function fetchLatestAssistantMessage(chatId, authToken) {
  try {
    const msgsResp = await fetch(`${AGENT_API_BASE}/api/chats/${chatId}?limit=10`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    
    if (!msgsResp.ok) return null;
    
    const data = await msgsResp.json();
    const messages = data.messages || [];
    
    // Find the latest assistant message (messages are ordered by createdAt)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        const content = messages[i].content;
        return {
          content: typeof content === 'string' ? content : JSON.stringify(content),
        };
      }
    }
  } catch (err) {
    logError('poll', 'Failed to fetch messages', err);
  }
  
  return null;
}

// ─── Exports ────────────────────────────────────────────────
export {
  routeMessage,
  getOrCreateChatMapping,
  pollForReply,
  ensureAcpUser,
  getAcpAuthToken,
  log,
  logError,
  ts,
  AGENT_API_BASE,
  ACP_PORT,
};
