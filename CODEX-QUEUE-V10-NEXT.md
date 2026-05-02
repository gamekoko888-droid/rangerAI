# V10 Next（任务书 + 迭代跟踪）

- [x] V10N-1 verify-runner 接入真实任务编排主循环（新增 `--with-task-loop`，调用 `/api/chat` + 轮询 `/api/task-status/:sessionKey`）
- [ ] V10N-2 验证失败自动回滚到上一个 release（定义 rollback webhook 与 guard）
- [ ] V10N-3 验证证据上报到 admin dashboard（新增 verify_audit 聚合接口）
- [ ] V10N-4 将 V10N 验证闭环并入 nightly pipeline（cron + 报警）
