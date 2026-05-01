/**
 * useAutoRefresh — 数据面板自动刷新 Hook
 * 提供可配置的刷新间隔 + 手动刷新 + 倒计时显示
 */

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseAutoRefreshOptions {
  /** 默认刷新间隔（秒），0 表示关闭自动刷新 */
  defaultInterval?: number;
  /** 可选的刷新间隔列表（秒） */
  intervals?: number[];
  /** 刷新回调 */
  onRefresh: () => void | Promise<void>;
  /** 是否启用 */
  enabled?: boolean;
}

interface UseAutoRefreshReturn {
  /** 当前刷新间隔（秒） */
  interval: number;
  /** 设置刷新间隔 */
  setInterval: (seconds: number) => void;
  /** 距下次刷新的剩余秒数 */
  countdown: number;
  /** 是否正在刷新 */
  isRefreshing: boolean;
  /** 手动触发刷新 */
  refresh: () => void;
  /** 上次刷新时间 */
  lastRefreshed: Date | null;
  /** 可选的间隔列表 */
  intervals: number[];
}

export function useAutoRefresh({
  defaultInterval = 0,
  intervals = [0, 30, 60, 120, 300],
  onRefresh,
  enabled = true,
}: UseAutoRefreshOptions): UseAutoRefreshReturn {
  const [interval, setIntervalState] = useState(defaultInterval);
  const [countdown, setCountdown] = useState(defaultInterval);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefreshRef.current();
      setLastRefreshed(new Date());
    } finally {
      setIsRefreshing(false);
      setCountdown(interval);
    }
  }, [interval]);

  const setInterval = useCallback((seconds: number) => {
    setIntervalState(seconds);
    setCountdown(seconds);
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!enabled || interval <= 0) return;

    const timer = window.setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // Trigger refresh
          refresh();
          return interval;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [enabled, interval, refresh]);

  return {
    interval,
    setInterval,
    countdown,
    isRefreshing,
    refresh,
    lastRefreshed,
    intervals,
  };
}

/** 格式化倒计时显示 */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '已停止';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

/** 格式化间隔选项标签 */
export function formatIntervalLabel(seconds: number): string {
  if (seconds === 0) return '关闭';
  if (seconds < 60) return `${seconds}秒`;
  return `${seconds / 60}分钟`;
}
