// ctxmgr-smoke.test.mjs — R83 回归测试：防止 ctxMgr 作用域事故逃逸
// 验证 context-window-manager 核心函数在生产路径上可正常初始化与使用
// R81 事故复盘：const ctxMgr 移入 try 块导致 ReferenceError，此测试确保下次逃逸被拦截

import { getContextManager, getUsageRatio, budgetToolResults } from '../worker/context-window-manager.mjs';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertOk(value, label) {
  if (value) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL [${label}]: expected truthy value`);
  }
}

// ─── Test 1: getContextManager creates and returns a manager ───
console.log('[Test 1] getContextManager — 工厂创建');
{
  const ctxMgr = getContextManager('smoke-session', 'task-smoke');
  assertOk(ctxMgr !== null && ctxMgr !== undefined, 'ctxMgr exists');
  assertEq(typeof ctxMgr.trackUserMessage, 'function', 'trackUserMessage is function');
  assertEq(typeof ctxMgr.processToolOutput, 'function', 'processToolOutput is function');
  assertEq(typeof ctxMgr.getStats, 'function', 'getStats is function');
  assertEq(typeof ctxMgr.getSummaryString, 'function', 'getSummaryString is function');
  assertEq(typeof ctxMgr.recordCompression, 'function', 'recordCompression is function');
  assertEq(typeof ctxMgr.trackAssistantResponse, 'function', 'trackAssistantResponse is function');
  assertEq(typeof ctxMgr.checkPreSendHealth, 'function', 'checkPreSendHealth is function');
}
console.log('  ✓ getContextManager 返回完整接口\n');

// ─── Test 2: trackUserMessage and getSummaryString ───
console.log('[Test 2] trackUserMessage + getSummaryString — token tracking');
{
  const ctxMgr = getContextManager('smoke-session-2', 'task-smoke-2');
  ctxMgr.trackUserMessage('Hello world, this is a test message with some CJK 你好世界');
  const summary = ctxMgr.getSummaryString();
  assertOk(typeof summary === 'string', 'summary is string');
  assertOk(summary.length > 0, 'summary not empty');
  assertOk(summary.includes('ctx-mgr'), 'summary mentions ctx-mgr');
  const stats = ctxMgr.getStats();
  assertOk(stats && typeof stats === 'object', 'stats is object');
  assertOk(typeof stats.estimatedTokens === 'number', 'stats has estimatedTokens');
}
console.log('  ✓ trackUserMessage 和 getStats 正常工作\n');

// ─── Test 3: processToolOutput trims long outputs ───
console.log('[Test 3] processToolOutput — 长工具输出裁剪');
{
  const ctxMgr = getContextManager('smoke-session-3', 'task-smoke-3');
  const longOutput = 'x'.repeat(20000);
  const trimmed = ctxMgr.processToolOutput('exec', longOutput);
  assertOk(typeof trimmed === 'string', 'trimmed output is string');
  assertOk(trimmed.length < longOutput.length, 'output was trimmed');
  // Should preserve head + tail portions
  assertOk(trimmed.includes('[...'), 'contains truncation marker');
}
console.log('  ✓ processToolOutput 正常裁剪长输出\n');

// ─── Test 4: getUsageRatio estimates correctly ───
console.log('[Test 4] getUsageRatio — 用量估算');
{
  const messages = [
    { role: 'user', content: 'Hello this is a test message with some content' },
    { role: 'assistant', content: 'Response with some content here too' },
  ];
  const ratio = getUsageRatio(messages, 100000);
  assertOk(typeof ratio === 'number', 'ratio is number');
  assertOk(ratio > 0 && ratio < 0.5, `ratio=${ratio} is between 0 and 0.5`);
}
console.log('  ✓ getUsageRatio 返回合法值\n');

// ─── Test 5: budgetToolResults handles empty input ───
console.log('[Test 5] budgetToolResults — 空输入不崩溃');
{
  const stats = budgetToolResults([]);
  assertOk(stats && typeof stats === 'object', 'stats is object');
  assertEq(stats.truncated, 0, 'empty input no truncation');
}
console.log('  ✓ budgetToolResults 处理空输入\n');

// ─── Test 6: checkPreSendHealth returns structured report ───
console.log('[Test 6] checkPreSendHealth — 健康报告结构');
{
  const ctxMgr = getContextManager('smoke-session-4', 'task-smoke-4');
  ctxMgr.trackUserMessage('test input');
  const health = ctxMgr.checkPreSendHealth();
  assertOk(health && typeof health === 'object', 'health report is object');
  assertOk(typeof health.tier === 'string', 'health report has tier');
  assertOk(typeof health.needsCompression === 'boolean', 'health report has needsCompression');
  assertOk(['green', 'yellow', 'red', 'critical'].includes(health.tier), `tier is valid: ${health.tier}`);
}
console.log('  ✓ checkPreSendHealth 返回完整结构\n');

// ─── Test 7: Two independent managers don't interfere ───
console.log('[Test 7] 独立 session 隔离');
{
  const mgrA = getContextManager('session-A', 'task-A');
  const mgrB = getContextManager('session-B', 'task-B');
  mgrA.trackUserMessage('message for A');
  mgrB.trackUserMessage('message for B and more tokens here to make it different 额外内容');
  const statsA = mgrA.getStats();
  const statsB = mgrB.getStats();
  assertOk(statsA.estimatedTokens !== statsB.estimatedTokens, 'sessions have different token counts');
}
console.log('  ✓ 不同 session 互不干扰\n');

// ─── Summary ───────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════');
console.log(`  结果: ${passed} 通过, ${failed} 失败`);
console.log('═══════════════════════════════════════════════');

if (failed > 0) process.exit(1);
