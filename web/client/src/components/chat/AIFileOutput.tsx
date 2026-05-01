/**
 * AIFileOutput — v3.0 Multi-Format Rich Rendering
 * 
 * Detects and renders downloadable file blocks in AI responses with:
 * - Line numbers in code preview
 * - File type-specific icons and colors
 * - File size estimation
 * - Enhanced image cards with zoom
 * - Better download UX with file type badges
 * - v3: Mermaid diagram rendering
 * - v3: CSV → interactive table preview
 * - v3: Markdown rendered preview
 * - v3: SVG inline rendering
 * - v3: HTML sandboxed preview
 */

import { useState, useMemo, useEffect, useRef } from 'react';
import {
 Download, Copy, Check, FileCode, ExternalLink, ChevronDown, ChevronUp,
 FileText, FileImage, FileSpreadsheet, FileArchive, File, FileJson,
 Hash, Maximize2, X, Eye, Code, Table, GitBranch, Globe,
} from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { copyToClipboard } from '../../lib/clipboard';

interface DetectedFile {
  type: 'code' | 'image' | 'link' | 'mermaid' | 'csv' | 'markdown' | 'svg' | 'html';
  name: string;
  language?: string;
  content?: string;
  url?: string;
  mimeType?: string;
}

// v2: File extension → icon/color mapping
const FILE_TYPE_MAP: Record<string, { icon: typeof FileCode; color: string; bgColor: string }> = {
  // Code files
  py: { icon: FileCode, color: 'text-yellow-400', bgColor: 'bg-yellow-500/10' },
  js: { icon: FileCode, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  ts: { icon: FileCode, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  tsx: { icon: FileCode, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  jsx: { icon: FileCode, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  html: { icon: FileCode, color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
  css: { icon: FileCode, color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
  sh: { icon: FileCode, color: 'text-green-400', bgColor: 'bg-green-500/10' },
  bash: { icon: FileCode, color: 'text-green-400', bgColor: 'bg-green-500/10' },
  sql: { icon: FileCode, color: 'text-cyan-400', bgColor: 'bg-cyan-500/10' },
  // Data files
  json: { icon: FileJson, color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
  yaml: { icon: FileJson, color: 'text-rose-400', bgColor: 'bg-rose-500/10' },
  yml: { icon: FileJson, color: 'text-rose-400', bgColor: 'bg-rose-500/10' },
  xml: { icon: FileJson, color: 'text-teal-400', bgColor: 'bg-teal-500/10' },
  csv: { icon: FileSpreadsheet, color: 'text-green-400', bgColor: 'bg-green-500/10' },
  xlsx: { icon: FileSpreadsheet, color: 'text-green-400', bgColor: 'bg-green-500/10' },
  xls: { icon: FileSpreadsheet, color: 'text-green-400', bgColor: 'bg-green-500/10' },
  // Document files
  md: { icon: FileText, color: 'text-zinc-300', bgColor: 'bg-zinc-500/10' },
  txt: { icon: FileText, color: 'text-zinc-400', bgColor: 'bg-zinc-500/10' },
  pdf: { icon: FileText, color: 'text-red-400', bgColor: 'bg-red-500/10' },
  doc: { icon: FileText, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  docx: { icon: FileText, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  // Image files
  png: { icon: FileImage, color: 'text-pink-400', bgColor: 'bg-pink-500/10' },
  jpg: { icon: FileImage, color: 'text-pink-400', bgColor: 'bg-pink-500/10' },
  jpeg: { icon: FileImage, color: 'text-pink-400', bgColor: 'bg-pink-500/10' },
  svg: { icon: FileImage, color: 'text-orange-400', bgColor: 'bg-orange-500/10' },
  webp: { icon: FileImage, color: 'text-pink-400', bgColor: 'bg-pink-500/10' },
  // Archive files
  zip: { icon: FileArchive, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  tar: { icon: FileArchive, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  gz: { icon: FileArchive, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  // Diagram files
  mmd: { icon: GitBranch, color: 'text-violet-400', bgColor: 'bg-violet-500/10' },
  mermaid: { icon: GitBranch, color: 'text-violet-400', bgColor: 'bg-violet-500/10' },
};

function getFileTypeInfo(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return FILE_TYPE_MAP[ext] || { icon: File, color: 'text-zinc-400', bgColor: 'bg-zinc-500/10' };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── CSV Parser ────────────────────────────────────────────
function parseCSV(content: string): string[][] {
  const rows: string[][] = [];
  const lines = content.trim().split('\n');
  for (const line of lines) {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          cells.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}

/**
 * Detect downloadable files in AI message content.
 * v3: Enhanced detection for mermaid, csv, markdown, svg, html
 */
export function detectFiles(content: string): DetectedFile[] {
  const files: DetectedFile[] = [];

  // 1. Code blocks with filenames: ```lang:filename or ```filename.ext
  const codeBlockRegex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const lang = match[1] || '';
    const filename = match[2]?.trim();
    const code = match[3]?.trim();
    
    // v3: Detect mermaid diagrams
    if (lang === 'mermaid') {
      files.push({
        type: 'mermaid',
        name: filename || 'diagram.mmd',
        language: 'mermaid',
        content: code,
      });
      continue;
    }
    
    // v3: Detect SVG content
    if (lang === 'svg' || (lang === 'xml' && code?.includes('<svg'))) {
      files.push({
        type: 'svg',
        name: filename || 'image.svg',
        language: 'svg',
        content: code,
      });
      continue;
    }
    
    // v3: Detect HTML content
    if (lang === 'html' && code && (code.includes('<html') || code.includes('<body') || code.includes('<!DOCTYPE') || code.length > 200)) {
      files.push({
        type: 'html',
        name: filename || 'page.html',
        language: 'html',
        content: code,
      });
      continue;
    }
    
    // v3: Detect CSV content
    if (lang === 'csv' || (filename && filename.endsWith('.csv'))) {
      files.push({
        type: 'csv',
        name: filename || 'data.csv',
        language: 'csv',
        content: code,
      });
      continue;
    }
    
    // v3: Detect Markdown content
    if ((lang === 'md' || lang === 'markdown') && filename) {
      files.push({
        type: 'markdown',
        name: filename,
        language: 'markdown',
        content: code,
      });
      continue;
    }
    
    if (filename && code) {
      // Check file extension for additional type detection
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext === 'csv') {
        files.push({ type: 'csv', name: filename, language: 'csv', content: code });
      } else if (ext === 'svg') {
        files.push({ type: 'svg', name: filename, language: 'svg', content: code });
      } else if (ext === 'html' || ext === 'htm') {
        files.push({ type: 'html', name: filename, language: 'html', content: code });
      } else if (ext === 'md' || ext === 'markdown') {
        files.push({ type: 'markdown', name: filename, language: 'markdown', content: code });
      } else if (ext === 'mmd' || ext === 'mermaid') {
        files.push({ type: 'mermaid', name: filename, language: 'mermaid', content: code });
      } else {
        files.push({ type: 'code', name: filename, language: lang, content: code });
      }
    }
  }

  // 2. Image URLs in markdown: ![alt](url)
  const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = imgRegex.exec(content)) !== null) {
    const alt = match[1] || 'image';
    const url = match[2];
    if (url.startsWith('http') || url.startsWith('/files/')) {
      files.push({
        type: 'image',
        name: alt,
        url,
        mimeType: 'image/png',
      });
    }
  }

  // 3. File download links: [Download filename](url) or [📎 filename](url)
  const linkRegex = /\[(?:📎\s*|Download\s+|下载\s+)?([^\]]+)\]\(([^)]+)\)/g;
  while ((match = linkRegex.exec(content)) !== null) {
    const name = match[1];
    const url = match[2];
    // Skip image links (already handled) and anchor links
    if (url.startsWith('#') || /!\[/.test(content.substring(match.index - 2, match.index))) continue;
    if (url.startsWith('/files/') || (url.startsWith('http') && /\.(pdf|docx?|xlsx?|csv|zip|tar|gz|py|js|ts|html|css|json|xml|yaml|txt|md|sh)$/i.test(url))) {
      files.push({
        type: 'link',
        name,
        url,
      });
    }
  }

  return files;
}

interface AIFileOutputProps {
  files: DetectedFile[];
}

export function AIFileOutput({ files }: AIFileOutputProps) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wider font-medium">
        <FileCode size={11} />
        <span>{t('aiFile.generatedFiles')} ({files.length})</span>
      </div>
      {files.map((file, i) => (
        <FileCard key={`${file.name}-${i}`} file={file} />
      ))}
    </div>
  );
}

// ─── Mermaid Renderer ──────────────────────────────────────
declare global {
  interface Window { mermaid?: any; __rangerMermaidPromise?: Promise<any>; }
}

function loadMermaidFromCdn(): Promise<any> {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (window.__rangerMermaidPromise) return window.__rangerMermaidPromise;
  window.__rangerMermaidPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
    script.async = true;
    script.onload = () => window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid CDN loaded without global'));
    script.onerror = () => reject(new Error('Failed to load Mermaid CDN'));
    document.head.appendChild(script);
  });
  return window.__rangerMermaidPromise;
}

function MermaidPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaidFromCdn();
        mermaid.initialize({ 
          startOnLoad: false, 
          theme: 'dark',
          themeVariables: {
            darkMode: true,
            background: '#18181b',
            primaryColor: '#6366f1',
            primaryTextColor: '#e4e4e7',
            primaryBorderColor: '#3f3f46',
            lineColor: '#71717a',
            secondaryColor: '#27272a',
            tertiaryColor: '#1f1f23',
          }
        });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: renderedSvg } = await mermaid.render(id, content);
        if (!cancelled) {
          setSvg(renderedSvg);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || 'Failed to render diagram');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [content]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-zinc-500 text-xs">
        <div className="animate-spin w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full mr-2" />
        渲染图表中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 text-xs text-red-400 bg-red-500/10 rounded">
        图表渲染失败: {error}
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="p-4 overflow-auto bg-zinc-900/50 flex items-center justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ─── CSV Table Renderer ────────────────────────────────────
function CSVTablePreview({ content }: { content: string }) {
  const rows = useMemo(() => parseCSV(content), [content]);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  
  if (rows.length === 0) return null;
  
  const headers = rows[0];
  const dataRows = rows.slice(1);
  
  const sortedRows = useMemo(() => {
    if (sortCol === null) return dataRows;
    return [...dataRows].sort((a, b) => {
      const va = a[sortCol] || '';
      const vb = b[sortCol] || '';
      const na = parseFloat(va);
      const nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) {
        return sortAsc ? na - nb : nb - na;
      }
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }, [dataRows, sortCol, sortAsc]);
  
  const handleSort = (col: number) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const maxRows = 50;
  const displayRows = sortedRows.slice(0, maxRows);

  return (
    <div className="overflow-auto max-h-[400px]">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10">
          <tr className="bg-zinc-800">
            {headers.map((h, i) => (
              <th 
                key={i} 
                onClick={() => handleSort(i)}
                className="px-3 py-2 text-left text-zinc-300 font-medium border-b border-zinc-700 
                           cursor-pointer hover:bg-zinc-700/50 whitespace-nowrap select-none"
              >
                <span className="flex items-center gap-1">
                  {h}
                  {sortCol === i && (
                    <span className="text-[10px] text-zinc-500">{sortAsc ? '▲' : '▼'}</span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, ri) => (
            <tr key={ri} className="hover:bg-zinc-700/20 border-b border-zinc-800">
              {headers.map((_, ci) => (
                <td key={ci} className="px-3 py-1.5 text-zinc-400 whitespace-nowrap">
                  {row[ci] || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sortedRows.length > maxRows && (
        <div className="text-center py-2 text-[10px] text-zinc-600">
          显示前 {maxRows} 行 / 共 {sortedRows.length} 行
        </div>
      )}
    </div>
  );
}

// ─── Markdown Renderer ─────────────────────────────────────
function MarkdownPreview({ content }: { content: string }) {
  // Simple markdown → HTML conversion (headings, bold, italic, links, lists, code)
  const html = useMemo(() => {
    let result = content
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-zinc-900 rounded p-2 my-2 overflow-x-auto"><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="bg-zinc-800 px-1 py-0.5 rounded text-emerald-400">$1</code>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3 class="text-sm font-semibold text-zinc-200 mt-3 mb-1">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="text-base font-semibold text-zinc-100 mt-4 mb-1">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 class="text-lg font-bold text-zinc-50 mt-4 mb-2">$1</h1>')
      // Bold & italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-200">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-blue-400 hover:underline">$1</a>')
      // Unordered lists
      .replace(/^[-*] (.+)$/gm, '<li class="ml-4 list-disc text-zinc-400">$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal text-zinc-400">$1</li>')
      // Blockquotes
      .replace(/^> (.+)$/gm, '<blockquote class="border-l-2 border-zinc-600 pl-3 text-zinc-500 italic my-1">$1</blockquote>')
      // Horizontal rules
      .replace(/^---$/gm, '<hr class="border-zinc-700 my-3" />')
      // Paragraphs (double newline)
      .replace(/\n\n/g, '</p><p class="my-1.5 text-zinc-400">')
      // Single newlines
      .replace(/\n/g, '<br />');
    
    return `<div class="text-xs leading-relaxed"><p class="my-1.5 text-zinc-400">${result}</p></div>`;
  }, [content]);

  return (
    <div 
      className="p-3 overflow-auto max-h-[400px] prose-sm"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ─── SVG Renderer ──────────────────────────────────────────
function SVGPreview({ content }: { content: string }) {
  const [zoomed, setZoomed] = useState(false);
  
  // Sanitize: remove script tags
  const safeSvg = content.replace(/<script[\s\S]*?<\/script>/gi, '');
  
  return (
    <>
      <div 
        className="p-4 overflow-auto bg-zinc-900/50 flex items-center justify-center cursor-pointer group"
        onClick={() => setZoomed(true)}
      >
        <div 
          className="max-w-full max-h-[300px] [&>svg]:max-w-full [&>svg]:max-h-[300px] [&>svg]:w-auto [&>svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: safeSvg }}
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
          <Maximize2 size={20} className="text-white/0 group-hover:text-white/60 transition-colors" />
        </div>
      </div>
      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={() => setZoomed(false)}
        >
          <button
            onClick={() => setZoomed(false)}
            className="absolute top-4 right-4 p-2 rounded-full bg-zinc-800/80 text-zinc-300 hover:text-white hover:bg-zinc-700 transition-colors"
          >
            <X size={20} />
          </button>
          <div 
            className="max-w-[90vw] max-h-[90vh] overflow-auto bg-white rounded-lg p-4 shadow-2xl [&>svg]:max-w-full [&>svg]:max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: safeSvg }}
          />
        </div>
      )}
    </>
  );
}

// ─── HTML Preview (sandboxed iframe) ───────────────────────
function HTMLPreview({ content }: { content: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [expanded, setExpanded] = useState(false);
  
  const blobUrl = useMemo(() => {
    const blob = new Blob([content], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [content]);
  
  useEffect(() => {
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  return (
    <div className="relative">
      <iframe
        ref={iframeRef}
        src={blobUrl}
        sandbox="allow-scripts"
        className={`w-full border-0 bg-white rounded-b-lg transition-all ${expanded ? 'h-[500px]' : 'h-[200px]'}`}
        title="HTML Preview"
      />
      <button
        onClick={() => setExpanded(!expanded)}
        className="absolute bottom-2 right-2 px-2 py-1 text-[10px] bg-zinc-800/90 text-zinc-300 rounded 
                   hover:bg-zinc-700 transition-colors backdrop-blur-sm"
      >
        {expanded ? '收起' : '展开'}
      </button>
    </div>
  );
}

// ─── Main FileCard ─────────────────────────────────────────
function FileCard({ file }: { file: DetectedFile }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [imageZoomed, setImageZoomed] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

  const fileTypeInfo = useMemo(() => getFileTypeInfo(file.name), [file.name]);
  const FileIcon = fileTypeInfo.icon;

  const handleCopy = async () => {
    if (file.content) {
      const ok = await copyToClipboard(file.content);
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleDownload = () => {
    if (file.content) {
      const mimeMap: Record<string, string> = {
        html: 'text/html', svg: 'image/svg+xml', csv: 'text/csv',
        markdown: 'text/markdown', mermaid: 'text/plain',
      };
      const mime = mimeMap[file.type] || 'text/plain';
      const blob = new Blob([file.content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    } else if (file.url) {
      window.open(file.url, '_blank');
    }
  };

  // ─── Image card (unchanged from v2) ─────────────────────
  if (file.type === 'image' && file.url) {
    const imgSrc = file.url.startsWith('/') ? `${window.location.origin}${file.url}` : file.url;
    return (
      <>
        <div className="rounded-lg border border-zinc-700/50 overflow-hidden bg-zinc-800/50 group">
          <div className="flex items-center justify-between px-2.5 py-1.5 bg-zinc-800/80 border-b border-zinc-700/50">
            <div className="flex items-center gap-1.5 min-w-0">
              <FileImage size={12} className="text-pink-400 shrink-0" />
              <span className="text-xs text-zinc-400 truncate">{file.name}</span>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => setImageZoomed(true)}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                title={t('aiFile.openInNewTab')}
              >
                <Maximize2 size={12} />
              </button>
              <a
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                title={t('aiFile.openInNewTab')}
              >
                <ExternalLink size={12} />
              </a>
            </div>
          </div>
          <div className="relative cursor-pointer" onClick={() => setImageZoomed(true)}>
            <img
              src={imgSrc}
              alt={file.name}
              className="max-w-full max-h-[300px] object-contain mx-auto transition-transform group-hover:scale-[1.02]"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
              <Maximize2 size={20} className="text-white/0 group-hover:text-white/60 transition-colors" />
            </div>
          </div>
        </div>
        {imageZoomed && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={() => setImageZoomed(false)}
          >
            <button
              onClick={() => setImageZoomed(false)}
              className="absolute top-4 right-4 p-2 rounded-full bg-zinc-800/80 text-zinc-300 hover:text-white hover:bg-zinc-700 transition-colors"
            >
              <X size={20} />
            </button>
            <img
              src={imgSrc}
              alt={file.name}
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
              loading="lazy"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  // ─── v3: Rich preview types (mermaid, csv, markdown, svg, html) ─────
  const hasPreview = ['mermaid', 'csv', 'markdown', 'svg', 'html'].includes(file.type);
  
  if (hasPreview && file.content) {
    const typeLabels: Record<string, { label: string; icon: typeof Eye; color: string }> = {
      mermaid: { label: 'Mermaid 图表', icon: GitBranch, color: 'text-violet-400' },
      csv: { label: 'CSV 数据表', icon: Table, color: 'text-green-400' },
      markdown: { label: 'Markdown 文档', icon: FileText, color: 'text-zinc-300' },
      svg: { label: 'SVG 图形', icon: FileImage, color: 'text-orange-400' },
      html: { label: 'HTML 页面', icon: Globe, color: 'text-orange-400' },
    };
    const typeInfo = typeLabels[file.type] || { label: file.type, icon: File, color: 'text-zinc-400' };
    const TypeIcon = typeInfo.icon;
    const estimatedSize = new Blob([file.content]).size;

    return (
      <div className="rounded-lg border border-zinc-700/50 overflow-hidden bg-zinc-800/50">
        {/* Header */}
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-zinc-800/80 border-b border-zinc-700/50">
          <div className="flex items-center gap-1.5 min-w-0">
            <TypeIcon size={12} className={`${typeInfo.color} shrink-0`} />
            <span className="text-xs text-zinc-400 truncate">{file.name}</span>
            <span className={`text-[10px] px-1 py-0 rounded ${typeInfo.color} bg-zinc-700/50`}>{typeInfo.label}</span>
            <span className="text-[9px] text-zinc-600">{formatFileSize(estimatedSize)}</span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Toggle preview/code */}
            <button
              onClick={() => setViewMode(viewMode === 'preview' ? 'code' : 'preview')}
              className={`p-1 rounded transition-colors ${viewMode === 'preview' ? 'text-zinc-300 bg-zinc-700/50' : 'text-zinc-500 hover:text-zinc-300'}`}
              title={viewMode === 'preview' ? '查看源码' : '查看预览'}
            >
              {viewMode === 'preview' ? <Code size={12} /> : <Eye size={12} />}
            </button>
            <button
              onClick={handleCopy}
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
              title={t('aiFile.copyCode')}
            >
              {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
            </button>
            <button
              onClick={handleDownload}
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
              title={t('aiFile.downloadFile')}
            >
              <Download size={12} />
            </button>
          </div>
        </div>
        
        {/* Content */}
        {viewMode === 'preview' ? (
          <>
            {file.type === 'mermaid' && <MermaidPreview content={file.content} />}
            {file.type === 'csv' && <CSVTablePreview content={file.content} />}
            {file.type === 'markdown' && <MarkdownPreview content={file.content} />}
            {file.type === 'svg' && <SVGPreview content={file.content} />}
            {file.type === 'html' && <HTMLPreview content={file.content} />}
          </>
        ) : (
          <CodePreview content={file.content} language={file.language} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        )}
      </div>
    );
  }

  // ─── Code card (v2 with line numbers) ───────────────────
  if (file.type === 'code' && file.content) {
    const estimatedSize = new Blob([file.content]).size;
    const lines = file.content.split('\n');

    return (
      <div className="rounded-lg border border-zinc-700/50 overflow-hidden bg-zinc-800/50">
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-zinc-800/80 border-b border-zinc-700/50">
          <div className="flex items-center gap-1.5 min-w-0">
            <FileIcon size={12} className={`${fileTypeInfo.color} shrink-0`} />
            <span className="text-xs text-zinc-400 truncate">{file.name}</span>
            {file.language && (
              <span className={`text-[10px] px-1 py-0 rounded ${fileTypeInfo.bgColor} ${fileTypeInfo.color}`}>{file.language}</span>
            )}
            <span className="text-[9px] text-zinc-600">{lines.length} {t('aiFile.lines')} · {formatFileSize(estimatedSize)}</span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={handleCopy}
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
              title={t('aiFile.copyCode')}
            >
              {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
            </button>
            <button
              onClick={handleDownload}
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
              title={t('aiFile.downloadFile')}
            >
              <Download size={12} />
            </button>
          </div>
        </div>
        <CodePreview content={file.content} language={file.language} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      </div>
    );
  }

  // ─── File link card (v2) ────────────────────────────────
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      download={file.name}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-700/50 bg-zinc-800/50
                 hover:bg-zinc-700/50 transition-all group hover:border-zinc-600/50"
    >
      <div className={`w-8 h-8 rounded-lg ${fileTypeInfo.bgColor} flex items-center justify-center shrink-0`}>
        <FileIcon size={16} className={`${fileTypeInfo.color} group-hover:scale-110 transition-transform`} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-xs text-zinc-300 group-hover:text-zinc-100 truncate block">{file.name}</span>
        <span className="text-[10px] text-zinc-600">{file.name.split('.').pop()?.toUpperCase()} {t('aiFile.downloadFile')}</span>
      </div>
      <Download size={14} className="text-zinc-600 group-hover:text-zinc-300 shrink-0 transition-colors" />
    </a>
  );
}

// ─── Shared Code Preview ───────────────────────────────────
function CodePreview({ content, language, expanded, onToggle }: { 
  content: string; language?: string; expanded: boolean; onToggle: () => void 
}) {
  const { t } = useI18n();
  const lines = content.split('\n');
  const isLong = lines.length > 12;
  const displayLines = expanded ? lines : lines.slice(0, 12);

  return (
    <>
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full border-collapse">
          <tbody>
            {displayLines.map((line, i) => (
              <tr key={i} className="hover:bg-zinc-700/20">
                <td className="text-right pr-3 pl-2 py-0 text-[10px] text-zinc-600 select-none w-[1%] whitespace-nowrap border-r border-zinc-700/30 align-top leading-[1.6]">
                  {i + 1}
                </td>
                <td className="pl-3 pr-3 py-0 text-[11px] sm:text-xs text-zinc-300 whitespace-pre font-mono leading-[1.6]">
                  {line || ' '}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isLong && (
        <button
          onClick={onToggle}
          className="w-full flex items-center justify-center gap-1 py-1.5 text-[10px] text-zinc-500 
                     hover:text-zinc-300 bg-zinc-800/80 border-t border-zinc-700/50 transition-colors"
        >
          {expanded ? (
            <><ChevronUp size={11} /> {t('aiFile.collapse')}</>
          ) : (
            <><ChevronDown size={11} /> {t('aiFile.expandAll')} ({lines.length} {t('aiFile.lines')})</>
          )}
        </button>
      )}
    </>
  );
}
