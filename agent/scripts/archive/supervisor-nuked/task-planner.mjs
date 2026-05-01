// ─── Plan System Architecture ─────────────────────────────
// This is ONE of THREE plan systems in RangerAI. See docs/plan-system-architecture.md
// for the full picture. This module handles in-memory plan parsing and lifecycle.
// Persistent storage is delegated to services/plan-service.mjs (MySQL).
// supervisor-engine.mjs has its own independent plan system for multi-step tasks.
// ─────────────────────────────────────────────────────────────
/**
 * Task Planner v3.0 — Ultra-flexible plan parsing
 * 
 * Supports ALL observed AI output formats:
 * 
 * Format 1 (standard emoji): 📋 **任务计划** + list
 * Format 2 (bold header): **任务计划** + list
 * Format 3 (bracket header): 【任务计划】 or 【任务分解】 + inline/list
 * Format 4 (plain header): 任务计划：+ list
 * Format 5 (inline steps): 步骤：①xxx → ②xxx → ③xxx
 * Format 6 (variant headers): 执行计划/行动计划/分析计划/工作计划
 * 
 * List formats:
 * - [ ] xxx / - [x] xxx (checkbox)
 * - 1. xxx / 2. xxx (numbered)
 * - xxx (bullet)
 * - ①xxx → ②xxx (circled numbers, inline)
 * - 步骤1：xxx (labeled steps)
 */

import https from "node:https";
import { sendEvent } from "./ipc-utils.mjs";
import { initTrackerFromPlan, markStepDone } from "./task-progress-tracker.mjs";
// R54: Plan persistence via IPC → main process → SQLite
import { savePlan as dbSavePlan, updateStepStatus as dbUpdateStepStatus, finalizePlan as dbFinalizePlan } from "./db-proxy.mjs";

import { logger } from '../lib/logger.mjs';
import { readFileSync } from 'node:fs';

// v27.0: Complexity estimation for plan trigger
const COMPLEX_THRESHOLD = 4;

/**
 * v27.0: Estimate task complexity from user message.
 * Returns a numeric score. Plan generation triggers when score >= COMPLEX_THRESHOLD.
 */
export function estimateComplexity(message) {
  if (!message) return 0;
  let score = 0;
  // Tool-call signals (each match = +1)
  const toolSignals = message.match(/修改|部署|重启|搜索|分析|创建|删除|更新|检查|配置|安装|迁移|优化|调试|debug|fix/gi);
  if (toolSignals) score += toolSignals.length;
  // Multi-step signals (+2 each)
  const multiStep = message.match(/然后|接着|之后|同时|并且|另外|最后|首先|第一步|第二步/gi);
  if (multiStep) score += multiStep.length * 2;
  // Completeness signals (+2)
  if (/完整|全部|所有|整个|从.*到|端到端|全流程/i.test(message)) score += 2;
  // Long message bonus
  if (message.length > 200) score += 1;
  if (message.length > 500) score += 1;
  return score;
}

/**
 * v27.0: Get Google API key (reuses smart-router pattern)
 */
function getOpenAIKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync("/home/admin/.openclaw/openclaw.json", "utf-8"));
    const key = cfg?.models?.providers?.openai?.apiKey;
    if (key) {
      process.env.OPENAI_API_KEY = key;
      return key;
    }
  } catch (e) { /* ignore */ }
  return "";
}
// R55: Lightweight model for active plan generation
const PLAN_MODEL = "gpt-5.4-mini"; // v28.0: Switched to GPT-4.1-mini (reliable, fast)
const PLAN_MAX_TOKENS = 800; // v27.0: Increased for structured plan output
const PLAN_TIMEOUT_MS = 3000; // v27.0: Reduced timeout with Promise.race degradation

// ─── Plan State Store (in-memory, keyed by msgId) ───
const planStore = new Map();

// ─── Circled number map ───
const CIRCLED_NUMS = { "①": 1, "②": 2, "③": 3, "④": 4, "⑤": 5, "⑥": 6, "⑦": 7, "⑧": 8, "⑨": 9, "⑩": 10 };

