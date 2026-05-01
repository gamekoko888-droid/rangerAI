// Stateless task complexity heuristics extracted from task-engine.mjs (R98)

/**
 * v28.2: Estimate task complexity from user message.
 * Returns a numeric score. Plan generation triggers when score >= COMPLEX_THRESHOLD.
 * R10-FIX: Added attachment awareness — messages with file attachments get +3 bonus.
 */
export function estimateComplexity(message) {
  if (!message) return 0;
  let score = 0;
  // R10-FIX: Attachment awareness — file attachments indicate complex tasks
  const hasFileAttachment = /--- 文件:|\[已注入文件内容到上下文\]|--- 文件结束 ---/.test(message);
  if (hasFileAttachment) score += 3;
  // Tool-call signals (each match = +1)
  const toolSignals = message.match(/修改|部署|重启|搜索|分析|创建|删除|更新|检查|配置|安装|迁移|优化|调试|debug|fix|查看|统计|汇总|报告|监控|扫描|备份|恢复|测试|验证|审计|验收/gi);
  if (toolSignals) score += toolSignals.length;
  // Multi-step signals (+2 each)
  const multiStep = message.match(/然后|接着|之后|同时|并且|另外|最后|首先|第一步|第二步|步骤/gi);
  if (multiStep) score += multiStep.length * 2;
  // Numbered step detection: "1)" "2)" "1." "2." "①" "②" etc (+2 per step found)
  const numberedSteps = message.match(/(?:^|\n|；|;)\s*(?:\d+[).、]|[①②③④⑤⑥⑦⑧⑨⑩])/gm);
  if (numberedSteps && numberedSteps.length >= 2) score += numberedSteps.length * 2;
  // Completeness signals (+2)
  if (/完整|全部|所有|整个|从.*到|端到端|全流程|多步骤/i.test(message)) score += 2;
  // Long message bonus
  if (message.length > 200) score += 1;
  if (message.length > 500) score += 1;
  return score;
}

