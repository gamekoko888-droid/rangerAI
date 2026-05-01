/**
 * generateMockData.ts - Mock data generator for CEO Dashboard
 * Extracted from CeoDashboard.tsx (Iter-59)
 * TD-031: Added missing imports and type definitions
 */
import {
  Target, Zap, Building2, ShoppingCart, Truck,
  Headphones, Crown, Users, DollarSign, TrendingUp
} from "lucide-react";

// --- Types (mirrored from CeoDashboard.tsx) ---
interface Alert {
  id: string;
  type: "warning" | "error" | "info";
  title: string;
  description: string;
  center: string;
  time: string;
  resolved: boolean;
}

interface TeamStatus {
  name: string;
  center: string;
  headcount: number;
  activeToday: number;
  tasksCompleted: number;
  tasksTotal: number;
  status: "normal" | "busy" | "idle";
}

interface MilestoneItem {
  id: string;
  title: string;
  description: string;
  deadline: string;
  status: "completed" | "in-progress" | "upcoming" | "at-risk";
  progress: number;
  owner: string;
  category: "tiktok" | "coins" | "ops" | "tech";
}

interface CenterData {
  id: string;
  name: string;
  shortName: string;
  icon: typeof Building2;
  color: string;
  bgColor: string;
  borderColor: string;
  headcount: number;
  revenue: number;
  revenueChange: number;
  orders: number;
  ordersChange: number;
  teams: TeamStatus[];
  highlights: string[];
}

