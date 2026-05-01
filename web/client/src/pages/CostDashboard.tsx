/**
 * CostDashboard — AI API 成本统计看板 (admin only)
 * 
 * Features:
 * - 手动刷新按钮
 * - 时间范围选择 (2h / 6h / 12h / 24h / 72h / 7d)
 * - 总成本摘要卡片
 * - 各用户成本排行
 * - 模型成本分布
 * - 每小时成本趋势
 * - Top Sessions 明细
 */
import { useState, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import {
  RefreshCw, DollarSign, Cpu, Users, Clock, Activity,
  ArrowLeft, Zap, TrendingUp, BarChart3,
} from 'lucide-react';
import { useLocation } from 'wouter';

// ─── Types ───────────────────────────────────────────────────
interface CostUser {
  name: string;
  total: number;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  models: { model: string; cost: number }[];
}

interface CostModel {
  name: string;
  total: number;
  calls: number;
}

interface CostHourly {
  hour: string;
  cost: number;
}

interface CostSession {
  sid: string;
  user: string;
  cost: number;
  calls: number;
  isCron: boolean;
  channel: string;
  label: string;
}

interface CostStats {
  timeRange: { hours: number; from: string; to: string };
  summary: {
    totalCost: number;
    totalCalls: number;
    activeSessions: number;
    cronCost: number;
    cronCalls: number;
    userCost: number;
    userCalls: number;
  };
  users: CostUser[];
  models: CostModel[];
  hourly: CostHourly[];
  daily: { date: string; cost: number }[];
  sessions: CostSession[];
}

// ─── Time Range Options ──────────────────────────────────────
const TIME_RANGES = [
  { label: '2h', hours: 2 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
];

// ─── Component ───────────────────────────────────────────────
export default function CostDashboard() {
  const [, navigate] = useLocation();
  const [stats, setStats] = useState<CostStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchStats = useCallback(async (h?: number) => {
    const targetHours = h ?? hours;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CostStats>(`/api/cost-stats?hours=${targetHours}`);
      setStats(data);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message || '获取成本数据失败');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  const handleTimeRange = (h: number) => {
    setHours(h);
    fetchStats(h);
  };

  // ─── Bar chart helper (pure CSS) ──────────────────────────
  const maxCost = stats?.hourly?.reduce((m, h) => Math.max(m, h.cost), 0) || 1;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-zinc-800 rounded-lg transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div className="flex items-center gap-2">
              <DollarSign size={20} className="text-emerald-400" />
              <h1 className="text-lg font-semibold">成本统计</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Time range selector */}
            <div className="flex bg-zinc-800 rounded-lg p-0.5">
              {TIME_RANGES.map(r => (
                <button
                  key={r.hours}
                  onClick={() => handleTimeRange(r.hours)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    hours === r.hours
                      ? 'bg-emerald-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {/* Refresh button */}
            <button
              onClick={() => fetchStats()}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              {loading ? '加载中...' : '刷新'}
            </button>
          </div>
        </div>
        {lastRefresh && (
          <div className="max-w-6xl mx-auto px-4 pb-2 text-xs text-zinc-500">
            上次刷新: {lastRefresh.toLocaleTimeString('zh-CN')}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Initial state */}
        {!stats && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <DollarSign size={48} className="mb-4 text-zinc-600" />
            <p className="text-lg mb-2">点击"刷新"加载成本数据</p>
            <p className="text-sm">选择时间范围后点击刷新按钮</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-300">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-zinc-900 rounded-xl p-4 animate-pulse">
                <div className="h-4 bg-zinc-800 rounded w-20 mb-3" />
                <div className="h-8 bg-zinc-800 rounded w-24" />
              </div>
            ))}
          </div>
        )}

        {stats && (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SummaryCard
                icon={<DollarSign size={18} />}
                label="总成本"
                value={`$${stats.summary.totalCost.toFixed(4)}`}
                color="emerald"
              />
              <SummaryCard
                icon={<Zap size={18} />}
                label="API 调用"
                value={stats.summary.totalCalls.toString()}
                color="blue"
              />
              <SummaryCard
                icon={<Activity size={18} />}
                label="活跃 Session"
                value={stats.summary.activeSessions.toString()}
                color="purple"
              />
              <SummaryCard
                icon={<Clock size={18} />}
                label="Cron 成本"
                value={`$${stats.summary.cronCost.toFixed(4)}`}
                sub={`${stats.summary.cronCalls} 次调用`}
                color="amber"
              />
            </div>

            {/* Two-column layout */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Users Cost Ranking */}
              <div className="bg-zinc-900 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Users size={16} className="text-blue-400" />
                  <h2 className="font-semibold">用户成本排行</h2>
                </div>
                {stats.users.length === 0 ? (
                  <p className="text-zinc-500 text-sm">暂无数据</p>
                ) : (
                  <div className="space-y-2">
                    {stats.users.map((u, i) => (
                      <div key={u.name} className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/50 transition-colors">
                        <span className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                          i === 0 ? 'bg-yellow-500/20 text-yellow-400' :
                          i === 1 ? 'bg-zinc-500/20 text-zinc-300' :
                          i === 2 ? 'bg-amber-700/20 text-amber-500' :
                          'bg-zinc-800 text-zinc-500'
                        }`}>
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium truncate">{u.name}</span>
                            <span className="text-sm font-mono text-emerald-400">${u.total.toFixed(4)}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-zinc-500 mt-0.5">
                            <span>{u.calls} 次调用</span>
                            <span>·</span>
                            <span>缓存写 ${u.cacheWrite.toFixed(2)}</span>
                            <span>·</span>
                            <span>缓存读 ${u.cacheRead.toFixed(2)}</span>
                          </div>
                          {/* Cost bar */}
                          <div className="mt-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all"
                              style={{ width: `${Math.max(2, (u.total / stats.users[0].total) * 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Model Cost Distribution */}
              <div className="bg-zinc-900 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Cpu size={16} className="text-purple-400" />
                  <h2 className="font-semibold">模型成本分布</h2>
                </div>
                {stats.models.length === 0 ? (
                  <p className="text-zinc-500 text-sm">暂无数据</p>
                ) : (
                  <div className="space-y-3">
                    {stats.models.map((m) => {
                      const pct = stats.summary.totalCost > 0
                        ? ((m.total / stats.summary.totalCost) * 100).toFixed(1)
                        : '0';
                      return (
                        <div key={m.name} className="p-3 bg-zinc-800/50 rounded-lg">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium">{m.name}</span>
                            <span className="text-sm font-mono text-purple-400">${m.total.toFixed(4)}</span>
                          </div>
                          <div className="flex items-center justify-between text-xs text-zinc-500">
                            <span>{m.calls} 次调用</span>
                            <span>{pct}%</span>
                          </div>
                          <div className="mt-2 h-2 bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-purple-500 to-violet-400 rounded-full"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Hourly Cost Trend */}
            <div className="bg-zinc-900 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp size={16} className="text-cyan-400" />
                <h2 className="font-semibold">每小时成本趋势 (CST)</h2>
              </div>
              {stats.hourly.length === 0 ? (
                <p className="text-zinc-500 text-sm">暂无数据</p>
              ) : (
                <div className="flex items-end gap-1 h-40">
                  {stats.hourly.map((h) => {
                    const height = maxCost > 0 ? Math.max(4, (h.cost / maxCost) * 100) : 4;
                    return (
                      <div key={h.hour} className="flex-1 flex flex-col items-center gap-1 group">
                        <div className="relative w-full flex justify-center">
                          <span className="absolute -top-5 text-[10px] text-zinc-400 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                            ${h.cost.toFixed(2)}
                          </span>
                          <div
                            className="w-full max-w-[32px] bg-gradient-to-t from-cyan-600 to-cyan-400 rounded-t-sm hover:from-cyan-500 hover:to-cyan-300 transition-colors cursor-default"
                            style={{ height: `${height}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-zinc-500">{h.hour.slice(0, 2)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Top Sessions */}
            <div className="bg-zinc-900 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 size={16} className="text-orange-400" />
                <h2 className="font-semibold">Top Sessions</h2>
              </div>
              {stats.sessions.length === 0 ? (
                <p className="text-zinc-500 text-sm">暂无数据</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-zinc-500 border-b border-zinc-800">
                        <th className="text-left py-2 px-2 font-medium">Session</th>
                        <th className="text-left py-2 px-2 font-medium">用户</th>
                        <th className="text-right py-2 px-2 font-medium">成本</th>
                        <th className="text-right py-2 px-2 font-medium">调用</th>
                        <th className="text-left py-2 px-2 font-medium">渠道</th>
                        <th className="text-left py-2 px-2 font-medium">类型</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.sessions.map((s) => (
                        <tr key={s.sid} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                          <td className="py-2 px-2 font-mono text-xs text-zinc-400">{s.sid}</td>
                          <td className="py-2 px-2 truncate max-w-[150px]">{s.user}</td>
                          <td className="py-2 px-2 text-right font-mono text-emerald-400">${s.cost.toFixed(4)}</td>
                          <td className="py-2 px-2 text-right">{s.calls}</td>
                          <td className="py-2 px-2 text-zinc-400">{s.channel}</td>
                          <td className="py-2 px-2">
                            {s.isCron ? (
                              <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded text-xs">Cron</span>
                            ) : (
                              <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs">对话</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Summary Card ────────────────────────────────────────────
function SummaryCard({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: 'emerald' | 'blue' | 'purple' | 'amber';
}) {
  const colors = {
    emerald: 'text-emerald-400 bg-emerald-500/10',
    blue: 'text-blue-400 bg-blue-500/10',
    purple: 'text-purple-400 bg-purple-500/10',
    amber: 'text-amber-400 bg-amber-500/10',
  };
  return (
    <div className="bg-zinc-900 rounded-xl p-4">
      <div className={`inline-flex p-2 rounded-lg ${colors[color]} mb-2`}>
        {icon}
      </div>
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className="text-xl font-bold font-mono">{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}
