/**
 * R23-T5: Dual Model Architecture Stub
 * 
 * Configuration switch for future multi-model routing.
 * When enabled=false (default), all requests transparently pass through
 * to the current single-model path. No behavioral change.
 * 
 * Future: When enabled=true, routes requests to different models
 * based on task complexity, cost, and latency requirements.
 */

import { logger } from "../lib/logger.mjs";

const ts = () => new Date().toISOString();

// Default config: disabled, transparent passthrough
const _config = {
  enabled: false,
  primaryModel: 'default',     // Current model
  secondaryModel: null,        // Future: fast/cheap model for simple tasks
  routingStrategy: 'none',     // none | complexity | cost | hybrid
  complexityThreshold: 0.7,    // Above this → primary model
  costBudgetPerTask: null,     // Future: per-task cost cap
};

/**
 * Initialize dual model config from environment or DB
 */
export function initDualModel(overrides = {}) {
  Object.assign(_config, overrides);
  logger.info(`[${ts()}] [R23-T5] Dual model stub initialized: enabled=${_config.enabled}, strategy=${_config.routingStrategy}`);
  return _config;
}

/**
 * Route a request to the appropriate model
 * When disabled: always returns primaryModel (transparent passthrough)
 * @param {Object} params
 * @param {string} params.taskType - Type of task
 * @param {number} params.complexity - Estimated complexity 0-1
 * @param {number} params.tokenEstimate - Estimated tokens needed
 * @returns {Object} { model, reason }
 */
export function routeToModel({ taskType = 'general', complexity = 0.5, tokenEstimate = 0 } = {}) {
  if (!_config.enabled) {
    return {
      model: _config.primaryModel,
      reason: 'dual_model_disabled',
      routed: false,
    };
  }
  
  // Future: implement actual routing logic
  // For now, always return primary even when enabled
  return {
    model: _config.primaryModel,
    reason: `stub_passthrough (strategy=${_config.routingStrategy})`,
    routed: false,
  };
}

/**
 * Get current dual model configuration (for admin API)
 */
export function getDualModelConfig() {
  return { ..._config };
}

/**
 * Update dual model configuration (for admin API)
 */
export function updateDualModelConfig(updates) {
  const allowed = ['enabled', 'primaryModel', 'secondaryModel', 'routingStrategy', 'complexityThreshold', 'costBudgetPerTask'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      _config[key] = updates[key];
    }
  }
  logger.info(`[${ts()}] [R23-T5] Dual model config updated: enabled=${_config.enabled}, strategy=${_config.routingStrategy}`);
  return { ..._config };
}
