/**
 * NexusGenesis - Custody Token
 *
 * 服务器代签凭据（JWT-lite, HMAC-SHA256 签名）
 *
 * 用例：
 *   - AGENT 注册成功后，服务器签发 custody_token 绑定 (agent_identity, address, publicKey)
 *   - AGENT 调用 /api/v1/wallet/sign 时，服务器用 token 确认身份后用托管私钥签名
 *   - 任务/投票/签 steward 等需要 PQC 签名的端点，可接受 custody_token 作为"准签名"通道
 *
 * 安全模型：
 *   - 私钥永远不出服务器（custody 不破）
 *   - token 必须由服务器签发，AGENT 不能伪造（HMAC 校验）
 *   - token 短期有效（默认 24h），过期需重新签发
 *   - token 携带公钥摘要，绑定到具体钱包
 *
 * 向后兼容：
 *   - 旧 x-admin-secret 仍可作为 devnet 兜底（adminAuth 模块）
 *   - 旧 PQC signature 路径仍可用（custody token 是新增通道）
 */

import crypto from 'crypto';

const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 小时
const TOKEN_SECRET_ENV = 'NG_CUSTODY_TOKEN_SECRET';
const FALLBACK_DEV_SECRET = 'devnet-custody-token-secret-do-not-use-in-prod';

function getSigningSecret() {
  const explicit = process.env[TOKEN_SECRET_ENV];
  if (explicit && explicit.length >= 32) return explicit;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[CustodyToken] ${TOKEN_SECRET_ENV} must be set (>= 32 chars) in production. ` +
      `Set it via env or PM2 config.`
    );
  }
  console.warn('[CustodyToken] Using dev fallback signing secret. Set NG_CUSTODY_TOKEN_SECRET before production.');
  return FALLBACK_DEV_SECRET;
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function publicKeyFingerprint(publicKeyHex) {
  // 用 SHA256 摘要公钥的前 16 字节（hex），用于 token 绑定校验
  return crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 32);
}

/**
 * 签发 custody token
 * @param {object} params
 * @param {string} params.agentId - Agent identity
 * @param {string} params.address - Wallet address
 * @param {string} params.publicKeyHex - Public key (hex)
 * @param {number} [params.ttlSeconds] - Token TTL (default 24h)
 * @returns {{ token: string, expiresAt: number }}
 */
function issueCustodyToken({ agentId, address, publicKeyHex, ttlSeconds }) {
  if (!agentId || !address || !publicKeyHex) {
    throw new Error('issueCustodyToken: agentId, address, publicKeyHex are required');
  }
  // Phase 2-D1 fix: distinguish "TTL not provided" (undefined) from "TTL=0".
  // The previous `ttlSeconds || DEFAULT` would treat 0 as falsy and fall back
  // to the 24h default — silently giving callers a 24h token when they asked
  // for "no expiry / already expired".
  const ttl = (typeof ttlSeconds === 'number') ? ttlSeconds : DEFAULT_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;

  const header = { alg: 'HS256', typ: 'CUSTODY' };
  const payload = {
    sub: agentId,
    addr: address,
    fp: publicKeyFingerprint(publicKeyHex),
    iat: now,
    exp
  };

  const headerB64 = base64url(header);
  const payloadB64 = base64url(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(signingInput)
    .digest();
  const sigB64 = base64url(signature);

  return {
    token: `${signingInput}.${sigB64}`,
    expiresAt: exp,
    issuedAt: now
  };
}

/**
 * 验证 custody token
 * @param {string} token
 * @param {object} [context] - 可选上下文（用于绑定校验）
 *   - agentId: 必须匹配 token.sub
 *   - address: 必须匹配 token.addr
 *   - publicKeyHex: 必须匹配 token.fp
 * @returns {{ valid: boolean, payload?: object, reason?: string }}
 */
function verifyCustodyToken(token, context = {}) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'token missing' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed token' };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // 重新计算 HMAC
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const providedSig = base64urlDecode(sigB64);
  if (expectedSig.length !== providedSig.length || !crypto.timingSafeEqual(expectedSig, providedSig)) {
    return { valid: false, reason: 'invalid signature' };
  }

  // 解析 payload
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed payload' };
  }

  // 过期检查
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) {
    return { valid: false, reason: 'token expired' };
  }

  // 上下文绑定校验
  if (context.agentId && payload.sub !== context.agentId) {
    return { valid: false, reason: 'agentId mismatch' };
  }
  if (context.address && payload.addr !== context.address) {
    return { valid: false, reason: 'address mismatch' };
  }
  if (context.publicKeyHex && payload.fp !== publicKeyFingerprint(context.publicKeyHex)) {
    return { valid: false, reason: 'publicKey fingerprint mismatch' };
  }

  return { valid: true, payload };
}

/**
 * 从请求中提取 custody token（支持 header / body 两种方式）
 * @param {object} req
 * @returns {string|null}
 */
function extractCustodyToken(req) {
  const headerToken = req.headers['x-custody-token'] || req.headers['x-custody'];
  if (headerToken) return headerToken;
  if (req.body?.custody_token) return req.body.custody_token;
  if (req.body?.custodyToken) return req.body.custodyToken;
  return null;
}

export {
  issueCustodyToken,
  verifyCustodyToken,
  extractCustodyToken,
  publicKeyFingerprint
};

export default {
  issueCustodyToken,
  verifyCustodyToken,
  extractCustodyToken,
  publicKeyFingerprint
};
