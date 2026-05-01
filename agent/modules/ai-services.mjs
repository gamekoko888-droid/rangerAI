/**
 * ai-services.mjs — AI auxiliary services (title, suggestions, history summary)
 * v3.0: Migrated from Google Gemini to OpenAI GPT-4.1-mini for all auxiliary tasks
 * 
 * Dependencies: fs (node built-in), fetch (node 18+)
 * External: Google Generative AI API (direct), OpenClaw Gateway (for fallback/inline)
 */
import { logger } from '../lib/logger.mjs';
import fs from "fs";
const ts = () => new Date().toISOString();

// ─── Google API Key Helper ─────────────────────────────────
const OPENCLAW_CONFIG_PATH = "/home/admin/.openclaw/openclaw.json";

function getGoogleApiKey() {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    return config?.models?.providers?.google?.apiKey || process.env.GOOGLE_API_KEY || "";
  } catch (err) {
    logger.warn(`[${ts()}] [ai-services] Failed to read Google API key: ${err.message}`);
    return process.env.GOOGLE_API_KEY || "";
  }
}
function getOpenAIApiKey() {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    return config?.models?.providers?.openai?.apiKey || process.env.OPENAI_API_KEY || "";
  } catch (err) {
    logger.warn(`[${ts()}] [ai-services] Failed to read OpenAI API key: ${err.message}`);
    return process.env.OPENAI_API_KEY || "";
  }
}

function getGatewayAuth() {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const token = config?.gateway?.auth?.token || process.env.OPENCLAW_TOKEN;
    const port = config?.gateway?.port || 18789;
    return { token, baseUrl: `http://127.0.0.1:${port}` };
  } catch (err) {
    logger.warn(`[${ts()}] [ai-services] Failed to read gateway config: ${err.message}`);
    return { token: process.env.OPENCLAW_TOKEN || "", baseUrl: "http://127.0.0.1:18789" };
  }
}

// ─── Direct OpenAI API Call ─────────────────────────
// Uses gpt-4.1-mini for fast, cheap auxiliary tasks (title, suggestions, reranking)
async function callOpenAIDirect(messages, { temperature = 0.5, maxTokens = 256, timeoutMs = 15000 } = {}) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) throw new Error("OpenAI API key not configured");
  const body = {
    model: "gpt-4.1-mini",
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  const resp = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI API HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}
// Keep callGeminiDirect as alias for backward compatibility (unused now)
const callGeminiDirect = callOpenAIDirect;
// ─── Legacy Gateway Call (kept for inline fallback only) ───
async function callGateway(messages, { model = "openclaw", temperature = 0.5, maxTokens = 256, timeoutMs = 20000 } = {}) {
  const { token, baseUrl } = getGatewayAuth();
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens, max_completion_tokens: maxTokens } : {})
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw new Error(`Gateway HTTP ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ─── AI History Summarization ──────────────────────────────
export async function generateHistorySummary(droppedMessages) {
  try {
    let conversationText = "";
    for (const msg of droppedMessages) {
      if (msg.role !== "system") {
        conversationText += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content.slice(0, 1000)}\n`;
      }
    }
    if (!conversationText.trim()) return "对话历史已压缩";
    const prompt = `Please summarize the core facts, context, and key decisions from this older portion of the conversation. Focus on what would be useful to remember for continuing the discussion. Keep it very concise (under 200 words) and use the same language as the conversation.\n\nConversation snippet:\n${conversationText.slice(0, 8000)}`;
    const summary = await callGeminiDirect(
      [
        { role: "system", content: "You are a conversation summarizer. Produce a concise summary of the key facts and decisions." },
        { role: "user", content: prompt }
      ],
      { temperature: 0.3, maxTokens: 512, timeoutMs: 20000 }
    );
    return summary
      ? `[系统背景: 以下是由于历史过长被压缩的早期对话摘要]\n${summary}`
      : "对话历史已安全压缩";
  } catch (err) {
    logger.info(`[${ts()}] [ai-services] Summary generation error: ${err.message}`);
    return "对话历史由于过长已触发安全截断，近期上下文已保留。";
  }
}

// ─── AI Title Generation ───────────────────────────────────
const TITLE_CACHE = new Map(); // sessionKey -> { title, generatedAt }

