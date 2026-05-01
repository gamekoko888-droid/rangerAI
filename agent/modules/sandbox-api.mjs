// ─── Sandbox API: Docker-isolated code execution endpoint ─────────────────
// P0: Docker-only execution — native fallback REMOVED for security
// v2.0.0: No more child_process fallback on host machine
import { exec, spawn } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
import { logger } from "../lib/logger.mjs";
import { ts } from "./helpers.mjs";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const SANDBOX_DIR = "/tmp/rangerai-sandbox";
const MAX_OUTPUT = 8000; // v14.7 R52: Expanded from 2000 to 8000 chars for complex task output
const DOCKER_CPU = "0.5";

// v14.8 R53 + R54: Role-based sandbox limits (tier system, not hardcoded role names)
const ROLE_LIMITS = {
  admin:    { tier: 1, memory: "128m", timeout: 30000, maxOutput: MAX_OUTPUT },
  manager:  { tier: 1, memory: "128m", timeout: 30000, maxOutput: MAX_OUTPUT },
  operator: { tier: 2, memory: "64m",  timeout: 10000, maxOutput: 4000 },
};
const DEFAULT_TIER = { tier: 0, memory: "0", timeout: 0, maxOutput: 0 }; // denied
const SANDBOX_TIMEOUT = 30000; // max timeout (tier 1 default)
const DOCKER_MEMORY = "128m"; // max memory (tier 1 default)

// Ensure sandbox directory exists
try { fs.mkdirSync(SANDBOX_DIR, { recursive: true }); } catch(_err) { /* v22.0 */ console.error("[sandbox-api] silent catch:", _err?.message || _err); }

// Check Docker availability at startup
let dockerAvailable = false;
try {
  await execAsync("docker info", { timeout: 5000 });
  dockerAvailable = true;
  logger.info(`[${ts()}] [sandbox] Docker available — container isolation enabled`);
} catch {
  logger.error(`[${ts()}] [sandbox] Docker NOT available — code execution DISABLED for security`);
}

// Docker images for each language
const DOCKER_IMAGES = {
  python: "python:3.11-slim",
  javascript: "node:22-alpine",
  bash: "ubuntu:22.04"
};

// R54: Role check now uses ROLE_LIMITS tier system
function getRoleLimits(role) {
  return ROLE_LIMITS[role] || DEFAULT_TIER;
}

/**
 * Execute code in a Docker container with full isolation
 */
async function executeInDocker({ language, code, timeout = SANDBOX_TIMEOUT, memory = DOCKER_MEMORY, maxOutput = MAX_OUTPUT }) {
  const execId = crypto.randomBytes(4).toString("hex");
  const workDir = path.join(SANDBOX_DIR, execId);
  fs.mkdirSync(workDir, { recursive: true });

  let ext, dockerCmd;
  switch (language) {
    case "python":
      ext = ".py";
      dockerCmd = ["python3", `/sandbox/code${ext}`];
      break;
    case "javascript": case "js": case "node":
      ext = ".mjs";
      dockerCmd = ["node", `/sandbox/code${ext}`];
      break;
    case "bash": case "shell":
      ext = ".sh";
      dockerCmd = ["bash", `/sandbox/code${ext}`];
      break;
    default:
      throw new Error(`Unsupported language: ${language}`);
  }

  // Write code to host workdir (will be mounted read-only into container)
  fs.writeFileSync(path.join(workDir, `code${ext}`), code, "utf-8");

  const image = DOCKER_IMAGES[language === "js" || language === "node" ? "javascript" : language === "shell" ? "bash" : language];
  const containerName = `rangerai-sbx-${execId}`;
  const timeoutMs = Math.min(timeout, SANDBOX_TIMEOUT);
  const timeoutSec = Math.ceil(timeoutMs / 1000);

  const startTime = Date.now();

  const dockerArgs = [
    "run", "--rm",
    "--name", containerName,
    "--network", "none",
    "--memory", memory,
    "--cpus", DOCKER_CPU,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--pids-limit", "50",
    "--ulimit", "nofile=256:256",
    "-v", `${workDir}:/sandbox:ro`,
    "-w", "/sandbox",
    image,
    ...dockerCmd
  ];

  logger.info(`[${ts()}] [sandbox] Docker exec: ${language} (id=${execId}, image=${image}, timeout=${timeoutSec}s)`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const proc = spawn("docker", dockerArgs, {
      timeout: timeoutMs + 5000, // extra 5s for Docker overhead
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
      execAsync(`docker kill ${containerName}`, { timeout: 3000 }).catch(_err => console.error("[sandbox-api] docker kill error:", _err?.message || _err));
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > maxOutput) {
        stdout = stdout.substring(0, maxOutput) + `\n... [output truncated at ${maxOutput} chars]`;
        killed = true;
        execAsync(`docker kill ${containerName}`, { timeout: 3000 }).catch(_err => console.error("[sandbox-api] docker kill error:", _err?.message || _err));
        proc.kill("SIGKILL");
      }
    });

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > maxOutput) {
        stderr = stderr.substring(0, maxOutput) + `\n... [output truncated at ${maxOutput} chars]`;
      }
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(_err) { /* v22.0 */ console.error("[sandbox-api] silent catch:", _err?.message || _err); }

      logger.info(`[${ts()}] [sandbox] Docker exec complete (id=${execId}, exit=${exitCode}, duration=${duration}ms, killed=${killed})`);

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: killed ? -1 : (exitCode || 0),
        duration,
        killed,
        isolated: true,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(_err) { /* v22.0 */ console.error("[sandbox-api] silent catch:", _err?.message || _err); }
      execAsync(`docker rm -f ${containerName}`, { timeout: 3000 }).catch(_err => console.error("[sandbox-api] docker rm error:", _err?.message || _err));

      resolve({
        stdout: "",
        stderr: `Docker execution error: ${err.message}`,
        exitCode: -1,
        duration: Date.now() - startTime,
        killed: false,
        isolated: false,
      });
    });
  });
}

