/**
 * Multi-Leader Consensus Tests
 */

import assert from 'assert';
import { test } from 'node:test';
import { MultiLeaderConsensus } from '../src/consensus/multiLeader.js';

/**
 * testnet/consensusNode.js is not present in this repository, so this file
 * failed to load at all and took its ten tests with it, including the five that
 * only need MultiLeaderConsensus.
 *
 * The import is optional rather than removed: nothing here can reconstruct
 * ConsensusTestnet, and guessing at its behaviour would be worse than not
 * running these four. Restore the module and they run again with no further
 * change.
 */
let ConsensusTestnet = null;
try {
  ({ ConsensusTestnet } = await import('../testnet/consensusNode.js'));
} catch {
  // Left null; the four tests that need it are skipped below.
}
const needsTestnet = ConsensusTestnet
  ? {}
  : { skip: 'requires testnet/consensusNode.js, which is not in the repository' };

import { createAgentRegisterTransaction } from '../src/transactions/agentRegister.js';

test('Test 1: Leader registration', () => {
  const consensus = new MultiLeaderConsensus();
  
  consensus.registerLeader('node1', 'ng1node100000000000000000000000000000000000', 10);
  
  assert.strictEqual(consensus.leaders.size, 1);
  assert.ok(consensus.leaders.has('node1'));
  
  const leader = consensus.leaders.get('node1');
  assert.strictEqual(leader.reputation, 10);
  assert.strictEqual(leader.isActive, true);
  
  console.log('✅ Leader registration works');
});

test('Test 2: Leader election', () => {
  const consensus = new MultiLeaderConsensus();
  
  consensus.registerLeader('node1', 'ng1node100000000000000000000000000000000000', 10);
  consensus.registerLeader('node2', 'ng1node200000000000000000000000000000000000', 5);
  
  const leader = consensus.electLeader();
  
  assert.ok(leader, 'Should elect a leader');
  assert.ok(['node1', 'node2'].includes(leader.nodeId), 'Should elect one of the registered nodes');
  assert.strictEqual(consensus.currentRound, 1);
  
  console.log(`✅ Leader election works: ${leader.nodeId} elected`);
});

test('Test 3: Block proposal and confirmation', () => {
  const consensus = new MultiLeaderConsensus();
  
  consensus.registerLeader('node1', 'ng1node100000000000000000000000000000000000', 10);
  consensus.registerLeader('node2', 'ng1node200000000000000000000000000000000000', 5);
  consensus.registerLeader('node3', 'ng1node300000000000000000000000000000000000', 5);
  
  const leader = consensus.electLeader();
  
  const block = {
    hash: 'abc123',
    height: 1,
    transactions: []
  };
  
  const proposed = consensus.proposeBlock(block, leader.nodeId);
  assert.strictEqual(proposed, true, 'Leader should be able to propose');
  
  // Other nodes confirm
  const otherNodes = ['node1', 'node2', 'node3'].filter(n => n !== leader.nodeId);
  let confirmed = false;
  
  for (const nodeId of otherNodes) {
    confirmed = consensus.confirmBlock(block.hash, nodeId);
    if (confirmed) break;
  }
  
  assert.strictEqual(confirmed, true, 'Block should be confirmed');
  
  const status = consensus.getBlockStatus(block.hash);
  assert.strictEqual(status.status, 'FINALIZED');
  
  console.log('✅ Block proposal and confirmation works');
});

test('Test 4: Non-leader cannot propose', () => {
  const consensus = new MultiLeaderConsensus();
  
  consensus.registerLeader('node1', 'ng1node100000000000000000000000000000000000', 10);
  consensus.registerLeader('node2', 'ng1node200000000000000000000000000000000000', 5);
  
  // Elect leader multiple times to ensure we know who it is
  consensus.forceRotateLeader();
  const currentLeader = consensus.roundLeader.nodeId;
  
  const block = {
    hash: 'def456',
    height: 1,
    transactions: []
  };
  
  // Try to propose from the non-leader
  const nonLeader = currentLeader === 'node1' ? 'node2' : 'node1';
  const proposed = consensus.proposeBlock(block, nonLeader);
  assert.strictEqual(proposed, false, 'Non-leader should not be able to propose');
  
  console.log(`✅ Non-leader (${nonLeader}) proposal rejected`);
});

test('Test 5: Consensus statistics', () => {
  const consensus = new MultiLeaderConsensus();
  
  consensus.registerLeader('node1', 'ng1node100000000000000000000000000000000000', 10);
  consensus.registerLeader('node2', 'ng1node200000000000000000000000000000000000', 5);
  
  const stats = consensus.getStats();
  
  assert.strictEqual(stats.totalLeaders, 2);
  assert.strictEqual(stats.activeLeaders, 2);
  assert.strictEqual(stats.finalizedBlocks, 0);
  
  console.log('✅ Consensus statistics works');
});

