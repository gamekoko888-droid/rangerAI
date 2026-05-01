/**
 * ServiceManagementTab — Standalone tab for service restart management.
 * Placed in admin sidebar under "运维" group for easy access.
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { getAuthToken } from '../../lib/api';
import {
  RefreshCw, Power, AlertTriangle, CheckCircle2, XCircle,
  Loader2, Zap, ServerCrash, RotateCcw,
} from 'lucide-react';
import { logger } from "../../lib/logger";

interface ServiceInfo {
  service: string;
  status: string;
  uptime: string;
  restartable: boolean;
}

interface ServiceStatusResponse {
  services: ServiceInfo[];
  timestamp: string;
}

export function ServiceManagementTab() {
  const { t } = useI18n();
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [restartingService, setRestartingService] = useState<string | null>(null);
  const [restartResult, setRestartResult] = useState<{ service: string; success: boolean; message: string } | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  const fetchServices = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const token = getAuthToken();
      const res = await fetch('/api/system/service-status', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data: ServiceStatusResponse = await res.json();
        setServices(data.services || []);
      }
    } catch (err) {
      logger.error('Failed to fetch service status:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchServices(); }, [fetchServices]);

  const handleRestart = async (serviceName: string) => {
    setConfirmTarget(null);
    setRestartingService(serviceName);
    setRestartResult(null);
    try {
      const token = getAuthToken();
      const res = await fetch('/api/system/restart-service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ service: serviceName }),
      });
      const data = await res.json();
      setRestartResult({
        service: serviceName,
        success: data.success || res.ok,
        message: data.message || (res.ok ? '重启成功' : '重启失败'),
      });
      // Auto refresh after restart
      setTimeout(() => fetchServices(true), 5000);
    } catch (err: any) {
      setRestartResult({
        service: serviceName,
        success: false,
        message: err.message || '请求失败',
      });
    } finally {
      setRestartingService(null);
    }
  };

  const handleRestartAll = async () => {
    setConfirmTarget(null);
    const restartable = services.filter(s => s.restartable);
    for (const svc of restartable) {
      setRestartingService(svc.service);
      try {
        const token = getAuthToken();
        await fetch('/api/system/restart-service', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ service: svc.service }),
        });
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    setRestartingService(null);
    setRestartResult({ service: 'all', success: true, message: '所有可重启服务已依次重启' });
    setTimeout(() => fetchServices(true), 5000);
  };

  const getStatusIcon = (status: string) => {
    if (status === 'active' || status === 'running') return <CheckCircle2 size={16} className="text-emerald-400" />;
    if (status === 'inactive' || status === 'dead') return <XCircle size={16} className="text-red-400" />;
    return <AlertTriangle size={16} className="text-yellow-400" />;
  };

  const getStatusColor = (status: string) => {
    if (status === 'active' || status === 'running') return 'text-emerald-400';
    if (status === 'inactive' || status === 'dead') return 'text-red-400';
    return 'text-yellow-400';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={28} className="animate-spin text-blue-400" />
      </div>
    );
  }

  const restartableServices = services.filter(s => s.restartable);
  const otherServices = services.filter(s => !s.restartable);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-orange-500/10">
            <Zap size={20} className="text-orange-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">服务管理</h2>
            <p className="text-xs text-zinc-500 mt-0.5">管理和重启系统各模块服务</p>
          </div>
        </div>
        <button
          onClick={() => fetchServices(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 text-zinc-300 text-sm transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          刷新状态
        </button>
      </div>

      {/* Result notification */}
      {restartResult && (
        <div className={`flex items-center gap-3 p-3 rounded-lg border ${
          restartResult.success
            ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300'
            : 'bg-red-500/5 border-red-500/20 text-red-300'
        }`}>
          {restartResult.success ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span className="text-sm">{restartResult.message}</span>
          <button onClick={() => setRestartResult(null)} className="ml-auto text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
      )}

      {/* Confirm dialog */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-orange-500/10">
                <AlertTriangle size={20} className="text-orange-400" />
              </div>
              <h3 className="text-base font-semibold">确认重启</h3>
            </div>
            <p className="text-sm text-zinc-400 mb-6">
              {confirmTarget === 'all'
                ? '确定要重启所有可重启服务吗？这将依次重启 rangerai-agent、openclaw-gateway、rangerai-static。'
                : `确定要重启 ${confirmTarget} 吗？服务将短暂不可用。`}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmTarget(null)}
                className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => confirmTarget === 'all' ? handleRestartAll() : handleRestart(confirmTarget)}
                className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium transition-colors"
              >
                确认重启
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restartable Services */}
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800/60 flex items-center gap-2">
          <Power size={16} className="text-orange-400" />
          <span className="text-sm font-medium">可重启服务</span>
          <span className="text-xs text-zinc-500 ml-1">({restartableServices.length})</span>
        </div>
        <div className="divide-y divide-zinc-800/40">
          {restartableServices.map(svc => (
            <div key={svc.service} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-800/20 transition-colors">
              <div className="flex items-center gap-3">
                {getStatusIcon(svc.status)}
                <div>
                  <div className="text-sm font-medium">{svc.service}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    <span className={getStatusColor(svc.status)}>{svc.status === 'active' ? '运行中' : svc.status}</span>
                    <span className="mx-1.5">·</span>
                    <span>{svc.uptime}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setConfirmTarget(svc.service)}
                disabled={restartingService === svc.service}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600/10 hover:bg-orange-600/20 text-orange-400 text-xs font-medium transition-colors disabled:opacity-50 border border-orange-600/20"
              >
                {restartingService === svc.service ? (
                  <><Loader2 size={13} className="animate-spin" /> 重启中...</>
                ) : (
                  <><RotateCcw size={13} /> 重启</>
                )}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Non-restartable Services */}
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800/60 flex items-center gap-2">
          <ServerCrash size={16} className="text-zinc-500" />
          <span className="text-sm font-medium text-zinc-400">其他服务（仅监控）</span>
          <span className="text-xs text-zinc-500 ml-1">({otherServices.length})</span>
        </div>
        <div className="divide-y divide-zinc-800/40">
          {otherServices.map(svc => (
            <div key={svc.service} className="flex items-center px-4 py-3">
              <div className="flex items-center gap-3">
                {getStatusIcon(svc.status)}
                <div>
                  <div className="text-sm font-medium text-zinc-400">{svc.service}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    <span className={getStatusColor(svc.status)}>{svc.status === 'active' ? '运行中' : svc.status}</span>
                    <span className="mx-1.5">·</span>
                    <span>{svc.uptime}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Restart All Button */}
      <div className="flex justify-center pt-2">
        <button
          onClick={() => setConfirmTarget('all')}
          disabled={restartingService !== null}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-red-600/10 hover:bg-red-600/20 text-red-400 text-sm font-medium transition-colors disabled:opacity-50 border border-red-600/20"
        >
          <AlertTriangle size={16} />
          重启所有可重启服务
        </button>
      </div>

      {/* Tips */}
      <div className="text-xs text-zinc-600 text-center space-y-1">
        <p>rangerai-agent 有 5 分钟冷却时间保护，频繁重启将被拒绝</p>
        <p>重启后需要 5-10 秒恢复，期间服务暂时不可用</p>
      </div>
    </div>
  );
}
