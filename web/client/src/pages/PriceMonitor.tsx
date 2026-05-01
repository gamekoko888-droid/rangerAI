/**
 * FC26 Coins Price Monitor — 竞品价格对比看板
 *
 * 从 6 个竞品网站采集 FC26 金币价格，按平台（PS/Xbox/PC）展示：
 * - 实时价格对比表（按价格排序）
 * - 最后更新时间 + 手动刷新
 * - 价格趋势（如有历史数据）
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft, RefreshCw, TrendingDown, TrendingUp, Minus,
  Clock, ExternalLink, Trophy, Medal, Award, Loader2,
  Monitor, Gamepad2, Laptop, ChevronDown, ChevronUp, Info
} from 'lucide-react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/api';
import { logger } from "../lib/logger";

// ── Types ────────────────────────────────────────────────────────
interface PriceRow {
  id: number;
  site: string;
  platform: string;
  quantity: string;
  priceRaw: string;
  currencyRaw: string;
  priceUsd: string;
  pricePerK: string | null;
  bonus: string | null;
  scrapedAt: string;
  batchId: string;
}

interface LatestPricesResponse {
  batchId: string;
  scrapedAt: string;
  duration: number;
  prices: PriceRow[];
}

interface ScrapeLog {
  id: number;
  batchId: string;
  status: string;
  sitesScraped: number;
  sitesTotal: number;
  errors: string | null;
  duration: number;
  startedAt: string;
  completedAt: string | null;
}

interface TriggerResult {
  batchId: string;
  pricesCollected: number;
  errors: string[];
  durationMs: number;
}

// ── Site metadata ────────────────────────────────────────────────
const SITE_INFO: Record<string, { name: string; type: string; url: string; color: string; icon: string }> = {
  eldorado: { name: 'Eldorado', type: 'C2C', url: 'https://www.eldorado.gg/ea-fc-coins/g/142-0-0', color: 'text-amber-400', icon: '🏪' },
  u7buy: { name: 'U7BUY', type: 'B2C', url: 'https://www.u7buy.com/fc26/fc26-coins', color: 'text-blue-400', icon: '🛒' },
  iggm: { name: 'IGGM', type: 'B2C', url: 'https://www.iggm.com/fc-26-coins', color: 'text-green-400', icon: '🎮' },
  lootbar: { name: 'LootBar', type: 'B2C', url: 'https://lootbar.gg/game-coins/fc26', color: 'text-purple-400', icon: '💎' },
  mmoexp: { name: 'MMOexp', type: 'B2C', url: 'https://www.mmoexp.com/Fc-26/Coins.html', color: 'text-orange-400', icon: '⚡' },
  ldshop: { name: 'LDShop', type: 'B2C', url: 'https://www.ldshop.gg/game-coins/fc-26-coins.html', color: 'text-cyan-400', icon: '🏬' },
};

const PLATFORM_TABS = [
  { key: 'ps', label: 'PlayStation', icon: Gamepad2, color: 'text-blue-400' },
  { key: 'xbox', label: 'Xbox', icon: Monitor, color: 'text-green-400' },
  { key: 'pc', label: 'PC', icon: Laptop, color: 'text-purple-400' },
] as const;

// ── Helpers ──────────────────────────────────────────────────────
function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function formatPrice(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getRankIcon(rank: number) {
  if (rank === 0) return <Trophy className="w-4 h-4 text-amber-400" />;
  if (rank === 1) return <Medal className="w-4 h-4 text-zinc-300" />;
  if (rank === 2) return <Award className="w-4 h-4 text-amber-600" />;
  return <span className="text-xs text-zinc-500 w-4 text-center">{rank + 1}</span>;
}

// ── Main Component ───────────────────────────────────────────────
export default function PriceMonitor() {
  const [, navigate] = useLocation();
  const [platform, setPlatform] = useState<'ps' | 'xbox' | 'pc'>('ps');
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [scrapedAt, setScrapedAt] = useState<string | null>(null);
  const [batchDuration, setBatchDuration] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<ScrapeLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Fetch latest prices
  const fetchPrices = useCallback(async () => {
    try {
      const resp = await fetch('/api/trpc/fc26.latestPrices', {
        headers: authHeaders(),
        credentials: 'include',
      });
      const json = await resp.json();
      // tRPC with SuperJSON wraps data in result.data.json
      const data = (json?.result?.data?.json ?? json?.result?.data) as LatestPricesResponse | null;
      if (data && data.prices) {
        setPrices(data.prices);
        setScrapedAt(data.scrapedAt);
        setBatchDuration(data.duration);
      }
    } catch (err) {
      logger.error('Failed to fetch prices:', err);
      toast.error('获取价格数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Trigger manual scrape
  const triggerScrape = useCallback(async () => {
    setRefreshing(true);
    try {
      const resp = await fetch('/api/trpc/fc26.triggerScrape', {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'include',
        body: JSON.stringify({}),
      });
      const json = await resp.json();
      const result = (json?.result?.data?.json ?? json?.result?.data) as TriggerResult | undefined;
      if (result) {
        toast.success(`采集完成：${result.pricesCollected} 条价格，耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
        // Refresh prices
        await fetchPrices();
      } else {
        toast.error('采集失败');
      }
    } catch (err: any) {
      logger.error('Scrape trigger failed:', err);
      toast.error(`采集失败: ${err.message || '未知错误'}`);
    } finally {
      setRefreshing(false);
    }
  }, [fetchPrices]);

  // Fetch scrape logs
  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const resp = await fetch('/api/trpc/fc26.scrapeLogs?input=%7B%7D', {
        headers: authHeaders(),
        credentials: 'include',
      });
      const json = await resp.json();
      const data = (json?.result?.data?.json ?? json?.result?.data) as ScrapeLog[] | undefined;
      if (data) setLogs(data);
    } catch (err) {
      logger.error('Failed to fetch logs:', err);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrices();
  }, [fetchPrices]);

  useEffect(() => {
    if (showLogs && logs.length === 0) fetchLogs();
  }, [showLogs, logs.length, fetchLogs]);

  // Filter & sort prices for current platform (100K quantity)
  const platformPrices = useMemo(() => {
    const filtered = prices.filter(
      (p) => p.platform === platform && (p.quantity === '100k' || p.quantity === '100K')
    );
    // Group by site, take the lowest price per site
    const siteMap = new Map<string, PriceRow>();
    for (const p of filtered) {
      const existing = siteMap.get(p.site);
      if (!existing || parseFloat(p.priceUsd) < parseFloat(existing.priceUsd)) {
        siteMap.set(p.site, p);
      }
    }
    return Array.from(siteMap.values()).sort(
      (a, b) => parseFloat(a.priceUsd) - parseFloat(b.priceUsd)
    );
  }, [prices, platform]);

  // Stats
  const stats = useMemo(() => {
    if (platformPrices.length === 0) return null;
    const usdPrices = platformPrices.map((p) => parseFloat(p.priceUsd));
    const min = Math.min(...usdPrices);
    const max = Math.max(...usdPrices);
    const avg = usdPrices.reduce((s, v) => s + v, 0) / usdPrices.length;
    const spread = max - min;
    return { min, max, avg, spread, count: platformPrices.length };
  }, [platformPrices]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-800/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/dashboard')}
              className="p-1.5 rounded-lg hover:bg-zinc-800/60 transition text-zinc-400 hover:text-zinc-200"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">FC26 价格监控</h1>
              <p className="text-xs text-zinc-500">6 个竞品网站 · 3 个平台 · 实时对比</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {scrapedAt && (
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-zinc-500">
                <Clock className="w-3.5 h-3.5" />
                <span>{formatTime(scrapedAt)}</span>
              </div>
            )}
            <button
              onClick={triggerScrape}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/30 transition text-sm disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">{refreshing ? '采集中...' : '手动采集'}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Platform Tabs */}
        <div className="flex gap-2">
          {PLATFORM_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = platform === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setPlatform(tab.key)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-zinc-800 border border-zinc-700/50 text-zinc-100 shadow-lg shadow-black/20'
                    : 'bg-zinc-900/50 border border-zinc-800/30 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? tab.color : ''}`} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="最低价" value={formatPrice(stats.min)} sub="100K Coins" accent="text-emerald-400" />
            <StatCard label="最高价" value={formatPrice(stats.max)} sub="100K Coins" accent="text-red-400" />
            <StatCard label="平均价" value={formatPrice(stats.avg)} sub="100K Coins" accent="text-blue-400" />
            <StatCard label="价差" value={formatPrice(stats.spread)} sub={`${((stats.spread / stats.min) * 100).toFixed(0)}% 差距`} accent="text-amber-400" />
          </div>
        )}

        {/* Price Comparison Table */}
        <div className="bg-zinc-900/60 border border-zinc-800/50 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800/50 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">
              100K Coins 价格排名
            </h2>
            <span className="text-xs text-zinc-500">
              {platformPrices.length} 个网站 · 按价格升序
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
              <span className="ml-2 text-sm text-zinc-500">加载中...</span>
            </div>
          ) : platformPrices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
              <Info className="w-8 h-8 mb-2" />
              <p className="text-sm">暂无价格数据</p>
              <p className="text-xs mt-1">点击"手动采集"获取最新价格</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/30">
              {platformPrices.map((row, idx) => {
                const siteInfo = SITE_INFO[row.site] || { name: row.site, type: '?', url: '#', color: 'text-zinc-400', icon: '❓' };
                const usd = parseFloat(row.priceUsd);
                const lowestPrice = parseFloat(platformPrices[0].priceUsd);
                const pctAboveLowest = idx === 0 ? 0 : ((usd - lowestPrice) / lowestPrice) * 100;

                return (
                  <div
                    key={row.id}
                    className={`flex items-center gap-4 px-5 py-4 hover:bg-zinc-800/30 transition group ${
                      idx === 0 ? 'bg-emerald-500/5' : ''
                    }`}
                  >
                    {/* Rank */}
                    <div className="flex items-center justify-center w-8">
                      {getRankIcon(idx)}
                    </div>

                    {/* Site info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{siteInfo.icon}</span>
                        <span className={`font-semibold text-sm ${siteInfo.color}`}>
                          {siteInfo.name}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          siteInfo.type === 'C2C'
                            ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20'
                            : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
                        }`}>
                          {siteInfo.type}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-zinc-600">
                          {row.currencyRaw !== 'USD' ? `原始: ${row.currencyRaw}` : 'USD'}
                        </span>
                        <a
                          href={siteInfo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-zinc-600 hover:text-zinc-400 transition opacity-0 group-hover:opacity-100 flex items-center gap-0.5"
                        >
                          访问 <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>

                    {/* Price */}
                    <div className="text-right">
                      <div className={`text-lg font-bold tabular-nums ${
                        idx === 0 ? 'text-emerald-400' : 'text-zinc-200'
                      }`}>
                        {formatPrice(usd)}
                      </div>
                      {idx > 0 && (
                        <div className="flex items-center justify-end gap-1 mt-0.5">
                          <TrendingUp className="w-3 h-3 text-red-400" />
                          <span className="text-[11px] text-red-400">
                            +{pctAboveLowest.toFixed(1)}%
                          </span>
                        </div>
                      )}
                      {idx === 0 && (
                        <span className="text-[11px] text-emerald-500 font-medium">最低价</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* All Tiers Table */}
        <AllTiersTable prices={prices} platform={platform} />

        {/* Scrape Logs */}
        <div className="bg-zinc-900/60 border border-zinc-800/50 rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-zinc-800/20 transition"
          >
            <span className="text-sm font-medium text-zinc-400">采集日志</span>
            {showLogs ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
          </button>
          {showLogs && (
            <div className="border-t border-zinc-800/50">
              {logsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
                </div>
              ) : logs.length === 0 ? (
                <p className="text-center text-sm text-zinc-500 py-8">暂无采集记录</p>
              ) : (
                <div className="divide-y divide-zinc-800/30 max-h-64 overflow-y-auto">
                  {logs.map((log) => (
                    <div key={log.id} className="px-5 py-3 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${
                          log.status === 'completed' ? 'bg-emerald-400' :
                          log.status === 'running' ? 'bg-amber-400 animate-pulse' :
                          'bg-red-400'
                        }`} />
                        <span className="text-zinc-400">
                          {new Date(log.startedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-zinc-500">
                        <span>{log.sitesScraped}/{log.sitesTotal} 站</span>
                        {log.duration && <span>{(log.duration / 1000).toFixed(1)}s</span>}
                        {log.errors && (
                          <span className="text-red-400" title={log.errors}>
                            {JSON.parse(log.errors).length} 错误
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Info Footer */}
        <div className="text-center text-xs text-zinc-600 pb-8">
          <p>数据来源：Eldorado · U7BUY · IGGM · LootBar · MMOexp · LDShop</p>
          <p className="mt-1">C2C = 玩家间交易（价格波动大） · B2C = 平台直售（价格相对稳定）</p>
          <p className="mt-1">价格每 4 小时自动更新 · 所有价格已换算为 USD</p>
        </div>
      </main>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/50 rounded-xl p-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${accent}`}>{value}</p>
      <p className="text-[11px] text-zinc-600 mt-0.5">{sub}</p>
    </div>
  );
}

function AllTiersTable({ prices, platform }: { prices: PriceRow[]; platform: string }) {
  const [expanded, setExpanded] = useState(false);

  // Get all tiers for this platform, grouped by site
  const tiersBySite = useMemo(() => {
    const filtered = prices.filter((p) => p.platform === platform);
    const map = new Map<string, PriceRow[]>();
    for (const p of filtered) {
      if (!map.has(p.site)) map.set(p.site, []);
      map.get(p.site)!.push(p);
    }
    // Sort each site's tiers by quantity
    for (const [, tiers] of Array.from(map)) {
      tiers.sort((a: PriceRow, b: PriceRow) => {
        const qA = parseInt(a.quantity) || 0;
        const qB = parseInt(b.quantity) || 0;
        return qA - qB;
      });
    }
    return map;
  }, [prices, platform]);

  if (tiersBySite.size === 0) return null;

  // Check if any site has more than just 100k
  const hasMultipleTiers = Array.from(tiersBySite.values()).some((tiers) => tiers.length > 1);
  if (!hasMultipleTiers) return null;

  return (
    <div className="bg-zinc-900/60 border border-zinc-800/50 rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-zinc-800/20 transition"
      >
        <span className="text-sm font-medium text-zinc-400">完整价格梯度</span>
        {expanded ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
      </button>
      {expanded && (
        <div className="border-t border-zinc-800/50 p-4 space-y-4">
          {Array.from(tiersBySite.entries()).map(([site, tiers]) => {
            const siteInfo = SITE_INFO[site] || { name: site, color: 'text-zinc-400', icon: '❓' };
            return (
              <div key={site}>
                <div className="flex items-center gap-2 mb-2">
                  <span>{siteInfo.icon}</span>
                  <span className={`text-sm font-medium ${siteInfo.color}`}>{siteInfo.name}</span>
                  <span className="text-xs text-zinc-600">{tiers.length} 个梯度</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {tiers.map((t) => (
                    <div
                      key={`${t.site}-${t.quantity}`}
                      className="bg-zinc-800/40 border border-zinc-700/30 rounded-lg px-3 py-2 text-center"
                    >
                      <div className="text-xs text-zinc-500 uppercase">{t.quantity}</div>
                      <div className="text-sm font-semibold tabular-nums text-zinc-200">
                        ${parseFloat(t.priceUsd).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
