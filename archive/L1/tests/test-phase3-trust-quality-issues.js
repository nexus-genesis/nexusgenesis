/**
 * Phase 3 test: Progressive Trust + Quality Score + Issues + Decay
 *
 * Tests:
 *   Layer 1: Trust tier assignment at submission + tier-based verify routing
 *   Layer 2: Quality score multiplier affecting reward payout
 *   Layer 3: Issue submission endpoint + reputation reward
 *   Decay: Decay log query + manual trigger
 */
const BASE = 'http://localhost:19891';
const ADMIN_SECRET = 'devnet-endow-2026';

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
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
}

async function getAgents() {
  const r = await http('GET', '/api/v1/bootstrap/validators?limit=50');
  return r.body.validators || [];
}

async function getAgentReputation(agentIdentity) {
  const r = await http('GET', `/api/v1/agents/milestones?agent_identity=${agentIdentity}`);
  return r.body?.stats?.tasksCompleted || 0;
}

async function publishTask(publisher, reward = '100') {
  const r = await http('POST', '/api/tasks', {
    agent_identity: publisher,
    title: `Phase3 test ${Date.now()}`,
    description: 'Phase 3 progressive trust test task',
    requiredCapabilities: ['general'],
    taskType: 'analysis',
    reward
  }, { 'x-admin-secret': ADMIN_SECRET });
  return r;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 3 Test: Trust Tiers + Quality + Issues + Decay');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Setup ───
  console.log('=== Setup: find existing agents ===');
  const agents = await getAgents();
  if (agents.length < 3) {
    console.log('  SKIP: need at least 3 existing agents');
    return;
  }

  // Pick publisher with HIGH balance and claimant with HIGH reputation (Tier 1+)
  // validator17832596467733: rep=10, balance=1349 (good publisher)
  // validator17833387151993: rep=28, balance=9 (good claimant)
  const publisher = 'validator17832596467733';
  const claimant = 'validator17833387151993';
  const sorted = agents
    .map(a => ({ identity: a.agent_identity, rep: a.reputation || 0 }))
    .sort((a, b) => b.rep - a.rep);
  const independent = sorted[2]?.identity || claimant;

  console.log(`  publisher (${agents.find(a=>a.agent_identity===publisher)?.reputation||'?'}):  ${publisher}`);
  console.log(`  claimant (${agents.find(a=>a.agent_identity===claimant)?.reputation||'?'}):   ${claimant}`);
  console.log(`  independent (${sorted[2]?.rep || '?'}): ${independent}`);

  const pubRep = await getAgentReputation(publisher);
  const claimantRep = await getAgentReputation(claimant);
  console.log(`  publisher tasksCompleted: ${pubRep}`);
  console.log(`  claimant tasksCompleted: ${claimantRep}`);

  // ─── Layer 1: Trust tier assignment ───
  console.log('\n=== Layer 1 Test 1: Task gets trustTier at submission ===');
  const tpub = await publishTask(publisher, '200');
  assert('task published', tpub.body.success === true, `err=${tpub.body.error}`);
  const taskId = tpub.body.task?.id;
  console.log(`  task: ${taskId}`);

  if (taskId) {
    const claimRes = await http('POST', `/api/tasks/${taskId}/claim`, {
      agent_identity: claimant
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('task claimed', claimRes.body.success === true, `err=${claimRes.body.error_code}`);

    const subRes = await http('POST', `/api/tasks/${taskId}/submit`, {
      agent_identity: claimant,
      submission: { type: 'analysis', result: 'done', proof: 'proof-1' }
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('task submitted', subRes.body.success === true, `err=${subRes.body.error}`);

    // Check trustTier is set on the task
    const taskDetail = await http('GET', `/api/tasks/${taskId}`);
    const task = taskDetail.body.task || subRes.body.task;
    assert('task has trustTier field', task?.trustTier !== undefined, `trustTier=${task?.trustTier}`);
    assert('task has trustTierLevel field', task?.trustTierLevel !== undefined, `level=${task?.trustTierLevel}`);
    console.log(`  trustTier: ${task?.trustTier} (level ${task?.trustTierLevel})`);

    // ─── Layer 1+2: Verify with qualityScore ───
    console.log('\n=== Layer 1+2 Test 2: Verify with qualityScore affects reward ===');
    const claimantBalanceBefore = await http('GET', `/api/v1/agents/balance?agent_identity=${claimant}`);
    const balanceBefore = BigInt(claimantBalanceBefore.body.balance || '0');
    console.log(`  claimant balance before: ${balanceBefore.toString()} NGEN`);

    const verifyRes = await http('POST', `/api/tasks/${taskId}/verify`, {
      agent_identity: publisher,
      approved: true,
      feedback: 'quality test',
      qualityScore: 5
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('verify with qualityScore=5 succeeds', verifyRes.body.success === true, `err=${verifyRes.body.error}`);

    const completedTask = verifyRes.body.task;
    assert('task has qualityScore field', completedTask?.qualityScore === 5, `qs=${completedTask?.qualityScore}`);
    assert('task has rewardMultiplier field', completedTask?.rewardMultiplier === 1.25, `mult=${completedTask?.rewardMultiplier}`);
    assert('task has adjustedReward field', completedTask?.adjustedReward !== undefined, `adj=${completedTask?.adjustedReward}`);

    // adjustedReward should be 200 * 1.25 = 250
    const expectedAdj = BigInt(200) * 125n / 100n;
    assert('adjustedReward = 200 * 1.25 = 250', completedTask?.adjustedReward === expectedAdj.toString(),
      `expected=${expectedAdj.toString()}, got=${completedTask?.adjustedReward}`);
    console.log(`  reward: ${completedTask?.reward} → adjusted: ${completedTask?.adjustedReward} (1.25x)`);
  }

  // ─── Layer 2: Quality score = 1 (0.5x) ───
  console.log('\n=== Layer 2 Test 3: Low quality score reduces reward ===');
  const t2pub = await publishTask(publisher, '100');
  const t2id = t2pub.body.task?.id;
  assert('task 2 published', t2pub.body.success === true);

  if (t2id) {
    await http('POST', `/api/tasks/${t2id}/claim`, { agent_identity: claimant }, { 'x-admin-secret': ADMIN_SECRET });
    await http('POST', `/api/tasks/${t2id}/submit`, {
      agent_identity: claimant, submission: { type: 'analysis', result: 'done' }
    }, { 'x-admin-secret': ADMIN_SECRET });

    const v2 = await http('POST', `/api/tasks/${t2id}/verify`, {
      agent_identity: publisher,
      approved: true,
      qualityScore: 1
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('verify with qualityScore=1 succeeds', v2.body.success === true, `err=${v2.body.error}`);

    // adjustedReward should be 100 * 0.5 = 50
    const expectedAdj2 = BigInt(100) * 50n / 100n;
    assert('adjustedReward = 100 * 0.5 = 50', v2.body.task?.adjustedReward === expectedAdj2.toString(),
      `expected=${expectedAdj2.toString()}, got=${v2.body.task?.adjustedReward}`);
    console.log(`  reward: ${v2.body.task?.reward} → adjusted: ${v2.body.task?.adjustedReward} (0.5x)`);
  }

  // ─── Layer 2: Default quality score = 3 (1.0x) ───
  console.log('\n=== Layer 2 Test 4: Default quality score = 3 (1.0x) ===');
  const t3pub = await publishTask(publisher, '100');
  const t3id = t3pub.body.task?.id;

  if (t3id) {
    await http('POST', `/api/tasks/${t3id}/claim`, { agent_identity: claimant }, { 'x-admin-secret': ADMIN_SECRET });
    await http('POST', `/api/tasks/${t3id}/submit`, {
      agent_identity: claimant, submission: { type: 'analysis', result: 'done' }
    }, { 'x-admin-secret': ADMIN_SECRET });

    const v3 = await http('POST', `/api/tasks/${t3id}/verify`, {
      agent_identity: publisher,
      approved: true
      // no qualityScore → should default to 3
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('verify without qualityScore succeeds', v3.body.success === true, `err=${v3.body.error}`);

    assert('default qualityScore = 3', v3.body.task?.qualityScore === 3, `qs=${v3.body.task?.qualityScore}`);
    assert('default multiplier = 1.0', v3.body.task?.rewardMultiplier === 1.0, `mult=${v3.body.task?.rewardMultiplier}`);
    // adjustedReward should equal base reward (100 * 1.0 = 100)
    assert('adjustedReward = 100 (no change)', v3.body.task?.adjustedReward === '100',
      `adj=${v3.body.task?.adjustedReward}`);
    console.log(`  reward: ${v3.body.task?.reward} → adjusted: ${v3.body.task?.adjustedReward} (1.0x)`);
  }

  // ─── Layer 3: Issues endpoint ───
  console.log('\n=== Layer 3 Test 5: Submit issue via POST /api/issues ===');
  const issueRes = await http('POST', '/api/issues', {
    agent_identity: claimant,
    title: 'Phase 3 test issue: API rate limiter too aggressive',
    description: 'When an agent makes more than 10 requests per second, the rate limiter blocks all subsequent requests for 60 seconds. This is too aggressive for batch task processing.',
    category: 'bug_report',
    severity: 'medium',
    related_task_id: taskId || null
  }, { 'x-admin-secret': ADMIN_SECRET });
  assert('issue submitted', issueRes.body.success === true, `err=${issueRes.body.error}`);
  assert('issue has id', issueRes.body.issue?.id !== undefined, `id=${issueRes.body.issue?.id}`);
  assert('issue has status open', issueRes.body.issue?.status === 'open', `status=${issueRes.body.issue?.status}`);
  assert('reputation awarded', issueRes.body.reputationAwarded === true, `awarded=${issueRes.body.reputationAwarded}`);
  const issueId = issueRes.body.issue?.id;
  console.log(`  issue: ${issueId} (cat=bug_report, sev=medium)`);

  // ─── Layer 3: List issues ───
  console.log('\n=== Layer 3 Test 6: List issues via GET /api/issues ===');
  const listRes = await http('GET', '/api/issues?limit=10');
  assert('list returns 200', listRes.status === 200);
  assert('list has issues array', Array.isArray(listRes.body.issues));
  assert('list includes our issue', listRes.body.issues.some(i => i.id === issueId), 'issue not found in list');
  console.log(`  total issues: ${listRes.body.total}`);

  // ─── Layer 3: Get issue by ID ───
  console.log('\n=== Layer 3 Test 7: Get issue by ID ===');
  if (issueId) {
    const detailRes = await http('GET', `/api/issues/${issueId}`);
    assert('detail returns 200', detailRes.status === 200);
    assert('detail has correct id', detailRes.body.issue?.id === issueId);
    assert('detail has reporter', detailRes.body.issue?.reporter !== undefined);
  }

  // ─── Layer 3: Invalid category rejected ───
  console.log('\n=== Layer 3 Test 8: Invalid category rejected ===');
  const badIssue = await http('POST', '/api/issues', {
    agent_identity: claimant,
    title: 'bad category test',
    description: 'should be rejected',
    category: 'invalid_category'
  }, { 'x-admin-secret': ADMIN_SECRET });
  assert('invalid category rejected', badIssue.status === 400, `status=${badIssue.status}`);
  assert('error code is INVALID_CATEGORY', badIssue.body.error_code === 'INVALID_CATEGORY', `code=${badIssue.body.error_code}`);

  // ─── Decay: Query decay log ───
  console.log('\n=== Decay Test 9: Query decay log ===');
  const decayLogRes = await http('GET', '/api/v1/agents/decay');
  assert('decay log returns 200', decayLogRes.status === 200);
  assert('decay log has entries array', Array.isArray(decayLogRes.body.entries));
  assert('decay log has tiers info', decayLogRes.body.tiers !== undefined);
  console.log(`  decay entries: ${decayLogRes.body.total}`);
  console.log(`  tiers: ${JSON.stringify(decayLogRes.body.tiers)}`);

  // ─── Decay: Manual trigger ───
  console.log('\n=== Decay Test 10: Manual decay trigger ===');
  const decayRunRes = await http('POST', '/api/v1/agents/decay/run', {}, { 'x-admin-secret': ADMIN_SECRET });
  assert('decay run returns 200', decayRunRes.status === 200, `status=${decayRunRes.status}`);
  assert('decay run has checked count', decayRunRes.body.checked !== undefined, `checked=${decayRunRes.body.checked}`);
  assert('decay run has decayed count', decayRunRes.body.decayed !== undefined, `decayed=${decayRunRes.body.decayed}`);
  console.log(`  checked: ${decayRunRes.body.checked}, decayed: ${decayRunRes.body.decayed}`);

  // ─── Summary ───
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
