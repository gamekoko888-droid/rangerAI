/**
 * supervisor-engine.mjs — Supervisor-Worker State Machine Engine
 * 
 * Replaces the Promise-blocking pattern in autonomous-task-worker.mjs
 * with a database-driven tick loop + LLM Supervisor decision engine.
 * 
 * Architecture:
 *   User Request → Supervisor (LLM) → JSON Decision → SubAgent Execution → Loop
 *   
 * Decision types:
 *   { decision: "next",   step: "具体指令" }           → Execute next step
 *   { decision: "retry",  step: "修正指令", reason: "" } → Retry with correction
 *   { decision: "finish", answer: "最终结论" }          → Task complete
 *   { decision: "error",  reason: "错误原因" }          → Unrecoverable error
 * 
 * @version 1.5.0 — S15: Planner module, audit action distinction, plan tracking
 */

import { logger } from '../lib/logger.mjs';
import { query, queryOne, run } from '../db-adapter.mjs';
import fs from 'fs';
import crypto from 'crypto';

const ts = () => new Date().toISOString();
const PREFIX = '[supervisor-engine]';

// ─── Configuration ───────────────────────────────────────────
const CONFIG = {
  MAX_STEPS: 20,              // Maximum steps per task
  MAX_RETRIES_PER_STEP: 2,    // Max retries for a single step
  SUPERVISOR_TIMEOUT_MS: 60000, // Iter-S9: increased to 60s for slow Gateway responses
  STEP_TIMEOUT_MS: 300000,    // SubAgent step execution timeout (5 min)
  COOLDOWN_MS: 3000, // Iter-S9: increased to 3s to avoid Gemini rate limits (plan-driven uses 500ms)
  PLAN_DRIVEN_COOLDOWN_MS: 500, // Faster cooldown for plan-driven mode (Gateway handles rate limits)
  MAX_TASK_DURATION_MS: 30 * 60 * 1000, // 30 min absolute max
};

