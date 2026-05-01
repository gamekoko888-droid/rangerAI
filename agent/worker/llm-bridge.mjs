/**
 * llm-bridge.mjs — Multi-Provider LLM Bridge (R44-T1)
 * 
 * Supports OpenAI, Anthropic (Claude), and Google (Gemini) providers.
 * Reads API keys from OpenClaw config or environment variables.
 * Returns OpenAI-compatible response format regardless of provider.
 * 
 * Provider selection: pass model with provider prefix:
 *   - "openai/gpt-5.5" or "gpt-5.5" → OpenAI
 *   - "openai/gpt-5.5" or "claude-*" → Anthropic
 *   - "google/gemini-3-flash-preview" or "gemini-*" → Google
 */
import https from 'https';
import { readFileSync } from 'fs';
import { logger } from '../lib/logger.mjs';
import { redisPool } from '../redis-pool.mjs'; // [R46-T2] Redis-backed CB state

// ═══════════════════════════════════════════════════════════════
// Provider Configuration
// ═══════════════════════════════════════════════════════════════

const PROVIDERS = {
  openai: {
    host: 'api.openai.com',
    path: '/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    host: 'api.anthropic.com',
    path: '/v1/messages',
    keyEnv: 'ANTHROPIC_API_KEY',
    apiVersion: '2023-06-01',
  },
  google: {
    // Gemini uses REST with API key in URL
    host: 'generativelanguage.googleapis.com',
    keyEnv: 'GOOGLE_API_KEY',
  },
  deepseek: {
    host: 'api.deepseek.com',
    path: '/v1/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
};

// ═══════════════════════════════════════════════════════════════
// API Key Cache
// ═══════════════════════════════════════════════════════════════

const _keyCache = {};

function getApiKey(provider) {
  if (_keyCache[provider]) return _keyCache[provider];
  
  // 1. Check env var
  const envKey = PROVIDERS[provider]?.keyEnv;
  if (envKey && process.env[envKey]) {
    _keyCache[provider] = process.env[envKey];
    return _keyCache[provider];
  }
  
  // 2. Fallback: read from OpenClaw config
  try {
    const cfgText = readFileSync('/home/admin/.openclaw/openclaw.json', 'utf-8');
    const cfg = JSON.parse(cfgText);
    const key = cfg?.models?.providers?.[provider]?.apiKey;
    if (key) { _keyCache[provider] = key; return key; }
  } catch (_) { /* silent */ }
  
  // 3. Legacy fallback for OpenAI
  if (provider === 'openai') {
    try {
      const cfgText = readFileSync('/home/admin/.openclaw/config.json', 'utf-8');
      const cfg = JSON.parse(cfgText);
      const key = cfg?.models?.providers?.openai?.apiKey;
      if (key) { _keyCache[provider] = key; return key; }
    } catch (_) { /* silent */ }
  }
  
  return '';
}

// ═══════════════════════════════════════════════════════════════
// Provider Detection
// ═══════════════════════════════════════════════════════════════

function detectProvider(model) {
  if (!model) return { provider: 'openai', modelId: 'gpt-5-mini' };
  
  // Explicit prefix: "openai/gpt-5.5", "openai/gpt-5.5"
  const slashIdx = model.indexOf('/');
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx).toLowerCase();
    const modelId = model.slice(slashIdx + 1);
    if (PROVIDERS[prefix]) return { provider: prefix, modelId };
  }
  
  // Heuristic detection
  const lower = model.toLowerCase();
  if (lower.startsWith('claude') || lower.includes('sonnet') || lower.includes('haiku') || lower.includes('opus')) {
    return { provider: 'anthropic', modelId: model };
  }
  if (lower.startsWith('gemini') || lower.startsWith('google')) {
    return { provider: 'google', modelId: model };
  }
  if (lower.startsWith('deepseek') || lower.includes('deepseek-v4') || lower.includes('deepseek-r1')) {
    return { provider: 'deepseek', modelId: model };
  }
  
  // Default: OpenAI
  return { provider: 'openai', modelId: model };
}
// ═══════════════════════════════════════════════════════════════
// [R45-T2] Circuit Breaker per Provider
// ═══════════════════════════════════════════════════════════════
const CB_FAILURE_THRESHOLD = 3;     // consecutive failures to trip
const CB_FAILURE_WINDOW_MS = 60000; // 60s window for counting failures
const CB_RECOVERY_MS = 30000;       // 30s before half-open probe
// [R77-T3] Max OPEN duration: force HALF_OPEN probe after 5min even if failures keep resetting the timer
const CB_MAX_OPEN_MS = 5 * 60 * 1000; // 5min hard safety cap (from circuit-breaker.mjs)
// [R75-P1-1] Dual-tier failure classification
const CB_HARD_THRESHOLD = 3;        // hard failures (connection/scope/timeout) trip fast
const CB_SOFT_THRESHOLD = 8;        // soft failures (empty response) trip slower
const CB_DECAY_MS = 60000;          // halve failure counts if no new failures in this interval

