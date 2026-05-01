/**
 * api/auth-api.mjs — Authentication & invite code REST endpoints.
 * Extracted from chat-api.mjs (Iter-52 Phase 2 split).
 *
 * Routes handled:
 *   POST   /api/auth/login
 *   POST   /api/auth/register
 *   GET    /api/auth/me
 *   POST   /api/auth/logout
 *   POST   /api/auth/invite-codes   (admin)
 *   GET    /api/auth/invite-codes   (admin)
 *   DELETE /api/auth/invite-codes/:id (admin)
 *
 * @module api/auth-api
 * @version 1.0.0
 */

import { logger } from '../lib/logger.mjs';
import { getPermissionsForRole, getModulesForRole, getDataScope, NAV_CONFIG, hasPermission } from "../modules/rbac.mjs";
import { validateDeps } from '../lib/context.mjs';

const REQUIRED_DEPS = ['db'];

/** @type {{ db: object }} */
let deps = {};

/**
 * Initialize auth-api with injected dependencies.
 * @param {object} dependencies
 */
export function init(dependencies) {
  validateDeps(REQUIRED_DEPS, dependencies, 'auth-api');
  deps = dependencies;
  logger.info('[auth-api] Initialized (v1.0.0)');
}

// ─── Login Rate Limiter (IP-based, 5 attempts per minute) ───
const loginAttempts = new Map(); // IP -> { count, resetAt }
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 60 * 1000;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
    return { allowed: true, remaining: LOGIN_RATE_LIMIT - 1 };
  }
  entry.count++;
  if (entry.count > LOGIN_RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }
  return { allowed: true, remaining: LOGIN_RATE_LIMIT - entry.count };
}

// Cleanup stale entries every 5 minutes
const _loginCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 5 * 60 * 1000);

/**
 * Handle /api/auth/* routes.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true if handled
 */
export async function handleAuthApi(req, res) {
  const { db } = deps;
  const urlPath = req.url.split('?')[0];
  const method = req.method;
  const ts = () => new Date().toISOString();

  try {
    // ─── POST /api/auth/login ───
    if (urlPath === '/api/auth/login' && method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      const rateCheck = checkLoginRateLimit(ip);
      if (!rateCheck.allowed) {
        logger.info(`[${ts()}] [auth-api] Login rate limited for IP: ${ip}`);
        res.setHeader('Retry-After', String(rateCheck.retryAfter));
        db.sendJson(res, 429, { error: `登录尝试次数过多，请 ${rateCheck.retryAfter} 秒后重试` });
        return true;
      }

      const body = await db.parseJsonBody(req);
      if (!body.username || !body.password) {
        db.sendJson(res, 400, { error: '用户名和密码不能为空' });
        return true;
      }

      if (body.username.length > 64 || body.password.length > 128) {
        db.sendJson(res, 400, { error: '输入长度超出限制' });
        return true;
      }
      const user = await db.authenticateUser(body.username, body.password);
      if (!user) {
        db.sendJson(res, 401, { error: '用户名或密码错误' });
        return true;
      }

      const token = await db.generateToken({ userId: user.id, username: user.username, role: user.role });
      logger.info(`[${ts()}] [auth-api] User logged in: ${user.username}`);
      db.sendJson(res, 200, { user, token });
      return true;
    }

    // ─── POST /api/auth/register ───
    if (urlPath === '/api/auth/register' && method === 'POST') {
      const body = await db.parseJsonBody(req);
      if (!body.username || !body.password || !body.inviteCode) {
        db.sendJson(res, 400, { error: '用户名、密码和邀请码都是必填的' });
        return true;
      }
      const result = await db.registerUser(body.username.trim(), body.password, body.inviteCode.trim());
      if (!result.success) {
        db.sendJson(res, 400, { error: result.error });
        return true;
      }
      const token = await db.generateToken({ userId: result.user.id, username: result.user.username, role: result.user.role });
      logger.info(`[${ts()}] [auth-api] New user registered: ${result.user.username}`);
      db.sendJson(res, 201, { user: result.user, token });
      return true;
    }

    // ─── GET /api/auth/me ───
    if (urlPath === '/api/auth/me' && method === 'GET') {
      const user = await db.extractUserFromRequest(req);
      if (!user) {
        db.sendJson(res, 401, { error: '未登录或 token 已过期' });
        return true;
      }
      // Enrich user response with RBAC permissions
      const role = user.role || 'member';
      const permissions = getPermissionsForRole(role);
      const modules = getModulesForRole(role);
      const dataScope = getDataScope(role);
      const nav = NAV_CONFIG.filter(item => hasPermission(role, item.permission));
      db.sendJson(res, 200, {
        user: {
          ...user,
          permissions,
          modules,
          dataScope,
        },
        nav,
      });
      return true;
    }

    // ─── POST /api/auth/logout ───
    if (urlPath === '/api/auth/logout' && method === 'POST') {
      db.sendJson(res, 200, { success: true });
      return true;
    }

    // ─── POST /api/auth/invite-codes (admin only) ───
    if (urlPath === '/api/auth/invite-codes' && method === 'POST') {
      const user = await db.extractUserFromRequest(req);
      if (!user || user.role !== 'admin') {
        db.sendJson(res, 403, { error: '仅管理员可以创建邀请码' });
        return true;
      }
      const body = await db.parseJsonBody(req);
      const maxUses = body.maxUses || 1;
      const expiresInDays = body.expiresInDays || 7;
      const role = body.role || 'member';
      let invite;
      try {
        invite = await db.createInviteCode(user.id, maxUses, expiresInDays, role);
      } catch (err) {
        db.sendJson(res, 400, { error: err.message });
        return true;
      }
      logger.info(`[${ts()}] [auth-api] Invite code created: ${invite.code} by ${user.username}`);
      db.sendJson(res, 201, invite);
      return true;
    }

    // ─── GET /api/auth/invite-codes (admin only) ───
    if (urlPath === '/api/auth/invite-codes' && method === 'GET') {
      const user = await db.extractUserFromRequest(req);
      if (!user || user.role !== 'admin') {
        db.sendJson(res, 403, { error: '仅管理员可以查看邀请码' });
        return true;
      }
      const codes = await db.getInviteCodes();
      db.sendJson(res, 200, { codes });
      return true;
    }

    // ─── DELETE /api/auth/invite-codes/:id (admin only) ───
    const inviteDeleteMatch = urlPath.match(/^\/api\/auth\/invite-codes\/(.+)$/);
    if (inviteDeleteMatch && method === 'DELETE') {
      const user = await db.extractUserFromRequest(req);
      if (!user || user.role !== 'admin') {
        db.sendJson(res, 403, { error: '仅管理员可以停用邀请码' });
        return true;
      }
      const deactivated = await db.deactivateInviteCode(inviteDeleteMatch[1]);
      if (!deactivated) {
        db.sendJson(res, 404, { error: '邀请码不存在' });
        return true;
      }
      db.sendJson(res, 200, { success: true });
      return true;
    }

    return false;

  } catch (err) {
    logger.error(`[${ts()}] [auth-api] Error: ${err.message}\n${err.stack}`);
    const statusCode = err.message === 'Invalid JSON' ? 400 : 500;
    const errorMsg = statusCode === 400 ? 'Invalid JSON in request body' : 'Internal server error';
    db.sendJson(res, statusCode, { error: errorMsg });
    return true;
  }
}

/**
 * Cleanup the login rate-limit cleanup timer.
 * Called during graceful shutdown.
 */
export function cleanupAuthApi() {
  clearInterval(_loginCleanupTimer);
}
