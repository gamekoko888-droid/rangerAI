# RangerAI 迭代验收检查清单
**版本**: v1.0
**生效日期**: 2026-04-29
**用途**: 每轮迭代完成后强制逐项检查，全部通过才能标记迭代完成

---

## L1 语法检查（必须全部通过）

- [ ] `node --check` 所有修改的 .mjs 文件
- [ ] `find worker/ modules/ -name '*.mjs' -exec node --check {} \;` 无新增语法错误
- [ ] iter-verify.sh 语法错误计数 = 0

## L2 单元/集成验证（必须全部通过）

- [ ] `npm run test:native` 全部 PASS
- [ ] `npm run test:vitest` 全部 PASS（或已知跳过项）
- [ ] `npm run test:integration` 全部 PASS
- [ ] 新模块有调用方代码（规则九：grep 引用检查）
- [ ] 修改的方法/变量所有引用点确认正确（规则十一）

## L3 运行时验证（核心链路改动必须通过）

- [ ] `bash iter-verify.sh <轮次号>` 运行成功
- [ ] 发送测试消息到 ranger.voyage，确认正常回复
- [ ] `journalctl -u rangerai-ws --since "5 min ago" | grep -ciE 'Error|ReferenceError|TypeError'` 无新增错误
- [ ] 所有服务端口正常 LISTENING（3000/3002/3005/18789）
- [ ] `curl -sI https://ranger.voyage/` 返回 200

## L4 验收报告完整性

- [ ] ACCEPTANCE.md 已更新（使用 ACCEPTANCE-TEMPLATE.md 模板）
- [ ] 迭代记分卡已填写（规则十四）
- [ ] 验收报告中的数字与 iter-verify 输出一致（P0-7）
- [ ] 修改签名已附（P0-3b）：文件路径:行号 + 验证命令 + 验证输出

## P0 铁律遵守确认

- [ ] 未使用 `systemctl restart/stop openclaw-gateway`（P0-4）
- [ ] 所有声称有工具输出佐证（P0-2）
- [ ] .mjs 修改后已做 Docker 验证（P0-5，如适用）
- [ ] 红线文件由 GPT-5.5 处理（P0-6）

---

**签名**: _________________  **日期**: _________________  **验收结论**: PASS / FAIL
