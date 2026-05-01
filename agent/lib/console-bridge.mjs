/**
 * Console-to-Logger Bridge (F26)
 * Intercepts console.log/warn/error in the worker process and routes through
 * the structured JSON logger. This avoids modifying 200+ console.log calls
 * across worker modules while achieving structured log output.
 */
import logger from "./logger.mjs";

const _originalLog = console.log;
const _originalWarn = console.warn;
const _originalError = console.error;

// Pattern to extract timestamp prefix: [2026-03-27T16:24:05.794Z]
const TS_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*/;
// Pattern to extract component tag: [worker] [gateway] [fallback] etc.
const TAG_RE = /\[(\w[\w-]*)\]/g;

function parseConsoleArgs(args) {
  let msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  // Strip redundant timestamp prefix (logger adds its own)
  msg = msg.replace(TS_RE, "");
  // Extract component tags
  const tags = [];
  let m;
  const tagRe = /\[(\w[\w-]*)\]/g;
  while ((m = tagRe.exec(msg)) !== null) {
    tags.push(m[1]);
  }
  return { msg: msg.trim(), component: tags[0] || "worker" };
}

export function installConsoleBridge() {
  console.log = (...args) => {
    const { msg, component } = parseConsoleArgs(args);
    // Skip empty messages
    if (!msg) return;
    // Already JSON structured? Pass through
    if (msg.startsWith("{") && msg.includes("\"ts\":")) {
      _originalLog(...args);
      return;
    }
    logger.info(msg, { component });
  };

  console.warn = (...args) => {
    const { msg, component } = parseConsoleArgs(args);
    if (!msg) return;
    if (msg.startsWith("{") && msg.includes("\"ts\":")) {
      _originalWarn(...args);
      return;
    }
    logger.warn(msg, { component });
  };

  console.error = (...args) => {
    const { msg, component } = parseConsoleArgs(args);
    if (!msg) return;
    // [v25.9.2] Skip EPIPE errors to prevent log explosion
    if (msg.includes("EPIPE")) return;
    if (msg.startsWith("{") && msg.includes("\"ts\":")) {
      _originalError(...args);
      return;
    }
    logger.error(msg, { component });
  };

  logger.info("Console-to-Logger bridge installed", { component: "console-bridge" });
}

export function uninstallConsoleBridge() {
  console.log = _originalLog;
  console.warn = _originalWarn;
  console.error = _originalError;
}
