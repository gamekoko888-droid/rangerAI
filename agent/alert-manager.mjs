#!/usr/bin/env node
/**
 * alert-manager.mjs — Alert notification module for RangerAI health checks.
 * Iter-12C: Supports multiple notification channels with cooldown/dedup.
 *
 * Channels:
 *   1. Console log (always active)
 *   2. Alert log file (/opt/rangerai-agent/logs/alerts.log)
 *   3. MySQL alert_events table (persistent)
 *   4. Telegram bot (when configured via secrets.json)
 *
 * Usage:
 *   import { sendAlert, checkAndAlert } from './alert-manager.mjs';
 *   await sendAlert({ level: 'CRIT', title: 'Agent Down', body: '...' });
 *   // Or auto-check from health-check results:
 *   await checkAndAlert(healthCheckResult);
 */
import { logger } from './lib/logger.mjs';
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_DIR = '/opt/rangerai-agent';
const LOG_DIR = join(BASE_DIR, 'logs');
const ALERT_LOG = join(LOG_DIR, 'alerts.log');
const COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown per component

// In-memory cooldown tracker
const lastAlertTime = new Map();

/** Load secrets.json */
function loadSecrets() {
  try {
    return JSON.parse(readFileSync(join(BASE_DIR, 'secrets.json'), 'utf8'));
  } catch(e) { logger.error("[alert-manager]", e.message); return {}; }
}

