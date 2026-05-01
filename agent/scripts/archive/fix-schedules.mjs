import WebSocket from "ws";
import fs from "fs";

// Read Gateway port from openclaw.json
const config = JSON.parse(fs.readFileSync("/home/admin/.openclaw/openclaw.json", "utf8"));
const port = config.port || 18789;
const host = config.host || "127.0.0.1";
const token = config.token || "";

console.log(`Connecting to Gateway at ws://${host}:${port}...`);

const ws = new WebSocket(`ws://${host}:${port}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {}
});

let reqId = 1;
const pending = new Map();

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = reqId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout"));
      }
    }, 10000);
  });
}

ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  } catch(e) { /* v22.0 */ console.error("[fix-schedules] silent catch:", e?.message || e); }
});

ws.on("open", async () => {
  console.log("Connected to Gateway");
  
  try {
    // Step 1: List all schedules
    console.log("\n=== Listing schedules ===");
    const schedules = await rpc("schedules.list", {});
    
    for (const s of (schedules || [])) {
      const hasDelivery = s.delivery && s.delivery.channel === "telegram";
      console.log(`  ${s.name} (${s.id}): delivery=${JSON.stringify(s.delivery)} ${hasDelivery ? "← TELEGRAM" : ""}`);
      
      // Step 2: Update telegram delivery schedules to remove telegram channel
      if (hasDelivery) {
        console.log(`  → Updating ${s.name} to remove telegram delivery...`);
        try {
          const updated = await rpc("schedules.update", {
            id: s.id,
            delivery: {
              mode: "announce",
              bestEffort: true
              // No channel or to — just announce to webchat
            }
          });
          console.log(`  ✅ Updated: ${JSON.stringify(updated?.delivery || "ok")}`);
        } catch (e) {
          console.log(`  ❌ Update failed: ${e.message}`);
        }
      }
    }
    
    console.log("\nDone!");
  } catch (e) {
    console.error("Error:", e.message);
  }
  
  ws.close();
  process.exit(0);
});

ws.on("error", (e) => {
  console.error("WS Error:", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("Global timeout");
  process.exit(1);
}, 15000);
