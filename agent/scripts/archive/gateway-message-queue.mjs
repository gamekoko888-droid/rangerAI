/**
 * gateway-message-queue.mjs — Gateway ↔ Agent 消息队列中间层
 * 
 * 目的：解耦 Gateway 和 Agent 的直接依赖关系
 * - Gateway 将消息推入 Redis 队列
 * - Agent 从 Redis 队列消费消息
 * - 如果 Agent 宕机，消息不会丢失（Redis 持久化）
 * - 如果 Gateway 宕机，Agent 可以继续处理已有消息
 * 
 * 使用方式：
 * - 在 agent-worker.mjs 中 import { enqueueMessage, dequeueMessage } from './gateway-message-queue.mjs'
 * - 或者作为独立的消息代理服务运行
 * 
 * 注意：这是一个基础实现，后续可以升级为更完整的消息队列（如 BullMQ）
 */

import { logger } from './lib/logger.mjs';
import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_QUEUE_URL || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_PREFIX = 'rangerai:mq:';
const RETRY_QUEUE = `${QUEUE_PREFIX}retry`;
const DEAD_LETTER_QUEUE = `${QUEUE_PREFIX}dead`;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

let redisClient = null;

/**
 * 获取或创建 Redis 客户端
 */
async function getRedisClient() {
  if (redisClient && redisClient.isOpen) return redisClient;
  
  redisClient = createClient({ url: REDIS_URL });
  
  redisClient.on('error', (err) => {
    logger.error('[MQ] Redis connection error:', err.message);
  });
  
  redisClient.on('reconnecting', () => {
    logger.info('[MQ] Redis reconnecting...');
  });
  
  await redisClient.connect();
  logger.info('[MQ] Redis connected');
  return redisClient;
}

/**
 * 将消息推入队列
 * @param {string} queueName - 队列名称（如 'chat', 'task', 'tool'）
 * @param {object} message - 消息内容
 * @returns {string} 消息 ID
 */
export async function enqueueMessage(queueName, message) {
  const client = await getRedisClient();
  const fullQueueName = `${QUEUE_PREFIX}${queueName}`;

  // Iter-41+: Global safety switch against "message must not contain null bytes" error.
  // We sanitize the entire message object by recursing and stripping \0 characters.
  const sanitizeNulls = (obj) => {
    if (typeof obj === "string") return obj.replace(/\0/g, "");
    if (obj && typeof obj === "object") {
      if (Array.isArray(obj)) return obj.map(sanitizeNulls);
      const cleaned = {};
      for (const [k, v] of Object.entries(obj)) {
        cleaned[k] = sanitizeNulls(v);
      }
      return cleaned;
    }
    return obj;
  };

  const safeMessage = sanitizeNulls(message);
  
  const envelope = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    retryCount: 0,
    payload: safeMessage,
  };
  
  await client.lPush(fullQueueName, JSON.stringify(envelope));
  
  // 记录队列深度指标
  const depth = await client.lLen(fullQueueName);
  if (depth > 100) {
    logger.warn(`[MQ] Queue ${queueName} depth: ${depth} — consider scaling consumers`);
  }
  
  return envelope.id;
}

/**
 * 从队列消费消息（阻塞式）
 * @param {string} queueName - 队列名称
 * @param {number} timeoutSeconds - 阻塞等待超时（秒）
 * @returns {object|null} 消息内容或 null（超时）
 */
export async function dequeueMessage(queueName, timeoutSeconds = 30) {
  const client = await getRedisClient();
  const fullQueueName = `${QUEUE_PREFIX}${queueName}`;
  
  const result = await client.brPop(fullQueueName, timeoutSeconds);
  if (!result) return null;
  
  try {
    return JSON.parse(result.element);
  } catch (e) {
    logger.error('[MQ] Failed to parse message:', e.message);
    return null;
  }
}

