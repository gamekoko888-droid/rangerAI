import { logger } from '../lib/logger.mjs';
/**
 * memory-extractor.mjs — 对话后异步提取用户记忆并持久化
 * v2: 增加容量管理 — 当记忆超过阈值时自动压缩摘要
 * 
 * 提取规则：
 *   - 用户偏好（语言、格式、工作习惯）
 *   - 用户身份（角色、部门、职责）
 *   - 重要决策和约定
 *   - 用户明确要求"记住"的内容
 *   - 不记录敏感信息（密码、密钥等）
 */

const ts = () => new Date().toISOString();

const MEMORY_SOFT_LIMIT = 2000;   // 超过此值触发压缩
const MEMORY_HARD_LIMIT = 3000;   // 绝对上限，强制截断
const COMPRESS_TARGET = 1200;     // 压缩后的目标长度

/**
 * 内部 HTTP 请求工具
 */
async function httpRequest(method, path, body = null) {
  const http = (await import('http')).default;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1', port: 3002,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-call': '1',
      },
    };
    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(method === 'POST' ? 30000 : 5000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * 调用 LLM 进行记忆压缩
 */
async function compressMemory(currentMemory) {
  logger.info(`[${ts()}] [memory-compress] Memory length ${currentMemory.length} exceeds soft limit ${MEMORY_SOFT_LIMIT}, compressing...`);
  
  const compressPrompt = `你是一个信息压缩专家。请将以下用户记忆列表压缩到 ${COMPRESS_TARGET} 字符以内。

当前记忆（${currentMemory.length} 字符）：
${currentMemory}

压缩规则：
1. 保留最重要和最新的信息
2. 合并重复或相似的条目
3. 删除过时或不再相关的信息
4. 保持 "- " 开头的列表格式
5. 优先保留：用户身份、核心偏好、重要决策
6. 可以删除：临时性记录、已完成的任务备注
7. 不要添加任何解释，直接输出压缩后的记忆列表

直接输出压缩后的记忆列表：`;

  try {
    const result = await httpRequest('POST', '/api/chat/simple', {
      message: compressPrompt,
      model: 'openai/gpt-5-mini',
    });
    
    let compressed = (result.reply || result.content || result.message || '').trim();
    // 清理 markdown 代码块标记
    compressed = compressed
      .replace(/^```[\s\S]*?\n/, '')
      .replace(/\n```\s*$/, '')
      .trim();
    
    if (compressed.length >= 10 && compressed.length < currentMemory.length) {
      logger.info(`[${ts()}] [memory-compress] Compressed: ${currentMemory.length} → ${compressed.length} chars`);
      return compressed;
    } else {
      logger.warn(`[${ts()}] [memory-compress] Compression result invalid (${compressed.length} chars), keeping original`);
      // Fallback: 硬截断到目标长度，在最后一个完整行处截断
      return hardTruncate(currentMemory, COMPRESS_TARGET);
    }
  } catch (err) {
    logger.warn(`[${ts()}] [memory-compress] LLM compression failed: ${err.message}, using hard truncate`);
    return hardTruncate(currentMemory, COMPRESS_TARGET);
  }
}

/**
 * 硬截断 — 在最后一个完整行处截断
 */
function hardTruncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxLen * 0.5) {
    return truncated.slice(0, lastNewline).trim();
  }
  return truncated.trim();
}

/**
 * 从对话中提取需要持久化的记忆
 * @param {string} userId - 用户ID
 * @param {string} userMessage - 用户最新消息
 * @param {string} assistantReply - AI 最新回复
 * @param {Array} conversationHistory - 对话历史
 */
