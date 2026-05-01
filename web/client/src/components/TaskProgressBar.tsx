import React, { useEffect, useState } from 'react';

interface TaskProgressBarProps {
  totalElapsed: number;    // 总运行秒数
  toolCount: number;       // 已用工具次数
  currentStep?: string;    // 当前步骤标题（可选）
}

const TaskProgressBar: React.FC<TaskProgressBarProps> = ({ totalElapsed, toolCount, currentStep }) => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // 前30秒：0→15%
    if (totalElapsed <= 30) {
      setProgress(Math.round((totalElapsed / 30) * 15));
    }
    // 30s-180s：15→60%
    else if (totalElapsed <= 180) {
      setProgress(Math.round(15 + ((totalElapsed - 30) / 150) * 45));
    }
    // 180s+：缓慢爬行，上限90%
    else {
      setProgress(Math.min(90, Math.round(60 + ((totalElapsed - 180) / 300) * 30)));
    }
  }, [totalElapsed]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  };

  return (
    <div className="mx-4 mb-2 p-3 bg-muted/50 rounded-lg border border-border/50">
      <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
        <span>{currentStep || '任务仍在执行中...'}</span>
        <span>已用时 {formatTime(totalElapsed)} · {toolCount} 个工具调用</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-1000 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};

export default TaskProgressBar;
