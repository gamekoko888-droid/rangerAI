import { encode } from "gpt-tokenizer";
import { FRONTEND_EVENT_TYPES, WS_SERVER_TYPES } from '#shared/message-types';
// ─── Format & Display Utilities (extracted from agent-worker.mjs) ───
// Pure functions for text processing, tool display, and skill detection.
// No external dependencies — safe to test in isolation.

// ─── Text helpers ────────────────────────────────────────────
export function sanitizeForFrontend(text) {
  if (!text || typeof text !== "string") return text;

  // ── Iter-S8: Strip all internal tags that should never reach the frontend ──
  // Block tags with opening and closing markers
  text = text.replace(/\[PLAN\][\s\S]*?\[\/PLAN\]/g, "");
  text = text.replace(/\[KNOWLEDGE_CONTEXT\][\s\S]*?\[\/KNOWLEDGE_CONTEXT\]/g, "");
  text = text.replace(/\[RESEARCH_CONTEXT\][\s\S]*?\[\/RESEARCH_CONTEXT\]/g, "");
  text = text.replace(/\[TOOL_MASK\][\s\S]*?\[\/TOOL_MASK\]/g, "");
  text = text.replace(/\[INSTRUCTION\][\s\S]*?\[\/INSTRUCTION\]/g, "");
  text = text.replace(/\[DOCUMENTS\][\s\S]*?\[\/DOCUMENTS\]/g, "");
  text = text.replace(/\[SYSTEM\][\s\S]*?\[\/SYSTEM\]/g, "");
  // Prefix markers (no closing tag — strip to next double newline or end)
  text = text.replace(/\[INTERNAL_KNOWLEDGE_CONTEXT_DO_NOT_REVEAL\][\s\S]*?(?:\n\n|$)/g, "");
  text = text.replace(/INTERNAL_CONTEXT_DO_NOT_REPLY[\s\S]*?(?:\n\n|$)/g, "");
  // Reference block markers
  text = text.replace(/--- 参考资料开始 ---[\s\S]*?--- 参考资料结束 ---/g, "");
  // Unclosed tags (safety net — if LLM outputs opening tag without closing)
  text = text.replace(/\[(?:PLAN|KNOWLEDGE_CONTEXT|RESEARCH_CONTEXT|TOOL_MASK|INSTRUCTION|DOCUMENTS|SYSTEM|NOTIFY|ASK|通知|询问)\][^\[]{0,500}/g, "");

  // ── Brand name replacement ──
  // Keep technical identifiers and paths intact (e.g. openclaw-handler.mjs,
  // openclaw-gateway) while still rewriting standalone product references.
  text = text.replace(/(?<![\p{L}\p{N}_./-])OpenClaw(?![\p{L}\p{N}_./-])/giu, "RangerAI");
  text = text.replace(/(?<![\p{L}\p{N}_./-])Gateway\s+WebSocket(?![\p{L}\p{N}_./-])/giu, "AI 引擎");
  text = text.replace(/(?<![\p{L}\p{N}_./-])Gateway(?![\p{L}\p{N}_./-])/giu, "AI 引擎");

  // Clean up excessive blank lines left by tag removal
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function estimateTokens(text) {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch (e) {
    // Fallback to heuristic if tokenizer fails
    const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4);
  }
}

export function rewriteWorkspacePaths(text) {
  if (!text || typeof text !== "string") return text;
  text = text.replace(/!\[([^\]]*)\]\(\/home\/admin\/.openclaw\/workspace\/([^)]+)\)/gi,
    (_, alt, path) => `![${alt}](https://ranger.voyage/workspace/${path})`);
  text = text.replace(/\[([^\]]*)\]\(\/home\/admin\/.openclaw\/workspace\/([^)]+)\)/gi,
    (_, label, path) => `[${label}](https://ranger.voyage/workspace/${path})`);
  text = text.replace(/`?\/home\/admin\/.openclaw\/workspace\/([^\s`]+\.(?:png|jpg|jpeg|gif|webp|svg))`?/gi,
    (match, path) => ` ![file](https://ranger.voyage/workspace/${path})`);
  return text;
}

