/**
 * MessageList — v3.0 Enhanced Execution Visualization
 * 
 * Renders chat messages with rich tool execution display:
 * - Vertical timeline with pulse animations for execution steps
 * - Enhanced ToolCards with progress bars, terminal output, screenshots, images
 * - Unified execution panel with collapsible sections
 * - Persisted tool summary for history messages
 * - Routing info badges on AI messages
 */

import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useMessageStore } from '../../stores/useMessageStore';
import { normalizeContent, parseMessageContent } from '../../lib/types';
import type { RoutingInfo, Attachment, ExecutionStep, ToolCall } from '../../lib/types';
import { MessageAttachments } from './MessageAttachments';
import { AIFileOutput, detectFiles } from './AIFileOutput';
import {
  Loader2, Bot, User, Brain, AlertCircle, Cpu, Zap,
  Search, Terminal, FileText, Image, Code, Globe, Pencil,
  Database, Clock, CheckCircle2, XCircle, ChevronDown, ChevronRight,
  Sparkles, Activity, Eye, X, Play, Volume2, Download,
  ArrowRight, Circle, Minus, Copy, Check, RefreshCw, ArrowDown,
  ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { SearchResultCards } from './SearchResultCards';
import { copyToClipboard } from '../../lib/clipboard';
import { KnowledgeReferences } from './KnowledgeReferences';
import { LazyStreamdown as Streamdown } from './LazyStreamdown';
import { useI18n } from '../../lib/i18n';
import { useChatActions } from '../../hooks/useChatActions';
import { SupervisorTimeline } from './SupervisorTimeline';
import { TaskPlanPanel } from './TaskPlanPanel'; // v27.0: Inline plan rendering
import { TASK_PHASE_LABELS } from '../../hooks/wsEventReducer'; // R91: task phase labels
import { logger } from "../../lib/logger";
// Note: Streamdown (shiki 9MB + mermaid 1.7MB) is lazy-loaded via LazyStreamdown
// to prevent blocking initial page render on slow connections

// ─── Task type display config ──────────────────────────────

// Task type config — labels are resolved via i18n at render time
const TASK_TYPE_STYLE: Record<string, { color: string; bg: string; i18nKey: string }> = {
  code: { color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30', i18nKey: 'msg.taskType.code' },
  reasoning: { color: 'text-amber-400', bg: 'bg-amber-500/15 border-amber-500/30', i18nKey: 'msg.taskType.reasoning' },
  creative: { color: 'text-purple-400', bg: 'bg-purple-500/15 border-purple-500/30', i18nKey: 'msg.taskType.creative' },
  research: { color: 'text-cyan-400', bg: 'bg-cyan-500/15 border-cyan-500/30', i18nKey: 'msg.taskType.research' },
  image_generation: { color: 'text-pink-400', bg: 'bg-pink-500/15 border-pink-500/30', i18nKey: 'msg.taskType.imageGeneration' },
  chat: { color: 'text-zinc-400', bg: 'bg-zinc-500/15 border-zinc-500/30', i18nKey: 'msg.taskType.chat' },
};

// Thinking labels — resolved via i18n
const THINKING_I18N_KEYS: Record<string, string> = {
  low: 'msg.thinking.low',
  medium: 'msg.thinking.medium',
  high: 'msg.thinking.high',
  xhigh: 'msg.thinking.xhigh',
};

function formatModelName(model: string | null): string {
  if (!model) return '';
  return model
    .replace('anthropic/', '')
    .replace('openai/', '')
    .replace('google/', '')
    .replace('deepseek/', '')
    .replace('meta-llama/', '');
}

// ─── Tool Display Config ────────────────────────────────────

interface ToolDisplayConfig {
  icon: React.ReactNode;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  accentColor: string;
}

// Skill category → display config mapping
// Skill category config — keyed by Chinese category name from backend, style only
const SKILL_CATEGORY_STYLE: Record<string, { color: string; bgColor: string; borderColor: string; accentColor: string }> = {
  '运维': { color: 'text-teal-400', bgColor: 'bg-teal-500/8', borderColor: 'border-teal-500/20', accentColor: 'bg-teal-500' },
  '安全': { color: 'text-red-400', bgColor: 'bg-red-500/8', borderColor: 'border-red-500/20', accentColor: 'bg-red-500' },
  '网络': { color: 'text-sky-400', bgColor: 'bg-sky-500/8', borderColor: 'border-sky-500/20', accentColor: 'bg-sky-500' },
  '监控': { color: 'text-cyan-400', bgColor: 'bg-cyan-500/8', borderColor: 'border-cyan-500/20', accentColor: 'bg-cyan-500' },
  '部署': { color: 'text-blue-400', bgColor: 'bg-blue-500/8', borderColor: 'border-blue-500/20', accentColor: 'bg-blue-500' },
  '备份': { color: 'text-amber-400', bgColor: 'bg-amber-500/8', borderColor: 'border-amber-500/20', accentColor: 'bg-amber-500' },
  '日志': { color: 'text-yellow-400', bgColor: 'bg-yellow-500/8', borderColor: 'border-yellow-500/20', accentColor: 'bg-yellow-500' },
  '成本': { color: 'text-emerald-400', bgColor: 'bg-emerald-500/8', borderColor: 'border-emerald-500/20', accentColor: 'bg-emerald-500' },
  '环境': { color: 'text-indigo-400', bgColor: 'bg-indigo-500/8', borderColor: 'border-indigo-500/20', accentColor: 'bg-indigo-500' },
  '定时': { color: 'text-violet-400', bgColor: 'bg-violet-500/8', borderColor: 'border-violet-500/20', accentColor: 'bg-violet-500' },
  '进化': { color: 'text-fuchsia-400', bgColor: 'bg-fuchsia-500/8', borderColor: 'border-fuchsia-500/20', accentColor: 'bg-fuchsia-500' },
  '创作': { color: 'text-pink-400', bgColor: 'bg-pink-500/8', borderColor: 'border-pink-500/20', accentColor: 'bg-pink-500' },
  '查询': { color: 'text-orange-400', bgColor: 'bg-orange-500/8', borderColor: 'border-orange-500/20', accentColor: 'bg-orange-500' },
  '开发': { color: 'text-lime-400', bgColor: 'bg-lime-500/8', borderColor: 'border-lime-500/20', accentColor: 'bg-lime-500' },
  '管理': { color: 'text-rose-400', bgColor: 'bg-rose-500/8', borderColor: 'border-rose-500/20', accentColor: 'bg-rose-500' },
};

function getSkillConfig(skillCategory: string, skillLabel: string): ToolDisplayConfig {
  const cat = SKILL_CATEGORY_STYLE[skillCategory] || SKILL_CATEGORY_STYLE['运维'];
  return {
    icon: <Sparkles size={13} />,
    label: skillLabel,
    ...cat,
  };
}

function getToolConfig(toolName: string): ToolDisplayConfig {
  const configs: Record<string, ToolDisplayConfig> = {
    web_search: {
      icon: <Search size={13} />,
      label: 'msg.tool.webSearch',
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/8',
      borderColor: 'border-blue-500/20',
      accentColor: 'bg-blue-500',
    },
    web_fetch: {
      icon: <Globe size={13} />,
      label: 'msg.tool.webFetch',
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/8',
      borderColor: 'border-cyan-500/20',
      accentColor: 'bg-cyan-500',
    },
    browser: {
      icon: <Eye size={13} />,
      label: 'msg.tool.browser',
      color: 'text-indigo-400',
      bgColor: 'bg-indigo-500/8',
      borderColor: 'border-indigo-500/20',
      accentColor: 'bg-indigo-500',
    },
    exec: {
      icon: <Terminal size={13} />,
      label: 'msg.tool.terminal',
      color: 'text-green-400',
      bgColor: 'bg-green-500/8',
      borderColor: 'border-green-500/20',
      accentColor: 'bg-green-500',
    },
    read: {
      icon: <FileText size={13} />,
      label: 'msg.tool.readFile',
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/8',
      borderColor: 'border-amber-500/20',
      accentColor: 'bg-amber-500',
    },
    write: {
      icon: <Pencil size={13} />,
      label: 'msg.tool.writeFile',
      color: 'text-orange-400',
      bgColor: 'bg-orange-500/8',
      borderColor: 'border-orange-500/20',
      accentColor: 'bg-orange-500',
    },
    edit: {
      icon: <Pencil size={13} />,
      label: 'msg.tool.editFile',
      color: 'text-orange-400',
      bgColor: 'bg-orange-500/8',
      borderColor: 'border-orange-500/20',
      accentColor: 'bg-orange-500',
    },
    image: {
      icon: <Image size={13} />,
      label: 'msg.tool.genImage',
      color: 'text-pink-400',
      bgColor: 'bg-pink-500/8',
      borderColor: 'border-pink-500/20',
      accentColor: 'bg-pink-500',
    },
    canvas: {
      icon: <Image size={13} />,
      label: 'msg.tool.canvas',
      color: 'text-pink-400',
      bgColor: 'bg-pink-500/8',
      borderColor: 'border-pink-500/20',
      accentColor: 'bg-pink-500',
    },
    tts: {
      icon: <Volume2 size={13} />,
      label: 'msg.tool.tts',
      color: 'text-violet-400',
      bgColor: 'bg-violet-500/8',
      borderColor: 'border-violet-500/20',
      accentColor: 'bg-violet-500',
    },
    code: {
      icon: <Code size={13} />,
      label: 'msg.tool.codeExec',
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/8',
      borderColor: 'border-emerald-500/20',
      accentColor: 'bg-emerald-500',
    },
    memory_search: {
      icon: <Database size={13} />,
      label: 'msg.tool.memorySearch',
      color: 'text-violet-400',
      bgColor: 'bg-violet-500/8',
      borderColor: 'border-violet-500/20',
      accentColor: 'bg-violet-500',
    },
    memory_get: {
      icon: <Database size={13} />,
      label: 'msg.tool.memoryGet',
      color: 'text-violet-400',
      bgColor: 'bg-violet-500/8',
      borderColor: 'border-violet-500/20',
      accentColor: 'bg-violet-500',
    },
  };
  return configs[toolName] || {
    icon: <Sparkles size={13} />,
    label: toolName,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/8',
    borderColor: 'border-purple-500/20',
    accentColor: 'bg-purple-500',
  };
}

/** Get config for a tool, with Skill-aware override */
function getToolConfigForCall(tool: ToolCall): ToolDisplayConfig {
  if (tool.skill && tool.skillLabel && tool.skillCategory) {
    return getSkillConfig(tool.skillCategory, tool.skillLabel);
  }
  return getToolConfig(tool.tool);
}

/** Generate a friendly title from tool name and args — uses i18n key prefixes */
function getToolDisplayTitle(toolName: string, args: string, t?: (k: any) => string): string {
  const tr = t || ((k: string) => k);
  try {
    const parsed = args ? JSON.parse(args) : {};
    switch (toolName) {
      case 'web_search': return `${tr('msg.toolTitle.search')}: ${parsed.query || ''}`;
      case 'web_fetch': return `${tr('msg.toolTitle.fetch')}: ${(parsed.url || '').substring(0, 50)}`;
      case 'browser': return `${tr('msg.toolTitle.browserAction')} ${parsed.action || ''}`;
      case 'exec': {
        // v4: Never show raw commands to users — always use generic title
        return tr('msg.toolTitle.execCmd') || '执行命令';
      }
      case 'read': return `${tr('msg.toolTitle.read')} ${(parsed.path || '').split('/').pop() || tr('msg.toolTitle.file')}`;
      case 'write': return `${tr('msg.toolTitle.write')} ${(parsed.path || '').split('/').pop() || tr('msg.toolTitle.file')}`;
      case 'edit': return `${tr('msg.toolTitle.edit')} ${(parsed.path || '').split('/').pop() || tr('msg.toolTitle.file')}`;
      case 'image': return tr('msg.toolTitle.genImage');
      case 'canvas': return tr('msg.toolTitle.canvasOp');
      case 'tts': return tr('msg.toolTitle.tts');
      case 'memory_search': return `${tr('msg.toolTitle.memSearch')}: ${parsed.query || ''}`;
      case 'memory_get': return tr('msg.toolTitle.memGet');
      default: return `${toolName}`;
    }
  } catch {
    return toolName;
  }
}

// ─── Execution Timeline (v3.0) ─────────────────────────────


// [R67] Plan Progress Bar — shows real planner steps instead of micro tool-call steps
function PlanProgressBar({ progress }: { progress: import('../../stores/useMessageStore').PlanProgress }) {
  const { t } = useI18n();
  const doneCount = progress.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const activeStep = progress.steps.find(s => s.status === 'doing' || s.status === 'active' || s.status === 'retrying');
  const isComplete = progress.status === 'completed' || (doneCount === progress.totalSteps && progress.totalSteps > 0);
  const isFailed = progress.status === 'failed';
  // Smooth progress: use visual step count that lags behind actual by 1 transition
  const visualDone = isComplete ? progress.totalSteps : doneCount;
  const pct = progress.totalSteps > 0 ? Math.min((visualDone / progress.totalSteps) * 100, 100) : 0;
  return (
    <div className="flex gap-2 sm:gap-3 transition-all duration-500 animate-in fade-in slide-in-from-bottom-1">
      <div className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 mt-0.5">
        <div className={`w-full h-full rounded-full flex items-center justify-center transition-colors duration-500 ${
          isComplete ? 'bg-emerald-500/20' : isFailed ? 'bg-red-500/20' : 'bg-blue-500/20'
        }`}>
          {isComplete ? (
            <CheckCircle2 size={14} className="text-emerald-400" />
          ) : isFailed ? (
            <AlertCircle size={14} className="text-red-400" />
          ) : (
            <div className="relative">
              <Activity size={14} className="text-blue-400" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-400 animate-ping" />
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        {/* Goal display */}
        {progress.goal && (
          <p className="text-[11px] sm:text-xs text-zinc-400 mb-1.5 leading-relaxed line-clamp-2">
            {progress.goal}
          </p>
        )}
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-[11px] sm:text-xs font-medium transition-colors duration-500 ${
            isComplete ? 'text-emerald-300' : isFailed ? 'text-red-300' : 'text-blue-300'
          }`}>
            {isComplete ? t('msg.exec.done') : isFailed ? '\u6267\u884c\u5931\u8d25' : t('msg.phase.executing')}
          </span>
          <span className="text-[10px] text-zinc-500">
            {`\u7b2c${activeStep ? activeStep.id : doneCount}/${progress.totalSteps}\u6b65`}
          </span>
          <div className="flex-1 max-w-[160px] h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ease-out ${
                isComplete ? 'bg-emerald-500' : isFailed ? 'bg-red-500' : 'bg-blue-500'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="relative pl-3 space-y-0.5">
          <div className="absolute left-[5px] top-1 bottom-1 w-px bg-zinc-700/50" />
          {progress.steps.map((step, idx) => {
            const isDone = step.status === 'done' || step.status === 'skipped';
            const isActive = step.status === 'doing' || step.status === 'active' || step.status === 'retrying';
            const isFail = step.status === 'failed' || step.status === 'blocked';
            return (
              <div key={step.id} className="relative flex items-start gap-2 py-0.5"
                style={{ transitionDelay: `${idx * 150}ms` }}>
                <div className={`relative z-10 mt-1.5 w-2 h-2 rounded-full transition-all duration-500 ${
                  isDone ? 'bg-emerald-400 scale-100' :
                  isActive ? 'bg-blue-400 animate-pulse scale-110' :
                  isFail ? 'bg-red-400' :
                  'bg-zinc-600 scale-90'
                }`} />
                <span className={`text-[11px] sm:text-xs leading-relaxed transition-all duration-500 ${
                  isDone ? 'text-zinc-400' :
                  isActive ? 'text-blue-300 font-medium' :
                  isFail ? 'text-red-400' :
                  'text-zinc-600'
                }`}>
                  {step.title}{isActive ? ' ...' : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
function ExecutionTimeline({ steps, tools }: { steps: ExecutionStep[]; tools: ToolCall[] }) {
  const { t } = useI18n();
  const hasRunning = steps.some(s => s.status === 'running') || tools.some(t => t.status === 'running');
  const [collapsed, setCollapsed] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const prevHasRunningRef = useRef(hasRunning);
  const completedSteps = steps.filter(s => s.status === 'completed').length;
  const completedTools = tools.filter(t => t.status === 'completed').length;
  const totalItems = steps.length + tools.length;

  // v25.0: Auto-collapse when execution finishes (running → not running), unless user manually toggled
  useEffect(() => {
    if (prevHasRunningRef.current && !hasRunning && !userToggled) {
      // Delay collapse for smooth transition
      const timer = setTimeout(() => setCollapsed(true), 800);
      return () => clearTimeout(timer);
    }
    prevHasRunningRef.current = hasRunning;
  }, [hasRunning, userToggled]);

  // Auto-expand when new tools start running
  useEffect(() => {
    if (hasRunning && collapsed && !userToggled) {
      setCollapsed(false);
    }
  }, [hasRunning, collapsed, userToggled]);

  if (totalItems === 0) return null;

  const handleToggle = () => {
    setUserToggled(true);
    setCollapsed(!collapsed);
  };

  return (
    <div className="flex gap-2 sm:gap-3 transition-all duration-300">
      {/* Avatar column */}
      <div className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 mt-0.5">
        <div className={`w-full h-full rounded-full flex items-center justify-center transition-colors duration-300 ${
          hasRunning ? 'bg-blue-500/20' : 'bg-emerald-500/20'
        }`}>
          {hasRunning ? (
            <div className="relative">
              <Activity size={14} className="text-blue-400" />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-400 animate-ping" />
            </div>
          ) : (
            <CheckCircle2 size={14} className="text-emerald-400" />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header bar */}
        <button
          onClick={handleToggle}
          className="flex items-center gap-2 w-full text-left group mb-1"
        >
          <span className={`text-[11px] sm:text-xs font-medium transition-colors duration-200 ${
            hasRunning ? 'text-blue-300' : 'text-emerald-300'
          }`}>
            {hasRunning ? t('msg.phase.executing') : t('msg.exec.done')}
          </span>
          <span className="text-[10px] text-zinc-500">
            {completedSteps + completedTools}/{totalItems} {t('msg.exec.steps')}
          </span>
          {/* Mini progress bar */}
          <div className="flex-1 max-w-[120px] h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                hasRunning ? 'bg-blue-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${totalItems > 0 ? ((completedSteps + completedTools) / totalItems) * 100 : 0}%` }}
            />
          </div>
          <span className="ml-auto text-zinc-600 group-hover:text-zinc-400 transition-colors">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
        </button>

        {/* Timeline items with slide animation */}
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
          collapsed ? 'max-h-0 opacity-0' : 'max-h-[2000px] opacity-100'
        }`}>
          <div className="relative pl-3 space-y-0.5">
            {/* Vertical line */}
            <div className="absolute left-[5px] top-1 bottom-1 w-px bg-zinc-700/50" />

            {/* Steps */}
            {steps.map((step, i) => (
              <TimelineStepItem key={step.id} step={step} isLast={i === steps.length - 1 && tools.length === 0} />
            ))}

            {/* Tools */}
            {tools.map((tool, i) => (
              <TimelineToolItem key={tool.id} tool={tool} isLast={i === tools.length - 1} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TimelineStepItem({ step, isLast }: { step: ExecutionStep; isLast: boolean }) {
  const elapsed = step.completedAt
    ? `${((step.completedAt - step.startedAt) / 1000).toFixed(1)}s`
    : null;

  return (
    <div className={`relative flex items-center gap-2 py-0.5 ${
      step.status === 'completed' ? 'opacity-60' : 'opacity-100'
    }`}>
      {/* Dot */}
      <div className="absolute -left-3 w-[11px] flex justify-center">
        {step.status === 'running' ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-50" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
          </span>
        ) : step.status === 'completed' ? (
          <CheckCircle2 size={11} className="text-emerald-500" />
        ) : (
          <XCircle size={11} className="text-red-400" />
        )}
      </div>

      <span className={`text-[11px] sm:text-xs font-medium ${
        step.status === 'running' ? 'text-blue-300' : step.status === 'completed' ? 'text-zinc-400' : 'text-red-400'
      }`}>
        {step.title}
      </span>
      {step.detail && (
        <span className="text-[10px] text-zinc-600 truncate max-w-[180px] sm:max-w-[250px]">
          {step.detail}
        </span>
      )}
      {elapsed && (
        <span className="text-[10px] text-zinc-600 ml-auto shrink-0 flex items-center gap-0.5 tabular-nums">
          <Clock size={9} />
          {elapsed}
        </span>
      )}
    </div>
  );
}

function TimelineToolItem({ tool, isLast }: { tool: ToolCall; isLast: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const config = getToolConfigForCall(tool);
  // v24.1: Prioritize backend description > skillLabel > frontend fallback
  const title = tool.description || (tool.skillLabel ? `✨ ${tool.skillLabel}` : getToolDisplayTitle(tool.tool, tool.args, t));

  // Error styling override
  const isError = tool.status === 'error' || tool.success === false;
  const cardBorder = isError ? 'border-red-500/40' : config.borderColor;
  const cardBg = isError ? 'bg-red-500/5' : config.bgColor;

  // Parse result for special rendering
  let resultObj: Record<string, unknown> | null = null;
  if (tool.result) {
    try { resultObj = JSON.parse(tool.result); } catch { /* keep as string */ }
  }
  const screenshot = (resultObj?.screenshot as string | undefined) || tool.screenshot;
  const imageUrl = extractImageUrl(tool.tool, resultObj, tool.result);

  // Extract browser URL from args
  const browserUrl = tool.tool === 'browser' ? extractBrowserUrl(tool.args) : null;

  return (
    <div className="relative py-0.5">
      {/* Dot */}
      <div className="absolute -left-3 top-[7px] w-[11px] flex justify-center">
        {tool.status === 'running' ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ backgroundColor: 'currentColor' }} />
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.accentColor}`} />
          </span>
        ) : tool.status === 'completed' && tool.success !== false ? (
          <CheckCircle2 size={11} className="text-emerald-500" />
        ) : (
          <XCircle size={11} className="text-red-400" />
        )}
      </div>

      {/* Tool card */}
      <div className={`ml-1 rounded-lg border ${cardBorder} ${cardBg} overflow-hidden transition-all duration-200`}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className={`shrink-0 ${config.color}`}>{config.icon}</span>
          <span className={`text-[11px] sm:text-xs font-medium ${config.color} truncate flex-1`}>{title}</span>

          {/* Running indicator */}
          {tool.status === 'running' && (
            <Loader2 size={11} className={`animate-spin ${config.color} shrink-0`} />
          )}
          {tool.status === 'completed' && tool.success !== false && (
            <CheckCircle2 size={10} className="text-emerald-400/60 shrink-0" />
          )}
          {(tool.status === 'error' || tool.success === false) && (
            <XCircle size={10} className="text-red-400/60 shrink-0" />
          )}

          {/* Duration */}
          {tool.status !== 'running' && tool.duration != null && (
            <span className="text-[10px] text-zinc-500 shrink-0 tabular-nums">
              {tool.duration >= 1000 ? `${(tool.duration / 1000).toFixed(1)}s` : `${tool.duration}ms`}
            </span>
          )}

          <span className="text-zinc-600 shrink-0">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        </button>

        {/* Browser URL subtitle (always visible) */}
        {browserUrl && (
          <div className="px-2.5 pb-1">
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 truncate">
              <Globe size={9} className="shrink-0 text-zinc-600" />
              <span className="truncate">{browserUrl}</span>
            </div>
          </div>
        )}

        {/* Browser screenshot thumbnail (visible when not expanded and screenshot exists) */}
        {screenshot && !expanded && (
          <BrowserScreenshotThumbnail src={screenshot} />
        )}

        {/* Image generation thumbnail (visible when not expanded and imageUrl exists) */}
        {imageUrl && !expanded && tool.status === 'completed' && (
          <div className="px-2.5 pb-1.5">
            <div className="relative group cursor-pointer" onClick={() => setExpanded(true)}>
              <img
                src={imageUrl}
                alt={t('msg.card.generatedImage')}
                className="rounded border border-zinc-700/50 max-w-full max-h-32 object-contain"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded flex items-center justify-center">
                <Eye size={16} className="text-white/0 group-hover:text-white/80 transition-colors" />
              </div>
            </div>
          </div>
        )}

        {/* Image generation loading placeholder */}
        {(tool.tool === 'image' || tool.tool === 'canvas' || tool.tool === 'generate_image') && tool.status === 'running' && (
          <div className="px-2.5 pb-1.5">
            <div className="w-full h-24 rounded border border-zinc-700/30 bg-zinc-900/50 flex items-center justify-center gap-2">
              <Sparkles size={14} className="text-purple-400/60 animate-pulse" />
              <span className="text-[10px] text-zinc-500">{t('msg.card.imageGenerating')}</span>
            </div>
          </div>
        )}

        {/* Running progress — exec tools get live terminal, others get single-line */}
        {tool.status === 'running' && tool.tool === 'exec' && (tool.progressHistory?.length || 0) > 0 && (
          <LiveTerminal lines={tool.progressHistory || []} />
        )}
        {tool.status === 'running' && tool.tool !== 'exec' && tool.progress && (
          <div className="px-2.5 pb-1.5">
            <div className="text-[10px] text-zinc-500 bg-black/20 rounded px-2 py-1 font-mono truncate">
              {String(tool.progress || '').substring(0, 120)}
            </div>
          </div>
        )}

        {/* Running animation bar */}
        {tool.status === 'running' && (
          <div className="h-0.5 w-full overflow-hidden">
            <div className={`h-full ${config.accentColor} animate-indeterminate`} />
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="px-2.5 pb-2 space-y-1.5 border-t border-white/5">
            {/* Args */}
            {tool.args && (
              <div className="mt-1.5">
                <p className="text-[10px] text-zinc-600 mb-0.5 font-medium">{t('msg.card.params')}</p>
                <pre className="text-[10px] sm:text-[11px] text-zinc-500 bg-black/20 rounded px-2 py-1 overflow-x-auto max-h-24 overflow-y-auto font-mono">
                  {formatArgs(tool.args)}
                </pre>
              </div>
            )}

            {/* Result */}
            {tool.result && (
              <div>
                <p className="text-[10px] text-zinc-600 mb-0.5 font-medium">{t('msg.card.result')}</p>
                {tool.tool === 'exec' ? (
                  <TerminalResult content={getResultText(tool.result)} />
                ) : tool.tool === 'web_search' ? (
                  <SearchResultCards result={tool.result} />
                ) : (
                  <ResultBlock text={getResultText(tool.result)} expanded={resultExpanded} onToggle={() => setResultExpanded(!resultExpanded)} />
                )}
              </div>
            )}

            {/* Screenshot (full size in expanded view) */}
            {screenshot && (
              <div>
                <p className="text-[10px] text-zinc-600 mb-0.5 font-medium">{t('msg.card.browserScreenshot')}</p>
                <ImagePreview src={screenshot} alt={t('msg.card.browserScreenshot')} maxH="max-h-72" />
              </div>
            )}

            {/* Image result */}
            {imageUrl && (
              <div>
                <p className="text-[10px] text-zinc-600 mb-0.5 font-medium">{t('msg.card.generatedImage')}</p>
                <ImagePreview src={imageUrl} alt={t('msg.card.generatedImage')} maxH="max-h-72" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Image Preview with Lightbox ────────────────────────────

function ImagePreview({ src, alt, maxH = 'max-h-48' }: { src: string; alt: string; maxH?: string }) {
  const [lightbox, setLightbox] = useState(false);

  // P4-2: Close lightbox on Escape key
  useEffect(() => {
    if (!lightbox) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightbox]);

  return (
    <>
      <img
        src={src}
        alt={alt}
        className={`rounded border border-zinc-700/50 max-w-full ${maxH} object-contain cursor-pointer hover:opacity-90 transition-opacity`}
        onClick={() => setLightbox(true)}
        loading="lazy"
      />
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setLightbox(false)}
        >
          <button
            className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors"
            onClick={() => setLightbox(false)}
            aria-label="close"
          >
            <X size={24} />
          </button>
          <img
            src={src}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
          />
        </div>
      )}
    </>
  );
}

// ─── Terminal-style result for exec tool ────────────────────

function TerminalResult({ content }: { content: string }) {
  return (
    <div className="bg-zinc-950 rounded border border-zinc-800 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900/80 border-b border-zinc-800">
        <span className="w-2 h-2 rounded-full bg-red-500/60" />
        <span className="w-2 h-2 rounded-full bg-yellow-500/60" />
        <span className="w-2 h-2 rounded-full bg-green-500/60" />
        <span className="text-[9px] text-zinc-600 ml-1 font-mono">Terminal</span>
      </div>
      <pre className="text-[10px] sm:text-[11px] text-green-400/80 px-2 py-1.5 overflow-x-auto max-h-40 overflow-y-auto font-mono whitespace-pre-wrap break-words">
        {String(content || '').substring(0, 10000)}
      </pre>
    </div>
  );
}

// ─── Live Terminal (streaming exec output) ─────────────────

function LiveTerminal({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const MAX_VISIBLE_LINES = 50;

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  // Show only the last N lines for performance
  const visibleLines = lines.length > MAX_VISIBLE_LINES
    ? lines.slice(-MAX_VISIBLE_LINES)
    : lines;
  const truncated = lines.length > MAX_VISIBLE_LINES;

  return (
    <div className="mx-2.5 mb-1.5">
      <div className="bg-zinc-950 rounded border border-zinc-800 overflow-hidden">
        {/* Terminal header */}
        <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900/80 border-b border-zinc-800">
          <span className="w-2 h-2 rounded-full bg-red-500/60" />
          <span className="w-2 h-2 rounded-full bg-yellow-500/60" />
          <span className="w-2 h-2 rounded-full bg-green-500/60" />
          <span className="text-[9px] text-zinc-600 ml-1 font-mono">Terminal</span>
          <span className="ml-auto flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-[9px] text-green-400/70 font-mono">LIVE</span>
          </span>
        </div>
        {/* Terminal body */}
        <div
          ref={scrollRef}
          className="px-2 py-1.5 max-h-40 overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent"
        >
          {truncated && (
            <div className="text-[9px] text-zinc-600 mb-1 font-mono">... ({lines.length - MAX_VISIBLE_LINES} lines hidden)</div>
          )}
          {visibleLines.map((line, i) => (
            <div key={i} className="text-[10px] sm:text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed">
              <TerminalLine text={line} />
            </div>
          ))}
          {/* Blinking cursor */}
          <span className="inline-block w-1.5 h-3 bg-green-400/70 animate-pulse ml-0.5" />
        </div>
      </div>
    </div>
  );
}

/** Parse basic ANSI colors and render terminal line */
function TerminalLine({ text }: { text: string }) {
  // Simple ANSI color mapping
  const parts = parseAnsiColors(text);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i} className={part.className}>{part.text}</span>
      ))}
    </>
  );
}

