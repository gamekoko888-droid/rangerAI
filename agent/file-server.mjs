/**
 * file-server.mjs — 极简文件上传/下载服务 + API 余额查询
 *
 * 功能：
 * - POST /upload            — 接收 multipart 文件上传（本地存储）
 * - POST /api/oss/credential — 生成阿里云 OSS 直传签名凭证
 * - GET  /api/oss/status     — 检查 OSS 配置状态
 * - GET  /files/*            — 提供已上传文件的下载
 * - GET  /workspace/*        — 提供 OpenClaw sandbox workspace 文件访问
 * - GET  /_share/*           — 提供 _share 目录文件访问
 * - GET  /api/balance        — 查询 API 提供商状态和用量
 * - GET  /health             — 健康检查
 *
 * 所有其他功能（聊天、会话、agent、health 等）由 OpenClaw Gateway 原生处理。
 *
 * OSS 环境变量（在 agent-secrets.env 中配置）：
 *   OSS_ACCESS_KEY_ID      — 阿里云 AccessKey ID
 *   OSS_ACCESS_KEY_SECRET  — 阿里云 AccessKey Secret
 *   OSS_BUCKET             — Bucket 名称，如 my-rangerai-bucket
 *   OSS_REGION             — 地域，如 oss-cn-hangzhou
 *   OSS_CDN_BASE           — （可选）CDN 域名，如 https://img.example.com
 */

import { logger } from './lib/logger.mjs';
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ─── OSS 签名模块（内联，避免外部依赖）─────────────────────────

const OSS_ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OSS_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function ossConfigured() {
  return !!(
    process.env.OSS_ACCESS_KEY_ID &&
    process.env.OSS_ACCESS_KEY_SECRET &&
    process.env.OSS_BUCKET &&
    process.env.OSS_REGION
  );
}

/**
 * @param {{ filename: string, mimeType: string, size: number }} params
 * @returns {{ ok: true, credential: object } | { ok: false, status: number, message: string }}
 */
function generateOssCredential({ filename, mimeType, size }) {
  if (!filename || typeof filename !== "string") {
    return { ok: false, status: 400, message: "缺少 filename 参数" };
  }
  if (!OSS_ALLOWED_MIMES.has(mimeType)) {
    return {
      ok: false,
      status: 415,
      message: `不支持的文件类型：${mimeType}。仅允许 image/png、image/jpeg、image/webp`,
    };
  }
  if (typeof size !== "number" || size <= 0 || !Number.isFinite(size)) {
    return { ok: false, status: 400, message: "size 参数无效" };
  }
  if (size > OSS_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `文件过大：${(size / 1024 / 1024).toFixed(2)} MB，单文件上限 5 MB`,
    };
  }
  if (!ossConfigured()) {
    return {
      ok: false,
      status: 500,
      message: "OSS 未配置：请在 agent-secrets.env 中设置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_REGION",
    };
  }

  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION;
  const cdnBase = process.env.OSS_CDN_BASE ?? null;

  const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
  const ext = extMap[mimeType] ?? ".bin";
  const d = new Date();
  const dateDir = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  const uid = crypto.randomUUID().replace(/-/g, "");
  const objectKey = `uploads/images/${dateDir}/${uid}${ext}`;

  const dateStr = d.toUTCString();
  const method = "PUT";
  const canonicalizedResource = `/${bucket}/${objectKey}`;
  const stringToSign = [method, "", mimeType, dateStr, canonicalizedResource].join("\n");
  const signature = crypto.createHmac("sha1", accessKeySecret).update(stringToSign, "utf-8").digest("base64");
  const authorization = `OSS ${accessKeyId}:${signature}`;

  const ossHost = `https://${bucket}.${region}.aliyuncs.com`;
  const uploadUrl = `${ossHost}/${objectKey}`;
  const publicBase = cdnBase ? cdnBase.replace(/\/$/, "") : ossHost;
  const publicUrl = `${publicBase}/${objectKey}`;

  return {
    ok: true,
    credential: {
      uploadUrl,
      publicUrl,
      headers: {
        Authorization: authorization,
        "Content-Type": mimeType,
        Date: dateStr,
      },
      expiresAt: d.getTime() + 300_000, // 5 min
      objectKey,
    },
  };
}