/**
 * Parse a plan block from AI text output (v3.0 — ultra-flexible)
 * Returns null if no plan found, or a plan object
 */
export function parsePlanFromText(text) {
  if (!text) return null;
  
  // ─── Header detection strategies (ordered by specificity) ───
  const headerPatterns = [
    // Strategy 1: 📋 emoji header
    /📋\s*\*{0,2}[任务]*[计划分解]\*{0,2}[：:]?\s*\n/,
    // Strategy 2: 【xxx】bracket header (任务计划/任务分解/执行计划/分析计划)
    /【(?:任务[计划分解]|执行计划|行动计划|分析计划|工作计划)】[：:]?\s*\n?/,
    // Strategy 3: **任务计划** bold header
    /\*{2}(?:任务[计划分解]|执行计划|行动计划|分析计划)\*{2}[：:]?\s*\n/,
    // Strategy 4: 任务计划：plain text header
    /^(?:任务[计划分解]|执行计划|行动计划)[：:]\s*\n/m,
  ];
  
  let headerMatch = null;
  for (const pattern of headerPatterns) {
    headerMatch = text.match(pattern);
    if (headerMatch) break;
  }
  
  // ─── Strategy 5: Inline plan without explicit header ───
  // Match: 步骤：①xxx → ②xxx or 步骤：①xxx ②xxx
  let isInlinePlan = false;
  let inlineMatch = null;
  if (!headerMatch) {
    inlineMatch = text.match(/(?:步骤|计划|流程)[：:]\s*(①.+)/);
    if (inlineMatch) {
      isInlinePlan = true;
    }
  }
  
  if (!headerMatch && !isInlinePlan) return null;
  
  // ─── Extract text after header ───
  let afterHeader;
  if (isInlinePlan) {
    afterHeader = inlineMatch[1];
  } else {
    const headerEnd = headerMatch.index + headerMatch[0].length;
    afterHeader = text.substring(headerEnd);
  }
  
  // ─── Extract goal line (optional) ───
  let goal = "";
  const goalRegex = /^(?:\*\s*)?(?:目标|目的|总目标)[：:]\s*(.+?)(?:\n|$)/m;
  const goalMatch = afterHeader.match(goalRegex);
  if (goalMatch) {
    goal = goalMatch[1].trim().replace(/\*+/g, "");
  }
  
  // ─── Extract plan items with multiple format support ───
  const phases = [];
  let usedPattern = null;
  
  // ─── Pattern A: Circled numbers ①②③④ (inline or multiline) ───
  const circledRegex = /([①②③④⑤⑥⑦⑧⑨⑩])\s*([^①②③④⑤⑥⑦⑧⑨⑩\n→➡]+)/g;
  let match;
  while ((match = circledRegex.exec(afterHeader)) !== null) {
    const num = CIRCLED_NUMS[match[1]] || phases.length + 1;
    let title = match[2].trim();
    // Clean trailing punctuation and arrows
    title = title.replace(/[→➡\s]+$/, "").trim();
    if (title.length < 2) continue;
    // R59: Extract [tools: xxx] from title
    const toolMatch = title.match(/\[tools?:\s*([^\]]+)\]/i);
    const allowedTools = toolMatch ? toolMatch[1].trim().split(/[,\s]+/) : ['all'];
    title = title.replace(/\s*\[tools?:[^\]]+\]/i, '').trim();
    phases.push({ id: num, title, status: "pending", allowedTools });
    usedPattern = "circled";
  }
  
  // ─── Pattern B: Checkbox format - [ ] xxx / - [x] xxx ───
  if (phases.length === 0) {
    const checkboxRegex = /- \[([ x])\]\s*(?:(?:步骤|阶段)\s*)?(\d+)?[：:.]?\s*(.+)/g;
    while ((match = checkboxRegex.exec(afterHeader)) !== null) {
      const isCompleted = match[1] === "x";
      const stepNum = match[2] ? parseInt(match[2]) : phases.length + 1;
      const title = match[3].trim();
      if (title.length < 2) continue;
      // R59: Extract [tools: xxx] from title
      const toolMatchC = title.match(/\[tools?:\s*([^\]]+)\]/i);
      const allowedToolsC = toolMatchC ? toolMatchC[1].trim().split(/[,\s]+/) : ['all'];
      title = title.replace(/\s*\[tools?:[^\]]+\]/i, '').trim();
      phases.push({ id: stepNum, title, status: isCompleted ? "completed" : "pending", allowedTools: allowedToolsC });
      usedPattern = "checkbox";
    }
  }
  
  // ─── Pattern C: Numbered list 1. xxx / 2) xxx ───
  if (phases.length === 0) {
    const nearHeader = afterHeader.substring(0, 800);
    const numberedRegex = /^(\d+)[.)]\s+(.+)/gm;
    while ((match = numberedRegex.exec(nearHeader)) !== null) {
      const stepNum = parseInt(match[1]);
      const title = match[2].trim();
      if (title.length > 120 || title.length < 2) continue;
      // R59: Extract [tools: xxx] from title
      const toolMatchN = title.match(/\[tools?:\s*([^\]]+)\]/i);
      const allowedToolsN = toolMatchN ? toolMatchN[1].trim().split(/[,\s]+/) : ['all'];
      title = title.replace(/\s*\[tools?:[^\]]+\]/i, '').trim();
      phases.push({ id: stepNum, title, status: "pending", allowedTools: allowedToolsN });
      usedPattern = "numbered";
    }
  }
  
  // ─── Pattern D: 步骤N：xxx / 阶段N：xxx (labeled steps) ───
  if (phases.length === 0) {
    const nearHeader = afterHeader.substring(0, 800);
    const labeledRegex = /(?:步骤|阶段)\s*(\d+)[：:.]\s*(.+?)(?:\n|$)/gm;
    while ((match = labeledRegex.exec(nearHeader)) !== null) {
      const stepNum = parseInt(match[1]);
      const title = match[2].trim();
      if (title.length > 120 || title.length < 2) continue;
      phases.push({ id: stepNum, title, status: "pending" });
      usedPattern = "labeled";
    }
  }
  
  // ─── Pattern E: Simple bullet list - xxx ───
  if (phases.length === 0) {
    const nearHeader = afterHeader.substring(0, 500);
    const bulletRegex = /^- (.+)/gm;
    let bulletIdx = 0;
    while ((match = bulletRegex.exec(nearHeader)) !== null) {
      bulletIdx++;
      const title = match[1].trim();
      if (title.length > 100 || title.length < 2) continue;
      if (title.startsWith("注意") || title.startsWith("说明") || title.startsWith("风险")) continue;
      phases.push({ id: bulletIdx, title, status: "pending" });
      usedPattern = "bullet";
    }
  }
  
  // ─── Pattern F: Arrow-separated inline steps (xxx → xxx → xxx) ───
  if (phases.length === 0) {
    const arrowMatch = afterHeader.match(/(.+?(?:→|➡).+)/);
    if (arrowMatch) {
      const parts = arrowMatch[1].split(/\s*[→➡]\s*/);
      parts.forEach((part, idx) => {
        const title = part.trim().replace(/^\d+[.)：:]\s*/, "");
        if (title.length >= 2 && title.length <= 100) {
          phases.push({ id: idx + 1, title, status: "pending" });
        }
      });
      usedPattern = "arrow";
    }
  }
  
  if (phases.length < 2) return null;
  
  // Set first pending phase as "running"
  const firstPending = phases.find(p => p.status === "pending");
  if (firstPending) firstPending.status = "running";
  
  return {
    id: `plan-${Date.now()}`,
    goal: goal || phases[0]?.title || "任务执行中",
    phases,
    currentPhaseId: firstPending ? firstPending.id : phases[phases.length - 1].id,
    totalPhases: phases.length,
    completedPhases: phases.filter(p => p.status === "completed").length,
    createdAt: Date.now(),
    _pattern: usedPattern,
  };
}

