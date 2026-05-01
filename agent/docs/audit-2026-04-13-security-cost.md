# RangerAI 安全与成本自检报告

**日期：** 2026-04-13
**审计范围：** 阿里云服务器 8.219.186.244（ranger.voyage）
**审计类型：** 只读检查，未修改任何代码或配置

---

## 一、Claude API Key 安全审计

### 1.1 总体评估

存在 **3 个高风险** + **2 个中风险** 问题。Key 在服务器上有多处明文存储，且部分位置权限过于宽松。

### 1.2 高风险问题

| 序号 | 问题 | 位置 | 详情 |
|------|------|------|------|
| H1 | systemd service 文件明文存储 Anthropic Key | `/etc/systemd/system/rangerai-ws.service` 第 22 行 | 文件权限 `-rw-r--r--`（644），所有系统用户可读。任何登录用户执行 `cat /etc/systemd/system/rangerai-ws.service` 即可看到完整 Key |
| H2 | secrets.json 明文存储 OpenAI Key | `/opt/rangerai-agent/secrets.json` | 包含 OPENAI_API_KEY、BRAVE_API_KEY、OPENCLAW_TOKEN、JWT_SECRET。权限 600（仅 owner），但纯 JSON 明文无加密 |
| H3 | agent-secrets.env 中重复存储 Anthropic Key | `/opt/rangerai-agent/agent-secrets.env` 第 21 行 | 与 `.env` 中的 Key 完全相同，增加了泄露面 |

### 1.3 中风险问题

| 序号 | 问题 | 位置 | 详情 |
|------|------|------|------|
| M1 | `.env` 文件被 git 追踪 | `git ls-files` 输出包含 `.env` | 虽然 `.gitignore` 中有 `.env` 条目，但文件已被 commit 过。如果 repo 被 push 到远程，Key 会随代码泄露 |
| M2 | SQLite 数据库及备份中包含 Key 字符串 | `rangerai.db` + `backups/db/*.db` | `grep` 匹配到 `sk-ant-` 和 `sk-proj-` 字符串，数据库备份泄露等同于 Key 泄露 |

### 1.4 正面发现

| 检查项 | 结果 |
|--------|------|
| `.env` 文件权限 | 600（仅 owner 可读）✅ |
| 前端构建产物中是否包含 Key | 未发现 ✅ |
| 内部服务端口绑定 | 3001/3002/3005/18789 绑定 `127.0.0.1` ✅ |
| Caddy 安全 headers | X-Content-Type-Options、HSTS、X-Frame-Options 等已配置 ✅ |
| 敏感路径 basic_auth 保护 | `/openclaw-media/*`、`/vnc/*`、`/tiktok-dl/*` 均有 basic_auth ✅ |

### 1.5 Key 存储位置汇总

| 文件 | 包含的 Key | 文件权限 | 是否 git 追踪 |
|------|-----------|---------|--------------|
| `/opt/rangerai-agent/.env` | ANTHROPIC_API_KEY, GOOGLE_API_KEY, QWEN_API_KEY, DINGTALK_CLIENT_SECRET | 600 | **是（已 commit）** |
| `/opt/rangerai-agent/agent-secrets.env` | ANTHROPIC_API_KEY（重复） | 未确认 | 否（在 .gitignore 中） |
| `/opt/rangerai-agent/secrets.json` | OPENAI_API_KEY, BRAVE_API_KEY, OPENCLAW_TOKEN, JWT_SECRET | 600 | 否 |
| `/etc/systemd/system/rangerai-ws.service` | ANTHROPIC_API_KEY | **644（所有人可读）** | N/A |

### 1.6 安全修复建议

**优先级 P0（立即修复）：**

1. 将 `rangerai-ws.service` 中的 `Environment=ANTHROPIC_API_KEY=sk-ant-...` 改为 `EnvironmentFile=/opt/rangerai-agent/agent-secrets.env`，并确保 `agent-secrets.env` 权限为 600
2. 执行 `systemctl daemon-reload && systemctl restart rangerai-ws`

**优先级 P1（本周修复）：**

3. 从 git 历史中清除 `.env`：
   ```bash
   cd /opt/rangerai-agent
   git rm --cached .env
   git commit -m "Remove .env from tracking"
   # 如需彻底清除历史：git filter-branch --force --index-filter 'git rm --cached --ignore-unmatch .env' HEAD
   ```

4. 轮换所有已暴露的 API Key（Anthropic、OpenAI、Google、Brave），因为无法确认是否已被读取

**优先级 P2（本月优化）：**

