/**
 * TaskReplayTab — R22-T3 Task-level Replay Panel
 * 
 * Provides a timeline-based replay view for any task:
 * - Select a task from recent list or enter taskId
 * - View timeline events with evidenceRef links
 * - See plan steps, browser actions, failure records
 * - 30-second readability: can answer "what did the task do, where did it stall, what was the result"
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { fetchAdmin } from './shared';
import {
  PlayCircle, Search, Clock, CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, ChevronRight, Eye, Globe, Loader2, RefreshCw,
  ArrowRight, ExternalLink, Image as ImageIcon,
} from 'lucide-react';

interface TimelineEvent {
  ts: string;
  type: string;
  label: string;
  detail?: string;
  status?: string;
  evidenceRef?: string;
}

interface PlanStep {
  index: number;
  action: string;
  status: string;
  expectedTools?: string[];
}

interface FailureRecord {
  ts: string;
  failureType: string;
  category: string;
  severity: string;
  detail: string;
  fallbackAction?: string;
}

interface ReplayData {
  taskId: string;
  taskFamily: string;
  routingReason: string;
  selectedPrimaryTool: string;
  finalStatus: string;
  finalOutput?: string;
  browserActions: number;
  browserEvidence: number;
  timeline: TimelineEvent[];
  plan: { goal?: string; steps: PlanStep[] };
  failureRecords: FailureRecord[];
  traceSpans: any[];
  supervisorReviews: any[];
  supervisorDecisions: any[];
}

interface TaskSummary {
  msg_id: string;
  session_key: string;
  status: string;
  goal: string;
  step_count: number;
  steps_completed: number;
  created_at: string;
  updated_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  success: 'text-emerald-400',
  completed: 'text-emerald-400',
  degraded_success: 'text-amber-400',
  failed: 'text-red-400',
  active: 'text-blue-400',
  unknown: 'text-zinc-400',
};

const STATUS_ICONS: Record<string, React.ElementType> = {
  success: CheckCircle2,
  completed: CheckCircle2,
  degraded_success: AlertTriangle,
  failed: XCircle,
  active: Loader2,
};

const FAMILY_LABELS: Record<string, string> = {
  page_lookup: '🌐 页面查找',
  page_extract: '📄 页面提取',
  site_navigation: '🧭 站点导航',
  web_verification: '✅ 网页验证',
  unknown: '❓ 未分类',
};

export default function TaskReplayTab() {
  const { t } = useI18n();
  const [taskList, setTaskList] = useState<TaskSummary[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['timeline', 'plan']));

  // Load recent task list
  useEffect(() => {
    (async () => {
      try {
        const data = await fetchAdmin('/api/admin/task-trace');
        if (data.tasks) {
          setTaskList(data.tasks.slice(0, 30));
        }
      } catch (e) {
        console.error('Failed to load task list:', e);
      } finally {
        setListLoading(false);
      }
    })();
  }, []);

  const loadReplay = useCallback(async (taskId: string) => {
    if (!taskId) return;
    setLoading(true);
    setSelectedTaskId(taskId);
    try {
      const data = await fetchAdmin(`/api/admin/task-replay?taskId=${encodeURIComponent(taskId)}`);
      setReplay(data);
    } catch (e: any) {
      console.error('Failed to load replay:', e);
      setReplay(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  };

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch { return ts; }
  };

  const SectionHeader = ({ id, title, count, icon: Icon }: { id: string; title: string; count?: number; icon: React.ElementType }) => (
    <button
      onClick={() => toggleSection(id)}
      className="w-full flex items-center gap-2 py-2 px-3 bg-zinc-800/50 rounded-lg hover:bg-zinc-800 transition-colors"
    >
      {expandedSections.has(id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <Icon size={14} className="text-blue-400" />
      <span className="text-sm font-medium">{title}</span>
      {count !== undefined && <span className="ml-auto text-xs text-zinc-500">{count}</span>}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PlayCircle size={20} className="text-blue-400" />
          <h2 className="text-lg font-semibold">Task Replay</h2>
          <span className="text-xs text-zinc-500">R22-T3</span>
        </div>
      </div>

      {/* Search Bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadReplay(searchInput)}
            placeholder="输入 taskId 或从列表选择..."
            className="w-full pl-9 pr-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <button
          onClick={() => loadReplay(searchInput)}
          disabled={!searchInput || loading}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : '回放'}
        </button>
      </div>

      {/* Task List (collapsible) */}
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
        <SectionHeader id="task-list" title="最近任务" count={taskList.length} icon={Clock} />
        {expandedSections.has('task-list') && (
          <div className="max-h-48 overflow-y-auto">
            {listLoading ? (
              <div className="p-4 text-center"><Loader2 size={16} className="animate-spin mx-auto text-zinc-500" /></div>
            ) : taskList.length === 0 ? (
              <div className="p-4 text-center text-zinc-500 text-sm">暂无任务记录</div>
            ) : (
              taskList.map(task => (
                <button
                  key={task.msg_id}
                  onClick={() => { setSearchInput(task.msg_id); loadReplay(task.msg_id); }}
                  className={`w-full text-left px-3 py-2 hover:bg-zinc-800/50 border-b border-zinc-800/30 transition-colors ${selectedTaskId === task.msg_id ? 'bg-blue-900/20 border-l-2 border-l-blue-500' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${STATUS_COLORS[task.status] || 'text-zinc-400'}`}>{task.status}</span>
                    <span className="text-xs text-zinc-500 truncate flex-1">{task.goal?.slice(0, 60) || task.msg_id}</span>
                    <span className="text-[10px] text-zinc-600">{task.steps_completed}/{task.step_count}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Replay Content */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-blue-400" />
          <span className="ml-2 text-zinc-400">加载回放数据...</span>
        </div>
      )}

      {replay && !loading && (
        <div className="space-y-3">
          {/* Task Summary Card */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  {(() => { const Icon = STATUS_ICONS[replay.finalStatus] || AlertTriangle; return <Icon size={16} className={STATUS_COLORS[replay.finalStatus] || 'text-zinc-400'} />; })()}
                  <span className={`text-sm font-semibold ${STATUS_COLORS[replay.finalStatus] || 'text-zinc-400'}`}>
                    {replay.finalStatus?.toUpperCase()}
                  </span>
                  <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded-full text-zinc-400">
                    {FAMILY_LABELS[replay.taskFamily] || replay.taskFamily}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 font-mono">{replay.taskId}</p>
              </div>
              <div className="text-right text-xs text-zinc-500">
                <div>Browser: {replay.browserActions} actions / {replay.browserEvidence} evidence</div>
                {replay.routingReason && <div className="mt-1">Routing: {replay.routingReason}</div>}
                {replay.selectedPrimaryTool && <div>Tool: {replay.selectedPrimaryTool}</div>}
              </div>
            </div>
            {replay.plan?.goal && (
              <div className="text-sm text-zinc-300 bg-zinc-800/50 rounded p-2 mb-2">
                <span className="text-zinc-500 text-xs">Goal: </span>{replay.plan.goal}
              </div>
            )}
            {replay.finalOutput && (
              <div className="text-sm text-zinc-300 bg-emerald-900/20 border border-emerald-800/30 rounded p-2">
                <span className="text-emerald-500 text-xs">Output: </span>{replay.finalOutput}
              </div>
            )}
          </div>

          {/* Timeline */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
            <SectionHeader id="timeline" title="时间线" count={replay.timeline.length} icon={Clock} />
            {expandedSections.has('timeline') && (
              <div className="p-3 space-y-1">
                {replay.timeline.length === 0 ? (
                  <div className="text-center text-zinc-500 text-sm py-4">无时间线事件</div>
                ) : (
                  replay.timeline.map((evt, i) => (
                    <div key={i} className="flex items-start gap-2 py-1.5 border-b border-zinc-800/30 last:border-0">
                      <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{
                        backgroundColor: evt.status === 'success' ? '#34d399' : evt.status === 'degraded_success' ? '#fbbf24' : evt.status === 'failed' ? '#f87171' : '#71717a'
                      }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-zinc-600 font-mono">{formatTime(evt.ts)}</span>
                          <span className="text-xs px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400">{evt.type}</span>
                          {evt.status && evt.status !== 'success' && (
                            <span className={`text-[10px] ${STATUS_COLORS[evt.status] || 'text-zinc-500'}`}>{evt.status}</span>
                          )}
                        </div>
                        <p className="text-sm text-zinc-300 mt-0.5">{evt.label}</p>
                        {evt.detail && <p className="text-xs text-zinc-500 mt-0.5 truncate">{evt.detail}</p>}
                        {evt.evidenceRef && (
                          <a
                            href={evt.evidenceRef}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mt-0.5"
                          >
                            <ExternalLink size={10} /> 查看证据
                          </a>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Plan Steps */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
            <SectionHeader id="plan" title="执行计划" count={replay.plan?.steps?.length || 0} icon={ArrowRight} />
            {expandedSections.has('plan') && (
              <div className="p-3">
                {(!replay.plan?.steps || replay.plan.steps.length === 0) ? (
                  <div className="text-center text-zinc-500 text-sm py-4">无计划步骤</div>
                ) : (
                  <div className="space-y-1">
                    {replay.plan.steps.map((step, i) => (
                      <div key={i} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-zinc-800/30">
                        <span className="text-[10px] text-zinc-600 w-5 text-right">{step.index ?? i + 1}</span>
                        <span className={`w-1.5 h-1.5 rounded-full ${step.status === 'done' ? 'bg-emerald-400' : step.status === 'active' ? 'bg-blue-400' : 'bg-zinc-600'}`} />
                        <span className="text-sm text-zinc-300 flex-1">{step.action}</span>
                        {step.expectedTools && step.expectedTools.length > 0 && (
                          <span className="text-[10px] text-zinc-500">{step.expectedTools.join(', ')}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Failure Records */}
          {replay.failureRecords.length > 0 && (
            <div className="bg-zinc-900/50 border border-red-900/30 rounded-lg overflow-hidden">
              <SectionHeader id="failures" title="失败记录" count={replay.failureRecords.length} icon={XCircle} />
              {expandedSections.has('failures') && (
                <div className="p-3 space-y-2">
                  {replay.failureRecords.map((f, i) => (
                    <div key={i} className="bg-red-900/10 border border-red-800/20 rounded p-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-zinc-600 font-mono">{formatTime(f.ts)}</span>
                        <span className="text-xs px-1.5 py-0.5 bg-red-900/30 rounded text-red-400">{f.failureType}</span>
                        <span className="text-xs text-zinc-500">{f.category}</span>
                        <span className={`text-[10px] ${f.severity === 'high' ? 'text-red-400' : f.severity === 'medium' ? 'text-amber-400' : 'text-zinc-400'}`}>
                          {f.severity}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-300">{f.detail}</p>
                      {f.fallbackAction && (
                        <p className="text-xs text-amber-400 mt-1">Fallback: {f.fallbackAction}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Supervisor Decisions */}
          {(replay.supervisorReviews.length > 0 || replay.supervisorDecisions.length > 0) && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
              <SectionHeader id="supervisor" title="Supervisor 决策" count={replay.supervisorReviews.length + replay.supervisorDecisions.length} icon={Eye} />
              {expandedSections.has('supervisor') && (
                <div className="p-3 text-sm text-zinc-400">
                  <div>Reviews: {replay.supervisorReviews.length}</div>
                  <div>Decisions: {replay.supervisorDecisions.length}</div>
                  {replay.supervisorDecisions.map((d: any, i: number) => (
                    <div key={i} className="mt-2 bg-zinc-800/50 rounded p-2">
                      <pre className="text-xs overflow-x-auto">{JSON.stringify(d, null, 2)}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Trace Spans */}
          {replay.traceSpans.length > 0 && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden">
              <SectionHeader id="traces" title="Trace Spans" count={replay.traceSpans.length} icon={Globe} />
              {expandedSections.has('traces') && (
                <div className="p-3">
                  {replay.traceSpans.map((span: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 py-1 text-sm">
                      <span className="text-[10px] text-zinc-600 font-mono">{formatTime(span.ts || span.created_at)}</span>
                      <span className="text-xs px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-400">{span.span_type || span.event_type}</span>
                      <span className="text-zinc-300 flex-1 truncate">{span.label || span.payload?.slice(0, 80)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!replay && !loading && (
        <div className="text-center py-12 text-zinc-500">
          <PlayCircle size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">选择一个任务或输入 taskId 开始回放</p>
          <p className="text-xs mt-1">30 秒内可回答：任务做了什么、卡在哪、结果是什么</p>
        </div>
      )}
    </div>
  );
}
