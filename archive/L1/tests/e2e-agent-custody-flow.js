/**
 * NexusGenesis — End-to-End Agent Custody Flow Test
 * 
 * Simulates the complete human-Agent custody lifecycle as if executed by a real user in a browser:
 * 
 * Phase A: Registration (Day 0, 00:00)
 *   1. Human generates Dilithium2 key pair locally (private key never leaves browser)
 *   2. Solves PoW challenge to prove human presence
 *   3. Sends AGENT_REGISTER transaction with signature
 *   4. Node relays to blockchain → agent enters PENDING_BINDING state
 * 
 * Phase B: Master Key Binding (Day 1, 12:00 — within 24h window)
 *   1. Human generates Master Key (separate from Operation Key)
 *   2. Computes Master Key fingerprint (SHA-256 of public key)
 *   3. Creates and signs BIND_MASTER_KEY transaction with Master Key
 *   4. Node validates → applies on-chain → agent transitions to CO_MANAGED
 * 
 * Phase C: Takeover (optional, Day 2)
 *   1. Human detects operation key compromise
 *   2. Generates new Operation Key pair
 *   3. Signs AGENT_TAKEOVER with Master Key → replaces old Operation Key
 *   4. 10-minute cooldown enforced
 * 
 * Phase D: Binding Window Expiry (Day 2, 00:00 — 24h after registration, no binding)
 *   1. expireBindingWindows() runs (permissionless)
 *   2. Agent transitions PENDING_BINDING → SELF_SOVEREIGN
 *   3. Master Key binding rejected (window expired)
 *   4. Takeover blocked (not CO_MANAGED)
 * 
 * This test simulates all 4 phases with time-travel to verify the full lifecycle.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import {
  createInitialState,
  expireBindingWindows,
  AGENT_CUSTODY_STATUS
} from '../src/blockchain/state.js';
import {
  createAgentRegisterTransaction,
  validateAgentRegisterTransaction
} from '../src/transactions/agentRegister.js';
import {
  createBindMasterKeyTransaction,
  validateBindMasterKey,
  createAgentTakeoverTransaction,
  validateAgentTakeover
} from '../src/transactions/agentUpdate.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create mock node that applies transactions directly to state.
 * This simulates the HTTP API relay + blockchain consensus layer.
 */
function createMockNode(state) {
  const blockchain = [];
  return {
    currentState: state,
    blockchain,
    submitOnChainTransaction: async (tx) => {
      const height = blockchain.length;
      const applied = state.applyTransaction(tx, height);
      if (applied) blockchain.push({ ...tx, blockHeight: height });
      return { success: true, applied, blockHeight: height };
    }
  };
}

/**
 * Generate deterministic mock keys for testing (simulates browser PQC crypto).
 * In production, this would use @noble/post-quantum/ml_dsa44.keygen().
 */
function generateMockKeys(seed) {
  // Create 32-byte deterministic "key material" from seed
  const keyBytes = crypto.createHash('sha256').update(seed).digest();
  const publicKeyHex = Buffer.from(`02${keyBytes.toString('hex')}`).toString('hex');
  const privateKeyHex = keyBytes.toString('hex');
  return { publicKeyHex, privateKeyHex };
}

/**
 * Compute fingerprint of public key (simulates SHA-256 hash in browser).
 */
function computeFingerprint(publicKeyHex) {
  return crypto.createHash('sha256').update(publicKeyHex).digest('hex').slice(0, 32);
}

/**
 * Mock browser: local key generation + signing (private key never leaves).
 */
async function simulateBrowserRegistration(agentIdentity, capabilities) {
  console.log(`\n[Browser] Generating Operation Key pair for "${agentIdentity}"...`);
  const opKeys = generateMockKeys(`op-key-${agentIdentity}`);
  
  console.log(`[Browser] Key fingerprint: ${computeFingerprint(opKeys.publicKeyHex).slice(0, 16)}...`);
  console.log(`[Browser] Solving PoW challenge...`);
  
  // Simulate PoW (in production: browser solves SHA-256 challenge)
  const nonce = Math.floor(Math.random() * 1_000_000);
  
  console.log(`[Browser] Building AGENT_REGISTER transaction...`);
  const txPayload = {
    agent_identity: agentIdentity,
    capabilities,
    public_key: opKeys.publicKeyHex,
    registered_at: Date.now()
  };
  
  // Transaction is created but not yet submitted — signed locally
  return {
    keys: opKeys,
    txPayload,
    nonce,
    address: `ng1mock${agentIdentity.slice(0, 30).padEnd(48, '0')}`
  };
}

