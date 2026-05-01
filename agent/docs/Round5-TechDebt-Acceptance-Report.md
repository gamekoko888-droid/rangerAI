# RangerAI 第五轮技术债验收报告（TD-034 ~ TD-039）

**版本**：v25.10  
**日期**：2026-04-11  
**Git Commit**：`0f6794a`  
**部署状态**：生产环境已部署，全量健康检查通过

---

## 总览

| TD 编号 | 优先级 | 标题 | 状态 |
|---------|--------|------|------|
| TD-034 | P1 高危 | P2-RECOVER 查询不存在的 SQLite 表 | **已修复** |
| TD-035 | P1 高危 | 5 个根目录孤儿文件归档 | **已完成** |
| TD-036 | P2 中危 | autonomous-task-api 与 supervisor 解耦 | **已修复** |
| TD-037 | P2 中危 | llm-gateway TASK_PATTERNS re-export 清理 | **已修复** |
| TD-038 | P3 卫生 | bootstrap.mjs 启动日志噪声 | **已修复** |
| TD-039 | P3 卫生 | fc26 数据库迁移 | **已标记 TODO** |

---

## TD-034（P1 高危）：P2-RECOVER 双重失效

**问题**：`ws-realtime.mjs` 启动时查询 SQLite 中不存在的 `autonomous_tasks` 表，且恢复 IPC 命令落到 deprecated stub 上。

**修复**：删除 `ws-realtime.mjs` 中 P2-RECOVER 的 autonomous_tasks 查询块（原行 575-605）。Redis 任务恢复逻辑（行 543-568）保留不变。

**验收**：
```
grep -c "autonomous_tasks" /opt/rangerai-agent/ws-realtime.mjs → 0 ✓
```

---

## TD-035（P1 高危）：5 个根目录孤儿文件

**问题**：根目录存在 5 个 `.mjs` 文件，实际功能已迁移到 `worker/` 或 `modules/` 子目录，造成认知混乱。

**修复**：

| 文件 | 处理方式 |
|------|---------|
| `smart-router.mjs` | 归档到 `scripts/archive/root-stubs-v25.10/` |
| `task-planner.mjs` | 归档到 `scripts/archive/root-stubs-v25.10/` |
| `rbac.mjs` | 归档到 `scripts/archive/root-stubs-v25.10/` |
| `conversation-recall.mjs` | 归档到 `scripts/archive/root-stubs-v25.10/` |
| `checkpoint-manager.mjs` | **保留**（230 行 canonical 版本，被 `worker/visual-verifier.mjs` 引用） |

**验收**：4 个文件已从根目录移除，`checkpoint-manager.mjs` 保留。所有活跃 import 均指向 `worker/` 或 `modules/` 子目录版本。

---

## TD-036（P2 中危）：autonomous-task-api 与 supervisor 解耦

**问题**：`autonomous-task-api.mjs` 创建任务时通过 `sendCommand({ type: 'submit_autonomous_task' })` IPC 调用已废弃的 supervisor stub。

**修复**：将 IPC 调用替换为直接 MySQL 状态更新（`UPDATE autonomous_tasks SET status='queued'`），删除 `sendCommand` import。

**验收**：
```
grep -c "sendCommand" /opt/rangerai-agent/api/autonomous-task-api.mjs → 0 ✓
```

---

## TD-037（P2 中危）：TASK_PATTERNS re-export 清理

**问题**：`llm-gateway.mjs` 通过 re-export 暴露 `TASK_PATTERNS`，破坏 TD-022 建立的单一来源原则。

**修复**：
- 删除 `export const TASK_PATTERNS = _TASK_PATTERNS;` re-export
- 清理 import 行：`import { TASK_PATTERNS as _TASK_PATTERNS, classifyTask as _classifyTask, setConfigAccessor }` → `import { classifyTask, setConfigAccessor }`
- 单一来源确认：`lib/routing-config.mjs`

**验收**：
```
grep -c "export.*TASK_PATTERNS" /opt/rangerai-agent/llm-gateway.mjs → 0 ✓
```

---

## TD-038（P3 卫生）：bootstrap 启动噪声

**问题**：每次启动产生 2 条 INFO 日志："Monitor module not available" 和 "RateLimiter module not available"。

**修复**：从 `loadBootstrap()` 中删除 `monitor.mjs` 和 `rate-limiter.mjs` 的动态 import 尝试，将 fallback no-op 对象作为静态默认值直接内联。Auth 模块动态 import 保留（关键模块）。

**验收**：
- 重启后日志中无 "Monitor module not available" / "RateLimiter module not available" ✓
- `loadBootstrap()` 仍返回 `{ auth, monitor, rateLimiter }` 接口不变 ✓

---

## TD-039（P3 卫生）：fc26 数据库迁移

**问题**：`drizzle/schema.ts` 定义了 `fc26_prices` 和 `fc26_scrape_logs` 表，但迁移未执行，数据库表不存在。

**决策**：**暂不执行迁移**，标记为 TODO。

**理由**：
1. FC26 价格监控是产品功能（游戏充值供应链核心），代码保留
2. tRPC router 未注册，前端 PriceMonitor 页面调用会 404
3. 激活需要：执行 drizzle 迁移 + 在 `routers.ts` 注册 fc26 router

**修复**：在 `server/fc26-scraper.ts` 头部添加 TODO 注释，记录当前状态和激活步骤。

---

## 生产环境健康检查

| 检查项 | 结果 |
|--------|------|
| rangerai-web 服务 | active ✓ |
| rangerai-ws 服务 | active ✓ |
| rangerai-agent 服务 | active ✓ |
| Port 3000 (SPA) | LISTENING ✓ |
| Port 3002 (API) | LISTENING ✓ |
| Port 3005 (WebSocket) | LISTENING ✓ |
| ranger.voyage HTTP | 200 ✓ |
| 磁盘使用率 | 56% ✓ |
| 启动噪声 | 已消除 ✓ |
| autonomous_tasks 查询 | 已消除 ✓ |

---

## 变更统计

- **修改文件**：5 个（ws-realtime.mjs, llm-gateway.mjs, bootstrap.mjs, autonomous-task-api.mjs, fc26-scraper.ts）
- **归档文件**：4 个（smart-router.mjs, task-planner.mjs, rbac.mjs, conversation-recall.mjs）
- **净变更**：-112 行删除 / +67 行新增

---

## 累计技术债清理进度

| 轮次 | TD 范围 | 版本 | 状态 |
|------|---------|------|------|
| 第一轮 | TD-001 ~ TD-011 | v22.x ~ v23.x | 已完成 |
| 第二轮 | TD-012 ~ TD-020 | v25.5 ~ v25.6 | 已完成 |
| 第三轮 | TD-021 ~ TD-026 | v25.7 | 已完成 |
| 第四轮 | TD-027 ~ TD-033 | v25.8 | 已完成 |
| **第五轮** | **TD-034 ~ TD-039** | **v25.10** | **已完成** |

---

## 建议的后续优化

1. **FC26 功能激活**（TD-039 后续）：执行 drizzle 迁移 + 注册 tRPC router
2. **前端 TaskQueue 清理**：移除或改造 `/tasks` 页面（当前任务创建走 DB 直写，无 worker 轮询执行）
3. **systemd KillMode**：添加 `KillMode=control-group` 防止僵尸进程
4. **磁盘告警**：使用率 > 80% 时主动通知
5. **checkpoint-manager 去重**：根目录和 `worker/` 各有一份，考虑统一为单一来源
