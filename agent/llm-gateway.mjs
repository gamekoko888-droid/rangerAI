// ─── RangerAI Smart Router ──────────────────────────────────
// Analyzes user messages and determines optimal model routing strategy.
// Integrates with OpenClaw Gateway (primary) and Direct API calls (OpenAI/Anthropic/Google).
//
// Core principle: Rely on OpenClaw capabilities first. Use direct API calls
// (OpenAI/Anthropic/Google) when Gateway is unavailable. DirectAPI is disabled.

import { logger } from './lib/logger.mjs';
import metrics from './lib/metrics-collector.mjs'; // Iter-60: Link metrics to routing
import https from "https";
import http from "http";

// --- Hot-Reloadable Configuration (kept in llm-gateway as the config owner) ---
import { readFileSync, existsSync, watchFile, statSync } from 'fs';
import path from 'path';

const CONFIG_PATH = path.resolve(
  process.env.SMART_ROUTER_CONFIG || '/opt/rangerai-agent/config/smart-router-config.json'
);
let _config = null;
let _configLoadedAt = 0;

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      _config = JSON.parse(raw);
      _configLoadedAt = Date.now();
      logger.info(`[smart-router] Config loaded from ${CONFIG_PATH} (v${_config._version || 'unknown'})`);
      return _config;
    }
  } catch (err) {
    logger.warn(`[smart-router] Failed to load config from ${CONFIG_PATH}: ${err.message}`);
  }
  return null;
}

loadConfig();

try {
  watchFile(CONFIG_PATH, { interval: 30000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      logger.info('[smart-router] Config file changed, reloading...');
      loadConfig();
    }
  });
} catch (e) {
  logger.info(`[smart-router] Config file watch not available: ${e.message}`);
}

function getConfig() { return _config; }


// ─── SOUL.md Identity Loader (extracted to lib/soul-loader.mjs — TD-023) ────
import { getSoulSystemPrompt as _getSoulSystemPrompt, getSoulSystemPromptSplit as _getSoulSystemPromptSplit, setSoulConfigAccessor } from './lib/soul-loader.mjs';
// Inject config accessor
setSoulConfigAccessor(getConfig);
// Re-export for backward compatibility
export const getSoulSystemPrompt = _getSoulSystemPrompt;
export const getSoulSystemPromptSplit = _getSoulSystemPromptSplit;

// ─── Task Classification (extracted to lib/routing-config.mjs — TD-022) ────
import { classifyTask, setConfigAccessor } from './lib/routing-config.mjs';
// Inject config accessor so routing-config can access hot-reloadable config
setConfigAccessor(getConfig);

// ─── DirectAPI Direct API Client (Fallback) ────────────────

// v8: Use Gateway token instead of DirectAPI key
// v8: Use existing readFileSync (already imported at top)
let _gwToken = "";
try { _gwToken = readFileSync("/home/admin/.openclaw/gateway.token", "utf-8").trim(); } catch(e) { /* v22.0 */ logger.error("[smart-router] silent catch:", e?.message || e); }
const GATEWAY_API_KEY = _gwToken || process.env.GATEWAY_API_KEY || "";
// v8: Redirect "DirectAPI" calls through Gateway (which routes to direct providers)
const GATEWAY_BASE_URL = "http://127.0.0.1:18789/v1";

// Model selection for direct DirectAPI calls (when Gateway is down)

// ─── Per-Provider Circuit Breaker (F25) ───────────────────────
const _providerCircuitBreaker = {
  // provider → { failures: 0, lastFailure: 0, openUntil: 0 }
};
const CB_FAILURE_THRESHOLD = 3;  // consecutive failures to trip
const CB_RECOVERY_MS = 5 * 60 * 1000;  // 5 min cooldown

// v14.3: Rate limit detection — 429 errors should NOT trip circuit breaker
function isRateLimitError(err) {
  if (!err || !err.message) return false;
  return err.message.includes('HTTP 429') || 
         err.message.includes('rate limit') ||
         err.message.includes('RESOURCE_EXHAUSTED') ||
         err.message.includes('Too Many Requests');
}

