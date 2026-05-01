/**
 * GatewayQuotaTab — Admin Dashboard tab for monitoring Gateway fallback events.
 * Shows fallback frequency chart, per-model stats, and alert banner when rate > 10%.
 * 
 * Iter-S7 P2: Gateway 配额监控面板
 * @version 1.0.0
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchAdmin, MetricCard } from './shared';
import {
  Loader2, AlertTriangle, RefreshCw, TrendingUp, Zap,
  ShieldAlert, Activity, Clock, BarChart3,
} from 'lucide-react';
import { logger } from "../../lib/logger";

// ─── Types ──────────────────────────────────────────────────
interface GatewayEvent {
  id: number;
  provider: string;
  model: string;
  error_type: string;
  error_message: string | null;
  fallback_result: string | null;
  timestamp: number;
}

interface ModelStat {
  provider: string;
  model: string;
  count: number;
  error_types: Record<string, number>;
}

interface HourlyData {
  hour: string;
  count: number;
}

interface GatewayEventsResponse {
  events: GatewayEvent[];
  stats: ModelStat[];
  hourly: HourlyData[];
  summary: {
    total: number;
    hours: number;
    fallbackRate: number;
    alerting: boolean;
  };
}

// ─── Simple Bar Chart Component ─────────────────────────────
function SimpleBarChart({ data, maxBars = 24 }: { data: HourlyData[]; maxBars?: number }) {
  const displayData = data.slice(-maxBars);
  if (displayData.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-500 text-sm">
        暂无数据
      </div>
    );
  }
  const maxCount = Math.max(...displayData.map(d => d.count), 1);

  return (
    <div className="flex items-end gap-1 h-48 px-2">
      {displayData.map((d, i) => {
        const height = Math.max((d.count / maxCount) * 100, 2);
        const hourLabel = d.hour.slice(11, 16); // HH:MM
        const isHigh = d.count > maxCount * 0.7;
        return (
          <div key={i} className="flex flex-col items-center flex-1 min-w-0 group relative">
            {/* Tooltip */}
            <div className="absolute bottom-full mb-1 hidden group-hover:block z-10">
              <div className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 whitespace-nowrap shadow-lg">
                {hourLabel}: {d.count} 次
              </div>
            </div>
            {/* Bar */}
            <div
              className={`w-full rounded-t transition-all duration-300 ${
                isHigh ? 'bg-red-500/80' : 'bg-blue-500/60'
              } hover:opacity-80`}
              style={{ height: `${height}%`, minHeight: '2px' }}
            />
            {/* Label - show every 3rd */}
            {i % 3 === 0 && (
              <span className="text-[9px] text-zinc-600 mt-1 truncate w-full text-center">
                {hourLabel}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Error Type Badge ───────────────────────────────────────
function ErrorTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    rate_limit: 'bg-red-500/15 text-red-400 border-red-500/30',
    health_degraded: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    gateway_error: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    all_failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  const labels: Record<string, string> = {
    rate_limit: '配额耗尽',
    health_degraded: '健康度低',
    gateway_error: '网关错误',
    all_failed: '全部失败',
  };
  return (
    <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded border font-medium ${
      colors[type] || 'bg-zinc-800 text-zinc-400 border-zinc-700'
    }`}>
      {labels[type] || type}
    </span>
  );
}

// ─── Main Component ─────────────────────────────────────────
export default function GatewayQuotaTab() {
  const [data, setData] = useState<GatewayEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hours, setHours] = useState(24);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchAdmin(`/api/admin/gateway-events?hours=${hours}`);
      setData(result);
    } catch (err) {
      logger.error('Failed to fetch gateway events:', err);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-zinc-500" size={24} />
      </div>
    );
  }

  const summary = data?.summary || { total: 0, hours: 24, fallbackRate: 0, alerting: false };

  return (
    <div className="space-y-6">
      {/* Alert Banner */}
      {summary.alerting && (
        <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
          <ShieldAlert size={20} className="text-red-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-300">
              Fallback 频率告警
            </p>
            <p className="text-xs text-red-400/80 mt-0.5">
              过去 {summary.hours} 小时内触发了 {summary.total} 次 fallback，
              平均 {summary.fallbackRate} 次/小时。请检查 Gateway 配额和模型可用性。
            </p>
          </div>
        </div>
      )}

      {/* Time Range Selector + Refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-zinc-500" />
          <span className="text-xs text-zinc-500">时间范围：</span>
          {[6, 12, 24, 48, 72, 168].map(h => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                hours === h
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {h < 24 ? `${h}h` : `${h / 24}d`}
            </button>
          ))}
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          icon={Zap}
          label="Fallback 总次数"
          value={summary.total}
          sub={`过去 ${summary.hours} 小时`}
          color="text-amber-400"
        />
        <MetricCard
          icon={TrendingUp}
          label="平均频率"
          value={`${summary.fallbackRate}/h`}
          sub="次/小时"
          color={summary.fallbackRate > 1 ? 'text-red-400' : 'text-emerald-400'}
        />
        <MetricCard
          icon={Activity}
          label="涉及模型"
          value={data?.stats?.length || 0}
          sub="个不同模型/通道"
          color="text-blue-400"
        />
        <MetricCard
          icon={BarChart3}
          label="状态"
          value={summary.alerting ? '告警' : '正常'}
          sub={summary.alerting ? 'fallback 频率偏高' : '无异常'}
          color={summary.alerting ? 'text-red-400' : 'text-emerald-400'}
        />
      </div>

      {/* Hourly Chart */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <BarChart3 size={14} className="text-blue-400" />
          Fallback 频次分布（按小时）
        </h3>
        <SimpleBarChart data={data?.hourly || []} maxBars={Math.min(hours, 48)} />
      </div>

      {/* Per-Model Stats */}
      {data?.stats && data.stats.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
            <Activity size={14} className="text-amber-400" />
            按模型/通道统计
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 px-3 font-medium">Provider</th>
                  <th className="text-left py-2 px-3 font-medium">Model</th>
                  <th className="text-right py-2 px-3 font-medium">次数</th>
                  <th className="text-left py-2 px-3 font-medium">错误类型</th>
                </tr>
              </thead>
              <tbody>
                {data.stats.sort((a, b) => b.count - a.count).map((stat, i) => (
                  <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2 px-3 text-zinc-300 font-mono">{stat.provider}</td>
                    <td className="py-2 px-3 text-zinc-400 font-mono">{stat.model}</td>
                    <td className="py-2 px-3 text-right text-zinc-200 font-semibold">{stat.count}</td>
                    <td className="py-2 px-3">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(stat.error_types).map(([type, count]) => (
                          <span key={type} className="flex items-center gap-1">
                            <ErrorTypeBadge type={type} />
                            <span className="text-zinc-500">{count as number}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Events */}
      {data?.events && data.events.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-orange-400" />
            最近事件（最多 100 条）
          </h3>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {data.events.map(event => (
              <div key={event.id} className="flex items-start gap-3 p-2 rounded-lg hover:bg-zinc-800/30 transition-colors">
                <div className="text-[10px] text-zinc-600 whitespace-nowrap mt-0.5 font-mono">
                  {new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false })}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-zinc-300 font-mono">{event.provider}</span>
                    <span className="text-zinc-700">/</span>
                    <span className="text-xs text-zinc-400 font-mono">{event.model}</span>
                    <ErrorTypeBadge type={event.error_type} />
                    {event.fallback_result && (
                      <span className={`text-[10px] px-1 py-0.5 rounded ${
                        event.fallback_result === 'failed' ? 'text-red-400 bg-red-500/10' : 'text-zinc-500 bg-zinc-800'
                      }`}>
                        {event.fallback_result}
                      </span>
                    )}
                  </div>
                  {event.error_message && (
                    <p className="text-[11px] text-zinc-600 mt-0.5 truncate">{event.error_message}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {(!data?.events || data.events.length === 0) && !loading && (
        <div className="flex flex-col items-center justify-center h-48 text-zinc-500">
          <Activity size={32} className="mb-2 opacity-30" />
          <p className="text-sm">过去 {hours} 小时内无 fallback 事件</p>
          <p className="text-xs text-zinc-600 mt-1">Gateway 运行正常</p>
        </div>
      )}
    </div>
  );
}
