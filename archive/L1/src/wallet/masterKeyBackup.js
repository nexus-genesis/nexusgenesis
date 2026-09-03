/**
 * NexusGenesis - Wallet Master Key Backup
 *
 * Phase 2-A3: 主密钥加密离线备份
 *
 * 设计目标：
 *   - 用户口令 → 派生 KEK (Key-Encryption Key) → AES-256-GCM 加密 32 字节主密钥
 *   - 备份文件是 JSON envelope（人类可读、便于审计）
 *   - 恢复时通过 fingerprint 比对 + 已知 agent 验证，防止静默损坏
 *
 * 算法选择（OWASP 2023 推荐）：
 *   - KDF:  scrypt (N=2^15, r=8, p=1) — 零依赖，Node 内置，64MB 派生成本
 *   - 加密: AES-256-GCM — Node 内置，自带完整性校验
 *
 * envelope 文件格式：
 *   {
 *     version: 1,
 *     type: 'ngen-wallet-master-key-backup',
 *     kdf: { name, salt (b64), N, r, p, maxmem },
 *     cipher: { name, iv (b64), ciphertext (b64), tagLength },
 *     payload: 'ngen-wallet-master-key-v1',
 *     kekFingerprint (hex 8 chars),  // SHA256(KEK).slice(0, 8)
 *     createdAt (ISO),
 *     warning
 *   }
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { decryptPrivateKey, isValidEnvelope } from './walletEncryption.js';

// ─── 参数与常量 ──────────────────────────────────────────────────────
const ENVELOPE_VERSION = 1;
const ENVELOPE_TYPE = 'ngen-wallet-master-key-backup';
const PAYLOAD_MAGIC = 'ngen-wallet-master-key-v1';

// scrypt 标准档（OWASP 推荐，64MB / ~1s 派生）
const KDF_PARAMS = {
  name: 'scrypt',
  N: 1 << 15,    // 32768
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024  // 128 MB 上限
};

// 快速档（CI/测试，~200ms）
const KDF_PARAMS_FAST = {
  name: 'scrypt',
  N: 1 << 12,    // 4096
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;  // 主密钥 = KEK = AES-256 key 都是 32 字节

// ─── Passphrase 强度检查 ────────────────────────────────────────────
const MIN_PASSPHRASE_LENGTH = 12;

// 常见弱口令（不全，截取常见一段；生产应接 HIBP API）
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'passw0rd',
  '12345678', '123456789', '1234567890', '123456789012',
  'qwerty', 'qwerty12', 'qwerty1234', 'qwertyuiop',
  'admin', 'admin12', 'admin1234', 'admin1234567',
  'letmein', 'welcome', 'welcome1', 'welcome12',
  'monkey', 'dragon', 'master', 'login', 'princess',
  'nexusgenesis', 'ngen', 'ngen1234', 'ngen2026', 'ngen2025',
  'test', 'test1', 'test12', 'test1234', 'test12345',
  '00000000', '11111111', 'aaaaaaaa', 'abcd1234'
]);

/**
 * 检查口令强度
 * @param {string} passphrase
 * @returns {{ ok: boolean, score: number, errors: string[] }}
 *   score: 0-4 (entropy estimation)
 *   errors: 失败原因列表
 */
export function validatePassphrase(passphrase) {
  const errors = [];
  let score = 0;

  if (typeof passphrase !== 'string') {
    return { ok: false, score: 0, errors: ['passphrase is not a string'] };
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    errors.push(`too short (minimum ${MIN_PASSPHRASE_LENGTH} characters, got ${passphrase.length})`);
  }

  // 字符类别
  const hasLower = /[a-z]/.test(passphrase);
  const hasUpper = /[A-Z]/.test(passphrase);
  const hasDigit = /[0-9]/.test(passphrase);
  const hasSymbol = /[^a-zA-Z0-9]/.test(passphrase);
  const categories = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;

  if (categories < 3) {
    errors.push(`weak character diversity (need at least 3 of: lowercase, uppercase, digit, symbol; got ${categories})`);
  } else {
    score += 1;
  }

  // 长度加分
  if (passphrase.length >= 16) score += 1;
  if (passphrase.length >= 24) score += 1;

  // 字符类别加分
  if (categories === 4) score += 1;

  // 常见口令
  if (COMMON_PASSWORDS.has(passphrase.toLowerCase())) {
    errors.push('passphrase is in the common-password list');
    score = 0;
  }

  // 全部同字符
  if (/^(.)\1+$/.test(passphrase)) {
    errors.push('passphrase is a single character repeated');
    score = 0;
  }

  // 严格顺序（asc/desc ascii）
  let isSequential = true;
  for (let i = 1; i < passphrase.length; i++) {
    if (passphrase.charCodeAt(i) !== passphrase.charCodeAt(i - 1) + 1 &&
        passphrase.charCodeAt(i) !== passphrase.charCodeAt(i - 1) - 1) {
      isSequential = false;
      break;
    }
  }
  if (isSequential && passphrase.length >= 8) {
    errors.push('passphrase is a strict ascending/descending sequence');
    score = 0;
  }

  return {
    ok: errors.length === 0,
    score: Math.min(score, 4),
    errors
  };
}

