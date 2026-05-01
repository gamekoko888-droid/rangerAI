/**
 * provider-discovery.mjs — OpenClaw configuration discovery
 * Provides: skills list, tools list, capabilities, providers/models
 * Extracted from server.mjs v63 during modular refactor.
 */

import { logger } from '../lib/logger.mjs';
import fs from "fs";
import { execSync as _execSync } from "child_process";

const ts = () => new Date().toISOString();
const OPENCLAW_CONFIG_PATH = "/home/admin/.openclaw/openclaw.json";

// ─── Skill Display Map (Chinese localization) ──────────────
const SKILL_DISPLAY_MAP = {
  "prose": { name: "多智能体协作", desc: "编排多个 AI 共同完成复杂任务" },
  "clawhub": { name: "插件商店", desc: "搜索、安装和更新 AI 技能插件" },
  "coding-agent": { name: "编程助手", desc: "委托 AI 处理大规模代码编写和重构任务" },
  "gemini": { name: "谷歌 AI 对话", desc: "调用 Gemini 模型进行文本生成和分析" },
  "gh-issues": { name: "GitHub 任务处理", desc: "自动修复 GitHub 仓库中的 Bug 并提交 PR" },
  "github": { name: "GitHub 集成", desc: "通过命令行管理 GitHub 的 Issue、PR 和 CI 流程" },
  "healthcheck": { name: "系统安全检查", desc: "对服务器进行安全审计和合规性检查" },
  "mcporter": { name: "MCP 扩展工具", desc: "连接和调用各类 MCP 协议的外部工具" },
  "nano-banana-pro": { name: "图片生成与编辑", desc: "使用谷歌模型生成或修改图片" },
  "openai-image-gen": { name: "DALL-E 图片生成", desc: "批量生成高质量 AI 图片并创建图库" },
  "openai-whisper-api": { name: "语音转文字", desc: "高效转录各种格式音频文件" },
  "session-logs": { name: "会话日志分析", desc: "检索和分析过去的历史对话记录" },
  "skill-creator": { name: "技能创建器", desc: "设计、打包并发布新的 Agent 技能" },
  "tmux": { name: "终端多窗口管理", desc: "控制 Linux 终端会话执行交互式操作" },
  "video-frames": { name: "视频抽帧", desc: "从视频中提取关键帧或短视频剪辑" },
  "weather": { name: "天气查询", desc: "获取全球城市的实时天气和预报" },
  "active-memory": { name: "主动记忆系统", desc: "跨任务检索关联经验，实现预测性记忆" },
  "alerting": { name: "运维告警", desc: "将系统异常实时推送到 Telegram 告警" },
  "api-testing": { name: "接口自动化测试", desc: "对 API 进行回归测试和响应校验" },
  "ask-chain": { name: "智能提问系统", desc: "在不确定时自动触发多层级提问协议" },
  "auto-backup": { name: "自动备份", desc: "每日自动备份核心配置和技能到 Git" },
  "canvas-game-dev": { name: "游戏开发辅助", desc: "针对 Canvas 游戏的开发痛点提供专项支持" },
  "chinese-content": { name: "中文内容创作", desc: "高质量撰写商业文案、技术文档和自媒体文章" },
  "code-review": { name: "代码质量审查", desc: "从安全、性能、维护性等多维度评审代码" },
  "context-optimization": { name: "上下文优化", desc: "智能管理 AI 的上下文窗口，提升推理效率" },
  "cost-tracker": { name: "API 成本统计", desc: "监控 API 调用量并生成费用使用报告" },
  "data-analysis": { name: "数据分析专家", desc: "完成从数据清洗到图表可视化的全流程分析" },
  "doc-generator": { name: "文档自动生成", desc: "从代码中自动提取信息生成项目 README 或 API 文档" },
  "evolution-engine": { name: "进化引擎", desc: "驱动 AI 在空闲时间自动执行自我提升任务" },
  "evolve-toward-excellence": { name: "向卓越进化", desc: "对标行业标杆，识别差距并生成进化任务" },
  "health-guardian": { name: "系统健康守护", desc: "每 5 分钟自动检测并修复系统常见故障" },
  "incident-response": { name: "故障应急响应", desc: "系统异常时的标准应急处理与证据采集流程" },
  "knowledge-base": { name: "结构化知识库", desc: "沉淀和管理任务过程中发现的新知识点" },
  "length-control": { name: "字数长度控制", desc: "精准控制生成内容的长度，确保符合字数要求" },
  "log-analyzer": { name: "日志智能分析", desc: "分析系统日志，定位异常尖峰和潜在风险" },
  "model-routing-v6": { name: "智能模型路由", desc: "按任务复杂度自动分派最优 AI 模型" },
  "observability": { name: "服务监控", desc: "设置和管理服务的指标收集、链路追踪和告警" },
  "parallel-tasks": { name: "并行任务处理", desc: "将复杂需求分解为多个子任务同时执行" },
  "presentation-master": { name: "专业 PPT 制作", desc: "从内容策划到视觉设计的一站式 PPT 生成" },
  "project-deploy": { name: "项目自动化部署", desc: "一键完成代码上线、域名配置和 SSL 证书更新" },
  "rangerai-architecture": { name: "游侠架构指南", desc: "了解和维护 RangerAI 核心系统的技术规范" },
  "sandbox-exec": { name: "代码安全执行", desc: "在隔离的沙箱环境中安全运行用户代码" },
  "searxng": { name: "无追踪搜索", desc: "使用私有搜索引擎保护隐私并获取纯净结果" },
  "security-hardening": { name: "服务器安全加固", desc: "迁移硬编码密钥至环境变量，提升系统安全性" },
  "self-deploy": { name: "前端自主部署", desc: "自主构建并将前端代码部署到阿里云服务器" },
  "self-diagnosis": { name: "系统自我诊断", desc: "全量检查资源、状态和连接健康度" },
  "self-evolution": { name: "自我进化闭环", desc: "任务完成后自动进行结构化反思与技能优化" },
  "self-repair": { name: "系统自动修复", desc: "诊断并修复部署层面的环境配置问题" },
  "server-ops": { name: "服务器运维专家", desc: "精通 Linux 系统管理、Docker 及进程控制" },
  "ssh-hardening": { name: "SSH 安全增强", desc: "加固远程访问安全，限制爆破攻击" },
  "task-memory": { name: "任务执行记忆", desc: "为复杂任务建立独立的上下文管理目录" },
  "taskkit": { name: "任务隔离与交付", desc: "提供规范的任务目录和标准化的交付结果" },
  "think-first": { name: "先思考再执行", desc: "强制执行意图理解、任务拆解和风险评估流程" },
  "web-dev": { name: "全栈 Web 开发", desc: "涵盖从前端 React 到后端 Node.js 的全方位开发" },
  "1password": { name: "1Password 密码管理", desc: "集成 1Password 命令行工具进行密钥存取" },
  "apple-notes": { name: "苹果备忘录管理", desc: "在 macOS 上创建、编辑和搜索备忘录" },
  "apple-reminders": { name: "苹果提醒事项", desc: "管理 iOS/macOS 的待办提醒列表" },
  "bear-notes": { name: "Bear 笔记助手", desc: "通过命令行创建和管理 Bear 笔记" },
  "blogwatcher": { name: "博客订阅监控", desc: "自动监控 RSS/Atom 源并提取更新内容" },
  "blucli": { name: "BluOS 音响控制", desc: "管理 BlueSound 系列音响的播放与分组" },
  "bluebubbles": { name: "iMessage 发送", desc: "通过 BlueBubbles 服务发送和管理苹果短信" },
  "camsnap": { name: "监控快照抓取", desc: "从 RTSP/ONVIF 摄像头提取实时画面帧" },
  "discord": { name: "Discord 社群管理", desc: "通过机器人管理 Discord 频道与消息交互" },
  "eightctl": { name: "智能床垫控制", desc: "远程管理 Eight Sleep 睡眠系统的温度与闹钟" },
  "gifgrep": { name: "GIF 动图搜索", desc: "快速搜索、下载并提取 GIF 素材" },
  "gog": { name: "谷歌办公套件", desc: "管理 Gmail、网盘、表格等 Google Workspace 服务" },
  "goplaces": { name: "谷歌地点搜索", desc: "查询全球地点详情、评价及导航信息" },
  "himalaya": { name: "邮件客户端", desc: "在终端中收发、搜索和管理 IMAP 邮件" },
  "imsg": { name: "苹果短信工具", desc: "在 macOS 终端中列出和发送本地短信" },
  "model-usage": { name: "模型用量统计", desc: "统计不同 AI 模型的调用成本与使用频率" },
  "nano-pdf": { name: "PDF 快速编辑", desc: "使用自然语言指令对 PDF 进行修改" },
  "notion": { name: "Notion 内容管理", desc: "同步、创建和维护 Notion 数据库与页面" },
  "obsidian": { name: "Obsidian 笔记助手", desc: "自动化管理本地 Obsidian 知识库文件" },
  "openai-whisper": { name: "本地语音转文字", desc: "在本地离线运行 Whisper 进行音频转录" },
  "openhue": { name: "飞利浦智能灯光", desc: "控制 Philips Hue 系列灯具的开关与色彩" },
  "oracle": { name: "代码文件捆绑", desc: "快速打包项目文件作为 AI 上下文输入" },
  "ordercli": { name: "外卖订单查询", desc: "查询 Foodora 等平台的历史订单与状态" },
  "peekaboo": { name: "macOS UI 自动化", desc: "捕获苹果电脑界面并执行 UI 模拟操作" },
  "sag": { name: "ElevenLabs 语音合成", desc: "调用顶级 AI 配音引擎生成自然的人声" },
  "sherpa-onnx-tts": { name: "本地文本转语音", desc: "离线运行高效率的语音合成引擎" },
  "slack": { name: "Slack 办公协作", desc: "通过 API 管理 Slack 消息、频道与回复" },
  "songsee": { name: "音频频谱分析", desc: "生成音频文件的可视化频谱图与特征面板" },
  "sonoscli": { name: "Sonos 音响控制", desc: "发现并控制局域网内的 Sonos 播放设备" },
  "spotify-player": { name: "Spotify 终端播放", desc: "在命令行中搜索并播放 Spotify 音乐" },
  "summarize": { name: "万能内容摘要", desc: "自动提取网页、视频、播客的核心摘要" },
  "things-mac": { name: "Things 待办管理", desc: "自动化管理 macOS 上的 Things 任务列表" },
  "trello": { name: "Trello 项目看板", desc: "管理 Trello 看板、任务列表与卡片" },
  "voice-call": { name: "语音通话启动", desc: "快速启动与用户的即时语音通话连接" },
  "wacli": { name: "WhatsApp 短信管理", desc: "搜索和同步 WhatsApp 聊天记录（非实时对话）" },
  "xurl": { name: "X/Twitter 社交管理", desc: "自动化发布推文、回复、点赞及管理关注" }
};

