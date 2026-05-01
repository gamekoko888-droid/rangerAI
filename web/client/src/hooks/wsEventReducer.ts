/**
 * wsEventReducer — Pure function reducer for WebSocket events
 *
 * Extracted from useChatStore.tsx handleWsEvent.
 * Input: (stateSnapshot, event) → Output: { mutations: StateMutation[] }
 *
 * This is a PURE function — no side effects, no localStorage, no DOM, no timers.
 * All state mutations are returned as a list of descriptions that the caller applies.
 * Side effects (watchdog, localStorage, CustomEvent, browser dedup) stay in useChatStore.
 */

import type { ToolCall } from '../lib/types';
import { normalizeContent } from '../lib/types';

// ─── State Snapshot (what the reducer can read) ────────────
export interface StateSnapshot {
  isStreaming: boolean;
  streamingContent: string;
  thinkingContent: string;
  activeTools: ToolCall[];
  messages: { id: number; role: string; content: string }[];
  _lastStreamEndAt: number;
  planProgress: { planId: string; goal: string; currentStep: number; totalSteps: number; steps: { id: string; title: string; status: string }[]; status: string } | null;
  taskPhase: string;
}

// ─── State Mutation (output of reducer) ────────────────────
export type StateMutation =
  | { type: 'setStreaming'; isStreaming: boolean; preserveContent?: boolean }
  | { type: 'clearStreaming' }
  | { type: 'addToolCall'; tool: ToolCall }
  | { type: 'updateToolCall'; id: string; updates: Partial<ToolCall> }
  | { type: 'streamEnd'; content: string; model?: string; responseMode?: string }
  | { type: 'setError'; error: string | null }
  | { type: 'setSuggestions'; suggestions: string[] }
  | { type: 'setPlanProgress'; progress: { planId: string; goal: string; currentStep: number; totalSteps: number; steps: { id: string; title: string; status: string }[]; status: string } | null }
  | { type: 'snapshotTextToTimeline' }
  | { type: 'appendTimelineItem'; item: { type: string; toolId?: string; timestamp: number } }
  | { type: 'appendThinking'; content: string }
  | { type: 'setLongRunningNotice'; notice: { elapsed: number; toolCount: number } | null }
  | { type: 'setTaskPhase'; phase: string }
  | { type: 'none' };

// ─── Reducer Input ─────────────────────────────────────────
export interface ReducerInput {
  snapshot: StateSnapshot;
  event: { type: string; [key: string]: unknown };
  /** Pre-extracted fields merged with the event (for upstream processing like browser dedup) */
  preprocessed?: Record<string, unknown>;
}

// ─── Helper to create empty snapshot ───────────────────────
export function emptySnapshot(): StateSnapshot {
  return {
    isStreaming: false,
    streamingContent: '',
    thinkingContent: '',
    activeTools: [],
    messages: [],
    _lastStreamEndAt: 0,
    planProgress: null,
    taskPhase: 'idle',
  };
}

// ─── Constants ─────────────────────────────────────────────
const STREAM_START_COOLDOWN_MS = 2000;

