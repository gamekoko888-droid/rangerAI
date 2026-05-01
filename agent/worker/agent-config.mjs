// ─── Agent Configuration Constants ───
// Extracted from openclaw-handler.mjs for centralized config management

// Long Output Auto-Document
export const LONG_OUTPUT_THRESHOLD = 8000; // chars - auto-save as file when exceeded
export const WORKSPACE_DIR = "/home/admin/.openclaw/workspace";
export const WORKSPACE_URL = "https://ranger.voyage/workspace";

// API Rate Limiting
export const MIN_API_INTERVAL_MS = 2000; // Minimum 2 seconds between chat.send calls

// Progress Guardrail
export const CONSECUTIVE_TOOL_NO_TEXT_THRESHOLD = 15; // Soft reminder after N consecutive tool calls without text
export const CONSECUTIVE_TOOL_NO_TEXT_HARD_LIMIT = 30; // Hard reminder after N consecutive tool calls without text

// Timeout Defaults
export const DEFAULT_TIMEOUT_MS = 600000;  // 10 min inactivity timeout (was 60min — too long for stuck tasks)
export const TOOL_TIMEOUT_MS = 1800000;    // 30 min timeout when tools are actively running (was 90min)

// Tool Count Guardrails
export const TOOL_COUNT_WARN = 60;
export const TOOL_COUNT_CRITICAL = 100;
export const TOOL_COUNT_HARD_LIMIT = 120;
// Single Tool Timeout
export const _RAW_SINGLE_TOOL_MAX_MS = 120000;   // 120s max per individual tool execution
export const _RAW_SINGLE_TOOL_HARD_MS = 180000;  // 180s hard limit — abort if tool still running
// [R44-T4] DEBUG_TIMEOUT_MS override for testing tool_timeout events
const _debugMs = parseInt(process.env.DEBUG_TIMEOUT_MS, 10);
export const SINGLE_TOOL_MAX_MS = _debugMs > 0 ? _debugMs : _RAW_SINGLE_TOOL_MAX_MS;
export const SINGLE_TOOL_HARD_MS = _debugMs > 0 ? _debugMs * 2 : _RAW_SINGLE_TOOL_HARD_MS;
if (_debugMs > 0) console.log('[R44-T4] DEBUG_TIMEOUT_MS active: soft=' + SINGLE_TOOL_MAX_MS + 'ms hard=' + SINGLE_TOOL_HARD_MS + 'ms');

// [R45-T3] Quality scoring sample rate (0.0 - 1.0, default 0.2 = 20%)
const QUALITY_SCORE_SAMPLE_RATE = parseFloat(process.env.QUALITY_SCORE_SAMPLE_RATE || '0.2');
export { QUALITY_SCORE_SAMPLE_RATE };

// ─── Iter-C: AutoCompact Prompt ───
export const AUTOCOMPACT_PROMPT = `你是一个对话历史压缩器。将以下对话历史压缩为结构化摘要。

**输出格式（严格遵守）**：
【任务目标】用户最初的任务需求，一句话概括
【已完成】已经完成的工作，列出关键步骤和结果
【产物】所有产出的文件路径、URL、代码片段引用（必须完整保留路径，不可省略）
【待处理】尚未完成的任务项
【关键上下文】后续执行需要知道的关键信息（配置、密码、端口、变量名等）

**铁律**：
1. 所有文件路径必须完整保留，不可缩写或省略
2. 所有 URL 必须完整保留
3. 不要包含对话的具体措辞，只保留信息
4. 压缩完成后继续执行待处理任务，不要向用户提问
5. 输出必须是中文`;

// ─── [R77-T1] Iter-C: Compression Thresholds (R57-T1遗漏修复：对齐context-compressor)
// 7天压缩仅7次 → 根因：agent-config阈值未随R57-T1同步降低
export const MICRO_COMPACT_THRESHOLD = 0.50;  // Usage ratio to trigger microCompact (was 0.75)
export const AUTO_COMPACT_THRESHOLD = 0.65;   // Usage ratio to trigger autoCompact (was 0.90)

// ─── [Cost-R1-TaskA] Message-count-based compression thresholds ───
// 解决"普通对话远未到 token 上限但已积累大量历史"的成本黑洞
// 补充 token-ratio 方案：超过消息数也触发压缩，避免历史无限增长
export const MICRO_COMPACT_MSG_THRESHOLD = 20;  // >= 20 条消息 → microCompact (was 30)
export const AUTO_COMPACT_MSG_THRESHOLD  = 35;  // >= 35 条消息 → autoCompact (was 60)
