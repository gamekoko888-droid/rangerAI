/**
 * tiktok-api.mjs — TikTok Partners & Market API (DI-refactored)
 *
 * Dependency-injected module for TikTok partner management,
 * script generation, and market price monitoring.
 *
 * Dependencies injected via init():
 *   - ctx.db.query, ctx.db.run   (database access via DI context)
 *   - ctx.db.parseJsonBody        (request body parsing)
 *   - ctx.db.sendJson             (response helper)
 *
 * @version 2.0.0 — DI-refactored (Iter-49)
 */

import { logger } from './lib/logger.mjs';
import { ts } from './modules/helpers.mjs';
import { validateDeps } from './lib/context.mjs';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

// ─── Library DB (TK Dashboard) ──────────────────────────────
const LIBRARY_DB_PATH = '/home/admin/.openclaw/workspace/data/library.db';

function getLibraryDb() {
  return new Database(LIBRARY_DB_PATH, { readonly: true });
}

// ─── Injected Dependencies ──────────────────────────────────
const REQUIRED_DEPS = ['ctx'];
let deps = {};

/**
 * Initialize with shared dependencies.
 * @param {Object} dependencies - Must include { ctx }
 */
export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'tiktok-api');
  deps = dependencies;
}

/**
 * Handle TikTok API requests. Returns true if handled.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleTiktokApi(req, res) {
  const { ctx } = deps;
  const method = req.method;
  const urlPath = req.url?.split('?')[0] || '';

  // Only handle /api/tiktok/* and /api/stats/market-prices
  if (!urlPath.startsWith('/api/tiktok') && !urlPath.startsWith('/api/stats/market-prices') && urlPath !== '/api/system/inspection-logs') {
    return false;
  }

  try {
    // --- GET /api/tiktok/partners ---
    if (urlPath === '/api/tiktok/partners' && method === 'GET') {
      const partners = await ctx.db.query('SELECT * FROM tiktok_partners ORDER BY last_update DESC');
      ctx.db.sendJson(res, 200, { success: true, count: partners.length, data: partners });
      return true;
    }

    // --- GET /api/tiktok/partners/:id ---
    const partnerMatch = urlPath.match(/^\/api\/tiktok\/partners\/(\d+)$/);
    if (partnerMatch && method === 'GET') {
      const partner = await ctx.db.query('SELECT * FROM tiktok_partners WHERE id = ?', [partnerMatch[1]]);
      if (!partner || partner.length === 0) {
        ctx.db.sendJson(res, 404, { error: '合作伙伴不存在' });
        return true;
      }
      ctx.db.sendJson(res, 200, { success: true, data: partner[0] });
      return true;
    }

    // --- POST /api/tiktok/partners ---
    if (urlPath === '/api/tiktok/partners' && method === 'POST') {
      const body = await ctx.db.parseJsonBody(req);
      const { kol_handle, country, game_category, sharing_ratio, base_fee, milestone_stage, store_url, bank_info } = body;

      if (!kol_handle || !country) {
        ctx.db.sendJson(res, 400, { error: 'kol_handle 和 country 为必填字段' });
        return true;
      }

      const sql = `INSERT INTO tiktok_partners (kol_handle, country, game_category, sharing_ratio, base_fee, milestone_stage, store_url, bank_info) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      await ctx.db.run(sql, [
        kol_handle,
        country,
        game_category || null,
        sharing_ratio || 0,
        base_fee || 0,
        milestone_stage || 'contacted',
        store_url || null,
        bank_info || null
      ]);

      logger.info(`[${ts()}] [tiktok-api] Partner added: @${kol_handle} (${country})`);
      ctx.db.sendJson(res, 201, { success: true, message: '合作伙伴添加成功' });
      return true;
    }

    // --- PUT /api/tiktok/partners/:id ---
    if (partnerMatch && method === 'PUT') {
      const body = await ctx.db.parseJsonBody(req);
      const fields = [];
      const values = [];

      const allowedFields = ['kol_handle', 'country', 'game_category', 'sharing_ratio', 'base_fee', 'milestone_stage', 'store_url', 'bank_info'];
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          fields.push(`${field} = ?`);
          values.push(body[field]);
        }
      }

      if (fields.length === 0) {
        ctx.db.sendJson(res, 400, { error: '没有需要更新的字段' });
        return true;
      }

      values.push(partnerMatch[1]);
      const sql = `UPDATE tiktok_partners SET ${fields.join(', ')}, last_update = CURRENT_TIMESTAMP WHERE id = ?`;
      await ctx.db.run(sql, values);

      logger.info(`[${ts()}] [tiktok-api] Partner updated: id=${partnerMatch[1]}`);
      ctx.db.sendJson(res, 200, { success: true, message: '合作伙伴更新成功' });
      return true;
    }

    // --- DELETE /api/tiktok/partners/:id ---
    if (partnerMatch && method === 'DELETE') {
      await ctx.db.run('DELETE FROM tiktok_partners WHERE id = ?', [partnerMatch[1]]);
      logger.info(`[${ts()}] [tiktok-api] Partner deleted: id=${partnerMatch[1]}`);
      ctx.db.sendJson(res, 200, { success: true, message: '合作伙伴已删除' });
      return true;
    }

    // --- GET /api/tiktok/milestones ---
    if (urlPath === '/api/tiktok/milestones' && method === 'GET') {
      const milestones = [
        { id: 1, title: "美区加白进度 (WL)", deadline: "2026-03-25", status: "waiting_approval", weight: 80 },
        { id: 2, title: "东南亚 DC 上线", deadline: "2026-04-15", status: "developing", weight: 30 },
        { id: 3, title: "直播间搭建", deadline: "2026-03-20", status: "on_track", weight: 95 }
      ];
      ctx.db.sendJson(res, 200, { success: true, data: milestones });
      return true;
    }

    // --- GET /api/tiktok/stats ---
    if (urlPath === '/api/tiktok/stats' && method === 'GET') {
      const totalPartners = await ctx.db.query('SELECT COUNT(*) as count FROM tiktok_partners');
      const activePartners = await ctx.db.query("SELECT COUNT(*) as count FROM tiktok_partners WHERE milestone_stage = 'active'");
      const byCountry = await ctx.db.query('SELECT country, COUNT(*) as count FROM tiktok_partners GROUP BY country ORDER BY count DESC');
      const byStage = await ctx.db.query('SELECT milestone_stage, COUNT(*) as count FROM tiktok_partners GROUP BY milestone_stage');
      const avgRatio = await ctx.db.query('SELECT AVG(sharing_ratio) as avg_ratio FROM tiktok_partners WHERE sharing_ratio > 0');

      ctx.db.sendJson(res, 200, {
        success: true,
        data: {
          total: totalPartners[0]?.count || 0,
          active: activePartners[0]?.count || 0,
          byCountry,
          byStage,
          avgSharingRatio: avgRatio[0]?.avg_ratio || 0
        }
      });
      return true;
    }

    // --- POST /api/tiktok/generate-script ---
    if (urlPath === '/api/tiktok/generate-script' && method === 'POST') {
      const body = await ctx.db.parseJsonBody(req);
      const { game, country, tone, duration, target } = body;

      if (!game || !country) {
        ctx.db.sendJson(res, 400, { error: 'game 和 country 为必填字段' });
        return true;
      }

      const durationSec = duration || 30;
      const scriptTone = tone || '幽默悬念';

      const scripts = [
        {
          style: "Hook-First (悬念开头)",
          duration: `${durationSec}s`,
          hook: `Wait... did ${game} just drop THIS?! 🤯`,
          content: `[0-3s] Hook: "No way... ${game} players in ${country} are going CRAZY over this!"\n[3-8s] 痛点: "Everyone's struggling to get enough in-game currency..."\n[8-20s] 方案: "But I found the CHEAPEST way to top up — saves you 30% instantly!"\n[20-${durationSec}s] CTA: "Link in bio 👆 Don't miss this deal before it's gone!"`,
          tags: [`#${game.replace(/\s/g, '')}`, '#gamingtips', '#topup', '#savemoney', `#${country.toLowerCase()}`]
        },
        {
          style: "Review (测评种草)",
          duration: `${durationSec}s`,
          hook: `The BEST ${game} meta this March 🔥`,
          content: `[0-3s] Hook: "I tested every top-up platform for ${game}..."\n[3-8s] 对比: "Platform A: expensive. Platform B: slow. But THIS one..."\n[8-20s] 展示: "Instant delivery, best prices, and they even have exclusive deals!"\n[20-${durationSec}s] CTA: "Check the link — you'll thank me later 💰"`,
          tags: [`#${game.replace(/\s/g, '')}`, '#review', '#gaming', '#deals']
        },
        {
          style: "Story (故事型)",
          duration: `${durationSec}s`,
          hook: `POV: You just discovered the ${game} secret 🎮`,
          content: `[0-3s] Hook: "POV: Your friend asks how you always have max currency in ${game}..."\n[3-8s] 故事: "I used to spend SO much... until I found this hack"\n[8-20s] 揭秘: "It's not a cheat — it's just the smartest way to top up in ${country}"\n[20-${durationSec}s] CTA: "Save 30%+ on every purchase. Link in bio! 🔗"`,
          tags: [`#${game.replace(/\s/g, '')}`, '#pov', '#gamerhack', '#topupsecret']
        }
      ];

      logger.info(`[${ts()}] [tiktok-api] Script generated for: ${game} (${country}), tone: ${scriptTone}`);
      ctx.db.sendJson(res, 200, { success: true, game, country, tone: scriptTone, duration: durationSec, data: scripts });
      return true;
    }

    // --- GET /api/stats/market-prices ---
    if (urlPath === '/api/stats/market-prices' && method === 'GET') {
      const priceData = [
        { game: "绝区零", currency: "星芒", our_price: 4.99, competitor_price: 5.49, competitor: "U7BUY", region: "US", updated_at: new Date().toISOString() },
        { game: "原神", currency: "创世结晶", our_price: 14.99, competitor_price: 16.99, competitor: "U7BUY", region: "US", updated_at: new Date().toISOString() },
        { game: "MLBB", currency: "钻石", our_price: 1.99, competitor_price: 2.29, competitor: "U7BUY", region: "ID", updated_at: new Date().toISOString() },
        { game: "Free Fire", currency: "钻石", our_price: 0.99, competitor_price: 1.19, competitor: "Codashop", region: "BR", updated_at: new Date().toISOString() },
        { game: "PUBG Mobile", currency: "UC", our_price: 0.89, competitor_price: 0.99, competitor: "Midasbuy", region: "SEA", updated_at: new Date().toISOString() },
        { game: "Honkai Star Rail", currency: "星琼", our_price: 9.99, competitor_price: 11.49, competitor: "U7BUY", region: "US", updated_at: new Date().toISOString() },
      ];

      const summary = {
        total_games: priceData.length,
        avg_savings_pct: Math.round(priceData.reduce((sum, p) => sum + ((p.competitor_price - p.our_price) / p.competitor_price * 100), 0) / priceData.length),
        best_deal: priceData.reduce((best, p) => {
          const savings = (p.competitor_price - p.our_price) / p.competitor_price * 100;
          return savings > best.savings ? { game: p.game, savings: Math.round(savings) } : best;
        }, { game: '', savings: 0 })
      };

      ctx.db.sendJson(res, 200, { success: true, data: priceData, summary });
      return true;
    }

    // ─── TK Dashboard API (library.db) ──────────────────────

    // --- GET /api/tiktok/dashboard/accounts ---
    if (urlPath === '/api/tiktok/dashboard/accounts' && method === 'GET') {
      const db = getLibraryDb();
      try {
        const accounts = db.prepare('SELECT * FROM tk_accounts ORDER BY region, username').all();
        ctx.db.sendJson(res, 200, { success: true, count: accounts.length, data: accounts });
      } finally { db.close(); }
      return true;
    }

    // --- GET /api/tiktok/dashboard/snapshots?username=xxx ---
    if (urlPath.startsWith('/api/tiktok/dashboard/snapshots') && method === 'GET') {
      const urlObj = new URL(req.url, 'http://localhost');
      const username = urlObj.searchParams.get('username');
      const db = getLibraryDb();
      try {
        let rows;
        if (username) {
          rows = db.prepare('SELECT * FROM tk_account_snapshots WHERE username=? ORDER BY pulled_at DESC LIMIT 30').all(username);
        } else {
          rows = db.prepare('SELECT * FROM tk_account_snapshots ORDER BY pulled_at DESC LIMIT 100').all();
        }
        ctx.db.sendJson(res, 200, { success: true, count: rows.length, data: rows });
      } finally { db.close(); }
      return true;
    }

    // --- GET /api/tiktok/dashboard/videos?username=xxx&limit=50 ---
    if (urlPath.startsWith('/api/tiktok/dashboard/videos') && method === 'GET') {
      const urlObj = new URL(req.url, 'http://localhost');
      const username = urlObj.searchParams.get('username');
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const db = getLibraryDb();
      try {
        let rows;
        if (username) {
          rows = db.prepare('SELECT * FROM tk_account_videos WHERE username=? ORDER BY upload_date DESC LIMIT ?').all(username, limit);
        } else {
          rows = db.prepare('SELECT * FROM tk_account_videos ORDER BY upload_date DESC LIMIT ?').all(limit);
        }
        ctx.db.sendJson(res, 200, { success: true, count: rows.length, data: rows });
      } finally { db.close(); }
      return true;
    }

    // --- GET /api/tiktok/dashboard/stats ---
    if (urlPath === '/api/tiktok/dashboard/stats' && method === 'GET') {
      const db = getLibraryDb();
      try {
        const accountCount = db.prepare('SELECT COUNT(*) as c FROM tk_accounts').get().c;
        const videoCount = db.prepare('SELECT COUNT(*) as c FROM tk_account_videos').get().c;
        const snapshotCount = db.prepare('SELECT COUNT(*) as c FROM tk_account_snapshots').get().c;
        const byRegion = db.prepare('SELECT region, COUNT(*) as count FROM tk_accounts GROUP BY region ORDER BY count DESC').all();
        const byGame = db.prepare('SELECT game, COUNT(*) as count FROM tk_accounts GROUP BY game ORDER BY count DESC').all();
        const topVideos = db.prepare('SELECT username, title, view_count, like_count FROM tk_account_videos ORDER BY view_count DESC LIMIT 10').all();
        ctx.db.sendJson(res, 200, {
          success: true,
          data: { accountCount, videoCount, snapshotCount, byRegion, byGame, topVideos }
        });
      } finally { db.close(); }
      return true;
    }

    // --- GET /api/tiktok/dashboard/analyses?status=xxx&limit=50 ---
    if (urlPath.startsWith('/api/tiktok/dashboard/analyses') && method === 'GET') {
      const urlObj = new URL(req.url, 'http://localhost');
      const status = urlObj.searchParams.get('status');
      const account = urlObj.searchParams.get('account');
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const db = getLibraryDb();
      try {
        let sql = 'SELECT id, tiktok_url, account, video_type, view_count, like_count, upload_date, title, analysis_status, created_at FROM video_analyses WHERE 1=1';
        const params = [];
        if (status) { sql += ' AND analysis_status=?'; params.push(status); }
        if (account) { sql += ' AND account=?'; params.push(account); }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        const rows = db.prepare(sql).all(...params);
        ctx.db.sendJson(res, 200, { success: true, count: rows.length, data: rows });
      } finally { db.close(); }
      return true;
    }

    // ─── End TK Dashboard API ────────────────────────────────

    // --- GET /api/system/inspection-logs (fixed: was unreachable in v1) ---
    if (urlPath === '/api/system/inspection-logs' && method === 'GET') {
      const logs = [
        { date: "2026-03-08", project: "TikTok-US", event: "店铺资料提交", status: "PENDING", progress: 10, note: "已进入待审队列" },
        { date: "2026-03-09", project: "TikTok-US", event: "补交授权文件", status: "PROCESSING", progress: 15, note: "一级授权需求已响应" },
        { date: "2026-03-10", project: "TikTok-US", event: "授权终审中", status: "WAITING", progress: 20, note: "等待 3/25 节点决策" }
      ];
      ctx.db.sendJson(res, 200, { success: true, count: logs.length, data: logs });
      return true;
    }

  } catch (err) {
    logger.error(`[${ts()}] [tiktok-api] Error: ${err.message}`);
    ctx.db.sendJson(res, 500, { error: 'Internal server error', message: err.message });
    return true;
  }

  return false;
}
