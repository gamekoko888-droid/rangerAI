/**
 * sub-agent-orchestrator-smoke.mjs — Phase A Smoke Test
 *
 * 验证 sub-agent-orchestrator.mjs 所有导出函数的正确性：
 *   - 单步 wave 返回 should=false
 *   - 多步 wave 返回 should=true
 *   - 三个子任务并发执行，失败项被记录
 *   - collectAndMerge 输出 completedSteps/failedSteps
 *   - 统计函数 getOrchestratorStats / resetOrchestratorStatsForTest
 *
 * 使用 mock getParallelBatches 和 mock spawnSubAgent，不调用真实外部服务。
 */

import {
  DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG,
  shouldParallelize,
  buildSubAgentPrompt,
  orchestrateWave,
  collectAndMerge,
  getOrchestratorStats,
  resetOrchestratorStatsForTest,
} from '../worker/sub-agent-orchestrator.mjs';

// ─── Test Utilities ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label} (${JSON.stringify(expected)})`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertGte(actual, expected, label) {
  if (actual >= expected) {
    passed++;
    console.log(`  ✓ ${label} (${actual} >= ${expected})`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — expected >= ${expected}, got ${actual}`);
  }
}

// ─── Mock Data ───────────────────────────────────────────────────────────

const TASK_ID = 'task-smoke-001';

// Mock getParallelBatches: 模拟 planner 行为
function mockGetParallelBatches_singleStep(taskId) {
  return [[
    { id: 'step-1', title: '分析需求', status: 'pending' },
  ]];
}

function mockGetParallelBatches_multiStep(taskId) {
  return [
    [{ id: 'step-1', title: '环境检查', status: 'pending' }],
    [
      { id: 'step-2', title: '写入A模块', status: 'pending', dependsOn: ['step-1'] },
      { id: 'step-3', title: '写入B模块', status: 'pending', dependsOn: ['step-1'] },
      { id: 'step-4', title: '写入C模块', status: 'pending', dependsOn: ['step-1'] },
    ],
    [{ id: 'step-5', title: '集成测试', status: 'pending', dependsOn: ['step-2', 'step-3', 'step-4'] }],
  ];
}

function mockGetParallelBatches_empty(taskId) {
  return [];
}

function mockGetParallelBatches_null(taskId) {
  return null;
}

// Mock spawnSubAgent: 模拟子 Agent 执行
function mockSpawnAllSuccess(index, step, taskId, prompt) {
  return Promise.resolve({
    stepId: step.id,
    success: true,
    result: `[子 Agent 执行报告]\n完成状态：成功\n产物：/${step.id}-output.js\n未完成：无`,
  });
}

function mockSpawnWithFailure(index, step, taskId, prompt) {
  // stepp-3 失败
  if (step.id === 'step-3') {
    return Promise.resolve({
      stepId: step.id,
      success: false,
      result: '',
      error: '模拟工具调用失败: 文件写入权限不足',
    });
  }
  return Promise.resolve({
    stepId: step.id,
    success: true,
    result: `[子 Agent 执行报告]\n完成状态：成功\n产物：/${step.id}-output.js\n未完成：无`,
  });
}

function mockSpawnWithTimeout(index, step, taskId, prompt) {
  // step-2 模拟超时（返回慢）
  if (step.id === 'step-2') {
    return new Promise((resolve) => {
      setTimeout(() => resolve({
        stepId: step.id,
        success: false,
        result: '',
        error: '模拟超时',
      }), 200); // 配置 timeoutMs 为 50 以触发超时
    });
  }
  return Promise.resolve({
    stepId: step.id,
    success: true,
    result: `[子 Agent 执行报告]\n完成状态：成功\n产物：/${step.id}-output.js\n未完成：无`,
  });
}

function mockSpawnMixedResults(index, step, taskId, prompt) {
  if (step.id === 'step-3') {
    return Promise.reject(new Error('子 Agent 崩溃'));
  }
  return Promise.resolve({
    stepId: step.id,
    success: true,
    result: `OK: ${step.title}`,
  });
}

// ─── R79 P1-2 recovery metadata mocks ─────────────────────────────
function mockSpawnWithAuthError(index, step, taskId, prompt) {
  return Promise.resolve({
    stepId: step.id,
    success: false,
    result: '',
    error: '401 Unauthorized: invalid API token',
  });
}

function mockSpawnWithContentBlocked(index, step, taskId, prompt) {
  return Promise.resolve({
    stepId: step.id,
    success: false,
    result: '',
    error: 'Content blocked by Cloudflare: access denied',
  });
}

function mockSpawnWithGatewayAborted(index, step, taskId, prompt) {
  return Promise.resolve({
    stepId: step.id,
    success: false,
    result: '',
    error: 'gateway aborted the run due to state conflict',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  sub-agent-orchestrator Phase A Smoke Test');
  console.log('═══════════════════════════════════════════════\n');

  // ─── Test 1: shouldParallelize — 单步 wave ───
  console.log('【Test 1】shouldParallelize — 单步 wave 返回 should=false');
  resetOrchestratorStatsForTest();
  {
    const result = shouldParallelize(TASK_ID, {
      getParallelBatches: mockGetParallelBatches_singleStep,
    });
    assert(result.should === false, 'should=false 对于单步 wave');
    assert(result.reason.length > 0, '提供原因说明');
    assert(result.waveIndex === -1, 'waveIndex=-1 表示无并行 wave');
    assertEq(result.waveSteps.length, 0, 'waveSteps 为空');
  }

  // ─── Test 2: shouldParallelize — 多步 wave ───
  console.log('【Test 2】shouldParallelize — 多步 wave 返回 should=true');
  resetOrchestratorStatsForTest();
  {
    const result = shouldParallelize(TASK_ID, {
      getParallelBatches: mockGetParallelBatches_multiStep,
    });
    assert(result.should === true, 'should=true 对于多步 wave');
    assert(result.waveIndex === 1, '识别出正确的 wave 索引 (wave[1] 有 3 步)');
    assertGte(result.waveSteps.length, 2, 'waveSteps 包含至少 2 个步骤');
    assert(result.reason.includes('3'), '说明中包含步骤数量');
  }

  // ─── Test 3: shouldParallelize — 空计划 ───
  console.log('【Test 3】shouldParallelize — 空计划返回 should=false');
  resetOrchestratorStatsForTest();
  {
    let result = shouldParallelize(TASK_ID, {
      getParallelBatches: mockGetParallelBatches_empty,
    });
    assert(result.should === false, 'should=false 对于空计划');

    result = shouldParallelize(TASK_ID, {
      getParallelBatches: mockGetParallelBatches_null,
    });
    assert(result.should === false, 'should=false 对于 null 返回');
  }

  // ─── Test 4: shouldParallelize — 未注入 getParallelBatches ───
  console.log('【Test 4】shouldParallelize — 未注入 getParallelBatches 返回 should=false');
  {
    const result = shouldParallelize(TASK_ID, {});
    assert(result.should === false, 'should=false 当未注入 getParallelBatches');
    assert(result.reason.includes('未注入'), '原因说明注入缺失');
  }

  // ─── Test 5: shouldParallelize — enabled=false ───
  console.log('【Test 5】shouldParallelize — enabled=false 返回 should=false');
  {
    const result = shouldParallelize(TASK_ID, {
      getParallelBatches: mockGetParallelBatches_multiStep,
      config: { enabled: false },
    });
    assert(result.should === false, 'should=false 当 enabled=false');
    assert(result.reason.includes('禁用'), '原因说明已禁用');
  }

  // ─── Test 6: buildSubAgentPrompt ───
  console.log('【Test 6】buildSubAgentPrompt — 生成正确的 prompt');
  {
    const step = {
      id: 'step-99',
      title: '编写核心模块',
      description: '实现 authentication 中间件',
      tools: ['read', 'write', 'exec'],
    };
    const context = {
      taskSummary: '构建 RangerAI v2 后台',
      previousResults: ['环境初始化完成', '依赖安装完成'],
    };
    const prompt = buildSubAgentPrompt(step, context);
    assert(typeof prompt === 'string', '返回字符串');
    assert(prompt.includes('step-99'), '包含步骤 ID');
    assert(prompt.includes('编写核心模块'), '包含步骤标题');
    assert(prompt.includes('authentication 中间件'), '包含步骤描述');
    assert(prompt.includes('read, write, exec'), '包含工具列表');
    assert(prompt.includes('RangerAI v2'), '包含任务摘要');
    assert(prompt.includes('环境初始化完成'), '包含前序结果');
  }

  // ─── Test 7: buildSubAgentPrompt — 最小输入 ───
  console.log('【Test 7】buildSubAgentPrompt — 最小输入不崩溃');
  {
    const prompt = buildSubAgentPrompt({ id: 'step-min' });
    assert(typeof prompt === 'string', '最小输入返回字符串');
    assert(prompt.includes('step-min'), '最小输入包含步骤 ID');
  }

  // ─── Test 8: orchestrateWave — 三个子任务全部成功 ───
  console.log('【Test 8】orchestrateWave — 三个子任务并发执行全部成功');
  resetOrchestratorStatsForTest();
  {
    const waveSteps = [
      { id: 'step-2', title: '写入A模块', status: 'pending' },
      { id: 'step-3', title: '写入B模块', status: 'pending' },
      { id: 'step-4', title: '写入C模块', status: 'pending' },
    ];
    const result = await orchestrateWave(TASK_ID, waveSteps, {
      spawnSubAgent: mockSpawnAllSuccess,
    });
    assertEq(result.taskId, TASK_ID, 'taskId 正确');
    assertEq(result.results.length, 3, '返回 3 个结果');
    assert(result.results.every(r => r.success), '全部成功');
    assertGte(result.durationMs, 0, 'durationMs 非负');

    const stats = getOrchestratorStats();
    assertEq(stats.totalWaves, 1, '统计: totalWaves=1');
    assertEq(stats.totalCompleted, 3, '统计: totalCompleted=3');
    assertEq(stats.totalFailed, 0, '统计: totalFailed=0');
  }

  // ─── Test 9: orchestrateWave — 一个子任务失败 ───
  console.log('【Test 9】orchestrateWave — 一个子任务失败，失败项被记录');
  resetOrchestratorStatsForTest();
  {
    const waveSteps = [
      { id: 'step-2', title: '写入A模块', status: 'pending' },
      { id: 'step-3', title: '写入B模块', status: 'pending' },
      { id: 'step-4', title: '写入C模块', status: 'pending' },
    ];
    const result = await orchestrateWave(TASK_ID, waveSteps, {
      spawnSubAgent: mockSpawnWithFailure,
    });
    assertEq(result.results.length, 3, '返回 3 个结果');
    const successResults = result.results.filter(r => r.success);
    const failedResults = result.results.filter(r => !r.success);
    assertEq(successResults.length, 2, '2 个成功');
    assertEq(failedResults.length, 1, '1 个失败');
    assert(failedResults[0].error.includes('权限不足'), '失败项包含错误信息');
    assert(failedResults[0]._fallbackToSerial === true, '失败项标记降级串行');

    const stats = getOrchestratorStats();
    assertEq(stats.totalWaves, 1, '统计: totalWaves=1');
    assertEq(stats.totalCompleted, 2, '统计: totalCompleted=2');
    assertEq(stats.totalFailed, 1, '统计: totalFailed=1');
  }

  // ─── Test 10: orchestrateWave — 超时处理 ───
  console.log('【Test 10】orchestrateWave — 超时子 Agent 被记录');
  resetOrchestratorStatsForTest();
  {
    const waveSteps = [
      { id: 'step-2', title: '慢任务', status: 'pending' },
      { id: 'step-4', title: '快任务', status: 'pending' },
    ];
    const result = await orchestrateWave(TASK_ID, waveSteps, {
      spawnSubAgent: mockSpawnWithTimeout,
      config: { timeoutMs: 50 }, // 强制超时
    });
    assertEq(result.results.length, 2, '返回 2 个结果');
    const timedOut = result.results.filter(r => r.timedOut);
    assertEq(timedOut.length, 1, '1 个超时');
    assert(timedOut[0].error.includes('超时'), '超时项包含超时错误');
  }

  // ─── Test 11: orchestrateWave — Promise rejection 被捕获 ───
  console.log('【Test 11】orchestrateWave — spawnSubAgent rejection 被正常捕获');
  resetOrchestratorStatsForTest();
  {
    const waveSteps = [
      { id: 'step-3', title: '崩溃任务', status: 'pending' },
      { id: 'step-4', title: '正常任务', status: 'pending' },
    ];
    const result = await orchestrateWave(TASK_ID, waveSteps, {
      spawnSubAgent: mockSpawnMixedResults,
    });
    assertEq(result.results.length, 2, '返回 2 个结果');
    assert(result.results[0].success === false, 'rejection 被捕获为失败');
    assert(result.results[0].error.includes('崩溃'), '包含错误信息');
    assert(result.results[1].success === true, '其他子 Agent 不受影响');
  }

  // ─── Test 12: collectAndMerge — 全部成功 ───
  console.log('【Test 12】collectAndMerge — 全部成功输出结构化报告');
  {
    const results = [
      { stepId: 'step-2', success: true, result: '完成: /app/moduleA.js' },
      { stepId: 'step-3', success: true, result: '完成: /app/moduleB.mjs' },
    ];
    const merged = await collectAndMerge(TASK_ID, 0, results);
    assert(merged.summary.includes('2/2 成功'), 'summary 显示全部成功');
    assertEq(merged.completedSteps.length, 2, 'completedSteps 包含 2 项');
    assertEq(merged.failedSteps.length, 0, 'failedSteps 为空');
    assert(merged.report.includes('moduleA.js'), '报告包含产物信息');
    assert(merged.report.includes('moduleB.mjs'), '报告包含产物信息');
    assertGte(merged.artifacts.length, 2, 'artifacts 至少包含 2 个产物');
    assert(merged._mergedAt, '包含时间戳');
  }

  // ─── Test 13: collectAndMerge — 部分失败 ───
  console.log('【Test 13】collectAndMerge — 部分失败输出 completedSteps/failedSteps');
  {
    const results = [
      { stepId: 'step-2', success: true, result: '完成: /app/A.js' },
      { stepId: 'step-3', success: false, error: '磁盘空间不足', timedOut: false, _fallbackToSerial: true },
      { stepId: 'step-4', success: true, result: '完成: /app/C.json' },
    ];
    const merged = await collectAndMerge(TASK_ID, 1, results);
    assertEq(merged.completedSteps.length, 2, 'completedSteps 包含 2 项');
    assertEq(merged.failedSteps.length, 1, 'failedSteps 包含 1 项');
    assert(merged.summary.includes('2/3 成功'), 'summary 显示 2/3 成功');
    assert(merged.failedSteps[0].stepId === 'step-3', '失败项 ID 正确');
    assert(merged.failedSteps[0].fallbackToSerial === true, '失败项标记降级串行');
    assert(merged.report.includes('磁盘空间不足'), '报告包含失败详情');
  }

  // ─── Test 14: collectAndMerge — 空结果 ───
  console.log('【Test 14】collectAndMerge — 空结果不崩溃');
  {
    const merged = await collectAndMerge(TASK_ID, 0, []);
    assert(merged.summary.includes('空 wave'), '空结果 summary');
    assertEq(merged.completedSteps.length, 0, 'completedSteps 为空');
    assertEq(merged.failedSteps.length, 0, 'failedSteps 为空');
  }

  // ─── Test 15: DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG ───
  console.log('【Test 15】DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG — 默认配置完整');
  {
    const c = DEFAULT_SUB_AGENT_ORCHESTRATOR_CONFIG;
    assert(typeof c.enabled === 'boolean', 'enabled 是 boolean');
    assertGte(c.maxConcurrent, 1, 'maxConcurrent >= 1');
    assertGte(c.timeoutMs, 1000, 'timeoutMs >= 1000');
    assertGte(c.minStepsForParallel, 2, 'minStepsForParallel >= 2');
    assert(typeof c.fallbackToSerial === 'boolean', 'fallbackToSerial 是 boolean');
  }

  // ─── Test 16: resetOrchestratorStatsForTest ───
  console.log('【Test 16】resetOrchestratorStatsForTest — 重置统计');
  resetOrchestratorStatsForTest();
  // Execute a wave to set some stats
  await orchestrateWave(TASK_ID, [
    { id: 's1', title: 'T1', status: 'pending' },
  ], { spawnSubAgent: mockSpawnAllSuccess });
  let stats = getOrchestratorStats();
  assertEq(stats.totalWaves, 1, '使用后 totalWaves=1');

  resetOrchestratorStatsForTest();
  stats = getOrchestratorStats();
  assertEq(stats.totalWaves, 0, '重置后 totalWaves=0');
  assertEq(stats.totalSubAgents, 0, '重置后 totalSubAgents=0');
  assertEq(stats.averageWaveDurationMs, 0, '重置后 averageWaveDurationMs=0');

  // ─── Test 17: P1-2 recovery metadata on non-retry failures (R79) ───
  console.log('【Test 17】P1-2 recovery metadata — 非重试失败回调恢复策略执行');
  resetOrchestratorStatsForTest();
  {
    const resAuth = await orchestrateWave(TASK_ID, [
      { id: 'auth-1', title: 'Auth step', status: 'pending' },
    ], { spawnSubAgent: mockSpawnWithAuthError });
    assertEq(resAuth.results.length, 1, 'auth: 1 个结果');
    const authR = resAuth.results[0];
    assertEq(authR.success, false, 'auth: 步骤标记为失败');
    assertEq(authR._failureType, 'api_auth_error', 'auth: 分类为 api_auth_error');
    assertEq(authR._recoveryAction, 'ask_human', 'auth: 建议 ask_human');
    assertEq(authR._severity, 'critical', 'auth: 严重度 critical');
    assertEq(authR._needsHuman, true, 'auth: 标记 needsHuman');
    assertEq(authR._retried, false, 'auth: 未重试（不可重试错误）');
  }
  {
    const resBlocked = await orchestrateWave(TASK_ID, [
      { id: 'blk-1', title: 'Blocked step', status: 'pending', tools: ['browser'] },
    ], { spawnSubAgent: mockSpawnWithContentBlocked });
    assertEq(resBlocked.results.length, 1, 'blocked: 1 个结果');
    const blkR = resBlocked.results[0];
    assertEq(blkR.success, false, 'blocked: 步骤标记为失败');
    assertEq(blkR._failureType, 'browser_content_blocked', 'blocked: 分类为 browser_content_blocked');
    assertEq(blkR._recoveryAction, 'skip_step', 'blocked: 建议 skip_step');
    assertEq(blkR._shouldSkip, true, 'blocked: 标记 shouldSkip');
    assertEq(blkR._retried, false, 'blocked: 未重试（跳过类错误）');
  }
  {
    const resAborted = await orchestrateWave(TASK_ID, [
      { id: 'gw-1', title: 'Gateway step', status: 'pending' },
    ], { spawnSubAgent: mockSpawnWithGatewayAborted });
    assertEq(resAborted.results.length, 1, 'gateway: 1 个结果');
    const gwR = resAborted.results[0];
    assertEq(gwR.success, false, 'gateway: 步骤标记为失败');
    assertEq(gwR._failureType, 'gateway_aborted', 'gateway: 分类为 gateway_aborted');
    assertEq(gwR._recoveryAction, 'retry_delayed', 'gateway: 建议 retry_delayed（第1次）');
    assertEq(gwR._severity, 'medium', 'gateway: 严重度 medium');
    assertEq(gwR._retried, true, 'gateway: 已尝试重试');
    assertEq(gwR._recovered, false, 'gateway: 重试未恢复（mock 仍返回错误）');
  }
  console.log('  ✓ 3 种非重试/条件重试失败恢复元数据全部正确');

  // ─── Summary ───────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  结果: ${passed} 通过, ${failed} 失败`);
  console.log('═══════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
