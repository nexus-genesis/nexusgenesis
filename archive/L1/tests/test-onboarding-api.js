/**
 * HTTP Integration Test: Onboarding API (Phase 2-A2)
 *
 * 覆盖:
 *   1. GET /api/v1/wallet/agent/:agentId/security-status
 *      - 404 for non-existent agent
 *      - 200 shape for existing agent
 *      - suggestedActions 字段仅在 needsAction=true 时出现
 *      - 余额/状态映射正确
 *   2. POST /api/v1/wallet/agent/:agentId/onboarding/complete
 *      - 401/403 没有 admin secret
 *      - 400 非法 method
 *      - 404 不存在的 agent
 *      - 200 + 4 种 method 各自落地
 *   3. Reward tx 触发钩子
 *      - applyTransaction 走 TASK_REWARD → state 余额 ≥ 100 → 触发
 *      - state 余额 < 100 → 不触发
 *      - 已是 terminal 状态 → 不再触发
 *   4. 端到端：reward 触发 → API 显示 pending → POST complete → API 显示 terminal
 *
 * Run: node tests/test-onboarding-api.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createServer } from 'http';
import walletApiRouter from '../src/http/routes/walletApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import {
  applyTransaction,
  isRewardTxType,
  TX_TYPE
} from '../src/blockchain/transactionEngine.js';

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}
function assertEq(name, actual, expected) {
  check(name, actual === expected, `expected=${expected} got=${actual}`);
}

async function http(method, p, body = null, headers = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

const TEST_AGENT = 'agent-OB-API-1';
const TEST_AGENT_2 = 'agent-OB-API-2';
const TEST_ADMIN_SECRET = 'onboarding-api-test-credit-secret-pad';
process.env.NG_ADMIN_CREDIT_SECRET = TEST_ADMIN_SECRET;
process.env.NODE_ENV = 'development';

let BASE;
let server;
let mockState;
let snapshots = new Map();

async function ensureAgent(id, initialBalance = 0n) {
  if (!agentWalletManager.registry.has(id)) {
    await agentWalletManager.createAgentWallet(id, { test: 'onboarding-api' }, initialBalance);
  }
  const entry = agentWalletManager.getRegistryEntry(id);
  const w = entry.wallet;
  snapshots.set(id, {
    balance: w.balance,
    nonce: w.nonce,
    onboarding: entry.onboarding ? { ...entry.onboarding } : null
  });
  return entry;
}

async function restoreAll() {
  for (const [id, snap] of snapshots) {
    const entry = agentWalletManager.getRegistryEntry(id);
    if (!entry) continue;
    entry.wallet.balance = snap.balance;
    entry.wallet.nonce = snap.nonce;
    entry.onboarding = snap.onboarding ? { ...snap.onboarding } : null;
  }
  agentWalletManager._saveRegistry();
}

function buildMockState(initialBalances = {}) {
  const txHistory = [];
  const byType = {};
  const byAddress = {};
  let txCount = 0;
  return {
    currentBlockHeight: 100,
    transactions: {
      get txHistory() { return txHistory; },
      set txHistory(v) { txHistory.length = 0; txHistory.push(...v); },
      get byType() { return byType; },
      get byAddress() { return byAddress; },
      get txCount() { return txCount; },
      set txCount(v) { txCount = v; },
      mempool: []
    },
    balances: { ...initialBalances },
    getBalance(addr) { return Number(this.balances[addr] ?? 0); },
    addBalance(addr, amount) {
      this.balances[addr] = (this.balances[addr] ?? 0) + Number(amount);
    },
    subtractBalance(addr, amount) {
      if ((this.balances[addr] ?? 0) < Number(amount)) return false;
      this.balances[addr] -= Number(amount);
      return true;
    },
    getAllTransactions() { return txHistory; }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('═══════════════════════════════════════════════════════════');
console.log('  Onboarding API + Reward Hook (Phase 2-A2)');
console.log('═══════════════════════════════════════════════════════════\n');

(async () => {
  try {
    // ─── 0. Setup ───────────────────────────────────────────────
    console.log('--- 0. Setup: 2 test agents + Express + mock state ---\n');
    const e1 = await ensureAgent(TEST_AGENT, 0n);
    const e2 = await ensureAgent(TEST_AGENT_2, 0n);
    check('TEST_AGENT created', e1 !== null);
    check('TEST_AGENT_2 created', e2 !== null);

    // Reset onboarding for both
    e1.onboarding = null;
    e2.onboarding = null;

    const senderAddr = e1.wallet.address;
    const recipientAddr = e2.wallet.address;

    mockState = buildMockState({
      [senderAddr]: 0,
      [recipientAddr]: 0
    });

    const app = express();
    app.use(express.json());
    app.locals.state = mockState;
    app.use('/api/v1/wallet', walletApiRouter);
    server = createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    BASE = `http://127.0.0.1:${port}`;
    check(`server listening on ${BASE}`, true);

    // ─── 1. GET security-status for non-existent agent ───────────
    console.log('\n--- 1. GET security-status: non-existent agent ---\n');
    const r404 = await http('GET', '/api/v1/wallet/agent/agent-DOES-NOT-EXIST/security-status');
    assertEq('returns 404', r404.status, 404);
    check('success = false', r404.body.success === false);

    // ─── 2. GET security-status for fresh agent (balance 0) ──────
    console.log('\n--- 2. GET security-status: fresh agent (balance=0) ---\n');
    // Update mock state to reflect 0 balance
    mockState.balances[recipientAddr] = 0;
    e2.wallet.balance = 0n;
    const r2 = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_2}/security-status`);
    assertEq('returns 200', r2.status, 200);
    check('success = true', r2.body.success === true);
    assertEq('agentId = TEST_AGENT_2', r2.body.agentId, TEST_AGENT_2);
    assertEq('needsOnboarding = false (balance 0)', r2.body.needsOnboarding, false);
    assertEq('status = null', r2.body.status, null);
    assertEq('isVirtual = false', r2.body.isVirtual, false);
    check('riskLevel = low', r2.body.riskLevel === 'low');
    check('suggestedActions = [] (not pending)', Array.isArray(r2.body.suggestedActions) && r2.body.suggestedActions.length === 0);

    // ─── 3. GET security-status: balance > threshold (virtual pending) ──
    console.log('\n--- 3. GET security-status: balance > threshold (virtual pending) ---\n');
    e2.wallet.balance = 500n;
    mockState.balances[recipientAddr] = 500;
    const r3 = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_2}/security-status`);
    assertEq('returns 200', r3.status, 200);
    assertEq('status = pending (virtual)', r3.body.status, 'pending');
    assertEq('isVirtual = true (not yet persisted)', r3.body.isVirtual, true);
    check('needsOnboarding = true', r3.body.needsAction === true || r3.body.needsOnboarding === true);
    check('suggestedActions has 3 items', r3.body.suggestedActions.length === 3);
    check('suggestedActions[0] is backup', r3.body.suggestedActions[0].method === 'backup');
    check('suggestedActions[2] is waive', r3.body.suggestedActions[2].method === 'waive');

    // ─── 4. POST onboarding/complete: no auth ────────────────────
    console.log('\n--- 4. POST onboarding/complete: no admin secret ---\n');
    const r4 = await http('POST', `/api/v1/wallet/agent/${TEST_AGENT_2}/onboarding/complete`, {
      method: 'backup'
    });
    // dev mode accepts bypass secret == credit secret; in test we set both
    // to TEST_ADMIN_SECRET. So without header, expect 403.
    assertEq('returns 403 (no auth)', r4.status, 403);
    check('error mentions admin secret', /admin/i.test(r4.body.error || ''));

    // ─── 5. POST onboarding/complete: invalid method ─────────────
    console.log('\n--- 5. POST onboarding/complete: invalid method ---\n');
    const r5 = await http('POST', `/api/v1/wallet/agent/${TEST_AGENT_2}/onboarding/complete`, {
      method: 'garbage_method'
    }, { 'x-admin-secret': TEST_ADMIN_SECRET });
    assertEq('returns 400', r5.status, 400);
    check('error mentions invalid', /invalid/i.test(r5.body.error || ''));

    // ─── 6. POST onboarding/complete: non-existent agent ─────────
    console.log('\n--- 6. POST onboarding/complete: non-existent agent ---\n');
    const r6 = await http('POST', '/api/v1/wallet/agent/agent-NONEXISTENT-XYZ/onboarding/complete', {
      method: 'backup'
    }, { 'x-admin-secret': TEST_ADMIN_SECRET });
    assertEq('returns 404', r6.status, 404);

    // ─── 7. POST onboarding/complete: valid (each method) ────────
    console.log('\n--- 7. POST onboarding/complete: 4 methods ---\n');
    for (const method of ['backup', 'transfer', 'hardware', 'waive']) {
      // Reset for each iteration: re-trigger pending first (in-memory only,
      // 让 handler 负责 save，避免连续多次 _saveRegistry 拖慢并触发资源压力)
      e2.onboarding = null;
      console.log(`  → requesting method=${method}...`);
      const r = await http('POST', `/api/v1/wallet/agent/${TEST_AGENT_2}/onboarding/complete`, {
        method
      }, { 'x-admin-secret': TEST_ADMIN_SECRET });
      console.log(`  ← got status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)}`);
      assertEq(`method=${method} status 200`, r.status, 200);
      assertEq(`method=${method} success`, r.body.success, true);
      const expectedStatus = {
        backup: 'backed_up',
        transfer: 'transferred_out',
        hardware: 'hardware_bound',
        waive: 'waived'
      }[method];
      assertEq(`method=${method} status`, r.body.status, expectedStatus);

      // Verify via GET security-status
      const check1 = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_2}/security-status`);
      assertEq(`GET status reflects ${method}`, check1.body.status, expectedStatus);
      check(`GET needsOnboarding = false (${method})`, check1.body.needsOnboarding === false);
      check(`GET suggestedActions = [] (${method})`, check1.body.suggestedActions.length === 0);
    }

    // ─── 8. Reward tx triggers onboarding ───────────────────────
    console.log('\n--- 8. Reward tx (TASK_REWARD) triggers onboarding ---\n');
    // Reset: e1 has balance 0, e2 is in terminal state. Create a fresh agent for reward tests.
    const REWARD_AGENT = 'agent-OB-API-REWARD';
    const eReward = await ensureAgent(REWARD_AGENT, 0n);
    eReward.onboarding = null;
    eReward.wallet.balance = 0n;
    const rewardAddr = eReward.wallet.address;
    mockState.balances[rewardAddr] = 0;

    // Apply a TASK_REWARD with state balance 50 (below threshold)
    const lowReward = applyTransaction(mockState, {
      tx_type: TX_TYPE.TASK_REWARD,
      from: 'null',
      to: rewardAddr,
      amount: 50
    });
    check('TASK_REWARD 50 succeeds', lowReward.success === true);
    await sleep(100);  // wait for setImmediate hook to fire
    let obNow = eReward.onboarding;
    check('onboarding still null after 50 (below threshold)', obNow === null);

    // Apply a TASK_REWARD that pushes state balance over 100
    const highReward = applyTransaction(mockState, {
      tx_type: TX_TYPE.TASK_REWARD,
      from: 'null',
      to: rewardAddr,
      amount: 60  // 50 + 60 = 110, crosses 100
    });
    check('TASK_REWARD 60 succeeds', highReward.success === true);
    await sleep(300);  // wait for setImmediate hook to fire (in-memory update)
    obNow = eReward.onboarding;
    check('onboarding = pending (after crossing threshold)', obNow !== null && obNow.status === 'pending');
    check('triggeredAt is set', typeof obNow?.triggeredAt === 'number' && obNow.triggeredAt > 0);

    // Verify via API (in-memory read, no disk save required for this assertion)
    const rReward = await http('GET', `/api/v1/wallet/agent/${REWARD_AGENT}/security-status`);
    assertEq('API shows status=pending after reward', rReward.body.status, 'pending');
    assertEq('API isVirtual = false (in-memory storedStatus)', rReward.body.isVirtual, false);

    // ─── 9. Reward tx to terminal agent does not re-trigger ──────
    console.log('\n--- 9. Reward tx to terminal agent: no re-trigger ---\n');
    const FIXED_TRIGGER_TIME = 1700000000000;  // 固定值便于精确比较
    eReward.onboarding = {
      status: 'backed_up',
      triggeredAt: FIXED_TRIGGER_TIME,
      completedAt: FIXED_TRIGGER_TIME + 500,
      method: 'backup'
    };
    agentWalletManager._saveRegistry();
    const noRetrigger = applyTransaction(mockState, {
      tx_type: TX_TYPE.BLOCK_REWARD,
      from: 'null',
      to: rewardAddr,
      amount: 10000  // big reward
    });
    check('BLOCK_REWARD succeeds', noRetrigger.success === true);
    await sleep(500);  // wait for hook to fire (no save because terminal status)
    obNow = eReward.onboarding;
    assertEq('status preserved as backed_up', obNow.status, 'backed_up');
    assertEq('triggeredAt unchanged', obNow.triggeredAt, FIXED_TRIGGER_TIME);
    // Persisted check (no async save was queued for terminal status, so file is unchanged)
    const savedEntry = JSON.parse(fs.readFileSync(path.join('data', 'wallets', 'agent_wallet_registry.json'), 'utf8'))
      .entries.find(e => e.agentId === REWARD_AGENT);
    check('persisted status = backed_up', savedEntry.onboarding.status === 'backed_up');
    assertEq('persisted triggeredAt = FIXED_TRIGGER_TIME', savedEntry.onboarding.triggeredAt, FIXED_TRIGGER_TIME);

    // ─── 10. End-to-end: reward → API pending → complete → API terminal ──
    console.log('\n--- 10. End-to-end flow ---\n');
    const E2E_AGENT = 'agent-OB-API-E2E';
    const eE2E = await ensureAgent(E2E_AGENT, 0n);
    eE2E.onboarding = null;
    eE2E.wallet.balance = 0n;
    const e2eAddr = eE2E.wallet.address;
    mockState.balances[e2eAddr] = 0;

    // Step a: apply reward
    applyTransaction(mockState, {
      tx_type: TX_TYPE.TASK_REWARD,
      from: 'null',
      to: e2eAddr,
      amount: 500
    });
    await sleep(100);

    // Step b: API shows pending
    const e2eS1 = await http('GET', `/api/v1/wallet/agent/${E2E_AGENT}/security-status`);
    assertEq('E2E step b: status=pending', e2eS1.body.status, 'pending');
    check('E2E step b: needsOnboarding=true', e2eS1.body.needsOnboarding === true);
    check('E2E step b: 3 suggested actions', e2eS1.body.suggestedActions.length === 3);

    // Step c: user picks "transfer" (transfer to hardware wallet)
    const e2eComplete = await http('POST', `/api/v1/wallet/agent/${E2E_AGENT}/onboarding/complete`, {
      method: 'transfer'
    }, { 'x-admin-secret': TEST_ADMIN_SECRET });
    assertEq('E2E step c: complete returns 200', e2eComplete.status, 200);
    assertEq('E2E step c: status=transferred_out', e2eComplete.body.status, 'transferred_out');

    // Step d: API now shows terminal
    const e2eS2 = await http('GET', `/api/v1/wallet/agent/${E2E_AGENT}/security-status`);
    assertEq('E2E step d: status=transferred_out', e2eS2.body.status, 'transferred_out');
    check('E2E step d: needsOnboarding=false', e2eS2.body.needsOnboarding === false);
    check('E2E step d: no suggested actions', e2eS2.body.suggestedActions.length === 0);

    // ─── 11. isRewardTxType function unit test ──────────────────
    console.log('\n--- 11. isRewardTxType utility ---\n');
    assertEq('TASK_REWARD is reward', isRewardTxType(TX_TYPE.TASK_REWARD), true);
    assertEq('BLOCK_REWARD is reward', isRewardTxType(TX_TYPE.BLOCK_REWARD), true);
    assertEq('REGISTRATION_MINT is reward', isRewardTxType(TX_TYPE.REGISTRATION_MINT), true);
    assertEq('GENESIS_UNLOCK is reward', isRewardTxType(TX_TYPE.GENESIS_UNLOCK), true);
    assertEq('TRANSFER is NOT reward', isRewardTxType(TX_TYPE.TRANSFER), false);
    assertEq('GOVERNANCE_VOTE is NOT reward', isRewardTxType(TX_TYPE.GOVERNANCE_VOTE), false);
    assertEq('CUSTODY_SIGN is NOT reward', isRewardTxType(TX_TYPE.CUSTODY_SIGN), false);
    assertEq('FEE_BURN is NOT reward', isRewardTxType(TX_TYPE.FEE_BURN), false);

  } catch (e) {
    console.error('\nFATAL:', e);
    failed++;
  } finally {
    console.log('\n--- Cleanup: restore test agents ---\n');
    await restoreAll();
    if (server) server.close();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    if (failed === 0) {
      console.log('  ✓ Onboarding API + reward hook works');
    } else {
      console.log('  ✗ Onboarding API has gaps — see failures above');
    }
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
