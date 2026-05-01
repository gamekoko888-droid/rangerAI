/**
 * TikTokDashboard - 自有TikTok账号数据看板
 *
 * 展示 library.db 中的账号数据、视频排行、增长快照
 * 数据来源：/api/tiktok/dashboard/*
 */

import { useState, useEffect, useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  Users, Video, TrendingUp, Globe, Gamepad2, RefreshCw,
  ChevronDown, ChevronUp, Eye, Heart, MessageCircle, Share2,
  BarChart3, Crown, Search, ArrowUpRight, Loader2
} from 'lucide-react';
import { toast } from 'sonner';
import { getAuthToken } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  const h: Record<string, string> = {};
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface TkAccount {
  id: number;
  username: string;
  region: string;
  game: string;
  note: string;
}

interface TkVideo {
  id: number;
  username: string;
  video_url: string;
  title: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  save_count: number;
  upload_date: string;
  duration_sec: number;
}

interface TkSnapshot {
  id: number;
  username: string;
  total_views: number;
  total_likes: number;
  total_videos: number;
  followers: number;
  pulled_at: string;
}

interface DashboardStats {
  accountCount: number;
  videoCount: number;
  snapshotCount: number;
  byRegion: Array<{ region: string; count: number }>;
  byGame: Array<{ game: string; count: number }>;
  topVideos: Array<{ username: string; title: string; view_count: number; like_count: number }>;
}

// ─── Helpers ─────────────────────────────────────────────────

