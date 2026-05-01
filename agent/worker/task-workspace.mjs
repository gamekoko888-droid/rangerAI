/**
 * worker/task-workspace.mjs — Iter-AB (v25.23)
 *
 * 文件系统主动外化记忆，对标 Manus "文件即上下文"策略。
 *
 * 每个任务获得独立工作目录：
 *   /home/admin/.openclaw/workspace/tasks/{taskId}/
 *
 * 工具结果 >4000 字符时写入文件，Context 只保留路径引用，
 * 彻底突破 128K token 上下文窗口限制。
 *
 * TTL: 任务完成后 48h 自动清理（cleanupTaskWorkspace 触发）
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── 配置 ────────────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = '/home/admin/.openclaw/workspace/tasks';
const TASK_WORKSPACE_THRESHOLD = parseInt(process.env.TASK_WORKSPACE_THRESHOLD || '4000', 10);
const EXTERNALIZABLE_TOOLS = new Set(['exec', 'web_fetch', 'web_search', 'read', 'read_file']);

export { TASK_WORKSPACE_THRESHOLD, EXTERNALIZABLE_TOOLS };

// ─── 工作目录管理 ─────────────────────────────────────────────────────────────

/**
 * 为任务创建工作目录（幂等，目录已存在则不报错）。
 *
 * @param {string} taskId
 * @returns {string} 目录绝对路径
 */
export function initTaskWorkspace(taskId) {
  if (!taskId) return null;
  const dir = path.join(WORKSPACE_ROOT, sanitizeTaskId(taskId));
  try {
    fs.mkdirSync(dir, { recursive: true });
    logger.debug(`[${ts()}] [task-workspace] Init: ${dir}`);
  } catch (err) {
    logger.warn(`[${ts()}] [task-workspace] initTaskWorkspace failed: ${err.message}`);
  }
  return dir;
}

/**
 * 写文件到任务工作目录。
 *
 * @param {string} taskId
 * @param {string} filename
 * @param {string} content
 * @returns {string|null} 绝对路径，失败返回 null
 */
export function writeTaskFile(taskId, filename, content) {
  if (!taskId || !filename) return null;
  const dir = path.join(WORKSPACE_ROOT, sanitizeTaskId(taskId));
  const filepath = path.join(dir, sanitizeFilename(filename));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, content, 'utf-8');
    logger.info(`[${ts()}] [task-workspace] Wrote ${content.length} chars → ${filepath}`);
    return filepath;
  } catch (err) {
    logger.warn(`[${ts()}] [task-workspace] writeTaskFile failed: ${err.message}`);
    return null;
  }
}

/**
 * 读取任务工作目录中的文件。
 *
 * @param {string} taskId
 * @param {string} filename
 * @returns {string|null} 文件内容，不存在或读取失败返回 null
 */
export function readTaskFile(taskId, filename) {
  if (!taskId || !filename) return null;
  const filepath = path.join(WORKSPACE_ROOT, sanitizeTaskId(taskId), sanitizeFilename(filename));
  try {
    return fs.existsSync(filepath) ? fs.readFileSync(filepath, 'utf-8') : null;
  } catch (err) {
    logger.warn(`[${ts()}] [task-workspace] readTaskFile failed: ${err.message}`);
    return null;
  }
}

/**
 * 列出任务工作目录中的文件。
 *
 * @param {string} taskId
 * @returns {Array<{name: string, size: number, mtime: Date}>}
 */
export function listTaskFiles(taskId) {
  if (!taskId) return [];
  const dir = path.join(WORKSPACE_ROOT, sanitizeTaskId(taskId));
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(name => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, mtime: st.mtime };
    }).filter(f => f.size > 0);
  } catch {
    return [];
  }
}

/**
 * 删除任务工作目录（任务完成时调用）。
 * 为安全起见，只删除 WORKSPACE_ROOT 下的子目录。
 *
 * @param {string} taskId
 */
