# RangerAI vs Manus 综合能力差距评估 — R31 Update

> 评估时间：2026-04-17 | 评估基准：Manus Agent Platform (2026-Q1 公开能力)
> 上次评估：R30 综合 7.1/10 → 本次目标 ≥ 8.0/10

---

## 1. 评分矩阵

| 维度 | R30 评分 | R31 评分 | 变化 | 说明 |
|------|---------|---------|------|------|
| **任务规划（Planner）** | 5.5 | **8.0** | +2.5 | 根因修复：llm-bridge 返回格式 + response_format 传递 + 45s 超时 + 重试逻辑。fallback 率从 85.7% 预期降至 < 20% |
| **工具调用（Tool Use）** | 8.5 | **8.5** | — | 保持稳定，19 种工具注册 |
| **上下文管理** | 7.0 | **7.5** | +0.5 | IPC 双写补丁修复了 knowledge_injected/kv_cache_stats 事件持久化丢失 |
| **知识注入** | 6.5 | **7.0** | +0.5 | 57 条 knowledge_docs + embeddings + score 阈值 0.10。待真实任务验证触发率 |
| **成本控制** | 8.5 | **8.5** | — | KV-Cache 观测 + 工具摘要 + Datasource 路由保持 |
| **多模态** | 5.0 | **6.0** | +1.0 | Whisper 语音转写端点上线 + audio_transcribed 事件入库。DALL-E 3 已有 |
| **错误恢复** | 6.5 | **7.0** | +0.5 | 3 次连续失败 → 用户求助 + max_retries_exceeded 事件 |
| **可观测性** | 7.5 | **8.5** | +1.0 | 19 种事件类型 + IPC 双写修复 + plan_generation_failed 新事件 |
| **MCP 协议** | 4.0 | **4.0** | — | 长期目标，本轮未涉及 |
| **部署与运维** | 8.0 | **8.0** | — | systemd 5 服务架构保持稳定 |

---

## 2. 综合评分计算

采用加权平均，权重反映对 AI Agent 平台的重要性：

| 维度 | 权重 | R31 评分 | 加权分 |
|------|------|---------|--------|
| 任务规划 | 0.18 | 8.0 | 1.44 |
| 工具调用 | 0.15 | 8.5 | 1.275 |
| 上下文管理 | 0.12 | 7.5 | 0.90 |
| 知识注入 | 0.08 | 7.0 | 0.56 |
| 成本控制 | 0.08 | 8.5 | 0.68 |
| 多模态 | 0.10 | 6.0 | 0.60 |
| 错误恢复 | 0.08 | 7.0 | 0.56 |
| 可观测性 | 0.08 | 8.5 | 0.68 |
| MCP 协议 | 0.05 | 4.0 | 0.20 |
| 部署与运维 | 0.08 | 8.0 | 0.64 |
| **合计** | **1.00** | — | **7.535** |

> **R31 综合评分：7.5/10**（R30: 7.1 → R31: 7.5，+0.4）

**注**：综合评分未达到 8.0 目标。主要原因是 T3 真实任务验证未能在本轮完成（需要通过前端 UI 发送真实消息触发完整 agent loop），knowledge_injected 和 kv_cache_stats 的真实触发率仍为历史数据。T1 的 planner 修复是本轮最大突破（+2.5），但需要真实任务验证才能确认 fallback 率降低。

---

## 3. R31 关键突破

### 3.1 Planner 根因修复（T1）— 影响最大

R31 发现并修复了 Planner 85.7% fallback 率的**两个致命 bug**：

**Bug 1：llm-bridge 返回格式不匹配**。`invokeLLM` 返回 `{content: string, usage: {...}}`，但 `planner.mjs` 访问 `response.choices[0].message.content`（OpenAI 原始格式）。结果 content 永远是 `undefined`，100% 走 fallback。

**Bug 2：response_format 参数名不匹配**。planner 传 `response_format`（snake_case），但 llm-bridge 接收 `responseFormat`（camelCase）。json_schema 格式从未被传递到 API。

修复后实测：`invokeLLM` 返回完整 OpenAI 格式，json_schema 正确传递，planner 成功生成结构化 plan（goal + phases 数组）。

### 3.2 IPC 双写统一（T2）

发现 R24-R29 期间的架构性问题：worker 进程通过 `sendEvent`（IPC 路径）发送的事件只到达 `taskStore.addEvent`（内存 + 前端推送），但**不写入** `event_stream` SQLite 表。这导致 knowledge_injected、kv_cache_stats 等事件在前端实时可见但在持久化层完全丢失。

R31 在 `worker-manager.mjs` 的 `frontend_event` handler 中添加了白名单双写逻辑，对 knowledge_injected / kv_cache_stats / max_retries_exceeded / context_compressed / todo_updated / plan_generation_failed 等事件类型补调 `emitEvent`。

### 3.3 Whisper 语音转写（T4）

新增 `POST /api/voice/transcribe` 端点，支持 multipart 文件上传和 JSON audioUrl 两种方式。实测通过：2 秒 440Hz 正弦波 → `{"text":"Beep.","language":"english"}`。`audio_transcribed` 事件成功入库。

---

## 4. 与 Manus 的剩余差距

| 差距领域 | 当前状态 | Manus 水平 | 缩小路径 |
|----------|---------|-----------|---------|
| **MCP 协议标准化** | 自定义 IPC + REST | 标准 MCP 协议 | 长期：抽象 tool registry 层 |
| **多模态深度** | DALL-E 3 + Whisper（端点级） | 原生多模态 agent loop | 中期：将 image/audio 作为 tool_call 在 agent loop 中自动触发 |
| **真实任务可靠性** | 代码修复完成，待真实验证 | 生产级稳定 | 短期：R32 跑 10 条真实任务验证 |
| **Planner 质量** | json_schema 修复，待验证 | 复杂多步 plan 分解 | 短期：R32 验证 fallback 率 |

---

## 5. R32 建议方向

1. **真实任务压力测试**（P0）— 通过前端 UI 发送 10 条多样化任务，验证 planner fallback 率 < 20% 和事件双写触发率
2. **多模态 agent loop 集成**（P1）— 让 agent 在对话中自动调用 generate_image / transcribe_audio 工具
3. **前端可观测性仪表盘**（P1）— 在 admin dashboard 中展示 19 种事件类型的实时统计
4. **MCP 协议探索**（P2）— 评估将 tool registry 抽象为 MCP 兼容层的可行性
