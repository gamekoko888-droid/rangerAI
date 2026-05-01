// [TD-035] NOTE: This is the canonical version. Also exists as worker/checkpoint-manager.mjs (copy).
/**
 * Checkpoint Manager — Git-based workspace versioning for RangerAI
 * v22.3: Converted all execSync to async exec to avoid blocking Worker event loop
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { logger } from './lib/logger.mjs';
const execAsync = promisify(exec);

const WORKSPACE_DIR = process.env.RANGER_WORKSPACE || '/home/admin/ranger-workspace';

/**
 * Run a git command asynchronously in the workspace directory.
 * @param {string} cmd - Shell command to execute
 * @param {object} [opts] - Additional options
 * @returns {Promise<string>} stdout trimmed
 */
async function gitExec(cmd, opts = {}) {
  const { stdout } = await execAsync(cmd, {
    cwd: WORKSPACE_DIR,
    timeout: opts.timeout || 15000,
    ...opts,
  });
  return stdout.toString().trim();
}

/**
 * Ensure the workspace has a git repo initialized.
 */
async function ensureGitRepo() {
  try {
    await gitExec('git rev-parse --is-inside-work-tree');
  } catch {
    // Not a git repo yet — initialize
    await gitExec('git init');
    await gitExec('git config user.email "ranger@openclaw.local"');
    await gitExec('git config user.name "RangerAI"');
    // Initial commit
    try {
      await gitExec('git add -A && git commit -m "Initial workspace state" --allow-empty');
    } catch {
      // May fail if nothing to commit
    }
  }
}

// ─── Save Checkpoint ─────────────────────────────────────────
/**
 * Save current workspace state as a git checkpoint.
 * @param {string} description - Human-readable description
 * @param {string} [taskId] - Optional task ID for tagging
 * @returns {Promise<{ id: string, tag: string, description: string, timestamp: string, files: number, taskId: string|null } | null>}
 */
export async function saveCheckpoint(description, taskId) {
  try {
    await ensureGitRepo();

    // Stage all changes
    await gitExec('git add -A');

    // Check if there are changes to commit
    const commitMsg = `[checkpoint] ${description}`;
    try {
      await gitExec('git diff --cached --quiet');
      // No changes — commit anyway with --allow-empty for tracking
      await gitExec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}" --allow-empty`);
    } catch {
      // There are changes — normal commit
      await gitExec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    }

    // Get commit hash
    const hash = await gitExec('git rev-parse --short HEAD');
    const timestamp = new Date().toISOString();

    // Tag with task ID if provided
    const tagName = taskId ? `task-${taskId}-${hash}` : `cp-${hash}`;
    try {
      await gitExec(`git tag ${tagName}`);
    } catch {
      // Tag might already exist
    }

    // Count tracked files
    const fileCountStr = await gitExec('git ls-files | wc -l');
    const fileCount = parseInt(fileCountStr) || 0;

    const checkpoint = {
      id: hash,
      tag: tagName,
      description,
      timestamp,
      files: fileCount,
      taskId: taskId || null,
    };

    logger.info(`[checkpoint] Saved: ${hash} — "${description}" (${fileCount} files)`);
    return checkpoint;

  } catch (err) {
    logger.error('[checkpoint] Save failed:', err.message);
    return null;
  }
}

// ─── Restore Checkpoint ──────────────────────────────────────
/**
 * Restore workspace to a previous checkpoint.
 * @param {string} ref - Commit hash, tag name, or "latest"
 * @returns {Promise<{ success: boolean, restoredTo: string, description: string } | null>}
 */
export async function restoreCheckpoint(ref) {
  try {
    await ensureGitRepo();

    // Save current state first (auto-backup)
    await saveCheckpoint('Auto-backup before restore', null);

    let targetRef = ref;
    if (ref === 'latest' || ref === 'last') {
      targetRef = 'HEAD~1';
    }

    // Hard reset to the target
    await gitExec('git checkout -- . && git clean -fd');
    await gitExec(`git reset --hard ${targetRef}`);

    // Get info about restored state
    const hash = await gitExec('git rev-parse --short HEAD');
    const desc = await gitExec('git log -1 --format=%s');

    logger.info(`[checkpoint] Restored to: ${hash} — "${desc}"`);
    return { success: true, restoredTo: hash, description: desc };

  } catch (err) {
    logger.error('[checkpoint] Restore failed:', err.message);
    return null;
  }
}

// ─── List Checkpoints ────────────────────────────────────────
/**
 * List recent checkpoints.
 * @param {number} [limit=10] - Maximum number of checkpoints to return
 * @returns {Promise<Array<{ id: string, description: string, timestamp: string, filesChanged: number }>>}
 */
export async function listCheckpoints(limit = 10) {
  try {
    await ensureGitRepo();

    const log = await gitExec(
      `git log --oneline --format="%h|%s|%ai|%ct" -n ${limit}`
    );

    if (!log) return [];

    return log.split('\n').map(line => {
      const [hash, description, date, unixTs] = line.split('|');
      return {
        id: hash,
        description: description.replace('[checkpoint] ', ''),
        timestamp: date,
        unixTimestamp: parseInt(unixTs) * 1000,
      };
    });

  } catch (err) {
    logger.error('[checkpoint] List failed:', err.message);
    return [];
  }
}

// ─── Diff Between Checkpoints ────────────────────────────────
/**
 * Get diff between two checkpoints or current state vs last checkpoint.
 * @param {string} [from='HEAD~1'] - Start ref
 * @param {string} [to='HEAD'] - End ref
 * @returns {Promise<{ files: Array<{ path: string, status: string }>, summary: string }>}
 */
export async function diffCheckpoints(from = 'HEAD~1', to = 'HEAD') {
  try {
    await ensureGitRepo();

    const diff = await gitExec(`git diff --name-status ${from} ${to}`);

    const files = diff ? diff.split('\n').map(line => {
      const [status, ...pathParts] = line.split('\t');
      return {
        path: pathParts.join('\t'),
        status: status === 'A' ? 'added' : status === 'M' ? 'modified' : status === 'D' ? 'deleted' : status,
      };
    }) : [];

    const stat = await gitExec(`git diff --stat ${from} ${to}`);

    return { files, summary: stat };

  } catch (err) {
    logger.error('[checkpoint] Diff failed:', err.message);
    return { files: [], summary: '' };
  }
}

// ─── Export for OpenClaw Tools ────────────────────────────────
/**
 * Handle checkpoint commands from SOUL.md instructions.
 * v22.3: Now async — callers must await.
 *
 * @param {string} action - 'save' | 'restore' | 'list' | 'diff'
 * @param {object} params - Action-specific parameters
 * @returns {Promise<object>} Result of the action
 */
export async function handleCheckpointAction(action, params = {}) {
  switch (action) {
    case 'save':
      return await saveCheckpoint(params.description || 'Unnamed checkpoint', params.taskId);
    case 'restore':
      return await restoreCheckpoint(params.ref || 'latest');
    case 'list':
      return await listCheckpoints(params.limit || 10);
    case 'diff':
      return await diffCheckpoints(params.from, params.to);
    default:
      return { error: `Unknown checkpoint action: ${action}` };
  }
}
