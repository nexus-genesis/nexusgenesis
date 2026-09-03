// Phase 2 test: Milestone system
// Strategy: Publish 11 tasks from one agent, have another claim+submit+verify all 11
// Expected: 1st task triggers 'first_task' milestone, 10th task triggers 'ten_tasks' milestone
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

async function getExistingAgent() {
  const r = await http('GET', '/api/v1/bootstrap/validators?limit=20');
  if (r.body.validators && r.body.validators.length >= 2) {
    return r.body.validators[0].agent_identity;
  }
  return null;
}

async function main() {
  console.log('=== Setup: find existing agents for publisher/claimant ===');
  const pub = await http('GET', '/api/v1/bootstrap/validators?limit=20');
  const all = pub.body.validators || [];
  if (all.length < 2) {
    console.log('  SKIP: need at least 2 existing agents');
    return;
  }
  const publisher = all[0].agent_identity;
  const claimant = all[1].agent_identity;
  console.log(`  publisher: ${publisher}`);
  console.log(`  claimant:  ${claimant}`);

  // Snapshot claimant's NGEN balance and reputation before
  const wallet0 = await http('GET', `/api/v1/agents/balance?agent_identity=${claimant}`);
  console.log(`  claimant initial NGEN: ${wallet0.body.balance || 'N/A'}`);

  console.log('\n=== Test 1: Milestone API endpoint exists ===');
  const m0 = await http('GET', `/api/v1/agents/milestones?agent_identity=${claimant}`);
  assert('endpoint returns 200', m0.status === 200, `status=${m0.status}`);
  assert('has milestones array', Array.isArray(m0.body.milestones));
  assert('has 6 milestones defined', m0.body.total_milestones === 6, `count=${m0.body.total_milestones}`);
  assert('has stats', m0.body.stats && typeof m0.body.stats.tasksCompleted === 'number');

  console.log('\n=== Test 2: First task triggers first_task milestone ===');
  // Publish task 1
  const t1pub = await http('POST', '/api/tasks', {
    agent_identity: publisher,
    title: `Phase2 milestone test 1 ${Date.now()}`,
    description: 'Test 1',
    reward: '0',
    taskType: 'general'
  }, { 'x-admin-secret': ADMIN_SECRET });
  assert('task 1 published', t1pub.body.success === true, `err=${t1pub.body.error}`);

  if (t1pub.body.success) {
    const tid = t1pub.body.task.id;
    const cl1 = await http('POST', `/api/tasks/${tid}/claim`, { agent_identity: claimant }, { 'x-admin-secret': ADMIN_SECRET });
    assert('task 1 claimed', cl1.body.success === true, `err=${cl1.body.error_code}`);

    const sub1 = await http('POST', `/api/tasks/${tid}/submit`, {
      agent_identity: claimant,
      submission: { type: 'generic', result: 'test 1 done', proof: 'proof-1' }
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('task 1 submitted', sub1.body.success === true, `err=${sub1.body.error}`);

    const ver1 = await http('POST', `/api/tasks/${tid}/verify`, {
      agent_identity: publisher,
      approved: true
    }, { 'x-admin-secret': ADMIN_SECRET });
    assert('task 1 verified', ver1.body.success === true, `err=${ver1.body.error}`);
    if (ver1.body.task && ver1.body.task.milestonesAwarded) {
      console.log(`  milestones awarded: ${JSON.stringify(ver1.body.task.milestonesAwarded.map(m => m.name))}`);
      assert('first_task milestone awarded', ver1.body.task.milestonesAwarded.some(m => m.milestoneId === 'first_task'));
    } else {
      console.log('  WARN: milestonesAwarded not in response (this is the test)');
    }
  }

  console.log('\n=== Test 3: Query milestones progress shows first_task awarded ===');
  const m1 = await http('GET', `/api/v1/agents/milestones?agent_identity=${claimant}`);
  if (m1.body.milestones) {
    const firstTask = m1.body.milestones.find(m => m.id === 'first_task');
    assert('first_task milestone awarded', firstTask?.awarded === true);
    assert('first_task progress = 1/1', firstTask?.progress?.current === 1);
    const tenTask = m1.body.milestones.find(m => m.id === 'ten_tasks');
    assert('ten_tasks NOT yet awarded', tenTask?.awarded === false);
  }

  console.log('\n=== Test 4: Complete 9 more tasks to trigger ten_tasks ===');
  for (let i = 2; i <= 10; i++) {
    const tpub = await http('POST', '/api/tasks', {
      agent_identity: publisher,
      title: `Phase2 milestone test ${i} ${Date.now()}`,
      description: `Test ${i}`,
      reward: '0',
      taskType: 'general'
    }, { 'x-admin-secret': ADMIN_SECRET });
    if (!tpub.body.success) {
      console.log(`  task ${i} publish failed: ${tpub.body.error}`);
      continue;
    }
    const tid = tpub.body.task.id;
    await http('POST', `/api/tasks/${tid}/claim`, { agent_identity: claimant }, { 'x-admin-secret': ADMIN_SECRET });
    await http('POST', `/api/tasks/${tid}/submit`, {
      agent_identity: claimant,
      submission: { type: 'generic', result: `task ${i} done`, proof: `proof-${i}` }
    }, { 'x-admin-secret': ADMIN_SECRET });
    const ver = await http('POST', `/api/tasks/${tid}/verify`, {
      agent_identity: publisher,
      approved: true
    }, { 'x-admin-secret': ADMIN_SECRET });
    if (i === 10 && ver.body.task?.milestonesAwarded) {
      console.log(`  task 10 milestones: ${ver.body.task.milestonesAwarded.map(m => m.name).join(', ')}`);
      assert('ten_tasks milestone awarded on 10th task', ver.body.task.milestonesAwarded.some(m => m.milestoneId === 'ten_tasks'));
    }
  }

  console.log('\n=== Test 5: Idempotency — milestones not double-awarded ===');
  const m2 = await http('GET', `/api/v1/agents/milestones?agent_identity=${claimant}`);
  const awarded = m2.body.milestones.filter(m => m.awarded).map(m => m.id);
  console.log(`  awarded milestones: ${awarded.join(', ')}`);
  assert('exactly 2 milestones awarded (first_task, ten_tasks)', awarded.length === 2, `count=${awarded.length}`);

  console.log('\n=== Test 6: Stats reflect 10 tasks completed ===');
  assert('stats.tasksCompleted >= 10', m2.body.stats.tasksCompleted >= 10, `count=${m2.body.stats.tasksCompleted}`);

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(2); });
