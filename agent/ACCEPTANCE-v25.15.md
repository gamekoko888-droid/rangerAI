# RangerAI v25.15 验收文档

**版本**：v25.15
**日期**：2026-04-12
**阶段**：Phase 3（Iter-E + Iter-F）
**前置版本**：v25.14（Iter-C 上下文压缩 + Iter-D 子Agent回注）

---

## 一、版本概述

v25.15 完成两个核心迭代：**Iter-E（SOUL.md 分层加载）** 解决所有任务共用同一份 15k+ token SOUL.md 导致的上下文浪费问题；**Iter-F（SkillTool 扩展系统）** 让 Agent 能主动调用注册的 Skill，而非仅靠人工触发。

---

## 二、功能验收清单

| 序号 | 验收项 | 状态 | 说明 |
|------|--------|------|------|
| E-1 | SOUL.md 瘦身到 ≤15000 字符 | ✅ | 8359 字符（原 26077） |
| E-2 | soul/ 目录包含 3 个子文件 | ✅ | business.md / coding.md / ops.md |
| E-3 | soul-loader.mjs 根据意图加载子文件 | ✅ | loadSoul() + detectSoulIntent() |
| E-4 | general 意图只加载主 SOUL.md | ✅ | INTENT_LAYERS.general = [] |
| E-5 | coding 意图额外加载 coding.md | ✅ | INTENT_LAYERS.coding = ['coding.md'] |
| E-6 | 关键词检测补充意图分类 | ✅ | INTENT_KEYWORDS 覆盖 3 类 |
| F-1 | skills/ 目录包含 3 个 Skill | ✅ | data-analysis / code-review / server-ops |
| F-2 | 每个 Skill 含 SKILL.md + run.mjs | ✅ | 6 个文件全部创建 |
| F-3 | loadSkillRegistry() 返回 3 个 Skill | ✅ | 含 hasRunner: true |
| F-4 | skill_tool 在工具注册表中 | ✅ | tools/index.mjs 第 387 行 |
| F-5 | getSkillPromptInjection() 生成 Skill 列表 | ✅ | Markdown 表格格式 |
| F-6 | 所有文件语法检查通过 | ✅ | 6 个文件 node --check OK |

---

## 三、Iter-E 详细说明

### 3.1 SOUL.md 瘦身

SOUL.md 从 26077 字符瘦身到 8359 字符，仅保留 P0 铁律和通用规则。

**保留内容**：绝对铁律 5 条、身份、基础设施速查、输出格式、任务执行、工具使用决策树、服务重启规则、记忆与知识、风险分级、模型路由、用户画像、交付签名、诚实约束、行为禁止清单、Skills 速查、维护规则。

**拆分内容**：

| 子文件 | 字符数 | 内容 |
|--------|--------|------|
| soul/business.md | 4825 | 内部业务 API 写回、深度研究协议 |
| soul/coding.md | 2955 | 代码修改六步流程、Canvas 策略、考试解题策略 |
| soul/ops.md | 6378 | 上下文工程、思维链、子 Agent 协作、错误恢复、安全意识 |

### 3.2 soul-loader.mjs

动态加载引擎，根据意图分类决定加载哪些子文件。

**意图映射表**：

| 意图 | 加载文件 | 典型触发词 |
|------|----------|-----------|
| general / chat | 仅主 SOUL.md | 日常对话 |
| business | + business.md | 工单、客服、KOL、充值、调研 |
| coding / task | + coding.md | 代码、修复、部署、bug、算法 |
| ops | + ops.md | 诊断、运维、日志、监控、安全 |
| complex | + coding.md + ops.md | 复杂任务 |

**上下文节省**：general 意图仅消耗 ~2k tokens（原 ~6k），节省约 67%。

### 3.3 验证方法

```bash
# 验证 SOUL.md 字符数
wc -c /opt/rangerai-agent/SOUL.md
# 预期: 8359

# 验证子文件存在
ls /opt/rangerai-agent/soul/
# 预期: business.md  coding.md  ops.md

# 验证 soul-loader.mjs 导出
grep "export" /opt/rangerai-agent/worker/soul-loader.mjs
# 预期: loadSoul, getSoulLayers, detectSoulIntent, INTENT_LAYERS, INTENT_KEYWORDS
```

---

## 四、Iter-F 详细说明

### 4.1 Skill 结构

每个 Skill 是一个独立目录，包含：

```
skills/
├── data-analysis/
│   ├── SKILL.md      # 描述 + 使用指南
│   └── run.mjs       # 自动执行入口
├── code-review/
│   ├── SKILL.md
│   └── run.mjs
└── server-ops/
    ├── SKILL.md
    └── run.mjs
```

