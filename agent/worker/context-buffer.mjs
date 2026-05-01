/**
 * context-buffer.mjs — Layered Context Buffer with Anchor Support
 * 
 * Phase 2 of Context Management Refactoring:
 * Implements a three-tier buffer system for short-term context:
 * 
 *   HOT  (last N messages)  — always included verbatim in prompt
 *   WARM (N+1 to M)         — included as condensed summaries
 *   COLD (M+1 and older)    — compressed into a single summary block
 * 
 * Anchors are messages that are "pinned" and always included in HOT
 * regardless of age. Examples: user's original goal, key decisions,
 * tool outputs with important data.
 * 
 * @module worker/context-buffer
 */
import { logger } from '../lib/logger.mjs';
import Database from 'better-sqlite3';

const ts = () => new Date().toISOString();

// ─── Configuration ───
const BUFFER_CONFIG = {
  HOT_SIZE: 6,           // Last N messages always verbatim
  WARM_SIZE: 12,         // Next M messages as condensed
  MAX_ANCHORS: 8,        // Max pinned messages per session
  WARM_SUMMARY_MAX: 300, // Max chars per warm message summary
  ANCHOR_TTL_MS: 2 * 60 * 60 * 1000, // Anchors expire after 2 hours
};

// ─── Per-session buffer state ───
const _buffers = new Map();

function getBuffer(sessionKey) {
  if (!_buffers.has(sessionKey)) {
    _buffers.set(sessionKey, {
      anchors: [],         // { id, content, reason, createdAt, priority }
      coldSummary: null,   // Compressed summary of cold messages
      coldMessageCount: 0, // How many messages are in the cold summary
      lastUpdate: Date.now(),
    });
  }
  return _buffers.get(sessionKey);
}

// ─── Anchor Management ───

/**
 * Pin a message as an anchor (always included in context).
 * 
 * @param {string} sessionKey
 * @param {string} content - The message content to pin
 * @param {string} reason - Why this is anchored (e.g., "user_goal", "key_decision", "tool_output")
 * @param {number} priority - Higher = more important (1-10)
 */
