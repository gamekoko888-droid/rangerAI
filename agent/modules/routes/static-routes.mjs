/**
 * modules/routes/static-routes.mjs — Static & Proxy Routes (v1.0.0, Iter-53)
 *
 * Extracted from http-routes.mjs:
 *   - /admin/* (Admin UI static files)
 *   - /* (SPA static files)
 *   - /v1/chat/completions (Gateway proxy)
 */

import fs from "fs";
import { logger } from "../../lib/logger.mjs";
import path from "path";
import crypto from "crypto";

let deps = {};

export function init(dependencies) {
  deps = dependencies;
}

/**
 * Handle admin UI static files. Returns true if handled.
 */
export function handleAdminUI(req, res) {
  const ADMIN_ROOT = "/opt/rangerai-agent/dist/admin";
  let adminUrlPath = req.url.replace(/^\/admin\/?/, "/").split("?")[0];
  if (adminUrlPath === "/") adminUrlPath = "/index.html";
  const safePath = path.normalize(adminUrlPath).replace(/^\.\.\//, "");
  const adminFullPath = path.join(ADMIN_ROOT, safePath);
  if (!adminFullPath.startsWith(ADMIN_ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const adminStat = fs.statSync(adminFullPath);
    if (adminStat.isFile()) {
      const ext = path.extname(adminFullPath).toLowerCase();
      const mimeMap = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".map": "application/json" };
      res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Content-Length": adminStat.size, "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
      fs.createReadStream(adminFullPath).pipe(res);
      return;
    }
  } catch (e) { logger.debug("[static] caught:", e?.message); }
  const adminIndex = path.join(ADMIN_ROOT, "index.html");
  try {
    const indexStat = fs.statSync(adminIndex);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": indexStat.size, "Cache-Control": "no-cache" });
    fs.createReadStream(adminIndex).pipe(res);
  } catch {
    res.writeHead(404); res.end("Admin UI not found");
  }
}

/**
 * Handle SPA static files (catch-all).
 */
export function handleStaticFiles(req, res) {
  const STATIC_ROOT = "/opt/rangerai-agent/dist/public";
  let staticUrlPath = req.url.split("?")[0];
  if (staticUrlPath === "/") staticUrlPath = "/index.html";
  const safePath = path.normalize(staticUrlPath).replace(/^\.\.\//, "");
  const fullPath = path.join(STATIC_ROOT, safePath);
  if (!fullPath.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  try {
    const fileStat = fs.statSync(fullPath);
    if (fileStat.isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      const mimeMap = {
        ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
        ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
        ".webp": "image/webp", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".map": "application/json",
      };
      let cacheControl;
      if (ext === ".html") cacheControl = "no-cache, no-store, must-revalidate";
      else if (staticUrlPath.startsWith("/assets/")) cacheControl = "public, max-age=31536000, immutable";
      else cacheControl = "public, max-age=300";
      const headers = { "Content-Type": mimeMap[ext] || "application/octet-stream", "Content-Length": fileStat.size, "Cache-Control": cacheControl };
      if (ext === ".html") { headers["CDN-Cache-Control"] = "no-store"; headers["Surrogate-Control"] = "no-store"; headers["Pragma"] = "no-cache"; headers["Expires"] = "0"; headers["Vary"] = "*"; }
      res.writeHead(200, headers);
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
  } catch (e) { logger.debug("[static] caught:", e?.message); }
  const indexPath = path.join(STATIC_ROOT, "index.html");
  try {
    const indexStat = fs.statSync(indexPath);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": indexStat.size, "Cache-Control": "no-cache, no-store, must-revalidate", "CDN-Cache-Control": "no-store", "Surrogate-Control": "no-store", "Vary": "*" });
    fs.createReadStream(indexPath).pipe(res);
  } catch {
    res.writeHead(404); res.end("Not Found");
  }
}

/**
 * Handle gateway proxy request. Returns true if handled.
 */
export async function handleGatewayProxy(req, res) {
  const { workerManager } = deps;
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      // Iter-59: Use IPC request-response if available (split-process mode)
      if (workerManager.sendRequest) {
        try {
          const resp = await workerManager.sendRequest(
            { type: "gateway_proxy", payload: { body } },
            120000
          );
          if (resp.error) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: resp.error }));
          } else {
            const data = resp.data || {};
            res.writeHead(data.status || 200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data.data || data));
          }
        } catch (ipcErr) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Gateway timeout: " + ipcErr.message }));
        }
      } else {
        // Fallback: direct worker access (single-process mode)
        if (!workerManager.worker) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Worker not available" })); return; }
        const reqId = `gw-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        const timeout = setTimeout(() => {
          workerManager.worker?.removeListener("message", handler);
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Gateway timeout" }));
        }, 120000);
        const handler = (msg) => {
          if (msg.type === "gateway_response" && msg.reqId === reqId) {
            clearTimeout(timeout);
            workerManager.worker?.removeListener("message", handler);
            res.writeHead(msg.status || 200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(msg.data));
          }
        };
        workerManager.worker.on("message", handler);
        workerManager.worker.send({ type: "gateway_proxy", reqId, body });
      }
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request: " + err.message }));
    }
  });
  return true;
}
