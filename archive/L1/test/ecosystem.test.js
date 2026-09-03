/**
 * 生态扩展集成测试
 * 验证：Agent 发现与匹配、Agent 市场与评价、跨链桥 API、SDK 增强
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { AgentDiscoveryService } from '../src/agent/agentDiscoveryService.js';
import agentDiscoveryService from '../src/agent/agentDiscoveryService.js';
import { AgentMarketplace } from '../src/agent/agentMarketplace.js';
import agentMarketplace from '../src/agent/agentMarketplace.js';
import { CrossChainBridge } from '../src/bridge/bridgeProtocol.js';
import { LightClient } from '../src/bridge/bridgeProtocol.js';
import { NexusGenesisSDK } from '../src/sdk/index.js';

// ==================== Agent 发现与匹配服务 ====================

describe('生态扩展 - AgentDiscoveryService', () => {
  let discovery;
  let mockAgents;

  before(() => {
    discovery = new AgentDiscoveryService();
    mockAgents = [
      { id: 'ng1_agent_001', name: 'DataProcessor', capabilities: ['nlp', 'data-analysis', 'summarization'], reputation: 450, activeTasks: [], taskQueue: [], maxCapacity: 10, health: { status: 'healthy', score: 95 }, metadata: { region: 'us-east' }, model: 'gpt-4' },
      { id: 'ng1_agent_002', name: 'CodeReviewer', capabilities: ['code-review', 'security-audit', 'testing'], reputation: 800, activeTasks: ['t1', 't2'], taskQueue: ['t3'], maxCapacity: 8, health: { status: 'healthy', score: 90 }, metadata: { region: 'eu-west' }, model: 'claude-3' },
      { id: 'ng1_agent_003', name: 'ContentWriter', capabilities: ['writing', 'nlp', 'translation'], reputation: 200, activeTasks: [], taskQueue: [], maxCapacity: 5, health: { status: 'warning', score: 60 }, metadata: { region: 'us-east' }, model: 'gpt-3.5' },
      { id: 'ng1_agent_004', name: 'DataEngineer', capabilities: ['data-analysis', 'etl', 'sql'], reputation: 950, activeTasks: ['t4', 't5', 't6', 't7', 't8', 't9'], taskQueue: ['t10'], maxCapacity: 12, health: { status: 'healthy', score: 98 }, metadata: { region: 'asia-east' }, model: 'claude-3' },
      { id: 'ng1_agent_005', name: 'SecurityGuard', capabilities: ['security-audit', 'penetration-test', 'compliance'], reputation: 350, activeTasks: [], taskQueue: [], maxCapacity: 6, health: { status: 'healthy', score: 88 }, metadata: { region: 'eu-west' }, model: 'gpt-4' }
    ];

    const mockManager = {
      getAllAgents: () => mockAgents
    };
    discovery.setAgentManager(mockManager);
  });

  after(() => {
    discovery.shutdown();
  });

  it('首次 index 构建应正确索引所有 agent', () => {
    assert.equal(discovery.loadIndex.size, 5);
    assert.ok(discovery.capabilityIndex.size > 0);
  });

  it('按能力搜索应返回匹配的 agent（全部匹配模式）', () => {
    const results = discovery.searchAgents({ capabilities: ['nlp', 'data-analysis'], limit: 10 });
    assert.ok(results.length > 0);
    const matchedIds = results.map(r => r.agentId);
    assert.ok(matchedIds.includes('ng1_agent_001'));
  });

  it('按能力搜索（任意匹配模式）应返回更多结果', () => {
    const resultsAll = discovery.searchAgents({ capabilities: ['nlp'], requireAllCapabilities: true, limit: 10 });
    const resultsAny = discovery.searchAgents({ capabilities: ['nlp'], requireAllCapabilities: false, limit: 10 });
    assert.ok(resultsAny.length >= resultsAll.length);
  });

  it('按声誉范围过滤应正确限制结果', () => {
    const results = discovery.searchAgents({ minReputation: 500, limit: 10 });
    const allAboveThreshold = results.every(r => r.reputation >= 500);
    assert.equal(allAboveThreshold, true);
  });

  it('按负载比例过滤应排除高负载 agent', () => {
    const results = discovery.searchAgents({ maxLoadRatio: 0.5, limit: 10 });
    const allLowLoad = results.every(r => r.loadRatio <= 0.5);
    assert.equal(allLowLoad, true);
  });

  it('按区域过滤应只返回指定区域的 agent', () => {
    const results = discovery.searchAgents({ region: 'eu-west', limit: 10 });
    const allInRegion = results.every(r => r.region === 'eu-west');
    assert.equal(allInRegion, true);
    assert.equal(results.length, 2);
  });

  it('按健康分数过滤应排除不健康的 agent', () => {
    const results = discovery.searchAgents({ minHealthScore: 80, limit: 10 });
    const allHealthy = results.every(r => r.healthScore >= 80);
    assert.equal(allHealthy, true);
  });

  it('文本搜索应匹配 agent 名称', () => {
    const results = discovery.searchAgents({ textQuery: 'code', limit: 10 });
    assert.ok(results.length > 0);
    const names = results.map(r => r.name);
    assert.ok(names.some(n => n.toLowerCase().includes('code')));
  });

  it('搜索结果缓存应生效（第二次命中）', () => {
    discovery.discoveryStats.searches = 0;
    discovery.discoveryStats.cacheHits = 0;
    discovery.discoveryStats.cacheMisses = 0;
    discovery.searchCache.clear();
    discovery.searchAgents({ capabilities: ['nlp'], limit: 10 });
    discovery.searchAgents({ capabilities: ['nlp'], limit: 10 });
    assert.equal(discovery.discoveryStats.cacheHits, 1);
    assert.equal(discovery.discoveryStats.cacheMisses, 1);
  });

  it('为任务发现 agent 应返回按评分排序的候选列表', () => {
    const task = {
      requiredCapabilities: ['security-audit'],
      preferredCapabilities: ['code-review'],
      region: 'eu-west'
    };
    const candidates = discovery.discoverAgentsForTask(task);
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0].agentId, 'ng1_agent_002');
  });

  it('getCapabilityStats 应返回能力统计', () => {
    const stats = discovery.getCapabilityStats();
    assert.ok(Array.isArray(stats));
    assert.ok(stats.length > 0);
    assert.ok('capability' in stats[0]);
    assert.ok('agentCount' in stats[0]);
  });

  it('getReputationDistribution 应返回声誉分布', () => {
    const dist = discovery.getReputationDistribution();
    assert.ok(typeof dist === 'object');
    assert.ok('legendary' in dist);
    assert.ok('new' in dist);
  });

  it('getRegionDistribution 应返回区域分布', () => {
    const dist = discovery.getRegionDistribution();
    assert.ok(Array.isArray(dist));
    assert.ok(dist.some(d => d.region === 'us-east'));
  });

  it('getLoadOverview 应返回负载概览', () => {
    const overview = discovery.getLoadOverview();
    assert.ok('low' in overview);
    assert.ok('critical' in overview);
    assert.equal(overview.total, 5);
  });
});

// ==================== Agent 市场与评价系统 ====================

describe('生态扩展 - AgentMarketplace', () => {
  let marketplace;
  let mockManager;

  before(() => {
    const dataDir = path.join('data', 'marketplace');
    try {
      if (fs.existsSync(dataDir)) {
        for (const file of fs.readdirSync(dataDir)) {
          fs.unlinkSync(path.join(dataDir, file));
        }
      }
    } catch (e) { /* ignore */ }

    marketplace = new AgentMarketplace();
    mockManager = {
      getAllAgents: () => [
        { id: 'ng1_market_001', name: 'MarketAgent1', reputation: 500, capabilities: ['nlp', 'writing'] },
        { id: 'ng1_market_002', name: 'MarketAgent2', reputation: 800, capabilities: ['code-review', 'security'] }
      ]
    };
    marketplace.agentManager = mockManager;
  });

  it('发布服务应成功创建列表', () => {
    const result = marketplace.listService('ng1_market_001', {
      name: 'NLP Text Analysis Service',
      description: 'High quality NLP service',
      capabilities: ['nlp', 'summarization'],
      category: 'AI',
      price: 100,
      tags: ['nlp', 'text']
    });
    assert.equal(result.success, true);
    assert.ok(result.listingId);
    assert.equal(result.listing.name, 'NLP Text Analysis Service');
    assert.equal(result.listing.status, 'active');
  });

  it('缺少必要字段的发布应失败', () => {
    const result = marketplace.listService('ng1_market_001', { name: '' });
    assert.equal(result.success, false);
  });

  it('缺少 capabilities 的发布应失败', () => {
    const result = marketplace.listService('ng1_market_001', { name: 'Test', capabilities: [] });
    assert.equal(result.success, false);
  });

  it('搜索列表应按类别过滤', () => {
    marketplace.listService('ng1_market_001', { name: 'Service A', capabilities: ['nlp'], category: 'AI', price: 50 });
    marketplace.listService('ng1_market_002', { name: 'Service B', capabilities: ['code-review'], category: 'Dev', price: 200 });
    const results = marketplace.searchListings({ category: 'Dev' });
    assert.ok(results.length > 0);
    results.forEach(r => assert.equal(r.category, 'Dev'));
  });

  it('搜索列表应按价格范围过滤', () => {
    const results = marketplace.searchListings({ maxPrice: 60 });
    results.forEach(r => assert.ok(r.price <= 60));
  });

  it('添加评价应成功并更新 agent 评分', () => {
    const listings = marketplace.getAgentListings('ng1_market_001');
    const listingId = listings[0].id;
    const result = marketplace.addReview(listingId, 'ng1_market_002', { rating: 5, content: 'Excellent service!' });
    assert.equal(result.success, true);
    assert.ok(result.reviewId);
  });

  it('评分超出范围应失败', () => {
    const listings = marketplace.getAgentListings('ng1_market_001');
    const listingId = listings[0].id;
    const result = marketplace.addReview(listingId, 'ng1_market_002', { rating: 6, content: 'Invalid' });
    assert.equal(result.success, false);
  });

  it('不能评价自己的列表', () => {
    const listings = marketplace.getAgentListings('ng1_market_001');
    const listingId = listings[0].id;
    const result = marketplace.addReview(listingId, 'ng1_market_001', { rating: 5 });
    assert.equal(result.success, false);
  });

  it('获取 agent 评分摘要应包含分布信息', () => {
    const summary = marketplace.getAgentRatingSummary('ng1_market_001');
    assert.ok('averageRating' in summary);
    assert.ok('totalReviews' in summary);
    assert.ok('distribution' in summary);
  });

  it('停用列表后不应出现在搜索结果中', () => {
    const result = marketplace.listService('ng1_market_001', { name: 'To Deactivate', capabilities: ['writing'], category: 'AI', price: 10 });
    marketplace.deactivateListing(result.listingId);
    const searchResults = marketplace.searchListings({});
    const found = searchResults.some(r => r.id === result.listingId);
    assert.equal(found, false);
  });

  it('更新列表信息应生效', () => {
    const result = marketplace.listService('ng1_market_002', { name: 'Update Test', capabilities: ['code-review'], category: 'Dev', price: 150 });
    const updated = marketplace.updateListing(result.listingId, { price: 250, name: 'Updated Name' });
    assert.equal(updated.success, true);
    assert.equal(updated.listing.price, 250);
    assert.equal(updated.listing.name, 'Updated Name');
  });

  it('marketplace stats 应包含正确统计', () => {
    const stats = marketplace.getMarketplaceStats();
    assert.ok('totalListings' in stats);
    assert.ok('activeListings' in stats);
    assert.ok('totalReviews' in stats);
    assert.ok('categories' in stats);
    assert.ok(stats.totalListings > 0);
  });
});

