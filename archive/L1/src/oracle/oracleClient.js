import https from 'https';
import http from 'http';
import crypto from 'crypto';

const ORACLE_SOURCES = {
  PRICE_FEED: {
    name: 'PriceFeed',
    endpoints: {
      'NGEN/USD': { price: 0.1, volatility: 0.02 },
      'ETH/USD': { price: 2500, volatility: 0.05 },
      'BTC/USD': { price: 48000, volatility: 0.04 },
      'SOL/USD': { price: 120, volatility: 0.06 },
      'MATIC/USD': { price: 0.85, volatility: 0.05 }
    }
  },
  WEATHER: {
    name: 'WeatherData',
    endpoints: {
      temperature: { current: 22, unit: '°C' },
      humidity: { current: 65, unit: '%' },
      windSpeed: { current: 12, unit: 'km/h' }
    }
  },
  RANDOM: {
    name: 'RandomGenerator',
    endpoints: {
      'vrf/number': { method: 'GET' },
      'vrf/bytes': { method: 'GET' }
    }
  }
};

class OracleClient {
  constructor(options = {}) {
    this.sources = options.sources || ORACLE_SOURCES;
    this.cache = new Map();
    this.cacheTTL = options.cacheTTL || 60000;
    this.trustedOracles = new Map();
    this.dataFeeds = new Map();
    this.bridgeSubscriptions = new Map();
  }

  async getPrice(pair) {
    const cached = this._getCached(`price:${pair}`);
    if (cached) return cached;

    const source = this.sources.PRICE_FEED;
    const priceData = source.endpoints[pair];

    if (priceData) {
      const volatility = priceData.volatility;
      const drift = (Math.random() - 0.5) * 2 * volatility;
      const price = priceData.price * (1 + drift);
      const result = {
        success: true,
        data: {
          pair,
          price: Math.round(price * 100) / 100,
          timestamp: Date.now(),
          source: 'NexusGenesis Price Oracle',
          confidence: 0.95
        }
      };
      this._setCache(`price:${pair}`, result);
      return result;
    }

    return { success: false, message: `Unknown pair: ${pair}` };
  }

  async getWeather(city = 'default') {
    const cached = this._getCached(`weather:${city}`);
    if (cached) return cached;

    const source = this.sources.WEATHER;
    const result = {
      success: true,
      data: {
        city,
        temperature: source.endpoints.temperature.current + Math.floor(Math.random() * 5 - 2),
        humidity: source.endpoints.humidity.current + Math.floor(Math.random() * 10 - 5),
        windSpeed: source.endpoints.windSpeed.current + Math.floor(Math.random() * 5 - 2),
        timestamp: Date.now(),
        source: 'NexusGenesis Weather Oracle'
      }
    };
    this._setCache(`weather:${city}`, result);
    return result;
  }

  async getRandomNumber(min = 0, max = 2 ** 256 - 1) {
    const randomBytes = crypto.randomBytes(32);
    const randomBigInt = BigInt('0x' + randomBytes.toString('hex'));
    const range = BigInt(max) - BigInt(min) + 1n;
    const randomNum = Number(randomBigInt % range + BigInt(min));
    return {
      success: true,
      data: {
        value: randomNum,
        min,
        max,
        timestamp: Date.now(),
        proof: randomBytes.toString('base64')
      }
    };
  }

  async getRandomBytes(count = 32) {
    const bytes = crypto.randomBytes(count);
    return {
      success: true,
      data: {
        bytes: bytes.toString('hex'),
        timestamp: Date.now(),
        proof: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    };
  }

  async fetchExternalFeed(url) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      protocol.get(url, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ success: true, data: JSON.parse(data) });
          } catch (e) {
            resolve({ success: true, data: { raw: data } });
          }
        });
      }).on('error', (e) => {
        resolve({ success: false, message: `External feed error: ${e.message}` });
      }).on('timeout', () => {
        resolve({ success: false, message: 'External feed timeout' });
      }).destroy();
    });
  }

  registerOracle(name, endpoint, signingKey) {
    const oracle = {
      name,
      endpoint,
      signingKey,
      registeredAt: Date.now(),
      reputation: 100,
      successfulDeliveries: 0,
      failedDeliveries: 0
    };
    this.trustedOracles.set(name, oracle);
    return oracle;
  }

  async queryOracle(name, query) {
    const oracle = this.trustedOracles.get(name);
    if (!oracle) {
      return { success: false, message: `Oracle "${name}" not found` };
    }

    try {
      const result = await this.fetchExternalFeed(oracle.endpoint + '?' + new URLSearchParams(query));
      if (result.success) {
        oracle.successfulDeliveries++;
      } else {
        oracle.failedDeliveries++;
      }
      return result;
    } catch (e) {
      oracle.failedDeliveries++;
      return { success: false, message: e.message };
    }
  }

  subscribeToFeed(feedId, callback) {
    const subscription = {
      id: crypto.randomBytes(8).toString('hex'),
      feedId,
      callback,
      interval: null
    };
    this.dataFeeds.set(subscription.id, subscription);
    return subscription.id;
  }

  startFeed(subscriptionId, intervalMs = 30000) {
    const sub = this.dataFeeds.get(subscriptionId);
    if (!sub) return false;

    sub.interval = setInterval(async () => {
      let data;
      if (sub.feedId.startsWith('price:')) {
        data = await this.getPrice(sub.feedId.replace('price:', ''));
      } else if (sub.feedId.startsWith('weather:')) {
        data = await this.getWeather(sub.feedId.replace('weather:', ''));
      } else if (sub.feedId === 'random:number') {
        data = await this.getRandomNumber();
      } else {
        data = { success: false, message: 'Unknown feed' };
      }
      sub.callback(data);
    }, intervalMs);

    return true;
  }

  stopFeed(subscriptionId) {
    const sub = this.dataFeeds.get(subscriptionId);
    if (sub && sub.interval) {
      clearInterval(sub.interval);
      sub.interval = null;
    }
  }

  getAllOracles() {
    const list = [];
    for (const [name, oracle] of this.trustedOracles) {
      list.push({
        name: oracle.name,
        reputation: oracle.reputation,
        successfulDeliveries: oracle.successfulDeliveries,
        failedDeliveries: oracle.failedDeliveries,
        registeredAt: oracle.registeredAt
      });
    }
    return list;
  }

  getAllFeeds() {
    const feeds = [];
    for (const [, sub] of this.dataFeeds) {
      feeds.push({
        id: sub.id,
        feedId: sub.feedId,
        active: sub.interval !== null
      });
    }
    return feeds;
  }

  _getCached(key) {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTTL) {
      return entry.data;
    }
    return null;
  }

  _setCache(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  clearCache() {
    this.cache.clear();
  }
}

export { OracleClient, ORACLE_SOURCES };
export default OracleClient;