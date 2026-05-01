/**
 * WebTaskStatsTab — R22-T1b Web Task Routing Statistics Panel
 * 
 * Displays web task family distribution, browser routing rates,
 * and missed-browser-case analysis.
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { fetchAdmin } from './shared';
import {
  Globe, RefreshCw, Loader2, BarChart3, AlertTriangle,
  ArrowDownRight, Search, Eye, TrendingUp,
} from 'lucide-react';

interface WebTaskStats {
  period: { hours: number; since: string };
  webTaskCount: number;
  webTaskBrowserRate: number;
  webTaskSearchRate: number;
  webTaskDirectAnswerRate: number;
  webTaskMissedBrowserCases: {
    downgraded_to_search: number;
    routed_to_shell: number;
    direct_text_answer: number;
    routed_to_other_tool: number;
  };
  familyDistribution: Record<string, number>;
}

const FAMILY_COLORS: Record<string, string> = {
  page_lookup: 'bg-blue-500',
  page_extract: 'bg-emerald-500',
  site_navigation: 'bg-violet-500',
  web_verification: 'bg-amber-500',
  unknown: 'bg-zinc-500',
};

const FAMILY_LABELS: Record<string, string> = {
  page_lookup: '页面查找',
  page_extract: '页面提取',
  site_navigation: '站点导航',
  web_verification: '网页验证',
  unknown: '未分类',
};

const MISSED_LABELS: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  downgraded_to_search: { label: '降级为搜索', icon: Search, color: 'text-amber-400' },
  routed_to_shell: { label: '路由到 Shell', icon: ArrowDownRight, color: 'text-red-400' },
  direct_text_answer: { label: '直接文本回答', icon: AlertTriangle, color: 'text-orange-400' },
  routed_to_other_tool: { label: '路由到其他工具', icon: ArrowDownRight, color: 'text-zinc-400' },
};

export default function WebTaskStatsTab() {
  const { t } = useI18n();
  const [stats, setStats] = useState<WebTaskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(168);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin(`/api/admin/web-task-stats?hours=${hours}`);
      setStats(data);
    } catch (e) {
      console.error('Failed to load web task stats:', e);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { loadStats(); }, [loadStats]);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(loadStats, 30000);
    return () => clearInterval(timer);
  }, [loadStats]);

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-blue-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe size={20} className="text-blue-400" />
          <h2 className="text-lg font-semibold">Web Task Routing</h2>
          <span className="text-xs text-zinc-500">R22-T1b</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={hours}
            onChange={e => setHours(Number(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs"
          >
            <option value={24}>24h</option>
            <option value={72}>3d</option>
            <option value={168}>7d</option>
            <option value={720}>30d</option>
          </select>
          <button onClick={loadStats} className="p-1.5 rounded hover:bg-zinc-800 transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin text-blue-400' : 'text-zinc-400'} />
          </button>
        </div>
      </div>

      {stats && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KPICard
              icon={Globe}
              label="Web Tasks"
              value={stats.webTaskCount}
              color="text-blue-400"
            />
            <KPICard
              icon={Eye}
              label="Browser 路由率"
              value={pct(stats.webTaskBrowserRate)}
              color="text-emerald-400"
              sub={`${Math.round(stats.webTaskCount * stats.webTaskBrowserRate)} tasks`}
            />
            <KPICard
              icon={Search}
              label="Search 降级率"
              value={pct(stats.webTaskSearchRate)}
              color="text-amber-400"
            />
            <KPICard
              icon={TrendingUp}
              label="直接回答率"
              value={pct(stats.webTaskDirectAnswerRate)}
              color="text-zinc-400"
            />
          </div>

          {/* Family Distribution */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <BarChart3 size={14} className="text-blue-400" />
              任务族分布
            </h3>
            {Object.keys(stats.familyDistribution).length === 0 ? (
              <div className="text-center text-zinc-500 text-sm py-4">
                暂无 Web 任务族数据（R22 部署后的新任务才会分类）
              </div>
            ) : (
              <div className="space-y-2">
                {Object.entries(stats.familyDistribution)
                  .sort(([, a], [, b]) => b - a)
                  .map(([family, count]) => {
                    const total = stats.webTaskCount || 1;
                    const width = Math.max(5, (count / total) * 100);
                    return (
                      <div key={family} className="flex items-center gap-3">
                        <span className="text-xs text-zinc-400 w-20 text-right">{FAMILY_LABELS[family] || family}</span>
                        <div className="flex-1 h-5 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${FAMILY_COLORS[family] || 'bg-zinc-600'} transition-all duration-500`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <span className="text-xs text-zinc-400 w-12">{count} ({pct(count / total)})</span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Missed Browser Cases */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <AlertTriangle size={14} className="text-amber-400" />
              Browser 未命中分析
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(stats.webTaskMissedBrowserCases).map(([key, count]) => {
                const meta = MISSED_LABELS[key] || { label: key, icon: AlertTriangle, color: 'text-zinc-400' };
                const Icon = meta.icon;
                return (
                  <div key={key} className="flex items-center gap-2 bg-zinc-800/50 rounded-lg p-3">
                    <Icon size={16} className={meta.color} />
                    <div>
                      <div className="text-sm font-medium">{count}</div>
                      <div className="text-[10px] text-zinc-500">{meta.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Period Info */}
          <div className="text-xs text-zinc-600 text-center">
            统计周期: {new Date(stats.period.since).toLocaleString('zh-CN')} 至今 · 30s 自动刷新
          </div>
        </>
      )}
    </div>
  );
}

function KPICard({ icon: Icon, label, value, color, sub }: {
  icon: React.ElementType; label: string; value: string | number; color: string; sub?: string;
}) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={color} />
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  );
}