/**
 * Parse phase completion markers from AI text (v3.0 — flexible matching)
 * Matches multiple formats:
 * - ✅ 步骤N：xxx（已完成）
 * - ✅ 阶段N：xxx（已完成）
 * - ✅ N. xxx（完成）
 * - ✅ xxx 已完成
 * - ✅ ①xxx 完成
 * Returns: { phaseId: number, title: string } or null
 */
export function parsePhaseCompletion(text) {
  if (!text) return null;
  
  // Pattern 1: ✅ 步骤/阶段N：xxx
  const pattern1 = /✅\s*(?:步骤|阶段)\s*(\d+)[：:.]\s*(.+?)(?:（已完成）|（完成）|\(完成\)|\(已完成\)|已完成|完成|$)/;
  // Pattern 2: ✅ N. xxx or ✅ N：xxx
  const pattern2 = /✅\s*(\d+)[.)：:.]\s*(.+?)(?:（已完成）|（完成）|\(完成\)|\(已完成\)|已完成|完成|$)/;
  // Pattern 3: ✅ ①②③ circled number
  const pattern3 = /✅\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*(.+?)(?:（已完成）|（完成）|\(完成\)|\(已完成\)|已完成|完成|$)/;
  
  let match = text.match(pattern1) || text.match(pattern2);
  if (match) {
    return { phaseId: parseInt(match[1]), title: match[2].trim() };
  }
  
  match = text.match(pattern3);
  if (match) {
    return { phaseId: CIRCLED_NUMS[match[1]] || 1, title: match[2].trim() };
  }
  
  return null;
}

