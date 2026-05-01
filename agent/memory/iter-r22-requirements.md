# R22 任务书 v1.1（修订版）

基线：R21 已验收通过（5/5 PASS，综合评分 7.7/10）
时间：2026-04-16
版本：v1.1（基于 v1.0 审阅修订，9 处关键变更）
核心主题：**网页任务生产化闭环 + 失败分流治理 + 任务回放 + 质量归因统一收口**

---

## 一、R22 定调

R21 解决的是：系统终于能把一次真实任务跑通，并且管理侧第一次拥有 Escalation 操作与统一 KPI 入口。

**R22 不允许继续停留在"能演示"。**

从这一轮开始，网页任务链路必须从"样板能力"升级为"生产能力"。如果 R22 结束后仍然出现以下状态，则视为本轮失败：

- 该走 browser 的任务仍然大量没走 browser
- browser 失败后没有明确 fallback，主链路直接断掉
- 有 evidence 但无法按任务时间线回放
- 失败任务无法归因为 planner / browser / page_state / policy 中的某一层
- 成功率、降级率、失败原因仍分散在多个接口里，管理层无法一眼判断系统质量

**一句话：R22 不是补功能，是把网页任务链路收敛成可运营、可复盘、可优化的正式能力。**

---

## 二、R21 遗留处置

R21 验收通过后留有 4 条遗留注记。以下逐条说明处置方式：

| 遗留项 | 处置 | 原因 |
|--------|------|------|
| Escalation RBAC 权限控制 | **延期至 R23+** | R22 聚焦网页任务链路生产化，RBAC 属于 Supervisor 精细化治理，与本轮主线无交集 |
| OverviewTab 组件统一（消除内联/外部双重存在） | **延期至 R23+** | 纯前端重构，不影响 R22 的后端链路建设，可在 R23 前端治理轮统一处理 |
| 真实数据清洗工具 | **延期至 R23+** | 需要先有 R22 的 task-replay 和 quality-summary 数据沉淀，才有清洗目标 |
| hint adoption 时间窗口分析 | **延期至 R23+** | 依赖更多真实任务数据积累，R22 的 golden tasks 完成后才有足够样本 |

> **R22 选择优先做网页任务链路的原因**：当前系统最大的生产化缺口不在 Supervisor 精细化或前端治理，而在于网页任务从识别到执行到回放的整条链路尚未闭环。这是阻碍系统从"能演示"到"能运营"的最短板。

---

## 三、R22 核心目标

R22 只做 4 件事，但这 4 件事必须做透：

1. **稳定触发**：网页类任务必须被稳定识别并优先走正确工具链
2. **失败治理**：Browser 失败必须进入分类、降级、留痕流程
3. **任务回放**：任何关键网页任务都必须能按时间线复盘
4. **质量归因**：管理层必须能看到成功、降级、失败分别因为什么发生

**目标评分**：综合 Manus 差距 7.7/10 → **8.5/10**（上下文路由 +0.4、失败治理 +0.4）

---

## 四、R21 之后残留的系统缺陷

即便 R21 全部通过，系统仍残留以下缺陷。R22 必须逐项消灭。

**缺陷 1：网页任务识别不稳定。** 现在最多只能证明 browser"被用过"，不能证明网页任务"被稳定识别并正确路由"。同类任务今天走 browser，明天走 web_fetch，后天直接文本回答，系统行为不可预测。

**缺陷 2：Browser 失败没有进入制度化治理。** navigate 失败、元素缺失、页面超时、抽取为空、登录墙拦截，这些都属于生产常态。没有 failure taxonomy + fallback policy，Browser 就只是一个脆弱工具，不是生产能力。

**缺陷 3：证据是散的，不是任务级回放。** 日志、trace、screenshot、evidence 分散存在，验收人无法快速回答："这个任务到底按什么计划执行了什么动作、卡在哪一步、最后为什么成功/失败？"

**缺陷 4：Supervisor 有 decision，没有统一归因。** 有 approve / reject / escalate 不等于有质量治理。必须把失败归因拉平：到底是规划选错、执行失败、页面环境变化、还是策略误判。

**缺陷 5：Golden task 仍然偏成功样本。** 只有成功样本几乎没有价值。生产系统需要成功 / 降级 / 失败三类样本的最小回归集。

---

## 五、执行顺序与依赖关系

> **强制串行执行：T1a → T1b → T2 → T3 → T4 → T5 → T6**
> 禁止跳过前置任务直接开发后置任务。

