/**
 * Phase 2 测试网验证测试
 * 验证：代币水龙头、Agent Swarm 模拟器、经济模型
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { TokenFaucet } from '../src/faucet/tokenFaucet.js';
import tokenFaucet from '../src/faucet/tokenFaucet.js';
import { AgentSwarmSimulator } from '../src/agent/agentSwarmSimulator.js';
import agentDiscoveryService from '../src/agent/agentDiscoveryService.js';

// ==================== 代币水龙头 ====================

describe('Phase 2 - TokenFaucet', () => {
  let faucet;

  before(() => {
    const dataDir = path.join('data', 'faucet');
    try {
      if (fs.existsSync(dataDir)) {
        for (const file of fs.readdirSync(dataDir)) {
          fs.unlinkSync(path.join(dataDir, file));
        }
      }
    } catch (e) { /* ignore */ }

    faucet = new TokenFaucet({
      DEFAULT_DISTRIBUTION: 500n,
      COOLDOWN_PER_ADDRESS: 1000,
      COOLDOWN_PER_IP: 500,
      DAILY_CAP: 50000n,
      MAX_REQUESTS_PER_WINDOW: 3,
      MAX_DISTRIBUTION: 5000n
    });
  });

  it('基本领取应返回钱包和代币', async () => {
    const result = await faucet.drip('test-ip-1');
    assert.equal(result.success, true);
    assert.ok(result.distribution);
    assert.ok(result.distribution.address.startsWith('ng1'));
    assert.equal(result.distribution.amount, 500);
    assert.ok(result.wallet.encryptedWallet);
  });

  it('指定金额领取应生效', async () => {
    const result = await faucet.drip('test-ip-2', 1000);
    assert.equal(result.success, true);
    assert.equal(result.distribution.amount, 1000);
  });

  it('超过最大领取额度应拒绝', async () => {
    const result = await faucet.drip('test-ip-overdrip', 10000);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('Maximum'));
  });

  it('低于最小领取额度应拒绝', async () => {
    const result = await faucet.drip('test-ip-min', 50);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('Minimum'));
  });

  it('IP 冷却期内再次请求应拒绝', async () => {
    await faucet.drip('test-ip-cooldown-1');
    const result = await faucet.drip('test-ip-cooldown-1');
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('cooldown'));
  });

  it('应能通过 distribution ID 查询', async () => {
    const dripResult = await faucet.drip('test-ip-lookup');
    const dist = faucet.getDistribution(dripResult.distribution.id);
    assert.ok(dist);
    assert.equal(dist.id, dripResult.distribution.id);
  });

  it('查询不存在的 distribution 应返回 null', () => {
    const dist = faucet.getDistribution('nonexistent-id');
    assert.equal(dist, null);
  });

  it('检查地址资格应返回完整信息', () => {
    const eligibility = faucet.checkEligibility('ng1test000000000000000000000000000000000');
    assert.ok('eligible' in eligibility);
    assert.ok('dailyRemaining' in eligibility);
    assert.ok('addressCooldownRemainingMs' in eligibility);
  });

  it('获取统计信息应包含各项指标', () => {
    const stats = faucet.getStats();
    assert.ok('totalDistributed' in stats);
    assert.ok('totalClaims' in stats);
    assert.ok('dailyDistributed' in stats);
    assert.ok('dailyCap' in stats);
    assert.ok('dailyRemaining' in stats);
  });

  it('屏蔽/解除屏蔽地址应生效', () => {
    const badAddr = 'ng1bad000000000000000000000000000000000';
    const result = faucet.blockAddress(badAddr, 'spam');
    assert.equal(result.success, true);
    assert.ok(faucet.blockedAddresses.has(badAddr));

    const unblockResult = faucet.unblockAddress(badAddr);
    assert.equal(unblockResult.success, true);
    assert.equal(faucet.blockedAddresses.has(badAddr), false);
  });

  it('速率限制应生效', async () => {
    faucet.ipRateCounters.delete('test-ip-ratelimit');
    for (let i = 0; i < 3; i++) {
      await faucet.drip('test-ip-ratelimit');
    }
    const result = await faucet.drip('test-ip-ratelimit');
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('Rate limited'));
  });
});

