import { orchestrateParallel } from './parallel-orchestrator.mjs';

export function markParallelSteps(plan) {
  if (!plan?.steps || !Array.isArray(plan.steps)) return plan;
  const seen = [];
  for (const step of plan.steps) {
    const text = String(step?.title || step?.text || '').toLowerCase();
    step.parallel = !/(then|after|based on|依赖|然后|之后|根据上一步)/.test(text) && seen.length > 0;
    seen.push(step);
  }
  return plan;
}

export async function executePlanWithParallel(steps = []) {
  const parallelTasks = steps.filter(s => s.parallel).map((s, i) => ({ id: s.id || `p${i}`, prompt: s.prompt || s.title || s.text || '' }));
  if (!parallelTasks.length) return null;
  return orchestrateParallel(parallelTasks);
}
