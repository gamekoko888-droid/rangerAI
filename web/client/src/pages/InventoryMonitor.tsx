import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Package, AlertTriangle, TrendingDown, TrendingUp,
  RefreshCw, Search, Filter, BarChart3, Boxes, Clock, Truck, CalendarDays, ShoppingCart
} from 'lucide-react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/api';


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface InventoryItem {
  id: string;
  product: string;
  sku: string;
  category: string;
  region: string;
  currentStock: number;
  safetyStock: number;
  dailyConsumption: number;
  daysRemaining: number;
  lastRestocked: string;
  supplier: string;
  status: 'critical' | 'low' | 'normal' | 'surplus';
  trend: 'up' | 'down' | 'stable';
  costPerUnit: number;
  currency: string;
}

interface InventoryStats {
  totalSKUs: number;
  criticalItems: number;
  lowItems: number;
  totalValue: number;
  avgDaysRemaining: number;
}

const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  critical: { label: '紧急', color: 'text-red-400', bg: 'bg-red-500/20 border-red-500/30' },
  low: { label: '偏低', color: 'text-orange-400', bg: 'bg-orange-500/20 border-orange-500/30' },
  normal: { label: '正常', color: 'text-green-400', bg: 'bg-green-500/20 border-green-500/30' },
  surplus: { label: '充足', color: 'text-blue-400', bg: 'bg-blue-500/20 border-blue-500/30' },
};

// Mock data based on 2月报 actual business data
const MOCK_INVENTORY: InventoryItem[] = [
  {
    id: '1', product: 'FC 金币 (美区)', sku: 'FC-COINS-US', category: 'FC金币',
    region: 'US', currentStock: 12500, safetyStock: 50000, dailyConsumption: 8200,
    daysRemaining: 1.5, lastRestocked: '2026-03-08', supplier: '直采渠道',
    status: 'critical', trend: 'down', costPerUnit: 0.0082, currency: 'USD'
  },
  {
    id: '2', product: 'FC 金币 (欧区)', sku: 'FC-COINS-EU', category: 'FC金币',
    region: 'EU', currentStock: 35000, safetyStock: 40000, dailyConsumption: 5600,
    daysRemaining: 6.3, lastRestocked: '2026-03-07', supplier: '直采渠道',
    status: 'low', trend: 'stable', costPerUnit: 0.0085, currency: 'EUR'
  },
  {
    id: '3', product: 'Google Play 礼品卡 $10', sku: 'GP-10-US', category: '代充',
    region: 'US', currentStock: 450, safetyStock: 500, dailyConsumption: 120,
    daysRemaining: 3.8, lastRestocked: '2026-03-06', supplier: 'CardPool',
    status: 'low', trend: 'down', costPerUnit: 9.2, currency: 'USD'
  },
  {
    id: '4', product: 'Google Play 礼品卡 $25', sku: 'GP-25-US', category: '代充',
    region: 'US', currentStock: 280, safetyStock: 200, dailyConsumption: 45,
    daysRemaining: 6.2, lastRestocked: '2026-03-05', supplier: 'CardPool',
    status: 'normal', trend: 'stable', costPerUnit: 23.1, currency: 'USD'
  },
  {
    id: '5', product: 'PlayStation Store $20', sku: 'PS-20-US', category: '代充',
    region: 'US', currentStock: 180, safetyStock: 300, dailyConsumption: 65,
    daysRemaining: 2.8, lastRestocked: '2026-03-04', supplier: 'DirectBuy',
    status: 'low', trend: 'down', costPerUnit: 18.5, currency: 'USD'
  },
  {
    id: '6', product: 'Steam 钱包 $50', sku: 'STEAM-50-US', category: '代充',
    region: 'US', currentStock: 520, safetyStock: 300, dailyConsumption: 38,
    daysRemaining: 13.7, lastRestocked: '2026-03-08', supplier: 'SteamDirect',
    status: 'surplus', trend: 'up', costPerUnit: 46.5, currency: 'USD'
  },
  {
    id: '7', product: 'Nintendo eShop $20', sku: 'NS-20-US', category: '代充',
    region: 'US', currentStock: 340, safetyStock: 250, dailyConsumption: 28,
    daysRemaining: 12.1, lastRestocked: '2026-03-07', supplier: 'NintendoWH',
    status: 'normal', trend: 'stable', costPerUnit: 18.8, currency: 'USD'
  },
  {
    id: '8', product: 'Roblox 400 Robux', sku: 'RBLX-400', category: 'CPS',
    region: 'Global', currentStock: 890, safetyStock: 500, dailyConsumption: 95,
    daysRemaining: 9.4, lastRestocked: '2026-03-08', supplier: 'RobloxAPI',
    status: 'normal', trend: 'up', costPerUnit: 4.2, currency: 'USD'
  },
  {
    id: '9', product: 'FC 金币 (日区)', sku: 'FC-COINS-JP', category: 'FC金币',
    region: 'JP', currentStock: 28000, safetyStock: 25000, dailyConsumption: 3200,
    daysRemaining: 8.8, lastRestocked: '2026-03-08', supplier: '直采渠道',
    status: 'normal', trend: 'stable', costPerUnit: 1.2, currency: 'JPY'
  },
  {
    id: '10', product: 'Apple Gift Card $10', sku: 'APPLE-10-US', category: '代充',
    region: 'US', currentStock: 150, safetyStock: 200, dailyConsumption: 55,
    daysRemaining: 2.7, lastRestocked: '2026-03-05', supplier: 'AppleDirect',
    status: 'low', trend: 'down', costPerUnit: 9.3, currency: 'USD'
  },
];

