import fs from 'fs';
const LOG = 'agent/logs/verification-audit.jsonl';
export function appendVerificationAudit(entry) {
  fs.mkdirSync('agent/logs', { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ ...entry, ts: Date.now() }) + '\n');
}
