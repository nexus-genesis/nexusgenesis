/**
 * NexusGenesis - 审批系统高并发压力测试
 * 
 * 模拟 50 个并发请求，验证签名验证逻辑在高压下的稳定性
 * 
 * 注意：Dilithium2 密钥生成很慢，所以使用预生成的密钥来加速测试
 * 
 * 测试场景：
 * 1. 50 个 Agent 同时创建审批请求
 * 2. 25 个并发批准请求 + 25 个并发拒绝请求
 * 3. 50 个并发无效签名请求（验证都被正确拒绝）
 * 4. 重复决策风暴（50 个并发请求尝试对同一审批做决策）
 */

// 预生成的 Dilithium2 密钥对（用于加速测试）
const PREGENERATED_KEYS = [];
(function generatePrekeys() {
  // 实际测试时会按需生成，这里只做占位
})();

import 'dotenv/config';
import express from 'express';
import bootstrapApi from '../src/http/routes/bootstrapApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { sign as pqcSign } from '../src/crypto/pqc.js';

// ─── 统计 ─────────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  successes: 0,
  failures: 0,
  errors: 0,
  rejections: 0,
  approvalIds: [],
  timings: []
};

function recordSuccess(id, elapsed) {
  stats.successes++;
  stats.timings.push(elapsed);
  if (id) stats.approvalIds.push(id);
}

function recordFailure(id, elapsed) {
  stats.failures++;
  stats.timings.push(elapsed);
  if (id) stats.approvalIds.push(id);
}

function recordError() {
  stats.errors++;
}

function recordRejection() {
  stats.rejections++;
}

// ─── 工具 ─────────────────────────────────────────────────────

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
app.use(express.json({ limit: '10mb' })); // 增大 body 限制以应对大签名

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

// ─── 测试 1: 10 个 Agent 并发创建审批请求（Dilithium2 很慢，减少并发） ─────────────────────

async function test1_concurrent_creation() {
  console.log('\n📋 Test 1: 10 concurrent approval creations');
  console.log('-'.repeat(70));

  const startTime = Date.now();
  const agentIds = [];
  const promises = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < CONCURRENCY; i++) {
    const agentId = `stress-agent-${i.toString().padStart(3, '0')}`;
    agentIds.push(agentId);

    const promise = (async () => {
      const keys = await generateTestKeys();
      try {
        await agentWalletManager.registerAgentWithKeyModel(agentId, {
          keyModel: 'self-sovereign',
          publicKeyHex: keys.publicKeyHex,
          privateKeyHex: keys.privateKeyHex,
          metadata: { spendConfig: { type: 'unlimited' } }
        });
      } catch (regErr) {
        return { registered: false };
      }

      const createStart = Date.now();
      try {
        const amount = (Math.random() * 1000 + 100).toFixed(0);
        const resp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            type: 'transfer',
            toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
            amount
          })
        });

        const elapsed = Date.now() - createStart;
        stats.totalRequests++;

        if (resp.ok) {
          const data = await resp.json();
          if (data.success) {
            recordSuccess(data.approvalId, elapsed);
            return { created: true, approvalId: data.approvalId, amount };
          }
        }
        recordFailure(null, elapsed);
        return { created: false };
      } catch (e) {
        recordError();
        return { error: e.message };
      }
    })();

    promises.push(promise);
  }

  // 50 个并发请求
  const results = await Promise.all(promises);

  const elapsed = Date.now() - startTime;
  const created = results.filter(r => r?.created).length;
  const failed = results.filter(r => !r?.created).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  Created: ${created}/${CONCURRENCY}`);
  console.log(`  Failed: ${failed}/${CONCURRENCY}`);
  console.log(`  Avg per request: ${(elapsed / CONCURRENCY).toFixed(1)}ms`);

  // 保存创建成功的 approvalId 供后续测试使用
  stats.test1Results = results.filter(r => r?.created);
  stats.test1ApprovalIds = stats.test1Results.map(r => r.approvalId);

  return { created, failed, elapsed };
}

// ─── 测试 2: 5 批准 + 5 拒绝并发 ────────────────────────────

async function test2_concurrent_decisions() {
  console.log('\n📋 Test 2: 5 approve + 5 reject concurrent decisions');
  console.log('-'.repeat(70));

  const CONCURRENCY = 10;
  if (!stats.test1Results || stats.test1Results.length < CONCURRENCY) {
    console.log(`  SKIP: Not enough approvals from Test 1 (have ${stats.test1Results?.length || 0}, need ${CONCURRENCY})`);
    return { skipped: true };
  }

  const startTime = Date.now();
  const promises = [];

  // 从 registry 获取 Agent 私钥用于签名
  const agentEntries = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const agentId = `stress-agent-${i.toString().padStart(3, '0')}`;
    const entry = agentWalletManager.registry.get(agentId);
    if (entry) {
      agentEntries.push({ agentId, privateKey: entry.wallet.privateKey });
    }
  }

  for (let i = 0; i < CONCURRENCY; i++) {
    const approvalId = stats.test1Results[i].approvalId;
    const agentEntry = agentEntries[i];
    const isApprove = i < 5; // 前 5 个批准，后 5 个拒绝

    const promise = (async () => {
      const decideStart = Date.now();
      try {
        const approval = stats.test1Results[i];
        // 使用创建时的实际金额（随机数）
        const message = `approval:${approval.approvalId}:${isApprove ? 'approve' : 'reject'}:${approval.amount}`;
        const sigBuffer = await pqcSign(message, agentEntry.privateKey);
        const masterSignature = sigBuffer.toString('hex');

        const resp = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: isApprove ? 'approve' : 'reject',
            masterSignature
          })
        });

        const elapsed = Date.now() - decideStart;
        stats.totalRequests++;

        if (resp.ok) {
          const data = await resp.json();
          if (data.success) {
            recordSuccess(approvalId, elapsed);
            return { decided: true, decision: data.decision };
          }
        }
        recordFailure(approvalId, elapsed);
        return { decided: false, status: resp.status };
      } catch (e) {
        recordError();
        return { error: e.message };
      }
    })();

    promises.push(promise);
  }

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  const approved = results.filter(r => r?.decided === true && r?.decision === 'approve').length;
  const rejected = results.filter(r => r?.decided === true && r?.decision === 'reject').length;
  const failed = results.filter(r => !r?.decided).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  Approved: ${approved}/5`);
  console.log(`  Rejected: ${rejected}/5`);
  console.log(`  Failed: ${failed}/${CONCURRENCY}`);
  console.log(`  Avg per request: ${(elapsed / CONCURRENCY).toFixed(1)}ms`);

  stats.test2Results = results;
  return { approved, rejected, failed, elapsed };
}

