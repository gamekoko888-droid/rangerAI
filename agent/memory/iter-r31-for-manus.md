# R31 任务书 — Planner 可靠性修复 + 事件双写统一

**生成时间**: 2026-04-17  
**前置迭代**: R30 (错误恢复成熟化 + 知识注入激活 + 多模态破冰)  
**核心定调**: 能力质量提升 — 修复 Planner 85% fallback 率 + 消除 IPC/event_stream 双写不一致

---

## 任务矩阵

| Task | 优先级 | 标题 | DoD |
|------|--------|------|-----|
| **T1** | P0 | Planner LLM 可靠性修复 | fallback 率 < 20%（10次调用 ≥8次命中 json_schema） |
| **T2** | P0 | worker-manager IPC 双写补丁 | sendEvent 路径的 knowledge_injected 写入 event_stream |
| **T3** | P1 | 真实任务验证（10条） | knowledge_injected ≥6/10，kv_cache_stats ≥8/10 |
| **T4** | P1 | Whisper 语音转写接入 | audio_transcribed 事件入库 |
| **T5** | P2 | manus-gap-analysis R31 更新 | 综合评分 ≥ 8.0/10 |

**最低 DoD**: T1 + T2 同时通过才可发布。

---

## 执行计划

### T1: Planner LLM 可靠性修复（三步）

**问题根因**: R30 触发率报告显示 plan_update 7 次中 6 次是 fallback（85.7% fallback 率），说明 planner 的 LLM 调用频繁失败。

**Step 1**: `llm-bridge.mjs` DEFAULT_TIMEOUT 15000 → **45000**（Planner json_schema 请求慢，需要更长超时）

**Step 2**: `planner.mjs` invokeLLM 加重试逻辑（max 2 次，间隔 2s）。在 `generatePlan` 函数的 LLM 调用处包裹重试：
```js
async function invokeLLMWithRetry(params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await invokeLLM(params);
    } catch (err) {
      if (attempt < maxRetries) {
        logger.warn(`[planner] LLM attempt ${attempt+1} failed: ${err.message}, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      } else throw err;
    }
  }
}
```

**Step 3**: fallback 时发射独立 `plan_generation_failed` 事件，带 `failureReason` 字段：
```js
emitEvent(sessionKey, taskId, 'plan_generation_failed', {
  failureReason: err.message,
  attempt: retryCount,
  fallbackUsed: true
});
```

### T2: worker-manager IPC 双写补丁

**问题根因**: R30 发现 `sendEvent`（IPC 路径）仅写入 `eventBuffer` + Redis `taskStore`，不写入 `event_stream` SQLite 表。

**修复方案**: 在 `worker-manager.mjs` 的 `frontend_event` handler 中，对白名单事件类型补调 `emitEvent`：
```js
const DUAL_WRITE_EVENTS = [
  'knowledge_injected', 'kv_cache_stats', 'max_retries_exceeded',
  'context_compress', 'todo_updated', 'datasource_routed',
  'image_generated', 'audio_transcribed'
];

if (DUAL_WRITE_EVENTS.includes(msg.event?.type)) {
  emitEvent(msg.sessionKey || 'unknown', msg.msgId, msg.event.type, msg.event);
}
```

### T3: 真实任务验证

部署 T1+T2 后，通过钉钉 ACP 或前端发送 10 条多样化任务，统计：
- knowledge_injected 触发率（目标 ≥6/10）
- kv_cache_stats 触发率（目标 ≥8/10）
- plan_update 非 fallback 率（目标 ≥80%）

### T4: Whisper 语音转写接入

检查现有 voice transcription 能力，确保 `audio_transcribed` 事件在转写完成后入库。

### T5: 差距评估更新

更新 manus-gap-analysis.md，目标综合评分 ≥ 8.0/10。

---

## 预期评分变化

| 维度 | R30 | R31 预期 | 变化 |
|------|-----|---------|------|
| 计划与任务分解 | 7.0 | 8.0 | ↑1.0 (fallback 率下降) |
| 可观测性 | 7.5 | 8.5 | ↑1.0 (双写统一) |
| 多模态 | 5.5 | 6.5 | ↑1.0 (Whisper 接入) |
| **综合** | **7.8** | **8.2** | **↑0.4** |
