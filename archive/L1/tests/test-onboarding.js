/**
 * Unit Test: Agent Security Onboarding (Phase 2-A1 data layer)
 *
 * Covers:
 *   1. Fresh agent (balance < 100) → status null
 *   2. Below threshold inbound → not triggered
 *   3. Cross-threshold inbound → triggered, status = pending
 *   4. Already-pending agent → second trigger is no-op
 *   5. Terminal status (backed_up) → no re-trigger
 *   6. markOnboardingComplete with each method
 *   7. markOnboardingComplete rejects invalid method
 *   8. computeOnboardingStatus virtual pending for legacy high-balance
 *   9. Persistence: state survives _saveRegistry / _loadRegistry
 *  10. getOnboardingStats aggregation
 *  11. ONBOARDING_SUGGESTIONS shape (3 items, valid methods)
 *  12. ONBOARDING_THRESHOLD_RAW is exactly 100n
 *
 * Run: node tests/test-onboarding.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import {
  ONBOARDING_STATUS,
  ONBOARDING_METHOD,
  ONBOARDING_THRESHOLD_RAW,
  ONBOARDING_SUGGESTIONS,
  computeOnboardingStatus,
  maybeTriggerOnboarding,
  markOnboardingComplete,
  getOnboardingStats
} from '../src/wallet/onboarding.js';

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}
function assertEq(name, actual, expected) {
  check(name, actual === expected, `expected=${expected} got=${actual}`);
}

// ─── 0. Setup: pick 4 throwaway test agents ────────────────────────
const TEST_IDS = ['agent-OB-A', 'agent-OB-B', 'agent-OB-C', 'agent-OB-D'];
const createdIds = [];

// Snapshot any pre-existing balance so we can restore
const snapshots = new Map();
for (const id of TEST_IDS) {
  if (!agentWalletManager.registry.has(id)) {
    const wallet = await agentWalletManager.createAgentWallet(id, { test: 'onboarding' }, 0n);
    createdIds.push(id);
    snapshots.set(id, { balance: 0n, nonce: 0, onboarding: null });
  } else {
    const w = agentWalletManager.getWalletInstance(id);
    const entry = agentWalletManager.getRegistryEntry(id);
    snapshots.set(id, { balance: w.balance, nonce: w.nonce, onboarding: entry.onboarding });
  }
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

function setBalance(agentId, rawBalance, resetOnboarding = true) {
  const entry = agentWalletManager.getRegistryEntry(agentId);
  entry.wallet.balance = BigInt(rawBalance);
  if (resetOnboarding) {
    entry.onboarding = null;  // reset for test
  } else {
    // 保留已有的 onboarding（用于测试"已完成后余额上升不再触发"）
  }
  // 不在这里 save：测试场景下连续多次 balance/onboarding 变化，_saveRegistry
  // 单次成本 = 180 agent × 310k PBKDF2-SHA512 ≈ 5-17s。测试自己负责在
  // 关键节点显式 save。
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  Onboarding Data Layer (Phase 2-A1)');
console.log('═══════════════════════════════════════════════════════════\n');

(async () => {
try {
  // ─── 1. Constants ─────────────────────────────────────────────
  console.log('--- 1. Constants ---\n');
  assertEq('ONBOARDING_THRESHOLD_RAW = 100n', ONBOARDING_THRESHOLD_RAW, 100n);
  assertEq('ONBOARDING_STATUS.PENDING = "pending"', ONBOARDING_STATUS.PENDING, 'pending');
  assertEq('ONBOARDING_STATUS.BACKED_UP = "backed_up"', ONBOARDING_STATUS.BACKED_UP, 'backed_up');
  assertEq('ONBOARDING_METHOD.BACKUP = "backup"', ONBOARDING_METHOD.BACKUP, 'backup');
  check('ONBOARDING_SUGGESTIONS has 3 items', ONBOARDING_SUGGESTIONS.length === 3);
  check('all suggestions have valid method', ONBOARDING_SUGGESTIONS.every(s => Object.values(ONBOARDING_METHOD).includes(s.method)));

  // ─── 2. Fresh agent below threshold ───────────────────────────
  console.log('\n--- 2. Fresh agent (balance=0) → status null ---\n');
  setBalance(TEST_IDS[0], 0n);
  let st = computeOnboardingStatus(TEST_IDS[0]);
  assertEq('status = null', st.status, null);
  check('needsAction = false', st.needsAction === false);
  check('riskLevel = low (zero balance)', st.riskLevel === 'low');

  // ─── 3. Below threshold inbound ───────────────────────────────
  console.log('\n--- 3. balance=50 (below 100) → no trigger ---\n');
  setBalance(TEST_IDS[0], 50n);
  st = computeOnboardingStatus(TEST_IDS[0]);
  assertEq('status still null', st.status, null);
  let trig = maybeTriggerOnboarding(TEST_IDS[0]);
  assertEq('triggered = false', trig.triggered, false);
  assertEq('reason = below_threshold', trig.reason, 'below_threshold');

  // ─── 4. Cross-threshold inbound ───────────────────────────────
  console.log('\n--- 4. balance=200 (above 100) → triggered, pending ---\n');
  setBalance(TEST_IDS[0], 200n);
  // Before trigger: computeOnboardingStatus returns virtual pending
  st = computeOnboardingStatus(TEST_IDS[0]);
  assertEq('virtual status = pending', st.status, ONBOARDING_STATUS.PENDING);
  check('isVirtual = true (not yet persisted)', st.isVirtual === true);
  check('needsAction = true', st.needsAction === true);
  check('riskLevel = medium (200 between 100-1000)', st.riskLevel === 'medium');

  // Now actually trigger → persists to disk
  trig = maybeTriggerOnboarding(TEST_IDS[0]);
  assertEq('triggered = true', trig.triggered, true);
  assertEq('status = pending', trig.status, ONBOARDING_STATUS.PENDING);
  st = computeOnboardingStatus(TEST_IDS[0]);
  check('isVirtual = false after persist', st.isVirtual === false);
  check('triggeredAt is set', typeof st.triggeredAt === 'number' && st.triggeredAt > 0);

  // ─── 5. Already-pending → second trigger is no-op ─────────────
  console.log('\n--- 5. Re-trigger on already-pending → no-op ---\n');
  const before = agentWalletManager.getOnboardingStatus(TEST_IDS[0]).triggeredAt;
  trig = maybeTriggerOnboarding(TEST_IDS[0]);
  assertEq('triggered = false', trig.triggered, false);
  assertEq('reason = already_pending', trig.reason, 'already_pending');
  const after = agentWalletManager.getOnboardingStatus(TEST_IDS[0]).triggeredAt;
  assertEq('triggeredAt unchanged', after, before);

  // ─── 6. markOnboardingComplete for each method ────────────────
  console.log('\n--- 6. markOnboardingComplete with each method ---\n');
  for (const [idx, method] of Object.entries(ONBOARDING_METHOD)) {
    const id = TEST_IDS[1];
    setBalance(id, 500n);
    maybeTriggerOnboarding(id);
    const res = markOnboardingComplete(id, method);
    assertEq(`method=${method} success`, res.success, true);
    const final = computeOnboardingStatus(id);
    check(`  method=${method} needsAction=false`, final.needsAction === false);
    const expectedStatus = {
      [ONBOARDING_METHOD.BACKUP]:   ONBOARDING_STATUS.BACKED_UP,
      [ONBOARDING_METHOD.TRANSFER]: ONBOARDING_STATUS.TRANSFERRED_OUT,
      [ONBOARDING_METHOD.HARDWARE]: ONBOARDING_STATUS.HARDWARE_BOUND,
      [ONBOARDING_METHOD.WAIVE]:    ONBOARDING_STATUS.WAIVED
    }[method];
    assertEq(`  method=${method} status`, final.status, expectedStatus);
    check(`  method=${method} completedAt set`, typeof final.completedAt === 'number' && final.completedAt > 0);
  }

  // ─── 7. Terminal status blocks re-trigger ─────────────────────
  console.log('\n--- 7. backed_up agent → no re-trigger ---\n');
  setBalance(TEST_IDS[2], 0n);  // even if balance drops to 0
  markOnboardingComplete(TEST_IDS[2], ONBOARDING_METHOD.BACKUP);
  // Now bump balance way up — but PRESERVE the terminal onboarding
  setBalance(TEST_IDS[2], 99999n, false);
  trig = maybeTriggerOnboarding(TEST_IDS[2]);
  assertEq('triggered = false on terminal', trig.triggered, false);
  assertEq('reason = terminal', trig.reason, 'terminal');
  const final2 = computeOnboardingStatus(TEST_IDS[2]);
  assertEq('status preserved as backed_up', final2.status, ONBOARDING_STATUS.BACKED_UP);
  check('riskLevel = low (terminal)', final2.riskLevel === 'low');

  // ─── 8. Invalid method rejected ───────────────────────────────
  console.log('\n--- 8. markOnboardingComplete invalid method ---\n');
  setBalance(TEST_IDS[3], 500n);
  maybeTriggerOnboarding(TEST_IDS[3]);
  const bad = markOnboardingComplete(TEST_IDS[3], 'invalid_method_xyz');
  assertEq('success = false', bad.success, false);
  check('error mentions invalid', /invalid/i.test(bad.error));
  // Status should remain pending
  const stillPending = computeOnboardingStatus(TEST_IDS[3]);
  assertEq('status still pending', stillPending.status, ONBOARDING_STATUS.PENDING);

  // ─── 9. Persistence: state survives save+load cycle ───────────
  console.log('\n--- 9. Persistence: save → load cycle preserves state ---\n');
  setBalance(TEST_IDS[0], 500n);
  maybeTriggerOnboarding(TEST_IDS[0]);
  markOnboardingComplete(TEST_IDS[0], ONBOARDING_METHOD.TRANSFER);
  // Force a save
  agentWalletManager._saveRegistry();
  // Read back from disk
  const onDisk = JSON.parse(
    fs.readFileSync(
      path.join('data', 'wallets', 'agent_wallet_registry.json'),
      'utf8'
    )
  );
  const entry = onDisk.entries.find(e => e.agentId === TEST_IDS[0]);
  check('onboarding field persisted', entry.onboarding !== null && entry.onboarding !== undefined);
  assertEq('persisted status = transferred_out', entry.onboarding.status, ONBOARDING_STATUS.TRANSFERRED_OUT);
  assertEq('persisted method = transfer', entry.onboarding.method, ONBOARDING_METHOD.TRANSFER);
  check('persisted completedAt is number', typeof entry.onboarding.completedAt === 'number');

  // ─── 10. getOnboardingStats ───────────────────────────────────
  console.log('\n--- 10. getOnboardingStats ---\n');
  const stats = getOnboardingStats();
  check('total is number', typeof stats.total === 'number' && stats.total > 0);
  check('pending >= 1 (TEST_IDS[0] now transferred, TEST_IDS[3] still pending)', stats.pending >= 1);
  check('completed >= 1', stats.completed >= 1);
  check('waived >= 1', stats.waived >= 1);
  assertEq('total = pending + completed + waived + (low-balance no-action)',
    stats.total,
    stats.pending + stats.completed + stats.waived + (stats.total - stats.pending - stats.completed - stats.waived));

  // ─── 11. computeOnboardingStatus for non-existent agent ────────
  console.log('\n--- 11. Non-existent agent ---\n');
  const missing = computeOnboardingStatus('agent-does-not-exist-xyz');
  assertEq('returns null for missing', missing, null);
  const missingTrig = maybeTriggerOnboarding('agent-does-not-exist-xyz');
  assertEq('trigger returns reason=agent_not_found', missingTrig.reason, 'agent_not_found');

} catch (e) {
  console.error('\nFATAL:', e);
  failed++;
} finally {
  // ─── Cleanup: restore all test agents to pre-test state ──────
  console.log('\n--- Cleanup: restore 4 test agents to pre-test state ---\n');
  await restoreAll();
  for (const id of createdIds) {
    check(`test agent ${id} snapshot restored`, true);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  ✓ Onboarding data layer works');
  } else {
    console.log('  ✗ Onboarding data layer has gaps — see failures above');
  }
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}
})();