5. 统一 Key 管理：将所有 Key 集中到一个 `agent-secrets.env` 文件，删除 `secrets.json` 和 `.env` 中的重复项
6. 数据库备份加密：`backups/db/*.db` 应使用加密存储或在备份时排除敏感数据

---

## 二、Claude API 用量与成本分析

### 2.1 用量概况

**数据来源：** `/var/log/rangerai-ws.log`，覆盖 2026-04-10 ~ 2026-04-13（约 3 天）

| 指标 | 数值 |
|------|------|
| 总请求数（endTrace 记录） | 422 |
| 日均请求数 | ~125 次/天 |
| Claude Sonnet 4 请求 | 374（88.6%） |
| GPT-5.4 请求 | 10（2.4%） |
| GPT-5.4-mini 请求 | 34（8.1%） |
| GPT-4.1-mini 请求 | 4（0.9%） |

### 2.2 模型路由配置

当前 `llm-gateway.mjs` 中的模型路由表：

| 任务类型 | 首选模型 | Fallback 链 |
|---------|---------|------------|
| code | anthropic/claude-sonnet-4-6 | → gpt-5.4 → gpt-4.1-mini |
| reasoning | openai/gpt-5.4 | → claude-sonnet-4-6 → gpt-4.1-mini |
| sysadmin | anthropic/claude-sonnet-4-6 | → gpt-5.4 → gpt-4.1-mini |
| gaming | anthropic/claude-sonnet-4-6 | → gpt-5.4 → gpt-4.1-mini |
| chat | openai/gpt-4.1-mini | → gpt-5.4 → claude-sonnet-4-6 |
| translation | openai/gpt-4.1-mini | → gpt-5.4 → claude-sonnet-4-6 |
| chinese_content | openai/gpt-5.4 | → claude-sonnet-4-6 → gpt-4.1-mini |
| creative | openai/gpt-5.4 | → claude-sonnet-4-6 → gpt-4.1-mini |
| research | openai/gpt-5.4 | → claude-sonnet-4-6 → gpt-4.1-mini |
| image_generation | google/gemini-3.1-flash | → gemini-3-flash → gemini-3-pro |

**关键发现：** 虽然 `chat` 类型配置了 gpt-4.1-mini 作为首选，但实际 88.6% 的请求走了 Claude Sonnet 4。这说明大部分请求被 smart-router 分类为 code/sysadmin/gaming 等需要 Claude 的类型，或者用户手动选择了 Claude。

### 2.3 Gateway Session Token 累积（成本核心）

**这是成本的最大驱动因素。** 每次请求不是只发送用户消息，而是发送整个 Gateway session 的完整上下文。

| Session 大小区间 | 请求占比 |
|-----------------|---------|
| <20k tokens | 2% |
| 20-50k tokens | 20% |
| 50-100k tokens | 39% |
| 100-150k tokens | 36% |
| >150k tokens | 1% |
| **平均 session 大小** | **82,671 tokens** |
| **最大 session 大小** | **174,538 tokens** |

context-window-manager 配置的上限为 200,000 tokens（Claude 3.5 Sonnet 默认值）。

### 2.4 成本追踪缺陷

**系统内置的 endTrace 成本追踪严重低估了真实成本。**

| 指标 | endTrace 记录 | 实际情况 |
|------|-------------|---------|
| 3 天 Claude 总成本 | $2.12 | 估算 $50-96 |
| 平均每请求 input tokens | 268 | 82,671（session 全量） |
| 成本来源 | 仅计算用户消息 token | 应计算完整 session context |

endTrace 使用 `source=estimate`，只统计了用户消息的 token 数（`tokens=13+208` 表示 13 input + 208 output），完全忽略了 Gateway session 中累积的 80k+ tokens 上下文。

### 2.5 Prompt Caching 状态

**好消息：代码中已启用了 Anthropic Prompt Caching。**

`llm-gateway.mjs` 的 `_streamAnthropicDirect` 函数（v14.6/v28.0）：
- 使用 `cache_control: { type: "ephemeral" }` 对 system prompt 进行缓存
- v28.0 实现了双层 KV-Cache：固定前缀（identity/rules）缓存，动态后缀（skills/APIs）不缓存

**但缓存范围有限：** Prompt caching 只缓存 system prompt 前缀（通常几千 tokens），不缓存对话历史。对话历史占了 session 的绝大部分（80k+ tokens），这部分每次都按全价计费。

**注意：** 这个 caching 只对 `_streamAnthropicDirect`（DirectAPI 路径）生效。通过 OpenClaw Gateway 的 `chat.send` 路径是否启用了 caching 取决于 Gateway 自身实现，当前无法从日志中确认。

