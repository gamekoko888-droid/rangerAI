
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

const BASE = process.env.API_BASE || 'http://localhost:3002';
const ADMIN_TOKEN = fs.readFileSync('/opt/rangerai-agent/.admin-token', 'utf8').trim();

const delay = ms => new Promise(r => setTimeout(r, ms));

describe('[R46-T3] Observability Integration', () => {
  const obsPath = '/opt/rangerai-agent/dist/admin/observability.html';

  it('observability.html exists', () => {
    assert.ok(fs.existsSync(obsPath), 'observability.html should exist');
  });

  it('has 30d time range option', () => {
    const html = fs.readFileSync(obsPath, 'utf8');
    assert.ok(html.includes('value="720"'), 'Should have 30d (720h) option');
  });

  it('has Provider Health panel', () => {
    const html = fs.readFileSync(obsPath, 'utf8');
    assert.ok(html.includes('Provider') || html.includes('provider'), 'Should have Provider panel');
  });

  it('has CSV export', () => {
    const html = fs.readFileSync(obsPath, 'utf8');
    assert.ok(html.includes('CSV') || html.includes('csv') || html.includes('exportCSV'), 'Should have CSV export');
  });

  it('has alert threshold config', () => {
    const html = fs.readFileSync(obsPath, 'utf8');
    assert.ok(html.includes('threshold') || html.includes('alert') || html.includes('WARN') || html.includes('CRIT'), 'Should have alert thresholds');
  });

  it('/api/system/observability-json returns data', async () => {
    await delay(1000);
    const res = await fetch(`${BASE}/api/system/observability-json`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    assert.ok(res.status === 200 || res.status === 429, );
    const data = await res.json();
    if (res.status === 200) { assert.ok(data.overview || data.period || data.ok, 'Should return observability data'); }
  });
});
