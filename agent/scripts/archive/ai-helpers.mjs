/**
 * AI Helpers Module — Extracted from server.mjs v73
 * Contains AI-powered history summarization, title generation, and follow-up suggestions.
 */
import { logger } from './lib/logger.mjs';
import fs from "fs";

const ts = () => new Date().toISOString();

// ─── AI History Summarization ───────────────────────────────
export async function generateHistorySummary(droppedMessages) {
  try {
    const configPath = "/home/admin/.openclaw/openclaw.json";
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const token = config?.gateway?.auth?.token || process.env.OPENCLAW_TOKEN;
    
    // Extract only the important info to keep prompt small
    let conversationText = "";
    for (const msg of droppedMessages) {
       if (msg.role !== 'system') {
           // Skip huge base64 blocks or giant text in the dropped history to save tokens
           conversationText += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content.slice(0, 1000)}\n`;
       }
    }
    
    if (!conversationText.trim()) return "对话历史已压缩";

    const prompt = `Please summarize the core facts, context, and key decisions from this older portion of the conversation. Focus on what would be useful to remember for continuing the discussion. Keep it very concise (under 200 words) and use the same language as the conversation.\n\nConversation snippet:\n${conversationText.slice(0, 8000)}`;

    const resp = await fetch("http://127.0.0.1:18789/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        model: "gemini-2.5-flash",
        messages: [
          { role: "system", content: `你是一个智能助手的「后续建议」生成器。你将基于用户问题与 AI 回复的具体内容，生成 3 条用户下一步最可能点击的建议。

核心原则：
1) **紧扣任务结果**：如果 AI 生成了文件（代码/文档/图表），建议必须包含"查看/运行/修改该文件"。如果 AI 进行了搜索，建议必须包含"深入挖掘[具体点]"。
2) **具体实体**：建议中必须包含对话中的具体关键词（如"BTC"、"财报"、"server.mjs"、"部署脚本"等），严禁使用"查看详情"、"继续优化"、"下一步做什么"等通用废话。
3) **短指令格式**：建议必须是用户可以直接发送的指令，每条长度控制在 6-18 字以内。
4) **多样性**：
   - 建议 1：针对当前结果的直接操作（如"运行代码"、"打开生成的 HTML"）。
   - 建议 2：当前任务的逻辑下一步（如"添加错误处理"、"搜索竞品对比"）。
   - 建议 3：发散或验证性问题（如"这样做的风险是什么"、"有没有更优方案"）。

输出格式：仅返回一个 JSON 字符串数组，例如：["运行测试脚本", "优化错误处理逻辑", "部署到生产环境"]。不要包含 Markdown 格式标记或其他解释文字。` },
          { role: "user", content: conversationText.slice(0, 8000) }
        ],
        temperature: 0.5,
        max_tokens: 256
      }),
      signal: AbortSignal.timeout(20000)
    });
    
    if (!resp.ok) return "由于对话历史过长已触发截断，保留近期对话以防止溢出。";
    
    const data = await resp.json();
    let summary = data.choices?.[0]?.message?.content?.trim();
    return summary ? `[系统背景: 以下是由于历史过长被压缩的早期对话摘要]\n${summary}` : "对话历史已安全压缩";
  } catch (err) {
    logger.info(`[${ts()}] Summary generation error: ${err.message}`);
    return "对话历史由于过长已触发安全截断，近期上下文已保留。";
  }
}

// ─── AI Title Generation ────────────────────────────────────
const TITLE_CACHE = new Map(); // sessionKey -> { title, generatedAt }

export async function generateTitle(userMessage, assistantReply, sessionKey) {
  // Skip if already generated for this session
  if (TITLE_CACHE.has(sessionKey)) return TITLE_CACHE.get(sessionKey).title;
  
  try {
    const configPath = "/home/admin/.openclaw/openclaw.json";
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const token = config?.gateway?.auth?.token || process.env.OPENCLAW_TOKEN;
    
    const prompt = `Based on the following conversation, generate a concise title (max 20 Chinese characters or 40 English characters). The title should capture the core topic/intent. Return ONLY the title text, nothing else.

