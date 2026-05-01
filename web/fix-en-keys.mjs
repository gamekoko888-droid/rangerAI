import fs from 'fs';
const file = 'client/src/lib/i18n.tsx';
let content = fs.readFileSync(file, 'utf8');

const enKeys = {
  'store.err.systemBusy': 'System is temporarily busy, recovering...',
  'store.err.waitingSeconds': '⚠️ Waited {seconds} seconds, still processing...',
  'store.err.taskTimeout': 'Task timed out, please resend your message',
  'store.err.taskFailed': 'Task processing failed, please retry',
  'store.err.sendFailed': 'Failed to send message, please retry',
  'store.err.retrying409': 'Chat is busy, auto-retrying in 3 seconds...',
  'store.err.chatBusy': 'Chat is busy, please wait until it finishes',
  'store.err.tooFrequent': 'Too many requests, please try again later',
  'store.err.loginExpired': 'Session expired, please log in again',
  'store.err.chatNotFound': 'Chat not found, please refresh the page',
  'store.err.serverError': 'Server error, please try again later',
  'store.err.requestTimeout': 'Request timed out, please check your network',
  'store.err.networkFailed': 'Network connection failed, please check your network',
  'store.err.regenerateFailed': 'Regeneration failed, please retry',
  'store.err.serverErrorShort': 'Server error',
  'home.title': 'RangerAI',
  'home.subtitle': 'Intelligent Chat Assistant',
  'home.startChat': 'Start Chat',
  'export.mdTitle': 'Chat History',
  'export.model': 'Model',
  'export.taskType': 'Task Type',
  'export.thinking': 'Thinking',
  'export.toolCalls': 'Tool Calls',
  'export.toolName': 'Tool',
  'export.args': 'Arguments',
  'export.result': 'Result',
  'export.status': 'Status',
  'export.steps': 'Execution Steps',
  'export.stepName': 'Step',
  'export.detail': 'Detail',
};

const marker = "'ticket.detail.autoAssign': 'Auto-assigned',";
const idx = content.indexOf(marker);
if (idx === -1) {
  console.error('Marker not found!');
  process.exit(1);
}
const insertAt = idx + marker.length;
const lines = Object.entries(enKeys).map(([k, v]) => `\n  '${k}': '${v}',`).join('');
content = content.slice(0, insertAt) + lines + content.slice(insertAt);
console.log(`Added ${Object.keys(enKeys).length} keys to en`);

fs.writeFileSync(file, content);
console.log('Done!');
