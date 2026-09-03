/**
 * 签名验证缓存模块
 * 
 * 用于缓存 Dilithium2 签名验证结果，避免重复的高成本密码学计算。
 * 缓存键格式: "{message}:{signatureHash}:{publicKeyHash}"
 * 
 * 安全考虑：
 * - TTL 5 分钟，防止长期重放攻击
 * - 定期清理过期条目，防止内存泄漏
 * - 缓存仅存储布尔结果，不存储敏感数据
 */

const SIGNATURE_VERIFY_CACHE = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 分钟
const CLEANUP_INTERVAL_MS = 60 * 1000;  // 每 60 秒清理一次

/**
 * 清理过期的缓存条目
 */
function pruneCache(ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  let deleted = 0;
  for (const [key, val] of SIGNATURE_VERIFY_CACHE.entries()) {
    if (now - val.ts > ttlMs) {
      SIGNATURE_VERIFY_CACHE.delete(key);
      deleted++;
    }
  }
  if (deleted > 0) {
    console.log(`[SigVerifyCache] Pruned ${deleted} expired entries, ${SIGNATURE_VERIFY_CACHE.size} remaining`);
  }
}

/**
 * 启动定期清理
 * @param {number} intervalMs - 清理间隔毫秒数
 */
export function startCleanup(intervalMs = CLEANUP_INTERVAL_MS) {
  setInterval(() => pruneCache(), intervalMs);
  console.log('[SigVerifyCache] Periodic cleanup started (interval: ' + (intervalMs / 1000) + 's)');
}

/**
 * 停止清理定时器
 */
export function stopCleanup() {
  // 清除所有定时器
  for (let i = 1; i < 100; i++) {
    clearInterval(i);
    clearTimeout(i);
  }
}

/**
 * 手动清理所有缓存
 */
export function clearCache() {
  const size = SIGNATURE_VERIFY_CACHE.size;
  SIGNATURE_VERIFY_CACHE.clear();
  console.log(`[SigVerifyCache] Cleared ${size} entries`);
}

/**
 * 获取缓存统计信息
 * @returns {{ size: number, ttlMs: number }}
 */
export function getStats() {
  return {
    size: SIGNATURE_VERIFY_CACHE.size,
    ttlMs: DEFAULT_TTL_MS
  };
}

/**
 * 验证签名（带缓存）
 * @param {string} cacheKey - 用于缓存的唯一键
 * @param {Function} verifyFn - 实际的签名验证函数（返回 Promise<boolean>）
 * @returns {Promise<boolean>} 是否验证通过
 */
export async function verifyWithCache(cacheKey, verifyFn) {
  const cached = SIGNATURE_VERIFY_CACHE.get(cacheKey);
  if (cached) {
    return cached.verified;
  }

  const isValid = await verifyFn();
  SIGNATURE_VERIFY_CACHE.set(cacheKey, { verified: isValid, ts: Date.now() });
  return isValid;
}

// 启动时自动开始定期清理
startCleanup();
