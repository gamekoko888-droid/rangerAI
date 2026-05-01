/**
 * useDailyReportData — 日报看板数据层 Hook
 * 统一封装两个接口的 fetch、数据聚合、类型映射逻辑
 * 消费方：DailyReportsV2.tsx / WeeklyReportPanel
 *
 * 接口：
 *   GET /api/reports/dingtalk/daily-summary  →  花名册口径汇总 + 日报列表 + 昨日对比
 *   GET /api/reports/dingtalk/daily-issues   →  今日异常告警列表
 */

import { useState, useEffect, useCallback } from 'react';
import { Target, Zap, Building2 } from 'lucide-react';
import { logger } from "../lib/logger";

// ─── 类型定义 ────────────────────────────────────────────────

export interface DailyReport {
  id: string;
  author: string;
  team: string;
  center: string;
  date: string;
  summary: string;
  highlights: string[];
  issues: string[];
  tomorrowPlan: string[];
  mood: 'good' | 'normal' | 'stressed';
  submittedAt: string;
}

export interface AiInsight {
  type: 'warning' | 'positive';
  title: string;
  description: string;
  relatedTeams: string[];
}

export interface CenterSummary {
  center: string;
  icon: typeof Building2;
  color: string;
  reportCount: number;
  totalStaff: number;
  submissionRate: number;
  keyHighlights: string[];
  keyIssues: string[];
  missingNames: string[];
}

export interface DailyIssue {
  id: number;
  creator_name: string;
  dept_name: string;
  issue_type: string;
  ai_summary: string;
  report_date: string;
}

export interface YesterdayData {
  total: number;
  issues: number;
  healthScore: number;
  rosterCenters: any[];
}

export interface DailyReportData {
  reports: DailyReport[];
  aiInsights: AiInsight[];
  centerSummaries: CenterSummary[];
  overallScore: number;
}

// ─── 内部工具 ────────────────────────────────────────────────

const CENTER_ICON_MAP: Record<string, typeof Building2> = {
  '豹量中心': Target,
  '窜天猴中心': Zap,
  '综合管理中心': Building2,
};

const CENTER_COLOR_MAP: Record<string, string> = {
  '豹量中心': 'text-blue-400',
  '窜天猴中心': 'text-amber-400',
  '综合管理中心': 'text-emerald-400',
};

function buildCenterSummaries(rosterCenters: any[]): CenterSummary[] {
  return (rosterCenters || []).map((c: any) => {
    const notSubmitted = c.missingNames || [];
    return {
      center: c.center.replace('中心', ''),
      icon: CENTER_ICON_MAP[c.center] || Building2,
      color: CENTER_COLOR_MAP[c.center] || 'text-zinc-400',
      reportCount: Number(c.submittedCount) || 0,
      totalStaff: Number(c.totalStaff) || 0,
      submissionRate: Number(c.submissionRate) || 0,
      keyHighlights: [`已提交 ${c.submittedCount}/${c.totalStaff} 人`],
      keyIssues: notSubmitted.length > 0 ? [`未提交 ${notSubmitted.length} 人`] : [],
      missingNames: notSubmitted,
    };
  });
}

function buildReports(rawReports: any[], date: string): DailyReport[] {
  return (rawReports || []).map((r: any) => {
    const center = r.template_name?.includes('窜天猴') ? '窜天猴'
      : r.template_name?.includes('豹量') ? '豹量引擎' : '综合管理';
    return {
      id: String(r.id),
      author: r.creator_name || '未知',
      team: r.dept_name || '',
      center,
      date: r.report_date || date,
      summary: r.ai_summary || '暂无摘要',
      highlights: r.is_issue ? [] : ['整体运营正常'],
      issues: r.is_issue
        ? [r.issue_type ? `[${r.issue_type}] ${r.ai_summary}` : r.ai_summary]
        : [],
      tomorrowPlan: [],
      mood: (r.is_issue ? 'stressed' : 'good') as 'good' | 'normal' | 'stressed',
      submittedAt: '',
    };
  });
}

function buildAiInsights(rawReports: any[]): AiInsight[] {
  const issueReports = (rawReports || []).filter((r: any) => r.is_issue);
  const insights: AiInsight[] = issueReports.map((r: any) => ({
    type: 'warning' as const,
    title: `${r.creator_name} · ${r.issue_type || '异常'}`,
    description: r.ai_summary || '',
    relatedTeams: [r.dept_name || ''],
  }));
  if (insights.length === 0) {
    insights.push({
      type: 'positive',
      title: '今日无异常',
      description: '所有团队日报未发现高危业务问题，运营状态良好。',
      relatedTeams: [],
    });
  }
  return insights;
}

// ─── 主 Hook ────────────────────────────────────────────────

export function useDailyReportData() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<DailyReportData | null>(null);
  const [ydData, setYdData] = useState<YesterdayData | null>(null);
  const [issues, setIssues] = useState<DailyIssue[]>([]);

  const EMPTY: DailyReportData = { reports: [], aiInsights: [], centerSummaries: [], overallScore: 100 };

  // 异常告警接口（独立，轻量）
  useEffect(() => {
    fetch('/api/reports/dingtalk/daily-issues')
      .then(r => r.json())
      .then(res => { if (res.success) setIssues(res.data || []); })
      .catch(() => {});
  }, []);

  // 主数据接口
  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/reports/dingtalk/daily-summary');
      const json = await res.json();
      if (json.success && json.data) {
        const d = json.data;
        setData({
          reports: buildReports(d.reports, d.date),
          aiInsights: buildAiInsights(d.reports),
          centerSummaries: buildCenterSummaries(d.rosterCenters),
          overallScore: d.summary?.healthScore ?? 100,
        });
        if (d.yesterday) setYdData(d.yesterday);
      } else {
        setData(EMPTY);
      }
    } catch (e) {
      logger.error('日报数据加载失败:', e);
      setData(EMPTY);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  return { loading, refreshing, data, ydData, issues, refresh };
}