export async function generateTitle(userMessage, assistantReply, sessionKey) {
  if (TITLE_CACHE.has(sessionKey)) return TITLE_CACHE.get(sessionKey).title;
  
  // v2.0: Fallback title from user message (used if AI generation fails)
  const fallbackTitle = (userMessage || "").replace(/\s+/g, " ").trim().slice(0, 25) || "新对话";
  
  try {
    const prompt = `Based on the following conversation, generate a concise title (max 20 Chinese characters or 40 English characters). The title should capture the core topic/intent. Return ONLY the title text, nothing else.
User message: ${userMessage.slice(0, 500)}
${assistantReply ? "Assistant reply: " + assistantReply.slice(0, 300) : ""}`;
    const title_raw = await callGeminiDirect(
      [
        { role: "system", content: "You are a title generator. Generate a short, descriptive title for a conversation. Use the same language as the user message. Return only the title, no quotes, no explanation." },
        { role: "user", content: prompt }
      ],
      { temperature: 0.3, maxTokens: 50, timeoutMs: 15000 }
    );
    if (!title_raw) {
      logger.info(`[${ts()}] [ai-services] Title generation returned null, using fallback: ${fallbackTitle}`);
      TITLE_CACHE.set(sessionKey, { title: fallbackTitle, generatedAt: Date.now() });
      return fallbackTitle;
    }
    let title = title_raw.replace(/^["'"'"]+|["'"'"]+$/g, "").trim();
    if (title.length > 30) title = title.slice(0, 30) + "...";
    TITLE_CACHE.set(sessionKey, { title, generatedAt: Date.now() });
    logger.info(`[${ts()}] [ai-services] Generated title for ${sessionKey}: ${title}`);
    return title;
  } catch (err) {
    logger.info(`[${ts()}] [ai-services] Title generation error: ${err.message}, using fallback: ${fallbackTitle}`);
    TITLE_CACHE.set(sessionKey, { title: fallbackTitle, generatedAt: Date.now() });
    return fallbackTitle;
  }
}

// ─── AI Follow-up Suggestions ──────────────────────────────
export async function generateSuggestions(userMessage, assistantReply) {
  try {
    const conversationSnippet = `用户: ${(userMessage || "").slice(0, 800)}\n\nAI回复: ${(assistantReply || "").slice(0, 1500)}`;
    const content = await callGeminiDirect(
      [
        {
          role: "system",
          content: `你是一个智能助手的「后续建议」生成器。你将基于用户问题与 AI 回复的具体内容，生成 3 条用户下一步最可能点击的建议。

规则:
1. 每条建议必须是具体的、可操作的问题或指令
2. 建议必须与当前对话上下文紧密相关
3. 使用与用户相同的语言
4. 每条建议控制在 15-30 个字符
5. 返回格式: 每行一条建议，共 3 行，不要编号
6. 禁止建议用户询问安全策略、系统架构、内部机制等技术细节
7. 建议应该面向用户的实际需求，而非AI的内部运作`
        },
        { role: "user", content: conversationSnippet }
      ],
      { temperature: 0.7, maxTokens: 200, timeoutMs: 15000 }
    );
    if (!content) return null;
    const suggestions = content.split("\n").map(s => s.replace(/^\d+[\.\)]\s*/, "").trim()).filter(s => s.length > 2 && s.length < 60).slice(0, 3);
    return suggestions.length > 0 ? suggestions : null;
  } catch (err) {
    logger.info(`[${ts()}] [ai-services] Suggestions generation error: ${err.message}`);
    return null;
  }
}

