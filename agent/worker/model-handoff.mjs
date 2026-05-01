/**
 * model-handoff.mjs — Unified Model Handoff Protocol
 * 
 * Phase 4 of Context Management Refactoring:
 * Implements a standardized handoff packet when switching between models.
 * 
 * Problem: When smart-router switches models (e.g., gpt-5.4-mini → claude),
 * the new model has no context about what the previous model was doing.
 * This causes:
 *   - Lost context on model switch
 *   - Redundant re-explanation by users
 *   - Inconsistent behavior across model transitions
 * 
 * Solution: Build a structured handoff packet that includes:
 *   - Task summary (what we're doing)
 *   - Key decisions made so far
 *   - Active constraints and user preferences
 *   - Relevant memory snippets
 *   - Model transition reason
 * 
 * @module worker/model-handoff
 */
import { logger } from '../lib/logger.mjs';
import { getActiveTaskState } from './task-engine.mjs';
import { recallUnifiedMemory } from './memory-manager.mjs';

const ts = () => new Date().toISOString();

// ─── Configuration ───
const HANDOFF_CONFIG = {
  MAX_SUMMARY_LENGTH: 500,
  MAX_DECISIONS_LENGTH: 300,
  MAX_MEMORY_LENGTH: 800,
  MAX_TOTAL_LENGTH: 2000,
  // Track model transitions per session
  TRANSITION_HISTORY_SIZE: 5,
};

// In-memory transition history (per session)
const _transitionHistory = new Map();

/**
 * Record a model transition for a session.
 */
export function recordTransition(sessionKey, fromModel, toModel, reason, category) {
  if (!_transitionHistory.has(sessionKey)) {
    _transitionHistory.set(sessionKey, []);
  }
  const history = _transitionHistory.get(sessionKey);
  history.push({
    from: fromModel,
    to: toModel,
    reason,
    category,
    timestamp: Date.now(),
  });
  // Keep only recent transitions
  if (history.length > HANDOFF_CONFIG.TRANSITION_HISTORY_SIZE) {
    history.shift();
  }
}

/**
 * Check if a model transition is happening and build a handoff packet if needed.
 * 
 * @param {string} sessionKey
 * @param {string} currentModel - Model about to be used
 * @param {string} previousModel - Model used in last turn (null if first turn)
 * @param {object} routeResult - Smart router result { model, category, thinking, reason }
 * @param {object} context - { userMessage, userId, conversationHistory }
 * @returns {string|null} Handoff injection string, or null if no transition
 */
export async function buildHandoffPacket(sessionKey, currentModel, previousModel, routeResult, context = {}) {
  // No transition → no handoff needed
  if (!previousModel || currentModel === previousModel) return null;
  
  // Same provider family → minimal handoff (e.g., gpt-5.4 → gpt-5.4-mini)
  const sameProvider = getProvider(currentModel) === getProvider(previousModel);
  
  logger.info(`[${ts()}] [handoff] Model transition: ${previousModel} → ${currentModel} (${sameProvider ? 'same' : 'cross'} provider, reason: ${routeResult?.reason || 'unknown'})`);
  
  // Record the transition
  recordTransition(sessionKey, previousModel, currentModel, routeResult?.reason || 'unknown', routeResult?.category || 'unknown');
  
  const parts = [];
  parts.push('[MODEL_HANDOFF — Context from previous model interaction]');
  
  // 1. Transition metadata
  parts.push(`Previous model: ${previousModel}`);
  parts.push(`Current model: ${currentModel}`);
  parts.push(`Switch reason: ${routeResult?.reason || 'auto-routing'}`);
  parts.push(`Task type: ${routeResult?.category || 'unknown'}`);
  
  // 2. Task state summary (if available)
  try {
    const taskState = await getActiveTaskState(sessionKey);
    if (taskState && taskState.status !== 'idle') {
      const stateInfo = [];
      if (taskState.currentGoal) stateInfo.push(`Goal: ${taskState.currentGoal.substring(0, HANDOFF_CONFIG.MAX_SUMMARY_LENGTH)}`);
      if (taskState.status) stateInfo.push(`Status: ${taskState.status}`);
      if (taskState.progress) stateInfo.push(`Progress: ${JSON.stringify(taskState.progress).substring(0, 200)}`);
      if (taskState.lastDecision) stateInfo.push(`Last decision: ${taskState.lastDecision.substring(0, 200)}`);
      
      if (stateInfo.length > 0) {
        parts.push('\nTask State:');
        parts.push(stateInfo.join('\n'));
      }
    }
  } catch (err) {
    // Non-fatal
  }
  
  // 3. For cross-provider transitions, add memory context
  if (!sameProvider) {
    try {
      const memoryBlock = await recallUnifiedMemory(
        context.userMessage || '', 
        sessionKey, 
        { userId: context.userId }
      );
      if (memoryBlock && memoryBlock.length > 0) {
        // Trim to fit budget
        const trimmed = memoryBlock.substring(0, HANDOFF_CONFIG.MAX_MEMORY_LENGTH);
        parts.push('\n' + trimmed);
      }
    } catch (err) {
      // Non-fatal
    }
  }
  
  // 4. Transition history (if multiple switches happened)
  const history = _transitionHistory.get(sessionKey) || [];
  if (history.length > 1) {
    const recentSwitches = history.slice(-3).map(h => 
      `${h.from} → ${h.to} (${h.category})`
    ).join(', ');
    parts.push(`\nRecent model switches: ${recentSwitches}`);
  }
  
  parts.push('[/MODEL_HANDOFF]');
  
  let packet = parts.join('\n');
  
  // Enforce total length limit
  if (packet.length > HANDOFF_CONFIG.MAX_TOTAL_LENGTH) {
    packet = packet.substring(0, HANDOFF_CONFIG.MAX_TOTAL_LENGTH - 20) + '\n[/MODEL_HANDOFF]';
  }
  
  logger.info(`[${ts()}] [handoff] Built packet: ${packet.length} chars for ${previousModel} → ${currentModel}`);
  
  return packet;
}

/**
 * Get the provider name from a model string.
 */
function getProvider(model) {
  if (!model) return 'unknown';
  if (model.includes('/')) return model.split('/')[0];
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3')) return 'openai';
  if (model.includes('gemini')) return 'google';
  return 'unknown';
}

/**
 * Get transition statistics for a session.
 */
export function getTransitionStats(sessionKey) {
  const history = _transitionHistory.get(sessionKey) || [];
  if (history.length === 0) return { transitions: 0 };
  
  const providerSwitches = history.filter((h, i) => 
    i > 0 && getProvider(h.from) !== getProvider(h.to)
  ).length;
  
  return {
    transitions: history.length,
    crossProvider: providerSwitches,
    lastTransition: history[history.length - 1],
    models: [...new Set(history.flatMap(h => [h.from, h.to]))],
  };
}

/**
 * Clear transition history for a session (on session end).
 */
export function clearTransitionHistory(sessionKey) {
  _transitionHistory.delete(sessionKey);
}

export { HANDOFF_CONFIG };
