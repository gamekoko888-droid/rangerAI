/**
 * OperationalEfficiency — 运营效率分析页面
 * 各中心人效比、任务完成率、响应时间、效率趋势
 */

import { useState } from 'react';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import {
  ArrowLeft, Gauge, Users, Clock, CheckCircle2, TrendingUp, TrendingDown,
  Zap, Target, BarChart3, Activity, RefreshCw, Timer, Award,
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Mock Data ─────────────────────────────────────────────
const CENTERS = [
  {
    name: '客服中心',
    nameEn: 'Customer Service',
    icon: '🎧',
    color: 'from-blue-500/20 to-blue-600/10',
    borderColor: 'border-blue-500/30',
    textColor: 'text-blue-400',
    members: 12,
    tasksCompleted: 847,
    tasksTotal: 892,
    avgResponseMin: 4.2,
    avgResolutionMin: 23.5,
    satisfaction: 94.2,
    efficiency: 89.3,
    trend: +2.1,
  },
  {
    name: '运营中心',
    nameEn: 'Operations',
    icon: '⚙️',
    color: 'from-emerald-500/20 to-emerald-600/10',
    borderColor: 'border-emerald-500/30',
    textColor: 'text-emerald-400',
    members: 8,
    tasksCompleted: 523,
    tasksTotal: 561,
    avgResponseMin: 12.8,
    avgResolutionMin: 45.2,
    satisfaction: 91.5,
    efficiency: 85.7,
    trend: +1.8,
  },
  {
    name: '市场中心',
    nameEn: 'Marketing',
    icon: '📈',
    color: 'from-purple-500/20 to-purple-600/10',
    borderColor: 'border-purple-500/30',
    textColor: 'text-purple-400',
    members: 6,
    tasksCompleted: 312,
    tasksTotal: 340,
    avgResponseMin: 18.5,
    avgResolutionMin: 72.3,
    satisfaction: 88.9,
    efficiency: 82.4,
    trend: -0.5,
  },
];

const WEEKLY_TREND = [
  { day: 'Mon', cs: 92, ops: 87, mkt: 84 },
  { day: 'Tue', cs: 88, ops: 89, mkt: 82 },
  { day: 'Wed', cs: 91, ops: 86, mkt: 85 },
  { day: 'Thu', cs: 87, ops: 88, mkt: 81 },
  { day: 'Fri', cs: 93, ops: 90, mkt: 86 },
  { day: 'Sat', cs: 85, ops: 82, mkt: 78 },
  { day: 'Sun', cs: 80, ops: 79, mkt: 75 },
];

const TOP_PERFORMERS = [
  { name: '张明', dept: '客服中心', score: 97.2, tasks: 156, trend: +3.1 },
  { name: '李华', dept: '运营中心', score: 95.8, tasks: 134, trend: +2.4 },
  { name: '王芳', dept: '客服中心', score: 94.5, tasks: 148, trend: +1.9 },
  { name: '陈伟', dept: '市场中心', score: 93.1, tasks: 98, trend: +0.8 },
  { name: '赵丽', dept: '运营中心', score: 92.7, tasks: 112, trend: -0.3 },
];

const BOTTLENECKS = [
  { issue: '工单高峰期响应延迟', severity: 'high', affected: '客服中心', suggestion: '增加高峰时段排班人数' },
  { issue: 'KOL 合同审批流程过长', severity: 'medium', affected: '市场中心', suggestion: '简化审批链路，授权主管直签' },
  { issue: '库存数据同步延迟', severity: 'medium', affected: '运营中心', suggestion: '优化数据同步频率至 5 分钟' },
  { issue: '跨部门协作沟通效率低', severity: 'low', affected: '全部', suggestion: '建立标准化跨部门协作流程' },
];

export default function OperationalEfficiency() {
  const [, navigate] = useLocation();
  const { t } = useI18n();
  const [timeRange, setTimeRange] = useState<'week' | 'month' | 'quarter'>('week');

  const totalMembers = CENTERS.reduce((s, c) => s + c.members, 0);
  const totalCompleted = CENTERS.reduce((s, c) => s + c.tasksCompleted, 0);
  const totalTasks = CENTERS.reduce((s, c) => s + c.tasksTotal, 0);
  const avgEfficiency = (CENTERS.reduce((s, c) => s + c.efficiency, 0) / CENTERS.length).toFixed(1);
  const avgSatisfaction = (CENTERS.reduce((s, c) => s + c.satisfaction, 0) / CENTERS.length).toFixed(1);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-zinc-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Gauge className="w-5 h-5 text-teal-400" />
            <h1 className="text-lg font-semibold">运营效率分析</h1>
          </div>
          <div className="flex items-center gap-2">
            {(['week', 'month', 'quarter'] as const).map(r => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  timeRange === r ? 'bg-teal-600/30 text-teal-300 border border-teal-500/30' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {r === 'week' ? '本周' : r === 'month' ? '本月' : '本季度'}
              </button>
            ))}
            <button
              onClick={() => toast.success('数据已刷新')}
              className="p-2 hover:bg-zinc-800 rounded-lg transition text-zinc-400 hover:text-zinc-200"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* KPI Overview Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
              <Users size={14} />
              <span>团队总人数</span>
            </div>
            <div className="text-2xl font-bold">{totalMembers}</div>
            <div className="text-xs text-zinc-500 mt-1">3 个中心</div>
          </div>
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
              <CheckCircle2 size={14} />
              <span>任务完成率</span>
            </div>
            <div className="text-2xl font-bold text-emerald-400">{((totalCompleted / totalTasks) * 100).toFixed(1)}%</div>
            <div className="text-xs text-zinc-500 mt-1">{totalCompleted}/{totalTasks} 任务</div>
          </div>
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
              <Gauge size={14} />
              <span>平均效率</span>
            </div>
            <div className="text-2xl font-bold text-teal-400">{avgEfficiency}%</div>
            <div className="text-xs text-emerald-500 mt-1">↑ 1.5% vs 上周</div>
          </div>
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 text-zinc-400 text-xs mb-2">
              <Award size={14} />
              <span>客户满意度</span>
            </div>
            <div className="text-2xl font-bold text-amber-400">{avgSatisfaction}%</div>
            <div className="text-xs text-emerald-500 mt-1">↑ 0.8% vs 上周</div>
          </div>
        </div>

        {/* Center Performance Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {CENTERS.map(center => {
            const completionRate = ((center.tasksCompleted / center.tasksTotal) * 100).toFixed(1);
            const humanEfficiency = (center.tasksCompleted / center.members).toFixed(0);
            return (
              <div key={center.name} className={`bg-gradient-to-br ${center.color} border ${center.borderColor} rounded-xl p-5`}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{center.icon}</span>
                    <h3 className="font-semibold">{center.name}</h3>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${center.trend >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                    {center.trend >= 0 ? '↑' : '↓'} {Math.abs(center.trend)}%
                  </span>
                </div>

                <div className="space-y-3">
                  {/* Efficiency Score */}
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-zinc-400">效率评分</span>
                      <span className={center.textColor}>{center.efficiency}%</span>
                    </div>
                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${
                          center.efficiency >= 85 ? 'bg-emerald-500' : center.efficiency >= 70 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${center.efficiency}%` }}
                      />
                    </div>
                  </div>

                  {/* Stats Grid */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-zinc-900/40 rounded-lg p-2">
                      <div className="text-zinc-500">人效比</div>
                      <div className="font-semibold mt-0.5">{humanEfficiency} 任务/人</div>
                    </div>
                    <div className="bg-zinc-900/40 rounded-lg p-2">
                      <div className="text-zinc-500">完成率</div>
                      <div className="font-semibold mt-0.5">{completionRate}%</div>
                    </div>
                    <div className="bg-zinc-900/40 rounded-lg p-2">
                      <div className="text-zinc-500">平均响应</div>
                      <div className="font-semibold mt-0.5">{center.avgResponseMin} min</div>
                    </div>
                    <div className="bg-zinc-900/40 rounded-lg p-2">
                      <div className="text-zinc-500">平均解决</div>
                      <div className="font-semibold mt-0.5">{center.avgResolutionMin} min</div>
                    </div>
                  </div>

                  {/* Team Size */}
                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    <Users size={12} />
                    <span>{center.members} 人</span>
                    <span className="text-zinc-600">·</span>
                    <span>满意度 {center.satisfaction}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Weekly Efficiency Trend Chart */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity size={16} className="text-teal-400" />
            <h3 className="font-semibold">周效率趋势</h3>
            <div className="ml-auto flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400" /> 客服</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> 运营</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-400" /> 市场</span>
            </div>
          </div>
          <div className="flex items-end gap-1 h-40">
            {WEEKLY_TREND.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex items-end justify-center gap-0.5 h-32">
                  <div className="w-2 bg-blue-500/60 rounded-t transition-all" style={{ height: `${(d.cs / 100) * 100}%` }} title={`客服 ${d.cs}%`} />
                  <div className="w-2 bg-emerald-500/60 rounded-t transition-all" style={{ height: `${(d.ops / 100) * 100}%` }} title={`运营 ${d.ops}%`} />
                  <div className="w-2 bg-purple-500/60 rounded-t transition-all" style={{ height: `${(d.mkt / 100) * 100}%` }} title={`市场 ${d.mkt}%`} />
                </div>
                <span className="text-[10px] text-zinc-500">{d.day}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Two Column: Top Performers + Bottlenecks */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Top Performers */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Award size={16} className="text-amber-400" />
              <h3 className="font-semibold">效率之星 Top 5</h3>
            </div>
            <div className="space-y-2">
              {TOP_PERFORMERS.map((p, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/50 transition">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    i === 0 ? 'bg-amber-500/20 text-amber-400' :
                    i === 1 ? 'bg-zinc-400/20 text-zinc-300' :
                    i === 2 ? 'bg-orange-500/20 text-orange-400' :
                    'bg-zinc-700/30 text-zinc-500'
                  }`}>{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{p.name}</span>
                      <span className="text-[10px] text-zinc-500">{p.dept}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                      <span>{p.tasks} 任务</span>
                      <span className={p.trend >= 0 ? 'text-emerald-500' : 'text-red-400'}>
                        {p.trend >= 0 ? '↑' : '↓'}{Math.abs(p.trend)}%
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-teal-400">{p.score}</div>
                    <div className="text-[10px] text-zinc-500">分</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottlenecks */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Target size={16} className="text-red-400" />
              <h3 className="font-semibold">效率瓶颈分析</h3>
            </div>
            <div className="space-y-3">
              {BOTTLENECKS.map((b, i) => (
                <div key={i} className="border border-zinc-700/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`w-2 h-2 rounded-full ${
                      b.severity === 'high' ? 'bg-red-500' : b.severity === 'medium' ? 'bg-amber-500' : 'bg-blue-500'
                    }`} />
                    <span className="text-sm font-medium">{b.issue}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-400 mb-2">
                    <span>影响：{b.affected}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                      b.severity === 'high' ? 'bg-red-500/15 text-red-400' :
                      b.severity === 'medium' ? 'bg-amber-500/15 text-amber-400' :
                      'bg-blue-500/15 text-blue-400'
                    }`}>
                      {b.severity === 'high' ? '高' : b.severity === 'medium' ? '中' : '低'}
                    </span>
                  </div>
                  <div className="flex items-start gap-1.5 text-xs">
                    <Zap size={12} className="text-emerald-500 shrink-0 mt-0.5" />
                    <span className="text-emerald-400/80">{b.suggestion}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Human Efficiency Comparison */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 size={16} className="text-indigo-400" />
            <h3 className="font-semibold">人效比对比</h3>
            <span className="text-xs text-zinc-500 ml-2">任务数 / 人</span>
          </div>
          <div className="space-y-3">
            {CENTERS.map(center => {
              const humanEff = center.tasksCompleted / center.members;
              const maxEff = Math.max(...CENTERS.map(c => c.tasksCompleted / c.members));
              return (
                <div key={center.name} className="flex items-center gap-3">
                  <span className="text-sm w-20 shrink-0">{center.icon} {center.name.replace('中心', '')}</span>
                  <div className="flex-1 h-6 bg-zinc-800 rounded-full overflow-hidden relative">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${
                        center.name === '客服中心' ? 'bg-blue-500/60' :
                        center.name === '运营中心' ? 'bg-emerald-500/60' : 'bg-purple-500/60'
                      }`}
                      style={{ width: `${(humanEff / maxEff) * 100}%` }}
                    />
                    <span className="absolute inset-0 flex items-center justify-center text-xs font-medium">
                      {humanEff.toFixed(1)} 任务/人
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-zinc-600 pb-6">
          RangerAI 运营效率分析 · 数据更新于 {new Date().toLocaleString('zh-CN')}
        </div>
      </div>
    </div>
  );
}