// ─── Base64 helpers ──────────────────────────────────────────────────
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (str) => Buffer.from(str, 'base64');

// ─── KEK 派生 ────────────────────────────────────────────────────────
function deriveKEK(passphrase, salt, params = KDF_PARAMS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, KEY_BYTES, params, (err, key) => {
      if (err) return reject(err);
      resolve(key);
    });
  });
}

// ─── KEK fingerprint ────────────────────────────────────────────────
/**
 * @param {Buffer} kek
 * @returns {string} 8 字符 hex（用于在恢复时与原备份比对）
 */
export function computeKEKFingerprint(kek) {
  return crypto.createHash('sha256').update(kek).digest('hex').slice(0, 8);
}

// ─── 加密：主密钥 → envelope ────────────────────────────────────────
/**
 * @param {Buffer|string} masterKeyRaw 32 字节主密钥（buffer 或 base64 字符串）
 * @param {string} passphrase
 * @param {object} [options]
 * @param {boolean} [options.fast] 使用快速档（CI/测试）
 * @returns {Promise<object>} envelope JSON object
 */
export async function encryptMasterKey(masterKeyRaw, passphrase, options = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('encryptMasterKey: passphrase is required');
  }

  // 规范化主密钥输入
  let keyBuf;
  if (Buffer.isBuffer(masterKeyRaw)) {
    keyBuf = masterKeyRaw;
  } else if (typeof masterKeyRaw === 'string') {
    // 优先 base64 解码
    try {
      keyBuf = unb64(masterKeyRaw);
    } catch {
      keyBuf = Buffer.from(masterKeyRaw, 'hex');
    }
  } else {
    throw new Error('encryptMasterKey: masterKeyRaw must be Buffer or string');
  }

  if (keyBuf.length !== KEY_BYTES) {
    throw new Error(`encryptMasterKey: master key must be ${KEY_BYTES} bytes, got ${keyBuf.length}`);
  }

  // 派生参数
  const params = options.fast ? KDF_PARAMS_FAST : KDF_PARAMS;
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);

  // 派生 KEK
  const kek = await deriveKEK(passphrase, salt, params);
  const fingerprint = computeKEKFingerprint(kek);

  // AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ctWithTagBuf = Buffer.concat([cipher.update(keyBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // ciphertext 部分 = ctWithTagBuf 的前 (keyBuf.length) 字节；tag 单独存
  const ct = ctWithTagBuf.subarray(0, keyBuf.length);

  const envelope = {
    version: ENVELOPE_VERSION,
    type: ENVELOPE_TYPE,
    payload: PAYLOAD_MAGIC,
    kdf: {
      name: params.name,
      N: params.N,
      r: params.r,
      p: params.p,
      salt: b64(salt)
    },
    cipher: {
      name: 'aes-256-gcm',
      iv: b64(iv),
      ciphertext: b64(ct),
      tag: b64(tag),
      tagLength: TAG_BYTES
    },
    kekFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    warning: 'Single point of failure for 180 agent wallets. Do not edit. Keep this file physically separate from the passphrase.'
  };

  // 清零敏感内存（尽力，V8 可能已拷贝）
  kek.fill(0);

  return envelope;
}

// ─── 解密：envelope → 主密钥 ────────────────────────────────────────
/**
 * @param {object} envelope
 * @param {string} passphrase
 * @returns {Promise<{ masterKey: Buffer, fingerprint: string }>}
 *   masterKey 是 32 字节 Buffer；fingerprint 用于调用方与 envelope 中的比对
 */