const FALLBACK_CHAIN = ['openai', 'deepseek', 'google']; // R52: removed anthropic (org disabled)

// [R46-T2] Redis-backed Circuit Breaker with local cache (5s TTL)
const CB_REDIS_PREFIX = 'rangerai:cb:';
const CB_LOCAL_CACHE_TTL = 5000; // 5s local cache to prevent Redis overheating

class CircuitBreaker {
  constructor(providerName) {
    this.provider = providerName;
    this.state = 'closed';
    this.failures = [];
    this.hardFailures = [];  // [R75-P1-1] connection/scope/timeout failures
    this.softFailures = [];  // [R75-P1-1] empty-response/application failures
    this.lastSoftFailure = 0; // [R75-P1-1] timestamp for decay
    this.lastHardFailure = 0; // [R75-P1-1] timestamp for decay
    this.openedAt = 0;
    this.lastSuccess = Date.now();
    this._localCacheTs = 0;
    this._syncingToRedis = false;
  }

  _redisKey() { return CB_REDIS_PREFIX + this.provider; }

  async _syncFromRedis() {
    const now = Date.now();
    if (now - this._localCacheTs < CB_LOCAL_CACHE_TTL) return;
    try {
      const client = redisPool?.getClient?.();
      if (!client) { this._localCacheTs = now; return; }
      const data = await client.hGetAll(this._redisKey());
      if (data && data.state) {
        this.state = data.state;
        this.failures = data.failures ? JSON.parse(data.failures) : [];
        this.openedAt = parseInt(data.openedAt) || 0;
        this.lastSuccess = parseInt(data.lastSuccess) || Date.now();
      }
      this._localCacheTs = now;
    } catch (err) {
      logger.warn('[llm-bridge] [R46-T2] Redis read failed for ' + this.provider + ': ' + err.message);
    }
  }

  async _syncToRedis() {
    if (this._syncingToRedis) return;
    this._syncingToRedis = true;
    try {
      const client = redisPool?.getClient?.();
      if (!client) return;
      await client.hSet(this._redisKey(), {
        state: this.state,
        failures: JSON.stringify(this.failures),
        openedAt: String(this.openedAt),
        lastSuccess: String(this.lastSuccess),
      });
      this._localCacheTs = Date.now();
    } catch (err) {
      logger.warn('[llm-bridge] [R46-T2] Redis write failed for ' + this.provider + ': ' + err.message);
    } finally {
      this._syncingToRedis = false;
    }
  }

