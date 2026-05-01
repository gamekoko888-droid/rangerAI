import { logger } from '../lib/logger.mjs';
import { createKnowledgeModule, formatBundleForInjection } from './knowledge-module.mjs';

let modulePromise = null;
let moduleInstance = null;

async function getOrCreateModule() {
  if (moduleInstance) return moduleInstance;
  if (!modulePromise) modulePromise = createKnowledgeModule({});
  moduleInstance = await modulePromise;
  return moduleInstance;
}

export async function getKnowledgeModule() { return getOrCreateModule(); }

export async function gatherKnowledge(params) {
  const km = await getOrCreateModule();
  const bundle = await km.gather(params);
  return {
    ragContext: bundle.segments.find(s => s.scope === 'rag')?.content || null,
    userMemory: bundle.segments.find(s => s.scope === 'user_memory')?.content || null,
    conversationRecall: bundle.segments.find(s => s.scope === 'conversation')?.content || null,
    workspaceContext: bundle.segments.find(s => s.scope === 'workspace')?.content || null,
    eventHistory: bundle.segments.find(s => s.scope === 'event_history')?.content || null,
    fileMemory: bundle.segments.find(s => s.scope === 'file_memory')?.content || null,
    totalChars: bundle.totalChars,
    activeSources: bundle.activeSources,
    traceId: bundle.traceId,
    segments: bundle.segments,
  };
}

export { formatBundleForInjection };

export function getAvailableSources() { return ['rag', 'memory', 'conversation', 'workspace', 'eventHistory', 'fileMemory']; }

export function storeFileMemory(taskId, toolName, content, metadata = {}) { return { stored: false, ref: content, metadata }; }
