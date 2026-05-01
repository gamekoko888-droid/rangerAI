/**
 * FilePanel — Workspace file browser with tree view and file preview.
 * 
 * Features:
 * - Recursive file tree with expand/collapse
 * - Syntax-highlighted code preview
 * - Image preview for common formats
 * - File download support
 * - Real-time updates via file_changed events
 * - Responsive: hidden on mobile, side panel on desktop
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import type { WorkspaceFileEntry, WorkspaceFileContent } from '../../lib/types';
import { downloadWorkspaceFile } from '../../lib/api';
import { ScrollArea } from '../ui/scroll-area';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import {
  FolderOpen, Folder, FileText, FileCode, FileImage, FileJson,
  ChevronRight, ChevronDown, Download, RefreshCw, X, Copy,
  Check, File, FileArchive, FileSpreadsheet, Loader2,
  PanelRightClose, FolderTree, Eye, AlertCircle,
} from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { copyToClipboard } from '../../lib/clipboard';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';

// Register commonly used languages for lighter bundle
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml';
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css';
import markdown from 'react-syntax-highlighter/dist/esm/languages/hljs/markdown';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import { logger } from "../../lib/logger";

SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('xml', xml);
SyntaxHighlighter.registerLanguage('html', xml);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('sql', sql);

// ─── File Extension → Language Mapping ──────────────────────

const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyw: 'python',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', less: 'css',
  md: 'markdown', mdx: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  xml: 'xml', svg: 'xml',
  txt: 'plaintext',
  env: 'bash',
  dockerfile: 'bash',
  makefile: 'bash',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

function getFileExtension(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

function getLanguage(filename: string): string {
  const ext = getFileExtension(filename);
  return EXT_LANG_MAP[ext] || 'plaintext';
}

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(filename));
}

// ─── File Icon Component ────────────────────────────────────

function FileIcon({ name, type, isOpen }: { name: string; type: 'file' | 'directory'; isOpen?: boolean }) {
  if (type === 'directory') {
    return isOpen
      ? <FolderOpen size={15} className="text-amber-400 shrink-0" />
      : <Folder size={15} className="text-amber-400/70 shrink-0" />;
  }

  const ext = getFileExtension(name);
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return <FileCode size={15} className="text-yellow-400 shrink-0" />;
    case 'ts': case 'tsx': case 'mts':
      return <FileCode size={15} className="text-blue-400 shrink-0" />;
    case 'py':
      return <FileCode size={15} className="text-green-400 shrink-0" />;
    case 'json': case 'jsonc':
      return <FileJson size={15} className="text-amber-300 shrink-0" />;
    case 'html': case 'htm': case 'vue': case 'svelte':
      return <FileCode size={15} className="text-orange-400 shrink-0" />;
    case 'css': case 'scss': case 'less':
      return <FileCode size={15} className="text-pink-400 shrink-0" />;
    case 'md': case 'mdx':
      return <FileText size={15} className="text-zinc-400 shrink-0" />;
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico':
      return <FileImage size={15} className="text-purple-400 shrink-0" />;
    case 'zip': case 'tar': case 'gz': case 'rar':
      return <FileArchive size={15} className="text-zinc-500 shrink-0" />;
    case 'csv': case 'xls': case 'xlsx':
      return <FileSpreadsheet size={15} className="text-emerald-400 shrink-0" />;
    default:
      return <File size={15} className="text-zinc-500 shrink-0" />;
  }
}

// ─── Tree Node Component ────────────────────────────────────

interface TreeNodeProps {
  entry: WorkspaceFileEntry;
  depth: number;
  selectedPath: string | null;
  changedFiles: string[];
  onSelect: (path: string) => void;
  defaultExpanded?: boolean;
}

function TreeNode({ entry, depth, selectedPath, changedFiles, onSelect, defaultExpanded }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? depth < 1);
  const isSelected = selectedPath === entry.path;
  const isChanged = changedFiles.includes(entry.path);
  const isDir = entry.type === 'directory';

  // Auto-expand directories containing changed files
  useEffect(() => {
    if (isDir && entry.children) {
      const hasChangedChild = changedFiles.some(f => f.startsWith(entry.path + '/'));
      if (hasChangedChild && !expanded) {
        setExpanded(true);
      }
    }
  }, [changedFiles, entry.path, entry.children, isDir, expanded]);

  const handleClick = useCallback(() => {
    if (isDir) {
      setExpanded(!expanded);
    } else {
      onSelect(entry.path);
    }
  }, [isDir, expanded, entry.path, onSelect]);

  // Sort children: directories first, then files, alphabetically
  const sortedChildren = useMemo(() => {
    if (!entry.children) return [];
    return [...entry.children].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [entry.children]);

  return (
    <div>
      <button
        onClick={handleClick}
        className={`
          w-full flex items-center gap-1 py-[3px] pr-2 text-left text-[13px] leading-5
          rounded-sm transition-colors group
          ${isSelected
            ? 'bg-blue-500/20 text-blue-300'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'}
          ${isChanged && !isSelected ? 'text-amber-300' : ''}
        `}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {isDir && (
          <span className="shrink-0 w-3.5 flex items-center justify-center">
            {expanded
              ? <ChevronDown size={12} className="text-zinc-500" />
              : <ChevronRight size={12} className="text-zinc-500" />
            }
          </span>
        )}
        {!isDir && <span className="w-3.5 shrink-0" />}
        <FileIcon name={entry.name} type={entry.type} isOpen={expanded} />
        <span className="truncate">{entry.name}</span>
        {isChanged && (
          <span className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full bg-amber-400" />
        )}
      </button>
      {isDir && expanded && sortedChildren.map(child => (
        <TreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          changedFiles={changedFiles}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// ─── File Preview Component ─────────────────────────────────

function FilePreview({ content, onClose }: { content: WorkspaceFileContent; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const lang = getLanguage(content.path);
  const filename = content.path.split('/').pop() || content.path;
  const isImage = isImageFile(filename);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(content.content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content.content]);

  const handleDownload = useCallback(async () => {
    try {
      const blobUrl = await downloadWorkspaceFile(content.path);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      logger.error('Download failed:', err);
    }
  }, [content.path, filename]);

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Preview Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-900/80 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileIcon name={filename} type="file" />
          <span className="text-[13px] text-zinc-200 truncate font-medium">{filename}</span>
          <span className="text-[11px] text-zinc-500">{formatSize(content.size)}</span>
        </div>
        <div className="flex items-center gap-1">
          {!content.isBinary && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleCopy}
                  className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('fp.copyContent')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleDownload}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                <Download size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('fp.downloadFile')}</TooltipContent>
          </Tooltip>
          <button
            onClick={onClose}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors ml-1"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Preview Content */}
      <div className="flex-1 overflow-hidden">
        {content.isBinary ? (
          isImage ? (
            <div className="flex items-center justify-center h-full p-4 bg-zinc-950/50">
              <img
                src={`/api/workspace/file?path=${encodeURIComponent(content.path)}&raw=1`}
                alt={filename}
                className="max-w-full max-h-full object-contain rounded"
                loading="lazy"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500">
              <FileArchive size={40} className="text-zinc-600" />
              <p className="text-sm">{t('fp.binaryNoPreview')}</p>
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition-colors"
              >
                <Download size={14} />
                {t('fp.downloadFile')}
              </button>
            </div>
          )
        ) : (
          <ScrollArea className="h-full">
            <SyntaxHighlighter
              language={lang}
              style={atomOneDark}
              customStyle={{
                margin: 0,
                padding: '12px 14px',
                background: 'transparent',
                fontSize: '12.5px',
                lineHeight: '1.6',
              }}
              showLineNumbers
              lineNumberStyle={{
                minWidth: '2.5em',
                paddingRight: '1em',
                color: 'rgba(113, 113, 122, 0.5)',
                fontSize: '11px',
              }}
              wrapLongLines
            >
              {content.content}
            </SyntaxHighlighter>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

// ─── Empty State ────────────────────────────────────────────

function EmptyFilePanel({ hasFiles, isLoading }: { hasFiles: boolean; isLoading: boolean }) {
  const { t } = useI18n();
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500">
        <Loader2 size={24} className="animate-spin text-zinc-600" />
        <p className="text-sm">{t('fp.loadingFiles')}</p>
      </div>
    );
  }

  if (!hasFiles) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500 px-6 text-center">
        <FolderTree size={32} className="text-zinc-600" />
        <div>
          <p className="text-sm font-medium text-zinc-400">{t('fp.noFiles')}</p>
          <p className="text-xs mt-1 text-zinc-600">
            {t('fp.noFilesHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-500 px-6 text-center">
      <Eye size={28} className="text-zinc-600" />
      <div>
        <p className="text-sm text-zinc-400">{t('fp.selectFile')}</p>
        <p className="text-xs mt-1 text-zinc-600">
          {t('fp.selectFileHint')}
        </p>
      </div>
    </div>
  );
}

// ─── Main FilePanel Component ───────────────────────────────

export function FilePanel() {
  const { t } = useI18n();
  const {
    workspaceFiles,
    selectedFilePath,
    fileContent,
    isFilePanelOpen,
    isLoadingFiles,
    changedFiles,
    loadWorkspaceFiles,
    selectFile,
    toggleFilePanel,
  } = useWorkspaceStore();

  // Load files when panel opens
  useEffect(() => {
    if (isFilePanelOpen) {
      loadWorkspaceFiles();
    }
  }, [isFilePanelOpen, loadWorkspaceFiles]);

  // Reload files when changedFiles updates
  useEffect(() => {
    if (isFilePanelOpen && changedFiles.length > 0) {
      const timer = setTimeout(() => {
        loadWorkspaceFiles();
      }, 500); // debounce
      return () => clearTimeout(timer);
    }
  }, [changedFiles, isFilePanelOpen, loadWorkspaceFiles]);

  const handleRefresh = useCallback(() => {
    loadWorkspaceFiles();
  }, [loadWorkspaceFiles]);

  const handleSelectFile = useCallback((path: string) => {
    selectFile(path);
  }, [selectFile]);

  const handleClosePreview = useCallback(() => {
    selectFile(null);
  }, [selectFile]);

  if (!isFilePanelOpen) return null;

  const hasFiles = workspaceFiles.length > 0;

  return (
    <div className="flex flex-col h-full bg-zinc-950 border-l border-zinc-800">
      {/* Panel Header */}
      <div className="flex items-center justify-between h-11 px-3 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
        <div className="flex items-center gap-2">
          <FolderTree size={15} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-300">{t('fp.workspaceFiles')}</span>
          {changedFiles.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">
              {changedFiles.length} {t('fp.changes')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRefresh}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                disabled={isLoadingFiles}
              >
                <RefreshCw size={14} className={isLoadingFiles ? 'animate-spin' : ''} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('fp.refreshFiles')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggleFilePanel(false)}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                <PanelRightClose size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('fp.closePanel')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Panel Body */}
      {selectedFilePath && fileContent ? (
        <FilePreview content={fileContent} onClose={handleClosePreview} />
      ) : (
        <div className="flex-1 overflow-hidden">
          {!hasFiles && !isLoadingFiles ? (
            <EmptyFilePanel hasFiles={false} isLoading={false} />
          ) : isLoadingFiles && !hasFiles ? (
            <EmptyFilePanel hasFiles={false} isLoading={true} />
          ) : (
            <ScrollArea className="h-full">
              <div className="py-1">
                {workspaceFiles.map(entry => (
                  <TreeNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    selectedPath={selectedFilePath}
                    changedFiles={changedFiles}
                    onSelect={handleSelectFile}
                    defaultExpanded
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}

      {/* Error indicator for failed file loads */}
      {selectedFilePath && !fileContent && !isLoadingFiles && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800 text-zinc-500 text-xs">
          <AlertCircle size={12} />
          <span>{t('fp.loadFailed')}</span>
        </div>
      )}
    </div>
  );
}
