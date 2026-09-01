/**
 * remote-signer-keeper.js — 远程托管签名器的**真实依赖组装**（Sprint 8 Key Custody）
 *
 * remote-signer.js 提供协议与纯逻辑（全部注入式）；本文件把注入点接到**真实实现**，
 * 让 Keeper 成为可运行的生产服务：
 *
 *   verifyCustodyToken → L1 custody token（src/http/custodyToken.js 同构 HMAC 格式，
 *                        共享 NG_CUSTODY_TOKEN_SECRET；跨进程验真，无 dev fallback）
 *   checkPolicy        → 权威 session 比对 + 过期 + 白名单 + maxPerTx/maxDaily
 *                        （每日累计为 Keeper 内存台账；'0' = 不设限，与 agent-keys
 *                        checkSessionAccess 语义一致）
 *   checkReplay        → 内存 nonce 去重（TTL 窗口）
 *   requestApproval    → REMOTE_SIGNER_APPROVAL_MODE：auto（默认，启动 WARN）| deny
 *   signIntent         → chain-eth signSmartAccountIntent（真签名，私钥来自 keyring）
 *
 * 关键安全设计：
 *   - **权威 session 比对**：keyring 里 Keeper 签发 session 时登记的权威副本与请求
 *     session 逐字段比对（键序无关）——AGENT 无法自造"更宽限额"的 session 送签
 *     （session 本身不经传输层完整性保护，比对是必需防线）。
 *   - keyring 文件 { agentId: { privateKeyHex, session } }，加载 fail-closed；
 *     私钥只在 Keeper 内存，绝不回传。
 *   - 签名用 chain-eth 真实路径（canonical digest + secp256k1 low-S，65 字节），
 *     产物直接可喂 executeFromAgent。
 *
 * 部署边界（诚实记录）：
 *   - Keeper **必须**跑在人类侧主机。绝不 import 进云端 server.js——否则"私钥不在
 *     云端"的核心承诺即被打破。入口：`node src/keeper-main.js`。
 *   - 默认仅 loopback；跨主机经 REMOTE_SIGNER_KEEPER_BIND 显式指定绑定地址，且
 *     生产必须前置 TLS/隧道（协议层 HMAC 已防篡改/防伪，但不加密）。
 */

import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logStructured } from './observability.js';
import { handleCustodySignRequest, startRemoteSignerKeeper } from './remote-signer.js';

// ── L1 custody token 验证（与 src/http/custodyToken.js 同构） ────────────────

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * L1 custody token 验证器工厂。secret 必须显式提供（≥32 字符）——Keeper 无
 * dev fallback（fail-closed：没有真 secret 就不该跑 Keeper）。
 * 返回 handleCustodySignRequest 兼容的 verifyCustodyToken。
 */
export function createL1CustodyVerifier({ secret }) {
  if (typeof secret !== 'string' || secret.length < 32) {
    const err = new Error('keeper custody verifier requires NG_CUSTODY_TOKEN_SECRET (>= 32 chars)');
    err.code = 'REMOTE_SIGNER_CUSTODY_SECRET_INVALID';
    throw err;
  }
  return function verifyL1CustodyToken(token) {
    if (!token || typeof token !== 'string') return { valid: false, reason: 'token missing' };
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'malformed token' };
    const [headerB64, payloadB64, sigB64] = parts;
    const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
    const provided = b64urlDecode(sigB64);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return { valid: false, reason: 'invalid signature' };
    }
    let payload;
    try {
      payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    } catch {
      return { valid: false, reason: 'malformed payload' };
    }
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) {
      return { valid: false, reason: 'token expired' };
    }
    // handleCustodySignRequest 契约：{ valid, agentId?, ... }；L1 token 的 sub 即 agentId。
    return { valid: true, agentId: payload.sub, address: payload.addr, expiresAt: payload.exp };
  };
}

// ── keyring：agentId → { privateKeyHex, session }（Keeper 权威密钥+会话台账） ──

/** 稳定 JSON（键排序递归）——session 比对不受键序影响。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * 加载 keyring 文件（fail-closed）：JSON { agentId: { privateKeyHex, session } }。
 * 校验：私钥 32 字节 hex；session.agentId 必须等于其键名（防错位）。
 */
