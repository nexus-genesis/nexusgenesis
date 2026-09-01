/**
 * remote-signer-keeper.test.js — Keeper 真实依赖组装测试（Key Custody 接入）
 *
 * 覆盖：
 *   - L1 custody token 验证（同构格式：有效/篡改/过期/secret 缺失 fail-closed）
 *   - keyring 加载（fail-closed：损坏/错位/空/坏私钥）
 *   - 策略：权威 session 比对（防自造宽 session）/ 过期 / maxPerTx / 白名单 /
 *     maxDaily 每日累计 / 无 amount 跳过 / 未知 agent
 *   - 防重放：nonce 二次拒绝
 *   - 真实签名：chain-eth signSmartAccountIntent → verifySmartAccountIntent 通过
 *   - 全链路（handleCustodySignRequest 直驱）：请求 HMAC / approval deny / 跨包
 *     互操作（agent-sdk createKeeperSigner 对上 mcp-server Keeper）
 *   - env gate：未设 port → null；缺 secret → 抛错；完整 env → 真实 HTTP e2e
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import {
  createL1CustodyVerifier,
  loadSessionKeyring,
  createSessionPolicyChecker,
  createReplayChecker,
  createKeyringSigner,
  buildKeeperHandle,
  startRealKeeperFromEnv,
} from '../src/remote-signer-keeper.js';
import { computeRequestHmac } from '../src/remote-signer.js';
import { createKeeperSigner, smartAccount } from 'nexusgenesis-agent-sdk';

const facadeSignSmartAccountIntent = smartAccount.signSmartAccountIntent;

import {
  signSmartAccountIntent,
  verifySmartAccountIntent,
  addressForPrivateKey,
} from 'nexusgenesis-chain-eth';

// ── fixtures ─────────────────────────────────────────────────────────────

const CUSTODY_SECRET = 'k'.repeat(32);
const SHARED_SECRET = 's'.repeat(32);

/** 与 src/http/custodyToken.js 同构的签发（测试用，锁定跨进程格式）。 */
function issueL1Token({ agentId, address = '0xaddr', ttl = 3600, secret = CUSTODY_SECRET }) {
  const now = Math.floor(Date.now() / 1000);
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'CUSTODY' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({
    sub: agentId, addr: address, fp: createHash('sha256').update('pk').digest('hex').slice(0, 32), iat: now, exp: now + ttl,
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest().toString('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

function makeSession(agentId, over = {}) {
  const issuedAt = Date.now() - 1000;
  return {
    type: 'session_key', version: 1, agentId, issuedAt, expiresAt: issuedAt + 3600_000,
    allowedContracts: ['0xcontract'], allowedMethods: ['transfer'], allowedChains: ['ethereum'],
    maxPerTx: '100', maxDaily: '1000', ...over,
  };
}

function makeIntent(over = {}) {
  return {
    action: 'transfer', chain: 'ethereum', asset: 'NGEN', amount: '50',
    recipient: '0xrecipient', contract: '0xcontract', method: 'transfer', nonce: '1', ...over,
  };
}

function makeKeyringEntry(agentId, sessionOver = {}) {
  return { privateKeyHex: '0x' + randomBytes(32).toString('hex'), session: makeSession(agentId, sessionOver) };
}

function makeKeyring(agentId = 'agent-1', sessionOver = {}) {
  const map = new Map();
  map.set(agentId, makeKeyringEntry(agentId, sessionOver));
  return map;
}

// ── L1 custody token 验证 ────────────────────────────────────────────────

describe('createL1CustodyVerifier', () => {
  test('secret 缺失/过短 → fail-closed 抛错', () => {
    assert.throws(() => createL1CustodyVerifier({}), /NG_CUSTODY_TOKEN_SECRET/);
    assert.throws(() => createL1CustodyVerifier({ secret: 'short' }), /NG_CUSTODY_TOKEN_SECRET/);
  });

  test('有效 token 验真并提取 agentId', async () => {
    const verify = createL1CustodyVerifier({ secret: CUSTODY_SECRET });
    const r = await verify(issueL1Token({ agentId: 'agent-1' }));
    assert.equal(r.valid, true);
    assert.equal(r.agentId, 'agent-1');
  });

  test('篡改签名 / 过期 / 非 token → 拒绝', async () => {
    const verify = createL1CustodyVerifier({ secret: CUSTODY_SECRET });
    const token = issueL1Token({ agentId: 'agent-1' });
    const tampered = token.slice(0, -4) + '0000';
    assert.equal((await verify(tampered)).valid, false);
    assert.equal((await verify(issueL1Token({ agentId: 'a', ttl: -10 }))).valid, false);
    assert.equal((await verify(null)).valid, false);
  });

  test('secret 与签发方不一致 → 拒绝（跨环境隔离）', async () => {
    const verify = createL1CustodyVerifier({ secret: CUSTODY_SECRET });
    const foreign = issueL1Token({ agentId: 'agent-1', secret: 'x'.repeat(32) });
    assert.equal((await verify(foreign)).valid, false);
  });
});

// ── keyring 加载 ─────────────────────────────────────────────────────────

describe('loadSessionKeyring', () => {
  test('有效文件 → Map（私钥规范化 0x+小写）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kr-'));
    try {
      const file = join(dir, 'kr.json');
      const pk = randomBytes(32).toString('hex').toUpperCase();
      writeFileSync(file, JSON.stringify({ 'agent-1': { privateKeyHex: pk, session: makeSession('agent-1') } }));
      const kr = loadSessionKeyring(file);
      assert.equal(kr.size, 1);
      const entry = kr.get('agent-1');
      assert.match(entry.privateKeyHex, /^0x[0-9a-f]{64}$/);
      assert.equal(entry.session.agentId, 'agent-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('损坏 / 空 / agentId 错位 / 坏私钥 → fail-closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kr-'));
    try {
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{not json');
      assert.throws(() => loadSessionKeyring(bad), /REMOTE_SIGNER_KEYRING_INVALID|unreadable/);

      const empty = join(dir, 'empty.json');
      writeFileSync(empty, '{}');
      assert.throws(() => loadSessionKeyring(empty), /REMOTE_SIGNER_KEYRING_INVALID/);

      const mismatch = join(dir, 'mismatch.json');
      writeFileSync(mismatch, JSON.stringify({
        'agent-1': { privateKeyHex: '0x' + randomBytes(32).toString('hex'), session: makeSession('other') },
      }));
      assert.throws(() => loadSessionKeyring(mismatch), /agentId mismatch/);

      const badpk = join(dir, 'badpk.json');
      writeFileSync(badpk, JSON.stringify({
        'agent-1': { privateKeyHex: '0x1234', session: makeSession('agent-1') },
      }));
      assert.throws(() => loadSessionKeyring(badpk), /REMOTE_SIGNER_KEYRING_INVALID/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── 策略 ─────────────────────────────────────────────────────────────────

describe('createSessionPolicyChecker', () => {
  // 权威 session（keyring 登记）就是请求应携带的 session；伪造用它的深拷贝变体。
  const setup = (sessionOver = {}) => {
    const keyring = makeKeyring('agent-1', sessionOver);
    const authority = keyring.get('agent-1').session;
    return { check: createSessionPolicyChecker({ keyring }), authority };
  };
  const custodyOk = { valid: true, agentId: 'agent-1' };

  test('合法请求（携带权威 session）→ allowed', async () => {
    const { check, authority } = setup();
    const r = await check({ session: authority, intent: makeIntent(), custody: custodyOk });
    assert.equal(r.allowed, true, r.reason);
  });

  test('伪造宽限额 session（与权威不符）→ 拒（防自造 session）', async () => {
    const { check, authority } = setup();
    const forged = { ...structuredClone(authority), maxPerTx: '999999' };
    const r = await check({ session: forged, intent: makeIntent({ amount: '500000' }), custody: custodyOk });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /does not match keeper-issued session/);
  });

  test('session 键序不同但内容相同 → allowed（稳定序列化比对）', async () => {
    const { check, authority } = setup();
    const reordered = structuredClone(authority);
    const r = await check({ session: reordered, intent: makeIntent(), custody: custodyOk });
    assert.equal(r.allowed, true);
  });

  test('过期 session → 拒', async () => {
    const { check, authority } = setup({ expiresAt: Date.now() - 1000 });
    const r = await check({ session: authority, intent: makeIntent(), custody: custodyOk });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /expired/);
  });

  test('amount 超 maxPerTx → 拒', async () => {
    const { check, authority } = setup();
    const r = await check({ session: authority, intent: makeIntent({ amount: '101' }), custody: custodyOk });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /maxPerTx/);
  });

  test('白名单外 contract / method / chain → 拒', async () => {
    const { check, authority } = setup();
    for (const over of [{ contract: '0xother' }, { method: 'swap' }, { chain: 'polygon' }]) {
      const r = await check({ session: authority, intent: makeIntent(over), custody: custodyOk });
      assert.equal(r.allowed, false, over.contract ?? over.method ?? over.chain);
      assert.match(r.reason, /not in session whitelist/);
    }
  });

  test('maxDaily 每日累计：第二笔超限 → 拒（保守计费）', async () => {
    // maxPerTx=100 单笔放行 60；maxDaily=100 累计 60+50=110 → 第二笔拒。
    const { check, authority } = setup({ maxDaily: '100' });
    const base = { session: authority, custody: custodyOk };
    assert.equal((await check({ ...base, intent: makeIntent({ amount: '60', nonce: '1' }) })).allowed, true);
    assert.equal((await check({ ...base, intent: makeIntent({ amount: '50', nonce: '2' }) })).allowed, false);
    // 0 = 不设限（与 checkSessionAccess 语义一致）
    const unlimitedKr = new Map([['agent-1', makeKeyringEntry('agent-1', { maxDaily: '0', maxPerTx: '0' })]]);
    const check2 = createSessionPolicyChecker({ keyring: unlimitedKr });
    const ua = unlimitedKr.get('agent-1').session;
    assert.equal((await check2({ session: ua, intent: makeIntent({ amount: '999999999' }), custody: custodyOk })).allowed, true);
  });

  test('非资产 intent（无 amount）→ 跳过限额 allowed', async () => {
    const { check, authority } = setup();
    const intent = makeIntent();
    delete intent.amount;
    const r = await check({ session: authority, intent, custody: custodyOk });
    assert.equal(r.allowed, true);
  });

  test('keyring 无此 agent → 拒', async () => {
    const { check } = setup();
    const r = await check({ session: makeSession('agent-x'), intent: makeIntent(), custody: { valid: true, agentId: 'agent-x' } });
    assert.equal(r.allowed, false);
    assert.match(r.reason, /no keyring entry/);
  });
});

// ── 防重放 / 真实签名 ─────────────────────────────────────────────────────

describe('createReplayChecker + createKeyringSigner', () => {
  test('同 nonce 二次拒绝', async () => {
    const check = createReplayChecker({});
    assert.equal((await check('n1')).ok, true);
    assert.equal((await check('n1')).ok, false);
    assert.equal((await check('n2')).ok, true);
  });

  test('真实签名 → verifySmartAccountIntent 通过（地址=keyring 私钥）', async () => {
    const keyring = makeKeyring('agent-1');
    const sign = createKeyringSigner({ keyring });
    const session = keyring.get('agent-1').session;
    const intent = makeIntent();
    const { signature, digest } = await sign({ intent, custody: { valid: true, agentId: 'agent-1' } });
    assert.match(signature, /^0x[0-9a-f]{130}$/);
    const addr = addressForPrivateKey(keyring.get('agent-1').privateKeyHex);
    const v = verifySmartAccountIntent({ address: addr, signature, session, intent });
    assert.equal(v.valid, true);
    assert.equal(v.digest, digest);
  });

  test('签名器拒绝未知 agent', async () => {
    const sign = createKeyringSigner({ keyring: makeKeyring('agent-1') });
    await assert.rejects(() => sign({ intent: makeIntent(), custody: { valid: true, agentId: 'ghost' } }), /no keyring entry/);
  });
});

// ── 全链路（handleCustodySignRequest 直驱） ───────────────────────────────

describe('buildKeeperHandle 全链路', () => {
  function setupHandle(over = {}) {
    const keyring = makeKeyring('agent-1');
    const handle = buildKeeperHandle({ keyring, custodySecret: CUSTODY_SECRET, sharedSecret: SHARED_SECRET, ...over });
    const session = keyring.get('agent-1').session;
    const pk = keyring.get('agent-1').privateKeyHex;
    return { handle, session, pk };
  }

  function makeRequest({ session, custodyToken, intent = makeIntent({ nonce: String(Date.now()) }) }) {
    const request = {
      custodyToken,
      agentId: session.agentId,
      session,
      intent,
      requestedAt: Date.now(),
      nonce: `nonce-${Math.random()}`,
    };
    request.hmac = computeRequestHmac(SHARED_SECRET, request);
    return request;
  }

  test('合法请求 → 签名成功且链上可验', async () => {
    const { handle, session, pk } = setupHandle();
    const request = makeRequest({ session, custodyToken: issueL1Token({ agentId: 'agent-1' }) });
    const res = await handle({ request });
    assert.equal(res.ok, true, res.reason);
    const addr = addressForPrivateKey(pk);
    const v = verifySmartAccountIntent({ address: addr, signature: res.signature, session, intent: request.intent });
    assert.equal(v.valid, true);
  });

  test('请求 HMAC 缺失/篡改 → REMOTE_SIGNER_REQUEST_HMAC_INVALID', async () => {
    const { handle, session } = setupHandle();
    const request = makeRequest({ session, custodyToken: issueL1Token({ agentId: 'agent-1' }) });
    const noHmac = { ...request };
    delete noHmac.hmac;
    assert.equal((await handle({ request: noHmac })).code, 'REMOTE_SIGNER_REQUEST_HMAC_INVALID');
    const tampered = { ...request, intent: { ...request.intent, amount: '999999' } };
    assert.equal((await handle({ request: tampered })).code, 'REMOTE_SIGNER_REQUEST_HMAC_INVALID');
  });

  test('approvalMode=deny → 人类放行闸默认拒绝', async () => {
    const { handle, session } = setupHandle({ approvalMode: 'deny' });
    const res = await handle({ request: makeRequest({ session, custodyToken: issueL1Token({ agentId: 'agent-1' }) }) });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'REMOTE_SIGNER_HUMAN_DENIED');
  });

  test('custody agent 与 keyring 不一致 → POLICY_DENIED', async () => {
    const { handle, session } = setupHandle();
    const res = await handle({ request: makeRequest({ session, custodyToken: issueL1Token({ agentId: 'agent-2' }) }) });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'REMOTE_SIGNER_POLICY_DENIED');
  });
});

// ── 跨包互操作：agent-sdk createKeeperSigner ↔ mcp-server Keeper ──────────

describe('跨包互操作（agent-sdk client ↔ keeper handle）', () => {
  test('createKeeperSigner 经 stub transport 对上真实 Keeper → 签名可用', async () => {
    const keyring = makeKeyring('agent-1');
    const handle = buildKeeperHandle({ keyring, custodySecret: CUSTODY_SECRET, sharedSecret: SHARED_SECRET });
    const session = keyring.get('agent-1').session;
    const pk = keyring.get('agent-1').privateKeyHex;

    const signer = createKeeperSigner({
      secret: SHARED_SECRET,
      custodyToken: issueL1Token({ agentId: 'agent-1' }),
      transport: async (request) => handle({ request }),
    });
    const intent = makeIntent({ nonce: String(Date.now()) });
    const { digest, signature } = await signer.signSmartAccountIntent({ session, intent });
    const v = verifySmartAccountIntent({
      address: addressForPrivateKey(pk), signature, session, intent,
    });
    assert.equal(v.valid, true);
    assert.equal(v.digest, digest);
  });

  test('响应 HMAC 篡改 → client 拒收（KEEPER_RESPONSE_INVALID）', async () => {
    const keyring = makeKeyring('agent-1');
    const handle = buildKeeperHandle({ keyring, custodySecret: CUSTODY_SECRET, sharedSecret: SHARED_SECRET });
    const session = keyring.get('agent-1').session;
    const signer = createKeeperSigner({
      secret: SHARED_SECRET,
      custodyToken: issueL1Token({ agentId: 'agent-1' }),
      transport: async (request) => {
        const res = await handle({ request });
        return { ...res, signature: res.signature.slice(0, -2) + '00' };
      },
    });
    await assert.rejects(
      () => signer.signSmartAccountIntent({ session, intent: makeIntent() }),
      /KEEPER_RESPONSE_INVALID|HMAC invalid/,
    );
  });
});

// ── env gate + 真实 HTTP e2e ─────────────────────────────────────────────

describe('startRealKeeperFromEnv', () => {
  const saved = {};
  before(() => {
    for (const k of ['REMOTE_SIGNER_KEEPER_PORT', 'NG_CUSTODY_TOKEN_SECRET', 'REMOTE_SIGNER_SHARED_SECRET', 'REMOTE_SIGNER_KEYRING_FILE', 'REMOTE_SIGNER_APPROVAL_MODE', 'REMOTE_SIGNER_KEEPER_BIND']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('未设 port → null（gate 关，零基线影响）', () => {
    assert.equal(startRealKeeperFromEnv(), null);
  });

  test('设了 port 但缺 secret/keyring → fail-closed 抛错', () => {
    process.env.REMOTE_SIGNER_KEEPER_PORT = '0';
    assert.throws(() => startRealKeeperFromEnv(), /REMOTE_SIGNER_NOT_CONFIGURED|NG_CUSTODY_TOKEN_SECRET/);
    process.env.NG_CUSTODY_TOKEN_SECRET = CUSTODY_SECRET;
    assert.throws(() => startRealKeeperFromEnv(), /REMOTE_SIGNER_NOT_CONFIGURED|REMOTE_SIGNER_SHARED_SECRET/);
    process.env.REMOTE_SIGNER_SHARED_SECRET = SHARED_SECRET;
    assert.throws(() => startRealKeeperFromEnv(), /REMOTE_SIGNER_NOT_CONFIGURED|REMOTE_SIGNER_KEYRING_FILE/);
  });

  test('完整 env → 真实 HTTP e2e：agent-sdk client 按 url 签名成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kree-'));
    try {
      const keyring = makeKeyring('agent-1');
      const keyringFile = join(dir, 'keyring.json');
      writeFileSync(keyringFile, JSON.stringify(Object.fromEntries(keyring)));

      process.env.REMOTE_SIGNER_KEYRING_FILE = keyringFile;
      process.env.REMOTE_SIGNER_KEEPER_PORT = '0';
      const server = startRealKeeperFromEnv();
      assert.ok(server, 'keeper should start');
      await once(server, 'listening');
      const port = server.address().port;

      const signer = createKeeperSigner({
        url: `http://127.0.0.1:${port}`,
        secret: SHARED_SECRET,
        custodyToken: issueL1Token({ agentId: 'agent-1' }),
      });
      const session = keyring.get('agent-1').session;
      const intent = makeIntent({ nonce: String(Date.now()) });
      const { signature } = await signer.signSmartAccountIntent({ session, intent });
      assert.equal(
        verifySmartAccountIntent({ address: addressForPrivateKey(keyring.get('agent-1').privateKeyHex), signature, session, intent }).valid,
        true,
      );

      // 被拒路径：伪造 session → keeper 拒 → client 抛 KEEPER_SIGN_DENIED
      const forged = makeSession('agent-1', { maxPerTx: '9999999' });
      await assert.rejects(
        () => signer.signSmartAccountIntent({ session: forged, intent: makeIntent({ nonce: String(Date.now()) }) }),
        /KEEPER_SIGN_DENIED|does not match/,
      );

      server.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── agent-sdk facade env gate：REMOTE_SIGNER_URL → 云端 AGENT 远程签名 ────

describe('agent-sdk facade env gate（smartAccount.signSmartAccountIntent）', () => {
  const saved = {};
  before(() => {
    for (const k of ['REMOTE_SIGNER_URL', 'REMOTE_SIGNER_SHARED_SECRET', 'REMOTE_SIGNER_CUSTODY_TOKEN', 'NG_CUSTODY_TOKEN_SECRET']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('remote 模式拒绝 privateKeyHex（KEEPER_LOCAL_KEY_FORBIDDEN，检查先于 transport）', async () => {
    const keyring = makeKeyring('agent-1');
    process.env.REMOTE_SIGNER_URL = 'stub://keeper';
    process.env.REMOTE_SIGNER_SHARED_SECRET = SHARED_SECRET;
    process.env.REMOTE_SIGNER_CUSTODY_TOKEN = issueL1Token({ agentId: 'agent-1' });
    await assert.rejects(
      () => facadeSignSmartAccountIntent({
        session: keyring.get('agent-1').session,
        intent: makeIntent(),
        privateKeyHex: keyring.get('agent-1').privateKeyHex,
      }),
      /KEEPER_LOCAL_KEY_FORBIDDEN|forbids privateKeyHex/,
    );
  });

  test('URL 设了但 secret 缺 → KEEPER_NOT_CONFIGURED（不静默回退本地私钥）', async () => {
    delete process.env.REMOTE_SIGNER_SHARED_SECRET;
    await assert.rejects(
      () => facadeSignSmartAccountIntent({ session: makeSession('agent-1'), intent: makeIntent() }),
      /KEEPER_NOT_CONFIGURED|REMOTE_SIGNER_SHARED_SECRET/,
    );
  });

  test('remote 模式端到端：真实 Keeper → facade 签名 → payload 重建 + 链上可验', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kfac-'));
    try {
      const keyring = makeKeyring('agent-1');
      const keyringFile = join(dir, 'keyring.json');
      writeFileSync(keyringFile, JSON.stringify(Object.fromEntries(keyring)));

      process.env.NG_CUSTODY_TOKEN_SECRET = CUSTODY_SECRET;
      process.env.REMOTE_SIGNER_KEYRING_FILE = keyringFile;
      process.env.REMOTE_SIGNER_KEEPER_PORT = '0';
      process.env.REMOTE_SIGNER_SHARED_SECRET = SHARED_SECRET;
      const server = startRealKeeperFromEnv();
      assert.ok(server, 'keeper should start');
      await once(server, 'listening');
      const port = server.address().port;

      // 云端 AGENT 只设 env（无任何私钥），走 facade 官方入口。
      process.env.REMOTE_SIGNER_URL = `http://127.0.0.1:${port}`;
      process.env.REMOTE_SIGNER_SHARED_SECRET = SHARED_SECRET;
      process.env.REMOTE_SIGNER_CUSTODY_TOKEN = issueL1Token({ agentId: 'agent-1' });

      const session = keyring.get('agent-1').session;
      const intent = makeIntent({ nonce: String(Date.now()) });
      const { payload, digest, signature } = await facadeSignSmartAccountIntent({ session, intent });

      // payload 由 (session, intent) 本地确定性重建，可直接喂 smart_account_execute。
      assert.equal(payload.type, 'agent_asset_intent');
      assert.equal(payload.agentId, 'agent-1');
      assert.equal(payload.amount, intent.amount);
      assert.equal(payload.nonce, intent.nonce);

      // 签名与本地签名路径完全同构：链上验真 + digest 一致。
      const v = verifySmartAccountIntent({
        address: addressForPrivateKey(keyring.get('agent-1').privateKeyHex),
        signature, session, intent,
      });
      assert.equal(v.valid, true);
      assert.equal(v.digest, digest);

      server.close();
    } finally {
      delete process.env.REMOTE_SIGNER_KEEPER_PORT;
      delete process.env.REMOTE_SIGNER_KEYRING_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