```
T1a（P0）─→ T1b（P1）─→ T2（P0）─→ T3（P0）─→ T4（P1）─→ T5（P1）─→ T6（P2）
  │                         │            │
  │ T1a 输出 taskFamily     │ T2 输出    │ T3 消费 T2 的
  │ 字段，T1b 才能聚合      │ failure    │ failure 字段做
  │                         │ 字段       │ replay timeline
  └─────────────────────────┴────────────┘
```

---

## 六、任务拆解

### T1a（P0，必须完成）— 网页任务族字段落库

**依赖**：无前置依赖
**目标**：在 Planner / routing 层输出 web task family 字段并持久化，建立最小可行的任务分类能力。

**硬性要求**：

1. 在 Planner / routing 层定义明确的 web task family，至少包括：
   - `page_lookup`
   - `page_extract`
   - `site_navigation`
   - `web_verification`

2. 对网页任务建立明确路由规则：
   - 页面打开、站内跳转、页面核验、元素交互 → **优先 browser**
   - 纯信息检索、无需交互 → 可走 `web_search` / `web_fetch`
   - **禁止**网页交互类任务直接走"纯文本回答"作为主路线

3. 在 event_stream 或 task trace 中持久化以下字段：
   - `taskFamily`
   - `routingReason`
   - `selectedPrimaryTool`

4. 上述字段必须在至少 1 个真实任务的 trace 中可见。

**验收标准（全部必须满足）**：
- `taskFamily` 字段在 event_stream 或 trace 中有值
- `routingReason` 字段非空
- `selectedPrimaryTool` 字段非空
- 至少 1 个网页交互任务在 trace 中可见 `selectedPrimaryTool=browser`

**不通过情形**：
- 字段定义了但没有落库
- 字段落库了但全部为空或 null
- 网页交互任务仍然可以无告警地走纯文本回答

---

### T1b（P1，强烈建议完成）— 网页任务独立统计口径

**依赖**：T1a 必须完成（需要 taskFamily 字段已落库）
**目标**：基于 T1a 落库的字段，建立独立的网页任务统计聚合能力。

**硬性要求**：

1. 新增独立统计指标：
   - `webTaskCount`
   - `webTaskBrowserRate`
   - `webTaskSearchRate`
   - `webTaskDirectAnswerRate`
   - `webTaskMissedBrowserCases`

2. 提供统计接口或在 dashboard-overview 中聚合输出。

3. 增加 missed-opportunity 归因：
   - 本应 browser 却没走 browser 的 case 必须被记录和统计
   - 至少输出 3 类 `missedBrowserCases` 归因标签

**验收标准**：
- 有独立 web task family 统计接口或聚合输出
- `webTaskCount > 0`
- `webTaskBrowserRate` 非空
- `webTaskDirectAnswerRate` 可见
- 至少输出 3 类 `missedBrowserCases` 归因标签

**不通过情形**：
- 仍无法区分网页任务与普通信息检索任务
- 仍无法统计本应 browser 却未触发 browser 的案例

---

### T2（P0，必须完成）— Browser 失败分流与降级闭环

**依赖**：T1a 必须完成（需要 taskFamily 和 selectedPrimaryTool 字段）
**目标**：Browser 失败时，系统必须进入制度化治理，而不是直接崩溃或静默失败。

**硬性要求**：

1. 建立统一 failure taxonomy，至少包括：
   - `navigate_failed`
   - `element_not_found`
   - `extract_empty`
   - `timeout`
   - `blocked_or_auth_required`
   - `unexpected_page_state`

2. 为每类 failure 定义默认 fallback policy：
   - `navigate_failed` → 可回退 `web_fetch` / `web_search`（若任务允许）
   - `element_not_found` → 截图 + DOM 摘要 + 允许 replan
   - `extract_empty` → 尝试 text fallback
   - `timeout` → 标记 `retryable=true`
   - `blocked_or_auth_required` → 明确标记不可自动继续
   - `unexpected_page_state` → 留痕并触发 Supervisor review

3. 在 trace / replay / supervisor 中统一输出：
   - `failureStage`
   - `failureReason`
   - `fallbackAction`
   - `retryable`
   - `degradedSuccess`

4. 所有 fallback 必须可追溯：
   - 原计划是什么
   - 为什么失败
   - 为什么切到 fallback
   - fallback 后结果是什么

**验收标准（全部必须满足）**：
- 至少 4 类 Browser failure reason 在接口输出中可见
- 至少 1 个任务发生 fallback 且主任务未崩溃
- 至少 1 个任务被标记为 `degradedSuccess=true`
- task trace / replay 中可见 `fallbackAction`
- `blocked_or_auth_required` 不再被误判成普通失败