export function loadSessionKeyring(file) {
  if (!file || typeof file !== 'string') {
    throw new Error('keyring file path required');
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const e = new Error(`keyring file unreadable/corrupted (fail-closed) [REMOTE_SIGNER_KEYRING_INVALID]: ${file}: ${err.message}`);
    e.code = 'REMOTE_SIGNER_KEYRING_INVALID';
    throw e;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const e = new Error(`keyring file must be a JSON object [REMOTE_SIGNER_KEYRING_INVALID]: ${file}`);
    e.code = 'REMOTE_SIGNER_KEYRING_INVALID';
    throw e;
  }
  const map = new Map();
  for (const [agentId, entry] of Object.entries(raw)) {
    const pk = entry && typeof entry.privateKeyHex === 'string' ? entry.privateKeyHex.replace(/^0x/i, '') : null;
    if (!pk || !/^[0-9a-fA-F]{64}$/.test(pk) || !entry.session || typeof entry.session !== 'object') {
      const e = new Error(`keyring entry invalid for agent "${agentId}" (need 32-byte hex privateKeyHex + session object) [REMOTE_SIGNER_KEYRING_INVALID]`);
      e.code = 'REMOTE_SIGNER_KEYRING_INVALID';
      throw e;
    }
    if (entry.session.agentId !== agentId) {
      const e = new Error(`keyring session agentId mismatch for "${agentId}" (session.agentId=${entry.session.agentId}) [REMOTE_SIGNER_KEYRING_INVALID]`);
      e.code = 'REMOTE_SIGNER_KEYRING_INVALID';
      throw e;
    }
    map.set(agentId, { privateKeyHex: '0x' + pk.toLowerCase(), session: entry.session });
  }
  if (map.size === 0) {
    const e = new Error('keyring file has no entries (fail-closed) [REMOTE_SIGNER_KEYRING_INVALID]');
    e.code = 'REMOTE_SIGNER_KEYRING_INVALID';
    throw e;
  }
  return map;
}

// ── 策略：权威 session 比对 + 过期 + 白名单 + 限额（每日累计内存台账） ────────

/**
 * Keeper 策略检查器。语义与 agent-keys checkSessionAccess 对齐：
 *   - 白名单仅在非空时强制（[] = 不限制）
 *   - maxPerTx/maxDaily '0' = 不设限；超限 → 拒
 *   - amount 缺失（非资产 intent）→ 跳过限额（同基线）
 * 额外（Keeper 特有）：
 *   - custody.agentId 必须等于权威条目
 *   - 请求 session 必须与权威 session 稳定序列化后逐字段相等（防自造宽 session）
 *   - 通过后按 amount 记入每日台账（保守方向：预授权即计费，签名未用不退额度）
 */
