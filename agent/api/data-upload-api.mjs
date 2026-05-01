/**
 * data-upload-api.mjs — 零配置 AI 数据摄食接口 v2
 *
 * 端点：
 *   POST /api/data/upload          上传任意文件，AI 自动识别并写入对应模块
 *   GET  /api/data/upload/history  上传历史
 *   GET  /api/data/upload/tables   支持的目标表说明
 *   GET  /api/data/upload/preview  预览最近上传数据（按表）
 */

import { query as dbQuery } from '../db-adapter.mjs';
import { sendJson } from '../lib/http-utils.mjs'; // Iter-N: migrated from database.mjs
import { ingestFile } from '../lib/ai-data-mapper.mjs';
import { logger } from '../lib/logger.mjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let deps = {};
export function init(d) { deps = d; }

// ─── 主路由 ──────────────────────────────────────────────────

export async function handle(req, res) {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  if (!urlPath.startsWith('/api/data/')) return false;

  // GET /api/data/upload/tables
  if (urlPath === '/api/data/upload/tables' && method === 'GET') {
    return sendJson(res, 200, {
      success: true,
      data: [
        { table: 'kol_weekly_stats', desc: 'KOL周绩效', keywords: ['KOL名称','GMV','ROI','订单量','粉丝'] },
        { table: 'inventory_items',  desc: '库存数据',   keywords: ['SKU','数量','库存','供应商','单价'] },
        { table: 'daily_metrics',    desc: '日度指标',   keywords: ['指标','日期','数值','营收','订单'] },
        { table: 'kols',             desc: 'KOL基础信息', keywords: ['达人','主播','平台','粉丝数','联系方式'] },
        { table: 'tickets',          desc: '工单数据',   keywords: ['工单','客服','售后','问题'] },
        { table: 'knowledge_docs',   desc: '知识文档',   keywords: ['规则','手册','公告','说明','任意文本'] },
      ],
      hint: '无需定义格式，AI 会自动识别文件类型和列映射',
    });
  }

  // GET /api/data/upload/history
  if (urlPath === '/api/data/upload/history' && method === 'GET') {
    const rows = await dbQuery(
      'SELECT id, filename, file_type, uploaded_by, row_count, mapped_tables, status, created_at FROM data_uploads ORDER BY created_at DESC LIMIT 30'
    );
    return sendJson(res, 200, { success: true, data: rows });
  }

  // GET /api/data/upload/preview?table=kol_weekly_stats
  if (urlPath === '/api/data/upload/preview' && method === 'GET') {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const table = params.get('table') || 'kol_weekly_stats';
    const allowedTables = ['kol_weekly_stats','inventory_items','daily_metrics'];
    if (!allowedTables.includes(table)) {
      return sendJson(res, 400, { success: false, error: '不支持的表' });
    }
    const rows = await dbQuery(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 20`);
    return sendJson(res, 200, { success: true, data: rows, table });
  }

  // POST /api/data/upload
  if (urlPath === '/api/data/upload' && method === 'POST') {
    return new Promise((resolve) => {
      let body = Buffer.alloc(0);
      req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
      req.on('end', async () => {
        try {
          const contentType = req.headers['content-type'] || '';

          // ── multipart/form-data 上传 ──────────────────────
          if (contentType.includes('multipart/form-data')) {
            const boundary = contentType.split('boundary=')[1]?.trim();
            if (!boundary) {
              sendJson(res, 400, { success: false, error: '缺少 boundary' });
              return resolve();
            }

            const boundaryBuf = Buffer.from('--' + boundary);
            let filename = `upload_${Date.now()}`;
            let fileBuffer = null;
            let fileMime = 'application/octet-stream';
            let start = 0;

            while (start < body.length) {
              const idx = body.indexOf(boundaryBuf, start);
              if (idx === -1) break;
              const nextIdx = body.indexOf(boundaryBuf, idx + boundaryBuf.length);
              if (nextIdx === -1) break;
              const part = body.slice(idx + boundaryBuf.length, nextIdx);
              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd === -1) { start = nextIdx; continue; }
              const header = part.slice(0, headerEnd).toString();
              const content = part.slice(headerEnd + 4, part.length - 2);
              if (header.includes('filename=')) {
                const m = header.match(/filename="([^"]+)"/);
                if (m) filename = m[1];
                const mimeMatch = header.match(/Content-Type:\s*([^\r\n]+)/);
                if (mimeMatch) fileMime = mimeMatch[1].trim();
                fileBuffer = content;
              }
              start = nextIdx;
            }

            if (!fileBuffer || fileBuffer.length === 0) {
              sendJson(res, 400, { success: false, error: '未找到文件内容' });
              return resolve();
            }

            const ext = path.extname(filename).toLowerCase();
            const allowed = ['.xlsx', '.xls', '.csv', '.pdf', '.doc', '.docx', '.txt', '.md'];
            if (!allowed.includes(ext)) {
              sendJson(res, 400, { success: false, error: `不支持的文件格式，支持: ${allowed.join(' ')}` });
              return resolve();
            }

            const uploadedBy = req.user?.username || req.user?.displayName || 'unknown';
            const result = await ingestFile({
              buffer: fileBuffer,
              filename,
              mimeType: fileMime || `application/${ext.slice(1)}`,
              uploadedBy,
            });

            return sendJson(res, result.success ? 200 : 422, result);
          }

          // ── application/json（手动指定数据，用于测试）──────
          if (contentType.includes('application/json')) {
            const payload = JSON.parse(body.toString());
            if (!payload.content || !payload.filename) {
              sendJson(res, 400, { success: false, error: '需要 content 和 filename 字段' });
              return resolve();
            }
            const result = await ingestFile({
              buffer: Buffer.from(payload.content),
              filename: payload.filename,
              mimeType: 'text/csv',
              uploadedBy: req.user?.username || 'api',
            });
            return sendJson(res, result.success ? 200 : 422, result);
          }

          sendJson(res, 400, { success: false, error: '请使用 multipart/form-data 上传文件' });
          resolve();
        } catch (e) {
          logger.error('[data-upload-api] 处理失败:', e);
          sendJson(res, 500, { success: false, error: e.message });
          resolve();
        }
      });
    });
  }

  return false;
}
