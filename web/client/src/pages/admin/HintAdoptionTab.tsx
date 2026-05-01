import React, { useState, useEffect } from 'react';
import { TrendingUp, BarChart3, CheckCircle2, XCircle, RefreshCw, Zap, Target, Hash } from 'lucide-react';
import { fetchAdmin } from './shared';

interface HintAdoption {
  id: number;
  task_id: string;
  session_key: string;
  task_type: string;
  hint_text: string;
  suggested_tools: string;
  actual_tools: string;
  adopted: number;
  created_at: string;
}

interface AdoptionStats {
  total: number;
  adopted: number;
  adoptionRate: number;
  realTotal: number;
  realAdopted: number;
  realAdoptionRate: number;
  seedTotal: number;
  seedAdopted: number;
  seedAdoptionRate: number;
  byType: Record<string, { total: number; adopted: number; rate: number }>;
}

export default function HintAdoptionTab() {
  const [stats, setStats] = useState<AdoptionStats | null>(null);
  const [records, setRecords] = useState<HintAdoption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin("/api/admin/hint-adoption-stats");
      if (data.ok) {
        const raw = data.data;
        const byTypeMap: Record<string, any> = {};
        if (Array.isArray(raw.byType)) {
          raw.byType.forEach((r: any) => {
            byTypeMap[r.task_type] = { total: r.total, adopted: r.adopted_count, rate: r.total > 0 ? (r.adopted_count / r.total * 100) : 0 };
          });
        }
        setStats({ ...raw, byType: byTypeMap });
        setRecords(data.data.recent || []);
      } else {
        setError(data.error || 'Failed to load');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = typeFilter === 'all' ? records : records.filter(r => r.task_type === typeFilter);
  const taskTypes = [...new Set(records.map(r => r.task_type))];

  if (loading) return <div className="flex items-center justify-center py-20 text-zinc-400"><RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading hint adoption data...</div>;
  if (error) return <div className="text-red-400 text-center py-12">{error}</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" /> Hint Adoption Analytics
          </h2>
          <p className="text-xs text-zinc-500 mt-1">Tracks how often planner hints are adopted by the execution engine</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><Hash className="w-4 h-4" /> Total Hints</div>
            <div className="text-2xl font-bold text-zinc-100">{stats.total}</div>
          </div>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><CheckCircle2 className="w-4 h-4" /> Adopted</div>
            <div className="text-2xl font-bold text-emerald-400">{stats.adopted}</div>
          </div>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><TrendingUp className="w-4 h-4" /> Adoption Rate</div>
            <div className={`text-2xl font-bold ${stats.adoptionRate >= 12 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {stats.adoptionRate.toFixed(1)}%
            </div>
            <div className="text-xs text-zinc-500 mt-1">Target: ≥12%</div>
          </div>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><XCircle className="w-4 h-4" /> Rejected</div>
            <div className="text-2xl font-bold text-red-400">{stats.total - stats.adopted}</div>
          </div>
        </div>
      )}

      {/* Real vs Seed Split */}
      {stats && (stats.realTotal > 0 || stats.seedTotal > 0) && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
            <div className="flex items-center gap-2 text-emerald-400 text-xs mb-2 font-semibold">
              <Target className="w-4 h-4" /> Real Tasks
            </div>
            <div className="flex items-baseline gap-2">
              <span className={`text-xl font-bold ${(stats.realAdoptionRate || 0) >= 12 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {(stats.realAdoptionRate || 0).toFixed(1)}%
              </span>
              <span className="text-xs text-zinc-500">{stats.realAdopted || 0}/{stats.realTotal || 0}</span>
            </div>
          </div>
          <div className="bg-zinc-500/5 border border-zinc-600/30 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2 font-semibold">
              <Hash className="w-4 h-4" /> Seed Data
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-zinc-400">
                {(stats.seedAdoptionRate || 0).toFixed(1)}%
              </span>
              <span className="text-xs text-zinc-500">{stats.seedAdopted || 0}/{stats.seedTotal || 0}</span>
            </div>
          </div>
        </div>
      )}
      {/* By Type Breakdown */}
      {stats?.byType && Object.keys(stats.byType).length > 0 && (
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-3 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-400" /> Adoption by Task Type
          </h3>
          <div className="space-y-3">
            {Object.entries(stats.byType).map(([type, data]) => (
              <div key={type} className="flex items-center gap-3">
                <span className="text-xs text-zinc-400 w-24 truncate">{type}</span>
                <div className="flex-1 bg-zinc-900 rounded-full h-5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${data.rate >= 12 ? 'bg-emerald-500/60' : 'bg-amber-500/60'}`}
                    style={{ width: `${Math.max(data.rate, 2)}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-zinc-300 w-16 text-right">{data.rate.toFixed(1)}%</span>
                <span className="text-xs text-zinc-500 w-12 text-right">{data.adopted}/{data.total}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">Filter:</span>
        <button onClick={() => setTypeFilter('all')} className={`px-2 py-1 rounded text-xs ${typeFilter === 'all' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>All</button>
        {taskTypes.map(t => (
          <button key={t} onClick={() => setTypeFilter(typeFilter === t ? 'all' : t)} className={`px-2 py-1 rounded text-xs ${typeFilter === t ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>{t}</button>
        ))}
      </div>

      {/* Records Table */}
      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-700/50">
              <th className="text-left p-3 text-zinc-400 font-medium">Task Type</th>
              <th className="text-left p-3 text-zinc-400 font-medium">Suggested Tools</th>
              <th className="text-left p-3 text-zinc-400 font-medium">Actual Tools</th>
              <th className="text-center p-3 text-zinc-400 font-medium">Adopted</th>
              <th className="text-left p-3 text-zinc-400 font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                <td className="p-3"><span className="px-2 py-0.5 bg-zinc-700/50 rounded text-zinc-300">{r.task_type}</span></td>
                <td className="p-3 text-zinc-400 font-mono">{r.suggested_tools}</td>
                <td className="p-3 text-zinc-400 font-mono">{r.actual_tools || '—'}</td>
                <td className="p-3 text-center">
                  {r.adopted ? <CheckCircle2 className="w-4 h-4 text-emerald-400 mx-auto" /> : <XCircle className="w-4 h-4 text-red-400 mx-auto" />}
                </td>
                <td className="p-3 text-zinc-500">{r.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
