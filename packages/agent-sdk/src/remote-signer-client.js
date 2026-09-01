/**
 * remote-signer-client.js — 云端 AGENT 侧的 Keeper 签名客户端（Key Custody 主线）
 *
 * 云端 AGENT **不持根私钥**：把 chain-eth `signSmartAccountIntent({ session, intent,
 * privateKeyHex })` 的私钥参数换成"向人类侧 Keeper 发签名请求"。本模块与
 * mcp-server/src/remote-signer.js 的 Keeper 说同一套 wire 协议：
 *
 *   请求  POST /sign  { custodyToken, agentId, session, intent, requestedAt, nonce, hmac }
 *         hmac = HMAC-SHA256(secret, JSON.stringify({ 六核心字段固定序 }))
 *   响应  { ok:true, signature, digest, requestedAt, nonce, hmac }
 *         hmac = HMAC-SHA256(secret, JSON.stringify({ ok,signature,digest,requestedAt,nonce }))
 *
 * 协议一致性防漂移：mcp-server/test/remote-signer-keeper.test.js 中有跨包互操作
 * 用例——agent-sdk 的 createKeeperSigner 对上 mcp-server 的 handleCustodySignRequest
 * 全链路签名/验签成功。任何一侧改协议导致字节不兼容，该测试即红。
 *
 * 信任模型：AGENT 持有 custodyToken（身份）+ sharedSecret（防伪，KMS/安全通道
 * 派生，见 GAP-001）+ session（公开部分）。**私钥不在本进程任何一层可读面。**
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function hmacHex(secret, body) {
  return createHmac('sha256', String(secret)).update(JSON.stringify(body)).digest('hex');
}

function hmacValid(secret, body, provided) {
  if (typeof provided !== 'string' || !secret) return false;
  const a = Buffer.from(hmacHex(secret, body), 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 与 mcp-server requestHmacBody 完全一致的固定序六字段。 */
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

/** 与 mcp-server verifyCustodySignResponse 一致的响应重建体。 */
function responseHmacBody(response) {
  return {
    ok: true,
    signature: response.signature,
    digest: response.digest ?? null,
    requestedAt: response.requestedAt,
    nonce: response.nonce,
  };
}

function validateShape(request) {
  const required = ['custodyToken', 'session', 'intent', 'requestedAt', 'nonce'];
  const missing = required.filter((f) => request[f] === undefined || request[f] === null || request[f] === '');
  if (missing.length) {
    const err = new Error(`keeper sign request missing field(s): ${missing.join(', ')}`);
    err.code = 'KEEPER_MALFORMED_REQUEST';
    throw err;
  }
  if (!request.intent || typeof request.intent !== 'object') {
    const err = new Error('keeper sign request: intent must be an object');
    err.code = 'KEEPER_MALFORMED_REQUEST';
    throw err;
  }
  if (request.intent.nonce === undefined || request.intent.nonce === null) {
    const err = new Error('keeper sign request: intent.nonce is required (on-chain replay protection)');
    err.code = 'KEEPER_MALFORMED_REQUEST';
    throw err;
  }
  if (typeof request.requestedAt !== 'number' || request.requestedAt <= 0) {
    const err = new Error('keeper sign request: requestedAt must be a positive epoch-ms number');
    err.code = 'KEEPER_MALFORMED_REQUEST';
    throw err;
  }
}

