// ─── Supervisor Bridge (v17.0) ───────────────────────────────────
// Bridges ordinary chat messages to Supervisor multi-step execution.
// When intent-classifier detects a "deep_task", this module:
//   1. Creates a Supervisor task in DB
//   2. Runs the Supervisor tick loop inside the Worker process
//   3. Each step is executed via handleViaOpenClaw (Gateway)
//   4. Progress is pushed to frontend via sendEvent/IPC
//   5. Final result is returned to the caller (handleUserMessage)
//
// This avoids IPC cross-process communication — everything runs in the
// current Worker process, reusing the existing Gateway WS connection.

import crypto from "crypto";
import { sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { handleViaOpenClaw } from "./openclaw-handler.mjs";
import { sanitizeForFrontend } from "./format-utils.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();
const PREFIX = "[supervisor-bridge]";

// ─── Deep Task Detection ─────────────────────────────────────────
// Determines if a message should be routed to Supervisor instead of
// single-shot Gateway. Called AFTER intent-classifier returns "task".

const DEEP_TASK_PATTERNS = [
  // Multi-step explicit requests
  /帮我.{2,30}然后.{2,30}/,
  /先.{2,20}再.{2,20}/,
  /第一步.{2,}第二步/,
  // Complex creation tasks
  /写一个.{2,30}(页面|网页|网站|h5|H5|app|应用|系统|平台|工具)/,
  /做一个.{2,30}(页面|网页|网站|h5|H5|app|应用|系统|平台|工具|报告|分析|方案)/,
  /开发一个.{2,30}/,
  /搭建.{2,30}/,
  /构建.{2,30}/,
  /设计.{2,30}(方案|系统|架构|流程)/,
  /实现.{2,30}(功能|系统|模块)/,
  // Research + analysis compound tasks
  /调研.{2,30}(并|然后|再).{2,30}/,
  /搜索.{2,30}(并|然后|再).{2,30}(分析|总结|对比|报告)/,
  /分析.{2,30}(并|然后|再).{2,30}(总结|报告|建议)/,
  // Report generation
  /写.{0,10}(报告|分析报告|调研报告|竞品分析|市场分析)/,
  /生成.{0,10}(报告|分析|方案|计划)/,
  // System operations
  /检查.{2,30}(并|然后|如果).{2,30}/,
  /部署.{2,30}(到|并).{2,30}/,
  // Data operations
  /导入.{2,30}(数据|文件).{0,20}(并|然后)/,
  /爬取.{2,30}(数据|信息|内容)/,
  /批量.{2,30}/,
];

// Keywords that strongly suggest multi-step execution
const DEEP_TASK_KEYWORDS = [
  "写一个", "做一个", "开发一个", "搭建", "构建",
  "帮我写", "帮我做", "帮我开发", "帮我搭建",
  "全面分析", "深度分析", "详细调研", "竞品分析",
  "市场调研", "写报告", "做报告", "生成报告",
  "批量处理", "自动化", "爬取",
  "build a", "create a", "develop a", "write a",
  "research and", "analyze and", "search and summarize",
];

// Short messages that look like tasks but should stay single-shot
const SHALLOW_TASK_PATTERNS = [
  /^(翻译|解释|总结|概括|简述|列出|列举).{0,100}$/,
  /^(什么是|怎么|如何|为什么).{0,100}$/,
  /^.{0,20}(是什么|怎么样|好不好|对不对|可以吗).{0,10}$/,
];

/**
 * Detect if a message is a "deep task" that benefits from Supervisor multi-step execution.
 * @param {string} message - The user's message (cleaned of knowledge context)
 * @param {object} intentResult - Result from intent-classifier { intent, confidence, reason }
 * @param {object} routing - Result from smart-router { taskType, ... }
 * @returns {{ isDeepTask: boolean, reason: string, confidence: number }}
 */
export function detectDeepTask(message, intentResult, routing) {
  // Only consider messages already classified as "task" by intent-classifier
  if (!intentResult || intentResult.intent !== "task") {
    return { isDeepTask: false, reason: "Not classified as task", confidence: 0 };
  }

  // Strip knowledge context for clean analysis
  const clean = message
    .replace(/\[KNOWLEDGE_CONTEXT\][\s\S]*?\[\/KNOWLEDGE_CONTEXT\]/g, "")
    .replace(/<knowledge_reference>[\s\S]*?<\/knowledge_reference>/g, "")
    .replace(/<user_memory>[\s\S]*?<\/user_memory>/g, "")
    .trim();

  // Short messages are never deep tasks
  if (clean.length < 15) {
    return { isDeepTask: false, reason: "Message too short", confidence: 0.9 };
  }

  // Check shallow task exclusions first
  for (const pattern of SHALLOW_TASK_PATTERNS) {
    if (pattern.test(clean)) {
      return { isDeepTask: false, reason: "Shallow task pattern", confidence: 0.8 };
    }
  }

  // Check deep task patterns
  for (const pattern of DEEP_TASK_PATTERNS) {
    if (pattern.test(clean)) {
      return { isDeepTask: true, reason: `Pattern match: ${pattern.source.substring(0, 40)}`, confidence: 0.85 };
    }
  }

  // Check deep task keywords
  const lowerClean = clean.toLowerCase();
  for (const kw of DEEP_TASK_KEYWORDS) {
    if (lowerClean.includes(kw.toLowerCase())) {
      return { isDeepTask: true, reason: `Keyword: "${kw}"`, confidence: 0.8 };
    }
  }

  // Long task messages (>100 chars) with task intent are likely deep
  if (clean.length > 100 && intentResult.confidence >= 0.8) {
    return { isDeepTask: true, reason: "Long task message with high confidence", confidence: 0.7 };
  }

  return { isDeepTask: false, reason: "No deep task indicators", confidence: 0.6 };
}

// ─── Supervisor Bridge Execution ─────────────────────────────────

/**
 * Execute a user message through the Supervisor multi-step engine.
 * This runs entirely within the Worker process.
 *
 * @param {object} params
 * @param {string} params.msgId - Message ID for frontend event routing
 * @param {string} params.userMessage - The user's original message
 * @param {string} params.sessionKey - Gateway session key
 * @param {object} params.gateway - Gateway connector instance
 * @param {object} params.routing - Smart router decision
 * @param {string} params.roleSystemPrompt - Role system prompt
 * @param {object} params.browserBreaker - Browser circuit breaker
 * @param {string} [params.userId] - User ID
 * @param {string} [params.chatId] - Chat ID
 * @returns {Promise<string>} - Final result text
 */
export async function executeSupervisorBridge({
  msgId,
  userMessage,
  sessionKey,
  gateway,
  routing,
  roleSystemPrompt,
  browserBreaker,
  userId,
  chatId,
}) {
  logger.info(`${PREFIX} Starting Supervisor bridge for msgId=${msgId}`);

  // Lazy import supervisor-engine to avoid circular dependencies
  const { createTask, runTask } = await import("./supervisor-engine.mjs");

  // ── Step 1: Notify frontend that Supervisor mode is active ──
  sendEvent(msgId, {
    type: "supervisor_mode",
    active: true,
    message: "正在规划多步骤执行方案...",
  });

  const supervisorStepId = sendStep(msgId, "Supervisor 任务规划", "running", "分析任务复杂度");

  // ── Step 2: Create Supervisor task (with planning progress events) ──
  const taskTitle = userMessage.length > 50
    ? userMessage.substring(0, 50) + "..."
    : userMessage;

  // Emit planning_start so frontend can show animated planning phase
  sendEvent(msgId, {
    type: "supervisor_progress",
    eventType: "planning_start",
    goal: userMessage,
    title: taskTitle,
  });

  let svTaskId;
  try {
    svTaskId = await createTask({
      chatId: chatId || null,
      userId: userId || "worker",
      sessionKey: `chat_sv_${sessionKey}`,
      title: taskTitle,
      goal: userMessage,
      metadata: { trigger: "chat_bridge", msgId, routing: routing?.taskType },
      trigger: "chat",
      onPlanProgress: (phase) => {
        // Forward planning progress to frontend
        sendEvent(msgId, {
          type: "supervisor_progress",
          eventType: "planning_progress",
          phase,
        });
      },
    });
    logger.info(`${PREFIX} Created Supervisor task: ${svTaskId}`);
    updateStep(msgId, supervisorStepId, "completed", `任务 ${svTaskId}`);
  } catch (err) {
    logger.error(`${PREFIX} Failed to create Supervisor task: ${err.message}`);
    updateStep(msgId, supervisorStepId, "error", err.message);
    sendEvent(msgId, { type: "supervisor_mode", active: false });
    throw new Error(`Supervisor task creation failed: ${err.message}`);
  }

  // ── Step 3: Define executeStep — each step goes through Gateway ──
  // Use a dedicated session for each step to avoid polluting the main chat session
  let _prevStepResult = null;
  const executeStep = async (instruction) => {
    const stepMsgId = `sv-step-${svTaskId}-${Date.now()}`;
    const stepSessionKey = `sv_exec_${svTaskId}_${Date.now().toString(36)}`;

    // Build context from previous step result
    let contextualInstruction = instruction;
    if (_prevStepResult) {
      const prevSnippet = _prevStepResult.length > 2000
        ? _prevStepResult.substring(0, 2000) + "\n...(截断)"
        : _prevStepResult;
      contextualInstruction = `上一步结果：\n${prevSnippet}\n\n当前步骤指令：\n${instruction}`;
    }

    // Tool phase hints (same logic as ws-realtime.mjs supervisor)
    const toolPhaseHints = (() => {
      const hints = [];
      const inst = instruction.toLowerCase();
      if (/exec|命令|shell|系统|服务器|磁盘|内存|cpu|进程|端口/.test(inst)) {
        hints.push("\n## 当前步骤推荐工具：exec\n使用 exec 工具执行 Shell 命令。");
      }
      if (/搜索|search|查找|最新|新闻|news|了解|调研|市场|竞品|趋势/.test(inst)) {
        hints.push("\n## 当前步骤推荐工具：web_search\n使用 web_search 工具进行信息检索。");
      }
      if (/文件|读取|写入|read|write|cat|保存|save/.test(inst)) {
        hints.push("\n## 当前步骤推荐工具：read/write\n使用 read 或 write 工具进行文件操作。");
      }
      if (/网页|浏览器|browser|visit|url|http|链接/.test(inst)) {
        hints.push("\n## 当前步骤推荐工具：browser/web_fetch\n使用 browser 或 web_fetch 工具访问网页。");
      }
      if (/api|接口|数据库|查询数据|业务数据|内部/.test(inst)) {
        hints.push("\n## 当前步骤推荐工具：exec (curl)\n使用 exec 工具执行 curl 命令调用内部 API。");
      }
      if (/分析|总结|汇总|报告|analyze|summary|report/.test(inst)) {
        hints.push("\n## 当前步骤推荐：综合分析\n基于前一步结果直接进行分析。");
      }
      hints.push("\n\n⚠️ 必须通过工具获取真实数据，禁止凭记忆输出");
      return hints.join("");
    })();

    const stepSystemPrompt = `你是 RangerAI 的执行代理（SubAgent），负责执行任务主管分配的单个步骤。
## 核心规则
1. **只完成当前指令**，不要规划额外步骤
2. **必须使用工具获取真实数据**——绝对禁止编造、猜测或凭记忆回答需要实时数据的问题
3. 执行完成后，简洁报告结果
${toolPhaseHints}
## 输出格式
- 直接输出工具执行的真实结果
- 如果工具执行失败，报告错误信息
- 保持简洁，不要添加不必要的解释`;

    try {
      // Create a temporary session for this step (only 'key' is valid for sessions.create)
      const fullSessionKey = `agent:main:${stepSessionKey}`;
      try {
        await gateway.request("sessions.create", { key: fullSessionKey });
        logger.info(`${PREFIX} Step session created: ${fullSessionKey}`);
      } catch (createErr) {
        logger.info(`${PREFIX} Step session create note: ${createErr.message}`);
        // If create fails, try reset to ensure clean state
        try {
          await gateway.request("sessions.reset", { key: fullSessionKey });
          logger.info(`${PREFIX} Step session reset fallback succeeded`);
        } catch (_) { /* best effort */ }
      }

      const reply = await handleViaOpenClaw(
        contextualInstruction,
        stepSessionKey,
        stepMsgId,
        {
          timeout: 300000, // 5 min per step
          thinking: "standard",
          roleSystemPrompt: stepSystemPrompt,
        },
        { gateway, browserBreaker }
      );

      const resultStr = typeof reply === "string"
        ? reply
        : (reply?.text || reply?.content || JSON.stringify(reply));

      _prevStepResult = resultStr;

      // Clean up step session
      try {
        await gateway.request("sessions.delete", { key: `agent:main:${stepSessionKey}` });
      } catch (_) { /* best effort */ }

      return { result: resultStr };
    } catch (err) {
      return { error: err.message };
    }
  };

  // ── Step 4: Define onProgress — push events to frontend via IPC ──
  const stepIdMap = new Map(); // stepNum → stepId for updateStep
  const onProgress = (taskId, event) => {
    logger.info(`${PREFIX} Progress: ${taskId} ${event.type} step=${event.stepNum || "-"}`);

    switch (event.type) {
      case "task_start":
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: "task_start",
          title: event.title,
          goal: event.goal,
          plan: event.plan,
        });
        break;

      case "supervisor_thinking":
        sendEvent(msgId, {
          type: "thinking",
          content: `\n🧠 Supervisor 正在规划第 ${event.stepNum} 步...\n`,
        });
        break;

      case "step_start": {
        // S16: Include totalSteps for accurate progress display (e.g., "Step 3/9")
        const stepLabel = event.totalSteps
          ? `步骤 ${event.stepNum}/${event.totalSteps}: ${event.instruction || "执行中"}`
          : `步骤 ${event.stepNum}: ${event.instruction || "执行中"}`;
        const sid = sendStep(
          msgId,
          stepLabel,
          "running",
          event.isRetry ? "重试" : ""
        );
        stepIdMap.set(event.stepNum, sid);
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: "step_start",
          stepNum: event.stepNum,
          totalSteps: event.totalSteps || null,
          instruction: event.instruction,
          isRetry: event.isRetry,
        });
        break;
      }

      case "step_complete": {
        const sid = stepIdMap.get(event.stepNum);
        if (sid) {
          updateStep(msgId, sid, "completed", `${event.duration || 0}ms`);
        }
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: "step_complete",
          stepNum: event.stepNum,
          duration: event.duration,
        });
        break;
      }

      case "step_failed": {
        const sid = stepIdMap.get(event.stepNum);
        if (sid) {
          updateStep(msgId, sid, "error", event.error?.substring(0, 100));
        }
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: "step_failed",
          stepNum: event.stepNum,
          error: event.error,
        });
        break;
      }

      case "plan_update":
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: "plan_update",
          plan: event.plan,
        });
        break;

      case "task_complete":
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: "task_complete",
          status: "completed",
        });
        break;

      case "task_error":
      case "task_timeout":
      case "task_retry_exhausted":
        sendEvent(msgId, {
          type: "supervisor_progress",
          svTaskId,
          eventType: event.type,
          status: "failed",
          reason: event.reason || event.error || "Unknown error",
        });
        break;
    }
  };

  // ── Step 5: Run Supervisor tick loop ──
  try {
    const result = await runTask({
      taskId: svTaskId,
      executeStep,
      onProgress,
    });

    logger.info(`${PREFIX} Supervisor task ${svTaskId} completed: status=${result.status}`);

    // Notify frontend that Supervisor mode is done
    sendEvent(msgId, {
      type: "supervisor_mode",
      active: false,
      status: result.status,
    });

    // Format the final result
    if (result.status === "completed" && result.result) {
      // Try to extract meaningful text from JSON result
      let finalText = result.result;
      try {
        if (finalText.trim().startsWith("{") || finalText.trim().startsWith("[")) {
          const parsed = JSON.parse(finalText);
          if (parsed.reply) finalText = parsed.reply;
          else if (parsed.content) finalText = parsed.content;
          else if (parsed.text) finalText = parsed.text;
          else if (parsed.answer) finalText = parsed.answer;
        }
      } catch (_) { /* not JSON, use as-is */ }

      return sanitizeForFrontend(finalText);
    } else if (result.status === "failed") {
      return `⚠️ **任务执行失败**\n\n${result.error || "未知错误"}\n\n${result.result ? `已完成的部分：\n${result.result}` : ""}`;
    } else if (result.status === "timeout") {
      return `⏱️ **任务超时**\n\n已执行的步骤结果：\n${result.result || "无"}`;
    } else if (result.status === "cancelled") {
      return `🚫 **任务已取消**`;
    } else {
      return result.result || "任务完成，但没有返回结果。";
    }
  } catch (err) {
    logger.error(`${PREFIX} Supervisor bridge execution failed: ${err.message}`);
    sendEvent(msgId, { type: "supervisor_mode", active: false });
    throw err;
  }
}
