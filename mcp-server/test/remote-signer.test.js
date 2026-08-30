/**
 * remote-signer.test.js — Sprint 8: 远程托管签名器（Key Custody 核心）
 *
 * 覆盖：
 *   - handleCustodySignRequest（Keeper 纯逻辑，零网络）：
 *     完整顺利签名 + HMAC；缺字段复审/缺 nonce/意图内 nonce 缺失 → 拒；
 *     custody 无效 → SM_CUSTODY_REJECTED；防重放驳回；策略驳回；人类否决；
 *     签名抛错/signIntent 无签名；确认失败绝不返回部分签名。
 *   - verifyCustodySignResponse（Client 纯逻辑）：正常通过；HMAC 伪造/篡改 → invalid；
 *     nonce 替换重放 → invalid；非 ok 响应 → invalid。
 *   - createRemoteSignerClient（注入 transport，无真实网络）：成功返回签名；
 *     HMAC 失配抛 REMOTE_SIGNER_RESPONSE_INVALID；transport 抛错 → TRANSPORT_FAIL；
 *     超时；peform 前补形状校验（坏 intent 不发起 transport）。
 *   - startRemoteSignerKeeper：gate 关 → null；非法 port 抛错；loopback POST /sign
 *     端到端（HTTP 层 + 注入 handle）；非 POST /sign → 404/405。
 *   - 复核修复回归：R5 请求 HMAC（缺失/MITM 篡改 intent/错 secret → 拒签；Client
 *     自动附 hmac）；R6 超大请求体 → 413；R7 端口占用 → 日志 + 不崩进程。
 *
 * 全部依赖注入（transport / custody / policy / approval / signIntent），CI 零外部服务全绿。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  handleCustodySignRequest,
  verifyCustodySignResponse,
  computeKeeperHmac,
  computeRequestHmac,
  verifyKeeperHmac,
  createRemoteSignerClient,
  startRemoteSignerKeeper,
} from '../src/remote-signer.js';

let listener;

const SECRET = 'test-shared-secret';
/** keeper 依赖注入全套（默认全部放行，signIntent 返回固定签名）。 */
function deps(overrides = {}) {
  return {
    verifyCustodyToken: async () => ({ valid: true, agentId: 'agent-1', session: null }),
    checkPolicy: async () => ({ allowed: true, reason: 'ok' }),
    signIntent: async ({ session, intent }) => ({ signature: `0xsig:${intent.nonce}`, digest: `0xdig:${intent.nonce}` }),
    ...overrides,
  };
}
const okRequest = (overrides = {}) => {
  const r = {
    custodyToken: 'tok-1', agentId: 'agent-1',
    session: { agentId: 'agent-1', issuedAt: 1700000000000, expiresAt: 1800000000000 },
    intent: { mode: 'transfer', asset: 'ETH', amount: '10', recipient: '0xaddr', nonce: 1 },
    requestedAt: 1700000000000, nonce: 'n-1', ...overrides,
  };
  // 请求防伪（R5）：fixture 与生产 Client 同路径附 hmac。
  r.hmac = computeRequestHmac(SECRET, r);
  return r;
};

afterEach(async () => {
  if (listener) { await new Promise((r) => listener.close(r)); listener = null; }
  delete process.env.REMOTE_SIGNER_KEEPER_PORT;
});

function start(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('RS Keeper 圆满：核验全通过 → 签名 + 防伪 HMAC，失败绝不返回部分签名', async () => {
  const res = await handleCustodySignRequest({ request: okRequest(), secret: SECRET, ...deps() });
  assert.equal(res.ok, true);
  assert.equal(res.signature, '0xsig:1');
  assert.equal(res.digest, '0xdig:1');
  assert.equal(res.nonce, 'n-1');
  // HMAC 可复验（Client 侧校验路径）。
  const bare = { ok: true, signature: res.signature, digest: res.digest, requestedAt: res.requestedAt, nonce: res.nonce };
  assert.equal(verifyKeeperHmac(SECRET, bare, res.hmac), true);
});

test('RS Keeper 圆满：signIntent 返回 digest → 响应带回', async () => {
  const res = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ signIntent: async () => ({ signature: '0xsig', digest: '0xd1' }) }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.digest, '0xd1');
});

