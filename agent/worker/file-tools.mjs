/**
 * file-tools.mjs — Persistent workspace file operations (Q3)
 * 
 * Provides file manipulation tools for the AI agent:
 *   - fileRead(sessionKey, path)
 *   - fileWrite(sessionKey, path, content)
 *   - fileAppend(sessionKey, path, content)
 *   - fileEdit(sessionKey, path, edits)
 *   - fileList(sessionKey, dirPath, options)
 *   - fileGrep(sessionKey, pattern, options)
 *   - fileDelete(sessionKey, path)
 *   - fileStat(sessionKey, path)
 *
 * All operations are scoped to the session workspace directory.
 * @module worker/file-tools
 */
import fs from 'fs/promises';
import path from 'path';
import { getOrCreateWorkspace } from './workspace-manager.mjs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function safePath(workspacePath, filePath) {
  const resolved = path.resolve(workspacePath, filePath);
  if (!resolved.startsWith(workspacePath)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

export async function fileRead(sessionKey, filePath) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, filePath);
    const stat = await fs.stat(fullPath);
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})` };
    }
    const content = await fs.readFile(fullPath, 'utf-8');
    logger.info(`[${ts()}] [Q3] fileRead: ${filePath} (${content.length} chars)`);
    return { success: true, content, size: stat.size };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileWrite(sessionKey, filePath, content) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    logger.info(`[${ts()}] [Q3] fileWrite: ${filePath} (${content.length} chars)`);
    return { success: true, path: filePath, size: content.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileAppend(sessionKey, filePath, content) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.appendFile(fullPath, content, 'utf-8');
    logger.info(`[${ts()}] [Q3] fileAppend: ${filePath} (+${content.length} chars)`);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileEdit(sessionKey, filePath, edits) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, filePath);
    let content = await fs.readFile(fullPath, 'utf-8');
    for (const edit of edits) {
      if (!edit.find) {
        return { success: false, error: 'Each edit must have a "find" field' };
      }
      const idx = content.indexOf(edit.find);
      if (idx === -1) {
        return { success: false, error: `Text not found: "${edit.find.substring(0, 50)}..."` };
      }
      if (edit.all) {
        content = content.replaceAll(edit.find, edit.replace || '');
      } else {
        content = content.replace(edit.find, edit.replace || '');
      }
    }
    await fs.writeFile(fullPath, content, 'utf-8');
    logger.info(`[${ts()}] [Q3] fileEdit: ${filePath} (${edits.length} edits)`);
    return { success: true, path: filePath, edits: edits.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileList(sessionKey, dirPath = '.', options = {}) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, dirPath);
    const { recursive = false, pattern = null } = options;
    
    async function listDir(dir, prefix = '') {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let results = [];
      for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          results.push({ name: relPath, type: 'directory' });
          if (recursive) {
            const subResults = await listDir(path.join(dir, entry.name), relPath);
            results = results.concat(subResults);
          }
        } else {
          if (pattern && !new RegExp(pattern).test(entry.name)) continue;
          const stat = await fs.stat(path.join(dir, entry.name));
          results.push({ name: relPath, type: 'file', size: stat.size });
        }
      }
      return results;
    }
    
    const files = await listDir(fullPath);
    logger.info(`[${ts()}] [Q3] fileList: ${dirPath} (${files.length} entries, recursive=${recursive})`);
    return { success: true, files, count: files.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileGrep(sessionKey, pattern, options = {}) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const { dirPath = '.', maxResults = 50 } = options;
    const searchDir = safePath(ws, dirPath);
    const regex = new RegExp(pattern, options.flags || 'g');
    const results = [];
    
    async function searchDir_(dir) {
      if (results.length >= maxResults) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await searchDir_(fullPath);
        } else {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  file: path.relative(ws, fullPath),
                  line: i + 1,
                  text: lines[i].substring(0, 200),
                });
                if (results.length >= maxResults) return;
              }
              regex.lastIndex = 0;
            }
          } catch (_) { /* skip binary files */ }
        }
      }
    }
    
    await searchDir_(searchDir);
    logger.info(`[${ts()}] [Q3] fileGrep: pattern="${pattern}" (${results.length} matches)`);
    return { success: true, matches: results, count: results.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileDelete(sessionKey, filePath) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, filePath);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await fs.unlink(fullPath);
    }
    logger.info(`[${ts()}] [Q3] fileDelete: ${filePath}`);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function fileStat(sessionKey, filePath) {
  try {
    const ws = await getOrCreateWorkspace(sessionKey);
    const fullPath = safePath(ws, filePath);
    const stat = await fs.stat(fullPath);
    return {
      success: true,
      path: filePath,
      size: stat.size,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      modified: stat.mtimeMs,
      created: stat.birthtimeMs,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
