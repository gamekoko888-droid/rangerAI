/**
 * SupervisorMetricsTab — R18-T1 + R21-T2/T5: Supervisor decision metrics dashboard.
 * Shows aggregated statistics, action/risk/outcome distributions, recent decisions,
 * escalation action buttons, batch review, and audit log.
 */
import { useState, useEffect, useCallback } from 'react';
import { fetchAdmin } from './shared';
import {
  Loader2, RefreshCw, ShieldAlert, CheckCircle2, XCircle,
  AlertTriangle, BarChart3, Target, TrendingUp, Ban, FileText,
} from 'lucide-react';
import { logger } from '../../lib/logger';

// ─── Types ──────────────────────────────────────────────────
interface SupervisorMetrics {
  total: number;
  interventionRate: number;
  overrideRate: number;
  actionDistribution: Record<string, number>;
  phaseDistribution: Record<string, number>;
  riskDistribution: Record<string, number>;
  outcomeDistribution: Record<string, number>;
  highRisk: {
    total: number;
    withOutcome: number;
    badOutcome: number;
    precision: number | null;
  };
  recentDecisions: RecentDecision[];
}

interface RecentDecision {
  id: number;
  taskId: string | null;
  sessionKey: string | null;
  phase: string;
  decisionAction: string;
  riskLevel: string;
  reason: string;
  finalOutcome: string | null;
  overrideByUser: boolean;
  timestamp: string;
  escalationStatus: string | null;
}

interface AuditEntry {
  id: number;
  action: string;
  operator_id: string;
  note: string;
  createdAt: string;
}

// ─── Helpers ────────────────────────────────────────────────
const ACTION_COLORS: Record<string, string> = {
  allow: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  warn: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  block: 'bg-red-500/20 text-red-400 border-red-500/30',
  replan: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

const RISK_COLORS: Record<string, string> = {
  low: 'bg-emerald-500/20 text-emerald-400',
  medium: 'bg-amber-500/20 text-amber-400',
  high: 'bg-red-500/20 text-red-400',
};

const OUTCOME_COLORS: Record<string, string> = {
  success: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-red-500/20 text-red-400',
  escalated: 'bg-orange-500/20 text-orange-400',
  user_cancelled: 'bg-gray-500/20 text-gray-400',
};

const ESCALATION_COLORS: Record<string, string> = {
  approved: 'bg-emerald-500/20 text-emerald-400',
  rejected: 'bg-red-500/20 text-red-400',
  escalated: 'bg-amber-500/20 text-amber-400',
  pending: 'bg-zinc-500/20 text-zinc-400',
};

const ACTION_ICONS: Record<string, React.ElementType> = {
  allow: CheckCircle2,
  warn: AlertTriangle,
  block: Ban,
  replan: Target,
};

function Badge({ text, colorClass }: { text: string; colorClass: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}>
      {text}
    </span>
  );
}

