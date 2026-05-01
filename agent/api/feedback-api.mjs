/**
 * feedback-api.mjs — Feedback Summary API for Admin Dashboard
 * 
 * Endpoints:
 *   GET  /api/admin/feedback-summary   — aggregated feedback stats
 *   GET  /api/admin/feedback-messages  — list messages with feedback (paginated)
 *   POST /api/admin/feedback-to-kb     — push a feedback message to knowledge base
 *
 * v2.0.0 Changes:
 *   - Internal-call bypass (x-internal-call from 127.0.0.1)
 *   - Feedback-to-knowledge-base endpoint
 *   - Exported checkFeedbackAlerts() for cron use
 *
 * @version 2.0.0
 */
import { logger } from "../lib/logger.mjs";
import { ts } from "../modules/helpers.mjs";
import { query, queryOne, run } from "../db-adapter.mjs";

// ─── Internal call detection (consistent with sandbox pattern) ──────────────
function isInternalCall(req) {
  const addr = req.socket?.remoteAddress || '';
  return req.headers['x-internal-call'] === '1' &&
    (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

/**
 * Check feedback alerts — called by cron every hour.
 * Returns { shouldAlert, stats } if negative feedback rate exceeds threshold.
 */
export async function checkFeedbackAlerts(thresholdPct = 20) {
  try {
    // Count feedback in the last hour
    const hourUp = await queryOne(
      `SELECT COUNT(*) as cnt FROM messages WHERE json_extract(metadata, '$.feedback') = 'up' AND createdAt >= datetime('now', '-1 hour')`
    );
    const hourDown = await queryOne(
      `SELECT COUNT(*) as cnt FROM messages WHERE json_extract(metadata, '$.feedback') = 'down' AND createdAt >= datetime('now', '-1 hour')`
    );
    const up = hourUp?.cnt || 0;
    const down = hourDown?.cnt || 0;
    const total = up + down;
    if (total === 0) return { shouldAlert: false, stats: { up, down, total, negRate: 0 } };
    const negRate = +(down / total * 100).toFixed(1);
    return {
      shouldAlert: negRate >= thresholdPct,
      stats: { up, down, total, negRate },
    };
  } catch (err) {
    logger.error(`[${ts()}] [feedback-api] Alert check error: ${err.message}`);
    return { shouldAlert: false, stats: null, error: err.message };
  }
}

/**
 * Handle feedback API requests.
 */
export async function handleFeedbackApi(req, res, options = {}) {
  const urlPath = req.url?.split("?")[0] || "";
  const method = req.method;
  const url = new URL(req.url, "http://localhost");
  
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // Permission check: admin/manager required — unless internal call
  const user = options.user || req._authenticatedUser;
  const _internal = isInternalCall(req);
  if (!_internal && (!user || (user.role !== 'admin' && user.role !== 'manager'))) {
    sendJson(403, { error: "Insufficient permissions. Admin or manager role required." });
    return true;
  }

  // GET /api/admin/feedback-summary
  if (urlPath === "/api/admin/feedback-summary" && method === "GET") {
    try {
      const upRow = await queryOne(
        `SELECT COUNT(*) as cnt FROM messages WHERE json_extract(metadata, '$.feedback') = 'up'`
      );
      const upCount = upRow?.cnt || 0;
      
      const downRow = await queryOne(
        `SELECT COUNT(*) as cnt FROM messages WHERE json_extract(metadata, '$.feedback') = 'down'`
      );
      const downCount = downRow?.cnt || 0;
      
      const totalRow = await queryOne(`SELECT COUNT(*) as cnt FROM messages WHERE role = 'assistant'`);
      const totalMessages = totalRow?.cnt || 0;
      
      // Feedback by day (last 30 days)
      const dailyFeedback = await query(`
        SELECT 
          date(m.createdAt) as day,
          SUM(CASE WHEN json_extract(m.metadata, '$.feedback') = 'up' THEN 1 ELSE 0 END) as thumbs_up,
          SUM(CASE WHEN json_extract(m.metadata, '$.feedback') = 'down' THEN 1 ELSE 0 END) as thumbs_down
        FROM messages m
        WHERE m.metadata LIKE '%feedback%'
          AND m.createdAt >= datetime('now', '-30 days')
        GROUP BY date(m.createdAt)
        ORDER BY day DESC
      `);
      
      // Feedback by chat
      const chatFeedback = await query(`
        SELECT 
          c.id as chatId,
          c.title as chatTitle,
          c.userId,
          SUM(CASE WHEN json_extract(m.metadata, '$.feedback') = 'up' THEN 1 ELSE 0 END) as thumbs_up,
          SUM(CASE WHEN json_extract(m.metadata, '$.feedback') = 'down' THEN 1 ELSE 0 END) as thumbs_down,
          COUNT(*) as feedback_count
        FROM messages m
        JOIN chats c ON c.id = m.chatId
        WHERE m.metadata LIKE '%feedback%'
        GROUP BY c.id
        ORDER BY thumbs_down DESC, feedback_count DESC
        LIMIT 20
      `);
      
      const totalFeedback = upCount + downCount;
      const satisfactionRate = totalFeedback > 0 ? +(upCount / totalFeedback * 100).toFixed(1) : 0;
      
      sendJson(200, {
        summary: {
          thumbsUp: upCount,
          thumbsDown: downCount,
          totalFeedback,
          totalAssistantMessages: totalMessages,
          feedbackRate: totalMessages > 0 ? +((totalFeedback / totalMessages) * 100).toFixed(1) : 0,
          satisfactionRate,
        },
        dailyTrend: dailyFeedback,
        chatBreakdown: chatFeedback,
      });
      return true;
    } catch (err) {
      logger.error(`[${ts()}] [feedback-api] Error fetching summary: ${err.message}`);
      sendJson(500, { error: "Failed to fetch feedback summary", detail: err.message });
      return true;
    }
  }

  // GET /api/admin/feedback-messages
  if (urlPath === "/api/admin/feedback-messages" && method === "GET") {
    try {
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const feedbackType = url.searchParams.get("type");
      const offset = (page - 1) * limit;
      
      let sql = `
        SELECT 
          m.id, m.chatId, m.role, m.content, m.metadata, m.createdAt,
          c.title as chatTitle, c.userId
        FROM messages m
        JOIN chats c ON c.id = m.chatId
        WHERE m.metadata LIKE '%feedback%'
      `;
      const params = [];
      
      if (feedbackType === 'up' || feedbackType === 'down') {
        sql += ` AND json_extract(m.metadata, '$.feedback') = ?`;
        params.push(feedbackType);
      }
      
      sql += ` ORDER BY m.createdAt DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      const messages = await query(sql, params);
      
      let countSql = `SELECT COUNT(*) as cnt FROM messages WHERE metadata LIKE '%feedback%'`;
      const countParams = [];
      if (feedbackType === 'up' || feedbackType === 'down') {
        countSql += ` AND json_extract(metadata, '$.feedback') = ?`;
        countParams.push(feedbackType);
      }
      const countRow = await queryOne(countSql, countParams);
      const total = countRow?.cnt || 0;
      
      const enriched = messages.map(msg => {
        let meta = {};
        try { meta = JSON.parse(msg.metadata || '{}'); } catch(_err) { /* v22.0 */ console.error("[feedback-api] silent catch:", _err?.message || _err); }
        return {
          ...msg,
          feedback: meta.feedback || null,
          metadata: meta,
          contentPreview: (msg.content || '').substring(0, 200),
        };
      });
      
      sendJson(200, {
        messages: enriched,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
      return true;
    } catch (err) {
      logger.error(`[${ts()}] [feedback-api] Error fetching messages: ${err.message}`);
      sendJson(500, { error: "Failed to fetch feedback messages", detail: err.message });
      return true;
    }
  }

  // POST /api/admin/feedback-to-kb — push a negative-feedback message into knowledge_docs
  if (urlPath === "/api/admin/feedback-to-kb" && method === "POST") {
    try {
      const body = await new Promise(r => {
        let d = ''; req.on('data', c => d += c);
        req.on('end', () => { try { r(JSON.parse(d)); } catch { r({}); } });
      });
      const { messageId, chatId, title, content, category } = body;
      if (!messageId || !content) {
        sendJson(400, { error: "messageId and content are required" });
        return true;
      }
      // Insert into knowledge_docs (matches actual schema)
      const docId = `fb-${messageId}-${Date.now()}`;
      const docTitle = title || `差评反馈 #${messageId}`;
      const docCategory = category || '反馈改进';
      const uploadedBy = user?.username || user?.id || 'system';
      
      await run(
        `INSERT INTO knowledge_docs (id, title, description, category, content, uploadedBy, mimeType, isActive, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 1, datetime('now'), datetime('now'))`,
        [docId, docTitle, `来源: 差评反馈 (消息ID: ${messageId}, 对话: ${chatId || 'unknown'})`, docCategory, content, uploadedBy]
      );

      logger.info(`[${ts()}] [feedback-api] Feedback message ${messageId} pushed to knowledge base as doc ${docId}`);
      
      sendJson(200, {
        success: true,
        docId,
        message: `已添加到知识库 (${docCategory})，状态: 待审阅`,
      });
      return true;
    } catch (err) {
      logger.error(`[${ts()}] [feedback-api] Error pushing to KB: ${err.message}`);
      sendJson(500, { error: "Failed to push feedback to knowledge base", detail: err.message });
      return true;
    }
  }

  return false;
}

export default { handleFeedbackApi, checkFeedbackAlerts };
