// executor.mjs — Single-Step Executor (Agent Loop Architecture)
//
// Responsibilities:
//   1. Read current task state (from event stream)
//   2. Decide the NEXT SINGLE ACTION
//   3. Execute that action (via tool-orchestrator for safety)
//   4. Write observation back to event stream
//
// ONE action per loop iteration. No implicit chaining.
//
// Action types:
//   - tool_call: Execute a tool
//   - notify: Non-blocking progress update to user
//   - ask: Blocking question to user (pauses task)
//   - final_answer: Task completion output
//   - replan: Request plan revision
//
// The Executor does NOT own the plan. It receives the current step
// from the orchestration layer (openclaw-handler) and executes it.

import { emitEvent, emitEventSync, emitLedgerEvent, EVENT_TYPES, ACTION_TYPES, verifyReplayConsistency } from "./event-stream.mjs";
import { getCurrentStep, markStepDone, markStepBlocked, markStepFailed, replanOnFailure, getPlan } from "./planner.mjs";
import { diagnoseFailure, recordAttempt, getAttemptCount, executeRecovery, checkCircuitBreaker, recordCircuitFailure, recordCircuitSuccess } from "./failure-recovery.mjs"; // [Iter-66 v2]
import { logger } from "../lib/logger.mjs";

const ts = () => new Date().toISOString();

// R8 Task 1: Executor registry to prevent duplicate creation per msgId
const _executorRegistry = new Map(); // msgId => { taskId, sessionKey, createdAt }

/**
 * @typedef {Object} ExecutorAction
 * @property {"tool_call"|"notify"|"ask"|"final_answer"|"replan"} type
 * @property {string} [tool]               - Tool name (for tool_call)
 * @property {Object} [args]               - Tool arguments (for tool_call)
 * @property {string} [content]            - Message content (for notify/ask/final_answer)
 * @property {string} reason               - Why this action was chosen
 * @property {string} [expectedObservation] - What we expect to learn
 * @property {string} [stepId]             - Which plan step this action serves
 * @property {string} [actionId]           - Stable ledger action id for replay/dedup
 */

/**
 * @typedef {Object} ExecutorResult
 * @property {boolean} success
 * @property {string} type                 - Same as action type
 * @property {Object|string|null} result   - Tool result, user response, etc.
 * @property {string} [error]              - Error message if failed
 * @property {number} durationMs           - Execution time
 * @property {string} [toolId]             - Tool execution ID (for tracking)
 */


function normalizePlanTool(tool) {
  if (typeof tool !== 'string') return '';
  const t = tool.trim().toLowerCase();
  const aliases = {
    read_file: 'read', file_read: 'read', cat: 'read', head: 'read', tail: 'read',
    write_file: 'write', edit_file: 'write', file_write: 'write', edit: 'write',
    shell_exec: 'shell', exec: 'shell', bash: 'shell', systemctl: 'shell', docker: 'shell',
    grep: 'inspect', rg: 'inspect', curl: 'inspect', status: 'inspect', check: 'inspect',
    browser_navigate: 'browser', browser_click: 'browser', browser_snapshot: 'browser',
    web_fetch: 'web_search', search: 'web_search',
  };
  return aliases[t] || t;
}

function validateActionAgainstPlanStep(action, taskId, deps = {}) {
  const actionTool = action.tool || action.type || '';
  const rawStepId = action.stepId ? String(action.stepId).replace(/^step-/, '') : null;
  const plan = getPlan(taskId) || deps.plan || deps.initialPlan || null;
  const step = rawStepId
    ? (plan?.steps || []).find(s => String(s.id) === rawStepId) || deps.currentStep || deps.initialStep || null
    : getCurrentStep(taskId) || deps.currentStep || deps.initialStep || null;
  const expected = Array.isArray(step?.tools) ? step.tools : [];
  let status = 'no_step';
  if (step) {
    if (!action.tool || expected.length === 0 || expected.includes('auto')) {
      status = 'pass';
    } else {
      const actual = normalizePlanTool(actionTool);
      const normalizedExpected = expected.map(normalizePlanTool).filter(Boolean);
      status = normalizedExpected.some(t => t === actual || t.includes(actual) || actual.includes(t)) ? 'pass' : 'mismatch';
    }
  }
  logger.info(`[${ts()}] [executor-R70] action validated against plan step: status=${status} task=${taskId} step=${step?.id || rawStepId || '-'} action=${actionTool || '-'} expected=${expected.join(',') || '-'}`);
  return { status, stepId: step?.id || rawStepId || null, expectedTools: expected };
}

