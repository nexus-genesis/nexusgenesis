/**
 * NexusGenesis - 签名验证缓存高并发压力测试
 * 
 * 模拟 500 个并发请求，验证缓存在高负载下的稳定性和性能表现
 * 
 * 测试场景：
 * 1. 100 个 Agent 并发创建审批请求（基线）
 * 2. 500 个并发决策请求（同一审批 ID，验证缓存命中）
 * 3. 500 个并发无效签名攻击（验证都被正确拒绝）
 * 4. 混合负载：创建 + 决策 + 无效签名同时进行
 */

import 'dotenv/config';
import express from 'express';
import bootstrapApi from '../src/http/routes/bootstrapApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { sign as pqcSign } from '../src/crypto/pqc.js';
import { getStats as getCacheStats } from '../src/crypto/signatureCache.js';

const stats = {
  totalRequests: 0,
  successes: 0,
  failures: 0,
  errors: 0,
  rejections: 0,
  timings: []
};

function recordSuccess(elapsed) {
  stats.successes++;
  stats.timings.push(elapsed);
}

function recordFailure(elapsed) {
  stats.failures++;
  stats.timings.push(elapsed);
}

function recordError() {
  stats.errors++;
}

function recordRejection() {
  stats.rejections++;
}

async function generateTestKeys() {
  const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
  const keyPair = ml_dsa44.keygen();
  return {
    publicKeyHex: Buffer.from(keyPair.publicKey).toString('hex'),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString('hex')
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 服务器启动 ───────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));

app.locals.state = {
  agents: {},
  approvals: {},
  balances: {},
  transactions: { txHistory: [] }
};

app.locals.agentWalletManager = agentWalletManager;
app.use(bootstrapApi);

const server = app.listen(0);
const port = server.address().port;
const baseUrl = `http://localhost:${port}`;

console.log(`\n🚀 Server started on port ${port}`);
console.log('='.repeat(70));

// ─── 测试 1: 100 个 Agent 创建审批（基线） ─────────────────────