**不通过情形**：
- Browser 失败后主链路直接中断无留痕
- fallback 存在但看不到触发原因
- 降级完成与正常成功混为一谈（**禁止**把 `degraded_success` 统计进 `success`）

---

### T3（P0，必须完成）— 任务级回放 API（task replay）

**依赖**：T2 必须完成（需要 failure 字段和 fallback 记录）
**目标**：把散落的 evidence、trace、decision 收口成任务级时间线回放。

**硬性要求**：

1. 新增统一回放接口：
   - `GET /api/admin/task-replay?taskId=xxx`

2. 返回结构必须至少包含：
   - task 基本信息（taskId / sessionKey / taskFamily / finalStatus）
   - planner 摘要（计划、主工具选择、reason）
   - browser 时间线（navigate / click / extract / screenshot）
   - supervisor review / decision
   - fallback 记录（原计划 / 失败原因 / fallback 动作 / fallback 结果）
   - final output 摘要

3. timeline item 至少包括：
   - `stepIndex`
   - `timestamp`
   - `kind`
   - `summary`
   - `status`
   - `evidenceRef`（必须可链接到原始 evidence，不是空字符串）

4. 成功任务必须能看到：
   - final page title 或 textSnippet

5. 失败/降级任务必须能看到：
   - failureReason
   - fallbackAction（若存在）
   - finalStatus = failed / degraded_success

6. **replay / evidence / trace 互跳**：
   - `evidenceRef` 必须是可访问的链接或 ID
   - 从 replay 可跳转到对应的 evidence 详情
   - 从 replay 可跳转到对应的 trace 记录

**验收标准（全部必须满足）**：
- 至少 1 个成功任务可完整回放
- 至少 1 个降级成功任务可完整回放
- 至少 1 个失败任务可完整回放
- replay API 的 `timeline.length > 0`
- replay 中可见 planner → browser → supervisor → final output 的串联痕迹
- **30 秒可读标准**：验收人能在 30 秒内通过 replay 回答"这个任务做了什么、卡在哪一步、最终结果是什么"。如果需要翻原始日志才能回答，则 replay 不合格。

**不通过情形**：
- replay 只是简单拼日志（原始日志堆砌不算 replay）
- 看不到 planner 选路原因
- 看不到失败点或 fallback 点
- evidenceRef 全部为空或不可访问

---

### T4（P1，强烈建议完成）— Supervisor 质量归因聚合

**依赖**：T2 + T3 完成（需要统一的 failure taxonomy 和 replay 数据）
**目标**：把"有 decision"升级为"有质量解释"。

**硬性要求**：

1. 为 review / decision 增加统一 root cause 分类：
   - `planner`
   - `browser_exec`
   - `page_state`
   - `supervisor_policy`
   - `business_risk`
   - `unknown`

2. 新增聚合接口：
   - `GET /api/admin/task-quality-summary`

3. 返回至少包括：
   - `totalTasks`
   - `successCount`
   - `degradedSuccessCount`（**必须**与 successCount 分开，禁止合并）
   - `failedCount`
   - `interventionRate`
   - `rootCauseDistribution`
   - `browserFailureTopReasons`

4. **必须区分三态**：
   - `success`
   - `degraded_success`
   - `failed`

**验收标准**：
- `task-quality-summary` 返回非空统计
- 至少 3 类 root cause 有样本
- 可以明确区分 success / degraded_success / failed

**不通过情形**：
- 降级成功仍被记作成功
- 失败原因无法聚合成 root cause 分布

---

### T5（P1，强烈建议完成）— Golden Tasks 扩展为三态验证集

**依赖**：T3 完成（需要 replay API 可用）
**目标**：把验收从单个样板任务升级为最小回归体系。

**硬性要求**：

1. 建立最小 golden set，至少 4 个任务：
   - 成功提取类
   - 成功导航类
   - 元素缺失降级类
   - 超时 / 异常页失败类

2. 每个任务必须定义：
   - prompt
   - 预期 task family
   - 预期 primary tool
   - 预期 fallback（若有）
   - 预期 final status
   - 预期 replay / evidence 特征

3. 必须提供**验证脚本**（不是复跑脚本）：脚本调用 replay API，检查返回的关键字段是否符合预期定义。不要求重新执行 prompt。

**验收标准**：
- 至少 4 个 golden tasks 被正式定义
- 至少 2 个 success、1 个 degraded_success、1 个 failed
- 每个样本都能通过验证脚本在 replay 或 trace 中核验
- 验证脚本可执行且输出 PASS/FAIL

