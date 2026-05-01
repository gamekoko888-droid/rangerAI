/**
 * OpenPlatformTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  Activity, AlertTriangle, CheckCircle2, Globe, Loader2, MessageSquare, Plus, Trash2, X, Zap,
} from 'lucide-react';
import { formatUptime, formatUptimeStr, MetricCard, type AcpApiKey } from './shared';

export function OpenPlatformTab() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI: KeyConfirmUI } = useConfirmDialog();
  const [keys, setKeys] = useState<AcpApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [acpStatus, setAcpStatus] = useState<{
    service: string; version: string; uptime: number;
    api: { keys_loaded: number; rate_limit: string; active_async_tasks: number };
    adapters: { dingtalk: { enabled: boolean; connected: boolean } };
  } | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      const res = await fetch('/acp/v1/admin/keys', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setKeys(data.keys || []);
    } catch {
      setError(t('admin.status.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAcpStatus = useCallback(async () => {
    try {
      const res = await fetch('/acp/v1/status');
      if (res.ok) setAcpStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchKeys(); fetchAcpStatus(); }, [fetchKeys, fetchAcpStatus]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) { setError(t('admin.acp.nameRequired')); return; }
    setCreating(true);
    setError('');
    try {
      const token = getAuthToken();
      const res = await fetch('/acp/v1/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${res.status}`);
      }
      const data = await res.json();
      setCreatedKey(data.key);
      setNewKeyName('');
      await fetchKeys();
    } catch (err: unknown) {
      setError((err as Error).message || t('admin.system.opFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: AcpApiKey) => {
    if (key.source === 'env') {
      setError(t('admin.acp.envKeyNoRevoke'));
      return;
    }
    const ok = await confirmDialog({
      title: t('admin.acp.revokeConfirm'),
      message: `${t('admin.acp.revokeMsg')} "${key.name}" (${key.key_prefix})`,
      variant: 'danger',
      confirmText: t('admin.acp.revoke'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      const token = getAuthToken();
      const res = await fetch(`/acp/v1/admin/keys/${key.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${res.status}`);
      }
      await fetchKeys();
    } catch (err: unknown) {
      setError((err as Error).message || t('admin.system.opFailed'));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-6">
      {/* ACP Status Card */}
      {acpStatus && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard icon={Globe} label={t('admin.acp.service')} value={acpStatus.version} sub={`${t('admin.running')} ${formatUptimeStr(acpStatus.uptime, (t as (k: string) => string))}`} color="text-blue-400" />
          <MetricCard icon={Zap} label={t('admin.acp.activeKeys')} value={acpStatus.api.keys_loaded} sub={acpStatus.api.rate_limit} color="text-emerald-400" />
          <MetricCard icon={Activity} label={t('admin.acp.asyncTasks')} value={acpStatus.api.active_async_tasks} color="text-amber-400" />
          <MetricCard icon={MessageSquare} label={t('admin.acp.dingtalk')} value={acpStatus.adapters.dingtalk.connected ? t('admin.acp.connected') : acpStatus.adapters.dingtalk.enabled ? t('admin.acp.disconnected') : t('admin.acp.disabled')} color={acpStatus.adapters.dingtalk.connected ? 'text-emerald-400' : 'text-zinc-500'} />
        </div>
      )}

      {/* API Keys Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-zinc-100">{t('admin.acp.apiKeys')}</h3>
            <p className="text-xs text-zinc-500 mt-1">{t('admin.acp.apiKeysDesc')}</p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreatedKey(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> {t('admin.acp.createKey')}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Created Key Display */}
        {createdKey && (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <h4 className="text-sm font-medium text-emerald-300">{t('admin.acp.keyCreated')}</h4>
            </div>
            <p className="text-xs text-emerald-400/80">{t('admin.acp.keyCreatedHint')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-emerald-300 font-mono select-all break-all">
                {createdKey}
              </code>
              <button
                onClick={() => copyToClipboard(createdKey)}
                className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg transition-colors whitespace-nowrap"
              >
                {copied ? t('admin.acp.copied') : t('admin.acp.copy')}
              </button>
            </div>
          </div>
        )}

        {/* Create Form */}
        {showCreate && !createdKey && (
          <div className="p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl space-y-3">
            <h4 className="text-sm font-medium text-zinc-200">{t('admin.acp.newKey')}</h4>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.acp.keyName')}</label>
              <input
                type="text"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
                placeholder={t('admin.acp.keyNamePlaceholder')}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-xs rounded-lg transition-colors"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {t('admin.acp.generate')}
              </button>
              <button
                onClick={() => { setShowCreate(false); setNewKeyName(''); }}
                className="px-4 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs rounded-lg hover:bg-zinc-800 transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Keys Table */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('admin.acp.noKeys')}</p>
            <p className="text-xs mt-1">{t('admin.acp.noKeysHint')}</p>
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800/50 text-zinc-400 text-xs">
                  <th className="py-3 px-4 text-left font-medium">{t('admin.acp.thName')}</th>
                  <th className="py-3 px-4 text-left font-medium">{t('admin.acp.thKeyPrefix')}</th>
                  <th className="py-3 px-4 text-left font-medium">{t('admin.acp.thStatus')}</th>
                  <th className="py-3 px-4 text-left font-medium hidden sm:table-cell">{t('admin.acp.thCalls')}</th>
                  <th className="py-3 px-4 text-left font-medium hidden md:table-cell">{t('admin.acp.thLastUsed')}</th>
                  <th className="py-3 px-4 text-left font-medium hidden lg:table-cell">{t('admin.acp.thCreatedAt')}</th>
                  <th className="py-3 px-4 text-right font-medium">{t('admin.acp.thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {keys.map(key => (
                  <tr key={key.id} className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-200 font-medium">{key.name}</span>
                        {key.source === 'env' && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700/50 text-zinc-400 rounded">ENV</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <code className="text-xs text-zinc-400 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">{key.key_prefix}</code>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${
                        key.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-red-500/10 text-red-400'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${key.status === 'active' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        {key.status === 'active' ? t('admin.acp.statusActive') : t('admin.acp.statusRevoked')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 hidden sm:table-cell">{key.call_count.toLocaleString()}</td>
                    <td className="py-3 px-4 text-zinc-500 text-xs hidden md:table-cell">
                      {key.last_used ? new Date(key.last_used).toLocaleString() : '—'}
                    </td>
                    <td className="py-3 px-4 text-zinc-500 text-xs hidden lg:table-cell">
                      {new Date(key.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {key.status === 'active' && key.source !== 'env' && (
                          <button
                            onClick={() => handleRevoke(key)}
                            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                            title={t('admin.acp.revoke')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* API Documentation */}
      <div className="p-4 bg-zinc-800/30 border border-zinc-700/30 rounded-xl">
        <h4 className="text-sm font-medium text-zinc-300 mb-3">{t('admin.acp.apiDocs')}</h4>
        <div className="space-y-2 text-xs text-zinc-500 font-mono">
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px] font-semibold">POST</span>
            <span>/acp/v1/chat</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docSyncChat')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px] font-semibold">POST</span>
            <span>/acp/v1/chat/async</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docAsyncChat')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded text-[10px] font-semibold">GET</span>
            <span>/acp/v1/task/:id</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docTaskStatus')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px] font-semibold">POST</span>
            <span>/acp/v1/knowledge/search</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docKnowledge')}</span>
          </div>
        </div>
        <div className="mt-3 p-3 bg-zinc-900/50 rounded-lg">
          <p className="text-xs text-zinc-400 mb-2">{t('admin.acp.usageExample')}</p>
          <pre className="text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre">{`curl -X POST https://ranger.voyage/acp/v1/chat \\
  -H "Authorization: Bearer rak_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "你好"}'`}</pre>
        </div>
      </div>

      {KeyConfirmUI}
    </div>
  );
}
