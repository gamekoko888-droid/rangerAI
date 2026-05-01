/**
 * TaskQueue — Autonomous Task Queue with Supervisor Step Details
 * v2.0 Iter-S4: Fetches real autonomous tasks + supervisor step details
 */
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../lib/i18n';
import { PageLoadingSkeleton } from '../components/PageLoadingSkeleton';

type TranslationFn = (key: any) => string;
import { useLocation } from 'wouter';
import {
  ArrowLeft, ListTodo, Clock, CheckCircle2, XCircle, Loader2,
  RefreshCw, Target, ChevronDown, ChevronRight, Zap,
  AlertTriangle, RotateCcw, Pause, ExternalLink,
  Eye, Users, BarChart2, FileText, Globe, Newspaper, Sparkles, Send, X,
} from 'lucide-react';
import { logger } from "../lib/logger";

interface AutonomousTask {
  id: string;
  userId: string;
  type: string;
  title: string;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  progress: number;
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  duration: number | null;
  steps?: { stepNumber: number; title: string; status: string }[];
}

interface SupervisorTask {
  id: string;
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
  metadata: any;
  steps: SupervisorStep[];
}

interface SupervisorStep {
  id: string;
  taskId: string;
  stepNum: number;
  instruction: string;
  status: string;
  result: string | null;
  error: string | null;
  retryCount: number;
  supervisorDecision: string | null;
  duration: number | null;
  createdAt: number;
  updatedAt: number;
}

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('rangerai_token');
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function getRelativeTime(dateStr: string | number): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function getStatusConfig(status: string) {
  switch (status) {
    case 'running':
      return { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, color: 'text-blue-400 bg-blue-400/10 border-blue-400/20', label: '运行中' };
    case 'completed':
      return { icon: <CheckCircle2 className="w-3.5 h-3.5" />, color: 'text-green-400 bg-green-400/10 border-green-400/20', label: '已完成' };
    case 'failed':
      return { icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-red-400 bg-red-400/10 border-red-400/20', label: '失败' };
    case 'queued':
      return { icon: <Clock className="w-3.5 h-3.5" />, color: 'text-amber-400 bg-amber-400/10 border-amber-400/20', label: '排队中' };
    case 'cancelled':
      return { icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20', label: '已取消' };
    case 'timeout':
      return { icon: <AlertTriangle className="w-3.5 h-3.5" />, color: 'text-amber-400 bg-amber-400/10 border-amber-400/20', label: '超时' };
    default:
      return { icon: <Clock className="w-3.5 h-3.5" />, color: 'text-white/40 bg-white/5 border-white/10', label: status };
  }
}

export default function TaskQueue() {
  const { t, locale } = useI18n();
  const dateLoc = locale === 'en' ? 'en-US' : locale === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  const [, setLocation] = useLocation();
  const [tasks, setTasks] = useState<AutonomousTask[]>([]);
  const [supervisorTasks, setSupervisorTasks] = useState<SupervisorTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [supervisorDetails, setSupervisorDetails] = useState<Record<string, SupervisorTask>>({});
  // S11 P2: Task templates
  interface TaskTemplate { id: string; name: string; description: string; category: string; icon: string; prompt: string; params: any[]; }
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TaskTemplate | null>(null);
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateDesc, setTemplateDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      // Fetch real autonomous tasks
      const atRes = await fetchWithAuth('/api/autonomous-tasks');
      if (atRes.ok) {
        const atData = await atRes.json();
        setTasks(Array.isArray(atData) ? atData : atData.tasks || []);
      }
      // Fetch supervisor tasks
      const svRes = await fetchWithAuth('/api/supervisor/tasks');
      if (svRes.ok) {
        const svData = await svRes.json();
        setSupervisorTasks(Array.isArray(svData) ? svData : svData.tasks || []);
      }
    } catch (err) {
      logger.error('Failed to load tasks:', err);
      toast.error(t('taskQueue.loadError'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSupervisorDetail = useCallback(async (taskId: string) => {
    try {
      const svTask = supervisorTasks.find(sv => {
        try {
          const meta = typeof sv.metadata === 'string' ? JSON.parse(sv.metadata) : sv.metadata;
          return meta?.legacyTaskId === taskId || meta?.autonomousTaskId === taskId;
        } catch { return false; }
      });
      if (svTask) {
        const res = await fetchWithAuth(`/api/supervisor/tasks/${svTask.id}`);
        if (res.ok) {
          const detail = await res.json();
          setSupervisorDetails(prev => ({ ...prev, [taskId]: detail }));
        }
      }
    } catch (err) {
      logger.error('Failed to load supervisor detail:', err);
    }
  }, [supervisorTasks]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  // S11 P2: Load task templates
  useEffect(() => {
    fetchWithAuth('/api/task-templates')
      .then(r => r.ok ? r.json() : { templates: [] })
      .then(d => setTemplates(d.templates || []))
      .catch(() => {});
  }, []);

  const templateIcons: Record<string, React.ReactNode> = {
    eye: <Eye className="w-4 h-4" />,
    users: <Users className="w-4 h-4" />,
    'bar-chart-2': <BarChart2 className="w-4 h-4" />,
    'file-text': <FileText className="w-4 h-4" />,
    globe: <Globe className="w-4 h-4" />,
    newspaper: <Newspaper className="w-4 h-4" />,
    zap: <Zap className="w-4 h-4" />,
  };

  const handleTemplateSubmit = async () => {
    if (!selectedTemplate || !templateTitle.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth('/api/autonomous-tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: templateTitle.trim(),
          description: templateDesc.trim() || selectedTemplate.prompt,
          type: selectedTemplate.category,
          templateId: selectedTemplate.id,
        }),
      });
      if (res.ok) {
        toast.success('任务已提交');
        setSelectedTemplate(null);
        setTemplateTitle('');
        setTemplateDesc('');
        setShowTemplatePanel(false);
        loadTasks();
      } else {
        const d = await res.json();
        toast.error(d.error || '提交失败');
      }
    } catch {
      toast.error('提交请求失败');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadTasks, 8000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadTasks]);

  useEffect(() => {
    if (expandedTaskId) loadSupervisorDetail(expandedTaskId);
  }, [expandedTaskId, loadSupervisorDetail]);

  const handleCancel = async (taskId: string) => {
    try {
      // Cancel legacy autonomous task
      const res = await fetchWithAuth(`/api/autonomous-tasks/${taskId}/cancel`, { method: 'POST' });
      // S10 P1: Also cancel linked supervisor tasks
      const svTask = supervisorTasks.find(sv => {
        try {
          const meta = typeof sv.metadata === 'string' ? JSON.parse(sv.metadata) : sv.metadata;
          return meta?.legacyTaskId === taskId;
        } catch { return false; }
      });
      if (svTask) {
        await fetchWithAuth(`/api/supervisor/tasks/${svTask.id}/cancel`, { method: 'POST' }).catch(() => {});
      }
      if (res.ok) { toast.success('任务已取消'); loadTasks(); }
      else { const d = await res.json(); toast.error(d.error || '取消失败'); }
    } catch { toast.error('取消请求失败'); }
  };

  const filteredTasks = statusFilter ? tasks.filter(tk => tk.status === statusFilter) : tasks;
  const runningCount = tasks.filter(tk => tk.status === 'running').length;
  const completedCount = tasks.filter(tk => tk.status === 'completed').length;
  const failedCount = tasks.filter(tk => tk.status === 'failed').length;
  const queuedCount = tasks.filter(tk => tk.status === 'queued').length;

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0f] text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10">
        <div className="flex items-center gap-2 sm:gap-3">
          <button onClick={() => setLocation('/')} className="p-1.5 sm:p-2 hover:bg-white/10 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Target className="w-5 h-5 sm:w-6 sm:h-6 text-violet-400" />
          <h1 className="text-lg sm:text-xl font-semibold">自主任务队列</h1>
          {runningCount > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded-full text-[10px] sm:text-xs">
              <Loader2 className="w-3 h-3 animate-spin" />
              {runningCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg text-[10px] sm:text-xs transition-colors ${
              autoRefresh ? 'bg-green-500/10 text-green-400' : 'bg-white/5 text-white/40'
            }`}
          >
            <RefreshCw className={`w-3 h-3 sm:w-3.5 sm:h-3.5 ${autoRefresh ? 'animate-spin' : ''}`} style={autoRefresh ? { animationDuration: '3s' } : {}} />
            <span className="hidden sm:inline">{autoRefresh ? '自动刷新' : '已暂停'}</span>
          </button>
          <button
            onClick={loadTasks}
            className="p-1.5 sm:p-2 hover:bg-white/10 rounded-lg transition-colors text-white/40 hover:text-white"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 sm:px-6 py-3 sm:py-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          {[
            { label: '总任务', count: tasks.length, icon: <ListTodo className="w-3.5 h-3.5" />, color: 'text-white/40', valColor: '' },
            { label: '运行中', count: runningCount, icon: <Loader2 className="w-3.5 h-3.5" />, color: 'text-blue-400/60', valColor: 'text-blue-400' },
            { label: '已完成', count: completedCount, icon: <CheckCircle2 className="w-3.5 h-3.5" />, color: 'text-green-400/60', valColor: 'text-green-400' },
            { label: '失败', count: failedCount, icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-red-400/60', valColor: 'text-red-400' },
          ].map((stat, i) => (
            <div key={i} className="p-3 sm:p-4 bg-white/[0.03] border border-white/5 rounded-xl">
              <div className={`flex items-center gap-1.5 ${stat.color} text-xs sm:text-sm mb-1 sm:mb-2`}>
                {stat.icon}
                {stat.label}
              </div>
              <p className={`text-xl sm:text-2xl font-semibold ${stat.valColor}`}>{stat.count}</p>
            </div>
          ))}
        </div>
      </div>

      {/* S11 P2: Task Template Quick Actions */}
      {templates.length > 0 && (
        <div className="px-4 sm:px-6 pb-3">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            <span className="text-xs font-medium text-zinc-400">快捷任务</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {templates.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => {
                  setSelectedTemplate(tpl);
                  setTemplateTitle(tpl.name);
                  setTemplateDesc('');
                  setShowTemplatePanel(true);
                }}
                className="flex items-center gap-1.5 px-3 py-2 bg-white/[0.04] hover:bg-violet-500/10 border border-white/5 hover:border-violet-500/20 rounded-lg text-xs text-zinc-300 hover:text-violet-300 whitespace-nowrap transition-all shrink-0"
              >
                {templateIcons[tpl.icon] || <Zap className="w-3.5 h-3.5" />}
                {tpl.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* S11 P2: Template Submit Panel */}
      {showTemplatePanel && selectedTemplate && (
        <div className="px-4 sm:px-6 pb-3">
          <div className="bg-zinc-900/80 border border-violet-500/20 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {templateIcons[selectedTemplate.icon] || <Zap className="w-4 h-4" />}
                <span className="text-sm font-medium text-violet-300">{selectedTemplate.name}</span>
              </div>
              <button onClick={() => { setShowTemplatePanel(false); setSelectedTemplate(null); }} className="p-1 hover:bg-white/10 rounded-md text-zinc-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">{selectedTemplate.description || selectedTemplate.prompt.substring(0, 120)}</p>
            <input
              type="text"
              value={templateTitle}
              onChange={e => setTemplateTitle(e.target.value)}
              placeholder="任务标题"
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/40"
            />
            <textarea
              value={templateDesc}
              onChange={e => setTemplateDesc(e.target.value)}
              placeholder="补充说明（可选，如目标网站、关键词等）"
              rows={2}
              className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/40 resize-none"
            />
            <div className="flex justify-end">
              <button
                onClick={handleTemplateSubmit}
                disabled={submitting || !templateTitle.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {submitting ? '提交中...' : '提交任务'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="px-4 sm:px-6 pb-2">
        <div className="flex gap-1.5 overflow-x-auto">
          {[
            { key: null, label: '全部' },
            { key: 'running', label: '运行中' },
            { key: 'queued', label: '排队中' },
            { key: 'completed', label: '已完成' },
            { key: 'failed', label: '失败' },
          ].map(f => (
            <button
              key={f.key || 'all'}
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors ${
                statusFilter === f.key
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                  : 'bg-white/5 text-white/40 hover:text-white/60 border border-transparent'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-6">
        {filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <Target className="w-12 h-12 mb-4 opacity-30" />
            <p className="text-sm">暂无自主任务</p>
            <p className="text-xs mt-1 text-zinc-600">在对话中提交自主任务后，将在此显示</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredTasks.map(task => {
              const statusCfg = getStatusConfig(task.status);
              const isRunning = task.status === 'running';
              const svDetail = supervisorDetails[task.id];
              const svSteps = svDetail?.steps || [];
              const completedSvSteps = svSteps.filter(s => s.status === 'completed').length;
              const isExpanded = expandedTaskId === task.id;

              return (
                <div key={task.id} className={`bg-zinc-900/60 border rounded-xl overflow-hidden transition-colors ${
                  isRunning ? 'border-violet-500/30' : 'border-zinc-800'
                }`}>
                  {/* Card Header */}
                  <button
                    onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
                  >
                    <div className={`flex items-center justify-center w-8 h-8 rounded-lg border ${statusCfg.color}`}>
                      {statusCfg.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-sm font-medium truncate hover:text-violet-300 hover:underline cursor-pointer transition-colors"
                          onClick={(e) => { e.stopPropagation(); setLocation(`/tasks/${task.id}`); }}
                          title="查看任务详情"
                        >{task.title} <ExternalLink size={10} className="inline-block ml-0.5 opacity-40" /></span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 shrink-0">{task.type || 'general'}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[10px] text-zinc-500">{task.startedAt ? getRelativeTime(task.startedAt) : getRelativeTime(task.createdAt)}</span>
                        {task.duration != null && <span className="text-[10px] text-zinc-600 flex items-center gap-0.5"><Clock size={9} />{formatDuration(task.duration * 1000)}</span>}
                        {task.completedSteps > 0 && <span className="text-[10px] text-zinc-600">{task.completedSteps} 步完成</span>}
                      </div>
                    </div>
                    {isRunning && (
                      <div className="w-16 sm:w-24">
                        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full bg-violet-500 rounded-full transition-all duration-500 animate-pulse" style={{ width: `${Math.max(task.progress || 10, 10)}%` }} />
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2 shrink-0">
                      {(isRunning || task.status === 'queued') && (
                        <button onClick={(e) => { e.stopPropagation(); handleCancel(task.id); }} className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors" title="取消任务">
                          <Pause size={14} />
                        </button>
                      )}
                      <span className="text-zinc-600">{isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                    </div>
                  </button>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800 px-4 py-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                      {task.description && (
                        <div className="text-xs text-zinc-400 bg-zinc-800/50 rounded-lg px-3 py-2 border border-zinc-700/50">
                          <p className="text-[10px] text-zinc-500 mb-1 font-medium">任务描述</p>
                          <p className="line-clamp-3">{task.description}</p>
                        </div>
                      )}
                      {task.currentStep && isRunning && (
                        <div className="flex items-center gap-2 text-xs text-violet-300">
                          <Loader2 size={12} className="animate-spin" />
                          <span className="truncate">{task.currentStep}</span>
                        </div>
                      )}
                      {/* Supervisor Steps Timeline */}
                      {svSteps.length > 0 && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 mb-2">
                            <Zap size={12} className="text-violet-400" />
                            <span className="text-[11px] font-medium text-violet-300">Supervisor 步骤</span>
                            <span className="text-[10px] text-zinc-500">{completedSvSteps}/{svSteps.length}</span>
                            <div className="flex-1 max-w-[100px] h-1 bg-zinc-800 rounded-full overflow-hidden">
                              <div className="h-full bg-violet-500 rounded-full transition-all duration-500" style={{ width: `${svSteps.length > 0 ? (completedSvSteps / svSteps.length) * 100 : 0}%` }} />
                            </div>
                          </div>
                          <div className="relative pl-4 space-y-1">
                            <div className="absolute left-[7px] top-1 bottom-1 w-px bg-zinc-700/50" />
                            {svSteps.map(step => {
                              let decision: any = null;
                              try { decision = step.supervisorDecision ? JSON.parse(step.supervisorDecision) : null; } catch {}
                              return (
                                <div key={step.id} className="relative flex items-start gap-2 py-0.5">
                                  <div className="absolute -left-4 w-[11px] flex justify-center mt-0.5">
                                    {step.status === 'running' ? (
                                      <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute h-full w-full rounded-full bg-violet-400 opacity-50" /><span className="relative rounded-full h-2.5 w-2.5 bg-violet-500" /></span>
                                    ) : step.status === 'completed' ? (
                                      <CheckCircle2 size={11} className="text-emerald-500" />
                                    ) : step.status === 'failed' ? (
                                      <XCircle size={11} className="text-red-400" />
                                    ) : (
                                      <div className="w-2 h-2 rounded-full bg-zinc-600" />
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      {step.retryCount > 0 && <RotateCcw size={10} className="text-amber-400 shrink-0" />}
                                      <span className={`text-[11px] font-medium ${
                                        step.status === 'running' ? 'text-violet-300' :
                                        step.status === 'completed' ? 'text-zinc-400' :
                                        step.status === 'failed' ? 'text-red-400' : 'text-zinc-500'
                                      }`}>步骤 {step.stepNum}</span>
                                      {decision?.decision && (
                                        <span className={`text-[9px] px-1 py-0.5 rounded ${
                                          decision.decision === 'next' ? 'bg-blue-500/10 text-blue-400' :
                                          decision.decision === 'retry' ? 'bg-amber-500/10 text-amber-400' :
                                          decision.decision === 'finish' ? 'bg-emerald-500/10 text-emerald-400' :
                                          'bg-red-500/10 text-red-400'
                                        }`}>{decision.decision}</span>
                                      )}
                                      {step.duration && <span className="text-[10px] text-zinc-600 ml-auto flex items-center gap-0.5 tabular-nums"><Clock size={9} />{formatDuration(step.duration)}</span>}
                                    </div>
                                    <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-1">{step.instruction}</p>
                                    {step.error && <p className="text-[10px] text-red-400/80 mt-0.5">{step.error.substring(0, 150)}</p>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {/* Result */}
                      {task.result && task.status === 'completed' && (
                        <div className="text-xs text-zinc-400 bg-emerald-500/5 rounded-lg px-3 py-2 border border-emerald-500/20">
                          <p className="text-[10px] text-emerald-400 mb-1 font-medium">任务结果</p>
                          <p className="line-clamp-5 whitespace-pre-wrap">
                            {(() => { try { const p = JSON.parse(task.result!); return p.reply || p.answer || JSON.stringify(p, null, 2); } catch { return task.result; } })()}
                          </p>
                        </div>
                      )}
                      {task.error && (
                        <div className="text-xs text-red-300 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/20">
                          <p className="text-[10px] text-red-400 mb-1 font-medium">错误信息</p>
                          <p>{task.error}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
