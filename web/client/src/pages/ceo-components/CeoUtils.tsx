/**
 * CeoUtils.tsx — Utility components for CEO Dashboard
 * Extracted from CeoDashboard.tsx (Iter-59)
 */
import React from 'react';

export function ChangeIndicator({ change }: { change: number }) {
  const isPositive = change >= 0;
  return (
    <span className={`inline-flex items-center text-xs font-medium ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
      {isPositive ? '↑' : '↓'} {Math.abs(change).toFixed(1)}%
    </span>
  );
}

export function StatusDot({ status }: { status: 'normal' | 'busy' | 'idle' }) {
  const colors = {
    normal: 'bg-emerald-400',
    busy: 'bg-amber-400',
    idle: 'bg-zinc-500',
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[status]} animate-pulse`} />
  );
}

export function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? (completed / total) * 100 : 0;
  return (
    <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
      <div
        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function AlertIcon({ type }: { type: 'warning' | 'error' | 'info' }) {
  const icons: Record<string, string> = { warning: '⚠️', error: '🔴', info: 'ℹ️' };
  return <span>{icons[type] || '📌'}</span>;
}

export function formatCurrency(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
