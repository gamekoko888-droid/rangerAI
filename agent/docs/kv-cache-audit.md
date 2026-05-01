# KV-Cache 系统 Prompt 审计报告

> **版本**: R53 · **日期**: 2026-04-04 · **审计范围**: RangerAI Agent 全链路系统 Prompt 缓存机制

---

## 1. 执行摘要

本报告对 RangerAI Agent 的 KV-Cache（Prompt Caching）实现进行了全面审计，覆盖 OpenClaw Gateway 路径和 Direct API Fallback 路径两条代码通道。审计基于生产日志的实际缓存命中数据，结合 Anthropic 官方文档的最新规范，评估当前实现的正确性、效率和潜在优化空间。

**核心结论**：当前系统的 Prompt Caching 已正确生效，生产环境缓存命中率达 **97.0%**（33 次调用中仅 1 次冷启动），累计节省约 **$4.51**（基于当前日志周期）。但仍存在两个可优化的结构性问题。

---

## 2. 架构概览

RangerAI 的 LLM 调用存在两条独立路径，每条路径的系统 Prompt 注入和缓存机制不同。

| 维度 | Gateway 路径 (OpenClaw) | Direct API Fallback 路径 |
|------|------------------------|--------------------------|
| 触发条件 | 默认路径，Gateway 健康时使用 | Gateway 健康度低时自动切换 |
| 系统 Prompt 来源 | OpenClaw 内部加载 SOUL.md + 技能上下文 | `getSoulSystemPrompt()` 函数读取 SOUL.md |
| cache_control 注入 | `pi-embedded-BaSvmUpW.js:19933` 的 `onPayload` 钩子 | `smart-router.mjs:565` 直接构造 |
| 适用模型 | Anthropic 模型（通过 `isOpenRouterAnthropicModel` 检测） | Anthropic 模型（通过 `callAnthropicDirect`） |
| API 版本 | OpenClaw 内部管理 | `anthropic-version: 2023-06-01` |
| Beta 头 | `fine-grained-tool-streaming-2025-05-14`, `interleaved-thinking-2025-05-14` | 无（不需要） |

---

## 3. Gateway 路径分析

### 3.1 系统 Prompt 组装

OpenClaw Gateway 从以下来源组装系统 Prompt：

1. **SOUL.md**（`/home/admin/.openclaw/workspace/SOUL.md`，21,941 字节）—— 核心人格与行为规范
2. **技能上下文**（coding-agent, searxng, cost-tracker 等 skill 的 SKILL.md）—— 按需注入
3. **Agent 身份信息**（identity.name = "RangerAI"，identity.theme 等）

Gateway 将这些内容拼接为系统消息，然后通过 `onPayload` 钩子注入 `cache_control`。

### 3.2 cache_control 注入机制

```javascript
// pi-embedded-BaSvmUpW.js:19919-19943
function createOpenRouterSystemCacheWrapper(baseStreamFn) {
    return (model, context, options) => {
        // 仅对 Anthropic 模型生效
        if (!isOpenRouterAnthropicModel(model.provider, model.id))
            return underlying(model, context, options);
        
        const originalOnPayload = options?.onPayload;
        return underlying(model, context, {
            ...options,
            onPayload: (payload) => {
                const messages = payload?.messages;
                if (Array.isArray(messages)) for (const msg of messages) {
                    if (msg.role !== "system" && msg.role !== "developer") continue;
                    // 字符串内容 → 转为带 cache_control 的数组格式
                    if (typeof msg.content === "string") msg.content = [{
                        type: "text",
                        text: msg.content,
                        cache_control: { type: "ephemeral" }
                    }];
                    // 数组内容 → 在最后一个块上添加 cache_control
                    else if (Array.isArray(msg.content) && msg.content.length > 0) {
                        const last = msg.content[msg.content.length - 1];
                        if (last && typeof last === "object")
                            last.cache_control = { type: "ephemeral" };
                    }
                }
                return originalOnPayload?.(payload, model);
            }
        });
    };
}
```

**评估**：此实现正确地将 `cache_control: { type: "ephemeral" }` 添加到所有 system/developer 角色消息的内容块上。根据 Anthropic 官方文档，这会标记缓存断点，使得从请求开头到该断点的所有内容（tools → system → messages 顺序）被缓存。

### 3.3 模型匹配逻辑