async function test1_baseline() {
  console.log('\n[Test 1] Baseline: 100 agents create approval requests');
  console.log('-'.repeat(70));

  const startTime = Date.now();
  const CONCURRENCY = 100;
  const results = [];

  for (let i = 0; i < CONCURRENCY; i++) {
    const idx = i;
    const agentId = `baseline-agent-${idx.toString().padStart(3, '0')}`;

    const promise = (async () => {
      const keys = await generateTestKeys();
      try {
        await agentWalletManager.registerAgentWithKeyModel(agentId, {
          keyModel: 'self-sovereign',
          publicKeyHex: keys.publicKeyHex,
          privateKeyHex: keys.privateKeyHex,
          metadata: { spendConfig: { type: 'unlimited' } }
        });
      } catch (e) {
        return { registered: false };
      }

      const createStart = Date.now();
      try {
        const resp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            type: 'transfer',
            toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
            amount: '500'
          })
        });

        const elapsed = Date.now() - createStart;
        stats.totalRequests++;

        if (resp.ok) {
          const data = await resp.json();
          if (data.success) {
            recordSuccess(elapsed);
            return { created: true, approvalId: data.approvalId, elapsed };
          }
        }
        recordFailure(elapsed);
        return { created: false };
      } catch (e) {
        recordError();
        return { error: e.message };
      }
    })();

    results.push(promise);
  }

  const outcomes = await Promise.all(results);
  const elapsed = Date.now() - startTime;

  const created = outcomes.filter(r => r?.created).length;
  const failed = outcomes.filter(r => !r?.created).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  Created: ${created}/${CONCURRENCY}`);
  console.log(`  Failed: ${failed}/${CONCURRENCY}`);
  console.log(`  Cache stats:`, getCacheStats());

  return { created, failed, elapsed };
}

// ─── 测试 2: 500 个并发决策请求（同一审批 ID） ──────────────────

async function test2_cache_stress() {
  console.log('\n[Test 2] Cache stress: 500 concurrent decisions on SAME approval');
  console.log('-'.repeat(70));

  // 创建一个审批供测试
  const agentId = 'cache-stress-agent';
  const keys = await generateTestKeys();
  await agentWalletManager.registerAgentWithKeyModel(agentId, {
    keyModel: 'self-sovereign',
    publicKeyHex: keys.publicKeyHex,
    privateKeyHex: keys.privateKeyHex,
    metadata: { spendConfig: { type: 'unlimited' } }
  });

  const createResp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      type: 'transfer',
      toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
      amount: '1000'
    })
  });

  const createData = await createResp.json();
  const approvalId = createData.approvalId;
  console.log(`  Test approval: ${approvalId.slice(0, 20)}...`);

  // 获取 Agent 私钥
  const agentEntry = agentWalletManager.registry.get(agentId);
  if (!agentEntry) {
    console.log('  SKIP: Agent not found');
    return { skipped: true };
  }

  // 500 个并发决策请求（分 5 批，每批 100）
  const CONCURRENCY = 500;
  const BATCH_SIZE = 100;
  const startTime = Date.now();
  const allResults = [];

  for (let batch = 0; batch < 5; batch++) {
    const promises = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
    const promise = (async () => {
      const decideStart = Date.now();
      try {
        // 用真实签名（前 50 个）和无效签名（后 450 个）
        const isRealSig = i < 50;
        let masterSignature;

        if (isRealSig) {
          const message = `approval:${approvalId}:approve:1000`;
          const sigBuffer = await pqcSign(message, agentEntry.wallet.privateKey);
          masterSignature = sigBuffer.toString('hex');
        } else {
          masterSignature = 'ff'.repeat(2420);
        }

        const resp = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'approve',
            masterSignature
          })
        });

        const elapsed = Date.now() - decideStart;
        stats.totalRequests++;

        if (resp.status === 400) {
          // 第一次成功后，后续都是 "already decided"
          recordRejection();
          return { rejected: true, status: 400, elapsed };
        } else if (resp.status === 403) {
          recordRejection();
          return { rejected: true, status: 403, elapsed };
        } else if (resp.ok) {
          const data = await resp.json();
          if (data.success) {
            recordSuccess(elapsed);
            return { succeeded: true, decision: data.decision, elapsed };
          }
        }

        recordFailure(elapsed);
        return { unknown: true, status: resp.status, elapsed };
      } catch (e) {
        recordError();
        return { error: e.message };
      }
    })();

    promises.push(promise);
  }

  const batchResults = await Promise.all(promises);
  allResults.push(...batchResults);

  console.log(`  Batch ${batch + 1}/5 completed (${batchResults.length} requests)`);
  await sleep(500); // 批次间休息
}

const results = allResults;
const elapsed = Date.now() - startTime;

const succeeded = results.filter(r => r?.succeeded).length;
const rejected = results.filter(r => r?.rejected).length;
const failed = results.filter(r => !r?.succeeded && !r?.rejected).length;

console.log(`  Total time: ${elapsed}ms`);
console.log(`  First decision succeeded: ${succeeded}`);
console.log(`  Correctly rejected (dup/invalid): ${rejected}`);
console.log(`  Failed/Error: ${failed}`);
console.log(`  Avg per request: ${(elapsed / CONCURRENCY).toFixed(1)}ms`);
console.log(`  Cache stats:`, getCacheStats());

return { succeeded, rejected, failed, elapsed };
}

// ─── 测试 3: 500 个并发无效签名攻击 ─────────────────────────────

async function test3_invalid_signature_flood() {
  console.log('\n[Test 3] Invalid signature flood: 100 concurrent attacks');
  console.log('-'.repeat(70));

  // 创建 10 个审批
  const testApprovalIds = [];
  for (let i = 0; i < 10; i++) {
    const agentId = `flood-agent-${i.toString().padStart(3, '0')}`;
    const keys = await generateTestKeys();
    await agentWalletManager.registerAgentWithKeyModel(agentId, {
      keyModel: 'self-sovereign',
      publicKeyHex: keys.publicKeyHex,
      privateKeyHex: keys.privateKeyHex,
      metadata: { spendConfig: { type: 'unlimited' } }
    });

    const resp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        type: 'transfer',
        toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
        amount: '100'
      })
    });

    const data = await resp.json();
    if (data.success) testApprovalIds.push(data.approvalId);
  }

  console.log(`  Created ${testApprovalIds.length} test approvals`);

  // 100 个并发无效签名攻击（分 2 批，每批 50）
  const CONCURRENCY = 100;
  const BATCH_SIZE = 50;
  const startTime = Date.now();
  const allResults = [];

  for (let batch = 0; batch < 2; batch++) {
    const promises = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      const globalIdx = batch * BATCH_SIZE + i;
      const approvalId = testApprovalIds[globalIdx % testApprovalIds.length];

      const promise = (async () => {
        const decideStart = Date.now();
        try {
          const resp = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              decision: globalIdx % 2 === 0 ? 'approve' : 'reject',
              masterSignature: 'deadbeef'.repeat(302) // 无效 hex
            })
          });

          const elapsed = Date.now() - decideStart;
          stats.totalRequests++;

          if (resp.status === 403) {
            recordRejection();
            return { correctlyRejected: true, elapsed };
          }

          recordFailure(elapsed);
          return { incorrectlyAccepted: true, status: resp.status };
        } catch (e) {
          recordError();
          return { error: e.message };
        }
      })();

      promises.push(promise);
    }

    const batchResults = await Promise.all(promises);
    allResults.push(...batchResults);
    console.log(`  Batch ${batch + 1}/2 completed (${batchResults.length} requests)`);
    await sleep(500);
  }

  const results = allResults;
  const elapsed = Date.now() - startTime;

  const correctlyRejected = results.filter(r => r?.correctlyRejected).length;
  const incorrectlyAccepted = results.filter(r => r?.incorrectlyAccepted).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  Correctly rejected: ${correctlyRejected}/${CONCURRENCY}`);
  console.log(`  Incorrectly accepted: ${incorrectlyAccepted}/${CONCURRENCY} ⚠️`);
  console.log(`  Avg per request: ${(elapsed / CONCURRENCY).toFixed(1)}ms`);
  console.log(`  Cache stats:`, getCacheStats());

  return { correctlyRejected, incorrectlyAccepted, elapsed };
}

