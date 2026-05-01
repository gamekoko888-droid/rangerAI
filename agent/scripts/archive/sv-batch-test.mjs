// S10 P2: Batch test for success rate measurement
// Submits 20 diverse tasks and measures success rate
import { initAdapter } from "./db-adapter.mjs";
import { createTask, runTask, getTask, getHealth } from "./worker/supervisor-engine.mjs";
import fs from 'fs';

await initAdapter();

const userId = "23a770ce-7588-46e6-a2bb-5d778f9dece0";

// Gateway config for executeStep
const CONFIG_PATH = '/home/admin/.openclaw/openclaw.json';
let gatewayToken = '';
let gatewayPort = 18789;
try {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  gatewayToken = config?.gateway?.auth?.token || '';
  gatewayPort = config?.gateway?.port || 18789;
} catch { /* use defaults */ }

if (!gatewayToken) {
  console.error('[BATCH] Gateway token not found!');
  process.exit(1);
}

// SubAgent system prompt
const SUBAGENT_PROMPT = `你是 RangerAI 的执行代理（SubAgent），负责执行任务主管分配的单个步骤。

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

async function executeStep(instruction) {
  try {
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
            { role: 'system', content: SUBAGENT_PROMPT },
            { role: 'user', content: instruction },
          ],
          max_tokens: 2000,
          temperature: 0.1,
          stream: false,
        }),
        signal: AbortSignal.timeout(120000),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { error: `Gateway API error: ${response.status} ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    return { result: content || 'Empty response' };
  } catch (err) {
    return { error: err.message };
  }
}

// Diverse test tasks
const TASKS = [
  // Category 1: Knowledge Q&A (simple, should be fast)
  { title: "回答：中国有多少个省级行政区", goal: "回答：中国有多少个省级行政区" },
  { title: "回答：Python 的创始人是谁", goal: "回答：Python 的创始人是谁" },
  { title: "回答：HTTP 状态码 404 代表什么", goal: "回答：HTTP 状态码 404 代表什么" },
  { title: "回答：DNA 的全称是什么", goal: "回答：DNA 的全称是什么" },
  { title: "回答：世界上最长的河流是什么", goal: "回答：世界上最长的河流是什么" },
  
  // Category 2: System queries (requires exec tool)
  { title: "查询当前系统 uptime", goal: "使用 exec 工具执行 uptime 命令，报告服务器运行时间" },
  { title: "查看当前目录文件列表", goal: "使用 exec 工具执行 ls -la /opt/ 命令，列出 /opt/ 目录下的文件" },
  { title: "查询 Node.js 版本", goal: "使用 exec 工具执行 node --version 命令，报告 Node.js 版本号" },
  { title: "查看系统 CPU 信息", goal: "使用 exec 工具执行 lscpu | head -15 命令，报告 CPU 基本信息" },
  { title: "查看当前网络连接", goal: "使用 exec 工具执行 ss -tlnp | head -20 命令，报告当前监听的端口" },
  
  // Category 3: Calculation/Logic
  { title: "计算 2^20 的值", goal: "计算 2 的 20 次方的值" },
  { title: "回答：1到100的质数有多少个", goal: "回答：1到100之间有多少个质数" },
  { title: "翻译：Hello World 的中文", goal: "将 'Hello World, how are you today?' 翻译成中文" },
  
  // Category 4: File operations (requires read tool)
  { title: "读取系统主机名", goal: "使用 exec 工具执行 hostname 命令，报告服务器主机名" },
  { title: "查看系统内核版本", goal: "使用 exec 工具执行 uname -a 命令，报告内核版本信息" },
  
  // Category 5: Multi-step tasks
  { title: "服务器磁盘和内存巡检", goal: "查询当前服务器的磁盘使用情况（df -h）和内存使用情况（free -h），报告真实数据" },
  { title: "查询 Docker 容器状态", goal: "使用 exec 工具执行 docker ps 命令，列出当前运行的 Docker 容器" },
  { title: "查看系统负载", goal: "使用 exec 工具执行 cat /proc/loadavg 命令，报告系统负载" },
  { title: "查询进程数量", goal: "使用 exec 工具执行 ps aux | wc -l 命令，报告当前运行的进程数量" },
  { title: "查看系统日志最后5行", goal: "使用 exec 工具执行 journalctl --no-pager -n 5 命令，显示最近的5条系统日志" },
];

console.log(`[BATCH] Starting batch test: ${TASKS.length} tasks`);
console.log(`[BATCH] Gateway port: ${gatewayPort}`);
console.log('');

const results = [];
let passed = 0;
let failed = 0;

for (let i = 0; i < TASKS.length; i++) {
  const task = TASKS[i];
  const startTime = Date.now();
  console.log(`[${i+1}/${TASKS.length}] ${task.title}...`);
  
  try {
    const taskId = await createTask({
      chatId: `batch-s10-${i}`,
      userId,
      sessionKey: `batch-s10-${i}`,
      title: task.title,
      goal: task.goal,
    });

    const result = await runTask({
      taskId,
      executeStep,
      onProgress: () => {},
    });

    const elapsed = Date.now() - startTime;
    const success = result.status === 'completed';
    
    if (success) {
      passed++;
      console.log(`  ✅ ${result.status} (${(elapsed/1000).toFixed(1)}s) — ${(result.result || '').slice(0, 80)}`);
    } else {
      failed++;
      console.log(`  ❌ ${result.status} (${(elapsed/1000).toFixed(1)}s) — ${result.error || result.result || 'unknown'}`);
    }
    
    results.push({
      title: task.title,
      status: result.status,
      elapsed,
      result: (result.result || '').slice(0, 200),
      error: result.error || null,
    });
  } catch (err) {
    failed++;
    const elapsed = Date.now() - startTime;
    console.log(`  ❌ CRASH (${(elapsed/1000).toFixed(1)}s) — ${err.message}`);
    results.push({
      title: task.title,
      status: 'crash',
      elapsed,
      result: null,
      error: err.message,
    });
  }
  
  // Small delay between tasks to avoid overwhelming Gateway
  if (i < TASKS.length - 1) {
    await new Promise(r => setTimeout(r, 2000));
  }
}

console.log('\n========================================');
console.log(`BATCH TEST RESULTS: ${passed}/${TASKS.length} passed (${(passed/TASKS.length*100).toFixed(1)}%)`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('========================================\n');

// Print failed tasks
if (failed > 0) {
  console.log('Failed tasks:');
  results.filter(r => r.status !== 'completed').forEach(r => {
    console.log(`  - ${r.title}: ${r.status} — ${r.error || 'no error info'}`);
  });
}

// Check overall health
const health = await getHealth();
console.log('\nUpdated health:', JSON.stringify(health, null, 2));

process.exit(0);
