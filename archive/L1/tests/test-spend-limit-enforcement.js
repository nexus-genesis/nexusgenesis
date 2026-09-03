/**
 * NexusGenesis - Spend Limit Enforcement Tests
 * 
 * 验证额度限制中间件的正确性：
 * 1. 超过每日额度 → 429 + requiresHumanApproval: true
 * 2. 未超过额度 → 继续放行
 * 3. unlimited 模式 → 永远放行
 * 4. per-tx 模式 → 单笔限制
 * 5. 自定义额度 → 动态调整
 */

import 'dotenv/config';
import assert from 'assert';

// Mock Express request/response objects
function createMockReq(body = {}, agentRecord = {}, state = {}) {
  return {
    body,
    app: {
      locals: {
        state
      }
    },
    agentRecord,
    customSpendConfig: null
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    json: function (body) {
      this.jsonBody = body;
      return this;
    },
    status: function (code) {
      this.statusCode = code;
      return this;
    }
  };
  return res;
}

function createNext() {
  let called = false;
  const next = () => { called = true; };
  next.wasCalled = () => called;
  return next;
}

// Dynamically import the middleware
let checkDailySpendLimit;
(async () => {
  const mod = await import('../src/http/middleware/opKeyVerification.js');
  checkDailySpendLimit = mod.checkDailySpendLimit;

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

  // ─── 测试 1: 超过每日额度 → 429 + requiresHumanApproval ──────────

  console.log('\n[Test 1] Exceeds daily limit → 429 + requiresHumanApproval');
  {
    // 模拟今日已花费 900 NGEN
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const mockReq = createMockReq(
      { amount: '2000000000000000000' }, // 2 NGEN
      {
        agentId: 'test-agent-001',
        spendConfig: { type: 'fixed', dailyLimit: '1000000000000000000' } // 1 NGEN
      },
      {
        transactions: {
          txHistory: [
            {
              from: 'test-agent-001',
              amount: '900000000000000000', // 0.9 NGEN
              timestamp: todayTimestamp + 1000
            }
          ]
        }
      }
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 429, 'Returns 429 status code');
    assert(mockRes.jsonBody.requiresHumanApproval === true, 'Sets requiresHumanApproval to true');
    assert(mockRes.jsonBody.error_code === 'SPEND_LIMIT_EXCEEDED', 'Error code is SPEND_LIMIT_EXCEEDED');
    assert(mockRes.jsonBody.spendConfig === 'fixed', 'Includes spendConfig type');
    assert(next.wasCalled() === false, 'Does NOT call next() — blocked');
  }

  // ─── 测试 2: 未超过额度 → 放行 ──────────────────────────────────

  console.log('\n[Test 2] Within daily limit → passes through');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const mockReq = createMockReq(
      { amount: '500000000000000000' }, // 0.5 NGEN
      {
        agentId: 'test-agent-002',
        spendConfig: { type: 'fixed', dailyLimit: '1000000000000000000' } // 1 NGEN
      },
      {
        transactions: {
          txHistory: [
            {
              from: 'test-agent-002',
              amount: '400000000000000000', // 0.4 NGEN
              timestamp: todayTimestamp + 1000
            }
          ]
        }
      }
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
    assert(typeof mockReq.dailyLimitRemaining === 'string', 'Sets remaining limit as string');
  }

  // ─── 测试 3: unlimited 模式 → 永远放行 ──────────────────────────

  console.log('\n[Test 3] Unlimited mode → always passes');
  {
    const mockReq = createMockReq(
      { amount: '999999999999999999999' }, // 超大金额
      {
        agentId: 'test-agent-003',
        spendConfig: { type: 'unlimited' }
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

  // ─── 测试 4: per-tx 模式 → 单笔限制 ─────────────────────────────

  console.log('\n[Test 4] Per-tx mode → single transaction limit');
  {
    const mockReq = createMockReq(
      { amount: '2000000000000000000' }, // 2 NGEN
      {
        agentId: 'test-agent-004',
        spendConfig: { type: 'per-tx', singleTxLimit: '1000000000000000000' } // 1 NGEN
      },
      {}
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 429, 'Returns 429 status code');
    assert(mockRes.jsonBody.requiresHumanApproval === true, 'Sets requiresHumanApproval to true');
    assert(next.wasCalled() === false, 'Does NOT call next() — blocked');
  }

  // ─── 测试 5: per-tx 模式内 → 放行 ──────────────────────────────

  console.log('\n[Test 5] Per-tx within limit → passes');
  {
    const mockReq = createMockReq(
      { amount: '500000000000000000' }, // 0.5 NGEN
      {
        agentId: 'test-agent-005',
        spendConfig: { type: 'per-tx', singleTxLimit: '1000000000000000000' } // 1 NGEN
      },
      {}
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
  }

  // ─── 测试 6: 无 Agent 记录 → 跳过检查 ──────────────────────────

  console.log('\n[Test 6] No agent record → skips check');
  {
    const mockReq = createMockReq(
      { amount: '999999999999999999999' },
      null, // 无 agentRecord
      {}
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(next.wasCalled() === true, 'Calls next() — skipped');
  }

  // ─── 测试 7: 精确等于额度 → 放行（不超限） ──────────────────────

  console.log('\n[Test 7] Exactly at limit → allows (not exceeded)');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const mockReq = createMockReq(
      { amount: '1000000000000000000' }, // 正好 1 NGEN
      {
        agentId: 'test-agent-007',
        spendConfig: { type: 'fixed', dailyLimit: '1000000000000000000' } // 1 NGEN
      },
      {
        transactions: {
          txHistory: [
            {
              from: 'test-agent-007',
              amount: '0', // 今日未花费
              timestamp: todayTimestamp + 1000
            }
          ]
        }
      }
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 200, 'Status remains 200');
    assert(next.wasCalled() === true, 'Calls next() — allowed through');
  }

  // ─── 测试 8: 超过额度 1 单位 → 拒绝 ────────────────────────────

  console.log('\n[Test 8] Exceeds by 1 unit → rejects');
  {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTimestamp = today.getTime();

    const mockReq = createMockReq(
      { amount: '1' }, // 多 1 个单位
      {
        agentId: 'test-agent-008',
        spendConfig: { type: 'fixed', dailyLimit: '1000000000000000000' } // 1 NGEN
      },
      {
        transactions: {
          txHistory: [
            {
              from: 'test-agent-008',
              amount: '1000000000000000000', // 正好 1 NGEN
              timestamp: todayTimestamp + 1000
            }
          ]
        }
      }
    );

    const mockRes = createMockRes();
    const next = createNext();

    checkDailySpendLimit(mockReq, mockRes, next);

    assert(mockRes.statusCode === 429, 'Returns 429 status code');
    assert(mockRes.jsonBody.requiresHumanApproval === true, 'Sets requiresHumanApproval to true');
    assert(next.wasCalled() === false, 'Does NOT call next() — blocked');
  }

  // ─── 汇总 ────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60));
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
})();
