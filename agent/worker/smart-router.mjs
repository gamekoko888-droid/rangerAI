/**
 * smart-router.mjs — RangerAI 智能路由模块 v3.1
 *
 * 根据用户消息内容和附件类型，自动选择最优 AI 模型。
 * 使用与 root smart-router.mjs classifyTask() 完全一致的 TASK_PATTERNS 和分类逻辑，
 * 确保分类准确性。
 *
 * v3.0 路由表（Ranger 设计）：
 *   code            → deepseek-v4-pro       (thinking: high)
 *   reasoning        → gpt-5.5                (thinking: high)
 *   sysadmin         → deepseek-v4-pro       (thinking: high)
 *   chinese_content  → gpt-5.5  (thinking: high)
 *   research         → gpt-5.5                (thinking: high)
 *   creative         → gpt-5.5  (thinking: high)
 *   chat             → deepseek-v4-pro        (thinking: low)
 *   translation      → deepseek-v4-pro        (thinking: medium)
 *   gaming           → deepseek-v4-pro       (thinking: medium)
 *   image_generation → gemini-3.1-flash-image  (thinking: high)
 *
 * 安全机制：
 *   - 分类置信度 < 0.4 → 回退到 Claude（最安全的默认）
 *   - 单关键词 + 短消息 → 降级为 chat
 *   - 被动疑问句 → chat（不触发工具）
 */

import { logger } from '../lib/logger.mjs';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const Database = _require('better-sqlite3');

// [R48-FIX3] DB-backed session context recovery after service restart
let _taskStateDb = null;
function getTaskStateDb() {
  if (_taskStateDb) return _taskStateDb;
  try {
    const dbPath = '/opt/rangerai-agent/db/rangerai.db';
    _taskStateDb = new Database(dbPath, { readonly: true });
    return _taskStateDb;
  } catch (e) {
    logger.info(`[smart-router] [R48-FIX3] Cannot open task-states DB: ${e.message}`);
    return null;
  }
}
import { TASK_PATTERNS, classifyTask as gatewayClassifyTask } from '../lib/routing-config.mjs';
import { preClassify } from './llm-pre-classifier.mjs';

// ─── Ranger 路由表（模型映射）──────────────────────────────────
// P0 cost fix v2 (2026-04-14): 降低非必要任务的模型等级，压缩成本
export const MODEL_MAP = {
  // === Tier 1: Complex tasks → DeepSeek V4 Pro (best agentic + reasoning) ===
  code:             'deepseek/deepseek-v4-pro',      // tools + code: DeepSeek V4 Pro
  sysadmin:         'deepseek/deepseek-v4-pro',      // tools + ops: DeepSeek V4 Pro
  reasoning:        'openai/gpt-5.5',                // deep reasoning: GPT-5.5
  research:         'openai/gpt-5.5',                // research/analysis: GPT-5.5
  // === Tier 2: Quality tasks → GPT-5.5 (strong general model) ===
  chinese_content:  'openai/gpt-5.5',                // Chinese writing: GPT-5.5
  creative:         'openai/gpt-5.5',                // creative writing: GPT-5.5
  // === Tier 3: Light tasks → GPT-5.4-mini (cost-efficient) ===
  chat:             'deepseek/deepseek-v4-pro',      // casual chat: V4 Pro (V4Flash disabled)
  translation:      'deepseek/deepseek-v4-pro',      // translation: V4 Pro (V4Flash disabled)
  gaming:           'deepseek/deepseek-v4-pro',      // gaming: V4 Pro (V4Flash disabled)
  // === Special: Image generation ===
  image_generation: 'google/gemini-3.1-flash-image-preview',
};

export const THINKING_MAP = {
  code:             'high',
  reasoning:        'high',
  sysadmin:         'high',
  chinese_content:  'high',
  research:         'high',
  creative:         'high',
  chat:             'low',
  translation:      'low',
  gaming:           'medium',
  image_generation: 'low',
};

// 安全回退模型（当分类不确定时使用）
// R64: mini models -> deepseek-v4-pro (OpenRouter), GPT models -> direct OpenAI API
// 注意：TOOL_REQUIRING_TYPES 的任务（code/sysadmin）会被 TOOL_MODEL 覆盖，不受此影响
const SAFE_FALLBACK_MODEL = 'deepseek/deepseek-v4-pro';  // R64: mini->V4Pro

// 工具调用专用模型 — code/sysadmin 强制走 Claude（工具调用稳定性最佳）
const TOOL_MODEL = 'deepseek/deepseek-v4-pro';

// 需要工具调用的任务类型 — 这些类型必须使用 Claude（工具调用最稳定）
// 即使 LLM 分类器选了其他模型，也强制回退到 Claude
// P0 cost fix v2 (2026-04-14): gaming 移除，不再强制走 Claude
const TOOL_REQUIRING_TYPES = new Set(['code', 'sysadmin']);

