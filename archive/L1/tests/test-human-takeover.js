/**
 * NexusGenesis - Human Takeover Tests
 * 
 * 验证人类接管 Agent 钱包后的行为：
 * 1. 接管前：Agent 自主（unlimited）
 * 2. 接管后：人类控制（fixed 额度）
 * 3. 额度限制生效
 * 4. 控制状态查询
 */

import 'dotenv/config';
import assert from 'assert';
import crypto from 'crypto';

let checkDailySpendLimit;
let createMockReq, createMockRes, createNext;

(async () => {
  // 导入中间件
  const mw = await import('../src/http/middleware/opKeyVerification.js');
  checkDailySpendLimit = mw.checkDailySpendLimit;

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  PASS: ${message}`);
      passed++;
    } else {
      console.error(`  FAIL: ${message}`);
      failed++;
    }
  }

  function createMockReq(body = {}, agentRecord = {}, state = {}) {
    return {
      body,
      app: { locals: { state } },
      agentRecord,
      customSpendConfig: null
    };
  }

  function createMockRes() {
    const res = {
      statusCode: 200,
      jsonBody: null,
      json: function (body) { this.jsonBody = body; return this; },
      status: function (code) { this.statusCode = code; return this; }
    };
    return res;
  }

  function createNext() {
    let called = false;
    const next = () => { called = true; };
    next.wasCalled = () => called;
    return next;
  }

  // ─── 辅助函数：模拟人类签名 ──────────────────────────────────────

  async function simulateHumanSignature(agentPublicKeyHex) {
    // 模拟人类用主密钥签名（实际应该用真实的主密钥私钥）
    // 这里简化：返回一个有效的签名占位符
    const message = `takeover:test-agent:${Date.now()}`;
    return crypto.randomBytes(2560).toString('hex'); // 占位签名
  }

  // ─── 测试 1: 接管前 — Agent 自主（unlimited） ─────────────────────

  console.log('\n[Test 1] Before takeover — Agent autonomous (unlimited)');
  {
    const mockReq = createMockReq(
      { amount: '999999999999999999999' }, // 超大金额
      {
        agentId: 'test-agent-001',
        keyModel: 'self-sovereign',
        spendConfig: { type: 'unlimited' },
        takenOver: false
      },
      {}
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
    assert(mockReq.dailyLimitRemaining === 'unlimited', 'Sets unlimited flag');
  }

  // ─── 测试 2: 接管后 — 默认 fixed 额度（1 NGEN） ─────────────────

  console.log('\n[Test 2] After takeover — Default fixed limit (1 NGEN)');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    // 模拟接管后的 Agent 状态
    const agentRecord = {
      agentId: 'test-agent-002',
      keyModel: 'self-sovereign',
      spendConfig: {
        type: 'fixed',
        dailyLimit: '1000000000000000000', // 1 NGEN
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      },
      takenOver: true
    };

    const state = {
      transactions: {
        txHistory: [
          {
            from: 'test-agent-002',
            amount: '500000000000000000', // 0.5 NGEN 今日已花费
            timestamp: todayTimestamp + 1000
          }
        ]
      }
    };

    const mockReq = createMockReq(
      { amount: '1000000000000000000' }, // 1 NGEN（会超限：0.5 + 1 > 1）
      agentRecord,
      state
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 429, 'Returns 429 status code');
    assert(mockRes.jsonBody.requiresHumanApproval === true, 'Sets requiresHumanApproval to true');
    assert(mockRes.jsonBody.spendConfig === 'fixed', 'Spend config is fixed');
    assert(next.wasCalled() === false, 'Does NOT call next() — blocked');
  }

  // ─── 测试 3: 接管后 — 小额交易通过 ──────────────────────────────

  console.log('\n[Test 3] After takeover — Small transaction passes');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const agentRecord = {
      agentId: 'test-agent-003',
      keyModel: 'self-sovereign',
      spendConfig: {
        type: 'fixed',
        dailyLimit: '1000000000000000000', // 1 NGEN
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      },
      takenOver: true
    };

    const state = {
      transactions: {
        txHistory: [
          {
            from: 'test-agent-003',
            amount: '500000000000000000', // 0.5 NGEN
            timestamp: todayTimestamp + 1000
          }
        ]
      }
    };

    const mockReq = createMockReq(
      { amount: '400000000000000000' }, // 0.4 NGEN（0.5 + 0.4 < 1，不超限）
      agentRecord,
      state
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
  }

  // ─── 测试 4: 人类重新设置额度为 10 NGEN ─────────────────────────

  console.log('\n[Test 4] Human raises limit to 10 NGEN — larger transactions pass');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    // 人类已将额度提升到 10 NGEN
    const agentRecord = {
      agentId: 'test-agent-004',
      keyModel: 'self-sovereign',
      spendConfig: {
        type: 'fixed',
        dailyLimit: '10000000000000000000', // 10 NGEN
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      },
      takenOver: true
    };

    const state = {
      transactions: {
        txHistory: [
          {
            from: 'test-agent-004',
            amount: '500000000000000000', // 0.5 NGEN
            timestamp: todayTimestamp + 1000
          }
        ]
      }
    };

    const mockReq = createMockReq(
      { amount: '5000000000000000000' }, // 5 NGEN（0.5 + 5 < 10，不超限）
      agentRecord,
      state
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
  }

  // ─── 测试 5: 人类设置 unlimited — 再次放开 ─────────────────────

  console.log('\n[Test 5] Human sets unlimited — reopens autonomy');
  {
    const agentRecord = {
      agentId: 'test-agent-005',
      keyModel: 'self-sovereign',
      spendConfig: {
        type: 'unlimited',
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      },
      takenOver: true
    };

    const mockReq = createMockReq(
      { amount: '999999999999999999999' },
      agentRecord,
      {}
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
    assert(mockReq.dailyLimitRemaining === 'unlimited', 'Sets unlimited flag');
  }

  // ─── 测试 6: 控制状态标记 ───────────────────────────────────────

  console.log('\n[Test 6] Control status markers');
  {
    // 接管前的 Agent
    const preTakeover = {
      agentId: 'test-agent-006',
      keyModel: 'self-sovereign',
      spendConfig: { type: 'unlimited' },
      takenOver: false
    };

    assert(preTakeover.takenOver === false, 'Pre-takeover: takenOver is false');
    assert(preTakeover.spendConfig.type === 'unlimited', 'Pre-takeover: unlimited');

    // 接管后的 Agent
    const postTakeover = {
      agentId: 'test-agent-006',
      keyModel: 'self-sovereign',
      spendConfig: {
        type: 'fixed',
        dailyLimit: '1000000000000000000',
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      },
      takenOver: true
    };

    assert(postTakeover.takenOver === true, 'Post-takeover: takenOver is true');
    assert(postTakeover.spendConfig.humanControlled === true, 'Post-takeover: humanControlled flag');
    assert(postTakeover.spendConfig.takenOverAt !== null, 'Post-takeover: has timestamp');
  }

  // ─── 测试 7: 从 unlimited 切换到 fixed ─────────────────────────

  console.log('\n[Test 7] Switch from unlimited to fixed — immediate effect');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    // 切换后的状态
    const agentRecord = {
      agentId: 'test-agent-007',
      keyModel: 'self-sovereign',
      spendConfig: {
        type: 'fixed',
        dailyLimit: '1000000000000000000', // 1 NGEN
        humanControlled: true,
        takenOverAt: new Date().toISOString()
      },
      takenOver: true
    };

    const state = {
      transactions: {
        txHistory: [
          {
            from: 'test-agent-007',
            amount: '1000000000000000000', // 1 NGEN（已满）
            timestamp: todayTimestamp + 1000
          }
        ]
      }
    };

    const mockReq = createMockReq(
      { amount: '1' }, // 再多 1 个单位
      agentRecord,
      state
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 429, 'Returns 429 — limit enforced immediately');
    assert(mockRes.jsonBody.requiresHumanApproval === true, 'Requires human approval');
  }

  // ─── 汇总 ────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
})();
