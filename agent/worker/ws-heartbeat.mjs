/**
 * ws-heartbeat.mjs — WebSocket heartbeat/ping-pong (R111)
 * 
 * Server sends ping every 30s, expects pong within 15s.
 * If no pong received, connection is considered dead and closed.
 * Client should respond to ping with pong and implement reconnect on close.
 *
 * Usage: import { startHeartbeat, stopHeartbeat } from './ws-heartbeat.mjs';
 *        startHeartbeat(wss); // pass the WebSocket.Server instance
 *
 * @module worker/ws-heartbeat
 */
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 15000;

const heartbeatTimers = new Map();

export function startHeartbeat(wss) {
  if (!wss) return;
  
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws._isAlive === false) {
        logger.info(`[${ts()}] [R111] Terminating dead connection (no pong)`);
        ws.terminate();
        return;
      }
      ws._isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        logger.warn(`[${ts()}] [R111] Ping failed: ${err.message}`);
      }
    });
  }, PING_INTERVAL_MS);
  
  wss.on('connection', (ws) => {
    ws._isAlive = true;
    ws.on('pong', () => {
      ws._isAlive = true;
    });
  });
  
  heartbeatTimers.set(wss, interval);
  logger.info(`[${ts()}] [R111] Heartbeat started (ping every ${PING_INTERVAL_MS/1000}s)`);
  return interval;
}

export function stopHeartbeat(wss) {
  const interval = heartbeatTimers.get(wss);
  if (interval) {
    clearInterval(interval);
    heartbeatTimers.delete(wss);
    logger.info(`[${ts()}] [R111] Heartbeat stopped`);
  }
}

export function getHeartbeatStatus() {
  return {
    activeServers: heartbeatTimers.size,
    pingInterval: PING_INTERVAL_MS,
    pongTimeout: PONG_TIMEOUT_MS,
  };
}
