import { PQCWallet } from '../wallet/pqcWallet.js';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FAUCET_DATA_DIR = path.join(__dirname, '../../data/faucet');

const FAUCET_CONFIG = {
  DEFAULT_DISTRIBUTION: 1000n,
  MIN_DISTRIBUTION: 100n,
  MAX_DISTRIBUTION: 10000n,
  COOLDOWN_PER_ADDRESS: 24 * 60 * 60 * 1000,
  COOLDOWN_PER_IP: 60 * 60 * 1000,
  DAILY_CAP: 1000000n,
  RATE_LIMIT_WINDOW: 60000,
  MAX_REQUESTS_PER_WINDOW: 5,
  ADDRESS_REGEX: /^ng1[a-km-zA-HJ-NP-Z1-9]{30,60}$/
};

class TokenFaucet {
  constructor(options = {}) {
    this.config = { ...FAUCET_CONFIG, ...options };

    this.distributions = new Map();
    this.dailyDistributed = 0n;
    this.dailyResetDate = this._getDateKey();

    this.addressCooldowns = new Map();
    this.ipCooldowns = new Map();
    this.ipRateCounters = new Map();

    this.blockedAddresses = new Set();
    this.blockedIPs = new Set();

    this.waitingQueue = [];

    this.stats = {
      totalDistributed: 0n,
      totalClaims: 0,
      uniqueAddresses: 0,
      rejectedClaims: 0,
      lastDistribution: null
    };

    this._initDirectories();
    this._loadState();
    this._startDailyReset();
  }

  _initDirectories() {
    if (!fs.existsSync(FAUCET_DATA_DIR)) {
      fs.mkdirSync(FAUCET_DATA_DIR, { recursive: true });
    }
  }

  _loadState() {
    try {
      const stateFile = path.join(FAUCET_DATA_DIR, 'state.json');
      if (fs.existsSync(stateFile)) {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (data.stats) {
          this.stats.totalDistributed = BigInt(data.stats.totalDistributed || '0');
          this.stats.totalClaims = data.stats.totalClaims || 0;
          this.stats.uniqueAddresses = data.stats.uniqueAddresses || 0;
        }
      }
    } catch (e) { /* ignore */ }
  }

  _saveState() {
    try {
      fs.writeFileSync(
        path.join(FAUCET_DATA_DIR, 'state.json'),
        JSON.stringify({
          stats: {
            totalDistributed: this.stats.totalDistributed.toString(),
            totalClaims: this.stats.totalClaims,
            uniqueAddresses: this.stats.uniqueAddresses
          },
          updatedAt: Date.now()
        }, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2)
      );
    } catch (e) { /* ignore */ }
  }

  _getDateKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _startDailyReset() {
    const reset = () => {
      const today = this._getDateKey();
      if (today !== this.dailyResetDate) {
        this.dailyDistributed = 0n;
        this.dailyResetDate = today;
        this.addressCooldowns.clear();
      }
    };
    reset();
    setInterval(reset, 60000).unref();
  }

  async drip(ip = 'unknown', requestedAmount = null) {
    const amount = requestedAmount ? BigInt(requestedAmount) : this.config.DEFAULT_DISTRIBUTION;

    const rateCheck = this._checkRateLimit(ip);
    if (!rateCheck.allowed) {
      this.stats.rejectedClaims++;
      return { success: false, reason: rateCheck.reason, retryAfterMs: rateCheck.retryAfterMs };
    }

    if (this.blockedIPs.has(ip)) {
      this.stats.rejectedClaims++;
      return { success: false, reason: 'IP address is blocked' };
    }

    if (amount < this.config.MIN_DISTRIBUTION) {
      return { success: false, reason: `Minimum distribution is ${this.config.MIN_DISTRIBUTION} NGEN` };
    }

    if (amount > this.config.MAX_DISTRIBUTION) {
      return { success: false, reason: `Maximum distribution is ${this.config.MAX_DISTRIBUTION} NGEN` };
    }

    const remainingDaily = this.config.DAILY_CAP - this.dailyDistributed;
    if (amount > remainingDaily) {
      this.stats.rejectedClaims++;
      return {
        success: false,
        reason: `Daily cap reached. Available: ${remainingDaily} NGEN. Resets tomorrow.`,
        remainingDaily: Number(remainingDaily)
      };
    }

    const wallet = await PQCWallet.generate(amount);
    const distributionId = createHash('sha256')
      .update(wallet.address + Date.now().toString())
      .digest('hex')
      .slice(0, 16);

    const distribution = {
      id: distributionId,
      address: wallet.address,
      publicKey: wallet.publicKey.toString('hex'),
      amount: Number(amount),
      ip,
      timestamp: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
    };

    this.distributions.set(distributionId, distribution);
    this.addressCooldowns.set(wallet.address, Date.now());
    this.ipCooldowns.set(ip, Date.now());
    this.dailyDistributed += amount;

    this.stats.totalDistributed += amount;
    this.stats.totalClaims++;
    this.stats.uniqueAddresses = this.addressCooldowns.size;
    this.stats.lastDistribution = distributionId;

    this._saveState();

    return {
      success: true,
      distribution,
      wallet: {
        address: wallet.address,
        publicKey: wallet.publicKey.toString('hex'),
        balance: Number(amount),
        encryptedWallet: wallet.exportEncrypted(`faucet-${distributionId}`)
      }
    };
  }

