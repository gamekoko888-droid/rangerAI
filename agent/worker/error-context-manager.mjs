/**
 * worker/error-context-manager.mjs — Iter-AC (v25.24)
 *
 * 错误保留策略，对标 Manus 3.5：
 * "错误信息必须保留在 Context 中，不得清除。错误的存在使模型隐式更新内部信念，
 *  降低重复同类错误的概率。"
 *
 * 职责：
 * 1. hasRecentErrors() — 检查最近 N 条历史是否含工具失败记录
 * 2. buildErrorSummaryBlock() — 生成 [ERROR_CONTEXT] 注入块（compact 替代品）
 * 3. appendToolError() — 将工具错误追加到 conversationHistory
 */

const ts = () => new Date().toISOString();

// 错误特征匹配正则
const ERROR_PATTERNS = [
  /error|失败|timeout|denied|exception|refused|unreachable/i,
  /\[TOOL_ERROR\]/,
  /tool.*fail|fail.*tool/i,
  /cannot|无法|不可|拒绝/i,
];

/**
 * 检查最近 n 条 conversationHistory 消息是否含有错误记录。
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 * @param {number} n - 检查最近 N 条，默认 5
 * @returns {boolean}
 */
export function hasRecentErrors(messages, n = 5) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const recent = messages.slice(-n);
  return recent.some(m => {
    const text = extractMessageText(m);
    return ERROR_PATTERNS.some(p => p.test(text));
  });
}

/**
 * 生成 [ERROR_CONTEXT] 注入块，提炼最近 n 条消息中的错误摘要。
 * 当 compact 前检测到错误时，注入此块而非直接清除历史。
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 * @param {number} n - 摘取最近 N 条，默认 5
 * @returns {string} [ERROR_CONTEXT] 块，无错误时返回空字符串
 */
export function buildErrorSummaryBlock(messages, n = 5) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const recent = messages.slice(-n);
  const errorEntries = [];

  for (const m of recent) {
    const text = extractMessageText(m);
    if (ERROR_PATTERNS.some(p => p.test(text))) {
      // 提取错误核心内容（去噪，截断到 120 字符）
      const snippet = text
        .replace(/\[TOOL_ERROR\][\s\S]*?\[\/TOOL_ERROR\]/g, s => s.slice(0, 120))
        .replace(/\n+/g, ' ')
        .trim()
        .slice(0, 120);
      if (snippet) errorEntries.push(`- [${m.role}] ${snippet}`);
    }
  }

  if (errorEntries.length === 0) return '';

  return [
    '[ERROR_CONTEXT]',
    '上一步操作存在以下失败记录（已保留供模型学习，勿重复同类操作）：',
    ...errorEntries,
    '[/ERROR_CONTEXT]',
  ].join('\n');
}

/**
 * 将工具调用错误追加到 conversationHistory（结构化 [TOOL_ERROR] 块）。
 * 在 agentic loop 工具 error 时调用，确保模型下一轮能在 Context 中看到失败记录。
 *
 * @param {Array} conversationHistory - 原地修改
 * @param {string} toolName
 * @param {string|Error} error
 * @param {object} [args] - 可选：工具调用参数摘要
 */
export function appendToolError(conversationHistory, toolName, error, args = null) {
  if (!Array.isArray(conversationHistory)) return;

  const errMsg = error instanceof Error ? error.message : String(error || '未知错误');
  const argsSummary = args ? JSON.stringify(args).slice(0, 100) : '';

  const errorBlock = [
    '[TOOL_ERROR]',
    `工具: ${toolName}`,
    `错误: ${errMsg.slice(0, 200)}`,
    argsSummary ? `参数: ${argsSummary}` : null,
    `时间: ${ts()}`,
    '[/TOOL_ERROR]',
  ].filter(Boolean).join('\n');

  conversationHistory.push({
    role: 'tool',
    content: errorBlock,
    _toolError: true, // 标记便于后续识别
  });
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

function extractMessageText(message) {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : (c.text || c.content || ''))).join(' ');
  }
  return '';
}