export function createSessionPolicyChecker({ keyring, dailyLedger = new Map() } = {}) {
  if (!(keyring instanceof Map) || keyring.size === 0) {
    const err = new Error('session policy checker requires a loaded keyring');
    err.code = 'REMOTE_SIGNER_KEYRING_INVALID';
    throw err;
  }
  const dateKey = () => new Date().toISOString().slice(0, 10);

  return async function checkPolicy({ session, intent, custody }) {
    const agentId = custody && custody.agentId;
    const entry = agentId ? keyring.get(agentId) : null;
    if (!entry) {
      return { allowed: false, reason: `no keyring entry for agent ${agentId ?? '(unknown)'}` };
    }
    // 权威 session 比对：请求 session 与 Keeper 签发时登记的权威副本必须一致。
    if (!session || stableStringify(session) !== stableStringify(entry.session)) {
      return { allowed: false, reason: 'request session does not match keeper-issued session (forged or stale)' };
    }
    // 过期。
    if (session.expiresAt && Date.now() > Number(session.expiresAt)) {
      return { allowed: false, reason: 'session key expired' };
    }
    // 白名单（非空才强制，同 checkSessionAccess）。
    const contract = intent && intent.contract;
    if (contract && Array.isArray(session.allowedContracts) && session.allowedContracts.length > 0) {
      if (!session.allowedContracts.some((c) => String(c).toLowerCase() === String(contract).toLowerCase())) {
        return { allowed: false, reason: `contract ${contract} not in session whitelist` };
      }
    }
    const method = intent && intent.method;
    if (method && Array.isArray(session.allowedMethods) && session.allowedMethods.length > 0) {
      if (!session.allowedMethods.some((m) => String(m).toLowerCase() === String(method).toLowerCase())) {
        return { allowed: false, reason: `method ${method} not in session whitelist` };
      }
    }
    const chain = intent && intent.chain;
    if (chain && Array.isArray(session.allowedChains) && session.allowedChains.length > 0) {
      if (!session.allowedChains.some((c) => String(c).toLowerCase() === String(chain).toLowerCase())) {
        return { allowed: false, reason: `chain ${chain} not in session whitelist` };
      }
    }
    // 限额（amount 缺失 → 跳过，同基线）。
    if (intent && intent.amount !== undefined && intent.amount !== null) {
      const amountRaw = typeof intent.amount === 'string' ? intent.amount.trim() : intent.amount;
      if (amountRaw === '') return { allowed: false, reason: 'invalid amount: empty string' };
      let amount;
      try {
        amount = BigInt(amountRaw);
      } catch {
        return { allowed: false, reason: 'invalid amount: not an integer' };
      }
      if (amount < 0n) return { allowed: false, reason: 'amount must not be negative' };

      const maxPerTx = BigInt(session.maxPerTx || '0');
      if (maxPerTx > 0n && amount > maxPerTx) {
        return { allowed: false, reason: `exceeds maxPerTx ${session.maxPerTx}` };
      }
      if (session.maxDaily) {
        const maxDaily = BigInt(session.maxDaily || '0');
        if (maxDaily > 0n) {
          const today = dateKey();
          let rec = dailyLedger.get(agentId);
          if (!rec || rec.date !== today) {
            rec = { date: today, total: 0n };
            dailyLedger.set(agentId, rec);
          }
          if (rec.total + amount > maxDaily) {
            return { allowed: false, reason: `exceeds daily limit ${session.maxDaily}` };
          }
          // 保守计费：预授权即计入（签名未用不退）。重启清零是已知 MVP 边界
          // （链上合约自身仍逐笔强制 per-tx 上限；daily 上链为后续项）。
          rec.total += amount;
        }
      }
    }
    return { allowed: true };
  };
}

// ── 防重放（内存 nonce 去重，TTL 窗口） ─────────────────────────────────────

export function createReplayChecker({ ttlMs = 10 * 60 * 1000 } = {}) {
  const seen = new Map(); // nonce → expiresAt
  return async function checkReplay(nonce) {
    const now = Date.now();
    for (const [n, exp] of seen) {
      if (exp <= now) seen.delete(n);
    }
    const key = String(nonce);
    if (seen.has(key)) {
      return { ok: false, reason: `nonce ${key} already used (replay rejected)` };
    }
    seen.set(key, now + ttlMs);
    return { ok: true };
  };
}

// ── 真实签名（chain-eth signSmartAccountIntent；私钥只在 Keeper 内存） ───────

export function createKeyringSigner({ keyring }) {
  if (!(keyring instanceof Map) || keyring.size === 0) {
    const err = new Error('keyring signer requires a loaded keyring');
    err.code = 'REMOTE_SIGNER_KEYRING_INVALID';
    throw err;
  }
  return async function signIntent({ intent, custody }) {
    const entry = custody && custody.agentId ? keyring.get(custody.agentId) : null;
    if (!entry) {
      throw new Error(`no keyring entry for agent ${custody && custody.agentId}`);
    }
    // 真实签名路径：canonical digest + secp256k1 low-S（与链上 SmartAccount._recover 对应）。
    const { signSmartAccountIntent } = await import('nexusgenesis-chain-eth');
    const signed = signSmartAccountIntent({
      session: entry.session,
      intent,
      privateKeyHex: entry.privateKeyHex,
    });
    return { signature: signed.signature, digest: signed.digest };
  };
}

// ── 组装：真实依赖 → handleCustodySignRequest 兼容 handle ────────────────────

/**
 * 构建真实 Keeper handle（供 startRemoteSignerKeeper / 测试直驱）。
 * @param {object} opts
 * @param {Map} opts.keyring            loadSessionKeyring 产物
 * @param {string} opts.custodySecret   NG_CUSTODY_TOKEN_SECRET（≥32 字符）
 * @param {string} opts.sharedSecret    Keeper↔Client HMAC secret
 * @param {string} [opts.approvalMode]  'auto'（默认，人工放行钩子自动放行）| 'deny'
 * @param {number} [opts.replayTtlMs]
 */
