/**
 * AGENT_REGISTER Transaction Tests
 */

import assert from 'assert';
import { test } from 'node:test';
import {
  createAgentRegisterTransaction,
  validateAgentRegisterTransaction,
  isAddressRegistered,
  getAgentInfo,
  getAgentIdByAddress,
  listAllAgents
} from '../src/transactions/agentRegister.js';
import { State } from '../src/blockchain/state.js';
import { generateAddress } from '../src/wallet/addressUtils.js';

const TEST_ADDRESS = generateAddress('agent-register-test-public-key');

test('Test 1: Create AGENT_REGISTER transaction', () => {
  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'test-agent-1',
    capabilities: ['coding', 'testing'],
    metadata: 'Test agent'
  });

  assert.strictEqual(tx.type, 'AGENT_REGISTER');
  assert.strictEqual(tx.from, TEST_ADDRESS);
  assert.strictEqual(tx.payload.agent_identity, 'test-agent-1');
  assert.deepStrictEqual(tx.payload.capabilities, ['coding', 'testing']);
  assert.ok(tx.id, 'Should have transaction ID');
  assert.ok(tx.timestamp, 'Should have timestamp');

  console.log('✅ Transaction creation works');
});

test('Test 2: Validate valid transaction', () => {
  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'valid-agent',
    capabilities: ['coding']
  });

  const result = validateAgentRegisterTransaction(tx);
  assert.strictEqual(result.valid, true, 'Should be valid');

  console.log('✅ Valid transaction passes validation');
});

test('Test 3: Validate missing agent_identity', () => {
  // Create transaction manually to bypass validation in create function
  const tx = {
    id: 'test-id',
    type: 'AGENT_REGISTER',
    from: TEST_ADDRESS,
    payload: {
      capabilities: ['coding']
      // agent_identity missing
    },
    timestamp: Date.now(),
    nonce: 1
  };

  const result = validateAgentRegisterTransaction(tx);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('agent_identity'));

  console.log('✅ Missing agent_identity rejected');
});

test('Test 4: Validate invalid address format', () => {
  const tx = createAgentRegisterTransaction('invalid-address', {
    agent_identity: 'test-agent'
  });

  const result = validateAgentRegisterTransaction(tx);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('address'));

  console.log('✅ Invalid address rejected');
});

test('Test 5: Validate invalid agent_identity', () => {
  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'invalid identity with spaces!'
  });

  const result = validateAgentRegisterTransaction(tx);
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('agent_identity'));

  console.log('✅ Invalid agent_identity rejected');
});

test('Test 6: Apply transaction to state', () => {
  const state = new State(TEST_ADDRESS);

  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'state-test-agent',
    capabilities: ['coding', 'review'],
    metadata: 'Test metadata'
  });

  const result = state.applyAgentRegister(tx, 1);

  assert.strictEqual(result, true, 'Should apply successfully');
  assert.strictEqual(state.agentRegistry.agents.has(tx.id), true);

  const agent = state.agentRegistry.agents.get(tx.id);
  assert.strictEqual(agent.agent_id, tx.id);
  assert.strictEqual(agent.address, TEST_ADDRESS);
  assert.deepStrictEqual(agent.capabilities, ['coding', 'review']);
  assert.strictEqual(agent.reputation, 1);
  assert.strictEqual(agent.registered_at_block, 1);

  console.log('✅ Transaction applied to state');
});

test('Test 7: Prevent duplicate registration', () => {
  const state = new State(TEST_ADDRESS);

  const tx1 = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'duplicate-agent'
  });

  const tx2 = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'duplicate-agent-2'
  });

  // First registration should succeed
  const result1 = state.applyAgentRegister(tx1, 1);
  assert.strictEqual(result1, true);

  // Second registration from same address should fail
  const result2 = state.applyAgentRegister(tx2, 2);
  assert.strictEqual(result2, false);

  console.log('✅ Duplicate registration prevented');
});

test('Test 8: Address registration check', () => {
  const state = new State(TEST_ADDRESS);

  assert.strictEqual(isAddressRegistered(TEST_ADDRESS, state), false);

  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'check-agent'
  });

  state.applyAgentRegister(tx, 1);

  assert.strictEqual(isAddressRegistered(TEST_ADDRESS, state), true);

  console.log('✅ Address registration check works');
});

test('Test 9: Get agent by ID', () => {
  const state = new State(TEST_ADDRESS);

  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'get-agent',
    capabilities: ['testing']
  });

  state.applyAgentRegister(tx, 1);

  const agent = getAgentInfo(tx.id, state);
  assert.ok(agent, 'Should find agent');
  assert.strictEqual(agent.agent_id, tx.id);

  const notFound = getAgentInfo('non-existent', state);
  assert.strictEqual(notFound, null);

  console.log('✅ Get agent by ID works');
});

test('Test 10: Get agent by address', () => {
  const state = new State(TEST_ADDRESS);

  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'by-address-agent'
  });

  state.applyAgentRegister(tx, 1);

  const agentId = getAgentIdByAddress(TEST_ADDRESS, state);
  assert.strictEqual(agentId, tx.id);

  const notFound = getAgentIdByAddress('unknown', state);
  assert.strictEqual(notFound, null);

  console.log('✅ Get agent by address works');
});

test('Test 11: List all agents', () => {
  const state = new State(TEST_ADDRESS);

  // Register multiple agents
  for (let i = 0; i < 3; i++) {
    const address = `ng1agent${i}000000000000000000000000000000000000`;
    const tx = createAgentRegisterTransaction(address, {
      agent_identity: `list-agent-${i}`
    });
    state.applyAgentRegister(tx, i + 1);
  }

  const agents = listAllAgents(state);
  assert.strictEqual(agents.length, 3);

  console.log('✅ List all agents works');
});

test('Test 12: Transaction with signature', async () => {
  const crypto = await import('crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'signed-agent'
  }, privateKey);

  assert.ok(tx.signature, 'Should have signature');

  console.log('✅ Transaction with signature works');
});

console.log('\n=== AGENT_REGISTER Tests ===');
