# RangerAI 降本不降性能迭代方案

**日期：** 2026-04-13
**基线数据：** 日均 ~$100 Claude API 费用（Apr 10-13 实测）
**目标：** 降至 $15-25/天，不牺牲任何用户可感知的性能

---

## 成本结构拆解

在给出方案前，先明确钱花在哪里。

### 当前成本构成

| 成本来源 | 占比（估算） | 机制 |
|---------|------------|------|
| **Gateway session 上下文重传** | ~60% | 每次 `chat.send` 发送完整 session（平均 82k tokens）给 Anthropic，按 input 全价计费 |
| **Extended thinking (high)** | ~20% | 7/10 种任务类型默认 `thinking: high`，thinking tokens 按 output 价格计费（$15/MTok） |
| **KV-Cache miss（prompt caching 失效）** | ~15% | R60 监控显示 miss rate 80-100%，system prompt 缓存几乎没有命中 |
| **其他直接 API 调用** | ~5% | ai-data-mapper、file-server、infra-routes 绕过 Gateway 直连 Anthropic |

### 关键数据

| 指标 | 当前值 | 说明 |
|------|--------|------|
| 日均 Claude 请求 | ~125 次 | 88.6% 走 Gateway，其余走 DirectAPI |
| 平均 session 大小 | 82,671 tokens | 75% 的请求 session >50k tokens |
| SOUL.md（system prompt） | 2,240 tokens | 仅占 session 的 2.7%，缓存价值有限 |
| KV-Cache miss rate | 80-100% | 因为 `effectiveMessage` 每次都变（含 ROLE_CONTEXT + 用户消息） |
| thinking level 分布 | high: 70%, medium: 20%, low: 10% | 绝大多数请求用最贵的 thinking |
| context-window-manager 压缩 | 几乎未触发 | 大多数 session 在 3-5% 利用率，但 Gateway 侧 session 已 82k+ |

---

## 方案一：修复 KV-Cache prefix 稳定性（预估节省 20-30%）

**问题根因：** R60 的 `trackPrefix` 对 `effectiveMessage` 做哈希，但 `effectiveMessage` = `[ROLE_CONTEXT]...[/ROLE_CONTEXT] + 用户消息`。用户消息每次都不同，导致 prefix hash 每次都变，Anthropic 的 prompt caching 完全失效。

**但真正的缓存不在这里。** OpenClaw Gateway 内部已经实现了 Anthropic prompt caching（`model-selection-46xMp11W.js` 第 104452 行）：它会自动给 system messages 和最后一条 user message 添加 `cache_control: { type: "ephemeral" }`。Gateway 的 session 包含完整对话历史，Anthropic 会缓存 system prompt + 对话历史前缀。

**真正的问题是：Gateway 的缓存是否在生效？** 从日志看，`cacheRead` 和 `cacheWrite` 全部为 0 或未记录。需要确认。

### 修改方案

**文件：** `/opt/rangerai-agent/worker/usage-tracker.mjs`

在 `extractGatewayUsage` 函数中，增加对 `cache_read_input_tokens` 和 `cache_creation_input_tokens` 的提取和日志记录。这不直接省钱，但能让我们看到 Gateway 侧的缓存是否生效。

```javascript
// usage-tracker.mjs - 在 extractGatewayUsage 中增加
const usage = {
  input: u.input_tokens || 0,
  output: u.output_tokens || 0,
  totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
  cacheRead: u.cache_read_input_tokens || 0,    // 新增
  cacheWrite: u.cache_creation_input_tokens || 0, // 新增
  cost: u.cost || null,
  source: 'gateway-jsonl'
};
logger.info(`[usage-tracker] Cache stats: read=${usage.cacheRead}, write=${usage.cacheWrite}`);
```

**如果确认缓存未生效**，需要检查 OpenClaw Gateway 的 Anthropic API 调用是否包含 `anthropic-beta: prompt-caching-2024-07-31` header。如果没有，需要在 `openclaw.json` 中配置或升级 OpenClaw 版本。

**风险：** 零。只是增加日志观测。

