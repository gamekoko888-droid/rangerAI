// ─── Tool Description Generator v2 ───
// Generates Chinese descriptions for Manus-style step cards

/**
 * Generate a human-readable Chinese description for a tool call
 * @param {string} toolName - The tool name (e.g., 'browser', 'exec', 'web_search')
 * @param {object|string} rawArgs - The tool arguments (JSON string or object)
 * @returns {string} Chinese description of the tool action
 */
export function generateToolDescription(toolName, rawArgs) {
  try {
    const a = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
    switch (toolName) {
      case 'web_search': return `搜索: ${a.query || ''}`;
      case 'web_fetch': {
        const url = a.url || '';
        const domain = url.match(/https?:\/\/([^/]+)/)?.[1] || '';
        return `访问网页: ${domain || url.substring(0, 60)}`;
      }
      case 'browser': {
        const act = a.action || '';
        if (act === 'navigate') {
          const url = a.url || '';
          const domain = url.match(/https?:\/\/([^/]+)/)?.[1] || '';
          return `浏览器导航: ${domain || url.substring(0, 50)}`;
        }
        if (act === 'click') return `点击页面元素`;
        if (act === 'type' || act === 'input') return `输入文本`;
        if (act === 'screenshot') return `截取页面截图`;
        if (act === 'scroll') return `滚动页面`;
        return `浏览器操作: ${act}`;
      }
      case 'exec': {
        const cmd = a.command || a.cmd || '';
        return classifyExecCommand(cmd);
      }
      case 'generate_image': return `生成图片: ${(a.prompt || '').substring(0, 40)}`;
      case 'transcribe_audio': return `语音转写: ${(a.audio_url || a.audioUrl || '').substring(0, 40)}`;
      case "speak_text": return `语音合成: ${(a.text || "").substring(0, 40)}`;
      case 'read': {
        const filename = (a.path || '').split('/').pop() || '';
        return `读取文件: ${filename}`;
      }
      case 'write': {
        const filename = (a.path || '').split('/').pop() || '';
        return `写入文件: ${filename}`;
      }
      case 'edit': {
        const filename = (a.path || '').split('/').pop() || '';
        return `编辑文件: ${filename}`;
      }
      case 'image': return '生成图片';
      case 'canvas': return '画布操作';
      case 'tts': return '文本转语音';
      case 'memory_search': return `搜索记忆: ${a.query || ''}`;
      case 'memory_get': return '获取记忆';
      case 'code': return '执行代码';
      case 'sessions_spawn': return `启动子任务: ${(a.task || a.message || '').substring(0, 40)}`;
      case 'sessions_send': return `发送跨会话消息`;
      case 'sessions_list': return `查询会话列表`;
      case 'subagents': return `管理子 Agent`;
      case 'cron': return `定时任务管理`;
      case 'message': return `发送消息`;
      default: return toolName;
    }
  } catch {
    return toolName;
  }
}

/**
 * Classify an exec command into a human-readable Chinese description
 * Handles SSH-wrapped commands, piped commands, and local commands
 */
