#!/usr/bin/env node
/**
 * remediation-engine.mjs — Automated Self-Healing Engine for RangerAI
 * Iter-13A: Circuit breaker + Audit logging + Remediation strategies
 *
 * Architecture:
 *   health-check.mjs → alert-manager.mjs → remediation-engine.mjs
 *                                              ├─ Circuit Breaker (熔断保护)
 *                                              ├─ Remediation Strategies (修复策略)
 *                                              └─ Audit Logger (修复审计)
 *
 * Safety Red Lines:
 *   - NEVER auto-restart rangerai-agent (server.mjs)
 *   - NEVER auto-restart Gateway (litellm)
 *   - NEVER delete business data files under /opt/rangerai-agent/
 *
 * Usage:
 *   import { attemptRemediation } from './remediation-engine.mjs';
 *   const result = await attemptRemediation(healthCheckResults);
 *
 *   // Or CLI: node remediation-engine.mjs --dry-run
 */
import { logger } from './lib/logger.mjs';
import { execSync, exec } from 'child_process';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const BASE_DIR = '/opt/rangerai-agent';
const LOG_DIR = join(BASE_DIR, 'logs');
const REMEDIATION_LOG = join(LOG_DIR, 'remediation.log');

// ─── Circuit Breaker Configuration ───
const CIRCUIT_BREAKER = {
  maxFailures: 3,          // Max failed attempts before tripping
  windowMs: 30 * 60 * 1000, // 30-minute window
  cooldownMs: 60 * 60 * 1000, // 1-hour cooldown after circuit trips
};

// In-memory circuit breaker state
// Map<component, { failures: [{timestamp, error}], trippedAt: number|null }>
const circuitState = new Map();

// ─── Safety Red Lines ───
const NEVER_RESTART_SERVICES = [
  'rangerai-agent',
  'litellm',
  'litellm-proxy',
];

const NEVER_DELETE_PATHS = [
  '/opt/rangerai-agent/',
  '/opt/rangerai-web/',
  '/var/www/',
];

// ─── Remediation Strategies Registry ───
const strategies = new Map();

/**
 * Register a remediation strategy.
 * @param {string} component - Component identifier (e.g., 'service:redis')
 * @param {Function} handler - async (checkResult) => { success: boolean, action: string, details: string }
 */
export function registerStrategy(component, handler) {
  strategies.set(component, handler);
}

// ─── Circuit Breaker Logic ───

/**
 * Check if circuit is open (tripped) for a component.
 * @param {string} component
 * @returns {{ isOpen: boolean, reason: string }}
 */
function checkCircuit(component) {
  const state = circuitState.get(component);
  if (!state) return { isOpen: false, reason: '' };

  // Check if circuit is tripped
  if (state.trippedAt) {
    const elapsed = Date.now() - state.trippedAt;
    if (elapsed < CIRCUIT_BREAKER.cooldownMs) {
      const remainMin = Math.ceil((CIRCUIT_BREAKER.cooldownMs - elapsed) / 60000);
      return {
        isOpen: true,
        reason: `Circuit OPEN — ${state.failures.length} failures in window. Cooldown: ${remainMin}min remaining.`,
      };
    }
    // Cooldown expired, reset circuit
    state.trippedAt = null;
    state.failures = [];
    return { isOpen: false, reason: 'Circuit reset after cooldown' };
  }

  // Clean old failures outside window
  const cutoff = Date.now() - CIRCUIT_BREAKER.windowMs;
  state.failures = state.failures.filter(f => f.timestamp > cutoff);

  return { isOpen: false, reason: '' };
}

/**
 * Record a failure for circuit breaker.
 * @param {string} component
 * @param {string} error
 * @returns {boolean} true if circuit just tripped
 */
function recordFailure(component, error) {
  if (!circuitState.has(component)) {
    circuitState.set(component, { failures: [], trippedAt: null });
  }
  const state = circuitState.get(component);
  state.failures.push({ timestamp: Date.now(), error });

  // Clean old failures
  const cutoff = Date.now() - CIRCUIT_BREAKER.windowMs;
  state.failures = state.failures.filter(f => f.timestamp > cutoff);

  // Check if we should trip
  if (state.failures.length >= CIRCUIT_BREAKER.maxFailures && !state.trippedAt) {
    state.trippedAt = Date.now();
    return true; // Just tripped
  }
  return false;
}