export async function decryptMasterKey(envelope, passphrase) {
  if (!envelope || envelope.type !== ENVELOPE_TYPE) {
    throw new Error(`decryptMasterKey: not a master-key backup envelope (type=${envelope?.type})`);
  }
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`decryptMasterKey: unsupported version ${envelope.version}`);
  }
  if (envelope.payload !== PAYLOAD_MAGIC) {
    throw new Error(`decryptMasterKey: payload magic mismatch (${envelope.payload})`);
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('decryptMasterKey: passphrase is required');
  }

  const salt = unb64(envelope.kdf.salt);
  const iv = unb64(envelope.cipher.iv);
  const ct = unb64(envelope.cipher.ciphertext);
  const tag = unb64(envelope.cipher.tag);

  if (salt.length !== SALT_BYTES) throw new Error(`decryptMasterKey: bad salt length ${salt.length}`);
  if (iv.length !== IV_BYTES) throw new Error(`decryptMasterKey: bad iv length ${iv.length}`);
  if (ct.length !== KEY_BYTES) throw new Error(`decryptMasterKey: bad ciphertext length ${ct.length}`);
  if (tag.length !== TAG_BYTES) throw new Error(`decryptMasterKey: bad tag length ${tag.length}`);

  const params = {
    name: 'scrypt',
    N: envelope.kdf.N,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
    maxmem: 128 * 1024 * 1024
  };

  const kek = await deriveKEK(passphrase, salt, params);
  const fingerprint = computeKEKFingerprint(kek);

  if (fingerprint !== envelope.kekFingerprint) {
    kek.fill(0);
    throw new Error('decryptMasterKey: KEK fingerprint mismatch (wrong passphrase or corrupted file)');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  let masterKey;
  try {
    masterKey = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (e) {
    kek.fill(0);
    throw new Error(`decryptMasterKey: AES-GCM auth failed (corrupted or tampered): ${e.message}`);
  }

  if (masterKey.length !== KEY_BYTES) {
    masterKey.fill(0);
    kek.fill(0);
    throw new Error(`decryptMasterKey: bad output length ${masterKey.length}`);
  }

  kek.fill(0);
  return { masterKey, fingerprint };
}

// ─── 文件读写 ───────────────────────────────────────────────────────
/**
 * @param {string} filePath
 * @returns {object} envelope
 */
export function readEnvelopeFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let env;
  try {
    env = JSON.parse(text);
  } catch (e) {
    throw new Error(`readEnvelopeFile: invalid JSON in ${filePath}: ${e.message}`);
  }
  return env;
}

/**
 * @param {string} filePath
 * @param {object} envelope
 */
export function writeEnvelopeFile(filePath, envelope) {
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 });
}

// ─── 已知 agent 验证 ────────────────────────────────────────────────
/**
 * 用解出的主密钥尝试解密一个已知 agent 的 envelope，验证主密钥正确性
 *
 * @param {Buffer} masterKey 32 字节主密钥
 * @param {object} agentWalletManager 必须已加载 registry
 * @param {string} [agentId='agent-validator-001'] 用于验证的 agent ID
 * @returns {{ ok: boolean, agentId: string, address?: string, error?: string }}
 */
export function verifyMasterKeyAgainstAgent(masterKey, agentWalletManager, agentId = 'agent-validator-001') {
  if (!agentWalletManager || !agentWalletManager.registry) {
    return { ok: false, agentId, error: 'agentWalletManager not loaded' };
  }
  const entry = agentWalletManager.registry.get(agentId);
  if (!entry) {
    return { ok: false, agentId, error: `agent ${agentId} not found in registry` };
  }

  try {
    // 从 registry 的 disk 形态读取 envelope
    // 优先从 entry.wallet 取（如果 PQCWallet 已经存了原始 envelope），否则读盘
    let envelope = entry.wallet.envelope || entry.wallet.encryptedPrivateKey;
    if (!envelope) {
      // 备用：从盘上读
      const regPath = path.join('data', 'wallets', 'agent_wallet_registry.json');
      if (fs.existsSync(regPath)) {
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        const rec = (reg.entries || []).find(e => e.agentId === agentId);
        envelope = rec?.wallet_data?.encryptedPrivateKey;
      }
    }
    if (!envelope) {
      return { ok: false, agentId, error: 'envelope not found on disk or in-memory' };
    }
    if (!isValidEnvelope(envelope)) {
      return { ok: false, agentId, error: 'envelope is not valid format' };
    }

    // masterKey → hex → 作为 password 参数传给 decryptPrivateKey
    const pwd = masterKey.toString('hex');
    const dec = decryptPrivateKey(envelope, pwd);

    // 检查解出的私钥长度符合 PQC（Dilithium2/3/5 或 superdilithium 变体）
    if (Buffer.isBuffer(dec) || dec instanceof Uint8Array) {
      const buf = Buffer.from(dec);
      // 已知 PQC 私钥长度：
      //   Dilithium2 (NIST L1)  = 2420
      //   Dilithium3 (NIST L3)  = 4000
      //   Dilithium5 (NIST L5)  = 4864
      //   superdilithium variant = 2560  (当前代码库实际使用)
      const validLengths = [2420, 2560, 4000, 4864];
      if (!validLengths.includes(buf.length)) {
        return {
          ok: false,
          agentId,
          error: `decrypted private key has unexpected length ${buf.length} (expected one of ${validLengths.join(', ')})`
        };
      }
      return { ok: true, agentId, address: entry.wallet.address, privateKeyLength: buf.length };
    }
    return { ok: false, agentId, error: `decrypt returned non-Buffer (type=${typeof dec})` };
  } catch (e) {
    return { ok: false, agentId, error: e.message };
  }
}
