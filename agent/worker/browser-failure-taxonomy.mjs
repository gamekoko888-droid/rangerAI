/**
 * browser-failure-taxonomy.mjs — R22-T2 Browser Failure Taxonomy & Fallback Policy
 * 
 * Unified failure classification for all browser operations.
 * Each failure gets a category, a default fallback policy, and retryable flag.
 * 
 * Failure categories:
 *   - navigate_failed: Page failed to load (DNS, 4xx, 5xx, network error)
 *   - element_not_found: Target element/selector not found on page
 *   - extract_empty: Page loaded but extraction returned empty content
 *   - timeout: Operation exceeded time limit
 *   - blocked_or_auth_required: Login wall, CAPTCHA, access denied
 *   - unexpected_page_state: Page loaded but DOM structure unexpected
 * 
 * @module worker/browser-failure-taxonomy
 */
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── Failure Taxonomy ───────────────────────────────────────
export const BROWSER_FAILURE_CATEGORIES = {
  navigate_failed: {
    label: 'navigate_failed',
    description: 'Page failed to load (DNS error, HTTP 4xx/5xx, network timeout, connection refused)',
    retryable: true,
    defaultFallback: 'web_fetch_or_search',
    fallbackDescription: 'Fall back to web_fetch or web_search if task allows non-interactive retrieval',
  },
  element_not_found: {
    label: 'element_not_found',
    description: 'Target element/selector not found on the loaded page',
    retryable: true,
    defaultFallback: 'screenshot_and_replan',
    fallbackDescription: 'Take screenshot + DOM summary, allow planner to replan with updated page state',
  },
  extract_empty: {
    label: 'extract_empty',
    description: 'Page loaded successfully but text extraction returned empty or near-empty content',
    retryable: true,
    defaultFallback: 'text_fallback',
    fallbackDescription: 'Try alternative extraction (innerText, textContent, or web_fetch raw HTML)',
  },
  timeout: {
    label: 'timeout',
    description: 'Browser operation exceeded time limit',
    retryable: true,
    defaultFallback: 'retry_then_search',
    fallbackDescription: 'Mark retryable=true, retry once; if still fails, fall back to web_search',
  },
  blocked_or_auth_required: {
    label: 'blocked_or_auth_required',
    description: 'Page requires login, shows CAPTCHA, or returns 403/access denied',
    retryable: false,
    defaultFallback: 'mark_blocked',
    fallbackDescription: 'Mark as not auto-continuable, escalate to supervisor review',
  },
  unexpected_page_state: {
    label: 'unexpected_page_state',
    description: 'Page loaded but DOM structure is unexpected (e.g., redirect to different page, JS-rendered blank)',
    retryable: true,
    defaultFallback: 'screenshot_and_review',
    fallbackDescription: 'Take screenshot, log page state, trigger supervisor review',
  },
};

// ─── Classification Patterns ────────────────────────────────
const FAILURE_PATTERNS = [
  {
    category: 'blocked_or_auth_required',
    patterns: [
      /login|sign.?in|authenticate|captcha|recaptcha|hcaptcha|cloudflare/i,
      /403|forbidden|access.?denied|unauthorized|401/i,
      /登录|验证码|权限不足|拒绝访问|需要登录/,
      /please.?log.?in|please.?sign.?in|authentication.?required/i,
    ],
  },
  {
    category: 'navigate_failed',
    patterns: [
      /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/i,
      /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_SSL/i,
      /DNS.?resolution|could.?not.?resolve|connection.?refused/i,
      /404|not.?found|page.?not.?found|500|502|503|504/i,
      /net::ERR_/i,
      /navigation.?failed|failed.?to.?navigate|page.?load.?failed/i,
    ],
  },
  {
    category: 'timeout',
    patterns: [
      /timeout|timed?.?out|deadline.?exceeded|navigation.?timeout/i,
      /超时|等待超时|请求超时/,
      /ERR_TIMED_OUT|TimeoutError|ETIMEDOUT/i,
    ],
  },
  {
    category: 'element_not_found',
    patterns: [
      /element.?not.?found|selector.?not.?found|no.?such.?element/i,
      /cannot.?find.?element|unable.?to.?locate|no.?matching/i,
      /找不到元素|元素不存在|选择器无效/,
      /waitForSelector.?failed|querySelector.?returned.?null/i,
    ],
  },
  {
    category: 'extract_empty',
    patterns: [
      /empty.?content|no.?text|extraction.?empty|empty.?result/i,
      /text.?content.?is.?empty|no.?data.?extracted|blank.?page/i,
      /提取为空|内容为空|无文本|空白页面/,
      /innerText.?is.?empty|textContent.?is.?empty/i,
    ],
  },
  {
    category: 'unexpected_page_state',
    patterns: [
      /unexpected.?page|redirect|different.?page|wrong.?page/i,
      /page.?changed|dom.?changed|structure.?changed/i,
      /页面跳转|页面变化|意外页面|结构变化/,
      /javascript.?error|js.?error|script.?error/i,
    ],
  },
];

