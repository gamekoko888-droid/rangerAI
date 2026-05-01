// ─── Gateway Usage Tracker ───
// F33: Extracts token usage data from Gateway session JSONL files
// Extracted from openclaw-handler.mjs

import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../lib/logger.mjs';
const execAsync = promisify(exec);

const SESSIONS_DIR = "/home/admin/.openclaw/agents/main/sessions";

/**
 * Extract Gateway token usage from session JSONL file
 * Uses grep-based approach to avoid parsing 16MB JSON files
 * @param {string} sessionKey - The session key (with or without "agent:main:" prefix)
 * @returns {object|null} Usage data { input, output, totalTokens, cacheRead, cacheWrite, cost, source }
 */
export async function extractGatewayUsage(sessionKey) {
  const ts = () => new Date().toISOString();
  const rawKey = sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;

  try {
    // Step 1: Use grep to find sessionId for this key (avoids parsing 16MB JSON)
    let sessionId = null;
    try {
      const grepObj = await execAsync(
        `grep -A1 '"${rawKey}"' ${SESSIONS_DIR}/sessions.json | grep sessionId | head -1`,
        { encoding: "utf8", timeout: 3000 }
      );
      const grepResult = (grepObj.stdout || "").trim();
      const match = grepResult.match(/"sessionId":\s*"([^"]+)"/);
      if (match) sessionId = match[1];
    } catch (_grepErr) {
      // grep may fail if key not found - that's ok
    }

    // Step 2: Read the JSONL file for this session
    if (sessionId) {
      const jsonlPath = `${SESSIONS_DIR}/${sessionId}.jsonl`;
      if (fs.existsSync(jsonlPath)) {
        const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const event = JSON.parse(lines[i]);
            if (event.type === "message" && event.message?.role === "assistant" && event.message?.usage) {
              const u = event.message.usage;
              const usage = {
                input: u.input || 0,
                output: u.output || 0,
                totalTokens: u.totalTokens || 0,
                cacheRead: u.cacheRead || 0,
                cacheWrite: u.cacheWrite || 0,
                cost: u.cost || null,
                source: "session.jsonl"
              };
              logger.info(`[${ts()}] [usage-tracker] Usage from JSONL: input=${usage.input}, output=${usage.output}, total=${usage.totalTokens}, cost=${JSON.stringify(u.cost)}`);
              return usage;
            }
          } catch(_) { /* v22.0 */ logger.error("[usage-tracker] silent catch:", _?.message || _); }
        }
      }
    }

    // Fallback: if no JSONL usage, try grep for token counts from sessions.json
    if (sessionId) {
      try {
        const grepTokens = await execAsync(
          `grep -A20 '"${rawKey}"' ${SESSIONS_DIR}/sessions.json | head -25`,
          { encoding: "utf8", timeout: 3000 }
        );
        const grepTokensStr = (grepTokens.stdout || ""); const inMatch = grepTokensStr.match(/"inputTokens":\s*(\d+)/);
        const outMatch = grepTokensStr.match(/"outputTokens":\s*(\d+)/);
        const totalMatch = grepTokensStr.match(/"totalTokens":\s*(\d+)/);
        if (inMatch || outMatch) {
          const usage = {
            input: parseInt(inMatch?.[1] || "0"),
            output: parseInt(outMatch?.[1] || "0"),
            totalTokens: parseInt(totalMatch?.[1] || "0"),
            source: "sessions.json.grep"
          };
          logger.info(`[${ts()}] [usage-tracker] Usage from sessions.json (grep): input=${usage.input}, output=${usage.output}`);
          return usage;
        }
      } catch(_) { /* v22.0 */ logger.error("[usage-tracker] silent catch:", _?.message || _); }
    }
  } catch (usageErr) {
    logger.info(`[${ts()}] [usage-tracker] Failed to fetch Gateway usage: ${usageErr.message}`);
  }

  return null;
}