interface AnsiPart {
  text: string;
  className: string;
}

/** Parse basic ANSI escape codes into styled parts */
function parseAnsiColors(text: string): AnsiPart[] {
  // Strip \x1b[ or \033[ sequences and map to Tailwind classes
  const ansiRegex = /\x1b\[(\d+(?:;\d+)*)m/g;
  const parts: AnsiPart[] = [];
  let lastIndex = 0;
  let currentClass = 'text-green-400/80'; // default terminal green

  const colorMap: Record<string, string> = {
    '0': 'text-green-400/80',   // reset
    '1': 'font-bold',           // bold
    '30': 'text-zinc-500',      // black
    '31': 'text-red-400',       // red
    '32': 'text-green-400',     // green
    '33': 'text-yellow-400',    // yellow
    '34': 'text-blue-400',      // blue
    '35': 'text-purple-400',    // magenta
    '36': 'text-cyan-400',      // cyan
    '37': 'text-zinc-300',      // white
    '90': 'text-zinc-500',      // bright black (gray)
    '91': 'text-red-300',       // bright red
    '92': 'text-green-300',     // bright green
    '93': 'text-yellow-300',    // bright yellow
    '94': 'text-blue-300',      // bright blue
    '95': 'text-purple-300',    // bright magenta
    '96': 'text-cyan-300',      // bright cyan
    '97': 'text-white',         // bright white
  };

  let match;
  while ((match = ansiRegex.exec(text)) !== null) {
    // Add text before this escape
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), className: currentClass });
    }
    // Update color
    const codes = match[1].split(';');
    for (const code of codes) {
      if (colorMap[code]) {
        currentClass = code === '0' ? 'text-green-400/80' : colorMap[code];
      }
    }
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), className: currentClass });
  }

  // If no ANSI codes found, return the whole text with default color
  if (parts.length === 0) {
    parts.push({ text, className: 'text-green-400/80' });
  }

  return parts;
}

