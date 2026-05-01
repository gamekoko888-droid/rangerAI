import WebSocket from "ws";
import fs from "fs";

const config = JSON.parse(fs.readFileSync("/home/admin/.openclaw/openclaw.json", "utf8"));
const port = config.gateway?.port || 18789;
const host = "127.0.0.1";
const token = config.gateway?.auth?.token || "";

console.log(`Connecting to ws://${host}:${port}...`);

const ws = new WebSocket(`ws://${host}:${port}`, {
  headers: { Origin: `http://127.0.0.1:${port}` }
});

let reqId = 100;
const pending = new Map();

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = String(reqId++);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); }
    }, 10000);
  });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "event" && msg.event === "connect.challenge") {
    console.log("Challenge received, authenticating...");
    ws.send(JSON.stringify({
      type: "req", id: "connect-1", method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: "openclaw-control-ui", version: "dev", platform: "linux", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["tool-events"], commands: [], permissions: {},
        auth: { token }, locale: "zh-CN", userAgent: "rangerai-agent/2.0"
      }
    }));
    return;
  }
  if (msg.type === "res" && msg.id === "connect-1") {
    if (msg.ok) { console.log("Authenticated!"); doWork(); }
    else { console.error("Auth failed:", JSON.stringify(msg.error)); process.exit(1); }
    return;
  }
  if (msg.type === "res" && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok === false || msg.error) reject(new Error(msg.error?.message || JSON.stringify(msg)));
    else resolve(msg.payload || msg.result || msg);
    return;
  }
});

async function doWork() {
  try {
    console.log("\n=== Listing schedules ===");
    const result = await rpc("schedules.list", {});
    const schedules = result?.schedules || (Array.isArray(result) ? result : []);
    console.log(`Found ${schedules.length} schedules\n`);
    
    for (const s of schedules) {
      const hasTg = s.delivery && s.delivery.channel === "telegram";
      console.log(`  ${s.name || s.id}: delivery=${JSON.stringify(s.delivery || {})} ${hasTg ? "<-- TELEGRAM" : ""}`);
      
      if (hasTg) {
        console.log(`  -> Removing telegram channel from ${s.name}...`);
        try {
          await rpc("schedules.update", { id: s.id, delivery: { mode: "announce", bestEffort: true } });
          console.log(`  OK`);
        } catch (e) {
          console.log(`  FAIL: ${e.message}`);
        }
      }
    }
    console.log("\nDone!");
  } catch (e) {
    console.error("Error:", e.message);
  }
  ws.close();
  process.exit(0);
}

ws.on("error", (e) => console.error("WS Error:", e.message));
setTimeout(() => { console.error("Timeout"); process.exit(1); }, 20000);
