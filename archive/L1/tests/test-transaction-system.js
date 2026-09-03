/**
 * Transaction System Tests (Phase 1A)
 *
 * Tests:
 *   1. tx_type validation
 *   2. txHash generation
 *   3. queueTransaction
 *   4. applyTransaction (TRANSFER, MINT, BURN)
 *   5. applyTransactions (batch)
 *   6. getTransactionHistory (with filters)
 *   7. getTransactionStats
 *   8. Persistence (serialize/deserialize roundtrip)
 *   9. All 21 tx_type builders
 *  10. Insufficient balance handling
 *  11. Mempool dedup
 *  12. Compatibility with existing addBalance
 */

import {
  TX_TYPE,
  validateTransaction,
  generateTxHash,
  createTransactionState,
  attachTransactionState,
  serializeTransactions,
  deserializeTransactions
} from '../src/blockchain/transactionEngine.js';

import {
  buildTransfer,
  buildRegistrationMint,
  buildBlockReward,
  buildObserverTax,
  buildFeeBurn,
  buildSwarmRelease,
  buildGenesisUnlock,
  buildStake,
  buildUnstake,
  buildTaskCreate,
  buildTaskComplete,
  buildTaskReward,
  buildEarlyBirdBonus,
  buildReferralReward,
  buildSlash,
  buildGovernanceVote,
  buildGovernanceProposal,
  buildObserverEvent,
  buildMultiSigSpend,
  getBuilder,
  listBuilders
} from '../src/utils/transactionBuilder.js';

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; failures.push(name); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

/* ============================================================
 * Build a mock state with two funded addresses
 * ============================================================ */
