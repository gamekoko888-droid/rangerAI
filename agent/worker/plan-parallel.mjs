// plan-parallel.mjs — R98 parallel plan scheduling helpers.

import { logger } from '../lib/logger.mjs';
import { _planCache } from './plan-storage.mjs';

const ts = () => new Date().toISOString();

export function getParallelBatches(taskId) {
  const plan = _planCache.get(taskId);
  if (!plan || !plan.steps) return [];

  const steps = plan.steps;
  const idToStep = new Map(steps.map(s => [String(s.id), s]));
  const completed = new Set(steps.filter(s => s.status === 'done' || s.status === 'skipped').map(s => String(s.id)));
  const pending = steps.filter(s => s.status === 'pending' || s.status === 'doing' || s.status === 'retrying');

  const batches = [];
  const dispatched = new Set([...completed]);

  // Topological wave sort
  let iterations = 0;
  while (pending.length > 0 && iterations < 20) {
    iterations++;
    const wave = pending.filter(step => {
      if (dispatched.has(String(step.id))) return false;
      const deps = (step.dependsOn || []).map(String);
      return deps.every(dep => dispatched.has(dep));
    });
    if (wave.length === 0) {
      // Circular dependency or blocked — take next pending step as fallback
      const blocked = pending.find(s => !dispatched.has(String(s.id)));
      if (blocked) wave.push(blocked);
      else break;
    }
    batches.push(wave);
    wave.forEach(s => dispatched.add(String(s.id)));
  }

  if (batches.length > 0) {
    const waveInfo = batches.map((b, i) => `w${i + 1}:[${b.map(s => s.id).join(',')}]`).join(' ');
    logger.info(`[${ts()}] [L4-parallel] ${taskId} batches: ${waveInfo}`);
  }

  return batches;
}

/**
 * [L4] Get the next parallel wave of steps ready to execute.
 * Returns steps whose dependsOn are all satisfied.
 *
 * @param {string} taskId
 * @returns {Array<Object>} Steps ready to run (may be multiple for parallel execution)
 */
export function getNextExecutableSteps(taskId) {
  const batches = getParallelBatches(taskId);
  return batches.length > 0 ? batches[0] : [];
}