// ─── TASK_PATTERNS（与 root smart-router.mjs classifyTask 完全一致）──────
// TD-022: TASK_PATTERNS extracted to lib/routing-config.mjs (single source of truth)
// const TASK_PATTERNS = { ... }; // REMOVED — now imported from lib/routing-config.mjs


// ─── 分类优先级（解决多类别同时匹配的冲突）──────────────────────
// 优先级从高到低：确保 code > reasoning，sysadmin > reasoning
// 例如 "分析这段代码" 同时匹配 code(代码) 和 reasoning(分析)，应走 code
const PRIORITY_ORDER = [
  'image_generation',  // 最高：图片生成有明确的视觉关键词
  'code',              // 代码任务优先于推理（"分析代码" → code）
  'sysadmin',          // 系统管理优先于推理（"分析日志" → sysadmin）
  'reasoning',         // 深度推理
  'research',          // 研究/信息检索
  'chinese_content',   // 中文内容创作
  'translation',       // 翻译
  'creative',          // 创意写作
  'gaming',            // 游戏
  'chat',              // 最低：兜底
];

// ─── 图片 MIME 检测 ──────────────────────────────────────────
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];

function hasImageAttachment(attachments) {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return false;
  return attachments.some(a => {
    const mime = (a.mimeType || a.mime_type || a.type || '').toLowerCase();
    return IMAGE_MIMES.some(im => mime.startsWith(im.split('/')[0]));
  });
}

