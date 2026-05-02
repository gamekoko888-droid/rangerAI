export function buildTaskTimeline(events = []) {
  return events.map((e, i) => ({ id: e.id || `evt-${i}`, type: e.type || 'event', ts: e.timestamp || Date.now(), title: e.title || e.type || 'event' }));
}

export function computePhaseDurations(items = []){ const out={}; for(const it of items){ if(!out[it.type]) out[it.type]={count:0}; out[it.type].count++; } return out; }