export function cleanupTaskWorkspace(taskId) {
  if (!taskId) return;
  const dir = path.join(WORKSPACE_ROOT, sanitizeTaskId(taskId));
  if (!dir.startsWith(WORKSPACE_ROOT + '/')) return; // 安全检查
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info(`[${ts()}] [task-workspace] Cleaned up: ${dir}`);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [task-workspace] cleanupTaskWorkspace failed: ${err.message}`);
  }
}

// ─── Context 注入 ─────────────────────────────────────────────────────────────

/**
 * 生成 [WORKSPACE] 注入块，告知 Agent 当前任务有哪些外化文件可读取。
 * 仅当工作目录存在文件时才生成（避免空块污染 Context）。
 *
 * @param {string} taskId
 * @returns {string} [WORKSPACE] 块字符串，无文件时返回空字符串
 */
export function buildWorkspaceBlock(taskId) {
  if (!taskId) return '';
  const files = listTaskFiles(taskId);
  if (files.length === 0) return '';

  const relRoot = `workspace/tasks/${sanitizeTaskId(taskId)}`;
  const fileList = files.map(f => {
    const kb = (f.size / 1024).toFixed(1);
    return `  - ${f.name}（${kb} KB）`;
  }).join('\n');

  return [
    '[WORKSPACE]',
    `任务工作区：${relRoot}/`,
    '当前外化文件（使用 read 工具按路径访问）：',
    fileList,
    '[/WORKSPACE]',
  ].join('\n');
}

// ─── 工具结果外化 ─────────────────────────────────────────────────────────────

/**
 * 检查工具结果是否需要外化，若需要则写文件并返回替代引用字符串。
 *
 * @param {string} taskId
 * @param {string} toolName
 * @param {string} result
 * @returns {{ externalized: boolean, ref: string }} ref 为替代字符串或原文
 */
export function loadFileMemory(taskId) {
  if (!taskId) return null;
  const files = listTaskFiles(taskId);
  if (files.length === 0) return null;
  const entries = [];
  for (const file of files) {
    if (!file.name.startsWith('tool-')) continue;
    const match = file.name.match(/^tool-(.+?)-\d+\.txt$/);
    const toolName = match ? match[1] : 'unknown';
    const kb = (file.size / 1024).toFixed(1);
    let preview = '';
    try { const content = readTaskFile(taskId, file.name); if (content) preview = content.substring(0, 200).replace(/\n/g, ' '); } catch (_) {}
    entries.push(`  - [${toolName}] ${file.name} (${kb}KB): ${preview}...`);
  }
  return entries.length ? ['[FILE_MEMORY]', ...entries, '[/FILE_MEMORY]'].join('\n') : null;
}

export function maybeExternalize(taskId, toolName, result) {
  if (!taskId || !toolName || typeof result !== 'string') {
    return { externalized: false, ref: result };
  }
  if (!EXTERNALIZABLE_TOOLS.has(toolName)) {
    return { externalized: false, ref: result };
  }
  if (result.length <= TASK_WORKSPACE_THRESHOLD) {
    return { externalized: false, ref: result };
  }

  const filename = `tool-${toolName}-${Date.now()}.txt`;
  const filepath = writeTaskFile(taskId, filename, result);
  if (!filepath) {
    return { externalized: false, ref: result };
  }

  const relPath = `workspace/tasks/${sanitizeTaskId(taskId)}/${filename}`;
  const ref = `[结果已外化（${result.length} 字符），路径: ${relPath}，使用 read 工具读取完整内容]`;
  logger.info(`[${ts()}] [task-workspace] Externalized ${toolName} result (${result.length} chars) → ${filename}`);
  return { externalized: true, ref };
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

function sanitizeTaskId(taskId) {
  // 只允许字母数字、-、_ ，防止路径穿越
  return String(taskId).replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 64);
}

function sanitizeFilename(filename) {
  return path.basename(String(filename)).replace(/[^a-zA-Z0-9\-_.]/g, '_').slice(0, 128);
}
