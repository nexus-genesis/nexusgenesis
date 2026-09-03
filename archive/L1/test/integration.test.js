/**
 * NexusGenesis - P0 Convergence Integration Tests
 *
 * 覆盖：
 *   1. POST /api/v1/agents/register        – v1 Agent 注册上链
 *   2. POST /api/v1/bootstrap/agents/register – Bootstrap 注册
 *   3. POST /api/v1/bootstrap/validators/join  – Validator 入委
 *   4. GET  /api/v1/agents                  – Agent 列表查询
 *   5. GET  /api/v1/bootstrap/status        – Bootstrap 状态
 *   6. POST /api/agents/register            – Legacy 注册兼容
 *   7. 跨接口一致性：注册后三个查询接口都能看到
 *   8. 区块生产：注册后区块高度推进
 */

import assert from 'assert';
import { test, after, before } from 'node:test';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 测试配置 ──────────────────────────────────────────────
const TEST_HTTP_PORT = 19902;
const TEST_P2P_PORT = 9851;
const TEST_DATA_DIR = path.join(__dirname, '..', 'data', 'integration-test');

// ── HTTP 请求辅助 ─────────────────────────────────────────
function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: TEST_HTTP_PORT,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (e) => reject(e));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── 唯一 ID 生成 ─────────────────────────────────────────
let counter = 0;
function uniqueName(prefix = 'test') {
  counter++;
  return `${prefix}${Date.now()}${counter}`;
}

// ── 生命周期 ──────────────────────────────────────────────
let node = null;

before(async () => {
  try {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}

  process.env.HTTP_PORT = String(TEST_HTTP_PORT);
  process.env.P2P_PORT = String(TEST_P2P_PORT);
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.NODE_ROLE = 'genesis';
  process.env.SEED_NODES = '';
  process.env.ALLOW_SINGLE_NODE_BLOCKS = 'true';

  const { startMainNode } = await import('../src/index.js');
  node = await startMainNode({ attachStdin: false });

  await new Promise(resolve => setTimeout(resolve, 3000));
});

