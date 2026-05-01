// ─── Observation Compressor ─── R50-T3
// 将工具返回结果在回灌上下文前压缩，减少 prompt token 消耗
// 接入点：openclaw-handler.mjs 中工具结果写入 event_stream 之前调用

import { logger } from '../lib/logger.mjs';

// 压缩开关（环境变量控制，设为 '0' 可临时关闭）
const COMPRESS_ENABLED = process.env.OBS_COMPRESS !== '0';

// 各类工具的目标输出上限（字符数，约等于 token 数 × 2.5）
const LIMITS = {
  shell:      parseInt(process.env.OBS_LIMIT_SHELL   || '3000'),
  web:        parseInt(process.env.OBS_LIMIT_WEB     || '3500'),
  json:       parseInt(process.env.OBS_LIMIT_JSON    || '2500'),
  default:    parseInt(process.env.OBS_LIMIT_DEFAULT || '4000'),
};

/** 工具名分类 */
function classifyTool(toolName) {
  if (!toolName) return 'default';
  const t = toolName.toLowerCase();
  if (['exec', 'shell', 'bash', 'run_command', 'terminal'].some(k => t.includes(k))) return 'shell';
  if (['web_fetch', 'browser', 'navigate', 'page'].some(k => t.includes(k))) return 'web';
  return 'default';
}

/** Shell / exec 输出压缩 */
function compressShellOutput(output, maxLen) {
  if (output.length <= maxLen) return output;

  const lines = output.split('\n');
  const errorLines = lines.filter(l => /error|Error|ERROR|failed|FAILED|exception|Exception|Traceback/i.test(l));
  const warnLines  = lines.filter(l => /warn|Warn|WARN/i.test(l)).slice(0, 3);

  const headCount = Math.min(15, Math.floor(lines.length * 0.2));
  const tailCount = Math.min(10, Math.floor(lines.length * 0.1));

  const sections = [
    `[shell output: ${lines.length} lines, ${output.length} chars → compressed]`,
  ];

  if (errorLines.length > 0) {
    sections.push(`[ERRORS (${errorLines.length})]:\n${errorLines.slice(0, 8).join('\n')}`);
  }
  if (warnLines.length > 0) {
    sections.push(`[WARNINGS]:\n${warnLines.join('\n')}`);
  }

  const head = lines.slice(0, headCount).join('\n');
  sections.push(`[HEAD ${headCount} lines]:\n${head}`);

  if (lines.length > headCount + tailCount) {
    const tail = lines.slice(-tailCount).join('\n');
    sections.push(`[... ${lines.length - headCount - tailCount} lines omitted ...]`);
    sections.push(`[TAIL ${tailCount} lines]:\n${tail}`);
  }

  const result = sections.join('\n\n');
  // 如果仍然超限，最终截断
  return result.length > maxLen * 1.2
    ? result.substring(0, maxLen) + `\n...[further truncated]`
    : result;
}

/** 网页/web_fetch 输出压缩 */
function compressWebOutput(content, maxLen) {
  if (content.length <= maxLen) return content;

  // 提取标题行
  const titleMatch = content.match(/^(#{1,3} .+)/m);
  const title = titleMatch ? titleMatch[1] : '';

  // 提取代码块外的正文（去除重复的链接）
  let body = content
    .replace(/!\[.*?\]\(.*?\)/g, '[image]')   // 图片
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\)]+\)/g, '$1') // 链接只保留文字
    .replace(/\n{3,}/g, '\n\n');               // 多余空行

  const bodyTruncated = body.substring(0, maxLen - title.length - 100);
  return [
    title ? `${title}\n` : '',
    bodyTruncated,
    body.length > maxLen ? `\n...[${body.length - maxLen} chars omitted]` : ''
  ].filter(Boolean).join('');
}