  async isAvailable() {
    await this._syncFromRedis();
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      // [R77-T3] 5min safety cap: force HALF_OPEN even if failures keep resetting the timer
      if (elapsed >= CB_MAX_OPEN_MS) {
        this.state = 'half-open';
        logger.info('[llm-bridge] [R77-T3] CB ' + this.provider + ': open -> half-open (max open duration ' + (CB_MAX_OPEN_MS / 1000) + 's exceeded, forcing probe)');
        this._syncToRedis();
        return true;
      }
      if (elapsed >= CB_RECOVERY_MS) {
        this.state = 'half-open';
        logger.info('[llm-bridge] [R46-T2] CB ' + this.provider + ': open -> half-open (probe allowed)');
        this._syncToRedis();
        return true;
      }
      return false;
    }
    return true;
  }

  async recordSuccess() {
    if (this.state === 'half-open') {
      logger.info('[llm-bridge] [R46-T2] CB ' + this.provider + ': half-open -> closed (probe succeeded)');
      this._emitCBStateChange('closed', 'probe_succeeded');
    }
    this.state = 'closed';
    this.failures = [];
    this.hardFailures = [];   // [R75-P1-1]
    this.softFailures = [];   // [R75-P1-1]
    this.lastSuccess = Date.now();
    await this._syncToRedis();
  }

  async recordFailure() {
    const now = Date.now();
    // [R75-P1-1] Decay before recording new failure
    this._decay(now);
    this.hardFailures = this.hardFailures.filter(t => now - t < CB_FAILURE_WINDOW_MS);
    this.hardFailures.push(now);
    this.lastHardFailure = now;
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      logger.warn('[llm-bridge] [R46-T2] CB ' + this.provider + ': half-open -> open (probe failed)');
      await this._syncToRedis();
      this._emitCBStateChange('open', 'probe_failed');
      return;
    }
    // Also keep legacy failures array for Redis compat
    this.failures = this.failures.filter(t => now - t < CB_FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.hardFailures.length >= CB_HARD_THRESHOLD) {
      this.state = 'open';
      this.openedAt = now;
      logger.warn('[llm-bridge] [R75-P1-1] CB ' + this.provider + ': closed -> open (' + this.hardFailures.length + ' hard failures in ' + CB_FAILURE_WINDOW_MS + 'ms)');
      await this._syncToRedis();
      this._emitCBStateChange('open', 'hard_threshold_reached');
    }
    await this._syncToRedis();
  }

  // [R75-P1-1] Record a soft failure (empty response, application-level error)
  async recordSoftFailure() {
    const now = Date.now();
    this._decay(now);
    this.softFailures = this.softFailures.filter(t => now - t < CB_FAILURE_WINDOW_MS);
    this.softFailures.push(now);
    this.lastSoftFailure = now;
    // Also keep legacy array for Redis compat
    this.failures = this.failures.filter(t => now - t < CB_FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.softFailures.length >= CB_SOFT_THRESHOLD) {
      this.state = 'open';
      this.openedAt = now;
      logger.warn('[llm-bridge] [R75-P1-1] CB ' + this.provider + ': closed -> open (' + this.softFailures.length + ' soft failures in ' + CB_FAILURE_WINDOW_MS + 'ms)');
      await this._syncToRedis();
      this._emitCBStateChange('open', 'soft_threshold_reached');
    }
    await this._syncToRedis();
  }

  // [R75-P1-1] Decay: halve failure counts if no new failure in decayIntervalMs
  _decay(now) {
    if (this.lastHardFailure && (now - this.lastHardFailure) >= CB_DECAY_MS) {
      const oldLen = this.hardFailures.length;
      this.hardFailures = this.hardFailures.filter(t => now - t < CB_DECAY_MS);
      if (this.hardFailures.length < oldLen) {
        logger.debug('[llm-bridge] [R75-P1-1] CB ' + this.provider + ': hard failures decayed ' + oldLen + '→' + this.hardFailures.length);
      }
    }
    if (this.lastSoftFailure && (now - this.lastSoftFailure) >= CB_DECAY_MS) {
      const oldLen = this.softFailures.length;
      this.softFailures = this.softFailures.filter(t => now - t < CB_DECAY_MS);
      if (this.softFailures.length < oldLen) {
        logger.debug('[llm-bridge] [R75-P1-1] CB ' + this.provider + ': soft failures decayed ' + oldLen + '→' + this.softFailures.length);
      }
    }
  }

  // [R75-P1-1] Emit CB state change event
  async _emitCBStateChange(newState, reason) {
    try {
      const cbStatus = { provider: this.provider, state: newState, reason, hardFailures: this.hardFailures.length, softFailures: this.softFailures.length, timestamp: new Date().toISOString() };
      const { emitEvent } = await import('./event-stream.mjs');
      emitEvent({
        type: 'circuit_breaker_state_change',
        sessionKey: 'system',
        payload: cbStatus,
      });
    } catch (_) {
      // Non-critical, don't throw
    }
  }

  async getStatus() {
    await this._syncFromRedis();
    return {
      provider: this.provider,
      state: this.state,
      recentFailures: this.failures.length,
      hardFailures: this.hardFailures.length,  // [R75-P1-1]
      softFailures: this.softFailures.length,  // [R75-P1-1]
      lastSuccess: this.lastSuccess,
    };
  }

  // [R77-T3] Force reset from external trigger (e.g., Gateway reconnect)
  async forceReset(reason = 'external') {
    const prevState = this.state;
    this.state = 'closed';
    this.failures = [];
    this.hardFailures = [];
    this.softFailures = [];
    this.lastSuccess = Date.now();
    this.openedAt = 0;
    this.lastHardFailure = 0;
    this.lastSoftFailure = 0;
    await this._syncToRedis();
    logger.info('[llm-bridge] [R77-T3] CB ' + this.provider + ': ' + prevState + ' -> closed (force reset: ' + reason + ')');
  }
}
// Initialize one CB per provider
const _circuitBreakers = {};
for (const p of Object.keys(PROVIDERS)) {
  _circuitBreakers[p] = new CircuitBreaker(p);
}

