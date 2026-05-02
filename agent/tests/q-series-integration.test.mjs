// tests/q-series-integration.test.mjs — Integration tests for Q-series modules
// Q14: Validates that all new modules load correctly and export expected interfaces
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Q-Series Module Integration Tests', () => {
  
  describe('Q1 — workspace-manager.mjs', () => {
    let mod;
    before(async () => { mod = await import('../worker/workspace-manager.mjs'); });
    
    it('exports getWorkspacePath', () => {
      assert.equal(typeof mod.getWorkspacePath, 'function');
    });
    it('returns a path for a session key', () => {
      const p = mod.getWorkspacePath('test-session-123');
      assert.ok(p, 'Should return a non-empty path');
      assert.ok(p.includes('test-session-123'), 'Path should include session key');
    });
  });

  describe('Q2 — workspace-mount.mjs', () => {
    let mod;
    before(async () => { mod = await import('../modules/workspace-mount.mjs'); });
    
    it('exports getWorkspaceMountArgs', () => {
      assert.equal(typeof mod.getWorkspaceMountArgs, 'function');
    });
    it('exports injectWorkspaceMount', () => {
      assert.equal(typeof mod.injectWorkspaceMount, 'function');
    });
    it('returns empty array for null session', () => {
      const args = mod.getWorkspaceMountArgs(null);
      assert.deepEqual(args, []);
    });
  });

  describe('Q3 — file-tools.mjs', () => {
    let mod;
    before(async () => { mod = await import('../worker/file-tools.mjs'); });
    
    it('exports fileRead', () => { assert.equal(typeof mod.fileRead, 'function'); });
    it('exports fileWrite', () => { assert.equal(typeof mod.fileWrite, 'function'); });
    it('exports fileList', () => { assert.equal(typeof mod.fileList, 'function'); });
    it('exports fileGrep', () => { assert.equal(typeof mod.fileGrep, 'function'); });
    it('exports fileDelete', () => { assert.equal(typeof mod.fileDelete, 'function'); });
  });

  describe('Q5 — browser-service.mjs', () => {
    let mod;
    before(async () => { mod = await import('../worker/browser-service.mjs'); });
    
    it('exports browserNavigate', () => { assert.equal(typeof mod.browserNavigate, 'function'); });
    it('exports browserScreenshot', () => { assert.equal(typeof mod.browserScreenshot, 'function'); });
    it('exports browserClick', () => { assert.equal(typeof mod.browserClick, 'function'); });
    it('exports getPoolStatus', () => { assert.equal(typeof mod.getPoolStatus, 'function'); });
    it('exports shutdownAll', () => { assert.equal(typeof mod.shutdownAll, 'function'); });
  });

  describe('Q6 — browser-api.mjs', () => {
    let mod;
    before(async () => { mod = await import('../modules/browser-api.mjs'); });
    
    it('exports registerBrowserRoutes', () => {
      assert.equal(typeof mod.registerBrowserRoutes, 'function');
    });
  });

  describe('Q7 — browser-tool-registry.mjs', () => {
    let mod;
    before(async () => { mod = await import('../modules/browser-tool-registry.mjs'); });
    
    it('exports isBrowserTool', () => { assert.equal(typeof mod.isBrowserTool, 'function'); });
    it('exports executeBrowserTool', () => { assert.equal(typeof mod.executeBrowserTool, 'function'); });
    it('exports isFileTool', () => { assert.equal(typeof mod.isFileTool, 'function'); });
    it('exports executeFileTool', () => { assert.equal(typeof mod.executeFileTool, 'function'); });
    it('identifies browser_navigate as browser tool', () => {
      assert.equal(mod.isBrowserTool('browser_navigate'), true);
    });
    it('identifies file_read as file tool', () => {
      assert.equal(mod.isFileTool('file_read'), true);
    });
    it('rejects unknown tool', () => {
      assert.equal(mod.isBrowserTool('unknown_tool'), false);
    });
  });

  describe('Q8+Q9 — sub-agent-orchestrator.mjs', () => {
    let mod;
    before(async () => { mod = await import('../worker/sub-agent-orchestrator.mjs'); });
    
    it('exports orchestrateWave', () => { assert.equal(typeof mod.orchestrateWave, 'function'); });
    it('exports shouldParallelize', () => { assert.equal(typeof mod.shouldParallelize, 'function'); });
    it('exports getOrchestratorStats', () => { assert.equal(typeof mod.getOrchestratorStats, 'function'); });
  });

  describe('Q10 — parallel-planner-bridge.mjs', () => {
    let mod;
    before(async () => { mod = await import('../modules/parallel-planner-bridge.mjs'); });
    
    it('exports analyzeParallelOpportunities', () => {
      assert.equal(typeof mod.analyzeParallelOpportunities, 'function');
    });
    it('exports shouldUseParallelExecution', () => {
      assert.equal(typeof mod.shouldUseParallelExecution, 'function');
    });
    it('exports executeParallelBatch', () => {
      assert.equal(typeof mod.executeParallelBatch, 'function');
    });
  });

  describe('Q11 — tool-execution-stream.mjs', () => {
    let mod;
    before(async () => { mod = await import('../modules/tool-execution-stream.mjs'); });
    
    it('exports createToolStreamEmitter', () => {
      assert.equal(typeof mod.createToolStreamEmitter, 'function');
    });
    it('exports TOOL_STREAM_EVENTS', () => {
      assert.ok(mod.TOOL_STREAM_EVENTS);
      assert.equal(mod.TOOL_STREAM_EVENTS.TOOL_START, 'tool:start');
    });
    it('creates no-op emitter when emit is null', () => {
      const emitter = mod.createToolStreamEmitter(null, 'test');
      assert.equal(typeof emitter.toolStart, 'function');
      emitter.toolStart({}); // Should not throw
    });
  });

  describe('Q13 — health-monitor.mjs', () => {
    let mod;
    before(async () => { mod = await import('../worker/health-monitor.mjs'); });
    
    it('exports getSystemHealth', () => { assert.equal(typeof mod.getSystemHealth, 'function'); });
    it('exports getDegradationReport', () => { assert.equal(typeof mod.getDegradationReport, 'function'); });
    it('returns health object', () => {
      const health = mod.getSystemHealth();
      assert.ok(health, 'Should return a health object');
      assert.ok('memory' in health || 'status' in health, 'Should have memory or status field');
    });
  });

  describe('R111 — ws-heartbeat.mjs', () => {
    let mod;
    before(async () => { mod = await import('../worker/ws-heartbeat.mjs'); });
    
    it('exports startHeartbeat or attachHeartbeat', () => {
      const hasStart = typeof mod.startHeartbeat === 'function';
      const hasAttach = typeof mod.attachHeartbeat === 'function';
      assert.ok(hasStart || hasAttach, 'Should export startHeartbeat or attachHeartbeat');
    });
  });
});
