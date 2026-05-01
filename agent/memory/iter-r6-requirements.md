# Agent Loop R6 — 计划驱动主循环

**版本**: v1.0
**日期**: 2026-04-15
**前置**: R5B 通过（失败自愈闭环完成）
**目标**: 让 planner.mjs 生成的结构化计划真正驱动 LLM 的每一轮决策，而不是生成后被遗忘

---

## 一、问题诊断（基于代码倒推，非推测）

### 发现 1：两套并行计划系统互不相通

RangerAI 当前存在两套独立的计划系统，它们各自生成计划但从未合并：

| 维度 | System A (task-engine.mjs) | System B (planner.mjs) |
|------|--------------------------|----------------------|
| **入口** | `context-injector.mjs:305` | `openclaw-handler.mjs:307` |
| **时序** | `chat.send` **之前** | `chat.send` **之后** (fire-and-forget `.then()`) |
| **模型** | gpt-5.4-mini, 3s timeout | invokeLLM (llm-bridge.mjs) |
| **输出** | 文本块 `[PLAN]...[/PLAN]` | StructuredPlan JSON (含 stepId/status/tools) |
| **注入 LLM** | 首轮注入 gatewayMessage | **从未注入** |
| **后续轮次** | `buildActiveStatusBlock` 提供摘要 | 存入 `_planCache` 后无人读取 |

**结论**：System B 的结构化计划（含 stepId、status、tools 等丰富信息）在 R1-R5 中被精心构建，但从未进入 LLM 的上下文窗口。LLM 看到的只是 System A 的简陋文本块。

### 发现 2：`assembleFromEventStream` 是死代码

`context-injector.mjs:446` 导出了 `assembleFromEventStream` 函数，内含完整的 Plan Layer 注入逻辑（L468-471：`formatPlanForInjection(plan)` → `parts.push(planBlock)`）。但 **全局 grep 显示没有任何文件调用此函数**。这意味着 R1-R4 构建的 Plan Layer 从未被激活。

### 发现 3：`generatePlan` 的 fire-and-forget 时序问题

```
openclaw-handler.mjs:295  payload = await gateway.request("chat.send", chatSendParams);
                           // ↑ LLM 调用已发出
openclaw-handler.mjs:307  _agentLoopModules.pl.generatePlan(msgId, ...).then(plan => {
                           // ↑ 计划生成在 LLM 响应之后才开始
                           //   即使生成成功，首轮 LLM 已经在没有计划的情况下做出了决策
```

这不是 bug — System A 的计划确实在首轮前注入了。但 System B 的结构化计划永远迟到，且后续轮次也不会注入。

### 发现 4：知识注入已有 scope 过滤

`knowledge-injector.mjs:71` 的 `classifyIntent()` 已实现规则级 scope 过滤（general/code/operations/customer-service/kol/analysis/research/creative），并有 token 预算控制。**此项不是死代码，已在生产运行**。R6 可在此基础上增强，但不需要从零构建。

---

## 二、R6 目标

> 让 planner.mjs 的结构化计划成为 LLM 每一轮决策的输入，实现"计划 → 执行 → 反馈 → 下一步"的闭环。

**不做什么**：
- 不合并两套计划系统（风险太高）
- 不重写 task-engine.mjs 的计划生成（它在首轮注入仍有价值）
- 不改变 Gateway 协议

---

## 三、四个任务

### Task 1 [P0]：将 planner.mjs 计划注入 LLM 后续轮次

**问题**：System B 的 StructuredPlan 存在于 `_planCache` 中，但 LLM 在工具循环的后续轮次中看不到它。

**改动文件**：`user-message-handler.mjs`

**改动位置**：L274（`buildActiveStatusBlock` 之后，`finalMessage` 组装之前）

**改动内容**：

