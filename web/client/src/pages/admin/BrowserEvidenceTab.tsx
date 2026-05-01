/**
 * BrowserEvidenceTab — R18-T2: Browser evidence management panel.
 * Shows browser evidence (screenshots, extracted text) with inline preview.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchAdmin } from './shared';
import {
  Loader2, RefreshCw, Image, FileText, Eye, X,
  AlertTriangle, Monitor, Clock, ChevronDown, ChevronUp,
} from 'lucide-react';
import { logger } from '../../lib/logger';
import { getAuthToken } from '../../lib/api';

// ─── Types ──────────────────────────────────────────────────
interface BrowserEvidence {
  id: number;
  task_id: string;
  step_id: number | null;
  evidence_type: string; // 'screenshot' | 'extracted_text'
  file_path: string | null;
  text_content: string | null;
  url: string | null;
  metadata: string | null;
  created_at: string;
}

// ─── Component ──────────────────────────────────────────────
export default function BrowserEvidenceTab() {
  const [evidence, setEvidence] = useState<BrowserEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'screenshot' | 'extracted_text'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin('/api/admin/browser-evidence');
      setEvidence((Array.isArray(data) ? data : data?.evidence || []).map((e: any) => ({ ...e, evidence_type: e.evidence_type || e.type })));
    } catch (e: any) {
      logger.error('BrowserEvidenceTab load error:', e);
      setError(e.message || 'Failed to load evidence');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = filterType === 'all' ? evidence : evidence.filter(e => filterType === 'extracted_text' ? (e.evidence_type === 'extracted_text' || e.evidence_type === 'text_snapshot') : e.evidence_type === filterType);

  const openScreenshot = (evidenceId: number) => {
    const token = getAuthToken();
    const url = `/api/admin/browser-screenshot/${evidenceId}${token ? `?token=${token}` : ''}`;
    setPreviewUrl(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
        <span className="ml-2 text-zinc-400">Loading browser evidence...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400">
        <AlertTriangle className="w-5 h-5 inline mr-2" />
        {error}
        <button onClick={load} className="ml-4 text-blue-400 hover:text-blue-300 text-sm">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Browser Evidence</h2>
          <p className="text-sm text-zinc-500 mt-1">R18-T2: 浏览器证据管理 — 截图与文本提取记录</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Filter */}
          <div className="flex items-center gap-1 bg-zinc-800 rounded-lg p-0.5">
            {(['all', 'screenshot', 'extracted_text'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilterType(f)}
                className={`px-3 py-1 rounded-md text-xs transition-colors ${
                  filterType === f ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {f === 'all' ? 'All' : f === 'screenshot' ? '📸 Screenshots' : '📝 Text'}
              </button>
            ))}
          </div>
          <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <Monitor className="w-4 h-4" /> Total Evidence
          </div>
          <div className="text-xl font-bold text-zinc-100">{evidence.length}</div>
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <Image className="w-4 h-4" /> Screenshots
          </div>
          <div className="text-xl font-bold text-blue-400">{evidence.filter(e => e.evidence_type === 'screenshot').length}</div>
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1">
            <FileText className="w-4 h-4" /> Text Extracts
          </div>
          <div className="text-xl font-bold text-emerald-400">{evidence.filter(e => e.evidence_type === 'extracted_text' || e.evidence_type === 'text_snapshot').length}</div>
        </div>
      </div>

      {/* Evidence List */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <Monitor className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No browser evidence found</p>
          <p className="text-xs mt-1">Evidence is collected during browser-based task execution</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((ev) => {
            const isExpanded = expandedId === ev.id;
            return (
              <div key={ev.id} className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl overflow-hidden">
                {/* Row header */}
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer hover:bg-zinc-700/20 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : ev.id)}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    ev.evidence_type === 'screenshot' ? 'bg-blue-500/20 text-blue-400' : ev.evidence_type === 'text_snapshot' ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'
                  }`}>
                    {ev.evidence_type === 'screenshot' ? <Image className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">
                        {ev.evidence_type === 'screenshot' ? 'Screenshot' : ev.evidence_type === 'text_snapshot' ? 'Text Snapshot' : 'Extracted Text'}
                      </span>
                      <span className="text-xs text-zinc-500 font-mono">#{ev.id}</span>
                      {ev.step_id && (
                        <span className="text-xs bg-zinc-700/50 text-zinc-400 px-1.5 py-0.5 rounded">Step {ev.step_id}</span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 truncate">
                      {ev.url || ev.task_id || 'No URL'}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {ev.created_at}
                    </span>
                    {ev.evidence_type === 'screenshot' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openScreenshot(ev.id); }}
                        className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
                        title="View screenshot"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    )}
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="border-t border-zinc-700/50 p-4 bg-zinc-900/30">
                    <div className="grid grid-cols-2 gap-4 text-xs mb-3">
                      <div><span className="text-zinc-500">Task ID:</span> <span className="text-zinc-300 font-mono">{ev.task_id}</span></div>
                      <div><span className="text-zinc-500">Step ID:</span> <span className="text-zinc-300">{ev.step_id ?? '—'}</span></div>
                      <div><span className="text-zinc-500">URL:</span> <span className="text-zinc-300 break-all">{ev.url || '—'}</span></div>
                      <div><span className="text-zinc-500">File:</span> <span className="text-zinc-300 font-mono break-all">{ev.file_path || '—'}</span></div>
                    </div>
                    {ev.text_content && (
                      <div className="mt-3">
                        <div className="text-xs text-zinc-500 mb-1">Extracted Text:</div>
                        <pre className="bg-zinc-950 rounded-lg p-3 text-xs text-zinc-300 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
                          {ev.text_content}
                        </pre>
                      </div>
                    )}
                    {ev.metadata && (
                      <div className="mt-3">
                        <div className="text-xs text-zinc-500 mb-1">Metadata:</div>
                        <pre className="bg-zinc-950 rounded-lg p-3 text-xs text-zinc-400 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                          {ev.metadata}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Screenshot Preview Modal */}
      {previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setPreviewUrl(null)}>
          <div className="relative max-w-4xl max-h-[90vh] bg-zinc-900 rounded-xl border border-zinc-700 overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-zinc-700">
              <span className="text-sm text-zinc-300">Screenshot Preview</span>
              <button onClick={() => setPreviewUrl(null)} className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 overflow-auto max-h-[80vh]">
              <img src={previewUrl} alt="Browser screenshot" className="max-w-full rounded-lg" onError={() => setPreviewUrl(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
