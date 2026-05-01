// ─── Output Manager ───
// Handles long output auto-save and workspace file management
// Extracted from openclaw-handler.mjs

import fs from 'node:fs';
import path from 'node:path';
import { LONG_OUTPUT_THRESHOLD, WORKSPACE_DIR, WORKSPACE_URL } from './agent-config.mjs';

import { logger } from '../lib/logger.mjs';
/**
 * Save long text output as a Markdown file in the workspace
 * @param {string} text - The text content to save
 * @param {string} msgId - The message ID for logging
 * @returns {object|null} { filename, filepath, fileUrl } or null on failure
 */
export function saveLongOutputAsFile(text, msgId) {
  const ts = () => new Date().toISOString();
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
    const filename = `report_${dateStr}_${timeStr}.md`;
    const filepath = path.join(WORKSPACE_DIR, filename);
    fs.writeFileSync(filepath, text, "utf-8");
    const fileUrl = `${WORKSPACE_URL}/${filename}`;
    logger.info(`[${ts()}] [output-manager] Saved ${text.length} chars to ${filepath}`);
    return { filename, filepath, fileUrl };
  } catch (err) {
    logger.info(`[${ts()}] [output-manager] Failed to save file: ${err.message}`);
    return null;
  }
}

/**
 * Check if text exceeds the long output threshold and auto-save if needed
 * @param {string} text - The text to check
 * @param {string} msgId - The message ID
 * @param {function} sendEvent - Event sender function
 * @returns {string} The text, potentially with appended download link
 */
export function handleLongOutput(text, msgId, sendEvent) {
  const ts = () => new Date().toISOString();
  if (text && text.length > LONG_OUTPUT_THRESHOLD) {
    logger.info(`[${ts()}] [output-manager] Text length ${text.length} exceeds threshold ${LONG_OUTPUT_THRESHOLD}, saving as document`);
    const fileInfo = saveLongOutputAsFile(text, msgId);
    if (fileInfo) {
      text += `\n\n---\n📄 **完整内容已保存为文档：** [${fileInfo.filename}](${fileInfo.fileUrl})`;
      sendEvent(msgId, { type: "file_changed", path: fileInfo.filename, action: "created" });
    }
  }
  return text;
}
