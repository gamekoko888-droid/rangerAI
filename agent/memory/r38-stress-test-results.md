# R38-T5 混合压测结果

## 测试配置
- 总任务数: 50 条
- 分类: 15 单步 + 15 代码执行 + 10 浏览器 + 10 多步
- 发送间隔: 8 秒/条
- 发送方式: 串行

## 结果汇总

| 指标 | 数值 | 说明 |
|------|------|------|
| 发送总数 | 50 | — |
| 进入处理 | 22 | 28 条被 MAX_CONCURRENT_TASKS=3 拒绝 |
| final_answer | 22/22 | **100%** (已接受任务) |
| final_answer (含 task-session) | 89 | 包含 Gateway 侧 ID |
| code_exec_started | 24 | 含多步任务中的代码步骤 |
| browser_action_detail | 20 | 含多步任务中的浏览器步骤 |
| plan_update | 108 | plan_update/msg = 1.23 |
| sandbox_limit_exceeded | 24 | CPU 超时记录 |

## 并发限制分析

**根因**: `modules/worker-manager.mjs` 第 1467 行:
```javascript
const MAX_CONCURRENT_TASKS = _deps.MAX_CONCURRENT_TASKS || 3;
```

当 pendingTasks.size >= 3 时，新任务被直接拒绝（throw Error）。
8 秒间隔不够等前一个任务完成，导致约 56% 的任务被拒绝。

**模式**: 每 2-3 条成功后，后续 2-3 条被拒绝（取决于前面任务的处理时间）。

## 多步子集

| 任务 | 状态 |
|------|------|
| #41 Python版本验证 | ✅ |
| #42 浏览器+Python | ❌ (并发拒绝) |
| #43 历史事件搜索 | ❌ (并发拒绝) |
| #44 随机数统计 | ✅ |
| #45 Lootbar搜索 | ✅ |
| #46 httpbin JSON | ❌ (并发拒绝) |
| #47 质数分布 | ❌ (并发拒绝) |
| #48 AI游戏应用 | ✅ |
| #49 密码SHA256 | ✅ |
| #50 链接结构分析 | ❌ (并发拒绝) |

多步子集: 5/10 = 50% (受并发限制影响)
多步子集(已接受): 5/5 = **100%**

## 诚实声明

- 22/50 的通过率是因为并发限制，不是能力问题
- 已接受任务的 final_answer 率为 100%
- 并发限制是 R39 需要解决的问题（任务队列+背压）
- 建议将 MAX_CONCURRENT_TASKS 提高到 5-8 或实现任务队列
