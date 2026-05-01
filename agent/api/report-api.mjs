// v6.1: Direct imports to fix missing init() call
import { query as dbQuery, queryOne as dbQueryOne } from "../db-adapter.mjs";
import { sendJson } from '../lib/http-utils.mjs'; // Iter-N: migrated from database.mjs
import { logger } from '../lib/logger.mjs';
import { validateDeps } from '../lib/context.mjs';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_MAP_PATH = path.join(__dirname, '../../.openclaw/workspace/memory/dingtalk_user_map.json');

const REQUIRED_DEPS = ['db'];
let deps = {};

export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'report-api');
  deps = dependencies;
  logger.info('[report-api] Initialized');
}

// 获取钉钉 access token
async function getDingtalkToken() {
  const clientId = process.env.DINGTALK_CLIENT_ID;
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('DINGTALK_CLIENT_ID 或 DINGTALK_CLIENT_SECRET 未配置');
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ appKey: clientId, appSecret: clientSecret });
    const options = {
      hostname: 'api.dingtalk.com',
      path: '/v1.0/oauth2/accessToken',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.accessToken) {
            resolve(parsed.accessToken);
          } else {
            reject(new Error(`获取 Token 失败: ${data}`));
          }
        } catch (e) {
          reject(new Error(`解析 Token 响应失败: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// 通过 access token 调用钉钉 API（GET）
async function dingtalkGet(accessToken, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const fullPath = qs ? `${path}?${qs}` : path;
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oapi.dingtalk.com',
      path: fullPath,
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`解析响应失败: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 通过 v1.0 API 调用（GET）
async function dingtalkV1Get(accessToken, apiPath, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const fullPath = qs ? `${apiPath}?${qs}` : apiPath;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.dingtalk.com',
      path: fullPath,
      method: 'GET',
      headers: { 'x-acs-dingtalk-access-token': accessToken }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`解析 v1 响应失败: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 读取本地用户映射表
function loadUserMap() {
  try {
    const content = fs.readFileSync(USER_MAP_PATH, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return {};
  }
}

// 通过姓名查找 userId（本地映射 + API 搜索）
async function findUserIdByName(accessToken, name) {
  // 先查本地映射
  const userMap = loadUserMap();
  if (userMap[name]) {
    return userMap[name];
  }

  // 通过 API 搜索
  try {
    const result = await dingtalkGet(accessToken, '/topapi/v2/user/getbymobile', {
      access_token: accessToken
    });
    // 如果没有手机号，通过部门遍历查找
    // 尝试通过姓名搜索
    const searchResult = await dingtalkGet(accessToken, '/topapi/search/user/get', {
      access_token: accessToken,
      search_key: name,
      offset: 0,
      count: 10
    });
    
    if (searchResult.result && searchResult.result.list) {
      const match = searchResult.result.list.find(u => u.name === name);
      if (match) return match.userid;
    }
  } catch (e) {
    logger.warn(`[report-api] 搜索用户失败: ${e.message}`);
  }

  return null;
}

// 拉取指定用户的日报
async function fetchMemberReports(accessToken, userId, startTime, endTime) {
  const reports = [];
  let cursor = 0;
  
  while (true) {
    const result = await dingtalkGet(accessToken, '/topapi/report/list', {
      access_token: accessToken,
      userid: userId,
      start_time: startTime,
      end_time: endTime,
      cursor,
      size: 20
    });

    if (result.result && result.result.data_list) {
      reports.push(...result.result.data_list);
      if (!result.result.has_more) break;
      cursor = result.result.next_cursor;
    } else {
      break;
    }
  }

  return reports;
}



function _normalizeReportRow(r) {
  const report_sender = r.creator_name || r.report_sender || r.reporter_name || r.author || '未知';
  
  let contentText = r.content || r.report_content || r.summary || '';
  if (r.contents && typeof r.contents === 'string') {
     try {
       const parsed = JSON.parse(r.contents);
       if (Array.isArray(parsed)) {
           contentText = parsed.map(p => "**" + p.key + "**\n" + p.value).join("\n\n");
       }
     } catch(e) { /* v22.0 */ console.error("[report-api] silent catch:", e?.message || e); }
  }

  const create_time = r.create_time || r.report_date || null;
  let report_date = r.report_date || null;
  if (!report_date && typeof create_time === 'string' && create_time.length >= 10) {
    report_date = create_time.slice(0, 10);
  }
  const template_name = r.template_name || r.team || r.dept_name || '日报';

  return {
    ...r,
    id: r.report_id || r.id,
    report_sender,
    reporter_name: report_sender,
    report_content: contentText,
    content: contentText,
    create_time,
    report_date,
    template_name,
  };
}

function _parseTimeMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0
}

export async function handleReportApi(req, res) {
  // v6.1: Use direct imports instead of deps.db (init was never called)
  const db = { query: dbQuery, queryOne: dbQueryOne, sendJson };
  let urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/report/')) urlPath = urlPath.replace('/api/report/', '/api/reports/');
  const method = req.method;

  if (urlPath === '/api/reports/dingtalk' && method === 'GET') {
    try {
      const urlObj = new URL('http://x' + urlPath + (req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
      const page = Math.max(1, parseInt(urlObj.searchParams.get('page') || '1'));
      const limit = Math.min(100, Math.max(1, parseInt(urlObj.searchParams.get('limit') || '20')));
      const offset = (page - 1) * limit;
      const totalRows = await db.query('SELECT COUNT(*) AS cnt FROM dingtalk_reports');
      const total = totalRows?.[0]?.cnt || 0;
      const rows = await db.query(
        `SELECT * FROM dingtalk_reports ORDER BY create_time DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      const data = (rows || []).map(_normalizeReportRow);
      db.sendJson(res, 200, { success: true, data, total, page, limit, totalPages: Math.ceil(total / limit) });
      return true;
    } catch (e) {
      db.sendJson(res, 500, { success: false, error: e.message });
      return true;
    }
  }
  
  if (urlPath === '/api/reports/dingtalk/stats' && method === 'GET') {
    try {
      // 为避免数据库方言差异（MySQL/SQLite）与列差异，这里用 JS 做统计聚合
      const rows = await db.query(`
        SELECT * FROM dingtalk_reports
        ORDER BY create_time DESC
        LIMIT 2000
      `);

      const now = Date.now();
      const cutoff = now - 1 * 24 * 60 * 60 * 1000;

      const counter = new Map();
      for (const raw of (rows || [])) {
        const r = _normalizeReportRow(raw);
        const t = _parseTimeMs(r.create_time);
        if (t && t < cutoff) continue;
        const key = r.template_name || '日报';
        counter.set(key, (counter.get(key) || 0) + 1);
      }

            
      const userCountRes = await db.query('SELECT COUNT(*) as cnt FROM users');
      const totalStaff = userCountRes && userCountRes[0] ? userCountRes[0].cnt : 100;
      
      const data = Array.from(counter.entries())
        .map(([template_name, count]) => ({ template_name, count }))
        .sort((a, b) => b.count - a.count);

      const totalSubmitted = data.reduce((sum, item) => sum + item.count, 0);
      
      db.sendJson(res, 200, { 
        success: true, 
        data, 
        submitted_count: totalSubmitted, 
        total_staff: totalStaff
      });
      return true;
    } catch (e) {
      db.sendJson(res, 500, { success: false, error: e.message });
      return true;
    }
  }



  // 新接口：按成员姓名查询钉钉日报
  if (urlPath === '/api/reports/dingtalk/member-reports' && method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const name = urlObj.searchParams.get('name');
      const days = parseInt(urlObj.searchParams.get('days') || '7', 10);

      if (!name) {
        db.sendJson(res, 400, { success: false, error: '缺少参数 name（成员姓名）' });
        return true;
      }

      // 先查数据库缓存
      try {
        const cachedAll = await db.query(
          `SELECT * FROM dingtalk_reports WHERE reporter_name = ? ORDER BY create_time DESC LIMIT 500`,
          [name]
        );
        const now = Date.now();
        const cutoff = now - days * 24 * 60 * 60 * 1000;
        const cached = (cachedAll || []).map(_normalizeReportRow).filter(r => {
          const t = _parseTimeMs(r.create_time);
          return !t || t >= cutoff;
        });
        if (cached.length > 0) {
          logger.info(`[report-api] 返回 ${name} 的 ${cached.length} 条缓存日报`);
          db.sendJson(res, 200, { success: true, source: 'cache', data: cached });
          return true;
        }
      } catch (dbErr) {
        logger.warn(`[report-api] 查询缓存失败: ${dbErr.message}`);
      }

      // 数据库无缓存，从钉钉 API 实时拉取
      const accessToken = await getDingtalkToken();
      const userId = await findUserIdByName(accessToken, name);

      if (!userId) {
        db.sendJson(res, 404, { 
          success: false, 
          error: `未找到成员「${name}」，请确认姓名是否正确或手动配置映射表` 
        });
        return true;
      }

      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;
      const reports = await fetchMemberReports(accessToken, userId, startTime, endTime);

      logger.info(`[report-api] 从钉钉 API 获取 ${name}(${userId}) 的 ${reports.length} 条日报`);
      db.sendJson(res, 200, { 
        success: true, 
        source: 'api',
        userId,
        name,
        data: reports 
      });
      return true;
    } catch (e) {
      logger.error(`[report-api] member-reports 错误: ${e.message}`);
      db.sendJson(res, 500, { success: false, error: e.message });
      return true;
    }
  }


  // 按姓名查 48H 内最新一条日报
  
  // == Iter-66: 日报异常问题聚合层 ==
  if (urlPath === '/api/reports/dingtalk/daily-issues' && method === 'GET') {
    try {
      const today = new Date().toISOString().split('T')[0];
      const issues = await db.query(
        `SELECT id, creator_name, template_name, issue_type, ai_summary, report_date 
         FROM dingtalk_reports 
         WHERE report_date = ? AND is_issue = 1 AND ai_summary IS NOT NULL 
         ORDER BY issue_type DESC`, 
         [today]
      );
      return sendJson(res, 200, { success: true, count: issues.length, data: issues });
    } catch (err) {
      return sendJson(res, 500, { success: false, error: err.message });
    }
  }

  if (urlPath === '/api/reports/dingtalk/member-last-report' && method === 'GET') {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const name = urlObj.searchParams.get('name');
      if (!name) { db.sendJson(res, 400, { error: '缺少 name 参数' }); return true; }
      const rows = await db.query(
        `SELECT create_time, content FROM dingtalk_reports WHERE reporter_name = ? ORDER BY create_time DESC LIMIT 1`,
        [name]
      );
      const row = rows && rows[0] ? _normalizeReportRow(rows[0]) : null;
      db.sendJson(res, 200, { success: true, name, create_time: row ? row.create_time : null, content: row ? (row.content || row.report_content) : null });
      return true;
    } catch (e) {
      db.sendJson(res, 500, { error: e.message });
      return true;
    }
  }


  // PageAgent 专用 API 代理 ( DashScope 中转 )
  if (urlPath === "/api/page-agent/proxy" && method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const apiKey = process.env.QWEN_API_KEY;
        const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: body
        });
        const data = await response.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return true;
  }

  // ─── GET /api/reports/dingtalk/daily-summary ─────────────────
  if (method === 'GET' && urlPath === '/api/reports/dingtalk/daily-summary') {
    try {
      const today = new Date().toISOString().slice(0, 10);

      const totalRows = await db.query(
        'SELECT COUNT(*) as total, SUM(is_issue) as issues FROM dingtalk_reports WHERE date(report_date) = ?',
        [today]
      );
      const { total, issues } = (Array.isArray(totalRows) ? totalRows[0] : totalRows) || { total: 0, issues: 0 };

      const reportList = await db.query(
        `SELECT id, creator_name, dept_name, template_name, is_issue, issue_type, ai_summary, report_date
         FROM dingtalk_reports WHERE date(report_date) = ?
         ORDER BY is_issue DESC, template_name, creator_name`,
        [today]
      );

      const healthScore = total > 0 ? Math.max(40, Math.round(100 - (issues / total) * 60)) : 100;

      // 花名册口径：按中心统计应交/已交/未交
      const rosterSql = `
        WITH roster AS (
          SELECT u.displayName as name,
            CASE
              WHEN u.department_id IN (SELECT id FROM departments WHERE name='金币组' OR name='腾讯组') THEN '豹量中心'
              WHEN d.parent_id = 'dept_v90qwm' OR u.department_id = 'dept_v90qwm' THEN '窜天猴中心'
              WHEN u.department_id = 'dept_mk1qs5' OR d.parent_id = 'dept_mk1qs5' THEN '豹量中心'
              WHEN u.department_id = 'dept_cqluwg' OR d.parent_id = 'dept_cqluwg' THEN '综合管理中心'
              ELSE NULL
            END as center
          FROM users u
          LEFT JOIN departments d ON d.id = u.department_id
          WHERE u.isActive=1 AND u.displayName != '' AND u.displayName IS NOT NULL
            AND u.displayName NOT LIKE '%@%'
            AND u.displayName NOT IN ('Joseph','Smoke Test User','auditor','客服小王','敏捷验收测试员')
        ),
        submitted AS (
          SELECT DISTINCT creator_name FROM dingtalk_reports WHERE date(report_date) = ?
        )
        SELECT
          r.center,
          COUNT(r.name) as total_staff,
          SUM(CASE WHEN s.creator_name IS NOT NULL THEN 1 ELSE 0 END) as submitted_count,
          GROUP_CONCAT(CASE WHEN s.creator_name IS NULL THEN r.name END, ',') as missing_names
        FROM roster r
        LEFT JOIN submitted s ON s.creator_name = r.name
        WHERE r.center IS NOT NULL
        GROUP BY r.center
        ORDER BY r.center
      `;
      const rosterRows = await db.query(rosterSql, [today]);
      const rosterArr = Array.isArray(rosterRows) ? rosterRows : [];

      // 构建中心汇总
      const centerMap = {};
      for (const row of rosterArr) {
        centerMap[row.center] = {
          center: row.center,
          totalStaff: Number(row.total_staff) || 0,
          submittedCount: Number(row.submitted_count) || 0,
          missingNames: row.missing_names ? row.missing_names.split(',').filter(Boolean) : [],
        };
        centerMap[row.center].submissionRate = centerMap[row.center].totalStaff > 0
          ? Math.round(centerMap[row.center].submittedCount / centerMap[row.center].totalStaff * 100)
          : 0;
      }

      // 昨日汇总（用于日度对比）
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yesterdayRows = await db.query(
        'SELECT COUNT(*) as total, SUM(is_issue) as issues FROM dingtalk_reports WHERE date(report_date) = ?',
        [yesterday]
      );
      const yd = (Array.isArray(yesterdayRows) ? yesterdayRows[0] : yesterdayRows) || { total: 0, issues: 0 };
      const yesterdayHealthScore = Number(yd.total) > 0
        ? Math.max(40, Math.round(100 - (Number(yd.issues) / Number(yd.total)) * 60))
        : 100;

      // 昨日花名册口径
      const ydRosterRows = await db.query(rosterSql, [yesterday]);
      const ydCenterMap = {};
      for (const row of (Array.isArray(ydRosterRows) ? ydRosterRows : [])) {
        ydCenterMap[row.center] = {
          center: row.center,
          totalStaff: Number(row.total_staff) || 0,
          submittedCount: Number(row.submitted_count) || 0,
          submissionRate: Number(row.total_staff) > 0
            ? Math.round(Number(row.submitted_count) / Number(row.total_staff) * 100) : 0,
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          date: today,
          summary: { total, issues, healthScore },
          yesterday: {
            date: yesterday,
            total: Number(yd.total) || 0,
            issues: Number(yd.issues) || 0,
            healthScore: yesterdayHealthScore,
            rosterCenters: Object.values(ydCenterMap),
          },
          rosterCenters: Object.values(centerMap),
          reports: Array.isArray(reportList) ? reportList : [],
        }
      }));
      return true;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
      return true;
    }
  }


  return false;
}
