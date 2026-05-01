import React, { useEffect, useState } from 'react';
import { AlertCircle, Zap, AlertTriangle } from 'lucide-react';
import { logger } from "../../lib/logger";

export const IssueDashboard: React.FC = () => {
  const [issues, setIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchIssues = async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/reports/dingtalk/daily-issues');
        const data = await res.json();
        if (data.success && data.data) {
          setIssues(data.data);
        }
      } catch (err) {
        logger.error('Failed to fetch AI issues', err);
      } finally {
        setLoading(false);
      }
    };
    fetchIssues();
  }, []);

  if (issues.length === 0) return null;

  return (
    <div className="mb-6 w-full max-w-full overflow-hidden bg-red-950/20 border border-red-900/50 rounded-xl shadow-sm shadow-red-900/10">
      <div className="bg-red-900/30 px-5 py-3.5 border-b border-red-900/40 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <AlertTriangle size={18} className="text-red-400" />
          <h3 className="text-[15px] font-medium text-red-200 truncate min-w-0">今日高危业务指标阻断报警 ({issues.length})</h3>
        </div>
        <div className="text-xs text-red-400/80 bg-red-950/50 px-2 py-1 rounded inline-flex items-center shrink-0 max-w-full truncate whitespace-nowrap">自动拦截</div>
      </div>
      <div className="p-5 grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {issues.map(issue => (
          <div key={issue.id} className="flex w-full min-w-0 overflow-hidden gap-3.5 items-start bg-zinc-950/40 p-4 rounded-lg border border-red-900/20 hover:border-red-500/30 transition-colors">
            <div className="p-2 bg-red-900/20 rounded-lg shrink-0 mt-0.5">
              <Zap size={16} className="text-red-400" />
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-0 mb-2">
                <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0 mr-2">
                  <span className="text-sm font-semibold text-zinc-200 truncate max-w-[140px] sm:max-w-[220px]">{issue.creator_name}</span>
                  <span className="text-xs text-zinc-500 truncate flex-1 min-w-0">| {issue.template_name?.replace('日报', '')}</span>
                </div>
                {issue.issue_type && (
                  <span className="shrink-0 ml-2 px-2 py-0.5 rounded-sm text-[10px] uppercase font-bold tracking-wider bg-red-500/10 text-red-400 border border-red-500/20 max-w-[120px] truncate">
                    {issue.issue_type}
                  </span>
                )}
              </div>
              <p className="text-[13px] leading-relaxed text-zinc-400 break-words whitespace-pre-wrap line-clamp-3">{issue.ai_summary}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
