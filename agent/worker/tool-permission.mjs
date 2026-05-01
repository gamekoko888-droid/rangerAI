/**
 * Iter-B: Tool Permission Chain
 * 
 * Three-tier permission system:
 * - CRITICAL: rm -rf /, DROP TABLE → force user confirmation, reject blocks execution
 * - HIGH: sudo, rm -r, curl|bash → push confirmation dialog (via human-approval.mjs)
 * - READONLY: file_read, grep, glob → whitelist passthrough, zero interception overhead
 * 
 * Integration point: tool-orchestrator.mjs calls validatePermission() before acquireExecution
 */

import { logger } from '../lib/logger.mjs';
import { checkCommandPermission } from './permissions/validator-chain.mjs'; // Iter-W
import { recordCompression } from './observability.mjs'; // [R13-T7]

const ts = () => new Date().toISOString().slice(11, 23);

// ─── Permission Tiers ───
export const PERMISSION_TIERS = {
  READONLY: 'readonly',      // Zero overhead, whitelist passthrough
  HIGH: 'high',              // Needs confirmation (via human-approval)
  CRITICAL: 'critical',      // Force user confirmation, reject blocks execution
};

// ─── Tool Whitelist (READONLY tier) ───
const READONLY_TOOLS = new Set([
  'file_read',
  'read_file',
  'grep',
  'glob',
  'find',
  'locate',
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_get',
  'image',
  'canvas',
  'read',
  'get_text',
  'get_html',
  'screenshot',
  'navigate',
  'scroll',
  'wait',
]);

// ─── CRITICAL Command Patterns ───
const CRITICAL_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+\/(?:opt|etc|home|var|root|sys|usr|bin|sbin)/,
  /rm\s+(-rf?|--recursive)\s+\/\s*$/,  // rm -rf /
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)/i,
  /\bTRUNCATE\s+TABLE/i,
  /\bDELETE\s+FROM\s+\w+\s*$/i,
  /systemctl\s+(stop|disable|restart)\s+(rangerai-|caddy|nginx)/,
  /\bsudo\s+(rm|mv|cp|chmod|chown)\s.*\/(etc|opt|usr|root)/,
  /git\s+(push|reset\s+--hard|force-push)/,
  /npm\s+(publish|unpublish)/,
  /\b(reboot|shutdown|halt|poweroff)\b/,
];

// ─── HIGH Command Patterns ───
const HIGH_PATTERNS = [
  /\bsudo\b/,
  /rm\s+-r\s/,
  /rm\s+(-f|--force)\s/,
  /curl\s+.*\|\s*bash/,
  /wget\s+.*\|\s*bash/,
  /curl\s+.*\|\s*sh/,
  /wget\s+.*\|\s*sh/,
  /\bchmod\s+/,
  /\bchown\s+/,
  /\bkill\s+-9/,
  /docker\s+(rm|rmi|stop|kill)/,
  /systemctl\s+(restart|reload)/,
];

/**
 * Classify a tool + args into permission tier
 * Returns: { tier: 'readonly'|'high'|'critical', reason: string|null }
 */
export function classifyPermissionTier(toolName, args) {
  // READONLY tools: whitelist passthrough
  if (READONLY_TOOLS.has(toolName)) {
    return {
      tier: PERMISSION_TIERS.READONLY,
      reason: null,
    };
  }

  // exec command: check patterns
  if (toolName === 'exec' || toolName === 'shell') {
    const cmd = args?.command || args?.cmd || '';
    if (!cmd || typeof cmd !== 'string') {
      return { tier: PERMISSION_TIERS.HIGH, reason: 'exec without command' };
    }

    // Check CRITICAL patterns first
    for (const pattern of CRITICAL_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          tier: PERMISSION_TIERS.CRITICAL,
          reason: `Destructive command detected: ${cmd.slice(0, 50)}...`,
        };
      }
    }

    // Check HIGH patterns
    for (const pattern of HIGH_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          tier: PERMISSION_TIERS.HIGH,
          reason: `Privileged command detected: ${cmd.slice(0, 50)}...`,
        };
      }
    }

    // Default exec: HIGH (conservative)
    return {
      tier: PERMISSION_TIERS.HIGH,
      reason: 'Shell command execution',
    };
  }

  // write/edit/create: HIGH
  if (['write', 'write_file', 'edit', 'edit_file', 'create_file'].includes(toolName)) {
    return {
      tier: PERMISSION_TIERS.HIGH,
      reason: `File mutation: ${toolName}`,
    };
  }

  // browser mutating actions: HIGH
  if (toolName === 'browser') {
    const action = args?.action || '';
    const mutatingActions = new Set([
      'click', 'input', 'fill_form', 'upload_file', 'press_key', 'select_option',
    ]);
    if (mutatingActions.has(action)) {
      return {
        tier: PERMISSION_TIERS.HIGH,
        reason: `Browser mutation: ${action}`,
      };
    }
  }

  // Default: HIGH (conservative)
  return {
    tier: PERMISSION_TIERS.HIGH,
    reason: `Tool requires approval: ${toolName}`,
  };
}

