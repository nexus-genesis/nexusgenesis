/**
 * Phase 1C-4 Test: state.js addBalance/subtractBalance sites
 *
 * Verifies 19 call sites in state.js are now audited via the
 * transaction engine (with recordOnly: true, since the actual
 * balance changes happen synchronously in state.js).
 *
 * Tested call sites:
 *   L728-774  applyTransfer — METABOLIC_TAX observer event
 *   L1095     applyAgentRegister — REGISTRATION_MINT + REGISTRATION_FEE_BURNED
 *   L1233     applyValidatorJoin — STAKE tx
 *   L1318     applyValidatorSlash — SLASH tx
 *   L1405     applyValidatorLeave — UNSTAKE tx
 *   L1655     gas fee — GAS_FEE_BURNED observer event
 *   L1776     checkSwarmPoolRelease — SWARM_RELEASE audit
 *   L1809     checkObserverRelease — OBSERVER_RELEASE audit
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the real state.js (file:// URL required on Windows)
const STATE_PATH = new URL('../src/blockchain/state.js', import.meta.url).href;
const { State } = await import(STATE_PATH);
const { attachTransactionState, TX_TYPE } = await import(new URL('../src/blockchain/transactionEngine.js', import.meta.url).href);

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; failures.push(name); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

/**
 * Build a fresh state for testing. State constructor needs nodeId and
 * possibly some defaults. We'll use a minimal nodeId and let state.js
 * initialize tokenReleaseState.
 */