// ─── Core Reducer ──────────────────────────────────────────
export function wsEventReducer(input: ReducerInput): StateMutation[] {
  const { snapshot: s, event: e, preprocessed } = input;

  // Merge preprocessed fields (upstream may have done browser dedup etc.)
  if (preprocessed) {
    for (const key of Object.keys(preprocessed)) {
      e[key] = preprocessed[key];
    }
  }

  switch (e.type) {
    // ── stream_start ──
    case 'stream_start': {
      const timeSinceLastEnd = Date.now() - (s._lastStreamEndAt || 0);
      if (timeSinceLastEnd < STREAM_START_COOLDOWN_MS && !s.isStreaming) {
        // Duplicate stream_start (late_result)
        return [{ type: 'none' }];
      }
      if (s.streamingContent) {
        // Existing content present — skip reset to preserve content
        return [{ type: 'none' }];
      }
      return [{ type: 'setStreaming', isStreaming: true }];
    }

    // ── stream_chunk ──
    case 'stream_chunk':
      // Content went to stream buffer — no store mutation needed from reducer
      // (buffer flush is handled by caller via useStreamBuffer)
      return [{ type: 'none' }];

    // ── thinking ──
    case 'thinking': {
      const content = (e as { content?: unknown }).content;
      if (content) {
        return [{ type: 'appendThinking', content: normalizeContent(content) }];
      }
      return [{ type: 'none' }];
    }

    // ── tool_start ──
    case 'tool_start': {
      const toolEvent = e as { id?: string; tool?: string; args?: unknown; toolIndex?: number; skill?: string; skillLabel?: string; skillCategory?: string; title?: string; description?: string };
      if (!toolEvent.tool) return [{ type: 'none' }];

      const argsStr = typeof toolEvent.args === 'string' ? toolEvent.args : (toolEvent.args ? JSON.stringify(toolEvent.args) : '');
      const toolId = toolEvent.id || `tool-${Date.now()}`;

      const tool: ToolCall = {
        id: toolId,
        tool: toolEvent.tool,
        args: argsStr,
        status: 'running',
        toolIndex: toolEvent.toolIndex,
        startedAt: Date.now(),
        ...(toolEvent.title ? { title: toolEvent.title } : {}),
        ...(toolEvent.description ? { description: toolEvent.description } : {}),
        ...(toolEvent.skill ? { skill: toolEvent.skill, skillLabel: toolEvent.skillLabel, skillCategory: toolEvent.skillCategory } : {}),
      };

      const mutations: StateMutation[] = [];

      // If not streaming, start streaming (preserve content for replay)
      if (!s.isStreaming) {
        mutations.push({ type: 'setStreaming', isStreaming: true, preserveContent: true });
      }

      mutations.push({ type: 'snapshotTextToTimeline' });
      mutations.push({ type: 'addToolCall', tool });
      mutations.push({ type: 'appendTimelineItem', item: { type: 'tool', toolId, timestamp: Date.now() } });

      return mutations;
    }

    // ── tool_progress ──
    case 'tool_progress': {
      const progEvent = e as { id?: string; tool?: string; data?: { partialResult?: string } };
      if (!progEvent.id) return [{ type: 'none' }];

      const progressText = progEvent.data?.partialResult || '';
      const existingTool = s.activeTools.find(t => t.id === progEvent.id);
      const isExec = existingTool?.tool === 'exec' || progEvent.tool === 'exec';

      if (isExec && progressText) {
        const prevHistory = existingTool?.progressHistory || [];
        return [{
          type: 'updateToolCall',
          id: progEvent.id,
          updates: {
            progress: progressText,
            progressHistory: [...prevHistory, progressText],
          },
        }];
      }
      return [{ type: 'updateToolCall', id: progEvent.id, updates: { progress: progressText } }];
    }

    // ── tool_end ──
    case 'tool_end': {
      const endEvent = e as { id?: string; tool?: string; success?: boolean; result?: unknown; screenshot?: string; duration?: number };
      if (!endEvent.id) return [{ type: 'none' }];

      const resultStr = typeof endEvent.result === 'string' ? endEvent.result : (endEvent.result ? JSON.stringify(endEvent.result) : '');
      let screenshotUrl: string | undefined;

      // Extract screenshot from top-level field or result object
      if (typeof endEvent.screenshot === 'string' && endEvent.screenshot) {
        screenshotUrl = endEvent.screenshot;
      } else if (endEvent.result && typeof endEvent.result === 'object') {
        const resultObj = endEvent.result as Record<string, unknown>;
        if (typeof resultObj.screenshot === 'string') screenshotUrl = resultObj.screenshot;
      } else if (typeof endEvent.result === 'string') {
        try {
          const parsed = JSON.parse(endEvent.result);
          if (parsed?.screenshot) screenshotUrl = parsed.screenshot;
        } catch { /* not JSON */ }
      }

      return [{
        type: 'updateToolCall',
        id: endEvent.id,
        updates: {
          result: resultStr,
          status: endEvent.success ? 'completed' : 'error',
          success: endEvent.success,
          completedAt: Date.now(),
          ...(endEvent.duration != null ? { duration: endEvent.duration } : {}),
          ...(screenshotUrl ? { screenshot: screenshotUrl } : {}),
        },
      }];
    }

    // ── tool_result ──
    case 'tool_result': {
      const resultEvent = e as { id?: string; tool?: string; result?: unknown; success?: boolean };
      const resultStr = typeof resultEvent.result === 'string' ? resultEvent.result : (resultEvent.result ? JSON.stringify(resultEvent.result) : '');
      if (resultEvent.id) {
        return [{
          type: 'updateToolCall',
          id: resultEvent.id,
          updates: {
            result: resultStr,
            status: resultEvent.success !== false ? 'completed' : 'error',
            success: resultEvent.success !== false,
            completedAt: Date.now(),
          },
        }];
      }
      return [{ type: 'none' }];
    }

    // ── stream_end / message_done ──
    case 'stream_end':
    case 'message_done': {
      // If synthetic and not streaming, skip
      if ((e as any)._synthetic && !s.isStreaming) {
        return [{ type: 'none' }];
      }

      const endEvent = e as { content?: unknown; model?: string; suggestions?: string[]; responseMode?: string };
      const finalContent = endEvent.content ? normalizeContent(endEvent.content) : '';
      const streamedSoFar = s.streamingContent;

      // R50: Use the LONGER of stream_end.content vs streamingContent
      const fullContent = (finalContent.length >= streamedSoFar.length)
        ? finalContent
        : streamedSoFar;

      // R55: If still empty, try thinkingContent as fallback
      let effectiveContent = fullContent || finalContent;
      if (!effectiveContent && s.thinkingContent) {
        effectiveContent = s.thinkingContent;
      }

      const mutations: StateMutation[] = [];
      mutations.push({ type: 'streamEnd', content: effectiveContent, model: endEvent.model, responseMode: endEvent.responseMode });

      if (endEvent.suggestions && endEvent.suggestions.length > 0) {
        mutations.push({ type: 'setSuggestions', suggestions: endEvent.suggestions });
      }

      return mutations;
    }

    // ── error ──
    case 'error': {
      const errEvent = e as { message?: string };
      const accumulated = s.streamingContent;
      const mutations: StateMutation[] = [];

      if (accumulated && accumulated.trim().length > 0) {
        // R65: Commit accumulated content before showing error
        mutations.push({ type: 'streamEnd', content: accumulated });
      } else {
        mutations.push({ type: 'clearStreaming' });
      }
      mutations.push({ type: 'setError', error: errEvent.message || 'Unknown error' });

      return mutations;
    }

    // ── task_timeout ──
    case 'task_timeout': {
      const accumulated = s.streamingContent;
      const mutations: StateMutation[] = [];

      if (accumulated && accumulated.trim().length > 0) {
        // R63: Commit accumulated content before clearing
        mutations.push({ type: 'streamEnd', content: accumulated });
      } else {
        mutations.push({ type: 'clearStreaming' });
      }
      // Error message is set with i18n t() in caller (side effect), not hard-coded in reducer
      mutations.push({ type: 'setError', error: '任务超时' });

      return mutations;
    }

    // ── status ──
    case 'status': {
      const statusEvent = e as { status?: string };
      if (statusEvent.status !== 'idle') return [{ type: 'none' }];

      const mutations: StateMutation[] = [];

      // Set taskPhase to completed
      mutations.push({ type: 'setTaskPhase', phase: 'completed' });

      if (s.isStreaming) {
        const hasContent = s.streamingContent && s.streamingContent.trim().length > 0;
        const hasToolCalls = s.activeTools && s.activeTools.length > 0;
        const lastMsg = s.messages[s.messages.length - 1];
        const lastMsgIsUser = lastMsg && lastMsg.role === 'user';
        const lastMsgIsAssistant = lastMsg && lastMsg.role === 'assistant';

        if (!hasContent && !hasToolCalls && lastMsgIsUser) {
          // No content received at all — show error
          mutations.push({ type: 'setError', error: 'AI 未能生成回复，请重试。如果问题持续，请尝试简化问题或更换模型。' });
          mutations.push({ type: 'clearStreaming' });
        } else if (!hasContent && hasToolCalls) {
          // Had tool calls but no final text
          mutations.push({ type: 'streamEnd', content: '' });
        } else if (hasContent && lastMsgIsUser) {
          // Content present but no assistant message yet — commit
          mutations.push({ type: 'streamEnd', content: s.streamingContent });
          // streamEnd already clears streaming state
          return mutations;
        } else if (lastMsgIsAssistant) {
          // stream_end already committed the message
          mutations.push({ type: 'clearStreaming' });
        } else {
          mutations.push({ type: 'clearStreaming' });
        }
      }

      return mutations;
    }

    // ── long_running_notify ──
    case 'long_running_notify': {
      const lrn = e as { totalElapsed?: number; toolCount?: number };
      return [{ type: 'setLongRunningNotice', notice: { elapsed: lrn.totalElapsed || 0, toolCount: lrn.toolCount || 0 } }];
    }

    // ── timeout_warning ──
    case 'timeout_warning': {
      // The t() i18n call is a side effect — caller handles it
      // Return none; caller appends thinking via store
      return [{ type: 'none' }];
    }

    // ── plan_progress ──
    case 'plan_progress': {
      const pp = e as {
        planId?: string;
        goal?: string;
        currentStep?: number;
        totalSteps?: number;
        steps?: Array<{ id: string; title: string; status: string }>;
        status?: string;
      };
      const mutations: StateMutation[] = [];

      if (pp.steps && pp.totalSteps) {
        mutations.push({
          type: 'setPlanProgress',
          progress: {
            planId: pp.planId || '',
            goal: pp.goal || '',
            currentStep: pp.currentStep || 1,
            totalSteps: pp.totalSteps,
            steps: pp.steps.map(s => ({
              id: s.id,
              title: s.title,
              status: s.status,
            })),
            status: pp.status || 'in_progress',
          },
        });

        // Update taskPhase based on plan_progress status
        if (pp.status === 'in_progress') {
          mutations.push({ type: 'setTaskPhase', phase: 'executing' });
        } else if (pp.status === 'completed') {
          // plan_completed already sets 'verifying', but if plan_progress itself says completed
          // we may also transition to verifying
          // Don't override — plan_completed has higher priority
        }
      }

      return mutations;
    }

    // ── plan_created / plan_phase_update / plan_completed ──
    case 'plan_created':
    case 'plan_phase_update':
    case 'plan_completed': {
      // These are side-effect-only events (CustomEvent dispatch) in the caller
      // But we set taskPhase transitions here:
      const mutations: StateMutation[] = [];
      if (e.type === 'plan_created') {
        mutations.push({ type: 'setTaskPhase', phase: 'planning' });
      } else if (e.type === 'plan_completed') {
        mutations.push({ type: 'setTaskPhase', phase: 'verifying' });
      }
      return mutations;
    }

    // ── Default: no mutation ──
    default:
      return [{ type: 'none' }];
  }
}

