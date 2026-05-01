// P2+P4 build v2 - run-in-sandbox + CodeMirror
/**
 * CodeExecutor — Interactive Code Execution Panel (P3+P4)
 * 
 * Allows users to write and execute code in an isolated sandbox.
 * Supports Python, Node.js, and Bash.
 * P4: Uses CodeMirror 6 for syntax highlighting and line numbers.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useI18n } from '../../lib/i18n';
import {
  Play, Square, Copy, Check, Terminal, Code,
  Loader2, AlertTriangle, ChevronDown
} from 'lucide-react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { LanguageSupport } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';

interface CodeExecutorProps {
  className?: string;
  onExecute?: (code: string, language: string) => void;
  initialCode?: string;
  initialLanguage?: string;
}

interface ExecutionResult {
  success: boolean;
  output: string;
  language: string;
  executionTime: number;
  error?: string;
}

const LANGUAGES = [
  { id: 'python', name: 'Python', icon: '🐍' },
  { id: 'node', name: 'Node.js', icon: '⬢' },
  { id: 'bash', name: 'Bash', icon: '💻' },
];

function getLanguageExtension(lang: string): LanguageSupport | null {
  switch (lang) {
    case 'python': return python();
    case 'node': return javascript();
    default: return null;
  }
}

export function CodeExecutor({ 
  className = '', 
  onExecute,
  initialCode = '',
  initialLanguage = 'python'
}: CodeExecutorProps) {
  const { t } = useI18n();
  const [code, setCode] = useState(initialCode);
  const [language, setLanguage] = useState(initialLanguage);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const codeRef = useRef(code);
  
  // Keep codeRef in sync
  useEffect(() => { codeRef.current = code; }, [code]);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;
    
    const langExt = getLanguageExtension(language);
    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      oneDark,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newCode = update.state.doc.toString();
          setCode(newCode);
        }
      }),
      EditorView.theme({
        '&': { 
          height: '100%', 
          fontSize: '13px',
          backgroundColor: 'transparent',
        },
        '.cm-content': { 
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          minHeight: '100px',
          padding: '8px 0',
        },
        '.cm-gutters': { 
          backgroundColor: 'rgba(24, 24, 27, 0.5)',
          borderRight: '1px solid rgba(63, 63, 70, 0.5)',
          color: 'rgb(113, 113, 122)',
          fontSize: '11px',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'rgba(52, 211, 153, 0.1)',
        },
        '.cm-activeLine': {
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
        },
        '.cm-cursor': {
          borderLeftColor: 'rgb(52, 211, 153)',
        },
        '.cm-selectionBackground': {
          backgroundColor: 'rgba(52, 211, 153, 0.15) !important',
        },
        '&.cm-focused .cm-selectionBackground': {
          backgroundColor: 'rgba(52, 211, 153, 0.2) !important',
        },
        '.cm-scroller': {
          overflow: 'auto',
          maxHeight: '260px',
        },
      }),
      keymap.of([{
        key: 'Mod-Enter',
        run: () => {
          // Trigger execution via the run button
          const btn = document.querySelector('[data-sandbox-run-btn]') as HTMLButtonElement;
          if (btn && !btn.disabled) btn.click();
          return true;
        }
      }]),
    ];
    if (langExt) extensions.push(langExt);
    
    const state = EditorState.create({
      doc: codeRef.current,
      extensions,
    });
    
    // Destroy previous view if exists
    if (viewRef.current) {
      viewRef.current.destroy();
    }
    
    const view = new EditorView({
      state,
      parent: editorRef.current,
    });
    viewRef.current = view;
    
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language]); // Recreate when language changes

  // P2: Listen for run-in-sandbox events from code blocks
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { code: newCode, language: newLang } = e.detail;
      if (newCode) {
        // Sync codeRef BEFORE setLanguage triggers CodeMirror rebuild
        codeRef.current = newCode;
        setCode(newCode);
        // Update CodeMirror content directly if view exists
        if (viewRef.current) {
          const view = viewRef.current;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: newCode }
          });
        }
      }
      if (newLang) setLanguage(newLang);
      // Auto-execute after a brief delay
      setTimeout(() => {
        const btn = document.querySelector('[data-sandbox-run-btn]') as HTMLButtonElement;
        if (btn) btn.click();
      }, 300);
    };
    window.addEventListener('run-in-sandbox', handler as EventListener);
    return () => window.removeEventListener('run-in-sandbox', handler as EventListener);
  }, []);

  const executeCode = useCallback(async () => {
    if (!code.trim() || isRunning) return;
    
    setIsRunning(true);
    setResult(null);
    
    try {
      const res = await fetch('/api/sandbox/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ language, code, timeout: 30000 })
      });
      const data = await res.json();
      setResult({
        success: data.success !== false && !data.error,
        output: data.output || data.stdout || '',
        language,
        executionTime: data.executionTime || data.duration || 0,
        error: data.error || data.stderr || undefined
      });
      if (onExecute) onExecute(code, language);
    } catch (e: any) {
      setResult({
        success: false,
        output: '',
        language,
        executionTime: 0,
        error: e.message || 'Execution failed'
      });
    } finally {
      setIsRunning(false);
    }
  }, [code, language, isRunning, onExecute]);

  const copyOutput = useCallback(() => {
    if (result?.output) {
      navigator.clipboard.writeText(result.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [result]);

  const selectedLang = LANGUAGES.find(l => l.id === language) || LANGUAGES[0];

  return (
    <div className={`rounded-lg border border-emerald-500/20 bg-zinc-950/80 backdrop-blur-sm overflow-hidden ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/60 border-b border-zinc-800">
        <Terminal size={14} className="text-emerald-400" />
        <span className="text-xs font-medium text-emerald-300">代码沙箱</span>
        
        {/* Language Selector */}
        <div className="relative ml-2">
          <button
            onClick={() => setShowLangMenu(!showLangMenu)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            <span>{selectedLang.icon}</span>
            <span>{selectedLang.name}</span>
            <ChevronDown size={12} />
          </button>
          {showLangMenu && (
            <div className="absolute top-full left-0 mt-1 bg-zinc-800 rounded border border-zinc-700 shadow-lg z-10">
              {LANGUAGES.map(lang => (
                <button
                  key={lang.id}
                  onClick={() => { setLanguage(lang.id); setShowLangMenu(false); }}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs w-full hover:bg-zinc-700 ${lang.id === language ? 'text-emerald-400' : 'text-zinc-300'}`}
                >
                  <span>{lang.icon}</span>
                  <span>{lang.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        
        {/* Run Button */}
        <button
          onClick={executeCode}
          disabled={isRunning || !code.trim()}
          data-sandbox-run-btn
          className="ml-auto flex items-center gap-1 px-2.5 py-0.5 rounded text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isRunning ? (
            <><Loader2 size={12} className="animate-spin" /> 运行中...</>
          ) : (
            <><Play size={12} /> 运行 <span className="text-emerald-200/60 ml-1">⌘↵</span></>
          )}
        </button>
      </div>

      {/* CodeMirror Editor */}
      <div 
        ref={editorRef} 
        className="min-h-[120px] max-h-[300px] overflow-auto"
        style={{ backgroundColor: 'rgb(24, 24, 27)' }}
      />

      {/* Output */}
      {result && (
        <div className={`border-t ${result.success ? 'border-emerald-500/20' : 'border-red-500/20'}`}>
          <div className="flex items-center gap-2 px-3 py-1 bg-zinc-900/40">
            {result.success ? (
              <Code size={12} className="text-emerald-400" />
            ) : (
              <AlertTriangle size={12} className="text-red-400" />
            )}
            <span className={`text-xs ${result.success ? 'text-emerald-400' : 'text-red-400'}`}>
              {result.success ? '输出' : '错误'}
            </span>
            <span className="text-xs text-zinc-500 ml-auto">
              {result.executionTime}ms
            </span>
            <button onClick={copyOutput} className="text-zinc-500 hover:text-zinc-300">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <pre className={`px-3 py-2 text-xs font-mono max-h-[200px] overflow-auto ${result.success ? 'text-zinc-300' : 'text-red-300'}`}>
            {result.output || result.error || '(no output)'}
          </pre>
        </div>
      )}
    </div>
  );
}

export default CodeExecutor;
