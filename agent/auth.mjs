/**
 * auth.mjs — RangerAI Authentication & Security Module (v52)
 * 
 * Independent, fail-safe module. If this module fails to load,
 * server.mjs falls back to permissive mode (backwards compatible).
 * 
 * Features:
 * - WS connection token validation
 * - Admin endpoint Bearer token authentication
 * - CORS origin restriction
 * - Security headers injection
 */

import { logger } from './lib/logger.mjs';
import crypto from "crypto";

// ─── Configuration ──────────────────────────────────────────
// Admin token for /api/metrics, /api/tasks/active, /admin/* endpoints
// Can be set via ADMIN_TOKEN env var, or auto-generated on startup
// Try: env var -> persisted file -> auto-generate
import fs from "fs";
function readPersistedToken() {
  try {
    const token = fs.readFileSync("/opt/rangerai-agent/.admin-token", "utf8").trim();
    if (token) { logger.info("[auth] Loaded ADMIN_TOKEN from persisted file"); return token; }
  } catch(e) { /* file not found, generate new */ }
  return null;
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.RANGERAI_ADMIN_TOKEN || readPersistedToken() || generateToken();

// WS connection token — clients must pass ?token=xxx to connect
// Can be set via WS_TOKEN env var, or defaults to a simple shared secret
// WS_TOKEN must be set via environment variable - no weak defaults
const _envWsToken = process.env.WS_TOKEN || process.env.RANGERAI_WS_TOKEN;
if (!_envWsToken) {
  logger.warn("[SECURITY] WS_TOKEN not set! Auto-generating random token for this session.");
}
const WS_TOKEN = _envWsToken || crypto.randomBytes(32).toString("hex");

// Allowed origins for CORS
const ALLOWED_ORIGINS = new Set([
  "https://ranger.voyage",
  "http://ranger.voyage",
  "https://www.ranger.voyage",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // Same-origin requests have no Origin header
  if (ALLOWED_ORIGINS.has(origin)) return true;

  // v60: Removed trycloudflare.com (public tunnel service, security risk)
  return false;
}

function generateToken() {
  const token = crypto.randomBytes(16).toString("hex");
  logger.info(`[auth] Auto-generated ADMIN_TOKEN: ${token}`);
  // Persist token to file for Prometheus and next restart
  try {
    fs.writeFileSync("/opt/rangerai-agent/.admin-token", token, "utf8");
    logger.info("[auth] Persisted ADMIN_TOKEN to .admin-token file");
  } catch(e) { logger.warn("[auth] Failed to persist ADMIN_TOKEN: " + e.message); }
  return token;
}

// ─── Security Headers ───────────────────────────────────────
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // HSTS: 1 year, include subdomains
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// ─── Middleware Functions ────────────────────────────────────

/**
 * Inject security headers into HTTP response
 */
function injectSecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

/**
 * Set CORS headers based on request origin
 * Returns true if origin is allowed, false otherwise
 */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, "") || "";
  
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    return true;
  }
  
  // For disallowed origins, still set a restrictive CORS header
  res.setHeader("Access-Control-Allow-Origin", "https://ranger.voyage");
  return false;
}

/**
 * Validate admin Bearer token from Authorization header
 * Returns true if authenticated
 */
function validateAdminToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token === ADMIN_TOKEN;
}

/**
 * Validate WebSocket connection token from URL query params
 * Returns { valid: boolean, reason?: string }
 */
function validateWsToken(req, verifyTokenFn) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const token = url.searchParams.get("token");
    
    if (!token) {
      return { valid: false, reason: "missing_token" };
    }
    
    // Primary: verify as JWT token (user auth token from login)
    if (verifyTokenFn) {
      const payload = verifyTokenFn(token);
      if (payload && payload.userId) {
        return { valid: true, userId: payload.userId, username: payload.username, role: payload.role || 'member' };
      }
    }
    
    // Fallback: check against WS_TOKEN env var (for admin/system connections)
    if (WS_TOKEN && token === WS_TOKEN) {
      return { valid: true };
    }
    
    return { valid: false, reason: "invalid_token" };
  } catch (e) {
    // v60: Fail-closed on parse error (security hardening)
    logger.info(`[auth] WS token validation parse error: ${e.message}`);
    return { valid: false, reason: "parse_error" };
  }
}

/**
 * Check if a URL path requires admin authentication
 */
function isAdminPath(urlPath) {
  const adminPaths = [
    "/api/metrics",
    "/api/tasks/active",
    "/admin/restart-worker",
  ];
  return adminPaths.some(p => urlPath === p || urlPath.startsWith(p + "?"));
}

/**
 * Check if a URL path is a public health endpoint (limited info)
 */
function isHealthPath(urlPath) {
  return urlPath === "/health" || urlPath === "/health/";
}

// ─── Export ─────────────────────────────────────────────────
const auth = {
  ADMIN_TOKEN,
  WS_TOKEN,
  ALLOWED_ORIGINS,
  isAllowedOrigin,
  injectSecurityHeaders,
  setCorsHeaders,
  validateAdminToken,
  validateWsToken,
  isAdminPath,
  isHealthPath,
  SECURITY_HEADERS,
};

export default auth;
export { auth };
