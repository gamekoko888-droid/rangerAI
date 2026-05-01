/**
 * worker/permissions/validator-chain.mjs — Iter-W (v25.22)
 *
 * 危险操作拦截链，对标 Claude Code bashSecurity.ts。
 * 每个 validator 返回 { action: 'continue'|'deny'|'warn', reason?: string }
 * 串行执行：第一个 deny 立即终止；continue 继续下一个；warn 记录并允许通过。
 *
 * 接入点：worker/tool-permission.mjs → checkCommandPermission()
 */

import { logger } from '../../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── 白名单：这些命令始终放行 ───────────────────────────────────────────────
const ALWAYS_ALLOWED = [
  /^bash\s+\/opt\/rangerai-safety\/defer-restart\.sh/,   // 延迟重启脚本
  /^sudo\s+cp\s+/,                                        // sudo cp（前端部署）
  /^sudo\s+rsync\s+/,                                     // sudo rsync
  /^sudo\s+systemctl\s+(status|reload)\s+/,               // systemctl status/reload
  /^node\s+--check\s+/,                                   // 语法检查
];

function isAlwaysAllowed(command) {
  for (const p of ALWAYS_ALLOWED) {
    if (p.test(command.trim())) return true;
  }
  return false;
}

// ─── Validator 1: 危险命令 ───────────────────────────────────────────────────
function validateDangerousCommands(command) {
  const DANGEROUS = [
    { re: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|--recursive.*--force|--force.*--recursive)/i, label: 'rm -rf' },
    { re: /\bdd\b.*\bof=\/dev\//i,   label: 'dd of=/dev/*（磁盘破坏）' },
    { re: /\bmkfs\b/i,               label: 'mkfs（格式化磁盘）' },
    { re: /\bfdisk\b.*\/dev\//i,     label: 'fdisk 分区' },
    { re: /\bshred\b/i,              label: 'shred 文件粉碎' },
    { re: /\bwipefs\b/i,             label: 'wipefs 擦除文件系统' },
    { re: /\bfork\s*bomb\b|:\(\)\s*\{.*:\|:&\s*\};:/i, label: 'Fork bomb' },
  ];
  for (const { re, label } of DANGEROUS) {
    if (re.test(command)) {
      return { action: 'deny', reason: `危险命令拦截: ${label}` };
    }
  }
  return { action: 'continue' };
}

// ─── Validator 2: 路径穿越 ───────────────────────────────────────────────────
function validatePathTraversal(command) {
  if (/\.\.\/\.\.\/.*\/(etc|proc|sys|root)\//i.test(command)) {
    return { action: 'deny', reason: '路径穿越: 尝试访问敏感系统目录' };
  }
  if (/\/etc\/(passwd|shadow|sudoers|crontab)/i.test(command) && /\b(cat|less|more|head|tail|cp|mv|echo)\b/.test(command)) {
    return { action: 'deny', reason: '路径穿越: 尝试读取敏感系统文件' };
  }
  return { action: 'continue' };
}

// ─── Validator 3: 代码注入/外泄 ─────────────────────────────────────────────
function validateSecretExfiltration(command) {
  const PATTERNS = [
    { re: /curl\s+[^\s]+\s*\|\s*(ba)?sh/i,  label: 'curl | bash（远程代码执行）' },
    { re: /wget\s+[^\s]+\s*\|\s*(ba)?sh/i,  label: 'wget | bash（远程代码执行）' },
    { re: /bash\s+-i\s*>&?\s*\/dev\/tcp/i,   label: 'bash 反弹 shell' },
    { re: /python[23]?\s+-c\s+["'].*socket/i, label: 'Python 反弹 shell' },
    { re: /nc\s+(-e|-c)\s+/i,               label: 'netcat 反弹 shell' },
  ];
  for (const { re, label } of PATTERNS) {
    if (re.test(command)) {
      return { action: 'deny', reason: `安全拦截: ${label}` };
    }
  }
  return { action: 'continue' };
}

// ─── Validator 4: sudo 权限升级 ──────────────────────────────────────────────
function validateSudoEscalation(command) {
  if (!/\bsudo\b/i.test(command)) return { action: 'continue' };

  // sudo su / sudo bash / sudo sh / sudo -s / sudo -i → 绝对拦截
  if (/sudo\s+(su\b|bash\b|sh\b|-s\b|-i\b)/i.test(command)) {
    return { action: 'deny', reason: 'sudo 权限升级拦截: sudo su/bash/sh 禁止' };
  }
  // 其他 sudo：warn（记录但允许）
  return { action: 'warn', reason: `sudo 命令: ${command.slice(0, 80)}` };
}

// ─── Validator 5: systemctl 服务操作 ─────────────────────────────────────────
function validateSystemctlOps(command) {
  if (!/systemctl\b/.test(command)) return { action: 'continue' };

  // P0-4 铁律：openclaw-gateway 绝对禁止
  if (/systemctl\s+(stop|start|restart|disable|mask|kill)\s+.*openclaw/i.test(command)) {
    return { action: 'deny', reason: 'P0-4 铁律: 禁止操作 openclaw-gateway' };
  }
  // 破坏性 systemctl 操作：拦截
  if (/systemctl\s+(disable|mask|kill)\s+/i.test(command)) {
    return { action: 'deny', reason: 'systemctl 破坏性操作拦截（disable/mask/kill）' };
  }
  // stop/start/restart 其他服务：warn
  if (/systemctl\s+(stop|start|restart)\s+/i.test(command)) {
    return { action: 'warn', reason: `systemctl 变更操作: ${command.slice(0, 80)}` };
  }
  return { action: 'continue' };
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────
const VALIDATORS = [
  validateDangerousCommands,
  validatePathTraversal,
  validateSecretExfiltration,
  validateSudoEscalation,
  validateSystemctlOps,
];

/**
 * 检查命令是否允许执行。
 *
 * @param {string} command - 待执行命令
 * @returns {{ allowed: boolean, warn: boolean, reason?: string }}
 */
export function checkCommandPermission(command) {
  if (!command || typeof command !== 'string') return { allowed: true, warn: false };

  // 白名单短路
  if (isAlwaysAllowed(command)) {
    return { allowed: true, warn: false };
  }

  for (const validator of VALIDATORS) {
    const result = validator(command);
    if (result.action === 'deny') {
      logger.warn(`[${ts()}] [validator-chain] DENY: ${result.reason} | cmd: ${command.slice(0, 120)}`);
      return { allowed: false, warn: false, reason: result.reason };
    }
    if (result.action === 'warn') {
      logger.info(`[${ts()}] [validator-chain] WARN: ${result.reason}`);
      return { allowed: true, warn: true, reason: result.reason };
    }
    // 'continue' → 检查下一个
  }

  return { allowed: true, warn: false };
}
