import { describe, it, before } from 'node:test';
import assert from 'assert';
import fs from 'fs';
import crypto from 'crypto';

describe('Plugin Manager', () => {
  let PluginManager;

  before(async () => {
    const mod = await import('../src/http/pluginManager.js');
    PluginManager = mod.default;
  });

  it('should initialize with default options', () => {
    const pm = new PluginManager();
    assert.strictEqual(pm.status, 'initialized');
    assert.strictEqual(pm.plugins.size, 0);
    assert.ok(pm.hooks.has('onInit'));
    assert.ok(pm.hooks.has('onReady'));
    assert.ok(pm.hooks.has('onShutdown'));
    assert.ok(pm.hooks.has('onBlockProduced'));
    assert.ok(pm.hooks.has('onError'));
  });

  it('should initialize with custom plugins dir', () => {
    const pm = new PluginManager({ pluginsDir: '/custom/plugins' });
    assert.ok(pm.pluginsDir.includes('custom'));
  });

  it('should register a valid plugin', async () => {
    const pm = new PluginManager();
    const plugin = {
      name: 'test-plugin',
      version: '1.0.0',
      dependencies: [],
      hooks: {},
      onRegister: null
    };

    const result = await pm.register(plugin);
    assert.strictEqual(result, true);
    assert.strictEqual(pm.plugins.has('test-plugin'), true);
    assert.strictEqual(pm.plugins.get('test-plugin').status, 'registered');
  });

  it('should reject plugin without name', async () => {
    const pm = new PluginManager();
    await assert.rejects(
      () => pm.register({ version: '1.0.0' }),
      /name and version/
    );
  });

  it('should reject plugin without version', async () => {
    const pm = new PluginManager();
    await assert.rejects(
      () => pm.register({ name: 'test' }),
      /name and version/
    );
  });

  it('should reject duplicate plugin registration', async () => {
    const pm = new PluginManager();
    await pm.register({ name: 'dup', version: '1.0.0' });
    await assert.rejects(
      () => pm.register({ name: 'dup', version: '1.0.0' }),
      /already registered/
    );
  });

  it('should validate plugin dependencies', async () => {
    const pm = new PluginManager();
    await assert.rejects(
      () => pm.register({
        name: 'dependent',
        version: '1.0.0',
        dependencies: ['nonexistent']
      }),
      /depends on.*not registered/
    );
  });

  it('should register plugin hooks', async () => {
    const pm = new PluginManager();

    await pm.register({
      name: 'hook-plugin',
      version: '1.0.0',
      hooks: {
        onInit: () => {},
        onReady: () => {}
      }
    });

    assert.strictEqual(pm.hooks.get('onInit').has('hook-plugin'), true);
    assert.strictEqual(pm.hooks.get('onReady').has('hook-plugin'), true);
  });

  it('should reject unknown hook names', async () => {
    const pm = new PluginManager();
    await assert.rejects(
      () => pm.register({
        name: 'bad-hook',
        version: '1.0.0',
        hooks: { unknownHook: () => {} }
      }),
      /Unknown hook/
    );
  });

  it('should call onRegister lifecycle', async () => {
    const pm = new PluginManager();
    let called = false;

    await pm.register({
      name: 'lifecycle',
      version: '1.0.0',
      onRegister: async () => {
        called = true;
      }
    });

    assert.strictEqual(called, true);
  });

  it('should get plugin by name', async () => {
    const pm = new PluginManager();
    await pm.register({ name: 'findable', version: '1.0.0' });

    const found = pm.get('findable');
    assert.ok(found);
    assert.strictEqual(found.name, 'findable');
  });

  it('should return null for unknown plugin', () => {
    const pm = new PluginManager();
    assert.strictEqual(pm.get('unknown'), null);
  });

  it('should list all plugins', async () => {
    const pm = new PluginManager();
    await pm.register({ name: 'p1', version: '1.0.0' });
    await pm.register({ name: 'p2', version: '2.0.0' });

    const list = pm.getAll();
    assert.strictEqual(list.length, 2);
  });
});