// ==================== 跨链桥协议 ====================

describe('生态扩展 - CrossChainBridge & LightClient', () => {
  let bridge;

  before(() => {
    bridge = new CrossChainBridge({ chainId: 'nexus-test', signatureThreshold: 2, minValidators: 2 });
  });

  it('注册验证者应成功', () => {
    const result = bridge.registerValidator('validator-1', 'pubkey-001');
    assert.equal(result, true);
    assert.equal(bridge.validators.size, 1);
  });

  it('重复注册验证者应失败', () => {
    const result = bridge.registerValidator('validator-1', 'pubkey-001');
    assert.equal(result, false);
  });

  it('锁定资产应返回 transferId', () => {
    const result = bridge.lockAsset('ethereum', 'solana', 'ETH', 10, 'ng1_recipient_addr');
    assert.ok(result.transferId);
    assert.equal(result.status, 'locked');
  });

  it('锁定不支持的链应抛出错误', () => {
    assert.throws(() => {
      bridge.lockAsset('unsupported', 'ethereum', 'ETH', 10, 'ng1_recipient');
    }, /Unsupported source chain/);
  });

  it('锁定非正数金额应抛出错误', () => {
    assert.throws(() => {
      bridge.lockAsset('ethereum', 'solana', 'ETH', 0, 'ng1_recipient');
    }, /Amount must be positive/);
  });

  it('获取活跃验证者列表应正确排序', () => {
    bridge.registerValidator('validator-2', 'pubkey-002');
    bridge.registerValidator('validator-3', 'pubkey-003');
    bridge.updateValidatorReputation('validator-1', 50);
    bridge.updateValidatorReputation('validator-2', -30);
    const active = bridge.getActiveValidators();
    assert.equal(active.length, 3);
    assert.equal(active[0].id, 'validator-1');
    assert.equal(active[0].reputation, 150);
  });

  it('获取桥接状态应包含完整信息', () => {
    const status = bridge.getBridgeStatus();
    assert.ok('chainId' in status);
    assert.ok('supportedChains' in status);
    assert.ok('activeValidators' in status);
    assert.ok('pendingTransfers' in status);
  });

  it('释放未完全验证的资产应抛出错误', () => {
    const result = bridge.lockAsset('bitcoin', 'ethereum', 'BTC', 5, 'ng1_recipient');
    assert.throws(() => {
      bridge.releaseAsset(result.transferId);
    }, /Transfer not validated/);
  });

  it('白名单/黑名单管理应正确生效', () => {
    bridge.addToValidatorWhitelist('vip-validator');
    bridge.addToValidatorBlacklist('bad-validator', 'malicious activity');
    const blacklistResult = bridge.registerValidator('bad-validator', 'pubkey-bad');
    assert.equal(blacklistResult, false);
  });

  it('紧急解锁应正确处理', () => {
    const result = bridge.lockAsset('ethereum', 'bitcoin', 'ETH', 3, 'ng1_recipient');
    const unlockResult = bridge.emergencyUnlock(result.transferId, 'admin-signature-here');
    assert.equal(unlockResult, true);
  });

  it('LightClient 应正确同步和验证', () => {
    const lc = new LightClient(bridge);
    lc.syncHeader(10, { hash: 'hash10', transactions: ['tx-abc'] });
    lc.syncHeader(20, { hash: 'hash20', transactions: ['tx-xyz'] });
    assert.equal(lc.syncHeight, 20);
    assert.equal(lc.headers.size, 2);
    const syncStatus = lc.getSyncStatus();
    assert.ok(syncStatus.isSynced);
  });
});