test('RS Keeper fail-closed：缺字段 / intent 含 nonce 缺失 → 拒', async () => {
  const missing = await handleCustodySignRequest({ request: okRequest({ custodyToken: undefined }), secret: SECRET, ...deps() });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'REMOTE_SIGNER_MALFORMED_REQUEST');

  const noIntentNonce = await handleCustodySignRequest({
    request: okRequest({ intent: { mode: 'transfer', amount: '1' } }), secret: SECRET, ...deps(),
  });
  assert.equal(noIntentNonce.ok, false);
  assert.equal(noIntentNonce.code, 'REMOTE_SIGNER_MALFORMED_REQUEST');

  // 请求级缺 nonce
  const noNonce = await handleCustodySignRequest({ request: okRequest({ nonce: undefined }), secret: SECRET, ...deps() });
  assert.equal(noNonce.ok, false);
});

test('RS Keeper fail-closed：custody 无效 → REMOTE_SIGNER_CUSTODY_REJECTED', async () => {
  const res = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ verifyCustodyToken: async () => ({ valid: false }) }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REMOTE_SIGNER_CUSTODY_REJECTED');
  assert.equal(res.signature, undefined, 'rejected request must not return a signature');
});

test('RS Keeper fail-closed：custody 校验抛错 → CUSTODY_FAIL', async () => {
  const res = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ verifyCustodyToken: async () => { throw new Error('vault down'); } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REMOTE_SIGNER_CUSTODY_FAIL');
});

test('RS Keeper 防重放：nonce 已被用 → REPLAY_REJECTED', async () => {
  const res = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ checkReplay: async () => ({ ok: false, reason: 'nonce already seen' }) }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REMOTE_SIGNER_REPLAY_REJECTED');
});

test('RS Keeper 策略：不通过 → POLICY_DENIED（含限额/白名单/仿真门）', async () => {
  const res = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ checkPolicy: async () => ({ allowed: false, reason: 'daily limit exceeded' }) }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REMOTE_SIGNER_POLICY_DENIED');
});

test('RS Keeper 人类可否决：人工未放行 → HUMAN_DENIED（高危签名前必过闸）', async () => {
  // 无 requestApproval 钩子 = 按策略直接签名。
  const auto = await handleCustodySignRequest({ request: okRequest(), secret: SECRET, ...deps() });
  assert.equal(auto.ok, true);
  // 有钩子但人类拒绝 → 拒签（即使策略通过）。
  const denied = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ requestApproval: async () => ({ approved: false, reason: 'keeper rejected' }) }),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'REMOTE_SIGNER_HUMAN_DENIED');
  // 有钩子且人工放行 → 签名。
  const approved = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ requestApproval: async () => ({ approved: true }) }),
  });
  assert.equal(approved.ok, true);
});

test('RS Keeper 签名失败：signIntent 抛错/无签名 → SIGN_FAIL，绝不部分签名', async () => {
  const boom = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ signIntent: async () => { throw new Error('key unavailable'); } }),
  });
  assert.equal(boom.ok, false);
  assert.equal(boom.code, 'REMOTE_SIGNER_SIGN_FAIL');

  const empty = await handleCustodySignRequest({
    request: okRequest(), secret: SECRET,
    ...deps({ signIntent: async () => ({}) }),
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'REMOTE_SIGNER_SIGN_FAIL');
});

test('RS Client verify：正常响应通过；HMAC 篡改/伪造 → invalid', () => {
  const response = { ok: true, signature: '0xsig', digest: '0xdig', requestedAt: 1, nonce: 'n-1' };
  response.hmac = computeKeeperHmac(SECRET, response);

  const good = verifyCustodySignResponse({ response, secret: SECRET, expectedNonce: 'n-1' });
  assert.equal(good.valid, true);
  assert.equal(good.signature, '0xsig');

  const forged = { ...response, hmac: '00'.repeat(64) };
  assert.equal(verifyCustodySignResponse({ response: forged, secret: SECRET, expectedNonce: 'n-1' }).valid, false);

  // 篡改签名（HMAC 未重新计算）
  const tampered = { ...response, signature: '0xEVIL' };
  assert.equal(verifyCustodySignResponse({ response: tampered, secret: SECRET, expectedNonce: 'n-1' }).valid, false);
});

test('RS Client verify：nonce 替换（回放替换）→ invalid', () => {
  const response = { ok: true, signature: '0xsig', digest: '0xdig', requestedAt: 1, nonce: 'attacker-nonce' };
  response.hmac = computeKeeperHmac(SECRET, response);
  assert.equal(verifyCustodySignResponse({ response, secret: SECRET, expectedNonce: 'n-1' }).valid, false);
});

