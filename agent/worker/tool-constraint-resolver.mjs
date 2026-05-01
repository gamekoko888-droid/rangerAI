/**
 * worker/tool-constraint-resolver.mjs — Iter-AA (v25.23)
 *
 * 工具约束结构化：将任务阶段的语义工具类别映射为具体工具名白名单，
 * 并生成结构化 XML 约束块注入 Context。
 *
 * 对标 Manus：通过前缀匹配实现 token 级别工具选择约束（软约束升级版）。
 * 约束形式：纯文本 TOOL_MASK → 结构化 <tool_constraint> XML 块。
 *
 * 语义类别映射：
 *   "file"    → read, write, edit, exec（exec 保留用于 grep/cat）
 *   "browser" → browser, web_fetch
 *   "exec"    → exec
 *   "search"  → web_search, web_fetch, browser
 *   "chat"    → []（仅文字回复，不调工具）
 *   "all"     → null（不约束，默认行为）
 */

// ─── 语义类别 → 工具名白名单 ──────────────────────────────────────────────────
const CATEGORY_MAP = {
  file:    ['read', 'write', 'edit', 'exec'],
  browser: ['browser', 'web_fetch'],
  exec:    ['exec'],
  search:  ['web_search', 'web_fetch', 'browser'],
  chat:    [],   // 空 = 不调工具
  all:     null, // null = 不约束
};

// ─── 工具类别 → 禁止列表（对称约束，辅助提示词） ───────────────────────────
const FORBIDDEN_MAP = {
  file:    ['web_search', 'web_fetch', 'browser'],
  browser: ['write', 'edit', 'exec'],
  exec:    ['browser', 'web_search', 'web_fetch', 'write', 'edit'],
  search:  ['write', 'edit', 'exec'],
  chat:    ['read', 'write', 'edit', 'exec', 'browser', 'web_search', 'web_fetch'],
  all:     [],
};

// ─── 工具类别的阶段描述 ──────────────────────────────────────────────────────
const PHASE_DESC = {
  file:    '文件读写阶段',
  browser: '网页浏览阶段',
  exec:    '命令执行阶段',
  search:  '信息收集阶段',
  chat:    '对话回复阶段（不需要调用工具）',
  all:     '无限制阶段',
};

/**
 * 将语义工具类别数组解析为具体工具名白名单。
 *
 * @param {string[]} phaseTools - 如 ['file', 'exec'] 或 ['all']
 * @returns {string[] | null} 具体工具名白名单；['all'] 或空输入返回 null（不约束）
 */
export function resolveAllowedTools(phaseTools) {
  if (!Array.isArray(phaseTools) || phaseTools.length === 0) return null;
  if (phaseTools.includes('all')) return null;

  const allowed = new Set();
  for (const cat of phaseTools) {
    const tools = CATEGORY_MAP[cat];
    if (tools === null) return null; // any 'all' mapped category → no constraint
    if (Array.isArray(tools)) tools.forEach(t => allowed.add(t));
  }
  return [...allowed];
}

/**
 * 生成结构化 XML 约束块，替代原 [TOOL_MASK] 纯文本软约束。
 *
 * @param {{ id?: string|number, title?: string, allowedTools?: string[] }} phase
 * @returns {string} 结构化 <tool_constraint> XML 块
 */
export function buildToolConstraintBlock(phase) {
  if (!phase) return '';

  const semanticTools = phase.allowedTools || ['all'];
  if (semanticTools.includes('all')) return '';

  const allowed = resolveAllowedTools(semanticTools);
  if (!allowed) return '';

  // 计算禁止列表（取所有类别 forbidden 的交集）
  const forbidden = new Set();
  for (const cat of semanticTools) {
    const f = FORBIDDEN_MAP[cat] || [];
    f.forEach(t => forbidden.add(t));
  }
  // 从 forbidden 里移除 allowed（有时 exec 既 allowed 又 forbidden）
  allowed.forEach(t => forbidden.delete(t));

  // 阶段描述
  const desc = semanticTools.map(c => PHASE_DESC[c] || c).join('、');

  const lines = [
    '<tool_constraint>',
    `  <phase id="${phase.id ?? '?'}" title="${(phase.title || '当前步骤').replace(/"/g, "'")}" />`,
    `  <allowed>${allowed.join(',')}</allowed>`,
    `  <forbidden>${[...forbidden].join(',')}</forbidden>`,
    `  <reason>当前步骤为${desc}，请优先使用 allowed 中的工具</reason>`,
    '</tool_constraint>',
  ];

  return lines.join('\n');
}

/**
 * 快捷方法：直接从任务计划 phase 对象构建约束注入块（含换行前缀）。
 *
 * @param {{ id?: string|number, title?: string, allowedTools?: string[] }} phase
 * @returns {string} 带 '\n\n' 前缀的完整约束块，无约束时返回空字符串
 */
export function buildConstraintInjection(phase) {
  const block = buildToolConstraintBlock(phase);
  return block ? '\n\n' + block : '';
}
