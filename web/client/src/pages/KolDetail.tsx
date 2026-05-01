import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { useLocation, useRoute } from 'wouter';
import {
  ArrowLeft, Users, Globe, TrendingUp, Star, Calendar,
  DollarSign, BarChart3, Plus, Edit2, ExternalLink,
  Mail, Phone, MapPin, Tag, Clock, CheckCircle, XCircle,
  AlertCircle, Loader2, RefreshCw, Video, ShoppingBag, Eye, Heart, MessageCircle, Share2
} from 'lucide-react';
import { getAuthToken } from '@/lib/api';
import { logger } from "../lib/logger";


function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface Kol {
  id: number; name: string; platform: string; handle: string;
  followers: number; engagement_rate: number; category: string;
  country: string; language: string; contact_email: string;
  contact_phone: string; status: string; cooperation_status: string;
  notes: string; tags: string; created_at: string; updated_at: string;
  cooperations?: Cooperation[];
}

interface Cooperation {
  id: number; kol_id: number; campaign_name: string; campaign_type: string;
  start_date: string; end_date: string; budget: number; actual_cost: number;
  deliverables: string; performance_metrics: string; status: string;
  notes: string; created_by: string; created_at: string;
}

const API_BASE = '/api/kols';

const platformIcons: Record<string, string> = {
  youtube: '📺', tiktok: '🎵', instagram: '📸', twitter: '🐦',
  facebook: '📘', twitch: '🎮', Other: '🌐',
};