/**
 * Parse recovery marker from AI text
 * Matches: 🔄 恢复任务，从步骤 N 继续...
 */
export function parseRecoveryMarker(text) {
  if (!text) return null;
  
  const recoveryRegex = /🔄\s*恢复任务.*?(?:步骤|阶段)\s*(\d+)/;
  const match = text.match(recoveryRegex);
  if (!match) return null;
  
  return { resumeFromPhase: parseInt(match[1]) };
}

/**
 * Store and manage plan state for a message
 */
export function storePlan(msgId, plan, sessionKey = null) {
  planStore.set(msgId, plan);
  // R54: Async persist to DB (fire-and-forget, don't block)
  if (sessionKey) {
    dbSavePlan({ sessionKey, msgId, plan }).catch(err => {
      logger.warn(`[task-planner] DB persist failed for ${msgId}: ${err.message}`);
    });
  }
  return plan;
}

export function getPlan(msgId) {
  return planStore.get(msgId) || null;
}

export function updatePlanPhase(msgId, phaseId, status) {
  const plan = planStore.get(msgId);
  if (!plan) return null;
  
  const phase = plan.phases.find(p => p.id === phaseId);
  if (!phase) return null;
  
  phase.status = status;
  
  if (status === "completed") {
    plan.completedPhases = plan.phases.filter(p => p.status === "completed").length;
    // R54: Persist step completion to DB
    const stepIndex = plan.phases.indexOf(phase);
    if (stepIndex >= 0) {
      dbUpdateStepStatus(msgId, stepIndex, 'done').catch(err => {
        logger.warn(`[task-planner] DB step update failed: ${err.message}`);
      });
    }
    
    // Set next pending phase as "running"
    const nextPending = plan.phases.find(p => p.status === "pending");
    if (nextPending) {
      nextPending.status = "running";
      plan.currentPhaseId = nextPending.id;
    }
  }
  
  return plan;
}

/**
 * Emit plan events to frontend via WebSocket
 */
export function emitPlanCreated(msgId, plan) {
  sendEvent(msgId, {
    type: "plan_created",
    plan: {
      id: plan.id,
      goal: plan.goal,
      phases: plan.phases,
      currentPhaseId: plan.currentPhaseId,
      totalPhases: plan.totalPhases,
      completedPhases: plan.completedPhases,
    },
  });
}

export function emitPlanPhaseUpdate(msgId, plan, phaseId, status) {
  sendEvent(msgId, {
    type: "plan_phase_update",
    planId: plan.id,
    phaseId,
    status,
    currentPhaseId: plan.currentPhaseId,
    completedPhases: plan.completedPhases,
    totalPhases: plan.totalPhases,
  });
}

