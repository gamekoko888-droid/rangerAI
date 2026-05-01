// ─── RangerAI LLM Pre-Classifier (v2.0) ─────────────────────────
// Uses GPT-5.4-mini to classify user messages into 10 task types.
//
// Architecture:
//   User Message → [strip context] → GPT-5.4-mini (non-streaming, <2s)
//                                        ↓
//                              { type, confidence, reason }
//                                        ↓
//                              smart-router uses this as primary signal
//                              keyword scoring as fallback if LLM fails
// ──────────────────────────────────────────────────────────────────
import { logger } from '../lib/logger.mjs';
import { readFileSync } from 'fs';
import https from 'https';

/**
 * Helper to strip markdown code fences from a JSON string.
 */
function stripMarkdownJson(text) {
  const match = text.match(/```(?:json|)\s*([\s\S]*?)\s*```/);
  return match ? match[1].trim() : text.trim();
}

// ─── Configuration ───────────────────────────────────────────────
const CLASSIFIER_TIMEOUT_MS = 5000;  // 5s hard timeout
const CLASSIFIER_MODEL = "gpt-5.4-mini";
const OPENAI_API_HOST = "api.openai.com";

// ─── OpenAI API Key ──────────────────────────────────────────────
let _cachedOpenAIKey = "";
function getOpenAIKey() {
  if (_cachedOpenAIKey) return _cachedOpenAIKey;
  if (process.env.OPENAI_API_KEY) {
    _cachedOpenAIKey = process.env.OPENAI_API_KEY;
    return _cachedOpenAIKey;
  }
  try {
    const cfg = JSON.parse(readFileSync("/home/admin/.openclaw/openclaw.json", "utf-8"));
    const key = cfg?.models?.providers?.openai?.apiKey;
    if (key) {
      _cachedOpenAIKey = key;
      return key;
    }
  } catch (e) { /* ignore */ }
  return "";
}

// ─── Context Stripping ───────────────────────────────────────────
function stripContext(raw) {
  let msg = raw;
  // Remove system context blocks
  msg = msg.replace(/\[SYSTEM CONTEXT\][\s\S]*?\[\/SYSTEM CONTEXT\]/g, "");
  msg = msg.replace(/\[CONTEXT\][\s\S]*?\[\/CONTEXT\]/g, "");
  // Remove metadata lines
  msg = msg.replace(/^(Session|User|Time|Context|History):.*$/gm, "");
  return msg.trim().substring(0, 500);  // Cap at 500 chars for speed
}

// ─── Classification Prompt ───────────────────────────────────────
const CLASSIFICATION_PROMPT = `You are a task classifier. Classify the user message into exactly ONE type.

Types:
- code: Writing, editing, debugging, reviewing, or explaining code/scripts/programs. ALSO includes "fix X bug", "解决X问题" about code/configs, "修改X功能", "实现X功能".
- reasoning: Pure logic puzzles, math proofs, abstract analysis WITH NO code/system action needed. NOT for "解决/修复/排查" technical issues.
- sysadmin: Server management, DevOps, Docker, systemd, Nginx, databases, deployments, network, logs, processes. Includes "排查", "检查", "解决", "验收", "审计", "核查", "巡检", "验证", "诊断" + server/infra/code topics. ANY task that requires checking actual server state, running commands, or verifying files on a server is sysadmin.
- chinese_content: Chinese writing, articles, copywriting, marketing content in Chinese
- research: Information lookup, fact-checking, summarization (no action/fix needed)
- creative: Creative writing, storytelling, poetry, brainstorming (non-Chinese)
- chat: Casual conversation, greetings, simple questions, opinions
- translation: Language translation between any languages
- gaming: Game-related discussions, strategies, game development
- image_generation: Requests to create, draw, generate, or edit images

PRIORITY RULES (apply in order):
1. If message asks to FIX, MODIFY, IMPLEMENT, DEBUG anything in code → "code"
2. If message asks to SOLVE, CHECK, DEPLOY, CONFIGURE server/infra issues → "sysadmin"  
3. If it's PURE analysis/logic/math with NO action → "reasoning"
4. 中文"解决/修复/排查/修改/实现"类请求: if about code → "code"; if about servers/infra → "sysadmin"

Respond with JSON only: {"type":"<type>","confidence":<0.0-1.0>}`;