test('Test 6: Full testnet consensus', needsTestnet, () => {
  const testnet = new ConsensusTestnet();
  
  // Create 4 nodes
  testnet.createNode('alpha', 8);
  testnet.createNode('beta', 6);
  testnet.createNode('gamma', 5);
  testnet.createNode('delta', 3);
  
  // Connect all nodes
  testnet.connectAllNodes();
  
  // Run 5 rounds
  const blocks = [];
  for (let i = 0; i < 5; i++) {
    testnet.sharedConsensus.forceRotateLeader();
    const block = testnet.runConsensusRound([]);
    if (block) blocks.push(block);
  }
  
  assert.ok(blocks.length > 0, 'Should produce blocks');
  
  // Check all nodes are synced
  const status = testnet.getNetworkStatus();
  assert.strictEqual(status.allSynced, true, 'All nodes should be synced');
  
  console.log(`✅ Full testnet consensus: ${blocks.length} blocks produced, all nodes synced`);
});

test('Test 7: Transaction processing in consensus', needsTestnet, () => {
  const testnet = new ConsensusTestnet();
  
  testnet.createNode('alpha', 8);
  testnet.createNode('beta', 6);
  testnet.connectAllNodes();
  
  // Create a transaction with tx_type for state.applyTransaction
  const tx = createAgentRegisterTransaction('ng1test000000000000000000000000000000000000', {
    agent_identity: 'consensus-test-agent',
    capabilities: ['testing']
  });
  
  // Add tx_type for state.applyTransaction compatibility
  tx.tx_type = 'AGENT_REGISTER';
  
  // Run round with transaction
  testnet.sharedConsensus.forceRotateLeader();
  const block = testnet.runConsensusRound([tx]);
  
  assert.ok(block, 'Should produce block');
  assert.strictEqual(block.transactions.length, 1, 'Block should contain transaction');
  
  // Check transaction was applied to the proposing node
  const leaderNode = testnet.nodes.get(block.validator);
  assert.ok(leaderNode, 'Leader node should exist');
  
  const agentId = leaderNode.state.agentRegistry.addressIndex.get('ng1test000000000000000000000000000000000000');
  assert.ok(agentId, 'Transaction should be applied to leader state');
  
  console.log('✅ Transaction processing in consensus works');
});

test('Test 8: Leader rotation', () => {
  const consensus = new MultiLeaderConsensus();
  
  consensus.registerLeader('node1', 'ng1node100000000000000000000000000000000000', 10, 0);
  consensus.registerLeader('node2', 'ng1node200000000000000000000000000000000000', 10, 100);
  consensus.registerLeader('node3', 'ng1node300000000000000000000000000000000000', 10, 200);
  
  const leaders = new Set();
  
  // Elect 10 times and collect leaders
  for (let i = 0; i < 10; i++) {
    consensus.forceRotateLeader();
    leaders.add(consensus.roundLeader.nodeId);
  }
  
  // Should have multiple different leaders
  assert.ok(leaders.size >= 2, 'Should have multiple leaders elected');
  
  console.log(`✅ Leader rotation works: ${leaders.size} unique leaders in 10 rounds`);
});

test('Test 9: Block validation', needsTestnet, () => {
  const testnet = new ConsensusTestnet();
  
  testnet.createNode('alpha', 8);
  testnet.createNode('beta', 6);
  testnet.connectAllNodes();
  
  // Produce first block
  testnet.sharedConsensus.forceRotateLeader();
  const block1 = testnet.runConsensusRound([]);
  
  assert.ok(block1, 'First block should be produced');
  
  // Try to produce block with wrong height
  const alphaNode = testnet.nodes.get('alpha');
  const invalidBlock = {
    height: 999, // Wrong height
    timestamp: Date.now(),
    previousHash: block1.hash,
    transactions: [],
    validator: 'alpha',
    hash: 'invalid-hash'
  };
  
  const valid = alphaNode.validateBlock(invalidBlock);
  assert.strictEqual(valid, false, 'Invalid block should be rejected');
  
  console.log('✅ Block validation works');
});

test('Test 10: Network status reporting', needsTestnet, () => {
  const testnet = new ConsensusTestnet();
  
  testnet.createNode('alpha', 8);
  testnet.createNode('beta', 6);
  testnet.createNode('gamma', 5);
  testnet.connectAllNodes();
  
  // Run a few rounds
  for (let i = 0; i < 3; i++) {
    testnet.sharedConsensus.forceRotateLeader();
    testnet.runConsensusRound([]);
  }
  
  const status = testnet.getNetworkStatus();
  
  assert.strictEqual(status.totalNodes, 3);
  assert.strictEqual(status.allSynced, true);
  assert.ok(status.averageBlockHeight > 0);
  assert.strictEqual(status.nodes.length, 3);
  
  console.log(`✅ Network status reporting works: ${status.averageBlockHeight} avg height`);
});

console.log('\n=== Multi-Leader Consensus Tests ===');
