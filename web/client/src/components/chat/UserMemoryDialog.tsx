/**
 * UserMemoryDialog — View, edit, and clear the AI agent's persistent memory about the current user.
 * Fetches from GET /api/user/:id/memory, updates via PUT /api/user/:id/memory.
 */
import { useState, useEffect, useCallback } from 'react';
import { Brain, X, Trash2, Save, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { getAuthToken } from '../../lib/api';

interface UserMemoryDialogProps {
  open: boolean;
  onClose: () => void;
  userId: string;
}

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = getAuthToken();
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

const MAX_MEMORY_CHARS = 3000;

export function UserMemoryDialog({ open, onClose, userId }: UserMemoryDialogProps) {
  const [memory, setMemory] = useState('');
  const [originalMemory, setOriginalMemory] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMemory = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/user/${userId}/memory`);
      if (res.ok) {
        const data = await res.json();
        const mem = data.memory || '';
        setMemory(mem);
        setOriginalMemory(mem);
      } else {
        setError('无法加载记忆数据');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (open && userId) {
      loadMemory();
      setEditing(false);
    }
  }, [open, userId, loadMemory]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetchWithAuth(`/api/user/${userId}/memory`, {
        method: 'PUT',
        body: JSON.stringify({ memory }),
      });
      if (res.ok) {
        setOriginalMemory(memory);
        setEditing(false);
        toast.success('记忆已更新');
      } else {
        toast.error('保存失败');
      }
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('确定要清除所有 AI 记忆吗？此操作不可撤销。')) return;
    setSaving(true);
    try {
      const res = await fetchWithAuth(`/api/user/${userId}/memory`, {
        method: 'PUT',
        body: JSON.stringify({ memory: '' }),
      });
      if (res.ok) {
        setMemory('');
        setOriginalMemory('');
        setEditing(false);
        toast.success('记忆已清除');
      } else {
        toast.error('清除失败');
      }
    } catch {
      toast.error('网络错误');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const hasChanges = memory !== originalMemory;
  const charCount = memory.length;
  const charPercent = Math.min((charCount / MAX_MEMORY_CHARS) * 100, 100);
  const isNearLimit = charCount > MAX_MEMORY_CHARS * 0.8;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-[#0f0f18] border border-white/10 rounded-2xl w-full max-w-lg max-h-[80vh] overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500/30 to-pink-500/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-purple-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">AI 记忆</h2>
              <p className="text-[10px] text-white/40">AI 在对话中记住的关于你的信息</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={loadMemory}
              disabled={loading}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-white/40 hover:text-white/70"
              title="刷新"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors">
              <X className="w-4 h-4 text-white/40" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(80vh-140px)]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-purple-400 animate-spin mb-3" />
              <p className="text-sm text-white/40">加载记忆中...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12">
              <AlertCircle className="w-6 h-6 text-red-400 mb-3" />
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={loadMemory}
                className="mt-3 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-xs text-white/60 transition-colors"
              >
                重试
              </button>
            </div>
          ) : !memory && !editing ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500/10 to-pink-500/10 flex items-center justify-center mb-4">
                <Brain className="w-7 h-7 text-purple-400/50" />
              </div>
              <h3 className="text-sm font-medium text-white/60 mb-1">暂无记忆</h3>
              <p className="text-[11px] text-white/30 text-center max-w-xs">
                AI 会在对话过程中自动记住关于你的重要信息，如偏好、习惯和常用数据。
              </p>
            </div>
          ) : (
            <>
              {/* Memory Content */}
              {editing ? (
                <textarea
                  value={memory}
                  onChange={e => setMemory(e.target.value)}
                  className="w-full h-48 px-3 py-2.5 bg-white/5 border border-purple-500/20 rounded-xl text-sm text-white/80 placeholder:text-white/20 focus:outline-none focus:border-purple-500/40 transition-colors resize-none font-mono leading-relaxed"
                  placeholder="AI 记忆内容..."
                />
              ) : (
                <div
                  className="px-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl cursor-pointer hover:bg-white/[0.05] transition-colors"
                  onClick={() => setEditing(true)}
                >
                  <pre className="text-sm text-white/70 whitespace-pre-wrap font-mono leading-relaxed break-words">
                    {memory}
                  </pre>
                  <p className="text-[10px] text-white/20 mt-2 italic">点击编辑</p>
                </div>
              )}

              {/* Capacity Indicator */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-white/30">记忆容量</span>
                  <span className={isNearLimit ? 'text-amber-400' : 'text-white/30'}>
                    {charCount.toLocaleString()} / {MAX_MEMORY_CHARS.toLocaleString()} 字符
                  </span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      isNearLimit ? 'bg-amber-500' : 'bg-purple-500'
                    }`}
                    style={{ width: `${charPercent}%` }}
                  />
                </div>
                {isNearLimit && (
                  <p className="text-[10px] text-amber-400/70">
                    接近容量上限，系统将自动压缩旧记忆
                  </p>
                )}
              </div>

              {/* Info */}
              <div className="bg-purple-500/5 border border-purple-500/15 rounded-lg px-3 py-2">
                <p className="text-[11px] text-purple-300/60 leading-relaxed">
                  AI 会在每次对话后自动提取并更新记忆。你可以手动编辑或清除记忆内容。记忆将在后续对话中作为上下文注入，帮助 AI 更好地理解你的需求。
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {(memory || editing) && !loading && !error && (
          <div className="px-5 py-3 border-t border-white/10 flex items-center justify-between">
            <button
              onClick={handleClear}
              disabled={saving || !originalMemory}
              className="flex items-center gap-1.5 px-3 py-1.5 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 rounded-lg text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3 h-3" />
              清除记忆
            </button>
            <div className="flex items-center gap-2">
              {editing && (
                <button
                  onClick={() => { setMemory(originalMemory); setEditing(false); }}
                  className="px-3 py-1.5 text-white/40 hover:text-white/70 text-xs transition-colors"
                >
                  取消
                </button>
              )}
              {editing && hasChanges && (
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded-lg text-xs font-medium transition-colors"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  保存
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