---

## 方案二：按任务类型分级 thinking level（预估节省 15-25%）

**问题根因：** `smart-router-config.json` 中 7/10 种任务类型设为 `thinking: high`。Extended thinking 的 thinking tokens 按 output 价格计费（Claude Sonnet 4: $15/MTok），且 `high` 模式下 thinking budget 可达数千 tokens。

**核心洞察：** 大部分日常对话（闲聊、简单问答、翻译）不需要 extended thinking。只有代码生成、复杂推理、系统运维才真正受益于 `high` thinking。

### 修改方案

**文件：** `/opt/rangerai-agent/config/smart-router-config.json`

```json
{
  "task_thinking_levels": {
    "code": "high",           // 保持：代码生成需要深度思考
    "sysadmin": "high",       // 保持：运维操作需要谨慎
    "reasoning": "high",      // 保持：复杂推理需要
    "research": "medium",     // 降级：研究类用 medium 足够
    "creative": "medium",     // 降级：创意写作不需要 high thinking
    "chinese_content": "medium", // 降级：中文内容生产用 medium
    "image_generation": "low", // 降级：图片生成不需要 thinking
    "gaming": "low",          // 降级：游戏相关对话不需要 high
    "chat": "low",            // 保持
    "translation": "low"      // 保持
  }
}
```

**性能影响分析：**

| 任务类型 | 原 thinking | 新 thinking | 性能影响 |
|---------|------------|------------|---------|
| code | high | high | 无变化 |
| sysadmin | high | high | 无变化 |
| reasoning | high | high | 无变化 |
| research | high | medium | 极小：research 主要靠信息检索，thinking 贡献有限 |
| creative | high | medium | 极小：创意写作质量主要取决于 prompt 和上下文 |
| chinese_content | high | medium | 极小：中文内容生产不依赖 extended thinking |
| image_generation | high | low | 无影响：图片生成由 Gemini 处理，thinking 对它无意义 |
| gaming | medium | low | 极小：游戏对话以信息查询为主 |

**风险：** 低。如果某类任务质量下降，可以单独调回 `high`。

---

## 方案三：对话历史分层压缩（预估节省 30-50%）

**问题根因：** 这是最大的成本驱动因素。Gateway session 平均 82k tokens，75% 的请求超过 50k tokens。但 `context-window-manager` 的压缩阈值设在 75%（150k tokens），绝大多数 session 永远不会触发压缩。

**核心洞察：** Gateway session 的 token 数和 `context-window-manager` 追踪的 token 数是两个不同的东西。`context-window-manager` 只追踪 worker 侧注入的消息（3-5% 利用率），而 Gateway session 包含了 OpenClaw 的完整 agent loop（system prompt + 对话历史 + tool calls + tool results），这才是真正的成本。

### 修改方案 A：降低 Gateway session 的 context window

**文件：** `/home/admin/.openclaw/openclaw.json`

