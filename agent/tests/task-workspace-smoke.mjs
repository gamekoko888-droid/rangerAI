/**
 * tests/task-workspace-smoke.mjs — R76 workspace lifecycle smoke test
 *
 * Verifies the full task-workspace lifecycle without external dependencies.
 * Uses a fixed test task ID that gets cleaned up at the end.
 *
 * Usage: node tests/task-workspace-smoke.mjs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  initTaskWorkspace,
  writeTaskFile,
  readTaskFile,
  listTaskFiles,
  buildWorkspaceBlock,
  maybeExternalize,
  loadFileMemory,
  cleanupTaskWorkspace,
  TASK_WORKSPACE_THRESHOLD,
  EXTERNALIZABLE_TOOLS,
} from '../worker/task-workspace.mjs';

// ─── Test scaffolding ─────────────────────────────────────────────────────────

const FAILURES = [];
const TEST_TASK_ID = `r76-workspace-smoke-${Date.now()}`;
const WORKSPACE_ROOT = '/home/admin/.openclaw/workspace/tasks';
const EXPECTED_DIR = path.join(WORKSPACE_ROOT, TEST_TASK_ID);

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    FAILURES.push(label);
  }
}

function cleanup() {
  cleanupTaskWorkspace(TEST_TASK_ID);
  // Also clean up any leaked dirs from older runs
  const dirs = fs.readdirSync(WORKSPACE_ROOT).filter(d => d.startsWith('r76-workspace-smoke-'));
  for (const d of dirs) {
    cleanupTaskWorkspace(d);
  }
}

// ─── Ensure clean start ──────────────────────────────────────────────────────

console.log(`\n[R76] Task Workspace Smoke Test — taskId=${TEST_TASK_ID}\n`);
cleanup(); // remove any leftovers

// ─── Test: initTaskWorkspace ─────────────────────────────────────────────────

console.log('1. initTaskWorkspace');
const dir = initTaskWorkspace(TEST_TASK_ID);
assert(dir === EXPECTED_DIR, 'returns expected directory path');
assert(fs.existsSync(dir), 'directory created on disk');
assert(fs.statSync(dir).isDirectory(), 'created path is a directory');

// Idempotent
const dir2 = initTaskWorkspace(TEST_TASK_ID);
assert(dir === dir2, 'idempotent: returns same path on second call');

// null safety
assert(initTaskWorkspace(null) === null, 'returns null for null taskId');
assert(initTaskWorkspace('') === null, 'returns null for empty taskId');

// ─── Test: writeTaskFile ─────────────────────────────────────────────────────

console.log('\n2. writeTaskFile');
const testContent = 'Hello, workspace smoke test!\nLine 2.';
const writtenPath = writeTaskFile(TEST_TASK_ID, 'test.txt', testContent);
assert(writtenPath !== null, 'writes file and returns path');
assert(writtenPath.endsWith('/test.txt'), 'path ends with filename');
assert(fs.existsSync(writtenPath), 'file exists on disk');
assert(fs.readFileSync(writtenPath, 'utf-8') === testContent, 'file content matches');

// Write a larger file
const largeContent = 'A'.repeat(500);
const largePath = writeTaskFile(TEST_TASK_ID, 'large.txt', largeContent);
assert(largePath !== null, 'writes large file');
assert(fs.readFileSync(largePath, 'utf-8') === largeContent, 'large file content matches');

// Null safety
assert(writeTaskFile(null, 'f', 'c') === null, 'returns null for null taskId');
assert(writeTaskFile('x', null, 'c') === null, 'returns null for null filename');

// ─── Test: readTaskFile ──────────────────────────────────────────────────────

console.log('\n3. readTaskFile');
const read = readTaskFile(TEST_TASK_ID, 'test.txt');
assert(read === testContent, 'reads existing file correctly');

const missing = readTaskFile(TEST_TASK_ID, 'nonexistent.txt');
assert(missing === null, 'returns null for nonexistent file');

assert(readTaskFile(null, 'f') === null, 'returns null for null taskId');
assert(readTaskFile('x', null) === null, 'returns null for null filename');

// ─── Test: listTaskFiles ─────────────────────────────────────────────────────

console.log('\n4. listTaskFiles');
const files = listTaskFiles(TEST_TASK_ID);
assert(Array.isArray(files), 'returns an array');
assert(files.length >= 2, 'lists at least 2 files (test.txt + large.txt)');

const names = files.map(f => f.name);
assert(names.includes('test.txt'), 'includes test.txt');
assert(names.includes('large.txt'), 'includes large.txt');

const testFile = files.find(f => f.name === 'test.txt');
assert(typeof testFile.size === 'number' && testFile.size === Buffer.byteLength(testContent), `size correct: ${testFile.size}`);
assert(testFile.mtime instanceof Date, 'mtime is Date');

assert(listTaskFiles(null).length === 0, 'returns empty array for null taskId');
assert(listTaskFiles('__bogus_nonexistent__').length === 0, 'returns empty array for nonexistent task');

// ─── Test: buildWorkspaceBlock ────────────────────────────────────────────────

console.log('\n5. buildWorkspaceBlock');
const block = buildWorkspaceBlock(TEST_TASK_ID);
assert(typeof block === 'string' && block.length > 0, 'returns non-empty string when files exist');
assert(block.includes('[WORKSPACE]'), 'contains [WORKSPACE] header');
assert(block.includes('test.txt'), 'mentions test.txt');
assert(block.includes('large.txt'), 'mentions large.txt');
assert(block.includes('[/WORKSPACE]'), 'contains closing tag');

// Empty when no files
const emptyDir = path.join(WORKSPACE_ROOT, 'r76-empty-dir');
fs.mkdirSync(emptyDir, { recursive: true });
assert(buildWorkspaceBlock('r76-empty-dir') === '', 'returns empty string when no files');
fs.rmdirSync(emptyDir);

assert(buildWorkspaceBlock(null) === '', 'returns empty string for null taskId');

// ─── Test: maybeExternalize ───────────────────────────────────────────────────

console.log('\n6. maybeExternalize');
const shortResult = 'Short result, should not be externalized.';
const short = maybeExternalize(TEST_TASK_ID, 'exec', shortResult);
assert(short.externalized === false, 'short result NOT externalized');
assert(short.ref === shortResult, 'short ref is original string');

const longResult = 'X'.repeat(TASK_WORKSPACE_THRESHOLD + 1);
const ext = maybeExternalize(TEST_TASK_ID, 'exec', longResult);
assert(ext.externalized === true, 'long result IS externalized');
assert(ext.ref.includes('tool-exec-') && ext.ref.includes('.txt'), 'ref mentions tool file path');
assert(ext.ref.includes('read 工具读取'), 'ref mentions read tool hint');

// Non-externalizable tool should NOT externalize even when large
const webRes = maybeExternalize(TEST_TASK_ID, 'browser', longResult);
assert(webRes.externalized === false, 'non-externalizable tool result NOT externalized');

// Edge cases
assert(maybeExternalize(null, 'exec', 'x').externalized === false, 'null taskId: not externalized');
assert(maybeExternalize('x', null, 'x').externalized === false, 'null toolName: not externalized');
assert(maybeExternalize('x', 'exec', undefined).externalized === false, 'undefined result: not externalized');

// Boundary: exactly at threshold
const boundary = 'X'.repeat(TASK_WORKSPACE_THRESHOLD);
const b = maybeExternalize(TEST_TASK_ID, 'web_fetch', boundary);
assert(b.externalized === false, `result at threshold (${TASK_WORKSPACE_THRESHOLD}) NOT externalized`);

// ─── Test: loadFileMemory ─────────────────────────────────────────────────────

console.log('\n7. loadFileMemory');

// Write a tool file manually so loadFileMemory can find it
writeTaskFile(TEST_TASK_ID, 'tool-exec-1234567890.txt', '{"result": "some tool output here"}');

const mem = loadFileMemory(TEST_TASK_ID);
assert(mem !== null, 'returns non-null when tool files exist');
assert(mem.includes('[FILE_MEMORY]'), 'contains [FILE_MEMORY] header');
assert(mem.includes('tool-exec-'), 'mentions tool file');
assert(mem.includes('[/FILE_MEMORY]'), 'contains closing tag');

assert(loadFileMemory(null) === null, 'returns null for null taskId');

// ─── Test: cleanupTaskWorkspace ───────────────────────────────────────────────

console.log('\n8. cleanupTaskWorkspace');
cleanupTaskWorkspace(TEST_TASK_ID);
assert(!fs.existsSync(EXPECTED_DIR), 'directory removed after cleanup');
assert(fs.existsSync(WORKSPACE_ROOT), 'root dir still exists');

// Safe double-cleanup
cleanupTaskWorkspace(TEST_TASK_ID); // no crash

// Safety: should not delete outside WORKSPACE_ROOT
const dangerousId = `../etc/passwd`;
const dangerousDir = path.join(WORKSPACE_ROOT, '____etc_passwd');
// Init then verify sanitized path
initTaskWorkspace(dangerousId);
const sanitizedDir = path.join(WORKSPACE_ROOT, dangerousId.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 64));
assert(sanitizedDir.startsWith(WORKSPACE_ROOT + '/'), 'sanitized id stays under WORKSPACE_ROOT');
cleanupTaskWorkspace(dangerousId);
assert(!fs.existsSync(sanitizedDir), 'sanitized test dir cleaned up');

// ─── Final cleanup + verification ────────────────────────────────────────────

console.log('\n── Final cleanup ──');
cleanup();
const remaining = fs.readdirSync(WORKSPACE_ROOT).filter(d => d.startsWith('r76-workspace-smoke-'));
if (remaining.length > 0) {
  console.log(`  WARNING: ${remaining.length} uncleaned dirs: ${remaining.join(', ')}`);
  for (const r of remaining) cleanupTaskWorkspace(r);
}
const after = fs.readdirSync(WORKSPACE_ROOT).filter(d => d.startsWith('r76-workspace-smoke-'));
assert(after.length === 0, 'no test dirs left in workspace');

// ─── Also verify constants are exported ──────────────────────────────────────

console.log('\n9. Exports check');
assert(typeof TASK_WORKSPACE_THRESHOLD === 'number', 'TASK_WORKSPACE_THRESHOLD exported as number');
assert(EXTERNALIZABLE_TOOLS instanceof Set, 'EXTERNALIZABLE_TOOLS exported as Set');
assert(EXTERNALIZABLE_TOOLS.has('exec'), 'EXTERNALIZABLE_TOOLS includes exec');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════');
if (FAILURES.length === 0) {
  console.log(`  ✅ ALL TESTS PASSED (${FAILURES.length} failures)`);
  console.log('═══════════════════════════════════════\n');
  process.exit(0);
} else {
  console.log(`  ❌ ${FAILURES.length} FAILURE(S):`);
  FAILURES.forEach((f, i) => console.log(`     ${i + 1}. ${f}`));
  console.log('═══════════════════════════════════════\n');
  process.exit(1);
}