/** Get fallback providers for a given provider */
async function getFallbackProviders(originalProvider) {
  const available = [];
  for (const p of FALLBACK_CHAIN) {
    if (p !== originalProvider && _circuitBreakers[p] && await _circuitBreakers[p].isAvailable() && getApiKey(p)) {
      available.push(p);
    }
  }
  return available;
}

/** Get all circuit breaker statuses */
export async function getCircuitBreakerStatus() {
  const statuses = [];
  for (const cb of Object.values(_circuitBreakers)) {
    statuses.push(await cb.getStatus());
  }
  return statuses;
}


// ═══════════════════════════════════════════════════════════════
// Default Models
// ═══════════════════════════════════════════════════════════════

// [R62-FIX] Reasoning models that only support temperature=1
const REASONING_MODELS = [
  "gpt-5-mini", "gpt-5.5", "gpt-5.5-pro", "o4-mini", "o3", "o3-mini",
  "deepseek-r1", "deepseek-v4-pro", "deepseek-v4-flash",
];
function isReasoningModel(modelId) {
  const lower = (modelId || "").toLowerCase();
  return REASONING_MODELS.some(m => lower.includes(m));
}
function safeTemperature(modelId, temperature) {
  if (isReasoningModel(modelId)) return undefined; // omit for reasoning models
  return temperature;
}
const DEFAULT_MODEL = 'deepseek-v4-pro'; // [COST-OPT] V4Pro for internal calls, GPT-5.5 only for explicit use // [R43-T1] Planner uses strong model
const DEFAULT_TIMEOUT = 45000;

// ═══════════════════════════════════════════════════════════════
// OpenAI Provider
// ═══════════════════════════════════════════════════════════════