// ─── Skill Detection ────────────────────────────────────────
export const SKILL_PATTERNS = [
  { pattern: /skills\/auto-maintenance/i, skill: 'auto-maintenance', label: '系统自动维护', category: '运维' },
  { pattern: /skills\/health-dashboard/i, skill: 'health-dashboard', label: '健康仪表盘', category: '运维' },
  { pattern: /skills\/system-health-monitor/i, skill: 'system-health-monitor', label: '系统健康监控', category: '运维' },
  { pattern: /skills\/process-monitor/i, skill: 'process-monitor', label: '进程监控', category: '运维' },
  { pattern: /skills\/service-restart/i, skill: 'service-restart', label: '服务重启', category: '运维' },
  { pattern: /skills\/security-scan/i, skill: 'security-scan', label: '安全扫描', category: '安全' },
  { pattern: /skills\/firewall-check/i, skill: 'firewall-check', label: '防火墙检查', category: '安全' },
  { pattern: /skills\/ssl-checker/i, skill: 'ssl-checker', label: 'SSL 证书检查', category: '安全' },
  { pattern: /skills\/port-scanner/i, skill: 'port-scanner', label: '端口扫描', category: '安全' },
  { pattern: /skills\/network-test/i, skill: 'network-test', label: '网络测试', category: '网络' },
  { pattern: /skills\/bandwidth-test/i, skill: 'bandwidth-test', label: '带宽测试', category: '网络' },
  { pattern: /skills\/dns-lookup/i, skill: 'dns-lookup', label: 'DNS 查询', category: '网络' },
  { pattern: /skills\/cpu-info/i, skill: 'cpu-info', label: 'CPU 信息', category: '监控' },
  { pattern: /skills\/memory-stats/i, skill: 'memory-stats', label: '内存状态', category: '监控' },
  { pattern: /skills\/disk-report/i, skill: 'disk-report', label: '磁盘报告', category: '监控' },
  { pattern: /skills\/load-average/i, skill: 'load-average', label: '负载分析', category: '监控' },
  { pattern: /skills\/uptime-monitor/i, skill: 'uptime-monitor', label: '运行时间监控', category: '监控' },
  { pattern: /skills\/rangerai-deploy/i, skill: 'rangerai-deploy', label: '应用部署', category: '部署' },
  { pattern: /skills\/git-snapshot/i, skill: 'git-snapshot', label: 'Git 快照', category: '部署' },
  { pattern: /skills\/nginx-check/i, skill: 'nginx-check', label: 'Nginx 检查', category: '部署' },
  { pattern: /skills\/daily-backup/i, skill: 'daily-backup', label: '数据备份', category: '备份' },
  { pattern: /skills\/backup-verify/i, skill: 'backup-verify', label: '备份验证', category: '备份' },
  { pattern: /skills\/log-rotation/i, skill: 'log-rotation', label: '日志轮转', category: '日志' },
  { pattern: /skills\/error-analyzer/i, skill: 'error-analyzer', label: '错误分析', category: '日志' },
  { pattern: /skills\/cost-tracker/i, skill: 'cost-tracker', label: '成本追踪', category: '成本' },
  { pattern: /skills\/smart-router/i, skill: 'smart-router', label: '智能路由', category: '成本' },
  { pattern: /skills\/env-checker/i, skill: 'env-checker', label: '环境检查', category: '环境' },
  { pattern: /skills\/package-checker/i, skill: 'package-checker', label: '依赖检查', category: '环境' },
  { pattern: /skills\/docker-status/i, skill: 'docker-status', label: 'Docker 状态', category: '环境' },
  { pattern: /skills\/swap-manager/i, skill: 'swap-manager', label: '交换空间管理', category: '环境' },
  { pattern: /skills\/crontab-manager/i, skill: 'crontab-manager', label: '定时任务管理', category: '定时' },
  { pattern: /skills\/session-cleanup/i, skill: 'session-cleanup', label: '会话清理', category: '定时' },
  { pattern: /skills\/cache-cleaner/i, skill: 'cache-cleaner', label: '缓存清理', category: '定时' },
  { pattern: /skills\/memory-consolidator/i, skill: 'memory-consolidator', label: '知识整理', category: '进化' },
  { pattern: /skills\/skill-audit/i, skill: 'skill-audit', label: '技能审计', category: '进化' },
  { pattern: /skills\/nano-banana-pro/i, skill: 'nano-banana-pro', label: 'AI 图片生成', category: '创作' },
  { pattern: /skills\/weather/i, skill: 'weather', label: '天气查询', category: '查询' },
  { pattern: /skills\/coding-agent/i, skill: 'coding-agent', label: '代码协作智能体', category: '开发' },
  { pattern: /skills\/github/i, skill: 'github', label: 'GitHub 操作', category: '开发' },
  { pattern: /skills\/visual-feedback/i, skill: 'visual-feedback', label: '视觉反馈', category: '运维' },
  { pattern: /skills\/user-manager/i, skill: 'user-manager', label: '用户管理', category: '管理' },
  { pattern: /skills\/system-summary/i, skill: 'system-summary', label: '系统概览', category: '运维' },
];

