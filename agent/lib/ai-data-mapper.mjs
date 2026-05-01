import crypto from 'crypto';
/**
 * ai-data-mapper.mjs — 零配置 AI 数据摄食引擎
 *
 * 核心能力：
 *   1. 接收任意文件（Excel/CSV/PDF/Word）
 *   2. 提取内容摘要（表头 + 前10行样本）
 *   3. 调用 LLM 理解数据类型和列映射
 *   4. 自动分发写入对应数据库表
 *   5. 返回结构化摄食报告
 *
 * 支持的目标表：
 *   - kol_weekly_stats    KOL周绩效数据
 *   - daily_metrics       日度业务指标
 *   - inventory_items     库存数据
 *   - kols                KOL基础信息
 *   - tickets             工单数据
 *   - knowledge_docs      通用知识文档
 */

import { query as dbQuery, run as dbRun } from '../db-adapter.mjs';
import { chunkText, estimateTokens } from './rag-utils.mjs';
import { createKnowledgeDoc } from '../knowledge-db.mjs';
import { callDirectAPI } from '../llm-gateway.mjs';
import { parseBuffer } from './file-parser.mjs';
import { logger } from './logger.mjs';
import https from 'https';
// ─── Markdown 专用解析器 ──────────────────────────────────────
function parseMarkdownTables(text) {
  const tables = [];
  const codeBlocks = [];
  const sections = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Code blocks (``` ... ```)
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      codeBlocks.push({ language: lang, code: codeLines.join('\n') });
      continue;
    }
    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      sections.push({ level: headingMatch[1].length, title: headingMatch[2].trim() });
      i++;
      continue;
    }
    // Pipe tables
    if (line.includes('|') && line.trim().startsWith('|')) {
      const parseRow = (l) => l.split('|').slice(1, -1).map(c => c.trim());
      const headerCells = parseRow(line);
      if (i + 1 < lines.length && /^\|[\s\-:|]+\|/.test(lines[i + 1])) {
        i += 2; // skip header + separator
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        tables.push({ headers: headerCells, rows });
        continue;
      }
    }
    i++;
  }
  return { tables, codeBlocks, sections };
}


