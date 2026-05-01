/**
 * AdminDashboard shared utilities and components.
 * Extracted from AdminDashboard.tsx for maintainability.
 */
import React from 'react';
import { getAuthToken } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────
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

export function parseHealthComponents(components: HealthComponent[]) {
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

export interface ActiveTask {
  chatId: string; chatTitle: string; msgId: number;
  startedAt: string; elapsed: number;
}

export interface SystemConfig {
  key: string; value: string; description: string;
  category: string; updatedAt: string; updatedBy: string | null;
}

export interface AiRole {
  id: string; name: string; description: string;
  systemPrompt: string; icon: string; color: string;
  category: string; isActive: number; sortOrder: number;
  createdBy: string; createdAt: string; updatedAt: string;
}

export interface AuditLog {
  id: number; userId: string; username: string;
  action: string; target: string; targetId: string;
  detail: string; ip: string; createdAt: string;
}

export interface AcpApiKey {
  id: string; name: string; key_prefix: string; status: string;
  call_count: number; last_used: string | null;
  created_by: string; created_at: string; revoked_at: string | null;
  source?: string;
}


export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatUptime(seconds: number): { d: number; h: number; m: number } {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return { d, h, m };
}

export function formatUptimeStr(seconds: number, t: (k: string) => string): string {
  const { d, h, m } = formatUptime(seconds);
  if (d > 0) return `${d}${t('admin.time.days')} ${h}${t('admin.time.hours')}`;
  if (h > 0) return `${h}${t('admin.time.hours')} ${m}${t('admin.time.minutes')}`;
  return `${m}${t('admin.time.minutes')}`;
}

// ─── Sub-components ─────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
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

export function MetricCard({ icon: Icon, label, value, sub, color = 'text-blue-400' }: {
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

export function ProgressBar({ value, max, color = 'bg-blue-500' }: { value: number; max: number; color?: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────
type TabId = 'overview' | 'users' | 'system' | 'config' | 'roles' | 'audit' | 'assign-rules' | 'open-platform' | 'services';

export async function fetchAdmin(url: string, options?: RequestInit) {
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers }, credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}


// Re-export types
export type { HealthComponent };
export type { HealthDetail };
export type { UserInfo };
export type { TabId };