test('RS Client 端到端：注入 transport → 成功返回签名（无真实网络）', async () => {
  const client = createRemoteSignerClient({
    secret: SECRET,
    transport: async (request) => {
      // 模拟人类侧 Keeper：核验 + 签名 + HMAC。
      const resp = { ok: true, signature: `0xsig:${request.nonce}`, digest: `0xdig:${request.nonce}`, requestedAt: request.requestedAt, nonce: request.nonce };
      resp.hmac = computeKeeperHmac(SECRET, resp);
      return resp;
    },
  });
  const out = await client.signIntent({ session: { agentId: 'a1' }, intent: { nonce: 7 }, nonce: 'n-7', custodyToken: 'tok-1' });
  assert.equal(out.signature, '0xsig:n-7');
  assert.equal(out.digest, '0xdig:n-7');
});

test('RS Client fail-closed：HMAC 失配 → REMOTE_SIGNER_RESPONSE_INVALID', async () => {
  const client = createRemoteSignerClient({
    secret: SECRET,
    transport: async () => ({ ok: true, signature: '0xevil', digest: null, requestedAt: 1, nonce: 'x', hmac: '00'.repeat(64) }),
  });
  await assert.rejects(() => client.signIntent({ session: { agentId: 'a1' }, intent: { nonce: 1 }, custodyToken: 'tok-1' }), { code: 'REMOTE_SIGNER_RESPONSE_INVALID' });
});

test('RS Client fail-closed：transport 失败 → TRANSPORT_FAIL；坏 intent 不前置于transport', async () => {
  let calls = 0;
  const failClient = createRemoteSignerClient({
    secret: SECRET,
    transport: async () => { calls++; throw new Error('network down'); },
  });
  await assert.rejects(() => failClient.signIntent({ session: { agentId: 'a1' }, intent: { nonce: 1 }, custodyToken: 'tok-1' }), { code: 'REMOTE_SIGNER_TRANSPORT_FAIL' });
  assert.equal(calls, 1);

  // 形状错误在 Client 侧先拦，不发起 transport。
  calls = 0;
  const okClient = createRemoteSignerClient({ secret: SECRET, transport: async () => { calls++; return { ok: true, signature: '0x', digest: null, requestedAt: 1, nonce: 'x' }; } });
  await assert.rejects(() => okClient.signIntent({ session: { agentId: 'a1' }, intent: {}, custodyToken: 'tok-1' }), { code: 'REMOTE_SIGNER_MALFORMED_REQUEST' });
  assert.equal(calls, 0, 'malformed request must not reach transport');
});

test('RS Client fail-closed：超时 → TRANSPORT_FAIL', async () => {
  const client = createRemoteSignerClient({
    secret: SECRET, signTimeoutMs: 20,
    transport: () => new Promise(() => {}), // 永不 resolve
  });
  await assert.rejects(() => client.signIntent({ session: { agentId: 'a1' }, intent: { nonce: 1 }, custodyToken: 'tok-1' }), { code: 'REMOTE_SIGNER_TRANSPORT_FAIL' });
});

test('RS Keeper HTTP gate：无 port → null；非法 port → 抛错', () => {
  assert.equal(startRemoteSignerKeeper({ handle: deps() }), null);
  assert.throws(() => startRemoteSignerKeeper({ port: 'abc', handle: deps() }), /REMOTE_SIGNER_KEEPER_PORT/);
});

test('RS Keeper HTTP 端到端：loopback POST /sign → 签名响应；GET / 404；PUT 405', async () => {
  // 注：HTTP 层不注入业务依赖，用 handle 闭包注入固定 ctx 的处理器做端到端冒烟。
  // checkPolicy 对 intent.nonce===2 拒绝 —— 验证 HTTP 层能如实回传 fail-closed。
  const policy = async ({ intent }) => (intent && intent.nonce === 2)
    ? { allowed: false, reason: 'disallowed nonce' } : { allowed: true, reason: 'ok' };
  const server = startRemoteSignerKeeper({
    port: '0',
    handle: async ({ request }) => handleCustodySignRequest({ request, secret: SECRET, ...deps({ checkPolicy: policy }) }),
  });
  const port = await start(server);
  listener = server;

  const okRes = await fetch(`http://127.0.0.1:${port}/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(okRequest()),
  });
  const okBody = await okRes.json();
  assert.equal(okRes.status, 200);
  assert.equal(okBody.ok, true);
  assert.equal(typeof okBody.signature, 'string');

  // 策略拒绝 → 200 + { ok:false }，无签名泄露。
  const deniedRes = await fetch(`http://127.0.0.1:${port}/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(okRequest({ intent: { nonce: 2 } })),
  });
  const deniedBody = await deniedRes.json();
  assert.equal(deniedRes.status, 200);
  assert.equal(deniedBody.ok, false);
  assert.equal(deniedBody.signature, undefined);

  // 严格白名单：GET / → 404，PUT /sign → 405。
  const getRes = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(getRes.status, 404);
  const putRes = await fetch(`http://127.0.0.1:${port}/sign`, { method: 'PUT' });
  assert.equal(putRes.status, 405);
});

