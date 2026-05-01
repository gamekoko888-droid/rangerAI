/**
 * Breadcrumb — 全局面包屑导航组件
 * 自动根据当前路由生成面包屑路径
 */

import { useLocation } from 'wouter';
import { ChevronRight, Home } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

const ROUTE_LABELS: Record<string, { zh: string; en: string }> = {
  '/': { zh: '首页', en: 'Home' },
  '/knowledge': { zh: '知识库', en: 'Knowledge Base' },
  '/search-debug': { zh: '搜索调试', en: 'Search Debug' },
  '/workflows': { zh: '工作流', en: 'Workflows' },
  '/team': { zh: '团队管理', en: 'Team' },
  '/tasks': { zh: '任务队列', en: 'Tasks' },
  '/admin': { zh: '管理控制台', en: 'Admin' },
  '/tickets': { zh: '工单管理', en: 'Tickets' },
  '/kols': { zh: 'KOL 管理', en: 'KOL Manager' },
  '/notifications': { zh: '通知中心', en: 'Notifications' },
  '/ceo': { zh: 'CEO 看板', en: 'CEO Dashboard' },
  '/data-analytics': { zh: '数据分析', en: 'Data Analytics' },
  '/daily-reports': { zh: '日报分析', en: 'Daily Reports' },
  '/tiktok-partners': { zh: 'TikTok 达人', en: 'TikTok Partners' },
  '/tiktok-scripts': { zh: '文案生成', en: 'Script Gen' },
  '/inventory': { zh: '库存监控', en: 'Inventory' },
  '/ops-efficiency': { zh: '运营效率', en: 'Ops Efficiency' },
  '/stats': { zh: '统计', en: 'Stats' },
  '/prompts': { zh: '提示词模板', en: 'Prompts' },
  '/invite-codes': { zh: '邀请码', en: 'Invite Codes' },
};

export function Breadcrumb() {
  const [location, navigate] = useLocation();
  const { locale } = useI18n();

  // Don't show breadcrumb on home/chat page or login page
  if (location === '/' || location === '/login') return null;

  const isZh = locale.startsWith('zh');
  const items: BreadcrumbItem[] = [
    { label: isZh ? '首页' : 'Home', path: '/' },
  ];

  // Handle dynamic routes like /kols/:id
  const basePath = location.replace(/\/\d+$/, '');
  const routeInfo = ROUTE_LABELS[location] || ROUTE_LABELS[basePath];

  if (routeInfo) {
    items.push({ label: isZh ? routeInfo.zh : routeInfo.en });
  }

  // If it's a detail page (e.g., /kols/123), add the parent
  if (basePath !== location && ROUTE_LABELS[basePath]) {
    const parentInfo = ROUTE_LABELS[basePath];
    items[items.length - 1] = { label: isZh ? parentInfo.zh : parentInfo.en, path: basePath };
    items.push({ label: isZh ? '详情' : 'Detail' });
  }

  return (
    <nav className="flex items-center gap-1 text-xs text-zinc-500 px-4 sm:px-6 py-2 bg-zinc-950/50 border-b border-zinc-800/50">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i === 0 && <Home size={12} className="text-zinc-600" />}
          {i > 0 && <ChevronRight size={12} className="text-zinc-700" />}
          {item.path ? (
            <button
              onClick={() => navigate(item.path!)}
              className="hover:text-zinc-300 transition-colors"
            >
              {item.label}
            </button>
          ) : (
            <span className="text-zinc-400">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
