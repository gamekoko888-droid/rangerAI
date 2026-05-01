// proxy80.mjs — Smart reverse proxy (v56-vnc-proxy)
// Listens on port 80
// Routes /ws/gateway (WebSocket only) to OpenClaw Gateway (18789)
// Routes /vnc/ (HTTP + WebSocket) to noVNC/websockify (6080)
// Everything else to localhost:3001
import { logger } from './lib/logger.mjs';
import http from "http";
import net from "net";
const BACKEND_PORT = 3001;
const GATEWAY_PORT = 18789;
const VNC_PORT = 6080;
const LISTEN_PORT = 80;
const GW_PREFIX = "/ws/gateway";
const VNC_PREFIX = "/vnc/";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
function getAllowedOrigin(reqOrigin) {
  if (!reqOrigin) return "https://ranger.voyage";
  const allowed = [
    "https://ranger.voyage",
    "http://ranger.voyage",
    "https://www.ranger.voyage",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://8.219.186.244",
    "http://8.219.186.244:3000",
    "http://8.219.186.244:80",
  ];
  if (allowed.includes(reqOrigin)) return reqOrigin;
  if (/^https?:\/\/[^/]*\.manus\.(computer|space)(:\d+)?$/.test(reqOrigin)) return reqOrigin;
  return "https://ranger.voyage";
}
function isGatewayPath(url) {
  return url === GW_PREFIX || url.startsWith(GW_PREFIX + "?") || url.startsWith(GW_PREFIX + "/");
}
function isVncPath(url) {
  return url.startsWith(VNC_PREFIX) || url === "/vnc";
}
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    const origin = getAllowedOrigin(req.headers.origin);
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
    });
    res.end();
    return;
  }

  // Gateway paths are WebSocket-only — reject plain HTTP
  if (isGatewayPath(req.url)) {
    res.writeHead(426, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain",
      "Upgrade": "websocket",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end("426 Upgrade Required — This endpoint only accepts WebSocket connections.");
    return;
  }

  // VNC/noVNC paths -> websockify (6080)
  if (isVncPath(req.url)) {
    // Strip /vnc/ prefix: /vnc/vnc_embed.html -> /vnc_embed.html
    const targetPath = req.url.slice("/vnc".length) || "/";
    const options = {
      hostname: "127.0.0.1",
      port: VNC_PORT,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${VNC_PORT}` },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      // Allow iframe embedding for VNC pages (remove X-Frame-Options)
      // Don't add DENY for VNC since it's loaded in an iframe
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        headers[key] = value;
      }
      // Override: allow framing for VNC
      delete headers["X-Frame-Options"];
      headers["X-Frame-Options"] = "SAMEORIGIN";
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on("error", (err) => {
      logger.error(`[proxy] VNC HTTP error: ${err.message}`);
      res.writeHead(502);
      res.end("VNC service unavailable");
    });
    req.pipe(proxyReq, { end: true });
    return;
  }

  // All other HTTP requests -> backend (3001)
  const options = {
    hostname: "127.0.0.1",
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: req.headers.host },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers[key] = value;
    }
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on("error", (err) => {
    logger.error(`[proxy] HTTP error: ${err.message}`);
    res.writeHead(502);
    res.end("Bad Gateway");
  });
  req.pipe(proxyReq, { end: true });
});

// WebSocket upgrade handler
server.on("upgrade", (req, socket, head) => {
  const isGw = isGatewayPath(req.url);
  const isVnc = isVncPath(req.url);
  const targetPort = isGw ? GATEWAY_PORT : isVnc ? VNC_PORT : BACKEND_PORT;
  // Strip prefix for gateway and vnc paths
  let targetUrl = req.url;
  if (isGw) {
    targetUrl = req.url.slice(GW_PREFIX.length) || "/";
  } else if (isVnc) {
    targetUrl = req.url.slice("/vnc".length) || "/";
  }
  logger.info(`[proxy] WS upgrade: ${req.url} -> :${targetPort}${targetUrl}`);
  const targetSocket = net.connect(targetPort, "127.0.0.1", () => {
    const headers = [`${req.method} ${targetUrl} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      headers.push(`${key}: ${value}`);
    }
    headers.push("", "");
    targetSocket.write(headers.join("\r\n"));
    if (head && head.length) targetSocket.write(head);
    targetSocket.pipe(socket);
    socket.pipe(targetSocket);
  });
  targetSocket.on("error", (err) => {
    logger.error(`[proxy] WS tunnel error (${targetPort}): ${err.message}`);
    socket.end();
  });
  socket.on("error", (err) => {
    logger.error(`[proxy] Client socket error: ${err.message}`);
    targetSocket.end();
  });
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  logger.info(`[proxy] v56-vnc-proxy — :80 -> backend(:${BACKEND_PORT}) + ${GW_PREFIX}(WS)->gateway(:${GATEWAY_PORT}) + /vnc/->noVNC(:${VNC_PORT})`);
});
