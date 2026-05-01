import { diagnoseFailure, FAILURE_TYPE } from './failure-recovery.mjs';

// R97 error-recovery: error classification and fallback metadata seam.
// It mirrors the legacy fallback table without moving behavior prematurely.

const TOOL_FALLBACK_MAP = {
  web_fetch: { fallback: 'web_search', reason: 'web_fetch failed, falling back to web_search' },
  web_search: { fallback: 'web_fetch', reason: 'web_search failed, falling back to web_fetch for direct URL access' },
  browser: { fallback: 'web_fetch', reason: 'browser tool failed, falling back to web_fetch' },
  web_fetch_to_browser: { fallback: 'browser', reason: 'web_fetch returned insufficient content, upgrading to browser' },
  read_file: { fallback: 'exec', reason: 'read_file failed, falling back to exec cat' },
  write_file: { fallback: 'exec', reason: 'write_file failed, falling back to exec with echo/cat' },
  generate_image: { fallback: 'web_search', reason: 'image generation failed, falling back to web_search for existing images' },
  speak_text: { fallback: null, reason: 'TTS failed, will skip voice output' },
  analyze_image: { fallback: null, reason: 'Vision analysis failed, will describe based on URL/context' },
  analyze_video: { fallback: null, reason: 'Video analysis failed' },
  analyze_audio: { fallback: null, reason: 'Audio analysis failed' },
  analyze_document: { fallback: null, reason: 'Document analysis failed' },
};

export { diagnoseFailure, FAILURE_TYPE };

export function getToolFallback(toolName) {
  return TOOL_FALLBACK_MAP[toolName] || null;
}

export function getRecoveryFallbackCatalog() {
  return Object.keys(TOOL_FALLBACK_MAP).sort();
}

export function classifyHandlerError(error, context = {}) {
  const message = error?.message || String(error || '');
  return diagnoseFailure({ error: message, ...context });
}

export function buildRecoveryNotice(toolName, error) {
  const fallback = getToolFallback(toolName);
  return {
    toolName,
    error: error?.message || String(error || ''),
    fallback: fallback?.fallback || null,
    reason: fallback?.reason || null,
  };
}

export function createRecoveryContext({ entry = {}, source = 'openclaw-handler' } = {}) {
  return {
    source,
    taskId: entry.taskId || null,
    sessionKey: entry.gatewaySessionKey || null,
    fallbackTools: getRecoveryFallbackCatalog(),
  };
}
