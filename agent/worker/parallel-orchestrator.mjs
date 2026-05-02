import { executeSubAgent } from './sub-agent-http.mjs';

export async function orchestrateParallel(tasks = []) {
  const start = Date.now();
  const results = new Map();
  const failed = [];
  const pending = new Map(tasks.map(t => [t.id, t]));
  while (pending.size) {
    const ready = [...pending.values()].filter(t => !(t.dependencies||[]).some(d => !results.has(d)));
    if (!ready.length) break;
    await Promise.all(ready.slice(0,3).map(async (t) => {
      try { results.set(t.id, await executeSubAgent(t.prompt, t.options||{})); }
      catch { failed.push(t.id); }
      finally { pending.delete(t.id); }
    }));
  }
  const confidence = results.size === 0 ? 0 : Math.max(0, (results.size - failed.length) / results.size);
  return { results, failed, duration_ms: Date.now() - start, confidence };
}
