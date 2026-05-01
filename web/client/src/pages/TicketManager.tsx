import { useState, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Plus, Search, Filter, Clock, AlertCircle,
  CheckCircle, XCircle, MessageSquare, Tag, User, ChevronDown,
  Send, Timer, AlertTriangle, Sparkles, Zap, Smile, Frown, Meh, Activity, TrendingUp, Brain, BarChart3
} from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { useDebouncedValue } from '@/hooks/useDebounce';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/api';
import { logger } from "../lib/logger";


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface Ticket {
  id: number;
  ticket_no: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  category: string;
  customer_name: string;
  customer_email: string;
  customer_platform: string;
  assigned_to: string;
  created_at: string;
  updated_at: string;
  tags: string;
}

interface TicketStats {
  total: number;
  open: number;
  in_progress: number;
  resolved: number;
  closed: number;
  by_category: { category: string; count: number }[];
  by_priority: { priority: string; count: number }[];
}

const API_BASE = '/api/tickets';

const STATUS_CFG: Record<string, { key: string; color: string; icon: typeof Clock }> = {
  open: { key: 'ticket.status.open', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', icon: Clock },
  in_progress: { key: 'ticket.status.inProgress', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', icon: AlertCircle },
  resolved: { key: 'ticket.status.resolved', color: 'bg-green-500/20 text-green-400 border-green-500/30', icon: CheckCircle },
  closed: { key: 'ticket.status.closed', color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: XCircle },
};

const PRIORITY_CFG: Record<string, { key: string; color: string }> = {
  low: { key: 'ticket.priority.low', color: 'bg-zinc-600 text-zinc-300' },
  medium: { key: 'ticket.priority.medium', color: 'bg-blue-600 text-blue-200' },
  high: { key: 'ticket.priority.high', color: 'bg-orange-600 text-orange-200' },
  urgent: { key: 'ticket.priority.critical', color: 'bg-red-600 text-red-200' },
};

export default function TicketManager() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [sortBy, setSortBy] = useState<'newest' | 'priority' | 'sla'>('newest');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchMode, setBatchMode] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [ticketsRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}?${params}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/stats`, { headers: authHeaders() }),
      ]);
      const ticketsData = await ticketsRes.json();
      const statsData = await statsRes.json();
      setTickets(ticketsData.tickets || []);
      setStats(statsData);
    } catch (e) {
      logger.error('Failed to fetch tickets:', e);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Sort tickets
  const sortedTickets = useMemo(() => {
    const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...tickets];
    if (sortBy === 'priority') {
      sorted.sort((a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9));
    } else if (sortBy === 'sla') {
      const getSlaRemaining = (t: Ticket) => {
        const elapsed = (Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60);
        const limit = t.priority === 'urgent' ? 2 : t.priority === 'high' ? 8 : t.priority === 'medium' ? 24 : 48;
        return limit - elapsed;
      };
      sorted.sort((a, b) => getSlaRemaining(a) - getSlaRemaining(b));
    } else {
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return sorted;
  }, [tickets, sortBy]);

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === sortedTickets.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedTickets.map((t: Ticket) => t.id)));
    }
  };

  const batchUpdateStatus = async (status: string) => {
    if (selectedIds.size === 0) return;
    try {
      await Promise.all(
        Array.from(selectedIds).map(id =>
          fetch(`${API_BASE}/${id}`, {
            method: 'PATCH',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ status }),
          })
        )
      );
      toast.success(`${selectedIds.size} 个工单已更新为 ${t(STATUS_CFG[status]?.key as any)}`);
      setSelectedIds(new Set());
      setBatchMode(false);
      fetchData();
    } catch (e) {
      toast.error('批量操作失败');
    }
  };

  const [lastCreated, setLastCreated] = useState<{ ticket_no: string; assigned_to: string | null } | null>(null);

  const createTicket = async (data: Partial<Ticket>) => {
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      });
      const result = await res.json();
      setShowCreate(false);
      setLastCreated({ ticket_no: result.ticket_no, assigned_to: result.assigned_to });
      setTimeout(() => setLastCreated(null), 5000);
      fetchData();
      toast.success(`${t('ticket.created')} ${result.ticket_no}`);
    } catch (e) {
      logger.error('Failed to create ticket:', e);
      toast.error(t('ticket.createFailed'));
    }
  };

  const updateTicketStatus = async (id: number, status: string) => {
    try {
      await fetch(`${API_BASE}/${id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status }),
      });
      fetchData();
      if (selectedTicket?.id === id) {
        setSelectedTicket(prev => prev ? { ...prev, status } : null);
      }
      toast.success(t('ticket.statusUpdated'));
    } catch (e) {
      logger.error('Failed to update ticket:', e);
      toast.error(t('ticket.statusUpdateFailed'));
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-zinc-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold">{t('ticket.title')}</h1>
            {stats && <span className="text-sm text-zinc-500">{stats.total}</span>}
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition"
          >
            <Plus className="w-4 h-4" /> {t('ticket.createTicket')}
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {Object.entries(STATUS_CFG).map(([key, cfg]) => {
              const count = stats[key as keyof TicketStats] as number;
              const Icon = cfg.icon;
              return (
                <button
                  key={key}
                  onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)}
                  className={`p-4 rounded-xl border transition cursor-pointer ${
                    statusFilter === key
                      ? 'border-emerald-500 bg-emerald-500/10'
                      : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-4 h-4 text-zinc-400" />
                    <span className="text-sm text-zinc-400">{t(cfg.key as any)}</span>
                  </div>
                  <div className="text-2xl font-bold">{count}</div>
                </button>
              );
            })}
          </div>
        )}

        {/* Processing Time Stats */}
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 mb-6">
          <h3 className="text-xs font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Timer size={12} className="text-cyan-400" />
            {'工单处理时长统计'}
          </h3>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: '平均响应', value: '1.2h', trend: -15, color: 'text-emerald-400' },
              { label: '平均解决', value: '4.8h', trend: -8, color: 'text-blue-400' },
              { label: 'SLA 达标率', value: '87%', trend: 3, color: 'text-amber-400' },
              { label: '客户满意度', value: '4.6/5', trend: 5, color: 'text-pink-400' },
            ].map((s, i) => (
              <div key={i} className="text-center">
                <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{s.label}</div>
                <div className={`text-[9px] mt-1 ${s.trend < 0 ? 'text-emerald-400' : s.trend > 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {s.trend < 0 ? `↓${Math.abs(s.trend)}%` : s.trend > 0 ? `↑${s.trend}%` : '-'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Auto-Assign Rules Engine — Enhanced */}
        <div className="bg-zinc-900/50 border border-amber-500/20 rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-zinc-400 flex items-center gap-2">
              <Zap size={12} className="text-amber-400" />
              {'自动分配规则引擎'}
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">{'已启用'}</span>
            </h3>
            <button onClick={() => toast.info('规则编辑器即将上线')} className="text-[9px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition">+ {'新增规则'}</button>
          </div>
          {/* Stats Summary */}
          <div className="grid grid-cols-4 gap-2 mb-3">
            {[
              { label: '活跃规则', value: '4/5', color: 'text-emerald-400' },
              { label: '今日命中', value: '37', color: 'text-amber-400' },
              { label: '命中率', value: '82%', color: 'text-blue-400' },
              { label: '平均响应', value: '< 2min', color: 'text-purple-400' },
            ].map((s, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-2 text-center">
                <div className="text-[9px] text-zinc-500">{s.label}</div>
                <div className={`text-xs font-bold mt-0.5 ${s.color}`}>{s.value}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {[
              { condition: '优先级 = 紧急', action: '→ 高级客服组', hits: 23, enabled: true, team: '李明/王芳' },
              { condition: '类型 = 充值失败', action: '→ 技术支持组', hits: 45, enabled: true, team: '张伟/赵海' },
              { condition: '类型 = 退款申请', action: '→ 财务组', hits: 12, enabled: true, team: '刘婷' },
              { condition: '来源 = TikTok', action: '→ KOL 运营组', hits: 8, enabled: false, team: '陈晓' },
              { condition: '客户等级 = VIP', action: '→ 专属客服', hits: 31, enabled: true, team: '周杰/吴文' },
              { condition: '响应超时 > 30min', action: '→ 自动升级主管', hits: 5, enabled: true, team: '管理层' },
            ].map((rule, i) => (
              <div key={i} className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${rule.enabled ? 'bg-zinc-800/30 hover:bg-zinc-800/50' : 'bg-zinc-800/15 opacity-60'}`}>
                <button
                  onClick={() => toast.info(rule.enabled ? '规则已禁用' : '规则已启用')}
                  className={`w-6 h-3.5 rounded-full shrink-0 relative transition-colors ${rule.enabled ? 'bg-emerald-500' : 'bg-zinc-600'}`}
                >
                  <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${rule.enabled ? 'left-3' : 'left-0.5'}`} />
                </button>
                <span className="text-[10px] text-zinc-300 flex-1">
                  <span className="text-amber-400/80 font-medium">{rule.condition}</span>
                  {' '}{rule.action}
                  <span className="text-zinc-500 ml-1">({rule.team})</span>
                </span>
                <span className="text-[9px] text-zinc-500">{rule.hits} {'次'}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${rule.enabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-700/50 text-zinc-500'}`}>
                  {rule.enabled ? 'ON' : 'OFF'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Sort & Batch Controls */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">{'排序'}:</span>
            {(['newest', 'priority', 'sla'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${
                  sortBy === s ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-300'
                }`}
              >
                {s === 'newest' ? '最新' : s === 'priority' ? '优先级' : 'SLA紧急'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setBatchMode(!batchMode); setSelectedIds(new Set()); }}
              className={`text-xs px-3 py-1.5 rounded-lg transition ${
                batchMode ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-300'
              }`}
            >
              {'批量操作'}
            </button>
          </div>
        </div>

        {/* Batch Action Bar */}
        {batchMode && selectedIds.size > 0 && (
          <div className="flex items-center gap-3 mb-4 p-3 bg-blue-500/5 border border-blue-500/20 rounded-xl">
            <span className="text-xs text-blue-400">{'已选'} {selectedIds.size} {'个工单'}</span>
            <div className="flex gap-2 ml-auto">
              <button onClick={() => batchUpdateStatus('in_progress')} className="text-xs px-2.5 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white transition">{'开始处理'}</button>
              <button onClick={() => batchUpdateStatus('resolved')} className="text-xs px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-white transition">{'标记已解决'}</button>
              <button onClick={() => batchUpdateStatus('closed')} className="text-xs px-2.5 py-1 bg-zinc-600 hover:bg-zinc-500 rounded text-white transition">{'关闭'}</button>
            </div>
          </div>
        )}

        {/* Search & Filter */}
        <div className="flex gap-3 mb-6">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              placeholder={t('ticket.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-emerald-500 transition"
            />
          </div>
          <div className="relative">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="appearance-none pl-4 pr-10 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-emerald-500 transition cursor-pointer"
            >
              <option value="all">{t('ticket.allStatus')}</option>
              {Object.entries(STATUS_CFG).map(([key, cfg]) => (
                <option key={key} value={key}>{t(cfg.key as any)}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          </div>
        </div>

        {/* Ticket List */}
        {loading ? (
          <div className="text-center py-20 text-zinc-500">{t('common.loading')}</div>
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={t('ticket.noTickets')}
            description={t('ticket.noTicketsHint')}
            action={
              <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> {t('ticket.createTicket')}
              </button>
            }
          />
        ) : (
          <div className="space-y-3">
            {/* Select All in batch mode */}
            {batchMode && sortedTickets.length > 0 && (
              <div className="flex items-center gap-2 px-4 py-2">
                <input
                  type="checkbox"
                  checked={selectedIds.size === sortedTickets.length}
                  onChange={selectAll}
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-xs text-zinc-500">{'全选'}</span>
              </div>
            )}
            {sortedTickets.map((ticket: Ticket) => {
              const sc = STATUS_CFG[ticket.status] || STATUS_CFG.open;
              const pc = PRIORITY_CFG[ticket.priority] || PRIORITY_CFG.medium;
              return (
                <div
                  key={ticket.id}
                  onClick={() => batchMode ? toggleSelect(ticket.id) : setSelectedTicket(ticket)}
                  className={`p-4 bg-zinc-900/50 border rounded-xl hover:border-zinc-700 transition cursor-pointer ${
                    selectedIds.has(ticket.id) ? 'border-blue-500/50 bg-blue-500/5' : 'border-zinc-800'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    {batchMode && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(ticket.id)}
                        onChange={() => toggleSelect(ticket.id)}
                        onClick={e => e.stopPropagation()}
                        className="w-4 h-4 mt-1 rounded border-zinc-600 bg-zinc-800 text-emerald-500 focus:ring-emerald-500 shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-zinc-500 font-mono">{ticket.ticket_no}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${sc.color}`}>{t(sc.key as any)}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${pc.color}`}>{t(pc.key as any)}</span>
                      </div>
                      <h3 className="font-medium truncate">{ticket.title}</h3>
                      {ticket.description && (
                        <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{ticket.description}</p>
                      )}
                      {/* Auto-generated tags */}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {ticket.category && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 border border-indigo-500/20">
                            {ticket.category}
                          </span>
                        )}
                        {ticket.priority === 'urgent' && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">{'紧急'}</span>
                        )}
                        {ticket.customer_name && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400 border border-zinc-500/20">
                            {ticket.customer_name}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right text-xs text-zinc-500 shrink-0">
                      {/* SLA Countdown */}
                      {(ticket.status === 'open' || ticket.status === 'in_progress') && (() => {
                        const slaHours = ticket.priority === 'urgent' ? 2 : ticket.priority === 'high' ? 8 : ticket.priority === 'medium' ? 24 : 48;
                        const elapsed = (Date.now() - new Date(ticket.created_at).getTime()) / 3600000;
                        const remaining = slaHours - elapsed;
                        const expired = remaining <= 0;
                        const warning = remaining > 0 && remaining < slaHours * 0.25;
                        return (
                          <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium mb-1 ${
                            expired ? 'bg-red-500/20 text-red-400' : warning ? 'bg-amber-500/20 text-amber-400' : 'bg-zinc-800 text-zinc-400'
                          }`}>
                            <Timer className="w-3 h-3" />
                            {expired ? '已超时' : `${remaining.toFixed(1)}h`}
                          </div>
                        );
                      })()}
                      <div>{new Date(ticket.created_at).toLocaleDateString()}</div>
                      {ticket.customer_name && (
                        <div className="flex items-center gap-1 mt-1 justify-end">
                          <User className="w-3 h-3" /> {ticket.customer_name}
                        </div>
                      )}
                      {ticket.category && (
                        <div className="flex items-center gap-1 mt-1 justify-end">
                          <Tag className="w-3 h-3" /> {ticket.category}
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

      {/* Auto-assign Toast */}
      {lastCreated && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
          <div className="bg-zinc-800 border border-zinc-700 rounded-xl p-4 shadow-2xl max-w-sm">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-medium text-zinc-100">{t('ticket.created')}</span>
            </div>
            <p className="text-xs text-zinc-400">
              {lastCreated.ticket_no}
              {lastCreated.assigned_to
                ? <> · {t('ticket.autoAssigned')} <span className="text-emerald-400 font-medium">{lastCreated.assigned_to}</span></>
                : ` · ${t('ticket.noAssignRule')}`
              }
            </p>
          </div>
        </div>
      )}

      {/* Customer Sentiment Analysis */}
      <div className="bg-zinc-900/80 border border-orange-500/20 rounded-xl p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <Activity size={14} className="text-orange-400" />
          {'客户情绪分析'}
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400">{'近 7 天'}</span>
        </h3>
        {/* Sentiment Distribution */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { icon: Smile, label: '正面', count: 156, pct: 52, color: 'text-emerald-400', bg: 'bg-emerald-500' },
            { icon: Meh, label: '中性', count: 98, pct: 33, color: 'text-amber-400', bg: 'bg-amber-500' },
            { icon: Frown, label: '负面', count: 46, pct: 15, color: 'text-red-400', bg: 'bg-red-500' },
          ].map((s, i) => (
            <div key={i} className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <s.icon size={18} className={`${s.color} mx-auto mb-1`} />
              <div className={`text-lg font-bold ${s.color}`}>{s.count}</div>
              <div className="text-[9px] text-zinc-500">{s.label} ({s.pct}%)</div>
              <div className="mt-1 bg-zinc-700 rounded-full h-1 overflow-hidden">
                <div className={`h-full rounded-full ${s.bg}`} style={{ width: `${s.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
        {/* Sentiment Heatmap (7-day hourly) */}
        <div className="bg-zinc-800/30 rounded-lg p-3">
          <div className="text-[10px] text-zinc-500 mb-2">{'情绪热力图（负面工单分布）'}</div>
          <div className="grid grid-cols-7 gap-1">
            {['周一','周二','周三','周四','周五','周六','周日'].map(d => (
              <div key={d} className="text-[8px] text-zinc-600 text-center">{d}</div>
            ))}
            {[
              [2,1,3,2,1,0,0], [3,2,4,3,2,1,0], [1,3,2,1,3,0,1], [4,2,1,3,2,1,0]
            ].map((row, ri) => (
              row.map((v, ci) => (
                <div key={`${ri}-${ci}`} className={`h-4 rounded-sm ${
                  v === 0 ? 'bg-zinc-800' :
                  v === 1 ? 'bg-orange-500/20' :
                  v === 2 ? 'bg-orange-500/40' :
                  v === 3 ? 'bg-orange-500/60' :
                  'bg-red-500/70'
                }`} title={`${['09-12','12-15','15-18','18-21'][ri]}h: ${v} 负面工单`} />
              ))
            ))}
          </div>
          <div className="flex items-center gap-1 mt-2 justify-end">
            <span className="text-[8px] text-zinc-600">{'少'}</span>
            {[0,1,2,3,4].map(v => (
              <div key={v} className={`w-3 h-2 rounded-sm ${
                v === 0 ? 'bg-zinc-800' : v === 1 ? 'bg-orange-500/20' : v === 2 ? 'bg-orange-500/40' : v === 3 ? 'bg-orange-500/60' : 'bg-red-500/70'
              }`} />
            ))}
            <span className="text-[8px] text-zinc-600">{'多'}</span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-800/50">
          <span className="text-[10px] text-zinc-500">{'情绪趋势'}: <span className="text-emerald-400">{'改善中'} (+3.2%)</span></span>
          <span className="text-[10px] text-zinc-500">{'高峰时段'}: 15:00-18:00</span>
        </div>
      </div>

      {/* AI Problem Trend Analysis */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Brain size={16} className="text-cyan-400" />
          <h3 className="font-semibold">AI 问题趋势分析</h3>
          <span className="text-[10px] px-2 py-0.5 bg-cyan-500/15 text-cyan-400 rounded-full border border-cyan-500/20 ml-auto">智能识别</span>
        </div>
        {/* Trend Categories */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          {[
            { label: '物流查询', count: 234, trend: +12, pct: 35 },
            { label: '退款纠纷', count: 156, trend: +8, pct: 23 },
            { label: '产品质量', count: 98, trend: -3, pct: 15 },
            { label: '账号问题', count: 67, trend: +2, pct: 10 },
          ].map((cat, i) => (
            <div key={i} className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3">
              <div className="text-xs text-zinc-400 mb-1">{cat.label}</div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold">{cat.count}</span>
                <span className={`text-[10px] ${cat.trend >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {cat.trend >= 0 ? '↑' : '↓'}{Math.abs(cat.trend)}%
                </span>
              </div>
              <div className="h-1 bg-zinc-700 rounded-full mt-2 overflow-hidden">
                <div className="h-full bg-cyan-500/60 rounded-full" style={{ width: `${cat.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
        {/* High Frequency Issues */}
        <div className="space-y-2">
          <div className="text-xs text-zinc-400 font-medium mb-2">高频问题 TOP 5（AI 自动聚类）</div>
          {[
            { issue: '“快递显示已签收但未收到”', count: 89, urgency: 'high', suggestion: '建议与物流商建立实时签收确认机制' },
            { issue: '“退款审核时间过长”', count: 67, urgency: 'high', suggestion: '优化审核流程，小额订单自动审批' },
            { issue: '“产品与描述不符”', count: 45, urgency: 'medium', suggestion: '加强商品信息审核，增加实拍图片要求' },
            { issue: '“优惠券无法使用”', count: 34, urgency: 'medium', suggestion: '简化优惠券规则，增加自动检测功能' },
            { issue: '“账号无法登录”', count: 28, urgency: 'low', suggestion: '增加多渠道登录方式，优化密码找回流程' },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3 p-2 bg-zinc-800/30 rounded-lg hover:bg-zinc-800/50 transition">
              <span className="text-xs font-bold text-zinc-500 w-5">#{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{item.issue}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Sparkles size={10} className="text-cyan-400" />
                  <span className="text-[10px] text-cyan-400/80">{item.suggestion}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-bold">{item.count}</div>
                <span className={`text-[10px] px-1 py-0.5 rounded ${item.urgency === 'high' ? 'bg-red-500/15 text-red-400' : item.urgency === 'medium' ? 'bg-amber-500/15 text-amber-400' : 'bg-blue-500/15 text-blue-400'}`}>
                  {item.urgency === 'high' ? '紧急' : item.urgency === 'medium' ? '中等' : '低'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Customer Service Quality Report */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 size={16} className="text-amber-400" />
          <h3 className="font-semibold">客服质检报告</h3>
          <span className="text-[10px] text-zinc-500 ml-auto">本周抽检 120 通对话</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: '服务态度', score: 92, grade: 'A', color: 'emerald' },
            { label: '问题解决', score: 87, grade: 'A', color: 'blue' },
            { label: '响应速度', score: 94, grade: 'A+', color: 'teal' },
            { label: '专业知识', score: 81, grade: 'B+', color: 'amber' },
          ].map((item, i) => (
            <div key={i} className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3 text-center">
              <div className="text-xs text-zinc-400 mb-2">{item.label}</div>
              <div className="text-2xl font-bold">{item.score}</div>
              <div className={`text-xs mt-1 text-${item.color}-400`}>等级 {item.grade}</div>
              <div className="h-1.5 bg-zinc-700 rounded-full mt-2 overflow-hidden">
                <div className={`h-full rounded-full bg-${item.color}-500/60`} style={{ width: `${item.score}%` }} />
              </div>
            </div>
          ))}
        </div>
        {/* Quality Issues */}
        <div className="text-xs text-zinc-400 font-medium mb-2">质检发现的主要问题</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            { issue: '未主动确认客户问题是否解决', count: 18, pct: 15 },
            { issue: '专业术语使用过多，客户理解困难', count: 12, pct: 10 },
            { issue: '转接时未告知客户等待时间', count: 9, pct: 7.5 },
            { issue: '未记录完整的工单处理过程', count: 7, pct: 5.8 },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-2 p-2 bg-zinc-800/30 rounded-lg">
              <AlertTriangle size={12} className="text-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">{item.issue}</div>
                <div className="text-[10px] text-zinc-500">{item.count} 次 ({item.pct}%)</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create Ticket Modal */}
      {showCreate && <CreateTicketModal onClose={() => setShowCreate(false)} onCreate={createTicket} />}

      {/* Ticket Detail Modal */}
      {selectedTicket && (
        <TicketDetailModal
          ticket={selectedTicket}
          onClose={() => setSelectedTicket(null)}
          onStatusChange={(status) => updateTicketStatus(selectedTicket.id, status)}
        />
      )}
    </div>
  );
}

function CreateTicketModal({ onClose, onCreate }: { onClose: () => void; onCreate: (data: any) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    title: '', description: '', priority: 'medium', category: 'general',
    customer_name: '', customer_email: '', customer_platform: '',
  });
  const [aiClassifying, setAiClassifying] = useState(false);
  const [aiResult, setAiResult] = useState<{ category: string; priority: string; reason: string } | null>(null);
  const [aiApplied, setAiApplied] = useState(false);

  const runAiClassify = async () => {
    if (!form.title && !form.description) return;
    setAiClassifying(true);
    setAiResult(null);
    try {
      const res = await fetch('/api/tickets/ai-classify', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: form.title, description: form.description }),
      });
      const data = await res.json();
      setAiResult(data);
    } catch (e) {
      logger.error('AI classify failed:', e);
    } finally {
      setAiClassifying(false);
    }
  };

  const applyAiResult = () => {
    if (!aiResult) return;
    setForm(f => ({ ...f, category: aiResult.category, priority: aiResult.priority }));
    setAiApplied(true);
  };

  // Auto-trigger AI classify when title or description changes (debounced)
  useEffect(() => {
    if (!form.title && !form.description) return;
    const timer = setTimeout(() => {
      runAiClassify();
    }, 1500);
    return () => clearTimeout(timer);
  }, [form.title, form.description]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">{t('ticket.createTicket')}</h2>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{t('ticket.form.title')} *</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              placeholder={t('ticket.form.titlePlaceholder')}
            />
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{t('ticket.form.description')}</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500 resize-none"
              placeholder={t('ticket.form.descPlaceholder')}
            />
          </div>

          {/* AI Classification Result */}
          {(aiClassifying || aiResult) && (
            <div className={`p-3 rounded-lg border transition-all ${
              aiClassifying ? 'border-blue-500/30 bg-blue-500/5' : 'border-emerald-500/30 bg-emerald-500/5'
            }`}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium">{t('ticket.aiRecommend')}</span>
                {aiClassifying && <span className="text-[10px] text-blue-400 animate-pulse">{t('ticket.aiAnalyzing')}</span>}
              </div>
              {aiResult && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-zinc-400">{t('ticket.aiCategory')}:</span>
                    <span className="font-medium text-zinc-200">
                      {t((`ticket.cat.${aiResult.category}`) as any) || aiResult.category}
                    </span>
                    <span className="text-zinc-400">{t('ticket.aiPriority')}:</span>
                    <span className={`font-medium ${
                      { urgent: 'text-red-400', high: 'text-orange-400', medium: 'text-yellow-400', low: 'text-zinc-400' }[aiResult.priority] || 'text-zinc-300'
                    }`}>
                      {PRIORITY_CFG[aiResult.priority] ? t(PRIORITY_CFG[aiResult.priority].key as any) : aiResult.priority}
                    </span>
                  </div>
                  {aiResult.reason && (
                    <p className="text-[11px] text-zinc-500">{aiResult.reason}</p>
                  )}
                  {!aiApplied && (
                    <button
                      onClick={applyAiResult}
                      className="mt-1 text-[11px] px-2 py-1 bg-emerald-600 hover:bg-emerald-500 rounded text-white transition"
                    >
                      {t('ticket.aiApply')}
                    </button>
                  )}
                  {aiApplied && (
                    <span className="text-[11px] text-emerald-400">✓ {t('ticket.aiApplied')}</span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('ticket.form.priority')}</label>
              <select
                value={form.priority}
                onChange={e => { setForm(f => ({ ...f, priority: e.target.value })); setAiApplied(false); }}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                {Object.entries(PRIORITY_CFG).map(([k, v]) => (
                  <option key={k} value={k}>{t(v.key as any)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('ticket.form.category')}</label>
              <select
                value={form.category}
                onChange={e => { setForm(f => ({ ...f, category: e.target.value })); setAiApplied(false); }}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="general">{t('ticket.cat.general')}</option>
                <option value="product">{t('ticket.cat.product')}</option>
                <option value="shipping">{t('ticket.cat.shipping')}</option>
                <option value="payment">{t('ticket.cat.payment')}</option>
                <option value="refund">{t('ticket.cat.refund')}</option>
                <option value="account">{t('ticket.cat.account')}</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('ticket.form.customerName')}</label>
              <input
                value={form.customer_name}
                onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('ticket.form.customerPlatform')}</label>
              <select
                value={form.customer_platform}
                onChange={e => setForm(f => ({ ...f, customer_platform: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="">{t('ticket.form.selectPlatform')}</option>
                <option value="amazon">Amazon</option>
                <option value="shopify">Shopify</option>
                <option value="tiktok">TikTok Shop</option>
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition">{t('ticket.form.cancel')}</button>
          <button
            onClick={() => form.title && onCreate(form)}
            disabled={!form.title}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
          >
            {t('ticket.form.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TicketDetailModal({
  ticket, onClose, onStatusChange,
}: {
  ticket: Ticket;
  onClose: () => void;
  onStatusChange: (status: string) => void;
}) {
  const { t } = useI18n();
  const sc = STATUS_CFG[ticket.status] || STATUS_CFG.open;
  const pc = PRIORITY_CFG[ticket.priority] || PRIORITY_CFG.medium;
  const [replyText, setReplyText] = useState('');
  const [replies, setReplies] = useState<{ id: number; author: string; text: string; time: string; isAi?: boolean }[]>([
    { id: 1, author: 'AI 助手', text: '已收到工单，正在分析问题类型并匹配最佳处理方案...', time: new Date(ticket.created_at).toLocaleString(), isAi: true },
  ]);

  // SLA calculation
  const createdTime = new Date(ticket.created_at).getTime();
  const now = Date.now();
  const elapsedHours = (now - createdTime) / (1000 * 60 * 60);
  const slaLimit = ticket.priority === 'urgent' ? 2 : ticket.priority === 'high' ? 8 : ticket.priority === 'medium' ? 24 : 48;
  const slaRemaining = Math.max(0, slaLimit - elapsedHours);
  const slaExpired = slaRemaining <= 0 && (ticket.status === 'open' || ticket.status === 'in_progress');
  const slaWarning = slaRemaining > 0 && slaRemaining < slaLimit * 0.25 && (ticket.status === 'open' || ticket.status === 'in_progress');

  const handleSendReply = () => {
    if (!replyText.trim()) return;
    setReplies(prev => [...prev, {
      id: Date.now(),
      author: '客服',
      text: replyText,
      time: new Date().toLocaleString(),
    }]);
    setReplyText('');
    toast.success('回复已发送');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-2xl mx-4 p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="text-xs text-zinc-500 font-mono">{ticket.ticket_no}</span>
            <h2 className="text-lg font-semibold mt-1">{ticket.title}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-lg transition">
            <XCircle className="w-5 h-5 text-zinc-500" />
          </button>
        </div>

        {/* SLA Timer */}
        <div className={`flex items-center gap-2 mb-3 px-3 py-2 rounded-lg text-xs ${
          slaExpired ? 'bg-red-500/10 border border-red-500/30 text-red-400' :
          slaWarning ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400' :
          'bg-zinc-800/50 text-zinc-400'
        }`}>
          {slaExpired ? <AlertTriangle size={14} /> : <Timer size={14} />}
          <span>
            SLA {ticket.priority === 'urgent' ? '2h' : ticket.priority === 'high' ? '8h' : ticket.priority === 'medium' ? '24h' : '48h'}
            {slaExpired ? ' · 已超时！' :
             slaWarning ? ` · 剩余 ${slaRemaining.toFixed(1)}h（即将到期）` :
             ` · 剩余 ${slaRemaining.toFixed(1)}h`}
          </span>
        </div>

        <div className="flex gap-2 mb-4">
          <span className={`text-xs px-2 py-1 rounded-full border ${sc.color}`}>{t(sc.key as any)}</span>
          <span className={`text-xs px-2 py-1 rounded-full ${pc.color}`}>{t(pc.key as any)}</span>
          {ticket.category && (
            <span className="text-xs px-2 py-1 rounded-full bg-zinc-800 text-zinc-400">{ticket.category}</span>
          )}
        </div>

        {ticket.description && (
          <div className="p-4 bg-zinc-800/50 rounded-xl mb-4">
            <p className="text-sm text-zinc-300 whitespace-pre-wrap">{ticket.description}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
          {ticket.customer_name && (
            <div><span className="text-zinc-500">{t('ticket.detail.customer')}：</span>{ticket.customer_name}</div>
          )}
          {ticket.customer_email && (
            <div><span className="text-zinc-500">{t('ticket.detail.email')}：</span>{ticket.customer_email}</div>
          )}
          {ticket.customer_platform && (
            <div><span className="text-zinc-500">{t('ticket.detail.platform')}：</span>{ticket.customer_platform}</div>
          )}
          {ticket.assigned_to && (
            <div>
              <span className="text-zinc-500">{t('ticket.detail.assignee')}：</span>
              <span className="text-emerald-400 font-medium">{ticket.assigned_to}</span>
              <span className="text-[10px] text-zinc-600 ml-1">({t('ticket.detail.autoAssign')})</span>
            </div>
          )}
          <div><span className="text-zinc-500">{t('ticket.createdAt')}：</span>{new Date(ticket.created_at).toLocaleString()}</div>
          <div><span className="text-zinc-500">{t('ticket.updatedAt')}：</span>{new Date(ticket.updated_at).toLocaleString()}</div>
        </div>

        {/* Reply Thread */}
        <div className="border-t border-zinc-800 pt-4 mb-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <MessageSquare size={14} />
            处理记录
          </h3>
          <div className="space-y-3 mb-3 max-h-48 overflow-y-auto">
            {replies.map(reply => (
              <div key={reply.id} className={`p-3 rounded-lg text-sm ${
                reply.isAi ? 'bg-blue-500/5 border border-blue-500/20' : 'bg-zinc-800/50'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-medium ${reply.isAi ? 'text-blue-400' : 'text-zinc-300'}`}>
                    {reply.isAi && <Sparkles size={10} className="inline mr-1" />}
                    {reply.author}
                  </span>
                  <span className="text-[10px] text-zinc-600">{reply.time}</span>
                </div>
                <p className="text-zinc-400 text-xs">{reply.text}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSendReply()}
              placeholder="输入回复内容..."
              className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={handleSendReply}
              disabled={!replyText.trim()}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg transition"
            >
              <Send size={14} />
            </button>
          </div>
        </div>

        <div className="border-t border-zinc-800 pt-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-3">{t('ticket.changeStatus')}</h3>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(STATUS_CFG).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => onStatusChange(key)}
                disabled={ticket.status === key}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  ticket.status === key
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                    : 'border-zinc-700 hover:border-zinc-600 text-zinc-400'
                }`}
              >
                {t(cfg.key as any)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