```javascript
function isOpenRouterAnthropicModel(provider, modelId) {
    return provider.toLowerCase() === "openrouter" 
        && modelId.toLowerCase().startsWith("anthropic/");
}
```

**潜在问题**：此函数仅匹配 `provider === "openrouter"` 的 Anthropic 模型。然而 RangerAI 的 `openclaw.json` 配置中，Anthropic 模型的 provider 是 `"anthropic"`（直连），而非 `"openrouter"`。这意味着 **Gateway 路径的 `createOpenRouterSystemCacheWrapper` 可能不会对直连 Anthropic 模型生效**。

但生产日志显示缓存确实在工作（97% 命中率），这说明 OpenClaw 内部可能有其他缓存机制，或者 Gateway 在路由时将 provider 映射为了 `"openrouter"` 格式。需要进一步确认 OpenClaw 内部的 provider 规范化逻辑。

---

## 4. Direct API Fallback 路径分析

### 4.1 系统 Prompt 来源

```javascript
// smart-router.mjs:560-573
const sysText = systemPrompt || "You are a helpful assistant.";
const body = JSON.stringify({
    model: apiModel,
    max_tokens: 8192,
    stream: true,
    system: [
        {
            type: "text",
            text: sysText,
            cache_control: { type: "ephemeral" }
        }
    ],
    messages
});
```

`systemPrompt` 参数来自 `getSoulSystemPrompt()` 函数，该函数读取 `/home/admin/.openclaw/SOUL.md`（23,915 字节）并截取前 `soul_md_max_chars`（默认 25,000）个字符。

### 4.2 缓存有效性验证

**Token 估算**：SOUL.md 约 23,915 字符 ≈ 18,000 tokens（中英混合文本按 1.3 字符/token 估算），远超 Anthropic Claude Sonnet 的 1,024 token 最低缓存阈值。

**API 版本**：使用 `anthropic-version: 2023-06-01`，符合 Anthropic 官方要求。根据 2026 年最新文档，prompt caching 已内置于标准 API，不需要额外的 `anthropic-beta` 头。

### 4.3 缓存命中日志

```javascript
// smart-router.mjs:636-640
if (parsed.type === "message_start" && parsed.message?.usage) {
    const u = parsed.message.usage;
    if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
        logger.info(`[smart-router] [anthropic-cache] model=${apiModel} ` +
            `input=${u.input_tokens || 0} ` +
            `cache_read=${u.cache_read_input_tokens || 0} ` +
            `cache_write=${u.cache_creation_input_tokens || 0}`);
    }
}
```

**评估**：日志记录正确，能够追踪每次调用的缓存读取和写入 token 数。

---

## 5. 动态内容注入分析

系统 Prompt 的缓存效率取决于前缀的稳定性。以下分析了所有动态内容的注入位置。

| 动态内容 | 注入位置 | 是否影响系统 Prompt 缓存 |
|----------|----------|--------------------------|
| 用户记忆 (`<user_memory>`) | 用户消息前缀 | 否 — 在 messages 中，不影响 system 缓存 |
| 知识库检索结果 (`<knowledge_reference>`) | 用户消息前缀 | 否 — 在 messages 中，不影响 system 缓存 |
| 进度提醒 (GUARDRAIL-PROGRESS) | 前端事件，不注入消息 | 否 — v10.0 已移除 chat.send |
| 浏览器警告 (browserWarning) | 用户消息前缀 | 否 — 在 messages 中，不影响 system 缓存 |
| 任务计划 (plan) | OpenClaw 内部管理 | 可能 — 取决于 Gateway 是否将 plan 放入 system 消息 |

**关键发现**：R53 之前的 `knowledge-injector.mjs` 已经正确地将所有动态内容注入到用户消息（而非系统消息）中，这保证了系统 Prompt 前缀的稳定性。R53 进一步优化了知识块的结构，将固定的指令前缀与动态文档内容分离，但由于这些内容本身就在用户消息中，对系统 Prompt 缓存的影响有限。

---

## 6. 生产环境缓存效果

基于 `worker-stdout.log` 中 33 条 `usage-tracker` 记录的分析：

