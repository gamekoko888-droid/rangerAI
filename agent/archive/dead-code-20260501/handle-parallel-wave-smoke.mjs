/**
 * handle-parallel-wave-smoke.mjs — handleParallelWave Integration Smoke Test
 *
 * 测试 handleParallelWave() 的三种路径：
 *   1. should=false → 直接返回 enrichedMessage（不触发任何并行逻辑）
 *   2. should=true, 无 spawnSubAgent/superviseTask → 注入 directive 文本
 *   3. should=true, 有 spawnSubAgent/superviseTask → 走真实委托路径
 *
 * 所有依赖（sendEvent, superviseTask, spawnSubAgent）使用 mock，不调用外部服务。
 */

import { handleParallelWave } from '../worker/sub-agent-orchestrator.mjs';

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

function assertContains(text, substring, label) {
  if (text && text.includes(substring)) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — text does not contain "${substring}"`);
  }
}

// ─── Mock Data & Helpers ────────────────────────────────────────────────

const MSG_ID = 'msg-smoke-001';
const SESSION_KEY = 'session-smoke-001';

// Mock sendEvent: 记录调用但不执行实际 IPC
function createEventRecorder() {
  const calls = [];
  return {
    fn: (msgId, event) => { calls.push({ msgId, event }); },
    calls,
    reset: () => { calls.length = 0; },
  };
}

// Mock progressMarkStepDone: 记录调用
function createProgressRecorder() {
  const calls = [];
  return {
    fn: (sessionKey, stepId) => { calls.push({ sessionKey, stepId }); },
    calls,
    reset: () => { calls.length = 0; },
  };
}

const noop = () => {};

// 典型多步 wave 数据
const WAVE_STEPS = [
  { id: 'step-a', title: '编写模块 A', description: '实现认证中间件' },
  { id: 'step-b', title: '编写模块 B', description: '实现数据库层' },
  { id: 'step-c', title: '编写模块 C', description: '实现 API 路由' },
];

// ─── Tests ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  handleParallelWave Integration Smoke Test');
  console.log('═══════════════════════════════════════════════\n');

  // ═══════════════════════════════════════════════════════════════════════
  // Test 1: should=false → 直接返回 enrichedMessage，不触发任何并行逻辑
  // ═══════════════════════════════════════════════════════════════════════
  console.log('【Test 1】should=false → 直接返回 enrichedMessage');
  const recorder1 = createEventRecorder();
  {
    const _parallel = {
      should: false,
      waveIndex: -1,
      waveSteps: [],
      reason: 'single step — nothing to parallelize',
    };
    const result = await handleParallelWave(MSG_ID, SESSION_KEY, _parallel, {
      sendEvent: recorder1.fn,
      userMessage: '测试任务',
      enrichedMessage: 'ENRICHED_CONTENT',
    });

    assertEq(result.enrichedMessage, 'ENRICHED_CONTENT', 'enrichedMessage 原样返回');
    assertEq(result.completed, 0, 'completed=0');
    assertEq(result.failed, 0, 'failed=0');
    assertEq(result.skipped, 0, 'skipped=0');
    assertEq(result.waveId, -1, 'waveId=-1');
    assertEq(result.durationMs, 0, 'durationMs=0');
    assertEq(recorder1.calls.length, 0, '未发送任何事件');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Test 2: should=true 但 spawnSubAgent/superviseTask 缺失 → 注入 directive
  // ═══════════════════════════════════════════════════════════════════════
  console.log('【Test 2】should=true 无 spawnSubAgent/superviseTask → 注入 directive');
  const recorder2 = createEventRecorder();
  {
    const _parallel = {
      should: true,
      waveIndex: 0,
      waveSteps: WAVE_STEPS,
      reason: '3 independent write steps detected',
    };
    const result = await handleParallelWave(MSG_ID, SESSION_KEY, _parallel, {
      sendEvent: recorder2.fn,
      userMessage: '实现三个独立模块',
      enrichedMessage: 'TASK_START',
      // 故意不传 spawnSubAgent 和 superviseTask
    });

    // 验证 events 已发送
    assertEq(recorder2.calls.length, 1, '发送了 1 个 parallel_wave_detected 事件');
    assertEq(recorder2.calls[0].event.type, 'parallel_wave_detected', '事件类型为 parallel_wave_detected');
    assertEq(recorder2.calls[0].event.waveIndex, 0, 'waveIndex=0');
    assertEq(recorder2.calls[0].event.stepCount, 3, 'stepCount=3');

    // 验证 directive 注入
    assertContains(result.enrichedMessage, 'TASK_START', '保留原始 enrichedMessage');
    assertContains(result.enrichedMessage, '[PARALLEL_SUBAGENT_DIRECTIVE]', '注入 directive 标签');
    assertContains(result.enrichedMessage, '[/PARALLEL_SUBAGENT_DIRECTIVE]', '注入 directive 结束标签');
    assertContains(result.enrichedMessage, '编写模块 A', '包含步骤 A');
    assertContains(result.enrichedMessage, '编写模块 B', '包含步骤 B');
    assertContains(result.enrichedMessage, '编写模块 C', '包含步骤 C');
    assertContains(result.enrichedMessage, 'independent', '包含原因说明');

    assertEq(result.completed, 0, 'completed=0（未实际执行）');
    assertEq(result.failed, 0, 'failed=0');
    assertEq(result.skipped, WAVE_STEPS.length, `skipped=${WAVE_STEPS.length}（标记为跳过）`);
    assertEq(result.waveId, -1, 'waveId=-1（未委派）');
    assertEq(result.durationMs, 0, 'durationMs=0');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Test 3: should=true 有 spawnSubAgent/superviseTask → 走真实委托路径
  // ═══════════════════════════════════════════════════════════════════════
  console.log('【Test 3】should=true 有 spawnSubAgent/superviseTask → 完整委托');
  const recorder3 = createEventRecorder();
  const progressRecorder3 = createProgressRecorder();
  {
    const _parallel = {
      should: true,
      waveIndex: 1,
      waveSteps: WAVE_STEPS,
      reason: '3 independent steps detected in wave 1',
    };

    // Mock spawnSubAgent: 每个子任务正常返回
    const mockSpawnSubAgent = async (index, step, taskId, prompt) => ({
      stepId: step.id,
      success: true,
      result: `Done: ${step.title}`,
    });

    // Mock superviseTask: 返回符合格式的监督结果
    const mockSuperviseTask = async (taskId, sessionKey, plan, opts) => ({
      taskId,
      waveId: 1,
      results: [
        { stepId: 'step-a', success: true, result: 'Module A built' },
        { stepId: 'step-b', success: true, result: 'Module B built' },
        { stepId: 'step-c', success: true, result: 'Module C built' },
      ],
      merged: {
        report: '3/3 成功: Module A, B, C 全部构建完成',
        completedSteps: [
          { stepId: 'step-a', title: '模块A' },
          { stepId: 'step-b', title: '模块B' },
          { stepId: 'step-c', title: '模块C' },
        ],
        failedSteps: [],
        summary: 'All 3 steps completed successfully',
      },
      completed: 3,
      failed: 0,
      skipped: 0,
      durationMs: 247,
    });

    const result = await handleParallelWave(MSG_ID, SESSION_KEY, _parallel, {
      sendEvent: recorder3.fn,
      spawnSubAgent: mockSpawnSubAgent,
      superviseTask: mockSuperviseTask,
      userMessage: '实现三个独立模块',
      enrichedMessage: 'ORIGINAL_ENRICHED',
      progressMarkStepDone: progressRecorder3.fn,
    });

    // 验证 events
    assertEq(recorder3.calls.length, 2, '发送了 2 个事件（detected + completed）');
    assertEq(recorder3.calls[0].event.type, 'parallel_wave_detected', '第1个: parallel_wave_detected');
    assertEq(recorder3.calls[1].event.type, 'parallel_wave_completed', '第2个: parallel_wave_completed');
    assertEq(recorder3.calls[1].event.completed, 3, 'completed 事件: 3 完成');
    assertEq(recorder3.calls[1].event.failed, 0, 'completed 事件: 0 失败');

    // 验证结果
    assertContains(result.enrichedMessage, 'ORIGINAL_ENRICHED', '保留原始 enrichedMessage');
    assertContains(result.enrichedMessage, '[PARALLEL_SUBAGENT_RESULTS]', '包含结果标签');
    assertContains(result.enrichedMessage, '[/PARALLEL_SUBAGENT_RESULTS]', '包含结果结束标签');
    assertContains(result.enrichedMessage, '3/3 成功', '包含合并报告内容');

    assertEq(result.completed, 3, 'completed=3');
    assertEq(result.failed, 0, 'failed=0');
    assertEq(result.skipped, 0, 'skipped=0');
    assertEq(result.waveId, 1, 'waveId=1');
    assertEq(result.durationMs, 247, 'durationMs=247');

    // 验证 progressMarkStepDone 被正确调用
    assertEq(progressRecorder3.calls.length, 3, 'progressMarkStepDone 被调用 3 次');
    assertEq(progressRecorder3.calls[0].stepId, 'step-a', '第1次: step-a');
    assertEq(progressRecorder3.calls[1].stepId, 'step-b', '第2次: step-b');
    assertEq(progressRecorder3.calls[2].stepId, 'step-c', '第3次: step-c');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Test 4: should=true 有 superviseTask 但无 merged/completed → 跳过路径
  // ═══════════════════════════════════════════════════════════════════════
  console.log('【Test 4】superviseTask 返回 skipped>0 → 记录跳过');
  const recorder4 = createEventRecorder();
  {
    const _parallel = {
      should: true,
      waveIndex: 2,
      waveSteps: [WAVE_STEPS[0]],
      reason: 'test skip path',
    };

    const mockSpawnSubAgent = async () => ({ stepId: 'x', success: true, result: 'ok' });
    const mockSuperviseTask = async () => ({
      taskId: MSG_ID,
      waveId: 2,
      results: [],
      merged: null,   // 无 merged → 不会走成功路径
      completed: 0,
      failed: 0,
      skipped: 1,    // 走了 else-if 路径
      durationMs: 10,
    });

    const result = await handleParallelWave(MSG_ID, SESSION_KEY, _parallel, {
      sendEvent: recorder4.fn,
      spawnSubAgent: mockSpawnSubAgent,
      superviseTask: mockSuperviseTask,
      enrichedMessage: 'PREFIX',
    });

    assertEq(result.completed, 0, 'completed=0');
    assertEq(result.failed, 0, 'failed=0');
    assertEq(result.skipped, 1, 'skipped=1（superviseTask 返回跳过）');
    assertEq(result.enrichedMessage, 'PREFIX', 'enrichedMessage 不变（无合并结果）');
    // detected 事件已发送，但 no completed 事件
    assertEq(recorder4.calls.length, 1, '只发送 detected 事件');
    assertEq(recorder4.calls[0].event.type, 'parallel_wave_detected', '事件: detected');
  }

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
