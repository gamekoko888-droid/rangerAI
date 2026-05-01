/**
 * dingtalk-adapter.mjs — DingTalk Stream Mode Adapter for ACP Bridge
 * 
 * Connects to DingTalk Open Platform via Stream mode (WebSocket),
 * receives robot messages, routes them through ACP Bridge to RangerAI,
 * and sends replies back to DingTalk.
 * 
 * Features:
 * - Stream mode connection (no public IP needed for callbacks)
 * - Text and Markdown message support
 * - Group chat and 1:1 chat support
 * - Auto-reconnect on disconnect
 * - Message deduplication (60s window)
 * - Rate limiting awareness (DingTalk 5000 calls/month free tier)
 * 
 * Required env vars:
 *   DINGTALK_CLIENT_ID     — AppKey from DingTalk Open Platform
 *   DINGTALK_CLIENT_SECRET — AppSecret from DingTalk Open Platform
 * 
 * @version 1.0.0
 * @since Iter-42
 */

import { routeMessage, log, logError, ts } from "./acp-bridge.mjs";

// ─── Configuration ──────────────────────────────────────────
const DINGTALK_CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const DINGTALK_CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;
const DINGTALK_ENABLED = !!(DINGTALK_CLIENT_ID && DINGTALK_CLIENT_SECRET);

// Rate limiting: DingTalk free tier = 5000 API calls/month
const MONTHLY_LIMIT = parseInt(process.env.DINGTALK_MONTHLY_LIMIT || "4500", 10); // Leave 500 buffer
let monthlyCallCount = 0;
let monthlyResetDate = getNextMonthReset();

// Message deduplication (DingTalk may retry within 60s)
const processedMessages = new Map();
const DEDUP_WINDOW_MS = 60000;

// ─── DingTalk Stream Client ────────────────────────────────
let streamClient = null;

/**
 * Initialize and connect the DingTalk Stream client.
 * Uses the official dingtalk-stream SDK.
 */
async function initDingTalk() {
  if (!DINGTALK_ENABLED) {
    log('dingtalk', 'DingTalk adapter disabled (DINGTALK_CLIENT_ID/SECRET not set)');
    return false;
  }

  log('dingtalk', `Initializing DingTalk Stream adapter (clientId: ${DINGTALK_CLIENT_ID.substring(0, 8)}...)`);

  try {
    // Dynamic import to avoid crash if SDK not installed
    const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream');

    streamClient = new DWClient({
      clientId: DINGTALK_CLIENT_ID,
      clientSecret: DINGTALK_CLIENT_SECRET,
      debug: process.env.DINGTALK_DEBUG === 'true',
    });

    // Register robot message callback
    streamClient.registerCallbackListener(TOPIC_ROBOT, async (res) => {
      try {
        await handleRobotMessage(res);
      } catch (err) {
        logError('dingtalk', 'Failed to handle robot message', err);
      }
    });

    // Connect to DingTalk Stream
    await streamClient.connect();
    log('dingtalk', 'DingTalk Stream connected successfully');
    
    // Start dedup cleanup interval
    _dedupCleanupTimer = setInterval(cleanupDedup, 30000);
    
    return true;
  } catch (err) {
    logError('dingtalk', 'Failed to initialize DingTalk Stream', err);
    return false;
  }
}

// ─── Robot Message Handler ──────────────────────────────────
async function handleRobotMessage(res) {
  const messageId = res.headers?.messageId;
  
  // Deduplication check
  if (messageId && processedMessages.has(messageId)) {
    log('dingtalk', `Duplicate message ${messageId}, skipping`);
    // Still need to ACK to prevent further retries
    if (streamClient) {
      streamClient.socketCallBackResponse(messageId, { msgtype: 'empty' });
    }
    return;
  }
  
  // Mark as processed
  if (messageId) {
    processedMessages.set(messageId, Date.now());
  }
  
  // Rate limit check
  checkMonthlyReset();
  if (monthlyCallCount >= MONTHLY_LIMIT) {
    log('dingtalk', `Monthly rate limit reached (${monthlyCallCount}/${MONTHLY_LIMIT}), rejecting message`);
    await replyToDingTalk(res, '本月 API 调用次数已达上限，请下月再试或联系管理员。');
    return;
  }
  monthlyCallCount++;

  // Parse message data
  const data = JSON.parse(res.data);
  const {
    text,
    senderStaffId,
    senderNick,
    conversationId,
    conversationType,
    sessionWebhook,
    chatbotUserId,
    isInAtList,
    atUsers,
    msgtype,
  } = data;

  // Extract message content
  let content = '';
  if (msgtype === 'text' && text?.content) {
    content = text.content.trim();
  } else if (msgtype === 'richText') {
    content = '[富文本消息，暂不支持]';
  } else if (msgtype === 'picture') {
    content = '[图片消息，暂不支持]';
  } else {
    content = text?.content?.trim() || '[空消息]';
  }

  // In group chat, remove @bot mention prefix
  if (conversationType === '2' && content.startsWith('@')) {
    content = content.replace(/^@\S+\s*/, '').trim();
  }

  if (!content || content === '[空消息]') {
    await replyToDingTalk(res, '请输入您的问题，我来帮您解答。');
    return;
  }

  const isGroupChat = conversationType === '2';
  log('dingtalk', `${isGroupChat ? 'Group' : '1:1'} message from ${senderNick || senderStaffId}: "${content.substring(0, 60)}"`);

  // Send "thinking" indicator
  await replyToDingTalk(res, null); // ACK immediately to prevent retry

  // Route through ACP Bridge to RangerAI
  const result = await routeMessage({
    platformId: 'dingtalk',
    externalUserId: senderStaffId,
    externalUserName: senderNick || senderStaffId,
    conversationId: conversationId || `dm-${senderStaffId}`,
    content,
    msgType: msgtype || 'text',
    metadata: {
      isGroupChat,
      chatbotUserId,
    },
  });

  // Send reply back to DingTalk via sessionWebhook
  if (sessionWebhook && result.reply) {
    await sendReplyViaWebhook(sessionWebhook, senderStaffId, result.reply, isGroupChat);
  }
}

