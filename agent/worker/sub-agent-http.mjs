const MAX_CONCURRENT = 3;
let active = 0;
const queue = [];

async function withSemaphore(fn) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => queue.push(resolve));
  }
  active += 1;
  try { return await fn(); } finally {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }
}

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export async function executeSubAgent(prompt, options = {}) {
  const cfg = { timeout: 60000, model: 'auto', maxTokens: 4000, ...options };
  const sessionKey = `sub-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  return withSemaphore(async () => {
    const start = Date.now();
    await fetch('http://127.0.0.1:3002/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey, message: prompt, model: cfg.model, maxTokens: cfg.maxTokens }) });
    while (Date.now() - start < cfg.timeout) {
      const r = await fetch(`http://127.0.0.1:3002/api/task-status/${sessionKey}`);
      if (r.ok) {
        const data = await r.json();
        if (data.status === 'completed' || data.done) {
          return data.result || data.message || data.assistantMessage || JSON.stringify(data);
        }
      }
      await sleep(2000);
    }
    throw new Error('sub-agent timeout');
  });
}
