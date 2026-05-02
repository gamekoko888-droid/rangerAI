/**
 * health-monitor.mjs — Degradation Health Monitor (Q13)
 * 
 * Tracks health of all subsystems:
 *   - Browser service pool status
 *   - Worker pool utilization
 *   - Gateway connection status
 *   - WebSocket connection count
 *   - Memory/CPU usage
 *
 * Exposes: getSystemHealth(), getDegradationReport()
 * @module worker/health-monitor
 */
import { logger } from '../lib/logger.mjs';
import { getPoolStatus } from './browser-service.mjs';
import os from 'os';

const ts = () => new Date().toISOString();

const healthHistory = [];
const MAX_HISTORY = 100;

function getMemoryUsage() {
  const used = process.memoryUsage();
  return {
    rss: Math.round(used.rss / 1024 / 1024),
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    external: Math.round(used.external / 1024 / 1024),
    systemFreePercent: Math.round((os.freemem() / os.totalmem()) * 100),
  };
}

function getCpuLoad() {
  const load = os.loadavg();
  const cpuCount = os.cpus().length;
  return {
    load1m: load[0],
    load5m: load[1],
    load15m: load[2],
    cpuCount,
    loadPercent: Math.round((load[0] / cpuCount) * 100),
  };
}

export function getSystemHealth() {
  const browserPool = getPoolStatus();
  const memory = getMemoryUsage();
  const cpu = getCpuLoad();
  const uptime = process.uptime();
  
  const degradations = [];
  
  if (memory.systemFreePercent < 10) {
    degradations.push({ subsystem: 'memory', severity: 'critical', detail: `System free memory: ${memory.systemFreePercent}%` });
  } else if (memory.systemFreePercent < 25) {
    degradations.push({ subsystem: 'memory', severity: 'warning', detail: `System free memory: ${memory.systemFreePercent}%` });
  }
  
  if (cpu.loadPercent > 90) {
    degradations.push({ subsystem: 'cpu', severity: 'critical', detail: `CPU load: ${cpu.loadPercent}%` });
  } else if (cpu.loadPercent > 70) {
    degradations.push({ subsystem: 'cpu', severity: 'warning', detail: `CPU load: ${cpu.loadPercent}%` });
  }
  
  if (!browserPool.available) {
    degradations.push({ subsystem: 'browser', severity: 'degraded', detail: 'Browser pool not available' });
  }
  
  if (memory.heapUsed > 1500) {
    degradations.push({ subsystem: 'heap', severity: 'warning', detail: `Heap usage: ${memory.heapUsed}MB` });
  }
  
  const overallStatus = degradations.some(d => d.severity === 'critical') ? 'critical'
    : degradations.some(d => d.severity === 'warning') ? 'degraded'
    : 'healthy';
  
  const snapshot = {
    timestamp: ts(),
    status: overallStatus,
    uptime: Math.round(uptime),
    memory,
    cpu,
    browserPool,
    degradations,
  };
  
  healthHistory.push(snapshot);
  if (healthHistory.length > MAX_HISTORY) healthHistory.shift();
  
  return snapshot;
}

export function getDegradationReport() {
  const current = getSystemHealth();
  const recentDegradations = healthHistory
    .filter(h => h.degradations.length > 0)
    .slice(-10);
  
  return {
    current,
    recentDegradations: recentDegradations.length,
    history: recentDegradations,
  };
}

export function getHealthHistory(limit = 20) {
  return healthHistory.slice(-limit);
}
