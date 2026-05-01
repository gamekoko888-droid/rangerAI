// ─── Stream Processor: Gateway Event Stream Handling ───
// Extracted from openclaw-handler.mjs (Phase 5: Planner/Executor split)
// Responsibilities:
//   - Process Gateway SSE events (agent, chat)
//   - Accumulate text from stream deltas
//   - Detect lifecycle events (end, error)
//   - Handle chat:final with gateway-injected filtering (v3.4)
//   - Truncation detection
//   - **NEW** Filter technical artifacts from stream deltas (v2)

import { sendEvent } from "./ipc-utils.mjs";
import { rewriteWorkspacePaths } from "./format-utils.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

// ─── Truncation Detection ───
// Checks if text ends cleanly (valid sentence-ending character)
// Fix P2-1 (2026-03-18): Previous version had endsCleanly matching almost everything
// (CJK chars, all digits, dashes, etc.), causing !endsCleanly to always be false.
// Now only real sentence-terminating characters count as "clean endings".
function detectTruncation(text) {
  if (!text || text.length <= 200) return false;
  // Strip trailing whitespace and Markdown formatting artifacts (but NOT content)
  const stripped = text.trim().replace(/[\s*_~`>]+$/g, "").trim();
  if (stripped.length === 0) return false;
  
  // ─── Layer 1: Structural completeness checks ───
  // Unfinished code blocks (odd number of ```)
  const codeBlockCount = (stripped.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    logger.info(`[${ts()}] [detectTruncation] Unclosed code block detected (${codeBlockCount} backtick groups)`);
    return true;
  }
  
  // Unfinished numbered/bulleted list: last item starts with number/bullet but has no content
  const textLines = stripped.split('\n');
  const lastLine = textLines[textLines.length - 1].trim();
  if (/^(\d+\.|[-*\u2022])\s*$/.test(lastLine)) {
    logger.info(`[${ts()}] [detectTruncation] Empty list item at end: "${lastLine}"`);
    return true;
  }
  
  // Unfinished bold: has opening ** without closing
  if (/\*\*[^*]{2,}$/.test(lastLine) && !/\*\*\s*$/.test(lastLine)) {
    logger.info(`[${ts()}] [detectTruncation] Unclosed bold marker at end`);
    return true;
  }
  
  // ─── Layer 2: Character-level ending check (original logic, enhanced) ───
  const lastChar = stripped.slice(-1);
  const cc = lastChar.charCodeAt(0);
  const endsCleanly =
    // English sentence terminators
    ".!?".includes(lastChar) ||
    // Chinese sentence terminators
    cc === 0x3002 /* \u3002 */ || cc === 0xFF01 /* \uFF01 */ || cc === 0xFF1F /* \uFF1F */ ||
    // Ellipsis (valid completion signal)
    cc === 0x2026 /* \u2026 */ ||
    // Closing brackets/quotes that end a complete structure
    "])}>".includes(lastChar) ||
    cc === 0x300B /* \u300B */ || cc === 0x3011 /* \u3011 */ ||
    cc === 0x300D /* \u300D */ || cc === 0x300F /* \u300F */ ||
    cc === 0xFF09 /* \uFF09 */ ||
    // Closing quote marks
    cc === 0x201D /* \u201D */ || cc === 0x2019 /* \u2019 */ ||
    // Markdown horizontal rule
    /---\s*$/.test(stripped);
  
  if (!endsCleanly) {
    logger.info(`[${ts()}] [detectTruncation] Text does not end cleanly (lastChar: "${lastChar}", code: ${cc})`);
    return true;
  }
  
  // ─── Layer 3: Content coherence check ───
  // Detect "started a section but didn't finish" patterns near end
  const last200 = stripped.slice(-200);
  if (/(?:\u4ee5\u4e0b\u662f|\u63a5\u4e0b\u6765|\u9996\u5148|\u7b2c\u4e00\u6b65|\u6b65\u9aa4[\u4e00\u4e8c\u4e09\u56db\u4e941234])[^\u3002\uFF01\uFF1F.!?]*$/.test(last200) && stripped.length < 500) {
    logger.info(`[${ts()}] [detectTruncation] Incomplete section opener detected near end`);
    return true;
  }
  
  return false;
}


/**
 * Clean heartbeat artifacts from text.
 */
function cleanHeartbeat(text) {
  // Fix: Only remove heartbeat/noreply tokens, NOT all | characters.
  // The previous .replace(/\|/g, "") was destroying Markdown tables.
  // Regex note: NO_REPLY? means "NO_REPL" + optional "Y" — use word boundary instead.
  // causing code block lines to merge (e.g., "left = ...\nmiddle = ..." → "left = ...middle = ...")
  const cleaned = text.replace(/\bHEARTBEAT_OK\b|\bHEARTBEAT\b|\bNO_REPLY\b/g, "");
  // Only return empty string if the entire delta was just heartbeat tokens
  return cleaned.replace(/^\s+$/, "") || cleaned;
}

// ─── Stream Delta Filter (v2) ───────────────────────────────
// Filters technical content that AI models (especially Claude) sometimes
// "echo back" into their text output stream. These should only appear in
// tool_start/tool_end events, not in the user-visible text.
//
// This is a STATEFUL filter that accumulates partial lines across delta chunks
// because a single "line" may arrive split across multiple deltas.

// ─── v25.7: Session-level plan JSON detection state ───
// Tracks which sessions have previously produced plan JSON output,
// so subsequent runs in the same session can detect partial fragments faster.
const _sessionPlanHistory = new Map(); // sessionKey → { lastSeenAt, count, patterns }
const SESSION_PLAN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getSessionPlanState(sessionKey) {
  if (!sessionKey) return null;
  const state = _sessionPlanHistory.get(sessionKey);
  if (!state) return null;
  // TTL check
  if (Date.now() - state.lastSeenAt > SESSION_PLAN_TTL_MS) {
    _sessionPlanHistory.delete(sessionKey);
    return null;
  }
  return state;
}

function recordSessionPlanDetection(sessionKey, charsSuppressed) {
  if (!sessionKey) return;
  const existing = _sessionPlanHistory.get(sessionKey);
  if (existing) {
    existing.count++;
    existing.lastSeenAt = Date.now();
    existing.totalCharsSuppressed += charsSuppressed;
  } else {
    _sessionPlanHistory.set(sessionKey, {
      count: 1,
      lastSeenAt: Date.now(),
      totalCharsSuppressed: charsSuppressed,
    });
  }
  // Periodic cleanup: remove expired entries
  if (_sessionPlanHistory.size > 100) {
    const now = Date.now();
    for (const [key, val] of _sessionPlanHistory) {
      if (now - val.lastSeenAt > SESSION_PLAN_TTL_MS) {
        _sessionPlanHistory.delete(key);
      }
    }
  }
  logger.info(`[${ts()}] [stream-filter-v25.7] Session plan state updated: session=${sessionKey}, count=${_sessionPlanHistory.get(sessionKey)?.count}, totalSuppressed=${_sessionPlanHistory.get(sessionKey)?.totalCharsSuppressed}`);
}

function createStreamFilter(sessionKey) {
  // Reason: v3's pendingBuffer + line-level filtering caused massive Chinese content loss
  // (code snippets, filenames, backticks mixed with Chinese triggered false positives)
  
  const SYSTEM_PATTERNS = [
    /^\[SYSTEM_DIRECTIVE\]/,
    /^\[SYSTEM_FORCE\]/,
    /^\[HIDDEN\]/,
    /^\[non-text content:.*\]/i,
    /^Assistant:\s*\[non-text content/i,
  ];
  
  function filter(delta) {
    if (!delta) return "";
    
    // If delta contains newlines, check each line for system directives
    if (delta.includes("\n")) {
      const lines = delta.split("\n");
      const cleanLines = [];
      for (const line of lines) {
        const trimmed = line.trim();
        let isSystem = false;
        for (const pat of SYSTEM_PATTERNS) {
          if (pat.test(trimmed)) {
            isSystem = true;
            logger.info(`[${ts()}] [stream-filter-v4] Filtered system line: "${trimmed.substring(0, 60)}"`);
            break;
          }
        }
        if (!isSystem) {
          cleanLines.push(line);
        }
      }
      return cleanLines.join("\n");
    }
    
    // Single-line delta (no newline): check if it starts with system directive
    const trimmed = delta.trim();
    for (const pat of SYSTEM_PATTERNS) {
      if (pat.test(trimmed)) {
        logger.info(`[${ts()}] [stream-filter-v4] Filtered system content: "${trimmed.substring(0, 60)}"`);
        return "";
      }
    }
    
    // Normal content passes through directly
    return delta;
  }
  
  // Plan JSON format: [{"stepNum":1,"text":"...","status":"pending"},...]
  let planJsonBuffer = "";
  let planJsonDetecting = false;
  let planJsonSuppressed = false;
  
  // These detect partial/tail fragments that start mid-JSON (cross-run leakage)
  const PLAN_FRAGMENT_PATTERNS = [
    /"\s*,\s*"status"\s*:\s*"(?:pending|done|running|error)"/,  // tail of a step object
    /"stepNum"\s*:\s*\d+/,                                       // stepNum key anywhere
    /\{\s*"stepNum"/,                                             // start of step object
    /"\s*,\s*"text"\s*:\s*"[^"]*"\s*,\s*"status"/,             // middle of step object
  ];
  
  function looksLikePlanFragment(text) {
    return PLAN_FRAGMENT_PATTERNS.some(p => p.test(text));
  }

  function filterWithPlanDetection(delta) {
    if (!delta) return "";
    
    // If we already determined this stream contains plan JSON, suppress all subsequent deltas
    if (planJsonSuppressed) {
      planJsonBuffer += delta;
      logger.info(`[${ts()}] [stream-filter-v25.7] Suppressing plan JSON delta (${delta.length} chars), buffer=${planJsonBuffer.length}`);
      return "";
    }
    
    // use more aggressive detection (lower buffer threshold, wider pattern matching)
    const sessionState = getSessionPlanState(sessionKey);
    const isHighRiskSession = sessionState && sessionState.count >= 1;
    
    // Check if this looks like the start of a plan JSON array
    if (!planJsonDetecting && planJsonBuffer === "") {
      const trimmed = (planJsonBuffer + delta).trimStart();
      
      // Standard detection: starts with [{"stepNum"
      if (trimmed.startsWith('[{"stepNum"') || trimmed.startsWith('[{\"stepNum\"')) {
        planJsonDetecting = true;
        planJsonBuffer = delta;
        logger.info(`[${ts()}] [stream-filter-v25.7] Detected plan JSON start (standard), buffering`);
        return "";
      }
      
      // These are tail/middle fragments from cross-run leakage
      if (isHighRiskSession && looksLikePlanFragment(trimmed)) {
        planJsonDetecting = true;
        planJsonBuffer = delta;
        logger.info(`[${ts()}] [stream-filter-v25.7] Detected plan JSON fragment (high-risk session, prev=${sessionState.count}), buffering`);
        return "";
      }
    }
    
    // If we're in detection mode, keep buffering
    if (planJsonDetecting) {
      planJsonBuffer += delta;
      
      // Check if buffer looks like valid plan JSON (has stepNum and status fields)
      if (planJsonBuffer.includes('"status"') && planJsonBuffer.includes('"stepNum"')) {
        planJsonSuppressed = true;
        recordSessionPlanDetection(sessionKey, planJsonBuffer.length);
        logger.info(`[${ts()}] [stream-filter-v25.7] Confirmed plan JSON — suppressing entire stream (${planJsonBuffer.length} chars)`);
        return "";
      }
      
      if (isHighRiskSession && looksLikePlanFragment(planJsonBuffer)) {
        // Wait a bit more to be sure, but with lower threshold
        if (planJsonBuffer.length > 80) {
          planJsonSuppressed = true;
          recordSessionPlanDetection(sessionKey, planJsonBuffer.length);
          logger.info(`[${ts()}] [stream-filter-v25.7] Confirmed plan fragment (high-risk, ${planJsonBuffer.length} chars) — suppressing`);
          return "";
        }
        return ""; // Keep buffering
      }
      
      // If buffer grows too large without matching, it's not plan JSON — flush it
      const maxBuffer = isHighRiskSession ? 300 : 200;
      if (planJsonBuffer.length > maxBuffer) {
        planJsonDetecting = false;
        const buffered = planJsonBuffer;
        planJsonBuffer = "";
        logger.info(`[${ts()}] [stream-filter-v25.7] Not plan JSON after ${buffered.length} chars, flushing buffer`);
        return filter(buffered);
      }
      return "";
    }
    
    // Normal filtering
    return filter(delta);
  }
  
  function flushWithPlan() {
    // If we were buffering but never confirmed plan JSON, flush the buffer
    if (planJsonDetecting && !planJsonSuppressed && planJsonBuffer) {
      // the complete buffer might be a plan fragment
      if (looksLikePlanFragment(planJsonBuffer) && planJsonBuffer.length > 50) {
        logger.info(`[${ts()}] [stream-filter-v25.7] Flush: late-detected plan fragment (${planJsonBuffer.length} chars), suppressing`);
        recordSessionPlanDetection(sessionKey, planJsonBuffer.length);
        planJsonBuffer = "";
        planJsonDetecting = false;
        return "";
      }
      const buffered = planJsonBuffer;
      planJsonBuffer = "";
      planJsonDetecting = false;
      return filter(buffered);
    }
    if (planJsonSuppressed) {
      logger.info(`[${ts()}] [stream-filter-v25.7] Flush: plan JSON was suppressed (${planJsonBuffer.length} chars total)`);
      planJsonBuffer = "";
      return "";
    }
    return "";
  }
  
  return { filter: filterWithPlanDetection, flush: flushWithPlan };
}


/**
 * Extract text from chat:final message content (handles both array and string formats).
 */
function extractFinalText(content) {
  let finalText = "";
  if (typeof content === "string") {
    finalText = content;
  } else if (Array.isArray(content)) {
    const textParts = content.filter(c => c.type === "text").map(c => c.text);
    if (textParts.length > 0) {
      finalText = textParts.join("\n");
    }
  }
  if (finalText) {
    finalText = cleanHeartbeat(finalText);
    // Remove code block wrapping if the entire response is wrapped in ```
    const codeBlockMatch = finalText.match(/^```[\s\S]*?\n([\s\S]+?)\n```\s*$/);
    if (codeBlockMatch) {
      logger.info(`[${ts()}] [stream-processor] Unwrapping code-block-wrapped reply`);
      finalText = codeBlockMatch[1].trim();
    }
  }
  return finalText;
}

/**
 * Clean the final full text — removes any technical artifacts that
 * slipped through the stream filter (belt-and-suspenders approach).
 */
function cleanFinalText(text) {
  if (!text) return text;
  let clean = text;
  // Pattern: entire text is a JSON array of plan steps [{stepNum:...,text:...,status:...}]
  const trimmed = clean.trim();
  if (trimmed.startsWith('[{') && trimmed.endsWith('}]')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].stepNum !== undefined && parsed[0].text !== undefined) {
        logger.info(`[${ts()}] [stream-processor] [v25.4] cleanFinalText: Detected plan JSON (${parsed.length} steps), replacing with empty string`);
        return "";
      }
    } catch(e) { /* not valid JSON, continue normal cleaning */ }
  }
  // These handle cross-run scenarios where only tail/middle fragments arrive
  // Layer 1: Complete plan JSON arrays embedded within other text
  clean = clean.replace(/\[\s*\{\s*"stepNum"[\s\S]*?\}\s*\]/g, '');
  // Layer 2: Plan JSON tail fragments (cross-run leakage)
  // e.g. '息（触发周期、检查项、告警阈值）并交付确认","status":"pending"}]'
  clean = clean.replace(/[^\[]*?"\s*,\s*"status"\s*:\s*"(?:pending|done|running|error)"\s*\}\s*\]\s*$/g, '');
  // Layer 3: Fragments containing stepNum JSON key-value patterns
  clean = clean.replace(/\{\s*"stepNum"\s*:\s*\d+\s*,\s*"text"\s*:\s*"[^"]*"\s*,\s*"status"\s*:\s*"[^"]*"\s*\}/g, '');
  // Layer 4: Trailing JSON structure with status field (partial object end)
  clean = clean.replace(/,?\s*"status"\s*:\s*"(?:pending|done|running|error)"\s*\}\s*\]\s*$/g, '');
  // Layer 5: Detect any remaining plan-like JSON fragments with stepNum
  // Only strip if it looks like orphaned JSON (not part of natural text)
  clean = clean.replace(/"stepNum"\s*:\s*\d+/g, '');
  // Layer 6: Clean up orphaned JSON brackets/commas left after removals
  clean = clean.replace(/^[\s,]*\}\s*\]\s*$/gm, '');
  clean = clean.replace(/^[\s,]*"status"\s*:\s*"(?:pending|done|running|error)"[\s,}\]]*$/gm, '');
  if (clean !== text) {
    logger.info(`[${ts()}] [stream-processor] [v25.6] cleanFinalText: Removed plan JSON fragments (${text.length} -> ${clean.length} chars)`);
  }

  // Remove [non-text content: ...] markers
  clean = clean.replace(/\[non-text content:[^\]]*\]/gi, "");
  clean = clean.replace(/Assistant:\s*\[non-text content:[^\]]*\]/gi, "");

  // Remove "Tool result (xxx): ..." lines
  clean = clean.replace(/^Tool result\s*\([^)]*\):.*$/gm, "");

  // Remove system directive echoes
  clean = clean.replace(/^\[SYSTEM_DIRECTIVE\].*$/gm, "");
  clean = clean.replace(/^\[SYSTEM_FORCE\].*$/gm, "");
  clean = clean.replace(/^\[HIDDEN\].*$/gm, "");

  // Remove compilation error echoes
  clean = clean.replace(/^src\/.*:\s*error\s+TS\d+:.*$/gm, "");
  clean = clean.replace(/^Command failed with exit code \d+\.?\s*$/gm, "");
  clean = clean.replace(/^ELIFECYCLE.*$/gm, "");

  // Remove shell prompt echoes
  clean = clean.replace(/^(?:ubuntu|admin|root)@\S+.*$/gm, "");
  clean = clean.replace(/^\$\s+.*$/gm, "");

  // Clean up excessive blank lines left by removals
  clean = clean.replace(/\n{3,}/g, "\n\n");

  // Remove heartbeat artifacts (HEARTBEAT_OK, NOHEARTBEAT_OK, standalone NO)
  // These can appear anywhere in the text from phantom agentic turn concatenation
  clean = clean.replace(/\bNO\s*HEARTBEAT_OK\b|\bHEARTBEAT_OK\b|\bNOHEARTBEAT_OK\b/gi, "");
  // Remove standalone "NO" only when it appears as a complete word on its own line or as the entire text
  clean = clean.replace(/^NO$/gm, "");
  // Clean up any blank lines created by the removals above
  clean = clean.replace(/\n{3,}/g, "\n\n");

  // [R51-FIX] Korean text detection: if response is predominantly Korean (>60% Korean chars)
  // but contains no Chinese characters, it's likely a model hallucination.
  // Add a warning prefix so the user knows, while avoiding short phrases and duplicate warnings.
  const cleanTrimmed = clean.trim();
  const KOREAN_HALLUCINATION_WARNING = "> ⚠️ 模型输出了韩语内容，可能是幻觉。请重新提问或切换模型。";
  if (cleanTrimmed.length > 20 && !cleanTrimmed.startsWith(KOREAN_HALLUCINATION_WARNING)) {
    const koreanChars = (cleanTrimmed.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
    const chineseChars = (cleanTrimmed.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
    const totalChars = cleanTrimmed.length;
    const koreanRatio = koreanChars / totalChars;
    if (koreanChars >= 12 && koreanRatio > 0.6 && chineseChars < 5) {
      logger.info(`[${ts()}] [stream-processor] [R51-FIX] Korean text detected: ${koreanChars} Korean chars (${(koreanRatio * 100).toFixed(1)}%), ${chineseChars} Chinese chars in ${totalChars} total`);
      clean = `${KOREAN_HALLUCINATION_WARNING}\n\n${clean}`;
    }
  }

  return clean.trim();
}

/**
 * Append media images to text if not already referenced.
 */
function appendMediaToText(text, mediaImages) {
  if (mediaImages.length === 0) return text;

  // Clean MEDIA-only replies
  const trimmedText = text.trim();
  if (/^MEDIA(:\s*\/[^\s]*)?$/i.test(trimmedText) || trimmedText === "") {
    text = "";
    logger.info(`[${ts()}] [stream-processor] Cleaned MEDIA-only reply, will show images directly`);
  }
  // Clean inline MEDIA: /path references (workspace and media paths)
  text = text.replace(/MEDIA:\s*\/home\/admin\/.openclaw\/(workspace|media)\/[^\s]+/gi, "").trim();

  for (const img of mediaImages) {
    const hasMarkdownRef = text.includes(img.url) || (text.includes(`![`) && text.includes(img.filename));
    if (!hasMarkdownRef) {
      text += `\n\n![${img.filename}](${img.url})`;
      logger.info(`[${ts()}] [stream-processor] Auto-appended image to reply: ${img.url}`);
    }
  }
  return text;
}

export { detectTruncation, cleanHeartbeat, extractFinalText, appendMediaToText, createStreamFilter, cleanFinalText, getSessionPlanState, _sessionPlanHistory };