// ─── Helper functions ───────────────────────────────────────

function formatArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'object') {
    try { return JSON.stringify(args, null, 2); } catch { return String(args); }
  }
  const str = String(args);
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return str.length > 500 ? str.slice(0, 500) + '...' : str;
  }
}

function getResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'object') {
    try {
      const obj = result as Record<string, unknown>;
      if (obj.text && typeof obj.text === 'string') return obj.text;
      if (obj.output && typeof obj.output === 'string') return obj.output;
      if (obj.stdout && typeof obj.stdout === 'string') return obj.stdout;
      if (obj.content) return typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  if (typeof result !== 'string') return String(result);
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.text) return String(parsed.text);
      if (parsed.output) return String(parsed.output);
      if (parsed.stdout) return String(parsed.stdout);
      if (parsed.content) return typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
      return JSON.stringify(parsed, null, 2);
    }
    return result;
  } catch {
    return result;
  }
}

const RESULT_COLLAPSE_THRESHOLD = 200;

function ResultBlock({ text, expanded, onToggle }: { text: string; expanded: boolean; onToggle: () => void }) {
  if (!text) return null;
  const needsCollapse = text.length > RESULT_COLLAPSE_THRESHOLD;
  const displayText = needsCollapse && !expanded ? text.substring(0, RESULT_COLLAPSE_THRESHOLD) + '...' : text.substring(0, 5000);

  return (
    <div>
      <pre className="text-[10px] sm:text-[11px] text-zinc-400 bg-black/20 rounded px-2 py-1 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono">
        {displayText}
      </pre>
      {needsCollapse && (
        <button
          onClick={onToggle}
          className="text-[10px] text-blue-400 hover:text-blue-300 mt-0.5 transition-colors"
        >
          {expanded ? '▲ 收起' : '▼ 查看详情'}
        </button>
      )}
    </div>
  );
}

