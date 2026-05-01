/**
 * ConfirmDialog — Reusable confirmation dialog to replace native confirm().
 * 
 * Usage:
 *   const { confirm, ConfirmDialogUI } = useConfirmDialog();
 *   
 *   // In handler:
 *   const ok = await confirm({ title: 'Delete?', message: 'This cannot be undone.', variant: 'danger' });
 *   if (!ok) return;
 *   
 *   // In JSX:
 *   return <>{ConfirmDialogUI}</>
 */

import { useState, useCallback, useRef } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface ConfirmOptions {
  title: string;
  message: string;
  variant?: 'danger' | 'warning' | 'info';
  confirmText?: string;
  cancelText?: string;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

export function useConfirmDialog() {
  const [state, setState] = useState<ConfirmState>({
    open: false,
    title: '',
    message: '',
    variant: 'info',
  });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ ...options, open: true });
    });
  }, []);

  const handleClose = useCallback((result: boolean) => {
    setState((s) => ({ ...s, open: false }));
    resolveRef.current?.(result);
    resolveRef.current = null;
  }, []);

  const ConfirmDialogUI = state.open ? (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => handleClose(false)}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                state.variant === 'danger'
                  ? 'bg-red-500/10'
                  : state.variant === 'warning'
                  ? 'bg-amber-500/10'
                  : 'bg-blue-500/10'
              }`}
            >
              {state.variant === 'danger' ? (
                <Trash2
                  size={18}
                  className="text-red-400"
                />
              ) : (
                <AlertTriangle
                  size={18}
                  className={
                    state.variant === 'warning'
                      ? 'text-amber-400'
                      : 'text-blue-400'
                  }
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-white mb-1">
                {state.title}
              </h3>
              <p className="text-sm text-zinc-400 leading-relaxed">
                {state.message}
              </p>
            </div>
            <button
              onClick={() => handleClose(false)}
              className="p-1 rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={() => handleClose(false)}
            className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium rounded-lg border border-zinc-700 transition-colors"
          >
            {state.cancelText || 'Cancel'}
          </button>
          <button
            onClick={() => handleClose(true)}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              state.variant === 'danger'
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : state.variant === 'warning'
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {state.confirmText || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, ConfirmDialogUI };
}
