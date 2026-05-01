/**
 * GlobalDashboard — 全局仪表盘首页
 * 根据 admin/user 角色权限分级展示不同的 KPI、快速入口和功能面板
 */

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useSimpleAuth } from '../hooks/useSimpleAuth';
import { useI18n } from '../lib/i18n';
import { toast } from 'sonner';
import { getAuthToken } from '../lib/api';
import {
  MessageSquare, BarChart3, Package, Users, Ticket, Crown,
  Globe, FileText, Zap, Clock, TrendingUp, AlertTriangle,
  CheckCircle2, ArrowRight, Star, Pin, PinOff, Sparkles,
  Activity, Eye, Headphones, BookOpen, ListTodo, Settings,
  Gauge, CalendarDays, Shield, ShieldCheck, User as UserIcon,
  Server, Database, Cpu, HardDrive, ClipboardList, Bell
} from 'lucide-react';

/* ─── Types ─── */
interface QuickEntry {
  id: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  path: string;
  color: string;
  bg: string;
  pinned: boolean;
  adminOnly?: boolean;
}

interface KpiMetric {
  label: string;
  value: string;
  change: string;
  up: boolean;
  icon: React.ReactNode;
  adminOnly?: boolean;
}

/* ─── Quick Entry Definitions ─── */
const ALL_ENTRIES: Omit<QuickEntry, 'pinned'>[] = [
  { id: 'chat', label: 'AI 助手', desc: '多模型对话', icon: <MessageSquare size={18} />, path: '/', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  { id: 'ceo', label: 'CEO 仪表盘', desc: '全局业务视图', icon: <Eye size={18} />, path: '/ceo', color: 'text-purple-400', bg: 'bg-purple-500/10', adminOnly: true },
  { id: 'analytics', label: '数据分析', desc: '营收与趋势', icon: <BarChart3 size={18} />, path: '/data-analytics', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  { id: 'inventory', label: '库存监控', desc: '实时库存管理', icon: <Package size={18} />, path: '/inventory', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  { id: 'price-monitor', label: 'FC26 价格', desc: '竞品价格对比', icon: <TrendingUp size={18} />, path: '/price-monitor', color: 'text-sky-400', bg: 'bg-sky-500/10' },
  { id: 'tickets', label: '工单管理', desc: '客服工单处理', icon: <Ticket size={18} />, path: '/tickets', color: 'text-red-400', bg: 'bg-red-500/10' },
  { id: 'kols', label: 'KOL 管理', desc: '达人合作管理', icon: <Crown size={18} />, path: '/kols', color: 'text-pink-400', bg: 'bg-pink-500/10' },
  { id: 'tiktok', label: 'TikTok 运营', desc: '平台数据分析', icon: <Globe size={18} />, path: '/tiktok-partners', color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  { id: 'reports', label: '日报分析', desc: '每日运营报告', icon: <FileText size={18} />, path: '/daily-reports', color: 'text-orange-400', bg: 'bg-orange-500/10' },
  { id: 'team', label: '团队管理', desc: '成员与绩效', icon: <Users size={18} />, path: '/team', color: 'text-indigo-400', bg: 'bg-indigo-500/10', adminOnly: true },
  { id: 'workflows', label: '工作流', desc: '自动化流程', icon: <Zap size={18} />, path: '/workflows', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  { id: 'tasks', label: '任务队列', desc: '异步任务管理', icon: <ListTodo size={18} />, path: '/tasks', color: 'text-teal-400', bg: 'bg-teal-500/10' },
  { id: 'knowledge', label: '知识库', desc: '文档与知识', icon: <BookOpen size={18} />, path: '/knowledge', color: 'text-violet-400', bg: 'bg-violet-500/10' },
  { id: 'scripts', label: 'TikTok 脚本', desc: '内容脚本生成', icon: <Sparkles size={18} />, path: '/tiktok-scripts', color: 'text-rose-400', bg: 'bg-rose-500/10' },
  { id: 'ops', label: '运营效率', desc: '人效与瓶颈', icon: <Gauge size={18} />, path: '/ops-efficiency', color: 'text-lime-400', bg: 'bg-lime-500/10', adminOnly: true },
  { id: 'admin', label: '管理面板', desc: '系统管理', icon: <Shield size={18} />, path: '/admin', color: 'text-red-400', bg: 'bg-red-500/10', adminOnly: true },
  { id: 'prompts', label: '提示词库', desc: 'AI 提示词管理', icon: <Settings size={18} />, path: '/prompts', color: 'text-zinc-400', bg: 'bg-zinc-500/10', adminOnly: true },
];

const ADMIN_DEFAULT_PINNED = ['chat', 'ceo', 'analytics', 'inventory', 'tickets', 'kols'];
const USER_DEFAULT_PINNED = ['chat', 'analytics', 'tickets', 'kols', 'tiktok', 'knowledge'];

/* ─── Component ─── */
export default function GlobalDashboard() {
  const [, navigate] = useLocation();
  const { user } = useSimpleAuth();
  const { t } = useI18n();

  const isAdmin = user?.role === 'admin';
  const defaultPinned = isAdmin ? ADMIN_DEFAULT_PINNED : USER_DEFAULT_PINNED;
  const storageKey = `dashboard-pinned-${isAdmin ? 'admin' : 'user'}`;

  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : defaultPinned;
    } catch { return defaultPinned; }
  });

  // Filter entries by role
  const visibleEntries = useMemo(() =>
    ALL_ENTRIES.filter(e => isAdmin || !e.adminOnly),
    [isAdmin]
  );

  const entries: QuickEntry[] = useMemo(() =>
    visibleEntries.map(e => ({ ...e, pinned: pinnedIds.includes(e.id) })),
    [pinnedIds, visibleEntries]
  );

  const pinnedEntries = entries.filter(e => e.pinned);
  const otherEntries = entries.filter(e => !e.pinned);

  const togglePin = (id: string) => {
    setPinnedIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      toast.success(prev.includes(id) ? '已取消置顶' : '已置顶');
      return next;
    });
  };

  /* ─── Drag & Drop Reorder for Pinned Entries ─── */
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);

  const handleDragStart = useCallback((id: string) => {
    dragItem.current = id;
    setDragActiveId(id);
  }, []);

  const handleDragEnter = useCallback((id: string) => {
    dragOverItem.current = id;
  }, []);

  const handleDragEnd = useCallback(() => {
    if (!dragItem.current || !dragOverItem.current || dragItem.current === dragOverItem.current) {
      setDragActiveId(null);
      return;
    }
    setPinnedIds(prev => {
      const newList = [...prev];
      const fromIdx = newList.indexOf(dragItem.current!);
      const toIdx = newList.indexOf(dragOverItem.current!);
      if (fromIdx === -1 || toIdx === -1) return prev;
      newList.splice(fromIdx, 1);
      newList.splice(toIdx, 0, dragItem.current!);
      try { localStorage.setItem(storageKey, JSON.stringify(newList)); } catch {}
      return newList;
    });
    dragItem.current = null;
    dragOverItem.current = null;
    setDragActiveId(null);
    toast.success('排序已更新');
  }, [storageKey]);

  const resetOrder = useCallback(() => {
    setPinnedIds(defaultPinned);
    try { localStorage.setItem(storageKey, JSON.stringify(defaultPinned)); } catch {}
    toast.success('已恢复默认排序');
  }, [defaultPinned, storageKey]);

  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';

  /* ─── Real-time System Data from API ─── */
  interface HealthData {
    status: string;
    uptime?: number;
    version?: string;
    system?: { memory: { total: number; free: number; usedPct: number }; loadAvg: number[]; cpus: number };
    components?: Array<{ name: string; status: string; port: number; detail?: any }>;
  }
  interface StatsData {
    totalUsers: number;
    totalChats: number;
    totalMessages: number;
  }
  interface HealthDetailData {
    summary: { status: string; pass_count: number; warn_count: number; crit_count: number };
    components: Array<{ status: string; message: string; component: string }>;
  }

  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [statsData, setStatsData] = useState<StatsData | null>(null);
  const [healthDetail, setHealthDetail] = useState<HealthDetailData | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  useEffect(() => {
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const fetchData = async () => {
      try {
        const [healthRes, statsRes, detailRes] = await Promise.allSettled([
          fetch('/api/health', { headers }),
          fetch('/api/stats/summary', { headers }),
          fetch('/api/system/health-detail', { headers }),
        ]);
        if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
          setHealthData(await healthRes.value.json());
        }
        if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
          setStatsData(await statsRes.value.json());
        }
        if (detailRes.status === 'fulfilled' && detailRes.value.ok) {
          setHealthDetail(await detailRes.value.json());
        }
      } catch (e) {
        console.warn('[Dashboard] Failed to fetch system data:', e);
      } finally {
        setDataLoading(false);
        setLastRefreshed(new Date());
      }
    };
    fetchData();
    // Refresh every 60 seconds
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  // Derive system metrics from real data
  const cpuLoad = healthData?.system?.loadAvg?.[0]
    ? Math.round((healthData.system.loadAvg[0] / healthData.system.cpus) * 100)
    : null;
  const memoryUsed = healthData?.system?.memory?.usedPct ?? null;
  const diskUsed = healthDetail?.components?.find(c => c.component === 'system:disk')?.message?.match(/(\d+)%/)?.[1]
    ? parseInt(healthDetail.components.find(c => c.component === 'system:disk')!.message.match(/(\d+)%/)![1])
    : null;

  // Format uptime
  const uptimeSeconds = healthData?.uptime ?? 0;
  const formatUptime = (s: number) => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天 ${h}小时`;
    if (h > 0) return `${h}小时 ${m}分钟`;
    return `${m}分钟`;
  };

  /* ─── KPI Metrics (role-based, with real data where available) ─── */
  const allMetrics: KpiMetric[] = [
    { label: '注册用户', value: statsData ? `${statsData.totalUsers}` : '...', change: '', up: true, icon: <Users size={14} /> },
    { label: '总对话数', value: statsData ? `${statsData.totalChats}` : '...', change: '', up: true, icon: <MessageSquare size={14} /> },
    { label: '总消息数', value: statsData ? `${statsData.totalMessages.toLocaleString()}` : '...', change: '', up: true, icon: <Ticket size={14} /> },
    { label: '任务完成率', value: '87%', change: '+3%', up: true, icon: <CheckCircle2 size={14} /> },
    { label: 'KOL 合作中', value: '8', change: '+1', up: true, icon: <Crown size={14} /> },
    // Admin-only system metrics
    { label: '系统负载', value: cpuLoad !== null ? `${cpuLoad}%` : '...', change: '', up: cpuLoad !== null && cpuLoad < 50, icon: <Cpu size={14} />, adminOnly: true },
    { label: '内存使用', value: memoryUsed !== null ? `${memoryUsed}%` : '...', change: '', up: memoryUsed !== null && memoryUsed < 70, icon: <HardDrive size={14} />, adminOnly: true },
    { label: '磁盘使用', value: diskUsed !== null ? `${diskUsed}%` : '...', change: '', up: diskUsed !== null && diskUsed < 80, icon: <Database size={14} />, adminOnly: true },
  ];

  const metrics = allMetrics.filter(m => isAdmin || !m.adminOnly);

  /* ─── Recent Activities (role-based) ─── */
  const adminActivities = [
    { time: '2 分钟前', text: '用户 @liwei 登录系统', type: 'system' },
    { time: '5 分钟前', text: '新工单 #TK-2847 已创建（退款申请）', type: 'ticket' },
    { time: '12 分钟前', text: 'KOL @TechGamer 发布了新视频', type: 'kol' },
    { time: '30 分钟前', text: '库存预警: Steam 50 美元卡库存低于安全线', type: 'inventory' },
    { time: '1 小时前', text: '日报已自动生成并发送至管理层', type: 'report' },
    { time: '2 小时前', text: '工作流「KOL 数据同步」执行完成', type: 'workflow' },
    { time: '3 小时前', text: '系统自动备份完成（数据库 + 配置）', type: 'system' },
  ];

  const userActivities = [
    { time: '5 分钟前', text: '你的工单 #TK-2841 已被处理', type: 'ticket' },
    { time: '15 分钟前', text: 'KOL @TechGamer 发布了新视频', type: 'kol' },
    { time: '30 分钟前', text: '你负责的库存项已更新', type: 'inventory' },
    { time: '1 小时前', text: '今日日报已生成，请查阅', type: 'report' },
    { time: '2 小时前', text: '你的任务「数据核对」已完成', type: 'task' },
  ];

  const recentActivities = isAdmin ? adminActivities : userActivities;

  /* ─── My Tasks (user-only panel) ─── */
  const myTasks = [
    { title: '处理退款工单 #TK-2841', priority: '高', deadline: '今天 18:00', status: '进行中' },
    { title: '更新 KOL 合作数据表', priority: '中', deadline: '明天 12:00', status: '待开始' },
    { title: '审核 TikTok 视频脚本', priority: '中', deadline: '明天 18:00', status: '待开始' },
    { title: '整理本周库存报告', priority: '低', deadline: '周五 18:00', status: '待开始' },
  ];

  /* ─── Audit Log (admin-only panel) ─── */
  const auditLogs = [
    { time: '10:32', user: 'admin', action: '修改系统配置', detail: '更新 API 限流阈值 → 1000/min' },
    { time: '09:15', user: 'admin', action: '角色变更', detail: '用户 @zhangsan 提升为 admin' },
    { time: '08:45', user: 'liwei', action: '批量导出', detail: '导出工单数据 (2847 条)' },
    { time: '昨日 22:10', user: 'system', action: '自动备份', detail: '数据库备份完成 (128MB)' },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-xl sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center">
                <span className="text-white font-bold text-sm">R</span>
              </div>
              {greeting}，{user?.displayName || user?.username || 'Ranger'}
              {/* Role Badge */}
              {isAdmin ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-400 border border-amber-500/30">
                  <ShieldCheck size={10} />
                  管理员
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30">
                  <UserIcon size={10} />
                  成员
                </span>
              )}
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
              {' · '}游侠出海 AI 中台
              {healthData?.version && (
                <span className="ml-2 text-zinc-600">v{healthData.version}</span>
              )}
              {uptimeSeconds > 0 && (
                <span className="ml-2 text-zinc-600">· 运行 {formatUptime(uptimeSeconds)}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => navigate('/admin')}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg transition border border-zinc-700"
              >
                <Shield size={13} />
                管理面板
              </button>
            )}
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition"
            >
              <MessageSquare size={13} />
              开始对话
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Key Metrics */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Activity size={14} className="text-blue-400" />
            <h2 className="text-sm font-semibold">关键指标</h2>
            {isAdmin && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <ShieldCheck size={8} />
                含系统指标
              </span>
            )}
            <span className="text-[10px] text-zinc-600 ml-auto">
              {dataLoading ? '加载中...' : lastRefreshed ? `最后刷新 ${lastRefreshed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '实时数据'}
            </span>
          </div>
          <div className={`grid gap-3 ${isAdmin ? 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'}`}>
            {metrics.map((m, i) => (
              <div key={i} className={`bg-zinc-900/60 border rounded-xl p-3 hover:border-zinc-700 transition ${m.adminOnly ? 'border-amber-500/20' : 'border-zinc-800'}`}>
                <div className="flex items-center gap-1.5 text-zinc-500 mb-1">
                  {m.icon}
                  <span className="text-[10px]">{m.label}</span>
                  {m.adminOnly && <ShieldCheck size={8} className="text-amber-500/50 ml-auto" />}
                </div>
                <div className="text-lg font-bold">{m.value}</div>
                {m.change && (
                  <span className={`text-[10px] ${m.up ? 'text-emerald-400' : 'text-red-400'}`}>
                    {m.change}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Pinned Quick Entries — Drag to reorder */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Star size={14} className="text-amber-400" />
            <h2 className="text-sm font-semibold">快速入口</h2>
            <span className="text-[10px] text-zinc-600">拖拽排序 · 点击 ★ 自定义</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={resetOrder}
                className="text-[10px] text-zinc-600 hover:text-zinc-400 transition"
              >
                恢复默认
              </button>
              {!isAdmin && (
                <span className="text-[10px] text-zinc-600">
                  部分管理功能仅管理员可见
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {pinnedEntries.map(entry => (
              <div
                key={entry.id}
                draggable
                onDragStart={() => handleDragStart(entry.id)}
                onDragEnter={() => handleDragEnter(entry.id)}
                onDragEnd={handleDragEnd}
                onDragOver={e => e.preventDefault()}
                className={`group relative bg-zinc-900/60 border rounded-xl p-4 hover:border-zinc-600 transition cursor-pointer select-none ${
                  entry.adminOnly ? 'border-amber-500/20' : 'border-zinc-800'
                } ${
                  dragActiveId === entry.id ? 'opacity-50 scale-95 border-blue-500/50' : ''
                } ${
                  dragActiveId && dragActiveId !== entry.id ? 'hover:border-blue-400/40' : ''
                }`}
                onClick={() => { if (!dragActiveId) navigate(entry.path); }}
              >
                {/* Drag handle indicator */}
                <div className="absolute top-1.5 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition">
                  <div className="flex gap-0.5">
                    <div className="w-0.5 h-0.5 rounded-full bg-zinc-600" />
                    <div className="w-0.5 h-0.5 rounded-full bg-zinc-600" />
                    <div className="w-0.5 h-0.5 rounded-full bg-zinc-600" />
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); togglePin(entry.id); }}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition p-1 hover:bg-zinc-700 rounded"
                  title="取消置顶"
                >
                  <PinOff size={10} className="text-zinc-500" />
                </button>
                {entry.adminOnly && (
                  <div className="absolute top-2 left-2">
                    <ShieldCheck size={10} className="text-amber-500/60" />
                  </div>
                )}
                <div className={`w-9 h-9 rounded-lg ${entry.bg} flex items-center justify-center mb-2`}>
                  <span className={entry.color}>{entry.icon}</span>
                </div>
                <div className="text-sm font-medium">{entry.label}</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{entry.desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: All Modules */}
          <div className="lg:col-span-2 space-y-6">
            {/* All Modules */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Zap size={14} className="text-emerald-400" />
                <h2 className="text-sm font-semibold">全部模块</h2>
                <span className="text-[10px] text-zinc-600">
                  {visibleEntries.length} 个可用
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {otherEntries.map(entry => (
                  <div
                    key={entry.id}
                    className={`group flex items-center gap-3 p-3 bg-zinc-900/40 border rounded-lg hover:border-zinc-700 transition cursor-pointer ${entry.adminOnly ? 'border-amber-500/15' : 'border-zinc-800/50'}`}
                    onClick={() => navigate(entry.path)}
                  >
                    <div className={`w-8 h-8 rounded-lg ${entry.bg} flex items-center justify-center shrink-0`}>
                      <span className={entry.color}>{entry.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium flex items-center gap-1.5">
                        {entry.label}
                        {entry.adminOnly && <ShieldCheck size={9} className="text-amber-500/50" />}
                      </div>
                      <div className="text-[10px] text-zinc-500">{entry.desc}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={e => { e.stopPropagation(); togglePin(entry.id); }}
                        className="opacity-0 group-hover:opacity-100 transition p-1 hover:bg-zinc-700 rounded"
                        title="置顶"
                      >
                        <Pin size={10} className="text-zinc-500" />
                      </button>
                      <ArrowRight size={12} className="text-zinc-600 group-hover:text-zinc-400 transition" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Admin-only: Audit Log Panel */}
            {isAdmin && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <ClipboardList size={14} className="text-amber-400" />
                  <h2 className="text-sm font-semibold">审计日志</h2>
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <ShieldCheck size={8} />
                    仅管理员
                  </span>
                </div>
                <div className="bg-zinc-900/60 border border-amber-500/15 rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500">
                        <th className="text-left px-4 py-2 font-medium">时间</th>
                        <th className="text-left px-4 py-2 font-medium">操作人</th>
                        <th className="text-left px-4 py-2 font-medium">操作</th>
                        <th className="text-left px-4 py-2 font-medium">详情</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.map((log, i) => (
                        <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition">
                          <td className="px-4 py-2.5 text-zinc-500 whitespace-nowrap">{log.time}</td>
                          <td className="px-4 py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${log.user === 'admin' ? 'bg-amber-500/15 text-amber-400' : log.user === 'system' ? 'bg-blue-500/15 text-blue-400' : 'bg-zinc-700 text-zinc-300'}`}>
                              {log.user}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-zinc-300">{log.action}</td>
                          <td className="px-4 py-2.5 text-zinc-500 max-w-[200px] truncate">{log.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-4 py-2 border-t border-zinc-800/50">
                    <button
                      onClick={() => navigate('/admin')}
                      className="text-[10px] text-zinc-500 hover:text-amber-400 transition"
                    >
                      查看完整审计日志 →
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* User-only: My Tasks Panel */}
            {!isAdmin && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <ListTodo size={14} className="text-blue-400" />
                  <h2 className="text-sm font-semibold">我的待办</h2>
                  <span className="text-[10px] text-zinc-600 ml-auto">{myTasks.filter(t => t.status === '进行中').length} 项进行中</span>
                </div>
                <div className="space-y-2">
                  {myTasks.map((task, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 bg-zinc-900/40 border border-zinc-800/50 rounded-lg hover:border-zinc-700 transition">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${task.status === '进行中' ? 'bg-blue-500 animate-pulse' : 'bg-zinc-600'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-zinc-200">{task.title}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            task.priority === '高' ? 'bg-red-500/15 text-red-400' :
                            task.priority === '中' ? 'bg-amber-500/15 text-amber-400' :
                            'bg-zinc-700 text-zinc-400'
                          }`}>
                            {task.priority}
                          </span>
                          <span className="text-[10px] text-zinc-500 flex items-center gap-0.5">
                            <Clock size={8} />
                            {task.deadline}
                          </span>
                        </div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        task.status === '进行中' ? 'bg-blue-500/15 text-blue-400' : 'bg-zinc-700 text-zinc-400'
                      }`}>
                        {task.status}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => navigate('/tasks')}
                  className="w-full text-center text-[10px] text-zinc-500 hover:text-blue-400 transition mt-2"
                >
                  查看全部任务 →
                </button>
              </div>
            )}
          </div>

          {/* Right Sidebar */}
          <div className="space-y-4">
            {/* Recent Activity */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Clock size={14} className="text-orange-400" />
                <h2 className="text-sm font-semibold">最近动态</h2>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
                {recentActivities.map((act, i) => (
                  <div key={i} className="flex gap-3">
                    <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                      act.type === 'system' ? 'bg-amber-500' :
                      act.type === 'ticket' ? 'bg-red-500' :
                      act.type === 'kol' ? 'bg-pink-500' :
                      act.type === 'inventory' ? 'bg-amber-500' :
                      'bg-zinc-600'
                    }`} />
                    <div>
                      <p className="text-xs text-zinc-300">{act.text}</p>
                      <span className="text-[10px] text-zinc-600">{act.time}</span>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => navigate('/notifications')}
                  className="w-full text-center text-[10px] text-zinc-500 hover:text-blue-400 transition pt-2 border-t border-zinc-800"
                >
                  查看全部通知 →
                </button>
              </div>
            </div>

            {/* System Status - Real-time from /api/health */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Activity size={14} className={dataLoading ? 'text-zinc-500 animate-pulse' : 'text-emerald-400'} />
                <h3 className="text-xs font-semibold">系统状态</h3>
                {healthDetail && (
                  <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] ml-auto border ${
                    healthDetail.summary.status === 'PASS'
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}>
                    <ShieldCheck size={8} />
                    {healthDetail.summary.pass_count}/{healthDetail.summary.pass_count + healthDetail.summary.warn_count + healthDetail.summary.crit_count} 通过
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {(healthData?.components || []).map((comp, i) => {
                  const statusOk = comp.status === 'ok';
                  const nameMap: Record<string, string> = {
                    'api-server': 'API 服务',
                    'ws-realtime': 'WebSocket 实时',
                    'openclaw-gateway': 'OpenClaw 引擎',
                    'file-server': '文件服务',
                  };
                  const detailMap: Record<string, string> = {
                    'api-server': comp.detail?.version ? `v${comp.detail.version}` : '',
                    'ws-realtime': comp.detail?.wsClients !== undefined ? `${comp.detail.wsClients} 连接` : '',
                    'openclaw-gateway': statusOk ? '运行中' : '异常',
                    'file-server': statusOk ? '运行中' : '异常',
                  };
                  return (
                    <div key={i} className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-400">{nameMap[comp.name] || comp.name}</span>
                      <span className="flex items-center gap-1">
                        {isAdmin && detailMap[comp.name] && <span className="text-zinc-600 mr-1">{detailMap[comp.name]}</span>}
                        <span className={`w-1.5 h-1.5 rounded-full ${statusOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
                        <span className="text-zinc-500">{statusOk ? '正常' : '异常'}</span>
                      </span>
                    </div>
                  );
                })}
                {!healthData && !dataLoading && (
                  <div className="text-[10px] text-zinc-600 text-center py-2">无法获取系统状态</div>
                )}
                {dataLoading && (
                  <div className="text-[10px] text-zinc-600 text-center py-2 animate-pulse">加载中...</div>
                )}
              </div>
              {isAdmin && (cpuLoad !== null || memoryUsed !== null || diskUsed !== null) && (
                <div className="mt-3 pt-2 border-t border-zinc-800/50">
                  <div className="space-y-1.5">
                    {cpuLoad !== null && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-zinc-500 flex items-center gap-1"><Cpu size={9} /> CPU</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${cpuLoad > 80 ? 'bg-red-500' : cpuLoad > 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(cpuLoad, 100)}%` }} />
                          </div>
                          <span className="text-zinc-500">{cpuLoad}%</span>
                        </div>
                      </div>
                    )}
                    {memoryUsed !== null && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-zinc-500 flex items-center gap-1"><HardDrive size={9} /> 内存</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${memoryUsed > 80 ? 'bg-red-500' : memoryUsed > 60 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${memoryUsed}%` }} />
                          </div>
                          <span className="text-zinc-500">{memoryUsed}%</span>
                        </div>
                      </div>
                    )}
                    {diskUsed !== null && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-zinc-500 flex items-center gap-1"><Database size={9} /> 磁盘</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-20 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${diskUsed > 80 ? 'bg-red-500' : diskUsed > 60 ? 'bg-amber-500' : 'bg-amber-500'}`} style={{ width: `${diskUsed}%` }} />
                          </div>
                          <span className="text-zinc-500">{diskUsed}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* User-only: My Notifications Summary */}
            {!isAdmin && (
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Bell size={14} className="text-blue-400" />
                  <h3 className="text-xs font-semibold">我的通知</h3>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-zinc-400">未读消息</span>
                    <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">3 条</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-zinc-400">待处理工单</span>
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">5 个</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-zinc-400">今日完成任务</span>
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">7 个</span>
                  </div>
                </div>
                <button
                  onClick={() => navigate('/notifications')}
                  className="w-full text-center text-[10px] text-zinc-500 hover:text-blue-400 transition mt-3 pt-2 border-t border-zinc-800/50"
                >
                  查看通知中心 →
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
