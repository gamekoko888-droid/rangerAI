import type React from 'react';
/**
 * TaskDetailPage — Full detail view for a Supervisor task
 * Iter-S8 P3: Shows task goal, step-by-step timeline with full results, final result, total duration
 */
import { useState, useEffect, useCallback } from 'react';
import { useRoute, useLocation } from 'wouter';
import {
  ArrowLeft, Target, Clock, CheckCircle2, XCircle, Loader2,
  Zap, AlertTriangle, RotateCcw, ChevronDown, ChevronRight,
  Copy, Check, Brain, Ban, ListOrdered,
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────
interface SupervisorStep {
  id: string;
  taskId: string;
  stepNum: number;
  instruction: string;
  status: string;
  result: string | null;
  error: string | null;
  retryCount: number;
  supervisorDecision: any;
  duration: number | null;
  createdAt: number;
  updatedAt: number;
  tool_used?: string;
}

interface StructuredResult {
  answer: string;
  steps_summary: { step: number; instruction: string; tool_used: string; result_preview: string; duration_ms: number }[];
  total_steps: number;
  duration_s: number;
  task_id: string;
}

interface PlanStep {
  stepNum: number;
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

interface SupervisorTask {
  id: string;
  title: string;
  goal: string;
  status: string;
  currentStepNum: number;
  totalSteps: number;
  result: string | null;
  result_text?: string;
  structured?: StructuredResult;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  metadata: any;
  steps: SupervisorStep[];
  plan?: PlanStep[] | null;
  _stepsSource?: string;
  duration_ms?: number;
}

// ─── Helpers ─────────────────────────────────────────────────
async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('auth_token');
  return fetch(url, {
    ...options,
    headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'completed':
      return { label: '已完成', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', icon: <CheckCircle2 size={12} /> };
    case 'running':
      return { label: '执行中', color: 'bg-violet-500/10 text-violet-400 border-violet-500/20', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'failed':
      return { label: '失败', color: 'bg-red-500/10 text-red-400 border-red-500/20', icon: <XCircle size={12} /> };
    case 'timeout':
      return { label: '超时', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20', icon: <AlertTriangle size={12} /> };
    case 'cancelled':
      return { label: '已取消', color: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20', icon: <XCircle size={12} /> };
    default:
      return { label: status, color: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20', icon: <Clock size={12} /> };
  }
}

// S13 P2: Render text with clickable links for source references
function renderWithLinks(text: string) {
  // Match markdown links: [title](url) and 来源：[title](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const parts: (string | React.ReactNode)[] = [];
  let lastIndex = 0;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const [, title, url] = match;
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors">
        {title}
      </a>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}

// ─── CopyButton ──────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button onClick={handleCopy} className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors" title="复制">
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
    </button>
  );
}

// S12 P0: Tool badge component
const TOOL_COLORS: Record<string, string> = {
  exec: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  web_search: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  web_fetch: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  read: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  write: 'bg-pink-500/10 text-pink-400 border-pink-500/20',
  browser: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  llm: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
};
const TOOL_LABELS: Record<string, string> = {
  exec: 'Shell', web_search: '搜索', web_fetch: '网页', read: '读取', write: '写入', browser: '浏览器', llm: 'LLM',
};

function ToolBadge({ tool }: { tool: string }) {
  const color = TOOL_COLORS[tool] || TOOL_COLORS.llm;
  const label = TOOL_LABELS[tool] || tool;
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${color}`}>
      {label}
    </span>
  );
}

// ─── StepDetail ──────────────────────────────────────────────
function StepDetail({ step, isLast }: { step: SupervisorStep; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const statusBadge = getStatusBadge(step.status);
  const decision = step.supervisorDecision;
  const decisionLabel = typeof decision === 'object' && decision?.decision ? decision.decision : null;
  const toolUsed = step.tool_used || (typeof decision === 'object' ? decision?.tool : null);

  return (
    <div className="relative">
      {/* Vertical connector line */}
      {!isLast && (
        <div className="absolute left-[15px] top-[30px] bottom-0 w-px bg-zinc-700/50" />
      )}
      <div className="flex gap-3">
        {/* Step indicator */}
        <div className="flex flex-col items-center shrink-0">
          <div className={`w-[30px] h-[30px] rounded-full flex items-center justify-center border ${
            step.status === 'completed' ? 'border-emerald-500/40 bg-emerald-500/10' :
            step.status === 'running' ? 'border-violet-500/40 bg-violet-500/10' :
            step.status === 'failed' ? 'border-red-500/40 bg-red-500/10' :
            'border-zinc-600 bg-zinc-800'
          }`}>
            <span className="text-xs font-mono font-bold text-zinc-300">{step.stepNum}</span>
          </div>
        </div>
        {/* Step content */}
        <div className="flex-1 min-w-0 pb-4">
          {/* Step header */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full text-left flex items-center gap-2 group"
          >
            <span className="text-sm font-medium text-zinc-200 flex-1">
              步骤 {step.stepNum}
            </span>
            {toolUsed && toolUsed !== 'llm' && <ToolBadge tool={toolUsed} />}
            {step.retryCount > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
                <RotateCcw size={10} />
                重试 {step.retryCount}
              </span>
            )}
            {decisionLabel && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                decisionLabel === 'next' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                decisionLabel === 'retry' ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' :
                decisionLabel === 'finish' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                'bg-red-500/10 text-red-400 border-red-500/20'
              }`}>{decisionLabel}</span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${statusBadge.color}`}>
              {statusBadge.icon}
              {statusBadge.label}
            </span>
            {step.duration != null && (
              <span className="text-[10px] text-zinc-500 flex items-center gap-0.5 tabular-nums">
                <Clock size={9} />
                {formatDuration(step.duration)}
              </span>
            )}
            <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors">
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
          {/* Instruction */}
          <p className="text-xs text-zinc-500 mt-1">{step.instruction}</p>
          {/* Expanded content */}
          {expanded && (
            <div className="mt-2 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
              {/* Step result */}
              {step.result && (
                <div className="bg-zinc-800/50 rounded-lg border border-zinc-700/50 overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-700/30">
                    <span className="text-[10px] font-medium text-zinc-400">执行结果</span>
                    <CopyButton text={step.result} />
                  </div>
                  <pre className="px-3 py-2 text-[11px] text-zinc-300 whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto font-mono leading-relaxed">
                    {renderWithLinks(step.result)}
                  </pre>
                </div>
              )}
              {/* Step error */}
              {step.error && (
                <div className="bg-red-500/5 rounded-lg border border-red-500/20 overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-red-500/10">
                    <span className="text-[10px] font-medium text-red-400">错误信息</span>
                    <CopyButton text={step.error} />
                  </div>
                  <pre className="px-3 py-2 text-[11px] text-red-300 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto font-mono">
                    {step.error}
                  </pre>
                </div>
              )}
              {/* Supervisor decision detail */}
              {decision && typeof decision === 'object' && (
                <div className="bg-violet-500/5 rounded-lg border border-violet-500/20 px-3 py-2">
                  <span className="text-[10px] font-medium text-violet-400 flex items-center gap-1 mb-1">
                    <Brain size={10} />
                    Supervisor 决策
                  </span>
                  {decision.reasoning && (
                    <p className="text-[11px] text-zinc-400 mt-1">{decision.reasoning}</p>
                  )}
                  {decision.step && (
                    <p className="text-[11px] text-zinc-500 mt-1">
                      <span className="text-zinc-600">下一步：</span> {decision.step}
                    </p>
                  )}
                  {decision.answer && (
                    <p className="text-[11px] text-zinc-400 mt-1">
                      <span className="text-zinc-600">最终回答：</span> {decision.answer}
                    </p>
                  )}
                </div>
              )}
              {/* Timestamps */}
              <div className="flex items-center gap-4 text-[10px] text-zinc-600">
                <span>创建: {formatTimestamp(step.createdAt)}</span>
                <span>更新: {formatTimestamp(step.updatedAt)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────
export default function TaskDetailPage() {
  const [, params] = useRoute('/tasks/:id');
  const [, navigate] = useLocation();
  const taskId = params?.id;

  const [task, setTask] = useState<SupervisorTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const loadTask = useCallback(async () => {
    if (!taskId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetchWithAuth(`/api/supervisor/tasks/${taskId}`);
      if (!res.ok) {
        // Try autonomous task API as fallback
        const atRes = await fetchWithAuth(`/api/autonomous-tasks`);
        if (atRes.ok) {
          const atData = await atRes.json();
          const atTask = atData.tasks?.find((t: any) => t.id === taskId);
          if (atTask) {
            // Convert autonomous task format to supervisor task format for display
            setTask({
              id: atTask.id,
              title: atTask.title || '自主任务',
              goal: atTask.description || '',
              status: atTask.status,
              currentStepNum: atTask.completedSteps || 0,
              totalSteps: atTask.totalSteps || 0,
              result: atTask.result,
              error: atTask.error,
              createdAt: new Date(atTask.createdAt).getTime(),
              updatedAt: new Date(atTask.completedAt || atTask.createdAt).getTime(),
              completedAt: atTask.completedAt ? new Date(atTask.completedAt).getTime() : null,
              metadata: {},
              steps: [],
            });
            return;
          }
        }
        throw new Error(`任务不存在 (${res.status})`);
      }
      const data = await res.json();
      if (data.ok && data.task) {
        // S15 P0: Parse plan if it's a string
        if (data.task.plan && typeof data.task.plan === 'string') {
          try { data.task.plan = JSON.parse(data.task.plan); } catch { data.task.plan = null; }
        }
        setTask(data.task);
      } else {
        throw new Error(data.error || '加载失败');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // S10 P1: Cancel handler
  const handleCancel = useCallback(async () => {
    if (!taskId || cancelling) return;
    setCancelling(true);
    try {
      // Cancel supervisor task
      const svRes = await fetchWithAuth(`/api/supervisor/tasks/${taskId}/cancel`, { method: 'POST' });
      // Also cancel legacy autonomous task if linked
      const legacyId = task?.metadata?.legacyTaskId;
      if (legacyId) {
        await fetchWithAuth(`/api/autonomous-tasks/${legacyId}/cancel`, { method: 'POST' }).catch(() => {});
      }
      if (svRes.ok) {
        toast.success('任务已取消');
        loadTask();
      } else {
        const d = await svRes.json().catch(() => ({}));
        toast.error(d.error || '取消失败');
      }
    } catch {
      toast.error('取消请求失败');
    } finally {
      setCancelling(false);
    }
  }, [taskId, cancelling, task, loadTask]);

  useEffect(() => {
    loadTask();
  }, [loadTask]);

  // Auto-refresh for running tasks
  useEffect(() => {
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return;
    const interval = setInterval(loadTask, 5000);
    return () => clearInterval(interval);
  }, [task?.status, loadTask]);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
          <span className="text-sm text-zinc-500">加载任务详情...</span>
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertTriangle className="w-12 h-12 text-red-400" />
          <p className="text-sm text-zinc-400">{error || '任务不存在'}</p>
          <button
            onClick={() => navigate('/tasks')}
            className="text-sm text-violet-400 hover:text-violet-300 flex items-center gap-1"
          >
            <ArrowLeft size={14} />
            返回任务列表
          </button>
        </div>
      </div>
    );
  }

  const statusBadge = getStatusBadge(task.status);
  const totalDuration = task.completedAt ? task.completedAt - task.createdAt : Date.now() - task.createdAt;
  const completedSteps = task.steps.filter(s => s.status === 'completed').length;
  const failedSteps = task.steps.filter(s => s.status === 'failed').length;

  // Parse final result - use structured result if available
  let finalResult = task.result_text || task.result;
  const structured = task.structured;
  try {
    if (finalResult && !task.result_text) {
      const parsed = JSON.parse(finalResult);
      finalResult = parsed.reply || parsed.answer || parsed.summary || JSON.stringify(parsed, null, 2);
    }
  } catch { /* use raw */ }
  
  // S12 P0: Detect tools used across all steps
  const toolsUsed = new Set<string>();
  task.steps.forEach(s => {
    const tool = s.tool_used || 'llm';
    if (tool !== 'llm') toolsUsed.add(tool);
  });
  if (structured?.steps_summary) {
    structured.steps_summary.forEach(s => {
      if (s.tool_used && s.tool_used !== 'llm') toolsUsed.add(s.tool_used);
    });
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur-sm border-b border-zinc-800">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate('/tasks')}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold truncate">{task.title || '自主任务'}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${statusBadge.color}`}>
                {statusBadge.icon}
                {statusBadge.label}
              </span>
              <span className="text-[10px] text-zinc-500 flex items-center gap-0.5">
                <Clock size={9} />
                {formatDuration(totalDuration)}
              </span>
              <span className="text-[10px] text-zinc-600">
                {formatTimestamp(task.createdAt)}
              </span>
            </div>
          </div>
          {/* S10 P1: Cancel button for running/pending tasks */}
          {(task.status === 'running' || task.status === 'pending') && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              {cancelling ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
              {cancelling ? '取消中...' : '取消任务'}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Task overview cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] text-zinc-500 mb-0.5">总步骤</p>
            <p className="text-lg font-bold text-zinc-200">{task.steps.length}</p>
          </div>
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] text-zinc-500 mb-0.5">已完成</p>
            <p className="text-lg font-bold text-emerald-400">{completedSteps}</p>
          </div>
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] text-zinc-500 mb-0.5">失败</p>
            <p className="text-lg font-bold text-red-400">{failedSteps}</p>
          </div>
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-3 py-2.5">
            <p className="text-[10px] text-zinc-500 mb-0.5">总耗时</p>
            <p className="text-lg font-bold text-zinc-200">{formatDuration(totalDuration)}</p>
          </div>
        </div>

        {/* Task goal */}
        {task.goal && (
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Target size={14} className="text-violet-400" />
              <span className="text-xs font-medium text-zinc-300">任务目标</span>
            </div>
            <p className="text-sm text-zinc-400 leading-relaxed">{task.goal}</p>
          </div>
        )}

        {/* S15 P0: Execution Plan Card */}
        {task.plan && Array.isArray(task.plan) && task.plan.length > 0 && (
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <ListOrdered size={14} className="text-violet-400" />
              <span className="text-xs font-medium text-zinc-300">执行计划</span>
              <span className="text-[10px] text-zinc-500 ml-auto">
                {task.plan.filter(p => p.status === 'done').length}/{task.plan.length} 完成
              </span>
            </div>
            <div className="space-y-1.5">
              {task.plan.map((p) => (
                <div key={p.stepNum} className="flex items-start gap-2">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                    p.status === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                    p.status === 'in_progress' ? 'bg-violet-500/20 text-violet-400' :
                    p.status === 'skipped' ? 'bg-zinc-700/50 text-zinc-500' :
                    'bg-zinc-800 text-zinc-500'
                  }`}>
                    {p.status === 'done' ? <CheckCircle2 size={11} /> :
                     p.status === 'in_progress' ? <Loader2 size={11} className="animate-spin" /> :
                     p.status === 'skipped' ? <XCircle size={9} /> :
                     <span className="text-[9px] font-mono">{p.stepNum}</span>}
                  </div>
                  <span className={`text-xs leading-relaxed ${
                    p.status === 'done' ? 'text-zinc-300' :
                    p.status === 'in_progress' ? 'text-violet-300' :
                    p.status === 'skipped' ? 'text-zinc-600 line-through' :
                    'text-zinc-500'
                  }`}>{p.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* S12 P0: Tools used summary */}
        {toolsUsed.size > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-zinc-500">使用工具:</span>
            {Array.from(toolsUsed).map(t => <ToolBadge key={t} tool={t} />)}
          </div>
        )}

        {/* Steps timeline */}
        {task.steps.length > 0 && (
          <div className="bg-zinc-900/60 rounded-xl border border-zinc-800 px-4 py-4">
            <div className="flex items-center gap-2 mb-4">
              <Zap size={14} className="text-violet-400" />
              <span className="text-xs font-medium text-zinc-300">执行步骤</span>
              {task._stepsSource === 'metadata' && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">历史数据</span>
              )}
              <span className="text-[10px] text-zinc-500 ml-auto">
                点击步骤展开完整输出
              </span>
            </div>
            <div className="space-y-0">
              {task.steps
                .sort((a, b) => a.stepNum - b.stepNum)
                .map((step, i) => (
                  <StepDetail
                    key={step.id}
                    step={step}
                    isLast={i === task.steps.length - 1}
                  />
                ))}
            </div>
          </div>
        )}

        {/* Final result - S12 P0: Enhanced with structured info */}
        {finalResult && task.status === 'completed' && (
          <div className="bg-emerald-500/5 rounded-xl border border-emerald-500/20 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-emerald-500/10">
              <span className="text-xs font-medium text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 size={13} />
                最终结果
              </span>
              <div className="flex items-center gap-2">
                {structured && (
                  <span className="text-[10px] text-zinc-500">
                    {structured.total_steps} 步 · {structured.duration_s}s
                  </span>
                )}
                <CopyButton text={finalResult} />
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">{renderWithLinks(finalResult)}</p>
            </div>
          </div>
        )}

        {/* Error */}
        {task.error && (
          <div className="bg-red-500/5 rounded-xl border border-red-500/20 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-red-500/10">
              <span className="text-xs font-medium text-red-400 flex items-center gap-1.5">
                <XCircle size={13} />
                错误信息
              </span>
              <CopyButton text={task.error} />
            </div>
            <div className="px-4 py-3">
              <p className="text-sm text-red-300 whitespace-pre-wrap">{task.error}</p>
            </div>
          </div>
        )}

        {/* Metadata */}
        <div className="text-[10px] text-zinc-600 flex flex-wrap gap-4 px-1">
          <span>任务 ID: {task.id}</span>
          <span>创建: {formatTimestamp(task.createdAt)}</span>
          {task.completedAt && <span>完成: {formatTimestamp(task.completedAt)}</span>}
          <span>更新: {formatTimestamp(task.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}