// ─── OpenAI API Call ─────────────────────────────────────────────
function callOpenAIMini(message) {
  return new Promise((resolve, reject) => {
    const apiKey = getOpenAIKey();
    if (!apiKey) {
      reject(new Error("No OpenAI API key found"));
      return;
    }

    const body = JSON.stringify({
      model: CLASSIFIER_MODEL,
      messages: [
        { role: "system", content: CLASSIFICATION_PROMPT },
        { role: "user", content: message }
      ],
      max_completion_tokens: 100,
      temperature: 0.1
    });

    const timeout = setTimeout(() => {
      reject(new Error("Classifier timeout"));
    }, CLASSIFIER_TIMEOUT_MS);

    const req = https.request({
      hostname: OPENAI_API_HOST,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          if (res.statusCode !== 200) {
            const errBody = JSON.parse(data);
            reject(new Error(`OpenAI API ${res.statusCode}: ${errBody?.error?.message || data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.message?.content || "";
          logger.info(`[llm-pre-classifier] RAW text: ${JSON.stringify(text).substring(0, 200)}`);

          // Robust JSON parsing
          let result;
          let jsonText = text
            .replace(/```json\s*/g, '')
            .replace(/```\s*/g, '')
            .trim();
          const firstBrace = jsonText.indexOf('{');
          if (firstBrace > 0) {
            jsonText = jsonText.substring(firstBrace);
          } else if (firstBrace === -1) {
            reject(new Error(`No JSON body in LLM response: ${text.substring(0, 100)}`));
            return;
          }
          try {
            result = JSON.parse(stripMarkdownJson(jsonText));
          } catch (e) {
            const typeMatch = text.match(/"type"\s*:\s*"(\w+)"/);
            const confMatch = text.match(/"confidence"\s*:\s*([\d.]+)/);
            if (typeMatch) {
              result = {
                type: typeMatch[1],
                confidence: confMatch ? parseFloat(confMatch[1]) : 0.8
              };
              logger.info(`[llm-pre-classifier] Recovered from partial JSON: type=${result.type} conf=${result.confidence}`);
            } else {
              reject(new Error(`Cannot parse LLM response: ${text.substring(0, 100)}`));
              return;
            }
          }

          // Validate type
          const VALID_TYPES = ["code", "reasoning", "sysadmin", "chinese_content", "research", "creative", "chat", "translation", "gaming", "image_generation"];
          if (!VALID_TYPES.includes(result.type)) {
            reject(new Error(`Invalid type: ${result.type}`));
            return;
          }
          resolve({
            type: result.type,
            confidence: Math.min(1, Math.max(0, result.confidence || 0.8)),
            source: "llm-gpt-5.4-mini"
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

// ─── Main Export ─────────────────────────────────────────────────
export async function preClassify(rawMessage) {
  const startTime = Date.now();
  const cleanMessage = stripContext(rawMessage);

  // ─── [R50-FIX] Explicit model request detection ─────────────────────
  // When user explicitly requests a specific model (e.g., "请用Claude4.6回答"),
  // override the classifier and force route to that model's task type.
  // This is the HIGHEST PRIORITY fast-rule.
  {
    const claudeRequest = /(?:请用|用|使用|请使用|switch to|use)\s*(?:claude|Claude|CLAUDE)[\s\-]?(?:4\.?6|sonnet|opus)?/i;
    const strongModelRequest = /(?:请用|用|使用|请使用|switch to|use)\s*(?:强模型|大模型|好模型|smart model|strong model|最好的模型|最强模型)/i;
    if (claudeRequest.test(cleanMessage) || strongModelRequest.test(cleanMessage)) {
      const elapsed = Date.now() - startTime;
      logger.info(`[llm-pre-classifier] [R50-FIX] FAST-RULE: type=sysadmin (explicit model request detected) elapsed=${elapsed}ms msg="${cleanMessage.substring(0, 50)}"`);
      // Return sysadmin type which maps to claude-sonnet-4-6 in MODEL_MAP
      // This ensures the user's explicit request is honored
      return { type: "sysadmin", confidence: 0.99, source: "fast-rule-explicit-model" };
    }
  }

  // ─── [R3-PlanB] Standalone reasoning/action keywords ─────────────────
  // These short phrases imply deep analysis even without tech nouns.
  // Must be checked BEFORE ultra-short rule to prevent "请验收" → chat.
  const STANDALONE_REASONING = /^.{0,6}(验收|总结|汇报|复盘|评估|分析结果|给我报告|任务书|方案|建议|出报告|写报告|给结论|做总结|出方案|写方案|给建议|做评估|做分析|给任务书|出任务书|写任务书)[。.！!？?\s]*$/i;
  if (STANDALONE_REASONING.test(cleanMessage)) {
    const elapsed = Date.now() - startTime;
    logger.info(`[llm-pre-classifier] FAST-RULE: type=reasoning (standalone-keyword "${cleanMessage}") elapsed=${elapsed}ms`);
    return { type: "reasoning", confidence: 0.88, source: "fast-rule" };
  }

  // Continuation detection: skip LLM
  if (/^(继续|接着|接着做|继续执行|请继续|继续吧|好的继续|好继续|continue|resume|go on|keep going|go ahead|next)[。.！!？?\s]*$/i.test(cleanMessage)) {
    const elapsed = Date.now() - startTime;
    logger.info(`[llm-pre-classifier] FAST: type=continuation elapsed=${elapsed}ms`);
    return { type: "continuation", confidence: 0.95, source: "fast-rule" };
  }

  // Ultra-short messages: skip LLM, classify as chat directly
  if (cleanMessage.length <= 5 && !/[`{}[\]()=<>]/.test(cleanMessage)) {
    const elapsed = Date.now() - startTime;
    logger.info(`[llm-pre-classifier] FAST: type=chat (ultra-short "${cleanMessage}") elapsed=${elapsed}ms`);
    return { type: "chat", confidence: 0.95, source: "fast-rule" };
  }

  // ─── [R3-PlanB] Longer reasoning/analysis requests ─────────────────
  // Matches phrases like "根据验收内容给我任务书", "帮我写一份验收报告"
  const REASONING_PHRASES = /(验收|总结|汇报|复盘|评估|分析).{0,20}(报告|任务书|方案|建议|结论|文档|清单|计划|规划|策略)/i;
  if (REASONING_PHRASES.test(cleanMessage)) {
    const elapsed = Date.now() - startTime;
    logger.info(`[llm-pre-classifier] FAST-RULE: type=reasoning (reasoning-phrase match) elapsed=${elapsed}ms`);
    return { type: "reasoning", confidence: 0.88, source: "fast-rule" };
  }


  // ─── [MODEL-FIX] Planning/Verification → reasoning (GPT-5.5) ─────────────
  // 验收/规划/分析类任务需要深度推理能力，不需要工具调用，应使用 GPT-5.5
  // 必须在 ACTION_VERBS_SYS 之前检查，否则会被错误判定为 sysadmin
  {
    const PLANNING_VERIFICATION_PATTERN = /(验收|审计|核查|核实|巡检|对照|逐项检查|评估|审查|盘点|规划|出方案|写方案|做评估|做分析|给建议|出任务书|写任务书|代码阅读|阅读代码|审阅|(?:^|\s)review|(?:^|\s)audit|(?:^|\s)verify|(?:^|\s)validate|(?:^|\s)assess|(?:^|\s)evaluate|(?:^|\s)plan(?:ning)?|(?:^|\s)diagnose)/i;
    if (PLANNING_VERIFICATION_PATTERN.test(cleanMessage)) {
      const elapsed = Date.now() - startTime;
      logger.info(`[llm-pre-classifier] FAST-RULE: type=reasoning (planning/verification keyword) elapsed=${elapsed}ms msg="${cleanMessage.substring(0, 50)}"`);
      return { type: "reasoning", confidence: 0.92, source: "fast-rule-planning" };
    }
  }

  // ─── Fast pre-check: 中文技术行动词 + 技术名词 → 直接分类，跳过 LLM ───────────
  // 防止 "解决X问题/修复X/排查X" 被 LLM 误判为 reasoning
  {
    const ACTION_VERBS_CODE = /(修复|修改|解决|实现|开发|调试|debug|fix|重构|优化|写|编写|生成|创建|改|加|删|删除|更新|重写).{0,15}(bug|功能|代码|接口|api|前端|后端|组件|页面|脚本|程序|函数|模块|文件|配置|路由|路径|逻辑)/i;
    const ACTION_VERBS_SYS = /(修复|修改|解决|排查|检查|重启|部署|迁移|清理|配置|安装|卸载|升级|恢复|备份|监控|查看|看看|看一下|检查一下|排查一下|解决一下|验收|审计|核查|核实|巡检|对照|逐项检查|验证|确认|诊断|评估|审查|盘点|测试).{0,40}(服务|进程|容器|docker|nginx|caddy|redis|mysql|数据库|服务器|日志|端口|磁盘|内存|cpu|systemd|systemctl|cron|定时|任务|gateway|worker|路由|路由过激|smart router|router|模块|文件|状态|运行|实际|线上|生产|部署|代码|语法|node|npm|pnpm)/i;

    if (ACTION_VERBS_CODE.test(cleanMessage)) {
      const elapsed = Date.now() - startTime;
      logger.info(`[llm-pre-classifier] FAST-RULE: type=code (action+code keyword) elapsed=${elapsed}ms`);
      return { type: "code", confidence: 0.90, source: "fast-rule" };
    }
    if (ACTION_VERBS_SYS.test(cleanMessage)) {
      const elapsed = Date.now() - startTime;
      logger.info(`[llm-pre-classifier] FAST-RULE: type=sysadmin (action+sys keyword) elapsed=${elapsed}ms`);
      return { type: "sysadmin", confidence: 0.90, source: "fast-rule" };
    }
  }

  // ─── Fix v3: Compound task detection ───────────────────────────
  // If message contains MULTIPLE technical indicators, it's likely a compound task
  // that needs tool-calling capability → force sysadmin
  {
    const techIndicators = [
      /服务器|server|ssh|进程|process|worker|node/i,
      /文件|file|模块|module|\.mjs|\.js|\.py/i,
      /日志|log|状态|status|运行|running/i,
      /检查|check|验证|verify|验收|audit|核查|核实|审计|巡检|诊断/i,
      /grep|cat|ls|wc|tail|head|sed|awk|node --check|npm|pnpm/i,
      /部署|deploy|线上|production|生产|阿里云/i,
    ];
    const matchCount = techIndicators.filter(p => p.test(cleanMessage)).length;
    if (matchCount >= 3) {
      const elapsed = Date.now() - startTime;
      logger.info(`[llm-pre-classifier] COMPOUND-RULE: type=sysadmin (${matchCount}/6 tech indicators matched) elapsed=${elapsed}ms`);
      return { type: "sysadmin", confidence: 0.88, source: "compound-rule" };
    }
  }

  try {
    const result = await callOpenAIMini(cleanMessage);
    const elapsed = Date.now() - startTime;
    logger.info(`[llm-pre-classifier] LLM: type=${result.type} conf=${result.confidence.toFixed(2)} elapsed=${elapsed}ms msg="${cleanMessage.substring(0, 30)}"`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.warn(`[llm-pre-classifier] FAILED (${elapsed}ms): ${err.message}. Returning null for fallback.`);
    return null;
  }
}

export { stripContext };
