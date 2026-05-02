#!/usr/bin/env node
import { execSync } from 'child_process';

const API_BASE = process.env.RANGER_API_BASE || 'http://127.0.0.1:3002';
const args = new Set(process.argv.slice(2));

const checks = [
  { name: 'quality_gate', cmd: 'node agent/scripts/r121-quality-gate.mjs' },
  { name: 'v6_integration', cmd: 'node --test agent/tests/integration/v6-chat-flow.integration.test.mjs' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyTaskLoop() {
  const sessionKey = `verify-${Date.now()}`;
  const startResp = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '验证主循环健康检查：请回复OK', sessionKey }),
  });
  if (!startResp.ok) throw new Error(`chat_start_failed:${startResp.status}`);

  const timeoutMs = 60000;
  const startTs = Date.now();
  while (Date.now() - startTs < timeoutMs) {
    await sleep(2000);
    const r = await fetch(`${API_BASE}/api/task-status/${encodeURIComponent(sessionKey)}`);
    if (!r.ok) continue;
    const data = await r.json();
    const status = String(data?.status || '').toLowerCase();
    if (status === 'done' || status === 'completed' || status === 'success') {
      return { pass: true, sessionKey, status };
    }
    if (status === 'failed' || status === 'error') {
      return { pass: false, sessionKey, status, error: data?.error || 'task failed' };
    }
  }
  return { pass: false, sessionKey, status: 'timeout', error: 'task loop timeout' };
}

const results = [];
for (const c of checks) {
  try {
    execSync(c.cmd, { stdio: 'pipe' });
    results.push({ name: c.name, pass: true });
  } catch (e) {
    results.push({ name: c.name, pass: false, error: String(e.message || e) });
  }
}

if (args.has('--with-task-loop')) {
  try {
    const taskResult = await verifyTaskLoop();
    results.push({ name: 'task_loop', ...taskResult });
  } catch (e) {
    results.push({ name: 'task_loop', pass: false, error: String(e.message || e) });
  }
}

const pass = results.every((r) => r.pass);
console.log(JSON.stringify({ pass, results, ts: Date.now() }, null, 2));
process.exit(pass ? 0 : 1);
