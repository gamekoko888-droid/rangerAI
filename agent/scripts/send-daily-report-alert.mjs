/**
 * send-daily-report-alert.mjs — 日报异常预警自动推送
 *
 * 职责：
 *   1. 检查今日数据库中被标记为 is_issue=1 的日报。
 *   2. 将问题按"通道/账号/支付/设备"整合为一条精简播报。
 *   3. 调用 alert-manager 的 sendAlert 推送给管理监控渠道。
 */

import { loadAllEnvironments } from '../lib/bootstrap.mjs';
loadAllEnvironments();
import { initAdapter, query } from '../db-adapter.mjs';
import { sendAlert } from '../alert-manager.mjs';
import { logger } from '../lib/logger.mjs';

async function generateAlerts() {
  await initAdapter();
  const dateStr = new Date().toISOString().split('T')[0];

  // 查询今日判定有风险的报告
  const issueReports = await query(`
    SELECT creator_name, template_name, issue_type, ai_summary 
    FROM dingtalk_reports 
    WHERE report_date = ? AND is_issue = 1
    ORDER BY issue_type DESC
  `, [dateStr]);

  if (issueReports.length === 0) {
    logger.info(`[ReportAlert] 今日 (${dateStr}) 暂无高危风险日报，跳过提醒。`);
    process.exit(0);
  }

  // 拼接预警文本
  let bodyLines = [];
  issueReports.forEach(r => {
    // 简化模板名为“中心-组别”
    const shortDept = r.template_name.replace("日报", "");
    bodyLines.push(`- **${r.creator_name}** (${shortDept})`);
    bodyLines.push(`  问题: ${r.ai_summary}`);
  });

  const title = `🚨 日报业务预警 (${dateStr})`;
  const bodyText = `今日共扫描出 **${issueReports.length} 项** 潜在业务卡点，需重点关注：\n\n` + bodyLines.join('\n');

  logger.info(`[ReportAlert] 检测到 ${issueReports.length} 个异常，准备发送通知。`);

  try {
    await sendAlert({
      level: 'WARN',
      title: title,
      body: bodyText,
      component: 'business:daily-reports'
    });
    logger.info(`[ReportAlert] 发送成功。`);
  } catch (error) {
    logger.error(`[ReportAlert] 提醒发送失败: ${error.message}`);
  }

  process.exit(0);
}

generateAlerts();