describe('API Key Manager', () => {
  let ApiKeyManager, DEFAULT_TIERS;

  before(async () => {
    const mod = await import('../src/http/apiKeyManager.js');
    ApiKeyManager = mod.ApiKeyManager;
    DEFAULT_TIERS = mod.DEFAULT_TIERS;
  });

  it('should generate API key for tier', () => {
    const akm = new ApiKeyManager();
    const result = akm.generateKey('test-user', 'basic');

    assert.ok(result.keyId);
    assert.ok(result.apiKey);
    assert.ok(result.apiKey.startsWith('ng1_'));
    assert.strictEqual(result.tier, 'basic');
    assert.ok(result.limits);
  });

  it('should generate unique API keys', () => {
    const akm = new ApiKeyManager();
    const result1 = akm.generateKey('user1', 'free');
    const result2 = akm.generateKey('user2', 'free');

    assert.notStrictEqual(result1.apiKey, result2.apiKey);
    assert.notStrictEqual(result1.keyId, result2.keyId);
  });

  it('should validate API key', () => {
    const akm = new ApiKeyManager();
    const result = akm.generateKey('user', 'pro');

    const validation = akm.validateKey(result.apiKey);
    assert.ok(validation);
    assert.strictEqual(validation.tier, 'pro');
  });

  it('should reject invalid API key', () => {
    const akm = new ApiKeyManager();
    assert.strictEqual(akm.validateKey('ng1_invalid_key_here'), null);
    assert.strictEqual(akm.validateKey(''), null);
    assert.strictEqual(akm.validateKey(null), null);
    assert.strictEqual(akm.validateKey('not_ng_prefix'), null);
  });

  it('should check rate limits', () => {
    const akm = new ApiKeyManager();
    const result = akm.generateKey('rate-user', 'free');

    const check = akm.checkRateLimit(result.keyId, '/api/v1/status');
    assert.strictEqual(check.allowed, true);

    // recordUsage 会增加计数器
    akm.recordUsage(result.keyId, '/api/v1/status');
    const check2 = akm.checkRateLimit(result.keyId, '/api/v1/status');
    assert.strictEqual(check2.allowed, true);
  });

  it('should enforce rate limits', () => {
    const akm = new ApiKeyManager();
    const result = akm.generateKey('limit-user', 'free');

    // free tier RPM=30，调用 31 次 recordUsage 后应触发限制
    for (let i = 0; i < 30; i++) {
      akm.recordUsage(result.keyId, '/api/v1/status');
    }
    let check = akm.checkRateLimit(result.keyId, '/api/v1/status');
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason.includes('RPM'));
  });

  it('should revoke API key by keyId', () => {
    const akm = new ApiKeyManager();
    const result = akm.generateKey('revoke-user', 'basic');

    const revoked = akm.revokeKey(result.keyId);
    assert.strictEqual(revoked, true);

    assert.strictEqual(akm.validateKey(result.apiKey), null);
  });

  it('should get all keys', () => {
    const akm = new ApiKeyManager();
    akm.generateKey('multi-user', 'free');
    akm.generateKey('multi-user', 'pro');

    const keys = akm.getAllKeys();
    assert.ok(keys.length >= 2);
  });

  it('should have all default tiers', () => {
    assert.ok(DEFAULT_TIERS.free);
    assert.ok(DEFAULT_TIERS.basic);
    assert.ok(DEFAULT_TIERS.pro);
    assert.ok(DEFAULT_TIERS.enterprise);
    assert.strictEqual(DEFAULT_TIERS.free.limits.rpm, 30);
    assert.strictEqual(DEFAULT_TIERS.enterprise.limits.concurrent, 100);
  });

  it('should get usage stats', () => {
    const akm = new ApiKeyManager();
    const result = akm.generateKey('stats-user', 'free');
    akm.recordUsage(result.keyId, '/api/v1/status');

    const stats = akm.getStats();
    assert.ok(stats.totalKeys >= 1);
    assert.ok(stats.activeKeys >= 1);
    assert.ok(stats.totalRequests >= 1);
  });
});

