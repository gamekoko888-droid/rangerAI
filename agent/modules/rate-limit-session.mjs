// Deploy pipeline E2E test - 2026-05-02T05:28:33Z
const hits = new Map();
export function checkRateLimit(id, max = 60, windowMs = 60000) {
  const now = Date.now();
  const arr = hits.get(id) || [];
  const next = arr.filter(ts => now - ts < windowMs);
  next.push(now); hits.set(id, next);
  return { allowed: next.length <= max, remaining: Math.max(0, max - next.length) };
}
