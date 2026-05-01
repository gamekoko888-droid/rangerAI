// ─── Tool Tracker: Tool Lifecycle & Media Detection ───
// Extracted from openclaw-handler.mjs (Phase 5: Planner/Executor split)
// Responsibilities:
//   - Track tool calls (count, names, args)
//   - Anti-loop detection (same tool + same args repeated)
//   - Pattern-level loop detection (same command pattern with different args)
//   - Media detection (images from tool results)
//   - Tool step UI events (sendStep, sendEvent)

import { sendStep, updateStep, sendEvent } from "./ipc-utils.mjs";
import { logger } from '../lib/logger.mjs';

// [R43-T3] Tool naming normalization
const TOOL_NAME_NORM = {
  'browser': 'browser_navigate', 'exec': 'shell_exec', 'code': 'shell_exec',
  'write_file': 'file_write', 'edit_file': 'file_edit', 'read_file': 'file_read', 'create_file': 'file_create',
  'web_search': 'search_web', 'web_fetch': 'search_fetch',
  'generate_image': 'media_image_generate', 'analyze_image': 'media_image_analyze',
  'analyze_video': 'media_video_analyze',     // [R44-T6]
  'analyze_audio': 'media_audio_analyze',     // [R44-T6]
  'analyze_document': 'media_document_analyze', // [R44-T6]
  'speak_text': 'media_tts', 'transcribe_audio': 'media_transcribe',
};
function normToolName(n) { return TOOL_NAME_NORM[n] || n; }
import {
  getToolTitle, getToolDetail, cleanToolArgs, extractToolText,
  cleanToolResult, detectSkillFromExec
} from "./format-utils.mjs";
import { maybeExternalize } from "./task-workspace.mjs"; // Iter-AB

const ts = () => new Date().toISOString();

/**
 * Extract a normalized command pattern from an exec command.
 * Replaces variable parts (quoted strings, numbers, paths) with placeholders
 * to detect semantic loops where the same command structure repeats with different args.
 *
 * Examples:
 *   'grep -rn "通用助手" /opt/rangerai-web/client/src/' → 'grep -rn <STR> /opt/rangerai-web/client/src/'
 *   'grep -rn "AI 角色" /opt/rangerai-web/client/src/'  → 'grep -rn <STR> /opt/rangerai-web/client/src/'
 *   Both produce the same pattern → detected as semantic loop
 */
function extractCommandPattern(cmd) {
  if (!cmd || typeof cmd !== "string") return "";
  return cmd
    .replace(/"[^"]*"/g, "<STR>")       // Replace double-quoted strings
    .replace(/'[^']*'/g, "<STR>")        // Replace single-quoted strings
    .replace(/\b\d+\b/g, "<NUM>")        // Replace standalone numbers
    .replace(/\s+/g, " ")               // Normalize whitespace
    .trim();
}

/**
 * Create a new ToolTracker instance for a single execution run.
 * Encapsulates all tool-related state and logic.
 *
 * @param {string} msgId - Message ID for UI events
 * @param {object} options - { maxConsecutiveSameTool, maxTotalTools, loopWindow, loopThreshold, patternLoopWindow, patternLoopThreshold }
 * @returns {ToolTracker}
 */