/**
 * Record a success, resetting the circuit.
 * @param {string} component
 */
function recordSuccess(component) {
  if (circuitState.has(component)) {
    const state = circuitState.get(component);
    state.failures = [];
    state.trippedAt = null;
  }
}

// ─── Audit Logger ───

/**
 * Log remediation action to file and MySQL.
 */
async function logRemediation(entry) {
  const {
    component,
    action,
    success,
    details,
    durationMs,
    dryRun = false,
  } = entry;

  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${success ? 'SUCCESS' : 'FAILURE'}] [${component}] ${action} — ${details} (${durationMs}ms)${dryRun ? ' [DRY-RUN]' : ''}\n`;

  // 1. File log
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(REMEDIATION_LOG, logLine);
  } catch (e) {
    logger.error('Failed to write remediation log:', e.message);
  }

  // 2. Console
  const icon = success ? '✅' : '❌';
  logger.info(`  ${icon} [${component}] ${action} — ${details}`);

  // 3. MySQL remediation_events table
  try {
    const mysql2 = (await import('mysql2/promise')).default;
    const conn = await mysql2.createConnection({
      host: '127.0.0.1', port: 3306, user: 'root',
      password: process.env.MYSQL_PASSWORD || 'RangerAI2026!',
      database: process.env.MYSQL_DATABASE || 'rangerai',
      connectTimeout: 5000,
    });
    await conn.execute(
      `INSERT INTO remediation_events (component, action, success, details, duration_ms, dry_run, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [component, action, success ? 1 : 0, details, durationMs, dryRun ? 1 : 0]
    );
    await conn.end();
  } catch (e) {
    logger.error('  ⚠ MySQL audit log failed:', e.message);
  }
}

// ─── Remediation Executor ───

/**
 * Execute a shell command safely with timeout.
 * @param {string} cmd
 * @param {number} timeoutMs
 * @returns {{ success: boolean, stdout: string, stderr: string }}
 */