function generateMockData(): {
  centers: CenterData[];
  alerts: Alert[];
  todayMetrics: { label: string; value: string; change: number; icon: typeof TrendingUp; color: string }[];
  milestones: MilestoneItem[];
} {
  const centers: CenterData[] = [
    {
      id: 'baoliang',
      name: '豹量引擎中心',
      shortName: '豹量',
      icon: Target,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
      borderColor: 'border-blue-500/20',
      headcount: 30,
      revenue: 2847500,
      revenueChange: 12.5,
      orders: 18432,
      ordersChange: 8.3,
      teams: [
        {
          name: 'CPS推广组',
          center: '豹量引擎',
          headcount: 10,
          activeToday: 8,
          tasksCompleted: 45,
          tasksTotal: 52,
          status: 'normal',
        },
        {
          name: 'FC金币组',
          center: '豹量引擎',
          headcount: 20,
          activeToday: 18,
          tasksCompleted: 156,
          tasksTotal: 170,
          status: 'busy',
        },
      ],
      highlights: [
        '今日CPS推广新增3个主播合作',
        'FC金币回收量达成12.8万枚',
        'Lootbar FC业务订单量同比增长15%',
      ],
    },
    {
      id: 'cuantianhuo',
      name: '窜天猴中心',
      shortName: '窜天猴',
      icon: Zap,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/20',
      headcount: 65,
      revenue: 5632100,
      revenueChange: -2.1,
      orders: 42856,
      ordersChange: 5.7,
      teams: [
        {
          name: '直充组',
          center: '窜天猴',
          headcount: 10,
          activeToday: 9,
          tasksCompleted: 89,
          tasksTotal: 95,
          status: 'normal',
        },
        {
          name: '代充组',
          center: '窜天猴',
          headcount: 40,
          activeToday: 35,
          tasksCompleted: 312,
          tasksTotal: 350,
          status: 'busy',
        },
        {
          name: 'TikTok运营组',
          center: '窜天猴',
          headcount: 15,
          activeToday: 12,
          tasksCompleted: 28,
          tasksTotal: 35,
          status: 'normal',
        },
      ],
      highlights: [
        '代充组今日处理订单312单，完成玉89%',
        'TikTok店铺新增2个KOL合作意向',
        '直充供应链稳定，售后工单下降8%',
      ],
    },
    {
      id: 'general',
      name: '综合管理中心',
      shortName: '综管',
      icon: Building2,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
      headcount: 10,
      revenue: 0,
      revenueChange: 0,
      orders: 0,
      ordersChange: 0,
      teams: [
        {
          name: '财法税组',
          center: '综合管理',
          headcount: 6,
          activeToday: 5,
          tasksCompleted: 18,
          tasksTotal: 22,
          status: 'normal',
        },
        {
          name: '行政组',
          center: '综合管理',
          headcount: 4,
          activeToday: 4,
          tasksCompleted: 12,
          tasksTotal: 15,
          status: 'normal',
        },
      ],
      highlights: [
        '本月财务报表已完成审核',
        '新合同审批流程优化完成',
        '员工社保缴纳已全部完成',
      ],
    },
  ];

  const alerts: Alert[] = [
    {
      id: '1',
      type: 'warning',
      title: '代充组工单积压',
      description: '待处理工单超过50单，建议调配人力支援',
      center: '窜天猴中心',
      time: '15分钟前',
      resolved: false,
    },
    {
      id: '2',
      type: 'error',
      title: 'FC金币库存低于安全线',
      description: '当前库存仅5.2万枚，低于安全线8万枚，需要加快回收',
      center: '豹量引擎中心',
      time: '1小时前',
      resolved: false,
    },
    {
      id: '3',
      type: 'info',
      title: 'TikTok KOL合作即将到期',
      description: '3个KOL合作协议将在7天内到期，需要跟进续约',
      center: '窜天猴中心',
      time: '2小时前',
      resolved: false,
    },
    {
      id: '4',
      type: 'warning',
      title: '直充供应商响应延迟',
      description: '主要供应商响应时间超过2小时，影响发货效率',
      center: '窜天猴中心',
      time: '30分钟前',
      resolved: false,
    },
  ];

  const todayMetrics = [
    { label: '今日订单', value: '61,288', change: 6.8, icon: ShoppingCart, color: 'text-blue-400' },
    { label: '今日发货', value: '58,921', change: 4.2, icon: Truck, color: 'text-emerald-400' },
    { label: '客服工单', value: '127', change: -8.5, icon: Headphones, color: 'text-amber-400' },
    { label: 'KOL合作', value: '48', change: 12.0, icon: Crown, color: 'text-purple-400' },
    { label: '在线员工', value: '91/105', change: 0, icon: Users, color: 'text-cyan-400' },
    { label: '今日GMV', value: '¥8.48M', change: 3.7, icon: DollarSign, color: 'text-rose-400' },
  ];

  const milestones: MilestoneItem[] = [
    {
      id: 'm1',
      title: '美区店铺加白',
      description: 'TikTok Shop 美区店铺最终选择与加白审核',
      deadline: '2026-03-25',
      status: 'in-progress',
      progress: 65,
      owner: 'TikTok运营组',
      category: 'tiktok',
    },
    {
      id: 'm2',
      title: '直播间搭建',
      description: '完成美区直播间硬件采购、场景搭建与测试',
      deadline: '2026-03-20',
      status: 'at-risk',
      progress: 40,
      owner: 'TikTok运营组',
      category: 'tiktok',
    },
    {
      id: 'm3',
      title: 'KOL分润标准化表',
      description: '制定并发布KOL分润标准化协议模板',
      deadline: '2026-03-18',
      status: 'in-progress',
      progress: 80,
      owner: '豹量引擎',
      category: 'tiktok',
    },
    {
      id: 'm4',
      title: '东南亚DC上线',
      description: '东南亚分发中心上线运营，对接本地物流',
      deadline: '2026-04-15',
      status: 'upcoming',
      progress: 20,
      owner: '窜天猴中心',
      category: 'ops',
    },
    {
      id: 'm5',
      title: 'FC金币库存监控系统',
      description: '完成EA封号动态监控与异常损耗率预警',
      deadline: '2026-03-30',
      status: 'in-progress',
      progress: 55,
      owner: '豹量引擎',
      category: 'coins',
    },
    {
      id: 'm6',
      title: 'RangerAI全功能上线',
      description: 'CEO看板、数据分析、日报分析模块全部对接实数据',
      deadline: '2026-03-28',
      status: 'in-progress',
      progress: 45,
      owner: 'Manus + Ranger',
      category: 'tech',
    },
  ];

  return { centers, alerts, todayMetrics, milestones };
}

// ─── Helper Components ──────────────────────────────────────

