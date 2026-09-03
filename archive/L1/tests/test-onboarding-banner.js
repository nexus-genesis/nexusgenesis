/**
 * Phase 2-A4: Frontend Banner End-to-End Test
 *
 * Verifies:
 *   1. GET /api/v1/wallet/agent/:id/security-status returns needsOnboarding=true
 *   2. POST /api/v1/wallet/agent/:id/onboarding/complete with admin secret works
 *   3. After completion, security-status returns needsOnboarding=false
 *   4. The dashboard.html references the correct element IDs
 *   5. The 3 modal actions (backup/transfer/waive) all map to correct methods
 *
 * This test does NOT exercise browser DOM (that needs a headless browser);
 * it validates the API contract that the banner code depends on.
 */

import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const HTTP_PORT = process.env.HTTP_PORT || '19891';
const TEST_AGENT = 'agent-X-001';
const ADMIN_SECRET = process.env.NG_ADMIN_CREDIT_SECRET || 'devnet-endow-2026';

let testsRun = 0;
let testsPassed = 0;

function test(name, fn) {
  testsRun++;
  return Promise.resolve()
    .then(() => fn())
    .then(() => { testsPassed++; console.log(`  ✓ ${name}`); })
    .catch(e => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; });
}

function httpReq(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: Number(HTTP_PORT),
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

console.log('═'.repeat(60));
console.log(' Phase 2-A4: Frontend Banner API Contract Test');
console.log('═'.repeat(60));
console.log(`  HTTP endpoint: http://localhost:${HTTP_PORT}`);
console.log(`  Test agent: ${TEST_AGENT}`);
console.log('');

console.log('─── 1. GET security-status returns the banner payload ──');

await test('security-status returns 200 + needsOnboarding=true', async () => {
  const r = await httpReq('GET', `/api/v1/wallet/agent/${TEST_AGENT}/security-status`);
  assert.strictEqual(r.status, 200, `status=${r.status}, body=${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.needsOnboarding, true,
    `agent has 7888 NGEN > 100 threshold, expected needsOnboarding=true, got ${JSON.stringify(r.body)}`);
  assert.ok(['high', 'medium', 'low'].includes(r.body.riskLevel),
    `riskLevel should be valid, got ${r.body.riskLevel}`);
  assert.ok(Array.isArray(r.body.suggestedActions), 'suggestedActions should be array');
  assert.strictEqual(r.body.suggestedActions.length, 3, 'should have 3 suggested actions');
});

await test('suggestedActions contains all 3 method types', async () => {
  const r = await httpReq('GET', `/api/v1/wallet/agent/${TEST_AGENT}/security-status`);
  const methods = r.body.suggestedActions.map(a => a.method).sort();
  assert.deepStrictEqual(methods, ['backup', 'transfer', 'waive'],
    `expected [backup, transfer, waive], got ${JSON.stringify(methods)}`);
});

await test('security-status for unknown agent returns 404', async () => {
  const r = await httpReq('GET', '/api/v1/wallet/agent/agent-DOES-NOT-EXIST-12345/security-status');
  assert.strictEqual(r.status, 404, 'unknown agent should 404 (not show banner)');
});

console.log('');
console.log('─── 2. POST onboarding/complete with admin secret ──');

await test('POST without admin secret returns 403', async () => {
  const r = await httpReq('POST',
    `/api/v1/wallet/agent/${TEST_AGENT}/onboarding/complete`,
    {},
    { method: 'backup' }
  );
  assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
  assert.ok(/admin/i.test(r.body.error || ''), 'error should mention admin');
});

await test('POST with wrong admin secret returns 403', async () => {
  const r = await httpReq('POST',
    `/api/v1/wallet/agent/${TEST_AGENT}/onboarding/complete`,
    { 'x-admin-secret': 'wrong-secret-1234567890' },
    { method: 'backup' }
  );
  assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
});

await test('POST with valid admin secret + method=backup succeeds', async () => {
  const r = await httpReq('POST',
    `/api/v1/wallet/agent/${TEST_AGENT}/onboarding/complete`,
    { 'x-admin-secret': ADMIN_SECRET },
    { method: 'backup' }
  );
  assert.strictEqual(r.status, 200, `expected 200, got ${r.status}, body=${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.status, 'backed_up', 'status should be backed_up');
  assert.strictEqual(r.body.method, 'backup');
});

await test('After completion, security-status returns needsOnboarding=false', async () => {
  const r = await httpReq('GET', `/api/v1/wallet/agent/${TEST_AGENT}/security-status`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.needsOnboarding, false,
    `after backup, banner should NOT show, got needsOnboarding=${r.body.needsOnboarding}`);
  assert.strictEqual(r.body.status, 'backed_up');
  assert.deepStrictEqual(r.body.suggestedActions, [],
    'terminal status should not return suggestedActions');
  assert.strictEqual(r.body.riskLevel, 'low', 'completed status = low risk');
});

console.log('');
console.log('─── 3. dashboard.html structure validation ──');

const dashboardPath = path.join(projectRoot, 'public', 'dashboard.html');
const dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');

await test('dashboard.html contains onboarding banner container', () => {
  assert.ok(dashboardHtml.includes('id="onboardingBanner"'),
    'expected #onboardingBanner element');
});

await test('dashboard.html contains all 3 banner action buttons', () => {
  assert.ok(dashboardHtml.includes('id="onbBtnBackup"'), 'missing backup button');
  assert.ok(dashboardHtml.includes('id="onbBtnTransfer"'), 'missing transfer button');
  assert.ok(dashboardHtml.includes('id="onbBtnWaive"'), 'missing waive button');
});

await test('dashboard.html contains modal backdrop + content', () => {
  assert.ok(dashboardHtml.includes('id="onbModalBackdrop"'), 'missing modal backdrop');
  assert.ok(dashboardHtml.includes('id="onbModalContent"'), 'missing modal content');
});

await test('dashboard.html includes initOnboardingBanner() call', () => {
  assert.ok(/initOnboardingBanner\s*\(\s*\)/.test(dashboardHtml),
    'expected initOnboardingBanner() call in DOMContentLoaded');
});

await test('dashboard.html fetches /security-status from the right endpoint', () => {
  assert.ok(/\/api\/v1\/wallet\/agent\/\$\{encodeURIComponent\(agentId\)\}\/security-status/.test(dashboardHtml),
    'expected security-status fetch with encoded agentId');
});

await test('dashboard.html posts to /onboarding/complete', () => {
  assert.ok(/\/api\/v1\/wallet\/agent\/\$\{encodeURIComponent\(ctx\.agentId\)\}\/onboarding\/complete/.test(dashboardHtml),
    'expected onboarding/complete POST endpoint');
});

await test('dashboard.html sends x-admin-secret header', () => {
  assert.ok(/'x-admin-secret':\s*secret/.test(dashboardHtml),
    'expected x-admin-secret header in submit handler');
});

await test('dashboard.html reads agent from localStorage nexusgenesis_agent_identity', () => {
  assert.ok(/localStorage\.getItem\(['"]nexusgenesis_agent_identity['"]\)/.test(dashboardHtml),
    'expected to read agent identity from localStorage');
});

await test('dashboard.html handles ADMIN_SECRET_DISABLED_IN_PRODUCTION', () => {
  assert.ok(dashboardHtml.includes('ADMIN_SECRET_DISABLED_IN_PRODUCTION'),
    'expected kill-switch error_code handling');
});

console.log('');
console.log('─── 4. Re-trigger scenario (post-completion) ──');

await test('waive method on already-completed agent: idempotent (still 200)', async () => {
  // After backup, calling again with any valid method should still succeed
  // (markOnboardingComplete unconditionally writes; not idempotent in the strict
  // sense, but should not error). Real-world: dashboard won't re-show banner.
  const r = await httpReq('POST',
    `/api/v1/wallet/agent/${TEST_AGENT}/onboarding/complete`,
    { 'x-admin-secret': ADMIN_SECRET },
    { method: 'waive' }
  );
  assert.strictEqual(r.status, 200, `expected 200, got ${r.status}`);
  // Method should now be 'waive' since it overwrote
  assert.strictEqual(r.body.status, 'waived');
});

console.log('');
console.log('═'.repeat(60));
console.log(` Result: ${testsPassed}/${testsRun} tests passed`);
console.log('═'.repeat(60));
if (testsPassed !== testsRun) {
  console.error('FAILED');
  process.exit(1);
}
console.log('OK — Phase 2-A4 banner API contract validated.');