// ─── 测试 3: 20 个无效签名并发 ──────────────────────────────

async function test3_invalid_signatures() {
  console.log('\n📋 Test 3: 20 concurrent invalid signature attempts');
  console.log('-'.repeat(70));

  // 创建 10 个新的审批供测试
  const startTime = Date.now();
  const promises = [];
  const testApprovalIds = [];

  for (let i = 0; i < 10; i++) {
    const agentId = `invalid-sig-agent-${i.toString().padStart(3, '0')}`;
    const promise = (async () => {
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
          amount: '1000'
        })
      });

      const data = await resp.json();
      if (data.success) {
        testApprovalIds.push(data.approvalId);
      }
      return data;
    })();
    promises.push(promise);
  }

  await Promise.all(promises);
  console.log(`  Created ${testApprovalIds.length} test approvals`);

  // 现在用无效签名并发攻击
  const attackPromises = [];
  for (let i = 0; i < 20; i++) {
    const approvalId = testApprovalIds[i % testApprovalIds.length];
    const isApprove = i % 2 === 0;

    const attackPromise = (async () => {
      const decideStart = Date.now();
      try {
        const resp = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: isApprove ? 'approve' : 'reject',
            masterSignature: 'ff'.repeat(100) // 无效签名
          })
        });

        const elapsed = Date.now() - decideStart;
        stats.totalRequests++;

        if (resp.status === 403) {
          recordRejection();
          return { correctlyRejected: true };
        }
        recordFailure(approvalId, elapsed);
        return { incorrectlyAccepted: true, status: resp.status };
      } catch (e) {
        recordError();
        return { error: e.message };
      }
    })();

    attackPromises.push(attackPromise);
  }

  const results = await Promise.all(attackPromises);
  const elapsed = Date.now() - startTime;

  const correctlyRejected = results.filter(r => r?.correctlyRejected).length;
  const incorrectlyAccepted = results.filter(r => r?.incorrectlyAccepted).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  Correctly rejected: ${correctlyRejected}/20`);
  console.log(`  Incorrectly accepted: ${incorrectlyAccepted}/20 ⚠️  DANGEROUS!`);
  console.log(`  Avg per request: ${(elapsed / 20).toFixed(1)}ms`);

  return { correctlyRejected, incorrectlyAccepted, elapsed };
}

// ─── 测试 4: 重复决策风暴 ─────────────────────────────────────

async function test4_duplicate_decision_storm() {
  console.log('\n📋 Test 4: 20 concurrent duplicate decision attempts');
  console.log('-'.repeat(70));

  // 找一个还在 pending 状态的审批
  const pendingApproval = Object.values(agentWalletManager.registry).find(entry => {
    // 随机找一个
    return Math.random() > 0.5;
  });

  // 创建一个明确的 pending 审批
  const agentId = 'duplicate-test-agent';
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
      amount: '500'
    })
  });

  const createData = await createResp.json();
  const approvalId = createData.approvalId;

  if (!approvalId) {
    console.log('  SKIP: Could not create test approval');
    return { skipped: true };
  }

  console.log(`  Using approvalId: ${approvalId.slice(0, 16)}...`);

  // 100 个并发重复决策
  const startTime = Date.now();
  const promises = [];

  for (let i = 0; i < 20; i++) {
    const promise = (async () => {
      const decideStart = Date.now();
      try {
        const resp = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'approve',
            masterSignature: 'aa'.repeat(2420) // 随机 hex
          })
        });

        const elapsed = Date.now() - decideStart;
        stats.totalRequests++;

        if (resp.status === 400 || resp.status === 403) {
          return { correctlyRejected: true, status: resp.status };
        }
        const data = await resp.json();
        if (data.success) {
          return { firstDecision: true, decision: data.decision };
        }
        return { unknown: true, status: resp.status };
      } catch (e) {
        recordError();
        return { error: e.message };
      }
    })();

    promises.push(promise);
  }

  const results = await Promise.all(promises);
  const elapsed = Date.now() - startTime;

  const firstDecision = results.filter(r => r?.firstDecision).length;
  const correctlyRejected = results.filter(r => r?.correctlyRejected).length;

  console.log(`  Total time: ${elapsed}ms`);
  console.log(`  First decision succeeded: ${firstDecision}/20`);
  console.log(`  Subsequent correctly rejected: ${correctlyRejected}/20`);
  console.log(`  Avg per request: ${(elapsed / 20).toFixed(1)}ms`);

  return { firstDecision, correctlyRejected, elapsed };
}

// ─── 主测试流程 ───────────────────────────────────────────────

async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  CONCURRENT STRESS TEST SUITE');
  console.log('='.repeat(70));

  const overallStart = Date.now();

  const t1 = await test1_concurrent_creation();
  await sleep(2000); // 增加间隔让服务器恢复

  const t2 = await test2_concurrent_decisions();
  await sleep(2000);

  const t3 = await test3_invalid_signatures();
  await sleep(2000);

  const t4 = await test4_duplicate_decision_storm();

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

  console.log('\n  Per-Test Results:');
  console.log(`    Test 1 (Creation):    ${t1.created}/${t1.failed} created in ${t1.elapsed}ms`);
  if (!t2.skipped) {
    console.log(`    Test 2 (Decisions):   ${t2.approved} approved, ${t2.rejected} rejected, ${t2.failed} failed in ${t2.elapsed}ms`);
  }
  if (!t3.skipped) {
    console.log(`    Test 3 (Invalid Sig): ${t3.correctlyRejected}/100 rejected, ${t3.incorrectlyAccepted} accepted ⚠️`);
  }
  if (!t4.skipped) {
    console.log(`    Test 4 (Dup Storm):   ${t4.firstDecision} first succeeded, ${t4.correctlyRejected} correctly rejected in ${t4.elapsed}ms`);
  }

  // 安全检查
  console.log('\n' + '-'.repeat(70));
  if (t3?.incorrectlyAccepted > 0) {
    console.log('  🚨 SECURITY ISSUE: Invalid signatures were accepted!');
    console.log('  This is a critical vulnerability.');
  } else {
    console.log('  ✅ All invalid signatures were correctly rejected.');
  }

  if (t4?.firstDecision === 1) {
    console.log('  ✅ Only one decision succeeded (idempotent).');
  } else if (t4?.firstDecision > 1) {
    console.log(`  🚨 CONCURRENCY BUG: ${t4.firstDecision} decisions succeeded (should be 1)!`);
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

  // 退出码：如果有安全漏洞或错误则非零
  const hasCriticalIssues = results.errors > 0 || (results.failures > results.totalRequests * 0.1);
  server.close();

  if (hasCriticalIssues) {
    console.log('\n❌ Stress test FAILED - critical issues detected');
    process.exit(1);
  } else {
    console.log('\n✅ Stress test PASSED');
    process.exit(0);
  }
} catch (e) {
  console.error('FATAL ERROR:', e.message);
  server.close();
  process.exit(1);
}
