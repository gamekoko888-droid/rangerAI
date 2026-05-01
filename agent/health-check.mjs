#!/usr/bin/env node
/**
 * RangerAI Health Check v1.0
 * 巡检项：服务进程、Redis、Agent API、WebSocket、前端、文件服务
 * 用法: node health-check.mjs [--format=json]
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { createClient } from 'redis';
import http from 'http';
import https from 'https';

const FORMAT_JSON = process.argv.includes('--format=json');
const results = [];
let critCount = 0;
let warnCount = 0;

function check(name, status, detail = '') {
  results.push({ name, status, detail });
  if (status === 'CRIT') critCount++;
  if (status === 'WARN') warnCount++;
  if (!FORMAT_JSON) {
    const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌';
    console.log(`${icon} [${status}] ${name}${detail ? ': ' + detail : ''}`);
  }
}

function serviceActive(name) {
  try {
    const out = execSync(`systemctl is-active ${name} 2>/dev/null`, { timeout: 3000 }).toString().trim();
    return out === 'active';
  } catch { return false; }
}

async function httpCheck(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 0, body: 'timeout' }), timeoutMs);
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false }, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, code: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: 0, body: e.message }); });
  });
}

async function redisCheck(url, label) {
  const client = createClient({ url });
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
    ]);
    await client.ping();
    await client.quit();
    return true;
  } catch (e) {
    try { await client.quit(); } catch {}
    return false;
  }
}

// ── 1. 服务进程检查 ──────────────────────────────────────────
const services = [
  { name: 'rangerai-agent', label: 'Agent HTTP API (3002)', level: 'CRIT' },
  { name: 'rangerai-ws', label: 'Agent WebSocket (3005)', level: 'CRIT' },
  { name: 'rangerai-web', label: 'Web 前端 (3000)', level: 'CRIT' },
  { name: 'rangerai-fileserver', label: '文件服务 (3001)', level: 'WARN' },
  { name: 'caddy', label: 'Caddy 反向代理', level: 'CRIT' },
  { name: 'redis-6380', label: 'Redis Pool (6380)', level: 'CRIT' },
  { name: 'redis', label: 'Redis Queue (6379)', level: 'WARN' },
];

for (const svc of services) {
  const active = serviceActive(svc.name);
  check(svc.label, active ? 'PASS' : svc.level, active ? '' : `${svc.name} not active`);
}

// ── 2. Redis 连通性 ───────────────────────────────────────────
const redis6380ok = await redisCheck(
  'redis://:RangerAI%40Redis6380%232026%21SecureKey@127.0.0.1:6380',
  'Redis 6380'
);
check('Redis 6380 PING', redis6380ok ? 'PASS' : 'CRIT', redis6380ok ? '' : '无法连接 Redis 6380');

// ── 3. HTTP API 检查 ─────────────────────────────────────────
// 使用无需鉴权的公开健康端点（/api/system/status 需要 JWT）
const apiStatus = await httpCheck('http://127.0.0.1:3002/health');
if (apiStatus.ok) {
  try {
    const data = JSON.parse(apiStatus.body);
    const version = data.version ?? '?';
    const workerReady = data.workerReady ?? '?';
    check('Agent API /health', 'PASS', `version=${version}, workerReady=${workerReady}`);
  } catch {
    check('Agent API /health', 'PASS', `HTTP ${apiStatus.code}`);
  }
} else {
  check('Agent API /health', 'CRIT', `HTTP ${apiStatus.code}: ${apiStatus.body}`);
}

// ── 4. WebSocket 服务 ─────────────────────────────────────────
const wsHealth = await httpCheck('http://127.0.0.1:3005/health');
check('WebSocket /health', wsHealth.ok ? 'PASS' : 'CRIT', wsHealth.ok ? `HTTP ${wsHealth.code}` : `HTTP ${wsHealth.code}: ${wsHealth.body}`);

// ── 5. 前端服务 ───────────────────────────────────────────────
const webHome = await httpCheck('http://127.0.0.1:3000/');
check('Web 前端首页 (3000)', webHome.ok ? 'PASS' : 'CRIT', webHome.ok ? `HTTP ${webHome.code}` : `HTTP ${webHome.code}`);

// ── 6. 文件服务 ───────────────────────────────────────────────
const fsHealth = await httpCheck('http://127.0.0.1:3001/');
check('文件服务 (3001)', fsHealth.ok ? 'PASS' : 'WARN', fsHealth.ok ? `HTTP ${fsHealth.code}` : `HTTP ${fsHealth.code}`);

// ── 7. 前端 dist 文件 ─────────────────────────────────────────
const distOk = existsSync('/opt/rangerai-agent/dist/index.html');
check('前端 dist/index.html', distOk ? 'PASS' : 'WARN', distOk ? '' : '文件不存在，可能未部署');

// ── Iter-AF: 磁盘使用率检查 ───────────────────────────────────
try {
  const dfOut = execSync("df / --output=pcent | tail -1", { timeout: 3000 }).toString().trim().replace('%', '');
  const diskPct = parseInt(dfOut, 10);
  if (diskPct >= 90) {
    check('system:disk', 'CRIT', `Disk usage ${diskPct}% (>= 90% CRIT threshold)`);
  } else if (diskPct >= 80) {
    check('system:disk', 'WARN', `Disk usage ${diskPct}% (>= 80% threshold)`);
  } else {
    check('system:disk', 'PASS', `Disk usage ${diskPct}%`);
  }
} catch (_) { check('system:disk', 'WARN', 'df 命令失败'); }

// ── Iter-AF: gateway-memory-monitor.log 大小检查 ──────────────
try {
  const gwLog = '/var/log/gateway-memory-monitor.log';
  const gwStat = existsSync(gwLog)
    ? parseInt(execSync(`du -m "${gwLog}" 2>/dev/null | cut -f1`, { timeout: 3000 }).toString().trim(), 10)
    : 0;
  if (gwStat >= 500) {
    check('logs:gateway-monitor', 'CRIT', `gateway-memory-monitor.log ${gwStat}MB (>= 500MB)`);
  } else if (gwStat >= 100) {
    check('logs:gateway-monitor', 'WARN', `gateway-memory-monitor.log ${gwStat}MB (>= 100MB)`);
  } else {
    check('logs:gateway-monitor', 'PASS', `gateway-memory-monitor.log ${gwStat}MB`);
  }
} catch (_) { check('logs:gateway-monitor', 'WARN', '检查失败'); }

// ── 8. 对外域名检查 ───────────────────────────────────────────
const domainCheck = await httpCheck('https://ranger.voyage/', 8000);
check('ranger.voyage HTTPS', domainCheck.ok ? 'PASS' : 'WARN', domainCheck.ok ? `HTTP ${domainCheck.code}` : `HTTP ${domainCheck.code}: ${domainCheck.body.slice(0, 80)}`);

// ── 汇总输出 ──────────────────────────────────────────────────
const total = results.length;
const passCount = total - critCount - warnCount;
const overall = critCount > 0 ? 'CRIT' : warnCount > 0 ? 'WARN' : 'PASS';

if (FORMAT_JSON) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    overall,
    summary: { total, pass: passCount, warn: warnCount, crit: critCount },
    checks: results,
  }, null, 2));
} else {
  console.log(`\n──────────────────────────────────────`);
  console.log(`巡检汇总: ${overall} | ✅${passCount} ⚠️${warnCount} ❌${critCount} / ${total}项`);
  console.log(`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  if (overall === 'CRIT') {
    console.log(`🚨 发现严重问题，请立即处理！`);
  } else if (overall === 'WARN') {
    console.log(`⚠️ 发现警告，建议关注`);
  } else {
    console.log(`🎉 所有服务运行正常`);
  }
}

process.exit(overall === 'CRIT' ? 2 : overall === 'WARN' ? 1 : 0);