describe('Oracle Client', () => {
  let OracleClient;

  before(async () => {
    const mod = await import('../src/oracle/oracleClient.js');
    OracleClient = mod.default;
  });

  it('should initialize with default sources', () => {
    const oc = new OracleClient();
    assert.ok(oc.sources.PRICE_FEED);
    assert.ok(oc.sources.WEATHER);
    assert.ok(oc.sources.RANDOM);
  });

  it('should get price for valid pair', async () => {
    const oc = new OracleClient();
    const result = await oc.getPrice('NGEN/USD');

    assert.strictEqual(result.success, true);
    assert.ok(result.data.price > 0);
    assert.strictEqual(result.data.pair, 'NGEN/USD');
    assert.ok(result.data.timestamp);
    assert.ok(result.data.confidence);
  });

  it('should get BTC/USD price', async () => {
    const oc = new OracleClient();
    const result = await oc.getPrice('BTC/USD');

    assert.strictEqual(result.success, true);
    assert.ok(result.data.price > 0);
  });

  it('should reject unknown price pair', async () => {
    const oc = new OracleClient();
    const result = await oc.getPrice('UNKNOWN/XYZ');

    assert.strictEqual(result.success, false);
    assert.ok(result.message);
  });

  it('should cache price results', async () => {
    const oc = new OracleClient({ cacheTTL: 60000 });
    const result1 = await oc.getPrice('ETH/USD');
    const result2 = await oc.getPrice('ETH/USD');

    assert.strictEqual(result1.data.price, result2.data.price);
  });

  it('should get weather data', async () => {
    const oc = new OracleClient();
    const result = await oc.getWeather();

    assert.strictEqual(result.success, true);
    assert.ok('temperature' in result.data);
    assert.ok('humidity' in result.data);
    assert.ok('windSpeed' in result.data);
  });

  it('should generate random number via VRF', async () => {
    const oc = new OracleClient();
    const result = await oc.getRandomNumber();

    assert.strictEqual(result.success, true);
    assert.ok(typeof result.data.value === 'number');
    assert.ok(result.data.value >= 0);
    assert.ok(result.data.proof);
  });

  it('should generate random bytes via VRF', async () => {
    const oc = new OracleClient();
    const result = await oc.getRandomBytes(32);

    assert.strictEqual(result.success, true);
    assert.ok(result.data.bytes);
    assert.strictEqual(result.data.bytes.length, 64);
    assert.ok(result.data.proof);
  });

  it('should register trusted oracle with signing key', () => {
    const oc = new OracleClient();
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const signingKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });

    oc.registerOracle('oracle1', 'https://oracle1.example.com', signingKey);

    assert.strictEqual(oc.trustedOracles.has('oracle1'), true);
  });

  it('should subscribe to data feed', () => {
    const oc = new OracleClient();
    const callback = () => {};

    const subId = oc.subscribeToFeed('NGEN/USD', callback);
    assert.ok(oc.dataFeeds.has(subId));
    assert.strictEqual(typeof subId, 'string');
  });

  it('should list all oracles', () => {
    const oc = new OracleClient();
    oc.registerOracle('oracle1', 'https://oracle1.example.com', Buffer.from('key1'));
    oc.registerOracle('oracle2', 'https://oracle2.example.com', Buffer.from('key2'));

    const oracles = oc.getAllOracles();
    assert.strictEqual(oracles.length, 2);
  });

  it('should list all feeds', () => {
    const oc = new OracleClient();
    oc.subscribeToFeed('ETH/USD', () => {});

    const feeds = oc.getAllFeeds();
    assert.strictEqual(feeds.length, 1);
  });
});

describe('Notification Service', () => {
  let NotificationService;

  before(async () => {
    const mod = await import('../src/automation/notificationService.js');
    NotificationService = mod.default;
  });

  it('should initialize with default config', () => {
    const ns = new NotificationService();
    assert.strictEqual(ns.config.console.enabled, true);
    assert.strictEqual(ns.config.file.enabled, true);
    assert.strictEqual(ns.config.email.enabled, false);
    assert.strictEqual(ns.config.sms.enabled, false);
    assert.strictEqual(ns.config.webhook.enabled, false);
  });

  it('should send console notification', async () => {
    const ns = new NotificationService();
    const results = await ns.send({
      subject: 'Test Alert',
      message: 'This is a test',
      channels: ['console']
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].channel, 'console');
    assert.strictEqual(results[0].success, true);
    assert.strictEqual(results[0].result.status, 'console');
  });

  it('should send file notification', async () => {
    const ns = new NotificationService();
    const results = await ns.send({
      subject: 'Test File Alert',
      message: 'Saved to file',
      channels: ['file']
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].channel, 'file');
    assert.strictEqual(results[0].success, true);
    assert.strictEqual(results[0].result.status, 'written');

    if (results[0].result.path && fs.existsSync(results[0].result.path)) {
      fs.unlinkSync(results[0].result.path);
    }
  });

  it('should send to multiple channels', async () => {
    const ns = new NotificationService();
    const results = await ns.send({
      subject: 'Multi Channel',
      message: 'Test',
      channels: ['console', 'file']
    });

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results.every(r => r.success), true);

    const fileResult = results.find(r => r.channel === 'file');
    if (fileResult && fileResult.result.path && fs.existsSync(fileResult.result.path)) {
      fs.unlinkSync(fileResult.result.path);
    }
  });

  it('should handle alert with level prefix', async () => {
    const ns = new NotificationService();
    const results = await ns.send({
      subject: 'Critical Issue',
      message: 'System down',
      alert: { type: 'SYSTEM_DOWN', level: 'critical' },
      channels: ['console']
    });

    assert.strictEqual(results[0].success, true);
  });

  it('should reject unknown channel', async () => {
    const ns = new NotificationService();
    const results = await ns.send({
      subject: 'Bad Channel',
      message: 'Test',
      channels: ['unknown_channel']
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].success, false);
  });

  it('should configure channels', () => {
    const ns = new NotificationService();
    ns.configure({
      email: { enabled: true, smtpHost: 'smtp.example.com', to: ['admin@test.com'] },
      sms: { enabled: true, phoneNumbers: ['+1234567890'] }
    });

    assert.strictEqual(ns.config.email.enabled, true);
    assert.strictEqual(ns.config.email.to[0], 'admin@test.com');
    assert.strictEqual(ns.config.sms.enabled, true);
  });

  it('should handle disabled email gracefully', async () => {
    const ns = new NotificationService();
    const results = await ns.send({
      subject: 'Email Test',
      message: 'Should fail gracefully',
      channels: ['email']
    });

    assert.strictEqual(results[0].success, false);
  });
});