import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { formatRelativeTime as formatRelTime } from '@/lib/dateUtils';
import { useLocation } from 'wouter';
import { useI18n } from '../lib/i18n';
import { PageLoadingSkeleton } from '../components/PageLoadingSkeleton';
import { useConfirmDialog } from '../components/ConfirmDialog';
import {
  ArrowLeft, Plus, Play, Trash2, Edit3,
  Save, X, Zap, Clock,
  ArrowDown, ChevronRight, ChevronUp, ChevronDown,
  Search, Globe, FileText, BarChart3, Mail, Database,
  Code, MessageSquare, Sparkles, Copy, Timer, ToggleLeft, ToggleRight,
  Layers, Headphones, ShoppingCart, Package, Users, FileCheck, CalendarClock, Repeat
} from 'lucide-react';
import { logger } from "../lib/logger";

const API_BASE = '/api/workflows';

interface WorkflowStep {
  id: string;
  prompt: string;
  description: string;
  waitForCompletion: boolean;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  category: string;
  runCount: number;
  lastRunAt: string | null;
  cronExpression: string | null;
  cronEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Cron schedule presets
const CRON_PRESET_KEYS = [
  { labelKey: 'wf.cron.hourly' as const, value: '0 * * * *', descKey: 'wf.cron.hourlyDesc' as const },
  { labelKey: 'wf.cron.daily9' as const, value: '0 9 * * *', descKey: 'wf.cron.daily9Desc' as const },
  { labelKey: 'wf.cron.daily18' as const, value: '0 18 * * *', descKey: 'wf.cron.daily18Desc' as const },
  { labelKey: 'wf.cron.weekday9' as const, value: '0 9 * * 1-5', descKey: 'wf.cron.weekday9Desc' as const },
  { labelKey: 'wf.cron.monday9' as const, value: '0 9 * * 1', descKey: 'wf.cron.monday9Desc' as const },
  { labelKey: 'wf.cron.monthly1' as const, value: '0 9 1 * *', descKey: 'wf.cron.monthly1Desc' as const },
] as const;

// describeCron is now a component-level function that uses t()

const WF_CATEGORY_KEYS = [
  'wf.cat.uncategorized', 'wf.cat.dailyTask', 'wf.cat.dataAnalysis', 'wf.cat.contentCreation',
  'wf.cat.codeDev', 'wf.cat.devops', 'wf.cat.research'
] as const;
const WF_CATEGORIES_SERVER = ['未分类', '日常任务', '数据分析', '内容创作', '代码开发', '运维部署', '调研报告'];

const CATEGORY_COLORS: Record<string, string> = {
  '日常任务': 'bg-green-500/15 text-green-400',
  '数据分析': 'bg-blue-500/15 text-blue-400',
  '内容创作': 'bg-purple-500/15 text-purple-400',
  '代码开发': 'bg-yellow-500/15 text-yellow-400',
  '运维部署': 'bg-red-500/15 text-red-400',
  '调研报告': 'bg-cyan-500/15 text-cyan-400',
  '未分类': 'bg-white/5 text-white/50',
};

// Step templates for quick insertion
const STEP_TEMPLATES = [
  { icon: Search, label: '搜索网页', description: '搜索信息', prompt: '请搜索以下关键词的最新信息：[关键词]，并整理出要点。', color: 'text-blue-400' },
  { icon: FileText, label: '分析文档', description: '分析文件', prompt: '请分析以下内容，提取关键信息并生成摘要：', color: 'text-emerald-400' },
  { icon: BarChart3, label: '数据分析', description: '分析数据', prompt: '请对以下数据进行分析，找出趋势和关键指标：', color: 'text-amber-400' },
  { icon: Code, label: '代码生成', description: '生成代码', prompt: '请根据以下需求生成代码：', color: 'text-yellow-400' },
  { icon: Mail, label: '发送通知', description: '发送通知', prompt: '请将以上分析结果整理成简报，格式清晰，重点突出。', color: 'text-purple-400' },
  { icon: Globe, label: '网页抓取', description: '抓取网页', prompt: '请访问以下网址并提取页面中的关键内容：[URL]', color: 'text-cyan-400' },
  { icon: Database, label: '数据查询', description: '查询数据', prompt: '请查询以下数据并返回结果：', color: 'text-rose-400' },
  { icon: MessageSquare, label: '生成报告', description: '生成报告', prompt: '请根据以上所有步骤的结果，生成一份完整的分析报告，包含：1. 概述 2. 关键发现 3. 建议', color: 'text-orange-400' },
];

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('rangerai_token');
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function generateStepId() {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// formatRelativeTime is now a component-level function that uses t()

export default function WorkflowEditor() {
  const { t } = useI18n();
  const { confirm: confirmDialog, ConfirmDialogUI } = useConfirmDialog();
  const [, setLocation] = useLocation();

  // Helper functions using t()
  const describeCron = (cron: string | null): string => {
    if (!cron) return t('wf.cron.notSet');
    const preset = CRON_PRESET_KEYS.find(p => p.value === cron);
    if (preset) return t(preset.descKey);
    return `${t('wf.cron.custom')}: ${cron}`;
  };
  const formatRelativeTime = (dateStr: string | null): string => {
    if (!dateStr) return t('wf.neverRun');
    return formatRelTime(dateStr, 'zh-CN', t as (k: string) => string);
  };
  const getCatLabel = (cat: string) => {
    const idx = WF_CATEGORIES_SERVER.indexOf(cat);
    return idx >= 0 ? t(WF_CATEGORY_KEYS[idx]) : cat;
  };
  const getCatColor = (cat: string) => CATEGORY_COLORS[cat] || CATEGORY_COLORS['未分类'];
  const getStepTemplates = () => [
    { icon: Search, label: t('wf.tpl.searchWeb'), description: t('wf.tpl.searchInfo'), prompt: t('wf.tpl.searchPrompt'), color: 'text-blue-400' },
    { icon: FileText, label: t('wf.tpl.analyzeDoc'), description: t('wf.tpl.analyzeFile'), prompt: t('wf.tpl.analyzePrompt'), color: 'text-emerald-400' },
    { icon: BarChart3, label: t('wf.tpl.dataAnalysis'), description: t('wf.tpl.analyzeData'), prompt: t('wf.tpl.dataPrompt'), color: 'text-amber-400' },
    { icon: Code, label: t('wf.tpl.codeGen'), description: t('wf.tpl.genCode'), prompt: t('wf.tpl.codePrompt'), color: 'text-yellow-400' },
    { icon: Mail, label: t('wf.tpl.sendNotify'), description: t('wf.tpl.sendNotifyDesc'), prompt: t('wf.tpl.notifyPrompt'), color: 'text-purple-400' },
    { icon: Globe, label: t('wf.tpl.webScrape'), description: t('wf.tpl.scrapeWeb'), prompt: t('wf.tpl.scrapePrompt'), color: 'text-cyan-400' },
    { icon: Database, label: t('wf.tpl.dataQuery'), description: t('wf.tpl.queryData'), prompt: t('wf.tpl.queryPrompt'), color: 'text-rose-400' },
    { icon: MessageSquare, label: t('wf.tpl.genReport'), description: t('wf.tpl.genReportDesc'), prompt: t('wf.tpl.reportPrompt'), color: 'text-orange-400' },
  ];

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [editing, setEditing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail' | 'edit'>('list');
  const [showTemplates, setShowTemplates] = useState(false);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editCategory, setEditCategory] = useState('未分类');
  const [editSteps, setEditSteps] = useState<WorkflowStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  // Cron schedule state
  const [editCronEnabled, setEditCronEnabled] = useState(false);
  const [editCronExpression, setEditCronExpression] = useState('');
  const [showCronCustom, setShowCronCustom] = useState(false);

  const loadWorkflows = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchWithAuth(API_BASE);
      const data = await res.json();
      setWorkflows(data.workflows || []);
    } catch (err) {
      logger.error('Failed to load workflows:', err);
      toast.error(t('workflow.loadError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  const startEdit = (wf: Workflow) => {
    setSelectedWorkflow(wf);
    setEditName(wf.name);
    setEditDesc(wf.description);
    setEditCategory(wf.category);
    setEditSteps([...wf.steps]);
    setEditCronEnabled(wf.cronEnabled || false);
    setEditCronExpression(wf.cronExpression || '');
    setShowCronCustom(!!wf.cronExpression && !CRON_PRESET_KEYS.find(p => p.value === wf.cronExpression));
    setEditing(true);
    setMobileView('edit');
    setExpandedStep(null);
  };

  const startCreate = () => {
    setSelectedWorkflow(null);
    setEditName('');
    setEditDesc('');
    setEditCategory('未分类');
    setEditCronEnabled(false);
    setEditCronExpression('');
    setShowCronCustom(false);
    setEditSteps([{
      id: generateStepId(),
      prompt: '',
      description: `${t('wf.step')} 1`,
      waitForCompletion: true,
    }]);
    setEditing(true);
    setShowCreate(true);
    setMobileView('edit');
    setExpandedStep(0);
  };

  const addStep = (template?: { icon: any; label: string; description: string; prompt: string; color: string }) => {
    const newStep: WorkflowStep = {
      id: generateStepId(),
      prompt: template?.prompt || '',
      description: template?.description || `${t('wf.step')} ${editSteps.length + 1}`,
      waitForCompletion: true,
    };
    setEditSteps(prev => [...prev, newStep]);
    setExpandedStep(editSteps.length);
    setShowTemplates(false);
  };

  const removeStep = (index: number) => {
    setEditSteps(prev => prev.filter((_, i) => i !== index));
    if (expandedStep === index) setExpandedStep(null);
    else if (expandedStep !== null && expandedStep > index) setExpandedStep(expandedStep - 1);
  };

  const updateStep = (index: number, field: keyof WorkflowStep, value: string | boolean) => {
    setEditSteps(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const newSteps = [...editSteps];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= newSteps.length) return;
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    setEditSteps(newSteps);
    setExpandedStep(targetIndex);
  };

  const handleSave = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: editName,
        description: editDesc,
        category: editCategory,
        steps: editSteps,
        cronExpression: editCronEnabled ? editCronExpression : null,
        cronEnabled: editCronEnabled,
      };

      if (selectedWorkflow) {
        await fetchWithAuth(`${API_BASE}/${selectedWorkflow.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await fetchWithAuth(API_BASE, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      setEditing(false);
      setShowCreate(false);
      setMobileView('list');
      loadWorkflows();
    } catch (err) {
      logger.error('Save failed:', err);
      toast.error(t('workflow.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirmDialog({
      title: t('wf.confirmDelete'),
      message: t('wf.confirmDelete'),
      variant: 'danger',
      confirmText: t('sidebar.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await fetchWithAuth(`${API_BASE}/${id}`, { method: 'DELETE' });
      loadWorkflows();
      if (selectedWorkflow?.id === id) {
        setSelectedWorkflow(null);
        setEditing(false);
        setMobileView('list');
      }
    } catch (err) {
      logger.error('Delete failed:', err);
      toast.error(t('workflow.deleteError'));
    }
  };

  const handleRun = async (wf: Workflow) => {
    try {
      await fetchWithAuth(`${API_BASE}/${wf.id}/run`, { method: 'POST' });
    } catch (err) {
      logger.error('Run count failed:', err);
    }

    const firstStep = wf.steps[0];
    if (firstStep) {
      const combinedPrompt = wf.steps.length === 1
        ? firstStep.prompt
        : `${t('wf.step')} 1-${wf.steps.length}:\n\n${wf.steps.map((s, i) => `${i + 1}. ${s.description}: ${s.prompt}`).join('\n\n')}`;
      
      sessionStorage.setItem('workflow_prompt', combinedPrompt);
      sessionStorage.setItem('workflow_name', wf.name);
      setLocation('/');
    }
  };

  const duplicateWorkflow = async (wf: Workflow) => {
    try {
      await fetchWithAuth(API_BASE, {
        method: 'POST',
        body: JSON.stringify({
          name: `${wf.name} (${t('wf.copy')})`,
          description: wf.description,
          category: wf.category,
          steps: wf.steps,
        }),
      });
      loadWorkflows();
    } catch (err) {
      logger.error('Duplicate failed:', err);
      toast.error(t('workflow.duplicateError'));
    }
  };

  

  const cancelEdit = () => {
    setEditing(false);
    setShowCreate(false);
    setMobileView(selectedWorkflow ? 'detail' : 'list');
  };

  // Render step node with visual connection
  const renderStepNode = (step: WorkflowStep, index: number, total: number, readOnly = false) => {
    const isExpanded = expandedStep === index;
    return (
      <div key={step.id} className="relative">
        {/* Connection line */}
        {index > 0 && (
          <div className="flex flex-col items-center py-1">
            <div className="w-px h-4 bg-gradient-to-b from-amber-500/40 to-amber-500/20" />
            <div className="w-5 h-5 rounded-full border border-amber-500/30 bg-amber-500/10 flex items-center justify-center">
              <ArrowDown className="w-3 h-3 text-amber-400/60" />
            </div>
            <div className="w-px h-4 bg-gradient-to-b from-amber-500/20 to-amber-500/40" />
          </div>
        )}

        {/* Step card */}
        <div className={`relative rounded-xl border transition-all ${
          readOnly
            ? 'border-white/5 bg-white/[0.03] p-3 sm:p-4'
            : isExpanded
              ? 'border-amber-500/30 bg-amber-500/5 shadow-lg shadow-amber-500/5'
              : 'border-white/10 bg-white/[0.03] hover:border-white/20'
        }`}>
          {/* Step header — always visible */}
          <div
            className={`flex items-center gap-2 sm:gap-3 ${readOnly ? '' : 'cursor-pointer p-3 sm:p-4'}`}
            onClick={readOnly ? undefined : () => setExpandedStep(isExpanded ? null : index)}
          >
            {/* Step number badge */}
            <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-xs sm:text-sm font-bold ${
              readOnly ? 'bg-amber-600/20 text-amber-400' : isExpanded ? 'bg-amber-600 text-white' : 'bg-amber-600/20 text-amber-400'
            }`}>
              {index + 1}
            </div>

            {/* Step info */}
            <div className="flex-1 min-w-0">
              {readOnly ? (
                <span className="text-sm font-medium text-white/80">{step.description}</span>
              ) : isExpanded ? (
                <input
                  type="text"
                  value={step.description}
                  onChange={e => updateStep(index, 'description', e.target.value)}
                  onClick={e => e.stopPropagation()}
                  className="bg-transparent border-none text-sm font-medium focus:outline-none text-white/90 w-full"
                  placeholder={t('wf.stepName')}
                />
              ) : (
                <div>
                  <span className="text-sm font-medium text-white/80">{step.description || t('wf.unnamedStep')}</span>
                  {step.prompt && (
                    <p className="text-xs text-white/30 mt-0.5 truncate">{step.prompt.slice(0, 60)}</p>
                  )}
                </div>
              )}
            </div>

            {/* Actions */}
            {!readOnly && (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {index > 0 && (
                  <button onClick={e => { e.stopPropagation(); moveStep(index, 'up'); }}
                    className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors">
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                )}
                {index < total - 1 && (
                  <button onClick={e => { e.stopPropagation(); moveStep(index, 'down'); }}
                    className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                )}
                {total > 1 && (
                  <button onClick={e => { e.stopPropagation(); removeStep(index); }}
                    className="p-1 hover:bg-red-500/10 rounded text-white/20 hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Expanded content */}
          {!readOnly && isExpanded && (
            <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3">
              <textarea
                value={step.prompt}
                onChange={e => updateStep(index, 'prompt', e.target.value)}
                rows={4}
                placeholder={t('wf.promptPlaceholder')}
                className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-amber-500/50 resize-none font-mono leading-relaxed"
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-white/40 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={step.waitForCompletion}
                    onChange={e => updateStep(index, 'waitForCompletion', e.target.checked)}
                    className="rounded accent-amber-500"
                  />
                  {t('wf.waitForCompletion')}
                </label>
                {step.prompt && (
                  <span className="text-[10px] text-white/20">{step.prompt.length} {t('wf.chars')}</span>
                )}
              </div>
            </div>
          )}

          {/* Read-only prompt display */}
          {readOnly && step.prompt && (
            <p className="text-xs text-white/40 mt-2 font-mono whitespace-pre-wrap line-clamp-4">{step.prompt}</p>
          )}
        </div>
      </div>
    );
  };

  // Template picker overlay
  const renderTemplatePicker = () => (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-end sm:items-center justify-center" onClick={() => setShowTemplates(false)}>
      <div className="bg-[#12121a] border border-white/10 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[70vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-medium">{t('wf.selectTemplate')}</h3>
          </div>
          <button onClick={() => setShowTemplates(false)} className="p-1 hover:bg-white/10 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 overflow-y-auto max-h-[55vh]">
          <div className="grid grid-cols-2 gap-2">
            {getStepTemplates().map((tpl, i) => (
              <button
                key={i}
                onClick={() => addStep(tpl)}
                className="flex items-start gap-3 p-3 rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/15 transition-all text-left group"
              >
                <tpl.icon className={`w-5 h-5 ${tpl.color} flex-shrink-0 mt-0.5 group-hover:scale-110 transition-transform`} />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-white/80 block">{tpl.label}</span>
                  <span className="text-[10px] text-white/30 line-clamp-2 mt-0.5">{tpl.prompt.slice(0, 40)}...</span>
                </div>
              </button>
            ))}
          </div>
          <button
            onClick={() => addStep()}
            className="w-full mt-2 p-3 rounded-xl border border-dashed border-white/10 hover:border-white/20 text-sm text-white/40 hover:text-white/60 transition-colors"
          >
            {t('wf.blankStep')}
          </button>
        </div>
      </div>
    </div>
  );

  // Shared edit form
  const renderEditForm = () => (
    <>
      <div className="space-y-4 mb-6">
        <div>
          <label className="block text-sm text-white/60 mb-1">{t('wf.workflowName')}</label>
          <input
            type="text"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            placeholder={t('wf.workflowNamePlaceholder')}
            className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-amber-500/50"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-white/60 mb-1">{t('wf.descLabel')}</label>
            <input
              type="text"
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              placeholder={t('wf.descPlaceholderShort')}
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-amber-500/50"
            />
          </div>
          <div>
            <label className="block text-sm text-white/60 mb-1">{t('wf.categoryLabel')}</label>
            <select
              value={editCategory}
              onChange={e => setEditCategory(e.target.value)}
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-amber-500/50"
            >
              {WF_CATEGORIES_SERVER.map((cat, catIdx) => (
                <option key={cat} value={cat}>{getCatLabel(cat)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Cron Schedule Section */}
      <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <div
          className="flex items-center justify-between p-3 sm:p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
          onClick={() => setEditCronEnabled(!editCronEnabled)}
        >
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              editCronEnabled ? 'bg-amber-500/20' : 'bg-white/5'
            }`}>
              <Timer className={`w-4 h-4 ${editCronEnabled ? 'text-amber-400' : 'text-white/30'}`} />
            </div>
            <div>
              <div className="text-sm font-medium">{t('wf.cronTrigger')}</div>
              <div className="text-[11px] text-white/40">
                {editCronEnabled ? describeCron(editCronExpression) : t('wf.cronNotEnabled')}
              </div>
            </div>
          </div>
          {editCronEnabled ? (
            <ToggleRight className="w-6 h-6 text-amber-400" />
          ) : (
            <ToggleLeft className="w-6 h-6 text-white/20" />
          )}
        </div>

        {editCronEnabled && (
          <div className="px-3 sm:px-4 pb-3 sm:pb-4 pt-0 space-y-3 border-t border-white/5">
            {/* Preset buttons */}
            <div className="pt-3">
              <label className="block text-xs text-white/40 mb-2">{t('wf.quickSelect')}</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {CRON_PRESET_KEYS.map(preset => (
                  <button
                    key={preset.value}
                    onClick={() => {
                      setEditCronExpression(preset.value);
                      setShowCronCustom(false);
                    }}
                    className={`px-3 py-2 rounded-lg text-xs text-left transition-all ${
                      editCronExpression === preset.value && !showCronCustom
                        ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300'
                        : 'bg-white/5 border border-white/10 text-white/60 hover:border-white/20'
                    }`}
                  >
                    <div className="font-medium">{t(preset.labelKey)}</div>
                    <div className="text-[10px] text-white/30 mt-0.5">{t(preset.descKey)}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom cron input */}
            <div>
              <button
                onClick={() => setShowCronCustom(!showCronCustom)}
                className="text-xs text-white/40 hover:text-white/60 transition-colors"
              >
                {showCronCustom ? t('wf.collapseCron') : t('wf.expandCron')}
              </button>
              {showCronCustom && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={editCronExpression}
                    onChange={e => setEditCronExpression(e.target.value)}
                    placeholder={t('wf.cronPlaceholder')}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm font-mono focus:outline-none focus:border-amber-500/50"
                  />
                  <p className="text-[10px] text-white/25 mt-1">{t('wf.cronHint')}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Steps with visual flow */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
            {t('wf.execSteps')} <span className="text-white/30 normal-case font-normal">({editSteps.length})</span>
          </h4>
          <button
            onClick={() => setShowTemplates(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 rounded-lg text-xs transition-colors"
          >
            <Plus className="w-3 h-3" /> {t('wf.addStepBtn')}
          </button>
        </div>

        <div className="relative">
          {editSteps.map((step, index) => renderStepNode(step, index, editSteps.length))}
        </div>

        {/* Add step hint at bottom */}
        {editSteps.length > 0 && (
          <div className="flex flex-col items-center py-2 mt-1">
            <div className="w-px h-4 bg-gradient-to-b from-white/10 to-transparent" />
            <button
              onClick={() => setShowTemplates(true)}
              className="mt-1 flex items-center gap-1 px-3 py-1.5 border border-dashed border-white/10 hover:border-amber-500/30 rounded-lg text-xs text-white/30 hover:text-amber-400 transition-colors"
            >
              <Plus className="w-3 h-3" /> {t('wf.continueAdd')}
            </button>
          </div>
        )}
      </div>
    </>
  );

  // Mobile: detail view
  const renderMobileDetail = () => {
    if (!selectedWorkflow) return null;
    return (
      <div className="md:hidden fixed inset-0 bg-[#0a0a0f] z-50 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="w-5 h-5 text-amber-400 flex-shrink-0" />
            <h3 className="font-medium truncate text-sm">{selectedWorkflow.name}</h3>
          </div>
          <button onClick={() => { setSelectedWorkflow(null); setMobileView('list'); }} className="p-2 hover:bg-white/10 rounded-lg flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-4">
            {selectedWorkflow.description && (
              <p className="text-sm text-white/60">{selectedWorkflow.description}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <span className={`px-2.5 py-1 rounded-full text-xs ${getCatColor(selectedWorkflow.category)}`}>
                {getCatLabel(selectedWorkflow.category)}
              </span>
              <span className="px-2.5 py-1 rounded-full text-xs bg-white/5 text-white/50">
                {selectedWorkflow.steps.length} {t('wf.nSteps')}
              </span>
              {selectedWorkflow.cronEnabled && selectedWorkflow.cronExpression && (
                <span className="px-2.5 py-1 rounded-full text-xs bg-amber-500/15 text-amber-400 flex items-center gap-1">
                  <Timer className="w-3 h-3" />{describeCron(selectedWorkflow.cronExpression)}
                </span>
              )}
              {selectedWorkflow.runCount > 0 && (
                <span className="px-2.5 py-1 rounded-full text-xs bg-white/5 text-white/50">
                  {t('wf.runNTimes').replace('{n}', String(selectedWorkflow.runCount))}
                </span>
              )}
              <span className="px-2.5 py-1 rounded-full text-xs bg-white/5 text-white/50">
                <Clock className="w-3 h-3 inline mr-1" />
                {formatRelativeTime(selectedWorkflow.lastRunAt)}
              </span>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">{t('wf.execSteps')}</h4>
              {selectedWorkflow.steps.map((step, i) => renderStepNode(step, i, selectedWorkflow.steps.length, true))}
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-white/10 flex gap-2">
          <button
            onClick={() => handleRun(selectedWorkflow)}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-green-600 hover:bg-green-700 rounded-lg text-sm transition-colors"
          >
            <Play className="w-4 h-4" />{t('wf.runBtn')}
          </button>
          <button
            onClick={() => startEdit(selectedWorkflow)}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm transition-colors"
          >
            <Edit3 className="w-4 h-4" />{t('wf.editBtn')}
          </button>
          <button
            onClick={() => duplicateWorkflow(selectedWorkflow)}
            className="py-2.5 px-3 bg-white/10 text-white/60 rounded-lg text-sm hover:bg-white/15 transition-colors"
            title={t('wf.copyBtn')}
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleDelete(selectedWorkflow.id)}
            className="py-2.5 px-3 bg-red-600/10 text-red-400 rounded-lg text-sm hover:bg-red-600/20 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  // Mobile: edit view
  const renderMobileEdit = () => {
    return (
      <div className="md:hidden fixed inset-0 bg-[#0a0a0f] z-50 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h3 className="font-medium text-sm">{selectedWorkflow ? t('wf.editWorkflowTitle') : t('wf.createWorkflowTitle')}</h3>
          <div className="flex items-center gap-2">
            <button onClick={cancelEdit} className="px-3 py-1.5 bg-white/10 hover:bg-white/15 rounded-lg text-xs">
              {t('wf.cancelBtn')}
            </button>
            <button
              onClick={handleSave}
              disabled={!editName.trim() || saving}
              className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 rounded-lg text-xs disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? t('wf.savingBtn') : t('wf.saveBtn')}
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {renderEditForm()}
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0f] text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/10">
        <div className="flex items-center gap-2 sm:gap-3">
          <button onClick={() => setLocation('/')} className="p-1.5 sm:p-2 hover:bg-white/10 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Zap className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />
          <h1 className="text-lg sm:text-xl font-semibold">{t('wf.workflowTitle')}</h1>
          <span className="text-xs sm:text-sm text-white/40 ml-1 sm:ml-2">{workflows.length} {t('wf.count')}</span>
        </div>
        <button
          onClick={startCreate}
          className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors text-xs sm:text-sm"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">{t('wf.createWorkflowTitle')}</span>
          <span className="sm:hidden">{t('wf.createWorkflowTitle')}</span>
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Workflow list */}
        <div className={`${editing ? 'hidden md:block md:w-80' : 'flex-1'} border-r border-white/10 overflow-y-auto p-3 sm:p-4 transition-all`}>
          {loading ? (
            <PageLoadingSkeleton rows={4} showHeader={false} variant="list" />
          ) : workflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 sm:py-20">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 flex items-center justify-center mb-6">
                <Zap className="w-8 h-8 sm:w-10 sm:h-10 text-amber-400" />
              </div>
              <h3 className="text-lg sm:text-xl font-semibold text-white/80 mb-2">{t('wf.emptyTitle')}</h3>
              <p className="text-sm text-white/40 mb-8 text-center max-w-md px-4">
                {t('wf.emptyDesc')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-xl px-4 mb-8">
                <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center text-xs text-blue-400 font-bold">1</div>
                    <span className="text-sm font-medium text-white/70">{t('wf.emptyStep1')}</span>
                  </div>
                  <p className="text-xs text-white/30">{t('wf.emptyStep1Desc')}</p>
                </div>
                <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full bg-amber-500/20 flex items-center justify-center text-xs text-amber-400 font-bold">2</div>
                    <span className="text-sm font-medium text-white/70">{t('wf.emptyStep2')}</span>
                  </div>
                  <p className="text-xs text-white/30">{t('wf.emptyStep2Desc')}</p>
                </div>
                <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center text-xs text-emerald-400 font-bold">3</div>
                    <span className="text-sm font-medium text-white/70">{t('wf.emptyStep3')}</span>
                  </div>
                  <p className="text-xs text-white/30">{t('wf.emptyStep3Desc')}</p>
                </div>
              </div>
              <button
                onClick={startCreate}
                className="flex items-center gap-2 px-6 py-2.5 bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                {t('wf.createFirstBtn')}
              </button>
            </div>
          ) : (
            <div className="grid gap-2 sm:gap-3">
              {workflows.map(wf => (
                <div
                  key={wf.id}
                  className={`group p-3 sm:p-4 rounded-xl border transition-all cursor-pointer ${
                    selectedWorkflow?.id === wf.id
                      ? 'border-amber-500/50 bg-amber-500/5'
                      : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10'
                  }`}
                  onClick={() => {
                    setSelectedWorkflow(wf);
                    setEditing(false);
                    setMobileView('detail');
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-white/90 text-sm sm:text-base">{wf.name}</h4>
                      {wf.description && (
                        <p className="text-xs sm:text-sm text-white/40 mt-1 line-clamp-2">{wf.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] sm:text-xs ${getCatColor(wf.category)}`}>
                          {getCatLabel(wf.category)}
                        </span>
                        <span className="text-[10px] sm:text-xs text-white/30">{wf.steps.length} {t('wf.nStepsShort')}</span>
                        {wf.cronEnabled && wf.cronExpression && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400 flex items-center gap-0.5">
                            <Timer className="w-2.5 h-2.5" />{describeCron(wf.cronExpression)}
                          </span>
                        )}
                        {wf.runCount > 0 && (
                          <span className="text-[10px] sm:text-xs text-white/30">
                            <Play className="w-2.5 h-2.5 inline mr-0.5" />{wf.runCount}
                          </span>
                        )}
                        <span className="text-[10px] sm:text-xs text-white/20">
                          {formatRelativeTime(wf.lastRunAt)}
                        </span>
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); handleRun(wf); }}
                        className="p-2 hover:bg-green-500/10 rounded-lg transition-colors text-white/30 hover:text-green-400"
                        title={t('wf.runBtn')}
                      >
                        <Play className="w-4 h-4" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); startEdit(wf); }}
                        className="p-2 hover:bg-blue-500/10 rounded-lg transition-colors text-white/30 hover:text-blue-400"
                        title={t('wf.editBtn')}
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); duplicateWorkflow(wf); }}
                        className="p-2 hover:bg-white/10 rounded-lg transition-colors text-white/30 hover:text-white/60"
                        title={t('wf.copyBtn')}
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(wf.id); }}
                        className="p-2 hover:bg-red-500/10 rounded-lg transition-colors text-white/20 hover:text-red-400"
                        title={t('wf.deleteBtn')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <ChevronRight className="sm:hidden w-4 h-4 text-white/20 flex-shrink-0 mt-1" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Editor panel (desktop) */}
        {editing && (
          <div className="hidden md:flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
              <h3 className="font-medium">{selectedWorkflow ? t('wf.editWorkflowTitle') : t('wf.createWorkflowTitle')}</h3>
              <div className="flex items-center gap-2">
                <button onClick={cancelEdit} className="px-4 py-1.5 bg-white/10 hover:bg-white/15 rounded-lg text-sm">
                  {t('wf.cancelBtn')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={!editName.trim() || saving}
                  className="flex items-center gap-1 px-4 py-1.5 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {saving ? t('wf.savingBtn') : t('wf.saveBtn')}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {renderEditForm()}
            </div>
          </div>
        )}

        {/* Preview panel (desktop, when not editing) */}
        {!editing && selectedWorkflow && (
          <div className="hidden md:flex w-96 border-l border-white/10 flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <h3 className="font-medium truncate">{selectedWorkflow.name}</h3>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleRun(selectedWorkflow)}
                  className="p-2 hover:bg-green-500/10 rounded-lg text-green-400"
                  title={t('wf.runBtn')}
                >
                  <Play className="w-4 h-4" />
                </button>
                <button
                  onClick={() => duplicateWorkflow(selectedWorkflow)}
                  className="p-2 hover:bg-white/10 rounded-lg text-white/40"
                  title={t('wf.copyBtn')}
                >
                 <Copy className="w-4 h-4" />
                </button>
                <button onClick={() => setSelectedWorkflow(null)} className="p-1 hover:bg-white/10 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                {selectedWorkflow.description && (
                  <div>
                    <label className="text-xs text-white/40 uppercase">{t('wf.descriptionLabel')}</label>
                    <p className="text-sm mt-1 text-white/70">{selectedWorkflow.description}</p>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/5">
                    <label className="text-[10px] text-white/40 uppercase">{t('wf.categoryLabelShort')}</label>
                    <p className="mt-1">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${getCatColor(selectedWorkflow.category)}`}>
                        {getCatLabel(selectedWorkflow.category)}
                      </span>
                    </p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/5">
                    <label className="text-[10px] text-white/40 uppercase">{t('wf.runLabel')}</label>
                    <p className="mt-1 text-lg font-semibold text-white/80">{selectedWorkflow.runCount}</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/[0.03] border border-white/5">
                    <label className="text-[10px] text-white/40 uppercase">{t('wf.recentLabel')}</label>
                    <p className="mt-1 text-xs text-white/60">{formatRelativeTime(selectedWorkflow.lastRunAt)}</p>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase mb-3 block">{t('wf.stepsLabel')} ({selectedWorkflow.steps.length})</label>
                  {selectedWorkflow.steps.map((step, i) => renderStepNode(step, i, selectedWorkflow.steps.length, true))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Workflow Template Library */}
      {!selectedWorkflow && !editing && (
        <div className="hidden md:block w-full border-t border-white/10 p-4">
          <h3 className="text-sm font-medium text-white/60 mb-3 flex items-center gap-2">
            <Layers size={14} className="text-teal-400" />
            {'流程模板库'}
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-teal-500/20 text-teal-400">5 {'个模板'}</span>
          </h3>
          <div className="grid grid-cols-5 gap-3">
            {[
              { name: '客服工单处理', icon: Headphones, steps: 6, color: 'border-cyan-500/30 hover:border-cyan-500/60', iconColor: 'text-cyan-400', desc: '接单→分类→分配→处理→回复→归档' },
              { name: 'KOL 合作流程', icon: Users, steps: 5, color: 'border-pink-500/30 hover:border-pink-500/60', iconColor: 'text-pink-400', desc: '筛选→沟通→合同→内容审核→结算' },
              { name: '库存补货流程', icon: Package, steps: 4, color: 'border-amber-500/30 hover:border-amber-500/60', iconColor: 'text-amber-400', desc: '监控→预警→下单→入库' },
              { name: '退款处理流程', icon: ShoppingCart, steps: 5, color: 'border-red-500/30 hover:border-red-500/60', iconColor: 'text-red-400', desc: '申请→审核→确认→执行→通知' },
              { name: '内容审核流程', icon: FileCheck, steps: 4, color: 'border-emerald-500/30 hover:border-emerald-500/60', iconColor: 'text-emerald-400', desc: '提交→AI初审→人工复审→发布' },
            ].map((tpl, i) => (
              <button
                key={i}
                onClick={() => toast.success(`模板「${tpl.name}」已应用`)}
                className={`bg-white/[0.02] border ${tpl.color} rounded-xl p-3 text-left transition-all hover:bg-white/[0.04] group`}
              >
                <tpl.icon size={16} className={`${tpl.iconColor} mb-2`} />
                <div className="text-[11px] font-medium text-white/80 group-hover:text-white transition">{tpl.name}</div>
                <div className="text-[9px] text-white/40 mt-1">{tpl.steps} {'步骤'}</div>
                <div className="text-[8px] text-white/30 mt-1 truncate">{tpl.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scheduled Trigger Configuration */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 mt-4">
        <div className="flex items-center gap-2 mb-4">
          <CalendarClock size={16} className="text-orange-400" />
          <h3 className="font-semibold">定时触发配置</h3>
          <span className="text-[10px] px-2 py-0.5 bg-orange-500/15 text-orange-400 rounded-full border border-orange-500/20 ml-auto">自动化</span>
        </div>
        <div className="space-y-3">
          {[
            { name: '每日库存同步', cron: '0 6 * * *', schedule: '每天 06:00', workflow: '库存数据同步流程', status: 'active', lastRun: '2h 前', nextRun: '明天 06:00' },
            { name: '周报自动生成', cron: '0 9 * * 1', schedule: '每周一 09:00', workflow: '周报汇总流程', status: 'active', lastRun: '5d 前', nextRun: '下周一 09:00' },
            { name: 'KOL 数据拉取', cron: '0 */4 * * *', schedule: '每 4 小时', workflow: 'KOL 数据同步', status: 'active', lastRun: '1h 前', nextRun: '2h 后' },
            { name: '月度财务报告', cron: '0 10 1 * *', schedule: '每月 1 日 10:00', workflow: '财务汇总流程', status: 'paused', lastRun: '30d 前', nextRun: '已暂停' },
            { name: '异常工单检测', cron: '*/30 * * * *', schedule: '每 30 分钟', workflow: '工单异常检测', status: 'active', lastRun: '15m 前', nextRun: '15m 后' },
          ].map((trigger, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-zinc-800/40 border border-zinc-700/50 rounded-lg hover:border-orange-500/30 transition">
              <div className={`w-2 h-2 rounded-full shrink-0 ${trigger.status === 'active' ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{trigger.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded font-mono">{trigger.cron}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-zinc-500 mt-0.5">
                  <span className="flex items-center gap-1"><Repeat size={9} />{trigger.schedule}</span>
                  <span>上次: {trigger.lastRun}</span>
                  <span>下次: {trigger.nextRun}</span>
                </div>
              </div>
              <button
                onClick={() => toast.success(`已${trigger.status === 'active' ? '暂停' : '启用'}: ${trigger.name}`)}
                className={`text-[10px] px-2 py-1 rounded ${trigger.status === 'active' ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25' : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'} transition`}
              >
                {trigger.status === 'active' ? '运行中' : '已暂停'}
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => toast.info('新建定时触发功能即将上线')}
          className="mt-3 w-full py-2 border border-dashed border-zinc-700 rounded-lg text-xs text-zinc-500 hover:text-orange-400 hover:border-orange-500/30 transition"
        >
          + 新建定时触发
        </button>
      </div>

      {/* Mobile overlays */}
      {mobileView === 'detail' && selectedWorkflow && renderMobileDetail()}
      {mobileView === 'edit' && editing && renderMobileEdit()}

      {/* Template picker */}
      {showTemplates && renderTemplatePicker()}
      {ConfirmDialogUI}
    </div>
  );
}