// ─── Database Schema Init ────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS supervisor_tasks (
    id TEXT PRIMARY KEY,
    chatId TEXT,
    userId TEXT,
    sessionKey TEXT,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    currentStepNum INTEGER DEFAULT 0,
    totalSteps INTEGER DEFAULT 0,
    result TEXT,
    error TEXT,
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    completedAt INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS supervisor_steps (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    stepNum INTEGER NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    retryCount INTEGER DEFAULT 0,
    supervisorDecision TEXT,
    duration INTEGER,
    metadata TEXT DEFAULT '{}',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sv_steps_task ON supervisor_steps(taskId, stepNum)`,
  `CREATE INDEX IF NOT EXISTS idx_sv_tasks_status ON supervisor_tasks(status)`,
];

// Migration definitions (v1.1 + S14)
const MIGRATIONS = [
  { table: 'supervisor_steps', column: 'supervisorDecision', definition: 'TEXT' },
  { table: 'supervisor_tasks', column: 'errorReason', definition: 'TEXT' },
  { table: 'supervisor_tasks', column: 'trigger', definition: "TEXT DEFAULT 'manual'" },
  { table: 'supervisor_tasks', column: 'plan', definition: 'TEXT' },
];

let schemaInitialized = false;

async function ensureSchema() {
  if (schemaInitialized) return;
  try {
    for (const stmt of SCHEMA_STATEMENTS) {
      await run(stmt);
    }
    // Run migrations idempotently — check column existence via PRAGMA (v22.4)
    for (const { table, column, definition } of MIGRATIONS) {
      const cols = await query(`PRAGMA table_info(${table})`);
      if (!cols.some(c => c.name === column)) {
        await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        logger.info(`${PREFIX} Migration: added ${table}.${column}`);
      }
    }
    schemaInitialized = true;
    logger.info(`${PREFIX} Schema initialized (v1.2)`);
  } catch (err) {
    if (err.message?.includes('already exists')) {
      schemaInitialized = true;
      return;
    }
    logger.error(`${PREFIX} Schema init failed: ${err.message}`);
    throw err;
  }
}

// ─── Supervisor LLM Decision Engine ─────────────────────────
const SUPERVISOR_SYSTEM_PROMPT = `你是 RangerAI 的任务主管（Supervisor）。你的职责是分析用户目标和已执行步骤的结果，做出下一步决策。

## 输入
- 用户最终目标
- 已执行的所有步骤历史（包括每步的指令、状态、结果）
- 当前步骤数 / 最大步骤数

## 输出规则
你必须输出严格的 JSON，不要包含任何其他文字。JSON 结构如下：

### 继续执行下一步
{"decision": "next", "step": "下一步的具体指令（要清晰、可执行、包含必要上下文）"}

### 纠错重试上一步
{"decision": "retry", "step": "修正后的指令", "reason": "上一步失败的原因分析"}

### 任务完成
{"decision": "finish", "answer": "最终结论和结果摘要"}

### 不可恢复的错误
{"decision": "error", "reason": "无法继续的原因"}

## 可用工具
SubAgent 拥有以下工具能力，你的 step 指令应当充分利用它们：
- **exec**: 执行 Shell 命令（如 df -h, free -h, curl, python3, ls, cat 等）
- **web_search**: 搜索互联网获取最新信息
- **web_fetch**: 访问指定 URL 获取网页内容
- **read**: 读取服务器上的文件
- **write**: 写入文件到服务器
- **browser**: 浏览器自动化操作

## 内部业务 API（重要）
你可以通过 exec 工具调用本地业务 API 来读写业务数据。这是你最强大的能力之一——不仅能回答问题，还能直接操作业务系统。

**调用方式**：在 step 指令中要求 SubAgent 使用 exec 执行 curl 命令：
  curl -s -H 'x-internal-call: 1' http://127.0.0.1:3002/api/<endpoint>
示例：curl -s -H 'x-internal-call: 1' 'http://127.0.0.1:3002/api/tickets?status=open&limit=5'

### 可用读操作
| 操作 | 路径 |
|------|------|
| 工单列表 | GET /api/tickets?status=open&limit=10 |
| 工单统计 | GET /api/tickets/stats |
| KOL 列表 | GET /api/kols?limit=20 |
| 知识库列表 | GET /api/knowledge?limit=10 |
| 知识库搜索 | POST /api/knowledge/search {query, limit} |
| 用户列表 | GET /api/users |
| 系统状态 | GET /api/system/status |
| 自主任务列表 | GET /api/autonomous-tasks |

### 可用写操作
| 操作 | 方法 | 路径 | Body |
|------|------|------|------|
| 创建工单 | POST | /api/tickets | {title, description, priority, category} |
| 更新工单 | PATCH | /api/tickets/:id | {status, priority, ...} |
| 添加知识库 | POST | /api/knowledge | {title, content, category} |
| 创建 KOL | POST | /api/kols | {name, platform, handle, ...} |
| 更新 KOL | PATCH | /api/kols/:id | {status, notes, ...} |

### 使用规则
1. GET 操作无限制，可自由查询
2. POST/PATCH 写操作：只有当用户任务明确要求写入时才执行
3. 写操作的 step 指令必须包含完整的 curl 命令示例，包括 -X POST -H 'Content-Type: application/json' -H 'x-internal-call: 1' -d '{...}'
4. 优先使用内部 API 获取业务数据，而不是让 SubAgent 猜测

## 决策原则
1. 每个 step 指令必须是原子化的、可独立执行的
2. 不要在一个 step 中塞入多个不相关的操作
3. 如果上一步失败，先分析原因，决定 retry 还是换一种方式（next）
4. 如果已经接近步骤上限，优先输出 finish 总结已有成果
5. 如果目标已经达成，立即输出 finish
6. step 指令要包含足够的上下文，因为 SubAgent 不会看到历史步骤
7. **需要真实数据时，必须在指令中明确要求使用工具**。例如：
   - 查询服务器状态 → "使用 exec 工具执行 df -h 和 free -h 命令，报告真实的磁盘和内存使用数据"
   - 搜索信息 → "使用 web_search 工具搜索'xxx'，汇总搜索结果，每条结果必须包含来源 URL"
   - 读取文件 → "使用 read 工具读取 /path/to/file 的内容"
   - 调用内部 API → "使用 exec 工具执行 curl -s -H 'x-internal-call: 1' http://127.0.0.1:3002/api/..."
8. **禁止让 SubAgent 凭记忆回答需要实时数据的问题**——必须通过工具获取真实数据
9. **web_search 结果必须包含来源 URL**：在搜索指令中明确要求 SubAgent 在每条结果后标注 "来源：[标题](URL)"
10. **web_search 降级策略**：如果 web_search 连续失败 2 次，改用 web_fetch + 指定高质量 URL（如 techcrunch.com、reddit.com 等）作为替代方案
11. **内容创作类任务必须先搜索**：对于 H5页面、网页、报告等内容创作任务，第一步必须使用 web_search 搜索真实信息，禁止让 SubAgent 凭空编造内容。搜索到的信息必须在后续步骤中被引用
12. **H5/网页任务必须包含完整流程**：搜索信息 → 搜索图片素材 → 编写代码 → 部署到静态目录 → 验证可访问 → 提供链接。不能把所有步骤合并为一步
13. **每步指令必须指定工具**：在 step 指令中明确写出"使用 xxx 工具"，不要让 SubAgent 自行判断是否使用工具
14. **上下文传递**：如果上一步搜索到了有用信息，在下一步指令中必须引用这些信息（如"根据上一步搜索到的景点信息..."），确保 SubAgent 能利用之前的成果`;

// ─── S15 P0: Plan Generation ────────────────────────────────
const PLAN_GENERATION_PROMPT = `你是 RangerAI 的任务规划器（Planner）。根据用户目标，生成一个结构化的执行计划。
你的规划方式应该像一个专业的 AI Agent（如 Manus）一样——先搜集信息，再动手执行，最后验证交付。

## 核心原则
- **自主判断步数**：根据任务复杂度自行决定需要多少步骤，不要机械套用固定数量
- **每步有意义**：每个步骤应该是一个有意义的独立工作单元，既不要过于琐碎（如"创建文件夹"），也不要过于笼统（如"完成所有开发"）
- **用户可感知**：每个步骤的描述应该让用户清楚知道正在做什么
- **渐进式交付**：用户应该能看到任务在持续推进，而不是长时间等待
- **合并同类操作**：相似的操作应该合并到一个步骤中（如多个搜索合并、多个代码编写合并）

## 步骤数量指导（非硬性限制，根据实际需要灵活调整）
- 简单任务（查信息、写脚本、单一操作）：3-4 步
- 中等任务（H5页面、调研报告、数据分析）：5-7 步
- 复杂任务（企业官网、多页面应用、深度调研+可视化）：7-10 步
- 判断依据：需要搜索的维度数量、需要编写的代码量、需要验证的环节数

## 输出规则
1. 输出纯 JSON 数组，不要包含任何其他文字或 markdown 标记
2. 每个元素格式：{"stepNum": N, "text": "步骤描述", "status": "pending"}
3. **搜索优先原则**——任何涉及真实世界信息的任务，第一步必须是搜索
4. 每个步骤必须明确标注使用的工具（web_search / web_fetch / exec / write / read / browser）
5. 最后一步通常是"部署并提供访问链接"或"汇总结果并交付"

## 任务类型参考流程（步骤数量根据实际复杂度自行调整）

### 内容创作类（H5页面、网页、报告、文档、PPT）
典型流程：搜索真实信息 → 搜索素材 → 编写代码 → 完善细节 → 部署验证
- 简单页面（单一主题）可以 4-5 步完成
- 复杂页面（多模块、多交互）可能需要 6-8 步

### 企业官网/品牌网站类
典型流程：调研企业信息 → 搜索设计参考和素材 → 编写核心页面 → 编写辅助区域 → 添加交互和适配 → 部署验证
- 简单展示站可以 5-6 步完成
- 多页面功能站可能需要 8-10 步

### 信息搜集类（新闻、调研、分析、竞品分析）
典型流程：广泛搜索 → 深入搜索 → 访问来源 → 分析整理 → 生成报告
- 简单查询 3-4 步即可
- 深度调研可能需要 5-7 步

### 系统运维类（服务器检查、部署、修复、监控）
典型流程：检查状态 → 执行操作 → 验证结果 → 汇总报告
- 通常 3-5 步

### 数据处理类（爬取、批量处理、数据分析）
典型流程：获取数据 → 处理数据 → 保存结果 → 分析总结
- 通常 3-5 步，复杂分析可能 6-7 步

## 示例

### 示例1：系统运维
用户目标："检查服务器磁盘使用率，如果超过80%则清理日志"
输出：
[{"stepNum":1,"text":"使用 exec 工具执行 df -h 获取磁盘使用率数据","status":"pending"},{"stepNum":2,"text":"分析磁盘使用数据，判断是否超过80%","status":"pending"},{"stepNum":3,"text":"如果超过80%，使用 exec 工具清理 /opt/logs/ 下30天前日志","status":"pending"},{"stepNum":4,"text":"使用 exec 工具再次执行 df -h 确认释放空间","status":"pending"},{"stepNum":5,"text":"汇总结果报告","status":"pending"}]

### 示例2：内容创作（简单H5页面，5步）
用户目标："做一个深圳旅游的H5页面"
输出：
[{"stepNum":1,"text":"使用 web_search 搜索深圳必去景点、特色美食、交通指南、旅游攻略等真实信息","status":"pending"},{"stepNum":2,"text":"使用 web_search 搜索深圳标志性景点的高清图片URL素材","status":"pending"},{"stepNum":3,"text":"使用 write 工具编写H5页面完整代码（HTML结构、CSS样式、头部Hero区域、景点介绍、美食推荐等所有内容区域）","status":"pending"},{"stepNum":4,"text":"使用 write 工具完善页面细节（响应式移动端适配、交互动效、底部信息区域）","status":"pending"},{"stepNum":5,"text":"使用 exec 工具部署H5文件到 /opt/rangerai-agent/public/ 并验证可访问，提供访问链接","status":"pending"}]

### 示例3：企业官网（复杂项目，8步）
用户目标："开发一个XX公司的官网，包含产品展示、团队介绍、新闻动态、联系我们等多个模块"
输出：
[{"stepNum":1,"text":"使用 web_search 搜索XX公司的基本信息、主营业务、产品服务、企业文化","status":"pending"},{"stepNum":2,"text":"使用 web_search 搜索XX公司的产品图片、品牌素材URL和同行业优秀官网设计参考","status":"pending"},{"stepNum":3,"text":"使用 write 工具搭建官网HTML框架和全局CSS样式系统（配色方案、字体、布局网格）","status":"pending"},{"stepNum":4,"text":"使用 write 工具编写首页核心区域（导航栏、Hero区域、产品展示卡片）","status":"pending"},{"stepNum":5,"text":"使用 write 工具编写团队介绍和新闻动态区域","status":"pending"},{"stepNum":6,"text":"使用 write 工具编写关于我们、联系方式和页面底部区域","status":"pending"},{"stepNum":7,"text":"使用 write 工具添加响应式移动端适配、交互动效和页面过渡效果","status":"pending"},{"stepNum":8,"text":"使用 exec 工具部署官网到 /opt/rangerai-agent/public/ 并验证PC版和移动版可正常访问，提供链接","status":"pending"}]

### 示例4：信息搜集（简单查询，4步）
用户目标："搜索2025年最新的AI新闻并写总结"
输出：
[{"stepNum":1,"text":"使用 web_search 搜索 2025年最新AI新闻 和 AI industry news 2025 获取中英文来源的全面信息","status":"pending"},{"stepNum":2,"text":"使用 web_fetch 访问搜索结果中最重要的2-3个来源URL获取详细内容","status":"pending"},{"stepNum":3,"text":"整理和分析所有搜集到的AI新闻信息","status":"pending"},{"stepNum":4,"text":"生成结构化的AI新闻总结报告并交付","status":"pending"}]

### 示例5：简单任务（3步）
用户目标："帮我查一下今天的天气"
输出：
[{"stepNum":1,"text":"使用 web_search 搜索今日天气预报信息","status":"pending"},{"stepNum":2,"text":"整理天气数据（温度、湿度、风力、穿衣建议）","status":"pending"},{"stepNum":3,"text":"汇总天气信息并交付给用户","status":"pending"}]`;

/**
 * Generate a structured execution plan for a task goal.
 * S15 P0: Core Planner module — generates numbered plan items before execution.
 */

// Helper: extract first valid JSON object/array from LLM response (ignores trailing text)

function _repairJSON(jsonStr) {
  let s = jsonStr;
  // Fix control characters inside strings
  s = s.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return "";
  });
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Try parsing as-is first
  try { JSON.parse(s); return s; } catch(e) {
    // Try to close truncated JSON
    let inStr = false;
    let esc = false;
    const stack = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") stack.push("}");
      if (ch === "[") stack.push("]");
      if (ch === "}" || ch === "]") stack.pop();
    }
    if (inStr) s += '"';
    while (stack.length > 0) s += stack.pop();
    try { JSON.parse(s); return s; } catch(e2) { return jsonStr; }
  }
}

function _extractJSON(raw) {
  let s = raw.trim();
  if (s.startsWith('`' + '`' + '`')) {
    s = s.replace(/^`{3}(?:json)?\n?/, '').replace(/\n?`{3}$/, '');
  }
  const startIdx = s.search(/[{\[]/);
  if (startIdx === -1) throw new Error('No JSON found in LLM response');
  const opener = s[startIdx];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.substring(startIdx, i + 1);
    }
  }
  return s;
}

