#!/usr/bin/env node
import fs from 'fs';

const checks = [
  {
    file: 'agent/modules/ws-server.mjs',
    pattern: /HEARTBEAT_INTERVAL_MS\s*=\s*30000/,
    desc: 'WS server heartbeat interval is 30000ms',
  },
  {
    file: 'web/client/src/hooks/useWebSocket.ts',
    pattern: /const\s+PONG_TIMEOUT\s*=\s*45000/,
    desc: 'Client pong timeout is 45000ms',
  },
  {
    file: 'agent/api/chat-api.mjs',
    pattern: /CHAT_RATE_LIMIT_MAX\s*=\s*60/,
    desc: 'Chat API rate limit is 60 req/min',
  },
  {
    file: 'agent/api/chat-api.mjs',
    pattern: /urlPath\s*===\s*'\/api\/conversations'/,
    desc: 'Conversations API route exists',
  },
  {
    file: 'agent/worker/openclaw-handler.legacy.mjs',
    pattern: /POLICY_DENY_PATTERNS/,
    desc: 'Exec safety deny-list is present',
  },
];

let failed = 0;
for (const c of checks) {
  const text = fs.readFileSync(c.file, 'utf8');
  if (c.pattern.test(text)) {
    console.log(`✅ ${c.desc}`);
  } else {
    console.log(`❌ ${c.desc}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n[R121] Quality gate failed: ${failed} check(s) failed.`);
  process.exit(1);
}

console.log('\n[R121] Quality gate passed.');