| 指标 | 数值 |
|------|------|
| 总 API 调用次数 | 33 |
| 冷启动次数 (cacheRead=0) | 1 (3.0%) |
| 缓存命中率 | **97.0%** |
| 总缓存读取成本 | $0.556 |
| 总缓存写入成本 | $0.495 |
| 总输入成本 | $0.000129 |
| 总输出成本 | $0.297 |
| 总成本 | $1.349 |
| 平均每次缓存读取 token 数 | ~56,178 |
| 无缓存假设下的输入成本 | $5.562 |
| 实际输入+缓存成本 | $1.052 |
| **净节省金额** | **$4.510** |

**成本节省率**：缓存使输入 token 成本降低了约 **81%**（$5.562 → $1.052）。理论最大节省率为 90%（缓存读取价格为正常输入的 10%），实际略低是因为缓存写入成本（1.25x）和冷启动的存在。

**冷启动分析**：唯一的冷启动发生在 `04:00:13`，该调用的 `cacheWrite` 高达 $0.168（约 44,920 tokens），表明这是一次新会话的首次调用，需要写入完整的系统 Prompt + 上下文到缓存。

---

## 7. 多提供商缓存对比

| 提供商 | 缓存机制 | RangerAI 实现状态 |
|--------|----------|-------------------|
| Anthropic (Claude) | 显式 `cache_control` 断点 | 已实现，生产验证通过 |
| OpenAI (GPT) | 自动缓存（无需显式标记） | 无需额外实现，OpenAI 自动处理 |
| Google (Gemini) | Context Caching API（需显式创建缓存对象） | 未实现 — 当前使用 `systemInstruction` 但未创建缓存对象 |

---

## 8. 发现的问题与建议

### 8.1 问题 P1：SOUL.md 版本不一致（中等优先级）

**现状**：存在两个 SOUL.md 文件：
- `/home/admin/.openclaw/SOUL.md`（23,915 字节）—— Direct API 路径使用
- `/home/admin/.openclaw/workspace/SOUL.md`（21,941 字节）—— Gateway 路径使用

两者差异约 2,000 字节，主要是 §24 深度研究协议和 coding-agent 描述的差异。

**风险**：不同路径使用不同版本的系统 Prompt，可能导致行为不一致。

**建议**：统一为单一 SOUL.md，使用符号链接或在 `getSoulSystemPrompt()` 中指向 workspace 版本。

### 8.2 问题 P2：Google Gemini 缺少显式缓存（低优先级）

**现状**：Google 的 `systemInstruction` 字段没有使用 Context Caching API。Gemini 的缓存需要通过 `cachedContents.create` 预先创建缓存对象，然后在请求中引用。

**影响**：当 Gemini 作为 fallback 模型时，每次调用都会重新处理完整的系统 Prompt，无法享受缓存折扣。

**建议**：由于 Gemini 主要作为 fallback 使用，频率较低，此优化的 ROI 有限。可在 Gemini 使用频率增加时再实施。

### 8.3 问题 P3：task-planner 未使用缓存（低优先级）

**现状**：`task-planner.mjs` 中的 `PLAN_SYSTEM_PROMPT` 直接作为字符串传递，未添加 `cache_control`。

**影响**：任务规划调用不享受缓存折扣。但由于规划调用频率低（每个会话通常只有 1-2 次），影响有限。

**建议**：如果 `PLAN_SYSTEM_PROMPT` 超过 1,024 tokens，可以添加 `cache_control`。但考虑到调用频率，优先级较低。

---

## 9. 优化建议总结

| 编号 | 建议 | 优先级 | 预期收益 | 实施难度 |
|------|------|--------|----------|----------|
| O1 | 统一两个 SOUL.md 文件 | 中 | 消除行为不一致风险 | 低 |
| O2 | 添加缓存命中率监控仪表盘 | 中 | 持续追踪缓存效率 | 中 |
| O3 | 为 Gemini 实现 Context Caching | 低 | Gemini fallback 时节省成本 | 高 |
| O4 | task-planner 添加 cache_control | 低 | 规划调用节省成本 | 低 |
| O5 | 添加缓存 TTL 预热机制 | 低 | 减少冷启动频率 | 中 |

---

## 10. 结论

RangerAI 的 KV-Cache 系统 Prompt 缓存实现总体健康，核心机制正确且生产验证通过。97% 的缓存命中率和 81% 的输入成本节省率表明当前实现已经在有效工作。主要的改进方向是统一 SOUL.md 版本和建立持续的缓存效率监控。

---

*审计完成于 2026-04-04，基于 OpenClaw v2026.3.24 + RangerAI Agent v65 (Iter-59)*
