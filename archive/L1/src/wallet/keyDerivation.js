/**
 * NexusGenesis - Key Derivation Module
 * 
 * 三层密钥体系的核心：从主密钥派生操作密钥
 * 
 * 设计原则：
 * 1. 主密钥永不联网，只在本地派生子密钥
 * 2. 每个 Agent 派生出不同的操作密钥（通过 info 参数区分）
 * 3. 支持版本化（opKeyVersion），便于密钥轮换
 * 4. 使用 HKDF-SHA256（Node.js 内置 crypto 模块）
 * 
 * 密钥层级：
 *   Level 0: Master Key（人类持有，冷存储）
 *   Level 1: Operation Key（Agent 持有，本地加密存储）
 *   Level 2: Custody Token（短期授权，24小时过期）
 */

import crypto from 'crypto';

// ─── 常量定义 ────────────────────────────────────────────────────────

/** 网络标识符（防不同网络串用派生结果） */
const NETWORK_SALT = 'nexus-genesis-mainnet-beta';

/** 主密钥长度（32 字节 = 256 位） */
const MASTER_KEY_LENGTH = 32;

/** 操作密钥种子长度（32 字节，用于生成 Dilithium2 密钥对） */
const OP_KEY_SEED_LENGTH = 32;

/** HKDF 算法 */
const HKDF_HASH = 'sha256';

/**
 * 密钥模式枚举
 */
export const KEY_MODELS = {
  /** 人类主密钥 + Agent 操作密钥（推荐） */
  HYBRID: 'hybrid',
  /** Agent 自主管理（Agent 自己是自己的"主人"） */
  SELF_SOVEREIGN: 'self-sovereign',
  /** 服务器托管（Legacy，标记为不安全） */
  SERVER_MANAGED: 'server-managed'
};

/**
 * 验证主密钥格式
 * @param {Buffer|string} key - 主密钥（Buffer 或 hex 字符串）
 * @returns {boolean}
 */
export function isValidMasterKey(key) {
  try {
    const buffer = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
    return buffer instanceof Buffer && buffer.length === MASTER_KEY_LENGTH;
  } catch {
    return false;
  }
}

/**
 * 从主密钥派生 Agent 操作密钥种子
 * 
 * @param {Buffer} masterKey - 32 字节主密钥
 * @param {object} options - 派生选项
 * @param {string} options.agentId - Agent ID（用于区分不同 Agent）
 * @param {number} [options.version=1] - 密钥版本号（用于轮换）
 * @param {string} [options.salt] - 自定义 salt（默认使用 NETWORK_SALT）
 * @returns {Promise<Buffer>} 32 字节操作密钥种子
 * 
 * @example
 * const masterKey = crypto.randomBytes(32);
 * const opKeySeed = await deriveOpKeySeed(masterKey, {
 *   agentId: 'my-agent-001',
 *   version: 1
 * });
 * // 用 opKeySeed 生成 Dilithium2 密钥对
 * const { publicKey, privateKey } = generateKeyPairFromSeed(opKeySeed);
 */
export async function deriveOpKeySeed(masterKey, options) {
  const {
    agentId,
    version = 1,
    salt = NETWORK_SALT
  } = options;

  if (!agentId) {
    throw new Error('agentId is required for key derivation');
  }

  if (!isValidMasterKey(masterKey)) {
    throw new Error('Invalid master key: must be 32 bytes');
  }

  // 构造 info 参数：agent-op-key/<agentId>/v<version>
  const info = `agent-op-key/${agentId}/v${version}`;

  return new Promise((resolve, reject) => {
    crypto.hkdf(
      HKDF_HASH,
      masterKey,
      Buffer.from(salt, 'utf8'),
      Buffer.from(info, 'utf8'),
      OP_KEY_SEED_LENGTH,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(Buffer.from(derivedKey)); // Convert ArrayBuffer to Buffer
      }
    );
  });
}

/**
 * 从操作密钥种子生成 Dilithium2 密钥对
 * 
 * @param {Buffer} seed - 32 字节种子
 * @returns {Promise<{publicKey: Buffer, privateKey: Buffer}>}
 */
export async function generateKeyPairFromSeed(seed) {
  if (!seed || seed.length !== OP_KEY_SEED_LENGTH) {
    throw new Error(`Invalid seed length: expected ${OP_KEY_SEED_LENGTH}, got ${seed?.length}`);
  }

  // 导入 PQC 模块（懒加载，避免循环依赖）
  const { ml_dsa44 } = await import('@noble/post-quantum/ml-dsa.js');

  // 确定性密钥生成：ml_dsa44.keygen(seed) 通过 SHAKE256（FIPS 204）扩展 32 字节种子。
  // 同一种子 ALWAYS 生成同一密钥对 —— 这是三层密钥体系可从 Master Key 恢复的前提。
  // SECURITY FIX: 此前 seed 被忽略、keygen() 使用系统熵，导致操作密钥不可恢复。
  // （与 packages/agent-keys/src/derivation.js 保持一致）
  const keyPair = ml_dsa44.keygen(new Uint8Array(seed));

  return {
    publicKey: Buffer.from(keyPair.publicKey),
    privateKey: Buffer.from(keyPair.secretKey)
  };
}

/**
 * 计算私钥指纹（用于轮换验证）
 * 
 * @param {Buffer} privateKey - 私钥
 * @returns {string} SHA256 指纹（十六进制）
 */
export function calculateKeyFingerprint(privateKey) {
  return crypto
    .createHash('sha256')
    .update(privateKey)
    .digest('hex');
}

/**
 * 生成随机主密钥
 * 
 * @returns {Buffer} 32 字节随机主密钥
 */
export function generateMasterKey() {
  return crypto.randomBytes(MASTER_KEY_LENGTH);
}

/**
 * 验证操作密钥指纹是否与链上记录匹配
 * 
 * @param {Buffer} privateKey - 待验证的操作密钥
 * @param {string} expectedFingerprint - 链上存储的预期指纹
 * @returns {boolean}
 */
export function verifyOpKeyFingerprint(privateKey, expectedFingerprint) {
  const actualFingerprint = calculateKeyFingerprint(privateKey);
  return actualFingerprint === expectedFingerprint;
}

/**
 * 检查密钥是否过期
 * 
 * @param {number} expiresAt - 过期时间戳（毫秒）
 * @returns {boolean}
 */
export function isKeyExpired(expiresAt) {
  return Date.now() > expiresAt;
}

/**
 * 生成新的密钥版本（用于轮换）
 * 
 * @param {Buffer} masterKey - 主密钥
 * @param {string} agentId - Agent ID
 * @param {number} currentVersion - 当前版本号
 * @returns {Promise<{opKeySeed: Buffer, version: number}>}
 */
export async function rotateOpKey(masterKey, agentId, currentVersion) {
  const newVersion = currentVersion + 1;
  
  const opKeySeed = await deriveOpKeySeed(masterKey, {
    agentId,
    version: newVersion
  });
  
  return { opKeySeed, version: newVersion };
}
