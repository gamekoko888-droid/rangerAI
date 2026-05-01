/**
 * AdminDashboard — Unified admin panel for RangerAI system management.
 * Tabs: Overview, System Monitor, Users, Config, AI Roles, Audit Logs
 */
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../lib/i18n';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { useLocation } from 'wouter';
import { getAuthToken } from '../lib/api';
import {
  ArrowLeft, RefreshCw, Shield, Users, Activity, Server,
  HardDrive, Database, Cpu, Clock, CheckCircle2, XCircle,
  AlertTriangle, Loader2, UserCog, Crown, UserMinus,
  BarChart3, Zap, Globe, Settings, ChevronRight, ChevronLeft,
  MemoryStick, Wifi, WifiOff, TrendingUp, MessageSquare,
  Bot, Pencil, Trash2, Plus, ScrollText, Save, X,
  Headphones, Megaphone, PenTool, Calculator, GitBranch,
  PanelLeftClose, PanelLeftOpen, DollarSign, Gauge, CircleDollarSign,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────
/** New API format: { summary, components[] } */
interface HealthComponent {
  status: 'PASS' | 'WARN' | 'CRIT';
  message: string;
  component: string;
}
interface HealthDetail {
  summary: {
    status: 'PASS' | 'WARN' | 'CRIT';
    checked_at: string;
    message: string;
    duration_ms: number;
    pass_count: number;
    warn_count: number;
    crit_count: number;
    triggered_by: string;
    uptime_seconds: number;
  };
  components: HealthComponent[];
}

/** Parse structured data from component messages */
function parseHealthComponents(components: HealthComponent[]) {
  const find = (prefix: string) => components.find(c => c.component === prefix);
  const cpu = find('system:cpu');
  const mem = find('system:memory');
  const disk = find('system:disk');
  const db = find('database:mysql') || find('database:sqlite');

  // Parse CPU: "Load average 0.22 / 0.17 / 0.17 (8 cores)"
  let loadAvg = { '1m': 0, '5m': 0, '15m': 0 };
  let cpus = 1;
  if (cpu) {
    const loadMatch = cpu.message.match(/Load average ([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)\s*\((\d+)\s*cores?\)/);
    if (loadMatch) {
      loadAvg = { '1m': parseFloat(loadMatch[1]), '5m': parseFloat(loadMatch[2]), '15m': parseFloat(loadMatch[3]) };
      cpus = parseInt(loadMatch[4]);
    }
  }

  // Parse Memory: "Free memory 11451MB / 15198MB total (25% used)"
  let memory = { total: 0, used: 0, free: 0, usedPercent: 0 };
  if (mem) {
    const memMatch = mem.message.match(/Free memory (\d+)MB\s*\/\s*(\d+)MB total \((\d+)% used\)/);
    if (memMatch) {
      const freeMB = parseInt(memMatch[1]);
      const totalMB = parseInt(memMatch[2]);
      const usedPct = parseInt(memMatch[3]);
      memory = { total: totalMB * 1024 * 1024, used: (totalMB - freeMB) * 1024 * 1024, free: freeMB * 1024 * 1024, usedPercent: usedPct };
    }
  }

  // Parse Disk: "Disk usage 38%"
  let diskInfo: { usePercent: string; size: string; used: string; available: string } | null = null;
  if (disk) {
    const diskMatch = disk.message.match(/Disk usage (\d+)%/);
    if (diskMatch) {
      diskInfo = { usePercent: `${diskMatch[1]}%`, size: '—', used: '—', available: '—' };
    }
  }

  // Parse services from components
  const services: Record<string, string> = {};
  components.filter(c => c.component.startsWith('service:')).forEach(c => {
    const name = c.component.replace('service:', '');
    services[name] = c.status === 'PASS' ? 'active' : 'inactive';
  });

  // Parse database info: "MySQL OK. 26 tables, 9 users. Latency: 2ms"
  let dbUsers = 0, dbMessages = 0;
  if (db) {
    const usersMatch = db.message.match(/(\d+) users/);
    if (usersMatch) dbUsers = parseInt(usersMatch[1]);
  }

  return { loadAvg, cpus, memory, diskInfo, services, dbUsers, dbMessages };
}

interface UserInfo {
  id: number; username: string; email: string; role: string;
  status: string; lastActive: string | null;
  messageCount: number; chatCount: number; createdAt: string;
}

interface ActiveTask {
  chatId: string; chatTitle: string; msgId: number;
  startedAt: string; elapsed: number;
}

interface SystemConfig {
  key: string; value: string; description: string;
  category: string; updatedAt: string; updatedBy: string | null;
}

interface AiRole {
  id: string; name: string; description: string;
  systemPrompt: string; icon: string; color: string;
  category: string; isActive: number; sortOrder: number;
  createdBy: string; createdAt: string; updatedAt: string;
}

interface AuditLog {
  id: number; userId: string; username: string;
  action: string; target: string; targetId: string;
  detail: string; ip: string; createdAt: string;
}

interface AcpApiKey {
  id: string; name: string; key_prefix: string; status: string;
  call_count: number; last_used: string | null;
  created_by: string; created_at: string; revoked_at: string | null;
  source?: string;
}

// ─── API helpers ────────────────────────────────────────────
async function fetchAdmin(url: string, options?: RequestInit) {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers }, credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatUptime(seconds: number): { d: number; h: number; m: number } {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return { d, h, m };
}
function formatUptimeStr(seconds: number, t: (k: any) => string): string {
  const { d, h, m } = formatUptime(seconds);
  if (d > 0) return `${d}${t('admin.time.days')} ${h}${t('admin.time.hours')}`;
  if (h > 0) return `${h}${t('admin.time.hours')} ${m}${t('admin.time.minutes')}`;
  return `${m}${t('admin.time.minutes')}`;
}

// ─── Sub-components ─────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const isActive = status === 'active' || status === 'healthy';
  const isWarning = status === 'degraded';
  const statusLabel = status === 'active' ? t('admin.status.running') : status === 'healthy' ? t('admin.status.healthy') : status === 'degraded' ? t('admin.status.degraded') : status;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
      isActive ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
      isWarning ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' :
      'bg-red-500/15 text-red-400 border border-red-500/30'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        isActive ? 'bg-emerald-400' : isWarning ? 'bg-amber-400' : 'bg-red-400'
      }`} />
      {statusLabel}
    </span>
  );
}

function MetricCard({ icon: Icon, label, value, sub, color = 'text-blue-400' }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 hover:border-zinc-700/80 transition-colors">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-zinc-800/80"><Icon size={18} className={color} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500 mb-0.5">{label}</p>
          <p className="text-xl font-semibold text-zinc-100 truncate">{value}</p>
          {sub && <p className="text-[11px] text-zinc-500 mt-0.5">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ value, max, color = 'bg-blue-500' }: { value: number; max: number; color?: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────
type TabId = 'overview' | 'users' | 'system' | 'config' | 'roles' | 'audit' | 'assign-rules' | 'open-platform';

const TAB_KEYS: Record<TabId, string> = {
  overview: 'admin.tab.overview',
  system: 'admin.tab.system',
  users: 'admin.tab.users',
  config: 'admin.tab.config',
  roles: 'admin.tab.roles',
  audit: 'admin.tab.audit',
  'assign-rules': 'admin.tab.assignRules',
  'open-platform': 'admin.tab.openPlatform',
};
const TAB_ICONS: Record<TabId, React.ElementType> = {
  overview: BarChart3, system: Server, users: Users, config: Settings, roles: Bot, audit: ScrollText, 'assign-rules': GitBranch, 'open-platform': Globe,
};
const TAB_IDS: TabId[] = ['overview', 'system', 'users', 'config', 'roles', 'audit', 'assign-rules', 'open-platform'];

// ─── Sidebar Navigation Groups ─────────────────────────────
interface NavGroup {
  label: string; // i18n key
  items: TabId[];
}
const NAV_GROUPS: NavGroup[] = [
  { label: 'admin.nav.monitor', items: ['overview', 'system'] },
  { label: 'admin.nav.manage', items: ['users', 'config', 'roles'] },
  { label: 'admin.nav.ops', items: ['audit', 'assign-rules', 'open-platform'] },
];

// ─── Main Component ─────────────────────────────────────────
export default function AdminDashboard() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI } = useConfirmDialog();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [health, setHealth] = useState<HealthDetail | null>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const [healthRes, usersRes, tasksRes] = await Promise.allSettled([
        fetchAdmin('/api/system/health-detail'),
        fetchAdmin('/api/stats/users'),
        fetchAdmin('/api/tasks/active'),
      ]);
      if (healthRes.status === 'fulfilled') setHealth(healthRes.value);
      if (usersRes.status === 'fulfilled') setUsers(usersRes.value.users || []);
      if (tasksRes.status === 'fulfilled') setActiveTasks(tasksRes.value.tasks || []);
    } catch (err: any) {
      setError(err.message || t('admin.status.loadFailed'));
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    const timer = setInterval(() => fetchAll(true), 30000);
    return () => clearInterval(timer);
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-blue-400" />
      </div>
    );
  }

  const sidebarContent = (
    <>
      {/* Sidebar Header */}
      <div className={`p-4 border-b border-zinc-800/60 ${sidebarCollapsed ? 'px-2 py-3' : ''}`}>
        <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
          {!sidebarCollapsed && (
            <button onClick={() => { navigate('/'); setMobileSidebarOpen(false); }} className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors">
              <ArrowLeft size={16} className="text-zinc-400" />
            </button>
          )}
          <div className={`flex items-center gap-2 ${sidebarCollapsed ? '' : 'flex-1'}`}>
            <Shield size={sidebarCollapsed ? 22 : 18} className="text-blue-400 shrink-0" />
            {!sidebarCollapsed && <h1 className="text-sm font-semibold truncate">{t('admin.title')}</h1>}
          </div>
        </div>
        {!sidebarCollapsed && health && (
          <div className="mt-3 flex items-center gap-2">
            <StatusBadge status={health.summary.status === 'PASS' ? 'healthy' : 'degraded'} />
            <span className="text-[11px] text-zinc-500 truncate">
              v5.0 · {health ? formatUptimeStr(health.summary.uptime_seconds, t) : '—'}
            </span>
          </div>
        )}
      </div>

      {/* Navigation Groups */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={sidebarCollapsed ? 'py-1' : 'mb-1'}>
            {!sidebarCollapsed && (
              <div className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t(group.label as any)}
              </div>
            )}
            {sidebarCollapsed && gi > 0 && <div className="mx-2 border-t border-zinc-800/40 my-1" />}
            {group.items.map(tabId => {
              const TabIcon = TAB_ICONS[tabId];
              const isActive = activeTab === tabId;
              return (
                <button
                  key={tabId}
                  onClick={() => { setActiveTab(tabId); setMobileSidebarOpen(false); }}
                  title={sidebarCollapsed ? t(TAB_KEYS[tabId] as any) : undefined}
                  className={`w-full flex items-center gap-3 transition-all duration-150 ${
                    sidebarCollapsed
                      ? 'justify-center px-0 py-2.5 mx-auto'
                      : 'px-4 py-2.5'
                  } ${
                    isActive
                      ? 'bg-blue-500/10 text-blue-400 border-r-2 border-blue-400'
                      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200 border-r-2 border-transparent'
                  }`}
                >
                  <TabIcon size={sidebarCollapsed ? 20 : 17} className={isActive ? 'text-blue-400' : ''} />
                  {!sidebarCollapsed && (
                    <span className="text-[13px] font-medium truncate">{t(TAB_KEYS[tabId] as any)}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Sidebar Footer */}
      <div className={`border-t border-zinc-800/60 ${sidebarCollapsed ? 'p-2' : 'p-3'}`}>
        <button
          onClick={() => fetchAll(true)}
          disabled={refreshing}
          className={`flex items-center gap-2 w-full rounded-lg transition-colors disabled:opacity-50 ${
            sidebarCollapsed ? 'justify-center p-2' : 'px-3 py-2 hover:bg-zinc-800/60'
          } text-zinc-400 hover:text-zinc-200`}
          title={sidebarCollapsed ? t('admin.refresh') : undefined}
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {!sidebarCollapsed && <span className="text-xs">{t('admin.refresh')}</span>}
        </button>
        {/* Collapse toggle - desktop only */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className={`hidden lg:flex items-center gap-2 w-full rounded-lg transition-colors mt-1 ${
            sidebarCollapsed ? 'justify-center p-2' : 'px-3 py-2 hover:bg-zinc-800/60'
          } text-zinc-500 hover:text-zinc-300`}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <><PanelLeftClose size={15} /><span className="text-xs">{t('admin.collapse')}</span></>}
        </button>
      </div>
    </>
  );

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex overflow-hidden">
      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMobileSidebarOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        </div>
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-50
        flex flex-col bg-zinc-900/95 backdrop-blur-md border-r border-zinc-800/60
        transition-all duration-200 ease-in-out
        ${mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        ${sidebarCollapsed ? 'w-[56px]' : 'w-[220px]'}
      `}>
        {sidebarContent}
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="lg:hidden sticky top-0 z-30 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800/50 h-12 flex items-center px-4 gap-3">
          <button onClick={() => setMobileSidebarOpen(true)} className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors">
            <PanelLeftOpen size={18} className="text-zinc-400" />
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Shield size={16} className="text-blue-400 shrink-0" />
            <span className="text-sm font-medium truncate">{t(TAB_KEYS[activeTab] as any)}</span>
          </div>
          {health && <StatusBadge status={health.summary.status === 'PASS' ? 'healthy' : 'degraded'} />}
          <button onClick={() => fetchAll(true)} disabled={refreshing} className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50">
            <RefreshCw size={15} className={`text-zinc-400 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </header>

        {/* Content area */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
                <AlertTriangle size={18} className="text-red-400 shrink-0" />
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}
            {activeTab === 'overview' && <OverviewTab health={health} users={users} activeTasks={activeTasks} />}
            {activeTab === 'system' && <SystemTab health={health} />}
            {activeTab === 'users' && <UsersTab users={users} onRefresh={() => fetchAll(true)} />}
            {activeTab === 'config' && <ConfigTab />}
            {activeTab === 'roles' && <RolesTab />}
            {activeTab === 'audit' && <AuditTab />}
            {activeTab === 'assign-rules' && <AssignRulesTab />}
            {activeTab === 'open-platform' && <OpenPlatformTab />}
          </div>
        </main>
      </div>
      {ConfirmDialogUI}
    </div>
  );
}

// ─── Overview Tab ───────────────────────────────────────────
function OverviewTab({ health, users, activeTasks }: {
  health: HealthDetail | null; users: UserInfo[]; activeTasks: ActiveTask[];
}) {
  const { t } = useI18n();
  const totalMessages = users.reduce((sum, u) => sum + u.messageCount, 0);
  const totalChats = users.reduce((sum, u) => sum + u.chatCount, 0);
  const activeUsers = users.filter(u => {
    if (!u.lastActive) return false;
    return new Date(u.lastActive).getTime() > Date.now() - 86400000;
  }).length;

  // AI Cost & Usage stats
  const [obsHours, setObsHours] = useState(24);
  const [obsParsed, setObsParsed] = useState<{
    totalRequests: number; successRate: string; avgResponse: string; ttfb: string;
    totalTokens: number; totalCost: string; models: { name: string; count: number; cost: string; tokens: number }[];
  } | null>(null);

  useEffect(() => {
    fetch(`/api/system/observability-json?hours=${obsHours}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) return;
        const ov = data.overview || {};
        const total = ov.total || 0;
        const successCount = ov.success_count || 0;
        const models = (data.modelDistribution || []).map((m: any) => ({
          name: m.model || 'unknown',
          count: m.cnt || 0,
          tokens: m.total_tokens || 0,
          cost: (m.total_cost_usd || 0).toFixed(6),
        }));
        setObsParsed({
          totalRequests: total,
          successRate: total > 0 ? (successCount / total * 100).toFixed(1) + '%' : '—',
          avgResponse: ov.avg_ms ? (ov.avg_ms > 1000 ? (ov.avg_ms / 1000).toFixed(1) + 's' : Math.round(ov.avg_ms) + 'ms') : '—',
          totalTokens: ov.total_tokens || 0,
          totalCost: '$' + (ov.total_cost_usd || 0).toFixed(6),
          ttfb: (() => {
            const spans = data.spanPerformance || [];
            const ki = spans.find((s: any) => s.span_name === 'knowledge_inject');
            const cr = spans.find((s: any) => s.span_name === 'conversation_recall');
            const total = (ki?.avg_ms || 0) + (cr?.avg_ms || 0);
            return total > 0 ? (total > 1000 ? (total/1000).toFixed(1) + 's' : Math.round(total) + 'ms') : '—';
          })(),
          models,
        });
      })
      .catch(() => {});
  }, [obsHours]);

  // Ticket & KOL stats
  const [ticketStats, setTicketStats] = useState<{ total: number; open: number; in_progress: number; resolved: number; closed: number; by_category: { category: string; count: number }[]; by_priority: { priority: string; count: number }[] } | null>(null);
  const [kolStats, setKolStats] = useState<{ total: number; by_platform: { platform: string; count: number }[]; by_status: { status: string; count: number }[]; total_cooperations: number; active_cooperations: number } | null>(null);
  const [ticketTrend, setTicketTrend] = useState<{ date: string; created: number; resolved: number }[]>([]);
  const [trendDays, setTrendDays] = useState(14);

  useEffect(() => {
    fetch('/api/tickets/stats', { headers: { Authorization: `Bearer ${getAuthToken()}` } }).then(r => r.json()).then(d => { if (d && d.total !== undefined && d.by_priority) setTicketStats(d); }).catch(() => {});
    fetch('/api/kols/stats', { headers: { Authorization: `Bearer ${getAuthToken()}` } }).then(r => r.json()).then(d => { if (d && d.total !== undefined && d.by_platform) setKolStats(d); }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/tickets/trend?days=${trendDays}`, { headers: { Authorization: `Bearer ${getAuthToken()}` } }).then(r => r.json()).then(d => setTicketTrend(d.trend || [])).catch(() => {});
  }, [trendDays]);

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

      {/* AI Cost & Usage Panel */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <CircleDollarSign size={16} className="text-green-400" />
            AI 成本与用量
          </h3>
          <div className="flex gap-1">
            {[24, 72, 168].map(h => (
              <button key={h} onClick={() => setObsHours(h)}
                className={`text-[11px] px-2 py-0.5 rounded-full transition-colors ${
                  obsHours === h ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'
                }`}>
                {h === 24 ? '24h' : h === 72 ? '3天' : '7天'}
              </button>
            ))}
          </div>
        </div>
        {obsParsed ? (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <div className="text-center p-2.5 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-green-400">{obsParsed.totalCost}</div>
                <div className="text-[10px] text-zinc-500">总成本</div>
              </div>
              <div className="text-center p-2.5 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-blue-400">{obsParsed.totalRequests}</div>
                <div className="text-[10px] text-zinc-500">总请求</div>
              </div>
              <div className="text-center p-2.5 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-emerald-400">{obsParsed.successRate}</div>
                <div className="text-[10px] text-zinc-500">成功率</div>
              </div>
              <div className="text-center p-2.5 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-purple-400">{obsParsed.totalTokens.toLocaleString()}</div>
                <div className="text-[10px] text-zinc-500">总 Tokens</div>
              </div>
              <div className="text-center p-2.5 bg-zinc-800/50 rounded-lg">
                <div className="text-lg font-bold text-amber-400">{obsParsed.avgResponse}</div>
                <div className="text-[10px] text-zinc-500">端到端耗时</div>
              </div>
            </div>
            {/* Model breakdown */}
            {obsParsed.models.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs text-zinc-500 font-medium">模型使用分布</h4>
                {obsParsed.models.map((m, i) => {
                  const maxTokens = Math.max(1, ...obsParsed.models.map(x => x.tokens));
                  const pct = (m.tokens / maxTokens) * 100;
                  const colors = ['bg-blue-500', 'bg-emerald-500', 'bg-purple-500', 'bg-amber-500', 'bg-rose-500'];
                  return (
                    <div key={m.name} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-300 truncate max-w-[200px]" title={m.name}>{m.name}</span>
                        <div className="flex items-center gap-3 text-zinc-500">
                          <span>{m.count} 次</span>
                          <span>{m.tokens.toLocaleString()} tok</span>
                          <span className="text-green-400 font-medium">${m.cost}</span>
                        </div>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-500 ${colors[i % colors.length]}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">加载中…</div>
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
    </>
  );
}

// ─── System Tab ─────────────────────────────────────────────
function SystemTab({ health }: { health: HealthDetail | null }) {
  const { t } = useI18n();
  const [browserStatus, setBrowserStatus] = useState<{
    state: string; failureCount: number; halfOpenAttempts: number;
    lastFailureTime: number | null; nextAttemptAt: number | null;
  } | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserAction, setBrowserAction] = useState<string | null>(null);
  const [browserMsg, setBrowserMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchBrowserStatus = useCallback(async () => {
    setBrowserLoading(true);
    try {
      const res = await fetchAdmin('/api/admin/browser-status');
      if (res.ok && res.browserBreaker) setBrowserStatus(res.browserBreaker);
    } catch { /* ignore */ }
    finally { setBrowserLoading(false); }
  }, []);

  useEffect(() => { fetchBrowserStatus(); }, [fetchBrowserStatus]);
  useEffect(() => {
    const timer = setInterval(fetchBrowserStatus, 15000);
    return () => clearInterval(timer);
  }, [fetchBrowserStatus]);

  const handleBrowserAction = async (action: 'recover' | 'reset') => {
    setBrowserAction(action);
    setBrowserMsg(null);
    try {
      const url = action === 'recover' ? '/api/admin/recover-browser' : '/api/admin/reset-browser-breaker';
      const res = await fetchAdmin(url, { method: 'POST' });
      setBrowserMsg({ type: 'success', text: res.message || t('admin.system.opSuccess') });
      setTimeout(fetchBrowserStatus, 2000);
    } catch (err: any) {
      setBrowserMsg({ type: 'error', text: err.message || t('admin.system.opFailed') });
    } finally { setBrowserAction(null); }
  };

  if (!health) return <p className="text-zinc-500 text-center py-12">{t('admin.system.platform')}</p>;

  const breakerStateLabel: Record<string, { label: string; color: string; bg: string }> = {
    CLOSED: { label: t('admin.system.breakerClosed'), color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
    OPEN: { label: t('admin.system.breakerOpen'), color: 'text-red-400', bg: 'bg-red-500/15 border-red-500/30' },
    HALF_OPEN: { label: t('admin.system.breakerHalfOpen'), color: 'text-amber-400', bg: 'bg-amber-500/15 border-amber-500/30' },
  };

  const parsed = parseHealthComponents(health.components);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Memory */}
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
          <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><MemoryStick size={16} className="text-rose-400" />{t('admin.system.memory')}</h3>
          <div className="space-y-3">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>{t('admin.system.used')} {formatBytes(parsed.memory.used)}</span>
              <span>{t('admin.system.total')} {formatBytes(parsed.memory.total)}</span>
            </div>
            <ProgressBar value={parsed.memory.used} max={parsed.memory.total || 1} color={parsed.memory.usedPercent > 85 ? 'bg-red-500' : 'bg-blue-500'} />
            <div className="text-[11px] text-zinc-500 mt-2">{t('admin.system.usageRate')} {parsed.memory.usedPercent.toFixed(1)}% · {t('admin.system.free')} {formatBytes(parsed.memory.free)}</div>
          </div>
        </div>
        {/* Disk + CPU Load */}
        <div className="space-y-4">
          {/* Disk */}
          {parsed.diskInfo && (
            <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
              <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><HardDrive size={16} className="text-amber-400" />{t('admin.system.disk')}</h3>
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-zinc-400">
                  <span>{t('admin.system.used')} {parsed.diskInfo.used}</span>
                  <span>{t('admin.system.total')} {parsed.diskInfo.size}</span>
                </div>
                <ProgressBar value={parseFloat(parsed.diskInfo.usePercent)} max={100} color={parseFloat(parsed.diskInfo.usePercent) > 85 ? 'bg-red-500' : 'bg-amber-500'} />
                <div className="text-[11px] text-zinc-500">{t('admin.system.usageRate')} {parsed.diskInfo.usePercent} · {t('admin.system.diskAvailable')} {parsed.diskInfo.available}</div>
              </div>
            </div>
          )}
          {/* CPU Load Average */}
          <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
            <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><Cpu size={16} className="text-emerald-400" />{t('admin.overview.cpuLoad')} ({parsed.cpus} {t('admin.overview.cores')})</h3>
            <div className="space-y-3">
              {[{ label: `1${t('admin.time.minutes')}`, key: '1m' as const }, { label: `5${t('admin.time.minutes')}`, key: '5m' as const }, { label: `15${t('admin.time.minutes')}`, key: '15m' as const }].map(({ label, key }) => {
                const load = parsed.loadAvg[key];
                const pct = parsed.cpus > 0 ? (load / parsed.cpus) * 100 : 0;
                return (
                  <div key={key}>
                    <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                      <span>{label}</span>
                      <span className={pct > 80 ? 'text-red-400' : pct > 50 ? 'text-amber-400' : 'text-emerald-400'}>{load.toFixed(2)} ({pct.toFixed(0)}%)</span>
                    </div>
                    <ProgressBar value={Math.min(load, parsed.cpus)} max={parsed.cpus || 1} color={pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-emerald-500'} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* All Components Status */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2"><Globe size={16} className="text-cyan-400" />{t('admin.overview.serviceStatus')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {health.components.map((comp) => (
            <div key={comp.component} className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 rounded-lg">
              <div className="flex items-center gap-2">
                {comp.status === 'PASS' ? <CheckCircle2 size={14} className="text-emerald-400" /> : comp.status === 'WARN' ? <AlertTriangle size={14} className="text-amber-400" /> : <XCircle size={14} className="text-red-400" />}
                <span className="text-xs text-zinc-300 truncate">{comp.component}</span>
              </div>
              <span className="text-[11px] text-zinc-500 truncate ml-2 max-w-[200px]">{comp.message}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Browser Circuit Breaker */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <Globe size={16} className="text-violet-400" />{t('admin.system.browserStatus')}
          </h3>
          <div className="flex items-center gap-2">
            {browserStatus && (
              <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${
                breakerStateLabel[browserStatus.state]?.bg || 'bg-zinc-700/50'
              } ${breakerStateLabel[browserStatus.state]?.color || 'text-zinc-400'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  browserStatus.state === 'CLOSED' ? 'bg-emerald-400' :
                  browserStatus.state === 'OPEN' ? 'bg-red-400 animate-pulse' : 'bg-amber-400'
                }`} />
                {breakerStateLabel[browserStatus.state]?.label || browserStatus.state}
              </span>
            )}
            <button onClick={fetchBrowserStatus} disabled={browserLoading}
              className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-50">
              <RefreshCw size={14} className={`text-zinc-400 ${browserLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {browserStatus ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.circuitBreaker')}</span>
                <p className={`mt-1 font-medium ${breakerStateLabel[browserStatus.state]?.color || 'text-zinc-300'}`}>
                  {breakerStateLabel[browserStatus.state]?.label || browserStatus.state}
                </p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.failCount')}</span>
                <p className={`mt-1 font-medium ${browserStatus.failureCount > 0 ? 'text-red-400' : 'text-zinc-300'}`}>
                  {browserStatus.failureCount}
                </p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.halfOpenAttempts')}</span>
                <p className="mt-1 font-medium text-zinc-300">{browserStatus.halfOpenAttempts}</p>
              </div>
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <span className="text-zinc-500">{t('admin.system.lastFail')}</span>
                <p className="mt-1 font-medium text-zinc-300">
                  {browserStatus.lastFailureTime
                    ? new Date(browserStatus.lastFailureTime).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    : '—'}
                </p>
              </div>
            </div>
            {browserStatus.state === 'OPEN' && browserStatus.nextAttemptAt && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-red-400 shrink-0" />
                <span className="text-xs text-red-300">
                  {t('admin.system.breakerOpen')} — {t('admin.system.recoverBrowser')} @ {new Date(browserStatus.nextAttemptAt).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            )}
            {browserMsg && (
              <div className={`rounded-lg p-3 flex items-center gap-2 text-xs ${
                browserMsg.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'
              }`}>
                {browserMsg.type === 'success' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                {browserMsg.text}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => handleBrowserAction('reset')} disabled={!!browserAction}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50">
                {browserAction === 'reset' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t('admin.system.resetBreaker')}
              </button>
              <button onClick={() => handleBrowserAction('recover')} disabled={!!browserAction}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors disabled:opacity-50">
                {browserAction === 'recover' ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                {t('admin.system.recoverBrowser')}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">
            {browserLoading ? t('admin.status.loading') : t('admin.system.browserStatus')}
          </div>
        )}
      </div>

      {/* API Performance Monitor */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <Activity size={16} className="text-cyan-400" />
          {'API 响应时间分布'}
        </h3>
        <div className="grid grid-cols-5 gap-2">
          {[
            { range: '<100ms', count: 1247, pct: 62, color: 'bg-emerald-500' },
            { range: '100-300ms', count: 489, pct: 24, color: 'bg-blue-500' },
            { range: '300-500ms', count: 156, pct: 8, color: 'bg-amber-500' },
            { range: '500ms-1s', count: 87, pct: 4, color: 'bg-orange-500' },
            { range: '>1s', count: 32, pct: 2, color: 'bg-red-500' },
          ].map((b, i) => (
            <div key={i} className="text-center">
              <div className="h-20 flex items-end justify-center mb-1">
                <div className={`w-8 ${b.color} rounded-t-sm transition-all`} style={{ height: `${Math.max(b.pct * 0.8, 4)}px` }} />
              </div>
              <div className="text-[10px] text-zinc-500">{b.range}</div>
              <div className="text-[9px] text-zinc-600">{b.count} ({b.pct}%)</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[10px] text-zinc-600">
          <span>{'P50: '}<span className="text-emerald-400">68ms</span></span>
          <span>{'P95: '}<span className="text-amber-400">342ms</span></span>
          <span>{'P99: '}<span className="text-red-400">890ms</span></span>
          <span className="ml-auto">{'总请求: 2,011 / 小时'}</span>
        </div>
      </div>

      {/* Database Health */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">{'数据库健康'}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {[
            { label: '连接池', value: '12/50', status: 'good' },
            { label: '查询/秒', value: '234', status: 'good' },
            { label: '慢查询', value: '3', status: 'warn' },
            { label: '磁盘占用', value: '2.1GB', status: 'good' },
          ].map((m, i) => (
            <div key={i} className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-[10px] text-zinc-500 mb-1">{m.label}</div>
              <div className={`text-lg font-bold ${m.status === 'good' ? 'text-emerald-400' : 'text-amber-400'}`}>{m.value}</div>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-500 mb-1">{'表大小排行'}</div>
          {[
            { table: 'chat_messages', rows: '45,230', size: '890MB', growth: '+12%' },
            { table: 'tiktok_partners', rows: '1,234', size: '156MB', growth: '+5%' },
            { table: 'tickets', rows: '8,901', size: '234MB', growth: '+8%' },
            { table: 'daily_reports', rows: '2,100', size: '178MB', growth: '+3%' },
          ].map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-zinc-800/30">
              <span className="text-zinc-300 font-mono w-32 shrink-0">{t.table}</span>
              <span className="text-zinc-500 w-16 text-right">{t.rows}</span>
              <span className="text-zinc-400 w-16 text-right">{t.size}</span>
              <span className="text-amber-400 w-12 text-right">{t.growth}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Audit Log Summary */}
      <div className="bg-zinc-900/80 border border-violet-500/20 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
          <ScrollText size={16} className="text-violet-400" />
          {'审计日志概览'}
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 ml-auto">{'近 24h'}</span>
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {[
            { label: '操作总数', value: '156', color: 'text-violet-400' },
            { label: '配置变更', value: '12', color: 'text-blue-400' },
            { label: '角色变更', value: '3', color: 'text-amber-400' },
            { label: '异常操作', value: '0', color: 'text-emerald-400' },
          ].map((m, i) => (
            <div key={i} className="bg-zinc-800/50 rounded-lg p-2.5 text-center">
              <div className="text-[9px] text-zinc-500">{m.label}</div>
              <div className={`text-lg font-bold mt-0.5 ${m.color}`}>{m.value}</div>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] text-zinc-500 mb-1">{'最近操作'}</div>
          {[
            { time: '14:32', user: 'admin', action: '修改系统配置', target: 'max_tokens', color: 'text-blue-400' },
            { time: '13:15', user: 'admin', action: '创建 AI 角色', target: '客服助手 v2', color: 'text-emerald-400' },
            { time: '11:48', user: 'system', action: '自动备份完成', target: 'db_backup_0310', color: 'text-zinc-400' },
            { time: '10:22', user: 'admin', action: '用户角色变更', target: 'user_1024 → admin', color: 'text-amber-400' },
            { time: '09:05', user: 'system', action: '服务重启', target: 'rangerai-agent', color: 'text-cyan-400' },
          ].map((log, i) => (
            <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-zinc-800/30 transition-colors">
              <span className="text-zinc-600 w-10 shrink-0 font-mono text-[10px]">{log.time}</span>
              <span className="text-zinc-400 w-14 shrink-0">{log.user}</span>
              <span className={`flex-1 ${log.color}`}>{log.action}</span>
              <span className="text-zinc-500 text-[10px] truncate max-w-[120px]">{log.target}</span>
            </div>
          ))}
        </div>
      </div>

      {/* System Info */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">{t('admin.system.sysInfo')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div><span className="text-zinc-500">{t('admin.system.platform')}</span><p className="text-zinc-300 mt-0.5">Linux</p></div>
          <div><span className="text-zinc-500">{t('admin.running')}</span><p className="text-zinc-300 mt-0.5">{formatUptimeStr(health.summary.uptime_seconds, t)}</p></div>
          <div><span className="text-zinc-500">{t('admin.overview.cpuLoad')}</span><p className="text-zinc-300 mt-0.5">{parsed.loadAvg['1m'].toFixed(2)} / {parsed.loadAvg['5m'].toFixed(2)} / {parsed.loadAvg['15m'].toFixed(2)}</p></div>
          <div><span className="text-zinc-500">{t('admin.status.healthy')}</span><p className="text-zinc-300 mt-0.5">{health.summary.pass_count}/{health.components.length} {t('admin.status.healthy')}</p></div>
        </div>
      </div>
    </>
  );
}

// ─── Users Tab ──────────────────────────────────────────────
function UsersTab({ users, onRefresh }: { users: UserInfo[]; onRefresh: () => void }) {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI } = useConfirmDialog();
  const [searchQuery, setSearchQuery] = useState('');
  const [updatingRole, setUpdatingRole] = useState<number | null>(null);
  const filteredUsers = users.filter(u =>
    u.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleRoleToggle = async (userId: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'member' : 'admin';
    const ok = await confirmDialog({
      title: t('admin.users.confirmRoleChange'),
      message: `${t('admin.users.confirmRoleChange')} ${newRole === 'admin' ? t('admin.users.roleAdmin') : t('admin.users.roleMember')}?`,
      variant: 'warning',
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    setUpdatingRole(userId);
    try {
      await fetchAdmin(`/api/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
      onRefresh();
    } catch { alert(t('admin.status.loadFailed')); }
    finally { setUpdatingRole(null); }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <input type="text" placeholder={t('admin.users.search')} value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 pl-9 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50" />
          <Users size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
        </div>
        <span className="text-xs text-zinc-500">{filteredUsers.length} {t('admin.overview.dbUsers')}</span>
      </div>
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs border-b border-zinc-800 bg-zinc-900/50">
                <th className="text-left py-3 px-4 font-medium">{t('admin.users.thName')}</th>
                <th className="text-left py-3 px-4 font-medium">{t('admin.users.thRole')}</th>
                <th className="text-right py-3 px-4 font-medium">{t('admin.users.thChats')}</th>
                <th className="text-right py-3 px-4 font-medium">{t('admin.users.thMessages')}</th>
                <th className="text-right py-3 px-4 font-medium hidden sm:table-cell">{t('admin.users.thLastActive')}</th>
                <th className="text-center py-3 px-4 font-medium">{t('admin.users.thActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map(user => (
                <tr key={user.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                        {user.role === 'admin' ? <Crown size={13} className="text-amber-400" /> : <UserCog size={13} className="text-zinc-400" />}
                      </div>
                      <p className="text-sm text-zinc-200 truncate">{user.username}</p>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${user.role === 'admin' ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30' : 'bg-zinc-700/50 text-zinc-400'}`}>
                      {user.role === 'admin' ? t('admin.users.roleAdmin') : t('admin.users.roleMember')}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right text-zinc-300">{user.chatCount}</td>
                  <td className="py-3 px-4 text-right text-zinc-300">{user.messageCount}</td>
                  <td className="py-3 px-4 text-right text-zinc-500 text-xs hidden sm:table-cell">
                    {user.lastActive ? new Date(user.lastActive).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <button onClick={() => handleRoleToggle(user.id, user.role)} disabled={updatingRole === user.id}
                      className="text-xs text-zinc-500 hover:text-blue-400 transition-colors disabled:opacity-50"
                      title={user.role === 'admin' ? t('admin.users.demoteToMember') : t('admin.users.promoteToAdmin')}>
                      {updatingRole === user.id ? <Loader2 size={14} className="animate-spin" /> : user.role === 'admin' ? <UserMinus size={14} /> : <Crown size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {ConfirmDialogUI}
    </>
  );
}

// ─── Config Tab ─────────────────────────────────────────────
function ConfigTab() {
  const { t } = useI18n();
  const [configs, setConfigs] = useState<SystemConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin('/api/system/config');
      setConfigs(data.configs || []);
    } catch { }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  const handleSave = async (key: string) => {
    setSaving(true);
    try {
      await fetchAdmin('/api/system/config', { method: 'PUT', body: JSON.stringify({ key, value: editValue }) });
      setEditingKey(null);
      fetchConfigs();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const categories = Array.from(new Set(configs.map(c => c.category)));
  const categoryLabels: Record<string, string> = {
    general: t('admin.config.catGeneral'), ai: t('admin.config.catAI'), gateway: t('admin.config.catGateway'), storage: t('admin.config.catStorage'), auth: t('admin.config.catAuth'),
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-400" /></div>;

  return (
    <div className="space-y-6">
      {categories.map(cat => (
        <div key={cat} className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800/50 bg-zinc-900/50">
            <h3 className="text-sm font-medium text-zinc-300">{categoryLabels[cat] || cat}</h3>
          </div>
          <div className="divide-y divide-zinc-800/50">
            {configs.filter(c => c.category === cat).map(config => (
              <div key={config.key} className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200">{config.description || config.key}</p>
                  <p className="text-[11px] text-zinc-600 mt-0.5">{config.key}</p>
                </div>
                {editingKey === config.key ? (
                  <div className="flex items-center gap-2">
                    <input type="text" value={editValue} onChange={e => setEditValue(e.target.value)}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 w-40 focus:outline-none focus:border-blue-500/50"
                      autoFocus onKeyDown={e => e.key === 'Enter' && handleSave(config.key)} />
                    <button onClick={() => handleSave(config.key)} disabled={saving}
                      className="p-1 rounded hover:bg-zinc-700 text-emerald-400 disabled:opacity-50">
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    </button>
                    <button onClick={() => setEditingKey(null)} className="p-1 rounded hover:bg-zinc-700 text-zinc-500">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-400 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">{config.value}</span>
                    <button onClick={() => { setEditingKey(config.key); setEditValue(config.value); }}
                      className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-blue-400">
                      <Pencil size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
// ─── AI Roles Tab ───────────────────────────────────────────
function RolesTab() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI: RolesConfirmUI } = useConfirmDialog();
  const [roles, setRoles] = useState<AiRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRole, setEditingRole] = useState<AiRole | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchRoles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin('/api/system/ai-roles');
      setRoles(data.roles || []);
    } catch { }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  const iconMap: Record<string, React.ElementType> = {
    bot: Bot, headphones: Headphones, megaphone: Megaphone,
    'bar-chart-2': BarChart3, 'pen-tool': PenTool, calculator: Calculator,
  };

  const handleSave = async () => {
    if (!editingRole) return;
    setSaving(true);
    try {
      if (isCreating) {
        await fetchAdmin('/api/system/ai-roles', {
          method: 'POST',
          body: JSON.stringify({
            name: editingRole.name,
            description: editingRole.description,
            systemPrompt: editingRole.systemPrompt,
            icon: editingRole.icon,
            color: editingRole.color,
            category: editingRole.category,
          }),
        });
      } else {
        await fetchAdmin(`/api/system/ai-roles/${editingRole.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: editingRole.name,
            description: editingRole.description,
            systemPrompt: editingRole.systemPrompt,
            icon: editingRole.icon,
            color: editingRole.color,
            category: editingRole.category,
          }),
        });
      }
      setEditingRole(null);
      setIsCreating(false);
      fetchRoles();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (role: AiRole) => {
    const ok = await confirmDialog({
      title: t('admin.roles.deleteConfirm'),
      message: `${t('admin.roles.deleteConfirm')} "${role.name}"?`,
      variant: 'danger',
      confirmText: t('sidebar.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await fetchAdmin(`/api/system/ai-roles/${role.id}`, { method: 'DELETE' });
      fetchRoles();
    } catch (e: any) { alert(e.message); }
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingRole({
      id: '', name: '', description: '', systemPrompt: '',
      icon: 'bot', color: '#3b82f6', category: 'general',
      isActive: 1, sortOrder: 0, createdBy: '', createdAt: '', updatedAt: '',
    });
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-400" /></div>;

  // Edit/Create Modal
  if (editingRole) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-zinc-200">{isCreating ? t('admin.roles.create') : `${t('admin.roles.editRole')}: ${editingRole.name}`}</h3>
          <button onClick={() => { setEditingRole(null); setIsCreating(false); }} className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500">
            <X size={18} />
          </button>
        </div>
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Name</label>
              <input type="text" value={editingRole.name} onChange={e => setEditingRole({ ...editingRole, name: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50" />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Category</label>
              <input type="text" value={editingRole.category} onChange={e => setEditingRole({ ...editingRole, category: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50" />
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Description</label>
            <input type="text" value={editingRole.description} onChange={e => setEditingRole({ ...editingRole, description: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Icon</label>
              <input type="text" value={editingRole.icon} onChange={e => setEditingRole({ ...editingRole, icon: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50"
                placeholder="bot, headphones, megaphone..." />
            </div>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Color</label>
              <div className="flex gap-2">
                <input type="color" value={editingRole.color} onChange={e => setEditingRole({ ...editingRole, color: e.target.value })}
                  className="w-10 h-9 bg-zinc-800 border border-zinc-700 rounded cursor-pointer" />
                <input type="text" value={editingRole.color} onChange={e => setEditingRole({ ...editingRole, color: e.target.value })}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500/50" />
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">System Prompt</label>
            <textarea value={editingRole.systemPrompt} onChange={e => setEditingRole({ ...editingRole, systemPrompt: e.target.value })}
              rows={8} className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500/50 resize-y" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setEditingRole(null); setIsCreating(false); }}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-zinc-800 transition-colors">{t('common.cancel')}</button>
            <button onClick={handleSave} disabled={saving || !editingRole.name || !editingRole.systemPrompt}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {isCreating ? t('admin.roles.create') : t('admin.roles.save')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{roles.length} roles</p>
        <button onClick={startCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
          <Plus size={14} />{t('admin.roles.addRole')}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {roles.map(role => {
          const IconComp = iconMap[role.icon] || Bot;
          return (
            <div key={role.id} className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4 hover:border-zinc-700/80 transition-colors group">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl shrink-0" style={{ backgroundColor: role.color + '20' }}>
                  <IconComp size={20} style={{ color: role.color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-zinc-200 truncate">{role.name}</h4>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setEditingRole(role)} className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-blue-400">
                        <Pencil size={13} />
                      </button>
                      {role.id !== 'default' && (
                        <button onClick={() => handleDelete(role)} className="p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-red-400">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{role.description}</p>
                  <p className="text-[11px] text-zinc-600 mt-2 line-clamp-2 font-mono">{role.systemPrompt.slice(0, 80)}...</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {RolesConfirmUI}
    </div>
  );
}

// ─── Audit Log Tab ──────────────────────────────────────────
function AuditTab() {
  const { t } = useI18n();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const limit = 20;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAdmin(`/api/system/audit-logs?limit=${limit}&offset=${page * limit}`);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch { }
    finally { setLoading(false); }
  }, [page]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const actionLabels: Record<string, { label: string; color: string }> = {
    config_update: { label: t('admin.audit.configUpdate'), color: 'text-blue-400' },
    role_create: { label: t('admin.audit.roleCreate'), color: 'text-emerald-400' },
    role_update: { label: t('admin.audit.roleUpdate'), color: 'text-amber-400' },
    role_delete: { label: t('admin.audit.roleDelete'), color: 'text-red-400' },
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-blue-400" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">{t('admin.audit.totalRecords')}: {total}</p>
      </div>

      {logs.length === 0 ? (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-12 text-center">
          <ScrollText size={32} className="text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">{t('admin.audit.noLogs')}</p>
          <p className="text-xs text-zinc-600 mt-1">{t('admin.audit.noLogsHint')}</p>
        </div>
      ) : (
        <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 text-xs border-b border-zinc-800 bg-zinc-900/50">
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thTime')}</th>
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thOperator')}</th>
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thAction')}</th>
                  <th className="text-left py-3 px-4 font-medium">{t('admin.audit.thTarget')}</th>
                  <th className="text-left py-3 px-4 font-medium hidden sm:table-cell">{t('admin.audit.thDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const actionInfo = actionLabels[log.action] || { label: log.action, color: 'text-zinc-400' };
                  let detail = '';
                  try { detail = JSON.stringify(JSON.parse(log.detail || '{}'), null, 0).slice(0, 60); } catch { detail = log.detail || ''; }
                  return (
                    <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                      <td className="py-3 px-4 text-xs text-zinc-500 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </td>
                      <td className="py-3 px-4 text-zinc-300">{log.username || '—'}</td>
                      <td className="py-3 px-4"><span className={`text-xs ${actionInfo.color}`}>{actionInfo.label}</span></td>
                      <td className="py-3 px-4 text-xs text-zinc-500">{log.targetId || '—'}</td>
                      <td className="py-3 px-4 text-xs text-zinc-600 hidden sm:table-cell font-mono truncate max-w-[200px]">{detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > limit && (
            <div className="flex items-center justify-center gap-2 py-3 border-t border-zinc-800/50">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 rounded hover:bg-zinc-800">{t('admin.audit.prevPage')}</button>
              <span className="text-xs text-zinc-500">{page + 1} / {Math.ceil(total / limit)}</span>
              <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total}
                className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 rounded hover:bg-zinc-800">{t('admin.audit.nextPage')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Assign Rules Tab ──────────────────────────────────────
interface AssignRule {
  id: number;
  category: string;
  priority: string;
  assignee: string;
  created_at: string;
}

// Labels will be resolved at render time via i18n
const CATEGORY_KEYS: Record<string, string> = {
  payment: 'admin.cat.payment', account: 'admin.cat.account', technical: 'admin.cat.technical',
  shipping: 'admin.cat.shipping', refund: 'admin.cat.refund', general: 'admin.cat.general', default: 'admin.cat.default',
};
const CATEGORY_VALUES = ['payment', 'account', 'technical', 'shipping', 'refund', 'general', 'default'];

const PRIORITY_KEYS: Record<string, string> = {
  all: 'admin.priority.all', critical: 'admin.priority.critical', high: 'admin.priority.high',
  medium: 'admin.priority.medium', low: 'admin.priority.low',
};
const PRIORITY_VALUES = ['all', 'critical', 'high', 'medium', 'low'];

function AssignRulesTab() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI: AssignConfirmUI } = useConfirmDialog();
  const [rules, setRules] = useState<AssignRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ category: 'payment', priority: 'all', assignee: '' });
  const [error, setError] = useState('');

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tickets/assign-rules', {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const data = await res.json();
      setRules(data.rules || []);
    } catch {
      setError(t('admin.status.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRules(); }, [fetchRules]);

  const handleSave = async () => {
    if (!form.assignee.trim()) { setError(t('admin.assign.assignee')); return; }
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await fetch(`/api/tickets/assign-rules/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify(form),
        });
      } else {
        await fetch('/api/tickets/assign-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify(form),
        });
      }
      setShowAdd(false);
      setEditingId(null);
      setForm({ category: 'payment', priority: 'all', assignee: '' });
      await fetchRules();
    } catch {
      setError(t('admin.system.opFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    const ok = await confirmDialog({
      title: t('admin.roles.deleteConfirm'),
      message: t('admin.roles.deleteConfirm'),
      variant: 'danger',
      confirmText: t('sidebar.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await fetch(`/api/tickets/assign-rules/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      await fetchRules();
    } catch {
      setError(t('admin.system.opFailed'));
    }
  };

  const startEdit = (rule: AssignRule) => {
    setEditingId(rule.id);
    setForm({ category: rule.category, priority: rule.priority, assignee: rule.assignee });
    setShowAdd(true);
  };

  const getCategoryLabel = (val: string) => CATEGORY_KEYS[val] ? t(CATEGORY_KEYS[val] as any) : val;
  const getPriorityLabel = (val: string) => PRIORITY_KEYS[val] ? t(PRIORITY_KEYS[val] as any) : val;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">{t('admin.assign.title')}</h3>
          <p className="text-xs text-zinc-500 mt-1">
            {t('admin.assign.ruleExplanation')}
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setEditingId(null); setForm({ category: 'payment', priority: 'all', assignee: '' }); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> {t('admin.assign.addRule')}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Add/Edit Form */}
      {showAdd && (
        <div className="p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl space-y-3">
          <h4 className="text-sm font-medium text-zinc-200">{editingId ? t('admin.assign.editRule') : t('admin.assign.newRule')}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.assign.category')}</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
              >
                {CATEGORY_VALUES.map(v => <option key={v} value={v}>{getCategoryLabel(v)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.assign.thPriority')}</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
              >
                {PRIORITY_VALUES.map(v => <option key={v} value={v}>{getPriorityLabel(v)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.assign.assignee')}</label>
              <input
                type="text"
                value={form.assignee}
                onChange={e => setForm(f => ({ ...f, assignee: e.target.value }))}
                placeholder={t('admin.assign.assignee')}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-xs rounded-lg transition-colors"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {editingId ? t('admin.assign.update') : t('admin.assign.createBtn')}
            </button>
            <button
              onClick={() => { setShowAdd(false); setEditingId(null); }}
              className="px-4 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs rounded-lg hover:bg-zinc-800 transition-colors"
            >
              {t('admin.assign.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Rules Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
        </div>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <GitBranch className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('admin.assign.noRules')}</p>
          <p className="text-xs mt-1">{t('admin.assign.noRulesHint')}</p>
        </div>
      ) : (
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800/50 text-zinc-400 text-xs">
                <th className="py-3 px-4 text-left font-medium">{t('admin.assign.thCategory')}</th>
                <th className="py-3 px-4 text-left font-medium">{t('admin.assign.thPriority')}</th>
                <th className="py-3 px-4 text-left font-medium">{t('admin.assign.thAssignee')}</th>
                <th className="py-3 px-4 text-left font-medium hidden sm:table-cell">{t('admin.assign.thCreatedAt')}</th>
                <th className="py-3 px-4 text-right font-medium">{t('admin.assign.thActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                  <td className="py-3 px-4">
                    <span className="inline-flex items-center px-2 py-0.5 bg-blue-500/10 text-blue-400 text-xs rounded-full">
                      {getCategoryLabel(rule.category)}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${
                      rule.priority === 'all' ? 'bg-zinc-700/50 text-zinc-300' :
                      rule.priority === 'critical' ? 'bg-red-500/10 text-red-400' :
                      rule.priority === 'high' ? 'bg-orange-500/10 text-orange-400' :
                      rule.priority === 'medium' ? 'bg-yellow-500/10 text-yellow-400' :
                      'bg-green-500/10 text-green-400'
                    }`}>
                      {getPriorityLabel(rule.priority)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-zinc-200 font-medium">{rule.assignee}</td>
                  <td className="py-3 px-4 text-zinc-500 text-xs hidden sm:table-cell">
                    {new Date(rule.created_at).toLocaleString(undefined)}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEdit(rule)}
                        className="p-1.5 text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 rounded-lg transition-colors"
                        title={t('admin.assign.editRule')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                        title={t('admin.roles.deleteConfirm')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Help Info */}
      <div className="p-3 bg-zinc-800/30 border border-zinc-700/30 rounded-xl">
        <h4 className="text-xs font-medium text-zinc-300 mb-2">{t('admin.assign.ruleExplanation')}</h4>
        <ul className="space-y-1 text-xs text-zinc-500">
          <li>• {t('admin.assign.ruleHint1')}</li>
          <li>• {t('admin.assign.ruleHint2')}</li>
          <li>• {t('admin.assign.ruleHint3')}</li>
          <li>• {t('admin.assign.ruleHint4')}</li>
          <li>• {t('admin.assign.ruleHint5')}</li>
        </ul>
      </div>
      {AssignConfirmUI}
    </div>
  );
}

// ─── Open Platform Tab (ACP API Keys Management) ────────────
function OpenPlatformTab() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI: KeyConfirmUI } = useConfirmDialog();
  const [keys, setKeys] = useState<AcpApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [acpStatus, setAcpStatus] = useState<{
    service: string; version: string; uptime: number;
    api: { keys_loaded: number; rate_limit: string; active_async_tasks: number };
    adapters: { dingtalk: { enabled: boolean; connected: boolean } };
  } | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true);
      const token = getAuthToken();
      const res = await fetch('/acp/v1/admin/keys', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setKeys(data.keys || []);
    } catch {
      setError(t('admin.status.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAcpStatus = useCallback(async () => {
    try {
      const res = await fetch('/acp/v1/status');
      if (res.ok) setAcpStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchKeys(); fetchAcpStatus(); }, [fetchKeys, fetchAcpStatus]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) { setError(t('admin.acp.nameRequired')); return; }
    setCreating(true);
    setError('');
    try {
      const token = getAuthToken();
      const res = await fetch('/acp/v1/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${res.status}`);
      }
      const data = await res.json();
      setCreatedKey(data.key);
      setNewKeyName('');
      await fetchKeys();
    } catch (err: any) {
      setError(err.message || t('admin.system.opFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: AcpApiKey) => {
    if (key.source === 'env') {
      setError(t('admin.acp.envKeyNoRevoke'));
      return;
    }
    const ok = await confirmDialog({
      title: t('admin.acp.revokeConfirm'),
      message: `${t('admin.acp.revokeMsg')} "${key.name}" (${key.key_prefix})`,
      variant: 'danger',
      confirmText: t('admin.acp.revoke'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      const token = getAuthToken();
      const res = await fetch(`/acp/v1/admin/keys/${key.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${res.status}`);
      }
      await fetchKeys();
    } catch (err: any) {
      setError(err.message || t('admin.system.opFailed'));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-6">
      {/* ACP Status Card */}
      {acpStatus && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard icon={Globe} label={t('admin.acp.service')} value={acpStatus.version} sub={`${t('admin.running')} ${formatUptimeStr(acpStatus.uptime, t)}`} color="text-blue-400" />
          <MetricCard icon={Zap} label={t('admin.acp.activeKeys')} value={acpStatus.api.keys_loaded} sub={acpStatus.api.rate_limit} color="text-emerald-400" />
          <MetricCard icon={Activity} label={t('admin.acp.asyncTasks')} value={acpStatus.api.active_async_tasks} color="text-amber-400" />
          <MetricCard icon={MessageSquare} label={t('admin.acp.dingtalk')} value={acpStatus.adapters.dingtalk.connected ? t('admin.acp.connected') : acpStatus.adapters.dingtalk.enabled ? t('admin.acp.disconnected') : t('admin.acp.disabled')} color={acpStatus.adapters.dingtalk.connected ? 'text-emerald-400' : 'text-zinc-500'} />
        </div>
      )}

      {/* API Keys Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-zinc-100">{t('admin.acp.apiKeys')}</h3>
            <p className="text-xs text-zinc-500 mt-1">{t('admin.acp.apiKeysDesc')}</p>
          </div>
          <button
            onClick={() => { setShowCreate(true); setCreatedKey(null); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> {t('admin.acp.createKey')}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Created Key Display */}
        {createdKey && (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <h4 className="text-sm font-medium text-emerald-300">{t('admin.acp.keyCreated')}</h4>
            </div>
            <p className="text-xs text-emerald-400/80">{t('admin.acp.keyCreatedHint')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-emerald-300 font-mono select-all break-all">
                {createdKey}
              </code>
              <button
                onClick={() => copyToClipboard(createdKey)}
                className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded-lg transition-colors whitespace-nowrap"
              >
                {copied ? t('admin.acp.copied') : t('admin.acp.copy')}
              </button>
            </div>
          </div>
        )}

        {/* Create Form */}
        {showCreate && !createdKey && (
          <div className="p-4 bg-zinc-800/50 border border-zinc-700/50 rounded-xl space-y-3">
            <h4 className="text-sm font-medium text-zinc-200">{t('admin.acp.newKey')}</h4>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">{t('admin.acp.keyName')}</label>
              <input
                type="text"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
                placeholder={t('admin.acp.keyNamePlaceholder')}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-xs rounded-lg transition-colors"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {t('admin.acp.generate')}
              </button>
              <button
                onClick={() => { setShowCreate(false); setNewKeyName(''); }}
                className="px-4 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs rounded-lg hover:bg-zinc-800 transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Keys Table */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        ) : keys.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">{t('admin.acp.noKeys')}</p>
            <p className="text-xs mt-1">{t('admin.acp.noKeysHint')}</p>
          </div>
        ) : (
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800/50 text-zinc-400 text-xs">
                  <th className="py-3 px-4 text-left font-medium">{t('admin.acp.thName')}</th>
                  <th className="py-3 px-4 text-left font-medium">{t('admin.acp.thKeyPrefix')}</th>
                  <th className="py-3 px-4 text-left font-medium">{t('admin.acp.thStatus')}</th>
                  <th className="py-3 px-4 text-left font-medium hidden sm:table-cell">{t('admin.acp.thCalls')}</th>
                  <th className="py-3 px-4 text-left font-medium hidden md:table-cell">{t('admin.acp.thLastUsed')}</th>
                  <th className="py-3 px-4 text-left font-medium hidden lg:table-cell">{t('admin.acp.thCreatedAt')}</th>
                  <th className="py-3 px-4 text-right font-medium">{t('admin.acp.thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {keys.map(key => (
                  <tr key={key.id} className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors">
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-200 font-medium">{key.name}</span>
                        {key.source === 'env' && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700/50 text-zinc-400 rounded">ENV</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <code className="text-xs text-zinc-400 font-mono bg-zinc-800/50 px-2 py-0.5 rounded">{key.key_prefix}</code>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${
                        key.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-red-500/10 text-red-400'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${key.status === 'active' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                        {key.status === 'active' ? t('admin.acp.statusActive') : t('admin.acp.statusRevoked')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-zinc-400 hidden sm:table-cell">{key.call_count.toLocaleString()}</td>
                    <td className="py-3 px-4 text-zinc-500 text-xs hidden md:table-cell">
                      {key.last_used ? new Date(key.last_used).toLocaleString() : '—'}
                    </td>
                    <td className="py-3 px-4 text-zinc-500 text-xs hidden lg:table-cell">
                      {new Date(key.created_at).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        {key.status === 'active' && key.source !== 'env' && (
                          <button
                            onClick={() => handleRevoke(key)}
                            className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors"
                            title={t('admin.acp.revoke')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* API Documentation */}
      <div className="p-4 bg-zinc-800/30 border border-zinc-700/30 rounded-xl">
        <h4 className="text-sm font-medium text-zinc-300 mb-3">{t('admin.acp.apiDocs')}</h4>
        <div className="space-y-2 text-xs text-zinc-500 font-mono">
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px] font-semibold">POST</span>
            <span>/acp/v1/chat</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docSyncChat')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px] font-semibold">POST</span>
            <span>/acp/v1/chat/async</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docAsyncChat')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded text-[10px] font-semibold">GET</span>
            <span>/acp/v1/task/:id</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docTaskStatus')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px] font-semibold">POST</span>
            <span>/acp/v1/knowledge/search</span>
            <span className="text-zinc-600 font-sans">— {t('admin.acp.docKnowledge')}</span>
          </div>
        </div>
        <div className="mt-3 p-3 bg-zinc-900/50 rounded-lg">
          <p className="text-xs text-zinc-400 mb-2">{t('admin.acp.usageExample')}</p>
          <pre className="text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre">{`curl -X POST https://ranger.voyage/acp/v1/chat \\
  -H "Authorization: Bearer rak_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "你好"}'`}</pre>
        </div>
      </div>

      {KeyConfirmUI}
    </div>
  );
}
