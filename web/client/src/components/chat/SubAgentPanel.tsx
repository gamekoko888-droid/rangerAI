/**
 * SubAgentPanel — Multi-Agent Collaboration Visualization (P2)
 * 
 * Displays active sub-agents, their tasks, and results in real-time.
 * Integrates with the WebSocket event stream for live updates.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useMessageStore } from '../../stores/useMessageStore';
import { useI18n } from '../../lib/i18n';
import {
  Users, Bot, Loader2, CheckCircle, XCircle, Clock,
  ChevronDown, ChevronUp, Sparkles, Brain, Search,
  Code, FileText, Globe
} from 'lucide-react';

interface SubAgent {
  id: string;
  task: string;
  status: 'spawning' | 'running' | 'completed' | 'failed';
  result?: string;
  startedAt: number;
  completedAt?: number;
}

interface SubAgentPanelProps {
  msgId: string;
  className?: string;
}

const AGENT_ICONS: Record<string, React.ReactNode> = {
  search: <Search size={14} />,
  code: <Code size={14} />,
  write: <FileText size={14} />,
  browse: <Globe size={14} />,
  analyze: <Brain size={14} />,
};

function getAgentIcon(task: string): React.ReactNode {
  const t = task.toLowerCase();
  if (t.includes('search') || t.includes('find')) return AGENT_ICONS.search;
  if (t.includes('code') || t.includes('program')) return AGENT_ICONS.code;
  if (t.includes('write') || t.includes('draft')) return AGENT_ICONS.write;
  if (t.includes('browse') || t.includes('visit')) return AGENT_ICONS.browse;
  return AGENT_ICONS.analyze;
}

export function SubAgentPanel({ msgId, className = '' }: SubAgentPanelProps) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const messages = useMessageStore(s => s.messages);

  // Extract subagent events from message store
  useEffect(() => {
    const subEvents = messages.filter(
      m => m.msgId === msgId && (m as any).type === 'subagent_event'
    );
    
    const agentMap = new Map<string, SubAgent>();
    for (const evt of subEvents) {
      const e = evt as any;
      const agentId = e.subagentId || `agent-${agentMap.size + 1}`;
      
      if (e.action === 'spawn' || !agentMap.has(agentId)) {
        agentMap.set(agentId, {
          id: agentId,
          task: e.subagentTask || 'Processing...',
          status: 'running',
          startedAt: e.timestamp || Date.now(),
        });
      }
      
      if (e.subagentStatus === 'completed' || e.action === 'result') {
        const existing = agentMap.get(agentId);
        if (existing) {
          existing.status = 'completed';
          existing.result = e.subagentResult;
          existing.completedAt = e.timestamp || Date.now();
        }
      }
      
      if (e.subagentStatus === 'failed') {
        const existing = agentMap.get(agentId);
        if (existing) {
          existing.status = 'failed';
          existing.result = e.subagentResult;
          existing.completedAt = e.timestamp || Date.now();
        }
      }
    }
    
    setAgents(Array.from(agentMap.values()));
  }, [messages, msgId]);

  if (agents.length === 0) return null;

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runningCount = agents.filter(a => a.status === 'running').length;
  const completedCount = agents.filter(a => a.status === 'completed').length;

  return (
    <div className={`rounded-lg border border-indigo-500/20 bg-indigo-950/30 backdrop-blur-sm ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-indigo-500/10">
        <Users size={16} className="text-indigo-400" />
        <span className="text-sm font-medium text-indigo-300">
          多Agent协作
        </span>
        <span className="ml-auto text-xs text-zinc-500">
          {runningCount > 0 && <span className="text-amber-400">{runningCount} 运行中</span>}
          {completedCount > 0 && <span className="text-emerald-400 ml-2">{completedCount} 已完成</span>}
        </span>
      </div>

      {/* Agent List */}
      <div className="divide-y divide-indigo-500/10">
        {agents.map(agent => (
          <div key={agent.id} className="px-3 py-2">
            <div 
              className="flex items-center gap-2 cursor-pointer"
              onClick={() => toggleExpand(agent.id)}
            >
              {/* Status Icon */}
              {agent.status === 'running' && <Loader2 size={14} className="text-amber-400 animate-spin" />}
              {agent.status === 'completed' && <CheckCircle size={14} className="text-emerald-400" />}
              {agent.status === 'failed' && <XCircle size={14} className="text-red-400" />}
              {agent.status === 'spawning' && <Sparkles size={14} className="text-indigo-400 animate-pulse" />}
              
              {/* Agent Icon */}
              <span className="text-zinc-400">{getAgentIcon(agent.task)}</span>
              
              {/* Task Description */}
              <span className="text-sm text-zinc-300 truncate flex-1">
                {agent.task.substring(0, 80)}
              </span>
              
              {/* Duration */}
              {agent.completedAt && (
                <span className="text-xs text-zinc-500">
                  {Math.round((agent.completedAt - agent.startedAt) / 1000)}s
                </span>
              )}
              
              {/* Expand Toggle */}
              {agent.result && (
                expanded.has(agent.id) 
                  ? <ChevronUp size={14} className="text-zinc-500" />
                  : <ChevronDown size={14} className="text-zinc-500" />
              )}
            </div>
            
            {/* Expanded Result */}
            {expanded.has(agent.id) && agent.result && (
              <div className="mt-2 ml-6 p-2 rounded bg-zinc-900/50 text-xs text-zinc-400 max-h-40 overflow-y-auto whitespace-pre-wrap">
                {agent.result}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default SubAgentPanel;
