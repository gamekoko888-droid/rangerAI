/**
 * TaskPlanPanel — Visual task plan progress panel for RangerAI.
 * 
 * Listens to plan events via two paths:
 *   1. CustomEvent ('rangerai:plan') — from plan_created/plan_phase_update/plan_completed WS events
 *   2. Zustand planProgress store — from plan_progress WS events (backend planner)
 * 
 * v3.0: Unified dual-path plan rendering — reads Zustand planProgress in addition to CustomEvents.
 * When both sources provide plan data, the Zustand store takes priority (more granular step-level data).
 */

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, Circle, Loader2, ChevronDown, ChevronUp, Target, SkipForward, AlertCircle, Search, Image, FileText, ExternalLink } from 'lucide-react';
import { useMessageStore } from '../../stores/useMessageStore';
import { BrowserPreviewPanel } from './BrowserPreviewPanel';

interface StepArtifact { type: 'search' | 'screenshot' | 'file' | 'text'; title: string; summary?: string; url?: string; }

interface TaskPlanPhase {
  id: number;
  title: string;
  status: 'pending' | 'active' | 'completed' | 'skipped' | 'failed';
  artifacts?: StepArtifact[];
}

interface TaskPlan {
  goal: string;
  phases: TaskPlanPhase[];
  currentPhaseId: number;
  totalPhases: number;
  completedPhases: number;
  failedPhases: number;
  status: string;
}


function summarizeArtifactText(value?: string, max = 120): string | undefined {
  if (!value) return undefined;
  const compact = String(value).replace(/\s+/g, ' ').trim();
  return compact ? (compact.length > max ? `${compact.slice(0, max)}…` : compact) : undefined;
}

function getStepArtifacts(index: number): StepArtifact[] {
  const { activeTools, executionSteps } = useMessageStore.getState();
  const step = executionSteps[index];
  const artifacts: StepArtifact[] = [];
  const tool = activeTools[index] || activeTools.find(t => (t.toolIndex ?? -1) === index);
  if (tool) {
    const name = (tool.tool || '').toLowerCase();
    const text = summarizeArtifactText(tool.result || tool.progress || tool.description || tool.args);
    if (name.includes('search')) artifacts.push({ type: 'search', title: tool.title || '搜索摘要', summary: text });
    if (tool.screenshot) artifacts.push({ type: 'screenshot', title: tool.title || '截图预览', url: tool.screenshot, summary: tool.description });
    const fileMatch = (tool.result || tool.args || '').match(/(?:\/opt|\/home|\.)[^\s"']+\.(?:md|txt|json|csv|png|jpg|jpeg|webp|pdf|html|tsx?|mjs)/i);
    if (fileMatch) artifacts.push({ type: 'file', title: '中间文件', url: fileMatch[0], summary: fileMatch[0] });
    if (!artifacts.length && text) artifacts.push({ type: 'text', title: tool.title || tool.tool || '执行产物', summary: text });
  }
  if (step?.detail && artifacts.length < 2) artifacts.push({ type: 'text', title: step.title || '步骤输出', summary: summarizeArtifactText(step.detail) });
  return artifacts.slice(0, 3);
}

function StepArtifacts({ artifacts }: { artifacts?: StepArtifact[] }) {
  if (!artifacts?.length) return null;
  return <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">{artifacts.map((artifact, idx) => (
    <div key={`${artifact.type}-${idx}`} className="rounded-md border border-zinc-700/60 bg-zinc-950/35 p-2 text-[10px] text-zinc-400">
      <div className="mb-1 flex items-center gap-1.5 text-zinc-300">
        {artifact.type === 'search' ? <Search size={11} className="text-purple-400" /> : artifact.type === 'screenshot' ? <Image size={11} className="text-blue-400" /> : <FileText size={11} className="text-cyan-400" />}
        <span className="font-medium">{artifact.title}</span>{artifact.url && artifact.type !== 'screenshot' && <ExternalLink size={10} className="ml-auto text-zinc-500" />}
      </div>
      {artifact.type === 'screenshot' && artifact.url ? <img src={artifact.url} alt="步骤截图" className="max-h-24 w-full rounded border border-zinc-800 object-cover" /> : <p className="line-clamp-3 break-all">{artifact.summary || artifact.url}</p>}
    </div>
  ))}</div>;
}

