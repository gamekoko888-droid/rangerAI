import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const status = { docker: 'down', browser: 'down', gateway: 'down' };
const listeners = new Set();

async function probe() {
  const prev = { ...status };
  try { await execAsync('docker info', { timeout: 3000 }); status.docker = 'up'; } catch { status.docker = 'down'; }
  try { const r = await fetch('http://127.0.0.1:9222/json/version'); status.browser = r.ok ? 'up' : 'down'; } catch { status.browser = 'down'; }
  try { const r = await fetch('http://127.0.0.1:18789/health'); status.gateway = r.ok ? 'up' : 'down'; } catch { status.gateway = 'down'; }
  for (const k of Object.keys(status)) if (prev[k] !== status[k]) listeners.forEach(fn => fn({ type:'health_change', capability:k, oldStatus:prev[k], newStatus:status[k] }));
}
setInterval(probe, 30000).unref?.(); probe();
export function getHealthStatus(){ return { ...status }; }
export function onHealthChange(fn){ listeners.add(fn); return () => listeners.delete(fn); }
