import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Plus, Search, Users, Globe, TrendingUp,
  Star, ExternalLink, ChevronDown, XCircle, Edit2, Trash2, RefreshCw,
  Award, AlertTriangle, Clock, Download, DollarSign, CalendarDays, Brain, Sparkles
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

interface Kol {
  id: number;
  name: string;
  platform: string;
  handle: string;
  followers: number;
  engagement_rate: number;
  category: string;
  country: string;
  language: string;
  contact_email: string;
  contact_phone: string;
  status: string;
  cooperation_status: string;
  notes: string;
  tags: string;
  last_contacted: string;
  created_at: string;
}

interface KolStats {
  total: number;
  by_platform: { platform: string; count: number }[];
  by_status: { status: string; count: number }[];
  by_country: { country: string; count: number }[];
  total_cooperations: number;
  active_cooperations: number;
}

const API_BASE = '/api/kols';

const platformIcons: Record<string, string> = {
  youtube: '📺', tiktok: '🎵', instagram: '📸', twitter: '🐦',
  facebook: '📘', twitch: '🎮', Other: '🌐',
};

const STATUS_KEYS: Record<string, { key: string; color: string }> = {
  active: { key: 'kol.status.active', color: 'bg-green-500/20 text-green-400' },
  inactive: { key: 'kol.status.inactive', color: 'bg-zinc-500/20 text-zinc-400' },
  blacklisted: { key: 'kol.status.blacklisted', color: 'bg-red-500/20 text-red-400' },
  pending: { key: 'kol.status.pending', color: 'bg-yellow-500/20 text-yellow-400' },
};

const COOP_KEYS: Record<string, { key: string; color: string }> = {
  none: { key: 'kol.coop.none', color: 'text-zinc-500' },
  contacted: { key: 'kol.coop.contacted', color: 'text-blue-400' },
  negotiating: { key: 'kol.coop.negotiating', color: 'text-yellow-400' },
  contracted: { key: 'kol.coop.contracted', color: 'text-emerald-400' },
  completed: { key: 'kol.coop.completed', color: 'text-purple-400' },
};

