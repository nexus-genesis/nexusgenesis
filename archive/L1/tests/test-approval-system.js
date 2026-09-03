/**
 * NexusGenesis - Approval System End-to-End Tests
 * 
 * 验证审批系统的完整流程：
 * 1. 注册 Agent
 * 2. 创建审批请求
 * 3. 查询审批详情
 * 4. 人类批准审批
 * 5. 人类拒绝审批
 * 6. 重复决策被拒绝
 * 7. 无效签名被拒绝
 */

import 'dotenv/config';
import express from 'express';
import bootstrapApi from '../src/http/routes/bootstrapApi.js';
import agentWalletManager from '../src/wallet/agentWalletManager.js';
import { sign as pqcSign } from '../src/crypto/pqc.js';

let passed = 0;
let failed = 0;

function logAssert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function generateTestKeys() {
  const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');
  const keyPair = ml_dsa44.keygen();
  return {
    publicKeyHex: Buffer.from(keyPair.publicKey).toString('hex'),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString('hex')
  };
}

(async () => {
  const app = express();
  app.use(express.json());

  const state = {
    agents: {},
    approvals: {},
    balances: {},
    transactions: { txHistory: [] }
  };

  app.locals.state = state;
  app.locals.agentWalletManager = agentWalletManager;
  app.use(bootstrapApi);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // ─── 测试 1: 注册 Agent 并创建审批请求 ──────────────────────

    console.log('\n[Test 1] Register agent and create approval request');
    {
      const keys = await generateTestKeys();
      const agentId = 'test-approval-agent';

      const regResult = await agentWalletManager.registerAgentWithKeyModel(agentId, {
        keyModel: 'self-sovereign',
        publicKeyHex: keys.publicKeyHex,
        privateKeyHex: keys.privateKeyHex,
        metadata: { spendConfig: { type: 'unlimited' } }
      });

      logAssert(regResult.agentId === agentId, 'Agent registered (has agentId)');

      const createResp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          type: 'transfer',
          toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
          amount: '100000000000000000000',
          memo: 'Emergency fund transfer'
        })
      });

      const createData = await createResp.json();
      logAssert(createData.success === true, 'Approval request created');
      logAssert(createData.approvalId.startsWith('apr_'), 'Has valid approvalId');
      logAssert(createData.status === 'pending_human_approval', 'Status is pending');

      global.testApprovalId = createData.approvalId;
    }

    // ─── 测试 2: 查询审批详情 ──────────────────────────────

    console.log('\n[Test 2] Query approval detail');
    {
      const detailResp = await fetch(`${baseUrl}/api/v1/approvals/${global.testApprovalId}`);
      const detailText = await detailResp.text();
      console.log('  Detail status:', detailResp.status);
      console.log('  Detail body:', detailText.slice(0, 300));
      const detailData = JSON.parse(detailText);

      logAssert(detailData.success === true, 'Detail query succeeds');
      logAssert(detailData.approval.id === global.testApprovalId, 'Returns correct approval');
      logAssert(detailData.approval.type === 'transfer', 'Has correct type');
      logAssert(detailData.approval.status === 'pending', 'Status is pending');
    }

    // ─── 测试 3: 人类批准审批 ──────────────────────────────

    console.log('\n[Test 3] Human approves approval');
    {
      const agent = state.agents['test-approval-agent'];
      if (agent) {
        // 测试简化：用 agent 的私钥模拟人类主密钥签名
        // 真实场景中人类有独立的 master key pair
        const agentEntry = agentWalletManager.registry.get('test-approval-agent');
        const privateKey = agentEntry.wallet.privateKey;
        
        const message = `approval:${global.testApprovalId}:approve:100000000000000000000`;
        const sigBuffer = await pqcSign(message, privateKey);
        const masterSignature = sigBuffer.toString('hex');

        const decideResp = await fetch(`${baseUrl}/api/v1/approvals/${global.testApprovalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve', masterSignature })
        });

        const decideData = await decideResp.json();
        logAssert(decideData.success === true, 'Approval decision accepted');
        logAssert(decideData.decision === 'approve', 'Decision is approve');
      } else {
        console.log('  SKIP: Agent not found in state');
      }
    }

    // ─── 测试 4: 创建新审批并拒绝 ──────────────────────────────

    console.log('\n[Test 4] Human rejects approval');
    {
      const keys = await generateTestKeys();
      const agentId = 'test-reject-agent';

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
          amount: '50000000000000000000',
          memo: 'Will be rejected'
        })
      });

      const createData = await createResp.json();
      const rejectionId = createData.approvalId;

      const agentEntry = agentWalletManager.registry.get(agentId);
      const message = `approval:${rejectionId}:reject:50000000000000000000`;
      const sigBuffer = await pqcSign(message, agentEntry.wallet.privateKey);
      const masterSignature = sigBuffer.toString('hex');

      const decideResp = await fetch(`${baseUrl}/api/v1/approvals/${rejectionId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', masterSignature })
      });

      const decideData = await decideResp.json();
      logAssert(decideData.success === true, 'Rejection decision accepted');
      logAssert(decideData.decision === 'reject', 'Decision is reject');
    }

    // ─── 测试 5: 重复决策被拒绝 ──────────────────────────────

    console.log('\n[Test 5] Duplicate decision rejected');
    {
      const approved = state.approvals[global.testApprovalId];
      if (approved && approved.status === 'approved') {
        const agentEntry = agentWalletManager.registry.get('test-approval-agent');
        const message = `approval:${global.testApprovalId}:approve:100000000000000000000`;
        const sigBuffer = await pqcSign(message, agentEntry.wallet.privateKey);
        const masterSignature = sigBuffer.toString('hex');

        const decideResp = await fetch(`${baseUrl}/api/v1/approvals/${global.testApprovalId}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'approve', masterSignature })
        });

        const decideData = await decideResp.json();
        logAssert(decideData.success === false, 'Duplicate decision rejected');
        logAssert(decideData.error.includes('already'), 'Error indicates already decided');
      } else {
        console.log('  SKIP: Approved approval not found');
      }
    }

    // ─── 测试 6: 无效签名被拒绝 ──────────────────────────────

    console.log('\n[Test 6] Invalid signature rejected');
    {
      const keys = await generateTestKeys();
      const agentId = 'test-invalid-sig-agent';

      try {
        await agentWalletManager.registerAgentWithKeyModel(agentId, {
          keyModel: 'self-sovereign',
          publicKeyHex: keys.publicKeyHex,
          privateKeyHex: keys.privateKeyHex,
          metadata: { spendConfig: { type: 'unlimited' } }
        });
        console.log('  Agent registered for invalid sig test');
      } catch (regErr) {
        console.error('  Register failed:', regErr.message);
        logAssert(false, 'Agent registration failed: ' + regErr.message);
        throw regErr;
      }

      const createResp = await fetch(`${baseUrl}/api/v1/approvals/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          type: 'transfer',
          toAddress: 'ng112pnh7iAfvPBhvaxR8HZnRejjJMBppSm5FaME3aAPGTMeCpTN5S',
          amount: '10000000000000000000'
        })
      });

      console.log('  Create status:', createResp.status);
      const createText = await createResp.text();
      console.log('  Create body:', createText.slice(0, 300));
      const createData = JSON.parse(createText);
      const approvalId = createData.approvalId;

      const decideResp = await fetch(`${baseUrl}/api/v1/approvals/${approvalId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', masterSignature: 'ff'.repeat(100) })
      });

      console.log('  Decide status:', decideResp.status);
      const decideText = await decideResp.text();
      console.log('  Decide body:', decideText.slice(0, 300));
      const decideData = JSON.parse(decideText);
      logAssert(decideData.success === false, 'Invalid signature rejected');
      logAssert(decideData.error === 'Invalid master key signature', `Got: "${decideData.error}"`);
    }

    // ─── 汇总 ────────────────────────────────────────────────

    console.log('\n' + '='.repeat(60));
    console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

  } finally {
    server.close();
  }

  if (failed > 0) process.exit(1);
})();
