/**
 * lib/bootstrap.mjs — Environment loading + dynamic module imports
 *
 * Extracted from server.mjs (Iter-6.2).
 * Handles:
 *   1. loadEnvFile() / loadSecretsJson() — .env and secrets.json loading
 *   2. loadBootstrap() — dynamic import of auth with fallback
 *
 * v25.10 (TD-038): Removed dynamic import of monitor.mjs and rate-limiter.mjs.
 * Both modules were archived in v25.8 and the dynamic imports only produced
 * startup noise ("Monitor module not available" / "RateLimiter module not available").
 * The fallback no-op objects are now the default — no import attempt, no log noise.
 */
import { logger } from '../lib/logger.mjs';
import fs from "fs";
// ─── Env Loaders ────────────────────────────────────────────
export function loadEnvFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    logger.warn(`[warn] Failed to load env file ${filePath}: ${e.message}`);
  }
}
export function loadSecretsJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    logger.warn(`[warn] Failed to load secrets json ${filePath}: ${e.message}`);
    return {};
  }
}
// ─── Dynamic Module Loader (auth only) ──────────────────────
/**
 * Load auth with graceful fallback.
 * monitor and rateLimiter are provided as static no-op defaults
 * (original modules archived, no longer dynamically imported).
 * Returns { auth, monitor, rateLimiter }
 */
export async function loadBootstrap(ts) {
  let auth;
  try {
    const authMod = await import("../auth.mjs");
    auth = authMod.default || authMod.auth;
    logger.info(`[${ts()}] [server] Auth module loaded (ADMIN_TOKEN: ${auth.ADMIN_TOKEN.slice(0, 4)}..., WS_TOKEN: ${auth.WS_TOKEN ? "configured" : "none"})`);
  } catch (e) {
    logger.error(`[${ts()}] [server] CRITICAL: Auth module failed to load: ${e.message}`);
    auth = {
      injectSecurityHeaders(req, res) {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
      },
      setCorsHeaders(req, res) {
        res.setHeader("Access-Control-Allow-Origin", "https://ranger.voyage");
        return true;
      },
      validateAdminToken() { return false; },
      validateWsToken() { return { valid: false, reason: "auth_module_unavailable" }; },
      isAdminPath(url) { return url?.startsWith("/admin"); },
      isHealthPath(url) { return url === "/health"; },
      isAllowedOrigin(origin) { return origin === "https://ranger.voyage"; },
      ADMIN_TOKEN: "DISABLED",
      WS_TOKEN: "DISABLED",
    };
    logger.error(`[${ts()}] [server] Auth fallback: FAIL-CLOSED mode active`);
  }
  // Static no-op defaults (monitor.mjs and rate-limiter.mjs archived in v25.8)
  const monitor = {
    recordTask() {},
    recordConnection() {},
    recordMessage() {},
    recordPreSearch() {},
    recordCacheHit() {},
    recordFallback() {},
    recordTokens() {},
    getMetrics() { return { error: "not loaded" }; },
    getStatus() { return {}; },
  };
  const rateLimiter = {
    checkConnection() { return { allowed: true }; },
    addConnection() {},
    removeConnection() {},
    checkMessage() { return { allowed: true }; },
    recordMessage() {},
    completeTask() {},
    getStatus() { return {}; },
  };
  return { auth, monitor, rateLimiter };
}
export function loadAllEnvironments() {
  const RANGERAI_ENV_FILE = process.env.RANGERAI_ENV_FILE || "/opt/rangerai-agent/.env";
  const RANGERAI_SECRETS_FILE = process.env.RANGERAI_SECRETS_FILE || "/opt/rangerai-agent/agent-secrets.env";
  loadEnvFile(RANGERAI_ENV_FILE);
  loadEnvFile(RANGERAI_SECRETS_FILE);
  const RANGERAI_SECRETS_JSON = process.env.RANGERAI_SECRETS_JSON || "/opt/rangerai-agent/secrets.json";
  const SECRETS = loadSecretsJson(RANGERAI_SECRETS_JSON);
  for (const [key, val] of Object.entries(SECRETS)) {
    if (process.env[key] === undefined && typeof val === "string") {
      process.env[key] = val;
    }
  }
  return SECRETS;
}