export function detectSkillFromExec(command) {
  if (!command) return null;
  for (const sp of SKILL_PATTERNS) {
    if (sp.pattern.test(command)) {
      return { skill: sp.skill, label: sp.label, category: sp.category };
    }
  }
  return null;
}

// ─── Tool display helpers ────────────────────────────────────

/** Generate human-readable Chinese description for shell commands */
function getExecDescription(command) {
  if (!command) return "执行命令";
  const cmd = command.trim();
  // Common command patterns → Chinese descriptions
  const patterns = [
    [/^grep/i, "搜索文件内容"],
    [/^find/i, "查找文件"],
    [/^cat/i, "查看文件内容"],
    [/^ls/i, "列出目录文件"],
    [/^cd/i, "切换目录"],
    [/^mkdir/i, "创建目录"],
    [/^rm/i, "删除文件"],
    [/^cp/i, "复制文件"],
    [/^mv/i, "移动文件"],
    [/^sed/i, "编辑文件内容"],
    [/^awk/i, "处理文本数据"],
    [/^curl/i, "发送网络请求"],
    [/^wget/i, "下载文件"],
    [/^pip|^pip3/i, "安装Python依赖"],
    [/^npm|^pnpm|^yarn/i, "安装Node依赖"],
    [/^python|^python3/i, "运行Python脚本"],
    [/^node/i, "运行Node脚本"],
    [/^git/i, "Git操作"],
    [/^docker/i, "Docker操作"],
    [/^systemctl|^service/i, "管理系统服务"],
    [/^chmod|^chown/i, "修改文件权限"],
    [/^tar|^zip|^unzip|^gzip/i, "压缩/解压文件"],
    [/^echo/i, "输出信息"],
    [/^tail|^head/i, "查看文件片段"],
    [/^wc/i, "统计文件信息"],
    [/^sort/i, "排序数据"],
    [/^diff/i, "对比文件差异"],
    [/^ssh|^scp/i, "远程操作"],
    [/^mysql|^psql|^sqlite3/i, "数据库操作"],
    [/^test|^\[/i, "条件检查"],
    [/^export/i, "设置环境变量"],
    [/^source|^\./i, "加载配置"],
    [/^kill|^pkill/i, "终止进程"],
    [/^ps|^top|^htop/i, "查看进程状态"],
    [/^df|^du/i, "查看磁盘空间"],
    [/^free/i, "查看内存使用"],
    [/^ping|^traceroute/i, "网络诊断"],
    [/^apt|^yum|^dnf/i, "安装系统软件"],
    [/^crontab/i, "管理定时任务"],
    [/^touch/i, "创建空文件"],
    [/^ln/i, "创建链接"],
    [/^xargs/i, "批量处理"],
    [/^tee/i, "写入文件"],
  ];
  for (const [pattern, desc] of patterns) {
    if (pattern.test(cmd)) return desc;
  }
  // If command starts with a known binary path
  if (cmd.startsWith("/")) {
    const binary = cmd.split("/").pop()?.split(" ")[0] || "";
    for (const [pattern, desc] of patterns) {
      if (pattern.test(binary)) return desc;
    }
  }
  // Pipe chains: describe as "多步处理"
  if (cmd.includes("|")) return "多步数据处理";
  // && chains: describe as "批量操作"
  if (cmd.includes("&&")) return "批量操作";
  return "执行命令";
}

export function getToolTitle(toolName, args) {
  // Smart Chinese description based on tool type and args
  if (toolName === "exec") {
    return getSmartExecDescription(args);
  }
  if (toolName === "read") {
    const path = typeof args === "string" ? args : (args?.path || args?.file || "");
    const fname = path.split("/").pop() || path;
    return fname ? `读取文件 ${fname}` : "读取文件";
  }
  if (toolName === "write") {
    const path = typeof args === "string" ? args : (args?.path || args?.file || "");
    const fname = path.split("/").pop() || path;
    return fname ? `写入文件 ${fname}` : "写入文件";
  }
  if (toolName === "edit" || toolName === "apply_patch") {
    const path = typeof args === "string" ? args : (args?.path || args?.file || "");
    const fname = path.split("/").pop() || path;
    return fname ? `编辑文件 ${fname}` : "编辑文件";
  }
  if (toolName === "browser" || toolName === "navigate") {
    const a = typeof args === "object" ? args : {};
    const action = a?.action || "";
    const url = typeof args === "string" ? args : (a?.url || a?.targetUrl || "");
    const urlHost = url ? (() => { try { return new URL(url).hostname; } catch { return url.substring(0, 40); } })() : "";
    switch (action) {
      case "navigate": case "open": return urlHost ? `打开网页 ${urlHost}` : "打开网页";
      case "snapshot": return "读取页面内容";
      case "screenshot": return "截取网页截图";
      case "act": case "click": return "页面交互";
      case "type": case "input": return "输入文本";
      case "scroll": return "滚动页面";
      case "close": return "关闭页面";
      case "wait": return "等待页面加载";
      case "select": return "选择元素";
      default:
        if (urlHost) return `浏览 ${urlHost}`;
        return action ? `浏览器操作` : "浏览网页";
    }
  }
  if (toolName === "search" || toolName === "web_search") return "搜索信息";
  if (toolName === "web_fetch") return "获取网页内容";
  if (toolName === "process") return "管理进程";
  if (toolName === "attach") return "添加附件";
  if (toolName === "image") return "生成图片";
  if (toolName === "canvas") return "画布操作";
  if (toolName === "tts") return "语音合成";
  if (toolName === "speak_text") return "语音合成";
  if (toolName === "analyze_image") return "图像分析";
  if (toolName === "analyze_video") return "视频分析";  // [R44-T6]
  if (toolName === "analyze_audio") return "音频分析";  // [R44-T6]
  if (toolName === "analyze_document") return "文档分析"; // [R44-T6]
  if (toolName === "memory_search") return "搜索记忆";
  if (toolName === "memory_get") return "获取记忆";
  // Default: clean up tool name
  return toolName.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());
}

