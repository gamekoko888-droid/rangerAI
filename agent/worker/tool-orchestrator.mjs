// ─── Tool Orchestrator v2.0: Active Interception Layer ───
//
// Three enforcement rules:
// Rule 1 — STATE_MUTATING mutex: serialize within session (30s queue timeout)
// Rule 2 — CRITICAL confirmation: 15s user approval timeout, auto-reject
// Rule 3 — Concurrency cap: max 3 tools per session (queue overflow)

import { sendEvent } from "./ipc-utils.mjs";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { logger } from '../lib/logger.mjs';
import { validatePermission, PERMISSION_TIERS, logPermissionCheck, recordPermissionCheck } from './tool-permission.mjs';
import { gateToolExecution } from './human-approval.mjs';
import { recordToolExecution } from './observability.mjs';
import { classifyFailure, getRecoveryStrategy } from './failure-recovery.mjs';

// ─── Role × Tool Matrix (P0-1) ───
let _roleToolMatrix = null;
function getRoleToolMatrix() {
  if (_roleToolMatrix) return _roleToolMatrix;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const configPath = join(dirname(__filename), '../config/role-tool-matrix.json');
    _roleToolMatrix = JSON.parse(readFileSync(configPath, 'utf8'));
    logger.info(`[tool-orchestrator] Role-tool matrix loaded (v${_roleToolMatrix._version})`);
  } catch (e) {
    logger.info(`[tool-orchestrator] WARNING: Could not load role-tool-matrix.json: ${e.message}`);
    _roleToolMatrix = null;
  }
  return _roleToolMatrix;
}

/**
 * Check if a role is allowed to use a tool group.
 * Returns { allowed: bool, group: string|null, reason: string|null }
 */
function checkRoleToolPermission(toolName, userRole) {
  const matrix = getRoleToolMatrix();
  if (!matrix || !matrix.matrix) return { allowed: true, group: null, reason: null };

  const rolePerms = matrix.matrix[userRole];
  if (!rolePerms) return { allowed: true, group: null, reason: null }; // unknown role → allow (fail-open)

  // Find which group the tool belongs to
  for (const [group, tools] of Object.entries(matrix._groups || {})) {
    if (tools.includes(toolName)) {
      const allowed = rolePerms[group] === true;
      if (!allowed) {
        return {
          allowed: false,
          group,
          reason: `[Permission Denied] Role '${userRole}' cannot use '${group}' group tools (${toolName}).`,
        };
      }
      return { allowed: true, group, reason: null };
    }
  }

  // Tool not in any group → allow (conservative: don't block unknown tools)
  return { allowed: true, group: null, reason: null };
}

// ─── Tool Safety Classification ───
const TOOL_CLASSES = {
  CONCURRENT_SAFE: 'concurrent_safe',
  STATE_MUTATING: 'state_mutating',
  CRITICAL: 'critical',
};

// Static tool name → class mapping
const STATIC_TOOL_MAP = {
  // ── Concurrent Safe (read-only) ──
  'read': TOOL_CLASSES.CONCURRENT_SAFE,
  'read_file': TOOL_CLASSES.CONCURRENT_SAFE,
  'web_search': TOOL_CLASSES.CONCURRENT_SAFE,
  'web_fetch': TOOL_CLASSES.CONCURRENT_SAFE,
  'memory_search': TOOL_CLASSES.CONCURRENT_SAFE,
  'memory_get': TOOL_CLASSES.CONCURRENT_SAFE,
  'image': TOOL_CLASSES.CONCURRENT_SAFE,
  'tts': TOOL_CLASSES.CONCURRENT_SAFE,
  'canvas': TOOL_CLASSES.CONCURRENT_SAFE,
  'code': TOOL_CLASSES.CONCURRENT_SAFE,

  // ── [R30-T4] Image Generation ──
  'generate_image': TOOL_CLASSES.STATE_MUTATING,
  'transcribe_audio': TOOL_CLASSES.STATE_MUTATING,
  "speak_text": TOOL_CLASSES.STATE_MUTATING,
  "analyze_image": TOOL_CLASSES.STATE_MUTATING,
  "analyze_video": TOOL_CLASSES.STATE_MUTATING,   // [R44-T6]
  "analyze_audio": TOOL_CLASSES.STATE_MUTATING,   // [R44-T6]
  "analyze_document": TOOL_CLASSES.STATE_MUTATING, // [R44-T6]

  // ── State Mutating ──
  'write': TOOL_CLASSES.STATE_MUTATING,
  'write_file': TOOL_CLASSES.STATE_MUTATING,
  'edit': TOOL_CLASSES.STATE_MUTATING,
  'edit_file': TOOL_CLASSES.STATE_MUTATING,
  'create_file': TOOL_CLASSES.STATE_MUTATING,
  'sessions': TOOL_CLASSES.STATE_MUTATING,
  'sessions_spawn': TOOL_CLASSES.STATE_MUTATING,
  'sessions_send': TOOL_CLASSES.STATE_MUTATING,
  'sessions_list': TOOL_CLASSES.CONCURRENT_SAFE,
  'subagents': TOOL_CLASSES.STATE_MUTATING,
  'prose': TOOL_CLASSES.STATE_MUTATING,
  'cron': TOOL_CLASSES.STATE_MUTATING,
  'message': TOOL_CLASSES.STATE_MUTATING,
};

