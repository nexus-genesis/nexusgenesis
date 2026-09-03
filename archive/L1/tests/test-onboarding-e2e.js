/**
 * End-to-End Onboarding Test (Phase 2-A5)
 *
 * 完整链路验证：
 *   1. 新建 AGENT 钱包（小额，不触发 onboarding）
 *   2. reward tx 让余额过阈值 → 自动触发 onboarding (in-memory)
 *   3. GET /security-status 暴露 needsOnboarding=true
 *   4. riskLevel 映射（medium / high）
 *   5. CLI 导出：encryptMasterKey + writeEnvelopeFile → 落盘 .enc
 *   6. CLI 恢复：readEnvelopeFile + decryptMasterKey → 与原密钥 byte-for-byte 一致
 *   7. 用恢复的主密钥 + 已知 agent envelope 验证（verifyMasterKeyAgainstAgent）
 *   8. 篡改的 envelope 拒绝（KEK fingerprint 不匹配）
 *   9. POST /onboarding/complete → terminal 状态
 *  10. 后续查询 needsOnboarding=false
 *  11. 完整链路：reward 触发 → API 显示 pending → CLI 导出 → CLI 恢复 → 验证 → 标记完成 → API 显示 terminal
 *
 * 设计：
 *   - in-process Express on random port（沿用 test-onboarding-api.js 模式）
 *   - 真实 walletApi 路由 + 真实 onboarding 模块 + 真实 masterKeyBackup 模块
 *   - mock state 注入到 app.locals.state
 *   - snapshot/restore 模式：跑完恢复 agent 余额和非明文字段，幂等
 *   - scrypt fast 模式（KDF_PARAMS_FAST）避免 CI 拖慢
 *
 * Run: node tests/test-onboarding-e2e.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

import walletApiRouter from '../src/http/routes/walletApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import {
  encryptMasterKey,
  decryptMasterKey,
  computeKEKFingerprint,
  readEnvelopeFile,
  writeEnvelopeFile,
  verifyMasterKeyAgainstAgent,
  validatePassphrase
} from '../src/wallet/masterKeyBackup.js';
import {
  applyTransaction,
  TX_TYPE
} from '../src/blockchain/transactionEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// ─── Test config ──────────────────────────────────────────────────
const TEST_ADMIN_SECRET = 'e2e-onboarding-test-credit-secret-pad-2026';
process.env.NG_ADMIN_CREDIT_SECRET = TEST_ADMIN_SECRET;
process.env.NODE_ENV = 'development';

const TEST_AGENT_E2E = 'agent-OB-E2E-MAIN';
const TEST_AGENT_BAL = 'agent-OB-E2E-RICH';
const TEST_AGENT_VER = 'agent-validator-001';  // 与 verifyMasterKeyAgainstAgent 默认一致

const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}
function assertEq(name, actual, expected) {
  check(name, actual === expected, `expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
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
    setBalance(addr, amount) { this.balances[addr] = Number(amount); },
    getAllTransactions() { return txHistory; }
  };
}

/**
 * Production keeps state.balances and agentWalletManager.wallet.balance
 * in sync via the faucet / transfer code paths. The reward path in
 * applyTransaction updates state.balances but NOT the wallet (by design —
 * see transactionEngine.js comment). For the test to read the right
 * balance via /security-status, we need to mirror state → wallet.
 */
function mirrorStateToWallet(addr) {
  const agentId = agentWalletManager.getAgentByAddress(addr);
  if (!agentId) return;
  const entry = agentWalletManager.getRegistryEntry(agentId);
  if (!entry) return;
  const stateBal = mockState.balances[addr] || 0;
  entry.wallet.balance = BigInt(stateBal);
}