function callOpenAI(messages, modelId, temperature, maxTokens, responseFormat, timeout) {
  const _safeTemp = safeTemperature(modelId, temperature);
  const apiKey = getApiKey('openai');
  if (!apiKey) throw new Error('LLM bridge: No OPENAI_API_KEY found');
  
  const body = JSON.stringify({
    model: modelId,
    messages,
    ...(typeof _safeTemp !== "undefined" ? { temperature: _safeTemp } : {}),
    max_completion_tokens: maxTokens,
    stream: false,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`LLM bridge timeout (${timeout}ms)`)); }, timeout);
    
    const req = https.request({
      hostname: PROVIDERS.openai.host,
      port: 443,
      path: PROVIDERS.openai.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (e) { reject(new Error(`OpenAI parse error: ${e.message}`)); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(new Error(`OpenAI request error: ${err.message}`)); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// DeepSeek Provider (R69-B: Direct API, OpenAI-compatible)
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize message content for DeepSeek API.
 * DeepSeek does NOT support image_url content parts — strip them.
 * Array content parts → keep only text, string content → pass through.
 */
function sanitizeDeepSeekContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const textParts = content.filter(p => p.type === 'text');
  if (textParts.length === 0) return '(image-only message removed for DeepSeek compatibility)';
  if (textParts.length === 1) return textParts[0].text;
  return textParts.map(p => p.text).join('\n');
}

function callDeepSeek(messages, modelId, temperature, maxTokens, responseFormat, timeout) {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey('deepseek');
    if (!apiKey) return reject(new Error('[llm-bridge] DEEPSEEK_API_KEY not set'));

    const safeMsgs = messages.map(m => {
      let content = sanitizeDeepSeekContent(m.content);
      // R83: DeepSeek API rejects all response_format types — inject instruction into system prompt instead
      if (m.role === 'system' && responseFormat) {
        if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
          content += `\n\nCRITICAL: You MUST respond with valid JSON matching this schema:\n${JSON.stringify(responseFormat.json_schema.schema)}`;
        } else if (responseFormat.type === 'json_object') {
          content += `\n\nCRITICAL: You MUST respond with valid JSON only. No markdown, no explanation outside JSON.`;
        }
      }
      return {
        role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
        content,
      };
    });

    const body = {
      model: modelId,
      messages: safeMsgs,
      max_tokens: maxTokens || 4000,
    };
    // Reasoning models don't accept temperature
    const safeTemp = safeTemperature(modelId, temperature);
    if (safeTemp !== undefined) body.temperature = safeTemp;
    // R83: DeepSeek API rejects ALL response_format types — never send it, injected into system prompt above

    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: PROVIDERS.deepseek.host,
      port: 443,
      path: PROVIDERS.deepseek.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeout || DEFAULT_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            return reject(new Error(`DeepSeek API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`DeepSeek parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('DeepSeek API timeout')); });
    req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Anthropic Provider
// ═══════════════════════════════════════════════════════════════

function convertToAnthropicMessages(messages) {
  let system = '';
  const converted = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + msg.content;
    } else {
      converted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
    }
  }
  
  return { system, messages: converted };
}

function callAnthropic(messages, modelId, temperature, maxTokens, responseFormat, timeout) {
  const _safeTemp = safeTemperature(modelId, temperature);
  const apiKey = getApiKey('anthropic');
  if (!apiKey) throw new Error('LLM bridge: No ANTHROPIC_API_KEY found');
  
  const { system, messages: anthMessages } = convertToAnthropicMessages(messages);
  
  // If JSON response format requested, add instruction to system prompt
  let effectiveSystem = system;
  if (responseFormat?.type === 'json_object' || responseFormat?.type === 'json_schema') {
    effectiveSystem += '\n\nIMPORTANT: You MUST respond with valid JSON only. No other text before or after the JSON.';
    if (responseFormat.json_schema?.schema) {
      effectiveSystem += `\nJSON Schema to follow: ${JSON.stringify(responseFormat.json_schema.schema)}`;
    }
  }
  
  const body = JSON.stringify({
    model: modelId,
    max_tokens: maxTokens || 4096,
    ...(typeof _safeTemp !== "undefined" ? { temperature: _safeTemp } : {}),
    ...(effectiveSystem ? { system: effectiveSystem } : {}),
    messages: anthMessages,
  });
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`Anthropic timeout (${timeout}ms)`)); }, timeout);
    
    const req = https.request({
      hostname: PROVIDERS.anthropic.host,
      port: 443,
      path: PROVIDERS.anthropic.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': PROVIDERS.anthropic.apiVersion,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Anthropic HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          // Convert Anthropic response to OpenAI format
          const content = parsed.content?.map(c => c.text).join('') || '';
          resolve({
            id: parsed.id,
            object: 'chat.completion',
            model: parsed.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: parsed.stop_reason === 'end_turn' ? 'stop' : parsed.stop_reason,
            }],
            usage: {
              prompt_tokens: parsed.usage?.input_tokens || 0,
              completion_tokens: parsed.usage?.output_tokens || 0,
              total_tokens: (parsed.usage?.input_tokens || 0) + (parsed.usage?.output_tokens || 0),
            },
            _provider: 'anthropic',
            _raw: parsed,
          });
        } catch (e) { reject(new Error(`Anthropic parse error: ${e.message}`)); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(new Error(`Anthropic request error: ${err.message}`)); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Google Gemini Provider
// ═══════════════════════════════════════════════════════════════

function convertToGeminiMessages(messages) {
  let systemInstruction = '';
  const contents = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content;
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }
  
  return { systemInstruction, contents };
}

