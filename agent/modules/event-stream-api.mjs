import { logger } from '../lib/logger.mjs';
import { getEvents } from '../worker/event-stream.mjs';

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

export function init() {
  logger.info('[event-stream-api] initialized');
}

export async function handleEventStreamApi(req, res) {
  const urlPath = req.url?.split('?')[0] || '';
  if (urlPath !== '/api/event-stream/latest' || req.method !== 'POST') return false;

  try {
    const body = await readJsonBody(req);
    const sessionKey = typeof body.sessionKey === 'string' && body.sessionKey.trim() ? body.sessionKey.trim() : undefined;
    const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(200, Number(body.limit))) : 50;
    const sinceId = Number.isFinite(Number(body.sinceId)) ? Number(body.sinceId) : undefined;
    const eventTypes = Array.isArray(body.eventTypes) ? body.eventTypes.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : undefined;

    const events = await getEvents(sessionKey, { eventTypes, sinceId, limit, order: 'desc' });
    sendJson(res, 200, { success: true, events });
    return true;
  } catch (err) {
    logger.error(`[event-stream-api] latest failed: ${err.message}`);
    sendJson(res, 500, { success: false, error: err.message });
    return true;
  }
}
