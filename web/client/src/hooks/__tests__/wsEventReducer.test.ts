/**
 * wsEventReducer — Event replay test suite
 * Tests deterministic state transitions: stream_start → tool_call → stream_end → idle
 */
import { describe, it, expect } from 'vitest';
import { wsEventReducer, emptySnapshot, applyMutations, TASK_PHASE_LABELS } from '../wsEventReducer';
import type { StateSnapshot, StateMutation, MutationHandler, TaskPhase } from '../wsEventReducer';

// ─── Helper: Lightweight store for mutation accumulation ───
function createTestStore() {
  const state: Record<string, unknown> = {
    isStreaming: false,
    streamingContent: '',
    thinkingContent: '',
    activeTools: [] as Array<{ id: string; tool: string; args: string; status: string; completedAt?: number; progress?: string }>,
    messages: [] as Array<{ id: number; role: string; content: string }>,
    error: null as string | null,
    suggestions: [] as string[],
    planProgress: null as Record<string, unknown> | null,
    timeline: [] as Array<{ type: string; toolId?: string; timestamp: number }>,
    taskPhase: 'idle' as string,
    longRunningNotice: null as { elapsed: number; toolCount: number } | null,
  };

  const handler: MutationHandler = {
    setStreaming: (isStreaming, preserveContent) => {
      state.isStreaming = isStreaming;
      if (!preserveContent) {
        state.streamingContent = '';
      }
    },
    clearStreaming: () => {
      state.isStreaming = false;
      state.streamingContent = '';
    },
    addToolCall: (tool) => {
      (state.activeTools as Array<Record<string, unknown>>).push(tool as Record<string, unknown>);
    },
    updateToolCall: (id, updates) => {
      const tools = state.activeTools as Array<Record<string, unknown>>;
      const idx = tools.findIndex(t => t.id === id);
      if (idx >= 0) {
        tools[idx] = { ...tools[idx], ...updates };
      }
    },
    streamEnd: (content) => {
      (state.messages as Array<Record<string, unknown>>).push({
        id: Date.now(),
        role: 'assistant',
        content,
      });
      state.isStreaming = false;
      state.streamingContent = '';
    },
    setError: (error) => { state.error = error; },
    setSuggestions: (suggestions) => { state.suggestions = suggestions; },
    setPlanProgress: (progress) => { state.planProgress = progress; },
    snapshotTextToTimeline: () => {
      (state.timeline as Array<Record<string, unknown>>).push({
        type: 'snapshot',
        timestamp: Date.now(),
      });
    },
    addTimelineItem: (item) => {
      (state.timeline as Array<Record<string, unknown>>).push(item as Record<string, unknown>);
    },
    appendThinking: (content) => {
      state.thinkingContent = (state.thinkingContent as string) + content;
    },
    setLongRunningNotice: (notice) => { state.longRunningNotice = notice; },
    setTaskPhase: (phase) => { state.taskPhase = phase; },
  };

  return { state, handler };
}

// ─── Helper: build snapshot from test store ───
function snapshotFromStore(state: Record<string, unknown>): StateSnapshot {
  return {
    isStreaming: state.isStreaming as boolean,
    streamingContent: state.streamingContent as string,
    thinkingContent: state.thinkingContent as string,
    activeTools: state.activeTools as StateSnapshot['activeTools'],
    messages: state.messages as StateSnapshot['messages'],
    _lastStreamEndAt: 0,
    planProgress: state.planProgress as StateSnapshot['planProgress'],
    taskPhase: state.taskPhase as string,
  };
}

