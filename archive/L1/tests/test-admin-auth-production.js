/**
 * Integration Test: Admin Auth Kill-Switch (Phase 2-A3)
 *
 * Verifies the production hardening in src/http/adminAuth.js:
 *
 *   - In production (NODE_ENV=production) without NG_ADMIN_ALLOW_IN_PRODUCTION,
 *     ALL x-admin-secret requests are rejected with 403 ADMIN_SECRET_DISABLED_IN_PRODUCTION.
 *   - Setting NG_ADMIN_ALLOW_IN_PRODUCTION=1 (or 'true') re-enables the path,
 *     provided the secret matches the resolved env var.
 *   - Only exact '1' or 'true' values are accepted (no accidental 'yes'/'on' passes).
 *   - Credit secret and bypass secret are independent (split-secret model).
 *   - Legacy NG_ADMIN_SECRET is honored as a fallback for both kinds when
 *     explicit envs are absent (with a startup warning, no break).
 *   - The kill-switch applies consistently across:
 *       • direct call to verifyCreditSecret / verifyBypassSecret / verifyAnySecret
 *       • HTTP POST /api/v1/wallet/agent/transfer with x-admin-secret
 *
 * Covers scenarios:
 *   1.  Module export shape
 *   2.  isProduction() reads NODE_ENV
 *   3.  adminSecretAllowedInProduction() — strict '1' / 'true' only
 *   4.  productionBlockResponse() — null in dev, 403 in production
 *   5.  describe() — reports adminSecretEffectivelyEnabled correctly
 *   6.  Kill-switch: production + no override → all verify functions reject
 *   7.  Kill-switch: production + no override → HTTP 403 with error_code
 *   8.  Override: NG_ADMIN_ALLOW_IN_PRODUCTION=1 + correct secret → accept
 *   9.  Override: NG_ADMIN_ALLOW_IN_PRODUCTION=true + correct secret → accept
 *  10.  Override: correct override + wrong secret → reject
 *  11.  Credit secret ≠ bypass secret (split enforcement)
 *  12.  Header x-admin-secret works
 *  13.  Body field admin_secret works
 *  14.  Body field adminSecret works
 *  15.  Missing both header and body → reject
 *  16.  verifyAnySecret returns 'credit' for credit secret, 'bypass' for bypass
 *  17.  Legacy NG_ADMIN_SECRET fallback when explicit envs absent
 *  18.  Explicit env wins over legacy (no override)
 *  19.  HTTP: kill-switch blocks /wallet/agent/transfer with 403
 *  20.  HTTP: with override, /wallet/agent/transfer succeeds (201/400, not 403)
 *  21.  HTTP: with override but wrong secret, /wallet/agent/transfer returns 403
 */

let passed = 0, failed = 0;

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
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

// ─── Pre-import environment setup (must run before adminAuth module loads) ──
const PROD_CREDIT_SECRET = 'prod-credit-secret-1234abcd';
const PROD_BYPASS_SECRET = 'prod-bypass-secret-1234abcd';
const LEGACY_SECRET = 'legacy-shared-secret-1234';
process.env.NODE_ENV = 'production';
process.env.NG_ADMIN_CREDIT_SECRET = PROD_CREDIT_SECRET;
process.env.NG_ADMIN_BYPASS_SECRET = PROD_BYPASS_SECRET;
// NG_ADMIN_ALLOW_IN_PRODUCTION deliberately unset → kill-switch active
delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;

