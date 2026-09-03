import { DEFAULT_TIERS } from './apiKeyManager.js';

const RATE_LIMIT_WINDOW = 60000;
const IP_RATE_LIMIT_MAX = 1000; // P0-3.1: 600 → 1000 (multi-agent shared IP)

const RATE_LIMIT_BY_ENDPOINT = {
  '/api/agents/register': 50,
  '/api/agents/openai': 80,
  '/api/agents/anthropic': 80,
  '/api/agents/heartbeat': 120,
  // Wallet read endpoints — generous limits for frontend UX
  '/wallet/health': 200,
  '/wallet/stats': 100,
  '/wallet/assets': 100,
  '/wallet/agent/list': 60,
  '/wallet/agent/stats': 60
};

const EXEMPT_ENDPOINTS = new Set([
  '/health',
  '/health/live',
  '/health/ready',
  '/api/v1/bootstrap/status',
  '/api/v1/bootstrap/validators/join',
  '/api/v1/bootstrap/blocks/recent',
  '/api/v1/bootstrap/contributions',
  '/api/v1/bootstrap/agents/latest',
  '/api/v1/bootstrap/agents',
  '/api/v1/agents',
  '/api/tasks/stats',
  '/api/forum/stats',
  '/api/forum/topics',
  '/api/forum/topics/',
  // API compatibility aliases
  '/api/v1/tasks',
  '/api/v1/tasks/list',
  '/api/v1/forum',
  '/api/v1/forum/topics',
  '/api/v1/proposals',
  '/api/v1/proposals/list',
  '/api/v1/blocks',
  '/api/v1/blocks/latest',
  '/api/v1/validators',
  '/api/v1/validators/list',
  '/api/v1/network',
  '/api/v1/network/status',
  '/api/v1/reputation',
  '/api/v1/reputation/',
  '/api/v1/agents/list',
  '/api/v1/transactions/list',
  '/api/v1/governance',
  '/api/v1/docs/endpoints',
  '/api/bootstrap',
  '/tasks',
  '/proposals',
  '/governance',
  '/forum/topics',
  '/agent/tasks',
  '/agent/proposals'
]);

// GET-only exempt prefixes: read requests skip rate limiting, but
// POST/PUT/DELETE to the same paths are still rate-limited.
const EXEMPT_GET_PREFIXES = [
  '/api/forum/topics',
  '/api/v1/agents',
  '/api/issues',
  '/api/v1/governance',
  '/api/v1/tasks',
  '/api/v1/proposals',
  '/api/v1/blocks',
  '/api/v1/validators',
  '/api/v1/network',
  '/api/v1/reputation',
  '/api/v1/transactions',
  '/api/bootstrap',
  '/agent/'
];

const EXEMPT_PREFIXES = [
  '/api/tasks',
  '/api/v1/bootstrap/validators/health',
  '/api/v1/bootstrap/validators/:id/heartbeat'
];

const PERMISSIVE_PREFIXES = [
  '/api/v1/wallet/health',
  '/api/v1/wallet/stats',
  '/api/v1/wallet/assets',
  '/api/v1/wallet/balance/',
  '/api/v1/wallet/history/',
  '/api/v1/wallet/info/',
  '/api/v1/wallet/agent/',
  '/api/wallet/health',
  '/api/wallet/stats',
  '/api/wallet/assets',
  '/api/wallet/balance/',
  '/api/wallet/history/',
  '/api/wallet/info/',
  '/api/wallet/agent/',
  '/api/v1/transactions',
  '/api/v1/bridge/chains',
  '/api/v1/bridge/status',
  '/api/v1/bridge/validators',
  '/api/v1/bridge/transfers/',
  '/api/v1/bridge/events',
  '/api/v1/bridge/light-client/status'
];

const AGENT_RATE_LIMITS = {
  validator: 300,
  high_reputation: 120,
  medium_reputation: 80,
  low_reputation: 50,
  new_agent: 30
};

// ─── P0-3.3: Gradient ban configuration ───
// Escalating ban durations for IPs that keep hammering past rate limits.
const GRADIENT_BAN_DURATIONS_MS = [
  5 * 60 * 1000,   // 1st violation of the day → 5 minutes
  30 * 60 * 1000,  // 2nd violation of the day → 30 minutes
  60 * 60 * 1000   // 3rd+ violation of the day → 1 hour
];
// An IP is banned only after this many rejected requests beyond the limit
// within the current window — a client that backs off after the first 429
// (with Retry-After) is NOT banned; only continued hammering triggers it.
const GRADIENT_BAN_TRIGGER_THRESHOLD = 10;

