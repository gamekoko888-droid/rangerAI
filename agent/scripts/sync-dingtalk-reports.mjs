import { fork } from "child_process";
import { loadAllEnvironments } from '../lib/bootstrap.mjs';
loadAllEnvironments();
import https from 'https';
import { initAdapter, run, queryOne, getDbType } from '../db-adapter.mjs';
import { logger } from '../lib/logger.mjs';

const APP_KEY = process.env.DINGTALK_CLIENT_ID;
const APP_SECRET = process.env.DINGTALK_CLIENT_SECRET.trim();

async function request(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken() {
  const res = await request(`https://oapi.dingtalk.com/gettoken?appkey=${APP_KEY}&appsecret=${APP_SECRET}`);
  if (res.errcode !== 0) throw new Error('Token Error: ' + JSON.stringify(res));
  return res.access_token;
}

async function fetchReports(token, days = 1) {
  const endDate = new Date();
  const startDate = new Date(endDate - days * 86400000);
  let cursor = 0;
  let all = [];

  while (true) {
    const res = await request(`https://oapi.dingtalk.com/topapi/report/list?access_token=${token}`, 'POST', {
      start_time: startDate.getTime(),
      end_time: endDate.getTime(),
      cursor: cursor,
      size: 100
    });
    if (!res.result || !res.result.data_list) break;
    all = all.concat(res.result.data_list);
    if (!res.result.has_more) break;
    cursor = res.result.next_cursor;
  }
  return all;
}

async function sync() {
  try {
    await initAdapter();
    const token = await getAccessToken();
    const reports = await fetchReports(token, 2); // Sync last 2 days
    
    logger.info(`[Sync] Starting sync of ${reports.length} reports`);
    
    for (const r of reports) {
      
      const reportDate = new Date(r.create_time).toISOString().split('T')[0];
      const params = [
        r.report_id, r.creator_id, r.creator_name, r.template_name, 
        r.dept_name || '', JSON.stringify(r.contents), 
        new Date(r.create_time).toISOString().replace('T', ' ').slice(0, 19), 
        new Date(r.modified_time).toISOString().replace('T', ' ').slice(0, 19), 
        reportDate,
        // fallback for legacy schema
        r.creator_name
      ];

      const isMySQL = getDbType() === 'mysql';
      
      if (isMySQL) {
        await run(`
          INSERT INTO dingtalk_reports 
          (report_id, creator_id, creator_name, template_name, dept_name, contents, create_time, modified_time, report_date, reporter_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE 
          modified_time = VALUES(modified_time),
          contents = VALUES(contents),
          synced_at = CURRENT_TIMESTAMP
        `, params);
      } else {
        // SQLite upsert
        await run(`
          INSERT INTO dingtalk_reports 
          (report_id, creator_id, creator_name, template_name, dept_name, contents, create_time, modified_time, report_date, reporter_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(report_id) DO UPDATE SET
          modified_time = excluded.modified_time,
          contents = excluded.contents,
          synced_at = CURRENT_TIMESTAMP
        `, params);
      }

    }
    
    logger.info(`[Sync] Completed successfully`);
    
    // Iter-64: Trigger auto-analysis after sync
    const analyzerPath = "/opt/rangerai-agent/scripts/analyze-today-reports.mjs";
    const child = fork(analyzerPath);
    child.on('exit', () => {
      logger.info("[Sync] Auto-analysis completed");
      process.exit(0);
    });
  } catch (e) {
    logger.error(`[Sync] Failed: ${e.message}`);
    process.exit(1);
  }
}

sync();
