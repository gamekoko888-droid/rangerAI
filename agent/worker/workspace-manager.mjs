import fs from "fs/promises";
import path from "path";

export const WORKSPACE_BASE_DIR = "/opt/rangerai-agent/workspaces";

function validateSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") {
    throw new Error("sessionKey is required");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionKey)) {
    throw new Error("sessionKey contains invalid characters");
  }
}

export function getWorkspacePath(sessionKey) {
  validateSessionKey(sessionKey);
  return path.join(WORKSPACE_BASE_DIR, sessionKey);
}

export async function getOrCreateWorkspace(sessionKey) {
  const workspacePath = getWorkspacePath(sessionKey);
  await fs.mkdir(workspacePath, { recursive: true, mode: 0o755 });
  await fs.chmod(workspacePath, 0o755);
  return workspacePath;
}

export async function listFiles(sessionKey) {
  const workspacePath = await getOrCreateWorkspace(sessionKey);
  return fs.readdir(workspacePath, { withFileTypes: true });
}

export async function cleanupStale(maxAgeMs = 86400000) {
  await fs.mkdir(WORKSPACE_BASE_DIR, { recursive: true, mode: 0o755 });
  const now = Date.now();
  const entries = await fs.readdir(WORKSPACE_BASE_DIR, { withFileTypes: true });
  const cleaned = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(WORKSPACE_BASE_DIR, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.rm(fullPath, { recursive: true, force: true });
        cleaned.push(entry.name);
      }
    } catch {
      // skip unreadable entries
    }
  }

  return cleaned;
}