async function generatePlan(goal, onPlanProgress) {
  const MAX_PLAN_RETRIES = 2;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_PLAN_RETRIES; attempt++) {
    try {
      const CONFIG_PATH = '/home/admin/.openclaw/openclaw.json';
      let gatewayToken = '';
      let gatewayPort = 18789;
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        gatewayToken = config?.gateway?.auth?.token || '';
        gatewayPort = config?.gateway?.port || 18789;
      } catch { /* use defaults */ }
      if (!gatewayToken) {
        logger.warn(`${PREFIX} generatePlan: Gateway token not configured, skipping plan generation`);
        return null;
      }
      onPlanProgress?.('llm_call');
      // S17: Quick Gateway health pre-check (3s timeout) to avoid long waits
      if (attempt === 1) {
        try {
          const healthResp = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${gatewayToken}` },
            signal: AbortSignal.timeout(3000),
          });
          if (!healthResp.ok) {
            logger.warn(`${PREFIX} Gateway health check failed: ${healthResp.status}`);
            throw new Error(`Gateway not healthy: ${healthResp.status}`);
          }
          logger.info(`${PREFIX} Gateway health check passed`);
        } catch (healthErr) {
          if (healthErr.name === 'TimeoutError') {
            logger.warn(`${PREFIX} Gateway health check timed out (3s) — Gateway may be busy`);
          } else if (healthErr.message?.includes('not healthy')) {
            throw healthErr;
          }
        }
      }
      // S19: Use stream:false (non-streaming) — same pattern as supervisorDecide
      // Gateway's SSE event routing only works with registered WebSocket handlers.
      // stream:true sends data via SSE events that get discarded as "UNREGISTERED".
      // stream:false returns a standard HTTP JSON response that works with fetch.
      const PLAN_TIMEOUT_MS = 30000;
      logger.info(`${PREFIX} Calling Gateway for plan generation (timeout=${PLAN_TIMEOUT_MS}ms, stream=false, attempt ${attempt}/${MAX_PLAN_RETRIES})`);
      const planStartTime = Date.now();
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${gatewayToken}`,
          },
          body: JSON.stringify({
            model: 'openclaw',
            messages: [
              { role: 'system', content: PLAN_GENERATION_PROMPT },
              { role: 'user', content: `用户目标：${goal}` },
            ],
            max_tokens: 1500,
            temperature: 0.1,
            stream: false,
          }),
          signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
        }
      );
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Gateway API error: ${response.status} ${response.statusText} ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      const planDuration = Date.now() - planStartTime;
      logger.info(`${PREFIX} Plan LLM response received in ${planDuration}ms (${(content || '').length} chars). First 300: ${(content || '').substring(0, 300)}`);
      if (!content) throw new Error('Empty LLM response for plan generation');
      onPlanProgress?.('parsing');
      const jsonStr = _extractJSON(content);
      let plan;
      try {
        plan = JSON.parse(jsonStr);
      } catch (parseErr) {
        const repaired = _repairJSON(jsonStr);
        try {
          plan = JSON.parse(repaired);
          logger.info(`${PREFIX} Plan JSON repaired successfully`);
        } catch (repairErr) {
          throw parseErr;
        }
      }
      if (!Array.isArray(plan)) {
        logger.warn(`${PREFIX} Plan parsed but not an array. Type: ${typeof plan}, keys: ${Object.keys(plan || {}).join(',')}`);
        throw new Error('Plan is not a valid array');
      }
      if (plan.length === 0) {
        logger.warn(`${PREFIX} Plan parsed as empty array`);
        throw new Error('Plan is an empty array');
      }
      // Normalize plan items
      const normalized = plan.map((item, idx) => ({
        stepNum: item.stepNum || idx + 1,
        text: item.text || item.description || `步骤 ${idx + 1}`,
        status: 'pending',
      }));
      logger.info(`${PREFIX} Plan generated: ${normalized.length} steps for goal "${goal.substring(0, 80)}"`);
      return normalized;
    } catch (err) {
      lastError = err;
      const isRetryable = err.message.includes('timeout') || err.message.includes('aborted') ||
        err.message.includes('429') || err.message.includes('502') || err.message.includes('503') ||
        err.message.includes('ECONNREFUSED') || err.message.includes('Empty LLM') ||
        err.message.includes('No JSON found');
      if (isRetryable && attempt < MAX_PLAN_RETRIES) {
        logger.warn(`${PREFIX} Plan generation attempt ${attempt} failed (retryable): ${err.message}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      logger.warn(`${PREFIX} Plan generation failed after ${attempt} attempt(s): ${err.message}`);
      break;
    }
  }
  return null;
}

/**
 * Call Supervisor LLM to get next decision.
 * Uses Gateway local API (lightweight, no tools) for fast decisions.
 */
async function supervisorDecide({ goal, steps, currentStep, maxSteps, plan }) {
  const stepsHistory = steps.map(s => ({
    stepNum: s.stepNum,
    instruction: s.instruction,
    status: s.status,
    result: s.result ? (s.result.length > 800 ? s.result.substring(0, 800) + '...' : s.result) : null,
    error: s.error || null,
  }));
  
  // S11 P0: Build previous step result summary for context passing
  let prevResultSummary = '';
  if (steps.length > 0) {
    const lastCompleted = [...steps].reverse().find(s => s.status === 'completed' && s.result);
    if (lastCompleted) {
      const truncResult = lastCompleted.result.length > 500 
        ? lastCompleted.result.substring(0, 500) + '...' 
        : lastCompleted.result;
      prevResultSummary = `\n## 上一步结果摘要\n步骤 ${lastCompleted.stepNum} 的实际输出：\n${truncResult}\n→ 你可以在下一步指令中引用上述具体数据值（如 "磁盘 55%"），而不是笼统描述。`;
    }
  }
  
  // S15 P0: Build plan status block for context injection
  let planStatusBlock = '';
  if (plan && Array.isArray(plan) && plan.length > 0) {
    const planLines = plan.map(p => {
      const marker = p.status === 'done' ? '[x]' : '[ ]';
      return `${p.stepNum}. ${marker} ${p.text}`;
    }).join('\n');
    planStatusBlock = `\n## 任务计划（全局视图）\n${planLines}\n→ 请根据计划进度决策下一步，已完成的步骤不要重复执行。如果所有计划项已完成，输出 finish。`;
  }

  const userMessage = `## 用户目标
${goal}
## 已执行步骤 (${currentStep}/${maxSteps})
${stepsHistory.length === 0 ? '（尚未执行任何步骤）' : JSON.stringify(stepsHistory, null, 2)}${prevResultSummary}${planStatusBlock}
请做出决策。你必须且只能输出一个 JSON 对象，不要输出任何其他文字。格式：{"decision":"next","step":"..."} 或 {"decision":"finish","answer":"..."} 或 {"decision":"retry","step":"..."}`;
  // Iter-S7: Retry logic — retry once on transient errors (timeout, 404, 502, 503)
  const MAX_LLM_RETRIES = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
    try {
      const CONFIG_PATH_D = '/home/admin/.openclaw/openclaw.json';
      let gatewayToken_d = '';
      let gatewayPort_d = 18789;
      try {
        const config_d = JSON.parse(fs.readFileSync(CONFIG_PATH_D, 'utf-8'));
        gatewayToken_d = config_d?.gateway?.auth?.token || '';
        gatewayPort_d = config_d?.gateway?.port || 18789;
      } catch { /* use defaults */ }
      if (!gatewayToken_d) throw new Error('Gateway token not configured for Supervisor');
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort_d}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${gatewayToken_d}`,
          },
          body: JSON.stringify({
            model: 'openclaw',
            messages: [
              { role: 'system', content: SUPERVISOR_SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            max_tokens: 500,
            temperature: 0.1,
            stream: false,
          }),
          signal: AbortSignal.timeout(CONFIG.SUPERVISOR_TIMEOUT_MS),
        }
      );
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Gateway API error: ${response.status} ${response.statusText} ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty LLM response from Gateway');
      const jsonStr = _extractJSON(content);
      let decision;
      try {
        decision = JSON.parse(jsonStr);
      } catch (parseErr) {
        const repaired = _repairJSON(jsonStr);
        try {
          decision = JSON.parse(repaired);
          logger.info(`${PREFIX} JSON repaired successfully`);
        } catch (repairErr) {
          throw parseErr;
        }
      }
      logger.info(`${PREFIX} Supervisor decision (via Gateway, attempt ${attempt}): ${JSON.stringify(decision).substring(0, 200)}`);
      return decision;
    } catch (err) {
      lastError = err;
      const isRetryable = err.message.includes('timeout') || err.message.includes('aborted') ||
        err.message.includes('429') || err.message.includes('rate limit') ||
        err.message.includes('404') || err.message.includes('502') || err.message.includes('503') ||
        err.message.includes('ECONNREFUSED') || err.message.includes('ECONNRESET') ||
        err.message.includes('No JSON found') || err.message.includes('Unexpected') || err.message.includes('Expected') || err.message.includes('position') ||
        err.message.includes('Empty LLM response');
      if (isRetryable && attempt < MAX_LLM_RETRIES) {
        logger.warn(`${PREFIX} Supervisor LLM attempt ${attempt} failed (retryable): ${err.message}`);
        await new Promise(r => setTimeout(r, 15000)); // Iter-S11: 15s backoff to let Gateway failover settle
        continue;
      }
      logger.error(`${PREFIX} Supervisor LLM failed after ${attempt} attempt(s): ${err.message}`);
      break;
    }
  }
  // Fallback logic: when LLM decision parsing fails, use step results as the answer
  if (steps.length === 0) {
    return { decision: 'next', step: `请完成以下任务：${goal}` };
  }
  const completedSteps = steps.filter(s => s.status === 'completed');
  if (completedSteps.length > 0) {
    // Use the last completed step's result as the answer (it contains the actual work output)
    const lastCompleted = completedSteps[completedSteps.length - 1];
    const stepResult = lastCompleted.result || lastCompleted.output || '';
    // If the step result looks like a meaningful response, use it directly
    if (stepResult && stepResult.length > 20) {
      logger.info(`${PREFIX} Using last step result as finish answer (decision parse failed: ${lastError?.message})`);
      return { decision: 'finish', answer: stepResult };
    }
    // Otherwise build a summary from all completed steps
    const summary = completedSteps.map((s, i) => `步骤${i+1}: ${s.instruction || s.step || '已完成'}`).join('\n');
    return { decision: 'finish', answer: `任务已完成 ${completedSteps.length} 个步骤:\n${summary}` };
  }
  return { decision: 'error', reason: `Supervisor LLM 调用失败: ${lastError?.message}` };
}

// ─── Task State Machine ─────────────────────────────────────

/**
 * Create a new supervised task
 */
export async function createTask({ chatId, userId, sessionKey, title, goal, metadata = {}, trigger = 'manual', onPlanProgress }) {
  await ensureSchema();
  const taskId = `sv_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const now = Date.now();
  
  // S14 P1: Store trigger type in metadata for audit trail
  metadata.trigger = trigger;
  
  // S15 P0: Generate structured plan before task execution
  // S16 P1: Strip knowledge context from goal for cleaner plan generation
  // Uses the proven pattern from task-planner.mjs: find [/KNOWLEDGE_CONTEXT] closing tag
  let planGoal = goal;
  
  // Method 1: Find [/KNOWLEDGE_CONTEXT] closing tag (most reliable)
  const ctxEndMarker = '[/KNOWLEDGE_CONTEXT]';
  const ctxEndIdx = planGoal.indexOf(ctxEndMarker);
  if (ctxEndIdx !== -1) {
    planGoal = planGoal.substring(ctxEndIdx + ctxEndMarker.length).trim();
    logger.info(`${PREFIX} Stripped via [/KNOWLEDGE_CONTEXT] tag. Clean goal: "${planGoal.substring(0, 120)}"`);
  } else if (planGoal.includes('[KNOWLEDGE_CONTEXT]')) {
    // Method 2: Regex strip [KNOWLEDGE_CONTEXT]...[/KNOWLEDGE_CONTEXT] block
    planGoal = planGoal.replace(/\[KNOWLEDGE_CONTEXT\][\s\S]*?\[\/KNOWLEDGE_CONTEXT\]/g, '').trim();
    logger.info(`${PREFIX} Stripped via regex. Clean goal: "${planGoal.substring(0, 120)}"`);
  }
  
  // Also strip knowledge_reference and user_memory tags
  const refEndMarker = '</knowledge_reference>';
  const refEndIdx = planGoal.indexOf(refEndMarker);
  if (refEndIdx !== -1) {
    planGoal = planGoal.substring(refEndIdx + refEndMarker.length).trim();
  }
  const memEndMarker = '</user_memory>';
  const memEndIdx = planGoal.indexOf(memEndMarker);
  if (memEndIdx !== -1) {
    planGoal = planGoal.substring(memEndIdx + memEndMarker.length).trim();
  }
  
  // Final fallback: if planGoal is still very long or starts with '[', use the title as goal
  if (!planGoal || planGoal.length < 10 || planGoal.startsWith('[')) {
    planGoal = title || goal.substring(goal.length - 200).trim();
    logger.info(`${PREFIX} Fallback to title/tail for plan goal: "${planGoal.substring(0, 120)}"`);
  }
  
  logger.info(`${PREFIX} Final plan goal (${planGoal.length} chars): "${planGoal.substring(0, 150)}"`);
  
  let plan = null;
  try {
    onPlanProgress?.('analyzing');
    plan = await generatePlan(planGoal, onPlanProgress);
    
    // S18: If plan generation failed or returned too few steps, retry with shorter timeout
    if (!plan || (Array.isArray(plan) && plan.length < 3)) {
      logger.info(`${PREFIX} Plan too short (${plan?.length || 0} steps), retrying with simplified goal (15s timeout)`);
      const simplifiedGoal = planGoal.length > 200 ? planGoal.substring(0, 200) : planGoal;
      plan = await generatePlan(simplifiedGoal, onPlanProgress);
    }
    
    onPlanProgress?.('ready');
  } catch (planErr) {
    logger.warn(`${PREFIX} Plan generation skipped: ${planErr.message}`);
    onPlanProgress?.('skipped');
  }
  
  await run(
    `INSERT INTO supervisor_tasks (id, chatId, userId, sessionKey, title, goal, status, metadata, trigger, plan, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [taskId, chatId, userId, sessionKey, title, goal, JSON.stringify(metadata), trigger, plan ? JSON.stringify(plan) : null, now, now]
  );

  logger.info(`${PREFIX} Task created: ${taskId} — "${title}" (trigger=${trigger}, plan=${plan ? plan.length + ' steps' : 'none'})`);
  return taskId;
}

/**
 * Run the tick loop for a task.
 * 
 * @param {object} params
 * @param {string} params.taskId - Task ID
 * @param {function} params.executeStep - (instruction: string) => Promise<{result?: string, error?: string}>
 * @param {function} params.onProgress - (taskId, event) => void
 * @param {AbortSignal} [params.signal] - Abort signal for cancellation
 */
export async function runTask({ taskId, executeStep, onProgress, signal }) {
  await ensureSchema();
  
  const task = await queryOne('SELECT * FROM supervisor_tasks WHERE id = ?', [taskId]);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // S15 P0: Load plan from DB
  let plan = null;
  try {
    plan = task.plan ? JSON.parse(task.plan) : null;
  } catch (_) { plan = null; }

  await run('UPDATE supervisor_tasks SET status = ?, updatedAt = ? WHERE id = ?',
    ['running', Date.now(), taskId]);
  
  onProgress?.(taskId, { type: 'task_start', title: task.title, goal: task.goal, plan });

  const startTime = Date.now();

  // ─── S16: Plan-Driven Execution Mode ───
  // When a plan exists, execute each plan step sequentially instead of
  // letting the Supervisor freely decide (which often merges steps).
  if (plan && Array.isArray(plan) && plan.length >= 3) {
    logger.info(`${PREFIX} Plan-driven mode: ${plan.length} steps for task ${taskId}`);
    return await _runPlanDriven({ taskId, task, plan, executeStep, onProgress, signal, startTime });
  }

  // ─── Fallback: Supervisor-Driven Mode (original) ───
  logger.info(`${PREFIX} Supervisor-driven mode (no plan or plan too short) for task ${taskId}`);
  return await _runSupervisorDriven({ taskId, task, plan, executeStep, onProgress, signal, startTime });
}

/**
 * Plan-Driven Execution: execute each plan step sequentially.
 * The Supervisor is only called for the final summary (finish decision).
 * This ensures fine-grained step visibility matching Manus's experience.
 */
async function _runPlanDriven({ taskId, task, plan, executeStep, onProgress, signal, startTime }) {
  let stepNum = 0;
  let lastStepResult = null;
  let accumulatedContext = ''; // Pass context between steps

  try {
    for (let planIdx = 0; planIdx < plan.length; planIdx++) {
      const planItem = plan[planIdx];
      
      // ─── Guard checks ───
      if (signal?.aborted) {
        await _finishTask(taskId, 'cancelled', null, '用户取消');
        onProgress?.(taskId, { type: 'task_cancelled' });
        return { status: 'cancelled' };
      }
      if (Date.now() - startTime > CONFIG.MAX_TASK_DURATION_MS) {
        const steps = await _getSteps(taskId);
        const summary = _buildSummary(steps);
        await _finishTask(taskId, 'timeout', summary, '超过最大执行时间(30分钟)');
        onProgress?.(taskId, { type: 'task_timeout', summary });
        return { status: 'timeout', result: summary };
      }

      stepNum++;
      const stepId = `step_${taskId}_${stepNum}`;
      
      // Build instruction from plan item text, enriched with context from previous steps
      let instruction = planItem.text;
      
      // Auto-inject context from previous step results
      if (accumulatedContext && stepNum > 1) {
        instruction += `\n\n【上下文信息】前序步骤已获得的信息：\n${accumulatedContext}`;
      }
      
      // S13 P2: Auto-inject URL reference requirement for search instructions
      const instrLower = instruction.toLowerCase();
      const isSearchStep = /web_search|搜索|search/.test(instrLower);
      const finalInstruction = isSearchStep
        ? instruction + "\n\n【重要】每条搜索结果必须包含来源URL，格式：来源：[标题](URL)，每条引用单独一行。"
        : instruction;

      // Record step in DB
      const decisionJson = JSON.stringify({ decision: 'plan_step', planIdx, text: planItem.text });
      await run(
        `INSERT INTO supervisor_steps (id, taskId, stepNum, instruction, status, retryCount, supervisorDecision, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'running', 0, ?, ?, ?)`,
        [stepId, taskId, stepNum, instruction, decisionJson, Date.now(), Date.now()]
      );

      await run('UPDATE supervisor_tasks SET currentStepNum = ?, totalSteps = ?, updatedAt = ? WHERE id = ?',
        [stepNum, plan.length, Date.now(), taskId]);

      onProgress?.(taskId, {
        type: 'step_start',
        stepNum,
        totalSteps: plan.length,
        instruction: planItem.text.substring(0, 200),
        isRetry: false,
      });

      // ─── Execute SubAgent ───
      const stepStart = Date.now();
      let stepResult;
      try {
        stepResult = await Promise.race([
          executeStep(finalInstruction),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Step execution timeout (5min)')), CONFIG.STEP_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        stepResult = { error: err.message };
      }

      const duration = Date.now() - stepStart;

      if (stepResult.error) {
        await run(
          `UPDATE supervisor_steps SET status = 'failed', error = ?, duration = ?, updatedAt = ? WHERE id = ?`,
          [stepResult.error, duration, Date.now(), stepId]
        );
        onProgress?.(taskId, { type: 'step_failed', stepNum, error: stepResult.error, duration });
        // In plan-driven mode, continue to next step even if one fails (best effort)
        logger.warn(`${PREFIX} Plan step ${stepNum}/${plan.length} failed: ${stepResult.error}`);
      } else {
        const resultStr = typeof stepResult.result === 'string' ? stepResult.result : JSON.stringify(stepResult.result || '');
        await run(
          `UPDATE supervisor_steps SET status = 'completed', result = ?, duration = ?, updatedAt = ? WHERE id = ?`,
          [resultStr, duration, Date.now(), stepId]
        );
        onProgress?.(taskId, { type: 'step_complete', stepNum, duration });
        lastStepResult = resultStr;
        
        // Accumulate context for subsequent steps (keep last 1000 chars)
        if (resultStr && resultStr.length > 10) {
          const contextSnippet = resultStr.length > 500 ? resultStr.substring(0, 500) + '...' : resultStr;
          accumulatedContext = contextSnippet; // Replace with latest (most relevant)
        }
      }

      // Mark plan item as done
      planItem.status = 'done';
      try {
        await run('UPDATE supervisor_tasks SET plan = ?, updatedAt = ? WHERE id = ?',
          [JSON.stringify(plan), Date.now(), taskId]);
      } catch (planErr) {
        logger.warn(`${PREFIX} Plan update failed (non-fatal): ${planErr.message}`);
      }
      onProgress?.(taskId, { type: 'plan_update', plan });

      // Heartbeat
      await heartbeatTask(taskId);
      await new Promise(r => setTimeout(r, CONFIG.PLAN_DRIVEN_COOLDOWN_MS));
    }

    // ─── All plan steps completed: generate final summary ───
    const durationMs = Date.now() - startTime;
    const allSteps = await _getSteps(taskId);
    
    // Plan-driven mode: Build context-rich summary for chat history continuity
    // CRITICAL: This summary is stored in conversationHistory and must contain enough
    // context for subsequent messages to understand what was built/done.
    let finishAnswer = '';
    const completedStepsList = allSteps.filter(s => s.status === 'completed' && !s.instruction?.startsWith('[FINISH]'));
    if (completedStepsList.length > 0) {
      const lastStep = completedStepsList[completedStepsList.length - 1];
      const lastStepText = lastStep.result || '';
      
      // Build a context-rich summary that includes key information from ALL steps
      const stepSummaries = completedStepsList.map(s => {
        const instr = (s.instruction || '').substring(0, 150);
        const res = (s.result || '').trim();
        // Extract file paths, URLs, and key outputs from results
        const paths = res.match(/\/[\w./-]+\.(html|js|css|py|mjs|json|txt|md|png|jpg|svg)/g) || [];
        const urls = res.match(/https?:\/\/[^\s)]+/g) || [];
        const truncRes = res.length > 300 ? res.substring(0, 300) + '...' : res;
        return { stepNum: s.stepNum, instruction: instr, result: truncRes, paths, urls };
      });
      
      // Construct the final answer with full context
      const contextParts = [];
      // Last step result first (the user-facing answer)
      contextParts.push(lastStepText);
      
      // Add execution context as a hidden block for AI continuity
      const allPaths = [...new Set(stepSummaries.flatMap(s => s.paths))];
      const allUrls = [...new Set(stepSummaries.flatMap(s => s.urls))];
      
      const contextBlock = [];
      if (allPaths.length > 0) {
        contextBlock.push('生成的文件：' + allPaths.join('、'));
      }
      if (allUrls.length > 0) {
        contextBlock.push('相关链接：' + allUrls.join('、'));
      }
      // Include step details for context
      const stepDetails = stepSummaries.map(s => 
        `步骤${s.stepNum}（${s.instruction}）：${s.result.substring(0, 200)}`
      ).join('\n');
      contextBlock.push('执行详情：\n' + stepDetails);
      
      // Append context as a structured block
      if (contextBlock.length > 0) {
        contextParts.push('\n\n<task_context>\n' + contextBlock.join('\n') + '\n</task_context>');
      }
      
      finishAnswer = contextParts.join('');
      // Limit total size to prevent bloat
      if (finishAnswer.length > 4000) {
        finishAnswer = finishAnswer.substring(0, 4000) + '\n... (部分上下文已省略)';
      }
    } else {
      finishAnswer = _buildSummary(allSteps);
    }
    logger.info(`${PREFIX} Plan-driven summary (template, no LLM): ${finishAnswer.substring(0, 100)}...`);

    // Record finish step
    try {
      const finishStepId = `step_${taskId}_${stepNum + 1}_finish`;
      const now = Date.now();
      await run(
        `INSERT INTO supervisor_steps (id, taskId, stepNum, instruction, status, supervisorDecision, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
        [finishStepId, taskId, stepNum + 1, '[FINISH] ' + (finishAnswer || '').substring(0, 200), JSON.stringify({ decision: 'finish', answer: finishAnswer }), now, now]
      );
    } catch (dbErr) {
      logger.warn(`${PREFIX} Failed to record finish step (non-fatal): ${dbErr.message}`);
    }

    const stepsSummary = allSteps
      .filter(s => s.status === 'completed' && !s.instruction?.startsWith('[FINISH]'))
      .map(s => ({
        step: s.stepNum,
        instruction: (s.instruction || '').substring(0, 150),
        tool_used: _detectToolUsed(s.instruction),
        result_preview: (s.result || '').substring(0, 200),
        duration_ms: s.duration || 0,
      }));
    const structuredResult = {
      answer: finishAnswer,
      steps_summary: stepsSummary,
      total_steps: stepsSummary.length,
      duration_s: Math.round(durationMs / 1000),
      task_id: taskId,
      execution_mode: 'plan_driven',
    };

    await _persistStepsToMetadata(taskId, allSteps, durationMs);
    await _finishTask(taskId, 'completed', JSON.stringify(structuredResult), null);
    onProgress?.(taskId, { type: 'task_complete', answer: finishAnswer, structured: structuredResult });
    return { status: 'completed', result: finishAnswer, structured: structuredResult };

  } catch (err) {
    logger.error(`${PREFIX} Plan-driven task ${taskId} crashed: ${err.message}\n${err.stack || 'no stack'}`);
    await _finishTask(taskId, 'failed', null, err.message);
    onProgress?.(taskId, { type: 'task_error', reason: err.message });
    return { status: 'failed', error: err.message };
  }
}