// ─── Apply mutations to a store-like interface ─────────────
export interface MutationHandler {
  setStreaming: (isStreaming: boolean, preserveContent?: boolean) => void;
  clearStreaming: () => void;
  addToolCall: (tool: ToolCall) => void;
  updateToolCall: (id: string, updates: Partial<ToolCall>) => void;
  streamEnd: (content: string, model?: string, responseMode?: string) => void;
  setError: (error: string | null) => void;
  setSuggestions: (suggestions: string[]) => void;
  setPlanProgress: (progress: { planId: string; goal: string; currentStep: number; totalSteps: number; steps: { id: string; title: string; status: string }[]; status: string } | null) => void;
  snapshotTextToTimeline: () => void;
  addTimelineItem: (item: { type: string; toolId?: string; timestamp: number }) => void;
  appendThinking: (content: string) => void;
  setLongRunningNotice: (notice: { elapsed: number; toolCount: number } | null) => void;
  setTaskPhase: (phase: string) => void;
}

/**
 * Apply a list of mutations to a store handler.
 * The handler maps each mutation type to the corresponding store action.
 */
export function applyMutations(mutations: StateMutation[], handler: MutationHandler): void {
  for (const m of mutations) {
    switch (m.type) {
      case 'setStreaming':
        handler.setStreaming(m.isStreaming, m.preserveContent);
        break;
      case 'clearStreaming':
        handler.clearStreaming();
        break;
      case 'addToolCall':
        handler.addToolCall(m.tool);
        break;
      case 'updateToolCall':
        handler.updateToolCall(m.id, m.updates);
        break;
      case 'streamEnd':
        handler.streamEnd(m.content, m.model, m.responseMode);
        break;
      case 'setError':
        handler.setError(m.error);
        break;
      case 'setSuggestions':
        handler.setSuggestions(m.suggestions);
        break;
      case 'setPlanProgress':
        handler.setPlanProgress(m.progress);
        break;
      case 'snapshotTextToTimeline':
        handler.snapshotTextToTimeline();
        break;
      case 'appendTimelineItem':
        handler.addTimelineItem(m.item);
        break;
      case 'appendThinking':
        handler.appendThinking(m.content);
        break;
      case 'setLongRunningNotice':
        handler.setLongRunningNotice(m.notice);
        break;
      case 'setTaskPhase':
        handler.setTaskPhase(m.phase);
        break;
      case 'none':
        break;
    }
  }
}

// ─── Task Phase Labels ─────────────────────────────────────
export const TASK_PHASE_LABELS: Record<string, string> = {
  idle: '',
  planning: '规划中',
  executing: '执行中',
  verifying: '验证中',
  completed: '完成',
};

export type TaskPhase = 'idle' | 'planning' | 'executing' | 'verifying' | 'completed';