/**
 * Process AI text delta for plan-related content
 * Called from openclaw-handler.mjs on each text delta
 * 
 * @param {string} msgId - Message ID
 * @param {string} fullText - Accumulated full text so far
 * @param {string} delta - New text delta
 * @returns {boolean} - true if plan event was emitted
 */
export function processTextForPlan(msgId, fullText, delta, sessionKey = null) {
  let emitted = false;
  
  // Check for new plan creation (only if no plan exists yet for this message)
  if (!planStore.has(msgId)) {
    const plan = parsePlanFromText(fullText);
    if (plan) {
      storePlan(msgId, plan, sessionKey); // R54: pass sessionKey for DB persistence
      emitPlanCreated(msgId, plan);
      // v14.7 R52: Initialize progress tracker for attention anchoring
      if (sessionKey) {
        initTrackerFromPlan(sessionKey, plan);
      }
      logger.info(`[${new Date().toISOString()}] [task-planner] Plan created for ${msgId}: ${plan.phases.length} phases (pattern: ${plan._pattern}), goal="${plan.goal}"`);
      emitted = true;
    }
  }
  
  // Check for phase completion in the delta (and also in recent fullText)
  const completion = parsePhaseCompletion(delta);
  if (completion) {
    const plan = planStore.get(msgId);
    if (plan) {
      const updatedPlan = updatePlanPhase(msgId, completion.phaseId, "completed");
      if (updatedPlan) {
        emitPlanPhaseUpdate(msgId, updatedPlan, completion.phaseId, "completed");
        // v14.7 R52: Sync progress tracker
        if (sessionKey) {
          markStepDone(sessionKey, completion.phaseId);
        }
        logger.info(`[${new Date().toISOString()}] [task-planner] Phase ${completion.phaseId} completed for ${msgId}: "${completion.title}"`);
        emitted = true;
      }
    }
  }
  
  // Check for recovery marker
  const recovery = parseRecoveryMarker(delta);
  if (recovery) {
    const plan = planStore.get(msgId);
    if (plan) {
      for (const phase of plan.phases) {
        if (phase.id < recovery.resumeFromPhase) {
          phase.status = "completed";
        } else if (phase.id === recovery.resumeFromPhase) {
          phase.status = "running";
          plan.currentPhaseId = phase.id;
        }
      }
      plan.completedPhases = plan.phases.filter(p => p.status === "completed").length;
      emitPlanCreated(msgId, plan);
      logger.info(`[${new Date().toISOString()}] [task-planner] Recovery detected for ${msgId}: resuming from phase ${recovery.resumeFromPhase}`);
      emitted = true;
    }
  }
  
  return emitted;
}

// ─── R55: Active Plan Generation ─────────────────────────────────
// Proactively generates a numbered pseudocode plan via lightweight LLM
// before the main task is sent to the Gateway.
// Silent failure — never blocks the main flow.

const PLAN_SYSTEM_PROMPT = `你是一个任务规划器。给定用户消息，生成一个简洁的执行计划。
规则：
- 输出 3-6 个编号步骤，每步一句话
- 格式："1. 动词+对象 [tools: 类别]"
- tools 类别可选值：read（只读操作）、write（文件写入）、exec（命令执行）、all（不限制）
- 示例："1. 读取配置文件 [tools: read]"、"2. 修改数据库配置 [tools: write]"
- 如果步骤需要多种操作，用逗号分隔："[tools: read,write]"
- 不确定时使用 [tools: all]
- 不要解释，不要开头说明，直接输出步骤
- 用中文`;

/**
 * Generate a plan proactively using a lightweight LLM call.
 * Returns plan text string or null on failure.
 * 
 * @param {string} sessionKey - Session key for logging
 * @param {string} userMessage - The user's message to plan for
 * @param {object} routing - Routing info (taskType, etc.)
 * @returns {Promise<string|null>} Plan text in [PLAN]...[/PLAN] format, or null
 */