const STATUS_LABELS: Record<string, { key: string; color: string }> = {
  active: { key: 'kol.status.active', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
  inactive: { key: 'kol.status.inactive', color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30' },
  blacklisted: { key: 'kol.status.blacklisted', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  pending: { key: 'kol.status.pending', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
};

const COOP_STATUS_CFG: Record<string, { key: string; color: string; icon: typeof Clock }> = {
  planning: { key: 'kolDetail.coopStatus.planning', color: 'text-zinc-400 bg-zinc-800', icon: Clock },
  active: { key: 'kolDetail.coopStatus.active', color: 'text-blue-400 bg-blue-500/15', icon: AlertCircle },
  completed: { key: 'kolDetail.coopStatus.completed', color: 'text-emerald-400 bg-emerald-500/15', icon: CheckCircle },
  cancelled: { key: 'kolDetail.coopStatus.cancelled', color: 'text-red-400 bg-red-500/15', icon: XCircle },
};

function formatFollowers(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatCurrency(n: number): string {
  if (n >= 10000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + n.toLocaleString();
}

export default function KolDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute('/kols/:id');
  const { t } = useI18n();
  const kolId = params?.id;

  const [kol, setKol] = useState<Kol | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddCoop, setShowAddCoop] = useState(false);
  const [refreshingKol, setRefreshingKol] = useState(false);

  const fetchKol = useCallback(async () => {
    if (!kolId) return;
    try {
      const res = await fetch(`${API_BASE}/${kolId}`, { headers: authHeaders() });
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      setKol(data);
    } catch (e) {
      logger.error('Failed to fetch KOL:', e);
    } finally {
      setLoading(false);
    }
  }, [kolId]);

  useEffect(() => { fetchKol(); }, [fetchKol]);

  const addCooperation = async (data: Partial<Cooperation>) => {
    if (!kolId) return;
    try {
      await fetch(`${API_BASE}/${kolId}/cooperations`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      });
      setShowAddCoop(false);
      fetchKol();
    } catch (e) {
      logger.error('Failed to add cooperation:', e);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 size={32} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  if (!kol) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center text-zinc-400">
        <Users size={48} className="mb-4 text-zinc-600" />
        <p className="mb-4">{t('kolDetail.notFound')}</p>
        <button onClick={() => navigate('/kols')} className="text-emerald-400 hover:underline text-sm">
          {t('kolDetail.backToList')}
        </button>
      </div>
    );
  }

  const sl = STATUS_LABELS[kol.status] || STATUS_LABELS.active;
  const cooperations = kol.cooperations || [];
  const totalBudget = cooperations.reduce((s, c) => s + (c.budget || 0), 0);
  const totalCost = cooperations.reduce((s, c) => s + (c.actual_cost || 0), 0);
  const completedCoops = cooperations.filter(c => c.status === 'completed');
  const avgCostPerCoop = completedCoops.length > 0
    ? completedCoops.reduce((s, c) => s + (c.actual_cost || 0), 0) / completedCoops.length
    : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/kols')} className="p-2 hover:bg-zinc-800 rounded-lg transition">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-zinc-800 rounded-full flex items-center justify-center text-xl">
                {platformIcons[kol.platform] || '🌐'}
              </div>
              <div>
                <h1 className="text-lg font-semibold">{kol.name}</h1>
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span>{kol.platform}</span>
                  {kol.handle && <span>@{kol.handle}</span>}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setRefreshingKol(true);
                try {
                  await fetch(`${API_BASE}/${kolId}/refresh`, { method: 'POST', headers: authHeaders() });
                  fetchKol();
                } catch (e) { logger.error(e); }
                finally { setRefreshingKol(false); }
              }}
              disabled={refreshingKol}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-lg transition disabled:opacity-50"
              title={t('kol.refreshData')}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingKol ? 'animate-spin' : ''}`} />
              {refreshingKol ? t('kol.refreshing') : t('kol.refreshData')}
            </button>
            <span className={`text-xs px-2 py-1 rounded-full border ${sl.color}`}>{t(sl.key as any)}</span>
            {kol.handle && (
              <a href={`https://${kol.platform === 'youtube' ? 'youtube.com/@' : kol.platform === 'tiktok' ? 'tiktok.com/@' : kol.platform === 'instagram' ? 'instagram.com/' : kol.platform === 'twitter' ? 'x.com/' : ''}${kol.handle}`}
                target="_blank" rel="noopener noreferrer"
                className="p-2 hover:bg-zinc-800 rounded-lg transition">
                <ExternalLink className="w-4 h-4 text-zinc-400" />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* KOL Info Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-blue-400" />
              <span className="text-xs text-zinc-500">{t('kol.followers')}</span>
            </div>
            <div className="text-2xl font-bold">{formatFollowers(kol.followers)}</div>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-zinc-500">{t('kol.engagementRate')}</span>
            </div>
            <div className="text-2xl font-bold">{kol.engagement_rate > 0 ? `${kol.engagement_rate}%` : '—'}</div>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Star className="w-4 h-4 text-amber-400" />
              <span className="text-xs text-zinc-500">{t('kolDetail.coopCount')}</span>
            </div>
            <div className="text-2xl font-bold">{cooperations.length}</div>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-4 h-4 text-purple-400" />
              <span className="text-xs text-zinc-500">{t('kolDetail.totalInvestment')}</span>
            </div>
            <div className="text-2xl font-bold">{formatCurrency(totalCost)}</div>
          </div>
        </div>

        {/* Detail Info */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* Contact & Basic Info */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
              <Globe size={16} className="text-blue-400" />
              {t('kol.form.name')}
            </h3>
            <div className="space-y-2.5 text-sm">
              {kol.category && (
                <div className="flex items-center gap-2">
                  <Tag className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-400">{t('kol.form.category')}：</span>
                  <span>{kol.category}</span>
                </div>
              )}
              {kol.country && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-400">{t('kol.form.country')}：</span>
                  <span>{kol.country}</span>
                </div>
              )}
              {kol.language && (
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-400">{t('kol.form.language')}：</span>
                  <span>{kol.language}</span>
                </div>
              )}
              {kol.contact_email && (
                <div className="flex items-center gap-2">
                  <Mail className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-400">{t('kol.form.email')}：</span>
                  <a href={`mailto:${kol.contact_email}`} className="text-emerald-400 hover:underline">{kol.contact_email}</a>
                </div>
              )}
              {kol.contact_phone && (
                <div className="flex items-center gap-2">
                  <Phone className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-zinc-400">{t('kol.form.handle')}：</span>
                  <span>{kol.contact_phone}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                <span className="text-zinc-400">{t('kolDetail.addedAt')}：</span>
                <span>{new Date(kol.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {/* ROI Analysis */}
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
              <BarChart3 size={16} className="text-purple-400" />
              {t('kolDetail.roiAnalysis')}
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400">{t('kolDetail.totalBudget')}</span>
                <span className="font-medium">{formatCurrency(totalBudget)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400">{t('kolDetail.actualSpend')}</span>
                <span className="font-medium">{formatCurrency(totalCost)}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400">{t('kolDetail.budgetUtilization')}</span>
                <span className="font-medium">
                  {totalBudget > 0 ? `${((totalCost / totalBudget) * 100).toFixed(0)}%` : '—'}
                </span>
              </div>
              <div className="border-t border-zinc-800 pt-3 flex justify-between items-center text-sm">
                <span className="text-zinc-400">{t('kolDetail.avgCoopCost')}</span>
                <span className="font-medium text-emerald-400">{avgCostPerCoop > 0 ? formatCurrency(avgCostPerCoop) : '—'}</span>
              </div>
              <div className="flex justify-between items-center text-sm">
                <span className="text-zinc-400">{t('kolDetail.completionRate')}</span>
                <span className="font-medium">
                  {cooperations.length > 0 ? `${((completedCoops.length / cooperations.length) * 100).toFixed(0)}%` : '—'}
                </span>
              </div>
              {kol.engagement_rate > 0 && kol.followers > 0 && (
                <div className="flex justify-between items-center text-sm">
                  <span className="text-zinc-400">{t('kolDetail.estReach')}</span>
                  <span className="font-medium text-blue-400">
                    {formatFollowers(Math.round(kol.followers * kol.engagement_rate / 100))}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* TikTok Performance Section (for TikTok KOLs) */}
        {kol.platform === 'tiktok' && (
          <TikTokPerformancePanel kolName={kol.name} followers={kol.followers} engagementRate={kol.engagement_rate} />
        )}

        {/* Notes */}
        {kol.notes && (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
            <h3 className="text-sm font-medium text-zinc-300 mb-2">{t('kol.form.notes')}</h3>
            <p className="text-sm text-zinc-400 whitespace-pre-wrap">{kol.notes}</p>
          </div>
        )}

        {/* Cooperation History */}
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Calendar size={16} className="text-amber-400" />
              {t('kolDetail.coopHistoryTitle')}
            </h3>
            <button
              onClick={() => setShowAddCoop(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium transition"
            >
              <Plus className="w-3.5 h-3.5" /> {t('kolDetail.addCoopRecord')}
            </button>
          </div>

          {cooperations.length === 0 ? (
            <div className="text-center py-8">
              <Calendar className="w-10 h-10 text-zinc-700 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">{t('kol.coop.none')}</p>
              <button onClick={() => setShowAddCoop(true)} className="mt-2 text-emerald-500 text-xs hover:underline">
                {t('kolDetail.addFirstCoop')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {cooperations.map(coop => {
                const cs = COOP_STATUS_CFG[coop.status] || COOP_STATUS_CFG.planning;
                const Icon = cs.icon;
                return (
                  <div key={coop.id} className="relative pl-6 pb-3 border-l-2 border-zinc-800 last:border-l-0">
                    {/* Timeline dot */}
                    <div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-zinc-600" />
                    
                    <div className="bg-zinc-800/40 rounded-lg p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h4 className="text-sm font-medium">{coop.campaign_name}</h4>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${cs.color}`}>
                              <Icon className="w-2.5 h-2.5 inline mr-0.5" />{t(cs.key as any)}
                            </span>
                            <span className="text-[10px] text-zinc-500">{coop.campaign_type}</span>
                          </div>
                        </div>
                        <div className="text-right text-xs text-zinc-500">
                          {coop.start_date && <div>{coop.start_date}</div>}
                          {coop.end_date && <div>→ {coop.end_date}</div>}
                        </div>
                      </div>
                      <div className="flex gap-4 text-xs text-zinc-400">
                        {coop.budget > 0 && <span>{t('kolDetail.coopBudget')}: {formatCurrency(coop.budget)}</span>}
                        {coop.actual_cost > 0 && <span>{t('kolDetail.coopActual')}: {formatCurrency(coop.actual_cost)}</span>}
                      </div>
                      {coop.deliverables && (
                        <p className="text-xs text-zinc-500 mt-1.5">{coop.deliverables}</p>
                      )}
                      {coop.notes && (
                        <p className="text-xs text-zinc-600 mt-1 italic">{coop.notes}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Add Cooperation Modal */}
      {showAddCoop && (
        <AddCooperationModal
          onClose={() => setShowAddCoop(false)}
          onSave={addCooperation}
        />
      )}
    </div>
  );
}

function AddCooperationModal({ onClose, onSave }: { onClose: () => void; onSave: (data: any) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    campaign_name: '', campaign_type: 'promotion', start_date: '',
    end_date: '', budget: 0, actual_cost: 0, deliverables: '',
    status: 'planning', notes: '',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg mx-4 p-6 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">{t('kolDetail.addCoopRecord')}</h2>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.campaignName')} *</label>
            <input
              value={form.campaign_name}
              onChange={e => setForm(f => ({ ...f, campaign_name: e.target.value }))}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              placeholder={t('kolDetail.form.campaignName')}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.campaignType')}</label>
              <select
                value={form.campaign_type}
                onChange={e => setForm(f => ({ ...f, campaign_type: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="promotion">{t('kolDetail.campaignType.promotion')}</option>
                <option value="review">{t('kolDetail.campaignType.review')}</option>
                <option value="livestream">{t('kolDetail.campaignType.livestream')}</option>
                <option value="sponsored">{t('kolDetail.campaignType.sponsored')}</option>
                <option value="affiliate">{t('kolDetail.campaignType.affiliate')}</option>
                <option value="other">{t('kolDetail.campaignType.other')}</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.campaignStatus')}</label>
              <select
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm"
              >
                <option value="planning">{t('kolDetail.coopStatus.planning')}</option>
                <option value="active">{t('kolDetail.coopStatus.active')}</option>
                <option value="completed">{t('kolDetail.coopStatus.completed')}</option>
                <option value="cancelled">{t('kolDetail.coopStatus.cancelled')}</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.startDate')}</label>
              <input
                type="date"
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.endDate')}</label>
              <input
                type="date"
                value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.budget')}</label>
              <input
                type="number"
                value={form.budget}
                onChange={e => setForm(f => ({ ...f, budget: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.actualCost')}</label>
              <input
                type="number"
                value={form.actual_cost}
                onChange={e => setForm(f => ({ ...f, actual_cost: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{t('kolDetail.form.deliverables')}</label>
            <input
              value={form.deliverables}
              onChange={e => setForm(f => ({ ...f, deliverables: e.target.value }))}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500"
              placeholder={t('kolDetail.form.delivPlaceholder')}
            />
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{t('kol.form.notes')}</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm focus:outline-none focus:border-emerald-500 resize-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition">{t('kol.form.cancel')}</button>
          <button
            onClick={() => form.campaign_name && onSave(form)}
            disabled={!form.campaign_name}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-sm font-medium transition"
          >
            {t('kol.form.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TikTok Performance Panel ──────────────────────────────

interface TikTokVideo {
  id: string;
  title: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  gmv: number;
  orders: number;
  conversionRate: number;
  postedAt: string;
}

function generateMockTikTokData(kolName: string, followers: number, engagementRate: number) {
  const baseViews = followers * (engagementRate / 100) * (0.5 + Math.random() * 0.5);
  const videos: TikTokVideo[] = Array.from({ length: 6 }, (_, i) => {
    const views = Math.round(baseViews * (0.3 + Math.random() * 1.4));
    const likes = Math.round(views * (0.02 + Math.random() * 0.08));
    const comments = Math.round(likes * (0.05 + Math.random() * 0.15));
    const shares = Math.round(likes * (0.02 + Math.random() * 0.06));
    const orders = Math.round(views * (0.001 + Math.random() * 0.005));
    const gmv = orders * (80 + Math.random() * 120);
    const d = new Date();
    d.setDate(d.getDate() - i * 3 - Math.floor(Math.random() * 3));
    return {
      id: `v${i}`,
      title: [`${kolName} 游戏充值省钱攻略`, `Lootbar 限时优惠开箱`, `FC金币最低价购买教程`, `Steam充值卡折扣分享`, `游戏礼品卡对比评测`, `新手必看 游戏充值指南`][i],
      views, likes, comments, shares, gmv, orders,
      conversionRate: orders > 0 ? (orders / views) * 100 : 0,
      postedAt: d.toISOString().slice(0, 10),
    };
  });

  const totalGmv = videos.reduce((s, v) => s + v.gmv, 0);
  const totalViews = videos.reduce((s, v) => s + v.views, 0);
  const totalOrders = videos.reduce((s, v) => s + v.orders, 0);
  const avgConversion = totalViews > 0 ? (totalOrders / totalViews) * 100 : 0;

  return { videos, totalGmv, totalViews, totalOrders, avgConversion };
}

function formatNum(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(Math.round(n));
}

function TikTokPerformancePanel({ kolName, followers, engagementRate }: { kolName: string; followers: number; engagementRate: number }) {
  const { t } = useI18n();
  const [data] = useState(() => generateMockTikTokData(kolName, followers || 100000, engagementRate || 3));

  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-medium text-zinc-300 mb-4 flex items-center gap-2">
        <Video size={16} className="text-rose-400" />
        TikTok 带货效果分析
        <span className="text-[10px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded-full">Mock</span>
      </h3>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">总GMV</p>
          <p className="text-lg font-bold text-zinc-100">¥{formatNum(data.totalGmv)}</p>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">总播放</p>
          <p className="text-lg font-bold text-zinc-100">{formatNum(data.totalViews)}</p>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">总订单</p>
          <p className="text-lg font-bold text-zinc-100">{data.totalOrders.toLocaleString()}</p>
        </div>
        <div className="bg-zinc-800/50 rounded-lg p-3">
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider">平均转化率</p>
          <p className="text-lg font-bold text-emerald-400">{data.avgConversion.toFixed(2)}%</p>
        </div>
      </div>

      {/* Video Performance Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="text-left px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">视频</th>
              <th className="text-right px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                <Eye size={10} className="inline mr-0.5" />播放
              </th>
              <th className="text-right px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                <Heart size={10} className="inline mr-0.5" />点赞
              </th>
              <th className="text-right px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                <ShoppingBag size={10} className="inline mr-0.5" />订单
              </th>
              <th className="text-right px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">GMV</th>
              <th className="text-right px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">转化率</th>
              <th className="text-right px-3 py-2 text-[10px] font-medium text-zinc-500 uppercase tracking-wider">日期</th>
            </tr>
          </thead>
          <tbody>
            {data.videos.map(v => (
              <tr key={v.id} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                <td className="px-3 py-2 text-zinc-200 font-medium max-w-[200px] truncate">{v.title}</td>
                <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">{formatNum(v.views)}</td>
                <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">{formatNum(v.likes)}</td>
                <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">{v.orders}</td>
                <td className="px-3 py-2 text-right text-zinc-300 tabular-nums">¥{formatNum(v.gmv)}</td>
                <td className="px-3 py-2 text-right">
                  <span className={`tabular-nums font-medium ${v.conversionRate >= 0.3 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                    {v.conversionRate.toFixed(2)}%
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-zinc-500 text-xs">{v.postedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-zinc-600 mt-3 text-center">
        数据来源：Mock 数据（待对接 TikTok Shop API）
      </p>
    </div>
  );
}