after(async () => {
  if (node) {
    await node.shutdown();
  }
  try {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

// ══════════════════════════════════════════════════════════
//  Test 1: 健康检查
// ══════════════════════════════════════════════════════════
test('GET /health 返回 200', async () => {
  const res = await apiRequest('GET', '/health');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.status, 'Should have status field');
  console.log('  Health check: OK');
});

// ══════════════════════════════════════════════════════════
//  Test 2: v1 Agent 注册 → 上链 → 查询一致
// ══════════════════════════════════════════════════════════
test('POST /api/v1/agents/register → 上链 → 查询一致', async () => {
  const agentName = uniqueName('v1reg');
  const regRes = await apiRequest('POST', '/api/v1/agents/register', {
    agent_identity: agentName,
    capabilities: ['integration-test', 'v1'],
    metadata: 'Integration test'
  });

  assert.ok(regRes.status === 200 || regRes.status === 201,
    `Register: ${regRes.status}: ${JSON.stringify(regRes.body)}`);
  assert.strictEqual(regRes.body.success, true);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const listRes = await apiRequest('GET', '/api/v1/agents');
  assert.strictEqual(listRes.status, 200);
  const agents = listRes.body.agents || listRes.body.data || [];
  const found = agents.find(a => a.identity === agentName || a.agent_identity === agentName);
  assert.ok(found, `Agent ${agentName} should appear in /api/v1/agents`);

  console.log(`  v1 Register: ${agentName} OK`);
});

// ══════════════════════════════════════════════════════════
//  Test 3: Bootstrap Agent 注册 → 上链
// ══════════════════════════════════════════════════════════
test('POST /api/v1/bootstrap/agents/register → 上链', async () => {
  const agentName = uniqueName('bsreg');
  // Test both agent_identity (canonical) and name (backward compat)
  const regRes = await apiRequest('POST', '/api/v1/bootstrap/agents/register', {
    agent_identity: agentName,
    capabilities: ['bootstrap', 'integration']
  });

  assert.ok(regRes.status === 200 || regRes.status === 201,
    `Bootstrap register: ${regRes.status}: ${JSON.stringify(regRes.body)}`);
  assert.strictEqual(regRes.body.success, true);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const v1List = await apiRequest('GET', '/api/v1/agents');
  const bsList = await apiRequest('GET', '/api/v1/bootstrap/agents');

  const v1Agents = v1List.body.agents || v1List.body.data || [];
  const bsAgents = bsList.body.agents || [];

  const foundInV1 = v1Agents.find(a => a.identity === agentName || a.agent_identity === agentName || (a.agentId === agentName));
  const foundInBs = bsAgents.find(a => a.agent_identity === agentName || a.identity === agentName || a.agentId === agentName);

  assert.ok(foundInV1, `Agent ${agentName} should appear in /api/v1/agents`);
  assert.ok(foundInBs, `Agent ${agentName} should appear in /api/v1/bootstrap/agents`);

  console.log(`  Bootstrap Register: ${agentName} OK`);
});

// ══════════════════════════════════════════════════════════
//  Test 4: Validator Join
// ══════════════════════════════════════════════════════════
test('POST /api/v1/bootstrap/validators/join → 入委', async () => {
  const agentName = uniqueName('validator');

  const regRes = await apiRequest('POST', '/api/v1/bootstrap/agents/register', {
    agent_identity: agentName,
    capabilities: ['validator', 'consensus']
  });
  assert.strictEqual(regRes.body.success, true, `Register: ${JSON.stringify(regRes.body)}`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const joinRes = await apiRequest('POST', '/api/v1/bootstrap/validators/join', {
    agent_identity: agentName,
    stake: 5000
  });

  assert.ok(joinRes.status === 200 || joinRes.status === 201,
    `Join: ${joinRes.status}: ${JSON.stringify(joinRes.body)}`);
  assert.strictEqual(joinRes.body.success, true, `Join: ${JSON.stringify(joinRes.body)}`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const statusRes = await apiRequest('GET', '/api/v1/bootstrap/status');
  assert.strictEqual(statusRes.status, 200);

  const committeeSize = statusRes.body.committeeSize || statusRes.body.validatorCount || statusRes.body.bootstrapExitProgress?.validatorCount || 0;
  // Committee size might be a string like "2/7"
  const size = typeof committeeSize === 'string' ? parseInt(committeeSize.split('/')[0]) : committeeSize;
  assert.ok(size >= 1, `Committee size: ${committeeSize}`);

  console.log(`  Validator Join: ${agentName} OK, committeeSize=${committeeSize}`);
});

// ══════════════════════════════════════════════════════════
//  Test 5: Legacy /api/agents/register 兼容
// ══════════════════════════════════════════════════════════
test('POST /api/agents/register (legacy) → 上链成功', async () => {
  const agentId = `ng1legacy${Date.now()}${counter}`;
  counter++;

  const regRes = await apiRequest('POST', '/api/agents/register', {
    agent_id: agentId,
    capabilities: ['legacy-compat', 'bridge'],
    model: 'test'
  });

  assert.ok(regRes.status === 200 || regRes.status === 201,
    `Legacy register: ${regRes.status}: ${JSON.stringify(regRes.body)}`);

  const onChainOk = regRes.body.success || regRes.body.onChain?.applied;
  assert.ok(onChainOk, `Legacy: ${JSON.stringify(regRes.body)}`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const legacyList = await apiRequest('GET', '/api/agents');
  const v1List = await apiRequest('GET', '/api/v1/agents');

  const legacyAgents = legacyList.body.agents || legacyList.body.data || [];
  const v1Agents = v1List.body.agents || v1List.body.data || [];

  // Legacy list might use `id` or `agent_id`; v1 might use `agent_identity` or `onChainAgentId`
  const foundInLegacy = legacyAgents.find(a =>
    a.id === agentId || a.agent_id === agentId || a.identity === agentId || a.agent_identity === agentId
  );
  const foundInV1 = v1Agents.find(a =>
    a.identity === agentId || a.agent_identity === agentId || a.id === agentId
  );

  assert.ok(foundInLegacy, `Agent ${agentId} in /api/agents: keys=${legacyAgents.length > 0 ? Object.keys(legacyAgents[0]).join(',') : 'empty'}`);
  assert.ok(foundInV1, `Agent ${agentId} in /api/v1/agents`);

  console.log(`  Legacy Register: ${agentId} OK`);
});

// ══════════════════════════════════════════════════════════
//  Test 6: Bootstrap 状态端点
// ══════════════════════════════════════════════════════════
test('GET /api/v1/bootstrap/status → 返回链状态', async () => {
  const res = await apiRequest('GET', '/api/v1/bootstrap/status');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true, 'Should have success: true');
  assert.ok(res.body.blockHeight !== undefined, 'Should have blockHeight');
  assert.ok(res.body.blockHeight > 0, `BlockHeight: ${res.body.blockHeight}`);
  assert.ok(res.body.agentCount !== undefined, 'Should have agentCount');

  console.log(`  Bootstrap Status: blockHeight=${res.body.blockHeight}, agents=${res.body.agentCount}`);
});

// ══════════════════════════════════════════════════════════
//  Test 7: 区块生产验证
// ══════════════════════════════════════════════════════════
test('区块生产：注册后区块高度推进', async () => {
  const initialStatus = await apiRequest('GET', '/api/v1/bootstrap/status');
  const initialHeight = initialStatus.body.blockHeight;

  const agentName = uniqueName('blocktest');
  await apiRequest('POST', '/api/v1/agents/register', {
    agent_identity: agentName,
    capabilities: ['block-test', 'verify']
  });

  await new Promise(resolve => setTimeout(resolve, 12000));

  const finalStatus = await apiRequest('GET', '/api/v1/bootstrap/status');
  const finalHeight = finalStatus.body.blockHeight;

  assert.ok(finalHeight > initialHeight,
    `Block height: ${initialHeight} → ${finalHeight}`);

  console.log(`  Block Production: ${initialHeight} → ${finalHeight} (+${finalHeight - initialHeight})`);
});

// ══════════════════════════════════════════════════════════
//  Test 8: 跨接口一致性
//  NOTE: Legacy /api/agents reads from AgentManager (file-based),
//  while v1 and bootstrap read from chain state. v1-registered agents
//  go to chain state but may not appear in legacy file-based storage.
// ══════════════════════════════════════════════════════════
test('跨接口一致性：v1 和 bootstrap 查询一致', async () => {
  const agentName = uniqueName('crosscheck');
  const regRes = await apiRequest('POST', '/api/v1/agents/register', {
    agent_identity: agentName,
    capabilities: ['cross-check', 'verify']
  });

  assert.ok(regRes.body.success, `Register should succeed: ${JSON.stringify(regRes.body)}`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const [v1Res, bsRes] = await Promise.all([
    apiRequest('GET', '/api/v1/agents'),
    apiRequest('GET', '/api/v1/bootstrap/agents')
  ]);

  const v1Agents = v1Res.body.agents || v1Res.body.data || [];
  const bsAgents = bsRes.body.agents || [];

  const matchV1 = (a) =>
    a.identity === agentName || a.agent_identity === agentName || a.id === agentName;
  const matchBs = (a) =>
    a.agentId === agentName || a.identity === agentName || a.agent_identity === agentName || a.agent_id === agentName || a.name === agentName;

  assert.ok(v1Agents.some(matchV1), `${agentName} not in v1 list (${v1Agents.length} agents)`);
  assert.ok(bsAgents.some(matchBs), `${agentName} not in bootstrap list (${bsAgents.length} agents)`);

  console.log(`  Cross-consistency: ${agentName} OK (v1 + bootstrap)`);
});

console.log('\n=== P0 Convergence Integration Tests Complete ===');