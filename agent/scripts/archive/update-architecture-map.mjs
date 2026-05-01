#!/usr/bin/env node
/**
 * update-architecture-map.mjs  v3.0 — Dynamic Probe Edition
 * 
 * 核心原则：零硬编码事实。所有架构描述均通过运行时探测生成。
 * 代码迭代后重新运行即可得到最新的架构地图，不会"刻舟求剑"。
 * 
 * 探测方法：
 *   1. systemd ExecStart → 判断活跃入口
 *   2. 文件头注释 → 提取模块自述
 *   3. import/require 依赖图 → 推断技术栈
 *   4. grep 关键模式 → 检测 Redis/MySQL/IPC/向量等能力
 *   5. 进程树 → 确认运行时状态
 * 
 * 运行方式：node /opt/rangerai-agent/update-architecture-map.mjs
 * 建议 cron：0 4 * * * (每天凌晨 4 点)
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';

const AGENT_DIR = '/opt/rangerai-agent';
const OUTPUT_FILE = '/home/admin/.openclaw/workspace/ARCHITECTURE-MAP.md';
const BACKUP_FILE = '/home/admin/.openclaw/workspace/docs/ARCHITECTURE-MAP.md';

function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

function safeExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim(); }
  catch { return ''; }
}

function countLines(filePath) {
  try {
    const result = safeExec(`wc -l < "${filePath}"`);
    return parseInt(result) || 0;
  } catch { return 0; }
}

// ─── Probe: Extract file metadata via code analysis ───
function probeFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const head = lines.slice(0, 40);
    
    // Self-description: extract the file's own header comment
    const selfDesc = head
      .filter(l => l.startsWith('//') || l.startsWith(' *') || l.startsWith('/**'))
      .map(l => l.replace(/^\/\/\s*/, '').replace(/^\s*\*\s*/, '').replace(/^\/\*\*\s*/, '').trim())
      .filter(l => l.length > 3 && l.length < 150 && !l.startsWith('─') && !l.startsWith('@'))
      .slice(0, 3);
    
    // Imports
    const imports = head
      .filter(l => l.startsWith('import ') || (l.startsWith('const ') && l.includes('require(')))
      .map(l => l.trim())
      .slice(0, 10);
    
    // Exports (named + default)
    const exports = [];
    const namedRe = /export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g;
    let m;
    while ((m = namedRe.exec(content)) !== null) exports.push(m[1]);
    const defMatch = content.match(/export\s+default\s+(?:class\s+)?(\w+)/);
    if (defMatch && !exports.includes(defMatch[1])) exports.push(`default:${defMatch[1]}`);
    
    // Technology tags — detected from actual code patterns
    const tags = [];
    if (/(?:import|require).*(?:redis|ioredis|RedisPool)/i.test(content)) tags.push('Redis');
    if (/(?:import|require).*(?:mysql|tidb|database|db-adapter)/i.test(content) || /query\(|queryOne\(|queryAll\(/i.test(content)) tags.push('MySQL');
    if (/writeFileSync|readFileSync|appendFileSync|createWriteStream|createReadStream/i.test(content)) tags.push('FileSystem');
    if (/child_process.*fork|fork\(/i.test(content)) tags.push('IPC:fork');
    if (/child_process.*spawn|spawn\(/i.test(content)) tags.push('IPC:spawn');
    if (/child_process.*exec[^S]/i.test(content)) tags.push('IPC:exec');
    if (/worker_threads|new Worker\(/i.test(content)) tags.push('WorkerThread');
    if (/WebSocket|\.on\(['"]message/i.test(content)) tags.push('WebSocket');
    if (/express|app\.get|app\.post|app\.use/i.test(content)) tags.push('HTTP');
    if (/embedding|vector|cosine|similarity/i.test(content)) tags.push('Vector');
    if (/FTS|fts5|MATCH\s*\(/i.test(content)) tags.push('FTS');
    if (/pub.*sub|subscribe|publish/i.test(content)) tags.push('PubSub');
    
    return { selfDesc, imports, exports, tags, lineCount: countLines(filePath) };
  } catch {
    return { selfDesc: [], imports: [], exports: [], tags: [], lineCount: 0 };
  }
}

function scanDirectory(dir, prefix = '') {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('dist-backup') || entry.name === 'public' || entry.name === 'backups') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDirectory(fullPath, prefix + entry.name + '/'));
      } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
        const stat = statSync(fullPath);
        results.push({ path: prefix + entry.name, fullPath, size: stat.size, modified: stat.mtime.toISOString().substring(0, 10) });
      }
    }
  } catch(_err) { /* v22.0 */ console.error("[update-architecture-map] silent catch:", _err?.message || _err); }
  return results;
}

// ─── Probe: systemd services → determine active entry files ───
function probeServices() {
  const serviceNames = ['rangerai-agent', 'rangerai-ws', 'rangerai-static', 'openclaw-gateway'];
  const results = [];
  for (const svc of serviceNames) {
    const status = safeExec(`systemctl is-active ${svc} 2>/dev/null`) || 'unknown';
    const pid = safeExec(`systemctl show ${svc} --property=MainPID --value 2>/dev/null`) || '?';
    const execStart = safeExec(`systemctl show ${svc} --property=ExecStart --value 2>/dev/null`);
    const scriptMatch = execStart.match(/\/opt\/rangerai-agent\/([\w\-/.]+\.mjs)/);
    const entryFile = scriptMatch ? scriptMatch[1] : null;
    const user = pid !== '?' && pid !== '0' ? safeExec(`ps -o user= -p ${pid} 2>/dev/null`) : '';
    results.push({ name: svc, status, pid, entryFile, user });
  }
  return results;
}

// ─── Probe: Caddy routes ───
function probeCaddyRoutes() {
  try {
    const caddyfile = readFileSync('/etc/caddy/Caddyfile', 'utf-8');
    const routes = [];
    const re = /(?:handle_path|handle|route)\s+([^\s{]+)/g;
    let m;
    while ((m = re.exec(caddyfile)) !== null) routes.push(m[1]);
    return routes;
  } catch { return []; }
}

// ─── Classify file status by comparing against systemd entries ───
function classifyStatus(filePath, services) {
  const activeEntries = services.filter(s => s.entryFile).map(s => s.entryFile);
  const fileName = basename(filePath);
  
  if (activeEntries.includes(fileName)) return '🟢 活跃入口';
  
  // If another file with similar purpose is the active entry, this one is legacy
  // Detect by: same prefix but different name, e.g. server.mjs vs api-server.mjs
  if (fileName === 'server.mjs' && activeEntries.some(e => e.includes('server'))) return '🔴 遗留';
  
  return '';
}

// ─── Generate architecture overview — ALL facts from probes ───
function generateOverview(services, files) {
  const activeServices = services.filter(s => s.status === 'active' && s.entryFile);
  
  let o = `## 架构概览（运行时探测生成）\n\n`;
  o += `> 以下所有描述均由运行时探测自动生成，不含硬编码断言。代码迭代后重新运行 \`update-architecture-map.mjs\` 即可刷新。\n\n`;
  
  // ── Process Model ──
  o += `### 进程模型\n\n`;
  if (activeServices.length > 0) {
    o += `系统由 systemd 管理 ${activeServices.length} 个活跃服务：\n\n`;
    o += `| 服务 | 入口文件 | 运行用户 | PID |\n`;
    o += `|------|----------|---------|-----|\n`;
    for (const s of activeServices) {
      o += `| ${s.name} | ${s.entryFile} | ${s.user || '?'} | ${s.pid} |\n`;
    }
    o += '\n';
    
    // Detect legacy files: .mjs files in root that look like entry points but are NOT in activeEntries
    const activeEntryNames = activeServices.map(s => s.entryFile);
    const rootMjs = files.filter(f => !f.path.includes('/') && f.path.endsWith('.mjs'));
    const legacyEntries = rootMjs.filter(f => {
      const name = f.path;
      if (activeEntryNames.includes(name)) return false;
      // Heuristic: file name contains "server" or has HTTP/express tags but is not active
      const probe = probeFile(f.fullPath);
      return probe.tags.includes('HTTP') || name.includes('server');
    });
    if (legacyEntries.length > 0) {
      o += `**检测到可能的遗留入口文件**（存在于代码库但未被 systemd 加载）：${legacyEntries.map(f => '`' + f.path + '`').join(', ')}。审计时应以 systemd 实际加载的入口为准。\n\n`;
    }
  }
  
  // ── IPC ──
  o += `### 进程间通信\n\n`;
  // Probe: what IPC mechanisms exist?
  const ipcFiles = [];
  for (const f of files) {
    if (f.path.endsWith('.json')) continue;
    const probe = probeFile(f.fullPath);
    const ipcTags = probe.tags.filter(t => t.startsWith('IPC:') || t === 'PubSub');
    if (ipcTags.length > 0) {
      ipcFiles.push({ path: f.path, tags: ipcTags, desc: probe.selfDesc[0] || '' });
    }
  }
  if (ipcFiles.length > 0) {
    o += `| 文件 | IPC 方式 | 自述 |\n`;
    o += `|------|---------|------|\n`;
    for (const f of ipcFiles) {
      o += `| ${f.path} | ${f.tags.join(', ')} | ${f.desc} |\n`;
    }
    o += '\n';
  } else {
    o += `未检测到显式 IPC 机制。\n\n`;
  }
  // Check for dedicated IPC library
  const redisIpcPath = join(AGENT_DIR, 'lib/redis-ipc.mjs');
  if (existsSync(redisIpcPath)) {
    const probe = probeFile(redisIpcPath);
    o += `专用 IPC 库：\`lib/redis-ipc.mjs\`（${probe.selfDesc[0] || '无自述'}），导出：${probe.exports.join(', ') || '无'}。\n\n`;
  }
  
  // ── Storage ──
  o += `### 存储分层\n\n`;
  const storageProbes = {};
  const storageFiles = ['task-store.mjs', 'database.mjs', 'db-adapter.mjs', 'knowledge-db.mjs', 'embedding-cache.mjs'];
  for (const name of storageFiles) {
    const fp = join(AGENT_DIR, name);
    if (existsSync(fp)) {
      const probe = probeFile(fp);
      storageProbes[name] = probe;
    }
  }
  if (Object.keys(storageProbes).length > 0) {
    o += `| 模块 | 自述 | 技术标签 |\n`;
    o += `|------|------|----------|\n`;
    for (const [name, probe] of Object.entries(storageProbes)) {
      o += `| ${name} | ${probe.selfDesc[0] || '无'} | ${probe.tags.join(', ') || '-'} |\n`;
    }
    o += '\n';
  }
  
  // ── RAG / Knowledge Retrieval ──
  o += `### 知识检索能力\n\n`;
  const knowledgeFile = join(AGENT_DIR, 'knowledge-db.mjs');
  if (existsSync(knowledgeFile)) {
    const probe = probeFile(knowledgeFile);
    const capabilities = [];
    if (probe.tags.includes('FTS')) capabilities.push('全文搜索 (FTS)');
    if (probe.tags.includes('Vector')) capabilities.push('向量搜索');
    if (probe.tags.includes('MySQL')) capabilities.push('SQL 查询');
    // Check for hybrid/RRF
    const ragUtilsPath = join(AGENT_DIR, 'lib/rag-utils.mjs');
    if (existsSync(ragUtilsPath)) {
      const ragProbe = probeFile(ragUtilsPath);
      const ragContent = readFileSync(ragUtilsPath, 'utf-8');
      if (/reciprocalRankFusion|RRF|rrf/i.test(ragContent)) capabilities.push('RRF 融合排序');
    }
    const kContent = readFileSync(knowledgeFile, 'utf-8');
    if (/searchKnowledgeHybrid/i.test(kContent)) capabilities.push('混合检索');
    
    o += `knowledge-db.mjs 检测到的检索能力：${capabilities.length > 0 ? capabilities.join(' + ') : '需手动检查'}。\n`;
    o += `自述：${probe.selfDesc[0] || '无'}。\n\n`;
  } else {
    o += `未找到 knowledge-db.mjs。\n\n`;
  }
  
  // ── Model Routing ──
  o += `### 模型路由\n\n`;
  const routerFile = join(AGENT_DIR, 'smart-router.mjs');
  if (existsSync(routerFile)) {
    const probe = probeFile(routerFile);
    o += `smart-router.mjs（${probe.lineCount} 行）：${probe.selfDesc[0] || '无自述'}。\n`;
    // Check if metrics feed back into routing
    const routerContent = readFileSync(routerFile, 'utf-8');
    const hasMetricsFeedback = /metricsCollector|getMetrics|latencyScore|qualityScore/i.test(routerContent);
    const metricsFile = join(AGENT_DIR, 'lib/metrics-collector.mjs');
    const hasMetricsCollector = existsSync(metricsFile);
    o += `指标收集器：${hasMetricsCollector ? '存在 (lib/metrics-collector.mjs)' : '未检测到'}。`;
    o += `指标反馈到路由决策：${hasMetricsFeedback ? '是' : '未检测到'}。\n\n`;
  }
  
  // ── Security ──
  o += `### 安全边界\n\n`;
  const users = [...new Set(services.filter(s => s.user).map(s => s.user))];
  o += `进程运行用户：${users.length > 0 ? users.join(', ') : '未检测到'}。\n`;
  const dockerCount = safeExec(`docker ps --format "{{.Names}}" 2>/dev/null | wc -l`);
  o += `Docker 容器数量：${dockerCount || '0'}。\n`;
  const hasSecretFile = existsSync(join(AGENT_DIR, 'agent-secrets.env'));
  o += `敏感配置文件：${hasSecretFile ? 'agent-secrets.env 存在' : '未检测到'}。\n\n`;
  
  return o;
}

// ─── Generate dynamic quick facts ───
function generateQuickFacts(services, files) {
  let md = `## 快速事实（运行时探测）\n\n`;
  md += `> 以下答案均由探测命令实时生成，非硬编码。\n\n`;
  
  const facts = [];
  
  // 1. Active entry files
  const activeEntries = services.filter(s => s.entryFile && s.status === 'active');
  facts.push({
    q: '当前活跃入口文件',
    a: activeEntries.map(s => `${s.name} → ${s.entryFile}`).join('; ') || '未检测到',
    cmd: 'systemctl show rangerai-agent rangerai-ws --property=ExecStart --value'
  });
  
  // 2. task-store backend
  const tsPath = join(AGENT_DIR, 'task-store.mjs');
  if (existsSync(tsPath)) {
    const header = safeExec(`head -5 "${tsPath}"`);
    facts.push({
      q: 'task-store.mjs 存储后端',
      a: header.split('\n').filter(l => l.includes('*') || l.includes('//')).map(l => l.trim()).join(' ') || '需检查文件头',
      cmd: 'head -5 /opt/rangerai-agent/task-store.mjs'
    });
  }
  
  // 3. IPC mechanisms
  const ipcSummary = [];
  for (const f of files) {
    if (f.path.endsWith('.json')) continue;
    const probe = probeFile(f.fullPath);
    const ipc = probe.tags.filter(t => t.startsWith('IPC:') || t === 'PubSub');
    if (ipc.length > 0) ipcSummary.push(`${f.path}(${ipc.join(',')})`);
  }
  facts.push({
    q: 'IPC 通信方式',
    a: ipcSummary.length > 0 ? ipcSummary.join('; ') : '未检测到',
    cmd: 'grep -rn "fork\\|spawn\\|pub.*sub" /opt/rangerai-agent/*.mjs /opt/rangerai-agent/modules/*.mjs /opt/rangerai-agent/lib/*.mjs 2>/dev/null | head -10'
  });
  
  // 4. RAG capabilities
  const kdb = join(AGENT_DIR, 'knowledge-db.mjs');
  if (existsSync(kdb)) {
    const content = readFileSync(kdb, 'utf-8');
    const caps = [];
    if (/FTS|fts5/i.test(content)) caps.push('FTS');
    if (/embedding|vector|cosine/i.test(content)) caps.push('Vector');
    if (/searchKnowledgeHybrid/i.test(content)) caps.push('Hybrid');
    facts.push({
      q: 'RAG/知识检索能力',
      a: caps.length > 0 ? caps.join(' + ') : '需手动检查',
      cmd: 'grep -c "FTS\\|vector\\|Hybrid\\|embedding" /opt/rangerai-agent/knowledge-db.mjs'
    });
  }
  
  // 5. Heartbeat config
  const pingMon = join(AGENT_DIR, 'modules/worker-ping-monitor.mjs');
  if (existsSync(pingMon)) {
    const pingContent = readFileSync(pingMon, 'utf-8');
    const intervalMatch = pingContent.match(/intervalMs\s*[=:]\s*(\d+)/);
    const maxMissedMatch = pingContent.match(/maxMissed\s*[=:]\s*(\d+)/);
    const interval = intervalMatch ? parseInt(intervalMatch[1]) : null;
    const maxMissed = maxMissedMatch ? parseInt(maxMissedMatch[1]) : null;
    let desc = '';
    if (interval && maxMissed) {
      desc = `间隔 ${interval}ms × 容忍 ${maxMissed} 次 = 超时 ${(interval * maxMissed / 1000).toFixed(0)}s`;
    } else {
      desc = safeExec(`grep -n "maxMissed\\|intervalMs" "${pingMon}"`);
    }
    facts.push({
      q: '心跳超时配置',
      a: desc,
      cmd: 'grep -n "maxMissed\\|intervalMs" /opt/rangerai-agent/modules/worker-ping-monitor.mjs'
    });
  }
  
  // 6. Process user
  facts.push({
    q: '进程运行用户',
    a: services.filter(s => s.user).map(s => `${s.name}: ${s.user}`).join('; ') || '未检测到',
    cmd: 'ps -o user= -p $(systemctl show rangerai-ws --property=MainPID --value)'
  });
  
  // 7. /tasks/ directory
  facts.push({
    q: '/tasks/ 目录',
    a: existsSync(join(AGENT_DIR, 'tasks')) ? '存在' : '不存在',
    cmd: 'ls -d /opt/rangerai-agent/tasks 2>/dev/null'
  });
  
  md += `| 问题 | 探测结果 | 验证命令 |\n`;
  md += `|------|---------|----------|\n`;
  for (const f of facts) {
    // Escape pipe characters in answers
    const safeA = f.a.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    md += `| ${f.q} | ${safeA} | \`${f.cmd}\` |\n`;
  }
  md += '\n';
  
  return md;
}

// === Main ===
console.log(`[${ts()}] Scanning ${AGENT_DIR}...`);

const files = scanDirectory(AGENT_DIR);
const services = probeServices();
const caddyRoutes = probeCaddyRoutes();

// Categorize files
const categories = {
  'Core (根目录)': files.filter(f => !f.path.includes('/') && f.path.endsWith('.mjs')),
  'Worker (子进程)': files.filter(f => f.path.startsWith('worker/')),
  'Services (服务层)': files.filter(f => f.path.startsWith('services/')),
  'Lib (工具库)': files.filter(f => f.path.startsWith('lib/')),
  'Modules (模块)': files.filter(f => f.path.startsWith('modules/')),
  'Config (配置)': files.filter(f => f.path.endsWith('.json') || f.path.endsWith('.yaml')),
};

let md = `# RangerAI 系统架构地图 v3.0（动态探测 · 自动生成）

> **生成时间**：${ts()}
> **源代码目录**：${AGENT_DIR}
> **文件总数**：${files.length} 个
> **生成方式**：所有事实均由运行时探测生成，零硬编码断言。代码迭代后重新运行即可刷新。

---

## 审计规则（Agent 必读）

1. **先验证后断言**：对任何技术细节，必须先用 exec 工具读取实际代码，再输出结论。
2. **引用格式**：每个结论附带 \`文件名:行号 — 实际代码片段\`。使用 \`sed -n 'Np' 文件路径\` 验证行号。
3. **以 systemd 为准**：判断"当前入口"以 \`systemctl show\` 的 ExecStart 为准，不以文件是否存在为准。
4. **以文件头为准**：判断模块用途以文件自身的头部注释为准，不以文件名猜测。
5. **禁止推断**：不得使用"通常来说"、"一般的 Node.js 应用"、"我记得"等表述。不确定的标注 [未验证]。
6. **本文件是快照**：本文件生成于 ${ts()}，如果代码在此之后有变更，以实际代码为准。

---

`;

// Architecture Overview (all dynamic)
md += generateOverview(services, files);
md += `---\n\n`;

// Service status
md += `## 系统服务状态\n\n`;
md += `| 服务名 | 状态 | PID | 入口文件 | 运行用户 |\n`;
md += `|--------|------|-----|----------|----------|\n`;
for (const s of services) {
  md += `| ${s.name} | ${s.status} | ${s.pid} | ${s.entryFile || '-'} | ${s.user || '-'} |\n`;
}
md += `\n`;

// Caddy routes
if (caddyRoutes.length > 0) {
  md += `## Caddy 路由表\n\n`;
  md += caddyRoutes.map(r => `- \`${r}\``).join('\n');
  md += '\n\n';
}
md += `---\n\n`;

// File listing
for (const [category, catFiles] of Object.entries(categories)) {
  if (catFiles.length === 0) continue;
  md += `## ${category}\n\n`;
  md += `| 文件 | 行数 | 大小 | 最后修改 | 状态 | 主要导出 | 技术标签 | 自述 |\n`;
  md += `|------|------|------|---------|------|----------|----------|------|\n`;
  for (const file of catFiles.sort((a, b) => a.path.localeCompare(b.path))) {
    const probe = probeFile(file.fullPath);
    const exportsStr = probe.exports.slice(0, 5).join(', ') || '-';
    const sizeKB = (file.size / 1024).toFixed(1) + 'KB';
    const status = classifyStatus(file.path, services);
    const tags = probe.tags.join(', ') || '-';
    const desc = probe.selfDesc[0] || '-';
    md += `| ${file.path} | ${probe.lineCount} | ${sizeKB} | ${file.modified} | ${status} | ${exportsStr} | ${tags} | ${desc} |\n`;
  }
  md += '\n';
}

// Key module details
md += `---\n\n## 关键模块详情\n\n`;
const keyModulePatterns = [
  '*-server.mjs', 'server.mjs', 'smart-router.mjs', 'database.mjs', 'db-adapter.mjs',
  'task-store.mjs', 'agent-worker.mjs', 'knowledge-db.mjs', 'embedding-cache.mjs',
  'gateway-connector.mjs',
];
// Also include worker/, modules/, lib/ key files
const keyFiles = files.filter(f => {
  const name = basename(f.path);
  if (keyModulePatterns.some(p => {
    if (p.startsWith('*')) return name.endsWith(p.slice(1));
    return name === p;
  })) return true;
  if (f.path.startsWith('worker/') || f.path.startsWith('modules/') || f.path.startsWith('lib/')) return true;
  if (f.path.startsWith('services/') && f.path.endsWith('.mjs')) return true;
  return false;
}).filter(f => f.path.endsWith('.mjs'));

for (const file of keyFiles) {
  const probe = probeFile(file.fullPath);
  const status = classifyStatus(file.path, services);
  md += `### ${file.path}${status ? ` ${status}` : ''}\n\n`;
  if (probe.selfDesc.length > 0) {
    md += `> ${probe.selfDesc.join(' ')}\n\n`;
  }
  md += `- **行数**：${probe.lineCount}\n`;
  md += `- **导出**：${probe.exports.join(', ') || '无'}\n`;
  md += `- **技术标签**：${probe.tags.join(', ') || '无'}\n`;
  if (probe.imports.length > 0) {
    md += `- **依赖**：\n`;
    for (const imp of probe.imports.slice(0, 8)) {
      md += `  - \`${imp}\`\n`;
    }
  }
  md += '\n';
}

// Quick facts (all dynamic)
md += `---\n\n`;
md += generateQuickFacts(services, files);

md += `---\n\n*本文件由 \`update-architecture-map.mjs\` v3.0 自动生成。所有事实均为运行时探测结果。*\n`;

// Write
writeFileSync(OUTPUT_FILE, md, 'utf-8');
console.log(`[${ts()}] Written ${OUTPUT_FILE} (${md.split('\n').length} lines, ${(md.length / 1024).toFixed(1)}KB)`);
try {
  writeFileSync(BACKUP_FILE, md, 'utf-8');
  console.log(`[${ts()}] Backup written to ${BACKUP_FILE}`);
} catch (e) {
  console.log(`[${ts()}] Backup write failed: ${e.message}`);
}
console.log(`[${ts()}] Done.`);
