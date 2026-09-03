/**
 * Phase 1C-2 Test: swarmPool fallback distribution via transactionEngine
 *
 * Verifies the fallback path (when genesisNode is not ready) now uses
 * transactionEngine.applyTransaction for full audit trail.
 *
 * 2 call sites covered:
 *   - _blockchainState.addBalance(agentAddress, amount)  → buildSwarmRelease credit
 *   - _blockchainState.addBalance(SWARM_POOL_ADDRESS, -amount)  → buildSwarmRelease debit placeholder
 */

import {
  TX_TYPE,
  attachTransactionState
} from '../src/blockchain/transactionEngine.js';
import { buildSwarmRelease } from '../src/utils/transactionBuilder.js';

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; failures.push(name); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

const SWARM_POOL_ADDRESS = 'ng1swarmpool000000000000000000000000000';

function mockState() {
  const state = {
    balances: new Map([
      [SWARM_POOL_ADDRESS, 100_000n]  // pool has 100k
    ]),
    currentBlockHeight: 500,
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
 * Simulate swarmPool fallback distribution.
 * Mirrors the logic in src/economy/swarmPool.js:135-145.
 */
function simulateFallback(state, { agentAddress, amount, distributionId, agentId, tx }) {
  const currentBlock = state.currentBlockHeight || 0;
  // Withdraw from pool (placeholder, no balance change)
  const withdrawTx = buildSwarmRelease({
    to: SWARM_POOL_ADDRESS, amount: 0, blockHeight: currentBlock,
    metadata: { reason: 'pool_debit_placeholder', distributionId, agentId }
  });
  // Credit agent
  const creditTx = buildSwarmRelease({
    to: agentAddress, amount, blockHeight: currentBlock,
    metadata: { distributionId, agentId, txId: tx.id, fallback: true }
  });
  const wRes = state.applyTransaction(withdrawTx);
  const cRes = state.applyTransaction(creditTx);
  return { wRes, cRes, withdrawTx, creditTx };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 1C-2 Test: swarmPool fallback distribution');
  console.log('═══════════════════════════════════════════════════');

  /* ─── Test 1: Single distribution produces 2 txs (debit + credit) ─── */
  section('Test 1: Single distribution produces 2 txs');
  {
    const state = mockState();
    const r = simulateFallback(state, {
      agentAddress: 'ng1agent-aaa', amount: 1000,
      distributionId: 'd-001', agentId: 'agent-001',
      tx: { id: 'tx-001' }
    });
    assert('withdraw tx succeeded', r.wRes.success);
    assert('credit tx succeeded', r.cRes.success);
    assert('agent has 1000 NGEN', state.getBalance('ng1agent-aaa') === 1000n);
    assert('2 txs in history', state.transactions.txHistory.length === 2);
    assert('both txs are SWARM_RELEASE',
      state.transactions.txHistory.every(tx => tx.tx_type === TX_TYPE.SWARM_RELEASE));
  }

  /* ─── Test 2: Multiple distributions to different agents ─── */
  section('Test 2: Multiple distributions');
  {
    const state = mockState();
    for (let i = 0; i < 5; i++) {
      simulateFallback(state, {
        agentAddress: `ng1agent-${i}`, amount: 100 * (i + 1),
        distributionId: `d-${i}`, agentId: `agent-${i}`,
        tx: { id: `tx-${i}` }
      });
    }
    assert('agent-0 has 100', state.getBalance('ng1agent-0') === 100n);
    assert('agent-4 has 500', state.getBalance('ng1agent-4') === 500n);
    assert('10 txs in history (2 per distribution)',
      state.transactions.txHistory.length === 10);
  }

  /* ─── Test 3: Each tx has correct metadata ─── */
  section('Test 3: Tx metadata correct');
  {
    const state = mockState();
    simulateFallback(state, {
      agentAddress: 'ng1agent', amount: 500,
      distributionId: 'd-meta', agentId: 'agent-meta',
      tx: { id: 'tx-meta' }
    });
    const creditTx = state.transactions.txHistory[1]; // second is credit
    assert('credit metadata has distributionId', creditTx.metadata.distributionId === 'd-meta');
    assert('credit metadata has agentId', creditTx.metadata.agentId === 'agent-meta');
    assert('credit metadata fallback=true', creditTx.metadata.fallback === true);
    assert('credit metadata has original txId', creditTx.metadata.txId === 'tx-meta');

    const withdrawTx = state.transactions.txHistory[0];
    assert('withdraw has pool_debit_placeholder', withdrawTx.metadata.reason === 'pool_debit_placeholder');
  }

  /* ─── Test 4: Queryable by agent address ─── */
  section('Test 4: Queryable by agent address');
  {
    const state = mockState();
    simulateFallback(state, {
      agentAddress: 'ng1target', amount: 100,
      distributionId: 'd-q1', agentId: 'agent-q1', tx: { id: 't1' }
    });
    simulateFallback(state, {
      agentAddress: 'ng1other', amount: 200,
      distributionId: 'd-q2', agentId: 'agent-q2', tx: { id: 't2' }
    });
    const targetHistory = state.getTransactionHistory({ address: 'ng1target' });
    assert('target has 1 SWARM_RELEASE credit', targetHistory.total === 1);
    assert('history filtered by SWARM_RELEASE',
      targetHistory.items.every(tx => tx.tx_type === TX_TYPE.SWARM_RELEASE));
  }

  /* ─── Test 5: Filter by distributionId via metadata ─── */
  section('Test 5: Distribution-level audit');
  {
    const state = mockState();
    // Pool starts with 100k — sufficient for 100+200+300 = 600
    simulateFallback(state, {
      agentAddress: 'ng1a', amount: 100,
      distributionId: 'DIST-A', agentId: 'a', tx: { id: 't1' }
    });
    simulateFallback(state, {
      agentAddress: 'ng1b', amount: 200,
      distributionId: 'DIST-B', agentId: 'b', tx: { id: 't2' }
    });
    simulateFallback(state, {
      agentAddress: 'ng1c', amount: 300,
      distributionId: 'DIST-A', agentId: 'c', tx: { id: 't3' }
    });
    // Filter to DIST-A credits only (amount > 0)
    const all = state.getTransactionHistory({ tx_type: TX_TYPE.SWARM_RELEASE });
    const distACredits = all.items.filter(
      tx => tx.metadata.distributionId === 'DIST-A' && Number(tx.amount) > 0
    );
    assert('DIST-A has 2 credit txs', distACredits.length === 2);
    assert('DIST-A agents: ng1a and ng1c',
      distACredits.every(tx => tx.to === 'ng1a' || tx.to === 'ng1c'));
    assert('DIST-B has 1 credit tx',
      all.items.filter(tx => tx.metadata.distributionId === 'DIST-B' && Number(tx.amount) > 0).length === 1);
  }

  /* ─── Test 6: No regression on legacy path ─── */
  section('Test 6: Legacy addBalance still works (ultimate fallback)');
  {
    const state = mockState();
    // Simulate the "ultimate fallback" path
    state.addBalance('ng1legacy', 100);
    state.addBalance(SWARM_POOL_ADDRESS, -100);
    assert('legacy credit works', state.getBalance('ng1legacy') === 100n);
    assert('no tx created by legacy path',
      state.transactions.txHistory.length === 0);
  }

  /* ─── Test 7: blockHeight preserved ─── */
  section('Test 7: blockHeight preserved');
  {
    const state = mockState();
    state.currentBlockHeight = 9999;
    const r = simulateFallback(state, {
      agentAddress: 'ng1bh', amount: 50,
      distributionId: 'd-bh', agentId: 'a', tx: { id: 't' }
    });
    assert('withdraw tx has blockHeight 9999',
      state.transactions.txHistory[0].blockHeight === 9999);
    assert('credit tx has blockHeight 9999',
      state.transactions.txHistory[1].blockHeight === 9999);
  }

  /* ─── Test 8: Stats include swarm releases ─── */
  section('Test 8: Stats aggregation');
  {
    const state = mockState();
    for (let i = 0; i < 3; i++) {
      simulateFallback(state, {
        agentAddress: `ng1a${i}`, amount: 100 + i,
        distributionId: `d${i}`, agentId: `a${i}`, tx: { id: `t${i}` }
      });
    }
    const stats = state.getTransactionStats();
    assert('stats total = 6 (2 per loop)', stats.total === 6);
    assert('byType.SWARM_RELEASE = 6', stats.byType.SWARM_RELEASE === 6);
  }

  /* ─── Test 9: Persistence roundtrip ─── */
  section('Test 9: Persistence roundtrip');
  {
    const { serializeTransactions, deserializeTransactions } = await import('../src/blockchain/transactionEngine.js');
    const state1 = mockState();
    simulateFallback(state1, {
      agentAddress: 'ng1persist', amount: 777,
      distributionId: 'd-p', agentId: 'a-p', tx: { id: 't-p' }
    });
    const ser = serializeTransactions(state1);
    const state2 = mockState();
    state2.transactions = deserializeTransactions(ser);
    assert('history restored (2 txs)', state2.transactions.txHistory.length === 2);
    const credit = state2.transactions.txHistory[1];
    assert('restored credit has amount 777', credit.amount === '777');
    assert('restored credit is SWARM_RELEASE', credit.tx_type === TX_TYPE.SWARM_RELEASE);
  }

  /* ─── Test 10: Failure handling (insufficient pool balance) ─── */
  section('Test 10: Failure handling — insufficient pool balance');
  {
    // The SWARM_RELEASE builder sets from=SWARM_POOL_ADDRESS.
    // The engine's applyBalanceEffect calls subtractBalance(from, amount)
    // before addBalance(to, amount). So if pool has insufficient balance,
    // the credit tx will FAIL — this is the correct double-entry behavior.
    const state = mockState();
    const r = simulateFallback(state, {
      agentAddress: 'ng1big', amount: 999_999_999,  // way more than pool (100k)
      distributionId: 'd-fail', agentId: 'a-fail', tx: { id: 't-fail' }
    });
    // Withdraw tx (amount=0) always succeeds
    assert('withdraw tx succeeded (amount=0)',
      r.wRes.success === true);
    // Credit tx FAILS due to insufficient pool balance
    assert('credit tx FAILED (insufficient pool)',
      r.cRes.success === false);
    assert('error mentions insufficient balance',
      r.cRes.error?.includes('insufficient') === true);
    // No balance change
    assert('agent has 0 NGEN (failed credit)', state.getBalance('ng1big') === 0n);
    // Failed tx still recorded
    const failed = state.getTransactionHistory({ status: 'failed' });
    assert('failed tx in history', failed.total === 1);
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
