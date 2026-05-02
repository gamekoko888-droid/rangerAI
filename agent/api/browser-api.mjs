/**
 * api/browser-api.mjs — Browser Takeover API (v1.0)
 *
 * Manages browser takeover state for the headed browser.
 * When a user takes over, AI browser operations are paused.
 * When the user returns control, AI can resume browser operations.
 *
 * Endpoints:
 *   GET  /api/browser/status   — Current browser & takeover state
 *   POST /api/browser/takeover — User requests browser control
 *   POST /api/browser/return   — User returns control to AI
 *   GET  /api/browser/vnc-token — Generate short-lived VNC access token
 *
 * State is kept in-memory (single server instance).
 * Takeover events are broadcast via WS to all connected clients.
 */
import { logger } from "../lib/logger.mjs";
import { ts } from "../modules/helpers.mjs";
import crypto from "crypto";
import http from "http";
import { browserNavigate, browserScreenshot, browserExtractText, browserClick, browserInput, browserScroll, getPoolStatus } from "../worker/browser-service.mjs";

// ─── In-Memory Takeover State ────────────────────────────────
const state = {
  isTakenOver: false,
  takenOverBy: null,     // userId or sessionId
  takenOverAt: null,     // timestamp
  browserRunning: true,  // assume browser is running
};

// VNC tokens: Map<token, { userId, expiresAt }>
const vncTokens = new Map();
const VNC_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

let deps = {};

/**
 * Initialize with shared dependencies.
 */
export function init(dependencies) {
  deps = dependencies;
  logger.info(`[${ts()}] [browser-api] Initialized v1.0`);
}

/**
 * Check if browser is currently in headed mode and accessible.
 */
async function checkBrowserHealth() {
  try {
    // Check CDP endpoint
    const resp = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      return { running: true, userAgent: data["User-Agent"], webSocketDebuggerUrl: data.webSocketDebuggerUrl };
    }
  } catch (e) {
    // CDP not responding
  }
  return { running: false };
}

/**
 * Check VNC/noVNC service health.
 */
async function checkVncHealth() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port: 6080, path: "/", method: "GET", timeout: 3000 }, (res) => {
      resolve({ running: true, port: 6080 });
    });
    req.on("error", () => resolve({ running: false }));
    req.on("timeout", () => { req.destroy(); resolve({ running: false }); });
    req.end();
  });
}

/**
 * Broadcast takeover state change to all WS clients.
 */
function broadcastTakeoverState(eventType) {
  const { wsClients, sendEvent } = deps;
  if (!wsClients || !sendEvent) return;

  const payload = {
    type: "browser_takeover",
    event: eventType, // "takeover" | "return" | "status"
    isTakenOver: state.isTakenOver,
    takenOverBy: state.takenOverBy,
    takenOverAt: state.takenOverAt,
  };

  // Broadcast to all connected WS clients
  if (wsClients instanceof Map) {
    for (const [, ws] of wsClients) {
      try { sendEvent(ws, payload); } catch (e) { /* ignore dead connections */ }
    }
  }
}

/**
 * Handle browser API routes.
 * @returns {boolean} true if route was handled
 */

function ensureBrowserRole(req, res) {
  const role = String(req.headers["x-user-role"] || "").toLowerCase();
  if (role !== "admin" && role !== "manager") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "browser tools require admin/manager role" }));
    return false;
  }
  return true;
}