/**
 * Smart Chinese description for exec commands.
 * Analyzes the command to produce a human-readable Chinese description.
 */
function getSmartExecDescription(args) {
  const raw = typeof args === "string" ? args : (args?.command || args?.cmd || args?.script || "");
  if (!raw) return "执行命令";
  
  // Extract the primary command (first word, ignoring env vars and cd)
  const cmd = raw.replace(/^(cd [^;&]+[;&]\s*|export [^;&]+[;&]\s*|sudo\s+)/g, "").trim();
  
  // File/path extraction helper
  const extractTarget = (c) => {
    // Try to find a meaningful file path
    const pathMatch = c.match(/\s(\/[\w.\/-]+|[\w.-]+\.[a-z]{1,4})(?:\s|$|\|)/);
    if (pathMatch) return pathMatch[1].split("/").pop();
    return "";
  };
  
  // grep patterns
  if (/^grep\b/.test(cmd) || /\bgrep\b/.test(cmd)) {
    const patternMatch = raw.match(/grep\s+(?:-[\w]+\s+)*['""]?([^'""\s|]+)/);
    const pattern = patternMatch ? patternMatch[1] : "";
    if (pattern) return `搜索 "${pattern}" 相关代码`;
    return "搜索文件内容";
  }
  
  // cat/head/tail — viewing files
  if (/^(cat|head|tail)\b/.test(cmd)) {
    const target = extractTarget(cmd);
    if (/\|\s*head/.test(raw)) return target ? `查看 ${target} 前几行` : "查看文件开头";
    if (/\|\s*tail/.test(raw)) return target ? `查看 ${target} 最新内容` : "查看文件末尾";
    return target ? `查看 ${target} 内容` : "查看文件内容";
  }
  
  // ls — listing
  if (/^ls\b/.test(cmd)) {
    const dirMatch = raw.match(/ls\s+(?:-[\w]+\s+)*(\/[\w.\/-]+)/);
    const dir = dirMatch ? dirMatch[1].split("/").pop() : "";
    return dir ? `查看 ${dir} 目录` : "查看目录内容";
  }
  
  // find — searching files
  if (/^find\b/.test(cmd)) {
    const nameMatch = raw.match(/-name\s+['""]?([^'""\s]+)/);
    return nameMatch ? `查找 ${nameMatch[1]} 文件` : "查找文件";
  }
  
  // mkdir
  if (/^mkdir\b/.test(cmd)) return "创建目录";
  
  // cp/mv/rm
  if (/^cp\b/.test(cmd)) return "复制文件";
  if (/^mv\b/.test(cmd)) return "移动文件";
  if (/^rm\b/.test(cmd)) return "删除文件";
  
  // sed — editing
  if (/^sed\b/.test(cmd)) {
    const target = extractTarget(cmd);
    return target ? `修改 ${target}` : "修改文件内容";
  }
  
  // node/python — running scripts
  if (/^(node|python3?)\b/.test(cmd)) {
    const scriptMatch = raw.match(/(?:node|python3?)\s+(?:-[\w]+\s+)*(\/[\w.\/-]+|[\w.-]+\.(?:mjs|js|py))/);
    const script = scriptMatch ? scriptMatch[1].split("/").pop() : "";
    return script ? `运行脚本 ${script}` : "运行脚本";
  }
  
  // npm/pnpm/yarn
  if (/^(npm|pnpm|yarn)\b/.test(cmd)) {
    if (/install|add/.test(cmd)) return "安装依赖";
    if (/build/.test(cmd)) return "构建项目";
    if (/test/.test(cmd)) return "运行测试";
    if (/start|dev/.test(cmd)) return "启动服务";
    return "执行包管理命令";
  }
  
  // curl/wget
  if (/^(curl|wget)\b/.test(cmd)) return "发送网络请求";
  
  // mysql/psql
  if (/^(mysql|psql)\b/.test(cmd)) return "执行数据库查询";
  
  // systemctl
  if (/^systemctl\b/.test(cmd)) {
    if (/restart/.test(cmd)) return "重启服务";
    if (/start/.test(cmd)) return "启动服务";
    if (/stop/.test(cmd)) return "停止服务";
    if (/status/.test(cmd)) return "检查服务状态";
    return "管理系统服务";
  }
  
  // echo with redirect — writing config
  if (/^(echo|cat\s*<<)/.test(cmd) && />/.test(raw)) {
    const target = raw.match(/>\s*(\/[\w.\/-]+|[\w.-]+)/);
    const fname = target ? target[1].split("/").pop() : "";
    return fname ? `写入 ${fname}` : "写入配置";
  }
  
  // wc — counting
  if (/^wc\b/.test(cmd)) return "统计文件信息";
  
  // chmod/chown
  if (/^chmod\b/.test(cmd)) return "修改文件权限";
  if (/^chown\b/.test(cmd)) return "修改文件所有者";
  
  // tar/zip/unzip
  if (/^(tar|zip|unzip|gzip)\b/.test(cmd)) return "处理压缩文件";
  
  // docker
  if (/^docker\b/.test(cmd)) return "执行容器操作";
  
  // git
  if (/^git\b/.test(cmd)) {
    if (/clone/.test(cmd)) return "克隆仓库";
    if (/pull/.test(cmd)) return "拉取更新";
    if (/push/.test(cmd)) return "推送代码";
    if (/commit/.test(cmd)) return "提交代码";
    if (/diff/.test(cmd)) return "查看代码差异";
    if (/log/.test(cmd)) return "查看提交历史";
    return "执行 Git 操作";
  }
  
  // Pipe chains — describe the intent
  if (/\|/.test(raw)) {
    // grep in pipe
    if (/\|\s*grep/.test(raw)) {
      const patternMatch = raw.match(/\|\s*grep\s+(?:-[\w]+\s+)*['""]?([^'""\s|]+)/);
      const pattern = patternMatch ? patternMatch[1] : "";
      if (pattern) return `筛选 "${pattern}" 相关内容`;
      return "筛选数据";
    }
    if (/\|\s*wc/.test(raw)) return "统计数据";
    if (/\|\s*sort/.test(raw)) return "排序数据";
    if (/\|\s*head/.test(raw)) return "查看前几条结果";
    if (/\|\s*tail/.test(raw)) return "查看最新结果";
    return "处理数据";
  }
  
  // Fallback: use first meaningful word
  const firstWord = cmd.split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "");
  if (firstWord) return `执行 ${firstWord}`;
  return "执行命令";
}


