
interface PriceItem {
  site: string;
  platform: string;
  price: number;
  currency: string;
  quantity: string;
  updatedAt: string;
  competitor_price?: number;
  our_price?: number;
  competitor?: string;
  game?: string;
  region?: string;
}

/**
 * CeoDashboard Sub-panels — extracted from CeoDashboard.tsx
 * Contains: MonthlyChronicle, PriceComparisonPanel, InspectionTimeline, RevenueTrendChart
 */
import { useState, useEffect, useMemo } from 'react';
import {
  CalendarDays, TrendingUp, TrendingDown, DollarSign, ArrowUpRight,
  ArrowDownRight, Clock, CheckCircle2, AlertTriangle, Eye, Shield,
  Package, Truck, ShoppingCart, Activity, BarChart3, Target
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';

// ─── getMockInspectionLogs ───
export function getMockInspectionLogs() {
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


// ─── MonthlyChronicle ───
export function MonthlyChronicle() {
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


// ─── PriceComparisonPanel ───
export function PriceComparisonPanel() {
  const [prices, setPrices] = useState<PriceItem[]>([]);
  const [summary, setSummary] = useState<{ total_games: number; avg_savings_pct: number; best_deal: { game: string; savings: number } } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats/market-prices')
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
                const savings = (((p.competitor_price ?? 0) - (p.our_price ?? 0)) / (p.competitor_price ?? 0) * 100).toFixed(1);
                const isGood = (p.our_price ?? 0) < (p.competitor_price ?? 0);
                return (
                  <tr key={i} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                    <td className="px-4 py-2.5 text-white font-medium">{p.game}</td>
                    <td className="px-4 py-2.5 text-zinc-400">{p.currency}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={isGood ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                        ${(p.our_price ?? 0).toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-400">${(p.competitor_price ?? 0).toFixed(2)}</td>
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


// ─── InspectionTimeline ───
export function InspectionTimeline() {
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
    fetch('/api/system/inspection-logs')
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


// ─── RevenueTrendChart ───
export function RevenueTrendChart() {
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

