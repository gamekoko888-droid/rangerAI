/**
 * web-task-family.mjs — R22-T1a Web Task Family Classifier
 * 
 * Classifies user goals into web task families and determines
 * the primary tool that should be used.
 * 
 * Task families:
 *   - page_lookup: Open a specific URL, read page content
 *   - page_extract: Extract structured data from a web page
 *   - site_navigation: Multi-page browsing, form filling, clicking
 *   - web_verification: Verify a page state, check if something exists
 *   - non_web: Not a web task
 * 
 * @module worker/web-task-family
 */
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── Web Task Family Patterns ───────────────────────────────
const WEB_FAMILY_PATTERNS = {
  site_navigation: {
    patterns: [
      // Navigation / interaction
      /\b(navigate|go to|open|visit|browse|click|fill|submit|login|sign.?in|register|sign.?up)\b.*\b(page|site|website|url|link|form|button)\b/i,
      /(打开|访问|浏览|进入|登录|注册|点击|填写|提交).{0,20}(网站|网页|页面|链接|表单|按钮)/,
      /(在.{0,15}(网站|页面|平台).{0,10}(上|里|中).{0,10}(操作|点击|填写|提交|选择|下载|上传))/,
      /\b(fill.?out|fill.?in|complete).{0,20}(form|application|survey)\b/i,
      /(帮我|请).{0,10}(在|去|到).{0,15}(网站|网页|平台|页面)/,
    ],
    primaryTool: 'browser',
    routingReason: 'Task requires multi-step web page interaction (navigation, clicking, form filling)',
  },
  // R39-T3: Research task family
  research: {
    patterns: [
      /\b(research|investigate|analyze|study|compare|benchmark|survey)\b.*\b(topic|subject|market|industry|company|product|trend)\b/i,
      /\b(deep research|comprehensive analysis|in-depth|detailed report|market research|competitive analysis)\b/i,
      /(深度研究|综合分析|详细报告|全面调研|市场研究|竞品分析|行业分析|趋势分析)/,
      /(研究|调研|分析).{0,20}(报告|总结|综述|对比)/,
      /\b(compare|contrast|pros.?and.?cons|advantages|disadvantages)\b.*\b(between|of|for)\b/i,
    ],
    primaryTool: 'web_search',
    routingReason: 'Deep research task - requires multi-source search, content fetching, and synthesis',
  },
  page_extract: {
    patterns: [
      // Data extraction from web
      /\b(extract|scrape|grab|pull|get|fetch|collect)\b.*\b(data|info|information|content|text|price|table|list)\b.*\b(from|on|at)\b.*\b(page|site|website|url)\b/i,
      /(提取|抓取|获取|采集|爬取).{0,20}(数据|信息|内容|文本|价格|表格|列表).{0,10}(从|在).{0,15}(网站|网页|页面)/,
      /(从|在).{0,15}(网站|网页|页面).{0,10}(提取|抓取|获取|采集|爬取)/,
      /\b(scrape|crawl|spider)\b/i,
      /(抓取|爬虫|爬取|采集).{0,10}(网页|网站|页面)/,
    ],
    primaryTool: 'browser',
    routingReason: 'Task requires extracting structured data from web pages',
  },
  page_lookup: {
    patterns: [
      // Open and read a specific page
      /\bhttps?:\/\/\S+/i,  // Contains a URL
      /\b(open|check|look at|read|view|see)\b.*\b(page|site|website|url|link)\b/i,
      /(打开|查看|看看|看一下|阅读|浏览).{0,10}(这个|那个|以下)?.{0,5}(网页|网站|页面|链接|URL|url)/,
      /(打开|查看|看看|看一下).{0,5}https?:\/\//,
      /\b(what.?does|what.?is.?on|show.?me)\b.*\b(page|site|website)\b/i,
    ],
    primaryTool: 'browser',
    routingReason: 'Task requires opening and reading a specific web page',
  },
  web_verification: {
    patterns: [
      // Verify / check web state
      /\b(verify|check|confirm|validate|test)\b.*\b(page|site|website|url|link|status|online|available|working)\b/i,
      /(验证|检查|确认|核实|测试).{0,20}(网站|网页|页面|链接|状态|是否|能否|可以)/,
      /\b(is|does|can)\b.*\b(page|site|website)\b.*\b(work|load|exist|available|online|up|down)\b/i,
      /(网站|网页|页面).{0,10}(是否|能否|有没有|还在|正常|可以访问)/,
    ],
    primaryTool: 'browser',
    routingReason: 'Task requires verifying web page state or availability',
  },
};

