import React, { useState, useEffect } from 'react';
import { Ticket, AlertTriangle, CheckCircle2, Clock, RefreshCw, Shield, ArrowUpRight, XCircle, Filter } from 'lucide-react';
import { fetchAdmin } from './shared';

interface TicketData {
  id: number;
  session_id: string;
  task_id: string;
  type: string;
  title: string;
  description: string;
  risk_type: string;
  risk_level: string;
  status: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

interface TicketStats {
  total: number;
  open: number;
  byType: { type: string; cnt: number }[];
  byRiskLevel: { risk_level: string; cnt: number }[];
}

const STATUS_STYLES: Record<string, { color: string; icon: React.ElementType; label: string }> = {
  open: { color: 'text-amber-400 bg-amber-500/10 border-amber-500/30', icon: Clock, label: 'Open' },
  processing: { color: 'text-blue-400 bg-blue-500/10 border-blue-500/30', icon: RefreshCw, label: 'Processing' },
  resolved: { color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', icon: CheckCircle2, label: 'Resolved' },
  escalated: { color: 'text-red-400 bg-red-500/10 border-red-500/30', icon: ArrowUpRight, label: 'Escalated' },
  closed: { color: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30', icon: XCircle, label: 'Closed' },
};

const RISK_STYLES: Record<string, string> = {
  high: 'text-red-400 bg-red-500/10 border-red-500/30',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  low: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
};

const TYPE_LABELS: Record<string, string> = {
  refund: 'Refund',
  payment: 'Payment',
  data_export: 'Data Export',
  account_change: 'Account Change',
  other: 'Other',
};

export default function TicketsTab() {
  const [tickets, setTickets] = useState<TicketData[]>([]);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdmin("/api/admin/tickets");
      if (data.ok) {
        setTickets(data.tickets || []);
        setStats(data.stats || null);
      } else {
        setError(data.error || 'Failed to load');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const resolveTicket = async (ticketId: number, newStatus: string) => {
    try {
      await fetchAdmin(`/api/admin/tickets/${ticketId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      load();
    } catch (err) {
      console.error('Failed to resolve ticket', err);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = statusFilter === 'all' ? tickets : tickets.filter(t => t.status === statusFilter);

  if (loading) return <div className="flex items-center justify-center py-20 text-zinc-400"><RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading tickets...</div>;
  if (error) return <div className="text-red-400 text-center py-12">{error}</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Ticket className="w-5 h-5 text-blue-400" /> Risk Tickets
          </h2>
          <p className="text-xs text-zinc-500 mt-1">Auto-generated from supervisor risk detection during task execution</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4 cursor-pointer hover:border-zinc-600/50" onClick={() => setStatusFilter('all')}>
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><Ticket className="w-4 h-4" /> Total</div>
            <div className="text-2xl font-bold text-zinc-100">{stats.total}</div>
          </div>
          <div className={`bg-zinc-800/50 border rounded-xl p-4 cursor-pointer transition-colors ${statusFilter === 'open' ? 'border-amber-500/50' : 'border-zinc-700/50 hover:border-zinc-600/50'}`} onClick={() => setStatusFilter(statusFilter === 'open' ? 'all' : 'open')}>
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><AlertTriangle className="w-4 h-4" /> Open</div>
            <div className="text-2xl font-bold text-amber-400">{stats.open}</div>
          </div>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><Shield className="w-4 h-4" /> By Risk Level</div>
            <div className="flex gap-2 mt-1">
              {stats.byRiskLevel.map(r => (
                <span key={r.risk_level} className={`px-2 py-0.5 rounded text-xs border ${RISK_STYLES[r.risk_level] || 'text-zinc-400'}`}>
                  {r.risk_level}: {r.cnt}
                </span>
              ))}
            </div>
          </div>
          <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1"><Filter className="w-4 h-4" /> By Type</div>
            <div className="flex flex-wrap gap-1 mt-1">
              {stats.byType.map(t => (
                <span key={t.type} className="px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-300">{TYPE_LABELS[t.type] || t.type}: {t.cnt}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Ticket List */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <Ticket className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No tickets found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(ticket => {
            const sCfg = STATUS_STYLES[ticket.status] || STATUS_STYLES.open;
            const SIcon = sCfg.icon;
            const expanded = expandedId === ticket.id;
            return (
              <div key={ticket.id} className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl overflow-hidden hover:border-zinc-600/50 transition-colors">
                <div className="p-4 cursor-pointer" onClick={() => setExpandedId(expanded ? null : ticket.id)}>
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${sCfg.color}`}>
                      <SIcon className="w-3 h-3" /> {sCfg.label}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-xs border ${RISK_STYLES[ticket.risk_level] || ''}`}>
                      {ticket.risk_level}
                    </span>
                    <span className="px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-300">
                      {TYPE_LABELS[ticket.type] || ticket.type}
                    </span>
                    <h3 className="text-sm font-medium text-zinc-200 flex-1 truncate">{ticket.title}</h3>
                    <span className="text-xs text-zinc-500">{ticket.created_at}</span>
                  </div>
                </div>
                {expanded && (
                  <div className="border-t border-zinc-700/50 p-4 bg-zinc-900/30">
                    <div className="space-y-3">
                      <div>
                        <span className="text-xs text-zinc-500">Description</span>
                        <p className="text-sm text-zinc-300 mt-1">{ticket.description}</p>
                      </div>
                      <div className="flex gap-6 text-xs text-zinc-500">
                        <span>Risk Type: <span className="text-zinc-300">{ticket.risk_type}</span></span>
                        <span>Task: <span className="text-zinc-300 font-mono">{ticket.task_id}</span></span>
                        <span>Session: <span className="text-zinc-300 font-mono">{ticket.session_id}</span></span>
                      </div>
                      {ticket.status !== 'resolved' && ticket.status !== 'closed' && (
                        <div className="flex gap-2 pt-2">
                          <button onClick={() => resolveTicket(ticket.id, 'resolved')} className="px-3 py-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/30 rounded-lg text-xs transition-colors">
                            Mark Resolved
                          </button>
                          <button onClick={() => resolveTicket(ticket.id, 'closed')} className="px-3 py-1.5 bg-zinc-700/50 hover:bg-zinc-700 text-zinc-400 border border-zinc-600/50 rounded-lg text-xs transition-colors">
                            Close
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
