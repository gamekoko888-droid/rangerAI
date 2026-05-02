// modules/tool-execution-stream.mjs — Fine-grained streaming events for tool execution
// Q11: Emits granular events during tool execution for real-time frontend display
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

/**
 * Event types for tool execution streaming.
 */
export const TOOL_STREAM_EVENTS = {
  TOOL_START: 'tool:start',
  TOOL_PROGRESS: 'tool:progress',
  TOOL_RESULT: 'tool:result',
  TOOL_ERROR: 'tool:error',
  TOOL_RETRY: 'tool:retry',
  BATCH_START: 'batch:start',
  BATCH_COMPLETE: 'batch:complete',
};

/**
 * Create a tool execution stream emitter.
 * Wraps a gateway/websocket emit function with structured tool events.
 * @param {Function} emit - The underlying event emit function (e.g., gateway.emit)
 * @param {string} sessionKey - Session identifier for routing
 * @returns {Object} Stream emitter with typed methods
 */
export function createToolStreamEmitter(emit, sessionKey) {
  if (!emit || typeof emit !== 'function') {
    // Return no-op emitter if no emit function provided
    return {
      toolStart: () => {},
      toolProgress: () => {},
      toolResult: () => {},
      toolError: () => {},
      toolRetry: () => {},
      batchStart: () => {},
      batchComplete: () => {},
    };
  }

  function send(type, payload) {
    try {
      emit({
        type,
        sessionKey,
        timestamp: Date.now(),
        ...payload
      });
    } catch (e) {
      logger.error(`[${ts()}] [tool-stream] Failed to emit ${type}: ${e.message}`);
    }
  }

  return {
    /**
     * Emit when a tool starts executing.
     */
    toolStart({ toolName, toolId, args, stepId }) {
      send(TOOL_STREAM_EVENTS.TOOL_START, {
        toolName,
        toolId,
        args: sanitizeArgs(args),
        stepId,
      });
    },

    /**
     * Emit progress updates during long-running tools.
     */
    toolProgress({ toolId, progress, message }) {
      send(TOOL_STREAM_EVENTS.TOOL_PROGRESS, {
        toolId,
        progress, // 0-100
        message,
      });
    },

    /**
     * Emit when a tool completes successfully.
     */
    toolResult({ toolId, toolName, result, durationMs }) {
      send(TOOL_STREAM_EVENTS.TOOL_RESULT, {
        toolId,
        toolName,
        result: truncateResult(result),
        durationMs,
        success: true,
      });
    },

    /**
     * Emit when a tool fails.
     */
    toolError({ toolId, toolName, error, durationMs, willRetry }) {
      send(TOOL_STREAM_EVENTS.TOOL_ERROR, {
        toolId,
        toolName,
        error: String(error).slice(0, 500),
        durationMs,
        willRetry: Boolean(willRetry),
      });
    },

    /**
     * Emit when a tool is being retried.
     */
    toolRetry({ toolId, toolName, attempt, maxAttempts, reason }) {
      send(TOOL_STREAM_EVENTS.TOOL_RETRY, {
        toolId,
        toolName,
        attempt,
        maxAttempts,
        reason,
      });
    },

    /**
     * Emit when a parallel batch starts.
     */
    batchStart({ batchId, taskCount, tools }) {
      send(TOOL_STREAM_EVENTS.BATCH_START, {
        batchId,
        taskCount,
        tools,
      });
    },

    /**
     * Emit when a parallel batch completes.
     */
    batchComplete({ batchId, results, durationMs }) {
      send(TOOL_STREAM_EVENTS.BATCH_COMPLETE, {
        batchId,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        total: results.length,
        durationMs,
      });
    },
  };
}

/**
 * Sanitize tool args for streaming (remove large payloads, secrets).
 */
function sanitizeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.toLowerCase().includes('secret') || key.toLowerCase().includes('password') || key.toLowerCase().includes('token')) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 200) {
      sanitized[key] = value.slice(0, 200) + '...[truncated]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Truncate tool results for streaming (keep under 1KB).
 */
function truncateResult(result) {
  if (!result) return null;
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (str.length <= 1024) return result;
  return typeof result === 'string' 
    ? str.slice(0, 1024) + '...[truncated]'
    : JSON.parse(str.slice(0, 1024) + '"}');
}