export function addAnchor(sessionKey, content, reason = 'important', priority = 5) {
  const buffer = getBuffer(sessionKey);
  
  // Check for duplicates (by content similarity)
  const isDuplicate = buffer.anchors.some(a => {
    if (a.content === content) return true;
    // Simple similarity check: if >80% overlap in first 200 chars
    const a1 = a.content.substring(0, 200);
    const a2 = content.substring(0, 200);
    if (a1.length < 20 || a2.length < 20) return false;
    const overlap = [...a1].filter(c => a2.includes(c)).length;
    return overlap / Math.max(a1.length, a2.length) > 0.8;
  });
  
  if (isDuplicate) {
    logger.info(`[${ts()}] [ctx-buffer] Skipping duplicate anchor for session ${sessionKey}`);
    return;
  }
  
  buffer.anchors.push({
    id: `anchor-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    content: content.substring(0, 2000), // Cap anchor size
    reason,
    priority,
    createdAt: Date.now(),
  });
  
  // Sort by priority (descending), then by recency
  buffer.anchors.sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt);
  
  // Evict expired anchors
  const now = Date.now();
  buffer.anchors = buffer.anchors.filter(a => now - a.createdAt < BUFFER_CONFIG.ANCHOR_TTL_MS);
  
  // Enforce max anchors
  if (buffer.anchors.length > BUFFER_CONFIG.MAX_ANCHORS) {
    buffer.anchors = buffer.anchors.slice(0, BUFFER_CONFIG.MAX_ANCHORS);
  }
  
  logger.info(`[${ts()}] [ctx-buffer] Anchor added (${reason}, priority=${priority}), total=${buffer.anchors.length}`);
}

/**
 * Remove an anchor by ID.
 */
export function removeAnchor(sessionKey, anchorId) {
  const buffer = getBuffer(sessionKey);
  buffer.anchors = buffer.anchors.filter(a => a.id !== anchorId);
}

/**
 * Get all active anchors for a session.
 */
export function getAnchors(sessionKey) {
  const buffer = getBuffer(sessionKey);
  const now = Date.now();
  // Filter expired
  buffer.anchors = buffer.anchors.filter(a => now - a.createdAt < BUFFER_CONFIG.ANCHOR_TTL_MS);
  return buffer.anchors;
}

// ─── Layered Buffer Assembly ───

/**
 * Classify messages into hot/warm/cold tiers.
 * 
 * @param {Array} messages - All conversation messages (oldest first)
 * @returns {{ hot: Array, warm: Array, cold: Array }}
 */
export function classifyMessages(messages) {
  if (!messages || messages.length === 0) {
    return { hot: [], warm: [], cold: [] };
  }
  
  const total = messages.length;
  const hotStart = Math.max(0, total - BUFFER_CONFIG.HOT_SIZE);
  const warmStart = Math.max(0, hotStart - BUFFER_CONFIG.WARM_SIZE);
  
  return {
    hot: messages.slice(hotStart),
    warm: messages.slice(warmStart, hotStart),
    cold: messages.slice(0, warmStart),
  };
}

/**
 * Build the layered context block for prompt injection.
 * This replaces the flat message list with a structured context.
 * 
 * @param {string} sessionKey
 * @param {Array} messages - All conversation messages
 * @param {object} options - { coldSummary?: string }
 * @returns {{ contextBlock: string, stats: object }}
 */
export function buildLayeredContext(sessionKey, messages, options = {}) {
  const buffer = getBuffer(sessionKey);
  const { hot, warm, cold } = classifyMessages(messages);
  const anchors = getAnchors(sessionKey);
  
  const parts = [];
  const stats = {
    hotCount: hot.length,
    warmCount: warm.length,
    coldCount: cold.length,
    anchorCount: anchors.length,
    totalMessages: messages.length,
  };
  
  // 1. Cold zone: compressed summary
  if (cold.length > 0) {
    const summary = options.coldSummary || buffer.coldSummary;
    if (summary) {
      parts.push(`[CONTEXT_COLD — ${cold.length} earlier messages compressed]`);
      parts.push(summary);
      parts.push('[/CONTEXT_COLD]');
    }
  }
  
  // 2. Anchors: pinned important messages
  if (anchors.length > 0) {
    parts.push('[CONTEXT_ANCHORS — pinned important context]');
    for (const anchor of anchors) {
      parts.push(`[${anchor.reason}] ${anchor.content}`);
    }
    parts.push('[/CONTEXT_ANCHORS]');
  }
  
  // 3. Warm zone: condensed recent history
  if (warm.length > 0) {
    parts.push(`[CONTEXT_WARM — ${warm.length} recent messages condensed]`);
    for (const msg of warm) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = msg.content || '';
      const condensed = content.length > BUFFER_CONFIG.WARM_SUMMARY_MAX
        ? content.substring(0, BUFFER_CONFIG.WARM_SUMMARY_MAX) + '...'
        : content;
      parts.push(`[${role}]: ${condensed}`);
    }
    parts.push('[/CONTEXT_WARM]');
  }
  
  // 4. Hot zone: verbatim recent messages (these go into the actual message array, not this block)
  // We return hot messages separately so they can be sent as proper message objects
  
  return {
    contextBlock: parts.join('\n'),
    hotMessages: hot,
    stats,
  };
}

/**
 * Update the cold summary for a session.
 * Called after compression generates a new summary.
 */
export function updateColdSummary(sessionKey, summary, messageCount) {
  const buffer = getBuffer(sessionKey);
  buffer.coldSummary = summary;
  buffer.coldMessageCount = messageCount;
  buffer.lastUpdate = Date.now();
  logger.info(`[${ts()}] [ctx-buffer] Cold summary updated: ${messageCount} messages → ${summary.length} chars`);
}

// ─── Auto-Anchor Detection ───

/**
 * Analyze a message and determine if it should be auto-anchored.
 * 
 * @param {object} message - { role, content }
 * @param {object} context - { isFirstMessage, hasToolOutput, taskState }
 * @returns {{ shouldAnchor: boolean, reason: string, priority: number } | null}
 */
export function detectAnchorCandidate(message, context = {}) {
  if (!message || !message.content) return null;
  
  const content = message.content;
  const contentLower = content.toLowerCase();
  
  // Rule 1: First user message (sets the task goal)
  if (context.isFirstMessage && message.role === 'user') {
    return { shouldAnchor: true, reason: 'user_goal', priority: 9 };
  }
  
  // Rule 2: Messages with explicit decisions or conclusions
  const decisionPatterns = [
    /(?:决定|确定|选择|采用|使用|方案是|结论是|最终)/i,
    /(?:let'?s go with|decided to|conclusion is|we'?ll use|final answer)/i,
  ];
  if (decisionPatterns.some(p => p.test(content))) {
    return { shouldAnchor: true, reason: 'key_decision', priority: 7 };
  }
  
  // Rule 3: Tool outputs with structured data (code blocks, JSON, tables)
  if (context.hasToolOutput || (message.role === 'assistant' && (
    content.includes('```') && content.length > 500
  ))) {
    // Only anchor if it contains meaningful structured output
    const codeBlocks = content.match(/```[\s\S]*?```/g);
    if (codeBlocks && codeBlocks.some(b => b.length > 200)) {
      return { shouldAnchor: true, reason: 'tool_output', priority: 6 };
    }
  }
  
  // Rule 4: Messages with explicit constraints or requirements
  const constraintPatterns = [
    /(?:必须|不能|要求|限制|约束|前提|条件是)/i,
    /(?:must|cannot|require|constraint|prerequisite|condition is)/i,
  ];
  if (message.role === 'user' && constraintPatterns.some(p => p.test(content))) {
    return { shouldAnchor: true, reason: 'constraint', priority: 8 };
  }
  
  return null;
}