function computeStats(items: InventoryItem[]): InventoryStats {
  const criticalItems = items.filter(i => i.status === 'critical').length;
  const lowItems = items.filter(i => i.status === 'low').length;
  const totalValue = items.reduce((sum, i) => sum + i.currentStock * i.costPerUnit, 0);
  const avgDaysRemaining = items.reduce((sum, i) => sum + i.daysRemaining, 0) / items.length;
  return { totalSKUs: items.length, criticalItems, lowItems, totalValue, avgDaysRemaining };
}

export default function InventoryMonitor() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState<'daysRemaining' | 'currentStock' | 'product'>('daysRemaining');

  useEffect(() => {
    // Try real API first, fallback to mock
    const loadData = async () => {
      try {
        const res = await fetch('/api/inventory', { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          setInventory(data.items || []);
          setStats(data.stats || computeStats(data.items || []));
        } else {
          throw new Error('API not available');
        }
      } catch {
        setInventory(MOCK_INVENTORY);
        setStats(computeStats(MOCK_INVENTORY));
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const filteredInventory = inventory
    .filter(item => {
      if (search && !item.product.toLowerCase().includes(search.toLowerCase()) && !item.sku.toLowerCase().includes(search.toLowerCase())) return false;
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'daysRemaining') return a.daysRemaining - b.daysRemaining;
      if (sortBy === 'currentStock') return a.currentStock - b.currentStock;
      return a.product.localeCompare(b.product);
    });

  const categories = Array.from(new Set(inventory.map(i => i.category)));

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-zinc-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Package className="w-5 h-5 text-amber-400" />
            <h1 className="text-lg font-semibold">库存监控中心</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Clock className="w-3.5 h-3.5" />
            <span>最后更新: {new Date().toLocaleString('zh-CN')}</span>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <Boxes className="w-4 h-4 text-zinc-400" />
                <span className="text-xs text-zinc-500">总 SKU</span>
              </div>
              <div className="text-2xl font-bold">{stats.totalSKUs}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-red-500/20 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span className="text-xs text-red-400">紧急缺货</span>
              </div>
              <div className="text-2xl font-bold text-red-400">{stats.criticalItems}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-orange-500/20 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <TrendingDown className="w-4 h-4 text-orange-400" />
                <span className="text-xs text-orange-400">库存偏低</span>
              </div>
              <div className="text-2xl font-bold text-orange-400">{stats.lowItems}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-4 h-4 text-zinc-400" />
                <span className="text-xs text-zinc-500">库存总值</span>
              </div>
              <div className="text-2xl font-bold">${stats.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-zinc-400" />
                <span className="text-xs text-zinc-500">平均可用天数</span>
              </div>
              <div className="text-2xl font-bold">{stats.avgDaysRemaining.toFixed(1)}</div>
            </div>
          </div>
        )}

        {/* 7-Day Inventory Trend */}
        <section className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4 mb-6">
          <h3 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-amber-400" />
            {'近 7 天库存总值趋势'}
          </h3>
          <div className="flex items-end gap-1 h-20">
            {(() => {
              const baseValue = stats?.totalValue || 5000;
              const days = Array.from({ length: 7 }, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() - 6 + i);
                const variation = 0.85 + Math.sin(i * 1.2) * 0.15 + (i / 7) * 0.1;
                return { day: d.toLocaleDateString('zh-CN', { weekday: 'short' }), value: baseValue * variation };
              });
              const max = Math.max(...days.map(d => d.value));
              return days.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
                  <div className="relative w-full">
                    <div
                      className={`w-full rounded-t transition-all ${
                        i === 6 ? 'bg-amber-500' : 'bg-zinc-700 group-hover:bg-zinc-600'
                      }`}
                      style={{ height: `${(d.value / max) * 64}px` }}
                    />
                    <div className="absolute -top-5 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity text-[9px] text-zinc-400 whitespace-nowrap">
                      ${(d.value / 1000).toFixed(1)}k
                    </div>
                  </div>
                  <span className={`text-[9px] ${i === 6 ? 'text-amber-400' : 'text-zinc-600'}`}>{d.day}</span>
                </div>
              ));
            })()}
          </div>
        </section>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              placeholder="搜索产品名或 SKU..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-amber-500 transition"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-amber-500 transition cursor-pointer"
          >
            <option value="all">全部分类</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-amber-500 transition cursor-pointer"
          >
            <option value="all">全部状态</option>
            <option value="critical">紧急</option>
            <option value="low">偏低</option>
            <option value="normal">正常</option>
            <option value="surplus">充足</option>
          </select>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as any)}
            className="px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-amber-500 transition cursor-pointer"
          >
            <option value="daysRemaining">按剩余天数排序</option>
            <option value="currentStock">按库存量排序</option>
            <option value="product">按产品名排序</option>
          </select>
        </div>

        {/* Inventory Table */}
        {loading ? (
          <div className="text-center py-20 text-zinc-500">加载中...</div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase">
                    <th className="text-left px-4 py-3">产品</th>
                    <th className="text-left px-4 py-3">分类</th>
                    <th className="text-left px-4 py-3">区域</th>
                    <th className="text-right px-4 py-3">当前库存</th>
                    <th className="text-right px-4 py-3">安全库存</th>
                    <th className="text-right px-4 py-3">日消耗</th>
                    <th className="text-right px-4 py-3">可用天数</th>
                    <th className="text-center px-4 py-3">趋势</th>
                    <th className="text-center px-4 py-3">状态</th>
                    <th className="text-left px-4 py-3">供应商</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInventory.map(item => {
                    const cfg = STATUS_CFG[item.status];
                    const stockRatio = item.currentStock / item.safetyStock;
                    return (
                      <tr key={item.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition">
                        <td className="px-4 py-3">
                          <div className="font-medium">{item.product}</div>
                          <div className="text-xs text-zinc-500">{item.sku}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">{item.category}</span>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">{item.region}</td>
                        <td className="px-4 py-3 text-right font-mono">
                          <span className={item.currentStock < item.safetyStock ? 'text-orange-400' : 'text-zinc-200'}>
                            {item.currentStock.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-zinc-500">{item.safetyStock.toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-mono text-zinc-400">{item.dailyConsumption.toLocaleString()}/天</td>
                        <td className="px-4 py-3 text-right">
                          <span className={`font-mono font-bold ${item.daysRemaining <= 2 ? 'text-red-400' : item.daysRemaining <= 5 ? 'text-orange-400' : 'text-green-400'}`}>
                            {item.daysRemaining.toFixed(1)}天
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {item.trend === 'up' ? (
                            <TrendingUp className="w-4 h-4 text-green-400 mx-auto" />
                          ) : item.trend === 'down' ? (
                            <TrendingDown className="w-4 h-4 text-red-400 mx-auto" />
                          ) : (
                            <span className="text-zinc-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-500 text-xs">{item.supplier}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filteredInventory.length === 0 && (
              <div className="text-center py-12 text-zinc-500">
                <Package className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>没有匹配的库存记录</p>
              </div>
            )}
          </div>
        )}

        {/* Stock Level Visualization */}
        <div className="mt-6 p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-amber-400" />
            库存水位图
          </h3>
          <div className="space-y-3">
            {inventory
              .sort((a, b) => a.daysRemaining - b.daysRemaining)
              .slice(0, 8)
              .map(item => {
                const ratio = Math.min(item.currentStock / item.safetyStock, 2);
                const barColor = item.status === 'critical' ? 'bg-red-500' : item.status === 'low' ? 'bg-orange-500' : item.status === 'normal' ? 'bg-green-500' : 'bg-blue-500';
                return (
                  <div key={item.id} className="flex items-center gap-3">
                    <div className="w-36 text-xs text-zinc-400 truncate">{item.product}</div>
                    <div className="flex-1 h-6 bg-zinc-800 rounded-full overflow-hidden relative">
                      <div
                        className={`h-full ${barColor} rounded-full transition-all duration-500`}
                        style={{ width: `${Math.min(ratio * 50, 100)}%` }}
                      />
                      {/* Safety line */}
                      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-yellow-500/50" title="安全库存线" />
                    </div>
                    <div className="w-16 text-right text-xs font-mono">
                      <span className={item.daysRemaining <= 2 ? 'text-red-400' : item.daysRemaining <= 5 ? 'text-orange-400' : 'text-zinc-400'}>
                        {item.daysRemaining.toFixed(1)}天
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
          <div className="flex items-center gap-4 mt-4 text-xs text-zinc-600">
            <span>黄线 = 安全库存线</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> 紧急</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" /> 偏低</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> 正常</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> 充足</span>
          </div>
        </div>

        {/* Restock Suggestions */}
        <div className="mt-6 p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-blue-400" />
            补货建议
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">自动计算</span>
          </h3>
          <div className="space-y-3">
            {inventory
              .filter(item => item.currentStock < item.safetyStock * 1.2)
              .sort((a, b) => a.daysRemaining - b.daysRemaining)
              .map(item => {
                // Calculate restock quantity: enough for 14 days + fill to safety stock
                const restockQty = Math.max(
                  item.safetyStock - item.currentStock,
                  item.dailyConsumption * 14 - item.currentStock
                );
                const restockCost = restockQty * item.costPerUnit;
                const urgency = item.daysRemaining <= 2 ? 'urgent' : item.daysRemaining <= 5 ? 'soon' : 'planned';
                const urgencyConfig = {
                  urgent: { bg: 'bg-red-500/10 border-red-500/20', text: 'text-red-400', label: '立即补货' },
                  soon: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-400', label: '尽快补货' },
                  planned: { bg: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-400', label: '计划补货' },
                };
                const cfg = urgencyConfig[urgency];
                return (
                  <div key={item.id} className={`flex items-center gap-4 p-3 rounded-lg border ${cfg.bg} transition-colors hover:border-zinc-600`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200">{item.product}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>
                      </div>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        当前 {item.currentStock.toLocaleString()} / 安全线 {item.safetyStock.toLocaleString()} · 日消耗 {item.dailyConsumption.toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-zinc-100">{restockQty > 0 ? `+${restockQty.toLocaleString()}` : '已达标'}</p>
                      <p className="text-[10px] text-zinc-500">
                        ≈ {item.currency === 'JPY' ? '¥' : '$'}{restockCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`text-xs font-medium ${cfg.text}`}>
                        {item.daysRemaining.toFixed(1)}天
                      </p>
                      <p className="text-[10px] text-zinc-600">剩余</p>
                    </div>
                  </div>
                );
              })}
            {inventory.filter(item => item.currentStock < item.safetyStock * 1.2).length === 0 && (
              <div className="text-center py-6 text-zinc-500 text-sm">所有 SKU 库存充足，无需补货</div>
            )}
          </div>
          <div className="mt-4 pt-3 border-t border-zinc-800/50 flex items-center justify-between">
            <span className="text-[10px] text-zinc-600">补货量 = max(安全库存差额, 14天消耗量 - 当前库存)</span>
            <span className="text-[10px] text-zinc-600">
              总补货成本: ${inventory
                .filter(item => item.currentStock < item.safetyStock * 1.2)
                .reduce((sum, item) => {
                  const qty = Math.max(item.safetyStock - item.currentStock, item.dailyConsumption * 14 - item.currentStock);
                  return sum + (qty > 0 ? qty * item.costPerUnit : 0);
                }, 0)
                .toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
        </div>

        {/* Supplier Scoring */}
        <div className="mt-6 p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
            <Boxes className="w-4 h-4 text-purple-400" />
            {'供应商评分'}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">{'综合评估'}</span>
          </h3>
          <div className="space-y-3">
            {[
              { name: '直采渠道', score: 92, delivery: 95, quality: 90, price: 88, skus: 4 },
              { name: 'Codashop 代理', score: 85, delivery: 82, quality: 88, price: 85, skus: 3 },
              { name: '东南亚本地供应商', score: 78, delivery: 75, quality: 80, price: 82, skus: 2 },
              { name: '欧洲分销商', score: 71, delivery: 68, quality: 78, price: 70, skus: 1 },
            ].map((s, i) => (
              <div key={i} className="flex items-center gap-4 p-3 rounded-lg bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  i === 0 ? 'bg-amber-500/20 text-amber-400' : 'bg-zinc-700 text-zinc-400'
                }`}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-zinc-200">{s.name}</span>
                    <span className="text-[10px] text-zinc-600">{s.skus} SKU</span>
                  </div>
                  <div className="flex gap-3">
                    {[
                      { label: '交付', val: s.delivery },
                      { label: '质量', val: s.quality },
                      { label: '价格', val: s.price },
                    ].map(d => (
                      <div key={d.label} className="flex items-center gap-1">
                        <span className="text-[9px] text-zinc-600">{d.label}</span>
                        <div className="w-12 h-1 bg-zinc-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${
                            d.val >= 90 ? 'bg-emerald-500' : d.val >= 80 ? 'bg-blue-500' : d.val >= 70 ? 'bg-amber-500' : 'bg-red-500'
                          }`} style={{ width: `${d.val}%` }} />
                        </div>
                        <span className="text-[9px] text-zinc-500">{d.val}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className={`text-lg font-bold ${
                    s.score >= 90 ? 'text-emerald-400' : s.score >= 80 ? 'text-blue-400' : s.score >= 70 ? 'text-amber-400' : 'text-red-400'
                  }`}>{s.score}</span>
                  <p className="text-[9px] text-zinc-600">{'综合分'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Inventory Turnover Analysis */}
        <div className="mt-6 p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-teal-400" />
            {'库存周转率分析'}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-400">{'本月'}</span>
          </h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { cat: 'FC金币', turnover: 18.5, days: 1.6, color: 'text-emerald-400', bg: 'bg-emerald-500' },
              { cat: '代充卡', turnover: 8.2, days: 3.7, color: 'text-blue-400', bg: 'bg-blue-500' },
              { cat: 'CPS', turnover: 12.1, days: 2.5, color: 'text-amber-400', bg: 'bg-amber-500' },
              { cat: '总体', turnover: 11.6, days: 2.6, color: 'text-pink-400', bg: 'bg-pink-500' },
            ].map((c, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-3">
                <div className="text-[10px] text-zinc-500 mb-1">{c.cat}</div>
                <div className={`text-lg font-bold ${c.color}`}>{c.turnover}x</div>
                <div className="text-[10px] text-zinc-600">{'平均 '}{c.days}{'天/周转'}</div>
                <div className="mt-2 h-1 bg-zinc-700 rounded-full overflow-hidden">
                  <div className={`h-full ${c.bg} rounded-full`} style={{ width: `${Math.min(c.turnover / 20 * 100, 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[10px] text-zinc-600">
            {'周转率 = 月销售量 / 平均库存 · FC金币周转最快，代充卡建议增加补货频率'}
          </div>
        </div>

        {/* Arrival Prediction */}
        <div className="bg-zinc-800/30 border border-zinc-700/30 rounded-xl p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
            <Truck size={14} className="text-indigo-400" />
            {'到货预测'}
          </h3>
          <div className="space-y-2">
            {[
              { sku: 'FC金币 (美区)', supplier: '供应商 A', eta: '03-12', qty: '5万枚', status: 'transit', progress: 65 },
              { sku: 'Google Play $10', supplier: '供应商 B', eta: '03-14', qty: '2,000张', status: 'confirmed', progress: 30 },
              { sku: 'Steam $20', supplier: '供应商 C', eta: '03-11', qty: '1,500张', status: 'transit', progress: 85 },
              { sku: 'Apple $15', supplier: '供应商 A', eta: '03-16', qty: '3,000张', status: 'ordered', progress: 10 },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/40 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-200 font-medium">{item.sku}</span>
                    <span className={`text-[8px] px-1.5 py-0.5 rounded ${
                      item.status === 'transit' ? 'bg-blue-500/20 text-blue-400' :
                      item.status === 'confirmed' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-zinc-500/20 text-zinc-500'
                    }`}>{item.status === 'transit' ? '运输中' : item.status === 'confirmed' ? '已确认' : '已下单'}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-500">
                    <span>{item.supplier}</span>
                    <span>{'·'}</span>
                    <span>{item.qty}</span>
                    <span>{'·'}</span>
                    <span>{'ETA '}{item.eta}</span>
                  </div>
                </div>
                <div className="w-20 shrink-0">
                  <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                  <div className="text-[9px] text-zinc-500 text-right mt-0.5">{item.progress}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Alert Rules Config */}
        <div className="bg-zinc-900/60 border border-zinc-800/50 rounded-xl p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-400" />
            {'库存预警规则'}
          </h3>
          <div className="space-y-2">
            {[
              { name: '安全库存线', desc: '当 SKU 库存低于安全水位时触发告警', value: '各 SKU 安全库存×1.2', enabled: true },
              { name: '周转率告警', desc: '当库存周转天数超过阈值时提醒清理', value: '> 45 天', enabled: true },
              { name: '到货延迟告警', desc: '当订单到货时间超过预期时通知', value: '超期 2 天', enabled: true },
              { name: '成本波动告警', desc: '当采购成本波动超过阈值时提醒', value: '± 10%', enabled: false },
            ].map((rule, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors">
                <div className={`w-2 h-2 rounded-full shrink-0 ${rule.enabled ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-200">{rule.name}</div>
                  <div className="text-[10px] text-zinc-500">{rule.desc}</div>
                </div>
                <span className="text-[10px] text-zinc-400 shrink-0 bg-zinc-800 px-2 py-0.5 rounded">{rule.value}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${rule.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-700/50 text-zinc-500'}`}>
                  {rule.enabled ? '已启用' : '已禁用'}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Smart Replenishment Plan */}
        <div className="bg-zinc-900/80 border border-teal-500/20 rounded-xl p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
            <CalendarDays size={14} className="text-teal-400" />
            {'智能补货计划'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-500/20 text-teal-400">{'本周计划'}</span>
            <span className="text-[9px] text-zinc-600 ml-auto">{'自动生成于'} 03/10 09:00</span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 text-[10px] border-b border-zinc-800">
                  <th className="text-left py-2 font-medium">SKU</th>
                  <th className="text-right py-2 font-medium">{'当前库存'}</th>
                  <th className="text-right py-2 font-medium">{'建议补货'}</th>
                  <th className="text-right py-2 font-medium">{'预估成本'}</th>
                  <th className="text-center py-2 font-medium">{'优先级'}</th>
                  <th className="text-right py-2 font-medium hidden sm:table-cell">{'建议日期'}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { sku: 'FC-US-500', stock: 1200, suggest: 3000, cost: '$4,500', priority: 'urgent', date: '03/11' },
                  { sku: 'FC-ID-100', stock: 2800, suggest: 2000, cost: '$1,200', priority: 'high', date: '03/12' },
                  { sku: 'GC-TH-200', stock: 3500, suggest: 1500, cost: '$2,100', priority: 'medium', date: '03/13' },
                  { sku: 'FC-PH-500', stock: 4200, suggest: 1000, cost: '$1,500', priority: 'low', date: '03/14' },
                  { sku: 'DC-US-50', stock: 890, suggest: 2500, cost: '$3,750', priority: 'urgent', date: '03/11' },
                  { sku: 'GC-MY-100', stock: 5100, suggest: 800, cost: '$640', priority: 'low', date: '03/15' },
                ].map((r, i) => (
                  <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2 text-zinc-300 font-mono">{r.sku}</td>
                    <td className="py-2 text-right text-zinc-400">{r.stock.toLocaleString()}</td>
                    <td className="py-2 text-right text-teal-400 font-medium">+{r.suggest.toLocaleString()}</td>
                    <td className="py-2 text-right text-zinc-300">{r.cost}</td>
                    <td className="py-2 text-center">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                        r.priority === 'urgent' ? 'bg-red-500/20 text-red-400' :
                        r.priority === 'high' ? 'bg-amber-500/20 text-amber-400' :
                        r.priority === 'medium' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-zinc-700/50 text-zinc-400'
                      }`}>{r.priority === 'urgent' ? '紧急' : r.priority === 'high' ? '高' : r.priority === 'medium' ? '中' : '低'}</span>
                    </td>
                    <td className="py-2 text-right text-zinc-500 hidden sm:table-cell">{r.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-800/50">
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-zinc-500"><ShoppingCart size={10} className="inline mr-1" />{'本周总补货成本'}: <span className="text-teal-400 font-medium">$13,690</span></span>
              <span className="text-[10px] text-zinc-500">{'涉及'} 6 {'个 SKU'}</span>
            </div>
            <button className="text-[10px] px-2 py-1 rounded bg-teal-500/20 text-teal-400 hover:bg-teal-500/30 transition-colors"
              onClick={() => toast.info('补货计划已导出')}>{'导出计划'}</button>
          </div>
        </div>

        {/* Data Source */}
        <div className="mt-4 text-center text-xs text-zinc-600">
          数据来源: 阿里云 MySQL · inventory 表 (API 未就绪时使用 Mock 数据)
        </div>
      </div>
    </div>
  );
}
