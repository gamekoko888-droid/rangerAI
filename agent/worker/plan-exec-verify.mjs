export function buildPlanExecVerifyPrompt(goal){
  return `[PLAN]\n拆解任务: ${goal}\n[/PLAN]\n[EXEC]\n按步骤执行并记录证据\n[/EXEC]\n[VERIFY]\n逐条验证结果并输出风险\n[/VERIFY]`;
}
