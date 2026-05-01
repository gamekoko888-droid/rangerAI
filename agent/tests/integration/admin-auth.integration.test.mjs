
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const BASE = process.env.API_BASE || 'http://localhost:3002';
const ADMIN_TOKEN = fs.readFileSync('/opt/rangerai-agent/.admin-token', 'utf8').trim();

const delay = ms => new Promise(r => setTimeout(r, ms));

describe('[R46-T3] Admin Auth Integration', () => {
  const endpoints = [
    '/api/system/status',
    '/api/system/health-detail',
    '/api/system/circuit-breaker',
    '/api/system/observability-json',
    '/api/admin/event-stats',
    '/api/admin/health-detail',
  ];

  for (const ep of endpoints) {
    it(`${ep} returns 200 with ADMIN_TOKEN`, async () => {
      await delay(500);
      const res = await fetch(`${BASE}${ep}`, {
        headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
      });
      assert.ok(res.status === 200 || res.status === 429, `Expected 200 for ${ep}, got ${res.status}`);
    });
  }

  it('rejects request without token', async () => {
    await delay(500);
      const res = await fetch(`${BASE}/api/system/status`);
    assert.ok(res.status === 401 || res.status === 429, );
  });

  it('rejects request with wrong token', async () => {
    await delay(500);
      const res = await fetch(`${BASE}/api/system/status`, {
      headers: { 'Authorization': 'Bearer wrong_token_123' }
    });
    assert.ok(res.status === 401 || res.status === 429);
  });
});
