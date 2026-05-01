/**
 * server-ops/run.mjs — Skill execution entry point
 * 
 * Server operations: health check, service status, resource monitoring.
 */

import { execSync } from 'child_process';

/**
 * @param {Object} input
 * @param {string} input.action - Action: health|services|resources|logs
 * @param {string} [input.service] - Service name for logs action
 * @param {number} [input.lines] - Number of log lines (default 50)
 * @returns {Object} { success, data }
 */
export async function run(input) {
  const { action = 'health', service, lines = 50 } = input;
  
  try {
    switch (action) {
      case 'health': {
        const uptime = execSync('uptime', { encoding: 'utf-8' }).trim();
        const disk = execSync('df -h / | tail -1', { encoding: 'utf-8' }).trim();
        const memory = execSync('free -h | head -2', { encoding: 'utf-8' }).trim();
        const load = execSync('cat /proc/loadavg', { encoding: 'utf-8' }).trim();
        
        return {
          success: true,
          data: { uptime, disk, memory, load },
        };
      }
      
      case 'services': {
        const services = ['rangerai-web', 'rangerai-ws', 'rangerai-agent'];
        const statuses = {};
        
        for (const svc of services) {
          try {
            const status = execSync(`systemctl is-active ${svc}`, { encoding: 'utf-8' }).trim();
            statuses[svc] = status;
          } catch {
            statuses[svc] = 'inactive';
          }
        }
        
        // Check ports
        const ports = {};
        for (const port of [3000, 3002, 3005, 18789]) {
          try {
            execSync(`ss -tlnp | grep :${port}`, { encoding: 'utf-8' });
            ports[port] = 'LISTENING';
          } catch {
            ports[port] = 'NOT LISTENING';
          }
        }
        
        return { success: true, data: { services: statuses, ports } };
      }
      
      case 'resources': {
        const cpu = execSync('top -bn1 | head -5', { encoding: 'utf-8' }).trim();
        const memory = execSync('free -m', { encoding: 'utf-8' }).trim();
        const disk = execSync('df -h', { encoding: 'utf-8' }).trim();
        const processes = execSync('ps aux --sort=-%mem | head -10', { encoding: 'utf-8' }).trim();
        
        return { success: true, data: { cpu, memory, disk, topProcesses: processes } };
      }
      
      case 'logs': {
        if (!service) {
          return { success: false, error: 'Service name required for logs action' };
        }
        const logs = execSync(`journalctl -u ${service} --no-pager -n ${lines}`, {
          encoding: 'utf-8',
          timeout: 10000,
        }).trim();
        
        return { success: true, data: { service, lines: logs } };
      }
      
      default:
        return { success: false, error: `Unknown action: ${action}. Use: health|services|resources|logs` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}