export async function handleBrowserApi(req, res, urlPath) {
  // GET /api/browser/status
  if (urlPath === "/api/browser/status" && req.method === "GET") {
    try {
      const [browser, vnc] = await Promise.all([checkBrowserHealth(), checkVncHealth()]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        browser: { ...browser, headed: true },
        vnc,
        takeover: {
          isTakenOver: state.isTakenOver,
          takenOverBy: state.takenOverBy,
          takenOverAt: state.takenOverAt,
        },
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // POST /api/browser/takeover
  if (urlPath === "/api/browser/takeover" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const userId = parsed.userId || req.headers["x-user-id"] || "anonymous";

      if (state.isTakenOver && state.takenOverBy !== userId) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: "Browser is already taken over by another user",
          takenOverBy: state.takenOverBy,
        }));
        return true;
      }

      state.isTakenOver = true;
      state.takenOverBy = userId;
      state.takenOverAt = Date.now();

      logger.info(`[${ts()}] [browser-api] Browser takeover by user: ${userId}`);
      broadcastTakeoverState("takeover");

      // Generate a VNC access token
      const token = crypto.randomBytes(16).toString("hex");
      vncTokens.set(token, { userId, expiresAt: Date.now() + VNC_TOKEN_TTL_MS });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        takeover: {
          isTakenOver: true,
          takenOverBy: userId,
          takenOverAt: state.takenOverAt,
        },
        vncToken: token,
        vncUrl: `/vnc/vnc_embed.html?path=vnc/websockify`,
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // POST /api/browser/return
  if (urlPath === "/api/browser/return" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const userId = parsed.userId || req.headers["x-user-id"] || "anonymous";

      if (!state.isTakenOver) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Browser is not currently taken over" }));
        return true;
      }

      logger.info(`[${ts()}] [browser-api] Browser returned by user: ${userId} (was taken by: ${state.takenOverBy})`);

      state.isTakenOver = false;
      state.takenOverBy = null;
      state.takenOverAt = null;

      // Invalidate all VNC tokens for this user
      for (const [token, info] of vncTokens) {
        if (info.userId === userId) vncTokens.delete(token);
      }

      broadcastTakeoverState("return");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        takeover: { isTakenOver: false, takenOverBy: null, takenOverAt: null },
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // GET /api/browser/vnc-token — validate or generate VNC token
  if (urlPath === "/api/browser/vnc-token" && req.method === "GET") {
    try {
      // Clean expired tokens
      const now = Date.now();
      for (const [token, info] of vncTokens) {
        if (info.expiresAt < now) vncTokens.delete(token);
      }

      // Only allow token generation if browser is taken over
      if (!state.isTakenOver) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Browser must be taken over first" }));
        return true;
      }

      const token = crypto.randomBytes(16).toString("hex");
      const userId = state.takenOverBy || "anonymous";
      vncTokens.set(token, { userId, expiresAt: now + VNC_TOKEN_TTL_MS });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, token, expiresIn: VNC_TOKEN_TTL_MS / 1000 }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // ─── [R14-T2] Browser Tool MVP Endpoints ───

  // POST /api/browser/navigate
  if (urlPath === "/api/browser/navigate" && req.method === "POST") {
    if (!ensureBrowserRole(req, res)) return true;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const { url, sessionId } = parsed;
      if (!url) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "url is required" }));
        return true;
      }
      const sid = sessionId || `api-${Date.now()}`;
      const result = await browserNavigate(sid, url);
      res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.success, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // POST /api/browser/screenshot
  if (urlPath === "/api/browser/screenshot" && req.method === "POST") {
    if (!ensureBrowserRole(req, res)) return true;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const { sessionId, fullPage } = parsed;
      const sid = sessionId || `api-${Date.now()}`;
      const result = await browserScreenshot(sid, { fullPage: !!fullPage });
      res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.success, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // POST /api/browser/extract-text
  if (urlPath === "/api/browser/extract-text" && req.method === "POST") {
    if (!ensureBrowserRole(req, res)) return true;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const { sessionId, selector } = parsed;
      const sid = sessionId || `api-${Date.now()}`;
      const result = await browserExtractText(sid, selector);
      res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.success, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // POST /api/browser/click
  if (urlPath === "/api/browser/click" && req.method === "POST") {
    if (!ensureBrowserRole(req, res)) return true;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const { sessionId, selector } = parsed;
      if (!selector) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "selector is required" }));
        return true;
      }
      const sid = sessionId || `api-${Date.now()}`;
      const result = await browserClick(sid, selector);
      res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.success, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }


  if (urlPath === "/api/browser/input" && req.method === "POST") {
    if (!ensureBrowserRole(req, res)) return true;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const { sessionId, selector, text } = parsed;
      const sid = sessionId || `api-${Date.now()}`;
      const result = await browserInput(sid, selector, text);
      res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.success, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  if (urlPath === "/api/browser/scroll" && req.method === "POST") {
    if (!ensureBrowserRole(req, res)) return true;
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const { sessionId, direction, amount } = parsed;
      const sid = sessionId || `api-${Date.now()}`;
      const result = await browserScroll(sid, direction, amount);
      res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.success, ...result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  // GET /api/browser/pool-status
  if (urlPath === "/api/browser/pool-status" && req.method === "GET") {
    try {
      const status = getPoolStatus();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...status }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return true;
  }

  return false;
}
