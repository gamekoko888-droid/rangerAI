/**
 * sub-agent-compactor.mjs — Iter-D: Sub-Agent Result Normalization
 * 
 * Problem: sessions_spawn sub-agents inject their full conversation history
 * back into the main thread, causing 5000+ token bloat per sub-task.
 * 
 * Solution:
 *   - Short tasks (<=10 rounds): Return last assistant message only (no LLM)
 *   - Long tasks (>10 rounds): Call gpt-5-mini to generate execution report (<=300 chars)
 * 
 * Report format:
 *   完成状态 | 产物路径 | 未完成项
 *   (No intermediate reasoning, no tool call details)
 */

import { logger } from '../lib/logger.mjs';
import { readFileSync } from 'fs';
import http from 'http';
import { recordCompression } from './observability.mjs'; // [R13-T2]

const ts = () => new Date().toISOString();

// ─── Configuration ──────────────────────────────────────────
const CONFIG = {
  SHORT_TASK_THRESHOLD: 10,  // <=10 rounds = short task
  REPORT_MAX_CHARS: 300,     // Max chars for LLM-generated report
  REPORT_MAX_TOKENS: 200,    // Max tokens for LLM call
  LLM_TIMEOUT_MS: 10000,    // 10s timeout for LLM call
  MODEL: 'deepseek/deepseek-v4-pro' // R64: mini->V4Pro,
};

// ─── Gateway LLM Call ───────────────────────────────────────
let _gwToken = "";
try { _gwToken = readFileSync("/home/admin/.openclaw/gateway.token", "utf-8").trim(); } catch(e) { /* ignore */ }

function _callCompactorLLMOnce(messages, maxTokens = 200) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CONFIG.MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
      stream: false,
    });
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error("sub-agent-compactor LLM timeout"));
    }, CONFIG.LLM_TIMEOUT_MS);
    
    const req = http.request({
      hostname: "127.0.0.1",
      port: 18789,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${_gwToken || process.env.GATEWAY_API_KEY || ""}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        clearTimeout(timeout);
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Gateway HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || "";
          resolve(content);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", (err) => { clearTimeout(timeout); reject(err); });
    req.write(body);
    req.end();
  });
}


