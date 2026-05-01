// plan-generator.mjs — Task Planner Layer (R98 extraction)
// Extracted from task-engine.mjs LAYER 1
// 
// Generates structured plans from user messages via LLM, manages in-memory
// plan lifecycle (parse → store → emit → track → cleanup).
// 
// @module worker/plan-generator

import https from "node:https";
import { readFileSync } from 'node:fs';
import { sendEvent } from "./ipc-utils.mjs";
import { savePlan as dbSavePlan, updateStepStatus as dbUpdateStepStatus, finalizePlan as dbFinalizePlan } from "./db-proxy.mjs";
import { logger } from '../lib/logger.mjs';
import { getKnowledgeModule, formatBundleForInjection } from './knowledge-provider.mjs';
import { TTLMap } from './lib/ttl-map.mjs';
import { estimateComplexity } from './complexity-estimator.mjs';
import { parsePlanFromText, parsePhaseCompletion, parseRecoveryMarker } from './plan-parser.mjs';
import { initTrackerFromPlan, markStepDone } from './progress-tracker.mjs';
import { getOrCreateTaskState } from './task-state-manager.mjs';

const COMPLEX_THRESHOLD = 2;

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

const PLAN_MODEL = "gpt-5.5";
const PLAN_MAX_TOKENS = 800;
const PLAN_TIMEOUT_MS = 8000;

// ─── Plan State Store (in-memory, keyed by msgId) ───
const planStore = new TTLMap(500, 2 * 60 * 60 * 1000, 5 * 60 * 1000);

export function storePlan(msgId, plan, sessionKey = null) {
  planStore.set(msgId, plan);
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
    const stepIndex = plan.phases.indexOf(phase);
    if (stepIndex >= 0) {
      dbUpdateStepStatus(msgId, stepIndex, 'done').catch(err => {
        logger.warn(`[task-planner] DB step update failed: ${err.message}`);
      });
    }
    
    const nextPending = plan.phases.find(p => p.status === "pending");
    if (nextPending) {
      nextPending.status = "running";
      plan.currentPhaseId = nextPending.id;
    }
  }
  
  return plan;
}

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

