/**
 * ToolConfirmModal — R55 Task1
 * Displays a confirmation dialog when a CRITICAL tool requires user approval.
 * Listens for 'rangerai:tool_confirm' CustomEvent dispatched by useChatStore.
 * Sends tool_confirm_response via WebSocket on approve/reject.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, ShieldAlert, X, Clock } from 'lucide-react';

interface ToolConfirmRequest {
  confirmId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionKey?: string;
}

interface ToolConfirmModalProps {
  wsSend: (data: unknown) => void;
}

const CONFIRM_TIMEOUT = 15; // seconds

/** Extract a human-readable description from tool args */
function describeToolAction(toolName: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  
  // Common arg keys that carry meaningful info
  const descKeys = ['command', 'query', 'sql', 'path', 'action', 'target', 'name', 'description'];
  for (const key of descKeys) {
    if (args[key] && typeof args[key] === 'string') {
      const val = args[key] as string;
      parts.push(`${key}: ${val.length > 120 ? val.substring(0, 120) + '…' : val}`);
    }
  }
  
  if (parts.length === 0) {
    // Fallback: show first few arg keys
    const keys = Object.keys(args).slice(0, 3);
    if (keys.length > 0) {
      parts.push(keys.map(k => `${k}: ${String(args[k]).substring(0, 60)}`).join(', '));
    }
  }
  
  return parts.join('\n') || '(无参数详情)';
}

/** Map tool names to readable Chinese labels */
function getToolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    system_restart: '系统重启',
    database_drop: '数据库删除',
    config_change: '配置变更',
    file_delete: '文件删除',
    service_stop: '服务停止',
  };
  return labels[toolName] || toolName;
}

export function ToolConfirmModal({ wsSend }: ToolConfirmModalProps) {
  const [request, setRequest] = useState<ToolConfirmRequest | null>(null);
  const [countdown, setCountdown] = useState(CONFIRM_TIMEOUT);
  const [responded, setResponded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for tool confirm events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToolConfirmRequest>).detail;
      if (detail?.confirmId) {
        setRequest(detail);
        setCountdown(CONFIRM_TIMEOUT);
        setResponded(false);
      }
    };
    window.addEventListener('rangerai:tool_confirm', handler);
    return () => window.removeEventListener('rangerai:tool_confirm', handler);
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!request || responded) return;
    
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // Auto-reject on timeout
          handleResponse(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [request, responded]);

  const handleResponse = useCallback((approved: boolean) => {
    if (!request || responded) return;
    setResponded(true);
    if (timerRef.current) clearInterval(timerRef.current);

    wsSend({
      type: 'tool_confirm_response',
      confirmId: request.confirmId,
      approved,
    });

    // Close modal after brief feedback
    setTimeout(() => {
      setRequest(null);
    }, 800);
  }, [request, responded, wsSend]);

  if (!request) return null;

  const progressPct = (countdown / CONFIRM_TIMEOUT) * 100;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-md mx-4 bg-zinc-900 border border-red-500/30 rounded-xl shadow-2xl shadow-red-500/10 overflow-hidden">
        {/* Countdown progress bar */}
        <div className="absolute top-0 left-0 h-1 bg-red-500 transition-all duration-1000 ease-linear"
             style={{ width: `${progressPct}%` }} />

        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-red-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-zinc-100">
              高危操作确认
            </h3>
            <p className="text-sm text-zinc-400 mt-0.5">
              以下操作需要您的确认才能执行
            </p>
          </div>
          <button
            onClick={() => handleResponse(false)}
            className="flex-shrink-0 p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-3 space-y-3">
          {/* Tool name badge */}
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/15 text-red-400 text-sm font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              {getToolLabel(request.toolName)}
            </span>
          </div>

          {/* Tool args detail */}
          <div className="bg-zinc-800/60 rounded-lg p-3 border border-zinc-700/50">
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-32 overflow-y-auto">
              {describeToolAction(request.toolName, request.toolArgs)}
            </pre>
          </div>

          {/* Countdown */}
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Clock className="w-3.5 h-3.5" />
            {responded ? (
              <span className="text-zinc-400">已响应</span>
            ) : (
              <span>{countdown}s 后自动拒绝</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 px-5 pb-5 pt-2">
          <button
            onClick={() => handleResponse(false)}
            disabled={responded}
            className="flex-1 px-4 py-2.5 rounded-lg bg-zinc-800 text-zinc-300 text-sm font-medium
                       hover:bg-zinc-700 active:scale-[0.98] transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed
                       border border-zinc-700"
          >
            取消
          </button>
          <button
            onClick={() => handleResponse(true)}
            disabled={responded}
            className="flex-1 px-4 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium
                       hover:bg-red-500 active:scale-[0.98] transition-all
                       disabled:opacity-50 disabled:cursor-not-allowed
                       shadow-lg shadow-red-500/20"
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  );
}
