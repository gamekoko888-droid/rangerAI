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
  PanelLeftClose, PanelLeftOpen, Target, RotateCcw, Gauge, Pause, Play, Calendar,
  FileText, ShieldAlert, PlayCircle, Ban, CircleSlash, Eye, Image, Crosshair, ListTodo, BookOpen,
} from 'lucide-react';
import GatewayQuotaTab from './admin/GatewayQuotaTab';
import SupervisorMetricsTab from './admin/SupervisorMetricsTab';
import BrowserEvidenceTab from './admin/BrowserEvidenceTab';
import TaskFocusTab from './admin/TaskFocusTab';
import HintAdoptionTab from './admin/HintAdoptionTab';
import TicketsTab from './admin/TicketsTab';
import TaskReplayTab from './admin/TaskReplayTab';
import WebTaskStatsTab from './admin/WebTaskStatsTab';
import KnowledgeTab from './admin/KnowledgeTab';
import EventReplay from './EventReplay';
import { SystemTab } from './admin/SystemTab';
import { UsersTab } from './admin/UsersTab';
import { ConfigTab } from './admin/ConfigTab';
import { RolesTab } from './admin/RolesTab';
import { AuditTab } from './admin/AuditTab';
import { AssignRulesTab } from './admin/AssignRulesTab';
import { OpenPlatformTab } from './admin/OpenPlatformTab';
import ToolMemoryTab from './admin/ToolMemoryTab';
import SupervisorTab from './admin/SupervisorTab';
import { logger } from "../lib/logger";

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
type TabId = 'overview' | 'users' | 'system' | 'config' | 'roles' | 'audit' | 'assign-rules' | 'open-platform' | 'tool-memory' | 'supervisor' | 'gateway-quota' | 'supervisor-metrics' | 'browser-evidence' | 'task-focus' | 'hint-adoption' | 'tickets' | 'task-replay' | 'event-replay' | 'web-task-stats' | 'knowledge';

const TAB_KEYS: Record<TabId, string> = {
  overview: 'admin.tab.overview',
  system: 'admin.tab.system',
  users: 'admin.tab.users',
  config: 'admin.tab.config',
  roles: 'admin.tab.roles',
  audit: 'admin.tab.audit',
  'assign-rules': 'admin.tab.assignRules',
  'open-platform': 'admin.tab.openPlatform',
  'tool-memory': 'admin.tab.toolMemory',
  supervisor: 'Supervisor',
  'gateway-quota': '配额监控',
  'supervisor-metrics': 'Supervisor Metrics',
  'browser-evidence': 'Browser Evidence',
  'task-focus': 'Task Focus',
  'hint-adoption': 'Hint Adoption',
  'tickets': 'Risk Tickets',
  'task-replay': 'Task Replay',
  'event-replay': 'Event Replay',
  'web-task-stats': 'Web Task Stats',
  'knowledge': 'Knowledge Base',
};
const TAB_ICONS: Record<TabId, React.ElementType> = {
  overview: BarChart3, system: Server, users: Users, config: Settings, roles: Bot, audit: ScrollText, 'assign-rules': GitBranch, 'open-platform': Globe, 'tool-memory': MemoryStick, supervisor: Target, 'gateway-quota': Gauge, 'supervisor-metrics': ShieldAlert, 'browser-evidence': Eye, 'task-focus': Crosshair,
  'hint-adoption': Zap,
  'tickets': Target,
  'task-replay': PlayCircle,
  'event-replay': ScrollText,
  'web-task-stats': Globe,
  'knowledge': BookOpen,
};
const TAB_IDS: TabId[] = ['overview', 'system', 'users', 'config', 'roles', 'audit', 'assign-rules', 'open-platform', 'tool-memory', 'supervisor', 'gateway-quota', 'supervisor-metrics', 'browser-evidence', 'task-focus', 'hint-adoption', 'tickets', 'task-replay', 'event-replay', 'web-task-stats', 'knowledge'];

