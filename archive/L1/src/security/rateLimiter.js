/**
 * Rate Limiter - API 速率限制
 * Token bucket 算法实现
 */

export class RateLimiter {
  constructor(config = {}) {
    this.maxRequestsPerSecond = config.maxRequestsPerSecond || 100;
    this.maxConnectionsPerIP = config.maxConnectionsPerIP || 10;
    this.banDurationMs = config.banDurationMs || 3600000;
    this.maxSuspiciousBeforeBan = config.maxSuspiciousBeforeBan || 5;
    this.enabled = config.enabled !== false;

    this.buckets = new Map();
    this.connectionCounts = new Map();
    this.suspiciousIPs = new Map();
    this.bannedIPs = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  allow(ip) {
    if (!this.enabled) return true;
    if (this.bannedIPs.has(ip)) {
      const bannedUntil = this.bannedIPs.get(ip);
      if (Date.now() < bannedUntil) return false;
      this.bannedIPs.delete(ip);
    }

    this.connectionCounts.set(ip, (this.connectionCounts.get(ip) || 0) + 1);

    if (this.connectionCounts.get(ip) > this.maxConnectionsPerIP) {
      return false;
    }

    const now = Date.now();
    let bucket = this.buckets.get(ip);

    if (!bucket) {
      bucket = { tokens: this.maxRequestsPerSecond, lastRefill: now };
      this.buckets.set(ip, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxRequestsPerSecond, bucket.tokens + elapsed * this.maxRequestsPerSecond);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    const suspicious = (this.suspiciousIPs.get(ip) || 0) + 1;
    this.suspiciousIPs.set(ip, suspicious);

    if (suspicious >= this.maxSuspiciousBeforeBan) {
      this.banIP(ip);
    }

    return false;
  }

  banIP(ip) {
    this.bannedIPs.set(ip, Date.now() + this.banDurationMs);
    console.log(`[SECURITY] IP banned for ${this.banDurationMs / 1000}s: ${ip}`);
  }

  unbanIP(ip) {
    this.bannedIPs.delete(ip);
    this.suspiciousIPs.delete(ip);
  }

  disconnect(ip) {
    const count = this.connectionCounts.get(ip) || 0;
    if (count > 1) {
      this.connectionCounts.set(ip, count - 1);
    } else {
      this.connectionCounts.delete(ip);
    }
  }

  getStats() {
    return {
      enabled: this.enabled,
      maxRequestsPerSecond: this.maxRequestsPerSecond,
      maxConnectionsPerIP: this.maxConnectionsPerIP,
      activeBans: this.bannedIPs.size,
      suspiciousIPs: this.suspiciousIPs.size,
      totalConnections: this.connectionCounts.size,
      bannedList: Array.from(this.bannedIPs.entries()).map(([ip, until]) => ({
        ip,
        remainingMs: Math.max(0, until - Date.now())
      }))
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, until] of this.bannedIPs) {
      if (now >= until) {
        this.bannedIPs.delete(ip);
        this.suspiciousIPs.delete(ip);
      }
    }
    for (const [ip, count] of this.suspiciousIPs) {
      if (count === 0) {
        this.suspiciousIPs.delete(ip);
      }
    }
  }

  stop() {
    clearInterval(this.cleanupInterval);
  }
}

export default RateLimiter;