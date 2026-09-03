/**
 * Swarm Pool Activation Tests
 */

import assert from 'assert';
import { test } from 'node:test';
import { State } from '../src/blockchain/state.js';
import { SwarmPoolActivated, SWARM_POOL_CONFIG } from '../src/economy/swarmPoolActivated.js';
import { ContributionSystem } from '../src/ai/contributionSystem.js';

const GENESIS_ADDRESS = 'ng1genesis000000000000000000000000000000000';

test('Test 1: Swarm Pool activation', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  const result = pool.activate(GENESIS_ADDRESS);
  
  assert.strictEqual(result, true, 'Activation should succeed');
  assert.strictEqual(pool.isActive, true, 'Pool should be active');
  
  const status = pool.getStatus();
  assert.strictEqual(status.totalTokens, '850000000', 'Total should be 850M');
  assert.strictEqual(status.releasedTokens, '0', 'Initially no tokens released');
  
  console.log('✅ Swarm Pool activation works');
});

test('Test 2: Token release at interval', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  const released = pool.checkAndRelease(100);
  assert.ok(released > 0n, 'Should release tokens');
  
  const status = pool.getStatus();
  assert.strictEqual(status.lastReleaseBlock, 100, 'Last release should be block 100');
  
  console.log(`✅ Token release works: ${released} NGEN released`);
});

test('Test 3: No release before interval', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  pool.checkAndRelease(100);
  const released = pool.checkAndRelease(150); // Only 50 blocks later
  
  assert.strictEqual(released, 0n, 'Should not release before interval');
  console.log('✅ No premature release');
});

test('Test 4: Contribution-based distribution', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  // Register agents and record contributions
  const agents = [
    { id: 'agent-1', pr: 10, code: 1000, bugs: 5 },
    { id: 'agent-2', pr: 5, code: 500, bugs: 2 },
    { id: 'agent-3', pr: 15, code: 1500, bugs: 8 }
  ];
  
  for (const agent of agents) {
    state.applyAgentRegister({
      agent_id: agent.id,
      from: agent.id,
      capabilities: ['coding']
    }, 1);
    
    ContributionSystem.recordContribution(agent.id, 'poc', 'pr_merged', agent.pr);
    ContributionSystem.recordContribution(agent.id, 'poc', 'code_added', agent.code);
    ContributionSystem.recordContribution(agent.id, 'poc', 'bug_fixed', agent.bugs);
  }
  
  // Release and distribute
  pool.checkAndRelease(100);
  const transactions = pool.executeDistribution();
  
  assert.ok(transactions.length >= 3, 'Should distribute to all agents');
  
  // Verify highest contributor gets most
  const balances = agents.map(a => BigInt(state.getBalance(a.id)));
  assert.ok(balances[2] > balances[0], 'Agent-3 should get more than Agent-1');
  assert.ok(balances[0] > balances[1], 'Agent-1 should get more than Agent-2');
  
  console.log('✅ Contribution-based distribution works');
});

test('Test 5: Burn and reserve rates', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  // Setup agents
  for (let i = 0; i < 5; i++) {
    const id = `agent-${i}`;
    state.applyAgentRegister({ agent_id: id, from: id, capabilities: ['test'] }, 1);
    ContributionSystem.recordContribution(id, 'poc', 'pr_merged', 10);
  }
  
  pool.checkAndRelease(100);
  const transactions = pool.executeDistribution();
  
  // Calculate total distributed
  const totalDistributed = transactions.reduce((sum, tx) => sum + BigInt(tx.amount), 0n);
  
  // Total distributed should be ~70% of released (after 10% burn + 20% reserve)
  const released = BigInt(pool.getStatus().releasedTokens);
  const expectedMax = released * 70n / 100n;
  
  assert.ok(totalDistributed <= expectedMax, 'Distributed should be <= 70% of released');
  console.log(`✅ Burn/Reserve working: distributed ${totalDistributed} of ${released}`);
});

test('Test 6: Distribution history tracking', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  // Setup and release twice
  for (let i = 0; i < 5; i++) {
    const id = `agent-${i}`;
    state.applyAgentRegister({ agent_id: id, from: id, capabilities: ['test'] }, 1);
    ContributionSystem.recordContribution(id, 'poc', 'pr_merged', 10);
  }
  
  pool.checkAndRelease(100);
  pool.executeDistribution();
  
  // Need to re-add contributions for second round
  for (let i = 0; i < 5; i++) {
    const id = `agent-${i}`;
    ContributionSystem.recordContribution(id, 'poc', 'pr_merged', 10);
  }
  
  pool.checkAndRelease(200);
  pool.executeDistribution();
  
  const history = pool.getDistributionHistory();
  assert.strictEqual(history.length, 2, 'Should have 2 distribution records');
  
  console.log('✅ Distribution history tracking works');
});

test('Test 7: Manual release', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  for (let i = 0; i < 5; i++) {
    const id = `agent-${i}`;
    state.applyAgentRegister({ agent_id: id, from: id, capabilities: ['test'] }, 1);
    ContributionSystem.recordContribution(id, 'poc', 'pr_merged', 10);
  }
  
  const result = pool.manualRelease(100);
  
  assert.ok(result.released, 'Should release tokens');
  assert.ok(result.transactions.length > 0, 'Should have transactions');
  assert.strictEqual(result.blockHeight, 100, 'Block height should match');
  
  console.log('✅ Manual release works');
});

test('Test 8: Release progress calculation', () => {
  const state = new State(GENESIS_ADDRESS);
  state.balances.set(GENESIS_ADDRESS, '1000000000');
  
  const pool = new SwarmPoolActivated(state);
  pool.activate(GENESIS_ADDRESS);
  
  // Release multiple times
  for (let block = 100; block <= 1000; block += 100) {
    pool.checkAndRelease(block);
  }
  
  const status = pool.getStatus();
  assert.ok(parseFloat(status.releaseProgress) > 0, 'Progress should be > 0');
  assert.ok(parseFloat(status.releaseProgress) < 1, 'Progress should be < 1%');
  
  console.log(`✅ Release progress: ${status.releaseProgress}`);
});

console.log('\n=== Swarm Pool Tests ===');