class RateLimiter {
  constructor(options = {}) {
    this.window = options.window || RATE_LIMIT_WINDOW;
    this.ipMax = options.ipMax || IP_RATE_LIMIT_MAX;
    this.endpointLimits = options.endpointLimits || RATE_LIMIT_BY_ENDPOINT;
    this.agentLimits = options.agentLimits || AGENT_RATE_LIMITS;
    this.ipRecords = new Map();
    // P0-3.2: Per-agent quota tracking (independent of IP)
    this.agentRecords = new Map();
    // P0-3.3: Gradient ban state
    // bannedIPs: ip -> bannedUntil (ms epoch); banCounts: `${day}:${ip}` -> count
    this.bannedIPs = new Map();
    this.banCounts = new Map();
    this.totalBlocked = 0;
    this.totalBanned = 0;
    this._startCleanup();
  }

  middleware(apiKeyManager = null, agentResolver = null) {
    return (req, res, next) => {
      const now = Date.now();
      const ip = req.ip;
      const fullPath = req.originalUrl.split('?')[0];
      const endpoint = req.path;

      if (EXEMPT_ENDPOINTS.has(endpoint) || EXEMPT_PREFIXES.some(p => fullPath.startsWith(p))) {
        return next();
      }

      if (req.method === 'GET' && EXEMPT_GET_PREFIXES.some(p => fullPath.startsWith(p))) {
        return next();
      }

      // ─── P0-3.2: Resolve agent identity → per-agent quota ───
      let agentRecord = null;
      if (agentResolver) {
        const agentIdentity = req.headers['x-agent-identity'];
        if (agentIdentity) {
          agentRecord = agentResolver(agentIdentity);
          if (agentRecord) {
            req.agentVerified = true;
            // Per-agent quota check
            const agentResult = this._checkAgentLimit(agentIdentity, agentRecord, endpoint, now);
            if (!agentResult.allowed) {
              this.totalBlocked++;
              res.setHeader('Retry-After', agentResult.retryAfter);
              res.setHeader('X-RateLimit-Limit', agentResult.limit);
              res.setHeader('X-RateLimit-Remaining', 0);
              return res.status(429).json({
                success: false,
                message: agentResult.reason,
                error_code: 'RATE_LIMITED',
                retry_after: agentResult.retryAfter,
                limit: agentResult.limit
              });
            }
            // Agent quota passed → skip IP-level check, proceed
            res.setHeader('X-RateLimit-Limit', agentResult.limit);
            res.setHeader('X-RateLimit-Remaining', agentResult.remaining);
            return this._checkApiKey(req, res, next, apiKeyManager);
          }
        }
      }

      // P0-3.3: Reject requests from currently-banned IPs (fallback path only —
      // agent-verified requests above already returned via per-agent quota).
      const banCheck = this._getActiveBan(ip);
      if (banCheck) {
        this.totalBlocked++;
        res.setHeader('Retry-After', banCheck.retryAfter);
        return res.status(429).json({
          success: false,
          message: `IP is banned due to repeated rate-limit violations (escalation level ${banCheck.level}). Retry after ${banCheck.retryAfter}s.`,
          error_code: 'IP_BANNED',
          retry_after: banCheck.retryAfter,
          ban_level: banCheck.level
        });
      }

      // No agent identity → fall back to IP-level limit
      const result = this._checkIpLimit(ip, endpoint, now, req, fullPath);
      if (!result.allowed) {
        this.totalBlocked++;
        res.setHeader('Retry-After', result.retryAfter);
        res.setHeader('X-RateLimit-Limit', result.limit);
        res.setHeader('X-RateLimit-Remaining', 0);
        return res.status(429).json({
          success: false,
          message: result.reason,
          error_code: 'RATE_LIMITED',
          retry_after: result.retryAfter,
          limit: result.limit
        });
      }

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      this._checkApiKey(req, res, next, apiKeyManager);
    };
  }