function classifyExecCommand(cmd) {
  if (!cmd) return '执行终端命令';
  
  // Strip leading sleep/wait patterns
  const cleanCmd = cmd.replace(/^(sleep\s+\d+\s*&&\s*)+/, '').trim();
  
  // SSH/SCP wrapped commands — extract the inner command
  if (cleanCmd.match(/^sshpass.*ssh/) || cleanCmd.match(/^ssh\s/)) {
    // Try multiple quote patterns: 'cmd', "cmd", \"cmd\"
    const innerMatch = 
      cleanCmd.match(/ssh\s+\S+\s+'([^']+)'/) ||
      cleanCmd.match(/ssh\s+\S+\s+"([^"]+)"/) ||
      cleanCmd.match(/ssh\s+[^'"]*'([^']+)'/) ||
      cleanCmd.match(/ssh\s+[^'"]*"([^"]+)"/) ||
      // Handle escaped quotes in JSON: \"cmd\"
      cleanCmd.match(/ssh\s+\S+\s+\\"(.+?)\\"/) ||
      // Last resort: everything after the last hostname-like token
      cleanCmd.match(/ssh\s+(?:-\S+\s+)*\S+@\S+\s+['"]?(.+?)['"]?$/);
    if (innerMatch) {
      return classifyRemoteCommand(innerMatch[1].trim());
    }
    return '远程服务器操作';
  }
  if (cleanCmd.match(/^sshpass.*scp/) || cleanCmd.startsWith('scp ')) {
    // Determine direction
    if (cleanCmd.includes(':/') && cleanCmd.match(/\s\/tmp\/|\/home\//)) {
      return '从服务器下载文件';
    }
    return '上传文件到服务器';
  }
  if (cleanCmd.startsWith('ssh ')) {
    return '远程服务器操作';
  }
  
  // Local commands
  return classifyLocalCommand(cleanCmd);
}

/**
 * Classify a remote (SSH) command
 */
function classifyRemoteCommand(cmd) {
  if (!cmd) return '远程服务器操作';
  
  // Multi-command chains — classify by the most significant command
  const commands = cmd.split(/\s*&&\s*|\s*;\s*/).filter(c => c.trim());
  
  // If multiple commands, try to find the most descriptive one
  if (commands.length > 1) {
    // Look for the "main" command (skip echo, cd, sleep)
    const mainCmd = commands.find(c => !c.match(/^(echo|cd|sleep|export|source|set)\s/)) || commands[commands.length - 1];
    return classifyRemoteCommand(mainCmd.trim());
  }
  
  const c = cmd.trim();
  
  // Service management
  if (c.includes('systemctl restart')) {
    const svc = c.match(/systemctl restart\s+(\S+)/)?.[1] || '';
    return `重启服务: ${svc}`;
  }
  if (c.includes('systemctl stop')) return '停止服务';
  if (c.includes('systemctl start')) return '启动服务';
  if (c.includes('systemctl status') || c.includes('systemctl is-active')) return '检查服务状态';
  if (c.includes('systemctl')) return '管理系统服务';
  
  // Process management
  if (c.includes('pm2 restart') || c.includes('pm2 reload')) return '重启 PM2 进程';
  if (c.includes('pm2 list') || c.includes('pm2 status')) return '查看 PM2 进程状态';
  if (c.includes('pm2')) return 'PM2 进程管理';
  
  // Health checks
  if (c.includes('curl') && (c.includes('health') || c.includes('status'))) return '健康检查';
  if (c.includes('curl')) return '发送 HTTP 请求';
  
  // Log analysis
  if (c.match(/tail\s.*log/) || c.match(/tail\s.*\.log/)) return '查看最新日志';
  if (c.match(/grep.*log/) || c.match(/grep.*\.log/)) return '搜索日志';
  if (c.includes('journalctl')) return '查看系统日志';
  
  // File search and analysis
  if (c.startsWith('grep ') || c.includes('| grep')) {
    const pattern = c.match(/grep\s+(?:-[a-zA-Z]+\s+)*['"]?([^'"|\s]+)/)?.[1] || '';
    if (pattern) return `搜索: ${pattern.substring(0, 30)}`;
    return '搜索文件内容';
  }
  if (c.startsWith('find ')) return '搜索文件';
  if (c.startsWith('wc ')) return '统计文件信息';
  
  // File reading
  if (c.startsWith('cat ') || c.startsWith('head ') || c.startsWith('tail ')) {
    const file = c.match(/(?:cat|head|tail)\s+(?:-\S+\s+)*(\S+)/)?.[1] || '';
    const filename = file.split('/').pop() || '';
    return `读取文件: ${filename || ''}`.trim();
  }
  if (c.startsWith('sed ') && c.includes('-n')) {
    const file = c.match(/(\S+)$/)?.[1] || '';
    const filename = file.split('/').pop() || '';
    return `读取文件片段: ${filename}`;
  }
  if (c.startsWith('sed ')) return '编辑文件内容';
  
  // File operations
  if (c.startsWith('mkdir ')) return '创建目录';
  if (c.startsWith('cp ')) return '复制文件';
  if (c.startsWith('mv ')) return '移动文件';
  if (c.startsWith('rm ')) return '删除文件';
  if (c.startsWith('chmod ')) return '修改文件权限';
  if (c.startsWith('chown ')) return '修改文件所有者';
  
  // Package management
  if (c.includes('npm install') || c.includes('pnpm install') || c.includes('pnpm add')) return '安装依赖包';
  if (c.includes('npm run build') || c.includes('pnpm build')) return '构建项目';
  if (c.includes('npm test') || c.includes('pnpm test')) return '运行测试';
  if (c.includes('apt-get install') || c.includes('apt install')) return '安装系统包';
  
  // Docker
  if (c.includes('docker build')) return '构建 Docker 镜像';
  if (c.includes('docker-compose up') || c.includes('docker compose up')) return '启动 Docker 容器';
  if (c.includes('docker ps')) return '查看 Docker 容器';
  if (c.includes('docker')) return 'Docker 操作';
  
  // Git
  if (c.includes('git pull')) return '拉取代码更新';
  if (c.includes('git push')) return '推送代码';
  if (c.includes('git commit')) return '提交代码';
  if (c.includes('git status')) return '查看 Git 状态';
  if (c.includes('git log')) return '查看 Git 日志';
  if (c.includes('git')) return 'Git 操作';
  
  // Database
  if (c.includes('mysql') || c.includes('sqlite3') || c.includes('psql')) return '数据库操作';
  
  // Network
  if (c.includes('netstat') || c.includes('ss -')) return '检查网络端口';
  if (c.includes('ping ')) return '网络连通性测试';
  if (c.includes('wget ')) return '下载文件';
  
  // System info
  if (c.includes('df ') || c.includes('du ')) return '检查磁盘空间';
  if (c.includes('free ') || c.includes('top ') || c.includes('htop')) return '检查系统资源';
  if (c.includes('uptime')) return '检查系统运行时间';
  if (c.includes('ps aux') || c.includes('ps -')) return '查看进程列表';
  
  // Node.js
  if (c.includes('node --check') || c.includes('node -c')) return '语法检查';
  if (c.startsWith('node ')) return '执行 Node.js 脚本';
  
  // Python
  if (c.startsWith('python')) return '执行 Python 脚本';
  
  // ls / directory listing
  if (c.startsWith('ls ')) return '查看目录内容';
  
  return '远程服务器操作';
}

/**
 * Classify a local command
 */
function classifyLocalCommand(cmd) {
  if (!cmd) return '执行终端命令';
  const c = cmd.trim();
  
  if (c.includes('npm') || c.includes('pnpm') || c.includes('yarn')) return '执行包管理命令';
  if (c.includes('git')) return 'Git 操作';
  if (c.includes('curl') || c.includes('wget')) return '发送网络请求';
  if (c.includes('docker')) return 'Docker 操作';
  if (c.includes('systemctl')) return '管理系统服务';
  if (c.startsWith('grep ') || c.includes('| grep')) return '搜索文件内容';
  if (c.startsWith('find ')) return '搜索文件';
  if (c.startsWith('cat ') || c.startsWith('head ') || c.startsWith('tail ')) return '读取文件内容';
  if (c.startsWith('mkdir ') || c.startsWith('cp ') || c.startsWith('mv ')) return '文件系统操作';
  if (c.startsWith('python')) return '执行 Python 脚本';
  if (c.includes('node --check') || c.includes('node -c')) return '语法检查';
  if (c.startsWith('node ')) return '执行 Node.js 脚本';
  if (c.startsWith('ls ')) return '查看目录内容';
  if (c.startsWith('wc ')) return '统计文件信息';
  if (c.startsWith('echo ')) return '输出信息';
  if (c.startsWith('sed ')) return '编辑文件内容';
  if (c.startsWith('awk ')) return '处理文本数据';
  if (c.includes('tsc') || c.includes('npx tsc')) return 'TypeScript 类型检查';
  
  return '执行终端命令';
}
