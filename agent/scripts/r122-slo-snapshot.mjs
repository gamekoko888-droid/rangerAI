#!/usr/bin/env node
import fs from 'fs';

const now = new Date().toISOString();

const rules = [
  { key: 'ws_server_heartbeat_ms', file: 'agent/modules/ws-server.mjs', regex: /HEARTBEAT_INTERVAL_MS\s*=\s*30000/, target: 30000 },
  { key: 'ws_client_pong_timeout_ms', file: 'web/client/src/hooks/useWebSocket.ts', regex: /PONG_TIMEOUT\s*=\s*45000/, target: 45000 },
  { key: 'chat_rate_limit_per_min', file: 'agent/api/chat-api.mjs', regex: /CHAT_RATE_LIMIT_MAX\s*=\s*60/, target: 60 },
  { key: 'conversations_api_enabled', file: 'agent/api/chat-api.mjs', regex: /urlPath\s*===\s*'\/api\/conversations'/, target: true },
  { key: 'exec_policy_guard_enabled', file: 'agent/worker/openclaw-handler.legacy.mjs', regex: /POLICY_DENY_PATTERNS/, target: true },
];

const checks = rules.map((r) => {
  const source = fs.readFileSync(r.file, 'utf8');
  const ok = r.regex.test(source);
  return { metric: r.key, ok, target: r.target, file: r.file };
});

const passed = checks.filter(c => c.ok).length;
const total = checks.length;
const score = total === 0 ? 1 : passed / total;

const snapshot = {
  generatedAt: now,
  sloScore: Number(score.toFixed(4)),
  passed,
  total,
  checks,
};

console.log(JSON.stringify(snapshot, null, 2));
if (passed !== total) process.exit(1);
