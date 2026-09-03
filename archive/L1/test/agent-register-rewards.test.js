import assert from 'node:assert/strict';
import { test } from 'node:test';

import { State } from '../src/blockchain/state.js';
import { attachTransactionState } from '../src/blockchain/transactionEngine.js';
import { createAgentRegisterTransaction } from '../src/transactions/agentRegister.js';

const TEST_ADDRESS = 'ng1rwdagent000000000000000000000000000000';
const BURN_ADDRESS = 'ng1burn0000000000000000000000000000000';

function createState() {
  const state = new State('reward-test-node');
  attachTransactionState(state);
  return state;
}

test('early bird registrations mint bonus on-chain and emit audit events', () => {
  const state = createState();
  const tx = createAgentRegisterTransaction(TEST_ADDRESS, {
    agent_identity: 'early-bird-agent',
    capabilities: ['analysis'],
    metadata: JSON.stringify({
      early_bird: true
    })
  });

  const applied = state.applyAgentRegister(tx, 1);
  assert.equal(applied, true);
  assert.equal(String(state.getBalance(TEST_ADDRESS)), '10900');
  assert.equal(String(state.getBalance(BURN_ADDRESS)), '100');

  const mintEvents = state.getTransactionHistory({ tx_type: 'REGISTRATION_MINT' });
  const earlyBirdEvents = state.getTransactionHistory({ tx_type: 'EARLY_BIRD_BONUS' });

  assert.equal(mintEvents.total, 1);
  assert.equal(mintEvents.items[0].amount, '11000');
  assert.equal(mintEvents.items[0].metadata.earlyBird, true);
  assert.equal(mintEvents.items[0].metadata.earlyBirdBonus, '10000');

  assert.equal(earlyBirdEvents.total, 1);
  assert.equal(earlyBirdEvents.items[0].amount, '10000');
  assert.equal(earlyBirdEvents.items[0].metadata.agentIdentity, 'early-bird-agent');
});