// [R66-B] Rate limit retry wrapper for sub-agent compactor
async function callCompactorLLM(messages, maxTokens = 200) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _callCompactorLLMOnce(messages, maxTokens);
    } catch (err) {
      if (/429|rate.?limit|temporarily rate-limited/i.test(err.message) && attempt < MAX_RETRIES) {
        logger.info(`[R66-B] sub-agent-compactor 429 retry ${attempt}/${MAX_RETRIES}, waiting 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

// ─── Sub-Agent Compaction Prompt ────────────────────────────
const COMPACTOR_PROMPT = `你是一个子任务执行报告生成器。将子 Agent 的完整对话历史压缩为简短的执行报告。

**输出格式（严格遵守，不超过300字）**：
完成状态：[成功/部分完成/失败]
产物：[列出所有产出的文件路径、URL，必须完整保留]
未完成：[如有未完成项，列出；如全部完成，写"无"]

**铁律**：
1. 所有文件路径和 URL 必须完整保留，不可缩写
2. 禁止包含中间推理过程
3. 禁止包含工具调用细节
4. 禁止包含对话的具体措辞
5. 只保留最终结果和产物信息
6. 输出必须是中文`;

// ─── Main API ───────────────────────────────────────────────

/**
 * Compact a sub-agent's conversation history into a brief report.
 * 
 * @param {Array} messages - Sub-agent's full conversation history [{role, content}, ...]
 * @param {object} options - { agentId, taskDescription }
 * @returns {Promise<{ report: string, _compressed: boolean, method: string, originalTokens: number }>}
 */
export async function compactSubAgentResult(messages, options = {}) {
  const { agentId = 'unknown', taskDescription = '' } = options;
  
  if (!messages || messages.length === 0) {
    return {
      report: '[子 Agent 执行报告]\n完成状态：未知（无消息记录）\n产物：无\n未完成：无法判断',
      _compressed: true,
      method: 'empty',
      originalTokens: 0,
    };
  }
  
  // Estimate original token count
  const originalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return sum + content.length;
  }, 0);
  const originalTokens = Math.ceil(originalChars / 3.5);
  
  // Count rounds (user-assistant pairs)
  const rounds = messages.filter(m => m.role === 'user').length;
  
  logger.info(`[${ts()}] [sub-agent-compactor] agent=${agentId}, rounds=${rounds}, originalTokens≈${originalTokens}`);
  
  // ─── Short task: extract last assistant message ───
  if (rounds <= CONFIG.SHORT_TASK_THRESHOLD) {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    const content = lastAssistant?.content || '(无助手回复)';
    const truncated = content.length > CONFIG.REPORT_MAX_CHARS 
      ? content.substring(0, CONFIG.REPORT_MAX_CHARS) + '...'
      : content;
    
    const report = `[子 Agent 执行报告]\n${truncated}`;
    
    logger.info(`[${ts()}] [sub-agent-compactor] SHORT task (${rounds} rounds): extracted last assistant msg, ${report.length} chars (saved ≈${originalTokens - Math.ceil(report.length / 3.5)} tokens)`);
    
    // [R13-T2] Record sub-agent compact to DB
    const compactedTokens = Math.ceil(report.length / 3.5);
    recordCompression('sub_agent_compact', originalTokens - compactedTokens, {
      sessionKey: options.sessionKey || 'unknown',
      tokensBefore: originalTokens,
      tokensAfter: compactedTokens,
      extraJson: {
        subAgentId: agentId,
        rounds,
        originalChars: originalChars,
        compactChars: report.length,
        compactMethod: 'last_message',
        truncated: content.length > CONFIG.REPORT_MAX_CHARS,
        compressionRatio: originalTokens > 0 ? Math.round((compactedTokens / originalTokens) * 100) / 100 : 1,
      },
    });
    logger.info(`[R13-T2] sub_agent_compact: agent=${agentId}, method=short_extract, saved=${originalTokens - compactedTokens} tokens`);

    return {
      report,
      _compressed: true,
      method: 'short_extract',
      originalTokens,
      compactedTokens,
    };
  }
  
  // ─── Long task: LLM-generated execution report ───
  try {
    // Format messages for LLM (truncate each to save input tokens)
    const formatted = messages
      .filter(m => m.content && typeof m.content === 'string' && m.content.trim().length > 0)
      .map(m => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
        const content = m.content.length > 1000
          ? m.content.substring(0, 800) + '...(截断)...' + m.content.substring(m.content.length - 200)
          : m.content;
        return `[${role}]: ${content}`;
      })
      .join('\n');
    
    const taskCtx = taskDescription ? `\n任务描述：${taskDescription}` : '';
    
    const report = await callCompactorLLM([
      { role: 'system', content: COMPACTOR_PROMPT },
      { role: 'user', content: `以下是子 Agent (${agentId}) 的完整对话历史（${rounds}轮）：${taskCtx}\n\n${formatted}` }
    ], CONFIG.REPORT_MAX_TOKENS);
    
    const finalReport = `[子 Agent 执行报告]\n${report.substring(0, CONFIG.REPORT_MAX_CHARS)}`;
    const compactedTokens = Math.ceil(finalReport.length / 3.5);
    
    logger.info(`[${ts()}] [sub-agent-compactor] LONG task (${rounds} rounds): LLM report generated, ${finalReport.length} chars, saved ≈${originalTokens - compactedTokens} tokens`);
    
    // [R13-T2] Record sub-agent compact to DB
    recordCompression('sub_agent_compact', originalTokens - compactedTokens, {
      sessionKey: options.sessionKey || 'unknown',
      tokensBefore: originalTokens,
      tokensAfter: compactedTokens,
      extraJson: {
        subAgentId: agentId,
        rounds,
        originalChars: originalChars,
        compactChars: finalReport.length,
        compactMethod: 'llm_summary',
        truncated: report.length > CONFIG.REPORT_MAX_CHARS,
        compressionRatio: originalTokens > 0 ? Math.round((compactedTokens / originalTokens) * 100) / 100 : 1,
      },
    });
    logger.info(`[R13-T2] sub_agent_compact: agent=${agentId}, method=llm_report, saved=${originalTokens - compactedTokens} tokens`);

    return {
      report: finalReport,
      _compressed: true,
      method: 'llm_report',
      originalTokens,
      compactedTokens,
    };
  } catch (err) {
    logger.error(`[${ts()}] [sub-agent-compactor] LLM call failed: ${err.message}, using fallback`);
    
    // Fallback: extract last assistant message
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    const content = lastAssistant?.content || '(LLM压缩失败，无法提取结果)';
    const truncated = content.length > CONFIG.REPORT_MAX_CHARS 
      ? content.substring(0, CONFIG.REPORT_MAX_CHARS) + '...'
      : content;
    
    // [R13-T2] Record fallback compact to DB
    const fbCompactedTokens = Math.ceil(truncated.length / 3.5);
    recordCompression('sub_agent_compact', originalTokens - fbCompactedTokens, {
      sessionKey: options.sessionKey || 'unknown',
      tokensBefore: originalTokens,
      tokensAfter: fbCompactedTokens,
      extraJson: {
        subAgentId: agentId,
        rounds,
        originalChars: originalChars,
        compactChars: truncated.length,
        compactMethod: 'fallback_extract',
        truncated: content.length > CONFIG.REPORT_MAX_CHARS,
        compressionRatio: originalTokens > 0 ? Math.round((fbCompactedTokens / originalTokens) * 100) / 100 : 1,
      },
    });

    return {
      report: `[子 Agent 执行报告]\n${truncated}`,
      _compressed: true,
      method: 'fallback_extract',
      originalTokens,
      compactedTokens: fbCompactedTokens,
    };
  }
}

export { CONFIG as SUB_AGENT_COMPACTOR_CONFIG };

// ─── Iter-X: microCompact ────────────────────────────────────────────────────
const MICRO_COMPACT_MAX_CHARS = 800; // ≈200 tokens，超过才压缩

/**
 * 将子 Agent 字符串结果压缩为摘要块。
 * 短结果（≤800字符）直接返回，不调 LLM。
 * 长结果调 gpt-5-mini 生成固定格式摘要。
 *
 * @param {string} rawResult - 子 Agent 原始输出字符串
 * @param {string} [taskDesc=''] - 任务描述（用于压缩提示，≤100字符）
 * @returns {Promise<string>} 压缩后的摘要块或原文
 */
export async function microCompact(rawResult, taskDesc = '') {
  if (!rawResult || typeof rawResult !== 'string') return rawResult || '';
  if (rawResult.length <= MICRO_COMPACT_MAX_CHARS) return rawResult; // 短结果直通

  const originalLen = rawResult.length;
  const prompt = [
    {
      role: 'system',
      content: '你是一个结果摘要压缩器。将子任务执行结果压缩为≤200字的中文摘要，格式严格如下：\n[子任务摘要]\n结论: （一句话）\n产物: （文件路径/URL，无则写"无"）\n状态: 成功/失败/部分完成\n[/子任务摘要]\n不要输出其他内容。',
    },
    {
      role: 'user',
      content: `任务：${taskDesc ? taskDesc.slice(0, 100) : '子任务'}\n\n原始结果：\n${rawResult.slice(0, 3000)}`,
    },
  ];

  try {
    const compressed = await callCompactorLLM(prompt, 250);
    if (compressed && compressed.length > 20) {
      logger.info(`[${ts()}] [micro-compact] ${originalLen} → ${compressed.length} chars`);
      return compressed;
    }
  } catch (err) {
    logger.warn(`[${ts()}] [micro-compact] LLM failed: ${err.message}, using truncation`);
  }

  // fallback: 截断
  return `[子任务摘要]\n结论: ${rawResult.slice(0, 150)}...\n产物: 无\n状态: 部分（压缩失败）\n[/子任务摘要]`;
}
