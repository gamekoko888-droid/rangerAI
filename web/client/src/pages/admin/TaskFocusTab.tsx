/**
 * TaskFocusTab — R18-T4: Task Focus / Todo Anchor MVP.
 * Shows active task focuses with progress, goals, and next actions.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchAdmin } from './shared';
import {
  Loader2, RefreshCw, Target, CheckCircle2, XCircle,
  AlertTriangle, Clock, ArrowRight, Activity,
  Crosshair, ListTodo,
} from 'lucide-react';
import { logger } from '../../lib/logger';

// ─── Types ──────────────────────────────────────────────────
interface TaskFocus {
  id: number;
  sessionId: string;
  taskId: string | null;
  title: string;
  currentGoal: string;
  nextAction: string;
  status: string; // 'active' | 'completed' | 'failed'
  stepCount: number;
  stepsCompleted: number;
  updatedAt: string;
  createdAt: string;
  interruptedAt?: string;
  resumedAt?: string;
  interruptReason?: string;
}

interface TaskFocusSummary {
  total: number;
  active: number;
  interrupted: number;
  completed: number;
  failed: number;
}

// ─── Helpers ────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { color: string; icon: React.ElementType; label: string }> = {
  active: { color: 'text-blue-400 bg-blue-500/20 border-blue-500/30', icon: Activity, label: 'Active' },
  interrupted: { color: 'text-amber-400 bg-amber-500/20 border-amber-500/30', icon: AlertTriangle, label: 'Interrupted' },
  completed: { color: 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30', icon: CheckCircle2, label: 'Completed' },
  failed: { color: 'text-red-400 bg-red-500/20 border-red-500/30', icon: XCircle, label: 'Failed' },
};

function ProgressRing({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  return (
    <div className="relative w-12 h-12 flex items-center justify-center">
      <svg className="w-12 h-12 -rotate-90" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={radius} fill="none" stroke="currentColor" className="text-zinc-700" strokeWidth="3" />
        <circle cx="22" cy="22" r={radius} fill="none" stroke="currentColor"
          className={pct === 100 ? 'text-emerald-400' : 'text-blue-400'}
          strokeWidth="3" strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      <span className="absolute text-[10px] font-bold text-zinc-300">{pct}%</span>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────
export default function TaskFocusTab() {
  const [focuses, setFocuses] = useState<TaskFocus[]>([]);
  const [summary, setSummary] = useState<TaskFocusSummary>({ total: 0, active: 0, interrupted: 0, completed: 0, failed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
  const [timelineId, setTimelineId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [tlLoading, setTlLoading] = useState(false);

  const toggleTimeline = async (id: number) => {
    if (timelineId === id) { setTimelineId(null); setTimeline([]); return; }
    setTimelineId(id);
    setTlLoading(true);
    try {
      const data = await fetchAdmin(`/api/admin/task-focus/${id}/timeline`);
      setTimeline(data.ok ? (data.events || []) : []);
    } catch { setTimeline([]); }
    setTlLoading(false);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
      const data = await fetchAdmin(`/api/admin/task-focus${params}`);
      setFocuses(data.focuses || []);
      setSummary(data.summary || { total: 0, active: 0, interrupted: 0, completed: 0, failed: 0 });
    } catch (e: any) {
      logger.error('TaskFocusTab load error:', e);
      setError(e.message || 'Failed to load task focus data');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
        <span className="ml-2 text-zinc-400">Loading task focus...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400">
        <AlertTriangle className="w-5 h-5 inline mr-2" />
        {error}
        <button onClick={load} className="ml-4 text-blue-400 hover:text-blue-300 text-sm">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Task Focus / Todo Anchor</h2>
          <p className="text-sm text-zinc-500 mt-1">R18-T4: 任务焦点追踪 — 实时展示当前任务目标与进度</p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4 cursor-pointer hover:border-zinc-600/50 transition-colors"
          onClick={() => setStatusFilter('all')}>
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <ListTodo className="w-4 h-4" /> Total
          </div>
          <div className="text-xl font-bold text-zinc-100">{summary.total}</div>
        </div>
        <div className={`bg-zinc-800/50 border rounded-xl p-4 cursor-pointer transition-colors ${
          statusFilter === 'active' ? 'border-blue-500/50' : 'border-zinc-700/50 hover:border-zinc-600/50'
        }`} onClick={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')}>
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <Activity className="w-4 h-4" /> Active
          </div>
          <div className="text-xl font-bold text-blue-400">{summary.active}</div>
        </div>
        <div className={`bg-zinc-800/50 border rounded-xl p-4 cursor-pointer transition-colors ${
          statusFilter === 'completed' ? 'border-emerald-500/50' : 'border-zinc-700/50 hover:border-zinc-600/50'
        }`} onClick={() => setStatusFilter(statusFilter === 'completed' ? 'all' : 'completed')}>
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <CheckCircle2 className="w-4 h-4" /> Completed
          </div>
          <div className="text-xl font-bold text-emerald-400">{summary.completed}</div>
        </div>
        <div className={`bg-zinc-800/50 border rounded-xl p-4 cursor-pointer transition-colors ${
          statusFilter === 'failed' ? 'border-red-500/50' : 'border-zinc-700/50 hover:border-zinc-600/50'
        }`} onClick={() => setStatusFilter(statusFilter === 'failed' ? 'all' : 'failed')}>
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <XCircle className="w-4 h-4" /> Failed
          </div>
          <div className="text-xl font-bold text-red-400">{summary.failed}</div>
        </div>
      </div>

      {/* Focus Cards */}
      {focuses.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <Crosshair className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No task focus entries found</p>
          <p className="text-xs mt-1">Task focus is updated when plans are generated or steps complete</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* [R20-T4] Recovery Prompt Card */}
      {focuses.filter(f => f.status === 'interrupted').length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-amber-300">Interrupted Tasks Detected</h3>
              <p className="text-xs text-amber-400/70 mt-1">
                {focuses.filter(f => f.status === 'interrupted').length} task(s) were interrupted. 
                They will auto-resume when the user sends a new message in the same session.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {focuses.filter(f => f.status === 'interrupted').map(f => (
              <div key={`recovery-${f.id}`} className="flex items-center gap-2 text-xs bg-amber-500/5 rounded-lg px-3 py-2">
                <Crosshair className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-zinc-300 font-mono">{f.sessionId.substring(0, 20)}...</span>
                <ArrowRight className="w-3 h-3 text-zinc-500" />
                <span className="text-zinc-400 truncate">{f.currentGoal || 'No goal set'}</span>
                {f.interruptReason && <span className="text-amber-500/60 ml-auto">({f.interruptReason})</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {focuses.map((focus) => {
            const statusCfg = STATUS_CONFIG[focus.status] || STATUS_CONFIG.active;
            const StatusIcon = statusCfg.icon;
            return (
              <div key={focus.id} className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5 hover:border-zinc-600/50 transition-colors">
                <div className="flex items-start gap-4">
                  {/* Progress Ring */}
                  <ProgressRing completed={focus.stepsCompleted} total={focus.stepCount} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-sm font-semibold text-zinc-100 truncate">{focus.title}</h3>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${statusCfg.color}`}>
                        <StatusIcon className="w-3 h-3" /> {statusCfg.label}
                      </span>
                    </div>

                    {/* Current Goal */}
                    <div className="flex items-start gap-2 mb-2">
                      <Target className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs text-zinc-500">Current Goal</div>
                        <div className="text-sm text-zinc-300">{focus.currentGoal}</div>
                      </div>
                    </div>

                    {/* Next Action */}
                    <div className="flex items-start gap-2 mb-3">
                      <ArrowRight className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
                      <div>
                        <div className="text-xs text-zinc-500">Next Action</div>
                        <div className="text-sm text-zinc-300">{focus.nextAction}</div>
                      </div>
                    </div>

                    {/* Meta */}
                    <div className="flex items-center gap-4 text-xs text-zinc-500">
                      <span className="font-mono">{focus.stepsCompleted}/{focus.stepCount} steps</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Updated: {focus.updatedAt}</span>
                      {focus.taskId && <span className="font-mono">Task: {focus.taskId}</span>}
                      {focus.interruptedAt && <span className="text-amber-400">Interrupted: {focus.interruptedAt}</span>}
                      {focus.resumedAt && <span className="text-blue-400">Resumed: {focus.resumedAt}</span>}
                    </div>
                    <button onClick={() => toggleTimeline(focus.id)} className="mt-2 px-3 py-1 bg-zinc-700/50 hover:bg-zinc-700 border border-zinc-600/50 rounded text-xs text-zinc-400 transition-colors">
                      {timelineId === focus.id ? 'Hide Timeline' : 'Show Timeline'}
                    </button>
                    {timelineId === focus.id && (
                      <div className="mt-3 border-t border-zinc-700/30 pt-3">
                        {tlLoading ? <div className="text-xs text-zinc-500">Loading timeline...</div> : timeline.length === 0 ? <div className="text-xs text-zinc-500">No timeline events</div> : (
                          <div className="space-y-2">
                            {timeline.map((evt: any, i: number) => (
                              <div key={i} className="flex items-center gap-3 text-xs">
                                <div className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                                <span className="text-zinc-500 w-36">{evt.created_at}</span>
                                <span className="text-zinc-400">{evt.from_status || '—'}</span>
                                <ArrowRight className="w-3 h-3 text-zinc-600" />
                                <span className="text-zinc-200 font-medium">{evt.to_status}</span>
                                {evt.reason && <span className="text-zinc-500 italic">({evt.reason})</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
