// ─── RangerAI Intent Classifier ──────────────────────────────────
// LLM-based intent pre-classification module.
// Runs BEFORE smart-router's keyword-based classifyTask to determine
// whether a user message is a simple conversational question (chat)
// or an actionable task requiring tools.
//
// Architecture:
//   User Message → intent-classifier (LLM, <2s) → smart-router (keyword scoring)
//                                                    ↓
//                                        chat → Direct LLM reply (no tools)
//                                        task → Gateway (with tools)
//
// Uses Gateway local API (http://127.0.0.1:18789/v1) with a lightweight model.
// Falls back to regex heuristics if LLM call fails or times out.
// ──────────────────────────────────────────────────────────────────

import { logger } from '../lib/logger.mjs';
import { readFileSync } from 'fs';
import http from 'http';

// ─── Configuration ───────────────────────────────────────────────
const CLASSIFIER_TIMEOUT_MS = 3000;  // 3s hard timeout for LLM call
const CLASSIFIER_MODEL = "openclaw";  // Must use openclaw for Gateway
const GATEWAY_BASE_URL = "http://127.0.0.1:18789/v1";

// Load Gateway token
let _gwToken = "";
try { _gwToken = readFileSync("/home/admin/.openclaw/gateway.token", "utf-8").trim(); } catch(e) { /* v22.0 */ logger.error("[intent-classifier] silent catch:", e?.message || e); }
const GATEWAY_API_KEY = _gwToken || process.env.GATEWAY_API_KEY || "";

// ─── Classification Prompt ───────────────────────────────────────
const CLASSIFIER_SYSTEM_PROMPT = `你是一个用户意图分类器。你的唯一任务是判断用户消息的意图类别。

分类规则：
1. **chat** — 闲聊、知识问答、观点咨询、简单问题。用户只是想得到一个文字回答，不需要执行任何操作。
   例如："后端开发必须懂JAVA吗"、"山姆有哪些低热量又好吃的零食"、"React和Vue哪个好"、"你好"、"为什么天空是蓝色的"、"你的前端输出为什么这么不稳定"

2. **task** — 用户要求执行具体操作：写代码、部署、修改文件、创建内容、分析数据、搜索信息、翻译等。需要工具或多步骤执行。
   例如："帮我写一个Python脚本"、"部署到阿里云服务器"、"分析这份市场数据并给出竞品对比报告"、"翻译这篇文章成英文"、"帮我调研东南亚市场"

3. **continuation** — 用户要求继续上一个未完成的任务。
   例如："继续"、"接着做"、"continue"

判断要点：
- 如果用户只是在**提问**（为什么、是什么、有哪些、怎么样、好不好、推荐、建议），大概率是 chat
- 如果用户使用了**祈使句**或**动作词**（帮我、请写、做一个、部署、修改、创建、分析...数据、调研...市场），大概率是 task
- 如果消息包含**代码块**或**文件内容**，大概率是 task
- 如果消息是关于 AI 系统本身的元问题（为什么要工具调用、路由问题），是 chat
- 短消息且无明确动作指令 → chat

只输出 JSON，不要输出其他内容：
{"intent": "chat|task|continuation", "confidence": 0.0-1.0, "reason": "一句话理由"}`;

