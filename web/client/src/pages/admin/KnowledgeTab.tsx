import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen, Plus, Search, Edit2, Trash2, Save, X, Tag,
  ChevronLeft, ChevronRight, ToggleLeft, ToggleRight, Star
} from 'lucide-react';

interface KnowledgeEntry {
  id: number;
  category: string;
  title: string;
  content: string;
  tags: string;
  priority: number;
  active: number;
  source: string;
  created_at: string;
  updated_at: string;
}

const CATEGORIES = [
  { value: 'general', label: 'General', color: 'bg-gray-500' },
  { value: 'system', label: 'System', color: 'bg-blue-500' },
  { value: 'capability', label: 'Capability', color: 'bg-purple-500' },
  { value: 'workflow', label: 'Workflow', color: 'bg-green-500' },
  { value: 'domain', label: 'Domain', color: 'bg-orange-500' },
  { value: 'policy', label: 'Policy', color: 'bg-red-500' },
];

function getCategoryColor(cat: string) {
  return CATEGORIES.find(c => c.value === cat)?.color || 'bg-gray-500';
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  }
}

const fetchAdmin = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, {
    ...options,
    headers: { 'X-Internal-Call': '1', 'Content-Type': 'application/json', ...options?.headers },
  });
  return res.json();
};

export default function KnowledgeTab() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterActive, setFilterActive] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<KnowledgeEntry>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ category: 'general', title: '', content: '', tags: '', priority: 5 });

  const pageSize = 10;

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (searchQuery) params.set('q', searchQuery);
      if (filterCategory) params.set('category', filterCategory);
      if (filterActive !== '') params.set('active', filterActive);
      const data = await fetchAdmin(`/api/admin/knowledge?${params}`);
      setEntries(data.entries || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Failed to load knowledge entries:', err);
    } finally {
      setLoading(false);
    }
  }, [page, searchQuery, filterCategory, filterActive]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const handleCreate = async () => {
    if (!createForm.title || !createForm.content) return;
    try {
      await fetchAdmin('/api/admin/knowledge', {
        method: 'POST',
        body: JSON.stringify(createForm),
      });
      setShowCreate(false);
      setCreateForm({ category: 'general', title: '', content: '', tags: '', priority: 5 });
      loadEntries();
    } catch (err) {
      console.error('Failed to create entry:', err);
    }
  };

  const handleUpdate = async (id: number) => {
    try {
      await fetchAdmin(`/api/admin/knowledge/${id}`, {
        method: 'PUT',
        body: JSON.stringify(editForm),
      });
      setEditingId(null);
      setEditForm({});
      loadEntries();
    } catch (err) {
      console.error('Failed to update entry:', err);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this knowledge entry?')) return;
    try {
      await fetchAdmin(`/api/admin/knowledge/${id}`, { method: 'DELETE' });
      loadEntries();
    } catch (err) {
      console.error('Failed to delete entry:', err);
    }
  };

  const handleToggleActive = async (entry: KnowledgeEntry) => {
    try {
      await fetchAdmin(`/api/admin/knowledge/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: entry.active ? 0 : 1 }),
      });
      loadEntries();
    } catch (err) {
      console.error('Failed to toggle entry:', err);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Knowledge Base</h2>
          <span className="text-xs text-zinc-500">({total} entries)</span>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Entry
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="bg-zinc-800/60 border border-zinc-700 rounded-lg p-4 space-y-3">
          <div className="flex gap-3">
            <select
              value={createForm.category}
              onChange={e => setCreateForm(f => ({ ...f, category: e.target.value }))}
              className="bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
            >
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input
              placeholder="Title"
              value={createForm.title}
              onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
              className="flex-1 bg-zinc-700 text-white text-sm rounded px-3 py-1 border border-zinc-600"
            />
            <input
              type="number"
              min={1}
              max={10}
              value={createForm.priority}
              onChange={e => setCreateForm(f => ({ ...f, priority: parseInt(e.target.value) || 5 }))}
              className="w-16 bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
              title="Priority (1-10)"
            />
          </div>
          <textarea
            placeholder="Content (knowledge to inject into agent context)"
            value={createForm.content}
            onChange={e => setCreateForm(f => ({ ...f, content: e.target.value }))}
            rows={3}
            className="w-full bg-zinc-700 text-white text-sm rounded px-3 py-2 border border-zinc-600"
          />
          <div className="flex gap-3 items-center">
            <input
              placeholder='Tags (comma-separated, e.g. "browser,automation")'
              value={createForm.tags}
              onChange={e => setCreateForm(f => ({ ...f, tags: e.target.value }))}
              className="flex-1 bg-zinc-700 text-white text-sm rounded px-3 py-1 border border-zinc-600"
            />
            <button onClick={handleCreate} className="flex items-center gap-1 px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-sm rounded transition-colors">
              <Save className="w-3 h-3" /> Save
            </button>
            <button onClick={() => setShowCreate(false)} className="flex items-center gap-1 px-3 py-1 bg-zinc-600 hover:bg-zinc-500 text-white text-sm rounded transition-colors">
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            placeholder="Search knowledge..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
            className="w-full bg-zinc-800 text-white text-sm rounded-lg pl-9 pr-3 py-2 border border-zinc-700"
          />
        </div>
        <select
          value={filterCategory}
          onChange={e => { setFilterCategory(e.target.value); setPage(1); }}
          className="bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 border border-zinc-700"
        >
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select
          value={filterActive}
          onChange={e => { setFilterActive(e.target.value); setPage(1); }}
          className="bg-zinc-800 text-white text-sm rounded-lg px-3 py-2 border border-zinc-700"
        >
          <option value="">All Status</option>
          <option value="1">Active</option>
          <option value="0">Inactive</option>
        </select>
      </div>

      {/* Entries List */}
      {loading ? (
        <div className="text-center text-zinc-500 py-8">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="text-center text-zinc-500 py-8">No knowledge entries found</div>
      ) : (
        <div className="space-y-2">
          {entries.map(entry => (
            <div key={entry.id} className={`bg-zinc-800/60 border rounded-lg p-3 transition-colors ${entry.active ? 'border-zinc-700' : 'border-zinc-800 opacity-60'}`}>
              {editingId === entry.id ? (
                /* Edit Mode */
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <select
                      value={editForm.category || entry.category}
                      onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                      className="bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
                    >
                      {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                    <input
                      value={editForm.title ?? entry.title}
                      onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                      className="flex-1 bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
                    />
                    <input
                      type="number" min={1} max={10}
                      value={editForm.priority ?? entry.priority}
                      onChange={e => setEditForm(f => ({ ...f, priority: parseInt(e.target.value) || 5 }))}
                      className="w-16 bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
                    />
                  </div>
                  <textarea
                    value={editForm.content ?? entry.content}
                    onChange={e => setEditForm(f => ({ ...f, content: e.target.value }))}
                    rows={3}
                    className="w-full bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
                  />
                  <div className="flex gap-2 items-center">
                    <input
                      value={editForm.tags ?? entry.tags}
                      onChange={e => setEditForm(f => ({ ...f, tags: e.target.value }))}
                      className="flex-1 bg-zinc-700 text-white text-sm rounded px-2 py-1 border border-zinc-600"
                      placeholder="Tags"
                    />
                    <button onClick={() => handleUpdate(entry.id)} className="px-2 py-1 bg-green-600 hover:bg-green-500 text-white text-xs rounded">Save</button>
                    <button onClick={() => { setEditingId(null); setEditForm({}); }} className="px-2 py-1 bg-zinc-600 hover:bg-zinc-500 text-white text-xs rounded">Cancel</button>
                  </div>
                </div>
              ) : (
                /* View Mode */
                <div>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded text-white ${getCategoryColor(entry.category)}`}>
                        {entry.category}
                      </span>
                      <span className="text-sm font-medium text-white">{entry.title}</span>
                      <span className="flex items-center gap-0.5 text-[10px] text-yellow-400">
                        <Star className="w-3 h-3" fill="currentColor" /> {entry.priority}
                      </span>
                      {entry.source === 'seed' && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-400">seed</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                      <button onClick={() => handleToggleActive(entry)} className="p-1 hover:bg-zinc-700 rounded" title={entry.active ? 'Deactivate' : 'Activate'}>
                        {entry.active ? <ToggleRight className="w-4 h-4 text-green-400" /> : <ToggleLeft className="w-4 h-4 text-zinc-500" />}
                      </button>
                      <button onClick={() => { setEditingId(entry.id); setEditForm({}); }} className="p-1 hover:bg-zinc-700 rounded" title="Edit">
                        <Edit2 className="w-3.5 h-3.5 text-zinc-400" />
                      </button>
                      <button onClick={() => handleDelete(entry.id)} className="p-1 hover:bg-zinc-700 rounded" title="Delete">
                        <Trash2 className="w-3.5 h-3.5 text-red-400" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{entry.content}</p>
                  {parseTags(entry.tags).length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {parseTags(entry.tags).map((tag, i) => (
                        <span key={i} className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/80 text-zinc-400">
                          <Tag className="w-2.5 h-2.5" />{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30"
          >
            <ChevronLeft className="w-4 h-4 text-zinc-400" />
          </button>
          <span className="text-xs text-zinc-500">{page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30"
          >
            <ChevronRight className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
      )}
    </div>
  );
}
