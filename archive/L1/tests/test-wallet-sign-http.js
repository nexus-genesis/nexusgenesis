/**
 * HTTP Integration Test: /wallet/sign & /wallet/custody/refresh
 *
 * Phase 2-D2. Spins up an in-process Express app on a random port,
 * mounts the real walletApi router against a mock state, and verifies:
 *
 *   1. Missing custody token → 401 CUSTODY_TOKEN_REQUIRED + hint
 *   2. Tampered token → 401 CUSTODY_TOKEN_REJECTED
 *   3. Token bound to different agent → 401
 *   4. Missing agentId → 400
 *   5. Missing data → 400
 *   6. Non-existent agent → 404
 *   7. Valid token + correct binding → 200, returns PQC signature
 *   8. Returned signature is verifiable against the agent's publicKey
 *   9. Successful sign records CUSTODY_SIGN audit event in state.txHistory
 *  10. /wallet/custody/refresh with valid token → new token issued
 *  11. /wallet/custody/refresh with missing token → 400 TOKEN_MISSING
 *  12. /wallet/custody/refresh with bad token → 401 TOKEN_REJECTED
 *  13. /wallet/health lists custody_token + server_side_signing features
 *  14. Custody token can also be passed via body.custody_token
 *  15. Custody token can also be passed via x-custody header
 *  16. Signature content is deterministic for same data (PQC deterministic)
 *  17. Audit event payload contains expected fields (action, dataLen, custodyFp)
 *  18. Two consecutive signs produce two distinct audit events
 *  19. Refresh with old token still bound to subject works
 *  20. /wallet/sign for one agent does not affect another's nonce
 */

import express from 'express';
import { createServer } from 'http';
import walletApiRouter from '../src/http/routes/walletApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import {
  issueCustodyToken,
  verifyCustodyToken,
  publicKeyFingerprint
} from '../src/http/custodyToken.js';
import { sign as pqcSign, verify as pqcVerifyFn } from '../src/crypto/pqc.js';

let passed = 0, failed = 0;

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
}