/** JSON 输出压缩 */
function compressJsonOutput(output, maxLen) {
  if (output.length <= maxLen) return output;

  try {
    const obj = JSON.parse(output);
    // 如果是数组，给摘要
    if (Array.isArray(obj)) {
      const summary = `[Array: ${obj.length} items, first item keys: ${Object.keys(obj[0] || {}).join(', ')}]`;
      const partial = JSON.stringify(obj.slice(0, 3), null, 2);
      return `${summary}\n${partial.substring(0, maxLen - summary.length)}\n...[${obj.length - 3} more items]`;
    }
    // 如果是对象，给 key 摘要 + 部分内容
    const keys = Object.keys(obj);
    const summary = `{Object: ${keys.length} keys: [${keys.join(', ')}]}`;
    const partial = JSON.stringify(obj, null, 2);
    return `${summary}\n${partial.substring(0, maxLen)}\n...[truncated]`;
  } catch {
    // 非 JSON，直接截断
    return output.substring(0, maxLen) + `\n...[${output.length - maxLen} chars omitted]`;
  }
}

/**
 * 压缩工具返回结果
 * @param {string} toolName  - 工具名称
 * @param {string} rawOutput - 原始输出字符串
 * @param {object} opts      - 可选：{ forceLimit: number }
 * @returns {{ compressed: string, originalLength: number, didCompress: boolean }}
 */
export function compressObservation(toolName, rawOutput, opts = {}) {
  if (!COMPRESS_ENABLED) {
    return { compressed: rawOutput, originalLength: rawOutput.length, didCompress: false };
  }

  if (typeof rawOutput !== 'string') {
    rawOutput = JSON.stringify(rawOutput);
  }

  const kind = classifyTool(toolName);
  const maxLen = opts.forceLimit || LIMITS[kind] || LIMITS.default;
  const originalLength = rawOutput.length;

  if (originalLength <= maxLen) {
    return { compressed: rawOutput, originalLength, didCompress: false };
  }

  let compressed;
  try {
    if (kind === 'shell') {
      compressed = compressShellOutput(rawOutput, maxLen);
    } else if (kind === 'web') {
      compressed = compressWebOutput(rawOutput, maxLen);
    } else if (rawOutput.trimStart().startsWith('{') || rawOutput.trimStart().startsWith('[')) {
      compressed = compressJsonOutput(rawOutput, maxLen);
    } else {
      // 默认：head + tail
      const half = Math.floor(maxLen / 2);
      compressed = rawOutput.substring(0, half)
        + `\n...[${originalLength - maxLen} chars omitted]...\n`
        + rawOutput.substring(originalLength - half);
    }
  } catch (err) {
    logger.warn(`[observation-compressor] compress error for tool=${toolName}: ${err?.message}`);
    compressed = rawOutput.substring(0, maxLen) + `\n...[truncated]`;
  }

  const ratio = Math.round((1 - compressed.length / originalLength) * 100);
  logger.debug(`[observation-compressor] tool=${toolName} ${originalLength}→${compressed.length} chars (-${ratio}%)`);

  return { compressed, originalLength, didCompress: true, compressionRatio: ratio };
}

/**
 * 批量压缩 event_stream 中的旧 observation（用于上下文分层）
 * @param {Array} events - event_stream 事件列表
 * @param {number} keepRecentN - 保留最近 N 条 observation 不压缩
 * @returns {Array} 压缩后的 events
 */
export function compressOldObservations(events, keepRecentN = 3) {
  if (!COMPRESS_ENABLED || !Array.isArray(events)) return events;

  // 找出所有 tool_result / observation 类型的事件
  const obsIndices = events
    .map((e, i) => ({ i, e }))
    .filter(({ e }) => e.type === 'tool_result' || e.type === 'observation' || e.role === 'tool');

  // 只压缩不在最近 keepRecentN 条内的 observation
  const toCompress = obsIndices.slice(0, Math.max(0, obsIndices.length - keepRecentN));

  if (toCompress.length === 0) return events;

  const result = [...events];
  for (const { i, e } of toCompress) {
    const content = typeof e.content === 'string' ? e.content : JSON.stringify(e.content);
    if (content.length <= LIMITS.default) continue;

    const { compressed, didCompress } = compressObservation(e.toolName || e.name || 'unknown', content);
    if (didCompress) {
      result[i] = { ...e, content: compressed, _compressed: true };
    }
  }

  return result;
}

/** 获取压缩统计（用于 admin stats） */
export function getCompressionStats() {
  return {
    enabled: COMPRESS_ENABLED,
    limits: LIMITS,
  };
}