export function getToolDetail(toolName, args) {
  if (toolName === "exec") return (args?.command || "").substring(0, 120);
  if (toolName === "web_search") return args?.query || "";
  if (toolName === "browser") {
    const bAction = args?.action || "";
    const bUrl = (args?.url || "").substring(0, 80);
    const actionMap = { navigate: "打开", open: "打开", snapshot: "读取", screenshot: "截图", act: "交互", click: "点击", type: "输入", scroll: "滚动", close: "关闭", wait: "等待", select: "选择" };
    return `${actionMap[bAction] || bAction} ${bUrl}`.trim();
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") return args?.path || "";
  return "";
}

export function cleanToolArgs(toolName, args) {
  if (!args) return {};
  const clone = { ...args };
  for (const key of Object.keys(clone)) {
    if (typeof clone[key] === "string" && clone[key].length > 500) {
      clone[key] = clone[key].substring(0, 200) + `... (${clone[key].length} chars)`;
    }
  }
  return clone;
}

export function extractToolText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (result.text) return result.text;
  if (result.content) return typeof result.content === "string" ? result.content : JSON.stringify(result.content).substring(0, 500);
  if (result.output) return result.output;
  if (result.stdout) return result.stdout;
  return JSON.stringify(result).substring(0, 300);
}

export function cleanToolResult(toolName, rawResult, resultText) {
  if (!rawResult) return { text: resultText || "" };
  if (toolName === "browser" && rawResult.details?.screenshot) {
    return { text: (resultText || "").substring(0, 500), screenshot: rawResult.details.screenshot };
  }
  return { text: (resultText || "").substring(0, 10000) };
}

// ─── Notify/Ask 语义分离 (Iter-S v25.20) ────────────────────
// 对标 Manus: notify（非阻塞进度通知）vs ask（阻塞等待用户决策）
// 模型在 SOUL.md §3.6 中被指导标注 [NOTIFY] / [ASK]
// 此函数解析标记，清理标记，返回 mode 和 cleanText

/**
 * 解析回复中的 notify/ask 语义标记
 * @param {string} text
 * @returns {{ mode: 'notify' | 'ask' | 'default', cleanText: string }}
 */
export function parseResponseMode(text) {
  if (!text || typeof text !== 'string') return { mode: 'default', cleanText: text };

  // 中英文双模式匹配
  if (/\[NOTIFY\]|\[通知\]/i.test(text)) {
    return {
      mode: 'notify',
      cleanText: text.replace(/\s*\[(?:NOTIFY|通知)\]\s*/gi, '').trim(),
    };
  }
  if (/\[ASK\]|\[询问\]/i.test(text)) {
    return {
      mode: 'ask',
      cleanText: text.replace(/\s*\[(?:ASK|询问)\]\s*/gi, '').trim(),
    };
  }
  return { mode: 'default', cleanText: text };
}