export async function extractAndSaveMemory(userId, userMessage, assistantReply, conversationHistory = []) {
  if (!userId || userId === 'system') return;
  
  // 只在有意义的对话后提取（排除极短对话）
  if (!userMessage || userMessage.length < 10) return;
  if (!assistantReply || assistantReply.length < 20) return;

  // 检测是否有记忆相关的触发信号
  const memoryTriggers = [
    '记住', '请记住', '以后', '下次', '我喜欢', '我偏好', '我习惯',
    '我是', '我的', '我负责', '我的角色', '我的部门',
    'remember', 'note that', 'keep in mind', 'my preference',
    '不要忘记', '别忘了', '务必记住'
  ];
  
  const hasExplicitTrigger = memoryTriggers.some(t => 
    userMessage.toLowerCase().includes(t.toLowerCase())
  );

  // 每 5 次对话做一次隐式记忆提取（即使没有显式触发）
  const isImplicitExtraction = conversationHistory.length > 0 && 
    conversationHistory.length % 10 === 0;

  if (!hasExplicitTrigger && !isImplicitExtraction) return;

  try {
    logger.info(`[${ts()}] [memory-extract] Extracting memory for user ${userId} (trigger: ${hasExplicitTrigger ? 'explicit' : 'implicit'})`);

    // 获取当前记忆
    let currentMemory = '';
    try {
      const memResult = await httpRequest('GET', `/api/user/${encodeURIComponent(userId)}/memory`);
      currentMemory = memResult.memory || memResult.agentMemory || '';
    } catch { currentMemory = ''; }

    // === P8: 容量管理 — 在提取前先检查是否需要压缩 ===
    if (currentMemory.length > MEMORY_SOFT_LIMIT) {
      currentMemory = await compressMemory(currentMemory);
      // 压缩后立即保存（即使后续提取失败也保留压缩结果）
      try {
        await httpRequest('PUT', `/api/user/${encodeURIComponent(userId)}/memory`, {
          memory: currentMemory,
        });
        logger.info(`[${ts()}] [memory-extract] Pre-extraction compression saved (${currentMemory.length} chars)`);
      } catch (saveErr) {
        logger.warn(`[${ts()}] [memory-extract] Failed to save compressed memory: ${saveErr.message}`);
      }
    }

    // 构建提取 prompt
    const recentHistory = conversationHistory.slice(-6).map(m => 
      `${m.role === 'user' ? '用户' : 'AI'}: ${String(m.content).slice(0, 300)}`
    ).join('\n');

    const remainingBudget = MEMORY_SOFT_LIMIT - currentMemory.length;
    const maxNewChars = Math.max(200, remainingBudget);

    const extractPrompt = `你是一个记忆提取助手。请分析以下对话，提取需要长期记住的用户信息。

当前已有记忆：
${currentMemory || '（空）'}

最近对话：
${recentHistory}
用户: ${userMessage.slice(0, 500)}
AI: ${assistantReply.slice(0, 500)}

请提取以下类型的信息（如果有的话）：
1. 用户偏好（语言、格式、工作习惯）
2. 用户身份（角色、部门、职责）
3. 重要决策和约定
4. 用户明确要求记住的内容

规则：
- 不要记录敏感信息（密码、密钥、token等）
- 不要记录临时性的任务细节
- 将新信息与已有记忆合并，去重
- 输出格式：每条记忆一行，用 "- " 开头
- 如果没有需要新增的记忆，原样返回已有记忆
- 总长度不超过 ${maxNewChars} 字符

直接输出合并后的记忆列表，不要加任何解释：`;

    // 调用 LLM 提取记忆
    const result = await httpRequest('POST', '/api/chat/simple', {
      message: extractPrompt,
      model: 'openai/gpt-5-mini',
    });

    const extractedMemory = (result.reply || result.content || result.message || '').trim();

    if (!extractedMemory || extractedMemory.length < 5) {
      logger.info(`[${ts()}] [memory-extract] No new memory extracted for ${userId}`);
      return;
    }

    // 清理提取结果
    let cleanMemory = extractedMemory
      .replace(/^```[\s\S]*?\n/, '')
      .replace(/\n```\s*$/, '')
      .trim();

    // === P8: 硬上限保护 ===
    if (cleanMemory.length > MEMORY_HARD_LIMIT) {
      logger.info(`[${ts()}] [memory-extract] Extracted memory (${cleanMemory.length}) exceeds hard limit, truncating`);
      cleanMemory = hardTruncate(cleanMemory, MEMORY_HARD_LIMIT);
    }

    // 保存记忆
    await httpRequest('PUT', `/api/user/${encodeURIComponent(userId)}/memory`, {
      memory: cleanMemory,
    });

    logger.info(`[${ts()}] [memory-extract] Saved ${cleanMemory.length} chars of memory for user ${userId}`);

  } catch (err) {
    logger.warn(`[${ts()}] [memory-extract] Failed: ${err.message}`);
  }
}
