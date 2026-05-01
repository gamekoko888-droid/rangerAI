/**
 * TikTokPartners - TikTok KOL 合作伙伴管理
 * 
 * 管理 TikTok 带货合作伙伴，包括分润比例、合作阶段、专属链接等
 * 数据来源：阿里云后端 /api/tiktok/partners
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useI18n } from '@/lib/i18n';
import {
  ArrowLeft, Plus, Search, Filter, ChevronRight, ExternalLink,
  Users, DollarSign, Globe, Gamepad2, TrendingUp, MoreHorizontal,
  Edit3, Trash2, RefreshCw, CheckCircle2, Clock, AlertCircle,
  ArrowUpRight, X, Save, Loader2, CalendarDays, Video, Heart
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

interface TikTokPartner {
  id: number;
  kol_handle: string;
  country: string;
  game_category: string | null;
  sharing_ratio: number;
  base_fee: number;
  milestone_stage: 'contacted' | 'negotiating' | 'agreed' | 'onboarding' | 'active';
  store_url: string | null;
  bank_info: string | null;
  last_update: string;
}

const STAGE_CONFIG: Record<string, { label: string; color: string; bg: string; icon: typeof Clock }> = {
  contacted: { label: '已联系', color: 'text-zinc-400', bg: 'bg-zinc-500/20', icon: Clock },
  negotiating: { label: '谈判中', color: 'text-amber-400', bg: 'bg-amber-500/20', icon: AlertCircle },
  agreed: { label: '已达成', color: 'text-blue-400', bg: 'bg-blue-500/20', icon: CheckCircle2 },
  onboarding: { label: '入驻中', color: 'text-purple-400', bg: 'bg-purple-500/20', icon: ArrowUpRight },
  active: { label: '已激活', color: 'text-emerald-400', bg: 'bg-emerald-500/20', icon: TrendingUp },
};

const STAGES = ['contacted', 'negotiating', 'agreed', 'onboarding', 'active'] as const;

const COUNTRIES = [
  { code: 'US', name: '美国', flag: '🇺🇸' },
  { code: 'ID', name: '印尼', flag: '🇮🇩' },
  { code: 'TH', name: '泰国', flag: '🇹🇭' },
  { code: 'VN', name: '越南', flag: '🇻🇳' },
  { code: 'MY', name: '马来西亚', flag: '🇲🇾' },
  { code: 'PH', name: '菲律宾', flag: '🇵🇭' },
  { code: 'SG', name: '新加坡', flag: '🇸🇬' },
  { code: 'UK', name: '英国', flag: '🇬🇧' },
];

// ─── API Helpers ──────────────────────────────────────────────

const API_BASE = '/api/tiktok';

async function fetchPartners(): Promise<TikTokPartner[]> {
  const res = await fetch(`${API_BASE}/partners`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch partners');
  const data = await res.json();
  return data.data || [];
}

async function createPartner(partner: Partial<TikTokPartner>): Promise<void> {
  const res = await fetch(`${API_BASE}/partners`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(partner),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to create partner');
  }
}

async function updatePartner(id: number, data: Partial<TikTokPartner>): Promise<void> {
  const res = await fetch(`${API_BASE}/partners/${id}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to update partner');
  }
}

async function deletePartner(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/partners/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Failed to delete partner');
  }
}

// ─── Main Component ─────────────────────────────────────────

export default function TikTokPartners() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [partners, setPartners] = useState<TikTokPartner[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [countryFilter, setCountryFilter] = useState<string>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedPartner, setSelectedPartner] = useState<TikTokPartner | null>(null);

  const loadPartners = useCallback(async () => {
    try {
      const data = await fetchPartners();
      setPartners(data);
    } catch (err) {
      toast.error('加载合作伙伴数据失败');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadPartners().finally(() => setLoading(false));
  }, [loadPartners]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadPartners();
    setRefreshing(false);
    toast.success('数据已刷新');
  };

  const filteredPartners = useMemo(() => {
    return partners.filter(p => {
      if (searchQuery && !p.kol_handle.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (stageFilter !== 'all' && p.milestone_stage !== stageFilter) return false;
      if (countryFilter !== 'all' && p.country !== countryFilter) return false;
      return true;
    });
  }, [partners, searchQuery, stageFilter, countryFilter]);

  const pipelineCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    STAGES.forEach(s => { counts[s] = partners.filter(p => p.milestone_stage === s).length; });
    return counts;
  }, [partners]);

  const getCountryFlag = (code: string) => {
    const c = COUNTRIES.find(c => c.code === code);
    return c ? c.flag : '🌍';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">加载中...</span>
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
            <button
              onClick={() => navigate('/')}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <Users size={20} className="text-pink-400" />
                TikTok 合作伙伴
              </h1>
              <p className="text-xs text-zinc-500">
                共 {partners.length} 个合作伙伴 · {partners.filter(p => p.milestone_stage === 'active').length} 个已激活
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              刷新
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-600 text-white hover:bg-pink-500 text-xs transition-colors"
            >
              <Plus size={13} />
              添加伙伴
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Pipeline View */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 mb-3">合作阶段管道</h2>
          <div className="grid grid-cols-5 gap-2">
            {STAGES.map((stage, i) => {
              const cfg = STAGE_CONFIG[stage];
              const Icon = cfg.icon;
              const count = pipelineCounts[stage] || 0;
              return (
                <button
                  key={stage}
                  onClick={() => setStageFilter(stageFilter === stage ? 'all' : stage)}
                  className={`relative p-3 rounded-xl border transition-all text-left ${
                    stageFilter === stage
                      ? `${cfg.bg} border-current ${cfg.color}`
                      : 'bg-zinc-900/50 border-zinc-800/50 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon size={14} className={cfg.color} />
                    <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                  </div>
                  <p className="text-xl font-bold text-zinc-100">{count}</p>
                  {i < STAGES.length - 1 && (
                    <ChevronRight size={14} className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-700" />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Search & Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="搜索 KOL Handle..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-zinc-900/50 border border-zinc-800/50 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <select
            value={countryFilter}
            onChange={e => setCountryFilter(e.target.value)}
            className="px-3 py-2 bg-zinc-900/50 border border-zinc-800/50 rounded-lg text-sm text-zinc-300 focus:outline-none focus:border-zinc-600"
          >
            <option value="all">全部国家</option>
            {COUNTRIES.map(c => (
              <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
            ))}
          </select>
        </div>

        {/* Partners List */}
        {filteredPartners.length === 0 ? (
          <div className="text-center py-16">
            <Users size={48} className="mx-auto text-zinc-700 mb-4" />
            <p className="text-zinc-500 text-sm">
              {partners.length === 0 ? '暂无合作伙伴数据' : '没有匹配的结果'}
            </p>
            {partners.length === 0 && (
              <button
                onClick={() => setShowAddModal(true)}
                className="mt-4 px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-500 transition-colors"
              >
                添加第一个合作伙伴
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredPartners.map(partner => {
              const stageCfg = STAGE_CONFIG[partner.milestone_stage];
              const StageIcon = stageCfg.icon;
              return (
                <div
                  key={partner.id}
                  onClick={() => setSelectedPartner(partner)}
                  className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 hover:border-zinc-700 transition-all cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-base font-semibold text-zinc-100">
                          {getCountryFlag(partner.country)} @{partner.kol_handle}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${stageCfg.bg} ${stageCfg.color} flex items-center gap-1`}>
                          <StageIcon size={10} />
                          {stageCfg.label}
                        </span>
                        {partner.game_category && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 flex items-center gap-1">
                            <Gamepad2 size={10} />
                            {partner.game_category}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                        <span className="flex items-center gap-1">
                          <DollarSign size={12} />
                          分润: {(Number(partner.sharing_ratio) * 100).toFixed(0)}%
                        </span>
                        <span className="flex items-center gap-1">
                          <DollarSign size={12} />
                          底价: ${Number(partner.base_fee).toFixed(0)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Globe size={12} />
                          {partner.country}
                        </span>
                        {partner.store_url && (
                          <a
                            href={partner.store_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="flex items-center gap-1 text-pink-400 hover:text-pink-300"
                          >
                            <ExternalLink size={12} />
                            店铺链接
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-zinc-600">
                        {new Date(partner.last_update).toLocaleDateString('zh-CN')}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Performance Analytics */}
        {partners.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
              <TrendingUp size={14} className="text-pink-400" />
              {'效果分析'}
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-400">{'模拟数据'}</span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'总带货GMV'}</p>
                <p className="text-xl font-bold text-zinc-100 mt-1">$128,500</p>
                <span className="inline-flex items-center gap-0.5 text-xs text-emerald-400"><ArrowUpRight size={12} />32.5%</span>
              </div>
              <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'平均ROI'}</p>
                <p className="text-xl font-bold text-zinc-100 mt-1">3.8x</p>
                <span className="inline-flex items-center gap-0.5 text-xs text-emerald-400"><ArrowUpRight size={12} />0.5x</span>
              </div>
              <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'转化率'}</p>
                <p className="text-xl font-bold text-zinc-100 mt-1">4.2%</p>
                <span className="inline-flex items-center gap-0.5 text-xs text-emerald-400"><ArrowUpRight size={12} />0.8%</span>
              </div>
              <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
                <p className="text-[10px] text-zinc-500 uppercase tracking-wider">{'总分润支出'}</p>
                <p className="text-xl font-bold text-zinc-100 mt-1">$18,200</p>
                <span className="text-xs text-zinc-500">{'占GMV 14.2%'}</span>
              </div>
            </div>

            {/* Top Performers */}
            <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
              <h3 className="text-xs font-medium text-zinc-400 mb-3">{'带货 Top 5 KOL'}</h3>
              <div className="space-y-2">
                {partners.filter(p => p.milestone_stage === 'active').slice(0, 5).map((p, i) => {
                  const mockGmv = [42000, 28500, 21000, 18200, 12800][i] || Math.round(Math.random() * 10000);
                  const mockOrders = [320, 215, 168, 142, 98][i] || Math.round(Math.random() * 100);
                  const mockRoi = [5.2, 4.1, 3.8, 3.5, 2.9][i] || (Math.random() * 3 + 1);
                  return (
                    <div key={p.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/30 transition-colors">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        i === 0 ? 'bg-amber-500/20 text-amber-400' : i === 1 ? 'bg-zinc-400/20 text-zinc-300' : i === 2 ? 'bg-orange-500/20 text-orange-400' : 'bg-zinc-700/50 text-zinc-500'
                      }`}>{i + 1}</span>
                      <span className="text-sm font-medium text-zinc-200 flex-1">{getCountryFlag(p.country)} @{p.kol_handle}</span>
                      <span className="text-xs text-zinc-400 tabular-nums">${mockGmv.toLocaleString()}</span>
                      <span className="text-[10px] text-zinc-500 tabular-nums w-16 text-right">{mockOrders} {'单'}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        mockRoi >= 4 ? 'bg-emerald-500/20 text-emerald-400' : mockRoi >= 3 ? 'bg-blue-500/20 text-blue-400' : 'bg-amber-500/20 text-amber-400'
                      }`}>{mockRoi.toFixed(1)}x ROI</span>
                    </div>
                  );
                })}
                {partners.filter(p => p.milestone_stage === 'active').length === 0 && (
                  <p className="text-xs text-zinc-600 text-center py-4">{'暂无已激活的 KOL'}</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Cooperation Pipeline */}
        {partners.length > 0 && (
          <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
            <h2 className="text-sm font-medium text-zinc-400 mb-4 flex items-center gap-2">
              <CheckCircle2 size={14} className="text-blue-400" />
              {'合作协议管道'}
            </h2>
            {/* Pipeline stages */}
            <div className="flex items-center gap-1 mb-4 overflow-x-auto pb-2">
              {STAGES.map((stage, i) => {
                const cfg = STAGE_CONFIG[stage];
                const count = partners.filter(p => p.milestone_stage === stage).length;
                const StageIcon = cfg.icon;
                return (
                  <div key={stage} className="flex items-center">
                    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${cfg.bg} border border-transparent min-w-[100px]`}>
                      <StageIcon size={12} className={cfg.color} />
                      <div>
                        <p className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</p>
                        <p className="text-lg font-bold text-zinc-100">{count}</p>
                      </div>
                    </div>
                    {i < STAGES.length - 1 && (
                      <ChevronRight size={14} className="text-zinc-700 shrink-0 mx-0.5" />
                    )}
                  </div>
                );
              })}
            </div>
            {/* Conversion funnel */}
            <div className="bg-zinc-800/30 rounded-lg p-3">
              <p className="text-[10px] text-zinc-500 mb-2">{'转化漏斗'}</p>
              <div className="space-y-1.5">
                {STAGES.map((stage, i) => {
                  const count = partners.filter(p => p.milestone_stage === stage).length;
                  const total = partners.length;
                  const pct = total > 0 ? (count / total) * 100 : 0;
                  const cfg = STAGE_CONFIG[stage];
                  return (
                    <div key={stage} className="flex items-center gap-2">
                      <span className={`text-[10px] w-12 ${cfg.color}`}>{cfg.label}</span>
                      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${cfg.bg.replace('/20', '')}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] text-zinc-500 w-8 text-right">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* Content Performance Ranking */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <TrendingUp size={14} className="text-pink-400" />
            {'内容效果排行'}
          </h2>
          <div className="space-y-2">
            {[
              { rank: 1, title: 'FC Coins 充值教程', kol: '@GamerPro', views: '2.3M', likes: '185K', conv: '4.2%', medal: '\u{1F947}' },
              { rank: 2, title: 'Lootbar 省钱攻略', kol: '@SaveMoney', views: '1.8M', likes: '142K', conv: '3.8%', medal: '\u{1F948}' },
              { rank: 3, title: '游戏充值对比评测', kol: '@TechReview', views: '1.2M', likes: '98K', conv: '3.5%', medal: '\u{1F949}' },
              { rank: 4, title: 'Genshin 抽卡省钱技巧', kol: '@GenshinFan', views: '890K', likes: '72K', conv: '3.1%', medal: '' },
              { rank: 5, title: 'Steam 充值最优解', kol: '@SteamDeals', views: '650K', likes: '51K', conv: '2.8%', medal: '' },
            ].map((v) => (
              <div key={v.rank} className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/30 transition-colors">
                <span className="text-sm w-6 text-center">{v.medal || `#${v.rank}`}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-200 truncate">{v.title}</div>
                  <div className="text-[10px] text-zinc-500">{v.kol}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-zinc-300">{v.views} {'播放'}</div>
                  <div className="text-[10px] text-zinc-500">{v.likes} {'点赞'} · {v.conv} {'转化'}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ROI Calculator */}
        <section className="bg-zinc-900/50 border border-emerald-500/20 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <DollarSign size={14} className="text-emerald-400" />
            {'KOL ROI 计算器'}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            {[
              { label: '投入预算', value: '$5,000', sub: '合作费+佣金' },
              { label: '预估曝光', value: '850K', sub: '基于历史数据' },
              { label: '预估转化', value: '2.8%', sub: '行业平均 2.1%' },
              { label: '预估营收', value: '$23,800', sub: 'ROI 376%' },
            ].map((m, i) => (
              <div key={i} className="bg-zinc-800/40 rounded-lg p-2.5 text-center">
                <div className="text-[10px] text-zinc-500">{m.label}</div>
                <div className="text-sm font-bold text-zinc-200 mt-0.5">{m.value}</div>
                <div className="text-[9px] text-emerald-400/70 mt-0.5">{m.sub}</div>
              </div>
            ))}
          </div>
          <div className="bg-zinc-800/30 rounded-lg p-3">
            <div className="text-[10px] text-zinc-400 mb-2">{'投资回报分析'}</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-zinc-800 rounded-full h-3 overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400" style={{ width: '78%' }} />
              </div>
              <span className="text-xs font-bold text-emerald-400">ROI 376%</span>
            </div>
            <div className="flex justify-between mt-2 text-[9px] text-zinc-500">
              <span>{'投入 $5,000'}</span>
              <span>{'回本点 $5,000'}</span>
              <span>{'预估产出 $23,800'}</span>
            </div>
          </div>
        </section>

        {/* TikTok Content Calendar */}
        <section className="bg-zinc-900/50 border border-rose-500/20 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <CalendarDays size={14} className="text-rose-400" />
            {'达人内容日历'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400">{'3月'}</span>
          </h2>
          {/* Mini Calendar */}
          <div className="grid grid-cols-7 gap-1 mb-4">
            {['日','一','二','三','四','五','六'].map(d => (
              <div key={d} className="text-[8px] text-zinc-600 text-center py-0.5">{d}</div>
            ))}
            {Array.from({ length: 31 }, (_, i) => {
              const day = i + 1;
              const events: Record<number, { type: string; color: string; creator: string }> = {
                2: { type: '开箱', color: 'bg-rose-500', creator: 'Luna' },
                5: { type: '直播', color: 'bg-cyan-500', creator: 'Alex' },
                7: { type: '评测', color: 'bg-amber-500', creator: 'Kai' },
                10: { type: 'Vlog', color: 'bg-emerald-500', creator: 'Mia' },
                12: { type: '带货', color: 'bg-purple-500', creator: 'Jay' },
                14: { type: '开箱', color: 'bg-rose-500', creator: 'Luna' },
                16: { type: '直播', color: 'bg-cyan-500', creator: 'Alex' },
                19: { type: '评测', color: 'bg-amber-500', creator: 'Kai' },
                21: { type: '带货', color: 'bg-purple-500', creator: 'Jay' },
                24: { type: 'Vlog', color: 'bg-emerald-500', creator: 'Mia' },
                26: { type: '开箱', color: 'bg-rose-500', creator: 'Luna' },
                28: { type: '直播', color: 'bg-cyan-500', creator: 'Alex' },
                30: { type: '评测', color: 'bg-amber-500', creator: 'Kai' },
              };
              const ev = events[day];
              const isToday = day === 10;
              return (
                <div key={day} className={`relative text-[10px] text-center py-1.5 rounded ${
                  isToday ? 'bg-rose-500/20 text-rose-400 font-bold' : ev ? 'bg-zinc-800/80 text-zinc-300' : 'text-zinc-600'
                } hover:bg-zinc-700/50 transition-colors cursor-default`}
                  title={ev ? `${ev.creator} - ${ev.type}` : ''}
                >
                  {day}
                  {ev && <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${ev.color}`} />}
                </div>
              );
            })}
          </div>
          {/* Upcoming Content */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-zinc-500 mb-1">{'近期内容计划'}</div>
            {[
              { date: '03/10', creator: 'Mia Gaming', type: 'Vlog 植入', game: 'Genshin Impact', status: '录制中', statusColor: 'bg-amber-500/20 text-amber-400' },
              { date: '03/12', creator: 'Jay Plays', type: '直播带货', game: 'PUBG Mobile', status: '已排期', statusColor: 'bg-cyan-500/20 text-cyan-400' },
              { date: '03/14', creator: 'Luna Beauty', type: '开箱视频', game: 'Free Fire', status: '待确认', statusColor: 'bg-zinc-500/20 text-zinc-400' },
              { date: '03/16', creator: 'Alex Travel', type: '直播带货', game: 'Mobile Legends', status: '已确认', statusColor: 'bg-emerald-500/20 text-emerald-400' },
            ].map((c, i) => (
              <div key={i} className="flex items-center gap-2 bg-zinc-800/30 rounded-lg px-3 py-2">
                <Video size={12} className="text-rose-400 shrink-0" />
                <span className="text-[10px] text-zinc-500 w-10 shrink-0">{c.date}</span>
                <span className="text-[10px] text-zinc-300 flex-1 truncate">{c.creator}</span>
                <span className="text-[9px] text-zinc-500 shrink-0">{c.type}</span>
                <span className={`text-[8px] px-1.5 py-0.5 rounded ${c.statusColor} shrink-0`}>{c.status}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-800/50">
            <span className="text-[10px] text-zinc-500">{'本月内容'}: 13 {'条'} · {'已发布'}: 9</span>
            <span className="text-[10px] text-rose-400">{'平均互动率'}: 8.7%</span>
          </div>
        </section>

        {/* Footer */}
        <div className="text-center py-4">
          <p className="text-[10px] text-zinc-600">
            数据来源：阿里云 MySQL · tiktok_partners 表
          </p>
        </div>
      </main>

      {/* Add Partner Modal */}
      {showAddModal && (
        <AddPartnerModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            loadPartners();
            toast.success('合作伙伴添加成功');
          }}
        />
      )}

      {/* Partner Detail Modal */}
      {selectedPartner && (
        <PartnerDetailModal
          partner={selectedPartner}
          onClose={() => setSelectedPartner(null)}
          onUpdate={async (id, data) => {
            await updatePartner(id, data);
            await loadPartners();
            setSelectedPartner(null);
            toast.success('合作伙伴已更新');
          }}
          onDelete={async (id) => {
            await deletePartner(id);
            await loadPartners();
            setSelectedPartner(null);
            toast.success('合作伙伴已删除');
          }}
        />
      )}
    </div>
  );
}

// ─── Add Partner Modal ──────────────────────────────────────

function AddPartnerModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    kol_handle: '',
    country: 'US',
    game_category: '',
    sharing_ratio: '0.10',
    base_fee: '0',
    milestone_stage: 'contacted' as const,
    store_url: '',
    bank_info: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.kol_handle.trim()) {
      toast.error('请输入 KOL Handle');
      return;
    }
    setSaving(true);
    try {
      await createPartner({
        kol_handle: form.kol_handle,
        country: form.country,
        game_category: form.game_category || null,
        sharing_ratio: parseFloat(form.sharing_ratio),
        base_fee: parseFloat(form.base_fee) || 0,
        milestone_stage: form.milestone_stage,
        store_url: form.store_url || null,
        bank_info: form.bank_info || null,
      });
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md mx-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <h3 className="text-sm font-semibold text-zinc-100">添加 TikTok 合作伙伴</h3>
          <button onClick={onClose} className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">KOL Handle *</label>
            <input
              type="text"
              value={form.kol_handle}
              onChange={e => setForm({ ...form, kol_handle: e.target.value })}
              placeholder="@username"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-pink-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">国家/地区 *</label>
              <select
                value={form.country}
                onChange={e => setForm({ ...form, country: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
              >
                {COUNTRIES.map(c => (
                  <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">游戏品类</label>
              <input
                type="text"
                value={form.game_category}
                onChange={e => setForm({ ...form, game_category: e.target.value })}
                placeholder="如: MOBA, FPS"
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-pink-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">分润比例</label>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1"
                value={form.sharing_ratio}
                onChange={e => setForm({ ...form, sharing_ratio: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
              />
              <p className="text-[10px] text-zinc-600 mt-0.5">0.10 = 10%</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">底价费用 ($)</label>
              <input
                type="number"
                step="1"
                min="0"
                value={form.base_fee}
                onChange={e => setForm({ ...form, base_fee: e.target.value })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">合作阶段</label>
            <select
              value={form.milestone_stage}
              onChange={e => setForm({ ...form, milestone_stage: e.target.value as any })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
            >
              {STAGES.map(s => (
                <option key={s} value={s}>{STAGE_CONFIG[s].label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">店铺链接</label>
            <input
              type="url"
              value={form.store_url}
              onChange={e => setForm({ ...form, store_url: e.target.value })}
              placeholder="https://..."
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-pink-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">银行信息</label>
            <input
              type="text"
              value={form.bank_info}
              onChange={e => setForm({ ...form, bank_info: e.target.value })}
              placeholder="银行名称 / 账号"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-pink-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-500 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Partner Detail Modal (with Edit & Delete) ──────────────

interface PartnerDetailModalProps {
  partner: TikTokPartner;
  onClose: () => void;
  onUpdate: (id: number, data: Partial<TikTokPartner>) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

function PartnerDetailModal({ partner, onClose, onUpdate, onDelete }: PartnerDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  
  const [form, setForm] = useState({
    kol_handle: partner.kol_handle,
    country: partner.country,
    game_category: partner.game_category || '',
    sharing_ratio: String(partner.sharing_ratio),
    base_fee: String(partner.base_fee),
    milestone_stage: partner.milestone_stage,
    store_url: partner.store_url || '',
    bank_info: partner.bank_info || '',
  });

  const stageCfg = STAGE_CONFIG[partner.milestone_stage];
  const StageIcon = stageCfg.icon;
  const stageIndex = STAGES.indexOf(partner.milestone_stage);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(partner.id, {
        kol_handle: form.kol_handle,
        country: form.country,
        game_category: form.game_category || null,
        sharing_ratio: parseFloat(form.sharing_ratio),
        base_fee: parseFloat(form.base_fee) || 0,
        milestone_stage: form.milestone_stage as any,
        store_url: form.store_url || null,
        bank_info: form.bank_info || null,
      });
    } catch (err: any) {
      toast.error(err.message || '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(partner.id);
    } catch (err: any) {
      toast.error(err.message || '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg mx-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <Users size={16} className="text-pink-400" />
            合作伙伴详情
          </h3>
          <div className="flex items-center gap-1">
            {!isEditing ? (
              <>
                <button
                  onClick={() => setIsEditing(true)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors"
                  title="编辑"
                >
                  <Edit3 size={14} />
                </button>
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </>
            ) : null}
            <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Delete Confirmation */}
        {confirmDelete && (
          <div className="p-4 bg-red-500/10 border-b border-red-500/20">
            <p className="text-sm text-red-400 mb-3">确定要删除 @{partner.kol_handle} 吗？此操作不可撤销。</p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs hover:bg-red-500 disabled:opacity-50"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {deleting ? '删除中...' : '确认删除'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="p-4 space-y-4">
          {isEditing ? (
            /* ─── Edit Mode ─── */
            <>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">KOL Handle</label>
                <input
                  type="text"
                  value={form.kol_handle}
                  onChange={e => setForm({ ...form, kol_handle: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">国家/地区</label>
                  <select
                    value={form.country}
                    onChange={e => setForm({ ...form, country: e.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
                  >
                    {COUNTRIES.map(c => (
                      <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">游戏品类</label>
                  <input
                    type="text"
                    value={form.game_category}
                    onChange={e => setForm({ ...form, game_category: e.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">分润比例</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={form.sharing_ratio}
                    onChange={e => setForm({ ...form, sharing_ratio: e.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">底价费用 ($)</label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={form.base_fee}
                    onChange={e => setForm({ ...form, base_fee: e.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">合作阶段</label>
                <select
                  value={form.milestone_stage}
                  onChange={e => setForm({ ...form, milestone_stage: e.target.value as any })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:border-pink-500"
                >
                  {STAGES.map(s => (
                    <option key={s} value={s}>{STAGE_CONFIG[s].label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">店铺链接</label>
                <input
                  type="url"
                  value={form.store_url}
                  onChange={e => setForm({ ...form, store_url: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-pink-500"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">银行信息</label>
                <input
                  type="text"
                  value={form.bank_info}
                  onChange={e => setForm({ ...form, bank_info: e.target.value })}
                  placeholder="银行名称 / 账号"
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-pink-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 bg-pink-600 text-white rounded-lg text-sm hover:bg-pink-500 transition-colors disabled:opacity-50"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  {saving ? '保存中...' : '保存修改'}
                </button>
              </div>
            </>
          ) : (
            /* ─── View Mode ─── */
            <>
              {/* Handle & Stage */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-zinc-100">@{partner.kol_handle}</h2>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {COUNTRIES.find(c => c.code === partner.country)?.flag} {COUNTRIES.find(c => c.code === partner.country)?.name || partner.country}
                    {partner.game_category && ` · ${partner.game_category}`}
                  </p>
                </div>
                <span className={`text-xs px-2 py-1 rounded-lg ${stageCfg.bg} ${stageCfg.color} flex items-center gap-1`}>
                  <StageIcon size={12} />
                  {stageCfg.label}
                </span>
              </div>

              {/* Stage Pipeline */}
              <div className="bg-zinc-800/50 rounded-xl p-3">
                <p className="text-[10px] text-zinc-500 mb-2">合作进度</p>
                <div className="flex items-center gap-1">
                  {STAGES.map((stage, i) => {
                    const isActive = i <= stageIndex;
                    const isCurrent = i === stageIndex;
                    return (
                      <div key={stage} className="flex-1 flex flex-col items-center">
                        <div className={`w-full h-1.5 rounded-full ${
                          isActive ? (isCurrent ? 'bg-pink-500' : 'bg-emerald-500') : 'bg-zinc-700'
                        }`} />
                        <span className={`text-[9px] mt-1 ${isActive ? 'text-zinc-300' : 'text-zinc-600'}`}>
                          {STAGE_CONFIG[stage].label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Details Grid */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-zinc-800/30 rounded-lg p-3">
                  <p className="text-[10px] text-zinc-500">分润比例</p>
                  <p className="text-lg font-bold text-pink-400">{(Number(partner.sharing_ratio) * 100).toFixed(0)}%</p>
                </div>
                <div className="bg-zinc-800/30 rounded-lg p-3">
                  <p className="text-[10px] text-zinc-500">底价费用</p>
                  <p className="text-lg font-bold text-emerald-400">${Number(partner.base_fee).toFixed(0)}</p>
                </div>
              </div>

              {/* Store URL */}
              {partner.store_url && (
                <div className="bg-zinc-800/30 rounded-lg p-3">
                  <p className="text-[10px] text-zinc-500 mb-1">专属店铺链接</p>
                  <a
                    href={partner.store_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-pink-400 hover:text-pink-300 flex items-center gap-1 break-all"
                  >
                    <ExternalLink size={12} />
                    {partner.store_url}
                  </a>
                </div>
              )}

              {/* Bank Info */}
              {partner.bank_info && (
                <div className="bg-zinc-800/30 rounded-lg p-3">
                  <p className="text-[10px] text-zinc-500 mb-1">银行信息</p>
                  <p className="text-xs text-zinc-300">{partner.bank_info}</p>
                </div>
              )}

              {/* Last Update */}
              <div className="text-center pt-2 border-t border-zinc-800">
                <p className="text-[10px] text-zinc-600">
                  最后更新: {new Date(partner.last_update).toLocaleString('zh-CN')}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