// [R62-FIX] Strip additionalProperties from JSON schema for Gemini compatibility
function stripAdditionalProperties(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const copy = { ...schema };
  delete copy.additionalProperties;
  if (copy.properties) {
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([k, v]) => [k, stripAdditionalProperties(v)])
    );
  }
  if (copy.items) copy.items = stripAdditionalProperties(copy.items);
  return copy;
}
function callGoogle(messages, modelId, temperature, maxTokens, responseFormat, timeout) {
  const _safeTemp = safeTemperature(modelId, temperature);
  const apiKey = getApiKey('google');
  if (!apiKey) throw new Error('LLM bridge: No GOOGLE_API_KEY found');
  
  const { systemInstruction, contents } = convertToGeminiMessages(messages);
  
  // Map model ID to Gemini API model name
  const geminiModel = modelId.replace('google/', '');
  
  const bodyObj = {
    contents,
    generationConfig: {
      ...(typeof _safeTemp !== "undefined" ? { temperature: _safeTemp } : {}),
      maxOutputTokens: Math.max(maxTokens || 4096, 1024), // [R44-T1] min 1024 for Gemini thinking models
    },
  };
  
  if (systemInstruction) {
    bodyObj.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  
  if (responseFormat?.type === 'json_object' || responseFormat?.type === 'json_schema') {
    bodyObj.generationConfig.responseMimeType = 'application/json';
    if (responseFormat.json_schema?.schema) {
      bodyObj.generationConfig.responseSchema = stripAdditionalProperties(responseFormat.json_schema.schema);
    }
  }
  
  const body = JSON.stringify(bodyObj);
  const path = `/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`Google timeout (${timeout}ms)`)); }, timeout);
    
    const req = https.request({
      hostname: PROVIDERS.google.host,
      port: 443,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Google HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          // Convert Gemini response to OpenAI format
          const candidate = parsed.candidates?.[0];
          const content = candidate?.content?.parts?.map(p => p.text).join('') || '';
          resolve({
            id: `gemini-${Date.now()}`,
            object: 'chat.completion',
            model: geminiModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : candidate?.finishReason?.toLowerCase(),
            }],
            usage: {
              prompt_tokens: parsed.usageMetadata?.promptTokenCount || 0,
              completion_tokens: parsed.usageMetadata?.candidatesTokenCount || 0,
              total_tokens: parsed.usageMetadata?.totalTokenCount || 0,
            },
            _provider: 'google',
            _raw: parsed,
          });
        } catch (e) { reject(new Error(`Google parse error: ${e.message}`)); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(new Error(`Google request error: ${err.message}`)); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════════════

/**
 * Invoke LLM via any supported provider.
 * Returns OpenAI-compatible response format regardless of provider.
 * 
 * @param {Object} options
 * @param {Array<{role: string, content: string}>} options.messages
 * @param {string} [options.model] - Model with optional provider prefix
 * @param {number} [options.temperature=0.3]
 * @param {number} [options.maxTokens=1000]
 * @param {Object} [options.responseFormat] - Response format
 * @param {number} [options.timeout=45000]
 * @returns {Promise<Object>} OpenAI-compatible response
 */
export async function invokeLLM(options) {
  const {
    messages,
    model = DEFAULT_MODEL,
    temperature = 0.3,
    maxTokens = 1000,
    responseFormat,
    response_format: responseFormatAlt,
    timeout = DEFAULT_TIMEOUT,
    _skipFallback = false,  // [R45-T2] internal: prevent recursive fallback
  } = options;
  
  const { provider: originalProvider, modelId } = detectProvider(model);
  const fmt = responseFormat || responseFormatAlt;
  
  // [R45-T2] Check Circuit Breaker
  const cb = _circuitBreakers[originalProvider];
  let activeProvider = originalProvider;
  let activeModelId = modelId;
  let usedFallback = false;
  
  if (cb && !(await cb.isAvailable())) {
    // Provider is circuit-broken, try fallback
    const fallbacks = await getFallbackProviders(originalProvider);
    if (fallbacks.length === 0) {
      logger.error(`[llm-bridge] [R45-T2] All providers unavailable! Forcing ${originalProvider} anyway.`);
    } else {
      activeProvider = fallbacks[0];
      // Map to a default model for the fallback provider
      activeModelId = _getDefaultModel(activeProvider);
      usedFallback = true;
      logger.warn(`[llm-bridge] [R45-T2] CB open for ${originalProvider}, falling back to ${activeProvider}/${activeModelId}`);
    }
  }
  
  logger.info(`[llm-bridge] [R45-T2] provider=${activeProvider} model=${activeModelId} timeout=${timeout}ms${usedFallback ? ' (FALLBACK from ' + originalProvider + ')' : ''}`);
  
  try {
    let result;
    switch (activeProvider) {
      case 'anthropic':
        result = await callAnthropic(messages, activeModelId, temperature, maxTokens, fmt, timeout);
        break;
      case 'google':
        result = await callGoogle(messages, activeModelId, temperature, maxTokens, fmt, timeout);
        break;
      case 'deepseek':
        result = await callDeepSeek(messages, activeModelId, temperature, maxTokens, fmt, timeout);
        break;
      case 'openai':
      default:
        result = await callOpenAI(messages, activeModelId, temperature, maxTokens, fmt, timeout);
        break;
    }
    
    // [R45-T2] Record success
    if (_circuitBreakers[activeProvider]) {
      await _circuitBreakers[activeProvider].recordSuccess();
    }
    
    // [R45-T2] Tag the response with provider info
    result._provider = activeProvider;
    result._originalProvider = originalProvider;
    result._fallback = usedFallback;
    
    // [R45-T2] Emit provider_fallback event if fallback was used
    if (usedFallback) {
      _emitProviderFallback(originalProvider, activeProvider, 'circuit_breaker_open');
    }
    
    return result;
  } catch (err) {
    // [R66-B] Retry on temporary 429 before trying fallbacks
    if (/429|rate.?limit|temporarily rate-limited/i.test(err.message) && !options._429retried) {
      logger.warn(`[llm-bridge] [R66-B] 429 rate limit from ${activeProvider}, retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      try {
        return await invokeLLM({ ...options, _429retried: true });
      } catch (retryErr) {
        logger.warn(`[llm-bridge] [R66-B] 429 retry also failed: ${retryErr.message}`);
        // Fall through to normal error handling
      }
    }
    // [R75-P1-1] Classify and record failure (hard vs soft)
    if (_circuitBreakers[activeProvider]) {
      const errMsg = err.message || '';
      const isHard = /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|scope.*not.*allowed|organization.*disabled|401 Unauthorized|403 Forbidden|timeout|aborted/i.test(errMsg);
      if (isHard) {
        await _circuitBreakers[activeProvider].recordFailure();
      } else {
        await _circuitBreakers[activeProvider].recordSoftFailure();
      }
    }
    
    // [R45-T2] Try fallback on error (only if not already a fallback attempt)
    if (!_skipFallback && !usedFallback) {
      const fallbacks = await getFallbackProviders(activeProvider);
      for (const fbProvider of fallbacks) {
        try {
          const fbModelId = _getDefaultModel(fbProvider);
          logger.warn(`[llm-bridge] [R45-T2] ${activeProvider} failed (${err.message}), trying fallback ${fbProvider}/${fbModelId}`);
          
          const result = await invokeLLM({
            ...options,
            model: `${fbProvider}/${fbModelId}`,
            _skipFallback: true,
          });
          
          result._originalProvider = originalProvider;
          result._fallback = true;
          _emitProviderFallback(originalProvider, fbProvider, err.message);
          return result;
        } catch (fbErr) {
          logger.error(`[llm-bridge] [R45-T2] Fallback ${fbProvider} also failed: ${fbErr.message}`);
          if (_circuitBreakers[fbProvider]) {
            // [R75-P1-1] Classify fallback failure too
            const fbMsg = fbErr.message || '';
            const fbHard = /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|scope.*not.*allowed|organization.*disabled|401 Unauthorized|403 Forbidden|timeout|aborted/i.test(fbMsg);
            if (fbHard) {
              await _circuitBreakers[fbProvider].recordFailure();
            } else {
              await _circuitBreakers[fbProvider].recordSoftFailure();
            }
          }
        }
      }
    }
    
    // All providers failed
    throw err;
  }
}