// ─── OSS 路由处理 ─────────────────────────────────────────────

async function handleOssCredential(req, res) {
  cors(res);
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  let body = "";
  try {
    body = await new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 8192) reject(new Error("Request too large")); });
      req.on("end", () => resolve(raw));
      req.on("error", reject);
    });
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "读取请求失败: " + e.message }));
    return;
  }

  let params;
  try {
    params = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "请求体必须是有效的 JSON" }));
    return;
  }

  const { filename, mimeType, size } = params;
  const result = generateOssCredential({ filename, mimeType, size });

  if (!result.ok) {
    res.writeHead(result.status);
    res.end(JSON.stringify({ error: result.message, code: `OSS_${result.status}` }));
    return;
  }

  logger.info(`[${ts()}] OSS credential issued for ${result.credential.objectKey} (${mimeType}, ${size} bytes)`);
  res.writeHead(200);
  res.end(JSON.stringify(result.credential));
}

function handleOssStatus(req, res) {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  const configured = ossConfigured();
  res.writeHead(configured ? 200 : 503);
  res.end(JSON.stringify({
    configured,
    bucket: configured ? process.env.OSS_BUCKET : null,
    region: configured ? process.env.OSS_REGION : null,
    hasCdn: !!(process.env.OSS_CDN_BASE),
    allowedMimes: [...OSS_ALLOWED_MIMES],
    maxFileSizeBytes: OSS_MAX_BYTES,
  }));
}

const PORT = 3001;
const UPLOADS_DIR = "/opt/rangerai-agent/uploads";
const FILES_DIR = "/opt/rangerai-agent/files";
const MEDIA_DIR = "/home/admin/.openclaw/media";
const WORKSPACE_DIR = "/home/admin/.openclaw/workspace";
const SHARE_DIR = "/var/www/rangerai/_share";
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const OPENCLAW_CONFIG = "/home/admin/.openclaw/openclaw.json";

// ─── Upload Security (Iter-61) ───────────────────────────────
const UPLOAD_ALLOWED_EXTS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv',
  // Code
  'js', 'mjs', 'ts', 'py', 'json', 'html', 'css', 'xml', 'yaml', 'yml',
  // Archives
  'zip', 'gz', 'tar', '7z', 'rar', 'bz2', 'xz',
  // Audio/Video
  'mp3', 'wav', 'ogg', 'mp4', 'webm',
]);

function isAllowedUploadExt(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return UPLOAD_ALLOWED_EXTS.has(ext);
}