// v14.3: Rate limit backoff — wait and retry instead of failing immediately
// v14.3.1: Task-type-aware backoff — image_generation gets longer waits (stricter RPM)
const RATE_LIMIT_BACKOFF_MS = {
  default: [15000, 30000],           // 15s, 30s for normal tasks
  image_generation: [30000, 60000, 90000]  // 30s, 60s, 90s for image tasks (Gemini is sole provider, stricter RPM)
};
async function withRateLimitRetry(fn, provider, signal, taskType = 'chat') {
  const backoffs = RATE_LIMIT_BACKOFF_MS[taskType] || RATE_LIMIT_BACKOFF_MS.default;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err)) throw err; // not a rate limit, propagate
      if (signal?.aborted) throw err;
      if (attempt >= backoffs.length) {
        logger.warn(`[smart-router] [rate-limit] ${provider} still rate-limited after ${attempt + 1} attempts (taskType=${taskType}), giving up`);
        throw err;
      }
      const waitMs = backoffs[attempt];
      logger.info(`[smart-router] [rate-limit] ${provider} returned 429 (taskType=${taskType}), backing off ${waitMs/1000}s (attempt ${attempt + 1}/${backoffs.length + 1})`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

function cbRecordSuccess(provider) {
  if (_providerCircuitBreaker[provider]) {
    _providerCircuitBreaker[provider].failures = 0;
    _providerCircuitBreaker[provider].openUntil = 0;
  }
}

function cbRecordFailure(provider) {
  if (!_providerCircuitBreaker[provider]) {
    _providerCircuitBreaker[provider] = { failures: 0, lastFailure: 0, openUntil: 0 };
  }
  const cb = _providerCircuitBreaker[provider];
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= CB_FAILURE_THRESHOLD) {
    cb.openUntil = Date.now() + CB_RECOVERY_MS;
    logger.warn(`[circuit-breaker] Provider ${provider} tripped after ${cb.failures} failures. Open until ${new Date(cb.openUntil).toISOString()}`);
  }
}

function cbIsOpen(provider) {
  const cb = _providerCircuitBreaker[provider];
  if (!cb || cb.openUntil === 0) return false;
  if (Date.now() >= cb.openUntil) {
    // Half-open: allow one attempt
    cb.openUntil = 0;
    cb.failures = 0;
    logger.info(`[circuit-breaker] Provider ${provider} half-open, allowing attempt`);
    return false;
  }
  return true;
}

export function getCircuitBreakerStatus() {
  const status = {};
  for (const [provider, cb] of Object.entries(_providerCircuitBreaker)) {
    status[provider] = {
      failures: cb.failures,
      isOpen: cbIsOpen(provider),
      openUntil: cb.openUntil > 0 ? new Date(cb.openUntil).toISOString() : null
    };
  }
  return status;
}

// Phase 4: Now reads from config file with hardcoded fallback
const _GATEWAY_MODELS_DEFAULT = {
  image_generation: "google/gemini-3.1-flash-image-preview",
  code: "anthropic/claude-sonnet-4-6",
  reasoning: "openai/gpt-5.4",
  sysadmin: "anthropic/claude-sonnet-4-6",
  chinese_content: "openai/gpt-5.4",
  research: "openai/gpt-5.4",
  creative: "openai/gpt-5.4",
  chat: "openai/gpt-4.1-mini",
  translation: "openai/gpt-4.1-mini",
  gaming: "anthropic/claude-sonnet-4-6"
};
// Restored: getDirectAPIModels — returns default model map for routing decisions
function getDirectAPIModels() {
  return _GATEWAY_MODELS_DEFAULT;
}

// Fallback chain — Phase 4: reads from config with hardcoded fallback
const _GATEWAY_FALLBACKS_DEFAULT = {
  image_generation: ["google/gemini-3.1-flash-image-preview", "google/gemini-3-flash-preview-image", "google/gemini-3-pro-image-preview"],
  code: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "openai/gpt-4.1-mini"],
  reasoning: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
  creative: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
  research: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
  gaming: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "openai/gpt-4.1-mini"],
  sysadmin: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4", "openai/gpt-4.1-mini"],
  chat: ["openai/gpt-4.1-mini", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
  chinese_content: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "openai/gpt-4.1-mini"],
  translation: ["openai/gpt-4.1-mini", "openai/gpt-5.4", "anthropic/claude-sonnet-4-6"]
};
export function getDirectAPIFallbacks() {
  return _GATEWAY_FALLBACKS_DEFAULT;
}

