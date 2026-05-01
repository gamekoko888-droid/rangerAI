/**
 * ToolMemoryTab — Admin Dashboard tab for adaptive tool memory stats.
 * Extracted from AdminDashboard.tsx (R56 Task4 refactor).
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { AlertTriangle, Loader2, MemoryStick, RefreshCw } from 'lucide-react';
import { fetchAdmin } from './shared';

interface ToolMemoryData {
  total: number;
  categories: { category: string; count: number; totalHits: number; avgScore: number }[];
  toolStats: { key: string; subType: string; durationMs: number | null; success: boolean | null; hitCount: number; score: number; updatedAt: string; contentPreview: string }[];
  subTypeAgg: Record<string, { count: number; totalHits: number; successCount: number; failCount: number; totalDuration: number; durationCount: number }>;
  recentPatterns: { key: string; hitCount: number; score: number; updatedAt: string; contentPreview: string }[];
}

export default function ToolMemoryTab() {
  const { t } = useI18n();
  const [data, setData] = useState<ToolMemoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAdmin('/api/admin/adaptive-memory/stats');
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="animate-spin text-zinc-500" size={24} />
    </div>
  );

  if (error) return (
    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
      <AlertTriangle size={18} className="text-red-400 shrink-0" />
      <p className="text-sm text-red-300">{error}</p>
      <button onClick={fetchData} className="ml-auto text-xs text-blue-400 hover:text-blue-300">
        {t('admin.refresh')}
      </button>
    </div>
  );

  if (!data || data.total === 0) return (
    <div className="text-center py-20 text-zinc-500">
      <MemoryStick size={48} className="mx-auto mb-4 opacity-30" />
      <p>{t('admin.toolMemory.noData')}</p>
    </div>
  );

  const subTypes = Object.entries(data.subTypeAgg).sort((a, b) => b[1].totalHits - a[1].totalHits);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{t('admin.toolMemory.title')}</h2>
          <p className="text-sm text-zinc-500 mt-1">{t('admin.toolMemory.totalRecords')}: {data.total}</p>
        </div>
        <button onClick={fetchData} className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors">
          <RefreshCw size={14} />
          {t('admin.refresh')}
        </button>
      </div>

      {/* Category Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {data.categories.map(cat => (
          <div key={cat.category} className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
            <p className="text-xs text-zinc-500 mb-1">{cat.category}</p>
            <p className="text-2xl font-semibold text-zinc-100">{cat.count}</p>
            <p className="text-[11px] text-zinc-500 mt-1">{t('admin.toolMemory.hitCount')}: {cat.totalHits} · Score: {cat.avgScore.toFixed(2)}</p>
          </div>
        ))}
      </div>

      {/* SubType Stats Table */}
      {subTypes.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800/80">
            <h3 className="text-sm font-medium text-zinc-300">{t('admin.toolMemory.subTypeStats')}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500 border-b border-zinc-800/50">
                  <th className="text-left px-4 py-2 font-medium">SubType</th>
                  <th className="text-right px-4 py-2 font-medium">Count</th>
                  <th className="text-right px-4 py-2 font-medium">{t('admin.toolMemory.hitCount')}</th>
                  <th className="text-right px-4 py-2 font-medium">{t('admin.toolMemory.successRate')}</th>
                  <th className="text-right px-4 py-2 font-medium">{t('admin.toolMemory.avgDuration')}</th>
                </tr>
              </thead>
              <tbody>
                {subTypes.map(([name, agg]) => {
                  const total = agg.successCount + agg.failCount;
                  const rate = total > 0 ? ((agg.successCount / total) * 100).toFixed(0) : '—';
                  const avgMs = agg.durationCount > 0 ? Math.round(agg.totalDuration / agg.durationCount) : null;
                  return (
                    <tr key={name} className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 text-xs font-mono">{name}</span>
                      </td>
                      <td className="text-right px-4 py-2.5 text-zinc-300">{agg.count}</td>
                      <td className="text-right px-4 py-2.5 text-zinc-300">{agg.totalHits}</td>
                      <td className="text-right px-4 py-2.5">
                        {total > 0 ? (
                          <span className={parseInt(rate) >= 80 ? 'text-emerald-400' : parseInt(rate) >= 50 ? 'text-amber-400' : 'text-red-400'}>
                            {rate}%
                          </span>
                        ) : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="text-right px-4 py-2.5 text-zinc-400">{avgMs !== null ? `${avgMs}ms` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top Tools */}
      {data.toolStats.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800/80">
            <h3 className="text-sm font-medium text-zinc-300">{t('admin.toolMemory.topTools')}</h3>
          </div>
          <div className="divide-y divide-zinc-800/30">
            {data.toolStats.slice(0, 10).map((tool, i) => (
              <div key={i} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono text-blue-400">{tool.subType}</span>
                  <span className="text-xs text-zinc-500">{t('admin.toolMemory.hitCount')}: {tool.hitCount}</span>
                </div>
                <p className="text-xs text-zinc-400 line-clamp-2 font-mono">{tool.contentPreview}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Patterns */}
      {data.recentPatterns.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800/80">
            <h3 className="text-sm font-medium text-zinc-300">{t('admin.toolMemory.recentPatterns')}</h3>
          </div>
          <div className="divide-y divide-zinc-800/30">
            {data.recentPatterns.map((pattern, i) => (
              <div key={i} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono text-purple-400">{pattern.key}</span>
                  <span className="text-xs text-zinc-500">Score: {pattern.score.toFixed(2)} · Hits: {pattern.hitCount}</span>
                </div>
                <p className="text-xs text-zinc-400 line-clamp-2">{pattern.contentPreview}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
