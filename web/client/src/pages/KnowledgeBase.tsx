import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Upload, Search, FileText, Image, FileCode, File,
  Trash2, Tag, FolderOpen, Plus, X, Eye,
  Calendar, HardDrive, ChevronRight, ChevronLeft, Menu, RefreshCw, Zap, AlertCircle, CheckCircle2, Loader2, BarChart3
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '../lib/i18n';
import { logger } from "../lib/logger";

const API_BASE = '/api/knowledge';

/**
 * Fix double-UTF8 encoded strings.
 * When Chinese filenames are uploaded via multipart, the UTF-8 bytes sometimes get
 * double-encoded (each byte treated as Latin-1 then re-encoded as UTF-8).
 * This function detects and reverses the double encoding.
 */
function fixDoubleUtf8(str: string): string {
  if (!str) return str;
  // Check if the string contains garbled characters typical of double-UTF8
  // These are Latin-1 chars (0x80-0xFF) that appear when UTF-8 bytes are misinterpreted
  const hasGarbled = /[\xC0-\xFF][\x80-\xBF]/.test(str);
  if (!hasGarbled) return str;
  try {
    // Each char's code point IS the original byte value
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xff;
    }
    const decoded = new TextDecoder('utf-8').decode(bytes);
    // Verify the result contains actual CJK characters
    if (/[一-鿿]/.test(decoded)) return decoded;
    return str;
  } catch {
    return str;
  }
}

interface KnowledgeDoc {
  score?: number;
  sources?: string[];
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string;
  fileName: string | null;
  filePath: string | null;
  fileSize: number;
  mimeType: string;
  content: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  scope?: string;
  priority?: number;
  enabled?: number;
}

interface EmbeddingStatus {
  docId: string;
  docTitle: string;
  contentLength: number;
  embeddingCount: number;
  maxChunkIndex: number;
  hasEmbeddings: boolean;
  status: 'ready' | 'missing';
}

interface Category {
  category: string;
  count: number;
}

// Category keys for i18n mapping
const CATEGORY_KEYS = [
  'kb.cat.uncategorized', 'kb.cat.techDoc', 'kb.cat.productReq', 'kb.cat.meetingNotes',
  'kb.cat.knowledgeBase', 'kb.cat.training', 'kb.cat.standards', 'kb.cat.apiDoc'
] as const;

// Server-side category values (always Chinese for DB storage)
const PRESET_CATEGORIES_SERVER = ['未分类', '技术文档', '产品需求', '会议纪要', '知识沉淀', '培训资料', '规范标准', 'API文档'];

const CATEGORY_COLORS_BY_INDEX: string[] = [
  'bg-white/5 text-white/50 border-white/10',       // uncategorized
  'bg-blue-500/15 text-blue-400 border-blue-500/20', // techDoc
  'bg-purple-500/15 text-purple-400 border-purple-500/20', // productReq
  'bg-amber-500/15 text-amber-400 border-amber-500/20',   // meetingNotes
  'bg-emerald-500/15 text-emerald-400 border-emerald-500/20', // knowledgeBase
  'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',    // training
  'bg-rose-500/15 text-rose-400 border-rose-500/20',    // standards
  'bg-orange-500/15 text-orange-400 border-orange-500/20', // apiDoc
];

