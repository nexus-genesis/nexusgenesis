// Test: repeated violations escalate to REPEATED_VIOLATION (-100)
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

async function main() {
  console.log('=== Setup: get a fresh agent with high reputation ===');
  // Use the slash function directly on a fresh agent we create via the API
  // First, register a new agent to test escalation
  // Note: registration requires PoW; we'll use existing agent
  const ag = await http('GET', '/api/v1/bootstrap/validators?limit=20');
  const candidates = ag.body.validators || [];
  if (candidates.length === 0) {
    console.log('  SKIP: no agents');
    return;
  }

  // Find an agent with reputation >= 100 to survive 3 slashes
  let target = candidates.find(v => v.reputation >= 100);
  if (!target) {
    // Accept any agent; the penalty/effectivePenalty still records correctly
    target = candidates[0];
    console.log(`  WARN: no rep>=100 agent, using ${target.agent_identity} (rep=${target.reputation}). Penalty values will be verified, not reputation drop.`);
  }
  console.log(`  target: ${target.agent_identity} (rep=${target.reputation})`);

  console.log('\n=== Trigger 3 self-dealing attempts ===');
  for (let i = 1; i <= 3; i++) {
    const pub = await http('POST', '/api/tasks', {
      agent_identity: target.agent_identity,
      title: `Escalation test ${Date.now()}-${i}`,
      description: `Violation attempt ${i} for escalation test`,
      reward: '0',
      taskType: 'general'
    }, { 'x-admin-secret': ADMIN_SECRET });

    if (!pub.body.success) {
      console.log(`  Attempt ${i}: publish failed: ${pub.body.error}`);
      continue;
    }
    const taskId = pub.body.task.id;

    const claim = await http('POST', `/api/tasks/${taskId}/claim`, {
      agent_identity: target.agent_identity
    }, { 'x-admin-secret': ADMIN_SECRET });

    console.log(`  Attempt ${i}: claim status=${claim.status}, error_code=${claim.body.error_code}`);
  }

  console.log('\n=== Verify escalation: 3rd violation should be -100 ===');
  const v = await http('GET', `/api/v1/agents/violations?agent_id=${target.agent_identity}`);
  const recent = v.body.violations.slice(-3);
  console.log(`  total violations: ${v.body.total}`);
  recent.forEach((vv, idx) => {
    console.log(`  [${idx+1}] ${vv.violationType} penalty=${vv.effectivePenalty} escalated=${vv.escalated} prev=${vv.previousReputation} new=${vv.newReputation}`);
  });

  assert('3 violations recorded', recent.length === 3, `count=${recent.length}`);
  assert('1st violation penalty = -50', recent[0]?.effectivePenalty === -50, `penalty=${recent[0]?.effectivePenalty}`);
  assert('1st NOT escalated', recent[0]?.escalated === false);
  assert('3rd violation penalty = -100 (REPEATED_VIOLATION)', recent[2]?.effectivePenalty === -100, `penalty=${recent[2]?.effectivePenalty}`);
  assert('3rd IS escalated', recent[2]?.escalated === true);

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST ERROR:', e); process.exit(2); });
