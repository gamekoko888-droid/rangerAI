// modules/parallel-planner-bridge.mjs — Bridge between planner and sub-agent-orchestrator
// Q10: Enables the planner to detect parallelizable steps and delegate to orchestrator
import { getParallelBatches, getNextExecutableSteps } from '../worker/planner.mjs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// Lazy import orchestrator
let _orchestrator = null;
async function getOrchestrator() {
  if (!_orchestrator) {
    try {
      _orchestrator = await import('../worker/sub-agent-orchestrator.mjs');
    } catch (e) {
      logger.error(`[${ts()}] [parallel-bridge] Failed to import orchestrator: ${e.message}`);
      return null;
    }
  }
  return _orchestrator;
}

/**
 * Analyze a plan for parallelizable steps.
 * Returns batches of steps that can execute concurrently.
 * @param {string} taskId - The task/plan identifier
 * @returns {{ canParallelize: boolean, batches: Array, reason: string }}
 */
export function analyzeParallelOpportunities(taskId) {
  try {
    const batches = getParallelBatches(taskId);
    if (!batches || batches.length === 0) {
      return { canParallelize: false, batches: [], reason: 'No parallel batches found' };
    }
    
    // Filter batches with more than 1 step (single-step batches aren't parallel)
    const parallelBatches = batches.filter(b => b.steps && b.steps.length > 1);
    
    if (parallelBatches.length === 0) {
      return { canParallelize: false, batches: [], reason: 'All batches are sequential (single step)' };
    }
    
    return {
      canParallelize: true,
      batches: parallelBatches,
      reason: `Found ${parallelBatches.length} parallel batch(es) with ${parallelBatches.reduce((sum, b) => sum + b.steps.length, 0)} total steps`
    };
  } catch (e) {
    return { canParallelize: false, batches: [], reason: `Analysis error: ${e.message}` };
  }
}

/**
 * Execute a parallel batch using the sub-agent orchestrator.
 * @param {Object} batch - { steps: [...], batchId }
 * @param {Object} context - { sessionKey, taskId, userRole, gateway }
 * @returns {Promise<{ results: Array, success: boolean }>}
 */
export async function executeParallelBatch(batch, context = {}) {
  const orch = await getOrchestrator();
  if (!orch || !orch.orchestrateWave) {
    logger.error(`[${ts()}] [parallel-bridge] Orchestrator not available, falling back to sequential`);
    return { results: [], success: false, fallbackToSequential: true };
  }
  
  const { sessionKey, taskId } = context;
  
  // Convert plan steps to orchestrator-compatible subtasks
  const subtasks = batch.steps.map((step, idx) => ({
    id: `${batch.batchId || 'batch'}-${idx}`,
    prompt: step.description || step.action || `Execute step ${step.id}`,
    tools: step.tools || [],
    context: { stepId: step.id, taskId, sessionKey }
  }));
  
  logger.info(`[${ts()}] [parallel-bridge] Executing parallel batch: ${subtasks.length} subtasks`);
  
  try {
    const waveResult = await orch.orchestrateWave(subtasks, {
      sessionKey,
      maxConcurrency: Math.min(subtasks.length, 3), // Cap at 3 concurrent
      timeoutMs: 60000
    });
    
    return {
      results: waveResult.results || [],
      success: waveResult.success !== false,
      stats: {
        total: subtasks.length,
        succeeded: (waveResult.results || []).filter(r => r.success).length,
        failed: (waveResult.results || []).filter(r => !r.success).length,
        durationMs: waveResult.durationMs || 0
      }
    };
  } catch (e) {
    logger.error(`[${ts()}] [parallel-bridge] Batch execution failed: ${e.message}`);
    return { results: [], success: false, error: e.message, fallbackToSequential: true };
  }
}

/**
 * Decide whether to use parallel execution for the next steps.
 * Called by the main execution loop before processing plan steps.
 * @param {string} taskId
 * @param {Object} context
 * @returns {{ useParallel: boolean, batch: Object|null, reason: string }}
 */
export function shouldUseParallelExecution(taskId, context = {}) {
  const analysis = analyzeParallelOpportunities(taskId);
  
  if (!analysis.canParallelize) {
    return { useParallel: false, batch: null, reason: analysis.reason };
  }
  
  // Get the next executable batch
  const nextSteps = getNextExecutableSteps(taskId);
  if (!nextSteps || nextSteps.length <= 1) {
    return { useParallel: false, batch: null, reason: 'Only one step ready to execute' };
  }
  
  // Check if the ready steps form a parallel batch
  const readyBatch = analysis.batches.find(b => 
    b.steps.some(s => nextSteps.find(ns => ns.id === s.id))
  );
  
  if (!readyBatch) {
    return { useParallel: false, batch: null, reason: 'Ready steps not in a parallel batch' };
  }
  
  return {
    useParallel: true,
    batch: readyBatch,
    reason: `Parallel batch ready: ${readyBatch.steps.length} steps`
  };
}
