# RangerAI R32 迭代任务书

> 发布时间：2026-04-17 | 定调：真实任务压力测试 + 多模态 agent loop 集成
> 前置迭代：R31（Planner 可靠性修复 + 事件双写统一）| 综合评分：7.5/10 → 目标 ≥8.0/10

---

## 背景与承接

R31 的两个最大修复（Planner 双 bug 根修 + IPC 双写统一）均处于"代码通过，待真实验证"状态。
R32 的核心任务是将 R31 的代码修复转化为**可观测的真实信号**，同时推进多模态能力进入 agent loop。

**R31 遗留项（P0 级，R32 必须消化）：**
- T3 真实任务验证未完成 → R32-T1 承接
- Planner fallback 率待真实验证 → R32-T2 承接

---

## 最低 DoD（发布门槛）

> **T1 + T2 同时通过 = R32 可发布**

---

## 任务清单

### T1 — P0 | Agent Loop HTTP 触发接口 + 真实任务压力测试

**背景**：R31 T3 失败的直接原因是"无法通过 API 直接发送用户消息触发 agent loop"，
只能通过前端 UI 或 DingTalk 触发。这使得自动化验证不可能完成。

**任务目标**：
1. 在 `api/` 下新增或修复 `POST /api/chat/send` 端点，接受 `{ userId, message, sessionId? }`，可直接在 server 端触发 agent loop（等价于前端发消息）。
2. 编写压力测试脚本 `scripts/r32-pressure-test.sh`，通过该端点发送 10 条多样化任务（含知识库检索、网页查询、代码分析等类型）。
3. 等待 agent loop 完成后，查询 event_stream 统计触发率。

**验收条件（DoD）**：
- `POST /api/chat/send` 返回 200，并在 event_stream 中产生对应 `user_message` 事件
- 10 条任务全部触发后：`knowledge_injected` 事件 ≥6 条（较 R31 基线 +3 条）
- 10 条任务全部触发后：`kv_cache_stats` 事件 ≥8 条（较 R31 基线 +6 条）
- event_stream 总条数相比 R31 基线（4446）增长 ≥100 条

**参考文件**：
- `modules/http-router.mjs` — 路由挂载位置
- `modules/RangerAI-handler.mjs` — agent loop 入口（handleUserMessage 或等价函数）
- `worker/event-stream.mjs` — emitEvent API
- `worker/knowledge-injector.mjs` — 知识注入逻辑

---

### T2 — P0 | Planner Fallback 率运行时验证

**背景**：R31 修复了 planner 100% fallback 的两个致命 bug，但截至 R31 验收时
event_stream 中无新的 `plan_update` 或 `plan_generation_failed` 事件，无法确认修复效果。

**任务目标**：
1. 在 T1 的 10 条真实任务跑完后，统计 `plan_update` 和 `plan_generation_failed` 的新增数量。
2. 若 fallback 率仍 ≥20%，诊断根因并修复。

**验收条件（DoD）**：
- T1 任务完成后，新增 `plan_update` 事件 ≥5 条（说明 planner 真实被调用）
- `plan_generation_failed / (plan_update + plan_generation_failed) < 20%`（fallback 率目标）
- 若失败：提供诊断日志 + 修复 diff，并重跑 T1 的至少 3 条任务验证

**验证命令**（参考）：
```bash
node --input-type=module << 'EOF'
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const db = req('better-sqlite3')('/opt/rangerai-agent/db/rangerai.db', { readonly: true });
const rows = db.prepare(`
  SELECT event_type, COUNT(*) as cnt
  FROM event_stream
  WHERE event_type IN ('plan_update', 'plan_generation_failed')
  GROUP BY event_type
`).all();
console.log(JSON.stringify(rows));
db.close();
EOF
```

---

### T3 — P1 | 多模态 Agent Loop 集成（Image + Audio 作为 tool_call）

**背景**：R31 已接入 DALL-E 3（图像生成）和 Whisper（语音转写），但两者均为独立 API 端点，
未集成进 agent loop 的 tool_call 机制。Manus 的多模态能力是在 agent loop 中原生调用的。

**任务目标**：
1. 在 agent 的工具注册表中新增 `generate_image` 和 `transcribe_audio` 两个工具。
2. agent loop 识别到相关意图时，自动发起 tool_call，调用已有的 `/api/image/generate` 和 `/api/voice/transcribe` 逻辑。
3. tool_call 结果作为 `observation` 事件写入 event_stream，并在前端 task timeline 中展示。