// [R71-P0-3] Extract verifiable evidence from action results.
// Returns null if no evidence can be derived.
const EVIDENCE_PATTERNS = [
  { type: 'node_check_pass', re: /\bnode --check[^\n]*\n(?:[^\n]*\bPASS\b|exit=0|\bSyntax OK\b)/i },
  { type: 'command_exit_0', re: /\b(?:exit code 0|Exit status: 0|command completed successfully|任务完成|PASS\b)/i },
  { type: 'http_200', re: /\b(?:HTTP\/1\.\d 200|HTTP 200|status.*200|200 OK|http_code.*200)\b/i },
  { type: 'grep_match', re: /\bPASS\b.*✅/i },
  { type: 'file_changed', re: /\b(?:Successfully (?:replaced|created|edited)|写入成功|commit [0-9a-f]{7})\b/i },
  { type: 'syntax_check_passed', re: /\b(?:Syntax OK|语法检查通过|node --check.*exit=0|\.mjs.*pass)\b/i },
];

function extractEvidenceFromResult(result, action = {}) {
  if (!result || !result.success) return null;
  const content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result || '');
  if (!content) return null;

  for (const pattern of EVIDENCE_PATTERNS) {
    if (pattern.re.test(content)) {
      return {
        evidenceType: pattern.type,
        detail: content.substring(0, 200),
        tool: action.tool || null,
      };
    }
  }

  // File write/read tools produce evidence via success flag
  if (result.success && (action.tool === 'write' || action.tool === 'write_file' || action.tool === 'edit')) {
    return { evidenceType: 'file_changed', detail: 'Tool succeeded: ' + (action.tool || 'write'), tool: action.tool };
  }

  return null;
}

/**
 * Create an Executor instance for a task.
 *
 * @param {string} taskId
 * @param {string} sessionKey
 * @param {string} msgId - Current message ID (for frontend events)
 * @param {Object} deps - { gateway, toolOrchestrator, sendEvent }
 * @returns {Object} Executor interface
 */