/** Write to alert log file */
function logToFile(level, title, body) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${title}: ${body}\n`;
    appendFileSync(ALERT_LOG, line);
  } catch (e) {
    logger.error('[alert-manager] Failed to write log:', e.message);
  }
}

/** Write to MySQL alert_events table */
async function logToMySQL(level, title, body, component) {
  try {
    const mysql2 = (await import('mysql2/promise')).default;
    const conn = await mysql2.createConnection({
      host: '127.0.0.1', port: 3306, user: 'root',
      password: process.env.MYSQL_PASSWORD || 'RangerAI2026!', database: process.env.MYSQL_DATABASE || 'rangerai',
      connectTimeout: 5000,
    });
    // Ensure table exists
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS alert_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        level VARCHAR(10) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT,
        component VARCHAR(100),
        acknowledged BOOLEAN DEFAULT FALSE,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.execute(
      'INSERT INTO alert_events (level, title, body, component) VALUES (?, ?, ?, ?)',
      [level, title, body, component || null]
    );
    await conn.end();
  } catch (e) {
    logger.error('[alert-manager] MySQL write failed:', e.message);
  }
}

/** Send Telegram notification (if configured) */
async function sendTelegram(level, title, body) {
  const secrets = loadSecrets();
  const botToken = secrets.TG_BOT_TOKEN;
  const chatId = secrets.TG_CHAT_ID;
  if (!botToken || !chatId) return false;

  const emoji = level === 'CRIT' ? '🔴' : level === 'WARN' ? '🟡' : 'ℹ️';
  const text = `${emoji} *RangerAI ${level}*\n\n*${title}*\n${body}`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      logger.error('[alert-manager] Telegram error:', data.description);
      return false;
    }
    return true;
  } catch (e) {
    logger.error('[alert-manager] Telegram send failed:', e.message);
    return false;
  }
}

/**
 * Send an alert through all configured channels.
 * @param {Object} opts
 * @param {string} opts.level - 'CRIT' | 'WARN' | 'INFO'
 * @param {string} opts.title - Alert title
 * @param {string} opts.body - Alert body/details
 * @param {string} [opts.component] - Component identifier for dedup
 */
export async function sendAlert({ level, title, body, component }) {
  // Cooldown check
  const key = `${level}:${component || title}`;
  const now = Date.now();
  const lastTime = lastAlertTime.get(key) || 0;
  if (now - lastTime < COOLDOWN_MS) {
    logger.info(`[alert-manager] Cooldown active for ${key}, skipping`);
    return { sent: false, reason: 'cooldown' };
  }
  lastAlertTime.set(key, now);

  // Channel 1: Console
  const ts = new Date().toISOString();
  logger.info(`[${ts}] [ALERT:${level}] ${title}: ${body}`);

  // Channel 2: Log file
  logToFile(level, title, body);

  // Channel 3: MySQL
  await logToMySQL(level, title, body, component);

  // Channel 4: Telegram
  const tgSent = await sendTelegram(level, title, body);

  return { sent: true, channels: { console: true, file: true, mysql: true, telegram: tgSent } };
}

/**
 * Analyze health check results and send alerts for CRIT/WARN components.
 * @param {Object} result - Health check result from health-check.mjs
 */
export async function checkAndAlert(result) {
  if (!result || !result.results) return;

  const criticals = result.results.filter(r => r.status === 'CRIT');
  const warnings = result.results.filter(r => r.status === 'WARN');

  // Send individual alerts for CRIT components
  for (const c of criticals) {
    await sendAlert({
      level: 'CRIT',
      title: `${c.component} 故障`,
      body: c.message,
      component: c.component,
    });
  }

  // Send summary alert for WARN (batch)
  if (warnings.length > 0) {
    const warnSummary = warnings.map(w => `• ${w.component}: ${w.message}`).join('\n');
    await sendAlert({
      level: 'WARN',
      title: `${warnings.length} 项警告`,
      body: warnSummary,
      component: 'batch-warnings',
    });
  }

  // Send recovery alert if all clear after previous CRIT
  if (criticals.length === 0 && result.status === 'PASS') {
    // Check if there was a recent CRIT in alert_events
    try {
      const mysql2 = (await import('mysql2/promise')).default;
      const conn = await mysql2.createConnection({
        host: '127.0.0.1', port: 3306, user: 'root',
        password: process.env.MYSQL_PASSWORD || 'RangerAI2026!', database: process.env.MYSQL_DATABASE || 'rangerai',
        connectTimeout: 5000,
      });
      const [rows] = await conn.execute(
        `SELECT COUNT(*) as cnt FROM alert_events
         WHERE level = 'CRIT' AND acknowledged = FALSE
         AND createdAt >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`
      );
      if (rows[0]?.cnt > 0) {
        // Mark as acknowledged and send recovery
        await conn.execute(
          `UPDATE alert_events SET acknowledged = TRUE
           WHERE level = 'CRIT' AND acknowledged = FALSE`
        );
        await sendAlert({
          level: 'INFO',
          title: '系统恢复正常',
          body: `所有 ${result.results.length} 项检查通过。之前的 ${rows[0].cnt} 个告警已自动确认。`,
          component: 'recovery',
        });
      }
      await conn.end();
    } catch (e) {
      logger.error('[alert-manager] Recovery check failed:', e.message);
    }
  }

  return { criticals: criticals.length, warnings: warnings.length };
}

// CLI mode: run directly to test
if (process.argv[1] && process.argv[1].endsWith('alert-manager.mjs')) {
  const mode = process.argv[2] || 'test';
  if (mode === 'test') {
    logger.info('[alert-manager] Running test alert...');
    const result = await sendAlert({
      level: 'WARN',
      title: '测试告警',
      body: '这是一条测试告警消息，验证告警通道是否正常工作。',
      component: 'test',
    });
    logger.info('[alert-manager] Result:', JSON.stringify(result));
  } else if (mode === 'check') {
    // Read health check result from stdin
    const { execSync } = await import('child_process');
    const healthJson = execSync('node /opt/rangerai-agent/scripts/health-check.mjs --format=json --no-persist', { encoding: 'utf8' });
    const healthResult = JSON.parse(healthJson);
    const alertResult = await checkAndAlert(healthResult);
    logger.info('[alert-manager] Alert result:', JSON.stringify(alertResult));
  }
}