// ─── Session Cleanup ───

/**
 * Clear buffer state for a session.
 */
export function clearBuffer(sessionKey) {
  _buffers.delete(sessionKey);
}

/**
 * Get buffer stats for monitoring.
 */
export function getBufferStats() {
  const stats = {};
  for (const [key, buffer] of _buffers.entries()) {
    stats[key] = {
      anchors: buffer.anchors.length,
      hasColdSummary: !!buffer.coldSummary,
      coldMessageCount: buffer.coldMessageCount,
      lastUpdate: new Date(buffer.lastUpdate).toISOString(),
    };
  }
  return stats;
}

// ─── [R14-T1] Checkpoint DB Singleton ───
let _checkpointDb = null;
function getCheckpointDb() {
  if (_checkpointDb) return _checkpointDb;
  try {
    _checkpointDb = new Database('/opt/rangerai-agent/db/rangerai.db');
    _checkpointDb.pragma('journal_mode = WAL');
    _checkpointDb.pragma('busy_timeout = 5000');
  } catch (e) {
    logger.warn(`[R14-T1] Failed to open checkpoint DB: ${e.message}`);
    return null;
  }
  return _checkpointDb;
}

/**
 * [R14-T1] Save a context checkpoint after step completion.
 * Uses a singleton DB connection instead of creating one per call.
 * 
 * @param {string} sessionKey
 * @param {string} msgId
 * @param {string} stepId
 * @param {Array} messages - Full conversation messages array
 */
export function saveContextCheckpoint(sessionKey, msgId, stepId, messages) {
  try {
    const db = getCheckpointDb();
    if (!db) return;
    const hotMsgs = (messages || []).slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content.substring(0, 500) : '(non-text)'
    }));
    const anchors = getAnchors(sessionKey) || [];
    const tokenEst = Math.ceil(
      (messages || []).reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 3.5
    );
    db.prepare(`
      INSERT INTO context_checkpoints (session_key, msg_id, step_id, hot_messages, anchors, token_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionKey, msgId, stepId, JSON.stringify(hotMsgs), JSON.stringify(anchors), tokenEst, Date.now());
    logger.info(`[R14-T1] Checkpoint saved: session=${sessionKey}, step=${stepId}, tokens=${tokenEst}`);
  } catch (err) {
    logger.warn(`[R14-T1] Checkpoint save failed (non-fatal): ${err.message}`);
  }
}

export { BUFFER_CONFIG };