export function createExecutor(taskId, sessionKey, msgId, deps = {}) {
  const { gateway, toolOrchestrator, sendEvent: _sendEvent, userRole = 'member' } = deps;

  // R8 Task 1: Dedup guard — only one executor per msgId
  const existingEntry = _executorRegistry.get(msgId);
  if (existingEntry) {
    logger.warn(`[${ts()}] [R8-executor] DUPLICATE createExecutor blocked: msgId=${msgId} existingTask=${existingEntry.taskId} newTask=${taskId}`);
    // Return the existing executor instead of creating a new one
    if (existingEntry.executor) {
      return existingEntry.executor;
    }
    // If no executor reference stored (shouldn't happen), fall through to create
  }

  // R7 Task 2: Capture and validate bound sessionKey
  const _boundSessionKey = sessionKey;
  logger.info(`[${ts()}] [R8-executor] created: task=${taskId} msgId=${msgId} boundSession=${sessionKey.substring(0, 40)}`);
  logger.info(`[${ts()}] [R8-executor] registry size=${_executorRegistry.size + 1}`);

  let _actionCount = 0;
  let _lastAction = null;
  let _lastObservation = null;
  let _currentStepId = null;  // [R3-Task1] Tracks the active plan step for this executor

  const executor = {
    /**
     * Execute a single action.
     * This is the ONLY way to make progress in the agent loop.
     *
     * @param {ExecutorAction} action
     * @returns {Promise<ExecutorResult>}
     */
    async executeAction(action) {
      _actionCount++;
      _lastAction = action;
      const startTime = Date.now();

      // [R3-Task1] Auto-bind stepId from current plan step if not explicitly set
      if (!action.stepId || action.stepId === '-') {
        const currentStep = getCurrentStep(taskId);
        if (currentStep) {
          action.stepId = `step-${currentStep.id}`;
          _currentStepId = action.stepId;
        } else {
          action.stepId = _currentStepId || 'step-unbound';
        }
      } else {
        _currentStepId = action.stepId;
      }

      const _plan = getPlan(taskId) || null;
      const _rawStepId = action.stepId ? String(action.stepId).replace(/^step-/, '') : null;
      const _actionId = action.actionId || `${taskId}:${_rawStepId || 'step-unbound'}:${_actionCount}`;
      action.actionId = _actionId;
      action._msgId = action._msgId || msgId;
      action._sessionKey = action._sessionKey || sessionKey;
      action._taskId = action._taskId || taskId;
      const _planValidation = validateActionAgainstPlanStep(action, taskId, deps);

      const _actionPayload = {
        taskId,
        runId: taskId,
        planId: _plan?.planId || _plan?.id || taskId,
        stepId: _rawStepId,
        actionId: _actionId,
        type: action.type,
        tool: action.tool || null,
        args: action.args ? summarizeArgs(action.args) : null,
        reason: action.reason,
        expectedObservation: action.expectedObservation || null,
        planValidation: _planValidation,
        actionIndex: _actionCount,
      };

      // Emit ACTION event to event stream + Runtime Ledger event for replay/dedup
      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.ACTION_STARTED, _actionPayload, null, action.tool || null);
      emitEvent(sessionKey, taskId, EVENT_TYPES.ACTION, _actionPayload, null, action.tool || null);

      logger.info(`[${ts()}] [executor] Action #${_actionCount}: type=${action.type} tool=${action.tool || '-'} step=${action.stepId} reason="${(action.reason || '').substring(0, 80)}"`);

      let result;
      try {
        switch (action.type) {
          case ACTION_TYPES.TOOL_CALL:
            result = await executeToolCall(action, deps);
            break;

          case ACTION_TYPES.NOTIFY:
            result = executeNotify(action, deps);
            break;

          case ACTION_TYPES.ASK:
            result = await executeAsk(action, deps);
            break;

          case ACTION_TYPES.FINAL_ANSWER:
            result = executeFinalAnswer(action, deps);
            break;

          case ACTION_TYPES.REPLAN:
            result = { success: true, type: 'replan', result: action.reason, durationMs: 0 };
            break;

          default:
            result = { success: false, type: action.type, error: `Unknown action type: ${action.type}`, durationMs: 0 };
        }
      } catch (err) {
        result = {
          success: false,
          type: action.type,
          error: err.message,
          durationMs: Date.now() - startTime,
        };
      }

      result.durationMs = result.durationMs || (Date.now() - startTime);
      _lastObservation = result;

      const _observationPayload = {
        taskId,
        runId: taskId,
        planId: _plan?.planId || _plan?.id || taskId,
        stepId: _rawStepId,
        actionId: _actionId,
        type: result.type,
        tool: action.tool || null,
        success: result.success,
        content: typeof result.result === 'string'
          ? result.result.substring(0, 2000)
          : JSON.stringify(result.result || '').substring(0, 2000),
        error: result.error || null,
        durationMs: result.durationMs,
        actionIndex: _actionCount,
      };

      // Emit OBSERVATION event to event stream + Runtime Ledger events for replay/dedup
      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.ACTION_COMPLETED, _observationPayload, null, action.tool || null);
      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.OBSERVATION_RECORDED, _observationPayload, null, action.tool || null);
      await emitEventSync(sessionKey, taskId, EVENT_TYPES.OBSERVATION, _observationPayload, null, action.tool || null);

      // [R71-P0-3] Extract and record verifiable evidence from action result
      if (result.success && _rawStepId) {
        const _evidence = extractEvidenceFromResult(result, action);
        if (_evidence) {
          emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.STEP_EVIDENCE_RECORDED, {
            taskId, runId: taskId, planId: _plan?.planId || _plan?.id || taskId,
            stepId: _rawStepId, actionId: _actionId,
            evidenceType: _evidence.evidenceType,
            detail: _evidence.detail,
            tool: _evidence.tool,
          }, null, action.tool || null);
          logger.info(`[${ts()}] [executor-R71] step_evidence_recorded: step=${_rawStepId} type=${_evidence.evidenceType} tool=${_evidence.tool}`);
        }
      }

      logger.info(`[${ts()}] [executor] Observation #${_actionCount}: success=${result.success} type=${result.type} step=${action.stepId} duration=${result.durationMs}ms`);

      // [R3-Task2] Trigger replay verification on task completion (final_answer)
      if (action.type === ACTION_TYPES.FINAL_ANSWER && result.success) {
        await emitEventSync(sessionKey, taskId, EVENT_TYPES.TASK_COMPLETED, {
          taskId,
          runId: taskId,
          planId: _plan?.planId || _plan?.id || taskId,
          stepId: _rawStepId,
          actionId: _actionId,
          content: typeof result.result === 'string' ? result.result.substring(0, 2000) : JSON.stringify(result.result || '').substring(0, 2000),
        }, null, action.tool || null);
        verifyReplayConsistency(taskId, sessionKey).catch(err => {
          logger.warn(`[${ts()}] [executor] Replay verification failed: ${err.message}`);
        });
      }

      // [R3-Task3] Mark plan step done/failed based on observation result
      if (action.stepId && action.stepId !== 'step-unbound') {
        try {
          const rawStepId = action.stepId.replace(/^step-/, '');
          if (result.success) {
            const outputSummary = typeof result.result === 'string'
              ? result.result.substring(0, 200)
              : JSON.stringify(result.result || '').substring(0, 200);
            markStepDone(taskId, rawStepId, outputSummary);
            // [Iter-66 v2] Record circuit breaker success
            if (action.tool) recordCircuitSuccess(action.tool);
            // Emit plan_step_update event for event stream
            emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_STEP_UPDATE, {
              taskId,
              runId: taskId,
              planId: _plan?.planId || _plan?.id || taskId,
              stepId: rawStepId,
              status: 'done',
              output: outputSummary,
            });
            emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.STEP_COMPLETED, {
              taskId,
              runId: taskId,
              planId: _plan?.planId || _plan?.id || taskId,
              stepId: rawStepId,
              actionId: _actionId,
              status: 'done',
              output: outputSummary,
            }, null, action.tool || null);
            logger.info(`[${ts()}] [executor] Step ${action.stepId} marked done via planner`);
          } else if (result.error) {
            // [R5-Task2] Mark step as failed (not blocked) for tool errors
            const _errMsg = result.error.substring(0, 200);
            markStepFailed(taskId, rawStepId, _errMsg);
            // [Iter-66 v2] Diagnose failure type and determine recovery strategy
            const _attemptCount = recordAttempt(taskId, rawStepId);
            const _diagnosis = diagnoseFailure(_errMsg, action.tool || '', { attempts: _attemptCount - 1 });
            logger.info(`[${ts()}] [Iter-66] Executor failure diagnosed: type=${_diagnosis.failureType} recovery=${_diagnosis.recovery.action} attempt=${_attemptCount}`);
            // [Iter-66 v2] Circuit breaker check
            if (action.tool) {
              recordCircuitFailure(action.tool);
              const _cb = checkCircuitBreaker(action.tool);
              if (!_cb.allowed) {
                logger.info(`[${ts()}] [Iter-66-CB] Circuit OPEN for tool=${action.tool}, forcing skip_step`);
                _diagnosis.recovery.action = 'skip_step';
              }
            }
            emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_STEP_UPDATE, {
              taskId,
              runId: taskId,
              planId: _plan?.planId || _plan?.id || taskId,
              stepId: rawStepId,
              status: 'failed',
              blockReason: _errMsg,
            });
            await emitEventSync(sessionKey, taskId, EVENT_TYPES.TASK_FAILED, {
              taskId,
              runId: taskId,
              planId: _plan?.planId || _plan?.id || taskId,
              stepId: rawStepId,
              actionId: _actionId,
              failureType: _diagnosis.failureType,
              recoveryAction: _diagnosis.recovery.action,
              recoverySeverity: _diagnosis.recovery.severity,
              attemptCount: _attemptCount,
              error: _errMsg,
            }, null, action.tool || null);
            logger.info(`[${ts()}] [executor] Step ${action.stepId} marked failed: ${result.error.substring(0, 100)}`);
            // [Iter-66 v2] Execute the recovery strategy (not just replan)
            try {
              const _recoveryResult = await executeRecovery(_diagnosis, {
                taskId, stepId: rawStepId, sendEvent: deps.sendEvent, msgId,
              });
              if (_recoveryResult.shouldRetry) {
                logger.info(`[${ts()}] [Iter-66-EXEC] Recovery: retry step ${rawStepId} (attempt ${_attemptCount + 1})`);
                // Caller (openclaw-handler) will re-enter the loop
              } else if (_recoveryResult.shouldSkip) {
                logger.info(`[${ts()}] [Iter-66-EXEC] Recovery: skip step ${rawStepId}`);
                markStepDone(taskId, rawStepId, `[SKIPPED] ${_errMsg}`);
              } else if (_recoveryResult.shouldReplan) {
                const _newPlan = await replanOnFailure(taskId, sessionKey, rawStepId, action.tool || 'unknown', _errMsg);
                if (_newPlan) {
                  logger.info(`[${ts()}] [executor] Plan v${_newPlan.version} generated after failure, continuing execution`);
                  const _nextStep = getCurrentStep(taskId);
                  if (_nextStep && _nextStep.status === 'pending') {
                    logger.info(`[${ts()}] [executor] Action: tool_call for replanned step ${_nextStep.id} "${_nextStep.title.substring(0, 80)}"`);
                  }
                }
              } else if (_recoveryResult.needsHuman) {
                logger.info(`[${ts()}] [Iter-66-EXEC] Recovery: waiting for human intervention on step ${rawStepId}`);
              } else if (_recoveryResult.abort) {
                logger.info(`[${ts()}] [Iter-66-EXEC] Recovery: aborting task ${taskId}`);
              }
            } catch (_recErr) {
              logger.error(`[${ts()}] [Iter-66-EXEC] Recovery execution error: ${_recErr.message}`);
              // Fallback: try replan
              try {
                const _newPlan = await replanOnFailure(taskId, sessionKey, rawStepId, action.tool || 'unknown', _errMsg);
                if (_newPlan) {
                  logger.info(`[${ts()}] [executor] Fallback replan v${_newPlan.version} after recovery error`);
                }
              } catch (_rpErr) {
                logger.error(`[${ts()}] [executor] Fallback replan also failed: ${_rpErr.message}`);
              }
            }
          }
        } catch (stepErr) {
          logger.warn(`[${ts()}] [executor] Failed to update step status: ${stepErr.message}`);
        }
      }

      return result;
    },

    /**
     * Get execution stats for this task.
     */
    getStats() {
      return {
        actionCount: _actionCount,
        lastAction: _lastAction,
        lastObservation: _lastObservation,
      };
    },

    /**
     * Check if the executor should yield (e.g., after ask action).
     */
    shouldYield() {
      return _lastAction?.type === ACTION_TYPES.ASK;
    },

    /**
     * Check if the task is complete (final_answer was given).
     */
    isComplete() {
      return _lastAction?.type === ACTION_TYPES.FINAL_ANSWER;
    },
  };

  // R8 Task 1: Register in dedup registry
  _executorRegistry.set(msgId, { taskId, sessionKey, createdAt: Date.now(), executor });

  return executor;
}

