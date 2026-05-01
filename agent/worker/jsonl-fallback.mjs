// ─── JSONL Fallback: Extract assistant reply from Gateway session JSONL ───
// When the WS event stream fails to deliver assistant text events,
// this function reads the Gateway's session JSONL file to recover the response.
// This is a critical fallback for the "empty response" bug where Gateway
// processes the request (output tokens > 0) but WS doesn't stream the text.

import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../lib/logger.mjs';
const execAsync = promisify(exec);

const SESSIONS_DIR = "/home/admin/.openclaw/agents/main/sessions";

/**
 * Extract the latest assistant reply text from Gateway session JSONL.
 * @param {string} sessionKey - Session key (with or without "agent:main:" prefix)
 * @returns {string|null} The assistant text content, or null if not found
 */
export async function extractAssistantReplyFromJsonl(sessionKey) {
  const ts = () => new Date().toISOString();
  const rawKey = sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;
  
  try {
    // Step 1: Find sessionId from sessions.json
    let sessionId = null;
    try {
      const grepExec = await execAsync(
        `grep -A1 '"${rawKey}"' ${SESSIONS_DIR}/sessions.json | grep sessionId | head -1`,
        { encoding: "utf8", timeout: 3000 }
      );
      const grepResult = grepExec?.stdout?.trim() || "";
      const match = grepResult.match(/"sessionId":\s*"([^"]+)"/);
      if (match) sessionId = match[1];
    } catch(_) { /* v22.0 */ logger.error("[jsonl-fallback] silent catch:", _?.message || _); }
    
    if (!sessionId) {
      logger.info(`[${ts()}] [jsonl-fallback] No sessionId found for ${rawKey}`);
      return null;
    }
    
    // Step 2: Read the last few lines of the JSONL file (last entry should be the assistant reply)
    const jsonlPath = `${SESSIONS_DIR}/${sessionId}.jsonl`;
    if (!fs.existsSync(jsonlPath)) {
      logger.info(`[${ts()}] [jsonl-fallback] JSONL file not found: ${jsonlPath}`);
      return null;
    }
    
    // Read last 5 lines (the assistant reply is usually the last or second-to-last entry)
    let lastLines;
    try {
      const tailExec = await execAsync(`tail -5 "${jsonlPath}"`, { encoding: "utf8", timeout: 3000 });
      lastLines = (tailExec?.stdout || "").trim().split("\n");
    } catch (_) {
      // Fallback: read entire file
      lastLines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n").slice(-5);
    }
    
    // Step 3: Find the latest assistant message with text content
    for (let i = lastLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lastLines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const content = entry.message.content;
          let textParts = [];
          
          if (typeof content === "string") {
            textParts.push(content);
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === "text" && part.text) {
                textParts.push(part.text);
              }
            }
          }
          
          if (textParts.length > 0) {
            let fullText = textParts.join("\n");
            
            // Strip <think>...</think> blocks (thinking content should not be shown to user)
            fullText = fullText.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
            
            // Also strip standalone <think> without closing tag (partial thinking)
            fullText = fullText.replace(/<think>[\s\S]*$/g, "").trim();
            
            if (fullText.length > 0) {
              logger.info(`[${ts()}] [jsonl-fallback] Recovered ${fullText.length} chars from JSONL (sessionId=${sessionId})`);
              return fullText;
            }
          }
        }
      } catch(_) { /* v22.0 */ logger.error("[jsonl-fallback] silent catch:", _?.message || _); }
    }
    
    logger.info(`[${ts()}] [jsonl-fallback] No assistant text found in last 5 lines of JSONL`);
    return null;
  } catch (err) {
    logger.info(`[${ts()}] [jsonl-fallback] Error: ${err.message}`);
    return null;
  }
}
