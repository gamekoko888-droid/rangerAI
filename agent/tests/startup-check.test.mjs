import { describe, it } from "vitest";;
import { expect } from "vitest";;
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const AGENT_DIR = '/opt/rangerai-agent';

describe('Startup Integrity', () => {
  const requiredModules = [
    'server.mjs', 'lib/logger.mjs', 'lib/context.mjs',
    'lib/metrics-collector.mjs', 'modules/http-router.mjs',
    'modules/ws-handler.mjs', 'modules/worker-manager.mjs',
    'modules/event-buffer.mjs', 'auth.mjs'
  ];

  for (const mod of requiredModules) {
    it(`should have required module: ${mod}`, () => {
      expect(existsSync(path.join(AGENT_DIR, mod)), `${mod} should exist`).toBeTruthy();
    });
  }

  it('should have node_modules directory', () => {
    expect(existsSync(path.join(AGENT_DIR, 'node_modules'))).toBeTruthy();
  });

  it('should have mysql2 dependency', () => {
    expect(existsSync(path.join(AGENT_DIR, 'node_modules/mysql2'))).toBeTruthy();
  });

  it('should have ws dependency', () => {
    expect(existsSync(path.join(AGENT_DIR, 'node_modules/ws'))).toBeTruthy();
  });

  it('should pass startup-check.sh script', () => {
    const result = execSync('bash /opt/rangerai-agent/scripts/startup-check.sh 2>&1', { encoding: 'utf-8' });
    expect(result.includes('PASSED'), 'Startup check should pass').toBeTruthy();
  });
});
