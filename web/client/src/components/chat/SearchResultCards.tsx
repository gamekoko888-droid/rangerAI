/**
 * SearchResultCards — v2.0 Enhanced Structured Search Results
 * 
 * Parses search result JSON and renders as rich cards with:
 * - Grid layout for multiple results
 * - Favicon + domain badge
 * - Snippet preview with highlight
 * - Numbered results indicator
 * - Responsive 1-2 column grid
 */
import { ExternalLink, Globe, Search } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface SearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  description?: string;
  content?: string;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url.substring(0, 30);
  }
}

function parseSearchResults(raw: string): SearchResult[] | null {
  try {
    const parsed = JSON.parse(raw);
    
    // Array of results
    if (Array.isArray(parsed)) {
      const results = parsed.filter(
        (r: unknown) => r && typeof r === 'object' && ('title' in (r as object) || 'url' in (r as object))
      );
      if (results.length > 0) return results as SearchResult[];
    }
    
    // Object with results array
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const arr = obj.results || obj.items || obj.data || obj.organic || obj.web;
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.filter(
          (r: unknown) => r && typeof r === 'object' && ('title' in (r as object) || 'url' in (r as object))
        ) as SearchResult[];
      }
    }
  } catch {
    // Not JSON, try line-based parsing
    const lines = raw.split('\n').filter(l => l.trim());
    const results: SearchResult[] = [];
    let current: Partial<SearchResult> = {};
    
    for (const line of lines) {
      const urlMatch = line.match(/https?:\/\/[^\s]+/);
      if (urlMatch && !current.url) {
        current.url = urlMatch[0];
        const titlePart = line.replace(urlMatch[0], '').trim().replace(/^[-:]\s*/, '');
        if (titlePart) current.title = titlePart;
      } else if (current.url && !current.snippet) {
        current.snippet = line.trim();
        results.push(current as SearchResult);
        current = {};
      } else if (line.length > 10 && !current.url) {
        current.title = line.trim();
      }
    }
    if (current.url) results.push(current as SearchResult);
    if (results.length > 0) return results;
  }
  
  return null;
}

export function SearchResultCards({ result }: { result: string }) {
  const { t } = useI18n();
  const results = parseSearchResults(result);
  if (!results || results.length === 0) return null;

  const displayResults = results.slice(0, 8);
  const useGrid = displayResults.length >= 3;

  return (
    <div className="mt-1.5">
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <Search size={10} className="text-blue-400/60" />
        <span className="text-[10px] text-zinc-600 font-medium">
          {t('searchCards.results')}
        </span>
        <span className="text-[9px] text-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 rounded-full">
          {results.length}
        </span>
      </div>

      {/* Results grid/list */}
      <div className={useGrid ? 'grid grid-cols-1 sm:grid-cols-2 gap-1.5' : 'space-y-1.5'}>
        {displayResults.map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-zinc-800/60 bg-zinc-900/40 hover:bg-zinc-800/40 
                       hover:border-zinc-700/60 transition-all duration-150 px-2.5 py-2 group relative overflow-hidden"
          >
            {/* Result number indicator */}
            <span className="absolute top-1.5 right-2 text-[9px] text-zinc-700 font-mono">
              {i + 1}
            </span>

            <div className="flex items-start gap-2">
              {/* Favicon */}
              {r.url && (
                <img
                  src={`https://www.google.com/s2/favicons?domain=${extractDomain(r.url)}&sz=32`}
                  alt=""
                  className="w-4 h-4 rounded-sm mt-0.5 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
                  loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              )}
              <div className="flex-1 min-w-0 pr-3">
                {/* Title */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-blue-400 group-hover:text-blue-300 truncate leading-tight">
                    {r.title || extractDomain(r.url || '')}
                  </span>
                  <ExternalLink size={9} className="text-zinc-600 group-hover:text-zinc-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                {/* Domain badge */}
                {r.url && (
                  <span className="inline-flex items-center gap-0.5 text-[9px] text-zinc-600 mt-0.5">
                    <Globe size={8} className="opacity-50" />
                    {extractDomain(r.url)}
                  </span>
                )}
                {/* Snippet */}
                {(r.snippet || r.description || r.content) && (
                  <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2 leading-relaxed">
                    {(r.snippet || r.description || r.content || '').substring(0, 200)}
                  </p>
                )}
              </div>
            </div>
          </a>
        ))}
      </div>

      {/* Show more indicator */}
      {results.length > 8 && (
        <p className="text-[9px] text-zinc-600 text-center mt-1">
          +{results.length - 8} more results
        </p>
      )}
    </div>
  );
}
