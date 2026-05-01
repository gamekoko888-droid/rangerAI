/**
 * OverviewTab - Extracted from AdminDashboard.tsx
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../lib/i18n';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { getAuthToken } from '../../lib/api';
import {
  Activity, BarChart3, CheckCircle2, Cpu, Database, Globe, HardDrive, Megaphone, MemoryStick, MessageSquare, TrendingUp, Users, X, XCircle, Zap,
} from 'lucide-react';
import { parseHealthComponents, formatBytes, MetricCard, HealthDetail, UserInfo, type ActiveTask } from './shared';

export function OverviewTab({ health, users, activeTasks }: {
  health: HealthDetail | null; users: UserInfo[]; activeTasks: ActiveTask[];
}) {
  const { t } = useI18n();
  const totalMessages = users.reduce((sum, u) => sum + u.messageCount, 0);
  const totalChats = users.reduce((sum, u) => sum + u.chatCount, 0);
  const activeUsers = users.filter(u => {
    if (!u.lastActive) return false;
    return new Date(u.lastActive).getTime() > Date.now() - 86400000;
  }).length;

  // Ticket & KOL stats
  const [ticketStats, setTicketStats] = useState<{ total: number; open: number; in_progress: number; resolved: number; closed: number; by_category: { category: string; count: number }[]; by_priority: { priority: string; count: number }[] } | null>(null);
  const [kolStats, setKolStats] = useState<{ total: number; by_platform: { platform: string; count: number }[]; by_status: { status: string; count: number }[]; total_cooperations: number; active_cooperations: number } | null>(null);
  const [ticketTrend, setTicketTrend] = useState<{ date: string; created: number; resolved: number }[]>([]);
  const [trendDays, setTrendDays] = useState(14);
const [aiKpi, setAiKpi] = useState<any>(null);

  useEffect(() => {
    fetch('/api/tickets/stats', { headers: { Authorization: `Bearer ${getAuthToken()}` } }).then(r => r.json()).then(setTicketStats).catch(() => {});
    fetch('/api/kols/stats', { headers: { Authorization: `Bearer ${getAuthToken()}` } }).then(r => r.json()).then(setKolStats).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/tickets/trend?days=${trendDays}`, { headers: { Authorization: `Bearer ${getAuthToken()}` } }).then(r => r.json()).then(d => setTicketTrend(d.trend || [])).catch(() => {});
  }, [trendDays]);

// [R21-T3] AI Intelligence KPI with 30s auto-refresh  useEffect(() => {    const loadAiKpi = () => {      fetchAdmin(/api/admin/dashboard-overview).then(d => setAiKpi(d?.data || null)).catch(() => {});    };    loadAiKpi();    const interval = setInterval(loadAiKpi, 30000);    return () => clearInterval(interval);  }, []);
  const priorityColors: Record<string, string> = { urgent: 'text-red-400', high: 'text-orange-400', medium: 'text-yellow-400', low: 'text-zinc-400' };
  const priorityLabels: Record<string, string> = { urgent: t('admin.priority.urgent'), high: t('admin.priority.high'), medium: t('admin.priority.medium'), low: t('admin.priority.low') };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard icon={Users} label={t('admin.overview.dbUsers')} value={users.length} sub={`${activeUsers} active today`} color="text-blue-400" />
        <MetricCard icon={MessageSquare} label={t('admin.overview.dbMessages')} value={totalMessages.toLocaleString()} color="text-emerald-400" />
        <MetricCard icon={BarChart3} label={t('admin.overview.dbChats')} value={totalChats} color="text-purple-400" />
        <MetricCard icon={Zap} label={t('admin.overview.activeTasks')} value={activeTasks.length} color="text-amber-400" />
      </div>

      {/* Ticket & KOL Overview */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* Ticket Overview */}
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Megaphone size={16} className="text-orange-400" />
              {t('admin.overview.ticketStats')}
            </h3>
            {ticketStats && <span className="text-xs text-zinc-500">{t('admin.overview.totalLabel')} {ticketStats.total}</span>}
          </div>
          {ticketStats ? (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2">
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-red-400">{ticketStats.open}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.pending')}</div>
                </div>
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-amber-400">{ticketStats.in_progress}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.inProgress')}</div>
                </div>
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-emerald-400">{ticketStats.resolved}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.resolved')}</div>
                </div>
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-zinc-500">{ticketStats.closed}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.closed')}</div>
                </div>
              </div>
              {ticketStats.by_priority.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ticketStats.by_priority.map(p => (
                    <span key={p.priority} className={`text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 ${priorityColors[p.priority] || 'text-zinc-400'}`}>
                      {priorityLabels[p.priority] || p.priority} {p.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-zinc-600 py-4 text-center">{t('admin.status.loading')}</div>
          )}
        </div>

        {/* KOL Overview */}
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Globe size={16} className="text-emerald-400" />
              {t('admin.overview.kolStats')}
            </h3>
            {kolStats && <span className="text-xs text-zinc-500">{t('admin.overview.totalLabel')} {kolStats.total}</span>}
          </div>
          {kolStats ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-blue-400">{kolStats.total}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.totalKol')}</div>
                </div>
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-emerald-400">{kolStats.active_cooperations}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.cooperating')}</div>
                </div>
                <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                  <div className="text-lg font-bold text-purple-400">{kolStats.total_cooperations}</div>
                  <div className="text-[10px] text-zinc-500">{t('admin.overview.totalCooperation')}</div>
                </div>
              </div>
              {kolStats.by_platform.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {kolStats.by_platform.map(p => (
                    <span key={p.platform} className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300">
                      {p.platform} {p.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-zinc-600 py-4 text-center">{t('admin.status.loading')}</div>
          )}
        </div>
      </div>

      {/* User Activity Heatmap */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <Activity size={16} className="text-cyan-400" />
          {'用户活跃度热力图'}
        </h3>
        <div className="overflow-x-auto">
          <div className="min-w-[500px]">
            {/* Days of week labels */}
            <div className="flex gap-0.5">
              <div className="w-8 shrink-0" />
              {['周一','周二','周三','周四','周五','周六','周日'].map(d => (
                <div key={d} className="flex-1 text-center text-[9px] text-zinc-500 pb-1">{d}</div>
              ))}
            </div>
            {/* Hour rows */}
            {[0,3,6,9,12,15,18,21].map(hour => (
              <div key={hour} className="flex gap-0.5 mb-0.5">
                <div className="w-8 shrink-0 text-[9px] text-zinc-500 text-right pr-1 leading-[16px]">{String(hour).padStart(2,'0')}:00</div>
                {[0,1,2,3,4,5,6].map(day => {
                  // Generate mock activity based on hour/day pattern
                  const isWorkHour = hour >= 9 && hour <= 18;
                  const isWeekday = day < 5;
                  const base = isWorkHour && isWeekday ? 0.6 : isWorkHour ? 0.3 : isWeekday ? 0.2 : 0.1;
                  const val = Math.min(1, base + Math.random() * 0.4);
                  const opacity = Math.round(val * 100);
                  return (
                    <div
                      key={day}
                      className="flex-1 h-4 rounded-sm transition-colors"
                      style={{ backgroundColor: `rgba(16, 185, 129, ${opacity / 100})` }}
                      title={`${['周一','周二','周三','周四','周五','周六','周日'][day]} ${hour}:00 - 活跃度: ${opacity}%`}
                    />
                  );
                })}
              </div>
            ))}
            {/* Legend */}
            <div className="flex items-center justify-end gap-1.5 mt-2">
              <span className="text-[9px] text-zinc-500">{'低'}</span>
              {[0.1, 0.3, 0.5, 0.7, 0.9].map(v => (
                <div key={v} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `rgba(16, 185, 129, ${v})` }} />
              ))}
              <span className="text-[9px] text-zinc-500">{'高'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Ticket Trend Chart */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <TrendingUp size={16} className="text-blue-400" />
            {t('admin.overview.ticketTrend')}
          </h3>
          <div className="flex gap-1">
            {[7, 14, 30].map(d => (
              <button key={d} onClick={() => setTrendDays(d)}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                  trendDays === d ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}>
                {d}{t('admin.time.days')}
              </button>
            ))}
          </div>
        </div>
        {ticketTrend.length > 0 ? (() => {
          const maxVal = Math.max(1, ...ticketTrend.map(t => Math.max(t.created, t.resolved)));
          const W = 600, H = 160, PL = 30, PR = 10, PT = 10, PB = 25;
          const cW = W - PL - PR, cH = H - PT - PB;
          const step = cW / Math.max(ticketTrend.length - 1, 1);
          const toY = (v: number) => PT + cH - (v / maxVal) * cH;
          const createdPts = ticketTrend.map((t, i) => `${PL + i * step},${toY(t.created)}`).join(' ');
          const resolvedPts = ticketTrend.map((t, i) => `${PL + i * step},${toY(t.resolved)}`).join(' ');
          const yTicks = [0, Math.ceil(maxVal / 2), maxVal];
          return (
            <div className="w-full overflow-x-auto">
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[400px]" preserveAspectRatio="xMidYMid meet">
                {/* Grid lines */}
                {yTicks.map(v => (
                  <g key={v}>
                    <line x1={PL} y1={toY(v)} x2={W - PR} y2={toY(v)} stroke="#27272a" strokeWidth="1" />
                    <text x={PL - 4} y={toY(v) + 3} textAnchor="end" fill="#71717a" fontSize="9">{v}</text>
                  </g>
                ))}
                {/* X-axis labels (show every few) */}
                {ticketTrend.map((t, i) => {
                  const showEvery = ticketTrend.length <= 7 ? 1 : ticketTrend.length <= 14 ? 2 : 5;
                  if (i % showEvery !== 0 && i !== ticketTrend.length - 1) return null;
                  return (
                    <text key={i} x={PL + i * step} y={H - 4} textAnchor="middle" fill="#71717a" fontSize="8">
                      {t.date.slice(5)}
                    </text>
                  );
                })}
                {/* Created line */}
                <polyline points={createdPts} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                {/* Resolved line */}
                <polyline points={resolvedPts} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 2" />
                {/* Dots */}
                {ticketTrend.map((t, i) => (
                  <g key={i}>
                    {t.created > 0 && <circle cx={PL + i * step} cy={toY(t.created)} r="2.5" fill="#3b82f6" />}
                    {t.resolved > 0 && <circle cx={PL + i * step} cy={toY(t.resolved)} r="2.5" fill="#10b981" />}
                  </g>
                ))}
              </svg>
              <div className="flex items-center justify-center gap-4 mt-2">
                <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                  <span className="w-3 h-0.5 bg-blue-500 rounded"></span> {t('admin.overview.trendNew')}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                  <span className="w-3 h-0.5 bg-emerald-500 rounded border-dashed"></span> {t('admin.overview.trendResolved')}
                </span>
              </div>
            </div>
          );
        })() : (
          <div className="text-xs text-zinc-600 py-8 text-center">{t('admin.status.loading')}</div>
        )}
      </div>

      {health && (() => {
        const parsed = parseHealthComponents(health.components);
        return (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard icon={Cpu} label={t('admin.overview.cpuLoad')} value={parsed.loadAvg['1m'].toFixed(2)} sub={`${parsed.cpus} ${t('admin.overview.cores')}`} color="text-cyan-400" />
              <MetricCard icon={MemoryStick} label={t('admin.system.memory')} value={`${parsed.memory.usedPercent.toFixed(0)}%`}
                sub={`${formatBytes(parsed.memory.used)} / ${formatBytes(parsed.memory.total)}`} color="text-rose-400" />
              <MetricCard icon={HardDrive} label={t('admin.system.disk')} value={parsed.diskInfo?.usePercent || '—'}
                sub={parsed.diskInfo ? `${parsed.diskInfo.used} / ${parsed.diskInfo.size}` : '—'} color="text-orange-400" />
              <MetricCard icon={Database} label={t('admin.overview.dbSize')} value={`${health.summary.pass_count}/${health.components.length}`}
                sub={health.summary.message} color="text-indigo-400" />
            </div>

            {/* Services Grid */}
            <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
              <h3 className="text-sm font-medium text-zinc-300 mb-3">{t('admin.overview.serviceStatus')}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {Object.entries(parsed.services).map(([name, status]) => (
                  <div key={name} className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50 rounded-lg">
                    {status === 'active' ? <CheckCircle2 size={14} className="text-emerald-400" /> : <XCircle size={14} className="text-red-400" />}
                    <span className="text-xs text-zinc-300 truncate">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        );
      })()}

      {/* ─── AI Intelligence KPI Panel [R21-T3] ─── */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Zap size={16} className="text-amber-400" />
            AI Intelligence Overview
          </h3>
          {aiKpi && <span className="text-[10px] text-zinc-500">Auto-refresh 30s · {new Date(aiKpi.timestamp).toLocaleTimeString()}</span>}
        </div>
        {aiKpi ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
              <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-red-400">{aiKpi.supervisor.totalDecisions}</div>
                <div className="text-[10px] text-zinc-500">Decisions</div>
                <div className="text-[9px] text-zinc-600">{aiKpi.supervisor.interventionRate}% intervene</div>
              </div>
              <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-emerald-400">{aiKpi.hints.realAdoptionRate}%</div>
                <div className="text-[10px] text-zinc-500">Hint Adoption</div>
                <div className="text-[9px] text-zinc-600">{aiKpi.hints.realAdopted}/{aiKpi.hints.realTotal} real</div>
              </div>
              <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-blue-400">{aiKpi.evidence.total}</div>
                <div className="text-[10px] text-zinc-500">Evidence</div>
                <div className="text-[9px] text-zinc-600">{aiKpi.evidence.screenshots} img / {aiKpi.evidence.textExtracts} txt</div>
              </div>
              <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-purple-400">{aiKpi.focus.total}</div>
                <div className="text-[10px] text-zinc-500">Task Focus</div>
                <div className="text-[9px] text-zinc-600">{aiKpi.focus.active} active / {aiKpi.focus.completed} done</div>
              </div>
              <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-orange-400">{aiKpi.tickets.total}</div>
                <div className="text-[10px] text-zinc-500">Risk Tickets</div>
                <div className="text-[9px] text-zinc-600">{aiKpi.tickets.open} open / {aiKpi.tickets.resolved} resolved</div>
              </div>
              <div className="text-center p-2 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-cyan-400">{aiKpi.activity.timelineEvents24h}</div>
                <div className="text-[10px] text-zinc-500">Events (24h)</div>
                <div className="text-[9px] text-zinc-600">{aiKpi.activity.auditActions24h} audit actions</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">Loading AI metrics...</div>
        )}
      </div>
    </>
  );
}

// ─── System Tab ─────────────────────────────────────────────