  async dripToAddress(ip, address, amount) {
    if (!this.config.ADDRESS_REGEX.test(address)) {
      return { success: false, reason: 'Invalid address format. Must start with ng1' };
    }

    if (this.blockedAddresses.has(address)) {
      this.stats.rejectedClaims++;
      return { success: false, reason: 'Address is blocked' };
    }

    const cooldownRemaining = this._getAddressCooldown(address);
    if (cooldownRemaining > 0) {
      return {
        success: false,
        reason: 'Address in cooldown',
        retryAfterMs: cooldownRemaining
      };
    }

    return this.drip(ip, amount);
  }

  _checkRateLimit(ip) {
    const now = Date.now();
    let counter = this.ipRateCounters.get(ip);

    if (!counter || now - counter.windowStart > this.config.RATE_LIMIT_WINDOW) {
      counter = { count: 0, windowStart: now };
      this.ipRateCounters.set(ip, counter);
    }

    counter.count++;

    if (counter.count > this.config.MAX_REQUESTS_PER_WINDOW) {
      const retryAfterMs = this.config.RATE_LIMIT_WINDOW - (now - counter.windowStart);
      return {
        allowed: false,
        reason: `Rate limited. Max ${this.config.MAX_REQUESTS_PER_WINDOW} requests per ${this.config.RATE_LIMIT_WINDOW / 1000}s`,
        retryAfterMs: Math.max(0, retryAfterMs)
      };
    }

    const ipCooldownRemaining = this._getIPCooldown(ip);
    if (ipCooldownRemaining > 0) {
      return { allowed: false, reason: 'IP in cooldown', retryAfterMs: ipCooldownRemaining };
    }

    return { allowed: true };
  }

  _getAddressCooldown(address) {
    const lastClaim = this.addressCooldowns.get(address);
    if (!lastClaim) return 0;
    const elapsed = Date.now() - lastClaim;
    return Math.max(0, this.config.COOLDOWN_PER_ADDRESS - elapsed);
  }

  _getIPCooldown(ip) {
    const lastClaim = this.ipCooldowns.get(ip);
    if (!lastClaim) return 0;
    const elapsed = Date.now() - lastClaim;
    return Math.max(0, this.config.COOLDOWN_PER_IP - elapsed);
  }

  getDistribution(distributionId) {
    return this.distributions.get(distributionId) || null;
  }

  getAddressCooldown(address) {
    return {
      address,
      cooldownRemainingMs: this._getAddressCooldown(address),
      blocked: this.blockedAddresses.has(address)
    };
  }

  checkEligibility(address) {
    const cooldown = this._getAddressCooldown(address);
    const dailyRemaining = Number(this.config.DAILY_CAP - this.dailyDistributed);

    return {
      eligible: cooldown === 0 && dailyRemaining >= Number(this.config.MIN_DISTRIBUTION),
      addressCooldownRemainingMs: cooldown,
      dailyRemaining,
      minDistribution: Number(this.config.MIN_DISTRIBUTION),
      maxDistribution: Number(this.config.MAX_DISTRIBUTION),
      defaultDistribution: Number(this.config.DEFAULT_DISTRIBUTION)
    };
  }

  blockAddress(address, reason = '') {
    this.blockedAddresses.add(address);
    return { success: true, blocked: address, reason };
  }

  unblockAddress(address) {
    const removed = this.blockedAddresses.delete(address);
    return { success: true, unblocked: removed ? address : null };
  }

  blockIP(ip, reason = '') {
    this.blockedIPs.add(ip);
    return { success: true, blocked: ip, reason };
  }

  unblockIP(ip) {
    const removed = this.blockedIPs.delete(ip);
    return { success: true, unblocked: removed ? ip : null };
  }

  getStats() {
    return {
      ...this.stats,
      totalDistributed: Number(this.stats.totalDistributed),
      dailyDistributed: Number(this.dailyDistributed),
      dailyCap: Number(this.config.DAILY_CAP),
      dailyRemaining: Number(this.config.DAILY_CAP - this.dailyDistributed),
      blockedAddresses: this.blockedAddresses.size,
      blockedIPs: this.blockedIPs.size,
      activeCooldowns: this.addressCooldowns.size,
      defaultDistribution: Number(this.config.DEFAULT_DISTRIBUTION)
    };
  }

  cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, dist] of this.distributions) {
      if (dist.expiresAt < now) {
        this.distributions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}

const tokenFaucet = new TokenFaucet();
export { TokenFaucet };
export default tokenFaucet;