// ─── Config Loader (compat) ─────────────────────────────────
export function loadOpenClawConfig(configPath) {
  // Each function reads config on demand; this is a no-op compat shim
  if (configPath) {
    logger.info(`[${ts()}] [provider-discovery] Config path: ${configPath}`);
  }
}

// ─── Skills Discovery ──────────────────────────────────────────
let _cachedSkills = null;
let _skillsCacheTime = 0;
const SKILLS_CACHE_TTL = 300000; // 5 min


// ─── Blocked monitoring/巡检 skills (prevent token waste) ───
const BLOCKED_SKILLS = [
  "health-guardian", "healthcheck", "self-diagnosis", "self-repair",
  "incident-response", "alerting", "observability", "evolution-engine",
  "evolve-toward-excellence", "self-evolution", "security-audit",
  "system-health-monitor", "health-dashboard", "process-monitor", "uptime-monitor"
];

export function getAvailableSkills() {
  const now = Date.now();
  if (_cachedSkills && (now - _skillsCacheTime) < SKILLS_CACHE_TTL) return _cachedSkills;
  try {
    const raw = _execSync('runuser -u admin -- /home/admin/.npm-global/bin/openclaw skills list --json 2>&1', {
      timeout: 30000, encoding: "utf-8"
    });
    const _start = raw.indexOf("{"); const _end = raw.lastIndexOf("}"); const jsonStr = (_start >= 0 && _end > _start) ? raw.substring(_start, _end + 1) : "{}";
    const data = JSON.parse(jsonStr);
    const skills = (data.skills || []).map(s => {
      const display = SKILL_DISPLAY_MAP[s.name] || { name: s.name, desc: s.description };
      return {
        name: s.name,
        displayName: display.name,
        label: display.name,
        description: `【${display.name}】${display.desc || ""}`,
        emoji: s.emoji || "🛠️",
        eligible: !!s.eligible,
        source: s.source || "unknown",
        homepage: s.homepage || null,
        missing: s.eligible ? null : {
          bins: s.missing?.bins || [],
          env: s.missing?.env || [],
          config: s.missing?.config || [],
          os: s.missing?.os || []
        }
      };
    });
    // Filter out blocked monitoring/巡检 skills
    const filteredSkills = skills.filter(s => !BLOCKED_SKILLS.includes(s.name));
    _cachedSkills = filteredSkills;
    _skillsCacheTime = now;
    logger.info(`[${ts()}] [provider-discovery] Skills: ${filteredSkills.filter(s => s.eligible).length} ready / ${filteredSkills.length} total (${skills.length - filteredSkills.length} blocked)`);
    return filteredSkills;
  } catch (e) {
    logger.warn(`[${ts()}] [provider-discovery] Skills discovery failed: ${e.message}`);
    return _cachedSkills || [];
  }
}