// Ensure directories exist
for (const dir of [UPLOADS_DIR, FILES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "application/javascript", ".json": "application/json",
  ".txt": "text/plain", ".md": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".zip": "application/zip", ".7z": "application/x-7z-compressed", ".rar": "application/x-rar-compressed", ".bz2": "application/x-bzip2", ".xz": "application/x-xz",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function ts() {
  return new Date().toISOString();
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── API Provider Status ───

// Cache balance for 30 seconds to avoid hitting rate limits
let _balanceCache = null;
let _balanceCacheTime = 0;
const BALANCE_CACHE_TTL = 30000; // 30s

function getProviderKeys() {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf-8"));
    const providers = config?.models?.providers || {};
    return {
      openai: providers.openai?.apiKey || process.env.OPENAI_API_KEY || "",
      google: providers.google?.apiKey || process.env.GOOGLE_API_KEY || "",
      anthropic: providers.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY || "",
    };
  } catch { return { openai: "", google: "", anthropic: "" }; }
}

async function handleApiBalance(req, res) {
  cors(res);
  res.setHeader("Content-Type", "application/json");

  // Return cached result if fresh
  const now = Date.now();
  if (_balanceCache && (now - _balanceCacheTime) < BALANCE_CACHE_TTL) {
    res.writeHead(200);
    res.end(JSON.stringify({ ..._balanceCache, cached: true }));
    return;
  }

  const keys = getProviderKeys();

  try {
    // Check OpenAI status
    let openaiStatus = "no_key";
    if (keys.openai) {
      try {
        const oaiRes = await fetch("https://api.openai.com/v1/models", {
          headers: { "Authorization": `Bearer ${keys.openai}` },
          signal: AbortSignal.timeout(5000),
        });
        openaiStatus = oaiRes.status === 200 ? "ok" : oaiRes.status === 429 ? "quota_exceeded" : `error_${oaiRes.status}`;
      } catch { openaiStatus = "unreachable"; }
    }

    // Check Google status
    let googleStatus = "no_key";
    if (keys.google) {
      try {
        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${keys.google}`, {
          signal: AbortSignal.timeout(5000),
        });
        googleStatus = gRes.status === 200 ? "ok" : `error_${gRes.status}`;
      } catch { googleStatus = "unreachable"; }
    }

    // Check Anthropic status
    let anthropicStatus = "no_key";
    if (keys.anthropic) {
      try {
        const aRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": keys.anthropic, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
          signal: AbortSignal.timeout(8000),
        });
        anthropicStatus = aRes.ok ? "ok" : aRes.status === 429 ? "rate_limited" : `error_${aRes.status}`;
      } catch { anthropicStatus = "unreachable"; }
    }

    const result = {
      providers: {
        openai: { status: openaiStatus, has_key: !!keys.openai },
        google: { status: googleStatus, has_key: !!keys.google },
        anthropic: { status: anthropicStatus, has_key: !!keys.anthropic },
      },
      default_model: null,
      timestamp: now,
      cached: false,
    };

    // Read default model from config
    try {
      const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf-8"));
      result.default_model = config?.agents?.defaults?.model || null;
    } catch(e) { logger.error("[file-server] Error:", e.message); }

    // Cache the result
    _balanceCache = result;
    _balanceCacheTime = now;

    logger.info(`[${ts()}] Provider status: OpenAI=${openaiStatus}, Google=${googleStatus}, Anthropic=${anthropicStatus}`);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (err) {
    logger.info(`[${ts()}] Balance error: ${err.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "Failed to check provider status: " + err.message }));
  }
}

// ─── File Serving ───

function serveFile(res, rootDir, relPath) {
  const filePath = path.resolve(rootDir, relPath);
  // Prevent path traversal
  if (!filePath.startsWith(path.resolve(rootDir)) ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("File not found");
    return;
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    res.writeHead(403);
    res.end("Directory listing not allowed");
    return;
  }
  const mime = getMime(filePath);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stat.size,
    "Cache-Control": "public, max-age=86400",
  });
  fs.createReadStream(filePath).pipe(res);
}