function extractImageUrl(toolName: string, resultObj: Record<string, unknown> | null, rawResult?: string): string | null {
  // Direct image tools
  if (toolName === 'image' || toolName === 'canvas' || toolName === 'generate_image') {
    if (resultObj?.url) return resultObj.url as string;
    if (resultObj?.image_url) return resultObj.image_url as string;
    if (resultObj?.output_url) return resultObj.output_url as string;
    if (rawResult) {
      const urlMatch = rawResult.match(/https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
      if (urlMatch) return urlMatch[0];
    }
    return null;
  }
  // exec tool: check for MEDIA tokens (image generation via exec)
  if (toolName === 'exec' && rawResult) {
    const mediaMatch = rawResult.match(/MEDIA:\s*(https?:\/\/[^\s"']+\.(png|jpg|jpeg|gif|webp))/i);
    if (mediaMatch) return mediaMatch[1];
    // Also check for workspace image URLs in result
    const wsMatch = rawResult.match(/https?:\/\/ranger\.voyage\/workspace\/[^\s"']+\.(png|jpg|jpeg|gif|webp)/i);
    if (wsMatch) return wsMatch[0];
  }
  return null;
}

/** Extract URL from browser tool args */
function extractBrowserUrl(args: string): string | null {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return parsed?.url || null;
  } catch {
    return null;
  }
}

function MsgBubbleTaskLabel({ i18nKey }: { i18nKey: string }) {
  const { t } = useI18n();
  return <>{t(i18nKey as any)}</>;
}

function MsgBubbleThinkingLabel({ thinking }: { thinking: string }) {
  const { t } = useI18n();
  const key = THINKING_I18N_KEYS[thinking];
  const label = key ? t(key as any) : thinking;
  return <>{label}{t('msg.thinkingSuffix')}</>;
}

function ViewLargerLabel() {
  const { t } = useI18n();
  return <>{t('msg.preview.viewLarger')}</>;
}

// ─── Browser Screenshot Thumbnail (always visible) ────────

function BrowserScreenshotThumbnail({ src }: { src: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // P4-2: Close lightbox on Escape key
  useEffect(() => {
    if (!lightbox) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightbox]);

  if (error) return null;

  return (
    <>
      <div
        className="mx-2.5 mb-1.5 relative cursor-pointer group"
        onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
      >
        {/* Skeleton while loading */}
        {!loaded && (
          <div className="w-full h-24 rounded bg-zinc-800/60 animate-pulse flex items-center justify-center">
            <Globe size={16} className="text-zinc-600" />
          </div>
        )}
        <div className="relative overflow-hidden rounded border border-zinc-700/40">
          <img
            src={src}
            alt="screenshot"
            className={`w-full max-h-36 object-cover object-top transition-opacity duration-300 ${
              loaded ? 'opacity-100' : 'opacity-0 h-0'
            }`}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            loading="lazy"
          />
          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-white text-[11px] bg-black/60 px-2 py-1 rounded-full">
              <Eye size={12} />
              <ViewLargerLabel />
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="screenshot preview"
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setLightbox(false)}
        >
          <button
            className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors z-10"
            onClick={() => setLightbox(false)}
            aria-label="close"
          >
            <X size={24} />
          </button>
          <img
            src={src}
            alt="screenshot"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
          />
        </div>
      )}
    </>
  );
}

// ─── Sanitize AI Content ────────────────────────────────────

function sanitizeAIContent(content: string): string {
  if (!content) return '';
  let safe = content;

  // 0. Preserve code blocks FIRST so tool tags inside code are not stripped
  const codeBlocks: string[] = [];
  safe = safe.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });
  const inlineCodes: string[] = [];
  safe = safe.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `__INLINE_CODE_${inlineCodes.length - 1}__`;
  });

  // 1. Remove <tool_call> blocks entirely
  safe = safe.replace(/<tool_call>\s*[\s\S]*?(?:<\/tool_call>|$)/gi, '');
  safe = safe.replace(/<tool_call>[\s\S]*/gi, '');

  // 1b. Remove <tool_response> blocks
  safe = safe.replace(/<tool_response>[\s\S]*?(?:<\/tool_response>|$)/gi, '');
  safe = safe.replace(/<tool_response>[\s\S]*/gi, '');

  // 1c. Remove <tool_result> blocks
  safe = safe.replace(/<tool_result>[\s\S]*?(?:<\/tool_result>|$)/gi, '');
  safe = safe.replace(/<tool_result>[\s\S]*/gi, '');

  // 1d. Remove orphaned opening/closing tags for all internal types
  safe = safe.replace(/<\/?(tool_call|tool_response|tool_result|function_call|function_result|system_instruction|internal_note|thinking|thought|scratchpad|reflection)[^>]*>/gi, '');

  // 1e. Remove common LLM artifacts: <|...|> tokens, [INST], <<SYS>>, etc.
  safe = safe.replace(/<\|[^|]*\|>/g, '');
  safe = safe.replace(/\[\/?INST\]/gi, '');
  safe = safe.replace(/<<\/?SYS>>/gi, '');

  // 2. Sanitize dangerous HTML tags
  safe = safe.replace(/<(\/?)(script|style|iframe|object|embed|form|input|button|select|textarea|title|meta|link|base|html|head|body)[^>]*>/gi, (match) => {
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });

  // 3. Restore code blocks
  safe = safe.replace(/__INLINE_CODE_(\d+)__/g, (_, i) => inlineCodes[parseInt(i)]);
  safe = safe.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[parseInt(i)]);

  // 4. Clean up excessive whitespace
  safe = safe.replace(/\n{3,}/g, '\n\n');

  return safe.trim();
}

