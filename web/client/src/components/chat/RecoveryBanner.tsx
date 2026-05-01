/**
 * RecoveryBanner — Shows a banner when the system is recovering a task after reconnection.
 * v2: Added "gave up" state with manual reconnect button.
 * v3: Added task recovery progress phases (recovering_task / recovered / failed).
 */
import { useConnectionStore } from '../../stores/useConnectionStore';
import { Loader2, Wifi, WifiOff, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';

interface RecoveryBannerProps {
  onForceReconnect?: () => void;
}

export function RecoveryBanner({ onForceReconnect }: RecoveryBannerProps) {
  const wsReconnecting = useConnectionStore(s => s.wsReconnecting);
  const wsReconnectAttempt = useConnectionStore(s => s.wsReconnectAttempt);
  const wsGaveUp = useConnectionStore(s => s.wsGaveUp);
  const recoveryPhase = useConnectionStore(s => s.recoveryPhase);
  const recoveryMessage = useConnectionStore(s => s.recoveryMessage);

  // Show "gave up" banner with reconnect button
  if (wsGaveUp) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-2">
        <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          <WifiOff size={14} className="shrink-0" />
          <span className="flex-1">连接已断开，自动重连失败</span>
          {onForceReconnect && (
            <button
              onClick={() => {
                useConnectionStore.getState().setWsGaveUp(false);
                onForceReconnect();
              }}
              className="flex items-center gap-1 px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 hover:text-red-200 transition-colors text-xs font-medium"
            >
              <RefreshCw size={12} />
              重新连接
            </button>
          )}
        </div>
      </div>
    );
  }

  // v3: Show task recovery progress (after WS reconnected, recovering task state)
  if (recoveryPhase === 'recovering_task') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-2">
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-sm text-amber-400">
          <RefreshCw size={14} className="animate-spin shrink-0" />
          <span className="flex-1">{recoveryMessage || '正在恢复任务...'}</span>
        </div>
      </div>
    );
  }

  // v3: Task successfully recovered — brief success indicator
  if (recoveryPhase === 'recovered') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-2">
        <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-sm text-emerald-400">
          <CheckCircle2 size={14} className="shrink-0" />
          <span className="flex-1">{recoveryMessage || '任务已恢复'}</span>
        </div>
      </div>
    );
  }

  // v3: Task recovery failed
  if (recoveryPhase === 'failed') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-2">
        <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">{recoveryMessage || '任务恢复失败'}</span>
          {onForceReconnect && (
            <button
              onClick={() => {
                useConnectionStore.getState().setRecoveryPhase('idle');
                onForceReconnect();
              }}
              className="flex items-center gap-1 px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-300 hover:text-red-200 transition-colors text-xs font-medium"
            >
              <RefreshCw size={12} />
              重试
            </button>
          )}
        </div>
      </div>
    );
  }

  // Show reconnecting banner
  if (!wsReconnecting) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-2">
      <div className="flex items-center gap-2 rounded-lg bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-sm text-blue-400">
        <Wifi size={14} className="shrink-0" />
        <Loader2 size={14} className="animate-spin shrink-0" />
        <span>
          {wsReconnectAttempt > 0
            ? `正在重新连接... (${wsReconnectAttempt})`
            : '正在恢复连接...'}
        </span>
      </div>
    </div>
  );
}