// R8 Task 1: Cleanup executor registry entry (called from scheduleTaskCleanup)
export function cleanupExecutorRegistry(msgId) {
  const deleted = _executorRegistry.delete(msgId);
  if (deleted) {
    logger.info(`[${ts()}] [R8-executor] registry cleaned: msgId=${msgId} remaining=${_executorRegistry.size}`);
  }
}

// ─── Action Executors ──────────────────────────────────────

/**
 * Execute a tool call through the tool orchestrator.
 */
async function executeToolCall(action, deps) {
  const { gateway, toolOrchestrator, sendEvent: _sendEvent } = deps;
  const { tool, args } = action;
  const toolId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Step 1: Acquire execution permission from orchestrator
  if (toolOrchestrator) {
    const permission = await toolOrchestrator.acquireExecution(toolId, tool, args);
    if (permission.blocked) {
      logger.info(`[${ts()}] [executor] Tool ${tool} BLOCKED: ${permission.blockReason}`);
      if (toolOrchestrator.releaseExecution) toolOrchestrator.releaseExecution(toolId);
      return {
        success: false,
        type: 'tool_call',
        toolId,
        error: permission.blockReason,
        result: `Tool ${tool} was blocked: ${permission.blockReason}`,
      };
    }
  }

  // Step 2: Execute the tool via Gateway
  try {
    // Emit tool_call event for frontend
    if (_sendEvent) {
      _sendEvent(action._msgId || 'unknown', {
        type: 'tool_call',
        id: toolId,
        tool,
        args: typeof args === 'object' ? JSON.stringify(args) : args,
      });
    }

    // The actual tool execution happens through the Gateway's tool system.
    // The executor doesn't directly call tools — it sends the action to the
    // Gateway which handles tool execution and returns results.
    //
    // This is a placeholder for the Gateway integration.
    // In the real flow, openclaw-handler will:
    //   1. Send the action as part of the chat message
    //   2. Gateway's agent will execute the tool
    //   3. Result comes back via stream events
    //
    // For now, we return a marker that the orchestration layer should handle.
    return {
      success: true,
      type: 'tool_call',
      toolId,
      result: { pending: true, tool, args },
    };

  } catch (err) {
    logger.error(`[${ts()}] [executor] Tool ${tool} execution error: ${err.message}`);
    return {
      success: false,
      type: 'tool_call',
      toolId,
      error: err.message,
    };
  } finally {
    if (toolOrchestrator?.releaseExecution) {
      toolOrchestrator.releaseExecution(toolId);
    }
  }
}

