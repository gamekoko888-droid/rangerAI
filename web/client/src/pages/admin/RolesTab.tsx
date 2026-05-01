/**
 * RolesTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  BarChart3, Bot, Calculator, Headphones, Loader2, Megaphone, PenTool, Pencil, Plus, Save, Trash2, X,
} from 'lucide-react';
import { fetchAdmin, type AiRole } from './shared';

export function RolesTab() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI: RolesConfirmUI } = useConfirmDialog();
  const [roles, setRoles] = useState<AiRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRole, setEditingRole] = useState<AiRole | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin('/api/system/ai-roles');
      setRoles(data.roles || []);
    } catch { }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  const iconMap: Record<string, React.ElementType> = {
    bot: Bot, headphones: Headphones, megaphone: Megaphone,
    'bar-chart-2': BarChart3, 'pen-tool': PenTool, calculator: Calculator,
  };

  const handleSave = async () => {
    if (!editingRole) return;
    setSaving(true);
    try {
      if (isCreating) {
        await fetchAdmin('/api/system/ai-roles', {
          method: 'POST',
          body: JSON.stringify({
            name: editingRole.name,
            description: editingRole.description,
            systemPrompt: editingRole.systemPrompt,
            icon: editingRole.icon,
            color: editingRole.color,
            category: editingRole.category,
          }),
        });
      } else {
        await fetchAdmin(`/api/system/ai-roles/${editingRole.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: editingRole.name,
            description: editingRole.description,
            systemPrompt: editingRole.systemPrompt,
            icon: editingRole.icon,
            color: editingRole.color,
            category: editingRole.category,
          }),
        });
      }
      setEditingRole(null);
      setIsCreating(false);
      fetchRoles();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const handleDelete = async (role: AiRole) => {
    const ok = await confirmDialog({
      title: t('admin.roles.deleteConfirm'),
      message: `${t('admin.roles.deleteConfirm')} "${role.name}"?`,
      variant: 'danger',
      confirmText: t('sidebar.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await fetchAdmin(`/api/system/ai-roles/${role.id}`, { method: 'DELETE' });
      fetchRoles();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingRole({
      id: '', name: '', description: '', systemPrompt: '',
      icon: 'bot', color: '#3b82f6', category: 'general',
      isActive: 1, sortOrder: 0, createdBy: '', createdAt: '', updatedAt: '',
    });
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-400" /></div>;

  // Edit/Create Modal
  if (editingRole) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-zinc-200">{isCreating ? t('admin.roles.create') : `${t('admin.roles.editRole')}: ${editingRole.name}`}</h3>
          <button onClick={() => { setEditingRole(null); setIsCreating(false); }} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500">
            <X size={18} />
          </button>
        </div>
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Name</label>
              <input type="text" value={editingRole.name} onChange={e => setEditingRole({ ...editingRole, name: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Category</label>
              <input type="text" value={editingRole.category} onChange={e => setEditingRole({ ...editingRole, category: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50" />
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Description</label>
            <input type="text" value={editingRole.description} onChange={e => setEditingRole({ ...editingRole, description: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Icon</label>
              <input type="text" value={editingRole.icon} onChange={e => setEditingRole({ ...editingRole, icon: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50"
                placeholder="bot, headphones, megaphone..." />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Color</label>
              <div className="flex gap-2">
                <input type="color" value={editingRole.color} onChange={e => setEditingRole({ ...editingRole, color: e.target.value })}
                  className="w-10 h-9 bg-zinc-800 border border-zinc-700 rounded cursor-pointer" />
                <input type="text" value={editingRole.color} onChange={e => setEditingRole({ ...editingRole, color: e.target.value })}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500/50" />
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">System Prompt</label>
            <textarea value={editingRole.systemPrompt} onChange={e => setEditingRole({ ...editingRole, systemPrompt: e.target.value })}
              rows={8} className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 resize-y" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setEditingRole(null); setIsCreating(false); }}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">{t('common.cancel')}</button>
            <button onClick={handleSave} disabled={saving || !editingRole.name || !editingRole.systemPrompt}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {isCreating ? t('admin.roles.create') : t('admin.roles.save')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{roles.length} roles</p>
        <button onClick={startCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          <Plus size={14} />{t('admin.roles.addRole')}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {roles.map(role => {
          const IconComp = iconMap[role.icon] || Bot;
          return (
            <div key={role.id} className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 hover:border-zinc-700/80 transition-colors group">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl shrink-0" style={{ backgroundColor: role.color + '20' }}>
                  <IconComp size={20} style={{ color: role.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-zinc-200 truncate">{role.name}</h4>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setEditingRole(role)} className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-blue-400">
                        <Pencil size={13} />
                      </button>
                      {role.id !== 'default' && (
                        <button onClick={() => handleDelete(role)} className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-red-400">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{role.description}</p>
                  <p className="text-[11px] text-zinc-600 mt-2 line-clamp-2 font-mono">{role.systemPrompt.slice(0, 80)}...</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {RolesConfirmUI}
    </div>
  );
}

// ─── Audit Log Tab ──────────────────────────────────────────
