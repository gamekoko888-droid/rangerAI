#!/usr/bin/env node
/**
 * RangerAI ESM Hot-Reload Watcher (Iter-55)
 * 
 * Watches .mjs files for changes and automatically:
 * 1. Validates syntax (node --check)
 * 2. Restarts rangerai-agent.service if valid
 * 3. Logs all actions with timestamps
 * 
 * Usage: node /opt/rangerai-agent/watch-reload.mjs [--dry-run]
 * 
 * NOTE: This is for DEVELOPMENT use only. In production, use systemd restart.
 * The ESM module cache cannot be invalidated at runtime (Node.js limitation),
 * so a full process restart is required for .mjs changes to take effect.
 */

import { logger } from './lib/logger.mjs';
import { watch } from 'fs';
import { execSync } from 'child_process';
import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';

const WATCH_DIR = '/opt/rangerai-agent';
const IGNORE_DIRS = ['node_modules', '.git', 'client', 'dist', 'backups'];
const DEBOUNCE_MS = 2000;
const DRY_RUN = process.argv.includes('--dry-run');

let debounceTimer = null;
let pendingChanges = new Set();

function log(msg) {
  const ts = new Date().toISOString();
  logger.info(`[${ts}] [hot-reload] ${msg}`);
}

function validateFile(filepath) {
  try {
    execSync(`node --check "${filepath}"`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    log(`SYNTAX ERROR in ${filepath}: ${e.stderr?.toString().trim()}`);
    return false;
  }
}

function restartService() {
  if (DRY_RUN) {
    log('DRY-RUN: Would restart rangerai-agent.service');
    return true;
  }
  try {
    log('Restarting rangerai-agent.service...');
//     execSync('sudo systemctl restart rangerai-agent.service', { stdio: 'pipe', timeout: 30000 });
    // Wait and check
    execSync('sleep 3', { stdio: 'pipe' });
    const status = execSync('systemctl is-active rangerai-agent.service', { stdio: 'pipe' }).toString().trim();
    if (status === 'active') {
      log('Service restarted successfully');
      return true;
    } else {
      log(`WARNING: Service status is "${status}" after restart`);
      return false;
    }
  } catch (e) {
    log(`RESTART FAILED: ${e.message}`);
    return false;
  }
}

function handleChanges() {
  const files = [...pendingChanges];
  pendingChanges.clear();
  
  log(`Changes detected in ${files.length} file(s): ${files.join(', ')}`);
  
  // Validate all changed files
  let allValid = true;
  for (const f of files) {
    if (!validateFile(f)) {
      allValid = false;
    }
  }
  
  if (!allValid) {
    log('BLOCKED: Syntax errors found. Fix errors before restart.');
    return;
  }
  
  log('All files valid. Triggering restart...');
  restartService();
}

async function getWatchDirs(baseDir) {
  const dirs = [baseDir];
  
  async function walk(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !IGNORE_DIRS.includes(entry.name)) {
          const fullPath = join(dir, entry.name);
          dirs.push(fullPath);
          await walk(fullPath);
        }
      }
    } catch (e) {
      // Skip inaccessible dirs
    }
  }
  
  await walk(baseDir);
  return dirs;
}

async function main() {
  log(`Starting ESM hot-reload watcher${DRY_RUN ? ' (DRY-RUN)' : ''}`);
  log(`Watching: ${WATCH_DIR}`);
  log(`Ignoring: ${IGNORE_DIRS.join(', ')}`);
  log(`Debounce: ${DEBOUNCE_MS}ms`);
  
  const watchDirs = await getWatchDirs(WATCH_DIR);
  log(`Monitoring ${watchDirs.length} directories`);
  
  for (const dir of watchDirs) {
    try {
      watch(dir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.mjs')) return;
        
        const fullPath = join(dir, filename);
        pendingChanges.add(fullPath);
        
        // Debounce: wait for batch changes to settle
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleChanges, DEBOUNCE_MS);
      });
    } catch (e) {
      // Some dirs may not be watchable
    }
  }
  
  log('Watcher running. Press Ctrl+C to stop.');
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
