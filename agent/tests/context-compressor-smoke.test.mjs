/**
 * context-compressor-smoke.test.mjs — Iter-C 压缩管线集成烟雾测试
 * 
 * 覆盖: microCompact 完整行为（截断/豁免/保底） + getCompressionStats
 * 不覆盖: autoCompact（需真实 LLM 调用，留待 L3 运行时验证）
 * 
 * 注意: microCompact 保留最近 N 轮（10条消息），只裁剪 older 部分
 *       因此测试需确保工具输出落在 olderMessages 分区
 */

import { microCompact, getCompressionStats } from '../worker/context-compressor.mjs';

// ─── Helpers ──────────────────────────────────────────

function totalChars(msgs) {
  return msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}

function longToolOutput(toolName, chars = 5000) {
  return {
    role: 'tool',
    toolName,
    content: 'A'.repeat(chars),
  };
}

/**
 * Build messages with tool outputs in the OLDER part.
 * microCompact keeps last 10 messages untouched,
 * so tool messages must appear before position (total - 10).
 */
function buildWithOldTools(opts = {}) {
  const { toolMsgs = [], normalRounds = 12 } = opts;
  const msgs = [];
  // Put tool messages FIRST (oldest)
  for (const tm of toolMsgs) {
    msgs.push(tm);
  }
  // Then normal rounds (newer)
  for (let i = 0; i < normalRounds; i++) {
    msgs.push({ role: 'user', content: `User message ${i.toString().padStart(4, '0')}` });
    msgs.push({ role: 'assistant', content: `Assistant response ${i.toString().padStart(4, '0')}` });
  }
  return msgs;
}

let passed = 0;
let failed = 0;
const startTotal = passed + failed;

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ❌ ${label}`); }
}

// ─── Test 1: 空输入不崩溃 ─────────────────────────────

console.log('[Test 1] 空输入 / null 输入');
{
  const r1 = microCompact([], 's1');
  assert(!r1.compressed, '空数组 → compressed=false');
  assert(r1.messages.length === 0, '空数组 → messages 为空');

  const r2 = microCompact(null, 's2');
  assert(!r2.compressed, 'null → compressed=false');

  const r3 = microCompact(undefined, 's3');
  assert(!r3.compressed, 'undefined → compressed=false');
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 2: 纯对话消息不触发压缩 ──────────────────────

console.log('[Test 2] 纯对话消息（无工具输出）不触发压缩');
{
  const msgs = buildWithOldTools({ toolMsgs: [], normalRounds: 30 });
  const before = totalChars(msgs);
  const result = microCompact(msgs, 's-pure');
  const after = totalChars(result.messages);

  assert(!result.compressed, '无工具输出 → compressed=false');
  assert(before === after, '字符数不变');
  assert(result.stats.truncated === 0, 'truncated=0');
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 3: 长 exec 输出被截断 ──────────────────────────

console.log('[Test 3] 长 exec 输出被截断');
{
  const longExec = longToolOutput('exec', 10000);
  const msgs = buildWithOldTools({ toolMsgs: [longExec], normalRounds: 12 });
  const before = totalChars(msgs);
  const result = microCompact(msgs, 's-exec');
  const after = totalChars(result.messages);

  assert(result.compressed, '长 exec → compressed=true');
  assert(after < before, `截断后字符数减少 (${before} → ${after})`);
  assert(result.stats.truncated === 1, 'truncated=1');
  assert(result.stats.savedChars > 0, `savedChars=${result.stats.savedChars} > 0`);
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 4: 豁免工具不被截断 ────────────────────────────

console.log('[Test 4] EXEMPT_TOOLS（file_read/read_file）不被截断');
{
  const exemptFile = longToolOutput('file_read', 10000);
  const msgs = buildWithOldTools({ toolMsgs: [exemptFile], normalRounds: 12 });
  const before = totalChars(msgs);
  const result = microCompact(msgs, 's-exempt');

  assert(!result.compressed, '豁免工具 → compressed=false');
  assert(result.stats.exempted >= 1, `exempted=${result.stats.exempted} >= 1`);
  assert(result.stats.truncated === 0, 'truncated=0');
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 5: 最近 5 轮消息不被截断 ───────────────────────

console.log('[Test 5] 最近 5 轮（10条）消息不被截断');
{
  const msgs = [];
  // 前面放长工具输出（应被截断）
  msgs.push(longToolOutput('exec', 8000));
  // 放大量正常轮次
  for (let i = 0; i < 35; i++) {
    msgs.push({ role: 'user', content: `History ${i}` });
    msgs.push({ role: 'assistant', content: `Response ${i}` });
  }
  // 最后附加一个 exec（在最近 10 条内，不应被截断）
  msgs.push(longToolOutput('exec', 8000));

  const result = microCompact(msgs, 's-recent');
  // 最后一个消息在 recentMessages 中，应保持原样
  const lastMsg = result.messages[result.messages.length - 1];
  assert(lastMsg.toolName === 'exec', '最后一条仍为 exec');
  assert(lastMsg.content.length === 8000, '最近 exec 输出未被截断');
  assert(result.stats.truncated >= 1, '前面的 exec 被截断');
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 6: 短工具输出不触发截断 ─────────────────────────

console.log('[Test 6] 短工具输出（≤2000字符）不截断');
{
  const shortExec = {
    role: 'tool',
    toolName: 'exec',
    content: 'Short output here, under 2000 chars.',
  };
  const msgs = buildWithOldTools({ toolMsgs: [shortExec], normalRounds: 12 });
  const result = microCompact(msgs, 's-short');

  assert(!result.compressed, '短 exec → compressed=false');
  assert(result.stats.truncated === 0, 'truncated=0');
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 7: 混合场景 — 截断 + 豁免 ──────────────────────

console.log('[Test 7] 混合场景 — exec/grep/web_search截断 + file_read豁免');
{
  const msgs = buildWithOldTools({
    toolMsgs: [
      longToolOutput('exec', 8000),       // 应截断
      longToolOutput('file_read', 8000),   // 应豁免
      longToolOutput('grep', 8000),        // 应截断
      longToolOutput('web_search', 6000),  // 应截断
    ],
    normalRounds: 12,
  });
  const result = microCompact(msgs, 's-mixed');

  assert(result.compressed, '混合场景 → compressed=true');
  assert(result.stats.truncated === 3, `truncated=${result.stats.truncated} === 3 (exec+grep+web_search)`);
  assert(result.stats.exempted >= 1, `exempted=${result.stats.exempted} >= 1 (file_read)`);
  assert(result.stats.savedChars > 0, `savedChars=${result.stats.savedChars} > 0`);
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Test 8: getCompressionStats 返回结构 ──────────────

console.log('[Test 8] getCompressionStats 返回结构');
{
  const stats = getCompressionStats();
  assert(typeof stats === 'object', '返回对象');
  assert(stats !== null, '非 null');
}
console.log(`  ${passed - startTotal}/${passed - startTotal + failed} 通过\n`);

// ─── Summary ──────────────────────────────────────────

const total = passed + failed;
console.log('═══════════════════════════════════════════════');
console.log(`  结果: ${passed} 通过, ${failed} 失败 (共 ${total} 断言)`);
console.log('═══════════════════════════════════════════════');

if (failed > 0) process.exit(1);