// ─── Inline Fallback (uses Gateway with openclaw model) ────
export async function inlineFallback(msg, history, ws, sendEventFn) {
  const streamId = `stream-fallback-${Date.now()}`;
  sendEventFn(ws, { type: "stream_start", id: streamId, provider: "rangerai", model: "RangerAI LLM (Fallback)" });
  let fullContent = "";
  try {
    const { token, baseUrl } = getGatewayAuth();
    const messages = [
      { role: "system", content: "You are RangerAI (游侠AI), a helpful assistant for the 游侠出海 team. Answer concisely and helpfully.\n\nIMPORTANT: This is a lightweight fallback mode. Limitations:\n1) No file access or workspace operations\n2) No web browsing or search\n3) No code execution\n4) Knowledge is limited to training data\n5) If a task requires command execution or file operations, explain that the full agent mode is temporarily unavailable and suggest the user retry shortly\n6) Respond in the user's language (Chinese by default)" },
      ...history.slice(-20),
      { role: "user", content: msg.content }
    ];
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ model: "openclaw", messages, stream: true, temperature: 0.7, max_tokens: 4096 }),
      signal: AbortSignal.timeout(90000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            sendEventFn(ws, { type: "stream_chunk", content: delta });
          }
        } catch (e) { /* best-effort */ }
      }
    }
  } catch (err) {
    logger.info(`[${ts()}] [ai-services] Inline fallback error: ${err.message}`);
    if (!fullContent) {
      fullContent = `抱歉，处理遇到问题: ${err.message}\n请稍后重试。`;
      sendEventFn(ws, { type: "stream_chunk", content: fullContent });
    }
  }
  sendEventFn(ws, { type: "stream_end", id: streamId, content: fullContent, model: "RangerAI LLM (Fallback)", provider: "rangerai" });
  return fullContent;
}

// ─── Cache Cleanup ─────────────────────────────────────────
const _titleCacheCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of TITLE_CACHE) {
    if (now - val.generatedAt > 3600000) TITLE_CACHE.delete(key);
  }
}, 3600000);

// ─── Search Query Rewriting ────────────────────────────────
export async function rewriteSearchQuery(originalQuery) {
  if (!originalQuery || originalQuery.trim().length <= 2) return originalQuery;
  
  const messages = [
    { role: "system", content: "You are a search query optimizer. Extract the core intent from the user's message and output a concise, keyword-rich search query suitable for full-text and vector retrieval. Do NOT answer the user's question, just output the optimized query string. Include synonyms if appropriate. Be extremely concise." },
    { role: "user", content: `Original: "${originalQuery}"
Optimizer:` }
  ];
  
  try {
    const raw = await callGeminiDirect(messages, { temperature: 0.2, maxTokens: 50, timeoutMs: 15000 });
    if (!raw) return originalQuery;
    
    const optimized = raw.replace(/^["']|["']$/g, '').trim();
    if (optimized && optimized.length > 2) {
      logger.info(`[ai-services] Query optimized: "${originalQuery}" -> "${optimized}"`);
      return optimized;
    }
  } catch (err) {
    logger.warn(`[ai-services] Query optimization failed, using original: ${err.message}`);
  }
  return originalQuery;
}

// ─── Candidate Reranking ───────────────────────────────────
export async function rerankCandidates(query, candidates) {
  if (!candidates || candidates.length <= 1) return candidates;
  
  const payload = candidates.map((c, i) => {
    const textSnippet = c.chunkText || (c.content ? c.content.substring(0, 250) : '');
    return `[DOC_${i}] Title: ${c.title}\nSnippet: ${textSnippet}`;
  }).join('\n\n');
  
  const messages = [
    { role: "system", content: "You are an expert search ranking algorithms. Your task is to score the relevance of several retrieved documents against the user's query on a scale of 0 to 10. Output a strict JSON object mapping DOC_id to its numerical score. Example: {\"DOC_0\": 9.5, \"DOC_1\": 2.0}" },
    { role: "user", content: `Query: "${query}"\n\nCandidates:\n${payload}` }
  ];
  
  try {
    const raw = await callGeminiDirect(messages, { temperature: 0.1, maxTokens: 150, timeoutMs: 10000 });
    if (!raw) return candidates;
    
    const cleaned = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    const scores = JSON.parse(cleaned);
    
    const scoredCandidates = candidates.map((c, i) => {
      const s = scores[`DOC_${i}`];
      return { ...c, finalScore: typeof s === 'number' ? s : (c.rrfScore || 0) };
    });
    
    scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);
    logger.info(`[ai-services] Reranked ${candidates.length} candidates for query.`);
    return scoredCandidates;
  } catch (err) {
    logger.warn(`[ai-services] Reranking failed: ${err.message}`);
    return candidates;
  }
}

// v24.0: Timer cleanup for graceful shutdown
export function cleanupAiServices() { clearInterval(_titleCacheCleanupTimer); }