export function processTextForPlan(msgId, fullText, delta, sessionKey = null) {
  let emitted = false;
  
  if (!planStore.has(msgId)) {
    const plan = parsePlanFromText(fullText);
    if (plan) {
      storePlan(msgId, plan, sessionKey);
      emitPlanCreated(msgId, plan);
      if (sessionKey) {
        initTrackerFromPlan(sessionKey, plan);
      }
      logger.info(`[${new Date().toISOString()}] [task-planner] Plan created for ${msgId}: ${plan.phases.length} phases (pattern: ${plan._pattern}), goal="${plan.goal}"`);
      emitted = true;
    }
  }
  
  const completion = parsePhaseCompletion(delta);
  if (completion) {
    const plan = planStore.get(msgId);
    if (plan) {
      const updatedPlan = updatePlanPhase(msgId, completion.phaseId, "completed");
      if (updatedPlan) {
        emitPlanPhaseUpdate(msgId, updatedPlan, completion.phaseId, "completed");
        if (sessionKey) {
          markStepDone(sessionKey, completion.phaseId);
        }
        logger.info(`[${new Date().toISOString()}] [task-planner] Phase ${completion.phaseId} completed for ${msgId}: "${completion.title}"`);
        emitted = true;
      }
    }
  }
  
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

const PLAN_SYSTEM_PROMPT = `你是一个任务规划器。给定用户消息，生成一个简洁的执行计划。
规则：
- 输出 3-6 个编号步骤，每步一句话
- 格式："1. 动词+对象 [tools: 类别]"
- tools 类别可选值（选择最精确的类别）：
  - read: 读取文件内容（cat/head/tail 或 read_file 工具）
  - write: 创建或修改文件（write_file/edit_file 工具）
  - inspect: 系统检查/状态查询（grep/ps/systemctl status/curl GET/sqlite3 SELECT 等只读 shell 命令）
  - shell: 执行有副作用的 shell 命令（安装/部署/重启/删除等）
  - browser: 网页操作（打开页面/截图/提取文案/点击元素）
  - search: 网络搜索或知识检索（web_search/memory_search）
  - all: 不确定或需要多种操作
- 选择指南：
  - 用 grep/head/sed -n 查看文件 → inspect（不是 read）
  - 用 systemctl status / curl / sqlite3 SELECT 检查状态 → inspect（不是 exec）
  - 用 systemctl restart / npm install / docker run → shell
  - 验证网页是否正常 / 检查页面内容 → browser
  - 读取文件全文 → read
  - 修改/创建文件 → write
- 示例："1. 检查服务运行状态 [tools: inspect]"、"2. 修改配置文件 [tools: write]"、"3. 验证网页显示正常 [tools: browser]"
- 如果步骤需要多种操作，用逗号分隔："[tools: inspect,write]"
- 不要解释，不要开头说明，直接输出步骤
- 用中文
- 对于 sysadmin/code 类任务，必须生成 3-6 个步骤，每个步骤对应一个独立的操作
- 对于 research/reasoning 类任务，生成 2-4 个步骤
- 每个步骤必须是可执行的原子操作，不要合并多个操作到一个步骤中`;

export async function generatePlan(sessionKey, userMessage, routing) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    logger.warn(`[task-planner] v28.0: No OPENAI_API_KEY, skipping plan generation`);
    return null;
  }
  const complexTypes = ['code', 'sysadmin', 'research', 'reasoning'];
  const taskType = routing?.taskType || 'chat';
  if (!complexTypes.includes(taskType)) {
    return null;
  }
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
  const metaPatterns = /(工具调用|智能路由|路由问题|模型选择|为什么.*调用|为什么.*回复|设定.*吗|配置.*吗)/;
  if (planInput.length < 150 && metaPatterns.test(planInput)) {
    logger.info(`[${new Date().toISOString()}] [task-planner] v27.0: Skipping plan for meta-question`);
    return null;
  }
  const complexity = estimateComplexity(planInput);
  const forceTypes = ['sysadmin', 'code', 'reasoning'];
  const forcePlan = forceTypes.includes(taskType);
  if (!forcePlan && complexity < COMPLEX_THRESHOLD) {
    logger.info(`[${new Date().toISOString()}] [task-planner] v28.1: Complexity ${complexity} < ${COMPLEX_THRESHOLD}, skipping plan (taskType=${taskType})`);
    return null;
  }
  logger.info(`[${new Date().toISOString()}] [task-planner] v28.1: Generating plan — complexity=${complexity} taskType=${taskType} forced=${forcePlan}`);
  try {
    const km = await getKnowledgeModule().catch(() => null);
    let knowledgeBlock = '';
    let traceId = null;
    if (km) {
      const kb = await km.gather({ sessionKey, userMessage: planInput, taskId: routing?.taskId || null, userId: routing?.userId || null, conversationHistory: routing?.conversationHistory || [], msgId: routing?.msgId || null });
      traceId = kb.traceId;
      knowledgeBlock = formatBundleForInjection({ ragContext: kb.segments.map(s => s.content).join('\n\n'), userMemory: null, conversationRecall: null, workspaceContext: null, eventHistory: null, fileMemory: null });
      try { const state = await getOrCreateTaskState(sessionKey, routing?.taskId || null); state.knowledge_trace_id = traceId; } catch (_) {}
    }
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
          { role: 'system', content: `${PLAN_SYSTEM_PROMPT}${knowledgeBlock ? `\n\n${knowledgeBlock}` : ''}` },
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
    
    const planBlock = `[PLAN]\n目标: ${planInput.substring(0, 60)}${planInput.length > 60 ? '...' : ''}\n${result.trim()}\n[/PLAN]`;
    
    logger.info(`[${new Date().toISOString()}] [task-planner] v27.0: Plan generated via Gemini Flash for session ${sessionKey} (${taskType}, complexity=${complexity}): ${result.trim().split('\n').length} steps`);
    
    return planBlock;
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn(`[${new Date().toISOString()}] [task-planner] v27.0: Plan generation timeout (${PLAN_TIMEOUT_MS}ms) — degrading gracefully`);
    } else {
      logger.warn(`[${new Date().toISOString()}] [task-planner] v27.0: Plan generation failed (silent): ${err.message}`);
    }
    return null;
  }
}

export function cleanupPlan(msgId) {
  if (planStore.has(msgId)) {
    const plan = planStore.get(msgId);
    const allDone = plan.phases?.every(p => p.status === 'completed');
    dbFinalizePlan(msgId, allDone ? 'completed' : 'cancelled').catch(() => {});
  }
  planStore.delete(msgId);
}

export function getSerializablePlan(msgId) {
  const plan = planStore.get(msgId);
  if (!plan) return null;
  return JSON.parse(JSON.stringify(plan));
}

export function cleanupPlanGeneratorResources() {
  planStore.dispose();
}


// ─── R98 Structured Planner Extraction (from planner.mjs) ───
import { recordHintAdoption } from './hint-system.mjs';
import { persistPlanToDb } from './plan-persistence.mjs';
import { _r42FormatPlanPayload, R8_PLAN_JSON_SCHEMA, TASK_TYPE_STEP_GUIDANCE, buildPlanSystemPrompt, REPLAN_SYSTEM_PROMPT, normalizePlanStepContract, parseR8PlanOutput } from './plan-formatter.mjs';
import { _planCache, _externalPlanKeys, _sessionKeyCache, _sendPlanProgress, createFallbackPlan } from './plan-storage.mjs';
import { invokeLLM as _rawStructuredInvokeLLM } from "./llm-bridge.mjs";
import { diagnoseFailure } from "./failure-recovery.mjs";
import { emitEvent, EVENT_TYPES } from "./event-stream.mjs";
import { classifyWebTaskFamily } from "./web-task-family.mjs";


// R98 split: structured planning/replanning is implemented in plan-structured.mjs.
export { generateStructuredPlan, replan, replanOnFailure } from './plan-structured.mjs';
