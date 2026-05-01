/**
 * R31-T3: Direct planner test — verify LLM plan generation works after R31 fixes
 */
import { generatePlan } from './worker/planner.mjs';

const testMsg = "帮我分析一下游戏充值市场的竞争格局";
const sessionKey = "r31_test_" + Date.now();
const msgId = "r31-test-" + Date.now();

console.log("[R31-T3] Testing planner with:", testMsg);
console.log("[R31-T3] Session:", sessionKey, "MsgId:", msgId);

try {
  const plan = await generatePlan(msgId, sessionKey, testMsg, []);
  console.log("[R31-T3] Plan result:", JSON.stringify(plan, null, 2).substring(0, 500));
  
  if (plan && plan.phases && plan.phases.length > 0) {
    console.log("[R31-T3] SUCCESS: Plan generated with", plan.phases.length, "phases");
    console.log("[R31-T3] Fallback:", plan._fallback ? "YES" : "NO");
  } else {
    console.log("[R31-T3] WARNING: Plan may be fallback");
  }
} catch (err) {
  console.error("[R31-T3] ERROR:", err.message);
}

process.exit(0);