/** 默认 HTTP(S) transport（node:http / node:https，零第三方依赖）。 */
function createHttpTransport(url, timeoutMs) {
  const base = new URL(url);
  const mod = base.protocol === 'https:' ? 'node:https' : 'node:http';
  return function transport(request) {
    return import(mod).then((m) => new Promise((resolve, reject) => {
      const body = JSON.stringify(request);
      const req = m.request({
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: '/sign',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch (err) {
            reject(new Error(`keeper response not JSON: ${err.message}`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`keeper request timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end(body);
    }));
  };
}

/**
 * 创建 Keeper 签名客户端。产物与 chain-eth signSmartAccountIntent 同调用形状
 * （去掉 privateKeyHex），云端 AGENT 的执行代码只需替换签名来源。
 *
 * @param {object} opts
 * @param {function} [opts.transport]  async (request) => response（注入；测试/自定义通道）
 * @param {string} [opts.url]          Keeper 地址（未注入 transport 时按此建 HTTP transport）
 * @param {string} opts.secret         Keeper↔Client 共享 HMAC secret
 * @param {string|function} [opts.custodyToken] 固定 token 或 async () => token（自动刷新）
 * @param {number} [opts.signTimeoutMs] 默认 15000
 * @returns {{ signSmartAccountIntent: ({ session, intent }) => Promise<{ digest, signature }> }}
 */
export function createKeeperSigner({ transport, url, secret, custodyToken, issueCustodyToken, signTimeoutMs = 15000 } = {}) {
  if (!secret) throw new Error('createKeeperSigner requires a shared HMAC secret');
  let tx = transport;
  if (!tx) {
    if (!url) throw new Error('createKeeperSigner requires transport or url');
    tx = createHttpTransport(url, signTimeoutMs);
  }
  const tokenFn = typeof custodyToken === 'function' ? custodyToken
    : custodyToken ? async () => custodyToken
    : issueCustodyToken ?? null;

  async function signSmartAccountIntent({ session, intent } = {}) {
    const token = tokenFn ? await tokenFn() : null;
    const nonceId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const request = {
      custodyToken: token,
      agentId: session && session.agentId,
      session: session ?? null,
      intent,
      requestedAt: Date.now(),
      nonce: nonceId,
    };
    validateShape(request);
    // 请求侧防伪：MITM 无法篡改收款人/金额后送签。
    request.hmac = hmacHex(secret, requestHmacBody(request));

    let response;
    try {
      response = await tx(request);
    } catch (err) {
      const e = new Error(`keeper transport failed: ${err.message} [KEEPER_TRANSPORT_FAIL]`);
      e.code = 'KEEPER_TRANSPORT_FAIL';
      throw e;
    }
    if (!response || response.ok !== true || typeof response.signature !== 'string' || !response.signature) {
      const e = new Error(`[${(response && response.code) || 'KEEPER_SIGN_DENIED'}] ${(response && response.reason) || 'keeper returned no valid signature'}`);
      e.code = (response && response.code) || 'KEEPER_SIGN_DENIED';
      throw e;
    }
    if (!hmacValid(secret, responseHmacBody(response), response.hmac)) {
      const e = new Error('keeper response HMAC invalid (forged or tampered) [KEEPER_RESPONSE_INVALID]');
      e.code = 'KEEPER_RESPONSE_INVALID';
      throw e;
    }
    if (response.nonce !== nonceId) {
      const e = new Error('keeper response nonce mismatch (replay substitution) [KEEPER_RESPONSE_INVALID]');
      e.code = 'KEEPER_RESPONSE_INVALID';
      throw e;
    }
    return { digest: response.digest ?? null, signature: response.signature };
  }

  return { signSmartAccountIntent };
}

/**
 * env gate 工厂：`REMOTE_SIGNER_URL` 设置 → 返回 Keeper signer；未设 → null
 * （调用方回退本地私钥签名，零基线影响）。
 *
 * fail-closed：
 *   - URL 设置但 `REMOTE_SIGNER_SHARED_SECRET` 缺失 → 抛 KEEPER_NOT_CONFIGURED
 *     （绝不静默回退本地私钥路径——云端 AGENT 一旦被指示走远程签名，就不该再摸私钥）。
 *
 * env 变量：
 *   REMOTE_SIGNER_URL            Keeper 地址（总开关）
 *   REMOTE_SIGNER_SHARED_SECRET  Keeper↔Client 共享 HMAC secret
 *   REMOTE_SIGNER_CUSTODY_TOKEN  L1 custody token（可选；也可由调用方注入 tokenFn）
 *   REMOTE_SIGNER_TIMEOUT_MS     签名请求超时（默认 15000）
 *
 * @returns {{ signSmartAccountIntent: Function } | null}
 */
export function createKeeperSignerFromEnv(env = process.env) {
  const url = String(env.REMOTE_SIGNER_URL ?? '').trim();
  if (!url) return null;
  const secret = env.REMOTE_SIGNER_SHARED_SECRET;
  if (!secret) {
    const err = new Error('REMOTE_SIGNER_URL is set but REMOTE_SIGNER_SHARED_SECRET is missing (fail-closed) [KEEPER_NOT_CONFIGURED]');
    err.code = 'KEEPER_NOT_CONFIGURED';
    throw err;
  }
  return createKeeperSigner({
    url,
    secret,
    custodyToken: env.REMOTE_SIGNER_CUSTODY_TOKEN || undefined,
    signTimeoutMs: env.REMOTE_SIGNER_TIMEOUT_MS ? Number(env.REMOTE_SIGNER_TIMEOUT_MS) : undefined,
  });
}