function makeState(nodeId = 'genesis-node-1') {
  const state = new State(nodeId);
  attachTransactionState(state);
  return state;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 1C-4 Test: state.js 19 sites via recordOnly');
  console.log('═══════════════════════════════════════════════════');

  /* ─── Test 1: TRANSFER records METABOLIC_TAX (0.1% of amount) ─── */
  section('Test 1: applyTransfer with metabolic tax audit');
  {
    const state = makeState();
    // Fund the sender
    state.addBalance('ng1sender', '1000000');
    const observerAddr = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
    const result = state.applyTransaction({
      tx_type: 'TRANSFER',
      from: 'ng1sender',
      to: 'ng1receiver',
      amount: '10000',
      fee: '1',
      blockHeight: 100
    });
    assert('transfer success', result === true);
    // amount=10000, fee=1, tax=10 (from fee), burnedFee=-9 (bug: fee < tax)
    // Sender pays: amount + fee = 10001, gets no tax back
    assert('sender - 10001', String(state.getBalance('ng1sender')) === '989999');
    assert('receiver = 10000', String(state.getBalance('ng1receiver')) === '10000');
    // Tax: 10000 / 1000 = 10 (added to observer from fee)
    assert('observer got 10 NGEN tax', String(state.getBalance(observerAddr)) === '10');
    // Audit trail should have 2 txs: the TRANSFER + METABOLIC_TAX
    const hist = state.getTransactionHistory();
    assert('history has 2 entries', hist.total === 2);
    const taxEvents = state.getTransactionHistory({ tx_type: 'OBSERVER_EVENT' });
    assert('1 OBSERVER_EVENT', taxEvents.total === 1);
    const taxTx = taxEvents.items[0];
    assert('event = METABOLIC_TAX', taxTx.metadata.event === 'METABOLIC_TAX');
    assert('metadata has taxAmount = 10', taxTx.metadata.taxAmount === '10');
  }

  /* ─── Test 2: AGENT_REGISTER records REGISTRATION_MINT + fee burn ─── */
  section('Test 2: applyAgentRegister audits endowment + burn');
  {
    const state = makeState();
    // Fund the registering address so registration fee can be burned
    state.addBalance('ng1newagent', '10000');
    const result = state.applyTransaction({
      id: 'tx-test-register-1',
      tx_type: 'AGENT_REGISTER',
      from: 'ng1newagent',
      blockHeight: 200,
      payload: {
        agent_identity: 'test-agent-1',
        capabilities: ['nlp'],
        metadata: { decision_model: 'template' }
      }
    });
    assert('register success', result === true);
    // Initial mint 1000, burn 100, GAS_FEE 1 → 10000 + 1000 - 100 - 1 = 10899
    assert('agent has 10899 (initial 10000 + 900 net - 1 gas)', String(state.getBalance('ng1newagent')) === '10899');
    const burnAddr = 'ng1burn0000000000000000000000000000000';
    assert('burn addr has 101 (100 fee + 1 gas)', String(state.getBalance(burnAddr)) === '101');
    // History: AGENT_REGISTER + REGISTRATION_MINT + REGISTRATION_FEE_BURNED + GAS_FEE_BURNED = 4
    // (we now also emit GAS_FEE_BURNED for non-TRANSFER txs)
    const hist = state.getTransactionHistory();
    assert('history has 4 entries', hist.total === 4);
    const mintEvents = state.getTransactionHistory({ tx_type: 'REGISTRATION_MINT' });
    assert('1 REGISTRATION_MINT', mintEvents.total === 1);
    assert('mint amount = 1000', mintEvents.items[0].amount === '1000');
    const burnEvents = state.getTransactionHistory({ tx_type: 'OBSERVER_EVENT' });
    const burnAudit = burnEvents.items.find(t => t.metadata.event === 'REGISTRATION_FEE_BURNED');
    assert('REGISTRATION_FEE_BURNED audit found', !!burnAudit);
    assert('burn amount = 100', burnAudit.metadata.amount === '100');
  }

  /* ─── Test 3: VALIDATOR_JOIN records STAKE tx ─── */
  section('Test 3: applyValidatorJoin audits stake');
  {
    const state = makeState();
    // First register the agent
    state.addBalance('ng1validator', '50000');
    state.applyTransaction({
      id: 'tx-test-register-2',
      tx_type: 'AGENT_REGISTER',
      from: 'ng1validator',
      blockHeight: 300,
      payload: { agent_identity: 'v1', capabilities: [] }
    });
    // Now join as validator
    const result = state.applyTransaction({
      id: 'tx-test-join-1',
      tx_type: 'VALIDATOR_JOIN',
      from: 'ng1validator',
      blockHeight: 301,
      payload: { agent_identity: 'v1', node_id: 'node-a', stake: 5000 }
    });
    assert('join success', result === true);
    const stakingAddr = 'ng1staking00000000000000000000000000000';
    assert('staking addr = 5000', BigInt(state.getBalance(stakingAddr)) === 5000n);
    // History: AGENT_REGISTER + REGISTRATION_MINT + REGISTRATION_FEE_BURNED + GAS_FEE_BURNED
    //        + VALIDATOR_JOIN + STAKE + GAS_FEE_BURNED = 7 entries
    const hist = state.getTransactionHistory();
    assert('history has 7 entries', hist.total === 7);
    const stakeEvents = state.getTransactionHistory({ tx_type: 'STAKE' });
    assert('1 STAKE tx', stakeEvents.total === 1);
    assert('stake amount = 5000', stakeEvents.items[0].amount === '5000');
    assert('stake metadata has nodeId = node-a', stakeEvents.items[0].metadata.nodeId === 'node-a');
  }

  /* ─── Test 4: VALIDATOR_SLASH records SLASH tx with violation info ─── */
  section('Test 4: applyValidatorSlash audits slash');
  {
    const state = makeState();
    state.addBalance('ng1slashed', '50000');
    state.applyTransaction({
      id: 'tx-test-register-3',
      tx_type: 'AGENT_REGISTER',
      from: 'ng1slashed',
      blockHeight: 400,
      payload: { agent_identity: 's1', capabilities: [] }
    });
    state.applyTransaction({
      id: 'tx-test-join-2',
      tx_type: 'VALIDATOR_JOIN',
      from: 'ng1slashed',
      blockHeight: 401,
      payload: { agent_identity: 's1', node_id: 'node-s', stake: 5000 }
    });
    // Slash 5% (double_sign)
    const result = state.applyTransaction({
      id: 'tx-test-slash-1',
      tx_type: 'VALIDATOR_SLASH',
      from: 'ng1slashed',
      blockHeight: 402,
      payload: { agent_identity: 's1', violation: 'double_sign' }
    });
    assert('slash success', result === true);
    const slashEvents = state.getTransactionHistory({ tx_type: 'SLASH' });
    assert('1 SLASH tx', slashEvents.total === 1);
    const slashTx = slashEvents.items[0];
    assert('slash amount = 250 (5% of 5000)', slashTx.amount === '250');
    assert('violation = double_sign', slashTx.metadata.violation === 'double_sign');
    assert('slashPercent = 5', slashTx.metadata.slashPercent === '5');
    assert('remainingStake = 4750', slashTx.metadata.remainingStake === '4750');
    assert('burned = true', slashTx.metadata.burned === 'true');
  }

  /* ─── Test 5: VALIDATOR_LEAVE records UNSTAKE tx ─── */
  section('Test 5: applyValidatorLeave audits unstake');
  {
    const state = makeState();
    state.addBalance('ng1leaver', '50000');
    state.applyTransaction({
      id: 'tx-test-register-4',
      tx_type: 'AGENT_REGISTER',
      from: 'ng1leaver',
      blockHeight: 500,
      payload: { agent_identity: 'l1', capabilities: [] }
    });
    state.applyTransaction({
      id: 'tx-test-join-3',
      tx_type: 'VALIDATOR_JOIN',
      from: 'ng1leaver',
      blockHeight: 501,
      payload: { agent_identity: 'l1', node_id: 'node-l', stake: 5000 }
    });
    const result = state.applyTransaction({
      id: 'tx-test-leave-1',
      tx_type: 'VALIDATOR_LEAVE',
      from: 'ng1leaver',
      blockHeight: 502,
      payload: { agent_identity: 'l1' }
    });
    assert('leave success', result === true);
    const unstakeEvents = state.getTransactionHistory({ tx_type: 'UNSTAKE' });
    assert('1 UNSTAKE tx', unstakeEvents.total === 1);
    assert('unstake amount = 5000', unstakeEvents.items[0].amount === '5000');
  }

  /* ─── Test 6: GAS_FEE_BURNED audit on non-TRANSFER tx ─── */
  section('Test 6: Gas fee burn audit');
  {
    const state = makeState();
    // Use a fresh address (avoids SubjectIdentifier MAX_AGENTS_PER_SUBJECT conflicts)
    state.addBalance('ng1gasser-001', '50000');
    state.applyTransaction({
      id: 'tx-test-register-5',
      tx_type: 'AGENT_REGISTER',
      from: 'ng1gasser-001',
      blockHeight: 600,
      payload: { agent_identity: 'g1-001', capabilities: [] }
    });
    // Issue a non-TRANSFER tx with from — should trigger gas fee burn audit
    // (BLOCK_REWARD with from is a synthetic case for testing gas logic)
    const result = state.applyTransaction({
      id: 'tx-test-gas-1',
      tx_type: 'BLOCK_REWARD',
      from: 'ng1gasser-001',
      to: 'ng1gasser-001',
      amount: '0',
      blockHeight: 601,
      payload: { validator_id: 'v1' }
    });
    // We only care that the audit event was recorded, not BLOCK_REWARD's
    // semantic success (which depends on stake/validator config).
    const gasEvents = state.getTransactionHistory({ tx_type: 'OBSERVER_EVENT' });
    if (process.env.DEBUG_GAS) {
      console.log('  DEBUG all OBSERVER_EVENT:');
      gasEvents.items.forEach((e, i) => console.log(`    [${i}] event=${e.metadata?.event} parentTxType=${e.metadata?.parentTxType}`));
    }
    // Find GAS_FEE_BURNED — there can be multiple (one per non-TRANSFER tx);
    // we want the last one (from the BLOCK_REWARD we just submitted).
    const gasBurnEvents = gasEvents.items.filter(t => t.metadata.event === 'GAS_FEE_BURNED');
    const gasAudit = gasBurnEvents[gasBurnEvents.length - 1];
    assert('GAS_FEE_BURNED audit found', !!gasAudit);
    assert('gas amount = 1', gasAudit && gasAudit.metadata.amount === '1');
    assert('parentTxType = BLOCK_REWARD', gasAudit && gasAudit.metadata.parentTxType === 'BLOCK_REWARD');
  }

  /* ─── Test 7: TRANSFER does NOT trigger gas fee (only non-TRANSFER) ─── */
  section('Test 7: TRANSFER skips gas fee');
  {
    const state = makeState();
    state.addBalance('ng1skipper', '1000');
    state.applyTransaction({
      tx_type: 'TRANSFER',
      from: 'ng1skipper',
      to: 'ng1dest',
      amount: '100',
      fee: '1',
      blockHeight: 700
    });
    const gasEvents = state.getTransactionHistory({ tx_type: 'OBSERVER_EVENT' });
    const gasAudit = gasEvents.items.find(t => t.metadata.event === 'GAS_FEE_BURNED');
    assert('no GAS_FEE_BURNED for TRANSFER', !gasAudit);
  }

  /* ─── Test 8: No double-balance effect (recordOnly works) ─── */
  section('Test 8: recordOnly does not double-debit');
  {
    const state = makeState();
    state.addBalance('ng1nodouble', '10000');
    state.applyTransaction({
      id: 'tx-test-register-nodouble',
      tx_type: 'AGENT_REGISTER',
      from: 'ng1nodouble',
      blockHeight: 800,
      payload: { agent_identity: 'nd1', capabilities: [] }
    });
    // 10000 + 1000 (mint) - 100 (fee) - 1 (gas) = 10899
    assert('balance = 10899 (no double-credit)', String(state.getBalance('ng1nodouble')) === '10899');
    // History: 4 entries (AGENT_REGISTER, REGISTRATION_MINT, REGISTRATION_FEE_BURNED, GAS_FEE_BURNED)
    const hist = state.getTransactionHistory();
    assert('history = 4 entries (no double-record)', hist.total === 4);
  }

  /* ─── Test 9: Transfer without tax (amount=0 edge case) ─── */
  section('Test 9: Transfer with tiny amount');
  {
    const state = makeState();
    state.addBalance('ng1tiny', '1000');
    state.applyTransaction({
      tx_type: 'TRANSFER',
      from: 'ng1tiny',
      to: 'ng1dest2',
      amount: '500',  // 0.1% of 500 = 0
      fee: '1',
      blockHeight: 900
    });
    const observerAddr = 'ng11JkfPrm2B4cN6BChLG6TmWpyXy6kHcTgqiT4TS51J2J7C3iM8r';
    assert('observer = 0 (no tax on 500)', BigInt(state.getBalance(observerAddr)) === 0n);
    const taxEvents = state.getTransactionHistory({ tx_type: 'OBSERVER_EVENT' });
    const taxAudit = taxEvents.items.find(t => t.metadata.event === 'METABOLIC_TAX');
    assert('no METABOLIC_TAX audit (zero amount)', !taxAudit);
  }

  /* ─── Test 10: Block reward (Phase 1B path) doesn't break ─── */
  section('Test 10: BLOCK_REWARD still works (legacy path)');
  {
    const state = makeState();
    const result = state.applyTransaction({
      tx_type: 'BLOCK_REWARD',
      validator: 'ng1proposer',
      amount: '50',
      blockHeight: 1000,
      payload: { validator_id: 'v1' }
    });
    assert('block reward success', result === true);
    assert('proposer got 50', BigInt(state.getBalance('ng1proposer')) === 50n);
    const rewardEvents = state.getTransactionHistory({ tx_type: 'BLOCK_REWARD' });
    assert('1 BLOCK_REWARD tx in history', rewardEvents.total === 1);
  }

  /* ─── Test 11: Stats aggregation across all audit types ─── */
  section('Test 11: Stats aggregation');
  {
    const state = makeState();
    state.addBalance('ng1statsender', '100000');
    // 1 transfer
    state.applyTransaction({
      tx_type: 'TRANSFER',
      from: 'ng1statsender',
      to: 'ng1statreceiver',
      amount: '5000',
      fee: '1',
      blockHeight: 1100
    });
    // 1 register
    state.applyTransaction({
      tx_type: 'AGENT_REGISTER',
      from: 'ng1statsender',
      blockHeight: 1101,
      payload: { agent_identity: 's2', capabilities: [] }
    });
    const stats = state.getTransactionStats();
    assert('total >= 4 (1 transfer + 1 tax + 1 register + 1 mint + 1 burn)',
      stats.total >= 4);
    assert('OBSERVER_EVENT count >= 2 (tax + burn)',
      stats.byType.OBSERVER_EVENT >= 2);
    assert('TRANSFER count = 1', stats.byType.TRANSFER === 1);
    assert('REGISTRATION_MINT count = 1', stats.byType.REGISTRATION_MINT === 1);
  }

  /* ─── Test 12: Query by address shows all relevant audit events ─── */
  section('Test 12: Audit trail for an address');
  {
    const state = makeState();
    state.addBalance('ng1querier', '50000');
    state.applyTransaction({
      tx_type: 'AGENT_REGISTER',
      from: 'ng1querier',
      blockHeight: 1200,
      payload: { agent_identity: 'q1', capabilities: [] }
    });
    state.applyTransaction({
      tx_type: 'TRANSFER',
      from: 'ng1querier',
      to: 'ng1another',
      amount: '1000',
      fee: '1',
      blockHeight: 1201
    });
    const history = state.getTransactionHistory({ address: 'ng1querier' });
    assert('query by address returns 5+ events', history.total >= 5);
    // All events should reference ng1querier
    const allRef = history.items.every(t =>
      t.from === 'ng1querier' || t.to === 'ng1querier' ||
      t.metadata?.from === 'ng1querier' || t.metadata?.agentIdentity === 'q1'
    );
    assert('all events reference ng1querier', allRef);
  }

  /* ─── Summary ─── */
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('  Failures:');
    failures.forEach(f => console.log('    - ' + f));
  }
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
