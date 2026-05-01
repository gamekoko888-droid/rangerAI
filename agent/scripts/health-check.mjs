#!/usr/bin/env node
/**
 * RangerAI Health Check v1.0 — Iter-12A
 * 
 * Full-stack health diagnostics covering:
 * 1. System resources (disk, memory, CPU)
 * 2. Service processes (rangerai-agent, openclaw-gateway, caddy, redis, mysql, fileserver)
 * 3. Database connectivity (MySQL primary, SQLite backup)
 * 4. Network endpoints (Agent API, Gateway, Caddy proxy)
 * 5. Frontend build integrity
 * 6. Workflow scheduler status
 * 7. Log & audit cleanup recommendations
 *
 * Usage:
 *   node health-check.mjs                 # Console output (default)
 *   node health-check.mjs --format=json   # JSON output for CI
 *   node health-check.mjs --fix           # Auto-fix recoverable issues
 *
 * Exit codes:
 *   0 = all PASS
 *   1 = at least one WARN
 *   2 = at least one CRIT
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { checkDBIntegrity, getDBHealthStatus } from '../modules/db-health.mjs';

// ─── Configuration ──────────────────────────────────────────
const PROJECT_DIR = '/opt/rangerai-agent';
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const LOG_DIR = path.join(PROJECT_DIR, 'logs');
const SQLITE_DB = path.join(PROJECT_DIR, 'rangerai.db');

const THRESHOLDS = {
  disk: { warn: 80, crit: 90 },           // percent
  memory: { warn: 1024, crit: 300 },       // MB free
  latency: { warn: 1500, crit: 5000 },     // ms
  logFileSize: { warn: 500, crit: 1000 },  // MB per file
  logDirSize: { warn: 2048, crit: 4096 },  // MB total
  auditLogDays: 30,                         // days to retain
  workflowRunDays: 90,                      // days to retain
};

const SERVICES = [
  { name: 'rangerai-agent', port: 3002, healthPath: '/api/health' },
  { name: 'openclaw-gateway', port: 18789, healthPath: null },
  { name: 'caddy', port: null },
  { name: 'redis', port: 6379 },
  { name: 'rangerai-fileserver', port: 3001, healthPath: '/health' },
  { name: 'rangerai-web', port: null },
];

const FORMAT = process.argv.includes('--format=json') ? 'json' : 'console';
const AUTO_FIX = process.argv.includes('--fix');

// ─── Results Collection ─────────────────────────────────────
const results = [];
const metrics = {};

function addResult(component, status, message, details = null) {
  results.push({ component, status, message, ...(details ? { details } : {}) });
}

// ─── Utility Functions ──────────────────────────────────────
function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function httpGet(port, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body, latency: Date.now() - start });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: '', latency: Date.now() - start, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', latency: timeoutMs, error: 'timeout' }); });
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// ─── Check 1: System Resources ──────────────────────────────
async function checkSystemResources() {
  // Disk usage
  const dfOutput = exec("df -h / | tail -1 | awk '{print $5}'");
  const diskPercent = dfOutput ? parseInt(dfOutput.replace('%', '')) : -1;
  metrics.disk_usage_percent = diskPercent;

  if (diskPercent < 0) {
    addResult('system:disk', 'CRIT', 'Unable to determine disk usage');
  } else if (diskPercent >= THRESHOLDS.disk.crit) {
    addResult('system:disk', 'CRIT', `Disk usage ${diskPercent}% (>= ${THRESHOLDS.disk.crit}% threshold)`);
  } else if (diskPercent >= THRESHOLDS.disk.warn) {
    addResult('system:disk', 'WARN', `Disk usage ${diskPercent}% (>= ${THRESHOLDS.disk.warn}% threshold)`);
  } else {
    addResult('system:disk', 'PASS', `Disk usage ${diskPercent}%`);
  }

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const freeMemMB = Math.round(freeMem / (1024 * 1024));
  const totalMemMB = Math.round(totalMem / (1024 * 1024));
  const usedPercent = Math.round((1 - freeMem / totalMem) * 100);
  metrics.memory_free_mb = freeMemMB;
  metrics.memory_total_mb = totalMemMB;
  metrics.memory_used_percent = usedPercent;

  if (freeMemMB < THRESHOLDS.memory.crit) {
    addResult('system:memory', 'CRIT', `Free memory ${freeMemMB}MB (< ${THRESHOLDS.memory.crit}MB threshold). OOM risk!`);
  } else if (freeMemMB < THRESHOLDS.memory.warn) {
    addResult('system:memory', 'WARN', `Free memory ${freeMemMB}MB (< ${THRESHOLDS.memory.warn}MB threshold)`);
  } else {
    addResult('system:memory', 'PASS', `Free memory ${freeMemMB}MB / ${totalMemMB}MB total (${usedPercent}% used)`);
  }

  // CPU load
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  metrics.cpu_load_1m = loadAvg[0].toFixed(2);
  metrics.cpu_cores = cpuCount;
  
  if (loadAvg[0] > cpuCount * 2) {
    addResult('system:cpu', 'WARN', `Load average ${loadAvg[0].toFixed(2)} (${cpuCount} cores) — high load`);
  } else {
    addResult('system:cpu', 'PASS', `Load average ${loadAvg[0].toFixed(2)} / ${loadAvg[1].toFixed(2)} / ${loadAvg[2].toFixed(2)} (${cpuCount} cores)`);
  }
}

// ─── Check 2: Service Processes ─────────────────────────────
async function checkServices() {
  for (const svc of SERVICES) {
    const status = exec(`systemctl is-active ${svc.name}.service 2>/dev/null`);
    if (status === 'active') {
      addResult(`service:${svc.name}`, 'PASS', `${svc.name} is active`);
    } else if (status === 'inactive' || status === 'failed') {
      addResult(`service:${svc.name}`, 'CRIT', `${svc.name} is ${status}`);
    } else {
      addResult(`service:${svc.name}`, 'WARN', `${svc.name} status: ${status || 'unknown'}`);
    }
  }
}

// ─── Check 3: Database Connectivity ─────────────────────────
async function checkDatabases() {
  // MySQL (primary)
  try {
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'RangerAI2026!',
      database: process.env.MYSQL_DATABASE || 'rangerai',
      connectTimeout: 5000,
    });
    const start = Date.now();
    const [rows] = await conn.execute('SELECT COUNT(*) as cnt FROM users');
    const latency = Date.now() - start;
    metrics.mysql_latency_ms = latency;
    metrics.mysql_user_count = rows[0].cnt;
    
    // Check table count
    const [tables] = await conn.execute('SHOW TABLES');
    metrics.mysql_table_count = tables.length;
    
    await conn.end();
    addResult('database:mysql', 'PASS', `MySQL OK. ${tables.length} tables, ${rows[0].cnt} users. Latency: ${latency}ms`);
  } catch (err) {
    addResult('database:mysql', 'CRIT', `MySQL connection failed: ${err.message}`);
  }

  // SQLite (backup)
  try {
    if (fs.existsSync(SQLITE_DB)) {
      const stat = fs.statSync(SQLITE_DB);
      addResult('database:sqlite', 'PASS', `SQLite backup exists (${formatBytes(stat.size)})`);
    } else {
      addResult('database:sqlite', 'WARN', 'SQLite backup file not found');
    }
  } catch (err) {
    addResult('database:sqlite', 'WARN', `SQLite check error: ${err.message}`);
  }

  // Redis (port 6380 with authentication)
  try {
    const REDIS_PORT = process.env.REDIS_PORT || '6380';
    const REDIS_PASS = process.env.REDIS_PASSWORD || 'RangerAI@Redis6380#2026!SecureKey';
    const redisCheck = exec(`redis-cli -p ${REDIS_PORT} -a "${REDIS_PASS}" --no-auth-warning ping 2>/dev/null`);
    if (redisCheck === 'PONG') {
      const info = exec(`redis-cli -p ${REDIS_PORT} -a "${REDIS_PASS}" --no-auth-warning info memory 2>/dev/null | grep used_memory_human`);
      const memUsed = info ? info.split(':')[1]?.trim() : 'unknown';
      metrics.redis_memory = memUsed;
      addResult('database:redis', 'PASS', `Redis PONG (port ${REDIS_PORT}). Memory: ${memUsed}`);
    } else {
      addResult('database:redis', 'WARN', `Redis ping returned: ${redisCheck}`);
    }
  } catch (err) {
    addResult('database:redis', 'WARN', `Redis check error: ${err.message}`);
  }
}

// ─── Check 4: Network Endpoints ─────────────────────────────
async function checkEndpoints() {
  // Agent API
  const agentResp = await httpGet(3002, '/api/health');
  metrics.agent_latency_ms = agentResp.latency;
  if (agentResp.status === 200) {
    try {
      const data = JSON.parse(agentResp.body);
      metrics.agent_version = data.version;
      if (agentResp.latency > THRESHOLDS.latency.crit) {
        addResult('endpoint:agent', 'CRIT', `Agent API responded but slow: ${agentResp.latency}ms`);
      } else if (agentResp.latency > THRESHOLDS.latency.warn) {
        addResult('endpoint:agent', 'WARN', `Agent API slow: ${agentResp.latency}ms (version: ${data.version})`);
      } else {
        addResult('endpoint:agent', 'PASS', `Agent API OK. Version: ${data.version}, Latency: ${agentResp.latency}ms`);
      }
    } catch {
      addResult('endpoint:agent', 'WARN', `Agent API returned non-JSON: ${agentResp.body.substring(0, 100)}`);
    }
  } else {
    addResult('endpoint:agent', 'CRIT', `Agent API unreachable: ${agentResp.error || `HTTP ${agentResp.status}`}`);
  }

  // Gateway (OpenClaw) — no health endpoint, check via /v1/chat/completions (expects 401 = alive)
  const gwResp = await httpGet(18789, '/v1/chat/completions');
  metrics.gateway_latency_ms = gwResp.latency;
  if (gwResp.status === 401 || gwResp.status === 200 || gwResp.status === 405) {
    addResult('endpoint:gateway', 'PASS', `Gateway OK (HTTP ${gwResp.status}). Latency: ${gwResp.latency}ms`);
  } else if (gwResp.status === 404) {
    // Gateway is running but endpoint not found — still alive
    addResult('endpoint:gateway', 'WARN', `Gateway running but /v1/chat/completions returned 404. Latency: ${gwResp.latency}ms`);
  } else {
    addResult('endpoint:gateway', 'CRIT', `Gateway unreachable: ${gwResp.error || `HTTP ${gwResp.status}`}`);
  }

  // File server
  const fsResp = await httpGet(3001, '/health');
  metrics.fileserver_latency_ms = fsResp.latency;
  if (fsResp.status === 200) {
    addResult('endpoint:fileserver', 'PASS', `File server OK. Latency: ${fsResp.latency}ms`);
  } else {
    addResult('endpoint:fileserver', 'WARN', `File server unreachable: ${fsResp.error || `HTTP ${fsResp.status}`}`);
  }
}

// ─── Check 5: Frontend Build Integrity ──────────────────────
async function checkFrontend() {
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    addResult('frontend:index', 'CRIT', `index.html not found at ${indexPath}`);
    return;
  }

  const indexStat = fs.statSync(indexPath);
  if (indexStat.size < 100) {
    addResult('frontend:index', 'CRIT', `index.html is too small (${indexStat.size} bytes)`);
    return;
  }

  // Check assets directory
  const assetsDir = path.join(DIST_DIR, 'assets');
  if (!fs.existsSync(assetsDir)) {
    addResult('frontend:assets', 'CRIT', 'Assets directory not found');
    return;
  }

  const assets = fs.readdirSync(assetsDir);
  const jsFiles = assets.filter(f => f.endsWith('.js'));
  const cssFiles = assets.filter(f => f.endsWith('.css'));

  // Check for zero-byte files
  const zeroByte = assets.filter(f => {
    const stat = fs.statSync(path.join(assetsDir, f));
    return stat.size === 0;
  });

  if (jsFiles.length === 0) {
    addResult('frontend:assets', 'CRIT', 'No JavaScript files in assets directory');
  } else if (zeroByte.length > 0) {
    addResult('frontend:assets', 'WARN', `Found ${zeroByte.length} zero-byte files: ${zeroByte.slice(0, 3).join(', ')}`);
  } else {
    // Parse index.html to find the actually-referenced main JS file
    let mainJs = null;
    const indexHtmlPath = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
      const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
      const match = htmlContent.match(/src="\/assets\/(index-[^"]+\.js)"/);
      if (match) mainJs = match[1];
    }
    // Fallback: pick largest index-* file
    if (!mainJs) {
      mainJs = jsFiles.filter(f => f.startsWith('index-')).sort((a, b) => fs.statSync(path.join(assetsDir, b)).size - fs.statSync(path.join(assetsDir, a)).size)[0];
    }
    if (mainJs) {
      const mainJsStat = fs.statSync(path.join(assetsDir, mainJs));
      if (mainJsStat.size < 10240) {
        addResult('frontend:assets', 'WARN', `Main JS file suspiciously small: ${formatBytes(mainJsStat.size)} (${mainJs})`);
      } else {
        addResult('frontend:assets', 'PASS', `Frontend OK. ${jsFiles.length} JS, ${cssFiles.length} CSS, ${assets.length} total files. Main: ${mainJs} (${formatBytes(mainJsStat.size)})`);
      }
    } else {
      addResult('frontend:assets', 'PASS', `Frontend OK. ${jsFiles.length} JS, ${cssFiles.length} CSS, ${assets.length} total files`);
    }
  }
}

// ─── Check 6: Workflow Scheduler ────────────────────────────
async function checkWorkflowScheduler() {
  try {
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({
      host: '127.0.0.1', port: 3306, user: 'root',
      password: process.env.MYSQL_PASSWORD || 'RangerAI2026!', database: process.env.MYSQL_DATABASE || 'rangerai',
      connectTimeout: 5000,
    });

    // Check workflow count
    const [wfRows] = await conn.execute('SELECT COUNT(*) as cnt FROM workflows');
    const [cronRows] = await conn.execute('SELECT COUNT(*) as cnt FROM workflows WHERE cronEnabled = 1');
    const [runRows] = await conn.execute('SELECT COUNT(*) as cnt FROM workflow_runs');
    
    metrics.workflow_count = wfRows[0].cnt;
    metrics.workflow_cron_enabled = cronRows[0].cnt;
    metrics.workflow_run_count = runRows[0].cnt;

    addResult('scheduler:workflows', 'PASS', 
      `${wfRows[0].cnt} workflows (${cronRows[0].cnt} cron-enabled), ${runRows[0].cnt} runs recorded`);

    // Check for stale workflow_runs (older than retention period)
    const [staleRuns] = await conn.execute(
      `SELECT COUNT(*) as cnt FROM workflow_runs WHERE createdAt < DATE_SUB(NOW(), INTERVAL ${THRESHOLDS.workflowRunDays} DAY)`
    );
    if (staleRuns[0].cnt > 0) {
      addResult('scheduler:cleanup', 'WARN', 
        `${staleRuns[0].cnt} workflow_runs older than ${THRESHOLDS.workflowRunDays} days — consider cleanup`);
      
      if (AUTO_FIX) {
        await conn.execute(
          `DELETE FROM workflow_runs WHERE createdAt < DATE_SUB(NOW(), INTERVAL ${THRESHOLDS.workflowRunDays} DAY)`
        );
        addResult('scheduler:cleanup:fix', 'PASS', `Auto-cleaned ${staleRuns[0].cnt} stale workflow_runs`);
      }
    } else {
      addResult('scheduler:cleanup', 'PASS', 'No stale workflow_runs');
    }

    await conn.end();
  } catch (err) {
    addResult('scheduler:workflows', 'WARN', `Workflow check error: ${err.message}`);
  }
}

// ─── Check 7: Logs & Audit ──────────────────────────────────
async function checkLogs() {
  // Check log directory size
  if (fs.existsSync(LOG_DIR)) {
    const logSize = exec(`du -sm ${LOG_DIR} 2>/dev/null | awk '{print $1}'`);
    const logSizeMB = logSize ? parseInt(logSize) : 0;
    metrics.log_dir_size_mb = logSizeMB;

    if (logSizeMB >= THRESHOLDS.logDirSize.crit) {
      addResult('logs:size', 'CRIT', `Log directory ${logSizeMB}MB (>= ${THRESHOLDS.logDirSize.crit}MB)`);
    } else if (logSizeMB >= THRESHOLDS.logDirSize.warn) {
      addResult('logs:size', 'WARN', `Log directory ${logSizeMB}MB (>= ${THRESHOLDS.logDirSize.warn}MB)`);
    } else {
      addResult('logs:size', 'PASS', `Log directory ${logSizeMB}MB`);
    }
  }

  // Check /var/log/rangerai-agent.log size
  const mainLogPath = '/var/log/rangerai-agent.log';
  if (fs.existsSync(mainLogPath)) {
    const stat = fs.statSync(mainLogPath);
    const sizeMB = Math.round(stat.size / (1024 * 1024));
    metrics.main_log_size_mb = sizeMB;

    if (sizeMB >= THRESHOLDS.logFileSize.crit) {
      addResult('logs:main', 'CRIT', `Main log ${sizeMB}MB (>= ${THRESHOLDS.logFileSize.crit}MB) — needs rotation`);
    } else if (sizeMB >= THRESHOLDS.logFileSize.warn) {
      addResult('logs:main', 'WARN', `Main log ${sizeMB}MB (>= ${THRESHOLDS.logFileSize.warn}MB)`);
    } else {
      addResult('logs:main', 'PASS', `Main log ${sizeMB}MB`);
    }
  }

  // Check SQLite DB integrity
  try {
    const dbHealth = await getDBHealthStatus();
    metrics.sqlite_db_healthy = dbHealth.healthy;
    metrics.sqlite_db_size_bytes = dbHealth.sizeBytes;
    metrics.sqlite_db_wal_bytes = dbHealth.walSizeBytes;
    metrics.sqlite_db_last_checked = dbHealth.lastChecked;
    metrics.sqlite_db_integrity = dbHealth.integrity;

    if (dbHealth.healthy) {
      addResult('database:sqlite:integrity', 'PASS', `SQLite integrity OK (${dbHealth.sizeBytes} bytes)`);
    } else {
      const severity = /malformed/i.test(dbHealth.integrity) ? 'CRIT' : 'WARN';
      addResult('database:sqlite:integrity', severity, dbHealth.integrity || 'integrity_check failed');
    }
  } catch (err) {
    addResult('database:sqlite:integrity', 'WARN', `SQLite integrity check error: ${err.message}`);
  }

  // Check audit_logs table size
  try {
    const mysql = (await import('mysql2/promise')).default;
    const conn = await mysql.createConnection({
      host: '127.0.0.1', port: 3306, user: 'root',
      password: process.env.MYSQL_PASSWORD || 'RangerAI2026!', database: process.env.MYSQL_DATABASE || 'rangerai',
      connectTimeout: 5000,
    });

    const [auditRows] = await conn.execute('SELECT COUNT(*) as cnt FROM audit_logs');
    const [oldRows] = await conn.execute(
      `SELECT COUNT(*) as cnt FROM audit_logs WHERE createdAt < DATE_SUB(NOW(), INTERVAL ${THRESHOLDS.auditLogDays} DAY)`
    );
    
    metrics.audit_log_count = auditRows[0].cnt;
    metrics.audit_log_stale = oldRows[0].cnt;

    if (oldRows[0].cnt > 100) {
      addResult('logs:audit', 'WARN', 
        `${oldRows[0].cnt} audit_logs older than ${THRESHOLDS.auditLogDays} days (${auditRows[0].cnt} total)`);
      
      if (AUTO_FIX) {
        await conn.execute(
          `DELETE FROM audit_logs WHERE createdAt < DATE_SUB(NOW(), INTERVAL ${THRESHOLDS.auditLogDays} DAY)`
        );
        addResult('logs:audit:fix', 'PASS', `Auto-cleaned ${oldRows[0].cnt} stale audit_logs`);
      }
    } else {
      addResult('logs:audit', 'PASS', `${auditRows[0].cnt} audit_logs (${oldRows[0].cnt} older than ${THRESHOLDS.auditLogDays} days)`);
    }

    await conn.end();
  } catch (err) {
    addResult('logs:audit', 'WARN', `Audit log check error: ${err.message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  await checkSystemResources();
  await checkServices();
  await checkDatabases();
  await checkEndpoints();
  await checkFrontend();
  await checkWorkflowScheduler();
  await checkLogs();

  const elapsed = Date.now() - startTime;
  metrics.check_duration_ms = elapsed;

  // Determine overall status
  const hasCrit = results.some(r => r.status === 'CRIT');
  const hasWarn = results.some(r => r.status === 'WARN');
  const overallStatus = hasCrit ? 'CRIT' : hasWarn ? 'WARN' : 'PASS';
  const passCount = results.filter(r => r.status === 'PASS').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  const critCount = results.filter(r => r.status === 'CRIT').length;

  if (FORMAT === 'json') {
    const output = {
      timestamp: new Date().toISOString(),
      status: overallStatus,
      summary: `${passCount}/${results.length} passed. ${warnCount} warnings, ${critCount} critical.`,
      duration_ms: elapsed,
      metrics,
      results,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Console output
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  RangerAI Health Check v1.0 (Iter-12A)');
    console.log('═══════════════════════════════════════════');
    console.log(`  Time: ${new Date().toISOString()}`);
    console.log(`  Duration: ${elapsed}ms`);
    console.log('');

    const statusIcon = { PASS: '✓', WARN: '⚠', CRIT: '✗' };
    const statusColor = { PASS: '\x1b[32m', WARN: '\x1b[33m', CRIT: '\x1b[31m' };
    const reset = '\x1b[0m';

    for (const r of results) {
      const icon = statusIcon[r.status];
      const color = statusColor[r.status];
      console.log(`  ${color}${icon}${reset} [${r.component}] ${r.message}`);
    }

    console.log('');
    console.log('───────────────────────────────────────────');
    const overallColor = statusColor[overallStatus];
    console.log(`  ${overallColor}Overall: ${overallStatus}${reset} — ${passCount} pass, ${warnCount} warn, ${critCount} crit`);
    console.log('═══════════════════════════════════════════');
    console.log('');
  }

  // ─── Persist results (Dual-Track Strategy) ───────────────
  const PERSIST = !process.argv.includes('--no-persist');
  const TRIGGERED_BY = process.argv.find(a => a.startsWith('--triggered-by='))?.split('=')[1] || 'manual';

  if (PERSIST) {
    try {
      const mysql = (await import('mysql2/promise')).default;
      const conn = await mysql.createConnection({
        host: '127.0.0.1', port: 3306, user: 'root',
        password: process.env.MYSQL_PASSWORD || 'RangerAI2026!', database: process.env.MYSQL_DATABASE || 'rangerai',
        connectTimeout: 5000,
      });

      // Track 1: Always write to health_check_runs
      await conn.execute(
        `INSERT INTO health_check_runs (status, summary, duration_ms, pass_count, warn_count, crit_count, metrics, results, triggered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          overallStatus,
          `${passCount}/${results.length} passed. ${warnCount} warnings, ${critCount} critical.`,
          elapsed,
          passCount, warnCount, critCount,
          JSON.stringify(metrics),
          JSON.stringify(results),
          TRIGGERED_BY,
        ]
      );

      // Track 2: State transition detection → write to audit_logs
      const [lastRuns] = await conn.execute(
        'SELECT status FROM health_check_runs ORDER BY id DESC LIMIT 2'
      );

      const dbIntegrityDetail = String(metrics.sqlite_db_integrity || '');
      if (/malformed/i.test(dbIntegrityDetail)) {
        await conn.execute(
          `INSERT INTO audit_logs (userId, action, target, detail, createdAt)
           VALUES (?, ?, ?, ?, NOW())`,
          [
            'system',
            'DIAGNOSTIC',
            'sqlite.integrity',
            JSON.stringify({ event_type: 'DB_INTEGRITY_DIAGNOSTIC', detail: dbIntegrityDetail, triggered_by: TRIGGERED_BY }),
          ]
        );
      }
      // lastRuns[0] is current (just inserted), lastRuns[1] is previous
      if (lastRuns.length >= 2) {
        const prevStatus = lastRuns[1].status;
        const currStatus = lastRuns[0].status;
        
        if (prevStatus !== currStatus) {
          // State transition detected! Write to audit_logs
          let severity = 'info';
          if (currStatus === 'CRIT') severity = 'critical';
          else if (currStatus === 'WARN') severity = 'warning';
          else if (currStatus === 'PASS' && (prevStatus === 'CRIT' || prevStatus === 'WARN')) severity = 'resolved';

          const critResults = results.filter(r => r.status === 'CRIT' || r.status === 'WARN');
          const detail = JSON.stringify({
            event_type: 'HEALTH_CHECK_STATE_CHANGE',
            severity,
            previous_status: prevStatus,
            current_status: currStatus,
            components: critResults.map(r => `${r.component}: ${r.message}`),
            triggered_by: TRIGGERED_BY,
          });

          await conn.execute(
            `INSERT INTO audit_logs (userId, action, target, detail, createdAt)
             VALUES (?, ?, ?, ?, NOW())`,
            [
              'system',
              `health.${severity}`,
              'health-check',
              detail,
            ]
          );

          if (FORMAT !== 'json') {
            console.log(`  [audit] State change: ${prevStatus} → ${currStatus} (${severity}) — written to audit_logs`);
          }
        }
      }

      await conn.end();
    } catch (err) {
      if (FORMAT !== 'json') {
        console.error(`  [persist] Failed to save results: ${err.message}`);
      }
    }
  }

  // ── Alert Integration (Iter-12C) ──
  try {
    const { checkAndAlert } = await import('../alert-manager.mjs');
    const alertResult = await checkAndAlert({
      status: hasCrit ? 'CRIT' : hasWarn ? 'WARN' : 'PASS',
      results,
    });
    if (FORMAT !== 'json' && alertResult) {
      const { criticals, warnings } = alertResult;
      if (criticals > 0 || warnings > 0) {
        console.log(`  [alert] Sent ${criticals} critical + ${warnings} warning alerts`);
      }
    }
  } catch (alertErr) {
    if (FORMAT !== 'json') {
      console.error(`  [alert] Alert check failed: ${alertErr.message}`);
    }
  }
  // ── Remediation Integration (Iter-13) ──
  if (hasCrit || hasWarn) {
    try {
      const { attemptRemediation } = await import('../remediation-engine.mjs');
      const remResult = await attemptRemediation(results, { dryRun: false });
      if (FORMAT !== 'json') {
        if (remResult.attempted > 0) {
          console.log(`  [remediation] ${remResult.succeeded}/${remResult.attempted} auto-repairs succeeded, ${remResult.circuitTripped} circuit-tripped`);
        }
      }
    } catch (remErr) {
      if (FORMAT !== 'json') {
        console.error(`  [remediation] Self-healing failed: ${remErr.message}`);
      }
    }
  }



  // Exit code
  process.exit(hasCrit ? 2 : hasWarn ? 1 : 0);
}

main().catch(err => {
  console.error('Health check failed:', err);
  process.exit(2);
});
