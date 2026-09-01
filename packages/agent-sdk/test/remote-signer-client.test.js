/**
 * remote-signer-client.test.js — 云端 AGENT 侧 Keeper 签名客户端测试
 *
 * 覆盖：
 *   - 形状校验（缺字段 / intent.nonce 缺失 → fail-closed）
 *   - stub transport 全流程：请求带 HMAC、响应 HMAC 验真 → { digest, signature }
 *   - 防伪：响应 HMAC 篡改 / nonce 替换 → KEEPER_RESPONSE_INVALID
 *   - 拒签（ok:false）→ KEEPER_SIGN_DENIED；transport 失败 → KEEPER_TRANSPORT_FAIL
 *   - custodyToken 固定值 / 函数源 / 缺失
 *   - 构造参数校验（transport 或 url 必须其一）
 *
 * 协议一致性：agent-sdk client ↔ mcp-server Keeper 的跨包互操作用例在
 * mcp-server/test/remote-signer-keeper.test.js（mcp-server 依赖 agent-sdk，
 * 反向依赖不成立，故互操作测试放那边）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createKeeperSigner, createKeeperSignerFromEnv } from '../src/remote-signer-client.js';

const SECRET = 'shared-secret-32-chars-minimum-ok';

function makeSession() {
  const issuedAt = Date.now() - 1000;
  return {
    type: 'session_key', version: 1, agentId: 'agent-1', issuedAt, expiresAt: issuedAt + 3600_000,
    allowedContracts: ['0xcontract'], allowedMethods: ['transfer'], allowedChains: ['ethereum'],
    maxPerTx: '100', maxDaily: '1000',
  };
}

function makeIntent() {
  return {
    action: 'transfer', chain: 'ethereum', asset: 'NGEN', amount: '50',
    recipient: '0xrecipient', contract: '0xcontract', method: 'transfer', nonce: '1',
  };
}

/** 与 wire 协议一致的响应构造（模拟 Keeper 侧）。 */
function keeperResponse(secret, request, over = {}) {
  const response = {
    ok: true,
    signature: '0x' + 'ab'.repeat(65),
    digest: '0x' + 'cd'.repeat(32),
    requestedAt: request.requestedAt,
    nonce: request.nonce,
  };
  response.hmac = createHmac('sha256', secret)
    .update(JSON.stringify({ ok: true, signature: response.signature, digest: response.digest, requestedAt: response.requestedAt, nonce: response.nonce }))
    .digest('hex');
  return { ...response, ...over };
}

describe('createKeeperSigner 构造', () => {
  test('缺 secret → 抛错', () => {
    assert.throws(() => createKeeperSigner({ transport: async () => ({}) }), /secret/);
  });

  test('transport 与 url 都缺 → 抛错', () => {
    assert.throws(() => createKeeperSigner({ secret: SECRET }), /transport or url/);
  });

  test('url 模式可构造（惰性，不发起连接）', () => {
    const signer = createKeeperSigner({ url: 'http://127.0.0.1:1', secret: SECRET, custodyToken: 't' });
    assert.equal(typeof signer.signSmartAccountIntent, 'function');
  });
});

describe('形状校验（发送前快速失败）', () => {
  test('缺 session / custodyToken / intent → KEEPER_MALFORMED_REQUEST', async () => {
    const signer = createKeeperSigner({ secret: SECRET, custodyToken: 't', transport: async () => ({}) });
    await assert.rejects(() => signer.signSmartAccountIntent({ intent: makeIntent() }), /KEEPER_MALFORMED_REQUEST|missing field/);
  });

  test('intent.nonce 缺失 → 拒（链上防重放依赖）', async () => {
    const signer = createKeeperSigner({ secret: SECRET, custodyToken: 't', transport: async () => ({}) });
    const intent = makeIntent();
    delete intent.nonce;
    await assert.rejects(() => signer.signSmartAccountIntent({ session: makeSession(), intent }), /intent\.nonce is required/);
  });
});