### 4.2 Skill 功能说明

| Skill | 描述 | 输入 | 输出 |
|-------|------|------|------|
| data-analysis | 数据分析与可视化 | dataPath, task, outputDir | summary, files (chart + JSON) |
| code-review | 多维度代码审查 | path, focus | fileReports, issues, grade |
| server-ops | 服务器运维操作 | action (health/services/resources/logs) | 对应系统信息 |

### 4.3 skill-tool.mjs 执行引擎

提供 4 个核心函数：

| 函数 | 用途 |
|------|------|
| `loadSkillRegistry()` | 加载所有可用 Skill（1 分钟缓存） |
| `executeSkill(name, input)` | 执行指定 Skill |
| `getSkillPromptInjection()` | 生成系统提示 Skill 列表 |
| `invalidateSkillCache()` | 清除注册表缓存 |

### 4.4 工具注册表集成

`skill_tool` 已注册到 `tools/index.mjs`：
- **权限等级**：high（需要审批）
- **并发分类**：STATE_MUTATING
- **结果大小限制**：50,000 字符

### 4.5 验证方法

```bash
# 验证 Skill 目录
find /opt/rangerai-agent/skills/ -type f | sort

# 验证 skill_tool 注册
grep "skill_tool" /opt/rangerai-agent/worker/tools/index.mjs

# 验证语法
node --check /opt/rangerai-agent/worker/skill-tool.mjs
```

---

## 五、部署验证

| 检查项 | 结果 |
|--------|------|
| Git commit | ✅ 26bb6e4 (13 files, +1410 -449) |
| Git tag | ✅ v25.15 |
| rangerai-web | ✅ active |
| rangerai-ws | ✅ active |
| rangerai-agent | ✅ active |
| Port 3000 | ✅ LISTENING |
| Port 3002 | ✅ LISTENING |
| Port 3005 | ✅ LISTENING |
| Port 18789 | ✅ LISTENING |
| ranger.voyage | ✅ HTTP 200 |

---

## 六、代码变更统计

| 类型 | 文件 | 行数 |
|------|------|------|
| 新建 | soul/business.md | +4825 chars |
| 新建 | soul/coding.md | +2955 chars |
| 新建 | soul/ops.md | +6378 chars |
| 新建 | worker/soul-loader.mjs | +5833 chars |
| 新建 | skills/data-analysis/SKILL.md | 从 workspace 复制 |
| 新建 | skills/data-analysis/run.mjs | +2974 chars |
| 新建 | skills/code-review/SKILL.md | 从 workspace 复制 |
| 新建 | skills/code-review/run.mjs | +4420 chars |
| 新建 | skills/server-ops/SKILL.md | 从 workspace 复制 |
| 新建 | skills/server-ops/run.mjs | +2942 chars |
| 新建 | worker/skill-tool.mjs | +5637 chars |
| 修改 | SOUL.md | 26077 → 8359 chars |
| 修改 | worker/tools/index.mjs | +skill_tool 注册 |
| **总计** | **13 files** | **+1410 -449 lines** |

---

## 七、版本历史

| 版本 | 日期 | 内容 |
|------|------|------|
| v25.13 | 2026-04-12 | Iter-A（工具注册表）+ Iter-B（权限链）+ 考试策略 |
| v25.14 | 2026-04-12 | Iter-C（上下文压缩）+ Iter-D（子Agent回注） |
| **v25.15** | **2026-04-12** | **Iter-E（SOUL.md分层加载）+ Iter-F（SkillTool扩展）** |

---

## 八、风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| SOUL.md 瘦身遗漏关键规则 | 低 | 所有 P0 铁律保留在主文件；子文件按需加载 |
| soul-loader 意图检测不准 | 低 | 关键词检测作为补充；fallback 到 general |
| Skill run.mjs 执行异常 | 低 | try-catch 包裹；超时 60s；错误返回结构化 |
| 回滚方案 | — | SOUL.md.bak-v21 备份；git revert 到 v25.14 |

---

## 九、验收结论

v25.15 所有 12 项验收标准全部通过。Iter-E 将 SOUL.md 从 26k 字符瘦身到 8.3k 字符，general 意图上下文节省约 67%。Iter-F 建立了完整的 SkillTool 扩展系统，3 个 Skill 已迁移并可通过 `skill_tool` 自动执行。

**验收状态**：✅ 通过

---

## 十、验收签字

| 角色 | 姓名 | 日期 | 签字 |
|------|------|------|------|
| 开发 | Manus | 2026-04-12 | ✅ |
| 测试 | | | |
| 产品 | Joseph | | |
| 运维 | | | |
