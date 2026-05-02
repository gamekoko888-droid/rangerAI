import { estimateTokenCount } from './context-compressor.mjs';
export function summarizeIfNeeded(messages = [], maxTokens = 128000) {
  const used = estimateTokenCount(messages);
  const ratio = used / maxTokens;
  if (ratio < 0.8) return { summarized: false, messages, ratio };
  const keep = messages.slice(-20);
  const summary = messages.slice(0, -20).map(m => `${m.role||'user'}: ${(m.content||'').slice(0,80)}`).join('\n');
  return { summarized: true, ratio, messages: [{ role: 'system', content: `[SUMMARY]\n${summary.slice(0,6000)}\n[/SUMMARY]` }, ...keep] };
}
