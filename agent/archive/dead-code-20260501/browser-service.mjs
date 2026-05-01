/**
 * worker/browser-service.mjs — Browser Tool Service (v1.0, R14-T2)
 *
 * Provides 4 browser tools for the AI agent:
 *   - browser_navigate(url)        → navigate to URL, return title + text snippet
 *   - browser_screenshot()         → take full-page screenshot, return base64 PNG
 *   - browser_extract_text(selector?) → extract text content from page or element
 *   - browser_click(selector)      → click an element by CSS selector
 *
 * Architecture:
 *   - Uses puppeteer-core connecting to existing CDP endpoint (port 9222)
 *   - Browser instances cached per sessionId with TTL=5min
 *   - Max 3 concurrent instances (pool limit)
 *   - Non-blocking: failures return error objects, never throw
 *
 * @module worker/browser-service
 */
import puppeteer from 'puppeteer-core';
import { logger } from '../lib/logger.mjs';
import { createRequire } from 'node:module';
import { resolve } from 'path';
const _require = createRequire(import.meta.url);
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';

// [R22-T2] Browser failure taxonomy
import { classifyBrowserFailure, buildFailureRecord } from './browser-failure-taxonomy.mjs';
import { emitEvent } from './event-stream.mjs';

// [R68-P1-3] Retry helper
const BROWSER_MAX_RETRIES = 2;
const BROWSER_RETRY_DELAY_MS = 2000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── [R17-T3] Evidence storage directory ───
const EVIDENCE_DIR = process.env.BROWSER_EVIDENCE_DIR || '/opt/rangerai-agent/data/browser-evidence';
try { mkdirSync(EVIDENCE_DIR, { recursive: true }); } catch (_) {}

// ─── [R16-T4] DB Singleton for browser_action_log ───
let _browserDb = null;
function getBrowserDb() {
  if (!_browserDb) {
    const dbPath = process.env.RANGERAI_WORKER_DB || resolve('/opt/rangerai-agent/db/rangerai.db');
    _browserDb = new (_require("better-sqlite3"))(dbPath);
    _browserDb.pragma('journal_mode = WAL');
    _browserDb.exec(`
      CREATE TABLE IF NOT EXISTS browser_action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        url TEXT,
        selector TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        title TEXT,
        status_code INTEGER,
        text_length INTEGER,
        error_msg TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      )
    `);
    // [R60-T1] Cookie jar for cross-session login persistence
    _browserDb.exec(`
      CREATE TABLE IF NOT EXISTS browser_cookie_jar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        url TEXT NOT NULL,
        cookies_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      )
    `);
    try { _browserDb.exec('CREATE INDEX IF NOT EXISTS idx_cookie_session ON browser_cookie_jar(session_id, url)'); } catch (_) {}
    // [R17-T3] Evidence pack table
    _browserDb.exec(`
      CREATE TABLE IF NOT EXISTS browser_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        action_id INTEGER,
        evidence_type TEXT NOT NULL,
        file_path TEXT,
        url TEXT,
        title TEXT,
        text_content TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      )
    `);
  }
  return _browserDb;
}

