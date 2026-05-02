/**
 * /api/task-status — Frontend self-healing endpoint
 * 
 * Called by useStreamWatchdog when streaming stalls.
 * Returns the current status of a task by msgId.
 * 
 * P0 Invariant: INV-6 (Frontend timeout self-healing)
 */
import { getDb } from './bootstrap.mjs';

export async function handleTaskStatus(req, res) {
  const { msgId } = req.query;
  if (!msgId) {
    return res.status(400).json({ status: 'unknown', error: 'Missing msgId' });
  }

  try {
    const db = getDb();
    // Check if there's a completed assistant reply for this message
    const [rows] = await db.execute(
      `SELECT content, model, role, createdAt FROM messages 
       WHERE chatId = (SELECT chatId FROM messages WHERE msgId = ? LIMIT 1)
       AND role = 'assistant'
       AND createdAt >= (SELECT createdAt FROM messages WHERE msgId = ? LIMIT 1)
       ORDER BY createdAt DESC LIMIT 1`,
      [msgId, msgId]
    );

    if (rows && rows.length > 0) {
      return res.json({
        status: 'completed',
        content: rows[0].content,
        model: rows[0].model,
      });
    }

    // Check if there's an active worker handling this message
    // (This is a simplified check — in production you'd check the worker pool)
    return res.json({ status: 'running' });
  } catch (err) {
    console.error('[task-status] Error:', err.message);
    return res.json({ status: 'unknown', error: err.message });
  }
}