```javascript
// R6-Task1: Inject planner.mjs structured plan into LLM context
try {
  const { getPlan, renderPlanForContext } = await import('./planner.mjs');
  // Try both msgId and taskId as keys (R3 registers under both)
  const structuredPlan = getPlan(msgId) || getPlan(taskId);
  if (structuredPlan && structuredPlan.steps?.length > 0) {
    const planBlock = renderPlanForContext(structuredPlan);
    if (planBlock) {
      contextParts.push(planBlock);
      logger.info(`[user-message-handler] [R6] Structured plan v${structuredPlan.version} injected (${planBlock.length} chars, ${structuredPlan.steps.length} steps)`);
    }
  }
} catch (_r6Err) {
  logger.warn(`[user-message-handler] [R6] Plan injection failed (non-fatal): ${_r6Err.message}`);
}
```

**验收标准**：
1. 日志出现 `[R6] Structured plan v1 injected` 且 chars > 0
2. LLM 后续轮次的 context 中包含 `[STRUCTURED_PLAN]` 或 `renderPlanForContext` 的输出格式
3. 正常任务（无计划的简单 chat）不受影响

**风险控制**：
- try/catch 包裹，失败不阻塞主流程
- 只在 structuredPlan 存在且有步骤时注入
- 与 `buildActiveStatusBlock` 共存（两者提供不同粒度的信息）

---

### Task 2 [P0]：优化 Planner Prompt 生成 2+ 步分解计划

**问题**：当前 planner.mjs 的 `PLAN_SYSTEM_PROMPT_BASE` 生成的计划经常只有 1 步（"直接回答用户"），对 LLM 没有指导价值。

**改动文件**：`planner.mjs`

**改动位置**：L48-90（`PLAN_SYSTEM_PROMPT_BASE` 和 `TASK_TYPE_STEP_GUIDANCE`）

**改动内容**：

1. 在 `PLAN_SYSTEM_PROMPT_BASE` 中增加硬性约束：

```
Rules:
...
7. MINIMUM 2 steps required. Single-step plans are INVALID.
8. If the task seems simple, still decompose into: a) understand/verify step, b) execute/respond step
9. Each step title must be specific and actionable, not generic like "respond to user"
```

2. 更新 `TASK_TYPE_STEP_GUIDANCE` 中 chat 和 translation 的 min 从 1 改为 2：

```javascript
chat: { min: 2, max: 3, hint: "For chat: 1) Analyze the user's intent and context 2) Formulate and deliver response. Even simple queries benefit from explicit analysis." },
translation: { min: 2, max: 3, hint: "For translation: 1) Analyze source text structure and context 2) Translate with appropriate register 3) Verify accuracy." },
```

3. 在 `generatePlan` 函数（L119）的 LLM 调用后增加验证：

```javascript
// R6-Task2: Validate minimum step count
if (plan && plan.steps && plan.steps.length < 2) {
  logger.warn(`[${ts()}] [planner] [R6] Plan has ${plan.steps.length} step(s), below minimum 2. Adding analysis step.`);
  plan.steps.unshift({
    id: 'step-0',
    title: '分析用户意图和上下文',
    status: 'done', // Already implicitly done
    tools: [],
    output: 'Context analyzed, proceeding with execution'
  });
  // Renumber remaining steps
  plan.steps.forEach((s, i) => { s.id = `step-${i + 1}`; });
  plan.currentStepId = plan.steps.find(s => s.status === 'pending')?.id || plan.steps[0].id;
}
```

**验收标准**：
1. 对 sysadmin/code 类任务，计划始终 >= 3 步
2. 对 chat/translation 类任务，计划始终 >= 2 步
3. 日志中不再出现 `Plan has 1 step(s)` 的 warn（或极少出现后被自动修复）

---

### Task 3 [P1]：Step 推进后注入"当前步骤指令"

**问题**：`markStepDone` 更新了计划状态，但 LLM 在下一轮工具调用时不知道"现在该做哪一步"。

**改动文件**：`openclaw-handler.mjs`

**改动位置**：tool_end 处理块中 `markStepDone` 调用之后（约 L1040 区域）

**改动内容**：

在 `markStepDone` 成功后，构建一条简短的步骤指令并追加到下一轮 LLM 的 observation 中：

