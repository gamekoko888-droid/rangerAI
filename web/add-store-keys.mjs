import fs from 'fs';
const file = 'client/src/lib/i18n.tsx';
let content = fs.readFileSync(file, 'utf8');

const keys = {
  zhCN: {
    'store.err.systemBusy': '系统暂时繁忙，正在恢复中...',
    'store.err.waitingSeconds': '⚠️ 已等待 {seconds} 秒，仍在处理中...',
    'store.err.taskTimeout': '任务超时，请重新发送消息重试',
    'store.err.taskFailed': '任务处理失败，请重试',
    'store.err.sendFailed': '发送消息失败，请重试',
    'store.err.retrying409': '当前对话正在处理中，3秒后自动重试...',
    'store.err.chatBusy': '当前对话正在处理中，请等待完成后再发送',
    'store.err.tooFrequent': '请求过于频繁，请稍后再试',
    'store.err.loginExpired': '登录已过期，请重新登录',
    'store.err.chatNotFound': '对话不存在，请刷新页面',
    'store.err.serverError': '服务器错误，请稍后重试',
    'store.err.requestTimeout': '请求超时，请检查网络后重试',
    'store.err.networkFailed': '网络连接失败，请检查网络后重试',
    'store.err.regenerateFailed': '重新生成失败，请重试',
    'store.err.serverErrorShort': '服务器错误',
    'home.title': 'RangerAI',
    'home.subtitle': '智能对话助手',
    'home.startChat': '开始对话',
    'export.mdTitle': '对话记录',
    'export.model': '模型',
    'export.taskType': '任务类型',
    'export.thinking': '思考过程',
    'export.toolCalls': '工具调用',
    'export.toolName': '工具',
    'export.args': '参数',
    'export.result': '结果',
    'export.status': '状态',
    'export.steps': '执行步骤',
    'export.stepName': '步骤',
    'export.detail': '详情',
  },
  zhTW: {
    'store.err.systemBusy': '系統暫時繁忙，正在恢復中...',
    'store.err.waitingSeconds': '⚠️ 已等待 {seconds} 秒，仍在處理中...',
    'store.err.taskTimeout': '任務超時，請重新發送訊息重試',
    'store.err.taskFailed': '任務處理失敗，請重試',
    'store.err.sendFailed': '發送訊息失敗，請重試',
    'store.err.retrying409': '當前對話正在處理中，3秒後自動重試...',
    'store.err.chatBusy': '當前對話正在處理中，請等待完成後再發送',
    'store.err.tooFrequent': '請求過於頻繁，請稍後再試',
    'store.err.loginExpired': '登入已過期，請重新登入',
    'store.err.chatNotFound': '對話不存在，請重新整理頁面',
    'store.err.serverError': '伺服器錯誤，請稍後重試',
    'store.err.requestTimeout': '請求超時，請檢查網路後重試',
    'store.err.networkFailed': '網路連線失敗，請檢查網路後重試',
    'store.err.regenerateFailed': '重新生成失敗，請重試',
    'store.err.serverErrorShort': '伺服器錯誤',
    'home.title': 'RangerAI',
    'home.subtitle': '智慧對話助手',
    'home.startChat': '開始對話',
    'export.mdTitle': '對話記錄',
    'export.model': '模型',
    'export.taskType': '任務類型',
    'export.thinking': '思考過程',
    'export.toolCalls': '工具呼叫',
    'export.toolName': '工具',
    'export.args': '參數',
    'export.result': '結果',
    'export.status': '狀態',
    'export.steps': '執行步驟',
    'export.stepName': '步驟',
    'export.detail': '詳情',
  },
  en: {
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
  }
};

// Find markers for each language pack
const markers = {
  zhCN: "'ticket.detail.autoAssign': '自动分配',",
  zhTW: "'ticket.detail.autoAssign': '自動分配',",
  en: "'ticket.detail.autoAssign': 'Auto Assign',"
};

for (const [lang, marker] of Object.entries(markers)) {
  const idx = content.indexOf(marker);
  if (idx === -1) {
    console.error(`Marker not found for ${lang}: ${marker}`);
    continue;
  }
  const insertAt = idx + marker.length;
  const lines = Object.entries(keys[lang]).map(([k, v]) => `\n  '${k}': '${v}',`).join('');
  content = content.slice(0, insertAt) + lines + content.slice(insertAt);
  console.log(`Added ${Object.keys(keys[lang]).length} keys to ${lang}`);
}

fs.writeFileSync(file, content);
console.log('Done!');