/**
 * Call DirectAPI API directly (streaming).
 * Used as fallback when OpenClaw Gateway is unavailable.
 * 
 * @param {Object} options
 * @param {string} options.message - User message
 * @param {Array} options.history - Conversation history [{role, content}]
 * @param {string} options.taskType - Task classification type
 * @param {Function} options.onDelta - Callback for streaming deltas
 * @param {Function} options.onDone - Callback when complete
 * @param {Function} options.onError - Callback on error
 * @param {AbortSignal} options.signal - Abort signal
 */
export async function callDirectAPIDirect(options) { // Redirects to direct API fallback chain
  // v13.0: Redirect to callDirectAPIWithFallback — DirectAPI is completely disabled
  return callDirectAPIWithFallback(options);
}

// Direct API only — OpenRouter completely removed (2026-03-26)


// ─── User-Selected Model Direct Call ────────────────────────
/**
 * Call DirectAPI with a specific user-selected model (no fallback chain).
 * Used when user manually picks a model from the UI.
 */
export async function callDirectAPIWithModel(options) {
  // v13.0: Redirect to callDirectAPI — DirectAPI is completely disabled
  // This function is kept for backward compatibility with existing callers
  return callDirectAPI(options);
}

// ─── Anthropic Direct API Call (bypasses Gateway Smart Router) ────────────────
// When user selects an Anthropic model, call the Anthropic Messages API directly
// to avoid Gateway's Smart Router overriding the model selection.


function getAnthropicKey() { return process.env.ANTHROPIC_API_KEY || ""; }
const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Stream a response from Anthropic Messages API directly.
 * @param {string} model - Anthropic model ID (e.g., "claude-sonnet-4-20250514")
 * @param {string} message - User message
 * @param {Array} history - Conversation history
 * @param {Function} onDelta - Callback for streaming deltas
 * @param {AbortSignal} signal - Abort signal
 * @param {Array} attachments - Optional attachments
 * @param {string} systemPrompt - System prompt
 * @returns {Promise<{content: string, model: string}>}
 */
