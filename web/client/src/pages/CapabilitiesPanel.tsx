import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Cpu, Shield, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, Loader2, Zap, Server, Activity, ChevronDown, ChevronRight
} from 'lucide-react';
import { fetchSkills, fetchCircuitBreakerStatus } from '@/lib/api';
import type { Skill } from '@/lib/api';

interface CircuitBreakerStatus {
  browserBreaker: {
    state: string;
    failureCount: number;
    totalTrips: number;
    halfOpenAttempts: number;
    nextAttemptAt: string | null;
  };
  workerStatus: {
    workerPid: number;
    workerReady: boolean;
    degraded: boolean;
    pendingTasks: number;
    restartCount: number;
    gatewayConnected: boolean;
  };
}

function StateIndicator({ state }: { state: string }) {
  const config: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    CLOSED: { color: 'text-green-400', icon: <CheckCircle2 className="w-4 h-4" />, label: '正常' },
    OPEN: { color: 'text-red-400', icon: <XCircle className="w-4 h-4" />, label: '断开' },
    HALF_OPEN: { color: 'text-amber-400', icon: <AlertTriangle className="w-4 h-4" />, label: '半开' },
  };
  const c = config[state] || config.CLOSED;
  return (
    <span className={`flex items-center gap-1.5 ${c.color}`}>
      {c.icon}
      <span className="text-sm font-medium">{c.label}</span>
    </span>
  );
}