function mockState() {
  const state = {
    balances: new Map([
      ['addr-alice', 1000n],
      ['addr-bob',   500n],
      ['ng1burn0000000000000000000000000000000000', 0n]
    ]),
    currentBlockHeight: 100,
    cache: { lastCacheUpdate: 0 },
    changes: { balances: new Set() }
  };
  state.getBalance = (addr) => state.balances.get(addr) || 0n;
  state.setBalance = (addr, val) => { state.balances.set(addr, BigInt(val)); };
  state.addBalance = (addr, amount) => {
    const cur = state.balances.get(addr) || 0n;
    state.balances.set(addr, cur + BigInt(amount.toString()));
  };
  state.subtractBalance = (addr, amount) => {
    const cur = state.balances.get(addr) || 0n;
    const sub = BigInt(amount.toString());
    if (cur < sub) return false;
    state.balances.set(addr, cur - sub);
    return true;
  };
  attachTransactionState(state);
  return state;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Transaction System Tests (Phase 1A)');
  console.log('═══════════════════════════════════════════════════');

  /* ─── Test 1: tx_type validation ─── */
  section('Test 1: tx_type validation');
  const v1 = validateTransaction({ tx_type: 'TRANSFER', from: 'a', to: 'b' });
  assert('TRANSFER valid', v1.valid);

  const v2 = validateTransaction({ tx_type: 'INVALID' });
  assert('unknown tx_type rejected', !v2.valid && v2.error.includes('unknown'));

  const v3 = validateTransaction({ tx_type: 'TRANSFER' });
  assert('TRANSFER without from rejected', !v3.valid);

  const v4 = validateTransaction({ tx_type: 'TRANSFER', from: 'a' });
  assert('TRANSFER without to rejected', !v4.valid);

  const v5 = validateTransaction({ tx_type: 'TRANSFER', from: 'a', to: 'b', amount: '-1' });
  assert('negative amount rejected', !v5.valid);

  const v6 = validateTransaction({ tx_type: 'TRANSFER', from: 'a', to: 'b', amount: 'abc' });
  assert('non-numeric amount rejected', !v6.valid);

  /* ─── Test 2: txHash generation ─── */
  section('Test 2: txHash generation');
  const h1 = generateTxHash({ tx_type: 'TRANSFER', from: 'a', to: 'b', amount: '100' });
  const h2 = generateTxHash({ tx_type: 'TRANSFER', from: 'a', to: 'b', amount: '100' });
  assert('txHash is a string', typeof h1 === 'string' && h1.startsWith('tx-'));
  assert('txHash has non-zero content', h1.length > 5);
  assert('txHash is non-deterministic (random suffix)', h1 !== h2);

  /* ─── Test 3: queueTransaction ─── */
  section('Test 3: queueTransaction');
  const s1 = mockState();
  const q1 = s1.queueTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 100 }));
  assert('queue succeeds', q1.success);
  assert('mempool size = 1', s1.transactions.mempool.length === 1);
  assert('txHash returned', typeof q1.txHash === 'string');

  // Dedup
  const q2 = s1.queueTransaction({
    tx_type: 'TRANSFER', from: 'addr-alice', to: 'addr-bob', amount: 100,
    txHash: q1.txHash
  });
  assert('duplicate txHash rejected', !q2.success && q2.error.includes('duplicate'));

  // Invalid
  const q3 = s1.queueTransaction({ tx_type: 'INVALID' });
  assert('invalid tx rejected', !q3.success);

  /* ─── Test 4: applyTransaction (TRANSFER/MINT/BURN) ─── */
  section('Test 4: applyTransaction');
  const s2 = mockState();
  const a1 = s2.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 100 }));
  assert('transfer succeeds', a1.success);
  assert('alice = 900', s2.getBalance('addr-alice') === 900n);
  assert('bob = 600', s2.getBalance('addr-bob') === 600n);
  assert('tx recorded', s2.transactions.txHistory.length === 1);

  // MINT
  const a2 = s2.applyTransaction(buildRegistrationMint({ to: 'addr-alice', amount: 50, agentId: 'new-agent' }));
  assert('mint succeeds', a2.success);
  assert('alice = 950 after mint', s2.getBalance('addr-alice') === 950n);

  // BURN
  const a3 = s2.applyTransaction(buildFeeBurn({ from: 'addr-alice', amount: 1, blockHeight: 100, txRef: 'abc' }));
  assert('burn succeeds', a3.success);
  assert('alice = 949 after burn', s2.getBalance('addr-alice') === 949n);
  assert('burn addr = 1', s2.getBalance('ng1burn0000000000000000000000000000000000') === 1n);

  /* ─── Test 5: applyTransactions (batch) ─── */
  section('Test 5: applyTransactions batch');
  const s3 = mockState();
  const batch = [
    buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 50 }),
    buildBlockReward({ to: 'addr-alice', amount: 50, blockHeight: 200, validatorId: 'v1' }),
    buildObserverTax({ from: 'addr-alice', amount: 5, blockHeight: 200, txRef: 'tx1' })
  ];
  const r = s3.applyTransactions(200, batch);
  assert('batch applied 3', r.applied === 3);
  assert('batch failed 0', r.failed === 0);
  assert('3 results returned', r.results.length === 3);

  /* ─── Test 6: getTransactionHistory (filters) ─── */
  section('Test 6: getTransactionHistory filters');
  const s4 = mockState();
  s4.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 10, blockHeight: 100 }));
  s4.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 20, blockHeight: 110 }));
  s4.applyTransaction(buildRegistrationMint({ to: 'addr-bob', amount: 5, agentId: 'x', blockHeight: 120 }));

  const hAll = s4.getTransactionHistory();
  assert('all 3 txs', hAll.total === 3);

  const hAlice = s4.getTransactionHistory({ address: 'addr-alice' });
  assert('alice has 2 txs (sender)', hAlice.total === 2);

  const hTransfer = s4.getTransactionHistory({ tx_type: TX_TYPE.TRANSFER });
  assert('filter by TRANSFER = 2', hTransfer.total === 2);

  const hMint = s4.getTransactionHistory({ tx_type: TX_TYPE.REGISTRATION_MINT });
  assert('filter by REGISTRATION_MINT = 1', hMint.total === 1);

  const hBlock = s4.getTransactionHistory({ fromBlock: 110 });
  assert('fromBlock filter', hBlock.total === 2);

  const hLimit = s4.getTransactionHistory({ limit: 1 });
  assert('limit works', hLimit.items.length === 1 && hLimit.total === 3);

  /* ─── Test 7: getTransactionStats ─── */
  section('Test 7: getTransactionStats');
  const s5 = mockState();
  s5.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 10 }));
  s5.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 20 }));
  s5.applyTransaction(buildRegistrationMint({ to: 'addr-bob', amount: 5, agentId: 'x' }));
  const stats = s5.getTransactionStats();
  assert('stats total = 3', stats.total === 3);
  assert('stats byType.TRANSFER = 2', stats.byType.TRANSFER === 2);
  assert('stats byType.REGISTRATION_MINT = 1', stats.byType.REGISTRATION_MINT === 1);
  assert('stats topAddresses exists', Array.isArray(stats.topAddresses));

  /* ─── Test 8: persistence roundtrip ─── */
  section('Test 8: Persistence serialize/deserialize');
  const s6 = mockState();
  s6.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 10 }));
  s6.applyTransaction(buildBlockReward({ to: 'addr-alice', amount: 50, blockHeight: 100, validatorId: 'v1' }));
  const ser = serializeTransactions(s6);
  assert('serialize has txHistory', ser.txHistory.length === 2);
  assert('serialize has txCount', ser.txCount === 2);

  // Restore into a new state
  const s7 = mockState();
  s7.transactions = deserializeTransactions(ser);
  assert('deserialize has txHistory', s7.transactions.txHistory.length === 2);
  assert('deserialize has correct amount',
    s7.transactions.txHistory[0].amount === '10' || s7.transactions.txHistory[1].amount === '10');

  // Test backward compat: null input
  const empty = deserializeTransactions(null);
  assert('null input → empty state',
    empty.txHistory.length === 0 && empty.mempool.length === 0);

  /* ─── Test 9: All 21 tx_type builders ─── */
  section('Test 9: All 21 tx_type builders');
  const builders = listBuilders();
  assert('21 builders available', builders.length === 21);
  for (const { tx_type, builder } of builders) {
    const exists = typeof builder === 'function';
    if (!exists) {
      assert(`builder for ${tx_type} exists`, false);
    }
  }
  assert('all 21 builders are functions',
    builders.every(b => typeof b.builder === 'function'));

  // Test each builder produces a valid tx
  const samples = {
    TRANSFER:            buildTransfer({ from: 'a', to: 'b', amount: 1 }),
    STAKE:               buildStake({ from: 'a', amount: 100 }),
    UNSTAKE:             buildUnstake({ from: 'a', to: 'b', amount: 100 }),
    GOVERNANCE_VOTE:     buildGovernanceVote({ from: 'a', proposalId: 'p1', vote: 'yes' }),
    GOVERNANCE_PROPOSAL: buildGovernanceProposal({ from: 'a', title: 't' }),
    TASK_CREATE:         buildTaskCreate({ from: 'a', taskId: 't1', reward: 50 }),
    TASK_COMPLETE:       buildTaskComplete({ from: 'a', taskId: 't1' }),
    TASK_REWARD:         buildTaskReward({ from: 'a', to: 'b', amount: 10, taskId: 't1' }),
    REGISTRATION_MINT:   buildRegistrationMint({ to: 'a', amount: 100, agentId: 'ag' }),
    BLOCK_REWARD:        buildBlockReward({ to: 'a', amount: 50, blockHeight: 1, validatorId: 'v' }),
    EARLY_BIRD_BONUS:    buildEarlyBirdBonus({ to: 'a', amount: 100, agentId: 'ag' }),
    REFERRAL_REWARD:     buildReferralReward({ to: 'a', amount: 10, agentId: 'ag', referralId: 'r' }),
    STAKE_REWARD:        null, // not exported, skip
    SWARM_RELEASE:       buildSwarmRelease({ to: 'a', amount: 100, blockHeight: 1 }),
    OBSERVER_RELEASE:    null, // not exported, skip
    GENESIS_UNLOCK:      buildGenesisUnlock({ to: 'a', amount: 100, blockHeight: 1, milestoneId: 'M1' }),
    OBSERVER_TAX:        buildObserverTax({ from: 'a', amount: 1, blockHeight: 1, txRef: 't' }),
    FEE_BURN:            buildFeeBurn({ from: 'a', amount: 1, blockHeight: 1, txRef: 't' }),
    SLASH:               buildSlash({ from: 'a', amount: 10, blockHeight: 1, reason: 'r' }),
    OBSERVER_EVENT:      buildObserverEvent({ event: 'log' }),
    MULTISIG_SPEND:      buildMultiSigSpend({ from: 'a', to: 'b', amount: 10, blockHeight: 1, proposalId: 'p' })
  };
  for (const [type, tx] of Object.entries(samples)) {
    if (tx) {
      const v = validateTransaction(tx);
      assert(`builder ${type} produces valid tx`, v.valid, v.error || '');
    }
  }

  /* ─── Test 10: Insufficient balance ─── */
  section('Test 10: Insufficient balance');
  const s8 = mockState();
  s8.applyTransaction(buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 2000 }));
  const hist = s8.getTransactionHistory();
  assert('failed tx recorded', hist.total === 1);
  assert('failed tx has status=failed', hist.items[0].status === 'failed');
  assert('alice balance unchanged', s8.getBalance('addr-alice') === 1000n);

  /* ─── Test 11: Mempool dedup ─── */
  section('Test 11: Mempool dedup');
  const s9 = mockState();
  const tx1 = buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 10 });
  s9.queueTransaction(tx1);
  // After queue, the mempool entry has a txHash assigned by engine.
  // We can fetch the queued tx and use its hash to build a duplicate.
  const queuedTx = s9.transactions.mempool[0];
  assert('queued tx has txHash', typeof queuedTx.txHash === 'string');
  // Try to queue a tx with the same hash — should be deduped
  const dupResult = s9.queueTransaction({ ...queuedTx, txHash: queuedTx.txHash });
  assert('exact-hash dedup', !dupResult.success && dupResult.error.includes('duplicate'));
  assert('mempool size still 1', s9.transactions.mempool.length === 1);

  /* ─── Test 12: Compatibility with existing addBalance ─── */
  section('Test 12: Compatibility with existing addBalance');
  const s10 = mockState();
  s10.addBalance('addr-alice', 500);
  s10.subtractBalance('addr-bob', 100);
  assert('addBalance still works', s10.getBalance('addr-alice') === 1500n);
  assert('subtractBalance still works', s10.getBalance('addr-bob') === 400n);
  assert('engine attached', typeof s10.queueTransaction === 'function');

  /* ─── Test 13: getBuilder dispatcher ─── */
  section('Test 13: getBuilder dispatcher');
  assert('getBuilder(TRANSFER) returns buildTransfer',
    getBuilder(TX_TYPE.TRANSFER) === buildTransfer);
  assert('getBuilder(UNKNOWN) returns null', getBuilder('UNKNOWN') === null);

  /* ─── Test 14: Mempool flush after apply ─── */
  section('Test 14: Mempool flush after apply');
  const s11 = mockState();
  const tx3 = buildTransfer({ from: 'addr-alice', to: 'addr-bob', amount: 10 });
  s11.queueTransaction(tx3);
  assert('mempool has 1', s11.transactions.mempool.length === 1);
  // Re-apply the same queued entry — engine matches by txHash
  const queued = s11.transactions.mempool[0];
  s11.applyTransaction(queued);
  assert('mempool empty after apply', s11.transactions.mempool.length === 0);
  assert('tx in history', s11.transactions.txHistory.length === 1);

  /* ─── Test 15: Performance (1000 txs) ─── */
  section('Test 15: Performance (1000 batch txs)');
  const s12 = mockState();
  s12.applyTransaction(buildRegistrationMint({ to: 'addr-alice', amount: 1000000n, agentId: 'big' }));
  const bigBatch = [];
  for (let i = 0; i < 1000; i++) {
    bigBatch.push(buildTransfer({
      from: 'addr-alice',
      to: 'addr-bob',
      amount: 1,
      blockHeight: 1000 + i
    }));
  }
  const t0 = Date.now();
  const r2 = s12.applyTransactions(2000, bigBatch);
  const t1 = Date.now();
  assert('1000 txs applied', r2.applied === 1000);
  assert('1000 txs in < 2s', t1 - t0 < 2000, `took ${t1 - t0}ms`);
  assert('history has 1001', s12.transactions.txHistory.length === 1001);

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
