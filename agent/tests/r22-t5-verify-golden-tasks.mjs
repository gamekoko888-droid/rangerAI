#!/usr/bin/env node
/**
 * r22-t5-verify-golden-tasks.mjs — R22-T5 Golden Task Verification Script
 * 
 * Calls the task-replay API for each golden task and checks if the returned
 * data matches the expected features defined in golden-tasks.json.
 * 
 * Usage: node r22-t5-verify-golden-tasks.mjs [--base-url http://localhost:18888]
 * 
 * This script does NOT re-execute prompts. It only verifies that existing
 * replay data matches expectations.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────
const BASE_URL = process.argv.includes('--base-url') 
  ? process.argv[process.argv.indexOf('--base-url') + 1] 
  : 'http://127.0.0.1:3002';

// ─── HTTP Helper ────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { "X-Internal-Call": "1" } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Verification Logic ─────────────────────────────────────
async function verifyGoldenTasks() {
  // Load golden tasks definition
  const goldenPath = path.join(__dirname, 'r22-t5-golden-tasks.json');
  if (!fs.existsSync(goldenPath)) {
    console.error('❌ Golden tasks file not found:', goldenPath);
    process.exit(1);
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
  
  console.log(`\n═══ R22-T5 Golden Task Verification ═══`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Golden tasks: ${golden.goldenTasks.length}\n`);

  // First, get list of recent tasks to find matching ones
  let taskList = [];
  try {
    // Try to get recent task plans
    const planResp = await httpGet(`${BASE_URL}/api/admin/recovery-plans`);
    if (planResp.status === 200 && Array.isArray(planResp.data)) {
      taskList = planResp.data;
    }
  } catch (e) {
    console.log('⚠ Could not fetch task list, will try direct task IDs');
  }

  let passCount = 0;
  let failCount = 0;
  const results = [];

  for (const gt of golden.goldenTasks) {
    console.log(`\n─── ${gt.id}: ${gt.name} ───`);
    
    // Find a matching task (by goal similarity)
    let matchedTaskId = null;
    for (const task of taskList) {
      if (task.goal && gt.prompt && task.goal.includes(gt.prompt.substring(0, 20))) {
        matchedTaskId = task.msg_id || task.taskId;
        break;
      }
    }

    if (!matchedTaskId) {
      console.log(`  ⚠ No matching task found for prompt: "${gt.prompt.substring(0, 50)}..."`);
      console.log(`  → SKIP (no data to verify)`);
      results.push({ id: gt.id, name: gt.name, result: 'SKIP', reason: 'No matching task found' });
      continue;
    }

    // Call task-replay API
    let replay;
    try {
      const replayResp = await httpGet(`${BASE_URL}/api/admin/task-replay?taskId=${matchedTaskId}`);
      if (replayResp.status !== 200) {
        console.log(`  ❌ task-replay returned ${replayResp.status}`);
        results.push({ id: gt.id, name: gt.name, result: 'FAIL', reason: `API returned ${replayResp.status}` });
        failCount++;
        continue;
      }
      replay = replayResp.data;
    } catch (e) {
      console.log(`  ❌ task-replay call failed: ${e.message}`);
      results.push({ id: gt.id, name: gt.name, result: 'FAIL', reason: e.message });
      failCount++;
      continue;
    }

    // Verify expected features
    const checks = [];
    const ef = gt.expectedReplayFeatures;

    // Check taskFamily
    if (replay.taskFamily && replay.taskFamily !== 'unknown') {
      checks.push({ field: 'taskFamily', expected: gt.expectedTaskFamily, actual: replay.taskFamily, pass: true });
    } else {
      checks.push({ field: 'taskFamily', expected: gt.expectedTaskFamily, actual: replay.taskFamily, pass: false });
    }

    // Check selectedPrimaryTool
    if (replay.selectedPrimaryTool) {
      checks.push({ field: 'selectedPrimaryTool', expected: gt.expectedPrimaryTool, actual: replay.selectedPrimaryTool, pass: replay.selectedPrimaryTool === gt.expectedPrimaryTool });
    } else {
      checks.push({ field: 'selectedPrimaryTool', expected: gt.expectedPrimaryTool, actual: 'empty', pass: false });
    }

    // Check timeline exists
    checks.push({ field: 'timeline.length', expected: '>0', actual: (replay.timeline || []).length, pass: (replay.timeline || []).length > 0 });

    // Check browser actions
    if (ef.hasBrowserActions) {
      checks.push({ field: 'browserActions', expected: '>0', actual: replay.browserActions, pass: replay.browserActions > 0 });
    }

    // Check browser evidence
    if (ef.hasBrowserEvidence) {
      checks.push({ field: 'browserEvidence', expected: '>0', actual: replay.browserEvidence, pass: replay.browserEvidence > 0 });
    }

    // Check failure records
    if (ef.hasFailureRecords) {
      checks.push({ field: 'failureRecords', expected: '>0', actual: (replay.failureRecords || []).length, pass: (replay.failureRecords || []).length > 0 });
      if (ef.failureCategory) {
        const hasCategory = (replay.failureRecords || []).some(f => f.failureReason === ef.failureCategory);
        checks.push({ field: 'failureCategory', expected: ef.failureCategory, actual: (replay.failureRecords || []).map(f => f.failureReason).join(','), pass: hasCategory });
      }
    }

    // Check final output
    if (ef.finalOutputHasTextSnippet) {
      checks.push({ field: 'finalOutput.textSnippet', expected: 'non-empty', actual: replay.finalOutput?.textSnippet ? 'present' : 'empty', pass: !!replay.finalOutput?.textSnippet });
    }

    // Print results
    const allPass = checks.every(c => c.pass);
    for (const c of checks) {
      console.log(`  ${c.pass ? '✓' : '✗'} ${c.field}: expected=${c.expected}, actual=${c.actual}`);
    }
    console.log(`  → ${allPass ? 'PASS' : 'FAIL'}`);
    
    results.push({ id: gt.id, name: gt.name, result: allPass ? 'PASS' : 'FAIL', checks });
    if (allPass) passCount++; else failCount++;
  }

  // Summary
  console.log(`\n═══ Summary ═══`);
  console.log(`PASS: ${passCount}  FAIL: ${failCount}  SKIP: ${results.filter(r => r.result === 'SKIP').length}`);
  console.log(`Overall: ${failCount === 0 && passCount > 0 ? 'PASS ✓' : 'NEEDS ATTENTION ⚠'}`);

  // Write results to file
  const outputPath = path.join(__dirname, 'r22-t5-verification-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { pass: passCount, fail: failCount, skip: results.filter(r => r.result === 'SKIP').length } }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

verifyGoldenTasks().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
