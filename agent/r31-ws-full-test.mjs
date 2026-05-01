import WebSocket from 'ws';
import crypto from 'crypto';

const TOKEN = 'rng3r_admin_ec6d6a69d155bc7865f2f9383eb98b0c';
const WS_URL = 'ws://127.0.0.1:3005';

const TASKS = [
  "帮我分析一下游戏充值市场的竞争格局",
  "查询最近的KOL合作数据",
  "帮我写一份TikTok运营周报",
];

let eventCount = 0;
let plannerEvents = [];

const ws = new WebSocket(WS_URL, {
  headers: { 'Authorization': `Bearer ${TOKEN}` }
});

ws.on('open', () => {
  console.log('[WS] Connected');
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    eventCount++;
    
    // Log important events
    if (msg.type === 'connected') {
      console.log(`[WS] Session: ${msg.sessionKey || 'unknown'}`);
      // Send first test message after connected
      setTimeout(() => {
        console.log('[WS] Sending test message...');
        ws.send(JSON.stringify({
          type: 'message',
          content: TASKS[0]
        }));
      }, 1000);
    } else if (msg.type === 'plan_update' || msg.type === 'plan_step_update') {
      plannerEvents.push(msg.type);
      console.log(`[EVENT] ${msg.type}: ${JSON.stringify(msg).substring(0, 200)}`);
    } else if (msg.type === 'knowledge_injected' || msg.type === 'kv_cache_stats') {
      console.log(`[EVENT] ${msg.type}`);
    } else if (msg.type === 'final_answer') {
      console.log(`[DONE] Final answer received (${eventCount} events total, planner: ${plannerEvents.length})`);
      ws.close();
      process.exit(0);
    } else if (msg.type === 'error') {
      console.log(`[ERROR] ${JSON.stringify(msg)}`);
    } else {
      // Just count, don't log every event
      if (eventCount % 10 === 0) {
        console.log(`[...] ${eventCount} events received (latest: ${msg.type})`);
      }
    }
  } catch (e) {
    console.log(`[RAW] ${data.toString().substring(0, 100)}`);
  }
});

ws.on('error', (err) => {
  console.error(`[WS ERROR] ${err.message}`);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log(`[WS] Closed: ${code} ${reason}`);
  process.exit(0);
});

// Timeout after 90 seconds
setTimeout(() => {
  console.log(`[TIMEOUT] ${eventCount} events, planner: ${plannerEvents.length}`);
  ws.close();
  process.exit(0);
}, 90000);
