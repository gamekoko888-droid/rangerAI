/**
 * PageLoadingSkeleton — Reusable loading skeleton for page-level loading states.
 * Provides consistent visual feedback across all pages.
 */
import { Skeleton } from './ui/skeleton';

interface PageLoadingSkeletonProps {
  /** Number of card-like skeleton rows to show */
  rows?: number;
  /** Whether to show a header skeleton */
  showHeader?: boolean;
  /** Layout variant */
  variant?: 'cards' | 'list' | 'stats';
}

export function PageLoadingSkeleton({ rows = 3, showHeader = true, variant = 'cards' }: PageLoadingSkeletonProps) {
  if (variant === 'stats') {
    return (
      <div className="space-y-6 p-4 sm:p-6 animate-in fade-in duration-300">
        {/* Stats cards row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-4 space-y-3">
              <Skeleton className="h-3 w-16 bg-zinc-700/50" />
              <Skeleton className="h-7 w-20 bg-zinc-700/50" />
              <Skeleton className="h-2 w-12 bg-zinc-700/50" />
            </div>
          ))}
        </div>
        {/* Chart placeholder */}
        <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-4 space-y-3">
          <Skeleton className="h-4 w-32 bg-zinc-700/50" />
          <Skeleton className="h-48 w-full bg-zinc-700/50" />
        </div>
      </div>
    );
  }

  if (variant === 'list') {
    return (
      <div className="space-y-2 p-4 animate-in fade-in duration-300">
        {showHeader && (
          <div className="flex items-center gap-3 mb-4">
            <Skeleton className="h-5 w-5 rounded bg-zinc-700/50" />
            <Skeleton className="h-5 w-40 bg-zinc-700/50" />
          </div>
        )}
        {[...Array(rows)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-zinc-800/30">
            <Skeleton className="h-8 w-8 rounded-full bg-zinc-700/50" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/3 bg-zinc-700/50" />
              <Skeleton className="h-2.5 w-1/3 bg-zinc-700/50" />
            </div>
            <Skeleton className="h-6 w-16 rounded bg-zinc-700/50" />
          </div>
        ))}
      </div>
    );
  }

  // Default: cards variant
  return (
    <div className="space-y-4 p-4 animate-in fade-in duration-300">
      {showHeader && (
        <div className="flex items-center gap-3 mb-2">
          <Skeleton className="h-5 w-5 rounded bg-zinc-700/50" />
          <Skeleton className="h-5 w-48 bg-zinc-700/50" />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[...Array(rows)].map((_, i) => (
          <div key={i} className="bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32 bg-zinc-700/50" />
              <Skeleton className="h-5 w-14 rounded-full bg-zinc-700/50" />
            </div>
            <Skeleton className="h-3 w-full bg-zinc-700/50" />
            <Skeleton className="h-3 w-4/5 bg-zinc-700/50" />
            <div className="flex items-center gap-2 pt-1">
              <Skeleton className="h-3 w-10 bg-zinc-700/50" />
              <Skeleton className="h-6 w-16 rounded bg-zinc-700/50" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
