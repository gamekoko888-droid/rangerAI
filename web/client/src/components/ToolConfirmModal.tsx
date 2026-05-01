/**
 * ToolConfirmModal — R8 Task 2: Tool Confirmation Modal
 * 
 * Listens for 'rangerai:tool_confirm' CustomEvents dispatched by useChatStore
 * when the backend sends a 'tool:confirm_required' WebSocket event.
 * 
 * Displays:
 *   - Tool name + high-risk warning
 *   - Tool arguments (formatted JSON)
 *   - Countdown timer (auto-reject on expiry)
 *   - Confirm / Reject buttons
 * 
 * Sends response back via WebSocket: { type: 'tool:confirm_response', confirmId, approved, sessionKey }
 * 
 * Usage: Mount once in ChatPage or App.tsx:
 *   <ToolConfirmModal wsSend={wsSend} />
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, ShieldAlert, Clock, Check, X } from 'lucide-react';

interface ToolConfirmRequest {
  confirmId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionKey?: string;
}

interface ToolConfirmModalProps {
  wsSend: (data: Record<string, unknown>) => void;
}

const COUNTDOWN_SECONDS = 30;

// High-risk tool categories for visual emphasis
const HIGH_RISK_TOOLS: Record<string, string> = {
  'exec': '执行系统命令',
  'shell': '执行 Shell 命令',
  'file_write': '写入文件',
  'file_delete': '删除文件',
  'browser_navigate': '浏览器导航',
  'browser_click': '浏览器点击',
  'http_request': 'HTTP 请求',
  'database_query': '数据库操作',
};

function getRiskLevel(toolName: string): 'critical' | 'high' | 'normal' {
  const lower = toolName.toLowerCase();
  if (lower.includes('exec') || lower.includes('shell') || lower.includes('delete') || lower.includes('rm ')) return 'critical';
  if (lower.includes('write') || lower.includes('browser') || lower.includes('http') || lower.includes('database')) return 'high';
  return 'normal';
}

function formatToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function ToolConfirmModal({ wsSend }: ToolConfirmModalProps) {
  const [request, setRequest] = useState<ToolConfirmRequest | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [responded, setResponded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for tool confirm events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ToolConfirmRequest;
      if (detail?.confirmId && detail?.toolName) {
        console.log('[ToolConfirmModal] Received confirm request:', detail.confirmId, detail.toolName);
        setRequest(detail);
        setCountdown(COUNTDOWN_SECONDS);
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
  }, [request, responded]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResponse = useCallback((approved: boolean) => {
    if (!request || responded) return;
    
    console.log(`[ToolConfirmModal] ${approved ? 'APPROVED' : 'REJECTED'}: ${request.confirmId}`);
    setResponded(true);
    if (timerRef.current) clearInterval(timerRef.current);

    wsSend({
      type: 'tool:confirm_response',
      confirmId: request.confirmId,
      approved,
      sessionKey: request.sessionKey,
    });

    // Auto-dismiss after response
    setTimeout(() => setRequest(null), 500);
  }, [request, responded, wsSend]);

  if (!request) return null;

  const riskLevel = getRiskLevel(request.toolName);
  const riskLabel = HIGH_RISK_TOOLS[request.toolName] || request.toolName;
  const argsStr = formatToolArgs(request.toolArgs);
  const countdownPct = (countdown / COUNTDOWN_SECONDS) * 100;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={() => handleResponse(false)}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Countdown progress bar */}
        <div className="h-1 bg-zinc-800 relative overflow-hidden">
          <div
            className={`h-full transition-all duration-1000 ease-linear ${
              countdown <= 10 ? 'bg-red-500' : countdown <= 20 ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${countdownPct}%` }}
          />
        </div>

        {/* Header */}
        <div className="p-5 pb-3">
          <div className="flex items-start gap-3">
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                riskLevel === 'critical'
                  ? 'bg-red-500/15 ring-1 ring-red-500/30'
                  : riskLevel === 'high'
                  ? 'bg-amber-500/15 ring-1 ring-amber-500/30'
                  : 'bg-blue-500/15 ring-1 ring-blue-500/30'
              }`}
            >
              {riskLevel === 'critical' ? (
                <ShieldAlert size={20} className="text-red-400" />
              ) : (
                <AlertTriangle size={20} className={riskLevel === 'high' ? 'text-amber-400' : 'text-blue-400'} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-white mb-0.5">
                {riskLevel === 'critical' ? '⚠️ 高危操作确认' : '工具执行确认'}
              </h3>
              <p className="text-sm text-zinc-400">
                Agent 请求执行 <span className="text-white font-medium">{riskLabel}</span>
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 shrink-0">
              <Clock size={14} />
              <span className={countdown <= 10 ? 'text-red-400 font-medium' : ''}>{countdown}s</span>
            </div>
          </div>
        </div>

        {/* Tool arguments */}
        <div className="px-5 pb-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 max-h-48 overflow-y-auto">
            <div className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">参数详情</div>
            <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
              {argsStr}
            </pre>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-5 pb-5">
          <button
            onClick={() => handleResponse(false)}
            disabled={responded}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium rounded-lg border border-zinc-700 transition-colors disabled:opacity-50"
          >
            <X size={16} />
            拒绝
          </button>
          <button
            onClick={() => handleResponse(true)}
            disabled={responded}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
              riskLevel === 'critical'
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            <Check size={16} />
            确认执行
          </button>
        </div>
      </div>
    </div>
  );
}