  /**
   * P0-3.2: Per-agent quota check — independent of IP-based limits.
   * Each agent gets its own token bucket based on reputation tier.
   */
  _checkAgentLimit(agentIdentity, agentRecord, endpoint, now) {
    if (!this.agentRecords.has(agentIdentity)) {
      let agentType = 'new_agent';
      if (agentRecord.is_validator) {
        agentType = 'validator';
      } else if (agentRecord.reputation >= 100) {
        agentType = 'high_reputation';
      } else if (agentRecord.reputation >= 10) {
        agentType = 'medium_reputation';
      } else if (agentRecord.reputation >= 1) {
        agentType = 'low_reputation';
      }

      const limit = this.agentLimits[agentType] || this.agentLimits.new_agent;
      this.agentRecords.set(agentIdentity, {
        count: 1,
        lastReset: now,
        agentType,
        limit,
        endpoints: { [endpoint]: 1 }
      });
      return { allowed: true, limit, remaining: limit - 1 };
    }

    const info = this.agentRecords.get(agentIdentity);

    if (now - info.lastReset > this.window) {
      info.count = 1;
      info.lastReset = now;
      info.endpoints = { [endpoint]: 1 };
      return { allowed: true, limit: info.limit, remaining: info.limit - 1 };
    }

    info.count++;

    if (info.count > info.limit) {
      const retryAfter = Math.ceil((this.window - (now - info.lastReset)) / 1000);
      return { allowed: false, reason: 'Agent rate limit exceeded', retryAfter, limit: info.limit, remaining: 0 };
    }

    // Endpoint-specific limit
    if (!info.endpoints[endpoint]) {
      info.endpoints[endpoint] = 0;
    }
    info.endpoints[endpoint]++;

    const endpointLimit = this.endpointLimits[endpoint] || info.limit;
    if (info.endpoints[endpoint] > endpointLimit) {
      const retryAfter = Math.ceil((this.window - (now - info.lastReset)) / 1000);
      return { allowed: false, reason: `Endpoint rate limit exceeded for ${endpoint}`, retryAfter, limit: endpointLimit, remaining: 0 };
    }

    return { allowed: true, limit: info.limit, remaining: info.limit - info.count };
  }

  _checkApiKey(req, res, next, apiKeyManager) {
    if (!apiKeyManager) return next();

    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) return next();

    const keyInfo = apiKeyManager.validateKey(apiKey);
    if (!keyInfo) return next();

    const keyResult = apiKeyManager.checkRateLimit(keyInfo.id, req.path);
    if (!keyResult.allowed) {
      this.totalBlocked++;
      res.setHeader('Retry-After', keyResult.retryAfter);
      return res.status(429).json({
        success: false,
        message: keyResult.reason,
        retry_after: keyResult.retryAfter
      });
    }

