const sessionMap = new Map();
const TTL_MS = 30 * 60 * 1000;

export function bindGatewaySession(taskId, gatewaySessionKey) {
  sessionMap.set(taskId, { gatewaySessionKey, ts: Date.now() });
}

export function getGatewaySession(taskId) {
  const item = sessionMap.get(taskId);
  if (!item) return null;
  if (Date.now() - item.ts > TTL_MS) { sessionMap.delete(taskId); return null; }
  return item.gatewaySessionKey;
}

export function cleanupGatewaySessions() {
  const now = Date.now();
  for (const [k, v] of sessionMap) if (now - v.ts > TTL_MS) sessionMap.delete(k);
  return sessionMap.size;
}

export function getGatewayMuxStats(){ return { activeSessions: sessionMap.size, ttlMs: TTL_MS }; }
setInterval(cleanupGatewaySessions, 5 * 60 * 1000).unref?.();