function safeExec(cmd, timeoutMs = 15000) {
  // Safety check: never restart protected services
  for (const svc of NEVER_RESTART_SERVICES) {
    if (cmd.includes(svc) && (cmd.includes('restart') || cmd.includes('stop') || cmd.includes('kill'))) {
      return {
        success: false,
        stdout: '',
        stderr: `BLOCKED: Safety red line — cannot restart/stop/kill ${svc}`,
      };
    }
  }

  // Safety check: never delete protected paths
  // Iter-15B: expanded detection beyond just 'rm ' to cover rmdir, find -delete, unlink, etc.
  const destructivePatterns = ['rm ', 'rm\t', 'rmdir ', 'unlink ', '-delete', 'shred '];
  const hasDestructiveCmd = destructivePatterns.some(pat => cmd.includes(pat));
  for (const path of NEVER_DELETE_PATHS) {
    if (hasDestructiveCmd && cmd.includes(path)) {
      return {
        success: false,
        stdout: '',
        stderr: `BLOCKED: Safety red line — cannot delete files under ${path}`,
      };
    }
  }

  try {
    const stdout = execSync(cmd, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    return {
      success: false,
      stdout: e.stdout?.toString().trim() || '',
      stderr: e.stderr?.toString().trim() || e.message,
    };
  }
}

// ─── Built-in Remediation Strategies ───

// Strategy 1: Redis restart
registerStrategy('service:redis', async (check) => {
  const start = Date.now();
  // Try systemctl restart first
  let result = safeExec('sudo systemctl restart redis-server 2>&1 || sudo systemctl restart redis 2>&1');
  if (!result.success) {
    // Fallback: try redis-cli ping after a moment
    result = safeExec('sleep 2 && redis-cli -p 6380 ping 2>&1');
  }

  // Verify recovery
  await new Promise(r => setTimeout(r, 2000));
  const verify = safeExec('redis-cli -p 6380 ping 2>&1');
  const success = verify.stdout.includes('PONG');

  return {
    success,
    action: 'systemctl restart redis',
    details: success ? 'Redis restarted and verified PONG' : `Redis restart failed: ${verify.stderr || result.stderr}`,
    durationMs: Date.now() - start,
  };
});

// Strategy 2: MySQL kill idle connections
registerStrategy('service:mysql', async (check) => {
  const start = Date.now();
  try {
    const mysql2 = (await import('mysql2/promise')).default;
    const conn = await mysql2.createConnection({
      host: '127.0.0.1', port: 3306, user: 'root',
      password: process.env.MYSQL_PASSWORD || 'RangerAI2026!',
      database: process.env.MYSQL_DATABASE || 'rangerai',
      connectTimeout: 5000,
    });

    // Find SLEEP connections idle > 60s (never kill QUERY/LOCKED)
    const [procs] = await conn.execute(
      "SELECT ID, TIME, COMMAND, INFO FROM information_schema.PROCESSLIST WHERE COMMAND = 'Sleep' AND TIME > 60"
    );

    let killed = 0;
    for (const proc of procs) {
      try {
        await conn.execute(`KILL ${proc.ID}`);
        killed++;
      } catch { /* connection may already be gone */ }
    }

    await conn.end();
    return {
      success: true,
      action: `kill ${killed} idle MySQL connections`,
      details: `Found ${procs.length} SLEEP connections >60s, killed ${killed}`,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      success: false,
      action: 'kill idle MySQL connections',
      details: `MySQL remediation failed: ${e.message}`,
      durationMs: Date.now() - start,
    };
  }
});

// Strategy 3: Disk cleanup (logs only, >7 days)
registerStrategy('system:disk', async (check) => {
  const start = Date.now();
  const cleanupPaths = [
    '/opt/rangerai-agent/logs/*.log.gz',
    '/opt/rangerai-agent/logs/*.log.[0-9]*',
    '/tmp/rangerai-*',
    '/tmp/health-check-*',
  ];

  let totalCleaned = 0;
  const details = [];

  // Clean old log archives (>7 days)
  const result1 = safeExec('find /opt/rangerai-agent/logs -name "*.log.gz" -o -name "*.log.[0-9]*" | xargs -r ls -la 2>/dev/null | wc -l');
  const oldLogCount = parseInt(result1.stdout) || 0;

  if (oldLogCount > 0) {
    const clean1 = safeExec('find /opt/rangerai-agent/logs \\( -name "*.log.gz" -o -name "*.log.[0-9]*" \\) -mtime +7 -delete 2>&1');
    if (clean1.success) {
      totalCleaned += oldLogCount;
      details.push(`Cleaned ${oldLogCount} old log archives`);
    }
  }

  // Clean temp files
  const clean2 = safeExec('find /tmp -name "rangerai-*" -o -name "health-check-*" -mtime +1 2>/dev/null | xargs -r rm -f 2>&1');
  if (clean2.success) {
    details.push('Cleaned temp files');
  }

  // Truncate large active logs (>100MB)
  const result3 = safeExec('find /opt/rangerai-agent/logs -name "*.log" -size +100M 2>/dev/null');
  if (result3.stdout) {
    for (const logFile of result3.stdout.split('\n').filter(Boolean)) {
      // Truncate to last 10000 lines instead of deleting
      safeExec(`tail -10000 "${logFile}" > "${logFile}.tmp" && mv "${logFile}.tmp" "${logFile}"`);
      details.push(`Truncated large log: ${logFile}`);
    }
  }

  return {
    success: true,
    action: 'disk cleanup',
    details: details.length > 0 ? details.join('; ') : 'No cleanup needed',
    durationMs: Date.now() - start,
  };
});

// Strategy 4: Fileserver restart
registerStrategy('service:fileserver', async (check) => {
  const start = Date.now();
  const result = safeExec('sudo systemctl restart rangerai-fileserver 2>&1');

  // Verify recovery
  await new Promise(r => setTimeout(r, 3000));
  const verify = safeExec('curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>&1');
  const success = verify.stdout === '200' || verify.stdout === '301' || verify.stdout === '302';

  return {
    success,
    action: 'systemctl restart rangerai-fileserver',
    details: success ? `Fileserver restarted, HTTP ${verify.stdout}` : `Fileserver restart failed: ${result.stderr || verify.stderr}`,
    durationMs: Date.now() - start,
  };
});

// Strategy 5: Web server (rangerai-web) restart
registerStrategy('service:web', async (check) => {
  const start = Date.now();
  const result = safeExec('sudo systemctl restart rangerai-web 2>&1');

  // Verify recovery
  await new Promise(r => setTimeout(r, 3000));
  const verify = safeExec('curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/ 2>&1');
  const success = verify.stdout === '200' || verify.stdout === '301' || verify.stdout === '302';

  return {
    success,
    action: 'systemctl restart rangerai-web',
    details: success ? `Web server restarted, HTTP ${verify.stdout}` : `Web restart failed: ${result.stderr || verify.stderr}`,
    durationMs: Date.now() - start,
  };
});

// Strategy 6: SSL/Caddy reload
registerStrategy('service:ssl', async (check) => {
  const start = Date.now();
  const result = safeExec('sudo systemctl reload caddy 2>&1');
  const success = result.success;

  return {
    success,
    action: 'systemctl reload caddy',
    details: success ? 'Caddy reloaded for SSL renewal' : `Caddy reload failed: ${result.stderr}`,
    durationMs: Date.now() - start,
  };
});

// ─── Main Remediation Orchestrator ───

/**
 * Map health check component names to remediation strategy keys.
 */
function mapToStrategy(component, status) {
  // Only attempt remediation for WARN or CRIT
  if (status === 'PASS') return null;

  const mapping = {
    'service:redis-6380': 'service:redis',
    'service:redis-6379': 'service:redis',
    'service:redis': 'service:redis',
    'database:redis': 'service:redis',
    'service:mysql': 'service:mysql',
    'database:mysql': 'service:mysql',
    'system:disk': 'system:disk',
    'service:fileserver': 'service:fileserver',
    'service:rangerai-fileserver': 'service:fileserver',
    'endpoint:fileserver': 'service:fileserver',
    'service:web-frontend': 'service:web',
    'service:rangerai-web': 'service:web',
    'endpoint:web': 'service:web',
    'service:caddy': 'service:ssl',
    'service:caddy-ssl': 'service:ssl',
  };

  return mapping[component] || null;
}

/**
 * Attempt remediation for all failing health check results.
 * @param {Array} results - Health check results array [{component, status, message}]
 * @param {object} options - { dryRun: boolean }
 * @returns {object} { attempted: number, succeeded: number, failed: number, circuitTripped: number, actions: [] }
 */
export async function attemptRemediation(results, options = {}) {
  const { dryRun = false } = options;
  const summary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    circuitTripped: 0,
    skipped: 0,
    actions: [],
  };

  // Filter to only WARN/CRIT results
  const failing = results.filter(r => r.status === 'WARN' || r.status === 'CRIT');

  if (failing.length === 0) {
    logger.info('  ℹ No failing components — no remediation needed.');
    return summary;
  }

  logger.info(`\n🔧 Remediation Engine — ${failing.length} failing component(s)`);
  logger.info(`   Mode: ${dryRun ? 'DRY-RUN (no changes)' : 'LIVE'}`);
  logger.info('');

  // Deduplicate by strategy (multiple checks may map to same strategy)
  const toRemediate = new Map();
  for (const check of failing) {
    const strategyKey = mapToStrategy(check.component, check.status);
    if (!strategyKey) {
      summary.skipped++;
      continue;
    }
    if (!toRemediate.has(strategyKey)) {
      toRemediate.set(strategyKey, check);
    }
  }

  for (const [strategyKey, check] of toRemediate) {
    // Check circuit breaker
    const circuit = checkCircuit(strategyKey);
    if (circuit.isOpen) {
      logger.info(`  ⛔ [${strategyKey}] CIRCUIT OPEN — ${circuit.reason}`);
      summary.circuitTripped++;
      summary.actions.push({
        component: strategyKey,
        action: 'CIRCUIT_OPEN',
        success: false,
        details: circuit.reason,
      });

      // Send critical alert for circuit trip
      try {
        const { sendAlert } = await import('./alert-manager.mjs');
        await sendAlert({
          level: 'CRIT',
          title: `CIRCUIT BREAKER TRIPPED: ${strategyKey}`,
          body: `Auto-repair failed ${CIRCUIT_BREAKER.maxFailures} times in ${CIRCUIT_BREAKER.windowMs / 60000}min. Manual intervention required.\n${circuit.reason}`,
        });
      } catch { /* alert-manager may not be available */ }
      continue;
    }

    const strategy = strategies.get(strategyKey);
    if (!strategy) {
      logger.info(`  ⚠ [${strategyKey}] No strategy registered — skipping`);
      summary.skipped++;
      continue;
    }

    summary.attempted++;

    if (dryRun) {
      logger.info(`  🔍 [${strategyKey}] Would execute remediation (dry-run)`);
      await logRemediation({
        component: strategyKey,
        action: 'dry-run check',
        success: true,
        details: `Would remediate: ${check.message}`,
        durationMs: 0,
        dryRun: true,
      });
      summary.succeeded++;
      summary.actions.push({
        component: strategyKey,
        action: 'dry-run',
        success: true,
        details: `Would remediate: ${check.message}`,
      });
      continue;
    }

    // Execute strategy
    try {
      const result = await strategy(check);

      await logRemediation({
        component: strategyKey,
        action: result.action,
        success: result.success,
        details: result.details,
        durationMs: result.durationMs,
      });

      if (result.success) {
        summary.succeeded++;
        recordSuccess(strategyKey);
      } else {
        summary.failed++;
        const tripped = recordFailure(strategyKey, result.details);
        if (tripped) {
          summary.circuitTripped++;
          logger.info(`  ⛔ [${strategyKey}] CIRCUIT JUST TRIPPED after ${CIRCUIT_BREAKER.maxFailures} failures!`);
          // Send critical alert
          try {
            const { sendAlert } = await import('./alert-manager.mjs');
            await sendAlert({
              level: 'CRIT',
              title: `AUTO_REPAIR_FAILED: ${strategyKey}`,
              body: `Circuit breaker tripped after ${CIRCUIT_BREAKER.maxFailures} consecutive failures. Last error: ${result.details}`,
            });
          } catch { /* alert-manager may not be available */ }
        }
      }

      summary.actions.push({
        component: strategyKey,
        action: result.action,
        success: result.success,
        details: result.details,
      });
    } catch (e) {
      summary.failed++;
      const tripped = recordFailure(strategyKey, e.message);
      await logRemediation({
        component: strategyKey,
        action: 'EXCEPTION',
        success: false,
        details: e.message,
        durationMs: 0,
      });
      summary.actions.push({
        component: strategyKey,
        action: 'EXCEPTION',
        success: false,
        details: e.message,
      });
    }
  }

  logger.info('');
  logger.info(`🔧 Remediation Summary: ${summary.attempted} attempted, ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.circuitTripped} circuit-tripped, ${summary.skipped} skipped`);

  return summary;
}