// ─── 直接调用 Anthropic API（直连 API）────────
async function callAnthropicDirect(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 数据库表 Schema 描述（给 LLM 看的） ────────────────────

// ─── 关键词列映射（LLM降级时使用）────────────────────────────

const KEYWORD_COLUMN_MAPS = {
  kol_weekly_stats: {
    kol_name:      ['kol名称','kol姓名','达人名称','达人','主播','博主','名称','name'],
    platform:      ['平台','platform'],
    week_start:    ['周开始','week start','开始日期','起始'],
    week_end:      ['周结束','week end','结束日期','截止'],
    gmv:           ['gmv','销售额','营收','revenue','成交额','本周gmv'],
    orders:        ['订单量','订单数','orders','单量','成交量','本周订单'],
    roi:           ['roi','回报率','投产比'],
    cost:          ['成本','花费','投入','cost','投入成本'],
    new_followers: ['新增粉丝','涨粉','followers','粉丝增量','新粉'],
    views:         ['播放量','浏览量','views','曝光量'],
    notes:         ['备注','notes'],
  },
  inventory_items: {
    sku:           ['sku','商品编码','编码'],
    product_name:  ['产品名称','商品名称','product','名称'],
    quantity:      ['数量','库存量','quantity','库存'],
    unit_cost:     ['单价','成本价','unit cost','cost'],
    supplier:      ['供应商','supplier'],
    category:      ['类别','category','分类'],
  },
  daily_metrics: {
    metric_date:   ['日期','date'],
    category:      ['类别','category','业务类型'],
    metric_key:    ['指标','metric','指标名'],
    metric_value:  ['值','value','数值','金额'],
    unit:          ['单位','unit'],
    region:        ['地区','region'],
  },
};

function autoMapColumns(headers, table) {
  const map = KEYWORD_COLUMN_MAPS[table] || {};
  const result = {};
  for (const [targetField, keywords] of Object.entries(map)) {
    for (let i = 0; i < headers.length; i++) {
      const h = (headers[i] || '').toLowerCase().trim();
      if (keywords.some(k => h.includes(k) || k.includes(h))) {
        if (!Object.values(result).includes(targetField)) {
          result[String(i)] = targetField;
          break;
        }
      }
    }
  }
  return result;
}

const SCHEMA_DESCRIPTIONS = `
可用数据库表：

1. kol_weekly_stats — KOL周绩效数据
   字段：kol_name(KOL名称), platform(平台), week_start(周开始日期), week_end(周结束日期),
         gmv(销售额/成交额), orders(订单量), roi(投资回报率%), cost(投入成本),
         new_followers(新增粉丝), views(播放量/浏览量), clicks(点击量),
         conversions(转化量), content_count(内容/视频数量), notes(备注)
   适用：KOL工作表、达人数据、主播数据、博主绩效

2. inventory_items — 库存数据
   字段：sku(商品编码), product_name(产品名称), category(分类), platform(平台),
         region(地区), quantity(数量/库存量), unit_cost(单价/成本价),
         total_value(总价值), safety_stock(安全库存/预警量), supplier(供应商),
         last_restocked(最近补货日期), notes(备注)
   适用：库存盘点表、SKU数据、商品数量

3. daily_metrics — 日度业务指标
   字段：metric_date(日期), category(业务类别), metric_key(指标名称),
         metric_value(数值), metric_text(文字描述), unit(单位), region(地区)
   适用：业务数据报表、营收数据、订单统计、KPI表格

4. kols — KOL基础信息
   字段：name(姓名/账号), platform(平台), handle(账号ID), followers(粉丝数),
         engagement_rate(互动率%), category(类别), country(国家), language(语言),
         contact_email(邮箱), status(状态), cooperation_status(合作状态), notes(备注)
   适用：KOL名单、达人联系方式、主播信息

5. tickets — 工单数据
   字段：title(标题), description(描述), status(状态), priority(优先级),
         category(类别), customer_name(客户名), customer_platform(平台)
   适用：客服工单、问题反馈、售后记录

6. knowledge_docs — 知识文档（纯文本内容）
   字段：title(标题), content(内容), category(分类), tags(标签)
   适用：规则文档、产品手册、FAQ、公告、任何非结构化文本
`;

// ─── LLM 分析提示词 ──────────────────────────────────────────

function buildAnalysisPrompt(filename, headers, sampleRows, rawText) {
  const headerStr = headers.length > 0
    ? `表头（列名）：${headers.join(' | ')}`
    : `（无明显表头）`;

  const sampleStr = sampleRows.slice(0, 5).map((row, i) =>
    `第${i + 1}行：${Array.isArray(row) ? row.slice(0, 8).join(' | ') : String(row).slice(0, 200)}`
  ).join('\n');

  const textSample = rawText ? rawText.slice(0, 800) : '';

  return `你是游侠出海内部数据摄食系统的 AI 分析器。

用户上传了文件：${filename}

${headerStr}

数据样本：
${sampleStr}

${textSample ? `原始文本片段：\n${textSample}` : ''}

${SCHEMA_DESCRIPTIONS}

请分析这份数据，然后以 JSON 格式回答：
{
  "dataType": "表格数据/文本文档/混合",
  "confidence": 0-100,
  "summary": "用一句话描述这份数据是什么",
  "targets": [
    {
      "table": "目标表名",
      "reason": "为什么写入这个表",
      "columnMapping": {
        "源列名或数组下标(数字)": "目标字段名",
        ...
      },
      "staticValues": {
        "写死的字段名": "写死的值（比如 platform='TikTok'）",
        ...
      }
    }
  ],
  "warnings": ["潜在问题或注意事项"],
  "skipReason": "如果不适合写入任何表，说明原因（否则留空）"
}

注意：
- targets 可以包含多个目标表（一份文件可以同时写多个表）
- columnMapping 里的 key 是原始列名（字符串）或列下标（数字，从0开始）
- 如果文件是纯文字文档，用 knowledge_docs 表
- 必须输出合法 JSON，不要加任何解释文字`;
}

// ─── 解析 LLM 的 JSON 输出 ───────────────────────────────────

function parseLLMResponse(content) {
  try {
    // 提取 JSON 块
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('未找到 JSON');
    return JSON.parse(match[0]);
  } catch (e) {
    logger.warn('[ai-data-mapper] LLM JSON 解析失败:', e.message);
    return null;
  }
}

// ─── 按映射写入行数据 ─────────────────────────────────────────

async function writeRows({ table, rows, headers, columnMapping, staticValues }) {
  let inserted = 0, skipped = 0, errors = [];

  for (const row of rows) {
    // 构建字段值对象
    const record = { ...staticValues };

    for (const [sourceKey, targetField] of Object.entries(columnMapping)) {
      let val;
      if (/^\d+$/.test(String(sourceKey))) {
        // 数字下标
        val = Array.isArray(row) ? row[parseInt(sourceKey)] : undefined;
      } else {
        // 列名
        if (Array.isArray(row)) {
          const idx = headers.indexOf(sourceKey);
          val = idx >= 0 ? row[idx] : undefined;
        } else {
          val = row[sourceKey];
        }
      }
      if (val !== undefined && val !== null && val !== '') {
        record[targetField] = String(val).trim();
      }
    }

    // 自动推断日期字段默认值
    const today = new Date().toISOString().split('T')[0];
    if (table === 'kol_weekly_stats') {
      if (!record.week_start) record.week_start = today;
      if (!record.week_end) record.week_end = today;
      if (!record.kol_name) { skipped++; continue; }
      // 数字类型转换
      ['gmv','roi','cost'].forEach(f => { if (record[f]) record[f] = parseFloat(record[f]) || 0; });
      ['orders','new_followers','views','clicks','conversions','content_count'].forEach(f => {
        if (record[f]) record[f] = parseInt(record[f]) || 0;
      });
    }
    if (table === 'inventory_items') {
      if (!record.sku && !record.product_name) { skipped++; continue; }
      if (!record.sku) record.sku = record.product_name;
      if (!record.recorded_date) record.recorded_date = today;
      record.quantity = parseInt(record.quantity) || 0;
      record.unit_cost = parseFloat(record.unit_cost) || 0;
      record.total_value = record.quantity * record.unit_cost;
    }
    if (table === 'daily_metrics') {
      if (!record.metric_key) { skipped++; continue; }
      if (!record.metric_date) record.metric_date = today;
      if (!record.category) record.category = 'general';
      if (record.metric_value) record.metric_value = parseFloat(record.metric_value) || null;
    }
    if (table === 'kols') {
      if (!record.name) { skipped++; continue; }
      if (!record.platform) record.platform = 'unknown';
      if (record.followers) record.followers = parseInt(record.followers) || 0;
      if (record.engagement_rate) record.engagement_rate = parseFloat(record.engagement_rate) || 0;
    }
    if (table === 'knowledge_docs') {
      if (!record.content && !record.title) { skipped++; continue; }
      if (!record.title) record.title = '导入文档';
      if (!record.category) record.category = 'imported';
    }

    // 构建 INSERT 语句
    const fields = Object.keys(record);
    const values = Object.values(record);
    const placeholders = fields.map(() => '?').join(',');

    try {
      await dbRun(
        `INSERT OR REPLACE INTO ${table} (${fields.join(',')}) VALUES (${placeholders})`,
        values
      );
      inserted++;
    } catch (e) {
      errors.push(e.message.slice(0, 80));
      skipped++;
    }
  }

  return { inserted, skipped, errors: [...new Set(errors)].slice(0, 3) };
}

// ─── 主函数：零配置摄食 ───────────────────────────────────────

export async function ingestFile({ buffer, filename, mimeType, uploadedBy }) {
  const startTime = Date.now();
  logger.info(`[ai-data-mapper] 开始摄食: ${filename}`);

  // 1. 解析文件内容
  let parsed;
  try {
    parsed = await parseBuffer(buffer, filename, mimeType);
  } catch (e) {
    return { success: false, error: `文件解析失败: ${e.message}` };
  }

  // 提取表头和行数据
  let headers = [];
  let dataRows = [];
  let rawText = '';

  const rawLines = (parsed.text || '').split('\n').filter(Boolean);
  // 检测是否为表格型数据（有逗号或制表符分隔）
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  const isMarkdownFile = ext === 'md' || ext === 'markdown';
  const firstLine = rawLines[0] || '';
  const isTabular = firstLine.includes(',') || firstLine.includes('\t');
  const isBinaryExcel = ['spreadsheet','excel'].includes(parsed.type);
  let mdParsed = null; // Markdown 解析结果
  if (isMarkdownFile) {
    // ── Markdown 专用路径 ──
    mdParsed = parseMarkdownTables(parsed.text || '');
    rawText = (parsed.text || '').slice(0, 3000);
    // 如果 Markdown 中有表格，提取最大的表格作为结构化数据
    if (mdParsed.tables.length > 0) {
      const biggest = mdParsed.tables.reduce((a, b) => b.rows.length > a.rows.length ? b : a, mdParsed.tables[0]);
      headers = biggest.headers;
      dataRows = biggest.rows;
      logger.info(`[ai-data-mapper] Markdown 表格提取: ${headers.length} 列, ${dataRows.length} 行`);
    } else {
      dataRows = rawLines;
    }
  } else if (isBinaryExcel || (isTabular && rawLines.length >= 2)) {
    // 表格数据：提取表头和行
    const sep = firstLine.includes('\t') ? '\t' : ',';
    headers = firstLine.split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
    dataRows = rawLines.slice(1).map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, '')));
  } else {
    // 非结构化文本（PDF/Word/纯文本）
    rawText = (parsed.text || '').slice(0, 3000);
    dataRows = rawLines;
  }

  // 2. 调用 LLM 分析
  const prompt = buildAnalysisPrompt(filename, headers, dataRows, rawText);
  let llmResult;
  try {
    // 优先用直连 API（GPT-5.4），失败则 fallback 到 Anthropic 直连
    let content;
    try {
      const resp = await callDirectAPI({ message: prompt, taskType: 'reasoning' });
      content = resp.content;
    } catch (apiErr) {
      logger.warn('[ai-data-mapper] Direct API 失败，fallback 到 Anthropic 直连:', apiErr.message);
      content = await callAnthropicDirect(prompt);
    }
    llmResult = parseLLMResponse(content);
  } catch (e) {
    logger.warn('[ai-data-mapper] LLM 调用失败，使用关键词降级:', e.message);
    llmResult = null;
  }

  // 3a. LLM 成功但 columnMapping 可能为空或用列名，做补充校对
  if (llmResult && llmResult.targets) {
    for (const target of llmResult.targets) {
      if (!target.columnMapping) target.columnMapping = {};
      // 如果 LLM 给了列名映射，把列名转为下标（更可靠）
      const remapped = {};
      for (const [src, dst] of Object.entries(target.columnMapping)) {
        if (/^\d+$/.test(String(src))) {
          remapped[src] = dst; // 已是下标，保留
        } else {
          // 按列名查找下标
          const idx = headers.findIndex(h => h.toLowerCase().trim() === String(src).toLowerCase().trim());
          if (idx >= 0) remapped[String(idx)] = dst;
          else remapped[src] = dst; // 找不到就保留原名，writeRows 会按名查
        }
      }
      // 如果 LLM 的映射太少（< 2个字段），用关键词映射补充
      if (Object.keys(remapped).length < 2 && autoMapColumns) {
        const autoMap = autoMapColumns(headers, target.table);
        target.columnMapping = Object.keys(remapped).length > 0 ? { ...autoMap, ...remapped } : autoMap;
      } else {
        target.columnMapping = remapped;
      }
    }
  }

  // 3. LLM 失败时降级到关键词匹配
  if (!llmResult) {
    const h = headers.join(' ').toLowerCase();
    const kolScore = ['kol','达人','主播','roi','gmv'].filter(k => h.includes(k)).length;
    const invScore = ['sku','库存','quantity','supplier'].filter(k => h.includes(k)).length;
    const metScore = ['指标','metric','日期','数值'].filter(k => h.includes(k)).length;

    if (kolScore >= 2) {
      llmResult = { dataType: '表格数据', confidence: 60, summary: 'KOL绩效数据（关键词匹配）',
        targets: [{ table: 'kol_weekly_stats', reason: '包含KOL相关列',
          columnMapping: autoMapColumns(headers, 'kol_weekly_stats'), staticValues: {} }],
        warnings: ['AI分析失败，使用关键词降级匹配'], skipReason: '' };
    } else if (invScore >= 2) {
      llmResult = { dataType: '表格数据', confidence: 60, summary: '库存数据（关键词匹配）',
        targets: [{ table: 'inventory_items', reason: '包含库存相关列',
          columnMapping: autoMapColumns(headers, 'inventory_items'), staticValues: {} }],
        warnings: ['AI分析失败，使用关键词降级匹配'], skipReason: '' };
    } else {
      llmResult = { dataType: '文本文档', confidence: 50, summary: '未能识别结构，作为知识文档存储',
        targets: [{ table: 'knowledge_docs', reason: '无法识别为结构化数据', columnMapping: {}, staticValues: { content: rawText || dataRows.join('\n'), title: filename } }],
        warnings: ['AI分析失败，作为文档存入知识库'], skipReason: '' };
    }
  }

  // 4. 写入数据库
  const results = [];
  for (const target of (llmResult.targets || [])) {
    if (!target.table) continue;

    let writeResult;
    if (target.table === 'knowledge_docs' && rawText) {
      // 知识文档：切块后逐块写入，每块自动触发向量化
      try {
        const fullText = rawText || dataRows.join('\n');
        const chunks = chunkText(fullText, { maxTokens: 2000, overlapTokens: 200 });
        let chunkInserted = 0;
        for (let i = 0; i < chunks.length; i++) {
          const chunkTitle = chunks.length === 1
            ? (target.staticValues?.title || filename)
            : `${target.staticValues?.title || filename} [${i+1}/${chunks.length}]`;
          await createKnowledgeDoc({
            title: chunkTitle,
            description: '',
            category: target.staticValues?.category || 'imported',
            tags: filename,
            fileName: filename,
            filePath: '',
            fileSize: 0,
            mimeType: mimeType || 'text/plain',
            content: chunks[i].text || chunks[i],
            uploadedBy: uploadedBy || 'system',
          });
          chunkInserted++;
        }
        writeResult = { inserted: chunkInserted, skipped: 0, errors: [], chunks: chunks.length };
      } catch (e) {
        writeResult = { inserted: 0, skipped: 1, errors: [e.message] };
      }
    } else if (dataRows.length > 0) {
      writeResult = await writeRows({
        table: target.table,
        rows: dataRows,
        headers,
        columnMapping: target.columnMapping || {},
        staticValues: target.staticValues || {},
      });
    } else {
      writeResult = { inserted: 0, skipped: 0, errors: ['无数据行'] };
    }

    results.push({ table: target.table, reason: target.reason, ...writeResult });
  }

  
  // 4.5 Markdown 代码块：单独存入知识库
  if (mdParsed && mdParsed.codeBlocks.length > 0) {
    for (let ci = 0; ci < mdParsed.codeBlocks.length; ci++) {
      const block = mdParsed.codeBlocks[ci];
      try {
        await createKnowledgeDoc({
          title: `${filename} - 代码块 ${ci + 1}${block.language ? ' (' + block.language + ')' : ''}`,
          description: `从 Markdown 文件 ${filename} 中提取的代码块`,
          category: 'code',
          tags: [filename, block.language || 'code'].filter(Boolean).join(','),
          fileName: filename,
          filePath: '',
          fileSize: block.code.length,
          mimeType: 'text/plain',
          content: block.code,
          uploadedBy: uploadedBy || 'system',
        });
        results.push({ table: 'knowledge_docs', reason: `代码块 ${ci + 1} (${block.language || 'text'})`, inserted: 1, skipped: 0, errors: [] });
      } catch (e) {
        logger.warn('[ai-data-mapper] Markdown 代码块写入失败:', e.message);
      }
    }
  }
  // 5. 写入上传记录
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const mappedTables = results.map(r => r.table).join(',');
  try {
    await dbRun(
      `INSERT INTO data_uploads (filename, file_type, uploaded_by, row_count, mapped_tables, status, ai_mapping) VALUES (?,?,?,?,?,?,?)`,
      [filename, mimeType || 'unknown', uploadedBy || 'system', dataRows.length, mappedTables, 'success', JSON.stringify(llmResult)]
    );
  } catch (e) {
    logger.warn('[ai-data-mapper] 上传记录写入失败:', e.message);
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[ai-data-mapper] 完成: ${filename} → ${mappedTables} (${totalInserted}行, ${elapsed}ms)`);

  return {
    success: true,
    filename,
    aiAnalysis: {
      dataType: llmResult.dataType,
      confidence: llmResult.confidence,
      summary: llmResult.summary,
      warnings: llmResult.warnings || [],
    },
    results,
    totalRows: dataRows.length,
    totalInserted,
    mappedTables: mappedTables.split(',').filter(Boolean),
    elapsedMs: elapsed,
    markdownPreview: mdParsed ? { tables: mdParsed.tables, codeBlocks: mdParsed.codeBlocks, sections: mdParsed.sections, rawText: (parsed.text || '').slice(0, 2000) } : undefined,
  };
}
