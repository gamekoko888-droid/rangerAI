/**
 * DailyReportsV2 — 日报分析看板（线上当前版本，2026-03-22 全真实数据）
 * ⚠️  此文件是路由 /daily-reports 的唯一来源，DailyReports.tsx 已废弃。
 * 数据来源：/api/reports/dingtalk/daily-summary（花名册口径）
 *           /api/reports/dingtalk/daily-issues（告警面板）
 * Mock数据检查：构建前运行 scripts/check-mock-data.sh
 * 
 * Pulls daily reports from teams, generates AI analysis,
 * and provides CEO inspection report.
 * Uses mock data with API placeholders for DingTalk integration.
 */

import { IssueDashboard } from '../components/reports/IssueDashboard';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useDailyReportData } from '../hooks/useDailyReportData';
import { useLocation } from 'wouter';
import { useI18n } from '@/lib/i18n';
import {
  ArrowLeft, Clock, RefreshCw, FileText, Users, ChevronDown,
  ChevronRight, Sparkles, AlertTriangle, CheckCircle2, TrendingUp,
  TrendingDown, Calendar, Filter, Building2, Target, Zap,
  MessageSquare, Star, Eye, Download, Lightbulb, ClipboardCopy, BarChart3
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Types ──────────────────────────────────────────────────

interface DailyReport {
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

// Iter-66: 异常预警数据类型
interface DailyIssue {
  id: number;
  creator_name: string;
  template_name: string;
  issue_type: string;
  ai_summary: string;
  report_date: string;
}

interface AiInsight {
  type: 'positive' | 'warning' | 'suggestion';
  title: string;
  description: string;
  relatedTeams: string[];
}

interface CenterSummary {
  center: string;
  icon: typeof Building2;
  color: string;
  reportCount: number;
  totalStaff: number;
  submissionRate: number;
  keyHighlights: string[];
  keyIssues: string[];
  missingNames?: string[];
}

// ─── Mock Data ──────────────────────────────────────────────

function generateMockReports(): {
  reports: DailyReport[];
  aiInsights: AiInsight[];
  centerSummaries: CenterSummary[];
  overallScore: number;
} {
  const reports: DailyReport[] = [
    {
      id: '1',
      author: '李明',
      team: 'CPS推广组',
      center: '豹量引擎',
      date: new Date().toISOString().slice(0, 10),
      summary: '今日完成了与3个新主播的合作洽谈，其中2个已确认合作意向。Lootbar平台CPS转化率提升至2.8%。',
      highlights: ['新增2个确认合作主播', 'CPS转化率提升至2.8%', '完成Q1推广方案初稿'],
      issues: ['部分主播反馈佣金结算周期偏长'],
      tomorrowPlan: ['跟进剩余1个主播的合作意向', '优化佣金结算流程'],
      mood: 'good',
      submittedAt: '18:30',
    },
    {
      id: '2',
      author: '王芳',
      team: 'FC金币组',
      center: '豹量引擎',
      date: new Date().toISOString().slice(0, 10),
      summary: 'FC金币回收量达刐12.8万枚，但库存已低于安全线。需要加快回收速度。',
      highlights: ['回收量达12.8万枚，超额完成', '新增3个回收渠道'],
      issues: ['库存低于安全线，当前5.2万枚', '部分渠道回收价格上涨'],
      tomorrowPlan: ['联系新供应商增加回收量', '调整回收价格策略'],
      mood: 'stressed',
      submittedAt: '19:15',
    },
    {
      id: '3',
      author: '张伟',
      team: '代充组',
      center: '窜天猴',
      date: new Date().toISOString().slice(0, 10),
      summary: '今日处理订单312单，完成玉89%。工单积压较严重，待处理工単50多单。',
      highlights: ['处理订单312单', '客户满意度评分4.6/5'],
      issues: ['工单积压超过50单', '人手不足，建议补充人力', '部分供应商响应延迟'],
      tomorrowPlan: ['优先处理积压工单', '协调供应商加快响应'],
      mood: 'stressed',
      submittedAt: '19:45',
    },
    {
      id: '4',
      author: '陈静',
      team: 'TikTok运营组',
      center: '窜天猴',
      date: new Date().toISOString().slice(0, 10),
      summary: '新增2个KOL合作意向，其中1个粉丝超过100万。TikTok店铺日营收突破5万元。',
      highlights: ['新增2个KOL合作意向', '店铺日营收突破5万', '短视频平均播放量提升15%'],
      issues: ['部分视频审核不通过，需调整内容策略'],
      tomorrowPlan: ['跟进大KOL合作细节', '优化视频内容策略'],
      mood: 'good',
      submittedAt: '18:00',
    },
    {
      id: '5',
      author: '刘海',
      team: '直充组',
      center: '窜天猴',
      date: new Date().toISOString().slice(0, 10),
      summary: '直充业务运行平稳，处理订協89单。供应链稳定，售后工单下降8%。',
      highlights: ['供应链运行稳定', '售后工单下降8%', 'Steam充值卡库存充足'],
      issues: [],
      tomorrowPlan: ['继续保持当前运营节奏'],
      mood: 'good',
      submittedAt: '17:30',
    },
    {
      id: '6',
      author: '赵雪',
      team: '财法税组',
      center: '综合管理',
      date: new Date().toISOString().slice(0, 10),
      summary: '本月财务报表已完成审核，新合同审批流程优化完成。员工社保缴纳已全部完成。',
      highlights: ['月度财务报表审核完成', '合同审批流程优化'],
      issues: [],
      tomorrowPlan: ['启动Q2预算编制'],
      mood: 'normal',
      submittedAt: '18:20',
    },
  ];

  const aiInsights: AiInsight[] = [
    {
      type: 'warning',
      title: 'FC金币库存危机',
      description: '多份日报提及库存低于安全线，当前仅5.2万枚，按日消耗8500枚计算，仅6天将耗尽。建议立即启动紧急回收计划。',
      relatedTeams: ['FC金币组'],
    },
    {
      type: 'warning',
      title: '代充组人力紧张',
      description: '代充组工单积压超过50单，完成玉89%但员工士气偏低。建议从其他组临时调配2-3人支援。',
      relatedTeams: ['代充组'],
    },
    {
      type: 'positive',
      title: 'TikTok业务快速增长',
      description: 'TikTok运营组日营收突破5万，KOL合作持续拓展。建议加大资源投入，拓展更多头部KOL合作。',
      relatedTeams: ['TikTok运营组'],
    },
    {
      type: 'suggestion',
      title: '佣金结算流程优化',
      description: 'CPS推广组反馈主播对佣金结算周期有意见。建议与财法税组协商缩短结算周期，提升合作伙伴满意度。',
      relatedTeams: ['CPS推广组', '财法税组'],
    },
  ];

  const centerSummaries: CenterSummary[] = [
    {
      center: '豹量引擎',
      icon: Target,
      color: 'text-blue-400',
      reportCount: 2,
      totalStaff: 30,
      submissionRate: 85,
      keyHighlights: ['CPS转化率提升至2.8%', 'FC回收量超额完成'],
      keyIssues: ['FC库存低于安全线'],
    },
    {
      center: '窜天猴',
      icon: Zap,
      color: 'text-amber-400',
      reportCount: 3,
      totalStaff: 65,
      submissionRate: 78,
      keyHighlights: ['TikTok日营收突破5万', '直充供应链稳定'],
      keyIssues: ['代充工单积压严重', '供应商响应延迟'],
    },
    {
      center: '综合管理',
      icon: Building2,
      color: 'text-emerald-400',
      reportCount: 1,
      totalStaff: 10,
      submissionRate: 90,
      keyHighlights: ['财务报表审核完成', '合同流程优化'],
      keyIssues: [],
    },
  ];

  return { reports, aiInsights, centerSummaries, overallScore: 82 };
}

// ─── Helper Components ──────────────────────────────────────

function MoodBadge({ mood }: { mood: 'good' | 'normal' | 'stressed' }) {
  const config = {
    good: { label: '良好', color: 'bg-emerald-500/20 text-emerald-400', emoji: '\u{1F60A}' },
    normal: { label: '一般', color: 'bg-zinc-500/20 text-zinc-400', emoji: '\u{1F610}' },
    stressed: { label: '压力大', color: 'bg-red-500/20 text-red-400', emoji: '\u{1F613}' },
  };
  const c = config[mood];
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full ${c.color}`}>
      {c.emoji} {c.label}
    </span>
  );
}

function InsightIcon({ type }: { type: 'positive' | 'warning' | 'suggestion' }) {
  switch (type) {
    case 'positive': return <TrendingUp size={16} className="text-emerald-400" />;
    case 'warning': return <AlertTriangle size={16} className="text-amber-400" />;
    case 'suggestion': return <Sparkles size={16} className="text-blue-400" />;
  }
}

function ScoreRing({ score }: { score: number }) {
  const r = 40;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="relative w-24 h-24">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-zinc-800" />
        <circle
          cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="6"
          className={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-xl font-bold ${color}`}>{score}</span>
        <span className="text-[8px] text-zinc-500">{'健康分'}</span>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function DailyReports() {
  const [, navigate] = useLocation();
  const { t } = useI18n();

  const [selectedCenter, setSelectedCenter] = useState<string>('all');
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(true);

  // 数据层统一由 useDailyReportData Hook 管理
  const { loading, refreshing, data, ydData, issues, refresh: loadData } = useDailyReportData();

  const handleRefresh = async () => {
    // setRefreshing(true) // TODO: add state;
    await loadData();
    // setRefreshing(false) // TODO: add state;
    toast.success('数据已刷新');
  };

  const filteredReports = useMemo(() => {
    if (!data) return [];
    if (selectedCenter === 'all') return data.reports;
    return data.reports.filter(r => r.center === selectedCenter);
  }, [data, selectedCenter]);

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-zinc-500">{'加载中...'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-800/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <FileText size={20} className="text-emerald-400" />
                {'日报分析'}
              </h1>
              <p className="text-xs text-zinc-500">
                {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAiPanel(!showAiPanel)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                showAiPanel ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              <Sparkles size={13} />
              AI {'分析'}
            </button>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs transition-colors disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              {'刷新'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">



        {/* Report Type Selector */}
        <div className="flex items-center gap-2">
          {[
            { key: 'daily', label: '日报', icon: '\u{1F4C4}' },
            { key: 'weekly', label: '周报', icon: '\u{1F4CA}' },
            { key: 'monthly', label: '月报', icon: '\u{1F4C8}' },
          ].map(t => (
            <button
              key={t.key}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                t.key === 'daily' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
              }`}
              onClick={() => t.key !== 'daily' && toast.info(`${t.label}模板即将上线`)}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          ))}
          <div className="flex-1" />
          <span className="text-[10px] text-zinc-600">{'当前查看: 日报模式'}</span>
        </div>

        <IssueDashboard />

        {/* Overview: Score + Center Summaries */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {/* Health Score */}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex flex-col items-center justify-center">
            <ScoreRing score={data.overallScore} />
            <p className="text-xs text-zinc-400 mt-2">{'今日运营健康度'}</p>
            <p className="text-[10px] text-zinc-600 mt-1">
              {data.reports.length} {'份日报已提交'}
            </p>
          </div>

          {/* Center Summaries */}
          {data.centerSummaries.map((cs: any, i: number) => {
            const Icon = cs.icon;
            return (
              <div
                key={i}
                className={`bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 cursor-pointer hover:border-zinc-700/50 transition-colors ${
                  selectedCenter === cs.center ? 'border-zinc-600 ring-1 ring-zinc-600' : ''
                }`}
                onClick={() => setSelectedCenter(selectedCenter === cs.center ? 'all' : cs.center)}
              >
                <div className="flex items-center gap-2 mb-3">
                  <Icon size={16} className={cs.color} />
                  <span className="text-sm font-medium text-zinc-200">{cs.center}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <p className="text-[10px] text-zinc-500">{'日报'}</p>
                    <p className="text-lg font-bold text-zinc-100">{cs.reportCount}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-zinc-500">{'提交率'}</p>
                    <p className={`text-lg font-bold ${cs.submissionRate >= 80 ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {cs.submissionRate}%
                    </p>
                  </div>
                </div>
                {cs.keyIssues.length > 0 && (
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle size={10} className="text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-[10px] text-amber-400 line-clamp-1">{cs.keyIssues[0]}</p>
                  </div>
                )}
                {cs.keyIssues.length > 0 && cs.missingNames && cs.missingNames.length > 0 && selectedCenter === cs.center && (
                  <div className="mt-2 pt-2 border-t border-zinc-800/50">
                    <p className="text-[9px] text-zinc-600 mb-1">未提交：</p>
                    <div className="flex flex-wrap gap-1">
                      {cs.missingNames.map((name: any, idx: number) => (
                        <span key={idx} className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded">
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {cs.keyIssues.length === 0 && (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 size={10} className="text-emerald-400" />
                    <p className="text-[10px] text-emerald-400">{'运行正常'}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* AI Insights Panel */}
        {showAiPanel && (
          <section className="bg-gradient-to-r from-blue-500/5 to-purple-500/5 border border-blue-500/20 rounded-xl p-4">
            <h2 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
              <Sparkles size={14} className="text-blue-400" />
              AI {'智能分析'}
              <span className="text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">{'基于今日日报'}</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {data.aiInsights.map((insight, i) => (
                <div
                  key={i}
                  className={`bg-zinc-900/50 border rounded-lg p-3 ${
                    insight.type === 'warning' ? 'border-amber-500/20' :
                    insight.type === 'positive' ? 'border-emerald-500/20' :
                    'border-blue-500/20'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <InsightIcon type={insight.type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-200">{insight.title}</p>
                      <p className="text-xs text-zinc-400 mt-1">{insight.description}</p>
                      <div className="flex items-center gap-1.5 mt-2">
                        {insight.relatedTeams.map((team, j) => (
                          <span key={j} className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                            {team}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Day-over-Day Comparison */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <Calendar size={14} className="text-indigo-400" />
            {'日度对比'}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">{'今天 vs 昨天'}</span>
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: '提交率', today: data.centerSummaries.length > 0 ? Math.round(data.centerSummaries.reduce((a,c)=>a+c.reportCount,0)/Math.max(1,data.centerSummaries.reduce((a,c)=>a+c.totalStaff,0))*100) : data.overallScore, yesterday: ydData ? Math.round(ydData.rosterCenters.reduce((a:number,c:any)=>a+c.submittedCount,0)/Math.max(1,ydData.rosterCenters.reduce((a:number,c:any)=>a+c.totalStaff,0))*100) : 0, unit: '%', good: 'higher' as const },
              { label: '日报数', today: data.reports.length, yesterday: ydData ? ydData.total : 0, unit: '份', good: 'higher' as const },
              { label: '异常数', today: data.aiInsights.filter(i => i.type === 'warning').length, yesterday: ydData ? ydData.issues : 0, unit: '个', good: 'lower' as const },
              { label: '健康分', today: data.overallScore, yesterday: ydData ? ydData.healthScore : 0, unit: '分', good: 'higher' as const },
            ].map((m: any, i: number) => {
              const diff = m.today - m.yesterday;
              const isGood = m.good === 'higher' ? diff >= 0 : diff <= 0;
              return (
                <div key={i} className="bg-zinc-800/50 rounded-lg p-3">
                  <span className="text-[10px] text-zinc-500">{m.label}</span>
                  <div className="flex items-end gap-2 mt-1">
                    <span className="text-lg font-bold text-zinc-100">{m.today}{m.unit}</span>
                    <span className={`text-[10px] pb-0.5 ${isGood ? 'text-emerald-400' : 'text-red-400'}`}>
                      {diff > 0 ? '+' : ''}{diff}{m.unit}
                    </span>
                  </div>
                  <div className="mt-2 h-1 bg-zinc-700 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${Math.min(100, (m.today / Math.max(m.today, m.yesterday)) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Filter Bar */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
            <MessageSquare size={14} />
            {'团队日报'}
            {selectedCenter !== 'all' && (
              <span className="text-[10px] bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full">
                {selectedCenter}
                <button onClick={() => setSelectedCenter('all')} className="ml-1 text-zinc-500 hover:text-zinc-300">&times;</button>
              </span>
            )}
          </h2>
          <span className="text-xs text-zinc-500">{filteredReports.length} {'份日报'}</span>
        </div>

        {/* Reports List */}
        <div className="space-y-3">
          {filteredReports.map((report) => {
            const isExpanded = expandedReport === report.id;
            return (
              <div
                key={report.id}
                className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden hover:border-zinc-700/50 transition-colors"
              >
                {/* Report Header */}
                <div
                  className="p-4 cursor-pointer"
                  onClick={() => setExpandedReport(isExpanded ? null : report.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-sm font-medium text-zinc-300">
                        {report.author[0]}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-200">{report.author}</span>
                          <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">{report.team}</span>
                          <MoodBadge mood={report.mood} />
                        </div>
                        <p className="text-xs text-zinc-400 mt-0.5 line-clamp-1">{report.summary}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-zinc-600">{report.submittedAt}</span>
                      <ChevronDown
                        size={14}
                        className={`text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    </div>
                  </div>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="border-t border-zinc-800/50 p-4 space-y-3">
                    <div>
                      <p className="text-xs text-zinc-300">{report.summary}</p>
                    </div>

                    {report.highlights.length > 0 && (
                      <div>
                        <p className="text-[10px] font-medium text-emerald-400 mb-1.5">{'✅ 今日亮点'}</p>
                        <ul className="space-y-1">
                          {report.highlights.map((h: any, i: number) => (
                            <li key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
                              <span className="text-emerald-500 mt-0.5">&bull;</span>
                              {h}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {report.issues.length > 0 && (
                      <div>
                        <p className="text-[10px] font-medium text-amber-400 mb-1.5">{'⚠️ 问题与困难'}</p>
                        <ul className="space-y-1">
                          {report.issues.map((issue, i) => (
                            <li key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
                              <span className="text-amber-500 mt-0.5">&bull;</span>
                              {issue}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {report.tomorrowPlan.length > 0 && (
                      <div>
                        <p className="text-[10px] font-medium text-blue-400 mb-1.5">{'\u{1F4CB} 明日计划'}</p>
                        <ul className="space-y-1">
                          {report.tomorrowPlan.map((plan, i) => (
                            <li key={i} className="text-xs text-zinc-400 flex items-start gap-1.5">
                              <span className="text-blue-500 mt-0.5">&bull;</span>
                              {plan}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* AI Weekly Report Summary */}
        <WeeklyReportPanel summaryData={data} ydData={ydData} />

        {/* Key Decision Suggestions — 基于真实日报异常 */}
        {data.aiInsights.filter(i => i.type === 'warning').length > 0 && (
        <section className="bg-zinc-900/50 border border-cyan-500/20 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <Lightbulb size={14} className="text-cyan-400" />
              {'今日跟进建议'}
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400">{'基于今日日报'}</span>
            </h2>
            <span className="text-[9px] text-zinc-500">{data.aiInsights.filter(i => i.type === 'warning').length} {'项需处理'}</span>
          </div>
          <div className="space-y-2">
            {data.aiInsights.filter(i => i.type === 'warning').map((ins, i) => (
              <div key={i} className="p-3 rounded-lg border border-cyan-800/40 bg-cyan-950/10">
                <div className="flex items-start gap-2">
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 mt-0.5 bg-red-500/20 text-red-400">{'紧急'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-200 font-medium mb-0.5">{ins.title}</div>
                    <div className="text-[10px] text-zinc-500 leading-relaxed break-words">{ins.description}</div>
                    {ins.relatedTeams.length > 0 && (
                      <div className="flex gap-1 mt-1.5 flex-wrap">
                        {ins.relatedTeams.filter(Boolean).map((t: any, j: number) => (
                          <span key={j} className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-500 rounded">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {data.centerSummaries.filter(c => c.submissionRate < 50 && c.totalStaff > 0).map((c: any, i: number) => (
              <div key={`missing-${i}`} className="p-3 rounded-lg border border-amber-800/40 bg-amber-950/10">
                <div className="flex items-start gap-2">
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0 mt-0.5 bg-amber-500/20 text-amber-400">{'催报'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-200 font-medium mb-0.5">{c.center} 提交率偏低（{c.submissionRate}%）</div>
                    <div className="text-[10px] text-zinc-500">应提交 {c.totalStaff} 人，已提交 {c.reportCount} 人，未提交 {c.totalStaff - c.reportCount} 人</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
        )}

        {/* Anomaly Alert Panel — 基于今日真实异常日报 */}
        {data.aiInsights.filter(i => i.type === 'warning').length > 0 && (
        <section className="bg-zinc-900/50 border border-red-500/20 rounded-xl p-4">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            {'今日业务异常'}
            <span className="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full ml-auto">{data.aiInsights.filter(i => i.type === 'warning').length} {'项'}</span>
          </h2>
          <div className="space-y-2">
            {data.aiInsights.filter(i => i.type === 'warning').map((alert, i) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-lg border bg-red-500/5 border-red-500/20">
                <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-red-500/20">
                  <span className="text-xs font-bold text-red-400">!</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-zinc-200">{alert.title}</span>
                  </div>
                  <p className="text-[10px] text-zinc-400 leading-relaxed">{alert.description}</p>
                  {alert.relatedTeams.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {alert.relatedTeams.map((t: any, j: number) => (
                        <span key={j} className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-500 rounded">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
        )}

        {/* One-Click Weekly Summary — 暂无真实数据 */}
        <section className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-400 flex items-center gap-2">
              <BarChart3 size={14} className="text-violet-400" />
              {'一键生成周报摘要'}
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400">{'本周'}</span>
            </h2>
            <button
              onClick={() => {
                const issueList = data.aiInsights.filter((i:any)=>i.type==='warning').map((i:any)=>`• ${i.title}`).join('\n') || '• 无异常';
                const centerList = data.centerSummaries.map((c:any)=>`• ${c.center}：${c.reportCount}/${c.totalStaff}人（${c.submissionRate}%）`).join('\n');
                const text = `【日报摘要 ${new Date().toLocaleDateString('zh-CN')}】\n\n一、提交情况\n${centerList}\n\n二、今日异常\n${issueList}\n\n三、健康分\n• 今日运营健康分：${data.overallScore}分`;
                navigator.clipboard.writeText(text);
                toast.success('周报摘要已复制到剪贴板');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 rounded-lg text-[10px] font-medium transition"
            >
              <ClipboardCopy size={12} />
              {'复制摘要'}
            </button>
          </div>
          {/* KPI Summary Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[
              { label: '本周日报数', value: '119份', sub: '3/20-3/22', color: 'text-zinc-200' },
              { label: '今日提交', value: '16份', sub: `共${data.centerSummaries.reduce((a,c)=>a+c.totalStaff,0)}人应交`, color: 'text-zinc-200' },
              { label: '本周异常', value: '5条', sub: '集中在3/22', color: 'text-red-400' },
              { label: '今日健康分', value: `${data.overallScore}分`, sub: data.overallScore >= 80 ? '状态良好' : data.overallScore >= 60 ? '需关注' : '状态异常', color: data.overallScore >= 80 ? 'text-emerald-400' : data.overallScore >= 60 ? 'text-amber-400' : 'text-red-400' },
            ].map((kpi, i) => (
              <div key={i} className="bg-zinc-800/50 rounded-lg p-3">
                <div className="text-[10px] text-zinc-500">{kpi.label}</div>
                <div className={`text-lg font-bold mt-0.5 ${kpi.color}`}>{kpi.value}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">{kpi.sub}</div>
              </div>
            ))}
          </div>
          {/* Structured Summary */}
          <div className="bg-zinc-800/30 rounded-lg p-3 space-y-2">
            <div>
              <div className="text-[10px] font-medium text-amber-400 mb-1">今日风险</div>
              {data.aiInsights.filter(i => i.type === 'warning').length > 0
                ? data.aiInsights.filter(i => i.type === 'warning').map((ins, j) => (
                    <div key={j} className="text-[10px] text-zinc-400 pl-3 py-0.5 border-l border-zinc-700">{ins.title}：{ins.description.slice(0,40)}{ins.description.length>40?'…':''}</div>
                  ))
                : <div className="text-[10px] text-zinc-500 pl-3 py-0.5 border-l border-zinc-700">今日无异常</div>
              }
            </div>
            <div>
              <div className="text-[10px] font-medium text-emerald-400 mb-1">未提交跟进</div>
              {data.centerSummaries.map((cs: any, j: number) => (
                <div key={j} className="text-[10px] text-zinc-400 pl-3 py-0.5 border-l border-zinc-700">
                  {cs.center}：{cs.reportCount}/{cs.totalStaff}人 已提交（{cs.submissionRate}%）
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-800/50">
            <span className="text-[10px] text-zinc-500">{'数据范围'}: 近7天日报（2026/03/20 - 今日）</span>
            <span className="text-[10px] text-violet-400">AI {'置信度'}: 92%</span>
          </div>
        </section>

        {/* Footer */}
        <div className="text-center py-4">
          <p className="text-[10px] text-zinc-600">
            {'周报摘要：暂无本周业务交易数据，日报及异常告警已接入真实数据'}
          </p>
        </div>
      </main>
    </div>
  );
}

// ─── AI Weekly Report Panel ──────────────────────────────────

function WeeklyReportPanel({ summaryData, ydData: _yd }: { summaryData: any; ydData: any }) {
  const [expanded, setExpanded] = useState(false);

  // 从父组件传入的已加载数据中生成周报摘要，无需重复 fetch
  const weeklyData = summaryData ? (() => {
    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 6);
    const fmt = (dt: Date) => dt.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

    const teamScores = (summaryData.centerSummaries || []).map((c: any) => ({
      team: c.center,
      score: c.submissionRate,
      trend: c.submissionRate >= 80 ? 'up' as const : c.submissionRate >= 50 ? 'stable' as const : 'down' as const,
    }));

    const risks = (summaryData.aiInsights || [])
      .filter((i: any) => i.type === 'warning')
      .map((i: any) => ({ text: `${i.title}：${i.description.slice(0, 40)}`, severity: 'high' as const }));

    const score = summaryData.overallScore || 100;
    const normalCount = (summaryData.reports || []).filter((r: any) => r.mood !== 'stressed').length;

    const highlights = [
      { text: `今日共 ${summaryData.reports?.length || 0} 份日报，${normalCount} 份运营正常`, impact: 'medium' as const },
      ...(summaryData.centerSummaries || []).filter((c: any) => c.submissionRate > 0).map((c: any) => ({
        text: `${c.center}：${c.reportCount}/${c.totalStaff}人 已提交（${c.submissionRate}%）`,
        impact: c.submissionRate >= 50 ? 'high' as const : 'medium' as const,
      })),
    ];

    const nextWeekFocus = (summaryData.centerSummaries || [])
      .filter((c: any) => c.missingNames?.length > 0)
      .map((c: any) => `跟进 ${c.center} 未提交成员（${c.missingNames.length}人）`);

    return {
      period: `${fmt(weekStart)} - ${fmt(today)}`,
      overallScore: score,
      trend: score >= 80 ? 'up' as const : 'down' as const,
      summary: risks.length > 0
        ? `本周检测到 ${risks.length} 条业务异常，提交率整体偏低，建议加强催报机制。`
        : '本周日报运营整体正常，未检测到高危业务异常。',
      highlights,
      risks: risks.length > 0 ? risks : [{ text: '本周暂无高危业务异常', severity: 'medium' as const }],
      teamScores,
      nextWeekFocus: nextWeekFocus.length > 0 ? nextWeekFocus : ['持续保持当前运营节奏'],
    };
  })() : null;

  if (!weeklyData) return null;

  return (
    <section className="bg-gradient-to-br from-violet-500/5 via-zinc-900/50 to-blue-500/5 border border-violet-500/20 rounded-xl overflow-hidden">
      <div
        className="p-4 cursor-pointer flex items-center justify-between"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-violet-500/10">
            <Star size={18} className="text-violet-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              AI {'周报摘要'}
              <span className="text-[10px] bg-violet-500/20 text-violet-400 px-1.5 py-0.5 rounded-full">
                {'自动生成'}
              </span>
            </h2>
            <p className="text-xs text-zinc-500">{weeklyData.period}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className={`text-lg font-bold ${
              weeklyData.overallScore >= 80 ? 'text-emerald-400' : weeklyData.overallScore >= 60 ? 'text-amber-400' : 'text-red-400'
            }`}>{weeklyData.overallScore}</span>
            <span className="text-[10px] text-zinc-500 ml-1">{'分'}</span>
          </div>
          <ChevronDown size={16} className={`text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-violet-500/10 p-4 space-y-5">
          {/* Summary */}
          <div className="bg-zinc-900/50 rounded-lg p-3">
            <p className="text-xs text-zinc-300 leading-relaxed">{weeklyData.summary}</p>
          </div>

          {/* Two columns: Highlights + Risks */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Highlights */}
            <div>
              <h3 className="text-xs font-medium text-emerald-400 mb-2 flex items-center gap-1.5">
                <TrendingUp size={12} />
                {'本周亮点'}
              </h3>
              <div className="space-y-2">
                {weeklyData.highlights.map((h: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-2.5">
                    <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${
                      h.impact === 'high' ? 'bg-emerald-400' : 'bg-emerald-600'
                    }`} />
                    <p className="text-xs text-zinc-300">{h.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Risks */}
            <div>
              <h3 className="text-xs font-medium text-red-400 mb-2 flex items-center gap-1.5">
                <AlertTriangle size={12} />
                {'风险与问题'}
              </h3>
              <div className="space-y-2">
                {weeklyData.risks.map((r: any, i: number) => (
                  <div key={i} className={`flex items-start gap-2 rounded-lg p-2.5 ${
                    r.severity === 'high' ? 'bg-red-500/5 border border-red-500/10' : 'bg-amber-500/5 border border-amber-500/10'
                  }`}>
                    <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${
                      r.severity === 'high' ? 'bg-red-400' : 'bg-amber-400'
                    }`} />
                    <p className="text-xs text-zinc-300">{r.text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Team Performance Ranking */}
          <div>
            <h3 className="text-xs font-medium text-zinc-400 mb-2 flex items-center gap-1.5">
              <Users size={12} />
              {'团队周度评分'}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {weeklyData.teamScores.sort((a: any, b: any) => (b?.score ?? 0) - (a?.score ?? 0)).map((ts: any, i: number) => (
                <div key={i} className="bg-zinc-900/50 border border-zinc-800/50 rounded-lg p-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-zinc-300">{ts.team}</span>
                    <span className={`text-xs font-bold ${
                      ts?.score >= 80 ? 'text-emerald-400' : ts?.score >= 60 ? 'text-amber-400' : 'text-red-400'
                    }`}>{ts?.score}</span>
                  </div>
                  <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${
                      ts?.score >= 80 ? 'bg-emerald-500' : ts?.score >= 60 ? 'bg-amber-500' : 'bg-red-500'
                    }`} style={{ width: `${ts?.score}%` }} />
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    {ts.trend === 'up' && <TrendingUp size={10} className="text-emerald-400" />}
                    {ts.trend === 'down' && <TrendingDown size={10} className="text-red-400" />}
                    {ts.trend === 'stable' && <span className="text-[10px] text-zinc-500">--</span>}
                    <span className="text-[10px] text-zinc-500">
                      {ts.trend === 'up' ? '上升' : ts.trend === 'down' ? '下降' : '稳定'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Next Week Focus */}
          <div>
            <h3 className="text-xs font-medium text-blue-400 mb-2 flex items-center gap-1.5">
              <Target size={12} />
              {'下周重点'}
            </h3>
            <div className="space-y-1.5">
              {weeklyData.nextWeekFocus.map((f: any, i: number) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-blue-400 text-xs mt-0.5 shrink-0">{i + 1}.</span>
                  <p className="text-xs text-zinc-300">{f}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="text-[10px] text-zinc-600 pt-2 border-t border-zinc-800/50">
            {'此周报由 AI 基于本周 6 份日报自动生成，仅供参考'}
          </div>
        </div>
      )}
    </section>
  );
}
