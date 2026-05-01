/**
 * AgentProgressToast — R57: Lightweight floating progress indicator
 * Listens to 'agent:notify' CustomEvent and displays a non-blocking toast
 * at the bottom of the chat area. Auto-fades after 3s, no stacking.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';

export function AgentProgressToast() {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState('');
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotify = useCallback((msg: string) => {
    // Clear any existing timer
    if (timerRef.current) clearTimeout(timerRef.current);
    setFading(false);
    setText(msg);
    setVisible(true);
    // Start fade after 2.5s, hide after 3s
    timerRef.current = setTimeout(() => {
      setFading(true);
      setTimeout(() => {
        setVisible(false);
        setFading(false);
      }, 500);
    }, 2500);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.content) {
        showNotify(detail.content);
      }
    };
    window.addEventListener('agent:notify', handler);
    return () => {
      window.removeEventListener('agent:notify', handler);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [showNotify]);

  if (!visible) return null;


  return (
    <div
      className={[
        'fixed bottom-20 left-1/2 -translate-x-1/2 z-50',
        'flex items-center gap-2 px-4 py-2 rounded-full',
        'bg-zinc-800/90 border border-zinc-700/50 backdrop-blur-sm',
        'text-sm text-zinc-300 shadow-lg',
        'transition-all duration-500',
        fading ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0',
      ].join(' ')}
    >
      <Loader2 size={14} className="animate-spin text-blue-400" />
      <span>{text}</span>
    </div>
  );
}