// ─── Reply to DingTalk ──────────────────────────────────────
async function replyToDingTalk(res, text) {
  const messageId = res.headers?.messageId;
  if (!messageId || !streamClient) return;

  if (text === null) {
    // Just ACK, no reply content
    streamClient.socketCallBackResponse(messageId, { msgtype: 'empty' });
    return;
  }

  // Simple text reply via Stream callback
  streamClient.socketCallBackResponse(messageId, {
    msgtype: 'text',
    text: { content: text },
  });
}

/**
 * Send a reply via DingTalk sessionWebhook (supports Markdown).
 * This is the primary reply method for rich content.
 */
async function sendReplyViaWebhook(webhookUrl, userId, content, isGroupChat = false) {
  try {
    // Determine if content should be sent as Markdown
    const isMarkdown = content.includes('```') || content.includes('**') || 
                       content.includes('###') || content.includes('- ') ||
                       content.length > 500;

    let body;
    if (isMarkdown) {
      // Truncate if too long (DingTalk Markdown limit ~20000 chars)
      const truncatedContent = content.length > 18000 
        ? content.substring(0, 18000) + '\n\n...[内容已截断]'
        : content;
      
      body = {
        msgtype: 'markdown',
        markdown: {
          title: 'RangerAI',
          text: isGroupChat ? `@${userId}\n\n${truncatedContent}` : truncatedContent,
        },
        at: isGroupChat ? { atUserIds: [userId], isAtAll: false } : undefined,
      };
    } else {
      body = {
        msgtype: 'text',
        text: {
          content: isGroupChat ? `@${userId} ${content}` : content,
        },
        at: isGroupChat ? { atUserIds: [userId], isAtAll: false } : undefined,
      };
    }

    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logError('dingtalk', `Webhook reply failed: ${resp.status} ${errText}`);
    } else {
      log('dingtalk', `Reply sent via webhook (${isMarkdown ? 'markdown' : 'text'}, ${content.length} chars)`);
    }
  } catch (err) {
    logError('dingtalk', 'Failed to send webhook reply', err);
  }
}

// ─── Rate Limiting Helpers ──────────────────────────────────
function getNextMonthReset() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function checkMonthlyReset() {
  if (Date.now() >= monthlyResetDate) {
    log('dingtalk', `Monthly rate limit reset (was ${monthlyCallCount})`);
    monthlyCallCount = 0;
    monthlyResetDate = getNextMonthReset();
  }
}

// ─── Dedup Cleanup ──────────────────────────────────────────
let _dedupCleanupTimer = null;
function cleanupDedup() {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      processedMessages.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log('dingtalk', `Cleaned ${cleaned} expired dedup entries`);
  }
}

// ─── Status ─────────────────────────────────────────────────
function getStatus() {
  return {
    enabled: DINGTALK_ENABLED,
    connected: streamClient?.connected || false,
    registered: streamClient?.registered || false,
    monthlyCallCount,
    monthlyLimit: MONTHLY_LIMIT,
    monthlyResetDate: new Date(monthlyResetDate).toISOString(),
    dedupCacheSize: processedMessages.size,
  };
}

// ─── Shutdown ───────────────────────────────────────────────
function shutdown() {
  if (_dedupCleanupTimer) { clearInterval(_dedupCleanupTimer); _dedupCleanupTimer = null; }
  if (streamClient) {
    log('dingtalk', 'Disconnecting DingTalk Stream...');
    streamClient.disconnect();
    streamClient = null;
  }
}

// ─── Exports ────────────────────────────────────────────────
export {
  initDingTalk,
  getStatus,
  shutdown,
  DINGTALK_ENABLED,
  sendReplyViaWebhook,
};