function PhaseIcon({ status }: { status: TaskPlanPhase['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
    case 'active':
      return <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />;
    case 'failed':
      return <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />;
    case 'skipped':
      return <SkipForward className="w-4 h-4 text-zinc-500 shrink-0" />;
    default:
      return <Circle className="w-4 h-4 text-zinc-600 shrink-0" />;
  }
}

export function TaskPlanPanel() {
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isCompleted, setIsCompleted] = useState(false);

  // v3.0: Subscribe to Zustand planProgress store (backend planner steps)
  const planProgress = useMessageStore(s => s.planProgress);

  // v3.0: Convert Zustand planProgress into TaskPlan format when available
  useEffect(() => {
    if (planProgress && planProgress.steps && planProgress.steps.length > 0) {
      const phases: TaskPlanPhase[] = planProgress.steps.map((s, i) => ({
        id: i + 1,
        title: s.title || `Step ${i + 1}`,
        artifacts: getStepArtifacts(i),
        status: (s.status === 'doing' || s.status === 'active' || s.status === 'retrying')
          ? 'active'
          : (s.status === 'failed' || s.status === 'blocked')
          ? 'failed'
          : (s.status === 'done' || s.status === 'skipped')
          ? (s.status === 'skipped' ? 'skipped' : 'completed')
          : 'pending',
      }));
      const completed = phases.filter(p => p.status === 'completed' || p.status === 'skipped').length;
      const failed = phases.filter(p => p.status === 'failed').length;
      const isDone = planProgress.status === 'completed';
      const isFailed = planProgress.status === 'failed';

      setPlan({
        goal: planProgress.goal || 'Executing task...',
        phases,
        currentPhaseId: planProgress.currentStep || 1,
        totalPhases: planProgress.totalSteps || phases.length,
        completedPhases: completed,
        failedPhases: failed,
        status: planProgress.status || 'in_progress',
      });

      if (isDone) {
        setIsCompleted(true);
        if (!isFailed) {
          const timer = setTimeout(() => setIsExpanded(false), 5000);
          return () => clearTimeout(timer);
        }
      } else {
        setIsCompleted(false);
        if (!isExpanded) setIsExpanded(true);
      }
    }
  }, [planProgress, isExpanded]);

  const handlePlanEvent = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail || !detail.type) return;

    // v3.0: If Zustand planProgress has data, skip CustomEvent — it's the canonical source
    const storePlan = useMessageStore.getState().planProgress;
    if (storePlan && storePlan.steps && storePlan.steps.length > 0) return;

    switch (detail.type) {
      case 'plan_created': {
        const phases: TaskPlanPhase[] = (detail.phases || []).map((p: any) => ({
          id: p.id,
          title: p.title,
          status: p.id === detail.currentPhaseId ? 'active' : 'pending',
          artifacts: getStepArtifacts((p.id || 1) - 1),
        }));
        setPlan({
          goal: detail.goal || 'Executing task...',
          phases,
          currentPhaseId: detail.currentPhaseId || 1,
          totalPhases: phases.length,
          completedPhases: 0,
          failedPhases: 0,
          status: 'in_progress',
        });
        setIsCompleted(false);
        setIsExpanded(true);
        break;
      }
      case 'plan_phase_update': {
        setPlan(prev => {
          if (!prev) return prev;
          const newPhases = prev.phases.map(p => {
            if (p.id < detail.currentPhaseId) return { ...p, status: 'completed' as const, artifacts: p.artifacts?.length ? p.artifacts : getStepArtifacts(p.id - 1) };
            if (p.id === detail.currentPhaseId) return { ...p, status: 'active' as const, artifacts: getStepArtifacts(p.id - 1) };
            return { ...p, status: 'pending' as const };
          });
          const completed = newPhases.filter(p => p.status === 'completed').length;
          return {
            ...prev,
            phases: newPhases,
            currentPhaseId: detail.currentPhaseId,
            completedPhases: completed,
          };
        });
        break;
      }
      case 'plan_completed': {
        setPlan(prev => {
          if (!prev) return prev;
          const newPhases = prev.phases.map(p => ({ ...p, status: 'completed' as const }));
          return {
            ...prev,
            phases: newPhases,
            completedPhases: newPhases.length,
          };
        });
        setIsCompleted(true);
        setTimeout(() => setIsExpanded(false), 5000);
        break;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('rangerai:plan', handlePlanEvent);
    return () => window.removeEventListener('rangerai:plan', handlePlanEvent);
  }, [handlePlanEvent]);

  if (!plan) return null;

  const hasFailed = plan.failedPhases > 0;
  const progress = plan.totalPhases > 0
    ? Math.round(((plan.completedPhases + plan.failedPhases) / plan.totalPhases) * 100)
    : 0;

  const headerBorder = hasFailed
    ? 'border-red-700/50 bg-red-900/20'
    : isCompleted
    ? 'border-emerald-700/50 bg-emerald-900/20'
    : 'border-zinc-700/50 bg-zinc-800/60';

  return (
    <div className={`mx-2 mb-3 rounded-lg border backdrop-blur-sm overflow-hidden transition-colors ${headerBorder}`}>
      {/* Header — always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-700/30 transition-colors"
      >
        <Target className={`w-4 h-4 shrink-0 ${hasFailed ? 'text-red-400' : isCompleted ? 'text-emerald-400' : 'text-amber-400'}`} />
        <span className="text-xs font-medium text-zinc-300 truncate flex-1 text-left">
          {plan.goal}
        </span>
        <span className="text-[10px] text-zinc-500 shrink-0">
          {plan.completedPhases}{hasFailed ? `(+${plan.failedPhases})` : ''}/{plan.totalPhases}
        </span>
        {/* Mini progress bar */}
        <div className="w-12 h-1.5 bg-zinc-700 rounded-full shrink-0 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              hasFailed ? 'bg-red-400' : isCompleted ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        {isExpanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        )}
      </button>

      {/* Phase list — collapsible */}
      {isExpanded && (
        <div className="px-3 pb-2 space-y-1">
          {plan.phases.map((phase) => (
            <div
              key={phase.id}
              className={`py-1 px-2 rounded text-xs transition-colors ${
                phase.status === 'failed'
                  ? 'bg-red-400/10 text-red-300'
                  : phase.status === 'active'
                  ? 'bg-amber-400/10 text-amber-300'
                  : phase.status === 'completed'
                  ? 'text-zinc-400'
                  : 'text-zinc-600'
              }`}
            >
              <div className="flex items-center gap-2">
                <PhaseIcon status={phase.status} />
              <span className={`flex-1 truncate ${
                (phase.status === 'completed' || phase.status === 'skipped') ? 'line-through opacity-60' : ''
              }`}>
                {phase.title}
              </span>
              {phase.status === 'active' && (
                <span className="text-[10px] text-amber-400/70 shrink-0">进行中</span>
              )}
              {phase.status === 'failed' && (
                <span className="text-[10px] text-red-400/70 shrink-0">失败</span>
              )}
              </div>
              <StepArtifacts artifacts={phase.artifacts} />
              {phase.status === 'active' && phase.artifacts?.some(a => a.type === 'screenshot') && (
                <div className="mt-2 max-h-72 overflow-hidden rounded-lg border border-blue-500/20"><BrowserPreviewPanel /></div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
