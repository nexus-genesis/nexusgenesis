/**
 * Phase 1C-1 Test: bootstrapApi admin credit
 *
 * Verifies:
 *   1. The credit endpoint produces an OBSERVER_EVENT tx in history
 *   2. Balance changes correctly
 *   3. Response includes txHash
 *   4. No regression: existing balance operations still work
 *   5. Persistence round-trip includes the audit event
 */

import {
  TX_TYPE,
  attachTransactionState
} from '../src/blockchain/transactionEngine.js';
import { buildObserverEvent } from '../src/utils/transactionBuilder.js';

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; failures.push(name); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function mockState() {
  const state = {
    balances: new Map(),
    currentBlockHeight: 100,
    cache: { lastCacheUpdate: 0 },
    changes: { balances: new Set() }
  };
  state.getBalance = (addr) => state.balances.get(addr) || 0n;
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

/**
 * Simulates the credit endpoint logic (extracted from bootstrapApi.js).
 */
function simulateCredit(state, { address, amount, reason }) {
  const before = state.getBalance(address);
  const blockHeight = state.currentBlockHeight || 0;
  const auditTx = buildObserverEvent({
    from: address,
    event: 'ADMIN_CREDIT',
    blockHeight,
    metadata: { amount, reason: reason || 'N/A', admin_action: true }
  });
  const auditResult = state.applyTransaction(auditTx);
  if (!auditResult.success) {
    return { success: false, error: auditResult.error };
  }
  state.addBalance(address, String(amount));
  const after = state.getBalance(address);
  return {
    success: true,
    address, amount, before, after, txHash: auditResult.txHash,
    auditEvent: 'ADMIN_CREDIT'
  };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 1C-1 Test: bootstrapApi admin credit');
  console.log('═══════════════════════════════════════════════════');

  /* ─── Test 1: Basic credit produces OBSERVER_EVENT ─── */
  section('Test 1: Basic credit produces OBSERVER_EVENT');
  {
    const state = mockState();
    const r = simulateCredit(state, {
      address: 'ng1abc123def4567890123456789012345678901234',
      amount: 1000, reason: 'bootstrap grant'
    });
    assert('credit succeeds', r.success);
    assert('response has txHash', typeof r.txHash === 'string' && r.txHash.startsWith('tx-'));
    assert('auditEvent = ADMIN_CREDIT', r.auditEvent === 'ADMIN_CREDIT');
    assert('balance went 0 → 1000', r.before === 0n && r.after === 1000n);
    assert('1 tx in history', state.transactions.txHistory.length === 1);
    assert('tx is OBSERVER_EVENT', state.transactions.txHistory[0].tx_type === TX_TYPE.OBSERVER_EVENT);
    assert('tx metadata has amount', state.transactions.txHistory[0].metadata.amount === 1000);
    assert('tx metadata has reason', state.transactions.txHistory[0].metadata.reason === 'bootstrap grant');
    assert('tx metadata admin_action=true', state.transactions.txHistory[0].metadata.admin_action === true);
  }

  /* ─── Test 2: Multiple credits accumulate ─── */
  section('Test 2: Multiple credits accumulate');
  {
    const state = mockState();
    simulateCredit(state, { address: 'ng1addr1', amount: 100, reason: 'first' });
    simulateCredit(state, { address: 'ng1addr1', amount: 200, reason: 'second' });
    simulateCredit(state, { address: 'ng1addr1', amount: 300, reason: 'third' });
    assert('balance = 600', state.getBalance('ng1addr1') === 600n);
    assert('3 txs in history', state.transactions.txHistory.length === 3);
    assert('all 3 are OBSERVER_EVENT',
      state.transactions.txHistory.every(tx => tx.tx_type === TX_TYPE.OBSERVER_EVENT));
  }

  /* ─── Test 3: Tx queryable by address ─── */
  section('Test 3: Audit trail queryable');
  {
    const state = mockState();
    simulateCredit(state, { address: 'ng1addr1', amount: 100, reason: 'r1' });
    simulateCredit(state, { address: 'ng1addr2', amount: 200, reason: 'r2' });
    const addr1History = state.getTransactionHistory({ address: 'ng1addr1' });
    assert('addr1 has 1 tx', addr1History.total === 1);
    assert('addr1 tx is OBSERVER_EVENT',
      addr1History.items[0].tx_type === TX_TYPE.OBSERVER_EVENT);
    const allObserver = state.getTransactionHistory({ tx_type: TX_TYPE.OBSERVER_EVENT });
    assert('2 OBSERVER_EVENT total', allObserver.total === 2);
  }

  /* ─── Test 4: Failure on invalid state ─── */
  section('Test 4: Failure on invalid state (no addBalance)');
  {
    // Mock the "State not available" path
    const state = null;
    let error = null;
    try {
      simulateCredit(state, { address: 'ng1a', amount: 1, reason: 'x' });
    } catch (e) {
      error = e.message;
    }
    assert('throws when state null', error !== null);
  }

  /* ─── Test 5: Persistence roundtrip preserves audit event ─── */
  section('Test 5: Persistence roundtrip');
  {
    const { serializeTransactions, deserializeTransactions } = await import('../src/blockchain/transactionEngine.js');
    const state1 = mockState();
    simulateCredit(state1, { address: 'ng1foo', amount: 500, reason: 'persist-test' });
    const ser = serializeTransactions(state1);
    const state2 = mockState();
    state2.transactions = deserializeTransactions(ser);
    assert('history restored', state2.transactions.txHistory.length === 1);
    const restoredTx = state2.transactions.txHistory[0];
    assert('restored tx is OBSERVER_EVENT', restoredTx.tx_type === TX_TYPE.OBSERVER_EVENT);
    assert('restored metadata preserved', restoredTx.metadata.amount === 500);
    assert('restored reason preserved', restoredTx.metadata.reason === 'persist-test');
  }

  /* ─── Test 6: Stats include admin credits ─── */
  section('Test 6: Stats aggregation');
  {
    const state = mockState();
    simulateCredit(state, { address: 'ng1a', amount: 100, reason: 'r1' });
    simulateCredit(state, { address: 'ng1b', amount: 200, reason: 'r2' });
    simulateCredit(state, { address: 'ng1a', amount: 50, reason: 'r3' });
    const stats = state.getTransactionStats();
    assert('total = 3', stats.total === 3);
    assert('byType.OBSERVER_EVENT = 3', stats.byType.OBSERVER_EVENT === 3);
    assert('topAddresses[0] = ng1a with 2 txs',
      stats.topAddresses[0]?.address === 'ng1a' && stats.topAddresses[0]?.count === 2);
  }

  /* ─── Test 7: No regression on low-level addBalance ─── */
  section('Test 7: No regression on addBalance');
  {
    const state = mockState();
    state.addBalance('ng1direct', 999);
    state.addBalance('ng1direct', 1);
    assert('addBalance still works', state.getBalance('ng1direct') === 1000n);
    // Engine attached (no errors)
    assert('engine attached', typeof state.applyTransaction === 'function');
    // Low-level addBalance does NOT create tx (intentional)
    assert('low-level addBalance does not create tx',
      state.transactions.txHistory.length === 0);
  }

  /* ─── Test 8: txHash is unique per credit ─── */
  section('Test 8: txHash uniqueness');
  {
    const state = mockState();
    const r1 = simulateCredit(state, { address: 'ng1a', amount: 100, reason: 'a' });
    const r2 = simulateCredit(state, { address: 'ng1a', amount: 100, reason: 'b' });
    const r3 = simulateCredit(state, { address: 'ng1a', amount: 100, reason: 'c' });
    const hashes = new Set([r1.txHash, r2.txHash, r3.txHash]);
    assert('all 3 txHashes are unique', hashes.size === 3);
  }

  /* ─── Test 9: blockHeight recorded correctly ─── */
  section('Test 9: blockHeight preserved');
  {
    const state = mockState();
    state.currentBlockHeight = 12345;
    const r = simulateCredit(state, { address: 'ng1a', amount: 100, reason: 'h' });
    assert('success', r.success);
    const tx = state.transactions.txHistory[0];
    assert('tx blockHeight = 12345', tx.blockHeight === 12345);
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
