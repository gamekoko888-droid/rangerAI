/**
 * BrowserPreviewPanel v5.0 — "Ranger's Computer" (Manus-level experience)
 *
 * Features:
 * P0: Title "Ranger's Computer", tool status, action description, URL bar, step progress
 * P1: Screenshot timeline with playback controls, maximize/fullscreen, multi-tool tabs
 * P2: Cursor annotation overlay, diff view placeholder
 *
 * Architecture:
 * - AI Mode: CDP screenshots from tool events (low bandwidth)
 * - Takeover Mode: noVNC iframe for full user interaction
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useMessageStore } from '../../stores/useMessageStore';
import { useI18n } from '../../lib/i18n';
import {
  Globe, ZoomIn, ZoomOut, Maximize2, Minimize2,
  ChevronLeft, ChevronRight, Monitor, Loader2, ExternalLink,
  Eye, Terminal, Search, FileText, Pencil, Image, Code, Sparkles,
  Hand, ArrowLeftRight, Shield, Wifi,
  MousePointer2, Keyboard, AlertTriangle, X,
  Play, Pause, SkipBack, SkipForward, Radio,
} from 'lucide-react';
import { logger } from "../../lib/logger";

// ─── Types ───────────────────────────────────────────────────
interface ScreenshotEntry {
  url: string;
  browserUrl?: string;
  toolName?: string;
  actionDesc?: string;
  timestamp: number;
}

interface TakeoverState {
  isTakenOver: boolean;
  takenOverBy: string | null;
  takenOverAt: number | null;
}

interface BrowserStatus {
  browser: { running: boolean; headed: boolean; userAgent?: string };
  vnc: { running: boolean; port?: number };
  takeover: TakeoverState;
}

// ─── Tool → Activity mapping ─────────────────────────────────
interface ActivityInfo {
  icon: React.ReactNode;
  label: string;
  labelEn: string;
  color: string;       // tailwind text color
  bgColor: string;     // tailwind bg color
  borderColor: string;
}

function getActivityInfo(toolName?: string): ActivityInfo {
  if (!toolName) return {
    icon: <Monitor size={14} />, label: '空闲', labelEn: 'Idle',
    color: 'text-zinc-400', bgColor: 'bg-zinc-800/60', borderColor: 'border-zinc-700/50'
  };
  const t = toolName.toLowerCase();
  if (t.includes('browser') || t === 'browser_navigate' || t === 'browser_click' || t === 'browser_input' || t === 'browser_scroll') return {
    icon: <Eye size={14} />, label: '浏览器', labelEn: 'Browser',
    color: 'text-blue-400', bgColor: 'bg-blue-500/10', borderColor: 'border-blue-500/30'
  };
  if (t === 'exec' || t === 'shell') return {
    icon: <Terminal size={14} />, label: '终端', labelEn: 'Terminal',
    color: 'text-emerald-400', bgColor: 'bg-emerald-500/10', borderColor: 'border-emerald-500/30'
  };
  if (t === 'web_search' || t === 'search') return {
    icon: <Search size={14} />, label: '搜索', labelEn: 'Search',
    color: 'text-purple-400', bgColor: 'bg-purple-500/10', borderColor: 'border-purple-500/30'
  };
  if (t === 'read' || t === 'file_read') return {
    icon: <FileText size={14} />, label: '读取文件', labelEn: 'Reading',
    color: 'text-cyan-400', bgColor: 'bg-cyan-500/10', borderColor: 'border-cyan-500/30'
  };
  if (t === 'write' || t === 'edit' || t === 'file_write') return {
    icon: <Pencil size={14} />, label: '编辑文件', labelEn: 'Editing',
    color: 'text-amber-400', bgColor: 'bg-amber-500/10', borderColor: 'border-amber-500/30'
  };
  if (t === 'image' || t === 'canvas' || t === 'generate_image') return {
    icon: <Image size={14} />, label: '生成图片', labelEn: 'Image Gen',
    color: 'text-pink-400', bgColor: 'bg-pink-500/10', borderColor: 'border-pink-500/30'
  };
  if (t === 'code' || t === 'code_interpreter') return {
    icon: <Code size={14} />, label: '代码', labelEn: 'Code',
    color: 'text-orange-400', bgColor: 'bg-orange-500/10', borderColor: 'border-orange-500/30'
  };
  return {
    icon: <Sparkles size={14} />, label: toolName, labelEn: toolName,
    color: 'text-indigo-400', bgColor: 'bg-indigo-500/10', borderColor: 'border-indigo-500/30'
  };
}

// ─── Action description from tool args ───────────────────────
function getActionDescription(toolName?: string, args?: string): string {
  if (!toolName || !args) return '';
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    const t = toolName.toLowerCase();
    if (t.includes('navigate') || (t === 'browser' && parsed?.url)) {
      const url = parsed?.url || parsed?.goto || '';
      if (url) {
        try {
          const u = new URL(url);
          return `Navigating to ${u.hostname}`;
        } catch { return `Navigating to ${url.substring(0, 50)}`; }
      }
    }
    if (t.includes('click') || (t === 'browser' && parsed?.action === 'click')) {
      return parsed?.brief || parsed?.description || 'Clicking element';
    }
    if (t.includes('input') || (t === 'browser' && parsed?.action === 'input')) {
      return parsed?.brief || 'Typing text';
    }
    if (t.includes('scroll') || (t === 'browser' && parsed?.action === 'scroll')) {
      return parsed?.brief || `Scrolling ${parsed?.direction || 'down'}`;
    }
    if (t.includes('search') || t === 'web_search') {
      const q = parsed?.query || parsed?.queries?.[0] || '';
      return q ? `Searching: ${q.substring(0, 40)}` : 'Searching...';
    }
    if (t === 'exec' || t === 'shell') {
      const cmd = parsed?.command || '';
      return cmd ? `$ ${cmd.substring(0, 50)}` : 'Running command';
    }
    if (t === 'read' || t === 'file_read') {
      const path = parsed?.path || parsed?.file || '';
      return path ? `Reading ${path.split('/').pop()}` : 'Reading file';
    }
    if (t === 'write' || t === 'edit' || t === 'file_write') {
      const path = parsed?.path || parsed?.file || '';
      return path ? `Editing ${path.split('/').pop()}` : 'Editing file';
    }
    // Fallback: use brief if available
    if (parsed?.brief) return parsed.brief.substring(0, 60);
  } catch { /* ignore parse errors */ }
  return '';
}

