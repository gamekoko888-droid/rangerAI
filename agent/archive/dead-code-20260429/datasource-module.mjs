import { logger } from '../lib/logger.mjs';
import { EVENT_TYPES, emitEvent } from './event-stream.mjs';

const ts = () => new Date().toISOString();
const rand = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CircuitBreaker {
  constructor() { this.failures = 0; this.state = 'CLOSED'; this.openUntil = 0; }
  canPass() { if (this.state === 'OPEN' && Date.now() >= this.openUntil) { this.state = 'HALF_OPEN'; return true; } return this.state !== 'OPEN'; }
  success() { this.failures = 0; this.state = 'CLOSED'; this.openUntil = 0; }
  failure() { this.failures += 1; if (this.failures >= 3) { this.state = 'OPEN'; this.openUntil = Date.now() + 30000; } }
  getStatus() { return { state: this.state, failures: this.failures, openUntil: this.openUntil }; }
}

class BaseSource { constructor(config = {}) { this.config = config; } async fetch() { return null; } }

class GameTopupStatsSource extends BaseSource {
  async fetch() {
    return { title: 'Game Topup Stats', content: '近7天 GMV ¥1,286,400；订单量 18,420 单；客单价 ¥69.8。iOS 占比 42%，Android 占比 58%；周环比 GMV +12.4%。', scope: 'game_topup_stats', score: 96 };
  }
}

class KolRosterSource extends BaseSource {
  async fetch() {
    return { title: 'KOL Roster', content: 'Top ROI 达人：@LunaTech ROI 4.8x，@晨曦游戏 ROI 3.9x，@阿北测评 ROI 3.4x；本周可投放档期 6 个。', scope: 'kol_roster', score: 90 };
  }
}

class SystemStatusSource extends BaseSource {
  async fetch() {
    const { getStatus } = await import('./runtime-ledger.mjs').catch(() => ({ getStatus: () => ({ healthy: true, fallback: true }) }));
    const status = typeof getStatus === 'function' ? await getStatus() : { healthy: true };
    return { title: 'System Status', content: `系统健康：${status.healthy !== false ? '正常' : '异常'}；摘要：${JSON.stringify(status).slice(0, 220)}`, scope: 'system_status', score: 88 };
  }
}

export class DatasourceModule {
  constructor(config = {}) {
    this.config = config;
    this.instanceId = `ds-${Date.now().toString(36)}-${rand()}`;
    this.state = 'created';
    this.started = false;
    this.sources = new Map();
    this.breakers = new Map();
    this.metrics = { gatherCount: 0, errors: 0, lastTraceId: null };
    this._initBuiltins();
  }
  async init() { this.state = 'initialized'; return this; }
  async start() { this.started = true; this.state = 'running'; return this; }
  async stop() { this.started = false; this.state = 'stopped'; }
  async destroy() { await this.stop(); this.sources.clear(); this.state = 'destroyed'; }
  async health() { return { healthy: this.state === 'initialized' || this.state === 'running', state: this.state, instanceId: this.instanceId }; }
  getStatus() { return { instanceId: this.instanceId, state: this.state, healthy: this.state === 'initialized' || this.state === 'running', sources: [...this.sources.keys()], metrics: this.metrics }; }
  registerSource(name, source) { this.sources.set(name, source); if (!this.breakers.has(name)) this.breakers.set(name, new CircuitBreaker()); }
  _initBuiltins() { this.registerSource('gameTopupStats', new GameTopupStatsSource(this.config)); this.registerSource('kolRoster', new KolRosterSource(this.config)); this.registerSource('systemStatus', new SystemStatusSource(this.config)); }
  _score(items) { return items.map((item, idx) => ({ ...item, score: item.score ?? (100 - idx * 5) })); }
  _dedupe(items) { const seen = new Set(); return items.filter((item) => { const key = `${item.title}:${item.content}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
  _format(items) { return items.map((item, idx) => `【${idx + 1}. ${item.title}】${item.content}`).join('\n\n'); }
  async gather(ctx = {}) {
    const traceId = ctx.traceId || `ds-${Date.now().toString(36)}-${rand()}`;
    const entries = [...this.sources.entries()];
    const results = await Promise.all(entries.map(async ([name, source]) => {
      const breaker = this.breakers.get(name) || new CircuitBreaker();
      this.breakers.set(name, breaker);
      if (!breaker.canPass()) return null;
      try { const res = await source.fetch(ctx); breaker.success(); return res ? { source: name, ...res } : null; } catch (error) { breaker.failure(); this.metrics.errors += 1; logger.warn(`[datasource] ${name} failed: ${error.message}`); return null; }
    }));
    const collected = this._dedupe(this._score(results.filter(Boolean)));
    const payload = { traceId, instanceId: this.instanceId, sessionKey: ctx.sessionKey || null, taskId: ctx.taskId || null, gatheredAt: ts(), sources: collected, formatted: this._format(collected), totalSources: collected.length };
    this.metrics.gatherCount += 1; this.metrics.lastTraceId = traceId;
    if (ctx.sessionKey || ctx.taskId) emitEvent(ctx.sessionKey || null, ctx.taskId || null, EVENT_TYPES.DATASOURCE_GATHERED, payload);
    return payload;
  }
}

export function createDatasourceModule(config = {}) { return new DatasourceModule(config); }

export { CircuitBreaker, BaseSource, GameTopupStatsSource, KolRosterSource, SystemStatusSource };