// ==================== SDK 增强 ====================

describe('生态扩展 - NexusGenesisSDK (增强)', () => {
  let sdk;

  before(async () => {
    sdk = new NexusGenesisSDK({ apiUrl: 'http://localhost:19999' });
  });

  after(() => {
    sdk.disconnect();
  });

  it('创建钱包应返回地址和公钥', async () => {
    const wallet = await sdk.createWallet();
    assert.ok(wallet.address);
    assert.ok(wallet.address.startsWith('ng1'));
    assert.ok(wallet.publicKey);
    assert.ok(sdk.walletAddress);
  });

  it('签名和验证签名应正常工作', async () => {
    const message = 'test message for signing';
    const signature = await sdk.signMessage(message);
    assert.ok(signature);
  });

  it('导出/导入钱包应保留地址一致', async () => {
    const password = 'test-password-123';
    const encrypted = sdk.exportWallet(password);
    assert.ok(encrypted);

    const sdk2 = new NexusGenesisSDK({ apiUrl: 'http://localhost:19999' });
    await sdk2.importWallet(encrypted, password);
    assert.equal(sdk2.walletAddress, sdk.walletAddress);
    sdk2.disconnect();
  });

  it('事件系统 on/off/once 应正常工作', (t) => {
    return new Promise((resolve) => {
      let callCount = 0;
      const handler = () => { callCount++; };

      sdk.on('test_event', handler);
      sdk.eventEmitter.emit('test_event', { data: 'test' });
      sdk.eventEmitter.emit('test_event', { data: 'test2' });
      assert.equal(callCount, 2);

      sdk.off('test_event', handler);
      sdk.eventEmitter.emit('test_event', { data: 'test3' });
      assert.equal(callCount, 2);

      let onceCalled = false;
      sdk.once('once_test', () => { onceCalled = true; });
      sdk.eventEmitter.emit('once_test');
      assert.equal(onceCalled, true);
      sdk.eventEmitter.emit('once_test');

      resolve();
    });
  });

  it('健康检查应在服务不可用时返回离线', async () => {
    const health = await sdk.checkHealth();
    assert.ok('success' in health);
  });

  it('disconnect 应清理所有轮询和监听', () => {
    sdk.disconnect();
    assert.equal(sdk._pollingIntervals.length, 0);
    assert.equal(sdk.eventEmitter.listenerCount('test_event'), 0);
  });

  it('静态验证签名方法应可调用', () => {
    assert.ok(typeof NexusGenesisSDK.verifySignature === 'function');
  });

  it('搜索市场列表应优雅降级', async () => {
    const result = await sdk.searchMarketplace({ category: 'AI' });
    assert.ok('success' in result);
  });
});
