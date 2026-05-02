const allowed = { queued:['running'], running:['review','done','failed'], review:['done','running'], done:[], failed:['running'] };
const states = new Map();
export function setTaskState(taskId, state){ const cur=states.get(taskId)||'queued'; if(cur!==state && !(allowed[cur]||[]).includes(state)) throw new Error(`invalid transition ${cur}->${state}`); states.set(taskId,state); return state; }
export function getTaskState(taskId){ return states.get(taskId)||'queued'; }
