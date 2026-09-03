import assert from 'assert';
import { test } from 'node:test';
import { State, createInitialState } from '../src/blockchain/state.js';

// 测试 Category C 资金提案的冷静期和 Observer 二次确认机制

// 场景 1：资金提案通过投票 + 冷静期within Observer 同意 → 最终 APPROVED
test('Treasury proposal should be APPROVED after cooldown with Observer approval', () => {
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  const state = createInitialState(genesisAddress, '1000');

  // 预先在 Agent Registry 中注册一个地址
  const registeredAddress = 'ng1registeredaddress12345678901234567890';
  const agentId = 'agent-1';
  
  // 注册 Agent
  state.agentRegistry.agents.set(agentId, {
    agent_id: agentId,
    address: registeredAddress,
    capabilities: [],
    metadata: '',
    registered_at_block: 1,
    reputation: 1
  });
  state.agentRegistry.addressIndex.set(registeredAddress, agentId);

  // 初始化一个 Category C 提案
  const proposalId = 'proposal-treasury-1';
  const proposalState = {
    proposal_id: proposalId,
    category: 'TREASURY_OP',
    purpose: 'Test treasury proposal',
    amount: '1000',
    beneficiary: registeredAddress,
    status: 'PENDING',
    submittedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8天前，已过期
    expirationTime: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1天前过期
    submitter: registeredAddress
  };

  // 添加提案到状态
  state.governanceState.proposals.set(proposalId, proposalState);
  state.governanceState.activeProposals.push(proposalId);

  // 初始化投票计数（YES > NO，满足通过条件）
  state.governanceState.voteCounts.set(proposalId, {
    YES: 2,
    NO: 1,
    ABSTAIN: 0
  });

  // 初始区块高度
  let currentBlockHeight = 100;

  // 第一次检查：提案过期，应该进入 COOLDOWN 状态
  state.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
  let updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.status, 'COOLDOWN');
  assert.strictEqual(updatedProposal.cooldown_end_block, currentBlockHeight + 5); // 5个区块的冷静期

  // 模拟 Observer 同意的事件
  const observerEvent = {
    tx_type: 'OBSERVER_EVENT',
    id: 'observer-event-1',
    from: 'ng1observeraddress12345678901234567890',
    payload: {
      proposal_id: proposalId,
      action_type: 'APPROVE_SPEND',
      reason: 'Approving test treasury proposal',
      observer_id: 'observer-1'
    }
  };

  // 应用 Observer 事件
  state.applyObserverEvent(observerEvent);
  updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.observer_decision.status, 'APPROVED');

  // 推进区块高度，超过冷静期结束区块
  currentBlockHeight = 106; // 100 + 6 = 106，超过 100 + 5 = 105

  // 第二次检查：冷静期结束，应该变为 APPROVED
  state.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
  updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.status, 'APPROVED');
  assert(!state.governanceState.activeProposals.includes(proposalId)); // 应该从 activeProposals 中移除
});

