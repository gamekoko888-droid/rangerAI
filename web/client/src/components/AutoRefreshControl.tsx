/**
 * AutoRefreshControl — 自动刷新控制组件
 * 显示刷新间隔选择、倒计时、手动刷新按钮
 */

import { RefreshCw, Timer } from 'lucide-react';
import { formatCountdown, formatIntervalLabel } from '../hooks/useAutoRefresh';

interface AutoRefreshControlProps {
  interval: number;
  setInterval: (seconds: number) => void;
  countdown: number;
  isRefreshing: boolean;
  refresh: () => void;
  lastRefreshed: Date | null;
  intervals: number[];
}

export function AutoRefreshControl({
  interval,
  setInterval,
  countdown,
  isRefreshing,
  refresh,
  lastRefreshed,
  intervals,
}: AutoRefreshControlProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {/* Interval selector */}
      <select
        value={interval}
        onChange={e => setInterval(Number(e.target.value))}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 outline-none cursor-pointer"
      >
        {intervals.map(s => (
          <option key={s} value={s}>{formatIntervalLabel(s)}</option>
        ))}
      </select>

      {/* Countdown */}
      {interval > 0 && (
        <span className="text-zinc-500 flex items-center gap-1">
          <Timer size={10} />
          {formatCountdown(countdown)}
        </span>
      )}

      {/* Manual refresh */}
      <button
        onClick={refresh}
        disabled={isRefreshing}
        className="p-1.5 hover:bg-zinc-800 rounded transition disabled:opacity-50"
        title="手动刷新"
      >
        <RefreshCw size={12} className={`text-zinc-400 ${isRefreshing ? 'animate-spin' : ''}`} />
      </button>

      {/* Last refreshed */}
      {lastRefreshed && (
        <span className="text-[10px] text-zinc-600 hidden sm:inline">
          {lastRefreshed.toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
