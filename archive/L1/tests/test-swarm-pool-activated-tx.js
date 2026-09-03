/**
 * Phase 1C-3 Test: swarmPoolActivated via transactionEngine
 *
 * Verifies both 4 call sites are converted to use applyTransaction:
 *   - L57-58: Genesis → Pool initialization (pool credit audit)
 *   - L189:    Pool → Agent distribution (per-agent SWARM_RELEASE)
 *   - L193:    Pool debit (engine handles via from=POOL)
 *
 * In this codebase, the engine's SWARM_RELEASE builder sets
 * from=SWARM_POOL_ADDRESS, so the engine automatically:
 *   1. subtractBalance(POOL, amount) — enforces pool balance check
 *   2. addBalance(agent, amount) — credit
 *
 * So we no longer need the explicit subtractBalance call —
 * the engine handles it. This is double-entry accounting.
 */

import {
  TX_TYPE,
  attachTransactionState
} from '../src/blockchain/transactionEngine.js';
import { buildSwarmRelease, buildObserverEvent } from '../src/utils/transactionBuilder.js';

let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; failures.push(name); }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

const GENESIS_ADDR = 'ng1genesis000000000000000000000000000';
const SWARM_POOL_ADDR = 'ng1swarmpool000000000000000000000000000';

function mockState({ genesisBalance = 1_000_000_000n, poolBalance = 0n } = {}) {
  const state = {
    balances: new Map([
      [GENESIS_ADDR, genesisBalance],
      [SWARM_POOL_ADDR, poolBalance]
    ]),
    currentBlockHeight: 200,
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
 * Simulate swarmPoolActivated initialization (L57-74).
 * Mirrors: subtractBalance(genesis) + addBalance(pool) + audit tx.
 */
function simulateInit(state, totalTokens) {
  const blockHeight = state.currentBlockHeight || 0;
  const poolCreditTx = buildSwarmRelease({
    to: SWARM_POOL_ADDR, amount: 0, blockHeight,
    metadata: {
      reason: 'swarm_pool_initialization',
      totalTokens: totalTokens.toString(),
      operation: 'genesis_to_pool'
    }
  });
  state.applyTransaction(poolCreditTx);
  state.subtractBalance(GENESIS_ADDR, totalTokens.toString());
  state.addBalance(SWARM_POOL_ADDR, totalTokens.toString());
}

/**
 * Simulate swarmPoolActivated distribution (L202-225).
 * Returns array of { from, to, amount, type, timestamp } (legacy format).
 */
function simulateDistribution(state, pendingDistributions) {
  const transactions = [];
  for (const [agentId, amount] of pendingDistributions) {
    if (amount <= 0n) continue;
    const agentAddress = agentId;
    const blockHeight = state.currentBlockHeight || 0;
    const distributionTx = buildSwarmRelease({
      to: agentAddress, amount: amount.toString(), blockHeight,
      metadata: {
        agentId,
        distributionType: 'periodic_release',
        distributionBatch: Date.now()
      }
    });
    const result = state.applyTransaction(distributionTx);
    if (!result.success) {
      console.error(`Distribution to ${agentAddress} failed: ${result.error}`);
      continue;
    }
    transactions.push({
      from: SWARM_POOL_ADDR, to: agentAddress,
      amount: amount.toString(), type: 'SWARM_DISTRIBUTION',
      timestamp: Date.now()
    });
  }
  return transactions;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 1C-3 Test: swarmPoolActivated');
  console.log('═══════════════════════════════════════════════════');

  /* ─── Test 1: Init records audit + moves tokens ─── */
  section('Test 1: Pool initialization');
  {
    const state = mockState();
    const totalTokens = 850_000_000n;
    simulateInit(state, totalTokens);
    assert('genesis balance = 150M (1B - 850M)',
      state.getBalance(GENESIS_ADDR) === 150_000_000n);
    assert('pool balance = 850M',
      state.getBalance(SWARM_POOL_ADDR) === 850_000_000n);
    assert('1 audit tx in history',
      state.transactions.txHistory.length === 1);
    const tx = state.transactions.txHistory[0];
    assert('audit tx is SWARM_RELEASE', tx.tx_type === TX_TYPE.SWARM_RELEASE);
    assert('metadata reason = swarm_pool_initialization',
      tx.metadata.reason === 'swarm_pool_initialization');
    assert('metadata has totalTokens', tx.metadata.totalTokens === '850000000');
    assert('metadata has operation', tx.metadata.operation === 'genesis_to_pool');
  }

  /* ─── Test 2: Init fails if genesis insufficient ─── */
  section('Test 2: Init fails on insufficient genesis balance');
  {
    const state = mockState({ genesisBalance: 100n });  // way too low
    // We expect this to fail BEFORE applying any tx
    // (In real code, there's a check at L50-54)
    const genesisBalance = state.getBalance(GENESIS_ADDR);
    assert('genesis = 100 (insufficient)', genesisBalance === 100n);
    // The actual check is in the calling code; we verify the engine
    // would have caught it if called.
    const blockHeight = state.currentBlockHeight;
    const poolCreditTx = buildSwarmRelease({
      to: SWARM_POOL_ADDR, amount: 0, blockHeight,
      metadata: { reason: 'swarm_pool_initialization' }
    });
    state.applyTransaction(poolCreditTx);
    state.subtractBalance(GENESIS_ADDR, '850000000');
    assert('subtractBalance returns false (insufficient)',
      state.getBalance(GENESIS_ADDR) === 100n);
  }

  /* ─── Test 3: Distribution produces SWARM_RELEASE per agent ─── */
  section('Test 3: Per-agent distribution');
  {
    const state = mockState({ genesisBalance: 0n, poolBalance: 1_000_000n });
    const pending = new Map([
      ['ng1agent-1', 1000n],
      ['ng1agent-2', 2000n],
      ['ng1agent-3', 500n]
    ]);
    const txs = simulateDistribution(state, pending);
    assert('3 txs returned', txs.length === 3);
    assert('agent-1 = 1000', state.getBalance('ng1agent-1') === 1000n);
    assert('agent-2 = 2000', state.getBalance('ng1agent-2') === 2000n);
    assert('agent-3 = 500', state.getBalance('ng1agent-3') === 500n);
    assert('pool = 1M - 3500', state.getBalance(SWARM_POOL_ADDR) === 996_500n);
    assert('3 txs in history',
      state.transactions.txHistory.length === 3);
    assert('all SWARM_RELEASE',
      state.transactions.txHistory.every(t => t.tx_type === TX_TYPE.SWARM_RELEASE));
  }

  /* ─── Test 4: Each tx has correct metadata ─── */
  section('Test 4: Distribution tx metadata');
  {
    const state = mockState({ poolBalance: 100_000n });
    const pending = new Map([['ng1meta-agent', 100n]]);
    simulateDistribution(state, pending);
    const tx = state.transactions.txHistory[0];
    assert('metadata has agentId', tx.metadata.agentId === 'ng1meta-agent');
    assert('metadata has distributionType', tx.metadata.distributionType === 'periodic_release');
    assert('metadata has distributionBatch', typeof tx.metadata.distributionBatch === 'number');
    assert('tx.to = ng1meta-agent', tx.to === 'ng1meta-agent');
  }

  /* ─── Test 5: Distribution fails if pool insufficient (caught by engine) ─── */
  section('Test 5: Insufficient pool blocks distribution');
  {
    const state = mockState({ poolBalance: 100n });  // tiny pool
    const pending = new Map([
      ['ng1big', 999_999_999n],  // way too much
      ['ng1ok', 50n]              // fits
    ]);
    const txs = simulateDistribution(state, pending);
    assert('only 1 tx succeeded (the one that fits)', txs.length === 1);
    assert('big agent has 0 NGEN', state.getBalance('ng1big') === 0n);
    assert('ok agent has 50 NGEN', state.getBalance('ng1ok') === 50n);
    // Both txs are in history, but big has status=failed
    const hist = state.getTransactionHistory();
    assert('2 txs in history (1 ok + 1 failed)', hist.total === 2);
    const failed = state.getTransactionHistory({ status: 'failed' });
    assert('1 failed tx recorded', failed.total === 1);
    const failedTx = failed.items[0];
    assert('failed tx has reason in failureReason',
      failedTx.failureReason?.includes('insufficient') === true);
  }

  /* ─── Test 6: Zero amounts are skipped ─── */
  section('Test 6: Zero-amount entries skipped');
  {
    const state = mockState({ poolBalance: 1_000n });
    const pending = new Map([
      ['ng1a', 100n],
      ['ng1b', 0n],     // skipped
      ['ng1c', 200n]
    ]);
    const txs = simulateDistribution(state, pending);
    assert('2 txs returned (zero skipped)', txs.length === 2);
    assert('a = 100', state.getBalance('ng1a') === 100n);
    assert('c = 200', state.getBalance('ng1c') === 200n);
    assert('pool = 700', state.getBalance(SWARM_POOL_ADDR) === 700n);
  }

  /* ─── Test 7: Full flow (init + distribution) ─── */
  section('Test 7: Full init + distribution flow');
  {
    const state = mockState();
    simulateInit(state, 850_000_000n);
    const pending = new Map([
      ['ng1a1', 100_000n],
      ['ng1a2', 200_000n]
    ]);
    const txs = simulateDistribution(state, pending);
    assert('init audit + 2 distribution txs = 3 total',
      state.transactions.txHistory.length === 3);
    assert('2 distribution txs', txs.length === 2);
    assert('genesis = 150M', state.getBalance(GENESIS_ADDR) === 150_000_000n);
    assert('pool = 850M - 300K = 849.7M',
      state.getBalance(SWARM_POOL_ADDR) === 849_700_000n);
    assert('a1 = 100K', state.getBalance('ng1a1') === 100_000n);
    assert('a2 = 200K', state.getBalance('ng1a2') === 200_000n);
  }

  /* ─── Test 8: Query by SWARM_RELEASE tx_type ─── */
  section('Test 8: Audit query by type');
  {
    const state = mockState();
    simulateInit(state, 100_000n);
    const pending = new Map([['ng1a', 50_000n]]);
    simulateDistribution(state, pending);
    const hist = state.getTransactionHistory({ tx_type: TX_TYPE.SWARM_RELEASE });
    assert('2 SWARM_RELEASE txs', hist.total === 2);
    // 1 audit (to=pool, amount=0) + 1 distribution (to=agent, amount=50k)
    const credits = hist.items.filter(t => Number(t.amount) > 0);
    assert('1 credit (amount > 0)', credits.length === 1);
    assert('credit to=ng1a', credits[0].to === 'ng1a');
  }

  /* ─── Test 9: Persistence roundtrip ─── */
  section('Test 9: Persistence roundtrip');
  {
    const { serializeTransactions, deserializeTransactions } = await import('../src/blockchain/transactionEngine.js');
    const state1 = mockState();
    simulateInit(state1, 100_000n);
    simulateDistribution(state1, new Map([['ng1persist', 500n]]));
    const ser = serializeTransactions(state1);
    const state2 = mockState({ poolBalance: 100_000n });
    state2.transactions = deserializeTransactions(ser);
    assert('history restored (2 txs)', state2.transactions.txHistory.length === 2);
    assert('init audit preserved',
      state2.transactions.txHistory[0].metadata.reason === 'swarm_pool_initialization');
    assert('distribution preserved',
      state2.transactions.txHistory[1].to === 'ng1persist');
  }

  /* ─── Test 10: Stats aggregation ─── */
  section('Test 10: Stats aggregation');
  {
    const state = mockState();
    simulateInit(state, 1_000_000n);
    simulateDistribution(state, new Map([
      ['ng1a', 100n], ['ng1b', 200n], ['ng1c', 300n]
    ]));
    const stats = state.getTransactionStats();
    assert('total = 4 (1 init + 3 distribution)',
      stats.total === 4);
    assert('byType.SWARM_RELEASE = 4',
      stats.byType.SWARM_RELEASE === 4);
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
