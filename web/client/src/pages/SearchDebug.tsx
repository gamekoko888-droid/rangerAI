/**
 * SearchDebug — RAG Search Visualization & Debug Panel
 * Shows FTS/Vector/Hybrid search results with detailed scoring.
 * Admin-only tool for debugging knowledge base search quality.
 */
import { useState, useCallback } from 'react';
import { useI18n } from '../lib/i18n';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Search, Zap, Database, GitMerge, Clock,
  ChevronDown, ChevronRight, BarChart3, FileText, Tag,
} from 'lucide-react';

const API_BASE = '/api/knowledge';

interface FTSResult {
  id: string;
  title: string;
  snippet: string;
  relevance: number | null;
}

interface VectorResult {
  id: string;
  title: string;
  snippet: string;
  score: number | null;
  chunkIndex: number;
}

interface FusedResult {
  id: string;
  title: string;
  snippet: string;
  rrfScore: number;
  sources: string[];
  ftsRelevance: number;
  vectorScore: number;
}

interface Timing {
  fts_ms: number;
  vector_ms: number;
  hybrid_ms: number;
  total_ms: number;
}

interface SearchDebugResponse {
  query: string;
  category: string | null;
  ftsResults: FTSResult[];
  vectorResults: VectorResult[];
  fusedResults: FusedResult[];
  timing: Timing;
  counts: { fts: number; vector: number; fused: number };
}

