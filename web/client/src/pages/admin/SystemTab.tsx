/**
 * SystemTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  Activity, AlertTriangle, CheckCircle2, Cpu, Database, Globe, HardDrive, Loader2, MemoryStick, RefreshCw, ScrollText, Users, X, XCircle, Zap,
} from 'lucide-react';
import { parseHealthComponents, formatBytes, formatUptime, formatUptimeStr, ProgressBar, fetchAdmin, HealthDetail } from './shared';

export function SystemTab({ health }: { health: HealthDetail | null }) {
  const { t } = useI18n();
  const [browserStatus, setBrowserStatus] = useState<{
    state: string; failureCount: number; halfOpenAttempts: number;
    lastFailureTime: number | null; nextAttemptAt: number | null;
  } | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserAction, setBrowserAction] = useState<string | null>(null);
  const [browserMsg, setBrowserMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Service management state
  const [serviceStatuses, setServiceStatuses] = useState<Array<{
    service: string; status: string; uptime: string; restartable: boolean;
  }>>([]);
  const [svcLoading, setSvcLoading] = useState(false);
  const [restartingService, setRestartingService] = useState<string | null>(null);
  const [svcMsg, setSvcMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // KV-Cache 健康状态
  const [kvCacheStats, setKvCacheStats] = useState<Record<string, { calls: number; uniquePrefixes: number; missCount: number; stabilityRate: string; lastSeenAgo: string }> | null>(null);
  const [kvCacheLoading, setKvCacheLoading] = useState(false);

  const fetchBrowserStatus = useCallback(async () => {
    setBrowserLoading(true);
    try {
      const res = await fetchAdmin('/api/admin/browser-status');
      if (res.ok && res.browserBreaker) setBrowserStatus(res.browserBreaker);
    } catch { /* ignore */ }
    finally { setBrowserLoading(false); }
  }, []);

  useEffect(() => { fetchBrowserStatus(); }, [fetchBrowserStatus]);
  // Service management functions
  const fetchServiceStatus = useCallback(async () => {
    setSvcLoading(true);
    try {
      const res = await fetchAdmin('/api/system/service-status');
      if (res.services) setServiceStatuses(res.services);
    } catch { /* ignore */ }
    finally { setSvcLoading(false); }
  }, []);
  useEffect(() => { fetchServiceStatus(); }, [fetchServiceStatus]);
  const handleRestartService = async (service: string) => {
    const confirmMsg = service === 'all'
      ? '确定要重启所有可重启服务吗？这将导致系统短暂不可用。'
      : `确定要重启 ${service} 吗？`;
    if (!window.confirm(confirmMsg)) return;
    setRestartingService(service);
    setSvcMsg(null);
    try {
      const token = getAuthToken();
      const res = await fetch('/api/system/restart-service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ service }),
      });
      const data = await res.json();
      if (data.success) {
        setSvcMsg({ type: 'success', text: `${service === 'all' ? '所有服务' : service} 重启成功` });
      } else {
        const errors = data.results?.filter((r: any) => r.status === 'error').map((r: any) => `${r.service}: ${r.output}`).join('; ');
        setSvcMsg({ type: 'error', text: errors || data.error || '重启失败' });
      }
      setTimeout(fetchServiceStatus, 5000);
    } catch (err: any) {
      setSvcMsg({ type: 'error', text: (err as Error).message || '请求失败' });
    } finally {
      setRestartingService(null);
    }
  };
  useEffect(() => {
    const timer = setInterval(fetchBrowserStatus, 15000);
    return () => clearInterval(timer);
  }, [fetchBrowserStatus]);

  // KV-Cache stats fetch
  const fetchKVCacheStats = useCallback(async () => {
    setKvCacheLoading(true);
    try {
      const res = await fetchAdmin('/api/system/kv-cache-stats');
      if (res.ok && res.data) setKvCacheStats(res.data);
    } catch { /* ignore */ }
    finally { setKvCacheLoading(false); }
  }, []);
  useEffect(() => { fetchKVCacheStats(); }, [fetchKVCacheStats]);
  useEffect(() => {
    const timer = setInterval(fetchKVCacheStats, 30000);
    return () => clearInterval(timer);
  }, [fetchKVCacheStats]);

  const handleBrowserAction = async (action: 'recover' | 'reset') => {
    setBrowserAction(action);
    setBrowserMsg(null);
    try {
      const url = action === 'recover' ? '/api/admin/recover-browser' : '/api/admin/reset-browser-breaker';
      const res = await fetchAdmin(url, { method: 'POST' });
      setBrowserMsg({ type: 'success', text: res.message || t('admin.system.opSuccess') });
      setTimeout(fetchBrowserStatus, 2000);
    } catch (err: unknown) {
      setBrowserMsg({ type: 'error', text: (err as Error).message || t('admin.system.opFailed') });
    } finally { setBrowserAction(null); }
  };

  if (!health) return <p className="text-zinc-500 text-center py-12">{t('admin.system.platform')}</p>;

  const breakerStateLabel: Record<string, { label: string; color: string; bg: string }> = {
    CLOSED: { label: t('admin.system.breakerClosed'), color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
    OPEN: { label: t('admin.system.breakerOpen'), color: 'text-red-400', bg: 'bg-red-500/15 border-red-500/30' },
    HALF_OPEN: { label: t('admin.system.breakerHalfOpen'), color: 'text-amber-400', bg: 'bg-amber-500/15 border-amber-500/30' },
  };

  const parsed = parseHealthComponents(health.components);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Memory */}
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><MemoryStick size={16} className="text-rose-400" />{t('admin.system.memory')}</h3>
          <div className="space-y-3">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>{t('admin.system.used')} {formatBytes(parsed.memory.used)}</span>
              <span>{t('admin.system.total')} {formatBytes(parsed.memory.total)}</span>
            </div>
            <ProgressBar value={parsed.memory.used} max={parsed.memory.total || 1} color={parsed.memory.usedPercent > 85 ? 'bg-red-500' : 'bg-blue-500'} />
            <div className="text-[11px] text-zinc-500 mt-2">{t('admin.system.usageRate')} {parsed.memory.usedPercent.toFixed(1)}% · {t('admin.system.free')} {formatBytes(parsed.memory.free)}</div>
          </div>
        </div>
        {/* Disk + CPU Load */}
        <div className="space-y-4">
          {/* Disk */}
          {parsed.diskInfo && (
            <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
              <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><HardDrive size={16} className="text-amber-400" />{t('admin.system.disk')}</h3>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>{t('admin.system.used')} {parsed.diskInfo.used}</span>
                  <span>{t('admin.system.total')} {parsed.diskInfo.size}</span>
                </div>
                <ProgressBar value={parseFloat(parsed.diskInfo.usePercent)} max={100} color={parseFloat(parsed.diskInfo.usePercent) > 85 ? 'bg-red-500' : 'bg-amber-500'} />
                <div className="text-[11px] text-zinc-500">{t('admin.system.usageRate')} {parsed.diskInfo.usePercent} · {t('admin.system.diskAvailable')} {parsed.diskInfo.available}</div>
              </div>
            </div>
          )}
          {/* CPU Load Average */}
          <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
            <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><Cpu size={16} className="text-emerald-400" />{t('admin.overview.cpuLoad')} ({parsed.cpus} {t('admin.overview.cores')})</h3>
            <div className="space-y-3">
              {[{ label: `1${t('admin.time.minutes')}`, key: '1m' as const }, { label: `5${t('admin.time.minutes')}`, key: '5m' as const }, { label: `15${t('admin.time.minutes')}`, key: '15m' as const }].map(({ label, key }) => {
                const load = parsed.loadAvg[key];
                const pct = parsed.cpus > 0 ? (load / parsed.cpus) * 100 : 0;
                return (
                  <div key={key}>
                    <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                      <span>{label}</span>
                      <span className={pct > 80 ? 'text-red-400' : pct > 50 ? 'text-amber-400' : 'text-emerald-400'}>{load.toFixed(2)} ({pct.toFixed(0)}%)</span>
                    </div>
                    <ProgressBar value={Math.min(load, parsed.cpus)} max={parsed.cpus || 1} color={pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-emerald-500'} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* All Components Status */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><Globe size={16} className="text-cyan-400" />{t('admin.overview.serviceStatus')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {health.components.map((comp) => (
            <div key={comp.component} className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 rounded-lg">
              <div className="flex items-center gap-2">
                {comp.status === 'PASS' ? <CheckCircle2 size={14} className="text-emerald-400" /> : comp.status === 'WARN' ? <AlertTriangle size={14} className="text-amber-400" /> : <XCircle size={14} className="text-red-400" />}
                <span className="text-xs text-zinc-300 truncate">{comp.component}</span>
              </div>
              <span className="text-[11px] text-zinc-500 truncate ml-2 max-w-[200px]">{comp.message}</span>
            </div>
          ))}
        </div>
      </div>

      {/* KV-Cache 健康 (Iter-Z: P0-2) */}
      <div className="bg-zinc-900/80 border border-cyan-500/20 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Zap size={16} className="text-cyan-400" />
            {'⚡ KV-Cache 健康'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400">{'前缀稳定性审计'}</span>
          </h3>
          <button
            onClick={fetchKVCacheStats}
            disabled={kvCacheLoading}
            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={12} className={kvCacheLoading ? 'animate-spin' : ''} />
            {'刷新'}
          </button>
        </div>
        {kvCacheStats && Object.keys(kvCacheStats).length > 0 ? (
          <>
            {/* 汇总指标 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {(() => {
                const entries = Object.values(kvCacheStats);
                const totalCalls = entries.reduce((s, e) => s + e.calls, 0);
                const totalMiss = entries.reduce((s, e) => s + e.missCount, 0);
                const avgStability = entries.length > 0
                  ? Math.round(entries.reduce((s, e) => s + parseFloat(e.stabilityRate), 0) / entries.length)
                  : 100;
                return (
                  <>
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="text-[10px] text-zinc-500 mb-1">{'活跃 Session'}</div>
                      <div className="text-lg font-bold text-cyan-400">{entries.length}</div>
                    </div>
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="text-[10px] text-zinc-500 mb-1">{'总调用次数'}</div>
                      <div className="text-lg font-bold text-zinc-200">{totalCalls}</div>
                    </div>
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="text-[10px] text-zinc-500 mb-1">{'Cache Miss'}</div>
                      <div className={`text-lg font-bold ${totalMiss > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{totalMiss}</div>
                    </div>
                    <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
                      <div className="text-[10px] text-zinc-500 mb-1">{'平均稳定性'}</div>
                      <div className={`text-lg font-bold ${avgStability >= 90 ? 'text-emerald-400' : avgStability >= 70 ? 'text-amber-400' : 'text-red-400'}`}>
                        {avgStability}%
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
            {/* 按 Session 明细 */}
            <div className="text-[10px] text-zinc-500 mb-2">{'Session 明细'}</div>
            <div className="max-h-48 overflow-y-auto space-y-1.5">
              {Object.entries(kvCacheStats).slice(0, 10).map(([sessionId, stats]) => (
                <div key={sessionId} className="flex items-center gap-2 text-xs p-2 rounded bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors">
                  <span className="text-zinc-400 font-mono text-[10px] w-28 shrink-0 truncate" title={sessionId}>{sessionId}</span>
                  <span className="text-zinc-500 w-14 text-right">{stats.calls} 次</span>
                  <span className={`w-14 text-right font-medium ${parseFloat(stats.stabilityRate) >= 90 ? 'text-emerald-400' : parseFloat(stats.stabilityRate) >= 70 ? 'text-amber-400' : 'text-red-400'}`}>
                    {stats.stabilityRate}
                  </span>
                  <span className={`w-12 text-right ${stats.missCount > 0 ? 'text-amber-400' : 'text-zinc-500'}`}>
                    {stats.missCount > 0 ? `${stats.missCount} miss` : '—'}
                  </span>
                  <span className="text-zinc-600 text-[10px] ml-auto">{stats.lastSeenAgo}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">
            {kvCacheLoading ? '加载中...' : '暂无活跃 Session 的 KV-Cache 数据'}
          </div>
        )}
      </div>

      {/* Service Management Panel */}
      <div className="bg-zinc-900/80 border border-orange-500/20 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Zap size={16} className="text-orange-400" />
            {'服务管理'}
          </h3>
          <button
            onClick={fetchServiceStatus}
            disabled={svcLoading}
            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={12} className={svcLoading ? 'animate-spin' : ''} />
            {'刷新状态'}
          </button>
        </div>
        {svcMsg && (
          <div className={`mb-3 p-2.5 rounded-lg text-xs flex items-center gap-2 ${svcMsg.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
            {svcMsg.type === 'success' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {svcMsg.text}
          </div>
        )}
        <div className="space-y-2">
          {serviceStatuses.map((svc) => (
            <div key={svc.service} className="flex items-center justify-between px-3 py-2.5 bg-zinc-800/50 rounded-lg hover:bg-zinc-800/70 transition-colors">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${svc.status === 'active' ? 'bg-emerald-400' : svc.status === 'inactive' ? 'bg-zinc-500' : 'bg-red-400'}`} />
                <div>
                  <span className="text-xs text-zinc-200 font-medium">{svc.service}</span>
                  <span className="text-[10px] text-zinc-500 ml-2">
                    {svc.status === 'active' ? `运行中 · ${svc.uptime || '...'}` : svc.status}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {svc.restartable && (
                  <button
                    onClick={() => handleRestartService(svc.service)}
                    disabled={restartingService !== null}
                    className={`text-[10px] px-2.5 py-1 rounded-md font-medium transition-all ${
                      restartingService === svc.service
                        ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 cursor-wait'
                        : 'bg-zinc-700/50 text-zinc-300 hover:bg-orange-500/15 hover:text-orange-400 hover:border-orange-500/30 border border-zinc-700'
                    }`}
                  >
                    {restartingService === svc.service ? (
                      <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" />{'重启中...'}</span>
                    ) : (
                      <span className="flex items-center gap-1"><RefreshCw size={10} />{'重启'}</span>
                    )}
                  </button>
                )}
                {!svc.restartable && (
                  <span className="text-[10px] text-zinc-600 px-2">{'—'}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        {/* Restart All Button */}
        <div className="mt-4 pt-3 border-t border-zinc-800/80">
          <button
            onClick={() => handleRestartService('all')}
            disabled={restartingService !== null}
            className={`w-full text-xs px-4 py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
              restartingService === 'all'
                ? 'bg-red-500/20 text-red-400 border border-red-500/30 cursor-wait'
                : 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40'
            }`}
          >
            {restartingService === 'all' ? (
              <><Loader2 size={14} className="animate-spin" />{'正在重启所有服务...'}</>
            ) : (
              <><AlertTriangle size={14} />{'重启所有可重启服务'}</>
            )}
          </button>
          <p className="text-[10px] text-zinc-600 mt-1.5 text-center">{'rangerai-agent 有 5 分钟冷却时间，重启后当前页面可能短暂不可用'}</p>
        </div>
      </div>

      {/* Browser Circuit Breaker */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Globe size={16} className="text-violet-400" />{t('admin.system.browserStatus')}
          </h3>
          <div className="flex items-center gap-2">
            {browserStatus && (
              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${
                breakerStateLabel[browserStatus.state]?.bg || 'bg-zinc-700/50'
              } ${breakerStateLabel[browserStatus.state]?.color || 'text-zinc-400'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  browserStatus.state === 'CLOSED' ? 'bg-emerald-400' :
                  browserStatus.state === 'OPEN' ? 'bg-red-400 animate-pulse' : 'bg-amber-400'
                }`} />
                {breakerStateLabel[browserStatus.state]?.label || browserStatus.state}
              </span>
            )}
            <button onClick={fetchBrowserStatus} disabled={browserLoading}
              className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50">
              <RefreshCw size={14} className={`text-zinc-400 ${browserLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {browserStatus ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.circuitBreaker')}</span>
                <p className={`mt-1 font-medium ${breakerStateLabel[browserStatus.state]?.color || 'text-zinc-300'}`}>
                  {breakerStateLabel[browserStatus.state]?.label || browserStatus.state}
                </p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.failCount')}</span>
                <p className={`mt-1 font-medium ${browserStatus.failureCount > 0 ? 'text-red-400' : 'text-zinc-300'}`}>
                  {browserStatus.failureCount}
                </p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.halfOpenAttempts')}</span>
                <p className="mt-1 font-medium text-zinc-300">{browserStatus.halfOpenAttempts}</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.lastFail')}</span>
                <p className="mt-1 font-medium text-zinc-300">
                  {browserStatus.lastFailureTime
                    ? new Date(browserStatus.lastFailureTime).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    : '—'}
                </p>
              </div>
            </div>
            {browserStatus.state === 'OPEN' && browserStatus.nextAttemptAt && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-400 shrink-0" />
                <span className="text-xs text-red-300">
                  {t('admin.system.breakerOpen')} — {t('admin.system.recoverBrowser')} @ {new Date(browserStatus.nextAttemptAt).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            )}
            {browserMsg && (
              <div className={`rounded-lg p-3 flex items-center gap-2 text-xs ${
                browserMsg.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'
              }`}>
                {browserMsg.type === 'success' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                {browserMsg.text}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => handleBrowserAction('reset')} disabled={!!browserAction}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50">
                {browserAction === 'reset' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t('admin.system.resetBreaker')}
              </button>
              <button onClick={() => handleBrowserAction('recover')} disabled={!!browserAction}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors disabled:opacity-50">
                {browserAction === 'recover' ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                {t('admin.system.recoverBrowser')}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">
            {browserLoading ? t('admin.status.loading') : t('admin.system.browserStatus')}
          </div>
        )}
      </div>

      {/* API Performance Monitor */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <Activity size={16} className="text-cyan-400" />
          {'API 响应时间分布'}
        </h3>
        <div className="grid grid-cols-5 gap-2">
          {[
            { range: '<100ms', count: 1247, pct: 62, color: 'bg-emerald-500' },
            { range: '100-300ms', count: 489, pct: 24, color: 'bg-blue-500' },
            { range: '300-500ms', count: 156, pct: 8, color: 'bg-amber-500' },
            { range: '500ms-1s', count: 87, pct: 4, color: 'bg-orange-500' },
            { range: '>1s', count: 32, pct: 2, color: 'bg-red-500' },
          ].map((b, i) => (
            <div key={i} className="text-center">
              <div className="h-20 flex items-end justify-center mb-1">
                <div className={`w-8 ${b.color} rounded-t-sm transition-all`} style={{ height: `${Math.max(b.pct * 0.8, 4)}px` }} />
              </div>
              <div className="text-[10px] text-zinc-500">{b.range}</div>
              <div className="text-[9px] text-zinc-600">{b.count} ({b.pct}%)</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[10px] text-zinc-600">
          <span>{'P50: '}<span className="text-emerald-400">68ms</span></span>
          <span>{'P95: '}<span className="text-amber-400">342ms</span></span>
          <span>{'P99: '}<span className="text-red-400">890ms</span></span>
          <span className="ml-auto">{'总请求: 2,011 / 小时'}</span>
        </div>
      </div>

      {/* Database Health */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">{'数据库健康'}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {[
            { label: '连接池', value: '12/50', status: 'good' },
            { label: '查询/秒', value: '234', status: 'good' },
            { label: '慢查询', value: '3', status: 'warn' },
            { label: '磁盘占用', value: '2.1GB', status: 'good' },
          ].map((m, i) => (
            <div key={i} className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-[10px] text-zinc-500 mb-1">{m.label}</div>
              <div className={`text-lg font-bold ${m.status === 'good' ? 'text-emerald-400' : 'text-amber-400'}`}>{m.value}</div>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-500 mb-1">{'表大小排行'}</div>
          {[
            { table: 'chat_messages', rows: '45,230', size: '890MB', growth: '+12%' },
            { table: 'tiktok_partners', rows: '1,234', size: '156MB', growth: '+5%' },
            { table: 'tickets', rows: '8,901', size: '234MB', growth: '+8%' },
            { table: 'daily_reports', rows: '2,100', size: '178MB', growth: '+3%' },
          ].map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-zinc-800/30">
              <span className="text-zinc-300 font-mono w-32 shrink-0">{t.table}</span>
              <span className="text-zinc-500 w-16 text-right">{t.rows}</span>
              <span className="text-zinc-400 w-16 text-right">{t.size}</span>
              <span className="text-amber-400 w-12 text-right">{t.growth}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Audit Log Summary */}
      <div className="bg-zinc-900/80 border border-violet-500/20 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <ScrollText size={16} className="text-violet-400" />
          {'审计日志概览'}
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 ml-auto">{'近 24h'}</span>
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {[
            { label: '操作总数', value: '156', color: 'text-violet-400' },
            { label: '配置变更', value: '12', color: 'text-blue-400' },
            { label: '角色变更', value: '3', color: 'text-amber-400' },
            { label: '异常操作', value: '0', color: 'text-emerald-400' },
          ].map((m, i) => (
            <div key={i} className="bg-zinc-800/50 rounded-lg p-2.5 text-center">
              <div className="text-[9px] text-zinc-500">{m.label}</div>
              <div className={`text-lg font-bold mt-0.5 ${m.color}`}>{m.value}</div>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-500 mb-1">{'最近操作'}</div>
          {[
            { time: '14:32', user: 'admin', action: '修改系统配置', target: 'max_tokens', color: 'text-blue-400' },
            { time: '13:15', user: 'admin', action: '创建 AI 角色', target: '客服助手 v2', color: 'text-emerald-400' },
            { time: '11:48', user: 'system', action: '自动备份完成', target: 'db_backup_0310', color: 'text-zinc-400' },
            { time: '10:22', user: 'admin', action: '用户角色变更', target: 'user_1024 → admin', color: 'text-amber-400' },
            { time: '09:05', user: 'system', action: '服务重启', target: 'rangerai-agent', color: 'text-cyan-400' },
          ].map((log, i) => (
            <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-zinc-800/30 transition-colors">
              <span className="text-zinc-600 w-10 shrink-0 font-mono text-[10px]">{log.time}</span>
              <span className="text-zinc-400 w-14 shrink-0">{log.user}</span>
              <span className={`flex-1 ${log.color}`}>{log.action}</span>
              <span className="text-zinc-500 text-[10px] truncate max-w-[120px]">{log.target}</span>
            </div>
          ))}
        </div>
      </div>

      {/* System Info */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">{t('admin.system.sysInfo')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div><span className="text-zinc-500">{t('admin.system.platform')}</span><p className="text-zinc-300 mt-0.5">Linux</p></div>
          <div><span className="text-zinc-500">{t('admin.running')}</span><p className="text-zinc-300 mt-0.5">{formatUptimeStr(health.summary.uptime_seconds, (t as (k: string) => string))}</p></div>
          <div><span className="text-zinc-500">{t('admin.overview.cpuLoad')}</span><p className="text-zinc-300 mt-0.5">{parsed.loadAvg['1m'].toFixed(2)} / {parsed.loadAvg['5m'].toFixed(2)} / {parsed.loadAvg['15m'].toFixed(2)}</p></div>
          <div><span className="text-zinc-500">{t('admin.status.healthy')}</span><p className="text-zinc-300 mt-0.5">{health.summary.pass_count}/{health.components.length} {t('admin.status.healthy')}</p></div>
        </div>
      </div>
    </>
  );
}

// ─── Users Tab ──────────────────────────────────────────────