/**
 * Execute code — Docker ONLY. No native fallback.
 */
export async function executeCode({ language, code, timeout = SANDBOX_TIMEOUT, memory = DOCKER_MEMORY, maxOutput = MAX_OUTPUT }) {
  if (!dockerAvailable) {
    return {
      stdout: "",
      stderr: "Code execution is disabled: Docker is not available on this server. Contact admin to install Docker.",
      exitCode: -1,
      duration: 0,
      killed: false,
      isolated: false,
    };
  }
  return executeInDocker({ language, code, timeout, memory, maxOutput });
}

/**
 * Internal call detection (consistent with other API modules)
 */
function isInternalCall(req) {
  const addr = req.socket?.remoteAddress || '';
  return req.headers['x-internal-call'] === '1' &&
    (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

/**
 * Handle sandbox API requests (called from http-router)
 */
export async function handleSandboxRequest(req, res, urlPath, user, readBody) {
  if (urlPath === "/api/sandbox/languages") {
    const body = JSON.stringify({
      languages: [
        { id: "python", name: "Python 3", extensions: [".py"] },
        { id: "javascript", name: "Node.js", extensions: [".js", ".mjs"] },
        { id: "bash", name: "Bash", extensions: [".sh"] },
      ],
      isolation: dockerAvailable ? "docker" : "disabled",
      dockerAvailable,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  if (urlPath === "/api/sandbox/execute" && req.method === "POST") {
    // Auth check
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication required" }));
      return;
    }
    // R54: RBAC via tier system — operator gets limited sandbox, others denied
    const _internal = isInternalCall(req);
    const _limits = getRoleLimits(user.role);
    if (!_internal && _limits.tier === 0) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Insufficient permissions for code execution",
        allowedRoles: Object.keys(ROLE_LIMITS),
        currentRole: user.role,
      }));
      return;
    }
    // Docker availability check
    if (!dockerAvailable) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Code execution is disabled: Docker is not available",
        isolation: "disabled",
      }));
      return;
    }
    try {
      const bodyStr = await readBody(req);
      const { language, code, timeout } = JSON.parse(bodyStr);
      if (!language || !code) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "language and code are required" }));
        return;
      }
      if (code.length > 100000) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Code too large (max 100KB)" }));
        return;
      }
      // R54: Apply role-specific limits
      const effectiveTimeout = _internal ? (timeout || SANDBOX_TIMEOUT) : Math.min(timeout || _limits.timeout, _limits.timeout);
      const effectiveMemory = _internal ? DOCKER_MEMORY : _limits.memory;
      const result = await executeCode({ language, code, timeout: effectiveTimeout, memory: effectiveMemory, maxOutput: _limits.maxOutput || MAX_OUTPUT });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.error(`[${ts()}] [sandbox] API error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (urlPath === "/api/sandbox/status") {
    const body = JSON.stringify({
      dockerAvailable,
      isolation: dockerAvailable ? "docker" : "disabled",
      sandboxDir: SANDBOX_DIR,
      maxTimeout: SANDBOX_TIMEOUT,
      maxOutput: MAX_OUTPUT,
      roleLimits: ROLE_LIMITS,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/**
 * Legacy Express-style route registration (kept for compatibility)
 */
export function registerSandboxRoutes(router, authMiddleware) {
  logger.info(`[${ts()}] [sandbox] API routes registered (Docker: ${dockerAvailable ? "YES" : "DISABLED"})`);
}

// Also export as setupSandboxRoutes for api-server.mjs compatibility
export const setupSandboxRoutes = registerSandboxRoutes;