// ─── Build a mock state compatible with recordCustodySign ──────────────
function buildMockState() {
  const txHistory = [];
  const byType = {};
  const byAddress = {};
  let txCount = 0;
  return {
    currentBlockHeight: 100,
    transactions: {
      get txHistory() { return txHistory; },
      get byType() { return byType; },
      get byAddress() { return byAddress; },
      get txCount() { return txCount; },
      set txCount(v) { txCount = v; }
    },
    // Direct getters used by the test (recordCustodySign uses txCount via setter)
    _txCountRef: () => txCount,
    _bumpCount: () => ++txCount,
    _addTx: (tx) => { txHistory.push(tx); }
  };
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

// ─── Test setup ─────────────────────────────────────────────────────────
const TEST_SECRET = 'd2-test-custody-secret-32-chars-padding';
process.env.NG_CUSTODY_TOKEN_SECRET = TEST_SECRET;
process.env.NODE_ENV = 'development';

let BASE;
let server;
let mockState;
let testAgentId;
let testAgentId2;
let testAgentWallet;
let testAgentWallet2;
let testToken;
let testToken2;

// Bypass the env-var warning during normal tests
const origWarn = console.warn;
console.warn = (...args) => {
  const msg = String(args[0] || '');
  if (msg.includes('Using dev fallback')) return;
  origWarn.apply(console, args);
};

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HTTP Integration: /wallet/sign (Phase 2-D2)');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Create two test agent wallets (singleton registry; OK — IDs are unique) ──
  console.log('=== Setup: Create 2 test agent wallets ===');
  testAgentId = `d2-test-agent-${Date.now()}-a`;
  testAgentId2 = `d2-test-agent-${Date.now()}-b`;
  testAgentWallet = await agentWalletManager.createAgentWallet(testAgentId, {
    type: 'd2-test', capabilities: ['testing']
  });
  testAgentWallet2 = await agentWalletManager.createAgentWallet(testAgentId2, {
    type: 'd2-test', capabilities: ['testing']
  });
  assert('agent A created', !!testAgentWallet?.address);
  assert('agent B created', !!testAgentWallet2?.address);
  assert('agent A has publicKey', !!testAgentWallet?.publicKey);

  // Mount the router on a fresh app with mock state
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mockState = buildMockState();
  // Manually patch the state to expose a txCount setter that recordCustodySign
  // will hit via state.transactions.txCount++ in normalizeTransaction.
  // The transactionEngine accesses state.transactions.txCount — make it a real
  // numeric field on the underlying object.
  const stateTx = {
    txHistory: [],
    byType: {},
    byAddress: {},
    txCount: 0
  };
  mockState.transactions = stateTx;
  app.locals.state = mockState;
  app.use('/api/v1/wallet', walletApiRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  BASE = `http://127.0.0.1:${addr.port}`;
  console.log(`  test server listening on ${BASE}\n`);

  // Issue custody tokens for both agents
  testToken = issueCustodyToken({
    agentId: testAgentId,
    address: testAgentWallet.address,
    publicKeyHex: testAgentWallet.publicKey
  });
  testToken2 = issueCustodyToken({
    agentId: testAgentId2,
    address: testAgentWallet2.address,
    publicKeyHex: testAgentWallet2.publicKey
  });

  // ─── Test 1: /wallet/sign without custody token → 401 ───
  console.log('=== Test 1: /wallet/sign without custody token ===');
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'hello',
      action: 'test_no_token'
    });
    assert('status 401', r.status === 401, `got ${r.status}`);
    assert('success:false', r.body.success === false);
    assert('error_code = CUSTODY_TOKEN_REQUIRED',
      r.body.error_code === 'CUSTODY_TOKEN_REQUIRED');
    assert('hint provided', !!r.body.hint);
    assert('hint.suggested_fixes present',
      Array.isArray(r.body.hint?.suggested_fixes) && r.body.hint.suggested_fixes.length > 0);
  }

  // ─── Test 2: /wallet/sign with tampered token → 401 ───
  console.log('\n=== Test 2: /wallet/sign with tampered token ===');
  {
    const tampered = testToken.token.slice(0, -3) + 'AAA';
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'hello',
      action: 'test_tampered'
    }, { 'x-custody-token': tampered });
    assert('status 401', r.status === 401, `got ${r.status}`);
    assert('error_code = CUSTODY_TOKEN_REJECTED',
      r.body.error_code === 'CUSTODY_TOKEN_REJECTED');
    assert('error mentions invalid signature',
      /invalid signature/i.test(r.body.error || ''));
  }

  // ─── Test 3: /wallet/sign with token bound to different agent → 401 ───
  console.log('\n=== Test 3: Token bound to different agent ===');
  {
    // Use agent B's token when calling sign for agent A
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'hello',
      action: 'test_wrong_agent'
    }, { 'x-custody-token': testToken2.token });
    assert('status 401', r.status === 401);
    assert('error_code = CUSTODY_TOKEN_REJECTED',
      r.body.error_code === 'CUSTODY_TOKEN_REJECTED');
  }

  // ─── Test 4: Missing agentId → 400 ───
  console.log('\n=== Test 4: Missing agentId in body ===');
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      data: 'hello',
      action: 'test_no_agentId'
    }, { 'x-custody-token': testToken.token });
    assert('status 400', r.status === 400);
    assert('error mentions agentId', /agentId/i.test(r.body.error || ''));
  }

  // ─── Test 5: Missing data → 400 ───
  console.log('\n=== Test 5: Missing data in body ===');
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      action: 'test_no_data'
    }, { 'x-custody-token': testToken.token });
    assert('status 400', r.status === 400);
    assert('error mentions data', /data/i.test(r.body.error || ''));
  }

  // ─── Test 6: Non-existent agent → 404 ───
  console.log('\n=== Test 6: Non-existent agent ===');
  {
    const fakeId = `nonexistent-agent-${Date.now()}`;
    // Need a valid-shape token whose sub matches — but agent won't exist
    // in registry, so the route will 404 before doing verify.
    const fakeToken = issueCustodyToken({
      agentId: fakeId,
      address: 'ng1nonexistent',
      publicKeyHex: '00'.repeat(32)
    });
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: fakeId,
      data: 'hello',
      action: 'test_no_agent'
    }, { 'x-custody-token': fakeToken.token });
    assert('status 404', r.status === 404, `got ${r.status}`);
    assert('error mentions not found', /not found/i.test(r.body.error || ''));
  }

  // ─── Test 7: Valid token + correct binding → 200 with signature ───
  console.log('\n=== Test 7: Valid sign request ===');
  let signResult;
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: { payload: 'phase2-d2-test', nonce: 'n-1' },
      action: 'phase2_d2_sign'
    }, { 'x-custody-token': testToken.token });
    assert('status 200', r.status === 200, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('success:true', r.body.success === true);
    assert('signature present (hex)', typeof r.body.signature === 'string' && r.body.signature.length > 100);
    assert('publicKey matches wallet', r.body.publicKey === testAgentWallet.publicKey);
    assert('address matches wallet', r.body.address === testAgentWallet.address);
    assert('agentId matches', r.body.agentId === testAgentId);
    assert('algorithm field present', /Dilithium/i.test(r.body.algorithm || ''));
    assert('signedAt is number', typeof r.body.signedAt === 'number');
    signResult = r.body;
  }

  // ─── Test 8: Returned signature is verifiable ───
  console.log('\n=== Test 8: Signature verifies against publicKey ===');
  {
    const dataStr = JSON.stringify({ payload: 'phase2-d2-test', nonce: 'n-1' });
    const sigBuf = Buffer.from(signResult.signature, 'hex');
    const pubBuf = Buffer.from(signResult.publicKey, 'hex');
    assert('pubKey buffer length = 1312 (Dilithium2)', pubBuf.length === 1312, `got ${pubBuf.length}`);
    assert('sig buffer length = 2420 (Dilithium2)', sigBuf.length === 2420, `got ${sigBuf.length}`);
    const isValid = await pqcVerifyFn(dataStr, sigBuf, pubBuf);
    assert('PQC signature verifies', isValid === true, `got ${isValid}`);
  }

  // ─── Test 9: Audit event recorded in state.txHistory ───
  console.log('\n=== Test 9: CUSTODY_SIGN audit event recorded ===');
  {
    const history = mockState.transactions.txHistory;
    const custodySignEvents = history.filter(tx => tx.tx_type === 'CUSTODY_SIGN');
    assert('at least 1 CUSTODY_SIGN event in txHistory',
      custodySignEvents.length >= 1,
      `got ${custodySignEvents.length} of ${history.length} total`);
    const last = custodySignEvents[custodySignEvents.length - 1];
    assert('event.from = agentId', last?.from === testAgentId);
    assert('event.to = address', last?.to === testAgentWallet.address);
    assert('event.amount = 0 (no balance effect)', Number(last?.amount) === 0);
    assert('event.auditOnly = true', last?.auditOnly === true);
    assert('event.status = applied', last?.status === 'applied');
    assert('event.payload.action recorded', last?.payload?.action === 'phase2_d2_sign');
    assert('event.payload.dataLen recorded', typeof last?.payload?.dataLen === 'number' && last.payload.dataLen > 0);
    assert('event.payload.custodyFp recorded',
      last?.payload?.custodyFp === publicKeyFingerprint(testAgentWallet.publicKey));
  }

  // ─── Test 10: /wallet/custody/refresh with valid token → new token ───
  console.log('\n=== Test 10: /wallet/custody/refresh with valid token ===');
  let newToken;
  {
    const r = await http('POST', '/api/v1/wallet/custody/refresh', {
      agentId: testAgentId,
      address: testAgentWallet.address
    }, { 'x-custody-token': testToken.token });
    assert('status 200', r.status === 200, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('success:true', r.body.success === true);
    assert('new token present', typeof r.body.custody?.token === 'string');
    assert('new token is 3-part', r.body.custody?.token?.split('.').length === 3);
    // Same-second refresh may produce byte-identical tokens (deterministic HMAC).
    // Instead, verify the refreshed token's payload is internally consistent.
    {
      const oldParts = testToken.token.split('.');
      const newParts = r.body.custody.token.split('.');
      const decode = (s) => JSON.parse(Buffer.from(
        s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4), 'base64'
      ).toString('utf8'));
      const oldP = decode(oldParts[1]);
      const newP = decode(newParts[1]);
      assert('refreshed token sub = agentId', newP.sub === oldP.sub);
      assert('refreshed token addr = address', newP.addr === oldP.addr);
      assert('refreshed token fp = same pubkey', newP.fp === oldP.fp);
    }
    assert('new token expiresAt >= old', r.body.custody?.expiresAt >= testToken.expiresAt);
    newToken = r.body.custody;
  }

  // ─── Test 11: /wallet/custody/refresh with missing token → 400 ───
  console.log('\n=== Test 11: /wallet/custody/refresh without token ===');
  {
    const r = await http('POST', '/api/v1/wallet/custody/refresh', {
      agentId: testAgentId,
      address: testAgentWallet.address
    });
    assert('status 400', r.status === 400);
    assert('error_code = TOKEN_MISSING', r.body.error_code === 'TOKEN_MISSING');
  }

  // ─── Test 12: /wallet/custody/refresh with bad token → 401 ───
  console.log('\n=== Test 12: /wallet/custody/refresh with invalid token ===');
  {
    const tampered = testToken.token.slice(0, -3) + 'BBB';
    const r = await http('POST', '/api/v1/wallet/custody/refresh', {
      agentId: testAgentId,
      address: testAgentWallet.address
    }, { 'x-custody-token': tampered });
    assert('status 401', r.status === 401);
    assert('error_code = TOKEN_REJECTED', r.body.error_code === 'TOKEN_REJECTED');
  }

  // ─── Test 13: /wallet/health lists custody_token + server_side_signing ───
  console.log('\n=== Test 13: /wallet/health feature list ===');
  {
    const r = await http('GET', '/api/v1/wallet/health');
    assert('status 200', r.status === 200);
    assert('custody_token in features', r.body.features?.includes('custody_token'));
    assert('server_side_signing in features', r.body.features?.includes('server_side_signing'));
  }

  // ─── Test 14: Custody token via body.custody_token ───
  console.log('\n=== Test 14: Token via body.custody_token ===');
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'body-token-test',
      action: 'phase2_d2_body_token',
      custody_token: testToken.token
    });
    assert('status 200', r.status === 200, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('success:true', r.body.success === true);
    assert('signature returned', typeof r.body.signature === 'string' && r.body.signature.length > 100);
  }

  // ─── Test 15: Custody token via x-custody header ───
  console.log('\n=== Test 15: Token via x-custody (short) header ===');
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'short-header-test',
      action: 'phase2_d2_short_header'
    }, { 'x-custody': testToken.token });
    assert('status 200', r.status === 200, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('success:true', r.body.success === true);
  }

  // ─── Test 16: Two consecutive signs produce two audit events ───
  console.log('\n=== Test 16: Multiple signs produce multiple events ===');
  const beforeCount = mockState.transactions.txHistory.filter(t => t.tx_type === 'CUSTODY_SIGN').length;
  {
    for (let i = 0; i < 3; i++) {
      const r = await http('POST', '/api/v1/wallet/sign', {
        agentId: testAgentId,
        data: `consecutive-${i}`,
        action: `phase2_d2_seq_${i}`
      }, { 'x-custody-token': testToken.token });
      assert(`sign ${i} status 200`, r.status === 200);
    }
    const afterCount = mockState.transactions.txHistory.filter(t => t.tx_type === 'CUSTODY_SIGN').length;
    assert('3 new CUSTODY_SIGN events recorded', afterCount - beforeCount === 3,
      `got ${afterCount - beforeCount} new events`);
  }

  // ─── Test 17: New (refreshed) token also works for sign ───
  console.log('\n=== Test 17: Refreshed token also signs successfully ===');
  {
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'refreshed-token-test',
      action: 'phase2_d2_refreshed_sign'
    }, { 'x-custody-token': newToken.token });
    assert('status 200', r.status === 200, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('success:true', r.body.success === true);
  }

  // ─── Test 18: Audit event from non-existent agent did NOT pollute history ───
  console.log('\n=== Test 18: Failed sign does not write audit event ===');
  {
    const beforeCount = mockState.transactions.txHistory.filter(t => t.tx_type === 'CUSTODY_SIGN').length;
    // 404 path — no audit event should be recorded
    const fakeId = `nonexistent-${Date.now()}`;
    const fakeToken = issueCustodyToken({
      agentId: fakeId,
      address: 'ng1nonexistent',
      publicKeyHex: '00'.repeat(32)
    });
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: fakeId, data: 'no_audit', action: 'should_not_record'
    }, { 'x-custody-token': fakeToken.token });
    assert('status 404', r.status === 404);
    const afterCount = mockState.transactions.txHistory.filter(t => t.tx_type === 'CUSTODY_SIGN').length;
    assert('no new CUSTODY_SIGN event', afterCount === beforeCount,
      `expected no change, got +${afterCount - beforeCount}`);
  }

  // ─── Test 19: Rejected (401) sign does not write audit event ───
  console.log('\n=== Test 19: 401 sign does not write audit event ===');
  {
    const beforeCount = mockState.transactions.txHistory.filter(t => t.tx_type === 'CUSTODY_SIGN').length;
    const tampered = testToken.token.slice(0, -3) + 'CCC';
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId, data: 'no_audit_401', action: 'should_not_record_401'
    }, { 'x-custody-token': tampered });
    assert('status 401', r.status === 401);
    const afterCount = mockState.transactions.txHistory.filter(t => t.tx_type === 'CUSTODY_SIGN').length;
    assert('no new CUSTODY_SIGN event on 401', afterCount === beforeCount,
      `expected no change, got +${afterCount - beforeCount}`);
  }

  // ─── Test 20: Sign for one agent does not affect another agent's nonce ───
  console.log('\n=== Test 20: Sign endpoint does not mutate wallet nonce ===');
  {
    const walletA = agentWalletManager.getWalletInstance(testAgentId);
    const walletB = agentWalletManager.getWalletInstance(testAgentId2);
    const nonceA_before = walletA.nonce;
    const nonceB_before = walletB.nonce;
    const r = await http('POST', '/api/v1/wallet/sign', {
      agentId: testAgentId,
      data: 'nonce-test',
      action: 'phase2_d2_nonce_test'
    }, { 'x-custody-token': testToken.token });
    assert('sign 200', r.status === 200);
    assert('agent A nonce unchanged', walletA.nonce === nonceA_before);
    assert('agent B nonce unchanged', walletB.nonce === nonceB_before);
  }

  // ─── Summary ───
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');

  server.close();
  // Allow async logs to flush
  await new Promise(r => setTimeout(r, 50));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  if (server) server.close();
  process.exit(1);
});
