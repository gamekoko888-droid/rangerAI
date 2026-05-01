import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Clock, Wrench, UserRound, GitBranch, AlertTriangle, MessageSquare, PlayCircle } from 'lucide-react';
import { getAuthToken } from '../lib/api';

type ReplayEvent = {
  id: number;
  session_key?: string;
  task_id?: string;
  event_type?: string;
  type?: string;
  payload?: any;
  model?: string | null;
  tool_name?: string | null;
  toolName?: string | null;
  created_at?: string;
  timestamp?: string;
};

const IMPORTANT = new Set(['plan_update', 'code_exec_started', 'tool_call', 'tool_result', 'human_intervention', 'human_blocked', 'ask', 'waiting_user', 'action', 'observation']);

async function fetchReplayEvents(): Promise<ReplayEvent[]> {
  const token = getAuthToken();
  const res = await fetch('/api/system/event-stats?hours=168', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data?.recentEvents || data?.events || [];
}

function safePayload(payload: any) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try { return JSON.parse(payload); } catch { return { text: String(payload) }; }
}

function summarize(payload: any) {
  const p = safePayload(payload);
  const keys = ['input', 'output', 'content', 'message', 'summary', 'query', 'command', 'tool', 'url', 'error', '_preview'];
  const picked = keys.map(k => p?.[k] ? `${k}: ${typeof p[k] === 'string' ? p[k] : JSON.stringify(p[k])}` : '').filter(Boolean).join(' · ');
  const text = picked || JSON.stringify(p);
  return text.length > 280 ? `${text.slice(0, 280)}…` : text;
}

function EventIcon({ type }: { type: string }) {
  if (type.includes('plan')) return <GitBranch size={16} className="text-blue-400" />;
  if (type.includes('tool') || type.includes('code_exec')) return <Wrench size={16} className="text-emerald-400" />;
  if (type.includes('human') || type.includes('ask') || type.includes('waiting')) return <UserRound size={16} className="text-amber-400" />;
  if (type.includes('error') || type.includes('failed')) return <AlertTriangle size={16} className="text-red-400" />;
  return <MessageSquare size={16} className="text-zinc-400" />;
}

export default function EventReplay() {
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [query, setQuery] = useState('');
  const [onlyKey, setOnlyKey] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try { setEvents(await fetchReplayEvents()); }
    catch (e: any) { setError(e.message || '加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events
      .map(e => ({ ...e, event_type: e.event_type || e.type || 'unknown', payload: safePayload(e.payload) }))
      .filter(e => !onlyKey || IMPORTANT.has(String(e.event_type)))
      .filter(e => !q || JSON.stringify(e).toLowerCase().includes(q))
      .sort((a, b) => String(a.created_at || a.timestamp).localeCompare(String(b.created_at || b.timestamp)));
  }, [events, query, onlyKey]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100"><PlayCircle size={20} className="text-blue-400" />任务执行回放 / 审计</h2>
          <p className="mt-1 text-sm text-zinc-500">基于 event_stream 展示 plan_update、tool_call、human_intervention 等关键事件。</p>
        </div>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />刷新</button>
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 sm:flex-row">
        <div className="relative flex-1"><Search size={15} className="absolute left-3 top-2.5 text-zinc-500" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="按 task_id / event_type / payload 搜索" className="w-full rounded-lg border border-zinc-700 bg-zinc-950 py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-500" /></div>
        <label className="flex items-center gap-2 text-sm text-zinc-400"><input type="checkbox" checked={onlyKey} onChange={e => setOnlyKey(e.target.checked)} />仅关键事件</label>
      </div>
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
        {loading ? <div className="p-8 text-center text-zinc-500">加载中…</div> : filtered.length === 0 ? <div className="p-8 text-center text-zinc-500">暂无事件</div> : filtered.map((event, idx) => (
          <div key={event.id || idx} className="relative border-b border-zinc-800/70 p-4 last:border-b-0">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-zinc-950 p-2"><EventIcon type={String(event.event_type)} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-200">{event.event_type}</span>
                  {event.tool_name || event.toolName ? <span className="text-xs text-emerald-400">{event.tool_name || event.toolName}</span> : null}
                  {event.model ? <span className="text-xs text-purple-400">{event.model}</span> : null}
                  <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500"><Clock size={12} />{event.created_at || event.timestamp}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-300">{summarize(event.payload)}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                  {event.task_id && <span>task: {event.task_id}</span>}
                  {event.session_key && <span>session: {String(event.session_key).slice(0, 18)}…</span>}
                  <span>#{event.id}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