// ─── Elapsed Timer ──────────────────────────────────────

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const sec = Math.floor(elapsed / 1000);
  const min = Math.floor(sec / 60);
  const display = min > 0 ? `${min}m ${sec % 60}s` : `${sec}s`;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
      <Clock size={10} className="text-zinc-500" />
      <span className="tabular-nums">{display}</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function MessageList() {
  const { t } = useI18n();
  const { sendMessage } = useChatActions();
  const messageStore = useMessageStore();
  const { messages, isStreaming, streamingContent, thinkingContent, progressContent, activeTools, executionSteps, isLoadingMessages, error, currentRoutingInfo, messageRoutingMap, planProgress, streamingStartedAt, taskPhase } = messageStore;
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const rafRef = useRef<number | null>(null);

  // Auto-clear error after 10 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      useMessageStore.getState().setError(null);
    }, 10000);
    return () => clearTimeout(timer);
  }, [error]);

  // Track whether user is near bottom (within 150px)
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 150;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isNearBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom);
  }, []);

  // Auto-scroll to bottom — only when near bottom, throttled via RAF
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      rafRef.current = null;
    });
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [messages, streamingContent, thinkingContent, progressContent, activeTools, executionSteps, planProgress, streamingStartedAt]);

  if (isLoadingMessages) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  if (messages.length === 0 && !isStreaming) {
    const capabilities = [
      { icon: '🌐', titleKey: 'msg.welcome.cap.webSearch' as const, descKey: 'msg.welcome.cap.webSearchDesc' as const, color: 'from-blue-500/20 to-blue-600/10 border-blue-500/20', prompt: '帮我联网搜索最新信息' },
      { icon: '💻', titleKey: 'msg.welcome.cap.codeDev' as const, descKey: 'msg.welcome.cap.codeDevDesc' as const, color: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/20', prompt: '帮我编写一个React组件，实现数据表格展示' },
      { icon: '📊', titleKey: 'msg.welcome.cap.dataViz' as const, descKey: 'msg.welcome.cap.dataVizDesc' as const, color: 'from-amber-500/20 to-amber-600/10 border-amber-500/20', prompt: '帮我做一份数据可视化分析' },
      { icon: '📝', titleKey: 'msg.welcome.cap.docReport' as const, descKey: 'msg.welcome.cap.docReportDesc' as const, color: 'from-teal-500/20 to-teal-600/10 border-teal-500/20', prompt: '帮我撰写一份专业报告' },
      { icon: '🌍', titleKey: 'msg.welcome.cap.multiLang' as const, descKey: 'msg.welcome.cap.multiLangDesc' as const, color: 'from-sky-500/20 to-sky-600/10 border-sky-500/20', prompt: '帮我翻译并润色这段内容' },
      { icon: '🤖', titleKey: 'msg.welcome.cap.aiModel' as const, descKey: 'msg.welcome.cap.aiModelDesc' as const, color: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/20', prompt: '帮我分析这个AI模型的输出结果' },
      { icon: '⚡', titleKey: 'msg.welcome.cap.taskOrch' as const, descKey: 'msg.welcome.cap.taskOrchDesc' as const, color: 'from-yellow-400/20 to-yellow-500/10 border-yellow-400/20', prompt: '帮我编排一个多步骤自动化任务' },
      { icon: '🔍', titleKey: 'msg.welcome.cap.research' as const, descKey: 'msg.welcome.cap.researchDesc' as const, color: 'from-rose-500/20 to-rose-600/10 border-rose-500/20', prompt: '帮我深入研究这个技术方案' },
    ];
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 overflow-y-auto">
        <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-3 sm:mb-4 shadow-lg shadow-blue-500/20">
          <Bot size={28} className="text-white sm:hidden" />
          <Bot size={32} className="text-white hidden sm:block" />
        </div>
        <h3 className="text-base sm:text-lg font-semibold text-zinc-200 mb-1">RangerAI</h3>
        <p className="text-xs sm:text-sm text-zinc-500 text-center max-w-md mb-2">
          {t('msg.welcome.subtitle')}
        </p>
        <p className="text-[11px] text-zinc-600 mb-4">{t('msg.welcome.modelRoute')}</p>
        {/* v31.0: Quick-start suggested prompts */}
        <SuggestedPrompts />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 max-w-3xl w-full">
          {capabilities.map((cap) => (
            <div
              key={cap.titleKey}
              onClick={() => sendMessage(cap.prompt)}
              className={`rounded-xl border bg-gradient-to-br ${cap.color} p-3 transition-all duration-200 hover:scale-[1.03] hover:shadow-lg cursor-pointer group active:scale-[0.98]`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-base">{cap.icon}</span>
                <span className="text-xs font-medium text-zinc-200 leading-tight">{t(cap.titleKey)}</span>
              </div>
              <p className="text-[10px] text-zinc-500 leading-relaxed group-hover:text-zinc-400 transition-colors">{t(cap.descKey)}</p>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-zinc-600 mt-4">{t('msg.welcome.describeNeeds')}</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="relative flex-1 overflow-y-auto overscroll-contain px-3 sm:px-4 py-4 sm:py-6">
      <div className="max-w-3xl mx-auto space-y-4 sm:space-y-6">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            role={msg.role}
            content={normalizeContent(msg.content)}
            model={msg.model}
            routingInfo={messageRoutingMap[msg.id]}
            metadata={msg.metadata}
            createdAt={msg.createdAt}
            messageId={msg.id}
            chatId={msg.chatId}
            msgId={msg.msgId}
          />
        ))}

        {/* v3.0: Unified Execution Panel — shown when steps or tools exist */}
        {/* [R67] Show plan progress if available, otherwise fall back to tool steps */}
        {planProgress && planProgress.steps.length > 0 ? (
          <PlanProgressBar progress={planProgress} />
        ) : (executionSteps.length > 0 || activeTools.length > 0) ? (
          <ExecutionTimeline steps={executionSteps} tools={activeTools} />
        ) : null}

        {/* v15.0 Iter-S4: Supervisor Timeline for autonomous tasks */}
        <SupervisorTimeline />

        {/* v25.0: Adaptive Three-Phase Streaming UI */}
        {isStreaming && (
          <div className="space-y-2 sm:space-y-3">
            {currentRoutingInfo && (
              <RoutingBadge info={currentRoutingInfo} isStreaming />
            )}

            {/* v28.0: Task elapsed timer */}
            {streamingStartedAt && <ElapsedTimer startedAt={streamingStartedAt} />}

            {/* R91: Task phase badge — 缩小 Manus 体感差距 */}
            {taskPhase && taskPhase !== 'idle' && taskPhase !== 'completed' && (
              <div className="flex items-center gap-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
                  ${taskPhase === 'planning' ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30' :
                    taskPhase === 'executing' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' :
                    'bg-violet-500/15 text-violet-400 border border-violet-500/30'}`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse
                    ${taskPhase === 'planning' ? 'bg-blue-400' :
                      taskPhase === 'executing' ? 'bg-emerald-400' :
                      'bg-violet-400'}`} />
                  {TASK_PHASE_LABELS[taskPhase]}
                </span>
              </div>
            )}

            {/* Task progress section */}
            {progressContent && (
              <div className="flex gap-2 sm:gap-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-emerald-500/20 flex items-center justify-center mt-1">
                  <Brain size={13} className="text-emerald-400 sm:hidden" />
                  <Brain size={15} className="text-emerald-400 hidden sm:block" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] sm:text-xs font-medium text-emerald-400/80 mb-1">{"任务进度"}</p>
                  <div className="text-xs sm:text-sm text-zinc-300 bg-zinc-800/50 rounded-lg px-2.5 sm:px-3 py-2 border border-emerald-700/30">
                    <pre className="whitespace-pre-wrap font-sans">{progressContent.replace(/\[当前进度\]|\[\/当前进度\]|\[CURRENT_PROGRESS\]|\[\/CURRENT_PROGRESS\]/g, '').trim()}</pre>
                  </div>
                </div>
              </div>
            )}
            {/* Deep thinking section */}
            {thinkingContent && (
              <div className="flex gap-2 sm:gap-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-amber-500/20 flex items-center justify-center mt-1">
                  <Brain size={13} className="text-amber-400 sm:hidden" />
                  <Brain size={15} className="text-amber-400 hidden sm:block" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] sm:text-xs font-medium text-amber-400/80 mb-1">{t('msg.stream.deepThinking')}</p>
                  <div className="text-xs sm:text-sm text-zinc-400 bg-zinc-800/50 rounded-lg px-2.5 sm:px-3 py-2 border border-zinc-700/50 max-h-48 overflow-y-auto">
                    <Streamdown>{thinkingContent}</Streamdown>
                  </div>
                </div>
              </div>
            )}

            {/* Output phase: streaming text content with smooth fade-in */}
            {streamingContent && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                <MessageBubble role="assistant" content={streamingContent} isStreaming />
              </div>
            )}

            {/* v27.0: Planning phase — TaskPlanPanel for structured plans, fallback dots for simple tasks */}
            {!streamingContent && !thinkingContent && !progressContent && activeTools.length === 0 && executionSteps.length === 0 && !planProgress && (
              <div className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                {/* v27.0: Render TaskPlanPanel inline — listens to rangerai:plan CustomEvent */}
                <TaskPlanPanel />
                {/* Fallback: bouncing dots when no plan is available yet */}
                <div className="flex gap-2 sm:gap-3">
                  <div className="shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-blue-500/20 flex items-center justify-center mt-1">
                    <Bot size={13} className="text-blue-400 sm:hidden" />
                    <Bot size={15} className="text-blue-400 hidden sm:block" />
                  </div>
                  <div className="flex items-center gap-2 py-2">
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-xs sm:text-sm text-zinc-500">
                      {t('msg.stream.analyzing')}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* v28.0: Quick action buttons after assistant completes */}
        {!isStreaming && messages.length > 0 && messages[messages.length - 1].role === 'assistant' && (
          <QuickActions chatId={messages[messages.length - 1].chatId} />
        )}

        {error && (
          <div className="flex items-start gap-2 sm:gap-3 bg-red-500/10 rounded-lg px-3 sm:px-4 py-2.5 sm:py-3 border border-red-500/20 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs sm:text-sm text-red-300">{error}</p>
            </div>
            <button
              onClick={() => useMessageStore.getState().setError(null)}
              className="text-red-400/60 hover:text-red-300 transition-colors shrink-0"
              title={t('msg.stream.close')}
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollBtn && (
        <button
          onClick={() => {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
            setShowScrollBtn(false);
          }}
          className="absolute bottom-4 right-4 sm:right-6 z-10 w-9 h-9 rounded-full bg-zinc-700/90 hover:bg-zinc-600 border border-zinc-600/50 shadow-lg flex items-center justify-center transition-all duration-200 hover:scale-110 animate-in fade-in slide-in-from-bottom-2"
          aria-label={t('msg.scrollToBottom')}
          title={t('msg.scrollToBottom')}
        >
          <ArrowDown size={16} className="text-zinc-300" />
        </button>
      )}
    </div>
  );
}

// ─── Routing Badge ──────────────────────────────────────────

function RoutingBadge({ info, isStreaming = false }: { info: RoutingInfo; isStreaming?: boolean }) {
  const { t } = useI18n();
  const taskStyle = TASK_TYPE_STYLE[info.taskType] || TASK_TYPE_STYLE.chat;
  const thinkingKey = THINKING_I18N_KEYS[info.thinking];
  const thinkingLabel = thinkingKey ? t(thinkingKey as any) : info.thinking;
  const modelName = formatModelName(info.model);

  return (
    <div className="flex items-center gap-1.5 sm:gap-2 ml-8 sm:ml-10 flex-wrap">
      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${taskStyle.bg} ${taskStyle.color}`}>
        <Cpu size={9} />
        {t(taskStyle.i18nKey as any)}
      </span>
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-700/50 bg-zinc-800/50 text-zinc-500">
        <Zap size={9} />
        {thinkingLabel}{t('msg.thinkingSuffix')}
      </span>
      {modelName && (
        <span className="text-[10px] text-zinc-600">{modelName}</span>
      )}
      {isStreaming && (
        <span className="inline-block w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
      )}
    </div>
  );
}

// ─── Persisted Tool Metadata ────────────────────────────────

function parseToolMetadata(metadata: string | null | undefined): { toolCalls: ToolCall[]; executionSteps: ExecutionStep[] } | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed) return null;
    const rawTools = parsed.toolCalls || parsed.tools;
    const rawSteps = parsed.executionSteps || parsed.steps;
    if (Array.isArray(rawTools) || Array.isArray(rawSteps)) {
      return {
        toolCalls: (rawTools || []).map((t: Record<string, unknown>, ti: number) => ({
          id: (t.id as string) || `tool-${ti}`,
          tool: (t.tool as string) || 'unknown',
          args: (t.args as string) || '',
          result: t.result as string | undefined,
          status: (t.status as string) || 'completed',
          success: (t.success as boolean) ?? (t.status === 'completed'),
          toolIndex: t.toolIndex as number | undefined,
          screenshot: t.screenshot as string | undefined,
          // v24.1: Restore description and skill fields from persisted metadata
          description: (t.description as string) || undefined,
          skill: (t.skill as string) || undefined,
          skillLabel: (t.skillLabel as string) || undefined,
          skillCategory: (t.skillCategory as string) || undefined,
        })),
        executionSteps: (rawSteps || []).map((s: Record<string, unknown>, si: number) => ({
          id: (s.id as string) || `step-${si}`,
          title: (s.title as string) || '',
          status: (s.status as string) || 'completed',
          detail: (s.detail as string) || '',
          stepIndex: (s.stepIndex as number) || 0,
          startedAt: (s.startedAt as number) || (s.timestamp as number) || 0,
          completedAt: (s.completedAt as number) || (s.timestamp as number),
        })),
      };
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/** Individual tool item in persisted summary — supports expandable exec terminal output */
function PersistedToolItem({
  tool, config, title, toolScreenshot, toolUrl, toolImageUrl, isExecTool, execOutput,
}: {
  tool: ToolCall;
  config: ToolDisplayConfig;
  title: string;
  toolScreenshot?: string;
  toolUrl?: string;
  toolImageUrl?: string;
  isExecTool: boolean;
  execOutput: string;
}) {
  const { t } = useI18n();
  const [showTerminal, setShowTerminal] = useState(false);
  const hasExecOutput = isExecTool && execOutput.length > 0;
  // Show first 3 lines as preview
  const previewLines = execOutput.split('\n').slice(0, 3);
  const hasMoreLines = execOutput.split('\n').length > 3;

  return (
    <div className="relative py-0.5">
      <div className="flex items-center gap-2 text-[11px] sm:text-xs">
        <div className="absolute -left-4 w-[13px] flex justify-center">
          {tool.success !== false ? (
            <CheckCircle2 size={10} className="text-emerald-500/70" />
          ) : (
            <XCircle size={10} className="text-red-400/70" />
          )}
        </div>
        <span className={`shrink-0 ${config.color} opacity-80`}>{config.icon}</span>
        <span className="text-zinc-400 truncate flex-1">{title}</span>
        {/* Expand terminal button for exec tools */}
        {hasExecOutput && (
          <button
            onClick={() => setShowTerminal(!showTerminal)}
            className="shrink-0 text-zinc-600 hover:text-zinc-400 transition-colors"
            title={t('msg.summary.viewTerminal')}
          >
            <Terminal size={11} />
          </button>
        )}
      </div>
      {/* Browser URL */}
      {toolUrl && (
        <div className="ml-5 mt-0.5 flex items-center gap-1 text-[10px] text-zinc-600 truncate">
          <Globe size={8} className="shrink-0" />
          <span className="truncate">{toolUrl}</span>
        </div>
      )}
      {/* Browser screenshot thumbnail in history */}
      {toolScreenshot && (
        <div className="ml-5 mt-1">
          <BrowserScreenshotThumbnail src={toolScreenshot} />
        </div>
      )}
      {/* Image generation result thumbnail in history */}
      {toolImageUrl && (
        <div className="ml-5 mt-1">
          <ImagePreview src={toolImageUrl} alt={t('msg.card.generatedImage')} maxH="max-h-28" />
        </div>
      )}
      {/* Exec terminal output preview (always show first 3 lines) */}
      {hasExecOutput && !showTerminal && (
        <div className="ml-5 mt-1">
          <div className="bg-zinc-950/80 rounded border border-zinc-800/60 px-2 py-1 max-w-full overflow-hidden">
            {previewLines.map((line, i) => (
              <div key={i} className="text-[9px] sm:text-[10px] font-mono text-green-400/60 truncate">{line || ' '}</div>
            ))}
            {hasMoreLines && (
              <button
                onClick={() => setShowTerminal(true)}
                className="text-[9px] text-zinc-500 hover:text-zinc-400 mt-0.5 font-mono"
              >
                {t('msg.summary.expandAll')}
              </button>
            )}
          </div>
        </div>
      )}
      {/* Exec terminal output full (expanded) */}
      {hasExecOutput && showTerminal && (
        <div className="ml-5 mt-1">
          <TerminalResult content={execOutput} />
          <button
            onClick={() => setShowTerminal(false)}
            className="text-[9px] text-zinc-500 hover:text-zinc-400 mt-0.5 font-mono"
          >
            {t('msg.summary.collapse')}
          </button>
        </div>
      )}
    </div>
  );
}

function PersistedToolSummary({ toolCalls, executionSteps }: { toolCalls: ToolCall[]; executionSteps: ExecutionStep[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const failedTools = toolCalls.filter(tc => tc.status === 'error' || tc.success === false);
  const successTools = toolCalls.filter(tc => tc.status === 'completed' && tc.success !== false);

  // Build summary text
  const parts: string[] = [];
  parts.push(`${toolCalls.length}${t('msg.summary.toolCalls')}`);
  if (failedTools.length > 0) parts.push(`${successTools.length} ${t('msg.summary.success')} · ${failedTools.length} ${t('msg.summary.fail')}`);
  else parts.push(t('msg.summary.allSuccess'));
  if (executionSteps.length > 0) parts.push(`${executionSteps.length}${t('msg.summary.stepsCount')}`);

  return (
    <div className="mt-3 border-t border-zinc-600/40 pt-2.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-zinc-300 hover:text-zinc-200 transition-colors w-full text-left group px-2 py-1.5 rounded-lg hover:bg-zinc-700/30"
      >
        <Activity size={13} className="shrink-0 text-emerald-500/70 group-hover:text-emerald-400" />
        <span className="font-medium">{parts.join(' · ')}</span>
        <span className="ml-auto text-zinc-500">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 pl-4 relative space-y-1">
          {/* Vertical line */}
          <div className="absolute left-[6px] top-0 bottom-0 w-px bg-zinc-600/40" />

          {/* Steps — safe render with fallback */}
          {executionSteps.map((step, si) => {
            try {
              const stepTitle = typeof step.title === 'string' ? step.title : String(step.title || '');
              const stepDetail = typeof step.detail === 'string' ? step.detail : (step.detail ? String(step.detail) : '');
              const stepStatus = typeof step.status === 'string' ? step.status : 'completed';
              return (
                <div key={step.id || `step-${si}`} className="relative flex items-center gap-2 py-0.5 text-[11px] sm:text-xs">
                  <div className="absolute -left-4 w-[13px] flex justify-center">
                    {stepStatus === 'completed' ? (
                      <CheckCircle2 size={10} className="text-emerald-500/70" />
                    ) : (
                      <XCircle size={10} className="text-red-400/70" />
                    )}
                  </div>
                  <span className="text-zinc-400">{stepTitle}</span>
                  {stepDetail && <span className="text-zinc-500 truncate max-w-[180px]">{stepDetail}</span>}
                </div>
              );
            } catch {
              return <div key={`step-err-${si}`} className="text-[10px] text-zinc-600 pl-2">⚠ step render error</div>;
            }
          })}

          {/* Tools — safe render with fallback */}
          {toolCalls.map((tool, ti) => {
            try {
              const config = getToolConfigForCall(tool);
              // v24.1: Prioritize backend description > skillLabel > frontend fallback
              const title = tool.description || (tool.skillLabel ? `✨ ${tool.skillLabel}` : getToolDisplayTitle(tool.tool || 'unknown', tool.args || '', t));
              // Extract screenshot from tool result or direct field
              let toolScreenshot = tool.screenshot;
              if (!toolScreenshot && tool.result) {
                try {
                  const r = typeof tool.result === 'string' ? JSON.parse(tool.result) : tool.result;
                  toolScreenshot = r?.screenshot;
                } catch { /* ignore */ }
              }
              const toolUrl = tool.tool === 'browser' ? extractBrowserUrl(tool.args || '') : null;
              // Extract image URL from tool result
              let resultObj: Record<string, unknown> | null = null;
              if (tool.result) {
                try { resultObj = typeof tool.result === 'string' ? JSON.parse(tool.result) : (tool.result as any); } catch { /* keep as string */ }
              }
              const toolImageUrl = extractImageUrl(tool.tool || 'unknown', resultObj, typeof tool.result === 'string' ? tool.result : undefined);
              // Extract exec terminal output for history display
              const isExecTool = tool.tool === 'exec';
              const execOutput = isExecTool ? getResultText(tool.result || '') : '';
              return (
                <PersistedToolItem
                  key={tool.id || `tool-${ti}`}
                  tool={tool}
                  config={config}
                  title={title}
                  toolScreenshot={toolScreenshot || undefined}
                  toolUrl={toolUrl || undefined}
                  toolImageUrl={toolImageUrl || undefined}
                  isExecTool={isExecTool}
                  execOutput={execOutput}
                />
              );
            } catch {
              return <div key={`tool-err-${ti}`} className="text-[10px] text-zinc-600 pl-2">⚠ tool render error</div>;
            }
          })}
        </div>
      )}
    </div>
  );
}
// ─── Quick Action Buttons ──────────────────────────────

function QuickActions({ chatId }: { chatId?: string }) {
  const { t } = useI18n();
  const { sendMessage } = useChatActions();
  const [sending, setSending] = useState(false);

  const handleContinue = useCallback(async () => {
    if (sending || !chatId) return;
    setSending(true);
    try {
      await sendMessage('继续执行');
    } finally {
      setSending(false);
    }
  }, [chatId, sending, sendMessage]);

  if (!chatId) return null;

  return (
    <div className="flex items-center gap-2 ml-9 sm:ml-10 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <button
        onClick={handleContinue}
        disabled={sending}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] sm:text-xs font-medium
          bg-zinc-800 border border-zinc-700 text-zinc-300
          hover:bg-zinc-700 hover:border-zinc-600 hover:text-zinc-100
          active:scale-95 transition-all duration-150
          disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ArrowRight size={11} />
        {sending ? '...' : '继续'}
      </button>
    </div>
  );
}

// ─── Message Actions (Copy / Regenerate) ────────────────────────────

function MessageActions({ content, isUser, messageId, chatId }: { content: string; isUser: boolean; messageId?: number; chatId?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const handleFeedback = useCallback(async (type: 'up' | 'down') => {
    if (!chatId || !messageId) return;
    const next = feedback === type ? null : type;
    setFeedback(next);
    try {
      const { submitMessageFeedback } = await import('../../lib/api');
      await submitMessageFeedback(chatId, messageId, next);
    } catch { /* ignore */ }
  }, [feedback, messageId, chatId]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [content]);

  const handleRegenerate = useCallback(async () => {
    if (!messageId || !chatId || isRegenerating) return;
    setIsRegenerating(true);
    try {
      const result = await import('../../lib/api').then(m => m.regenerateMessage(chatId, messageId));
      if (result.success && result.userMessage) {
        // Parse the user message content (might be JSON with attachments)
        let userContent = result.userMessage.content;
        try {
          const parsed = JSON.parse(userContent);
          if (parsed.text) userContent = parsed.text;
        } catch { /* plain text */ }
        // Reload the chat to reflect deleted messages, then re-send
        const { fetchChatDetail, sendMessage } = await import('../../lib/api');
        const chatDetail = await fetchChatDetail(chatId);
        // Dispatch updated messages via a custom event
        window.dispatchEvent(new CustomEvent('rangerai:regenerate', {
          detail: { chatId, messages: chatDetail.messages, userContent }
        }));
      }
    } catch (err) {
      logger.error('[MessageActions] Regenerate failed:', err);
    } finally {
      setIsRegenerating(false);
    }
  }, [messageId, chatId, isRegenerating]);

  return (
    <div className="flex items-center gap-0.5">
      {!isUser && (
        <>
          <button onClick={() => handleFeedback('up')}
            className={`p-1 rounded transition-colors ${feedback === 'up' ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'}`}
            title="有帮助"><ThumbsUp size={13} /></button>
          <button onClick={() => handleFeedback('down')}
            className={`p-1 rounded transition-colors ${feedback === 'down' ? 'text-red-400' : 'text-zinc-500 hover:text-zinc-300'}`}
            title="没帮助"><ThumbsDown size={13} /></button>
        </>
      )}
      <button
        onClick={handleCopy}
        className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
        aria-label={copied ? t('msg.action.copied') : t('msg.action.copyMsg')}
        title={copied ? t('msg.action.copied') : t('msg.action.copy')}
      >
        {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
      </button>
      {isUser && (
        <button
          onClick={() => {
            useMessageStore.getState().setPendingInput(content);
          }}
          className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
          aria-label="编辑消息"
          title="编辑消息"
        >
          <Pencil size={12} />
        </button>
      )}
      {!isUser && messageId && chatId && (
        <button
          onClick={handleRegenerate}
          disabled={isRegenerating}
          className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={t('msg.action.regenerate')}
          title={t('msg.action.regenerate')}
        >
          <RefreshCw size={12} className={isRegenerating ? 'animate-spin' : ''} />
        </button>
      )}
    </div>
  );
}

// ─── Suggested Prompts (v31.0) ────────────────────────────

function SuggestedPrompts() {
  const { sendMessage } = useChatActions();
  const prompts = [
    { emoji: '💡', text: '帮我分析一下 RangerAI 的架构' },
    { emoji: '🔍', text: '搜索最新的 AI 新闻' },
    { emoji: '📊', text: '生成一份数据分析报告' },
    { emoji: '💻', text: '帮我写一个 React 组件' },
  ];
  return (
    <div className="flex flex-wrap justify-center gap-2 mb-5 max-w-2xl w-full">
      {prompts.map((prompt) => (
        <button
          key={prompt.text}
          onClick={() => sendMessage(prompt.text)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-700/50 bg-zinc-800/60 hover:bg-zinc-700/60 hover:border-zinc-600/50 text-xs text-zinc-300 hover:text-zinc-100 transition-all duration-200 active:scale-95"
        >
          <span className="text-sm">{prompt.emoji}</span>
          <span className="truncate max-w-[180px]">{prompt.text}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Code Block with Copy Button (v31.0) ─────────────────────────────

function CodeBlock({ code, language, ...props }: { code: string; language: string; [key: string]: any }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [code]);

  return (
    <div className="relative group my-2">
      {language && (
        <div className="flex items-center justify-between px-4 py-1.5 bg-zinc-800/80 border border-b-0 border-zinc-700 rounded-t-lg">
          <span className="text-[10px] text-zinc-500 font-mono">{language}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            title={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      )}
      <pre className={`bg-zinc-900 border border-zinc-700 overflow-x-auto p-4 text-[12px] sm:text-[13px] ${language ? 'rounded-b-lg border-t-0' : 'rounded-lg'}`}>
        <code {...props}>{code}</code>
      </pre>
    </div>
  );
}

// ─── Message Bubble (memoized) ───────────────────────────────────────

const MessageBubble = memo(function MessageBubble({role,
  content: rawContent,
  isStreaming = false,
  model,
  routingInfo,
  metadata,
  createdAt,
  messageId,
  chatId,
  msgId,
}: {
  role: string;
  content: string | unknown;
  isStreaming?: boolean;
  model?: string | null;
  routingInfo?: RoutingInfo;
  metadata?: string | null;
  createdAt?: string;
  messageId?: number;
  chatId?: string;
  msgId?: string | null;
}) {
  const rawContentStr = typeof rawContent === 'string' ? rawContent : normalizeContent(rawContent);
  const contentStr = role === 'assistant' ? sanitizeAIContent(rawContentStr) : rawContentStr;
  const isUser = role === 'user';

  // Iter-U: responseMode 差异化样式
  let _responseMode = 'default';
  try { if (metadata) _responseMode = JSON.parse(metadata)?.responseMode || 'default'; } catch { /* ignore */ }
  const responseModeClass = _responseMode === 'notify'
    ? 'border-l-2 border-blue-400/60 pl-1'
    : _responseMode === 'ask'
    ? 'border-l-2 border-amber-400 pl-1'
    : '';

  // Parse user messages that may contain attachments (stored as JSON)
  let displayText = contentStr;
  let userAttachments: Attachment[] = [];
  if (isUser) {
    const parsed = parseMessageContent(contentStr);
    displayText = parsed.text;
    userAttachments = parsed.attachments;
  }

  // Detect downloadable files in AI responses
  const aiFiles = !isUser && !isStreaming ? detectFiles(contentStr) : [];

  return (
    <div className={`flex gap-2 sm:gap-3 ${isUser ? 'flex-row-reverse' : ''} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
      {/* Avatar */}
      <div className={`shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-full flex items-center justify-center mt-1 ${
        isUser ? 'bg-blue-600' : 'bg-zinc-700'
      }`}>
        {isUser ? (
          <>
            <User size={13} className="text-white sm:hidden" />
            <User size={15} className="text-white hidden sm:block" />
          </>
        ) : (
          <>
            <Bot size={13} className="text-zinc-300 sm:hidden" />
            <Bot size={15} className="text-zinc-300 hidden sm:block" />
          </>
        )}
      </div>

      {/* Content */}
      <div className={`min-w-0 ${isUser ? 'text-right max-w-[85%] sm:max-w-[75%]' : 'flex-1'}`}>
        <div
          className={`inline-block text-left text-sm rounded-2xl px-3 sm:px-4 py-2 sm:py-2.5 max-w-full ${
            isUser
              ? 'bg-blue-600 text-white rounded-tr-sm'
              : `bg-zinc-800 text-zinc-200 rounded-tl-sm border border-zinc-700/50 ${responseModeClass}`
          }`}
        >
          {/* User attachments */}
          {isUser && userAttachments.length > 0 && (
            <MessageAttachments attachments={userAttachments} isUser />
          )}

          {isUser ? (
            <div className="whitespace-pre-wrap break-words text-[13px] sm:text-sm">{displayText}</div>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none
                            prose-p:my-1.5 prose-headings:my-2 prose-li:my-0.5
                            prose-h1:text-base prose-h2:text-[15px] prose-h3:text-[14px]
                            prose-h1:font-semibold prose-h2:font-semibold prose-h3:font-medium
                            prose-table:text-xs prose-table:overflow-x-auto
                            prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-700
                            prose-pre:overflow-x-auto prose-pre:max-w-[calc(100vw-6rem)] sm:prose-pre:max-w-none
                            prose-code:text-blue-200 prose-code:bg-zinc-800/80 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:border prose-code:border-zinc-600/50
                            prose-code:text-[12px] sm:prose-code:text-[13px] prose-code:font-medium
                            prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                            prose-img:rounded-lg prose-img:max-h-[300px] prose-img:my-2
                            text-[13px] sm:text-sm">
              <Streamdown components={{
                code: ({ node, className, children, ...props }: any) => {
                  // Check if inline code (single line) vs code block
                  const isInline = node?.position?.start?.line === node?.position?.end?.line;
                  if (isInline) {
                    return (
                      <code
                        style={{
                          color: '#93c5fd',
                          backgroundColor: 'rgba(30, 41, 59, 0.9)',
                          border: '1px solid rgba(100, 116, 139, 0.5)',
                          padding: '0.15em 0.45em',
                          borderRadius: '0.3em',
                          fontWeight: 500,
                          fontSize: '0.88em',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        }}
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  }
                  // v31.0: Code block with copy button
                  const codeText = typeof children === 'string' ? children : String(children ?? '');
                  // Extract language from className (e.g., "language-javascript")
                  const lang = className?.replace('language-', '') || '';
                  return <CodeBlock code={codeText} language={lang} className={className} {...props} />;
                },
              }}>{contentStr}</Streamdown>
              {isStreaming && (
                <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-middle" />
              )}
            </div>
          )}

          {/* AI file output cards */}
          {aiFiles.length > 0 && (
            <AIFileOutput files={aiFiles} />
          )}

          {/* Persisted tool calls from metadata — crash-safe */}
          {(() => {
            try {
              const toolMeta = !isUser && !isStreaming ? parseToolMetadata(metadata) : null;
              if (toolMeta && (toolMeta.toolCalls.length > 0 || toolMeta.executionSteps.length > 0)) {
                return <PersistedToolSummary toolCalls={toolMeta.toolCalls} executionSteps={toolMeta.executionSteps} />;
              }
            } catch (e) {
              logger.warn('[PersistedToolSummary] render error:', e);
              return <div className="text-[10px] text-zinc-600 mt-1">⚠ Tool summary unavailable</div>;
            }
            return null;
          })()}
        </div>

        {/* Message actions + timestamp footer */}
        {!isStreaming && (
          <div className={`flex items-center gap-1.5 sm:gap-2 mt-1 ml-1 flex-wrap ${isUser ? 'justify-end' : ''}`}>
            {createdAt && (
              <span className="text-[10px] text-zinc-600">
                {new Date(createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <MessageActions content={contentStr} isUser={isUser} messageId={messageId} chatId={chatId} />
          </div>
        )}
        {!isUser && !isStreaming && (model || routingInfo) && (
          <div className="flex items-center gap-1.5 sm:gap-2 mt-0.5 ml-1 flex-wrap">
            {routingInfo && (
              <>
                {(() => {
                  const ts = TASK_TYPE_STYLE[routingInfo.taskType] || TASK_TYPE_STYLE.chat;
                  return (
                    <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded-full border ${ts.bg} ${ts.color}`}>
                      <MsgBubbleTaskLabel i18nKey={ts.i18nKey} />
                    </span>
                  );
                })()}
                <span className="text-[10px] text-zinc-600">
                  <MsgBubbleThinkingLabel thinking={routingInfo.thinking} />
                </span>
              </>
            )}
            {model && (
              <span className="text-[10px] text-zinc-600">{formatModelName(model)}</span>
            )}
          </div>
        )}
        {/* RAG Knowledge References — show source citations for AI messages */}
        {!isUser && !isStreaming && msgId && (
          <div className="ml-1">
            <KnowledgeReferences msgId={msgId} />
          </div>
        )}
      </div>
    </div>
  );
});
MessageBubble.displayName = 'MessageBubble';