function logBrowserAction(sessionId, action, result, durationMs, extra = {}) {
  try {
    const db = getBrowserDb();
    const info = db.prepare(`
      INSERT INTO browser_action_log (session_id, action, url, selector, success, title, status_code, text_length, error_msg, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      action,
      result.url || extra.url || null,
      extra.selector || null,
      result.success ? 1 : 0,
      result.title || null,
      result.statusCode || null,
      result.text ? result.text.length : (result.textSnippet ? result.textSnippet.length : null),
      result.error || null,
      durationMs || null
    );
    return info.lastInsertRowid;
  } catch (err) {
    logger.warn(`[${ts()}] [browser-service] Failed to log action to DB: ${err.message}`);
    return null;
  }
}

// ─── [R17-T3] Evidence Storage ───

function saveScreenshotEvidence(sessionId, actionId, base64Data, url, title) {
  try {
    const sessionDir = resolve(EVIDENCE_DIR, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const filename = `screenshot_${actionId || Date.now()}_${Date.now()}.png`;
    const filePath = resolve(sessionDir, filename);
    writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    // Record in DB
    const db = getBrowserDb();
    db.prepare(`
      INSERT INTO browser_evidence (session_id, action_id, evidence_type, file_path, url, title, metadata, task_focus_id)
      VALUES (?, ?, 'screenshot', ?, ?, ?, ?, ?)
    `).run(sessionId, actionId, filePath, url || null, title || null, JSON.stringify({ width: 1280, height: 900 }, getActiveTaskFocusId(sessionId)));
    logger.info(`[${ts()}] [browser-service] Screenshot evidence saved: ${filePath}`);
    return filePath;
  } catch (err) {
    logger.warn(`[${ts()}] [browser-service] Failed to save screenshot evidence: ${err.message}`);
    return null;
  }
}

function saveEvidence(sessionId, actionId, evidenceType, data) {
  try {
    const db = getBrowserDb();
    db.prepare(`
      INSERT INTO browser_evidence (session_id, action_id, evidence_type, url, title, text_content, metadata, task_focus_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      actionId,
      evidenceType,
      data.url || null,
      data.title || null,
      data.text ? data.text.substring(0, 50000, getActiveTaskFocusId(sessionId)) : null,
      data.selector ? JSON.stringify({ selector: data.selector }) : null
    );
  } catch (err) {
    logger.warn(`[${ts()}] [browser-service] Failed to save evidence: ${err.message}`);
  }
}

/**
 * [R17-T3] Get evidence for a session or all sessions.
 * @param {object} opts - { sessionId?, limit?, type? }
 * @returns {Array} evidence records
 */
export 
// [R19-T5] Auto-link evidence to active task_focus
function getActiveTaskFocusId(sessionId) {
  try {
    const row = db.prepare("SELECT id FROM task_focus WHERE session_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(sessionId);
    return row ? row.id : null;
  } catch (_) { return null; }
}

function getEvidence(opts = {}) {
  try {
    const db = getBrowserDb();
    let sql = 'SELECT id, session_id, action_id, evidence_type, file_path, url, title, text_content, metadata, created_at, task_focus_id FROM browser_evidence';
    const conditions = [];
    const params = [];
    if (opts.sessionId) { conditions.push('session_id = ?'); params.push(opts.sessionId); }
    if (opts.type) { conditions.push('evidence_type = ?'); params.push(opts.type); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(opts.limit || 50);
    return db.prepare(sql).all(...params);
  } catch (err) {
    logger.warn(`[${ts()}] [browser-service] Failed to get evidence: ${err.message}`);
    return [];
  }
}

const ts = () => new Date().toISOString();

// ─── Configuration ───
const CONFIG = {
  CDP_ENDPOINT: 'http://127.0.0.1:9222',
  MAX_INSTANCES: 3,
  INSTANCE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  NAV_TIMEOUT_MS: 30000,
  SCREENSHOT_TIMEOUT_MS: 15000,
  CLICK_TIMEOUT_MS: 10000,
  EXTRACT_TIMEOUT_MS: 10000,
};

// ─── Instance Pool ───
// Map<sessionId, { page, browser, lastUsed, createdAt }>
const _pool = new Map();

// Cleanup timer
let _cleanupTimer = null;

/**
 * Get or create a browser page for a session.
 * Connects to existing CDP endpoint, opens a new page.
 */
async function getPage(sessionId) {
  // Check existing
  if (_pool.has(sessionId)) {
    const entry = _pool.get(sessionId);
    entry.lastUsed = Date.now();
    try {
      // Verify page is still alive
      await entry.page.evaluate(() => true);
      return entry.page;
    } catch (e) {
      // Page is dead, remove and recreate
      logger.warn(`[${ts()}] [browser-service] Page for ${sessionId} is dead, recreating`);
      _pool.delete(sessionId);
    }
  }

  // Enforce pool limit
  if (_pool.size >= CONFIG.MAX_INSTANCES) {
    // Evict oldest by lastUsed
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of _pool) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      await closePage(oldestKey);
    }
  }

  // Connect to CDP and open new page
  try {
    const browser = await puppeteer.connect({
      browserURL: CONFIG.CDP_ENDPOINT,
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    
    // [R60-T1] Auto-restore cookies for cross-session login persistence
    try {
      const db = getBrowserDb();
      const savedCookies = db.prepare('SELECT cookies_json, url FROM browser_cookie_jar WHERE session_id = ? ORDER BY updated_at DESC LIMIT 5').all(sessionId);
      if (savedCookies.length > 0) {
        for (const row of savedCookies) {
          try {
            const cookies = JSON.parse(row.cookies_json);
            // Set cookies for the domain they were saved from
            const cookieUrl = row.url;
            await page.setCookie(...cookies.map(c => ({ ...c, url: cookieUrl })));
          } catch (parseErr) { /* skip malformed cookie */ }
        }
        logger.info(`[${ts()}] [browser-service] Restored cookies from ${savedCookies.length} saved jars for ${sessionId}`);
      }
    } catch (e) { logger.warn(`[${ts()}] [browser-service] Cookie restore failed (non-fatal): ${e.message}`); }
    
    // Set reasonable defaults
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 RangerAI/1.0');
    page.setDefaultNavigationTimeout(CONFIG.NAV_TIMEOUT_MS);
    page.setDefaultTimeout(CONFIG.CLICK_TIMEOUT_MS);

    _pool.set(sessionId, {
      page,
      browser,
      lastUsed: Date.now(),
      createdAt: Date.now(),
    });

    logger.info(`[${ts()}] [browser-service] New page created for session ${sessionId} (pool size: ${_pool.size})`);

    // Start cleanup timer if not running
    if (!_cleanupTimer) {
      _cleanupTimer = setInterval(cleanupExpired, 60000);
    }

    return page;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Failed to connect to CDP: ${err.message}`);
    throw new Error(`Browser connection failed: ${err.message}`);
  }
}

/**
 * Close and remove a page from the pool.
 */
async function closePage(sessionId) {
  const entry = _pool.get(sessionId);
  if (!entry) return;
  // [R60-T1] Auto-save cookies before closing page
  try {
    const currentUrl = entry.page.url();
    if (currentUrl && currentUrl.startsWith('http')) {
      const cookies = await entry.page.cookies();
      if (cookies && cookies.length > 0) {
        const db = getBrowserDb();
        const cookiesJson = JSON.stringify(cookies);
        // Upsert: replace existing cookie jar for this session+url
        const existing = db.prepare('SELECT id FROM browser_cookie_jar WHERE session_id = ? AND url = ?').get(sessionId, currentUrl);
        if (existing) {
          db.prepare('UPDATE browser_cookie_jar SET cookies_json = ?, updated_at = ? WHERE id = ?').run(cookiesJson, Date.now(), existing.id);
        } else {
          db.prepare('INSERT INTO browser_cookie_jar (session_id, url, cookies_json, updated_at) VALUES (?, ?, ?, ?)').run(sessionId, currentUrl, cookiesJson, Date.now());
        }
        logger.info(`[${ts()}] [browser-service] Saved ${cookies.length} cookies for ${sessionId} @ ${currentUrl}`);
      }
    }
  } catch (e) { logger.warn(`[${ts()}] [browser-service] Cookie save failed (non-fatal): ${e.message}`); }
  try {
    await entry.page.close();
  } catch (e) { /* ignore */ }
  try {
    entry.browser.disconnect();
  } catch (e) { /* ignore */ }
  _pool.delete(sessionId);
  logger.info(`[${ts()}] [browser-service] Page closed for session ${sessionId} (pool size: ${_pool.size})`);
}

/**
 * Cleanup expired instances.
 */
function cleanupExpired() {
  const now = Date.now();
  for (const [sessionId, entry] of _pool) {
    if (now - entry.lastUsed > CONFIG.INSTANCE_TTL_MS) {
      closePage(sessionId).catch(() => {});
    }
  }
  if (_pool.size === 0 && _cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ─── Tool Implementations ───

/**
 * Navigate to a URL and return page info.
 * @param {string} sessionId
 * @param {string} url
 * @returns {{ title: string, url: string, textSnippet: string }}
 */
export async function browserNavigate(sessionId, url) {
  const t0 = Date.now();
  for (let attempt = 0; attempt <= BROWSER_MAX_RETRIES; attempt++) {
  try {
    const page = await getPage(sessionId);
    
    // Normalize URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.NAV_TIMEOUT_MS,
    });

    const title = await page.title();
    const currentUrl = page.url();
    const statusCode = response ? response.status() : null;

    // Extract text snippet (first 2000 chars of visible text)
    const textSnippet = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      return body.innerText.substring(0, 2000);
    });

    logger.info(`[${ts()}] [browser-service] Navigated to ${currentUrl} (status=${statusCode}, title="${title}")`);

    const result = { success: true, title, url: currentUrl, statusCode, textSnippet };
    const actionId = logBrowserAction(sessionId, 'navigate', result, Date.now() - t0, { url });
    // [R17-T3] Save text evidence
    saveEvidence(sessionId, actionId, 'text_snapshot', { url: currentUrl, title, text: textSnippet });
    return result;
  } catch (err) {
    if (attempt < BROWSER_MAX_RETRIES) {
      logger.warn(`[${ts()}] [browser-service] Navigate attempt ${attempt + 1}/${BROWSER_MAX_RETRIES + 1} failed, retrying in ${BROWSER_RETRY_DELAY_MS}ms: ${err.message}`);
      await sleep(BROWSER_RETRY_DELAY_MS);
      continue;
    }
    logger.error(`[${ts()}] [browser-service] Navigate failed after ${BROWSER_MAX_RETRIES + 1} attempts: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'navigate', result, Date.now() - t0, { url });
    // [R22-T2] Classify and emit browser failure
    try {
      const classification = classifyBrowserFailure({ action: 'navigate', errorMsg: err.message, url });
      const failureRecord = buildFailureRecord({
        taskId: sessionId, sessionKey: sessionId, action: 'navigate',
        url, errorMsg: err.message, classification,
      });
      emitEvent(sessionId, null, 'browser_failure', failureRecord);
      logger.info(`[${ts()}] [R22-T2] Browser failure classified: category=${classification.category} retryable=${classification.retryable} fallback=${classification.fallbackAction}`);
    } catch (classErr) {
      logger.warn(`[${ts()}] [R22-T2] Failure classification failed (non-fatal): ${classErr.message}`);
    }
    return result;
  }
  }
}

/**
 * Take a screenshot of the current page.
 * @param {string} sessionId
 * @param {object} options - { fullPage?: boolean }
 * @returns {{ base64: string, width: number, height: number }}
 */
export async function browserScreenshot(sessionId, options = {}) {
  const t0 = Date.now();
  for (let attempt = 0; attempt <= BROWSER_MAX_RETRIES; attempt++) {
  try {
    const page = await getPage(sessionId);
    
    const screenshotBuffer = await page.screenshot({
      type: 'png',
      fullPage: options.fullPage || false,
      encoding: 'base64',
    });

    const viewport = page.viewport();

    logger.info(`[${ts()}] [browser-service] Screenshot taken (${viewport?.width}x${viewport?.height})`);

    const pageUrl = page.url();
    const pageTitle = await page.title();
    const result = {
      success: true,
      base64: screenshotBuffer,
      width: viewport?.width || 1280,
      height: viewport?.height || 900,
      url: pageUrl,
      title: pageTitle,
    };
    const actionId = logBrowserAction(sessionId, 'screenshot', result, Date.now() - t0);
    // [R17-T3] Save screenshot evidence to file
    const screenshotPath = saveScreenshotEvidence(sessionId, actionId, screenshotBuffer, pageUrl, pageTitle);
    result.evidencePath = screenshotPath;
    return result;
  } catch (err) {
    if (attempt < BROWSER_MAX_RETRIES) {
      logger.warn(`[${ts()}] [browser-service] Screenshot attempt ${attempt + 1}/${BROWSER_MAX_RETRIES + 1} failed, retrying in ${BROWSER_RETRY_DELAY_MS}ms: ${err.message}`);
      await sleep(BROWSER_RETRY_DELAY_MS);
      continue;
    }
    logger.error(`[${ts()}] [browser-service] Screenshot failed after ${BROWSER_MAX_RETRIES + 1} attempts: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'screenshot', result, Date.now() - t0);
    return result;
  }
  }
}

/**
 * Extract text content from the page or a specific element.
 * @param {string} sessionId
 * @param {string} [selector] - CSS selector (optional, defaults to body)
 * @returns {{ text: string, url: string }}
 */
export async function browserExtractText(sessionId, selector) {
  const t0 = Date.now();
  for (let attempt = 0; attempt <= BROWSER_MAX_RETRIES; attempt++) {
  try {
    const page = await getPage(sessionId);
    
    let text;
    if (selector) {
      const el = await page.$(selector);
      if (!el) {
        const result = { success: false, error: `Element not found: ${selector}` };
        logBrowserAction(sessionId, 'extract_text', result, Date.now() - t0, { selector });
        // [R22-T2] Classify element_not_found failure
        try {
          const classification = classifyBrowserFailure({ action: 'extract_text', errorMsg: `Element not found: ${selector}` });
          const failureRecord = buildFailureRecord({ taskId: sessionId, sessionKey: sessionId, action: 'extract_text', errorMsg: `Element not found: ${selector}`, classification });
          emitEvent(sessionId, null, 'browser_failure', failureRecord);
        } catch (_) {}
        return result;
      }
      text = await page.evaluate(el => el.innerText, el);
    } else {
      text = await page.evaluate(() => document.body ? document.body.innerText : '');
    }

    // Cap at 10000 chars
    if (text.length > 10000) {
      text = text.substring(0, 10000) + '\n... (truncated)';
    }

    logger.info(`[${ts()}] [browser-service] Text extracted: ${text.length} chars (selector=${selector || 'body'})`);

    const pageUrl = page.url();
    const pageTitle = await page.title();
    const result = {
      success: true,
      text,
      url: pageUrl,
      title: pageTitle,
      selector: selector || 'body',
    };
    const actionId = logBrowserAction(sessionId, 'extract_text', result, Date.now() - t0, { selector: selector || 'body' });
    // [R17-T3] Save text evidence
    saveEvidence(sessionId, actionId, 'extracted_text', { url: pageUrl, title: pageTitle, text, selector: selector || 'body' });
    return result;
  } catch (err) {
    if (attempt < BROWSER_MAX_RETRIES) {
      logger.warn(`[${ts()}] [browser-service] Extract text attempt ${attempt + 1}/${BROWSER_MAX_RETRIES + 1} failed, retrying in ${BROWSER_RETRY_DELAY_MS}ms: ${err.message}`);
      await sleep(BROWSER_RETRY_DELAY_MS);
      continue;
    }
    logger.error(`[${ts()}] [browser-service] Extract text failed after ${BROWSER_MAX_RETRIES + 1} attempts: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'extract_text', result, Date.now() - t0, { selector });
    // [R22-T2] Classify and emit browser failure
    try {
      const classification = classifyBrowserFailure({ action: 'extract_text', errorMsg: err.message });
      const failureRecord = buildFailureRecord({ taskId: sessionId, sessionKey: sessionId, action: 'extract_text', errorMsg: err.message, classification });
      emitEvent(sessionId, null, 'browser_failure', failureRecord);
    } catch (_) {}
    return result;
  }
  }
}

/**
 * Click an element by CSS selector.
 * @param {string} sessionId
 * @param {string} selector - CSS selector
 * @returns {{ clicked: boolean, url: string }}
 */
export async function browserClick(sessionId, selector) {
  const t0 = Date.now();
  try {
    const page = await getPage(sessionId);
    
    // Wait for element to be visible
    await page.waitForSelector(selector, { visible: true, timeout: CONFIG.CLICK_TIMEOUT_MS });
    await page.click(selector);

    // Wait a bit for navigation or DOM changes
    await new Promise(r => setTimeout(r, 500));

    const newUrl = page.url();
    const newTitle = await page.title();

    logger.info(`[${ts()}] [browser-service] Clicked: ${selector} → url=${newUrl}`);

    const result = { success: true, clicked: true, selector, url: newUrl, title: newTitle };
    logBrowserAction(sessionId, 'click', result, Date.now() - t0, { selector });
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Click failed: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'click', result, Date.now() - t0, { selector });
    // [R22-T2] Classify and emit browser failure
    try {
      const classification = classifyBrowserFailure({ action: 'click', errorMsg: err.message });
      const failureRecord = buildFailureRecord({ taskId: sessionId, sessionKey: sessionId, action: 'click', errorMsg: err.message, classification });
      emitEvent(sessionId, null, 'browser_failure', failureRecord);
    } catch (_) {}
    return result;
  }
}

