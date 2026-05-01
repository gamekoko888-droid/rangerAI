import { fork } from "child_process";
/**
 * analyze-today-reports.mjs — 2026-03-22 日报深度分析脚本
 *
 * 职责：
 *   1. 拉取今日（及未分析的）各部门日报原始 JSON
 *   2. 遍历 contents，提取出"遇到的问题"、"卡单描述"等具体业务块
 *   3. 经过 AI (Direct API) 结构化提取：标记 is_issue, 归类 issue_type, 生成 summary
 *   4. 写回本地数据库 dingtalk_reports
 */

import { loadAllEnvironments } from '../lib/bootstrap.mjs';
loadAllEnvironments();
import { initAdapter, run, query } from '../db-adapter.mjs';
import { callDirectAPI } from "../llm-gateway.mjs";
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

/** 解析日报 JSON contents，拼接成可分析的纯文本 */
function extractReportText(contentsJson) {
  try {
    const items = JSON.parse(contentsJson);
    if (!Array.isArray(items)) return "格式错误";
    return items.map(it => `[${it.key}]: ${it.value}`).join('\n');
  } catch (e) {
    return contentsJson || "无内容";
  }
}

async function analyze() {
  await initAdapter();
  const dateStr = new Date().toISOString().split('T')[0];

  // 1. 获取今日待分析的记录
  const reports = await query(`
    SELECT id, creator_name, template_name, contents 
    FROM dingtalk_reports 
    WHERE report_date = ? AND (ai_summary IS NULL OR ai_summary = '')
    LIMIT 20
  `, [dateStr]);

  if (reports.length === 0) {
    logger.info(`[Analyzer] No pending reports for ${dateStr}`);
    // Trigger alert push after analysis
  const alerterPath = "/opt/rangerai-agent/scripts/send-daily-report-alert.mjs";
  const child = fork(alerterPath);
  child.on('exit', () => {
    logger.info("[Analyzer] Alert check completed");
    process.exit(0);
  });
  }

  logger.info(`[Analyzer] Found ${reports.length} reports to analyze`);

  for (const r of reports) {
    const rawText = extractReportText(r.contents);
    
    // 2. 调用 AI 提取核心情报
    const prompt = `你是一个专业的游戏充值供应链分析师。
请阅读以下日报内容，提取业务中的“异常/风险/问题”。
内容：
${rawText}

输出要求（JSON 格式）：
{
  "is_issue": 0或1 (只有出现明确的卡单、设备锁、支付失败、账号封禁时才为1),
  "issue_type": "设备"|"支付"|"账号"|"通道"|"其他" (如果没有问题设为 null),
  "summary": "50字内核心结论",
  "risk_score": 0.0-1.0 (风险指数)
}`;

    try {
      const resp = await callDirectAPI({
        message: prompt,
        taskType: 'reasoning',
        model: 'openai/gpt-5-mini'  // 用轻量模型做结构化提取够了
      });

      const cleanJsonStr = resp.content.match(/\{[\s\S]*\}/)?.[0];
      if (!cleanJsonStr) throw new Error("AI resp invalid format");
      
      const analysis = JSON.parse(cleanJsonStr);

      // 3. 回填数据库
      await run(`
        UPDATE dingtalk_reports 
        SET is_issue = ?, issue_type = ?, ai_summary = ?
        WHERE id = ?
      `, [analysis.is_issue || 0, analysis.issue_type || null, analysis.summary || "已阅无异常", r.id]);

      logger.info(`[Analyzer] Analyzed ${r.creator_name}: ${analysis.summary}`);
    } catch (e) {
      logger.error(`[Analyzer] Error on ${r.creator_name}: ${e.message}`);
    }
  }

  process.exit(0);
}

analyze();