// ─── Sidebar Navigation Groups ─────────────────────────────
interface NavGroup {
  label: string; // i18n key
  items: TabId[];
}
const NAV_GROUPS: NavGroup[] = [
  { label: 'admin.nav.monitor', items: ['overview', 'system', 'gateway-quota'] },
  { label: 'admin.nav.manage', items: ['users', 'config', 'roles'] },
  { label: 'admin.nav.ops', items: ['audit', 'assign-rules', 'open-platform'] },
  { label: 'admin.nav.ai', items: ['tool-memory', 'supervisor', 'supervisor-metrics', 'browser-evidence', 'task-focus', 'hint-adoption', 'tickets', 'task-replay', 'event-replay', 'web-task-stats', 'knowledge'] },
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
            {activeTab === 'tool-memory' && <ToolMemoryTab />}
            {activeTab === 'supervisor' && <SupervisorTab />}
            {activeTab === 'gateway-quota' && <GatewayQuotaTab />}
            {activeTab === 'supervisor-metrics' && <SupervisorMetricsTab />}
            {activeTab === 'browser-evidence' && <BrowserEvidenceTab />}
            {activeTab === 'task-focus' && <TaskFocusTab />}
            {activeTab === 'hint-adoption' && <HintAdoptionTab />}
            {activeTab === 'tickets' && <TicketsTab />}
            {activeTab === 'task-replay' && <TaskReplayTab />}
            {activeTab === 'event-replay' && <EventReplay />}
            {activeTab === 'web-task-stats' && <WebTaskStatsTab />}
            {activeTab === 'knowledge' && <KnowledgeTab />}
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

  // Ticket & KOL stats
  const [ticketStats, setTicketStats] = useState<{ total: number; open: number; in_progress: number; resolved: number; closed: number; by_category: { category: string; count: number }[]; by_priority: { priority: string; count: number }[] } | null>(null);
  const [kolStats, setKolStats] = useState<{ total: number; by_platform: { platform: string; count: number }[]; by_status: { status: string; count: number }[]; total_cooperations: number; active_cooperations: number } | null>(null);
  const [ticketTrend, setTicketTrend] = useState<{ date: string; created: number; resolved: number }[]>([]);
  const [trendDays, setTrendDays] = useState(14);
  const [aiKpi, setAiKpi] = useState<any>(null);
  const [qualitySummary, setQualitySummary] = useState<any>(null);
  // [R21-T3] AI Intelligence KPI + [R22-T4] Quality Summary with 30s auto-refresh
  useEffect(() => {
    const loadAiKpi = () => {
      fetchAdmin('/api/admin/dashboard-overview')
        .then(d => setAiKpi(d?.data || null))
        .catch(() => {});
      fetchAdmin('/api/admin/task-quality-summary?hours=168')
        .then(d => setQualitySummary(d))
        .catch(() => {});
    };
    loadAiKpi();
    const interval = setInterval(loadAiKpi, 30000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    fetch('/api/tickets/stats').then(r => { if (!r.ok) throw new Error(r.status.toString()); return r.json(); }).then(setTicketStats).catch(() => {});
    fetch('/api/kols/stats').then(r => { if (!r.ok) throw new Error(r.status.toString()); return r.json(); }).then(setKolStats).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/tickets/trend?days=${trendDays}`).then(r => { if (!r.ok) throw new Error(r.status.toString()); return r.json(); }).then(d => setTicketTrend(d.trend || [])).catch(() => {});
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
              {ticketStats.by_priority?.length > 0 && (
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
              {kolStats.by_platform?.length > 0 && (
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

      {/* ─── AI Intelligence KPI Panel [R21-T3] ─── */}
      <div className="bg-zinc-900/80 border border-zinc-800/80 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
            <ShieldAlert size={16} className="text-red-400" />
            AI Intelligence KPI
          </h3>
          {aiKpi && <span className="text-[10px] text-zinc-500">Auto-refresh 30s · {new Date(aiKpi.timestamp).toLocaleTimeString()}</span>}
        </div>
        {aiKpi ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-red-400">{aiKpi.supervisor?.totalDecisions ?? 0}</div>
              <div className="text-[10px] text-zinc-500">Supervisor</div>
              <div className="text-[9px] text-zinc-600">{aiKpi.supervisor?.interventionRate ?? 0}% intervene</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-emerald-400">{aiKpi.hints?.realAdoptionRate ?? 0}%</div>
              <div className="text-[10px] text-zinc-500">Hint Adoption</div>
              <div className="text-[9px] text-zinc-600">{aiKpi.hints?.realAdopted ?? 0}/{aiKpi.hints?.realTotal ?? 0} real</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-blue-400">{aiKpi.evidence?.total ?? 0}</div>
              <div className="text-[10px] text-zinc-500">Evidence</div>
              <div className="text-[9px] text-zinc-600">{aiKpi.evidence?.screenshots ?? 0} img / {aiKpi.evidence?.textExtracts ?? 0} txt</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-purple-400">{aiKpi.focus?.total ?? 0}</div>
              <div className="text-[10px] text-zinc-500">Task Focus</div>
              <div className="text-[9px] text-zinc-600">{aiKpi.focus?.active ?? 0} active / {aiKpi.focus?.completed ?? 0} done</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-orange-400">{aiKpi.tickets?.total ?? 0}</div>
              <div className="text-[10px] text-zinc-500">Risk Tickets</div>
              <div className="text-[9px] text-zinc-600">{aiKpi.tickets?.open ?? 0} open / {aiKpi.tickets?.resolved ?? 0} resolved</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-cyan-400">{aiKpi.activity?.timelineEvents24h ?? 0}</div>
              <div className="text-[10px] text-zinc-500">24h Activity</div>
              <div className="text-[9px] text-zinc-600">{aiKpi.activity?.auditActions24h ?? 0} audit actions</div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">Loading AI KPI...</div>
        )}
      </div>

      {/* ─── Task Quality Summary Panel [R22-T4] ─── */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert size={16} className="text-violet-400" />
          <h3 className="text-sm font-semibold">Task Quality (7d)</h3>
          {qualitySummary && <span className="text-[10px] text-zinc-500">Auto-refresh 30s</span>}
        </div>
        {qualitySummary ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-blue-400">{qualitySummary.totalTasks}</div>
              <div className="text-[10px] text-zinc-500">Total Tasks</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-emerald-400">{qualitySummary.successCount}</div>
              <div className="text-[10px] text-zinc-500">Success</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-amber-400">{qualitySummary.degradedSuccessCount}</div>
              <div className="text-[10px] text-zinc-500">Degraded</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-red-400">{qualitySummary.failedCount}</div>
              <div className="text-[10px] text-zinc-500">Failed</div>
            </div>
            <div className="text-center p-3 bg-zinc-800/50 rounded-lg">
              <div className="text-lg font-bold text-cyan-400">{qualitySummary.interventionRate}%</div>
              <div className="text-[10px] text-zinc-500">Intervention</div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-600 py-4 text-center">Loading Quality Summary...</div>
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
