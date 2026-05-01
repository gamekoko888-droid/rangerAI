/**
 * notification-service.mjs — Unified notification service
 * Supports: DingTalk Webhook, Generic Webhook, Console log
 */
import http from 'http';
import https from 'https';

import { logger } from './lib/logger.mjs';

/**
 * Send notification via configured channel
 * @param {Object} opts
 * @param {string} opts.channel - 'dingtalk_webhook' | 'webhook' | 'console'
 * @param {string} opts.title - Notification title
 * @param {string} opts.content - Notification body (markdown supported for dingtalk)
 * @param {string} [opts.webhookUrl] - Webhook URL
 * @param {Object} [opts.extra] - Extra data for webhook payload
 */
export async function sendNotification({ channel = 'console', title, content, webhookUrl, extra = {} }) {
  logger.info(`Sending via ${channel}: ${title}`);
  
  if (channel === 'dingtalk_webhook') {
    return sendDingTalkWebhook({ title, content, webhookUrl });
  } else if (channel === 'webhook') {
    return sendGenericWebhook({ title, content, webhookUrl, extra });
  } else {
    logger.info(`[console] ${title}: ${content}`);
    return { success: true, channel: 'console' };
  }
}

async function sendDingTalkWebhook({ title, content, webhookUrl }) {
  if (!webhookUrl) throw new Error('DingTalk webhook URL required');
  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { title, text: `### ${title}\n\n${content}` }
  });
  return postJSON(webhookUrl, body);
}

async function sendGenericWebhook({ title, content, webhookUrl, extra }) {
  if (!webhookUrl) throw new Error('Webhook URL required');
  const body = JSON.stringify({ title, content, timestamp: new Date().toISOString(), ...extra });
  return postJSON(webhookUrl, body);
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        logger.info(`Webhook response ${res.statusCode}: ${data.slice(0, 200)}`);
        resolve({ success: res.statusCode < 400, statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Webhook timeout')); });
    req.write(body);
    req.end();
  });
}

export default { sendNotification };
