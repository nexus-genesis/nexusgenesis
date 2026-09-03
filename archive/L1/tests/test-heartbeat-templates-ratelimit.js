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

async function getAgents() {
  const r = await api('GET', '/api/v1/bootstrap/validators?limit=10');
  return r.body.validators || [];
}

async function testHeartbeat() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Validator Heartbeat Test');
  console.log('═══════════════════════════════════════════════\n');

  const agents = await getAgents();
  if (agents.length < 1) {
    console.log('  SKIP: no agents available');
    return;
  }
  const agent = agents[0];
  console.log(`  test agent: ${agent.agent_identity}\n`);

  // Test 1: Health overview endpoint
  console.log('=== Test 1: Health overview endpoint ===');
  const healthRes = await api('GET', '/api/v1/bootstrap/validators/health');
  test('endpoint returns 200', healthRes.status === 200, `status=${healthRes.status}`);
  test('has success: true', healthRes.body?.success === true);
  test('has validators array', Array.isArray(healthRes.body?.validators));
  test('has summary', !!healthRes.body?.summary);
  test('summary has total', healthRes.body?.summary?.total >= 0);
  console.log(`  total: ${healthRes.body?.summary?.total}, healthy: ${healthRes.body?.summary?.healthy}`);
  console.log();

  // Test 2: Submit heartbeat
  console.log('=== Test 2: Submit heartbeat ===');
  const hbRes = await api('POST', `/api/v1/bootstrap/validators/${agent.agent_identity}/heartbeat`, {});
  test('heartbeat returns 200', hbRes.status === 200, `status=${hbRes.status}`);
  test('success: true', hbRes.body?.success === true);
  test('has heartbeat data', !!hbRes.body?.heartbeat);
  test('healthy is true', hbRes.body?.heartbeat?.healthy === true);
  console.log(`  heartbeat timestamp: ${hbRes.body?.heartbeat?.timestamp}`);
  console.log();

  // Test 3: Second heartbeat (consecutive)
  console.log('=== Test 3: Consecutive heartbeat ===');
  const hb2Res = await api('POST', `/api/v1/bootstrap/validators/${agent.agent_identity}/heartbeat`, {});
  test('second heartbeat returns 200', hb2Res.status === 200);
  test('still healthy', hb2Res.body?.heartbeat?.healthy === true);
  console.log();

  console.log('═══════════════════════════════════════════════');
  console.log(`  Heartbeat Result: ${passed - passed} passed, ${failed - failed} failed`);
  console.log('═══════════════════════════════════════════════\n');
}

async function testTaskTemplates() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Task Templates Test');
  console.log('═══════════════════════════════════════════════\n');

  // Test 1: List templates
  console.log('=== Test 1: List all templates ===');
  const listRes = await api('GET', '/api/tasks/templates');
  test('endpoint returns 200', listRes.status === 200, `status=${listRes.status}`);
  test('has success: true', listRes.body?.success === true);
  test('has data array', Array.isArray(listRes.body?.data));
  test('has 10 templates', listRes.body?.data?.length === 10, `count=${listRes.body?.data?.length}`);
  test('has total count', listRes.body?.total === 10);
  console.log(`  templates count: ${listRes.body?.data?.length}`);
  console.log();

  // Test 2: Template has correct fields
  console.log('=== Test 2: Template field validation ===');
  const templates = listRes.body?.data || [];
  if (templates.length > 0) {
    const t = templates[0];
    test('has id', !!t.id);
    test('has name', !!t.name);
    test('has description', !!t.description);
    test('has taskType', !!t.taskType);
    test('has requiredCapabilities', Array.isArray(t.requiredCapabilities));
    test('has suggestedReward', !!t.suggestedReward);
    test('has tags', Array.isArray(t.tags));
  }
  console.log();

  // Test 3: Filter by category
  console.log('=== Test 3: Filter by category (analysis) ===');
  const catRes = await api('GET', '/api/tasks/templates?category=analysis');
  test('filter returns 200', catRes.status === 200);
  test('all are analysis type', catRes.body?.data?.every(t => t.taskType === 'analysis'));
  console.log(`  analysis templates: ${catRes.body?.data?.length}`);
  console.log();

  // Test 4: Filter by tag
  console.log('=== Test 4: Filter by tag (security) ===');
  const tagRes = await api('GET', '/api/tasks/templates?tag=security');
  test('tag filter returns 200', tagRes.status === 200);
  test('all have security tag', tagRes.body?.data?.every(t => t.tags.includes('security')));
  console.log(`  security tagged: ${tagRes.body?.data?.length}`);
  console.log();

  // Test 5: Known template IDs exist
  console.log('=== Test 5: Core template IDs present ===');
  const ids = templates.map(t => t.id);
  test('network_health_monitor exists', ids.includes('network_health_monitor'));
  test('code_review exists', ids.includes('code_review'));
  test('data_analysis exists', ids.includes('data_analysis'));
  test('community_engagement exists', ids.includes('community_engagement'));
  test('documentation_update exists', ids.includes('documentation_update'));
  console.log();

  console.log('═══════════════════════════════════════════════');
  console.log(`  Templates Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');
}

async function testRateLimiting() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Rate Limiting Test');
  console.log('═══════════════════════════════════════════════\n');

  // Test basic rate limit — send many requests quickly
  console.log('=== Test: Rate limit triggers after many requests ===');
  let hitRateLimit = false;
  let requestsSent = 0;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await api('GET', '/api/tasks/templates');
      requestsSent++;
      if (res.status === 429) {
        hitRateLimit = true;
        break;
      }
    } catch {}
  }
  test('rate limit triggered (429)', hitRateLimit, `sent ${requestsSent} requests`);
  console.log(`  requests sent: ${requestsSent}`);
  console.log();

  console.log('═══════════════════════════════════════════════');
  console.log(`  Rate Limit Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');
}

async function main() {
  await testHeartbeat();
  await testTaskTemplates();
  await testRateLimiting();

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Final Total: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