// 场景 2：资金提案通过投票，但 Observer 不同意 → REJECTED
test('Treasury proposal should be REJECTED after cooldown with Observer rejection', () => {
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  const state = createInitialState(genesisAddress, '1000');

  // 预先在 Agent Registry 中注册一个地址
  const registeredAddress = 'ng1registeredaddress12345678901234567890';
  const agentId = 'agent-1';
  
  // 注册 Agent
  state.agentRegistry.agents.set(agentId, {
    agent_id: agentId,
    address: registeredAddress,
    capabilities: [],
    metadata: '',
    registered_at_block: 1,
    reputation: 1
  });
  state.agentRegistry.addressIndex.set(registeredAddress, agentId);

  // 初始化一个 Category C 提案
  const proposalId = 'proposal-treasury-2';
  const proposalState = {
    proposal_id: proposalId,
    category: 'TREASURY_OP',
    purpose: 'Test treasury proposal 2',
    amount: '2000',
    beneficiary: registeredAddress,
    status: 'PENDING',
    submittedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8天前，已过期
    expirationTime: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1天前过期
    submitter: registeredAddress
  };

  // 添加提案到状态
  state.governanceState.proposals.set(proposalId, proposalState);
  state.governanceState.activeProposals.push(proposalId);

  // 初始化投票计数（YES > NO，满足通过条件）
  state.governanceState.voteCounts.set(proposalId, {
    YES: 3,
    NO: 1,
    ABSTAIN: 0
  });

  // 初始区块高度
  let currentBlockHeight = 200;

  // 第一次检查：提案过期，应该进入 COOLDOWN 状态
  state.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
  let updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.status, 'COOLDOWN');
  assert.strictEqual(updatedProposal.cooldown_end_block, currentBlockHeight + 5); // 5个区块的冷静期

  // 模拟 Observer 拒绝的事件
  const observerEvent = {
    tx_type: 'OBSERVER_EVENT',
    id: 'observer-event-2',
    from: 'ng1observeraddress12345678901234567890',
    payload: {
      proposal_id: proposalId,
      action_type: 'REJECT_SPEND',
      reason: 'Rejecting test treasury proposal',
      observer_id: 'observer-1'
    }
  };

  // 应用 Observer 事件
  state.applyObserverEvent(observerEvent);
  updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.observer_decision.status, 'REJECTED');

  // 推进区块高度，超过冷静期结束区块
  currentBlockHeight = 206; // 200 + 6 = 206，超过 200 + 5 = 205

  // 第二次检查：冷静期结束，应该变为 REJECTED
  state.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
  updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.status, 'REJECTED');
  assert(!state.governanceState.activeProposals.includes(proposalId)); // 应该从 activeProposals 中移除
});

// 场景 3：资金提案通过投票，但无 Observer 决策 → REJECTED
test('Treasury proposal should be REJECTED after cooldown with no Observer decision', () => {
  const genesisAddress = 'ng11HtQNLuTjwDg86yrgkgBo3MzZaHuGkqZrQ';
  const state = createInitialState(genesisAddress, '1000');

  // 预先在 Agent Registry 中注册一个地址
  const registeredAddress = 'ng1registeredaddress12345678901234567890';
  const agentId = 'agent-1';
  
  // 注册 Agent
  state.agentRegistry.agents.set(agentId, {
    agent_id: agentId,
    address: registeredAddress,
    capabilities: [],
    metadata: '',
    registered_at_block: 1,
    reputation: 1
  });
  state.agentRegistry.addressIndex.set(registeredAddress, agentId);

  // 初始化一个 Category C 提案
  const proposalId = 'proposal-treasury-3';
  const proposalState = {
    proposal_id: proposalId,
    category: 'TREASURY_OP',
    purpose: 'Test treasury proposal 3',
    amount: '3000',
    beneficiary: registeredAddress,
    status: 'PENDING',
    submittedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8天前，已过期
    expirationTime: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1天前过期
    submitter: registeredAddress
  };

  // 添加提案到状态
  state.governanceState.proposals.set(proposalId, proposalState);
  state.governanceState.activeProposals.push(proposalId);

  // 初始化投票计数（YES > NO，满足通过条件）
  state.governanceState.voteCounts.set(proposalId, {
    YES: 2,
    NO: 0,
    ABSTAIN: 0
  });

  // 初始区块高度
  let currentBlockHeight = 300;

  // 第一次检查：提案过期，应该进入 COOLDOWN 状态
  state.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
  let updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.status, 'COOLDOWN');
  assert.strictEqual(updatedProposal.cooldown_end_block, currentBlockHeight + 5); // 5个区块的冷静期

  // 不发送任何 Observer 事件

  // 推进区块高度，超过冷静期结束区块
  currentBlockHeight = 306; // 300 + 6 = 306，超过 300 + 5 = 305

  // 第二次检查：冷静期结束，应该变为 REJECTED（无 Observer 决策）
  state.checkAndUpdateProposalStatus(proposalId, currentBlockHeight);
  updatedProposal = state.governanceState.proposals.get(proposalId);
  assert.strictEqual(updatedProposal.status, 'REJECTED');
  assert(!state.governanceState.activeProposals.includes(proposalId)); // 应该从 activeProposals 中移除
});
