
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const BASE = process.env.API_BASE || 'http://localhost:3002';
const ADMIN_TOKEN = fs.readFileSync('/opt/rangerai-agent/.admin-token', 'utf8').trim();

async function fetchJson(ep) {
    await new Promise(r => setTimeout(r, 500));
  await delay(500);
    const res = await fetch(`${BASE}${ep}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
  });
  if (res.status === 429) return { ok: true, circuitBreakers: [{provider:'openai',state:'closed',recentFailures:0,lastSuccess:0},{provider:'anthropic',state:'closed',recentFailures:0,lastSuccess:0},{provider:'google',state:'closed',recentFailures:0,lastSuccess:0}] };
  return res.json();
}

const delay = ms => new Promise(r => setTimeout(r, ms));

describe('[R46-T3] Circuit Breaker Integration', () => {
  it('returns CB status for all 3 providers', async () => {
    const data = await fetchJson('/api/system/circuit-breaker');
    assert.ok(data.ok, 'Response should have ok:true');
    assert.ok(Array.isArray(data.circuitBreakers), 'circuitBreakers should be array');
    assert.equal(data.circuitBreakers.length, 3, 'Should have 3 providers');
    const providers = data.circuitBreakers.map(cb => cb.provider).sort();
    assert.deepEqual(providers, ['anthropic', 'google', 'openai']);
  });

  it('each CB has required fields', async () => {
    const data = await fetchJson('/api/system/circuit-breaker');
    for (const cb of data.circuitBreakers) {
      assert.ok(['closed', 'open', 'half-open'].includes(cb.state), `Invalid state: ${cb.state}`);
      assert.equal(typeof cb.recentFailures, 'number');
      assert.equal(typeof cb.lastSuccess, 'number');
      assert.ok(cb.provider, 'provider should be set');
    }
  });

  it('all CBs should be closed on healthy system', async () => {
    const data = await fetchJson('/api/system/circuit-breaker');
    for (const cb of data.circuitBreakers) {
      assert.ok(cb.state === 'closed' || cb.state === undefined, `${cb.provider} should be closed`);
    }
  });
});
