// message-router.mjs — Routing decision logic (extracted from user-message-handler.mjs Iter-I)
// Responsibilities: Smart Router + Intent Classifier + R60 Override + Routing Events
// Iter-M (v25.18): Uses classifyUnifiedIntent from intent-pipeline.mjs (replaces dual classifier calls)
// Iter-66b: Fix user_override being overridden by legacy getRoutingDecision fallbackModel

import { classifyUnifiedIntent } from "./intent-pipeline.mjs"; // Iter-M: unified intent pipeline
import { classifyIntent, getRoutingOverride } from "./intent-classifier.mjs"; // kept as fallback reference
import { getRoutingDecision, logRoutingDecision } from "../llm-gateway.mjs";
import { sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { emitEvent, EVENT_TYPES } from "./event-stream.mjs";
import { MODEL_MAP, THINKING_MAP } from "./smart-router.mjs";
import { logger } from "../lib/logger.mjs";

const ts = () => new Date().toISOString();

/**
 * Resolve routing decision based on LLM pre-classifier or legacy R60 + keyword routing.
 * 
 * @param {string} userMessage
 * @param {string} msgId
 * @param {string} sessionKey
 * @param {string} taskId
 * @param {object} deps - { routeResult }
 * @returns {{ routing, intentResult, intentOverride }}
 */
export async function resolveRouting(userMessage, msgId, sessionKey, taskId, deps = {}) {
  let intentResult = null;
  let intentOverride = null;
  let routing;

  if (deps.routeResult && deps.routeResult.category !== 'user_override') {
    // LLM pre-classifier result available - use it directly
    const rr = deps.routeResult;
    routing = getRoutingDecision(userMessage); // Still call for healthScore/gatewayStatus
    // Override with LLM pre-classifier results
    routing.taskType = rr.category;
    routing.fallbackModel = rr.model;
    routing.thinking = rr.thinking || 'high';
    routing.confidence = rr.confidence || 0.9;
    routing.description = 'LLM pre-classifier: ' + rr.reason;
    logger.info('[' + ts() + '] [router] [v4.0] Using LLM pre-classifier: type=' + rr.category + ' model=' + rr.model + ' thinking=' + rr.thinking + ' conf=' + rr.confidence);
    emitEvent(sessionKey, taskId, EVENT_TYPES.MODEL_ROUTE, {
      role: 'executor', // [R43-T1] Mark as executor model route
      category: rr.category, model: rr.model, thinking: rr.thinking,
      confidence: rr.confidence, reason: rr.reason,
    }, rr.model);
  } else if (deps.routeResult && deps.routeResult.category === 'user_override') {
    // [Iter-66b FIX] User explicitly selected a model via UI or message text
    // smartRoute already resolved the correct model — DO NOT let legacy getRoutingDecision override it
    const rr = deps.routeResult;
    routing = getRoutingDecision(userMessage); // Still call for healthScore/gatewayStatus/useGateway
    // Override fallbackModel with the user's explicit choice
    routing.taskType = 'user_override';
    routing.fallbackModel = rr.model;
    routing.thinking = rr.thinking || 'high';
    routing.confidence = 1.0;
    routing.description = `User override: ${rr.reason}`;
    logger.info(`[${ts()}] [router] [Iter-66b] User override respected: model=${rr.model} reason=${rr.reason}`);
    emitEvent(sessionKey, taskId, EVENT_TYPES.MODEL_ROUTE, {
      role: 'executor',
      category: 'user_override', model: rr.model, thinking: rr.thinking,
      confidence: 1.0, reason: rr.reason,
    }, rr.model);
  } else {
    // No LLM result (LLM failed) - use legacy R60 + keyword routing
    try {
      intentResult = await classifyUnifiedIntent(userMessage);
      intentOverride = intentResult.routingOverride || getRoutingOverride(intentResult);
      if (intentOverride) {
        logger.info('[' + ts() + '] [router] [R60/Iter-M] Intent: ' + intentResult.intent + ' src=' + intentResult.source + ' conf=' + intentResult.confidence + ' override=' + (intentOverride?.overrideType || 'none'));
      }
    } catch (intentErr) {
      logger.warn('[' + ts() + '] [router] [R60] Intent classification failed (silent): ' + intentErr.message);
    }
    routing = getRoutingDecision(userMessage);
    if (intentOverride?.overrideType) {
      const originalType = routing.taskType;
      routing.taskType = intentOverride.overrideType;
      routing.description = `Intent override: ${intentOverride.reason} (was: ${originalType})`;
      routing.confidence = intentResult?.confidence || 0.7;
      if (MODEL_MAP[routing.taskType]) {
        routing.fallbackModel = MODEL_MAP[routing.taskType];
        routing.thinking = THINKING_MAP[routing.taskType] || 'high';
        logger.info(`[${ts()}] [router] [v23.2-FIX] Synced model to ${routing.fallbackModel} and thinking to ${routing.thinking} after override ${originalType} → ${routing.taskType}`);
      }
      if (originalType === 'image_generation' && routing.taskType !== 'image_generation') {
        routing.useGateway = true;
        routing.gatewayStatus = routing.healthScore >= 0.3 ? 'healthy' : routing.gatewayStatus;
        logger.info(`[${ts()}] [router] [v22.5-FIX] Restored useGateway=true after image_generation override → ${routing.taskType}`);
      }
      logger.info(`[${ts()}] [router] [R60] Routing overridden: ${originalType} → ${routing.taskType}`);
    }
  }

  logRoutingDecision(msgId, userMessage, routing);

  sendEvent(msgId, {
    type: "routing_info",
    taskType: routing.taskType,
    thinking: routing.thinking,
    confidence: routing.confidence,
    fallbackModel: routing.fallbackModel,
    description: routing.description,
    healthScore: routing.healthScore,
    gatewayStatus: routing.gatewayStatus,
    useGateway: routing.useGateway
  });

  return { routing, intentResult, intentOverride };
}

