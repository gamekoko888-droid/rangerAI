import WebSocket from "ws";
import fs from "fs";

const config = JSON.parse(fs.readFileSync("/home/admin/.openclaw/openclaw.json", "utf8"));
const port = config.port || 18789;
const host = config.host || "127.0.0.1";
const token = config.gateway?.auth?.token || config.token || "";

console.log(`Connecting to Gateway at ws://${host}:${port}...`);

const ws = new WebSocket(`ws://${host}:${port}`, { headers: { Origin: "http://127.0.0.1:18789" } }); // (`ws://${host}:${port}`);
let reqId = 100;
const pending = new Map();
let connected = false;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = String(reqId++);
    pending.set(id, { resolve, reject });
    const msg = { type: "req", id, method, params };
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout for ${method}`));
      }
    }, 10000);
  });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  
  // Handle challenge
  if (msg.type === "event" && msg.event === "connect.challenge") {
    console.log("Received challenge, sending connect...");
    ws.send(JSON.stringify({
      type: "req", id: "connect-1", method: "connect",
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: "openclaw-control-ui", version: "1.0", platform: "linux", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: ["tool-events"],
        commands: [], permissions: {},
        auth: { token },
        locale: "zh-CN",
        userAgent: "fix-script/1.0"
      }
    }));
    return;
  }
  
  // Handle connect response
  if (msg.type === "res" && msg.id === "connect-1") {
    if (msg.ok) {
      console.log("Authenticated successfully!");
      connected = true;
      doWork();
    } else {
      console.error("Connect failed:", msg.error);
      process.exit(1);
    }
    return;
  }
  
  // Handle RPC responses
  if (msg.type === "res" && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok === false || msg.error) {
      reject(new Error(msg.error?.message || JSON.stringify(msg)));
    } else {
      resolve(msg.payload || msg.result || msg);
    }
    return;
  }
  
  // Log other messages
  if (msg.type !== "event" || msg.event !== "tick") {
    console.log("Other:", JSON.stringify(msg).substring(0, 200));
  }
});

async function doWork() {
  try {
    console.log("\n=== Listing schedules ===");
    const result = await rpc("schedules.list", {});
    const schedules = result?.schedules || result || [];
    console.log(`Found ${Array.isArray(schedules) ? schedules.length : "?"} schedules`);
    
    if (Array.isArray(schedules)) {
      for (const s of schedules) {
        const hasTg = s.delivery && s.delivery.channel === "telegram";
        console.log(`  ${s.name || s.id}: delivery=${JSON.stringify(s.delivery || {})} ${hasTg ? "<-- TELEGRAM" : ""}`);
        
        if (hasTg) {
          console.log(`  -> Removing telegram delivery from ${s.name || s.id}...`);
          try {
            await rpc("schedules.update", {
              id: s.id,
              delivery: { mode: "announce", bestEffort: true }
            });
            console.log(`  OK: Updated`);
          } catch (e) {
            console.log(`  FAIL: ${e.message}`);
          }
        }
      }
    } else {
      console.log("Unexpected result format:", JSON.stringify(result).substring(0, 500));
    }
    
    console.log("\nDone!");
  } catch (e) {
    console.error("Error:", e.message);
  }
  ws.close();
  process.exit(0);
}

ws.on("error", (e) => console.error("WS Error:", e.message));
setTimeout(() => { console.error("Global timeout"); process.exit(1); }, 20000);