User message: ${userMessage.slice(0, 500)}
${assistantReply ? "Assistant reply: " + assistantReply.slice(0, 300) : ""}`;

    const resp = await fetch("http://127.0.0.1:18789/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "You are a title generator. Generate a short, descriptive title for a conversation. Use the same language as the user message. Return only the title, no quotes, no explanation." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_completion_tokens: 50
      }),
      signal: AbortSignal.timeout(15000)
    });
    
    if (!resp.ok) {
      logger.info(`[${ts()}] Title generation HTTP error: ${resp.status}`);
      return null;
    }
    
    const data = await resp.json();
    let title = data.choices?.[0]?.message?.content?.trim();
    
    if (!title) return null;
    
    // Clean up: remove quotes, limit length
    title = title.replace(/^["'"'"]+|["'"'"]+$/g, "").trim();
    if (title.length > 30) title = title.slice(0, 30) + "...";
    
    TITLE_CACHE.set(sessionKey, { title, generatedAt: Date.now() });
    logger.info(`[${ts()}] Generated title for ${sessionKey}: ${title}`);
    return title;
  } catch (err) {
    logger.info(`[${ts()}] Title generation error: ${err.message}`);
    return null;
  }
}

// ─── AI Follow-up Suggestions Generation ────────────────────
export async function generateSuggestions(userMessage, assistantReply) {
  try {
    const configPath = "/home/admin/.openclaw/openclaw.json";
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const token = config?.gateway?.auth?.token || process.env.OPENCLAW_TOKEN;
    
    const conversationSnippet = `用户: ${(userMessage || "").slice(0, 800)}\n\nAI回复: ${(assistantReply || "").slice(0, 1500)}`;
    
    const resp = await fetch("http://127.0.0.1:18789/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: `你是一个智能助手的「后续建议」生成器。你将基于用户问题与 AI 回复的具体内容，生成 3 条用户下一步最可能点击的建议。

核心目标：这三条建议必须是用户**真的想点击**的下一步操作，能够帮助用户节省打字时间，直接推动任务进展。

建议策略：
1. **深入追问**：针对 AI 回复中的关键信息点，进行深入挖掘。
2. **相关操作**：如果 AI 给出了代码，建议运行或修改；如果给出了数据，建议分析或可视化。
3. **实际行动**：建议用户让 RangerAI 执行具体操作（如写脚本、分析数据、搜索信息）。

格式要求：
- 必须是**用户发送给 AI 的指令**（第一人称或祈使句）。
- 简短有力（15 字以内）。
- 禁止客套话（如"谢谢"、"很好"）。
- 输出 JSON 数组：["建议1", "建议2", "建议3"]。\n\n非常重要：只输出一个 JSON 数组，严禁其他解释文本。` },
          { role: "user", content: conversationSnippet }
        ],
        temperature: 0.7,
        max_tokens: 150
      }),
      signal: AbortSignal.timeout(20000)
    });
    
    if (!resp.ok) {
      logger.info(`[${ts()}] Suggestions generation HTTP error: ${resp.status}`);
      return null;
    }
    
    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;
    
    // Parse JSON array from response
    // Handle cases where LLM wraps in markdown code block
    content = content.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
    
    try {
      const suggestions = JSON.parse(content);
      if (Array.isArray(suggestions) && suggestions.length >= 2) {
        const result = suggestions.slice(0, 3).map(s => String(s).trim()).filter(s => s.length > 0 && s.length <= 15);
        if (result.length >= 2) {
          logger.info(`[${ts()}] Generated suggestions: ${JSON.stringify(result)}`);
          return result;
        }
      }
    } catch (parseErr) {
      logger.info(`[${ts()}] Suggestions JSON parse error: ${parseErr.message}, content: ${content.slice(0, 200)}`);
    }
    
    return null;
  } catch (err) {
    logger.info(`[${ts()}] Suggestions generation error: ${err.message}`);
    return null;
  }
}

// Clean up old title cache entries every hour
const _aiHelpersCacheTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of TITLE_CACHE) {
    if (now - val.generatedAt > 3600000) TITLE_CACHE.delete(key);
  }
}, 3600000);

export { TITLE_CACHE };
