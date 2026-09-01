/**
 * remote-signer.js — 远程托管签名器 (Sprint 8: Key Custody 主线核心)
 *
 * 「云端 AGENT 私钥不暴露 + 人类安全把控」的架构基座：
 * 云端 AGENT **永不持有根私钥** —— 私钥物理上在**人类侧托管签名器(Keeper)**。
 * AGENT 只组装"签名请求"（canonical intent + 会话凭据）发给 Keeper；Keeper 逐笔
 * 核验后签名并回传。即使整个云实例整机沦陷（内存/磁盘/进程全被看光）也拿不到任何
 * 私钥。这是对既有"隔离签名子进程"（进程边界）的进一步升级：把边界推到**远程**，
 * 私钥不在签名发起主机的任何一层可读面。
 *
 * 信任模型：
 *   - PowerShell AGENT 只持有会话凭据（CustodyToken / sessions）与 Keeper 共享的
 *     HMAC secret（防伪密钥，经安全握手/KMS 派生，见 GAP-001）。不持根钥。
 *   - Keeper 持根/操作密钥（生产从 KMS 取，见 GAP-001；绝不落明文 env）。
 *   - 每笔签名 Keeper 都要**独立核验**（身份 + 防重放 + 策略；高危可选人工放行），
 *     fail-closed：任何一项不过 → 拒绝签名，绝不放行。
 *   - 协议双侧防伪：请求侧 HMAC（Client 计算，Keeper 复验 —— 防 MITM 篡改 intent）
 *     + 响应侧 HMAC（Keeper 计算，Client 复验 —— 防仿冒 Keeper）。
 *
 * 本模块核心逻辑全部为**纯函数 / 可注入**（transport / custody 校验 / 策略 / 签名
 * 全部注入），保证零隐式依赖、测试无外部网络/服务可全绿。HTTP loopback 封装提供
 * Keeper 的极简生产接线；Client 侧传输由调用方契入（地址在人类侧，非本进程地址）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { logStructured } from './observability.js';

// ── 响应防伪（HMAC）：让 Client 能校验响应来自约定 Keeper，防仿冒/篡改 ──────────

/** canonical 序列化用于 HMAC 的请求/响应体。 */
function hmacBody(obj) {
  return JSON.stringify(obj);
}

/** computeKeeperHmac(secret, body) —— 返回 hex HMAC-SHA256。 */
export function computeKeeperHmac(secret, body) {
  return createHmac('sha256', String(secret)).update(hmacBody(body)).digest('hex');
}

/**
 * 常量时间校验 Keeper HMAC（防时序侧信道）。
 * @returns {boolean}
 */
