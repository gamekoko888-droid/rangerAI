import WebSocket from "ws";
import fs from "fs";

const config = JSON.parse(fs.readFileSync("/home/admin/.openclaw/openclaw.json", "utf8"));
const port = config.port || 18789;
const host = config.host || "127.0.0.1";
const token = config.token || "";

const ws = new WebSocket(`ws://${host}:${port}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {}
});

ws.on("message", (raw) => {
  const str = raw.toString();
  console.log("RECV:", str.substring(0, 500));
});

ws.on("open", async () => {
  console.log("Connected");
  
  // Try different method names
  const methods = ["schedules.list", "schedule.list", "cron.list", "health", "status"];
  let id = 1;
  for (const m of methods) {
    console.log(`\nTrying: ${m}`);
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: m, params: {}, id: id++ }));
    await new Promise(r => setTimeout(r, 2000));
  }
  
  setTimeout(() => { ws.close(); process.exit(0); }, 3000);
});

ws.on("error", (e) => console.error("Error:", e.message));
setTimeout(() => process.exit(1), 20000);
