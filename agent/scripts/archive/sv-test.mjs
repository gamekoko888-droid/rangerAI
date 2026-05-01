import { initAdapter } from "./db-adapter.mjs";
import { createTask, runTask } from "./worker/supervisor-engine.mjs";
import crypto from "crypto";

await initAdapter();

const userId = "23a770ce-7588-46e6-a2bb-5d778f9dece0";
const tasks = [
  "回答：1+1等于多少",
  "回答：中国的首都是哪里",
  "回答：水的化学式是什么",
  "回答：地球有几大洲",
  "回答：一年有多少天",
  "回答：太阳从哪个方向升起",
  "回答：人体有多少块骨头",
  "回答：光的速度大约是多少",
  "回答：世界上最大的海洋是什么",
  "回答：一周有几天",
];

async function executeStep(instruction) {
  return { success: true, output: "Executed: " + instruction };
}

let passed = 0, failed = 0;
for (let i = 0; i < tasks.length; i++) {
  const title = tasks[i];
  console.log("[" + (i+1) + "/10] " + title);
  try {
    const taskId = await createTask({
      chatId: "test-chat-" + i,
      userId,
      sessionKey: "test-session",
      title,
      goal: title,
    });
    const result = await runTask({
      taskId,
      executeStep,
      onProgress: () => {},
    });
    if (result.status === "completed") {
      passed++;
      console.log("  PASS: " + (result.result || "").slice(0, 80));
    } else {
      failed++;
      console.log("  FAIL: " + result.status + " - " + (result.error || "unknown"));
    }
  } catch (err) {
    failed++;
    console.log("  ERROR: " + err.message.slice(0, 100));
  }
}
console.log("\n=== RESULTS ===");
console.log("Passed: " + passed + "/10 (" + (passed*10) + "%)");
console.log("Failed: " + failed + "/10");
process.exit(0);