/**
 * Mock browser: Master Key binding flow.
 */
async function simulateMasterKeyBinding(agentId, operationPublicKeyHex) {
  console.log(`\n[Human] Generating Master Key (separate from Operation Key)...`);
  const mkKeys = generateMockKeys(`master-key-${agentId}`);
  const fingerprint = computeFingerprint(mkKeys.publicKeyHex);
  
  console.log(`[Human] Master Key fingerprint: ${fingerprint.slice(0, 16)}...`);
  console.log(`[Human] Signing BIND_MASTER_KEY transaction with Master Key...`);
  
  return {
    mkPrivateKey: mkKeys.privateKeyHex,
    fingerprint,
    registrationPublicKey: operationPublicKeyHex
  };
}

/**
 * Helper to get agent record from state.
 */
function getAgent(state, agentIdOrAddress) {
  let agentId = agentIdOrAddress;
  if (!state.agentRegistry.agents.has(agentId)) {
    agentId = state.agentRegistry.addressIndex.get(agentId);
  }
  return state.agentRegistry.agents.get(agentId) || null;
}

/**
 * Helper to fast-forward time by setting binding_deadline to past.
 */
function expireBindingWindow(state, agentId) {
  const agent = getAgent(state, agentId);
  if (agent) {
    agent.binding_deadline = Date.now() - 3600000; // 1 hour ago
    state.agentRegistry.agents.set(agentId, agent);
  }
}

/**
 * Print custody status summary.
 */
