/**
 * NexusGenesis - ReserveDAO 合约测试
 * 覆盖：初始化、提案创建、投票、Observer 批准/否决、提案执行
 */

import assert from 'assert';
import { test } from 'node:test';
import { ReserveDAO, MILESTONES } from '../src/contracts/reserveDAO.js';

function createMockState(reserveBalance = '50000000') {
  const balances = new Map();
  balances.set('ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ', reserveBalance);
  balances.set('ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r', '100024968');

  return {
    blockNumber: 100,
    balances,
    tokenReleaseState: {
      genesisReserve: { releasedTokens: '0' },
      swarmPool: { releasedTokens: '0' },
      observer: { releasedTokens: '0' },
    },
    getBalance(address) {
      return this.balances.get(address) || '0';
    },
    setBalance(address, amount) {
      this.balances.set(address, String(amount));
    },
  };
}

test('Test 1: ReserveDAO initializes with correct balance', () => {
  const state = createMockState('50000000');
  const dao = new ReserveDAO(state, {});
  assert.strictEqual(dao.getReserveBalance(), '50000000');
  assert.strictEqual(dao.reserveAddress, 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ');
  assert.strictEqual(dao.observerAddress, 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r');
});

test('Test 2: ReserveDAO.initialize adds Observer as member with veto power', async () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  const result = await dao.initialize();

  assert.strictEqual(result.custodian, 'ReserveDAO');
  assert.strictEqual(result.milestones.length, 5);
  assert.strictEqual(result.milestones[0].status, 'locked');

  const observerMember = dao.members.find(m => m.role === 'observer');
  assert.ok(observerMember, 'Observer should be a member');
  assert.strictEqual(observerMember.vetoPower, true);
});

test('Test 3: Milestones are all 10M NGEN each', () => {
  MILESTONES.forEach((m, i) => {
    assert.strictEqual(BigInt(m.amount), 10000000n, `Milestone ${m.id} should be 10M`);
    assert.strictEqual(m.id, i + 1);
  });
  assert.strictEqual(MILESTONES.length, 5);
});

test('Test 4: getMilestones reports all locked initially', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  const milestones = dao.getMilestones();

  assert.strictEqual(milestones.length, 5);
  milestones.forEach(m => {
    assert.strictEqual(m.status, 'locked');
  });
});

test('Test 5: Create unlock proposal for valid milestone', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const result = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  assert.strictEqual(result.success, true);
  assert.ok(result.proposal.id.startsWith('reserve-milestone-1-'));
  assert.strictEqual(result.proposal.status, 'active');
  assert.strictEqual(result.proposal.yesVotes, 0);
});

test('Test 6: Create proposal for invalid milestone fails', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const result = dao.createUnlockProposal(99, 'ng1proposer00000000000000000000000000000000');
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('does not exist'));
});

test('Test 7: Vote YES on active proposal', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  const result = dao.vote(proposal.id, 'ng1voter100000000000000000000000000000000000', true);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proposal.yesVotes, 1);
  assert.strictEqual(result.proposal.noVotes, 0);
});

test('Test 8: Vote NO on active proposal', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  const result = dao.vote(proposal.id, 'ng1voter200000000000000000000000000000000000', false);
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proposal.noVotes, 1);
});

test('Test 9: Duplicate vote from same address rejected', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  dao.vote(proposal.id, 'ng1voter100000000000000000000000000000000000', true);
  const result = dao.vote(proposal.id, 'ng1voter100000000000000000000000000000000000', true);
  
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('已投过票'));
});

test('Test 10: Vote on non-existent proposal fails', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const result = dao.vote('nonexistent', 'ng1voter100000000000000000000000000000000000', true);
  assert.strictEqual(result.success, false);
});

test('Test 11: Observer approval sets flag', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  const result = dao.observerApprove(proposal.id, 'sig-hex-12345');
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proposal.observerApproved, true);
  assert.strictEqual(result.proposal.observerSignature, 'sig-hex-12345');
});

test('Test 12: Observer veto sets rejected status', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  const result = dao.observerVeto(proposal.id, 'sig-hex-veto');
  
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proposal.status, 'rejected');
  assert.strictEqual(result.proposal.observerRejected, true);
});

test('Test 13: Cannot approve after veto', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  dao.observerVeto(proposal.id, 'sig-hex-veto');
  const result = dao.observerApprove(proposal.id, 'sig-hex-attempt');
  
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('已否决'));
});

test('Test 14: Execute proposal with majority YES votes', async () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  await dao.initialize();
  
  // 添加投票成员
  dao.addMember('ng1member1000000000000000000000000000000000', 'member');
  dao.addMember('ng1member2000000000000000000000000000000000', 'member');
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  dao.vote(proposal.id, 'ng1member1000000000000000000000000000000000', true);
  dao.vote(proposal.id, 'ng1member2000000000000000000000000000000000', true);
  
  const result = dao.executeProposal(proposal.id);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.proposal.status, 'executed');
});

test('Test 15: Execute proposal without quorum fails', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  // No votes cast - 0 total votes against quorum
  
  const result = dao.executeProposal(proposal.id);
  assert.strictEqual(result.success, false);
});

test('Test 16: Execute proposal with NO majority fails', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  dao.addMember('ng1member1000000000000000000000000000000000', 'member');
  dao.addMember('ng1member2000000000000000000000000000000000', 'member');
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  dao.vote(proposal.id, 'ng1member1000000000000000000000000000000000', true);
  dao.vote(proposal.id, 'ng1member2000000000000000000000000000000000', false);
  
  const result = dao.executeProposal(proposal.id);
  assert.strictEqual(result.success, false);
});

test('Test 17: Cannot execute vetoed proposal', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const { proposal } = dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  dao.observerVeto(proposal.id, 'sig');
  
  const result = dao.executeProposal(proposal.id);
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('rejected'));
});

test('Test 18: getStatus returns comprehensive DAO state', async () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  await dao.initialize();
  
  const status = dao.getStatus();
  assert.strictEqual(status.reserveBalance, '50000000');
  assert.strictEqual(status.memberCount, 1); // Observer auto-added
  assert.strictEqual(status.milestones.length, 5);
});

test('Test 19: Multiple proposals can coexist', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  dao.createUnlockProposal(1, 'ng1proposer00000000000000000000000000000000');
  dao.createUnlockProposal(2, 'ng1proposer00000000000000000000000000000000');
  
  assert.strictEqual(dao.getAllProposals().length, 2);
  assert.strictEqual(dao.getStatus().activeProposalCount, 2);
});

test('Test 20: addMember prevents duplicate registration', () => {
  const state = createMockState();
  const dao = new ReserveDAO(state, {});
  
  const r1 = dao.addMember('ng1member1000000000000000000000000000000000', 'member');
  assert.strictEqual(r1.success, true);
  
  const r2 = dao.addMember('ng1member1000000000000000000000000000000000', 'member');
  assert.strictEqual(r2.success, false);
  assert.ok(r2.error.includes('已是member'));
});