export function buildKeeperHandle({ keyring, custodySecret, sharedSecret, approvalMode = 'auto', replayTtlMs } = {}) {
  if (!sharedSecret || typeof sharedSecret !== 'string') {
    const err = new Error('keeper requires a shared HMAC secret (REMOTE_SIGNER_SHARED_SECRET)');
    err.code = 'REMOTE_SIGNER_SHARED_SECRET_INVALID';
    throw err;
  }
  const mode = approvalMode === 'deny' ? 'deny' : 'auto';
  if (mode === 'auto') {
    logStructured('remote_signer_approval_auto', {
      warning: 'requestApproval is auto-approve (dev default). Set REMOTE_SIGNER_APPROVAL_MODE=deny and wire a human approval hook for production.',
    });
  }
  const deps = {
    request: null, // 由 handle 闭包注入
    verifyCustodyToken: createL1CustodyVerifier({ secret: custodySecret }),
    checkReplay: createReplayChecker({ ttlMs: replayTtlMs }),
    checkPolicy: createSessionPolicyChecker({ keyring }),
    requestApproval: mode === 'deny'
      ? async () => ({ approved: false, reason: 'approval mode is deny (human approval hook not wired)' })
      : async ({ intent, nonce }) => ({ approved: true, reason: 'auto (dev default)' , intent, nonce }),
    signIntent: createKeyringSigner({ keyring }),
    secret: sharedSecret,
  };
  return async function handle({ request }) {
    return handleCustodySignRequest({ ...deps, request });
  };
}

// ── env gate 启动（Keeper 进程入口；默认关、fail-closed） ────────────────────

/**
 * 从环境变量启动真实 Keeper。**仅应在人类侧主机调用**（绝不进云端 server 进程）。
 *
 * 必需 env（缺任一 → 抛错 fail-closed）：
 *   REMOTE_SIGNER_KEEPER_PORT     监听端口（本 gate 的总开关；未设 → 返回 null）
 *   NG_CUSTODY_TOKEN_SECRET       L1 custody token 验签密钥（≥32 字符）
 *   REMOTE_SIGNER_SHARED_SECRET   Keeper↔Client HMAC secret
 *   REMOTE_SIGNER_KEYRING_FILE    keyring JSON 路径
 * 可选 env：
 *   REMOTE_SIGNER_APPROVAL_MODE   auto（默认）| deny
 *   REMOTE_SIGNER_REPLAY_TTL_MS   nonce 去重窗口（默认 600000）
 *   REMOTE_SIGNER_KEEPER_BIND     绑定地址（默认 127.0.0.1；跨主机需显式 + TLS 前置）
 *
 * @returns {import('node:http').Server|null} null = gate 关（零基线影响）
 */
export function startRealKeeperFromEnv(env = process.env) {
  const rawPort = String(env.REMOTE_SIGNER_KEEPER_PORT ?? '').trim();
  if (!rawPort) return null; // gate 关

  const custodySecret = env.NG_CUSTODY_TOKEN_SECRET;
  const sharedSecret = env.REMOTE_SIGNER_SHARED_SECRET;
  const keyringFile = env.REMOTE_SIGNER_KEYRING_FILE;
  for (const [name, v] of [
    ['NG_CUSTODY_TOKEN_SECRET', custodySecret],
    ['REMOTE_SIGNER_SHARED_SECRET', sharedSecret],
    ['REMOTE_SIGNER_KEYRING_FILE', keyringFile],
  ]) {
    if (!v) {
      const err = new Error(`real keeper requires ${name} (fail-closed; no dev fallback)`);
      err.code = 'REMOTE_SIGNER_NOT_CONFIGURED';
      throw err;
    }
  }

  const keyring = loadSessionKeyring(keyringFile);
  const handle = buildKeeperHandle({
    keyring,
    custodySecret,
    sharedSecret,
    approvalMode: env.REMOTE_SIGNER_APPROVAL_MODE,
    replayTtlMs: env.REMOTE_SIGNER_REPLAY_TTL_MS ? Number(env.REMOTE_SIGNER_REPLAY_TTL_MS) : undefined,
  });
  const bind = env.REMOTE_SIGNER_KEEPER_BIND || '127.0.0.1';
  logStructured('remote_signer_keeper_starting', { agents: keyring.size, bind });
  return startRemoteSignerKeeper({ port: rawPort, bind, handle });
}
