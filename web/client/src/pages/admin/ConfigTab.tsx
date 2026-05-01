/**
 * ConfigTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  Loader2, Pencil, Save, X,
} from 'lucide-react';
import { fetchAdmin, type SystemConfig } from './shared';

export function ConfigTab() {
  const { t } = useI18n();
  const [configs, setConfigs] = useState<SystemConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin('/api/system/config');
      setConfigs(data.configs || []);
    } catch { }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  const handleSave = async (key: string) => {
    setSaving(true);
    try {
      await fetchAdmin('/api/system/config', { method: 'PUT', body: JSON.stringify({ key, value: editValue }) });
      setEditingKey(null);
      fetchConfigs();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const categories = Array.from(new Set(configs.map(c => c.category)));
  const categoryLabels: Record<string, string> = {
    general: t('admin.config.catGeneral'), ai: t('admin.config.catAI'), gateway: t('admin.config.catGateway'), storage: t('admin.config.catStorage'), auth: t('admin.config.catAuth'),
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-400" /></div>;

  return (
    <div className="space-y-6">
      {categories.map(cat => (
        <div key={cat} className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800/50 bg-zinc-900/50">
            <h3 className="text-sm font-medium text-zinc-300">{categoryLabels[cat] || cat}</h3>
          </div>
          <div className="divide-y divide-zinc-800/50">
            {configs.filter(c => c.category === cat).map(config => (
              <div key={config.key} className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200">{config.description || config.key}</p>
                  <p className="text-[11px] text-zinc-600 mt-0.5">{config.key}</p>
                </div>
                {editingKey === config.key ? (
                  <div className="flex items-center gap-2">
                    <input type="text" value={editValue} onChange={e => setEditValue(e.target.value)}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 w-40 focus:outline-none focus:border-blue-500/50"
                      autoFocus onKeyDown={e => e.key === 'Enter' && handleSave(config.key)} />
                    <button onClick={() => handleSave(config.key)} disabled={saving}
                      className="p-1 rounded hover:bg-zinc-700 text-emerald-400 disabled:opacity-50">
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    </button>
                    <button onClick={() => setEditingKey(null)} className="p-1 rounded hover:bg-zinc-700 text-zinc-500">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-400 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">{config.value}</span>
                    <button onClick={() => { setEditingKey(config.key); setEditValue(config.value); }}
                      className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-blue-400">
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
// ─── AI Roles Tab ───────────────────────────────────────────
