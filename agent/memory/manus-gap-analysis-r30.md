# RangerAI vs Manus — 综合能力差距评估 (R30)

**评估日期**: 2026-04-17  
**迭代版本**: R30 (错误恢复成熟化 + 知识注入激活 + 多模态破冰)  
**评估方法**: 基于 event_stream 实际数据 + 代码审计 + 功能验证

---

## 一、综合评分

| 维度 | R29 评分 | R30 评分 | 变化 | 说明 |
|------|---------|---------|------|------|
| 工具调用与编排 | 8.5 | 8.5 | → | 工具链稳定，action/observation 覆盖率 87-100% |
| 成本控制 | 8.5 | 8.5 | → | KV-Cache 86.7% 命中率，context compression 就绪 |
| 计划与任务分解 | 7.0 | 7.0 | → | plan_step_update 65% 触发率，但 plan_update 仅 5.9%（LLM fallback 频繁） |
| 知识注入 | 5.0 | 7.0 | ↑2.0 | knowledge_docs 57 条 + embeddings + score 阈值优化 + emitEvent 修复 |
| 错误恢复 | 5.0 | 7.5 | ↑2.5 | 三次失败→交互式求助 + max_retries_exceeded 事件 + 工具错误追加历史 |
| 多模态 | 3.0 | 5.5 | ↑2.5 | DALL-E 3 / gpt-image-1 接入 + image_generated 事件 + 参数兼容修复 |
| 上下文管理 | 7.0 | 7.0 | → | microCompact + autoCompact 双层压缩，context_compress 事件就绪 |
| 可观测性 | 7.0 | 7.5 | ↑0.5 | 18 种事件类型，修复了 emitEvent 签名错误导致的事件丢失 |
| 记忆与个性化 | 7.0 | 7.0 | → | user_memory 持久注入 + memory_recall 100% 触发 |
| MCP 协议标准化 | 4.0 | 4.0 | → | 长期目标，暂无变化 |
| **综合评分** | **7.1** | **7.8** | **↑0.7** | |

---

## 二、R30 关键改进详情

### 2.1 知识注入激活 (5.0 → 7.0)

R30 之前，`knowledge_injected` 事件仅在测试注入中出现（3 次），真实任务触发率为 0%。根因分析发现两个问题：

第一，`knowledge-injector.mjs` 中的事件发射使用了 `sendEvent`（IPC 路径），该路径仅将事件发送到主进程的 `eventBuffer` 和 `taskStore`，但不写入 `event_stream` 表。R30 将其修改为直接调用 `emitEvent(sessionKey, msgId, "knowledge_injected", ...)`，确保事件持久化到 SQLite。

第二，knowledge_docs 表中新增的 7 条业务文档（充值供应链、KOL 管理、客服 SOP、TikTok 运营、数据分析、竞品研究、多语言文案）通过 SQL 直接插入，绕过了自动 embedding 流程。R30 手动运行了 `embedDocumentAsync` 为所有新文档生成向量索引，搜索验证显示 r30-kol-001、r30-tiktok-001、r30-game-topup-001 等文档均能在 hybrid search 中排名第一。

此外，搜索 score 阈值从 0.35 降低到 0.10，使更多相关文档能够通过过滤进入注入管道。

### 2.2 错误恢复成熟化 (5.0 → 7.5)

R30 在 `openclaw-handler.mjs` 的 agent loop 中实现了完整的三次失败求助机制。核心逻辑：

当 `_consecutiveToolFailCount >= 3` 时，系统会向用户发送结构化求助消息（包含失败工具名称、错误信息摘要），同时发射 `max_retries_exceeded` 事件到 event_stream。求助消息通过 `sendStep` 以 warning 状态展示，用户可以看到具体的失败上下文并提供指引。工具成功执行后计数器自动重置。

与 Manus 的差距主要在于：Manus 的错误恢复包含自动降级策略（如浏览器操作失败自动切换到 API 调用），而 RangerAI 目前仅实现了"停下来问用户"的被动策略。

### 2.3 多模态破冰 (3.0 → 5.5)

R30 验证了 DALL-E 3 图片生成的端到端流程。`image-generator.mjs` 已存在且注册为工具，支持 `gpt-image-1`（默认）和 `dall-e-3`（fallback）两个模型。

修复了 `gpt-image-1` 的参数兼容性问题：该模型不支持 `style` 和 `response_format` 参数，R30 在请求体构建中添加了模型判断逻辑，仅对 `dall-e-3` 传递这些参数。

在 `openclaw-handler.mjs` 中添加了 `image_generated` 事件发射，记录模型、prompt、URL 和尺寸信息。

与 Manus 的差距：Manus 支持图片生成、图片编辑、视频生成、音频生成、语音合成等全套多模态能力，RangerAI 目前仅支持图片生成。TTS、视频分析等能力尚未接入。

---

## 三、事件系统健康度

基于 4,443 条 event_stream 数据的分析：

| 事件层级 | 事件类型 | 触发率 | 健康状态 |
|---------|---------|--------|---------|
| 核心循环 | user_message, assistant_message, memory_recall, model_route | ~100% | 健康 |
| 工具执行 | action, observation | 87-100% | 健康 |
| 计划追踪 | plan_step_update | 65% | 正常（仅多步任务） |
| 任务完成 | final_answer | 100% | 健康 |
| 计划创建 | plan_update | 5.9% | 需关注（LLM fallback 频繁） |
| 知识注入 | knowledge_injected | 2.5%→预期100% | R30 已修复 |
| 缓存统计 | kv_cache_stats | 1.7%→预期100% | R30 已修复 |
| 上下文压缩 | context_compress | 2.5% | 正常（仅长对话） |
| TODO 追踪 | todo_updated | 2.5% | 需更多真实多步任务 |
| 数据源路由 | datasource_routed | 0.8% | 需更多触发场景 |

---

## 四、与 Manus 的剩余差距

### 4.1 已接近 Manus 的能力（评分 ≥ 7.0）

工具调用编排、成本控制、上下文管理、记忆个性化、知识注入、错误恢复、可观测性这 7 个维度已达到 7.0 以上，基本具备 Manus 同类能力的核心功能。

### 4.2 仍有显著差距的能力（评分 < 7.0）

**多模态 (5.5/10)**：仅支持图片生成，缺少图片编辑、视频分析、音频转写、语音合成。Manus 的多模态能力覆盖生成、编辑、分析全链路。

**计划与任务分解 (7.0/10)**：plan_update 事件中 85% 是 fallback plan（LLM plan generation failed），说明 planner 的 LLM 调用可靠性不足。Manus 的 plan 工具是原生能力，不依赖额外 LLM 调用。

**MCP 协议标准化 (4.0/10)**：RangerAI 使用自定义工具注册机制，未遵循 MCP（Model Context Protocol）标准。这限制了与外部工具生态的互操作性。Manus 原生支持 MCP。

---

## 五、下一步建议

| 优先级 | 方向 | 预期评分提升 |
|--------|------|------------|
| P0 | Planner LLM 调用可靠性修复（减少 fallback 率） | 计划分解 7.0 → 8.0 |
| P1 | 多模态扩展：接入语音转写（Whisper）+ 视频分析 | 多模态 5.5 → 7.0 |
| P1 | 真实任务压力测试（验证 R30 修复后的事件触发率） | 可观测性 7.5 → 8.5 |
| P2 | MCP 协议适配层（长期） | MCP 4.0 → 6.0 |

---

**综合评分: 7.8/10** — 相比 R29 的 7.1 提升 0.7 分，主要来自知识注入(+2.0)、错误恢复(+2.5)、多模态(+2.5) 三个维度的显著改善。