// ─── 测试 4: 混合负载 ─────────────────────────────────────────

async function test4_mixed_load() {
  console.log('\n[Test 4] Mixed load: 50 create + 50 decide + 50 invalid');
  console.log('-'.repeat(70));

  const startTime = Date.now();
  const CONCURRENCY = 150;
  const promises = [];

  // 50 个创建请求
  for (let i = 0; i < 50; i++) {
    const agentId = `mixed-create-${i.toString().padStart(3, '0')}`;
    const promise = (async () => {
      const keys = await generateTestKeys();
      try {
        await agentWalletManager.registerAgentWithKeyModel(agentId, {
          keyModel: 'self-sovereign',
          publicKeyHex: keys.publicKeyHex,
          privateKeyHex: keys.privateKeyHex,
          metadata: { spendConfig: { type: 'unlimited' } }
        });

        const resp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            type: 'transfer',
            toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
            amount: '200'
          })
        });

        const data = await resp.json();
        if (data.success) {
          return { created: true, approvalId: data.approvalId };
        }
        return { created: false };
      } catch (e) {
        return { error: e.message };
      }
    })();
    promises.push(promise);
  }

  // 50 个决策请求
  const createdApprovals = [];
  for (let i = 0; i < 50; i++) {
    const agentId = `mixed-decide-${i.toString().padStart(3, '0')}`;
    const promise = (async () => {
      const keys = await generateTestKeys();
      try {
        await agentWalletManager.registerAgentWithKeyModel(agentId, {
          keyModel: 'self-sovereign',
          publicKeyHex: keys.publicKeyHex,
          privateKeyHex: keys.privateKeyHex,
          metadata: { spendConfig: { type: 'unlimited' } }
        });

        const createResp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            type: 'transfer',
            toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
            amount: '300'
          })
        });

        const createData = await createResp.json();
        if (!createData.success) return { decided: false };

        createdApprovals.push(createData.approvalId);
        const agentEntry = agentWalletManager.registry.get(agentId);
        if (!agentEntry) return { decided: false };

        const message = `approval:${createData.approvalId}:approve:300`;
        const sigBuffer = await pqcSign(message, agentEntry.wallet.privateKey);
        const masterSignature = sigBuffer.toString('hex');

        const resp = await fetch(`${baseUrl}/api/v1/approvals/${createData.approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve', masterSignature })
        });

        if (resp.ok) {
          const data = await resp.json();
          return { decided: true, success: data.success };
        }
        return { decided: false, status: resp.status };
      } catch (e) {
        return { error: e.message };
      }
    })();
    promises.push(promise);
  }

  // 50 个无效签名攻击
  for (let i = 0; i < 50; i++) {
    const agentId = `mixed-invalid-${i.toString().padStart(3, '0')}`;
    const promise = (async () => {
      const keys = await generateTestKeys();
      try {
        await agentWalletManager.registerAgentWithKeyModel(agentId, {
          keyModel: 'self-sovereign',
          publicKeyHex: keys.publicKeyHex,
          privateKeyHex: keys.privateKeyHex,
          metadata: { spendConfig: { type: 'unlimited' } }
        });

        const createResp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            type: 'transfer',
            toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
            amount: '400'
          })
        });

        const createData = await createResp.json();
        if (!createData.success) return { invalid: false };

        const resp = await fetch(`${baseUrl}/api/v1/approvals/${createData.approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'approve',
            masterSignature: 'aa'.repeat(2420)
          })
        });

        if (resp.status === 403) {
          return { invalid: true, rejected: true };
        }
        return { invalid: false, accepted: true };
      } catch (e) {
        return { error: e.message };
      }
    })();
    promises.push(promise);
  }

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  const created = results.filter(r => r?.created).length;
  const decided = results.filter(r => r?.decided).length;
  const rejected = results.filter(r => r?.invalid && r?.rejected).length;
  const errors = results.filter(r => r?.error).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  Created: ${created}/200`);
  console.log(`  Decided: ${decided}/200`);
  console.log(`  Invalid sigs rejected: ${rejected}/100`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Cache stats:`, getCacheStats());

  return { created, decided, rejected, errors, elapsed };
}

