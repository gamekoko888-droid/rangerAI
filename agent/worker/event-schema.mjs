const STATUS_VALUES = ['pending', 'in_progress', 'completed', 'failed'];

export const EVENT_TYPES = Object.freeze({
  USER_MESSAGE: 'user_message',
  PLAN_UPDATE: 'plan_update',
  PLAN_GENERATED: 'plan_generated',
  ACTION: 'action',
  ACTION_STARTED: 'action_started',
  ACTION_COMPLETED: 'action_completed',
  OBSERVATION: 'observation',
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  FINAL_ANSWER: 'final_answer',
  ERROR: 'error',
  TTS_GENERATED: 'tts_generated',
  KNOWLEDGE_GATHERED: 'knowledge_gathered',
  KNOWLEDGE_INJECTED: 'knowledge_injected',
  DATASOURCE_GATHERED: 'datasource_gathered',
  SUPERVISOR_BLOCK: 'supervisor_block',
  MAX_RETRIES_EXCEEDED: 'max_retries_exceeded',
  REPLAN: 'replan',
  RECOVERY_ATTEMPT: 'recovery_attempt',
  AGENT_THINKING: 'agent_thinking',
  HEALTH_CHECK: 'health_check',
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });
const stringArray = (v) => Array.isArray(v) && v.every(isStr);
const sourceArray = (v) => Array.isArray(v) && v.every(x => isObj(x) && isStr(x.source) && isNum(x.relevance));

export const EVENT_SCHEMAS = Object.freeze({
  [EVENT_TYPES.USER_MESSAGE]: { type: 'string' },
  [EVENT_TYPES.PLAN_UPDATE]: { type: 'object', required: ['status'] },
  [EVENT_TYPES.PLAN_GENERATED]: { type: 'object' },
  [EVENT_TYPES.ACTION]: { type: 'object' },
  [EVENT_TYPES.ACTION_STARTED]: { type: 'object' },
  [EVENT_TYPES.ACTION_COMPLETED]: { type: 'object' },
  [EVENT_TYPES.OBSERVATION]: { type: 'object' },
  [EVENT_TYPES.TASK_STARTED]: { type: 'object' },
  [EVENT_TYPES.TASK_COMPLETED]: { type: 'object' },
  [EVENT_TYPES.TASK_FAILED]: { type: 'object' },
  [EVENT_TYPES.FINAL_ANSWER]: { type: 'object' },
  [EVENT_TYPES.ERROR]: { type: 'object' },
  [EVENT_TYPES.TTS_GENERATED]: { type: 'object' },
  [EVENT_TYPES.KNOWLEDGE_GATHERED]: { type: 'object' },
  [EVENT_TYPES.KNOWLEDGE_INJECTED]: { type: 'object' },
  [EVENT_TYPES.DATASOURCE_GATHERED]: { type: 'object' },
  [EVENT_TYPES.SUPERVISOR_BLOCK]: { type: 'object' },
  [EVENT_TYPES.MAX_RETRIES_EXCEEDED]: { type: 'object' },
  [EVENT_TYPES.REPLAN]: { type: 'object' },
  [EVENT_TYPES.RECOVERY_ATTEMPT]: { type: 'object' },
  [EVENT_TYPES.AGENT_THINKING]: { type: 'object' },
  [EVENT_TYPES.HEALTH_CHECK]: { type: 'object' },
});

export function validatePayload(type, payload) {
  switch (type) {
    case EVENT_TYPES.USER_MESSAGE:
      return (isStr(payload) || (isObj(payload) && (isStr(payload.message) || isStr(payload.content)))) ? ok() : fail('USER_MESSAGE must be string or {message, content}');
    case EVENT_TYPES.PLAN_UPDATE:
      if (!isObj(payload)) return fail('PLAN_UPDATE must be object');
      if (!STATUS_VALUES.includes(payload.status)) return fail('PLAN_UPDATE.status invalid');
      if (payload.stepNumber !== undefined && !isNum(payload.stepNumber)) return fail('PLAN_UPDATE.stepNumber must be number');
      if (payload.pseudoCode !== undefined && !isStr(payload.pseudoCode)) return fail('PLAN_UPDATE.pseudoCode must be string');
      if (payload.reflection !== undefined && !isStr(payload.reflection)) return fail('PLAN_UPDATE.reflection must be string');
      return ok();
    case EVENT_TYPES.KNOWLEDGE_GATHERED:
      if (!isObj(payload)) return fail('KNOWLEDGE_GATHERED must be object');
      if (payload.contributingSources !== undefined && !sourceArray(payload.contributingSources)) return fail('KNOWLEDGE_GATHERED.contributingSources invalid');
      return ok();
    case EVENT_TYPES.DATASOURCE_GATHERED:
      return isObj(payload) ? ok() : fail('DATASOURCE_GATHERED must be object');
    default:
      return isObj(payload) || payload === undefined || payload === null || isStr(payload) ? ok() : fail(`${type} payload must be object or string`);
  }
}

export function validateEvent(eventType, payload) {
  return validatePayload(eventType, payload);
}

export default { EVENT_TYPES, EVENT_SCHEMAS, validatePayload, validateEvent };
