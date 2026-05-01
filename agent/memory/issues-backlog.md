
## [2026-04-28] [P1→✅] sessions_spawn + sessions_send/sessions_list/cron/message 工具注册

**问题**：tool-description.mjs 和 tool-orchestrator.mjs 未注册 Gateway 已支持的 `sessions_spawn` / `sessions_send` / `sessions_list` / `cron` / `message` 工具。LLM 能调用但前端无中文描述，工具无超时/并发分类。

**修复**：
- tool-description.mjs 新增 5 个 case（sessions_spawn/send/list/subagents/cron/message）
- tool-orchestrator.mjs 新增 5 个 TOOL_CLASSES 映射（sessions_spawn/send/cron/message → STATE_MUTATING, sessions_list → CONCURRENT_SAFE）
- 语法检查 PASS，已重启生效

**验证**：curl /api/health → 200, systemctl active

**状态**：✅ 已完成（2026-04-28 22:59）

## [2026-04-28] [澄清] degraded-success / supervisor-block 已不存在

**实际状态**：这两个文件在 Phase B 死代码清理时已从 modules/ 移除。worker/ 目录中也不存在。degradedSuccess 逻辑已内联到 planner.mjs:369-371 和 browser-failure-taxonomy.mjs 中。我的全栈阅读报告关于"这两个模块未集成"的判断为误报。

**状态**：✅ 已澄清（功能已内联，无需额外操作）