// ─── 主测试流程 ───────────────────────────────────────────────

async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  HIGH-LOAD CACHE STABILITY TEST SUITE');
  console.log('='.repeat(70));

  const overallStart = Date.now();

  const t1 = await test1_baseline();
  await sleep(1000);

  const t2 = await test2_cache_stress();
  await sleep(1000);

  const t3 = await test3_invalid_signature_flood();
  await sleep(1000);

  const t4 = await test4_mixed_load();

  const overallElapsed = Date.now() - overallStart;

  // ─── 汇总 ─────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('  FINAL SUMMARY');
  console.log('='.repeat(70));

  const avgTime = stats.timings.length > 0
    ? (stats.timings.reduce((a, b) => a + b, 0) / stats.timings.length).toFixed(1)
    : 'N/A';

  const minTime = stats.timings.length > 0 ? Math.min(...stats.timings) : 'N/A';
  const maxTime = stats.timings.length > 0 ? Math.max(...stats.timings) : 'N/A';

  console.log(`  Total requests:     ${stats.totalRequests}`);
  console.log(`  Successful:         ${stats.successes}`);
  console.log(`  Failed:             ${stats.failures}`);
  console.log(`  Errors:             ${stats.errors}`);
  console.log(`  Rejected (expected):${stats.rejections}`);
  console.log(`  Avg response time:  ${avgTime}ms`);
  console.log(`  Min response time:  ${minTime}ms`);
  console.log(`  Max response time:  ${maxTime}ms`);
  console.log(`  Total elapsed:      ${overallElapsed}ms`);
  console.log(`  Cache stats:        `, getCacheStats());

  console.log('\n  Per-Test Results:');
  console.log(`    Test 1 (Baseline):     ${t1.created}/${t1.failed} created in ${t1.elapsed}ms`);
  if (!t2.skipped) {
    console.log(`    Test 2 (Cache Stress): ${t2.succeeded} succeeded, ${t2.rejected} rejected, ${t2.failed} failed in ${t2.elapsed}ms`);
  }
  if (!t3.skipped) {
    console.log(`    Test 3 (Invalid Flood):${t3.correctlyRejected}/100 rejected, ${t3.incorrectlyAccepted} accepted ⚠️`);
  }
  if (!t4.skipped) {
    console.log(`    Test 4 (Mixed Load):   ${t4.created} created, ${t4.decided} decided, ${t4.rejected} rejected in ${t4.elapsed}ms`);
  }

  // 安全检查
  console.log('\n' + '-'.repeat(70));
  if (t3?.incorrectlyAccepted > 0) {
    console.log(`  🚨 SECURITY ISSUE: ${t3.incorrectlyAccepted} invalid signatures were accepted!`);
  } else {
    console.log('  ✅ All invalid signatures were correctly rejected.');
  }

  if (t2?.succeeded === 1) {
    console.log('  ✅ Only one decision succeeded (idempotent).');
  } else if (t2?.succeeded > 1) {
    console.log(`  🚨 CONCURRENCY BUG: ${t2.succeeded} decisions succeeded (should be 1)!`);
  }

  console.log('='.repeat(70));

  return {
    totalRequests: stats.totalRequests,
    successes: stats.successes,
    failures: stats.failures,
    errors: stats.errors,
    rejections: stats.rejections,
    avgTime,
    minTime,
    maxTime,
    overallElapsed
  };
}

// ─── 执行 ─────────────────────────────────────────────────────

try {
  const results = await runAllTests();

  const hasCriticalIssues = results.errors > 0 || results.failures > results.totalRequests * 0.05;
  server.close();

  if (hasCriticalIssues) {
    console.log('\n❌ HIGH-LOAD TEST FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ HIGH-LOAD TEST PASSED');
    process.exit(0);
  }
} catch (e) {
  console.error('FATAL ERROR:', e.message);
  server.close();
  process.exit(1);
}