/** [R45-T2] Default models per provider for fallback */
function _getDefaultModel(provider) {
  switch (provider) {
    case 'openai': return 'gpt-5-mini';
    case 'anthropic': return 'claude-sonnet-4-20250514'; // R52: anthropic disabled
    case 'google': return 'gemini-3.1-pro-preview'; // v4.0: no flash models, use pro
    case 'deepseek': return 'deepseek-v4-pro'; // v4.0: no flash models, use pro
    default: return 'deepseek-v4-pro'; // R81: safe default instead of non-existent gpt-5.5
  }
}

/** [R45-T2] Emit provider_fallback event (fire-and-forget) */
async function _emitProviderFallback(fromProvider, toProvider, reason) {
  try {
    // [BUGFIX] Await getStatus() properly and use await import instead of .then()
    const cbStatus = Object.fromEntries(
      await Promise.all(
        Object.entries(_circuitBreakers).map(async ([k, v]) => [k, await v.getStatus()])
      )
    );
    const { emitEvent } = await import('./event-stream.mjs');
    emitEvent({
      type: 'provider_fallback',
      sessionKey: 'system',
      payload: {
        from_provider: fromProvider,
        to_provider: toProvider,
        reason: reason,
        timestamp: new Date().toISOString(),
        circuit_breaker_status: cbStatus,
      },
    });
  } catch (_) { /* fire-and-forget */ }
}

/**
 * Invoke LLM with JSON response format.
 * Convenience wrapper that sets response_format and parses the JSON.
 */
export async function invokeLLMJson(options) {
  const result = await invokeLLM({
    ...options,
    responseFormat: { type: 'json_object' },
  });
  
  const rawContent = result?.choices?.[0]?.message?.content || '';
  try {
    return {
      ...result,
      content: rawContent,
      json: JSON.parse(rawContent),
    };
  } catch (parseErr) {
    logger.warn(`[llm-bridge] JSON parse failed: ${parseErr.message}`);
    return {
      ...result,
      content: rawContent,
      json: null,
    };
  }
}

/**
 * List available providers and their status.
 */
export function getProviderStatus() {
  return Object.entries(PROVIDERS).map(([name, cfg]) => ({
    name,
    hasKey: !!getApiKey(name),
    host: cfg.host,
  }));
}

export default { invokeLLM, invokeLLMJson, getProviderStatus, getCircuitBreakerStatus };
