// ─── Tool Output Summarizer ───
// [R28-T2] Intelligent tool output summarization
// Reduces long exec/web_fetch outputs to ≤2000 chars while preserving key info
// Uses heuristic extraction (no LLM call) to keep latency near-zero

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

// Maximum output size after summarization
const SUMMARIZE_THRESHOLD = 3000;  // Only summarize if > 3000 chars
const TARGET_MAX_CHARS = 2000;     // Target output size

// Error/warning patterns to always preserve
const ERROR_PATTERNS = [
  /error[:\s]/i,
  /ERR[!:\s]/,
  /failed/i,
  /exception/i,
  /traceback/i,
  /WARN[:\s]/i,
  /warning[:\s]/i,
  /fatal/i,
  /panic/i,
  /ENOENT|EACCES|EPERM|ECONNREFUSED/,
  /Permission denied/i,
  /No such file/i,
  /command not found/i,
  /syntax error/i,
  /TypeError|ReferenceError|SyntaxError/,
  /exit code [1-9]/i,
  /non-zero exit/i,
];

// Noise patterns to strip entirely
const NOISE_PATTERNS = [
  /^\s*$/,                          // Empty lines
  /^[\s│├└─┌┐┘┤┬┴┼]+$/,          // Box drawing chars only
  /^={3,}$/,                        // Separator lines
  /^-{3,}$/,
  /^\+{3,}$/,
  /^~{3,}$/,
  /^\s*\d+\s+\d+\s+\d+\s*$/,     // Pure numeric columns (ls -la sizes)
  /^total \d+$/,                    // ls total line
  /^\s*#.*$/,                       // Comment-only lines
];

// Key info patterns to prioritize
const KEY_PATTERNS = [
  /^\s*\{/,                         // JSON start
  /^\s*\[/,                         // Array start
  /status[:\s]/i,
  /result[:\s]/i,
  /output[:\s]/i,
  /success/i,
  /complete/i,
  /version[:\s]/i,
  /HTTP\/\d/,                       // HTTP status lines
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, // IP addresses
  /port\s*[:=]\s*\d+/i,
  /pid\s*[:=]\s*\d+/i,
  /active\s*\(running\)/i,         // systemctl status
];

/**
 * Summarize long tool output to ≤ TARGET_MAX_CHARS
 * Strategy: head + errors + key lines + tail
 * @param {string} toolName - Name of the tool (exec, web_fetch, etc.)
 * @param {string} output - Raw tool output
 * @returns {{ summarized: boolean, output: string, originalLength: number }}
 */
export function summarizeToolOutput(toolName, output) {
  if (!output || typeof output !== 'string') {
    return { summarized: false, output: output || '', originalLength: 0 };
  }

  const originalLength = output.length;

  // Don't summarize short outputs
  if (originalLength <= SUMMARIZE_THRESHOLD) {
    return { summarized: false, output, originalLength };
  }

  const lines = output.split('\n');
  const totalLines = lines.length;

  // Classify lines
  const errorLines = [];
  const keyLines = [];
  const normalLines = [];

  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip noise
    if (NOISE_PATTERNS.some(p => p.test(trimmed))) continue;

    // Categorize
    if (ERROR_PATTERNS.some(p => p.test(line))) {
      errorLines.push({ idx: i, line });
    } else if (KEY_PATTERNS.some(p => p.test(line))) {
      keyLines.push({ idx: i, line });
    } else {
      normalLines.push({ idx: i, line });
    }
  }

  // Budget allocation
  const headBudget = Math.floor(TARGET_MAX_CHARS * 0.30);  // 600 chars for head
  const errorBudget = Math.floor(TARGET_MAX_CHARS * 0.30); // 600 chars for errors
  const keyBudget = Math.floor(TARGET_MAX_CHARS * 0.20);   // 400 chars for key info
  const tailBudget = Math.floor(TARGET_MAX_CHARS * 0.20);  // 400 chars for tail

  // Extract head (first N lines within budget)
  let headText = '';
  let headCount = 0;
  for (const { line } of [...errorLines, ...keyLines, ...normalLines].sort((a, b) => a.idx - b.idx)) {
    if (headText.length + line.length + 1 > headBudget) break;
    headText += line + '\n';
    headCount++;
  }

  // Extract error lines within budget
  let errorText = '';
  let errorCount = 0;
  for (const { line } of errorLines) {
    if (errorText.length + line.length + 1 > errorBudget) break;
    errorText += line + '\n';
    errorCount++;
  }

  // Extract key lines within budget (not already in head)
  let keyText = '';
  let keyCount = 0;
  for (const { idx, line } of keyLines) {
    if (idx < headCount) continue; // Already in head
    if (keyText.length + line.length + 1 > keyBudget) break;
    keyText += line + '\n';
    keyCount++;
  }

  // Extract tail (last N lines within budget)
  let tailText = '';
  const reversedAll = [...errorLines, ...keyLines, ...normalLines].sort((a, b) => b.idx - a.idx);
  for (const { line } of reversedAll) {
    if (tailText.length + line.length + 1 > tailBudget) break;
    tailText = line + '\n' + tailText;
  }

  // Compose summarized output
  const omittedChars = originalLength - headText.length - errorText.length - keyText.length - tailText.length;
  const parts = [headText.trim()];

  if (errorText.trim()) {
    parts.push(`--- errors/warnings (${errorCount}/${errorLines.length}) ---\n${errorText.trim()}\n--- end errors ---`);
  }

  if (keyText.trim()) {
    parts.push(`--- key info ---\n${keyText.trim()}\n--- end key info ---`);
  }

  parts.push(`[... ${omittedChars > 0 ? omittedChars : 0} chars omitted from ${totalLines} lines ...]`);
  parts.push(tailText.trim());

  const summarized = parts.join('\n\n');

  logger.info(`[${ts()}] [R28-T2] Summarized ${toolName}: ${originalLength}→${summarized.length} chars (${totalLines} lines, ${errorLines.length} errors, ${keyLines.length} key)`);

  return {
    summarized: true,
    output: summarized,
    originalLength,
    summarizedLength: summarized.length,
    stats: { totalLines, errorCount: errorLines.length, keyCount: keyLines.length },
  };
}

/**
 * Enhanced processToolOutput that applies summarization after trimming
 * @param {string} toolName
 * @param {string} output - Already trimmed by context-window-manager
 * @returns {string} Final output ≤ TARGET_MAX_CHARS
 */
export function postProcessToolOutput(toolName, output) {
  if (!output || typeof output !== 'string') return output;

  // Only apply to exec and web_fetch (highest volume tools)
  if (toolName !== 'exec' && toolName !== 'web_fetch' && toolName !== 'browser') {
    return output;
  }

  const result = summarizeToolOutput(toolName, output);
  if (result.summarized) {
    logger.info(`[${ts()}] [R28-T2] truncated ${toolName}: ${result.originalLength}→${result.summarizedLength} chars`);
  }
  return result.output;
}