// ─── Classify Web Task Family ───────────────────────────────
/**
 * Classify a user goal into a web task family.
 * 
 * @param {string} userGoal - The user's task goal text
 * @param {string} taskType - The task type from classifyTask (code, research, etc.)
 * @param {Object} planSteps - The generated plan steps (optional)
 * @returns {{ taskFamily: string, routingReason: string, selectedPrimaryTool: string }}
 */
export function classifyWebTaskFamily(userGoal, taskType = '', planSteps = []) {
  // R39-T3: Early research detection
  const _r39Goal = String(userGoal || '');
  if (/deep research|comprehensive analysis|in-depth research|detailed report|market research|competitive analysis/i.test(_r39Goal) ||
      /深度研究|综合分析|全面调研|详细报告|市场研究|竞品分析/i.test(_r39Goal)) {
    return {
      taskFamily: 'research',
      selectedPrimaryTool: 'web_search',
      routingReason: 'Deep research task detected - multi-source search + synthesis required',
      confidence: 0.9
    };
  }

  if (!userGoal || typeof userGoal !== 'string') {
    return {
      taskFamily: 'non_web',
      routingReason: 'Empty or invalid goal',
      selectedPrimaryTool: 'none',
    };
  }

  const goal = userGoal.trim();

  // 1. Pattern-based classification
  let bestFamily = null;
  let bestScore = 0;

  for (const [family, config] of Object.entries(WEB_FAMILY_PATTERNS)) {
    let score = 0;
    for (const pattern of config.patterns) {
      if (pattern.test(goal)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestFamily = family;
    }
  }

  // 2. Plan-step heuristic: if plan steps mention browser tools, it's likely a web task
  if (!bestFamily && planSteps && planSteps.length > 0) {
    const browserSteps = planSteps.filter(s => {
      const tools = (s.tools || []).concat(s.expectedTools || []);
      return tools.some(t => /browser/i.test(t));
    });
    if (browserSteps.length > 0) {
      // Determine family from step descriptions
      const allTitles = browserSteps.map(s => (s.title || '').toLowerCase()).join(' ');
      if (/extract|scrape|grab|pull|提取|抓取/.test(allTitles)) {
        bestFamily = 'page_extract';
      } else if (/navigate|click|fill|submit|login|注册|登录|点击|填写/.test(allTitles)) {
        bestFamily = 'site_navigation';
      } else if (/verify|check|confirm|验证|检查|确认/.test(allTitles)) {
        bestFamily = 'web_verification';
      } else {
        bestFamily = 'page_lookup';
      }
      bestScore = 0.5; // Lower confidence from plan heuristic
    }
  }

  // 3. URL detection fallback
  if (!bestFamily && /https?:\/\/\S+/.test(goal)) {
    bestFamily = 'page_lookup';
    bestScore = 1;
  }

  // 4. Return result
  if (bestFamily) {
    const config = WEB_FAMILY_PATTERNS[bestFamily];
    logger.info(`[${ts()}] [R22-T1a] Web task family classified: family=${bestFamily} score=${bestScore} primaryTool=${config.primaryTool}`);
    return {
      taskFamily: bestFamily,
      routingReason: config.routingReason,
      selectedPrimaryTool: config.primaryTool,
    };
  }

  // Not a web task
  return {
    taskFamily: 'non_web',
    routingReason: 'No web task patterns detected in goal',
    selectedPrimaryTool: taskType === 'research' ? 'web_search' : 'none',
  };
}

/**
 * Check if a task that should use browser is instead using a non-browser tool.
 * Returns a missed-opportunity record if applicable.
 * 
 * @param {string} taskFamily 
 * @param {string} selectedPrimaryTool 
 * @param {string} actualTool - The tool actually used
 * @returns {Object|null} Missed opportunity record or null
 */
export function checkMissedBrowserOpportunity(taskFamily, selectedPrimaryTool, actualTool) {
  if (taskFamily === 'non_web') return null;
  if (selectedPrimaryTool !== 'browser') return null;
  if (/browser/i.test(actualTool)) return null;

  // This is a missed browser opportunity
  let missedCategory = 'unknown';
  if (/web_search|web_fetch/i.test(actualTool)) {
    missedCategory = 'downgraded_to_search';
  } else if (/shell|exec/i.test(actualTool)) {
    missedCategory = 'routed_to_shell';
  } else if (!actualTool || actualTool === 'none') {
    missedCategory = 'direct_text_answer';
  } else {
    missedCategory = 'routed_to_other_tool';
  }

  logger.warn(`[${ts()}] [R22-T1a] Missed browser opportunity: family=${taskFamily} expected=browser actual=${actualTool} category=${missedCategory}`);

  return {
    taskFamily,
    expectedTool: 'browser',
    actualTool: actualTool || 'none',
    missedCategory,
    timestamp: Date.now(),
  };
}