/**
 * Validate permission before tool execution
 * 
 * Returns: { allowed: boolean, tier: string, reason: string|null, requiresApproval: boolean }
 * 
 * Usage in tool-orchestrator.mjs:
 *   const perm = validatePermission(toolName, args);
 *   if (!perm.allowed) throw new Error(`Permission denied: ${perm.reason}`);
 *   if (perm.requiresApproval) {
 *     // Call human-approval.mjs gateToolExecution()
 *   }
 */
export function validatePermission(toolName, args = {}) {
  // Iter-W: validator-chain 前置拦截（比 tier 分类更早）
  if (toolName === 'exec' || toolName === 'shell' || toolName === 'bash') {
    const cmd = args?.command || args?.cmd || '';
    if (cmd) {
      const chainResult = checkCommandPermission(cmd);
      if (!chainResult.allowed) {
        return {
          allowed: false,
          tier: PERMISSION_TIERS.CRITICAL,
          reason: chainResult.reason || '安全策略拒绝',
          requiresApproval: false,
        };
      }
    }
  }

  const { tier, reason } = classifyPermissionTier(toolName, args);

  switch (tier) {
    case PERMISSION_TIERS.READONLY:
      // Zero overhead: direct passthrough
      return {
        allowed: true,
        tier,
        reason: null,
        requiresApproval: false,
      };

    case PERMISSION_TIERS.HIGH:
      // Requires approval via human-approval.mjs
      return {
        allowed: true,  // Will be re-gated by gateToolExecution()
        tier,
        reason,
        requiresApproval: true,
      };

    case PERMISSION_TIERS.CRITICAL:
      // Force user confirmation, reject blocks execution
      return {
        allowed: true,  // Will be re-gated by gateToolExecution()
        tier,
        reason,
        requiresApproval: true,
      };

    default:
      return {
        allowed: true,
        tier: 'unknown',
        reason: null,
        requiresApproval: false,
      };
  }
}

/**
 * Log permission check for audit trail
 */
export function logPermissionCheck(toolName, tier, allowed, userId = 'system') {
  const icon = allowed ? '✅' : '❌';
  logger.info(`[${ts()}] [permission] ${icon} ${tier.toUpperCase()} | ${toolName} | user=${userId}`);
}

/**
 * Stats for permission chain
 */
const _stats = {
  readonly: 0,
  high: 0,
  critical: 0,
  approved: 0,
  rejected: 0,
};

export function recordPermissionCheck(tier, approved = true, toolName = 'unknown', reason = null) {
  if (tier === PERMISSION_TIERS.READONLY) _stats.readonly++;
  else if (tier === PERMISSION_TIERS.HIGH) _stats.high++;
  else if (tier === PERMISSION_TIERS.CRITICAL) _stats.critical++;

  if (approved) _stats.approved++;
  else _stats.rejected++;

  // [R13-T7] Persist permission check to DB (non-readonly only)
  if (tier !== PERMISSION_TIERS.READONLY) {
    try {
      recordCompression('tool_permission_check', 0, {
        extraJson: {
          toolName,
          riskLevel: tier,
          approved,
          reason,
          statsSnapshot: { ..._stats },
        },
      });
    } catch (e) {
      // non-fatal
    }
  }
}

export function getPermissionStats() {
  return { ..._stats };
}

export function getPermissionSummary() {
  const s = _stats;
  return `[permission] readonly=${s.readonly} | high=${s.high} | critical=${s.critical} | approved=${s.approved} | rejected=${s.rejected}`;
}
