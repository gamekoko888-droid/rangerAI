/**
 * AuditTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  Loader2, ScrollText,
} from 'lucide-react';
import { fetchAdmin } from './shared';

interface AuditLog {
  id: number; userId: string; username: string;
  action: string; target: string; targetId: string;
  detail: string; ip: string; createdAt: string;
}


export function AuditTab() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const limit = 20;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin(`/api/system/audit-logs?limit=${limit}&offset=${page * limit}`);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch { }
    finally { setLoading(false); }
  }, [page]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const actionLabels: Record<string, { label: string; color: string }> = {
    config_update: { label: t('admin.audit.configUpdate'), color: 'text-blue-400' },
    role_create: { label: t('admin.audit.roleCreate'), color: 'text-emerald-400' },
    role_update: { label: t('admin.audit.roleUpdate'), color: 'text-amber-400' },
    role_delete: { label: t('admin.audit.roleDelete'), color: 'text-red-400' },
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-400" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{t('admin.audit.totalRecords')}: {total}</p>
      </div>

      {logs.length === 0 ? (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-12 text-center">
          <ScrollText size={32} className="text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">{t('admin.audit.noLogs')}</p>
          <p className="text-xs text-zinc-600 mt-1">{t('admin.audit.noLogsHint')}</p>
        </div>
      ) : (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs border-b border-zinc-800 bg-zinc-900/50">
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thTime')}</th>
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thOperator')}</th>
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thAction')}</th>
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thTarget')}</th>
                  <th className="text-left py-3 px-4 font-medium hidden sm:table-cell">{t('admin.audit.thDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const actionInfo = actionLabels[log.action] || { label: log.action, color: 'text-zinc-400' };
                  let detail = '';
                  try { detail = JSON.stringify(JSON.parse(log.detail || '{}'), null, 0).slice(0, 60); } catch { detail = log.detail || ''; }
                  return (
                    <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                      <td className="py-3 px-4 text-xs text-zinc-500 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td className="py-3 px-4 text-zinc-300">{log.username || '—'}</td>
                      <td className="py-3 px-4"><span className={`text-xs ${actionInfo.color}`}>{actionInfo.label}</span></td>
                      <td className="py-3 px-4 text-xs text-zinc-500">{log.targetId || '—'}</td>
                      <td className="py-3 px-4 text-xs text-zinc-600 hidden sm:table-cell font-mono truncate max-w-[200px]">{detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > limit && (
            <div className="flex items-center justify-center gap-2 py-3 border-t border-zinc-800/50">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 rounded hover:bg-zinc-800">{t('admin.audit.prevPage')}</button>
              <span className="text-xs text-zinc-500">{page + 1} / {Math.ceil(total / limit)}</span>
              <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total}
                className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 rounded hover:bg-zinc-800">{t('admin.audit.nextPage')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Assign Rules Tab ──────────────────────────────────────
export interface AssignRule {
  id: number;
  category: string;
  priority: string;
  assignee: string;
  created_at: string;
}

// Labels will be resolved at render time via i18n
export const CATEGORY_KEYS: Record<string, string> = {
  payment: 'admin.cat.payment', account: 'admin.cat.account', technical: 'admin.cat.technical',
  shipping: 'admin.cat.shipping', refund: 'admin.cat.refund', general: 'admin.cat.general', default: 'admin.cat.default',
};
export const CATEGORY_VALUES = ['payment', 'account', 'technical', 'shipping', 'refund', 'general', 'default'];

export const PRIORITY_KEYS: Record<string, string> = {
  all: 'admin.priority.all', critical: 'admin.priority.critical', high: 'admin.priority.high',
  medium: 'admin.priority.medium', low: 'admin.priority.low',
};
export const PRIORITY_VALUES = ['all', 'critical', 'high', 'medium', 'low'];
