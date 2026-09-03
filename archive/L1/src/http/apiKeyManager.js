import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEYS_FILE = path.join(__dirname, '../../data/api-keys.json');
const USAGE_FILE = path.join(__dirname, '../../data/api-usage.json');

const DEFAULT_TIERS = {
  free: {
    name: 'Free',
    limits: {
      rpm: 30,
      rpd: 1000,
      concurrent: 2,
      endpoints: {
        '/api/v1/contracts/deploy': 5,
        '/api/v1/bridge/lock': 5,
        '/api/v1/ai/contract/generate': 3
      }
    }
  },
  basic: {
    name: 'Basic',
    limits: {
      rpm: 100,
      rpd: 5000,
      concurrent: 5,
      endpoints: {
        '/api/v1/contracts/deploy': 20,
        '/api/v1/bridge/lock': 20,
        '/api/v1/ai/contract/generate': 10
      }
    }
  },
  pro: {
    name: 'Pro',
    limits: {
      rpm: 500,
      rpd: 50000,
      concurrent: 20,
      endpoints: {}
    }
  },
  enterprise: {
    name: 'Enterprise',
    limits: {
      rpm: 2000,
      rpd: 200000,
      concurrent: 100,
      endpoints: {}
    }
  }
};

class ApiKeyManager {
  constructor() {
    this.keys = new Map();
    this._ensureDataDir();
    this._loadKeys();
  }