export default function CapabilitiesPanel() {
  const [, setLocation] = useLocation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [cbStatus, setCbStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const isAdmin = (() => {
    try {
      const user = JSON.parse(localStorage.getItem('rangerai_user') || '{}');
      return user.role === 'admin' || user.role === 'manager';
    } catch { return false; }
  })();

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillsData, cbData] = await Promise.allSettled([
        fetchSkills(),
        isAdmin ? fetchCircuitBreakerStatus() : Promise.resolve(null),
      ]);
      if (skillsData.status === 'fulfilled' && skillsData.value) {
        setSkills(skillsData.value || []);
      }
      if (cbData.status === 'fulfilled' && cbData.value) {
        setCbStatus(cbData.value);
      }
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const eligibleSkills = skills.filter(s => s.eligible);
  const unavailableSkills = skills.filter(s => !s.eligible);
  const displaySkills = showAll ? skills : eligibleSkills;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <button onClick={() => setLocation('/')} className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors">
          <ArrowLeft size={18} className="text-zinc-400" />
        </button>
        <Cpu size={18} className="text-violet-400" />
        <h1 className="text-sm font-semibold flex-1">能力面板</h1>
        <button
          onClick={loadData}
          className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-800 transition-colors"
          title="刷新"
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <AlertTriangle size={32} className="mb-3 text-red-400/50" />
            <p className="text-sm mb-3">{error}</p>
            <button onClick={loadData} className="px-4 py-2 text-sm bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors">
              重试
            </button>
          </div>
        ) : (
          <>
            {/* Circuit Breaker Status (Admin only) */}
            {isAdmin && cbStatus && (
              <section>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-300 mb-3">
                  <Shield size={16} className="text-violet-400" />
                  系统状态
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Browser Breaker */}
                  <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-zinc-400 font-medium">浏览器熔断器</span>
                      <StateIndicator state={cbStatus.browserBreaker.state} />
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">失败次数</span>
                        <span className="text-zinc-300">{cbStatus.browserBreaker.failureCount}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">总熔断</span>
                        <span className="text-zinc-300">{cbStatus.browserBreaker.totalTrips}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">半开尝试</span>
                        <span className="text-zinc-300">{cbStatus.browserBreaker.halfOpenAttempts}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">下次重试</span>
                        <span className="text-zinc-300">{cbStatus.browserBreaker.nextAttemptAt || '-'}</span>
                      </div>
                    </div>
                  </div>
                  {/* Worker Status */}
                  <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-zinc-400 font-medium">Worker 状态</span>
                      <span className={`flex items-center gap-1.5 text-sm font-medium ${
                        cbStatus.workerStatus.workerReady ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {cbStatus.workerStatus.workerReady ? (
                          <><CheckCircle2 className="w-4 h-4" /> 就绪</>
                        ) : (
                          <><XCircle className="w-4 h-4" /> 未就绪</>
                        )}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">PID</span>
                        <span className="text-zinc-300 font-mono">{cbStatus.workerStatus.workerPid}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Gateway</span>
                        <span className={cbStatus.workerStatus.gatewayConnected ? 'text-green-400' : 'text-red-400'}>
                          {cbStatus.workerStatus.gatewayConnected ? '已连接' : '断开'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">待处理</span>
                        <span className="text-zinc-300">{cbStatus.workerStatus.pendingTasks}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">重启次数</span>
                        <span className="text-zinc-300">{cbStatus.workerStatus.restartCount}</span>
                      </div>
                    </div>
                    {cbStatus.workerStatus.degraded && (
                      <div className="mt-2 px-2 py-1 bg-amber-500/10 border border-amber-500/20 rounded-md text-[10px] text-amber-400">
                        系统处于降级模式
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* Skills Overview */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
                  <Zap size={16} className="text-cyan-400" />
                  技能列表
                  <span className="text-xs text-zinc-500 font-normal">
                    ({eligibleSkills.length} 可用 / {skills.length} 总计)
                  </span>
                </h2>
                <button
                  onClick={() => setShowAll(!showAll)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                    showAll
                      ? 'bg-violet-500/20 text-violet-400 border-violet-500/30'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                  }`}
                >
                  {showAll ? `全部 (${skills.length})` : `仅可用 (${eligibleSkills.length})`}
                </button>
              </div>

              <div className="space-y-2">
                {displaySkills.map(skill => (
                  <div
                    key={skill.name}
                    className={`bg-zinc-800/40 border rounded-xl transition-all ${
                      skill.eligible ? 'border-zinc-700/50' : 'border-zinc-800 opacity-60'
                    }`}
                  >
                    <div
                      className="flex items-center gap-3 p-3 cursor-pointer hover:bg-zinc-800/60 rounded-xl transition-colors"
                      onClick={() => setExpandedSkill(expandedSkill === skill.name ? null : skill.name)}
                    >
                      <span className="text-lg flex-shrink-0">{skill.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-200 truncate">{skill.displayName}</span>
                          {skill.eligible ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-500 truncate mt-0.5">{skill.description}</p>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] bg-zinc-700/50 text-zinc-400">
                        {skill.source}
                      </span>
                      {expandedSkill === skill.name ? (
                        <ChevronDown size={14} className="text-zinc-500" />
                      ) : (
                        <ChevronRight size={14} className="text-zinc-500" />
                      )}
                    </div>
                    {expandedSkill === skill.name && skill.missing && (
                      <div className="px-4 pb-3 pt-0 border-t border-zinc-800 mt-0">
                        <div className="pt-2 space-y-1.5">
                          <p className="text-[11px] text-zinc-500 font-medium">缺失依赖:</p>
                          {(skill.missing?.bins?.length ?? 0) > 0 && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-zinc-500">命令:</span>
                              <div className="flex gap-1 flex-wrap">
                                {(skill.missing?.bins ?? []).map(b => (
                                  <code key={b} className="px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded text-[10px]">{b}</code>
                                ))}
                              </div>
                            </div>
                          )}
                          {(skill.missing?.env?.length ?? 0) > 0 && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-zinc-500">环境变量:</span>
                              <div className="flex gap-1 flex-wrap">
                                {(skill.missing?.env ?? []).map(e => (
                                  <code key={e} className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded text-[10px]">{e}</code>
                                ))}
                              </div>
                            </div>
                          )}
                          {(skill.missing?.config?.length ?? 0) > 0 && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-zinc-500">配置:</span>
                              <div className="flex gap-1 flex-wrap">
                                {(skill.missing?.config ?? []).map(c => (
                                  <code key={c} className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded text-[10px]">{c}</code>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
