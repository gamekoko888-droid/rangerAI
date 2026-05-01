/**
 * ShareDialog — Dialog for sharing a chat with other users.
 * Shows user list, allows selecting permission level, and manages existing shares.
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Share2, Users, Loader2, Trash2, Shield, Eye, Pencil, Check, UserPlus, Link, Copy } from 'lucide-react';
import { fetchUsers, shareChat, fetchChatShares, unshareChat } from '../../lib/api';
import type { User, ChatShare } from '../../lib/types';
import { useI18n } from '../../lib/i18n';
import { copyToClipboard, buildShareUrl } from '../../lib/clipboard';
import { logger } from "../../lib/logger";

interface ShareDialogProps {
  chatId: string;
  chatTitle: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ShareDialog({ chatId, chatTitle, isOpen, onClose }: ShareDialogProps) {
  const { t } = useI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [shares, setShares] = useState<ChatShare[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isLoadingShares, setIsLoadingShares] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [permission, setPermission] = useState<'read' | 'write'>('read');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const handleCopyLink = async () => {
    const url = buildShareUrl(`/chat/${chatId}`);
    const ok = await copyToClipboard(url);
    if (ok) {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const loadData = useCallback(async () => {
    setIsLoadingUsers(true);
    setIsLoadingShares(true);
    setError(null);
    try {
      const [usersData, sharesData] = await Promise.all([
        fetchUsers(),
        fetchChatShares(chatId),
      ]);
      setUsers(usersData);
      setShares(sharesData);
    } catch (err) {
      setError(t('share.loadFailed'));
      logger.error('Failed to load share data:', err);
    } finally {
      setIsLoadingUsers(false);
      setIsLoadingShares(false);
    }
  }, [chatId, t]);

  useEffect(() => {
    if (isOpen) {
      loadData();
      setSelectedUserId('');
      setPermission('read');
      setSuccessMsg(null);
    }
  }, [isOpen, loadData]);

  // Filter out already-shared users
  const availableUsers = users.filter(
    (u) => !shares.some((s) => s.sharedWithUserId === u.id)
  );

  const handleShare = async () => {
    if (!selectedUserId) return;
    setIsSharing(true);
    setError(null);
    try {
      await shareChat(chatId, selectedUserId, permission);
      const selectedUser = users.find((u) => u.id === selectedUserId);
      setSuccessMsg(`${t('share.sharedTo')} ${selectedUser?.displayName || selectedUser?.username}`);
      setSelectedUserId('');
      // Reload shares
      const sharesData = await fetchChatShares(chatId);
      setShares(sharesData);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err) {
      setError(t('share.shareFailed'));
      logger.error('Share failed:', err);
    } finally {
      setIsSharing(false);
    }
  };

  const handleUnshare = async (userId: string) => {
    const share = shares.find((s) => s.sharedWithUserId === userId);
    if (!share) return;
    if (!confirm(`${t('share.cancelShareConfirm')} ${share.displayName || share.username}`)) return;
    try {
      await unshareChat(chatId, userId);
      setShares((prev) => prev.filter((s) => s.sharedWithUserId !== userId));
    } catch (err) {
      setError(t('share.cancelShareFailed'));
      logger.error('Unshare failed:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-full max-w-md mx-4 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Share2 size={18} className="text-blue-400" />
            <h3 className="text-sm font-semibold text-zinc-100">{t('share.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Chat title + copy link */}
        <div className="px-5 py-3 border-b border-zinc-800/50 flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-zinc-500">{t('share.conversation')}</p>
            <p className="text-sm text-zinc-200 truncate mt-0.5">{chatTitle}</p>
          </div>
          <button
            onClick={handleCopyLink}
            className="shrink-0 ml-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                       bg-zinc-800 border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700
                       transition-colors"
            aria-label={t('share.copyLink')}
          >
            {linkCopied ? <Check size={12} className="text-green-400" /> : <Link size={12} />}
            {linkCopied ? t('share.linkCopied') : t('share.copyLink')}
          </button>
        </div>

        {/* Share form */}
        <div className="px-5 py-4">
          {error && (
            <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="mb-3 px-3 py-2 bg-green-500/10 border border-green-500/30 rounded-lg text-xs text-green-300 flex items-center gap-1.5">
              <Check size={12} />
              {successMsg}
            </div>
          )}

          <div className="flex items-center gap-2">
            {/* User select */}
            <div className="flex-1">
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                disabled={isLoadingUsers || availableUsers.length === 0}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200
                           focus:border-blue-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">
                  {isLoadingUsers
                    ? t('share.loading')
                    : availableUsers.length === 0
                    ? t('share.noShareableUsers')
                    : t('share.selectUser')}
                </option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName || u.username}
                    {u.team ? ` (${u.team})` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Permission select */}
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value as 'read' | 'write')}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-zinc-200
                         focus:border-blue-500 focus:outline-none"
            >
              <option value="read">{t('share.readOnly')}</option>
              <option value="write">{t('share.readWrite')}</option>
            </select>

            {/* Share button */}
            <button
              onClick={handleShare}
              disabled={!selectedUserId || isSharing}
              className="flex items-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700
                         disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors
                         disabled:cursor-not-allowed"
            >
              {isSharing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <UserPlus size={14} />
              )}
            </button>
          </div>
        </div>

        {/* Existing shares */}
        <div className="px-5 pb-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Users size={13} className="text-zinc-500" />
            <span className="text-xs text-zinc-500 font-medium">
              {t('share.shared')} ({shares.length})
            </span>
          </div>

          {isLoadingShares ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 size={16} className="animate-spin text-zinc-500" />
            </div>
          ) : shares.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-xs text-zinc-600">{t('share.notSharedYet')}</p>
            </div>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {shares.map((share) => (
                <div
                  key={share.id}
                  className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 rounded-lg group"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center shrink-0">
                      <span className="text-[10px] text-zinc-300 font-medium">
                        {(share.displayName || share.username || '?')[0].toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs text-zinc-200 truncate">
                        {share.displayName || share.username}
                      </p>
                    </div>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full border shrink-0 flex items-center gap-0.5
                        ${share.permission === 'write'
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                          : 'bg-zinc-700/50 border-zinc-600 text-zinc-400'
                        }`}
                    >
                      {share.permission === 'write' ? (
                        <><Pencil size={8} /> {t('share.readWriteLabel')}</>
                      ) : (
                        <><Eye size={8} /> {t('share.readOnlyLabel')}</>
                      )}
                    </span>
                  </div>
                  <button
                    onClick={() => handleUnshare(share.sharedWithUserId)}
                    className="p-1 rounded text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                    title={t('share.cancelShare')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 flex items-center gap-1.5">
          <Shield size={12} className="text-zinc-600" />
          <p className="text-[10px] text-zinc-600">
            {t('share.readOnlyHint')}
          </p>
        </div>
      </div>
    </div>
  );
}