// ─── 复核修复回归（R5/R6/R7） ────────────────────────────────────────────

test('RS Keeper 请求防伪（R5）：hmac 缺失 / intent 被 MITM 篡改 → REQUEST_HMAC_INVALID，不签名', async () => {
  // hmac 缺失。
  const noHmac = okRequest();
  delete noHmac.hmac;
  const res1 = await handleCustodySignRequest({ request: noHmac, secret: SECRET, ...deps() });
  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'REMOTE_SIGNER_REQUEST_HMAC_INVALID');
  assert.equal(res1.signature, undefined);

  // MITM 在传输中改收款人（hmac 未重算）→ Keeper 复验失配拒签。
  const tampered = okRequest();
  tampered.intent = { ...tampered.intent, recipient: '0xMITM-evil', amount: '1000000' };
  const res2 = await handleCustodySignRequest({ request: tampered, secret: SECRET, ...deps() });
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'REMOTE_SIGNER_REQUEST_HMAC_INVALID');
  assert.equal(res2.signature, undefined, 'tampered request must never be signed');

  // 对照：同请求重算 hmac 后（合法 Client 行为）→ 正常签名。
  const legit = okRequest();
  legit.intent = { ...legit.intent, recipient: '0xnew-recipient' };
  legit.hmac = computeRequestHmac(SECRET, legit);
  const res3 = await handleCustodySignRequest({ request: legit, secret: SECRET, ...deps() });
  assert.equal(res3.ok, true);
});

test('RS Keeper 请求防伪（R5）：错误 secret 计算的 hmac → 拒签', async () => {
  const forged = okRequest();
  forged.hmac = computeRequestHmac('wrong-secret', forged);
  const res = await handleCustodySignRequest({ request: forged, secret: SECRET, ...deps() });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'REMOTE_SIGNER_REQUEST_HMAC_INVALID');
});

test('RS Client（R5）：发出的请求自动携带请求侧 HMAC', async () => {
  let seen;
  const client = createRemoteSignerClient({
    secret: SECRET,
    transport: async (request) => {
      seen = request;
      const resp = { ok: true, signature: `0xsig:${request.nonce}`, digest: null, requestedAt: request.requestedAt, nonce: request.nonce };
      resp.hmac = computeKeeperHmac(SECRET, resp);
      return resp;
    },
  });
  await client.signIntent({ session: { agentId: 'a1' }, intent: { nonce: 7 }, nonce: 'n-7', custodyToken: 'tok-1' });
  assert.equal(typeof seen.hmac, 'string');
  // Keeper 复验同路径可行。
  assert.equal(verifyKeeperHmac(SECRET, {
    custodyToken: seen.custodyToken, agentId: seen.agentId, session: seen.session,
    intent: seen.intent, requestedAt: seen.requestedAt, nonce: seen.nonce,
  }, seen.hmac), true);
});

test('RS Keeper HTTP（R6）：超大请求体 → 413 拒收', async () => {
  const server = startRemoteSignerKeeper({
    port: '0',
    handle: async ({ request }) => handleCustodySignRequest({ request, secret: SECRET, ...deps() }),
  });
  const port = await start(server);
  listener = server;
  const res = await fetch(`http://127.0.0.1:${port}/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(300 * 1024), // > 256KB 上限
  });
  assert.equal(res.status, 413);
});

test('RS Keeper（R7）：端口占用 → 结构化日志 + 不崩进程（无 uncaughtException）', async () => {
  const a = startRemoteSignerKeeper({ port: '0', handle: async () => ({ ok: true }) });
  const port = await start(a);
  listener = a;
  // 同端口第二个 keeper → EADDRINUSE；模块 handler 只记日志 + close（不 throw）。
  const b = startRemoteSignerKeeper({ port: String(port), handle: async () => ({ ok: true }) });
  const errP = new Promise((resolve) => b.on('error', resolve));
  await errP; // 触发 EADDRINUSE 且进程存活至此 = 未崩（throw 会变 uncaughtException 测试失败）
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(b, 'process must survive port conflict without uncaught exception');
});
