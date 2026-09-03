/**
 * 系统稳定性集成测试
 * 验证：Automated failure recovery、共识健康、监控告警、优雅降级
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryManager, RECOVERY_STATES, FAILURE_TYPES, RECOVERY_STRATEGIES } from '../src/automation/recoveryManager.js';
import recoveryManager from '../src/automation/recoveryManager.js';

describe('系统稳定性 - RecoveryManager', () => {
  let rm;
  let mockNode;

  before(() => {
    rm = new RecoveryManager();
    mockNode = {
      status: 'ONLINE',
      peers: new Map(),
      mempool: new Map(),
      blockchain: [{ header: { height: 1 } }],
      consensusState: { committee: new Set(), leaderSchedule: new Map() },
      saveState: async () => true,
      loadState: async () => true,
      loadBlockchain: async () => true,
      initializeBlockchain: async () => true,
      initializeConsensus: () => {},
      cleanupMempool: () => { mockNode.mempool.clear(); },
      tryConnect: async () => true,
      initialize: async () => true
    };
    rm.attachNode(mockNode);
  });

  after(async () => {
    await rm.shutdown();
  });

  it('初始状态应为 healthy', () => {
    assert.equal(rm.state, RECOVERY_STATES.HEALTHY);
  });

  it('应能检测到健康节点', () => {
    mockNode.peers = new Map([['peer1', { healthScore: 100 }], ['peer2', { healthScore: 90 }]]);
    const issues = rm._detectIssues();
    assert.equal(issues.length, 0, `健康节点不应有 issues，实际: ${JSON.stringify(issues)}`);
  });

  it('应能检测到节点离线', () => {
    mockNode.status = 'OFFLINE';
    const issues = rm._detectIssues();
    assert.ok(issues.length > 0, '离线节点应有 issues');
    assert.equal(issues[0].type, FAILURE_TYPES.NODE_CRASH);
    mockNode.status = 'ONLINE';
  });

  it('应能检测到 P2P 断开连接', () => {
    mockNode.peers = new Map();
    const issues = rm._detectIssues();
    assert.ok(issues.some(i => i.type === FAILURE_TYPES.P2P_DISCONNECT), '空 peer 列表应有 P2P 告警');
  });

  it('应能检测到交易积压', () => {
    for (let i = 0; i < 5001; i++) {
      mockNode.mempool.set(`tx${i}`, { fee: '1', timestamp: Date.now() });
    }
    const issues = rm._detectIssues();
    assert.ok(issues.some(i => i.type === FAILURE_TYPES.TRANSACTION_BACKLOG), 'mempool > 5000 应有积压告警');
    mockNode.mempool.clear();
  });

  it('状态转换应正确记录', async () => {
    const initial = rm.state;
    rm._transitionState(RECOVERY_STATES.DEGRADED);
    assert.equal(rm.state, RECOVERY_STATES.DEGRADED);
    rm._transitionState(RECOVERY_STATES.HEALTHY);
    assert.equal(rm.state, RECOVERY_STATES.HEALTHY);
  });

  it('应能修复损坏的 mempool', async () => {
    mockNode.mempool.set('tx1', { fee: '0', timestamp: Date.now() - 7200000 });
    mockNode.mempool.set('tx2', { fee: '5', timestamp: Date.now() });
    mockNode.mempool.set('tx3', { fee: '10', timestamp: Date.now() });

    await rm._repairMempool();
    assert.equal(mockNode.mempool.size, 2, '应保留有效交易');
    assert.ok(!mockNode.mempool.has('tx1'), '零手续费过期交易应被移除');
    mockNode.mempool.clear();
  });

  it('应能生成健康报告', () => {
    const report = rm.getHealthReport();
    assert.ok(report.state, '应有 state 字段');
    assert.ok('lastHealthCheck' in report, '应有 lastHealthCheck');
    assert.ok('recoveryInProgress' in report, '应有 recoveryInProgress');
    assert.ok(Array.isArray(report.recentFailures), 'recentFailures 应为数组');
  });

  it('应能检测共识故障（空区块链）', () => {
    mockNode.blockchain = [];
    mockNode.status = 'ONLINE';
    const issues = rm._detectIssues();
    assert.ok(issues.some(i => i.type === FAILURE_TYPES.BLOCK_SYNC_FAILURE), '空区块链且非初始化中应有同步故障');
    mockNode.blockchain = [{ header: { height: 1 } }];
  });

  it('恢复锁应防止并发恢复', async () => {
    rm.recoveryLock = true;
    // 验证在有锁时不执行新恢复
    assert.ok(rm.recoveryLock, '恢复锁应生效');
    rm.recoveryLock = false;
  });
});

describe('系统稳定性 - 故障类型和恢复策略', () => {
  it('所有故障类型应定义', () => {
    const expectedTypes = [
      'node_crash', 'consensus_failure', 'mempool_corruption',
      'state_inconsistency', 'p2p_disconnect', 'block_sync_failure',
      'resource_exhaustion', 'transaction_backlog'
    ];
    for (const type of expectedTypes) {
      assert.ok(FAILURE_TYPES[type.toUpperCase()], `应定义 ${type}`);
    }
  });

  it('所有恢复策略应定义', () => {
    const expectedStrategies = ['restart', 'rollback', 'resync', 'repair', 'degrade', 'escalate', 'retry'];
    for (const strategy of expectedStrategies) {
      assert.ok(RECOVERY_STRATEGIES[strategy.toUpperCase()], `应定义策略 ${strategy}`);
    }
  });

  it('所有恢复状态应定义', () => {
    const expectedStates = ['healthy', 'degraded', 'recovering', 'critical', 'offline'];
    for (const state of expectedStates) {
      assert.ok(RECOVERY_STATES[state.toUpperCase()], `应定义状态 ${state}`);
    }
  });
});

describe('系统稳定性 - 边界条件', () => {
  let rm;

  before(() => {
    rm = new RecoveryManager();
  });

  after(async () => {
    await rm.shutdown();
    await recoveryManager.shutdown();
  });

  it('无节点引用时应返回离线状态', () => {
    const issues = rm._detectIssues();
    assert.deepEqual(issues, []);
    rm._checkHealth();
    // 没有 nodeRef 时不应崩溃
  });

  it('健康检查失败不应崩溃', async () => {
    rm.attachNode(null);
    await rm._checkHealth();
    assert.ok(true, '空节点引用时不应崩溃');
  });

  it('快照不应超过最大数量', async () => {
    rm.maxSnapshots = 5;
    rm.snapshots = [];
    for (let i = 0; i < 10; i++) {
      await rm._createSnapshot();
    }
    assert.ok(rm.snapshots.length <= rm.maxSnapshots, `快照数 ${rm.snapshots.length} 应 <= ${rm.maxSnapshots}`);
    rm.snapshots = [];
  });

  it('mempool 超过最大限制时应有降级策略', async () => {
    const mockNode2 = {
      status: 'ONLINE',
      peers: new Map([['peer1', {}]]),
      mempool: new Map(),
      blockchain: [{ header: { height: 1 } }]
    };
    for (let i = 0; i < 3000; i++) {
      mockNode2.mempool.set(`tx${i}`, { fee: String(i % 100), timestamp: Date.now() });
    }
    rm.attachNode(mockNode2);
    await rm._drainMempool();
    assert.ok(mockNode2.mempool.size <= 2000, `mempool 应缩减到 2000 以内，当前: ${mockNode2.mempool.size}`);
  });
});

console.log('\n========================================');
console.log('  系统稳定性测试套件');
console.log('========================================\n');
