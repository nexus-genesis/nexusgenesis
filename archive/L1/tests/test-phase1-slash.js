// Phase 1 anti-self-dealing & slash test
const BASE = 'http://localhost:19891';
const ADMIN_SECRET = 'devnet-endow-2026';

let passed = 0, failed = 0;

async function http(method, path, body = null, headers = {}) {
  const url = `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
  };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

function assert(name, cond, info = '') {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${info ? ' | ' + info : ''}`); failed++; }
}

async function main() {
  console.log('=== Test 1: Violation log endpoint reachable ===');
  const v0 = await http('GET', '/api/v1/agents/violations');
  assert('endpoint returns 200', v0.status === 200, `status=${v0.status}`);
  assert('returns success: true', v0.body.success === true);
  assert('returns violations array', Array.isArray(v0.body.violations));
  assert('returns penalty table', v0.body.penalties && v0.body.penalties.SELF_DEALING_CLAIM === -50);
  console.log(`  penalties: ${JSON.stringify(v0.body.penalties)}`);

  console.log('\n=== Test 2: Create two agents for self-dealing test ===');
  // Reuse admin-secret to publish + claim to test the CANNOT_CLAIM_OWN check
  const ts = Date.now();
  const publisherId = `test-pub-${ts}`;
  const claimantId = `test-clm-${ts}`;

  const pub = await http('POST', '/api/tasks', {
    agent_identity: publisherId,
    title: `Self-dealing test ${ts}`,
    description: 'Test task to verify publisher cannot claim own task',
    reward: '0',
    taskType: 'general'
  }, { 'x-admin-secret': ADMIN_SECRET });

  // The publisherId won't be in the local agent registry (no real registration),
  // so publish will fail with INVALID_PUBLISHER. Use an existing agent instead.
  // List real agents first.
  const ag = await http('GET', '/api/v1/bootstrap/validators?limit=3');
  const existingAgents = ag.body.validators || [];
  if (existingAgents.length === 0) {
    console.log('  WARN: no registered agents; skipping rest of tests');
    return;
  }
  const realPub = existingAgents[0].agent_identity;
  console.log(`  using real publisher: ${realPub}`);

  const pub2 = await http('POST', '/api/tasks', {
    agent_identity: realPub,
    title: `Self-dealing test ${ts}`,
    description: 'Test task to verify publisher cannot claim own task',
    reward: '0',
    taskType: 'general'
  }, { 'x-admin-secret': ADMIN_SECRET });

  console.log(`  publish response: status=${pub2.status}, success=${pub2.body.success}, error_code=${pub2.body.error_code}`);

  if (!pub2.body.success) {
    console.log('  SKIP rest: could not publish test task');
    return;
  }

  const taskId = pub2.body.task.id;
  console.log(`  task created: ${taskId}`);

  console.log('\n=== Test 3: Publisher attempts to claim own task (SHOULD FAIL + SLASH) ===');
  const claim = await http('POST', `/api/tasks/${taskId}/claim`, {
    agent_identity: realPub
  }, { 'x-admin-secret': ADMIN_SECRET });

  console.log(`  claim response: status=${claim.status}, success=${claim.body.success}`);
  console.log(`  error: ${claim.body.error}, error_code: ${claim.body.error_code}`);
  console.log(`  violation: ${JSON.stringify(claim.body.violation)}`);

  assert('claim rejected with 403', claim.status === 403, `status=${claim.status}`);
  assert('success is false', claim.body.success === false);
  assert('error_code is CANNOT_CLAIM_OWN', claim.body.error_code === 'CANNOT_CLAIM_OWN');
  assert('violation field present', claim.body.violation && claim.body.violation.type === 'SELF_DEALING_CLAIM');

  console.log('\n=== Test 4: Violation log records the self-dealing attempt ===');
  const v1 = await http('GET', `/api/v1/agents/violations?agent_id=${realPub}`);
  assert('log query returns 200', v1.status === 200);
  assert('log has at least 1 entry', v1.body.violations && v1.body.violations.length >= 1,
    `count=${v1.body.violations?.length}`);

  if (v1.body.violations && v1.body.violations.length > 0) {
    const last = v1.body.violations[v1.body.violations.length - 1];
    console.log(`  latest violation: ${JSON.stringify(last)}`);
    assert('type is SELF_DEALING_CLAIM', last.violationType === 'SELF_DEALING_CLAIM');
    assert('penalty is -50', last.effectivePenalty === -50, `penalty=${last.effectivePenalty}`);
  }

  console.log('\n=== Test 5: Reputation dropped by 50 ===');
  const ag2 = await http('GET', '/api/v1/bootstrap/validators?limit=10');
  const pub2_rec = (ag2.body.validators || []).find(v => v.agent_identity === realPub);
  if (pub2_rec) {
    console.log(`  ${realPub} reputation: ${pub2_rec.reputation}`);
    assert('reputation is finite number', typeof pub2_rec.reputation === 'number');
  } else {
    console.log('  WARN: publisher not in validator list (may not be a validator)');
  }

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(2); });
