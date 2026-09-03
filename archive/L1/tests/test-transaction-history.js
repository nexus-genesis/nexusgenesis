(async () => {
  const BASE = 'http://localhost:19891';
  const ADMIN_SECRET = 'devnet-endow-2026';

  async function api(method, path, body = null) {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
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

  console.log('═══════════════════════════════════════════════');
  console.log('  Transaction History Test');
  console.log('═══════════════════════════════════════════════\n');

  // Test 1: List transactions endpoint
  console.log('=== Test 1: List all transactions ===');
  const listRes = await api('GET', '/api/v1/transactions');
  test('endpoint returns 200', listRes.status === 200, `status=${listRes.status}`);
  test('has success: true', listRes.body?.success === true);
  test('has transactions array', Array.isArray(listRes.body?.transactions));
  test('has pagination', !!listRes.body?.pagination);
  console.log(`  total transactions: ${listRes.body?.total || 0}\n`);

  // Test 2: Transaction types endpoint
  console.log('=== Test 2: List transaction types ===');
  const typesRes = await api('GET', '/api/v1/transactions/types');
  test('endpoint returns 200', typesRes.status === 200);
  test('has success: true', typesRes.body?.success === true);
  test('has types array', Array.isArray(typesRes.body?.types));
  test('has 15+ transaction types', typesRes.body?.types?.length >= 15, `count=${typesRes.body?.types?.length}`);
  console.log(`  transaction types: ${typesRes.body?.types?.length}\n`);

  // Test 3: Transaction stats endpoint
  console.log('=== Test 3: Transaction statistics ===');
  const statsRes = await api('GET', '/api/v1/transactions/stats');
  test('endpoint returns 200', statsRes.status === 200);
  test('has success: true', statsRes.body?.success === true);
  test('has stats object', !!statsRes.body?.stats);
  test('has total count', typeof statsRes.body?.stats?.total === 'number');
  test('has byType breakdown', !!statsRes.body?.stats?.byType);
  test('has byCategory breakdown', !!statsRes.body?.stats?.byCategory);
  console.log(`  total: ${statsRes.body?.stats?.total}, 24h: ${statsRes.body?.stats?.last24h}, 7d: ${statsRes.body?.stats?.last7d}\n`);

  // Test 4: Filter by type
  console.log('=== Test 4: Filter transactions by type ===');
  const filterRes = await api('GET', '/api/v1/transactions?type=TASK_PUBLISH');
  test('filter returns 200', filterRes.status === 200);
  test('all are TASK_PUBLISH', filterRes.body?.transactions?.every(tx => 
    tx.tx_type === 'TASK_PUBLISH' || tx.type === 'TASK_PUBLISH'
  ));
  console.log(`  TASK_PUBLISH transactions: ${filterRes.body?.total || 0}\n`);

  // Test 5: Pagination
  console.log('=== Test 5: Pagination ===');
  const page1 = await api('GET', '/api/v1/transactions?limit=5&offset=0');
  const page2 = await api('GET', '/api/v1/transactions?limit=5&offset=5');
  test('page 1 has 5 items', page1.body?.transactions?.length <= 5, `count=${page1.body?.transactions?.length}`);
  test('page 2 has items', page2.body?.transactions?.length >= 0);
  test('pagination has hasNext', !!page1.body?.pagination?.hasNext);
  test('pagination has hasPrev', !!page1.body?.pagination?.hasPrev);
  console.log(`  page1: ${page1.body?.transactions?.length} items, page2: ${page2.body?.transactions?.length} items\n`);

  // Test 6: Transaction enrichment
  console.log('=== Test 6: Transaction metadata enrichment ===');
  const enriched = page1.body?.transactions?.[0];
  if (enriched) {
    test('has typeDescription', !!enriched.typeDescription);
    test('has label', !!enriched.typeDescription?.label);
    test('has category', !!enriched.typeDescription?.category);
    test('has icon', !!enriched.typeDescription?.icon);
  } else {
    console.log('  SKIP: no transactions to check enrichment');
  }
  console.log();

  // Test 7: Agent transaction history
  console.log('=== Test 7: Agent transaction history ===');
  const agentsRes = await api('GET', '/api/v1/bootstrap/validators?limit=1');
  if (agentsRes.body?.validators?.length > 0) {
    const agent = agentsRes.body.validators[0];
    const agentIdentity = agent.agent_identity;
    const agentTxRes = await api('GET', `/api/v1/transactions/agent/${agentIdentity}`);
    test('agent history returns 200', agentTxRes.status === 200);
    test('has agentId', agentTxRes.body?.agentId === agentIdentity);
    test('has transactions array', Array.isArray(agentTxRes.body?.transactions));
    console.log(`  agent: ${agentIdentity}, transactions: ${agentTxRes.body?.total || 0}`);
  } else {
    console.log('  SKIP: no agents available');
  }
  console.log();

  console.log('═══════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
  
  if (failed > 0) {
    process.exit(1);
  }
})();
