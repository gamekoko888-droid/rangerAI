/**
 * AssignRulesTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  AlertTriangle, GitBranch, Loader2, Pencil, Plus, Save, Trash2, X,
} from 'lucide-react';

// ─── Types (shared with AuditTab) ───
interface AssignRule {
  id: number;
  category: string;
  priority: string;
  assignee: string;
  created_at: string;
}

const CATEGORY_KEYS: Record<string, string> = {
  payment: 'admin.cat.payment', account: 'admin.cat.account', technical: 'admin.cat.technical',
  shipping: 'admin.cat.shipping', refund: 'admin.cat.refund', general: 'admin.cat.general', default: 'admin.cat.default',
};
const CATEGORY_VALUES = ['payment', 'account', 'technical', 'shipping', 'refund', 'general', 'default'];
const PRIORITY_KEYS: Record<string, string> = {
  all: 'admin.priority.all', critical: 'admin.priority.critical', high: 'admin.priority.high',
  medium: 'admin.priority.medium', low: 'admin.priority.low',
};
const PRIORITY_VALUES = ['all', 'critical', 'high', 'medium', 'low'];


export function AssignRulesTab() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI: AssignConfirmUI } = useConfirmDialog();
  const [rules, setRules] = useState<AssignRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ category: 'payment', priority: 'all', assignee: '' });
  const [error, setError] = useState('');

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tickets/assign-rules', {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await res.json();
      setRules(data.rules || []);
    } catch {
      setError(t('admin.status.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const handleSave = async () => {
    if (!form.assignee.trim()) { setError(t('admin.assign.assignee')); return; }
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await fetch(`/api/tickets/assign-rules/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify(form),
        });
      } else {
        await fetch('/api/tickets/assign-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify(form),
        });
      }
      setShowAdd(false);
      setEditingId(null);
      setForm({ category: 'payment', priority: 'all', assignee: '' });
      await fetchRules();
    } catch {
      setError(t('admin.system.opFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirmDialog({
      title: t('admin.roles.deleteConfirm'),
      message: t('admin.roles.deleteConfirm'),
      variant: 'danger',
      confirmText: t('sidebar.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await fetch(`/api/tickets/assign-rules/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      await fetchRules();
    } catch {
      setError(t('admin.system.opFailed'));
    }
  };

  const startEdit = (rule: AssignRule) => {
    setEditingId(rule.id);
    setForm({ category: rule.category, priority: rule.priority, assignee: rule.assignee });
    setShowAdd(true);
  };

  const getCategoryLabel = (val: string) => CATEGORY_KEYS[val] ? t(CATEGORY_KEYS[val] as any) : val;
  const getPriorityLabel = (val: string) => PRIORITY_KEYS[val] ? t(PRIORITY_KEYS[val] as any) : val;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">{t('admin.assign.title')}</h3>
          <p className="text-xs text-zinc-500 mt-1">
            {t('admin.assign.ruleExplanation')}
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setEditingId(null); setForm({ category: 'payment', priority: 'all', assignee: '' }); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> {t('admin.assign.addRule')}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl space-y-3">
          <h4 className="text-sm font-medium text-zinc-200">{editingId ? t('admin.assign.editRule') : t('admin.assign.newRule')}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.assign.category')}</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
              >
                {CATEGORY_VALUES.map(v => <option key={v} value={v}>{getCategoryLabel(v)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.assign.thPriority')}</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
              >
                {PRIORITY_VALUES.map(v => <option key={v} value={v}>{getPriorityLabel(v)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.assign.assignee')}</label>
              <input
                type="text"
                value={form.assignee}
                onChange={e => setForm(f => ({ ...f, assignee: e.target.value }))}
                placeholder={t('admin.assign.assignee')}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-xs rounded-lg transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {editingId ? t('admin.assign.update') : t('admin.assign.createBtn')}
            </button>
            <button
              onClick={() => { setShowAdd(false); setEditingId(null); }}
              className="px-4 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs rounded-lg hover:bg-zinc-800 transition-colors"
            >
              {t('admin.assign.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Rules Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
        </div>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <GitBranch className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('admin.assign.noRules')}</p>
          <p className="text-xs mt-1">{t('admin.assign.noRulesHint')}</p>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800/50 text-zinc-400 text-xs">
                <th className="py-3 px-4 text-left font-medium">{t('admin.assign.thCategory')}</th>
                <th className="py-3 px-4 text-left font-medium">{t('admin.assign.thPriority')}</th>
                <th className="py-3 px-4 text-left font-medium">{t('admin.assign.thAssignee')}</th>
                <th className="py-3 px-4 text-left font-medium hidden sm:table-cell">{t('admin.assign.thCreatedAt')}</th>
                <th className="py-3 px-4 text-right font-medium">{t('admin.assign.thActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-3 px-4">
                    <span className="inline-flex items-center px-2 py-0.5 bg-blue-500/10 text-blue-400 text-xs rounded-full">
                      {getCategoryLabel(rule.category)}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${
                      rule.priority === 'all' ? 'bg-zinc-700/50 text-zinc-300' :
                      rule.priority === 'critical' ? 'bg-red-500/10 text-red-400' :
                      rule.priority === 'high' ? 'bg-orange-500/10 text-orange-400' :
                      rule.priority === 'medium' ? 'bg-yellow-500/10 text-yellow-400' :
                      'bg-green-500/10 text-green-400'
                    }`}>
                      {getPriorityLabel(rule.priority)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-zinc-200 font-medium">{rule.assignee}</td>
                  <td className="py-3 px-4 text-zinc-500 text-xs hidden sm:table-cell">
                    {new Date(rule.created_at).toLocaleString(undefined)}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEdit(rule)}
                        className="p-1.5 text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 rounded-lg transition-colors"
                        title={t('admin.assign.editRule')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                        title={t('admin.roles.deleteConfirm')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Help Info */}
      <div className="p-3 bg-zinc-800/30 border border-zinc-700/30 rounded-xl">
        <h4 className="text-xs font-medium text-zinc-300 mb-2">{t('admin.assign.ruleExplanation')}</h4>
        <ul className="space-y-1 text-xs text-zinc-500">
          <li>• {t('admin.assign.ruleHint1')}</li>
          <li>• {t('admin.assign.ruleHint2')}</li>
          <li>• {t('admin.assign.ruleHint3')}</li>
          <li>• {t('admin.assign.ruleHint4')}</li>
          <li>• {t('admin.assign.ruleHint5')}</li>
        </ul>
      </div>
      {AssignConfirmUI}
    </div>
  );
}

// ─── Open Platform Tab (ACP API Keys Management) ────────────
