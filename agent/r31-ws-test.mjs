import WebSocket from 'ws';
import crypto from 'crypto';

const TOKEN = 'rng3r_admin_ec6d6a69d155bc7865f2f9383eb98b0c';
const WS_URL = 'ws://127.0.0.1:3005';

const TASKS = [
  "帮我分析一下游戏充值市场的竞争格局",
  "查询最近的KOL合作数据",
  "帮我写一份TikTok运营周报",
];

async function sendTask(ws, content) {
  const msgId = crypto.randomUUID();
  const sessionKey = `r31_test_${Date.now()}`;
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve({ status: 'timeout', msgId });
    }, 60000);

    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'dispatch_task_result' || msg.type === 'dispatch_task_error') {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve({ status: msg.type, msgId, data: msg });
      }
    };
    ws.on('message', handler);

    ws.send(JSON.stringify({
      type: 'dispatch_task',
      payload: {
        msgId,
        sessionKey,
        content,
        history: [],
        model: 'auto'
      }
    }));
    console.log(`[Sent] ${msgId.substring(0,8)}: ${content.substring(0,30)}...`);
  });
}

const ws = new WebSocket(WS_URL, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
});

ws.on('open', async () => {
  console.log('WS connected');
  
  // Send first task only to test
  try {
    const result = await sendTask(ws, TASKS[0]);
    console.log(`[Result] ${result.status}`);
  } catch (err) {
    console.error(`[Error] ${err.message}`);
  }
  
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.error(`WS error: ${err.message}`);
  process.exit(1);
});
