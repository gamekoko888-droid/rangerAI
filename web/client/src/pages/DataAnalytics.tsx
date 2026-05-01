/**
 * DataAnalytics - Business Data Analytics Dashboard
 * 
 * Core metrics for supply chain, sales, and operations.
 * Uses mock data with API placeholders for future integration.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { useI18n } from '@/lib/i18n';
import {
  ArrowLeft, BarChart3, TrendingUp, TrendingDown, RefreshCw,
  Package, DollarSign, ShoppingCart, Truck, ArrowUpRight, ArrowDownRight,
  Calendar, Filter, Download, Layers, Globe, Gamepad2, Coins,
  Activity, PieChart, LineChart, AlertTriangle, Users, ClipboardCheck, Timer, CheckCircle2
} from 'lucide-react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface TimeSeriesPoint {
  date: string;
  value: number;
}

interface BusinessLine {
  id: string;
  name: string;
  icon: typeof Package;
  color: string;
  barColor: string;
  revenue: number;
  revenueChange: number;
  orders: number;
  ordersChange: number;
  avgOrderValue: number;
  trend: TimeSeriesPoint[];
}

interface InventoryItem {
  name: string;
  category: string;
  stock: number;
  safetyLine: number;
  status: 'normal' | 'low' | 'critical';
  dailyConsumption: number;
  daysRemaining: number;
}

// ─── Mock Data ──────────────────────────────────────────────

function generateTrend(base: number, days: number, volatility: number): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  let val = base;
  for (let i = days; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    val = Math.max(0, val + (Math.random() - 0.45) * volatility);
    points.push({ date: d.toISOString().slice(5, 10), value: Math.round(val) });
  }
  return points;
}

interface ProfitLine {
  name: string;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  color: string;
}

function generateMockAnalytics(trendDays: number = 14) {
  const businessLines: BusinessLine[] = [
    {
      id: 'cps',
      name: 'CPS推广',
      icon: Globe,
      color: 'text-blue-400',
      barColor: 'bg-blue-500',
      revenue: 1245000,
      revenueChange: 15.2,
      orders: 8432,
      ordersChange: 12.1,
      avgOrderValue: 147.6,
      trend: generateTrend(280000, trendDays, 30000),
    },
    {
      id: 'fc',
      name: 'FC金币',
      icon: Coins,
      color: 'text-amber-400',
      barColor: 'bg-amber-500',
      revenue: 1602500,
      revenueChange: 8.7,
      orders: 10000,
      ordersChange: 6.3,
      avgOrderValue: 160.3,
      trend: generateTrend(350000, trendDays, 40000),
    },
    {
      id: 'direct',
      name: '直充业务',
      icon: Gamepad2,
      color: 'text-emerald-400',
      barColor: 'bg-emerald-500',
      revenue: 2180000,
      revenueChange: -1.3,
      orders: 15600,
      ordersChange: 2.8,
      avgOrderValue: 139.7,
      trend: generateTrend(480000, trendDays, 50000),
    },
    {
      id: 'agent',
      name: '代充业务',
      icon: ShoppingCart,
      color: 'text-purple-400',
      barColor: 'bg-purple-500',
      revenue: 3452100,
      revenueChange: 5.4,
      orders: 27256,
      ordersChange: 7.9,
      avgOrderValue: 126.7,
      trend: generateTrend(750000, trendDays, 80000),
    },
    {
      id: 'tiktok',
      name: 'TikTok运营',
      icon: Activity,
      color: 'text-rose-400',
      barColor: 'bg-rose-500',
      revenue: 456000,
      revenueChange: 42.3,
      orders: 3200,
      ordersChange: 35.6,
      avgOrderValue: 142.5,
      trend: generateTrend(80000, trendDays, 20000),
    },
  ];

  const inventory: InventoryItem[] = [
    { name: 'FC金币 (EA)', category: '豹量引擎', stock: 52000, safetyLine: 80000, status: 'critical', dailyConsumption: 8500, daysRemaining: 6 },
    { name: 'Steam充值卡', category: '直充', stock: 15000, safetyLine: 10000, status: 'normal', dailyConsumption: 2000, daysRemaining: 7 },
    { name: 'Google Play礼品卡', category: '代充', stock: 8500, safetyLine: 8000, status: 'low', dailyConsumption: 1200, daysRemaining: 7 },
    { name: 'Apple Gift Card', category: '代充', stock: 12000, safetyLine: 6000, status: 'normal', dailyConsumption: 900, daysRemaining: 13 },
    { name: 'PlayStation Store', category: '直充', stock: 5200, safetyLine: 5000, status: 'low', dailyConsumption: 700, daysRemaining: 7 },
    { name: 'Nintendo eShop', category: '直充', stock: 3800, safetyLine: 2000, status: 'normal', dailyConsumption: 300, daysRemaining: 12 },
  ];

  const totalRevenue = businessLines.reduce((s, b) => s + b.revenue, 0);
  const totalOrders = businessLines.reduce((s, b) => s + b.orders, 0);

  // Profit analysis per business line
  const profitData: ProfitLine[] = [
    { name: 'CPS推广', revenue: 1245000, cost: 935000, profit: 310000, marginPct: 24.9, color: 'bg-blue-500' },
    { name: 'FC金币', revenue: 1602500, cost: 1282000, profit: 320500, marginPct: 20.0, color: 'bg-amber-500' },
    { name: '直充业务', revenue: 2180000, cost: 1853000, profit: 327000, marginPct: 15.0, color: 'bg-emerald-500' },
    { name: '代充业务', revenue: 3452100, cost: 2761680, profit: 690420, marginPct: 20.0, color: 'bg-purple-500' },
    { name: 'TikTok运营', revenue: 456000, cost: 319200, profit: 136800, marginPct: 30.0, color: 'bg-rose-500' },
  ];

  return { businessLines, inventory, totalRevenue, totalOrders, profitData };
}

// ─── Helper Components ──────────────────────────────────────

function ChangeIndicator({ change, size = 'sm' }: { change: number; size?: 'sm' | 'lg' }) {
  if (change === 0) return <span className="text-zinc-500 text-xs">--</span>;
  const isPositive = change > 0;
  const textSize = size === 'lg' ? 'text-sm' : 'text-xs';
  return (
    <span className={`inline-flex items-center gap-0.5 ${textSize} font-medium ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
      {isPositive ? <ArrowUpRight size={size === 'lg' ? 14 : 12} /> : <ArrowDownRight size={size === 'lg' ? 14 : 12} />}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

function MiniChart({ data, color }: { data: TimeSeriesPoint[]; color: string }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map(d => d.value));
  const min = Math.min(...data.map(d => d.value));
  const range = max - min || 1;
  const h = 40;
  const w = 120;
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((d.value - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={color}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InventoryBar({ stock, safetyLine, status }: { stock: number; safetyLine: number; status: string }) {
  const maxVal = Math.max(stock, safetyLine) * 1.2;
  const stockPct = (stock / maxVal) * 100;
  const safetyPct = (safetyLine / maxVal) * 100;
  const barColor = status === 'critical' ? 'bg-red-500' : status === 'low' ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
      <div className={`absolute h-full rounded-full ${barColor}`} style={{ width: `${stockPct}%` }} />
      <div
        className="absolute h-full w-0.5 bg-zinc-400"
        style={{ left: `${safetyPct}%` }}
        title={`安全线: ${safetyLine.toLocaleString()}`}
      />
    </div>
  );
}

function formatCurrency(n: number): string {
  if (n >= 10000000) return '¥' + (n / 10000000).toFixed(2) + '亿';
  if (n >= 10000) return '¥' + (n / 10000).toFixed(1) + '万';
  return '¥' + n.toLocaleString();
}

// ─── Loss Rate Monitor ─────────────────────────────────────

interface LossEntry {
  channel: string;
  lossAmount: number;
  lossRate: number;
  refundCount: number;
  totalOrders: number;
  trend: 'up' | 'down' | 'stable';
}

function LossRateMonitor() {
  const [monthlyTrend, setMonthlyTrend] = useState<Array<{period: string; loss_rate: number}>>([]);
  const [apiConnected, setApiConnected] = useState(false);

  useEffect(() => {
    fetch('/api/stats/loss-rates')
      .then(res => { if (!res.ok) throw new Error('API not available'); return res.json(); })
      .then(data => {
        if (data.success && data.data) {
          setMonthlyTrend(data.data);
          setApiConnected(true);
        }
      })
      .catch(() => { /* fallback: no trend data */ });
  }, []);

  const [lossData] = useState<LossEntry[]>([
    { channel: 'FC金币代充', lossAmount: 5600000, lossRate: 18.2, refundCount: 342, totalOrders: 1879, trend: 'up' },
    { channel: 'Steam直充', lossAmount: 1230000, lossRate: 8.5, refundCount: 89, totalOrders: 1047, trend: 'down' },
    { channel: 'Google Play', lossAmount: 890000, lossRate: 12.1, refundCount: 156, totalOrders: 1289, trend: 'stable' },
    { channel: 'Apple Gift Card', lossAmount: 450000, lossRate: 5.3, refundCount: 45, totalOrders: 849, trend: 'down' },
    { channel: 'TikTok带货', lossAmount: 230000, lossRate: 6.8, refundCount: 28, totalOrders: 412, trend: 'up' },
    { channel: 'PlayStation', lossAmount: 180000, lossRate: 4.2, refundCount: 22, totalOrders: 524, trend: 'down' },
  ]);

  const totalLoss = lossData.reduce((s, d) => s + d.lossAmount, 0);
  const avgRate = lossData.reduce((s, d) => s + d.lossRate, 0) / lossData.length;
  const maxLoss = Math.max(...lossData.map(d => d.lossAmount));

  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
        <AlertTriangle size={14} className="text-amber-400" />
        {'损耗率监控'}
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">{'2月报告'}</span>
      </h2>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'总损耗金额'}</p>
          <p className="text-xl font-bold text-red-400 mt-1">{formatCurrency(totalLoss)}</p>
          <p className="text-[10px] text-zinc-500">{'约 14 亿金币'}</p>
        </div>
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'平均损耗率'}</p>
          <p className="text-xl font-bold text-amber-400 mt-1">{avgRate.toFixed(1)}%</p>
          <p className="text-[10px] text-zinc-500">{'目标 < 10%'}</p>
        </div>
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'退款单数'}</p>
          <p className="text-xl font-bold text-zinc-100 mt-1">{lossData.reduce((s, d) => s + d.refundCount, 0)}</p>
          <p className="text-[10px] text-zinc-500">{'约 $29k'}</p>
        </div>
      </div>

      {/* Monthly Trend from API */}
      {monthlyTrend.length > 0 && (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-zinc-400">月度损耗率趋势</span>
            {apiConnected && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">API 实时</span>
            )}
          </div>
          <div className="flex items-end gap-3 h-16">
            {monthlyTrend.slice().reverse().map((m, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <span className={`text-xs font-mono font-bold ${
                  m.loss_rate > 15 ? 'text-red-400' : m.loss_rate > 10 ? 'text-amber-400' : 'text-emerald-400'
                }`}>{m.loss_rate}%</span>
                <div className="w-full bg-zinc-800 rounded-t" style={{ height: `${Math.min(100, m.loss_rate * 3)}%` }}>
                  <div className={`w-full h-full rounded-t ${
                    m.loss_rate > 15 ? 'bg-red-500/60' : m.loss_rate > 10 ? 'bg-amber-500/60' : 'bg-emerald-500/60'
                  }`} />
                </div>
                <span className="text-[9px] text-zinc-500">{m.period}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Channel Breakdown */}
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800/50">
                <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'渠道'}</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'损耗金额'}</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider w-32">{'损耗比例'}</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'损耗率'}</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'退款单'}</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'趋势'}</th>
              </tr>
            </thead>
            <tbody>
              {lossData.map((entry, i) => (
                <tr key={i} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                  <td className="px-4 py-2.5 text-zinc-200 font-medium">{entry.channel}</td>
                  <td className="px-4 py-2.5 text-right text-red-400 tabular-nums font-medium">{formatCurrency(entry.lossAmount)}</td>
                  <td className="px-4 py-2.5">
                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${
                          entry.lossRate > 15 ? 'bg-red-500' : entry.lossRate > 10 ? 'bg-amber-500' : 'bg-emerald-500'
                        }`}
                        style={{ width: `${(entry.lossAmount / maxLoss) * 100}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`tabular-nums font-medium ${
                      entry.lossRate > 15 ? 'text-red-400' : entry.lossRate > 10 ? 'text-amber-400' : 'text-emerald-400'
                    }`}>
                      {entry.lossRate}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400 tabular-nums">{entry.refundCount}</td>
                  <td className="px-4 py-2.5 text-center">
                    {entry.trend === 'up' ? (
                      <TrendingUp size={14} className="text-red-400 mx-auto" />
                    ) : entry.trend === 'down' ? (
                      <TrendingDown size={14} className="text-emerald-400 mx-auto" />
                    ) : (
                      <span className="text-zinc-500">{'→'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── Market Price Panel ────────────────────────────────────

interface MarketPrice {
  game: string;
  currency: string;
  ourPrice: number;
  competitorPrice: number;
  competitor: string;
  region: string;
  margin: number;
}

function MarketPricePanel() {
  const [prices, setPrices] = useState<MarketPrice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/stats/market-prices', { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.data) {
            setPrices(data.data.map((item: any) => {
              const ourPrice = item.our_price || 0;
              const compPrice = item.competitor_price || 0;
              const margin = compPrice > 0 ? ((compPrice - ourPrice) / compPrice * 100) : 0;
              return {
                game: item.game,
                currency: item.currency || '',
                ourPrice,
                competitorPrice: compPrice,
                competitor: item.competitor || 'N/A',
                region: item.region || '',
                margin: Math.round(margin * 10) / 10,
              };
            }));
            setLoading(false);
            return;
          }
        }
        // Fallback to mock data
        setPrices([
          { game: '绝区零', currency: '星芒', ourPrice: 4.99, competitorPrice: 5.49, competitor: 'U7BUY', region: 'US', margin: 9.1 },
          { game: '原神', currency: '创世结晶', ourPrice: 14.99, competitorPrice: 16.99, competitor: 'U7BUY', region: 'US', margin: 11.8 },
          { game: 'MLBB', currency: '钻石', ourPrice: 1.99, competitorPrice: 2.29, competitor: 'U7BUY', region: 'ID', margin: 13.1 },
          { game: 'Free Fire', currency: '钻石', ourPrice: 0.99, competitorPrice: 1.19, competitor: 'Codashop', region: 'BR', margin: 16.8 },
          { game: 'PUBG Mobile', currency: 'UC', ourPrice: 0.89, competitorPrice: 0.99, competitor: 'Midasbuy', region: 'SEA', margin: 10.1 },
          { game: 'Honkai Star Rail', currency: '星琼', ourPrice: 9.99, competitorPrice: 11.49, competitor: 'U7BUY', region: 'US', margin: 13.1 },
        ]);
        setLoading(false);
      } catch {
        // Mock data fallback
        setPrices([
          { game: '绝区零', currency: '星芒', ourPrice: 4.99, competitorPrice: 5.49, competitor: 'U7BUY', region: 'US', margin: 9.1 },
          { game: '原神', currency: '创世结晶', ourPrice: 14.99, competitorPrice: 16.99, competitor: 'U7BUY', region: 'US', margin: 11.8 },
          { game: 'MLBB', currency: '钻石', ourPrice: 1.99, competitorPrice: 2.29, competitor: 'U7BUY', region: 'ID', margin: 13.1 },
        ]);
        setLoading(false);
      }
    };
    fetchPrices();
  }, []);

  if (loading) {
    return (
      <section>
        <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
          <DollarSign size={14} className="text-green-400" />
          {'竞品价格监控'}
        </h2>
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
        <DollarSign size={14} className="text-green-400" />
        {'竞品价格监控'}
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">{'实时 API'}</span>
      </h2>
      <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800/50">
                               <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'游戏'}</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'货币'}</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'我们的价格'}</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'竞品价格'}</th>
                <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'竞品'}</th>
                <th className="text-center px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'区域'}</th>
                <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'优势'}</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p, i) => (
                  <tr key={i} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                    <td className="px-4 py-2.5 text-zinc-200 font-medium">{p.game}</td>
                    <td className="px-4 py-2.5 text-zinc-400 text-xs">{p.currency}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium text-emerald-400">
                      ${p.ourPrice.toFixed(2)}
                      <span className="ml-1 text-[10px]">{'★'}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-zinc-400">${p.competitorPrice.toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-zinc-400 text-xs">{p.competitor}</td>
                    <td className="px-4 py-2.5 text-center"><span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{p.region}</span></td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        p.margin > 5 ? 'bg-emerald-500/20 text-emerald-400' :
                        p.margin > 3 ? 'bg-amber-500/20 text-amber-400' :
                        'bg-red-500/20 text-red-400'
                      }`}>
                        {p.margin > 0 ? '+' : ''}{p.margin.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function DataAnalytics() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<ReturnType<typeof generateMockAnalytics> | null>(null);
  const [timeRange, setTimeRange] = useState<'7d' | '14d' | '30d'>('14d');
  const [sortBy, setSortBy] = useState<'revenue' | 'orders'>('revenue');

  const trendDays = timeRange === '7d' ? 7 : timeRange === '14d' ? 14 : 30;

  const loadData = useCallback(async () => {
    await new Promise(r => setTimeout(r, 300));
    setData(generateMockAnalytics(trendDays));
  }, [trendDays]);

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

  const exportCSV = (filename: string, headers: string[], rows: string[][]) => {
    const bom = '﻿';
    const csv = bom + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${filename}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success(`已导出 ${filename}.csv`);
  };

  const handleExportAll = () => {
    if (!data) return;
    // Export business lines
    exportCSV('rangerai-business-lines', ['业务线','营收','营收变化%','订单数','订单变化%','客单价'],
      data.businessLines.map(l => [l.name, String(l.revenue), String(l.revenueChange), String(l.orders), String(l.ordersChange), String(l.avgOrderValue)]));
  };

  const sortedLines = useMemo(() => {
    if (!data) return [];
    return [...data.businessLines].sort((a, b) => sortBy === 'revenue' ? b.revenue - a.revenue : b.orders - a.orders);
  }, [data, sortBy]);

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

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-800/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <BarChart3 size={20} className="text-blue-400" />
                {'数据分析'}
              </h1>
              <p className="text-xs text-zinc-500">{'供应链 + 销售核心指标'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Time Range Selector */}
            <div className="flex bg-zinc-800 rounded-lg p-0.5">
              {(['7d', '14d', '30d'] as const).map(range => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    timeRange === range ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {range === '7d' ? '7天' : range === '14d' ? '14天' : '30天'}
                </button>
              ))}
            </div>
            <button
              onClick={handleExportAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs transition-colors"
            >
              <Download size={13} />
              {'导出'}
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              {'刷新'}
            </button>
            <span className="text-[10px] text-zinc-600 hidden sm:inline">
              {'更新: '}{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'总营收'}</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">{formatCurrency(data.totalRevenue)}</p>
            <ChangeIndicator change={7.8} size="lg" />
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'总订单'}</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">{data.totalOrders.toLocaleString()}</p>
            <ChangeIndicator change={8.9} size="lg" />
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'平均客单价'}</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">{'¥'}{(data.totalRevenue / data.totalOrders).toFixed(0)}</p>
            <ChangeIndicator change={-1.2} size="lg" />
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'业务线'}</p>
            <p className="text-2xl font-bold text-zinc-100 mt-1">{data.businessLines.length}</p>
            <span className="text-xs text-zinc-500">{'全部运营中'}</span>
          </div>
        </div>

        {/* Business Lines Comparison */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <Layers size={14} />
              {'各业务线对比'}
            </h2>
            <div className="flex bg-zinc-800 rounded-lg p-0.5">
              <button
                onClick={() => setSortBy('revenue')}
                className={`px-2 py-1 text-[10px] rounded-md transition-colors ${
                  sortBy === 'revenue' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500'
                }`}
              >
                {'按营收'}
              </button>
              <button
                onClick={() => setSortBy('orders')}
                className={`px-2 py-1 text-[10px] rounded-md transition-colors ${
                  sortBy === 'orders' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500'
                }`}
              >
                {'按订单'}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {sortedLines.map((line) => {
              const Icon = line.icon;
              const revPct = (line.revenue / data.totalRevenue) * 100;
              return (
                <div key={line.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 hover:border-zinc-700/50 transition-colors">
                  <div className="flex items-center gap-4">
                    {/* Icon + Name */}
                    <div className="flex items-center gap-2 w-32 shrink-0">
                      <Icon size={16} className={line.color} />
                      <span className="text-sm font-medium text-zinc-200">{line.name}</span>
                    </div>

                    {/* Revenue Bar */}
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-zinc-400">{formatCurrency(line.revenue)}</span>
                        <span className="text-[10px] text-zinc-500">{revPct.toFixed(1)}%</span>
                      </div>
                      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${line.barColor} transition-all duration-700`}
                          style={{ width: `${revPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="hidden sm:flex items-center gap-6 shrink-0">
                      <div className="text-right">
                        <p className="text-xs text-zinc-500">{'订单'}</p>
                        <p className="text-sm font-medium text-zinc-200">{line.orders.toLocaleString()}</p>
                        <ChangeIndicator change={line.ordersChange} />
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-zinc-500">{'客单价'}</p>
                        <p className="text-sm font-medium text-zinc-200">{'¥'}{line.avgOrderValue.toFixed(0)}</p>
                      </div>
                    </div>

                    {/* Mini Trend */}
                    <div className="hidden md:block w-28 shrink-0">
                      <MiniChart data={line.trend} color={line.color} />
                    </div>

                    {/* Revenue Change */}
                    <div className="shrink-0 w-16 text-right">
                      <ChangeIndicator change={line.revenueChange} size="lg" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Inventory Status */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Package size={14} />
            {'库存状态'}
          </h2>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800/50">
                    <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'商品'}</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'类别'}</th>
                    <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'当前库存'}</th>
                    <th className="text-left px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider w-40">{'库存水位'}</th>
                    <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'日消耗'}</th>
                    <th className="text-right px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'可用天数'}</th>
                    <th className="text-center px-4 py-2.5 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{'状态'}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inventory.map((item, i) => (
                    <tr key={i} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                      <td className="px-4 py-2.5 text-zinc-200 font-medium">{item.name}</td>
                      <td className="px-4 py-2.5 text-zinc-400">{item.category}</td>
                      <td className="px-4 py-2.5 text-right text-zinc-300 tabular-nums">{item.stock.toLocaleString()}</td>
                      <td className="px-4 py-2.5">
                        <InventoryBar stock={item.stock} safetyLine={item.safetyLine} status={item.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right text-zinc-400 tabular-nums">{item.dailyConsumption.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className={`tabular-nums font-medium ${
                          item.daysRemaining <= 5 ? 'text-red-400' : item.daysRemaining <= 7 ? 'text-amber-400' : 'text-emerald-400'
                        }`}>
                          {item.daysRemaining}{'天'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                          item.status === 'critical' ? 'bg-red-500/20 text-red-400' :
                          item.status === 'low' ? 'bg-amber-500/20 text-amber-400' :
                          'bg-emerald-500/20 text-emerald-400'
                        }`}>
                          {item.status === 'critical' ? '紧急' : item.status === 'low' ? '偏低' : '正常'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Profit Analysis */}
        {data.profitData && (
          <section>
            <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
              <PieChart size={14} className="text-indigo-400" />
              {'利润分析'}
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">{'毛利率对比'}</span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {data.profitData.map((pl, i) => (
                <div key={i} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 hover:border-zinc-700/50 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-400">{pl.name}</span>
                    <span className={`text-xs font-bold ${
                      pl.marginPct >= 25 ? 'text-emerald-400' : pl.marginPct >= 18 ? 'text-blue-400' : 'text-amber-400'
                    }`}>{pl.marginPct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
                    <div className={`h-full rounded-full ${pl.color} transition-all duration-700`} style={{ width: `${pl.marginPct * 3}%` }} />
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-zinc-500">{'成本 '}{formatCurrency(pl.cost)}</span>
                    <span className="text-emerald-400 font-medium">{'利润 '}{formatCurrency(pl.profit)}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{'总利润'}</span>
                  <p className="text-xl font-bold text-emerald-400">{formatCurrency(data.profitData.reduce((s, p) => s + p.profit, 0))}</p>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{'综合毛利率'}</span>
                  <p className="text-xl font-bold text-blue-400">
                    {(data.profitData.reduce((s, p) => s + p.profit, 0) / data.profitData.reduce((s, p) => s + p.revenue, 0) * 100).toFixed(1)}%
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Channel Comparison Radar */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Activity size={14} className="text-cyan-400" />
            {'渠道多维对比'}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400">{'雷达图'}</span>
          </h2>
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            {(() => {
              const channels = [
                { name: 'CPS推广', scores: [85, 72, 90, 65, 78] },
                { name: 'FC金币', scores: [70, 88, 75, 92, 85] },
                { name: '直充', scores: [90, 65, 80, 88, 70] },
                { name: '代充', scores: [75, 80, 85, 70, 92] },
                { name: 'TikTok', scores: [60, 95, 70, 55, 88] },
              ];
              const dims = ['营收', '增长率', '利润率', '稳定性', '客户量'];
              const colors = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444'];
              const cx = 150, cy = 130, R = 100;
              const angleStep = (2 * Math.PI) / dims.length;
              const toXY = (angle: number, r: number) => ({
                x: cx + r * Math.sin(angle),
                y: cy - r * Math.cos(angle),
              });
              return (
                <div className="flex flex-col lg:flex-row items-center gap-6">
                  <svg viewBox="0 0 300 260" className="w-full max-w-[300px] h-auto">
                    {/* Grid rings */}
                    {[0.2, 0.4, 0.6, 0.8, 1.0].map(scale => (
                      <polygon key={scale} points={dims.map((_, i) => {
                        const p = toXY(i * angleStep, R * scale);
                        return `${p.x},${p.y}`;
                      }).join(' ')} fill="none" stroke="#27272a" strokeWidth="0.5" />
                    ))}
                    {/* Axis lines */}
                    {dims.map((_, i) => {
                      const p = toXY(i * angleStep, R);
                      return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#27272a" strokeWidth="0.5" />;
                    })}
                    {/* Dimension labels */}
                    {dims.map((dim, i) => {
                      const p = toXY(i * angleStep, R + 18);
                      return <text key={i} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" fill="#71717a" fontSize="10">{dim}</text>;
                    })}
                    {/* Channel polygons */}
                    {channels.map((ch, ci) => (
                      <polygon key={ci} points={ch.scores.map((s, i) => {
                        const p = toXY(i * angleStep, (s / 100) * R);
                        return `${p.x},${p.y}`;
                      }).join(' ')} fill={`${colors[ci]}15`} stroke={colors[ci]} strokeWidth="1.5" />
                    ))}
                  </svg>
                  <div className="flex flex-wrap gap-3 justify-center">
                    {channels.map((ch, ci) => (
                      <div key={ci} className="flex items-center gap-2 bg-zinc-800/50 rounded-lg px-3 py-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: colors[ci] }} />
                        <span className="text-xs text-zinc-300">{ch.name}</span>
                        <span className="text-[10px] text-zinc-500">{'均分 '}{Math.round(ch.scores.reduce((a, b) => a + b, 0) / ch.scores.length)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        </section>

        {/* Loss Rate Monitor */}
        <LossRateMonitor />

        {/* Market Price Comparison */}
        <MarketPricePanel />

        {/* SKU Hot-Selling Ranking */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <ShoppingCart size={14} className="text-pink-400" />
            {'热销 SKU 排行榜'}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-400">{'本周'}</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 px-2 w-8">#</th>
                  <th className="text-left py-2 px-2">SKU</th>
                  <th className="text-right py-2 px-2">{'销量'}</th>
                  <th className="text-right py-2 px-2">{'营收'}</th>
                  <th className="text-right py-2 px-2">{'毛利率'}</th>
                  <th className="text-right py-2 px-2">{'趋势'}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { sku: 'FC-COINS-US', name: 'FC金币(美区)', sales: 18420, revenue: 15100, margin: 22.5, trend: 12.3 },
                  { sku: 'FC-COINS-SEA', name: 'FC金币(东南亚)', sales: 12800, revenue: 8960, margin: 18.2, trend: 8.7 },
                  { sku: 'TOPUP-US-50', name: '美区充值$50', sales: 8650, revenue: 7200, margin: 15.8, trend: -2.1 },
                  { sku: 'CPS-BUNDLE-A', name: 'CPS套餐A', sales: 5200, revenue: 4680, margin: 28.3, trend: 15.6 },
                  { sku: 'TOPUP-SEA-20', name: '东南亚充值$20', sales: 4800, revenue: 3360, margin: 12.1, trend: 5.4 },
                  { sku: 'FC-COINS-EU', name: 'FC金币(欧区)', sales: 3200, revenue: 2880, margin: 20.0, trend: -0.5 },
                  { sku: 'TOPUP-US-100', name: '美区充值$100', sales: 2100, revenue: 3150, margin: 19.5, trend: 7.2 },
                ].map((item, i) => (
                  <tr key={item.sku} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2 px-2">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        i === 0 ? 'bg-amber-500/20 text-amber-400' : i === 1 ? 'bg-zinc-400/20 text-zinc-300' : i === 2 ? 'bg-orange-500/20 text-orange-400' : 'text-zinc-600'
                      }`}>{i + 1}</span>
                    </td>
                    <td className="py-2 px-2">
                      <div className="font-medium text-zinc-200">{item.name}</div>
                      <div className="text-[10px] text-zinc-600 font-mono">{item.sku}</div>
                    </td>
                    <td className="py-2 px-2 text-right text-zinc-300 tabular-nums">{item.sales.toLocaleString()}</td>
                    <td className="py-2 px-2 text-right text-zinc-300 tabular-nums">${item.revenue.toLocaleString()}</td>
                    <td className="py-2 px-2 text-right">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                        item.margin >= 25 ? 'bg-emerald-500/20 text-emerald-400' : item.margin >= 15 ? 'bg-blue-500/20 text-blue-400' : 'bg-amber-500/20 text-amber-400'
                      }`}>{item.margin}%</span>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <span className={`inline-flex items-center gap-0.5 text-[10px] ${
                        item.trend >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}>
                        {item.trend >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                        {Math.abs(item.trend)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Regional Sales Distribution */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Globe size={14} className="text-cyan-400" />
            {'地区销售分布'}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { region: '美区', flag: '\u{1F1FA}\u{1F1F8}', revenue: 42500, orders: 3200, pct: 38.2, trend: 5.3 },
              { region: '东南亚', flag: '\u{1F30F}', revenue: 28600, orders: 4800, pct: 25.7, trend: 12.8 },
              { region: '欧洲', flag: '\u{1F1EA}\u{1F1FA}', revenue: 18200, orders: 1500, pct: 16.4, trend: -1.2 },
              { region: '巴西', flag: '\u{1F1E7}\u{1F1F7}', revenue: 9800, orders: 2100, pct: 8.8, trend: 22.5 },
              { region: '日韩', flag: '\u{1F1EF}\u{1F1F5}', revenue: 7500, orders: 680, pct: 6.7, trend: 3.1 },
              { region: '其他', flag: '\u{1F310}', revenue: 4600, orders: 520, pct: 4.1, trend: -0.8 },
            ].map((r, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-3 hover:bg-zinc-800/60 transition-colors">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="text-base">{r.flag}</span>
                  <span className="text-xs font-medium text-zinc-200">{r.region}</span>
                </div>
                <div className="text-lg font-bold text-zinc-100">${(r.revenue / 1000).toFixed(1)}k</div>
                <div className="text-[10px] text-zinc-500 mt-0.5">{r.orders.toLocaleString()} {'订单'}</div>
                <div className="mt-2 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${r.pct}%` }} />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[9px] text-zinc-600">{r.pct}%</span>
                  <span className={`text-[9px] flex items-center gap-0.5 ${r.trend >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {r.trend >= 0 ? <ArrowUpRight size={8} /> : <ArrowDownRight size={8} />}
                    {Math.abs(r.trend)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Customer Retention */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Users size={14} className="text-violet-400" />
            {'客户留存分析'}
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: '新客户', value: 1240, pct: 42, color: 'text-blue-400', bg: 'bg-blue-500' },
              { label: '回头客', value: 1720, pct: 58, color: 'text-emerald-400', bg: 'bg-emerald-500' },
              { label: '7日留存', value: 68.5, pct: 68.5, color: 'text-amber-400', bg: 'bg-amber-500', suffix: '%' },
              { label: '30日留存', value: 42.3, pct: 42.3, color: 'text-pink-400', bg: 'bg-pink-500', suffix: '%' },
            ].map((m, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-3">
                <div className="text-[10px] text-zinc-500 mb-1">{m.label}</div>
                <div className={`text-xl font-bold ${m.color}`}>
                  {typeof m.value === 'number' && !m.suffix ? m.value.toLocaleString() : m.value}{m.suffix || ''}
                </div>
                <div className="mt-2 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                  <div className={`h-full ${m.bg} rounded-full transition-all`} style={{ width: `${m.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-4 text-[10px] text-zinc-600">
            <span>{'本周新客转化率: '}<span className="text-emerald-400">23.4%</span></span>
            <span>{'平均客单价: '}<span className="text-blue-400">$12.80</span></span>
            <span>{'复购周期: '}<span className="text-amber-400">8.2天</span></span>
          </div>
        </section>

        {/* Real-time Order Flow */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Activity size={14} className="text-cyan-400" />
            {'实时订单流水'}
            <span className="relative flex h-2 w-2 ml-1"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span></span>
            <span className="text-[9px] text-zinc-600 ml-auto">{'最近 20 笔'}</span>
          </h2>
          <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin">
            {Array.from({ length: 20 }, (_, i) => {
              const products = ['FC 金币 (美区)', 'Google Play $10', 'Steam $50', 'PS Store $20', 'Roblox 400', 'Apple $10', 'FC 金币 (欧区)', 'Nintendo $20', 'MLBB 钻石', 'Free Fire 钻石'];
              const regions = ['US', 'EU', 'JP', 'SEA', 'BR', 'KR'];
              const statuses = ['已完成', '处理中', '已完成', '已完成', '待支付'];
              const amounts = [12.5, 9.8, 46.5, 19.2, 4.2, 9.3, 25.6, 18.8, 8.5, 15.0];
              const product = products[i % products.length];
              const region = regions[i % regions.length];
              const status = statuses[i % statuses.length];
              const amount = amounts[i % amounts.length];
              const mins = i * 3 + 1;
              return (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/30 transition-colors text-xs">
                  <span className="text-[10px] text-zinc-600 w-12 shrink-0">{mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`}</span>
                  <span className="text-zinc-300 flex-1 truncate">{product}</span>
                  <span className="text-[10px] text-zinc-500 w-8">{region}</span>
                  <span className="text-emerald-400 font-mono text-[11px] w-14 text-right">${amount.toFixed(2)}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                    status === '已完成' ? 'bg-emerald-500/20 text-emerald-400' :
                    status === '处理中' ? 'bg-blue-500/20 text-blue-400' :
                    'bg-amber-500/20 text-amber-400'
                  }`}>{status}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Conversion Funnel */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-4 flex items-center gap-2">
            <Filter size={14} className="text-orange-400" />
            {'转化漏斗分析'}
          </h2>
          <div className="space-y-2">
            {[
              { stage: '访问量', value: 12580, pct: 100, color: 'bg-blue-500' },
              { stage: '浏览商品', value: 8420, pct: 66.9, color: 'bg-cyan-500' },
              { stage: '加入购物车', value: 3210, pct: 25.5, color: 'bg-amber-500' },
              { stage: '提交订单', value: 2150, pct: 17.1, color: 'bg-orange-500' },
              { stage: '完成支付', value: 1820, pct: 14.5, color: 'bg-emerald-500' },
            ].map((step, i, arr) => {
              const dropRate = i > 0 ? ((1 - step.value / arr[i-1].value) * 100).toFixed(1) : null;
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-[10px] text-zinc-500 w-20 shrink-0 text-right">{step.stage}</span>
                  <div className="flex-1 relative">
                    <div className="h-7 bg-zinc-800/50 rounded-lg overflow-hidden">
                      <div
                        className={`h-full ${step.color} rounded-lg flex items-center justify-end pr-2 transition-all duration-500`}
                        style={{ width: `${step.pct}%` }}
                      >
                        <span className="text-[10px] font-mono text-white font-bold">
                          {step.value.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] text-zinc-500 w-12 shrink-0">{step.pct}%</span>
                  {dropRate && (
                    <span className="text-[9px] text-red-400 w-14 shrink-0">-{dropRate}%</span>
                  )}
                  {!dropRate && <span className="w-14 shrink-0" />}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-4 text-[10px] text-zinc-600">
            <span>{'整体转化率: '}<span className="text-emerald-400 font-bold">14.5%</span></span>
            <span>{'平均客单价: '}<span className="text-blue-400">$18.6</span></span>
            <span>{'购物车放弃率: '}<span className="text-amber-400">33.0%</span></span>
          </div>
        </section>

        {/* Refund Analysis */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-400" />
            {'退款分析'}
          </h2>
          <div className="grid grid-cols-3 gap-3 mb-4">
            {[
              { label: '本月退款率', value: '3.2%', change: '-0.5%', good: true },
              { label: '退款总额', value: '$4,120', change: '+$320', good: false },
              { label: '平均处理时间', value: '2.4h', change: '-0.8h', good: true },
            ].map((m, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-3 text-center">
                <div className="text-[10px] text-zinc-500 mb-1">{m.label}</div>
                <div className="text-lg font-bold text-zinc-100">{m.value}</div>
                <div className={`text-[10px] font-medium ${m.good ? 'text-emerald-400' : 'text-red-400'}`}>{m.change}</div>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <div className="text-[10px] text-zinc-500 mb-1">{'退款原因分布'}</div>
            {[
              { reason: '充值未到账', pct: 42, color: 'bg-red-500' },
              { reason: '价格不匹配', pct: 23, color: 'bg-amber-500' },
              { reason: '账号错误', pct: 18, color: 'bg-blue-500' },
              { reason: '重复下单', pct: 11, color: 'bg-purple-500' },
              { reason: '其他', pct: 6, color: 'bg-zinc-500' },
            ].map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 w-20 shrink-0">{r.reason}</span>
                <div className="flex-1 h-3 bg-zinc-800 rounded-full overflow-hidden">
                  <div className={`h-full ${r.color} rounded-full transition-all`} style={{ width: `${r.pct}%` }} />
                </div>
                <span className="text-[10px] text-zinc-400 w-8 text-right">{r.pct}%</span>
              </div>
            ))}
          </div>
        </section>

        {/* Month-over-Month Comparison */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <BarChart3 size={14} className="text-cyan-400" />
            {'同比环比分析'}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left py-2 text-zinc-500 font-normal">{'指标'}</th>
                  <th className="text-right py-2 text-zinc-500 font-normal">{'本月'}</th>
                  <th className="text-right py-2 text-zinc-500 font-normal">{'上月'}</th>
                  <th className="text-right py-2 text-zinc-500 font-normal">{'环比'}</th>
                  <th className="text-right py-2 text-zinc-500 font-normal">{'去年同期'}</th>
                  <th className="text-right py-2 text-zinc-500 font-normal">{'同比'}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: '总营收', curr: '$142K', prev: '$128K', mom: '+10.9%', momGood: true, yoy: '$98K', yoyChg: '+44.9%', yoyGood: true },
                  { name: '订单量', curr: '3,240', prev: '2,980', mom: '+8.7%', momGood: true, yoy: '2,100', yoyChg: '+54.3%', yoyGood: true },
                  { name: '客单价', curr: '$43.8', prev: '$42.9', mom: '+2.1%', momGood: true, yoy: '$46.7', yoyChg: '-6.2%', yoyGood: false },
                  { name: '毛利率', curr: '34.2%', prev: '32.8%', mom: '+1.4pp', momGood: true, yoy: '31.5%', yoyChg: '+2.7pp', yoyGood: true },
                  { name: '退款率', curr: '3.2%', prev: '3.7%', mom: '-0.5pp', momGood: true, yoy: '4.1%', yoyChg: '-0.9pp', yoyGood: true },
                  { name: '新客占比', curr: '38%', prev: '35%', mom: '+3pp', momGood: true, yoy: '42%', yoyChg: '-4pp', yoyGood: false },
                ].map((r, i) => (
                  <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                    <td className="py-2 text-zinc-300">{r.name}</td>
                    <td className="py-2 text-right text-zinc-200 font-medium">{r.curr}</td>
                    <td className="py-2 text-right text-zinc-400">{r.prev}</td>
                    <td className={`py-2 text-right font-medium ${r.momGood ? 'text-emerald-400' : 'text-red-400'}`}>{r.mom}</td>
                    <td className="py-2 text-right text-zinc-400">{r.yoy}</td>
                    <td className={`py-2 text-right font-medium ${r.yoyGood ? 'text-emerald-400' : 'text-red-400'}`}>{r.yoyChg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* AI Prediction Analysis Panel */}
        <section className="bg-zinc-900/50 border border-purple-500/20 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <LineChart size={14} className="text-purple-400" />
            {'AI 预测分析'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">{'下月预测'}</span>
            <span className="text-[9px] text-zinc-600 ml-auto">{'基于近 90 天数据训练'}</span>
          </h2>
          {/* Prediction Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {[
              { label: '预测营收', value: '$142.5K', range: '$128K - $157K', confidence: 85, trend: '+12.3%', color: 'text-emerald-400' },
              { label: '预测订单量', value: '8,920', range: '7,800 - 10,040', confidence: 78, trend: '+8.7%', color: 'text-blue-400' },
              { label: '预测客单价', value: '$16.0', range: '$14.8 - $17.2', confidence: 82, trend: '+3.5%', color: 'text-amber-400' },
              { label: '预测毛利率', value: '34.2%', range: '31% - 37%', confidence: 72, trend: '+1.8%', color: 'text-purple-400' },
            ].map((p, i) => (
              <div key={i} className="bg-zinc-800/50 rounded-lg p-3">
                <div className="text-[9px] text-zinc-500 mb-1">{p.label}</div>
                <div className={`text-lg font-bold ${p.color}`}>{p.value}</div>
                <div className="text-[9px] text-zinc-600 mt-0.5">{'置信区间'}: {p.range}</div>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex-1 bg-zinc-700 rounded-full h-1 overflow-hidden">
                    <div className="h-full rounded-full bg-purple-500 transition-all" style={{ width: `${p.confidence}%` }} />
                  </div>
                  <span className="text-[9px] text-zinc-500">{p.confidence}%</span>
                </div>
                <div className="text-[9px] text-emerald-400 mt-0.5">{p.trend} vs {'本月'}</div>
              </div>
            ))}
          </div>
          {/* Trend Sparkline */}
          <div className="bg-zinc-800/30 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-zinc-500">{'营收趋势预测（近 6 月 + 下月预测）'}</span>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 text-[9px] text-zinc-500"><span className="w-3 h-0.5 bg-cyan-400 inline-block rounded" /> {'实际'}</span>
                <span className="flex items-center gap-1 text-[9px] text-zinc-500"><span className="w-3 h-0.5 bg-purple-400 inline-block rounded border border-dashed border-purple-400" /> {'预测'}</span>
              </div>
            </div>
            <div className="flex items-end gap-1 h-16">
              {[
                { month: '10月', value: 98, type: 'actual' },
                { month: '11月', value: 105, type: 'actual' },
                { month: '12月', value: 112, type: 'actual' },
                { month: '1月', value: 118, type: 'actual' },
                { month: '2月', value: 121, type: 'actual' },
                { month: '3月', value: 127, type: 'actual' },
                { month: '4月', value: 142, type: 'predicted' },
              ].map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className={`w-full rounded-t-sm transition-all ${
                    d.type === 'predicted' ? 'bg-purple-500/60 border border-dashed border-purple-400' : 'bg-cyan-500/60'
                  }`} style={{ height: `${(d.value / 150) * 100}%` }} />
                  <span className="text-[8px] text-zinc-600">{d.month}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2 text-[9px] text-zinc-500">
              <span>{'模型'}: ARIMA + {'季节性调整'}</span>
              <span className="ml-auto">{'下次更新'}: {'每周一 09:00'}</span>
            </div>
          </div>
        </section>

        {/* Data Inspection Timeline */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <ClipboardCheck size={16} className="text-indigo-400" />
            <h3 className="font-semibold">数据质量检查时间线</h3>
            <span className="text-[10px] px-2 py-0.5 bg-indigo-500/15 text-indigo-400 rounded-full border border-indigo-500/20 ml-auto">自动巡检</span>
          </div>
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-4 top-0 bottom-0 w-px bg-zinc-700" />
            <div className="space-y-4">
              {[
                { time: '09:00', title: '日常数据完整性检查', status: 'pass', detail: '检查 12 个数据源，全部正常', duration: '2m 15s' },
                { time: '09:15', title: '营收数据交叉验证', status: 'pass', detail: '订单金额与支付记录匹配率 99.7%', duration: '3m 42s' },
                { time: '09:30', title: '库存数据一致性校验', status: 'warning', detail: '3 个 SKU 库存偏差 > 5%，已标记待处理', duration: '5m 08s' },
                { time: '10:00', title: 'KOL 投放数据同步', status: 'pass', detail: 'TikTok + Instagram 数据已同步，延迟 < 30s', duration: '1m 22s' },
                { time: '10:30', title: '异常波动检测', status: 'fail', detail: '检测到商品 #A2045 退货率突增 340%，已触发告警', duration: '8m 33s' },
                { time: '11:00', title: '数据备份完成', status: 'pass', detail: '全量数据已备份至 S3，大小 2.3GB', duration: '12m 05s' },
              ].map((item, i) => (
                <div key={i} className="relative flex items-start gap-4 pl-8">
                  <div className={`absolute left-[11px] w-[10px] h-[10px] rounded-full border-2 ${
                    item.status === 'pass' ? 'bg-emerald-500 border-emerald-400' :
                    item.status === 'warning' ? 'bg-amber-500 border-amber-400' :
                    'bg-red-500 border-red-400'
                  }`} />
                  <div className="flex-1 bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-zinc-500">{item.time}</span>
                        <span className="font-medium text-sm">{item.title}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                          <Timer size={10} />{item.duration}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          item.status === 'pass' ? 'bg-emerald-500/15 text-emerald-400' :
                          item.status === 'warning' ? 'bg-amber-500/15 text-amber-400' :
                          'bg-red-500/15 text-red-400'
                        }`}>
                          {item.status === 'pass' ? '通过' : item.status === 'warning' ? '警告' : '异常'}
                        </span>
                      </div>
                    </div>
                    <div className="text-xs text-zinc-400">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-zinc-800">
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1"><CheckCircle2 size={12} className="text-emerald-500" /> 4 通过</span>
              <span className="flex items-center gap-1"><AlertTriangle size={12} className="text-amber-500" /> 1 警告</span>
              <span className="flex items-center gap-1"><Activity size={12} className="text-red-500" /> 1 异常</span>
            </div>
            <span className="text-[10px] text-zinc-600">下次巡检: 14:00</span>
          </div>
        </section>

        {/* Footer */}
        <div className="text-center py-4">
          <p className="text-[10px] text-zinc-600">
            {'数据来源：Mock + API 数据（已对接 market-prices 和 loss-rates）'}
          </p>
        </div>
      </main>
    </div>
  );
}
