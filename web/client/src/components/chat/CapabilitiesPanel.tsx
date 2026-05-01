/**
 * CapabilitiesPanel — Displays OpenClaw Skills, Tools, Providers, and System Capabilities.
 * Slides in from the left as an overlay panel.
 * Skills can be clicked to view details or invoke directly.
 * Iter-54: Added Provider health tab, Skill detail panel, visual enhancements.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useI18n } from '../../lib/i18n';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useChatActions } from '../../hooks/useChatActions';
import { useLocation } from 'wouter';
import { fetchProviderHealth, type ProviderStatus, type ProviderHealthResponse } from '../../lib/api';
import {
  X, Search, Terminal, Globe, FileText, Image, Brain,
  Code, Shield, Cpu, Zap, Wrench, Bot, Volume2,
  Database, Layers, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Sparkles, Activity,
  Play, ArrowRight, RefreshCw, AlertTriangle,
  Clock, Server, ExternalLink, Info, ChevronLeft,
  Wifi, WifiOff, KeyRound,
} from 'lucide-react';
import { logger } from "../../lib/logger";

// ─── Provider display config ───────────────────────────────

const PROVIDER_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode; gradient: string }> = {
  openai: { label: 'OpenAI', color: 'text-emerald-400', icon: <Sparkles size={18} />, gradient: 'from-emerald-500/20 to-emerald-500/5' },
  google: { label: 'Google AI', color: 'text-blue-400', icon: <Globe size={18} />, gradient: 'from-blue-500/20 to-blue-500/5' },
  anthropic: { label: 'Anthropic', color: 'text-orange-400', icon: <Brain size={18} />, gradient: 'from-orange-500/20 to-orange-500/5' },

};

function getProviderStatusBadge(status: string) {
  switch (status) {
    case 'ok':
      return { label: 'Online', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', icon: <CheckCircle2 size={12} /> };
    case 'error':
      return { label: 'Error', color: 'bg-red-500/20 text-red-400 border-red-500/30', icon: <AlertTriangle size={12} /> };
    case 'no_key':
      return { label: 'No Key', color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: <KeyRound size={12} /> };
    case 'timeout':
      return { label: 'Timeout', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', icon: <Clock size={12} /> };
    default:
      return { label: status, color: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: <Info size={12} /> };
  }
}

// ─── Tool category config ────────────────────────────────────

interface ToolCategory {
  label: string;
  icon: React.ReactNode;
  color: string;
  tools: string[];
}

type TranslationFn = (key: any) => string;

function getToolCategories(t: TranslationFn): ToolCategory[] {
  return [
    { label: t('cap.toolCat.codeExec'), icon: <Terminal size={14} />, color: 'text-emerald-400', tools: ['exec', 'process', 'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'session_status'] },
    { label: t('cap.toolCat.fileOps'), icon: <FileText size={14} />, color: 'text-blue-400', tools: ['read', 'write', 'edit', 'apply_patch'] },
    { label: t('cap.toolCat.browser'), icon: <Globe size={14} />, color: 'text-cyan-400', tools: ['browser'] },
    { label: t('cap.toolCat.searchEngine'), icon: <Search size={14} />, color: 'text-amber-400', tools: ['web_search', 'web_fetch'] },
    { label: t('cap.toolCat.imageProc'), icon: <Image size={14} />, color: 'text-pink-400', tools: ['image', 'canvas'] },
    { label: t('cap.toolCat.voiceSynth'), icon: <Volume2 size={14} />, color: 'text-purple-400', tools: ['tts'] },
    { label: t('cap.toolCat.multiAgent'), icon: <Bot size={14} />, color: 'text-indigo-400', tools: ['subagents', 'agents_list'] },
    { label: t('cap.toolCat.messaging'), icon: <Zap size={14} />, color: 'text-yellow-400', tools: ['message', 'nodes'] },
    { label: t('cap.toolCat.elevated'), icon: <Shield size={14} />, color: 'text-red-400', tools: ['elevated'] },
  ];
}

const TOOL_DISPLAY_KEYS: Record<string, string> = {
  exec: 'cap.tool.exec',
  process: 'cap.tool.process',
  read: 'cap.tool.read',
  write: 'cap.tool.write',
  edit: 'cap.tool.edit',
  apply_patch: 'cap.tool.applyPatch',
  image: 'cap.tool.image',
  canvas: 'cap.tool.canvas',
  browser: 'cap.tool.browser',
  web_search: 'cap.tool.webSearch',
  web_fetch: 'cap.tool.webFetch',
  tts: 'cap.tool.tts',
  subagents: 'cap.tool.subagents',
  agents_list: 'cap.tool.agentsList',
  message: 'cap.tool.message',
  nodes: 'cap.tool.nodes',
  elevated: 'cap.tool.elevated',
  sessions_list: 'cap.tool.sessionsList',
  sessions_history: 'cap.tool.sessionsHistory',
  sessions_send: 'cap.tool.sessionsSend',
  sessions_spawn: 'cap.tool.sessionsSpawn',
  session_status: 'cap.tool.sessionStatus',
};

// ─── Skill category grouping ────────────────────────────────

const SKILL_CAT_KEYS: Record<string, { labelKey: string; color: string; icon: React.ReactNode }> = {
  '运维': { labelKey: 'cap.skillCat.ops', color: 'text-teal-400', icon: <Wrench size={14} /> },
  '开发': { labelKey: 'cap.skillCat.dev', color: 'text-emerald-400', icon: <Code size={14} /> },
  '安全': { labelKey: 'cap.skillCat.security', color: 'text-red-400', icon: <Shield size={14} /> },
  '创作': { labelKey: 'cap.skillCat.creative', color: 'text-pink-400', icon: <Sparkles size={14} /> },
  '数据': { labelKey: 'cap.skillCat.data', color: 'text-cyan-400', icon: <Database size={14} /> },
  '监控': { labelKey: 'cap.skillCat.monitor', color: 'text-amber-400', icon: <Activity size={14} /> },
  '进化': { labelKey: 'cap.skillCat.evolution', color: 'text-purple-400', icon: <Brain size={14} /> },
  '集成': { labelKey: 'cap.skillCat.integration', color: 'text-blue-400', icon: <Layers size={14} /> },
  '其他': { labelKey: 'cap.skillCat.other', color: 'text-zinc-400', icon: <Cpu size={14} /> },
};

function categorizeSkill(skill: { name: string; displayName?: string; description?: string | string[] }): string {
  const name = String(skill.displayName || skill.name || '').toLowerCase();
  const desc = String(
    Array.isArray(skill.description) ? skill.description.join(' ') : (skill.description || '')
  ).toLowerCase();
  const text = name + ' ' + desc;

  if (/运维|服务器|部署|备份|修复|诊断/.test(text)) return '运维';
  if (/代码|开发|web|全栈|审查|游戏/.test(text)) return '开发';
  if (/安全|加固|ssh|密码/.test(text)) return '安全';
  if (/创作|文案|ppt|内容|摘要|pdf/.test(text)) return '创作';
  if (/数据|分析|统计|成本/.test(text)) return '数据';
  if (/监控|日志|健康|告警/.test(text)) return '监控';
  if (/进化|学习|优化|记忆|知识/.test(text)) return '进化';
  if (/discord|slack|notion|spotify|whatsapp|twitter|gmail|trello|1password|bear|obsidian/.test(text)) return '集成';
  return '其他';
}

function safeDescription(desc: any): string {
  if (!desc) return '';
  if (typeof desc === 'string') return desc.replace(/^【[^】]+】/, '');
  if (Array.isArray(desc)) return desc.map(d => String(d)).join(' ').replace(/^【[^】]+】/, '');
  return String(desc);
}

// ─── Skill Detail Panel ─────────────────────────────────────

function SkillDetailPanel({ skill, onClose, onUse, isInvoking, t }: {
  skill: any;
  onClose: () => void;
  onUse: (skill: any) => void;
  isInvoking: boolean;
  t: TranslationFn;
}) {
  const cat = categorizeSkill(skill);
  const catConfig = SKILL_CAT_KEYS[cat] || SKILL_CAT_KEYS['其他'];
  const desc = safeDescription(skill.description);

  return (
    <div className="absolute inset-0 bg-zinc-900 z-10 flex flex-col animate-in slide-in-from-right-4 duration-200">
      {/* Detail Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-zinc-100 truncate">
          {skill.displayName || skill.name}
        </span>
        {skill.eligible ? (
          <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
        ) : (
          <XCircle size={14} className="text-zinc-600 shrink-0" />
        )}
      </div>

      {/* Detail Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Skill Identity */}
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700/50 flex items-center justify-center text-2xl shrink-0">
            {skill.emoji || '🛠️'}
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-zinc-100">
              {skill.displayName || skill.name}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border border-zinc-700/50 bg-zinc-800/50 ${catConfig.color}`}>
                {catConfig.icon}
                <span>{t(catConfig.labelKey as any)}</span>
              </span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                skill.eligible
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20'
              }`}>
                {skill.eligible ? t('cap.skillReady' as any) : t('cap.skillNotReady' as any)}
              </span>
            </div>
          </div>
        </div>

        {/* Description */}
        {desc && (
          <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
            <h4 className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">
              {t('cap.skillDescription' as any)}
            </h4>
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {desc}
            </p>
          </div>
        )}

        {/* Skill Metadata */}
        <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
          <h4 className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">
            {t('cap.skillInfo' as any)}
          </h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">{t('cap.skillId' as any)}</span>
              <code className="text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded font-mono text-[10px]">
                {skill.name}
              </code>
            </div>
            {skill.version && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">{t('cap.skillVersion' as any)}</span>
                <span className="text-zinc-300">{skill.version}</span>
              </div>
            )}
            {skill.author && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">{t('cap.skillAuthor' as any)}</span>
                <span className="text-zinc-300">{skill.author}</span>
              </div>
            )}
          </div>
        </div>

        {/* Trigger Patterns */}
        {skill.triggers && skill.triggers.length > 0 && (
          <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
            <h4 className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider mb-2">
              {t('cap.skillTriggers' as any)}
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {skill.triggers.map((trigger: string, i: number) => (
                <span
                  key={i}
                  className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-500/10 text-[10px] text-blue-300 border border-blue-500/20"
                >
                  {trigger}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Action Footer */}
      <div className="px-4 py-3 border-t border-zinc-800">
        <button
          onClick={() => onUse(skill)}
          disabled={isInvoking}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-sm font-medium transition-colors"
        >
          {isInvoking ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>{t('cap.invoking')}</span>
            </>
          ) : (
            <>
              <Play size={14} />
              <span>{t('cap.useSkill' as any)}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Provider Tab Content ───────────────────────────────────

function ProviderTab() {
  const [providerData, setProviderData] = useState<ProviderHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProviderHealth();
      setProviderData(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load provider status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  if (loading) {
    return (
      <div className="py-8 flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
        <span className="text-xs text-zinc-500">Loading providers...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 flex flex-col items-center gap-3 px-4">
        <AlertTriangle size={24} className="text-red-400" />
        <span className="text-xs text-red-400 text-center">{error}</span>
        <button
          onClick={loadProviders}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs hover:bg-zinc-700 transition-colors"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      </div>
    );
  }

  if (!providerData) return null;

  const okCount = providerData.providers.filter(p => p.status === 'ok').length;
  const totalCount = providerData.providers.length;
  const overallColor = okCount === totalCount ? 'text-emerald-400' : okCount > 0 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="py-2 px-3 space-y-3">
      {/* Overall Status */}
      <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server size={14} className={overallColor} />
            <span className="text-xs font-medium text-zinc-300">
              {okCount}/{totalCount} Providers Online
            </span>
          </div>
          <button
            onClick={loadProviders}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
        {providerData.checkedAt && (
          <div className="flex items-center gap-1 mt-1.5 text-[10px] text-zinc-600">
            <Clock size={10} />
            <span>Last checked: {new Date(providerData.checkedAt).toLocaleTimeString()}</span>
          </div>
        )}
      </div>

      {/* Provider Cards */}
      {providerData.providers.map((provider) => {
        const config = PROVIDER_CONFIG[provider.provider] || {
          label: provider.provider,
          color: 'text-zinc-400',
          icon: <Server size={18} />,
          gradient: 'from-zinc-500/20 to-zinc-500/5',
        };
        const badge = getProviderStatusBadge(provider.status);

        return (
          <div
            key={provider.provider}
            className={`rounded-lg border border-zinc-700/30 overflow-hidden bg-gradient-to-br ${config.gradient}`}
          >
            {/* Provider Header */}
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center gap-2.5">
                <div className={`${config.color}`}>
                  {config.icon}
                </div>
                <div>
                  <div className="text-sm font-medium text-zinc-200">{config.label}</div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">{provider.message}</div>
                </div>
              </div>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${badge.color}`}>
                {badge.icon}
                <span>{badge.label}</span>
              </span>
            </div>

            {/* Models List */}
            {provider.models.length > 0 && (
              <div className="px-3 pb-2.5 pt-0">
                <div className="text-[10px] text-zinc-500 mb-1.5 uppercase tracking-wider font-medium">
                  Available Models ({provider.models.length})
                </div>
                <div className="flex flex-wrap gap-1">
                  {provider.models.map((model) => {
                    // Clean up model name for display
                    const displayName = model.replace(/^openai\/|^google\/|^anthropic\//, '');
                    return (
                      <span
                        key={model}
                        className="inline-flex items-center px-1.5 py-0.5 rounded bg-zinc-800/60 text-[9px] text-zinc-400 border border-zinc-700/40 font-mono"
                      >
                        {displayName}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Test Model */}
            {provider.testModel && (
              <div className="px-3 pb-2 flex items-center gap-1 text-[10px] text-zinc-600">
                <Activity size={9} />
                <span>Test: {provider.testModel}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function CapabilitiesPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { createNewChat, sendMessage } = useChatActions();
  const { aiSkills, aiTools, aiCapabilities } = useWorkspaceStore();
  const [, navigate] = useLocation();
  // AI capabilities destructured above from useWorkspaceStore
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'skills' | 'tools' | 'providers'>('skills');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['运维', '开发']));
  const [invokingSkill, setInvokingSkill] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<any | null>(null);

  // Group skills by category
  const groupedSkills = useMemo(() => {
    const groups: Record<string, typeof aiSkills> = {};
    const filtered = aiSkills.filter((s: any) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const name = String(s.displayName || s.name || '').toLowerCase();
      const desc = String(Array.isArray(s.description) ? s.description.join(' ') : (s.description || '')).toLowerCase();
      return name.includes(q) || desc.includes(q);
    });

    for (const skill of filtered) {
      const cat = categorizeSkill(skill);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(skill);
    }
    return groups;
  }, [aiSkills, searchQuery]);

  // Group tools by category
  const toolCategories = useMemo(() => getToolCategories(t), [t]);
  const groupedTools = useMemo(() => {
    return toolCategories.map((cat: ToolCategory) => ({
      ...cat,
      activeTools: cat.tools.filter((tl: string) => aiTools.includes(tl)),
    })).filter((cat: ToolCategory & { activeTools: string[] }) => cat.activeTools.length > 0);
  }, [aiTools, toolCategories]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // Invoke a skill: create new chat and send the skill invocation message
  const handleUseSkill = useCallback(async (skill: any) => {
    const skillName = skill.displayName || skill.name;
    setInvokingSkill(skill.name);
    try {
      navigate('/');
      const newChat = await createNewChat(skillName);
      const message = t('cap.useSkillMsg').replace('{name}', skillName);
      await sendMessage(message, undefined, newChat.id);
      onClose();
      setSelectedSkill(null);
    } catch (err) {
      logger.error('Failed to invoke skill:', err);
    } finally {
      setInvokingSkill(null);
    }
  }, [createNewChat, sendMessage, navigate, onClose, t]);

  const eligibleCount = aiSkills.filter((s: any) => s.eligible).length;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-[400px] max-w-[92vw] bg-zinc-900 border-r border-zinc-700/50
          transform transition-transform duration-300 ease-out shadow-2xl
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Skill Detail Overlay */}
        {selectedSkill && (
          <SkillDetailPanel
            skill={selectedSkill}
            onClose={() => setSelectedSkill(null)}
            onUse={handleUseSkill}
            isInvoking={invokingSkill === selectedSkill.name}
            t={t}
          />
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/20 flex items-center justify-center">
              <Cpu size={14} className="text-blue-400" />
            </div>
            <h2 className="text-sm font-semibold text-zinc-100">{t('cap.aiCenter')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stats Bar — Enhanced */}
        <div className="flex items-center gap-4 px-4 py-2.5 bg-gradient-to-r from-zinc-800/80 to-zinc-800/40 border-b border-zinc-800 text-[11px]">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-zinc-400">Skills</span>
            <span className="text-zinc-200 font-semibold">{eligibleCount}<span className="text-zinc-500 font-normal">/{aiSkills.length}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="text-zinc-400">Tools</span>
            <span className="text-zinc-200 font-semibold">{aiTools.length}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-zinc-400">Caps</span>
            <span className="text-zinc-200 font-semibold">{aiCapabilities.length}</span>
          </div>
        </div>

        {/* Tab Switcher — 3 tabs */}
        <div className="flex border-b border-zinc-800">
          {(['skills', 'tools', 'providers'] as const).map((tab) => {
            const labels = { skills: `Skills (${aiSkills.length})`, tools: `Tools (${aiTools.length})`, providers: 'Providers' };
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2 text-xs font-medium transition-colors relative ${
                  activeTab === tab
                    ? 'text-blue-400'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {labels[tab]}
                {activeTab === tab && (
                  <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-blue-400 rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        {/* Search — only for skills and tools */}
        {activeTab !== 'providers' && (
          <div className="px-3 py-2 border-b border-zinc-800">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={activeTab === 'skills' ? t('cap.searchSkills') : t('cap.searchTools' as any)}
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/50 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto" style={{ height: 'calc(100dvh - 220px)' }}>
          {activeTab === 'skills' ? (
            <div className="py-1">
              {Object.entries(groupedSkills).sort(([a], [b]) => {
                const order = ['运维', '开发', '安全', '创作', '数据', '监控', '进化', '集成', '其他'];
                return order.indexOf(a) - order.indexOf(b);
              }).map(([category, skills]) => {
                const catConfig = SKILL_CAT_KEYS[category] || SKILL_CAT_KEYS['其他'];
                const isExpanded = expandedCategories.has(category);
                return (
                  <div key={category}>
                    <button
                      onClick={() => toggleCategory(category)}
                      className="w-full flex items-center gap-2 px-4 py-2 hover:bg-zinc-800/50 transition-colors"
                    >
                      {isExpanded ? <ChevronDown size={12} className="text-zinc-500" /> : <ChevronRight size={12} className="text-zinc-500" />}
                      <span className={catConfig.color}>{catConfig.icon}</span>
                      <span className="text-xs font-medium text-zinc-300">{t(catConfig.labelKey as any)}</span>
                      <span className="text-[10px] text-zinc-500 ml-auto">{(skills as any[]).length}</span>
                    </button>
                    {isExpanded && (
                      <div className="pb-1">
                        {(skills as any[]).map((skill: any) => {
                          const isInvoking = invokingSkill === skill.name;
                          return (
                            <div
                              key={skill.name}
                              className="group flex items-start gap-2.5 px-4 pl-9 py-2 hover:bg-zinc-800/50 transition-colors cursor-pointer rounded-r-lg mx-1"
                              onClick={() => setSelectedSkill(skill)}
                            >
                              <span className="text-sm mt-0.5">{skill.emoji || '🛠️'}</span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-medium text-zinc-200 truncate">
                                    {skill.displayName || skill.name}
                                  </span>
                                  {skill.eligible ? (
                                    <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
                                  ) : (
                                    <XCircle size={10} className="text-zinc-600 shrink-0" />
                                  )}
                                </div>
                                {skill.description && (
                                  <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-2">
                                    {safeDescription(skill.description)}
                                  </p>
                                )}
                              </div>
                              {/* Quick Use + Detail buttons */}
                              <div className="shrink-0 mt-0.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleUseSkill(skill); }}
                                  disabled={isInvoking}
                                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
                                >
                                  {isInvoking ? (
                                    <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                                  ) : (
                                    <Play size={10} />
                                  )}
                                  <span className="text-[10px] font-medium">{t('cap.use')}</span>
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setSelectedSkill(skill); }}
                                  className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
                                >
                                  <Info size={10} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {Object.keys(groupedSkills).length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                  <Search size={24} className="mb-2" />
                  <p className="text-xs">{t('cap.noSkillMatch')}</p>
                </div>
              )}
            </div>
          ) : activeTab === 'tools' ? (
            <div className="py-2 px-3 space-y-3">
              {groupedTools.map((cat) => (
                <div key={cat.label} className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={cat.color}>{cat.icon}</span>
                    <span className="text-xs font-medium text-zinc-300">{cat.label}</span>
                    <span className="text-[10px] text-zinc-600 ml-auto">{cat.activeTools.length}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {cat.activeTools.map(tool => (
                      <span
                        key={tool}
                        className="inline-flex items-center px-2 py-0.5 rounded-md bg-zinc-700/50 text-[10px] text-zinc-300 border border-zinc-700 hover:border-zinc-600 hover:text-zinc-200 transition-colors"
                      >
                        {t((TOOL_DISPLAY_KEYS[tool] || tool) as any) || tool}
                      </span>
                    ))}
                  </div>
                </div>
              ))}

              {/* System Capabilities */}
              {aiCapabilities.length > 0 && (
                <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/30 mt-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap size={14} className="text-amber-400" />
                    <span className="text-xs font-medium text-zinc-300">{t('cap.sysCaps')}</span>
                    <span className="text-[10px] text-zinc-600 ml-auto">{aiCapabilities.length}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {aiCapabilities.map((cap: string) => (
                      <span
                        key={cap}
                        className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-500/10 text-[10px] text-amber-300 border border-amber-500/20 hover:border-amber-500/30 transition-colors"
                      >
                        {cap.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <ProviderTab />
          )}
        </div>
      </div>
    </>
  );
}