在 `agents.defaults` 或 `agents.main` 中设置 `contextWindow`：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6",
        "contextWindow": 80000
      }
    }
  }
}
```

这会让 OpenClaw Gateway 在 session 达到 80k tokens 时自动触发内部压缩（OpenClaw 有内置的 autocompact 机制），而不是等到 200k。

**效果：** 平均 session 从 82k 降到 ~50k（Gateway 压缩后），每次请求的 input 成本降低 ~40%。

**风险：** 中等。需要测试 Gateway 的 autocompact 质量是否足够好，不会丢失关键上下文。建议先设为 100k 观察一周，再逐步降到 80k。

### 修改方案 B：主动 session 轮换

**文件：** `/opt/rangerai-agent/worker/openclaw-handler.mjs`

在 `handleViaOpenClaw` 中，当 session token 数超过阈值时，创建新 session 并注入摘要：

```javascript
// 在 chat.send 之前检查 session 大小
const sessionInfo = await gateway.request("sessions.get", { key: gatewaySessionKey });
if (sessionInfo?.tokens > 80000) {
  // 1. 用 LLM 生成当前对话摘要（用 gpt-5.4-mini，成本极低）
  // 2. 创建新 session
  // 3. 注入摘要作为 system context
  logger.info(`[worker] Session rotation: ${sessionInfo.tokens} tokens → new session with summary`);
}
```

**风险：** 高。Session 轮换可能导致上下文丢失，需要非常仔细的摘要策略。建议作为 P2 方案，先实施方案 A。

---

## 方案四：稳定 system prompt prefix 以提升缓存命中率（预估节省 10-15%）

**问题根因：** `effectiveMessage` 每次都包含不同的用户消息，导致 R60 监控的 prefix hash 每次都变。但这个监控本身不影响 Gateway 侧的缓存。真正影响缓存的是 Gateway 发给 Anthropic 的 system prompt 是否稳定。

**核心洞察：** OpenClaw Gateway 的 `model-selection` 模块会自动给 system messages 添加 `cache_control`。如果 SOUL.md（system prompt）保持稳定，Anthropic 会缓存它。SOUL.md 只有 2,240 tokens，缓存价值有限。但如果能把 ROLE_CONTEXT 也纳入缓存前缀，缓存价值会大幅提升。

### 修改方案

**文件：** `/opt/rangerai-agent/worker/openclaw-handler.mjs`

将 `ROLE_CONTEXT` 从 `effectiveMessage`（user message）移到 session 的 system prompt 中：

```javascript
// 当前（每次都变，无法缓存）：
const effectiveMessage = roleSystemPrompt
  ? `[ROLE_CONTEXT]\n${roleSystemPrompt}\n[/ROLE_CONTEXT]\n\n${userMessage}`
  : userMessage;

// 优化后（ROLE_CONTEXT 作为 session system prompt 的一部分，可被缓存）：
// 在 session 创建时注入 ROLE_CONTEXT 到 system prompt
// effectiveMessage 只包含用户消息
const effectiveMessage = userMessage;
// ROLE_CONTEXT 通过 sessions.patch 注入到 system prompt
if (roleSystemPrompt && !sessionRoleInjected) {
  await gateway.request("sessions.patch", {
    key: gatewaySessionKey,
    systemPrompt: `${baseSystemPrompt}\n\n[ROLE_CONTEXT]\n${roleSystemPrompt}\n[/ROLE_CONTEXT]`
  });
}
```

**风险：** 中等。需要确认 OpenClaw Gateway 的 `sessions.patch` 是否支持 `systemPrompt` 参数。如果不支持，需要在 session 创建时就注入。

---

## 方案五：轻量任务路由到 GPT-5.4-mini（预估节省 15-20%）

**问题根因：** 当前 88.6% 的请求走 Claude Sonnet 4（$3/$15 per MTok）。但很多任务（闲聊、简单查询、翻译）用 GPT-5.4-mini（$0.15/$0.60 per MTok）就能完成，成本差 20-25 倍。

**核心洞察：** `smart-router-config.json` 的 `gateway_model_routing` 已经把 `chat` 和 `translation` 归为 `default_model_tasks`，但 Gateway 的 primary model 是 Claude，所以这些任务仍然走 Claude。

### 修改方案

**文件：** `/opt/rangerai-agent/config/smart-router-config.json`

问题在于 `gateway_model_routing` 的 `default_model_tasks` 没有真正生效——Gateway 的 primary model 始终是 Claude。需要在 `openclaw-handler.mjs` 中，对 `default_model_tasks` 使用 `sessions.patch` 切换到 mini 模型：

```javascript
// openclaw-handler.mjs - 在 chat.send 之前
const defaultTasks = ['chat', 'research', 'creative', 'gaming', 'translation', 'image_generation'];
if (defaultTasks.includes(options.taskType) && !options.needsStrongModel) {
  // 对轻量任务，使用 mini 模型
  await gateway.request("sessions.patch", {
    key: gatewaySessionKey,
    model: 'openai/gpt-5.4-mini'
  });
  logger.info(`[worker] [cost-opt] Routing ${options.taskType} to gpt-5.4-mini`);
}
```

**但有一个关键问题：** Gateway session 是有状态的，切换模型后再切回来可能导致上下文格式不兼容。更安全的做法是：

**替代方案：对轻量任务走 DirectAPI 路径**

```javascript
// 在 user-message-handler.mjs 中，对轻量任务直接走 llm-gateway 的 DirectAPI
if (['chat', 'translation'].includes(taskType)) {
  // 绕过 Gateway，直接用 llm-gateway 的 streamChat
  return await handleViaDirectAPI(message, { model: 'openai/gpt-5.4-mini', ...options });
}
```

**风险：** 中等。轻量任务走 mini 模型可能在某些边界情况下质量下降。建议先只对 `chat` 和 `translation` 两种类型实施，观察用户反馈。

**性能影响：** GPT-5.4-mini 的响应速度比 Claude Sonnet 4 更快，用户体验反而会提升。

---

## 方案六：修复成本追踪（预估节省 0%，但必须做）

**问题根因：** 当前 `endTrace` 只记录用户消息的 token 数（平均 268 tokens/请求），完全忽略了 Gateway session 的 82k tokens 上下文。导致成本报表严重失真（显示 $2.12/3天，实际 $50-100/3天）。

### 修改方案

**文件：** `/opt/rangerai-agent/worker/user-message-handler.mjs`

在 `endTrace` 中使用 Gateway 返回的真实 usage 数据：

```javascript
// 当前（估算，严重低估）：
tokenInfo = { prompt_tokens: estimateTokens(message), completion_tokens: estimateTokens(reply) };

