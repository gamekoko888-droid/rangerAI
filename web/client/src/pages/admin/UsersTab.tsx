/**
 * UsersTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  Crown, Loader2, UserCog, UserMinus, Users,
} from 'lucide-react';
import { fetchAdmin, UserInfo } from './shared';

export function UsersTab({ users, onRefresh }: { users: UserInfo[]; onRefresh: () => void }) {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI } = useConfirmDialog();
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingRole, setUpdatingRole] = useState<number | null>(null);
  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleRoleToggle = async (userId: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'member' : 'admin';
    const ok = await confirmDialog({
      title: t('admin.users.confirmRoleChange'),
      message: `${t('admin.users.confirmRoleChange')} ${newRole === 'admin' ? t('admin.users.roleAdmin') : t('admin.users.roleMember')}?`,
      variant: 'warning',
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    setUpdatingRole(userId);
    try {
      await fetchAdmin(`/api/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
      onRefresh();
    } catch { alert(t('admin.status.loadFailed')); }
    finally { setUpdatingRole(null); }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <input type="text" placeholder={t('admin.users.search')} value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 pl-9 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50" />
          <Users size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
        </div>
        <span className="text-xs text-zinc-500">{filteredUsers.length} {t('admin.overview.dbUsers')}</span>
      </div>
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs border-b border-zinc-800 bg-zinc-900/50">
                <th className="text-left py-3 px-4 font-medium">{t('admin.users.thName')}</th>
                <th className="text-left py-3 px-4 font-medium">{t('admin.users.thRole')}</th>
                <th className="text-right py-3 px-4 font-medium">{t('admin.users.thChats')}</th>
                <th className="text-right py-3 px-4 font-medium">{t('admin.users.thMessages')}</th>
                <th className="text-right py-3 px-4 font-medium hidden sm:table-cell">{t('admin.users.thLastActive')}</th>
                <th className="text-center py-3 px-4 font-medium">{t('admin.users.thActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map(user => (
                <tr key={user.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                        {user.role === 'admin' ? <Crown size={13} className="text-amber-400" /> : <UserCog size={13} className="text-zinc-400" />}
                      </div>
                      <p className="text-sm text-zinc-200 truncate">{user.username}</p>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${user.role === 'admin' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'bg-zinc-700/50 text-zinc-400'}`}>
                      {user.role === 'admin' ? t('admin.users.roleAdmin') : t('admin.users.roleMember')}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right text-zinc-300">{user.chatCount}</td>
                  <td className="py-3 px-4 text-right text-zinc-300">{user.messageCount}</td>
                  <td className="py-3 px-4 text-right text-zinc-500 text-xs hidden sm:table-cell">
                    {user.lastActive ? new Date(user.lastActive).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <button onClick={() => handleRoleToggle(user.id, user.role)} disabled={updatingRole === user.id}
                      className="text-xs text-zinc-500 hover:text-blue-400 transition-colors disabled:opacity-50"
                      title={user.role === 'admin' ? t('admin.users.demoteToMember') : t('admin.users.promoteToAdmin')}>
                      {updatingRole === user.id ? <Loader2 size={14} className="animate-spin" /> : user.role === 'admin' ? <UserMinus size={14} /> : <Crown size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {ConfirmDialogUI}
    </>
  );
}

// ─── Config Tab ─────────────────────────────────────────────
