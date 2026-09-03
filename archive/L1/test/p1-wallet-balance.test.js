#!/usr/bin/env node
/**
 * P1-3: Wallet API confirmedBalance vs pendingBalance 测试
 *
 * 模拟 walletApi.js 中 /balance/:address 的行为：
 * - confirmedBalance = 链上余额（state.getBalance）
 * - pendingBalance = walletManager 本地余额（可能包含未上链的任务奖励）
 * - balance = max(confirmed, pending)
 *
 * 运行: node test/p1-wallet-balance.test.js
 */

// ─── 模拟 formatNgen（与 walletApi.js 逻辑一致） ───
const NGEN_DECIMALS = 8;
function formatNgen(raw) {
  return Number(raw) / Math.pow(10, NGEN_DECIMALS);
}

// ─── 模拟 balance endpoint 核心逻辑 ───
function getBalanceResponse(address, state, agentWalletManager) {
  const onChainRaw = state?.getBalance?.(address);
  const confirmedBalance = formatNgen(onChainRaw || 0);

  let pendingBalance = 0;
  let agentId = null;
  let nonce = undefined;
  const walletAgentId = agentWalletManager?.getAgentByAddress(address);
  if (walletAgentId) {
    const balanceResult = agentWalletManager.getBalance(walletAgentId);
    if (balanceResult.success) {
      agentId = walletAgentId;
      pendingBalance = balanceResult.balance;
      nonce = balanceResult.nonce;
    }
  }

  const balance = Math.max(confirmedBalance, pendingBalance);
  const source = (onChainRaw !== undefined && onChainRaw !== null && onChainRaw !== 0)
    ? 'blockchain'
    : (pendingBalance > 0 ? 'agent_wallet_manager' : (state ? 'blockchain' : 'default'));

  return {
    success: true,
    wallet: {
      address,
      balance,
      confirmedBalance,
      pendingBalance,
      source,
      ...(agentId ? { agentId } : {}),
      ...(nonce !== undefined ? { nonce } : {})
    }
  };
}

// ─── 测试框架 ───
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║   P1-3: Wallet API — confirmedBalance vs pendingBalance ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 1: 链上余额 = 900 (已确认)，walletManager 余额 = 10900 (含未上链奖励)
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 1] On-chain confirmed, walletManager has pending rewards');

const mockState1 = {
  getBalance: (addr) => (addr === 'ng1_early_bird' ? 90000000000n : undefined)
  // 900 * 10^8 = 900.00000000 NGEN on-chain
};

const mockWalletManager1 = {
  getAgentByAddress: (addr) => (addr === 'ng1_early_bird' ? 'agent_01' : null),
  getBalance: (agentId) => ({
    success: true,
    balance: 10900, // walletManager 有 10900（含 10000 未上链奖励）
    nonce: 5
  })
};

const result1 = getBalanceResponse('ng1_early_bird', mockState1, mockWalletManager1);
console.log(`  Response: ${JSON.stringify(result1.wallet, null, 2)}`);
assert(result1.wallet.confirmedBalance === 900, 'confirmedBalance = 900 (on-chain)');
assert(result1.wallet.pendingBalance === 10900, 'pendingBalance = 10900 (walletManager)');
assert(result1.wallet.balance === 10900, 'display balance = max(900, 10900) = 10900');
assert(result1.wallet.source === 'blockchain', 'source = blockchain');
assert(result1.wallet.agentId === 'agent_01', 'agentId present');
assert(result1.wallet.nonce === 5, 'nonce present');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 2: 链上余额 = 10900，walletManager = 10900（已同步）
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 2] Fully synced — both on-chain and walletManager = 10900');

const mockState2 = {
  getBalance: (addr) => (addr === 'ng1_synced' ? 1090000000000n : undefined)
  // 10900 * 10^8 = 10900.00000000 NGEN
};

const mockWalletManager2 = {
  getAgentByAddress: (addr) => (addr === 'ng1_synced' ? 'agent_02' : null),
  getBalance: (agentId) => ({
    success: true,
    balance: 10900,
    nonce: 10
  })
};

const result2 = getBalanceResponse('ng1_synced', mockState2, mockWalletManager2);
console.log(`  Response: ${JSON.stringify(result2.wallet, null, 2)}`);
assert(result2.wallet.confirmedBalance === 10900, 'confirmedBalance = 10900');
assert(result2.wallet.pendingBalance === 10900, 'pendingBalance = 10900');
assert(result2.wallet.balance === 10900, 'display balance = 10900');
assert(result2.wallet.source === 'blockchain', 'source = blockchain');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 3: 链上 = 0，walletManager = 1000（新注册未上链）
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 3] New agent — walletManager has balance, chain not yet');

