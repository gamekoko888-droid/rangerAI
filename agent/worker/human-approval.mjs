// ─── Human Approval Layer: CRIT Operation Gating ───
//
// Three-tier operation classification:
// - LOW (read-only): Auto-approve, no logging
// - MED (reversible writes): Auto-approve + mandatory audit log
// - CRIT (high-risk / deploy): Block execution, send approval request via WebSocket
//
// Integration: Called from tool-orchestrator.mjs when a CRITICAL tool is detected.
// Approval channel: WebSocket event → frontend renders [Approve/Reject] buttons.
// Timeout: Auto-reject after configurable timeout (default 120s).

import { sendEvent } from "./ipc-utils.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();
let _approvalStatsTimer = null;

// ─── Configuration ───
const CONFIG = {
  // Approval timeout
  APPROVAL_TIMEOUT_MS: 120_000,  // 2 minutes — auto-reject if no response

  // Audit log retention
  AUDIT_LOG_MAX_ENTRIES: 1000,

  // Operation tiers
  TIER_LOW: 'low',       // Read-only: auto-approve, no log
  TIER_MED: 'med',       // Reversible write: auto-approve + audit log
  TIER_CRIT: 'crit',     // High-risk: block + approval request
};

// ─── Pending approvals (in-memory, keyed by approvalId) ───
const _pendingApprovals = new Map();

// ─── SQLite direct access for audit logs ───
let _db = null;
async function getDb() {
  if (_db) return _db;
  try {
    const { default: Database } = await import('better-sqlite3');
    _db = new Database('/opt/rangerai-agent/db/rangerai.db');
    // TD-019: WAL mode + busy_timeout for concurrent access safety
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    let _busyCount = 0;
    let _queryCount = 0;
    const _origPrepare = _db.prepare.bind(_db);
    _db.prepare = function(sql) {
      _queryCount++;
      return _origPrepare(sql);
    };
    // Periodic stats log (every 15 min)
    _approvalStatsTimer = setInterval(() => {
      logger.info(`[${ts()}] [approval] [SQLite-STATS] queries=${_queryCount} busy=${_busyCount}`);
      _queryCount = 0;
      _busyCount = 0;
    }, 15 * 60 * 1000);
    if (_approvalStatsTimer.unref) _approvalStatsTimer.unref();
    return _db;
  } catch (err) {
    logger.warn(`[${ts()}] [approval] SQLite init failed: ${err.message}`);
    return null;
  }
}

// ─── Operation Tier Classification ───

/**
 * Classify an operation into LOW/MED/CRIT tier.
 * Uses the safety class from tool-orchestrator.mjs as input.
 */
export function classifyOperationTier(toolName, args, safetyClass) {
  // CRITICAL from orchestrator → CRIT tier
  if (safetyClass === 'critical') {
    return {
      tier: CONFIG.TIER_CRIT,
      reason: getCritReason(toolName, args),
      requiresApproval: true,
    };
  }

  // STATE_MUTATING from orchestrator → MED tier
  if (safetyClass === 'state_mutating') {
    return {
      tier: CONFIG.TIER_MED,
      reason: `State-modifying operation: ${toolName}`,
      requiresApproval: false,
    };
  }

  // CONCURRENT_SAFE → LOW tier
  return {
    tier: CONFIG.TIER_LOW,
    reason: null,
    requiresApproval: false,
  };
}

function getCritReason(toolName, args) {
  const cmd = typeof args === 'string' ? args : (args?.command || args?.cmd || JSON.stringify(args) || '');
  const reasons = [];

  if (/systemctl\s+(restart|stop|disable)/.test(cmd)) reasons.push('Service lifecycle change');
  if (/rm\s+-rf\s+\/(opt|etc|home|var)/.test(cmd)) reasons.push('Destructive file deletion');
  if (/git\s+push\s+--force/.test(cmd)) reasons.push('Force push to remote');
  if (/DROP\s+(TABLE|DATABASE)/i.test(cmd)) reasons.push('Database schema destruction');
  if (/docker\s+(rm|rmi|system\s+prune)/.test(cmd)) reasons.push('Container/image removal');
  if (/npm\s+publish/.test(cmd)) reasons.push('Package publication');
  if (/chmod\s+777/.test(cmd)) reasons.push('Insecure permission change');
  if (/iptables|ufw/.test(cmd)) reasons.push('Firewall rule change');

  return reasons.length > 0 ? reasons.join('; ') : `High-risk operation: ${toolName}`;
}