// ─── CLI Mode ───
const args = process.argv.slice(2);
if (args.includes('--help')) {
  logger.info(`
remediation-engine.mjs — RangerAI Automated Self-Healing Engine

Usage:
  node remediation-engine.mjs [options]

Options:
  --dry-run     Simulate remediation without making changes
  --test        Run with mock failing data to test strategies
  --status      Show circuit breaker status
  --help        Show this help

Integration:
  Called automatically by health-check.mjs when failures are detected.
  `);
  process.exit(0);
}

if (args.includes('--test')) {
  // Test mode: simulate failures
  const mockResults = [
    { component: 'service:redis-6380', status: 'CRIT', message: 'Redis connection refused' },
    { component: 'system:disk', status: 'WARN', message: 'Disk usage 82%' },
  ];
  const dryRun = args.includes('--dry-run');
  const summary = await attemptRemediation(mockResults, { dryRun });
  logger.info('\nTest result:', JSON.stringify(summary, null, 2));
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (args.includes('--status')) {
  logger.info('Circuit Breaker Status:');
  if (circuitState.size === 0) {
    logger.info('  No circuits tracked (clean state)');
  }
  for (const [comp, state] of circuitState) {
    const status = state.trippedAt ? 'OPEN' : 'CLOSED';
    logger.info(`  ${comp}: ${status} (${state.failures.length} recent failures)`);
  }
  process.exit(0);
}
