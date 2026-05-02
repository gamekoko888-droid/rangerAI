const snapshots = new Map();
export function saveToolSnapshot(taskId, toolCalls = []){ snapshots.set(taskId, { ts: Date.now(), toolCalls }); }
export function loadToolSnapshot(taskId){ return snapshots.get(taskId) || null; }

export function mergeSnapshotWithTimeline(snapshot, timeline = []){ if(!snapshot) return timeline; return [...timeline, ...((snapshot.toolCalls||[]).map((t,i)=>({ id:`tool-${i}`, type:"tool", title:t.tool||"tool", ts:snapshot.ts })))]; }
