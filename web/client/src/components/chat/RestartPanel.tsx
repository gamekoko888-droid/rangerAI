/**
 * RestartPanel — 服务重启面板
 * 独立 Popover 组件，与文件树按钮平级放在顶部工具栏。
 * 仅 admin 用户可见。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import * as api from '../../lib/api';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import {
  RotateCcw, Power, Cpu, Globe, Database, Server,
  RefreshCw, Loader2, X, ChevronDown,
} from 'lucide-react';

interface ServiceItem {
  id: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  danger?: boolean;
}

const SERVICES: ServiceItem[] = [
  { id: 'worker',         label: 'Agent Worker',   desc: '重启 AI 子进程，恢复卡死任务',              icon: <Cpu size={13} /> },
  { id: 'rangerai-agent', label: 'RangerAI Agent', desc: '重启后端主服务（3秒延迟，连接短暂断开）',   icon: <Server size={13} />, danger: true },
  { id: 'rangerai-web',   label: '前端静态服务',   desc: '重启 Node.js 静态文件服务',                 icon: <Globe size={13} /> },
  { id: 'caddy',          label: 'Caddy 热重载',   desc: '重载反向代理配置（无中断）',                icon: <RotateCcw size={13} /> },
  { id: 'redis',          label: 'Redis',          desc: '重启缓存数据库',                            icon: <Database size={13} />, danger: true },
];

export function RestartPanel() {
  const user = useAuthStore(s => s.user);
  const [open, setOpen] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string } | undefined>>({});
  const [svcStatus, setSvcStatus] = useState<Record<string, string>>({});
  const [workerStatus, setWorkerStatus] = useState<{ ready?: boolean; pendingTasks?: number; gatewayConnected?: boolean } | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const isAdmin = user?.role === 'admin';

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const fetchStatus = useCallback(async () => {
    if (!isAdmin) return;
    setStatusLoading(true);
    try {
      const data = await api.apiFetch<any>('/api/admin/services/status');
      if (data.ok) {
        setSvcStatus(data.services || {});
        setWorkerStatus(data.worker || null);
      }
    } catch { /* silent */ }
    finally { setStatusLoading(false); }
  }, [isAdmin]);

  // Fetch status when panel opens
  useEffect(() => {
    if (open) fetchStatus();
  }, [open, fetchStatus]);

  const handleRestart = useCallback(async (svcId: string) => {
    setLoadingId(svcId);
    setResults(r => ({ ...r, [svcId]: undefined }));
    try {
      const data = await api.apiFetch<any>(`/api/admin/restart/${svcId}`, { method: 'POST' });
      setResults(r => ({ ...r, [svcId]: { ok: data.ok, message: data.message || data.error } }));
      // Re-fetch status 3s later
      setTimeout(fetchStatus, 3000);
    } catch (err: any) {
      setResults(r => ({ ...r, [svcId]: { ok: false, message: err.message || '请求失败' } }));
    } finally {
      setLoadingId(null);
    }
  }, [fetchStatus]);

  if (!isAdmin) return null;

  return (
    <div ref={panelRef} className="relative">
      {/* Trigger button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setOpen(v => !v)}
            className={`p-1.5 rounded-md transition-colors relative ${
              open
                ? 'text-orange-400 hover:text-orange-300 bg-orange-500/10'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
            aria-label="服务重启面板"
          >
            <Power size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent>服务重启面板</TooltipContent>
      </Tooltip>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <div className="flex items-center gap-1.5">
              <Power size={12} className="text-orange-400" />
              <span className="text-xs font-semibold text-zinc-300">服务重启面板</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={fetchStatus}
                disabled={statusLoading}
                className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                title="刷新状态"
              >
                <RefreshCw size={11} className={statusLoading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X size={11} />
              </button>
            </div>
          </div>

          {/* Worker status bar */}
          {workerStatus && (
            <div className="mx-3 mt-2 px-2 py-1.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] flex items-center gap-3 flex-wrap">
              <span className={`flex items-center gap-1 ${workerStatus.ready ? 'text-emerald-400' : 'text-red-400'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${workerStatus.ready ? 'bg-emerald-400' : 'bg-red-400'}`} />
                Worker {workerStatus.ready ? '正常' : '异常'}
              </span>
              <span className={`flex items-center gap-1 ${workerStatus.gatewayConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${workerStatus.gatewayConnected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                Gateway {workerStatus.gatewayConnected ? '已连接' : '断开'}
              </span>
              {(workerStatus.pendingTasks ?? 0) > 0 && (
                <span className="text-amber-400">队列: {workerStatus.pendingTasks}</span>
              )}
            </div>
          )}

          {/* Service list */}
          <div className="px-2 py-2 space-y-0.5">
            {SERVICES.map(svc => {
              const status = svcStatus[svc.id];
              const result = results[svc.id];
              const isLoading = loadingId === svc.id;
              return (
                <div
                  key={svc.id}
                  className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-zinc-800/60 transition-colors"
                >
                  {/* Status dot */}
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    status === 'active' ? 'bg-emerald-400' :
                    status === 'inactive' ? 'bg-red-400' : 'bg-zinc-600'
                  }`} />

                  <span className="text-zinc-500 shrink-0">{svc.icon}</span>

                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-zinc-200 leading-tight">{svc.label}</div>
                    {result ? (
                      <div className={`text-[10px] leading-tight mt-0.5 ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                        {result.ok ? '✓ ' : '✗ '}{result.message}
                      </div>
                    ) : (
                      <div className="text-[10px] text-zinc-500 leading-tight mt-0.5">{svc.desc}</div>
                    )}
                  </div>

                  {/* Restart button */}
                  <button
                    onClick={() => handleRestart(svc.id)}
                    disabled={isLoading || loadingId !== null}
                    title={svc.danger ? `⚠ 重启 ${svc.label}` : `重启 ${svc.label}`}
                    className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                      svc.danger
                        ? 'text-orange-400 hover:text-orange-200 hover:bg-orange-500/15 border border-orange-500/30'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 border border-zinc-700'
                    }`}
                  >
                    {isLoading
                      ? <Loader2 size={11} className="animate-spin" />
                      : <RotateCcw size={11} />
                    }
                    重启
                  </button>
                </div>
              );
            })}
          </div>

          <div className="px-3 py-2 border-t border-zinc-800 text-[10px] text-zinc-600">
            橙色按钮为高风险操作，重启前请确认无进行中任务
          </div>
        </div>
      )}
    </div>
  );
}
