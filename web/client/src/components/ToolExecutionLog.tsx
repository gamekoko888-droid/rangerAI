import { useMemo, useState } from 'react';
import { Terminal, Globe, FileText, ChevronDown, ChevronRight } from 'lucide-react';

type ToolEvent = { tool?: string; status?: string; duration_ms?: number; args_summary?: string };

export function ToolExecutionLog({ events = [], running = false }: { events?: ToolEvent[]; running?: boolean }) {
  const [open, setOpen] = useState(running);
  const iconFor = (tool = '') => tool.includes('browser') ? Globe : (tool.includes('file') ? FileText : Terminal);
  const rows = useMemo(() => events.slice(-10), [events]);
  if (!rows.length) return null;
  return (
    <div className="border border-zinc-700 rounded-md bg-zinc-900/70 mb-2">
      <button className="w-full p-2 text-xs flex items-center gap-2" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} Thinking ({rows.length})
      </button>
      {open && <div className="px-2 pb-2 space-y-1">{rows.map((e, i) => {
        const Icon = iconFor(e.tool || 'exec');
        return <div key={i} className="text-xs flex items-center gap-2 text-zinc-300"><Icon size={12}/><span>{e.tool || 'tool'}</span><span>{e.status || (running ? 'running':'done')}</span><span>{e.duration_ms ? `${e.duration_ms}ms` : ''}</span><span className="truncate">{e.args_summary || ''}</span></div>;
      })}</div>}
    </div>
  );
}