    apiKeyManager.recordUsage(keyInfo.id, req.path);
    req.apiKey = keyInfo;
    next();
  }

  _checkIpLimit(ip, endpoint, now, req, fullPath) {
    const isPermissive = req.method === 'GET' &&
      PERMISSIVE_PREFIXES.some(p => fullPath.startsWith(p));

    if (!this.ipRecords.has(ip)) {
      this.ipRecords.set(ip, {
        count: 0,
        permissiveCount: 0,
        lastReset: now,
        endpoints: { [endpoint]: 1 },
        agentType: 'new_agent'
      });
      if (isPermissive) {
        this.ipRecords.get(ip).permissiveCount = 1;
      } else {
        this.ipRecords.get(ip).count = 1;
      }
      return { allowed: true, limit: this.ipMax, remaining: this.ipMax - 1 };
    }

    const info = this.ipRecords.get(ip);

    if (now - info.lastReset > this.window) {
      info.count = 0;
      info.permissiveCount = 0;
      info.violations = 0; // P0-3.3: reset violation count on window rollover
      info.lastReset = now;
      info.endpoints = { [endpoint]: 1 };
      if (isPermissive) {
        info.permissiveCount = 1;
      } else {
        info.count = 1;
      }
      return { allowed: true, limit: this.ipMax, remaining: this.ipMax - 1 };
    }

    if (isPermissive) {
      info.permissiveCount++;
      if (info.permissiveCount > this.ipMax) {
        this._registerViolation(ip, info);
        const retryAfter = Math.ceil((this.window - (now - info.lastReset)) / 1000);
        return { allowed: false, reason: 'IP rate limit exceeded', retryAfter, limit: this.ipMax, remaining: 0 };
      }
      return {
        allowed: true,
        limit: this.ipMax,
        remaining: this.ipMax - info.permissiveCount
      };
    }

    info.count++;

    const agentLimit = this.agentLimits[info.agentType] || this.ipMax;

    if (info.count > agentLimit) {
      this._registerViolation(ip, info);
      const retryAfter = Math.ceil((this.window - (now - info.lastReset)) / 1000);
      return { allowed: false, reason: 'IP rate limit exceeded', retryAfter, limit: agentLimit, remaining: 0 };
    }

    if (!info.endpoints) {
      info.endpoints = {};
    }
    if (!info.endpoints[endpoint]) {
      info.endpoints[endpoint] = 0;
    }
    info.endpoints[endpoint]++;

    const endpointLimit = this.endpointLimits[endpoint] || agentLimit;
    if (info.endpoints[endpoint] > endpointLimit) {
      this._registerViolation(ip, info);
      const retryAfter = Math.ceil((this.window - (now - info.lastReset)) / 1000);
      return { allowed: false, reason: `Endpoint rate limit exceeded for ${endpoint}`, retryAfter, limit: endpointLimit, remaining: 0 };
    }

    return { allowed: true, limit: agentLimit, remaining: agentLimit - info.count };
  }

  /**
   * P0-3.3: Register a rate-limit violation for an IP. When violations within
   * the current window reach GRADIENT_BAN_TRIGGER_THRESHOLD (continued hammering
   * past 429s instead of backing off), the IP is gradient-banned.
   */
  _registerViolation(ip, info) {
    info.violations = (info.violations || 0) + 1;
    if (info.violations >= GRADIENT_BAN_TRIGGER_THRESHOLD) {
      this._gradientBan(ip);
      // Reset so post-ban hammering re-triggers another (escalated) ban
      info.violations = 0;
    }
  }

  /**
   * P0-3.3: Gradient ban — escalation is counted per calendar day per IP.
   * 1st ban of the day: 5 min · 2nd: 30 min · 3rd+: 1 hour.
   */
  _gradientBan(ip) {
    const today = new Date().toDateString();
    const key = `${today}:${ip}`;
    const banCount = (this.banCounts.get(key) || 0) + 1;
    this.banCounts.set(key, banCount);

    const level = Math.min(banCount, GRADIENT_BAN_DURATIONS_MS.length);
    const durationMs = GRADIENT_BAN_DURATIONS_MS[level - 1];
    const bannedUntil = Date.now() + durationMs;
    this.bannedIPs.set(ip, bannedUntil);
    this.totalBanned++;

    console.warn(`[RateLimiter] Gradient ban: ${ip} level=${level}/${GRADIENT_BAN_DURATIONS_MS.length} duration=${durationMs / 60000}min (daily count=${banCount})`);
    return { level, durationMs, bannedUntil };
  }

  /** Returns active ban info for an IP, or null if not banned. */
  _getActiveBan(ip) {
    const bannedUntil = this.bannedIPs.get(ip);
    if (!bannedUntil) return null;
    const now = Date.now();
    if (now >= bannedUntil) {
      this.bannedIPs.delete(ip);
      return null;
    }
    const today = new Date().toDateString();
    const banCount = this.banCounts.get(`${today}:${ip}`) || 1;
    return {
      level: Math.min(banCount, GRADIENT_BAN_DURATIONS_MS.length),
      retryAfter: Math.ceil((bannedUntil - now) / 1000)
    };
  }

  setAgentType(ip, agentType) {
    const record = this.ipRecords.get(ip);
    if (record) {
      record.agentType = agentType;
    }
  }

  getStats() {
    const now = Date.now();
    let activeIPs = 0;
    let totalRequests = 0;

    for (const [ip, info] of this.ipRecords.entries()) {
      if (now - info.lastReset < this.window) {
        activeIPs++;
        totalRequests += info.count + (info.permissiveCount || 0);
      }
    }

    return {
      activeIPs,
      totalRequests,
      totalBlocked: this.totalBlocked,
      windowMs: this.window,
      maxPerWindow: this.ipMax,
      activeAgents: this.agentRecords.size,
      bannedIPs: this.bannedIPs.size,
      totalBanned: this.totalBanned
    };
  }

  resetIp(ip) {
    this.ipRecords.delete(ip);
  }

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, info] of this.ipRecords.entries()) {
        if (now - info.lastReset > this.window * 2) {
          this.ipRecords.delete(ip);
        }
      }
      for (const [agentId, info] of this.agentRecords.entries()) {
        if (now - info.lastReset > this.window * 2) {
          this.agentRecords.delete(agentId);
        }
      }
      // P0-3.3: purge expired bans and yesterday's ban counts
      for (const [ip, until] of this.bannedIPs.entries()) {
        if (now >= until) this.bannedIPs.delete(ip);
      }
      const today = new Date().toDateString();
      for (const key of this.banCounts.keys()) {
        if (!key.startsWith(`${today}:`)) this.banCounts.delete(key);
      }
    }, 60000);
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
    this.ipRecords.clear();
    this.agentRecords.clear();
    this.bannedIPs.clear();
    this.banCounts.clear();
  }
}

function createRateLimiter(options) {
  return new RateLimiter(options);
}

export { RateLimiter, createRateLimiter, RATE_LIMIT_WINDOW, IP_RATE_LIMIT_MAX, RATE_LIMIT_BY_ENDPOINT, AGENT_RATE_LIMITS, EXEMPT_ENDPOINTS, EXEMPT_PREFIXES };
export default RateLimiter;