function formatFollowers(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

export default function KolManager() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [kols, setKols] = useState<Kol[]>([]);
  const [stats, setStats] = useState<KolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [editingKol, setEditingKol] = useState<Kol | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (platformFilter !== 'all') params.set('platform', platformFilter);
      const [kolsRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}?${params}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/stats`, { headers: authHeaders() }),
      ]);
      const kolsData = await kolsRes.json();
      const statsData = await statsRes.json();
      setKols(kolsData.kols || []);
      setStats(statsData);
    } catch (e) {
      logger.error('Failed to fetch KOLs:', e);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, platformFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const createKol = async (data: Partial<Kol>) => {
    try {
      await fetch(API_BASE, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      });
      setShowCreate(false);
      fetchData();
      toast.success(t('kol.addSuccess'));
    } catch (e) {
      logger.error('Failed to create KOL:', e);
      toast.error(t('kol.addFailed'));
    }
  };

  const updateKol = async (id: number, data: Partial<Kol>) => {
    try {
      await fetch(`${API_BASE}/${id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      });
      setEditingKol(null);
      fetchData();
      toast.success(t('kol.updateSuccess'));
    } catch (e) {
      logger.error('Failed to update KOL:', e);
      toast.error(t('kol.updateFailed'));
    }
  };

  const deleteKol = async (id: number) => {
    if (!confirm(t('kol.deleteConfirm'))) return;
    try {
      await fetch(`${API_BASE}/${id}`, { method: 'DELETE', headers: authHeaders() });
      fetchData();
      toast.success(t('kol.deleteSuccess'));
    } catch (e) {
      logger.error('Failed to delete KOL:', e);
      toast.error(t('kol.deleteFailed'));
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
            <h1 className="text-lg font-semibold">{t('kol.title')}</h1>
            {stats && <span className="text-sm text-zinc-500">{stats.total}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setRefreshing(true);
                setRefreshResult(null);
                try {
                  const res = await fetch(`${API_BASE}/batch-refresh`, { method: 'POST', headers: authHeaders() });
                  const data = await res.json();
                  setRefreshResult(`${t('kol.refreshed')} (${data.refreshed || 0})`);
                  setTimeout(() => setRefreshResult(null), 3000);
                  fetchData();
                } catch (e) {
                  setRefreshResult(t('kol.refreshFailed'));
                  setTimeout(() => setRefreshResult(null), 3000);
                } finally {
                  setRefreshing(false);
                }
              }}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-lg transition disabled:opacity-50"
              title={t('kol.refreshData')}
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? t('kol.refreshing') : t('kol.refreshData')}
            </button>
            <button
              onClick={() => toast.info('批量导入功能即将上线，支持 CSV/Excel 格式')}
              className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 rounded-lg transition border border-zinc-700/50"
            >
              <Download className="w-4 h-4" />
              {'批量导入'}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium transition"
            >
              <Plus className="w-4 h-4" /> {t('kol.addKol')}
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-zinc-400" />
                <span className="text-sm text-zinc-400">{t('kol.total')}</span>
              </div>
              <div className="text-2xl font-bold">{stats.total}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <Globe className="w-4 h-4 text-zinc-400" />
                <span className="text-sm text-zinc-400">{t('kol.platformCoverage')}</span>
              </div>
              <div className="text-2xl font-bold">{stats.by_platform.length}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-zinc-400" />
                <span className="text-sm text-zinc-400">{t('kol.cooperating')}</span>
              </div>
              <div className="text-2xl font-bold">{stats.active_cooperations}</div>
            </div>
            <div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <Star className="w-4 h-4 text-zinc-400" />
                <span className="text-sm text-zinc-400">{t('kol.totalCooperation')}</span>
              </div>
              <div className="text-2xl font-bold">{stats.total_cooperations}</div>
            </div>
          </div>
        )}

        {/* Search & Filter */}
        <div className="flex gap-3 mb-6">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              placeholder={t('kol.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-emerald-500 transition"
            />
          </div>
          <div className="relative">
            <select
              value={platformFilter}
              onChange={e => setPlatformFilter(e.target.value)}
              className="appearance-none pl-4 pr-10 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-emerald-500 transition cursor-pointer"
            >
              <option value="all">{t('kol.allPlatforms')}</option>
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
              <option value="twitter">Twitter/X</option>
              <option value="facebook">Facebook</option>
              <option value="twitch">Twitch</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          </div>
        </div>

        {/* KOL Grid */}
        {loading ? (
          <div className="text-center py-20 text-zinc-500">{t('common.loading')}</div>
        ) : kols.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t('kol.noData')}
            description={t('kol.noDataHint')}
            action={
              <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" /> {t('kol.addFirst')}
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {kols.map(kol => {
              const sl = STATUS_KEYS[kol.status] || STATUS_KEYS.active;
              const cl = COOP_KEYS[kol.cooperation_status] || COOP_KEYS.none;
              return (
                <div key={kol.id} onClick={() => navigate(`/kols/${kol.id}`)} className="p-4 bg-zinc-900/50 border border-zinc-800 rounded-xl hover:border-zinc-700 transition cursor-pointer">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-zinc-800 rounded-full flex items-center justify-center text-lg">
                        {platformIcons[kol.platform] || '🌐'}
                      </div>
                      <div>
                        <h3 className="font-medium">{kol.name}</h3>
                        <div className="flex items-center gap-1 text-xs text-zinc-500">
                          <span>{kol.platform}</span>
                          {kol.handle && <span>· @{kol.handle}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={(e) => { e.stopPropagation(); setEditingKol(kol); }} className="p-1.5 hover:bg-zinc-800 rounded-lg transition">
                        <Edit2 className="w-3.5 h-3.5 text-zinc-500" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteKol(kol.id); }} className="p-1.5 hover:bg-zinc-800 rounded-lg transition">
                        <Trash2 className="w-3.5 h-3.5 text-zinc-500" />
                      </button>
                    </div>
                  </div>

                  {/* Performance Score */}
                  {(() => {
                    const followerScore = Math.min(kol.followers / 100000, 1) * 30;
                    const engScore = Math.min(kol.engagement_rate / 10, 1) * 40;
                    const coopScore = kol.cooperation_status === 'contracted' ? 30 : kol.cooperation_status === 'completed' ? 25 : kol.cooperation_status === 'negotiating' ? 15 : 0;
                    const totalScore = Math.round(followerScore + engScore + coopScore);
                    const scoreColor = totalScore >= 70 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' : totalScore >= 40 ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30' : 'text-zinc-400 bg-zinc-800 border-zinc-700';
                    const scoreLabel = totalScore >= 70 ? 'A' : totalScore >= 40 ? 'B' : 'C';
                    return (
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="text-sm">
                            <span className="text-zinc-500">{t('kol.followers')}</span>
                            <span className="ml-1 font-medium">{formatFollowers(kol.followers)}</span>
                          </div>
                          {kol.engagement_rate > 0 && (
                            <div className="text-sm">
                              <span className="text-zinc-500">{t('kol.engagementRate')}</span>
                              <span className="ml-1 font-medium">{kol.engagement_rate}%</span>
                            </div>
                          )}
                          {kol.country && (
                            <div className="text-sm">
                              <span className="text-zinc-500">{t('kol.region')}</span>
                              <span className="ml-1">{kol.country}</span>
                            </div>
                          )}
                        </div>
                        <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${scoreColor}`}>
                          <Award size={11} />
                          {scoreLabel}{totalScore}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Contract Expiry Warning (mock: 30 days from last_contacted) */}
                  {kol.cooperation_status === 'contracted' && kol.last_contacted && (() => {
                    const lastContact = new Date(kol.last_contacted);
                    const expiryDate = new Date(lastContact.getTime() + 90 * 24 * 60 * 60 * 1000);
                    const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    if (daysLeft <= 30 && daysLeft > 0) {
                      return (
                        <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                          <AlertTriangle size={12} className="text-amber-400" />
                          <span className="text-[10px] text-amber-400">{'合同将于'} {daysLeft} {'天后到期'}</span>
                        </div>
                      );
                    }
                    if (daysLeft <= 0) {
                      return (
                        <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded-lg">
                          <Clock size={12} className="text-red-400" />
                          <span className="text-[10px] text-red-400">{'合同已到期，请尽快续约'}</span>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${sl.color}`}>{t(sl.key as any)}</span>
                    <span className={`text-xs ${cl.color}`}>{t(cl.key as any)}</span>
                    {kol.category && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">{kol.category}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* KOL Performance Comparison */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-6">
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <TrendingUp size={14} className="text-violet-400" />
            {'KOL 绩效对比 (Top 5)'}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 px-2 font-medium">KOL</th>
                  <th className="text-right py-2 px-2 font-medium">{'粉丝'}</th>
                  <th className="text-right py-2 px-2 font-medium">{'互动率'}</th>
                  <th className="text-right py-2 px-2 font-medium">GMV</th>
                  <th className="text-right py-2 px-2 font-medium">ROI</th>
                  <th className="text-center py-2 px-2 font-medium">{'评级'}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: '@GameMaster', fans: '2.1M', rate: '8.5%', gmv: '$45.2K', roi: '3.8x', grade: 'A' },
                  { name: '@PlayZone', fans: '890K', rate: '6.2%', gmv: '$28.7K', roi: '2.9x', grade: 'A' },
                  { name: '@GamerGirl', fans: '1.5M', rate: '5.8%', gmv: '$22.1K', roi: '2.4x', grade: 'B' },
                  { name: '@TopUpKing', fans: '450K', rate: '9.1%', gmv: '$18.5K', roi: '4.2x', grade: 'A' },
                  { name: '@MobileGuru', fans: '670K', rate: '4.3%', gmv: '$12.8K', roi: '1.8x', grade: 'B' },
                ].map((kol, i) => (
                  <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-2 px-2 text-zinc-200 font-medium">{kol.name}</td>
                    <td className="py-2 px-2 text-right text-zinc-400">{kol.fans}</td>
                    <td className="py-2 px-2 text-right text-emerald-400">{kol.rate}</td>
                    <td className="py-2 px-2 text-right text-blue-400 font-mono">{kol.gmv}</td>
                    <td className="py-2 px-2 text-right text-amber-400 font-mono">{kol.roi}</td>
                    <td className="py-2 px-2 text-center">
                      <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${
                        kol.grade === 'A' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                      }`}>{kol.grade}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* KOL Cost-Benefit Analysis */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-6">
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <DollarSign size={14} className="text-green-400" />
            {'成本效益分析'}
          </h2>
          <div className="space-y-2">
            {[
              { name: '@GamerPro', invest: '$2,500', revenue: '$18,200', roi: '628%', profit: '$15,700', rank: 1 },
              { name: '@SaveMoney', invest: '$1,800', revenue: '$12,400', roi: '589%', profit: '$10,600', rank: 2 },
              { name: '@TechReview', invest: '$3,200', revenue: '$15,600', roi: '388%', profit: '$12,400', rank: 3 },
              { name: '@GenshinFan', invest: '$1,200', revenue: '$5,800', roi: '383%', profit: '$4,600', rank: 4 },
              { name: '@SteamDeals', invest: '$800', revenue: '$2,900', roi: '263%', profit: '$2,100', rank: 5 },
            ].map((k) => (
              <div key={k.rank} className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/30 transition-colors">
                <span className="text-xs text-zinc-500 w-5">#{k.rank}</span>
                <span className="text-xs text-zinc-200 w-24 shrink-0">{k.name}</span>
                <div className="flex-1 flex items-center gap-4 text-[10px]">
                  <span className="text-zinc-500">{'投入'} <span className="text-zinc-300">{k.invest}</span></span>
                  <span className="text-zinc-500">{'产出'} <span className="text-emerald-400">{k.revenue}</span></span>
                  <span className="text-zinc-500">{'净利'} <span className="text-cyan-400">{k.profit}</span></span>
                </div>
                <span className="text-xs font-bold text-emerald-400 shrink-0">ROI {k.roi}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* KOL Collaboration Calendar */}
      <div className="bg-zinc-900/80 border border-pink-500/20 rounded-xl p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <CalendarDays size={14} className="text-pink-400" />
          {'合作日历'}
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-pink-500/20 text-pink-400">{'3月'}</span>
        </h3>
        {/* Mini Calendar Grid */}
        <div className="grid grid-cols-7 gap-1 mb-3">
          {['日','一','二','三','四','五','六'].map(d => (
            <div key={d} className="text-[9px] text-zinc-600 text-center py-0.5">{d}</div>
          ))}
          {Array.from({ length: 31 }, (_, i) => {
            const day = i + 1;
            const events: Record<number, { color: string; kol: string }> = {
              3: { color: 'bg-pink-500', kol: 'Luna' },
              5: { color: 'bg-cyan-500', kol: 'Alex' },
              8: { color: 'bg-amber-500', kol: 'Mia' },
              10: { color: 'bg-emerald-500', kol: 'Jay' },
              12: { color: 'bg-pink-500', kol: 'Luna' },
              15: { color: 'bg-purple-500', kol: 'Kai' },
              18: { color: 'bg-cyan-500', kol: 'Alex' },
              20: { color: 'bg-amber-500', kol: 'Mia' },
              22: { color: 'bg-emerald-500', kol: 'Jay' },
              25: { color: 'bg-pink-500', kol: 'Luna' },
              28: { color: 'bg-purple-500', kol: 'Kai' },
              30: { color: 'bg-cyan-500', kol: 'Alex' },
            };
            const ev = events[day];
            const isToday = day === 10;
            return (
              <div key={day} className={`relative text-[10px] text-center py-1 rounded ${
                isToday ? 'bg-pink-500/20 text-pink-400 font-bold' : ev ? 'bg-zinc-800/80 text-zinc-300' : 'text-zinc-600'
              } hover:bg-zinc-700/50 transition-colors cursor-default`}
                title={ev ? `${ev.kol} - 内容发布` : ''}
              >
                {day}
                {ev && <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${ev.color}`} />}
              </div>
            );
          })}
        </div>
        {/* Upcoming Schedule */}
        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-500 mb-1">{'近期排期'}</div>
          {[
            { date: '03/10', kol: 'Jay Gaming', type: '直播带货', color: 'bg-emerald-500' },
            { date: '03/12', kol: 'Luna Beauty', type: '开箱视频', color: 'bg-pink-500' },
            { date: '03/15', kol: 'Kai Tech', type: '评测视频', color: 'bg-purple-500' },
            { date: '03/18', kol: 'Alex Travel', type: 'Vlog 植入', color: 'bg-cyan-500' },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-2 bg-zinc-800/30 rounded-lg px-3 py-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${s.color} shrink-0`} />
              <span className="text-[10px] text-zinc-500 w-10 shrink-0">{s.date}</span>
              <span className="text-[10px] text-zinc-300 flex-1">{s.kol}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400">{s.type}</span>
            </div>
          ))}
        </div>
      </div>

      {/* AI KOL Value Analysis */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Brain size={16} className="text-violet-400" />
          <h3 className="font-semibold">AI KOL 价值分析</h3>
          <span className="text-[10px] px-2 py-0.5 bg-violet-500/15 text-violet-400 rounded-full border border-violet-500/20 ml-auto flex items-center gap-1">
            <Sparkles size={10} /> AI 综合评估
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { name: 'Sarah Chen', handle: '@sarahchen', score: 95, tier: 'S', followers: '2.1M', engagement: '8.2%', roi: '+342%', risk: '低', color: 'emerald', insight: '内容创作力极强，粉丝粘性高，适合长期合作' },
            { name: 'Mike Wang', handle: '@mikewang', score: 88, tier: 'A', followers: '890K', engagement: '6.5%', roi: '+218%', risk: '低', color: 'blue', insight: '男性受众覆盖广，科技品类转化率高' },
            { name: 'Lisa Zhang', handle: '@lisaz', score: 82, tier: 'A', followers: '1.5M', engagement: '5.1%', roi: '+186%', risk: '中', color: 'amber', insight: '美妆赛道头部，但近期互动率下滑，建议观察' },
            { name: 'Tom Lee', handle: '@tomlee', score: 76, tier: 'B', followers: '450K', engagement: '9.1%', roi: '+156%', risk: '低', color: 'teal', insight: '小众但精准，互动率极高，性价比优秀' },
            { name: 'Amy Liu', handle: '@amyliu', score: 71, tier: 'B', followers: '680K', engagement: '4.3%', roi: '+98%', risk: '中', color: 'orange', insight: '生活方式博主，受众广但转化一般' },
            { name: 'Jack Wu', handle: '@jackwu', score: 63, tier: 'C', followers: '320K', engagement: '3.8%', roi: '+45%', risk: '高', color: 'red', insight: '近期负面舆情较多，建议暂停合作观察' },
          ].map((kol, i) => (
            <div key={i} className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3 hover:border-violet-500/30 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-medium text-sm">{kol.name}</div>
                  <div className="text-[10px] text-zinc-500">{kol.handle}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                    kol.tier === 'S' ? 'bg-emerald-500/20 text-emerald-400' :
                    kol.tier === 'A' ? 'bg-blue-500/20 text-blue-400' :
                    kol.tier === 'B' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>{kol.tier}</span>
                  <span className="text-lg font-bold text-violet-400">{kol.score}</span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1 text-[10px] mb-2">
                <div className="bg-zinc-900/60 rounded p-1 text-center">
                  <div className="text-zinc-500">粉丝</div>
                  <div className="font-medium">{kol.followers}</div>
                </div>
                <div className="bg-zinc-900/60 rounded p-1 text-center">
                  <div className="text-zinc-500">互动率</div>
                  <div className="font-medium">{kol.engagement}</div>
                </div>
                <div className="bg-zinc-900/60 rounded p-1 text-center">
                  <div className="text-zinc-500">ROI</div>
                  <div className="font-medium text-emerald-400">{kol.roi}</div>
                </div>
              </div>
              <div className="flex items-center gap-1 text-[10px] mb-1.5">
                <span className="text-zinc-500">风险:</span>
                <span className={`px-1 py-0.5 rounded ${
                  kol.risk === '低' ? 'bg-emerald-500/15 text-emerald-400' :
                  kol.risk === '中' ? 'bg-amber-500/15 text-amber-400' :
                  'bg-red-500/15 text-red-400'
                }`}>{kol.risk}</span>
              </div>
              <div className="text-[10px] text-zinc-400 leading-relaxed">
                <Sparkles size={10} className="inline text-violet-400 mr-1" />
                {kol.insight}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Refresh Result Toast */}
      {refreshResult && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="bg-zinc-800 border border-zinc-700 rounded-xl p-4 shadow-2xl">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-emerald-400" />
              <span className="text-sm text-zinc-200">{refreshResult}</span>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      {(showCreate || editingKol) && (
        <KolFormModal
          kol={editingKol}
          onClose={() => { setShowCreate(false); setEditingKol(null); }}
          onSave={(data) => editingKol ? updateKol(editingKol.id, data) : createKol(data)}
        />
      )}
    </div>
  );
}

function KolFormModal({
  kol, onClose, onSave,
}: {
  kol: Kol | null;
  onClose: () => void;
  onSave: (data: Partial<Kol>) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: kol?.name || '',
    platform: kol?.platform || 'youtube',
    handle: kol?.handle || '',
    followers: kol?.followers || 0,
    category: kol?.category || 'gaming',
    country: kol?.country || '',
    language: kol?.language || 'en',
    contact_email: kol?.contact_email || '',
    contact_phone: kol?.contact_phone || '',
    status: kol?.status || 'active',
    cooperation_status: kol?.cooperation_status || 'none',
    notes: kol?.notes || '',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg mx-4 p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">{kol ? t('kol.editKol') : t('kol.addKol')}</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.name')} *</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.platform')} *</label>
              <select
                value={form.platform}
                onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="youtube">YouTube</option>
                <option value="tiktok">TikTok</option>
                <option value="instagram">Instagram</option>
                <option value="twitter">Twitter/X</option>
                <option value="facebook">Facebook</option>
                <option value="twitch">Twitch</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.handle')}</label>
              <input
                value={form.handle}
                onChange={e => setForm(f => ({ ...f, handle: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
                placeholder="@username"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.followers')}</label>
              <input
                type="number"
                value={form.followers}
                onChange={e => setForm(f => ({ ...f, followers: parseInt(e.target.value) || 0 }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.category')}</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="gaming">{t('kol.cat.gaming')}</option>
                <option value="beauty">{t('kol.cat.beauty')}</option>
                <option value="tech">{t('kol.cat.tech')}</option>
                <option value="lifestyle">{t('kol.cat.lifestyle')}</option>
                <option value="food">{t('kol.cat.food')}</option>
                <option value="fashion">{t('kol.cat.fashion')}</option>
                <option value="fitness">{t('kol.cat.fitness')}</option>
                <option value="education">{t('kol.cat.education')}</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.country')}</label>
              <input
                value={form.country}
                onChange={e => setForm(f => ({ ...f, country: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
                placeholder="US, JP, KR..."
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.language')}</label>
              <select
                value={form.language}
                onChange={e => setForm(f => ({ ...f, language: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="en">English</option>
                <option value="zh">中文</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
                <option value="es">Español</option>
                <option value="pt">Português</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.email')}</label>
              <input
                value={form.contact_email}
                onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.coopStatus')}</label>
              <select
                value={form.cooperation_status}
                onChange={e => setForm(f => ({ ...f, cooperation_status: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                {Object.entries(COOP_KEYS).map(([k, ck]) => (
                  <option key={k} value={k}>{t(ck.key as any)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.notes')}</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500 resize-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition">{t('kol.form.cancel')}</button>
          <button
            onClick={() => form.name && onSave(form)}
            disabled={!form.name}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
          >
            {kol ? t('kol.form.save') : t('kol.form.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