// ─── Extract tool calls from message metadata ────────────────
function extractToolCallsFromMetadata(metadata: string | null | undefined): Array<{
  tool: string; args?: string; result?: string;
  screenshot?: string; startedAt?: number;
}> {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata);
    const rawTools = parsed.toolCalls || parsed.tools;
    if (!Array.isArray(rawTools)) return [];
    return rawTools.map((t: Record<string, unknown>) => ({
      tool: (t.tool || t.name || '') as string,
      args: typeof t.args === 'string' ? t.args : JSON.stringify(t.args || ''),
      result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result || ''),
      screenshot: (t.screenshot || '') as string,
      startedAt: (t.startedAt || 0) as number,
    }));
  } catch { return []; }
}

// ─── API helpers ─────────────────────────────────────────────
async function fetchBrowserStatus(): Promise<BrowserStatus | null> {
  try {
    const res = await fetch('/api/browser/status');
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function requestTakeover(userId: string): Promise<{ ok: boolean; vncUrl?: string; error?: string }> {
  try {
    const res = await fetch('/api/browser/takeover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return await res.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function requestReturn(userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/browser/return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return await res.json();
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ─── Format duration ─────────────────────────────────────────
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════
// ─── Main Component ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
export function BrowserPreviewPanel() {
  const { activeTools, messages, executionSteps } = useMessageStore();
  const { t, locale } = useI18n();
  const isZh = locale.startsWith('zh');

  // UI state
  const [zoom, setZoom] = useState(100);
  const [sliderIndex, setSliderIndex] = useState(-1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isLive = sliderIndex === -1;

  // Takeover state
  const [mode, setMode] = useState<'ai' | 'takeover'>('ai');
  const [takeoverState, setTakeoverState] = useState<TakeoverState>({
    isTakenOver: false, takenOverBy: null, takenOverAt: null,
  });
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus | null>(null);
  const [vncUrl, setVncUrl] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [vncConnected, setVncConnected] = useState(false);
  const [takeoverDuration, setTakeoverDuration] = useState(0);

  // ─── Effects ─────────────────────────────────────────────
  // Poll browser status
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const status = await fetchBrowserStatus();
      if (!cancelled && status) {
        setBrowserStatus(status);
        setTakeoverState(status.takeover);
      }
    };
    poll();
    const interval = setInterval(poll, mode === 'takeover' ? 30000 : 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [mode]);

  // Takeover duration timer
  useEffect(() => {
    if (mode !== 'takeover' || !takeoverState.takenOverAt) return;
    const interval = setInterval(() => {
      setTakeoverDuration(Date.now() - (takeoverState.takenOverAt || Date.now()));
    }, 1000);
    return () => clearInterval(interval);
  }, [mode, takeoverState.takenOverAt]);

  // VNC postMessage events
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'vnc-connected') { setVncConnected(true); setIsConnecting(false); }
      else if (event.data.type === 'vnc-disconnected') { setVncConnected(false); }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // WS takeover events
  useEffect(() => {
    const handleEvent = (event: Event) => {
      try {
        const data = (event as CustomEvent).detail || {};
        if (data.event === 'return') {
          setMode('ai'); setVncUrl(null); setVncConnected(false); setTakeoverDuration(0);
        }
        setTakeoverState({ isTakenOver: data.isTakenOver, takenOverBy: data.takenOverBy, takenOverAt: data.takenOverAt });
      } catch { /* ignore */ }
    };
    window.addEventListener('browser_takeover', handleEvent);
    return () => window.removeEventListener('browser_takeover', handleEvent);
  }, []);

  // ─── Collect screenshots ─────────────────────────────────
  const screenshots = useMemo<ScreenshotEntry[]>(() => {
    const entries: ScreenshotEntry[] = [];
    const recentMsgs = messages.slice(-10);
    for (const msg of recentMsgs) {
      if (msg.role === 'assistant') {
        const toolCalls = extractToolCallsFromMetadata(msg.metadata);
        for (const tc of toolCalls) {
          if (tc.screenshot) {
            let browserUrl: string | undefined;
            let actionDesc: string | undefined;
            try {
              const args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args;
              browserUrl = (args as Record<string, unknown>)?.url as string || (args as Record<string, unknown>)?.goto as string;
              actionDesc = getActionDescription(tc.tool, tc.args);
            } catch { /* ignore */ }
            entries.push({ url: tc.screenshot, browserUrl, toolName: tc.tool, actionDesc, timestamp: tc.startedAt || 0 });
          }
        }
      }
    }
    for (const tool of activeTools) {
      if (tool.screenshot) {
        let browserUrl: string | undefined;
        let actionDesc: string | undefined;
        try {
          const args = typeof tool.args === 'string' ? JSON.parse(tool.args) : tool.args;
          browserUrl = (args as Record<string, unknown>)?.url as string || (args as Record<string, unknown>)?.goto as string;
          actionDesc = getActionDescription(tool.tool, tool.args);
        } catch { /* ignore */ }
        entries.push({ url: tool.screenshot, browserUrl, toolName: tool.tool, actionDesc, timestamp: tool.startedAt || Date.now() });
      }
    }
    const seen = new Set<string>();
    return entries.filter(e => { if (seen.has(e.url)) return false; seen.add(e.url); return true; })
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, activeTools]);

  // Auto-track live
  useEffect(() => {
    if (isLive && screenshots.length > 0) { /* already tracking live */ }
  }, [screenshots.length, isLive]);

  const currentScreenshot = isLive
    ? screenshots[screenshots.length - 1]
    : screenshots[sliderIndex];

  // ─── Active tool info ────────────────────────────────────
  const currentActiveTool = useMemo(() => {
    for (let i = activeTools.length - 1; i >= 0; i--) {
      if (activeTools[i].status === 'running') return activeTools[i];
    }
    return null;
  }, [activeTools]);

  const isBrowserActive = activeTools.some(t => t.tool === 'browser' && t.status === 'running');
  const isAnyToolActive = activeTools.some(t => t.status === 'running');

  const activityInfo = useMemo(() => getActivityInfo(currentActiveTool?.tool), [currentActiveTool]);

  const actionDescription = useMemo(() => {
    if (!currentActiveTool) return '';
    // Use title from backend first (most descriptive)
    if (currentActiveTool.title && currentActiveTool.title !== currentActiveTool.tool) {
      return currentActiveTool.title;
    }
    return getActionDescription(currentActiveTool.tool, currentActiveTool.args);
  }, [currentActiveTool]);

  // Current URL
  const displayUrl = useMemo(() => {
    if (currentScreenshot?.browserUrl) return currentScreenshot.browserUrl;
    for (let i = activeTools.length - 1; i >= 0; i--) {
      const tool = activeTools[i];
      if (tool.tool === 'browser' || tool.tool?.includes('browser')) {
        try {
          const args = typeof tool.args === 'string' ? JSON.parse(tool.args) : tool.args;
          return (args as Record<string, unknown>)?.url as string || (args as Record<string, unknown>)?.goto as string || '';
        } catch { /* ignore */ }
      }
    }
    return '';
  }, [currentScreenshot, activeTools]);

  // Current execution step
  const currentStep = useMemo(() => {
    if (!executionSteps.length) return null;
    const idx = executionSteps.length;
    const step = executionSteps[idx - 1];
    return { index: idx, total: executionSteps.length, title: step?.title || '' };
  }, [executionSteps]);

  // ─── Handlers ────────────────────────────────────────────
  const handleZoomIn = useCallback(() => setZoom(z => Math.min(z + 25, 200)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(z - 25, 50)), []);
  const handleZoomReset = useCallback(() => setZoom(100), []);
  const toggleFullscreen = useCallback(() => setIsFullscreen(f => !f), []);
  const jumpToLive = useCallback(() => { setSliderIndex(-1); setIsPlaying(false); }, []);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (val >= screenshots.length) { setSliderIndex(-1); } else { setSliderIndex(val); }
    setIsPlaying(false);
  }, [screenshots.length]);

  // Playback controls
  const handlePlayPause = useCallback(() => {
    if (screenshots.length <= 1) return;
    if (isPlaying) {
      setIsPlaying(false);
      if (playIntervalRef.current) { clearInterval(playIntervalRef.current); playIntervalRef.current = null; }
    } else {
      setIsPlaying(true);
      if (sliderIndex === -1) setSliderIndex(0);
    }
  }, [isPlaying, screenshots.length, sliderIndex]);

  useEffect(() => {
    if (!isPlaying) { if (playIntervalRef.current) { clearInterval(playIntervalRef.current); playIntervalRef.current = null; } return; }
    playIntervalRef.current = setInterval(() => {
      setSliderIndex(prev => {
        const next = (prev === -1 ? 0 : prev) + 1;
        if (next >= screenshots.length) { setIsPlaying(false); return -1; }
        return next;
      });
    }, 1500);
    return () => { if (playIntervalRef.current) clearInterval(playIntervalRef.current); };
  }, [isPlaying, screenshots.length]);

  const handlePrevScreenshot = useCallback(() => {
    setIsPlaying(false);
    setSliderIndex(prev => {
      if (prev === -1) return Math.max(0, screenshots.length - 2);
      return Math.max(0, prev - 1);
    });
  }, [screenshots.length]);

  const handleNextScreenshot = useCallback(() => {
    setIsPlaying(false);
    setSliderIndex(prev => {
      if (prev === -1) return -1;
      if (prev >= screenshots.length - 1) return -1;
      return prev + 1;
    });
  }, [screenshots.length]);

  // Takeover handlers
  const handleTakeover = useCallback(async () => {
    setIsConnecting(true); setTakeoverError(null);
    try {
      const result = await requestTakeover('user');
      if (result.ok && result.vncUrl) {
        setVncUrl(result.vncUrl); setMode('takeover');
        setTakeoverState({ isTakenOver: true, takenOverBy: 'user', takenOverAt: Date.now() });
      } else { setTakeoverError(result.error || 'Failed to take over browser'); }
    } catch (e) { setTakeoverError(String(e)); }
    finally { setIsConnecting(false); }
  }, []);

  const handleReturn = useCallback(async () => {
    try {
      const result = await requestReturn('user');
      if (result.ok) {
        setMode('ai'); setVncUrl(null); setVncConnected(false); setTakeoverDuration(0);
        setTakeoverState({ isTakenOver: false, takenOverBy: null, takenOverAt: null });
      }
    } catch (e) { logger.error('Failed to return browser control:', e); }
  }, []);

  // VNC iframe connection monitor
  useEffect(() => {
    if (mode !== 'takeover' || !vncUrl) return;
    const timer = setTimeout(() => { if (iframeRef.current) setVncConnected(true); }, 3000);
    return () => clearTimeout(timer);
  }, [mode, vncUrl]);

  const browserAvailable = browserStatus?.browser?.running && browserStatus?.vnc?.running;

  // ═══════════════════════════════════════════════════════════
  // ─── RENDER ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════
  return (
    <div className={`flex flex-col h-full bg-zinc-950 ${isFullscreen ? 'fixed inset-0 z-50' : ''}`}>

      {/* ━━━ Header: "Ranger's Computer" ━━━ */}
      <div className="shrink-0 border-b border-zinc-800">
        {/* Title bar */}
        <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/80">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor size={16} className="text-zinc-400 shrink-0" />
            <span className="text-sm font-medium text-zinc-200 truncate">
              Ranger's Computer
            </span>
            {/* Maximize button */}
            <button
              onClick={toggleFullscreen}
              className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors shrink-0"
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          </div>
          {/* Right: zoom controls (AI mode only) */}
          {mode === 'ai' && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button onClick={handleZoomOut} className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
                <ZoomOut size={13} />
              </button>
              <button onClick={handleZoomReset}
                className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors tabular-nums font-mono">
                {zoom}%
              </button>
              <button onClick={handleZoomIn} className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
                <ZoomIn size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Tool status bar — "Ranger is using Browser" + action description */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/40 border-t border-zinc-800/50">
          {/* Tool badge */}
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 border ${
            mode === 'takeover'
              ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
              : isAnyToolActive
                ? `${activityInfo.bgColor} ${activityInfo.color} ${activityInfo.borderColor}`
                : 'bg-zinc-800/60 text-zinc-500 border-zinc-700/50'
          }`}>
            {mode === 'takeover' ? (
              <>
                <Hand size={12} />
                <span>{isZh ? '你在控制' : 'You'}</span>
              </>
            ) : isAnyToolActive ? (
              <>
                {activityInfo.icon}
                <span>{isZh ? activityInfo.label : activityInfo.labelEn}</span>
              </>
            ) : (
              <>
                <Monitor size={12} />
                <span>{isZh ? '空闲' : 'Idle'}</span>
              </>
            )}
          </div>

          {/* Status text: "Ranger is using Browser" + action */}
          <div className="flex-1 min-w-0">
            {mode === 'takeover' ? (
              <p className="text-xs text-amber-400/80 truncate">
                {isZh ? '你正在控制浏览器' : 'You have control of the browser'}
              </p>
            ) : isAnyToolActive ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`text-xs ${activityInfo.color} shrink-0`}>
                  Ranger is using <span className="font-medium">{isZh ? activityInfo.label : activityInfo.labelEn}</span>
                </span>
                {actionDescription && (
                  <>
                    <span className="text-zinc-600 shrink-0">·</span>
                    <span className="text-xs text-zinc-500 truncate">{actionDescription}</span>
                  </>
                )}
              </div>
            ) : (
              <p className="text-xs text-zinc-600 truncate">
                {isZh ? '等待指令...' : 'Waiting for instructions...'}
              </p>
            )}
          </div>

          {/* Step progress: 2/8 */}
          {currentStep && isAnyToolActive && (
            <div className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/30">
              <span className="text-[10px] text-zinc-400 tabular-nums font-mono">
                {currentStep.index}/{currentStep.total}
              </span>
            </div>
          )}
        </div>

        {/* URL bar */}
        {(mode === 'ai' && (displayUrl || isBrowserActive)) && (
          <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/20 border-t border-zinc-800/30">
            <div className="flex items-center gap-1.5 flex-1 px-2 py-1 rounded-md bg-zinc-800/40 border border-zinc-700/20 min-w-0">
              {isBrowserActive ? (
                <Loader2 size={11} className="text-blue-400 animate-spin shrink-0" />
              ) : (
                <Globe size={11} className="text-zinc-500 shrink-0" />
              )}
              <span className="text-[11px] text-zinc-400 truncate font-mono">
                {displayUrl || 'about:blank'}
              </span>
              {displayUrl && (
                <a href={displayUrl} target="_blank" rel="noopener noreferrer"
                  className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors"
                  onClick={(e) => e.stopPropagation()}>
                  <ExternalLink size={9} />
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ━━━ Main content area ━━━ */}
      <div className="flex-1 min-h-0 relative" ref={containerRef}>
        {mode === 'takeover' && vncUrl ? (
          /* ── VNC iframe ── */
          <iframe
            ref={iframeRef}
            src={vncUrl}
            className="absolute inset-0 w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
            title="Remote Browser"
            style={{ minHeight: '200px' }}
          />
        ) : currentScreenshot ? (
          /* ── Screenshot view ── */
          <div className="w-full h-full overflow-auto flex items-start justify-center p-2 bg-zinc-950">
            <div style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center', transition: 'transform 0.2s ease' }}>
              <img
                ref={imgRef}
                src={currentScreenshot.url}
                alt="Browser screenshot"
                className="max-w-none rounded-sm shadow-2xl shadow-black/50"
                style={{ imageRendering: zoom > 100 ? 'pixelated' : 'auto' }}
                draggable={false}
              />
              {/* Cursor annotation overlay — show tool action position hint */}
              {currentScreenshot.actionDesc && (
                <div className="absolute bottom-3 left-3 right-3 pointer-events-none">
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-black/70 backdrop-blur-sm border border-zinc-700/50">
                    <MousePointer2 size={10} className="text-blue-400" />
                    <span className="text-[10px] text-zinc-300">{currentScreenshot.actionDesc}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── Empty state ── */
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <Monitor size={28} className="text-zinc-600" />
            </div>
            <div className="text-center space-y-1.5">
              <p className="text-sm text-zinc-400">
                {t('browserPreview.noScreenshots')}
              </p>
              <p className="text-xs text-zinc-600 max-w-[240px]">
                {t('browserPreview.hint')}
              </p>
            </div>
            {/* Take Over button in empty state */}
            <button
              onClick={handleTakeover}
              disabled={isConnecting || !browserAvailable}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 mt-2 ${
                browserAvailable
                  ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50 hover:shadow-lg hover:shadow-amber-500/5'
                  : 'bg-zinc-800 border border-zinc-700 text-zinc-600 cursor-not-allowed'
              }`}
            >
              {isConnecting ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
              {isConnecting ? (t('browserPreview.connecting')) : (t('browserPreview.takeOver'))}
            </button>
            {takeoverError && (
              <div className="flex items-center gap-1.5 text-xs text-red-400 mt-1">
                <AlertTriangle size={12} />
                <span>{takeoverError}</span>
                <button onClick={() => setTakeoverError(null)} className="p-0.5 rounded hover:bg-red-500/20"><X size={10} /></button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ━━━ Bottom bar: Controls + Timeline ━━━ */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/80">
        {/* Action bar: Take Over / Return Control */}
        <div className="flex items-center justify-between px-3 py-1.5">
          {/* Left: takeover/return button */}
          <div className="flex items-center gap-2">
            {mode === 'takeover' ? (
              <button
                onClick={handleReturn}
                className="group flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-all duration-200"
              >
                <ArrowLeftRight size={12} className="group-hover:rotate-180 transition-transform duration-300" />
                {t('browserPreview.returnControl')}
              </button>
            ) : (
              <button
                onClick={handleTakeover}
                disabled={isConnecting || !browserAvailable}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
                  browserAvailable
                    ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-600 cursor-not-allowed'
                }`}
              >
                {isConnecting ? <Loader2 size={12} className="animate-spin" /> : <Hand size={12} />}
                {isConnecting ? t('browserPreview.connecting') : t('browserPreview.takeOver')}
              </button>
            )}
            {takeoverError && mode === 'ai' && (
              <div className="flex items-center gap-1 text-[10px] text-red-400">
                <AlertTriangle size={10} />
                <span className="truncate max-w-[100px]">{takeoverError}</span>
                <button onClick={() => setTakeoverError(null)} className="p-0.5 rounded hover:bg-red-500/20"><X size={8} /></button>
              </div>
            )}
          </div>

          {/* Right: connection status */}
          <div className="flex items-center gap-2">
            {mode === 'takeover' && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-amber-400/60 tabular-nums font-mono">
                  {formatDuration(takeoverDuration)}
                </span>
                <div className={`flex items-center gap-1 text-[10px] ${vncConnected ? 'text-emerald-400/70' : 'text-amber-400/70'}`}>
                  {vncConnected ? <Wifi size={10} /> : <Loader2 size={10} className="animate-spin" />}
                  <span>{vncConnected ? 'Connected' : t('browserPreview.connecting')}</span>
                </div>
                <div className="flex items-center gap-1">
                  <MousePointer2 size={9} className="text-amber-400/50" />
                  <Keyboard size={9} className="text-amber-400/50" />
                </div>
              </div>
            )}
            {browserStatus && (
              <div className="flex items-center gap-1" title={browserStatus.browser.running ? 'Browser running' : 'Browser offline'}>
                <div className={`w-1.5 h-1.5 rounded-full ${browserStatus.browser.running ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <span className="text-[10px] text-zinc-600">
                  {browserStatus.browser.running ? 'Browser' : t('browserPreview.browserOffline')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Timeline — Manus-style playback controls */}
        {mode === 'ai' && screenshots.length > 0 && (
          <div className="px-3 pb-2 pt-0.5 border-t border-zinc-800/50">
            <div className="flex items-center gap-2">
              {/* Playback controls */}
              <div className="flex items-center gap-0.5 shrink-0">
                <button onClick={handlePrevScreenshot} disabled={screenshots.length <= 1}
                  className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                  <SkipBack size={12} />
                </button>
                <button onClick={handlePlayPause} disabled={screenshots.length <= 1}
                  className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                  {isPlaying ? <Pause size={12} /> : <Play size={12} />}
                </button>
                <button onClick={handleNextScreenshot} disabled={screenshots.length <= 1}
                  className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                  <SkipForward size={12} />
                </button>
              </div>

              {/* Progress slider */}
              <input
                type="range"
                min={0}
                max={screenshots.length}
                value={isLive ? screenshots.length : sliderIndex}
                onChange={handleSliderChange}
                className="flex-1 h-1 appearance-none bg-zinc-700 rounded-full cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500
                  [&::-webkit-slider-thumb]:hover:bg-blue-400 [&::-webkit-slider-thumb]:transition-colors
                  [&::-webkit-slider-thumb]:shadow-sm"
              />

              {/* Live indicator */}
              {isLive ? (
                <div className="flex items-center gap-1 shrink-0">
                  <Radio size={10} className="text-blue-400 animate-pulse" />
                  <span className="text-[10px] text-blue-400 font-medium">LIVE</span>
                </div>
              ) : (
                <button onClick={jumpToLive}
                  className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:text-blue-400 hover:bg-zinc-800 transition-colors">
                  <Radio size={10} />
                  <span>LIVE</span>
                </button>
              )}

              {/* Counter */}
              <span className="text-[10px] text-zinc-600 tabular-nums shrink-0 font-mono">
                {isLive ? screenshots.length : sliderIndex + 1}/{screenshots.length}
              </span>
            </div>

            {/* Step description under timeline */}
            {currentStep && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-zinc-500 truncate">
                  {isAnyToolActive && <Loader2 size={9} className="inline animate-spin mr-1" />}
                  {currentStep.title}
                </span>
                <span className="text-[10px] text-zinc-600 tabular-nums shrink-0">
                  {currentStep.index}/{currentStep.total}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