function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('rangerai_token');
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function ScoreBar({ score, max, color }: { score: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((score / max) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-white/50 font-mono w-14 text-right">{score.toFixed(4)}</span>
    </div>
  );
}

export default function SearchDebug() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchDebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'fused' | 'fts' | 'vector'>('fused');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const handleSearch = useCallback(async () => {
    if (!query.trim() || query.trim().length < 2) {
      setError(t('sd.minChars'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_BASE}/search-debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), category: category || undefined, limit }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' }));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      const data: SearchDebugResponse = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [query, category, limit]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const maxFtsScore = result ? Math.max(...result.ftsResults.map(r => r.relevance || 0), 0.001) : 1;
  const maxVecScore = result ? Math.max(...result.vectorResults.map(r => r.score || 0), 0.001) : 1;
  const maxRrfScore = result ? Math.max(...result.fusedResults.map(r => r.rrfScore || 0), 0.001) : 1;

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0f] text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10">
        <div className="flex items-center gap-2 sm:gap-3">
          <button onClick={() => setLocation('/knowledge')} className="p-1.5 sm:p-2 hover:bg-white/10 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6 text-purple-400" />
          <h1 className="text-lg sm:text-xl font-semibold">{t('sd.title')}</h1>
          <span className="text-xs text-white/30 hidden sm:inline">RAG Search Debug Panel</span>
        </div>
      </div>

      {/* Search input */}
      <div className="px-4 sm:px-6 py-4 border-b border-white/10 bg-white/[0.01]">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
              <input
                type="text"
                placeholder={t('sd.searchPlaceholder')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={t('sd.categoryFilter')}
                value={category}
                onChange={e => setCategory(e.target.value)}
                className="w-28 sm:w-32 px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50"
              />
              <select
                value={limit}
                onChange={e => setLimit(Number(e.target.value))}
                className="w-20 px-2 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-purple-500/50"
              >
                <option value={3}>Top 3</option>
                <option value={5}>Top 5</option>
                <option value={10}>Top 10</option>
              </select>
              <button
                onClick={handleSearch}
                disabled={loading}
                className="px-4 py-2.5 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
                {t('sd.search')}
              </button>
            </div>
          </div>
          {error && (
            <p className="text-red-400 text-sm mt-2">{error}</p>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {result && (
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-6">
            {/* Timing summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-1.5 mb-1">
                  <Database className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[11px] text-white/40">FTS</span>
                </div>
                <p className="text-lg font-semibold text-blue-400">{result.timing.fts_ms}ms</p>
                <p className="text-[10px] text-white/30">{t('sd.nResults').replace('{n}', String(result.counts.fts))}</p>
              </div>
              <div className="p-3 rounded-lg border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-1.5 mb-1">
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-[11px] text-white/40">Vector</span>
                </div>
                <p className="text-lg font-semibold text-emerald-400">{result.timing.vector_ms}ms</p>
                <p className="text-[10px] text-white/30">{t('sd.nResults').replace('{n}', String(result.counts.vector))}</p>
              </div>
              <div className="p-3 rounded-lg border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-1.5 mb-1">
                  <GitMerge className="w-3.5 h-3.5 text-purple-400" />
                  <span className="text-[11px] text-white/40">Hybrid (RRF)</span>
                </div>
                <p className="text-lg font-semibold text-purple-400">{result.timing.hybrid_ms}ms</p>
                <p className="text-[10px] text-white/30">{t('sd.nFused').replace('{n}', String(result.counts.fused))}</p>
              </div>
              <div className="p-3 rounded-lg border border-white/10 bg-white/[0.02]">
                <div className="flex items-center gap-1.5 mb-1">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-[11px] text-white/40">{t('sd.totalTime')}</span>
                </div>
                <p className="text-lg font-semibold text-amber-400">{result.timing.total_ms}ms</p>
                <p className="text-[10px] text-white/30">{t('sd.queryLabel')}: "{result.query}"</p>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-white/10">
              {[
                { key: 'fused' as const, label: 'Hybrid (RRF)', icon: GitMerge, color: 'text-purple-400', count: result.counts.fused },
                { key: 'fts' as const, label: 'FTS', icon: Database, color: 'text-blue-400', count: result.counts.fts },
                { key: 'vector' as const, label: 'Vector', icon: Zap, color: 'text-emerald-400', count: result.counts.vector },
              ].map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-xs sm:text-sm transition-colors border-b-2 -mb-px ${
                    activeTab === tab.key
                      ? `${tab.color} border-current`
                      : 'text-white/40 border-transparent hover:text-white/60'
                  }`}
                >
                  <tab.icon className="w-3.5 h-3.5" />
                  {tab.label}
                  <span className="text-[10px] opacity-60">({tab.count})</span>
                </button>
              ))}
            </div>

            {/* Result list */}
            <div className="space-y-2">
              {activeTab === 'fused' && result.fusedResults.map((r, i) => (
                <div key={`fused-${r.id}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                  <div
                    className="flex items-start gap-3 p-3 cursor-pointer"
                    onClick={() => toggleExpand(`fused-${r.id}`)}
                  >
                    <span className="text-xs font-mono text-purple-400/60 mt-0.5 w-5">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white/90 truncate">{r.title}</span>
                        {r.sources.map(s => (
                          <span key={s} className={`text-[9px] px-1.5 py-0 rounded-full border ${
                            s === 'fts' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          }`}>
                            {s.toUpperCase()}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1.5 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-purple-400/70 w-10">RRF</span>
                          <ScoreBar score={r.rrfScore} max={maxRrfScore} color="bg-purple-500" />
                        </div>
                        {r.ftsRelevance > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-blue-400/70 w-10">FTS</span>
                            <ScoreBar score={r.ftsRelevance} max={maxFtsScore} color="bg-blue-500" />
                          </div>
                        )}
                        {r.vectorScore > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-emerald-400/70 w-10">Vec</span>
                            <ScoreBar score={r.vectorScore} max={maxVecScore} color="bg-emerald-500" />
                          </div>
                        )}
                      </div>
                    </div>
                    {expandedIds.has(`fused-${r.id}`) ? (
                      <ChevronDown className="w-4 h-4 text-white/20 mt-1 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-white/20 mt-1 shrink-0" />
                    )}
                  </div>
                  {expandedIds.has(`fused-${r.id}`) && (
                    <div className="px-3 pb-3 pt-0 ml-8">
                      <p className="text-xs text-white/50 leading-relaxed bg-white/5 rounded-lg p-2.5">{r.snippet}</p>
                    </div>
                  )}
                </div>
              ))}

              {activeTab === 'fts' && result.ftsResults.map((r, i) => (
                <div key={`fts-${r.id}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                  <div
                    className="flex items-start gap-3 p-3 cursor-pointer"
                    onClick={() => toggleExpand(`fts-${r.id}`)}
                  >
                    <span className="text-xs font-mono text-blue-400/60 mt-0.5 w-5">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-white/90">{r.title}</span>
                      <div className="mt-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-blue-400/70 w-16">Relevance</span>
                          <ScoreBar score={r.relevance || 0} max={maxFtsScore} color="bg-blue-500" />
                        </div>
                      </div>
                    </div>
                    {expandedIds.has(`fts-${r.id}`) ? (
                      <ChevronDown className="w-4 h-4 text-white/20 mt-1 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-white/20 mt-1 shrink-0" />
                    )}
                  </div>
                  {expandedIds.has(`fts-${r.id}`) && (
                    <div className="px-3 pb-3 pt-0 ml-8">
                      <p className="text-xs text-white/50 leading-relaxed bg-white/5 rounded-lg p-2.5">{r.snippet}</p>
                    </div>
                  )}
                </div>
              ))}

              {activeTab === 'vector' && result.vectorResults.map((r, i) => (
                <div key={`vec-${r.id}-${i}`} className="rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
                  <div
                    className="flex items-start gap-3 p-3 cursor-pointer"
                    onClick={() => toggleExpand(`vec-${r.id}`)}
                  >
                    <span className="text-xs font-mono text-emerald-400/60 mt-0.5 w-5">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white/90">{r.title}</span>
                        <span className="text-[9px] px-1.5 py-0 rounded-full bg-white/5 text-white/30 border border-white/10">
                          chunk #{r.chunkIndex}
                        </span>
                      </div>
                      <div className="mt-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-emerald-400/70 w-16">Cosine</span>
                          <ScoreBar score={r.score || 0} max={maxVecScore} color="bg-emerald-500" />
                        </div>
                      </div>
                    </div>
                    {expandedIds.has(`vec-${r.id}`) ? (
                      <ChevronDown className="w-4 h-4 text-white/20 mt-1 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-white/20 mt-1 shrink-0" />
                    )}
                  </div>
                  {expandedIds.has(`vec-${r.id}`) && (
                    <div className="px-3 pb-3 pt-0 ml-8">
                      <p className="text-xs text-white/50 leading-relaxed bg-white/5 rounded-lg p-2.5">{r.snippet}</p>
                    </div>
                  )}
                </div>
              ))}

              {/* Empty state */}
              {((activeTab === 'fused' && result.fusedResults.length === 0) ||
                (activeTab === 'fts' && result.ftsResults.length === 0) ||
                (activeTab === 'vector' && result.vectorResults.length === 0)) && (
                <div className="text-center py-12 text-white/30">
                  <Search className="w-8 h-8 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">{t('sd.noChannelResults')}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Initial state */}
        {!result && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-white/30">
            <BarChart3 className="w-12 h-12 mb-4 opacity-30" />
            <h3 className="text-lg font-medium text-white/50 mb-2">{t('sd.panelTitle')}</h3>
            <p className="text-sm max-w-md text-center px-4">
              {t('sd.panelDesc')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