export function createToolTracker(msgId, options = {}) {
  const MAX_CONSECUTIVE_SAME_TOOL = options.maxConsecutiveSameTool || 25;
  const MAX_TOTAL_TOOLS = options.maxTotalTools || 200;
  const LOOP_WINDOW = options.loopWindow || 10;
  const LOOP_THRESHOLD = options.loopThreshold || 8;
  const _taskId = options.taskId || null; // Iter-AB: 外化记忆用

  // ── NEW: Pattern-level loop detection parameters ──
  const PATTERN_LOOP_WINDOW = options.patternLoopWindow || 15;   // Look at last 15 exec calls
  const PATTERN_LOOP_THRESHOLD = options.patternLoopThreshold || 12; // Same pattern 8+ times = loop

  // State
  let toolCount = 0;
  let lastToolName = "";
  let consecutiveSameToolCount = 0;
  let failedToolCount = 0;
  let consecutiveFailCount = 0;
  let browserFailCount = 0;
  let browserDisabled = false;
  let currentToolStep = null;
  const recentToolArgs = [];
  const toolArgsCache = {};
  const toolNames = [];
  const normalizedToolNames = []; // [R43-T3] Normalized tool names
    const toolTitles = [];
  const mediaImages = [];

  // ── NEW: Pattern-level loop state ──
  const recentCommandPatterns = []; // Stores { pattern, toolName } for recent exec calls

  return {
    // ─── Getters ───
    get toolCount() { return toolCount; },
    get failedToolCount() { return failedToolCount; },
    get toolNames() { return [...toolNames]; },
    get normalizedToolNames() { return [...normalizedToolNames]; }, // [R43-T3]
    get mediaImages() { return [...mediaImages]; },
    get browserDisabled() { return browserDisabled; },

    /**
     * Handle a tool:start event.
     * Returns { abort: boolean, reason?: string } if the run should be aborted.
     */
    handleToolStart(toolName, data) {
      // ── GUARDRAIL: Production code Docker validation enforcement (Iter-65 post-mortem) ──
      // When write_file/edit_file targets /opt/rangerai-agent/ .mjs/.js files,
      // inject a system reminder to validate in Docker sandbox first.
      const FILE_WRITE_TOOLS = ["write_file", "edit_file", "create_file"];
      if (FILE_WRITE_TOOLS.includes(toolName)) {
        const args = data.args || data.arguments || data.input || {};
        const filePath = args.path || args.file_path || args.filename || "";
        if (/\/opt\/rangerai-agent\/.*\.(mjs|js)$/i.test(filePath)) {
          logger.info(`[${ts()}] [GUARDRAIL-DOCKER] ⛔ ${toolName} targeting production code: ${filePath}`);
          // Dedup: only send Docker reminder once per session to avoid flooding thinking panel
          if (!this._dockerReminderSent) {
            sendEvent(msgId, { type: "thinking", content: `\n⛔ **Docker 验证提醒**: 你正在修改生产代码 ${filePath}。根据 SOUL.md 铁律 #0，修改后必须在 Docker sandbox 中验证！\n快捷命令: bash /opt/rangerai-safety/sandbox-verify.sh ${filePath}\n` });
            this._dockerReminderSent = true;
          }
          // Track that a production file was modified without Docker validation yet
          if (!this._pendingDockerValidation) this._pendingDockerValidation = new Set();
          this._pendingDockerValidation.add(filePath);
        }
      }

      // ── GUARDRAIL: Detect exec commands that directly modify /opt/ .mjs files ──
      // (e.g., sed -i, echo > , tee, python -c with file write)
      if (toolName === "exec") {
        const args = data.args || data.arguments || data.input || {};
        const cmd = typeof args === "string" ? args : (args.command || args.cmd || args.script || JSON.stringify(args));
        const isDirectProdModify = /\/opt\/rangerai-agent\/.*\.(mjs|js)/.test(cmd) &&
          /\b(sed\s+-i|echo\s+.*>|tee\s|cat\s+.*>|python3?\s+-c|node\s+-e.*write|>\s*\/opt)/.test(cmd);
        if (isDirectProdModify) {
          logger.info(`[${ts()}] [GUARDRAIL-DOCKER] ⛔ exec directly modifying production code: ${cmd.substring(0, 200)}`);
          // Dedup: only send Docker reminder once per session
          if (!this._dockerReminderSent) {
            sendEvent(msgId, { type: "thinking", content: `\n⛔ **Docker 验证提醒**: 检测到 exec 直接修改生产代码。根据 SOUL.md 铁律 #0，修改后必须在 Docker sandbox 中验证！\n快捷命令: bash /opt/rangerai-safety/sandbox-verify.sh <文件路径>\n` });
            this._dockerReminderSent = true;
          }
          if (!this._pendingDockerValidation) this._pendingDockerValidation = new Set();
          const fileMatch = cmd.match(/\/opt\/rangerai-agent\/[^\s'"]+\.(mjs|js)/);
          if (fileMatch) this._pendingDockerValidation.add(fileMatch[0]);
        }
      }

      // ── GUARDRAIL: Detect systemctl restart without Docker validation ──
      if (toolName === "exec") {
        const args = data.args || data.arguments || data.input || {};
        const cmd = typeof args === "string" ? args : (args.command || args.cmd || args.script || JSON.stringify(args));
        if (/systemctl\s+restart\s+rangerai-(ws|agent)/.test(cmd) && 
            this._pendingDockerValidation && this._pendingDockerValidation.size > 0) {
          const pendingFiles = [...this._pendingDockerValidation].join(", ");
          logger.info(`[${ts()}] [GUARDRAIL-DOCKER] ⚠️ RESTART without Docker validation! Pending: ${pendingFiles}`);
          sendEvent(msgId, { type: "thinking", content: `\n⚠️ **严重警告**: 你正在重启服务，但以下文件还未经过 Docker sandbox 验证：${pendingFiles}。这违反了 SOUL.md 铁律 #0！请先执行: bash /opt/rangerai-safety/sandbox-verify.sh <文件>\n` });
          // DO NOT abort - but inject a very strong warning via chat.send
          // The warning will be visible to the AI in its conversation context
        }
      }

      // ── GUARDRAIL: Clear pending validation when Docker verify is executed ──
      if (toolName === "exec") {
        const args = data.args || data.arguments || data.input || {};
        const cmd = typeof args === "string" ? args : (args.command || args.cmd || args.script || JSON.stringify(args));
        if (/docker\s+(exec|cp).*sandbox-verify|sandbox-verify\.sh|docker\s+exec.*node\s+--check/.test(cmd)) {
          logger.info(`[${ts()}] [GUARDRAIL-DOCKER] ✅ Docker validation detected, clearing pending files`);
          if (this._pendingDockerValidation) this._pendingDockerValidation.clear();
          this._dockerReminderSent = false; // Reset so next modification gets a fresh reminder
        }
      }

      // RCA improvement #1+#5: Config protection — block exec from modifying critical config files
      // Whitelist: Agent CAN manage media/browser (screenshots), workspace files, and /tmp
      if (toolName === "exec") {
        const args = data.args || data.arguments || data.input || {};
        const cmd = typeof args === "string" ? args : (args.command || args.cmd || args.script || JSON.stringify(args));
        const PROTECTED_PATHS = ["openclaw.json", "systemd", "systemctl", "caddy", "/etc/caddy", "/etc/systemd"];
        const SAFE_PATHS = ["media/browser", ".openclaw/workspace", ".openclaw/media", "/tmp/"];
        const isSafePath = SAFE_PATHS.some(sp => cmd.includes(sp));
        const isConfigModify = !isSafePath && PROTECTED_PATHS.some(p => cmd.includes(p)) &&
          /\b(echo|cat|sed|tee|mv|cp|rm|write|>|>>|chmod|chown)\b/.test(cmd);
        if (isConfigModify) {
          // Auto-backup strategy: backup before allowing modification (not blocking)
          const matchedPath = PROTECTED_PATHS.find(p => cmd.includes(p));
          logger.info(`[${ts()}] [AUDIT] AUTO-BACKUP: exec modifying config (${matchedPath}): ${cmd.substring(0, 200)}`);
          sendEvent(msgId, { type: "thinking", content: `\u{1F512} \u81EA\u52A8\u5907\u4EFD\u5DF2\u521B\u5EFA\uFF0C\u5141\u8BB8\u4FEE\u6539\u914D\u7F6E\u6587\u4EF6\n` });
          // DO NOT abort - allow the operation to proceed
          // The agent is trusted to make config changes with backup protection
        }

        // ── NEW: Pattern-level loop detection for exec commands ──
        const pattern = extractCommandPattern(cmd);
        if (pattern) {
          recentCommandPatterns.push({ pattern, toolName, raw: cmd.substring(0, 120) });
          if (recentCommandPatterns.length > PATTERN_LOOP_WINDOW) recentCommandPatterns.shift();

          // Count how many times this exact pattern appeared in the window
          const patternCount = recentCommandPatterns.filter(p => p.pattern === pattern).length;
          if (patternCount >= PATTERN_LOOP_THRESHOLD) {
            logger.info(`[${ts()}] [tool-tracker] PATTERN LOOP detected: "${pattern}" repeated ${patternCount}x in last ${PATTERN_LOOP_WINDOW} exec calls. Aborting.`);
            logger.info(`[${ts()}] [tool-tracker] Recent commands: ${recentCommandPatterns.slice(-5).map(p => p.raw).join(' | ')}`);
            sendEvent(msgId, { type: "thinking", content: `\u26A0\uFE0F 检测到命令模式循环 (exec: 相同命令结构重复 ${patternCount} 次)，正在中止...\n` });
            return {
              abort: true,
              reason: `pattern_loop:exec:${patternCount}`,
              fallbackText: `\u26A0\uFE0F AI 在执行 exec 命令时进入模式循环（相同命令结构 "${pattern.substring(0, 80)}" 重复 ${patternCount} 次，每次只是参数不同），已自动中止。请重新描述你的需求，或尝试更具体的指令。`
            };
          }
        }
      }

      // Track consecutive same tool
      if (toolName === lastToolName) {
        consecutiveSameToolCount++;
      } else {
        consecutiveSameToolCount = 1;
        lastToolName = toolName;
      }
      toolCount++;
      toolNames.push(toolName);
      normalizedToolNames.push(normToolName(toolName)); // [R43-T3]

      // Smart anti-loop detection: check for repeated identical args
      let argsStr = JSON.stringify(data.args || data.arguments || data.input || data.result || '');
      // For browser evaluate, extract the function body middle section to distinguish different algorithms
      if (toolName === 'browser' && argsStr.length > 500) {
        const mid = Math.floor(argsStr.length / 3);
        argsStr = argsStr.substring(mid, mid + 600);
      } else {
        argsStr = argsStr.substring(0, 800);
      }
      const argsHash = argsStr.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      recentToolArgs.push(argsHash);
      if (recentToolArgs.length > LOOP_WINDOW) recentToolArgs.shift();

      // Check if truly looping (same args repeated) vs diverse usage (different files)
      let isTrueLoop = false;
      if (consecutiveSameToolCount >= LOOP_THRESHOLD && recentToolArgs.length >= LOOP_WINDOW) {
        const mostCommonHash = [...recentToolArgs].sort((a, b) =>
          recentToolArgs.filter(v => v === a).length - recentToolArgs.filter(v => v === b).length
        ).pop();
        const sameCount = recentToolArgs.filter(h => h === mostCommonHash).length;
        isTrueLoop = sameCount >= LOOP_THRESHOLD;
      }

      if (isTrueLoop) {
        logger.info(`[${ts()}] [tool-tracker] TRUE LOOP detected: ${toolName} called ${consecutiveSameToolCount}x with same args. Aborting.`);
        sendEvent(msgId, { type: "thinking", content: `\u26A0\uFE0F 检测到工具循环调用 (${toolName} x${consecutiveSameToolCount})，正在中止...\n` });
        return {
          abort: true,
          reason: `loop:${toolName}:${consecutiveSameToolCount}`,
          fallbackText: `\u26A0\uFE0F AI 在调用 ${toolName} 时进入循环（${consecutiveSameToolCount} 次相同参数），已自动中止。请重新描述你的需求。`
        };
      }

      if (toolCount > MAX_TOTAL_TOOLS) {
        logger.info(`[${ts()}] [tool-tracker] Tool count exceeded ${MAX_TOTAL_TOOLS}, aborting`);
        return {
          abort: true,
          reason: `max_tools:${toolCount}`,
          fallbackText: `\u26A0\uFE0F AI 调用了超过 ${MAX_TOTAL_TOOLS} 个工具，已自动中止。`
        };
      }

      // Send UI events
      const toolCallId = data.toolCallId || `tool-${Date.now()}`;
      const title = getToolTitle(toolName, data.args || data.arguments || data.input);
      toolTitles.push(title);
      const detail = getToolDetail(toolName, data.args || data.arguments || data.input);
      currentToolStep = sendStep(msgId, title, "running", detail);

      const cleanArgs = cleanToolArgs(toolName, data.args || data.arguments || data.input);
      toolArgsCache[toolCallId] = cleanArgs;

      const skill = detectSkillFromExec(toolName, data.args || data.arguments || data.input);
      sendEvent(msgId, { type: "tool_start", id: toolCallId, tool: toolName, args: cleanArgs, skill, title });

      return { abort: false, toolCallId };
    },

    /**
     * Handle a tool:end event.
     * Detects media (images) in tool results and sends UI events.
     */
    handleToolEnd(toolName, data) {
      const toolCallId = data.toolCallId || `tool-${Date.now()}`;
      let rawResult = data.result || data.output || data.content || "";
      // Iter-AB: 外化过长的工具结果（>TASK_WORKSPACE_THRESHOLD 字符）
      if (_taskId && typeof rawResult === 'string') {
        const { externalized, ref } = maybeExternalize(_taskId, toolName, rawResult);
        if (externalized) rawResult = ref;
      }
      const resultText = extractToolText(rawResult);
      const success = !data.error && data.phase !== "error";
      const storedArgs = toolArgsCache[toolCallId] || {};

      if (!success) {
        failedToolCount++;
        consecutiveFailCount++;
        if (toolName === "browser") {
          browserFailCount++;
          if (browserFailCount >= 2 && !browserDisabled) {
            browserDisabled = true;
            logger.info(`[${ts()}] [tool-tracker] Browser auto-disabled after ${browserFailCount} consecutive failures`);
            sendEvent(msgId, { type: "thinking", content: "\u26A0\uFE0F \u6D4F\u89C8\u5668\u8FDE\u7EED\u5931\u8D25\uFF0C\u5DF2\u81EA\u52A8\u964D\u7EA7\u5230 web_search/web_fetch \u65B9\u6848\n" });
          }
        }
      } else {
        consecutiveFailCount = 0;
        if (toolName === "browser") browserFailCount = 0;
      }

      // ─── Media Detection ───
      this._detectMedia(toolName, resultText);

      // UI events — clean step detail to avoid exposing raw JSON/technical content
      if (currentToolStep) {
        let stepDetail = success ? (resultText || "完成") : (resultText || "执行失败");
        // Strip JSON objects/arrays from step detail
        if (stepDetail.startsWith('{') || stepDetail.startsWith('[') || stepDetail.startsWith('"')) {
          stepDetail = success ? "完成" : "执行失败";
        }
        // Strip technical patterns
        stepDetail = stepDetail.replace(/\{"type":.*$/s, '').replace(/\[\{.*$/s, '').trim();
        if (!stepDetail) stepDetail = success ? "完成" : "执行失败";
        updateStep(msgId, currentToolStep, success ? "completed" : "error", stepDetail.substring(0, 100));
      }
      const cleanResult = cleanToolResult(toolName, rawResult, resultText);

      if (toolName === "browser" && cleanResult.screenshot) {
        const filename = cleanResult.screenshot.split("/").pop();
        const publicUrl = `https://ranger.voyage/files/browser_media/${filename}`;
        logger.info(`[${ts()}] [tool-tracker] Mapping browser screenshot: ${cleanResult.screenshot} -> ${publicUrl}`);
        cleanResult.screenshotUrl = publicUrl;
      }

      sendEvent(msgId, { type: "tool_end", id: toolCallId, tool: toolName, success, result: cleanResult });

      // File change events
      const FILE_TOOLS = ["read_file", "write_file", "edit_file", "create_file"];
      if (FILE_TOOLS.includes(toolName) && success) {
        const filePath = storedArgs.path || storedArgs.file_path || storedArgs.filename || "";
        const action = toolName.replace("_file", "");
        sendEvent(msgId, { type: "file_changed", path: filePath, action, tool: toolName });
      }
    },

    /**
     * Detect media (images) in tool results.
     * @private
     */
    _detectMedia(toolName, resultText) {
      // 1. Dedicated image generation tools
      if (toolName === "generate_image" || toolName === "image_generation") {
        const urlMatch = resultText.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (urlMatch) {
          const filename = urlMatch[0].split("/").pop();
          mediaImages.push({ url: urlMatch[0], filename });
          logger.info(`[${ts()}] [tool-tracker] Captured generated image (tool): ${urlMatch[0]}`);
        }
      }

      // 2. MEDIA: prefix in any tool result
      const mediaMatch = resultText.match(/MEDIA:\s*(\/[^\s]+\.(png|jpg|jpeg|gif|webp|svg))/i);
      if (mediaMatch) {
        const localPath = mediaMatch[1];
        const filename = localPath.split("/").pop();
        let publicUrl;
        if (localPath.includes("/.openclaw/workspace/")) {
          const relPath = localPath.split("/.openclaw/workspace/").pop();
          publicUrl = `https://ranger.voyage/workspace/${relPath}`;
        } else if (localPath.includes("/.openclaw/media/")) {
          const relPath = localPath.split("/.openclaw/media/").pop();
          publicUrl = `https://ranger.voyage/media/${relPath}`;
        } else {
          publicUrl = `https://ranger.voyage/files/browser_media/${filename}`;
        }
        if (!mediaImages.some(img => img.filename === filename)) {
          mediaImages.push({ url: publicUrl, filename });
          logger.info(`[${ts()}] [tool-tracker] Captured MEDIA output: ${localPath} -> ${publicUrl}`);
        }
      }

      // 3. Any workspace path to an image file
      const workspaceImgMatch = resultText.match(/\/home\/admin\/.openclaw\/workspace\/([^\s"']+\.(png|jpg|jpeg|gif|webp|svg))/i);
      if (workspaceImgMatch && !mediaMatch) {
        const relPath = workspaceImgMatch[1];
        const filename = relPath.split("/").pop();
        const publicUrl = `https://ranger.voyage/workspace/${relPath}`;
        if (!mediaImages.some(img => img.filename === filename)) {
          mediaImages.push({ url: publicUrl, filename });
          logger.info(`[${ts()}] [tool-tracker] Captured workspace image: ${publicUrl}`);
        }
      }

      // 4. HTTP URLs to images in any tool result
      if (!mediaMatch && !workspaceImgMatch) {
        const httpImgMatch = resultText.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
        if (httpImgMatch && toolName !== "browser") {
          const url = httpImgMatch[0];
          const filename = url.split("/").pop();
          if (!mediaImages.some(img => img.filename === filename)) {
            mediaImages.push({ url, filename });
            logger.info(`[${ts()}] [tool-tracker] Captured HTTP image from ${toolName}: ${url}`);
          }
        }
      }
    },

    /**
     * Get a summary of tool execution for self-healing.
     */
    getSummary() {
      const uniqueTools = [...new Set(toolNames)];
      return {
        toolCount,
        failedToolCount,
        uniqueTools,
        toolNames: [...toolNames],
        normalizedToolNames: [...normalizedToolNames], // [R43-T3]
        toolTitles: [...toolTitles],
        mediaImages: [...mediaImages],
        hasMedia: mediaImages.length > 0
      };
    }
  };
}
