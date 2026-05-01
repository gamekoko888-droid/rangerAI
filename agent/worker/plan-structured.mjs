// plan-structured.mjs — Structured planning/replan helpers extracted from plan-generator (R98 extraction)
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

const PLAN_MODEL = "gpt-5.4-mini";
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

const structuredTs = () => new Date().toISOString();

async function invokeStructuredLLM(params) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _rawStructuredInvokeLLM(params);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn(`[R31-T1] [planner] LLM attempt ${attempt + 1} failed: ${err.message}, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        logger.error(`[R31-T1] [planner] LLM all ${MAX_RETRIES + 1} attempts failed: ${err.message}`);
        throw err;
      }
    }
  }
}

export async function generateStructuredPlan(taskId, sessionKey, userGoal, context = {}) {
  const { recentEvents = [], conversationSummary = '', taskState = null, taskType = 'reasoning' } = context;

  // Check if we already have a valid plan that doesn't need replanning
  const existingPlan = _planCache.get(taskId);
  // [R10-Task1] If existing plan came from registerExternalPlan, DON'T early-return.
  // Let planner's own LLM path generate a higher-quality structured plan with plan_version/reflection/rationale.
  const isExternalPlan = _externalPlanKeys.has(taskId);
  if (existingPlan && !existingPlan.needsReplan && !isExternalPlan && existingPlan.steps.some(s => s.status === 'pending' || s.status === 'doing')) {
    logger.info(`[${structuredTs()}] [planner] Existing plan v${existingPlan.version} still valid for task ${taskId}`);
    // [R24-T1] Classify web task family even on early return (fixes webTaskCount=0 bug)
    try {
      const wtc = classifyWebTaskFamily(userGoal, taskType, existingPlan.steps);
      existingPlan.taskFamily = wtc.taskFamily;
      existingPlan.routingReason = wtc.routingReason;
      existingPlan.selectedPrimaryTool = wtc.selectedPrimaryTool;
      if (wtc.taskFamily !== 'non_web') {
        logger.info(`[${structuredTs()}] [R24-T1] Web task detected on early-return: family=${wtc.taskFamily} tool=${wtc.selectedPrimaryTool}`);
        emitEvent(sessionKey, taskId, 'web_task_routing', wtc);
      }
    } catch (wtErr) {
      logger.warn(`[${structuredTs()}] [R24-T1] Web task classification failed on early-return (non-fatal): ${wtErr.message}`);
    }
    return existingPlan;
  }
  if (isExternalPlan) {
    logger.info(`[${structuredTs()}] [R10-Task1] External plan detected for ${taskId}, upgrading via LLM path`);
    _externalPlanKeys.delete(taskId); // consume the flag so replan doesn't re-trigger
  }

  // Build context for LLM
  const contextParts = [];
  if (conversationSummary) {
    contextParts.push(`[Conversation Context]\n${conversationSummary}`);
  }
  if (recentEvents.length > 0) {
    const eventSummary = recentEvents.slice(-10).map(e =>
      `- ${e.event_type}: ${typeof e.payload === 'string' ? e.payload.substring(0, 200) : JSON.stringify(e.payload).substring(0, 200)}`
    ).join('\n');
    contextParts.push(`[Recent Events]\n${eventSummary}`);
  }
  if (taskState) {
    contextParts.push(`[Current Task State]\n${JSON.stringify(taskState, null, 2)}`);
  }

  const userPrompt = contextParts.length > 0
    ? `Goal: ${userGoal}\n\n${contextParts.join('\n\n')}`
    : `Goal: ${userGoal}`;

  try {
    // [R8-Task3] Use enhanced JSON schema with plan_version + reflection
    // [Iter-67] Multi-model architecture: GPT-5.5 for planning (high reasoning quality), V4 Pro for execution (cost-efficient)
    // GPT-5.5 produces better task decomposition, risk assessment, and validation steps
    const _r43PlannerModel = 'openai/gpt-5.5'; // Iter-67: GPT-5.5 primary planner
    const _r43FallbackModel = 'deepseek/deepseek-v4-pro'; // Iter-67: V4 Pro fallback
    let response;
    try {
      response = await invokeStructuredLLM({
        messages: [
          { role: 'system', content: buildPlanSystemPrompt(taskType) },
          { role: 'user', content: userPrompt }
        ],
        model: _r43PlannerModel,
        maxTokens: 4000,
        response_format: {
          type: 'json_schema',
          json_schema: R8_PLAN_JSON_SCHEMA
        }
      });
    } catch (_plannerPrimaryErr) {
      logger.warn();
      response = await invokeStructuredLLM({
        messages: [
          { role: 'system', content: buildPlanSystemPrompt(taskType) },
          { role: 'user', content: userPrompt }
        ],
        model: _r43FallbackModel,
        maxTokens: 4000,
        response_format: {
          type: 'json_schema',
          json_schema: R8_PLAN_JSON_SCHEMA
        }
      });
    }
    // [R43-T1] Emit model_route event for planner
    try {
      emitEvent(sessionKey, taskId, EVENT_TYPES.MODEL_ROUTE, {
        role: 'planner',
        model: _r43PlannerModel,
        provider: _r43PlannerModel.startsWith('openai/') ? 'openai' : 'deepseek',
        category: taskType || 'planning',
        thinking: 'low',
        confidence: 1.0,
        reason: 'Iter-67: Planner uses GPT-5.5 (multi-model architecture)',
      });
    } catch (_e43mr) { /* non-fatal */ }

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`[${structuredTs()}] [planner] LLM returned empty response`);
      return null;
    }

    // [R8-Task3] Parse with multi-layer fallback
    const { plan, method } = parseR8PlanOutput(content, existingPlan);

    // [R9-plan] Log schema path hit for main-path validation
    if (method === 'r8_json_schema' || method === 'r8_json_partial') {
      logger.info(`[${structuredTs()}] [R9-plan] generatePlan schema path hit: method=${method}`);
      const hasVersion = plan?.plan_version !== undefined;
      const hasReflection = plan?.reflection !== undefined;
      const hasRationale = plan?.steps?.every(s => s.rationale !== undefined) || false;
      logger.info(`[${structuredTs()}] [R9-plan] schema validation: plan_version=${hasVersion}(${plan?.plan_version}) reflection=${hasReflection} allRationale=${hasRationale}`);
      if (hasVersion && hasReflection && hasRationale) {
        logger.info(`[${structuredTs()}] [R9-plan] schema validation ok`);
      } else {
        logger.warn(`[${structuredTs()}] [R9-plan] schema validation partial — missing fields`);
      }
    } else {
      logger.info(`[${structuredTs()}] [R9-plan] generatePlan non-schema path: method=${method}`);
    }

    if (!plan) {
      logger.warn(`[${structuredTs()}] [R8-planner] All parse methods failed, using fallback plan`);
      const fallbackPlan = normalizePlanStepContract(createFallbackPlan(taskId, userGoal, existingPlan));
      _planCache.set(taskId, fallbackPlan);
      persistPlanToDb(taskId, sessionKey, fallbackPlan); // [R8-Task4]
      emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_UPDATE, {
        plan: fallbackPlan,
        version: fallbackPlan.version,
        trigger: 'fallback'
      });
      // [R24-T1] Classify web task family on fallback path
      try {
        const wtc = classifyWebTaskFamily(userGoal, taskType, fallbackPlan.steps);
        fallbackPlan.taskFamily = wtc.taskFamily;
        fallbackPlan.routingReason = wtc.routingReason;
        fallbackPlan.selectedPrimaryTool = wtc.selectedPrimaryTool;
        if (wtc.taskFamily !== 'non_web') {
          logger.info(`[${structuredTs()}] [R24-T1] Web task detected on fallback: family=${wtc.taskFamily} tool=${wtc.selectedPrimaryTool}`);
          emitEvent(sessionKey, taskId, 'web_task_routing', wtc);
        }
      } catch (wtErr) {
        logger.warn(`[${structuredTs()}] [R24-T1] Web task classification failed on fallback (non-fatal): ${wtErr.message}`);
      }
      return fallbackPlan;
    }

    // [L4-PR2] Normalize parallel/failure fields for strict-schema and legacy/fallback plans.
    normalizePlanStepContract(plan);

    // [R22-T1a] Classify web task family and attach to plan
    let webTaskClassification = { taskFamily: 'non_web', routingReason: '', selectedPrimaryTool: 'none' };
    try {
      webTaskClassification = classifyWebTaskFamily(userGoal, taskType, plan.steps);
      plan.taskFamily = webTaskClassification.taskFamily;
      plan.routingReason = webTaskClassification.routingReason;
      plan.selectedPrimaryTool = webTaskClassification.selectedPrimaryTool;
      if (webTaskClassification.taskFamily !== 'non_web') {
        logger.info(`[${structuredTs()}] [R22-T1a] Web task detected: family=${webTaskClassification.taskFamily} tool=${webTaskClassification.selectedPrimaryTool}`);
        // Emit routing event for persistence
        emitEvent(sessionKey, taskId, 'web_task_routing', webTaskClassification);
        // [R37-T3] Inject browser into plan steps when web task requires browser
        if (webTaskClassification.selectedPrimaryTool === 'browser' && plan.steps && plan.steps.length > 0) {
          let browserInjected = false;
          for (const step of plan.steps) {
            const tools = step.tools || [];
            const hasWebTool = tools.some(t => /web_fetch|web_search|browser|curl|fetch/i.test(t));
            const hasBrowser = tools.some(t => /browser/i.test(t));
            if (hasWebTool && !hasBrowser) {
              step.tools = [...tools, 'browser'];
              browserInjected = true;
            }
            // Also inject browser for steps that mention web/page/site in title
            if (!hasBrowser && /web|page|site|url|browse|navigate|visit|open|check|verify|extract|scrape/i.test(step.title || '')) {
              if (!step.tools) step.tools = [];
              if (!step.tools.includes('browser')) {
                step.tools.push('browser');
                browserInjected = true;
              }
            }
          }
          if (browserInjected) {
            logger.info(`[${structuredTs()}] [R37-T3] Injected browser tool into plan steps for web task family=${webTaskClassification.taskFamily}`);
          }
        }
      }
    } catch (wtErr) {
      logger.warn(`[${structuredTs()}] [R22-T1a] Web task classification failed (non-fatal): ${wtErr.message}`);
      plan.taskFamily = 'unknown';
      plan.routingReason = '';
      plan.selectedPrimaryTool = '';
    }

    // Enrich with metadata
    plan.version = existingPlan ? existingPlan.version + 1 : 1;
    plan.plan_version = plan.plan_version || plan.version;
    plan.reflection = plan.reflection || '';
    plan.createdAt = existingPlan ? existingPlan.createdAt : Date.now();
    plan.updatedAt = Date.now();

    // Validate
    if (!plan.steps || plan.steps.length === 0) {
      logger.warn(`[${structuredTs()}] [planner] LLM produced plan with no steps`);
      return null;
    }

    // [R6-Task2] Log step count quality metric
    const guidance = TASK_TYPE_STEP_GUIDANCE[taskType] || TASK_TYPE_STEP_GUIDANCE.reasoning;
    if (plan.steps.length < guidance.min && taskType !== 'chat') {
      logger.warn(`[${structuredTs()}] [R6-plan-quality] Plan has ${plan.steps.length} steps but taskType=${taskType} expects min=${guidance.min}. Consider replanning.`);
    }
    logger.info(`[${structuredTs()}] [R6-plan-quality] taskType=${taskType} steps=${plan.steps.length} expected=${guidance.min}-${guidance.max} tools=${plan.steps.map(s => (s.tools||[]).join(',')).join('|')}`);

    // [R8-Task3] Log R8-specific fields
    logger.info(`[${structuredTs()}] [R8-planner] JSON plan v${plan.plan_version}: ${plan.steps.length} steps, method=${method}`);
    logger.info(`[${structuredTs()}] [R8-planner] reflection: "${(plan.reflection || '').substring(0, 120)}"`);

    // Cache
    _planCache.set(taskId, plan);
    _sendPlanProgress(taskId, plan, "plan_generated");
    _sessionKeyCache.set(taskId, sessionKey); // [R9-Task2]
    persistPlanToDb(taskId, sessionKey, plan); // [R8-Task4]

    // [R25-T5] Generate structured numbered planText (Manus-style)
    const planText = plan.steps
      .map((s, i) => `${i + 1}. ${s.title || s.description || 'Step ' + (i + 1)}`)
      .join('\n');
    plan.planText = planText;
    logger.info(`[${structuredTs()}] [R25-T5] Structured planText generated: ${plan.steps.length} steps`);

    // [方案A] Infer taskPhase for each step based on tools array
    // This enables smartRouteByPhase() to pick the right model per step
    // Inference logic (priority order): coding → sysadmin → review → summary → qa → planning
    try {
      const _TOOL_CODE_SIGNALS = new Set(['write', 'exec', 'shell', 'file_write', 'edit_file', 'shell_exec', 'code_exec']);
      const _TOOL_SYSADMIN_SIGNALS = new Set(['shell', 'shell_exec', 'inspect', 'systemctl', 'docker', 'journalctl']);
      const _TOOL_READ_SIGNALS = new Set(['read', 'inspect', 'grep', 'cat', 'head', 'tail', 'wc', 'ls']);
      const _TOOL_WEB_SIGNALS = new Set(['web_search', 'web_fetch', 'browser']);
      for (const step of plan.steps) {
        const tools = (step.tools || []).map(t => t.toLowerCase());
        const hasCode = tools.some(t => _TOOL_CODE_SIGNALS.has(t));
        const hasSysadmin = tools.some(t => _TOOL_SYSADMIN_SIGNALS.has(t));
        const hasReadOnly = tools.every(t => _TOOL_READ_SIGNALS.has(t) || t === 'none' || t === 'inspect');
        const hasWeb = tools.some(t => _TOOL_WEB_SIGNALS.has(t));
        const titleLower = (step.title || '').toLowerCase();
        if (hasCode) {
          step.taskPhase = 'coding';
        } else if (hasSysadmin) {
          step.taskPhase = 'sysadmin';
        } else if (hasWeb || /search|research|find|look up|retrieve/i.test(titleLower)) {
          step.taskPhase = 'review';
        } else if (hasReadOnly && /review|check|verif|audit|analyz|inspect/i.test(titleLower)) {
          step.taskPhase = 'review';
        } else if (/summary|summariz|总结|汇总|report/i.test(titleLower)) {
          step.taskPhase = 'summary';
        } else if (tools.includes('none') || tools.length === 0) {
          step.taskPhase = 'planning';
        } else {
          step.taskPhase = 'review';  // default: non-coding steps go to lighter model
        }
      }
      // [Iter-67] Force last step to be validation phase (GPT-5.5)
      // This ensures every plan ends with a quality gate using the strongest model
      const lastStep = plan.steps[plan.steps.length - 1];
      if (lastStep) {
        const lastTitle = (lastStep.title || '').toLowerCase();
        if (/verif|validat|confirm|review|check|report|summar|总结|验收|确认/.test(lastTitle)) {
          lastStep.taskPhase = 'validation';
        } else {
          // Even if the planner didn't generate a validation step title, mark the last step
          // so it at least gets the stronger model for final output
          lastStep.taskPhase = 'validation';
          logger.info(`[${structuredTs()}] [Iter-67] Forced last step ${lastStep.id} to validation phase (was: ${lastStep.taskPhase})`);
        }
      }
      // [R70] Set reviewPolicy defaults if not already set by GPT
      for (const step of plan.steps) {
        if (!step.reviewPolicy) {
          if (step.taskPhase === 'coding' || step.taskPhase === 'sysadmin') {
            step.reviewPolicy = step.critical ? 'gpt_review' : 'auto_pass';
          } else if (step.taskPhase === 'validation') {
            step.reviewPolicy = 'gpt_review';
          } else {
            step.reviewPolicy = step.critical ? 'gpt_review' : 'auto_pass';
          }
        }
        // Ensure last step always gets gpt_review
        if (step === plan.steps[plan.steps.length - 1]) {
          step.reviewPolicy = 'gpt_review';
        }
      }
      const phaseSummary = plan.steps.map(s => `${s.id}:${s.taskPhase}(${s.reviewPolicy})`).join(', ');
      logger.info(`[${structuredTs()}] [方案A] Step phases annotated: ${phaseSummary}`);
    } catch (_phaseErr) {
      logger.warn(`[${structuredTs()}] [方案A] Phase annotation failed (non-fatal): ${_phaseErr.message}`);
    }

    // Emit plan_update event
    emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_UPDATE, _r42FormatPlanPayload(plan, {
      planText,
      version: plan.version,
      plan_version: plan.plan_version,
      trigger: existingPlan ? 'replan' : 'initial',
      method,
      taskId
    }));

    // [R9-plan] Log plan registered with version
    logger.info(`[${structuredTs()}] [R9-plan] plan registered version=${plan.plan_version} steps=${plan.steps.length} method=${method}`);
        // [R19-T1] Record hint adoption baseline
    try {
      const guidance = TASK_TYPE_STEP_GUIDANCE[taskType] || TASK_TYPE_STEP_GUIDANCE.reasoning;
      const suggestedToolsFromHint = [];
      const hintStr = guidance.hint || '';
      // Extract tool names from hint text: [tool_name] or "Use tools like x, y, z"
      const bracketTools = hintStr.match(/\[([a-z_]+)\]/g);
      if (bracketTools) bracketTools.forEach(t => suggestedToolsFromHint.push(t.replace(/[\[\]]/g, '')));
      const useToolsMatch = hintStr.match(/Use tools like ([a-z_, ]+)/i);
      if (useToolsMatch) useToolsMatch[1].split(',').forEach(t => { const tt = t.trim(); if (tt) suggestedToolsFromHint.push(tt); });
      // Also extract from plan steps
      const planTools = [...new Set(plan.steps.flatMap(s => s.tools || []))];
      recordHintAdoption({
        taskId, sessionKey, taskType,
        hintText: hintStr.substring(0, 500),
        suggestedTools: suggestedToolsFromHint.length > 0 ? suggestedToolsFromHint : planTools,
      });
    } catch (hintErr) {
      logger.warn(`[${structuredTs()}] [R19-T1] hint recording failed (non-fatal): ${hintErr.message}`);
    }
    logger.info(`[${structuredTs()}] [planner] Plan v${plan.version} generated: ${plan.steps.length} steps, goal="${plan.goal.substring(0, 80)}"`);
    return plan;

  } catch (err) {
    logger.error(`[${structuredTs()}] [planner] Plan generation failed: ${err.message}`);
    // R31-T1: Emit plan_generation_failed event for observability
    try {
      emitEvent(sessionKey, taskId, 'plan_generation_failed', {
        failureReason: err.message,
        fallbackUsed: true,
        timestamp: Date.now()
      });
    } catch (_evtErr) { /* non-fatal */ }
    // Fallback: create a minimal single-step plan
    const fallbackPlan = createFallbackPlan(taskId, userGoal, existingPlan);
    _planCache.set(taskId, fallbackPlan);
    persistPlanToDb(taskId, sessionKey, fallbackPlan); // [R8-Task4]
    emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_UPDATE, {
      plan: fallbackPlan,
      version: fallbackPlan.version,
      trigger: 'fallback'
    });
    return fallbackPlan;
  }
}

export async function replan(taskId, sessionKey, reason, context = {}) {
  const currentPlan = _planCache.get(taskId);
  if (!currentPlan) {
    logger.warn(`[${structuredTs()}] [planner] Cannot replan — no existing plan for task ${taskId}`);
    return null;
  }

  const { recentObservations = [], errors = [], newInfo = '' } = context;

  const observationSummary = recentObservations.map((o, i) =>
    `${i + 1}. [${o.type || 'observation'}] ${typeof o.content === 'string' ? o.content.substring(0, 300) : JSON.stringify(o.content).substring(0, 300)}`
  ).join('\n');

  const errorSummary = errors.map(e =>
    `- Error: ${typeof e === 'string' ? e : e.message || JSON.stringify(e)}`
  ).join('\n');

  const userPrompt = [
    `Goal: ${currentPlan.goal}`,
    `\nPrevious plan_version: ${currentPlan.plan_version || currentPlan.version || 1}`,
    `\nCurrent Plan (v${currentPlan.version}):`,
    JSON.stringify(currentPlan.steps, null, 2),
    `\nReason for replanning: ${reason}`,
    observationSummary ? `\nRecent Observations:\n${observationSummary}` : '',
    errorSummary ? `\nErrors:\n${errorSummary}` : '',
    newInfo ? `\nNew Information:\n${newInfo}` : ''
  ].filter(Boolean).join('\n');

  try {
    // [R8-Task3] Use enhanced JSON schema for replan too
    const response = await invokeStructuredLLM({
      messages: [
        { role: 'system', content: REPLAN_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: R8_PLAN_JSON_SCHEMA
      }
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) return currentPlan;

    // [R8-Task3] Parse with fallback
    const { plan: newPlan, method } = parseR8PlanOutput(content, currentPlan);

    if (!newPlan) {
      logger.warn(`[${structuredTs()}] [R8-planner] Replan parse failed, keeping current plan`);
      return currentPlan;
    }

    newPlan.version = currentPlan.version + 1;
    // [R11-T5] Force plan_version to always increment (LLM may return same or lower value)
    const prevPlanVersion = currentPlan.plan_version || currentPlan.version || 1;
    if (!newPlan.plan_version || newPlan.plan_version <= prevPlanVersion) {
      newPlan.plan_version = prevPlanVersion + 1;
      logger.info(`[${structuredTs()}] [R11-T5] replan: forced plan_version ${prevPlanVersion} \u2192 ${newPlan.plan_version}`);
    }
    newPlan.reflection = newPlan.reflection || `Replan due to: ${reason.substring(0, 100)}`;
    newPlan.createdAt = currentPlan.createdAt;
    newPlan.updatedAt = Date.now();
    newPlan.needsReplan = false;

    _planCache.set(taskId, newPlan);
    _sessionKeyCache.set(taskId, sessionKey); // [R9-Task2]
    persistPlanToDb(taskId, sessionKey, newPlan); // [R8-Task4]
    // [R9-db] Log replan persist
    logger.info(`[${structuredTs()}] [R9-db] replan persisted version=${newPlan.plan_version}`);

    emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_UPDATE, {
      plan: newPlan,
      version: newPlan.version,
      plan_version: newPlan.plan_version,
      trigger: 'replan',
      reason,
      method
    });

    // [R8-Task3] Log replan with R8 fields
    logger.info(`[${structuredTs()}] [R8-planner] Replan v${newPlan.plan_version}: ${newPlan.steps.length} steps, method=${method}`);
    logger.info(`[${structuredTs()}] [R8-planner] replan reflection: "${(newPlan.reflection || '').substring(0, 120)}"`);
    logger.info(`[${structuredTs()}] [planner] Replanned v${newPlan.version}: ${newPlan.steps.length} steps, reason="${reason}"`);
    return newPlan;

  } catch (err) {
    logger.error(`[${structuredTs()}] [planner] Replan failed: ${err.message}`);
    return currentPlan;
  }
}

export async function replanOnFailure(taskId, sessionKey, failedStepId, toolName, errorMsg) {
  const plan = _planCache.get(taskId);
  if (!plan) {
    logger.warn(`[${structuredTs()}] [planner] replanOnFailure: no plan for ${taskId}`);
    return null;
  }
  // Build enriched context
  const completedSteps = plan.steps
    .filter(s => s.status === 'done')
    .map(s => `${s.id}: ${s.title} (${s.output || 'completed'})`)
    .join('\n');
  const failedStep = plan.steps.find(s => s.id === failedStepId);
  const failedStepDesc = failedStep ? failedStep.title : 'unknown step';
  // [Iter-66] Diagnose failure for structured recovery strategy
  const diagnosis = diagnoseFailure(errorMsg, toolName, { attempts: 0 });
  const recoveryHint = diagnosis.recovery.action;
  const reason = `Tool "${toolName}" failed at step ${failedStepId} ("${failedStepDesc}"): ${errorMsg.substring(0, 300)}`;
  logger.info(`[${structuredTs()}] [R5-replan] replan triggered: taskId=${taskId} failedStep=${failedStepId} tool=${toolName} error=${errorMsg.substring(0, 150)} recoveryHint=${recoveryHint}`);
  const newPlan = await replan(taskId, sessionKey, reason, {
    errors: [{ tool: toolName, error: errorMsg, stepId: failedStepId, failureType: diagnosis.failureType, recoveryAction: diagnosis.recovery.action }],
    recentObservations: [],
    newInfo: `Failed step: ${failedStepId} (${failedStepDesc})\nTool: ${toolName}\nError: ${errorMsg}\nFailure type: ${diagnosis.failureType}\nRecovery: ${recoveryHint}\nCompleted steps:\n${completedSteps}`,
  });
  if (newPlan) {
    // [R11-T5] Force plan_version increment if LLM didn't do it correctly
    if (newPlan.plan_version <= (plan.plan_version || plan.version || 1)) {
      const oldVersion = plan.plan_version || plan.version || 1;
      newPlan.plan_version = oldVersion + 1;
      logger.info(`[${structuredTs()}] [R11-T5] Forced plan_version increment: ${oldVersion} \u2192 ${newPlan.plan_version}`);
    }
    logger.info(`[${structuredTs()}] [R5-replan] Plan v${newPlan.plan_version} generated: ${newPlan.steps.length} steps, recovery from step ${failedStepId}`);
    // Count new steps added by replan
    const newSteps = newPlan.steps.filter(s => s.status === 'pending');
    logger.info(`[${structuredTs()}] [R5-replan] registered replan steps: ${newSteps.length} new pending steps, currentStepId=${newPlan.currentStepId}`);
  } else {
    logger.warn(`[${structuredTs()}] [R5-replan] replan failed to produce new plan for ${taskId}`);
  }
  return newPlan;
}
