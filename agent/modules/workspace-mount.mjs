// modules/workspace-mount.mjs — Wire workspace-manager into sandbox Docker containers
// Q2: Ensures each sandbox container mounts the session's persistent workspace
import { getWorkspacePath } from '../worker/workspace-manager.mjs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

/**
 * Generate Docker volume mount args for a session's workspace.
 * @param {string} sessionKey - The session identifier
 * @returns {string[]} Docker CLI args for -v mount
 */
export function getWorkspaceMountArgs(sessionKey) {
  if (!sessionKey) return [];
  const wsPath = getWorkspacePath(sessionKey);
  if (!wsPath) {
    logger.info(`[${ts()}] [workspace-mount] No workspace for session ${sessionKey}`);
    return [];
  }
  // Mount workspace as /workspace inside container (read-write)
  return ['-v', `${wsPath}:/workspace:rw`];
}

/**
 * Patch the Docker run args array to include workspace mount.
 * Call this before spawning the container.
 * @param {string[]} dockerArgs - Existing docker run args
 * @param {string} sessionKey - Session identifier
 * @returns {string[]} Updated args with workspace mount inserted
 */
export function injectWorkspaceMount(dockerArgs, sessionKey) {
  const mountArgs = getWorkspaceMountArgs(sessionKey);
  if (mountArgs.length === 0) return dockerArgs;
  
  // Insert mount args after "--rm" (position 2 in typical docker run args)
  const rmIndex = dockerArgs.indexOf('--rm');
  if (rmIndex >= 0) {
    dockerArgs.splice(rmIndex + 1, 0, ...mountArgs);
  } else {
    // Fallback: prepend after "run"
    const runIndex = dockerArgs.indexOf('run');
    if (runIndex >= 0) {
      dockerArgs.splice(runIndex + 1, 0, ...mountArgs);
    }
  }
  
  logger.info(`[${ts()}] [workspace-mount] Mounted workspace for ${sessionKey}`);
  return dockerArgs;
}

/**
 * Get workspace info for API response enrichment.
 * @param {string} sessionKey
 * @returns {{ path: string, mounted: boolean }}
 */
export function getWorkspaceInfo(sessionKey) {
  const wsPath = getWorkspacePath(sessionKey);
  return {
    path: wsPath || null,
    mounted: Boolean(wsPath),
    containerPath: '/workspace'
  };
}
