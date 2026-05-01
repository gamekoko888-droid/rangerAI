// S10 P0 Test: Submit a task that requires real tool execution (exec)
import { initAdapter } from "./db-adapter.mjs";
import { createTask, runTask, getTask } from "./worker/supervisor-engine.mjs";

await initAdapter();

const userId = "23a770ce-7588-46e6-a2bb-5d778f9dece0";

// This task REQUIRES exec tool to get real data
const title = "查询服务器磁盘和内存使用情况";
const goal = "查询当前服务器的磁盘使用情况（df -h）和内存使用情况（free -h），报告真实数据";

console.log(`[TEST] Submitting task: ${title}`);
console.log(`[TEST] Goal: ${goal}`);

// We need a real executeStep that goes through Gateway
// Import the worker manager to use sendTask
const { WorkerManager } = await import("./modules/worker-manager.mjs");

// Since we can't easily instantiate WorkerManager in a test script,
// let's use the Gateway HTTP API directly (same as supervisorDecide does)
import fs from 'fs';

const CONFIG_PATH = '/home/admin/.openclaw/openclaw.json';
let gatewayToken = '';
let gatewayPort = 18789;
try {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  gatewayToken = config?.gateway?.auth?.token || '';
  gatewayPort = config?.gateway?.port || 18789;
} catch { /* use defaults */ }

if (!gatewayToken) {
  console.error('[TEST] Gateway token not found!');
  process.exit(1);
}

async function executeStep(instruction) {
  const stepSystemPrompt = `你是 RangerAI 的执行代理（SubAgent），负责执行任务主管分配的单个步骤。

## 核心规则
1. **只完成当前指令**，不要规划额外步骤
2. **必须使用工具获取真实数据**——绝对禁止编造、猜测或凭记忆回答需要实时数据的问题
3. 执行完成后，简洁报告结果

## 工具使用指南
- 当指令要求查询系统信息时 → 使用 exec 工具执行对应的 Shell 命令
- 当指令要求搜索信息时 → 使用 web_search 工具搜索
- 当指令要求读取文件时 → 使用 read 工具读取
- 当指令要求写入文件时 → 使用 write 工具写入
- 当指令要求浏览网页时 → 使用 browser 或 web_fetch 工具

## 输出格式
- 直接输出工具执行的真实结果
- 如果工具执行失败，报告错误信息
- 保持简洁，不要添加不必要的解释`;

  try {
    console.log(`[TEST] executeStep: "${instruction.slice(0, 100)}..."`);
    
    // Use Gateway chat.completions API (non-streaming) 
    // This goes through the Gateway which has full tool execution capability
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          model: 'openclaw',
          messages: [
            { role: 'system', content: stepSystemPrompt },
            { role: 'user', content: instruction },
          ],
          max_tokens: 2000,
          temperature: 0.1,
          stream: false,
        }),
        signal: AbortSignal.timeout(120000), // 2 min timeout for tool execution
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { error: `Gateway API error: ${response.status} ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    console.log(`[TEST] executeStep result (${content?.length || 0} chars): "${(content || '').slice(0, 200)}..."`);
    return { result: content || 'Empty response' };
  } catch (err) {
    console.error(`[TEST] executeStep error: ${err.message}`);
    return { error: err.message };
  }
}

try {
  const taskId = await createTask({
    chatId: "test-s10-tools",
    userId,
    sessionKey: "test-s10",
    title,
    goal,
  });
  console.log(`[TEST] Created task: ${taskId}`);

  const result = await runTask({
    taskId,
    executeStep,
    onProgress: (tid, event) => {
      console.log(`[TEST] Progress: ${event.type} step=${event.stepNum || '-'} ${event.instruction ? event.instruction.slice(0, 80) : ''}`);
    },
  });

  console.log(`\n=== RESULT ===`);
  console.log(`Status: ${result.status}`);
  console.log(`Result: ${(result.result || '').slice(0, 500)}`);
  if (result.error) console.log(`Error: ${result.error}`);

  // Verify the result contains real data
  const resultText = result.result || '';
  const hasRealDisk = /\d+G|\d+%|nvme|Filesystem/i.test(resultText);
  const hasRealMem = /\d+Gi|\d+Mi|Mem:|total/i.test(resultText);
  
  console.log(`\n=== VERIFICATION ===`);
  console.log(`Contains real disk data: ${hasRealDisk}`);
  console.log(`Contains real memory data: ${hasRealMem}`);
  console.log(`Tool execution ${hasRealDisk || hasRealMem ? 'VERIFIED ✅' : 'NOT VERIFIED ❌'}`);

} catch (err) {
  console.error(`[TEST] Fatal error: ${err.message}`);
  console.error(err.stack);
}

process.exit(0);
