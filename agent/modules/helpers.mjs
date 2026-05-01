/**
 * helpers.mjs — Shared utility functions
 * Extracted from server.mjs v63 during modular refactor.
 * 
 * Provides: sendEvent, smartReplayEvents, safeWriteFileSync,
 *           saveSession, loadSession, loadEnvFile, loadSecretsJson
 */

import { logger } from '../lib/logger.mjs';
import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import { execSync as _execSync } from "child_process";

export const ts = () => new Date().toISOString();

const SESSION_DIR = "/opt/rangerai-agent/sessions";
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (e) { /* best-effort */ }

// ─── WebSocket Event Sending ───────────────────────────────
export function sendEvent(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    // v66: Filter system tags from ALL events
    if (data && typeof data === "object") {
      const clone = { ...data };
      for (const key of ["content", "text", "message", "detail"]) {
        if (typeof clone[key] === "string") {
          clone[key] = clone[key]
            .replace(/\[SYSTEM:[^\]]*\]/g, "")
            .replace(/\[CONTEXT FOR AI[^\]]*?\][\s\S]{0,2000}?\[END CONTEXT\]/g, "")
            .replace(/<ranger_enhanced_instructions>[\s\S]{0,5000}?<\/ranger_enhanced_instructions>/g, "")
            .replace(/\[PRE-SEARCH RESULTS[^\]]*?\][^\n]{0,3000}/g, "")
            .replace(/\[Ranger hint\][^\n]*/g, "")
            .trim();
          if (key === "content" && !clone[key] && (clone.type === "text_delta" || clone.type === "stream_chunk")) return;
        }
      }
      ws.send(JSON.stringify(clone));
    } else {
      ws.send(JSON.stringify(data));
    }
  }
}

// ─── Smart Event Replay (for reconnect) ────────────────────
export function smartReplayEvents(ws, events) {
  let streamStartEvent = null;
  let mergedStreamContent = "";
  let streamEndEvent = null;
  const otherEvents = [];

  for (const ev of events) {
    if (ev.type === "stream_start") {
      if (!streamStartEvent) streamStartEvent = ev;
    } else if (ev.type === "stream_chunk") {
      if (ev.content) mergedStreamContent += ev.content;
    } else if (ev.type === "stream_end") {
      streamEndEvent = ev;
    } else {
      otherEvents.push(ev);
    }
  }

  if (streamStartEvent) sendEvent(ws, streamStartEvent);
  if (mergedStreamContent) sendEvent(ws, { type: "stream_chunk", content: mergedStreamContent });
  for (const ev of otherEvents) sendEvent(ws, ev);
  // v23.0: Ensure stream_end content reflects merged chunks (prevents stale content on replay)
  if (streamEndEvent) {
    if (mergedStreamContent && mergedStreamContent.length > (streamEndEvent.content || "").length) {
      streamEndEvent = { ...streamEndEvent, content: mergedStreamContent };
    }
    sendEvent(ws, streamEndEvent);
  }
}

// ─── Atomic Write Utility ──────────────────────────────────
export function safeWriteFileSync(filePath, content, options = {}) {
  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmpPath, content, options);
    if (filePath.endsWith(".mjs") || filePath.endsWith(".js")) {
      try {
        _execSync(`node --check "${tmpPath}"`, { timeout: 5000, stdio: "pipe" });
      } catch (syntaxErr) {
        fs.unlinkSync(tmpPath);
        logger.info(`[${ts()}] [safe-write] Syntax check FAILED for ${filePath}`);
        throw new Error(`Syntax validation failed for ${filePath}`);
      }
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best-effort */ }
    throw err;
  }
}

// ─── Session Persistence ───────────────────────────────────
export function saveSession(sessionKey, history) {
  try {
    const filePath = path.join(SESSION_DIR, `${sessionKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ history, updatedAt: Date.now() }));
  } catch (err) {
    logger.info(`[${ts()}] Failed to save session: ${err.message}`);
  }
}

export function loadSession(sessionKey) {
  try {
    const filePath = path.join(SESSION_DIR, `${sessionKey}.json`);
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data.history || [];
  } catch {
    return [];
  }
}

// ─── Environment Loading ───────────────────────────────────
export function loadEnvFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
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