const mockState3 = {
  getBalance: (addr) => 0 // on-chain returns 0
};

const mockWalletManager3 = {
  getAgentByAddress: (addr) => (addr === 'ng1_new' ? 'agent_03' : null),
  getBalance: (agentId) => ({
    success: true,
    balance: 1000,
    nonce: 1
  })
};

const result3 = getBalanceResponse('ng1_new', mockState3, mockWalletManager3);
console.log(`  Response: ${JSON.stringify(result3.wallet, null, 2)}`);
assert(result3.wallet.confirmedBalance === 0, 'confirmedBalance = 0');
assert(result3.wallet.pendingBalance === 1000, 'pendingBalance = 1000');
assert(result3.wallet.balance === 1000, 'display balance = 1000');
assert(result3.wallet.source === 'agent_wallet_manager', 'source = agent_wallet_manager');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 4: 链上 = 0，walletManager 也没有（未知地址）
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 4] Unknown address — both sources return 0');

const mockState4 = {
  getBalance: (addr) => 0
};

const mockWalletManager4 = {
  getAgentByAddress: (addr) => null
};

const result4 = getBalanceResponse('ng1_unknown', mockState4, mockWalletManager4);
console.log(`  Response: ${JSON.stringify(result4.wallet, null, 2)}`);
assert(result4.wallet.confirmedBalance === 0, 'confirmedBalance = 0');
assert(result4.wallet.pendingBalance === 0, 'pendingBalance = 0');
assert(result4.wallet.balance === 0, 'display balance = 0');
assert(result4.wallet.source === 'blockchain', 'source = blockchain (state exists)');
assert(!result4.wallet.agentId, 'no agentId');
assert(!result4.wallet.nonce, 'no nonce');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 5: 链上余额 > walletManager 余额（任务奖励后已上链，walletManager 未同步）
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 5] On-chain > walletManager (chain ahead)');

const mockState5 = {
  getBalance: (addr) => (addr === 'ng1_rich' ? 500000000000n : undefined)
  // 5000 * 10^8 = 5000 NGEN
};

const mockWalletManager5 = {
  getAgentByAddress: (addr) => (addr === 'ng1_rich' ? 'agent_05' : null),
  getBalance: (agentId) => ({
    success: true,
    balance: 1000,
    nonce: 3
  })
};

const result5 = getBalanceResponse('ng1_rich', mockState5, mockWalletManager5);
console.log(`  Response: ${JSON.stringify(result5.wallet, null, 2)}`);
assert(result5.wallet.confirmedBalance === 5000, 'confirmedBalance = 5000 (on-chain)');
assert(result5.wallet.pendingBalance === 1000, 'pendingBalance = 1000 (walletManager stale)');
assert(result5.wallet.balance === 5000, 'display balance = max(5000, 1000) = 5000');
assert(result5.wallet.source === 'blockchain', 'source = blockchain');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 6: state 不存在（null），walletManager 也无
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 6] No state object at all');

const result6 = getBalanceResponse('ng1_ghost', null, null);
console.log(`  Response: ${JSON.stringify(result6.wallet, null, 2)}`);
assert(result6.wallet.confirmedBalance === 0, 'confirmedBalance = 0');
assert(result6.wallet.balance === 0, 'display balance = 0');
assert(result6.wallet.source === 'default', 'source = default');
console.log('');

// ═══════════════════════════════════════════════════════════
// Scenario 7: formatNgen 精度测试
// ═══════════════════════════════════════════════════════════
console.log('[Scenario 7] formatNgen precision');

assert(formatNgen(0) === 0, '0 -> 0');
assert(formatNgen(100000000) === 1, '100000000 -> 1.0 NGEN');
assert(formatNgen(1090000000000) === 10900, '1090000000000 -> 10900 NGEN');
assert(formatNgen(90000000000) === 900, '90000000000 -> 900 NGEN');
assert(formatNgen(1) === 0.00000001, '1 satoshi -> 0.00000001 NGEN');
console.log('');

// ─── 统计 ───
console.log('╔══════════════════════════════════════════════════════════╗');
console.log(`║   Results: ${passed} passed, ${failed} failed                              ║`);
console.log('╚══════════════════════════════════════════════════════════╝');

if (failed > 0) {
  console.log('');
  console.log('⚠  Some tests FAILED — check output above.');
  process.exit(1);
} else {
  console.log('');
  console.log('✓ All P1-3 wallet balance tests PASSED.');
  console.log('');
  console.log('Key improvements:');
  console.log('  - confirmedBalance: use for "can I spend this?" checks');
  console.log('  - pendingBalance: shows walletManager state (may include unconfirmed rewards)');
  console.log('  - balance: max(confirmed, pending) for display');
  console.log('  - source: indicates which ledger provided the display balance');
}