describe('stub transport 全流程', () => {
  function setup(responseOver, requestSpy) {
    const seen = [];
    const signer = createKeeperSigner({
      secret: SECRET,
      custodyToken: 'tok-123',
      transport: async (request) => {
        seen.push(request);
        if (requestSpy) return requestSpy(request);
        return keeperResponse(SECRET, request, responseOver);
      },
    });
    return { signer, seen };
  }

  test('成功路径：请求带 HMAC + 固定序字段 → 返回 { digest, signature }', async () => {
    const { signer, seen } = setup();
    const session = makeSession();
    const intent = makeIntent();
    const out = await signer.signSmartAccountIntent({ session, intent });
    assert.match(out.signature, /^0x[0-9a-f]{130}$/);
    assert.match(out.digest, /^0x[0-9a-f]{64}$/);

    const req = seen[0];
    assert.equal(req.custodyToken, 'tok-123');
    assert.equal(req.agentId, 'agent-1');
    assert.equal(req.session, session);
    assert.equal(typeof req.requestedAt, 'number');
    assert.ok(req.nonce);
    // 请求 HMAC 可复算（与 Keeper 规则一致：六核心字段固定序）
    const expected = createHmac('sha256', SECRET).update(JSON.stringify({
      custodyToken: req.custodyToken, agentId: req.agentId, session: req.session,
      intent: req.intent, requestedAt: req.requestedAt, nonce: req.nonce,
    })).digest('hex');
    assert.equal(req.hmac, expected);
  });

  test('响应 HMAC 篡改 → KEEPER_RESPONSE_INVALID', async () => {
    const { signer } = setup({ signature: '0x' + 'ff'.repeat(65) });
    await assert.rejects(() => signer.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() }), /KEEPER_RESPONSE_INVALID/);
  });

  test('nonce 替换（回放替换攻击）→ KEEPER_RESPONSE_INVALID', async () => {
    // HMAC 对篡改后的 body 有效（模拟"合法 Keeper 签了 A，攻击者换 nonce 回放"）——
    // 命中的应是 client 的 expectedNonce 检查而非 HMAC 检查。
    const signer = createKeeperSigner({
      secret: SECRET, custodyToken: 't',
      transport: async (request) => keeperResponse(SECRET, request, {
        nonce: 'other-nonce',
        hmac: createHmac('sha256', SECRET).update(JSON.stringify({
          ok: true,
          signature: '0x' + 'ab'.repeat(65),
          digest: '0x' + 'cd'.repeat(32),
          requestedAt: request.requestedAt,
          nonce: 'other-nonce',
        })).digest('hex'),
      }),
    });
    await assert.rejects(() => signer.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() }), /nonce mismatch/);
  });

  test('Keeper 拒签（ok:false）→ KEEPER_SIGN_DENIED（带 reason）', async () => {
    const signer = createKeeperSigner({
      secret: SECRET, custodyToken: 't',
      transport: async () => ({ ok: false, reason: 'policy denied' }),
    });
    await assert.rejects(() => signer.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() }), /policy denied/);
  });

  test('transport 抛错 → KEEPER_TRANSPORT_FAIL', async () => {
    const signer = createKeeperSigner({
      secret: SECRET, custodyToken: 't',
      transport: async () => { throw new Error('conn refused'); },
    });
    await assert.rejects(() => signer.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() }), /KEEPER_TRANSPORT_FAIL/);
  });

  test('custodyToken 为函数 → 每次调用获取（可自动刷新）', async () => {
    let calls = 0;
    const signer = createKeeperSigner({
      secret: SECRET,
      custodyToken: async () => `tok-${++calls}`,
      transport: async (request) => keeperResponse(SECRET, request),
    });
    await signer.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() });
    await signer.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() });
    assert.ok(calls >= 2);
  });
});

describe('createKeeperSignerFromEnv（env gate 工厂）', () => {
  const saved = {};
  function withEnv(env) {
    for (const k of ['REMOTE_SIGNER_URL', 'REMOTE_SIGNER_SHARED_SECRET', 'REMOTE_SIGNER_CUSTODY_TOKEN', 'REMOTE_SIGNER_TIMEOUT_MS']) {
      if (k in env) process.env[k] = env[k];
      else delete process.env[k];
    }
  }

  test('REMOTE_SIGNER_URL 未设 → null（gate 关，零基线影响）', () => {
    withEnv({});
    assert.equal(createKeeperSignerFromEnv(), null);
  });

  test('URL 设了但 secret 缺 → KEEPER_NOT_CONFIGURED（fail-closed）', () => {
    withEnv({ REMOTE_SIGNER_URL: 'http://127.0.0.1:7788' });
    assert.throws(() => createKeeperSignerFromEnv(), /KEEPER_NOT_CONFIGURED|REMOTE_SIGNER_SHARED_SECRET/);
  });

  test('完整 env → 构建 signer（stub transport 同形状可签）', async () => {
    withEnv({ REMOTE_SIGNER_URL: 'http://127.0.0.1:7788', REMOTE_SIGNER_SHARED_SECRET: SECRET, REMOTE_SIGNER_CUSTODY_TOKEN: 'tok-1' });
    const signer = createKeeperSignerFromEnv();
    assert.ok(signer && typeof signer.signSmartAccountIntent === 'function');
    const captured = [];
    // env gate 不注入 transport（真实 HTTP）；此处直接验证产物形状 + 用同参
    // 构建的注入版做行为等价校验。
    const equiv = createKeeperSigner({
      secret: process.env.REMOTE_SIGNER_SHARED_SECRET,
      custodyToken: process.env.REMOTE_SIGNER_CUSTODY_TOKEN,
      transport: async (request) => { captured.push(request); return keeperResponse(SECRET, request); },
    });
    const res = await equiv.signSmartAccountIntent({ session: makeSession(), intent: makeIntent() });
    assert.equal(typeof res.signature, 'string');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].custodyToken, 'tok-1');
  });
});
