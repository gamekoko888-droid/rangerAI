// ─── lib/routing-config.mjs ─────────────────────────────────
// TD-022: Single source of truth for TASK_PATTERNS and classifyTask
// Extracted from llm-gateway.mjs to eliminate duplication with worker/smart-router.mjs
//
// Consumers:
//   - llm-gateway.mjs: getRoutingDecision() calls classifyTask()
//   - worker/smart-router.mjs: smartRoute() uses TASK_PATTERNS for scoring
//
// To modify task classification rules, edit ONLY this file.
// ─────────────────────────────────────────────────────────────

import { logger } from './logger.mjs';

// Hot-reloadable config accessor (injected at init time)
let _getConfig = () => ({ });
export function setConfigAccessor(fn) { _getConfig = fn; }

// ─── Task Classification ────────────────────────────────────

export const TASK_PATTERNS = {
  // Image generation / visual content tasks (highest priority — must match before creative/research)
  image_generation: {
    keywords: [
      /\b(draw|paint|sketch|illustrate|generate.*image|create.*image|image.*generat|picture|artwork|illustration)\b/i,
      /\b(logo|poster|banner|icon|avatar|wallpaper|thumbnail|infographic)\b/i,
      /\b(dall-?e|midjourney|stable.?diffusion|image.?edit)\b/i,
      // v22.5-FIX: Tightened image regex — '生成一个' and '帮我生成' are too broad.
      // '生成一个账号' was misclassified as image_generation.
      // Now require image-specific context words (图/画/片/张/幅) near '生成'.
      /(画|画一[张个只幅条]|生成图片|生成一[张幅]图|设计图|海报|插画|图片生成|壁纸|头像|图标)/,
      /(帮我画|请画|来一张|做一张图|画.*图|生成.*图|制作.*图|做个图)/,
      /(帮我生成.*图|请生成.*图|生成一[张幅]|画个|画只|画一|来张|来个图)/,
      /(卡通|漫画|水彩|油画|素描|像素|写实|抽象|可爱.*风格|动漫风)/,
    ],
    thinking: "high",
    description: "Image generation, editing, or visual content creation"
  },

  // Code-related tasks
  code: {
    keywords: [
      /\b(code|coding|program|debug|fix bug|compile|syntax|function|class|method|api|endpoint|refactor)\b/i,
      /\b(python|javascript|typescript|java|c\+\+|rust|go|sql|html|css|react|vue|node|express|golang|rust)\b/i,
      /\b(algorithm|data structure|leetcode|implement|deploy|docker|kubernetes|git|npm|pip)\b/i,
      /(代码|编程|调试|修复bug|修复|修bug|改bug|函数|类|方法|接口|重构|部署|编译|脚本|程序|报错|错误|异常|崩溃)/,
      /```[\s\S]*```/,  // Code blocks
      /\b(import|export|const|let|var|function|class|def|return|if|else|for|while)\b/
    ],
    thinking: "high",
    description: "Code generation, debugging, or technical implementation"
  },

  // Deep reasoning / analysis tasks
  reasoning: {
    keywords: [
      /\b(analyze|analysis|compare|evaluate|assess|reason|logic|proof|theorem|derive)\b/i,
      /\b(why|how come|explain why|what causes|root cause|trade-?off|pros and cons)\b/i,
      /\b(strategy|architecture|design pattern|system design|optimize|performance)\b/i,
      /(分析|比较|评估|推理|论证|权衡|优缺点|原因|为什么|怎么回事|对比)/,
      /\b(math|equation|calculate|formula|statistics|probability|regression)\b/i,
      /(数学|方程|计算|公式|统计|概率|算一下|算算)/
    ],
    thinking: "high",
    description: "Complex analysis, reasoning, or mathematical tasks"
  },


  // Chinese content creation and translation tasks
  chinese_content: {
    keywords: [
      /(写一篇|写一份|写个|写段|写点).*(爆款|小红书|推文|软文|公文|总结|报告|文案)/,
      /(润色|修改|优化|翻译|精简|扩写).*(文章|简历|邮件|汇报)/,
      /翻译成(中文|英文|日文)/,
      /(语气|口吻|风格)(专业|幽默|严肃|活泼)/
    ],
    thinking: "high",
    description: "Chinese content creation, copywriting, and polishing"
  },
  // Translation tasks
  translation: {
    keywords: [
      /\b(translate|translation|localize|localization|i18n|l10n)\b/i,
      /\b(translate.*to|translate.*into|convert.*language|language.*convert)\b/i,
      /(翻译|本地化|国际化|多语言|汉化|中译英|英译中|翻成|译成|翻译成)/,
      /\b(english to|to english|chinese to|to chinese|japanese to|french to|spanish to)\b/i
    ],
    thinking: "medium",
    description: "Translation, localization, and i18n tasks"
  },

  // Creative writing tasks
  creative: {
    keywords: [
      /\b(write|compose|draft|create|story|poem|essay|article|blog|novel|script)\b/i,
      /\b(creative|imaginative|fiction|narrative|character|plot|dialogue|scene)\b/i,
      /\b(marketing|copywriting|slogan|tagline|brand|pitch|presentation)\b/i,
      /(写一篇|写一个|创作|故事|诗|文章|博客|小说|剧本|文案|营销|品牌|撰写|起草|草拟|输出|导出|生成|转换|制作)/,
      /\b(translate|localize)\b/i
    ],
    thinking: "high",
    description: "Creative writing, content creation, or translation"
  },

  // Research / information tasks
  research: {
    keywords: [
      /(价格|报价|汇率|充值|支付|订单|库存|供应链|物流)/,
      /\b(research|investigate|find out|look up|search|summarize|summary|overview)\b/i,
      /\b(what is|who is|when did|where is|how does|tell me about|explain)\b/i,
      /\b(report|review|survey|study|paper|reference|citation|source)\b/i,
      /(研究|调查|查找|搜索|查一下|搜一下|找一下|查询|检索|总结|概述|报告|综述)/,
      /(是什么|谁是|什么时候|在哪里|怎么样|告诉我|介绍一下|了解|最新|趋势|动态|新闻|怎么办|怎么弄|如何|能不能|可以吗|有没有)/,
      /(帮我|请|麻烦).{0,10}(搜|查|找|看|了解)/,
      /(市场|行业|规模|增长|份额|竞品|调研|趋势|前景|预测|数据分析)/,
      /(KOL|网红|达人|博主|直播|带货|种草|投放|ROI|转化率|获客)/,
      /(东南亚|印尼|泰国|越南|菲律宾|马来西亚|新加坡|印度|巴西|中东|拉美)/,
    ],
    thinking: "high",
    description: "Information retrieval, research, or summarization"
  },

  // Gaming / game strategy tasks
  gaming: {
    keywords: [
      /\b(game|gaming|esports|moba|fps|rpg|mmorpg|strategy game|build|comp|meta|tier list)\b/i,
      /\b(league of legends|lol|valorant|dota|csgo|fortnite|genshin|minecraft|overwatch|apex)\b/i,
      /\b(champion|hero|character|loadout|deck|team comp|counter|matchup|patch notes)\b/i,
      /(游戏|攻略|阵容|装备|出装|天赋|符文|英雄|角色|副本|关卡|通关|打法|玩法|赛季|排位|段位|上分)/,
      /(云顶之弈|英雄联盟|原神|王者荣耀|绝地求生|和平精英|崩坏|明日方舟|星穹铁道)/,
      /(lol|tft|dnf|cf|csgo|dota|wow|ff14|pubg)/i,
      /(怎么打|怎么玩|怎么出装|怎么搭配|什么阵容|推荐阵容|最强阵容|版本强势|运营)/
    ],
    thinking: "medium",
    description: "Gaming strategy, guides, builds, or esports content"
  },
  // System administration / DevOps tasks
  sysadmin: {
    keywords: [
      /\b(server|linux|ubuntu|centos|nginx|caddy|systemctl|systemd|docker|kubernetes|k8s)\b/i,
      /\b(ssh|scp|rsync|cron|firewall|iptables|ufw|ssl|tls|certificate|dns|domain)\b/i,
      /\b(deploy|ci\/cd|pipeline|monitoring|log|backup|restore|migrate|scale|load balance)\b/i,
      /(服务器|运维|部署|监控|日志|备份|恢复|迁移|扩容|负载均衡|防火墙|域名|证书)/,
      /(重启|启动|停止|进程|端口|内存|CPU|磁盘|网络|配置|权限|安全|故障|宕机|挂了|不通|超时|连不上)/,
      /\b(pm2|supervisor|forever|tmux|screen|htop|top|df|du|free|ps|kill|grep|awk|sed)\b/i
    ],
    thinking: "high",
    description: "Server administration, DevOps, or infrastructure management"
  },
  // Simple conversation / chat
  chat: {
    keywords: [
      /^(hi|hello|hey|yo|sup|你好|嗨|哈喽|早|晚安|谢谢|thanks|ok|好的|嗯|对)\s*[!?。！？]*$/i,
      /\b(how are you|what's up|good morning|good night|bye|see you)\b/i,
      /(你好吗|最近怎么样|早上好|晚上好|再见|拜拜)/
    ],
    thinking: "low",
    description: "Casual conversation or simple greetings"
  }
};

/**
 * Classify a user message into a task type.
 * Returns { type, thinking, confidence, description }
 */

export function classifyTask(message) {
  // v3.6+v28.1-FIX: Strip knowledge context before classification to avoid interference
  // Handles both legacy [KNOWLEDGE_CONTEXT]...[/KNOWLEDGE_CONTEXT] and new <knowledge_reference>...</knowledge_reference>
  const ctxEndMarker = "[/KNOWLEDGE_CONTEXT]";
  const ctxEndIdx = message.indexOf(ctxEndMarker);
  if (ctxEndIdx !== -1) {
    const afterCtx = message.substring(ctxEndIdx + ctxEndMarker.length).trim();
    if (afterCtx.length > 0) {
      message = afterCtx;
    }
  }
  // v28.1-FIX: Also strip <knowledge_reference>...</knowledge_reference> (current injection format)
  const krEndTag = "</knowledge_reference>";
  const krEndIdx = message.indexOf(krEndTag);
  if (krEndIdx !== -1) {
    const afterKr = message.substring(krEndIdx + krEndTag.length).trim();
    if (afterKr.length > 0) {
      message = afterKr;
    }
  }
  if (!message || typeof message !== "string") {
    return { type: "chat", thinking: "medium", confidence: 0, description: "Empty or invalid message" };
  }

  const trimmed = message.trim();
  
  // Very short messages are likely casual chat
  // v1.8: Only treat very short messages without Chinese action verbs as chat
  // v1.9: Also check for 画 (draw) verb
  // v2.2: Expanded verb list for short messages and category patterns
  if (trimmed.length < 6 && !/[`{}\[\]()=<>]/.test(trimmed) && !/(搜|查|找|写|算|分析|帮|请|画|来|做|给|输出|导出|生成|转换|打开|运行|执行|下载|上传|发送|修复|修改|更新|删除|创建|翻译|总结|对比|解释)/.test(trimmed)) {
    return { type: "chat", thinking: "low", confidence: 0.8, description: "Short casual message" };
  }

  // v3.8: [R60-FIX] Expanded passive query detection
  // Problem: v3.7 used ^ anchor requiring pattern at START of message, missing "我问...为什么" patterns
  // Fix: Use contains-match instead of start-match, add more conversational prefixes
  // Also detect meta-questions about the AI system itself
  // v3.9: Expanded passive patterns — cover more conversational question forms
  const passivePatterns = /(为什么|为何|怎么|什么是|谁是|解释下|解释一下|说明下|总结下|总结一下|是什么|啥是|能不能|可以吗|有没有|如何看待|评价下|怎么回事|定位|检查下|检查|请问|我问|想问|问个|问一下|想知道|告诉我|说说|讲讲|聊聊|有哪些|哪些|哪个好|哪个|推荐|建议|好不好|值不值|值得|必须.{0,6}吗|应该.{0,6}吗|需要.{0,6}吗|要不要|懂.{0,4}吗|会.{0,4}吗|算.{0,4}吗|属于|区别|差别|不同|一样吗|对吗|是吗|吗$)/;
  const actionExclusions = /(读取|写入|修改|执行|运行|代码|文件|脚本|程序|部署|重启|修复|搜索|抓取|下载|上传|打开浏览器|截图|编辑|读文件|写文件|查文件|创建|删除|安装|卸载|编译|构建|发布)/;
  const metaQuestionPatterns = /(工具调用|智能路由|路由问题|模型选择|token|成本|缓存|上下文|system prompt|SOUL|配置|设定|设置|参数)/;
  
  if (trimmed.length < 200 && passivePatterns.test(trimmed) && !actionExclusions.test(trimmed)) {
    // v3.9: Additional check — if message also contains task-oriented phrases, don't classify as passive chat
    const taskPhrases = /(给出.*报告|给出.*建议|给出.*方案|给出.*策略|写.*报告|做.*分析|做.*对比|做.*调研|详细.*分析|竞品.*对比|市场.*分析|数据.*分析|部署.*到|迁移.*到|备份.*到)/;
    if (!taskPhrases.test(trimmed)) {
      return { type: "chat", thinking: "medium", confidence: 0.9, description: "Passive informational query" };
    }
  }
  // v3.8: Meta-questions about the AI system itself should be chat, not reasoning
  if (trimmed.length < 200 && metaQuestionPatterns.test(trimmed) && !actionExclusions.test(trimmed)) {
    return { type: "chat", thinking: "medium", confidence: 0.85, description: "Meta-question about AI system" };
  }

  // v3.9: Short message protection — simple questions without action verbs should be chat
  // This catches messages like "后端开发必须懂JAVA吗" (12 chars, no action verb)
  // and "山姆有哪些低热量又好吃的零食" (14 chars, no action verb)
  // But NOT "部署到阿里云服务器" (has 部署+服务器 = sysadmin action)
  // And NOT "分析一下这个市场数据 给出详细的竞品对比报告" (has 分析+报告 = research action)
  {
    const shortMsgThreshold = 50; // chars (reduced from 60 to be more conservative)
    const taskIndicators = /(帮我|请.*写|请.*做|请.*改|请.*修|请.*查|请.*搜|请.*找|请.*读|请.*执行|请.*运行|请.*部署|请.*创建|请.*删除|请.*安装|写一个|做一个|改一下|修一下|开发|实现|搭建|构建|编写|调试|部署|重启|迁移|备份|恢复|监控|分析.*数据|分析.*报告|竞品.*分析|市场.*分析|给出.*报告|给出.*建议|debug|fix|build|create|implement|deploy|write.*code|make.*script)/;
    if (trimmed.length < shortMsgThreshold && !taskIndicators.test(trimmed) && !/```/.test(trimmed)) {
      return { type: "chat", thinking: "medium", confidence: 0.7, description: "Short conversational question (no action verb)" };
    }
  }
  // Score each category
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

  // Find the highest scoring category
  // v1.8: Default to "research" instead of "chat" when no patterns match
  // This ensures OpenClaw gets a chance to use tools for ambiguous queries
  // v3.9: Default to "chat" instead of "research" — ambiguous queries should not trigger tools
  let bestType = "chat";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  // v3.9: Single-keyword protection — if only 1 keyword matched and message is short,
  // it's likely a casual question that happens to contain a technical term
  // e.g., "后端开发必须懂JAVA吗" matches 'java' in code patterns but is a simple question
  if (bestScore === 1 && trimmed.length < 80 && bestType !== 'chat') {
    bestType = "chat";
    bestScore = 0;
  }
  // Confidence based on score magnitude
  const confidence = Math.min(bestScore / 3, 1.0);
  const config = TASK_PATTERNS[bestType];

  // Adjust thinking level based on message complexity
  // Phase 4: Override thinking level from config if available
  const configThinkingLevels = _getConfig()?.task_thinking_levels;
  let thinking = (configThinkingLevels && configThinkingLevels[bestType]) || config.thinking;
  
  // Long messages with multiple paragraphs suggest complex tasks
  if (trimmed.length > 500 || (trimmed.match(/\n/g) || []).length > 5) {
    if (thinking === "low") thinking = "medium";
    if (thinking === "medium") thinking = "high";
  }

  // Messages with code blocks always get high thinking
  if (/```[\s\S]*```/.test(trimmed)) {
    thinking = "high";
  }

  // v5.0: Determine if this task needs a strong model (Claude) via sessions.patch
  const modelRouting = _getConfig()?.gateway_model_routing;
  const strongModelTasks = modelRouting?.strong_model_tasks || ['code', 'reasoning', 'sysadmin', 'chinese_content'];
  const needsStrongModel = strongModelTasks.includes(bestType);

  return {
    type: bestType,
    thinking,
    confidence,
    description: config.description,
    needsStrongModel,
    strongModel: needsStrongModel ? (modelRouting?.strong_model || 'openai/gpt-5.5') : null
  };
}