  _ensureDataDir() {
    const dir = path.dirname(API_KEYS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _loadKeys() {
    try {
      if (fs.existsSync(API_KEYS_FILE)) {
        const data = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
        for (const [id, keyData] of Object.entries(data)) {
          this.keys.set(id, keyData);
        }
      }
    } catch (e) {
      console.error('[ApiKeyManager] Failed to load API keys:', e.message);
    }
  }

  _saveKeys() {
    try {
      const data = {};
      for (const [id, keyData] of this.keys.entries()) {
        data[id] = keyData;
      }
      fs.writeFileSync(API_KEYS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[ApiKeyManager] Failed to save API keys:', e.message);
    }
  }

  generateKey(owner, tier = 'free', metadata = {}) {
    const keyId = `ngk_${crypto.randomBytes(16).toString('hex')}`;
    const apiKey = `ng1_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    const keyData = {
      id: keyId,
      keyHash,
      keyPrefix: apiKey.substring(0, 8),
      owner,
      tier,
      limits: { ...DEFAULT_TIERS[tier].limits },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsed: null,
      status: 'active',
      usage: {
        totalRequests: 0,
        requestsThisMinute: 0,
        requestsToday: 0,
        lastMinuteReset: Date.now(),
        lastDayReset: Date.now(),
        endpoints: {}
      },
      metadata
    };

    this.keys.set(keyId, keyData);
    this._saveKeys();

    return { keyId, apiKey, tier, limits: keyData.limits };
  }

  validateKey(apiKey) {
    if (!apiKey || !apiKey.startsWith('ng1_')) {
      return null;
    }

    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    for (const [id, keyData] of this.keys.entries()) {
      if (keyData.keyHash === keyHash && keyData.status === 'active') {
        return { id, ...keyData };
      }
    }
    return null;
  }

  getKey(keyId) {
    return this.keys.get(keyId) || null;
  }

  updateKeyTier(keyId, newTier) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return false;

    if (!DEFAULT_TIERS[newTier]) return false;

    keyData.tier = newTier;
    keyData.limits = { ...DEFAULT_TIERS[newTier].limits };
    keyData.updatedAt = Date.now();
    this._saveKeys();
    return true;
  }

  revokeKey(keyId) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return false;

    keyData.status = 'revoked';
    keyData.updatedAt = Date.now();
    this._saveKeys();
    return true;
  }

  reactivateKey(keyId) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return false;

    keyData.status = 'active';
    keyData.updatedAt = Date.now();
    this._saveKeys();
    return true;
  }

  recordUsage(keyId, endpoint) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return;

    const now = Date.now();
    keyData.lastUsed = now;
    keyData.usage.totalRequests++;

    if (now - keyData.usage.lastMinuteReset > 60000) {
      keyData.usage.requestsThisMinute = 0;
      keyData.usage.lastMinuteReset = now;
    }
    keyData.usage.requestsThisMinute++;

    if (now - keyData.usage.lastDayReset > 86400000) {
      keyData.usage.requestsToday = 0;
      keyData.usage.lastDayReset = now;
    }
    keyData.usage.requestsToday++;

    if (!keyData.usage.endpoints[endpoint]) {
      keyData.usage.endpoints[endpoint] = { count: 0, lastReset: now };
    }
    if (now - keyData.usage.endpoints[endpoint].lastReset > 60000) {
      keyData.usage.endpoints[endpoint].count = 0;
      keyData.usage.endpoints[endpoint].lastReset = now;
    }
    keyData.usage.endpoints[endpoint].count++;

    if (now - keyData.lastUsed > 60000) {
      this._saveKeys();
    }
  }

  checkRateLimit(keyId, endpoint) {
    const keyData = this.keys.get(keyId);
    if (!keyData) return { allowed: false, reason: 'Invalid key', retryAfter: 60 };

    if (keyData.status !== 'active') {
      return { allowed: false, reason: 'Key is not active', retryAfter: 0 };
    }

    const tierConfig = DEFAULT_TIERS[keyData.tier];
    if (!tierConfig) return { allowed: false, reason: 'Invalid tier', retryAfter: 60 };

    const now = Date.now();

    if (now - keyData.usage.lastMinuteReset > 60000) {
      keyData.usage.requestsThisMinute = 0;
      keyData.usage.lastMinuteReset = now;
    }

    if (keyData.usage.requestsThisMinute >= tierConfig.limits.rpm) {
      const retryAfter = Math.ceil((60000 - (now - keyData.usage.lastMinuteReset)) / 1000);
      return { allowed: false, reason: `RPM limit exceeded (${tierConfig.limits.rpm}/min)`, retryAfter };
    }

    if (now - keyData.usage.lastDayReset > 86400000) {
      keyData.usage.requestsToday = 0;
      keyData.usage.lastDayReset = now;
    }

    if (keyData.usage.requestsToday >= tierConfig.limits.rpd) {
      return { allowed: false, reason: `Daily limit exceeded (${tierConfig.limits.rpd}/day)`, retryAfter: 86400 };
    }

    const endpointLimit = tierConfig.limits.endpoints[endpoint];
    if (endpointLimit) {
      if (!keyData.usage.endpoints[endpoint]) {
        keyData.usage.endpoints[endpoint] = { count: 0, lastReset: now };
      }
      const epUsage = keyData.usage.endpoints[endpoint];
      if (now - epUsage.lastReset > 60000) {
        epUsage.count = 0;
        epUsage.lastReset = now;
      }
      if (epUsage.count >= endpointLimit) {
        const retryAfter = Math.ceil((60000 - (now - epUsage.lastReset)) / 1000);
        return { allowed: false, reason: `Endpoint limit exceeded (${endpointLimit}/min for ${endpoint})`, retryAfter };
      }
    }

    return { allowed: true };
  }

  getAllKeys() {
    const result = [];
    for (const [id, keyData] of this.keys.entries()) {
      result.push({
        id,
        keyPrefix: keyData.keyPrefix,
        owner: keyData.owner,
        tier: keyData.tier,
        status: keyData.status,
        totalRequests: keyData.usage.totalRequests,
        lastUsed: keyData.lastUsed,
        createdAt: keyData.createdAt,
        updatedAt: keyData.updatedAt
      });
    }
    return result;
  }

  getStats() {
    let totalRequests = 0;
    let activeKeys = 0;
    const byTier = {};
    const byStatus = {};

    for (const [id, keyData] of this.keys.entries()) {
      totalRequests += keyData.usage.totalRequests;
      if (keyData.status === 'active') activeKeys++;

      byTier[keyData.tier] = (byTier[keyData.tier] || 0) + 1;
      byStatus[keyData.status] = (byStatus[keyData.status] || 0) + 1;
    }

    return {
      totalKeys: this.keys.size,
      activeKeys,
      totalRequests,
      byTier,
      byStatus,
      tiers: Object.keys(DEFAULT_TIERS).map(t => ({
        name: DEFAULT_TIERS[t].name,
        tier: t,
        limits: DEFAULT_TIERS[t].limits
      }))
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [id, keyData] of this.keys.entries()) {
      if (now - keyData.usage.lastMinuteReset > 120000) {
        keyData.usage.requestsThisMinute = 0;
        keyData.usage.lastMinuteReset = now;
      }
      for (const ep of Object.values(keyData.usage.endpoints || {})) {
        if (now - ep.lastReset > 120000) {
          ep.count = 0;
          ep.lastReset = now;
        }
      }
    }
  }
}

export { ApiKeyManager, DEFAULT_TIERS };
export default ApiKeyManager;