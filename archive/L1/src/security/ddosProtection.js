/**
 * DDoS Protection Module
 * SYN flood detection, request rate analysis, traffic anomaly detection
 */

export class DDoSProtection {
  constructor(config = {}) {
    this.synFloodLimit = config.synFloodLimit || 100;
    this.requestRateLimit = config.requestRateLimit || 200;
    this.detectionWindowMs = config.detectionWindowMs || 10000;
    this.enabled = config.enabled !== false;

    this.requestCounts = new Map();
    this.synCounts = new Map();
    this.blockedIPs = new Set();
    this.anomalyThreshold = 3.0;

    this.cleanupInterval = setInterval(() => this.cleanup(), this.detectionWindowMs);
  }

  checkRequest(ip) {
    if (!this.enabled) return { allowed: true };

    if (this.blockedIPs.has(ip)) {
      return { allowed: false, reason: 'blocked', mitigation: 'IP blocked due to DDoS detection' };
    }

    const now = Date.now();
    let record = this.requestCounts.get(ip);

    if (!record) {
      record = { count: 1, firstSeen: now, lastSeen: now };
      this.requestCounts.set(ip, record);
      return { allowed: true };
    }

    const windowMs = now - record.firstSeen;
    if (windowMs > this.detectionWindowMs) {
      record.count = 1;
      record.firstSeen = now;
      record.lastSeen = now;
      return { allowed: true };
    }

    record.count++;
    record.lastSeen = now;

    const rate = record.count / (Math.max(windowMs, 1) / 1000);

    if (rate > this.requestRateLimit) {
      this.blockIP(ip, 'request rate exceeded');
      return { allowed: false, reason: 'rate_limit', mitigation: 'Request rate too high' };
    }

    if (this.detectAnomaly(ip, record)) {
      return { allowed: false, reason: 'anomaly', mitigation: 'Traffic anomaly detected' };
    }

    return { allowed: true };
  }

  checkSYN(ip) {
    if (!this.enabled) return { allowed: true };

    const count = (this.synCounts.get(ip) || 0) + 1;
    this.synCounts.set(ip, count);

    if (count > this.synFloodLimit) {
      this.blockIP(ip, 'SYN flood');
      return { allowed: false, reason: 'syn_flood', mitigation: 'SYN flood detected' };
    }

    return { allowed: true };
  }

  detectAnomaly(ip, record) {
    const avgRate = this.getAverageRate();
    const ipRate = record.count / (Math.max(Date.now() - record.firstSeen, 1) / 1000);

    if (avgRate === 0) return false;
    return (ipRate / avgRate) > this.anomalyThreshold;
  }

  getAverageRate() {
    if (this.requestCounts.size === 0) return 0;
    let totalRate = 0;
    for (const [, record] of this.requestCounts) {
      const windowMs = Math.max(Date.now() - record.firstSeen, 1);
      totalRate += record.count / (windowMs / 1000);
    }
    return totalRate / this.requestCounts.size;
  }

  blockIP(ip, reason) {
    this.blockedIPs.add(ip);
    console.log(`[DDoS] IP blocked: ${ip} (${reason})`);
  }

  unblockIP(ip) {
    this.blockedIPs.delete(ip);
  }

  getBlockedIPs() {
    return Array.from(this.blockedIPs);
  }

  getStats() {
    return {
      enabled: this.enabled,
      blockedCount: this.blockedIPs.size,
      monitoredIPs: this.requestCounts.size,
      averageRate: this.getAverageRate(),
      synFloodLimit: this.synFloodLimit,
      requestRateLimit: this.requestRateLimit
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.requestCounts) {
      if (now - record.lastSeen > this.detectionWindowMs * 2) {
        this.requestCounts.delete(ip);
      }
    }
    for (const [ip, count] of this.synCounts) {
      this.synCounts.delete(ip);
    }
  }

  stop() {
    clearInterval(this.cleanupInterval);
  }
}

export default DDoSProtection;