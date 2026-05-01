/**
 * CeoDashboard - CEO Global Business Dashboard
 * 
 * Shows real-time overview of 3 business centers:
 * - Baoliang Engine Center (CPS + FC Coins)
 * - Cuantianhuo Center (Direct + Agent Recharge + TikTok)
 * - General Management Center (Finance/Legal/Admin)
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useI18n } from '@/lib/i18n';
import {
  ArrowLeft, TrendingUp, TrendingDown, AlertTriangle, Users, Package,
  Headphones, Crown, DollarSign, ShoppingCart, Truck, BarChart3,
  RefreshCw, ChevronRight, Clock, Zap, Globe, Activity,
  ArrowUpRight, ArrowDownRight, Building2, Target, Gamepad2,
  Sparkles, AlertCircle, CheckCircle2, XCircle, Timer, Eye,
  Flag, CalendarDays, Milestone as MilestoneIcon, Shield, Star, GitBranch, ArrowRightLeft
} from 'lucide-react';
import { toast } from 'sonner';
import { useAutoRefresh } from '@/hooks/useAutoRefresh';
import { AutoRefreshControl } from '@/components/AutoRefreshControl';
import { getAuthToken } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface Alert {
  id: string;
  type: 'warning' | 'error' | 'info';
  title: string;
  description: string;
  center: string;
  time: string;
  resolved: boolean;
}

interface TeamStatus {
  name: string;
  center: string;
  headcount: number;
  activeToday: number;
  tasksCompleted: number;
  tasksTotal: number;
  status: 'normal' | 'busy' | 'idle';
}

interface MilestoneItem {
  id: string;
  title: string;
  description: string;
  deadline: string;
  status: 'completed' | 'in-progress' | 'upcoming' | 'at-risk';
  progress: number;
  owner: string;
  category: 'tiktok' | 'coins' | 'ops' | 'tech';
}

interface CenterData {
  id: string;
  name: string;
  shortName: string;
  icon: typeof Building2;
  color: string;
  bgColor: string;
  borderColor: string;
  headcount: number;
  revenue: number;
  revenueChange: number;
  orders: number;
  ordersChange: number;
  teams: TeamStatus[];
  highlights: string[];
}

// ─── Mock Data ──────────────────────────────────────────────

function generateMockData(): {
  centers: CenterData[];
  alerts: Alert[];
  todayMetrics: { label: string; value: string; change: number; icon: typeof TrendingUp; color: string }[];
  milestones: MilestoneItem[];
} {
  const centers: CenterData[] = [
    {
      id: 'baoliang',
      name: '豹量引擎中心',
      shortName: '豹量',
      icon: Target,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-blue-500/20',
      headcount: 30,
      revenue: 2847500,
      revenueChange: 12.5,
      orders: 18432,
      ordersChange: 8.3,
      teams: [
        {
          name: 'CPS推广组',
          center: '豹量引擎',
          headcount: 10,
          activeToday: 8,
          tasksCompleted: 45,
          tasksTotal: 52,
          status: 'normal',
        },
        {
          name: 'FC金币组',
          center: '豹量引擎',
          headcount: 20,
          activeToday: 18,
          tasksCompleted: 156,
          tasksTotal: 170,
          status: 'busy',
        },
      ],
      highlights: [
        '今日CPS推广新增3个主播合作',
        'FC金币回收量达成12.8万枚',
        'Lootbar FC业务订单量同比增长15%',
      ],
    },
    {
      id: 'cuantianhuo',
      name: '窜天猴中心',
      shortName: '窜天猴',
      icon: Zap,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/20',
      headcount: 65,
      revenue: 5632100,
      revenueChange: -2.1,
      orders: 42856,
      ordersChange: 5.7,
      teams: [
        {
          name: '直充组',
          center: '窜天猴',
          headcount: 10,
          activeToday: 9,
          tasksCompleted: 89,
          tasksTotal: 95,
          status: 'normal',
        },
        {
          name: '代充组',
          center: '窜天猴',
          headcount: 40,
          activeToday: 35,
          tasksCompleted: 312,
          tasksTotal: 350,
          status: 'busy',
        },
        {
          name: 'TikTok运营组',
          center: '窜天猴',
          headcount: 15,
          activeToday: 12,
          tasksCompleted: 28,
          tasksTotal: 35,
          status: 'normal',
        },
      ],
      highlights: [
        '代充组今日处理订单312单，完成玉89%',
        'TikTok店铺新增2个KOL合作意向',
        '直充供应链稳定，售后工单下降8%',
      ],
    },
    {
      id: 'general',
      name: '综合管理中心',
      shortName: '综管',
      icon: Building2,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
      headcount: 10,
      revenue: 0,
      revenueChange: 0,
      orders: 0,
      ordersChange: 0,
      teams: [
        {
          name: '财法税组',
          center: '综合管理',
          headcount: 6,
          activeToday: 5,
          tasksCompleted: 18,
          tasksTotal: 22,
          status: 'normal',
        },
        {
          name: '行政组',
          center: '综合管理',
          headcount: 4,
          activeToday: 4,
          tasksCompleted: 12,
          tasksTotal: 15,
          status: 'normal',
        },
      ],
      highlights: [
        '本月财务报表已完成审核',
        '新合同审批流程优化完成',
        '员工社保缴纳已全部完成',
      ],
    },
  ];

  const alerts: Alert[] = [
    {
      id: '1',
      type: 'warning',
      title: '代充组工单积压',
      description: '待处理工单超过50单，建议调配人力支援',
      center: '窜天猴中心',
      time: '15分钟前',
      resolved: false,
    },
    {
      id: '2',
      type: 'error',
      title: 'FC金币库存低于安全线',
      description: '当前库存仅5.2万枚，低于安全线8万枚，需要加快回收',
      center: '豹量引擎中心',
      time: '1小时前',
      resolved: false,
    },
    {
      id: '3',
      type: 'info',
      title: 'TikTok KOL合作即将到期',
      description: '3个KOL合作协议将在7天内到期，需要跟进续约',
      center: '窜天猴中心',
      time: '2小时前',
      resolved: false,
    },
    {
      id: '4',
      type: 'warning',
      title: '直充供应商响应延迟',
      description: '主要供应商响应时间超过2小时，影响发货效率',
      center: '窜天猴中心',
      time: '30分钟前',
      resolved: false,
    },
  ];

  const todayMetrics = [
    { label: '今日订单', value: '61,288', change: 6.8, icon: ShoppingCart, color: 'text-blue-400' },
    { label: '今日发货', value: '58,921', change: 4.2, icon: Truck, color: 'text-emerald-400' },
    { label: '客服工单', value: '127', change: -8.5, icon: Headphones, color: 'text-amber-400' },
    { label: 'KOL合作', value: '48', change: 12.0, icon: Crown, color: 'text-purple-400' },
    { label: '在线员工', value: '91/105', change: 0, icon: Users, color: 'text-cyan-400' },
    { label: '今日GMV', value: '¥8.48M', change: 3.7, icon: DollarSign, color: 'text-rose-400' },
  ];

  const milestones: MilestoneItem[] = [
    {
      id: 'm1',
      title: '美区店铺加白',
      description: 'TikTok Shop 美区店铺最终选择与加白审核',
      deadline: '2026-03-25',
      status: 'in-progress',
      progress: 65,
      owner: 'TikTok运营组',
      category: 'tiktok',
    },
    {
      id: 'm2',
      title: '直播间搭建',
      description: '完成美区直播间硬件采购、场景搭建与测试',
      deadline: '2026-03-20',
      status: 'at-risk',
      progress: 40,
      owner: 'TikTok运营组',
      category: 'tiktok',
    },
    {
      id: 'm3',
      title: 'KOL分润标准化表',
      description: '制定并发布KOL分润标准化协议模板',
      deadline: '2026-03-18',
      status: 'in-progress',
      progress: 80,
      owner: '豹量引擎',
      category: 'tiktok',
    },
    {
      id: 'm4',
      title: '东南亚DC上线',
      description: '东南亚分发中心上线运营，对接本地物流',
      deadline: '2026-04-15',
      status: 'upcoming',
      progress: 20,
      owner: '窜天猴中心',
      category: 'ops',
    },
    {
      id: 'm5',
      title: 'FC金币库存监控系统',
      description: '完成EA封号动态监控与异常损耗率预警',
      deadline: '2026-03-30',
      status: 'in-progress',
      progress: 55,
      owner: '豹量引擎',
      category: 'coins',
    },
    {
      id: 'm6',
      title: 'RangerAI全功能上线',
      description: 'CEO看板、数据分析、日报分析模块全部对接实数据',
      deadline: '2026-03-28',
      status: 'in-progress',
      progress: 45,
      owner: 'Manus + Ranger',
      category: 'tech',
    },
  ];

  return { centers, alerts, todayMetrics, milestones };
}

// ─── Helper Components ──────────────────────────────────────

function ChangeIndicator({ change }: { change: number }) {
  if (change === 0) return <span className="text-zinc-500 text-xs">--</span>;
  const isPositive = change > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
      {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

function StatusDot({ status }: { status: 'normal' | 'busy' | 'idle' }) {
  const colors = {
    normal: 'bg-emerald-500',
    busy: 'bg-amber-500 animate-pulse',
    idle: 'bg-zinc-500',
  };
  const labels = {
    normal: '正常',
    busy: '繁忙',
    idle: '空闲',
  };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${colors[status]}`} />
      <span className="text-xs text-zinc-400">{labels[status]}</span>
    </span>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            pct >= 90 ? 'bg-emerald-500' : pct >= 60 ? 'bg-blue-500' : 'bg-amber-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{pct}%</span>
    </div>
  );
}

function AlertIcon({ type }: { type: 'warning' | 'error' | 'info' }) {
  switch (type) {
    case 'error': return <XCircle size={16} className="text-red-400" />;
    case 'warning': return <AlertTriangle size={16} className="text-amber-400" />;
    case 'info': return <AlertCircle size={16} className="text-blue-400" />;
  }
}

function formatCurrency(n: number): string {
  if (n >= 10000000) return '¥' + (n / 10000000).toFixed(2) + '亿';
  if (n >= 10000) return '¥' + (n / 10000).toFixed(1) + '万';
  return '¥' + n.toLocaleString();
}

// ─── Main Component ─────────────────────────────────────────

export default function CeoDashboard() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefresh = useAutoRefresh({
    defaultInterval: 0,
    intervals: [0, 30, 60, 120, 300],
    onRefresh: () => handleRefresh(),
  });
  const [data, setData] = useState<ReturnType<typeof generateMockData> | null>(null);
  const [expandedCenter, setExpandedCenter] = useState<string | null>(null);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  const loadData = useCallback(async () => {
    // TODO: Replace with real API calls
    // const [centersRes, alertsRes, metricsRes] = await Promise.all([
    //   fetch('/api/ceo/centers', { headers: authHeaders() }),
    //   fetch('/api/ceo/alerts', { headers: authHeaders() }),
    //   fetch('/api/ceo/metrics', { headers: authHeaders() }),
    // ]);
    await new Promise(r => setTimeout(r, 600));
    setData(generateMockData());
  }, []);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
    toast.success('数据已刷新');
  };

  const visibleAlerts = useMemo(() => {
    if (!data) return [];
    return showAllAlerts ? data.alerts : data.alerts.filter(a => !a.resolved).slice(0, 3);
  }, [data, showAllAlerts]);

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">{'加载中...'}</span>
        </div>
      </div>
    );
  }

  const totalHeadcount = data.centers.reduce((s, c) => s + c.headcount, 0);
  const totalActiveToday = data.centers.reduce((s, c) => s + c.teams.reduce((ts, t) => ts + t.activeToday, 0), 0);

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-800/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <Eye size={20} className="text-blue-400" />
                CEO {'仪表盘'}
              </h1>
              <p className="text-xs text-zinc-500">
                {'游侠出海'} &middot; {'全局业务视图'} &middot; {totalActiveToday}/{totalHeadcount} {'人在线'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AutoRefreshControl {...autoRefresh} />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Today's Key Metrics */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Activity size={14} />
            {'今日关键指标'}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
            {data.todayMetrics.map((metric, i) => {
              const Icon = metric.icon;
              return (
                <div
                  key={i}
                  className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-3 hover:border-zinc-700/50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <Icon size={16} className={metric.color} />
                    <ChangeIndicator change={metric.change} />
                  </div>
                  <p className="text-lg font-bold text-zinc-100 tabular-nums">{metric.value}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">{metric.label}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* 7-Day Revenue Trend */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <TrendingUp size={14} className="text-blue-400" />
            {'近 7 天营收趋势'}
          </h2>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            <RevenueTrendChart />
          </div>
        </section>

        {/* Alert Panel */}
        {visibleAlerts.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-400" />
                {'异常预警'}
                <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full">
                  {data.alerts.filter(a => !a.resolved).length}
                </span>
              </h2>
              <button
                onClick={() => setShowAllAlerts(!showAllAlerts)}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showAllAlerts ? '收起' : '查看全部'}
              </button>
            </div>
            <div className="space-y-2">
              {visibleAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                    alert.type === 'error'
                      ? 'bg-red-500/5 border-red-500/20'
                      : alert.type === 'warning'
                      ? 'bg-amber-500/5 border-amber-500/20'
                      : 'bg-blue-500/5 border-blue-500/20'
                  }`}
                >
                  <AlertIcon type={alert.type} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-zinc-200">{alert.title}</p>
                      <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">{alert.center}</span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-0.5">{alert.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-zinc-600">{alert.time}</span>
                    <button
                      onClick={() => toast.success('已标记为已处理')}
                      className="text-[10px] text-zinc-500 hover:text-emerald-400 transition-colors"
                    >
                      <CheckCircle2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Milestone Roadmap */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Flag size={14} className="text-purple-400" />
            {'项目里程碑'}
            <span className="text-[10px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded-full">
              {data.milestones.filter((m: MilestoneItem) => m.status !== 'completed').length} {'进行中'}
            </span>
          </h2>
          <div className="space-y-3">
            {data.milestones.sort((a: MilestoneItem, b: MilestoneItem) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime()).map((ms: MilestoneItem) => {
              const deadlineDate = new Date(ms.deadline);
              const now = new Date();
              const daysLeft = Math.ceil((deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
              const statusConfig = {
                'completed': { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400', label: '已完成', barColor: 'bg-emerald-500' },
                'in-progress': { bg: 'bg-blue-500/10', border: 'border-blue-500/20', text: 'text-blue-400', label: '进行中', barColor: 'bg-blue-500' },
                'upcoming': { bg: 'bg-zinc-500/10', border: 'border-zinc-500/20', text: 'text-zinc-400', label: '待开始', barColor: 'bg-zinc-500' },
                'at-risk': { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400', label: '有风险', barColor: 'bg-red-500' },
              };
              const cfg = statusConfig[ms.status];
              const categoryColors = {
                tiktok: 'bg-pink-500/20 text-pink-400',
                coins: 'bg-yellow-500/20 text-yellow-400',
                ops: 'bg-cyan-500/20 text-cyan-400',
                tech: 'bg-violet-500/20 text-violet-400',
              };
              const categoryLabels = { tiktok: 'TikTok', coins: '金币', ops: '运营', tech: '技术' };
              return (
                <div key={ms.id} className={`${cfg.bg} border ${cfg.border} rounded-xl p-4 transition-all hover:border-zinc-600`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-zinc-100">{ms.title}</h3>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${categoryColors[ms.category]}`}>
                          {categoryLabels[ms.category]}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>
                          {cfg.label}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">{ms.description}</p>
                      <div className="flex items-center gap-4 mt-2">
                        <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                          <CalendarDays size={10} />
                          {'截止'}: {deadlineDate.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                        </span>
                        <span className={`text-[10px] font-medium ${
                          daysLeft <= 3 ? 'text-red-400' : daysLeft <= 7 ? 'text-amber-400' : 'text-zinc-500'
                        }`}>
                          {daysLeft > 0 ? `剩余 ${daysLeft} 天` : daysLeft === 0 ? '今天截止' : `已过期 ${Math.abs(daysLeft)} 天`}
                        </span>
                        <span className="text-[10px] text-zinc-500">{ms.owner}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <span className={`text-lg font-bold ${cfg.text}`}>{ms.progress}%</span>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${cfg.barColor}`}
                      style={{ width: `${ms.progress}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Quarterly Target Progress */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Target size={14} className="text-emerald-400" />
            {'季度目标追踪'}
            <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full">Q1 2026</span>
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: '季度GMV', current: 84.8, target: 100, unit: 'M', color: '#3b82f6' },
              { label: '新增KOL', current: 48, target: 60, unit: '', color: '#a855f7' },
              { label: '客服满意度', current: 92, target: 95, unit: '%', color: '#10b981' },
              { label: '损耗率控制', current: 82, target: 85, unit: '%', color: '#f59e0b' },
            ].map((item, i) => {
              const pct = Math.min(Math.round((item.current / item.target) * 100), 100);
              const r = 40;
              const c = 2 * Math.PI * r;
              const offset = c - (pct / 100) * c;
              return (
                <div key={i} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex flex-col items-center">
                  <svg width="100" height="100" viewBox="0 0 100 100" className="mb-2">
                    <circle cx="50" cy="50" r={r} fill="none" stroke="#27272a" strokeWidth="6" />
                    <circle
                      cx="50" cy="50" r={r} fill="none"
                      stroke={item.color} strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={c}
                      strokeDashoffset={offset}
                      transform="rotate(-90 50 50)"
                      className="transition-all duration-1000"
                    />
                    <text x="50" y="46" textAnchor="middle" className="fill-zinc-100 text-lg font-bold" style={{fontSize:'18px'}}>{pct}%</text>
                    <text x="50" y="62" textAnchor="middle" className="fill-zinc-500" style={{fontSize:'9px'}}>{item.current}{item.unit}/{item.target}{item.unit}</text>
                  </svg>
                  <span className="text-xs text-zinc-400 text-center">{item.label}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* 竞品价格监控 */}
        <PriceComparisonPanel />

        {/* 美区加白巡检时间轴 */}
        <InspectionTimeline />

        {/* 团队效率排行 */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Users size={14} className="text-cyan-400" />
            {'团队效率排行'}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400">{'本周'}</span>
          </h2>
          <div className="space-y-2">
            {[
              { team: '爬量引擎组', score: 92, tasks: 47, trend: 'up' as const },
              { team: '窜天火运营组', score: 88, tasks: 35, trend: 'up' as const },
              { team: 'TikTok 内容组', score: 85, tasks: 28, trend: 'stable' as const },
              { team: '客服中心', score: 79, tasks: 62, trend: 'down' as const },
              { team: '综合管理部', score: 75, tasks: 18, trend: 'stable' as const },
            ].map((t, i) => (
              <div key={i} className="flex items-center gap-3 group">
                <span className={`text-xs font-bold w-5 text-center ${
                  i === 0 ? 'text-amber-400' : i === 1 ? 'text-zinc-300' : i === 2 ? 'text-orange-400' : 'text-zinc-600'
                }`}>{i + 1}</span>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-zinc-300">{t.team}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500">{t.tasks} {'任务'}</span>
                      {t.trend === 'up' && <TrendingUp size={10} className="text-emerald-400" />}
                      {t.trend === 'down' && <TrendingDown size={10} className="text-red-400" />}
                      {t.trend === 'stable' && <span className="text-[10px] text-zinc-500">--</span>}
                      <span className={`text-xs font-bold ${
                        t.score >= 90 ? 'text-emerald-400' : t.score >= 80 ? 'text-cyan-400' : t.score >= 70 ? 'text-amber-400' : 'text-red-400'
                      }`}>{t.score}</span>
                    </div>
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${
                      t.score >= 90 ? 'bg-emerald-500' : t.score >= 80 ? 'bg-cyan-500' : t.score >= 70 ? 'bg-amber-500' : 'bg-red-500'
                    }`} style={{ width: `${t.score}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 本月大事记 */}
        <MonthlyChronicle />

        {/* Competitor Dynamics */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Globe size={14} className="text-orange-400" />
            {'竞品动态摘要'}
            <span className="text-[9px] bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded-full ml-auto">{'本周更新'}</span>
          </h2>
          <div className="space-y-2">
            {[
              { competitor: 'U7BUY', action: '下调原神初始号价格 5%', impact: 'high', time: '2天前' },
              { competitor: 'G2G', action: '新增 MLBB 钻石充值服务', impact: 'medium', time: '3天前' },
              { competitor: 'SEA Gamer', action: '印尼市场推出限时折扣', impact: 'high', time: '4天前' },
              { competitor: 'OffGamers', action: '上线 Free Fire 新充值渠道', impact: 'low', time: '5天前' },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 bg-zinc-800/30 rounded-lg px-3 py-2 hover:bg-zinc-800/50 transition-colors">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  item.impact === 'high' ? 'bg-red-400' : item.impact === 'medium' ? 'bg-amber-400' : 'bg-zinc-500'
                }`} />
                <span className="text-xs font-medium text-zinc-300 w-20 flex-shrink-0">{item.competitor}</span>
                <span className="text-xs text-zinc-400 flex-1">{item.action}</span>
                <span className="text-[10px] text-zinc-600 flex-shrink-0">{item.time}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Cash Flow Overview */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <DollarSign size={14} className="text-emerald-400" />
            {'资金流水概览'}
          </h2>
          <div className="grid grid-cols-3 gap-3 mb-3">
            {[
              { label: '本月收入', value: '$128.5K', change: '+12.3%', positive: true },
              { label: '本月支出', value: '$89.2K', change: '+5.1%', positive: false },
              { label: '净利润', value: '$39.3K', change: '+28.7%', positive: true },
            ].map((item, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-3 text-center">
                <div className="text-[10px] text-zinc-500 mb-1">{item.label}</div>
                <div className="text-lg font-bold text-zinc-100">{item.value}</div>
                <div className={`text-[10px] font-medium ${item.positive ? 'text-emerald-400' : 'text-red-400'}`}>{item.change}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {[
              { desc: 'Lootbar 充值收入', amount: '+$45,200', time: '今日 14:30', type: 'in' },
              { desc: '供应商 A 采购付款', amount: '-$12,800', time: '今日 11:00', type: 'out' },
              { desc: 'TikTok KOL 佣金结算', amount: '-$3,500', time: '今日 09:15', type: 'out' },
              { desc: 'CPS 渠道分成收入', amount: '+$8,900', time: '昨日 18:00', type: 'in' },
            ].map((tx, i) => (
              <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-zinc-800/30 transition-colors">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tx.type === 'in' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <span className="text-zinc-400 flex-1 truncate">{tx.desc}</span>
                <span className={`font-mono font-medium shrink-0 ${tx.type === 'in' ? 'text-emerald-400' : 'text-red-400'}`}>{tx.amount}</span>
                <span className="text-[10px] text-zinc-600 shrink-0 w-16 text-right">{tx.time}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Business Centers */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Building2 size={14} />
            {'三大业务中心'}
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {data.centers.map((center) => {
              const Icon = center.icon;
              const isExpanded = expandedCenter === center.id;
              return (
                <div
                  key={center.id}
                  className={`bg-zinc-900/50 border rounded-xl overflow-hidden transition-all duration-300 ${
                    isExpanded ? 'border-zinc-600 lg:col-span-3' : `${center.borderColor} hover:border-zinc-600`
                  }`}
                >
                  {/* Center Header */}
                  <div
                    className={`p-4 cursor-pointer ${center.bgColor}`}
                    onClick={() => setExpandedCenter(isExpanded ? null : center.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${center.bgColor}`}>
                          <Icon size={20} className={center.color} />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-100">{center.name}</h3>
                          <p className="text-[10px] text-zinc-500">{center.headcount} {'人'} &middot; {center.teams.length} {'个团队'}</p>
                        </div>
                      </div>
                      <ChevronRight
                        size={16}
                        className={`text-zinc-500 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                      />
                    </div>

                    {/* Quick Stats */}
                    {center.revenue > 0 && (
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <div>
                          <p className="text-[10px] text-zinc-500">{'今日营收'}</p>
                          <p className="text-sm font-bold text-zinc-100">{formatCurrency(center.revenue)}</p>
                          <ChangeIndicator change={center.revenueChange} />
                        </div>
                        <div>
                          <p className="text-[10px] text-zinc-500">{'今日订单'}</p>
                          <p className="text-sm font-bold text-zinc-100">{center.orders.toLocaleString()}</p>
                          <ChangeIndicator change={center.ordersChange} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Expanded: Team Details */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800/50">
                      {/* Teams Table */}
                      <div className="p-4">
                        <h4 className="text-xs font-medium text-zinc-400 mb-3">{'团队状态'}</h4>
                        <div className="space-y-3">
                          {center.teams.map((team, i) => (
                            <div key={i} className="bg-zinc-800/30 rounded-lg p-3">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium text-zinc-200">{team.name}</span>
                                  <StatusDot status={team.status} />
                                </div>
                                <span className="text-xs text-zinc-500">
                                  {team.activeToday}/{team.headcount} {'人在线'}
                                </span>
                              </div>
                              <ProgressBar completed={team.tasksCompleted} total={team.tasksTotal} />
                              <p className="text-[10px] text-zinc-500 mt-1">
                                {'今日完成'} {team.tasksCompleted}/{team.tasksTotal} {'项任务'}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Highlights */}
                      <div className="px-4 pb-4">
                        <h4 className="text-xs font-medium text-zinc-400 mb-2">{'今日亮点'}</h4>
                        <div className="space-y-1.5">
                          {center.highlights.map((h, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <Sparkles size={12} className={center.color + ' mt-0.5 shrink-0'} />
                              <p className="text-xs text-zinc-300">{h}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* All Teams Overview Table */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Users size={14} />
            {'全部团队一览'}
          </h2>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800/50">
                    <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'团队'}</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'所属中心'}</th>
                    <th className="text-center px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'人数'}</th>
                    <th className="text-center px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'在线'}</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'任务进度'}</th>
                    <th className="text-center px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'状态'}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.centers.flatMap(c => c.teams).map((team, i) => (
                    <tr key={i} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                      <td className="px-4 py-2.5 text-zinc-200 font-medium">{team.name}</td>
                      <td className="px-4 py-2.5 text-zinc-400">{team.center}</td>
                      <td className="px-4 py-2.5 text-center text-zinc-300">{team.headcount}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={team.activeToday >= team.headcount * 0.8 ? 'text-emerald-400' : 'text-amber-400'}>
                          {team.activeToday}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 w-40">
                        <ProgressBar completed={team.tasksCompleted} total={team.tasksTotal} />
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <StatusDot status={team.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Quick Actions */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Zap size={14} />
            {'快捷操作'}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: '查看KOL管理', icon: Crown, color: 'text-yellow-400', bg: 'bg-yellow-500/10', href: '/kols' },
              { label: '查看工单系统', icon: Headphones, color: 'text-orange-400', bg: 'bg-orange-500/10', href: '/tickets' },
              { label: '数据分析', icon: BarChart3, color: 'text-blue-400', bg: 'bg-blue-500/10', href: '/data-analytics' },
              { label: '日报分析', icon: Clock, color: 'text-emerald-400', bg: 'bg-emerald-500/10', href: '/daily-reports' },
              { label: 'TikTok合作伙伴', icon: Globe, color: 'text-pink-400', bg: 'bg-pink-500/10', href: '/tiktok-partners' },
              { label: 'TikTok文案生成', icon: Sparkles, color: 'text-violet-400', bg: 'bg-violet-500/10', href: '/tiktok-scripts' },
              { label: '库存监控', icon: Package, color: 'text-red-400', bg: 'bg-red-500/10', href: '/inventory' },
              { label: '管理控制台', icon: Shield, color: 'text-cyan-400', bg: 'bg-cyan-500/10', href: '/admin' },
            ].map((action, i) => {
              const Icon = action.icon;
              return (
                <button
                  key={i}
                  onClick={() => navigate(action.href)}
                  className={`flex items-center gap-3 p-3 rounded-xl border border-zinc-800/50 ${action.bg} hover:border-zinc-600 transition-colors text-left`}
                >
                  <Icon size={18} className={action.color} />
                  <span className="text-sm text-zinc-200">{action.label}</span>
                  <ChevronRight size={14} className="text-zinc-600 ml-auto" />
                </button>
              );
            })}
          </div>
        </section>

        {/* Inventory Alert Summary */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Package size={14} className="text-red-400" />
            {'库存预警概览'}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-red-400" />
                <span className="text-xs text-red-400 font-medium">{'紧急补货'}</span>
              </div>
              <p className="text-lg font-bold text-zinc-100">FC金币 (美区)</p>
              <p className="text-xs text-zinc-400 mt-1">{'当前 1.25万 / 安全线 5万'}</p>
              <p className="text-xs text-red-400 mt-1">{'仅剩 1.5 天库存'}</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-zinc-500">{'建议补货'}</span>
                <span className="text-xs font-bold text-amber-400">5万枚</span>
              </div>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle size={14} className="text-amber-400" />
                <span className="text-xs text-amber-400 font-medium">{'偏低库存'}</span>
              </div>
              <p className="text-lg font-bold text-zinc-100">3 个 SKU</p>
              <p className="text-xs text-zinc-400 mt-1">FC金币(欧区)、GP $10、PS $20</p>
              <p className="text-xs text-amber-400 mt-1">{'平均剩余 4.3 天'}</p>
              <button onClick={() => navigate('/inventory')} className="mt-2 text-[10px] text-blue-400 hover:text-blue-300">{'查看详情 →'}</button>
            </div>
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">{'库存充足'}</span>
              </div>
              <p className="text-lg font-bold text-zinc-100">6 个 SKU</p>
              <p className="text-xs text-zinc-400 mt-1">Steam、Apple、Nintendo 等</p>
              <p className="text-xs text-emerald-400 mt-1">{'平均剩余 12+ 天'}</p>
              <div className="mt-2 text-[10px] text-zinc-500">{'无需操作'}</div>
            </div>
          </div>
        </section>

        {/* Today's Todo */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Target size={14} className="text-blue-400" />
            {'今日待办'}
            <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full ml-auto">3/7 {'已完成'}</span>
          </h2>
          <div className="space-y-1.5">
            {[
              { text: '审批美区 FC 金币补货订单 (5万枚)', done: true, priority: 'high' },
              { text: '检查 TikTok KOL @GameMaster 合作合同续签', done: true, priority: 'medium' },
              { text: '回复客服工单 #TK-0312 (欧区充值异常)', done: true, priority: 'high' },
              { text: '确认本周日报数据归档', done: false, priority: 'medium' },
              { text: '与供应商 B 沟通 Google Play 价格调整', done: false, priority: 'high' },
              { text: '安排下周 KOL 拍摄计划', done: false, priority: 'low' },
              { text: '更新季度 OKR 进度报告', done: false, priority: 'medium' },
            ].map((item, i) => (
              <div key={i} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                item.done ? 'bg-zinc-800/20' : 'bg-zinc-800/40 hover:bg-zinc-800/60'
              }`}>
                <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                  item.done ? 'bg-emerald-500/20 border-emerald-500/50' : 'border-zinc-600'
                }`}>
                  {item.done && <CheckCircle2 size={10} className="text-emerald-400" />}
                </div>
                <span className={`text-xs flex-1 ${
                  item.done ? 'text-zinc-500 line-through' : 'text-zinc-300'
                }`}>{item.text}</span>
                <span className={`text-[8px] px-1.5 py-0.5 rounded ${
                  item.priority === 'high' ? 'bg-red-500/15 text-red-400' :
                  item.priority === 'medium' ? 'bg-amber-500/15 text-amber-400' :
                  'bg-zinc-500/15 text-zinc-500'
                }`}>{item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Footer note */}
        {/* Customer Satisfaction NPS */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Star size={14} className="text-yellow-400" />
            {'客户满意度 (NPS)'}
          </h2>
          <div className="flex items-center gap-6 mb-4">
            <div className="text-center">
              <div className="text-4xl font-bold text-emerald-400">72</div>
              <div className="text-[10px] text-zinc-500">NPS {'评分'}</div>
            </div>
            <div className="flex-1 space-y-2">
              {[
                { label: '推荐者', pct: 78, color: 'bg-emerald-500', count: 156 },
                { label: '中立者', pct: 16, color: 'bg-amber-500', count: 32 },
                { label: '贬损者', pct: 6, color: 'bg-red-500', count: 12 },
              ].map((seg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-500 w-14 shrink-0">{seg.label}</span>
                  <div className="flex-1 h-3 bg-zinc-800 rounded-full overflow-hidden">
                    <div className={`h-full ${seg.color} rounded-full`} style={{ width: `${seg.pct}%` }} />
                  </div>
                  <span className="text-[10px] text-zinc-400 w-12 text-right">{seg.pct}% ({seg.count})</span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: '响应速度', score: 4.5, max: 5 },
              { label: '产品质量', score: 4.3, max: 5 },
              { label: '价格竞争力', score: 4.1, max: 5 },
              { label: '售后服务', score: 4.6, max: 5 },
            ].map((dim, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-2 text-center">
                <div className="text-[10px] text-zinc-500 mb-1">{dim.label}</div>
                <div className="text-sm font-bold text-zinc-200">{dim.score}<span className="text-[10px] text-zinc-600">/{dim.max}</span></div>
                <div className="mt-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
                  <div className="h-full bg-yellow-500 rounded-full" style={{ width: `${(dim.score / dim.max) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Risk Warning */}
        <section className="bg-zinc-900/50 border border-red-900/30 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Shield size={14} className="text-red-400" />
            {'风险预警'}
          </h2>
          <div className="space-y-2">
            {[
              { level: 'high', title: '汇率波动预警', desc: 'USD/CNY 近 7 天波动超过 1.2%，影响充值利润率', time: '2h 前' },
              { level: 'medium', title: '供应商交付延迟', desc: 'CPS 供应商 B 近 3 单平均延迟 2.1 天', time: '5h 前' },
              { level: 'low', title: '合规更新提醒', desc: '印尼游戏充值新规将于 4/1 生效，需调整 KYC 流程', time: '1d 前' },
              { level: 'medium', title: 'API 错误率上升', desc: 'Lootbar API 近 24h 错误率从 0.3% 升至 1.8%', time: '3h 前' },
            ].map((r, i) => (
              <div key={i} className={`flex items-start gap-3 p-2.5 rounded-lg border ${
                r.level === 'high' ? 'border-red-800/50 bg-red-950/20' :
                r.level === 'medium' ? 'border-amber-800/50 bg-amber-950/20' :
                'border-zinc-800/50 bg-zinc-900/30'
              }`}>
                <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                  r.level === 'high' ? 'bg-red-500 animate-pulse' :
                  r.level === 'medium' ? 'bg-amber-500' : 'bg-blue-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-200 font-medium">{r.title}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                      r.level === 'high' ? 'bg-red-500/20 text-red-400' :
                      r.level === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-blue-500/20 text-blue-400'
                    }`}>{r.level === 'high' ? '高' : r.level === 'medium' ? '中' : '低'}</span>
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{r.desc}</div>
                </div>
                <span className="text-[10px] text-zinc-600 shrink-0">{r.time}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Market Share Visualization */}
        <section className="bg-zinc-900/50 border border-indigo-500/20 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Globe size={14} className="text-indigo-400" />
            {'市场份额分布'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 ml-auto">Q1 2026</span>
          </h2>
          {/* Donut Chart SVG */}
          <div className="flex items-center gap-4 mb-3">
            <div className="relative w-28 h-28 shrink-0">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                {[
                  { pct: 32, offset: 0, color: '#818cf8' },
                  { pct: 24, offset: 32, color: '#f59e0b' },
                  { pct: 18, offset: 56, color: '#10b981' },
                  { pct: 14, offset: 74, color: '#f43f5e' },
                  { pct: 12, offset: 88, color: '#64748b' },
                ].map((seg, i) => (
                  <circle key={i} cx="50" cy="50" r="40" fill="none" stroke={seg.color} strokeWidth="12"
                    strokeDasharray={`${seg.pct * 2.51} ${251 - seg.pct * 2.51}`}
                    strokeDashoffset={`${-seg.offset * 2.51}`} className="transition-all" />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-bold text-indigo-400">32%</span>
                <span className="text-[8px] text-zinc-500">{'我们'}</span>
              </div>
            </div>
            <div className="flex-1 space-y-1.5">
              {[
                { name: 'RangerAI (我们)', share: 32, trend: '+3.2%', color: 'bg-indigo-500' },
                { name: 'Codashop', share: 24, trend: '-1.1%', color: 'bg-amber-500' },
                { name: 'UniPin', share: 18, trend: '+0.5%', color: 'bg-emerald-500' },
                { name: 'Razer Gold', share: 14, trend: '-0.8%', color: 'bg-rose-500' },
                { name: '其他', share: 12, trend: '+0.2%', color: 'bg-zinc-500' },
              ].map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${c.color}`} />
                  <span className="text-[10px] text-zinc-300 flex-1">{c.name}</span>
                  <span className="text-[10px] text-zinc-400 w-8 text-right">{c.share}%</span>
                  <span className={`text-[9px] w-10 text-right ${c.trend.startsWith('+') ? 'text-emerald-400' : 'text-red-400'}`}>{c.trend}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-2.5">
            <div className="text-[10px] text-zinc-500 mb-1">{'关键洞察'}</div>
            <div className="text-[10px] text-zinc-400">{'本季度市场份额提升 3.2%，主要得益于印尼市场拓展和 TikTok KOL 合作带来的新客流量。Codashop 份额下降主因其印尼定价策略调整延迟。'}</div>
          </div>
        </section>

        {/* Cross-Center Collaboration Board */}
        <section className="bg-zinc-900/50 border border-indigo-500/20 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <GitBranch size={14} className="text-indigo-400" />
            {'跨中心协同看板'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">{'本周'}</span>
          </h2>
          {/* Center Connection Diagram */}
          <div className="flex items-center justify-center gap-2 mb-4">
            {[
              { name: '爆量引擎', color: 'border-cyan-500/40 bg-cyan-500/10', text: 'text-cyan-400' },
              { name: '窜天火', color: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-400' },
              { name: '综合管理', color: 'border-emerald-500/40 bg-emerald-500/10', text: 'text-emerald-400' },
            ].map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className={`px-3 py-1.5 rounded-lg border ${c.color}`}>
                  <span className={`text-[10px] font-medium ${c.text}`}>{c.name}</span>
                </div>
                {i < 2 && <ArrowRightLeft size={12} className="text-zinc-600" />}
              </div>
            ))}
          </div>
          {/* Collaboration Tasks */}
          <div className="space-y-2">
            {[
              { task: '印尼 FC 币定价策略协调', from: '爆量引擎', to: '综合管理', status: 'active', progress: 75, priority: 'high' },
              { task: 'TikTok KOL 合作内容审核流程', from: '窜天火', to: '综合管理', status: 'active', progress: 45, priority: 'medium' },
              { task: '库存共享调度系统对接', from: '爆量引擎', to: '窜天火', status: 'pending', progress: 20, priority: 'high' },
              { task: 'Q2 联合营销活动策划', from: '爆量引擎', to: '窜天火', status: 'active', progress: 60, priority: 'medium' },
              { task: '客服工单转派自动化', from: '综合管理', to: '爆量引擎', status: 'completed', progress: 100, priority: 'low' },
            ].map((t, i) => (
              <div key={i} className={`flex items-center gap-3 bg-zinc-800/30 rounded-lg px-3 py-2 transition-colors hover:bg-zinc-800/50 ${
                t.status === 'completed' ? 'opacity-60' : ''
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  t.status === 'completed' ? 'bg-emerald-500' : t.status === 'active' ? 'bg-indigo-500 animate-pulse' : 'bg-zinc-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-zinc-300 truncate">{t.task}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[9px] text-zinc-600">{t.from} → {t.to}</span>
                    <span className={`text-[8px] px-1 py-0.5 rounded ${
                      t.priority === 'high' ? 'bg-red-500/20 text-red-400' :
                      t.priority === 'medium' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-zinc-700/50 text-zinc-500'
                    }`}>{t.priority === 'high' ? '高' : t.priority === 'medium' ? '中' : '低'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-16 bg-zinc-700 rounded-full h-1 overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${
                      t.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-500'
                    }`} style={{ width: `${t.progress}%` }} />
                  </div>
                  <span className="text-[9px] text-zinc-500 w-7 text-right">{t.progress}%</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-800/50">
            <span className="text-[10px] text-zinc-500">{'进行中'}: 3 · {'待启动'}: 1 · {'已完成'}: 1</span>
            <span className="text-[10px] text-indigo-400">{'平均进度'}: 60%</span>
          </div>
        </section>

        <div className="text-center py-4">
          <p className="text-[10px] text-zinc-600">
            {'数据来源：Mock 数据（待对接库存系统、客服系统、钉钉 API）'}
          </p>
        </div>
      </main>
    </div>
  );
}


// ─── Price Comparison Panel ─────────────────────────────────

interface PriceItem {
  game: string;
  currency: string;
  our_price: number;
  competitor_price: number;
  competitor: string;
  region: string;
  updated_at: string;
}

function MonthlyChronicle() {
  const [expanded, setExpanded] = useState(false);
  const events = [
    { date: '03-10', title: '前端 Iter-17 部署', type: 'deploy' as const, desc: 'SKU排行榜+SLA倒计时+协议管道' },
    { date: '03-09', title: 'admin 用户安全加固', type: 'security' as const, desc: '禁用root SSH，改用admin+sudo' },
    { date: '03-08', title: '美区 FC 金币库存告急', type: 'alert' as const, desc: '剩余仅 1.5 天，已紧急补货' },
    { date: '03-07', title: 'ACP Bridge 上线', type: 'feature' as const, desc: '钉钉机器人 + API 网关对接完成' },
    { date: '03-05', title: 'TikTok 合作伙伴新增 3 人', type: 'business' as const, desc: '印尼+泰国市场拓展' },
    { date: '03-03', title: '月度损耗率报告发布', type: 'report' as const, desc: '2月损耗率 17%，环比下降 2.3%' },
    { date: '03-01', title: 'Q1 目标复盘', type: 'meeting' as const, desc: '营收完成 68%，订单完成 72%' },
  ];
  const typeColors: Record<string, string> = {
    deploy: 'bg-blue-500', security: 'bg-red-500', alert: 'bg-amber-500',
    feature: 'bg-emerald-500', business: 'bg-purple-500', report: 'bg-cyan-500', meeting: 'bg-pink-500',
  };
  const shown = expanded ? events : events.slice(0, 4);
  return (
    <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
          <CalendarDays size={14} className="text-violet-400" />
          {'本月大事记'}
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400">3月</span>
        </h2>
        <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-zinc-500 hover:text-zinc-300 transition">
          {expanded ? '收起' : `全部 ${events.length} 条`}
        </button>
      </div>
      <div className="relative">
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-zinc-800" />
        <div className="space-y-3">
          {shown.map((e, i) => (
            <div key={i} className="flex items-start gap-3 group">
              <div className={`w-[15px] h-[15px] rounded-full ${typeColors[e.type] || 'bg-zinc-600'} shrink-0 mt-0.5 ring-2 ring-zinc-950`} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-zinc-600 font-mono">{e.date}</span>
                  <span className="text-xs text-zinc-200 font-medium">{e.title}</span>
                </div>
                <p className="text-[10px] text-zinc-500 mt-0.5">{e.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PriceComparisonPanel() {
  const [prices, setPrices] = useState<PriceItem[]>([]);
  const [summary, setSummary] = useState<{ total_games: number; avg_savings_pct: number; best_deal: { game: string; savings: number } } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats/market-prices', { headers: authHeaders() })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setPrices(data.data);
          setSummary(data.summary);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <section>
        <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
          <DollarSign size={14} />
          竞品价格监控
        </h2>
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 animate-pulse">
          <div className="h-4 bg-zinc-800 rounded w-1/3 mb-4" />
          <div className="h-32 bg-zinc-800 rounded" />
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
        <DollarSign size={14} />
        竞品价格监控
        {summary && (
          <span className="text-[10px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full ml-2">
            平均节省 {summary.avg_savings_pct}%
          </span>
        )}
      </h2>
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
        {/* Summary Bar */}
        {summary && (
          <div className="px-4 py-3 border-b border-zinc-800/50 flex items-center gap-4 text-xs">
            <span className="text-zinc-400">监控 <span className="text-white font-medium">{summary.total_games}</span> 款游戏</span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-400">最优价差: <span className="text-green-400 font-medium">{summary.best_deal.game} (-{summary.best_deal.savings}%)</span></span>
          </div>
        )}
        {/* Price Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800/50">
                <th className="text-left px-4 py-2 text-zinc-500 font-medium">游戏</th>
                <th className="text-left px-4 py-2 text-zinc-500 font-medium">货币</th>
                <th className="text-right px-4 py-2 text-zinc-500 font-medium">我方价格</th>
                <th className="text-right px-4 py-2 text-zinc-500 font-medium">竞品价格</th>
                <th className="text-left px-4 py-2 text-zinc-500 font-medium">竞品</th>
                <th className="text-right px-4 py-2 text-zinc-500 font-medium">价差</th>
                <th className="text-left px-4 py-2 text-zinc-500 font-medium">区域</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p, i) => {
                const savings = ((p.competitor_price - p.our_price) / p.competitor_price * 100).toFixed(1);
                const isGood = p.our_price < p.competitor_price;
                return (
                  <tr key={i} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                    <td className="px-4 py-2.5 text-white font-medium">{p.game}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{p.currency}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={isGood ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                        ${p.our_price.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">${p.competitor_price.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-zinc-500">{p.competitor}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        isGood ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                      }`}>
                        {isGood ? <TrendingDown size={10} /> : <TrendingUp size={10} />}
                        {isGood ? '-' : '+'}{Math.abs(parseFloat(savings))}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">{p.region}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Footer */}
        <div className="px-4 py-2 border-t border-zinc-800/50 text-[10px] text-zinc-600">
          数据来源: 竞品价格抓取脚本 (u7buy.py) · 更新频率: 每 4 小时
        </div>
      </div>
    </section>
  );
}


// ─── Inspection Timeline ──────────────────────────────────

function InspectionTimeline() {
  const [logs, setLogs] = useState<Array<{
    id: number;
    date: string;
    event: string;
    status: string;
    progress: number;
    details?: string;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Try to fetch from API first, fallback to mock data
    fetch('/api/system/inspection-logs', { headers: authHeaders() })
      .then(res => {
        if (!res.ok) throw new Error('API not available');
        return res.json();
      })
      .then(data => {
        if (data.data && data.data.length > 0) {
          setLogs(data.data);
        } else {
          setLogs(getMockInspectionLogs());
        }
      })
      .catch(() => {
        setLogs(getMockInspectionLogs());
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
        <Shield size={14} />
        美区 TikTok Shop 加白巡检
      </h2>
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-xs text-zinc-300">joypay_US 店铺加白进度</span>
          </div>
          <span className="text-xs text-zinc-500">目标: 2026-03-25</span>
        </div>

        {/* Progress Bar */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-zinc-400">总体进度</span>
            <span className="text-xs font-mono text-amber-400">
              {logs.length > 0 ? `${logs[logs.length - 1].progress}%` : '0%'}
            </span>
          </div>
          <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 rounded-full transition-all duration-1000"
              style={{ width: `${logs.length > 0 ? logs[logs.length - 1].progress : 0}%` }}
            />
          </div>
        </div>

        {/* Timeline */}
        {loading ? (
          <div className="px-4 py-6 text-center">
            <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        ) : (
          <div className="px-4 pb-4 space-y-0">
            {logs.map((log, i) => {
              const isLatest = i === logs.length - 1;
              const statusColor = log.status === '已完成' ? 'bg-emerald-500' :
                                  log.status === '处理中' ? 'bg-amber-500' :
                                  log.status === '审核中' ? 'bg-blue-500' :
                                  log.status === '等待中' ? 'bg-zinc-500' : 'bg-zinc-600';
              const statusIcon = log.status === '已完成' ? '✓' :
                                 log.status === '审核中' ? '…' :
                                 log.status === '处理中' ? '▶' : '○';
              return (
                <div key={log.id} className={`flex gap-3 group cursor-pointer transition-all ${isLatest ? 'bg-amber-500/5 -mx-4 px-4 rounded-lg' : ''}`}>
                  {/* Timeline dot & line */}
                  <div className="flex flex-col items-center">
                    <div className={`w-3 h-3 rounded-full ${statusColor} ${isLatest ? 'ring-2 ring-offset-1 ring-offset-zinc-900 ring-amber-500/50 animate-pulse' : ''} shrink-0 mt-1.5 flex items-center justify-center`}>
                      <span className="text-[6px] text-white font-bold">{statusIcon}</span>
                    </div>
                    {i < logs.length - 1 && <div className={`w-px flex-1 my-1 ${log.status === '已完成' ? 'bg-emerald-800' : 'bg-zinc-800'}`} />}
                  </div>
                  {/* Content */}
                  <div className={`pb-3 flex-1 ${isLatest ? '' : 'opacity-70 group-hover:opacity-100 transition-opacity'}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-zinc-500 font-mono">{log.date}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                        log.status === '已完成' ? 'bg-emerald-500/20 text-emerald-400' :
                        log.status === '处理中' ? 'bg-amber-500/20 text-amber-400' :
                        log.status === '审核中' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-zinc-500/20 text-zinc-400'
                      }`}>{log.status}</span>
                      <span className="text-[10px] text-zinc-500">+{log.progress - (i > 0 ? logs[i-1].progress : 0)}%</span>
                      {isLatest && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 animate-pulse">{'最新'}</span>}
                    </div>
                    <p className="text-xs text-zinc-300 mt-0.5 font-medium">{log.event}</p>
                    {log.details && (
                      <p className="text-[10px] text-zinc-500 mt-1 pl-2 border-l border-zinc-800 group-hover:border-zinc-600 transition-colors">{log.details}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2 border-t border-zinc-800/50 text-[10px] text-zinc-600 flex items-center justify-between">
          <span>数据来源: /api/system/inspection-logs</span>
          <span>距离目标: {Math.max(0, Math.ceil((new Date('2026-03-25').getTime() - Date.now()) / 86400000))} 天</span>
        </div>
      </div>
    </section>
  );
}

// ─── Revenue Trend Chart (CSS-only mini bar chart) ─────────

function RevenueTrendChart() {
  const days = useMemo(() => {
    const result = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const base = 7500000 + Math.random() * 2000000;
      const orders = 55000 + Math.floor(Math.random() * 15000);
      result.push({
        date: d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
        weekday: d.toLocaleDateString('zh-CN', { weekday: 'short' }),
        revenue: Math.round(base),
        orders,
        isToday: i === 0,
      });
    }
    return result;
  }, []);

  const maxRevenue = Math.max(...days.map(d => d.revenue));

  return (
    <div>
      {/* Summary row */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="text-xs text-zinc-500">{'周总营收'}</span>
          <p className="text-xl font-bold text-zinc-100">
            ¥{(days.reduce((s, d) => s + d.revenue, 0) / 10000).toFixed(1)}{'万'}
          </p>
        </div>
        <div className="text-right">
          <span className="text-xs text-zinc-500">{'周总订单'}</span>
          <p className="text-xl font-bold text-zinc-100">
            {days.reduce((s, d) => s + d.orders, 0).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Bar chart */}
      <div className="flex items-end gap-2 h-32">
        {days.map((day, i) => {
          const pct = (day.revenue / maxRevenue) * 100;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              {/* Tooltip on hover */}
              <div className="opacity-0 group-hover:opacity-100 transition-opacity text-center mb-1">
                <p className="text-[10px] text-zinc-300 font-medium">¥{(day.revenue / 10000).toFixed(1)}{'万'}</p>
                <p className="text-[9px] text-zinc-500">{day.orders.toLocaleString()} {'单'}</p>
              </div>
              {/* Bar */}
              <div className="w-full flex-1 flex items-end">
                <div
                  className={`w-full rounded-t transition-all duration-500 ${
                    day.isToday
                      ? 'bg-gradient-to-t from-blue-600 to-blue-400'
                      : 'bg-zinc-700 group-hover:bg-zinc-600'
                  }`}
                  style={{ height: `${pct}%` }}
                />
              </div>
              {/* Label */}
              <span className={`text-[10px] ${
                day.isToday ? 'text-blue-400 font-medium' : 'text-zinc-600'
              }`}>
                {day.isToday ? '今天' : day.weekday}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getMockInspectionLogs() {
  return [
    {
      id: 1,
      date: '2026-03-05',
      event: '启动美区 joypay_US 店铺 TikTok Shop 加白申请流程',
      status: '已完成',
      progress: 5,
      details: '提交初始申请材料，包括营业执照、品牌授权书'
    },
    {
      id: 2,
      date: '2026-03-08',
      event: '美区 joypay_US 店铺资料提交，状态：审核中',
      status: '已完成',
      progress: 10,
      details: 'TikTok 平台已接收材料，进入初审队列'
    },
    {
      id: 3,
      date: '2026-03-09',
      event: '收到 TikTok 站内信，要求补交一级授权文件',
      status: '已完成',
      progress: 15,
      details: '平台要求提供品牌方一级代理授权证明'
    },
    {
      id: 4,
      date: '2026-03-10',
      event: '授权文件已重新上传，等待 1 级授权最终决策',
      status: '审核中',
      progress: 20,
      details: '已联系品牌方获取正式授权函，预计 3 个工作日内反馈'
    },
  ];
}