/**
 * Execute a notify action (non-blocking progress update).
 */
function executeNotify(action, deps) {
  const { sendEvent: _sendEvent } = deps;

  if (_sendEvent) {
    _sendEvent(action._msgId || 'unknown', {
      type: 'thinking',
      content: action.content || '',
    });
  }

  // Emit NOTIFY event
  emitEvent(
    action._sessionKey || 'unknown',
    action._taskId || null,
    EVENT_TYPES.NOTIFY,
    { content: action.content }
  );

  return {
    success: true,
    type: 'notify',
    result: 'Notification sent',
  };
}

/**
 * Execute an ask action (blocking — pauses task until user responds).
 */
async function executeAsk(action, deps) {
  const { sendEvent: _sendEvent } = deps;

  if (_sendEvent) {
    _sendEvent(action._msgId || 'unknown', {
      type: 'ask_user',
      content: action.content || '',
      question: action.content || '',
    });
  }

  // Emit ASK + WAITING_USER events
  await emitEventSync(
    action._sessionKey || 'unknown',
    action._taskId || null,
    EVENT_TYPES.ASK,
    { question: action.content, reason: action.reason }
  );
  emitEvent(
    action._sessionKey || 'unknown',
    action._taskId || null,
    EVENT_TYPES.WAITING_USER,
    { question: action.content }
  );

  return {
    success: true,
    type: 'ask',
    result: 'Waiting for user response',
  };
}

