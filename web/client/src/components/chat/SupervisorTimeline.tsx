/**
 * SupervisorTimeline — Real-time progress display for Supervisor-driven autonomous tasks.
 * 
 * Listens to 'rangerai:supervisor' CustomEvents dispatched by useChatStore
 * and renders a collapsible step-by-step timeline with live status updates.
 * 
 * @version 1.0.0 — Iter-S4
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useChatListStore } from '../../stores/useChatListStore';
import { useI18n } from '../../lib/i18n';
import {
  Brain, CheckCircle2, XCircle, Clock, ChevronRight, ChevronDown,
  Loader2, Target, Zap, AlertTriangle, RotateCcw, Search, Image, FileText, ExternalLink,
} from 'lucide-react';
import { BrowserPreviewPanel } from './BrowserPreviewPanel';

// ─── Types ───────────────────────────────────────────────────
interface SupervisorStep {
  stepNum: number;
  instruction: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  isRetry: boolean;
  duration?: number;
  error?: string;
  reflection?: string;  // [P1-2] 执行后反思文本，来自 planner reflection 字段
  startedAt: number;
  completedAt?: number;
  artifacts?: StepArtifact[];
}

interface StepArtifact { type: 'search' | 'screenshot' | 'file' | 'text'; title: string; summary?: string; url?: string; }

interface SupervisorState {
  taskId: string;
  svTaskId: string;
  title: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  steps: SupervisorStep[];
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}


function extractStepArtifacts(detail: any): StepArtifact[] {
  const artifacts: StepArtifact[] = [];
  const payloads = [detail.output, detail.result, detail.reflection, detail.summary, detail.toolResult].filter(Boolean).map(String);
  const joined = payloads.join(' ').replace(/\s+/g, ' ').trim();
  const screenshot = detail.screenshot || detail.screenshotUrl || detail.imageUrl;
  if (screenshot) artifacts.push({ type: 'screenshot', title: '截图缩略图', url: screenshot, summary: detail.url });
  const tool = String(detail.tool || detail.toolName || '').toLowerCase();
  if (tool.includes('search') || detail.searchSummary) artifacts.push({ type: 'search', title: '搜索摘要', summary: String(detail.searchSummary || joined).slice(0, 180) });
  const fileMatch = joined.match(/(?:\/opt|\/home|\.)[^\s"']+\.(?:md|txt|json|csv|png|jpg|jpeg|webp|pdf|html|tsx?|mjs)/i);
  if (fileMatch) artifacts.push({ type: 'file', title: '中间文件', url: fileMatch[0], summary: fileMatch[0] });
  if (!artifacts.length && joined) artifacts.push({ type: 'text', title: '步骤输出', summary: joined.slice(0, 180) });
  return artifacts.slice(0, 3);
}

function StepArtifactPreview({ artifacts }: { artifacts?: StepArtifact[] }) {
  if (!artifacts?.length) return null;
  return <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">{artifacts.map((a, i) => (
    <div key={`${a.type}-${i}`} className="rounded-md border border-zinc-700/50 bg-zinc-950/35 p-2 text-[10px] text-zinc-400">
      <div className="mb-1 flex items-center gap-1.5 text-zinc-300">
        {a.type === 'search' ? <Search size={11} className="text-purple-400" /> : a.type === 'screenshot' ? <Image size={11} className="text-blue-400" /> : <FileText size={11} className="text-cyan-400" />}
        <span className="font-medium">{a.title}</span>{a.url && a.type !== 'screenshot' && <ExternalLink size={10} className="ml-auto text-zinc-500" />}
      </div>
      {a.type === 'screenshot' && a.url ? <img src={a.url} alt="步骤截图" className="max-h-24 w-full rounded border border-zinc-800 object-cover" /> : <p className="line-clamp-3 break-all">{a.summary || a.url}</p>}
    </div>
  ))}</div>;
}

// ─── Component ───────────────────────────────────────────────
export function SupervisorTimeline() {
  const { t } = useI18n();
  const currentChatId = useChatListStore(s => s.currentChatId);
  const [state, setState] = useState<SupervisorState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const stateRef = useRef<SupervisorState | null>(null);

  const handleEvent = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail) return;
    // Skip autonomous/scheduled task events — they dont belong to any specific chat
    if (detail.source === "autonomous" && !detail.chatId) return;
    // If event has a chatId, only show if it matches current chat
    if (detail.chatId && detail.chatId !== currentChatId) return;

    setState(prev => {
      const current: SupervisorState = prev || {
        taskId: detail.taskId || '',
        svTaskId: detail.svTaskId || '',
        title: '',
        goal: '',
        status: 'running' as const,
        steps: [],
        startedAt: Date.now(),
        completedAt: undefined,
        summary: undefined,
        error: undefined,
      };

      const next = { ...current };

      // Fix: WS events have type='supervisor_progress' and eventType='task_start'/'step_start'/etc.
      const eventType = detail.eventType || detail.type;
      switch (eventType) {
        case 'task_start':
          next.title = detail.title || '';
          next.goal = detail.goal || '';
          next.status = 'running';
          next.startedAt = Date.now();
          next.steps = [];
          break;

        case 'supervisor_thinking':
          // Supervisor is deciding next step — show thinking indicator
          break;

        case 'plan_update': {
          // [P1-2] Handle trigger-based step status updates from planner
          // Triggers: step_doing → running, step_done → completed, step_failed → failed
          const trigger = detail.trigger;
          const targetStepId = detail.stepId;

          if (trigger === 'step_doing' && targetStepId) {
            // Find step by id mapping — stepId from planner is numeric id in steps array
            next.steps = next.steps.map((s, idx) => {
              const sId = String(idx + 1);
              if (sId === String(targetStepId) || s.stepNum === Number(targetStepId)) {
                return { ...s, status: 'running' as const, startedAt: Date.now() };
              }
              return s;
            });
          } else if (trigger === 'step_done' && targetStepId) {
            next.steps = next.steps.map((s, idx) => {
              const sId = String(idx + 1);
              if (sId === String(targetStepId) || s.stepNum === Number(targetStepId)) {
                // reflection: use step output from steps array in detail.steps
                const stepDetail = Array.isArray(detail.steps)
                  ? detail.steps.find((ds: any) => String(ds.id) === String(targetStepId))
                  : null;
                return {
                  ...s,
                  status: 'completed' as const,
                  completedAt: Date.now(),
                  reflection: detail.output || stepDetail?.output || undefined,
                  artifacts: extractStepArtifacts({ ...detail, ...(stepDetail || {}) }),
                };
              }
              return s;
            });
          } else if (trigger === 'step_failed' && targetStepId) {
            next.steps = next.steps.map((s, idx) => {
              const sId = String(idx + 1);
              if (sId === String(targetStepId) || s.stepNum === Number(targetStepId)) {
                return {
                  ...s,
                  status: 'failed' as const,
                  completedAt: Date.now(),
                  error: detail.error || detail.reason || '步骤失败',
                };
              }
              return s;
            });
          } else if (Array.isArray(detail.steps)) {
            // Initial plan load or full plan refresh — use detail.steps (new format)
            const planSteps: SupervisorStep[] = detail.steps.map((p: any, i: number) => {
              const stepNum = p.id || (i + 1);
              const existing = next.steps.find(s => s.stepNum === stepNum);
              if (existing && existing.status !== 'pending') return existing;
              return {
                stepNum,
                instruction: p.desc || p.instruction || `Step ${stepNum}`,
                status: (p.status === 'doing' ? 'running' : p.status === 'done' ? 'completed' : 'pending') as SupervisorStep['status'],
                isRetry: false,
                startedAt: existing?.startedAt || 0,
                reflection: p.output || undefined,
                artifacts: extractStepArtifacts(p),
              };
            });
            next.steps = planSteps;
          } else if (Array.isArray(detail.plan)) {
            // Legacy format fallback
            const planSteps: SupervisorStep[] = detail.plan.map((p: any, i: number) => {
              const stepNum = p.stepNum || i + 1;
              const existing = next.steps.find(s => s.stepNum === stepNum);
              if (existing) return existing;
              return {
                stepNum,
                instruction: p.text || p.instruction || `Step ${stepNum}`,
                status: 'pending' as const,
                isRetry: false,
                startedAt: 0,
              };
            });
            next.steps = planSteps;
          }
          break;
        }

        case 'planning_progress':
          // Planning phase indicator — no action needed, thinking indicator handles this
          break;

        case 'step_start': {
          const stepNum = detail.stepNum || (next.steps.length + 1);
          // Update existing step (from plan_update or retry) or add new
          const existingIdx = next.steps.findIndex(s => s.stepNum === stepNum);
          const newStep: SupervisorStep = {
            stepNum,
            instruction: detail.instruction || next.steps[existingIdx]?.instruction || `Step ${stepNum}`,
            status: 'running',
            isRetry: !!detail.isRetry,
            startedAt: Date.now(),
          };
          if (existingIdx >= 0) {
            next.steps = [...next.steps];
            next.steps[existingIdx] = newStep;
          } else {
            next.steps = [...next.steps, newStep];
          }
          break;
        }

         case 'step_complete': {
          const stepNum = detail.stepNum;
          next.steps = next.steps.map(s =>
            s.stepNum === stepNum && (s.status === 'running' || s.status === 'pending')
              ? { ...s, status: 'completed' as const, duration: detail.duration, completedAt: Date.now(),
                  reflection: detail.reflection || undefined, artifacts: extractStepArtifacts(detail) }  // [P1-2] 保存 reflection
              : s
          );
          break;
        }
        case 'step_failed': {
          const stepNum = detail.stepNum;
          next.steps = next.steps.map(s =>
            s.stepNum === stepNum && (s.status === 'running' || s.status === 'pending')
              ? { ...s, status: 'failed' as const, error: detail.error, duration: detail.duration, completedAt: Date.now(),
                  reflection: detail.reflection || undefined, artifacts: extractStepArtifacts(detail) }  // [P1-2] 保存 reflection
              : s
          );
          break;
        }

        case 'task_timeout':
          next.status = 'timeout';
          next.summary = detail.summary;
          next.completedAt = Date.now();
          break;

        case 'task_max_steps':
          next.status = 'completed';
          next.summary = detail.summary;
          next.completedAt = Date.now();
          break;

        case 'task_retry_exhausted':
          next.status = 'failed';
          next.summary = detail.summary;
          next.error = detail.error || '重试次数耗尽';
          next.completedAt = Date.now();
          break;

        case 'task_cancelled':
          next.status = 'cancelled';
          next.completedAt = Date.now();
          break;

        case 'task_complete':
          next.status = detail.status === 'failed' ? 'failed' : 'completed';
          next.summary = detail.summary || next.summary;
          next.completedAt = Date.now();
          // Mark any remaining running steps as completed
          next.steps = next.steps.map(s =>
            s.status === 'running' ? { ...s, status: 'completed' as const, completedAt: Date.now() } : s
          );
          break;

        case 'task_error':
          next.status = 'failed';
          next.error = detail.reason;
          next.completedAt = Date.now();
          break;
      }

      stateRef.current = next;
      return next;
    });
  }, [currentChatId]);

  useEffect(() => {
    window.addEventListener('rangerai:supervisor', handleEvent);
    return () => window.removeEventListener('rangerai:supervisor', handleEvent);
  }, [handleEvent]);

  // Iter-S5: Fallback — poll for active supervisor tasks if no WS events received
  // This handles WS reconnect scenarios where events were missed
  useEffect(() => {
    let cancelled = false;
    const fetchActiveTask = async () => {
      try {
        // Only poll for tasks in the current chat — skip global/scheduled tasks
        const chatId = useChatListStore.getState().currentChatId;
        if (!chatId) return;
        const res = await fetch(`/api/supervisor/tasks?status=running&limit=1&chatId=${encodeURIComponent(chatId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const tasks = data.tasks || data;
        if (Array.isArray(tasks) && tasks.length > 0) {
          const task = tasks[0];
          // Skip tasks with no chatId (scheduled/autonomous tasks)
          if (!task.chatId) return;
          if (!stateRef.current || stateRef.current.svTaskId !== task.id) {
            // Found an active task we're not tracking — hydrate state from API
            const steps: SupervisorStep[] = (task.steps || []).map((s: any, i: number) => ({
              stepNum: s.stepNumber || i + 1,
              instruction: s.instruction || `Step ${i + 1}`,
              status: s.status === 'done' ? 'completed' : s.status === 'error' ? 'failed' : s.status === 'running' ? 'running' : 'pending',
              isRetry: !!s.isRetry,
              startedAt: s.startedAt ? new Date(s.startedAt).getTime() : Date.now(),
              completedAt: s.completedAt ? new Date(s.completedAt).getTime() : undefined,
              duration: s.duration,
              error: s.error,
            }));
            setState({
              taskId: task.metadata?.legacyTaskId || task.id,
              svTaskId: task.id,
              title: task.title || '',
              goal: task.goal || '',
              status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'running',
              steps,
              startedAt: task.createdAt ? new Date(task.createdAt).getTime() : Date.now(),
              completedAt: task.completedAt ? new Date(task.completedAt).getTime() : undefined,
              summary: task.summary,
            });
          }
        }
      } catch { /* silent */ }
    };

    // Initial fetch after 2s (give WS events a chance first)
    const timer = setTimeout(fetchActiveTask, 2000);
    // Then poll every 10s while no state exists
    const interval = setInterval(() => {
      if (!stateRef.current) fetchActiveTask();
    }, 10000);

    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); };
  }, []);

  // Also handle task_complete event from Iter-S5 final WS push
  useEffect(() => {
    const handleComplete = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.eventType === 'task_complete') {
        setState(prev => prev ? {
          ...prev,
          status: detail.status === 'completed' ? 'completed' : 'failed',
          summary: detail.summary || prev.summary,
          completedAt: Date.now(),
        } : prev);
      }
    };
    window.addEventListener('rangerai:supervisor', handleComplete);
    return () => window.removeEventListener('rangerai:supervisor', handleComplete);
  }, []);

  // Auto-hide completed supervisor tasks after 15 seconds
  useEffect(() => {
    if (!state) return;
    const isFinished = ['completed', 'failed', 'cancelled', 'timeout'].includes(state.status);
    if (isFinished) {
      const timer = setTimeout(() => {
        setCollapsed(true);
        // After another 30s, fully hide
        setTimeout(() => setState(null), 30000);
      }, 15000);
      return () => clearTimeout(timer);
    }
  }, [state?.status]);

  // Clear state when chat changes
  useEffect(() => {
    const handleChatChange = () => {
      setState(null);
      stateRef.current = null;
    };
    window.addEventListener('rangerai:chat_changed', handleChatChange);
    return () => window.removeEventListener('rangerai:chat_changed', handleChatChange);
  }, []);

  // Don't render if no supervisor task is active
  if (!state) return null;

  const isRunning = state.status === 'running';
  const isFinished = ['completed', 'failed', 'cancelled', 'timeout'].includes(state.status);
  const completedSteps = state.steps.filter(s => s.status === 'completed').length;
  const totalSteps = state.steps.length;
  const elapsedMs = (state.completedAt || Date.now()) - state.startedAt;

  return (
    <div className="flex gap-2 sm:gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Avatar */}
      <div className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 mt-0.5">
        <div className={`w-full h-full rounded-full flex items-center justify-center ${
          isRunning ? 'bg-violet-500/20' : isFinished && state.status === 'completed' ? 'bg-emerald-500/20' : 'bg-red-500/20'
        }`}>
          {isRunning ? (
            <div className="relative">
              <Target size={14} className="text-violet-400" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-violet-400 animate-ping" />
            </div>
          ) : state.status === 'completed' ? (
            <CheckCircle2 size={14} className="text-emerald-400" />
          ) : (
            <AlertTriangle size={14} className="text-red-400" />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 w-full text-left group mb-1"
        >
          <span className="text-[11px] sm:text-xs font-medium text-violet-300 flex items-center gap-1">
            <Zap size={11} className="text-violet-400" />
            Supervisor
          </span>
          <span className="text-[10px] text-zinc-500">
            {totalSteps > 0 ? `${completedSteps}/${totalSteps} 步` : '规划中...'}
          </span>
          {/* Progress bar */}
          <div className="flex-1 max-w-[120px] h-1 bg-zinc-800 rounded-full overflow-hidden">
            {isRunning && totalSteps === 0 ? (
              <div className="h-full w-full bg-gradient-to-r from-transparent via-violet-500 to-transparent animate-pulse rounded-full" />
            ) : (
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isRunning ? 'bg-violet-500' : state.status === 'completed' ? 'bg-emerald-500' : 'bg-red-500'
                }`}
                style={{ width: `${totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0}%` }}
              />
            )}
          </div>
          {/* Elapsed time */}
          <span className="text-[10px] text-zinc-600 tabular-nums flex items-center gap-0.5">
            <Clock size={9} />
            {formatElapsed(elapsedMs)}
          </span>
          <span className="ml-auto text-zinc-600 group-hover:text-zinc-400 transition-colors">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
        </button>

        {/* Goal */}
        {!collapsed && state.goal && (
          <div className="text-[10px] sm:text-[11px] text-zinc-500 mb-2 pl-1 border-l-2 border-violet-500/30 ml-0.5">
            {state.goal.length > 120 ? state.goal.substring(0, 120) + '...' : state.goal}
          </div>
        )}

        {/* Steps timeline */}
        {!collapsed && (
          <div className="relative pl-3 space-y-0.5">
            {/* Vertical line */}
            <div className="absolute left-[5px] top-1 bottom-1 w-px bg-zinc-700/50" />

            {state.steps.map((step, i) => (
              <SupervisorStepItem key={`${step.stepNum}-${step.isRetry ? 'r' : 'n'}-${i}`} step={step} />
            ))}

            {/* Supervisor thinking indicator */}
            {isRunning && state.steps.every(s => s.status !== 'running') && (
              <div className="relative flex items-center gap-2 py-1">
                <div className="absolute -left-3 w-[11px] flex justify-center">
                  <Loader2 size={11} className="text-violet-400 animate-spin" />
                </div>
                <span className="text-[11px] text-violet-400/80 animate-pulse">
                  Supervisor 正在分析...
                </span>
              </div>
            )}
          </div>
        )}

        {/* Summary / Error */}
        {isFinished && state.summary && !collapsed && (
          <div className="mt-2 text-[11px] text-zinc-400 bg-zinc-800/50 rounded-lg px-2.5 py-2 border border-zinc-700/50">
            <p className="font-medium text-zinc-300 mb-1">
              {state.status === 'completed' ? '任务完成' : state.status === 'timeout' ? '任务超时' : '任务失败'}
            </p>
            <p className="whitespace-pre-wrap">{state.summary.substring(0, 500)}</p>
          </div>
        )}
        {isFinished && state.error && !collapsed && (
          <div className="mt-2 text-[11px] text-red-300 bg-red-500/10 rounded-lg px-2.5 py-2 border border-red-500/20">
            {state.error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step Item ───────────────────────────────────────────────
function SupervisorStepItem({ step }: { step: SupervisorStep }) {
  const elapsed = step.duration
    ? formatElapsed(step.duration)
    : step.status === 'running'
      ? formatElapsed(Date.now() - step.startedAt)
      : null;

  return (
    <div className={`relative flex items-start gap-2 py-0.5 ${
      step.status === 'completed' ? 'opacity-60' : 'opacity-100'
    }`}>
      {/* Dot */}
      <div className="absolute -left-3 w-[11px] flex justify-center mt-0.5">
        {step.status === 'running' ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-50" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
          </span>
        ) : step.status === 'completed' ? (
          <CheckCircle2 size={11} className="text-emerald-500" />
        ) : step.status === 'failed' ? (
          <XCircle size={11} className="text-red-400" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-zinc-600" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {step.isRetry && (
            <RotateCcw size={10} className="text-amber-400 shrink-0" />
          )}
          <span className={`text-[11px] sm:text-xs font-medium truncate ${
            step.status === 'running' ? 'text-violet-300' :
            step.status === 'completed' ? 'text-zinc-400' :
            step.status === 'failed' ? 'text-red-400' : 'text-zinc-500'
          }`}>
            步骤 {step.stepNum}
          </span>
          {elapsed && (
            <span className="text-[10px] text-zinc-600 ml-auto shrink-0 flex items-center gap-0.5 tabular-nums">
              <Clock size={9} />
              {elapsed}
            </span>
          )}
        </div>
        {step.instruction && (
          <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2">
            {step.instruction}
          </p>
        )}
        {step.error && (
          <p className="text-[10px] text-red-400/80 mt-0.5">
            {step.error.substring(0, 150)}
          </p>
        )}
        <StepArtifactPreview artifacts={step.artifacts} />
        {step.status === 'running' && step.artifacts?.some(a => a.type === 'screenshot') && (
          <div className="mt-2 max-h-72 overflow-hidden rounded-lg border border-blue-500/20"><BrowserPreviewPanel /></div>
        )}
        {/* [P1-2] Reflection — 步骤执行后反思，仅在 completed/failed 时显示 */}
        {step.reflection && (step.status === 'completed' || step.status === 'failed') && (
          <p className="text-[10px] text-violet-400/70 mt-0.5 italic line-clamp-2" title={step.reflection}>
            💡 {step.reflection.substring(0, 200)}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export default SupervisorTimeline;
