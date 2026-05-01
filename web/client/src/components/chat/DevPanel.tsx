/**
 * DevPanel — Developer panel showing checkpoints, terminal output, and file changes.
 * 
 * Displayed as a tab in the right panel area (alongside FilePanel).
 * Shows real-time development progress during autonomous coding tasks.
 * 
 * v1.0: Initial implementation
 */

import { useState, useEffect, useRef } from 'react';
import { 
  GitBranch, RotateCcw, Terminal, FileCode, 
  ChevronDown, ChevronRight, Clock, CheckCircle2,
  AlertCircle, Plus, Minus, Edit3, Eye
} from 'lucide-react';

interface Checkpoint {
  id: string;
  description: string;
  timestamp: string;
  unixTimestamp: number;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

interface DevPanelProps {
  /** Terminal output lines from tool executions */
  terminalLines?: string[];
  /** File changes detected during session */
  changedFiles?: string[];
  /** Whether the AI is currently executing */
  isActive?: boolean;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'added':
      return <Plus className="w-3 h-3 text-emerald-400" />;
    case 'modified':
      return <Edit3 className="w-3 h-3 text-amber-400" />;
    case 'deleted':
      return <Minus className="w-3 h-3 text-red-400" />;
    default:
      return <FileCode className="w-3 h-3 text-zinc-400" />;
  }
}

function TimeAgo({ timestamp }: { timestamp: number }) {
  const [, setTick] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);
  
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  
  if (mins < 1) return <span className="text-zinc-500 text-[10px]">刚刚</span>;
  if (mins < 60) return <span className="text-zinc-500 text-[10px]">{mins}分钟前</span>;
  if (hours < 24) return <span className="text-zinc-500 text-[10px]">{hours}小时前</span>;
  return <span className="text-zinc-500 text-[10px]">{Math.floor(hours / 24)}天前</span>;
}

export function DevPanel({ terminalLines = [], changedFiles = [], isActive = false }: DevPanelProps) {
  const [activeTab, setActiveTab] = useState<'checkpoints' | 'terminal' | 'files'>('checkpoints');
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Auto-scroll terminal
  useEffect(() => {
    if (activeTab === 'terminal' && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLines, activeTab]);

  const tabs = [
    { id: 'checkpoints' as const, label: '检查点', icon: GitBranch, count: checkpoints.length },
    { id: 'terminal' as const, label: '终端', icon: Terminal, count: terminalLines.length },
    { id: 'files' as const, label: '文件变更', icon: FileCode, count: changedFiles.length },
  ];

  return (
    <div className="h-full flex flex-col bg-zinc-900 text-zinc-300">
      {/* Tab bar */}
      <div className="flex border-b border-zinc-800 shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'text-amber-400 border-amber-400 bg-zinc-800/50'
                : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-zinc-800/30'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
            {tab.count > 0 && (
              <span className={`text-[10px] px-1 rounded-full ${
                activeTab === tab.id ? 'bg-amber-400/20 text-amber-400' : 'bg-zinc-700 text-zinc-400'
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Checkpoints Tab */}
        {activeTab === 'checkpoints' && (
          <div className="p-2 space-y-1">
            {checkpoints.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-zinc-600">
                <GitBranch className="w-8 h-8 mb-2" />
                <p className="text-xs">暂无检查点</p>
                <p className="text-[10px] mt-1">AI 执行开发任务时会自动创建检查点</p>
              </div>
            ) : (
              checkpoints.map((cp, i) => (
                <div
                  key={cp.id}
                  className="flex items-start gap-2 p-2 rounded-md hover:bg-zinc-800/50 transition-colors group"
                >
                  <div className="mt-0.5">
                    {i === 0 ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Clock className="w-4 h-4 text-zinc-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-300 truncate">{cp.description}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <code className="text-[10px] text-zinc-500 font-mono">{cp.id}</code>
                      <TimeAgo timestamp={cp.unixTimestamp} />
                    </div>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-500 hover:text-amber-400 hover:bg-zinc-700 transition-all"
                    title="恢复到此检查点"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Terminal Tab */}
        {activeTab === 'terminal' && (
          <div
            ref={terminalRef}
            className="p-2 font-mono text-[11px] leading-relaxed"
          >
            {terminalLines.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-zinc-600">
                <Terminal className="w-8 h-8 mb-2" />
                <p className="text-xs">暂无终端输出</p>
                <p className="text-[10px] mt-1">AI 执行命令时会在这里显示输出</p>
              </div>
            ) : (
              terminalLines.map((line, i) => (
                <div key={i} className="py-0.5">
                  <span className="text-zinc-600 select-none mr-2">{String(i + 1).padStart(3)}</span>
                  <span className={
                    line.startsWith('$') ? 'text-emerald-400' :
                    line.includes('error') || line.includes('Error') ? 'text-red-400' :
                    line.includes('warning') || line.includes('Warning') ? 'text-amber-400' :
                    line.includes('success') || line.includes('✓') ? 'text-emerald-400' :
                    'text-zinc-400'
                  }>
                    {line}
                  </span>
                </div>
              ))
            )}
            {isActive && (
              <div className="py-0.5 flex items-center gap-1">
                <span className="text-emerald-400">$</span>
                <span className="w-2 h-4 bg-emerald-400 animate-pulse" />
              </div>
            )}
          </div>
        )}

        {/* Files Tab */}
        {activeTab === 'files' && (
          <div className="p-2 space-y-0.5">
            {changedFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-zinc-600">
                <FileCode className="w-8 h-8 mb-2" />
                <p className="text-xs">暂无文件变更</p>
                <p className="text-[10px] mt-1">AI 修改文件时会在这里显示</p>
              </div>
            ) : (
              changedFiles.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-zinc-800/50 transition-colors text-xs group"
                >
                  <StatusIcon status="modified" />
                  <span className="flex-1 truncate font-mono text-[11px] text-zinc-400">
                    {file}
                  </span>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-500 hover:text-amber-400 transition-all"
                    title="查看文件"
                  >
                    <Eye className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="shrink-0 px-3 py-1.5 border-t border-zinc-800 flex items-center gap-2 text-[10px] text-zinc-600">
        {isActive ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>AI 正在执行...</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
            <span>空闲</span>
          </>
        )}
        <span className="ml-auto">{changedFiles.length} 个文件变更</span>
      </div>
    </div>
  );
}