/**
 * Supervisor-Driven Execution: original free-form decision loop.
 * Used as fallback when no plan is available.
 */
async function _runSupervisorDriven({ taskId, task, plan, executeStep, onProgress, signal, startTime }) {
  let stepNum = 0;
  let consecutiveRetries = 0;

  try {
    while (true) {
      // ─── Guard checks ───
      if (signal?.aborted) {
        await _finishTask(taskId, 'cancelled', null, '用户取消');
        onProgress?.(taskId, { type: 'task_cancelled' });
        return { status: 'cancelled' };
      }

      if (Date.now() - startTime > CONFIG.MAX_TASK_DURATION_MS) {
        const steps = await _getSteps(taskId);
        const summary = _buildSummary(steps);
        await _finishTask(taskId, 'timeout', summary, '超过最大执行时间(30分钟)');
        onProgress?.(taskId, { type: 'task_timeout', summary });
        return { status: 'timeout', result: summary };
      }

      if (stepNum >= CONFIG.MAX_STEPS) {
        const steps = await _getSteps(taskId);
        const summary = _buildSummary(steps);
        await _finishTask(taskId, 'completed', summary, null);
        onProgress?.(taskId, { type: 'task_max_steps', summary });
        return { status: 'completed', result: summary };
      }

      if (consecutiveRetries >= CONFIG.MAX_RETRIES_PER_STEP) {
        const steps = await _getSteps(taskId);
        const summary = _buildSummary(steps);
        await _finishTask(taskId, 'failed', summary, `连续重试 ${consecutiveRetries} 次仍失败`);
        onProgress?.(taskId, { type: 'task_retry_exhausted', summary });
        return { status: 'failed', result: summary, error: `连续重试 ${consecutiveRetries} 次` };
      }

      // ─── TICK: Read DB state ───
      const steps = await _getSteps(taskId);
      
      // ─── TICK: Supervisor decides ───
      onProgress?.(taskId, { type: 'supervisor_thinking', stepNum: stepNum + 1 });
      
      const decision = await supervisorDecide({
        goal: task.goal,
        steps,
        currentStep: stepNum,
        maxSteps: CONFIG.MAX_STEPS,
        plan,
      });

      // ─── Handle decision ───
      switch (decision.decision) {
        case 'finish': {
          // Record terminal decision for audit trail (with error protection)
          try {
            const finishStepId = `step_${taskId}_${stepNum + 1}_finish`;
            const now = Date.now();
            await run(
              `INSERT INTO supervisor_steps (id, taskId, stepNum, instruction, status, supervisorDecision, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
              [finishStepId, taskId, stepNum + 1, '[FINISH] ' + (decision.answer || '').substring(0, 200), JSON.stringify(decision), now, now]
            );
          } catch (dbErr) {
            logger.warn(`${PREFIX} Failed to record finish step (non-fatal): ${dbErr.message}`);
          }
          
          // S12 P0: Build structured result payload
          const durationMs = Date.now() - startTime;
          const allSteps = await _getSteps(taskId);
          const stepsSummary = allSteps
            .filter(s => s.status === 'completed' && !s.instruction?.startsWith('[FINISH]'))
            .map(s => ({
              step: s.stepNum,
              instruction: (s.instruction || '').substring(0, 150),
              tool_used: _detectToolUsed(s.instruction),
              result_preview: (s.result || '').substring(0, 200),
              duration_ms: s.duration || 0,
            }));
          const structuredResult = {
            answer: decision.answer,
            steps_summary: stepsSummary,
            total_steps: stepsSummary.length,
            duration_s: Math.round(durationMs / 1000),
            task_id: taskId,
          };
          
          // S12 P1: Persist steps to metadata for history
          await _persistStepsToMetadata(taskId, allSteps, durationMs);
          
          await _finishTask(taskId, 'completed', JSON.stringify(structuredResult), null);
          onProgress?.(taskId, { type: 'task_complete', answer: decision.answer, structured: structuredResult });
          return { status: 'completed', result: decision.answer, structured: structuredResult };
        }

        case 'error': {
          try {
            const errStepId = `step_${taskId}_${stepNum + 1}_error`;
            const now = Date.now();
            await run(
              `INSERT INTO supervisor_steps (id, taskId, stepNum, instruction, status, supervisorDecision, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)`,
              [errStepId, taskId, stepNum + 1, '[ERROR] ' + (decision.reason || '').substring(0, 200), JSON.stringify(decision), now, now]
            );
          } catch (dbErr) {
            logger.warn(`${PREFIX} Failed to record error step (non-fatal): ${dbErr.message}`);
          }
          await _finishTask(taskId, 'failed', null, decision.reason);
          onProgress?.(taskId, { type: 'task_error', reason: decision.reason });
          return { status: 'failed', error: decision.reason };
        }

        case 'next':
        case 'retry': {
          if (decision.decision === 'retry') {
            consecutiveRetries++;
          } else {
            consecutiveRetries = 0;
          }

          stepNum++;
          const stepId = `step_${taskId}_${stepNum}`;
          const instruction = decision.step || task.goal;
          // S13 P2: Auto-inject URL reference requirement for search instructions
          const instrLower = instruction.toLowerCase();
          const isSearchStep = /web_search|搜索|search/.test(instrLower);
          const finalInstruction = isSearchStep
            ? instruction + "\n\n【重要】每条搜索结果必须包含来源URL，格式：来源：[标题](URL)，每条引用单独一行。"
            : instruction;
          
          const decisionJson = JSON.stringify(decision);
          await run(
            `INSERT INTO supervisor_steps (id, taskId, stepNum, instruction, status, retryCount, supervisorDecision, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
            [stepId, taskId, stepNum, instruction, decision.decision === 'retry' ? 1 : 0, decisionJson, Date.now(), Date.now()]
          );

          await run('UPDATE supervisor_tasks SET currentStepNum = ?, totalSteps = ?, updatedAt = ? WHERE id = ?',
            [stepNum, stepNum, Date.now(), taskId]);

          onProgress?.(taskId, {
            type: 'step_start',
            stepNum,
            instruction: instruction.substring(0, 200),
            isRetry: decision.decision === 'retry',
          });

          // ─── Execute SubAgent via Gateway ───
          const stepStart = Date.now();
          let stepResult;
          
          try {
            stepResult = await Promise.race([
              executeStep(finalInstruction),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Step execution timeout (5min)')), CONFIG.STEP_TIMEOUT_MS)
              ),
            ]);
          } catch (err) {
            stepResult = { error: err.message };
          }

          const duration = Date.now() - stepStart;

          if (stepResult.error) {
            await run(
              `UPDATE supervisor_steps SET status = 'failed', error = ?, duration = ?, updatedAt = ? WHERE id = ?`,
              [stepResult.error, duration, Date.now(), stepId]
            );
            onProgress?.(taskId, { type: 'step_failed', stepNum, error: stepResult.error, duration });
          } else {
            const resultStr = typeof stepResult.result === 'string' ? stepResult.result : JSON.stringify(stepResult.result || '');
            await run(
              `UPDATE supervisor_steps SET status = 'completed', result = ?, duration = ?, updatedAt = ? WHERE id = ?`,
              [resultStr, duration, Date.now(), stepId]
            );
            onProgress?.(taskId, { type: 'step_complete', stepNum, duration });
          }

          // S15 P0: Update plan item status after step completion
          if (plan && Array.isArray(plan) && stepNum <= plan.length) {
            // Mark the corresponding plan item as done
            // Use fuzzy matching: mark the first pending item as done
            const pendingItem = plan.find(p => p.status === 'pending');
            if (pendingItem) {
              pendingItem.status = 'done';
              // Persist updated plan to DB
              try {
                await run('UPDATE supervisor_tasks SET plan = ?, updatedAt = ? WHERE id = ?',
                  [JSON.stringify(plan), Date.now(), taskId]);
              } catch (planErr) {
                logger.warn(`${PREFIX} Plan update failed (non-fatal): ${planErr.message}`);
              }
              onProgress?.(taskId, { type: 'plan_update', plan });
            }
          }

          // Heartbeat: update updatedAt to prevent stale detection
          await heartbeatTask(taskId);
          await new Promise(r => setTimeout(r, CONFIG.COOLDOWN_MS));
          break;
        }

        default: {
          logger.warn(`${PREFIX} Unknown decision: ${decision.decision}`);
          await _finishTask(taskId, 'failed', null, `Unknown decision: ${decision.decision}`);
          return { status: 'failed', error: `Unknown decision: ${decision.decision}` };
        }
      }
    }
  } catch (err) {
    logger.error(`${PREFIX} Task ${taskId} crashed: ${err.message}\n${err.stack || 'no stack'}`);
    await _finishTask(taskId, 'failed', null, err.message);
    onProgress?.(taskId, { type: 'task_error', reason: err.message });
    return { status: 'failed', error: err.message };
  }
}

// ─── Internal Helpers ────────────────────────────────────────

// S12 P0: Detect which tool was used based on instruction text
function _detectToolUsed(instruction) {
  if (!instruction) return 'llm';
  const lower = instruction.toLowerCase();
  if (/\bexec\b|\bshell\b|\b命令\b|\bdf\b|\bfree\b|\bcurl\b|\bls\b|\bcat\b/.test(lower)) return 'exec';
  if (/\bweb_search\b|\b搜索\b|\bsearch\b/.test(lower)) return 'web_search';
  if (/\bweb_fetch\b|\b访问.*url\b|\bfetch\b/.test(lower)) return 'web_fetch';
  if (/\bread\b|\b读取\b|\b文件\b/.test(lower)) return 'read';
  if (/\bwrite\b|\b写入\b/.test(lower)) return 'write';
  if (/\bbrowser\b|\b浏览器\b/.test(lower)) return 'browser';
  return 'llm';
}

// S12 P1: Persist step details to task metadata for history survival across restarts
async function _persistStepsToMetadata(taskId, steps, durationMs) {
  try {
    const task = await queryOne('SELECT metadata FROM supervisor_tasks WHERE id = ?', [taskId]);
    const existing = JSON.parse(task?.metadata || '{}');
    existing.steps = steps.map(s => ({
      stepNum: s.stepNum,
      instruction: s.instruction,
      status: s.status,
      result: s.result,
      error: s.error,
      duration: s.duration,
      retryCount: s.retryCount || 0,
      tool_used: _detectToolUsed(s.instruction),
      createdAt: s.createdAt,
    }));
    existing.duration_ms = durationMs;
    existing.completed_at = Date.now();
    await run('UPDATE supervisor_tasks SET metadata = ? WHERE id = ?', [JSON.stringify(existing), taskId]);
  } catch (err) {
    logger.warn(`${PREFIX} Failed to persist steps to metadata (non-fatal): ${err.message}`);
  }
}

async function _getSteps(taskId) {
  return await query(
    'SELECT * FROM supervisor_steps WHERE taskId = ? ORDER BY stepNum ASC',
    [taskId]
  );
}

function _buildSummary(steps) {
  const completed = steps.filter(s => s.status === 'completed');
  if (completed.length === 0) return '未完成任何步骤';
  const lines = completed.map(s => {
    const result = (s.result || '').trim();
    const truncated = result.length > 500 ? result.substring(0, 500) + '...' : result;
    return `**步骤 ${s.stepNum}：** ${(s.instruction || '').substring(0, 100)}\n${truncated}`;
  });
  return lines.join('\n\n---\n\n');
}

// S14 P0: Classify error reason from error text
function _classifyErrorReason(error, status) {
  if (!error) return null;
  if (status === 'completed') return null;
  if (status === 'cancelled') return 'cancelled';
  const lower = (error || '').toLowerCase();
  if (status === 'timeout' || /timeout|超时|timed out|超过最大执行时间/.test(lower)) return 'timeout';
  if (/tool_error|step execution|exec.*fail|command.*fail/.test(lower)) return 'tool_error';
  if (/llm.*refused|content.*policy|safety|blocked|refused/.test(lower)) return 'llm_refused';
  if (/api.*error|gateway.*error|404|502|503|500|ECONNREFUSED|ECONNRESET|fetch.*fail/.test(lower)) return 'api_error';
  if (/stale|heartbeat|orphan|restart/.test(lower)) return 'stale_recovery';
  if (/retry.*次|连续重试/.test(lower)) return 'retry_exhausted';
  return 'unknown';
}

async function _finishTask(taskId, status, result, error) {
  const now = Date.now();
  // S14 P0: Classify error reason
  const errorReason = _classifyErrorReason(error, status);
  await run(
    `UPDATE supervisor_tasks SET status = ?, result = ?, error = ?, errorReason = ?, completedAt = ?, updatedAt = ? WHERE id = ?`,
    [status, result, error, errorReason, now, now, taskId]
  );
  logger.info(`${PREFIX} Task ${taskId} finished: status=${status}${errorReason ? ` errorReason=${errorReason}` : ''}`);

  // S14 P1: Write audit_logs record
  try {
    const task = await queryOne('SELECT userId, title, totalSteps, createdAt, metadata FROM supervisor_tasks WHERE id = ?', [taskId]);
    if (task) {
      const durationMs = now - task.createdAt;
      const meta = JSON.parse(task.metadata || '{}');
      const trigger = meta.scheduleId ? 'scheduled' : (meta.trigger || 'manual');
      // Detect tools used from steps
      const steps = await _getSteps(taskId);
      const toolsUsed = [...new Set(steps.map(s => _detectToolUsed(s.instruction)).filter(t => t !== 'llm'))];
      const auditDetail = JSON.stringify({
        title: task.title,
        steps_count: steps.length,
        tools_used: toolsUsed,
        trigger,
        duration_ms: durationMs,
        status,
        errorReason: errorReason || undefined,
      });
      // S15 P1: Use distinct action values for completed vs failed tasks
      const auditAction = (status === 'completed') ? 'supervisor_task_completed' : 'supervisor_task_failed';
      await run(
        `INSERT INTO audit_logs (userId, username, action, target, targetId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [task.userId || 'system', task.userId || 'system', auditAction, 'supervisor_tasks', taskId, auditDetail, new Date(now).toISOString()]
      );
      logger.info(`${PREFIX} Audit log written for task ${taskId} (trigger=${trigger})`);
    }
  } catch (auditErr) {
    logger.warn(`${PREFIX} Failed to write audit log (non-fatal): ${auditErr.message}`);
  }
}

// S14 P0: Export error classifier for external use
export { _classifyErrorReason as classifyErrorReason };

// ─── Query API (for Admin UI) ────────────────────────────────

export async function getTask(taskId) {
  await ensureSchema();
  const task = await queryOne('SELECT * FROM supervisor_tasks WHERE id = ?', [taskId]);
  if (task) {
    task.metadata = JSON.parse(task.metadata || '{}');
    task.steps = await _getSteps(taskId);
    // S15 P0: Parse plan JSON
    try {
      task.plan = task.plan ? JSON.parse(task.plan) : null;
    } catch (_) { task.plan = null; }
  }
  return task;
}

export async function listTasks({ userId, status, limit = 20 } = {}) {
  await ensureSchema();
  let sql = 'SELECT * FROM supervisor_tasks WHERE 1=1';
  const params = [];
  if (userId) { sql += ' AND userId = ?'; params.push(userId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY createdAt DESC LIMIT ?';
  params.push(limit);
  return await query(sql, params);
}

// S12 P3: List all steps for tool usage statistics
export async function listAllSteps({ limit = 500 } = {}) {
  await ensureSchema();
  return await query(
    'SELECT id, taskId, instruction, status FROM supervisor_steps ORDER BY createdAt DESC LIMIT ?',
    [limit]
  );
}

export async function cancelTask(taskId) {
  await ensureSchema();
  const task = await queryOne('SELECT * FROM supervisor_tasks WHERE id = ?', [taskId]);
  if (!task) return false;
  if (['completed', 'failed', 'cancelled'].includes(task.status)) return false;
  await run('UPDATE supervisor_tasks SET status = ?, updatedAt = ? WHERE id = ?',
    ['cancelled', Date.now(), taskId]);
  return true;
}


// ─── P0: Orphan Task Cleanup (run on startup) ───────────────
/**
 * Called on server startup to clean up tasks that were running
 * when the server was last shut down. These tasks are now orphaned
 * because the executing code is dead.
 */
export async function cleanupOrphanTasks() {
  await ensureSchema();
  const now = Date.now();
  const orphans = await query(
    "SELECT * FROM supervisor_tasks WHERE status IN ('running', 'pending')"
  );
  let cleaned = 0;
  for (const task of orphans) {
    const age = now - task.createdAt;
    const ageMin = Math.floor(age / 60000);
    const reason = age > CONFIG.MAX_TASK_DURATION_MS
      ? `Task timeout after ${ageMin} minutes — recovered on restart`
      : `Task orphaned by server restart after ${ageMin} minutes`;
    
    // Build summary from any completed steps
    const steps = await _getSteps(task.id);
    const summary = _buildSummary(steps);
    const result = summary !== '未完成任何步骤' 
      ? `${reason}\n\n已完成的步骤:\n${summary}` 
      : reason;
    
    await run(
      'UPDATE supervisor_tasks SET status = ?, result = ?, error = ?, completedAt = ?, updatedAt = ? WHERE id = ?',
      ['failed', result, reason, now, now, task.id]
    );
    cleaned++;
    logger.info(`${PREFIX} Orphan cleanup: task ${task.id} (age=${ageMin}min) → failed`);
  }
  if (cleaned > 0) {
    logger.info(`${PREFIX} Orphan cleanup: cleaned ${cleaned} orphaned tasks`);
  }
  return cleaned;
}

// ─── P1: Stale Task Recovery (periodic check) ───────────────
/**
 * Periodically checks for tasks that are marked as 'running' but
 * haven't been updated recently (stale/zombie tasks).
 * Called every 5 minutes by background-jobs.
 */
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes without update = stale
export async function recoverStaleTasks() {
  await ensureSchema();
  const now = Date.now();
  const staleTasks = await query(
    "SELECT * FROM supervisor_tasks WHERE status = 'running' AND updatedAt < ?",
    [now - STALE_THRESHOLD_MS]
  );
  let recovered = 0;
  for (const task of staleTasks) {
    const staleMin = Math.floor((now - task.updatedAt) / 60000);
    const steps = await _getSteps(task.id);
    const summary = _buildSummary(steps);
    const reason = `Task stale for ${staleMin} minutes (no heartbeat) — auto-recovered`;
    const result = summary !== '未完成任何步骤'
      ? `${reason}\n\n已完成的步骤:\n${summary}`
      : reason;
    
    await run(
      'UPDATE supervisor_tasks SET status = ?, result = ?, error = ?, completedAt = ?, updatedAt = ? WHERE id = ?',
      ['failed', result, reason, now, now, task.id]
    );
    recovered++;
    logger.info(`${PREFIX} Stale recovery: task ${task.id} (stale ${staleMin}min) → failed`);
  }
  return recovered;
}

// ─── P1: Task Heartbeat (called during execution) ───────────
/**
 * Update the task's updatedAt timestamp to prevent stale detection.
 * Called automatically during step execution.
 */
export async function heartbeatTask(taskId) {
  await run('UPDATE supervisor_tasks SET updatedAt = ? WHERE id = ?', [Date.now(), taskId]);
}

// ─── P1: Health Check ────────────────────────────────────────
export async function getHealth() {
  await ensureSchema();
  const now = Date.now();
  const running = await query("SELECT COUNT(*) as count FROM supervisor_tasks WHERE status = 'running'");
  
  // Helper to compute success rate for a time window
  const rateForWindow = async (ms) => {
    const cutoff = now - ms;
    const c = await query("SELECT COUNT(*) as count FROM supervisor_tasks WHERE status = 'completed' AND completedAt > ?", [cutoff]);
    const f = await query("SELECT COUNT(*) as count FROM supervisor_tasks WHERE status = 'failed' AND completedAt > ?", [cutoff]);
    const total = (c[0]?.count || 0) + (f[0]?.count || 0);
    return {
      completed: c[0]?.count || 0,
      failed: f[0]?.count || 0,
      total,
      rate: total > 0 ? ((c[0]?.count || 0) / total * 100).toFixed(1) : 'N/A',
    };
  };

  const h1  = await rateForWindow(1 * 60 * 60 * 1000);   // 1 hour
  const h24 = await rateForWindow(24 * 60 * 60 * 1000);  // 24 hours
  const d7  = await rateForWindow(7 * 24 * 60 * 60 * 1000); // 7 days
  
  return {
    activeTasks: running[0]?.count || 0,
    completed24h: h24.completed,
    failed24h: h24.failed,
    successRate: h24.rate,
    successRate1h: h1.rate,
    successRate7d: d7.rate,
    completed1h: h1.completed,
    failed1h: h1.failed,
    completed7d: d7.completed,
    failed7d: d7.failed,
    staleThresholdMin: STALE_THRESHOLD_MS / 60000,
    maxTaskDurationMin: CONFIG.MAX_TASK_DURATION_MS / 60000,
  };
}

// ─── S11 P3: Admin Task Cleanup ─────────────────────────────
/**
 * Delete failed tasks older than a given timestamp.
 * Admin-only operation for data hygiene.
 * @param {number} beforeTimestamp - Unix ms timestamp; delete failed tasks completed before this
 * @returns {{ deleted: number }}
 */
export async function cleanupFailedTasks(beforeTimestamp) {
  await ensureSchema();
  // First delete associated steps
  const failedTasks = await query(
    "SELECT id FROM supervisor_tasks WHERE status = 'failed' AND completedAt < ?",
    [beforeTimestamp]
  );
  let deleted = 0;
  for (const t of failedTasks) {
    await run('DELETE FROM supervisor_steps WHERE taskId = ?', [t.id]);
    await run('DELETE FROM supervisor_tasks WHERE id = ?', [t.id]);
    deleted++;
  }
  logger.info(`${PREFIX} Admin cleanup: deleted ${deleted} failed tasks before ${new Date(beforeTimestamp).toISOString()}`);
  return { deleted };
}

export { CONFIG, SUPERVISOR_SYSTEM_PROMPT, generatePlan };
