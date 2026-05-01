/**
 * InviteCodesPage — Admin page for managing invite codes.
 * Mobile: responsive layout, stacked form, card-based list.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  createInviteCode,
  getInviteCodes,
  deactivateInviteCode,
  getMe,
  type InviteCode,
} from '../lib/api';
import type { User } from '../lib/types';
import {
  Plus,
  Copy,
  Trash2,
  ArrowLeft,
  Loader2,
  Check,
  AlertCircle,
  Ticket,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import { EmptyState } from '../components/EmptyState';
import { copyToClipboard } from '../lib/clipboard';

export default function InviteCodesPage() {
  const { t, locale } = useI18n();
  const [, navigate] = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [maxUses, setMaxUses] = useState(5);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [selectedRole, setSelectedRole] = useState('member');
  const ROLE_OPTIONS = [
    { value: 'member', label: '成员 (Member)' },
    { value: 'manager', label: '管理者 (Manager)' },
    { value: 'cs', label: '客服 (CS)' },
    { value: 'viewer', label: '观察者 (Viewer)' },
    { value: 'finance', label: '财务 (Finance)' },
  ];

  // Fetch current user independently (no ChatProvider dependency)
  useEffect(() => {
    getMe().then((u) => {
      setUser(u?.user ?? null);
      setUserLoading(false);
      if (!u?.user) {
        navigate('/login');
      }
    }).catch(() => {
      setUserLoading(false);
      navigate('/login');
    });
  }, [navigate]);

  const loadCodes = useCallback(async () => {
    try {
      const data = await getInviteCodes();
      setCodes(data);
    } catch {
      setError('Failed to load invite codes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user && user.role === 'admin') {
      loadCodes();
    }
  }, [user, loadCodes]);

  // Loading state
  if (userLoading) {
    return (
      <div className="min-h-dvh bg-zinc-950 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  // Only admin can access
  if (user && user.role !== 'admin') {
    return (
      <div className="min-h-dvh bg-zinc-950 flex items-center justify-center px-4">
        <div className="text-center">
          <AlertCircle size={48} className="text-red-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-zinc-100 mb-2">{t('invite.noAccess')}</h2>
          <p className="text-zinc-500 mb-4">{t('invite.adminOnly')}</p>
          <button
            onClick={() => navigate('/')}
            className="text-blue-400 hover:text-blue-300 text-sm"
          >
            {t('invite.back')}
          </button>
        </div>
      </div>
    );
  }

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const newCode = await createInviteCode(maxUses, expiresInDays, selectedRole);
      setCodes((prev) => [newCode, ...prev]);
    } catch {
      setError('Failed to create invite code');
    } finally {
      setCreating(false);
    }
  };

  const handleDeactivate = async (codeId: string) => {
    try {
      await deactivateInviteCode(codeId);
      setCodes((prev) =>
        prev.map((c) => (c.id === codeId ? { ...c, active: 0 } : c))
      );
    } catch {
      setError('Failed to deactivate invite code');
    }
  };

  const handleCopy = async (code: string, id: string) => {
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    const loc = locale === 'en' ? 'en-US' : locale === 'zh-TW' ? 'zh-TW' : 'zh-CN';
    return new Date(dateStr).toLocaleDateString(loc, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {/* Header */}
        <div className="flex items-center gap-2 sm:gap-3 mb-5 sm:mb-8">
          <button
            onClick={() => navigate('/')}
            className="p-2 rounded-lg hover:bg-zinc-800 active:bg-zinc-700 transition-colors shrink-0"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold flex items-center gap-2">
              <Ticket size={18} className="text-blue-400 shrink-0" />
              {t('invite.title')}
            </h1>
            <p className="text-xs sm:text-sm text-zinc-500 mt-0.5">
              {t('invite.adminOnly')}
            </p>
          </div>
        </div>

        {/* Create Section */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 sm:p-5 mb-4 sm:mb-6">
          <h2 className="text-sm font-medium text-zinc-300 mb-3 sm:mb-4">{t('invite.createTitle')}</h2>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex gap-3 flex-1">
              <div className="flex-1">
                <label className="block text-xs text-zinc-500 mb-1">{t('invite.maxUses')}</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 sm:py-2 text-sm
                             focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-zinc-500 mb-1">{t('invite.expireDays')}</label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 sm:py-2 text-sm
                             focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            </div>
            {/* Role selector */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-zinc-500">{t('invite.role' as any) || '注册角色'}</label>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 sm:py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500 transition-colors"
              >
                {ROLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700
                         disabled:bg-blue-600/50
                         text-white text-sm font-medium rounded-lg px-4 py-2.5 sm:py-2 transition-colors whitespace-nowrap"
            >
              {creating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              {creating ? t('invite.creating') : t('invite.createBtn')}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 mb-4">
            <AlertCircle size={16} className="text-red-400 shrink-0" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Codes List */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-zinc-500" />
          </div>
        ) : codes.length === 0 ? (
          <EmptyState
            icon={Ticket}
            title={t('invite.empty')}
            description={t('invite.emptyDesc')}
          />
        ) : (
          <div className="space-y-2">
            {codes.map((code) => {
              const isExpired = code.expiresAt && new Date(code.expiresAt) < new Date();
              const isUsedUp = code.currentUses >= code.maxUses;
              const isInactive = !code.active;
              const status = isInactive
                ? 'inactive'
                : isExpired
                ? 'expired'
                : isUsedUp
                ? 'used'
                : 'active';

              const statusColors = {
                active: 'bg-green-500/10 text-green-400 border-green-500/20',
                expired: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                used: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
                inactive: 'bg-red-500/10 text-red-400 border-red-500/20',
              };

              const statusLabels = {
                active: t('invite.statusActive'),
                expired: t('invite.statusExpired'),
                used: t('invite.statusUsed'),
                inactive: t('invite.statusInactive'),
              };

              return (
                <div
                  key={code.id}
                  className={`bg-zinc-900 border border-zinc-800 rounded-xl p-3 sm:p-4 
                    ${status !== 'active' ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start sm:items-center gap-3">
                    {/* Code info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <code className="text-sm font-mono font-bold text-zinc-100 tracking-wider">
                          {code.code}
                        </code>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${statusColors[status]}`}
                        >
                          {statusLabels[status]}
                        </span>
                        {code.role && code.role !== 'member' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border font-medium bg-purple-500/10 text-purple-400 border-purple-500/20">
                            {ROLE_OPTIONS.find(r => r.value === code.role)?.label || code.role}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 text-[11px] sm:text-xs text-zinc-500 flex-wrap">
                        <span>
                          {code.currentUses}/{code.maxUses} {t('invite.uses')}
                        </span>
                        <span>{t('invite.created')} {formatDate(code.createdAt)}</span>
                        {code.expiresAt && (
                          <span>{t('invite.expired')} {formatDate(code.expiresAt)}</span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => handleCopy(code.code, code.id)}
                        className="p-2 rounded-lg hover:bg-zinc-800 active:bg-zinc-700 transition-colors"
                        title="Copy"
                      >
                        {copiedId === code.id ? (
                          <Check size={14} className="text-green-400" />
                        ) : (
                          <Copy size={14} className="text-zinc-500" />
                        )}
                      </button>
                      {status === 'active' && (
                        <button
                          onClick={() => handleDeactivate(code.id)}
                          className="p-2 rounded-lg hover:bg-red-500/10 active:bg-red-500/20 transition-colors"
                          title="Deactivate"
                        >
                          <Trash2 size={14} className="text-zinc-500 hover:text-red-400" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