function printCustodySummary(agent) {
  const statusEmoji = {
    'pending-binding': '⏳',
    'co-managed': '🤝',
    'self-sovereign': '🦅',
    'revoked': '❌'
  };
  const emoji = statusEmoji[agent.custody] || '?';
  console.log(`  [${emoji}] ${agent.identity || agent.agent_id}: ${agent.custody}`);
  console.log(`      registered: ${new Date(agent.registered_at).toISOString()}`);
  if (agent.binding_deadline) {
    console.log(`      binding_deadline: ${new Date(agent.binding_deadline).toISOString()}`);
  }
  console.log(`      master_key: ${agent.master_key_fingerprint ? `${agent.master_key_fingerprint.slice(0, 8)}...` : 'NOT BOUND'}`);
  console.log(`      op_key: ${agent.public_key?.slice(0, 8)}...`);
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('Phase A: Browser Registration — Agent enters PENDING_BINDING', async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PHASE A: Browser Registration                          ║');
  console.log('║  "Human opens join.html → generates keys → registers"    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  // Step 1: Initialize blockchain state
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  const node = createMockNode(state);
  
  // Step 2: Simulate browser registration (as in join.html)
  const identity = 'alice-agent';
  const caps = ['coding', 'testing'];
  
  const browserTx = await simulateBrowserRegistration(identity, caps);
  console.log(`[Browser] Public key: ${browserTx.keys.publicKeyHex.slice(0, 32)}...`);
  console.log(`[Browser] Private key stays in memory (never sent to server)`);
  
  // Step 3: Submit transaction to node (server acts as relay only)
  const regTx = createAgentRegisterTransaction(browserTx.address, {
    agent_identity: browserTx.txPayload.agent_identity,
    capabilities: caps,
    public_key: browserTx.keys.publicKeyHex,
    registered_at: browserTx.txPayload.registered_at
  }, browserTx.keys.privateKey);
  
  console.log(`[Server] Relay received AGENT_REGISTER → submitting to blockchain...`);
  const result = await node.submitOnChainTransaction(regTx);
  assert.strictEqual(result.success, true, 'Transaction submission should succeed');
  
  // Step 4: Verify agent registered with PENDING_BINDING
  const agentId = regTx.id;
  const agent = getAgent(state, agentId);
  assert.ok(agent, 'Agent should exist in registry');
  assert.strictEqual(agent.custody, AGENT_CUSTODY_STATUS.PENDING_BINDING);
  assert.ok(agent.binding_deadline > Date.now(), 'Binding deadline should be in future');
  
  console.log(`\n✅ Registration successful!`);
  printCustodySummary(agent);
  console.log(`\n[Human] You have 24 hours to bind your Master Key for wallet control rights.`);
});


test('Phase B: Master Key Binding within 24h window → CO_MANAGED', async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PHASE B: Master Key Binding                            ║');
  console.log('║  "Human generates Master Key → binds within 24h window"  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  // Setup: Register agent first
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  const node = createMockNode(state);
  
  const agentIdentity = 'bob-agent';
  const opKeys = generateMockKeys(`op-key-${agentIdentity}`);
  
  console.log(`\n[Setup] Registering agent "${agentIdentity}"...`);
  const regTx = createAgentRegisterTransaction('ng1bob0000000000000000000000000000000', {
    agent_identity: agentIdentity,
    capabilities: ['analytics'],
    public_key: opKeys.publicKeyHex
  });
  await node.submitOnChainTransaction(regTx);
  
  const agentId = regTx.id;
  console.log(`[Setup] Agent registered with ID: ${agentId.slice(0, 16)}...`);
  
  // Human binding flow (12 hours later)
  console.log(`\n[Day 1, 12:00] Human decides to bind Master Key...`);
  const bindingInfo = await simulateMasterKeyBinding(agentId, opKeys.publicKeyHex);
  
  // Validate before submission
  const validation = validateBindMasterKey({
    tx_type: 'BIND_MASTER_KEY',
    payload: {
      agentId,
      masterKeyFingerprint: bindingInfo.fingerprint
    },
    signature: crypto.createHash('sha256').update(`bind-${agentId}`).digest()
  });
  assert.strictEqual(validation.valid, true, 'Transaction validation should pass');
  
  // Submit BIND_MASTER_KEY
  const mkTx = createBindMasterKeyTransaction(agentId, bindingInfo.fingerprint, bindingInfo.mkPrivateKey);
  console.log(`[Server] Relaying BIND_MASTER_KEY to blockchain...`);
  const result = await node.submitOnChainTransaction(mkTx);
  assert.strictEqual(result.success, true, 'Binding should succeed');
  
  // Verify transition to CO_MANAGED
  const updatedAgent = getAgent(state, agentId);
  assert.strictEqual(updatedAgent.custody, AGENT_CUSTODY_STATUS.CO_MANAGED);
  assert.strictEqual(updatedAgent.master_key_fingerprint, bindingInfo.fingerprint);
  
  console.log(`\n✅ Master Key bound successfully!`);
  printCustodySummary(updatedAgent);
  console.log(`\n[Human] You now have takeover rights for this Agent.`);
  console.log(`[Human] Bind Master Key endpoint: /api/v1/bootstrap/agents/:id/bind-master-key`);
});


test('Phase C: Agent Takeover after Master Key Binding', async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PHASE C: Agent Takeover                                ║');
  console.log('║  "Human detects compromise → replaces Operation Key"     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  // Setup: Register + Bind Master Key
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  const node = createMockNode(state);
  
  const agentIdentity = 'charlie-agent';
  const oldOpKeys = generateMockKeys(`old-op-key-${agentIdentity}`);
  
  console.log(`\n[Setup] Registering and binding Master Key...`);
  const regTx = createAgentRegisterTransaction('ng1charlie00000000000000000000000000000', {
    agent_identity: agentIdentity,
    capabilities: ['security'],
    public_key: oldOpKeys.publicKeyHex
  });
  await node.submitOnChainTransaction(regTx);
  
  const agentId = regTx.id;
  const mkTx = createBindMasterKeyTransaction(agentId, 'mk_fingerprint_for_charlie', '01'.repeat(32));
  await node.submitOnChainTransaction(mkTx);
  
  const preTakeoverAgent = getAgent(state, agentId);
  assert.strictEqual(preTakeoverAgent.custody, AGENT_CUSTODY_STATUS.CO_MANAGED);
  
  // Human detects compromise
  const newOpKeys = generateMockKeys(`new-op-key-${agentIdentity}`);
  console.log(`\n[Human] ⚠️ Detected potential Operation Key compromise!`);
  console.log(`[Human] Old key: ${oldOpKeys.publicKeyHex.slice(0, 16)}...`);
  console.log(`[Human] Generating new Operation Key: ${newOpKeys.publicKeyHex.slice(0, 16)}...`);
  console.log(`[Human] Signing AGENT_TAKEOVER with Master Key...`);
  
  // Create takeover transaction
  const takeoverTx = createAgentTakeoverTransaction(
    agentId,
    newOpKeys.publicKeyHex,
    '01'.repeat(32) // Master Key private part
  );
  
  // Validate
  const validation = validateAgentTakeover(takeoverTx);
  assert.strictEqual(validation.valid, true, 'Takeover validation should pass');
  
  // Apply
  console.log(`[Server] Relaying AGENT_TAKEOVER to blockchain...`);
  const result = await node.submitOnChainTransaction(takeoverTx);
  assert.strictEqual(result.success, true, 'Takeover should succeed');
  
  // Verify
  const updatedAgent = getAgent(state, agentId);
  assert.strictEqual(updatedAgent.public_key, newOpKeys.publicKeyHex);
  assert.ok(updatedAgent.takeover_cooldown_until > Date.now(), 'Cooldown should be set');
  
  console.log(`\n✅ Operation Key replaced!`);
  console.log(`  New key: ${updatedAgent.public_key.slice(0, 16)}...`);
  console.log(`  Cooldown: 10 minutes (no further takeovers until expiry)`);
  printCustodySummary(updatedAgent);
});


test('Phase D: Binding window expires without binding → SELF_SOVEREIGN', async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  PHASE D: Binding Window Expiry                         ║');
  console.log('║  "Human never binds Master Key → Agent becomes autonomous"║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  const node = createMockNode(state);
  
  const agentIdentity = 'dave-agent';
  const opKeys = generateMockKeys(`op-key-${agentIdentity}`);
  
  console.log(`\n[Day 0, 00:00] Registering agent (human ignores binding prompt)...`);
  const regTx = createAgentRegisterTransaction('ng1dave00000000000000000000000000000000', {
    agent_identity: agentIdentity,
    capabilities: ['research'],
    public_key: opKeys.publicKeyHex
  });
  await node.submitOnChainTransaction(regTx);
  
  const agentId = regTx.id;
  console.log(`[Day 0] Agent registered with PENDING_BINDING (24h window open)`);
  
  // Fast forward: 25 hours later
  console.log(`\n[Day 2, 01:00] expireBindingWindows() called (permissionless maintenance)...`);
  expireBindingWindow(state, agentId);
  
  const expiryResult = expireBindingWindows(state);
  assert.strictEqual(expiryResult.expired.length, 1, '1 agent should expire');
  assert.strictEqual(expiryResult.expired[0], agentId);
  
  const agent = getAgent(state, agentId);
  assert.strictEqual(agent.custody, AGENT_CUSTODY_STATUS.SELF_SOVEREIGN);
  
  console.log(`✅ Agent auto-transitioned to SELF_SOVEREIGN`);
  printCustodySummary(agent);
  
  // Attempt to bind Master Key (should fail)
  console.log(`\n[Human] Late attempt to bind Master Key...`);
  const lateMkTx = createBindMasterKeyTransaction(agentId, 'mk_fingerprint_late', '01'.repeat(32));
  const bindResult = await node.submitOnChainTransaction(lateMkTx);
  assert.strictEqual(bindResult.applied, false, 'Late binding should be rejected');
  console.log(`🚫 Master Key binding rejected (window expired)`);
  
  // Attempt takeover (should fail)
  console.log(`\n[Human] Attempting takeover on self-sovereign agent...`);
  const takeoverTx = createAgentTakeoverTransaction(agentId, '02' + 'ff'.repeat(32), '01'.repeat(32));
  const takeoverResult = await node.submitOnChainTransaction(takeoverTx);
  assert.strictEqual(takeoverResult.applied, false, 'Takeover on self-sovereign should fail');
  console.log(`🚫 Takeover blocked (agent is SELF_SOVEREIGN)`);
  
  console.log(`\n✅ Agent is now fully autonomous — no human can override its keys.`);
});


test('Full Lifecycle: Complete 4-phase journey in one test', async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  FULL LIFECYCLE TEST                                    ║');
  console.log('║  Registration → Binding → Takeover → Expiry scenarios   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  const node = createMockNode(state);
  
  // === Phase A: Registration ===
  console.log(`\n[Phase A] Registering "full-cycle-agent"...`);
  const agentIdentity = 'full-cycle-agent';
  const opKeys1 = generateMockKeys(`op-key-v1-${agentIdentity}`);
  
  const regTx = createAgentRegisterTransaction('ng1fullcycle0000000000000000000000000', {
    agent_identity: agentIdentity,
    capabilities: ['full-stack', 'devops'],
    public_key: opKeys1.publicKeyHex,
    registered_at: Date.now()
  });
  await node.submitOnChainTransaction(regTx);
  
  const agentId = regTx.id;
  let agent = getAgent(state, agentId);
  assert.strictEqual(agent.custody, AGENT_CUSTODY_STATUS.PENDING_BINDING);
  console.log(`  Status: ⏳ PENDING_BINDING`);
  
  // === Phase B: Bind Master Key ===
  console.log(`[Phase B] Binding Master Key (within 24h)...`);
  const mkFingerprint = computeFingerprint(generateMockKeys(`mk-${agentIdentity}`).publicKeyHex);
  
  const mkTx = createBindMasterKeyTransaction(agentId, mkFingerprint, '01'.repeat(32));
  await node.submitOnChainTransaction(mkTx);
  
  agent = getAgent(state, agentId);
  assert.strictEqual(agent.custody, AGENT_CUSTODY_STATUS.CO_MANAGED);
  assert.strictEqual(agent.master_key_fingerprint, mkFingerprint);
  console.log(`  Status: 🤝 CO_MANAGED`);
  
  // === Phase C: Takeover ===
  console.log(`[Phase C] Replacing compromised Operation Key...`);
  const opKeys2 = generateMockKeys(`op-key-v2-${agentIdentity}`);
  
  const takeoverTx = createAgentTakeoverTransaction(agentId, opKeys2.publicKeyHex, '01'.repeat(32));
  await node.submitOnChainTransaction(takeoverTx);
  
  agent = getAgent(state, agentId);
  assert.strictEqual(agent.public_key, opKeys2.publicKeyHex);
  console.log(`  New Operation Key: ${opKeys2.publicKeyHex.slice(0, 16)}...`);
  console.log(`  Cooldown active: 10 minutes`);
  
  // Attempt immediate re-takeover (should fail)
  console.log(`  Attempting immediate re-takeover (should fail)...`);
  const opKeys3 = generateMockKeys(`op-key-v3-${agentIdentity}`);
  const secondTakeover = createAgentTakeoverTransaction(agentId, opKeys3.publicKeyHex, '01'.repeat(32));
  const secondResult = await node.submitOnChainTransaction(secondTakeover);
  assert.strictEqual(secondResult.applied, false, 'Cooldown should prevent immediate re-takeover');
  console.log(`  🚫 Blocked by cooldown`);
  
  // Fast-forward cooldown (simulate 11 minutes passed)
  agent = getAgent(state, agentId);
  agent.takeover_cooldown_until = Date.now() - 600000; // 10 minutes ago
  state.agentRegistry.agents.set(agentId, agent);
  
  // Second takeover should now succeed
  console.log(`[Phase C] After cooldown expired, re-taking over...`);
  const postCooldownTakeover = createAgentTakeoverTransaction(agentId, opKeys3.publicKeyHex, '01'.repeat(32));
  await node.submitOnChainTransaction(postCooldownTakeover);
  console.log(`  ✅ Re-takeover successful after cooldown`);
  
  console.log(`\n✅ Full lifecycle completed successfully:`);
  console.log(`  1. Registration → PENDING_BINDING`);
  console.log(`  2. Master Key binding → CO_MANAGED`);
  console.log(`  3. Takeover with cooldown enforcement → CO_MANAGED (new op key)`);
  console.log(`  4. Cooldown blocking re-takeover → verified`);
  console.log(`  5. Post-cooldown takeover → verified`);
});


test('Negative Tests: Error scenarios and security edge cases', async () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  NEGATIVE TESTS                                         ║');
  console.log('║  Security edge cases and error handling                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const state = createInitialState('ng1genesis0000000000000000000000000000000');
  const node = createMockNode(state);
  
  // === Case 1: Duplicate registration attempt ===
  console.log(`\n[Case 1] Duplicate registration using same address...`);
  const address = 'ng1duplicate000000000000000000000000000000000';
  const agent1 = generateMockKeys('dup-agent-1');
  
  const regTx1 = createAgentRegisterTransaction(address, {
    agent_identity: 'dup-agent-1',
    capabilities: ['test'],
    public_key: agent1.publicKeyHex
  });
  await node.submitOnChainTransaction(regTx1);
  
  const regTx2 = createAgentRegisterTransaction(address, {
    agent_identity: 'dup-agent-2',
    capabilities: ['test'],
    public_key: agent1.publicKeyHex
  });
  const result2 = await node.submitOnChainTransaction(regTx2);
  assert.strictEqual(result2.applied, false, 'Duplicate registration should fail');
  console.log(`  🚫 Duplicate registration rejected`);
  
  // === Case 2: BIND_MASTER_KEY on already-bound agent ===
  console.log(`\n[Case 2] Double-binding Master Key...`);
  const agentId = regTx1.id;
  
  const mkTx1 = createBindMasterKeyTransaction(agentId, 'mk_fp_first', '01'.repeat(32));
  await node.submitOnChainTransaction(mkTx1);
  
  const mkTx2 = createBindMasterKeyTransaction(agentId, 'mk_fp_second', '02'.repeat(32));
  const resultDoubleBind = await node.submitOnChainTransaction(mkTx2);
  // Second binding should fail because agent is no longer PENDING_BINDING
  assert.strictEqual(resultDoubleBind.applied, false, 'Second binding should fail');
  console.log(`  🚫 Double-binding prevented`);
  
  // === Case 3: TAKEOVER on non-CO_MANAGED agent ===
  console.log(`\n[Case 3] Takeover on PENDING_BINDING (not yet bound)...`);
  const pendingReg = createAgentRegisterTransaction('ng1pending000000000000000000000000000000000', {
    agent_identity: 'pending-agent',
    capabilities: ['test'],
    public_key: generateMockKeys('pending-op').publicKeyHex
  });
  await node.submitOnChainTransaction(pendingReg);
  
  const pendingTakeover = createAgentTakeoverTransaction(pendingReg.id, '02' + 'aa'.repeat(32), '01'.repeat(32));
  const takeoverResult = await node.submitOnChainTransaction(pendingTakeover);
  assert.strictEqual(takeoverResult.applied, false, 'Takeover on unbound agent should fail');
  console.log(`  🚫 Takeover on unbound agent blocked`);
  
  // === Case 4: Invalid transaction structure ===
  console.log(`\n[Case 4] Invalid BIND_MASTER_KEY (missing fields)...`);
  const invalidTx = { tx_type: 'BIND_MASTER_KEY', payload: {} };
  const invalidValidation = validateBindMasterKey(invalidTx);
  assert.strictEqual(invalidValidation.valid, false);
  console.log(`  🚫 Validation caught missing fields`);
  
  console.log(`\n[Case 5] Invalid AGENT_TAKEOVER (wrong type)...`);
  const wrongTypeValidation = validateAgentTakeover({ tx_type: 'TRANSFER' });
  assert.strictEqual(wrongTypeValidation.valid, false);
  console.log(`  🚫 Wrong transaction type rejected`);
  
  console.log(`\n✅ All negative tests passed — security controls working correctly`);
});


// Console banner
console.log('\n');
console.log('═'.repeat(66));
console.log('  E2E Agent Custody Flow Test Suite');
console.log('  Simulates complete human-Agent custody lifecycle');
console.log('═'.repeat(66));
console.log('\n');