/**
 * Execute a final_answer action (task completion).
 */
function executeFinalAnswer(action, deps) {
  const { sendEvent: _sendEvent } = deps;

  if (_sendEvent) {
    _sendEvent(action._msgId || 'unknown', {
      type: 'message_done',
      content: action.content || '',
    });
  }

  // Emit FINAL_ANSWER event
  emitEvent(
    action._sessionKey || 'unknown',
    action._taskId || null,
    EVENT_TYPES.FINAL_ANSWER,
    { content: action.content, reason: action.reason }
  );

  return {
    success: true,
    type: 'final_answer',
    result: action.content,
  };
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Summarize tool args for event logging (avoid storing huge payloads).
 */
function summarizeArgs(args) {
  if (!args) return null;
  const str = typeof args === 'string' ? args : JSON.stringify(args);
  return str.length > 500 ? str.substring(0, 500) + '...(truncated)' : str;
}

// ─── Action Builders (convenience factories) ───────────────

/**
 * Build a tool_call action.
 */
export function buildToolCallAction(tool, args, reason, stepId = null) {
  return {
    type: ACTION_TYPES.TOOL_CALL,
    tool,
    args,
    reason,
    stepId,
    expectedObservation: `Result from ${tool}`,
  };
}

/**
 * Build a notify action.
 */
export function buildNotifyAction(content, reason = 'progress update') {
  return {
    type: ACTION_TYPES.NOTIFY,
    content,
    reason,
  };
}

/**
 * Build an ask action.
 */
export function buildAskAction(question, reason = 'need user input') {
  return {
    type: ACTION_TYPES.ASK,
    content: question,
    reason,
  };
}

/**
 * Build a final_answer action.
 */
export function buildFinalAnswerAction(content, reason = 'task complete') {
  return {
    type: ACTION_TYPES.FINAL_ANSWER,
    content,
    reason,
  };
}

/**
 * Build a replan action.
 */
export function buildReplanAction(reason) {
  return {
    type: ACTION_TYPES.REPLAN,
    reason,
  };
}

// ─── R70 P0-1: Tool failure handling extracted from openclaw-handler ───

/**
 * Handle a tool failure with strategy-aware recovery.
 * Extracted from openclaw-handler.mjs (R70 P0-1 Executor主轴化第一步).
 *
 * @param {Object} ctx
 * @param {string} ctx.taskId
 * @param {string} ctx.sessionKey
 * @param {string} ctx.msgId          - Current message ID (for frontend events)
 * @param {string} ctx.planId         - Plan identifier for event ledger
 * @param {string} ctx.runId          - Run identifier for event ledger
 * @param {Object} ctx.step           - Current plan step object
 * @param {string} ctx.toolName       - Name of the failed tool
 * @param {string} ctx.error          - Error message (max 300 chars)
 * @param {string} [ctx.actionId]     - Tool-end action ID for ledger
 * @returns {Promise<{action: string, directive: string, failureType: string, recoveryAction: string, plan?: Object, attempt?: number, aborted?: boolean}>}
 */
export async function handleToolFailure(ctx = {}) {
  const { taskId, sessionKey, msgId, planId, runId, step, toolName, error, actionId } = ctx;
  const failError = String(error || 'unknown error').substring(0, 300);
  const stepId = step?.id || 'unknown';
  const stepTitle = step?.title || 'unknown step';

  // Step 1: Classify failure
  const diagnosis = diagnoseFailure(failError, toolName, { attempts: step?.retryCount || 0 });
  logger.info(`[${ts()}] [executor-R70] tool_call failed: step=${stepId} tool=${toolName} failureType=${diagnosis.failureType} recovery=${diagnosis.recovery.action}`);

  // Step 2: Emit PLAN_STEP_UPDATE with 'failed' status
  emitEvent(sessionKey, taskId, EVENT_TYPES.PLAN_STEP_UPDATE, {
    taskId,
    runId,
    planId: planId || taskId,
    stepId,
    status: 'failed',
    blockReason: `${toolName} failed: ${failError.substring(0, 200)}`,
  });

  // Step 3: Resolve strategy via planner
  const plannerModule = await import('./planner.mjs');
  const resolved = await plannerModule.handleStepFailure(taskId, sessionKey, stepId, toolName, failError);

  // Step 4: Build directive for LLM context injection (done by caller in openclaw-handler)
  // and emit terminal event for abort
  logger.info(`[${ts()}] [executor-R70] step=${stepId} resolved: action=${resolved.action}`);

  let directive = '';
  let aborted = false;

  if (resolved.action === 'replan' && resolved.plan) {
    const plan = plannerModule.getPlan(taskId);
    const nextStep = plan?.steps?.find(s => s.status === 'doing' || s.status === 'pending');
    directive = nextStep
      ? `[REPLAN] Step ${stepId} ("${stepTitle}") failed (${toolName}: ${failError.substring(0, 120)}). Plan updated to v${resolved.plan.plan_version} (${resolved.plan.steps.length} steps). Proceed with step ${nextStep.id}: "${nextStep.title}". Tools: ${(nextStep.tools || []).join(', ') || 'auto'}.`
      : `[REPLAN] Step ${stepId} failed. Plan updated to v${resolved.plan.plan_version}. Summarize situation and respond to user.`;
  } else if (resolved.action === 'retry') {
    const tools = (step.tools || []).join(', ') || 'auto';
    directive = `[RETRY_STEP] Step ${stepId} ("${stepTitle}") failed due to ${toolName} error: ${failError.substring(0, 120)}. This is retry attempt ${resolved.attempt}/${step.retryCount || 2}. Please retry the step using: ${tools}. Try an alternative approach if the same approach failed.`;
  } else if (resolved.action === 'skip') {
    const plan = plannerModule.getPlan(taskId);
    const nextStep = plan?.steps?.find(s => s.status === 'doing' || s.status === 'pending');
    directive = nextStep
      ? `[SKIP_STEP] Step ${stepId} ("${stepTitle}") was skipped (non-critical failure). Proceed to step ${nextStep.id}: "${nextStep.title}". Tools: ${(nextStep.tools || []).join(', ') || 'auto'}.`
      : `[SKIP_STEP] Step ${stepId} skipped. All remaining steps complete. Summarize results.`;
  } else if (resolved.action === 'abort') {
    directive = `[ABORT] Step ${stepId} ("${stepTitle}") caused an abort (${toolName}: ${failError.substring(0, 120)}). Stop execution and report the failure to the user clearly.`;
    aborted = true;
    // Emit terminal TASK_FAILED sync (must complete before caller continues)
    try {
      await emitEventSync(sessionKey, taskId, EVENT_TYPES.TASK_FAILED, {
        taskId,
        runId,
        planId: planId || taskId,
        stepId,
        actionId: actionId || null,
        tool: toolName,
        failureType: diagnosis.failureType,
        recoveryAction: 'abort',
        error: failError,
      }, null, toolName);
    } catch (syncErr) {
      logger.warn(`[${ts()}] [executor-R70] task_failed sync failed, falling back to buffer: ${syncErr.message}`);
      emitLedgerEvent(sessionKey, taskId, EVENT_TYPES.TASK_FAILED, {
        taskId, runId, planId: planId || taskId, stepId,
        tool: toolName, failureType: diagnosis.failureType,
        recoveryAction: 'abort', error: failError,
      }, null, toolName);
    }
  }

  return {
    action: resolved.action,
    directive,
    failureType: diagnosis.failureType,
    recoveryAction: diagnosis.recovery.action,
    plan: resolved.plan || null,
    attempt: resolved.attempt || null,
    aborted,
  };
}

