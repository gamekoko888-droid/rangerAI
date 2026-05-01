/**
 * TTLMap — 带自动过期清理的 Map 封装
 *
 * 用途：替换 Worker 进程中的全局 Map/Set，防止内存泄漏
 * 特性：
 *   - 每个 entry 独立 TTL（set 时记录时间戳）
 *   - 定时清理过期条目（cleanupIntervalMs）
 *   - maxSize 上限保护（LRU：超出后删除最老的条目）
 *   - dispose() 释放清理定时器（进程退出时调用）
 *
 * Iter-95 · Manus 任务书 R95 交付
 */

export class TTLMap {
  /**
   * @param {number} [maxSize=1000]  最大条目数
   * @param {number} [ttlMs=3600000] 条目过期时间（毫秒），默认 1 小时
   * @param {number} [cleanupIntervalMs=300000] 清理间隔（毫秒），默认 5 分钟
   */
  constructor(maxSize = 1000, ttlMs = 3600000, cleanupIntervalMs = 300000) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._map = new Map();
    this._timestamps = new Map(); // key → setAt (ms)

    this._cleanupTimer = setInterval(() => this._cleanupExpired(), cleanupIntervalMs);
    // 允许 Node.js 进程正常退出（不阻止 event loop）
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  /**
   * 设置键值，记录时间戳。超出 maxSize 时删除最老条目（LRU）。
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    // LRU 淘汰：超出容量时删除最老的条目
    if (this._map.size >= this._maxSize && !this._map.has(key)) {
      const oldest = this._findOldest();
      if (oldest) {
        this._map.delete(oldest);
        this._timestamps.delete(oldest);
      }
    }
    this._map.set(key, value);
    this._timestamps.set(key, Date.now());
  }

  /**
   * 获取值。如果过期返回 undefined 并自动删除。
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    if (!this._map.has(key)) return undefined;
    const setAt = this._timestamps.get(key);
    if (setAt && Date.now() - setAt > this._ttlMs) {
      this._map.delete(key);
      this._timestamps.delete(key);
      return undefined;
    }
    return this._map.get(key);
  }

  /**
   * 检查键是否存在（且未过期）
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    if (!this._map.has(key)) return false;
    const setAt = this._timestamps.get(key);
    if (setAt && Date.now() - setAt > this._ttlMs) {
      this._map.delete(key);
      this._timestamps.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 删除键
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    this._timestamps.delete(key);
    return this._map.delete(key);
  }

  /**
   * 清空所有条目
   */
  clear() {
    this._map.clear();
    this._timestamps.clear();
  }

  /**
   * 当前有效条目数（不含过期）
   */
  get size() {
    this._cleanupExpired();
    return this._map.size;
  }

  /**
   * 释放清理定时器（进程退出前调用）
   */
  dispose() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._map.clear();
    this._timestamps.clear();
  }

  /**
   * 遍历所有有效条目（类似 Map.forEach）
   * @param {(value, key) => void} callback
   */
  forEach(callback) {
    this._cleanupExpired();
    for (const [key, value] of this._map) {
      callback(value, key);
    }
  }

  /**
   * 返回所有有效条目的迭代器
   * @returns {Iterator<[string, *]>}
   */
  *[Symbol.iterator]() {
    this._cleanupExpired();
    yield* this._map;
  }

  /** 清理过期条目 */
  _cleanupExpired() {
    const now = Date.now();
    for (const [key, setAt] of this._timestamps) {
      if (now - setAt > this._ttlMs) {
        this._map.delete(key);
        this._timestamps.delete(key);
      }
    }
  }

  /** 找到最老的条目（按时间戳排序） */
  _findOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, setAt] of this._timestamps) {
      if (setAt < oldestTime) {
        oldestTime = setAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}

export default TTLMap;
