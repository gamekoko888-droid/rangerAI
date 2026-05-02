// modules/browser-api.mjs — HTTP API routes for browser service management
// Q6: Exposes browser pool status and admin controls via REST endpoints
// Requires admin/manager role for all operations
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// Lazy import browser-service to avoid circular deps
let _browserService = null;
async function getBrowserService() {
  if (!_browserService) {
    try {
      _browserService = await import('../worker/browser-service.mjs');
    } catch (e) {
      logger.error(`[${ts()}] [browser-api] Failed to import browser-service: ${e.message}`);
      return null;
    }
  }
  return _browserService;
}

/**
 * Register browser API routes on the HTTP server.
 * @param {Function} registerRoute - Route registration function (method, path, handler)
 */
export function registerBrowserRoutes(registerRoute) {
  // GET /api/browser/status — Pool status (admin/manager only)
  registerRoute('GET', '/api/browser/status', async (req, res, { user }) => {
    if (!user || !['admin', 'manager'].includes(user.role)) {
      return { status: 403, body: { error: 'Forbidden: admin/manager only' } };
    }
    const svc = await getBrowserService();
    if (!svc) {
      return { status: 503, body: { error: 'Browser service unavailable' } };
    }
    const status = svc.getPoolStatus ? svc.getPoolStatus() : { error: 'getPoolStatus not available' };
    return { status: 200, body: status };
  });

  // POST /api/browser/navigate — Direct browser navigation (admin/manager only)
  registerRoute('POST', '/api/browser/navigate', async (req, res, { user, body }) => {
    if (!user || !['admin', 'manager'].includes(user.role)) {
      return { status: 403, body: { error: 'Forbidden: admin/manager only' } };
    }
    const { url, sessionKey } = body || {};
    if (!url) {
      return { status: 400, body: { error: 'url is required' } };
    }
    const svc = await getBrowserService();
    if (!svc || !svc.browserNavigate) {
      return { status: 503, body: { error: 'Browser service unavailable' } };
    }
    try {
      const result = await svc.browserNavigate({ url, sessionKey: sessionKey || 'api-direct' });
      return { status: 200, body: result };
    } catch (e) {
      return { status: 500, body: { error: e.message } };
    }
  });

  // POST /api/browser/screenshot — Take screenshot (admin/manager only)
  registerRoute('POST', '/api/browser/screenshot', async (req, res, { user, body }) => {
    if (!user || !['admin', 'manager'].includes(user.role)) {
      return { status: 403, body: { error: 'Forbidden: admin/manager only' } };
    }
    const { url, sessionKey } = body || {};
    const svc = await getBrowserService();
    if (!svc || !svc.browserScreenshot) {
      return { status: 503, body: { error: 'Browser service unavailable' } };
    }
    try {
      const result = await svc.browserScreenshot({ url, sessionKey: sessionKey || 'api-direct' });
      return { status: 200, body: result };
    } catch (e) {
      return { status: 500, body: { error: e.message } };
    }
  });

  // POST /api/browser/shutdown — Shutdown all browser pages (admin only)
  registerRoute('POST', '/api/browser/shutdown', async (req, res, { user }) => {
    if (!user || user.role !== 'admin') {
      return { status: 403, body: { error: 'Forbidden: admin only' } };
    }
    const svc = await getBrowserService();
    if (!svc || !svc.shutdownAll) {
      return { status: 503, body: { error: 'Browser service unavailable' } };
    }
    try {
      await svc.shutdownAll();
      return { status: 200, body: { success: true, message: 'All browser pages closed' } };
    } catch (e) {
      return { status: 500, body: { error: e.message } };
    }
  });

  logger.info(`[${ts()}] [browser-api] Routes registered: /api/browser/{status,navigate,screenshot,shutdown}`);
}