// ─── 分类函数（与 root smart-router.mjs classifyTask 逻辑一致）──────
function classifyMessage(content) {
  let message = (content || '').trim();
  if (!message) {
    return { type: 'chat', confidence: 0, thinking: 'low' };
  }

  const ctxEndMarker = '[/KNOWLEDGE_CONTEXT]';
  const ctxEndIdx = message.indexOf(ctxEndMarker);
  if (ctxEndIdx !== -1) {
    const afterCtx = message.substring(ctxEndIdx + ctxEndMarker.length).trim();
    if (afterCtx.length > 0) {
      message = afterCtx;
    }
  }
  // Also strip <knowledge_reference>...</knowledge_reference>
  const krEndTag = '</knowledge_reference>';
  const krEndIdx = message.indexOf(krEndTag);
  if (krEndIdx !== -1) {
    const afterKr = message.substring(krEndIdx + krEndTag.length).trim();
    if (afterKr.length > 0) {
      message = afterKr;
    }
  }

  const trimmed = message.trim();

  // ── 守卫 1：极短消息且无动作词 → chat ──
  // 注意：翻译/画 等动作词即使很短也不应被拦截
  if (trimmed.length < 6 && !/[`{}\[\]()=<>]/.test(trimmed) &&
      !/(搜|查|找|写|算|分析|帮|请|画|来|做|给|输出|导出|生成|转换|打开|运行|执行|下载|上传|发送|修复|修改|更新|删除|创建|翻译|总结|对比|解释|bug|修bug|部署|重启|润色)/.test(trimmed)) {
    return { type: 'chat', confidence: 0.8, thinking: 'low' };
  }

  // ── 守卫 2：被动疑问句（无动作指令）→ chat ──
  const passivePatterns = /(为什么|为何|怎么|什么是|谁是|解释下|解释一下|说明下|总结下|总结一下|是什么|啥是|能不能|可以吗|有没有|如何看待|评价下|怎么回事|定位|检查下|检查|请问|我问|想问|问个|问一下|想知道|告诉我|说说|讲讲|聊聊|有哪些|哪些|哪个好|哪个|推荐|建议|好不好|值不值|值得|必须.{0,6}吗|应该.{0,6}吗|需要.{0,6}吗|要不要|懂.{0,4}吗|会.{0,4}吗|算.{0,4}吗|属于|区别|差别|不同|一样吗|对吗|是吗|吗$)/;
  // actionExclusions: 如果消息包含这些词，即使有被动疑问词也不应判为 chat
  const actionExclusions = /(读取|写入|修改|执行|运行|代码|文件|脚本|程序|部署|重启|修复|搜索|抓取|下载|上传|打开浏览器|截图|编辑|读文件|写文件|查文件|创建|删除|安装|卸载|编译|构建|发布|bug|debug|nginx|docker|服务器|磁盘|端口|进程|日志|备份|迁移|防火墙|域名|证书|配置|权限|systemctl|ssh|翻译|翻成|译成|本地化|国际化|润色|扩写|精简|文案|小红书|推文|软文|公文|游戏|攻略|阵容|装备|出装|英雄|角色|副本|关卡|通关|云顶之弈|英雄联盟|原神|王者荣耀|lol|tft|KOL|达人|直播|带货|种草|投放|竞品|调研|市场|行业|数据分析)/;
  const metaQuestionPatterns = /(工具调用|智能路由|路由问题|模型选择|token|成本|缓存|上下文|system prompt|SOUL|配置|设定|设置|参数)/;

  if (trimmed.length < 200 && passivePatterns.test(trimmed) && !actionExclusions.test(trimmed)) {
    const taskPhrases = /(给出.*报告|给出.*建议|给出.*方案|给出.*策略|写.*报告|做.*分析|做.*对比|做.*调研|详细.*分析|竞品.*对比|市场.*分析|数据.*分析|部署.*到|迁移.*到|备份.*到)/;
    if (!taskPhrases.test(trimmed)) {
      return { type: 'chat', confidence: 0.9, thinking: 'low' };
    }
  }

  // ── 守卫 3：AI 系统元问题 → chat ──
  // 例如 "上下文是如何管理实现的" 是技术深度问题，不是闲聊
  const implementationIntent = /(如何.*管理|如何.*实现|怎么.*实现|怎么.*管理|如何.*工作|怎么.*工作|原理|机制|架构|实现|源码|代码.*逻辑|底层|内部|核心|设计|方案|流程|算法|策略|具体|详细|深入|展示|验证|真实)/;
  if (trimmed.length < 200 && metaQuestionPatterns.test(trimmed) && !actionExclusions.test(trimmed)) {
    if (implementationIntent.test(trimmed)) {
      return { type: 'reasoning', confidence: 0.80, thinking: 'high' };
    }
    return { type: 'chat', confidence: 0.85, thinking: 'low' };
  }

  // ── 守卫 4：短消息无动作指令 → chat ──
  //        同时复用 actionExclusions 作为额外保护层
  {
    const shortMsgThreshold = 50;
    const taskIndicators = /(帮我|请.*写|请.*做|请.*改|请.*修|请.*查|请.*搜|请.*找|请.*读|请.*执行|请.*运行|请.*部署|请.*创建|请.*删除|请.*安装|写一个|写一篇|写一份|做一个|改一下|修一下|开发|实现|搭建|构建|编写|调试|部署|重启|迁移|备份|恢复|监控|分析|对比|推理|评估|比较|优劣|利弊|方案|策略|修复|搜索|搜一下|查找|查询|debug|fix|build|create|implement|deploy|write.*code|make.*script|translate|translation|bug|修bug|改bug|nginx|docker|服务器|磁盘|端口|日志|API|接口|错误|翻译|翻成|译成|润色|扩写|文案|周报|日报|月报|公告|通知|总结|报告|论文|研究|小红书|推文|游戏|攻略|阵容|装备|出装|英雄|角色|副本|云顶|原神|王者|lol|KOL|达人|直播|调研|竞品|画图|生成图|画一|修改|执行|代码|权限|账户|账号|脚本|程序|文件|配置|数据库|前端|后端|功能|模块|页面|组件|任务)/;
    if (trimmed.length < shortMsgThreshold && !taskIndicators.test(trimmed) && !actionExclusions.test(trimmed) && !/```/.test(trimmed)) {
      return { type: 'chat', confidence: 0.7, thinking: 'low' };
    }
  }

  // ── 关键词评分 ──
  const scores = {};
  for (const [type, config] of Object.entries(TASK_PATTERNS)) {
    let score = 0;
    for (const pattern of config.keywords) {
      const matches = trimmed.match(pattern);
      if (matches) {
        score += matches.length;
      }
    }
    scores[type] = score;
  }

  // ── 选择最高分类别（同分时按优先级排序）──
  let bestType = 'chat';
  let bestScore = 0;

  // 按优先级顺序遍历，同分时高优先级类别胜出
  for (const type of PRIORITY_ORDER) {
    const score = scores[type] || 0;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  // ── 安全守卫：单关键词 + 短消息 → 降级为 chat ──
  // 例如 "后端开发必须懂JAVA吗" 只匹配 code 的 'java' 一个词，但其实是问答
  const highConfidenceSingleMatch = ['image_generation', 'gaming', 'sysadmin', 'translation'];
  const hasActionVerb = /(修|写|做|改|建|装|配|部署|调|换|删|加|安装|卸载)/.test(trimmed);
  if (bestScore === 1 && trimmed.length < 80 && bestType !== 'chat' && !highConfidenceSingleMatch.includes(bestType) && !hasActionVerb) {
    bestType = 'chat';
    bestScore = 0;
  }

  const confidence = Math.min(bestScore / 3, 1.0);
  const thinking = THINKING_MAP[bestType] || 'high';

  // ── 长消息/代码块 → 提升 thinking ──
  let finalThinking = thinking;
  if (trimmed.length > 500 || (trimmed.match(/\n/g) || []).length > 5) {
    if (finalThinking === 'low') finalThinking = 'medium';
    if (finalThinking === 'medium') finalThinking = 'high';
  }
  if (/```[\s\S]*```/.test(trimmed)) {
    finalThinking = 'high';
  }

  return { type: bestType, confidence, thinking: finalThinking };
}

// ─── 主路由函数 ──────────────────────────────────────────────
/**
 * 智能路由：根据消息内容和附件选择最优模型
 * @param {string} content - 用户消息文本
 * @param {Array} attachments - 附件列表
 * @param {string|null} userModel - 用户手动选择的模型 (null/'auto' 表示自动)
 * @returns {{ model: string, reason: string, category: string, thinking: string, confidence: number }}
 */
export async function smartRoute(content, attachments = [], userModel = null, sessionKey = null) {
  // 用户手动指定模型 → 不覆盖
  if (userModel && userModel !== 'auto') {
    return {
      model: userModel,
      reason: `user_selected: ${userModel}`,
      category: 'user_override',
      thinking: 'high',
      confidence: 1.0,
    };
  }

  // [R58-FIX] Detect explicit model requests in message TEXT
  // When user writes "用GPT5.5" or "请用deepseek" in their message, respect it
  {
    const msgLower = (content || '').toLowerCase().replace(/[\s\-_.]/g, '');
    const explicitModelPatterns = [
      // GPT-5.5 / GPT5.5 variants
      { pattern: /(?:请|用|使用|切换到?|换成?).*(?:gpt55|gpt5\.?5)/i, model: 'openai/gpt-5.5', name: 'GPT-5.5' },
      { pattern: /(?:gpt55|gpt5\.?5).*(?:模型|来|执行|处理|回答|工作)/i, model: 'openai/gpt-5.5', name: 'GPT-5.5' },
      // GPT-5.4-mini variants
      { pattern: /(?:请|用|使用|切换到?|换成?).*(?:gpt54mini|gpt5\.?4[\.\-]?mini|mini模型)/i, model: 'deepseek/deepseek-v4-pro', name: 'GPT-5.4-mini' },
      // DeepSeek V4 Pro variants
      { pattern: /(?:请|用|使用|切换到?|换成?).*(?:deepseek|v4pro|v4[\.\-]?pro)/i, model: 'deepseek/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      { pattern: /(?:deepseek|v4pro|v4[\.\-]?pro).*(?:模型|来|执行|处理|回答|工作)/i, model: 'deepseek/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      // GPT-5.5-pro variants
      { pattern: /(?:请|用|使用|切换到?|换成?).*(?:gpt55pro|gpt5\.?5[\.\-]?pro)/i, model: 'openai/gpt-5.5-pro', name: 'GPT-5.5-pro' },
    ];
    // Test against the ORIGINAL content (not lowered/stripped) for Chinese patterns
    const originalMsg = (content || '');
    for (const { pattern, model, name } of explicitModelPatterns) {
      if (pattern.test(originalMsg)) {
        logger.info(`[smart-router] [R58-FIX] Explicit model request detected in message: "${name}" → ${model}`);
        return {
          model,
          reason: `explicit_in_message: user requested ${name}`,
          category: 'user_override',
          thinking: 'high',
          confidence: 1.0,
        };
      }
    }
  }

  // Users often attach screenshots as context for code/reasoning tasks.
  // The LLM pre-classifier (or keyword fallback) determines the actual task type.
  // image_generation is only selected when the TEXT content requests image generation/editing.
  const _hasImageAttachment = hasImageAttachment(attachments);

  // ─── v4.0: LLM Pre-Classifier (AUTHORITATIVE SOURCE) ───
  // Use LLM pre-classifier to determine task type. This is the primary signal.
  // Keyword-based classification is the FALLBACK only (when LLM fails).
  const llmResult = await preClassify(content);
  
  if (llmResult && llmResult.type !== 'continuation') {
    const llmType = llmResult.type;
    const llmModel = MODEL_MAP[llmType] || SAFE_FALLBACK_MODEL;
    const llmThinking = THINKING_MAP[llmType] || 'high';
    
    // Low confidence from LLM → still use Claude as safe fallback
    if (llmResult.confidence < 0.5 && llmType !== 'chat') {
      logger.info(`[smart-router-v4] LLM LOW CONF (${llmResult.confidence.toFixed(2)}) type=${llmType}, SAFE FALLBACK → gpt-5.5`);
      return {
        model: SAFE_FALLBACK_MODEL,
        reason: `llm_low_conf (type=${llmType}@${llmResult.confidence.toFixed(2)}) → gpt-5.5 (safe)`,
        category: llmType,
        thinking: 'high',
        confidence: llmResult.confidence,
      };
    }
    
    if (TOOL_REQUIRING_TYPES.has(llmType)) {
      // [MODEL-FIX] 规划/验收/分析类任务即使被分类为 sysadmin/code，也应使用 GPT-5.5
      // 这些任务需要深度推理和上下文理解，不需要工具调用
      const REASONING_OVERRIDE_PATTERNS = [
        /验收|审计|核查|核实|巡检|对照|逐项检查|评估|审查|盘点/i,
        /规划|出方案|写方案|做评估|做分析|给建议|出任务书|写任务书/i,
        /代码阅读|阅读代码|审阅|(?:^|\s)review|(?:^|\s)audit|(?:^|\s)verify|(?:^|\s)validate|(?:^|\s)assess/i,
        /分析报告|验收报告|总结报告|给我报告|出报告|写报告/i,
        /确认当前.*状态|确认.*实际状态|对应报告/i,
      ];
      const isReasoningTask = REASONING_OVERRIDE_PATTERNS.some(p => p.test(content));
      if (isReasoningTask) {
        logger.info(`[smart-router-v4] [MODEL-FIX] type=${llmType} but content is planning/verification → GPT-5.5 (override TOOL_REQUIRING)`);
        return {
          model: 'openai/gpt-5.5',
          reason: `llm_${llmResult.source}: ${llmType} → GPT-5.5 (planning/verification override)`,
          category: 'reasoning',
          thinking: 'high',
          confidence: llmResult.confidence,
        };
      }
      const safeModel = TOOL_MODEL;
      logger.info(`[smart-router-v4] LLM: type=${llmType} is TOOL-REQUIRING → forced to ${safeModel} (thinking: high)`);
      return {
        model: safeModel,
        reason: `llm_${llmResult.source}: ${llmType} (conf=${llmResult.confidence.toFixed(2)}) → ${safeModel} (tool-requiring)`,
        category: llmType,
        thinking: 'high',
        confidence: llmResult.confidence,
      };
    }
    
    // ─── v3 Fix: Context-aware upgrade for misclassified compound tasks ───
    // If LLM says chat/research but message has strong tool-requiring signals, upgrade
    const UPGRADEABLE_TYPES = new Set(['chat', 'research', 'creative', 'chinese_content']);
    if (UPGRADEABLE_TYPES.has(llmType)) {
      const toolSignals = [
        /服务器|server|ssh|进程|process|worker|agent/i,
        /文件|file|模块|module|\.mjs|\.js|\.py|\.sh/i,
        /日志|log|状态|status|运行|running|pid/i,
        /检查|check|验证|verify|验收|audit|核查|核实|审计|巡检|诊断/i,
        /grep|cat|ls|wc|tail|head|sed|awk|node|npm|pnpm|docker|systemctl/i,
        /部署|deploy|线上|production|生产|阿里云|重启|restart/i,
        /代码|code|bug|debug|修复|fix|修改|编译|build/i,
      ];
      const signalCount = toolSignals.filter(p => p.test(content)).length;
      if (signalCount >= 3) {
        const upgradeModel = TOOL_MODEL;
        logger.info(`[smart-router-v4] UPGRADE: LLM said ${llmType} but ${signalCount}/7 tool-signals detected → upgrading to ${upgradeModel}`);
        return {
          model: upgradeModel,
          reason: `llm_upgraded: ${llmType} → sysadmin (${signalCount} tool-signals) → ${upgradeModel}`,
          category: 'sysadmin',
          thinking: 'high',
          confidence: Math.max(llmResult.confidence, 0.85),
        };
      }
    }

    // ─── [R3-PlanA] Session context inheritance for chat/translation ───
    // If LLM classified as chat/translation but session has recent non-chat context,
    // and the message is short (likely a follow-up command), inherit session context.
    const INHERITABLE_TYPES = new Set(['chat', 'translation']);
    if (INHERITABLE_TYPES.has(llmType) && sessionKey) {
      const sessionCtx = getSessionContext(sessionKey);
      if (sessionCtx) {
        // Short messages are likely follow-up commands in the same task context
        const cleanLen = (content || '').replace(/\[KNOWLEDGE_CONTEXT\][\s\S]*?\[\/KNOWLEDGE_CONTEXT\]/g, '').trim().length;
        if (cleanLen < 80) {
          // [COST-OPT] Don't inherit expensive models for tasks that don't need them
          const COST_DOWNGRADE_CATEGORIES = new Set(['code', 'sysadmin']);
          const sessionIsExpensive = sessionCtx.model && sessionCtx.model.includes('gpt-5.5');
          if (sessionIsExpensive && COST_DOWNGRADE_CATEGORIES.has(sessionCtx.category)) {
            const cheaperModel = MODEL_MAP[sessionCtx.category] || 'deepseek/deepseek-v4-pro';
            logger.info(`[smart-router-v4] [COST-OPT] SESSION-INHERIT blocked: session=${sessionCtx.category} uses ${sessionCtx.model}, downgrading to ${cheaperModel}`);
            return {
              model: cheaperModel,
              reason: `session_inherit_cost_opt: ${llmType} → ${sessionCtx.category} (downgraded from ${sessionCtx.model} to ${cheaperModel})`,
              category: sessionCtx.category,
              thinking: sessionCtx.thinking,
              confidence: Math.max(llmResult.confidence, 0.80),
            };
          }
          logger.info(`[smart-router-v4] SESSION-INHERIT: LLM said ${llmType} but session has ${sessionCtx.category} context (${Math.round((Date.now() - sessionCtx.ts) / 1000)}s ago) → inheriting ${sessionCtx.model}`);
          return {
            model: sessionCtx.model,
            reason: `session_inherit: ${llmType} → ${sessionCtx.category} (session context) → ${sessionCtx.model}`,
            category: sessionCtx.category,
            thinking: sessionCtx.thinking,
            confidence: Math.max(llmResult.confidence, 0.80),
          };
        }
      }
    }

    logger.info(`[smart-router-v4] LLM: type=${llmType} conf=${llmResult.confidence.toFixed(2)} → model=${llmModel} thinking=${llmThinking} (source: ${llmResult.source})`);
    return {
      model: llmModel,
      reason: `llm_${llmResult.source}: ${llmType} (conf=${llmResult.confidence.toFixed(2)}) → ${llmModel}`,
      category: llmType,
      thinking: llmThinking,
      confidence: llmResult.confidence,
    };
  }
  
  // ─── FALLBACK: Keyword-based classification ───
  // Only reached when LLM pre-classifier fails or returns null
  // [R48-FIX4] Continuation messages: try session context first, then use strong model
  if (llmResult && llmResult.type === 'continuation' && sessionKey) {
    const sessionCtx = getSessionContext(sessionKey);
    if (sessionCtx) {
      logger.info(`[smart-router-v4] [R48-FIX4] CONTINUATION with session context: ${sessionCtx.category} → ${sessionCtx.model}`);
      return {
        model: sessionCtx.model,
        reason: `continuation_inherit: ${sessionCtx.category} (session context) → ${sessionCtx.model}`,
        category: sessionCtx.category,
        thinking: sessionCtx.thinking,
        confidence: 0.85,
      };
    }
    // No session context available (e.g., after restart) — use GPT-5.4 as balanced default
    // P0 cost fix v3: was sysadmin+thinking:high → now gpt-5.5 + thinking:medium
    logger.info(`[smart-router-v4] [R48-FIX4] CONTINUATION without session context → gpt-5.5 (cost-opt)`);
    return {
      model: 'openai/gpt-5.5',
      reason: `continuation_no_context → gpt-5.5 (cost-opt)`,
      category: 'reasoning',
      thinking: 'medium',
      confidence: 0.75,
    };
  }
  logger.info(`[smart-router-v4] LLM failed or continuation, falling back to keyword classification`);
  const classification = classifyMessage(content);
  const model = MODEL_MAP[classification.type] || SAFE_FALLBACK_MODEL;
  // ── 安全回退：低置信度 → Claude（最安全）──
  if (classification.confidence < 0.4 && classification.type !== 'chat') {
    const safeModel = SAFE_FALLBACK_MODEL;
    logger.info(`[smart-router-v4] KEYWORD LOW CONFIDENCE (${classification.confidence.toFixed(2)}) for type=${classification.type}, SAFE FALLBACK → ${safeModel}`);
    return {
      model: safeModel,
      reason: `keyword_low_conf (was: ${classification.type}@${classification.confidence.toFixed(2)}) → gpt-5.5 (safe)`,
      category: classification.type,
      thinking: 'high',
      confidence: classification.confidence,
    };
  }
  // [MODEL-FIX] keyword fallback 也需要规划/验收例外
  let finalModel;
  if (TOOL_REQUIRING_TYPES.has(classification.type)) {
    const REASONING_OVERRIDE_KW = [
      /验收|审计|核查|核实|巡检|对照|逐项检查|评估|审查|盘点/i,
      /规划|出方案|写方案|做评估|做分析|给建议|出任务书|写任务书/i,
      /代码阅读|阅读代码|审阅|review|audit|verify|validate|assess/i,
    ];
    const isReasoningKW = REASONING_OVERRIDE_KW.some(p => p.test(content));
    finalModel = isReasoningKW ? 'openai/gpt-5.5' : TOOL_MODEL;
  } else {
    finalModel = model;
  }
  const finalThinking = TOOL_REQUIRING_TYPES.has(classification.type) ? 'high' : classification.thinking;
  
  logger.info(`[smart-router-v4] KEYWORD: type=${classification.type} conf=${classification.confidence.toFixed(2)} → model=${finalModel} thinking=${finalThinking}`);
  return {
    model: finalModel,
    reason: `keyword: ${classification.type} (conf=${classification.confidence.toFixed(2)}) → ${finalModel}`,
    category: classification.type,
    thinking: finalThinking,
    confidence: classification.confidence,
  };
}

// ─── R93: Sub-agent adaptive model routing ──────────────────────────────
// Search → Gemini, coding → Claude, analysis/reasoning → OpenAI GPT,
// browser/screenshot → default model (no override).
export function routeSubAgentModel(step = {}, prompt = '') {
  const text = [step.title, step.description, step.objective, step.goal, step.task, Array.isArray(step.tools) ? step.tools.join(' ') : step.tools, prompt]
    .filter(Boolean).join(' ').toLowerCase();
  const has = (re) => re.test(text);

  if (has(/browser|浏览器|网页|打开网站|截图|screenshot|screen\s*shot|playwright|chrome|页面预览|browserpreview/)) {
    return { model: null, thinking: 'medium', category: 'browser', reason: 'subagent_adaptive: browser/screenshot → default model' };
  }
  if (has(/搜索|检索|查找资料|调研|research|web_search|searx|google|bing|资料搜集|竞品信息/)) {
    return { model: 'google/gemini-3.1-pro-preview', thinking: 'medium', category: 'research', reason: 'subagent_adaptive: search/research → Gemini' };
  }
  if (has(/代码|编程|修复|修改|实现|重构|debug|bug|build|compile|test|npm|pnpm|typescript|tsx|javascript|\.mjs|\.tsx|\.ts|\.js|coding|code/)) {
    return { model: 'openai/gpt-5.5', thinking: 'high', category: 'code', reason: 'subagent_adaptive: coding → GPT-5.5' };
  }
  if (has(/分析|推理|判断|规划|审计|复盘|总结|compare|reason|analysis|analyze|evaluate|评估|诊断/)) {
    return { model: 'openai/gpt-5.5', thinking: 'high', category: 'reasoning', reason: 'subagent_adaptive: analysis/reasoning → OpenAI GPT' };
  }
  return { model: null, thinking: 'medium', category: 'default', reason: 'subagent_adaptive: no override → default model' };
}

// ─── [R3-PlanA] Session-level route history cache ──────────────────
// Tracks the last non-chat category per session so short follow-up
// messages (e.g. "请验收", "给我报告") can inherit the session context.
const _sessionRouteCache = new Map(); // sessionKey → { category, model, thinking, ts }
const SESSION_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CACHE_MAX = 200; // [R95] reduced from 500 for memory safety

function updateSessionCache(sessionKey, result) {
  if (!sessionKey) return;
  // Only cache non-chat, non-translation categories (meaningful context)
  const CACHEABLE = new Set(['code', 'sysadmin', 'reasoning', 'research', 'chinese_content', 'creative']);
  if (CACHEABLE.has(result.category)) {
    _sessionRouteCache.set(sessionKey, {
      category: result.category,
      model: result.model,
      thinking: result.thinking,
      ts: Date.now(),
    });
    // Evict old entries if cache grows too large
    if (_sessionRouteCache.size > SESSION_CACHE_MAX) {
      const oldest = [..._sessionRouteCache.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, Math.floor(SESSION_CACHE_MAX / 4));
      for (const [k] of oldest) _sessionRouteCache.delete(k);
    }
  }
}

function getSessionContext(sessionKey) {
  if (!sessionKey) return null;
  const cached = _sessionRouteCache.get(sessionKey);
  if (cached) {
    if (Date.now() - cached.ts > SESSION_CACHE_TTL_MS) {
      _sessionRouteCache.delete(sessionKey);
      return null;
    }
    return cached;
  }
  // [R48-FIX3] Fallback: recover from task-states DB (survives restart)
  try {
    const db = getTaskStateDb();
    if (!db) return null;
    // Find the most recent task for this session with a known model
    const row = db.prepare(
      `SELECT last_model, updated_at FROM task_states 
       WHERE session_key = ? AND last_model IS NOT NULL AND last_model != '' 
       ORDER BY updated_at DESC LIMIT 1`
    ).get(sessionKey);
    if (row && row.last_model) {
      // Determine category from model name
      const model = row.last_model;
      let category = 'code'; // default to strong category
      if (model.includes('mini')) category = 'chat';
      else if (model.includes('gpt-5.5')) category = 'sysadmin';
      else if (model.includes('gemini')) category = 'image_generation';
      const thinking = (category === 'chat' || category === 'translation') ? 'low' : 'high';
      const recovered = { category, model, thinking, ts: new Date(row.updated_at).getTime() || Date.now() - 60000 };
      // Cache it in memory for future lookups
      _sessionRouteCache.set(sessionKey, recovered);
      logger.info(`[smart-router] [R48-FIX3] Recovered session context from DB: session=${sessionKey.substring(0,30)} model=${model} category=${category}`);
      return recovered;
    }
  } catch (e) {
    logger.info(`[smart-router] [R48-FIX3] DB recovery failed: ${e.message}`);
  }
  return null;
}
// ─── 路由统计 ────────────────────────────────────────────────
const _routeStats = {
  total: 0,
  byCategory: {},
  byModel: {},
};

/**
 * 带统计的路由函数（生产使用）
 */
export async function smartRouteWithStats(content, attachments = [], userModel = null, sessionKey = null) {
  const result = await smartRoute(content, attachments, userModel, sessionKey);
  
  // [R3-PlanA] Update session route cache after every route decision
  updateSessionCache(sessionKey, result);
  
  _routeStats.total++;
  _routeStats.byCategory[result.category] = (_routeStats.byCategory[result.category] || 0) + 1;
  _routeStats.byModel[result.model] = (_routeStats.byModel[result.model] || 0) + 1;

  return result;
}

/**
 * 获取路由统计
 */
export function getRouteStats() {
  return { ..._routeStats };
}

// ─── [方案A] taskPhase 分层路由 ────────────────────────────────────────────
// 根据任务阶段（phase）选择模型：
//   planning  → GPT-5.4（写计划，不需要工具调用）
//   coding    → Claude + thinking:high（写代码/系统操作，需工具调用稳定性）
//   review    → GPT-5.4（审查/检验，阅读理解为主）
//   qa        → GPT-5.4-mini（简单 Q&A / 验证）
//   default   → 委托给 smartRoute（保持原逻辑）
//
// 用法：
//   import { smartRouteByPhase } from './smart-router.mjs';
//   const route = await smartRouteByPhase('coding', content, attachments, userModel, sessionKey);
//
// [方案A] 2026-04-20 — 跨模型任务编排支持
export async function smartRouteByPhase(phase, content, attachments = [], userModel = null, sessionKey = null) {
  // 用户手动指定模型时不干预
  if (userModel && userModel !== 'auto') {
    return {
      model: userModel,
      reason: `user_selected: ${userModel}`,
      category: phase || 'default',
      thinking: 'high',
      confidence: 1.0,
      taskPhase: phase,
    };
  }

  // [GOVERNANCE-v4.0] High-risk keyword detection — force GPT-5.5 for dangerous operations
  const HIGH_RISK_KEYWORDS = [
    'systemd', 'systemctl', 'service', 'daemon-reload',
    'rm -rf', 'rm -f', 'rmdir', 'delete',
    'DROP TABLE', 'DROP DATABASE', 'DELETE FROM', 'TRUNCATE',
    '.env', 'API_KEY', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'TOKEN',
    '密钥', '密码', '凭证', '令牌',
    'chmod 777', 'chown root',
    'iptables', 'ufw', 'firewall',
    'nginx', 'caddy', 'ssl', 'tls', 'certificate',
    'production', 'deploy', '部署', '生产环境',
    'migration', 'schema change', 'ALTER TABLE',
  ];
  const contentLower = (content || '').toLowerCase();
  const isHighRisk = HIGH_RISK_KEYWORDS.some(kw => contentLower.includes(kw.toLowerCase()));
  if (isHighRisk && (phase === 'coding' || phase === 'sysadmin')) {
    logger.info(`[smart-router] [GOVERNANCE] High-risk operation detected in ${phase} phase, upgrading to GPT-5.5: "${content?.substring(0, 100)}"`);
    const result = {
      model: 'openai/gpt-5.5',
      thinking: 'high',
      category: phase,
      reason: `phase:${phase} → GPT-5.5 (GOVERNANCE: high-risk operation detected)`,
      confidence: 1.0,
      taskPhase: phase,
    };
    updateSessionCache(sessionKey, result);
    _routeStats.total++;
    _routeStats.byCategory[result.category] = (_routeStats.byCategory[result.category] || 0) + 1;
    _routeStats.byModel[result.model] = (_routeStats.byModel[result.model] || 0) + 1;
    return result;
  }

  const phaseRoutes = {
    planning: {
      model: 'openai/gpt-5.5',
      thinking: 'low',
      category: 'planning',
      reason: 'phase:planning → gpt-5.5 (plan generation, no tools needed)',
    },
    coding: {
      model: TOOL_MODEL,  // deepseek-v4-pro
      thinking: 'high',
      category: 'code',
      reason: 'phase:coding → deepseek-v4-pro (tool-calling, cost-efficient)',
    },
    sysadmin: {
      model: TOOL_MODEL,
      thinking: 'high',
      category: 'sysadmin',
      reason: 'phase:sysadmin → deepseek-v4-pro (tool-calling, cost-efficient)',
    },
    review: {
      model: 'openai/gpt-5.5',
      thinking: 'medium',
      category: 'reasoning',
      reason: 'phase:review → gpt-5.5 (code review, no tools needed)',
    },
    qa: {
      model: 'deepseek/deepseek-v4-pro',
      thinking: 'low',
      category: 'chat',
      reason: 'phase:qa → deepseek-v4-pro (Q&A / verification, lightweight)',
    },
    summary: {
      model: 'deepseek/deepseek-v4-pro',
      thinking: 'low',
      category: 'chat',
      reason: 'phase:summary → deepseek-v4-pro (summarization, lightweight)',
    },
    // [Iter-67] Validation phase: GPT-5.5 for final quality gate
    validation: {
      model: 'openai/gpt-5.5',
      thinking: 'high',
      category: 'reasoning',
      reason: 'phase:validation → gpt-5.5 (Iter-67: final quality gate, impact assessment)',
    },
  };

  const route = phaseRoutes[phase];
  if (route) {
    const result = {
      ...route,
      confidence: 1.0,
      taskPhase: phase,
    };
    updateSessionCache(sessionKey, result);
    _routeStats.total++;
    _routeStats.byCategory[result.category] = (_routeStats.byCategory[result.category] || 0) + 1;
    _routeStats.byModel[result.model] = (_routeStats.byModel[result.model] || 0) + 1;
    return result;
  }

  // 未知 phase → 降级到标准路由
  const fallbackResult = await smartRoute(content, attachments, userModel, sessionKey);
  return { ...fallbackResult, taskPhase: phase || 'default' };
}