// ─── [R60-T1] Extended Browser Actions ───

/**
 * Type text into an input field identified by CSS selector.
 * @param {string} sessionId
 * @param {string} selector - CSS selector for the input element
 * @param {string} text - Text to type
 * @returns {{ success: boolean, selector: string, textLength: number }}
 */
export async function browserType(sessionId, selector, text) {
  const t0 = Date.now();
  try {
    const page = await getPage(sessionId);
    await page.waitForSelector(selector, { visible: true, timeout: CONFIG.CLICK_TIMEOUT_MS });
    // Clear existing content, then type
    await page.click(selector, { clickCount: 3 }); // triple-click to select all
    await page.type(selector, text, { delay: 20 }); // human-like typing

    logger.info(`[${ts()}] [browser-service] Typed ${text.length} chars into ${selector}`);
    const result = { success: true, selector, textLength: text.length };
    logBrowserAction(sessionId, 'type', result, Date.now() - t0, { selector });
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Type failed: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'type', result, Date.now() - t0, { selector });
    return result;
  }
}

/**
 * Fill multiple form fields at once.
 * @param {string} sessionId
 * @param {Array<{selector: string, value: string}>} fields
 * @returns {{ success: boolean, filled: number, failed: number }}
 */
export async function browserFillForm(sessionId, fields) {
  const t0 = Date.now();
  let filled = 0, failed = 0;
  const errors = [];
  try {
    const page = await getPage(sessionId);
    for (const { selector, value } of fields) {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        await page.click(selector, { clickCount: 3 });
        await page.type(selector, value, { delay: 15 });
        filled++;
      } catch (fieldErr) {
        failed++;
        errors.push({ selector, error: fieldErr.message });
      }
    }
    logger.info(`[${ts()}] [browser-service] Form filled: ${filled}/${fields.length} fields (${failed} failed)`);
    const result = { success: failed === 0, filled, failed, total: fields.length, errors: errors.length > 0 ? errors : undefined };
    logBrowserAction(sessionId, 'fill_form', result, Date.now() - t0, { selector: fields.map(f => f.selector).join(',') });
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Fill form failed: ${err.message}`);
    return { success: false, error: err.message, filled, failed };
  }
}

/**
 * Select an option from a <select> dropdown.
 * @param {string} sessionId
 * @param {string} selector - CSS selector for the <select> element
 * @param {string} value - Option value or label text to select
 * @returns {{ success: boolean, selector: string, selectedValue: string }}
 */
export async function browserSelect(sessionId, selector, value) {
  const t0 = Date.now();
  try {
    const page = await getPage(sessionId);
    await page.waitForSelector(selector, { visible: true, timeout: CONFIG.CLICK_TIMEOUT_MS });
    await page.select(selector, value);

    logger.info(`[${ts()}] [browser-service] Selected "${value}" from ${selector}`);
    const result = { success: true, selector, selectedValue: value };
    logBrowserAction(sessionId, 'select', result, Date.now() - t0, { selector });
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Select failed: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'select', result, Date.now() - t0, { selector });
    return result;
  }
}

/**
 * Hover over an element to trigger tooltips, dropdowns, etc.
 * @param {string} sessionId
 * @param {string} selector - CSS selector for the element to hover
 * @returns {{ success: boolean, selector: string }}
 */
export async function browserHover(sessionId, selector) {
  const t0 = Date.now();
  try {
    const page = await getPage(sessionId);
    await page.waitForSelector(selector, { visible: true, timeout: CONFIG.CLICK_TIMEOUT_MS });
    await page.hover(selector);
    await new Promise(r => setTimeout(r, 300)); // wait for hover effects

    logger.info(`[${ts()}] [browser-service] Hovered ${selector}`);
    const result = { success: true, selector };
    logBrowserAction(sessionId, 'hover', result, Date.now() - t0, { selector });
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Hover failed: ${err.message}`);
    const result = { success: false, error: err.message };
    logBrowserAction(sessionId, 'hover', result, Date.now() - t0, { selector });
    return result;
  }
}

