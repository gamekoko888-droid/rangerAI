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
 * Iter-101 · TypeScript 改写成 R101 Task 2
 */

export class TTLMap<K extends string = string, V = unknown> {
  private _maxSize: number;
  private _ttlMs: number;
  private _map: Map<K, V>;
  private _timestamps: Map<K, number>;
  private _cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(
    maxSize: number = 1000,
    ttlMs: number = 3600000,
    cleanupIntervalMs: number = 300000,
  ) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._map = new Map<K, V>();
    this._timestamps = new Map<K, number>(); // key → setAt (ms)
    this._cleanupTimer = null;

    this._cleanupTimer = setInterval(() => this._cleanupExpired(), cleanupIntervalMs);
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  set(key: K, value: V): void {
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

  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const setAt = this._timestamps.get(key);
    if (setAt !== undefined && Date.now() - setAt > this._ttlMs) {
      this._map.delete(key);
      this._timestamps.delete(key);
      return undefined;
    }
    return this._map.get(key);
  }

  has(key: K): boolean {
    if (!this._map.has(key)) return false;
    const setAt = this._timestamps.get(key);
    if (setAt !== undefined && Date.now() - setAt > this._ttlMs) {
      this._map.delete(key);
      this._timestamps.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    this._timestamps.delete(key);
    return this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
    this._timestamps.clear();
  }

  get size(): number {
    this._cleanupExpired();
    return this._map.size;
  }

  dispose(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._map.clear();
    this._timestamps.clear();
  }

  forEach(callback: (value: V, key: K) => void): void {
    this._cleanupExpired();
    for (const [key, value] of this._map) {
      callback(value, key);
    }
  }

  *[Symbol.iterator](): Iterator<[K, V]> {
    this._cleanupExpired();
    yield* this._map;
  }

  private _cleanupExpired(): void {
    const now = Date.now();
    for (const [key, setAt] of this._timestamps) {
      if (now - setAt > this._ttlMs) {
        this._map.delete(key);
        this._timestamps.delete(key);
      }
    }
  }

  private _findOldest(): K | null {
    let oldestKey: K | null = null;
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