// ─── Read-only exec command patterns ───
const EXEC_READ_ONLY_PATTERNS = [
  /^\s*(cat|head|tail|less|more)\s/,
  /^\s*(ls|find|locate|which|whereis)\s/,
  /^\s*(grep|rg|ag|ack)\s/,
  /^\s*(wc|du|df|stat|file)\s/,
  /^\s*(ps|top|htop|free|uptime|vmstat|iostat)\s/,
  /^\s*(echo|printf)\s/,
  /^\s*(date|hostname|uname|whoami|id|groups)\s*$/,
  /^\s*(env|printenv|set)\s*$/,
  /^\s*git\s+(log|status|diff|show|branch|tag|remote|rev-parse|describe|shortlog)\s/,
  /^\s*git\s+(log|status|diff|show|branch|tag|remote|rev-parse|describe|shortlog)\s*$/,
  /^\s*docker\s+(ps|images|logs|inspect|stats|version|info|top)\s/,
  /^\s*docker\s+(ps|images|logs|inspect|stats|version|info|top)\s*$/,
  /^\s*systemctl\s+(status|is-active|is-enabled|list-units|show)\s/,
  /^\s*systemctl\s+(status|is-active|is-enabled|list-units|show)\s*$/,
  /^\s*journalctl\s/,
  /^\s*(node|python3?)\s+-e\s/,
  /^\s*sqlite3\s+.*\s+("|')\s*(SELECT|PRAGMA|\.tables|\.schema)/i,
  /^\s*curl\s/,
  /^\s*wget\s+.*-O\s*-/,
  /^\s*npm\s+(list|ls|view|info|outdated|audit|search)\s/,
  /^\s*npm\s+(list|ls|view|info|outdated|audit|search)\s*$/,
  /^\s*npx\s/,
  /^\s*ping\s/,
  /^\s*dig\s/,
  /^\s*nslookup\s/,
  /^\s*ss\s/,
  /^\s*netstat\s/,
  /^\s*sed\s+-n\s/,
  /^\s*awk\s/,
  /^\s*sort\s/,
  /^\s*uniq\s/,
  /^\s*cut\s/,
  /^\s*tr\s/,
  /^\s*diff\s/,
  /^\s*md5sum\s/,
  /^\s*sha256sum\s/,
  /^\s*test\s/,
  /^\s*\[\s/,
  /^\s*sleep\s/,
  /^\s*true\s*$/,
  /^\s*false\s*$/,
];

// ─── Critical exec command patterns ───
const EXEC_CRITICAL_PATTERNS = [
  /systemctl\s+(restart|stop|start|enable|disable)\s/,
  /rm\s+(-rf?|--recursive)\s+\/(opt|etc|home|var)/,
  /docker\s+(rm|rmi|stop|kill|restart)\s/,
  /\b(reboot|shutdown|halt|poweroff)\b/,
  /caddy\s+(reload|stop|start)/,
  /nginx\s+(-s\s+)?(reload|stop|quit)/,
  /\bsudo\s+(rm|mv|cp|chmod|chown)\s.*\/(etc|opt|usr)/,
  /npm\s+(publish|unpublish)/,
  /git\s+(push|reset\s+--hard|force-push)/,
  /\bDROP\s+(TABLE|DATABASE)/i,
  /\bTRUNCATE\s+TABLE/i,
  /\bDELETE\s+FROM\s+\w+\s*$/i,
];

// ─── Browser read-only actions ───
const BROWSER_READ_ONLY_ACTIONS = new Set([
  'navigate', 'screenshot', 'scroll', 'evaluate', 'get_text', 'get_html',
  'wait', 'wait_for', 'get_url', 'get_title',
]);

function classifyExecCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return TOOL_CLASSES.STATE_MUTATING;
  const trimmed = cmd.trim();
  if (EXEC_CRITICAL_PATTERNS.some(p => p.test(trimmed))) return TOOL_CLASSES.CRITICAL;
  const hasWriteRedirect = /\s*>{1,2}\s*[^&]/.test(trimmed);
  if (hasWriteRedirect) return TOOL_CLASSES.STATE_MUTATING;
  if (EXEC_READ_ONLY_PATTERNS.some(p => p.test(trimmed))) return TOOL_CLASSES.CONCURRENT_SAFE;
  const pipeSegments = trimmed.split(/\s*\|\s*/);
  if (pipeSegments.length > 1) {
    const allSafe = pipeSegments.every(seg =>
      EXEC_READ_ONLY_PATTERNS.some(p => p.test(seg.trim()))
    );
    if (allSafe) return TOOL_CLASSES.CONCURRENT_SAFE;
  }
  return TOOL_CLASSES.STATE_MUTATING;
}

function classifyBrowserAction(args) {
  const action = args?.action || '';
  if (BROWSER_READ_ONLY_ACTIONS.has(action)) return TOOL_CLASSES.CONCURRENT_SAFE;
  return TOOL_CLASSES.STATE_MUTATING;
}

// ─── R54: Active Interception Configuration ───
const ACTIVE_CONFIG = {
  MUTEX_QUEUE_TIMEOUT_MS: 30_000,      // Rule 1: max wait time for mutex queue
  CONFIRM_TIMEOUT_MS: 15_000,          // Rule 2: user confirmation timeout
  MAX_CONCURRENT_TOOLS: 3,             // Rule 3: max concurrent tools per session
  CONCURRENCY_QUEUE_TIMEOUT_MS: 10_000, // Rule 3: max wait time in concurrency queue
};

// ─── Orchestrator Factory ───
export function createToolOrchestrator(msgId, userRole = 'member') {
  // Active tool tracking
  const activeTools = new Map();
  const conflictLog = [];
  const classificationHistory = [];

  let mutexLocked = false;
  const mutexQueue = [];     // Array of { resolve, reject, timer, toolName }
  let activeConcurrentCount = 0;
  const concurrencyQueue = []; // Array of { resolve, reject, timer, toolName }

  const pendingConfirmations = new Map(); // confirmId → { resolve, timer }

  const _confirmListener = ({ confirmId, approved }) => {
    const pending = pendingConfirmations.get(confirmId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingConfirmations.delete(confirmId);
      logger.info(`[${new Date().toISOString()}] [orchestrator] ${approved ? '✅' : '❌'} Confirmation ${confirmId}: ${approved ? 'approved' : 'rejected'} (via IPC)`);
      pending.resolve({ confirmed: approved, reason: approved ? 'User approved' : 'User rejected' });
    }
  };
  process.on('tool_confirm_response', _confirmListener);

  const stats = {
    totalConcurrentSafe: 0,
    totalStateMutating: 0,
    totalCritical: 0,
    concurrentConflicts: 0,
    maxConcurrentTools: 0,
    maxConcurrentMutating: 0,
    parallelizableWindows: 0,
    // R54 new stats
    mutexWaits: 0,
    mutexTimeouts: 0,
    confirmRequests: 0,
    confirmApproved: 0,
    confirmRejected: 0,
    confirmTimeouts: 0,
    concurrencyQueueWaits: 0,
    concurrencyQueueTimeouts: 0,
  };

  let consecutiveReadOnly = 0;
  let maxConsecutiveReadOnly = 0;

  const ts = () => new Date().toISOString();

  // ─── Rule 1: STATE_MUTATING Mutex ───
  function acquireMutex(toolName) {
    if (!mutexLocked) {
      mutexLocked = true;
      logger.info(`[${ts()}] [orchestrator] 🔒 Mutex acquired: ${toolName}`);
      return Promise.resolve();
    }

    stats.mutexWaits++;
    logger.info(`[${ts()}] [orchestrator] ⏳ Mutex queued: ${toolName} (queue size: ${mutexQueue.length + 1})`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = mutexQueue.findIndex(q => q.resolve === resolve);
        if (idx !== -1) mutexQueue.splice(idx, 1);
        stats.mutexTimeouts++;
        logger.info(`[${ts()}] [orchestrator] ⏱️ Mutex timeout: ${toolName} after ${ACTIVE_CONFIG.MUTEX_QUEUE_TIMEOUT_MS / 1000}s`);
        reject(new Error(`Tool conflict: another state-mutating tool is running (waited ${ACTIVE_CONFIG.MUTEX_QUEUE_TIMEOUT_MS / 1000}s)`));
      }, ACTIVE_CONFIG.MUTEX_QUEUE_TIMEOUT_MS);

      mutexQueue.push({ resolve, reject, timer, toolName });
    });
  }

  function releaseMutex() {
    if (mutexQueue.length > 0) {
      const next = mutexQueue.shift();
      clearTimeout(next.timer);
      logger.info(`[${ts()}] [orchestrator] 🔓 Mutex passed to: ${next.toolName}`);
      next.resolve();
    } else {
      mutexLocked = false;
      logger.info(`[${ts()}] [orchestrator] 🔓 Mutex released`);
    }
  }

  // ─── Rule 2: CRITICAL Confirmation ───
  function requestConfirmation(toolId, toolName, toolArgs) {
    stats.confirmRequests++;
    const confirmId = `confirm-${toolId}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingConfirmations.has(confirmId)) {
          pendingConfirmations.delete(confirmId);
          stats.confirmTimeouts++;
          logger.info(`[${ts()}] [orchestrator] ⏱️ Confirmation timeout: ${toolName} after ${ACTIVE_CONFIG.CONFIRM_TIMEOUT_MS / 1000}s — auto-rejected`);
          sendEvent(msgId, {
            type: 'tool_confirm_timeout',
            confirmId,
            toolName,
          });
          resolve({ confirmed: false, reason: 'User confirmation timeout (auto-rejected)' });
        }
      }, ACTIVE_CONFIG.CONFIRM_TIMEOUT_MS);

      pendingConfirmations.set(confirmId, { resolve, timer, toolName });

      // Send confirmation request to frontend
      const argsPreview = typeof toolArgs === 'string' ? toolArgs.slice(0, 300) : JSON.stringify(toolArgs).slice(0, 300);
      sendEvent(msgId, {
        type: 'tool_confirm_required',
        confirmId,
        toolName,
        argsPreview,
        timeoutMs: ACTIVE_CONFIG.CONFIRM_TIMEOUT_MS,
        message: `⚠️ 高危操作确认: ${toolName}`,
      });

      logger.info(`[${ts()}] [orchestrator] 🔴 CRITICAL confirmation requested: ${confirmId} | ${toolName}`);
    });
  }

  // ─── Rule 3: Concurrency Cap ───
  function acquireConcurrencySlot(toolName) {
    if (activeConcurrentCount < ACTIVE_CONFIG.MAX_CONCURRENT_TOOLS) {
      activeConcurrentCount++;
      return Promise.resolve();
    }

    stats.concurrencyQueueWaits++;
    logger.info(`[${ts()}] [orchestrator] ⏳ Concurrency cap reached (${ACTIVE_CONFIG.MAX_CONCURRENT_TOOLS}), queuing: ${toolName}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = concurrencyQueue.findIndex(q => q.resolve === resolve);
        if (idx !== -1) concurrencyQueue.splice(idx, 1);
        stats.concurrencyQueueTimeouts++;
        logger.info(`[${ts()}] [orchestrator] ⏱️ Concurrency queue timeout: ${toolName}`);
        reject(new Error(`Concurrency limit: max ${ACTIVE_CONFIG.MAX_CONCURRENT_TOOLS} tools, queue timeout`));
      }, ACTIVE_CONFIG.CONCURRENCY_QUEUE_TIMEOUT_MS);

      concurrencyQueue.push({ resolve, reject, timer, toolName });
    });
  }

  function releaseConcurrencySlot() {
    if (concurrencyQueue.length > 0) {
      const next = concurrencyQueue.shift();
      clearTimeout(next.timer);
      logger.info(`[${ts()}] [orchestrator] 🔓 Concurrency slot freed for: ${next.toolName}`);
      next.resolve();
    } else {
      activeConcurrentCount = Math.max(0, activeConcurrentCount - 1);
    }
  }

  return {
    /**
     * R54: Main entry point — classify + enforce all 3 rules.
     * Returns: { safetyClass, warning, isCritical, blocked, blockReason }
     * If blocked === true, the tool should NOT execute.
     *
     * This is an async function that may wait for mutex or confirmation.
     */
    async acquireExecution(toolId, toolName, rawArgs) {
      // Parse args
      let args = {};
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
      } catch { args = {}; }

      
      // ─── Rule -1: Self-Restart Protection (ABSOLUTE BLOCK for ALL roles) ───
      // Prevents Gateway from killing its own Worker process mid-execution.
      // This applies to ALL roles including admin — no exceptions.
      if (toolName === 'exec') {
        const cmd = args.command || args.cmd || (typeof rawArgs === 'string' ? rawArgs : '');
        const SELF_DESTRUCT_PATTERNS = [
          /systemctl\s+(restart|stop)\s+rangerai-ws/,
          /systemctl\s+(restart|stop)\s+rangerai-agent/,
          /kill\s+(-9\s+)?\$\$/, // kill own process
          /pkill\s+.*node.*ws-realtime/,
          /defer-restart/,                   // Block defer-restart.sh (causes delayed self-restart)
        ];
        if (SELF_DESTRUCT_PATTERNS.some(p => p.test(cmd))) {
          const reason = `[HARD BLOCK] Cannot restart/stop own service during execution. Mark [NEEDS_RESTART: rangerai-ws] in your reply instead.`;
          logger.info(`[${ts()}] [orchestrator] 🛑 Rule -1 HARD BLOCK (self-restart): ${cmd.slice(0,100)} for role=${userRole}`);
          return { safetyClass: 'self_restart_blocked', warning: reason, isCritical: true, blocked: true, blockReason: reason };
        }
      }

      // ─── Rule 0: Ranger Self-Protection (HARD BLOCK) ───
      // Only blocks non-admin users from modifying Ranger's own code, config, and server infrastructure.
      // Normal development, writing, programming tasks are fully allowed for all roles.
      // RBAC v2: Only admin has unrestricted tool access (manager is now restricted)
      const ADMIN_ROLES = new Set(['admin']);
      if (!ADMIN_ROLES.has(userRole)) {
        // Protected paths: Ranger source code, system config, service management
        const PROTECTED_PATH_PATTERNS = [
          /\/opt\/rangerai/i,           // Ranger agent/ws/web code
          /\/etc\/(caddy|nginx|systemd)/i, // Reverse proxy & service config
          /\/etc\/environment/i,         // System env vars
          /rangerai-(agent|ws|web)/i,    // Ranger service names in any context
        ];
        // Dangerous system commands (regardless of path)
        const SYSTEM_CMD_PATTERNS = [
          /\bsudo\b/,
          /\b(reboot|shutdown|halt|poweroff)\b/,
          /\bsystemctl\s+(restart|stop|start|enable|disable)\s+rangerai/,
          /\bcaddy\s+(reload|stop|start|restart)/,
          /\bnginx\s+(-s\s+)?(reload|stop|quit)/,
        ];

        const filePath = args.file_path || args.path || args.filename || '';

        // Block read/write/edit to Ranger protected paths
        if (['read', 'read_file', 'write', 'write_file', 'edit', 'edit_file', 'create_file'].includes(toolName)) {
          const isProtected = PROTECTED_PATH_PATTERNS.some(p => p.test(filePath));
          if (isProtected) {
            const reason = `[Permission Denied] Role '${userRole}' cannot access Ranger system files (${filePath}). Admin access required.`;
            logger.info(`[${ts()}] [orchestrator] 🚫 Rule 0 BLOCKED ${toolName} on protected path: ${filePath} for role=${userRole}`);
            return { safetyClass: 'role_blocked', warning: reason, isCritical: false, blocked: true, blockReason: reason, roleBlocked: true };
          }
        }

        // Block exec commands that target Ranger or system infrastructure
        if (toolName === 'exec') {
          const cmd = args.command || args.cmd || (typeof rawArgs === 'string' ? rawArgs : '');
          // Check dangerous system commands
          const isDangerousCmd = SYSTEM_CMD_PATTERNS.some(p => p.test(cmd));
          if (isDangerousCmd) {
            const reason = `[Permission Denied] Role '${userRole}' cannot run system management commands. Admin access required.`;
            logger.info(`[${ts()}] [orchestrator] 🚫 Rule 0 BLOCKED exec (system cmd): ${cmd.slice(0,100)} for role=${userRole}`);
            return { safetyClass: 'role_blocked', warning: reason, isCritical: false, blocked: true, blockReason: reason, roleBlocked: true };
          }
          // Check if command reads or writes to protected paths
          const touchesProtected = PROTECTED_PATH_PATTERNS.some(p => p.test(cmd));
          if (touchesProtected) {
            const reason = `[Permission Denied] Role '${userRole}' cannot access Ranger system files via shell. Admin access required.`;
            logger.info(`[${ts()}] [orchestrator] 🚫 Rule 0 BLOCKED exec (access protected): ${cmd.slice(0,100)} for role=${userRole}`);
            return { safetyClass: 'role_blocked', warning: reason, isCritical: false, blocked: true, blockReason: reason, roleBlocked: true };
          }
        }
      }

      // ─── Rule 0.25: Role × Tool Matrix (P0-1) ───
      // Enforce per-role tool group restrictions before any execution.
      // Admin bypasses matrix (same as Rule 0). Only non-admin roles are checked.
      if (!['admin'].includes(userRole)) {
        const matrixCheck = checkRoleToolPermission(toolName, userRole);
        if (!matrixCheck.allowed) {
          logger.info(`[${ts()}] [orchestrator] 🚫 Rule 0.25 MATRIX BLOCK: ${toolName} (group=${matrixCheck.group}) for role=${userRole}`);
          return {
            safetyClass: 'role_matrix_blocked',
            warning: matrixCheck.reason,
            isCritical: false,
            blocked: true,
            blockReason: matrixCheck.reason,
            roleBlocked: true,
          };
        }
      }

      // ─── Pre-classify for permission chain ───
      let safetyClass;
      if (toolName === 'exec') {
        const cmd_pre = args.command || args.cmd || (typeof rawArgs === 'string' ? rawArgs : '');
        safetyClass = classifyExecCommand(cmd_pre);
      } else if (toolName === 'browser') {
        safetyClass = classifyBrowserAction(args);
      } else {
        safetyClass = STATIC_TOOL_MAP[toolName] || TOOL_CLASSES.STATE_MUTATING;
      }
      
      // ─── Rule 0.5: Permission Chain (Iter-B) ───
      // Three-tier permission system:
      // - READONLY: file_read, grep, glob → zero overhead, whitelist passthrough
      // - HIGH: file write, exec commands → requires approval via human-approval.mjs
      // - CRITICAL: rm -rf /, DROP TABLE → force user confirmation, reject blocks execution
      
      const permissionCheck = validatePermission(toolName, args);
      
      // READONLY tier: zero-cost passthrough
      if (permissionCheck.tier === PERMISSION_TIERS.READONLY) {
        logPermissionCheck(toolName, permissionCheck.tier, true, userRole);
        recordPermissionCheck(permissionCheck.tier, true, toolName, permissionCheck.reason); // [R13-T7]
        // Continue to next rule (no blocking)
      }
      // HIGH/CRITICAL tier: require approval via human-approval.mjs
      else if (permissionCheck.requiresApproval) {
        const approvalResult = await gateToolExecution(msgId, toolName, args, safetyClass, userRole);
        if (!approvalResult.allowed) {
          logPermissionCheck(toolName, permissionCheck.tier, false, userRole);
          recordPermissionCheck(permissionCheck.tier, false, toolName, permissionCheck.reason); // [R13-T7]
          logger.info(`[${ts()}] [orchestrator] 🚫 Rule 0.5 BLOCKED by permission chain: ${toolName} (${permissionCheck.tier})`);
          return {
            safetyClass: permissionCheck.tier,
            warning: approvalResult.reason || permissionCheck.reason,
            isCritical: permissionCheck.tier === PERMISSION_TIERS.CRITICAL,
            blocked: true,
            blockReason: `Permission denied: ${permissionCheck.reason}`,
            permissionBlocked: true,
          };
        }
        logPermissionCheck(toolName, permissionCheck.tier, true, userRole);
        recordPermissionCheck(permissionCheck.tier, true, toolName, permissionCheck.reason); // [R13-T7]
        logger.info(`[${ts()}] [orchestrator] ✅ Rule 0.5 APPROVED: ${toolName} (${permissionCheck.tier})`);
      }



      // Classify (re-assign with detailed classification)
      if (toolName === 'exec') {
        const cmd = args.command || args.cmd || (typeof rawArgs === 'string' ? rawArgs : '');
        safetyClass = classifyExecCommand(cmd);
      } else if (toolName === 'browser') {
        safetyClass = classifyBrowserAction(args);
      } else if (STATIC_TOOL_MAP[toolName]) {
        safetyClass = STATIC_TOOL_MAP[toolName];
      } else {
        safetyClass = TOOL_CLASSES.STATE_MUTATING;
      }

      // Update stats
      if (safetyClass === TOOL_CLASSES.CONCURRENT_SAFE) {
        stats.totalConcurrentSafe++;
        consecutiveReadOnly++;
        maxConsecutiveReadOnly = Math.max(maxConsecutiveReadOnly, consecutiveReadOnly);
      } else {
        if (safetyClass === TOOL_CLASSES.STATE_MUTATING) stats.totalStateMutating++;
        if (safetyClass === TOOL_CLASSES.CRITICAL) stats.totalCritical++;
        consecutiveReadOnly = 0;
      }

      // Log classification
      const classEmoji = safetyClass === TOOL_CLASSES.CONCURRENT_SAFE ? '🟢' :
                          safetyClass === TOOL_CLASSES.STATE_MUTATING ? '🟡' : '🔴';
      logger.info(`[${ts()}] [orchestrator] ${classEmoji} ${toolName} → ${safetyClass} (active: ${activeTools.size})`);

      // Record classification
      classificationHistory.push({
        toolId, toolName, safetyClass, timestamp: Date.now(), concurrent: activeTools.size,
      });

      // Send classification event
      sendEvent(msgId, {
        type: "tool_classified",
        id: toolId,
        tool: toolName,
        safetyClass,
        concurrent: activeTools.size,
      });

      // ─── Rule 3: Concurrency cap (applies to ALL tools) ───
      try {
        await acquireConcurrencySlot(toolName);
      } catch (err) {
        logger.info(`[${ts()}] [orchestrator] ❌ BLOCKED by concurrency cap: ${toolName}`);
        return {
          safetyClass, warning: err.message, isCritical: false,
          blocked: true, blockReason: err.message,
        };
      }

      // ─── Rule 2: CRITICAL confirmation (before mutex, since confirmation is user-facing) ───
      if (safetyClass === TOOL_CLASSES.CRITICAL) {
        const _confirmId = `confirm-${toolId}`; // [R12-T3] mirror the ID used inside requestConfirmation
        const confirmation = await requestConfirmation(toolId, toolName, rawArgs);
        if (!confirmation.confirmed) {
          releaseConcurrencySlot();
          stats.confirmRejected++;
          // [R12-T3] Structured log: REJECT or TIMEOUT branch
          const rejectReason = confirmation.reason || 'User rejected';
          const isTimeout = rejectReason.includes('timeout');
          if (isTimeout) {
            logger.info(`[${ts()}] [R12-T3] CONFIRM_TIMEOUT: ${_confirmId} | tool=${toolName} | timeout=${ACTIVE_CONFIG.CONFIRM_TIMEOUT_MS}ms`);
            sendEvent(msgId, { type: 'tool_confirm_result', confirmId: _confirmId, toolName, branch: 'timeout', reason: rejectReason });
          } else {
            logger.info(`[${ts()}] [R12-T3] CONFIRM_REJECTED: ${_confirmId} | tool=${toolName} | reason=${rejectReason}`);
            sendEvent(msgId, { type: 'tool_confirm_result', confirmId: _confirmId, toolName, branch: 'rejected', reason: rejectReason });
          }
          logger.info(`[${ts()}] [orchestrator] ❌ BLOCKED by confirmation: ${toolName} — ${rejectReason}`);
          return {
            safetyClass, warning: rejectReason, isCritical: true,
            blocked: true, blockReason: rejectReason,
          };
        }
        stats.confirmApproved++;
        // [R12-T3] Structured log: APPROVE branch
        logger.info(`[${ts()}] [R12-T3] CONFIRM_APPROVED: ${_confirmId} | tool=${toolName}`);
        sendEvent(msgId, { type: 'tool_confirm_result', confirmId: _confirmId, toolName, branch: 'approved' });
        logger.info(`[${ts()}] [orchestrator] ✅ CRITICAL confirmed: ${toolName}`);
      }

      // ─── Rule 1: STATE_MUTATING mutex (serialize writes) ───
      if (safetyClass === TOOL_CLASSES.STATE_MUTATING || safetyClass === TOOL_CLASSES.CRITICAL) {
        try {
          await acquireMutex(toolName);
        } catch (err) {
          releaseConcurrencySlot();
          logger.info(`[${ts()}] [orchestrator] ❌ BLOCKED by mutex timeout: ${toolName}`);
          return {
            safetyClass, warning: err.message, isCritical: safetyClass === TOOL_CLASSES.CRITICAL,
            blocked: true, blockReason: err.message,
          };
        }
      }

      // Track active tool
      activeTools.set(toolId, {
        name: toolName,
        class: safetyClass,
        startTime: Date.now(),
        args: typeof rawArgs === 'string' ? rawArgs.substring(0, 200) : JSON.stringify(rawArgs || '').substring(0, 200),
        holdsMutex: safetyClass === TOOL_CLASSES.STATE_MUTATING || safetyClass === TOOL_CLASSES.CRITICAL,
      });

      stats.maxConcurrentTools = Math.max(stats.maxConcurrentTools, activeTools.size);

      // Detect concurrent mutations (for observability)
      const activeMutations = [...activeTools.values()].filter(
        t => t.class === TOOL_CLASSES.STATE_MUTATING || t.class === TOOL_CLASSES.CRITICAL
      );
      stats.maxConcurrentMutating = Math.max(stats.maxConcurrentMutating, activeMutations.length);

      let warning = null;
      if (safetyClass !== TOOL_CLASSES.CONCURRENT_SAFE && activeMutations.length > 1) {
        const currentEntry = activeTools.get(toolId);
        const others = activeMutations.filter(t => t !== currentEntry);
        if (others.length > 0) {
          stats.concurrentConflicts++;
          warning = `并发写冲突: ${toolName} 与 [${others.map(t => t.name).join(', ')}] 同时活跃`;
          conflictLog.push({
            time: ts(), tool: toolName,
            conflictsWith: others.map(t => t.name), class: safetyClass,
          });
          logger.info(`[${ts()}] [orchestrator] ⚠️ ${warning}`);
        }
      }

      // Parallelizable window detection
      const activeSafe = [...activeTools.values()].filter(t => t.class === TOOL_CLASSES.CONCURRENT_SAFE);
      if (activeSafe.length > 1) stats.parallelizableWindows++;

      return {
        safetyClass, warning, isCritical: safetyClass === TOOL_CLASSES.CRITICAL,
        blocked: false, blockReason: null,
      };
    },

    /**
     * R54: Release execution resources when tool completes.
     * MUST be called for every tool that passed acquireExecution with blocked=false.
     */
    releaseExecution(toolId) {
      const tool = activeTools.get(toolId);
      if (!tool) return;

      const duration = Date.now() - tool.startTime;
      logger.info(`[${ts()}] [orchestrator] ✓ ${tool.name} completed (${duration}ms, class=${tool.class})`);

      // Release mutex if this tool held it
      if (tool.holdsMutex) {
        releaseMutex();
      }

      // Release concurrency slot
      releaseConcurrencySlot();

      activeTools.delete(toolId);
      // [BUGFIX] Leak detection: if activeTools is empty but activeConcurrentCount > 0, reset
      if (activeTools.size === 0 && activeConcurrentCount > 0) {
        logger.warn(`[${ts()}] [orchestrator] ⚠️ LEAK DETECTED: activeConcurrentCount=${activeConcurrentCount} but activeTools is empty. Resetting to 0.`);
        activeConcurrentCount = 0;
      }
    },

    // ─── R73 P0-1: Tool Dispatch Spine ───
    // Dispatch wraps acquireExecution + registers the tool as a pending dispatch.
    // This replaces the fire-and-forget pattern in openclaw-handler.
    // Returns the same { safetyClass, blocked, ... } shape but ALSO stores the
    // dispatch for later completion via completeDispatch().
    _dispatchRegistry: new Map(),

    async dispatch(toolId, toolName, rawArgs) {
      const result = await this.acquireExecution(toolId, toolName, rawArgs);
      if (!result.blocked) {
        this._dispatchRegistry.set(toolId, {
          toolName,
          safetyClass: result.safetyClass,
          startedAt: Date.now(),
        });
      }
      return result;
    },

    // Called at tool_end to release resources and return dispatch context.
    // [R73-P0-2] Integrates failure-recovery: classifies failures and attaches
    // recovery strategy to the dispatch result.
    completeDispatch(toolId, toolResult = null) {
      const dispatch = this._dispatchRegistry.get(toolId);
      const info = this.getActiveToolInfo(toolId);
      this.releaseExecution(toolId);
      this._dispatchRegistry.delete(toolId);

      const result = {
        dispatch: dispatch || null,
        toolInfo: info || null,
        toolResult,
        success: true,
        failureType: null,
        recoveryAction: null,
      };

      // [R73-P0-2] Failure classification: if toolResult indicates an error,
      // use failure-recovery.mjs to diagnose and suggest recovery.
      if (toolResult && (toolResult.error || toolResult.isError || (toolResult.content && typeof toolResult.content === 'string' && /^(Error|Failed|FAILED|\[ERROR\])/i.test(toolResult.content)))) {
        const errorObj = toolResult.error || new Error(typeof toolResult.content === 'string' ? toolResult.content.substring(0, 200) : 'tool_error');
        const toolName = dispatch?.toolName || info?.toolName || 'unknown';
        const failureType = classifyFailure(errorObj, toolName);
        const recovery = getRecoveryStrategy(failureType, { tool: toolName });
        result.success = false;
        result.failureType = failureType;
        result.recoveryAction = recovery?.action || 'log_and_continue';
        result.recoveryHint = recovery?.hint || null;
        logger.info(`[${ts()}] [R73-P0-2] Dispatch complete with failure: tool=${toolName} type=${failureType} recovery=${result.recoveryAction}`);
      }

      return result;
    },

    getPendingDispatches() {
      return new Map(this._dispatchRegistry);
    },

    /**
     * R54: Handle user confirmation response from frontend.
     * Called when user clicks confirm/reject on tool_confirm_required.
     */
    handleConfirmResponse(confirmId, approved) {
      const pending = pendingConfirmations.get(confirmId);
      if (!pending) {
        logger.warn(`[${ts()}] [orchestrator] Unknown confirmation: ${confirmId}`);
        return false;
      }

      clearTimeout(pending.timer);
      pendingConfirmations.delete(confirmId);

      logger.info(`[${ts()}] [orchestrator] ${approved ? '✅' : '❌'} Confirmation ${confirmId}: ${approved ? 'approved' : 'rejected'}`);

      pending.resolve({
        confirmed: approved,
        reason: approved ? 'User approved' : 'User rejected',
      });

      return true;
    },

    /**
     * Legacy: classifyAndTrack (kept for backward compatibility, wraps acquireExecution sync part)
     */
    classifyAndTrack(toolId, toolName, rawArgs) {
      let args = {};
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
      } catch { args = {}; }

      let safetyClass;
      if (toolName === 'exec') {
        const cmd = args.command || args.cmd || (typeof rawArgs === 'string' ? rawArgs : '');
        safetyClass = classifyExecCommand(cmd);
      } else if (toolName === 'browser') {
        safetyClass = classifyBrowserAction(args);
      } else if (STATIC_TOOL_MAP[toolName]) {
        safetyClass = STATIC_TOOL_MAP[toolName];
      } else {
        safetyClass = TOOL_CLASSES.STATE_MUTATING;
      }

      return { safetyClass, warning: null, isCritical: safetyClass === TOOL_CLASSES.CRITICAL };
    },

    /**
     * Legacy: trackEnd (kept for backward compatibility)
     */
    trackEnd(toolId) {
      this.releaseExecution(toolId);
    },

    getStats() {
      return {
        ...stats,
        maxConsecutiveReadOnly,
        activeToolCount: activeTools.size,
        conflictCount: conflictLog.length,
        classificationCount: classificationHistory.length,
        parallelizabilityScore: stats.totalConcurrentSafe > 0
          ? Math.round((stats.totalConcurrentSafe / (stats.totalConcurrentSafe + stats.totalStateMutating + stats.totalCritical)) * 100)
          : 0,
      };
    },

    getConflictLog() { return conflictLog; },

    getSummaryString() {
      const s = this.getStats();
      const parts = [
        `🟢safe=${s.totalConcurrentSafe}`,
        `🟡mutating=${s.totalStateMutating}`,
        `🔴critical=${s.totalCritical}`,
        `parallel_score=${s.parallelizabilityScore}%`,
        `max_concurrent=${s.maxConcurrentTools}`,
        `conflicts=${s.concurrentConflicts}`,
      ];
      // R54 active stats
      if (s.mutexWaits > 0) parts.push(`mutex_waits=${s.mutexWaits}`);
      if (s.mutexTimeouts > 0) parts.push(`mutex_timeouts=${s.mutexTimeouts}`);
      if (s.confirmRequests > 0) parts.push(`confirms=${s.confirmApproved}/${s.confirmRequests}`);
      if (s.concurrencyQueueWaits > 0) parts.push(`concurrency_waits=${s.concurrencyQueueWaits}`);
      if (s.maxConsecutiveReadOnly > 2) parts.push(`max_consecutive_readonly=${s.maxConsecutiveReadOnly}`);
      return `[orchestrator] ${parts.join(' | ')}`;
    },

    getClassificationHistory() { return classificationHistory; },

    getActiveToolInfo(toolId) { return activeTools.get(toolId) || null; },

    // [R46-BUGFIX] Force reset all concurrency slots on task cleanup
    forceReset() {
      const activeIds = [...activeTools.keys()];
      for (const id of activeIds) {
        try { this.releaseExecution(id); } catch(_) {}
      }
      activeConcurrentCount = 0;
      concurrencyQueue.length = 0;
      this._dispatchRegistry.clear();
    },
    // Export constants
    TOOL_CLASSES,
    ACTIVE_CONFIG,
  };
}