// ─── Audit Logging ───

/**
 * Write an audit log entry for MED/CRIT operations.
 */
export async function writeAuditLog(toolName, args, tier, decision, userId = 'system', details = '') {
  try {
    const db = await getDb();
    if (!db) {
      logger.info(`[${ts()}] [audit] DB unavailable, logging to console: ${tier} ${toolName} → ${decision}`);
      return;
    }

    const argsStr = typeof args === 'string' ? args.slice(0, 500) : JSON.stringify(args).slice(0, 500);

    db.prepare(`
      INSERT INTO audit_logs (userId, action, target, details, ip, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      `${tier.toUpperCase()}_${decision.toUpperCase()}`,
      toolName,
      JSON.stringify({ args: argsStr, details, tier }),
      'worker',
      new Date().toISOString()
    );

    logger.info(`[${ts()}] [audit] ${tier.toUpperCase()} ${toolName} → ${decision} (user: ${userId})`);

    // Enforce max entries
    const count = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get();
    if (count.cnt > CONFIG.AUDIT_LOG_MAX_ENTRIES) {
      db.prepare(`
        DELETE FROM audit_logs WHERE id IN (
          SELECT id FROM audit_logs ORDER BY createdAt ASC LIMIT ?
        )
      `).run(count.cnt - CONFIG.AUDIT_LOG_MAX_ENTRIES);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [audit] writeAuditLog failed: ${err.message}`);
  }
}

// ─── Approval Request/Response ───

/**
 * Request human approval for a CRIT operation.
 * Sends a WebSocket event to the frontend and waits for response.
 * Returns: { approved: boolean, approvedBy: string|null, timedOut: boolean }
 */
export function requestApproval(msgId, toolName, args, reason) {
  const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const argsPreview = typeof args === 'string' ? args.slice(0, 300) : JSON.stringify(args).slice(0, 300);

  return new Promise((resolve) => {
    // Store pending approval
    const approvalState = {
      id: approvalId,
      toolName,
      args: argsPreview,
      reason,
      createdAt: Date.now(),
      resolved: false,
    };

    _pendingApprovals.set(approvalId, {
      ...approvalState,
      resolve,
    });

    // Send approval request to frontend
    sendEvent(msgId, {
      type: 'approval_request',
      approvalId,
      toolName,
      argsPreview,
      reason,
      timeoutMs: CONFIG.APPROVAL_TIMEOUT_MS,
      actions: [
        { label: '✅ 批准执行', value: 'approve', style: 'primary' },
        { label: '❌ 拒绝执行', value: 'reject', style: 'danger' },
      ],
    });

    logger.info(`[${ts()}] [approval] 🔴 CRIT approval requested: ${approvalId} | ${toolName} | ${reason}`);

    // Auto-reject timeout
    const timer = setTimeout(() => {
      if (!_pendingApprovals.has(approvalId)) return;
      const pending = _pendingApprovals.get(approvalId);
      if (pending.resolved) return;

      pending.resolved = true;
      _pendingApprovals.delete(approvalId);

      logger.info(`[${ts()}] [approval] ⏱️ Approval ${approvalId} timed out after ${CONFIG.APPROVAL_TIMEOUT_MS / 1000}s — auto-rejecting`);

      sendEvent(msgId, {
        type: 'approval_timeout',
        approvalId,
        toolName,
      });

      resolve({
        approved: false,
        approvedBy: null,
        timedOut: true,
        approvalId,
      });
    }, CONFIG.APPROVAL_TIMEOUT_MS);

    // Store timer ref for cleanup
    _pendingApprovals.get(approvalId).timer = timer;
  });
}