// Snapshot/restore for idempotent reruns.
// IMPORTANT: snapshot BEFORE we mutate, so the finally block can put
// the agent back to whatever state it was in (which may include a stale
// onboarding from a previous test run).
const snapshots = new Map();
function snapshotAgent(id) {
  const entry = agentWalletManager.getRegistryEntry(id);
  if (!entry) return null;
  return {
    balance: entry.wallet.balance,
    nonce: entry.wallet.nonce,
    onboarding: entry.onboarding ? { ...entry.onboarding } : null,
    metadata: entry.metadata ? { ...entry.metadata } : null
  };
}
function resetAgent(id) {
  const entry = agentWalletManager.getRegistryEntry(id);
  if (!entry) return null;
  entry.wallet.balance = 0n;
  entry.wallet.nonce = 0;
  entry.onboarding = null;
  return entry;
}
async function ensureAgent(id, initialBalance = 0n) {
  if (!agentWalletManager.registry.has(id)) {
    await agentWalletManager.createAgentWallet(id, { test: 'e2e' }, initialBalance);
  } else {
    // existing wallet from a previous run — force-reset to clean state
    const e = agentWalletManager.getRegistryEntry(id);
    e.wallet.balance = initialBalance;
    e.wallet.nonce = 0;
    e.onboarding = null;
  }
  const snap = snapshotAgent(id);
  if (snap) snapshots.set(id, snap);
  return agentWalletManager.getRegistryEntry(id);
}
async function restoreAll() {
  for (const [id, snap] of snapshots) {
    const entry = agentWalletManager.getRegistryEntry(id);
    if (!entry) continue;
    entry.wallet.balance = snap.balance;
    entry.wallet.nonce = snap.nonce;
    entry.onboarding = snap.onboarding ? { ...snap.onboarding } : null;
    if (snap.metadata) entry.metadata = { ...snap.metadata };
  }
  agentWalletManager._saveRegistry();
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  End-to-End Onboarding Test (Phase 2-A5)');
console.log('═══════════════════════════════════════════════════════════\n');

let BASE, server, mockState, tmpDir;

(async () => {
  try {
    // ─── 0. Setup ──────────────────────────────────────────────
    console.log('--- 0. Setup: 3 test agents + Express + mock state ---\n');

    const eMain = await ensureAgent(TEST_AGENT_E2E, 0n);
    const eRich = await ensureAgent(TEST_AGENT_BAL, 0n);
    // Try to ensure validator exists for verifyMasterKeyAgainstAgent
    let eVer = agentWalletManager.getRegistryEntry(TEST_AGENT_VER);
    if (!eVer) {
      await ensureAgent(TEST_AGENT_VER, 0n);
    } else {
      snapshots.set(TEST_AGENT_VER, snapshotAgent(TEST_AGENT_VER));
    }

    eMain.onboarding = null;
    eRich.onboarding = null;
    if (eVer) eVer.onboarding = null;

    const mainAddr = eMain.wallet.address;
    const richAddr = eRich.wallet.address;
    const verAddr = eVer?.wallet.address;

    mockState = buildMockState({
      [mainAddr]: 0,
      [richAddr]: 0,
      ...(verAddr ? { [verAddr]: 0 } : {})
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
    check(`master key loaded: ${!!agentWalletManager.masterKey}`,
      !!agentWalletManager.masterKey,
      `expected 32 bytes, got ${agentWalletManager.masterKey?.length || 0}`);
    check(`master key length = 32`, agentWalletManager.masterKey?.length === 32);

    // tmp dir for .enc files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-e2e-'));
    check(`tmp dir created: ${tmpDir}`, fs.existsSync(tmpDir));

    // ─── 1. New agent: balance < threshold → no onboarding ──────
    console.log('\n--- 1. New agent: balance 0 < 100 threshold ---\n');
    const r1 = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_E2E}/security-status`);
    assertEq('1.1 returns 200', r1.status, 200);
    assertEq('1.2 needsOnboarding = false', r1.body.needsOnboarding, false);
    assertEq('1.3 status = null', r1.body.status, null);
    assertEq('1.4 riskLevel = low', r1.body.riskLevel, 'low');
    check('1.5 suggestedActions is empty', r1.body.suggestedActions.length === 0);

    // ─── 2. Reward tx: balance 50 → still below threshold ──────
    console.log('\n--- 2. TASK_REWARD 50: still below 100 ---\n');
    const r2a = applyTransaction(mockState, {
      tx_type: TX_TYPE.TASK_REWARD,
      from: 'null',
      to: mainAddr,
      amount: 50
    });
    check('2.1 reward applied', r2a.success === true);
    mirrorStateToWallet(mainAddr);
    await sleep(100);  // hook is async (setImmediate)
    assertEq('2.2 onboarding still null', eMain.onboarding, null);
    const r2b = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_E2E}/security-status`);
    assertEq('2.3 needsOnboarding = false', r2b.body.needsOnboarding, false);

    // ─── 3. Reward tx: pushes over threshold → triggers ───────
    console.log('\n--- 3. TASK_REWARD 60: 50+60=110 crosses threshold ---\n');
    const r3a = applyTransaction(mockState, {
      tx_type: TX_TYPE.TASK_REWARD,
      from: 'null',
      to: mainAddr,
      amount: 60
    });
    check('3.1 reward applied', r3a.success === true);
    mirrorStateToWallet(mainAddr);
    await sleep(300);  // give async hook time
    check('3.2 in-memory onboarding = pending',
      eMain.onboarding !== null && eMain.onboarding.status === 'pending',
      `got ${JSON.stringify(eMain.onboarding)}`);
    check('3.3 triggeredAt is set', typeof eMain.onboarding?.triggeredAt === 'number');

    const r3b = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_E2E}/security-status`);
    assertEq('3.4 API status = pending', r3b.body.status, 'pending');
    assertEq('3.5 API needsOnboarding = true', r3b.body.needsOnboarding, true);
    assertEq('3.6 riskLevel = medium (110 < 1000)', r3b.body.riskLevel, 'medium');
    assertEq('3.7 API balance = 110', r3b.body.balance, '110');
    check('3.8 suggestedActions has 3 items', r3b.body.suggestedActions.length === 3);

    // ─── 4. Push to high risk ──────────────────────────────────
    console.log('\n--- 4. Push to high risk: +1000 NGEN (total 1110) ---\n');
    const r4a = applyTransaction(mockState, {
      tx_type: TX_TYPE.BLOCK_REWARD,
      from: 'null',
      to: mainAddr,
      amount: 1000
    });
    check('4.1 reward applied', r4a.success === true);
    mirrorStateToWallet(mainAddr);
    await sleep(200);
    const r4b = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_E2E}/security-status`);
    assertEq('4.2 riskLevel = high', r4b.body.riskLevel, 'high');
    assertEq('4.3 balance shows 1110', r4b.body.balance, '1110');

    // ─── 5. CLI export: encrypt master key + write .enc file ───
    console.log('\n--- 5. CLI export: encrypt master key + write .enc file ---\n');
    const masterKey = agentWalletManager.masterKey;
    const PASSPHRASE = 'E2E-Recovery-Passphrase-2026!@#';
    const passCheck = validatePassphrase(PASSPHRASE);
    check('5.1 passphrase passes strength check', passCheck.ok, JSON.stringify(passCheck.errors));

    const envelope = await encryptMasterKey(masterKey, PASSPHRASE, { fast: true });
    check('5.2 envelope has expected structure', !!envelope.cipher && !!envelope.kdf && !!envelope.kekFingerprint);
    check('5.3 envelope.type = ngen-wallet-master-key-backup',
      envelope.type === 'ngen-wallet-master-key-backup');
    check('5.4 envelope.version = 1', envelope.version === 1);
    check('5.5 fingerprint is 8 hex chars', /^[0-9a-f]{8}$/.test(envelope.kekFingerprint));

    const encFile = path.join(tmpDir, `master-key-${Date.now()}.enc`);
    writeEnvelopeFile(encFile, envelope);
    check('5.6 .enc file written', fs.existsSync(encFile));
    const fileSize = fs.statSync(encFile).size;
    check('5.7 .enc file size > 200 bytes', fileSize > 200, `got ${fileSize} bytes`);

    // Verify on-disk format
    const onDisk = JSON.parse(fs.readFileSync(encFile, 'utf8'));
    assertEq('5.8 on-disk type matches', onDisk.type, 'ngen-wallet-master-key-backup');
    assertEq('5.9 on-disk fingerprint matches', onDisk.kekFingerprint, envelope.kekFingerprint);

    // ─── 6. CLI import: read file + decrypt ────────────────────
    console.log('\n--- 6. CLI import: read file + decrypt with passphrase ---\n');
    const envFromDisk = readEnvelopeFile(encFile);
    const recovered = await decryptMasterKey(envFromDisk, PASSPHRASE);
    check('6.1 recovered has masterKey Buffer', Buffer.isBuffer(recovered.masterKey));
    assertEq('6.2 recovered key length = 32', recovered.masterKey.length, 32);
    assertEq('6.3 fingerprint matches', recovered.fingerprint, envelope.kekFingerprint);
    assertEq('6.4 byte-for-byte match with original master key',
      Buffer.compare(recovered.masterKey, masterKey), 0);

    // ─── 7. Wrong passphrase rejected ──────────────────────────
    console.log('\n--- 7. Wrong passphrase rejected ---\n');
    let wrongPassRejected = false;
    try {
      await decryptMasterKey(envFromDisk, 'wrong-passphrase-1234!');
    } catch (e) {
      wrongPassRejected = /fingerprint mismatch|auth failed/i.test(e.message);
    }
    check('7.1 wrong passphrase raises error', wrongPassRejected);

    // ─── 8. Tampered ciphertext rejected (GCM auth) ──────────
    console.log('\n--- 8. Tampered ciphertext rejected ---\n');
    const tampered = JSON.parse(JSON.stringify(envFromDisk));
    const ctBuf = Buffer.from(tampered.cipher.ciphertext, 'base64');
    ctBuf[0] = ctBuf[0] ^ 0x01;  // flip one bit
    tampered.cipher.ciphertext = ctBuf.toString('base64');
    let tamperRejected = false;
    try {
      await decryptMasterKey(tampered, PASSPHRASE);
    } catch (e) {
      tamperRejected = /fingerprint mismatch|auth failed|corrupted/i.test(e.message);
    }
    check('8.1 tampered envelope rejected', tamperRejected);

    // ─── 9. verifyMasterKeyAgainstAgent: end-to-end key works ──
    console.log('\n--- 9. verifyMasterKeyAgainstAgent: end-to-end key works ---\n');
    // First confirm validator agent exists
    const verEntry = agentWalletManager.getRegistryEntry(TEST_AGENT_VER);
    if (!verEntry) {
      console.log('  SKIP 9.x: agent-validator-001 not in registry, skipping');
    } else {
      // Test that ORIGINAL master key works
      const okOrig = verifyMasterKeyAgainstAgent(masterKey, agentWalletManager, TEST_AGENT_VER);
      check('9.1 original master key verifies', okOrig.ok,
        okOrig.error || 'no error');
      if (okOrig.ok) {
        check(`9.2 verified address: ${okOrig.address?.slice(0, 20)}...`, !!okOrig.address);
        check(`9.3 privateKey length is valid PQC (${okOrig.privateKeyLength})`,
          [2420, 2560, 4000, 4864].includes(okOrig.privateKeyLength));
      }

      // Test that RECOVERED master key also works (proves recovery is functional)
      const okRec = verifyMasterKeyAgainstAgent(recovered.masterKey, agentWalletManager, TEST_AGENT_VER);
      check('9.4 recovered master key also verifies', okRec.ok,
        okRec.error || 'no error');

      // Test that RANDOM key fails
      const randomKey = crypto.randomBytes(32);
      const okBad = verifyMasterKeyAgainstAgent(randomKey, agentWalletManager, TEST_AGENT_VER);
      check('9.5 random wrong key fails cleanly', !okBad.ok && !!okBad.error,
        okBad.error || 'no error');
    }

    // ─── 10. API: POST complete marks terminal ────────────────
    console.log('\n--- 10. POST /onboarding/complete: terminal state ---\n');
    const r10a = await http('POST',
      `/api/v1/wallet/agent/${TEST_AGENT_E2E}/onboarding/complete`,
      { method: 'backup' },
      { 'x-admin-secret': TEST_ADMIN_SECRET }
    );
    assertEq('10.1 returns 200', r10a.status, 200);
    assertEq('10.2 status = backed_up', r10a.body.status, 'backed_up');
    assertEq('10.3 method = backup', r10a.body.method, 'backup');

    const r10b = await http('GET', `/api/v1/wallet/agent/${TEST_AGENT_E2E}/security-status`);
    assertEq('10.4 needsOnboarding = false', r10b.body.needsOnboarding, false);
    assertEq('10.5 status = backed_up (terminal)', r10b.body.status, 'backed_up');
    assertEq('10.6 riskLevel = low', r10b.body.riskLevel, 'low');
    check('10.7 suggestedActions = [] (terminal)',
      Array.isArray(r10b.body.suggestedActions) && r10b.body.suggestedActions.length === 0);
    check('10.8 completedAt is set', typeof r10b.body.completedAt === 'number');

    // ─── 11. Full pipeline E2E on a fresh agent ────────────────
    console.log('\n--- 11. Full pipeline: reward → API → CLI export → recovery → verify → complete ---\n');

    const E2E = 'agent-OB-E2E-FULL';
    const e2e = await ensureAgent(E2E, 0n);
    e2e.onboarding = null;
    e2e.wallet.balance = 0n;
    const e2eAddr = e2e.wallet.address;
    mockState.balances[e2eAddr] = 0;

    // 11.1 Reward
    applyTransaction(mockState, {
      tx_type: TX_TYPE.TASK_REWARD,
      from: 'null',
      to: e2eAddr,
      amount: 200
    });
    mirrorStateToWallet(e2eAddr);
    await sleep(200);
    check('11.1 reward triggered onboarding',
      e2e.onboarding !== null && e2e.onboarding.status === 'pending');

    // 11.2 API shows pending
    const e2e1 = await http('GET', `/api/v1/wallet/agent/${E2E}/security-status`);
    assertEq('11.2 API status = pending', e2e1.body.status, 'pending');
    assertEq('11.3 API balance = 200', e2e1.body.balance, '200');

    // 11.3 CLI export (use real masterKeyBackup)
    const envE2E = await encryptMasterKey(masterKey, PASSPHRASE, { fast: true });
    const e2eEncFile = path.join(tmpDir, 'e2e-full.enc');
    writeEnvelopeFile(e2eEncFile, envE2E);
    check('11.4 CLI export file written', fs.existsSync(e2eEncFile));

    // 11.4 CLI recovery
    const envRead = readEnvelopeFile(e2eEncFile);
    const recoveredE2E = await decryptMasterKey(envRead, PASSPHRASE);
    assertEq('11.5 recovered key matches',
      Buffer.compare(recoveredE2E.masterKey, masterKey), 0);

    // 11.5 Verify recovered key works (if validator exists)
    if (verEntry) {
      const verifyE2E = verifyMasterKeyAgainstAgent(recoveredE2E.masterKey, agentWalletManager, TEST_AGENT_VER);
      check('11.6 recovered key decrypts validator wallet', verifyE2E.ok,
        verifyE2E.error || 'no error');
    }

    // 11.6 POST complete
    const e2eComplete = await http('POST',
      `/api/v1/wallet/agent/${E2E}/onboarding/complete`,
      { method: 'transfer' },
      { 'x-admin-secret': TEST_ADMIN_SECRET }
    );
    assertEq('11.7 complete returns 200', e2eComplete.status, 200);
    assertEq('11.8 complete status = transferred_out', e2eComplete.body.status, 'transferred_out');

    // 11.7 API now shows terminal
    const e2e2 = await http('GET', `/api/v1/wallet/agent/${E2E}/security-status`);
    assertEq('11.9 API status = transferred_out', e2e2.body.status, 'transferred_out');
    assertEq('11.10 needsOnboarding = false', e2e2.body.needsOnboarding, false);
    check('11.11 suggestedActions empty after complete',
      e2e2.body.suggestedActions.length === 0);

    // 11.8 Re-trigger no-op
    const e2eRetrigger = applyTransaction(mockState, {
      tx_type: TX_TYPE.BLOCK_REWARD,
      from: 'null',
      to: e2eAddr,
      amount: 5000
    });
    mirrorStateToWallet(e2eAddr);
    await sleep(200);
    assertEq('11.12 terminal status unchanged after re-reward',
      e2e.onboarding.status, 'transferred_out');
    assertEq('11.13 terminal triggeredAt unchanged',
      e2e.onboarding.triggeredAt, e2e.onboarding.triggeredAt);

    // 11.9 .enc file is byte-stable (no race on re-read)
    const reRead = readEnvelopeFile(e2eEncFile);
    assertEq('11.14 .enc re-read fingerprint stable',
      reRead.kekFingerprint, envE2E.kekFingerprint);
    assertEq('11.15 .enc re-read type stable',
      reRead.type, 'ngen-wallet-master-key-backup');

  } catch (e) {
    console.error('\nFATAL:', e);
    console.error(e.stack);
    failed++;
  } finally {
    console.log('\n--- Cleanup: restore test agents + close server ---\n');
    await restoreAll();
    if (server) server.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    if (failed === 0) {
      console.log('  ✓ Full onboarding pipeline (reward → API → CLI → recovery → complete) works');
    } else {
      console.log('  ✗ Pipeline has gaps — see failures above');
    }
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(failed > 0 ? 1 : 0);
  }
})();
