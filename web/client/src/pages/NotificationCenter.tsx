import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import {
  ArrowLeft, Bell, BellOff, Check, CheckCheck, Trash2,
  Ticket, Crown, AlertCircle, Info, Clock, Volume2, VolumeX
} from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { formatRelativeTime } from '@/lib/dateUtils';
import { getAuthToken } from '@/lib/api';
import { logger } from "../lib/logger";


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface Notification {
  id: number;
  title: string;
  content: string;
  type: string;
  target_user: string | null;
  related_type: string | null;
  related_id: number | null;
  is_read: number;
  created_at: string;
}

const API_BASE = '/api/notifications';

function getTypeConfig(t: (k: string) => string): Record<string, { icon: typeof Bell; color: string; label: string }> {
  return {
    ticket: { icon: Ticket, color: 'text-orange-400 bg-orange-500/10', label: t('notif.typeTicket') },
    kol: { icon: Crown, color: 'text-yellow-400 bg-yellow-500/10', label: t('notif.typeKol') },
    system: { icon: Info, color: 'text-blue-400 bg-blue-500/10', label: t('notif.typeSystem') },
    alert: { icon: AlertCircle, color: 'text-red-400 bg-red-500/10', label: t('notif.typeAlert') },
  };
}

// timeAgo replaced by unified formatRelativeTime from dateUtils

export default function NotificationCenter() {
  const { t, locale } = useI18n();
  const [, navigate] = useLocation();
  const typeConfig = getTypeConfig(t as (k: string) => string);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem('notif-sound') !== 'off'; } catch { return true; }
  });
  const toggleSound = () => {
    setSoundEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('notif-sound', next ? 'on' : 'off'); } catch {}
      toast.success(next ? '通知声音已开启' : '通知声音已关闭');
      return next;
    });
  };

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch(API_BASE, { headers: authHeaders() });
      const data = await res.json();
      const notifs = data.notifications || [];
      setNotifications(notifs);
      // Derive unread count from actual data to prevent inconsistency (unread > total)
      const actualUnread = notifs.filter((n: Notification) => !n.is_read).length;
      const serverUnread = data.unread_count || 0;
      // Use the smaller of server-reported and actual to prevent unread > total
      setUnreadCount(Math.min(serverUnread, actualUnread, notifs.length));
      setTotalCount(notifs.length);
    } catch (e) {
      logger.error('Failed to fetch notifications:', e);
      toast.error(t('notif.fetchError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const markAsRead = async (id: number) => {
    try {
      await fetch(`${API_BASE}/${id}/read`, { method: 'PATCH', headers: authHeaders() });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: 1 } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (e) {
      logger.error('Failed to mark as read:', e);
      toast.error(t('notif.markReadError'));
    }
  };

  const markAllAsRead = async () => {
    try {
      await fetch(`${API_BASE}/read-all`, { method: 'POST', headers: authHeaders() });
      setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
      setUnreadCount(0);
      toast.success('OK');
    } catch (e) {
      logger.error('Failed to mark all as read:', e);
      toast.error('Failed');
    }
  };

  const deleteNotification = async (id: number) => {
    try {
      await fetch(`${API_BASE}/${id}`, { method: 'DELETE', headers: authHeaders() });
      const removed = notifications.find(n => n.id === id);
      setNotifications(prev => prev.filter(n => n.id !== id));
      if (removed && !removed.is_read) setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (e) {
      logger.error('Failed to delete notification:', e);
      toast.error(t('notif.deleteError'));
    }
  };

  const handleNotificationClick = (n: Notification) => {
    if (!n.is_read) markAsRead(n.id);
    if (n.related_type === 'ticket' && n.related_id) {
      navigate('/tickets');
    } else if (n.related_type === 'kol' && n.related_id) {
      navigate(`/kols/${n.related_id}`);
    }
  };

  const filtered = notifications
    .filter(n => filter === 'unread' ? !n.is_read : true)
    .filter(n => typeFilter === 'all' ? true : n.type === typeFilter);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-zinc-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold">{t('notif.title')}</h1>
            {unreadCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSound}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-blue-400 hover:bg-zinc-800 rounded-lg transition"
              title={soundEnabled ? '关闭通知声音' : '开启通知声音'}
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              {soundEnabled ? '声音开' : '声音关'}
            </button>
            {unreadCount > 0 && (
              <button
                onClick={markAllAsRead}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-lg transition"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                {t('notif.markAllRead')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6">
        {/* Filter Tabs */}
        <div className="flex flex-col gap-3 mb-6">
          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                filter === 'all'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              {t('notif.all')} ({totalCount})
            </button>
            <button
              onClick={() => setFilter('unread')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                filter === 'unread'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
              }`}
            >
              {t('notif.unread')} ({unreadCount})
            </button>
          </div>
          {/* Type Category Filter */}
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
            {['all', 'ticket', 'kol', 'system', 'alert'].map(type => {
              const tc = type !== 'all' ? typeConfig[type] : null;
              const count = type === 'all' ? notifications.length : notifications.filter(n => n.type === type).length;
              return (
                <button
                  key={type}
                  onClick={() => setTypeFilter(type)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
                    typeFilter === type
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  {tc && (() => { const Icon = tc.icon; return <Icon size={12} />; })()}
                  {type === 'all' ? '全部类型' : tc?.label || type}
                  <span className="text-[10px] opacity-60">({count})</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Notification List */}
        {loading ? (
          <div className="space-y-3">
            {[1,2,3,4].map(i => (
              <div key={i} className="p-4 rounded-xl border border-zinc-800/50 bg-zinc-900/30">
                <div className="flex items-start gap-3">
                  <Skeleton className="w-8 h-8 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title={filter === 'unread' ? t('notif.emptyUnread') : t('notif.empty')}
            description={filter === 'unread' ? t('notif.emptyUnreadDesc') : t('notif.emptyDesc')}
          />
        ) : (
          <div className="space-y-2">
            {filtered.map(n => {
              const tc = typeConfig[n.type] || typeConfig.system;
              const Icon = tc.icon;
              return (
                <div
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  className={`group p-4 rounded-xl border transition cursor-pointer ${
                    n.is_read
                      ? 'border-zinc-800/50 bg-zinc-900/30 hover:border-zinc-700'
                      : 'border-zinc-700 bg-zinc-900/80 hover:border-zinc-600'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tc.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {!n.is_read && (
                          <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                        )}
                        <h3 className={`text-sm font-medium truncate ${n.is_read ? 'text-zinc-400' : 'text-zinc-100'}`}>
                          {n.title}
                        </h3>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${tc.color}`}>{tc.label}</span>
                      </div>
                      <p className={`text-xs leading-relaxed ${n.is_read ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        {n.content}
                      </p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-zinc-600 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatRelativeTime(n.created_at, locale, t as (k: string) => string)}
                        </span>
                        {n.target_user && (
                          <span className="text-[10px] text-zinc-600">
                            {n.target_user}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0">
                      {!n.is_read && (
                        <button
                          onClick={(e) => { e.stopPropagation(); markAsRead(n.id); }}
                          className="p-1.5 hover:bg-zinc-800 rounded-lg transition"
                          title={t('notif.markRead')}
                          aria-label={t('notif.markRead')}
                        >
                          <Check className="w-3.5 h-3.5 text-zinc-500 hover:text-emerald-400" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteNotification(n.id); }}
                        className="p-1.5 hover:bg-zinc-800 rounded-lg transition"
                        title={t('notif.delete')}
                        aria-label={t('notif.delete')}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-zinc-500 hover:text-red-400" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
