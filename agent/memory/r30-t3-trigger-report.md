# R30-T3 触发率报告

**生成时间**: 2026-04-17T10:48:00Z  
**数据来源**: event_stream (db/rangerai.db)

## 1. 事件总览

| 事件类型 | 总计数 | 覆盖任务数 | 触发率(119真实任务) |
|----------|--------|-----------|-------------------|
| user_message | 770 | 419 | 100% (core) |
| action | 720 | 121 | ~100% |
| observation | 675 | 103 | ~87% |
| memory_recall | 634 | 292 | ~100% |
| model_route | 618 | 296 | ~100% |
| assistant_message | 614 | 292 | ~100% |
| plan_step_update | 193 | 77 | ~65% |
| final_answer | 119 | 119 | 100% |
| notify | 74 | 0 | N/A (system) |
| **plan_update** | **7** | **7** | **5.9%** |
| **context_compress** | **6** | **3** | **2.5%** |
| **knowledge_injected** | **3** | **3** | **2.5%** |
| **todo_updated** | **3** | **3** | **2.5%** |
| **kv_cache_stats** | **2** | **2** | **1.7%** |
| supervisor_block | 2 | 1 | 0.8% |
| datasource_routed | 1 | 1 | 0.8% |
| browser_fallback | 1 | 1 | 0.8% |
| web_task_routing | 1 | 1 | 0.8% |

## 2. 核心发现

### 高频事件（>50% 触发率）— 正常运行
- `user_message`, `assistant_message`, `memory_recall`, `model_route`: 核心 agent loop 事件，触发率接近 100%
- `action`, `observation`: 工具调用事件，87-100% 触发率
- `plan_step_update`: 65% 触发率（多步任务才触发）
- `final_answer`: 100% 完成率

### 低频事件（<10% 触发率）— 需要关注
1. **plan_update (5.9%)**: 7 次中 6 次是 fallback（LLM plan generation failed），仅 1 次是正常生成。说明 planner 的 LLM 调用频繁失败，但 fallback 机制保证了任务继续执行。
2. **knowledge_injected (2.5%)**: 3 次全部来自测试注入。**根因已修复**：sendEvent (IPC) 不写入 event_stream，已改为 emitEvent。
3. **kv_cache_stats (1.7%)**: 2 次。**根因已修复**：emitEvent 调用缺少 sessionKey 参数。
4. **todo_updated (2.5%)**: 3 次来自测试。需要更多真实多步任务触发。
5. **context_compress (2.5%)**: 6 次/3 任务。仅在长对话中触发，属于正常低频。

## 3. 修复措施（R30 已实施）

| 问题 | 修复 |
|------|------|
| knowledge_injected 不写入 event_stream | 改用 emitEvent(sessionKey, msgId, ...) 替代 sendEvent(IPC) |
| kv_cache_stats emitEvent 签名错误 | 添加 sessionKey 参数 |
| knowledge_docs 缺少 embeddings | 手动运行 embed 脚本为 7 条 r30 文档生成 embeddings |
| knowledge search score 阈值过高 (0.35) | 降低到 0.10 |

## 4. 预期改善

修复后，下一轮真实任务应该看到：
- `knowledge_injected` 触发率从 2.5% → **~100%**（每条消息都会注入 knowledge_entries）
- `kv_cache_stats` 触发率从 1.7% → **~100%**（每次 LLM 调用都有 cache stats）
- `plan_update` 保持 ~5-10%（仅首次创建 plan 时触发，后续通过 plan_step_update 追踪）

## 5. 统计摘要

- **总事件数**: 4,443
- **唯一会话数**: 308
- **唯一任务数**: 431
- **已完成任务**: 119/126 (94.4% 完成率)
- **平均事件/任务**: ~10.3