**验收条件（DoD）**：
- 工具注册表（`worker/tool-registry.mjs` 或等价文件）中存在 `generate_image` 和 `transcribe_audio` 定义
- 发送"帮我画一张风景图"类消息后，event_stream 中产生 `action`（tool_call）+ `observation`（图片 URL）事件
- 发送音频文件后，event_stream 中产生 `audio_transcribed` 事件（通过 agent loop 触发，非直接调用）
- 对应事件的 `metadata.tool` 字段值为 `generate_image` / `transcribe_audio`

**参考文件**：
- `worker/tool-executor.mjs`（或等价）— 工具执行层
- `api/image-api.mjs` — 现有图像生成逻辑
- `api/voice-api.mjs:204` — 现有语音转写逻辑

---

### T4 — P1 | Admin Dashboard 可观测性：事件统计 Tab

**背景**：目前 event_stream 有 19 种事件类型、4,446 条记录，但前端 Admin Dashboard 没有对应的可视化入口。运维和调试时只能查 SQLite，不利于生产监控。

**任务目标**：
在 Admin Dashboard（前端 `/admin` 页面）新增 **EventStats** Tab，展示：
1. 各事件类型的总数量（柱状图或表格）
2. 最近 24h / 7d 的事件趋势折线图（按小时聚合）
3. 最后 10 条事件的实时列表（event_type / task_id / created_at）

**技术说明**：
- 后端：在 `api/admin-api.mjs`（或等价）新增 `GET /api/admin/event-stats?period=24h|7d` 端点
- 前端：在 Admin Dashboard 页面（`/opt/rangerai-web/client/src/pages/AdminDashboard.tsx` 或等价）新增 Tab
- 前端构建完成后执行 `bash /opt/rangerai-agent/deploy-frontend.sh` 部署

**验收条件（DoD）**：
- `GET /api/admin/event-stats` 返回 200，响应包含 `eventTypes`（数组）+ `timeline`（按小时）+ `recent`（最近 10 条）
- 前端 `/admin` 页面可见 EventStats Tab，无白屏/报错
- Tab 中展示的事件类型总数 ≥ 15 种（当前 19 种，允许未来变化）

---

### T5 — P2 | Manus Gap Analysis R32 更新

**任务目标**：
基于 R32 实际完成情况，更新 `memory/manus-gap-analysis-r31.md`（另存为 `manus-gap-analysis-r32.md`），重新计算各维度评分和综合评分。

**验收条件（DoD）**：
- `memory/manus-gap-analysis-r32.md` 文件存在
- 综合评分 **≥ 8.0/10**（T1+T2 完成后，任务规划评分应从 8.0 → 8.5，知识注入从 7.0 → 7.5+）
- 文件包含"R32 新增能力"章节，说明 T1-T4 的实际交付内容

---

## 任务依赖关系

```
T1（agent loop 接口 + 压测）
  └─→ T2（基于 T1 产生的事件统计 fallback 率）
       └─→ T5（基于 T1+T2 结果更新评分）

T3（多模态 tool_call）— 可与 T1/T2 并行
T4（Admin Dashboard）— 可与 T1 并行，但需 T1 的事件数据才能测试完整效果
```

**执行顺序建议**：
1. 先完成 T1（含 agent loop 接口开发 + 压测脚本）
2. T1 压测完成后立即执行 T2 验证（直接读 event_stream）
3. T3 和 T4 可在 T1 开发期间并行推进
4. T5 最后执行

---

## 关键约束

1. **不要修改 openclaw-gateway 相关代码**
2. **backend 修改后必须 `node --check <文件>` 语法检查**
3. **agent loop 接口不能绕过认证中间件**（若现有 `/api/chat/*` 需 token，新接口应复用相同机制）
4. **前端修改后必须 `bash /opt/rangerai-agent/deploy-frontend.sh` 重新部署**
5. **每个 Task 完成后，在 `memory/iter-r32-acceptance.md` 追加对应 Task 的验收记录**

---

## 验收方式

完成后请输出 `memory/iter-r32-acceptance.md`，格式参考 R31：
- 每个 Task 的状态（通过 / 部分通过 / 未通过）
- 关键证据（命令输出截图或文字）
- 修改文件清单
- 遗留问题（若有）

---

## 参考基线（R31 部署后）

| 指标 | R31 基线值 |
|------|-----------|
| event_stream 总条数 | 4,446 |
| knowledge_injected | 3 |
| kv_cache_stats | 2 |
| audio_transcribed | 1 |
| plan_update | 7 |
| plan_generation_failed | 0 |
| 综合评分 | 7.5/10 |
| 事件类型种数 | 19 |
