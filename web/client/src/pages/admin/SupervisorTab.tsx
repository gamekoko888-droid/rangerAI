/**
 * SupervisorTab — Admin Dashboard tab for viewing Supervisor autonomous tasks.
 * Shows task list, stats overview, and per-task step detail with decision audit trail.
 * 
 * @version 1.0.0
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { getAuthToken } from '../../lib/api';
import {
  Loader2, AlertTriangle, RefreshCw, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Clock, Zap, RotateCcw, Ban, Timer,
  Brain, ArrowRight, GitBranch, Eye, X as XIcon,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────
interface SupervisorStep {
  id: string;
  taskId: string;
  stepNum: number;
  instruction: string;
  status: string;
  result: string | null;
  error: string | null;
  retryCount: number;
  supervisorDecision: {
    decision: string;
    step?: string;
    answer?: string;
    reason?: string;
  } | null;
  duration: number | null;
  createdAt: number;
  updatedAt: number;
}

interface SupervisorTask {
  id: string;
  chatId: string;
  userId: string;
  title: string;
  goal: string;
  status: string;
  currentStepNum: number;
  totalSteps: number;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  steps?: SupervisorStep[];
}

interface SupervisorStats {
  total: number;
  byStatus: Record<string, number>;
  avgSteps: number;
  avgDurationMs: number;
  recentTasks: Array<{
    id: string;
    title: string;
    status: string;
    totalSteps: number;
    createdAt: number;
    completedAt: number | null;
    duration: number | null;
  }>;
}

// ─── Helpers ────────────────────────────────────────────────
async function fetchSupervisor(url: string, options?: RequestInit) {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers }, credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  pending:   { icon: Clock,        color: 'text-zinc-400',  label: '等待中' },
  running:   { icon: Zap,          color: 'text-blue-400',  label: '运行中' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400', label: '已完成' },
  failed:    { icon: XCircle,      color: 'text-red-400',   label: '失败' },
  cancelled: { icon: Ban,          color: 'text-zinc-500',  label: '已取消' },
  timeout:   { icon: Timer,        color: 'text-amber-400', label: '超时' },
};

const DECISION_CONFIG: Record<string, { color: string; label: string }> = {
  next:   { color: 'text-blue-400',    label: 'NEXT' },
  retry:  { color: 'text-amber-400',   label: 'RETRY' },
  finish: { color: 'text-emerald-400', label: 'FINISH' },
  error:  { color: 'text-red-400',     label: 'ERROR' },
};

// ─── Stats Cards ────────────────────────────────────────────
function StatsOverview({ stats }: { stats: SupervisorStats }) {
  const cards = [
    { label: '总任务数', value: stats.total, color: 'from-blue-500/20 to-blue-600/10', textColor: 'text-blue-300' },
    { label: '已完成', value: stats.byStatus['completed'] || 0, color: 'from-emerald-500/20 to-emerald-600/10', textColor: 'text-emerald-300' },
    { label: '失败/超时', value: (stats.byStatus['failed'] || 0) + (stats.byStatus['timeout'] || 0), color: 'from-red-500/20 to-red-600/10', textColor: 'text-red-300' },
    { label: '平均步骤', value: stats.avgSteps, color: 'from-purple-500/20 to-purple-600/10', textColor: 'text-purple-300' },
    { label: '平均耗时', value: formatDuration(stats.avgDurationMs), color: 'from-amber-500/20 to-amber-600/10', textColor: 'text-amber-300' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {cards.map((c, i) => (
        <div key={i} className={`bg-gradient-to-br ${c.color} border border-white/5 rounded-xl p-4`}>
          <p className="text-xs text-zinc-400 mb-1">{c.label}</p>
          <p className={`text-xl font-bold tabular-nums ${c.textColor}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Step Detail Row ────────────────────────────────────────
function StepRow({ step }: { step: SupervisorStep }) {
  const [expanded, setExpanded] = useState(false);
  const sc = STATUS_CONFIG[step.status] || STATUS_CONFIG.pending;
  const StatusIcon = sc.icon;
  const dc = step.supervisorDecision ? DECISION_CONFIG[step.supervisorDecision.decision] : null;

  const isTerminal = step.instruction.startsWith('[FINISH]') || step.instruction.startsWith('[ERROR]');

  return (
    <div className={`border-l-2 ${step.status === 'completed' ? 'border-emerald-500/50' : step.status === 'failed' ? 'border-red-500/50' : 'border-zinc-600/50'} ml-3 pl-4 py-2`}>
      <div
        className="flex items-center gap-2 cursor-pointer hover:bg-white/5 rounded-lg px-2 py-1 -mx-2 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}
        <StatusIcon size={14} className={`${sc.color} shrink-0`} />
        <span className="text-xs text-zinc-500 font-mono shrink-0">#{step.stepNum}</span>
        {dc && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${dc.color} bg-white/5`}>
            {dc.label}
          </span>
        )}
        {step.retryCount > 0 && (
          <span className="text-[10px] text-amber-400 flex items-center gap-0.5">
            <RotateCcw size={10} /> x{step.retryCount}
          </span>
        )}
        <span className={`text-sm truncate ${isTerminal ? 'italic text-zinc-400' : 'text-zinc-200'}`}>
          {step.instruction.substring(0, 120)}
        </span>
        <span className="ml-auto text-xs text-zinc-500 tabular-nums shrink-0">
          {formatDuration(step.duration)}
        </span>
      </div>

      {expanded && (
        <div className="mt-2 ml-5 space-y-2">
          {/* Full instruction */}
          <div className="bg-zinc-800/50 rounded-lg p-3">
            <p className="text-xs text-zinc-400 mb-1 font-medium">指令</p>
            <p className="text-sm text-zinc-200 whitespace-pre-wrap">{step.instruction}</p>
          </div>

          {/* Supervisor Decision JSON */}
          {step.supervisorDecision && (
            <div className="bg-zinc-800/50 rounded-lg p-3">
              <p className="text-xs text-zinc-400 mb-1 font-medium flex items-center gap-1">
                <Brain size={12} /> Supervisor 决策原文
              </p>
              <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap overflow-x-auto">
                {JSON.stringify(step.supervisorDecision, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {step.result && (
            <div className="bg-zinc-800/50 rounded-lg p-3">
              <p className="text-xs text-zinc-400 mb-1 font-medium">执行结果</p>
              <p className="text-sm text-zinc-300 whitespace-pre-wrap max-h-40 overflow-y-auto">
                {step.result.length > 1000 ? step.result.substring(0, 1000) + '...' : step.result}
              </p>
            </div>
          )}

          {/* Error */}
          {step.error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs text-red-400 mb-1 font-medium">错误</p>
              <p className="text-sm text-red-300 whitespace-pre-wrap">{step.error}</p>
            </div>
          )}

          {/* Metadata */}
          <div className="flex gap-4 text-xs text-zinc-500">
            <span>创建: {formatTime(step.createdAt)}</span>
            {step.duration && <span>耗时: {formatDuration(step.duration)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Task Detail Modal ──────────────────────────────────────
function TaskDetailModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<SupervisorTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSupervisor(`/api/supervisor/tasks/${taskId}`);
      setTask(res.task);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { fetchDetail(); }, [fetchDetail]);

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await fetchSupervisor(`/api/supervisor/tasks/${taskId}/cancel`, { method: 'POST' });
      await fetchDetail();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  };

  const sc = task ? (STATUS_CONFIG[task.status] || STATUS_CONFIG.pending) : STATUS_CONFIG.pending;
  const StatusIcon = sc.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-3 min-w-0">
            <Brain size={20} className="text-blue-400 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-zinc-100 truncate">
                {task?.title || taskId}
              </h3>
              <p className="text-xs text-zinc-500 font-mono">{taskId}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {task && task.status === 'running' && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
              >
                {cancelling ? <Loader2 size={12} className="animate-spin" /> : '取消任务'}
              </button>
            )}
            <button onClick={fetchDetail} className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors">
              <RefreshCw size={14} className="text-zinc-400" />
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors">
              <XIcon size={14} className="text-zinc-400" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto max-h-[calc(85vh-64px)] px-6 py-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin text-zinc-500" size={24} />
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
              <AlertTriangle size={18} className="text-red-400 shrink-0" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {task && !loading && (
            <div className="space-y-4">
              {/* Task Info */}
              <div className="bg-zinc-800/50 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <StatusIcon size={16} className={sc.color} />
                  <span className={`text-sm font-medium ${sc.color}`}>{sc.label}</span>
                  <span className="text-xs text-zinc-500 ml-auto">
                    {formatTime(task.createdAt)}
                    {task.completedAt && ` → ${formatTime(task.completedAt)}`}
                  </span>
                </div>
                <div>
                  <p className="text-xs text-zinc-400 mb-1">目标</p>
                  <p className="text-sm text-zinc-200">{task.goal}</p>
                </div>
                <div className="flex gap-6 text-xs text-zinc-400">
                  <span>步骤: {task.currentStepNum}/{task.totalSteps}</span>
                  {task.completedAt && (
                    <span>总耗时: {formatDuration(task.completedAt - task.createdAt)}</span>
                  )}
                </div>
                {task.result && (
                  <div>
                    <p className="text-xs text-zinc-400 mb-1">最终结果</p>
                    <p className="text-sm text-zinc-300 whitespace-pre-wrap max-h-32 overflow-y-auto bg-zinc-900/50 rounded-lg p-2">
                      {task.result.length > 2000 ? task.result.substring(0, 2000) + '...' : task.result}
                    </p>
                  </div>
                )}
                {task.error && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2">
                    <p className="text-xs text-red-400 mb-1">错误</p>
                    <p className="text-sm text-red-300">{task.error}</p>
                  </div>
                )}
              </div>

              {/* Steps Timeline */}
              <div>
                <h4 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                  <GitBranch size={14} className="text-zinc-500" />
                  步骤决策链 ({task.steps?.length || 0} 步)
                </h4>
                {task.steps && task.steps.length > 0 ? (
                  <div className="space-y-0">
                    {task.steps.map(step => (
                      <StepRow key={step.id} step={step} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500 text-center py-6">暂无步骤记录</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Tab Component ─────────────────────────────────────
export default function SupervisorTab() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<SupervisorTask[]>([]);
  const [stats, setStats] = useState<SupervisorStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tasksRes, statsRes] = await Promise.all([
        fetchSupervisor('/api/supervisor/tasks?limit=50'),
        fetchSupervisor('/api/supervisor/stats'),
      ]);
      setTasks(tasksRes.tasks || []);
      setStats(statsRes.stats || null);
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filteredTasks = statusFilter === 'all'
    ? tasks
    : tasks.filter(t => t.status === statusFilter);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="animate-spin text-zinc-500" size={24} />
    </div>
  );

  if (error) return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
      <AlertTriangle size={18} className="text-red-400 shrink-0" />
      <p className="text-sm text-red-300">{error}</p>
      <button onClick={fetchData} className="ml-auto text-xs text-blue-400 hover:text-blue-300">
        重试
      </button>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain size={20} className="text-blue-400" />
          <h2 className="text-lg font-semibold text-zinc-100">Supervisor 自主任务</h2>
          <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full">
            {tasks.length} 个任务
          </span>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-lg transition-colors"
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      {/* Stats */}
      {stats && <StatsOverview stats={stats} />}

      {/* Filter */}
      <div className="flex items-center gap-2">
        {['all', 'running', 'completed', 'failed', 'timeout', 'cancelled'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
              statusFilter === s
                ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-transparent'
            }`}
          >
            {s === 'all' ? '全部' : (STATUS_CONFIG[s]?.label || s)}
            {s !== 'all' && stats?.byStatus[s] ? ` (${stats.byStatus[s]})` : ''}
          </button>
        ))}
      </div>

      {/* Task List */}
      {filteredTasks.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          <Brain size={48} className="mx-auto mb-4 opacity-20" />
          <p>暂无 Supervisor 任务记录</p>
          <p className="text-xs mt-1">当用户提交自主任务时，Supervisor 引擎将自动创建任务并在此显示</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredTasks.map(task => {
            const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
            const StatusIcon = sc.icon;
            const duration = task.completedAt ? task.completedAt - task.createdAt : (task.status === 'running' ? Date.now() - task.createdAt : null);

            return (
              <div
                key={task.id}
                onClick={() => setSelectedTaskId(task.id)}
                className="bg-zinc-800/40 hover:bg-zinc-800/70 border border-zinc-700/50 rounded-xl p-4 cursor-pointer transition-all group"
              >
                <div className="flex items-center gap-3">
                  <StatusIcon size={16} className={`${sc.color} shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-zinc-200 truncate">{task.title}</h3>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${sc.color} bg-white/5`}>
                        {sc.label}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500 truncate mt-0.5">{task.goal}</p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-zinc-500 shrink-0">
                    <span className="tabular-nums">{task.totalSteps} 步</span>
                    <span className="tabular-nums">{formatDuration(duration)}</span>
                    <span>{formatTime(task.createdAt)}</span>
                    <Eye size={14} className="text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedTaskId && (
        <TaskDetailModal
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