const CATEGORY_COLORS: Record<string, string> = {
  '技术文档': 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  '产品需求': 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  '会议纪要': 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  '知识沉淀': 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  '培训资料': 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20',
  '规范标准': 'bg-rose-500/15 text-rose-400 border-rose-500/20',
  'API文档': 'bg-orange-500/15 text-orange-400 border-orange-500/20',
  '未分类': 'bg-white/5 text-white/50 border-white/10',
};
// v26.0: Scope options for knowledge injection filtering
const SCOPE_OPTIONS = [
  { value: 'general', label: '通用', color: 'bg-gray-500/15 text-gray-400 border-gray-500/20' },
  { value: 'code', label: '代码/开发', color: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20' },
  { value: 'operations', label: '运维', color: 'bg-red-500/15 text-red-400 border-red-500/20' },
  { value: 'customer-service', label: '客服', color: 'bg-pink-500/15 text-pink-400 border-pink-500/20' },
  { value: 'kol', label: 'KOL/营销', color: 'bg-violet-500/15 text-violet-400 border-violet-500/20' },
  { value: 'analysis', label: '数据分析', color: 'bg-teal-500/15 text-teal-400 border-teal-500/20' },
  { value: 'research', label: '研究', color: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/20' },
  { value: 'creative', label: '创意/写作', color: 'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/20' },
];
const getScopeOption = (val: string) => SCOPE_OPTIONS.find(s => s.value === val) || SCOPE_OPTIONS[0];


function getFileIcon(mimeType: string) {
  if (mimeType?.startsWith('image/')) return <Image className="w-5 h-5 text-green-400" />;
  if (mimeType?.includes('json') || mimeType?.includes('javascript') || mimeType?.includes('python') || mimeType?.includes('code'))
    return <FileCode className="w-5 h-5 text-yellow-400" />;
  if (mimeType?.startsWith('text/') || mimeType?.includes('markdown'))
    return <FileText className="w-5 h-5 text-blue-400" />;
  return <File className="w-5 h-5 text-gray-400" />;
}

function formatFileSizeI18n(bytes: number, textEntryLabel: string): string {
  if (bytes === 0) return textEntryLabel;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateI18n(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('rangerai_token');
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export default function KnowledgeBase() {
  const { t, locale } = useI18n();
  const [, setLocation] = useLocation();

  // i18n helpers
  const getCatLabel = (serverCat: string) => {
    const idx = PRESET_CATEGORIES_SERVER.indexOf(serverCat);
    return idx >= 0 ? t(CATEGORY_KEYS[idx]) : serverCat;
  };
  const getCatColor = (serverCat: string) => {
    const idx = PRESET_CATEGORIES_SERVER.indexOf(serverCat);
    return idx >= 0 ? CATEGORY_COLORS_BY_INDEX[idx] : CATEGORY_COLORS_BY_INDEX[0];
  };
  const fmtSize = (bytes: number) => formatFileSizeI18n(bytes, t('kb.textEntry'));
  const fmtDate = (d: string) => formatDateI18n(d, locale === 'en' ? 'en-US' : locale === 'zh-TW' ? 'zh-TW' : 'zh-CN');
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showTextEntry, setShowTextEntry] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);
  const [uploadProgress, setUploadProgress] = useState(false);
  const [showMobileCategories, setShowMobileCategories] = useState(false);
  const [embeddingStatuses, setEmbeddingStatuses] = useState<Record<string, EmbeddingStatus>>({});
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [totalDocs2, setTotalDocs2] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const PAGE_SIZE = 20;

  // Upload form state
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadCategory, setUploadCategory] = useState('未分类');
  const [uploadTags, setUploadTags] = useState('');
  const [uploadFile, setUploadFile] = useState<globalThis.File | null>(null);
  const [textContent, setTextContent] = useState('');
  const [isCustomCategory, setIsCustomCategory] = useState(false);
  const [customCategoryInput, setCustomCategoryInput] = useState('');
  const [tagChips, setTagChips] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  // v26.0: Scope, priority, enabled state
  const [uploadScope, setUploadScope] = useState('general');
  const [uploadPriority, setUploadPriority] = useState(50);
  const [uploadEnabled, setUploadEnabled] = useState(true);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const customCatInputRef = useRef<HTMLInputElement>(null);

  const loadDocs = useCallback(async () => {
    try {
      setLoading(true);
      const offset = (currentPage - 1) * PAGE_SIZE;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (selectedCategory) params.set('category', selectedCategory);
      const res = await fetchWithAuth(`${API_BASE}?${params}`);
      const data = await res.json();
      setDocs(data.docs || []);
      setTotalDocs2(data.total ?? 0);
      setHasMore(data.hasMore ?? false);
    } catch (err) {
      logger.error('Failed to load docs:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, currentPage]);

  // Load embedding statuses for all docs
  const loadEmbeddingStatuses = useCallback(async (docIds: string[]) => {
    const results: Record<string, EmbeddingStatus> = {};
    await Promise.all(
      docIds.map(async (id) => {
        try {
          const res = await fetchWithAuth(`${API_BASE}/${id}/embedding-status`);
          if (res.ok) {
            results[id] = await res.json();
          }
        } catch (e) {
          // ignore individual failures
        }
      })
    );
    setEmbeddingStatuses(prev => ({ ...prev, ...results }));
  }, []);

  const handleRetryEmbedding = async (docId: string) => {
    setRetryingIds(prev => new Set(prev).add(docId));
    try {
      const res = await fetchWithAuth(`${API_BASE}/${docId}/retry-embedding`, {
        method: 'POST',
      });
      if (res.ok) {
        // Wait a bit then refresh status
        setTimeout(async () => {
          await loadEmbeddingStatuses([docId]);
          setRetryingIds(prev => {
            const next = new Set(prev);
            next.delete(docId);
            return next;
          });
        }, 3000);
      } else {
        setRetryingIds(prev => {
          const next = new Set(prev);
          next.delete(docId);
          return next;
        });
      }
    } catch (err) {
      logger.error('Retry embedding failed:', err);
      setRetryingIds(prev => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
    }
  };

  const loadCategories = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/categories`);
      const data = await res.json();
      setCategories(data.categories || []);
    } catch (err) {
      logger.error('Failed to load categories:', err);
    }
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCategory]);

  useEffect(() => {
    loadDocs();
    loadCategories();
  }, [loadDocs, loadCategories]);

  // Load embedding statuses when docs change
  useEffect(() => {
    if (docs.length > 0) {
      loadEmbeddingStatuses(docs.map(d => d.id));
    }
  }, [docs, loadEmbeddingStatuses]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadDocs();
      return;
    }
    try {
      setLoading(true);
      const res = await fetchWithAuth(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, category: selectedCategory }),
      });
      const data = await res.json();
      setDocs(data.docs || []);
    } catch (err) {
      logger.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleUploadFile = async () => {
    if (!uploadFile) return;
    setUploadProgress(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('title', uploadTitle || uploadFile.name);
      formData.append('description', uploadDesc);
      formData.append('category', uploadCategory);
      formData.append('tags', uploadTags);
      formData.append('scope', uploadScope);
      formData.append('priority', String(uploadPriority));
      formData.append('enabled', uploadEnabled ? '1' : '0');

      const token = localStorage.getItem('rangerai_token');
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (res.ok) {
        setShowUpload(false);
        resetUploadForm();
        loadDocs();
        loadCategories();
        toast.success(t('kb.uploadSuccess'));
      } else {
        toast.error(t('kb.uploadFailed'));
      }
    } catch (err) {
      logger.error('Upload failed:', err);
      toast.error(t('kb.uploadFailed'));
    } finally {
      setUploadProgress(false);
    }
  };

  const handleAddText = async () => {
    if (!uploadTitle.trim()) return;
    setUploadProgress(true);
    try {
      const res = await fetchWithAuth(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: uploadTitle,
          description: uploadDesc,
          category: uploadCategory,
          tags: uploadTags,
          content: textContent,
          scope: uploadScope,
          priority: uploadPriority,
          enabled: uploadEnabled,
        }),
      });
      if (res.ok) {
        setShowTextEntry(false);
        resetUploadForm();
        loadDocs();
        loadCategories();
        toast.success(t('kb.addTextSuccess'));
      } else {
        toast.error(t('kb.addTextFailed'));
      }
    } catch (err) {
      logger.error('Add text failed:', err);
      toast.error(t('kb.addTextFailed'));
    } finally {
      setUploadProgress(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('kb.deleteConfirm'))) return;
    try {
      await fetchWithAuth(`${API_BASE}/${id}`, { method: 'DELETE' });
      loadDocs();
      loadCategories();
      if (selectedDoc?.id === id) setSelectedDoc(null);
      toast.success(t('kb.deleteSuccess'));
    } catch (err) {
      logger.error('Delete failed:', err);
      toast.error(t('kb.deleteFailed'));
    }
  };

  const resetUploadForm = () => {
    setUploadTitle('');
    setUploadDesc('');
    setUploadCategory('未分类');
    setUploadTags('');
    setUploadFile(null);
    setTextContent('');
    setIsCustomCategory(false);
    setCustomCategoryInput('');
    setTagChips([]);
    setTagInput('');
    setUploadScope('general');
    setUploadPriority(50);
    setUploadEnabled(true);
  };

  // Sync tagChips to uploadTags string
  useEffect(() => {
    setUploadTags(tagChips.join(','));
  }, [tagChips]);

  const handleAddTag = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !tagChips.includes(trimmed)) {
      setTagChips(prev => [...prev, trimmed]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    setTagChips(prev => prev.filter(t => t !== tag));
  };

  const handleCategoryChange = (value: string) => {
    if (value === '__custom__') {
      setIsCustomCategory(true);
      setUploadCategory('');
      setCustomCategoryInput('');
      setTimeout(() => customCatInputRef.current?.focus(), 50);
    } else {
      setIsCustomCategory(false);
      setUploadCategory(value);
    }
  };

  const handleCustomCategoryConfirm = () => {
    const trimmed = customCategoryInput.trim();
    if (trimmed) {
      setUploadCategory(trimmed);
    } else {
      setIsCustomCategory(false);
      setUploadCategory('未分类');
    }
  };

  // Collect custom categories from server data
  const customCategoriesFromServer = categories
    .map(c => c.category)
    .filter(cat => !PRESET_CATEGORIES_SERVER.includes(cat));

  const totalDocs = categories.reduce((sum, c) => sum + c.count, 0);

  const getCategoryColor = (cat: string) => CATEGORY_COLORS[cat] || CATEGORY_COLORS['未分类'];

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0f] text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10">
        <div className="flex items-center gap-2 sm:gap-3">
          <button onClick={() => setLocation('/')} className="p-1.5 sm:p-2 hover:bg-white/10 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <FolderOpen className="w-5 h-5 sm:w-6 sm:h-6 text-blue-400" />
          <h1 className="text-lg sm:text-xl font-semibold">{t('kb.title')}</h1>
          <span className="text-xs sm:text-sm text-white/40 ml-1 sm:ml-2">{totalDocs2 || totalDocs} {t('kb.docCount')}</span>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Mobile category toggle */}
          <button
            onClick={() => setShowMobileCategories(!showMobileCategories)}
            className="sm:hidden p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <button
            onClick={() => { setShowTextEntry(true); setShowUpload(false); }}
            className="hidden sm:flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg transition-colors text-sm"
          >
            <Plus className="w-4 h-4" />
            {t('kb.addKnowledge')}
          </button>
          <button
            onClick={() => setLocation('/search-debug')}
            className="hidden sm:flex items-center gap-2 px-3 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 rounded-lg transition-colors text-sm border border-purple-500/20"
          >
            <BarChart3 className="w-4 h-4" />
            {t('kb.searchDebug')}
          </button>
          <button
            onClick={() => { setShowUpload(true); setShowTextEntry(false); }}
            className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors text-xs sm:text-sm"
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">{t('kb.uploadFile')}</span>
            <span className="sm:hidden">{t('kb.upload')}</span>
          </button>
        </div>
      </div>

      {/* Mobile categories — horizontal scroll */}
      <div className="sm:hidden overflow-x-auto border-b border-white/10 scrollbar-hide">
        <div className="flex items-center gap-1.5 px-4 py-2.5 min-w-max">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs transition-colors ${
              !selectedCategory ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/60'
            }`}
          >
            {t('kb.all')} ({totalDocs})
          </button>
          {PRESET_CATEGORIES_SERVER.map(cat => {
            const catData = categories.find(c => c.category === cat);
            const count = catData?.count || 0;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs transition-colors ${
                  selectedCategory === cat ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/60'
                }`}
              >
                {getCatLabel(cat)} {count > 0 && `(${count})`}
              </button>
            );
          })}
          {customCategoriesFromServer.map(cat => {
            const catData = categories.find(c => c.category === cat);
            const count = catData?.count || 0;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs transition-colors ${
                  selectedCategory === cat ? 'bg-blue-600 text-white' : 'bg-white/5 text-white/60'
                }`}
              >
                {fixDoubleUtf8(cat)} {count > 0 && `(${count})`}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mobile action buttons */}
      <div className="sm:hidden flex items-center gap-2 px-4 py-2 border-b border-white/10">
        <button
          onClick={() => { setShowTextEntry(true); setShowUpload(false); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/15 rounded-lg transition-colors text-xs flex-1 justify-center"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('kb.addKnowledge')}
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — Categories (desktop only) */}
        <div className="hidden sm:block w-56 border-r border-white/10 p-4 overflow-y-auto">
          <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">{t('kb.categories')}</h3>
          <button
            onClick={() => setSelectedCategory(null)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors ${
              !selectedCategory ? 'bg-blue-600/20 text-blue-400' : 'hover:bg-white/5 text-white/70'
            }`}
          >
            {t('kb.all')} ({totalDocs})
          </button>
          {PRESET_CATEGORIES_SERVER.map(cat => {
            const catData = categories.find(c => c.category === cat);
            const count = catData?.count || 0;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors ${
                  selectedCategory === cat ? 'bg-blue-600/20 text-blue-400' : 'hover:bg-white/5 text-white/70'
                }`}
              >
                {getCatLabel(cat)} {count > 0 && <span className="text-white/30 ml-1">({count})</span>}
              </button>
            );
          })}
          {customCategoriesFromServer.map(cat => {
            const catData = categories.find(c => c.category === cat);
            const count = catData?.count || 0;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 transition-colors ${
                  selectedCategory === cat ? 'bg-blue-600/20 text-blue-400' : 'hover:bg-white/5 text-white/70'
                }`}
              >
                <span className="flex items-center gap-1">
                  <Tag className="w-3 h-3" />
                  {fixDoubleUtf8(cat)}
                </span>
                {count > 0 && <span className="text-white/30 ml-1">({count})</span>}
              </button>
            );
          })}
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Search bar */}
          <div className="px-4 sm:px-6 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
                <input
                  type="text"
                  placeholder={t('kb.searchPlaceholder')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  className="w-full pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-white/30 focus:outline-none focus:border-blue-500/50"
                />
              </div>
              <button onClick={handleSearch} className="px-3 sm:px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-xs sm:text-sm transition-colors">
                {t('kb.search')}
              </button>
            </div>
          </div>

          {/* Document list */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {loading ? (
              <div className="grid gap-3">
                {[1,2,3,4,5].map(i => (
                  <div key={i} className="flex items-start gap-4 p-4 rounded-xl border border-white/5 bg-white/[0.02] animate-pulse">
                    <div className="w-5 h-5 rounded bg-white/10 mt-1 flex-shrink-0" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-white/10 rounded w-3/4" />
                      <div className="h-3 bg-white/5 rounded w-1/2" />
                      <div className="flex gap-2 mt-2">
                        <div className="h-5 bg-white/5 rounded w-16" />
                        <div className="h-5 bg-white/5 rounded w-12" />
                        <div className="h-5 bg-white/5 rounded w-20" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : docs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 sm:py-20">
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center mb-6">
                  <FolderOpen className="w-8 h-8 sm:w-10 sm:h-10 text-blue-400" />
                </div>
                <h3 className="text-lg sm:text-xl font-semibold text-white/80 mb-2">{t('kb.emptyTitle')}</h3>
                <p className="text-sm text-white/40 mb-8 text-center max-w-md px-4">
                  {t('kb.emptyDesc')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 w-full max-w-lg px-4">
                  <button
                    onClick={() => { setShowUpload(true); setShowTextEntry(false); }}
                    className="flex flex-col items-center gap-2 p-4 sm:p-5 rounded-xl border border-dashed border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 hover:border-blue-500/50 transition-all group"
                  >
                    <Upload className="w-6 h-6 text-blue-400 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium text-white/70">{t('kb.emptyUploadFile')}</span>
                    <span className="text-[10px] text-white/30">{t('kb.emptyUploadHint')}</span>
                  </button>
                  <button
                    onClick={() => { setShowTextEntry(true); setShowUpload(false); }}
                    className="flex flex-col items-center gap-2 p-4 sm:p-5 rounded-xl border border-dashed border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/50 transition-all group"
                  >
                    <Plus className="w-6 h-6 text-emerald-400 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium text-white/70">{t('kb.emptyAddText')}</span>
                    <span className="text-[10px] text-white/30">{t('kb.emptyAddTextHint')}</span>
                  </button>
                  <button
                    onClick={() => setLocation('/')}
                    className="flex flex-col items-center gap-2 p-4 sm:p-5 rounded-xl border border-dashed border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20 transition-all group"
                  >
                    <Eye className="w-6 h-6 text-white/40 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium text-white/70">{t('kb.emptyBrowse')}</span>
                    <span className="text-[10px] text-white/30">{t('kb.emptyBrowseHint')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
              <div className="grid gap-3">
                {docs.map(doc => (
                  <div
                    key={doc.id}
                    onClick={() => setSelectedDoc(doc)}
                    className={`group flex items-start gap-3 sm:gap-4 p-3 sm:p-4 rounded-xl border transition-all cursor-pointer ${
                      selectedDoc?.id === doc.id
                        ? 'border-blue-500/50 bg-blue-500/5'
                        : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10'
                    }`}
                  >
                    <div className="mt-0.5 sm:mt-1 flex-shrink-0">{getFileIcon(doc.mimeType)}</div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-white/90 truncate text-sm sm:text-base">{fixDoubleUtf8(doc.title)}</h4>
                      {doc.description && (
                        <p className="text-xs sm:text-sm text-white/40 mt-1 line-clamp-2">{doc.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2 text-xs text-white/30">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] sm:text-xs ${getCatColor(doc.category)}`}>
                          {fixDoubleUtf8(getCatLabel(doc.category))}
                        </span>
                        <span className="flex items-center gap-1">
                          <HardDrive className="w-3 h-3" /> {fmtSize(doc.fileSize)}
                        </span>
                        <span className="hidden sm:flex items-center gap-1">
                          <Calendar className="w-3 h-3" /> {fmtDate(doc.createdAt)}
                        </span>
                        {/* RRF score display */}
                        {doc.score !== undefined && (
                          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/15 text-[10px] whitespace-nowrap">
                            <Zap className="w-2.5 h-2.5" />
                            <span>RRF {(doc.score * 100).toFixed(1)}</span>
                          </span>
                        )}
                        {/* Source channel tags (fts / vector / fts+vector) */}
                        {doc.sources && doc.sources.length > 0 && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-[10px] text-white/40 whitespace-nowrap">
                            <Tag className="w-2.5 h-2.5" />
                            <span>{doc.sources.join('+')}</span>
                          </span>
                        )}
                        {/* v26.0: Scope badge */}
                        {doc.scope && doc.scope !== 'general' && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${getScopeOption(doc.scope).color}`}>
                            {getScopeOption(doc.scope).label}
                          </span>
                        )}
                        {doc.enabled === 0 && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 text-[10px]">
                            已禁用
                          </span>
                        )}
                        {/* Embedding status indicator */}
                        {embeddingStatuses[doc.id] && (
                          embeddingStatuses[doc.id].hasEmbeddings ? (
                            <span className="flex items-center gap-1 text-emerald-400/70">
                              <Zap className="w-3 h-3" />
                              <span className="text-[10px]">{embeddingStatuses[doc.id].embeddingCount} chunks</span>
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <AlertCircle className="w-3 h-3 text-amber-400/70" />
                              <span className="text-[10px] text-amber-400/70">{t('kb.notVectorized')}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRetryEmbedding(doc.id); }}
                                disabled={retryingIds.has(doc.id)}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-[10px] transition-colors disabled:opacity-50"
                              >
                                {retryingIds.has(doc.id) ? (
                                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-2.5 h-2.5" />
                                )}
                                {t('kb.retry')}
                              </button>
                            </span>
                          )
                        )}
                      </div>
                      {doc.tags && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {doc.tags.split(',').slice(0, 3).map((tag, i) => (
                            <span key={i} className="px-1.5 sm:px-2 py-0.5 bg-white/5 rounded text-[10px] sm:text-xs text-white/40">
                              {tag.trim()}
                            </span>
                          ))}
                          {doc.tags.split(',').length > 3 && (
                            <span className="px-1.5 py-0.5 text-[10px] sm:text-xs text-white/30">
                              +{doc.tags.split(',').length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(doc.id); }}
                        className="p-1.5 sm:p-2 opacity-0 group-hover:opacity-100 hover:bg-red-500/10 rounded-lg transition-all text-white/20 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-white/20 sm:hidden" />
                    </div>
                  </div>
                ))}
              </div>
              {/* Pagination */}
              {totalDocs2 > PAGE_SIZE && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/10">
                  <div className="text-xs text-white/40">
                    {t('kb.showing')} {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, totalDocs2)} / {t('kb.total')} {totalDocs2} {t('kb.docs')}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="flex items-center gap-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      {t('kb.prevPage')}
                    </button>
                    <span className="text-xs text-white/60 px-2">
                      {currentPage} / {Math.ceil(totalDocs2 / PAGE_SIZE)}
                    </span>
                    <button
                      onClick={() => setCurrentPage(p => p + 1)}
                      disabled={!hasMore}
                      className="flex items-center gap-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {t('kb.nextPage')}
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>
        </div>

        {/* Right panel — Document preview (desktop only) */}
        {selectedDoc && (
          <div className="hidden md:flex w-96 border-l border-white/10 flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <h3 className="font-medium truncate">{fixDoubleUtf8(selectedDoc.title)}</h3>
              <button onClick={() => setSelectedDoc(null)} className="p-1 hover:bg-white/10 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-white/40 uppercase">{t('kb.category')}</label>
                  <p className="text-sm mt-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs ${getCatColor(selectedDoc.category)}`}>
                      {fixDoubleUtf8(getCatLabel(selectedDoc.category))}
                    </span>
                  </p>
                </div>
                {selectedDoc.description && (
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.description')}</label>
                    <p className="text-sm mt-1 text-white/70">{selectedDoc.description}</p>
                  </div>
                )}
                {selectedDoc.fileName && (
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.fileName')}</label>
                    <p className="text-sm mt-1 text-white/70 break-all">{fixDoubleUtf8(selectedDoc.fileName || '')}</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.size')}</label>
                    <p className="text-sm mt-1 text-white/70">{fmtSize(selectedDoc.fileSize)}</p>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.createdAt')}</label>
                    <p className="text-sm mt-1 text-white/70">{fmtDate(selectedDoc.createdAt)}</p>
                  </div>
                </div>
                {/* v26.0: Scope, Priority, Enabled display */}
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-white/40 uppercase">作用域</label>
                    <p className="mt-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs ${getScopeOption(selectedDoc.scope || 'general').color}`}>
                        {getScopeOption(selectedDoc.scope || 'general').label}
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 uppercase">优先级</label>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${selectedDoc.priority ?? 50}%` }} />
                      </div>
                      <span className="text-xs text-white/60">{selectedDoc.priority ?? 50}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 uppercase">状态</label>
                    <p className="mt-1">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                        (selectedDoc.enabled !== 0) ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                      }`}>
                        {(selectedDoc.enabled !== 0) ? '✓ 已启用' : '✗ 已禁用'}
                      </span>
                    </p>
                  </div>
                </div>
                {/* Embedding status in detail panel */}
                {embeddingStatuses[selectedDoc.id] && (
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.embeddingStatus')}</label>
                    <div className="mt-2 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
                      {embeddingStatuses[selectedDoc.id].hasEmbeddings ? (
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          <div>
                            <p className="text-sm text-emerald-400">已向量化</p>
                            <p className="text-[11px] text-white/40 mt-0.5">
                              {embeddingStatuses[selectedDoc.id].embeddingCount} 个向量块 · 内容长度 {embeddingStatuses[selectedDoc.id].contentLength} 字符
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-amber-400" />
                            <div>
                              <p className="text-sm text-amber-400">未向量化</p>
                              <p className="text-[11px] text-white/40 mt-0.5">该文档无法被语义搜索命中</p>
                            </div>
                          </div>
                          <button
                            onClick={() => handleRetryEmbedding(selectedDoc.id)}
                            disabled={retryingIds.has(selectedDoc.id)}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-xs transition-colors disabled:opacity-50"
                          >
                            {retryingIds.has(selectedDoc.id) ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5" />
                            )}
                            重新生成
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {selectedDoc.content && (
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.contentPreview')}</label>
                    <pre className="mt-2 p-3 bg-white/5 rounded-lg text-xs text-white/60 whitespace-pre-wrap max-h-96 overflow-y-auto break-all">
                      {selectedDoc.content.slice(0, 3000)}
                      {selectedDoc.content.length > 3000 && `\n\n${t('kb.contentTruncated')}`}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile document detail overlay */}
      {selectedDoc && (
        <div className="md:hidden fixed inset-0 bg-[#0a0a0f] z-50 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2 min-w-0">
              {getFileIcon(selectedDoc.mimeType)}
              <h3 className="font-medium truncate text-sm">{fixDoubleUtf8(selectedDoc.title)}</h3>
            </div>
            <button onClick={() => setSelectedDoc(null)} className="p-2 hover:bg-white/10 rounded-lg flex-shrink-0">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs ${getCatColor(selectedDoc.category)}`}>
                  {fixDoubleUtf8(getCatLabel(selectedDoc.category))}
                </span>
                {selectedDoc.tags && selectedDoc.tags.split(',').map((tag, i) => (
                  <span key={i} className="px-2 py-0.5 bg-white/5 rounded text-xs text-white/40">
                    {tag.trim()}
                  </span>
                ))}
              </div>
              {selectedDoc.description && (
                <div>
                  <label className="text-xs text-white/40 uppercase">{t('kb.description')}</label>
                  <p className="text-sm mt-1 text-white/70">{selectedDoc.description}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {selectedDoc.fileName && (
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('kb.fileName')}</label>
                    <p className="text-xs mt-1 text-white/70 break-all">{fixDoubleUtf8(selectedDoc.fileName || '')}</p>
                  </div>
                )}
                <div>
                  <label className="text-xs text-white/40 uppercase">{t('kb.size')}</label>
                  <p className="text-xs mt-1 text-white/70">{fmtSize(selectedDoc.fileSize)}</p>
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase">{t('kb.createdAt')}</label>
                  <p className="text-xs mt-1 text-white/70">{fmtDate(selectedDoc.createdAt)}</p>
                </div>
              </div>
              {selectedDoc.content && (
                <div>
                  <label className="text-xs text-white/40 uppercase">{t('kb.contentPreview')}</label>
                  <pre className="mt-2 p-3 bg-white/5 rounded-lg text-xs text-white/60 whitespace-pre-wrap overflow-x-auto break-all">
                    {selectedDoc.content.slice(0, 3000)}
                    {selectedDoc.content.length > 3000 && `\n\n${t('kb.contentTruncated')}`}
                  </pre>
                </div>
              )}
            </div>
          </div>
          <div className="p-4 border-t border-white/10">
            <button
              onClick={() => { handleDelete(selectedDoc.id); }}
              className="w-full py-2.5 bg-red-600/10 text-red-400 rounded-lg text-sm hover:bg-red-600/20 transition-colors"
            >
              {t('kb.deleteDoc')}
            </button>
          </div>
        </div>
      )}

      {/* Upload file modal */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50" onClick={() => setShowUpload(false)}>
          <div
            className="bg-[#1a1a2e] rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 w-full sm:w-[500px] max-h-[85vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{t('kb.uploadFileTitle')}</h2>
              <button onClick={() => { setShowUpload(false); resetUploadForm(); }} className="p-1 hover:bg-white/10 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-white/60 mb-1">{t('kb.selectFile')}</label>
                <input
                  type="file"
                  accept=".txt,.md,.json,.csv,.pdf,.docx"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setUploadFile(f);
                      if (!uploadTitle) setUploadTitle(f.name);
                    }
                  }}
                  className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-600 file:text-white file:cursor-pointer"
                />
                <p className="text-[10px] text-white/30 mt-1">{t('kb.supportedFormats')}</p>
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">{t('kb.titleLabel')}</label>
                <input
                  type="text"
                  value={uploadTitle}
                  onChange={e => setUploadTitle(e.target.value)}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-blue-500/50"
                />
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">{t('kb.descLabel')}</label>
                <textarea
                  value={uploadDesc}
                  onChange={e => setUploadDesc(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-blue-500/50 resize-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-white/60 mb-1">{t('kb.categoryLabel')}</label>
                  {isCustomCategory ? (
                    <div className="flex gap-2">
                      <input
                        ref={customCatInputRef}
                        type="text"
                        value={customCategoryInput}
                        onChange={e => setCustomCategoryInput(e.target.value)}
                        onBlur={handleCustomCategoryConfirm}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCustomCategoryConfirm(); } }}
                        placeholder={t('kb.customCategoryPlaceholder')}
                        className="flex-1 px-3 py-2.5 bg-white/5 border border-blue-500/50 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500/70"
                      />
                      <button
                        type="button"
                        onClick={() => { setIsCustomCategory(false); setUploadCategory('未分类'); }}
                        className="px-2 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <select
                      value={uploadCategory}
                      onChange={e => handleCategoryChange(e.target.value)}
                      className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-medium focus:outline-none focus:border-blue-500/50 [&>option]:bg-zinc-800 [&>option]:text-white [&>option]:py-1"
                    >
                      {PRESET_CATEGORIES_SERVER.map(cat => (
                        <option key={cat} value={cat}>{getCatLabel(cat)}</option>
                      ))}
                      {customCategoriesFromServer.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                      <option value="__custom__">➕ {t('kb.customCategory')}</option>
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-white/60 mb-1">{t('kb.tagsLabel')}</label>
                  <div className="flex flex-wrap gap-1.5 p-2 bg-white/5 border border-white/10 rounded-lg min-h-[42px] focus-within:border-blue-500/50 transition-colors">
                    {tagChips.map(tag => (
                      <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 text-blue-400 border border-blue-500/20 rounded text-xs">
                        {tag}
                        <button type="button" onClick={() => handleRemoveTag(tag)} className="hover:text-blue-200 transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      ref={tagInputRef}
                      type="text"
                      value={tagInput}
                      onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          handleAddTag(tagInput);
                        } else if (e.key === 'Backspace' && !tagInput && tagChips.length > 0) {
                          handleRemoveTag(tagChips[tagChips.length - 1]);
                        }
                      }}
                      onBlur={() => { if (tagInput.trim()) handleAddTag(tagInput); }}
                      placeholder={tagChips.length === 0 ? t('kb.tagInputPlaceholder') : ''}
                      className="flex-1 min-w-[80px] bg-transparent text-sm text-white outline-none placeholder-white/30"
                    />
                  </div>
                  <p className="text-[10px] text-white/30 mt-1">{t('kb.tagInputHint')}</p>
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => { setShowUpload(false); resetUploadForm(); }} className="flex-1 sm:flex-none px-4 py-2.5 bg-white/10 hover:bg-white/15 rounded-lg text-sm">
                {t('kb.cancel')}
              </button>
              <button
                onClick={handleUploadFile}
                disabled={!uploadFile || uploadProgress}
                className="flex-1 sm:flex-none px-4 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploadProgress ? t('kb.uploading') : t('kb.upload')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add text knowledge modal */}
      {showTextEntry && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50" onClick={() => setShowTextEntry(false)}>
          <div
            className="bg-[#1a1a2e] rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 w-full sm:w-[600px] max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{t('kb.addKnowledgeEntry')}</h2>
              <button onClick={() => { setShowTextEntry(false); resetUploadForm(); }} className="p-1 hover:bg-white/10 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-white/60 mb-1">{t('kb.titleRequired')}</label>
                <input
                  type="text"
                  value={uploadTitle}
                  onChange={e => setUploadTitle(e.target.value)}
                  placeholder={t('kb.titlePlaceholder')}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-blue-500/50"
                />
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">{t('kb.descLabel')}</label>
                <textarea
                  value={uploadDesc}
                  onChange={e => setUploadDesc(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-blue-500/50 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">{t('kb.contentLabel')}</label>
                <textarea
                  value={textContent}
                  onChange={e => setTextContent(e.target.value)}
                  rows={6}
                  placeholder={t('kb.contentPlaceholder')}
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-blue-500/50 resize-none font-mono"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-white/60 mb-1">{t('kb.categoryLabel')}</label>
                  {isCustomCategory ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={customCategoryInput}
                        onChange={e => setCustomCategoryInput(e.target.value)}
                        onBlur={handleCustomCategoryConfirm}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCustomCategoryConfirm(); } }}
                        placeholder={t('kb.customCategoryPlaceholder')}
                        autoFocus
                        className="flex-1 px-3 py-2.5 bg-white/5 border border-blue-500/50 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500/70"
                      />
                      <button
                        type="button"
                        onClick={() => { setIsCustomCategory(false); setUploadCategory('未分类'); }}
                        className="px-2 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <select
                      value={uploadCategory}
                      onChange={e => handleCategoryChange(e.target.value)}
                      className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-medium focus:outline-none focus:border-blue-500/50 [&>option]:bg-zinc-800 [&>option]:text-white [&>option]:py-1"
                    >
                      {PRESET_CATEGORIES_SERVER.map(cat => (
                        <option key={cat} value={cat}>{getCatLabel(cat)}</option>
                      ))}
                      {customCategoriesFromServer.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                      <option value="__custom__">➕ {t('kb.customCategory')}</option>
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-white/60 mb-1">{t('kb.tagsLabel')}</label>
                  <div className="flex flex-wrap gap-1.5 p-2 bg-white/5 border border-white/10 rounded-lg min-h-[42px] focus-within:border-blue-500/50 transition-colors">
                    {tagChips.map(tag => (
                      <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 text-blue-400 border border-blue-500/20 rounded text-xs">
                        {tag}
                        <button type="button" onClick={() => handleRemoveTag(tag)} className="hover:text-blue-200 transition-colors">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={tagInput}
                      onChange={e => setTagInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          handleAddTag(tagInput);
                        } else if (e.key === 'Backspace' && !tagInput && tagChips.length > 0) {
                          handleRemoveTag(tagChips[tagChips.length - 1]);
                        }
                      }}
                      onBlur={() => { if (tagInput.trim()) handleAddTag(tagInput); }}
                      placeholder={tagChips.length === 0 ? t('kb.tagInputPlaceholder') : ''}
                      className="flex-1 min-w-[80px] bg-transparent text-sm text-white outline-none placeholder-white/30"
                    />
                  </div>
                  <p className="text-[10px] text-white/30 mt-1">{t('kb.tagInputHint')}</p>
                </div>
              </div>
              {/* v26.0: Scope, Priority, Enabled fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm text-white/60 mb-1">作用域 (Scope)</label>
                  <select
                    value={uploadScope}
                    onChange={e => setUploadScope(e.target.value)}
                    className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-600 rounded-lg text-sm text-white font-medium focus:outline-none focus:border-blue-500/50 [&>option]:bg-zinc-800 [&>option]:text-white"
                  >
                    {SCOPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-white/30 mt-1">决定哪类问题能检索到这条知识</p>
                </div>
                <div>
                  <label className="block text-sm text-white/60 mb-1">优先级 (Priority)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="1"
                      max="100"
                      value={uploadPriority}
                      onChange={e => setUploadPriority(Number(e.target.value))}
                      className="flex-1 accent-blue-500"
                    />
                    <span className="text-sm text-white/70 w-8 text-right">{uploadPriority}</span>
                  </div>
                  <p className="text-[10px] text-white/30 mt-1">数值越高，注入时排序越靠前</p>
                </div>
                <div>
                  <label className="block text-sm text-white/60 mb-1">启用状态</label>
                  <button
                    type="button"
                    onClick={() => setUploadEnabled(!uploadEnabled)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                      uploadEnabled
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                        : 'bg-white/5 border-white/10 text-white/40'
                    }`}
                  >
                    <div className={`w-8 h-4 rounded-full relative transition-colors ${uploadEnabled ? 'bg-emerald-500' : 'bg-white/20'}`}>
                      <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${uploadEnabled ? 'left-4' : 'left-0.5'}`} />
                    </div>
                    {uploadEnabled ? '已启用' : '已禁用'}
                  </button>
                  <p className="text-[10px] text-white/30 mt-1">禁用后不会被检索注入</p>
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button onClick={() => { setShowTextEntry(false); resetUploadForm(); }} className="flex-1 sm:flex-none px-4 py-2.5 bg-white/10 hover:bg-white/15 rounded-lg text-sm">
                {t('kb.cancel')}
              </button>
              <button
                onClick={handleAddText}
                disabled={!uploadTitle.trim() || uploadProgress}
                className="flex-1 sm:flex-none px-4 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploadProgress ? t('kb.saving') : t('kb.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
