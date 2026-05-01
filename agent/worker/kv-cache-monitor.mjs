// worker/kv-cache-monitor.mjs — KV-Cache 前缀稳定性监控 (Iter-R v25.20)
//
// 扩展 R60 sha256 审计能力：
//   - 追踪同一 session 内连续调用的前缀哈希变化
//   - 当前缀发生变化时记录（表示 KV-Cache miss）
//   - 提供统计数据供 /api/system/kv-cache-stats 端点消费
//
// 设计原则：
//   - 纯内存，无 DB 依赖
//   - 不阻塞主链路（所有写入同步，读取O(1)）
//   - 自动清理过期 session（30min TTL）

import crypto from 'node:crypto';
import { logger } from '../lib/logger.mjs';
import { recordCompression } from './observability.mjs'; // [R13-T4]

const PREFIX_LENGTH = 2000;       // 与 R60 保持一致
const MAX_LOG_PER_SESSION = 20;   // 每 session 保留最近 20 次
const SESSION_TTL_MS = 30 * 60 * 1000; // 30min 过期

// Map<sessionKey, { log: [{hash, ts}], missCount, totalCount }>
const sessionStore = new Map();

const ts = () => new Date().toISOString();

/**
 * 追踪一次 LLM 调用的前缀哈希
 * @param {string} sessionKey
 * @param {string} systemPromptText - effectiveMessage 或 systemPrompt 的完整文本
 * @returns {{ stable: boolean, hash: string, prevHash: string|null, missRate: string }}
 */
export function trackPrefix(sessionKey, systemPromptText) {
  if (!sessionKey || !systemPromptText) return { stable: true, hash: '', prevHash: null, missRate: '0%' };

  const hash = crypto.createHash('sha256')
    .update(systemPromptText.substring(0, PREFIX_LENGTH))
    .digest('hex')
    .substring(0, 12);

  let entry = sessionStore.get(sessionKey);

  // 清理过期 session
  if (entry && (Date.now() - entry.lastAt) > SESSION_TTL_MS) {
    sessionStore.delete(sessionKey);
    entry = null;
  }

  if (!entry) {
    entry = { log: [], missCount: 0, totalCount: 0, lastAt: Date.now() };
    sessionStore.set(sessionKey, entry);
  }

  entry.totalCount++;
  entry.lastAt = Date.now();

  const prevHash = entry.log.length > 0 ? entry.log[entry.log.length - 1].hash : null;
  const stable = prevHash === null || prevHash === hash;

  entry.log.push({ hash, ts: Date.now() });
  if (entry.log.length > MAX_LOG_PER_SESSION) entry.log.shift();

  if (!stable) {
    entry.missCount++;
    const missRateNum = Math.round(entry.missCount / entry.totalCount * 100);
    logger.info(`[${ts()}] [kv-cache-monitor] [R60-MISS] session=${sessionKey} prev=${prevHash} curr=${hash} missRate=${missRateNum}%`);
    // [R13-T4] Persist KV-Cache miss to DB
    try {
      recordCompression('kv_cache_miss', 0, {
        sessionKey,
        extraJson: {
          prevHash,
          newHash: hash,
          missRate: missRateNum,
          totalCalls: entry.totalCount,
          totalMisses: entry.missCount,
        },
      });
      logger.info(`[R13-T4] kv_cache_miss persisted: session=${sessionKey}, missRate=${missRateNum}%`);
    } catch (e) {
      logger.warn(`[R13-T4] kv_cache_miss persist failed: ${e.message}`);
    }
  }

  const missRate = entry.totalCount > 1
    ? `${Math.round(entry.missCount / (entry.totalCount - 1) * 100)}%`
    : '0%';

  return { stable, hash, prevHash, missRate };
}

/**
 * 获取所有 session 的 KV-Cache 稳定性统计
 * @returns {object} sessionKey → { calls, uniquePrefixes, stabilityRate, missCount }
 */
export function getKVCacheStats() {
  const result = {};
  const now = Date.now();

  for (const [sk, entry] of sessionStore) {
    // 跳过已过期的 session
    if ((now - entry.lastAt) > SESSION_TTL_MS) continue;

    const hashes = entry.log.map(l => l.hash);
    const uniquePrefixes = new Set(hashes).size;
    const calls = entry.totalCount;
    const missCount = entry.missCount;
    const stabilityRate = calls > 1
      ? `${Math.round((1 - missCount / (calls - 1)) * 100)}%`
      : '100%';

    result[sk.substring(0, 12) + '...'] = {
      calls,
      uniquePrefixes,
      missCount,
      stabilityRate,
      lastSeenAgo: `${Math.round((now - entry.lastAt) / 1000)}s ago`,
    };
  }
  return result;
}

/**
 * 清理过期 session（供定期调用）
 */
export function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [sk, entry] of sessionStore) {
    if ((now - entry.lastAt) > SESSION_TTL_MS) {
      sessionStore.delete(sk);
      cleaned++;
    }
  }
  return cleaned;
}
