import { logger } from '../lib/logger.mjs';
import { emitKnowledgeEvent, EVENT_TYPES } from './event-stream.mjs';

const ts = () => new Date().toISOString();
const rand = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const MODULE_INSTANCE_ID = `km-${Date.now().toString(36)}-${rand()}`;

class CircuitBreaker {
  constructor() { this.failures = 0; this.state = 'CLOSED'; this.openUntil = 0; }
  canPass() {
    if (this.state === 'OPEN' && Date.now() >= this.openUntil) { this.state = 'HALF_OPEN'; return true; }
    return this.state !== 'OPEN';
  }
  success() { this.failures = 0; this.state = 'CLOSED'; this.openUntil = 0; }
  failure() { this.failures += 1; if (this.failures >= 3) { this.state = 'OPEN'; this.openUntil = Date.now() + 30000; } }
}

const DEFAULT_BUDGET = 12000;

export class KnowledgeModule {
  constructor(config = {}) {
    this.config = config;
    this.instanceId = MODULE_INSTANCE_ID;
    this.sources = new Map();
    this.breakers = new Map();
    this.metrics = { latencyPerSource: {}, hits: 0, misses: 0, charsInjected: 0, budgetUtilization: 0, errors: 0 };
    this.state = 'created';
    this.pendingEvents = [];
    this.started = false;
    this._initBuiltins();
    for (const [name, source] of Object.entries(this.config.sources || {})) this.registerSource(name, source);
  }
  async init() { this.state = 'initialized'; return this; }
  async start() { this.started = true; this.state = 'running'; return this; }
  async stop() { await this.flushPendingEvents(); this.started = false; this.state = 'stopped'; }
  async destroy() { await this.stop(); this.sources.clear(); this.state = 'destroyed'; }
  isHealthy() { return this.state === 'initialized' || this.state === 'running'; }
  getStatus() { return { instanceId: this.instanceId, state: this.state, healthy: this.isHealthy(), sources: this.listSources(), metrics: this.metrics }; }
  registerSource(name, source) { if (!name || !source) return; this.sources.set(name, source); if (!this.breakers.has(name)) this.breakers.set(name, new CircuitBreaker()); }
  getSource(name) { return this.sources.get(name); }
  listSources() { return [...this.sources.keys()]; }
  async gather(ctx = {}) { const traceId = ctx.traceId || `kn-${Date.now().toString(36)}-${rand()}`; const started = Date.now(); const collected = await this._collect(ctx); const scored = this._score(collected); const deduped = this._dedupe(scored); const budgetTotal = ctx.budgetTotal || DEFAULT_BUDGET; const allocated = this._allocateBudget(deduped, budgetTotal); const formatted = this._format(allocated, budgetTotal); const latencyMs = Date.now() - started; const bundle = { traceId, segments: allocated.map(s => ({ source: s.source, title: s.title, content: s.content, score: s.score, chars: s.chars, scope: s.scope })), totalChars: allocated.reduce((n,s)=>n+s.chars,0), budgetTotal, budgetUsed: allocated.reduce((n,s)=>n+s.chars,0), latencyMs, activeSources: allocated.map(s=>s.source), errors: collected.errors || [], formatted }; this.metrics.latencyPerSource.total = latencyMs; this.metrics.charsInjected += bundle.totalChars; this.metrics.budgetUtilization = budgetTotal ? bundle.budgetUsed / budgetTotal : 0; await this.emitToEventStream(bundle, ctx); return bundle; }
  async emitToEventStream(bundle, ctx={}) {
    const payload = {
      traceId: bundle.traceId, instanceId: this.instanceId,
      scope: 'knowledge_gather', searchTerms: ctx.userMessage || null,
      segments: bundle.segments, reason: 'knowledge_gather',
      totalChars: bundle.totalChars, budgetTotal: bundle.budgetTotal,
      budgetUsed: bundle.budgetUsed, latencyMs: bundle.latencyMs,
      activeSources: bundle.activeSources, errors: bundle.errors || [],
      ts: new Date().toISOString(),
      userMessage: ctx.userMessage || null,
    };
    // Legacy callback path (preserves backward compatibility)
    const es = this.config.eventStream?.emitKnowledgeGathered || this.config.emitKnowledgeGathered;
    if (es) try { await es(ctx, payload); } catch (e) { logger.warn(`[km] emitKnowledgeGathered callback failed: ${e.message}`); }
    // Standard event stream path (Iter-64: idempotent emission via traceId)
    const sessionKey = ctx.sessionKey || this.config.sessionKey || null;
    const taskId = ctx.taskId || ctx.msgId || null;
    if (sessionKey || taskId) {
      try {
        emitKnowledgeEvent(sessionKey, taskId, EVENT_TYPES.KNOWLEDGE_GATHERED, payload);
      } catch (e) {
        logger.warn(`[km] emitKnowledgeEvent failed (non-fatal): ${e.message}`);
      }
    } else {
      // Buffer for later emission (no sessionKey available yet)
      this.pendingEvents.push({ payload, ctx });
    }
  }
  async flushPendingEvents() { while (this.pendingEvents.length) { const { payload, ctx } = this.pendingEvents.shift(); if (this.config.eventStream?.emitKnowledgeGathered) await this.config.eventStream.emitKnowledgeGathered(null, payload).catch?.(()=>{}); const sessionKey = ctx?.sessionKey || this.config.sessionKey || null; const taskId = ctx?.taskId || ctx?.msgId || null; if (sessionKey || taskId) emitKnowledgeEvent(sessionKey, taskId, EVENT_TYPES.KNOWLEDGE_GATHERED, payload); } }
  async _collect(ctx) { const entries = [...this.sources.entries()]; const settled = await Promise.allSettled(entries.map(async ([name, source]) => { const br = this.breakers.get(name) || new CircuitBreaker(); this.breakers.set(name, br); const start = Date.now(); if (!br.canPass()) return { name, error: new Error('breaker_open'), skipped: true }; try { const result = await source.fetch(ctx); br.success(); this.metrics.hits += 1; this.metrics.latencyPerSource[name] = Date.now() - start; return { name, result: result || null, source }; } catch (error) { br.failure(); this.metrics.errors += 1; this.metrics.misses += 1; this.metrics.latencyPerSource[name] = Date.now() - start; return { name, error }; } })); const results = []; const errors = []; for (const s of settled) { if (s.status === 'fulfilled') { if (s.value.error) errors.push({ source: s.value.name, message: s.value.error.message }); if (s.value.result) results.push({ source: s.value.name, ...s.value.result }); } else { errors.push({ source: 'unknown', message: s.reason?.message || String(s.reason) }); } } return { results, errors }; }
  _score(collected) { return collected.results.map((r, i) => { const content = r.content ?? r.result?.content ?? r.result ?? ''; return { ...r, content: typeof content === 'string' ? content : String(content || ''), score: r.score ?? (100 - i * 5) + (r.budget || 0), chars: (typeof content === 'string' ? content : String(content || '')).length }; }); }
  _dedupe(items) { const seen = new Set(); return items.filter(it => { const key = `${it.title || ''}:${(it.content || '').slice(0, 120)}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
  _allocateBudget(items, budgetTotal) { let remaining = budgetTotal; return [...items].sort((a,b)=>(b.score||0)-(a.score||0)).map(it => { if (remaining <= 0) return { ...it, content: '', chars: 0 }; const chars = Math.min(it.chars || (it.content||'').length, Math.max(0, Math.floor(remaining))); remaining -= chars; return { ...it, content: String(it.content || '').slice(0, chars), chars }; }).filter(it => it.chars > 0); }
  _format(bundle) { return formatBundleForInjection({ ragContext: bundle.map(b=>b.content).join('\n\n'), userMemory: null, conversationRecall: null, workspaceContext: null, eventHistory: null, fileMemory: null }); }
  _initBuiltins() { const cfg = this.config.sources || {}; this.registerSource('rag', cfg.rag || new RAGSource(this.config)); this.registerSource('memory', cfg.memory || new MemorySource(this.config)); this.registerSource('conversation', cfg.conversation || new ConversationSource(this.config)); this.registerSource('workspace', cfg.workspace || new WorkspaceSource(this.config)); this.registerSource('eventHistory', cfg.eventHistory || new EventHistorySource(this.config)); this.registerSource('fileMemory', cfg.fileMemory || new FileMemorySource(this.config)); }
}

class BaseSource { constructor(config){ this.config=config; } }
class RAGSource extends BaseSource { constructor(c){ super(c); this.name='rag'; this.budget=3000; this.ttl=60000; } async fetch(ctx){ const { buildKnowledgeInjectedMessage } = await import('./knowledge-injector.mjs'); const content = await buildKnowledgeInjectedMessage(ctx.msgId, ctx.userMessage, ctx.userId); return { title: 'RAG', content: content || '', scope: 'rag', budget: this.budget }; } }
class MemorySource extends BaseSource { constructor(c){ super(c); this.name='memory'; this.budget=2000; this.ttl=60000; } async fetch(ctx){ const { recallUnifiedMemory } = await import('./memory-manager.mjs'); return { title: 'User Memory', content: await recallUnifiedMemory(ctx.userMessage, ctx.sessionKey, { userId: ctx.userId }) || '', scope: 'user_memory', budget: this.budget }; } }
class ConversationSource extends BaseSource { constructor(c){ super(c); this.name='conversation'; this.budget=1800; this.ttl=30000; } async fetch(ctx){ const { recallShortTermContext } = await import('./memory-manager.mjs'); return { title: 'Conversation', content: recallShortTermContext(ctx.userMessage, ctx.conversationHistory || []) || '', scope: 'conversation', budget: this.budget }; } }
class WorkspaceSource extends BaseSource { constructor(c){ super(c); this.name='workspace'; this.budget=1500; this.ttl=30000; } async fetch(ctx){ const { buildWorkspaceBlock } = await import('./task-workspace.mjs'); return { title: 'Workspace', content: buildWorkspaceBlock(ctx.taskId) || '', scope: 'workspace', budget: this.budget }; } }
class EventHistorySource extends BaseSource { constructor(c){ super(c); this.name='eventHistory'; this.budget=1500; this.ttl=30000; } async fetch(ctx){ const { summarizeEvents } = await import('./event-stream.mjs'); return { title: 'Events', content: await summarizeEvents(ctx.sessionKey, 20) || '', scope: 'event_history', budget: this.budget }; } }
class FileMemorySource extends BaseSource { constructor(c){ super(c); this.name='fileMemory'; this.budget=1200; this.ttl=30000; } async fetch(ctx){ const { loadFileMemory } = await import('./task-workspace.mjs'); return { title: 'File Memory', content: await loadFileMemory?.(ctx.taskId) || '', scope: 'file_memory', budget: this.budget }; } }

export function formatBundleForInjection(bundle, maxChars = DEFAULT_BUDGET) {
  const parts = [];
  let remaining = maxChars;
  const sources = [
    { key: 'ragContext', label: 'KNOWLEDGE' },
    { key: 'userMemory', label: 'USER_MEMORY' },
    { key: 'conversationRecall', label: 'RECALL' },
    { key: 'eventHistory', label: 'EVENT_HISTORY' },
    { key: 'workspaceContext', label: null },
    { key: 'fileMemory', label: 'FILE_MEMORY' },
  ];
  for (const { key, label } of sources) {
    const content = bundle?.[key];
    if (!content || remaining <= 0) continue;
    const trimmed = String(content).slice(0, remaining);
    parts.push(label ? `[${label}]\n${trimmed}\n[/${label}]` : trimmed);
    remaining -= trimmed.length;
  }
  return parts.join('\n\n');
}
export async function createKnowledgeModule(config = {}) { const km = new KnowledgeModule(config); await km.init(); await km.start(); return km; }