```javascript
// R6-Task3: After step completion, inject next step instruction into observation
if (_agentLoopModules && _cs) {
  try {
    const plan = _agentLoopModules.pl.getPlan(msgId);
    if (plan) {
      const nextStep = plan.steps.find(s => s.status === 'pending' || s.status === 'doing');
      if (nextStep) {
        const stepInstruction = `\n[NEXT_STEP] Step ${nextStep.id}: ${nextStep.title}${nextStep.tools?.length ? ` [tools: ${nextStep.tools.join(',')}]` : ''} [/NEXT_STEP]`;
        // Append to the observation that will be sent to LLM
        if (typeof observation === 'string') {
          observation = observation + stepInstruction;
        } else if (observation && typeof observation === 'object') {
          observation._r6NextStep = stepInstruction;
        }
        logger.info(`[${ts()}] [R6-step] Next step injected: ${nextStep.id} "${nextStep.title}"`);
      } else {
        logger.info(`[${ts()}] [R6-step] All steps completed, no next step to inject`);
      }
    }
  } catch (_r6Err) {
    logger.warn(`[${ts()}] [R6-step] Step instruction injection failed (non-fatal): ${_r6Err.message}`);
  }
}
```

**验收标准**：
1. 日志出现 `[R6-step] Next step injected: step-2 "xxx"`
2. LLM 的 observation 中包含 `[NEXT_STEP]...[/NEXT_STEP]` 标记
3. 所有步骤完成后日志出现 `All steps completed`

**注意**：需要确认 `observation` 变量在 tool_end 处理块中的确切位置和类型。如果 observation 是通过 Gateway 协议传递的，可能需要在 `chatSendParams.message` 中追加而非直接修改 observation。实施时需根据实际代码结构调整注入点。

---

### Task 4 [P2]：Knowledge scope 与 Plan step 联动

**问题**：知识注入在首轮完成后不再更新。当计划推进到不同步骤时（如从"读取代码"到"部署服务"），知识上下文应该随之变化。

**改动文件**：`knowledge-injector.mjs`

**改动位置**：`classifyIntent` 函数（L71）

**改动内容**：

增加一个可选参数 `currentStepHint`，当存在时用步骤标题辅助 scope 判断：

```javascript
export function classifyIntent(message, currentStepHint = '') {
  const text = (message + ' ' + currentStepHint).toLowerCase();
  // ... existing regex matching logic unchanged ...
}
```

在 `buildKnowledgeInjectedMessage` 中，尝试从 planner 获取当前步骤标题并传入：

```javascript
// R6-Task4: Use current plan step to enhance knowledge scope
let stepHint = '';
try {
  const { getPlan } = await import('./planner.mjs');
  const plan = getPlan(msgId);
  if (plan) {
    const currentStep = plan.steps.find(s => s.status === 'doing');
    if (currentStep) stepHint = currentStep.title;
  }
} catch (_) {}
const scopes = classifyIntent(userMessage, stepHint);
```

**验收标准**：
1. 当计划步骤包含"部署"关键词时，scope 包含 `operations`
2. 当计划步骤包含"代码"关键词时，scope 包含 `code`
3. 无计划时行为与当前完全一致（向后兼容）

**风险**：低。`classifyIntent` 是纯规则匹配，增加输入文本不会改变其确定性行为。

---

## 四、实施顺序和依赖

```
Task 2 (Prompt 优化) → Task 1 (Plan 注入) → Task 3 (Step 推进) → Task 4 (Knowledge 联动)
         ↑ 无依赖              ↑ 依赖 Task 2           ↑ 依赖 Task 1          ↑ 独立
```

建议分两批：
- **批次 A**（核心闭环）：Task 2 + Task 1 — 确保计划质量 + 计划可见
- **批次 B**（增强）：Task 3 + Task 4 — 步骤级精细控制

---

## 五、涉及文件清单

