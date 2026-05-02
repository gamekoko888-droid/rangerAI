let draining = false;
const active = new Set();
export function trackRequest(id) { if (!draining) active.add(id); }
export function finishRequest(id) { active.delete(id); }
export function initGracefulShutdown(saveState = async () => {}) {
  async function shutdown() { if (draining) return; draining = true; await saveState(); const t = Date.now(); while (active.size && Date.now()-t < 10000) await new Promise(r=>setTimeout(r,100)); process.exit(0); }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
