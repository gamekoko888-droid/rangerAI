#!/usr/bin/env node
/**
 * browser-golden-task.mjs — R17-T4 Browser End-to-End Golden Task
 *
 * Runs a complete browser workflow:
 *   1. Navigate to a target URL
 *   2. Extract text content
 *   3. Take a screenshot
 *   4. Click a link (if available)
 *   5. Verify evidence was saved to DB
 *
 * Usage: node browser-golden-task.mjs [baseUrl]
 * Default baseUrl: http://localhost:3002
 */

const BASE_URL = process.argv[2] || 'http://localhost:3002';
const SESSION_ID = `golden-task-${Date.now()}`;
const TARGET_URL = 'https://example.com';

async function apiCall(endpoint, body) {
  const url = `${BASE_URL}/api/browser/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-call': '1',
    },
    body: JSON.stringify({ sessionId: SESSION_ID, ...body }),
  });
  if (!res.ok) throw new Error(`${endpoint} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function adminCall(endpoint) {
  const url = `${BASE_URL}/api/admin/${endpoint}`;
  const res = await fetch(url, {
    headers: { 'x-internal-call': '1' },
  });
  if (!res.ok) throw new Error(`admin ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function run() {
  const results = { steps: [], passed: 0, failed: 0, sessionId: SESSION_ID };

  // Step 1: Navigate
  console.log('\n=== Step 1: Navigate to', TARGET_URL, '===');
  try {
    const nav = await apiCall('navigate', { url: TARGET_URL });
    const ok = nav.success && nav.title && nav.title.includes('Example');
    results.steps.push({ step: 'navigate', ok, title: nav.title, url: nav.url, statusCode: nav.statusCode });
    ok ? results.passed++ : results.failed++;
    console.log(ok ? '  ✅ PASS' : '  ❌ FAIL', `title="${nav.title}" status=${nav.statusCode}`);
  } catch (err) {
    results.steps.push({ step: 'navigate', ok: false, error: err.message });
    results.failed++;
    console.log('  ❌ FAIL', err.message);
  }

  // Step 2: Extract text
  console.log('\n=== Step 2: Extract text ===');
  try {
    const text = await apiCall('extract-text', {});
    const ok = text.success && text.text && text.text.length > 50;
    results.steps.push({ step: 'extract_text', ok, textLength: text.text?.length, preview: text.text?.substring(0, 200) });
    ok ? results.passed++ : results.failed++;
    console.log(ok ? '  ✅ PASS' : '  ❌ FAIL', `textLength=${text.text?.length}`);
  } catch (err) {
    results.steps.push({ step: 'extract_text', ok: false, error: err.message });
    results.failed++;
    console.log('  ❌ FAIL', err.message);
  }

  // Step 3: Screenshot
  console.log('\n=== Step 3: Take screenshot ===');
  try {
    const ss = await apiCall('screenshot', { fullPage: false });
    const ok = ss.success && ss.base64 && ss.base64.length > 100;
    results.steps.push({ step: 'screenshot', ok, base64Length: ss.base64?.length, evidencePath: ss.evidencePath, width: ss.width, height: ss.height });
    ok ? results.passed++ : results.failed++;
    console.log(ok ? '  ✅ PASS' : '  ❌ FAIL', `base64Length=${ss.base64?.length} evidence=${ss.evidencePath || 'none'}`);
  } catch (err) {
    results.steps.push({ step: 'screenshot', ok: false, error: err.message });
    results.failed++;
    console.log('  ❌ FAIL', err.message);
  }

  // Step 4: Click "More information..." link on example.com
  console.log('\n=== Step 4: Click link ===');
  try {
    const click = await apiCall('click', { selector: 'a' });
    const ok = click.success && click.clicked;
    results.steps.push({ step: 'click', ok, url: click.url, title: click.title });
    ok ? results.passed++ : results.failed++;
    console.log(ok ? '  ✅ PASS' : '  ❌ FAIL', `url=${click.url}`);
  } catch (err) {
    results.steps.push({ step: 'click', ok: false, error: err.message });
    results.failed++;
    console.log('  ❌ FAIL', err.message);
  }

  // Step 5: Verify evidence in DB
  console.log('\n=== Step 5: Verify evidence in DB ===');
  try {
    const evidence = await adminCall(`browser-evidence?sessionId=${SESSION_ID}`);
    const evidenceCount = evidence.evidence?.length || 0;
    const ok = evidenceCount >= 2; // At least navigate text + screenshot
    results.steps.push({ step: 'verify_evidence', ok, evidenceCount, types: evidence.evidence?.map(e => e.type) });
    ok ? results.passed++ : results.failed++;
    console.log(ok ? '  ✅ PASS' : '  ❌ FAIL', `evidenceCount=${evidenceCount} types=${evidence.evidence?.map(e => e.type).join(',')}`);
  } catch (err) {
    results.steps.push({ step: 'verify_evidence', ok: false, error: err.message });
    results.failed++;
    console.log('  ❌ FAIL', err.message);
  }

  // Step 6: Verify browser actions in DB
  console.log('\n=== Step 6: Verify browser actions log ===');
  try {
    const actions = await adminCall(`browser-actions?sessionId=${SESSION_ID}`);
    const actionCount = actions.actions?.length || 0;
    const ok = actionCount >= 3; // navigate + extract_text + screenshot + click
    results.steps.push({ step: 'verify_actions', ok, actionCount, actions: actions.actions?.map(a => `${a.action}:${a.success}`) });
    ok ? results.passed++ : results.failed++;
    console.log(ok ? '  ✅ PASS' : '  ❌ FAIL', `actionCount=${actionCount}`);
  } catch (err) {
    results.steps.push({ step: 'verify_actions', ok: false, error: err.message });
    results.failed++;
    console.log('  ❌ FAIL', err.message);
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`GOLDEN TASK RESULT: ${results.passed}/${results.passed + results.failed} steps passed`);
  console.log(`Session: ${SESSION_ID}`);
  console.log(results.failed === 0 ? '🎉 ALL PASSED' : `⚠️  ${results.failed} FAILED`);
  console.log('='.repeat(50));

  // Output JSON for programmatic verification
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(results, null, 2));
}

run().catch(err => {
  console.error('Golden task failed:', err);
  process.exit(1);
});