// ─── LLM Call (Non-streaming, via Gateway) ───────────────────────
function callLLMForClassification(userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLASSIFIER_MODEL,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userMessage.substring(0, 500) }  // Truncate to save tokens
      ],
      temperature: 0.1,
      max_tokens: 100,
      stream: false,
      response_format: { type: "json_object" }
    });

    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("Intent classifier timeout"));
    }, CLASSIFIER_TIMEOUT_MS);

    const req = http.request({
      hostname: "127.0.0.1",
      port: 18789,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GATEWAY_API_KEY}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Gateway HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || "";
          // Parse the JSON response
          const result = JSON.parse(content);
          resolve({
            intent: result.intent || "chat",
            confidence: result.confidence || 0.5,
            reason: result.reason || "LLM classification",
            source: "llm"
          });
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ─── Regex Fallback (fast, no LLM) ──────────────────────────────
function classifyByRegex(message) {
  const trimmed = message.replace(/\[KNOWLEDGE_CONTEXT\][\s\S]*?\[\/KNOWLEDGE_CONTEXT\]/g, "")
                         .replace(/<knowledge_reference>[\s\S]*?<\/knowledge_reference>/g, "")
                         .replace(/<user_memory>[\s\S]*?<\/user_memory>/g, "")
                         .trim();

  // Continuation patterns
  if (/^(继续|接着|接着做|继续执行|接着执行|请继续|continue|resume|go on|keep going)[。.！!？?\s]*$/i.test(trimmed)) {
    return { intent: "continuation", confidence: 0.95, reason: "Continuation keyword", source: "regex" };
  }

  // Very short messages without action verbs → chat
  if (trimmed.length < 10 && !/[`{}[\]()=<>]/.test(trimmed)) {
    return { intent: "chat", confidence: 0.9, reason: "Very short message", source: "regex" };
  }

  // Code blocks → task
  if (/```[\s\S]*```/.test(trimmed)) {
    return { intent: "task", confidence: 0.9, reason: "Contains code block", source: "regex" };
  }

  // Strong task indicators (imperative verbs + objects)
  const strongTaskPatterns = /(帮我|请.*写|请.*做|请.*改|请.*修|请.*查|请.*搜|请.*找|请.*读|请.*执行|请.*运行|请.*部署|请.*创建|请.*删除|请.*安装|写一个|做一个|改一下|修一下|开发一个|实现一个|搭建|构建|编写|调试|debug|fix|build|create|implement|deploy|write.*code|make.*script)/;
  if (strongTaskPatterns.test(trimmed)) {
    return { intent: "task", confidence: 0.85, reason: "Strong task indicator", source: "regex" };
  }

  // Task phrases with objects (分析+数据, 调研+市场, etc.)
  const taskPhrases = /(分析.*数据|分析.*报告|调研.*市场|调研.*竞品|翻译.*成|部署.*到|迁移.*到|备份.*到|给出.*报告|给出.*方案|写.*报告|做.*对比|做.*分析)/;
  if (taskPhrases.test(trimmed)) {
    return { intent: "task", confidence: 0.8, reason: "Task phrase with object", source: "regex" };
  }

  // Passive question patterns → chat
  const passivePatterns = /(为什么|为何|怎么|什么是|谁是|是什么|啥是|能不能|可以吗|有没有|有哪些|哪些|哪个好|推荐|建议|好不好|值不值|必须.{0,6}吗|应该.{0,6}吗|需要.{0,6}吗|要不要|懂.{0,4}吗|会.{0,4}吗|算.{0,4}吗|区别|差别|不同|一样吗|对吗|是吗|吗$)/;
  if (trimmed.length < 200 && passivePatterns.test(trimmed)) {
    return { intent: "chat", confidence: 0.8, reason: "Passive question pattern", source: "regex" };
  }

  // Default: ambiguous, let LLM decide or fallback to chat for short messages
  if (trimmed.length < 60) {
    return { intent: "chat", confidence: 0.5, reason: "Short ambiguous message", source: "regex" };
  }

  return { intent: "unknown", confidence: 0.3, reason: "No clear pattern", source: "regex" };
}

// ─── Main Classification Function ────────────────────────────────
// Strips injected knowledge context before classification.
// Tries LLM first, falls back to regex on failure/timeout.
export async function classifyIntent(rawMessage) {
  const startTime = Date.now();

  // Strip injected knowledge context — classify based on user's actual question only
  const cleanMessage = rawMessage
    .replace(/\[KNOWLEDGE_CONTEXT\][\s\S]*?\[\/KNOWLEDGE_CONTEXT\]/g, "")
    .replace(/<knowledge_reference>[\s\S]*?<\/knowledge_reference>/g, "")
    .replace(/<user_memory>[\s\S]*?<\/user_memory>/g, "")
    .trim();

  // Fast path: regex can handle obvious cases without LLM
  const regexResult = classifyByRegex(cleanMessage);
  if (regexResult.confidence >= 0.85) {
    const elapsed = Date.now() - startTime;
    logger.info(`[intent-classifier] FAST path: intent=${regexResult.intent} conf=${regexResult.confidence.toFixed(2)} reason="${regexResult.reason}" elapsed=${elapsed}ms`);
    return regexResult;
  }

  // Slow path: use LLM for ambiguous cases
  try {
    const llmResult = await callLLMForClassification(cleanMessage);
    const elapsed = Date.now() - startTime;
    logger.info(`[intent-classifier] LLM path: intent=${llmResult.intent} conf=${llmResult.confidence.toFixed(2)} reason="${llmResult.reason}" elapsed=${elapsed}ms`);
    return llmResult;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.warn(`[intent-classifier] LLM failed (${elapsed}ms): ${err.message}. Falling back to regex.`);
    // Use regex result even if low confidence
    return regexResult;
  }
}

// ─── Integration Helper ─────────────────────────────────────────
// Returns the routing override based on intent classification.
// If intent is "chat", returns { overrideType: "chat", skipPlan: true, skipTools: false }
// If intent is "task", returns null (let smart-router handle normally)
export function getRoutingOverride(intentResult) {
  if (!intentResult) return null;

  if (intentResult.intent === "chat") {
    return {
      overrideType: "chat",
      skipPlan: true,      // Don't generate task plan for chat
      skipWideResearch: true,  // Don't trigger wide research for chat
      reason: intentResult.reason
    };
  }

  if (intentResult.intent === "continuation") {
    return {
      overrideType: null,  // Let smart-router decide the type
      skipPlan: true,      // Don't generate new plan for continuation
      skipWideResearch: true,
      reason: "Continuation message"
    };
  }

  // intent === "task" or "unknown" → no override, let smart-router handle
  return null;
}

export { classifyByRegex };