| 文件 | Task | 改动量 | 风险 |
|------|------|--------|------|
| `planner.mjs` | Task 2 | ~30 行 | 低（prompt 和验证逻辑） |
| `user-message-handler.mjs` | Task 1 | ~15 行 | 低（追加 contextParts） |
| `openclaw-handler.mjs` | Task 3 | ~20 行 | 中（需确认 observation 注入点） |
| `knowledge-injector.mjs` | Task 4 | ~10 行 | 低（增加可选参数） |

**不修改的文件**：
- `task-engine.mjs` — System A 保持不变，继续提供首轮计划和 `buildActiveStatusBlock`
- `context-injector.mjs` — `assembleFromEventStream` 暂不激活（风险太高，且 Task 1 已解决注入问题）
- `event-stream.mjs` — R5 已完善，无需改动
- `executor.mjs` — R5 已完善，无需改动

---

## 六、统一验收标准（6 项）

| # | 验收项 | 要求的日志模式 | 验证方法 |
|---|--------|-------------|---------|
| 1 | 结构化计划注入 LLM | `[R6] Structured plan v1 injected (N chars, M steps)` | grep worker 日志 |
| 2 | 计划最少 2 步 | 无 `Plan has 1 step(s)` 或有自动修复日志 | 发送 5 个不同类型任务，检查计划步骤数 |
| 3 | 步骤推进通知 | `[R6-step] Next step injected: step-N "xxx"` | 发送多步骤任务，检查每次 tool_end 后的日志 |
| 4 | Knowledge scope 联动 | scope 包含计划步骤相关的类别 | 发送含"部署"步骤的任务，检查 knowledge scope 日志 |
| 5 | 正常任务无回归 | 简单 chat 任务正常完成，无额外错误 | 发送"你好"等简单消息 |
| 6 | 服务健康 | `status=ok workerReady=true` | curl health endpoint |

---

## 七、备份要求

修改前备份以下文件到 `/home/admin/backups/agent-loop-r6/`：
- `planner.mjs`
- `user-message-handler.mjs`
- `openclaw-handler.mjs`
- `knowledge-injector.mjs`

---

## 八、与 R1-R5 的关系

| 迭代 | 成果 | R6 如何利用 |
|------|------|-----------|
| R1 | event-stream + planner 模块创建 | R6 读取 planner 的 `getPlan` 和 `renderPlanForContext` |
| R2 | executor 创建 | R6 不直接改动 executor，但 Task 3 的步骤推进与 executor 的 `markStepDone` 协同 |
| R3 | Plan bridge（task-engine → planner cache） | R6 Task 1 依赖此 bridge 确保 `_planCache` 中有计划 |
| R4 | Observation 注入 | R6 Task 3 在 observation 中追加步骤指令 |
| R5/R5B | 失败自愈闭环 | R6 不改动失败路径，replanOnFailure 生成的新计划也会被 Task 1 注入 |

---

## 九、预期效果

**改动前**（当前状态）：
```
用户: "帮我读取 /opt/rangerai-agent/config.json 并修改端口为 3005"
LLM 第 1 轮: 看到 [PLAN] 文本块（System A），执行 cat 命令
LLM 第 2 轮: 看到 [TASK_STATUS] 摘要，但不知道结构化计划的下一步是什么
LLM 第 3 轮: 可能重复读取，或跳过修改步骤
```

**改动后**（R6 完成）：
```
用户: "帮我读取 /opt/rangerai-agent/config.json 并修改端口为 3005"
LLM 第 1 轮: 看到 [PLAN] 文本块 + [STRUCTURED_PLAN] JSON（含 3 步：读取→修改→验证）
LLM 第 2 轮: 看到 [STRUCTURED_PLAN] 中 step-1 ✅ done + [NEXT_STEP] step-2 "修改端口配置"
LLM 第 3 轮: 看到 step-2 ✅ done + [NEXT_STEP] step-3 "验证修改结果"
LLM 第 4 轮: 所有步骤完成，汇报结果
```

---

**起草人**: Manus AI
**审核人**: 待定
