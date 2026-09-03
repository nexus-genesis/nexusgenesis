/**
 * Test: Genesis Reserve Multi-Sig (3-of-5)
 *
 * Tests:
 *   1. Propose a spend from Genesis Reserve
 *   2. Sign by 2 signers → pending
 *   3. Sign by 3rd signer → auto-executes
 *   4. Test rejection flow (2 rejections → rejected)
 *   5. Test cancel flow (no confirmations yet)
 *   6. Verify API endpoints
 */

const BASE = 'http://localhost:19891';
let passed = 0, failed = 0;

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

function assert(name, cond, info = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${info ? ' | ' + info : ''}`); failed++; }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Genesis Reserve Multi-Sig (3-of-5) Tests');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Test 1: Propose a spend (small amount to avoid reserve balance issues) ───
  console.log('=== Test 1: Propose Spend ===');
  const propose = await http('POST', '/api/v1/genesis-reserve/propose', {
    milestoneBlock: 1000,
    amount: '100',
    recipient: 'ng11cefTZvjm7u5kjhJDcrysfDu3U1LjjxFNZoXmmTv9taSFhEbsJ',
    purpose: 'Test propose',
    justification: 'Test only — small amount to verify multi-sig flow',
    expectedBenefit: 'Test flow validation',
    duration: 'test',
    riskAssessment: 'none'
  });
  if (!propose.body?.success) {
    console.log('  DEBUG propose error:', JSON.stringify(propose.body).slice(0, 300));
  }
  assert('propose succeeds', propose.body?.success === true);
  const proposalId = propose.body?.proposal?.id || propose.body?.proposalId;
  assert('has proposalId', !!proposalId);
  console.log(`  proposalId: ${proposalId}\n`);

  // ─── Test 2: Sign by 2 signers → pending ───
  console.log('=== Test 2: Sign by 2 Signers (Pending) ===');
  const sign1 = await http('POST', '/api/v1/genesis-reserve/sign', {
    signerAgentId: 'swarm-atlas',
    proposalId
  });
  assert('first sign succeeds', sign1.body?.success === true);

  const sign2 = await http('POST', '/api/v1/genesis-reserve/sign', {
    signerAgentId: 'swarm-beacon',
    proposalId
  });
  assert('second sign succeeds', sign2.body?.success === true);
  assert('still pending (2/3)', sign2.body?.status?.includes('2/3'));

  // Verify via API
  const list = await http('GET', '/api/v1/genesis-reserve/proposals');
  assert('list proposals succeeds', list.body?.success === true);
  assert('proposal count >= 1', (list.body?.proposals || []).length >= 1);
  console.log(`  proposals listed: ${list.body?.count}\n`);

  // ─── Test 3: Sign by 3rd signer → auto-execute ───
  console.log('=== Test 3: 3rd Sign → Auto-Execute ===');
  const sign3 = await http('POST', '/api/v1/genesis-reserve/sign', {
    signerAgentId: 'observer_agent',
    proposalId
  });
  assert('third sign succeeds', sign3.body?.success === true);
  assert('status is executed', sign3.body?.status === 'executed' || sign3.body?.proposal?.status === 'executed');

  // Get single proposal detail
  const detail = await http('GET', `/api/v1/genesis-reserve/proposals/${proposalId}`);
  assert('get proposal detail succeeds', detail.body?.success === true);
  assert('detail status is executed', detail.body?.proposal?.status === 'executed');
  console.log(`  executed: ${detail.body?.proposal?.txHash}\n`);

  // ─── Test 4: Reject flow ───
  console.log('=== Test 4: Reject Flow ===');
  const propose2 = await http('POST', '/api/v1/genesis-reserve/propose', {
    milestoneBlock: 10000,
    amount: '100',
    recipient: 'ng1test000000000000000000000000000000000',
    purpose: 'Test reject',
    justification: 'Testing rejection flow'
  });
  assert('second propose succeeds', propose2.body?.success === true);
  const proposalId2 = propose2.body?.proposal?.id;

  const reject1 = await http('POST', '/api/v1/genesis-reserve/reject', {
    signerAgentId: 'swarm-atlas',
    proposalId: proposalId2,
    reason: 'Not ready yet'
  });
  assert('first rejection succeeds', reject1.body?.success === true);

  const reject2 = await http('POST', '/api/v1/genesis-reserve/reject', {
    signerAgentId: 'swarm-beacon',
    proposalId: proposalId2,
    reason: 'Still not ready'
  });
  assert('second rejection → rejected', reject2.body?.success === true);
  assert('status is rejected', reject2.body?.status === 'rejected');
  console.log(`  rejected by: 2 signers\n`);

  // ─── Test 5: Cancel flow ───
  console.log('=== Test 5: Cancel Flow ===');
  const propose3 = await http('POST', '/api/v1/genesis-reserve/propose', {
    milestoneBlock: 50000,
    amount: '50',
    recipient: 'ng1test000000000000000000000000000000000',
    purpose: 'Test cancel',
    justification: 'Testing cancel flow'
  });
  assert('third propose succeeds', propose3.body?.success === true);
  const proposalId3 = propose3.body?.proposal?.id;

  const cancel = await http('POST', '/api/v1/genesis-reserve/cancel', {
    signerAgentId: 'swarm-atlas',
    proposalId: proposalId3
  });
  assert('cancel succeeds (no confirmations)', cancel.body?.success === true);
  console.log(`  cancelled proposal: ${proposalId3}\n`);

  // ─── Test 6: Stats & Signers ───
  console.log('=== Test 6: Stats & Signers ===');
  const stats = await http('GET', '/api/v1/genesis-reserve/stats');
  assert('stats succeeds', stats.body?.success === true);
  console.log(`  total proposals: ${stats.body?.stats?.totalProposals}`);
  console.log(`  executed: ${stats.body?.stats?.executed}`);
  console.log(`  rejected: ${stats.body?.stats?.rejected}`);
  console.log(`  cancelled: ${stats.body?.stats?.cancelled}`);

  const signers = await http('GET', '/api/v1/genesis-reserve/signers');
  assert('signers succeeds', signers.body?.success === true);
  console.log(`  signers: ${signers.body?.count}/5\n`);

  // ─── Test 7: Audit Log ───
  console.log('=== Test 7: Audit Log ===');
  const audit = await http('GET', '/api/v1/genesis-reserve/audit-log');
  assert('audit-log succeeds', audit.body?.success === true);
  console.log(`  audit entries: ${audit.body?.count}\n`);

  // ─── Summary ───
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