// ==================== Agent Swarm 模拟器 ====================

describe('Phase 2 - AgentSwarmSimulator', () => {
  let simulator;

  after(() => {
    if (simulator) simulator.shutdown();
    agentDiscoveryService.shutdown();
  });

  it('初始化应创建指定数量的 Agent', () => {
    simulator = new AgentSwarmSimulator({
      agentCount: 10,
      simulationRounds: 5,
      taskPerRound: 3,
      enableMarketplace: true,
      enableFaucet: true,
      logLevel: 'error'
    });
    simulator.initialize();

    assert.equal(simulator.agents.length, 10);
    simulator.agents.forEach(agent => {
      assert.ok(agent.id);
      assert.ok(agent.capabilities.length > 0);
      assert.ok(agent.model);
      assert.ok(agent.metadata.region);
    });
  });

  it('Agent 注册应将 Agent 标记为已注册', async () => {
    await simulator.registerAgents();
    const registered = simulator.agents.filter(a => a.registered);
    assert.ok(registered.length > 0);
  });

  it('市场列表应创建成功', async () => {
    await simulator.createMarketplaceListings();
    const totalListings = simulator.agents.reduce((sum, a) => sum + a.listings.length, 0);
    assert.ok(totalListings > 0);
  });

  it('任务生成应创建符合模板的任务', () => {
    const tasks = simulator.generateTasks();
    assert.ok(tasks.length > 0);
    tasks.forEach(task => {
      assert.ok(task.id);
      assert.ok(task.requiredCapabilities.length > 0);
      assert.equal(task.status, 'pending');
    });
  });

  it('任务匹配应在 Agent 中找到候选', async () => {
    const tasks = simulator.generateTasks();
    const assigned = await simulator.matchAndAssignTasks(tasks);
    const assignedTasks = assigned.filter(t => t.status === 'assigned');
    assert.ok(assignedTasks.length > 0);
  });

  it('任务执行应完成部分任务', async () => {
    const tasks = simulator.generateTasks();
    await simulator.matchAndAssignTasks(tasks);
    const { completed, failed, taxed } = await simulator.executeTasks();
    assert.ok(completed >= 0);
    assert.ok(taxed >= 0);
  });

  it('完整模拟运行应生成有效报告', async () => {
    const sim2 = new AgentSwarmSimulator({
      agentCount: 8,
      simulationRounds: 5,
      taskPerRound: 3,
      enableMarketplace: true,
      enableFaucet: true,
      logLevel: 'error'
    });
    const report = await sim2.run();

    assert.ok(report.summary);
    assert.ok(report.economic);
    assert.ok(report.reputation);
    assert.ok(report.performance);
    assert.ok(report.validation);

    assert.ok(report.summary.registeredAgents > 0);
    assert.ok(report.economic.taskCompletionRate >= 0);
    assert.ok(typeof report.validation.taskCompletionOk === 'boolean');

    sim2.shutdown();
  });

  it('经济指标应在合理范围内', async () => {
    const sim3 = new AgentSwarmSimulator({
      agentCount: 5,
      simulationRounds: 10,
      taskPerRound: 3,
      enableMarketplace: true,
      enableFaucet: true,
      logLevel: 'error'
    });
    const report = await sim3.run();

    assert.ok(report.economic.totalTokensEarned >= 0);
    assert.ok(report.economic.totalTaxCollected >= 0);
    assert.ok(report.economic.averageReputationGrowth >= 0);
    assert.ok(report.reputation.distribution.new >= 0);

    sim3.shutdown();
  });

  it('getAgents / getTasks / getRounds 应返回数据', async () => {
    const sim4 = new AgentSwarmSimulator({
      agentCount: 5,
      simulationRounds: 3,
      taskPerRound: 2,
      enableFaucet: true,
      logLevel: 'error'
    });
    await sim4.run();

    const agents = sim4.getAgents();
    const tasks = sim4.getTasks();
    const rounds = sim4.getRounds();

    assert.ok(agents.length === 5);
    assert.ok(tasks.length > 0);
    assert.ok(rounds.length === 3);

    sim4.shutdown();
  });
});