export async function generatePlan(sessionKey, userMessage, routing) {
  // v28.0: Use OpenAI GPT-4.1-mini (reliable)
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    logger.warn(`[task-planner] v28.0: No OPENAI_API_KEY, skipping plan generation`);
    return null;
  }
  // Only generate for complex task types
  const complexTypes = ['code', 'sysadmin', 'research', 'reasoning'];
  const taskType = routing?.taskType || 'chat';
  if (!complexTypes.includes(taskType)) {
    return null;
  }
  // v27.0: Use estimateComplexity threshold instead of simple length check
  // Strip context markers first
  let planInput = userMessage;
  const ctxEndMarker = "[/KNOWLEDGE_CONTEXT]";
  const ctxEndIdx = planInput.indexOf(ctxEndMarker);
  if (ctxEndIdx !== -1) {
    planInput = planInput.substring(ctxEndIdx + ctxEndMarker.length).trim();
  }
  const refEndMarker = "</knowledge_reference>";
  const refEndIdx = planInput.indexOf(refEndMarker);
  if (refEndIdx !== -1) {
    planInput = planInput.substring(refEndIdx + refEndMarker.length).trim();
  }
  const memEndMarker = "</user_memory>";
  const memEndIdx = planInput.indexOf(memEndMarker);
  if (memEndIdx !== -1) {
    planInput = planInput.substring(memEndIdx + memEndMarker.length).trim();
  }
  // Skip meta-questions about the AI system
  const metaPatterns = /(工具调用|智能路由|路由问题|模型选择|为什么.*调用|为什么.*回复|设定.*吗|配置.*吗)/;
  if (planInput.length < 150 && metaPatterns.test(planInput)) {
    logger.info(`[${new Date().toISOString()}] [task-planner] v27.0: Skipping plan for meta-question`);
    return null;
  }
  // v27.0: Complexity-based trigger (replaces simple length check)
  const complexity = estimateComplexity(planInput);
  if (complexity < COMPLEX_THRESHOLD) {
    logger.info(`[${new Date().toISOString()}] [task-planner] v27.0: Complexity ${complexity} < ${COMPLEX_THRESHOLD}, skipping plan`);
    return null;
  }
  try {
    // v28.0: Call OpenAI API directly (gpt-5.4-mini)
    const url = 'https://api.openai.com/v1/chat/completions';
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
    
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: PLAN_MODEL,
        messages: [
          { role: 'system', content: PLAN_SYSTEM_PROMPT },
          { role: 'user', content: planInput.substring(0, 800) },
        ],
        max_completion_tokens: PLAN_MAX_TOKENS,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timer);
    
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${errText.substring(0, 200)}`);
    }
    
    const data = await resp.json();
    const result = data.choices?.[0]?.message?.content || '';
    
    if (!result || result.trim().length < 10) {
      return null;
    }
    
    // Wrap in [PLAN] tags for injection
    const planBlock = `[PLAN]\n目标: ${planInput.substring(0, 60)}${planInput.length > 60 ? '...' : ''}\n${result.trim()}\n[/PLAN]`;
    
    logger.info(`[${new Date().toISOString()}] [task-planner] v27.0: Plan generated via Gemini Flash for session ${sessionKey} (${taskType}, complexity=${complexity}): ${result.trim().split('\n').length} steps`);
    
    return planBlock;
  } catch (err) {
    // Silent failure — never block main flow
    if (err.name === 'AbortError') {
      logger.warn(`[${new Date().toISOString()}] [task-planner] v27.0: Plan generation timeout (${PLAN_TIMEOUT_MS}ms) — degrading gracefully`);
    } else {
      logger.warn(`[${new Date().toISOString()}] [task-planner] v27.0: Plan generation failed (silent): ${err.message}`);
    }
    return null;
  }
}
/**
 * Clean up plan state for a completed message
 */
export function cleanupPlan(msgId) {
  // R54: Finalize plan in DB before removing from memory
  if (planStore.has(msgId)) {
    const plan = planStore.get(msgId);
    const allDone = plan.phases?.every(p => p.status === 'completed');
    dbFinalizePlan(msgId, allDone ? 'completed' : 'cancelled').catch(() => {});
  }
  planStore.delete(msgId);
}

/**
 * Get serializable plan for Redis storage (for "继续" mechanism)
 */
export function getSerializablePlan(msgId) {
  const plan = planStore.get(msgId);
  if (!plan) return null;
  return JSON.parse(JSON.stringify(plan));
}
