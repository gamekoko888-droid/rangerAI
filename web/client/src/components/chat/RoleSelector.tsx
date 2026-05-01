import { useState, useRef, useEffect } from 'react';
import { useMessageStore } from '../../stores/useMessageStore';

interface RoleSelectorProps {
  selectedRole?: string | null;
  onSelectRole?: (roleId: string | null) => void;
}

interface SkillItem {
  icon: string;
  label: string;
  prompt: string;
}

const SKILLS: SkillItem[] = [
  { icon: '📊', label: '审阅日报', prompt: '审阅今日日报' },
  { icon: '🔍', label: '竞品分析', prompt: '帮我分析最新竞品价格动态' },
  { icon: '🤝', label: 'KOL拓展', prompt: '帮我分析KOL拓展机会' },
  { icon: '📝', label: '周报摘要', prompt: '帮我生成本周周报摘要' },
  { icon: '📁', label: '数据摄食', prompt: '我要上传数据文件' },
  { icon: '🌐', label: '市场情报', prompt: '搜索最新游戏充值市场动态' },
];

export function RoleSelector({ selectedRole, onSelectRole }: RoleSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  function handleSkillClick(prompt: string) {
    useMessageStore.getState().setPendingInput(prompt);
    setOpen(false);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 10px',
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.15)',
          background: open ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: '13px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          transition: 'background 0.15s',
        }}
        title="常用Skills快捷启动器"
      >
        ⚡ Skills
        <span style={{ fontSize: '10px', opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            minWidth: '180px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'var(--bg-secondary, #1e1e2e)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {SKILLS.map((skill) => (
            <button
              key={skill.label}
              onClick={() => handleSkillClick(skill.prompt)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '9px 14px',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '13px',
                textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              <span style={{ fontSize: '16px' }}>{skill.icon}</span>
              <span>{skill.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