function DistributionBar({ data, colors }: { data: Record<string, number>; colors: Record<string, string> }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  if (total === 0) return <div className="text-zinc-500 text-sm">No data</div>;
  return (
    <div className="space-y-2">
      {Object.entries(data).sort(([, a], [, b]) => b - a).map(([key, count]) => {
        const pct = Math.round((count / total) * 100);
        const color = colors[key] || 'bg-zinc-500/20 text-zinc-400';
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-20 text-right font-mono">{key}</span>
            <div className="flex-1 h-5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color.split(' ')[0]} transition-all duration-500`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-zinc-300 w-16 font-mono">{count} ({pct}%)</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────
export default function SupervisorMetricsTab() {
  const [metrics, setMetrics] = useState<SupervisorMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState<number | null>(null);

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin('/api/admin/supervisor-metrics');
      setMetrics(data);
    } catch (e: any) {
      logger.error('SupervisorMetricsTab load error:', e);
      setError(e.message || 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  // [R21-T2] Escalation action handler
  const handleEscalation = useCallback(async (decisionId: number, action: string) => {
    setActionLoading(decisionId);
    try {
      const note = action === 'escalate' ? 'Escalated for manual review' : `${action}d by admin`;
      await fetchAdmin('/api/admin/supervisor-escalation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId,
          status: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'escalated',
          action,
          operatorId: 'admin',
          note,
        }),
      });
      loadMetrics();
    } catch (err) {
      logger.error('Escalation failed', err);
    } finally {
      setActionLoading(null);
    }
  }, [loadMetrics]);

  // [R21-T2] Load audit log for a decision
  const loadAudit = useCallback(async (decisionId: number) => {
    if (showAudit === decisionId) { setShowAudit(null); return; }
    try {
      const data = await fetchAdmin(`/api/admin/escalation-audit?decisionId=${decisionId}`);
      setAuditLog(data?.logs || []);
      setShowAudit(decisionId);
    } catch (err) {
      logger.error('Audit load failed', err);
    }
  }, [showAudit]);

  // [R21-T5] Batch action handler
  const handleBatchAction = useCallback(async (action: string) => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      const ids = Array.from(selectedIds);
      for (const id of ids) {
        await fetchAdmin('/api/admin/supervisor-escalation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decisionId: id,
            status: action === 'approve' ? 'approved' : 'rejected',
            action,
            operatorId: 'admin',
            note: `Batch ${action} by admin`,
          }),
        });
      }
      setSelectedIds(new Set());
      loadMetrics();
    } catch (err) {
      logger.error('Batch action failed', err);
    } finally {
      setBatchLoading(false);
    }
  }, [selectedIds, loadMetrics]);

  // [R21-T5] Toggle selection
  const toggleSelect = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!metrics) return;
    if (selectedIds.size === metrics.recentDecisions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(metrics.recentDecisions.map(d => d.id)));
    }
  }, [metrics, selectedIds]);

  useEffect(() => { loadMetrics(); }, [loadMetrics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
        <span className="ml-2 text-zinc-400">Loading supervisor metrics...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400">
        <AlertTriangle className="w-5 h-5 inline mr-2" />
        {error}
        <button onClick={loadMetrics} className="ml-4 text-blue-400 hover:text-blue-300 text-sm">Retry</button>
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Supervisor Decision Metrics</h2>
          <p className="text-sm text-zinc-500 mt-1">R21: 干预评估闭环 — 决策统计、Escalation 操作与审计</p>
        </div>
        <button onClick={loadMetrics} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
            <BarChart3 className="w-4 h-4" /> Total Decisions
          </div>
          <div className="text-2xl font-bold text-zinc-100">{metrics.total}</div>
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
            <ShieldAlert className="w-4 h-4" /> Intervention Rate
          </div>
          <div className="text-2xl font-bold text-amber-400">{metrics.interventionRate}%</div>
          <div className="text-xs text-zinc-500 mt-1">non-allow / total</div>
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
            <Target className="w-4 h-4" /> Override Rate
          </div>
          <div className="text-2xl font-bold text-purple-400">{metrics.overrideRate}%</div>
          <div className="text-xs text-zinc-500 mt-1">user overrides</div>
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
            <TrendingUp className="w-4 h-4" /> High-Risk Precision
          </div>
          <div className="text-2xl font-bold text-red-400">
            {metrics.highRisk.precision !== null ? `${metrics.highRisk.precision}%` : 'N/A'}
          </div>
          <div className="text-xs text-zinc-500 mt-1">{metrics.highRisk.badOutcome}/{metrics.highRisk.withOutcome} bad outcomes</div>
        </div>
      </div>

      {/* Distribution Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Action Distribution</h3>
          <DistributionBar data={metrics.actionDistribution} colors={{
            allow: 'bg-emerald-500/60 text-emerald-400',
            warn: 'bg-amber-500/60 text-amber-400',
            block: 'bg-red-500/60 text-red-400',
            replan: 'bg-purple-500/60 text-purple-400',
          }} />
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Risk Level Distribution</h3>
          <DistributionBar data={metrics.riskDistribution} colors={{
            low: 'bg-emerald-500/60 text-emerald-400',
            medium: 'bg-amber-500/60 text-amber-400',
            high: 'bg-red-500/60 text-red-400',
          }} />
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Phase Distribution</h3>
          <DistributionBar data={metrics.phaseDistribution} colors={{
            preflight: 'bg-blue-500/60 text-blue-400',
            step_intervention: 'bg-orange-500/60 text-orange-400',
            final_review: 'bg-cyan-500/60 text-cyan-400',
          }} />
        </div>
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Outcome Distribution</h3>
          <DistributionBar data={metrics.outcomeDistribution} colors={{
            success: 'bg-emerald-500/60 text-emerald-400',
            failed: 'bg-red-500/60 text-red-400',
            escalated: 'bg-orange-500/60 text-orange-400',
            user_cancelled: 'bg-gray-500/60 text-gray-400',
          }} />
        </div>
      </div>

      {/* Recent Decisions Table with Escalation Actions */}
      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300">Recent Decisions (Last 10)</h3>
          {/* [R21-T5] Batch Action Bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">{selectedIds.size} selected</span>
              <button onClick={() => handleBatchAction('approve')} disabled={batchLoading}
                className="px-2 py-1 text-xs bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30 disabled:opacity-50 transition-colors">
                {batchLoading ? 'Processing...' : 'Batch Approve'}
              </button>
              <button onClick={() => handleBatchAction('reject')} disabled={batchLoading}
                className="px-2 py-1 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 disabled:opacity-50 transition-colors">
                {batchLoading ? 'Processing...' : 'Batch Reject'}
              </button>
              <button onClick={() => setSelectedIds(new Set())}
                className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">Clear</button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs border-b border-zinc-700/50">
                <th className="py-2 px-1 w-8">
                  <input type="checkbox"
                    checked={selectedIds.size === metrics.recentDecisions.length && metrics.recentDecisions.length > 0}
                    onChange={toggleSelectAll}
                    className="accent-blue-500" />
                </th>
                <th className="text-left py-2 px-2">ID</th>
                <th className="text-left py-2 px-2">Task</th>
                <th className="text-left py-2 px-2">Phase</th>
                <th className="text-left py-2 px-2">Action</th>
                <th className="text-left py-2 px-2">Risk</th>
                <th className="text-left py-2 px-2">Outcome</th>
                <th className="text-left py-2 px-2">Escalation</th>
                <th className="text-left py-2 px-2">Actions</th>
                <th className="text-left py-2 px-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {metrics.recentDecisions.map((d) => (
                <tr key={d.id} className={`border-b border-zinc-800/50 hover:bg-zinc-700/20 transition-colors ${selectedIds.has(d.id) ? 'bg-blue-500/5' : ''}`}>
                  <td className="py-2 px-1">
                    <input type="checkbox" checked={selectedIds.has(d.id)} onChange={() => toggleSelect(d.id)} className="accent-blue-500" />
                  </td>
                  <td className="py-2 px-2 text-zinc-400 font-mono">#{d.id}</td>
                  <td className="py-2 px-2 text-zinc-300 font-mono text-xs max-w-[120px] truncate" title={d.taskId || ''}>
                    {d.taskId || '\u2014'}
                  </td>
                  <td className="py-2 px-2">
                    <span className="text-xs text-zinc-400">{d.phase}</span>
                  </td>
                  <td className="py-2 px-2">
                    <Badge text={d.decisionAction} colorClass={ACTION_COLORS[d.decisionAction] || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'} />
                  </td>
                  <td className="py-2 px-2">
                    <Badge text={d.riskLevel} colorClass={RISK_COLORS[d.riskLevel] || 'bg-zinc-500/20 text-zinc-400'} />
                  </td>
                  <td className="py-2 px-2">
                    {d.finalOutcome ? (
                      <Badge text={d.finalOutcome} colorClass={OUTCOME_COLORS[d.finalOutcome] || 'bg-zinc-500/20 text-zinc-400'} />
                    ) : (
                      <span className="text-xs text-zinc-600">pending</span>
                    )}
                    {d.overrideByUser && (
                      <span className="ml-1 text-xs text-purple-400" title="User override">\u26A1</span>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    {d.escalationStatus ? (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${ESCALATION_COLORS[d.escalationStatus] || ESCALATION_COLORS.pending}`}>
                        {d.escalationStatus}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">\u2014</span>
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleEscalation(d.id, 'approve')} disabled={actionLoading === d.id}
                        className="p-1 text-emerald-400 hover:bg-emerald-500/20 rounded transition-colors disabled:opacity-30" title="Approve">
                        <CheckCircle2 size={14} />
                      </button>
                      <button onClick={() => handleEscalation(d.id, 'reject')} disabled={actionLoading === d.id}
                        className="p-1 text-red-400 hover:bg-red-500/20 rounded transition-colors disabled:opacity-30" title="Reject">
                        <XCircle size={14} />
                      </button>
                      <button onClick={() => handleEscalation(d.id, 'escalate')} disabled={actionLoading === d.id}
                        className="p-1 text-amber-400 hover:bg-amber-500/20 rounded transition-colors disabled:opacity-30" title="Escalate">
                        <ShieldAlert size={14} />
                      </button>
                      <button onClick={() => loadAudit(d.id)}
                        className="p-1 text-blue-400 hover:bg-blue-500/20 rounded transition-colors" title="Audit Log">
                        <FileText size={14} />
                      </button>
                    </div>
                  </td>
                  <td className="py-2 px-2 text-zinc-500 text-xs whitespace-nowrap">
                    {d.timestamp}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* [R21-T2] Audit Log Panel */}
        {showAudit && (
          <div className="mt-4 p-3 bg-zinc-900/80 rounded-lg border border-zinc-700/50">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-medium text-zinc-300">Audit Log \u2014 Decision #{showAudit}</h4>
              <button onClick={() => setShowAudit(null)} className="text-zinc-500 hover:text-zinc-300 transition-colors">
                <XCircle size={14} />
              </button>
            </div>
            {auditLog.length > 0 ? (
              <div className="space-y-1">
                {auditLog.map((log, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-zinc-700/30 last:border-0">
                    <span className={`px-1.5 py-0.5 rounded ${log.action === 'approve' ? 'bg-emerald-500/20 text-emerald-400' : log.action === 'reject' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                      {log.action}
                    </span>
                    <span className="text-zinc-400">{log.operator_id}</span>
                    <span className="text-zinc-500 flex-1 truncate">{log.note}</span>
                    <span className="text-zinc-600 whitespace-nowrap">{log.createdAt}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-zinc-600 text-center py-2">No audit records</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
