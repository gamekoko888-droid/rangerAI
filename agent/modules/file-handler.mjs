/**
 * file-handler.mjs — File attachment content injection (v2)
 * 
 * Reads uploaded files referenced in message content and appends their
 * extracted text so the AI can see them.
 * 
 * Now delegates ALL parsing to lib/file-parser.mjs (Single Source of Truth).
 */
import { logger } from '../lib/logger.mjs';
import { parseFile } from '../lib/file-parser.mjs';
import path from 'path';

const FILES_DIR = '/opt/rangerai-agent/files';

/**
 * Expand file attachment references in message content.
 * Supports two formats:
 *   1. Frontend format: [附件: name] 文件路径: /files/path
 *   2. Legacy markdown:  [附件: name](/files/path)
 * 
 * @param {string} content - Raw message content
 * @returns {Promise<string>} Content with file text injected
 */
export async function expandFileAttachments(content) {
  const pattern = /\[附件: ([^\]]+)\] 文件路径: \/files\/([^\s\n]+)|\[附件: ([^\]]+)\]\(\/files\/([^)]+)\)/g;
  let match;
  const injections = [];

  while ((match = pattern.exec(content)) !== null) {
    const displayName = match[1] || match[3];
    const fileName = match[2] || match[4];
    const filePath = path.join(FILES_DIR, fileName);

    try {
      const result = await parseFile(filePath);

      if (result.type === 'missing') {
        injections.push(`\n\n[附件 "${displayName}" 文件不存在]`);
      } else if (result.type === 'oversized') {
        injections.push(`\n\n[附件 "${displayName}" ${result.text}]`);
      } else if (result.type === 'image' || result.type === 'audio' || result.type === 'video' || result.type === 'archive') {
        injections.push(`\n\n[附件 "${displayName}" ${result.text}]`);
      } else {
        const truncNote = result.truncated ? ' (内容已截断)' : '';
        injections.push(`\n\n--- 附件内容: ${displayName}${truncNote} ---\n${result.text}\n--- 附件结束 ---`);
      }
    } catch (e) {
      logger.warn(`[expandFileAttachments] Failed to read ${fileName}: ${e.message}`);
      injections.push(`\n\n[附件 "${displayName}" 读取失败: ${e.message}]`);
    }
  }

  return injections.length > 0 ? content + injections.join('') : content;
}