/**
 * 将失败的消息放入重试队列
 * @param {string} queueName - 原始队列名称
 * @param {object} envelope - 消息信封
 * @param {string} error - 错误信息
 */
export async function retryMessage(queueName, envelope, error) {
  const client = await getRedisClient();
  
  envelope.retryCount = (envelope.retryCount || 0) + 1;
  envelope.lastError = error;
  envelope.lastRetryAt = Date.now();
  
  if (envelope.retryCount >= MAX_RETRIES) {
    // 超过最大重试次数，放入死信队列
    await client.lPush(DEAD_LETTER_QUEUE, JSON.stringify({
      ...envelope,
      originalQueue: queueName,
      deadAt: Date.now(),
    }));
    logger.error(`[MQ] Message ${envelope.id} moved to dead letter queue after ${MAX_RETRIES} retries`);
    return;
  }
  
  // 延迟重试（使用 sorted set 实现延迟）
  const retryAt = Date.now() + RETRY_DELAY_MS * envelope.retryCount;
  await client.zAdd(RETRY_QUEUE, {
    score: retryAt,
    value: JSON.stringify({ ...envelope, targetQueue: queueName }),
  });
  
  logger.info(`[MQ] Message ${envelope.id} scheduled for retry #${envelope.retryCount} at ${new Date(retryAt).toISOString()}`);
}

/**
 * 处理重试队列中到期的消息
 * 应该由定时器定期调用
 */
export async function processRetryQueue() {
  const client = await getRedisClient();
  const now = Date.now();
  
  // 获取所有到期的重试消息
  const messages = await client.zRangeByScore(RETRY_QUEUE, 0, now);
  
  for (const msgStr of messages) {
    try {
      const msg = JSON.parse(msgStr);
      const targetQueue = `${QUEUE_PREFIX}${msg.targetQueue}`;
      
      // 重新入队
      await client.lPush(targetQueue, JSON.stringify(msg));
      // 从重试队列移除
      await client.zRem(RETRY_QUEUE, msgStr);
      
      logger.info(`[MQ] Retried message ${msg.id} back to queue ${msg.targetQueue}`);
    } catch (e) {
      logger.error('[MQ] Error processing retry:', e.message);
    }
  }
}

/**
 * 获取队列状态
 * @returns {object} 各队列的深度信息
 */
export async function getQueueStats() {
  const client = await getRedisClient();
  
  const keys = await client.keys(`${QUEUE_PREFIX}*`);
  const stats = {};
  
  for (const key of keys) {
    const type = await client.type(key);
    if (type === 'list') {
      stats[key.replace(QUEUE_PREFIX, '')] = await client.lLen(key);
    } else if (type === 'zset') {
      stats[key.replace(QUEUE_PREFIX, '')] = await client.zCard(key);
    }
  }
  
  return stats;
}

/**
 * 健康检查
 */
export async function healthCheck() {
  try {
    const client = await getRedisClient();
    const pong = await client.ping();
    const stats = await getQueueStats();
    return { status: 'ok', redis: pong, queues: stats };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

/**
 * 关闭连接
 */
export async function shutdown() {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    logger.info('[MQ] Redis connection closed');
  }
}

// 如果直接运行此文件，启动重试处理器
if (process.argv[1] && process.argv[1].includes('gateway-message-queue')) {
  logger.info('[MQ] Starting message queue processor...');
  
  // 每 5 秒处理一次重试队列
  const _retryTimer = setInterval(async () => {
    try {
      await processRetryQueue();
    } catch (e) {
      logger.error('[MQ] Retry processor error:', e.message);
    }
  }, 5000);
  
  // 每 30 秒输出队列状态
  const _statsTimer = setInterval(async () => {
    try {
      const stats = await getQueueStats();
      if (Object.keys(stats).length > 0) {
        logger.info('[MQ] Queue stats:', JSON.stringify(stats));
      }
    } catch (e) {
      // ignore
    }
  }, 30000);
  
  // 优雅关闭
  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}