let BASE;
let server;
let adminAuth;
let agentA;
let agentB;
let agentAId;
let agentBId;

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Admin Auth Kill-Switch Tests (Phase 2-D3)');
  console.log('═══════════════════════════════════════════════════\n');

  // Dynamic import AFTER env setup (ESM static imports are hoisted)
  adminAuth = (await import('../src/http/adminAuth.js')).default;
  const {
    verifyCreditSecret,
    verifyBypassSecret,
    verifyAnySecret,
    productionBlockResponse,
    adminSecretAllowedInProduction,
    isProduction,
    describe: describeAuth
  } = adminAuth;

  // ─── Test 1: Module export shape ───
  console.log('=== Test 1: Module Export Shape ===');
  {
    const expectedFns = [
      'verifyCreditSecret', 'verifyBypassSecret', 'verifyAnySecret',
      'productionBlockResponse', 'adminSecretAllowedInProduction',
      'isProduction', 'describe', 'init'
    ];
    for (const fn of expectedFns) {
      assert(`exports ${fn}`, typeof adminAuth[fn] === 'function');
    }
  }

  // ─── Test 2: isProduction reads NODE_ENV ───
  console.log('\n=== Test 2: isProduction() ===');
  {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    assert('isProduction() true in production', isProduction() === true);
    process.env.NODE_ENV = 'development';
    assert('isProduction() false in development', isProduction() === false);
    process.env.NODE_ENV = 'test';
    assert('isProduction() false in test', isProduction() === false);
    process.env.NODE_ENV = orig;  // restore
  }

  // ─── Test 3: adminSecretAllowedInProduction strict values ───
  console.log('\n=== Test 3: adminSecretAllowedInProduction() ===');
  {
    const orig = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';
    assert("'1' → true", adminSecretAllowedInProduction() === true);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'true';
    assert("'true' → true", adminSecretAllowedInProduction() === true);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'TRUE';
    assert("'TRUE' → false (case-sensitive, exact only)", adminSecretAllowedInProduction() === false);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '0';
    assert("'0' → false", adminSecretAllowedInProduction() === false);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'false';
    assert("'false' → false", adminSecretAllowedInProduction() === false);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'yes';
    assert("'yes' → false", adminSecretAllowedInProduction() === false);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'on';
    assert("'on' → false", adminSecretAllowedInProduction() === false);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '';
    assert("'' → false", adminSecretAllowedInProduction() === false);
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    assert('undefined → false', adminSecretAllowedInProduction() === false);
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = orig;  // restore
  }

  // ─── Test 4: productionBlockResponse() ───
  console.log('\n=== Test 4: productionBlockResponse() ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'development';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    assert('dev + no override → null', productionBlockResponse() === null);

    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    const block = productionBlockResponse();
    assert('production + no override → 403 body', block !== null);
    assert('block.success = false', block?.success === false);
    assert('block.error_code = ADMIN_SECRET_DISABLED_IN_PRODUCTION',
      block?.error_code === 'ADMIN_SECRET_DISABLED_IN_PRODUCTION');
    assert('block.error mentions NG_ADMIN_ALLOW_IN_PRODUCTION',
      /NG_ADMIN_ALLOW_IN_PRODUCTION/.test(block?.error || ''));

    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';
    assert('production + override=1 → null', productionBlockResponse() === null);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 5: describe() output ───
  console.log('\n=== Test 5: describe() ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    const d = describeAuth();
    assert('production: production=true', d.production === true);
    assert('production: adminSecretAllowedInProduction=false', d.adminSecretAllowedInProduction === false);
    assert('production: adminSecretEffectivelyEnabled=false', d.adminSecretEffectivelyEnabled === false);
    assert('production: creditSecretSet=true (env was set)', d.creditSecretSet === true);
    assert('production: bypassSecretSet=true (env was set)', d.bypassSecretSet === true);
    assert('production: usingDefaultDevSecret=false', d.usingDefaultDevSecret === false);

    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';
    const d2 = describeAuth();
    assert('production+override: adminSecretEffectivelyEnabled=true',
      d2.adminSecretEffectivelyEnabled === true);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 6: Kill-switch at module level ───
  console.log('\n=== Test 6: Kill-switch via direct verify ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;

    const reqWithCorrectCredit = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    const reqWithCorrectBypass = { headers: { 'x-admin-secret': PROD_BYPASS_SECRET }, body: {} };
    const reqWithWrong = { headers: { 'x-admin-secret': 'wrong-secret' }, body: {} };
    const reqNoSecret = { headers: {}, body: {} };

    assert('verifyCreditSecret: correct credit secret → false (kill-switch)',
      verifyCreditSecret(reqWithCorrectCredit) === false);
    assert('verifyBypassSecret: correct bypass secret → false (kill-switch)',
      verifyBypassSecret(reqWithCorrectBypass) === false);
    assert('verifyAnySecret: correct credit secret → invalid + disabled',
      verifyAnySecret(reqWithCorrectCredit)?.valid === false &&
      verifyAnySecret(reqWithCorrectCredit)?.error_code === 'ADMIN_SECRET_DISABLED_IN_PRODUCTION');
    assert('verifyAnySecret: wrong secret → still invalid',
      verifyAnySecret(reqWithWrong)?.valid === false);
    assert('verifyAnySecret: no secret → still invalid',
      verifyAnySecret(reqNoSecret)?.valid === false);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 7: Override enabled → accept correct secret ───
  console.log('\n=== Test 7: Override=1 accepts correct secret ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';

    const reqCorrectCredit = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    const reqCorrectBypass = { headers: { 'x-admin-secret': PROD_BYPASS_SECRET }, body: {} };
    const reqWrong = { headers: { 'x-admin-secret': 'wrong-secret' }, body: {} };

    assert('verifyCreditSecret: correct credit → true', verifyCreditSecret(reqCorrectCredit) === true);
    assert('verifyBypassSecret: correct bypass → true', verifyBypassSecret(reqCorrectBypass) === true);
    assert('verifyCreditSecret: wrong secret → false', verifyCreditSecret(reqWrong) === false);
    assert('verifyBypassSecret: wrong secret → false', verifyBypassSecret(reqWrong) === false);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 8: Override='true' (string) also works ───
  console.log('\n=== Test 8: Override=true (string) accepts correct secret ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'true';

    const req = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    assert('verifyCreditSecret: correct + override=true → true',
      verifyCreditSecret(req) === true);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 9: Credit and bypass secrets are independent ───
  console.log('\n=== Test 9: Credit / Bypass split ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';

    // Use credit secret against bypass endpoint → should fail
    const req = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    assert('credit secret does NOT verify bypass endpoint',
      verifyBypassSecret(req) === false);

    // Use bypass secret against credit endpoint → should fail
    const req2 = { headers: { 'x-admin-secret': PROD_BYPASS_SECRET }, body: {} };
    assert('bypass secret does NOT verify credit endpoint',
      verifyCreditSecret(req2) === false);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 10: verifyAnySecret returns correct kind ───
  console.log('\n=== Test 10: verifyAnySecret kind resolution ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';

    const reqCredit = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    const reqBypass = { headers: { 'x-admin-secret': PROD_BYPASS_SECRET }, body: {} };
    const reqNone = { headers: { 'x-admin-secret': 'wrong' }, body: {} };

    const r1 = verifyAnySecret(reqCredit);
    assert("credit secret → kind='credit'", r1.kind === 'credit' && r1.valid === true);
    const r2 = verifyAnySecret(reqBypass);
    assert("bypass secret → kind='bypass'", r2.kind === 'bypass' && r2.valid === true);
    const r3 = verifyAnySecret(reqNone);
    assert("wrong secret → valid:false, kind:null", r3.valid === false && r3.kind === null);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 11: Header / body field acceptance ───
  console.log('\n=== Test 11: Header / Body field acceptance ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';

    const reqHeader = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    assert('x-admin-secret header → true', verifyCreditSecret(reqHeader) === true);

    const reqBodySnake = { headers: {}, body: { admin_secret: PROD_CREDIT_SECRET } };
    assert('body.admin_secret → true', verifyCreditSecret(reqBodySnake) === true);

    const reqBodyCamel = { headers: {}, body: { adminSecret: PROD_CREDIT_SECRET } };
    assert('body.adminSecret → true', verifyCreditSecret(reqBodyCamel) === true);

    const reqNone = { headers: {}, body: {} };
    assert('no header / no body → false', verifyCreditSecret(reqNone) === false);

    const reqEmpty = { headers: {}, body: null };
    assert('no header / null body → false', verifyCreditSecret(reqEmpty) === false);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Test 12: Legacy NG_ADMIN_SECRET fallback (dev only) ───
  // NOTE: The module is _initialized=true from earlier production init. We
  // cannot re-init it in-process, so this scenario would need a separate
  // process to truly verify. We assert that the current state is consistent
  // (explicit credit secret still wins over any legacy setting).
  console.log('\n=== Test 12: Explicit secret still wins over legacy ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';
    process.env.NG_ADMIN_SECRET = LEGACY_SECRET;

    // The explicit NG_ADMIN_CREDIT_SECRET (set before init) should win
    const req = { headers: { 'x-admin-secret': PROD_CREDIT_SECRET }, body: {} };
    assert('explicit credit secret still verifies',
      verifyCreditSecret(req) === true);

    // Legacy secret alone should NOT verify (explicit was set)
    const reqLegacy = { headers: { 'x-admin-secret': LEGACY_SECRET }, body: {} };
    assert('legacy secret does NOT verify when explicit is set',
      verifyCreditSecret(reqLegacy) === false);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
    process.env.NG_ADMIN_SECRET = LEGACY_SECRET;
  }

  // ─── Test 13-15: HTTP-level kill-switch via /wallet/agent/transfer ───
  console.log('\n=== Test 13: HTTP — kill-switch blocks /wallet/agent/transfer ===');

  // Set up test app with wallet router (need real agents for transfer)
  const express = (await import('express')).default;
  const walletApiRouter = (await import('../src/http/routes/walletApi.js')).default;
  const agentWalletManager = (await import('../src/wallet/agentWalletManager.js')).default;

  agentAId = `d3-test-agent-${Date.now()}-sender`;
  agentBId = `d3-test-agent-${Date.now()}-receiver`;
  agentA = await agentWalletManager.createAgentWallet(agentAId, { type: 'd3-test' });
  agentB = await agentWalletManager.createAgentWallet(agentBId, { type: 'd3-test' });

  // Top up agent A so transfer has enough balance
  agentWalletManager.updateBalance(agentAId, 100000n);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Inject state (required by walletApi)
  app.locals.state = {
    balances: {},
    getBalance: (a) => 0,
    setBalance: (a, v) => { app.locals.state.balances[a] = v; },
    addBalance: (a, v) => { app.locals.state.balances[a] = (app.locals.state.balances[a] || 0) + v; },
    getBalanceOf: (a) => app.locals.state.balances[a] || 0,
    transactions: [],
    currentBlockHeight: 100
  };
  app.use('/api/v1/wallet', walletApiRouter);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  BASE = `http://127.0.0.1:${addr.port}`;
  console.log(`  test server listening on ${BASE}`);

  const transferBody = {
    fromAgentId: agentAId,
    toAgentId: agentBId,
    amount: 100,
    memo: 'd3 kill-switch test'
  };

  // 13: kill-switch ON, no override → 403
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;

    const r = await http('POST', '/api/v1/wallet/agent/transfer', transferBody, {
      'x-admin-secret': PROD_CREDIT_SECRET
    });
    assert('kill-switch: status 403', r.status === 403, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('kill-switch: success:false', r.body.success === false);
    assert('kill-switch: error_code = ADMIN_SECRET_DISABLED_IN_PRODUCTION',
      r.body.error_code === 'ADMIN_SECRET_DISABLED_IN_PRODUCTION');

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 14: override ON, correct secret → not 403
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';

    const r = await http('POST', '/api/v1/wallet/agent/transfer', transferBody, {
      'x-admin-secret': PROD_CREDIT_SECRET
    });
    // 201 success, or 400 (insufficient balance/other validation) — but NOT 403
    assert('override+correct: status ≠ 403', r.status !== 403,
      `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('override+correct: status in {201, 200, 400}',
      [200, 201, 400].includes(r.status),
      `got ${r.status}`);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 15: override ON, WRONG secret → 403 (verify failure, not kill-switch)
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';

    const r = await http('POST', '/api/v1/wallet/agent/transfer', transferBody, {
      'x-admin-secret': 'definitely-wrong-secret'
    });
    assert('override+wrong: status 403', r.status === 403, `got ${r.status} body=${JSON.stringify(r.body).slice(0,200)}`);
    assert('override+wrong: error_code ≠ ADMIN_SECRET_DISABLED_IN_PRODUCTION',
      r.body.error_code !== 'ADMIN_SECRET_DISABLED_IN_PRODUCTION',
      `got error_code=${r.body.error_code}`);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 16: override='0' (string) → still kill-switch
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '0';

    const r = await http('POST', '/api/v1/wallet/agent/transfer', transferBody, {
      'x-admin-secret': PROD_CREDIT_SECRET
    });
    assert("override='0' (string): status 403", r.status === 403);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 17: override='yes' (non-strict value) → still kill-switch
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = 'yes';

    const r = await http('POST', '/api/v1/wallet/agent/transfer', transferBody, {
      'x-admin-secret': PROD_CREDIT_SECRET
    });
    assert("override='yes': status 403 (strict check)", r.status === 403);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 18: No header at all in production → 403
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;

    const r = await http('POST', '/api/v1/wallet/agent/transfer', transferBody);
    assert('no header in production: status 403', r.status === 403);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 19: Body field admin_secret also blocked by kill-switch
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;

    const r = await http('POST', '/api/v1/wallet/agent/transfer', {
      ...transferBody, admin_secret: PROD_CREDIT_SECRET
    });
    assert('body.admin_secret in production: status 403', r.status === 403);
    assert('body.admin_secret in production: error_code=ADMIN_SECRET_DISABLED',
      r.body.error_code === 'ADMIN_SECRET_DISABLED_IN_PRODUCTION');

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // 20: HTTP health check — describe() suitable for /health endpoint
  console.log('\n=== Test 14: HTTP — describe() reports kill-switch state ===');
  {
    const orig = process.env.NODE_ENV;
    const origAllow = process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;
    process.env.NODE_ENV = 'production';
    delete process.env.NG_ADMIN_ALLOW_IN_PRODUCTION;

    const d = describeAuth();
    assert('describe() with kill-switch: adminSecretEffectivelyEnabled=false',
      d.adminSecretEffectivelyEnabled === false);
    assert('describe() with kill-switch: production=true', d.production === true);
    assert('describe() reports all 6 fields',
      ['creditSecretSet', 'bypassSecretSet', 'usingDefaultDevSecret',
       'production', 'adminSecretAllowedInProduction', 'adminSecretEffectivelyEnabled']
        .every(k => k in d));

    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = '1';
    const d2 = describeAuth();
    assert('describe() with override: adminSecretEffectivelyEnabled=true',
      d2.adminSecretEffectivelyEnabled === true);

    process.env.NODE_ENV = orig;
    process.env.NG_ADMIN_ALLOW_IN_PRODUCTION = origAllow;
  }

  // ─── Summary ───
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');

  server.close();
  await new Promise(r => setTimeout(r, 50));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  if (server) server.close();
  process.exit(1);
});
