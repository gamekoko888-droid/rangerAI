/**
 * StatsPage — System statistics dashboard for admin users.
 * Shows message trends, model usage, user activity, and routing stats.
 */
import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import { getStats, getRoutingStats } from '../lib/api';
import type { StatsResponse, RoutingStatsResponse } from '../lib/types';
import {
  ArrowLeft, RefreshCw, MessageSquare, Users, Database,
  BarChart3, Activity, Tag, Cpu, Loader2,
} from 'lucide-react';
import { PageLoadingSkeleton } from '../components/PageLoadingSkeleton';
import { logger } from "../lib/logger";

const COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#f97316', '#ec4899'];

/** Fix double-UTF8 encoded strings (Chinese filenames stored with wrong encoding) */
function fixDoubleUtf8(str: string): string {
  if (!str) return str;
  const hasGarbled = /[\xC0-\xFF][\x80-\xBF]/.test(str);
  if (!hasGarbled) return str;
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    const decoded = new TextDecoder('utf-8').decode(bytes);
    if (/[一-鿿]/.test(decoded)) return decoded;
    return str;
  } catch { return str; }
}

/** Strip Markdown syntax for clean text display */
function stripMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?(```|$)/g, '[code] ')  // code blocks (including unclosed)
    .replace(/`([^`]*)`/g, '$1')               // inline code
    .replace(/`/g, '')                          // stray backticks
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // bold
    .replace(/\*([^*]+)\*/g, '$1')              // italic
    .replace(/\*\*/g, '')                       // stray bold markers
    .replace(/\*/g, '')                         // stray italic markers
    .replace(/~~([^~]+)~~/g, '$1')              // strikethrough
    .replace(/^#{1,6}\s+/gm, '')                // headings
    .replace(/!?\[([^\]]*)]\([^)]*\)/g, '$1')   // links/images
    .replace(/^[\s]*[-*+]\s/gm, '')             // list markers
    .replace(/^>\s?/gm, '')                     // blockquotes
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '') // tool calls
    .replace(/<tool_response>[\s\S]*?(<\/tool_response>|$)/gi, '') // tool responses
    .replace(/<[^>]+>/g, '')                    // any remaining HTML/XML tags
    .replace(/\n{2,}/g, ' ')                    // multiple newlines
    .replace(/\n/g, ' ')                        // single newlines
    .replace(/\s{2,}/g, ' ')                    // multiple spaces
    .trim();
}


function TrendBars({ data, userKey, aiKey }: { data: Array<Record<string, number | string>>; userKey: string; aiKey: string }) {
  const max = Math.max(1, ...data.flatMap(d => [Number(d[userKey]) || 0, Number(d[aiKey]) || 0]));
  return (
    <div className="h-60 flex items-end gap-2 border-l border-b border-zinc-800 px-2 pt-4">
      {data.map((d, i) => (
        <div key={i} className="flex-1 min-w-0 flex flex-col items-center gap-2">
          <div className="w-full h-44 flex items-end justify-center gap-1">
            <div className="w-3 md:w-4 rounded-t bg-indigo-500" title={`${userKey}: ${d[userKey]}`} style={{ height: `${Math.max(4, (Number(d[userKey]) || 0) / max * 100)}%` }} />
            <div className="w-3 md:w-4 rounded-t bg-cyan-400" title={`${aiKey}: ${d[aiKey]}`} style={{ height: `${Math.max(4, (Number(d[aiKey]) || 0) / max * 100)}%` }} />
          </div>
          <span className="text-[10px] text-zinc-500 truncate max-w-full">{String(d.day)}</span>
        </div>
      ))}
    </div>
  );
}

function DonutList({ data }: { data: Array<{ name: string; value: number }> }) {
  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;
  let offset = 25;
  return (
    <div className="h-50 flex items-center justify-center gap-6">
      <svg width="120" height="120" viewBox="0 0 120 120" className="shrink-0 -rotate-90">
        <circle cx="60" cy="60" r="42" fill="none" stroke="#27272a" strokeWidth="18" />
        {data.map((d, i) => {
          const pct = d.value / total * 100;
          const dash = `${pct} ${100 - pct}`;
          const el = <circle key={d.name} cx="60" cy="60" r="42" fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="18" strokeDasharray={dash} strokeDashoffset={offset} pathLength="100" />;
          offset -= pct;
          return el;
        })}
      </svg>
      <div className="space-y-2 min-w-0">
        {data.slice(0, 6).map((d, i) => (
          <div key={d.name} className="flex items-center gap-2 text-xs text-zinc-300">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
            <span className="truncate max-w-32">{d.name}</span>
            <span className="text-zinc-500">{Math.round(d.value / total * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HorizontalBars({ data }: { data: Array<{ name: string; value: number }> }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <div className="space-y-3 py-2">
      {data.map(d => (
        <div key={d.name} className="grid grid-cols-[80px_1fr_48px] items-center gap-3 text-xs">
          <span className="text-zinc-400 truncate">{d.name}</span>
          <div className="h-5 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full rounded bg-amber-500" style={{ width: `${Math.max(3, d.value / max * 100)}%` }} />
          </div>
          <span className="text-zinc-500 text-right">{d.value}</span>
        </div>
      ))}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex items-start gap-3">
      <div className="p-2 rounded-lg bg-zinc-800">
        <Icon size={18} className="text-blue-400" />
      </div>
      <div>
        <p className="text-xs text-zinc-500 mb-0.5">{label}</p>
        <p className="text-xl font-semibold text-zinc-100">{value}</p>
        {sub && <p className="text-[11px] text-zinc-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function StatsPage() {
  const { t, locale } = useI18n();
  const [, navigate] = useLocation();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [routing, setRouting] = useState<RoutingStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [s, r] = await Promise.all([getStats(), getRoutingStats()]);
      setStats(s);
      setRouting(r);
    } catch (err) {
      logger.error('[Stats] Failed to fetch:', err);
      toast.error(t('stats.fetchError'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  // Prepare chart data
  const trendData = useMemo(() => {
    if (!stats?.messageTrend) return [];
    return stats.messageTrend.map(d => ({
      day: d.day.slice(5, 10), // MM-DD only, strip time portion
      [t('stats.userMessages')]: d.userMsgs,
      [t('stats.aiReplies')]: d.aiMsgs,
    }));
  }, [stats]);

  const roleData = useMemo(() => {
    if (!stats?.roleDistribution) return [];
    const labels: Record<string, string> = { user: t('stats.user'), assistant: 'AI', system: 'System' };
    return stats.roleDistribution.map(r => ({
      name: labels[r.role] || r.role,
      value: r.count,
    }));
  }, [stats]);

  const modelData = useMemo(() => {
    if (!routing?.modelCounts) return [];
    return Object.entries(routing.modelCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name: name.split('/').pop() || name, value }));
  }, [routing]);

  const levelData = useMemo(() => {
    if (!routing?.levelCounts) return [];
    return Object.entries(routing.levelCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({ name, value }));
  }, [routing]);

  const tagData = useMemo(() => {
    if (!stats?.tagStats) return [];
    return stats.tagStats
      .filter(t => t.tags)
      .flatMap(t => {
        try {
          const parsed = JSON.parse(t.tags);
          return Array.isArray(parsed) ? parsed.map((tag: string) => ({ tag, count: t.count })) : [];
        } catch { return []; }
      })
      .reduce((acc: Array<{ name: string; value: number }>, { tag, count }) => {
        const existing = acc.find(a => a.name === tag);
        if (existing) existing.value += count;
        else acc.push({ name: tag, value: count });
        return acc;
      }, [])
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [stats]);

  if (loading) {
    return (
      <div className="h-screen bg-zinc-950">
        <PageLoadingSkeleton variant="stats" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-zinc-950/80 backdrop-blur-sm border-b border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <BarChart3 size={20} className="text-blue-400" />
              {t('stats.title')}
            </h1>
          </div>
          <button
            onClick={() => fetchAll(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {t('stats.refresh')}
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={MessageSquare} label={t('stats.totalChats')} value={stats?.chats ?? 0} />
          <StatCard icon={Activity} label={t('stats.totalMessages')} value={stats?.messages ?? 0} />
          <StatCard icon={Users} label={t('stats.totalUsers')} value={stats?.users ?? 0} />
          <StatCard icon={Database} label={t('stats.database')} value={`${stats?.dbSizeMB ?? '0'} MB`} />
        </div>

        {/* Message Trend Chart */}
        {trendData.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
              <Activity size={16} className="text-blue-400" />
              {t('stats.messageTrend')}
            </h2>
            <TrendBars data={trendData} userKey={t('stats.userMessages')} aiKey={t('stats.aiReplies')} />
          </div>
        )}

        {/* Two-column: Role Distribution + Model Usage */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* Role Distribution */}
          {roleData.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
                <MessageSquare size={16} className="text-cyan-400" />
                {t('stats.roleDistribution')}
              </h2>
              <DonutList data={roleData} />
            </div>
          )}

          {/* Model Usage */}
          {modelData.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
              <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
                <Cpu size={16} className="text-purple-400" />
                {t('stats.modelUsage')}
              </h2>
              <DonutList data={modelData} />
            </div>
          )}
        </div>

        {/* Routing Level Distribution */}
        {levelData.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
              <BarChart3 size={16} className="text-amber-400" />
              {t('stats.routingComplexity')}
            </h2>
            <HorizontalBars data={levelData} />
          </div>
        )}

        {/* Tag Stats */}
        {tagData.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
              <Tag size={16} className="text-green-400" />
              {t('stats.hotTags')}
            </h2>
            <div className="flex flex-wrap gap-2">
              {tagData.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {t.name}
                  <span className="text-zinc-500">{t.value}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* User Activity Table */}
        {stats?.userActivity && stats.userActivity.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
              <Users size={16} className="text-indigo-400" />
              {t('stats.userActivity')}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 text-xs border-b border-zinc-800">
                    <th className="text-left py-2 px-3 font-medium">{t('stats.user')}</th>
                    <th className="text-left py-2 px-3 font-medium">{t('stats.role')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('stats.chatCount')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('stats.messageCount')}</th>
                    <th className="text-right py-2 px-3 font-medium">{t('stats.lastLogin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.userActivity.map((u, i) => (
                    <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="py-2.5 px-3 text-zinc-200">{u.username}</td>
                      <td className="py-2.5 px-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          u.role === 'admin' ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-700 text-zinc-400'
                        }`}>
                          {u.role === 'admin' ? 'Admin' : 'Member'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-zinc-300">{u.chatCount}</td>
                      <td className="py-2.5 px-3 text-right text-zinc-300">{u.messageCount}</td>
                      <td className="py-2.5 px-3 text-right text-zinc-500 text-xs">
                        {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString(locale === 'en' ? 'en-US' : locale === 'zh-TW' ? 'zh-TW' : 'zh-CN') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Recent Routing Entries */}
        {routing && routing.recentEntries.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
              <Cpu size={16} className="text-rose-400" />
              {t('stats.recentRouting')}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-zinc-500 text-xs border-b border-zinc-800">
                    <th className="text-left py-2 px-3 font-medium">Time</th>
                    <th className="text-left py-2 px-3 font-medium">Level</th>
                    <th className="text-left py-2 px-3 font-medium">Model</th>
                    <th className="text-left py-2 px-3 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {routing.recentEntries.slice().reverse().map((e, i) => (
                    <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="py-2 px-3 text-zinc-500 text-xs whitespace-nowrap">
                        {new Date(e.ts).toLocaleString(locale === 'en' ? 'en-US' : locale === 'zh-TW' ? 'zh-TW' : 'zh-CN')}
                      </td>
                      <td className="py-2 px-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          e.level === 'EXPERT' ? 'bg-red-500/10 text-red-400' :
                          e.level === 'COMPLEX' ? 'bg-amber-500/10 text-amber-400' :
                          e.level === 'MODERATE' ? 'bg-blue-500/10 text-blue-400' :
                          'bg-zinc-700 text-zinc-400'
                        }`}>
                          {e.level}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-zinc-300 text-xs">{(e.model || '').split('/').pop()}</td>
                      <td className="py-2 px-3 text-zinc-400 text-xs truncate max-w-[200px]">{fixDoubleUtf8(stripMarkdown(e.msg))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty state for routing */}
        {routing && routing.total === 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
            <Cpu size={32} className="text-zinc-600 mx-auto mb-3" />
            <p className="text-sm text-zinc-500">No routing data</p>
            <p className="text-xs text-zinc-600 mt-1">Routing stats will appear after sending messages</p>
          </div>
        )}
      </div>
    </div>
  );
}