/**
 * Handle an approval response from the frontend.
 * Called when the user clicks [Approve] or [Reject].
 */
export function handleApprovalResponse(approvalId, decision, userId = 'unknown') {
  const pending = _pendingApprovals.get(approvalId);
  if (!pending) {
    logger.warn(`[${ts()}] [approval] Unknown or expired approval: ${approvalId}`);
    return false;
  }

  if (pending.resolved) {
    logger.warn(`[${ts()}] [approval] Approval ${approvalId} already resolved`);
    return false;
  }

  pending.resolved = true;
  clearTimeout(pending.timer);
  _pendingApprovals.delete(approvalId);

  const approved = decision === 'approve';
  logger.info(`[${ts()}] [approval] ${approved ? '✅' : '❌'} Approval ${approvalId} ${decision} by ${userId}`);

  pending.resolve({
    approved,
    approvedBy: userId,
    timedOut: false,
    approvalId,
  });

  return true;
}

// ─── Gate Function (main entry point) ───

/**
 * Gate a tool execution through the approval system.
 * Returns: { allowed: boolean, tier: string, reason: string|null }
 *
 * Usage in openclaw-handler.mjs:
 *   const gate = await gateToolExecution(msgId, toolName, args, safetyClass, userId);
 *   if (!gate.allowed) { // skip tool or notify user }
 */
export async function gateToolExecution(msgId, toolName, args, safetyClass, userId = 'system') {
  const classification = classifyOperationTier(toolName, args, safetyClass);

  // LOW: pass through silently
  if (classification.tier === CONFIG.TIER_LOW) {
    return { allowed: true, tier: CONFIG.TIER_LOW, reason: null };
  }

  // MED: auto-approve + audit log
  if (classification.tier === CONFIG.TIER_MED) {
    // Fire-and-forget audit log
    writeAuditLog(toolName, args, CONFIG.TIER_MED, 'auto_approved', userId).catch(() => {});
    return { allowed: true, tier: CONFIG.TIER_MED, reason: classification.reason };
  }

  // CRIT: request approval
  if (classification.tier === CONFIG.TIER_CRIT) {
    // Log the attempt
    await writeAuditLog(toolName, args, CONFIG.TIER_CRIT, 'pending', userId, classification.reason);

    // Request approval (blocks until response or timeout)
    const result = await requestApproval(msgId, toolName, args, classification.reason);

    // Log the decision
    const decision = result.approved ? 'approved' : (result.timedOut ? 'timeout_rejected' : 'rejected');
    await writeAuditLog(toolName, args, CONFIG.TIER_CRIT, decision, result.approvedBy || userId);

    if (!result.approved) {
      sendEvent(msgId, {
        type: 'approval_result',
        approvalId: result.approvalId,
        approved: false,
        reason: result.timedOut ? '操作审批超时，已自动拒绝' : '操作已被拒绝',
        toolName,
      });
    } else {
      sendEvent(msgId, {
        type: 'approval_result',
        approvalId: result.approvalId,
        approved: true,
        reason: '操作已批准执行',
        toolName,
      });
    }

    return {
      allowed: result.approved,
      tier: CONFIG.TIER_CRIT,
      reason: result.approved ? 'Approved by user' : (result.timedOut ? 'Auto-rejected (timeout)' : 'Rejected by user'),
    };
  }

  // Fallback: allow
  return { allowed: true, tier: 'unknown', reason: null };
}

// ─── Stats ───

export function getApprovalStats() {
  return {
    pendingCount: _pendingApprovals.size,
    pendingIds: [..._pendingApprovals.keys()],
  };
}

export function cleanupHumanApprovalResources() {
  if (_approvalStatsTimer) {
    clearInterval(_approvalStatsTimer);
    _approvalStatsTimer = null;
  }
}

export { CONFIG as APPROVAL_CONFIG };