describe('wsEventReducer — 核心事件序列', () => {
  // ── Test 1: stream_start 正常启动 ──
  it('stream_start 应设置 isStreaming=true 且 reset filter/buffer', () => {
    const snap = emptySnapshot();
    const result = wsEventReducer({ snapshot: snap, event: { type: 'stream_start' } });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('setStreaming');
    expect((result[0] as any).isStreaming).toBe(true);
  });

  // ── Test 2: stream_start 防重复 (cooldown 内) ──
  it('stream_start 在 2 秒内重复应返回 none', () => {
    const snap = { ...emptySnapshot(), _lastStreamEndAt: Date.now() - 500 };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'stream_start' } });
    expect(result[0].type).toBe('none');
  });

  // ── Test 3: stream_start 有存量内容时跳过重置 ──
  it('stream_start 当 streamingContent 非空时应返回 none (保护存量内容)', () => {
    const snap = { ...emptySnapshot(), streamingContent: 'hello' };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'stream_start' } });
    expect(result[0].type).toBe('none');
  });

  // ── Test 4: tool_start 创建 tool + 快照 + 时间线 ──
  it('tool_start 应触发 setStreaming + snapshotTextToTimeline + addToolCall + appendTimelineItem', () => {
    const snap = emptySnapshot();
    const result = wsEventReducer({
      snapshot: snap,
      event: { type: 'tool_start', id: 't1', tool: 'exec', args: { cmd: 'ls' } },
    });

    const types = result.map(r => r.type);
    expect(types).toContain('setStreaming');
    expect(types).toContain('snapshotTextToTimeline');
    expect(types).toContain('addToolCall');
    expect(types).toContain('appendTimelineItem');

    const addTool = result.find(r => r.type === 'addToolCall') as any;
    expect(addTool.tool.tool).toBe('exec');
    expect(addTool.tool.status).toBe('running');
  });

  // ── Test 5: tool_start 无 tool 名返回 none ──
  it('tool_start 无 tool 名应返回 none', () => {
    const snap = emptySnapshot();
    const result = wsEventReducer({
      snapshot: snap,
      event: { type: 'tool_start', id: 't1' },
    });
    expect(result[0].type).toBe('none');
  });

  // ── Test 6: tool_end 成功完成 ──
  it('tool_end 应将 tool 标记为 completed', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      activeTools: [{ id: 't1', tool: 'exec', args: '{}', status: 'running', startedAt: Date.now() }],
    };
    const result = wsEventReducer({
      snapshot: snap,
      event: { type: 'tool_end', id: 't1', tool: 'exec', success: true, result: 'ok' },
    });
    expect(result[0].type).toBe('updateToolCall');
    const update = result[0] as any;
    expect(update.id).toBe('t1');
    expect(update.updates.status).toBe('completed');
    expect(update.updates.success).toBe(true);
  });

  // ── Test 7: stream_end 提交流内容 + 建议 ──
  it('stream_end 应触发 streamEnd + setSuggestions', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      streamingContent: 'Hello, this is the final response.',
    };
    const result = wsEventReducer({
      snapshot: snap,
      event: { type: 'stream_end', content: 'Hello, this is the final response.', suggestions: ['试试这个'] },
    });
    const types = result.map(r => r.type);
    expect(types).toContain('streamEnd');
    expect(types).toContain('setSuggestions');
  });

  // ── Test 8: status:idle 清理流并设 taskPhase=completed ──
  it('status:idle 应设置 taskPhase=completed 并 clearStreaming', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      streamingContent: 'Done',
      messages: [{ id: 1, role: 'user', content: 'hi' }],
    };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'status', status: 'idle' } });
    const types = result.map(r => r.type);
    expect(types).toContain('setTaskPhase');
    expect(types).toContain('streamEnd'); // hasContent + lastMsgIsUser
  });

  // ── Test 9: status:idle 时非 streaming 状态返回空 ──
  it('status:idle 非 idle 状态应返回 none', () => {
    const snap = emptySnapshot();
    const result = wsEventReducer({ snapshot: snap, event: { type: 'status', status: 'running' } });
    expect(result[0].type).toBe('none');
  });

  // ── Test 10: status:idle 无内容且无 tool → setError ──
  it('status:idle 无内容无工具时应用端不应丢失错误', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      messages: [{ id: 1, role: 'user', content: 'test' }],
    };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'status', status: 'idle' } });
    expect(result.some(r => r.type === 'setError')).toBe(true);
  });

  // ── Test 11: 完整事件回放序列 stream_start → tool_start → tool_end → stream_end → idle ──
  it('完整事件回放: stream_start → tool_start → tool_end → stream_end → idle', () => {
    const { state, handler } = createTestStore();

    // Step 1: stream_start
    let mutations = wsEventReducer({ snapshot: snapshotFromStore(state), event: { type: 'stream_start' } });
    applyMutations(mutations, handler);
    expect(state.isStreaming).toBe(true);

    // Step 2: tool_start (exec)
    mutations = wsEventReducer({
      snapshot: snapshotFromStore(state),
      event: { type: 'tool_start', id: 't-exec', tool: 'exec', args: { cmd: 'echo hi' } },
    });
    applyMutations(mutations, handler);
    const tools = state.activeTools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].tool).toBe('exec');
    expect(tools[0].status).toBe('running');

    // Step 3: tool_end (success)
    mutations = wsEventReducer({
      snapshot: snapshotFromStore(state),
      event: { type: 'tool_end', id: 't-exec', tool: 'exec', success: true, result: 'hi' },
    });
    applyMutations(mutations, handler);
    expect(tools[0].status).toBe('completed');
    expect(tools[0].success).toBe(true);

    // Step 4: stream_end
    mutations = wsEventReducer({
      snapshot: { ...snapshotFromStore(state), streamingContent: 'Result: hi' },
      event: { type: 'stream_end', content: 'Result: hi' },
    });
    applyMutations(mutations, handler);
    const msgs = state.messages as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');

    // Step 5: status:idle
    mutations = wsEventReducer({
      snapshot: { ...snapshotFromStore(state), isStreaming: false },
      event: { type: 'status', status: 'idle' },
    });
    applyMutations(mutations, handler);
    expect(state.taskPhase).toBe('completed');
  });

  // ── Test 12: 边界 — 缺 stream_end 直接 idle (有 tool 无文本) ──
  it('边界: idle 有 tool 无文本应调用 streamEnd(\'\')', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      activeTools: [{ id: 't1', tool: 'web_search', args: '{}', status: 'completed', completedAt: Date.now() }],
      messages: [{ id: 1, role: 'user', content: 'search' }],
    };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'status', status: 'idle' } });
    expect(result.some(r => r.type === 'streamEnd')).toBe(true);
    // streamEnd with empty content
    const se = result.find(r => r.type === 'streamEnd') as any;
    expect(se.content).toBe('');
  });

  // ── Test 13: 边界 — 缺 stream_end 直接 idle (有内容) ──
  it('边界: idle 有 streamingContent + lastMsgIsUser 应 commit content', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      streamingContent: 'partial response',
      messages: [{ id: 1, role: 'user', content: 'query' }],
    };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'status', status: 'idle' } });
    const se = result.find(r => r.type === 'streamEnd') as any;
    expect(se.content).toBe('partial response');
  });

  // ── Test 14: 边界 — idle 时 lastMsgIsAssistant 直接 clear ──
  it('边界: idle 时 lastMsgIsAssistant 应 clearStreaming 不重复 commit', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      messages: [
        { id: 1, role: 'user', content: 'query' },
        { id: 2, role: 'assistant', content: 'answer' },
      ],
    };
    const result = wsEventReducer({ snapshot: snap, event: { type: 'status', status: 'idle' } });
    expect(result.some(r => r.type === 'clearStreaming')).toBe(true);
    expect(result.every(r => r.type !== 'streamEnd')).toBe(true);
  });

  // ── Test 15: plan_created → taskPhase=planning ──
  it('plan_created 应设 taskPhase=planning', () => {
    const result = wsEventReducer({
      snapshot: emptySnapshot(),
      event: { type: 'plan_created', planId: 'p1' },
    });
    expect(result[0].type).toBe('setTaskPhase');
    expect((result[0] as any).phase).toBe('planning');
  });

  // ── Test 16: plan_progress(in_progress) → taskPhase=executing + setPlanProgress ──
  it('plan_progress(in_progress) 应设 taskPhase=executing + setPlanProgress', () => {
    const result = wsEventReducer({
      snapshot: emptySnapshot(),
      event: {
        type: 'plan_progress',
        planId: 'p1',
        goal: 'test goal',
        currentStep: 2,
        totalSteps: 5,
        steps: [{ id: 's1', title: 'step 1', status: 'completed' }, { id: 's2', title: 'step 2', status: 'running' }],
        status: 'in_progress',
      },
    });
    const types = result.map(r => r.type);
    expect(types).toContain('setPlanProgress');
    expect(types).toContain('setTaskPhase');
    const phaseMutation = result.find(r => r.type === 'setTaskPhase') as any;
    expect(phaseMutation.phase).toBe('executing');
  });

  // ── Test 17: plan_completed → taskPhase=verifying ──
  it('plan_completed 应设 taskPhase=verifying', () => {
    const result = wsEventReducer({
      snapshot: emptySnapshot(),
      event: { type: 'plan_completed' },
    });
    expect(result[0].type).toBe('setTaskPhase');
    expect((result[0] as any).phase).toBe('verifying');
  });

  // ── Test 18: error 事件提交累积内容 + setError ──
  it('error 有 streamingContent 应先 streamEnd 再 setError', () => {
    const snap: StateSnapshot = {
      ...emptySnapshot(),
      isStreaming: true,
      streamingContent: 'partial response...',
    };
    const result = wsEventReducer({
      snapshot: snap,
      event: { type: 'error', message: 'Connection lost' },
    });
    const types = result.map(r => r.type);
    expect(types).toContain('streamEnd');
    expect(types).toContain('setError');
  });
});

describe('wsEventReducer — TaskPhase 标签映射', () => {
  it('TASK_PHASE_LABELS 包含全部阶段', () => {
    expect(TASK_PHASE_LABELS.idle).toBe('');
    expect(TASK_PHASE_LABELS.planning).toBe('规划中');
    expect(TASK_PHASE_LABELS.executing).toBe('执行中');
    expect(TASK_PHASE_LABELS.verifying).toBe('验证中');
    expect(TASK_PHASE_LABELS.completed).toBe('完成');
  });
});

describe('wsEventReducer — emptySnapshot', () => {
  it('应返回全空初始状态', () => {
    const snap = emptySnapshot();
    expect(snap.isStreaming).toBe(false);
    expect(snap.streamingContent).toBe('');
    expect(snap.activeTools).toEqual([]);
    expect(snap.messages).toEqual([]);
    expect(snap.taskPhase).toBe('idle');
  });
});
