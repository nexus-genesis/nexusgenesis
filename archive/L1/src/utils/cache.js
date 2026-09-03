/**
 * NexusGenesis - 缓存实现
 * support缓存预热, 缓存统计和智能缓存清理
 */

class Cache {
  constructor() {
    // 缓存Storage
    this.cache = new Map();
    // 缓存统计info
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0
    };
    // 缓存Configuration
    this.config = {
      maxSize: 1000, // Maximum缓存条目数
      defaultTTL: 3600000, // Default过期时间(1小时)
      cleanupInterval: 60000 // 清理间隔(1分钟)
    };
    // Start定期清理
    this.startCleanup();
  }

  /**
   * Set缓存
   * @param {string} key 缓存键
   * @param {any} value 缓存值
   * @param {number} ttl 过期时间(ms)
   */
  set(key, value, ttl = this.config.defaultTTL) {
    const now = Date.now();
    const item = {
      value,
      ttl,
      createdAt: now,
      lastAccessed: now
    };

    // 如果缓存达到Maximum容量, 清理最少using的条目
    if (this.cache.size >= this.config.maxSize) {
      this.evictLeastUsed();
    }

    this.cache.set(key, item);
    this.stats.sets++;
  }

  /**
   * get缓存
   * @param {string} key 缓存键
   * @returns {any} 缓存值或undefined
   */
  get(key) {
    const item = this.cache.get(key);
    if (!item) {
      this.stats.misses++;
      return undefined;
    }

    // Check是否过期
    const now = Date.now();
    if (now - item.createdAt > item.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Update最后访问时间
    item.lastAccessed = now;
    this.cache.set(key, item);
    this.stats.hits++;
    return item.value;
  }

  /**
   * Delete缓存
   * @param {string} key 缓存键
   */
  delete(key) {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.stats.deletes++;
    }
  }

  /**
   * 清空缓存
   */
  clear() {
    this.cache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0
    };
  }

  /**
   * getCache size
   * @returns {number} Cache size
   */
  size() {
    return this.cache.size;
  }

  /**
   * get缓存统计info
   * @returns {object} 统计info
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : '0.00';

    return {
      ...this.stats,
      hitRate: parseFloat(hitRate),
      size: this.cache.size,
      maxSize: this.config.maxSize
    };
  }

  /**
   * 清理过期缓存
   */
  cleanup() {
    const now = Date.now();
    let deleted = 0;

    for (const [key, item] of this.cache.entries()) {
      if (now - item.createdAt > item.ttl) {
        this.cache.delete(key);
        deleted++;
      }
    }

    if (deleted > 0) {
      console.log(`[Cache] 清理了 ${deleted} 个过期缓存条目`);
    }
  }

  /**
   * Start定期清理
   */
  startCleanup() {
    setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * 清理最少using的缓存
   */
  evictLeastUsed() {
    let leastUsedKey = null;
    let leastUsedTime = Infinity;

    for (const [key, item] of this.cache.entries()) {
      if (item.lastAccessed < leastUsedTime) {
        leastUsedTime = item.lastAccessed;
        leastUsedKey = key;
      }
    }

    if (leastUsedKey) {
      this.cache.delete(leastUsedKey);
      console.log(`[Cache] 清理最少using的缓存条目: ${leastUsedKey}`);
    }
  }

  /**
   * 缓存预热
   * @param {object} data 预热data
   */
  prewarm(data) {
    for (const [key, value] of Object.entries(data)) {
      this.set(key, value);
    }
    console.log(`[Cache] 预热了 ${Object.keys(data).length} 个缓存条目`);
  }

  /**
   * Set缓存Configuration
   * @param {object} config Configuration对象
   */
  setConfig(config) {
    this.config = { ...this.config, ...config };
  }

  /**
   * get缓存Configuration
   * @returns {object} Configuration对象
   */
  getConfig() {
    return { ...this.config };
  }
}

// Export单例instance
export default new Cache();