### 2.6 真实成本估算

**Claude Sonnet 4 定价（2026-04）：** Input $3/MTok, Output $15/MTok, Cached Input $0.30/MTok

| 场景 | 日均成本 | 月均成本 |
|------|---------|---------|
| 无缓存（最差） | ~$32/天 | ~$960/月 |
| 缓存 50% 命中率 | ~$18/天 | ~$540/月 |
| 缓存 90% 命中率（乐观） | ~$7/天 | ~$210/月 |

**以上仅计算 Gateway 路径的 374 次 Claude 请求。** 还有至少 3 个额外的直接 API 调用路径未计入。

### 2.7 Claude API 调用路径汇总

| 路径 | 文件 | 说明 |
|------|------|------|
| Gateway 主路径 | `openclaw-handler.mjs` → Gateway → Anthropic | 主要对话路径，占 88.6% |
| DirectAPI 路径 | `llm-gateway.mjs` → `_streamAnthropicDirect` → `api.anthropic.com` | 用户手动选模型时绕过 Gateway |
| ai-data-mapper | `lib/ai-data-mapper.mjs` → `api.anthropic.com` | 数据映射功能 |
| file-server | `file-server.mjs` → `api.anthropic.com` | 文件处理 |
| infra-routes | `modules/routes/infra-routes.mjs` → `api.anthropic.com` | 基础设施管理 |

### 2.8 $100/天是否合理？

**结论：偏高，但在当前架构下可以解释。**

主要成本驱动因素：
1. **88.6% 请求使用 Claude Sonnet 4**（最贵的模型之一）
2. **平均 session 82k tokens**（每次请求发送大量上下文）
3. **Extended thinking 默认 high**（`openclaw-handler.mjs` 第 171 行：`thinking: 'high'`）
4. **多个独立 API 调用路径**，日志中的统计不完整
5. **OpenClaw Gateway 的 tool use 循环**，每次 `chat.send` 后可能进行多轮 tool call，每轮都带完整上下文

---

## 三、降本优化建议

| 优先级 | 优化方向 | 预估节省 | 实施难度 | 说明 |
|--------|---------|---------|---------|------|
| P0 | 降低 context window 上限（200k → 50-80k） | 50-60% | 低 | 修改 `context-window-manager.mjs` 的 `DEFAULT_CONTEXT_WINDOW` |
| P0 | 简单对话用 GPT-5.4-mini 替代 Claude | 40-50% | 低 | 调整 smart-router 分类阈值，让更多 chat 类请求走 mini 模型 |
| P1 | Extended thinking 改为按需启用 | 20-30% | 低 | 将默认 `thinking: 'high'` 改为 `thinking: 'standard'`，仅复杂任务用 high |
| P1 | 修复成本追踪（统计完整 session tokens） | 0%（但能看清真实成本） | 中 | 从 Gateway JSONL 或 Anthropic usage 响应中提取真实 token 数 |
| P2 | 确认 Gateway 路径的 prompt caching 命中率 | 可能 20-40% | 低 | 添加 `anthropic-beta: prompt-caching-2024-07-31` header，检查 usage 中的 `cache_read_input_tokens` |
| P2 | 合并直接 API 调用路径 | 10-20% | 中 | 将 ai-data-mapper、file-server、infra-routes 的 Claude 调用统一走 Gateway 以利用缓存 |
| P3 | 对话历史压缩策略优化 | 15-25% | 高 | 当前 compression 在 75% 才触发，可提前到 50% |

---

## 四、端口与网络暴露情况

| 端口 | 服务 | 绑定地址 | 对外暴露 |
|------|------|---------|---------|
| 3000 | 前端静态服务 | `*:3000`（所有接口） | **是（直接对外）** |
| 3001 | 内部服务 | `127.0.0.1` | 否（Caddy 代理） |
| 3002 | API Server | `127.0.0.1` | 否（Caddy 代理） |
| 3005 | WS Realtime | `127.0.0.1` | 否（Caddy 代理） |
| 18789 | OpenClaw Gateway | `127.0.0.1` | 否（Caddy 代理，路径 `/ed0d9821*`） |

**注意：** 端口 3000 绑定了所有接口（`*:3000`），理论上可以通过 `http://8.219.186.244:3000` 直接访问，绕过 Caddy 的安全 headers。建议改为绑定 `127.0.0.1:3000`。

---

*报告生成时间：2026-04-13 20:00 CST*
*审计人：Manus AI（只读检查，未修改任何文件）*
