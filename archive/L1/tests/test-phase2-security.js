/**
 * Phase 2 Security Revision Test Suite
 * 
 * Tests the new custody model:
 * 1. Agent registration with 24h binding window
 * 2. BIND_MASTER_KEY transaction
 * 3. AGENT_TAKEOVER transaction (with cooldown)
 * 4. Binding window expiry → self-sovereign
 * 5. Permission model enforcement
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { State, createInitialState, expireBindingWindows, AGENT_CUSTODY_STATUS } from '../src/blockchain/state.js';
import {
  createAgentRegisterTransaction,
  AGENT_CUSTODY_STATUS as REGISTER_CUSTODY
} from '../src/transactions/agentRegister.js';
import {
  createBindMasterKeyTransaction,
  validateBindMasterKey,
  createAgentTakeoverTransaction,
  validateAgentTakeover
} from '../src/transactions/agentUpdate.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function createMockNode(state) {
  const blockchain = [];
  return {
    currentState: state,
    blockchain,
    submitOnChainTransaction: async (tx, opts) => {
      const applied = state.applyTransaction(tx, state.blockchain.length);
      if (applied) blockchain.push(tx);
      return { success: true, applied, blockHeight: state.blockchain.length };
    }
  };
}

// ─── Test 1: Agent registration sets PENDING_BINDING ──────────────────

test('Agent registration creates agent with PENDING_BINDING custody', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  const tx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'test-agent',
    capabilities: ['coding'],
    public_key: '02' + 'aa'.repeat(32) // mock PQC public key
  });

  const applied = state.applyTransaction(tx, 1);
  assert.strictEqual(applied, true, 'Registration should succeed');

  // Find the agent by address index
  const agentId = state.agentRegistry.addressIndex.get('ng1test0000000000000000000000000000000');
  const agent = state.agentRegistry.agents.get(agentId);
  
  assert.strictEqual(agent.custody, AGENT_CUSTODY_STATUS.PENDING_BINDING);
  assert.ok(agent.binding_deadline > Date.now(), 'Binding deadline should be in the future');
  assert.ok(agent.registered_at, 'Should have registration timestamp');
  assert.ok(agent.master_key_fingerprint === null, 'No Master Key bound yet');
});

// ─── Test 2: BIND_MASTER_KEY within window ────────────────────────────

test('BIND_MASTER_KEY succeeds within 24h window', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  // Register agent
  const regTx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'test-agent',
    capabilities: ['coding'],
    public_key: '02' + 'bb'.repeat(32)
  });
  state.applyTransaction(regTx, 1);

  // Get agent ID (it's the tx id)
  const agentId = regTx.id;
  
  // Create BIND_MASTER_KEY transaction
  const mkTx = createBindMasterKeyTransaction(
    agentId,
    'mk_fingerprint_abc123',
    '01'.repeat(32) // mock master key
  );

  const applied = state.applyTransaction(mkTx, 2);
  assert.strictEqual(applied, true, 'Bind Master Key should succeed');

  const updated = state.agentRegistry.agents.get(agentId);
  assert.strictEqual(updated.custody, AGENT_CUSTODY_STATUS.CO_MANAGED);
  assert.strictEqual(updated.master_key_fingerprint, 'mk_fingerprint_abc123');
});

// ─── Test 3: BIND_MASTER_KEY after window expires ─────────────────────

test('BIND_MASTER_KEY fails after 24h window expires', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  // Register agent
  const regTx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'test-agent',
    capabilities: ['coding'],
    public_key: '02' + 'cc'.repeat(32)
  });
  state.applyTransaction(regTx, 1);

  const agentId = regTx.id;
  const agent = state.agentRegistry.agents.get(agentId);
  
  // Manually set deadline to the past (simulate 25h elapsed)
  agent.binding_deadline = Date.now() - 3600000; // 1 hour ago
  state.agentRegistry.agents.set(agentId, agent);

  // Create BIND_MASTER_KEY transaction
  const mkTx = createBindMasterKeyTransaction(
    agentId,
    'mk_fingerprint_xyz',
    '01'.repeat(32)
  );

  const applied = state.applyTransaction(mkTx, 2);
  assert.strictEqual(applied, false, 'Bind should fail after window expired');
  
  const updated = state.agentRegistry.agents.get(agentId);
  assert.strictEqual(updated.custody, AGENT_CUSTODY_STATUS.SELF_SOVEREIGN, 'Should auto-expire to self-sovereign');
});

// ─── Test 4: AGENT_TAKEOVER with cooldown ─────────────────────────────

test('AGENT_TAKEOVER succeeds with cooldown enforcement', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  // Register and bind Master Key
  const regTx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'test-agent',
    capabilities: ['coding'],
    public_key: '02' + 'dd'.repeat(32)
  });
  state.applyTransaction(regTx, 1);

  const agentId = regTx.id;
  
  const mkTx = createBindMasterKeyTransaction(agentId, 'mk_fingerprint_123', '01'.repeat(32));
  state.applyTransaction(mkTx, 2);

  // Takeover: replace operation key
  const takeoverTx = createAgentTakeoverTransaction(
    agentId,
    '03' + 'ee'.repeat(32), // new public key
    '01'.repeat(32) // master key
  );

  const applied = state.applyTransaction(takeoverTx, 3);
  assert.strictEqual(applied, true, 'Takeover should succeed');

  const updated = state.agentRegistry.agents.get(agentId);
  assert.strictEqual(updated.public_key, '03' + 'ee'.repeat(32), 'Public key updated');
  assert.ok(updated.takeover_cooldown_until > Date.now(), 'Cooldown set');
});

// ─── Test 5: AGENT_TAKEOVER blocked by cooldown ──────────────────────

test('AGENT_TAKEOVER blocked by 10-minute cooldown', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  const regTx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'cooldown-agent',
    capabilities: ['coding'],
    public_key: '02' + 'ff'.repeat(32)
  });
  state.applyTransaction(regTx, 1);

  const agentId = regTx.id;
  const mkTx = createBindMasterKeyTransaction(agentId, 'mk_fingerprint_cc', '01'.repeat(32));
  state.applyTransaction(mkTx, 2);

  // First takeover
  const t1 = createAgentTakeoverTransaction(agentId, '02' + 'aa'.repeat(32), '01'.repeat(32));
  state.applyTransaction(t1, 3);

  // Second takeover immediately after — should fail
  const t2 = createAgentTakeoverTransaction(agentId, '02' + 'bb'.repeat(32), '01'.repeat(32));
  const applied = state.applyTransaction(t2, 4);
  assert.strictEqual(applied, false, 'Second takeover should be blocked by cooldown');
});

// ─── Test 6: Self-sovereign agent cannot be taken over ───────────────

test('Self-sovereign agents cannot be taken over', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  const regTx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'sovereign-agent',
    capabilities: ['coding'],
    public_key: '02' + '11'.repeat(32)
  });
  state.applyTransaction(regTx, 1);

  const agentId = regTx.id;
  const agent = state.agentRegistry.agents.get(agentId);
  
  // Simulate 25h elapsed → auto-expire
  agent.binding_deadline = Date.now() - 3600000;
  state.agentRegistry.agents.set(agentId, agent);

  // Try takeover on self-sovereign agent
  const takeoverTx = createAgentTakeoverTransaction(agentId, '02' + '22'.repeat(32), '01'.repeat(32));
  const applied = state.applyTransaction(takeoverTx, 2);
  assert.strictEqual(applied, false, 'Takeover should fail on self-sovereign agent');
});

// ─── Test 7: expireBindingWindows auto-transition ─────────────────────

test('expireBindingWindows transitions expired agents to self-sovereign', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  // Register 3 agents
  for (let i = 0; i < 3; i++) {
    const tx = createAgentRegisterTransaction(`ng1test${i}000000000000000000000000000000`, {
      agent_identity: `agent-${i}`,
      capabilities: ['coding'],
      public_key: '02' + ('0' + i).repeat(32)
    });
    state.applyTransaction(tx, i + 1);
  }

  // Expire 2 agents (set deadline in past)
  for (const [agentId, record] of state.agentRegistry.agents.entries()) {
    if (record.identity !== 'agent-2') {
      record.binding_deadline = Date.now() - 3600000;
      state.agentRegistry.agents.set(agentId, record);
    }
  }

  const result = expireBindingWindows(state);
  
  assert.strictEqual(result.expired.length, 2, '2 agents should expire');
  
  for (const [agentId, record] of state.agentRegistry.agents.entries()) {
    if (record.identity === 'agent-2') {
      assert.strictEqual(record.custody, AGENT_CUSTODY_STATUS.PENDING_BINDING, 'agent-2 should still be pending');
    } else {
      assert.strictEqual(record.custody, AGENT_CUSTODY_STATUS.SELF_SOVEREIGN, `${record.identity} should be self-sovereign`);
    }
  }
});

// ─── Test 8: Transaction validation ───────────────────────────────────

test('BIND_MASTER_KEY and AGENT_TAKEOVER validation', () => {
  // Valid BIND_MASTER_KEY
  const mkTx = createBindMasterKeyTransaction('agent-1', 'mk_fp_123', '01'.repeat(32));
  const mkValidation = validateBindMasterKey(mkTx);
  assert.strictEqual(mkValidation.valid, true);

  // Invalid: missing fingerprint
  const badMkTx = { tx_type: 'BIND_MASTER_KEY', payload: { agentId: 'agent-1' } };
  assert.strictEqual(validateBindMasterKey(badMkTx).valid, false);

  // Valid AGENT_TAKEOVER
  const tTx = createAgentTakeoverTransaction('agent-1', '02' + 'aa'.repeat(32), '01'.repeat(32));
  const tValidation = validateAgentTakeover(tTx);
  assert.strictEqual(tValidation.valid, true);

  // Invalid: wrong type
  assert.strictEqual(validateAgentTakeover({ tx_type: 'TRANSFER' }).valid, false);
});

// ─── Test 9: Custody constants are consistent ─────────────────────────

test('Custody status constants match across modules', () => {
  assert.deepStrictEqual(
    Object.keys(REGISTER_CUSTODY),
    Object.keys(AGENT_CUSTODY_STATUS),
    'Custody constants should match across modules'
  );
});

// ─── Test 10: Registration processing includes binding deadline ───────

test('Registration processing adds binding deadline automatically', () => {
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  
  const tx = createAgentRegisterTransaction('ng1test0000000000000000000000000000000', {
    agent_identity: 'deadline-agent',
    capabilities: ['coding'],
    public_key: '02' + '33'.repeat(32)
  });

  state.applyTransaction(tx, 1);
  const agentId = state.agentRegistry.addressIndex.get('ng1test0000000000000000000000000000000');
  const agent = state.agentRegistry.agents.get(agentId);

  assert.ok(agent.registered_at, 'Should have registered_at');
  assert.ok(agent.binding_deadline, 'Should have binding_deadline');
  assert.ok(agent.binding_deadline > agent.registered_at + 23 * 3600 * 1000, 'Deadline should be ~24h after registration');
});

console.log('\n🧪 Phase 2 Security Revision Test Suite\n');
console.log('------------------------------------------------------------\n');
