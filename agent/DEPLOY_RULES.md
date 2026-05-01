# RangerAI 部署规则
**版本**: R59+ (含模型治理铁律)
**最后更新**: 2026-04-26

---

## ⚠️ 模型治理铁律（最高优先级）

**在执行任何代码迭代之前，必须先阅读 MODEL-GOVERNANCE.md。**

核心规则：V4 Pro 只负责写代码，GPT-5.5 负责规划和验收。红线文件禁止 V4 Pro 触碰。
详见：`/opt/rangerai-agent/MODEL-GOVERNANCE.md`

---

---

## 强制规则

### 1. 服务重启映射

| 变更文件 | 重启服务 | 命令 |
|---------|---------|------|
| `worker/*.mjs` | rangerai-ws | `sudo systemctl restart rangerai-ws` |
| `modules/*.mjs`, `api-server.mjs` | rangerai-agent | `sudo systemctl restart rangerai-agent` |
| `client/src/**` (前端) | 无需重启 | `bash deploy-frontend.sh` |
| `smart-router.mjs` (根目录) | rangerai-agent | `sudo systemctl restart rangerai-agent` |

### 2. 关键注意事项

- **worker 代码由 rangerai-ws 加载**，不是 rangerai-agent。R58 因此导致修复延迟一个迭代才生效。
- 前端部署后无需重启任何服务，Nginx 直接提供静态文件。
- 使用 `defer-restart.sh` 进行安全重启（等待活跃会话结束后再重启）。
- 重启后务必检查 `worker-stdout.log` 确认新代码已加载（搜索版本标记如 `[R59-diag]`）。

### 3. 部署前检查清单

- [ ] 代码语法检查（`node --check file.mjs`）
- [ ] 确认修改的文件对应的服务
- [ ] 使用 `defer-restart.sh` 而非直接 `systemctl restart`
- [ ] 重启后检查 `journalctl -u <service> -n 20` 确认无启动错误
- [ ] 检查 `worker-stdout.log` 确认新代码加载

### 4. 回滚流程

如果部署后出现问题：
1. 检查 `.bak` 备份文件（每次部署自动创建）
2. 恢复备份：`cp file.mjs.bak file.mjs`
3. 重启对应服务

---

**作者**: Manus AI
**迭代**: R59
