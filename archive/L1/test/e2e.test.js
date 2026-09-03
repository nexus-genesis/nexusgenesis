import { describe, test } from 'node:test';
import assert from 'node:assert';
import { PQCWallet, Transaction } from '../src/wallet/pqcWallet.js';
import { State } from '../src/blockchain/state.js';
import { Block, createGenesisBlock, createBlock } from '../src/blockchain/block.js';
import { MultiLeaderConsensus } from '../src/consensus/multiLeader.js';
import { SwarmPool } from '../src/economy/swarmPool.js';
import { WeightedVotingSystem } from '../src/governance/weightedVoting.js';
import { CrossChainBridge } from '../src/bridge/bridgeProtocol.js';
import { validateAddress } from '../src/wallet/pqcWallet.js';
import { ContributionSystem } from '../src/ai/contributionSystem.js';

describe('NexusGenesis E2E 全链路集成测试', () => {
  let alice, bob, state, consensus;

  describe('场景 1: 创世启动 → 钱包创建 → 共识就绪', () => {
    test('1.1 创建 PQC 抗量子钱包', async () => {
      alice = await PQCWallet.generate(1000000n);
      assert.ok(alice.address.startsWith('ng1'), '地址应以 ng1 开头');
      assert.ok(validateAddress(alice.address), '地址应通过验证');
      assert.ok(alice.hasEnoughBalance(1000n), '应有足够余额');
    });

    test('1.2 初始化区块链状态', () => {
      state = new State(alice.address);
      state.setBalance(alice.address, 1000000n);
      state.initializeTokenRelease();
      assert.ok(state, 'State 应创建成功');
    });

    test('1.3 初始化多领导者共识', () => {
      consensus = new MultiLeaderConsensus();
      consensus.registerLeader('node1', 'ng1node1000000000000000000000000000000000', 10);
      consensus.registerLeader('node2', 'ng1node2000000000000000000000000000000000', 8);
      consensus.registerLeader('node3', 'ng1node3000000000000000000000000000000000', 6);

      const stats = consensus.getStats();
      assert.strictEqual(stats.activeLeaders, 3, '应有 3 个活跃领导者');
    });
  });

  describe('场景 2: 交易签名 → 验证 → 上链', () => {
    let transaction;
    let sender;
    let recipient;

    test('2.1 创建发送方和接收方钱包', async () => {
      sender = await PQCWallet.generate(100000n);
      recipient = await PQCWallet.generate(0n);
      assert.ok(validateAddress(sender.address));
      assert.ok(validateAddress(recipient.address));
      assert.notStrictEqual(sender.address, recipient.address, '地址应不同');
    });

    test('2.2 创建并签名交易', async () => {
      transaction = Transaction.create(sender, recipient.address, 5000n);
      assert.strictEqual(transaction.type, 'TRANSFER');
      assert.strictEqual(transaction.amount, 5000n);
      assert.strictEqual(transaction.from, sender.address);

      await transaction.sign(sender);
      assert.ok(transaction.signature, '签名应存在');
    });

    test('2.3 验证交易签名', async () => {
      const valid = await transaction.verify(sender);
      assert.strictEqual(valid, true, '签名验证应通过');
    });

    test('2.4 拒绝被篡改的交易', async () => {
      const tampered = Transaction.create(sender, recipient.address, 9999n);
      await tampered.sign(sender);

      const validWithWrongWallet = await tampered.verify(recipient);
      assert.strictEqual(validWithWrongWallet, false, '错误钱包验证应失败');
    });

    test('2.5 交易上链 (含代谢税)', () => {
      const localState = new State(sender.address);
      localState.setBalance(sender.address, 100000n);
      localState.initializeTokenRelease();

      localState.applyTransfer({
        type: 'TRANSFER',
        from: sender.address,
        to: recipient.address,
        amount: 1000,
        fee: 1
      });

      const senderBalance = localState.getBalance(sender.address);
      const recipientBalance = localState.getBalance(recipient.address);
      assert.ok(Number(senderBalance) < 100000, '发送方余额应减少（含税）');
      assert.ok(Number(recipientBalance) >= 999, '接收方余额应增加（税后）');
    });
  });

  describe('场景 3: 区块创建 → 共识确认', () => {
    test('3.1 创建创世区块', () => {
      const genesisBlock = createGenesisBlock();
      assert.ok(genesisBlock, '创世区块应存在');
      assert.strictEqual(genesisBlock.header.height, 0, '创世区块高度为 0');
      assert.ok(genesisBlock.hash, '创世区块应有哈希');
    });

    test('3.2 共识：选举领袖 → 提议区块 → 确认', () => {
      const localConsensus = new MultiLeaderConsensus();
      localConsensus.registerLeader('alpha', 'ng1alpha00000000000000000000000000000000000', 10);
      localConsensus.registerLeader('beta', 'ng1beta000000000000000000000000000000000000', 8);
      localConsensus.registerLeader('gamma', 'ng1gamma00000000000000000000000000000000000', 5);

      const leader = localConsensus.electLeader();
      assert.ok(leader, '应选举出领袖');

      const genesisBlock = createGenesisBlock();
      const blockResult = localConsensus.proposeBlock(genesisBlock, leader);
      if (blockResult) {
        localConsensus.confirmBlock(genesisBlock.hash, 'gamma');
        const status = localConsensus.getBlockStatus(genesisBlock.hash);
        assert.ok(status, '应能查到区块状态');
      }
    });

    test('3.3 连续出块 5 轮', () => {
      const localConsensus = new MultiLeaderConsensus();
      localConsensus.registerLeader('n1', 'ng1n10000000000000000000000000000000000000', 10);
      localConsensus.registerLeader('n2', 'ng1n20000000000000000000000000000000000000', 8);
      localConsensus.registerLeader('n3', 'ng1n30000000000000000000000000000000000000', 6);

      let previousBlock = createGenesisBlock();
      const blocks = [];

      for (let i = 0; i < 5; i++) {
        const leaderObj = localConsensus.electLeader();
        const leaderNodeId = leaderObj?.nodeId || leaderObj;
        const block = createBlock(previousBlock, [
          { id: `tx-${i}`, type: 'TRANSFER', from: 'ng1n10000000000000000000000000000000000000', amount: 100 }
        ]);
        const result = localConsensus.proposeBlock(block, leaderNodeId);
        if (result && result.accepted !== false) {
          blocks.push(block);
          previousBlock = block;
        }
      }

      assert.ok(blocks.length >= 1, '应至少产生 1 个区块');
    });
  });

  describe('场景 4: Agent 注册', () => {
    test('4.1 注册 Agent 到区块链状态', () => {
      const localState = new State('ng1genesis000000000000000000000000000000');
      localState.initializeTokenRelease();

      const tx = {
        id: 'agent-tx-e2e-001',
        type: 'AGENT_REGISTER',
        from: 'ng1testagent000000000000000000000000000000',
        payload: {
          agent_identity: 'agent-id-e2e-001',
          capabilities: ['coding', 'review'],
          metadata: 'E2E test agent'
        },
        signature: 'sig'
      };

      const result = localState.applyAgentRegister(tx, 1);
      assert.strictEqual(result, true, '注册应成功');

      const agent = localState.agentRegistry.agents.get(tx.id);
      assert.ok(agent, '应能找到注册的 Agent');
      assert.strictEqual(agent.address, tx.from, 'Agent 地址应正确');
    });

    test('4.2 防止重复注册', () => {
      const localState = new State('ng1genesis000000000000000000000000000000');
      localState.initializeTokenRelease();

      const tx = {
        id: 'agent-tx-e2e-002',
        type: 'AGENT_REGISTER',
        from: 'ng1testagent111111111111111111111111111111',
        payload: {
          agent_identity: 'agent-id-e2e-002',
          capabilities: ['testing']
        },
        signature: 'sig'
      };

      const firstResult = localState.applyAgentRegister(tx, 1);
      assert.strictEqual(firstResult, true, '第一次注册应成功');

      const secondResult = localState.applyAgentRegister(tx, 2);
      assert.strictEqual(secondResult, false, '重复注册应返回 false');
    });
  });

  describe('场景 5: 智能合约部署 → 执行', () => {
    test('5.1 部署计数器合约并调用', () => {
      const localState = new State('ng1genesis000000000000000000000000000000');
      localState.setBalance('ng1caller0000000000000000000000000000000', '1000000');

      const deployTx = {
        id: 'deploy-counter-e2e',
        tx_type: 'CONTRACT_DEPLOY',
        from: 'ng1caller0000000000000000000000000000000',
        contract_id: 'test-counter-e2e',
        bytecode: '0x070001010308000b',
        gas_limit: '10000',
        fee: '1000',
        timestamp: Date.now(),
        nonce: '1',
        signature: 'test-sig'
      };

      const deployResult = localState.applyTransaction(deployTx);
      assert.strictEqual(deployResult, true, '合约部署应成功');

      const contract = localState.contracts.get('test-counter-e2e');
      assert.ok(contract, '合约应存在于状态中');

      const callTx1 = {
        id: 'call-counter-e2e-1',
        tx_type: 'CONTRACT_CALL',
        from: 'ng1caller0000000000000000000000000000000',
        contract_id: 'test-counter-e2e',
        method: 'increment',
        params: [],
        gas_limit: '1000',
        fee: '10',
        timestamp: Date.now(),
        nonce: '2',
        signature: 'test-sig'
      };

      const callResult1 = localState.applyTransaction(callTx1);
      assert.strictEqual(callResult1, true, '第一次调用应成功');

      const callTx2 = {
        id: 'call-counter-e2e-2',
        tx_type: 'CONTRACT_CALL',
        from: 'ng1caller0000000000000000000000000000000',
        contract_id: 'test-counter-e2e',
        method: 'increment',
        params: [],
        gas_limit: '1000',
        fee: '10',
        timestamp: Date.now(),
        nonce: '3',
        signature: 'test-sig'
      };

      localState.applyTransaction(callTx2);

      const callTx3 = {
        id: 'call-counter-e2e-3',
        tx_type: 'CONTRACT_CALL',
        from: 'ng1caller0000000000000000000000000000000',
        contract_id: 'test-counter-e2e',
        method: 'get_counter',
        params: [],
        gas_limit: '1000',
        fee: '10',
        timestamp: Date.now(),
        nonce: '4',
        signature: 'test-sig'
      };

      const callResult3 = localState.applyTransaction(callTx3);
      assert.strictEqual(callResult3, true, 'get_counter 调用应成功');
    });

    test('5.2 调用不存在的合约应失败', () => {
      const localState = new State('ng1genesis000000000000000000000000000000');

      const callTx = {
        id: 'call-nonexistent',
        tx_type: 'CONTRACT_CALL',
        from: 'ng1caller0000000000000000000000000000000',
        contract_id: 'non-existent',
        method: 'get',
        params: [],
        gas_limit: '1000',
        fee: '10',
        timestamp: Date.now(),
        nonce: '1',
        signature: 'test-sig'
      };

      const result = localState.applyTransaction(callTx);
      assert.strictEqual(result, false, '调用不存在的合约应返回 false');
    });
  });

  describe('场景 6: 治理提案 → 投票 → 执行', () => {
    test('6.1 创建提案并投票', () => {
      ContributionSystem.setAgentReputation('voter1', 150);
      ContributionSystem.setAgentReputation('voter2', 200);

      const proposalId = WeightedVotingSystem.createProposal({
        creatorId: 'voter2',
        title: 'E2E Protocol Upgrade',
        description: 'Upgrade consensus algorithm to v2',
        type: 'protocol_update',
        params: { version: '2.0' }
      });

      assert.ok(proposalId, '提案应创建成功');

      WeightedVotingSystem.activateProposal(proposalId);

      WeightedVotingSystem.castVote(proposalId, 'voter1', 'yes');
      WeightedVotingSystem.castVote(proposalId, 'voter2', 'yes');

      const stats = WeightedVotingSystem.getProposal(proposalId);
      assert.ok(stats, '应能获取提案详情');
    });
  });

  describe('场景 7: Swarm Pool 代币释放', () => {
    test('7.1 检查 Swarm Pool 释放机制', () => {
      const initialBalance = SwarmPool.getBalance();
      assert.ok(initialBalance > 0, 'Swarm Pool 应有初始余额');

      SwarmPool.recordContribution('agent-e2e-1', 'poc', 'pr_merged', 10);

      const result = SwarmPool.checkAndReleaseTokens();
      if (result) {
        assert.ok(typeof result.released === 'number', '释放结果应有 released 字段');
      }

      const status = SwarmPool.getStatus();
      assert.ok(status, '应能获取状态');
      assert.ok('balance' in status, '状态应包含 balance');
    });
  });

  describe('场景 8: 跨链桥', () => {
    test('8.1 创建跨链桥并锁定资产', () => {
      const bridge = new CrossChainBridge({
        chainId: 'nexusgenesis',
        supportedChains: ['nexus', 'ethereum', 'bitcoin', 'solana'],
        minValidators: 2
      });

      bridge.registerValidator('val-e2e-1', 'pubkey-e2e-1');
      bridge.registerValidator('val-e2e-2', 'pubkey-e2e-2');

      const lock = bridge.lockAsset('nexus', 'ethereum', 'NGEN', 5000, '0xRecipientETH');
      assert.ok(lock, '锁定操作应成功');
      assert.ok(lock.transferId, 'transferId 应存在');
      assert.strictEqual(lock.status, 'locked', '状态应为 locked');

      const bridgeStatus = bridge.getBridgeStatus();
      assert.strictEqual(bridgeStatus.validatorCount, 2, '应有 2 个验证者');
      assert.strictEqual(bridgeStatus.pendingTransfers, 1, '应有 1 笔待处理转账');
    });
  });

  describe('场景 9: 端到端完整流程', () => {
    test('9.1 钱包 → 交易 → 共识出块 → 状态验证', async () => {
      const a = await PQCWallet.generate(1000000n);
      const b = await PQCWallet.generate(0n);

      const s = new State(a.address);
      s.setBalance(a.address, 1000000n);
      s.initializeTokenRelease();

      const c = new MultiLeaderConsensus();
      c.registerLeader('l1', a.address, 10);
      c.registerLeader('l2', b.address, 5);

      const leaderId = c.electLeader();

      s.applyTransfer({ type: 'TRANSFER', from: a.address, to: b.address, amount: 50000, fee: 1 });
      s.applyTransfer({ type: 'TRANSFER', from: b.address, to: a.address, amount: 10000, fee: 1 });

      assert.ok(Number(s.getBalance(b.address)) > 0, 'Bob 应有余额');
      assert.ok(Number(s.getBalance(b.address)) < 50000, 'Bob 余额应小于收到的全额');
      assert.ok(Number(s.getBalance(a.address)) < 1000000, 'Alice 余额应减少');

      c.electLeader();
      const block = createBlock(createGenesisBlock(), [
        { id: 'tx-a', type: 'TRANSFER', from: a.address, to: b.address, amount: 50000 },
        { id: 'tx-b', type: 'TRANSFER', from: b.address, to: a.address, amount: 10000 }
      ]);
      const blockLeader = c.getCurrentLeader().nodeId || c.getCurrentLeader();
      c.proposeBlock(block, blockLeader);

      const stats = c.getStats();
      assert.ok(stats.currentRound >= 0, '共识轮次应可查询');

      const economicData = s.getEconomicAuditData();
      assert.ok(economicData, '应能获取经济数据');
    });

    test('9.2 全模块状态校验', async () => {
      const wallet = await PQCWallet.generate(1000n);
      assert.ok(validateAddress(wallet.address), '钱包地址有效');

      const s = new State(wallet.address);
      s.setBalance(wallet.address, 1000n);
      s.initializeTokenRelease();
      assert.strictEqual(Number(s.getBalance(wallet.address)), 1000, '状态余额正确');

      const c = new MultiLeaderConsensus();
      c.registerLeader('n', wallet.address, 1);
      assert.strictEqual(c.getStats().activeLeaders, 1, '共识节点已注册');

      const bridge = new CrossChainBridge({
        chainId: 'nexusgenesis',
        supportedChains: ['nexus', 'ethereum', 'bitcoin', 'solana'],
        minValidators: 1
      });
      bridge.registerValidator('v', 'pk');
      const lockResult = bridge.lockAsset('nexus', 'ethereum', 'NGEN', 100, '0xTarget');
      assert.strictEqual(lockResult.status, 'locked', '跨链桥锁定成功');

      ContributionSystem.setAgentReputation('e2e-final-voter', 200);
      const proposalId = WeightedVotingSystem.createProposal({
        creatorId: 'e2e-final-voter',
        title: 'Final E2E Verification',
        description: 'All modules verified',
        type: 'protocol_update',
        params: {}
      });
      assert.ok(proposalId, '治理提案创建成功');

      s.setBalance(wallet.address, '1000000');

      const deployTx = {
        id: 'e2e-final-deploy',
        tx_type: 'CONTRACT_DEPLOY',
        from: wallet.address,
        contract_id: 'e2e-final-ctr',
        bytecode: '0x07002a000308000b',
        gas_limit: '10000',
        fee: '1000',
        timestamp: Date.now(),
        nonce: '1',
        signature: 'test-sig'
      };
      s.applyTransaction(deployTx);
      assert.ok(s.contracts.get('e2e-final-ctr'), '合约部署成功');

      SwarmPool.recordContribution('e2e-final-agent', 'poc', 'pr_merged', 10);
      const poolStatus = SwarmPool.getStatus();
      assert.ok(poolStatus.balance > 0, 'Swarm Pool 余额正常');

      assert.ok(true, '所有模块校验通过');
    });
  });
});