export function verifyKeeperHmac(secret, body, provided) {
  if (typeof provided !== 'string' || !secret) return false;
  const expected = computeKeeperHmac(secret, body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── 共享校验工具 ──────────────────────────────────────────────────────────

/**
 * 请求侧防伪体（R5）：请求六个核心字段按固定序提取。
 * 两侧（Client 计算 / Keeper 复算）都用本函数 → 序列化确定、不受顶层键序影响。
 */
function requestHmacBody(request) {
  return {
    custodyToken: request.custodyToken,
    agentId: request.agentId,
    session: request.session,
    intent: request.intent,
    requestedAt: request.requestedAt,
    nonce: request.nonce,
  };
}

/** 计算请求防伪 HMAC（Client 侧组装后随请求携带）。 */
export function computeRequestHmac(secret, request) {
  return computeKeeperHmac(secret, requestHmacBody(request));
}

function assertFields(request, fields, origin) {
  const missing = fields.filter((f) => request[f] === undefined || request[f] === null || request[f] === '');
  if (missing.length) {
    const err = new Error(`${origin}: missing required field(s): ${missing.join(', ')}`);
    err.code = 'REMOTE_SIGNER_MALFORMED_REQUEST';
    throw err;
  }
}

/**
 * 请求级 fail-closed 轮廓校验（不依赖任何服务，纯形状检查）。
 * 供 Client 发送前 / Keeper 接收后第一道闸复用。
 * @param {object} request { custodyToken, agentId, session, intent, requestedAt, nonce }
 * @throws REMOTE_SIGNER_MALFORMED_REQUEST
 */
export function validateCustodyRequestShape(request) {
  if (!request || typeof request !== 'object') {
    const err = new Error('remote-signer request must be an object');
    err.code = 'REMOTE_SIGNER_MALFORMED_REQUEST';
    throw err;
  }
  assertFields(request, ['custodyToken', 'agentId', 'session', 'intent', 'requestedAt', 'nonce'], 'remote-signer');
  if (!request.intent || typeof request.intent !== 'object') {
    const err = new Error('remote-signer: intent must be an object');
    err.code = 'REMOTE_SIGNER_MALFORMED_REQUEST';
    throw err;
  }
  // intent 必须带 nonce（链上防重放层面依赖；缺则不签）。
  if (request.intent.nonce === undefined || request.intent.nonce === null) {
    const err = new Error('remote-signer: intent.nonce is required (on-chain replay protection)');
    err.code = 'REMOTE_SIGNER_MALFORMED_REQUEST';
    throw err;
  }
  if (typeof request.requestedAt !== 'number' || request.requestedAt <= 0) {
    const err = new Error('remote-signer: requestedAt must be a positive epoch-ms number');
    err.code = 'REMOTE_SIGNER_MALFORMED_REQUEST';
    throw err;
  }
}

/**
 * 纯函数：Keeper 处理一笔签名请求的完整核验 + 签名 + 可靠性。不碰网络。
 *
 * 按序 fail-closed：
 *   1. 形状校验（validateCustodyRequestShape）
 *   2. 请求防伪（R5）：request.hmac = HMAC(六核心字段含 intent) —— MITM 无法篡改
 *      收款人/金额后送签；缺失/失配 → 拒（绝不签出"没请求过的东西"）
 *   3. custody 身份核验（注入 verifyCustodyToken：{ valid, agentId, session?, expiresAt? }）
 *   4. 防重放（注入 checkReplay(nonce) → { ok, reason? }；默认恒通过）
 *   5. 策略核验（注入 checkPolicy({ session, intent, custody }) → { allowed, reason }）
 *      —— 策略不过 → 拒签（含限额/白名单/仿真门等，接 policy-engine）
 *   6. 人类可否决（注入 requestApproval({ session, intent }) → { approved, reason? }）
 *      —— 高危操作签名**前**需人工放行；被拒 → 拒签；无钩子 → 视为按策略直接签
 *   7. 签名（注入 signIntent({ session, intent }) → { signature, digest? }）
 *   8. 用共享 secret 给响应附防伪 HMAC（含 signature）
 *
 * 返回 { ok: true, signature, digest?, requestedAt, nonce, hmac } | { ok: false, reason, code? }
 * —— 失败绝不返回部分签名。
 *
 * @param {object} opts
 * @param {object} opts.request
 * @param {function} opts.verifyCustodyToken async/cb → { valid, agentId?, session?, expiresAt? }
 * @param {function} [opts.checkReplay] async/cb → { ok, reason? }
 * @param {function} opts.checkPolicy async/cb → { allowed, reason }
 * @param {function} [opts.requestApproval] async/cb → { approved, reason? }
 * @param {function} opts.signIntent async/cb → { signature, digest? }
 * @param {string} opts.secret  Keeper↔Client 共享 HMAC secret
 */
export async function handleCustodySignRequest({
  request, verifyCustodyToken, checkReplay, checkPolicy, requestApproval, signIntent, secret,
}) {
  try {
    validateCustodyRequestShape(request);
  } catch (err) {
    return { ok: false, reason: err.message, code: err.code ?? 'REMOTE_SIGNER_MALFORMED_REQUEST' };
  }
  // 请求防伪（R5）：HMAC 覆盖六核心字段（含 intent）—— 传输层无完整性时，
  // MITM 无法篡改收款人/金额后送签（Keeper 不会签出"没请求过的东西"）。
  if (typeof request.hmac !== 'string' || !verifyKeeperHmac(secret, requestHmacBody(request), request.hmac)) {
    return { ok: false, reason: 'request HMAC missing or invalid (forged or tampered request)', code: 'REMOTE_SIGNER_REQUEST_HMAC_INVALID' };
  }
  // 身份（fail-closed：无法确证身份 → 拒签）。
  let custody;
  try {
    custody = (await verifyCustodyToken(request.custodyToken)) ?? null;
  } catch (err) {
    return { ok: false, reason: `custody verification failed: ${err.message}`, code: 'REMOTE_SIGNER_CUSTODY_FAIL' };
  }
  if (!custody || custody.valid !== true) {
    return { ok: false, reason: 'custody token rejected', code: 'REMOTE_SIGNER_CUSTODY_REJECTED' };
  }
  // 防重放。
  if (checkReplay) {
    const rep = await checkReplay(request.nonce);
    if (!rep || rep.ok !== true) {
      return { ok: false, reason: (rep && rep.reason) || `nonce ${request.nonce} rejected`, code: 'REMOTE_SIGNER_REPLAY_REJECTED' };
    }
  }
  // 策略（fail-closed：策略不通过 → 拒签）。
  if (checkPolicy) {
    const pol = await checkPolicy({ session: request.session, intent: request.intent, custody });
    if (!pol || pol.allowed !== true) {
      return { ok: false, reason: (pol && pol.reason) || 'policy denied', code: 'REMOTE_SIGNER_POLICY_DENIED' };
    }
  }
  // 人类可否决（高危放行闸）。
  if (requestApproval) {
    const ap = await requestApproval({ session: request.session, intent: request.intent, custody, nonce: request.nonce });
    if (!ap || ap.approved !== true) {
      return { ok: false, reason: (ap && ap.reason) || 'human not approved', code: 'REMOTE_SIGNER_HUMAN_DENIED' };
    }
  }
  // 签名。
  let signed;
  try {
    signed = (await signIntent({ session: request.session, intent: request.intent, custody })) ?? null;
  } catch (err) {
    return { ok: false, reason: `signing failed: ${err.message}`, code: 'REMOTE_SIGNER_SIGN_FAIL' };
  }
  if (!signed || typeof signed.signature !== 'string' || !signed.signature) {
    return { ok: false, reason: 'signer returned no signature', code: 'REMOTE_SIGNER_SIGN_FAIL' };
  }
  const response = {
    ok: true,
    signature: signed.signature,
    digest: signed.digest ?? null,
    requestedAt: request.requestedAt,
    nonce: request.nonce,
  };
  response.hmac = computeKeeperHmac(secret, response);
  logStructured('remote_signer_signed', { agent: custody.agentId ?? request.agentId, nonce: request.nonce });
  return response;
}

/**
 * 纯函数：Client 校验 Keeper 的签名响应。
 * HMAC 失配 / 非 ok / nonce 不符 → 拒收（fail-closed，防仿冒/篡改/回放替换）。
 * @returns {{ valid: boolean, signature?: string, digest?: string|null, reason?: string }}
 */
export function verifyCustodySignResponse({ response, secret, expectedNonce }) {
  if (!response || response.ok !== true || typeof response.signature !== 'string' || !response.signature) {
    return { valid: false, reason: 'keeper returned no valid signature' };
  }
  const resp = { ok: true, signature: response.signature, digest: response.digest ?? null, requestedAt: response.requestedAt, nonce: response.nonce };
  if (!verifyKeeperHmac(secret, resp, response.hmac)) {
    return { valid: false, reason: 'keeper response HMAC invalid (forged or tampered)' };
  }
  if (expectedNonce !== undefined && response.nonce !== expectedNonce) {
    return { valid: false, reason: 'keeper response nonce mismatch (replay substitution)' };
  }
  return { valid: true, signature: response.signature, digest: response.digest ?? null };
}

/**
 * Client（云端 AGENT 侧）：不持根私钥，向 Keeper 请求签名。
 *
 * @param {object} opts
 * @param {function} opts.transport async (request) => response —— 发送到人类侧
 *   Keeper（HTTP/桩注入；网络地址在人类侧，非本进程）。
 * @param {string} opts.secret   与 Keeper 共享的 HMAC secret（secure channel/KMS 派生）。
 * @param {function} [opts.issueCustodyToken] async () => custodyToken —— 会话凭据源。
 * @param {number} [opts.signTimeoutMs] 默认 15000 —— 超时拒收。
 * @returns {object} createRemoteSignerClient().signIntent({ session, intent, requestedAt, nonce, custodyToken })
 *   → { digest, signature }（可直接喂 smart_account_execute）
 */
export function createRemoteSignerClient({ transport, secret, issueCustodyToken, signTimeoutMs = 15000 }) {
  if (typeof transport !== 'function') throw new Error('createRemoteSignerClient requires a transport function');
  if (!secret) throw new Error('createRemoteSignerClient requires a shared HMAC secret');

  async function signIntent({ session, intent, requestedAt, nonce, custodyToken } = {}) {
    const token = custodyToken ?? (issueCustodyToken ? await issueCustodyToken() : null);
    const nonceId = nonce ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const request = {
      custodyToken: token,
      agentId: session && session.agentId,
      session: session ?? null,
      intent,
      requestedAt: requestedAt ?? Date.now(),
      nonce: nonceId,
    };
    // Client 侧也先拦形状错误（快速失败，避免把坏请求网络往返）。
    validateCustodyRequestShape(request);
    // 请求防伪（R5）：与 Keeper 共享 secret，对请求核心字段（含 intent）计算 HMAC。
    request.hmac = computeRequestHmac(secret, request);

    let response;
    try {
      response = await withTimeout(transport(request), signTimeoutMs);
    } catch (err) {
      const e = new Error(`remote signer transport failed: ${err.message}`);
      e.code = 'REMOTE_SIGNER_TRANSPORT_FAIL';
      throw e;
    }
    const check = verifyCustodySignResponse({ response, secret, expectedNonce: nonceId });
    if (!check.valid) {
      const e = new Error(check.reason);
      e.code = 'REMOTE_SIGNER_RESPONSE_INVALID';
      throw e;
    }
    return { digest: check.digest, signature: check.signature };
  }

  return { signIntent };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`signature timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Keeper（人类侧）极简 loopback HTTP 接线（REMOTE_SIGNER_KEEPER_PORT gate，默认关）。
 *
 * 语义：
 *   - 未设 port → 返回 null（零基线影响）。非法 port → 抛错（操作员错误要响亮）。
 *   - POST /sign：body = { custodyToken, agentId, session, intent, requestedAt, nonce,
 *     hmac }，转交给 handleCustodySignRequest（所有核验/签名/防伪都在那，含请求 HMAC）。
 *   - 仅监听 127.0.0.1 + 仅允许 POST /sign（严格白名单），其余 404/405（收缩攻击面）。
 *   - 请求体上限 256KB（R6），超限 413 拒收。
 *   - 端口占用/监听失败 → 结构化日志 remote_signer_keeper_error + 关闭（R7：不
 *     uncaughtException、不崩宿主进程；签名缺席由 client TRANSPORT_FAIL 与告警暴露）。
 *   - 失败响应一律 200 + { ok:false }（与纯函数一致），HTTP 层不做语义判断——
 *     拒绝原因是否暴露给远端由调用方决定。
 *
 * @param {object} opts
 * @param {string|number} [opts.port]   默认 process.env.REMOTE_SIGNER_KEEPER_PORT
 * @param {string} [opts.bind]          绑定地址，默认 127.0.0.1（跨主机部署需显式
 *                                      指定并前置 TLS/隧道；协议 HMAC 防篡改但不加密）
 * @param {function} [opts.handle]      默认走 handleCustodySignRequest；可注入（测试）
 * @returns {import('node:http').Server|null}
 */
export function startRemoteSignerKeeper({ port, bind, handle } = {}) {
  const raw = (port ?? process.env.REMOTE_SIGNER_KEEPER_PORT ?? '').trim();
  if (!raw) return null; // gate 关
  const p = Number(raw);
  if (!Number.isFinite(p) || p < 0) {
    const err = new Error('REMOTE_SIGNER_KEEPER_PORT must be a non-negative integer (0 = ephemeral)');
    err.code = 'REMOTE_SIGNER_PORT_INVALID';
    throw err;
  }
  const processFn = handle ?? (async ({ request, ctx }) => handleCustodySignRequest({ ...ctx, request }));
  const server = http.createServer((req, res) => {
    const respond = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const url = (req.url || '/').split('?')[0];
    const isSign = url === '/sign';
    // 严格白名单：未知路径一律 404；已知端点(仅 /sign)错误方法 → 405。收缩攻击面。
    if (!isSign) {
      respond(404, { ok: false, reason: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      respond(405, { ok: false, reason: 'method not allowed' });
      return;
    }
    let rawBody = '';
    let responded = false;
    const MAX_SIGN_BODY_BYTES = 262144; // 256KB（R6）：签名请求形状小，超限视为滥用。
    req.on('data', (chunk) => {
      if (responded) return;
      rawBody += chunk;
      if (Buffer.byteLength(rawBody) > MAX_SIGN_BODY_BYTES) {
        responded = true;
        respond(413, { ok: false, reason: 'request body too large' });
      }
    });
    req.on('end', () => {
      if (responded) return;
      let request;
      try {
        request = JSON.parse(rawBody || '{}');
      } catch {
        respond(400, { ok: false, reason: 'request body must be JSON' });
        return;
      }
      // ctx：HTTP 层不注入任何业务依赖 —— 由 startRemoteSignerKeeper 的调用方
      // （server.js）通过 handle 闭包显式带入，否则 keeper 拒绝处理。
      processFn({ request, ctx:{} }).then(
        (result) => respond(200, result),
        (err) => {
          logStructured('remote_signer_keeper_error', { error: String(err?.message || err) });
          respond(500, { ok: false, reason: 'keeper internal error', code: err?.code || 'REMOTE_SIGNER_KEEPER_ERROR' });
        },
      );
    });
  });
  server.on('error', (err) => {
    // 复核修复 R7：事件处理器内 throw → uncaughtException，去向取决于全局 handler
    // （不可靠），且崩掉整个宿主进程是错误爆炸半径。改为结构化记录 + 关闭：
    // 签名缺席由 client 侧 REMOTE_SIGNER_TRANSPORT_FAIL 与本日志（可接告警）共同
    // 暴露 —— fail-safe 可见，不静默降级为"无保护签名"。
    logStructured('remote_signer_keeper_error', { error: `listen failed on ${p}: ${err?.message ?? err}`, code: err?.code ?? 'E_LISTEN' });
    server.close();
  });
  server.listen(p, bind || '127.0.0.1');
  return server;
}