// ─── Classify Browser Failure ───────────────────────────────
/**
 * Classify a browser failure into a taxonomy category.
 * 
 * @param {Object} params
 * @param {string} params.action - The browser action that failed (navigate, click, extract, etc.)
 * @param {string} params.errorMsg - The error message
 * @param {number} params.statusCode - HTTP status code (if applicable)
 * @param {number} params.textLength - Length of extracted text (for extract_empty detection)
 * @param {string} params.url - The target URL
 * @returns {{ category: string, retryable: boolean, fallbackAction: string, confidence: number }}
 */
export function classifyBrowserFailure({ action, errorMsg = '', statusCode = 0, textLength = -1, url = '' }) {
  const errorStr = `${errorMsg} ${action} ${url}`.toLowerCase();

  // Special case: successful navigation but empty extraction
  if (action === 'extract_text' && textLength === 0 && !errorMsg) {
    return {
      category: 'extract_empty',
      retryable: true,
      fallbackAction: BROWSER_FAILURE_CATEGORIES.extract_empty.defaultFallback,
      confidence: 0.9,
    };
  }

  // Special case: HTTP status codes
  if (statusCode >= 400 && statusCode < 500) {
    if (statusCode === 401 || statusCode === 403) {
      return {
        category: 'blocked_or_auth_required',
        retryable: false,
        fallbackAction: BROWSER_FAILURE_CATEGORIES.blocked_or_auth_required.defaultFallback,
        confidence: 0.95,
      };
    }
    if (statusCode === 404) {
      return {
        category: 'navigate_failed',
        retryable: false,
        fallbackAction: BROWSER_FAILURE_CATEGORIES.navigate_failed.defaultFallback,
        confidence: 0.95,
      };
    }
  }
  if (statusCode >= 500) {
    return {
      category: 'navigate_failed',
      retryable: true,
      fallbackAction: BROWSER_FAILURE_CATEGORIES.navigate_failed.defaultFallback,
      confidence: 0.9,
    };
  }

  // Pattern-based classification
  for (const { category, patterns } of FAILURE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(errorStr)) {
        const config = BROWSER_FAILURE_CATEGORIES[category];
        return {
          category,
          retryable: config.retryable,
          fallbackAction: config.defaultFallback,
          confidence: 0.8,
        };
      }
    }
  }

  // Default: unexpected_page_state
  logger.warn(`[${ts()}] [R22-T2] Unclassified browser failure: action=${action} error=${errorMsg?.substring(0, 100)}`);
  return {
    category: 'unexpected_page_state',
    retryable: true,
    fallbackAction: BROWSER_FAILURE_CATEGORIES.unexpected_page_state.defaultFallback,
    confidence: 0.3,
  };
}

/**
 * Get the fallback policy description for a failure category.
 * 
 * @param {string} category - The failure category
 * @returns {Object} The full category config including fallback details
 */
export function getFallbackPolicy(category) {
  return BROWSER_FAILURE_CATEGORIES[category] || BROWSER_FAILURE_CATEGORIES.unexpected_page_state;
}

/**
 * Build a structured failure record for persistence.
 * 
 * @param {Object} params
 * @param {string} params.taskId
 * @param {string} params.sessionKey
 * @param {string} params.action - Browser action
 * @param {string} params.url
 * @param {string} params.errorMsg
 * @param {number} params.statusCode
 * @param {Object} params.classification - Output of classifyBrowserFailure
 * @param {string} params.fallbackResult - What happened after fallback (success/failed/skipped)
 * @param {boolean} params.degradedSuccess - Whether task completed via fallback
 * @returns {Object} Structured failure record
 */
export function buildFailureRecord({
  taskId,
  sessionKey,
  action,
  url,
  errorMsg,
  statusCode,
  classification,
  fallbackResult = 'pending',
  degradedSuccess = false,
}) {
  return {
    taskId,
    sessionKey,
    failureStage: action,
    failureReason: classification.category,
    failureDetail: errorMsg?.substring(0, 500) || '',
    url: url || '',
    statusCode: statusCode || 0,
    retryable: classification.retryable,
    fallbackAction: classification.fallbackAction,
    fallbackResult,
    degradedSuccess,
    confidence: classification.confidence,
    timestamp: Date.now(),
  };
}