function handleUpload(req, res) {
  let totalSize = 0;
  const chunks = [];

  req.on("data", (chunk) => {
    totalSize += chunk.length;
    if (totalSize > MAX_UPLOAD_SIZE) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "文件过大，最大支持 20MB" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    try {
      const body = Buffer.concat(chunks);
      const boundary = req.headers["content-type"]?.match(/boundary=(.+)/)?.[1];
      if (!boundary) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid multipart form data" }));
        return;
      }

      const boundaryBuf = Buffer.from("--" + boundary);
      const files = [];
      let offset = 0;

      while (offset < body.length) {
        const start = body.indexOf(boundaryBuf, offset);
        if (start < 0) break;
        const nextStart = body.indexOf(boundaryBuf, start + boundaryBuf.length);
        if (nextStart < 0) break;

        const partBuf = body.slice(start + boundaryBuf.length, nextStart);
        const headerEndIdx = partBuf.indexOf(Buffer.from("\r\n\r\n"));
        if (headerEndIdx < 0) { offset = nextStart; continue; }

        const headerStr = partBuf.slice(0, headerEndIdx).toString("utf-8");
        if (!headerStr.includes("filename=")) { offset = nextStart; continue; }

        const nameMatch = headerStr.match(/filename="([^"]+)"/);
        if (!nameMatch) { offset = nextStart; continue; }

        const originalName = nameMatch[1].replace(/[^a-zA-Z0-9._-]/g, "_");
        const ext = (originalName.split(".").pop() || "bin").toLowerCase();

        // Iter-61: Extension whitelist — reject dangerous file types
        if (!isAllowedUploadExt(originalName)) {
          logger.warn(`[${ts()}] Upload rejected: disallowed extension .${ext} (${originalName})`);
          offset = nextStart;
          continue;
        }

        const safeName = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;

        let fileContent = partBuf.slice(headerEndIdx + 4);
        if (fileContent.length >= 2 &&
            fileContent[fileContent.length - 2] === 0x0d &&
            fileContent[fileContent.length - 1] === 0x0a) {
          fileContent = fileContent.slice(0, -2);
        }

        const uploadPath = path.join(UPLOADS_DIR, safeName);
        const servePath = path.join(FILES_DIR, safeName);
        fs.writeFileSync(uploadPath, fileContent);
        fs.copyFileSync(uploadPath, servePath);

        const stat = fs.statSync(uploadPath);
        files.push({ name: originalName, path: `/files/${safeName}`, size: stat.size });
        offset = nextStart;
      }

      logger.info(`[${ts()}] Upload: ${files.length} file(s), total ${totalSize} bytes`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, files }));
    } catch (err) {
      logger.info(`[${ts()}] Upload error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "上传处理失败: " + err.message }));
    }
  });
}

// ─── HTTP Server ───

const server = http.createServer(async (req, res) => {
  cors(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url?.split("?")[0] || "/";

  // Root status (simple)
  if (url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "rangerai-file-server",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Detailed status
  if (url === "/api/status") {
    let gateway = { ok: false, error: "unknown" };
    try {
      // Best-effort probe of gateway health endpoint
      const health = await fetch("http://127.0.0.1:18789/health", { signal: AbortSignal.timeout(2000) });
      gateway = { ok: health.status === 200, http_status: health.status };
    } catch (e) {
      gateway = { ok: false, error: e?.message || String(e) };
    }

    const mem = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "rangerai-file-server",
      pid: process.pid,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      node: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
      gateway,
    }));
    return;
  }

  // API: Balance check
  if (url === "/api/balance") {
    handleApiBalance(req, res);
    return;
  }

  // OSS credential endpoint (POST /api/oss/credential)
  if (url === "/api/oss/credential") {
    await handleOssCredential(req, res);
    return;
  }

  // OSS status check (GET /api/oss/status)
  if (url === "/api/oss/status" && req.method === "GET") {
    handleOssStatus(req, res);
    return;
  }

  // File upload (local fallback)
  if (url === "/upload" && req.method === "POST") {
    handleUpload(req, res);
    return;
  }

  // Serve uploaded files
  if (url.startsWith("/files/")) {
    const fileName = decodeURIComponent(url.slice(7));
    serveFile(res, FILES_DIR, fileName);
    return;
  }

  // Serve workspace files
    // Serve media files (screenshots etc)
  if (url.startsWith("/media/")) {
    const relPath = decodeURIComponent(url.slice(7));
    serveFile(res, MEDIA_DIR, relPath);
    return;
  }

  if (url.startsWith("/workspace/")) {
    const relPath = decodeURIComponent(url.slice(11));
    serveFile(res, WORKSPACE_DIR, relPath);
    return;
  }

  // Serve _share files
  if (url.startsWith("/_share/")) {
    const relPath = decodeURIComponent(url.slice(8));
    serveFile(res, SHARE_DIR, relPath);
    return;
  }

  // Health check
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "file-server", uptime: process.uptime() }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  logger.info(`[${ts()}] file-server listening on 127.0.0.1:${PORT}`);
});
