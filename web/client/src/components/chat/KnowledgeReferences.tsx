/**
 * KnowledgeReferences — Display RAG source citations for AI messages.
 * Shows which knowledge documents were used to generate the response.
 */
import { useState, useEffect, useCallback } from 'react';
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, FileText, Tag } from 'lucide-react';
import { getAuthToken } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { logger } from "../../lib/logger";

interface KnowledgeReference {
  id: string;
  messageId: string;
  knowledgeDocId: string;
  snippet: string;
  createdAt: number;
  docTitle: string;
  docCategory: string;
}

interface KnowledgeReferencesProps {
  msgId: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  '市场': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  '运营': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  '技术': 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  '客服': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  'test': 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
}

export function KnowledgeReferences({ msgId }: KnowledgeReferencesProps) {
  const { t } = useI18n();
  const [references, setReferences] = useState<KnowledgeReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedSnippets, setExpandedSnippets] = useState<Set<string>>(new Set());

  const fetchReferences = useCallback(async () => {
    if (loaded || loading) return;
    setLoading(true);
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      
      const res = await fetch(`/api/messages/${msgId}/references`, {
        headers,
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setReferences(data.references || []);
      }
    } catch (err) {
      logger.error('[KnowledgeReferences] Failed to fetch:', err);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [msgId, loaded, loading]);

  // Auto-fetch on mount
  useEffect(() => {
    fetchReferences();
  }, [fetchReferences]);

  if (!loaded || loading) return null;
  if (references.length === 0) return null;

  const toggleSnippet = (refId: string) => {
    setExpandedSnippets(prev => {
      const next = new Set(prev);
      if (next.has(refId)) next.delete(refId);
      else next.add(refId);
      return next;
    });
  };

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors group"
      >
        <BookOpen size={12} className="text-blue-400/70 group-hover:text-blue-400" />
        <span>{t('kref.title')}</span>
        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-blue-500/15 text-blue-400 text-[10px] font-medium">
          {references.length}
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
          {references.map((ref) => (
            <div
              key={ref.id}
              className="group/card rounded-lg border border-zinc-700/50 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600/50 transition-all cursor-pointer"
              onClick={() => toggleSnippet(ref.id)}
            >
              <div className="flex items-start gap-2 px-2.5 py-2">
                <FileText size={13} className="text-blue-400/70 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[12px] font-medium text-zinc-200 truncate max-w-[200px]">
                      {ref.docTitle}
                    </span>
                    {ref.docCategory && (
                      <span className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0 rounded-full border ${getCategoryColor(ref.docCategory)}`}>
                        <Tag size={8} />
                        {ref.docCategory}
                      </span>
                    )}
                  </div>
                  {expandedSnippets.has(ref.id) && ref.snippet && (
                    <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed line-clamp-4">
                      {ref.snippet}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
                  {expandedSnippets.has(ref.id) ? (
                    <ChevronDown size={12} className="text-zinc-500" />
                  ) : (
                    <ChevronRight size={12} className="text-zinc-500" />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