// 修复后（使用 Gateway 真实数据）：
const gatewayUsage = await extractGatewayUsage(sessionKey, msgId);
if (gatewayUsage) {
  tokenInfo = {
    prompt_tokens: gatewayUsage.input,
    completion_tokens: gatewayUsage.output,
    total_tokens: gatewayUsage.totalTokens,
    cache_read_tokens: gatewayUsage.cacheRead,
    cache_write_tokens: gatewayUsage.cacheWrite,
    gateway_cost: gatewayUsage.cost,
    source: 'gateway-real'
  };
} else {
  // fallback to estimate
  tokenInfo = { ... };
}
```

**风险：** 零。只影响日志记录，不影响功能。

---

## 实施优先级与预期效果

| 阶段 | 方案 | 预估节省 | 实施时间 | 风险 | 依赖 |
|------|------|---------|---------|------|------|
| **第一天** | 方案二：thinking level 分级 | 15-25% | 10 分钟 | 低 | 无 |
| **第一天** | 方案六：修复成本追踪 | 0%（可观测性） | 30 分钟 | 零 | 无 |
| **第一天** | 方案一：确认 Gateway 缓存状态 | 0%（诊断） | 20 分钟 | 零 | 无 |
| **第三天** | 方案三A：降低 Gateway context window | 30-50% | 20 分钟 | 中 | 方案一结果 |
| **第一周** | 方案五：轻量任务路由 mini 模型 | 15-20% | 2 小时 | 中 | 需要测试 |
| **第二周** | 方案四：稳定 system prompt prefix | 10-15% | 3 小时 | 中 | 需要验证 Gateway API |

### 预期成本变化

| 阶段 | 日均成本 | 较基线节省 |
|------|---------|----------|
| 当前基线 | ~$100/天 | - |
| 方案二落地后 | ~$75-85/天 | 15-25% |
| 方案三A 落地后 | ~$40-55/天 | 45-60% |
| 方案五落地后 | ~$25-40/天 | 60-75% |
| 全部落地后 | ~$15-25/天 | 75-85% |

---

## 关键原则

1. **不降低 code/sysadmin/reasoning 的质量**：这三种任务类型保持 Claude Sonnet 4 + thinking: high，是 Ranger 的核心价值
2. **渐进式实施**：每个方案独立可回滚，观察一天再推进下一个
3. **数据驱动**：先修复成本追踪（方案六），再做优化决策
4. **缓存优先**：如果 Gateway 的 prompt caching 能生效，是最"免费"的优化

---

*文档生成时间：2026-04-13 20:30 CST*