**不通过情形**：
- 只有成功样本
- 样本无法通过验证脚本核验
- 样本跑完无法进入 replay 核验

---

### T6（P2，可选）— 网页任务总览入口

**依赖**：T1b + T4 完成
**目标**：为管理侧提供一个统一入口，快速查看 web tasks 的健康度。

**要求**：

1. 提供轻量聚合页或聚合接口，至少展示：
   - 最近 web tasks
   - success / degraded / failed 占比
   - browser failure top reasons
   - intervene rate

2. **禁止**为做页面而做页面；优先聚合接口，其次轻 UI。

**验收标准**：
- 至少有一个聚合入口可查看 web task 健康度

---

## 七、最低通过条件（Must Pass）

> **R22 必须同时通过 T1a + T2 + T3。缺任一项，整轮不算通过。**

强制 DoD：

- [ ] `taskFamily` 字段在 event_stream 或 trace 中有值（T1a）
- [ ] `routingReason` 和 `selectedPrimaryTool` 字段非空（T1a）
- [ ] 至少 1 个网页交互任务 trace 中可见 `selectedPrimaryTool=browser`（T1a）
- [ ] Browser failure taxonomy 至少 4 类可见（T2）
- [ ] 至少 1 个任务发生 fallback 且主链路未崩溃（T2）
- [ ] 至少 1 个任务被标记为 `degradedSuccess=true`（T2）
- [ ] `task-replay` 可回放至少 1 个 success 任务（T3）
- [ ] `task-replay` 可回放至少 1 个 degraded_success 任务（T3）
- [ ] `task-replay` 可回放至少 1 个 failed 任务（T3）
- [ ] replay 中能看到 planner → browser → supervisor → final output 串联（T3）
- [ ] replay 满足"30 秒可读"标准（T3）
- [ ] 所有新增/修改文件通过语法检查
- [ ] 所有验收接口返回非空数据

T1b / T4 / T5 完成后，才可宣称 R22 "完整通过"；否则最多只能算"最低通过"。

**目标评分**：综合 Manus 差距 7.7/10 → **8.5/10**（上下文路由 +0.4、失败治理 +0.4）

---

## 八、预期交付物

### 后端
- 网页任务 family 识别与路由字段输出（T1a）
- 网页任务独立统计口径（T1b）
- Browser failure taxonomy + fallback policy 落地（T2）
- `GET /api/admin/task-replay`（T3）
- `GET /api/admin/task-quality-summary`（T4）
- Golden task 验证脚本 / 样本定义（T5）

### 数据与字段
- task trace / replay / supervisor 统一 failure 字段：
  - `failureStage`
  - `failureReason`
  - `fallbackAction`
  - `retryable`
  - `degradedSuccess`
- routing 输出字段：
  - `taskFamily`
  - `routingReason`
  - `selectedPrimaryTool`

### 管理侧
- web tasks 聚合入口（T6 可选）

---

## 九、实现禁令

以下做法在 R22 **明确禁止**：

1. **禁止**只补日志，不补 fallback policy
2. **禁止**把 `degraded_success` 统计进 `success`
3. **禁止**把 replay 做成原始日志拼接页
4. **禁止**继续用成功样板替代失败治理
5. **禁止**网页交互任务默认走纯文本回答且无风险提示
6. **禁止**各接口继续各自定义 failure reason，必须统一 taxonomy
7. **禁止**T2 和 T3 并行开发——T3 必须在 T2 的 failure 字段落地后才能开始

---

## 十、风险与实现提醒

1. **先统一 taxonomy，再做聚合。** failure reason 命名不统一，后面所有 summary 都会失真。

2. **degraded_success 是本轮关键指标。** 它直接决定系统是否具备真实生产韧性。

3. **网页任务识别优先于更多 browser 能力扩展。** 现在的主要问题不是 browser 工具不够，而是任务没被稳定送进 browser。

4. **Golden set 必须覆盖失败样本。** 没有失败样本回归，后续任何 success rate 都不可信。

5. **T1a 是整条链的地基。** 如果 taskFamily 字段不落库，后续所有统计、归因、回放都无法按 web task 维度切分。务必确保 T1a 的字段在真实任务中有值后再推进 T2。

---

## 十一、一句话总结

**R22 = 不再证明 Browser 能工作，而是证明网页任务链路在真实生产里能稳定触发、失败可降级、全程可回放、结果可归因。**