// ─── Tools Discovery ───────────────────────────────────────
export function getAvailableTools() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const sandboxTools = cfg?.tools?.sandbox?.tools?.allow || [];
    const alsoAllow = cfg?.tools?.alsoAllow || [];
    const webSearch = cfg?.tools?.web?.search?.enabled ? ["web_search"] : [];
    const webFetch = cfg?.tools?.web?.fetch?.enabled ? ["web_fetch"] : [];
    const elevated = cfg?.tools?.elevated?.enabled ? ["elevated"] : [];
    return [...new Set([...sandboxTools, ...alsoAllow, ...webSearch, ...webFetch, ...elevated])];
  } catch {
    return [];
  }
}

// ─── System Capabilities ───────────────────────────────────
export function getSystemCapabilities() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const caps = [];
    if (cfg?.agents?.defaults?.memorySearch?.enabled) caps.push("memory_search");
    if (cfg?.cron?.enabled) caps.push("cron_scheduling");
    if (cfg?.agents?.defaults?.sandbox?.browser?.enabled) caps.push("browser_automation");
    if (cfg?.agents?.defaults?.subagents) caps.push("multi_agent");
    if (cfg?.hooks?.internal?.enabled) caps.push("hooks");
    if (cfg?.channels?.telegram?.enabled) caps.push("telegram_channel");
    const plugins = Object.entries(cfg?.plugins?.entries || {}).filter(([, v]) => v.enabled).map(([k]) => k);
    if (plugins.length) caps.push(...plugins.map(p => `plugin_${p}`));
    return caps;
  } catch {
    return [];
  }
}

// ─── Providers / Models ────────────────────────────────────
export function getAvailableProviders() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const providers = cfg?.models?.providers || {};
    const result = [{ id: "rangerai", name: "RangerAI", models: ["Agent"] }];
    for (const [pid, pdata] of Object.entries(providers)) {
      const models = (pdata.models || []).map(m => m.name || m.id);
      if (models.length > 0) {
        const displayName = pid === "openai" ? "OpenAI" : pid === "google" ? "Google" : pid === "anthropic" ? "Anthropic" : pid;
        result.push({ id: pid, name: displayName, models });
      }
    }
    return result;
  } catch {
    return [{ id: "rangerai", name: "RangerAI", models: ["Agent"] }];
  }
}
