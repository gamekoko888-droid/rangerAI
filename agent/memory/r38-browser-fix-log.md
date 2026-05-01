# R38-T1 浏览器真实交互路径 — 分析结论

## 核心发现

1. **Gateway 原生 browser 工具已经可用且在被调用**
   - event_stream 中有 9 次 browser action + 9 次 browser observation
   - 最近调用时间：2026-04-17T13:56（今天）
   - 返回了真实的页面内容（包括 targetId, wsUrl, title, url）

2. **R36 拦截是多余的**
   - R36 在 tool_start 的 update/progress 阶段添加了 puppeteer 拦截
   - 这个拦截并没有阻止 Gateway 原生 browser 执行
   - 但它产生了额外的 puppeteer 调用，造成混淆

3. **真正的问题**
   - Gateway browser 工具只做了 navigate（打开页面）和 snapshot（获取快照）
   - 没有 click/type/screenshot 等交互动作
   - 原因：LLM 在 R37 压测中收到的任务都是"访问 xxx 网页"类型
   - 需要发送需要交互的任务才能触发 click/type

## 修复方案

### A. 移除 R36 puppeteer 拦截（消除干扰）
- 删除 openclaw-handler.mjs 第 1489-1557 行的 R36-T2 拦截块
- 保留 tool_end 中的 browser_action 事件记录

### B. 增强 browser_action 事件记录
- 在 tool_end 阶段记录 Gateway 原生 browser 的具体动作类型
- 区分 navigate/click/type/screenshot/snapshot

### C. 修复 args 序列化问题
- event_stream 中 args 显示为 "[object Object]"
- 需要 JSON.stringify(data.args) 而非 String(data.args)

### D. 发送交互型测试任务
- 设计需要 click/type 的测试任务
- 例如："去 example.com 点击 More information 链接"