function fmtNum(n: number | null | undefined): string {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function regionColor(region: string): string {
  const map: Record<string, string> = {
    '菲律宾': 'bg-blue-500/15 text-blue-300',
    '印尼': 'bg-green-500/15 text-green-300',
    '新加坡': 'bg-purple-500/15 text-purple-300',
    '美区': 'bg-orange-500/15 text-orange-300',
    '马来': 'bg-yellow-500/15 text-yellow-300',
  };
  return map[region] ?? 'bg-zinc-500/15 text-zinc-300';
}

// ─── API ─────────────────────────────────────────────────────

async function fetchStats(): Promise<DashboardStats> {
  const r = await fetch('/api/tiktok/dashboard/stats', { headers: authHeaders() });
  if (!r.ok) throw new Error('Failed to fetch stats');
  const j = await r.json();
  return j.data;
}

async function fetchAccounts(): Promise<TkAccount[]> {
  const r = await fetch('/api/tiktok/dashboard/accounts', { headers: authHeaders() });
  if (!r.ok) throw new Error('Failed to fetch accounts');
  const j = await r.json();
  return j.data;
}

async function fetchVideos(username?: string, limit = 100): Promise<TkVideo[]> {
  const q = username ? `?username=${encodeURIComponent(username)}&limit=${limit}` : `?limit=${limit}`;
  const r = await fetch(`/api/tiktok/dashboard/videos${q}`, { headers: authHeaders() });
  if (!r.ok) throw new Error('Failed to fetch videos');
  const j = await r.json();
  return j.data;
}

// ─── Sub-components ──────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex items-start gap-3">
      <div className={`p-2 rounded-lg ${color ?? 'bg-pink-500/15'}`}>
        <Icon size={18} className={color ? undefined : 'text-pink-400'} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-500 mb-1">{label}</p>
        <p className="text-xl font-bold text-white">{value}</p>
        {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function AccountRow({ acc, onClick, selected }: { acc: TkAccount; onClick: () => void; selected: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all flex items-center gap-3 ${
        selected ? 'bg-pink-500/20 border border-pink-500/30' : 'hover:bg-zinc-800/60 border border-transparent'
      }`}
    >
      <div className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400 shrink-0">
        {acc.username[0]?.toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-200 truncate">@{acc.username}</p>
        <p className="text-xs text-zinc-500 truncate">{acc.game}</p>
      </div>
      <span className={`text-xs px-1.5 py-0.5 rounded-md shrink-0 ${regionColor(acc.region)}`}>
        {acc.region}
      </span>
    </button>
  );
}

// ─── Main Component ──────────────────────────────────────────

export default function TikTokDashboard() {
  const { locale } = useI18n();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [accounts, setAccounts] = useState<TkAccount[]>([]);
  const [videos, setVideos] = useState<TkVideo[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'accounts' | 'videos'>('overview');
  const [loading, setLoading] = useState(true);
  const [videosLoading, setVideosLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'view_count' | 'like_count' | 'upload_date'>('view_count');
  const [sortDesc, setSortDesc] = useState(true);
  const [regionFilter, setRegionFilter] = useState<string>('');

  const loadData = async () => {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([fetchStats(), fetchAccounts()]);
      setStats(s);
      setAccounts(a);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadVideos = async (username?: string) => {
    setVideosLoading(true);
    try {
      const v = await fetchVideos(username, 200);
      setVideos(v);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setVideosLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (activeTab === 'videos') {
      loadVideos(selectedAccount ?? undefined);
    }
  }, [activeTab, selectedAccount]);

  const regions = useMemo(() => [...new Set(accounts.map(a => a.region))], [accounts]);

  const filteredAccounts = useMemo(() => accounts.filter(a => {
    const matchSearch = !search || a.username.toLowerCase().includes(search.toLowerCase()) || a.game.toLowerCase().includes(search.toLowerCase());
    const matchRegion = !regionFilter || a.region === regionFilter;
    return matchSearch && matchRegion;
  }), [accounts, search, regionFilter]);

  const sortedVideos = useMemo(() => {
    return [...videos].sort((a, b) => {
      const av = (a as any)[sortBy] ?? 0;
      const bv = (b as any)[sortBy] ?? 0;
      if (sortDesc) return bv > av ? 1 : -1;
      return av > bv ? 1 : -1;
    });
  }, [videos, sortBy, sortDesc]);

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDesc(!sortDesc);
    else { setSortBy(col); setSortDesc(true); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-zinc-800/60 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <BarChart3 size={20} className="text-pink-400" />
              {locale === 'en' ? 'TikTok Dashboard' : 'TikTok 账号看板'}
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              {locale === 'en' ? 'Own account monitoring & video analytics' : '自有账号监控 · 视频数据分析'}
            </p>
          </div>
          <button
            onClick={loadData}
            className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
            title={locale === 'en' ? 'Refresh' : '刷新'}
          >
            <RefreshCw size={15} className="text-zinc-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4">
          {(['overview', 'accounts', 'videos'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab
                  ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {tab === 'overview' ? (locale === 'en' ? 'Overview' : '总览') :
               tab === 'accounts' ? (locale === 'en' ? 'Accounts' : '账号') :
               (locale === 'en' ? 'Videos' : '视频')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-6 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && stats && (
          <div className="space-y-6">
            {/* Stat Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard icon={Users} label={locale === 'en' ? 'Accounts' : '账号数'} value={stats.accountCount} color="bg-pink-500/15 text-pink-400" />
              <StatCard icon={Video} label={locale === 'en' ? 'Videos' : '视频总数'} value={fmtNum(stats.videoCount)} color="bg-violet-500/15 text-violet-400" />
              <StatCard icon={TrendingUp} label={locale === 'en' ? 'Snapshots' : '快照记录'} value={stats.snapshotCount} color="bg-blue-500/15 text-blue-400" />
              <StatCard icon={Crown} label={locale === 'en' ? 'Top Views' : '最高播放'} value={fmtNum(stats.topVideos[0]?.view_count)} sub={stats.topVideos[0]?.username} color="bg-amber-500/15 text-amber-400" />
            </div>

            {/* By Region + By Game */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                  <Globe size={14} className="text-pink-400" />
                  {locale === 'en' ? 'By Region' : '按地区'}
                </h3>
                <div className="space-y-2">
                  {stats.byRegion.map(r => (
                    <div key={r.region} className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-md ${regionColor(r.region)}`}>{r.region}</span>
                      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-pink-500 rounded-full"
                          style={{ width: `${(r.count / stats.accountCount) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-zinc-400 w-6 text-right">{r.count}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                  <Gamepad2 size={14} className="text-violet-400" />
                  {locale === 'en' ? 'By Game' : '按游戏'}
                </h3>
                <div className="space-y-2">
                  {stats.byGame.map(g => (
                    <div key={g.game} className="flex items-center gap-2">
                      <span className="text-xs text-zinc-300 w-24 truncate">{g.game || '未分类'}</span>
                      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-violet-500 rounded-full"
                          style={{ width: `${(g.count / stats.accountCount) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-zinc-400 w-6 text-right">{g.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Top Videos */}
            <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
              <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
                <Crown size={14} className="text-amber-400" />
                {locale === 'en' ? 'Top 10 Videos' : 'Top 10 视频'}
              </h3>
              <div className="space-y-2">
                {stats.topVideos.map((v, i) => (
                  <div key={i} className="flex items-center gap-3 py-1.5 border-b border-zinc-800/40 last:border-0">
                    <span className="text-xs font-bold text-zinc-600 w-5">#{i + 1}</span>
                    <span className="text-xs text-pink-400 shrink-0">@{v.username}</span>
                    <span className="text-xs text-zinc-300 flex-1 truncate">{v.title || '(无标题)'}</span>
                    <span className="text-xs text-zinc-400 flex items-center gap-1 shrink-0">
                      <Eye size={10} />{fmtNum(v.view_count)}
                    </span>
                    <span className="text-xs text-zinc-500 flex items-center gap-1 shrink-0">
                      <Heart size={10} />{fmtNum(v.like_count)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ACCOUNTS TAB */}
        {activeTab === 'accounts' && (
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex gap-2 flex-wrap">
              <div className="flex-1 min-w-48 relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={locale === 'en' ? 'Search accounts...' : '搜索账号或游戏...'}
                  className="w-full pl-8 pr-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-pink-500/50"
                />
              </div>
              <select
                value={regionFilter}
                onChange={e => setRegionFilter(e.target.value)}
                className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300 focus:outline-none focus:border-pink-500/50"
              >
                <option value="">{locale === 'en' ? 'All Regions' : '全部地区'}</option>
                {regions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>

            {/* Account Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredAccounts.map(acc => (
                <div
                  key={acc.id}
                  onClick={() => {
                    setSelectedAccount(acc.username);
                    setActiveTab('videos');
                  }}
                  className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 cursor-pointer hover:border-pink-500/30 hover:bg-zinc-900 transition-all group"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-base font-bold text-zinc-300 group-hover:bg-pink-500/20 transition-colors">
                      {acc.username[0]?.toUpperCase()}
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-md ${regionColor(acc.region)}`}>{acc.region}</span>
                  </div>
                  <p className="text-sm font-semibold text-zinc-200">@{acc.username}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{acc.game || '未分类'}</p>
                  {acc.note && <p className="text-xs text-zinc-600 mt-1 truncate">{acc.note}</p>}
                  <div className="mt-3 flex items-center gap-1 text-xs text-pink-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span>查看视频</span><ArrowUpRight size={11} />
                  </div>
                </div>
              ))}
            </div>

            {filteredAccounts.length === 0 && (
              <div className="text-center py-12 text-zinc-600">
                <Users size={32} className="mx-auto mb-2 opacity-30" />
                <p>{locale === 'en' ? 'No accounts found' : '没有找到账号'}</p>
              </div>
            )}
          </div>
        )}

        {/* VIDEOS TAB */}
        {activeTab === 'videos' && (
          <div className="space-y-4">
            {/* Account selector + sort */}
            <div className="flex gap-2 flex-wrap items-center">
              <select
                value={selectedAccount ?? ''}
                onChange={e => setSelectedAccount(e.target.value || null)}
                className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-zinc-300 focus:outline-none focus:border-pink-500/50"
              >
                <option value="">{locale === 'en' ? 'All Accounts' : '全部账号'}</option>
                {accounts.map(a => <option key={a.username} value={a.username}>@{a.username}</option>)}
              </select>
              <div className="flex gap-1 ml-auto">
                {(['view_count', 'like_count', 'upload_date'] as const).map(col => (
                  <button
                    key={col}
                    onClick={() => toggleSort(col)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 transition-all ${
                      sortBy === col ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30' : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                    }`}
                  >
                    {col === 'view_count' ? <Eye size={11} /> : col === 'like_count' ? <Heart size={11} /> : <TrendingUp size={11} />}
                    {col === 'view_count' ? (locale === 'en' ? 'Views' : '播放') :
                     col === 'like_count' ? (locale === 'en' ? 'Likes' : '点赞') :
                     (locale === 'en' ? 'Date' : '日期')}
                    {sortBy === col && (sortDesc ? <ChevronDown size={10} /> : <ChevronUp size={10} />)}
                  </button>
                ))}
              </div>
            </div>

            {videosLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin text-zinc-500" />
              </div>
            ) : (
              <div className="space-y-2">
                {sortedVideos.map((v, i) => (
                  <div key={v.id ?? i} className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-4 py-3 flex items-center gap-4 hover:border-zinc-700 transition-colors">
                    <span className="text-xs text-zinc-600 w-7 shrink-0">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{v.title || '(无标题)'}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-pink-400">@{v.username}</span>
                        {v.upload_date && <span className="text-xs text-zinc-600">{v.upload_date?.slice(0, 10)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0 text-xs">
                      <span className="flex items-center gap-1 text-zinc-300"><Eye size={12} />{fmtNum(v.view_count)}</span>
                      <span className="flex items-center gap-1 text-zinc-400"><Heart size={12} />{fmtNum(v.like_count)}</span>
                      <span className="flex items-center gap-1 text-zinc-500 hidden sm:flex"><MessageCircle size={12} />{fmtNum(v.comment_count)}</span>
                      <span className="flex items-center gap-1 text-zinc-500 hidden md:flex"><Share2 size={12} />{fmtNum(v.share_count)}</span>
                    </div>
                    {v.video_url && (
                      <a
                        href={v.video_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-lg bg-zinc-800 hover:bg-pink-500/20 hover:text-pink-300 transition-colors text-zinc-500 shrink-0"
                        onClick={e => e.stopPropagation()}
                      >
                        <ArrowUpRight size={12} />
                      </a>
                    )}
                  </div>
                ))}

                {sortedVideos.length === 0 && (
                  <div className="text-center py-12 text-zinc-600">
                    <Video size={32} className="mx-auto mb-2 opacity-30" />
                    <p>{locale === 'en' ? 'No videos found' : '没有找到视频'}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