function _streamAnthropicDirect(model, message, history, onDelta, signal, attachments, systemPrompt) {
  return new Promise((resolve, reject) => {
    // Build messages array (Anthropic format: no system role in messages)
    const messages = [];
    
    // Add history (filter and convert)
    const recentHistory = (history || []).slice(-20)
      .filter(h => h && h.content && (typeof h.content === 'string' ? h.content.trim().length > 0 : true));
    
    for (const h of recentHistory) {
      const role = h.role === "assistant" ? "assistant" : "user";
      const content = typeof h.content === "string" ? h.content : JSON.stringify(h.content);
      messages.push({ role, content });
    }
    
    // Build user message with optional image attachments
    if (attachments && attachments.length > 0) {
      const parts = [];
      for (const att of attachments) {
        if (att.type === 'image' && att.url) {
          parts.push({
            type: 'image',
            source: {
              type: 'url',
              url: att.url.startsWith('/') ? `https://ranger.voyage${att.url}` : att.url
            }
          });
        }
      }
      parts.push({ type: 'text', text: message });
      messages.push({ role: 'user', content: parts });
    } else {
      messages.push({ role: 'user', content: message });
    }
    
    // Map model IDs: frontend uses "anthropic/claude-sonnet-4-6" but Anthropic API needs "claude-sonnet-4-20250514"
    const MODEL_MAP = {
      "anthropic/claude-sonnet-4-6": "claude-sonnet-4-20250514",
      "claude-sonnet-4-6": "claude-sonnet-4-20250514",
      "anthropic/claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
    };
    const apiModel = MODEL_MAP[model] || model.replace("anthropic/", "");
    
    // v14.6: KV-Cache optimization — use cache_control for prompt caching
    // Anthropic caches the system prompt prefix; cached tokens cost 0.1x (90% savings)
    // v28.0: Dual-layer KV-Cache — fixed prefix gets cache_control, volatile suffix does not
    // This ensures the stable identity/rules prefix is always cached (90% savings)
    // while volatile sections (skills, APIs) don't pollute the cache key
    let systemBlocks;
    if (systemPrompt) {
      // External system prompt (e.g., from roleSystemPrompt) — single block, cached
      systemBlocks = [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
    } else {
      const split = getSoulSystemPromptSplit();
      if (split.volatile && split.volatile.length > 0) {
        systemBlocks = [
          { type: "text", text: split.fixed, cache_control: { type: "ephemeral" } },
          { type: "text", text: split.volatile }
        ];
        logger.info(`[smart-router] [v28.0] Anthropic dual-cache: fixed=${split.fixed.length}, volatile=${split.volatile.length}`);
      } else {
        systemBlocks = [{ type: "text", text: split.full, cache_control: { type: "ephemeral" } }];
      }
    }
    const body = JSON.stringify({
      model: apiModel,
      max_tokens: 8192,
      stream: true,
      system: systemBlocks,
      messages
    });
    
    const reqOptions = {
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": getAnthropicKey(),
        "anthropic-version": ANTHROPIC_API_VERSION
      }
    };
    
    let fullContent = "";
    let aborted = false;
    
    if (signal) {
      signal.addEventListener("abort", () => {
        aborted = true;
        req.destroy();
      });
    }
    
    const req = https.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = "";
        res.on("data", chunk => errorBody += chunk);
        res.on("end", () => {
          reject(new Error(`Anthropic ${apiModel}: HTTP ${res.statusCode} - ${errorBody.substring(0, 300)}`));
        });
        return;
      }
      
      let buffer = "";
      res.on("data", (chunk) => {
        if (aborted) return;
        buffer += chunk.toString();
        
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            resolve({ content: fullContent, model: apiModel });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            // Anthropic streaming events
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
              const delta = parsed.delta.text || "";
              if (delta) {
                fullContent += delta;
                if (onDelta) onDelta(delta);
              }
            } else if (parsed.type === "message_stop") {
              resolve({ content: fullContent, model: apiModel });
              return;
            } else if (parsed.type === "message_start" && parsed.message?.usage) {
              // v14.6: Log prompt caching metrics
              const u = parsed.message.usage;
              if (u.cache_read_input_tokens || u.cache_creation_input_tokens) {
                logger.info(`[smart-router] [anthropic-cache] model=${apiModel} input=${u.input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0}`);
              }
            }
          } catch (e) { /* best-effort */ }
        }
      });
      
      res.on("end", () => {
        if (!aborted) resolve({ content: fullContent, model: apiModel });
      });
      res.on("error", reject);
    });
    
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function callAnthropicDirect(options) {
  const { model, message, history = [], onDelta, onDone, onError, signal, attachments, systemPrompt } = options;
  if (!getAnthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  try {
    const result = await _streamAnthropicDirect(model, message, history, onDelta, signal, attachments, systemPrompt);
    if (onDone) onDone(result.content, result.model);
    return { content: result.content, model: result.model, provider: "anthropic-direct" };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

// ─── OpenAI Direct API Call ────────────────────────────────────
function getOpenAIKey() { return process.env.OPENAI_API_KEY || ""; }

function _streamOpenAIDirect(model, message, history, onDelta, signal, attachments, systemPrompt) {
  return new Promise((resolve, reject) => {
    const messages = [
      { role: "system", content: systemPrompt || getSoulSystemPrompt() },
      ...((history || []).slice(-20)
        .filter(h => h && h.content && (typeof h.content === 'string' ? h.content.trim().length > 0 : true))
        .map(h => ({
          role: h.role === "assistant" ? "assistant" : h.role === "system" ? "system" : "user",
          content: typeof h.content === "string" ? h.content : JSON.stringify(h.content)
        }))),
      (() => {
        if (attachments && attachments.length > 0) {
          const parts = [];
          for (const att of attachments) {
            if (att.type === 'image' && att.url) {
              parts.push({
                type: 'image_url',
                image_url: { url: att.url.startsWith('/') ? `https://ranger.voyage${att.url}` : att.url, detail: 'auto' }
              });
            }
          }
          parts.push({ type: 'text', text: message });
          return { role: 'user', content: parts };
        }
        return { role: 'user', content: message };
      })()
    ];

    // Map model IDs
    const MODEL_MAP = {
      "openai/gpt-5.4": "gpt-5.4",
      "gpt-5.4": "gpt-5.4",
      "openai/gpt-4o": "gpt-4o",
      "openai/gpt-4o-mini": "gpt-4o-mini",
      "openai/gpt-5-mini": "gpt-5-mini",
      "openai/gpt-4.1-mini": "gpt-4.1-mini",
      "gpt-4.1-mini": "gpt-4.1-mini",
    };
    const apiModel = MODEL_MAP[model] || model.replace("openai/", "");

    // Reasoning models (o1, o3, gpt-5-mini) dont support temperature
    const isReasoningModel = /^(o1|o3|gpt-5-mini)/.test(apiModel);
    const bodyObj = {
      model: apiModel,
      messages,
      stream: true,
      max_completion_tokens: 8192,
    };
    if (!isReasoningModel) bodyObj.temperature = 0.7;
    const body = JSON.stringify(bodyObj);

    const reqOptions = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getOpenAIKey()}`
      }
    };

    let fullContent = "";
    let aborted = false;

    if (signal) {
      signal.addEventListener("abort", () => {
        aborted = true;
        req.destroy();
      });
    }

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = "";
        res.on("data", chunk => errorBody += chunk);
        res.on("end", () => {
          reject(new Error(`OpenAI ${apiModel}: HTTP ${res.statusCode} - ${errorBody.substring(0, 300)}`));
        });
        return;
      }

      let buffer = "";
      res.on("data", (chunk) => {
        if (aborted) return;
        buffer += chunk.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            resolve({ content: fullContent, model: apiModel });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullContent += delta;
              if (onDelta) onDelta(delta);
            }
          } catch (e) { /* best-effort */ }
        }
      });

      res.on("end", () => {
        if (!aborted) resolve({ content: fullContent, model: apiModel });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function callOpenAIDirect(options) {
  const { model, message, history = [], onDelta, onDone, onError, signal, attachments, systemPrompt } = options;
  if (!getOpenAIKey()) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  try {
    const result = await _streamOpenAIDirect(model, message, history, onDelta, signal, attachments, systemPrompt);
    if (onDone) onDone(result.content, result.model);
    return { content: result.content, model: result.model, provider: "openai-direct" };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

// ─── Google Gemini Direct API Call ────────────────────────────────────
function getGoogleKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  // v15.0: Fallback to openclaw.json for Google API key
  try {
    const cfg = JSON.parse(readFileSync("/home/admin/.openclaw/openclaw.json", "utf-8"));
    const key = cfg?.models?.providers?.google?.apiKey;
    if (key) {
      process.env.GOOGLE_API_KEY = key; // Cache for future calls
      return key;
    }
  } catch (e) { /* ignore */ }
  return "";
}

function _streamGoogleDirect(model, message, history, onDelta, signal, attachments, systemPrompt) {
  return new Promise((resolve, reject) => {
    // Map model IDs
    const MODEL_MAP = {
      "google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
      "google/gemini-3.1-pro": "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
      "gemini-3.1-pro": "gemini-3.1-pro-preview",
      "google/gemini-3-flash-preview": "gemini-3-flash-preview",
      "gemini-2.5-flash": "gemini-3-flash-preview",
      "google/gemini-2.5-pro": "gemini-3.1-pro-preview",
      "gemini-2.5-pro": "gemini-3.1-pro-preview",
      "google/gemini-3-flash-preview": "gemini-3-flash-preview",
      "gemini-3-flash-preview": "gemini-3-flash-preview",
      // Nano Banana image generation models
      "google/gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
      "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
      "google/gemini-3-flash-preview-image": "gemini-2.5-flash-image",
      "gemini-2.5-flash-image": "gemini-2.5-flash-image",
      "google/gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
      "gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
    };
    const apiModel = MODEL_MAP[model] || model.replace("google/", "");

    // Build Gemini API format
    const contents = [];

    // Add history
    const recentHistory = (history || []).slice(-20)
      .filter(h => h && h.content && (typeof h.content === 'string' ? h.content.trim().length > 0 : true));

    for (const h of recentHistory) {
      const role = h.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: [{ text: typeof h.content === "string" ? h.content : JSON.stringify(h.content) }] });
    }

    // Build user message with optional image attachments
    if (attachments && attachments.length > 0) {
      const parts = [];
      for (const att of attachments) {
        if (att.type === 'image' && att.url) {
          const imgUrl = att.url.startsWith('/') ? `https://ranger.voyage${att.url}` : att.url;
          parts.push({ fileData: { fileUri: imgUrl, mimeType: "image/jpeg" } });
        }
      }
      parts.push({ text: message });
      contents.push({ role: "user", parts });
    } else {
      contents.push({ role: "user", parts: [{ text: message }] });
    }

    // v15.0: Detect Nano Banana image generation models
    const _isImageModel = /^gemini-.*image/.test(apiModel);
    
    const requestBody = {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt || getSoulSystemPrompt() }] },
      generationConfig: {
        maxOutputTokens: _isImageModel ? 65536 : 8192,
        temperature: 0.7,
        // Nano Banana models need responseModalities to generate images
        ...(_isImageModel ? { responseModalities: ["TEXT", "IMAGE"] } : {})
      }
    };

    // v15.0: Image models use non-streaming endpoint (images can't stream)
    const body = JSON.stringify(requestBody);
    const apiPath = _isImageModel
      ? `/v1beta/models/${apiModel}:generateContent?key=${getGoogleKey()}`
      : `/v1beta/models/${apiModel}:streamGenerateContent?alt=sse&key=${getGoogleKey()}`;

    const reqOptions = {
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: apiPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    };

    let fullContent = "";
    let aborted = false;

    if (signal) {
      signal.addEventListener("abort", () => {
        aborted = true;
        req.destroy();
      });
    }

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = "";
        res.on("data", chunk => errorBody += chunk);
        res.on("end", () => {
          reject(new Error(`Google ${apiModel}: HTTP ${res.statusCode} - ${errorBody.substring(0, 300)}`));
        });
        return;
      }

      let buffer = "";
      res.on("data", (chunk) => {
        if (aborted) return;
        buffer += chunk.toString();

        // v15.0: Image models use non-streaming JSON response
        if (_isImageModel) {
          // Accumulate full response (non-streaming)
          return;
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]" || !data) continue;
          try {
            const parsed = JSON.parse(data);
            // Gemini streaming format: candidates[0].content.parts[0].text
            const delta = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (delta) {
              fullContent += delta;
              if (onDelta) onDelta(delta);
            }
          } catch (e) { /* best-effort */ }
        }
      });

      res.on("end", () => {
        if (aborted) return;
        
        // v15.0: Handle Nano Banana image response
        if (_isImageModel) {
          try {
            const parsed = JSON.parse(buffer);
            const parts = parsed.candidates?.[0]?.content?.parts || [];
            let textContent = "";
            let imageCount = 0;
            
            for (const part of parts) {
              if (part.text) {
                textContent += part.text;
              } else if (part.inlineData) {
                // Save base64 image to file
                imageCount++;
                const mime = part.inlineData.mimeType || "image/jpeg";
                const ext = mime.includes("png") ? "png" : "jpeg";
                const timestamp = Date.now();
                const filename = `img_${timestamp}_${imageCount}.${ext}`;
                const filePath = `/opt/rangerai-agent/files/generated/${filename}`;
                
                try {
                  writeFileSync(filePath, Buffer.from(part.inlineData.data, "base64"));
                  const imageUrl = `https://ranger.voyage/files/generated/${filename}`;
                  const imgMarkdown = `\n\n![生成的图片](${imageUrl})\n`;
                  textContent += imgMarkdown;
                  logger.info(`[smart-router] [v15.0] Nano Banana image saved: ${filePath} (${part.inlineData.data.length} chars base64)`);
                } catch (writeErr) {
                  logger.warn(`[smart-router] [v15.0] Failed to save image: ${writeErr.message}`);
                  textContent += "\n\n[图片生成成功但保存失败]\n";
                }
              }
            }
            
            fullContent = textContent;
            if (onDelta) onDelta(textContent);
            resolve({ content: fullContent, model: apiModel, imageGenerated: imageCount > 0 });
          } catch (parseErr) {
            reject(new Error(`Google ${apiModel}: Failed to parse image response - ${parseErr.message}`));
          }
          return;
        }
        
        resolve({ content: fullContent, model: apiModel });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function callGoogleDirect(options) {
  const { model, message, history = [], onDelta, onDone, onError, signal, attachments, systemPrompt } = options;
  if (!getGoogleKey()) {
    throw new Error("GOOGLE_API_KEY not configured");
  }
  try {
    const result = await _streamGoogleDirect(model, message, history, onDelta, signal, attachments, systemPrompt);
    if (onDone) onDone(result.content, result.model);
    return { content: result.content, model: result.model, provider: "google-direct" };
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

// ─── Universal Direct API Router ────────────────────────────────────
// Routes to the correct direct API based on model prefix
export async function callDirectAPI(options) {
  const { model } = options;
  const m = (model || "").toLowerCase();

  if (m.startsWith("anthropic/") || m.startsWith("claude-") || m.startsWith("claude ")) {
    return callAnthropicDirect(options);
  } else if (m.startsWith("openai/") || m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("o3-")) {
    return callOpenAIDirect(options);
  } else if (m.startsWith("google/") || m.startsWith("gemini-")) {
    return callGoogleDirect(options);
  }

  // Unknown provider — try OpenAI format as default (most compatible)
  logger.warn(`[smart-router] Unknown model provider for "${model}", trying OpenAI format`);
  return callOpenAIDirect(options);
}

// ─── Direct API Fallback Chain ────────────────────────────────────
// Replaces callDirectAPIDirect — tries each model in the fallback chain using direct APIs
export async function callDirectAPIWithFallback(options) {
  const { message, history = [], taskType = "chat", onDelta, onDone, onError, signal, attachments, systemPrompt } = options;

  const models = getDirectAPIFallbacks()[taskType] || getDirectAPIFallbacks().chat;
  let lastError = null;

  if (signal?.aborted) {
    throw new Error("Task aborted before model selection");
  }

  for (const model of models) {
    if (signal?.aborted) {
      logger.info(`[smart-router] Task aborted, skipping model ${model}`);
      throw new Error("Task aborted during model fallback");
    }
    // F25: Circuit breaker — skip providers that are tripped
    const provider = model.split("/")[0] || model;
    if (cbIsOpen(provider)) {
      logger.info(`[smart-router] Skipping ${model} — circuit breaker OPEN for ${provider}`);
      continue;
    }
    try {
      // v14.3: Wrap in rate limit retry — 429 errors get automatic backoff
      // v14.3.1: Pass taskType for image_generation longer backoff
      const result = await withRateLimitRetry(
        () => callDirectAPI({
          model, message, history, onDelta, onDone, onError, signal, attachments, systemPrompt
        }),
        provider,
        signal,
        taskType
      );
      cbRecordSuccess(provider);
      return result;
    } catch (err) {
      lastError = err;
      // v14.3: Rate limit errors should NOT trip circuit breaker
      if (isRateLimitError(err)) {
        logger.info(`[smart-router] Direct API ${model} rate-limited (429), NOT counting as circuit breaker failure`);
      } else {
        cbRecordFailure(provider);
      }
      logger.info(`[smart-router] Direct API ${model} failed: ${err.message} (cb failures: ${_providerCircuitBreaker[provider]?.failures || 0})`);
      if (signal?.aborted) throw err;
      continue;
    }
  }

  const error = new Error(`All direct API models failed. Last error: ${lastError?.message}`);
  if (onError) onError(error);
  throw error;
}




// ─── Smart Router Integration ───────────────────────────────

/**
 * Compute a provider health score from metrics snapshot.
 * Returns a value between 0.0 (dead) and 1.0 (perfectly healthy).
 * Formula: 0.4 * availability + 0.35 * latency_score + 0.25 * error_rate_score
 */
function computeGatewayHealthScore(snapshot) {
  // P1-7: When no snapshot data, return 0.5 (cautious) instead of 1.0 (fully healthy)
  // This prevents false "healthy" status when metrics collection hasn't started yet
  if (!snapshot) return 0.5;

  // --- Availability: based on 5xx rate relative to total RPM ---
  const rpm = snapshot.traffic?.http_rpm || 0;
  const fiveXX = snapshot.errors?.http_5xx_rpm || 0;
  const availability = rpm > 0 ? Math.max(0, 1 - (fiveXX / rpm)) : 1.0;

  // --- Latency score: p99 first-token latency, penalize above thresholds ---
  const p99 = snapshot.latency?.model_first_token?.p99 || 0;
  // 0-5s = 1.0, 5-15s = linear decay, 15s+ = 0
  const latencyScore = p99 <= 5000 ? 1.0 : p99 >= 15000 ? 0 : 1 - ((p99 - 5000) / 10000);

  // --- Error rate: gateway-specific errors per minute ---
  const gwErrors = snapshot.errors?.gateway_errors_rpm || 0;
  // 0 errors = 1.0, 10+ errors = 0
  const errorRateScore = Math.max(0, 1 - (gwErrors / 10));

  const score = 0.4 * availability + 0.35 * latencyScore + 0.25 * errorRateScore;
  return Math.round(score * 100) / 100;
}

/**
 * Get routing decision for a message.
 * Returns { thinking, taskType, description, useGateway, fallbackModel, healthScore, gatewayStatus }
 *
 * Iter-62: Metrics now ACTUALLY influence routing decisions.
 * - healthScore < degraded_threshold → useGateway=false (skip Gateway, go direct DirectAPI)
 * - healthScore < warning_threshold  → log warning, still try Gateway
 * - Thresholds are configurable via smart-router-config.json (hot-reloadable)
 */
export function getRoutingDecision(message) {
  const classification = classifyTask(message);

  // --- Health assessment ---
  const snapshot = metrics.getSnapshot();
  const healthScore = computeGatewayHealthScore(snapshot);

  // Configurable thresholds (hot-reloadable from config)
  const thresholds = getConfig()?.health_thresholds || {};
  const degradedThreshold = thresholds.degraded ?? 0.3;  // Below this → skip Gateway
  const warningThreshold  = thresholds.warning  ?? 0.6;  // Below this → log warning
  const autoFallbackEnabled = thresholds.auto_fallback !== false; // Default: enabled

  let gatewayStatus = 'healthy';
  let useGateway = true;

  // v15.0: Image generation tasks always use Direct API (Nano Banana handles images natively)
  if (classification.type === 'image_generation') {
    gatewayStatus = 'image_direct';
    useGateway = false;
    logger.info(
      `[smart-router] [v15.0] Image generation task detected. ` +
      `Routing directly to Nano Banana 2 (gemini-3.1-flash-image-preview) via Direct API.`
    );
  } else if (healthScore < degradedThreshold) {
    // v22.1: Gateway degraded - DO NOT fallback to direct LLM. Keep using Gateway and log warning.
    gatewayStatus = 'degraded';
    useGateway = true;  // v22.1: ALWAYS use Gateway, never silently fallback to direct LLM
    logger.warn(
      `[smart-router] [v22.1] Gateway DEGRADED (score=${healthScore}, threshold=${degradedThreshold}). ` +
      `Still routing through Gateway - direct LLM fallback DISABLED.`
    );
    // v22.2: Alert owner when Gateway is degraded (with 10-minute cooldown)
    const now = Date.now();
    if (!getRoutingDecision._lastDegradedAlert || (now - getRoutingDecision._lastDegradedAlert) > 600000) {
      getRoutingDecision._lastDegradedAlert = now;
      sendNotification({
        channel: 'console',
        title: '[RangerAI] Gateway 健康度告警',
        content: `Gateway 健康分数过低: ${healthScore} (阈值: ${degradedThreshold})\n时间: ${new Date().toISOString()}\n状态: 仍通过 Gateway 路由，但可能影响响应速度。\n建议: 检查 Gateway 服务状态和 API 额度。`
      }).catch(e => logger.error('[smart-router] [v22.2] Failed to send degraded alert:', e.message));
    }
  } else if (healthScore < warningThreshold) {
    gatewayStatus = 'warning';
    logger.info(
      `[smart-router] Gateway WARNING (score=${healthScore}). ` +
      `Still using Gateway but monitoring closely.`
    );
  }

  // --- Reorder fallback chain by provider health (future: per-provider metrics) ---
  const fallbackChain = getDirectAPIFallbacks()[classification.type] || getDirectAPIFallbacks().chat;

  return {
    thinking: classification.thinking,
    taskType: classification.type,
    description: classification.description,
    confidence: classification.confidence,
    useGateway,
    gatewayStatus,
    healthScore,
    fallbackModel: getDirectAPIModels()[classification.type] || getDirectAPIModels().chat,
    fallbackChain,
    // v5.0: Model upgrade routing
    needsStrongModel: classification.needsStrongModel,
    strongModel: classification.strongModel
  };
}

/**
 * Log routing decision for debugging
 */
export { computeGatewayHealthScore };

export function logRoutingDecision(msgId, message, decision) {
  const preview = message.substring(0, 60).replace(/\n/g, " ");
  logger.info(
    `[smart-router] msg=${msgId} type=${decision.taskType} ` +
    `thinking=${decision.thinking} confidence=${decision.confidence.toFixed(2)} ` +
    `health=${decision.healthScore ?? 'N/A'} gw=${decision.gatewayStatus ?? 'unknown'} ` +
    `useGateway=${decision.useGateway} fallback=${decision.fallbackModel} preview="${preview}..."`
  );
}