/**
 * Get cookies for the current page.
 * @param {string} sessionId
 * @returns {{ success: boolean, cookies: Array, count: number }}
 */
export async function browserGetCookies(sessionId) {
  const t0 = Date.now();
  try {
    const page = await getPage(sessionId);
    const cookies = await page.cookies();
    logger.info(`[${ts()}] [browser-service] Got ${cookies.length} cookies`);
    const result = { success: true, cookies, count: cookies.length };
    logBrowserAction(sessionId, 'get_cookies', result, Date.now() - t0, {});
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Get cookies failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Set cookies on the current page (e.g., for session restoration).
 * @param {string} sessionId
 * @param {Array<object>} cookies - Array of cookie objects { name, value, domain?, ... }
 * @returns {{ success: boolean, setCount: number }}
 */
export async function browserSetCookies(sessionId, cookies) {
  const t0 = Date.now();
  try {
    const page = await getPage(sessionId);
    await page.setCookie(...cookies);
    logger.info(`[${ts()}] [browser-service] Set ${cookies.length} cookies`);
    const result = { success: true, setCount: cookies.length };
    logBrowserAction(sessionId, 'set_cookies', result, Date.now() - t0, {});
    return result;
  } catch (err) {
    logger.error(`[${ts()}] [browser-service] Set cookies failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Pool Status ───

/**
 * Get current pool status for monitoring.
 */
/**
 * [R17-T3] Get evidence summary stats.
 */
export function getEvidenceSummary() {
  try {
    const db = getBrowserDb();
    const total = db.prepare('SELECT COUNT(*) as cnt FROM browser_evidence').get()?.cnt || 0;
    const byType = db.prepare('SELECT evidence_type, COUNT(*) as cnt FROM browser_evidence GROUP BY evidence_type').all();
    const bySess = db.prepare('SELECT session_id, COUNT(*) as cnt FROM browser_evidence GROUP BY session_id ORDER BY cnt DESC LIMIT 10').all();
    return { totalEvidence: total, byType, topSessions: bySess };
  } catch (err) {
    return { totalEvidence: 0, byType: [], topSessions: [], error: err.message };
  }
}

export function getPoolStatus() {
  const entries = [];
  for (const [sessionId, entry] of _pool) {
    entries.push({
      sessionId,
      lastUsed: new Date(entry.lastUsed).toISOString(),
      createdAt: new Date(entry.createdAt).toISOString(),
      ageMs: Date.now() - entry.createdAt,
    });
  }
  return {
    poolSize: _pool.size,
    maxInstances: CONFIG.MAX_INSTANCES,
    ttlMs: CONFIG.INSTANCE_TTL_MS,
    instances: entries,
  };
}

/**
 * Shutdown all browser instances.
 */
export async function shutdownAll() {
  for (const sessionId of [..._pool.keys()]) {
    await closePage(sessionId);
  }
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
  logger.info(`[${ts()}] [browser-service] All instances shut down`);
}
