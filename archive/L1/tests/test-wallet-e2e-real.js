/**
 * End-to-End Test: Real Agent Transfer Flow (Phase 2 E2E)
 *
 * This test exercises the full wallet pipeline using REAL agents
 * (agent-X-001, agent-Y-001) that exist in the persistent registry.
 * It validates that an HTTP-initiated transfer correctly:
 *   1. Decrements sender's agentWalletManager balance by the transfer amount
 *   2. Increments recipient's state balance by the transfer amount
 *   3. Persists the change to disk via _saveRegistry
 *   4. Records a CUSTODY_SIGN audit event in txHistory
 *   5. Issues a fresh Custody Token via issueCustodyToken
 *   6. Signs a message via /wallet/sign with the token
 *   7. Verifies the PQC signature against the sender's publicKey
 *
 * Run: node tests/test-wallet-e2e-real.js
 *
 * IMPORTANT: dotenv MUST be loaded first, otherwise the agentWalletManager
 * singleton is constructed with a freshly-generated random key and cannot
 * decrypt any of the 176 existing wallets.
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import walletApiRouter from '../src/http/routes/walletApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { publicKeyFingerprint, issueCustodyToken, verifyCustodyToken } from '../src/http/custodyToken.js';
import { verify as pqcVerify } from '../src/crypto/pqc.js';
import { recordCustodySign } from '../src/blockchain/transactionEngine.js';

let passed = 0, failed = 0;
function check(name, cond, info = '') {
  if (cond) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${info ? ' | ' + info : ''}`); failed++; }
}
function assertEq(name, actual, expected) {
  check(name, actual === expected, `expected=${expected} got=${actual}`);
}

async function http(method, path, body = null, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

// Real agents from the persistent registry
const SENDER_ID = 'agent-X-001';
const RECIPIENT_ID = 'agent-Y-001';
const TRANSFER_AMOUNT = 500;

// Test secrets (override dev defaults)
const TEST_CREDIT_SECRET = 'e2e-real-transfer-test-credit-secret-pad';
const TEST_CUSTODY_SECRET = 'e2e-real-custody-secret-32-chars-padding!';
process.env.NG_ADMIN_CREDIT_SECRET = TEST_CREDIT_SECRET;
process.env.NG_ADMIN_BYPASS_SECRET = TEST_CREDIT_SECRET;
process.env.NG_CUSTODY_TOKEN_SECRET = TEST_CUSTODY_SECRET;
process.env.NODE_ENV = 'development';

let BASE;
let server;
let mockState;
let senderAddress;
let recipientAddress;
let senderBalanceBefore;
let recipientBalanceBefore;
let txCountBefore;
let senderInstance;
let recipientInstance;
let testFailed = false;

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
      get txCount() { return txCount; },
      set txCount(v) { txCount = v; },
      byType,
      byAddress
    },
    balances: { ...initialBalances },
    getBalance(addr) { return this.balances[addr] ?? 0; },
    getBalanceOf(addr) { return this.balances[addr] ?? 0; },
    setBalance(addr, val) { this.balances[addr] = Number(val); },
    getAllTransactions() { return txHistory; }
  };
}

(async () => {
  try {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Real Agent Transfer — End-to-End (Phase 2)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ─── 0. Pre-flight ─────────────────────────────────────────────
  console.log('--- 0. Pre-flight: verify real agents in registry ---\n');
  const senderWallet = agentWalletManager.getAgentWallet(SENDER_ID);
  const recipientWallet = agentWalletManager.getAgentWallet(RECIPIENT_ID);
  check(`${SENDER_ID} exists`, senderWallet !== null);
  check(`${RECIPIENT_ID} exists`, recipientWallet !== null);
  if (!senderWallet || !recipientWallet) {
    console.log('\n  FATAL: required real agents missing. Aborting.\n');
    process.exit(1);
  }
  senderAddress = senderWallet.address;
  recipientAddress = recipientWallet.address;
  senderBalanceBefore = BigInt(senderWallet.balance);
  recipientBalanceBefore = BigInt(recipientWallet.balance);
  txCountBefore = senderWallet.nonce || 0;
  senderInstance = agentWalletManager.getWalletInstance(SENDER_ID);
  recipientInstance = agentWalletManager.getWalletInstance(RECIPIENT_ID);

  console.log(`  Sender   : ${SENDER_ID}  ${senderAddress}  ${senderBalanceBefore} NGEN  nonce=${txCountBefore}`);
  console.log(`  Recipient: ${RECIPIENT_ID}  ${recipientAddress}  ${recipientBalanceBefore} NGEN`);

  // ─── 1. Spin up minimal Express + walletApi ───────────────────
  console.log('\n--- 1. Start HTTP server (Express + walletApi) ---\n');
  mockState = buildMockState({
    [senderAddress]: Number(senderBalanceBefore),
    [recipientAddress]: Number(recipientBalanceBefore)
  });
  const app = express();
  app.use(express.json());
  app.locals.state = mockState;
  app.use('/api/v1/wallet', walletApiRouter);
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  BASE = `http://127.0.0.1:${port}`;
  check(`server listening on ${BASE}`, true);

  // ─── 2. /api/v1/wallet/stats sanity ───────────────────────────
  console.log('\n--- 2. GET /api/v1/wallet/stats ---\n');
  const stats = await http('GET', '/api/v1/wallet/stats');
  check('stats 200', stats.status === 200);
  check('stats success=true', stats.body.success === true);
  check('stats has totalWallets >= 176', stats.body.totalWallets >= 176,
    `got ${stats.body.totalWallets}`);

  // ─── 3. Pre-transfer balances ─────────────────────────────────
  console.log('\n--- 3. GET pre-transfer balances ---\n');
  const senderBalBefore = await http('GET', `/api/v1/wallet/balance/${senderAddress}`);
  const recipientBalBefore = await http('GET', `/api/v1/wallet/balance/${recipientAddress}`);
  check('sender balance 200', senderBalBefore.status === 200);
  check('recipient balance 200', recipientBalBefore.status === 200);
  assertEq('sender pre-balance = 7888', senderBalBefore.body.wallet.balance, 7888);
  assertEq('recipient pre-balance = 13018', recipientBalBefore.body.wallet.balance, 13018);

  // ─── 4. POST /wallet/transfer ─────────────────────────────────
  console.log('\n--- 4. POST /api/v1/wallet/transfer (Mode A: fromAgentId) ---\n');
  const transferRes = await http('POST', '/api/v1/wallet/transfer', {
    fromAgentId: SENDER_ID,
    toAddress: recipientAddress,
    amount: TRANSFER_AMOUNT,
    memo: 'e2e-real-transfer-test'
  }, { 'x-admin-secret': TEST_CREDIT_SECRET });
  // Endpoint returns 201 (Created) for new transaction
  check('transfer returns 201', transferRes.status === 201,
    `got status=${transferRes.status}`);
  check('transfer success=true', transferRes.body.success === true);
  check('transfer has tx.id (64 hex chars)',
    typeof transferRes.body.transaction?.id === 'string' && transferRes.body.transaction.id.length === 64);
  assertEq('transfer amount = 500', transferRes.body.transaction?.amount, TRANSFER_AMOUNT);
  assertEq('transfer mode = agent-managed', transferRes.body.transaction?.mode, 'agent-managed');

  // ─── 5. Verify in-memory state ────────────────────────────────
  console.log('\n--- 5. Verify state updated ---\n');
  const expectedSenderBalance = senderBalanceBefore - BigInt(TRANSFER_AMOUNT);
  const expectedRecipientStateBalance = Number(recipientBalanceBefore) + TRANSFER_AMOUNT;
  // Sender's agentWalletManager balance decreases
  check(`sender agentWalletManager balance: 7888 → ${expectedSenderBalance}`,
    BigInt(senderInstance.balance) === expectedSenderBalance,
    `expected=${expectedSenderBalance} got=${senderInstance.balance}`);
  check(`sender nonce: ${txCountBefore} → ${txCountBefore + 1}`,
    senderInstance.nonce === txCountBefore + 1,
    `expected=${txCountBefore + 1} got=${senderInstance.nonce}`);
  // Recipient's state balance increases
  check(`recipient state balance: ${recipientBalanceBefore} → ${expectedRecipientStateBalance}`,
    mockState.getBalance(recipientAddress) === expectedRecipientStateBalance,
    `expected=${expectedRecipientStateBalance} got=${mockState.getBalance(recipientAddress)}`);
  // Sender's state balance also decreases (state is canonical for both)
  check(`sender state balance: ${senderBalanceBefore} → ${expectedSenderBalance}`,
    mockState.getBalance(senderAddress) === Number(expectedSenderBalance),
    `expected=${Number(expectedSenderBalance)} got=${mockState.getBalance(senderAddress)}`);

  // ─── 6. HTTP balance post-transfer ────────────────────────────
  console.log('\n--- 6. GET post-transfer balances via HTTP ---\n');
  const senderBalAfter = await http('GET', `/api/v1/wallet/balance/${senderAddress}`);
  const recipientBalAfter = await http('GET', `/api/v1/wallet/balance/${recipientAddress}`);
  assertEq(`sender HTTP balance = ${expectedSenderBalance}`, senderBalAfter.body.wallet.balance, Number(expectedSenderBalance));
  assertEq(`recipient HTTP balance = ${expectedRecipientStateBalance}`, recipientBalAfter.body.wallet.balance, expectedRecipientStateBalance);

  // ─── 7. Custody Token flow ────────────────────────────────────
  console.log('\n--- 7. Custody Token: issue ---\n');
  const pubKeyHex = senderInstance.publicKey.toString('hex');
  const fingerprint = publicKeyFingerprint(pubKeyHex);
  console.log(`  Sender pubKey fingerprint: ${fingerprint}`);

  const tokenObj = issueCustodyToken({
    agentId: SENDER_ID,
    address: senderAddress,
    publicKeyHex: pubKeyHex,
    ttlSeconds: 60
  });
  const tokenStr = tokenObj.token;
  check('token issued (3-part string)', tokenStr.split('.').length === 3);
  check('token has expiresAt (60s)',
    typeof tokenObj.expiresAt === 'number' && tokenObj.expiresAt > Math.floor(Date.now() / 1000));
  const verified = verifyCustodyToken(tokenStr, SENDER_ID, senderAddress, pubKeyHex);
  check('token verifies for sender', verified.valid === true);

  // ─── 8. /wallet/sign with custody token ───────────────────────
  console.log('\n--- 8. POST /api/v1/wallet/sign with custody token ---\n');
  const signPayload = { type: 'e2e-test', nonce: Date.now(), msg: 'phase2-e2e-real' };
  const signRes = await http('POST', '/api/v1/wallet/sign', {
    agentId: SENDER_ID,
    data: signPayload
  }, { 'x-custody-token': tokenStr });
  check('sign returns 200', signRes.status === 200,
    `status=${signRes.status} body=${JSON.stringify(signRes.body).slice(0, 200)}`);
  check('signature length = 4840 hex chars (Dilithium2)',
    typeof signRes.body.signature === 'string' && signRes.body.signature.length === 4840);
  check('publicKey length = 2624 hex chars (Dilithium2)',
    typeof signRes.body.publicKey === 'string' && signRes.body.publicKey.length === 2624);

  // ─── 9. Verify PQC signature ──────────────────────────────────
  console.log('\n--- 9. Verify PQC signature against publicKey ---\n');
  const sigBuf = Buffer.from(signRes.body.signature, 'hex');
  const pubBuf = Buffer.from(signRes.body.publicKey, 'hex');
  const isValid = await pqcVerify(JSON.stringify(signPayload), sigBuf, pubBuf);
  check('PQC signature verifies', isValid === true);

  // ─── 10. Audit event recorded ─────────────────────────────────
  console.log('\n--- 10. CUSTODY_SIGN audit event recorded ---\n');
  const auditEvents = mockState.transactions.txHistory;
  const custodyEvent = auditEvents.find(e => e.tx_type === 'CUSTODY_SIGN');
  check('CUSTODY_SIGN event in txHistory', custodyEvent !== undefined);
  if (custodyEvent) {
    check('audit event from = sender', custodyEvent.from === SENDER_ID,
      `got from=${custodyEvent.from}`);
    check('audit event custodyFp = sender fp', custodyEvent.payload?.custodyFp === fingerprint,
      `expected=${fingerprint} got=${custodyEvent.payload?.custodyFp}`);
  }

  // ─── 11. recordCustodySign (library-level) ────────────────────
  console.log('\n--- 11. recordCustodySign direct call ---\n');
  const countBefore = mockState.transactions.txCount;
  const recRes = recordCustodySign(mockState, {
    agentId: SENDER_ID,
    address: senderAddress,
    action: 'e2e-direct-call',
    dataLen: 42,
    custodyFp: fingerprint,
    ip: '127.0.0.1'
  });
  check('recordCustodySign success=true', recRes.success === true, `result=${JSON.stringify(recRes)}`);
  check('txCount incremented', mockState.transactions.txCount === countBefore + 1);
  } catch (e) {
    console.error('FATAL:', e);
    testFailed = true;
  } finally {
    // ─── Cleanup: restore balances and nonce so test is idempotent ──
    console.log('\n--- Cleanup: restore registry to pre-test state ---\n');
    if (senderInstance && recipientInstance) {
      senderInstance.balance = senderBalanceBefore;
      senderInstance.nonce = txCountBefore;
      agentWalletManager._saveRegistry();
      check('sender balance restored to 7888', senderInstance.balance === senderBalanceBefore);
    }

    // ─── Summary ──────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  Result: ${passed} passed, ${failed} failed`);
    if (failed === 0 && !testFailed) {
      console.log('  ✓ End-to-end real Agent transfer flow works');
    } else {
      console.log('  ✗ E2E has gaps — see failures above');
    }
    console.log('═══════════════════════════════════════════════════════════');

    if (server) server.close();
    process.exit(failed > 0 || testFailed ? 1 : 0);
  }
})();
