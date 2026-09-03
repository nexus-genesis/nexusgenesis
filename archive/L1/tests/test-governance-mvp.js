const BASE = 'http://localhost:19891';
const ADMIN_SECRET = 'devnet-endow-2026';

async function api(method, path, body = null, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET, ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

async function findAgents() {
  const res = await api('GET', '/api/v1/bootstrap/validators?limit=50');
  if (res.body?.validators?.length > 0) {
    return res.body.validators.map(v => ({
      identity: v.agent_identity,
      reputation: v.reputation || 0,
      address: v.address
    }));
  }
  return [];
}

let passed = 0, failed = 0;
function test(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} ${detail ? '| ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Governance MVP Test');
  console.log('═══════════════════════════════════════════════\n');

  const agents = await findAgents();
  if (agents.length < 2) {
    console.log('ERROR: need at least 2 agents');
    process.exit(1);
  }
  const creator = agents[0];
  const voter1 = agents[1];
  const voter2 = agents[2] || agents[0];
  console.log(`  creator: ${creator.identity} (rep=${creator.reputation})`);
  console.log(`  voter1:  ${voter1.identity} (rep=${voter1.reputation})`);
  console.log(`  voter2:  ${voter2.identity} (rep=${voter2.reputation})\n`);

  // ─── Test 1: List proposals endpoint ───
  console.log('=== Test 1: List proposals endpoint ===');
  const listRes = await api('GET', '/api/v1/governance/proposals');
  test('endpoint returns 200', listRes.status === 200, `status=${listRes.status}`);
  test('has success: true', listRes.body?.success === true);
  test('has data array', Array.isArray(listRes.body?.data));
  test('has pagination', !!listRes.body?.pagination);
  console.log();

  // ─── Test 2: Create proposal ───
  console.log('=== Test 2: Create proposal ===');
  const createBody = {
    title: 'Test Proposal - Increase validator rewards',
    body: 'This proposal aims to increase validator rewards by 10% to improve network security.',
    type: 'parameter_change',
    parameters: { rewardMultiplier: 1.1 },
    agent_identity: creator.identity,
    timestamp: Date.now(),
    nonce: 'test-nonce-1',
    signature: 'devnet-bypass'
  };
  const createRes = await api('POST', '/api/v1/governance/proposals', createBody, {
    'x-agent-identity': creator.identity
  });
  test('create returns 201', createRes.status === 201, `status=${createRes.status}`);
  test('success: true', createRes.body?.success === true);
  test('has proposal id', !!createRes.body?.proposal?.id);
  test('status is open', createRes.body?.proposal?.status === 'open');
  const proposalId = createRes.body?.proposal?.id;
  console.log(`  proposal id: ${proposalId}\n`);

  // ─── Test 3: Proposal detail ───
  console.log('=== Test 3: Proposal detail ===');
  const detailRes = await api('GET', `/api/v1/governance/proposals/${proposalId}`);
  test('detail returns 200', detailRes.status === 200);
  test('has correct id', detailRes.body?.data?.id === proposalId);
  test('has creator info', !!detailRes.body?.data?.creatorIdentity);
  console.log();

  // ─── Test 4: Invalid proposal rejected ───
  console.log('=== Test 4: Invalid proposal rejected ===');
  const badRes = await api('POST', '/api/v1/governance/proposals', {
    title: '',
    body: 'test',
    type: 'invalid_type',
    agent_identity: creator.identity,
    timestamp: Date.now(),
    nonce: 'test-nonce-2',
    signature: 'devnet-bypass'
  }, { 'x-agent-identity': creator.identity });
  test('invalid type rejected', badRes.status === 400 || badRes.status === 403, `status=${badRes.status}`);
  console.log();

  // ─── Test 5: Cast vote (voter1) ───
  console.log('=== Test 5: Cast vote (voter1) ===');
  const vote1Res = await api('POST', `/api/v1/governance/proposals/${proposalId}/vote`, {
    choice: 'yes',
    agent_identity: voter1.identity,
    timestamp: Date.now(),
    nonce: 'vote-nonce-1',
    signature: 'devnet-bypass'
  }, { 'x-agent-identity': voter1.identity });
  test('vote returns 200', vote1Res.status === 200, `status=${vote1Res.status}`);
  test('vote recorded', vote1Res.body?.success === true);
  test('has weight', vote1Res.body?.vote?.weight > 0, `weight=${vote1Res.body?.vote?.weight}`);
  console.log(`  vote weight: ${vote1Res.body?.vote?.weight?.toFixed(2)}`);
  console.log();

  // ─── Test 6: Cannot vote twice ───
  console.log('=== Test 6: Cannot vote twice ===');
  const dupRes = await api('POST', `/api/v1/governance/proposals/${proposalId}/vote`, {
    choice: 'no',
    agent_identity: voter1.identity,
    timestamp: Date.now(),
    nonce: 'vote-nonce-dup',
    signature: 'devnet-bypass'
  }, { 'x-agent-identity': voter1.identity });
  test('duplicate vote rejected', dupRes.status === 409, `status=${dupRes.status}`);
  test('error_code: ALREADY_VOTED', dupRes.body?.error_code === 'ALREADY_VOTED');
  console.log();

  // ─── Test 7: Vote tally ───
  console.log('=== Test 7: Vote tally ===');
  const tallyRes = await api('GET', `/api/v1/governance/proposals/${proposalId}/votes`);
  test('tally returns 200', tallyRes.status === 200);
  test('has votes array', Array.isArray(tallyRes.body?.data?.votes));
  test('vote count >= 1', tallyRes.body?.data?.tally?.voteCount >= 1);
  test('has yesWeight', !!tallyRes.body?.data?.tally?.yesWeight);
  console.log(`  yesWeight: ${tallyRes.body?.data?.tally?.yesWeight}`);
  console.log(`  voteCount: ${tallyRes.body?.data?.tally?.voteCount}`);
  console.log();

  // ─── Test 8: Invalid vote choice ───
  console.log('=== Test 8: Invalid vote choice ===');
  if (voter2.identity !== voter1.identity) {
    const badVoteRes = await api('POST', `/api/v1/governance/proposals/${proposalId}/vote`, {
      choice: 'maybe',
      agent_identity: voter2.identity,
      timestamp: Date.now(),
      nonce: 'vote-nonce-bad',
      signature: 'devnet-bypass'
    }, { 'x-agent-identity': voter2.identity });
    test('invalid choice rejected', badVoteRes.status === 400, `status=${badVoteRes.status}`);
    test('error_code: INVALID_CHOICE', badVoteRes.body?.error_code === 'INVALID_CHOICE');
  } else {
    console.log('  SKIP: only one unique agent available');
  }
  console.log();

  // ─── Test 9: Proposal not found ───
  console.log('=== Test 9: Proposal not found ===');
  const notFoundRes = await api('GET', '/api/v1/governance/proposals/prop_nonexistent');
  test('returns 404', notFoundRes.status === 404);
  test('error_code: PROPOSAL_NOT_FOUND', notFoundRes.body?.error_code === 'PROPOSAL_NOT_FOUND');
  console.log();

  // ─── Test 10: Filter proposals by status ───
  console.log('=== Test 10: Filter proposals by status ===');
  const filteredRes = await api('GET', '/api/v1/governance/proposals?status=open');
  test('filter returns 200', filteredRes.status === 200);
  test('all returned are open', filteredRes.body?.data?.every(p => p.status === 'open'));
  console.log();

  console.log('═══════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
